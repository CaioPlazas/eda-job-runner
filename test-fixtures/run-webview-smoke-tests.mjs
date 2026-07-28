// Browser-free crash gate for the 5 webview panels' `renderHtml` output,
// runnable in CI (no Chromium needed -- see scripts/render-webviews.mjs +
// scripts/screenshot-webviews.mjs for the fuller, screenshot-producing,
// locally-cached-Chromium-requiring sibling of this gate). Each panel is
// esbuild-bundled with the same `--alias:vscode=scripts/vscode-webview-shim.mjs`
// trick and `npx esbuild -> /tmp -> import` idiom every other
// test-fixtures/run-*-tests.mjs already uses, then its real `renderHtml`
// output is loaded into a jsdom `Window` with `runScripts: 'dangerously'`
// so its inline <script> actually executes -- exactly the same principle
// as the Chromium harness, just without a browser.
//
// Coverage rule (mirrors scripts/render-webviews.mjs's own header comment):
// every branch of a `renderHtml` conditional that changes which top-level
// element ids exist needs its own state rendered here, or that branch's
// script has never actually been executed by any gate.
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

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

function bundle(srcRelPath, outName) {
  const outFile = `/tmp/webview-smoke-${outName}.mjs`;
  execSync(
    `npx esbuild ${srcRelPath} --bundle --format=esm --platform=node --alias:vscode=${shimPath} --outfile=${outFile}`,
    { cwd: repoRoot, stdio: 'inherit' }
  );
  return outFile;
}

const fakeWebview = { cspSource: 'vscode-resource:' };

// ---- Minimal sample data, self-contained (not shared with render-webviews.mjs) ----

const lists = [
  { name: 'Tests', command: 'ls tests/*.sv', values: ['smoke_test', 'regress_full'], insertTemplate: '${value}' },
  { name: 'a</script>b', values: ['x', 'y'] }
];

const tool = {
  id: 'tool-1',
  command: 'questa_run.sh',
  variants: [
    {
      label: '',
      selectArgs: [],
      options: [
        { flags: ['-s', '--seed'], metavar: 'SEED', description: 'Random seed', favorite: true },
        { flags: ['-t', '--test'], metavar: 'TEST', description: 'Test name', valueListName: 'Tests' },
        { flags: ['--gui'], description: 'Launch GUI' },
        { flags: ['--std'], metavar: '{g2001,g2005,g2012}', description: 'SV standard' }
      ]
    }
  ]
};

const job = {
  id: 'job-1',
  name: 'regress_seeds',
  command: 'questa_run.sh -s ${randomSeed} -t regress_full --std g2001',
  cwd: '.',
  toolId: tool.id,
  toolVariantLabel: '',
  customArgs: [{ arg: '--extra', value: 'v' }],
  paramOverrides: { X: '1' }
};

const toolWithScanError = {
  id: 'tool-2',
  command: 'xrun',
  helpArg: '--help',
  variants: [
    {
      label: '',
      selectArgs: [],
      options: [],
      rawHelp: '',
      scanError: 'exited 127 with no recognizable options'
    }
  ]
};

const templates = [{ name: 'Smoke', command: 'questa_run.sh -t smoke_test', cwd: '.' }];
const globalParams = [{ name: 'X', value: '1' }];
const folders = ['Regression'];

const shellState = {
  shellPath: 'bash',
  shellArgsAuto: true,
  shellArgs: '-lc\n${command}',
  env: 'LM_LICENSE_FILE=27000@licsrv',
  setupScript: '',
  setupCommands: '',
  postSetupCwd: '',
  logsDirectory: '',
  logRetentionCount: 20,
  logRetentionMaxSizeMB: 0,
  maxConcurrentJobs: 0,
  setupChecks: '',
  registeredTools: [{ name: 'xrun', command: 'xrun' }],
  detectedShellMatches: true,
  detectedShellPath: 'bash',
  detectedShellSource: 'vscode.env.shell',
  status: { env: 'todo', tool: 'ok', job: 'ok', params: 'todo' },
  doneLine: undefined
};
const shellStateTested = {
  ...shellState,
  status: { env: 'ok', tool: 'ok', job: 'ok', params: 'ok' },
  doneLine: '✓ Shell setup tested.'
};

// ---- jsdom execution harness ----

