import { JobRunState } from './jobOutcome';

/**
 * The fields of `JobRunStatus` (jobRunner.ts) this module actually formats.
 * Declared structurally here rather than importing `JobRunStatus` itself,
 * because that type lives in a file that imports `vscode` -- and a pure module
 * has to stay importable by the standalone Node test harness. `JobRunStatus`
 * satisfies this shape, so callers pass one straight in.
 */
export interface StatusLike {
  state: JobRunState;
  startTime?: number;
  endTime?: number;
  exitCode?: number | null;
  signal?: string | null;
  errorCount?: number;
  warningCount?: number;
  detached?: boolean;
  reattached?: boolean;
}

/**
 * Every piece of status→text formatting the sidebar, the status bar and the
 * completion toasts share. Pure (no `vscode` import) so it can be unit-tested
 * by `test-fixtures/run-status-text-tests.mjs`, which exists mainly to pin
 * down one rule:
 *
 * **A tree row's text must never contain anything that changes on its own.**
 *
 * `describeStatus` used to render `running 1:23 · 2✗` — elapsed time and live
 * error counts — which meant the only way to keep a row honest was to rebuild
 * the entire tree once a second for as long as a job ran. That is a visible,
 * constant repaint of the sidebar, and it was the single reason the periodic
 * refresh existed at all. A running row now reads just `running`; the spinner
 * icon (`sync~spin`) animates by itself with no refresh, and anything
 * genuinely live lives where it costs nothing: the status bar (one item, no
 * tree churn) and the hover tooltip (`JobTreeProvider.resolveTreeItem`, built
 * on demand). Terminal states keep their duration and counts — those are
 * final, so they change only with the state itself.
 */

/** The short text after a row's label. Must be a pure function of `status` alone -- no clock, no counters that move on their own. */
export function describeStatus(status: StatusLike): string {
  switch (status.state) {
    case 'running':
      return status.reattached ? 'running (resumed)' : status.detached ? 'running (detached)' : 'running';
    case 'passed':
      return `passed (${formatDuration((status.endTime ?? 0) - (status.startTime ?? 0))})` + countSuffix(status);
    case 'failed': {
      const reason = status.exitCode === 0 && (status.errorCount ?? 0) > 0 ? 'log errors' : `exit ${status.exitCode ?? '?'}`;
      return reason + countSuffix(status);
    }
    case 'killed':
      return 'killed';
    default:
      return '';
  }
}

/**
 * The tree row's version of `describeStatus`, and the only one the sidebar
 * uses. Shorter on purpose.
 *
 * VS Code renders `TreeItem.description` both smaller than the label *and* at
 * reduced opacity -- it is the least legible text the extension puts on screen,
 * and it was carrying the most important information (`★ default · passed
 * (1:23) · 2✗`), long enough to be ellipsized in a narrow sidebar. Pass/fail is
 * now carried by a full-opacity coloured badge instead (`treeDecorations.ts`)
 * and the counts by the hover tooltip (`describeStatusLong`), so this can drop
 * to one short segment: `running`, `passed 1:23`, `exit 1`, `killed`.
 *
 * Subject to the same invariant as `describeStatus`: a pure function of
 * `status`, no clock, nothing that moves on its own. See this module's header.
 */
export function describeStatusShort(status: StatusLike): string {
  switch (status.state) {
    case 'running':
      return status.reattached ? 'running (resumed)' : status.detached ? 'running (detached)' : 'running';
    case 'passed':
      return `passed ${formatDuration((status.endTime ?? 0) - (status.startTime ?? 0))}`;
    case 'failed':
      return status.exitCode === 0 && (status.errorCount ?? 0) > 0 ? 'log errors' : `exit ${status.exitCode ?? '?'}`;
    case 'killed':
      return 'killed';
    default:
      return '';
  }
}

/** " · 2✗ 1⚠" style suffix, omitting zero counts. Only ever used for a finished run, whose counts are final. */
export function countSuffix(status: StatusLike): string {
  const errs = status.errorCount ?? 0;
  const warns = status.warningCount ?? 0;
  if (!errs && !warns) {
    return '';
  }
  const parts: string[] = [];
  if (errs) {
    parts.push(`${errs}✗`);
  }
  if (warns) {
    parts.push(`${warns}⚠`);
  }
  return ` · ${parts.join(' ')}`;
}

/** The static part of a row's tooltip. A running row's *live* half is added on hover instead -- see describeLiveProgress. */
export function describeStatusLong(status: StatusLike): string {
  if (status.state === 'idle') {
    return '_Never run in this session._';
  }
  const parts = [`status: **${status.state}**`];
  if (status.reattached) {
    parts.push('_Resumed live tailing after a window reload — log, counts, and Problems keep updating as normal._');
  } else if (status.detached) {
    parts.push(
      '_Lost track of this job across a window reload — still running detached. ' +
        'Stop still works; check its log directly for progress._'
    );
  }
  if (status.exitCode !== undefined && status.exitCode !== null) {
    parts.push(`exit code: ${status.exitCode}`);
  }
  if (status.signal) {
    parts.push(`signal: ${status.signal}`);
  }
  return parts.join('\n\n');
}

/**
 * The live half of a running job's tooltip: elapsed so far, plus counts as
 * they stand right now. `now` is a parameter rather than a `Date.now()` call
 * so this stays pure and testable. Deliberately NOT part of `describeStatus`
 * — this is only ever built at the moment the user hovers a row, never as
 * part of a rendered tree.
 */
export function describeLiveProgress(status: StatusLike, now: number): string {
  const parts = [`running for **${formatDuration(now - (status.startTime ?? now))}**`];
  const errs = status.errorCount ?? 0;
  const warns = status.warningCount ?? 0;
  if (errs || warns) {
    parts.push(`${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'} so far`);
  } else {
    parts.push('_no errors or warnings parsed yet_');
  }
  return parts.join('\n\n');
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${totalSeconds}s`;
}
