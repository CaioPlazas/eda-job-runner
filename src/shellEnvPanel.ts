import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JobStore } from './jobStore';
import { ToolStore } from './toolStore';
import { JobRunner } from './jobRunner';
import { LogManager } from './logManager';
import { defaultArgsForShell, substituteVars } from './shellInvocation';
import { HELP_CSS, help } from './webviewHelp';
import { BROWSE_CSS, BROWSE_JS, BrowseMessage, handleBrowseMessage } from './webviewBrowse';
import { CLIENT_ERROR_JS, ClientErrorMessage, handleClientErrorMessage } from './webviewError';
import { runProbeChecks, PROBE_CSS } from './webviewProbe';
import { shellQuote } from './shellQuote';

interface SaveMessage {
  type: 'save';
  shellPath: string;
  shellArgsAuto: boolean;
  shellArgs: string; // one arg per line
  env: string; // one KEY=VALUE per line
  setupScript: string;
  setupCommands: string; // one command per line
  postSetupCwd: string;
  logsDirectory: string;
  logRetentionCount: string;
  logRetentionMaxSizeMB: string;
  maxConcurrentJobs: string;
}

interface ShellTestProbeMessage {
  type: 'shellTestProbe';
  shellPath: string;
  shellArgsAuto: boolean;
  shellArgs: string;
  env: string;
  setupScript: string;
  setupCommands: string;
  postSetupCwd: string;
  alsoChecks: string; // one probe command per line, persisted to eda-job-runner.setupChecks
}

interface ResolvePathMessage {
  type: 'resolvePath';
  requestId: number;
  field: string;
  value: string;
}

interface CancelMessage {
  type: 'cancel';
}

interface CleanAllLogsMessage {
  type: 'cleanAllLogs';
}

type WebviewMessage =
  | SaveMessage
  | ShellTestProbeMessage
  | ResolvePathMessage
  | CancelMessage
  | CleanAllLogsMessage
  | BrowseMessage
  | ClientErrorMessage;

export class ShellEnvPanel {
  private static current: ShellEnvPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private probing = false;

