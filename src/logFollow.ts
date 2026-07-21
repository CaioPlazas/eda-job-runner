import * as vscode from 'vscode';
import { JobRunner } from './jobRunner';

/**
 * Auto-scrolls an open log editor to the last line as new output arrives,
 * for whichever job was most recently told to be "followed". Only one job
 * is meaningfully followable at a time since only one job can run at once.
 */
export class LogFollowController implements vscode.Disposable {
  private followedJobId: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly jobRunner: JobRunner) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChanged(e)),
      jobRunner.onDidChangeStatus(jobId => {
        if (jobId && jobId === this.followedJobId && this.jobRunner.getStatus(jobId).state !== 'running') {
          this.followedJobId = undefined;
        }
      })
    );
  }

  follow(jobId: string): void {
    this.followedJobId = jobId;
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
