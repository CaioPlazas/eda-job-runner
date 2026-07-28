import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JobStore } from './jobStore';
import { JobRunner, JobRunStatus, BatchSummary } from './jobRunner';
import { LogManager } from './logManager';
import { LogDiagnostics } from './logDiagnostics';
import { LogFollowController } from './logFollow';
import { StatusBarController } from './statusBar';
import { JobConfigPanel } from './jobConfigPanel';
import { ShellEnvPanel } from './shellEnvPanel';
import { ParamsPanel } from './paramsPanel';
import { LogViewerPanel } from './logViewerPanel';
import { LogLiveView } from './logLiveView';
import { substituteVars } from './shellInvocation';
import {
  EdaTreeDragAndDropController,
  EdaTreeElement,
  FolderTreeItem,
  JobGroupTreeItem,
  JobTreeItem,
  JobTreeProvider,
  formatDuration
} from './treeProvider';
import { JobDefinition, JobTemplate } from './types';
import { ToolStore } from './toolStore';
import { ToolSetupPanel } from './toolSetupPanel';
import { scanTool, scanAllLists } from './toolIntrospect';
import { planListMigration } from './listMigration';
import { createExampleJobs } from './exampleJobs';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    // No workspace open: the view's viewsWelcome content explains this, nothing to wire up.
    return;
  }

  const jobStore = new JobStore(folder);
  context.subscriptions.push(jobStore);

  const toolStore = new ToolStore(folder);
  context.subscriptions.push(toolStore);

  const logManager = new LogManager(folder, context.workspaceState);
  const logDiagnostics = new LogDiagnostics(folder);
  context.subscriptions.push(logDiagnostics);
  const jobRunner = new JobRunner(
    folder,
    logManager,
    () => jobStore.getSetup(),
    () => jobStore.getParams(),
    context.workspaceState,
    logDiagnostics
  );
  context.subscriptions.push(jobRunner);

  const treeProvider = new JobTreeProvider(jobStore, jobRunner);
  const treeView = vscode.window.createTreeView('edaJobRunnerView', {
    treeDataProvider: treeProvider,
    dragAndDropController: new EdaTreeDragAndDropController(jobStore)
  });
  context.subscriptions.push(treeView);

  const statusBar = new StatusBarController(jobStore, jobRunner);
  context.subscriptions.push(statusBar);

  const logFollow = new LogFollowController(jobRunner);
  context.subscriptions.push(logFollow);

  void migrateMaxConcurrentJobs(folder);

  const updateContextKeys = () => {
    // Gates the F5 keybinding: F5 only runs the default EDA job when this
    // workspace actually has one set, so debugging is unaffected otherwise.
    void vscode.commands.executeCommand('setContext', 'edaJobRunner.hasDefaultJob', !!jobStore.getDefaultJob());
  };
  updateContextKeys();

  context.subscriptions.push(
    jobStore.onDidChangeJobs(updateContextKeys),
    jobRunner.onDidChangeStatus(jobId => {
      if (jobId) {
        notifyOnCompletion(jobStore, jobRunner, jobId);
      }
    }),
    jobRunner.onDidCompleteBatch(summary => notifyOnBatchCompletion(summary))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('eda-job-runner.addJob', () => addJob(jobStore, toolStore, folder, jobRunner, context)),
    vscode.commands.registerCommand('eda-job-runner.configureJob', (item: EdaTreeElement) =>
      item ? JobConfigPanel.createOrShow(jobStore, toolStore, folder, jobRunner, context, item.job) : undefined
    ),
    vscode.commands.registerCommand('eda-job-runner.deleteJob', (item: EdaTreeElement) => deleteJob(jobStore, item)),
    vscode.commands.registerCommand('eda-job-runner.saveJobAsTemplate', (item: EdaTreeElement) => saveJobAsTemplate(jobStore, item)),
    vscode.commands.registerCommand('eda-job-runner.duplicateJob', (item: EdaTreeElement) =>
      jobStore.duplicateJob(item.job.id)
    ),
    vscode.commands.registerCommand('eda-job-runner.refresh', () => jobStore.load()),
    vscode.commands.registerCommand('eda-job-runner.configureShell', () => ShellEnvPanel.createOrShow(jobStore, toolStore, folder, logManager, jobRunner, context)),
    vscode.commands.registerCommand('eda-job-runner.configureTools', () => ToolSetupPanel.createOrShow(toolStore, jobStore, folder, jobRunner, context)),
    vscode.commands.registerCommand('eda-job-runner.configureParams', () => ParamsPanel.createOrShow(jobStore, toolStore, folder, jobRunner, context)),
    vscode.commands.registerCommand('eda-job-runner.refreshValueLists', () => refreshValueLists(jobStore, folder)),
    vscode.commands.registerCommand('eda-job-runner.createExampleJobs', () => createExampleJobs(jobStore)),
    vscode.commands.registerCommand('eda-job-runner.openLogViewer', () => LogViewerPanel.createOrShow(jobStore, logManager, toolStore)),
    vscode.commands.registerCommand('eda-job-runner.addFolder', () => addFolder(jobStore)),
    vscode.commands.registerCommand('eda-job-runner.addJobInFolder', (item: FolderTreeItem) =>
      item ? JobConfigPanel.createOrShow(jobStore, toolStore, folder, jobRunner, context, undefined, item.folderName) : undefined
    ),
    vscode.commands.registerCommand('eda-job-runner.renameFolder', (item: FolderTreeItem) => renameFolder(jobStore, item)),
    vscode.commands.registerCommand('eda-job-runner.deleteFolder', (item: FolderTreeItem) => deleteFolder(jobStore, item)),
    vscode.commands.registerCommand('eda-job-runner.runFolder', (item: FolderTreeItem) => runFolder(jobStore, jobRunner, item)),
    vscode.commands.registerCommand('eda-job-runner.stopFolder', (item: FolderTreeItem) => stopFolder(jobStore, jobRunner, item)),
    vscode.commands.registerCommand('eda-job-runner.moveJobToFolder', (item: EdaTreeElement) => moveJobToFolder(jobStore, item)),
    vscode.commands.registerCommand('eda-job-runner.runDefaultJob', () => {
      const def = jobStore.getDefaultJob();
      if (!def) {
        void vscode.window.showInformationMessage(
          'No default EDA job set for this workspace. Configure a job and check "Default job for this workspace".'
        );
        return;
      }
      return jobRunner.run(def);
    }),
    // Works uniformly for a plain job and a job-group header (starts a fresh
    // repeat-count batch once the previous one has finished) — jobRunner.run()
    // no-ops with an "already running" message if this exact job is still
    // mid-run, regardless of experimentalMultipleRuns (that setting only ever
    // gates two *different* jobs running side by side).
    vscode.commands.registerCommand('eda-job-runner.runJob', (item: JobTreeItem | JobGroupTreeItem) =>
      jobRunner.run(item.job)
    ),
    // item.laneKey equals item.job.id for a plain/primary run, so this is
    // unchanged for the common single-run case.
    vscode.commands.registerCommand('eda-job-runner.stopJob', (item: JobTreeItem) =>
      jobRunner.stop(item.job.id, item.laneKey)
    ),
    // Replays this exact row's last resolved command (its ${param:...}/
    // ${randomSeed} placeholders already substituted) verbatim -- no new
    // prompt, no fresh seed, always a single run.
    vscode.commands.registerCommand('eda-job-runner.reRunLast', (item: JobTreeItem) => {
      if (!item) {
        return;
      }
      const resolvedCommand = item.status.resolvedCommand;
      if (!resolvedCommand) {
        void vscode.window.showInformationMessage(`No previous run to reuse for "${item.job.name}" yet — run it once first.`);
        return;
      }
      return jobRunner.run(item.job, { forcedCommand: resolvedCommand });
    }),
    vscode.commands.registerCommand('eda-job-runner.stopAllRuns', (item: JobGroupTreeItem) =>
      jobRunner.stopAllRuns(item.job.id)
    ),
    // Collapses a repeat-count batch's expandable group back to a flat
    // single-run row, without deleting the job -- a no-op while the batch
    // is still running (see clearLanes), which the menu also guards against
    // by only ever showing this on an idle group.
    vscode.commands.registerCommand('eda-job-runner.clearRunHistory', (item: JobGroupTreeItem) =>
      item ? jobRunner.clearLanes(item.job.id) : undefined
    ),
    // Opens this specific row's own log — the primary's latest run, or one
    // exact lane's log when invoked on a run inside a job group. `quiet`
    // (D1) is set by a plain click on a never-run row's default command --
    // it just selects the row instead of popping a "run it first" toast;
    // an explicit context-menu invocation always keeps the toast.
    vscode.commands.registerCommand('eda-job-runner.openLog', (item: JobTreeItem, options?: { quiet?: boolean }) =>
      item ? openLogForJob(item.job, item.status.logPath, options?.quiet ?? false) : undefined
    ),
    vscode.commands.registerCommand('eda-job-runner.openLogHistory', (item: EdaTreeElement) =>
      openLogHistory(logManager, item)
    ),
    vscode.commands.registerCommand('eda-job-runner.followLog', async (item: JobTreeItem) => {
      if (!item) {
        return;
      }
      logFollow.follow(item.job.id);
      await openLogForJob(item.job, item.status.logPath);
    }),
    vscode.commands.registerCommand('eda-job-runner.liveLog', (item: JobTreeItem) =>
      item ? openLiveLog(jobRunner, folder, item.job) : undefined
    )
  );

  void (async () => {
    await Promise.all([jobStore.load(), toolStore.load()]);
    jobRunner.beginReattachment(id => jobStore.getJob(id));
    await migrateLegacyToolLists(toolStore, jobStore);
    await rescanAllTools(toolStore, jobStore, folder);
  })();
}