  static createOrShow(
    jobStore: JobStore,
    toolStore: ToolStore,
    folder: vscode.WorkspaceFolder,
    logManager: LogManager,
    jobRunner: JobRunner
  ): void {
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
    ShellEnvPanel.current = new ShellEnvPanel(panel, jobStore, toolStore, folder, logManager, jobRunner);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly jobStore: JobStore,
    private readonly toolStore: ToolStore,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly logManager: LogManager,
    private readonly jobRunner: JobRunner
  ) {
    this.panel = panel;
    this.render();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
        // A rejected promise here (e.g. an I/O error mid-probe) would
        // otherwise be an unhandled rejection VS Code's event emitter never
        // surfaces -- the panel just silently stops responding to that
        // message with no indication why.
        this.onMessage(msg).catch(err => {
          void vscode.window.showErrorMessage(`EDA Job Runner: ${err instanceof Error ? err.message : String(err)}`);
        });
      }),
      this.panel.onDidDispose(() => this.cleanup())
    );
  }

  private render(): void {
    this.panel.webview.html = renderHtml(this.panel.webview, this.readState());
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
      postSetupCwd: config.get<string>('postSetupCwd', ''),
      logsDirectory: config.get<string>('logsDirectory', ''),
      logRetentionCount: Math.max(0, config.get<number>('logRetentionCount', 20)),
      logRetentionMaxSizeMB: Math.max(0, config.get<number>('logRetentionMaxSizeMB', 0)),
      maxConcurrentJobs: Math.max(0, config.get<number>('maxConcurrentJobs', 0)),
      setupChecks: config.get<string[]>('setupChecks', []).join('\n'),
      registeredTools: this.toolStore.getTools().map(t => ({ name: t.displayName || t.command, command: t.command }))
    };
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'cancel':
        this.panel.dispose();
        return;
      case 'shellTestProbe':
        return this.onShellTestProbe(msg);
      case 'resolvePath':
        return this.onResolvePath(msg);
      case 'save':
        return this.onSave(msg);
      case 'cleanAllLogs':
        return this.onCleanAllLogs();
      case 'browse':
        return handleBrowseMessage(msg, this.panel.webview, this.folder);
      case 'clientError':
        return handleClientErrorMessage(msg);
    }
  }

  private async onCleanAllLogs(): Promise<void> {
    // The de-duplicated set of every root a per-job logsDirectory override
    // could have redirected some job's runs to, not just the global root --
    // otherwise an overridden job's logs would silently survive "clean all."
    const roots = this.logManager.resolveAllRoots(this.jobStore.getJobs());
    // Currently-live runs are never deleted -- unlinking one out from under
    // its still-writing child would freeze live tailing and orphan the
    // eventual trailer write (see JobRunner.getActiveLogPaths).
    const active = this.jobRunner.getActiveLogPaths();
    const { files, bytes } = await this.logManager.totalSize(roots, active);
    if (files === 0) {
      void vscode.window.showInformationMessage('EDA Job Runner: no logs to clean.');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete all ${files} log file${files === 1 ? '' : 's'} (${formatBytes(bytes)}) across every job? This cannot be undone.`,
      { modal: true },
      'Delete all logs'
    );
    if (confirm !== 'Delete all logs') {
      return;
    }
    const result = await this.logManager.cleanAllLogs(roots, active);
    const skippedNote = result.skipped > 0 ? ` (${result.skipped} currently running, skipped)` : '';
    void vscode.window.showInformationMessage(
      `EDA Job Runner: deleted ${result.files} log file${result.files === 1 ? '' : 's'} (${formatBytes(result.bytes)})${skippedNote}.`
    );
  }

  private async onResolvePath(msg: ResolvePathMessage): Promise<void> {
    const workspaceRoot = this.folder.uri.fsPath;
    const value = msg.value.trim();
    if (!value) {
      void this.panel.webview.postMessage({ type: 'resolvedPath', requestId: msg.requestId, field: msg.field, resolved: '', exists: undefined });
      return;
    }
    const expanded = substituteVars(value, workspaceRoot);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(workspaceRoot, expanded);
    let exists: boolean | undefined;
    try {
      await fs.promises.access(resolved);
      exists = true;
    } catch {
      exists = false;
    }
    void this.panel.webview.postMessage({ type: 'resolvedPath', requestId: msg.requestId, field: msg.field, resolved, exists });
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

    const retentionCountParsed = parseInt(msg.logRetentionCount.trim(), 10);
    const retentionSizeParsed = parseInt(msg.logRetentionMaxSizeMB.trim(), 10);
    const maxConcurrentParsed = parseInt(msg.maxConcurrentJobs.trim(), 10);

    try {
      await config.update('shellPath', shellPath, target);
      // undefined removes the key -> reverts to the auto (null) default.
      await config.update('shellArgs', shellArgs, target);
      await config.update('env', Object.keys(env).length > 0 ? env : undefined, target);
      await config.update('postSetupCwd', msg.postSetupCwd.trim() || undefined, target);
      await config.update('logsDirectory', msg.logsDirectory.trim() || undefined, target);
      await config.update(
        'logRetentionCount',
        Number.isFinite(retentionCountParsed) ? Math.max(0, retentionCountParsed) : undefined,
        target
      );
      await config.update(
        'logRetentionMaxSizeMB',
        Number.isFinite(retentionSizeParsed) ? Math.max(0, retentionSizeParsed) : undefined,
        target
      );
      await config.update(
        'maxConcurrentJobs',
        Number.isFinite(maxConcurrentParsed) ? Math.max(0, maxConcurrentParsed) : undefined,
        target
      );

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

    // Unlike before, the panel stays open (D9/T1.2 item 7 -- disposing mid-
    // setup destroyed the stepper the user was following and silently
    // discarded an un-run test). A flash confirms the save; the stepper/
    // banner state is recomputed on the next full render (e.g. Test, or a
    // fresh open) rather than here, since Save alone doesn't change step ①'s
    // tested-or-not status.
    void this.panel.webview.postMessage({ type: 'saved' });
  }

  private async onShellTestProbe(msg: ShellTestProbeMessage): Promise<void> {
    if (this.probing) {
      return;
    }
    this.probing = true;
    try {
      const shellPath = msg.shellPath.trim() || 'bash';
      const shellArgs = msg.shellArgsAuto ? null : parseLines(msg.shellArgs);
      const env = parseEnv(msg.env);
      const setup = { script: msg.setupScript.trim() || undefined, commands: parseLines(msg.setupCommands) };
      const workspaceRoot = this.folder.uri.fsPath;
      const cwd = msg.postSetupCwd.trim()
        ? path.resolve(workspaceRoot, substituteVars(msg.postSetupCwd.trim(), workspaceRoot))
        : workspaceRoot;

      const tools = this.toolStore.getTools();
      const toolChecks = tools.map(t => `command -v ${shellQuote(t.command)}`);
      const alsoChecks = parseLines(msg.alsoChecks);
      const allChecks = [...toolChecks, ...alsoChecks];

      const run = await runProbeChecks(allChecks, { path: shellPath, args: shellArgs, env }, setup, cwd, this.folder);

      const toolResults = run.results.slice(0, toolChecks.length).map((r, i) => ({ name: tools[i].displayName || tools[i].command, command: tools[i].command, ok: r.ok, output: r.output }));
      const alsoResults = run.results.slice(toolChecks.length);

      const allOk = !run.launchError && run.results.every(r => r.ok);

      // Persist the user-authored "Also check" list so it becomes a
      // reusable site smoke test, independent of the main Save button.
      const config = vscode.workspace.getConfiguration('eda-job-runner', this.folder.uri);
      await config.update('setupChecks', alsoChecks.length > 0 ? alsoChecks : undefined, vscode.ConfigurationTarget.Workspace);

      void this.panel.webview.postMessage({
        type: 'shellTestProbed',
        invocation: run.invocation,
        cwd: run.cwd,
        toolResults,
        alsoResults,
        launchError: run.launchError,
        allOk
      });
    } finally {
      this.probing = false;
    }
  }

  private cleanup(): void {
    ShellEnvPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
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

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PanelState {
  shellPath: string;
  shellArgsAuto: boolean;
  shellArgs: string;
  env: string;
  setupScript: string;
  setupCommands: string;
  postSetupCwd: string;
  logsDirectory: string;
  logRetentionCount: number;
  logRetentionMaxSizeMB: number;
  maxConcurrentJobs: number;
  setupChecks: string;
  registeredTools: { name: string; command: string }[];
}

export function renderHtml(webview: vscode.Webview, state: PanelState): string {
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
    max-width: min(1200px, 100%);
    width: 100%;
  }
  h2 { margin-top: 0; }
  label { display: block; margin-top: 18px; font-weight: 600; }
  input, textarea {
    width: 100%;
    box-sizing: border-box;
    margin-top: 6px;
    padding: 9px 12px;
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
  ${HELP_CSS}
  ${BROWSE_CSS}
  ${PROBE_CSS}
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
    max-height: 320px;
    overflow: auto;
  }
  #saveOut { margin-top: 8px; font-size: 0.85em; min-height: 1.2em; }
  #saveOut.error { color: var(--vscode-errorForeground); }
  #saveOut.ok { color: var(--vscode-charts-green); }
  .pathCheck { margin-top: 4px; font-size: 0.85em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); min-height: 1.2em; }
  .pathCheck .yes { color: var(--vscode-charts-green); }
  .pathCheck .no { color: var(--vscode-charts-red, var(--vscode-errorForeground)); }
  .hidden { display: none; }
  details.section { margin-top: 22px; }
  details.section summary { cursor: pointer; font-weight: 600; }
</style>
</head>
<body>
  <h2>Shell &amp; Environment ${help(
    "Controls how every job's command is launched. Settings are saved to this " +
      'workspace (they can also be set in User settings). Environment setup (sourced ' +
      'script + pre-commands) is saved to <code>.vscode/eda-jobs.json</code>.'
  )}</h2>

  <label for="shellPath">Shell path ${help(
    'Shell binary (name on PATH or absolute path), e.g. <code>bash</code>, <code>zsh</code>, <code>tcsh</code>. Provenance: whatever shell your tool already runs correctly under, in a plain terminal.'
  )}</label>
  <input id="shellPath" type="text" value="${esc(state.shellPath)}" placeholder="bash" />

  <label class="check">
    <input id="shellArgsAuto" type="checkbox" ${state.shellArgsAuto ? 'checked' : ''} />
    Auto-select shell arguments (recommended)
    ${help(
      'Picks the right invocation per shell family — <code>bash -lc</code>, ' +
        '<code>tcsh -c</code>, etc. Uncheck to specify arguments yourself.'
    )}
  </label>

  <div id="argsWrap" class="${state.shellArgsAuto ? 'hidden' : ''}">
    <label for="shellArgs">Shell arguments (one per line) ${help(
      'Use the token <code>' +
        '${command}' +
        '</code> where the assembled command should go. If no line contains it, the command is appended as the final argument.'
    )}</label>
    <textarea id="shellArgs" spellcheck="false">${esc(state.shellArgs)}</textarea>
  </div>

  <label for="env">Environment variables (one <code>KEY=VALUE</code> per line) ${help(
    'Merged on top of the inherited environment. Supports <code>' +
      '${workspaceFolder}' +
      '</code> and <code>' +
      '${env:NAME}' +
      '</code>. Provenance: licence servers, install roots — variables your tool needs exported before it runs.'
  )}</label>
  <textarea id="env" spellcheck="false" placeholder="LM_LICENSE_FILE=27000@licsrv">${esc(state.env)}</textarea>

  <label for="setupScript">Setup script (sourced before every job) ${help(
    'Relative to the workspace root, or an absolute path. Optional. Provenance: a file you `source` in your terminal before your tool works.'
  )}</label>
  <input id="setupScript" type="text" value="${esc(state.setupScript)}" placeholder="scripts/env_setup.sh" />
  <div class="pathCheck" id="setupScriptCheck"></div>

  <label for="setupCommands">Setup commands (one per line, run before every job)</label>
  <textarea id="setupCommands" spellcheck="false" placeholder="the commands you run in a terminal before launching your tool">${esc(state.setupCommands)}</textarea>

  <label for="postSetupCwd">Post-setup working directory ${help(
    "Where a job's shell starts, after its own startup (sourcing " +
      '<code>.bashrc</code>/<code>.zshrc</code>/<code>.cshrc</code> etc.) and ' +
      "before the setup commands above and the job's command run. A job's own " +
      '<b>Working Directory</b> (in its config form) then resolves relative to ' +
      'this instead of the workspace root — useful when the actual EDA run ' +
      'tree (and site tool-load setup) lives outside the folder you have open ' +
      'in VS Code. Supports <code>' +
      '${workspaceFolder}' +
      '</code> and <code>' +
      '${env:NAME}' +
      '</code>. Leave blank to resolve against the workspace ' +
      "root, as before. A job can override this individually in its Advanced " +
      'settings.'
  )}</label>
  <input id="postSetupCwd" type="text" value="${esc(state.postSetupCwd)}" placeholder="e.g. work or \${workspaceFolder}/work" />
  <div class="pathCheck" id="postSetupCwdCheck"></div>

  <label class="check">
    <input id="limitConcurrent" type="checkbox" ${state.maxConcurrentJobs > 0 ? 'checked' : ''} />
    Limit how many jobs run at once
    ${help(
      'Off by default — different jobs can run side by side (e.g. compiling in one directory while a sim runs in another). ' +
        "A single job can never run concurrently with itself either way — its own Repeat count is the only way to run it again, always sequentially."
    )}
  </label>
  <div class="row">
    <input id="maxConcurrentJobs" type="number" min="1" style="flex:0 0 100px;" value="${state.maxConcurrentJobs > 0 ? state.maxConcurrentJobs : 1}" ${state.maxConcurrentJobs > 0 ? '' : 'disabled'} />
    <span>jobs at once</span>
  </div>

  <details class="section" id="logsRetentionDetails">
    <summary>Logs &amp; retention</summary>

    <label for="logsDirectory">Logs directory ${help(
      'Where run logs are stored, instead of the default <code>.eda-runner/logs</code> under the workspace root. ' +
        'Absolute, or relative to the workspace root; supports <code>' +
        '${workspaceFolder}' +
        '</code> and <code>' +
        '${env:NAME}' +
        '</code>. Leave blank to keep the default. A job can override this individually in its Advanced settings.'
    )}</label>
    <input id="logsDirectory" type="text" value="${esc(state.logsDirectory)}" placeholder=".eda-runner/logs (default)" />
    <div class="pathCheck" id="logsDirectoryCheck"></div>

    <label class="check">
      <input id="limitByCount" type="checkbox" ${state.logRetentionCount > 0 ? 'checked' : ''} />
      Limit by run count
    </label>
    <div class="row">
      <input id="logRetentionCount" type="number" min="1" style="flex:0 0 100px;" value="${state.logRetentionCount > 0 ? state.logRetentionCount : 20}" ${state.logRetentionCount > 0 ? '' : 'disabled'} />
      <span>past runs per job ${help('Older runs beyond this count are deleted automatically after each new run.')}</span>
    </div>

    <label class="check">
      <input id="limitBySize" type="checkbox" ${state.logRetentionMaxSizeMB > 0 ? 'checked' : ''} />
      Limit by total size
    </label>
    <div class="row">
      <input id="logRetentionMaxSizeMB" type="number" min="1" style="flex:0 0 100px;" value="${state.logRetentionMaxSizeMB > 0 ? state.logRetentionMaxSizeMB : 500}" ${state.logRetentionMaxSizeMB > 0 ? '' : 'disabled'} />
      <span>MB total per job ${help(
        'Once a job\'s own past runs exceed this total size, the oldest surviving ones are deleted (after the count limit above, if that\'s also on) until back under it. ' +
          'This bounds disk usage only -- unrelated to the separate logParseBudgetMB setting (settings.json only), which caps how much of a run\'s output gets parsed for errors/warnings, not how much is kept on disk.'
      )}</span>
    </div>

    <div class="actions">
      <button class="secondary" id="cleanAllLogs">Clean all logs now…</button>
    </div>
  </details>

  <details class="section" id="alsoCheckDetails">
    <summary>Also check (one command per line)</summary>
    <textarea id="setupChecks" spellcheck="false" placeholder="echo \$LM_LICENSE_FILE">${esc(state.setupChecks)}</textarea>
  </details>

  <div class="actions">
    <button class="primary" id="test">Test Shell Setup</button>
    <button class="secondary" id="save">Save</button>
    <button class="secondary" id="cancel">Cancel</button>
  </div>
  <div id="saveOut"></div>
  <div id="testOut"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    ${CLIENT_ERROR_JS}
    ${BROWSE_JS}
    const $ = id => document.getElementById(id);
    const $req = id => { const el = $(id); if (!el) { throw new Error('missing element #' + id); } return el; };
    const autoEl = $req('shellArgsAuto');
    const argsWrap = $req('argsWrap');
    const testOut = $req('testOut');
    const saveOut = $req('saveOut');
    const limitByCountEl = $req('limitByCount');
    const logRetentionCountEl = $req('logRetentionCount');
    const limitBySizeEl = $req('limitBySize');
    const logRetentionMaxSizeMBEl = $req('logRetentionMaxSizeMB');
    const limitConcurrentEl = $req('limitConcurrent');
    const maxConcurrentJobsEl = $req('maxConcurrentJobs');
    const registeredTools = ${JSON.stringify(state.registeredTools)};

    autoEl.addEventListener('change', () => {
      argsWrap.classList.toggle('hidden', autoEl.checked);
    });
    limitByCountEl.addEventListener('change', () => {
      logRetentionCountEl.disabled = !limitByCountEl.checked;
    });
    limitBySizeEl.addEventListener('change', () => {
      logRetentionMaxSizeMBEl.disabled = !limitBySizeEl.checked;
    });
    limitConcurrentEl.addEventListener('change', () => {
      maxConcurrentJobsEl.disabled = !limitConcurrentEl.checked;
    });

    function collect() {
      return {
        shellPath: $req('shellPath').value,
        shellArgsAuto: autoEl.checked,
        shellArgs: $req('shellArgs').value,
        env: $req('env').value,
        setupScript: $req('setupScript').value,
        setupCommands: $req('setupCommands').value,
        postSetupCwd: $req('postSetupCwd').value,
        logsDirectory: $req('logsDirectory').value,
        logRetentionCount: limitByCountEl.checked ? logRetentionCountEl.value : '0',
        logRetentionMaxSizeMB: limitBySizeEl.checked ? logRetentionMaxSizeMBEl.value : '0',
        maxConcurrentJobs: limitConcurrentEl.checked ? maxConcurrentJobsEl.value : '0'
      };
    }


    $req('test').addEventListener('click', () => {
      testOut.style.display = 'block';
      testOut.textContent = 'Running…';
      const c = collect();
      vscode.postMessage(Object.assign({ type: 'shellTestProbe', alsoChecks: $req('setupChecks').value }, c));
    });
    $req('save').addEventListener('click', () => {
      saveOut.textContent = '';
      saveOut.className = '';
      vscode.postMessage(Object.assign({ type: 'save' }, collect()));
    });
    $req('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    $req('cleanAllLogs').addEventListener('click', () => vscode.postMessage({ type: 'cleanAllLogs' }));
    addBrowseButton($req('setupScript'), 'file');
    addBrowseButton($req('postSetupCwd'), 'folder');
    addBrowseButton($req('logsDirectory'), 'folder');

    // P4/Resolve+Check: debounced passive feedback under each path field.
    let __resolveRequestId = 0;
    const __resolvePending = new Map();
    function watchPath(inputId, checkId) {
      const input = $req(inputId);
      const out = $req(checkId);
      let timer;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const requestId = ++__resolveRequestId;
          __resolvePending.set(requestId, out);
          vscode.postMessage({ type: 'resolvePath', requestId, field: inputId, value: input.value });
        }, 300);
      });
      // Also check once on load, so an already-filled field shows feedback immediately.
      if (input.value.trim()) {
        const requestId = ++__resolveRequestId;
        __resolvePending.set(requestId, out);
        vscode.postMessage({ type: 'resolvePath', requestId, field: inputId, value: input.value });
      }
    }
    watchPath('setupScript', 'setupScriptCheck');
    watchPath('postSetupCwd', 'postSetupCwdCheck');
    watchPath('logsDirectory', 'logsDirectoryCheck');

    function renderProbeResult(m) {
      testOut.style.display = 'block';
      if (m.launchError) {
        testOut.innerHTML = 'Problem — ' + m.launchError + '\\n\\nRan:  ' + m.invocation + '\\nIn:   ' + m.cwd;
        return;
      }
      const lines = [];
      lines.push((m.allOk ? '✓ Shell setup works.' : '✗ Shell setup has problems.'));
      lines.push('');
      lines.push('Ran:  ' + m.invocation);
      lines.push('In:   ' + m.cwd);
      if (m.toolResults && m.toolResults.length > 0) {
        lines.push('');
        lines.push('Registered tools');
        for (const t of m.toolResults) {
          lines.push('  ' + (t.ok ? '✓' : '✗') + ' ' + t.name + '   ' + (t.output || (t.ok ? '' : 'not found on PATH')));
        }
      }
      if (m.alsoResults && m.alsoResults.length > 0) {
        lines.push('');
        lines.push('Also check');
        for (const r of m.alsoResults) {
          lines.push('  ' + (r.ok ? '✓' : '✗') + ' ' + r.command + '   ' + r.output);
        }
      }
      if (!m.allOk) {
        lines.push('');
        lines.push("Tool Setup's Scan and value-list Refresh run through this same shell and setup chain — fix this first and they will work too.");
      }
      testOut.textContent = lines.join('\\n');
    }

    window.addEventListener('message', event => {
      const m = event.data;
      if (!m) { return; }
      if (m.type === 'shellTestProbed') {
        renderProbeResult(m);
      } else if (m.type === 'saveError') {
        saveOut.className = 'error';
        saveOut.textContent = m.message;
      } else if (m.type === 'saved') {
        saveOut.className = 'ok';
        saveOut.textContent = 'Saved ✓';
        setTimeout(() => { if (saveOut.textContent === 'Saved ✓') { saveOut.textContent = ''; saveOut.className = ''; } }, 4000);
      } else if (m.type === 'resolvedPath') {
        const out = __resolvePending.get(m.requestId);
        __resolvePending.delete(m.requestId);
        if (!out) { return; }
        if (!m.resolved) {
          out.textContent = '';
          return;
        }
        out.innerHTML = '→ ' + m.resolved + '  ' + (m.exists === undefined ? '' : m.exists ? '<span class="yes">✓</span>' : '<span class="no">✗ does not exist</span>');
      }
    });

    $req('shellPath').focus();
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
