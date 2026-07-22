import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Per-file cap on how much of a (potentially up-to-200MB) log is read for the
// log viewer's table -- only the header (first block) and trailer (last
// block) ever carry the structured fields it needs (see logIndex.ts); the
// bulk of a run's captured output in between is never read just to list it.
const HEAD_TAIL_CAP = 4 * 1024;

export class LogManager {
  private readonly logsRoot: string;

  constructor(workspaceFolder: vscode.WorkspaceFolder) {
    this.logsRoot = path.join(workspaceFolder.uri.fsPath, '.eda-runner', 'logs');
  }

  /**
   * `laneSuffix` disambiguates log filenames for a job's non-primary run
   * lanes (concurrent extra instances, or sequential repeat-count
   * iterations) — e.g. "run2" or "3-10" — so they never collide with each
   * other or with the primary lane's log, and don't relink `latest.log`
   * (that always tracks the primary lane).
   */
  async createLogFile(
    jobId: string,
    retentionCount: number,
    laneSuffix?: string
  ): Promise<{ logPath: string; stream: fs.WriteStream }> {
    const dir = path.join(this.logsRoot, jobId);
    await fs.promises.mkdir(dir, { recursive: true });
    const logPath = path.join(dir, `${timestamp()}${laneSuffix ? `_${laneSuffix}` : ''}.log`);
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    if (!laneSuffix) {
      await this.relinkLatest(dir, logPath);
    }
    await this.prune(jobId, retentionCount);
    return { logPath, stream };
  }

  async getLatestLogPath(jobId: string): Promise<string | undefined> {
    const runs = await this.listRuns(jobId);
    return runs[0];
  }

  /** Newest-first list of past run log files for a job (excludes the latest.log symlink). */
  async listRuns(jobId: string): Promise<string[]> {
    const dir = path.join(this.logsRoot, jobId);
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

  /** Every job id that has ever had a log directory created, including one for a job since deleted from JobStore. */
  async listAllJobIds(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.logsRoot, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  /** Every past run log across every job (not just one), for the log viewer's table. Not sorted -- callers order by whatever field they display. */
  async listAllRuns(): Promise<{ jobId: string; logPath: string }[]> {
    const jobIds = await this.listAllJobIds();
    const perJob = await Promise.all(
      jobIds.map(async jobId => (await this.listRuns(jobId)).map(logPath => ({ jobId, logPath })))
    );
    return perJob.flat();
  }

  /**
   * The first and last `HEAD_TAIL_CAP` bytes of a log file -- enough to
   * recover its header and trailer (see logIndex.ts) without reading a
   * potentially huge captured-output body in between. Never throws; a
   * missing/unreadable file (e.g. pruned between listing and reading)
   * yields empty strings.
   */
  async readHeadTail(filePath: string): Promise<{ head: string; tail: string; size: number }> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(filePath, 'r');
    } catch {
      return { head: '', tail: '', size: 0 };
    }
    try {
      const size = (await handle.stat()).size;
      const headLen = Math.min(HEAD_TAIL_CAP, size);
      const headBuf = Buffer.alloc(headLen);
      if (headLen > 0) {
        await handle.read(headBuf, 0, headLen, 0);
      }
      const tailLen = Math.min(HEAD_TAIL_CAP, size);
      const tailBuf = Buffer.alloc(tailLen);
      if (tailLen > 0) {
        await handle.read(tailBuf, 0, tailLen, Math.max(0, size - tailLen));
      }
      return { head: headBuf.toString('utf8'), tail: tailBuf.toString('utf8'), size };
    } finally {
      await handle.close();
    }
  }

  private async relinkLatest(dir: string, logPath: string): Promise<void> {
    const linkPath = path.join(dir, 'latest.log');
    await fs.promises.unlink(linkPath).catch(() => undefined);
    await fs.promises.symlink(path.basename(logPath), linkPath).catch(() => undefined);
  }

  private async prune(jobId: string, keep: number): Promise<void> {
    const runs = await this.listRuns(jobId);
    const stale = runs.slice(Math.max(0, keep));
    await Promise.all(stale.map(p => fs.promises.unlink(p).catch(() => undefined)));
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
