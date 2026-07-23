// Pure retention-pruning logic, deliberately free of any `vscode`/`fs`
// import so it can be unit-tested by the standalone Node harness
// (test-fixtures/run-log-retention-tests.mjs) the same way the other pure
// modules are. The actual `fs.stat`/`fs.unlink` calls are impure and live in
// logManager.ts; this module only decides which paths to delete.

export interface PruneFile {
  path: string;
  size: number;
}

export interface RetentionOptions {
  /** Keep at most this many runs, newest first. 0 (or negative) means unlimited -- no count-based pruning. */
  maxCount: number;
  /** Keep total size under this many bytes, pruning oldest-first among survivors. 0 (or negative) means unlimited -- no size-based pruning. */
  maxTotalBytes: number;
}

/**
 * Decide which files to delete, given `files` already sorted newest-first
 * (matching `LogManager.listRuns`'s existing convention). Both constraints
 * can apply at once: the count cap is enforced first (if set), then the
 * size cap walks the survivors newest-first, pruning oldest-first once the
 * cumulative size would exceed it (if set). Either cap alone, or neither,
 * works the same as before this feature existed (count-only was the only
 * option; 0/0 means keep everything, matching "no retention limit").
 */
export function planPrune(files: PruneFile[], opts: RetentionOptions): string[] {
  const toDelete: string[] = [];
  let survivors = files;

  if (opts.maxCount > 0 && survivors.length > opts.maxCount) {
    toDelete.push(...survivors.slice(opts.maxCount).map(f => f.path));
    survivors = survivors.slice(0, opts.maxCount);
  }

  if (opts.maxTotalBytes > 0) {
    let cumulative = 0;
    let cutIndex = survivors.length;
    for (let i = 0; i < survivors.length; i++) {
      cumulative += survivors[i].size;
      if (cumulative > opts.maxTotalBytes) {
        cutIndex = i;
        break;
      }
    }
    toDelete.push(...survivors.slice(cutIndex).map(f => f.path));
  }

  return toDelete;
}
