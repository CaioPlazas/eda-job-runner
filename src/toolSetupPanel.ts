import * as vscode from 'vscode';
import { ToolStore } from './toolStore';
import { JobStore } from './jobStore';
import { ToolDefinition, ToolList, ToolOption, ToolVariant } from './types';
import { scanVariant, scanTool, scanLists, discoverList } from './toolIntrospect';
import { detectSubcommandChoices, mergeFavorites, parseChoices } from './toolOptionParser';

interface ScanNewMessage {
  type: 'scanNew';
  command: string;
  helpArg: string;
}
interface CancelAddMessage {
  type: 'cancelAdd';
}
interface ConfirmAddMessage {
  type: 'confirmAdd';
  variants: { label: string; selectArgs: string }[];
}
interface RescanToolMessage {
  type: 'rescanTool';
  id: string;
}
interface RescanVariantMessage {
  type: 'rescanVariant';
  id: string;
  label: string;
}
interface RemoveToolMessage {
  type: 'removeTool';
  id: string;
}
interface StartEditMessage {
  type: 'startEdit';
  id: string;
}
interface CancelEditMessage {
  type: 'cancelEdit';
}
interface SaveEditMessage {
  type: 'saveEdit';
  id: string;
  command: string;
  helpArg: string;
}
interface StartAddVariantMessage {
  type: 'startAddVariant';
  id: string;
}
interface CancelAddVariantMessage {
  type: 'cancelAddVariant';
}
interface ConfirmAddVariantMessage {
  type: 'confirmAddVariant';
  id: string;
  label: string;
  selectArgs: string;
}
interface RemoveVariantMessage {
  type: 'removeVariant';
  id: string;
  label: string;
}
interface ToggleFavoriteMessage {
  type: 'toggleFavorite';
  id: string;
  label: string;
  flagsKey: string;
}
interface AddListMessage {
  type: 'addList';
  id: string;
  name: string;
  sourceType: 'file' | 'command';
  source: string;
  pattern: string;
  insertTemplate: string;
}
interface RefreshListMessage {
  type: 'refreshList';
  id: string;
  name: string;
}
interface RemoveListMessage {
  type: 'removeList';
  id: string;
  name: string;
}
interface CloseMessage {
  type: 'close';
}

type WebviewMessage =
  | ScanNewMessage
  | CancelAddMessage
  | ConfirmAddMessage
  | RescanToolMessage
  | RescanVariantMessage
  | RemoveToolMessage
  | StartEditMessage
  | CancelEditMessage
  | SaveEditMessage
  | StartAddVariantMessage
  | CancelAddVariantMessage
  | ConfirmAddVariantMessage
  | RemoveVariantMessage
  | ToggleFavoriteMessage
  | AddListMessage
  | RefreshListMessage
  | RemoveListMessage
  | CloseMessage;

interface PendingAdd {
  command: string;
  helpArg: string;
  topLevel: { options: ToolOption[]; rawHelp: string; scanError?: string };
  suggestedChoices: string[];
}

export class ToolSetupPanel {
  private static current: ToolSetupPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingAdd: PendingAdd | undefined;
  private editingToolId: string | undefined;
  private addingVariantForToolId: string | undefined;

