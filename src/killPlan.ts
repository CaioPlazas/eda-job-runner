// Pure kill-signal-escalation logic, deliberately free of any `vscode`
// import so it can be unit-tested by the standalone Node harness
// (test-fixtures/run-kill-tests.mjs) the same way the other pure modules
// are. Kept separate from jobRunner.ts's actual signalling/timing (which
// needs real process handles/timers and isn't unit-testable in isolation)
// so the decision -- which signals, in what order, with what grace --
// carries real test coverage.

export type Signal =
  | 'SIGINT'
  | 'SIGTERM'
  | 'SIGKILL'
  | 'SIGHUP'
  | 'SIGQUIT'
  | 'SIGUSR1'
  | 'SIGUSR2'
  | 'SIGABRT';

const KNOWN_SIGNALS: ReadonlySet<string> = new Set<Signal>([
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGHUP',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
  'SIGABRT'
]);

/** One raw entry of the `eda-job-runner.killSignals` setting, before validation/defaulting. */
export interface RawKillSignalEntry {
  signal?: string;
  graceSeconds?: number;
}

export interface KillStage {
  signal: Signal;
  /** How long (ms) to wait after sending this stage's signal before moving to the next. Meaningless on the final stage. */
  graceMs: number;
}

// No graceSeconds of their own -- always resolved against fallbackGraceMs,
// matching today's pre-existing (single-setting) behavior exactly.
const SAFE_DEFAULT_SIGNALS: RawKillSignalEntry[] = [{ signal: 'SIGTERM' }, { signal: 'SIGKILL' }];

/**
 * Turn the user's `killSignals` setting into a concrete ordered escalation
 * schedule. Rules:
 * - Unrecognized/malformed entries are dropped rather than throwing (a typo
 *   in settings.json shouldn't break Stop).
 * - A stage without its own `graceSeconds` falls back to `fallbackGraceMs`
 *   (today's single `killGracePeriodSeconds` setting).
 * - An empty or entirely-invalid list falls back to today's historical
 *   two-stage SIGTERM->SIGKILL sequence, not an empty schedule.
 * - `SIGKILL` is always force-appended as the final stage if the (cleaned)
 *   list doesn't already end with one -- a misconfigured sequence should
 *   never leave a job unkillable.
 */
export function computeKillSchedule(input: {
  signals: RawKillSignalEntry[] | undefined;
  fallbackGraceMs: number;
}): KillStage[] {
  const toStage = (entry: RawKillSignalEntry): KillStage => ({
    signal: entry.signal as Signal,
    graceMs: entry.graceSeconds !== undefined && entry.graceSeconds >= 0
      ? entry.graceSeconds * 1000
      : input.fallbackGraceMs
  });

  const cleaned = (input.signals ?? [])
    .filter((entry): entry is RawKillSignalEntry & { signal: string } => KNOWN_SIGNALS.has(entry?.signal ?? ''))
    .map(toStage);

  const stages = cleaned.length > 0 ? cleaned : SAFE_DEFAULT_SIGNALS.map(toStage);

  if (stages[stages.length - 1].signal !== 'SIGKILL') {
    stages.push({ signal: 'SIGKILL', graceMs: 0 });
  }
  return stages;
}
