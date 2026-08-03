import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveLogsRoot } from './logsRoot';
import { planPrune, RetentionOptions } from './logRetention';
import { JobDefinition } from './types';

// Per-file cap on how much of a (potentially up-to-200MB) log is read for the
// log viewer's table -- only the header (first block) and trailer (last
// block) ever carry the structured fields it needs (see logIndex.ts); the
// bulk of a run's captured output in between is never read just to list it.
// A real EDA tool's startup banner (license checkout messages, version/library-
// load text) can easily run several KB before any useful content (e.g. a seed
// line) appears, so 4 KB could miss it; 16 KB gives real tools more room while
// still being a tiny, bounded read compared to a multi-MB log.
const HEAD_TAIL_CAP = 16 * 1024;

// Cap on how many distinct log paths' head/tail text stays cached (see
// readHeadTail) -- retention already bounds how many log files exist on
// disk at once, but this is a second, independent guard against unbounded
// growth across a long-lived extension host session. Insertion-order
// eviction (Map preserves it): oldest-read path goes first, same tradeoff
// as MAX_LANES_PER_JOB in jobRunner.ts.
const HEAD_TAIL_CACHE_CAP = 2000;

/** Workspace-state key: every logs root a per-job `logsDirectory` override has ever actually written to (see `resolveAllRoots`). */
const KNOWN_ROOTS_STORAGE_KEY = 'eda-job-runner.knownLogRoots';

// How many log files are statted/unlinked at once (see sizeAllRuns). Matches
// logViewerPanel.ts's READ_CONCURRENCY: enough parallelism to hide NFS latency,
// not so much that a thousand-run workspace opens a thousand handles at once.
const STAT_CONCURRENCY = 20;

interface HeadTailCacheEntry {
  mtimeMs: number;
  size: number;
  head: string;
  tail: string;
}

/**
 * Read exactly `length` bytes at `position`, looping until the buffer is full
 * or the file ends. `read(2)` is allowed to return fewer bytes than asked for
 * and routinely does on NFS -- which is where these logs live. A single
 * `handle.read(...)` that ignores its `bytesRead` result leaves the rest of a
 * zero-filled buffer as NUL bytes, which then look like real (empty) content:
 * a log header parses wrong, or a full-text search reports "no match" for text
 * that is right there. Returns only the bytes actually read.
 */
export async function readFully(handle: fs.promises.FileHandle, length: number, position: number): Promise<Buffer> {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  // allocUnsafe, not alloc: every byte is either overwritten below or trimmed
  // off by the subarray, and these buffers are megabytes each in the search path.
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, position + filled);
    if (bytesRead <= 0) {
      break; // EOF (or the file shrank under us)
    }
    filled += bytesRead;
  }
  return filled === length ? buf : buf.subarray(0, filled);
}

/**
 * The last `maxBytes` of a file as text, plus the offset that text ended at --
 * the caller (the live-tail view) starts tailing from exactly there, so no
 * bytes written between this read and the first poll are skipped or shown
 * twice. Standalone rather than a LogManager method because that view has no
 * LogManager instance. Never throws: an unreadable file yields empty text at
 * offset 0, which tails the file from its start once it appears.
 */
