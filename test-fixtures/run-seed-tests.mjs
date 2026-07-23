import { execSync } from 'child_process';

execSync('npx esbuild ./src/seedDetect.ts --bundle --format=esm --outfile=/tmp/seedDetect.mjs', {
  stdio: 'inherit'
});
const { detectSeed, compileSeedPattern, BUILTIN_SEED_PATTERNS } = await import('/tmp/seedDetect.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

// --- each built-in pattern, against a synthetic banner/command line ---
check(detectSeed('vsim -sv_seed 123456789 tb_top') === '123456789', 'Questa/Xcelium -sv_seed detected');
check(detectSeed('vsim -svseed=987654321 tb_top') === '987654321', 'Questa/Xcelium -svseed detected');
check(detectSeed('run.sh +ntb_random_seed=42') === '42', 'VCS-style +ntb_random_seed detected');
check(detectSeed('sim +seed=555') === '555', 'generic plusarg +seed= detected');
check(detectSeed('tool -seed 111') === '111', 'generic -seed flag detected');
check(detectSeed('verilator --seed 222 --lint-only') === '222', 'Verilator --seed detected');
check(detectSeed('# Random Seed: 999999') === '999999', 'loosest fallback "seed: value" detected');

// --- precedence: custom pattern tried first ---
check(
  detectSeed('MYTOOL_SEED=42424242 starting run', 'MYTOOL_SEED=(\\d+)') === '42424242',
  'custom pattern takes precedence over builtins'
);
check(
  detectSeed('vsim -sv_seed 123456789 tb_top', 'MYTOOL_SEED=(\\d+)') === '123456789',
  'custom pattern that does not match falls through to builtins'
);

// --- invalid custom regex never throws, falls through safely ---
{
  let threw = false;
  let result;
  try {
    result = detectSeed('vsim -sv_seed 555 tb_top', '[[[invalid(regex');
  } catch {
    threw = true;
  }
  check(!threw, 'an invalid custom regex does not throw');
  check(result === '555', 'invalid custom regex falls through to builtins (got ' + result + ')');
}
check(compileSeedPattern('[[[invalid(regex') === undefined, 'compileSeedPattern(invalid) -> undefined, does not throw');
check(compileSeedPattern(undefined) === undefined, 'compileSeedPattern(undefined) -> undefined');
check(compileSeedPattern('') === undefined, 'compileSeedPattern("") -> undefined');

// --- no match anywhere -> undefined ---
check(detectSeed('a perfectly ordinary log line with no seed info at all') === undefined, 'no match -> undefined');

// --- seed value must look numeric/hex, not a bare word ---
check(
  detectSeed('Simulation seed: automatic') === undefined,
  'the loosest fallback does not treat a non-numeric word ("automatic") as a seed'
);
check(
  detectSeed('vsim -sv_seed  tb_top') === undefined,
  '-sv_seed followed by no real value does not capture the next positional arg ("tb_top") as the seed'
);
check(detectSeed('# Random Seed: 0x1a2b3c') === '0x1a2b3c', 'a 0x-prefixed hex seed value is still detected');

// --- catastrophic-backtracking custom patterns are refused outright, never executed ---
check(compileSeedPattern('(a+)+b') === undefined, 'a classic catastrophic-backtracking shape is refused, not compiled');
check(compileSeedPattern('(x*)*') === undefined, 'another catastrophic shape variant ((x*)*) is refused');
check(compileSeedPattern('MY_SEED=(\\d+)') instanceof RegExp, 'an ordinary safe custom pattern still compiles fine');
{
  const start = Date.now();
  // Would take many seconds (backtracking is exponential in input length) if this pattern actually ran.
  const result = detectSeed('a'.repeat(60), '(a+)+b');
  const elapsed = Date.now() - start;
  check(result === undefined, 'a catastrophic custom pattern is skipped and falls through to the builtins (no match here)');
  check(elapsed < 1000, `detectSeed with a catastrophic custom pattern returns immediately (${elapsed}ms) instead of hanging`);
}

// --- the (safe) custom-pattern text cap still finds a match near the tail of a huge log ---
{
  const huge = 'x'.repeat(50000) + '\nMY_SEED=777888';
  check(
    detectSeed(huge, 'MY_SEED=(\\d+)') === '777888',
    'a safe custom pattern still finds a match near the tail of a huge log, despite the text cap'
  );
}

// --- sanity: the exported builtin list is non-empty and each entry has a label + pattern ---
check(BUILTIN_SEED_PATTERNS.length > 0, 'BUILTIN_SEED_PATTERNS is non-empty');
check(
  BUILTIN_SEED_PATTERNS.every(p => typeof p.label === 'string' && p.pattern instanceof RegExp),
  'every builtin pattern entry has a label and a RegExp'
);

console.log(failures === 0 ? '\nAll seed-detection tests passed.' : `\n${failures} seed-detection test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