/**
 * Loads `html` into a jsdom Window with its inline <script> actually
 * executed, `acquireVsCodeApi` stubbed BEFORE parsing starts (via
 * `beforeParse` -- the only hook that runs early enough; setting it after
 * `new JSDOM(...)` returns would be too late, since `runScripts:
 * 'dangerously'` runs a classic inline <script> synchronously during
 * parsing itself), and returns any uncaught script errors. The CSP <meta>
 * tag is stripped first -- rely on jsdom's actual script execution as the
 * signal, not its (different, and not what we're testing) CSP enforcement.
 */
function renderErrors(html) {
  const stripped = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', err => {
    // jsdom reports its own "not implemented" browser-API stubs (e.g.
    // window.scrollTo) as jsdomError too -- that's not a real script bug.
    if (!/not implemented/i.test(err.message)) {
      errors.push(err.message);
    }
  });
  new JSDOM(stripped, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: () => {},
        getState: () => undefined,
        setState: () => undefined
      });
      window.addEventListener('error', e => {
        errors.push(e.message || String(e.error || 'unknown error'));
      });
    }
  });
  return errors;
}

function checkState(name, html) {
  const errors = renderErrors(html);
  check(errors.length === 0, `${name}: no script errors (${errors.join('; ')})`);
}

// ---- Render + check every state ----

{
  const { renderHtml } = await import(bundle('./src/jobConfigPanel.ts', 'jobConfig'));
  const configureHtml = renderHtml(fakeWebview, job, [tool], folders, undefined, false, globalParams, templates, lists);
  const addHtml = renderHtml(fakeWebview, undefined, [tool], folders, undefined, false, globalParams, templates, lists);
  checkState('jobConfig', configureHtml);
  checkState('jobConfig-new', addHtml);
  checkState('jobConfig-nolists', renderHtml(fakeWebview, job, [tool], folders, undefined, false, globalParams, templates, []));
  const addNoTemplatesHtml = renderHtml(fakeWebview, undefined, [tool], folders, undefined, false, globalParams, [], lists);
  checkState('jobConfig-new-notemplates', addNoTemplatesHtml);
  // T2.2: the template row is absent (hidden) when there are zero templates, present when there are.
  check(addNoTemplatesHtml.includes('class="templateRow hidden"'), 'template row is hidden with zero templates');
  check(!addHtml.includes('class="templateRow hidden"'), 'template row is shown when templates exist');
  // D10: the stepper renders only when adding a job, never when configuring an existing one.
  check(addHtml.includes('class="stepper"'), 'jobConfig-new (Add) shows the stepper');
  check(!configureHtml.includes('class="stepper"'), 'jobConfig (Configure existing) has no stepper');
  check(addHtml.includes('id="willRun"') && configureHtml.includes('id="willRun"'), 'Will-run preview is present in both Add and Configure (verification, not onboarding)');
}

{
  const { renderHtml } = await import(bundle('./src/toolSetupPanel.ts', 'toolSetup'));
  checkState('toolSetup', renderHtml(fakeWebview, [tool], lists, undefined, undefined, undefined));
  checkState('toolSetup-editing', renderHtml(fakeWebview, [tool], lists, undefined, tool.id, undefined));
  const pendingAdd = {
    command: 'questa_run.sh',
    helpArg: '--help',
    displayName: 'Questa Runner',
    scanDir: '',
    topLevel: { options: tool.variants[0].options, rawHelp: '(sample --help output)' },
    suggestedChoices: []
  };
  checkState('toolSetup-pending', renderHtml(fakeWebview, [tool], lists, pendingAdd, undefined, undefined));
  checkState('toolSetup-addvariant', renderHtml(fakeWebview, [tool], lists, undefined, undefined, tool.id));
  checkState('toolSetup-scanerror', renderHtml(fakeWebview, [toolWithScanError], lists, undefined, undefined, undefined));
  checkState('toolSetup-empty', renderHtml(fakeWebview, [], [], undefined, undefined, undefined));
}

{
  const { renderHtml } = await import(bundle('./src/shellEnvPanel.ts', 'shellEnv'));
  checkState('shellEnv', renderHtml(fakeWebview, shellState));
  checkState('shellEnv-tested', renderHtml(fakeWebview, shellStateTested));
}

{
  const { renderHtml } = await import(bundle('./src/paramsPanel.ts', 'params'));
  checkState('params', renderHtml(fakeWebview, globalParams, lists));
  checkState('params-empty', renderHtml(fakeWebview, [], []));
}

{
  const { renderHtml } = await import(bundle('./src/logViewerPanel.ts', 'logViewer'));
  checkState('logViewer', renderHtml(fakeWebview));
}

console.log(failures === 0 ? '\nAll webview smoke tests passed.' : `\n${failures} webview smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
