import * as vscode from 'vscode';
import { JobStore } from './jobStore';
import { GlobalParam, JobDefinition, JobTemplate, ToolDefinition } from './types';
import { HELP_CSS, help } from './webviewHelp';

interface SaveMessage {
  type: 'save';
  name: string;
  command: string;
  cwd: string;
  logFile: string;
  isDefault: boolean;
  parseProblems: boolean;
  failPattern: string;
  passPattern: string;
  postSetupCwd: string;
  logsDirectory: string;
  runCount: string;
  postRunEnabled: boolean;
  postRunCommand: string;
  toolId: string;
  toolVariantLabel: string;
  listInsertOverrides: Record<string, string>;
  folder: string;
  customArgs: { arg: string; value?: string }[];
  paramOverrides: Record<string, string>;
}

interface CancelMessage {
  type: 'cancel';
}

/** Sent by the in-panel "Save as template…" button -- the host still owns the name prompt and overwrite confirmation, same as the right-click "Save Job as Template" command. */
interface SaveTemplateRequestMessage {
  type: 'saveTemplateRequest';
  namePattern: string;
  command: string;
  cwd: string;
  toolId: string;
  toolVariantLabel: string;
  parseProblems: boolean;
  folder: string;
}

interface DeleteTemplateRequestMessage {
  type: 'deleteTemplateRequest';
  name: string;
}

type WebviewMessage = SaveMessage | CancelMessage | SaveTemplateRequestMessage | DeleteTemplateRequestMessage;

export class JobConfigPanel {
  private static readonly panels = new Map<string, JobConfigPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** The job this panel saves to. Undefined until a brand-new job's first Save creates one. */
  private currentJobId: string | undefined;

  static createOrShow(jobStore: JobStore, tools: ToolDefinition[], existingJob?: JobDefinition, presetFolder?: string): void {
    const key = existingJob?.id ?? '__new__';
    const existing = JobConfigPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'edaJobConfig',
      existingJob ? `Configure: ${existingJob.name}` : 'Add EDA Job',
      vscode.ViewColumn.Active,
      // retainContextWhenHidden: true -- don't lose in-progress typing if the
      // user switches tabs away and back before clicking Save.
      { enableScripts: true, retainContextWhenHidden: true }
    );