export async function readTailChunk(
  filePath: string,
  maxBytes: number
): Promise<{ text: string; endOffset: number; truncated: boolean }> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch {
    return { text: '', endOffset: 0, truncated: false };
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(maxBytes, size);
    const buf = await readFully(handle, length, size - length);
    return { text: buf.toString('utf8'), endOffset: size, truncated: size > length };
  } catch {
    return { text: '', endOffset: 0, truncated: false };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class LogManager {
  private readonly workspaceRoot: string;
  private readonly knownRoots: Set<string>;
  /** readHeadTail's cache, keyed by log path -- see HEAD_TAIL_CACHE_CAP. */
  private readonly headTailCache = new Map<string, HeadTailCacheEntry>();

  constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly memento?: vscode.Memento
  ) {
    this.workspaceRoot = workspaceFolder.uri.fsPath;
    this.knownRoots = new Set(memento?.get<string[]>(KNOWN_ROOTS_STORAGE_KEY, []) ?? []);
  }

  /**
   * The effective logs-storage root: the `eda-job-runner.logsDirectory`
   * workspace setting if set, else `<workspaceRoot>/.eda-runner/logs` (the
   * hardcoded default this used to be unconditionally). Recomputed fresh on
   * every call, not cached at construction -- a `.vscode/settings.json` edit
   * doesn't require a window reload, same convention as every other
   * config-backed setting in this codebase (e.g. `shellPath`/`postSetupCwd`
   * in jobRunner.ts). `jobOverride` plugs in a per-job override (see
   * `JobDefinition.logsDirectory`) when the caller has one.
   */
  resolveRoot(jobOverride?: string): string {
    const globalSetting = vscode.workspace
      .getConfiguration('eda-job-runner', this.workspaceFolder.uri)
      .get<string>('logsDirectory', '');
    return resolveLogsRoot({ workspaceRoot: this.workspaceRoot, globalSetting, jobOverride });
  }

  /**
   * The de-duplicated set of every logs root actually in use: the global
   * root, every *currently existing* job's own resolved override (if any),
   * plus every root any job has ever actually written a log to (see
   * `knownRoots`/`rememberRoot`) -- a cross-job scan (the Log Viewer's
   * table, "clean all logs") needs every root a per-job `logsDirectory`
   * override could have redirected a job's runs to, including a job since
   * deleted from JobStore, or that job's logs would silently vanish from
   * view/from the clean-all sweep forever.
   */
  resolveAllRoots(jobs: JobDefinition[]): string[] {
    const roots = new Set<string>([this.resolveRoot(), ...this.knownRoots]);
    for (const job of jobs) {
      if (job.logsDirectory && job.logsDirectory.trim()) {
        roots.add(this.resolveRoot(job.logsDirectory));
      }
    }
    return [...roots];
  }

  /**
   * Opens the log file with the `a` (append) flag and returns the raw
   * `FileHandle` rather than a `WriteStream`: the caller passes its `.fd`
   * straight into the spawned child's `stdio` array so the job's own
   * stdout/stderr write directly to this file at the OS level (append mode
   * guarantees the header write below and the child's own writes never
   * interleave out of order) -- this is what lets capture survive an
   * extension-host restart, since it no longer depends on this process
   * staying alive to relay the child's output through a pipe.
   *
   * `laneSuffix` disambiguates log filenames for a job's non-primary run
   * lanes (concurrent extra instances, or sequential repeat-count
   * iterations) — e.g. "run2" or "3-10" — so they never collide with each
   * other or with the primary lane's log, and don't relink `latest.log`
   * (that always tracks the primary lane).
   */
  async createLogFile(
    jobId: string,
    retention: RetentionOptions,
    laneSuffix?: string,
    root: string = this.resolveRoot(),
    exclude: Set<string> = new Set()
  ): Promise<{ logPath: string; handle: fs.promises.FileHandle }> {
    const dir = path.join(root, jobId);
    await fs.promises.mkdir(dir, { recursive: true });
    const logPath = path.join(dir, `${timestamp()}${laneSuffix ? `_${laneSuffix}` : ''}.log`);
    const handle = await fs.promises.open(logPath, 'a');
    if (!laneSuffix) {
      await this.relinkLatest(dir, logPath);
    }
    await this.prune(jobId, retention, root, exclude);
    await this.rememberRoot(root);
    return { logPath, handle };
  }

  /** Newest-first list of past run log files for a job (excludes the latest.log symlink). */
  async listRuns(jobId: string, root: string = this.resolveRoot()): Promise<string[]> {
    const dir = path.join(root, jobId);
    try {
      const entries = await fs.promises.readdir(dir);
      return entries
        .filter(e => e.endsWith('.log') && e !== 'latest.log')
        .sort()
        .reverse()
        .map(e => path.join(dir, e));
    } catch {
      return [];
    }
  }

  /** Every job id that has ever had a log directory created under `root`, including one for a job since deleted from JobStore. */
  async listAllJobIds(root: string = this.resolveRoot()): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Every past run log across every job, for the log viewer's table. Not
   * sorted -- callers order by whatever field they display. `roots`
   * defaults to just the single global root; a per-job override (see
   * `JobDefinition.logsDirectory`) means a caller that wants to see
   * everything needs to pass the de-duplicated set of every root actually
   * in use (global + each overriding job's own).
   */
  async listAllRuns(roots: string[] = [this.resolveRoot()]): Promise<{ jobId: string; logPath: string }[]> {
    const perRoot = await Promise.all(
      roots.map(async root => {
        const jobIds = await this.listAllJobIds(root);
        const perJob = await Promise.all(
          jobIds.map(async jobId => (await this.listRuns(jobId, root)).map(logPath => ({ jobId, logPath })))
        );
        return perJob.flat();
      })
    );
    return perRoot.flat();
  }

  /**
   * The first and last `HEAD_TAIL_CAP` bytes of a log file -- enough to
   * recover its header and trailer (see logIndex.ts) without reading a
   * potentially huge captured-output body in between. Never throws; a
   * missing/unreadable file (e.g. pruned between listing and reading)
   * yields empty strings.
   *
   * Cached by `filePath + mtimeMs + size` (see `headTailCache`): a finished
   * run's log never changes again, and the Log Viewer re-reads every past
   * run's head/tail on every open and every Refresh -- without this, that's
   * a full file open+read of every run, every time, even though almost all
   * of them are immutable history. A cache hit costs one `stat`, no read at
   * all. Still-growing (currently-running) logs naturally miss the cache
   * once their mtime/size move on.
   */
  async readHeadTail(filePath: string): Promise<{ head: string; tail: string; size: number }> {
    // stat() first, open() only on a miss: the comment above promises a cache
    // hit costs one stat, and the Log Viewer takes thousands of them per open
    // -- opening first made every hit an open+fstat+close instead, three NFS
    // round-trips where one was intended.
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = await fs.promises.stat(filePath));
    } catch {
      return { head: '', tail: '', size: 0 };
    }
    const cached = this.headTailCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return { head: cached.head, tail: cached.tail, size: cached.size };
    }

    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(filePath, 'r');
    } catch {
      return { head: '', tail: '', size: 0 };
    }
    try {
      const head = await readFully(handle, Math.min(HEAD_TAIL_CAP, size), 0);
      // The head read above already covers the whole file once it's no
      // bigger than the cap -- re-reading the same bytes as a "tail" would
      // just be redundant I/O for identical content.
      const tail =
        size <= HEAD_TAIL_CAP ? head : await readFully(handle, HEAD_TAIL_CAP, size - HEAD_TAIL_CAP);
      const result = { head: head.toString('utf8'), tail: tail.toString('utf8'), size };
      this.cacheHeadTail(filePath, mtimeMs, result);
      return result;
    } catch {
      // A file that vanishes or errors mid-read (pruned by retention, or
      // another run's log rotation, between being listed and being read)
      // must not take down the whole log-viewer table build with an
      // unhandled rejection -- treat it the same as "couldn't open".
      return { head: '', tail: '', size: 0 };
    } finally {
      // Inside its own catch: a close() failure escaping this "never throws"
      // API used to be enough to strand a reattached job mid-finalize.
      await handle.close().catch(() => undefined);
    }
  }

  private cacheHeadTail(filePath: string, mtimeMs: number, result: { head: string; tail: string; size: number }): void {
    this.headTailCache.delete(filePath); // re-insert at the end -- keeps insertion order meaningful for eviction below
    this.headTailCache.set(filePath, { mtimeMs, ...result });
    if (this.headTailCache.size > HEAD_TAIL_CACHE_CAP) {
      const oldest = this.headTailCache.keys().next().value;
      if (oldest !== undefined) {
        this.headTailCache.delete(oldest);
      }
    }
  }

  /**
   * Total run count and on-disk byte size across `roots` -- the "how much
   * would this actually delete" summary for the clean-all confirmation.
   * `exclude` (a currently-live run's log path, see
   * `JobRunner.getActiveLogPaths`) is left out of both counts so the
   * confirmation matches what `cleanAllLogs` will actually delete.
   */
  async totalSize(
    roots: string[] = [this.resolveRoot()],
    exclude: Set<string> = new Set()
  ): Promise<{ files: number; bytes: number; skipped: number }> {
    const { sizes, skipped } = await this.sizeAllRuns(roots, exclude);
    let bytes = 0;
    for (const size of sizes.values()) {
      bytes += size;
    }
    return { files: sizes.size, bytes, skipped };
  }

  /**
   * Size of every non-excluded run log under `roots`, statted in bounded
   * parallel batches like `listAllRuns`/`prune` already do -- serially awaiting
   * one stat at a time meant a workspace with a thousand retained runs spent
   * seconds of wall-clock on NFS latency alone, twice over (once for the
   * clean-all confirmation, once for the deletion itself).
   */
  private async sizeAllRuns(
    roots: string[],
    exclude: Set<string>
  ): Promise<{ sizes: Map<string, number>; skipped: number }> {
    const runs = await this.listAllRuns(roots);
    const targets = runs.filter(run => !exclude.has(run.logPath));
    const sizes = new Map<string, number>();
    for (let i = 0; i < targets.length; i += STAT_CONCURRENCY) {
      const batch = targets.slice(i, i + STAT_CONCURRENCY);
      const batchSizes = await Promise.all(batch.map(run => this.fileSize(run.logPath)));
      batch.forEach((run, j) => sizes.set(run.logPath, batchSizes[j]));
    }
    return { sizes, skipped: runs.length - targets.length };
  }

  /**
   * Deletes every past run log under `roots`, unconditionally -- the caller
   * is responsible for confirming first (see extension.ts's cleanAllLogs
   * command). `exclude` (see `JobRunner.getActiveLogPaths`) skips any log a
   * currently-live run still has open: unlinking it while the child still
   * holds the fd would freeze live tailing/error counts and orphan
   * `finish()`'s trailer write into a deleted inode. Also unlinks any
   * `latest.log` symlink left dangling at a deleted target (skipping one
   * still pointing at an excluded, still-live log). Returns what was
   * actually freed.
   */
  async cleanAllLogs(
    roots: string[] = [this.resolveRoot()],
    exclude: Set<string> = new Set()
  ): Promise<{ files: number; bytes: number; skipped: number }> {
    const { sizes, skipped } = await this.sizeAllRuns(roots, exclude);
    let bytes = 0;
    const paths = [...sizes.keys()];
    for (let i = 0; i < paths.length; i += STAT_CONCURRENCY) {
      const batch = paths.slice(i, i + STAT_CONCURRENCY);
      await Promise.all(batch.map(logPath => fs.promises.unlink(logPath).catch(() => undefined)));
      for (const logPath of batch) {
        bytes += sizes.get(logPath) ?? 0;
      }
    }
    await this.unlinkStaleLatestSymlinks(roots, exclude);
    return { files: paths.length, bytes, skipped };
  }

  /** Removes each job dir's `latest.log` symlink, unless it still points at a `exclude`d (currently-live) log. */
  private async unlinkStaleLatestSymlinks(roots: string[], exclude: Set<string>): Promise<void> {
    for (const root of roots) {
      const jobIds = await this.listAllJobIds(root);
      for (const jobId of jobIds) {
        const dir = path.join(root, jobId);
        const linkPath = path.join(dir, 'latest.log');
        let target: string;
        try {
          target = await fs.promises.readlink(linkPath);
        } catch {
          continue; // no symlink here, or already gone
        }
        const targetAbs = path.isAbsolute(target) ? target : path.join(dir, target);
        if (exclude.has(targetAbs)) {
          continue; // still actively being written -- leave it pointing at the live log
        }
        await fs.promises.unlink(linkPath).catch(() => undefined);
      }
    }
  }

  private async fileSize(filePath: string): Promise<number> {
    try {
      return (await fs.promises.stat(filePath)).size;
    } catch {
      return 0;
    }
  }

  /** Records `root` as having actually held a log, once -- a no-op after the first time (or with no memento), so this never adds I/O to the common repeat-run case. */
  private async rememberRoot(root: string): Promise<void> {
    if (!this.memento || this.knownRoots.has(root)) {
      return;
    }
    this.knownRoots.add(root);
    await this.memento.update(KNOWN_ROOTS_STORAGE_KEY, [...this.knownRoots]);
  }

  private async relinkLatest(dir: string, logPath: string): Promise<void> {
    const linkPath = path.join(dir, 'latest.log');
    await fs.promises.unlink(linkPath).catch(() => undefined);
    await fs.promises.symlink(path.basename(logPath), linkPath).catch(() => undefined);
  }

  /** `exclude` (see `JobRunner.getActiveLogPaths`) keeps retention pruning from unlinking a log a live/reattached run still has open -- same hazard `cleanAllLogs` guards against. */
  private async prune(jobId: string, retention: RetentionOptions, root: string, exclude: Set<string> = new Set()): Promise<void> {
    const runs = await this.listRuns(jobId, root);
    const withSizes = await Promise.all(runs.map(async p => ({ path: p, size: await this.fileSize(p) })));
    const toDelete = planPrune(withSizes, retention).filter(p => !exclude.has(p));
    await Promise.all(toDelete.map(p => fs.promises.unlink(p).catch(() => undefined)));
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}