/**
 * Re-scans every registered tool's `--help` output at activation (window
 * reload), in case the tool's own flags changed since it was last scanned.
 * Sequential, not parallel, to avoid a spawn storm if many tools are registered.
 */
async function rescanAllTools(toolStore: ToolStore, jobStore: JobStore, folder: vscode.WorkspaceFolder): Promise<void> {
  for (const tool of toolStore.getTools()) {
    const variants = await scanTool(tool, jobStore, folder);
    await toolStore.updateTool(tool.id, { variants, lastScanned: Date.now() });
  }
}

/**
 * One-time migration for a pre-global-lists workspace: a tool registered
 * before value lists moved to `JobsFile.lists` may still have its own
 * `lists` sitting in `.vscode/eda-tools.json` (captured by `ToolStore.load`
 * but no longer part of `ToolDefinition`). Move any such entries into the
 * new global list array via the pure `planListMigration` (inherits the
 * owning tool's `scanDir` when the list doesn't have its own; an existing
 * global always wins over a colliding legacy list; two legacy tools
 * colliding with EACH OTHER get the second one renamed instead of one
 * silently winning -- see that module's own doc comment for why the two
 * cases are handled differently). A rename requires rewriting the owning
 * tool's own `ToolOption.valueListName` occurrences and every job using
 * that tool's `optionListOverrides` values, both done below, before a
 * fresh persist of each migrated tool drops the stale key from disk so the
 * next load finds nothing left to migrate.
 */
