import * as vscode from 'vscode';
import { JobRunner } from './jobRunner';
import { JobRunState } from './jobOutcome';

/**
 * A coloured status badge on each sidebar row.
 *
 * The extension cannot change the font VS Code renders the tree in -- there is
 * no API and no theme variable for it. What it can change is *which slot* the
 * status lives in. `TreeItem.description` is rendered both smaller than the
 * label and at reduced opacity, so the status text was the least legible thing
 * on screen; a `FileDecorationProvider` badge renders at full label opacity in
 * a real `ThemeColor` and is the one genuinely legible slot the tree API
 * offers. `statusText.ts`'s `describeStatusShort` trims the dim text to match.
 *
 * Rows opt in by setting `resourceUri` to `eda-job:<laneKey>` -- a synthetic
 * scheme owned entirely by this extension, matched on below so no other
 * provider's files are ever decorated. `treeProvider.ts` keeps `iconPath` set
 * on every row, which is what stops the file-icon theme claiming the icon once
 * a `resourceUri` is present.
 *
 * Like the tree itself, this listens to `onDidChangeStatus` and deliberately
 * NOT to `onDidTick`: a badge is a function of state alone, so a once-a-second
 * tick has nothing to repaint here either (see `statusText.ts`'s header for why
 * that rule exists).
 */
export const EDA_JOB_SCHEME = 'eda-job';

/** `eda-job:<laneKey>` for a row. `laneKey` is a job id or `<job id>::runN`, both already unique tree-wide. */
export function jobResourceUri(laneKey: string): vscode.Uri {
  return vscode.Uri.parse(`${EDA_JOB_SCHEME}:${laneKey}`, true);
}

/** Whether row decorations are switched on. Read live so the setting takes effect without a reload. */
export function sidebarBadgesEnabled(): boolean {
  return vscode.workspace.getConfiguration('eda-job-runner').get<boolean>('sidebarBadges', true);
}

// One character each: VS Code truncates a FileDecoration badge to two, and
// these sit immediately right of an already-coloured icon, so a single glyph
// reads better than a two-letter abbreviation. Colours mirror `iconForState`
// in treeProvider.ts -- they must stay in step, or a row's icon and its badge
// will disagree about how the run went.
const BADGES: Record<JobRunState, { badge: string; color: string; tooltip: string } | undefined> = {
  running: { badge: '▶', color: 'charts.blue', tooltip: 'Running' },
  passed: { badge: '✓', color: 'charts.green', tooltip: 'Passed' },
  failed: { badge: '✗', color: 'charts.red', tooltip: 'Failed' },
  killed: { badge: '■', color: 'charts.orange', tooltip: 'Stopped' },
  idle: undefined
};

export class EdaJobDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly jobRunner: JobRunner) {
    this.disposables.push(
      // Undefined means "re-ask about everything", which is what a status
      // change needs: a job finishing also changes its group row's badge.
      jobRunner.onDidChangeStatus(() => this._onDidChange.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('eda-job-runner.sidebarBadges')) {
          this._onDidChange.fire(undefined);
        }
      })
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== EDA_JOB_SCHEME || !sidebarBadgesEnabled()) {
      return undefined;
    }
    // `Uri.parse('eda-job:a::b')` puts everything after the colon in `path`.
    const laneKey = uri.path;
    const jobId = laneKey.includes('::') ? laneKey.slice(0, laneKey.indexOf('::')) : laneKey;
    const state = laneKey.includes('::')
      ? this.jobRunner.getLanes(jobId).find(l => l.laneKey === laneKey)?.status.state
      : this.groupOrJobState(jobId);
    const entry = state ? BADGES[state] : undefined;
    if (!entry) {
      return undefined;
    }
    return {
      badge: entry.badge,
      color: new vscode.ThemeColor(entry.color),
      tooltip: entry.tooltip
    };
  }

  /**
   * A row that renders as a group (more than one tracked run) has no single
   * status of its own, so summarise its lanes the same way `JobGroupTreeItem`
   * summarises them for its own icon: anything still running wins, then any
   * failure, then killed, then passed.
   */
  private groupOrJobState(jobId: string): JobRunState | undefined {
    const lanes = this.jobRunner.getLanes(jobId);
    if (lanes.length === 0) {
      return this.jobRunner.getStatus(jobId).state;
    }
    const states = lanes.map(l => l.status.state);
    if (states.includes('running')) {
      return 'running';
    }
    if (states.includes('failed')) {
      return 'failed';
    }
    if (states.includes('killed')) {
      return 'killed';
    }
    return states.includes('passed') ? 'passed' : undefined;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }
}
