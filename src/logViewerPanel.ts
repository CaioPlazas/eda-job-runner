import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JobStore } from './jobStore';
import { LogManager } from './logManager';
import { ToolStore } from './toolStore';
import { JobDefinition } from './types';
import { parseLogHeader, parseLogTrailer, parseLogFilename, searchMatches } from './logIndex';
import { detectSeed } from './seedDetect';

interface OpenLogMessage {
  type: 'openLog';
  logPath: string;
}
interface RefreshMessage {
  type: 'refresh';
}
interface SearchMessage {
  type: 'search';
  query: string;
  logPaths: string[];
}
interface CloseMessage {
  type: 'close';
}

type WebviewMessage = OpenLogMessage | RefreshMessage | SearchMessage | CloseMessage;

interface LogRow {
  jobId: string;
  jobName: string;
  folder?: string;
  logPath: string;
  filename: string;
  laneLabel?: string;
  seed?: string;
  command?: string;
  started?: string;
  state?: string;
  exitCode?: string;
  errorCount?: number;
  warningCount?: number;
}

// Full-text search reads a file's whole (capped) content, unlike the
// header/trailer-only reads used to build the table -- bound both the
// per-file size and the number of files scanned so a workspace with lots of
// large logs can't make a search hang the panel.
const SEARCH_FILE_CAP = 5 * 1024 * 1024;
const SEARCH_FILE_LIMIT = 300;
// Bounds how many log files are read concurrently while building the table
// or running a search, so a workspace with hundreds of logs doesn't open
// that many file handles at once.
const READ_CONCURRENCY = 20;

export class LogViewerPanel {
  private static current: LogViewerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(jobStore: JobStore, logManager: LogManager, toolStore: ToolStore): void {
    if (LogViewerPanel.current) {
      LogViewerPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('edaLogViewer', 'Log Viewer', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    LogViewerPanel.current = new LogViewerPanel(panel, jobStore, logManager, toolStore);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly jobStore: JobStore,
    private readonly logManager: LogManager,
    private readonly toolStore: ToolStore
  ) {
    this.panel = panel;
    this.panel.webview.html = renderHtml(panel.webview);
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
    void this.sendRows();
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'close':
        this.panel.dispose();
        return;
      case 'refresh':
        await this.sendRows();
        return;
      case 'openLog':
        await this.openLog(msg.logPath);
        return;
      case 'search':
        await this.search(msg.query, msg.logPaths);
        return;
    }
  }

  private async sendRows(): Promise<void> {
    const rows = await this.gatherRows();
    void this.panel.webview.postMessage({ type: 'rows', rows });
  }

  /** One row per past run across every job, built from each log's own header/trailer -- no separate persisted index needed. */
  private async gatherRows(): Promise<LogRow[]> {
    const jobList = this.jobStore.getJobs();
    const jobs = new Map(jobList.map(j => [j.id, j]));
    const runs = await this.logManager.listAllRuns(this.logManager.resolveAllRoots(jobList));
    const rows: LogRow[] = [];
    for (let i = 0; i < runs.length; i += READ_CONCURRENCY) {
      const batch = runs.slice(i, i + READ_CONCURRENCY);
      const batchRows = await Promise.all(batch.map(run => this.buildRow(run, jobs)));
      rows.push(...batchRows);
    }
    return rows;
  }

  private async buildRow(
    { jobId, logPath }: { jobId: string; logPath: string },
    jobs: Map<string, JobDefinition>
  ): Promise<LogRow> {
    const { head, tail } = await this.logManager.readHeadTail(logPath);
    const header = parseLogHeader(head);
    const trailer = parseLogTrailer(tail);
    const filename = path.basename(logPath);
    const fromName = parseLogFilename(filename);
    const job = jobs.get(jobId);
    // `# seed:` is only ever written when a job's Command uses
    // ${randomSeed} -- a job that specifies its seed any other way (typed
    // literally, ${param:SEED}, or the tool echoing it in its own startup
    // banner) never gets that header field populated, so fall back to
    // scanning the already-read head+tail text for it: the built-in
    // guessed patterns, or this job's tool's own custom override if it has
    // one (Tool Setup's "Seed pattern" field).
    const tool = job?.toolId ? this.toolStore.getTool(job.toolId) : undefined;
    const seed = header.seed ?? detectSeed(`${head}\n${tail}`, tool?.seedPattern);
    return {
      jobId,
      jobName: header.jobName ?? job?.name ?? `(deleted job ${jobId.slice(0, 8)})`,
      folder: job?.folder,
      logPath,
      filename,
      laneLabel: header.laneLabel,
      seed,
      command: header.command,
      started: header.started ?? fromName.timestamp,
      state: trailer.state,
      exitCode: trailer.exitCode,
      errorCount: trailer.errorCount,
      warningCount: trailer.warningCount
    };
  }

  private async openLog(logPath: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      // Most likely pruned by log retention between the last row list and this click.
      void vscode.window.showInformationMessage('EDA Job Runner: that log no longer exists — try refreshing.');
    }
  }

