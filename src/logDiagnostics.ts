import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogIssue } from './logParser';

/**
 * Owns the shared DiagnosticCollection (one Problems-panel provider for the
 * whole extension) and resolves the file paths tools print — which may be
 * absolute, relative to the job's cwd, or just a bare name relative to some
 * incdir we can't see — onto real files in the workspace.
 */
export class LogDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  /** Diagnostics contributed per job id, so re-running a job replaces only its own. */
  private readonly byJob = new Map<string, vscode.Uri[]>();

  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {
    this.collection = vscode.languages.createDiagnosticCollection('eda-job-runner');
  }

  /** Clear a job's previous diagnostics (called when a run starts). */
  clearJob(jobId: string): void {
    const uris = this.byJob.get(jobId);
    if (uris) {
      for (const uri of uris) {
        this.collection.delete(uri);
      }
      this.byJob.delete(jobId);
    }
  }

  /**
   * Replace `jobId`'s diagnostics with those derived from `issues`. Issues
   * whose file can't be resolved to a real path are dropped from the Problems
   * panel (they still counted toward the job's error/warning badge) — a
   * diagnostic with no valid location isn't actionable.
   */
  setJobIssues(jobId: string, jobCwdAbs: string, issues: LogIssue[]): void {
    this.clearJob(jobId);

    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const issue of issues) {
      if (!issue.file || issue.line === undefined) {
        continue;
      }
      const resolved = this.resolvePath(issue.file, jobCwdAbs);
      if (!resolved) {
        continue;
      }
      const lineIdx = Math.max(0, issue.line - 1);
      const colIdx = issue.column ? Math.max(0, issue.column - 1) : 0;
      const range = new vscode.Range(lineIdx, colIdx, lineIdx, Number.MAX_SAFE_INTEGER);
      const diag = new vscode.Diagnostic(
        range,
        issue.message,
        issue.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error
      );
      diag.source = `eda:${issue.source}`;
      const key = resolved.fsPath;
      const list = grouped.get(key) ?? [];
      list.push(diag);
      grouped.set(key, list);
    }

    const uris: vscode.Uri[] = [];
    for (const [fsPath, diags] of grouped) {
      const uri = vscode.Uri.file(fsPath);
      this.collection.set(uri, diags);
      uris.push(uri);
    }
    this.byJob.set(jobId, uris);
  }

  /**
   * Resolve a tool-printed file string to a real file:
   *   1. absolute path that exists → use as-is
   *   2. relative to the job's cwd → use if it exists
   *   3. relative to the workspace root → use if it exists
   *   4. otherwise give up (return undefined) — we don't guess by basename
   *      here, because a bare name can match many files and a wrong jump is
   *      worse than none. Basename search could be a future opt-in.
   */
  private resolvePath(file: string, jobCwdAbs: string): vscode.Uri | undefined {
    if (path.isAbsolute(file)) {
      return existsFile(file) ? vscode.Uri.file(file) : undefined;
    }
    const fromCwd = path.resolve(jobCwdAbs, file);
    if (existsFile(fromCwd)) {
      return vscode.Uri.file(fromCwd);
    }
    const fromRoot = path.resolve(this.workspaceFolder.uri.fsPath, file);
    if (existsFile(fromRoot)) {
      return vscode.Uri.file(fromRoot);
    }
    return undefined;
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
