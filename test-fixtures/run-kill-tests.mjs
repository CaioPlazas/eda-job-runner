import { execSync } from 'child_process';

// Bundle the pure kill-signal-escalation logic to a temp ESM file and import
// it, the same approach the other pure-module test harnesses use.
execSync('npx esbuild ./src/killPlan.ts --bundle --format=esm --outfile=/tmp/killPlan.mjs', {
  stdio: 'inherit'
});
const { computeKillSchedule } = await import('/tmp/killPlan.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

// --- default setting shape (SIGINT-first, per-stage grace) ---
{
  const schedule = computeKillSchedule({
    signals: [
      { signal: 'SIGINT', graceSeconds: 5 },
      { signal: 'SIGTERM', graceSeconds: 5 },
      { signal: 'SIGKILL' }
    ],
    fallbackGraceMs: 5000
  });
  check(schedule.length === 3, 'default 3-stage list -> 3 stages (got ' + schedule.length + ')');
  check(schedule[0].signal === 'SIGINT', 'leads with SIGINT');
  check(schedule[0].graceMs === 5000, 'SIGINT stage uses its own graceSeconds');
  check(schedule[1].signal === 'SIGTERM', 'second stage SIGTERM');
  check(schedule[2].signal === 'SIGKILL', 'final stage SIGKILL');
}

// --- a stage missing graceSeconds falls back to fallbackGraceMs ---
{
  const schedule = computeKillSchedule({
    signals: [{ signal: 'SIGINT' }, { signal: 'SIGKILL' }],
    fallbackGraceMs: 7000
  });
  check(schedule[0].graceMs === 7000, 'missing graceSeconds falls back to fallbackGraceMs');
}

// --- unrecognized/malformed entries are dropped, not thrown ---
{
  const schedule = computeKillSchedule({
    signals: [{ signal: 'SIGBOGUS' }, { signal: 'SIGINT', graceSeconds: 2 }, {}, { graceSeconds: 3 }],
    fallbackGraceMs: 5000
  });
  check(schedule.length === 2, 'bogus/malformed entries dropped, SIGKILL appended (got ' + schedule.length + ')');
  check(schedule[0].signal === 'SIGINT', 'only the valid entry survives as stage 1');
  check(schedule[1].signal === 'SIGKILL', 'SIGKILL force-appended since list did not end with one');
}

// --- empty/undefined list falls back to the historical SIGTERM->SIGKILL sequence ---
{
  const empty = computeKillSchedule({ signals: [], fallbackGraceMs: 4000 });
  check(empty.length === 2, 'empty list -> safe 2-stage default');
  check(empty[0].signal === 'SIGTERM' && empty[0].graceMs === 4000, 'safe default stage 1 is SIGTERM using fallback grace');
  check(empty[1].signal === 'SIGKILL', 'safe default stage 2 is SIGKILL');

  const undef = computeKillSchedule({ signals: undefined, fallbackGraceMs: 4000 });
  check(undef.length === 2 && undef[0].signal === 'SIGTERM', 'undefined signals list behaves like an empty one');
}

// --- a list that already ends in SIGKILL isn't double-appended ---
{
  const schedule = computeKillSchedule({
    signals: [{ signal: 'SIGTERM', graceSeconds: 1 }, { signal: 'SIGKILL' }],
    fallbackGraceMs: 5000
  });
  check(schedule.length === 2, 'already ends with SIGKILL -> not duplicated (got ' + schedule.length + ')');
}

// --- a list of entirely-invalid entries still gets a safe default plus guaranteed SIGKILL ---
{
  const schedule = computeKillSchedule({ signals: [{ signal: 'NOPE' }], fallbackGraceMs: 5000 });
  check(schedule.length === 2, 'all-invalid list -> falls back to safe default (got ' + schedule.length + ')');
  check(schedule[schedule.length - 1].signal === 'SIGKILL', 'final stage is always SIGKILL');
}

console.log(failures === 0 ? '\nAll kill-schedule tests passed.' : `\n${failures} kill-schedule test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
