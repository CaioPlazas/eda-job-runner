import { execSync } from 'child_process';

// Bundle the pure status-text module and import it, matching the style of
// run-parser-tests.mjs / run-tailer-tests.mjs.
execSync('npx esbuild ./src/statusText.ts --bundle --format=esm --platform=node --outfile=/tmp/statusText.mjs', {
  stdio: 'inherit'
});
const { describeStatus, describeStatusShort, describeStatusLong, describeLiveProgress, countSuffix, formatDuration } =
  await import('/tmp/statusText.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

// --- THE load-bearing rule -------------------------------------------------
// A tree row's text must not contain anything that moves on its own. If it
// does, the only way to keep it honest is to rebuild the whole sidebar on a
// timer, which is a visible, constant repaint for the entire length of a run.
// Everything live belongs in the status bar or the on-hover tooltip instead.

const started = 1_700_000_000_000;
const runningEarly = { state: 'running', startTime: started, errorCount: 0, warningCount: 0 };
const runningLater = { state: 'running', startTime: started, errorCount: 7, warningCount: 3 };

check(
  describeStatus(runningEarly) === describeStatus(runningLater),
  `a running row's text ignores elapsed time and in-progress counts (got ${JSON.stringify(
    describeStatus(runningEarly)
  )} vs ${JSON.stringify(describeStatus(runningLater))})`
);
check(describeStatus(runningEarly) === 'running', `plain running row reads "running" (got ${JSON.stringify(describeStatus(runningEarly))})`);
check(!/\d/.test(describeStatus(runningLater)), 'a running row contains no digits at all -- nothing to tick');
check(
  describeStatus({ state: 'running', startTime: started, reattached: true }) === 'running (resumed)',
  'a resumed run still says so'
);
check(
  describeStatus({ state: 'running', startTime: started, detached: true }) === 'running (detached)',
  'a detached run still says so'
);

// --- terminal states keep their (now final, so static) detail --------------

check(
  describeStatus({ state: 'passed', startTime: started, endTime: started + 151_000 }) === 'passed (2:31)',
  'a passed row keeps its duration'
);
check(
  describeStatus({ state: 'passed', startTime: started, endTime: started + 151_000, warningCount: 1 }) === 'passed (2:31) · 1⚠',
  'a passed row keeps its final counts'
);
check(describeStatus({ state: 'failed', exitCode: 2 }) === 'exit 2', 'a failed row reports its exit code');
check(
  describeStatus({ state: 'failed', exitCode: 0, errorCount: 4 }) === 'log errors · 4✗',
  'a zero-exit failure caused by parsed errors says so'
);
check(describeStatus({ state: 'killed' }) === 'killed', 'a killed row reads "killed"');
check(describeStatus({ state: 'idle' }) === '', 'an idle row has no status text');

// --- countSuffix ----------------------------------------------------------

check(countSuffix({ state: 'passed' }) === '', 'no counts -> no suffix');
check(countSuffix({ state: 'failed', errorCount: 2, warningCount: 1 }) === ' · 2✗ 1⚠', 'both counts render');
check(countSuffix({ state: 'failed', warningCount: 5 }) === ' · 5⚠', 'a zero error count is omitted');

// --- the live half, which is only ever built on hover ---------------------

const live = describeLiveProgress(runningLater, started + 151_000);
check(live.includes('2:31'), `live progress includes elapsed (got ${JSON.stringify(live)})`);
check(live.includes('7 error') && live.includes('3 warning'), 'live progress includes current counts');
check(
  describeLiveProgress(runningEarly, started + 1000).includes('no errors or warnings parsed yet'),
  'live progress says so when nothing has been parsed'
);
check(
  describeLiveProgress(runningLater, started + 151_000) !== describeLiveProgress(runningLater, started + 152_000),
  'live progress DOES move with the clock -- that is why it is resolved on demand, not rendered into a row'
);

// --- describeStatusLong (the static half of a tooltip) --------------------

check(describeStatusLong({ state: 'idle' }).includes('Never run'), 'idle tooltip explains itself');
check(describeStatusLong({ state: 'passed', exitCode: 0 }).includes('exit code: 0'), 'tooltip reports exit code 0');
check(
  describeStatusLong({ state: 'running', detached: true }).includes('Lost track'),
  'a detached run explains what detached means'
);
check(
  describeStatusLong({ state: 'running', reattached: true }).includes('Resumed live tailing'),
  'a resumed run explains what resumed means'
);

// --- describeStatusShort: the sidebar's own, shorter text ------------------
// Same no-clock invariant as describeStatus (it feeds the same tree row), plus
// its own reason to exist: TreeItem.description renders smaller and dimmer than
// the label, so it has to stay short enough not to be ellipsized. Counts moved
// to the hover tooltip and pass/fail to a full-opacity badge.

check(
  describeStatusShort(runningEarly) === describeStatusShort(runningLater),
  'a running row ignores elapsed time and in-progress counts here too'
);
check(!/\d/.test(describeStatusShort(runningLater)), 'a running row contains no digits at all -- nothing to tick');
check(describeStatusShort(runningEarly) === 'running', 'plain running row reads "running"');
check(
  describeStatusShort({ state: 'running', startTime: started, reattached: true }) === 'running (resumed)',
  'a resumed run still says so in the short form'
);
check(
  describeStatusShort({ state: 'passed', startTime: started, endTime: started + 83_000 }) === 'passed 1:23',
  `a passed row keeps its duration without parentheses (got ${JSON.stringify(
    describeStatusShort({ state: 'passed', startTime: started, endTime: started + 83_000 })
  )})`
);
check(
  describeStatusShort({ state: 'passed', startTime: started, endTime: started + 83_000, errorCount: 4, warningCount: 2 }) ===
    'passed 1:23',
  'the short form drops the count suffix -- the badge and tooltip carry that now'
);
check(
  describeStatusShort({ state: 'failed', exitCode: 1, errorCount: 9 }) === 'exit 1',
  'a failed row reports its exit code and nothing else'
);
check(
  describeStatusShort({ state: 'failed', exitCode: 0, errorCount: 3 }) === 'log errors',
  'a zero-exit failure still explains it was the log that failed it'
);
check(describeStatusShort({ state: 'killed' }) === 'killed', 'a killed row reads "killed"');
check(describeStatusShort({ state: 'idle' }) === '', 'an idle row has no status text at all');
// The whole point of the short form: it must be shorter than what it replaced.
check(
  describeStatusShort({ state: 'passed', startTime: started, endTime: started + 83_000, errorCount: 4, warningCount: 2 }).length <
    describeStatus({ state: 'passed', startTime: started, endTime: started + 83_000, errorCount: 4, warningCount: 2 }).length,
  'the short form really is shorter than describeStatus for the same status'
);

// --- formatDuration -------------------------------------------------------

check(formatDuration(0) === '0s', 'zero renders as 0s');
check(formatDuration(45_000) === '45s', 'under a minute renders as seconds');
check(formatDuration(151_000) === '2:31', 'over a minute renders as m:ss');
check(formatDuration(60_000) === '1:00', 'exactly a minute pads its seconds');
check(formatDuration(-5000) === '0s', 'a negative duration clamps to 0s');

console.log(failures === 0 ? '\nALL STATUS-TEXT ASSERTIONS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
