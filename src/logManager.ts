import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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
