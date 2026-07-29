import * as vscode from 'vscode';
import { JobRunner } from './jobRunner';

const FOLLOWED_JOB_STORAGE_KEY = 'eda-job-runner.followedJobId';

/**
 * Auto-scrolls an open log editor to the last line as new output arrives,
 * for whichever job was most recently told to be "followed". Only one job
 * is meaningfully followable at a time since only one job can run at once.
 */
export class LogFollowController implements vscode.Disposable {
  private followedJobId: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly jobRunner: JobRunner,
    private readonly memento: vscode.Memento
  ) {
    // Restore a follow that was in progress when the window reloaded --
    // JobRunner's own constructor already reconstructed `status.state` from
    // a still-alive pid by the time this runs (see its own constructor),
    // so this doesn't need to wait for beginReattachment. A job that's no
    // longer running (or was deleted) just drops the stale stored id.
    const storedJobId = memento.get<string>(FOLLOWED_JOB_STORAGE_KEY);
    if (storedJobId && jobRunner.getStatus(storedJobId).state === 'running') {
      this.followedJobId = storedJobId;
    } else if (storedJobId) {
      void memento.update(FOLLOWED_JOB_STORAGE_KEY, undefined);
    }

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChanged(e)),
      jobRunner.onDidChangeStatus(jobId => {
        if (jobId && jobId === this.followedJobId && this.jobRunner.getStatus(jobId).state !== 'running') {
          this.followedJobId = undefined;
          void this.memento.update(FOLLOWED_JOB_STORAGE_KEY, undefined);
        }
      })
    );
  }

  follow(jobId: string): void {
    this.followedJobId = jobId;
    void this.memento.update(FOLLOWED_JOB_STORAGE_KEY, jobId);
  }

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (!this.followedJobId) {
      return;
    }
    const logPath = this.jobRunner.getStatus(this.followedJobId).logPath;
    if (!logPath || e.document.uri.fsPath !== logPath) {
      return;
    }
    const lastLine = Math.max(0, e.document.lineCount - 1);
    const range = new vscode.Range(lastLine, 0, lastLine, 0);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === e.document) {
        editor.revealRange(range, vscode.TextEditorRevealType.Default);
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
