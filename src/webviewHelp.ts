// Shared "(?)" hover/focus help-icon convention for every webview panel
// (jobConfigPanel.ts, toolSetupPanel.ts, shellEnvPanel.ts, paramsPanel.ts).
// Previously duplicated (and only actually used) in jobConfigPanel.ts alone;
// the other three panels still used plain always-visible hint text. Pulled
// out here so all four panels render the same icon, at the same (legible)
// size, instead of three of them never having gotten it at all.
//
// Sizing is fixed-px rather than the original's `em`-relative values: the
// icon glyph was `0.72em` and the tooltip body `0.85em`, both relative to
// VS Code's own already-small (~13px) UI font variable -- compounding to
// sub-11px effective rendering on a high-DPI display with no floor. Fixed
// pixel sizes here avoid that regardless of the inherited font context.

export const HELP_CSS = `
  .help {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--vscode-badge-background, rgba(127,127,127,0.35));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    font-size: 12px;
    font-weight: 700;
    cursor: help;
    margin-left: 6px;
    position: relative;
    vertical-align: middle;
  }
  .help .tip {
    display: none;
    position: absolute;
    left: 0;
    top: 130%;
    z-index: 10;
    width: 320px;
    max-width: 60vw;
    padding: 8px 10px;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-input-background));
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-input-border, rgba(127,127,127,0.4)));
    border-radius: 4px;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.45;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
  .help:hover .tip, .help:focus .tip { display: block; }
`;

/**
 * A small (?) icon that reveals `html` on hover/focus -- CSS-only, no script
 * needed. `html` may itself contain markup (code/b/br) -- it must always be
 * this extension's own static copy, never user/workspace data, since it's
 * not escaped.
 */
export function help(html: string): string {
  return `<span class="help" tabindex="0">?<span class="tip">${html}</span></span>`;
}
