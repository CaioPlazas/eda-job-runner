import { execSync } from 'child_process';

// Bundle the pure pass/fail decision logic to a temp ESM file and import it,
// the same approach the other pure-module test harnesses use. jobRunner.ts's
// own streaming/IO plumbing needs vscode + child processes and isn't
// unit-testable this way -- decideFinalState/compilePattern carry the real
// test coverage for the decision itself.
execSync('npx esbuild ./src/jobOutcome.ts --bundle --format=esm --outfile=/tmp/jobOutcome.mjs', {
  stdio: 'inherit'
});
const { decideFinalState, compilePattern } = await import('/tmp/jobOutcome.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

const base = {
  baseState: 'passed',
  errorCount: 0,
  failOnLogErrors: true,
  parseProblems: true,
  hasFailPattern: false,
  hasPassPattern: false,
  matchedFail: false,
  matchedPass: false
};

// --- killed always wins, regardless of any pattern flags ---
check(
  decideFinalState({ ...base, baseState: 'killed', hasFailPattern: true, matchedFail: true }) === 'killed',
  'killed beats a matched failPattern'
);
check(
  decideFinalState({ ...base, baseState: 'killed', hasPassPattern: true, matchedPass: false }) === 'killed',
  'killed beats an unmatched passPattern'
);

// --- failPattern matched overrides exit-0 "passed" ---
check(
  decideFinalState({ ...base, baseState: 'passed', hasFailPattern: true, matchedFail: true }) === 'failed',
  'matched failPattern overrides exit-0 passed'
);

// --- failPattern present but not matched falls through to normal logic ---
check(
  decideFinalState({ ...base, baseState: 'passed', hasFailPattern: true, matchedFail: false, errorCount: 0 }) === 'passed',
  'unmatched failPattern is a no-op, falls through'
);

// --- passPattern matched overrides a nonzero-exit "failed" ---
check(
  decideFinalState({ ...base, baseState: 'failed', hasPassPattern: true, matchedPass: true }) === 'passed',
  'matched passPattern overrides nonzero-exit failed'
);

// --- passPattern set but never matched forces failed, even from a "passed" baseState ---
check(
  decideFinalState({ ...base, baseState: 'passed', hasPassPattern: true, matchedPass: false }) === 'failed',
  'unmatched passPattern forces failed'
);

// --- both patterns matched: failPattern wins ---
check(
  decideFinalState({
    ...base,
    baseState: 'passed',
    hasFailPattern: true,
    matchedFail: true,
    hasPassPattern: true,
    matchedPass: true
  }) === 'failed',
  'failPattern beats a matched passPattern'
);

// --- passPattern governing bypasses the errorCount/failOnLogErrors flip ---
check(
  decideFinalState({
    ...base,
    baseState: 'passed',
    hasPassPattern: true,
    matchedPass: true,
    errorCount: 5,
    failOnLogErrors: true
  }) === 'passed',
  'matched passPattern bypasses the log-errors flip'
);

// --- neither pattern set: today's pre-existing behavior is preserved ---
check(
  decideFinalState({ ...base, baseState: 'passed', parseProblems: true, failOnLogErrors: true, errorCount: 1 }) === 'failed',
  'no patterns: log errors still flip passed -> failed (existing behavior)'
);
check(
  decideFinalState({ ...base, baseState: 'passed', parseProblems: false, errorCount: 1 }) === 'passed',
  'no patterns, parseProblems off: errorCount ignored, baseState stands'
);
check(
  decideFinalState({ ...base, baseState: 'passed', failOnLogErrors: false, errorCount: 1 }) === 'passed',
  'no patterns, failOnLogErrors off: baseState stands even with errors'
);
check(
  decideFinalState({ ...base, baseState: 'failed', errorCount: 0 }) === 'failed',
  'no patterns: a real nonzero exit stays failed'
);

// --- compilePattern ---
check(compilePattern(undefined) === undefined, 'compilePattern(undefined) -> undefined');
check(compilePattern('') === undefined, 'compilePattern("") -> undefined');
check(compilePattern('   ') === undefined, 'compilePattern(whitespace) -> undefined');
check(compilePattern('[') === undefined, 'compilePattern(invalid regex) -> undefined, does not throw');
{
  const re = compilePattern('test result:\\s*fail');
  check(re instanceof RegExp, 'compilePattern(valid) -> a RegExp');
  check(re.test('TEST RESULT: FAIL') === true, 'compiled pattern is case-insensitive');
  check(re.test('test result: pass') === false, 'compiled pattern does not match unrelated text');
}

console.log(failures === 0 ? '\nAll pass/fail decision tests passed.' : `\n${failures} decision test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
