import { execSync } from 'child_process';
import * as path from 'path';

// Bundle the pure setup-chain helper to a temp ESM file and import it, the
// same approach run-var-tests.mjs uses for paramVars.ts.
execSync('npx esbuild ./src/setupChain.ts --bundle --format=esm --platform=node --outfile=/tmp/setupChain.mjs', {
  stdio: 'inherit'
});
const { buildSetupChain } = await import('/tmp/setupChain.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

const ROOT = '/home/u/proj';

// --- Finding #15 regression: whitespace-only script is dropped ---
{
  const out = buildSetupChain({ script: '   ', commands: [] }, 'echo hi', ROOT);
  check(out === 'echo hi', `whitespace-only script dropped (got ${JSON.stringify(out)})`);
}

// --- Finding #15 regression: blank entries in commands are dropped ---
{
  const out = buildSetupChain({ commands: ['module load foo', '', '   ', 'echo ready'] }, 'run_it', ROOT);
  check(out === 'module load foo && echo ready && run_it', `blank command entries dropped (got ${JSON.stringify(out)})`);
}

// --- ordering: script -> commands -> tail ---
{
  const out = buildSetupChain({ script: 'env.sh', commands: ['module load xrun'] }, 'xrun --help', ROOT);
  check(
    out === `source "${path.join(ROOT, 'env.sh')}" && module load xrun && xrun --help`,
    `script -> commands -> tail ordering (got ${JSON.stringify(out)})`
  );
}

// --- relative script resolves against workspace root; absolute is left alone ---
{
  const rel = buildSetupChain({ script: 'env.sh' }, 'tail', ROOT);
  check(rel.includes(`source "${path.join(ROOT, 'env.sh')}"`), `relative script resolved against root (got ${JSON.stringify(rel)})`);

  const abs = buildSetupChain({ script: '/opt/tools/env.sh' }, 'tail', ROOT);
  check(abs.includes('source "/opt/tools/env.sh"'), `absolute script left alone (got ${JSON.stringify(abs)})`);
}

// --- no setup at all: just the tail ---
{
  const out = buildSetupChain(undefined, 'echo only', ROOT);
  check(out === 'echo only', `no setup -> tail only (got ${JSON.stringify(out)})`);
}

// --- golden test: matches jobRunner's old buildShellCommand for a realistic, already-clean setup ---
{
  // Reproduces the pre-refactor jobRunner.ts buildShellCommand logic exactly,
  // for a setup that was already well-formed (no blank entries) -- the
  // refactor must not change any currently-working run.
  function oldBuildShellCommand(setup, resolvedCommand, workspaceRoot) {
    const steps = [];
    if (setup?.script && setup.script.trim().length > 0) {
      const scriptPath = path.isAbsolute(setup.script) ? setup.script : path.join(workspaceRoot, setup.script);
      steps.push(`source "${scriptPath}"`);
    }
    for (const cmd of setup?.commands ?? []) {
      if (cmd.trim().length > 0) {
        steps.push(cmd);
      }
    }
    steps.push(resolvedCommand);
    return steps.join(' && ');
  }

  const setup = { script: 'setup/env.sh', commands: ['module load xcelium/24.03', 'export LM_LICENSE_FILE=27000@licsrv'] };
  const resolvedCommand = 'xrun -sv top.sv';
  const workspaceRoot = '/home/eng/rtl-project';

  const before = oldBuildShellCommand(setup, resolvedCommand, workspaceRoot);
  const after = buildSetupChain(setup, resolvedCommand, workspaceRoot);
  check(before === after, `golden test: matches pre-refactor buildShellCommand output exactly (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log('\nAll setupChain tests passed.');
}
