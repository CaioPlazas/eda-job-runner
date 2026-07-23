export interface JobDefinition {
  id: string;
  name: string;
  command: string;
  /** Path relative to the workspace root. "." means the workspace root itself. */
  cwd: string;
  /**
   * When true, this is the workspace's default job — the one run by the
   * "EDA: Run Default Job" command (and the F5 keybinding, when a default
   * exists). At most one job may be default; JobStore enforces that.
   */
  default?: boolean;
  /**
   * Whether to scan this job's output for errors/warnings and surface them in
   * the Problems panel (and let them influence pass/fail). Undefined means
   * enabled — the default. Set false as a safeguard for an unsupported tool
   * whose output the built-in patterns misread; the job then runs and logs
   * normally, with pure exit-code status and no diagnostics.
   */
  parseProblems?: boolean;
  /**
   * Optional case-insensitive regex, tested against each captured output
   * line, tool-agnostic (any tool's own printed "this actually failed" line
   * works, not just the four built-in UVM/Questa/Icarus/DSim/Verilator
   * patterns). If it matches anywhere in the run, the job is marked FAILED
   * even if the process exited 0. Works independently of `parseProblems`.
   * A `failPattern` match overrides everything except a user Stop.
   */
  failPattern?: string;
  /**
   * Optional case-insensitive regex marking this job's required "passed"
   * signal, tool-agnostic like `failPattern`. When set it fully governs
   * pass/fail: the job passes only if this matches at least once
   * (regardless of exit code -- for tools that always exit non-zero even on
   * success) and is marked FAILED if it never appears. A matching
   * `failPattern` still overrides to failed. Works independently of
   * `parseProblems`.
   */
  passPattern?: string;
  /**
   * Optional external file to tail in the live log viewer instead of the
   * captured pipe output. Set this to a scheduler's output file (e.g. an
   * LSF/SGE `bsub -o` / `qsub -o` path) when the job detaches to a farm host,
   * so the live viewer streams the real job output. Absolute, or relative to
   * the job's working directory; supports `${workspaceFolder}`.
   */
  logFile?: string;
  /**
   * Per-job override of `eda-job-runner.postSetupCwd` — the directory this
   * job's shell starts in, which `cwd` above then resolves against, instead
   * of the workspace-wide setting. Blank/undefined inherits the setting.
   * Supports `${workspaceFolder}` / `${env:NAME}`. Set via a job's Advanced
   * configuration.
   */
  postSetupCwd?: string;
  /**
   * Per-job override of `eda-job-runner.logsDirectory` — where this job's
   * own run logs are stored, instead of the workspace-wide setting.
   * Blank/undefined inherits the setting. Supports `${workspaceFolder}` /
   * `${env:NAME}`. Set via a job's Advanced configuration.
   */
  logsDirectory?: string;
  /**
   * Sequential repeat count for Run — e.g. 10 back-to-back runs of the same
   * test with a random seed, one after another (never in parallel). 1 or
   * undefined means a normal single run. Set via a job's Advanced
   * configuration.
   */
  runCount?: number;
  /**
   * Optional link to a tool registered in Tool Setup, used only to
   * re-show that tool's checkbox builder when reopening this job's
   * Configure form. Purely a UI convenience — `command` above remains the
   * single source of truth for what actually runs, unaffected by this
   * field (tool-agnostic core).
   */
  toolId?: string;
  /** Which of `toolId`'s variants (sub-tool) the builder should show. "" is the top-level variant. */
  toolVariantLabel?: string;
  /**
   * Per-job override of a `toolId` list's insert template, keyed by the
   * list's `name` (see `ToolList`). Lets one job insert a picked value as
   * `+UVM_TESTNAME=${value}` and another as `--test ${value}` from the same
   * shared tool list. Absent keys inherit the tool's own `insertTemplate`.
   * UI convenience only — `command` remains the single source of truth.
   */
  listInsertOverrides?: Record<string, string>;
  /**
   * Which sidebar folder this job is grouped under (must match an entry in
   * `JobsFile.folders`). Undefined, or a name no longer in that list, means
   * ungrouped -- shown flat at the top level, today's behavior. A job
   * belongs to at most one folder; folders are a single flat level, not a
   * nested tree.
   */
  folder?: string;
  /**
   * User-typed arguments not discovered from any tool scan -- an escape
   * hatch in the Configure form's builder for a flag/value pair the tool
   * doesn't advertise via --help. Appended to the built command after the
   * discovered options/lists, in order. `value` is optional (a bare flag).
   */
  customArgs?: { arg: string; value?: string }[];
  /**
   * Per-job values for `${var:NAME}` references in this job's command,
   * keyed by parameter name. Overrides the matching entry in
   * `JobsFile.params` (see `GlobalParam`); a name here with no global
   * counterpart is a job-local parameter. Resolved silently at run time --
   * no prompt, unlike `${param:NAME}`. Set via the Configure form's
   * "override parameter" checkboxes.
   */
  paramOverrides?: Record<string, string>;
  /**
   * Whether `postRunCommand` below is active. A separate explicit flag
   * (not "non-empty command means enabled") so the checkbox in the
   * Configure form can disable/re-enable the field without losing
   * whatever was typed into it, matching this form's parameter-override
   * checkbox-disables-a-field convention.
   */
  postRunEnabled?: boolean;
  /**
   * Run after this job finishes (passed or failed) -- skipped for a
   * user-stopped ("killed") run, since a Stop isn't "the job's done, run
   * the follow-up." Spawned fire-and-forget, once per completed lane, via
   * the same shell/setup chain and working directory as the job itself; a
   * nonzero exit or launch failure surfaces a warning notification rather
   * than affecting the job's own already-decided pass/fail. Only takes
   * effect when `postRunEnabled` is true.
   */
  postRunCommand?: string;
}