    JobConfigPanel.panels.set(key, new JobConfigPanel(panel, jobStore, key, existingJob, tools, presetFolder));
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly jobStore: JobStore,
    /** Key into the static `panels` map -- mutable: a new job's first Save re-keys this from `'__new__'` to its real id. */
    private mapKey: string,
    existingJob: JobDefinition | undefined,
    tools: ToolDefinition[],
    presetFolder: string | undefined
  ) {
    this.panel = panel;
    this.currentJobId = existingJob?.id;
    const autoSave = vscode.workspace
      .getConfiguration('eda-job-runner')
      .get<boolean>('experimentalAutoSaveJobConfig', false);
    this.panel.webview.html = renderHtml(
      panel.webview,
      existingJob,
      tools,
      jobStore.getFolders(),
      presetFolder,
      autoSave,
      jobStore.getParams(),
      jobStore.getTemplates()
    );
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg)),
      this.panel.onDidDispose(() => this.cleanup())
    );
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    if (msg.type === 'cancel') {
      this.panel.dispose();
      return;
    }
    if (msg.type === 'saveTemplateRequest') {
      return this.onSaveTemplateRequest(msg);
    }
    if (msg.type === 'deleteTemplateRequest') {
      return this.onDeleteTemplateRequest(msg);
    }

    const name = msg.name.trim();
    const command = msg.command.trim();
    const cwd = msg.cwd.trim() || '.';
    const logFile = msg.logFile.trim() || undefined;
    const isDefault = msg.isDefault === true;
    // Store only when disabled, so the common (enabled) case stays absent from
    // the JSON and `undefined` continues to mean "enabled".
    const parseProblems = msg.parseProblems === false ? false : undefined;
    const failPattern = msg.failPattern.trim() || undefined;
    const passPattern = msg.passPattern.trim() || undefined;
    const postSetupCwd = msg.postSetupCwd.trim() || undefined;
    const logsDirectory = msg.logsDirectory.trim() || undefined;
    const runCountParsed = parseInt(msg.runCount.trim(), 10);
    const runCount = Number.isFinite(runCountParsed) && runCountParsed > 1 ? Math.min(1000, runCountParsed) : undefined;
    const postRunCommand = msg.postRunCommand.trim() || undefined;
    const postRunEnabled = msg.postRunEnabled === true && !!postRunCommand ? true : undefined;
    const toolId = msg.toolId.trim() || undefined;
    const toolVariantLabel = toolId ? msg.toolVariantLabel : undefined;
    // Overrides only mean anything alongside a tool's lists — drop orphans.
    const listInsertOverrides = toolId ? sanitizeOverrides(msg.listInsertOverrides) : undefined;
    const folder = msg.folder.trim() || undefined;
    const customArgs = sanitizeCustomArgs(msg.customArgs);
    const paramOverrides = sanitizeParamOverrides(msg.paramOverrides);

    if (!name || !command) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: 'Name and Command are both required.'
      });
      return;
    }

    const fields = {
      name,
      command,
      cwd,
      logFile,
      default: isDefault || undefined,
      parseProblems,
      failPattern,
      passPattern,
      postSetupCwd,
      logsDirectory,
      runCount,
      postRunEnabled,
      postRunCommand,
      toolId,
      toolVariantLabel,
      listInsertOverrides,
      folder,
      customArgs,
      paramOverrides
    };
    if (this.currentJobId) {
      await this.jobStore.updateJob(this.currentJobId, fields);
    } else {
      // First save of a brand-new job: adopt its id so a second Save updates
      // instead of creating a duplicate, and re-key the singleton map entry
      // away from '__new__' so a fresh "Add Job" can open its own panel.
      const created = await this.jobStore.addJob(fields);
      this.currentJobId = created.id;
      JobConfigPanel.panels.delete(this.mapKey);
      this.mapKey = created.id;
      JobConfigPanel.panels.set(this.mapKey, this);
      this.panel.title = `Configure: ${created.name}`;
    }
    // Save no longer closes the tab -- just acknowledge, so the user can keep
    // editing (and so an auto-save doesn't yank the tab out from under them).
    void this.panel.webview.postMessage({ type: 'saved' });
  }

  /**
   * The name prompt and overwrite confirmation are the same shape as the
   * right-click "Save Job as Template" command in extension.ts (kept as a
   * second entry point) -- this one saves the panel's own live, possibly
   * unsaved, form fields instead of a persisted job's.
   */
  private async onSaveTemplateRequest(msg: SaveTemplateRequestMessage): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'Template name',
      value: msg.namePattern.trim(),
      validateInput: v => (v.trim() ? undefined : 'Name is required')
    });
    if (!name || !name.trim()) {
      return;
    }
    const trimmedName = name.trim();
    if (this.jobStore.getTemplates().some(t => t.name === trimmedName)) {
      const confirm = await vscode.window.showWarningMessage(
        `A template named "${trimmedName}" already exists. Overwrite it?`,
        { modal: true },
        'Overwrite'
      );
      if (confirm !== 'Overwrite') {
        return;
      }
    }
    const toolId = msg.toolId.trim() || undefined;
    const template: JobTemplate = {
      name: trimmedName,
      namePattern: msg.namePattern.trim() || undefined,
      command: msg.command.trim() || undefined,
      cwd: msg.cwd.trim() || undefined,
      toolId,
      toolVariantLabel: toolId ? msg.toolVariantLabel : undefined,
      parseProblems: msg.parseProblems === false ? false : undefined,
      folder: msg.folder.trim() || undefined
    };
    await this.jobStore.addTemplate(template);
    void this.panel.webview.postMessage({ type: 'templates', list: this.jobStore.getTemplates(), selected: trimmedName });
    void vscode.window.showInformationMessage(`Saved template "${trimmedName}".`);
  }

  private async onDeleteTemplateRequest(msg: DeleteTemplateRequestMessage): Promise<void> {
    const name = msg.name.trim();
    if (!name) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(`Delete template "${name}"? This cannot be undone.`, { modal: true }, 'Delete');
    if (confirm !== 'Delete') {
      return;
    }
    await this.jobStore.deleteTemplate(name);
    void this.panel.webview.postMessage({ type: 'templates', list: this.jobStore.getTemplates() });
  }

  private cleanup(): void {
    JobConfigPanel.panels.delete(this.mapKey);
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

export function renderHtml(
  webview: vscode.Webview,
  job: JobDefinition | undefined,
  tools: ToolDefinition[],
  folders: string[],
  presetFolder: string | undefined,
  autoSave: boolean,
  globalParams: GlobalParam[],
  templates: JobTemplate[]
): string {
  const nonce = getNonce();
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Slim payload for the builder script -- id/command/variants/options only, no rawHelp/scanError.
  // '<' escaped so a tool's own text can never break out of the <script> tag.
  const toolsJson = JSON.stringify(
    tools.map(t => ({
      id: t.id,
      command: t.command,
      lists: (t.lists ?? []).map(l => ({
        name: l.name,
        values: Array.isArray(l.values) ? l.values : [],
        insertTemplate: l.insertTemplate || '${value}'
      })),
      variants: t.variants.map(v => ({
        label: v.label,
        selectArgs: v.selectArgs,
        options: v.options.map(o => ({
          flags: o.flags,
          metavar: o.metavar,
          description: o.description,
          favorite: o.favorite,
          valueListName: o.valueListName
        }))
      }))
    }))
  ).replace(/</g, '\\u003c');
  const customArgsJson = JSON.stringify(job?.customArgs ?? []).replace(/</g, '\\u003c');
  const globalParamsJson = JSON.stringify(globalParams).replace(/</g, '\\u003c');
  const paramOverridesJson = JSON.stringify(job?.paramOverrides ?? {}).replace(/</g, '\\u003c');
  const templatesJson = JSON.stringify(templates).replace(/</g, '\\u003c');
  const hasVarRef = /\$\{var:[A-Za-z_][\w-]*\}/.test(job?.command ?? '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>${job ? 'Configure Job' : 'Add Job'}</title>
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
  input, textarea, select {
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
  input:focus, textarea:focus, select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  textarea { min-height: 64px; resize: vertical; }
  label.check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  label.check input {
    width: auto;
    margin-top: 0;
  }
  .hidden { display: none; }
  ${HELP_CSS}
  .optRow { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .optRow label.check { font-weight: 400; flex: 1 1 auto; min-width: 200px; }
  .optRow .optValue { width: auto; flex: 0 1 160px; margin-top: 0; }
  .paramOverrideRow .poName { font-weight: 600; }
  .paramOverrideRow .poNameInput { width: auto; flex: 0 1 180px; margin-top: 0; font-weight: 400; }
  .paramOverrideRow .poValue { width: auto; flex: 0 1 220px; margin-top: 0; }
  .listRow { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .listRow > label { font-weight: 400; margin-top: 0; flex: 1 1 auto; min-width: 200px; }
  .listRow .listValue { width: auto; flex: 0 1 200px; margin-top: 0; }
  .listRow .tmplBtn { flex: 0 0 auto; padding: 4px 8px; }
  .listRow .listTemplate { flex: 1 1 100%; margin-top: 4px; }
  .listGroupHeading { margin-top: 14px; font-weight: 600; font-size: 0.85em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; }
  #builderHint { min-height: 1.2em; }
  .optGroupHeading { margin-top: 14px; font-weight: 600; font-size: 0.85em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; }
  .allOptsDetails { margin-top: 14px; }
  .allOptsDetails summary { cursor: pointer; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  #optFilter { margin-top: 14px; }
  .customArgRow { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
  .customArgRow input { width: auto; flex: 1 1 200px; margin-top: 0; }
  .hint {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }
  .error {
    color: var(--vscode-errorForeground);
    margin-top: 14px;
    min-height: 1.2em;
    font-size: 0.9em;
  }
  .savedFlash {
    color: var(--vscode-terminal-ansiGreen, #89d185);
    align-self: center;
    font-size: 0.9em;
  }
  details {
    margin-top: 22px;
    padding-top: 4px;
    border-top: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
  }
  details summary {
    cursor: pointer;
    font-weight: 600;
    padding: 6px 0;
  }
  details[open] summary { margin-bottom: 4px; }
  .actions { margin-top: 26px; display: flex; gap: 8px; align-items: center; }
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
  .templateRow { display: flex; gap: 8px; align-items: flex-end; margin-top: 18px; flex-wrap: wrap; }
  .templateRow > div { flex: 1 1 240px; }
  .templateRow button { flex: 0 0 auto; }
</style>
</head>
<body>
  <h2>${job ? 'Configure Job' : 'Add Job'}</h2>

  <div class="templateRow">
    <div>
      <label for="templateSelect">Template ${help(
        "Load a saved template's fields into this form below, or save the current form as a new one. Deleting a template only removes the template itself — jobs already created from it are untouched."
      )}</label>
      <select id="templateSelect">
        <option value="">(none)</option>
        ${templates.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}
      </select>
    </div>
    <button class="secondary" id="loadTemplate" type="button">Load</button>
    <button class="secondary" id="saveAsTemplate" type="button">Save as template…</button>
    <button class="secondary" id="deleteTemplateBtn" type="button">Delete</button>
  </div>

  <label for="name">Name</label>
  <input id="name" type="text" value="${esc(job?.name ?? '')}" placeholder="e.g. smoke_test" />

  <label for="folder">Folder (optional) ${help(
    "Groups this job under a folder in the sidebar. Leave blank for no folder. Typing a name that doesn't exist yet creates that folder."
  )}</label>
  <input id="folder" list="folderOptions" type="text" value="${esc(job?.folder ?? presetFolder ?? '')}" placeholder="e.g. Compile" />
  <datalist id="folderOptions">
    ${folders.map(f => `<option value="${esc(f)}"></option>`).join('')}
  </datalist>

  <label for="command">Command ${help(
    'Shell command to run. Runs via the configured shell (bash login shell by default; see the Shell &amp; Environment panel), so module load / sourced environment setup is available.<br /><br />Optional placeholders: <code>${param:NAME}</code> (or <code>${param:NAME=default}</code>) prompts for a value on every Run, remembering what you last entered; <code>${randomSeed}</code> fills in a fresh random integer on every run with no prompt. "Re-run Last" on an already-run job replays its exact previous values/seed with no new prompt.'
  )}</label>
  <textarea id="command" placeholder="e.g. make sim TEST=smoke_test">${esc(job?.command ?? '')}</textarea>
  <div class="hint" id="builderHint"></div>

  <details id="toolBuilder" ${job?.toolId ? 'open' : ''}>
    <summary>Tool builder</summary>
    <label for="toolSelect">Tool ${help(
      'Registered in the <b>Tool Setup</b> panel (wrench icon in the EDA Jobs view). Checking its flags below writes them into the Command field above while this section is expanded — collapse it to hand-edit the Command field instead.'
    )}</label>
    <select id="toolSelect">
      <option value="">(none — plain command)</option>
      ${tools
        .map(
          t =>
            `<option value="${esc(t.id)}" ${job?.toolId === t.id ? 'selected' : ''}>${esc(t.displayName || t.command)}</option>`
        )
        .join('')}
    </select>

    <div id="variantWrap" class="hidden">
      <label for="variantSelect">Sub-tool</label>
      <select id="variantSelect"></select>
    </div>

    <input id="optFilter" type="text" placeholder="Filter flags…" />
    <div id="toolOptionsWrap"></div>

    <div id="customArgsWrap"></div>
    <button class="secondary" id="addCustomArg" type="button" style="margin-top:10px;">+ Add custom argument</button>

    <div id="toolListsWrap"></div>
  </details>

  <datalist id="varOptions">
    ${globalParams.map(p => `<option value="\${var:${esc(p.name)}}"></option>`).join('')}
  </datalist>

  <details id="paramsSection" ${job?.paramOverrides && Object.keys(job.paramOverrides).length > 0 ? 'open' : hasVarRef ? 'open' : ''}>
    <summary>Parameters</summary>
    <div class="hint">
      Override a workspace parameter's value for this job only, or add a
      job-only one. Referenced in the Command (including Tool builder
      free-text fields) as <code>\${var:NAME}</code> — resolved silently,
      no prompt. Set globally from the Parameters panel (the puzzle-piece
      icon in the EDA Jobs view).
    </div>
    <div id="paramOverridesWrap"></div>
    <button class="secondary" id="addParamOverride" type="button" style="margin-top:10px;">+ Add parameter override</button>
  </details>

  <label for="cwd">Working Directory ${help('Relative to the workspace root. Use "." for the root itself.')}</label>
  <input id="cwd" type="text" value="${esc(job?.cwd ?? '.')}" placeholder="." />

  <label for="runCount">Repeat count (sequential) ${help(
    'Run this job this many times in a row when you click Run — e.g. 10 back-to-back runs of the same test with a random seed. Always sequential (never in parallel), regardless of the experimental multiple-jobs setting. Leave empty (or 1) for a normal single run.'
  )}</label>
  <input id="runCount" type="number" min="1" max="1000" step="1" value="${job?.runCount && job.runCount > 1 ? job.runCount : ''}" placeholder="1" />

  <details id="advanced" ${
    job?.postSetupCwd ||
    job?.logsDirectory ||
    job?.failPattern ||
    job?.passPattern ||
    job?.logFile ||
    job?.default ||
    job?.parseProblems === false ||
    job?.postRunEnabled
      ? 'open'
      : ''
  }>
    <summary>Advanced</summary>

    <label for="logFile">Live log file to tail (optional) ${help(
      'For jobs that detach to a farm (LSF <code>bsub -o</code> / SGE <code>qsub -o</code>) or write their own log: point the <b>Live Log</b> viewer at that file so it streams the real output in real time. Absolute, or relative to the working directory; supports <code>${workspaceFolder}</code>. Leave empty to tail the captured output.'
    )}</label>
    <input id="logFile" type="text" value="${esc(job?.logFile ?? '')}" placeholder="e.g. run.log or \${workspaceFolder}/lsf.%J.out" />

    <label class="check">
      <input id="isDefault" type="checkbox" ${job?.default ? 'checked' : ''} />
      Default job for this workspace
      ${help(
        'Run this with <b>EDA: Run Default Job</b> (and the F5 key, once a default is set). Only one job per workspace can be the default — choosing this unsets any other.'
      )}
    </label>

    <label class="check">
      <input id="parseProblems" type="checkbox" ${job?.parseProblems === false ? '' : 'checked'} />
      Scan output for errors/warnings (Problems panel)
      ${help(
        'On by default. Detects UVM_ERROR/UVM_WARNING and common compile errors, shows them in the Problems panel, and lets them mark the job failed. Uncheck if you use a tool whose output the built-in patterns misread — the job still runs and logs normally, judged purely by its exit code.'
      )}
    </label>

    <label for="postSetupCwd">Post-setup working directory (override) ${help(
      'Overrides <code>eda-job-runner.postSetupCwd</code> (Shell &amp; Environment panel) for this job only — the directory its shell starts in, which <b>Working Directory</b> above then resolves against. Leave empty to inherit the workspace-wide setting.'
    )}</label>
    <input id="postSetupCwd" type="text" value="${esc(job?.postSetupCwd ?? '')}" placeholder="inherit from Shell & Environment settings" />

    <label for="logsDirectory">Logs directory (override) ${help(
      'Overrides <code>eda-job-runner.logsDirectory</code> (Shell &amp; Environment panel) for this job only. Leave empty to inherit the workspace-wide setting.'
    )}</label>
    <input id="logsDirectory" type="text" value="${esc(job?.logsDirectory ?? '')}" placeholder="inherit from Shell & Environment settings" />

    <label for="failPattern">Fail pattern (regex, optional) ${help(
      'Tool-agnostic: case-insensitive regex matched against each output line, for a tool whose own pass/fail summary line the built-in patterns don’t cover. If it matches, the job is marked <b>failed</b> even if it exited 0 — works even with "Scan output" above off. An invalid regex is silently ignored (no error), same as leaving it blank.'
    )}</label>
    <input id="failPattern" type="text" value="${esc(job?.failPattern ?? '')}" placeholder="e.g. TEST RESULT:\s*FAIL" />

    <label for="passPattern">Pass pattern (regex, optional) ${help(
      'Tool-agnostic, like Fail pattern above. When set, it fully governs the outcome: the job passes only if this matches at least once (ignoring exit code — for tools that always exit non-zero even on success) and is marked <b>failed</b> if it never appears. A matching Fail pattern still wins over this.'
    )}</label>
    <input id="passPattern" type="text" value="${esc(job?.passPattern ?? '')}" placeholder="e.g. TEST RESULT:\s*PASS" />

    <label class="check">
      <input id="postRunEnabled" type="checkbox" ${job?.postRunEnabled ? 'checked' : ''} />
      Run a command after this job finishes
      ${help(
        'Runs once per completed lane after the job passes or fails — skipped for a Stopped run. Uses the same shell/setup chain and working directory as the job itself. A nonzero exit or launch failure only shows a warning notification; it never changes this job\'s own result.'
      )}
    </label>
    <input id="postRunCommand" type="text" value="${esc(job?.postRunCommand ?? '')}" placeholder="e.g. notify-send done || true" ${job?.postRunEnabled ? '' : 'disabled'} />
  </details>

  <div class="error" id="error"></div>

  <div class="actions">
    <button class="primary" id="save">Save</button>
    <button class="secondary" id="cancel">Cancel</button>
    <span class="savedFlash hidden" id="savedFlash">Saved ✓</span>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const AUTO_SAVE = ${autoSave ? 'true' : 'false'};
    const nameEl = document.getElementById('name');
    const folderEl = document.getElementById('folder');
    const commandEl = document.getElementById('command');
    const cwdEl = document.getElementById('cwd');
    const logFileEl = document.getElementById('logFile');
    const isDefaultEl = document.getElementById('isDefault');
    const parseProblemsEl = document.getElementById('parseProblems');
    const failPatternEl = document.getElementById('failPattern');
    const passPatternEl = document.getElementById('passPattern');
    const postSetupCwdEl = document.getElementById('postSetupCwd');
    const logsDirectoryEl = document.getElementById('logsDirectory');
    const runCountEl = document.getElementById('runCount');
    const postRunEnabledEl = document.getElementById('postRunEnabled');
    const postRunCommandEl = document.getElementById('postRunCommand');
    postRunEnabledEl.addEventListener('change', () => {
      postRunCommandEl.disabled = !postRunEnabledEl.checked;
    });
    const errorEl = document.getElementById('error');
    const savedFlashEl = document.getElementById('savedFlash');
    let savedFlashTimer;

    const TOOLS = ${toolsJson};
    // Mutable (not const): loading a template re-seeds which variant should
    // be pre-selected the next time renderVariantSelect runs, same as a
    // freshly-opened existing job's saved variant would be.
    let SAVED_TOOL_VARIANT = ${JSON.stringify(job?.toolVariantLabel ?? '')};
    // Per-job insert-template overrides for a tool's value lists, keyed by list name.
    let LIST_OVERRIDES = ${JSON.stringify(job?.listInsertOverrides ?? {})};
    const GLOBAL_PARAMS = ${globalParamsJson};
    const SAVED_PARAM_OVERRIDES = ${paramOverridesJson};
    let TEMPLATES = ${templatesJson};
    const templateSelectEl = document.getElementById('templateSelect');
    const paramOverridesWrap = document.getElementById('paramOverridesWrap');
    const toolSelectEl = document.getElementById('toolSelect');
    const variantWrap = document.getElementById('variantWrap');
    const variantSelectEl = document.getElementById('variantSelect');
    const optFilterEl = document.getElementById('optFilter');
    const optionsWrap = document.getElementById('toolOptionsWrap');
    const listsWrap = document.getElementById('toolListsWrap');
    const customArgsWrap = document.getElementById('customArgsWrap');
    const builderHint = document.getElementById('builderHint');
    const toolBuilderEl = document.getElementById('toolBuilder');

    function builderOwns() {
      return toolBuilderEl.open;
    }

    function currentTool() {
      return TOOLS.find(t => t.id === toolSelectEl.value);
    }
    function currentVariant(tool) {
      if (!tool) { return undefined; }
      return tool.variants.find(v => v.label === variantSelectEl.value) || tool.variants[0];
    }
    function flagPresent(flag, text) {
      return new RegExp('(^|\\\\s)' + flag + '(=|\\\\s|$)').test(text);
    }
    function extractValue(flag, text) {
      const m = new RegExp(flag + '[=\\\\s]+(\\\\S+)').exec(text);
      return m ? m[1] : '';
    }
    // If metavar is an argparse choices= brace list (e.g. "{qrun,dsim}"),
    // return its choices so the flag renders as a dropdown; null otherwise
    // (a plain metavar like "SEED" keeps the free-text input). A plain split
    // on ',' is safe here (no brace-aware scan needed): this metavar was
    // already isolated as one atomic flag token upstream in
    // toolOptionParser.ts, so it never itself contains nested braces.
    function parseChoices(metavar) {
      if (!metavar || metavar[0] !== '{' || metavar[metavar.length - 1] !== '}') { return null; }
      const inner = metavar.slice(1, -1);
      if (!inner.trim()) { return null; }
      return inner.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
    // Insert a picked list value into its Command fragment (mirrors
    // applyInsertTemplate in listSource.ts): the \${value} token -> the value;
    // a blank template defaults to a bare \${value} token.
    function applyInsertTemplate(template, value) {
      const t = template && template.trim().length > 0 ? template : '\${value}';
      return t.split('\${value}').join(value);
    }
    function effectiveTemplate(list) {
      const override = LIST_OVERRIDES[list.name];
      return (override && override.trim().length > 0) ? override : (list.insertTemplate || '\${value}');
    }

    // Mirrors paramVars.ts's VAR_TOKEN -- distinct names referenced as
    // \${var:NAME} in the given text, in first-appearance order.
    function parseVarNames(text) {
      const re = /\$\{var:([A-Za-z_][\w-]*)\}/g;
      const seen = new Set();
      const names = [];
      let m;
      while ((m = re.exec(text))) {
        if (!seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); }
      }
      return names;
    }
    function globalParamValue(name) {
      const p = GLOBAL_PARAMS.find(p => p.name === name);
      return p ? p.value : '';
    }

    function addParamOverrideRow(name, value, checked, isGlobal) {
      const row = document.createElement('div');
      row.className = 'optRow paramOverrideRow';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'poToggle';
      checkbox.checked = !!checked;

      const label = document.createElement('label');
      label.className = 'check';
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode('override '));

      let nameEl;
      if (isGlobal) {
        nameEl = document.createElement('span');
        nameEl.className = 'poName';
        nameEl.dataset.name = name;
        nameEl.textContent = name;
      } else {
        nameEl = document.createElement('input');
        nameEl.type = 'text';
        nameEl.className = 'poName poNameInput';
        nameEl.placeholder = 'name';
        nameEl.value = name || '';
      }
      label.appendChild(nameEl);
      row.appendChild(label);

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'poValue';
      valueInput.placeholder = isGlobal ? (globalParamValue(name) || '(no global default)') : 'value';
      valueInput.value = value || '';
      valueInput.disabled = !checkbox.checked;
      row.appendChild(valueInput);

      checkbox.addEventListener('change', () => { valueInput.disabled = !checkbox.checked; });

      if (!isGlobal) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'secondary';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => row.remove());
        row.appendChild(removeBtn);
      }

      paramOverridesWrap.appendChild(row);
    }

    // A named function (not the IIFE it used to be) so loadTemplate can
    // re-run it against an empty override set after clearing the wrap --
    // a template never carries param overrides of its own.
    function initParamOverrides(savedOverrides) {
      const seenNames = new Set();
      GLOBAL_PARAMS.forEach(p => {
        seenNames.add(p.name);
        const hasOverride = Object.prototype.hasOwnProperty.call(savedOverrides, p.name);
        addParamOverrideRow(p.name, hasOverride ? savedOverrides[p.name] : '', hasOverride, true);
      });
      Object.keys(savedOverrides).forEach(name => {
        if (seenNames.has(name)) { return; }
        seenNames.add(name);
        addParamOverrideRow(name, savedOverrides[name], true, false);
      });
      parseVarNames(commandEl.value).forEach(name => {
        if (seenNames.has(name)) { return; }
        seenNames.add(name);
        addParamOverrideRow(name, '', false, false);
      });
    }
    initParamOverrides(SAVED_PARAM_OVERRIDES);

    document.getElementById('addParamOverride').addEventListener('click', () => addParamOverrideRow('', '', true, false));

    function renderVariantSelect(tool) {
      variantSelectEl.innerHTML = '';
      if (!tool || tool.variants.length <= 1) {
        variantWrap.classList.add('hidden');
        return;
      }
      variantWrap.classList.remove('hidden');
      for (const v of tool.variants) {
        const opt = document.createElement('option');
        opt.value = v.label;
        opt.textContent = v.label || '(top-level)';
        variantSelectEl.appendChild(opt);
      }
      if (tool.variants.some(v => v.label === SAVED_TOOL_VARIANT)) {
        variantSelectEl.value = SAVED_TOOL_VARIANT;
      }
    }

    // An option can source its value from a list (attached in Tool Setup)
    // instead of a plain argparse choices= metavar -- the attached list wins
    // when both could apply.
    function optionChoices(opt, tool) {
      if (opt.valueListName && tool && tool.lists) {
        const list = tool.lists.find(l => l.name === opt.valueListName);
        if (list) { return list.values || []; }
      }
      return parseChoices(opt.metavar);
    }

    function buildOptionRow(opt, text, tool) {
      const row = document.createElement('div');
      row.className = 'optRow';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'optToggle';
      checkbox.dataset.flags = opt.flags.join(',');
      checkbox.checked = opt.flags.some(f => flagPresent(f, text));

      const label = document.createElement('label');
      label.className = 'check';
      label.title = opt.description || '';
      label.appendChild(checkbox);
      const span = document.createElement('span');
      span.textContent = (opt.favorite ? '★ ' : '') + opt.flags.join(', ') + (opt.metavar ? ' ' + opt.metavar : '');
      label.appendChild(span);
      row.appendChild(label);

      let valueInput;
      if (opt.metavar) {
        const choices = optionChoices(opt, tool);
        const existing = opt.flags.map(f => extractValue(f, text)).find(v => v);
        // A choices dropdown only actually applies when the existing value (if
        // any) is one of its fixed choices -- an existing value that ISN'T
        // (most commonly a \${var:NAME} reference from the toggle below, but
        // also just a stale value from a since-rescanned choice list) must
        // still render as free text pre-filled with it. Silently falling back
        // to the dropdown's blank option here would drop that value the next
        // time the builder rebuilds Command from the row (e.g. reopening this
        // job's Configure form, where the details section renders pre-open).
        const useDropdown = choices && (!existing || choices.includes(existing));

        const buildSelect = value => {
          const el = document.createElement('select');
          el.className = 'optValue';
          const blank = document.createElement('option');
          blank.value = '';
          blank.textContent = '(none)';
          el.appendChild(blank);
          choices.forEach(c => {
            const o = document.createElement('option');
            o.value = c;
            o.textContent = c;
            el.appendChild(o);
          });
          // Setting .value to something outside the choice list is a no-op
          // (leaves it on the blank option) -- exactly what should happen when
          // swapping back from a \${var:...}/unmatched free-text value.
          if (value && choices.includes(value)) { el.value = value; }
          return el;
        };
        const buildFree = value => {
          const el = document.createElement('input');
          el.type = 'text';
          el.className = 'optValue';
          el.placeholder = choices ? '\${var:NAME}' : opt.metavar;
          el.setAttribute('list', 'varOptions');
          if (value) { el.value = value; }
          return el;
        };

        valueInput = choices ? (useDropdown ? buildSelect(existing) : buildFree(existing)) : buildFree(existing);
        valueInput.disabled = !checkbox.checked;
        row.appendChild(valueInput);

        // A fixed-choices dropdown can't hold a \${var:NAME} reference -- this
        // toggle swaps the active editor between the dropdown and a free-text
        // field (with the same varOptions autocomplete as any other builder
        // value field), relabeling itself and preserving the value across the
        // swap whenever it still fits, in both directions.
        if (choices) {
          const varToggle = document.createElement('button');
          varToggle.type = 'button';
          varToggle.className = 'secondary varToggle';
          const syncToggleLabel = () => {
            const isDropdown = valueInput.tagName === 'SELECT';
            varToggle.textContent = isDropdown ? '✎ var' : '◀ choices';
            varToggle.title = isDropdown
              ? 'Use a parameter (\${var:NAME}) instead of one of the fixed choices'
              : 'Switch back to the fixed-choices dropdown';
          };
          varToggle.addEventListener('click', () => {
            const currentValue = valueInput.value;
            const wasDisabled = valueInput.disabled;
            const next = valueInput.tagName === 'SELECT' ? buildFree(currentValue) : buildSelect(currentValue);
            next.disabled = wasDisabled;
            next.addEventListener(next.tagName === 'SELECT' ? 'change' : 'input', onBuilderChange);
            valueInput.replaceWith(next);
            valueInput = next;
            syncToggleLabel();
            onBuilderChange();
          });
          syncToggleLabel();
          row.appendChild(varToggle);
        }
      }

      checkbox.addEventListener('change', () => {
        if (valueInput) { valueInput.disabled = !checkbox.checked; }
        onBuilderChange();
      });
      if (valueInput) {
        valueInput.addEventListener(valueInput.tagName === 'SELECT' ? 'change' : 'input', onBuilderChange);
      }

      return row;
    }

    function renderOptions(tool, variant) {
      optionsWrap.innerHTML = '';
      optFilterEl.value = '';
      if (!tool || !variant) { return; }
      const text = commandEl.value;
      const favorites = variant.options.filter(o => o.favorite);
      const rest = variant.options.filter(o => !o.favorite);

      if (favorites.length > 0) {
        const heading = document.createElement('div');
        heading.className = 'optGroupHeading';
        heading.textContent = 'Favorites';
        optionsWrap.appendChild(heading);
        favorites.forEach(opt => optionsWrap.appendChild(buildOptionRow(opt, text, tool)));
      }

      if (rest.length === 0) {
        return;
      }
      if (favorites.length === 0) {
        rest.forEach(opt => optionsWrap.appendChild(buildOptionRow(opt, text, tool)));
        return;
      }
      const details = document.createElement('details');
      details.className = 'allOptsDetails';
      const summary = document.createElement('summary');
      summary.textContent = 'All options (' + variant.options.length + ')';
      details.appendChild(summary);
      rest.forEach(opt => details.appendChild(buildOptionRow(opt, text, tool)));
      optionsWrap.appendChild(details);
    }

    optFilterEl.addEventListener('input', () => {
      const q = optFilterEl.value.trim().toLowerCase();
      optionsWrap.querySelectorAll('.optRow').forEach(row => {
        const label = row.querySelector('label.check');
        const text = (label ? label.textContent + ' ' + (label.title || '') : '').toLowerCase();
        row.style.display = !q || text.includes(q) ? '' : 'none';
      });
    });

    function buildListRow(list, text) {
      const row = document.createElement('div');
      row.className = 'listRow';
      row.dataset.listName = list.name;
      row.dataset.template = effectiveTemplate(list);

      const label = document.createElement('label');
      label.textContent = list.name;
      row.appendChild(label);

      const select = document.createElement('select');
      select.className = 'listValue';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '(none)';
      select.appendChild(blank);
      (list.values || []).forEach(v => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        select.appendChild(o);
      });
      // Pre-select the value whose templated fragment is already in the command.
      const preset = (list.values || []).find(v => text.indexOf(applyInsertTemplate(row.dataset.template, v)) !== -1);
      if (preset) { select.value = preset; }
      select.addEventListener('change', onBuilderChange);
      row.appendChild(select);

      // Advanced: an override for how a picked value is inserted, per job.
      const tmplBtn = document.createElement('button');
      tmplBtn.type = 'button';
      tmplBtn.className = 'secondary tmplBtn';
      tmplBtn.textContent = '✎ template';
      tmplBtn.title = 'Override how a picked value is inserted into the Command (this job only)';
      row.appendChild(tmplBtn);

      const tmplInput = document.createElement('input');
      tmplInput.type = 'text';
      tmplInput.className = 'listTemplate hidden';
      tmplInput.value = row.dataset.template;
      tmplInput.placeholder = '\${value}';
      tmplInput.setAttribute('list', 'varOptions');
      tmplBtn.addEventListener('click', () => tmplInput.classList.toggle('hidden'));
      tmplInput.addEventListener('input', () => {
        const v = tmplInput.value.trim();
        if (v && v !== (list.insertTemplate || '\${value}')) { LIST_OVERRIDES[list.name] = tmplInput.value; }
        else { delete LIST_OVERRIDES[list.name]; }
        row.dataset.template = effectiveTemplate(list);
        onBuilderChange();
      });
      row.appendChild(tmplInput);

      return row;
    }

    function renderLists(tool) {
      listsWrap.innerHTML = '';
      if (!tool || !tool.lists || tool.lists.length === 0) { return; }
      // A list attached to an option (see optionChoices) already shows as
      // that option's own dropdown -- don't also show it as a free-floating
      // one. Only an unattached list (e.g. a plusarg with no real CLI flag
      // to attach to) still needs its own row + insert-template control.
      const variant = currentVariant(tool);
      const attached = new Set((variant ? variant.options : []).map(o => o.valueListName).filter(Boolean));
      const unattached = tool.lists.filter(l => !attached.has(l.name));
      if (unattached.length === 0) { return; }
      const text = commandEl.value;
      const heading = document.createElement('div');
      heading.className = 'listGroupHeading';
      heading.textContent = 'Lists';
      listsWrap.appendChild(heading);
      unattached.forEach(list => listsWrap.appendChild(buildListRow(list, text)));
    }

    function addCustomArgRow(arg, value) {
      const row = document.createElement('div');
      row.className = 'customArgRow';

      const argInput = document.createElement('input');
      argInput.type = 'text';
      argInput.className = 'caArg';
      argInput.placeholder = 'argument (e.g. --plusarg or +define)';
      argInput.value = arg || '';

      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.className = 'caVal';
      valInput.placeholder = 'value (optional)';
      valInput.setAttribute('list', 'varOptions');
      valInput.value = value || '';

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        row.remove();
        onBuilderChange();
      });

      argInput.addEventListener('input', onBuilderChange);
      valInput.addEventListener('input', onBuilderChange);

      row.appendChild(argInput);
      row.appendChild(valInput);
      row.appendChild(removeBtn);
      customArgsWrap.appendChild(row);
    }

    document.getElementById('addCustomArg').addEventListener('click', () => addCustomArgRow());
    (${customArgsJson}).forEach(c => addCustomArgRow(c.arg, c.value));

    function buildCommandFromBuilder() {
      const tool = currentTool();
      if (!tool) { return null; }
      const variant = currentVariant(tool);
      const parts = [tool.command];
      if (variant && variant.selectArgs && variant.selectArgs.length) {
        parts.push(...variant.selectArgs);
      }
      optionsWrap.querySelectorAll('.optRow').forEach(row => {
        const checkbox = row.querySelector('.optToggle');
        if (!checkbox.checked) { return; }
        const flags = checkbox.dataset.flags.split(',');
        // Prefer a short (single-dash) flag when one exists -- e.g. "-p" over "--probe".
        const preferred = flags.find(f => /^-[^-]/.test(f)) || flags[0];
        parts.push(preferred);
        const valueInput = row.querySelector('.optValue');
        if (valueInput && valueInput.value.trim()) {
          parts.push(valueInput.value.trim());
        }
      });
      listsWrap.querySelectorAll('.listRow').forEach(row => {
        const select = row.querySelector('.listValue');
        if (select && select.value.trim()) {
          parts.push(applyInsertTemplate(row.dataset.template, select.value.trim()));
        }
      });
      customArgsWrap.querySelectorAll('.customArgRow').forEach(row => {
        const arg = row.querySelector('.caArg').value.trim();
        if (!arg) { return; }
        parts.push(arg);
        const val = row.querySelector('.caVal').value.trim();
        if (val) { parts.push(val); }
      });
      return parts.join(' ');
    }

    function applyBuilderToCommand() {
      const built = buildCommandFromBuilder();
      if (built === null) { return; }
      commandEl.value = built;
      updateHint();
    }

    function onBuilderChange() {
      if (builderOwns()) {
        applyBuilderToCommand();
      } else {
        updateHint();
      }
    }

    function updateHint() {
      builderHint.textContent = builderOwns()
        ? 'Tool builder is controlling the Command field — collapse it to hand-edit the command.'
        : 'Hand-written command is in effect — expand Tool builder to build it from flags.';
    }

    toolBuilderEl.addEventListener('toggle', () => {
      if (toolBuilderEl.open) {
        applyBuilderToCommand();
      }
      updateHint();
    });

    toolSelectEl.addEventListener('change', () => {
      const tool = currentTool();
      renderVariantSelect(tool);
      renderOptions(tool, currentVariant(tool));
      renderLists(tool);
      onBuilderChange();
    });
    variantSelectEl.addEventListener('change', () => {
      const tool = currentTool();
      renderOptions(tool, currentVariant(tool));
      renderLists(tool);
      onBuilderChange();
    });

    // Re-syncs the builder's selects/checkboxes FROM the current Command
    // text/toolSelectEl value -- never the other way around, so calling
    // this never silently rewrites Command itself (only an actual builder
    // interaction, or an open toolBuilder's own 'toggle'/change handlers,
    // ever do that). Used both at initial load and after loading a
    // template into the live form. Guarded: a fault in the optional tool
    // builder must never leave the whole form locked (Save/Cancel are
    // wired after this) -- the plain Command field still works without it.
    function refreshBuilderUI() {
      try {
        const tool = currentTool();
        renderVariantSelect(tool);
        renderOptions(tool, currentVariant(tool));
        renderLists(tool);
        updateHint();
      } catch (e) {
        console.error('EDA Job Runner: tool builder init failed', e);
      }
    }
    refreshBuilderUI();

    function renderTemplateOptions(selectName) {
      templateSelectEl.innerHTML = '';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '(none)';
      templateSelectEl.appendChild(blank);
      TEMPLATES.forEach(t => {
        const o = document.createElement('option');
        o.value = t.name;
        o.textContent = t.name;
        templateSelectEl.appendChild(o);
      });
      if (selectName) { templateSelectEl.value = selectName; }
    }

    document.getElementById('loadTemplate').addEventListener('click', () => {
      const t = TEMPLATES.find(x => x.name === templateSelectEl.value);
      if (!t) { return; }
      nameEl.value = t.namePattern || '';
      folderEl.value = t.folder || '';
      commandEl.value = t.command || '';
      cwdEl.value = t.cwd || '.';
      parseProblemsEl.checked = t.parseProblems !== false;
      SAVED_TOOL_VARIANT = t.toolVariantLabel || '';
      toolSelectEl.value = t.toolId || '';
      // A template never carries custom args, param overrides, or list
      // insert-template overrides of its own -- clear all three before
      // rebuilding, or leftovers from whatever job/template was loaded
      // before get silently re-appended into the new Command via
      // buildCommandFromBuilder and persisted on Save.
      customArgsWrap.innerHTML = '';
      paramOverridesWrap.innerHTML = '';
      LIST_OVERRIDES = {};
      initParamOverrides({});
      // Sync the builder's selects/checkboxes from the just-applied Command
      // text BEFORE possibly opening the builder -- so if opening it does
      // trigger its own 'toggle' rebuild, it rebuilds from state that
      // already matches the template, not stale leftovers from whatever
      // was in the form before Load was clicked.
      refreshBuilderUI();
      toolBuilderEl.open = !!t.toolId;
      updateHint();
    });

    document.getElementById('saveAsTemplate').addEventListener('click', () => {
      vscode.postMessage({
        type: 'saveTemplateRequest',
        namePattern: nameEl.value,
        command: commandEl.value,
        cwd: cwdEl.value,
        toolId: toolSelectEl.value,
        toolVariantLabel: variantSelectEl.value,
        parseProblems: parseProblemsEl.checked,
        folder: folderEl.value
      });
    });

    document.getElementById('deleteTemplateBtn').addEventListener('click', () => {
      if (!templateSelectEl.value) { return; }
      vscode.postMessage({ type: 'deleteTemplateRequest', name: templateSelectEl.value });
    });

    function collectSaveMessage() {
      return {
        type: 'save',
        name: nameEl.value,
        folder: folderEl.value,
        command: commandEl.value,
        cwd: cwdEl.value,
        logFile: logFileEl.value,
        isDefault: isDefaultEl.checked,
        parseProblems: parseProblemsEl.checked,
        failPattern: failPatternEl.value,
        passPattern: passPatternEl.value,
        postSetupCwd: postSetupCwdEl.value,
        logsDirectory: logsDirectoryEl.value,
        runCount: runCountEl.value,
        postRunEnabled: postRunEnabledEl.checked,
        postRunCommand: postRunCommandEl.value,
        toolId: toolSelectEl.value,
        toolVariantLabel: variantSelectEl.value,
        listInsertOverrides: LIST_OVERRIDES,
        customArgs: Array.from(customArgsWrap.querySelectorAll('.customArgRow')).map(row => ({
          arg: row.querySelector('.caArg').value,
          value: row.querySelector('.caVal').value
        })),
        paramOverrides: (() => {
          const out = {};
          paramOverridesWrap.querySelectorAll('.paramOverrideRow').forEach(row => {
            if (!row.querySelector('.poToggle').checked) { return; }
            const nameEl = row.querySelector('.poName');
            const name = (nameEl.tagName === 'SPAN' ? nameEl.dataset.name : nameEl.value).trim();
            if (!name) { return; }
            out[name] = row.querySelector('.poValue').value;
          });
          return out;
        })()
      };
    }

    document.getElementById('save').addEventListener('click', () => {
      errorEl.textContent = '';
      vscode.postMessage(collectSaveMessage());
    });

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    if (AUTO_SAVE) {
      let debounceTimer;
      const scheduleAutoSave = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (!nameEl.value.trim() || !commandEl.value.trim()) { return; } // don't nag mid-typing
          errorEl.textContent = '';
          vscode.postMessage(collectSaveMessage());
        }, 300);
      };
      document.querySelectorAll('input, textarea, select').forEach(el => {
        el.addEventListener('input', scheduleAutoSave);
        el.addEventListener('change', scheduleAutoSave);
        el.addEventListener('blur', scheduleAutoSave);
        el.addEventListener('keydown', e => { if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') { scheduleAutoSave(); } });
      });
    }

    window.addEventListener('message', event => {
      const m = event.data;
      if (!m) { return; }
      if (m.type === 'error') {
        errorEl.textContent = m.message;
      } else if (m.type === 'saved') {
        errorEl.textContent = '';
        savedFlashEl.classList.remove('hidden');
        clearTimeout(savedFlashTimer);
        savedFlashTimer = setTimeout(() => savedFlashEl.classList.add('hidden'), 1600);
      } else if (m.type === 'templates') {
        TEMPLATES = m.list;
        renderTemplateOptions(m.selected || '');
      }
    });

    nameEl.focus();
  </script>
</body>
</html>`;
}

/** Drop blank/whitespace-only entries; return undefined when nothing meaningful remains. */
function sanitizeOverrides(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.trim().length > 0 && typeof value === 'string' && value.trim().length > 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Like `sanitizeOverrides`, but keeps an explicit empty-string value -- a
 * checked "override" row with a blank value is a real, intentional override
 * to empty (paramVars.ts's `effectiveVarValue` distinguishes it from "no
 * override", which falls back to the global default), so it must survive
 * the round-trip through this sanitizer.
 */
function sanitizeParamOverrides(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.trim().length > 0 && typeof value === 'string') {
      out[key.trim()] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Drop rows with a blank argument; return undefined when nothing meaningful remains. */
function sanitizeCustomArgs(raw: unknown): { arg: string; value?: string }[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: { arg: string; value?: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rawArg = (item as { arg?: unknown }).arg;
    const arg = typeof rawArg === 'string' ? rawArg.trim() : '';
    if (!arg) {
      continue;
    }
    const rawValue = (item as { value?: unknown }).value;
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    out.push(value ? { arg, value } : { arg });
  }
  return out.length > 0 ? out : undefined;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
