import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { JobDefinition, JobsFileSetup } from './types';
import { LogManager } from './logManager';
import { ensureGitignoreEntry } from './gitignoreManager';
import { LogDiagnostics } from './logDiagnostics';
import { ParseState, newParseState, parseLine } from './logParser';
import { buildShellInvocation, resolveJobEnv, substituteVars } from './shellInvocation';
import { ParamSpec, parseParams, substituteParams, substituteRandomSeed } from './paramSubstitution';
import { decideFinalState, compilePattern } from './jobOutcome';

export type { JobRunState } from './jobOutcome';
import type { JobRunState } from './jobOutcome';

export interface JobRunStatus {
  state: JobRunState;
  startTime?: number;
  endTime?: number;
  exitCode?: number | null;
  signal?: string | null;
  logPath?: string;
  pid?: number;
  /** Parsed error count from the log (UVM_ERROR/UVM_FATAL + compile errors). */
  errorCount?: number;
  /** Parsed warning count from the log (UVM_WARNING + compile warnings). */
  warningCount?: number;
  /**
   * True when this "running" status was reconstructed after an extension host
   * restart (window reload) rather than tracked live: we know the pid and can
   * still stop it, but we have no stdio handle and won't get an exit event, so
   * it stays "running" until the user checks the log or stops it manually.
   */
  detached?: boolean;
  /**
   * Set when this status is one of several tracked runs for its job — a
   * sequential repeat-count iteration ("3/10") or a concurrent extra
   * instance ("#2"). Undefined for a normal single run. Drives the tree's
   * expandable group view (see JobRunner.getLanes).
   */
  laneLabel?: string;
  /**
   * The job's Command after `${param:NAME}` and `${randomSeed}` placeholders
   * (see paramSubstitution.ts) were resolved for this specific run — e.g. the
   * exact seed that was actually used. "Re-run Last" replays this string
   * verbatim, with no new prompt and no fresh random seed. Equal to the job's
   * plain `command` when it has no placeholders.
   */
  resolvedCommand?: string;
}

interface ActiveRun {
  child: cp.ChildProcess;
  logStream: fs.WriteStream;
  bytesWritten: number;
  truncated: boolean;
  killRequested: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  cwdAbs: string;
  parseState: ParseState;
  /** Carry for a partial trailing line split across stdout chunks. */
  lineCarry: string;
  /** Per-job safeguard: when false, skip all output parsing/diagnostics. */
  parseProblems: boolean;
  jobId: string;
  /** Key into `activeRuns`/`laneGroups`: `job.id` for the primary lane, synthetic otherwise. */
  laneKey: string;
  /** Whether this lane's status is mirrored into the persisted primary `statuses` slot. */
  mirrorPrimary: boolean;
  label?: string;
  finished: boolean;
  /** This run's Command after `${param:...}`/`${randomSeed}` were resolved. See JobRunStatus.resolvedCommand. */
  resolvedCommand: string;
  /** Compiled from the job's `failPattern`/`passPattern`, if set and valid. See jobOutcome.ts. */
  failRegex?: RegExp;
  passRegex?: RegExp;
  /** Whether failRegex/passRegex has matched any line seen so far this run. */
  matchedFail: boolean;
  matchedPass: boolean;
}