/**
 * A saved job skeleton offered when adding a new job, so a common shape
 * (a tool selection, a command pattern, a folder) doesn't need re-typing
 * every time. Captured from an existing job via "Save as Template"; applied
 * by pre-filling a brand-new Add-Job form exactly like reopening an existing
 * job does, minus the id, so Save always creates a fresh job.
 */
export interface JobTemplate {
  name: string;
  namePattern?: string;
  command?: string;
  cwd?: string;
  toolId?: string;
  toolVariantLabel?: string;
  parseProblems?: boolean;
  folder?: string;
}

/** A single discovered CLI flag for a tool, e.g. `-s SEED, --seed SEED`. */
export interface ToolOption {
  /** All flag spellings, e.g. ["-s", "--seed"]. */
  flags: string[];
  /** Placeholder text if the flag takes a value (e.g. "SEED"); undefined for a pure toggle. */
  metavar?: string;
  description?: string;
  /** Starred in Tool Setup so it surfaces first in a job's builder, ahead of a long flag list. */
  favorite?: boolean;
  /**
   * Names a `ToolList` on the same tool/variant that supplies this option's
   * selectable values. When set, a job's builder renders this option's value
   * editor as a dropdown of that list's values instead of free text -- the
   * picked value is inserted as the flag's own argument (flag, then value),
   * not via a `ToolList.insertTemplate`. Set from Tool Setup's per-option
   * "value source" control.
   */
  valueListName?: string;
}

/**
 * One scannable "mode" of a tool. `variants[0]` on a `ToolDefinition` is
 * always the implicit top-level variant (`label: ""`, `selectArgs: []`) —
 * plain `<command> <helpArg>`. Additional variants are dispatcher
 * sub-commands whose own flag set differs from the top level (e.g. a run
 * script's `compile` mode vs. its `regression` mode taking different
 * flags), scanned as `<command> ...selectArgs <helpArg>`.
 */
export interface ToolVariant {
  label: string;
  selectArgs: string[];
  options: ToolOption[];
  /** Captured help text, capped, kept for troubleshooting a misparse in the Tool Setup panel. */
  rawHelp?: string;
  /** Set only when the scan failed AND produced zero parseable options. */
  scanError?: string;
}

