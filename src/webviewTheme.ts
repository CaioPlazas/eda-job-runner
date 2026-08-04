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
 *
 * ## Motion: four rules, also test-enforced
 *
 * These panels are opened dozens of times a day, so motion here earns its place
 * by making a change legible -- never by decorating one.
 *
 * 1. **Nothing animates on initial render.** A panel that fades itself in every
 *    time it opens reads as slow, however brief the fade.
 * 2. **Nothing exceeds 200ms.** `run-webview-theme-tests.mjs` fails the build
 *    otherwise. The tokens are 120ms and 160ms.
 * 3. **Only `opacity`, `transform`, `background-color`, `outline-color` and
 *    `border-color`** -- never `height`/`width`/`top`/`left`, which force a
 *    layout pass on every frame.
 * 4. **No interaction ever waits on an animation.** Every animation here is
 *    decorative in the strict sense: delete it and the panel behaves the same.
 *
 * `prefers-reduced-motion` is honoured once, globally, at the end of BASE_CSS
 * rather than per-rule -- so it cannot be forgotten when a new animation lands.
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
   --eda-motion: 120ms;
    --eda-motion-slow: 160ms;
  }
  body {
    font-family: var(--eda-font);
    font-size: var(--eda-size);
    color: var(--vscode-foreground);
    padding: var(--eda-gap-xl);
    max-width: min(1200px, 100%);
    width: 100%;
    /* Without this, width:100% is the CONTENT box and the 24px padding is added
       on top of it -- every panel overflowed its viewport horizontally by 48px.
       Harmless-looking (the overflow is empty), but it means a sticky full-bleed
       bar can't line up with the viewport, and a narrow panel gets a horizontal
       scrollbar it has no use for. */
    box-sizing: border-box;
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
  /* A page-level action row, opt-in via class="actions sticky". Configure Job's
     Save sat below ~160 lines of form -- off screen in normal use, on a panel
     where Save is the whole point and (since v1.6.0) no longer closes the
     window. Only the ONE bottom row of a panel gets this: Tool Setup nests
     several .actions inside its tool cards, and those must scroll normally.
     The negative side margins pull the bar out over body's own padding so
     content scrolls under it edge to edge rather than peeking down the sides;
     the negative bottom margin lets it sit flush against the viewport bottom. */
  .actions.sticky {
    position: sticky;
    bottom: 0;
    z-index: 5;
    margin: var(--eda-gap-xl) calc(-1 * var(--eda-gap-xl)) calc(-1 * var(--eda-gap-xl));
    padding: var(--eda-gap) var(--eda-gap-xl);
    background: var(--vscode-editor-background);
    border-top: 1px solid var(--eda-border);
  }
  /* Section cards. The panels already spoke half a card language -- Tool Setup's
     .tool and Parameters' .listItem were bordered/rounded boxes while every
     <details> section was a bare top border -- so this settles it on cards.
     Opt-in by class because toolSetupPanel's <details> ARE its cards already
     and must not be double-boxed. */
  details.card {
    margin-top: var(--eda-gap-lg);
    border: 1px solid var(--eda-border);
    border-radius: var(--eda-radius);
    padding: 0 var(--eda-gap-lg);
  }
  details.card > summary { cursor: pointer; font-weight: 600; padding: var(--eda-gap) 0; }
  details.card[open] { padding-bottom: var(--eda-gap-lg); }

  /* ---- Motion. Four rules, see the module header. ------------------------ */

  button { transition: background-color var(--eda-motion) ease, outline-color var(--eda-motion) ease; }
  input, textarea, select { transition: border-color var(--eda-motion) ease, outline-color var(--eda-motion) ease; }
  tbody tr, .optRow, .listItem, .tool { transition: background-color var(--eda-motion) ease; }

  /* The save confirmation. v1.6.0 made Save keep the panel open, so this flash
     is the entire acknowledgement that anything happened -- it has to be
     noticeable without being waited on. Applied by adding .flash; replaying it
     needs the class removed and re-added across a frame (see FLASH_JS),
     because resetting textContent alone will not restart a running animation. */
  .flash { animation: edaFlash var(--eda-motion-slow) ease-out; }
  @keyframes edaFlash {
    from { opacity: 0; transform: translateY(-2px); }
    to   { opacity: 1; transform: none; }
  }

  /* Rows arriving from a client-side patch (paramsPanel's applyLists,
     toolSetupPanel's favourite toggle). Since v1.7.0 those panels swap
     individual rows instead of reloading the page, and without this the new row
     simply teleports in with nothing marking it as the thing that just changed. */
  .rowIn { animation: edaRowIn var(--eda-motion-slow) ease-out; }
  @keyframes edaRowIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: none; }
  }

  .busyOverlay { animation: edaFade 100ms ease-out; }
  @keyframes edaFade { from { opacity: 0; } to { opacity: 1; } }

  /* Non-negotiable, and deliberately global. Zeroing animation-duration is not
     enough on its own -- a looping animation also needs its iteration count
     pinned, or it keeps running at 0.01ms forever. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
`;

/**
 * Client-side helper: replay a CSS animation already attached to an element.
 * Embed via a template interpolation inside a panel's own `<script>` block, the
 * same way `BROWSE_JS` and `PROBE_JS` are.
 *
 * Re-setting an element's text does not restart its animation, and re-adding a
 * class it already has does nothing at all -- the class was never absent, so
 * nothing re-triggers. Removing it, forcing a reflow, then adding it back is
 * what actually replays it. Saving twice in a row has to flash twice, or the
 * second save looks like it did nothing.
 */
export const FLASH_JS = `
  function edaFlash(el) {
    if (!el) { return; }
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
`;
