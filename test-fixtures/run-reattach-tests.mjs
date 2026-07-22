import { execSync } from 'child_process';

// Bundle the pure reattachment decision logic (which itself imports
// jobOutcome.ts -- esbuild inlines that relative import into the same
// standalone file) and import it, the same approach the other pure-module
// test harnesses use.
execSync('npx esbuild ./src/reattach.ts --bundle --format=esm --outfile=/tmp/reattach.mjs', {
  stdio: 'inherit'
});
const { decideReattachState } = await import('/tmp/reattach.mjs');

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
  pidAlive: false,
  errorCount: 0,
  failOnLogErrors: true,
  parseProblems: true,
  hasFailPattern: false,
  hasPassPattern: false,
  matchedFail: false,
  matchedPass: false
};

// --- still alive -> undefined regardless of any other signal ---
check(decideReattachState({ ...base, pidAlive: true }) === undefined, 'pid alive -> still running (undefined)');
check(
  decideReattachState({ ...base, pidAlive: true, hasPassPattern: true, matchedPass: true }) === undefined,
  'pid alive beats even a matched passPattern'
);

// --- an existing trailer state (defensive case) is trusted as-is ---
check(
  decideReattachState({ ...base, pidAlive: false, existingTrailerState: 'passed' }) === 'passed',
  'existing trailer state "passed" is trusted over re-deriving'
);
check(
  decideReattachState({ ...base, pidAlive: false, existingTrailerState: 'killed', hasPassPattern: true, matchedPass: true }) ===
    'killed',
  'existing trailer state wins even over a matched passPattern'
);

// --- no trailer, no signals at all: conservative default is failed, not passed ---
check(
  decideReattachState({ ...base }) === 'failed',
  'pid gone, no trailer, no patterns, no errors -> conservative failed (not credited as a pass)'
);
check(
  decideReattachState({ ...base, parseProblems: false }) === 'failed',
  'pid gone, parsing was off entirely -> still conservative failed'
);

// --- a matched passPattern can still flip the conservative default to passed ---
check(
  decideReattachState({ ...base, hasPassPattern: true, matchedPass: true }) === 'passed',
  'matched passPattern overrides the conservative default'
);
check(
  decideReattachState({ ...base, hasPassPattern: true, matchedPass: false }) === 'failed',
  'passPattern set but never matched -> stays failed'
);

// --- a matched failPattern is a no-op here (conservative default is already failed) ---
check(
  decideReattachState({ ...base, hasFailPattern: true, matchedFail: true }) === 'failed',
  'matched failPattern -> failed (same as the conservative default)'
);

// --- failPattern beats a matched passPattern, same precedence as jobOutcome.ts ---
check(
  decideReattachState({ ...base, hasFailPattern: true, matchedFail: true, hasPassPattern: true, matchedPass: true }) === 'failed',
  'failPattern still beats a matched passPattern'
);

// --- errorCount alone (no patterns) never flips a 'failed' baseState to 'passed' -- there is nothing to flip from ---
check(
  decideReattachState({ ...base, errorCount: 5, failOnLogErrors: true }) === 'failed',
  'errorCount alone: baseState was already failed, stays failed'
);

console.log(failures === 0 ? '\nAll reattach-decision tests passed.' : `\n${failures} reattach-decision test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
