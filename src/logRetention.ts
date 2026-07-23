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

// A repeat-count batch lane's filename carries a `_<i>-<total>` suffix (see
// `sanitizeLaneSuffix`/`createLogFile` in jobRunner.ts/logManager.ts --
// `label` is `${i}/${total}`, sanitized to `${i}-${total}`).
const BATCH_SUFFIX_RE = /_(\d+)-(\d+)\.log$/;

/**
 * Groups a newest-first file list into "run families": every lane of a
 * repeat-count batch counts as one family, so the batch is never partially
 * pruned while (or after) it's still logically "one run" of N iterations.
 * An unsuffixed primary-run log is a family of one.
 *
 * Relies on `runBatch` (jobRunner.ts) always iterating `i = 1..total`
 * sequentially for a given job, with no other run for that same job
 * interleaved (enforced there by the ongoing-batch guard) -- so walking
 * newest-first, a batch's lanes always appear as a contiguous,
 * strictly-decreasing `i` sequence that terminates at `i === 1` (the
 * iteration the batch started at, whether or not it reached `total`).
 */
function groupIntoFamilies(files: PruneFile[]): PruneFile[][] {
  const families: PruneFile[][] = [];
  let openBatch: PruneFile[] | undefined;

  for (const file of files) {
    const match = BATCH_SUFFIX_RE.exec(file.path);
    if (!match) {
      openBatch = undefined;
      families.push([file]);
      continue;
    }
    if (openBatch) {
      openBatch.push(file);
    } else {
      openBatch = [file];
      families.push(openBatch);
    }
    if (Number(match[1]) === 1) {
      openBatch = undefined; // reached the batch's first iteration -- family closed
    }
  }
  return families;
}

/**
 * Decide which files to delete, given `files` already sorted newest-first
 * (matching `LogManager.listRuns`'s existing convention). Pruning operates
 * on run **families** (see `groupIntoFamilies`) rather than individual
 * files, so a repeat-count batch is always kept or removed as a whole.
 * Both constraints can apply at once: the count cap is enforced first (if
 * set), then the size cap walks the surviving families newest-first,
 * cutting whole families oldest-first once the cumulative size would
 * exceed it (if set). The newest family is never cut by the size cap, even
 * if it alone exceeds the cap -- retention should age out old runs, not
 * delete the run that just finished. Either cap alone, or neither, works
 * the same as before this feature existed (count-only was the only
 * option; 0/0 means keep everything, matching "no retention limit").
 */
export function planPrune(files: PruneFile[], opts: RetentionOptions): string[] {
  const families = groupIntoFamilies(files);
  const toDelete: string[] = [];
  let survivors = families;

  if (opts.maxCount > 0 && survivors.length > opts.maxCount) {
    toDelete.push(...survivors.slice(opts.maxCount).flat().map(f => f.path));
    survivors = survivors.slice(0, opts.maxCount);
  }

  if (opts.maxTotalBytes > 0) {
    let cumulative = 0;
    let cutIndex = survivors.length;
    for (let i = 0; i < survivors.length; i++) {
      cumulative += survivors[i].reduce((sum, f) => sum + f.size, 0);
      if (cumulative > opts.maxTotalBytes && i > 0) {
        cutIndex = i;
        break;
      }
    }
    toDelete.push(...survivors.slice(cutIndex).flat().map(f => f.path));
  }

  return toDelete;
}