  static createOrShow(toolStore: ToolStore, jobStore: JobStore, folder: vscode.WorkspaceFolder): void {
    if (ToolSetupPanel.current) {
      ToolSetupPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('edaToolSetup', 'Tool Setup', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    ToolSetupPanel.current = new ToolSetupPanel(panel, toolStore, jobStore, folder);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly toolStore: ToolStore,
    private readonly jobStore: JobStore,
    private readonly folder: vscode.WorkspaceFolder
  ) {
    this.panel = panel;
    this.render();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg)),
      this.panel.onDidDispose(() => this.cleanup())
    );
  }

  private render(): void {
    this.panel.webview.html = renderHtml(
      this.panel.webview,
      this.toolStore.getTools(),
      this.pendingAdd,
      this.editingToolId,
      this.addingVariantForToolId
    );
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'close':
        this.panel.dispose();
        return;

      case 'scanNew': {
        const command = msg.command.trim();
        if (!command) {
          return;
        }
        const helpArg = msg.helpArg.trim() || '--help';
        const result = await scanVariant(command, [], helpArg, this.jobStore, this.folder);
        this.pendingAdd = {
          command,
          helpArg,
          topLevel: { options: result.options, rawHelp: result.rawHelp, scanError: result.scanError },
          suggestedChoices: detectSubcommandChoices(result.rawHelp)
        };
        this.render();
        return;
      }

      case 'cancelAdd':
        this.pendingAdd = undefined;
        this.render();
        return;

      case 'confirmAdd': {
        const pending = this.pendingAdd;
        if (!pending) {
          return;
        }
        const variants: ToolVariant[] = [
          {
            label: '',
            selectArgs: [],
            options: pending.topLevel.options,
            rawHelp: pending.topLevel.rawHelp,
            scanError: pending.topLevel.scanError
          }
        ];
        for (const v of msg.variants) {
          const label = v.label.trim();
          const selectArgs = v.selectArgs.trim().split(/\s+/).filter(a => a.length > 0);
          if (!label || selectArgs.length === 0) {
            continue;
          }
          const result = await scanVariant(pending.command, selectArgs, pending.helpArg, this.jobStore, this.folder);
          variants.push({ label, selectArgs, options: result.options, rawHelp: result.rawHelp, scanError: result.scanError });
        }
        await this.toolStore.addTool({ command: pending.command, helpArg: pending.helpArg, variants, lastScanned: Date.now() });
        this.pendingAdd = undefined;
        this.render();
        return;
      }

      case 'rescanTool': {
        const tool = this.toolStore.getTool(msg.id);
        if (!tool) {
          return;
        }
        const variants = await scanTool(tool, this.jobStore, this.folder);
        const lists = await scanLists(tool, this.jobStore, this.folder);
        await this.toolStore.updateTool(msg.id, { variants, lists, lastScanned: Date.now() });
        this.render();
        return;
      }

      case 'rescanVariant': {
        const tool = this.toolStore.getTool(msg.id);
        if (!tool) {
          return;
        }
        const idx = tool.variants.findIndex(v => v.label === msg.label);
        if (idx === -1) {
          return;
        }
        const helpArg = tool.helpArg?.trim() || '--help';
        const result = await scanVariant(tool.command, tool.variants[idx].selectArgs, helpArg, this.jobStore, this.folder);
        const variants = tool.variants.slice();
        variants[idx] = {
          ...variants[idx],
          options: mergeFavorites(variants[idx].options, result.options),
          rawHelp: result.rawHelp,
          scanError: result.scanError
        };
        await this.toolStore.updateTool(msg.id, { variants, lastScanned: Date.now() });
        this.render();
        return;
      }

      case 'removeTool':
        await this.toolStore.removeTool(msg.id);
        this.render();
        return;

      case 'startEdit':
        this.editingToolId = msg.id;
        this.render();
        return;

      case 'cancelEdit':
        this.editingToolId = undefined;
        this.render();
        return;

      case 'saveEdit': {
        const command = msg.command.trim();
        if (!command) {
          return;
        }
        const helpArg = msg.helpArg.trim() || '--help';
        await this.toolStore.updateTool(msg.id, { command, helpArg });
        const updated = this.toolStore.getTool(msg.id);
        if (updated) {
          const variants = await scanTool(updated, this.jobStore, this.folder);
          const lists = await scanLists(updated, this.jobStore, this.folder);
          await this.toolStore.updateTool(msg.id, { variants, lists, lastScanned: Date.now() });
        }
        this.editingToolId = undefined;
        this.render();
        return;
      }

      case 'startAddVariant':
        this.addingVariantForToolId = msg.id;
        this.render();
        return;

      case 'cancelAddVariant':
        this.addingVariantForToolId = undefined;
        this.render();
        return;

      case 'confirmAddVariant': {
        const tool = this.toolStore.getTool(msg.id);
        const label = msg.label.trim();
        const selectArgs = msg.selectArgs.trim().split(/\s+/).filter(a => a.length > 0);
        if (!tool || !label || selectArgs.length === 0) {
          return;
        }
        const helpArg = tool.helpArg?.trim() || '--help';
        const result = await scanVariant(tool.command, selectArgs, helpArg, this.jobStore, this.folder);
        const variants = tool.variants.filter(v => v.label !== label);
        variants.push({ label, selectArgs, options: result.options, rawHelp: result.rawHelp, scanError: result.scanError });
        await this.toolStore.updateTool(msg.id, { variants, lastScanned: Date.now() });
        this.addingVariantForToolId = undefined;
        this.render();
        return;
      }

      case 'removeVariant': {
        const tool = this.toolStore.getTool(msg.id);
        if (!tool || msg.label === '') {
          return; // the implicit top-level variant can't be removed
        }
        const variants = tool.variants.filter(v => v.label !== msg.label);
        await this.toolStore.updateTool(msg.id, { variants });
        this.render();
        return;
      }

      case 'toggleFavorite': {
        const tool = this.toolStore.getTool(msg.id);
        if (!tool) {
          return;
        }
        const idx = tool.variants.findIndex(v => v.label === msg.label);
        if (idx === -1) {
          return;
        }
        const variants = tool.variants.slice();
        variants[idx] = {
          ...variants[idx],
          options: variants[idx].options.map(o =>
            o.flags.join('|') === msg.flagsKey ? { ...o, favorite: !o.favorite } : o
          )
        };
        await this.toolStore.updateTool(msg.id, { variants });
        this.render();
        return;
      }

      case 'addList': {
        const tool = this.toolStore.getTool(msg.id);
        const name = msg.name.trim();
        const source = msg.source.trim();
        if (!tool || !name || !source) {
          return;
        }
        const list: ToolList = {
          name,
          command: msg.sourceType === 'command' ? source : undefined,
          file: msg.sourceType === 'file' ? source : undefined,
          pattern: msg.pattern.trim() || undefined,
          insertTemplate: msg.insertTemplate.trim() || undefined,
          values: []
        };
        const discovered = await discoverList(list, this.jobStore, this.folder);
        // Replace any existing list of the same name (edit-in-place), else append.
        const lists = (tool.lists ?? []).filter(l => l.name !== name);
        lists.push(discovered);
        await this.toolStore.updateTool(msg.id, { lists });
        this.render();
        return;
      }

      case 'refreshList': {
        const tool = this.toolStore.getTool(msg.id);
        if (!tool || !tool.lists) {
          return;
        }
        const idx = tool.lists.findIndex(l => l.name === msg.name);
        if (idx === -1) {
          return;
        }
        const lists = tool.lists.slice();
        lists[idx] = await discoverList(lists[idx], this.jobStore, this.folder);
        await this.toolStore.updateTool(msg.id, { lists });
        this.render();
        return;
      }

      case 'removeList': {
        const tool = this.toolStore.getTool(msg.id);
        if (!tool || !tool.lists) {
          return;
        }
        const lists = tool.lists.filter(l => l.name !== msg.name);
        await this.toolStore.updateTool(msg.id, { lists: lists.length > 0 ? lists : undefined });
        this.render();
        return;
      }
    }
  }

  private cleanup(): void {
    ToolSetupPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function renderHtml(
  webview: vscode.Webview,
  tools: ToolDefinition[],
  pendingAdd: PendingAdd | undefined,
  editingToolId: string | undefined,
  addingVariantForToolId: string | undefined
): string {
  const nonce = getNonce();
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // A choices metavar (e.g. "{qrun,dsim}") renders as "choices: qrun, dsim"
  // instead of the literal brace form, since Configure's builder now treats
  // it specially (a dropdown) -- showing raw braces here would look stale.
  const metavarHtml = (metavar: string | undefined): string => {
    if (!metavar) {
      return '';
    }
    const choices = parseChoices(metavar);
    return choices ? ` <i>choices: ${choices.map(esc).join(', ')}</i>` : ` <i>${esc(metavar)}</i>`;
  };

  const renderOptionRows = (options: ToolOption[]): string =>
    options.length === 0
      ? '<div class="hint">No options detected.</div>'
      : `<table class="opts">${options
          .map(
            o =>
              `<tr><td>${esc(o.flags.join(', '))}${metavarHtml(o.metavar)}</td><td class="hint">${esc(
                o.description ?? ''
              )}</td></tr>`
          )
          .join('')}</table>`;

  const renderOptionRowsEditable = (toolId: string, variantLabel: string, options: ToolOption[]): string => {
    if (options.length === 0) {
      return '<div class="hint">No options detected.</div>';
    }
    const sorted = [...options].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
    return `<table class="opts">${sorted
      .map(o => {
        const key = o.flags.join('|');
        return `<tr>
          <td><button class="favBtn ${o.favorite ? 'favOn' : ''}" data-fav-id="${esc(toolId)}" data-fav-label="${esc(
          variantLabel
        )}" data-fav-key="${esc(key)}" title="${o.favorite ? 'Unfavorite' : 'Favorite'}" type="button">${
          o.favorite ? '★' : '☆'
        }</button></td>
          <td>${esc(o.flags.join(', '))}${metavarHtml(o.metavar)}</td>
          <td class="hint">${esc(o.description ?? '')}</td>
        </tr>`;
      })
      .join('')}</table>`;
  };

  const renderVariant = (toolId: string, v: ToolVariant): string => {
    const label = v.label || '(top-level)';
    return `<details class="variant" open>
      <summary>${esc(label)} — ${v.options.length} option${v.options.length === 1 ? '' : 's'}${
      v.scanError ? ' <span class="err">⚠ scan issue</span>' : ''
    }
        <button class="secondary small" data-rescan-variant-id="${esc(toolId)}" data-rescan-variant-label="${esc(v.label)}" type="button">Rescan</button>
        ${
          v.label !== ''
            ? `<button class="secondary small" data-remove-variant-id="${esc(toolId)}" data-remove-variant-label="${esc(v.label)}" type="button">Remove sub-tool</button>`
            : ''
        }
      </summary>
      ${v.scanError ? `<div class="err">${esc(v.scanError)}</div>` : ''}
      ${renderOptionRowsEditable(toolId, v.label, v.options)}
      <details><summary class="rawSummary">raw help output</summary><pre>${esc(v.rawHelp ?? '')}</pre></details>
    </details>`;
  };

  const renderAddVariantForm = (toolId: string): string => `
    <div class="variantRow" style="margin-top:12px;">
      <input type="text" placeholder="label (e.g. regression)" class="newVariantLabel" style="flex:1;" />
      <input type="text" placeholder="selector args (e.g. --regression)" class="newVariantArgs" style="flex:1;" />
      <button class="primary small" data-confirm-addvariant="${esc(toolId)}" type="button">Scan &amp; Add</button>
      <button class="secondary small" id="cancelAddVariant" type="button">Cancel</button>
    </div>`;

  const renderList = (toolId: string, l: ToolList): string => {
    const src = l.command ? `command: <code>${esc(l.command)}</code>` : l.file ? `file: <code>${esc(l.file)}</code>` : '<span class="err">no source</span>';
    const status = l.scanError
      ? `<span class="err">⚠ ${esc(l.scanError)}</span>`
      : `${l.values.length} value${l.values.length === 1 ? '' : 's'}`;
    return `<div class="listItem">
      <div class="listHeader">
        <b>${esc(l.name)}</b> <span class="hint">${src}${l.pattern ? ` · pattern <code>${esc(l.pattern)}</code>` : ''} · inserts <code>${esc(l.insertTemplate || '${value}')}</code> · ${status}</span>
        <button class="secondary small" data-refresh-list-id="${esc(toolId)}" data-refresh-list-name="${esc(l.name)}" type="button">↻ Refresh</button>
        <button class="secondary small" data-remove-list-id="${esc(toolId)}" data-remove-list-name="${esc(l.name)}" type="button">Remove</button>
      </div>
      ${l.values.length > 0 ? `<div class="hint listValues">${l.values.slice(0, 12).map(esc).join(', ')}${l.values.length > 12 ? `, …(+${l.values.length - 12})` : ''}</div>` : ''}
    </div>`;
  };

  const renderLists = (tool: ToolDefinition): string => `
    <div class="lists">
      <div class="listsHeading">Value lists <span class="hint">(e.g. a test list — shown as a dropdown in a job's builder)</span></div>
      ${(tool.lists ?? []).map(l => renderList(tool.id, l)).join('')}
      <div class="listRow">
        <input type="text" placeholder="name (e.g. Test)" class="newListName" style="flex:1;" />
        <select class="newListSourceType">
          <option value="command">command</option>
          <option value="file">file</option>
        </select>
        <input type="text" placeholder="source (command to run, or file path)" class="newListSource" style="flex:2;" />
        <input type="text" placeholder="pattern (optional regex)" class="newListPattern" style="flex:1;" />
        <input type="text" placeholder="insert template (default \${value})" class="newListTemplate" style="flex:1;" />
        <button class="primary small" data-add-list="${esc(tool.id)}" type="button">Read &amp; Add</button>
      </div>
    </div>`;

  const renderTool = (tool: ToolDefinition): string => {
    if (editingToolId === tool.id) {
      return `
    <div class="tool">
      <div class="toolHeader editForm">
        <input type="text" class="editCommand" value="${esc(tool.command)}" style="flex:2;" />
        <input type="text" class="editHelpArg" value="${esc(tool.helpArg || '--help')}" style="flex:1;" placeholder="--help" />
        <button class="primary small" data-save-edit="${esc(tool.id)}" type="button">Save &amp; Rescan</button>
        <button class="secondary small" id="cancelEdit" type="button">Cancel</button>
      </div>
    </div>`;
    }
    return `
    <div class="tool">
      <div class="toolHeader">
        <b>${esc(tool.command)}</b>
        ${tool.helpArg && tool.helpArg !== '--help' ? `<span class="hint">(${esc(tool.helpArg)})</span>` : ''}
        <span class="hint">${tool.lastScanned ? 'scanned ' + esc(new Date(tool.lastScanned).toLocaleString()) : 'never scanned'}</span>
        <button class="secondary small" data-edit-tool="${esc(tool.id)}" type="button">Edit</button>
        <button class="secondary small" data-rescan-tool="${esc(tool.id)}" type="button">Rescan All</button>
        <button class="secondary small" data-remove-tool="${esc(tool.id)}" type="button">Remove</button>
      </div>
      ${tool.variants.map(v => renderVariant(tool.id, v)).join('')}
      ${
        addingVariantForToolId === tool.id
          ? renderAddVariantForm(tool.id)
          : `<button class="secondary small" data-start-addvariant="${esc(tool.id)}" type="button" style="margin-top:10px;">+ Add sub-tool</button>`
      }
      ${renderLists(tool)}
    </div>`;
  };

  const pendingHtml = pendingAdd
    ? `
    <div class="pendingAdd">
      <h3>Add ${esc(pendingAdd.command)}</h3>
      <div class="hint">
        Top-level scan: ${pendingAdd.topLevel.options.length} option(s)${
        pendingAdd.topLevel.scanError ? ` — ${esc(pendingAdd.topLevel.scanError)}` : ''
      }
      </div>
      ${renderOptionRows(pendingAdd.topLevel.options)}
      ${
        pendingAdd.suggestedChoices.length > 0
          ? `<div class="hint" style="margin-top:14px;">Detected possible sub-commands — add as variants?</div>
             ${pendingAdd.suggestedChoices
               .map(
                 c =>
                   `<label class="check"><input type="checkbox" class="suggestedVariant" value="${esc(c)}" checked /> ${esc(c)}</label>`
               )
               .join('')}`
          : ''
      }
      <div id="manualVariants"></div>
      <button class="secondary" id="addVariantRow" type="button">+ Add sub-tool manually</button>
      <div class="hint">
        A sub-tool's <b>selector args</b> are what's inserted after the command to reach it, e.g.
        <code>regression</code> (positional) or <code>--regression</code> (flag) — whatever the tool itself expects.
      </div>
      <div class="actions">
        <button class="primary" id="confirmAdd">Scan &amp; Add</button>
        <button class="secondary" id="cancelAdd">Cancel</button>
      </div>
    </div>`
    : `
    <div class="addTool">
      <h3>Add a tool</h3>
      <label for="newCommand">Command</label>
      <input id="newCommand" type="text" placeholder="your_run_script.py or /path/to/tool" />
      <label for="newHelpArg">Help argument</label>
      <input id="newHelpArg" type="text" value="--help" />
      <div class="hint">Scanned through the same shell &amp; workspace setup chain a job uses (Shell &amp; Environment panel).</div>
      <div class="actions">
        <button class="primary" id="scanNew">Scan</button>
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Tool Setup</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 24px;
    max-width: 760px;
  }
  h2 { margin-top: 0; }
  h3 { margin-bottom: 8px; }
  label { display: block; margin-top: 14px; font-weight: 600; }
  input {
    width: 100%;
    box-sizing: border-box;
    margin-top: 6px;
    padding: 7px 9px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  label.check { display: flex; align-items: center; gap: 8px; font-weight: 400; margin-top: 6px; }
  label.check input { width: auto; margin-top: 0; }
  .hint { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .err { color: var(--vscode-errorForeground); }
  .actions { margin-top: 18px; display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    padding: 6px 16px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  button.small { padding: 2px 8px; font-size: 0.8em; margin-left: 8px; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .addTool, .pendingAdd, .tool {
    margin-top: 20px;
    padding: 14px 16px;
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
    border-radius: 4px;
  }
  .toolHeader { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .toolHeader.editForm input { margin-top: 0; }
  .variant { margin-top: 10px; border-top: 1px solid var(--vscode-input-border, rgba(127,127,127,0.2)); padding-top: 8px; }
  .variant summary { cursor: pointer; }
  .rawSummary { cursor: pointer; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  table.opts { border-collapse: collapse; margin-top: 8px; width: 100%; }
  table.opts td { padding: 2px 10px 2px 0; vertical-align: top; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  .favBtn {
    background: none; border: none; cursor: pointer; padding: 0 4px 0 0; font-size: 1em;
    color: var(--vscode-descriptionForeground);
  }
  .favBtn.favOn { color: var(--vscode-charts-yellow, #e2c08d); }
  pre {
    margin-top: 6px;
    padding: 8px;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1));
    border-radius: 3px;
    font-size: 0.8em;
    white-space: pre-wrap;
    max-height: 240px;
    overflow: auto;
  }
  .variantRow { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
  .variantRow input { margin-top: 0; }
  .lists { margin-top: 14px; border-top: 1px solid var(--vscode-input-border, rgba(127,127,127,0.2)); padding-top: 8px; }
  .listsHeading { font-weight: 600; }
  .listItem { margin-top: 8px; }
  .listHeader { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .listValues { font-family: var(--vscode-editor-font-family); margin-top: 2px; }
  .listRow { display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
  .listRow input, .listRow select { margin-top: 0; }
  .listRow select { width: auto; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
</style>
</head>
<body>
  <h2>Tool Setup</h2>
  <div class="hint">
    Register a tool's command and its <code>--help</code> output is scanned into checkable flags —
    used by a job's Configure form to build its Command field. Star a flag to surface it first in
    that builder. Re-scanned automatically on every window reload, in case the tool's own flags changed.
  </div>

  ${pendingHtml}

  ${tools.length > 0 ? tools.map(renderTool).join('') : '<div class="hint" style="margin-top:20px;">No tools registered yet.</div>'}

  <div class="actions">
    <button class="secondary" id="close">Close</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);

    function wire(selector, handler) {
      document.querySelectorAll(selector).forEach(btn => {
        btn.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          handler(btn);
        });
      });
    }

    wire('[data-rescan-tool]', btn => vscode.postMessage({ type: 'rescanTool', id: btn.getAttribute('data-rescan-tool') }));
    wire('[data-remove-tool]', btn => vscode.postMessage({ type: 'removeTool', id: btn.getAttribute('data-remove-tool') }));
    wire('[data-edit-tool]', btn => vscode.postMessage({ type: 'startEdit', id: btn.getAttribute('data-edit-tool') }));
    wire('[data-start-addvariant]', btn => vscode.postMessage({ type: 'startAddVariant', id: btn.getAttribute('data-start-addvariant') }));
    wire('[data-rescan-variant-id]', btn =>
      vscode.postMessage({
        type: 'rescanVariant',
        id: btn.getAttribute('data-rescan-variant-id'),
        label: btn.getAttribute('data-rescan-variant-label')
      })
    );
    wire('[data-remove-variant-id]', btn =>
      vscode.postMessage({
        type: 'removeVariant',
        id: btn.getAttribute('data-remove-variant-id'),
        label: btn.getAttribute('data-remove-variant-label')
      })
    );
    wire('[data-fav-id]', btn =>
      vscode.postMessage({
        type: 'toggleFavorite',
        id: btn.getAttribute('data-fav-id'),
        label: btn.getAttribute('data-fav-label'),
        flagsKey: btn.getAttribute('data-fav-key')
      })
    );
    wire('[data-add-list]', btn => {
      const wrap = btn.closest('.listRow');
      vscode.postMessage({
        type: 'addList',
        id: btn.getAttribute('data-add-list'),
        name: wrap.querySelector('.newListName').value,
        sourceType: wrap.querySelector('.newListSourceType').value,
        source: wrap.querySelector('.newListSource').value,
        pattern: wrap.querySelector('.newListPattern').value,
        insertTemplate: wrap.querySelector('.newListTemplate').value
      });
    });
    wire('[data-refresh-list-id]', btn =>
      vscode.postMessage({
        type: 'refreshList',
        id: btn.getAttribute('data-refresh-list-id'),
        name: btn.getAttribute('data-refresh-list-name')
      })
    );
    wire('[data-remove-list-id]', btn =>
      vscode.postMessage({
        type: 'removeList',
        id: btn.getAttribute('data-remove-list-id'),
        name: btn.getAttribute('data-remove-list-name')
      })
    );
    wire('[data-save-edit]', btn => {
      const wrap = btn.closest('.tool');
      vscode.postMessage({
        type: 'saveEdit',
        id: btn.getAttribute('data-save-edit'),
        command: wrap.querySelector('.editCommand').value,
        helpArg: wrap.querySelector('.editHelpArg').value
      });
    });
    wire('[data-confirm-addvariant]', btn => {
      const wrap = btn.closest('.tool');
      vscode.postMessage({
        type: 'confirmAddVariant',
        id: btn.getAttribute('data-confirm-addvariant'),
        label: wrap.querySelector('.newVariantLabel').value,
        selectArgs: wrap.querySelector('.newVariantArgs').value
      });
    });
    if ($('cancelEdit')) {
      $('cancelEdit').addEventListener('click', () => vscode.postMessage({ type: 'cancelEdit' }));
    }
    if ($('cancelAddVariant')) {
      $('cancelAddVariant').addEventListener('click', () => vscode.postMessage({ type: 'cancelAddVariant' }));
    }

    if ($('scanNew')) {
      $('scanNew').addEventListener('click', () => {
        vscode.postMessage({ type: 'scanNew', command: $('newCommand').value, helpArg: $('newHelpArg').value });
      });
      $('newCommand').focus();
    }

    if ($('addVariantRow')) {
      $('addVariantRow').addEventListener('click', () => {
        const row = document.createElement('div');
        row.className = 'variantRow';
        row.innerHTML =
          '<input type="text" placeholder="label (e.g. regression)" class="manualLabel" style="flex:1;" />' +
          '<input type="text" placeholder="selector args (e.g. --regression)" class="manualArgs" style="flex:1;" />' +
          '<button class="secondary small" type="button">Remove</button>';
        row.querySelector('button').addEventListener('click', () => row.remove());
        $('manualVariants').appendChild(row);
      });
    }

    if ($('confirmAdd')) {
      $('confirmAdd').addEventListener('click', () => {
        const variants = [];
        document.querySelectorAll('.suggestedVariant:checked').forEach(cb => {
          variants.push({ label: cb.value, selectArgs: cb.value });
        });
        document.querySelectorAll('#manualVariants .variantRow').forEach(row => {
          const label = row.querySelector('.manualLabel').value;
          const selectArgs = row.querySelector('.manualArgs').value;
          if (label.trim() && selectArgs.trim()) {
            variants.push({ label, selectArgs });
          }
        });
        vscode.postMessage({ type: 'confirmAdd', variants });
      });
    }
    if ($('cancelAdd')) {
      $('cancelAdd').addEventListener('click', () => vscode.postMessage({ type: 'cancelAdd' }));
    }

    $('close').addEventListener('click', () => vscode.postMessage({ type: 'close' }));
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