  private async search(query: string, logPaths: string[]): Promise<void> {
    const q = query.trim();
    if (!q) {
      void this.panel.webview.postMessage({ type: 'searchResult', matched: null, truncated: false, contentCapped: false });
      return;
    }
    const scanned = logPaths.slice(0, SEARCH_FILE_LIMIT);
    const truncated = logPaths.length > scanned.length;
    const matched: string[] = [];
    let contentCapped = false;
    for (let i = 0; i < scanned.length; i += READ_CONCURRENCY) {
      const batch = scanned.slice(i, i + READ_CONCURRENCY);
      const results = await Promise.all(batch.map(p => this.searchOne(p, q)));
      results.forEach((result, idx) => {
        if (result.matched) {
          matched.push(batch[idx]);
        }
        if (result.capped) {
          contentCapped = true;
        }
      });
    }
    void this.panel.webview.postMessage({ type: 'searchResult', matched, truncated, contentCapped });
  }

  private async searchOne(logPath: string, query: string): Promise<{ matched: boolean; capped: boolean }> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(logPath, 'r');
    } catch {
      return { matched: false, capped: false };
    }
    try {
      const size = (await handle.stat()).size;
      const len = Math.min(SEARCH_FILE_CAP, size);
      const buf = Buffer.alloc(len);
      if (len > 0) {
        await handle.read(buf, 0, len, 0);
      }
      return { matched: searchMatches(buf.toString('utf8'), query), capped: size > SEARCH_FILE_CAP };
    } catch {
      return { matched: false, capped: false };
    } finally {
      await handle.close();
    }
  }

  private cleanup(): void {
    LogViewerPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Log Viewer</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 24px;
    max-width: min(1600px, 100%);
    width: 100%;
  }
  h2 { margin-top: 0; }
  .hint {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }
  .toolbar {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    align-items: flex-end;
    margin-top: 14px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
  }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 0.8em; font-weight: 600; color: var(--vscode-descriptionForeground); }
  input, select {
    box-sizing: border-box;
    padding: 6px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }
  select[multiple] { min-width: 160px; min-height: 60px; }
  .statusChecks { display: flex; gap: 10px; flex-wrap: wrap; }
  .statusChecks label { display: flex; align-items: center; gap: 4px; font-weight: 400; font-size: 0.9em; }
  .statusChecks input { width: auto; margin: 0; }
  #seedFilter { width: 140px; }
  .dateField input { width: 150px; }
  .searchRow { display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
  #searchQuery { flex: 1 1 320px; min-width: 200px; }
  #searchStatus { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  button {
    padding: 6px 16px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  details {
    margin-top: 18px;
    padding-top: 4px;
    border-top: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
  }
  details summary {
    cursor: pointer;
    font-weight: 600;
    padding: 6px 0;
  }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 0.9em; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-input-border, rgba(127,127,127,0.15)); white-space: nowrap; }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  /* A real seed value can be a long random integer -- a fixed minimum keeps it from being squeezed illegibly narrow by wider neighbors like Job/Folder. */
  .seedCol { min-width: 90px; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 0.82em; font-weight: 600; }
  .badge-passed { background: rgba(137,209,133,0.2); color: var(--vscode-terminal-ansiGreen, #89d185); }
  .badge-failed { background: rgba(224,108,117,0.2); color: var(--vscode-terminal-ansiRed, #e06c75); }
  .badge-killed { background: rgba(224,178,108,0.2); color: var(--vscode-terminal-ansiYellow, #e0b26c); }
  .badge-unknown { background: rgba(127,127,127,0.2); color: var(--vscode-descriptionForeground); }
  #emptyState, #loadingState { margin-top: 24px; color: var(--vscode-descriptionForeground); }
  #groups { margin-top: 4px; }
</style>
</head>
<body>
  <h2>Log Viewer</h2>
  <div class="hint">
    Every past run across every job, newest first. Built directly from each
    log file's own header/trailer -- nothing is pre-indexed, so this always
    reflects exactly what's on disk (the logs directory, configurable from
    the Shell &amp; Environment panel — <code>.eda-runner/logs/</code> by default).
  </div>

  <div class="toolbar">
    <div class="field">
      <label for="filterJob">Job</label>
      <select id="filterJob" multiple></select>
    </div>
    <div class="field">
      <label for="filterFolder">Folder</label>
      <select id="filterFolder" multiple></select>
    </div>
    <div class="field">
      <label>Status</label>
      <div class="statusChecks">
        <label><input type="checkbox" class="statusCheck" value="passed" checked /> Passed</label>
        <label><input type="checkbox" class="statusCheck" value="failed" checked /> Failed</label>
        <label><input type="checkbox" class="statusCheck" value="killed" checked /> Killed</label>
        <label><input type="checkbox" class="statusCheck" value="unknown" checked /> Running/unknown</label>
      </div>
    </div>
    <div class="field">
      <label for="seedFilter">Seed contains</label>
      <input id="seedFilter" type="text" placeholder="e.g. 12345" />
    </div>
    <div class="field dateField">
      <label for="dateFrom">From</label>
      <input id="dateFrom" type="date" />
    </div>
    <div class="field dateField">
      <label for="dateTo">To</label>
      <input id="dateTo" type="date" />
    </div>
    <div class="field">
      <label>&nbsp;</label>
      <button class="secondary" id="clearFilters" type="button">Clear filters</button>
    </div>
    <div class="field">
      <label>&nbsp;</label>
      <button class="secondary" id="refresh" type="button">↻ Refresh</button>
    </div>
  </div>

  <div class="searchRow">
    <input id="searchQuery" type="text" placeholder="Search log contents (e.g. UVM_ERROR) — searches the currently filtered logs" />
    <button class="primary" id="searchBtn" type="button">Search</button>
    <button class="secondary" id="clearSearch" type="button">Clear search</button>
    <span id="searchStatus"></span>
  </div>

  <div id="loadingState">Loading…</div>
  <div id="emptyState" style="display:none;">No logs found yet — run a job first.</div>
  <div id="groups"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let ROWS = [];
    let SEARCH_MATCHED = null; // null = no active search; else a Set of matching logPaths
    let SEARCH_TRUNCATED = false;
    let SEARCH_CONTENT_CAPPED = false;

    function statusOf(row) {
      return row.state === 'passed' || row.state === 'failed' || row.state === 'killed' ? row.state : 'unknown';
    }

    function populateSelect(sel, values, placeholder) {
      const prevSelected = new Set(Array.from(sel.selectedOptions).map(o => o.value));
      sel.innerHTML = '';
      values.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v || placeholder;
        if (prevSelected.has(v)) { opt.selected = true; }
        sel.appendChild(opt);
      });
    }

    function refreshFilterOptions() {
      const jobs = [...new Set(ROWS.map(r => r.jobName))].sort();
      const folders = [...new Set(ROWS.map(r => r.folder || ''))].sort();
      populateSelect($('filterJob'), jobs, '(unnamed)');
      populateSelect($('filterFolder'), folders, '(no folder)');
    }

    function selectedValues(sel) {
      return new Set(Array.from(sel.selectedOptions).map(o => o.value));
    }

    function applyFilters() {
      const jobSel = selectedValues($('filterJob'));
      const folderSel = selectedValues($('filterFolder'));
      const statuses = new Set(Array.from(document.querySelectorAll('.statusCheck:checked')).map(c => c.value));
      const seedQ = $('seedFilter').value.trim().toLowerCase();
      const dateFrom = $('dateFrom').value;
      const dateTo = $('dateTo').value;

      return ROWS.filter(row => {
        if (jobSel.size > 0 && !jobSel.has(row.jobName)) { return false; }
        if (folderSel.size > 0 && !folderSel.has(row.folder || '')) { return false; }
        if (!statuses.has(statusOf(row))) { return false; }
        if (seedQ && !(row.seed || '').toLowerCase().includes(seedQ)) { return false; }
        if ((dateFrom || dateTo) && row.started) {
          const day = row.started.slice(0, 10);
          if (dateFrom && day < dateFrom) { return false; }
          if (dateTo && day > dateTo) { return false; }
        }
        if (SEARCH_MATCHED && !SEARCH_MATCHED.has(row.logPath)) { return false; }
        return true;
      });
    }

    function fmtDate(iso) {
      if (!iso) { return '–'; }
      const d = new Date(iso);
      return isNaN(d.getTime()) ? iso : d.toLocaleString();
    }

    function rowHtml(row) {
      const status = statusOf(row);
      const label = status === 'unknown' ? 'running/unknown' : status;
      const title = row.command ? ' title="' + esc(row.command) + '"' : '';
      return '<tr data-log="' + esc(row.logPath) + '"' + title + '>' +
        '<td>' + esc(fmtDate(row.started)) + '</td>' +
        '<td>' + esc(row.jobName) + '</td>' +
        '<td>' + esc(row.folder || '–') + '</td>' +
        '<td>' + esc(row.laneLabel || '–') + '</td>' +
        '<td class="seedCol">' + esc(row.seed || '–') + '</td>' +
        '<td><span class="badge badge-' + status + '">' + esc(label) + '</span></td>' +
        '<td>' + esc(row.exitCode ?? '–') + '</td>' +
        '<td>' + esc(row.errorCount ?? '–') + '</td>' +
        '<td>' + esc(row.warningCount ?? '–') + '</td>' +
      '</tr>';
    }

    function tableHtml(rows) {
      if (rows.length === 0) {
        return '<div class="hint">No logs match the current filters.</div>';
      }
      return '<table><thead><tr>' +
        '<th>Started</th><th>Job</th><th>Folder</th><th>Run</th><th class="seedCol">Seed</th><th>Status</th><th>Exit</th><th>Errors</th><th>Warnings</th>' +
        '</tr></thead><tbody>' + rows.map(rowHtml).join('') + '</tbody></table>';
    }

    function sortedByDateDesc(rows) {
      return rows.slice().sort((a, b) => (b.started || '').localeCompare(a.started || ''));
    }

    function render() {
      const visible = sortedByDateDesc(applyFilters());
      const groupsEl = $('groups');

      let html = '<details open><summary>All logs (' + visible.length + ')</summary>' + tableHtml(visible) + '</details>';

      const byJob = new Map();
      visible.forEach(r => {
        if (!byJob.has(r.jobId)) { byJob.set(r.jobId, []); }
        byJob.get(r.jobId).push(r);
      });
      const jobOrder = [...byJob.keys()].sort((a, b) => {
        const an = byJob.get(a)[0].jobName, bn = byJob.get(b)[0].jobName;
        return an.localeCompare(bn);
      });
      jobOrder.forEach(jobId => {
        const jobRows = byJob.get(jobId);
        const name = jobRows[0].jobName;
        const folder = jobRows[0].folder;
        const heading = name + (folder ? ' (' + folder + ')' : '') + ' — ' + jobRows.length + ' run' + (jobRows.length === 1 ? '' : 's');
        html += '<details><summary>' + esc(heading) + '</summary>' + tableHtml(jobRows) + '</details>';
      });

      groupsEl.innerHTML = html;
      groupsEl.querySelectorAll('tbody tr').forEach(tr => {
        tr.addEventListener('click', () => vscode.postMessage({ type: 'openLog', logPath: tr.getAttribute('data-log') }));
      });
    }

    document.querySelectorAll('.statusCheck').forEach(c => c.addEventListener('change', () => { SEARCH_MATCHED = null; updateSearchStatus(); render(); }));
    $('filterJob').addEventListener('change', () => { SEARCH_MATCHED = null; updateSearchStatus(); render(); });
    $('filterFolder').addEventListener('change', () => { SEARCH_MATCHED = null; updateSearchStatus(); render(); });
    $('seedFilter').addEventListener('input', () => { SEARCH_MATCHED = null; updateSearchStatus(); render(); });
    $('dateFrom').addEventListener('change', () => { SEARCH_MATCHED = null; updateSearchStatus(); render(); });
    $('dateTo').addEventListener('change', () => { SEARCH_MATCHED = null; updateSearchStatus(); render(); });

    $('clearFilters').addEventListener('click', () => {
      Array.from($('filterJob').options).forEach(o => o.selected = false);
      Array.from($('filterFolder').options).forEach(o => o.selected = false);
      document.querySelectorAll('.statusCheck').forEach(c => c.checked = true);
      $('seedFilter').value = '';
      $('dateFrom').value = '';
      $('dateTo').value = '';
      SEARCH_MATCHED = null;
      $('searchQuery').value = '';
      updateSearchStatus();
      render();
    });

    $('refresh').addEventListener('click', () => {
      // A stale SEARCH_MATCHED (a Set of logPaths from before the refresh)
      // would otherwise silently hide every newly-appeared run -- its
      // logPath was never actually searched, so it can't be in the set.
      SEARCH_MATCHED = null;
      updateSearchStatus();
      $('loadingState').style.display = '';
      vscode.postMessage({ type: 'refresh' });
    });

    function updateSearchStatus() {
      const el = $('searchStatus');
      if (SEARCH_MATCHED === null) { el.textContent = ''; return; }
      let note = '';
      if (SEARCH_TRUNCATED) { note += ' (search stopped early — narrow the filters first for a full scan)'; }
      if (SEARCH_CONTENT_CAPPED) { note += ' (only the first 5MB of some large log(s) was searched)'; }
      el.textContent = SEARCH_MATCHED.size + ' match' + (SEARCH_MATCHED.size === 1 ? '' : 'es') + note;
    }

    function runSearch() {
      const query = $('searchQuery').value;
      if (!query.trim()) {
        SEARCH_MATCHED = null;
        updateSearchStatus();
        render();
        return;
      }
      // Search only what's already filtered (job/folder/status/seed/date) --
      // scoping down first makes a full-content scan both faster and more relevant.
      const scoped = applyFilters();
      $('searchStatus').textContent = 'Searching ' + scoped.length + ' log(s)…';
      vscode.postMessage({ type: 'search', query, logPaths: scoped.map(r => r.logPath) });
    }
    $('searchBtn').addEventListener('click', runSearch);
    $('searchQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { runSearch(); } });
    $('clearSearch').addEventListener('click', () => {
      $('searchQuery').value = '';
      SEARCH_MATCHED = null;
      updateSearchStatus();
      render();
    });

    window.addEventListener('message', event => {
      const m = event.data;
      if (!m) { return; }
      if (m.type === 'rows') {
        ROWS = m.rows;
        $('loadingState').style.display = 'none';
        $('emptyState').style.display = ROWS.length === 0 ? '' : 'none';
        refreshFilterOptions();
        render();
      } else if (m.type === 'searchResult') {
        if (m.matched === null) {
          SEARCH_MATCHED = null;
        } else {
          SEARCH_MATCHED = new Set(m.matched);
        }
        SEARCH_TRUNCATED = !!m.truncated;
        SEARCH_CONTENT_CAPPED = !!m.contentCapped;
        updateSearchStatus();
        render();
      }
    });
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
