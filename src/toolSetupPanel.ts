import * as vscode from 'vscode';
import { ToolStore } from './toolStore';
import { JobStore } from './jobStore';
import { ToolDefinition, ToolList, ToolOption, ToolVariant } from './types';
import { scanVariant, scanTool, scanLists, discoverList } from './toolIntrospect';
import { detectSubcommandChoices, mergeFavorites, parseChoices } from './toolOptionParser';
import { HELP_CSS, help } from './webviewHelp';
import { BUILTIN_SEED_PATTERNS } from './seedDetect';

interface ScanNewMessage {
  type: 'scanNew';
  command: string;
  helpArg: string;
  displayName: string;
  scanDir: string;
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
  displayName: string;
  scanDir: string;
  seedPattern: string;
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
interface SetOptionValueSourceMessage {
  type: 'setOptionValueSource';
  id: string;
  label: string;
  flagsKey: string;
  listName: string;
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
  | SetOptionValueSourceMessage
  | AddListMessage
  | RefreshListMessage
  | RemoveListMessage
  | CloseMessage;

interface PendingAdd {
  command: string;
  helpArg: string;
  displayName: string;
  scanDir: string;
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
        const displayName = msg.displayName.trim();
        const scanDir = msg.scanDir.trim();
        const result = await scanVariant(command, [], helpArg, this.jobStore, this.folder, scanDir || undefined);
        this.pendingAdd = {
          command,
          helpArg,
          displayName,
          scanDir,
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
          const result = await scanVariant(
            pending.command,
            selectArgs,
            pending.helpArg,
            this.jobStore,
            this.folder,
            pending.scanDir || undefined
          );
          variants.push({ label, selectArgs, options: result.options, rawHelp: result.rawHelp, scanError: result.scanError });
        }
        await this.toolStore.addTool({
          command: pending.command,
          helpArg: pending.helpArg,
          displayName: pending.displayName || undefined,
          scanDir: pending.scanDir || undefined,
          variants,
          lastScanned: Date.now()
        });
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
        const result = await scanVariant(
          tool.command,
          tool.variants[idx].selectArgs,
          helpArg,
          this.jobStore,
          this.folder,
          tool.scanDir
        );
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
        const displayName = msg.displayName.trim();
        const scanDir = msg.scanDir.trim();
        const seedPattern = msg.seedPattern.trim();
        await this.toolStore.updateTool(msg.id, {
          command,
          helpArg,
          displayName: displayName || undefined,
          scanDir: scanDir || undefined,
          seedPattern: seedPattern || undefined
        });
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
        const result = await scanVariant(tool.command, selectArgs, helpArg, this.jobStore, this.folder, tool.scanDir);
        // Re-adding a label that already exists (nothing in the UI stops
        // this) used to be a bare replace, silently discarding the previous
        // variant's favorites and value-list attachments entirely -- route
        // it through the same merge every rescan path already uses instead.
        const existing = tool.variants.find(v => v.label === label);
        const options = existing ? mergeFavorites(existing.options, result.options) : result.options;
        const variants = tool.variants.filter(v => v.label !== label);
        variants.push({ label, selectArgs, options, rawHelp: result.rawHelp, scanError: result.scanError });
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

