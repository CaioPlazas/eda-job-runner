// Renders each webview panel's REAL `renderHtml` output to a static HTML
// file, for the visual-test harness (see screenshot-webviews.mjs, which
// loads these in headless Chromium and screenshots them).
//
// Each panel module is esbuild-bundled with the `vscode` import aliased to
// a no-op shim (vscode-webview-shim.mjs) so it can run outside the
// extension host -- every renderHtml only ever reads `webview.cspSource`
// (verified across all five panels), which the fake webview below supplies
// directly; nothing else in the vscode import is ever touched by the code
// path this harness exercises.
//
// Usage: node scripts/render-webviews.mjs
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const shimPath = path.join(__dirname, 'vscode-webview-shim.mjs');
const outDir = path.join(repoRoot, '.webview-preview', 'html');
fs.mkdirSync(outDir, { recursive: true });

function bundle(srcRelPath, outName) {
  const outFile = `/tmp/webview-render-${outName}.mjs`;
  execSync(
    `npx esbuild ${srcRelPath} --bundle --format=esm --platform=node --alias:vscode=${shimPath} --outfile=${outFile}`,
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return outFile;
}

// A fake webview: renderHtml only ever reads .cspSource (for the CSP meta tag).
const fakeWebview = { cspSource: 'vscode-resource:' };

// ---- Representative sample data, exercising the recently-changed surfaces ----

const tool = {
  id: 'tool-questa',
  command: 'questa_run.sh',
  displayName: 'Questa Runner',
  helpArg: '--help',
  lastScanned: Date.now() - 3600_000,
  seedPattern: 'MY_SEED=(\\d+)',
  lists: [{ name: 'Tests', command: 'ls tests/*.sv', values: ['smoke_test', 'regress_full', 'corner_case_1'], insertTemplate: '${value}' }],
  variants: [
    {
      label: '',
      selectArgs: [],
      options: [
        { flags: ['-s', '--seed'], metavar: 'SEED', description: 'Random seed for simulation', favorite: true },
        { flags: ['-t', '--test'], metavar: 'TEST', description: 'Test name to run', valueListName: 'Tests' },
        { flags: ['--gui'], description: 'Launch waveform viewer' },
        { flags: ['--std'], metavar: '{g2001,g2005,g2012}', description: 'SystemVerilog standard' }
      ]
    },
    {
      label: 'regression',
      selectArgs: ['regression'],
      options: [
        { flags: ['--parallel'], metavar: 'N', description: 'Number of parallel jobs', favorite: true },
        { flags: ['--seeds'], metavar: 'COUNT', description: 'Number of seeds to run' }
      ]
    }
  ]
};

const job = {
  id: 'job-1',
  name: 'regress_seeds',
  command: 'questa_run.sh -s ${randomSeed} -t regress_full --std g2001',
  cwd: 'sim',
  parseProblems: true,
  failPattern: 'TEST RESULT:\\s*FAIL',
  passPattern: 'TEST RESULT:\\s*PASS',
  logsDirectory: '${workspaceFolder}/scratch-logs',
  runCount: 10,
  toolId: tool.id,
  toolVariantLabel: '',
  folder: 'Regression',
  customArgs: [{ arg: '--extra-flag', value: 'value1' }],
  paramOverrides: { SEED_BASE: '1000' },
  postRunEnabled: true,
  postRunCommand: 'notify-send "Regression done"'
};

const templates = [
  { name: 'Questa Compile', namePattern: 'Questa Compile', command: 'questa_run.sh compile', cwd: '.', toolId: tool.id },
  { name: 'Smoke Test', namePattern: 'smoke_test', command: 'questa_run.sh -t smoke_test', cwd: 'sim' }
];

const globalParams = [
  { name: 'SEED_BASE', value: '42' },
  { name: 'TB_ROOT', value: '${workspaceFolder}/tb' }
];

const folders = ['Regression', 'Compile'];

// ---- Render each panel ----

{
  const { renderHtml } = await import(bundle('./src/jobConfigPanel.ts', 'jobConfig'));
  const html = renderHtml(fakeWebview, job, [tool], folders, undefined, false, globalParams, templates);
  fs.writeFileSync(path.join(outDir, 'jobConfig.html'), html);
}

{
  const { renderHtml } = await import(bundle('./src/toolSetupPanel.ts', 'toolSetup'));
  const html = renderHtml(fakeWebview, [tool], undefined, undefined, undefined);
  fs.writeFileSync(path.join(outDir, 'toolSetup.html'), html);
  // A separate render with the tool's in-place edit form open -- the Seed
  // pattern field + its paste-and-preview tester only exist in this state
  // (editingToolId set), not the default list view above.
  const editingHtml = renderHtml(fakeWebview, [tool], undefined, tool.id, undefined);
  fs.writeFileSync(path.join(outDir, 'toolSetup-editing.html'), editingHtml);
}

{
  const { renderHtml } = await import(bundle('./src/shellEnvPanel.ts', 'shellEnv'));
  const state = {
    shellPath: 'bash',
    shellArgsAuto: true,
    shellArgs: '-lc\n${command}',
    env: 'LM_LICENSE_FILE=27000@licsrv',
    setupScript: 'scripts/env_setup.sh',
    setupCommands: 'module load questa/2024.1',
    postSetupCwd: '',
    logsDirectory: '',
    logRetentionCount: 20,
    logRetentionMaxSizeMB: 0
  };
  const html = renderHtml(fakeWebview, state);
  fs.writeFileSync(path.join(outDir, 'shellEnv.html'), html);
}

{
  const { renderHtml } = await import(bundle('./src/paramsPanel.ts', 'params'));
  const html = renderHtml(fakeWebview, globalParams);
  fs.writeFileSync(path.join(outDir, 'params.html'), html);
}

{
  const { renderHtml } = await import(bundle('./src/logViewerPanel.ts', 'logViewer'));
  const html = renderHtml(fakeWebview);
  fs.writeFileSync(path.join(outDir, 'logViewer.html'), html);
}

console.log('Rendered 5 panels to', outDir);