async function migrateLegacyToolLists(toolStore: ToolStore, jobStore: JobStore): Promise<void> {
  const legacy = toolStore.takeLegacyLists();
  if (legacy.length === 0) {
    return;
  }
  const { lists, renames } = planListMigration(
    jobStore.getLists(),
    legacy.map(({ toolId, lists: toolLists }) => ({ toolId, toolScanDir: toolStore.getTool(toolId)?.scanDir, lists: toolLists }))
  );
  await jobStore.setLists(lists);

  for (const rename of renames) {
    const tool = toolStore.getTool(rename.toolId);
    if (tool) {
      const variants = tool.variants.map(v => ({
        ...v,
        options: v.options.map(o => (o.valueListName === rename.from ? { ...o, valueListName: rename.to } : o))
      }));
      await toolStore.updateTool(rename.toolId, { variants });
    }
    for (const job of jobStore.getJobs()) {
      if (job.toolId !== rename.toolId || !job.optionListOverrides) {
        continue;
      }
      const overrides = { ...job.optionListOverrides };
      let changed = false;
      for (const key of Object.keys(overrides)) {
        if (overrides[key] === rename.from) {
          overrides[key] = rename.to;
          changed = true;
        }
      }
      if (changed) {
        await jobStore.updateJob(job.id, { ...job, optionListOverrides: overrides });
      }
    }
  }

  for (const { toolId } of legacy) {
    await toolStore.updateTool(toolId, {});
  }
}

