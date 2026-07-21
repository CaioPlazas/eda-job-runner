import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { JobStore } from './jobStore';
import { detectVscodeShell } from './shellDetect';
import { buildShellInvocation, defaultArgsForShell, resolveJobEnv, substituteVars } from './shellInvocation';

interface SaveMessage {
  type: 'save';
  shellPath: string;
  shellArgsAuto: boolean;
  shellArgs: string; // one arg per line
  env: string; // one KEY=VALUE per line
  setupScript: string;
  setupCommands: string; // one command per line
  postSetupCwd: string;
}

interface DetectMessage {
  type: 'detect';
}

interface TestMessage {
  type: 'test';
  shellPath: string;
  shellArgsAuto: boolean;
  shellArgs: string;
  env: string;
  setupScript: string;
  setupCommands: string;
  postSetupCwd: string;
}

interface CancelMessage {
  type: 'cancel';
}

type WebviewMessage = SaveMessage | DetectMessage | TestMessage | CancelMessage;

const TEST_TIMEOUT_MS = 15000;
const TEST_OUTPUT_CAP = 64 * 1024;
const TEST_MARKER = '__EDA_SHELL_OK__';

export class ShellEnvPanel {
  private static current: ShellEnvPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private testChild: cp.ChildProcess | undefined;

