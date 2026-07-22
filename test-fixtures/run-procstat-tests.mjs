import { execSync } from 'child_process';

// Bundle the pure /proc/<pid>/stat parsing logic to a temp ESM file and
// import it, the same approach the other pure-module test harnesses use.
execSync('npx esbuild ./src/procStat.ts --bundle --format=esm --outfile=/tmp/procStat.mjs', {
  stdio: 'inherit'
});
const { parseStartTimeTicks } = await import('/tmp/procStat.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

// A real captured /proc/self/stat shape (fields abbreviated where
// irrelevant): pid (comm) state ppid pgrp session tty tpgid flags minflt
// cminflt majflt cmajflt utime stime cutime cstime priority nice
// num_threads itrealvalue starttime ...
const plain = '12345 (bash) S 100 12345 12345 0 -1 4194304 10 0 0 0 5 2 0 0 20 0 1 0 987654321 0';
check(parseStartTimeTicks(plain) === 987654321, 'plain comm: extracts field 22 (starttime)');

// comm containing spaces and parens -- e.g. a process renamed via prctl to
// something like "my (weird) prog". Must slice past the LAST ')', not the
// first, or this would misparse.
const weirdComm = '999 (my (weird) prog) R 1 999 999 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 42 0';
check(parseStartTimeTicks(weirdComm) === 42, 'comm with nested parens/spaces: still finds field 22 via the last )');

check(parseStartTimeTicks('') === undefined, 'empty input -> undefined, does not throw');
check(parseStartTimeTicks('no parens here at all') === undefined, 'no ) in input -> undefined');
check(parseStartTimeTicks('1 (comm) S') === undefined, 'truncated stat line (missing starttime) -> undefined');
const nonNumericStarttime = '1 (comm) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 abc';
check(parseStartTimeTicks(nonNumericStarttime) === undefined, 'non-numeric field 22 -> undefined, does not throw');

console.log(failures === 0 ? '\nAll procStat tests passed.' : `\n${failures} procStat test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
