import * as vscode from 'vscode';
import { JobStore } from './jobStore';
import { JobRunner, JobRunStatus } from './jobRunner';
import { JobDefinition } from './types';

/**
 * One tree row for a single run. For a job that has never had more than one
 * tracked run (the common case), this is the job's only row and behaves
 * exactly as before this feature existed: clicking it opens Configure.
 * When it's a lane inside a JobGroupTreeItem (`laneKey !== job.id`), it
 * represents one specific run (a sequential repeat-count iteration, or a
 * concurrent extra instance) — clicking it opens that run's own log instead,
 * since "configure" is a job-level action available on the group header.
 */
export class JobTreeItem extends vscode.TreeItem {
  public readonly isLane: boolean;

  constructor(public readonly job: JobDefinition, public readonly status: JobRunStatus, public readonly laneKey: string) {
    const isLane = laneKey !== job.id;
    super(isLane ? status.laneLabel ?? laneKey : job.name, vscode.TreeItemCollapsibleState.None);
    this.isLane = isLane;
    if (!isLane) {
      this.id = job.id;
    }
    const statusText = describeStatus(status);
    this.description = !isLane && job.default ? `★ default${statusText ? ` · ${statusText}` : ''}` : statusText;
    const defaultNote = !isLane && job.default ? '\n\n★ **Default job** — runs on F5 / "EDA: Run Default Job".' : '';
    this.tooltip = new vscode.MarkdownString(
      isLane
        ? `**${job.name} — run ${status.laneLabel ?? laneKey}**\n\n${describeStatusLong(status)}`
        : `**${job.name}**\n\n\`${job.command}\`\n\ncwd: \`${job.cwd}\`${defaultNote}\n\n${describeStatusLong(status)}`
    );
    this.contextValue = isLane ? `edaJobRun-${status.state}` : `edaJob-${status.state}`;
    this.iconPath = iconForState(status);
    this.command = isLane
      ? { command: 'eda-job-runner.openLog', title: 'Open Log', arguments: [this] }
      : { command: 'eda-job-runner.configureJob', title: 'Configure Job', arguments: [this] };
  }
}

/**
 * A job's parent row once it has more than one tracked run — a sequential
 * repeat-count batch, or a concurrent extra instance (both require
 * `eda-job-runner.experimentalMultipleRuns` or a job's own repeat count).
 * Expands to one JobTreeItem child per run. Jobs that have only ever run
 * one instance at a time never produce one of these.
 */
