// The shared base stylesheet for all five webview panels -- the missing member
// of the `HELP_CSS` / `BROWSE_CSS` / `PROBE_CSS` / `SETUP_ERROR_CSS` set every
// panel already concatenates in. Pure (no `vscode` import), so
// test-fixtures/run-webview-theme-tests.mjs can import it directly.
//
// It exists because the same body/input/button/hint/actions block was
// copy-pasted into all five panels and had quietly drifted apart: input padding
// `9px 12px` in four panels vs `6px 8px` in the Log Viewer, `label` margin-top
// 18px vs 14px, `button.small` 0.8em/2px-8px vs 0.85em/3px-10px, max-width 1200
// vs 1600, and three different border radii. Consolidating is what makes the
// two type rules below enforceable rather than aspirational.
//
// **Interpolate this FIRST** in a panel's `<style>` block, ahead of the panel's
// own rules and the other shared CSS constants. Everything here is written to
// be overridable by a later same-specificity rule; putting it last would
// silently clobber panel-specific layout.

/**
 * ## Rule 1: no fractional-`em` font sizes. Ever.
 *
 * Use `--eda-size` / `--eda-size-sm` / `--eda-size-xs`. Nothing else.
 *
 * The panels used to carry 30 `font-size` declarations at `0.8em`-`0.9em`
 * against VS Code's ~13px UI font, several of them nested so they *multiplied*:
 * `.willRun {0.85em}` containing a `button {0.85em}` rendered at ~9.4px, and the
 * Log Viewer's status badge (`table {0.9em}` > `.badge {0.82em}`) at ~9.6px --
 * the single most important cell in that table was the least readable text in
 * the extension. `webviewHelp.ts` hit this first and worked around it locally
 * with fixed px; this generalises that fix instead of repeating it.
 *
 * The `max()` floor is what makes these safe to nest anyway: a token can never
 * resolve below its floor no matter what it inherits. It does not fight
 * `window.zoomLevel` -- VS Code zoom scales px units too.
 *
 * ## Rule 2: monospace is opt-in, never inherited.
 *
 * Every panel used to set `input, textarea, select { font-family:
 * var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size) }`
 * -- the *editor's* font at the *editor's* size. That coupled this extension's
 * legibility to an unrelated setting: `editor.fontSize: 11` for dense HDL
 * shrank every field here to 11px while its own label stayed at 13px.
 *
 * Fields now default to the UI font. Add `class="mono"` only where character
 * alignment genuinely matters and a stray space or quote must be visible:
 * commands, regex patterns, paths, env text, `${var:NAME}` identifiers, search
 * queries. Not names, folders, dropdowns, counts, or dates.
 */
export const BASE_CSS = `
  :root {
    --eda-font: var(--vscode-font-family);
    --eda-mono: var(--vscode-editor-font-family, monospace);
    --eda-size: max(13px, var(--vscode-font-size, 13px));
    --eda-size-sm: max(12px, calc(var(--vscode-font-size, 13px) * 0.92));
    --eda-size-xs: max(11px, calc(var(--vscode-font-size, 13px) * 0.85));
    --eda-radius-sm: 3px;
    --eda-radius: 6px;
    --eda-gap-xs: 4px;
    --eda-gap-sm: 8px;
    --eda-gap: 12px;
    --eda-gap-lg: 16px;
    --eda-gap-xl: 24px;
    --eda-border: var(--vscode-input-border, rgba(127,127,127,0.3));
  }
  body {
    font-family: var(--eda-font);
    font-size: var(--eda-size);
    color: var(--vscode-foreground);
    padding: var(--eda-gap-xl);
    max-width: min(1200px, 100%);
    width: 100%;
  }
  h2 { margin-top: 0; }
  label { display: block; margin-top: var(--eda-gap-lg); font-weight: 600; }
  input, textarea, select {
    width: 100%;
    box-sizing: border-box;
    margin-top: var(--eda-gap-xs);
    padding: 7px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--eda-radius-sm);
    font-family: var(--eda-font);
    font-size: var(--eda-size);
  }
  input:focus, textarea:focus, select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  option { background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  /* Rule 2 -- the opt-in. Deliberately does NOT set a font-size: a mono field
     is still a field, and should line up with the label above it. */
  .mono { font-family: var(--eda-mono); }
  textarea { resize: vertical; }
  label.check { display: flex; align-items: center; gap: var(--eda-gap-sm); font-weight: 600; }
  label.check input { width: auto; margin-top: 0; }
  .hint { font-size: var(--eda-size-sm); color: var(--vscode-descriptionForeground); margin-top: var(--eda-gap-xs); }
  .err { color: var(--vscode-errorForeground); }
  .hidden { display: none; }
  button {
    padding: 6px 16px;
    border: 1px solid transparent;
    border-radius: var(--eda-radius-sm);
    cursor: pointer;
    font-family: var(--eda-font);
    font-size: var(--eda-size);
  }
  button.small { padding: 3px 10px; font-size: var(--eda-size-sm); }
  /* Inputs had a focus ring and buttons had nothing at all -- keyboard focus on
     any button in any panel was completely invisible. :focus-visible so a mouse
     click doesn't leave a ring behind. */
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  /* Layout only, no margin-top: panels place their own action rows at different
     depths (Tool Setup nests several inside cards) and each keeps its own
     spacing. Sharing the margin here is what made them drift in the first place. */
  .actions { display: flex; gap: var(--eda-gap-sm); align-items: center; flex-wrap: wrap; }
`;