export function deactivate(): void {
  // Running jobs are detached child processes and are deliberately left running —
  // see JobRunner.dispose(). Nothing else needs explicit teardown.
}

async function deleteJob(jobStore: JobStore, item: EdaTreeElement): Promise<void> {
  if (!item) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(`Delete job "${item.job.name}"?`, { modal: true }, 'Delete');
  if (confirm === 'Delete') {
    await jobStore.deleteJob(item.job.id);
  }
}

// A blank Configure panel always opens first now -- templates are loaded
// from a dropdown inside the panel itself instead of a QuickPick shown
// before it existed, so they're visible/reachable without having to
// remember to pick one before the form was even on screen.
/**
 * One-time migration (T3.1): `experimentalMultipleRuns` is deprecated in
 * favor of `maxConcurrentJobs`, but only derives a value when the user
 * actually set the old boolean *and* hasn't touched the new setting --
 * nobody's current behavior changes silently just because they upgraded.
 * `false` (the old one-job-at-a-time default) -> `1`; `true` -> `0`
 * (unlimited), matching what each used to mean.
 */
async function migrateMaxConcurrentJobs(folder: vscode.WorkspaceFolder): Promise<void> {
  const config = vscode.workspace.getConfiguration('eda-job-runner', folder.uri);
  const maxConcurrentInspect = config.inspect<number>('maxConcurrentJobs');
  const maxConcurrentUntouched =
    maxConcurrentInspect?.workspaceValue === undefined &&
    maxConcurrentInspect?.globalValue === undefined &&
    maxConcurrentInspect?.workspaceFolderValue === undefined;
  if (!maxConcurrentUntouched) {
    return;
  }
  const legacyInspect = config.inspect<boolean>('experimentalMultipleRuns');
  const legacyValue = legacyInspect?.workspaceFolderValue ?? legacyInspect?.workspaceValue ?? legacyInspect?.globalValue;
  if (legacyValue === undefined) {
    return;
  }
  const target =
    legacyInspect?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : legacyInspect?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await config.update('maxConcurrentJobs', legacyValue ? 0 : 1, target);
}

function addJob(
  jobStore: JobStore,
  toolStore: ToolStore,
  folder: vscode.WorkspaceFolder,
  jobRunner: JobRunner,
  context: vscode.ExtensionContext
): void {
  JobConfigPanel.createOrShow(jobStore, toolStore, folder, jobRunner, context);
}

async function saveJobAsTemplate(jobStore: JobStore, item: EdaTreeElement): Promise<void> {
  if (!item) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Template name',
    value: item.job.name,
    validateInput: v => (v.trim() ? undefined : 'Name is required')
  });
  if (!name || !name.trim()) {
    return;
  }
  const trimmedName = name.trim();
  // addTemplate() replaces any existing template of the same name -- confirm
  // first, since two differently-configured jobs sharing a name (or
  // re-saving the same job later) could otherwise silently clobber an
  // earlier template with no way back.
  if (jobStore.getTemplates().some(t => t.name === trimmedName)) {
    const confirm = await vscode.window.showWarningMessage(
      `A template named "${trimmedName}" already exists. Overwrite it?`,
      { modal: true },
      'Overwrite'
    );
    if (confirm !== 'Overwrite') {
      return;
    }
  }
  const job = item.job;
  const template: JobTemplate = {
    name: trimmedName,
    namePattern: job.name,
    command: job.command,
    cwd: job.cwd,
    toolId: job.toolId,
    toolVariantLabel: job.toolVariantLabel,
    parseProblems: job.parseProblems,
    folder: job.folder
  };
  await jobStore.addTemplate(template);
  void vscode.window.showInformationMessage(`Saved template "${template.name}".`);
}