export class JobGroupTreeItem extends vscode.TreeItem {
  constructor(public readonly job: JobDefinition, lanes: { laneKey: string; status: JobRunStatus }[]) {
    super(job.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = job.id;
    const running = lanes.filter(l => l.status.state === 'running').length;
    const passed = lanes.filter(l => l.status.state === 'passed').length;
    const failed = lanes.filter(l => l.status.state === 'failed').length;
    const killed = lanes.filter(l => l.status.state === 'killed').length;
    const parts: string[] = [];
    if (running) {
      parts.push(`${running} running`);
    }
    if (passed) {
      parts.push(`${passed} passed`);
    }
    if (failed) {
      parts.push(`${failed} failed`);
    }
    if (killed) {
      parts.push(`${killed} killed`);
    }
    this.description = (job.default ? '★ default · ' : '') + (parts.join(' · ') || `${lanes.length} runs`);
    this.tooltip = new vscode.MarkdownString(
      `**${job.name}**\n\n\`${job.command}\`\n\ncwd: \`${job.cwd}\`\n\n${lanes.length} tracked runs — expand to see each.`
    );
    this.contextValue = `edaJobGroup-${running > 0 ? 'running' : 'idle'}`;
    this.iconPath =
      running > 0
        ? new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'))
        : failed > 0
          ? new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
          : new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.blue'));
  }
}

/**
 * A single flat grouping level in the sidebar (e.g. "Compile", "Simulation
 * ADDER") -- not a nested tree. Jobs opt into one by name via
 * `JobDefinition.folder`; a folder can exist with zero jobs (created ahead
 * of time) since folder names are tracked independently in `JobsFile.folders`.
 */
export class FolderTreeItem extends vscode.TreeItem {
  constructor(public readonly folderName: string, jobCount: number) {
    super(folderName, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${folderName}`;
    this.description = `${jobCount} job${jobCount === 1 ? '' : 's'}`;
    this.contextValue = 'edaFolder';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

export type EdaTreeElement = JobTreeItem | JobGroupTreeItem;
export type EdaTreeNode = EdaTreeElement | FolderTreeItem;

export class JobTreeProvider implements vscode.TreeDataProvider<EdaTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly jobStore: JobStore, private readonly jobRunner: JobRunner) {
    jobStore.onDidChangeJobs(() => this._onDidChangeTreeData.fire());
    jobRunner.onDidChangeStatus(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: EdaTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: EdaTreeNode): EdaTreeNode[] {
    if (element instanceof FolderTreeItem) {
      return this.toTreeItems(this.jobStore.getJobs().filter(j => j.folder === element.folderName));
    }
    if (element instanceof JobGroupTreeItem) {
      return this.jobRunner
        .getLanes(element.job.id)
        .map(({ laneKey, status }) => new JobTreeItem(element.job, status, laneKey));
    }
    if (element) {
      return []; // a leaf JobTreeItem -- never expandable, but handle defensively
    }

    const folders = this.jobStore.getFolders();
    const jobs = this.jobStore.getJobs();
    const folderItems = folders.map(name => new FolderTreeItem(name, jobs.filter(j => j.folder === name).length));
    const knownFolders = new Set(folders);
    const ungrouped = jobs.filter(j => !j.folder || !knownFolders.has(j.folder));
    return [...folderItems, ...this.toTreeItems(ungrouped)];
  }

  private toTreeItems(jobs: JobDefinition[]): EdaTreeElement[] {
    return jobs.map(job => {
      const lanes = this.jobRunner.getLanes(job.id);
      return lanes.length > 0
        ? new JobGroupTreeItem(job, lanes)
        : new JobTreeItem(job, this.jobRunner.getStatus(job.id), job.id);
    });
  }
}

/**
 * Drag-and-drop reordering in the sidebar, for both jobs and folders. A whole
 * job is draggable -- whether it renders as a plain row (`JobTreeItem`) or,
 * once it has more than one tracked run, as an expandable group
 * (`JobGroupTreeItem`) -- and so is a `FolderTreeItem` itself, to reorder
 * folders relative to each other. A run-lane inside an expanded group isn't
 * an independent job, so it isn't draggable. The single shared MIME payload
 * carries a small `{kind, value}` tag so a drop handler can tell a dragged
 * job apart from a dragged folder.
 *
 * Job drop targets: a folder header appends the job to that folder; a
 * job/job-group inserts before it, in that item's folder; anywhere else (the
 * empty area below the tree) moves it to the root/ungrouped list.
 *
 * Folder drop targets: another folder inserts the dragged folder before it;
 * anywhere else appends it to the end of the folder list. Dropping a folder
 * on a job/job-group is ignored (folders only reorder among themselves).
 */
interface DragPayload {
  kind: 'job' | 'folder';
  value: string;
}

export class EdaTreeDragAndDropController implements vscode.TreeDragAndDropController<EdaTreeNode> {
  readonly dropMimeTypes = ['application/vnd.code.tree.edajobrunnerview'];
  readonly dragMimeTypes = ['application/vnd.code.tree.edajobrunnerview'];

  constructor(private readonly jobStore: JobStore) {}

  handleDrag(source: readonly EdaTreeNode[], dataTransfer: vscode.DataTransfer): void {
    const folderNode = source.find((n): n is FolderTreeItem => n instanceof FolderTreeItem);
    if (folderNode) {
      const payload: DragPayload = { kind: 'folder', value: folderNode.folderName };
      dataTransfer.set('application/vnd.code.tree.edajobrunnerview', new vscode.DataTransferItem(JSON.stringify(payload)));
      return;
    }
    const jobNode = source.find(
      (n): n is JobTreeItem | JobGroupTreeItem =>
        (n instanceof JobTreeItem && !n.isLane) || n instanceof JobGroupTreeItem
    );
    if (!jobNode) {
      return;
    }
    const payload: DragPayload = { kind: 'job', value: jobNode.job.id };
    dataTransfer.set('application/vnd.code.tree.edajobrunnerview', new vscode.DataTransferItem(JSON.stringify(payload)));
  }

  async handleDrop(target: EdaTreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const transferItem = dataTransfer.get('application/vnd.code.tree.edajobrunnerview');
    if (!transferItem) {
      return;
    }
    let payload: DragPayload;
    try {
      payload = JSON.parse(transferItem.value as string) as DragPayload;
    } catch {
      return;
    }

    if (payload.kind === 'folder') {
      if (target instanceof FolderTreeItem) {
        if (target.folderName === payload.value) {
          return;
        }
        await this.jobStore.reorderFolder(payload.value, target.folderName);
      } else if (!target) {
        await this.jobStore.reorderFolder(payload.value, undefined);
      }
      // Dropping a dragged folder on a job/group is a no-op -- folders only reorder among themselves.
      return;
    }

    const draggedId = payload.value;
    if (target instanceof FolderTreeItem) {
      await this.jobStore.reorderJob(draggedId, undefined, target.folderName);
    } else if (target instanceof JobTreeItem && !target.isLane) {
      if (target.job.id === draggedId) {
        return;
      }
      await this.jobStore.reorderJob(draggedId, target.job.id, target.job.folder);
    } else if (target instanceof JobGroupTreeItem) {
      if (target.job.id === draggedId) {
        return;
      }
      await this.jobStore.reorderJob(draggedId, target.job.id, target.job.folder);
    } else {
      await this.jobStore.reorderJob(draggedId, undefined, undefined);
    }
  }
}

function iconForState(status: JobRunStatus): vscode.ThemeIcon {
  switch (status.state) {
    case 'running':
      // A job that's detached but not yet reattached has no live capture at
      // all (the frozen "lost track" state); one that's been reattached is
      // actively re-tailing its log again, so it gets the normal running
      // look back rather than looking permanently disconnected.
      return status.detached && !status.reattached
        ? new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('charts.yellow'))
        : new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    case 'passed':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'killed':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.orange'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

function describeStatus(status: JobRunStatus): string {
  switch (status.state) {
    case 'running': {
      const elapsed = formatDuration(Date.now() - (status.startTime ?? Date.now()));
      const base = status.reattached
        ? `running (resumed) ${elapsed}`
        : status.detached
          ? `running (detached) ${elapsed}`
          : `running ${elapsed}`;
      return base + countSuffix(status);
    }
    case 'passed':
      return `passed (${formatDuration((status.endTime ?? 0) - (status.startTime ?? 0))})` + countSuffix(status);
    case 'failed': {
      const reason = status.exitCode === 0 && (status.errorCount ?? 0) > 0 ? 'log errors' : `exit ${status.exitCode ?? '?'}`;
      return reason + countSuffix(status);
    }
    case 'killed':
      return 'killed';
    default:
      return '';
  }
}

/** " · 2✗ 1⚠" style suffix, omitting zero counts. */
function countSuffix(status: JobRunStatus): string {
  const errs = status.errorCount ?? 0;
  const warns = status.warningCount ?? 0;
  if (!errs && !warns) {
    return '';
  }
  const parts: string[] = [];
  if (errs) {
    parts.push(`${errs}✗`);
  }
  if (warns) {
    parts.push(`${warns}⚠`);
  }
  return ` · ${parts.join(' ')}`;
}

function describeStatusLong(status: JobRunStatus): string {
  if (status.state === 'idle') {
    return '_Never run in this session._';
  }
  const parts = [`status: **${status.state}**`];
  if (status.reattached) {
    parts.push('_Resumed live tailing after a window reload — log, counts, and Problems keep updating as normal._');
  } else if (status.detached) {
    parts.push(
      '_Lost track of this job across a window reload — still running detached. ' +
        'Stop still works; check its log directly for progress._'
    );
  }
  if (status.exitCode !== undefined && status.exitCode !== null) {
    parts.push(`exit code: ${status.exitCode}`);
  }
  if (status.signal) {
    parts.push(`signal: ${status.signal}`);
  }
  return parts.join('\n\n');
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
}
