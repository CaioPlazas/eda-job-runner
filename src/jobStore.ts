import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { GlobalParam, JobDefinition, JobsFile, JobsFileSetup, JobTemplate, emptyJobsFile } from './types';
import { computeReorderedJobs } from './jobOrder';
import { computeReorderedFolders } from './folderOrder';

export class JobStore implements vscode.Disposable {
  private readonly _onDidChangeJobs = new vscode.EventEmitter<void>();
  readonly onDidChangeJobs = this._onDidChangeJobs.event;

  private data: JobsFile = emptyJobsFile();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly jobsFileUri: vscode.Uri;

  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {
    this.jobsFileUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'eda-jobs.json');

    const pattern = new vscode.RelativePattern(workspaceFolder, '.vscode/eda-jobs.json');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.load()),
      watcher.onDidCreate(() => this.load()),
      watcher.onDidDelete(() => {
        this.data = emptyJobsFile();
        this._onDidChangeJobs.fire();
      }),
      this._onDidChangeJobs
    );
  }

  async load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.jobsFileUri);
      const text = Buffer.from(bytes).toString('utf8');
      const parsed = text.trim().length === 0 ? emptyJobsFile() : (JSON.parse(text) as Partial<JobsFile>);
      this.data = normalize(parsed);
    } catch (err) {
      if (isFileNotFound(err)) {
        this.data = emptyJobsFile();
      } else {
        vscode.window.showErrorMessage(
          `EDA Job Runner: failed to read .vscode/eda-jobs.json (${describeError(err)}). ` +
            'Fix the file by hand or delete it to start over.'
        );
        return;
      }
    }
    this._onDidChangeJobs.fire();
  }

  getJobs(): JobDefinition[] {
    return this.data.jobs;
  }

  getJob(id: string): JobDefinition | undefined {
    return this.data.jobs.find(j => j.id === id);
  }

  getDefaultJob(): JobDefinition | undefined {
    return this.data.jobs.find(j => j.default);
  }

  getSetup() {
    return this.data.setup;
  }

  getFolders(): string[] {
    return this.data.folders ?? [];
  }

  /** No-op if `name` is blank or already exists -- safe to call unconditionally. */
  async addFolder(name: string): Promise<void> {
    if (!this.ensureFolder(name)) {
      return;
    }
    await this.persist();
  }

  /** Mutates `this.data.folders` in place if `name` is new; returns whether it changed anything. */
  private ensureFolder(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) {
      return false;
    }
    const folders = this.data.folders ?? [];
    if (folders.includes(trimmed)) {
      return false;
    }
    this.data.folders = [...folders, trimmed];
    return true;
  }

  /** No-op if `oldName` doesn't exist or `newName` collides with a different existing folder. */
  async renameFolder(oldName: string, newName: string): Promise<void> {
    const trimmed = newName.trim();
    const folders = this.data.folders ?? [];
    const idx = folders.indexOf(oldName);
    if (!trimmed || trimmed === oldName || idx === -1 || folders.includes(trimmed)) {
      return;
    }
    const nextFolders = folders.slice();
    nextFolders[idx] = trimmed;
    this.data.folders = nextFolders;
    for (const job of this.data.jobs) {
      if (job.folder === oldName) {
        job.folder = trimmed;
      }
    }
    await this.persist();
  }

  /**
   * Removes the folder itself. When `deleteJobs` is true (the normal case --
   * the caller is expected to have warned the user first if the folder was
   * non-empty), every job inside it is deleted outright; when false, they're
   * only ungrouped (moved back to the top level), never deleted.
   */
  async deleteFolder(name: string, deleteJobs: boolean): Promise<void> {
    this.data.folders = (this.data.folders ?? []).filter(f => f !== name);
    if (deleteJobs) {
      this.data.jobs = this.data.jobs.filter(j => j.folder !== name);
    } else {
      for (const job of this.data.jobs) {
        if (job.folder === name) {
          delete job.folder;
        }
      }
    }
    await this.persist();
  }

  /** No-op (same array reference, nothing persisted) if `name` doesn't exist. */
  async reorderFolder(name: string, beforeName: string | undefined): Promise<void> {
    const folders = this.data.folders ?? [];
    const next = computeReorderedFolders(folders, name, beforeName);
    if (next === folders) {
      return;
    }
    this.data.folders = next;
    await this.persist();
  }

  /** Pass `undefined` to ungroup. Regrouping into an unknown folder name creates it. */
  async moveJobToFolder(id: string, folder: string | undefined): Promise<void> {
    const job = this.data.jobs.find(j => j.id === id);
    if (!job) {
      return;
    }
    if (folder) {
      this.ensureFolder(folder);
      job.folder = folder;
    } else {
      delete job.folder;
    }
    await this.persist();
  }

  /**
   * Reorders a job within `data.jobs` (the sidebar's sole source of visual
   * order) and, same as `moveJobToFolder`, regroups it into `folder` (pass
   * `undefined` to ungroup). Used by drag-and-drop in the tree; a no-op if
   * `id` doesn't exist. See `computeReorderedJobs` for the pure logic.
   */
  async reorderJob(id: string, beforeId: string | undefined, folder: string | undefined): Promise<void> {
    const next = computeReorderedJobs(this.data.jobs, id, beforeId, folder);
    if (next === this.data.jobs) {
      return; // no such job -- nothing moved, so don't touch folders or persist
    }
    if (folder) {
      this.ensureFolder(folder);
    }
    this.data.jobs = next;
    await this.persist();
  }

  getTemplates(): JobTemplate[] {
    return this.data.templates ?? [];
  }

  /** Replaces any existing template of the same name (edit-in-place), else appends. */
  async addTemplate(template: JobTemplate): Promise<void> {
    const name = template.name.trim();
    if (!name) {
      return;
    }
    const templates = (this.data.templates ?? []).filter(t => t.name !== name);
    templates.push({ ...template, name });
    this.data.templates = templates;
    await this.persist();
  }

  async deleteTemplate(name: string): Promise<void> {
    const templates = (this.data.templates ?? []).filter(t => t.name !== name);
    this.data.templates = templates.length > 0 ? templates : undefined;
    await this.persist();
  }

  getParams(): GlobalParam[] {
    return this.data.params ?? [];
  }

  /** Replaces the whole list (the Parameters panel edits/saves the full set at once); trims and drops blank names. */
  async setParams(params: GlobalParam[]): Promise<void> {
    const byName = new Map<string, GlobalParam>();
    for (const p of params) {
      const name = p.name.trim();
      if (!name) {
        continue;
      }
      byName.set(name, { name, value: p.value });
    }
    this.data.params = byName.size > 0 ? [...byName.values()] : undefined;
    await this.persist();
  }

  /**
   * Replace the workspace-level `setup` block (sourced script + pre-commands)
   * and persist. Passing an empty/blank setup drops the key entirely so the
   * common "no setup" case stays absent from the JSON.
   */
  async setSetup(setup: JobsFileSetup | undefined): Promise<void> {
    const script = setup?.script?.trim();
    const commands = (setup?.commands ?? []).map(c => c.trim()).filter(c => c.length > 0);
    const next: JobsFileSetup = {};
    if (script) {
      next.script = script;
    }
    if (commands.length > 0) {
      next.commands = commands;
    }
    this.data.setup = script || commands.length > 0 ? next : undefined;
    await this.persist();
  }

  get jobsFilePath(): vscode.Uri {
    return this.jobsFileUri;
  }

  async addJob(job: Omit<JobDefinition, 'id'>): Promise<JobDefinition> {
    const newJob: JobDefinition = { id: randomUUID(), ...job };
    this.data.jobs.push(newJob);
    if (newJob.default) {
      this.clearDefaultExcept(newJob.id);
    }
    if (newJob.folder) {
      this.ensureFolder(newJob.folder);
    }
    await this.persist();
    return newJob;
  }

  async updateJob(id: string, updates: Omit<JobDefinition, 'id'>): Promise<void> {
    const job = this.data.jobs.find(j => j.id === id);
    if (!job) {
      return;
    }
    job.name = updates.name;
    job.command = updates.command;
    job.cwd = updates.cwd;
    job.default = updates.default;
    job.parseProblems = updates.parseProblems;
    job.failPattern = updates.failPattern;
    job.passPattern = updates.passPattern;
    job.logFile = updates.logFile;
    job.postSetupCwd = updates.postSetupCwd;
    job.runCount = updates.runCount;
    job.toolId = updates.toolId;
    job.toolVariantLabel = updates.toolVariantLabel;
    job.listInsertOverrides = updates.listInsertOverrides;
    job.customArgs = updates.customArgs;
    job.paramOverrides = updates.paramOverrides;
    if (updates.folder) {
      this.ensureFolder(updates.folder);
      job.folder = updates.folder;
    } else {
      delete job.folder;
    }
    if (updates.default) {
      this.clearDefaultExcept(id);
    }
    await this.persist();
  }

  async deleteJob(id: string): Promise<void> {
    this.data.jobs = this.data.jobs.filter(j => j.id !== id);
    await this.persist();
  }

  async duplicateJob(id: string): Promise<JobDefinition | undefined> {
    const job = this.getJob(id);
    if (!job) {
      return undefined;
    }
    // A duplicate is never the default — only one job can hold that.
    return this.addJob({
      name: `${job.name} (copy)`,
      command: job.command,
      cwd: job.cwd,
      parseProblems: job.parseProblems,
      failPattern: job.failPattern,
      passPattern: job.passPattern,
      logFile: job.logFile,
      postSetupCwd: job.postSetupCwd,
      runCount: job.runCount,
      toolId: job.toolId,
      toolVariantLabel: job.toolVariantLabel,
      listInsertOverrides: job.listInsertOverrides,
      customArgs: job.customArgs,
      paramOverrides: job.paramOverrides,
      folder: job.folder
    });
  }

  /** Enforces the "at most one default" invariant by clearing the flag elsewhere. */
  private clearDefaultExcept(id: string): void {
    for (const job of this.data.jobs) {
      if (job.id !== id && job.default) {
        delete job.default;
      }
    }
  }

  private async persist(): Promise<void> {
    const dir = vscode.Uri.joinPath(this.workspaceFolder.uri, '.vscode');
    await vscode.workspace.fs.createDirectory(dir);
    const text = JSON.stringify(this.data, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(this.jobsFileUri, Buffer.from(text, 'utf8'));
    this._onDidChangeJobs.fire();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function normalize(parsed: Partial<JobsFile> | undefined): JobsFile {
  if (!parsed || !Array.isArray(parsed.jobs)) {
    return emptyJobsFile();
  }
  let defaultSeen = false;
  const jobs: JobDefinition[] = parsed.jobs
    .filter(
      (j): j is JobDefinition =>
        typeof j?.id === 'string' && typeof j?.name === 'string' && typeof j?.command === 'string'
    )
    .map(j => {
      const job: JobDefinition = {
        id: j.id,
        name: j.name,
        command: j.command,
        cwd: typeof j.cwd === 'string' && j.cwd.trim().length > 0 ? j.cwd : '.'
      };
      if (j.parseProblems === false) {
        job.parseProblems = false;
      }
      if (typeof j.failPattern === 'string' && j.failPattern.trim().length > 0) {
        job.failPattern = j.failPattern.trim();
      }
      if (typeof j.passPattern === 'string' && j.passPattern.trim().length > 0) {
        job.passPattern = j.passPattern.trim();
      }
      if (typeof j.logFile === 'string' && j.logFile.trim().length > 0) {
        job.logFile = j.logFile.trim();
      }
      if (typeof j.postSetupCwd === 'string' && j.postSetupCwd.trim().length > 0) {
        job.postSetupCwd = j.postSetupCwd.trim();
      }
      if (typeof j.runCount === 'number' && Number.isFinite(j.runCount) && j.runCount > 1) {
        job.runCount = Math.min(1000, Math.round(j.runCount));
      }
      if (typeof j.toolId === 'string' && j.toolId.trim().length > 0) {
        job.toolId = j.toolId.trim();
        if (typeof j.toolVariantLabel === 'string') {
          job.toolVariantLabel = j.toolVariantLabel;
        }
      }
      const listOverrides = normalizeStringRecord(j.listInsertOverrides);
      if (listOverrides) {
        job.listInsertOverrides = listOverrides;
      }
      const customArgs = normalizeCustomArgs(j.customArgs);
      if (customArgs) {
        job.customArgs = customArgs;
      }
      const paramOverrides = normalizeParamOverrides(j.paramOverrides);
      if (paramOverrides) {
        job.paramOverrides = paramOverrides;
      }
      if (typeof j.folder === 'string' && j.folder.trim().length > 0) {
        job.folder = j.folder.trim();
      }
      // Tolerate a hand-edited file that marked more than one job default:
      // keep the first, drop the rest, so the invariant always holds in memory.
      if (j.default === true && !defaultSeen) {
        job.default = true;
        defaultSeen = true;
      }
      return job;
    });
  const folders = Array.isArray(parsed.folders)
    ? [...new Set(parsed.folders.filter((f): f is string => typeof f === 'string' && f.trim().length > 0))]
    : undefined;
  const templates = normalizeTemplates(parsed.templates);
  const params = normalizeParams(parsed.params);
  return { version: 1, setup: parsed.setup, folders, templates, params, jobs };
}

/** Keep only well-formed {name, value} entries with a non-empty name, deduped by name (last one wins); undefined if none survive. */
function normalizeParams(raw: unknown): GlobalParam[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const byName = new Map<string, GlobalParam>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) {
      continue;
    }
    const value = typeof rec.value === 'string' ? rec.value : '';
    byName.set(name, { name, value });
  }
  return byName.size > 0 ? [...byName.values()] : undefined;
}

