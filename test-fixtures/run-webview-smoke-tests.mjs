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

/**
 * Same as renderErrors, but hands back the live window so a test can drive the
 * panel's own client script (dispatch a host message, click a button) and
 * assert on the resulting DOM -- not just that nothing threw on first render.
 */
function renderWindow(html) {
  const stripped = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', err => {
    if (!/not implemented/i.test(err.message)) {
      errors.push(err.message);
    }
  });
  const dom = new JSDOM(stripped, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.__posted = [];
      window.acquireVsCodeApi = () => ({
        postMessage: m => window.__posted.push(m),
        getState: () => undefined,
        setState: () => undefined
      });
      window.addEventListener('error', e => {
        errors.push(e.message || String(e.error || 'unknown error'));
      });
    }
  });
  return { window: dom.window, errors };
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
  // The template row always renders, regardless of whether any templates exist yet.
  check(addNoTemplatesHtml.includes('class="templateRow"'), 'template row renders with zero templates');
  check(addHtml.includes('class="templateRow"'), 'template row renders when templates exist');
  // The stepper was removed; neither Add nor Configure should render one.
  check(!addHtml.includes('class="stepper"'), 'jobConfig-new (Add) has no stepper');
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

  // ---- The Parameters panel patches its value lists in place ----
  // A list action (Add / Refresh / Remove / Refresh all) used to re-render the
  // entire document, which wiped every typed parameter row and every
  // half-finished new list along with it. The host now posts a `lists` patch
  // instead. These assertions are the actual guarantee: everything the user
  // typed is still there afterwards.
  {
    const { window, errors } = renderWindow(renderHtml(fakeWebview, globalParams, lists));
    check(errors.length === 0, `params-patch: panel loaded without errors (${errors.join('; ')})`);
    const doc = window.document;

    // The user types a parameter value (not saved yet) and starts a new list.
    doc.querySelector('.paramRow .pValue').value = 'typed-but-not-saved';
    doc.getElementById('addList').click();
    const draft = Array.from(doc.querySelectorAll('.listItem')).find(r => !r.hasAttribute('data-list-name'));
    check(!!draft, 'params-patch: "+ Add value list" adds a row with no data-list-name');
    draft.querySelector('.lName').value = 'InProgress';
    draft.querySelector('.lSource').value = 'ls in-progress/*';

    // Meanwhile the host refreshes a different list and drops another.
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'lists',
          lists: [{ name: 'Tests', command: 'ls tests/*.sv', values: ['smoke_test', 'regress_full', 'new_test'] }]
        }
      })
    );

    check(
      doc.querySelector('.paramRow .pValue').value === 'typed-but-not-saved',
      'params-patch: a typed parameter row survives a list patch'
    );
    const draftAfter = Array.from(doc.querySelectorAll('.listItem')).find(r => !r.hasAttribute('data-list-name'));
    check(
      draftAfter && draftAfter.querySelector('.lName').value === 'InProgress',
      'params-patch: a half-filled new list row survives a list patch'
    );
    check(
      doc.querySelector('[data-list-name="Tests"]').textContent.includes('new_test'),
      "params-patch: a refreshed list's row shows its new values"
    );
    check(
      !doc.querySelector('[data-list-name="a</script>b"]'),
      'params-patch: a list that is gone from the payload has its row removed'
    );

    // Now the in-progress list is actually added: its draft row becomes the
    // saved row rather than leaving a duplicate behind.
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'lists',
          lists: [
            { name: 'Tests', command: 'ls tests/*.sv', values: ['smoke_test'] },
            { name: 'InProgress', command: 'ls in-progress/*', values: ['one'] }
          ]
        }
      })
    );
    check(
      doc.querySelectorAll('.listItem').length === 2,
      `params-patch: the draft row is replaced by its saved row, not duplicated (got ${doc.querySelectorAll('.listItem').length} rows)`
    );
    check(
      !!doc.querySelector('[data-list-name="InProgress"]'),
      'params-patch: the newly added list is present as a saved row'
    );
    check(
      doc.querySelector('.paramRow .pValue').value === 'typed-but-not-saved',
      'params-patch: the typed parameter row is still there after the second patch'
    );
  }
}

{
  const { renderHtml } = await import(bundle('./src/logViewerPanel.ts', 'logViewer'));
  checkState('logViewer', renderHtml(fakeWebview));
}

console.log(failures === 0 ? '\nAll webview smoke tests passed.' : `\n${failures} webview smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
