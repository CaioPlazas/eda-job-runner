import { execSync } from 'child_process';

// Bundle the pure log-header/trailer parsing helpers to a temp ESM file and
// import them, the same approach every other test-fixtures harness uses.
execSync('npx esbuild ./src/logIndex.ts --bundle --format=esm --outfile=/tmp/logIndex.mjs', {
  stdio: 'inherit'
});
const { parseLogHeader, parseLogTrailer, parseLogFilename, searchMatches } = await import('/tmp/logIndex.mjs');

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

// --- parseLogHeader: plain job, no lane, no seed ---
{
  const header =
    '# EDA Job Runner\n# job: smoke_test\n# command: make sim TEST=smoke_test\n' +
    '# cwd: /work/sim\n# started: 2026-07-22T10:00:00.000Z\n\n';
  const info = parseLogHeader(header);
  check(
    eq(info, {
      jobName: 'smoke_test',
      command: 'make sim TEST=smoke_test',
      cwd: '/work/sim',
      started: '2026-07-22T10:00:00.000Z'
    }),
    `plain header, no lane/seed (got ${JSON.stringify(info)})`
  );
}

// --- parseLogHeader: with a lane label and a seed ---
{
  const header =
    '# EDA Job Runner\n# job: regress_seeds (run 3/10)\n# command: sim -seed 12345\n' +
    '# seed: 12345\n# cwd: /work/sim\n# started: 2026-07-22T10:05:00.000Z\n\n';
  const info = parseLogHeader(header);
  check(info.jobName === 'regress_seeds', `job name with lane suffix stripped (got ${JSON.stringify(info.jobName)})`);
  check(info.laneLabel === '3/10', `lane label extracted (got ${JSON.stringify(info.laneLabel)})`);
  check(info.seed === '12345', `seed extracted (got ${JSON.stringify(info.seed)})`);
}

// --- parseLogHeader: garbage/empty text -> empty object, never throws ---
{
  const info = parseLogHeader('not a real log header at all');
  check(eq(info, {}), `unrecognized header -> empty object (got ${JSON.stringify(info)})`);
}

// --- parseLogTrailer: simple passed, no errors/warnings, no signal ---
{
  const trailer = '\n# EDA Job Runner: passed (exit 0) at 2026-07-22T10:01:00.000Z\n';
  const info = parseLogTrailer(trailer);
  check(
    eq(info, { state: 'passed', exitCode: '0', ended: '2026-07-22T10:01:00.000Z' }),
    `simple passed trailer (got ${JSON.stringify(info)})`
  );
}

// --- parseLogTrailer: failed with error/warning counts ---
{
  const trailer =
    '\n# EDA Job Runner: failed (exit 0, 2 error(s) 1 warning(s) parsed) at 2026-07-22T10:02:00.000Z\n';
  const info = parseLogTrailer(trailer);
  check(info.state === 'failed', `state (got ${JSON.stringify(info.state)})`);
  check(info.errorCount === 2, `errorCount (got ${JSON.stringify(info.errorCount)})`);
  check(info.warningCount === 1, `warningCount (got ${JSON.stringify(info.warningCount)})`);
}

// --- parseLogTrailer: killed with a signal, no error/warning counts ---
{
  const trailer = '\n# EDA Job Runner: killed (exit n/a, signal SIGTERM) at 2026-07-22T10:03:00.000Z\n';
  const info = parseLogTrailer(trailer);
  check(info.state === 'killed', `state (got ${JSON.stringify(info.state)})`);
  check(info.exitCode === 'n/a', `exitCode (got ${JSON.stringify(info.exitCode)})`);
  check(info.signal === 'SIGTERM', `signal (got ${JSON.stringify(info.signal)})`);
  check(info.errorCount === undefined, `no error/warning counts when absent (got ${JSON.stringify(info.errorCount)})`);
}

// --- parseLogTrailer: signal AND error/warning counts together ---
{
  const trailer =
    '\n# EDA Job Runner: failed (exit 1, signal SIGTERM, 3 error(s) 0 warning(s) parsed) at 2026-07-22T10:04:00.000Z\n';
  const info = parseLogTrailer(trailer);
  check(info.signal === 'SIGTERM', `signal alongside counts (got ${JSON.stringify(info.signal)})`);
  check(info.errorCount === 3, `errorCount alongside signal (got ${JSON.stringify(info.errorCount)})`);
}

// --- parseLogTrailer: pattern-match note preserved ---
{
  const trailer =
    '\n# EDA Job Runner: failed (exit 0) [failPattern matched] at 2026-07-22T10:05:00.000Z\n';
  const info = parseLogTrailer(trailer);
  check(info.patternNote === '[failPattern matched]', `pattern note (got ${JSON.stringify(info.patternNote)})`);
}

// --- parseLogTrailer: no trailer yet (still running) -> empty object ---
{
  const info = parseLogTrailer('some stdout output\nmore output\n');
  check(eq(info, {}), `no trailer -> empty object (got ${JSON.stringify(info)})`);
}

// --- parseLogFilename: primary lane (no suffix) ---
{
  const info = parseLogFilename('2026-07-22_10-00-00-000.log');
  check(eq(info, { timestamp: '2026-07-22_10-00-00-000' }), `primary lane filename (got ${JSON.stringify(info)})`);
}

// --- parseLogFilename: with a lane suffix ---
{
  const info = parseLogFilename('2026-07-22_10-00-00-000_3-10.log');
  check(
    eq(info, { timestamp: '2026-07-22_10-00-00-000', laneSuffix: '3-10' }),
    `filename with lane suffix (got ${JSON.stringify(info)})`
  );
}

// --- parseLogFilename: latest.log / unrecognized -> empty object ---
{
  check(eq(parseLogFilename('latest.log'), {}), 'latest.log symlink name -> empty object');
}

// --- searchMatches: case-insensitive substring ---
{
  check(searchMatches('UVM_ERROR at line 42', 'uvm_error'), 'case-insensitive match');
  check(!searchMatches('all good here', 'uvm_error'), 'no match -> false');
}

// --- searchMatches: blank query matches everything ---
{
  check(searchMatches('anything at all', ''), 'blank query matches everything');
  check(searchMatches('anything at all', '   '), 'whitespace-only query matches everything');
}

console.log(failures === 0 ? '\nAll log-index tests passed.' : `\n${failures} log-index test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
