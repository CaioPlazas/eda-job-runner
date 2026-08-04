// Pure HTML/CSS/JS strings for the setup-error recovery UI shared by the
// Tool Setup and Parameters panels. No `vscode` import, so this is
// unit-tested by the standalone Node harness (test-fixtures/run-steps-tests.mjs)
// the same way webviewHelp.ts's sibling modules are.

export type StepId = 1 | 2 | 3 | 4;

export const SETUP_ERROR_CSS = `
  .setupError { border-left: 3px solid var(--vscode-charts-yellow); padding: 6px 10px; margin: 8px 0; font-size: var(--eda-size); }
  .setupError .probeLine { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--eda-size-sm); background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 4px 6px; margin: 6px 0; white-space: pre-wrap; }
  .setupError .actions { margin-top: 8px; display: flex; gap: 8px; }
`;

/** Explanatory block for a scan/list failure that is probably a shell-environment problem. */
export function setupErrorHtml(message: string, probeCommand?: string): string {
  const probeLine = probeCommand ? `<div class="probeLine">${escapeHtml(probeCommand)}</div>` : '';
  return `
    <div class="setupError">
      <div>⚠ ${escapeHtml(message)}</div>
      ${probeCommand ? `<p>The scan ran this through your configured shell:</p>${probeLine}` : ''}
      <p>If this tool needs a module load or a licence variable first, set it in Shell &amp; Environment.</p>
      <div class="actions">
        <button type="button" class="secondary" data-open-step="1">Open Shell &amp; Environment</button>
      </div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Client-side JS: `[data-open-step]` clicks (e.g. setupErrorHtml's recovery button) postMessage({type:'openStep', step}). */
export const OPEN_STEP_JS = `
  document.addEventListener('click', event => {
    const openStepBtn = event.target.closest('[data-open-step]');
    if (openStepBtn) {
      vscode.postMessage({ type: 'openStep', step: Number(openStepBtn.dataset.openStep) });
    }
  });
`;
