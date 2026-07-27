import * as vscode from 'vscode';

export interface ClientErrorMessage {
  type: 'clientError';
  message: string;
  source?: string;
  line?: number;
}

/**
 * Host-side handler for an uncaught client-side error from any webview
 * panel that embeds `CLIENT_ERROR_JS`. This does not restore whatever
 * listener failed to wire -- it converts "the panel is silently inert",
 * which produced zero signal anywhere for a full release (see
 * `toolSetupPanel.ts`'s v0.42.0 crash), into a visible, reportable error.
 */
export function handleClientErrorMessage(msg: ClientErrorMessage): void {
  console.error(`EDA Job Runner: webview client error: ${msg.message} (${msg.source ?? '?'}:${msg.line ?? '?'})`);
  void vscode.window.showErrorMessage('EDA Job Runner: a panel failed to initialize. Please report this.');
}

/**
 * Client-side snippet -- embed via `${CLIENT_ERROR_JS}` immediately after
 * `const vscode = acquireVsCodeApi();` in every panel's own `<script>`
 * block, before any other wiring, so it's registered before anything else
 * has a chance to throw.
 */
export const CLIENT_ERROR_JS = `
  window.addEventListener('error', e => {
    vscode.postMessage({
      type: 'clientError',
      message: e.message || String(e.error || 'unknown error'),
      source: e.filename,
      line: e.lineno
    });
  });
`;
