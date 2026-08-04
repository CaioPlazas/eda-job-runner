import * as vscode from 'vscode';
import { JobStore } from './jobStore';
import { GlobalParam, ValueList } from './types';
import { BASE_CSS } from './webviewTheme';
import { HELP_CSS, help } from './webviewHelp';
import { discoverList } from './toolIntrospect';
import { BROWSE_CSS, BROWSE_JS, BrowseMessage, handleBrowseMessage } from './webviewBrowse';
import { CLIENT_ERROR_JS, ClientErrorMessage, handleClientErrorMessage } from './webviewError';
import { SETUP_ERROR_CSS, OPEN_STEP_JS, setupErrorHtml, StepId } from './webviewSteps';
import { confirmOverwriteIfStale } from './staleWrite';

interface SaveMessage {
  type: 'save';
  params: { name: string; value: string }[];
}
interface CancelMessage {
  type: 'cancel';
}
interface OpenStepMessage {
  type: 'openStep';
  step: StepId;
}
interface AddListMessage {
  type: 'addList';
  name: string;
  sourceType: 'file' | 'command';
  source: string;
  pattern: string;
  insertTemplate: string;
  scanDir: string;
}
interface RefreshListMessage {
  type: 'refreshList';
  name: string;
  sourceType: 'file' | 'command';
  source: string;
  pattern: string;
  insertTemplate: string;
  scanDir: string;
}
interface RemoveListMessage {
  type: 'removeList';
  name: string;
}
interface RefreshAllListsMessage {
  type: 'refreshAllLists';
}

type WebviewMessage =
  | SaveMessage
  | CancelMessage
  | OpenStepMessage
  | AddListMessage
  | RefreshListMessage
  | RemoveListMessage
  | RefreshAllListsMessage
  | BrowseMessage
  | ClientErrorMessage;

export class ParamsPanel {
  private static current: ParamsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Guards against a second Save landing while the first one's write is still in flight. */
  private saving = false;
  /** Store revision this panel's contents came from -- see staleWrite.ts. */
  private renderedRevision = 0;
  /** The probe command behind a list's current scanError, by list name -- transient, never persisted, shown via setupErrorHtml. */
  private readonly lastProbeCommands = new Map<string, string | undefined>();

