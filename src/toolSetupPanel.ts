import * as vscode from 'vscode';
import { ToolStore } from './toolStore';
import { JobStore } from './jobStore';
import { ToolDefinition, ToolOption, ToolVariant, ValueList, JobsFileSetup } from './types';
import { scanVariant, scanTool } from './toolIntrospect';
import { detectSubcommandChoices, mergeFavorites, parseChoices, parseHelpOutputDeep } from './toolOptionParser';
import { HELP_CSS, help } from './webviewHelp';
import { BROWSE_CSS, BROWSE_JS, BrowseMessage, handleBrowseMessage } from './webviewBrowse';
import { CLIENT_ERROR_JS, ClientErrorMessage, handleClientErrorMessage } from './webviewError';
import { runProbeChecks } from './webviewProbe';
import { SETUP_ERROR_CSS, OPEN_STEP_JS, setupErrorHtml, StepId } from './webviewSteps';
import { buildSetupChain } from './setupChain';
import { BUILTIN_SEED_PATTERNS } from './seedDetect';
import { shellQuote } from './shellQuote';

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
  errorPattern: string;
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
interface CloseMessage {
  type: 'close';
}
interface FindItMessage {
  type: 'findIt';
  requestId: number;
  command: string;
  scanDir: string;
}
interface TryHelpArgMessage {
  type: 'tryHelpArg';
  id: string;
  helpArg: string;
}
/**
 * "Search deeper": re-parse a variant's already-captured `rawHelp` with the
 * looser `parseHelpOutputDeep` rules instead of re-running the tool -- for
 * help text whose format the default scan's conservative parser can't read
 * (see toolOptionParser.ts). Only offered when a scan found zero options.
 */
interface DeepParseVariantMessage {
  type: 'deepParseVariant';
  id: string;
  label: string;
}
/** Same as DeepParseVariantMessage, but for the top-level scan of a tool that hasn't been added yet (`pendingAdd`). */
interface DeepParsePendingMessage {
  type: 'deepParsePending';
}
interface OpenStepMessage {
  type: 'openStep';
  step: StepId;
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
  | CloseMessage
  | FindItMessage
  | TryHelpArgMessage
  | DeepParseVariantMessage
  | DeepParsePendingMessage
  | OpenStepMessage
  | BrowseMessage
  | ClientErrorMessage;

interface PendingAdd {
  command: string;
  helpArg: string;
  displayName: string;
  scanDir: string;
  topLevel: { options: ToolOption[]; rawHelp: string; scanError?: string; probeCommand?: string };
  suggestedChoices: string[];
}

export class ToolSetupPanel {
  private static current: ToolSetupPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingAdd: PendingAdd | undefined;
  private editingToolId: string | undefined;
  private addingVariantForToolId: string | undefined;