/**
 * Re-discovers every workspace-wide value list on demand -- lists stay
 * on-demand-only by design (see `toolIntrospect.ts`'s `scanAllLists` doc
 * comment): now that lists are workspace-global rather than tool-owned,
 * refreshing them inside a tool's own rescan would be the wrong axis, and
 * an activation-time refresh would spawn one arbitrary user command per
 * list on every window reload. This command, and the Parameters panel's
 * per-list ↻, are the only two refresh paths.
 */
async function refreshValueLists(jobStore: JobStore, folder: vscode.WorkspaceFolder): Promise<void> {
  // T4.3: housekeeping shouldn't outrank the main event -- a 40-minute job
  // run gets no progress notification at all, so refreshing a few value
  // lists doesn't deserve a modal-adjacent popup either. Window-location
  // progress renders as a quiet status-bar message instead.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'EDA Job Runner: refreshing value lists…' },
    async () => {
      const refreshed = await scanAllLists(jobStore.getLists(), jobStore, folder);
      await jobStore.setLists(refreshed);
    }
  );
}

async function addFolder(jobStore: JobStore): Promise<void> {
  const name = await vscode.window.showInputBox({ prompt: 'New folder name', placeHolder: 'e.g. Compile' });
  if (name && name.trim()) {
    await jobStore.addFolder(name);
  }
}

async function renameFolder(jobStore: JobStore, item: FolderTreeItem): Promise<void> {
  if (!item) {
    return;
  }
  const name = await vscode.window.showInputBox({ prompt: `Rename folder "${item.folderName}"`, value: item.folderName });
  if (name && name.trim() && name.trim() !== item.folderName) {
    await jobStore.renameFolder(item.folderName, name);
  }
}

