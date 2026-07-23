import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GlobalParam, JobDefinition, JobsFileSetup } from './types';
import { LogManager } from './logManager';
import { ensureGitignoreEntry } from './gitignoreManager';
import { LogDiagnostics } from './logDiagnostics';
import { ParseState, newParseState, parseLine } from './logParser';
import { buildShellInvocation, resolveJobEnv, substituteVars } from './shellInvocation';
import { ParamSpec, parseParams, substituteParams, substituteRandomSeed } from './paramSubstitution';
import { flattenGlobalParams, substituteParamVars } from './paramVars';
import { decideFinalState, compilePattern } from './jobOutcome';
import { parseStartTimeTicks } from './procStat';
import { computeKillSchedule, KillStage, RawKillSignalEntry } from './killPlan';
import { FileTailer } from './tailer';
import { parseLogTrailer } from './logIndex';
import { decideReattachState } from './reattach';
import { RetentionOptions } from './logRetention';

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
   * This process's start time (field 22 of /proc/<pid>/stat, clock ticks
   * since boot), captured right after spawn. Lets a later liveness check
   * confirm `pid` still refers to the same process instead of trusting bare
   * `/proc/<pid>` existence -- on a long-lived host, the OS can recycle a pid
   * for an unrelated process well before this status is next checked (e.g.
   * minutes after a window reload). Undefined for a status persisted before
   * this field existed; treated as "can't verify, fall back to existence
   * only" rather than a hard failure.
   */
  pidStartTime?: number;
  /**
   * True once a "running (detached)" job's live tailing/counts/diagnostics
   * have been resumed after a window reload (see JobRunner.beginReattachment)
   * -- distinct from `detached`, which just means "no live ChildProcess
   * handle exists in this session." A job can be `detached && !reattached`
   * only very briefly, right at extension activation before reattachment
   * kicks in.
   */
  reattached?: boolean;
  /**
   * Set when this status is one of several tracked runs for its job — one
   * iteration of a sequential repeat-count batch ("3/10"). Undefined for a
   * normal single run. Drives the tree's expandable group view (see
   * JobRunner.getLanes).
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
  /**
   * The job's own stdout/stderr are redirected straight to this handle at
   * spawn time (see runLane) so capture survives an extension-host restart —
   * we only use it ourselves for the header/trailer/notice lines, never for
   * the job's actual output, which the child writes directly.
   */
  logHandle: fs.promises.FileHandle;
  logPath: string;
  /** Tails logPath to feed captured output into the parser -- the same mechanism used to resume a reattached job's counts, so live and reattached runs share one code path. */
  tailer: FileTailer;
  /** Total (ANSI-stripped) bytes fed into parsing so far this run -- independent of the log file's own size, which the OS controls now. */
  parseBytesFed: number;
  /** Once true, further chunks are no longer fed to the parser (logMaxSizeMB cap) -- the log file itself keeps growing regardless, that's no longer something this class controls. */
  parseTruncated: boolean;
  maxParseBytes: number;
  killRequested: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  cwdAbs: string;
  parseState: ParseState;
  /** Carry for a partial trailing line split across stdout chunks. */
  lineCarry: string;
  /** Per-job safeguard: when false, skip all output parsing/diagnostics. */
  parseProblems: boolean;
  jobId: string;
  /** Key into `activeRuns`/`laneGroups`: `job.id` for the primary lane, `job.id::runN` for a repeat-count batch iteration. */
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
  /** Captured from the job at spawn time -- see JobDefinition.postRunEnabled/postRunCommand. */
  postRunEnabled: boolean;
  postRunCommand?: string;
}

/**
 * A job resumed after a window reload -- no live `ChildProcess`/exit event
 * exists for it in this session (it was never spawned here), so it's tracked
 * separately from `ActiveRun` rather than shoehorned into that lane-oriented
 * shape. Only ever the job's primary run (batch/concurrent lanes aren't
 * persisted across a reload at all, so there's nothing to reattach to for
 * those). See JobRunner.beginReattachment/reattach.ts.
 */
