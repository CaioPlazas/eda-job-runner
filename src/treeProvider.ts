import * as vscode from 'vscode';
import { JobStore } from './jobStore';
import { JobRunner, JobRunStatus } from './jobRunner';
import { JobDefinition } from './types';
import { describeStatus, describeStatusLong, describeLiveProgress, formatDuration } from './statusText';

// formatDuration used to live here; re-exported so existing importers
// (statusBar.ts, extension.ts) keep working while its definition sits in the
// pure module that can actually be unit-tested.
export { formatDuration };

/**
 * One tree row for a single run. For a job that has never had more than one
 * tracked run (the common case), this is the job's only row: clicking it
 * opens Configure, with "Open Log" moved to the inline icon on the right
 * (swapped back from the log-on-click / gear-for-Configure arrangement).
 * When it's a lane inside a JobGroupTreeItem (`laneKey !== job.id`), it
 * represents one specific run (a sequential repeat-count iteration, or a
 * concurrent extra instance) — clicking it still opens that run's own log,
 * since "configure" is a job-level action, not something a single run has.
 */
export class JobTreeItem extends vscode.TreeItem {
  public readonly isLane: boolean;

  constructor(public readonly job: JobDefinition, public readonly status: JobRunStatus, public readonly laneKey: string) {
    const isLane = laneKey !== job.id;
    super(isLane ? status.laneLabel ?? laneKey : job.name, vscode.TreeItemCollapsibleState.None);
    this.isLane = isLane;
    // A lane's key is already `job.id::runN`, so it's unique tree-wide. Without
    // an id VS Code can't tell one refresh's lane rows from the next's and
    // treats them all as new, dropping selection and scroll position.
    this.id = isLane ? laneKey : job.id;
    const statusText = describeStatus(status);
    this.description = !isLane && job.default ? `★ default${statusText ? ` · ${statusText}` : ''}` : statusText;
    const defaultNote = !isLane && job.default ? '\n\n★ **Default job** — runs on F5 / "EDA: Run Default Job".' : '';
    // A running row's tooltip is deliberately left undefined and filled in by
    // JobTreeProvider.resolveTreeItem on hover: it's the one place elapsed
    // time and live counts still appear, and resolving it on demand is what
    // lets the row itself stay completely static (see statusText.ts). VS Code
    // only resolves properties that are undefined, so this must not be set here.
    this.tooltip =
      status.state === 'running'
        ? undefined
        : new vscode.MarkdownString(
            isLane
              ? `**${job.name} — run ${status.laneLabel ?? laneKey}**\n\n${describeStatusLong(status)}`
              : `**${job.name}**\n\n\`${job.command}\`\n\ncwd: \`${job.cwd}\`${defaultNote}\n\n${describeStatusLong(status)}`
          );
    this.contextValue = isLane ? `edaJobRun-${status.state}` : `edaJob-${status.state}`;
    this.iconPath = iconForState(status);
    this.command = isLane
      ? { command: 'eda-job-runner.openLog', title: 'Open Log', arguments: [this] }
      : { command: 'eda-job-runner.configureJob', title: 'Configure', arguments: [this] };
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
  constructor(
    public readonly job: JobDefinition,
    lanes: { laneKey: string; status: JobRunStatus }[],
    // Expanded unless the user collapsed this group -- hardcoding Expanded
    // meant every refresh popped a group the user had just closed back open.
    expanded = true
  ) {
    super(job.name, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
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
  /** `expanded` — see JobGroupTreeItem's own note; a collapsed folder must stay collapsed across a refresh. */
  constructor(public readonly folderName: string, jobCount: number, expanded = true) {
    super(folderName, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `folder:${folderName}`;
    this.description = `${jobCount} job${jobCount === 1 ? '' : 's'}`;
    this.contextValue = 'edaFolder';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

export type EdaTreeElement = JobTreeItem | JobGroupTreeItem;
export type EdaTreeNode = EdaTreeElement | FolderTreeItem;

/**
 * How long a refresh waits for others to join it. Long enough to collapse a
 * burst (a folder run's jobs starting and finishing, a repeat-count batch's
 * iterations) into one redraw, short enough to be imperceptible.
 */
const REFRESH_DEBOUNCE_MS = 100;

export class JobTreeProvider implements vscode.TreeDataProvider<EdaTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  /**
   * Whether the sidebar is actually on screen (see `bindView`). Refreshes that
   * land while it's hidden are collapsed into a single one on the way back in.
   * Undefined until bound, which reads as "assume visible".
   */
  private viewVisible: boolean | undefined;
  /** A refresh that was skipped while hidden, to be replayed on the way back in. */
  private missedRefresh = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Groups/folders the user has collapsed, by tree item id. Tracked from the
   * view's own expand/collapse events because `collapsibleState` is baked into
   * each rebuilt item -- without this, any refresh re-expands them.
   */
  private readonly collapsed = new Set<string>();

  constructor(private readonly jobStore: JobStore, private readonly jobRunner: JobRunner) {
    jobStore.onDidChangeJobs(() => this.refresh());
    // Deliberately NOT subscribed to jobRunner.onDidTick: that fires once a
    // second for as long as anything is running, and a tree row's text no
    // longer contains anything that changes on its own (see statusText.ts), so
    // there is nothing for a tick to repaint. The status bar owns the live
    // elapsed/counts display; hovering a row resolves its own live tooltip.
    jobRunner.onDidChangeStatus(() => this.refresh());
  }

  /**
   * Wires this provider to its TreeView (visibility + expand/collapse state).
   * Called from activate() right after createTreeView, since a provider can't
   * reach its own view.
   */
  bindView(view: vscode.TreeView<EdaTreeNode>, disposables: vscode.Disposable[]): void {
    this.viewVisible = view.visible;
    disposables.push(
      view.onDidChangeVisibility(e => {
        this.viewVisible = e.visible;
        if (e.visible && this.missedRefresh) {
          this.missedRefresh = false;
          this._onDidChangeTreeData.fire();
        }
      }),
      view.onDidCollapseElement(e => {
        if (e.element.id) {
          this.collapsed.add(e.element.id);
        }
      }),
      view.onDidExpandElement(e => {
        if (e.element.id) {
          this.collapsed.delete(e.element.id);
        }
      })
    );
  }

  private refresh(): void {
    if (this.viewVisible === false) {
      this.missedRefresh = true;
      return;
    }
    if (this.refreshTimer) {
      return; // one is already pending; it will pick this change up too
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this._onDidChangeTreeData.fire();
    }, REFRESH_DEBOUNCE_MS);
  }

  getTreeItem(element: EdaTreeNode): vscode.TreeItem {
    return element;
  }

  /**
   * Fills in a running row's tooltip at the moment it's hovered. This is the
   * one place elapsed time and in-progress error counts still appear in the
   * tree, and building it on demand is exactly what lets the row itself stay
   * static all run long. Status is re-read here rather than taken from the
   * (possibly minutes-old) item, so the numbers are current.
   */
  resolveTreeItem(item: vscode.TreeItem, element: EdaTreeNode): vscode.TreeItem {
    if (!(element instanceof JobTreeItem) || element.status.state !== 'running') {
      return item;
    }
    const status = element.isLane
      ? this.jobRunner.getLanes(element.job.id).find(l => l.laneKey === element.laneKey)?.status
      : this.jobRunner.getStatus(element.job.id);
    if (!status || status.state !== 'running') {
      return item;
    }
    const { job } = element;
    const header = element.isLane ? `**${job.name} — run ${status.laneLabel ?? element.laneKey}**` : `**${job.name}**`;
    const body = element.isLane ? '' : `\n\n\`${job.command}\`\n\ncwd: \`${job.cwd}\``;
    item.tooltip = new vscode.MarkdownString(
      `${header}${body}\n\n${describeLiveProgress(status, Date.now())}\n\n${describeStatusLong(status)}`
    );
    return item;
  }

  getChildren(element?: EdaTreeNode): EdaTreeNode[] {
    if (element instanceof FolderTreeItem) {
      return this.toTreeItems(this.jobStore.getJobsInFolder(element.folderName));
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
    const folderItems = folders.map(
      name => new FolderTreeItem(name, this.jobStore.getJobsInFolder(name).length, !this.collapsed.has(`folder:${name}`))
    );
    const knownFolders = new Set(folders);
    const ungrouped = jobs.filter(j => !j.folder || !knownFolders.has(j.folder));
    return [...folderItems, ...this.toTreeItems(ungrouped)];
  }

  private toTreeItems(jobs: JobDefinition[]): EdaTreeElement[] {
    return jobs.map(job => {
      const lanes = this.jobRunner.getLanes(job.id);
      return lanes.length > 0
        ? new JobGroupTreeItem(job, lanes, !this.collapsed.has(job.id))
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