  static createOrShow(
    toolStore: ToolStore,
    jobStore: JobStore,
    folder: vscode.WorkspaceFolder
  ): void {
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
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
        // A rejected promise here (e.g. an I/O error mid-scan) would
        // otherwise be an unhandled rejection VS Code's event emitter never
        // surfaces -- the panel just silently stops responding to that
        // message with no indication why.
        this.onMessage(msg).catch(err => {
          void vscode.window.showErrorMessage(`EDA Job Runner: ${err instanceof Error ? err.message : String(err)}`);
        });
      }),
      this.panel.onDidDispose(() => this.cleanup())
    );
  }

  private render(): void {
    this.panel.webview.html = renderHtml(
      this.panel.webview,
      this.toolStore.getTools(),
      this.jobStore.getLists(),
      this.pendingAdd,
      this.editingToolId,
      this.addingVariantForToolId,
      this.jobStore.getSetup(),
      this.folder.uri.fsPath
    );
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'close':
        this.panel.dispose();
        return;

      case 'browse':
        return handleBrowseMessage(msg, this.panel.webview, this.folder);

      case 'clientError':
        return handleClientErrorMessage(msg);

      case 'openStep':
        await vscode.commands.executeCommand(
          msg.step === 1
            ? 'eda-job-runner.configureShell'
            : msg.step === 2
              ? 'eda-job-runner.configureTools'
              : msg.step === 3
                ? 'eda-job-runner.addJob'
                : 'eda-job-runner.configureParams'
        );
        return;

      case 'findIt': {
        const command = msg.command.trim();
        if (!command) {
          void this.panel.webview.postMessage({ type: 'foundIt', requestId: msg.requestId, ok: false, output: '' });
          return;
        }
        const config = vscode.workspace.getConfiguration('eda-job-runner', this.folder.uri);
        const shellPath = config.get<string>('shellPath', 'bash');
        const shellArgs = config.get<string[] | null>('shellArgs', null);
        const env = config.get<Record<string, string>>('env', {});
        const postSetupCwd = config.get<string>('postSetupCwd', '');
        const cwd = (msg.scanDir.trim() || postSetupCwd) || undefined;
        const run = await runProbeChecks(
          [`command -v ${shellQuote(command)}`],
          { path: shellPath, args: shellArgs, env },
          this.jobStore.getSetup() ?? {},
          cwd,
          this.folder
        );
        const result = run.results[0];
        void this.panel.webview.postMessage({
          type: 'foundIt',
          requestId: msg.requestId,
          ok: !run.launchError && result.ok,
          output: run.launchError ?? result.output
        });
        return;
      }

      case 'tryHelpArg': {
        const tool = this.toolStore.getTool(msg.id);
        if (!tool) {
          return;
        }
        await this.toolStore.updateTool(msg.id, { helpArg: msg.helpArg });
        const updated = this.toolStore.getTool(msg.id);
        if (updated) {
          const variants = await scanTool(updated, this.jobStore, this.folder);
          await this.toolStore.updateTool(msg.id, { variants, lastScanned: Date.now() });
        }
        this.render();
        return;
      }

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
          topLevel: { options: result.options, rawHelp: result.rawHelp, scanError: result.scanError, probeCommand: result.probeCommand },
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
        await this.toolStore.updateTool(msg.id, { variants, lastScanned: Date.now() });
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
        // Re-read the tool after the await instead of splicing back into the
        // pre-await snapshot -- a concurrent rescan of a different variant on
        // this same tool may have already written its own update, and
        // splicing into the stale `tool.variants` here would silently
        // discard it.
        const freshTool = this.toolStore.getTool(msg.id);
        if (!freshTool) {
          return;
        }
        const freshIdx = freshTool.variants.findIndex(v => v.label === msg.label);
        if (freshIdx === -1) {
          return;
        }
        const variants = freshTool.variants.slice();
        variants[freshIdx] = {
          ...variants[freshIdx],
          options: mergeFavorites(variants[freshIdx].options, result.options),
          rawHelp: result.rawHelp,
          scanError: result.scanError
        };
        await this.toolStore.updateTool(msg.id, { variants, lastScanned: Date.now() });
        this.render();
        return;
      }

      case 'deepParseVariant': {
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
          options: mergeFavorites(variants[idx].options, parseHelpOutputDeep(variants[idx].rawHelp ?? ''))
        };
        await this.toolStore.updateTool(msg.id, { variants });
        this.render();
        return;
      }

      case 'deepParsePending': {
        const pending = this.pendingAdd;
        if (!pending) {
          return;
        }
        this.pendingAdd = {
          ...pending,
          topLevel: {
            ...pending.topLevel,
            options: parseHelpOutputDeep(pending.topLevel.rawHelp ?? '')
          }
        };
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
        const errorPattern = msg.errorPattern.trim();
        await this.toolStore.updateTool(msg.id, {
          command,
          helpArg,
          displayName: displayName || undefined,
          scanDir: scanDir || undefined,
          seedPattern: seedPattern || undefined,
          errorPattern: errorPattern || undefined
        });
        const updated = this.toolStore.getTool(msg.id);
        if (updated) {
          const variants = await scanTool(updated, this.jobStore, this.folder);
          await this.toolStore.updateTool(msg.id, { variants, lastScanned: Date.now() });
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
        // Re-read the tool after the await for the same reason as
        // rescanVariant above -- a concurrent scan on another variant of
        // this tool may have written its own update in the meantime.
        const freshTool = this.toolStore.getTool(msg.id);
        if (!freshTool) {
          return;
        }
        // Re-adding a label that already exists (nothing in the UI stops
        // this) used to be a bare replace, silently discarding the previous
        // variant's favorites and value-list attachments entirely -- route
        // it through the same merge every rescan path already uses instead.
        const existing = freshTool.variants.find(v => v.label === label);
        const options = existing ? mergeFavorites(existing.options, result.options) : result.options;
        const variants = freshTool.variants.filter(v => v.label !== label);
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
        // No this.render() -- a favorite-star click is the highest-frequency
        // interaction in this panel, and the client already patched its own
        // DOM (icon + re-sort) the moment it was clicked, matching this same
        // sort order (see the client script's fav click handler). A full
        // webview.html reassignment here would just discard the filter text,
        // open <details>, focus, and scroll position for no visible benefit.
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
        // No this.render() -- the <select> the user just changed already
        // shows its new value natively; nothing else on the page depends on
        // valueListName, so there's nothing to patch or re-render at all.
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

export function renderHtml(
  webview: vscode.Webview,
  tools: ToolDefinition[],
  lists: ValueList[],
  pendingAdd: PendingAdd | undefined,
  editingToolId: string | undefined,
  addingVariantForToolId: string | undefined,
  setup?: JobsFileSetup,
  workspaceRoot?: string
): string {
  const nonce = getNonce();
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const effectiveRoot = workspaceRoot ?? '';

  /** Distinguishes the scan outcomes so the remedy shown matches the actual cause (T1.3 item 7). */
  const EXEC_FAILURE = /command not found|is not recognized as an internal or external command|no such file or directory|permission denied/i;
  const classifyOutcome = (v: { rawHelp?: string; scanError?: string; options?: unknown[] }): 'launchFailed' | 'commandNotFound' | 'printedNothing' | 'nothingParsed' | 'ok' => {
    if (!v.scanError) {
      return 'ok';
    }
    if (v.scanError.startsWith('Failed to launch shell')) {
      return 'launchFailed';
    }
    if (v.rawHelp && EXEC_FAILURE.test(v.rawHelp)) {
      return 'commandNotFound';
    }
    if (!v.rawHelp || v.rawHelp.trim().length === 0) {
      return 'printedNothing';
    }
    return 'nothingParsed';
  };

  const outcomeMessage = (outcome: 'launchFailed' | 'commandNotFound' | 'printedNothing' | 'nothingParsed' | 'ok', scanError: string): string => {
    if (outcome === 'launchFailed' || outcome === 'ok') {
      return scanError;
    }
    if (outcome === 'printedNothing') {
      return 'The command ran but printed nothing. It may need a different help argument.';
    }
    if (outcome === 'commandNotFound') {
      return `This command doesn't seem to run in your configured shell (${scanError}) — check the path is correct, and that a script is executable (chmod +x) or invoked through its interpreter (e.g. \`python script.py\`, not the script alone).`;
    }
    return `Ran and produced output, but no recognisable flags were found (${scanError}).`;
  };

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
    // `lists` here is renderHtml's own parameter (the workspace-wide list
    // array) via closure -- every tool's options can pick from the same set.
    // Embedded per-row as data-orig-idx (below) so the client-side favorite
    // toggle (see toggleFavorite's wire() handler) can re-sort using this
    // same original-definition order as its tiebreak, exactly like this
    // sort's stable behavior against the untouched `options` array -- without
    // it, repeatedly toggling a flag on/off client-side would sort against
    // whatever order the DOM happened to be in from the previous toggle,
    // permanently drifting away from what a fresh render would show.
    const origIndex = new Map(options.map((o, i) => [o.flags.join('|'), i]));
    const sorted = [...options].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
    return `<input type="text" class="optFilterTool" placeholder="Filter flags…" />
    <table class="opts">${sorted
      .map(o => {
        const key = o.flags.join('|');
        const valueSourceCell =
          o.metavar && lists.length > 0
            ? `<td><select class="valueSourceSelect" data-vs-id="${esc(tool.id)}" data-vs-label="${esc(
                variantLabel
              )}" data-vs-key="${esc(key)}" title="Where this flag's value comes from. Manage value lists themselves from the Parameters &amp; Value Lists panel.">
                <option value="">free text</option>
                ${lists
                  .map(
                    l =>
                      `<option value="${esc(l.name)}" ${o.valueListName === l.name ? 'selected' : ''}>${esc(l.name)}</option>`
                  )
                  .join('')}
              </select></td>`
            : '<td></td>';
        return `<tr data-orig-idx="${origIndex.get(key) ?? 0}">
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
    const helpArg = tool.helpArg?.trim() || '--help';
    const probeCommand = buildSetupChain(setup, [tool.command, ...v.selectArgs, helpArg].join(' '), effectiveRoot);
    const outcome = classifyOutcome(v);
    const helpArgLadder =
      outcome === 'nothingParsed' && v.options.length === 0
        ? `<div class="actions">
             <button class="secondary small" data-try-helparg-id="${esc(tool.id)}" data-try-helparg-label="${esc(v.label)}" data-try-helparg="-help" type="button">Try -help</button>
             <button class="secondary small" data-try-helparg-id="${esc(tool.id)}" data-try-helparg-label="${esc(v.label)}" data-try-helparg="-h" type="button">Try -h</button>
             <input type="text" class="tryHelpArgCustom" placeholder="e.g. -help all" data-custom-helparg-id="${esc(tool.id)}" data-custom-helparg-label="${esc(v.label)}" />
             <button class="secondary small" data-try-helparg-custom-id="${esc(tool.id)}" data-try-helparg-custom-label="${esc(v.label)}" type="button">Retry with this</button>
           </div>`
        : '';
    // Offered whenever a scan found zero options, independent of scanError --
    // some tools (e.g. mock_tool.sh's "report" sub-command) are genuinely
    // flagless, in which case a click here just confirms that; others simply
    // use a help-text format the default conservative parser can't read (see
    // toolOptionParser.ts's parseHelpOutputDeep), in which case it recovers
    // real flags from the very same captured output -- no re-run needed.
    const deepParseButton =
      v.options.length === 0
        ? `<div class="actions">
             <button class="secondary small" data-deep-id="${esc(tool.id)}" data-deep-label="${esc(v.label)}" type="button" title="Re-parse the captured output above with looser rules, for tools whose help text doesn't follow common flag-listing conventions.">Search deeper</button>
           </div>`
        : '';
    return `<details class="variant" open>
      <summary>${esc(label)} — ${v.options.length} option${v.options.length === 1 ? '' : 's'}${
      v.scanError ? ' <span class="err">⚠ scan issue</span>' : ''
    }
        <button class="secondary small" data-rescan-variant-id="${esc(tool.id)}" data-rescan-variant-label="${esc(v.label)}" type="button">Rescan</button>
        ${
          v.label !== ''
            ? `<button class="secondary small" data-remove-variant-id="${esc(tool.id)}" data-remove-variant-label="${esc(v.label)}" type="button">Remove sub-command</button>`
            : ''
        }
      </summary>
      ${v.scanError ? setupErrorHtml(outcomeMessage(outcome, v.scanError), probeCommand) : ''}
      ${helpArgLadder}
      ${deepParseButton}
      ${renderOptionRowsEditable(tool, v.label, v.options)}
      <details><summary class="rawSummary">Show output</summary><pre>${esc(v.rawHelp ?? '')}</pre></details>
    </details>`;
  };

  const renderAddVariantForm = (toolId: string): string => `
    <div class="variantRow" style="margin-top:12px;">
      <input type="text" placeholder="label (e.g. regression)" class="newVariantLabel" style="flex:1;" />
      <input type="text" placeholder="selector args (e.g. --regression)" class="newVariantArgs" style="flex:1;" />
      <button class="primary small" data-confirm-addvariant="${esc(toolId)}" type="button">Add</button>
      <button class="secondary small" id="cancelAddVariant" type="button">Cancel</button>
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
        <label>Error pattern (regex, optional) ${help(
          "Treat any output line matching this as an error, added to this tool's error count and the Problems panel -- for output that doesn't match a built-in error format (UVM/Questa/Icarus/DSim/Verilator). Case-insensitive. Leave blank to rely on built-in parsing only."
        )}</label>
        <input type="text" class="editErrorPattern" value="${esc(tool.errorPattern ?? '')}" placeholder="e.g. FAILED|Error:" />
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
          : `<button class="secondary small" data-start-addvariant="${esc(tool.id)}" type="button" style="margin-top:10px;">+ Add sub-command</button>`
      }
    </div>`;
  };

  const pendingOutcome = pendingAdd ? classifyOutcome(pendingAdd.topLevel) : 'ok';
  const pendingHtml = pendingAdd
    ? `
    <div class="pendingAdd">
      <h3>Add ${esc(pendingAdd.displayName || pendingAdd.command)}</h3>
      ${pendingAdd.displayName ? `<div class="hint"><code>${esc(pendingAdd.command)}</code></div>` : ''}
      ${pendingAdd.scanDir ? `<div class="hint">scanning from <code>${esc(pendingAdd.scanDir)}</code></div>` : ''}
      <div class="hint">
        Top-level scan: ${pendingAdd.topLevel.options.length} option(s)
      </div>
      ${pendingAdd.topLevel.scanError ? setupErrorHtml(outcomeMessage(pendingOutcome, pendingAdd.topLevel.scanError), pendingAdd.topLevel.probeCommand) : ''}
      ${
        pendingOutcome === 'nothingParsed' && pendingAdd.topLevel.options.length === 0
          ? `<div class="actions">
               <button class="secondary small" id="tryHelpArgDash" data-pending-command="${esc(pendingAdd.command)}" data-pending-displayname="${esc(pendingAdd.displayName)}" data-pending-scandir="${esc(pendingAdd.scanDir)}">Try -help</button>
               <button class="secondary small" id="tryHelpArgH" data-pending-command="${esc(pendingAdd.command)}" data-pending-displayname="${esc(pendingAdd.displayName)}" data-pending-scandir="${esc(pendingAdd.scanDir)}">Try -h</button>
               <input type="text" id="tryHelpArgCustomInput" placeholder="e.g. -help all" />
               <button class="secondary small" id="tryHelpArgCustomBtn" data-pending-command="${esc(pendingAdd.command)}" data-pending-displayname="${esc(pendingAdd.displayName)}" data-pending-scandir="${esc(pendingAdd.scanDir)}">Retry with this</button>
             </div>`
          : ''
      }
      ${
        pendingAdd.topLevel.options.length === 0
          ? `<div class="actions">
               <button class="secondary small" id="deepParsePendingBtn" type="button" title="Re-parse the captured output below with looser rules, for tools whose help text doesn't follow common flag-listing conventions.">Search deeper</button>
             </div>`
          : ''
      }
      ${renderOptionRows(pendingAdd.topLevel.options)}
      <details><summary class="rawSummary">Show output</summary><pre>${esc(pendingAdd.topLevel.rawHelp ?? '')}</pre></details>
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
      <button class="secondary" id="addVariantRow" type="button">+ Add sub-command manually</button>
      ${help(
        "A sub-command's <b>selector args</b> are what's inserted after the command to reach it, e.g. " +
          '<code>regression</code> (positional) or <code>--regression</code> (flag) — whatever the tool itself expects.'
      )}
      <div class="actions">
        <button class="primary" id="confirmAdd">Add</button>
        <button class="secondary" id="cancelAdd">Cancel</button>
      </div>
    </div>`
    : `
    <details class="addTool" id="addToolDetails" ${tools.length === 0 ? 'open' : ''}>
      <summary>${tools.length === 0 ? 'Add a tool' : '+ Add tool'}</summary>
      <label for="newCommand">Command ${help(
        'Exactly what you type in a terminal to launch the tool. If it is a script in your project, use its path, or Browse…'
      )}</label>
      <input id="newCommand" type="text" placeholder="your_run_script.py or /path/to/tool" />
      <div class="hint" id="willScanPreview"></div>
      <div class="actions">
        <button class="secondary small" id="findIt" type="button">Find it</button>
        <span class="hint" id="findItResult"></span>
      </div>
      <details class="advancedFields">
        <summary>Advanced (help argument, name, scan directory)</summary>
        <label for="newHelpArg">Help argument ${help(
          'Scanned through the same shell &amp; workspace setup chain a job uses (Shell &amp; Environment panel). Defaults to <code>--help</code>; change it if a scan comes back empty.'
        )}</label>
        <input id="newHelpArg" type="text" value="--help" />
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
    </details>`;

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
  option { background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  label.check { display: flex; align-items: center; gap: 8px; font-weight: 400; margin-top: 6px; }
  label.check input { width: auto; margin-top: 0; }
  .hint { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  ${HELP_CSS}
  ${BROWSE_CSS}
  ${SETUP_ERROR_CSS}
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
  .addTool > summary { cursor: pointer; font-weight: 600; font-size: 1.05em; }
  .rawSummary { cursor: pointer; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .optFilterTool { margin-top: 8px; }
  table.opts { border-collapse: collapse; margin-top: 8px; width: 100%; }
  table.opts td { padding: 2px 10px 2px 0; vertical-align: top; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  table.opts select.valueSourceSelect {
    width: auto; margin-top: 0; padding: 2px 6px; font-size: 0.85em;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
  }
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

  ${tools.length > 0 ? tools.map(renderTool).join('') : '<div class="hint" style="margin-top:20px;">No tools registered yet.</div>'}

  ${pendingHtml}

  <div class="actions">
    <button class="secondary" id="close">Close</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    ${CLIENT_ERROR_JS}
    ${BROWSE_JS}
    ${OPEN_STEP_JS}
    const $ = id => document.getElementById(id);
    const $req = id => { const el = $(id); if (!el) { throw new Error('missing element #' + id); } return el; };
    $req('close').addEventListener('click', () => vscode.postMessage({ type: 'close' }));

    // P4/Resolve: "Will scan" preview under the Command field -- pure string
    // assembly mirroring buildSetupChain, no subprocess. Blank entries are
    // dropped the same way the real chain drops them (Finding #15).
    (function wireWillScanPreview() {
      const cmdEl = $('newCommand');
      const helpArgEl = $('newHelpArg');
      const previewEl = $('willScanPreview');
      if (!cmdEl || !helpArgEl || !previewEl) { return; }
      const setupScript = ${JSON.stringify((setup?.script ?? '').trim())};
      const setupCommands = ${JSON.stringify((setup?.commands ?? []).filter(c => c.trim().length > 0))};
      const update = () => {
        const command = cmdEl.value.trim();
        if (!command) { previewEl.textContent = ''; return; }
        const steps = [];
        if (setupScript) { steps.push('source "' + setupScript + '"'); }
        steps.push(...setupCommands);
        steps.push(command + ' ' + (helpArgEl.value.trim() || '--help'));
        previewEl.textContent = 'Will scan: ' + steps.join(' && ');
      };
      cmdEl.addEventListener('input', update);
      helpArgEl.addEventListener('input', update);
      update();
    })();

    // P4/Probe: [Find it] -- "is this even on PATH after my step ① setup?"
    let __findItRequestId = 0;
    const __findItPending = new Map();
    const findItBtn = $('findIt');
    if (findItBtn) {
      findItBtn.addEventListener('click', () => {
        const resultEl = $req('findItResult');
        resultEl.textContent = 'Checking…';
        const requestId = ++__findItRequestId;
        __findItPending.set(requestId, resultEl);
        vscode.postMessage({ type: 'findIt', requestId, command: $req('newCommand').value, scanDir: $('newScanDir') ? $req('newScanDir').value : '' });
      });
    }
    window.addEventListener('message', event => {
      const m = event.data;
      if (!m) { return; }
      if (m.type === 'foundIt') {
        const resultEl = __findItPending.get(m.requestId);
        __findItPending.delete(m.requestId);
        if (!resultEl) { return; }
        resultEl.innerHTML = m.ok
          ? '✓ ' + m.output
          : '✗ not on PATH after your setup commands. <a href="#" id="findItOpenStep1">Open step ① Environment</a>';
        const link = document.getElementById('findItOpenStep1');
        if (link) { link.addEventListener('click', e => { e.preventDefault(); vscode.postMessage({ type: 'openStep', step: 1 }); }); }
      }
    });

    // Help-argument ladder: a zero-option scan offers a one-click retry with
    // a different guess, updating tool.helpArg on success (rescan handlers
    // already persist whatever helpArg the tool/edit form last had).
    wire('[data-try-helparg-id]', btn => {
      showBusy();
      vscode.postMessage({
        type: 'tryHelpArg',
        id: btn.getAttribute('data-try-helparg-id'),
        helpArg: btn.getAttribute('data-try-helparg')
      });
    });
    wire('[data-try-helparg-custom-id]', btn => {
      const id = btn.getAttribute('data-try-helparg-custom-id');
      const label = btn.getAttribute('data-try-helparg-custom-label');
      const input = document.querySelector('.tryHelpArgCustom[data-custom-helparg-id="' + CSS.escape(id) + '"][data-custom-helparg-label="' + CSS.escape(label) + '"]');
      const helpArg = input ? input.value.trim() : '';
      if (!helpArg) { return; }
      showBusy();
      vscode.postMessage({ type: 'tryHelpArg', id, helpArg });
    });
    function wirePendingHelpArgRetry(id, helpArg) {
      const btn = $(id);
      if (!btn) { return; }
      btn.addEventListener('click', () => {
        showBusy();
        vscode.postMessage({
          type: 'scanNew',
          command: btn.getAttribute('data-pending-command'),
          helpArg,
          displayName: btn.getAttribute('data-pending-displayname'),
          scanDir: btn.getAttribute('data-pending-scandir')
        });
      });
    }
    wirePendingHelpArgRetry('tryHelpArgDash', '-help');
    wirePendingHelpArgRetry('tryHelpArgH', '-h');
    {
      const customBtn = $('tryHelpArgCustomBtn');
      const customInput = $('tryHelpArgCustomInput');
      if (customBtn && customInput) {
        customBtn.addEventListener('click', () => {
          const helpArg = customInput.value.trim();
          if (!helpArg) { return; }
          showBusy();
          vscode.postMessage({
            type: 'scanNew',
            command: customBtn.getAttribute('data-pending-command'),
            helpArg,
            displayName: customBtn.getAttribute('data-pending-displayname'),
            scanDir: customBtn.getAttribute('data-pending-scandir')
          });
        });
      }
    }
    {
      const deepPendingBtn = $('deepParsePendingBtn');
      if (deepPendingBtn) {
        deepPendingBtn.addEventListener('click', () => {
          showBusy();
          vscode.postMessage({ type: 'deepParsePending' });
        });
      }
    }
    // At most one tool is ever in edit mode at a time -- a class, not an id,
    // since renderTool re-renders per-tool (see wrap.querySelector('.editCommand') below).
    const editCommandEl = document.querySelector('.editCommand');
    if (editCommandEl) { addBrowseButton(editCommandEl, 'file'); }
    const editScanDirEl = document.querySelector('.editScanDir');
    if (editScanDirEl) { addBrowseButton(editScanDirEl, 'folder'); }

    // Mirrors seedDetect.ts's detectSeed exactly, client-side, so the
    // paste-and-preview tester needs no host round-trip: try the tool's own
    // custom pattern first (if it compiles and matches), then each built-in
    // guessed pattern in order. BUILTIN_SEED_PATTERNS ships as {label,
    // source} (a RegExp doesn't survive JSON.stringify) and is recompiled
    // here.
    const BUILTIN_SEED_PATTERNS = (${seedPatternsJson}).map(p => ({ label: p.label, pattern: new RegExp(p.source, 'i') }));
    // Mirrors seedDetect.ts's CATASTROPHIC_SHAPE -- this tester re-runs the
    // pattern on every keystroke, so a nested-quantifier typo (e.g. "(a+)+")
    // would otherwise freeze this webview's tab, not just the real Log Viewer.
    const CATASTROPHIC_SHAPE = /\\([^()]*[+*][^()]*\\)[+*]/;
    function detectSeedPreview(text, customSource) {
      const custom = (customSource || '').trim();
      if (custom && !CATASTROPHIC_SHAPE.test(custom)) {
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
    wire('[data-deep-id]', btn => {
      showBusy();
      vscode.postMessage({
        type: 'deepParseVariant',
        id: btn.getAttribute('data-deep-id'),
        label: btn.getAttribute('data-deep-label')
      });
    });
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
    // The highest-frequency interaction in this panel -- patch this row (and
    // re-sort the table, favorites-first, exactly like the server's own
    // renderOptionRowsEditable sort) right here instead of waiting on a host
    // round-trip + a full webview.html reassignment (see onMessage's
    // 'toggleFavorite' case, which no longer calls render() for this reason).
    wire('[data-fav-id]', btn => {
      const nowFavorite = !btn.classList.contains('favOn');
      btn.classList.toggle('favOn', nowFavorite);
      btn.textContent = nowFavorite ? '★' : '☆';
      btn.title = nowFavorite ? 'Unfavorite' : 'Favorite';
      const table = btn.closest('table.opts');
      if (table) {
        const rows = Array.from(table.querySelectorAll('tr'));
        rows.sort((a, b) => {
          const aFav = a.querySelector('.favBtn.favOn') ? 1 : 0;
          const bFav = b.querySelector('.favBtn.favOn') ? 1 : 0;
          // Ties (both favorite or both not) fall back to each row's
          // original definition-order index -- not current DOM order -- so
          // repeated toggling stays idempotent instead of permanently
          // drifting away from what a fresh render would show.
          return bFav - aFav || Number(a.dataset.origIdx) - Number(b.dataset.origIdx);
        });
        rows.forEach(r => table.appendChild(r));
      }
      vscode.postMessage({
        type: 'toggleFavorite',
        id: btn.getAttribute('data-fav-id'),
        label: btn.getAttribute('data-fav-label'),
        flagsKey: btn.getAttribute('data-fav-key')
      });
    });
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
        seedPattern: wrap.querySelector('.editSeedPattern').value,
        errorPattern: wrap.querySelector('.editErrorPattern').value
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
      addBrowseButton($('newCommand'), 'file');
      addBrowseButton($('newScanDir'), 'folder');
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
