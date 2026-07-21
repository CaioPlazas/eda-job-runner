import { execSync } from 'child_process';

// Bundle the pure param-substitution helpers to a temp ESM file and import
// them, the same approach run-shell-tests.mjs uses for shellInvocation.ts.
execSync('npx esbuild ./src/paramSubstitution.ts --bundle --format=esm --outfile=/tmp/paramSubstitution.mjs', {
  stdio: 'inherit'
});
const { parseParams, substituteParams, substituteRandomSeed } = await import('/tmp/paramSubstitution.mjs');

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

// --- parseParams: plain placeholder, no default ---
{
  const params = parseParams('sim_run.py --test ${param:TESTNAME}');
  check(eq(params, [{ name: 'TESTNAME', default: '' }]), `plain placeholder (got ${JSON.stringify(params)})`);
}

// --- parseParams: placeholder with a default value ---
{
  const params = parseParams('sim_run.py --seed ${param:SEED=42}');
  check(eq(params, [{ name: 'SEED', default: '42' }]), `placeholder with default (got ${JSON.stringify(params)})`);
}

// --- parseParams: multiple distinct names, in first-appearance order ---
{
  const params = parseParams('run.sh ${param:B} ${param:A=1} ${param:B}');
  check(
    eq(params, [
      { name: 'B', default: '' },
      { name: 'A', default: '1' }
    ]),
    `multiple names, deduped, first-appearance order (got ${JSON.stringify(params)})`
  );
}

// --- parseParams: no placeholders -> empty ---
{
  check(eq(parseParams('make sim TEST=smoke_test'), []), 'no placeholders -> empty array');
}

// --- substituteParams: fills in every occurrence of a name ---
{
  const out = substituteParams('run.sh ${param:B} mid ${param:A} ${param:B}', { A: '1', B: '2' });
  check(out === 'run.sh 2 mid 1 2', `substituteParams fills every occurrence (got ${JSON.stringify(out)})`);
}

// --- substituteParams: missing value falls back to empty string, not a crash ---
{
  const out = substituteParams('run.sh ${param:MISSING}', {});
  check(out === 'run.sh ', `missing value -> empty string (got ${JSON.stringify(out)})`);
}

// --- substituteRandomSeed: no placeholder -> command unchanged ---
{
  const out = substituteRandomSeed('make sim TEST=smoke_test', () => 999);
  check(out === 'make sim TEST=smoke_test', 'no ${randomSeed} -> command unchanged');
}

// --- substituteRandomSeed: replaces with the injected generator's value ---
{
  const out = substituteRandomSeed('sim -seed ${randomSeed}', () => 12345);
  check(out === 'sim -seed 12345', `substituteRandomSeed uses generator (got ${JSON.stringify(out)})`);
}

// --- substituteRandomSeed: every occurrence in one call gets the SAME value ---
{
  let calls = 0;
  const out = substituteRandomSeed('sim -seed ${randomSeed} -sv_seed ${randomSeed}', () => {
    calls++;
    return 7;
  });
  check(out === 'sim -seed 7 -sv_seed 7', `multiple occurrences share one value (got ${JSON.stringify(out)})`);
  check(calls === 1, `generator called exactly once per substitution call (got ${calls})`);
}

// --- substituteRandomSeed: default generator produces a non-negative integer ---
{
  const out = substituteRandomSeed('sim -seed ${randomSeed}');
  const m = /^sim -seed (\d+)$/.exec(out);
  check(!!m && Number(m[1]) >= 0, `default generator produces a plain integer (got ${JSON.stringify(out)})`);
}

console.log(failures === 0 ? '\nAll param-substitution tests passed.' : `\n${failures} param-substitution test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