      case 'setOptionValueSource': {
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
            o.flags.join('|') === msg.flagsKey ? { ...o, valueListName: msg.listName || undefined } : o
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
        const discovered = await discoverList(list, this.jobStore, this.folder, tool.scanDir);
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
        lists[idx] = await discoverList(lists[idx], this.jobStore, this.folder, tool.scanDir);
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

  // For the Seed pattern paste-and-preview tester -- regex source (not the
  // RegExp object itself, which doesn't survive JSON.stringify) plus label,
  // re-compiled client-side so the live preview needs no host round-trip.
  const seedPatternsJson = JSON.stringify(BUILTIN_SEED_PATTERNS.map(p => ({ label: p.label, source: p.pattern.source }))).replace(
    /</g,
    '\\u003c'
  );

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

  const renderOptionRowsEditable = (tool: ToolDefinition, variantLabel: string, options: ToolOption[]): string => {
    if (options.length === 0) {
      return '<div class="hint">No options detected.</div>';
    }
    const lists = tool.lists ?? [];
    const sorted = [...options].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
    return `<input type="text" class="optFilterTool" placeholder="Filter flags…" />
    <table class="opts">${sorted
      .map(o => {
        const key = o.flags.join('|');
        const valueSourceCell =
          o.metavar && lists.length > 0
            ? `<td><select class="valueSourceSelect" data-vs-id="${esc(tool.id)}" data-vs-label="${esc(
                variantLabel
              )}" data-vs-key="${esc(key)}" title="Where this flag's value comes from">
                <option value="">free text</option>
                ${lists
                  .map(
                    l =>
                      `<option value="${esc(l.name)}" ${o.valueListName === l.name ? 'selected' : ''}>${esc(l.name)}</option>`
                  )
                  .join('')}
              </select></td>`
            : '<td></td>';
        return `<tr>
          <td><button class="favBtn ${o.favorite ? 'favOn' : ''}" data-fav-id="${esc(tool.id)}" data-fav-label="${esc(
          variantLabel
        )}" data-fav-key="${esc(key)}" title="${o.favorite ? 'Unfavorite' : 'Favorite'}" type="button">${
          o.favorite ? '★' : '☆'
        }</button></td>
          <td>${esc(o.flags.join(', '))}${metavarHtml(o.metavar)}</td>
          <td class="hint">${esc(o.description ?? '')}</td>
          ${valueSourceCell}
        </tr>`;
      })
      .join('')}</table>`;
  };

  const renderVariant = (tool: ToolDefinition, v: ToolVariant): string => {
    const label = v.label || '(top-level)';
    return `<details class="variant" open>
      <summary>${esc(label)} — ${v.options.length} option${v.options.length === 1 ? '' : 's'}${
      v.scanError ? ' <span class="err">⚠ scan issue</span>' : ''
    }
        <button class="secondary small" data-rescan-variant-id="${esc(tool.id)}" data-rescan-variant-label="${esc(v.label)}" type="button">Rescan</button>
        ${
          v.label !== ''
            ? `<button class="secondary small" data-remove-variant-id="${esc(tool.id)}" data-remove-variant-label="${esc(v.label)}" type="button">Remove sub-tool</button>`
            : ''
        }
      </summary>
      ${v.scanError ? `<div class="err">${esc(v.scanError)}</div>` : ''}
      ${renderOptionRowsEditable(tool, v.label, v.options)}
      <details><summary class="rawSummary">raw help output</summary><pre>${esc(v.rawHelp ?? '')}</pre></details>
    </details>`;
  };

  const renderAddVariantForm = (toolId: string): string => `
    <div class="variantRow" style="margin-top:12px;">
      <input type="text" placeholder="label (e.g. regression)" class="newVariantLabel" style="flex:1;" />
      <input type="text" placeholder="selector args (e.g. --regression)" class="newVariantArgs" style="flex:1;" />
      <button class="primary small" data-confirm-addvariant="${esc(toolId)}" type="button">Add</button>
      <button class="secondary small" id="cancelAddVariant" type="button">Cancel</button>
    </div>`;

  const renderList = (toolId: string, l: ToolList): string => {
    const src = l.command ? `command: <code>${esc(l.command)}</code>` : l.file ? `file: <code>${esc(l.file)}</code>` : '<span class="err">no source</span>';
    const status = l.scanError
      ? `<span class="err">⚠ ${esc(l.scanError)}</span>`
      : `${l.values.length} value${l.values.length === 1 ? '' : 's'}`;
    return `<div class="listItem">
      <div class="listHeader">
        <b>${esc(l.name)}</b> <span class="hint">${src}${l.pattern ? ` · pattern <code>${esc(l.pattern)}</code>` : ''} · ${status}</span>
        <button class="secondary small" data-refresh-list-id="${esc(toolId)}" data-refresh-list-name="${esc(l.name)}" type="button">↻ Refresh</button>
        <button class="secondary small" data-remove-list-id="${esc(toolId)}" data-remove-list-name="${esc(l.name)}" type="button">Remove</button>
      </div>
      ${l.values.length > 0 ? `<div class="hint listValues">${l.values.slice(0, 12).map(esc).join(', ')}${l.values.length > 12 ? `, …(+${l.values.length - 12})` : ''}</div>` : ''}
    </div>`;
  };

  const renderLists = (tool: ToolDefinition): string => `
    <div class="lists">
      <div class="listsHeading">Value lists ${help(
        'Discovered values for a dropdown. <b>Attach one to a flag</b> using that ' +
          "flag's \"value source\" column above (in a variant's option table) to " +
          "make it that flag's dropdown — the usual case. Leave a list unattached " +
          'for a value with no real CLI flag to attach to (e.g. a plusarg like ' +
          '<code>+UVM_TESTNAME=</code>) — an unattached list keeps its own row ' +
          'below, with an insert template controlling exactly how a picked value ' +
          'is written into the Command.'
      )}</div>
      ${(tool.lists ?? []).map(l => renderList(tool.id, l)).join('')}
      <div class="listRow">
        <input type="text" placeholder="name (e.g. Test)" class="newListName" style="flex:1;" />
        <select class="newListSourceType">
          <option value="command">command</option>
          <option value="file">file</option>
        </select>
        <input type="text" placeholder="source (command to run, or file path)" class="newListSource" style="flex:2;" />
        <input type="text" placeholder="pattern (optional regex)" class="newListPattern" style="flex:1;" />
        <input type="text" placeholder="insert template, for an unattached list (default \${value})" class="newListTemplate" style="flex:1;" />
        <button class="primary small" data-add-list="${esc(tool.id)}" type="button">Add</button>
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
      <details class="advancedFields">
        <summary>Advanced (name, scan directory)</summary>
        <label>Display name ${help('Friendly label shown wherever this tool is listed. Leave blank to just show the command.')}</label>
        <input type="text" class="editDisplayName" value="${esc(tool.displayName ?? '')}" placeholder="${esc(tool.command)}" />
        <label>Scan directory ${help(
          "Directory this tool's scans/rescans run from. Leave blank to use the workspace's postSetupCwd setting. " +
            'Register the same command twice with different scan directories (and names) if colleagues keep separate copies in different folders.'
        )}</label>
        <input type="text" class="editScanDir" value="${esc(tool.scanDir ?? '')}" placeholder="(workspace default)" />
        <label>Seed pattern (regex, optional) ${help(
          "Recovers a run's seed for the Log Viewer's Seed column when a job's Command doesn't use " +
            '<code>${randomSeed}</code> (whose value is already captured directly). Capture group 1 is the seed. ' +
            "Overrides the built-in guessed patterns for every job using this tool. Leave blank to just use the guesses."
        )}</label>
        <input type="text" class="editSeedPattern" value="${esc(tool.seedPattern ?? '')}" placeholder="e.g. MY_SEED=(\\d+)" />
        <div class="seedTester">
          <label>Try it: paste a sample log line</label>
          <textarea class="seedTesterSample" rows="2" placeholder="paste a line from a real run's output here"></textarea>
          <div class="hint seedTesterResult">Detected seed: <i>(nothing pasted yet)</i></div>
        </div>
      </details>
    </div>`;
    }
    return `
    <div class="tool">
      <div class="toolHeader">
        <b>${esc(tool.displayName || tool.command)}</b>
        ${tool.displayName ? `<span class="hint"><code>${esc(tool.command)}</code></span>` : ''}
        ${tool.helpArg && tool.helpArg !== '--help' ? `<span class="hint">(${esc(tool.helpArg)})</span>` : ''}
        ${tool.scanDir ? `<span class="hint">scans from <code>${esc(tool.scanDir)}</code></span>` : ''}
        <span class="hint">${tool.lastScanned ? 'scanned ' + esc(new Date(tool.lastScanned).toLocaleString()) : 'never scanned'}</span>
        <button class="secondary small" data-edit-tool="${esc(tool.id)}" type="button">Edit</button>
        <button class="secondary small" data-rescan-tool="${esc(tool.id)}" type="button">Rescan All</button>
        <button class="secondary small" data-remove-tool="${esc(tool.id)}" type="button">Remove</button>
      </div>
      ${tool.variants.map(v => renderVariant(tool, v)).join('')}
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
      <h3>Add ${esc(pendingAdd.displayName || pendingAdd.command)}</h3>
      ${pendingAdd.displayName ? `<div class="hint"><code>${esc(pendingAdd.command)}</code></div>` : ''}
      ${pendingAdd.scanDir ? `<div class="hint">scanning from <code>${esc(pendingAdd.scanDir)}</code></div>` : ''}
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
      ${help(
        "A sub-tool's <b>selector args</b> are what's inserted after the command to reach it, e.g. " +
          '<code>regression</code> (positional) or <code>--regression</code> (flag) — whatever the tool itself expects.'
      )}
      <div class="actions">
        <button class="primary" id="confirmAdd">Add</button>
        <button class="secondary" id="cancelAdd">Cancel</button>
      </div>
    </div>`
    : `
    <div class="addTool">
      <h3>Add a tool</h3>
      <label for="newCommand">Command</label>
      <input id="newCommand" type="text" placeholder="your_run_script.py or /path/to/tool" />
      <label for="newHelpArg">Help argument ${help(
        'Scanned through the same shell &amp; workspace setup chain a job uses (Shell &amp; Environment panel).'
      )}</label>
      <input id="newHelpArg" type="text" value="--help" />
      <details class="advancedFields">
        <summary>Advanced (name, scan directory)</summary>
        <label for="newDisplayName">Display name</label>
        <input id="newDisplayName" type="text" placeholder="(defaults to the command)" />
        <label for="newScanDir">Scan directory ${help(
          "Leave blank to use the workspace's postSetupCwd setting. Set this (with a distinguishing display name) to register the same command a second time for a different folder, e.g. colleagues keeping separate copies in work1/work2."
        )}</label>
        <input id="newScanDir" type="text" placeholder="(workspace default)" />
      </details>
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
    max-width: min(1200px, 100%);
    width: 100%;
  }
  h2 { margin-top: 0; }
  h3 { margin-bottom: 8px; }
  label { display: block; margin-top: 14px; font-weight: 600; }
  input {
    width: 100%;
    box-sizing: border-box;
    margin-top: 6px;
    padding: 9px 12px;
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
  ${HELP_CSS}
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
  .optFilterTool { margin-top: 8px; }
  table.opts { border-collapse: collapse; margin-top: 8px; width: 100%; }
  table.opts td { padding: 2px 10px 2px 0; vertical-align: top; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  table.opts select.valueSourceSelect { width: auto; margin-top: 0; padding: 2px 6px; font-size: 0.85em; }
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
  .seedTester { margin-top: 10px; padding: 8px 10px; border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.25)); border-radius: 4px; }
  .seedTester label { margin-top: 0; font-weight: 400; }
  .seedTester textarea { width: 100%; box-sizing: border-box; margin-top: 4px; font-family: var(--vscode-editor-font-family); font-size: 0.85em; resize: vertical; }
  .seedTesterResult { margin-top: 6px; }
  .busyOverlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.35);
    color: #fff;
    font-size: 1.1em;
    font-family: var(--vscode-font-family);
  }
</style>
</head>
<body>
  <h2>Tool Setup ${help(
    "Register a tool's command and its <code>--help</code> output is scanned into checkable flags — " +
      "used by a job's Configure form to build its Command field. Star a flag to surface it first in " +
      "that builder. Re-scanned automatically on every window reload, in case the tool's own flags changed."
  )}</h2>

  ${pendingHtml}

  ${tools.length > 0 ? tools.map(renderTool).join('') : '<div class="hint" style="margin-top:20px;">No tools registered yet.</div>'}

  <div class="actions">
    <button class="secondary" id="close">Close</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);

    // Mirrors seedDetect.ts's detectSeed exactly, client-side, so the
    // paste-and-preview tester needs no host round-trip: try the tool's own
    // custom pattern first (if it compiles and matches), then each built-in
    // guessed pattern in order. BUILTIN_SEED_PATTERNS ships as {label,
    // source} (a RegExp doesn't survive JSON.stringify) and is recompiled
    // here.
    const BUILTIN_SEED_PATTERNS = (${seedPatternsJson}).map(p => ({ label: p.label, pattern: new RegExp(p.source, 'i') }));
    function detectSeedPreview(text, customSource) {
      const custom = (customSource || '').trim();
      if (custom) {
        try {
          const m = new RegExp(custom, 'i').exec(text);
          if (m && m[1]) { return { value: m[1], via: 'custom pattern' }; }
        } catch {
          // Invalid regex -- fall through to the builtins, same as the real detectSeed.
        }
      }
      for (const { label, pattern } of BUILTIN_SEED_PATTERNS) {
        const m = pattern.exec(text);
        if (m && m[1]) { return { value: m[1], via: label }; }
      }
      return null;
    }
    (function wireSeedTesters() {
      document.querySelectorAll('.tool').forEach(toolEl => {
        const patternEl = toolEl.querySelector('.editSeedPattern');
        const sampleEl = toolEl.querySelector('.seedTesterSample');
        const resultEl = toolEl.querySelector('.seedTesterResult');
        if (!patternEl || !sampleEl || !resultEl) { return; }
        const update = () => {
          const sample = sampleEl.value;
          if (!sample.trim()) {
            resultEl.innerHTML = 'Detected seed: <i>(nothing pasted yet)</i>';
            return;
          }
          const found = detectSeedPreview(sample, patternEl.value);
          resultEl.innerHTML = found
            ? 'Detected seed: <b>' + found.value.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</b> (via ' + found.via.replace(/&/g, '&amp;').replace(/</g, '&lt;') + ')'
            : 'Detected seed: <i>no match</i>';
        };
        patternEl.addEventListener('input', update);
        sampleEl.addEventListener('input', update);
      });
    })();

    // Preserve scroll position across a render() -- a full panel.webview.html
    // reassignment (every state change here does one) reloads the document,
    // which would otherwise reset scroll to the top on e.g. a favorite toggle.
    // The webview's own state object (unlike the DOM/JS) survives that reassignment.
    (function restoreScroll() {
      const s = vscode.getState();
      if (s && typeof s.scrollY === 'number') {
        window.scrollTo(0, s.scrollY);
      }
    })();
    let scrollSaveQueued = false;
    window.addEventListener('scroll', () => {
      if (scrollSaveQueued) { return; }
      scrollSaveQueued = true;
      requestAnimationFrame(() => {
        vscode.setState(Object.assign({}, vscode.getState(), { scrollY: window.scrollY }));
        scrollSaveQueued = false;
      });
    });

    // A visible "Scanning…" overlay for the handful of actions that spawn a
    // real process (scan/rescan/list-discovery) and wait on the extension
    // host. No teardown needed -- render() always replaces the whole
    // document once the awaited work finishes, taking the overlay with it.
    function showBusy(msg) {
      const overlay = document.createElement('div');
      overlay.className = 'busyOverlay';
      overlay.textContent = msg || 'Scanning…';
      document.body.appendChild(overlay);
    }

    function wire(selector, handler) {
      document.querySelectorAll(selector).forEach(btn => {
        btn.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          handler(btn);
        });
      });
    }

    wire('[data-rescan-tool]', btn => {
      showBusy();
      vscode.postMessage({ type: 'rescanTool', id: btn.getAttribute('data-rescan-tool') });
    });
    wire('[data-remove-tool]', btn => vscode.postMessage({ type: 'removeTool', id: btn.getAttribute('data-remove-tool') }));
    wire('[data-edit-tool]', btn => vscode.postMessage({ type: 'startEdit', id: btn.getAttribute('data-edit-tool') }));
    wire('[data-start-addvariant]', btn => vscode.postMessage({ type: 'startAddVariant', id: btn.getAttribute('data-start-addvariant') }));
    wire('[data-rescan-variant-id]', btn => {
      showBusy();
      vscode.postMessage({
        type: 'rescanVariant',
        id: btn.getAttribute('data-rescan-variant-id'),
        label: btn.getAttribute('data-rescan-variant-label')
      });
    });
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
    document.querySelectorAll('.valueSourceSelect').forEach(sel => {
      sel.addEventListener('change', () => {
        vscode.postMessage({
          type: 'setOptionValueSource',
          id: sel.getAttribute('data-vs-id'),
          label: sel.getAttribute('data-vs-label'),
          flagsKey: sel.getAttribute('data-vs-key'),
          listName: sel.value
        });
      });
    });
    document.querySelectorAll('.optFilterTool').forEach(input => {
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const scope = input.closest('.variant');
        if (!scope) { return; }
        scope.querySelectorAll('table.opts tr').forEach(tr => {
          const text = tr.textContent.toLowerCase();
          tr.style.display = !q || text.includes(q) ? '' : 'none';
        });
      });
    });
    wire('[data-add-list]', btn => {
      const wrap = btn.closest('.listRow');
      showBusy();
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
    wire('[data-refresh-list-id]', btn => {
      showBusy();
      vscode.postMessage({
        type: 'refreshList',
        id: btn.getAttribute('data-refresh-list-id'),
        name: btn.getAttribute('data-refresh-list-name')
      });
    });
    wire('[data-remove-list-id]', btn =>
      vscode.postMessage({
        type: 'removeList',
        id: btn.getAttribute('data-remove-list-id'),
        name: btn.getAttribute('data-remove-list-name')
      })
    );
    wire('[data-save-edit]', btn => {
      const wrap = btn.closest('.tool');
      showBusy();
      vscode.postMessage({
        type: 'saveEdit',
        id: btn.getAttribute('data-save-edit'),
        command: wrap.querySelector('.editCommand').value,
        helpArg: wrap.querySelector('.editHelpArg').value,
        displayName: wrap.querySelector('.editDisplayName').value,
        scanDir: wrap.querySelector('.editScanDir').value,
        seedPattern: wrap.querySelector('.editSeedPattern').value
      });
    });
    wire('[data-confirm-addvariant]', btn => {
      const wrap = btn.closest('.tool');
      showBusy();
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
        showBusy();
        vscode.postMessage({
          type: 'scanNew',
          command: $('newCommand').value,
          helpArg: $('newHelpArg').value,
          displayName: $('newDisplayName').value,
          scanDir: $('newScanDir').value
        });
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
        showBusy();
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
