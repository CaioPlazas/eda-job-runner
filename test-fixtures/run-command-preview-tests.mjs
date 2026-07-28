import { execSync } from 'child_process';
import * as path from 'path';

// Bundle the pure preview resolver (and the modules it composes, transitively
// via esbuild's bundling) to a temp ESM file and import it.
execSync('npx esbuild ./src/commandPreview.ts --bundle --format=esm --platform=node --outfile=/tmp/commandPreview.mjs', {
  stdio: 'inherit'
});
execSync('npx esbuild ./src/setupChain.ts --bundle --format=esm --platform=node --outfile=/tmp/setupChain2.mjs', {
  stdio: 'inherit'
});
execSync('npx esbuild ./src/shellInvocation.ts --bundle --format=esm --outfile=/tmp/shellInvocation2.mjs', {
  stdio: 'inherit'
});
const { buildPreview } = await import('/tmp/commandPreview.mjs');
const { buildSetupChain } = await import('/tmp/setupChain2.mjs');
const { buildShellInvocation } = await import('/tmp/shellInvocation2.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ROOT = '/home/eng/rtl-project';

// --- ${var:NAME} substituted from globals, then overridden by paramOverrides ---
{
  const preview = buildPreview({
    command: 'make sim TEST=${var:TOP}',
    workspaceRoot: ROOT,
    shellPath: 'bash',
    shellArgs: null,
    globalParams: { TOP: 'default_top' },
    overrides: { TOP: 'override_top' }
  });
  check(preview.fullCommand.includes('TEST=override_top'), `override wins over global default (got ${preview.fullCommand})`);
}
{
  const preview = buildPreview({
    command: 'make sim TEST=${var:TOP}',
    workspaceRoot: ROOT,
    shellPath: 'bash',
    shellArgs: null,
    globalParams: { TOP: 'default_top' },
    overrides: {}
  });
  check(preview.fullCommand.includes('TEST=default_top'), `global default used when no override (got ${preview.fullCommand})`);
}

// --- ${param:NAME} left as <prompts at run time>, reported in prompts[] ---
{
  const preview = buildPreview({
    command: 'make sim SEED=${param:SEED}',
    workspaceRoot: ROOT,
    shellPath: 'bash',
    shellArgs: null,
    globalParams: {},
    overrides: {}
  });
  check(preview.fullCommand.includes('SEED=<prompts at run time>'), `param placeholder rendered literally (got ${preview.fullCommand})`);
  check(eq(preview.prompts, ['SEED']), `prompts[] reports the param name (got ${JSON.stringify(preview.prompts)})`);
}

// --- undefined vars reported with defined: false ---
{
  const preview = buildPreview({
    command: 'make sim TEST=${var:TOP} SEED=${var:MISSING}',
    workspaceRoot: ROOT,
    shellPath: 'bash',
    shellArgs: null,
    globalParams: { TOP: 'top1' },
    overrides: {}
  });
  const byName = Object.fromEntries(preview.vars.map(v => [v.name, v.defined]));
  check(byName.TOP === true, `defined var reported true (got ${JSON.stringify(preview.vars)})`);
  check(byName.MISSING === false, `undefined var reported false (got ${JSON.stringify(preview.vars)})`);
}

// --- cwd precedence: job cwd -> postSetupCwd -> workspace root ---
{
  const preview = buildPreview({
    command: 'run',
    cwd: 'sim',
    postSetupCwd: 'work',
    workspaceRoot: ROOT,
    shellPath: 'bash',
    shellArgs: null,
    globalParams: {},
    overrides: {}
  });
  check(preview.resolvedCwd === path.resolve(ROOT, 'work', 'sim'), `cwd resolves against postSetupCwd (got ${preview.resolvedCwd})`);
}
{
  const preview = buildPreview({
    command: 'run',
    cwd: 'sim',
    workspaceRoot: ROOT,
    shellPath: 'bash',
    shellArgs: null,
    globalParams: {},
    overrides: {}
  });
  check(preview.resolvedCwd === path.resolve(ROOT, 'sim'), `cwd resolves against workspace root when no postSetupCwd (got ${preview.resolvedCwd})`);
}
{
  const preview = buildPreview({
    command: 'run',
    workspaceRoot: ROOT,
    shellPath: 'bash',
    shellArgs: null,
    globalParams: {},
    overrides: {}
  });
  check(preview.resolvedCwd === ROOT, `no job cwd -> workspace root (got ${preview.resolvedCwd})`);
}

// --- the preview equals what the runner would build (asserted directly against buildSetupChain + buildShellInvocation) ---
{
  const setup = { script: 'env.sh', commands: ['module load xrun'] };
  const command = 'xrun -sv top.sv TEST=${var:TOP}';
  const globalParams = { TOP: 'alu_smoke' };
  const overrides = {};

  const preview = buildPreview({
    command,
    setup,
    workspaceRoot: ROOT,
    shellPath: 'tcsh',
    shellArgs: null,
    globalParams,
    overrides
  });

  // Reproduce what jobRunner would actually build for the same input.
  const resolvedCommand = command.replace('${var:TOP}', globalParams.TOP);
  const expectedFullCommand = buildSetupChain(setup, resolvedCommand, ROOT);
  check(preview.fullCommand === expectedFullCommand, `preview.fullCommand matches buildSetupChain directly (preview=${preview.fullCommand}, expected=${expectedFullCommand})`);

  const { file, args } = buildShellInvocation('tcsh', null, expectedFullCommand);
  check(preview.invocation === `${file} ${args.slice(0, -1).join(' ')}`.trim(), `preview.invocation matches buildShellInvocation's file+args (got ${preview.invocation})`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log('\nAll commandPreview tests passed.');
}
