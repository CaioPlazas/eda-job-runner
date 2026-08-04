// The regression gate for the two type rules in src/webviewTheme.ts, plus the
// motion rules added later. It scans each panel's REAL rendered `<style>`
// block, not the source -- so a rule reintroduced through any of the shared CSS
// constants (HELP_CSS, BROWSE_CSS, PROBE_CSS, SETUP_ERROR_CSS) is caught too.
//
// Why this exists: `webviewHelp.ts` found the compounding-em problem, fixed it
// in that one file, and left the same defect in place across all five panels
// for many releases -- until a user reported illegible text on a HiDPI display
// a second time. A comment does not stop that; a failing test does.
//
// Usage: node test-fixtures/run-webview-theme-tests.mjs
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const shimPath = path.join(repoRoot, 'scripts', 'vscode-webview-shim.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

// Same bundling trick the visual harness uses (scripts/render-webviews.mjs):
// alias the `vscode` import to a no-op shim so a panel module can be imported
// outside the extension host. renderHtml only ever reads `webview.cspSource`.
function bundle(srcRelPath, outName) {
  const outFile = `/tmp/webview-theme-${outName}.mjs`;
  execSync(
    `npx esbuild ${srcRelPath} --bundle --format=esm --platform=node --alias:vscode=${shimPath} --outfile=${outFile}`,
    { cwd: repoRoot, stdio: 'pipe' }
  );
  return outFile;
}

const fakeWebview = { cspSource: 'vscode-resource:' };

// Minimal arguments per panel -- enough to render, since this test only reads
// the <style> block, which is identical across a panel's rendered states.
const panels = [
  // Signatures: see each panel's `export function renderHtml(...)`.
  { name: 'jobConfig', src: './src/jobConfigPanel.ts', args: w => [w, undefined, [], [], undefined, false, [], [], []] },
  { name: 'toolSetup', src: './src/toolSetupPanel.ts', args: w => [w, [], [], undefined, undefined, undefined, undefined, ''] },
  {
    name: 'shellEnv',
    src: './src/shellEnvPanel.ts',
    args: w => [
      w,
      {
        shellPath: 'bash',
        shellArgsAuto: true,
        shellArgs: '-lc',
        env: '',
        setupScript: '',
        setupCommands: '',
        postSetupCwd: '',
        logsDirectory: '',
        logRetentionCount: 20,
        logRetentionMaxSizeMB: 0,
        maxConcurrentJobs: 0,
        setupChecks: '',
        registeredTools: []
      }
    ]
  },
  { name: 'params', src: './src/paramsPanel.ts', args: w => [w, [], [], new Map()] },
  { name: 'logViewer', src: './src/logViewerPanel.ts', args: w => [w] }
];

const styles = {};
for (const panel of panels) {
  const mod = await import(bundle(panel.src, panel.name));
  const html = mod.renderHtml(...panel.args(fakeWebview));
  const match = /<style>([\s\S]*?)<\/style>/.exec(html);
  check(match !== null, `${panel.name}: has a <style> block`);
  styles[panel.name] = match ? match[1] : '';
}

// --- Rule 1: no fractional-em font sizes -----------------------------------
// The failure this prevents is compounding: `.willRun {0.85em}` containing a
// `button {0.85em}` resolved to ~9.4px, and the Log Viewer's status badge
// (`table {0.9em}` x `.badge {0.82em}`) to ~9.6px, against a 13px base.

const FRACTIONAL_EM = /font-size:\s*(?:0?\.\d+|\d+\.\d+)em/g;
for (const [name, css] of Object.entries(styles)) {
  const hits = css.match(FRACTIONAL_EM) ?? [];
  check(
    hits.length === 0,
    `${name}: no fractional-em font-size${hits.length ? ` (found ${hits.length}: ${[...new Set(hits)].join(', ')})` : ''}`
  );
}

// --- Rule 2: monospace is opt-in, never inherited --------------------------
// Fields must not be sized from the editor's font, or `editor.fontSize: 11`
// shrinks every input in the extension while its own label stays at 13px.

for (const [name, css] of Object.entries(styles)) {
  check(!css.includes('--vscode-editor-font-size'), `${name}: no field is sized from the editor's font size`);
  check(css.includes('.mono'), `${name}: carries the .mono opt-in class`);
}

// --- The shared sheet is actually shared ------------------------------------

for (const [name, css] of Object.entries(styles)) {
  const tokenBlocks = css.match(/--eda-size-xs:/g) ?? [];
  check(tokenBlocks.length === 1, `${name}: BASE_CSS is included exactly once (found ${tokenBlocks.length})`);
  check(css.includes('font-size: var(--eda-size)'), `${name}: body type comes from the shared token`);
}

// Every token a panel references must be one BASE_CSS actually defines --
// otherwise it silently resolves to nothing and the property is dropped.
const defined = new Set([...(styles.jobConfig.match(/(--eda-[a-z-]+):/g) ?? [])].map(s => s.slice(0, -1)));
for (const [name, css] of Object.entries(styles)) {
  const used = new Set([...(css.match(/var\((--eda-[a-z-]+)/g) ?? [])].map(s => s.slice(4)));
  const undefinedTokens = [...used].filter(t => !defined.has(t));
  check(undefinedTokens.length === 0, `${name}: every --eda-* token used is defined${undefinedTokens.length ? ` (missing: ${undefinedTokens.join(', ')})` : ''}`);
}

// --- The floors hold --------------------------------------------------------
// A token must never resolve below its floor, whatever font context it sits in.
// This is what makes the tokens safe to nest where raw `em` values were not.

const themeSrc = fs.readFileSync(path.join(repoRoot, 'src', 'webviewTheme.ts'), 'utf8');
for (const token of ['--eda-size', '--eda-size-sm', '--eda-size-xs']) {
  const re = new RegExp(`${token}:\\s*max\\(\\s*(\\d+)px`);
  const m = re.exec(themeSrc);
  check(m !== null, `${token} is declared with a max() floor`);
  check(m !== null && Number(m[1]) >= 11, `${token}'s floor is at least 11px (got ${m ? m[1] : '?'}px)`);
}

// --- Motion rules (Phase 3; assert nothing until motion lands) --------------
// 1. nothing exceeds 200ms  2. reduced motion is honoured wherever motion exists.

for (const [name, css] of Object.entries(styles)) {
  const durations = [...css.matchAll(/(?:transition|animation)[^;{}]*?(\d+)ms/g)].map(m => Number(m[1]));
  const tooSlow = durations.filter(d => d > 200);
  check(tooSlow.length === 0, `${name}: no transition or animation exceeds 200ms${tooSlow.length ? ` (found ${tooSlow.join('ms, ')}ms)` : ''}`);
  if (durations.length > 0) {
    check(css.includes('prefers-reduced-motion'), `${name}: has motion, so it honours prefers-reduced-motion`);
  }
}

console.log(failures === 0 ? '\nALL WEBVIEW-THEME ASSERTIONS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