const MB = 1024 * 1024;
const STATUS_STORAGE_KEY = 'eda-job-runner.jobStatuses';
const PARAM_VALUES_STORAGE_KEY = 'eda-job-runner.jobParamValues';
// Matches CSI ANSI escape sequences (color codes, cursor movement, etc.)
// commonly emitted by EDA tools and Makefiles with colorized output.
const ANSI_PATTERN = /\x1B\[[0-9;]*[a-zA-Z]/g;
// Cap on how many lane entries we keep per job (oldest finished ones evicted
// first) so a very large repeat count or long-lived concurrent usage can't
// grow this in-memory, non-persisted structure without bound.
const MAX_LANES_PER_JOB = 50;

export class JobRunner implements vscode.Disposable {
  private readonly _onDidChangeStatus = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private readonly statuses: Map<string, JobRunStatus>;
  private readonly activeRuns = new Map<string, ActiveRun>();
  /**
   * Extra/lane-group tracking for jobs that have run more than once
   * concurrently or as a sequential repeat-count batch. Not persisted —
   * live-session only, same tradeoff as the "detached across reload"
   * primary-slot handling below, just not carried across a window reload.
   * A job with no entry here (the common case) renders as a single flat
   * row using `statuses`, exactly as before this feature existed.
   */
  private readonly laneGroups = new Map<string, Map<string, JobRunStatus>>();
  private laneSeq = 0;
  private readonly laneCompletionResolvers = new Map<string, (state: JobRunState) => void>();
  private readonly laneCompletionPromises = new Map<string, Promise<JobRunState>>();
  /** Jobs with a sequential repeat-count batch currently in flight — guards against a second concurrent batch for the same job stomping the first one's lane-group map (see runBatch). */
  private readonly activeBatchJobs = new Set<string>();
  /** Jobs currently sitting in a `${param:...}` prompt — an in-flight run that has no `activeRuns` entry yet. Guards the async prompt window against a double-click starting a second run. */
  private readonly promptingJobs = new Set<string>();
  private tickTimer?: ReturnType<typeof setInterval>;
  /**
   * Last-entered value per job+`${param:NAME}` name, persisted so the next
   * prompt for that param defaults to whatever was typed last time rather
   * than the job's own `${param:NAME=default}` every single run.
   */
  private readonly paramValues: Map<string, Record<string, string>>;

  constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly logManager: LogManager,
    private readonly getSetup: () => JobsFileSetup | undefined,
    private readonly memento: vscode.Memento,
    private readonly diagnostics: LogDiagnostics
  ) {
    this.statuses = new Map(Object.entries(memento.get<Record<string, JobRunStatus>>(STATUS_STORAGE_KEY, {})));
    this.paramValues = new Map(
      Object.entries(memento.get<Record<string, Record<string, string>>>(PARAM_VALUES_STORAGE_KEY, {}))
    );
    // A "running" status left over from a previous session means the extension
    // host restarted (window reload, VS Code exit) and we lost the stdio/exit
    // handle. If the pid is still alive, keep showing it as running (detached)
    // rather than lying that it's idle — Stop still works via the raw pid.
    for (const [jobId, status] of this.statuses) {
      if (status.state !== 'running') {
        continue;
      }
      if (status.pid && isPidAlive(status.pid)) {
        this.statuses.set(jobId, { ...status, detached: true });
      } else {
        this.statuses.set(jobId, { ...status, state: 'idle', pid: undefined, detached: undefined });
      }
    }
    void this.persistStatuses();
    if (this.hasAnyRunning()) {
      this.ensureTicking();
    }
  }

  getStatus(jobId: string): JobRunStatus {
    return this.statuses.get(jobId) ?? { state: 'idle' };
  }

  /**
   * All tracked run entries for a job beyond the simple single-run case —
   * empty for the overwhelming common case (a job that has only ever run
   * one instance at a time), non-empty once it's had a sequential
   * repeat-count batch or a concurrent extra instance. The tree uses this to
   * decide whether to render a job as a flat row (empty) or an expandable
   * group (non-empty).
   */
  getLanes(jobId: string): { laneKey: string; status: JobRunStatus }[] {
    const group = this.laneGroups.get(jobId);
    return group ? [...group.entries()].map(([laneKey, status]) => ({ laneKey, status })) : [];
  }

  /**
   * `forcedCommand`, set by "Re-run Last", replays one exact prior resolved
   * command verbatim -- no `${param:...}` prompt, no fresh `${randomSeed}`,
   * and always a single run regardless of the job's repeat count, since it's
   * meant to reproduce one specific prior run (e.g. a failure) exactly.
   */
  async run(job: JobDefinition, options?: { forcedCommand?: string }): Promise<void> {
    const config = vscode.workspace.getConfiguration('eda-job-runner', this.workspaceFolder.uri);
    const multiEnabled = config.get<boolean>('experimentalMultipleRuns', false);

    // `activeRuns` alone doesn't cover a run still sitting in its `${param:...}`
    // prompt (no lane allocated yet), so a fast double-click could start two
    // runs with multi-run off — `promptingJobs` closes that window.
    if (!multiEnabled) {
      if (this.activeRuns.has(job.id) || this.promptingJobs.has(job.id)) {
        void vscode.window.showInformationMessage(`"${job.name}" is already running.`);
        return;
      }
      if (this.activeRuns.size > 0 || this.promptingJobs.size > 0) {
        void vscode.window.showWarningMessage(
          'Only one job can run at a time for now — stop the current job first, or turn on ' +
            '"Experimental: multiple jobs" in settings.'
        );
        return;
      }
    } else if (this.promptingJobs.has(job.id)) {
      // Even with multi-run on, don't stack a second prompt for the *same* job
      // from a double-click — one Run click, one prompt.
      return;
    }

    if (options?.forcedCommand !== undefined) {
      if (this.activeRuns.has(job.id)) {
        const { laneKey, label } = this.allocateExtraLane(job.id);
        await this.runLane(job, laneKey, label, false, options.forcedCommand);
      } else {
        await this.runLane(job, job.id, undefined, true, options.forcedCommand);
      }
      return;
    }

    // `${param:NAME}` placeholders in the command are prompted for once here
    // (not per repeat-count iteration); `${randomSeed}` is left untouched --
    // it's resolved fresh inside runLane for every actual spawn, so a batch
    // still gets a different seed per iteration.
    const params = parseParams(job.command);
    let template = job.command;
    if (params.length > 0) {
      this.promptingJobs.add(job.id);
      let values: Record<string, string> | undefined;
      try {
        values = await this.promptForParams(job.id, params);
      } finally {
        this.promptingJobs.delete(job.id);
      }
      if (!values) {
        return; // user cancelled a prompt -- abort, nothing started
      }
      template = substituteParams(job.command, values);
    }

    const runCount = Math.max(1, Math.min(1000, Math.round(job.runCount ?? 1)));
    if (runCount > 1) {
      if (this.activeBatchJobs.has(job.id)) {
        void vscode.window.showInformationMessage(`"${job.name}" already has a repeat-count batch running.`);
        return;
      }
      this.activeBatchJobs.add(job.id);
      try {
        await this.runBatch(job, runCount, template);
      } finally {
        this.activeBatchJobs.delete(job.id);
      }
      return;
    }

    if (this.activeRuns.has(job.id)) {
      const { laneKey, label } = this.allocateExtraLane(job.id);
      await this.runLane(job, laneKey, label, false, template);
    } else {
      await this.runLane(job, job.id, undefined, true, template);
    }
  }

  /**
   * Sequentially prompt for every `${param:NAME}` in the command, defaulting
   * each to the last value entered for this job+name (or the placeholder's
   * own `${param:NAME=default}` the very first time). Returns undefined if
   * the user cancels any prompt (Escape) -- the caller aborts the whole run.
   */
  private async promptForParams(jobId: string, params: ParamSpec[]): Promise<Record<string, string> | undefined> {
    const previous = this.paramValues.get(jobId) ?? {};
    const values: Record<string, string> = { ...previous };
    for (const p of params) {
      const value = await vscode.window.showInputBox({
        title: 'Run parameters',
        prompt: `Value for \${param:${p.name}}`,
        value: previous[p.name] ?? p.default,
        ignoreFocusOut: true
      });
      if (value === undefined) {
        return undefined;
      }
      values[p.name] = value;
    }
    this.paramValues.set(jobId, values);
    void this.persistParamValues();
    return values;
  }

  /** Sequential repeat-count batch: N runs of the same job, one after another, never in parallel. */
  private async runBatch(job: JobDefinition, total: number, template: string): Promise<void> {
    // A fresh batch replaces any previous lane-group history for this job so
    // old and new batch results don't mix confusingly in the tree.
    this.laneGroups.set(job.id, new Map());
    for (let i = 1; i <= total; i++) {
      const laneKey = `${job.id}::run${i}`;
      const label = `${i}/${total}`;
      const finalState = await this.runLane(job, laneKey, label, true, template);
      if (finalState === 'killed') {
        break; // the user explicitly stopped this iteration — don't keep going
      }
    }
  }

  private allocateExtraLane(jobId: string): { laneKey: string; label: string } {
    if (!this.laneGroups.has(jobId)) {
      const group = new Map<string, JobRunStatus>();
      const primary = this.statuses.get(jobId);
      if (primary) {
        group.set(jobId, primary);
      }
      this.laneGroups.set(jobId, group);
    }
    const n = ++this.laneSeq;
    return { laneKey: `${jobId}#${n}`, label: `#${n}` };
  }

  /**
   * `template` is the job's command with `${param:...}` already resolved (or
   * a "Re-run Last" replay's already-fully-resolved command, which has no
   * placeholders left); `${randomSeed}` is resolved fresh right here so every
   * actual spawn -- including each iteration of a repeat-count batch -- gets
   * its own value.
   */
  private async runLane(
    job: JobDefinition,
    laneKey: string,
    label: string | undefined,
    mirrorPrimary: boolean,
    template: string
  ): Promise<JobRunState> {
    void ensureGitignoreEntry(this.workspaceFolder, this.memento);
    const resolvedCommand = substituteRandomSeed(template);

    const config = vscode.workspace.getConfiguration('eda-job-runner', this.workspaceFolder.uri);
    const shellPath = (config.get<string>('shellPath', 'bash') || 'bash').trim() || 'bash';
    const shellArgs = config.get<string[] | null>('shellArgs', null);
    const envSetting = config.get<Record<string, string>>('env', {});
    const maxBytes = Math.max(1, config.get<number>('logMaxSizeMB', 200)) * MB;
    const retentionCount = Math.max(1, config.get<number>('logRetentionCount', 20));
    const stripAnsi = config.get<boolean>('stripAnsiCodes', true);
    const globalPostSetupCwd = config.get<string>('postSetupCwd', '');

    const workspaceRoot = this.workspaceFolder.uri.fsPath;
    // A job's own Advanced override wins over the workspace-wide setting.
    // Once set, `cwd` below resolves against this instead of the workspace
    // root — the directory the shell starts in, after its own dotfile
    // sourcing and before workspace setup / the job's command run.
    const effectivePostSetupCwd = (job.postSetupCwd && job.postSetupCwd.trim()) || globalPostSetupCwd;
    const baseDir = effectivePostSetupCwd.trim()
      ? path.resolve(workspaceRoot, substituteVars(effectivePostSetupCwd.trim(), workspaceRoot))
      : workspaceRoot;
    const cwdAbs = path.resolve(baseDir, job.cwd || '.');
    const shellCommand = buildShellCommand(this.getSetup(), resolvedCommand, workspaceRoot);

    // Fresh run: drop the previous run's Problems-panel entries for this job.
    // Only the primary/mirrored lane owns the Problems panel — a concurrent
    // extra instance of the same job doesn't touch it, so it can't clobber
    // diagnostics from the lane the user is actually watching.
    if (mirrorPrimary) {
      this.diagnostics.clearJob(job.id);
    }

    const laneSuffix = laneKey === job.id ? undefined : sanitizeLaneSuffix(label ?? laneKey);
    const { logPath, stream } = await this.logManager.createLogFile(job.id, retentionCount, laneSuffix);
    const startTime = Date.now();
    stream.write(
      `# EDA Job Runner\n# job: ${job.name}${label ? ` (run ${label})` : ''}\n# command: ${resolvedCommand}\n` +
        `# cwd: ${cwdAbs}\n# started: ${new Date(startTime).toISOString()}\n\n`
    );
    if ((job.failPattern?.trim() && !compilePattern(job.failPattern)) || (job.passPattern?.trim() && !compilePattern(job.passPattern))) {
      stream.write('# EDA Job Runner: an invalid fail/pass pattern (bad regex) was ignored\n\n');
    }

    // Argument vector is derived from the shell family (or a user override) so
    // non-bash shells work: a hardcoded `-lc` is invalid for tcsh/csh. See
    // buildShellInvocation. env is only passed when the user configured extra
    // vars, otherwise the child inherits process.env as before.
    const { file: shellFile, args: shellSpawnArgs } = buildShellInvocation(shellPath, shellArgs, shellCommand);
    const child = cp.spawn(shellFile, shellSpawnArgs, {
      cwd: cwdAbs,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: resolveJobEnv(envSetting, workspaceRoot)
    });

    const run: ActiveRun = {
      child,
      logStream: stream,
      bytesWritten: 0,
      truncated: false,
      killRequested: false,
      cwdAbs,
      parseState: newParseState(),
      lineCarry: '',
      parseProblems: job.parseProblems !== false,
      jobId: job.id,
      laneKey,
      mirrorPrimary,
      label,
      finished: false,
      resolvedCommand,
      failRegex: compilePattern(job.failPattern),
      passRegex: compilePattern(job.passPattern),
      matchedFail: false,
      matchedPass: false
    };
    this.activeRuns.set(laneKey, run);
    this.beginLaneCompletion(laneKey);
    this.setLaneStatus(run, {
      state: 'running',
      startTime,
      logPath,
      pid: child.pid,
      errorCount: 0,
      warningCount: 0,
      laneLabel: label,
      resolvedCommand
    });
    this.ensureTicking();

    const onData = (chunk: Buffer) => this.appendOutput(run, chunk, maxBytes, stripAnsi);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', err => {
      stream.write(`\n# EDA Job Runner: failed to start (${err.message})\n`);
      this.finish(run, 'failed', null, null);
    });

    child.on('exit', (code, signal) => {
      const state: JobRunState = run.killRequested ? 'killed' : code === 0 ? 'passed' : 'failed';
      this.finish(run, state, code, signal);
    });

    return this.waitForLane(laneKey);
  }

  /** Stop the primary run, or a specific lane (`laneKey`) of a job with more than one tracked run. */
  async stop(jobId: string, laneKey: string = jobId): Promise<void> {
    const run = this.activeRuns.get(laneKey);
    const graceMs = this.getGraceMs();

    if (run) {
      if (!run.child.pid) {
        return;
      }
      // detached: true put the child in its own process group (its pid == pgid),
      // so signalling -pid reaches the whole make/shell/simulator tree, not just
      // the immediate child. This is what makes stop() actually free the license.
      run.killRequested = true;
      safeKill(run.child.pid, 'SIGTERM');
      run.killTimer = setTimeout(() => {
        if (this.activeRuns.has(laneKey) && run.child.pid) {
          safeKill(run.child.pid, 'SIGKILL');
        }
      }, graceMs);
      return;
    }

    if (laneKey !== jobId) {
      // Extra/batch lanes aren't persisted across a reload — if there's no
      // live ActiveRun for one, it's already gone, nothing to reattach to.
      return;
    }

    // No live ChildProcess handle — this is a "running (detached)" job left
    // over from before a window reload. We can still signal its process group
    // by pid, but since we'll never get an exit event for it, we poll instead.
    const status = this.statuses.get(jobId);
    if (status?.state !== 'running' || !status.pid) {
      return;
    }
    const pid = status.pid;
    safeKill(pid, 'SIGTERM');
    await delay(graceMs);
    if (isPidAlive(pid)) {
      safeKill(pid, 'SIGKILL');
      await delay(300);
    }
    this.setStatus(jobId, { ...status, state: 'killed', endTime: Date.now(), detached: undefined });
  }

  /** Stop every currently-running lane of a job (concurrent extras and/or the primary). */
  async stopAllRuns(jobId: string): Promise<void> {
    const laneKeys = [...this.activeRuns.entries()]
      .filter(([, run]) => run.jobId === jobId)
      .map(([laneKey]) => laneKey);
    await Promise.all(laneKeys.map(laneKey => this.stop(jobId, laneKey)));
  }

  private appendOutput(run: ActiveRun, chunk: Buffer, maxBytes: number, stripAnsi: boolean): void {
    const stripped = chunk.toString('utf8').replace(ANSI_PATTERN, '');

    // Feed lines (on ANSI-stripped text so escape codes can't break the
    // regexes) to the structured issue parser and/or the fail/pass pattern
    // scan, even after the log file itself has been truncated, so counts and
    // pattern matches stay accurate for arbitrarily large runs. The pattern
    // scan is a separate, lighter mechanism than the structured parser and
    // runs even when the job opted out of "Scan output" (parseProblems).
    if (run.parseProblems || run.failRegex || run.passRegex) {
      this.feedLines(run, stripped);
    }

    if (run.truncated) {
      return;
    }
    const data = stripAnsi ? Buffer.from(stripped) : chunk;
    run.bytesWritten += data.length;
    if (run.bytesWritten > maxBytes) {
      run.truncated = true;
      run.logStream.write(
        `\n# EDA Job Runner: log capture truncated at ${Math.round(maxBytes / MB)} MB. The job is still running.\n`
      );
      return;
    }
    run.logStream.write(data);
  }

  /**
   * Split streamed text into whole lines (carrying a partial across chunks),
   * feeding each to the structured issue parser (when `parseProblems`) and/or
   * the fail/pass pattern scan (when either pattern is set) -- the two are
   * independent, sharing only this line-buffering so a match can't be missed
   * or double-counted at a chunk boundary.
   */
  private feedLines(run: ActiveRun, strippedText: string): void {
    const lines = (run.lineCarry + strippedText).split('\n');
    run.lineCarry = lines.pop() ?? '';
    for (const line of lines) {
      if (run.parseProblems) {
        try {
          parseLine(line, run.parseState);
        } catch {
          // A parser fault must never break the actual job or its log capture —
          // just stop parsing this run. (The per-job "Scan output" toggle is the
          // deliberate opt-out; this catch is the last-resort safety net.)
          run.parseProblems = false;
        }
      }
      this.scanLinePatterns(run, line);
    }
    // Update live counts in place on whatever status object(s) currently
    // represent this lane; the 1s ticker refreshes the tree without a
    // memento write per chunk.
    for (const status of this.liveStatusRefs(run)) {
      status.errorCount = run.parseState.errorCount;
      status.warningCount = run.parseState.warningCount;
    }
  }

  /** Test `failRegex`/`passRegex` (if set) against one line; sticky once matched, for this run. */
  private scanLinePatterns(run: ActiveRun, line: string): void {
    if (run.failRegex && !run.matchedFail && run.failRegex.test(line)) {
      run.matchedFail = true;
    }
    if (run.passRegex && !run.matchedPass && run.passRegex.test(line)) {
      run.matchedPass = true;
    }
  }

  private liveStatusRefs(run: ActiveRun): JobRunStatus[] {
    const refs: JobRunStatus[] = [];
    if (run.mirrorPrimary) {
      const status = this.statuses.get(run.jobId);
      if (status) {
        refs.push(status);
      }
    }
    const laneStatus = this.laneGroups.get(run.jobId)?.get(run.laneKey);
    if (laneStatus) {
      refs.push(laneStatus);
    }
    return refs;
  }

  private finish(run: ActiveRun, state: JobRunState, exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (run.finished) {
      // Node can fire both 'error' and 'exit' for the same child in some
      // failure modes; only the first should actually finalize this run.
      return;
    }
    run.finished = true;
    if (run.killTimer) {
      clearTimeout(run.killTimer);
    }
    const jobId = run.jobId;
    const laneKey = run.laneKey;
    const previous = run.mirrorPrimary ? this.statuses.get(jobId) : this.laneGroups.get(jobId)?.get(laneKey);
    const endTime = Date.now();

    let errorCount = previous?.errorCount ?? 0;
    let warningCount = previous?.warningCount ?? 0;

    // Flush the last partial line to both the structured parser (if enabled)
    // and the fail/pass pattern scan (if either pattern is set) -- moved out
    // of the `parseProblems` gate below so a pattern-only job (parseProblems
    // off) still sees its very last, un-terminated line.
    if (run.lineCarry.length > 0) {
      if (run.parseProblems) {
        try {
          parseLine(run.lineCarry, run.parseState);
        } catch {
          run.parseProblems = false;
        }
      }
      this.scanLinePatterns(run, run.lineCarry);
      run.lineCarry = '';
    }

    if (run.parseProblems) {
      errorCount = run.parseState.errorCount;
      warningCount = run.parseState.warningCount;
      if (run.mirrorPrimary) {
        this.diagnostics.setJobIssues(jobId, run.cwdAbs, run.parseState.issues);
      }
    } else {
      // Parsing disabled for this job: no counts, no diagnostics, pure exit code
      // (unless a fail/pass pattern below overrides it).
      errorCount = 0;
      warningCount = 0;
    }

    // Exit-code-only status is insufficient for EDA tools: a UVM_ERROR does
    // not make the simulator exit non-zero (confirmed against real DSim), and
    // some tools' real verdict is a printed summary line an exit code can't
    // capture at all either way. `failPattern`/`passPattern` are tool-agnostic
    // user-defined overrides for that; see jobOutcome.ts for the full
    // precedence (killed > failPattern > passPattern > log-errors > exit code).
    const failOnLogErrors = vscode.workspace
      .getConfiguration('eda-job-runner', this.workspaceFolder.uri)
      .get<boolean>('failOnLogErrors', true);
    const finalState = decideFinalState({
      baseState: state,
      errorCount,
      failOnLogErrors,
      parseProblems: run.parseProblems,
      hasFailPattern: !!run.failRegex,
      hasPassPattern: !!run.passRegex,
      matchedFail: run.matchedFail,
      matchedPass: run.matchedPass
    });

    const patternNote = run.matchedFail
      ? ' [failPattern matched]'
      : run.passRegex && !run.matchedPass
        ? ' [passPattern not found]'
        : run.matchedPass
          ? ' [passPattern matched]'
          : '';
    run.logStream.write(
      `\n# EDA Job Runner: ${finalState} (exit ${exitCode ?? 'n/a'}${signal ? `, signal ${signal}` : ''}` +
        `${errorCount || warningCount ? `, ${errorCount} error(s) ${warningCount} warning(s) parsed` : ''})${patternNote} ` +
        `at ${new Date(endTime).toISOString()}\n`
    );
    run.logStream.end();
    this.activeRuns.delete(laneKey);

    this.setLaneStatus(run, {
      state: finalState,
      startTime: previous?.startTime,
      endTime,
      exitCode,
      signal,
      logPath: previous?.logPath,
      errorCount,
      warningCount,
      laneLabel: run.label,
      resolvedCommand: run.resolvedCommand
    });

    this.resolveLaneCompletion(laneKey, finalState);
  }

  /** Route a status update to the persisted primary slot and/or this job's lane group, as applicable. */
  private setLaneStatus(run: ActiveRun, status: JobRunStatus): void {
    if (run.mirrorPrimary) {
      // Unchanged primary path: persists + fires onDidChangeStatus(jobId),
      // which drives notifications — exactly as before this feature existed.
      this.setStatus(run.jobId, status);
    }
    const group = this.laneGroups.get(run.jobId);
    if (group) {
      group.set(run.laneKey, status);
      this.pruneLaneGroup(group);
      if (!run.mirrorPrimary) {
        // A concurrent extra lane changed. Fire with no jobId — the tree
        // refreshes (it always re-reads getLanes/getStatus fresh) but this
        // deliberately does NOT trigger a completion notification, since
        // notifyOnCompletion re-reads the *primary* status and would show
        // stale/unrelated content for a lane it doesn't know about.
        this._onDidChangeStatus.fire(undefined);
      }
    }
  }

  private pruneLaneGroup(group: Map<string, JobRunStatus>): void {
    if (group.size <= MAX_LANES_PER_JOB) {
      return;
    }
    for (const [key, status] of group) {
      if (group.size <= MAX_LANES_PER_JOB) {
        break;
      }
      if (status.state !== 'running') {
        group.delete(key);
      }
    }
  }

  private beginLaneCompletion(laneKey: string): void {
    const promise = new Promise<JobRunState>(resolve => {
      this.laneCompletionResolvers.set(laneKey, resolve);
    });
    this.laneCompletionPromises.set(laneKey, promise);
  }

  private resolveLaneCompletion(laneKey: string, state: JobRunState): void {
    const resolve = this.laneCompletionResolvers.get(laneKey);
    this.laneCompletionResolvers.delete(laneKey);
    this.laneCompletionPromises.delete(laneKey);
    resolve?.(state);
  }

  private waitForLane(laneKey: string): Promise<JobRunState> {
    return this.laneCompletionPromises.get(laneKey) ?? Promise.resolve('idle');
  }

  private setStatus(jobId: string, status: JobRunStatus): void {
    this.statuses.set(jobId, status);
    void this.persistStatuses();
    this._onDidChangeStatus.fire(jobId);
  }

  private async persistStatuses(): Promise<void> {
    await this.memento.update(STATUS_STORAGE_KEY, Object.fromEntries(this.statuses));
  }

  private async persistParamValues(): Promise<void> {
    await this.memento.update(PARAM_VALUES_STORAGE_KEY, Object.fromEntries(this.paramValues));
  }

  private getGraceMs(): number {
    const config = vscode.workspace.getConfiguration('eda-job-runner', this.workspaceFolder.uri);
    return Math.max(0, config.get<number>('killGracePeriodSeconds', 5)) * 1000;
  }

  private hasAnyRunning(): boolean {
    // activeRuns covers every live lane (primary, concurrent extras, and the
    // in-flight iteration of a sequential batch); the statuses scan on top
    // additionally catches a "running (detached)" job reconstructed after a
    // window reload, which never gets an ActiveRun entry.
    return this.activeRuns.size > 0 || [...this.statuses.values()].some(s => s.state === 'running');
  }

  private ensureTicking(): void {
    if (this.tickTimer) {
      return;
    }
    this.tickTimer = setInterval(() => {
      if (!this.hasAnyRunning()) {
        clearInterval(this.tickTimer);
        this.tickTimer = undefined;
        return;
      }
      this._onDidChangeStatus.fire(undefined);
    }, 1000);
  }

  dispose(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
    this._onDidChangeStatus.dispose();
    // Running jobs are intentionally left detached and running — closing the
    // sidebar or window shouldn't kill an overnight regression.
  }
}

