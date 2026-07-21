import { execSync } from 'child_process';

// Bundle the pure value-list helpers to a temp ESM file and import them, the
// same approach run-param-tests.mjs uses for paramSubstitution.ts.
execSync('npx esbuild ./src/listSource.ts --bundle --format=esm --outfile=/tmp/listSource.mjs', {
  stdio: 'inherit'
});
const { parseListLines, applyInsertTemplate, MAX_LIST_VALUES } = await import('/tmp/listSource.mjs');

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

// --- plain list: trims, drops blank + comment lines, dedupes ---
{
  const text = 'smoke_test\n\n  reset_test  \n# a comment\nsmoke_test\nburst_test\n';
  const out = parseListLines(text);
  check(eq(out, ['smoke_test', 'reset_test', 'burst_test']), `plain list cleaned + deduped (got ${JSON.stringify(out)})`);
}

// --- pattern with a capture group extracts just the test name from a messy line ---
{
  const text = 'TEST: alu_smoke   (weight=1)\nTEST: alu_random (weight=5)\nnot a test line\n';
  const out = parseListLines(text, '^TEST:\\s+(\\S+)');
  check(eq(out, ['alu_smoke', 'alu_random']), `pattern capture group 1 extracted, non-matches dropped (got ${JSON.stringify(out)})`);
}

// --- pattern with no capture group uses the whole match ---
{
  const text = 'run_foo_test\nskip_this\nrun_bar_test\n';
  const out = parseListLines(text, 'run_\\w+');
  check(eq(out, ['run_foo_test', 'run_bar_test']), `pattern whole-match used when no group (got ${JSON.stringify(out)})`);
}

// --- invalid regex falls back to raw (comment/blank-filtered) lines, no throw ---
{
  const out = parseListLines('a\nb\n', '([unclosed');
  check(eq(out, ['a', 'b']), `invalid pattern falls back to raw lines (got ${JSON.stringify(out)})`);
}

// --- CRLF line endings handled ---
{
  const out = parseListLines('one\r\ntwo\r\n');
  check(eq(out, ['one', 'two']), `CRLF split (got ${JSON.stringify(out)})`);
}

// --- empty input -> empty list ---
{
  check(eq(parseListLines(''), []), 'empty input -> empty list');
}

// --- pathological huge input is capped so the builder dropdown can't blow up ---
{
  const many = Array.from({ length: MAX_LIST_VALUES + 500 }, (_, i) => 'test_' + i).join('\n');
  const out = parseListLines(many);
  check(out.length === MAX_LIST_VALUES, `values capped at MAX_LIST_VALUES (got ${out.length})`);
  check(out[0] === 'test_0', 'cap keeps first-appearance order');
}

// --- applyInsertTemplate: default is a bare value ---
{
  check(applyInsertTemplate(undefined, 'smoke') === 'smoke', 'default template -> bare value');
  check(applyInsertTemplate('   ', 'smoke') === 'smoke', 'blank template -> bare value');
}

// --- applyInsertTemplate: custom template substitutes every ${value} ---
{
  check(
    applyInsertTemplate('+UVM_TESTNAME=${value}', 'my_test') === '+UVM_TESTNAME=my_test',
    'custom template substituted'
  );
  check(
    applyInsertTemplate('--test ${value} --tb ${value}', 'x') === '--test x --tb x',
    'every ${value} occurrence substituted'
  );
}

console.log(failures === 0 ? '\nAll value-list tests passed.' : `\n${failures} value-list test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
