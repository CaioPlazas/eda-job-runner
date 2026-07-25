import * as vscode from 'vscode';

export interface BrowseMessage {
  type: 'browse';
  requestId: number;
  kind: 'folder' | 'file';
  currentValue: string;
}

/**
 * Host-side handler for a generic folder/file picker request from any
 * webview panel that embeds `BROWSE_JS`'s client helper. Posts back
 * `{ type: 'browsed', requestId, path }` (`path` omitted if the user
 * cancelled) so the client can correlate the response to whichever
 * Browse button triggered it -- a panel can have several.
 */
export async function handleBrowseMessage(
  msg: BrowseMessage,
  webview: vscode.Webview,
  folder: vscode.WorkspaceFolder
): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: msg.kind === 'folder',
    canSelectFiles: msg.kind === 'file',
    canSelectMany: false,
    defaultUri: folder.uri,
    openLabel: msg.kind === 'folder' ? 'Select folder' : 'Select file'
  });
  void webview.postMessage({
    type: 'browsed',
    requestId: msg.requestId,
    path: picked && picked.length > 0 ? picked[0].fsPath : undefined
  });
}

export const BROWSE_CSS = '.browseBtn { display: inline-block; margin-top: 6px; padding: 6px 12px; }';

/**
 * Client-side snippet -- embed via `${BROWSE_JS}` inside a panel's own
 * `<script>` block, anywhere after `const vscode = acquireVsCodeApi();`.
 * Provides `addBrowseButton(inputEl, kind)` (`kind: 'folder' | 'file'`):
 * inserts a "Browse…" button right after `inputEl` that opens a native
 * picker and writes the chosen path into `inputEl`, dispatching an `input`
 * event so any existing listener on the field still fires. Safe with
 * multiple buttons on one panel -- each request is correlated by an
 * incrementing id, not tied to a single hardcoded field the way the one
 * bespoke picker this replaces (Shell & Environment's old Logs Directory
 * Browse button) was.
 */
export const BROWSE_JS = `
  let __browseRequestId = 0;
  const __browsePending = new Map();
  window.addEventListener('message', event => {
    const m = event.data;
    if (m && m.type === 'browsed' && __browsePending.has(m.requestId)) {
      const inputEl = __browsePending.get(m.requestId);
      __browsePending.delete(m.requestId);
      if (m.path) {
        inputEl.value = m.path;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  });
  function addBrowseButton(inputEl, kind) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary browseBtn';
    btn.textContent = 'Browse…';
    btn.addEventListener('click', () => {
      const requestId = ++__browseRequestId;
      __browsePending.set(requestId, inputEl);
      vscode.postMessage({ type: 'browse', requestId, kind, currentValue: inputEl.value });
    });
    inputEl.insertAdjacentElement('afterend', btn);
    return btn;
  }
`;