function buildShellCommand(setup: JobsFileSetup | undefined, resolvedCommand: string, workspaceRoot: string): string {
  const steps: string[] = [];
  if (setup?.script && setup.script.trim().length > 0) {
    const scriptPath = path.isAbsolute(setup.script) ? setup.script : path.join(workspaceRoot, setup.script);
    steps.push(`source "${scriptPath}"`);
  }
  for (const cmd of setup?.commands ?? []) {
    if (cmd.trim().length > 0) {
      steps.push(cmd);
    }
  }
  // Deliberately NOT `exec ${resolvedCommand}`: exec replaces the shell
  // process with the *first* simple command it's given, so if the command
  // itself contains further "&&"/";"/"|" steps (extremely common -- "make
  // clean && make compile", "vlog ... && vsim ..."), everything after the
  // first step would silently never run once that first program's process
  // exits. The extra bash layer this costs is harmless: detached:true +
  // setsid already puts the whole tree in one process group, so
  // kill(-pgid) still reaches everything regardless of how many shells are
  // nested.
  steps.push(resolvedCommand);
  return steps.join(' && ');
}

/** Turn a lane label ("3/10", "#2") into a filesystem-safe log filename suffix. */
function sanitizeLaneSuffix(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group is likely already gone.
  }
}

function isPidAlive(pid: number): boolean {
  try {
    return fs.existsSync(`/proc/${pid}`);
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