  static createOrShow(jobStore: JobStore, folder: vscode.WorkspaceFolder): void {
    if (ShellEnvPanel.current) {
      ShellEnvPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'edaShellEnvConfig',
      'Shell & Environment',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ShellEnvPanel.current = new ShellEnvPanel(panel, jobStore, folder);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly jobStore: JobStore,
    private readonly folder: vscode.WorkspaceFolder
  ) {
    this.panel = panel;
    this.panel.webview.html = renderHtml(panel.webview, this.readState());
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg)),
      this.panel.onDidDispose(() => this.cleanup())
    );
  }

  private readState() {
    const config = vscode.workspace.getConfiguration('eda-job-runner', this.folder.uri);
    const shellPath = config.get<string>('shellPath', 'bash');
    const shellArgs = config.get<string[] | null>('shellArgs', null);
    const env = config.get<Record<string, string>>('env', {});
    const setup = this.jobStore.getSetup();
    return {
      shellPath,
      shellArgsAuto: !shellArgs || shellArgs.length === 0,
      shellArgs: (shellArgs ?? defaultArgsForShell(shellPath)).join('\n'),
      env: Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      setupScript: setup?.script ?? '',
      setupCommands: (setup?.commands ?? []).join('\n'),
      postSetupCwd: config.get<string>('postSetupCwd', '')
    };
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'cancel':
        this.panel.dispose();
        return;
      case 'detect':
        return this.onDetect();
      case 'test':
        return this.onTest(msg);
      case 'save':
        return this.onSave(msg);
    }
  }

  private onDetect(): void {
    const detected = detectVscodeShell();
    void this.panel.webview.postMessage({
      type: 'detected',
      shellPath: detected.path,
      shellArgs: detected.args.join('\n'),
      env: Object.entries(detected.env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      source: detected.source
    });
  }

  private async onSave(msg: SaveMessage): Promise<void> {
    const config = vscode.workspace.getConfiguration('eda-job-runner', this.folder.uri);
    // Workspace target (not WorkspaceFolder): these settings are window-scoped
    // by default, and VS Code rejects config.update() at the WorkspaceFolder
    // target for anything that isn't resource-scoped. Workspace writes to
    // .vscode/settings.json, which is where per-project EDA config belongs.
    const target = vscode.ConfigurationTarget.Workspace;

    const shellPath = msg.shellPath.trim() || 'bash';
    const shellArgs = msg.shellArgsAuto ? undefined : parseLines(msg.shellArgs);
    const env = parseEnv(msg.env);

    try {
      await config.update('shellPath', shellPath, target);
      // undefined removes the key -> reverts to the auto (null) default.
      await config.update('shellArgs', shellArgs, target);
      await config.update('env', Object.keys(env).length > 0 ? env : undefined, target);
      await config.update('postSetupCwd', msg.postSetupCwd.trim() || undefined, target);

      await this.jobStore.setSetup({
        script: msg.setupScript.trim() || undefined,
        commands: parseLines(msg.setupCommands)
      });
    } catch (err) {
      void this.panel.webview.postMessage({
        type: 'saveError',
        message: `Could not save settings: ${describe(err)}`
      });
      return;
    }

    void vscode.window.showInformationMessage('EDA Job Runner: shell & environment settings saved.');
    this.panel.dispose();
  }

  private onTest(msg: TestMessage): void {
    if (this.testChild) {
      return; // a test is already running
    }
    const shellPath = msg.shellPath.trim() || 'bash';
    const shellArgs = msg.shellArgsAuto ? null : parseLines(msg.shellArgs);
    const env = parseEnv(msg.env);
    const workspaceRoot = this.folder.uri.fsPath;

    const probe = buildTestCommand(msg.setupScript.trim(), parseLines(msg.setupCommands), workspaceRoot);
    const { file, args } = buildShellInvocation(shellPath, shellArgs, probe);
    const testCwd = msg.postSetupCwd.trim()
      ? path.resolve(workspaceRoot, substituteVars(msg.postSetupCwd.trim(), workspaceRoot))
      : workspaceRoot;

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(file, args, {
        cwd: testCwd,
        env: resolveJobEnv(env, workspaceRoot),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      void this.panel.webview.postMessage({
        type: 'testResult',
        ok: false,
        output: `Failed to launch shell: ${describe(err)}`
      });
      return;
    }
    this.testChild = child;

    let output = '';
    let capped = false;
    const collect = (buf: Buffer) => {
      if (capped) {
        return;
      }
      output += buf.toString('utf8');
      if (output.length > TEST_OUTPUT_CAP) {
        output = output.slice(0, TEST_OUTPUT_CAP) + '\n…(truncated)';
        capped = true;
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, TEST_TIMEOUT_MS);

    child.on('error', err => {
      clearTimeout(timer);
      this.testChild = undefined;
      void this.panel.webview.postMessage({
        type: 'testResult',
        ok: false,
        output: `Failed to launch shell: ${describe(err)}\n\nInvocation: ${file} ${args.join(' ')}`
      });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      this.testChild = undefined;
      const ok = code === 0 && output.includes(TEST_MARKER);
      const header = ok
        ? `OK — shell responded (exit 0, marker seen).`
        : `Problem — exit ${code ?? 'n/a'}${signal ? `, signal ${signal}` : ''}${
            signal === 'SIGKILL' ? ' (timed out)' : ''
          }.`;
      void this.panel.webview.postMessage({
        type: 'testResult',
        ok,
        output: `cwd: ${testCwd}\n$ ${file} ${args.join(' ')}\n\n${output || '(no output)'}\n\n${header}`
      });
    });
  }

  private cleanup(): void {
    ShellEnvPanel.current = undefined;
    if (this.testChild?.pid) {
      try {
        process.kill(this.testChild.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** Assemble the probe command: run the same setup chain, then echo a marker. */
function buildTestCommand(script: string, commands: string[], workspaceRoot: string): string {
  const steps: string[] = [];
  if (script) {
    const scriptPath = path.isAbsolute(script) ? script : path.join(workspaceRoot, script);
    steps.push(`source "${scriptPath}"`);
  }
  for (const cmd of commands) {
    steps.push(cmd);
  }
  steps.push(`echo ${TEST_MARKER}`);
  steps.push('echo "PATH=$PATH"');
  return steps.join(' && ');
}

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue; // skip malformed lines (no key)
    }
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PanelState {
  shellPath: string;
  shellArgsAuto: boolean;
  shellArgs: string;
  env: string;
  setupScript: string;
  setupCommands: string;
  postSetupCwd: string;
}

function renderHtml(webview: vscode.Webview, state: PanelState): string {
  const nonce = getNonce();
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Shell &amp; Environment</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 24px;
    max-width: 680px;
  }
  h2 { margin-top: 0; }
  label { display: block; margin-top: 18px; font-weight: 600; }
  input, textarea {
    width: 100%;
    box-sizing: border-box;
    margin-top: 6px;
    padding: 7px 9px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }
  input:focus, textarea:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  textarea { min-height: 56px; resize: vertical; white-space: pre; }
  label.check { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  label.check input { width: auto; margin-top: 0; }
  .hint {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 18px; }
  .row label { margin-top: 0; }
  .actions { margin-top: 26px; display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    padding: 6px 16px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #testOut {
    margin-top: 12px;
    padding: 10px;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1));
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 0.85em;
    white-space: pre-wrap;
    display: none;
    max-height: 240px;
    overflow: auto;
  }
  #detectNote { margin-top: 6px; font-size: 0.85em; color: var(--vscode-descriptionForeground); min-height: 1em; }
  .hidden { display: none; }
</style>
</head>
<body>
  <h2>Shell &amp; Environment</h2>
  <div class="hint">
    Controls how every job's command is launched. Settings are saved to this
    workspace (they can also be set in User settings). Environment setup (sourced
    script + pre-commands) is saved to <code>.vscode/eda-jobs.json</code>.
  </div>

  <div class="actions">
    <button class="secondary" id="detect">Use My VS Code Terminal Shell</button>
  </div>
  <div id="detectNote"></div>

  <label for="shellPath">Shell path</label>
  <input id="shellPath" type="text" value="${esc(state.shellPath)}" placeholder="bash" />
  <div class="hint">Shell binary (name on PATH or absolute path), e.g. <code>bash</code>, <code>zsh</code>, <code>tcsh</code>.</div>

  <label class="check">
    <input id="shellArgsAuto" type="checkbox" ${state.shellArgsAuto ? 'checked' : ''} />
    Auto-select shell arguments (recommended)
  </label>
  <div class="hint">
    Picks the right invocation per shell family — <code>bash -lc</code>,
    <code>tcsh -c</code>, etc. Uncheck to specify arguments yourself.
  </div>

  <div id="argsWrap" class="${state.shellArgsAuto ? 'hidden' : ''}">
    <label for="shellArgs">Shell arguments (one per line)</label>
    <textarea id="shellArgs" spellcheck="false">${esc(state.shellArgs)}</textarea>
    <div class="hint">
      Use the token <code>\${command}</code> where the assembled command should
      go. If no line contains it, the command is appended as the final argument.
    </div>
  </div>

  <label for="env">Environment variables (one <code>KEY=VALUE</code> per line)</label>
  <textarea id="env" spellcheck="false" placeholder="LM_LICENSE_FILE=27000@licsrv">${esc(state.env)}</textarea>
  <div class="hint">
    Merged on top of the inherited environment. Supports
    <code>\${workspaceFolder}</code> and <code>\${env:NAME}</code>.
  </div>

  <label for="setupScript">Setup script (sourced before every job)</label>
  <input id="setupScript" type="text" value="${esc(state.setupScript)}" placeholder="scripts/env_setup.sh" />
  <div class="hint">Relative to the workspace root, or an absolute path. Optional.</div>

  <label for="setupCommands">Setup commands (one per line, run before every job)</label>
  <textarea id="setupCommands" spellcheck="false" placeholder="module load xcelium/24.03">${esc(state.setupCommands)}</textarea>

  <label for="postSetupCwd">Post-setup working directory</label>
  <input id="postSetupCwd" type="text" value="${esc(state.postSetupCwd)}" placeholder="e.g. work or \${workspaceFolder}/work" />
  <div class="hint">
    Where a job's shell starts, after its own startup (sourcing
    <code>.bashrc</code>/<code>.zshrc</code>/<code>.cshrc</code> etc.) and
    before the setup commands above and the job's command run. A job's own
    <b>Working Directory</b> (in its config form) then resolves relative to
    this instead of the workspace root — useful when the actual EDA run
    tree (and site tool-load setup) lives outside the folder you have open
    in VS Code. Supports <code>\${workspaceFolder}</code> and
    <code>\${env:NAME}</code>. Leave blank to resolve against the workspace
    root, as before. A job can override this individually in its Advanced
    settings.
  </div>

  <div class="actions">
    <button class="secondary" id="test">Test Shell Setup</button>
    <button class="primary" id="save">Save</button>
    <button class="secondary" id="cancel">Cancel</button>
  </div>
  <div id="testOut"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const autoEl = $('shellArgsAuto');
    const argsWrap = $('argsWrap');
    const testOut = $('testOut');
    const detectNote = $('detectNote');

    autoEl.addEventListener('change', () => {
      argsWrap.classList.toggle('hidden', autoEl.checked);
    });

    function collect() {
      return {
        shellPath: $('shellPath').value,
        shellArgsAuto: autoEl.checked,
        shellArgs: $('shellArgs').value,
        env: $('env').value,
        setupScript: $('setupScript').value,
        setupCommands: $('setupCommands').value,
        postSetupCwd: $('postSetupCwd').value
      };
    }

    $('detect').addEventListener('click', () => {
      detectNote.textContent = 'Detecting…';
      vscode.postMessage({ type: 'detect' });
    });
    $('test').addEventListener('click', () => {
      testOut.style.display = 'block';
      testOut.textContent = 'Running…';
      vscode.postMessage(Object.assign({ type: 'test' }, collect()));
    });
    $('save').addEventListener('click', () => {
      vscode.postMessage(Object.assign({ type: 'save' }, collect()));
    });
    $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

    window.addEventListener('message', event => {
      const m = event.data;
      if (!m) { return; }
      if (m.type === 'detected') {
        $('shellPath').value = m.shellPath;
        $('shellArgs').value = m.shellArgs;
        if (m.env) { $('env').value = m.env; }
        autoEl.checked = true;
        argsWrap.classList.add('hidden');
        detectNote.textContent = 'Filled from ' + m.source + '. Review, then Save.';
      } else if (m.type === 'testResult') {
        testOut.style.display = 'block';
        testOut.textContent = m.output;
      } else if (m.type === 'saveError') {
        testOut.style.display = 'block';
        testOut.textContent = m.message;
      }
    });

    $('shellPath').focus();
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
