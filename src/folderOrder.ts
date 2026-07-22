// Pure folder-reordering helper, deliberately free of any `vscode` import so
// it can be unit-tested by the standalone Node harness
// (test-fixtures/run-folder-order-tests.mjs), mirroring jobOrder.ts's
// computeReorderedJobs for the job-list equivalent.

/**
 * Reorder `folders` by moving `name` to immediately before `beforeName` (if
 * given and found), or to the end of the list otherwise. Returns the same
 * array reference (no-op) if `name` isn't present -- callers use that to
 * skip persisting a no-op move.
 */
export function computeReorderedFolders(folders: string[], name: string, beforeName: string | undefined): string[] {
  const fromIdx = folders.indexOf(name);
  if (fromIdx === -1) {
    return folders;
  }
  const next = folders.slice();
  next.splice(fromIdx, 1);

  const insertAt = beforeName !== undefined ? next.indexOf(beforeName) : -1;
  next.splice(insertAt === -1 ? next.length : insertAt, 0, name);
  return next;
}
