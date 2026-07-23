// Loads each rendered panel (see render-webviews.mjs) in headless Chromium
// via playwright-core and screenshots it, in both a dark and a light VS
// Code theme, at deviceScaleFactor:2 (to reproduce a HiDPI/1440p display --
// the original complaint that started the help-icon sizing fix). The
// panel's own client-side script is allowed to run for real (window.
// acquireVsCodeApi is stubbed via an init script, which VS Code webviews
// always provide) so the builder/table population logic executes exactly
// as it would in a real window; a few scripted interactions are captured
// too since those are exactly the paths recent bugs were found in.
//
// Requires: node scripts/render-webviews.mjs to have been run first.
// Usage: node scripts/screenshot-webviews.mjs
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const htmlDir = path.join(repoRoot, '.webview-preview', 'html');
const shotDir = path.join(repoRoot, '.webview-preview', 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const CHROME_PATH = path.join(
  os.homedir(),
  '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
);

// Approximate real VS Code Dark+ / Light+ values for every --vscode-*
// variable these panels actually reference (verified by grep against
// src/*.ts) -- plus --vscode-editor-background, which a real webview host
// injects onto <body> itself (these panels never set a body background,
// relying on that), so it has to be supplied here too for a faithful render.
const THEMES = {
  dark: {
    '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    '--vscode-font-size': '13px',
    '--vscode-editor-font-family': 'Consolas, "Courier New", monospace',
    '--vscode-editor-font-size': '14px',
    '--vscode-editor-background': '#1e1e1e',
    '--vscode-foreground': '#cccccc',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-errorForeground': '#f48771',
    '--vscode-focusBorder': '#007fd4',
    '--vscode-input-background': '#3c3c3c',
    '--vscode-input-foreground': '#cccccc',
    '--vscode-input-border': '#5a5a5a',
    '--vscode-button-background': '#0e639c',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#1177bb',
    '--vscode-button-secondaryBackground': '#3a3d41',
    '--vscode-button-secondaryForeground': '#ffffff',
    '--vscode-button-secondaryHoverBackground': '#45494e',
    '--vscode-badge-background': '#4d4d4d',
    '--vscode-badge-foreground': '#ffffff',
    '--vscode-editorHoverWidget-background': '#252526',
    '--vscode-editorHoverWidget-foreground': '#cccccc',
    '--vscode-editorHoverWidget-border': '#454545',
    '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-textCodeBlock-background': '#0a0a0a',
    '--vscode-terminal-ansiGreen': '#0dbc79',
    '--vscode-terminal-ansiRed': '#cd3131',
    '--vscode-terminal-ansiYellow': '#e5e510',
    '--vscode-charts-yellow': '#cca700'
  },
  light: {
    '--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    '--vscode-font-size': '13px',
    '--vscode-editor-font-family': 'Consolas, "Courier New", monospace',
    '--vscode-editor-font-size': '14px',
    '--vscode-editor-background': '#ffffff',
    '--vscode-foreground': '#3b3b3b',
    '--vscode-descriptionForeground': '#717171',
    '--vscode-errorForeground': '#a1260d',
    '--vscode-focusBorder': '#0090f1',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-foreground': '#3b3b3b',
    '--vscode-input-border': '#cecece',
    '--vscode-button-background': '#007acc',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#0062a3',
    '--vscode-button-secondaryBackground': '#5f6a79',
    '--vscode-button-secondaryForeground': '#ffffff',
    '--vscode-button-secondaryHoverBackground': '#4c5561',
    '--vscode-badge-background': '#c4c4c4',
    '--vscode-badge-foreground': '#333333',
    '--vscode-editorHoverWidget-background': '#f8f8f8',
    '--vscode-editorHoverWidget-foreground': '#383838',
    '--vscode-editorHoverWidget-border': '#c8c8c8',
    '--vscode-list-hoverBackground': '#e8e8e8',
    '--vscode-textCodeBlock-background': '#f5f5f5',
    '--vscode-terminal-ansiGreen': '#00bc00',
    '--vscode-terminal-ansiRed': '#cd3131',
    '--vscode-terminal-ansiYellow': '#949800',
    '--vscode-charts-yellow': '#895503'
  }
};

function themeStyleTag(theme) {
  const vars = THEMES[theme];
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
  return `:root { ${body} } html, body { background: var(--vscode-editor-background); }`;
}

const SAMPLE_LOG_VIEWER_ROWS = [
  {
    jobId: 'job-1',
    jobName: 'regress_seeds',
    folder: 'Regression',
    logPath: '/workspace/.eda-runner/logs/job-1/2026-07-20_10-00-00-000.log',
    filename: '2026-07-20_10-00-00-000.log',
    laneLabel: '3/10',
    seed: '826609497',
    command: 'questa_run.sh -s 826609497 -t regress_full --std g2001',
    started: '2026-07-20T10:00:00.000Z',
    state: 'failed',
    exitCode: '0',
    errorCount: 2,
    warningCount: 5
  },
  {
    jobId: 'job-1',
    jobName: 'regress_seeds',
    folder: 'Regression',
    logPath: '/workspace/.eda-runner/logs/job-1/2026-07-20_09-58-00-000.log',
    filename: '2026-07-20_09-58-00-000.log',
    laneLabel: '2/10',
    seed: '–',
    command: 'questa_run.sh -s 1000 -t regress_full --std g2001',
    started: '2026-07-20T09:58:00.000Z',
    state: 'passed',
    exitCode: '0',
    errorCount: 0,
    warningCount: 1
  },
  {
    jobId: 'job-2',
    jobName: 'smoke_test',
    folder: undefined,
    logPath: '/workspace/.eda-runner/logs/job-2/2026-07-20_09-30-00-000.log',
    filename: '2026-07-20_09-30-00-000.log',
    laneLabel: undefined,
    seed: undefined,
    command: 'questa_run.sh -t smoke_test',
    started: '2026-07-20T09:30:00.000Z',
    state: 'killed',
    exitCode: undefined,
    errorCount: 0,
    warningCount: 0
  }
];

async function shoot(page, name) {
  const file = path.join(shotDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('  wrote', path.relative(repoRoot, file));
}

async function run() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  try {
    for (const theme of ['dark', 'light']) {
      const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 900, height: 1000 } });
      // A real VS Code webview always has `acquireVsCodeApi` available before
      // the page's own script runs -- addInitScript runs before any page
      // script and isn't subject to the page's CSP nonce (it's injected by
      // the browser itself), matching how VS Code's own webview host works.
      await context.addInitScript(() => {
        window.__vscodeMessages = [];
        window.acquireVsCodeApi = () => ({
          postMessage: msg => window.__vscodeMessages.push(msg),
          getState: () => undefined,
          setState: () => undefined
        });
      });

      for (const htmlFile of fs.readdirSync(htmlDir).filter(f => f.endsWith('.html'))) {
        const name = path.basename(htmlFile, '.html');
        const page = await context.newPage();
        await page.goto(`file://${path.join(htmlDir, htmlFile)}`);
        await page.addStyleTag({ content: themeStyleTag(theme) });
        console.log(`${name} (${theme}):`);
        await shoot(page, `${name}-${theme}`);

        if (name === 'jobConfig') {
          // Non-favorite flags (where the --std choices/var toggle lives in
          // the sample data) render inside a collapsed "All options" details
          // -- expand it so later locators can actually see/click into it.
          const allOpts = page.locator('.allOptsDetails').first();
          if (await allOpts.count()) {
            await allOpts.evaluate(el => { el.open = true; });
          }
          // Toggle the "--std" flag's choices dropdown to free-text and back,
          // exercising the reversible var/choices toggle end to end.
          const toggleBtn = page.locator('.varToggle').first();
          if (await toggleBtn.count()) {
            await toggleBtn.click();
            await shoot(page, `${name}-${theme}-var-toggled`);
            await page.locator('.varToggle').first().click();
            await shoot(page, `${name}-${theme}-var-toggled-back`);
          }
          // Load a template and confirm it doesn't leave the page in a broken state.
          const templateSelect = page.locator('#templateSelect');
          if (await templateSelect.count()) {
            await templateSelect.selectOption({ label: 'Smoke Test' });
            await page.locator('#loadTemplate').click();
            await shoot(page, `${name}-${theme}-template-loaded`);
          }
          // Hover a help icon to force its normally hover-only tooltip visible.
          const help = page.locator('.help').first();
          if (await help.count()) {
            await help.hover();
            await shoot(page, `${name}-${theme}-help-hover`);
          }
        }

        if (name === 'toolSetup') {
          const help = page.locator('.help').first();
          if (await help.count()) {
            await help.hover();
            await shoot(page, `${name}-${theme}-help-hover`);
          }
          // Exercises the client-side favorite-toggle patch (icon flip +
          // favorites-first re-sort, done without any host round-trip/full
          // re-render -- see toggleFavorite's wire() handler): "--gui" starts
          // unfavorited and should jump up next to the already-favorited
          // "--seed" row, then return to its original spot when toggled back.
          const favBtn = page.locator('tr', { hasText: '--gui' }).locator('.favBtn').first();
          if (await favBtn.count()) {
            await favBtn.click();
            await shoot(page, `${name}-${theme}-fav-toggled`);
            await favBtn.click();
            await shoot(page, `${name}-${theme}-fav-toggled-back`);
          }
        }

        if (name === 'toolSetup-editing') {
          // The Seed pattern field + tester live inside a collapsed
          // "Advanced (name, scan directory)" details -- expand it first.
          // Scoped to `.tool` (the tool's own edit-form container): the
          // always-present "Add a tool" form below it has its own, separate
          // `.advancedFields`, which an unscoped `.first()` would grab instead.
          const advanced = page.locator('.tool .advancedFields').first();
          if (await advanced.count()) {
            await advanced.evaluate(el => { el.open = true; });
          }
          const sampleEl = page.locator('.seedTesterSample').first();
          if (await sampleEl.count()) {
            await sampleEl.fill('vsim -sv_seed 123456789 tb_top');
            await shoot(page, `${name}-${theme}-seed-tester`);
          }
        }

        if (name === 'shellEnv') {
          await page.locator('#limitByCount').check();
          await page.locator('#limitBySize').check();
          await shoot(page, `${name}-${theme}-retention-checked`);
        }

        if (name === 'logViewer') {
          await page.evaluate(rows => {
            window.postMessage({ type: 'rows', rows }, '*');
          }, SAMPLE_LOG_VIEWER_ROWS);
          await page.waitForTimeout(150);
          await shoot(page, `${name}-${theme}-with-rows`);
        }

        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log('\nDone. Screenshots in', shotDir);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
