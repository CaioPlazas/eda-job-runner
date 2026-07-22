import { execSync } from 'child_process';

// Bundle the pure global-parameter substitution helpers to a temp ESM file
// and import them, the same approach run-param-tests.mjs uses for
// paramSubstitution.ts.
execSync('npx esbuild ./src/paramVars.ts --bundle --format=esm --outfile=/tmp/paramVars.mjs', {
  stdio: 'inherit'
});
const { parseVars, effectiveVarValue, substituteParamVars, flattenGlobalParams } = await import('/tmp/paramVars.mjs');

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

// --- parseVars: plain placeholder ---
{
  const names = parseVars('sim_run.py --tb ${var:TESTBENCH_DIR}');
  check(eq(names, ['TESTBENCH_DIR']), `plain placeholder (got ${JSON.stringify(names)})`);
}

// --- parseVars: multiple distinct names, deduped, first-appearance order ---
{
  const names = parseVars('run.sh ${var:B} ${var:A} ${var:B}');
  check(eq(names, ['B', 'A']), `multiple names, deduped, first-appearance order (got ${JSON.stringify(names)})`);
}

// --- parseVars: no placeholders -> empty ---
{
  check(eq(parseVars('make sim TEST=smoke_test'), []), 'no placeholders -> empty array');
}

// --- parseVars: does NOT match ${param:...} (the co-existence guarantee) ---
{
  const names = parseVars('run.sh ${param:SEED=42} ${var:TESTBENCH_DIR}');
  check(eq(names, ['TESTBENCH_DIR']), `parseVars ignores \${param:...} tokens (got ${JSON.stringify(names)})`);
}

// --- effectiveVarValue: job override wins over global default ---
{
  const v = effectiveVarValue('X', { X: 'global' }, { X: 'override' });
  check(v === 'override', `override wins over global (got ${JSON.stringify(v)})`);
}

// --- effectiveVarValue: falls back to global default when no override ---
{
  const v = effectiveVarValue('X', { X: 'global' }, {});
  check(v === 'global', `falls back to global default (got ${JSON.stringify(v)})`);
}

// --- effectiveVarValue: an override of empty string still wins (not treated as "unset") ---
{
  const v = effectiveVarValue('X', { X: 'global' }, { X: '' });
  check(v === '', `empty-string override still wins over global (got ${JSON.stringify(v)})`);
}

// --- effectiveVarValue: undefined anywhere -> empty string, not a crash ---
{
  const v = effectiveVarValue('MISSING', {}, {});
  check(v === '', `undefined name -> empty string (got ${JSON.stringify(v)})`);
}

// --- substituteParamVars: fills in every occurrence of a name ---
{
  const out = substituteParamVars('run.sh ${var:B} mid ${var:A} ${var:B}', { A: '1', B: '2' }, {});
  check(out === 'run.sh 2 mid 1 2', `substituteParamVars fills every occurrence (got ${JSON.stringify(out)})`);
}

// --- substituteParamVars: override applies per-name, globals fill the rest ---
{
  const out = substituteParamVars('run.sh ${var:A} ${var:B}', { A: 'ga', B: 'gb' }, { A: 'oa' });
  check(out === 'run.sh oa gb', `per-name override with global fallback (got ${JSON.stringify(out)})`);
}

// --- substituteParamVars: does NOT touch ${param:...} placeholders ---
{
  const out = substituteParamVars('run.sh ${param:SEED=42} ${var:X}', { X: 'val' }, {});
  check(out === 'run.sh ${param:SEED=42} val', `\${param:...} left untouched (got ${JSON.stringify(out)})`);
}

// --- flattenGlobalParams: GlobalParam[] -> Record<string,string> ---
{
  const flat = flattenGlobalParams([
    { name: 'A', value: '1' },
    { name: 'B', value: '2' }
  ]);
  check(eq(flat, { A: '1', B: '2' }), `flattenGlobalParams (got ${JSON.stringify(flat)})`);
}

console.log(failures === 0 ? '\nAll global-parameter (var) tests passed.' : `\n${failures} global-parameter (var) test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
