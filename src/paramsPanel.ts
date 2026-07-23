import * as vscode from 'vscode';
import { JobStore } from './jobStore';
import { GlobalParam } from './types';
import { HELP_CSS, help } from './webviewHelp';

interface SaveMessage {
  type: 'save';
  params: { name: string; value: string }[];
}

interface CancelMessage {
  type: 'cancel';
}

type WebviewMessage = SaveMessage | CancelMessage;

export class ParamsPanel {
  private static current: ParamsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(jobStore: JobStore): void {
    if (ParamsPanel.current) {
      ParamsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('edaParamsConfig', 'Parameters', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    ParamsPanel.current = new ParamsPanel(panel, jobStore);
  }

  private constructor(panel: vscode.WebviewPanel, private readonly jobStore: JobStore) {
    this.panel = panel;
    this.panel.webview.html = renderHtml(panel.webview, jobStore.getParams());
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg)),
      this.panel.onDidDispose(() => this.cleanup())
    );
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'cancel':
        this.panel.dispose();
        return;
      case 'save': {
        const params: GlobalParam[] = msg.params
          .map(p => ({ name: p.name.trim(), value: p.value }))
          .filter(p => p.name.length > 0);
        await this.jobStore.setParams(params);
        void vscode.window.showInformationMessage('EDA Job Runner: parameters saved.');
        this.panel.dispose();
        return;
      }
    }
  }

  private cleanup(): void {
    ParamsPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function renderHtml(webview: vscode.Webview, params: GlobalParam[]): string {
  const nonce = getNonce();
  // Guards against a param value containing "</script>" breaking out of the
  // embedded script block, same convention as jobConfigPanel.ts's customArgsJson.
  const paramsJson = JSON.stringify(params).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Parameters</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 24px;
    max-width: min(1200px, 100%);
    width: 100%;
  }
  h2 { margin-top: 0; }
  .hint {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }
  ${HELP_CSS}
  .paramRow { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
  .paramRow input { width: auto; flex: 1 1 200px; margin: 0; }
  .paramRow .pName { flex: 1 1 220px; }
  .paramRow .pValue { flex: 2 1 320px; }
  input {
    box-sizing: border-box;
    padding: 9px 12px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }
  input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
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
  #paramsWrap { margin-top: 14px; }
</style>
</head>
<body>
  <h2>Parameters ${help(
    "Workspace-wide named values, referenced in a job's Command (including the " +
      "Tool builder's free-text fields) as <code>" +
      '${var:NAME}' +
      '</code>. Resolved silently every run — no prompt, unlike <code>' +
      '${param:NAME}' +
      "</code> (which still prompts every Run and is unaffected by this panel). " +
      "A job can override any parameter's value for itself in its own Configure form."
  )}</h2>

  <div id="paramsWrap"></div>
  <button class="secondary" id="addParam" type="button" style="margin-top:10px;">+ Add parameter</button>

  <div class="actions">
    <button class="primary" id="save">Save</button>
    <button class="secondary" id="cancel">Cancel</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const paramsWrap = document.getElementById('paramsWrap');

    function addParamRow(name, value) {
      const row = document.createElement('div');
      row.className = 'paramRow';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'pName';
      nameInput.placeholder = 'name (e.g. TESTBENCH_DIR)';
      nameInput.value = name || '';

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'pValue';
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

    document.getElementById('save').addEventListener('click', () => {
      const params = Array.from(paramsWrap.querySelectorAll('.paramRow')).map(row => ({
        name: row.querySelector('.pName').value,
        value: row.querySelector('.pValue').value
      }));
      vscode.postMessage({ type: 'save', params });
    });
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
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