interface ReattachRun {
  jobId: string;
  logPath: string;
  cwdAbs: string;
  tailer: FileTailer;
  parseState: ParseState;
  lineCarry: string;
  parseProblems: boolean;
  failRegex?: RegExp;
  passRegex?: RegExp;
  matchedFail: boolean;
  matchedPass: boolean;
  parseBytesFed: number;
  parseTruncated: boolean;
  maxParseBytes: number;
  pid: number;
  pidStartTime?: number;
  pollTimer?: ReturnType<typeof setInterval>;
  /** Guards pollReattachment against running twice concurrently if a poll tick fires again before an earlier one's async finalize work finishes. */
  finalizing: boolean;
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
// A post-run command is meant to be a quick follow-up action (a notification,
// a cleanup script), not a second tracked job -- unlike the job itself, it's
// never meant to survive as a detached background process. Mirrors the Test
// button's own timeout in shellEnvPanel.ts.
const POST_RUN_TIMEOUT_MS = 60_000;

export class JobRunner implements vscode.Disposable {
  private readonly _onDidChangeStatus = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private readonly statuses: Map<string, JobRunStatus>;
  private readonly activeRuns = new Map<string, ActiveRun>();
  /** Jobs currently being re-tailed after a window reload. See beginReattachment/ReattachRun. */
  private readonly reattachedRuns = new Map<string, ReattachRun>();
  /** Still-running `runPostRunCommand` children -- unlike the job itself, killed on dispose() (see there) rather than left detached. */
  private readonly postRunChildren = new Set<cp.ChildProcess>();
  /**
   * Lane-group tracking for a job that has run as a sequential repeat-count
   * batch (a job can never run concurrently with itself — see `run()`). Not
   * persisted — live-session only, same tradeoff as the "detached across
   * reload" primary-slot handling below, just not carried across a window
   * reload. A job with no entry here (the common case, runCount 1) renders
   * as a single flat row using `statuses`, exactly as before this feature
   * existed.
   */
  private readonly laneGroups = new Map<string, Map<string, JobRunStatus>>();
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
    private readonly getParams: () => GlobalParam[],
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
      if (status.pid && isPidAliveWithIdentity(status.pid, status.pidStartTime)) {
        // `reattached` always starts false here even if it was true when
        // last persisted -- re-tailing hasn't resumed yet in *this* session
        // (beginReattachment needs the job's definition, which JobStore
        // hasn't finished loading yet at construction time).
        this.statuses.set(jobId, { ...status, detached: true, reattached: undefined });
      } else {
        this.statuses.set(jobId, { ...status, state: 'idle', pid: undefined, pidStartTime: undefined, detached: undefined });
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
   * empty for the overwhelming common case (runCount 1), non-empty once it's
   * had a sequential repeat-count batch. The tree uses this to decide
   * whether to render a job as a flat row (empty) or an expandable group
   * (non-empty).
   */
  getLanes(jobId: string): { laneKey: string; status: JobRunStatus }[] {
    const group = this.laneGroups.get(jobId);
    return group ? [...group.entries()].map(([laneKey, status]) => ({ laneKey, status })) : [];
  }

  /**
   * The log file every currently-live run (spawned or reattached) is
   * actively writing to -- "clean all logs" must never unlink one of these,
   * or the child keeps writing into an orphaned inode while the log viewer
   * and error-count tailing silently freeze on the now-vanished path.
   */
  getActiveLogPaths(): Set<string> {
    const paths = new Set<string>();
    for (const run of this.activeRuns.values()) {
      paths.add(run.logPath);
    }
    for (const run of this.reattachedRuns.values()) {
      paths.add(run.logPath);
    }
    return paths;
  }

  /**
   * Collapse a job's repeat-count batch history back to a flat single-run
   * row, without touching the job itself -- until now the only way back to
   * a flat row was deleting and recreating the job. A no-op while a batch
   * for this job is actually in flight (a live iteration still needs
   * somewhere to record its own lane), so this is only ever wired up to a
   * command scoped to an idle group in the tree.
   */
  clearLanes(jobId: string): void {
    if (this.activeBatchJobs.has(jobId) || [...this.activeRuns.values()].some(run => run.jobId === jobId)) {
      return;
    }
    this.laneGroups.delete(jobId);
    this._onDidChangeStatus.fire(jobId);
  }

  /**
   * `forcedCommand`, set by "Re-run Last", replays one exact prior resolved
   * command verbatim -- no `${param:...}` prompt, no fresh `${randomSeed}`,
   * and always a single run regardless of the job's repeat count, since it's
   * meant to reproduce one specific prior run (e.g. a failure) exactly.
   */
  async run(job: JobDefinition, options?: { forcedCommand?: string }): Promise<void> {
    // A job can never run concurrently with itself — its own sequential Repeat
    // Count (runBatch) is the only way it ever has more than one tracked run,
    // and that's still just one lane in flight at a time. This guard is
    // unconditional on experimentalMultipleRuns, which only ever gates
    // *different* jobs running side by side. `promptingJobs` covers a run
    // still sitting in its `${param:...}` prompt (no activeRuns entry yet),
    // so a fast double-click can't slip through the window before a lane
    // exists.
    if (this.activeRuns.has(job.id) || this.promptingJobs.has(job.id) || this.activeBatchJobs.has(job.id)) {
      void vscode.window.showInformationMessage(`"${job.name}" is already running.`);
      return;
    }

    const config = vscode.workspace.getConfiguration('eda-job-runner', this.workspaceFolder.uri);
    const multiEnabled = config.get<boolean>('experimentalMultipleRuns', false);
    if (!multiEnabled && (this.activeRuns.size > 0 || this.promptingJobs.size > 0)) {
      void vscode.window.showWarningMessage(
        'Only one job can run at a time for now — stop the current job first, or turn on ' +
          '"Experimental: multiple jobs" in settings.'
      );
      return;
    }

    if (options?.forcedCommand !== undefined) {
      await this.runLane(job, job.id, undefined, true, options.forcedCommand);
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

    // `${var:NAME}` references resolve silently -- no prompt, unlike
    // `${param:...}` above -- from this job's own override, else the
    // workspace-wide global default (Parameters panel). Resolved once per
    // Run, same as `${param:...}`, so a repeat-count batch stays consistent;
    // the result is baked into `resolvedCommand`, so Re-run Last (which
    // returns before this point via `forcedCommand`) replays the exact same
    // values without re-resolving.
    template = substituteParamVars(template, flattenGlobalParams(this.getParams()), job.paramOverrides ?? {});

    const runCount = Math.max(1, Math.min(1000, Math.round(job.runCount ?? 1)));
    if (runCount > 1) {
      this.activeBatchJobs.add(job.id);
      try {
        await this.runBatch(job, runCount, template);
      } finally {
        this.activeBatchJobs.delete(job.id);
      }
      return;
    }

    await this.runLane(job, job.id, undefined, true, template);
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

  /**
   * The directory a job's shell starts in: its own Advanced override wins
   * over the workspace-wide `postSetupCwd` setting; once resolved, `cwd`
   * resolves against that instead of the workspace root. Shared by runLane
   * (a real spawn) and startReattachment (needs the same directory to
   * resolve a reattached run's Problems-panel paths correctly).
   */
  private resolveCwdAbs(job: JobDefinition, globalPostSetupCwd: string): string {
    const workspaceRoot = this.workspaceFolder.uri.fsPath;
    const effectivePostSetupCwd = (job.postSetupCwd && job.postSetupCwd.trim()) || globalPostSetupCwd;
    const baseDir = effectivePostSetupCwd.trim()
      ? path.resolve(workspaceRoot, substituteVars(effectivePostSetupCwd.trim(), workspaceRoot))
      : workspaceRoot;
    return path.resolve(baseDir, job.cwd || '.');
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
    const { command: resolvedCommand, seed } = substituteRandomSeed(template);

    const config = vscode.workspace.getConfiguration('eda-job-runner', this.workspaceFolder.uri);
    const shellPath = (config.get<string>('shellPath', 'bash') || 'bash').trim() || 'bash';
    const shellArgs = config.get<string[] | null>('shellArgs', null);
    const envSetting = config.get<Record<string, string>>('env', {});
    const maxBytes = Math.max(1, config.get<number>('logMaxSizeMB', 200)) * MB;
    // 0 means "no limit" for either -- see logRetention.ts's planPrune.
    const retention: RetentionOptions = {
      maxCount: Math.max(0, config.get<number>('logRetentionCount', 20)),
      maxTotalBytes: Math.max(0, config.get<number>('logRetentionMaxSizeMB', 0)) * MB
    };
    const globalPostSetupCwd = config.get<string>('postSetupCwd', '');

    const workspaceRoot = this.workspaceFolder.uri.fsPath;
    const cwdAbs = this.resolveCwdAbs(job, globalPostSetupCwd);
    const shellCommand = buildShellCommand(this.getSetup(), resolvedCommand, workspaceRoot);

    const logsRoot = this.logManager.resolveRoot(job.logsDirectory);
    void ensureGitignoreEntry(this.workspaceFolder, this.memento, logsRoot);

    // Fresh run: drop the previous run's Problems-panel entries for this job
    // (every lane is mirrorPrimary=true now that a job can't run concurrently
    // with itself, so this always fires — including each repeat-count
    // iteration, which is exactly what should reset diagnostics per run).
    if (mirrorPrimary) {
      this.diagnostics.clearJob(job.id);
    }

    const laneSuffix = laneKey === job.id ? undefined : sanitizeLaneSuffix(label ?? laneKey);
    const { logPath, handle: logHandle } = await this.logManager.createLogFile(job.id, retention, laneSuffix, logsRoot);
    const startTime = Date.now();
    // The structured fields (seed/cwd/started) are written BEFORE the
    // free-text command line deliberately: the log viewer's header parser
    // only reads a capped prefix of the file (see logManager.ts's
    // readHeadTail), and a long resolved command (common for EDA compile
    // invocations with many file arguments) would otherwise push those
    // fields past the cap and silently drop them from the viewer.
    await logHandle.write(
      `# EDA Job Runner\n# job: ${job.name}${label ? ` (run ${label})` : ''}\n` +
        (seed !== undefined ? `# seed: ${seed}\n` : '') +
        `# cwd: ${cwdAbs}\n# started: ${new Date(startTime).toISOString()}\n` +
        `# command: ${resolvedCommand}\n\n`
    );
    if ((job.failPattern?.trim() && !compilePattern(job.failPattern)) || (job.passPattern?.trim() && !compilePattern(job.passPattern))) {
      await logHandle.write('# EDA Job Runner: an invalid fail/pass pattern (bad regex) was ignored\n\n');
    }

    // Argument vector is derived from the shell family (or a user override) so
    // non-bash shells work: a hardcoded `-lc` is invalid for tcsh/csh. See
    // buildShellInvocation. env is only passed when the user configured extra
    // vars, otherwise the child inherits process.env as before.
    const { file: shellFile, args: shellSpawnArgs } = buildShellInvocation(shellPath, shellArgs, shellCommand);
    // stdout/stderr are redirected straight to the log file's own fd (an
    // inherited fd, not a shell-level `>` redirect -- shell-agnostic across
    // bash/tcsh/csh and doesn't disturb exit-code capture) instead of being
    // piped through this extension host. This is what lets capture survive a
    // window reload: the write goes straight from the child to the file at
    // the OS level, so it doesn't depend on this process staying alive to
    // relay it. `feedLines`/logParser now get their input by tailing the file
    // (see the FileTailer below) instead of from a 'data' event on a pipe --
    // the same mechanism a reattached (post-reload) job uses to resume, so
    // live and reattached runs share one code path rather than one being a
    // special case of the other.
    const child = cp.spawn(shellFile, shellSpawnArgs, {
      cwd: cwdAbs,
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      env: resolveJobEnv(envSetting, workspaceRoot)
    });

    const run: ActiveRun = {
      child,
      logHandle,
      logPath,
      tailer: new FileTailer(logPath, chunk => this.feedChunk(run, chunk)),
      parseBytesFed: 0,
      parseTruncated: false,
      maxParseBytes: maxBytes,
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
      matchedPass: false,
      postRunEnabled: job.postRunEnabled === true,
      postRunCommand: job.postRunCommand
    };
    this.activeRuns.set(laneKey, run);
    this.beginLaneCompletion(laneKey);
    this.setLaneStatus(run, {
      state: 'running',
      startTime,
      logPath,
      pid: child.pid,
      pidStartTime: child.pid ? readProcStartTime(child.pid) : undefined,
      errorCount: 0,
      warningCount: 0,
      laneLabel: label,
      resolvedCommand
    });
    this.ensureTicking();
    run.tailer.start();

    child.on('error', err => {
      void logHandle.write(`\n# EDA Job Runner: failed to start (${err.message})\n`).catch(() => undefined);
      void this.finish(run, 'failed', null, null);
    });

    child.on('exit', (code, signal) => {
      const state: JobRunState = run.killRequested ? 'killed' : code === 0 ? 'passed' : 'failed';
      void this.finish(run, state, code, signal);
    });

    return this.waitForLane(laneKey);
  }

  /** Stop the primary run, or a specific lane (`laneKey`) of a job with more than one tracked run. */
  async stop(jobId: string, laneKey: string = jobId): Promise<void> {
    const run = this.activeRuns.get(laneKey);

    if (run) {
      if (!run.child.pid) {
        return;
      }
      // detached: true put the child in its own process group (its pid == pgid),
      // so signalling -pid reaches the whole make/shell/simulator tree, not just
      // the immediate child. This is what makes stop() actually free the license.
      run.killRequested = true;
      this.advanceKillSchedule(run, run.child.pid, this.buildKillSchedule(), 0);
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
    if (!isPidAliveWithIdentity(pid, status.pidStartTime)) {
      // The process already exited (or the OS recycled this pid for something
      // else) since we last checked — nothing to signal. Signalling a bare,
      // unverified pid here would risk killing an unrelated process.
      this.setStatus(jobId, { ...status, state: 'idle', pid: undefined, pidStartTime: undefined, detached: undefined });
      return;
    }
    await this.runDetachedKillSchedule(pid, status.pidStartTime, this.buildKillSchedule());
    this.setStatus(jobId, { ...status, state: 'killed', endTime: Date.now(), detached: undefined });
  }

  /** The `killSignals` setting (falling back to `killGracePeriodSeconds` per unset stage) as a concrete schedule. See killPlan.ts. */
  private buildKillSchedule(): KillStage[] {
    const config = vscode.workspace.getConfiguration('eda-job-runner', this.workspaceFolder.uri);
    return computeKillSchedule({
      signals: config.get<RawKillSignalEntry[]>('killSignals'),
      fallbackGraceMs: this.getGraceMs()
    });
  }

  /**
   * Live-run escalation: send `schedule[index]`'s signal now; if it's not the
   * final stage, arrange to advance to the next one after its grace period,
   * unless the run has genuinely exited by then (`finish()` both clears
   * `run.killTimer` synchronously on the real 'exit' event AND this always
   * re-checks `activeRuns.has(laneKey)` before signalling, belt-and-suspenders
   * against a stray late signal).
   */
  private advanceKillSchedule(run: ActiveRun, pid: number, schedule: KillStage[], index: number): void {
    if (!this.activeRuns.has(run.laneKey)) {
      return;
    }
    safeKill(pid, schedule[index].signal);
    const nextIndex = index + 1;
    if (nextIndex >= schedule.length) {
      run.killTimer = undefined;
      return;
    }
    run.killTimer = setTimeout(() => this.advanceKillSchedule(run, pid, schedule, nextIndex), schedule[index].graceMs);
  }

  /**
   * Detached-reload escalation: same schedule, but driven by polling
   * `isPidAliveWithIdentity` between stages (an async sleep, not a timer)
   * since there's no live ChildProcess/exit event to race against here. Ends
   * with the same 300ms settle-and-verify window the pre-schedule code used
   * after its final SIGKILL.
   */
  private async runDetachedKillSchedule(pid: number, expectedStartTime: number | undefined, schedule: KillStage[]): Promise<void> {
    for (let i = 0; i < schedule.length; i++) {
      if (!isPidAliveWithIdentity(pid, expectedStartTime)) {
        return;
      }
      safeKill(pid, schedule[i].signal);
      if (i < schedule.length - 1) {
        await delay(schedule[i].graceMs);
      }
    }
    await delay(300);
  }

  /** Stop the job's currently-running lane (its own repeat-count batch runs one lane at a time, so there's at most one). */
  async stopAllRuns(jobId: string): Promise<void> {
    const laneKeys = [...this.activeRuns.entries()]
      .filter(([, run]) => run.jobId === jobId)
      .map(([laneKey]) => laneKey);
    await Promise.all(laneKeys.map(laneKey => this.stop(jobId, laneKey)));
  }

  /**
   * Called with each new chunk a run's FileTailer reads off its log file --
   * the only path output reaches the parser now, whether the job is live or
   * reattached after a reload (see runLane's spawn comment). `logMaxSizeMB`
   * used to cap what got written to the log file itself; now the OS writes
   * that file directly (the whole point of this redesign), so it instead
   * caps how much gets fed into in-memory parsing/counting per run -- the
   * log file keeps growing and recording everything regardless.
   */
  private feedChunk(run: ActiveRun, chunk: string): void {
    if (run.parseTruncated) {
      return;
    }
    // ANSI-stripped so escape codes can't break the regexes. The pattern
    // scan is a separate, lighter mechanism than the structured parser and
    // runs even when the job opted out of "Scan output" (parseProblems).
    const stripped = chunk.replace(ANSI_PATTERN, '');
    if (run.parseProblems || run.failRegex || run.passRegex) {
      this.feedLines(run, stripped);
    }
    run.parseBytesFed += Buffer.byteLength(stripped, 'utf8');
    if (run.parseBytesFed > run.maxParseBytes) {
      run.parseTruncated = true;
      void run.logHandle
        .write(
          `\n# EDA Job Runner: error/warning parsing capped at ${Math.round(run.maxParseBytes / MB)} MB of ` +
            "this run's output. The job keeps running and its full output keeps being recorded below -- only " +
            'further error/warning counting and pattern matching stop.\n'
        )
        .catch(() => undefined);
      // The tailer's only purpose is feeding chunks here (feedChunk), and
      // parsing/pattern-matching is now permanently capped for the rest of
      // this run -- polling on, reading every subsequent 500ms delta off a
      // (potentially still-growing, up to 200MB) log file just to hand it
      // straight to the `if (run.parseTruncated) return;` guard above would
      // be pure wasted I/O for however much longer the run keeps going.
      run.tailer.stop();
    }
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

  private async finish(run: ActiveRun, state: JobRunState, exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (run.finished) {
      // Node can fire both 'error' and 'exit' for the same child in some
      // failure modes; only the first should actually finalize this run. This
      // guard (unlike removing the activeRuns entry, see below) happens
      // before the first `await` below, so it's still race-free now that
      // finish() is async.
      return;
    }
    run.finished = true;
    if (run.killTimer) {
      clearTimeout(run.killTimer);
    }

    // The child wrote straight to the log file (no pipe in between), so its
    // output is already durable on disk by the time 'exit' fires -- but our
    // own FileTailer only sees it once it next polls. One more synchronous
    // poll here guarantees the final counts/lineCarry reflect the whole run
    // before we compute its final state below.
    await run.tailer.pollOnce();
    run.tailer.stop();

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
    await run.logHandle
      .write(
        `\n# EDA Job Runner: ${finalState} (exit ${exitCode ?? 'n/a'}${signal ? `, signal ${signal}` : ''}` +
          `${errorCount || warningCount ? `, ${errorCount} error(s) ${warningCount} warning(s) parsed` : ''})${patternNote} ` +
          `at ${new Date(endTime).toISOString()}\n`
      )
      .catch(() => undefined);
    await run.logHandle.close().catch(() => undefined);

    // A user Stop isn't "the job's done, run the follow-up" -- skip it for a
    // killed run. Fire-and-forget: this shouldn't block lane completion, and
    // its own outcome is surfaced via a notification, never folded into the
    // job's own already-decided pass/fail.
    if (finalState !== 'killed') {
      this.runPostRunCommand(run);
    }

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

    // Only removed here, at the very end -- not right after the 'exit'/'error'
    // event fires -- so `run()`'s activeRuns.has(laneKey) guard keeps refusing
    // a new run for this same lane for as long as this finish() still has
    // cleanup in flight (log trailer write/close, setLaneStatus above). Doing
    // this earlier left a window where a fresh run() could slip through the
    // guard, get its own activeRuns entry, and then have this finish() call
    // overwrite its live "running" status with this (older) run's terminal
    // one once the awaits above finally settled.
    this.activeRuns.delete(run.laneKey);
    this.resolveLaneCompletion(laneKey, finalState);
  }

  /**
   * Spawns `run.postRunCommand` fire-and-forget, once per completed lane --
   * same shell/setup chain and working directory as the job itself, but
   * intentionally not folded into the main pipeline's capture/parsing/
   * status: this is a lightweight follow-up action, not a second tracked
   * job, so a failure here only shows a warning notification. A no-op
   * unless the job's "Run a command after this job finishes" checkbox is
   * on and the field isn't blank.
   */
  private runPostRunCommand(run: ActiveRun): void {
    const postRunCommand = run.postRunCommand?.trim();
    if (!run.postRunEnabled || !postRunCommand) {
      return;
    }
    const config = vscode.workspace.getConfiguration('eda-job-runner', this.workspaceFolder.uri);
    const shellPath = (config.get<string>('shellPath', 'bash') || 'bash').trim() || 'bash';
    const shellArgs = config.get<string[] | null>('shellArgs', null);
    const envSetting = config.get<Record<string, string>>('env', {});
    const workspaceRoot = this.workspaceFolder.uri.fsPath;
    const shellCommand = buildShellCommand(this.getSetup(), postRunCommand, workspaceRoot);
    const { file, args } = buildShellInvocation(shellPath, shellArgs, shellCommand);

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(file, args, {
        cwd: run.cwdAbs,
        stdio: 'ignore',
        env: resolveJobEnv(envSetting, workspaceRoot)
      });
    } catch (err) {
      void vscode.window.showWarningMessage(
        `EDA Job Runner: post-run command failed to start: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    this.postRunChildren.add(child);
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, POST_RUN_TIMEOUT_MS);

    child.on('error', err => {
      clearTimeout(timer);
      this.postRunChildren.delete(child);
      void vscode.window.showWarningMessage(`EDA Job Runner: post-run command failed to start: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      this.postRunChildren.delete(child);
      if (code !== 0 || signal) {
        void vscode.window.showWarningMessage(
          `EDA Job Runner: post-run command exited ${code ?? 'n/a'}${
            signal ? ` (signal ${signal}${signal === 'SIGKILL' ? ', timed out' : ''})` : ''
          }.`
        );
      }
    });
  }

  /**
   * Called once at activation, after the workspace's job definitions have
   * finished loading (JobStore loads asynchronously and isn't wired into
   * this class's constructor, so a job's parseProblems/failPattern/
   * passPattern aren't available any earlier than this). For every job the
   * constructor above left "running (detached)" with a still-alive,
   * identity-verified pid, resumes live tailing/counts/diagnostics and
   * starts polling for its actual completion -- see reattach.ts for how a
   * final state is inferred without a real exit code.
   */
  beginReattachment(getJob: (jobId: string) => JobDefinition | undefined): void {
    for (const [jobId, status] of this.statuses) {
      if (status.state !== 'running' || !status.detached || !status.pid || !status.logPath) {
        continue;
      }
      const job = getJob(jobId);
      if (!job) {
        // Job definition deleted since this run started -- Stop still works
        // via the raw pid (see stop()'s detached branch), just no live
        // re-tailing without a job to read parseProblems/patterns from.
        continue;
      }
      this.startReattachment(job, status.pid, status.pidStartTime, status.logPath);
    }
  }

  private startReattachment(job: JobDefinition, pid: number, pidStartTime: number | undefined, logPath: string): void {
    const config = vscode.workspace.getConfiguration('eda-job-runner', this.workspaceFolder.uri);
    const globalPostSetupCwd = config.get<string>('postSetupCwd', '');
    const maxParseBytes = Math.max(1, config.get<number>('logMaxSizeMB', 200)) * MB;

    this.diagnostics.clearJob(job.id);
    const run: ReattachRun = {
      jobId: job.id,
      logPath,
      cwdAbs: this.resolveCwdAbs(job, globalPostSetupCwd),
      tailer: new FileTailer(logPath, chunk => this.feedReattachChunk(run, chunk)),
      parseState: newParseState(),
      lineCarry: '',
      parseProblems: job.parseProblems !== false,
      failRegex: compilePattern(job.failPattern),
      passRegex: compilePattern(job.passPattern),
      matchedFail: false,
      matchedPass: false,
      parseBytesFed: 0,
      parseTruncated: false,
      maxParseBytes,
      pid,
      pidStartTime,
      finalizing: false
    };
    this.reattachedRuns.set(job.id, run);

    const status = this.statuses.get(job.id);
    if (status) {
      // Rebuilding from byte 0 (FileTailer's default start point) since
      // there's no persisted ParseState to resume from -- errorCount/
      // warningCount/Problems-panel issues are cumulative over the whole
      // run, not just what's written after this reload.
      this.setStatus(job.id, { ...status, reattached: true, errorCount: 0, warningCount: 0 });
    }
    run.tailer.start();
    run.pollTimer = setInterval(() => void this.pollReattachment(run), 1000);
    this.ensureTicking();
  }

  private feedReattachChunk(run: ReattachRun, chunk: string): void {
    if (run.parseTruncated) {
      return;
    }
    const stripped = chunk.replace(ANSI_PATTERN, '');
    if (run.parseProblems || run.failRegex || run.passRegex) {
      this.feedReattachLines(run, stripped);
    }
    run.parseBytesFed += Buffer.byteLength(stripped, 'utf8');
    if (run.parseBytesFed > run.maxParseBytes) {
      run.parseTruncated = true;
      // Same reasoning as feedChunk's own tailer.stop() -- nothing further
      // is ever done with a chunk once parsing is capped for the rest of
      // this run, so keep polling for one would be pure wasted I/O.
      run.tailer.stop();
    }
  }

  private feedReattachLines(run: ReattachRun, strippedText: string): void {
    const lines = (run.lineCarry + strippedText).split('\n');
    run.lineCarry = lines.pop() ?? '';
    for (const line of lines) {
      if (run.parseProblems) {
        try {
          parseLine(line, run.parseState);
        } catch {
          run.parseProblems = false;
        }
      }
      if (run.failRegex && !run.matchedFail && run.failRegex.test(line)) {
        run.matchedFail = true;
      }
      if (run.passRegex && !run.matchedPass && run.passRegex.test(line)) {
        run.matchedPass = true;
      }
    }
    const status = this.statuses.get(run.jobId);
    if (status) {
      status.errorCount = run.parseState.errorCount;
      status.warningCount = run.parseState.warningCount;
    }
    if (run.parseProblems) {
      // No single finish() call exists to do this once at the end for a
      // reattached run, so diagnostics are pushed incrementally as lines
      // come in instead -- setJobIssues replaces the whole set each time,
      // so this is just "keep it current," not an ever-growing list.
      this.diagnostics.setJobIssues(run.jobId, run.cwdAbs, run.parseState.issues);
    }
  }

  /** Poll a reattached job's identity-verified pid liveness; once it disappears, finalize its state and stop tracking it. */
  private async pollReattachment(run: ReattachRun): Promise<void> {
    if (run.finalizing || isPidAliveWithIdentity(run.pid, run.pidStartTime)) {
      return;
    }
    run.finalizing = true;
    if (run.pollTimer) {
      clearInterval(run.pollTimer);
      run.pollTimer = undefined;
    }

    // Same reasoning as finish(): the process's own writes are already
    // durable on disk by the time its pid disappears, but our tailer only
    // sees them on its next poll -- force one more here first.
    await run.tailer.pollOnce();
    run.tailer.stop();

    if (run.lineCarry.length > 0) {
      if (run.parseProblems) {
        try {
          parseLine(run.lineCarry, run.parseState);
        } catch {
          run.parseProblems = false;
        }
      }
      if (run.failRegex && !run.matchedFail && run.failRegex.test(run.lineCarry)) {
        run.matchedFail = true;
      }
      if (run.passRegex && !run.matchedPass && run.passRegex.test(run.lineCarry)) {
        run.matchedPass = true;
      }
      run.lineCarry = '';
    }
    if (run.parseProblems) {
      this.diagnostics.setJobIssues(run.jobId, run.cwdAbs, run.parseState.issues);
    }

    const failOnLogErrors = vscode.workspace
      .getConfiguration('eda-job-runner', this.workspaceFolder.uri)
      .get<boolean>('failOnLogErrors', true);
    const { tail } = await this.logManager.readHeadTail(run.logPath);
    const existingTrailerState = asJobRunState(parseLogTrailer(tail).state);
    const finalState =
      decideReattachState({
        pidAlive: false,
        existingTrailerState,
        errorCount: run.parseState.errorCount,
        failOnLogErrors,
        parseProblems: run.parseProblems,
        hasFailPattern: !!run.failRegex,
        hasPassPattern: !!run.passRegex,
        matchedFail: run.matchedFail,
        matchedPass: run.matchedPass
      }) ?? 'failed';

    // No real exit code is ever available for a reattached process (there
    // was never a live ChildProcess/exit event for it in this session) --
    // write our own completion trailer, in the same format finish() uses, so
    // the log/Log Viewer look consistent regardless of which path finalized
    // a given run. Skipped if a trailer already existed (the defensive
    // "already finalized somehow" case decideReattachState also handles).
    if (!existingTrailerState) {
      const endTime = Date.now();
      await fs.promises
        .appendFile(
          run.logPath,
          `\n# EDA Job Runner: ${finalState} (exit n/a` +
            `${run.parseState.errorCount || run.parseState.warningCount ? `, ${run.parseState.errorCount} error(s) ${run.parseState.warningCount} warning(s) parsed` : ''})` +
            ' [reattached: resumed after a window reload, no real exit code available] ' +
            `at ${new Date(endTime).toISOString()}\n`
        )
        .catch(() => undefined);
    }

    this.reattachedRuns.delete(run.jobId);
    const status = this.statuses.get(run.jobId);
    this.setStatus(run.jobId, {
      ...(status ?? { state: 'idle' }),
      state: finalState,
      endTime: Date.now(),
      errorCount: run.parseState.errorCount,
      warningCount: run.parseState.warningCount,
      pid: undefined,
      pidStartTime: undefined,
      detached: undefined,
      reattached: undefined
    });
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
    for (const run of this.reattachedRuns.values()) {
      run.tailer.stop();
      if (run.pollTimer) {
        clearInterval(run.pollTimer);
      }
    }
    // Unlike the job itself (see the comment below), a post-run command is
    // never meant to survive as a detached background process -- it's a
    // quick follow-up action, not a second tracked job.
    for (const child of this.postRunChildren) {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    this._onDidChangeStatus.dispose();
    // Running jobs are intentionally left detached and running — closing the
    // sidebar or window shouldn't kill an overnight regression. A job we were
    // re-tailing just goes back to "running (detached)" for whatever session
    // reattaches to it next (beginReattachment doesn't care how it got there).
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

/** The impure /proc read backing parseStartTimeTicks (see procStat.ts). Undefined on any read/parse failure. */
function readProcStartTime(pid: number): number | undefined {
  try {
    return parseStartTimeTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Like isPidAlive, but also confirms `pid` still refers to the same process
 * that was last recorded there, using its /proc start time — a bare
 * `/proc/<pid>` existence check can't tell a still-running job apart from an
 * unrelated process the OS later recycled that pid for. `expectedStartTime`
 * is undefined for a status persisted before this check existed; in that
 * case we fall back to existence-only rather than treating a legacy status
 * as always dead.
 */
function isPidAliveWithIdentity(pid: number, expectedStartTime?: number): boolean {
  if (expectedStartTime === undefined) {
    return isPidAlive(pid);
  }
  const currentStartTime = readProcStartTime(pid);
  return currentStartTime !== undefined && currentStartTime === expectedStartTime;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const REATTACHABLE_STATES: ReadonlySet<string> = new Set<JobRunState>(['passed', 'failed', 'killed']);

/** Narrows logIndex.ts's plain-string trailer state to JobRunState -- undefined for a missing/unrecognized trailer. */
function asJobRunState(state: string | undefined): JobRunState | undefined {
  return state !== undefined && REATTACHABLE_STATES.has(state) ? (state as JobRunState) : undefined;
}
