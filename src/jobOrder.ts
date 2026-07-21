// Pure job-reordering helper, deliberately free of any `vscode` import so it
// can be unit-tested by the standalone Node harness
// (test-fixtures/run-reorder-tests.mjs) the same way the log/tool parsers are.
import { JobDefinition } from './types';

/**
 * Pure reorder logic for drag-and-drop, kept separate from `JobStore` so it
 * can be unit-tested without a live `vscode.workspace.fs`. Returns a new
 * array with `id` moved: immediately before `beforeId` if given and found,
 * otherwise appended right after the last existing job already in the
 * target group (`folder`, or root/ungrouped when `folder` is undefined) so
 * it lands at the end of that group's visual list, not the end of the
 * whole file. Returns the same array reference (no-op) if `id` isn't found.
 */
export function computeReorderedJobs(
  jobs: JobDefinition[],
  id: string,
  beforeId: string | undefined,
  folder: string | undefined
): JobDefinition[] {
  const fromIdx = jobs.findIndex(j => j.id === id);
  if (fromIdx === -1) {
    return jobs;
  }
  const next = jobs.slice();
  const [job] = next.splice(fromIdx, 1);
  if (folder) {
    job.folder = folder;
  } else {
    delete job.folder;
  }

  let insertAt = next.findIndex(j => j.id === beforeId);
  if (insertAt === -1) {
    const groupJobs = next.filter(j => (j.folder ?? undefined) === (folder ?? undefined));
    insertAt = groupJobs.length > 0 ? next.lastIndexOf(groupJobs[groupJobs.length - 1]) + 1 : next.length;
  }
  next.splice(insertAt, 0, job);
  return next;
}
