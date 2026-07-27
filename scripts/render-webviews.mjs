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
// Coverage rule: every branch of a `renderHtml` conditional that changes
// WHICH TOP-LEVEL ELEMENT IDS EXIST must have its own rendered state here.
// The panels' inline scripts look ids up unconditionally in many places; a
// branch with no rendered state is a branch whose script has never actually
// been executed by this harness -- exactly how a past crash (an unguarded
// DOM lookup only reachable when Tool Setup's `pendingAdd` state was set)
// went undetected for a full release.
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

const lists = [
  { name: 'Tests', command: 'ls tests/*.sv', values: ['smoke_test', 'regress_full', 'corner_case_1'], insertTemplate: '${value}' },
  { name: 'a</script>b', values: ['x', 'y'] }
];

const tool = {
  id: 'tool-questa',
  command: 'questa_run.sh',
  displayName: 'Questa Runner',
  helpArg: '--help',
  lastScanned: Date.now() - 3600_000,
  seedPattern: 'MY_SEED=(\\d+)',
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
  const html = renderHtml(fakeWebview, job, [tool], folders, undefined, false, globalParams, templates, lists);
  fs.writeFileSync(path.join(outDir, 'jobConfig.html'), html);
  // "Add Job" state where job is undefined
  const newJobHtml = renderHtml(fakeWebview, undefined, [tool], folders, undefined, false, globalParams, templates, lists);
  fs.writeFileSync(path.join(outDir, 'jobConfig-new.html'), newJobHtml);
  // Same as normal but with empty lists array (exercises var-toggle-gate fix)
  const nolistsHtml = renderHtml(fakeWebview, job, [tool], folders, undefined, false, globalParams, templates, []);
  fs.writeFileSync(path.join(outDir, 'jobConfig-nolists.html'), nolistsHtml);
}

{
  const { renderHtml } = await import(bundle('./src/toolSetupPanel.ts', 'toolSetup'));
  const html = renderHtml(fakeWebview, [tool], lists, undefined, undefined, undefined);
  fs.writeFileSync(path.join(outDir, 'toolSetup.html'), html);
  // A separate render with the tool's in-place edit form open -- the Seed
  // pattern field + its paste-and-preview tester only exist in this state
  // (editingToolId set), not the default list view above.
  const editingHtml = renderHtml(fakeWebview, [tool], lists, undefined, tool.id, undefined);
  fs.writeFileSync(path.join(outDir, 'toolSetup-editing.html'), editingHtml);
  // Pending add state -- exercises the branch where #newCommand/#newScanDir
  // don't exist in the DOM (the exact branch that caused a past crash bug).
  const pendingAdd = {
    command: 'questa_run.sh',
    helpArg: '--help',
    displayName: 'Questa Runner',
    scanDir: '',
    topLevel: {
      options: tool.variants[0].options,
      rawHelp: '(sample --help output)'
    },
    suggestedChoices: []
  };
  const pendingHtml = renderHtml(fakeWebview, [tool], lists, pendingAdd, undefined, undefined);
  fs.writeFileSync(path.join(outDir, 'toolSetup-pending.html'), pendingHtml);
  // Add-variant state for an existing tool
  const addVariantHtml = renderHtml(fakeWebview, [tool], lists, undefined, undefined, tool.id);
  fs.writeFileSync(path.join(outDir, 'toolSetup-addvariant.html'), addVariantHtml);
  // Empty state: zero tools, zero lists
  const emptyHtml = renderHtml(fakeWebview, [], [], undefined, undefined, undefined);
  fs.writeFileSync(path.join(outDir, 'toolSetup-empty.html'), emptyHtml);
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
  const html = renderHtml(fakeWebview, globalParams, lists);
  fs.writeFileSync(path.join(outDir, 'params.html'), html);
  // Empty state: zero params, zero lists
  const emptyParamsHtml = renderHtml(fakeWebview, [], []);
  fs.writeFileSync(path.join(outDir, 'params-empty.html'), emptyParamsHtml);
}

{
  const { renderHtml } = await import(bundle('./src/logViewerPanel.ts', 'logViewer'));
  const html = renderHtml(fakeWebview);
  fs.writeFileSync(path.join(outDir, 'logViewer.html'), html);
}

console.log('Rendered 12 states to', outDir);
