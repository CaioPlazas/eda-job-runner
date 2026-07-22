// Pure decision logic for a job reattached after a window reload,
// deliberately free of any `vscode` import so it can be unit-tested by the
// standalone Node harness (test-fixtures/run-reattach-tests.mjs) the same
// way the other pure modules are.

import { JobRunState, decideFinalState } from './jobOutcome';

export interface ReattachInput {
  /** Result of this run's identity-verified /proc liveness poll. */
  pidAlive: boolean;
  /**
   * A completion state already found in the log's own trailer line, if one
   * happens to be there (defensive case: e.g. this job was somehow already
   * finalized by another code path). Trusted as-is over re-deriving one.
   */
  existingTrailerState?: JobRunState;
  errorCount: number;
  failOnLogErrors: boolean;
  parseProblems: boolean;
  hasFailPattern: boolean;
  hasPassPattern: boolean;
  matchedFail: boolean;
  matchedPass: boolean;
}

/**
 * Decide whether a "running (resumed)" reattached job has actually finished,
 * and if so, what its final state is -- returns undefined while it should
 * still be considered running.
 *
 * A reattached process was never spawned by this session (there's no live
 * ChildProcess, and so no real Node 'exit' event/exit code ever arrives for
 * it), so once its pid disappears, the only evidence available is whatever
 * this session's own re-tailing observed in its output: a matched
 * fail/passPattern, or the structured error/warning parser. Reusing
 * decideFinalState with a conservative 'failed' baseState (rather than the
 * optimistic 'passed' a real run starts from) means an unproven run can't be
 * credited as a pass by default, while a genuine, user-configured pass
 * signal can still flip it -- exactly the scenario passPattern exists for
 * (a tool that always exits nonzero even on success).
 */
export function decideReattachState(input: ReattachInput): JobRunState | undefined {
  if (input.pidAlive) {
    return undefined;
  }
  if (input.existingTrailerState) {
    return input.existingTrailerState;
  }
  return decideFinalState({
    baseState: 'failed',
    errorCount: input.errorCount,
    failOnLogErrors: input.failOnLogErrors,
    parseProblems: input.parseProblems,
    hasFailPattern: input.hasFailPattern,
    hasPassPattern: input.hasPassPattern,
    matchedFail: input.matchedFail,
    matchedPass: input.matchedPass
  });
}