  static createOrShow(
    jobStore: JobStore,
    folder: vscode.WorkspaceFolder
  ): void {
    if (ParamsPanel.current) {
      ParamsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('edaParamsConfig', 'Parameters & Value Lists', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    ParamsPanel.current = new ParamsPanel(panel, jobStore, folder);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly jobStore: JobStore,
    private readonly folder: vscode.WorkspaceFolder
  ) {
    this.panel = panel;
    this.render();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
        // A rejected promise here (e.g. an I/O error mid-scan) would
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

  /**
   * Full-document render. Only ever called once, from the constructor: every
   * later change to this panel is a targeted DOM patch (`postLists`) instead.
   * Reassigning `webview.html` is a page reload -- it destroys every typed
   * parameter row and every half-filled new-list row on the screen, which is
   * why this used to need `draftParams`/`draftLists` shuttling state back and
   * forth just to survive its own re-renders.
   */
  private render(): void {
    this.renderedRevision = this.jobStore.getRevision();
    this.panel.webview.html = renderHtml(
      this.panel.webview,
      this.jobStore.getParams(),
      this.jobStore.getLists(),
      this.lastProbeCommands
    );
  }

  /**
   * The replacement for re-rendering after a list action: the client patches
   * just the rows that changed and leaves everything else -- parameter rows,
   * other lists, in-progress typing, scroll position, focus -- untouched.
   */
  private postLists(): void {
    this.renderedRevision = this.jobStore.getRevision();
    void this.panel.webview.postMessage({ type: 'lists', lists: listsPayload(this.jobStore.getLists(), this.lastProbeCommands) });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'cancel':
        this.panel.dispose();
        return;
      case 'openStep':
        await vscode.commands.executeCommand(
          msg.step === 1
            ? 'eda-job-runner.configureShell'
            : msg.step === 2
              ? 'eda-job-runner.configureTools'
              : msg.step === 3
                ? 'eda-job-runner.addJob'
                : 'eda-job-runner.configureParams'
        );
        return;
      case 'save': {
        if (this.saving) {
          return;
        }
        // setParams replaces the whole parameter list, so a hand edit that
        // landed while this panel sat open would go with it -- see staleWrite.ts.
        if (
          this.jobStore.hasChangedSince(this.renderedRevision) &&
          !(await confirmOverwriteIfStale('.vscode/eda-jobs.json', true))
        ) {
          return;
        }
        this.saving = true;
        try {
          const params: GlobalParam[] = msg.params
            .map(p => ({ name: p.name.trim(), value: p.value }))
            .filter(p => p.name.length > 0);
          await this.jobStore.setParams(params);
        } catch (err) {
          void this.panel.webview.postMessage({
            type: 'saveError',
            message: `Could not save parameters: ${err instanceof Error ? err.message : String(err)}`
          });
          return;
        } finally {
          this.saving = false;
        }
        this.renderedRevision = this.jobStore.getRevision();
        // The panel stays open on Save, like every other panel here: closing it
        // discarded any value-list row being edited alongside the parameters,
        // and there's nothing about saving that means "I'm done with this
        // screen". A flash confirms it instead of a notification -- the tab
        // being right there is the rest of the confirmation.
        void this.panel.webview.postMessage({ type: 'saved' });
        return;
      }
      case 'addList':
      case 'refreshList': {
        const name = msg.name.trim();
        const source = msg.source.trim();
        if (!name || !source) {
          return; // true no-op, e.g. the blank "add new" row
        }
        const scanDir = msg.scanDir.trim() || undefined;
        // Seed with the currently-stored values (refreshList only -- addList
        // has none yet) so discoverList can fall back to them instead of
        // wiping a working list to empty on a transient scan failure.
        const previousValues = msg.type === 'refreshList' ? this.jobStore.getLists().find(l => l.name === name)?.values ?? [] : [];
        const list: ValueList = {
          name,
          command: msg.sourceType === 'command' ? source : undefined,
          file: msg.sourceType === 'file' ? source : undefined,
          pattern: msg.pattern.trim() || undefined,
          insertTemplate: msg.insertTemplate.trim() || undefined,
          scanDir,
          values: previousValues
        };
        const { list: discovered, probeCommand } = await discoverList(list, this.jobStore, this.folder, scanDir);
        if (discovered.scanError) {
          this.lastProbeCommands.set(name, probeCommand);
        } else {
          this.lastProbeCommands.delete(name);
        }
        // Index-preserving upsert -- an edit (Add over an existing name, or
        // Refresh) replaces in place instead of moving to the bottom.
        const lists = this.jobStore.getLists();
        const idx = lists.findIndex(l => l.name === name);
        const next = lists.slice();
        if (idx === -1) {
          next.push(discovered);
        } else {
          next[idx] = discovered;
        }
        await this.jobStore.setLists(next);
        this.postLists();
        return;
      }
      case 'removeList': {
        const lists = this.jobStore.getLists().filter(l => l.name !== msg.name);
        await this.jobStore.setLists(lists);
        this.lastProbeCommands.delete(msg.name);
        this.postLists();
        return;
      }
      case 'refreshAllLists': {
        await vscode.commands.executeCommand('eda-job-runner.refreshValueLists');
        this.postLists();
        return;
      }
      case 'browse':
        return handleBrowseMessage(msg, this.panel.webview, this.folder);
      case 'clientError':
        return handleClientErrorMessage(msg);
    }
  }

  private cleanup(): void {
    ParamsPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/**
 * What the client needs to render a value-list row, for both the initial HTML
 * and every later `lists` patch -- one builder so the two can't drift. The
 * scan error is pre-rendered here because `setupErrorHtml` is host-side.
 */
function listsPayload(lists: ValueList[], probeCommands?: Map<string, string | undefined>) {
  return lists.map(l => ({
    ...l,
    errorHtml: l.scanError ? setupErrorHtml(l.scanError, probeCommands?.get(l.name)) : undefined
  }));
}

export function renderHtml(
  webview: vscode.Webview,
  params: GlobalParam[],
  lists: ValueList[],
  probeCommands?: Map<string, string | undefined>
): string {
  const nonce = getNonce();
  // Guards against a param/list value containing "</script>" breaking out of
  // the embedded script block, same convention as jobConfigPanel.ts's customArgsJson.
  const paramsJson = JSON.stringify(params).replace(/</g, '\\u003c');
  const listsJson = JSON.stringify(listsPayload(lists, probeCommands)).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Parameters &amp; Value Lists</title>
<style>
  ${BASE_CSS}
  ${HELP_CSS}
  ${BROWSE_CSS}
  ${SETUP_ERROR_CSS}
  h2 { margin-top: var(--eda-gap); }
  h2:first-child { margin-top: 0; }
  .paramRow { display: flex; gap: 6px; margin-top: var(--eda-gap-sm); align-items: center; flex-wrap: wrap; }
  .paramRow input { width: auto; flex: 1 1 200px; margin: 0; }
  .paramRow .pName { flex: 1 1 220px; }
  .paramRow .pValue { flex: 2 1 320px; }
  .actions { margin-top: var(--eda-gap-xl); }
  /* Same inline save feedback the other panels use -- Save keeps this tab open, so it needs to say so itself. */
  #saveOut { font-size: var(--eda-size-sm); min-height: 1.2em; }
  #saveOut.error { color: var(--vscode-errorForeground); }
  #saveOut.ok { color: var(--vscode-charts-green); }
  #paramsWrap { margin-top: var(--eda-gap); }
  #listsWrap { margin-top: var(--eda-gap); }
  .listItem {
    margin-top: 10px;
    padding: 10px var(--eda-gap);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.25));
    border-radius: var(--eda-radius);
  }
  .listRow { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .listRow input, .listRow select { width: auto; flex: 1 1 160px; margin: 0; }
  .listRow .lName { flex: 1 1 160px; }
  .listRow .lSourceType { flex: 0 0 auto; }
  .listRow .lSource { flex: 2 1 220px; }
  .listStatus { margin-top: 6px; }
  .listAdvanced { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .listAdvanced input { width: auto; flex: 1 1 260px; margin: 0; }
  .listAdvanced.hidden { display: none; }
</style>
</head>
<body>
  <h2>Parameters &amp; Value Lists</h2>

  <h3>Parameters ${help(
    "Workspace-wide named values, referenced in a job's Command (including the " +
      "Tool builder's free-text fields) as <code>" +
      '${var:NAME}' +
      '</code>. Resolved silently every run — no prompt, unlike <code>' +
      '${param:NAME}' +
      "</code> (which still prompts every Run and is unaffected by this panel). " +
      "A job can override any parameter's value for itself in its own Configure form. Saved automatically as you type."
  )}</h3>

  <div id="paramsWrap"></div>
  <button class="secondary" id="addParam" type="button" style="margin-top:10px;">+ Add parameter</button>

  <h3>Value lists ${help(
    'A named list of values (e.g. a test list), discovered from a command\'s stdout or a file, ' +
      'surfaced as a dropdown in any job\'s Configure form. <b>Attach one to a specific flag</b> from ' +
      "Tool Setup's per-option \"value source\" column, or a job can attach one for itself only, from its " +
      "own Configure form. Leave a list unattached for a value with " +
      'no real CLI flag to attach to (e.g. a plusarg like <code>+UVM_TESTNAME=</code>) — an unattached list ' +
      "keeps its own row in a job's Configure form, with an insert template controlling exactly how a picked " +
      'value is written into the Command.'
  )}</h3>
  <div id="listsWrap"></div>
  <button class="secondary" id="addList" type="button" style="margin-top:10px;">+ Add value list</button>
  <button class="secondary" id="refreshAllLists" type="button" style="margin-top:10px;">↻ Refresh all</button>

  <div class="actions">
    <button class="primary" id="save">Save</button>
    <button class="secondary" id="cancel">Cancel</button>
    <span id="saveOut"></span>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    ${CLIENT_ERROR_JS}
    ${BROWSE_JS}
    ${OPEN_STEP_JS}
    const paramsWrap = document.getElementById('paramsWrap');
    const listsWrap = document.getElementById('listsWrap');

    function addParamRow(name, value) {
      const row = document.createElement('div');
      row.className = 'paramRow';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'pName mono';
      nameInput.placeholder = 'name (e.g. TESTBENCH_DIR)';
      nameInput.value = name || '';

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'pValue mono';
      valueInput.placeholder = 'value';
      valueInput.value = value || '';

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => row.remove());

      row.appendChild(nameInput);
      row.appendChild(valueInput);
      row.appendChild(removeBtn);
      paramsWrap.appendChild(row);
    }

    document.getElementById('addParam').addEventListener('click', () => addParamRow());
    (${paramsJson}).forEach(p => addParamRow(p.name, p.value));

    function collectParams() {
      return Array.from(paramsWrap.querySelectorAll('.paramRow')).map(row => ({
        name: row.querySelector('.pName').value,
        value: row.querySelector('.pValue').value
      }));
    }

    const saveOut = document.getElementById('saveOut');

    document.getElementById('save').addEventListener('click', () => {
      saveOut.textContent = '';
      saveOut.className = '';
      vscode.postMessage({ type: 'save', params: collectParams() });
    });
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

    window.addEventListener('message', event => {
      const m = event.data;
      if (!m) { return; }
      if (m.type === 'saveError') {
        saveOut.className = 'error';
        saveOut.textContent = m.message;
      } else if (m.type === 'saved') {
        saveOut.className = 'ok';
        saveOut.textContent = 'Saved ✓';
        setTimeout(() => {
          if (saveOut.textContent === 'Saved ✓') { saveOut.textContent = ''; saveOut.className = ''; }
        }, 4000);
      } else if (m.type === 'lists') {
        applyLists(m.lists);
      }
    });

    /**
     * Patch the value-list section to match \`lists\`, touching nothing else on
     * the page. Saved rows are keyed by data-list-name: one that changed is
     * replaced, one that's gone is removed, one that's new is inserted ahead of
     * any in-progress rows. A row the user is still filling in has no
     * data-list-name and is never touched -- except the one whose Add just
     * succeeded, which the freshly saved row replaces.
     *
     * This exists instead of re-rendering the whole document, which is what a
     * list action used to do: that wiped every typed parameter row and every
     * half-finished new list, and needed the host to shuttle both back and
     * forth on every message just to put them back.
     */
    function applyLists(lists) {
      const incoming = new Map(lists.map(l => [l.name, l]));
      Array.from(listsWrap.querySelectorAll('.listItem[data-list-name]')).forEach(row => {
        const name = row.getAttribute('data-list-name');
        const next = incoming.get(name);
        if (!next) {
          row.remove();
          return;
        }
        row.replaceWith(buildListRow(next, false));
        incoming.delete(name);
      });
      const drafts = Array.from(listsWrap.querySelectorAll('.listItem:not([data-list-name])'));
      incoming.forEach(list => {
        // The draft row this list was just created from, if it's still there.
        const draft = drafts.find(row => row.querySelector('.lName').value.trim() === list.name);
        const saved = buildListRow(list, false);
        if (draft) {
          draft.replaceWith(saved);
          drafts.splice(drafts.indexOf(draft), 1);
        } else {
          listsWrap.insertBefore(saved, drafts[0] || null);
        }
      });
    }

    // Existing lists render read-only-ish (name locked once saved, matching
    // the old Tool Setup behavior) with immediate Refresh/Remove; the blank
    // row at the bottom is the "add a new one" form. Returns the element
    // rather than appending it, so applyLists can swap a single row in place.
    function buildListRow(list, isNew) {
      list = list || { name: '', command: '', file: '', pattern: '', insertTemplate: '', scanDir: '', values: [], scanError: undefined };
      const row = document.createElement('div');
      row.className = 'listItem';
      if (!isNew) {
        // The key applyLists patches by. Absent on a row still being filled in.
        row.setAttribute('data-list-name', list.name);
      }

      const top = document.createElement('div');
      top.className = 'listRow';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'lName mono';
      nameInput.placeholder = 'name (e.g. Test)';
      nameInput.value = list.name || '';
      nameInput.disabled = !isNew;
      top.appendChild(nameInput);

      const sourceTypeSelect = document.createElement('select');
      sourceTypeSelect.className = 'lSourceType';
      ['command', 'file'].forEach(v => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        sourceTypeSelect.appendChild(o);
      });
      sourceTypeSelect.value = list.file ? 'file' : 'command';
      top.appendChild(sourceTypeSelect);

      const sourceInput = document.createElement('input');
      sourceInput.type = 'text';
      sourceInput.className = 'lSource mono';
      sourceInput.placeholder = 'source (command to run, or file path)';
      sourceInput.value = list.command || list.file || '';
      top.appendChild(sourceInput);
      // Only a file source is a real path to browse for -- a command isn't.
      const sourceBrowseBtn = addBrowseButton(sourceInput, 'file');
      const syncSourceBrowseVisibility = () => {
        sourceBrowseBtn.style.display = sourceTypeSelect.value === 'file' ? '' : 'none';
      };
      sourceTypeSelect.addEventListener('change', syncSourceBrowseVisibility);
      syncSourceBrowseVisibility();

      const patternInput = document.createElement('input');
      patternInput.type = 'text';
      patternInput.className = 'lPattern mono';
      patternInput.placeholder = 'pattern (optional regex)';
      patternInput.value = list.pattern || '';
      top.appendChild(patternInput);

      const templateInput = document.createElement('input');
      templateInput.type = 'text';
      templateInput.className = 'lTemplate mono';
      templateInput.placeholder = 'insert template, for an unattached list (default \${value})';
      templateInput.value = list.insertTemplate || '';
      top.appendChild(templateInput);

      const advToggle = document.createElement('button');
      advToggle.type = 'button';
      advToggle.className = 'secondary small';
      advToggle.textContent = 'Advanced';
      top.appendChild(advToggle);

      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'primary small';
      actionBtn.textContent = isNew ? 'Add' : '↻ Refresh';
      top.appendChild(actionBtn);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary small';
      removeBtn.textContent = isNew ? 'Clear' : 'Remove';
      top.appendChild(removeBtn);

      row.appendChild(top);

      const adv = document.createElement('div');
      adv.className = 'listAdvanced hidden';
      const scanDirInput = document.createElement('input');
      scanDirInput.type = 'text';
      scanDirInput.className = 'lScanDir mono';
      scanDirInput.placeholder = "scan directory (leave blank to use the workspace's post-setup working directory)";
      scanDirInput.value = list.scanDir || '';
      adv.appendChild(scanDirInput);
      addBrowseButton(scanDirInput, 'folder');
      advToggle.addEventListener('click', () => adv.classList.toggle('hidden'));
      row.appendChild(adv);

      const statusEl = document.createElement('div');
      statusEl.className = 'listStatus';
      if (!isNew) {
        if (list.scanError) {
          statusEl.innerHTML = list.errorHtml || ('⚠ ' + list.scanError);
        } else {
          const n = (list.values || []).length;
          let text = n + ' value' + (n === 1 ? '' : 's');
          if (n > 0) {
            text += ': ' + list.values.slice(0, 12).join(', ') + (n > 12 ? ', …(+' + (n - 12) + ')' : '');
          }
          const hintDiv = document.createElement('div');
          hintDiv.className = 'hint';
          hintDiv.textContent = text;
          statusEl.appendChild(hintDiv);
        }
        row.appendChild(statusEl);
      }

      actionBtn.addEventListener('click', () => {
        vscode.postMessage({
          type: isNew ? 'addList' : 'refreshList',
          name: nameInput.value,
          sourceType: sourceTypeSelect.value,
          source: sourceInput.value,
          pattern: patternInput.value,
          insertTemplate: templateInput.value,
          scanDir: scanDirInput.value
        });
      });
      removeBtn.addEventListener('click', () => {
        if (isNew) {
          nameInput.value = '';
          sourceInput.value = '';
          patternInput.value = '';
          templateInput.value = '';
          scanDirInput.value = '';
          return;
        }
        vscode.postMessage({ type: 'removeList', name: list.name });
      });

      return row;
    }

    function addListRow(list, isNew) {
      listsWrap.appendChild(buildListRow(list, isNew));
    }

    (${listsJson}).forEach(l => addListRow(l, false));
    document.getElementById('addList').addEventListener('click', () => addListRow(null, true));
    document.getElementById('refreshAllLists').addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshAllLists' });
    });
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
