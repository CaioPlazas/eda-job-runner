import * as vscode from 'vscode';
import { JobStore } from './jobStore';
import { JobRunner, JobRunStatus } from './jobRunner';
import { JobDefinition } from './types';
import { formatDuration } from './treeProvider';

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly jobStore: JobStore, private readonly jobRunner: JobRunner) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'workbench.view.extension.eda-job-runner';
    this.disposables.push(this.item, jobStore.onDidChangeJobs(() => this.refresh()), jobRunner.onDidChangeStatus(() => this.refresh()));
    this.refresh();
  }

  private refresh(): void {
    // Mirror the tree's model: a job with tracked lanes is represented by
    // those lanes (its primary run is itself one of them — as a lane-group
    // member for a concurrent extra, or an iteration entry for a repeat-count
    // batch), a job without lanes by its single status. Counting both would
    // double-count the running run and, when only a non-primary lane is
    // running, the old "find the running primary" display hid the bar entirely.
    const running: { job: JobDefinition; status: JobRunStatus }[] = [];
    for (const job of this.jobStore.getJobs()) {
      const lanes = this.jobRunner.getLanes(job.id);
      if (lanes.length > 0) {
        for (const lane of lanes) {
          if (lane.status.state === 'running') {
            running.push({ job, status: lane.status });
          }
        }
      } else if (this.jobRunner.getStatus(job.id).state === 'running') {
        running.push({ job, status: this.jobRunner.getStatus(job.id) });
      }
    }

    if (running.length === 0) {
      this.item.hide();
      return;
    }
    if (running.length > 1) {
      this.item.text = `$(sync~spin) ${running.length} jobs running`;
      this.item.tooltip = 'EDA Job Runner: multiple jobs running — click to open the sidebar';
      this.item.show();
      return;
    }

    const { job, status } = running[0];
    const elapsed = formatDuration(Date.now() - (status.startTime ?? Date.now()));
    const suffix = status.reattached ? ' (resumed)' : status.detached ? ' (detached)' : '';
    const laneNote = status.laneLabel ? ` (${status.laneLabel})` : '';
    const errs = status.errorCount ?? 0;
    const warns = status.warningCount ?? 0;
    const counts = errs || warns ? ` ${errs ? `$(error) ${errs}` : ''}${warns ? ` $(warning) ${warns}` : ''}` : '';
    this.item.text = `$(sync~spin) ${job.name}${laneNote} ${elapsed}${suffix}${counts}`;
    this.item.tooltip = `EDA Job Runner: "${job.name}" is running — click to open the sidebar`;
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
