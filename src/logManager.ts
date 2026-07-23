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
const HEAD_TAIL_CAP = 4 * 1024;

// Cap on how many distinct log paths' head/tail text stays cached (see
// readHeadTail) -- retention already bounds how many log files exist on
// disk at once, but this is a second, independent guard against unbounded
// growth across a long-lived extension host session. Insertion-order
// eviction (Map preserves it): oldest-read path goes first, same tradeoff
// as MAX_LANES_PER_JOB in jobRunner.ts.
const HEAD_TAIL_CACHE_CAP = 2000;

/** Workspace-state key: every logs root a per-job `logsDirectory` override has ever actually written to (see `resolveAllRoots`). */
const KNOWN_ROOTS_STORAGE_KEY = 'eda-job-runner.knownLogRoots';

interface HeadTailCacheEntry {
  mtimeMs: number;
  size: number;
  head: string;
  tail: string;
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
    root: string = this.resolveRoot()
  ): Promise<{ logPath: string; handle: fs.promises.FileHandle }> {
    const dir = path.join(root, jobId);
    await fs.promises.mkdir(dir, { recursive: true });
    const logPath = path.join(dir, `${timestamp()}${laneSuffix ? `_${laneSuffix}` : ''}.log`);
    const handle = await fs.promises.open(logPath, 'a');
    if (!laneSuffix) {
      await this.relinkLatest(dir, logPath);
    }
    await this.prune(jobId, retention, root);
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
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(filePath, 'r');
    } catch {
      return { head: '', tail: '', size: 0 };
    }
    try {
      const stat = await handle.stat();
      const { size, mtimeMs } = stat;
      const cached = this.headTailCache.get(filePath);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return { head: cached.head, tail: cached.tail, size: cached.size };
      }

      const headLen = Math.min(HEAD_TAIL_CAP, size);
      const headBuf = Buffer.alloc(headLen);
      if (headLen > 0) {
        await handle.read(headBuf, 0, headLen, 0);
      }
      // The head read above already covers the whole file once it's no
      // bigger than the cap -- re-reading the same bytes as a "tail" would
      // just be redundant I/O for identical content.
      let tail: string;
      if (size <= HEAD_TAIL_CAP) {
        tail = headBuf.toString('utf8');
      } else {
        const tailBuf = Buffer.alloc(HEAD_TAIL_CAP);
        await handle.read(tailBuf, 0, HEAD_TAIL_CAP, size - HEAD_TAIL_CAP);
        tail = tailBuf.toString('utf8');
      }
      const result = { head: headBuf.toString('utf8'), tail, size };
      this.cacheHeadTail(filePath, mtimeMs, result);
      return result;
    } catch {
      // A file that vanishes or errors mid-read (pruned by retention, or
      // another run's log rotation, between being listed and being read)
      // must not take down the whole log-viewer table build with an
      // unhandled rejection -- treat it the same as "couldn't open".
      return { head: '', tail: '', size: 0 };
    } finally {
      await handle.close();
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
    const runs = await this.listAllRuns(roots);
    let bytes = 0;
    let files = 0;
    let skipped = 0;
    for (const run of runs) {
      if (exclude.has(run.logPath)) {
        skipped++;
        continue;
      }
      bytes += await this.fileSize(run.logPath);
      files++;
    }
    return { files, bytes, skipped };
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
    const runs = await this.listAllRuns(roots);
    let bytes = 0;
    let files = 0;
    let skipped = 0;
    for (const run of runs) {
      if (exclude.has(run.logPath)) {
        skipped++;
        continue;
      }
      bytes += await this.fileSize(run.logPath);
      await fs.promises.unlink(run.logPath).catch(() => undefined);
      files++;
    }
    await this.unlinkStaleLatestSymlinks(roots, exclude);
    return { files, bytes, skipped };
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

  private async prune(jobId: string, retention: RetentionOptions, root: string): Promise<void> {
    const runs = await this.listRuns(jobId, root);
    const withSizes = await Promise.all(runs.map(async p => ({ path: p, size: await this.fileSize(p) })));
    const toDelete = planPrune(withSizes, retention);
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
