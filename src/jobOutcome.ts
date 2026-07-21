// Pure pass/fail decision logic, deliberately free of any `vscode` import so
// it can be unit-tested by the standalone Node harness
// (test-fixtures/run-decide-tests.mjs) the same way the other pure modules
// are. Kept separate from jobRunner.ts's streaming/IO plumbing (which needs
// vscode + child processes and isn't unit-testable in isolation) so the
// actual decision -- the part most worth getting right and easiest to get
// subtly wrong -- has real test coverage.

export type JobRunState = 'idle' | 'running' | 'passed' | 'failed' | 'killed';

export interface OutcomeInput {
  /** 'killed' | 'passed' | 'failed' as already decided from the user's Stop / the process exit code. */
  baseState: JobRunState;
  errorCount: number;
  failOnLogErrors: boolean;
  /** Whether this run had the structured UVM/Questa/Icarus/DSim/Verilator issue parser active. */
  parseProblems: boolean;
  hasFailPattern: boolean;
  hasPassPattern: boolean;
  /** Whether `failPattern` matched anywhere in this run's output. Ignored if `hasFailPattern` is false. */
  matchedFail: boolean;
  /** Whether `passPattern` matched anywhere in this run's output. Ignored if `hasPassPattern` is false. */
  matchedPass: boolean;
}

/**
 * Decide a run's final state. Precedence, strongest signal first:
 * 1. `killed` always wins -- a user Stop is never reinterpreted as a failure
 *    for a missing/unmatched signal.
 * 2. A matching `failPattern` forces `failed`, overriding exit code 0 and any
 *    `passPattern` -- the strongest evidence, since the whole feature exists
 *    because exit codes and summary lines can lie.
 * 3. A configured `passPattern` fully governs the outcome: matched -> `passed`
 *    (overrides a nonzero exit, for tools that always exit nonzero even on
 *    success); never matched -> `failed`. Forcing a fail on an absent pass
 *    signal mirrors how `failOnLogErrors` already treats "expected signal
 *    absent" as suspicious -- `passPattern` exists specifically because the
 *    exit code can't be trusted, so a missing pass signal can't be trusted
 *    as a pass either. When `passPattern` governs, the generic
 *    errorCount/failOnLogErrors flip below is bypassed entirely.
 * 4. Otherwise, today's pre-existing behavior: a `passed` baseState flips to
 *    `failed` when `parseProblems && failOnLogErrors && errorCount > 0`;
 *    otherwise `baseState` stands as-is.
 *
 * Both patterns are evaluated independently of `parseProblems` -- a plain
 * per-line regex test is a separate, lighter mechanism than the structured
 * issue parser, so it still works with output scanning turned off.
 */
export function decideFinalState(input: OutcomeInput): JobRunState {
  if (input.baseState === 'killed') {
    return 'killed';
  }
  if (input.hasFailPattern && input.matchedFail) {
    return 'failed';
  }
  if (input.hasPassPattern) {
    return input.matchedPass ? 'passed' : 'failed';
  }
  if (input.baseState === 'passed' && input.parseProblems && input.failOnLogErrors && input.errorCount > 0) {
    return 'failed';
  }
  return input.baseState;
}

/** Compile a user-supplied regex case-insensitively. Undefined for blank or invalid input -- never throws. */
export function compilePattern(source: string | undefined): RegExp | undefined {
  const trimmed = (source ?? '').trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new RegExp(trimmed, 'i');
  } catch {
    return undefined;
  }
}