/** Keep only string→(non-empty)string entries from a hand-editable object; undefined if none survive. */
function normalizeStringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim().length > 0 && typeof value === 'string' && value.trim().length > 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Like `normalizeStringRecord`, but keeps an explicit empty-string value --
 * unlike `listInsertOverrides` (where blank genuinely means "no override"),
 * `paramVars.ts`'s `effectiveVarValue` treats an empty-string override as a
 * real, intentional override (distinct from "no override", which falls back
 * to the global default), so it must survive a save/reload round-trip.
 */
function normalizeParamOverrides(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim().length > 0 && typeof value === 'string') {
      out[key.trim()] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep only well-formed {arg, value?} entries with a non-empty arg; undefined if none survive. */
function normalizeCustomArgs(raw: unknown): { arg: string; value?: string }[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: { arg: string; value?: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rawArg = (item as { arg?: unknown }).arg;
    const arg = typeof rawArg === 'string' ? rawArg.trim() : '';
    if (!arg) {
      continue;
    }
    const rawValue = (item as { value?: unknown }).value;
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    out.push(value ? { arg, value } : { arg });
  }
  return out.length > 0 ? out : undefined;
}

/** Keep only well-formed templates with a non-empty name, deduped by name (last one wins); undefined if none survive. */
function normalizeTemplates(raw: unknown): JobTemplate[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const byName = new Map<string, JobTemplate>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) {
      continue;
    }
    const str = (key: string): string | undefined =>
      typeof rec[key] === 'string' && (rec[key] as string).trim().length > 0 ? (rec[key] as string) : undefined;
    byName.set(name, {
      name,
      namePattern: str('namePattern'),
      command: str('command'),
      cwd: str('cwd'),
      toolId: str('toolId'),
      toolVariantLabel: typeof rec.toolVariantLabel === 'string' ? rec.toolVariantLabel : undefined,
      parseProblems: rec.parseProblems === false ? false : undefined,
      folder: str('folder')
    });
  }
  return byName.size > 0 ? [...byName.values()] : undefined;
}

function isFileNotFound(err: unknown): boolean {
  return err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
