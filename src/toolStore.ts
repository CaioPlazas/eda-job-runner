import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ToolDefinition, ToolsFile, ToolVariant, ValueList, emptyToolsFile } from './types';
import { LoadGuard } from './storeSync';

/** A pre-global-lists tool's own `lists`, captured at load time so a one-time
 * startup migration (see `extension.ts`) can move it into `JobsFile.lists`.
 * Never written back onto a `ToolDefinition` -- that field no longer exists
 * on the type. */
export interface LegacyToolLists {
  toolId: string;
  lists: ValueList[];
}

/** Mirrors JobStore: loads/saves/watches a hand-editable, shareable workspace file. */
export class ToolStore implements vscode.Disposable {
  private readonly _onDidChangeTools = new vscode.EventEmitter<void>();
  readonly onDidChangeTools = this._onDidChangeTools.event;

  private data: ToolsFile = emptyToolsFile();
  private legacyLists: LegacyToolLists[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly toolsFileUri: vscode.Uri;
  /** Chains persist() calls so overlapping writes land on disk in the order they were issued -- see persist(). */
  private writeQueue: Promise<void> = Promise.resolve();
  /** Same load/write sequencing JobStore uses -- see storeSync.ts. */
  private readonly guard = new LoadGuard();

  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {
    this.toolsFileUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'eda-tools.json');

    const pattern = new vscode.RelativePattern(workspaceFolder, '.vscode/eda-tools.json');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.load()),
      watcher.onDidCreate(() => this.load()),
      watcher.onDidDelete(() => {
        this.data = emptyToolsFile();
        this._onDidChangeTools.fire();
      }),
      this._onDidChangeTools
    );
  }

  /** Same guarded shape as `JobStore.load()` -- see storeSync.ts for what the guard prevents. */
  async load(): Promise<void> {
    const attempt = this.guard.beginLoad();
    let nextData: ToolsFile;
    let nextLegacy: LegacyToolLists[];
    try {
      const bytes = await vscode.workspace.fs.readFile(this.toolsFileUri);
      const text = Buffer.from(bytes).toString('utf8');
      if (this.guard.isSelfWrite(text)) {
        return; // our own persist() coming back around
      }
      const parsed = text.trim().length === 0 ? emptyToolsFile() : (JSON.parse(text) as Partial<ToolsFile>);
      const { toolsFile, legacyLists } = normalize(parsed);
      nextData = toolsFile;
      nextLegacy = legacyLists;
    } catch (err) {
      if (isFileNotFound(err)) {
        nextData = emptyToolsFile();
        nextLegacy = [];
      } else {
        vscode.window.showErrorMessage(
          `EDA Job Runner: failed to read .vscode/eda-tools.json (${describeError(err)}). ` +
            'Fix the file by hand or delete it to start over.'
        );
        return;
      }
    }
    if (!this.guard.shouldApply(attempt)) {
      return; // superseded mid-read; see JobStore.load()
    }
    this.data = nextData;
    this.legacyLists = nextLegacy;
    this._onDidChangeTools.fire();
  }

  /** See `JobStore.getRevision()`. */
  getRevision(): number {
    return this.guard.revision;
  }

  /** See `JobStore.hasChangedSince()`. */
  hasChangedSince(revision: number): boolean {
    return this.guard.revision !== revision;
  }

  getTools(): ToolDefinition[] {
    return this.data.tools;
  }

  getTool(id: string): ToolDefinition | undefined {
    return this.data.tools.find(t => t.id === id);
  }

  /** One-time migration hook, consumed once by `extension.ts`'s startup
   * migration (moving each tool's pre-global-lists `lists` into
   * `JobsFile.lists`). Clears the returned entries so a caller that also
   * forces a fresh `persist()` per migrated tool (dropping the now-unused
   * `lists` key from the JSON file) makes the next `load()` a true no-op. */
  takeLegacyLists(): LegacyToolLists[] {
    const taken = this.legacyLists;
    this.legacyLists = [];
    return taken;
  }

  async addTool(tool: Omit<ToolDefinition, 'id'>): Promise<ToolDefinition> {
    const newTool: ToolDefinition = { id: randomUUID(), ...tool };
    this.data.tools.push(newTool);
    await this.persist();
    return newTool;
  }

  /** Partial merge — a rescan only touches `variants`/`lastScanned`, leaving `command`/`helpArg` alone. */
  async updateTool(id: string, updates: Partial<Omit<ToolDefinition, 'id'>>): Promise<void> {
    const tool = this.data.tools.find(t => t.id === id);
    if (!tool) {
      return;
    }
    Object.assign(tool, updates);
    await this.persist();
  }

  async removeTool(id: string): Promise<void> {
    this.data.tools = this.data.tools.filter(t => t.id !== id);
    await this.persist();
  }

  /**
   * Snapshots `this.data` synchronously (so callers that mutate `this.data`
   * then `await this.persist()` back-to-back never interleave their
   * snapshots), then queues the actual disk write behind any write already
   * in flight. Without the queue, two overlapping writes could complete out
   * of order and leave the earlier, staler snapshot as the on-disk result.
   */
  private async persist(): Promise<void> {
    const text = JSON.stringify(this.data, null, 2) + '\n';
    this.guard.beginWrite(text); // see JobStore.persist()
    const write = this.writeQueue.then(() => this.writeAtomic(text));
    this.writeQueue = write.catch(() => undefined);
    await write;
    this._onDidChangeTools.fire();
  }

  /** Writes to a sibling temp file then renames over the target, so a crash mid-write can never leave `.vscode/eda-tools.json` truncated/corrupt. */
  private async writeAtomic(text: string): Promise<void> {
    const dir = vscode.Uri.joinPath(this.workspaceFolder.uri, '.vscode');
    await vscode.workspace.fs.createDirectory(dir);
    const tmpUri = this.toolsFileUri.with({ path: `${this.toolsFileUri.path}.tmp-${randomUUID()}` });
    await vscode.workspace.fs.writeFile(tmpUri, Buffer.from(text, 'utf8'));
    await vscode.workspace.fs.rename(tmpUri, this.toolsFileUri, { overwrite: true });
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function normalize(parsed: Partial<ToolsFile> | undefined): { toolsFile: ToolsFile; legacyLists: LegacyToolLists[] } {
  if (!parsed || !Array.isArray(parsed.tools)) {
    return { toolsFile: emptyToolsFile(), legacyLists: [] };
  }
  const legacyLists: LegacyToolLists[] = [];
  const tools: ToolDefinition[] = parsed.tools
    .filter((t): t is ToolDefinition => typeof t?.id === 'string' && typeof t?.command === 'string')
    .map(t => {
      // Pre-global-lists tools carried their own `lists` array; that field
      // no longer exists on `ToolDefinition`, but a workspace's JSON file
      // may still have it on disk from before this change -- captured here
      // (not assigned onto the tool) so extension.ts can migrate it once.
      const legacy = normalizeLegacyLists((t as unknown as { lists?: unknown }).lists);
      if (legacy && legacy.length > 0) {
        legacyLists.push({ toolId: t.id, lists: legacy });
      }
      return {
        id: t.id,
        command: t.command,
        displayName: typeof t.displayName === 'string' && t.displayName.trim() ? t.displayName.trim() : undefined,
        scanDir: typeof t.scanDir === 'string' && t.scanDir.trim() ? t.scanDir.trim() : undefined,
        helpArg: typeof t.helpArg === 'string' && t.helpArg.trim() ? t.helpArg.trim() : undefined,
        seedPattern: typeof t.seedPattern === 'string' && t.seedPattern.trim() ? t.seedPattern.trim() : undefined,
        errorPattern: typeof t.errorPattern === 'string' && t.errorPattern.trim() ? t.errorPattern.trim() : undefined,
        variants: normalizeVariants(t.variants),
        lastScanned: typeof t.lastScanned === 'number' ? t.lastScanned : undefined
      };
    });
  return { toolsFile: { version: 1, tools }, legacyLists };
}

function normalizeLegacyLists(raw: unknown): ValueList[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const lists = raw
    .filter((l): l is ValueList => typeof l?.name === 'string' && l.name.trim().length > 0)
    .map(l => ({
      name: l.name.trim(),
      command: typeof l.command === 'string' && l.command.trim() ? l.command.trim() : undefined,
      file: typeof l.file === 'string' && l.file.trim() ? l.file.trim() : undefined,
      pattern: typeof l.pattern === 'string' && l.pattern.trim() ? l.pattern.trim() : undefined,
      insertTemplate: typeof l.insertTemplate === 'string' && l.insertTemplate.trim() ? l.insertTemplate : undefined,
      values: Array.isArray(l.values) ? l.values.filter((v: unknown): v is string => typeof v === 'string') : [],
      scanError: typeof l.scanError === 'string' ? l.scanError : undefined
    }));
  return lists.length > 0 ? lists : undefined;
}

function normalizeVariants(raw: unknown): ToolVariant[] {
  const variants = Array.isArray(raw)
    ? raw
        .filter((v): v is ToolVariant => typeof v?.label === 'string' && Array.isArray(v?.selectArgs))
        .map(v => ({
          label: v.label,
          selectArgs: v.selectArgs.filter((a: unknown): a is string => typeof a === 'string'),
          options: Array.isArray(v.options) ? v.options : [],
          rawHelp: typeof v.rawHelp === 'string' ? v.rawHelp : undefined,
          scanError: typeof v.scanError === 'string' ? v.scanError : undefined
        }))
    : [];
  if (variants.length === 0 || variants[0].label !== '') {
    variants.unshift({ label: '', selectArgs: [], options: [], rawHelp: undefined, scanError: undefined });
  }
  return variants;
}

function isFileNotFound(err: unknown): boolean {
  return err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
