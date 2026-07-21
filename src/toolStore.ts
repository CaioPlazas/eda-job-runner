import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ToolDefinition, ToolList, ToolsFile, ToolVariant, emptyToolsFile } from './types';

/** Mirrors JobStore: loads/saves/watches a hand-editable, shareable workspace file. */
export class ToolStore implements vscode.Disposable {
  private readonly _onDidChangeTools = new vscode.EventEmitter<void>();
  readonly onDidChangeTools = this._onDidChangeTools.event;

  private data: ToolsFile = emptyToolsFile();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly toolsFileUri: vscode.Uri;

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

  async load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.toolsFileUri);
      const text = Buffer.from(bytes).toString('utf8');
      const parsed = text.trim().length === 0 ? emptyToolsFile() : (JSON.parse(text) as Partial<ToolsFile>);
      this.data = normalize(parsed);
    } catch (err) {
      if (isFileNotFound(err)) {
        this.data = emptyToolsFile();
      } else {
        vscode.window.showErrorMessage(
          `EDA Job Runner: failed to read .vscode/eda-tools.json (${describeError(err)}). ` +
            'Fix the file by hand or delete it to start over.'
        );
        return;
      }
    }
    this._onDidChangeTools.fire();
  }

  getTools(): ToolDefinition[] {
    return this.data.tools;
  }

  getTool(id: string): ToolDefinition | undefined {
    return this.data.tools.find(t => t.id === id);
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

  private async persist(): Promise<void> {
    const dir = vscode.Uri.joinPath(this.workspaceFolder.uri, '.vscode');
    await vscode.workspace.fs.createDirectory(dir);
    const text = JSON.stringify(this.data, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(this.toolsFileUri, Buffer.from(text, 'utf8'));
    this._onDidChangeTools.fire();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function normalize(parsed: Partial<ToolsFile> | undefined): ToolsFile {
  if (!parsed || !Array.isArray(parsed.tools)) {
    return emptyToolsFile();
  }
  const tools: ToolDefinition[] = parsed.tools
    .filter((t): t is ToolDefinition => typeof t?.id === 'string' && typeof t?.command === 'string')
    .map(t => ({
      id: t.id,
      command: t.command,
      helpArg: typeof t.helpArg === 'string' && t.helpArg.trim() ? t.helpArg.trim() : undefined,
      variants: normalizeVariants(t.variants),
      lists: normalizeLists(t.lists),
      lastScanned: typeof t.lastScanned === 'number' ? t.lastScanned : undefined
    }));
  return { version: 1, tools };
}

function normalizeLists(raw: unknown): ToolList[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const lists = raw
    .filter((l): l is ToolList => typeof l?.name === 'string' && l.name.trim().length > 0)
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