/**
 * A named, tool-agnostic "value list" — the source behind a test-list
 * dropdown in the job builder. Its members are discovered from exactly one
 * source (a file, or a command's stdout) and cached in `values`, refreshed
 * whenever the tool's flags are rescanned. `parseListLines`/`discoverList`
 * do the reading; `applyInsertTemplate` turns a picked value into a Command
 * fragment via `insertTemplate` so no tool's flag syntax is assumed.
 */
export interface ToolList {
  /** Label shown next to the dropdown in the builder, e.g. "Test". */
  name: string;
  /** Command whose stdout lines are the values. Exactly one of command/file is set. */
  command?: string;
  /** File whose lines are the values (absolute, or relative to the tool's cwd). */
  file?: string;
  /** Optional regex applied per line; capture group 1 (or the whole match) is the value. */
  pattern?: string;
  /** How a picked value is inserted into the Command; `${value}` is substituted. Defaults to `${value}`. */
  insertTemplate?: string;
  /** Discovered + cached values (like `ToolVariant.options`), refreshed on rescan. */
  values: string[];
  /** Set when the last discovery failed (spawn/read error, or no values found). */
  scanError?: string;
}

export interface ToolDefinition {
  id: string;
  /** Command as typed by the user, e.g. "run_simulation.py" or a full path. */
  command: string;
  /** Friendly label shown wherever this tool is listed. Falls back to `command` when unset/blank -- never affects what actually runs. */
  displayName?: string;
  /**
   * Optional per-tool override of the directory tool scans/rescans run from
   * (manual add, manual rescan, and the window-reload auto-rescan). Blank/unset
   * uses the workspace `eda-job-runner.postSetupCwd` setting. Supports
   * `${workspaceFolder}`/`${env:NAME}`. Scan-time only -- never affects a job's
   * own runtime cwd, which is resolved independently per job.
   */
  scanDir?: string;
  /** Flag used to introspect the tool. Defaults to "--help". */
  helpArg?: string;
  variants: ToolVariant[];
  /** Named value lists (e.g. a test list) surfaced as dropdowns in the job builder. */
  lists?: ToolList[];
  /** Epoch ms of the last scan attempt (successful or not). */
  lastScanned?: number;
  /**
   * Custom regex (capture group 1 = the seed value) for recovering a run's
   * seed from its captured log output, for the Log Viewer's Seed column --
   * overrides the built-in guessed patterns (see seedDetect.ts) for every
   * job bound to this tool. Only needed when a job's Command doesn't use
   * `${randomSeed}` (whose value is already captured directly) and the
   * built-in guesses don't match this tool's actual output. Set via Tool
   * Setup's Advanced section, with a live paste-and-preview tester.
   */
  seedPattern?: string;
}

export interface ToolsFile {
  version: 1;
  tools: ToolDefinition[];
}

export function emptyToolsFile(): ToolsFile {
  return { version: 1, tools: [] };
}

/**
 * A workspace-wide named value, referenced from a job's command as
 * `${var:NAME}` and substituted silently at run time (no prompt) -- unlike
 * `${param:NAME}`, which always prompts. Its default here is used unless a
 * job sets its own value via `JobDefinition.paramOverrides`. Managed from
 * the Parameters panel.
 */
export interface GlobalParam {
  name: string;
  value: string;
}

export interface JobsFileSetup {
  /** Path (relative to workspace root) to a script that is sourced before every job. */
  script?: string;
  /** Literal shell commands run (in order) before every job, after `setup.script`. */
  commands?: string[];
}

export interface JobsFile {
  version: 1;
  setup?: JobsFileSetup;
  /** Ordered list of sidebar folder names. A job groups under one by name via `JobDefinition.folder`. */
  folders?: string[];
  /** Saved job skeletons offered when adding a new job. See `JobTemplate`. */
  templates?: JobTemplate[];
  /** Workspace-wide named values referenced as `${var:NAME}`. See `GlobalParam`. */
  params?: GlobalParam[];
  jobs: JobDefinition[];
}

export function emptyJobsFile(): JobsFile {
  return { version: 1, jobs: [] };
}