async function deleteFolder(jobStore: JobStore, item: FolderTreeItem): Promise<void> {
  if (!item) {
    return;
  }
  const jobCount = jobStore.getJobsInFolder(item.folderName).length;
  if (jobCount === 0) {
    const confirm = await vscode.window.showWarningMessage(`Delete folder "${item.folderName}"?`, { modal: true }, 'Delete');
    if (confirm === 'Delete') {
      await jobStore.deleteFolder(item.folderName, true);
    }
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete folder "${item.folderName}" and permanently delete the ${jobCount} job${jobCount === 1 ? '' : 's'} inside it? This cannot be undone.`,
    { modal: true },
    'Delete folder & jobs'
  );
  if (confirm === 'Delete folder & jobs') {
    await jobStore.deleteFolder(item.folderName, true);
  }
}

/**
 * Runs every job in a folder one after another -- jobRunner.run() only
 * resolves once its job (or whole repeat-count batch) is completely
 * finished, so this plain sequential loop naturally never overlaps two
 * jobs, independent of experimentalMultipleRuns. A cancelled `${param:...}`
 * prompt just skips that one job; the loop continues.
 */
async function runFolder(jobStore: JobStore, jobRunner: JobRunner, item: FolderTreeItem): Promise<void> {
  if (!item) {
    return;
  }
  const jobs = jobStore.getJobsInFolder(item.folderName);
  for (const job of jobs) {
    await jobRunner.run(job);
  }
}

/** Stop every currently-running job in a folder (each job's own tracked lanes, via stopAllRuns). */
async function stopFolder(jobStore: JobStore, jobRunner: JobRunner, item: FolderTreeItem): Promise<void> {
  if (!item) {
    return;
  }
  const jobs = jobStore.getJobsInFolder(item.folderName);
  await Promise.all(jobs.map(job => jobRunner.stopAllRuns(job.id)));
}

async function moveJobToFolder(jobStore: JobStore, item: EdaTreeElement): Promise<void> {
  if (!item) {
    return;
  }
  const NONE = '(none — top level)';
  const NEW_FOLDER = '+ New folder…';
  const choice = await vscode.window.showQuickPick([NONE, ...jobStore.getFolders(), NEW_FOLDER], {
    title: `Move "${item.job.name}" to folder`,
    placeHolder: item.job.folder ?? NONE
  });
  if (!choice) {
    return;
  }
  if (choice === NEW_FOLDER) {
    const name = await vscode.window.showInputBox({ prompt: 'New folder name', placeHolder: 'e.g. Compile' });
    if (name && name.trim()) {
      await jobStore.moveJobToFolder(item.job.id, name.trim());
    }
    return;
  }
  await jobStore.moveJobToFolder(item.job.id, choice === NONE ? undefined : choice);
}

function openLiveLog(jobRunner: JobRunner, folder: vscode.WorkspaceFolder, job: JobDefinition): void {
  const workspaceRoot = folder.uri.fsPath;
  let filePath: string | undefined;
  if (job.logFile && job.logFile.trim().length > 0) {
    // An explicit external file (e.g. a scheduler's -o output) — resolve
    // ${workspaceFolder}, then anchor a relative path at the job's cwd.
    const resolved = substituteVars(job.logFile.trim(), workspaceRoot);
    const cwdAbs = path.resolve(workspaceRoot, job.cwd || '.');
    filePath = path.isAbsolute(resolved) ? resolved : path.resolve(cwdAbs, resolved);
  } else {
    filePath = jobRunner.getStatus(job.id).logPath;
  }
  if (!filePath) {
    void vscode.window.showInformationMessage(
      `No log to tail for "${job.name}" yet — run it first, or set a live log file in its config.`
    );
    return;
  }
  LogLiveView.show(job.name, filePath);
}

async function openLogForJob(job: JobDefinition, logPath: string | undefined, quiet = false): Promise<void> {
  if (!logPath) {
    if (!quiet) {
      void vscode.window.showInformationMessage(`No logs yet for "${job.name}" — run it first.`);
    }
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function openLogHistory(logManager: LogManager, item: EdaTreeElement): Promise<void> {
  if (!item) {
    return;
  }
  const runs = await logManager.listRuns(item.job.id, logManager.resolveRoot(item.job.logsDirectory));
  if (runs.length === 0) {
    void vscode.window.showInformationMessage(`No logs yet for "${item.job.name}" — run it first.`);
    return;
  }

  const picks = runs.map(logPath => ({
    label: path.basename(logPath, '.log'),
    description: formatFileSize(safeStatSize(logPath)),
    logPath
  }));

  const choice = await vscode.window.showQuickPick(picks, {
    title: `Log history — ${item.job.name}`,
    placeHolder: 'Select a past run to open'
  });
  if (!choice) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(choice.logPath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

function notifyOnCompletion(jobStore: JobStore, jobRunner: JobRunner, jobId: string): void {
  const job = jobStore.getJob(jobId);
  const status = jobRunner.getStatus(jobId);
  if (!job) {
    return;
  }
  // T3.3: a repeat-count batch gets one summary toast (onDidCompleteBatch)
  // instead of one per lane -- 10 back-to-back toasts was never the fix for
  // 10 back-to-back toasts, however distinguishable each one reads.
  if (status.laneLabel) {
    return;
  }

  const name = job.name;
  const warns = status.warningCount ?? 0;
  const errs = status.errorCount ?? 0;

  if (status.state === 'passed') {
    const warnNote = warns > 0 ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '';
    void vscode.window.showInformationMessage(`"${name}" passed (${describeElapsed(status)}${warnNote}).`);
  } else if (status.state === 'failed') {
    // When the process exited 0 but the log carried UVM/compile errors, say so —
    // otherwise a bare "exit 0" would look like a spurious failure.
    const reason =
      status.exitCode === 0 && errs > 0
        ? `${errs} error${errs === 1 ? '' : 's'} in log`
        : `exit ${status.exitCode ?? '?'}`;
    void vscode.window
      .showWarningMessage(`"${name}" failed (${reason}).`, 'Open Log')
      .then(choice => {
        if (choice === 'Open Log') {
          void openLogForJob(job, status.logPath);
        }
      });
  }
  // 'killed' is always user-initiated (they just clicked Stop) — no toast needed.
}

function notifyOnBatchCompletion(summary: BatchSummary): void {
  const message = `"${summary.jobName}" finished — ${summary.passed} passed, ${summary.failed} failed.`;
  const notify = summary.failed > 0 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  void notify(message, 'Open Log Viewer').then(choice => {
    if (choice === 'Open Log Viewer') {
      void vscode.commands.executeCommand('eda-job-runner.openLogViewer');
    }
  });
}

function describeElapsed(status: JobRunStatus): string {
  return formatDuration((status.endTime ?? 0) - (status.startTime ?? 0));
}

function safeStatSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
