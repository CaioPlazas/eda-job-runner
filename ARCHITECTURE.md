# EDA Job Runner — Architecture & Codebase Guide

This document is a from-scratch, exhaustive map of this codebase: what every
file does, how the pieces fit together, and the conventions that hold it
together. It exists so an AI assistant (of any capability level) picking up
this project cold — without the history of how it was built — can orient
itself immediately and make changes that fit the existing design instead of
fighting it or duplicating something that already exists.

**Read this file fully before making changes.** Then check `PLAN.md` (phased
backlog / design decisions) and `STATUS.md` (what shipped most recently, what
was in flight) for anything that changed since this document was last
updated. If something here contradicts the actual code, trust the code —
this is a snapshot, not a live index — but treat the discrepancy as worth
fixing in this file too, since keeping it accurate is the whole point of it
existing.

## 1. What this project is

**EDA Job Runner** is a VS Code extension: a tool-agnostic sidebar for
running and tracking EDA (Electronic Design Automation — chip/RTL/ASIC/FPGA)
compile and simulation jobs (Xcelium, Questa, DSim, Verilator, Icarus, or any
custom script) without leaving the editor. It has **zero built-in knowledge**
of any specific EDA tool's syntax — a "job" is just `{name, command, cwd}`
run through a configurable shell, with everything else (tool flags, seeds,
pass/fail detection, value lists) built as generic, tool-agnostic primitives
on top. This "tool-agnostic core" principle is a locked design decision (see
`PLAN.md`'s "Locked decisions" section) — never special-case a specific
tool's name or CLI syntax anywhere in `src/`; all tool-specific behavior
(if any is ever needed) belongs in user-supplied regex patterns / a
`ToolDefinition`, not in this extension's own code.

Distribution: published on the VS Code Marketplace as `CaioPlazas.eda-job-runner`
(pre-release channel only), built and released from **two git repos** — see
section 9.

Target environment: **Remote-SSH is the primary use case** (the extension
runs host-side via `extensionKind: ["workspace"]`), alongside plain local
Linux. **CentOS 7 / old-server compatibility is a hard requirement**: no
native modules, no `node-pty`, a single bundled JS file via esbuild, and
`engines.vscode: "^1.74.0"`.

## 2. High-level architecture

Three layers, cleanly separated:

1. **Pure logic modules** — no `vscode` import, no `fs`/`child_process`
   dependency at all (or only Node's own `path`, which is fine). Each has a
   matching standalone Node test harness in `test-fixtures/run-*-tests.mjs`
   (see section 8). This is the single most important convention in this
   codebase: **whenever a piece of decision logic can be extracted from an
   impure orchestrator into a pure, synchronously-callable function, it
   should be**, specifically so it can carry real, fast, CI-verified test
   coverage. Examples: `logRetention.ts`, `jobOutcome.ts`, `killPlan.ts`,
   `seedDetect.ts`, `paramSubstitution.ts`.
2. **Impure orchestrators** — own real VS Code API surface (`vscode.window`,
   `vscode.workspace`, `vscode.commands`), spawn child processes, do file
   I/O. These import and call the pure modules for any actual decision-
   making, keeping their own bodies as thin glue as possible. Examples:
   `jobRunner.ts`, `jobStore.ts`, `toolStore.ts`, `logManager.ts`,
   `toolIntrospect.ts`.
3. **Webview panels** — five VS Code `WebviewPanel`s, each a single `.ts`
   file containing *both* the host-side controller class *and* a
   `renderHtml()` function that returns one big self-contained HTML string
   (inline `<style>`, inline `<script>`) sent to the webview. See section 6
   for the shared conventions across all five.

Everything is driven from one entry point, `src/extension.ts`'s `activate()`,
which wires up all the long-lived singleton objects and registers every
command. There is no dependency-injection framework — everything is manual
constructor injection, explicit and traceable by reading `activate()` top to
bottom.

## 3. Repository layout

```
vscode-verilog-manager/          <- PRIVATE dev repo (this one)
├── src/                         <- All TypeScript source (see section 5)
├── test-fixtures/                <- Standalone Node test harnesses + captured real tool output (section 8)
├── scripts/                      <- Dev tooling, NOT shipped in the VSIX (section 8.3, 10)
│   ├── generate-icon.js            pure-Node/zlib PNG encoder for media/icon.png (no image-tool dependency)
│   ├── vscode-webview-shim.mjs      no-op `vscode` module stand-in for the visual-test harness
│   ├── render-webviews.mjs          renders each panel's real renderHtml() to static HTML with sample data
│   └── screenshot-webviews.mjs      loads that HTML in headless Chromium (playwright-core), screenshots it
├── examples/                     <- A live example workspace (.vscode/eda-jobs.json + eda-tools.json + mock scripts) used for manual testing
├── sample-projects/              <- Two more complete example EDA projects (uvm_alu, uart_soc) with real testbenches
├── docs/                         <- eda-tools-setup.md (user-facing tool-registration walkthrough)
├── media/                        <- icon.png / icon.svg (extension + Marketplace icon)
├── .github/workflows/            <- ci.yml (every push/PR) + release.yml (tag-triggered, builds+attaches VSIX)
├── .vscodeignore                 <- What's excluded from the packaged VSIX (dev-only dirs; keep in sync when adding new dev tooling!)
├── .gitignore
├── package.json                  <- Extension manifest: commands/menus/views/settings (section 7) + npm scripts/devDeps
├── tsconfig.json                 <- strict TS, ES2020 target, rootDir src/, outDir out/ (esbuild bundles to dist/ instead, see below)
├── PLAN.md                       <- Authoritative phased plan/backlog + "Locked decisions" — READ for design rationale
├── STATUS.md                     <- Last-session handoff notes: exact tag, what shipped, what's unresolved
├── CHANGELOG.md                  <- User-facing per-version changelog
└── ARCHITECTURE.md               <- (this file)
```

A **second, public repo**, `github.com/CaioPlazas/eda-job-runner` (local
clone at `~/eda-job-runner-public`, sibling directory to this one, NOT inside
this repo), is a manually-synced release-only mirror that `vsce publish`
actually runs from. See section 9 — do not confuse the two when asked to
"release" or "publish."

## 4. The data model

Everything the extension manages is either (a) one of two hand-editable JSON
files stored in the *user's own workspace* under `.vscode/`, or (b) transient
runtime state kept in VS Code's `Memento` (`context.workspaceState`) or purely
in memory. There is **no database, no SQLite, no custom binary format**.

### 4.1 `types.ts` — the shared type definitions

This file has zero logic — pure interfaces/type aliases, imported everywhere.
Read it first when touching anything data-model-related.

- **`JobDefinition`** — one job. Required: `id` (a `crypto.randomUUID()`),
  `name`, `command` (a shell string, may contain `${param:NAME}` /
  `${randomSeed}` / `${var:NAME}` placeholders — see 4.3), `cwd` (relative to
  workspace root, `"."` = root itself). Everything else is optional and
  additive: `default` (at most one job may have this), `parseProblems`
  (`undefined`/absent = enabled, `false` = disabled — the "only store when
  non-default" convention used throughout this file), `failPattern`/
  `passPattern` (regex strings), `logFile` (external file to live-tail
  instead of captured output), `postSetupCwd`/`logsDirectory` (per-job
  overrides of the matching workspace settings), `runCount` (sequential
  repeat count, 1000 max), `toolId`/`toolVariantLabel`/`listInsertOverrides`
  (UI convenience — always derived FROM `command`, never the other way; see
  4.4), `folder` (sidebar grouping, must match an entry in
  `JobsFile.folders`), `customArgs` (hand-typed flag/value pairs not from any
  tool scan), `paramOverrides` (per-job `${var:NAME}` value overrides),
  `postRunEnabled`/`postRunCommand` (fire-and-forget follow-up command).
- **`JobTemplate`** — a saved skeleton (subset of `JobDefinition` fields, no
  `id`) offered when adding a new job. See 5.3 (`JobStore`).
- **`ToolOption`** — one discovered CLI flag: `flags: string[]` (all spellings,
  e.g. `["-s","--seed"]`), `metavar?` (placeholder if it takes a value, may be
  an argparse `{a,b,c}` choices-brace string — see `toolOptionParser.ts`'s
  `parseChoices`), `description?`, `favorite?` (starred in Tool Setup, surfaces
  first in the job builder), `valueListName?` (names a `ToolList` on the same
  tool/variant supplying this option's values as a dropdown instead of free
  text).
- **`ToolVariant`** — one scannable "mode" of a tool. `variants[0]` is always
  the implicit top-level variant (`label: "", selectArgs: []`); additional
  variants are dispatcher sub-commands (argparse subparsers) with their own
  independently-scanned flag set, invoked as `<command> ...selectArgs <helpArg>`.
- **`ToolList`** — a named, tool-agnostic "value list" (the primitive behind a
  test-list dropdown): `name`, exactly one of `command`/`file` as its source,
  optional `pattern` (regex to extract the value per line), `insertTemplate`
  (`${value}` substitution, defaults to bare `${value}`), and cached
  `values: string[]` refreshed on every rescan.
- **`ToolDefinition`** — one registered tool: `id`, `command`, `displayName?`,
  `scanDir?` (per-tool override of where scans run from), `helpArg?` (defaults
  to `--help`), `variants: ToolVariant[]`, `lists?: ToolList[]`,
  `lastScanned?`, `seedPattern?` (custom regex overriding the built-in
  guessed seed patterns — see `seedDetect.ts`).
- **`GlobalParam`** — `{name, value}`, a workspace-wide named value referenced
  as `${var:NAME}` (see 4.3), managed from the Parameters panel.
- **`JobsFile`** — the whole `.vscode/eda-jobs.json` shape: `version: 1`,
  `setup?` (script + pre-commands sourced before every job), `folders?:
  string[]` (ordered sidebar folder names), `templates?: JobTemplate[]`,
  `params?: GlobalParam[]`, `jobs: JobDefinition[]`.
- **`ToolsFile`** — the whole `.vscode/eda-tools.json` shape: `version: 1`,
  `tools: ToolDefinition[]`.

### 4.2 The two persisted JSON files

Both live under the user's workspace `.vscode/` directory, are
**hand-editable and meant to be shareable/committed** (they describe the
project's own job/tool setup, not user-specific state), and are each owned by
one `Disposable` store class that loads, watches (via
`vscode.workspace.createFileSystemWatcher`), normalizes, and persists them:

- `.vscode/eda-jobs.json` ↔ `JobsFile` ↔ owned by **`JobStore`** (`jobStore.ts`).
- `.vscode/eda-tools.json` ↔ `ToolsFile` ↔ owned by **`ToolStore`** (`toolStore.ts`).

Both follow the identical pattern (see 5.3): `load()` reads+JSON.parses+calls
a private `normalize()` that tolerates a hand-edited or malformed file (drops
unrecognized fields, fills defaults, never throws out of `load()` itself —
shows an error message and keeps the previous in-memory state instead), fires
a `_onDidChange*` event; every mutator method (`addJob`, `updateJob`, etc.)
mutates `this.data` in memory then calls a private `persist()` that
`JSON.stringify(this.data, null, 2) + '\n'`s the whole file back to disk and
re-fires the change event. There is no diffing/patching — every save
rewrites the entire file.

### 4.3 Command placeholder syntax (three independent kinds, deliberately disjoint)

A job's `command` string can use any combination of:

| Token | Resolved | When | Module |
|---|---|---|---|
| `${param:NAME}` or `${param:NAME=default}` | Prompted via `showInputBox`, once per Run (not per repeat-count iteration) | Every `run()` call, before any spawn | `paramSubstitution.ts` |
| `${randomSeed}` | A fresh random unsigned 31-bit integer | Fresh for **every** actual spawn, including every iteration of a repeat-count batch | `paramSubstitution.ts` |
| `${var:NAME}` | Silently, from `JobDefinition.paramOverrides[NAME]` else `GlobalParam` default else `""` — **never prompts** | Once per Run (same as `${param:...}`) | `paramVars.ts` |

`${param:...}` values are remembered per job+name (`JobRunner`'s
`paramValues` map, persisted to the memento) so the next prompt defaults to
last time's answer. **"Re-run Last"** (`eda-job-runner.reRunLast` command)
replays a prior run's `resolvedCommand` (the command with ALL placeholders
already substituted) completely verbatim — no new prompt, no fresh seed,
regardless of `runCount` — by passing `options.forcedCommand` into
`JobRunner.run()`, which short-circuits straight to a single `runLane()` call
before any placeholder resolution happens again.

Resolution order in `JobRunner.run()`: `${param:...}` prompted and
substituted first → `${var:...}` substituted next (via
`substituteParamVars`) → the resulting `template` is what a repeat-count
batch loops over → `${randomSeed}` is resolved fresh inside `runLane()` for
each actual spawn.

### 4.4 The "tool builder" is UI convenience only, never authoritative

`JobDefinition.toolId`/`toolVariantLabel`/`listInsertOverrides` and
`ToolOption.valueListName`/`favorite` exist **only** to let the Configure
webview reconstruct which checkboxes/dropdowns should be pre-filled when
reopening a job. **`JobDefinition.command` is always the single source of
truth for what actually runs** — `jobRunner.ts` never looks at `toolId` at
all. Client-side, `jobConfigPanel.ts`'s builder writes INTO the `command`
textarea live while its `<details id="toolBuilder">` is expanded; collapsing
it (or a hand-edit while collapsed) leaves `command` as the sole source of
truth again. See section 6.2 for the exact mechanics.

### 4.5 Runtime-only state (never persisted to the JSON files)

`JobRunner` (section 5.4) keeps several in-memory-only maps for currently-
running or recently-run jobs: `activeRuns`, `reattachedRuns`, `laneGroups`,
`activeBatchJobs`, `promptingJobs`, `postRunChildren`. Only `statuses` (one
`JobRunStatus` per job id — the *primary* lane's status) and `paramValues`
are persisted, into `context.workspaceState` (a VS Code `Memento`, i.e.
opaque per-workspace key/value storage — NOT a file the user can see or
edit), under keys `eda-job-runner.jobStatuses` / `eda-job-runner.jobParamValues`.
`LogManager` also persists one thing to workspace state:
`eda-job-runner.knownLogRoots` (every logs root ever actually written to —
see 5.6). A repeat-count batch's per-iteration lane statuses
(`laneGroups`) and any concurrent "extra" lane do NOT survive a window
reload — only the primary lane's status does (via the reattachment
mechanism in 5.4.3).

## 5. Module-by-module reference (`src/`)

### 5.1 `extension.ts` — the entry point

`activate(context)`: bails immediately if no workspace folder is open (the
`viewsWelcome` content in `package.json` explains this to the user).
Otherwise, in order: constructs `JobStore`, `ToolStore`, `LogManager` (passed
`context.workspaceState` for its known-roots persistence), `LogDiagnostics`,
`JobRunner` (passed `logManager`, closures reading `jobStore.getSetup()` /
`getParams()`, `context.workspaceState`, `logDiagnostics`), `JobTreeProvider`
+ the actual `vscode.window.createTreeView` (with
`EdaTreeDragAndDropController`), `StatusBarController`, `LogFollowController`
— every one of these is `context.subscriptions.push`ed for disposal.

Then: a small `updateContextKeys()` closure sets two `setContext` keys
(`edaJobRunner.anyJobRunning`, `edaJobRunner.hasDefaultJob`) that drive
`package.json`'s `when` clauses (inline Run-button visibility, the F5
keybinding's guard) — re-run on every job-list change, every status change,
and every `experimentalMultipleRuns` config change.

Then every command from `package.json`'s `contributes.commands` is
`registerCommand`'d here (see section 7 for the full command list and what
each one calls). Most are thin one-liners delegating straight into
`jobStore`/`jobRunner`/a panel's `createOrShow`; a handful of small
free-standing helper functions live at the bottom of this file for the ones
with actual logic: `deleteJob` (confirm dialog), `addJob`, `saveJobAsTemplate`
(overwrite-confirmation, same shape as the Configure panel's own in-panel
"Save as template" flow — see `jobConfigPanel.ts`'s
`onSaveTemplateRequest`), `addFolder`/`renameFolder`/`deleteFolder`,
`runFolder`/`stopFolder` (sequential loop over `jobStore.getJobsInFolder`),
`moveJobToFolder` (a `showQuickPick` of existing folders + "+ New folder…"),
`openLiveLog`, `openLogForJob`, `openLogHistory` (a `showQuickPick` of past
runs, sized via `formatFileSize`), `notifyOnCompletion` (the passed/failed/
killed toast shown on every `jobRunner.onDidChangeStatus` fire with a
concrete `jobId` — killed never toasts, since it's always user-initiated).

Finally: `jobStore.load()` then `jobRunner.beginReattachment(...)` (resume
tailing any "running (detached)" job left over from before this window
reload — see 5.4.3); `toolStore.load()` then `rescanAllTools` (re-scans
every registered tool's `--help` sequentially at every activation, in case
flags changed since last scan).

`deactivate()` does nothing — running jobs are deliberately left as detached
background processes (see `JobRunner.dispose()` in 5.4).

### 5.2 `types.ts` — see section 4.1.

### 5.3 `jobStore.ts` and `toolStore.ts` — persisted-JSON stores

Both are `vscode.Disposable` classes owning one `.vscode/*.json` file. See
4.2 for the shared load/watch/normalize/persist pattern. Distinct
responsibilities beyond plain CRUD:

**`JobStore`** additionally owns: folder management (`addFolder`/
`renameFolder`/`deleteFolder` — deleting can either cascade-delete every job
inside or just ungroup them, caller's choice via a boolean), drag-and-drop
reordering (`reorderJob`/`reorderFolder`, delegating the actual array-splice
logic to the pure `jobOrder.ts`/`folderOrder.ts` — see 5.11), template
CRUD (`addTemplate` replaces same-named in place, `deleteTemplate`), global
params (`setParams`, replaces the whole list at once — the Parameters panel
edits/saves everything together), workspace `setup` (sourced script +
pre-commands). `updateJob`/`addJob`/`duplicateJob` enumerate every
`JobDefinition` field explicitly (no generic spread) — **when adding a new
field to `JobDefinition`, you must also add it here** (both `updateJob`'s
assignment list and `duplicateJob`'s copied-fields object) or it will
silently never save/duplicate. Same requirement applies to `normalize()`'s
per-field validation block if the new field needs sanitizing on load.

**`ToolStore`** is simpler: `updateTool` does a raw `Object.assign` partial
merge (used by a rescan to touch only `variants`/`lastScanned` while leaving
`command`/`helpArg` untouched). `normalize()`'s `normalizeVariants` always
guarantees `variants[0]` exists with `label: ""` (the implicit top-level
variant), inserting one if the loaded file lacks it.

### 5.4 `jobRunner.ts` — the job execution engine (the biggest, most complex file)

Owns everything about actually running a job: spawning, streaming output
into the parser, tracking status, killing, and resuming after a window
reload. `JobRunner implements vscode.Disposable`, one instance for the whole
extension.

#### 5.4.1 Core data structures

- **`JobRunStatus`** (exported, used everywhere status is displayed) — the
  persisted-shape status: `state` (`'idle'|'running'|'passed'|'failed'|
  'killed'`, from `jobOutcome.ts`'s `JobRunState`), `startTime`/`endTime`,
  `exitCode`/`signal`, `logPath`, `pid`/`pidStartTime` (for reload-survival
  identity verification — see 5.4.3), `errorCount`/`warningCount`,
  `detached`/`reattached` (reload-survival flags, see 5.4.3), `laneLabel`
  (e.g. `"3/10"` for a repeat-count iteration), `resolvedCommand` (fully
  substituted — what "Re-run Last" replays).
- **`ActiveRun`** (internal) — everything about one currently-spawned lane:
  the live `ChildProcess`, the open log `FileHandle`, a `FileTailer` reading
  that same log file back (see 5.9 — NOT a pipe; see 5.4.2), parse-byte
  accounting (`parseBytesFed`/`parseTruncated`/`maxParseBytes`), kill state
  (`killRequested`/`killTimer`), the resolved `cwdAbs`, a `ParseState`
  (structured issue parser state, `logParser.ts`), `lineCarry` (partial
  trailing line across chunk boundaries), compiled `failRegex`/`passRegex`
  + their `matchedFail`/`matchedPass` sticky flags, `laneKey` (`job.id` for
  the primary lane, `job.id::runN` for batch iteration N), `mirrorPrimary`
  (whether this lane's status also writes to the persisted primary slot),
  captured `postRunEnabled`/`postRunCommand`.
- **`ReattachRun`** (internal) — the equivalent for a job resumed after a
  window reload: no live `ChildProcess`/exit event exists, so completion is
  inferred by polling `/proc/<pid>` liveness instead (see 5.4.3).

Maps on the `JobRunner` instance: `statuses` (persisted), `activeRuns`,
`reattachedRuns`, `postRunChildren` (a `Set<ChildProcess>`, killed on
`dispose()`), `laneGroups` (per-job `Map<laneKey, JobRunStatus>` for a
job that's had more than one tracked run — not persisted), lane-completion
promise plumbing (`laneCompletionResolvers`/`laneCompletionPromises`,
`beginLaneCompletion`/`resolveLaneCompletion`/`waitForLane` — how `run()`
awaits a specific lane finishing), `activeBatchJobs`, `promptingJobs`,
`paramValues` (persisted).

#### 5.4.2 The spawn pipeline (`run()` → `runLane()`)

`run(job, options?)`: guards (job already running / prompting / batching →
info message and return; **job still running detached from before a window
reload** — `reattachedRuns.has(id)`, or a persisted `running` + `detached`
status — → info message and return; multiple-jobs-off and something else already
running → warning and return) → if `options.forcedCommand` set (Re-run
Last), skip straight to a single `runLane()` → else parse+prompt for
`${param:...}` → substitute `${var:...}` → if `runCount > 1`, delegate to
`runBatch()` (sequential loop, `laneKey = job.id::run<i>`, breaks early if an
iteration comes back `'killed'`) → else a single `runLane(job, job.id, ...)`.

`runLane()` (the actual spawn): resolves `${randomSeed}` fresh
(`substituteRandomSeed`), reads every relevant `eda-job-runner.*` config
value fresh (never cached — a `settings.json` edit takes effect on the very
next run with no reload needed, a convention followed throughout this
codebase), resolves `cwdAbs` via `resolveCwdAbs()` (job's own
`postSetupCwd` override wins over the workspace setting; `cwd` then
resolves against that), builds the full shell command via
`buildShellCommand()` (sources the setup script, runs setup commands, then
the resolved command — joined with `&&`, deliberately NOT `exec`'d so a
multi-step command like `make clean && make compile` doesn't get truncated
after its first step), creates the log file via
`logManager.createLogFile()` (writes a structured header FIRST — job name,
lane label, seed, cwd, started — before the free-text command line, so it
survives the head/tail read cap even for a very long resolved command),
then `cp.spawn`s with **`detached: true` and `stdio: ['ignore', logHandle.fd,
logHandle.fd]`** — this is the single most important architectural detail in
this file: **the child's stdout/stderr are redirected straight to the log
file's own OS-level file descriptor, not piped through this Node process**.
This means capture survives an extension-host restart (the write goes
child→disk directly, no dependency on this process staying alive to relay
it) and requires a **`FileTailer`** (tailing the same file this process just
wrote the header to) as the *only* path by which captured output ever
reaches the structured parser / pattern matchers (`feedChunk`) — this is
deliberately the same mechanism a reattached (post-reload) job uses to
resume (`feedReattachChunk`), so live and reattached runs share one code
path instead of one being a bespoke special case of the other.

The detached-run guard above is not redundant with the tree hiding Run on a
running job: **Run Folder, the default-job keybinding (F5) and Log History's
"Re-run This Command" all call `run()` directly**, bypassing the tree's
context-value gate. Without it, a job resumed after a reload could be started a
second time, and the new lane's `setStatus` would overwrite the recorded `pid`
— leaving the original process unreachable by Stop (and its tool licence
checked out) until it exited on its own. Any *new* entry point that starts a
job must go through `run()` for this reason.

Everything between `createLogFile()` and the `ActiveRun` being constructed is
wrapped in `try/catch` that closes the log handle and rethrows: until that
object exists nothing owns the `FileHandle`, and `finish()` is what would
normally close it, so a failure in between (ENOSPC, a stale NFS handle, a
synchronous spawn failure) leaked one descriptor per attempt.

`child.on('exit', ...)` / `child.on('error', ...)` both call `finish()`.

#### 5.4.3 Reload survival ("detached" / "reattached")

Because the child is `detached: true` and its own process group, and its
stdio is a bare file descriptor (no pipe VS Code's extension host is
listening on), the job **keeps running even if the extension host restarts**
(window reload, VS Code crash/exit). On the next activation:

1. `JobRunner`'s constructor scans persisted `statuses` for any `'running'`
   entry, and for each one checks `isPidAliveWithIdentity(pid, pidStartTime)`
   — NOT a bare `/proc/<pid>` existence check, but a comparison against
   `/proc/<pid>/stat`'s field 22 (`starttime`, parsed by the pure
   `procStat.ts`) captured at spawn time, since a long-lived host can recycle
   a pid for an unrelated process well before this check runs. Alive →
   marked `detached: true` (no live capture yet); dead → reset to `'idle'`.
2. `extension.ts` calls `beginReattachment(getJob)` once `JobStore` has
   finished loading — for every still-alive `detached` job with a known
   `logPath`, `startReattachment()` builds a `ReattachRun`, starts its own
   `FileTailer` from byte 0 (there's no persisted `ParseState` to resume
   from — counts are rebuilt from scratch, cumulative over the whole
   captured file so far; that catch-up read is sliced by
   `REATTACH_READ_CHUNK`, see 5.9) feeding `feedReattachChunk`, and starts a
   1s `pollReattachment` interval. A job whose **definition no longer exists**
   (deleted, or hand-edited out of the JSON, while it was running) is
   reattached too — with parsing off and the tailer started at EOF, since
   there's no job left to read `parseProblems`/patterns from. Skipping it
   outright (the original behaviour) left a `running` status nothing could
   ever resolve: invisible in the tree, yet enough to keep `hasAnyRunning()`
   true and the 1s ticker firing for the rest of the session.
3. `pollReattachment()` fires once the identity-verified pid disappears:
   forces one final tailer poll (the process's own writes are already
   durable on disk by the time its pid vanishes, but the tailer only notices
   on its next poll), flushes the trailing partial line, then calls the pure
   `decideReattachState()` (`reattach.ts`) — a conservative variant of
   `decideFinalState()` that starts from baseState `'failed'` rather than
   `'passed'` (an unproven, never-actually-observed-exiting run can't be
   credited as a pass by default; a genuine matched `passPattern` can still
   flip it). Writes its own completion trailer line into the log (same
   format `finish()` uses, tagged `[reattached: ...]`) if none already
   exists, then finalizes the persisted status.

Note `stop()`'s own detached branch (no live `ActiveRun` for `laneKey ===
jobId`): it can still signal the process group by its verified pid — it
just has to *poll* for death instead of getting a real Node `'exit'` event
(`runDetachedKillSchedule`). **`stopAllRuns(jobId)` must fall through to
`stop(jobId)` when no live lane matches** — it builds its lane list from
`activeRuns`, which a detached run is never in, so without that fallback
"Stop Folder" (which counts running jobs by *status*, so it does see them)
put up a "Stop all N running jobs?" modal and then signalled nothing at all.

#### 5.4.4 Kill / stop (`stop()`, `killPlan.ts`)

`stop(jobId, laneKey = jobId)`: live lane → `killRequested = true` then
`advanceKillSchedule()` walks the configured `killSignals` escalation
(`computeKillSchedule` in the pure `killPlan.ts`: an ordered list of
`{signal, graceSeconds}`, unrecognized entries dropped, missing
`graceSeconds` falls back to `killGracePeriodSeconds`, an empty/fully-invalid
list falls back to the historical SIGTERM→SIGKILL default, and `SIGKILL` is
always force-appended as the final stage no matter what — a misconfigured
sequence must never leave a job unkillable). Each stage sends
`process.kill(-pid, signal)` — **negative pid**, since the child was
spawned `detached: true` making its pid its own process-group id, so the
signal reaches the whole `make`/shell/simulator tree at once (this is what
actually frees an EDA tool's license checkout on Stop, not just kills the
top process). `advanceKillSchedule` re-checks `activeRuns.has(laneKey)`
before every stage as a belt-and-suspenders guard against a stray signal
firing after the run already finished on its own.

No live `ActiveRun` (a "running (detached)" job) → the polling variant,
`runDetachedKillSchedule`.

#### 5.4.5 Finishing a run (`finish()`) — read this before touching lifecycle code

`finish()` is a thin wrapper (re-entrancy guard, then
`try { finalizeRun(...) } catch { record a terminal status } finally { free
the lane }`) around **`finalizeRun()`**, which holds the actual sequence. The
split exists so the last two steps below can never be skipped: they used to be
plain statements at the end of one long method, so any throw in between left
the lane in `activeRuns` with an unresolved completion promise — the job
reported "already running" for the rest of the session, its spinner never
cleared, the 1s ticker never stopped, and a `runFolder` loop awaiting that lane
hung forever with no way to cancel. Both call sites are `void`ed event
handlers, so the rejection wasn't even visible.

`finalizeRun(run, state, exitCode, signal)` is `async` and does, **in this exact
order** (the ordering is load-bearing, see the in-code comments and Part 2
bug #7 in `PLAN.md`'s Phase 12 for why):

1. Re-entrancy guard (`run.finished`) — Node can fire both `'error'` and
   `'exit'` for the same child in some failure modes; only the first call
   proceeds. This check (and clearing `killTimer`) happens before the first
   `await`, so it's synchronous/race-free.
2. One final synchronous `tailer.pollOnce()` + `tailer.stop()` — guarantees
   the final counts reflect the whole run even though the child already
   exited (its writes are already durable on disk; the tailer just hasn't
   polled since the last 500ms tick).
3. Flush the trailing partial line (`lineCarry`) to both the structured
   parser and the fail/pass pattern scan.
4. Compute `errorCount`/`warningCount`, push `LogDiagnostics.setJobIssues`
   (Problems panel) if `parseProblems` was on.
5. `decideFinalState()` (pure, `jobOutcome.ts`) — see 5.10 for the exact
   precedence rules.
6. Write the completion trailer line to the log file, close the log handle.
7. `runPostRunCommand()` — fire-and-forget, skipped for a `'killed'` state.
8. `setLaneStatus()` — routes the final status to the persisted primary slot
   (if `mirrorPrimary`) and/or the `laneGroups` entry.
9. **Only now**, back in `finish()`'s `finally` —
   `this.activeRuns.delete(run.laneKey)`, then `resolveLaneCompletion()`.

**Why step 9 is last, not right after the exit event fires**: `run()`'s own
double-start guard is `this.activeRuns.has(job.id)`. If the entry were
deleted earlier (e.g. right at the top of `finish()`, before its several
`await`s), a fresh `run()` call could slip through that guard during
`finish()`'s remaining cleanup, get its own new `ActiveRun`, and then have
THIS (older) `finish()` call's `setLaneStatus`/`resolveLaneCompletion`
(running with stale, closed-over `run`/`laneKey` values) overwrite the new
run's live "running" status with the old run's terminal one, and
incorrectly resolve the new run's completion promise. Keeping the guard
"hot" for the entire duration of `finish()`'s cleanup closes this race
entirely. (Fixed in the Phase 12 review — see `PLAN.md`.)

`pollReattachment()` (the no-live-child equivalent, 5.4.3) has the identical
shape and for the identical reason: it sets `finalizing` and clears its own
poll timer up front, so its body lives in `finalizeReattachedRun()` inside a
`try/catch/finally` that always stops the tailer and drops the
`reattachedRuns` entry. Without it, one rejection stranded the job at
"running (resumed)" with nothing left to re-check it.

#### 5.4.6 Output → parser wiring (`feedChunk`/`feedLines`, and the reattach equivalents)

**The parse budget is charged before the chunk is touched, not after.**
`run.parseBytesFed += Buffer.byteLength(chunk)` and the `> maxParseBytes`
check are the first things `feedChunk`/`feedReattachChunk` do; only a chunk
that fits the budget gets ANSI-stripped and split. Charging afterwards (the
original order) meant the budget *described* work already done instead of
bounding it — harmless for a 500ms live delta, but on the reattach path, where
one catch-up read can be an entire multi-hundred-MB log, it was the difference
between a bounded parse and stripping + line-splitting the whole thing.
(Side effect worth knowing: the budget now counts raw bytes rather than
ANSI-stripped ones, so a heavily colorized log reaches the cap marginally
sooner.)

Every chunk that clears the budget is ANSI-stripped (`ANSI_PATTERN`) before
anything else touches it. Two independent consumers, both gated
independently: the structured issue parser (`logParser.ts`'s `parseLine`,
only if `parseProblems`) and the fail/pass regex scan
(`scanLinePatterns`, only if either pattern is set) — both share the same
line-buffering (`lineCarry` split logic) so a match can't be missed or
double-counted at a chunk boundary, but are otherwise fully independent (a
pattern-only job with `parseProblems` off still gets fail/pass detection).
`run.parseBytesFed` tracks ANSI-stripped bytes fed so far; once it exceeds
`logMaxSizeMB` (config, despite the name — see 5.6/7's note on this
setting), `parseTruncated` latches true forever for this run **and the
tailer itself is stopped** (`run.tailer.stop()`) — the log file keeps
growing and recording everything regardless (the child writes it directly),
only in-memory parsing/counting stops, so there's no reason to keep polling
and reading deltas that would just hit the `if (run.parseTruncated) return`
guard for the rest of a potentially very long run.

#### 5.4.7 Post-run command (`runPostRunCommand`)

A completely separate, lightweight fire-and-forget spawn (same
`buildShellCommand`/`buildShellInvocation` plumbing as the job itself, same
`cwdAbs`) — never folded into the main run's capture/status. Tracked in
`postRunChildren` (a `Set`), given a 60s timeout (`POST_RUN_TIMEOUT_MS`,
SIGKILL on expiry — mirrors `shellEnvPanel.ts`'s own Test-button timeout
pattern), and **killed on `dispose()`** — unlike the job itself (which is
deliberately left running detached across a window close/reload), a
post-run command is never meant to survive as a background process; it's a
notification/cleanup action, not a second tracked job.

#### 5.4.8 `dispose()`

Clears the 1s tick timer, stops every reattached **and live** run's tailer
(plus any pending `killTimer`) and closes each live run's log `FileHandle`,
**SIGKILLs every still-tracked `postRunChildren`** (see 5.4.7), disposes the
status-change emitter. Deliberately does **NOT** touch any live `ActiveRun`'s
child **process** — running jobs are intentionally left detached and running;
closing the sidebar/window must never kill an overnight regression run. The
distinction to keep straight: the *child* is the user's and survives; the
*tailer and descriptor* are ours and must not. On a plain host exit the OS
would reclaim them anyway, but on a disable/reinstall or workspace-folder
change the host survives and every leftover tailer keeps polling forever.

### 5.5 `treeProvider.ts` — the sidebar tree

`JobTreeItem` (one run row), `JobGroupTreeItem` (a job's parent row once it
has more than one tracked run — expandable, `TreeItemCollapsibleState.Expanded`),
`FolderTreeItem` (a single flat grouping level — folders are explicitly NOT
nested, a locked decision). `JobTreeProvider implements
vscode.TreeDataProvider<EdaTreeNode>` — `getChildren()` branches on the
element's runtime type (`instanceof` checks) to decide what to return next;
top-level (`element === undefined`) returns every `FolderTreeItem` first,
then every ungrouped job. `EdaTreeDragAndDropController` handles both job and
folder reordering via one shared MIME type
(`application/vnd.code.tree.edajobrunnerview`) carrying a small
`{kind: 'job'|'folder', value}` JSON payload — `handleDrag`/`handleDrop`
dispatch on `kind` and delegate the actual array math to `JobStore`'s
`reorderJob`/`reorderFolder` (which in turn delegate to the pure
`jobOrder.ts`/`folderOrder.ts`). `iconForState`/`describeStatus`/
`countSuffix`/`describeStatusLong` are the status→icon/text mapping used by
both `JobTreeItem` and (partially) `StatusBarController`. `formatDuration`
(exported) is the shared `m:ss` / `Ns` formatter used by the tree, the
status bar, and `extension.ts`'s completion toasts.

**The tree never repaints on a timer.** `_onDidChangeTreeData` is a bare
`EventEmitter<void>`, so every fire rebuilds every row — which is fine, as
long as fires are rare. They are, because of one rule enforced in
`statusText.ts` and its test:

> **A tree row's text must never contain anything that changes on its own.**

A running row reads exactly `running` (or `running (resumed)`/`(detached)`);
no elapsed time, no in-progress error counts. The `sync~spin` icon is animated
by VS Code in CSS and needs no refresh at all, so it carries "this is alive"
by itself. That leaves the tree with nothing to repaint between real state
transitions, and `JobTreeProvider` therefore subscribes to
`jobRunner.onDidChangeStatus` (transitions) and **not** to `onDidTick` (the
1s timer, which exists purely for `statusBar.ts`). Before v1.6.1 the row
carried elapsed time, which forced a full-tree invalidation every second for
the entire length of a run — a visible, constant flicker in the sidebar.

Live numbers still exist, in the two places that cost nothing:

- **`statusBar.ts`** — one `StatusBarItem`, repainted on every `onDidTick`,
  showing the running job's elapsed time and error/warning counts.
- **`resolveTreeItem(item, element)`** — builds a running row's tooltip *when
  the user hovers it*, from a freshly-read status (`describeLiveProgress`).
  This is why `JobTreeItem` leaves `tooltip` **undefined** for a running row:
  VS Code only resolves properties that are undefined. Every other state keeps
  the static tooltip built in the constructor.

Three supporting details, all about making the remaining (transition-driven)
refreshes invisible:

- `refresh()` debounces `REFRESH_DEBOUNCE_MS` (100ms), so a folder run or a
  repeat-count batch firing several transitions at once redraws once.
- It also drops the event entirely while `TreeView.visible` is false and
  replays a single refresh on the way back in (`missedRefresh`).
- Every row sets a stable `TreeItem.id` — including **lane** rows, which use
  their `laneKey` (`job.id::runN`); without one, VS Code treats each refresh's
  lanes as brand-new rows and loses selection/scroll. `JobGroupTreeItem` and
  `FolderTreeItem` take an `expanded` flag instead of hardcoding
  `Expanded`, fed from the provider's `collapsed` set, which is maintained
  from `onDidExpandElement`/`onDidCollapseElement` — otherwise any refresh
  re-opens a group the user just closed.

`activate()` wires the visibility and expand/collapse listeners via
`treeProvider.bindView(treeView, context.subscriptions)` right after
`createTreeView`, since a provider can't reach its own view.

### 5.6 `logManager.ts` — log file storage, retention, and reads

Owns everything about *where* logs live on disk and reading them back (never
about *writing* a job's own output — that's the raw OS-level fd redirect in
`jobRunner.ts`; `LogManager` only writes the header/handles retention
cleanup).

- `resolveRoot(jobOverride?)` — the effective logs root: `jobOverride` (a
  job's own `logsDirectory`) wins, else the `eda-job-runner.logsDirectory`
  setting, else the hardcoded default `<workspaceRoot>/.eda-runner/logs`.
  Delegates to the pure `resolveLogsRoot()` in `logsRoot.ts`. Recomputed
  fresh on every call (config can change without a reload, same convention
  as everywhere else).
- `resolveAllRoots(jobs)` — the de-duplicated union of: the global root, every
  *currently existing* job's own override, **and** every root ever recorded
  in `knownRoots` (a `Set<string>` loaded from/persisted to workspace state
  under `eda-job-runner.knownLogRoots`, updated once per `createLogFile` call
  the first time a genuinely new root is seen — see `rememberRoot`). The
  `knownRoots` piece exists specifically so a **deleted** job's
  once-overridden logs root doesn't silently vanish from the Log Viewer /
  "clean all logs" sweep forever.
- `createLogFile(jobId, retention, laneSuffix?, root?)` — makes the per-job
  directory, opens `<timestamp>[_<laneSuffix>].log` in append mode, relinks
  `latest.log` (a symlink, only for the primary/unsuffixed lane), calls
  `prune()` (retention cleanup, fires on every new lane creation — including
  every batch iteration), then `rememberRoot()`.
- `listRuns(jobId, root?)` — every past-run log file for a job, **newest
  first** (string-sorted then reversed — this works because the filename
  timestamp format `YYYY-MM-DD_HH-MM-SS-mmm` sorts correctly as a plain
  string), excluding the `latest.log` symlink itself.
- `listAllJobIds(root?)` / `listAllRuns(roots?)` — cross-job enumeration for
  the Log Viewer; `listAllRuns` is NOT sorted (callers order by whatever
  field they display).
- `readHeadTail(filePath)` — reads only the first+last `HEAD_TAIL_CAP` (16KB)
  of a file (enough for the structured header/trailer — see
  `logIndex.ts`), **cached** by `path + mtimeMs + size` in an in-memory
  `Map` (`headTailCache`, capped at `HEAD_TAIL_CACHE_CAP = 2000` entries,
  oldest-insertion-order eviction) — a finished run's log never changes
  again, so a cache hit costs one `stat()` and zero reads. That's literal:
  it `stat`s first and only `open`s on a miss (it used to open first, making
  every hit an open+fstat+close — three NFS round-trips per row where one was
  intended). Skips the redundant second ("tail") read entirely when the whole
  file already fits within the head buffer (`size <= HEAD_TAIL_CAP`). Never
  throws — a vanished/unreadable file yields empty strings (defensive against
  a concurrent retention prune), and its `close()` is inside the catch, since
  a close failure escaping a "never throws" API was enough to strand a
  reattached job mid-finalize.
- **`readFully(handle, length, position)`** (exported) — reads exactly
  `length` bytes, **looping until the buffer is full or EOF**. `read(2)` may
  return short and routinely does on NFS, which is where these logs live: a
  single `handle.read(...)` that ignores `bytesRead` leaves the rest of the
  buffer as NULs, which then read as real (empty) content — a log header
  parsed wrong, or a full-text search reporting "no match" for text that is
  right there. Use this for **every** positional read; `readHeadTail`, the
  Log Viewer's `searchOne`, and `readTailChunk` all go through it.
- **`readTailChunk(filePath, maxBytes)`** (exported, standalone) — the last
  `maxBytes` as text *plus the offset that text ended at*, so a caller can
  continue tailing from exactly there with no gap or overlap. Used by
  `logLiveView.ts` (see 5.11) — standalone rather than a method because that
  view owns no `LogManager`.
- `totalSize(roots?, exclude?)` / `cleanAllLogs(roots?, exclude?)` — the
  "clean all logs" button's summary + actual deletion, both built on the
  private `sizeAllRuns()`, which stats in `STAT_CONCURRENCY`-wide batches
  (serial `await`s meant a thousand-run workspace spent seconds of NFS
  latency, twice: once for the confirmation, once for the deletion).
  **`exclude`** (a `Set<string>` of currently-live log paths, from
  `JobRunner.getActiveLogPaths()`) is skipped entirely in both — deleting a
  log a running child still has open would freeze live tailing/counts and
  orphan the eventual trailer write into a deleted inode. Note
  `getActiveLogPaths()` also covers a `running` status with no `ActiveRun` or
  `ReattachRun` yet (the activation window before `beginReattachment`).
  `cleanAllLogs` also unlinks any `latest.log` symlink whose target isn't in
  `exclude` (`unlinkStaleLatestSymlinks`), so a finished job's dangling
  symlink doesn't survive a clean-all.
- `prune()` (private) — delegates the actual "which files to delete"
  decision entirely to the pure `planPrune()` in `logRetention.ts` (see
  5.11) — this method's only job is gathering `{path, size}` for every
  existing run and unlinking whatever `planPrune` says to delete.

**Family-aware retention** (added in the Phase 12 review, see `PLAN.md`):
a repeat-count batch's lanes (filenames carrying a `_<i>-<total>` suffix,
produced by `sanitizeLaneSuffix` in `jobRunner.ts`) are grouped by
`logRetention.ts`'s `groupIntoFamilies` into ONE family for both the count
and size caps, so a large batch can never have its own still-in-progress
iterations pruned mid-run, and the newest family is never deleted even if it
alone exceeds a size cap.

### 5.7 `logDiagnostics.ts` — Problems panel integration

Owns the one shared `vscode.DiagnosticCollection` for the whole extension.
`setJobIssues(jobId, jobCwdAbs, issues)` replaces a job's previous
diagnostics wholesale (tracked per-job in `byJob: Map<string, vscode.Uri[]>`
so re-running only clears its own). Because it rebuilds a `Range` +
`Diagnostic` for **every** stored issue (up to `MAX_STORED_ISSUES = 5000`) on
each call, callers must not invoke it per chunk: a live run pushes once, in
`finish()`, and the reattach path goes through `jobRunner`'s
`pushReattachDiagnostics()`, which skips when the issue count hasn't changed
and otherwise rate-limits to `REATTACH_DIAGNOSTICS_INTERVAL_MS` (the final
push passes `force`). `resolvePath()` tries, in order:
absolute-and-exists, relative-to-job-cwd-and-exists, relative-to-workspace-
root-and-exists — gives up (drops the issue from the Problems panel, though
it still counted toward the error/warning badge) rather than guessing by
basename search, since a wrong jump is worse than none.

### 5.8 `logParser.ts` — structured issue extraction (the "understands EDA tool output" module)

The one place this codebase has tool-specific pattern knowledge — but it's
about **recognizing output formats**, not about running or configuring any
tool (still consistent with the tool-agnostic-core principle: nothing here
assumes a specific command/flag, only a specific *output shape*). Every
regex here is grounded in real captured output (see `test-fixtures/*.log`),
not guessed. Five tool formats recognized: UVM runtime messages (with the
classic "don't count the end-of-run summary row" trap —
`UVM_ERROR :    1` looks almost like a real message line but is excluded via
an anchored regex requiring the count to be the ONLY thing after the
colon), Questa vlog/vcom (`** Error:`/`** Warning:`), Icarus
(`file.sv:5: error:`), DSim (structured `=E:[Tag]:` blocks — an indented
location line only counts as an error while inside an open `=E:`/`=F:`
block, tracked via `ParseState.dsimErrorBlock`), Verilator
(`%Error:`/`%Warning-CODE:` with `file:line:col`, whose summary rows have no
location and so simply fail to match — no special exclusion needed, unlike
UVM's). `parseLine(line, state)` mutates a `ParseState` in place, called
once per output line as it streams in; `state.issues` is capped at
`MAX_STORED_ISSUES = 5000` (counts stay exact regardless — only the stored
`LogIssue[]` backing the Problems panel is capped).

### 5.9 `tailer.ts` — `FileTailer`

Polls via `fs.stat` (NOT `fs.watch`/inotify — EDA farm output files on NFS
usually don't fire inotify events, so only size-polling reliably notices
growth), every 500ms by default. Handles truncation/rotation (size shrinks →
re-read from offset 0). `pollOnce()` is exposed and awaitable so
`jobRunner.ts` can force a deterministic final read at completion time
without waiting on the timer. Used in **three** independent places: a live
run's own captured-output tail (`jobRunner.ts`'s `ActiveRun.tailer`), a
reattached run's tail (`ReattachRun.tailer`), and the completely separate
"Live Log (tail)" feature (`logLiveView.ts`, tailing an arbitrary external
file like an LSF `-o` output — has nothing to do with the job's own captured
log).

Three details that each exist because of a specific bug (v1.6.0):

- **`pollOnce()` calls are serialized, never dropped.** They chain onto a
  `queue` promise, so a call issued while another poll is in flight still runs
  its own full drain afterwards. The original implementation returned early
  when a poll was already running — which silently turned `finish()`'s
  "guaranteed final read" into a no-op whenever the 500ms timer happened to
  fire first, losing the tail of the log and, for a job with a `passPattern`,
  reporting a passing run as **failed**. The timer path (not the explicit one)
  is what coalesces: it skips its tick while `draining` is true.
- **`maxBytesPerRead`** (default unbounded) bounds each read+emit; one
  `pollOnce()` still catches up completely, looping with an `await` between
  slices so the extension host isn't blocked building one whole-file string.
  Only `ReattachRun` sets it (`REATTACH_READ_CHUNK`, 4MB).
- **`startAt: 'beginning' | 'end' | <offset>`** (default `'beginning'`).
  `'end'` is for a viewer that only wants new output; a numeric offset is for a
  caller that already read the earlier bytes itself and knows exactly where it
  stopped — `logLiveView.ts` seeds its terminal with `readTailChunk`'s last
  16KB and then continues from that read's own end offset, so nothing is
  skipped or shown twice. Anything that must rebuild cumulative state from a
  whole run (the reattach path: error counts, Problems entries) has to stay on
  `'beginning'`.

### 5.10 The pure decision modules (each with its own `test-fixtures/run-*-tests.mjs`)

- **`jobOutcome.ts`** — `JobRunState` type (`'idle'|'running'|'passed'|
  'failed'|'killed'`) and `decideFinalState()`: the precedence is `killed`
  (unconditional) > a matched `failPattern` (forces failed even on exit 0)
  > a configured `passPattern` (fully governs: matched→passed, unmatched→
  failed — bypasses the generic error-count flip entirely) > the generic
  "passed baseState flips to failed if `parseProblems && failOnLogErrors &&
  errorCount > 0`" rule > else `baseState` stands. Also `compilePattern()`
  (case-insensitive, never throws, undefined for blank/invalid — the shared
  convention every user-regex field in this codebase follows).
- **`reattach.ts`** — `decideReattachState()`, a thin wrapper reusing
  `decideFinalState` with a conservative `'failed'` baseline (see 5.4.3).
- **`killPlan.ts`** — `computeKillSchedule()` (see 5.4.4).
- **`procStat.ts`** — `parseStartTimeTicks()`, extracts field 22 of
  `/proc/<pid>/stat` (careful about `comm` potentially containing spaces/
  parens — slices past the *last* `)` first).
- **`paramSubstitution.ts`** — `parseParams`/`substituteParams`/
  `substituteRandomSeed` (see 4.3).
- **`paramVars.ts`** — `parseVars`/`effectiveVarValue`/`substituteParamVars`/
  `flattenGlobalParams` (see 4.3). Its `VAR_TOKEN` regex is deliberately
  disjoint from `paramSubstitution.ts`'s `PARAM_TOKEN` (`${var:...}` vs.
  `${param:...}`) so a command can use either or both with no collision.
- **`logsRoot.ts`** — `resolveLogsRoot()` (see 5.6), `logsRootRelativeToWorkspace()`
  (for the `.gitignore` auto-entry — undefined when the root isn't actually
  inside the workspace, e.g. an absolute path elsewhere).
- **`logRetention.ts`** — `planPrune()` and `groupIntoFamilies()` (see 5.6).
  `RetentionOptions { maxCount, maxTotalBytes }`, `0` means unlimited for
  either.
- **`logIndex.ts`** — `parseLogHeader`/`parseLogTrailer`/`parseLogFilename`/
  `searchMatches` (see 5.6/5.12 — the log's own header/trailer text IS the
  index; nothing is separately persisted).
- **`seedDetect.ts`** — `BUILTIN_SEED_PATTERNS` (an ordered array of guessed
  regexes for common EDA seed-argument conventions), `compileSeedPattern()`
  (rejects blank/invalid input AND the classic catastrophic-backtracking
  regex shape — `CATASTROPHIC_SHAPE = /\([^()]*[+*][^()]*\)[+*]/`, e.g.
  `(a+)+` — outright, before ever executing it: verified empirically that a
  text-length cap alone cannot bound catastrophic backtracking to something
  safe, since it's exponential in input length), `detectSeed(text,
  customPattern?)` (tries the custom pattern first against a bounded
  slice of `text` — `CUSTOM_PATTERN_TEXT_CAP`, taken from both ends so a
  seed banner near the tail is still reachable — then each builtin pattern
  in order; every builtin's captured value must look numeric/hex-shaped,
  `(0x[0-9a-fA-F]+|\d+)\b`, so a loose fallback pattern can't capture a bare
  word like "automatic"). Mirrored (kept in sync!) client-side in
  `toolSetupPanel.ts`'s seed-tester script.
- **`jobOrder.ts`** / **`folderOrder.ts`** — `computeReorderedJobs()` /
  `computeReorderedFolders()`, plain array splice/insert logic for drag-and-
  drop, returning the SAME array reference (a deliberate no-op sentinel) when
  the target id/name isn't found.
- **`shellInvocation.ts`** — `defaultArgsForShell()` (per-shell-family argv,
  e.g. bash/zsh/sh/ksh/dash/fish → `-lc`, tcsh/csh → `-c` — NOT `-lc`, since
  tcsh's `-l` "may be given only if it is the only flag" and can't combine
  with `-c` anyway; tcsh/csh still source `~/.tcshrc`/`~/.cshrc` on any
  non-`-f` invocation), `buildShellInvocation()` (substitutes the
  `${command}` token wherever it appears in the arg template, or appends the
  command as the final arg if absent — the command is always one argv
  element, never string-concatenated, so there's no re-quoting/injection
  surface), `substituteVars()` (`${workspaceFolder}`/`${env:NAME}` expansion,
  used by every path-like setting in this codebase), `resolveJobEnv()`
  (merges configured env vars on top of `process.env`, returns `undefined`
  when there's nothing to add so the common case stays a pure inherit).
- **`toolOptionParser.ts`** — `parseHelpOutput()` (generic GNU/argparse/click
  `--help` line parsing: a 1-4-space-indented line starting with `-`, a
  2+-space gap separating the flag column from the description,
  `splitTopLevel()` for comma-splitting flags while respecting `{...}`
  choices braces), `mergeFavorites()` (carries a flag's `favorite` AND
  `valueListName` forward across a rescan by matching on flag spelling, not
  list position — **this must be called by every code path that replaces a
  variant's options after a rescan**, or hand-set favorites/value-list
  attachments silently vanish; a real bug this exact omission caused once,
  fixed in Phase 11), `parseChoices()` (derives dropdown choices from an
  argparse `{a,b,c}`-shaped metavar, purely on demand — not persisted
  separately), `detectSubcommandChoices()` (spots an argparse subparser
  signature to suggest tool variants when first registering a tool).
- **`listSource.ts`** — `parseListLines()` (generic line-splitting +
  comment/blank-filtering + optional regex extraction, capped at
  `MAX_LIST_VALUES = 5000`), `applyInsertTemplate()` (`${value}`
  substitution into a Command fragment, mirrored client-side in
  `jobConfigPanel.ts`).

### 5.11 The impure-but-simple support modules

- **`shellDetect.ts`** — `detectVscodeShell()`, reads VS Code's own
  integrated-terminal default profile (or falls back to `vscode.env.shell`,
  or a hardcoded `'bash'`) for the "Use My VS Code Terminal Shell" button.
  Deliberately does NOT copy a profile's own `args` verbatim (they're
  interactive-only, e.g. a bare `-l`, and can't run a command) — always
  regenerates command-capable args via `defaultArgsForShell` for the
  detected shell's family.
- **`toolIntrospect.ts`** — the impure half of tool scanning. `runProbe()`
  (shared by flag-scanning and list-discovery) spawns `<setup chain> &&
  <probeCommand>` through the exact same `buildShellInvocation`/
  `resolveJobEnv` path a real job uses, with a 15s timeout
  (`SCAN_TIMEOUT_MS`) and a 64KB output cap (`SCAN_OUTPUT_CAP`).
  `scanVariant()`/`scanTool()` wrap this + `parseHelpOutput` for flags;
  `discoverList()`/`scanLists()` wrap this (or a capped file read,
  `LIST_FILE_CAP = 1MB`) + `parseListLines` for value lists. A tool's own
  `scanDir` override (or the workspace `postSetupCwd` default) decides the
  probe's cwd — independent from a job's own runtime cwd.
- **`gitignoreManager.ts`** — `ensureGitignoreEntry()`, offers ONCE per
  workspace (tracked via a memento flag) to add the resolved logs root to
  `.gitignore`. A no-op when the root isn't actually inside the workspace.
- **`webviewHelp.ts`** — `HELP_CSS` + `help(html)`: the shared "(?)" hover/
  focus tooltip icon used by all five webview panels. Fixed-pixel sizing
  (not `em`-relative) deliberately, to avoid compounding into illegibly
  small text on a high-DPI display — this was a real reported bug (Phase 11).
- **`statusBar.ts`** — `StatusBarController`, mirrors the tree's own
  "a job with lanes is represented by its lanes" model exactly (to avoid
  double-counting or hiding the bar when only a non-primary lane is running
  — a real bug fixed once already). It is the **only** subscriber to
  `jobRunner.onDidTick`, and so the only thing in the extension that repaints
  on a timer: one item, no tree churn. This is where a running job's live
  elapsed time and error/warning counts live now (see 5.5).
- **`statusText.ts`** — pure: every status→text formatter shared by the tree,
  the status bar and the completion toasts (`describeStatus`, `countSuffix`,
  `describeStatusLong`, `describeLiveProgress`, `formatDuration`). Its test
  (`run-status-text-tests.mjs`) is where 5.5's "a row's text must never move
  on its own" rule is actually enforced rather than just documented.
- **`logFollow.ts`** — `LogFollowController`, auto-scrolls an open log
  editor tab to its last line as new output lands, for whichever job was
  most recently told to be "followed" (`eda-job-runner.followLog` command).
  Only one job followable at a time (matches the one-job-at-a-time default).
- **`logLiveView.ts`** — `LogLiveView`, a read-only VS Code Pseudoterminal
  streaming an arbitrary file via its own `FileTailer` — completely separate
  from a job's own captured-output tailing; this is for `JobDefinition.logFile`
  (an external scheduler output file) or just live-viewing the current
  captured log in real time instead of relying on VS Code's passive
  file-change reload of an editor tab. **It starts at end-of-file, not byte 0**:
  `open()` seeds the terminal with `readTailChunk`'s last `SEED_TAIL_BYTES`
  (16KB, prefixed with a "showing the last N KB" note when the file is bigger)
  and then tails from that read's own end offset. Replaying the whole file was
  a hard freeze on an overnight run's log — the more so because
  `extension.ts`'s `restoreLiveLogViews` reopens one of these automatically for
  every still-running job after a reload, concurrently with that same job's
  reattach catch-up. The seed read is async, so `close()` sets a `closed` flag
  the continuation checks — otherwise closing the terminal first left a
  polling tailer nothing would ever stop.

## 6. Webview panels (5 total) — the shared pattern

Every panel is one `.ts` file with two exported pieces: a controller
**class** (owns the `vscode.WebviewPanel`, a static `createOrShow()`
singleton-or-reveal factory, a private constructor, an `onMessage()` handler,
a `cleanup()`) and an exported **`renderHtml(webview, ...data)` function**
returning one complete `<!DOCTYPE html>` string. `renderHtml` is the ONLY
thing the visual-test harness (section 8.3) calls directly — every panel's
signature was made `export`able specifically to support that.

| Panel | File | Command | Purpose |
|---|---|---|---|
| Configure Job | `jobConfigPanel.ts` | `eda-job-runner.configureJob` / `addJob` / `addJobInFolder` | Add/edit a job: name, command (+ tool builder), cwd, templates, params, Advanced section |
| Tool Setup | `toolSetupPanel.ts` | `eda-job-runner.configureTools` | Register/edit tools, scan flags, favorites, value lists, seed pattern |
| Shell & Environment | `shellEnvPanel.ts` | `eda-job-runner.configureShell` | Shell/env/setup-script settings, log retention, clean-all |
| Parameters | `paramsPanel.ts` | `eda-job-runner.configureParams` | Global `${var:NAME}` name/value pairs |
| Log Viewer | `logViewerPanel.ts` | `eda-job-runner.openLogViewer` | Every past run across every job, filterable/searchable table |

### 6.1 Universal conventions across all five

- **CSP**: `default-src 'none'; style-src <cspSource> 'unsafe-inline';
  script-src 'nonce-<random>';` — a fresh 32-char nonce per render
  (`getNonce()`, duplicated verbatim in each file rather than shared —
  intentional, trivial, not worth a shared import).
- **All styling is inline `<style>`** using `--vscode-*` CSS custom
  properties for full theme compliance (never hardcoded colors except as
  a documented fallback, e.g. `var(--vscode-badge-background,
  rgba(127,127,127,0.35))`). `HELP_CSS` (5.11) is always concatenated in.
- **All JSON embedded into the client script is escaped**:
  `JSON.stringify(...).replace(/</g, '\\u003c')` — prevents a value
  containing `</script>` from breaking out of the inline `<script>` block.
  This is required on every single embedded payload; when adding a new one,
  copy this exact pattern.
- **Host↔webview messaging**: `vscode.postMessage({type, ...})` one
  direction, `panel.webview.postMessage({type, ...})` the other,
  `window.addEventListener('message', ...)` client-side. Every panel's
  message union is a TypeScript discriminated union (`type WebviewMessage =
  A | B | C`) switched over in `onMessage()`.
- **Save never closes a panel; only Cancel/Close does.** The only thing that
  may call `panel.dispose()` is a `cancel`/`close` message handler. A save-like
  handler persists, then posts `{type:'saved'}` (and `{type:'saveError',
  message}` from a `try/catch` around the write) and the client shows an
  inline flash — `jobConfigPanel`, `shellEnvPanel` and `paramsPanel` all do
  exactly this, and `toolSetupPanel`'s sub-form saves re-`render()` in place.
  Disposing on save destroyed whatever else was mid-edit on the same screen
  and made a failed write indistinguishable from a successful one. Each of
  these also has a `saving`/`probing` re-entrancy boolean so a double-click
  can't start two writes.
- **A handler that can throw must leave the panel usable.** Every panel wraps
  `onMessage(msg).catch(...)` to surface the error instead of dying silently;
  `toolSetupPanel`'s also calls `render()` in that catch, because its
  client-side `showBusy()` overlay is torn down only by the next full render —
  without it, one failed scan left the panel behind an unclickable overlay
  with no way out but closing and reopening it. Any panel that grows a busy
  overlay needs the same.
- **Client-side state that the user typed but hasn't committed must survive a
  re-render.** A full-document reassignment throws away every uncommitted
  field, so the panel keeps it host-side and replays it into `renderHtml`:
  `paramsPanel`'s `draftParams` (typed parameter rows) and `draftLists`
  (a half-filled "add a value list" row) are the worked example — the client
  sends both with every message that triggers a render.
- **Full-document reassignment vs. client-side patching**: four of the five
  panels (`jobConfigPanel`, `shellEnvPanel`, `paramsPanel`, `logViewerPanel`)
  reassign `panel.webview.html` on essentially every state-changing message
  — the exception is `toolSetupPanel.ts`, which does this for structural
  changes (add/remove tool, rescan, add/remove variant, add/remove list) but
  deliberately **patches the DOM client-side instead** for its two
  highest-frequency interactions (favorite-star toggle, value-source
  dropdown change) — see 6.3. If you're adding a new high-frequency toggle
  anywhere, prefer the client-side-patch approach over a full re-render;
  it's the established, reviewed-in convention now, not a one-off hack.
- **Escaping user/data text into HTML**: every panel defines its own local
  `esc()` (`&`/`"`/`</>`replacement) — used for anything interpolated as HTML
  text or attribute value. `help()`'s `html` argument is the one deliberate
  exception (never escaped) because it must always be this extension's own
  static copy, never user/workspace data.
- **Shared client-side snippets, embedded via a `${CONST}` template
  interpolation right inside each panel's own `<script>` block** (never a
  separate `<script src>`, since CSP only allows the one nonced inline
  block): `src/webviewBrowse.ts`'s `BROWSE_JS` (a folder/file "Browse…"
  button, correlated to the host by an incrementing request id) and
  `src/webviewError.ts`'s `CLIENT_ERROR_JS` (posts any uncaught
  `window.onerror` back to the host as a `clientError` message, shown as a
  generic "a panel failed to initialize" notification — added after a
  v0.42.0 regression left an entire panel silently inert for a full
  release with zero signal anywhere; it also listens for
  `unhandledrejection`, tagged `kind: 'rejection'` so the notification says
  "failed to finish" rather than "failed to initialize" — a rejected promise
  never fires `error`, so async panel code used to fail with no signal at all,
  the exact hole this bridge exists to close). `CLIENT_ERROR_JS` is always the
  **very first** thing after `const vscode = acquireVsCodeApi();` in every
  panel, ahead of even `BROWSE_JS` — an error-reporting bridge that isn't
  wired before everything else it's meant to catch is much less useful.
- **`$req` convention**, in the three panels that already have a
  `const $ = id => document.getElementById(id);` shorthand
  (`toolSetupPanel.ts`, `shellEnvPanel.ts`, `logViewerPanel.ts` —
  `jobConfigPanel.ts`/`paramsPanel.ts` call `document.getElementById`
  directly with no such helper): `$req(id)` throws a named
  `missing element #<id>` error instead of silently returning `null`, and
  is used at every unconditional lookup site. `$(id)` stays the nullable
  form, still required for `toolSetupPanel.ts`'s several `if ($('x'))`
  presence checks (its HTML has multiple mutually-exclusive rendered
  states, unlike the other two panels, which always render one full form
  and so have no legitimate use for the nullable form at all). Do not make
  `$()` itself throw — that would break those presence checks.

### 6.2 `jobConfigPanel.ts` deep dive (the largest, most stateful panel)

`JobConfigPanel.panels: Map<string, JobConfigPanel>` — a static map keyed by
job id (or the sentinel `'__new__'` for an unsaved new job), so re-invoking
"Configure" on an already-open job reveals the existing tab instead of
opening a duplicate. A brand-new job's first Save adopts the newly-created
id and re-keys the map entry from `'__new__'` (so a subsequent fresh "Add
Job" can open its own separate panel).

Client-side state: `TOOLS` (slim per-tool payload: id/command/variants/
options/lists, no `rawHelp`/`scanError` — those aren't needed here),
`SAVED_TOOL_VARIANT`, `LIST_OVERRIDES` (mutable — cleared on template Load),
`GLOBAL_PARAMS`, `SAVED_PARAM_OVERRIDES`, `TEMPLATES` (mutable — refreshed
via a `'templates'` message after a save/delete-template round-trip).

**The builder/Command relationship** (read this before touching either): the
`<details id="toolBuilder">` element's own `open` state decides ownership.
`builderOwns()` returns `toolBuilderEl.open`. `onBuilderChange()` (called by
every checkbox/value-input/list-select change) checks `builderOwns()`: if
open, it calls `applyBuilderToCommand()` (writes the built command INTO the
textarea); if collapsed, it only updates the hint text — Command stays
whatever was hand-typed. `refreshBuilderUI()` goes the OTHER direction —
re-syncs the builder's checkboxes/selects FROM the current Command text (via
`flagPresent`/`extractValue`, simple regex tests against the command
string) — called on initial load, and by `loadTemplate` after clearing
stale state. **Never call `applyBuilderToCommand` and `refreshBuilderUI` in
the same direction accidentally** — the whole design rests on this being a
strict one-way sync in each mode, so opening the builder never silently
clobbers a hand-written command the user didn't intend to lose (it does
intentionally rebuild once, right when you open it — this is documented,
intended behavior, not a bug, per Phase 11's investigation).

`loadTemplate` (Template dropdown → Load button): applies the template's
fields, then **clears `customArgsWrap`, `paramOverridesWrap`, and
`LIST_OVERRIDES`** before calling `refreshBuilderUI()` — a `JobTemplate`
never carries any of the three, so without this clear, a previously-loaded
job/template's custom args or parameter overrides would silently leak into
whatever gets loaded next (a real bug found and fixed via the visual-test
harness — see `PLAN.md`'s Phase 12).

The **choices-vs-var toggle** (`buildOptionRow`'s `varToggle` button, `✎ var`
/ `◀ choices`): a value-taking option whose metavar is an argparse
`{a,b,c}` choices brace renders as a `<select>` by default, but a fixed
dropdown can't hold a `${var:NAME}` reference — the toggle button swaps the
live DOM element between a `<select>` and a free-text `<input>` (with the
same `varOptions` `<datalist>` autocomplete every builder text field gets),
preserving the current value across the swap whenever it still fits. This
is a genuinely reversible toggle (fixed in Phase 11 after being a one-way,
destructive swap originally).

### 6.3 `toolSetupPanel.ts` deep dive

`ToolSetupPanel` tracks three pieces of "what am I currently showing"
state beyond the persisted tools list itself: `pendingAdd` (a scan result
awaiting confirmation before it becomes a real `ToolDefinition`),
`editingToolId` (which tool's in-place edit form is open), `addingVariantForToolId`.
Every `render()` call re-derives the whole HTML from `toolStore.getTools()`
plus these three.

**The favorite-toggle client-side patch** (`wire('[data-fav-id]', ...)`): on
click, immediately (1) flips the button's glyph/class/title, (2) re-sorts
the enclosing `<table class="opts">`'s rows favorites-first using the SAME
comparator the server's `renderOptionRowsEditable` uses — critically, ties
break on each row's **`data-orig-idx`** attribute (the option's index in the
tool's own, un-sorted `options` array, embedded server-side specifically for
this), **not** current DOM order. This detail matters: an earlier version of
this patch used current-DOM-order as the tiebreak, which meant repeatedly
toggling a flag on and off would permanently drift the table's order away
from what a fresh render would show (caught by the visual-test harness,
section 8.3 — a real bug in this very feature's own fix). Then (3) posts
`{type:'toggleFavorite', ...}` to the host, which persists via
`mergeFavorites`-free direct mutation (`toggleFavorite`'s handler) and
**does not call `render()`** — the client already reflects the new state.
The value-source `<select>`'s `change` handler similarly posts
`setOptionValueSource` with no re-render — nothing else on the page depends
on that value.

The Seed pattern paste-and-preview tester (`wireSeedTesters`,
`detectSeedPreview`) is a **client-side reimplementation of `seedDetect.ts`'s
`detectSeed`**, kept manually in sync (including the `CATASTROPHIC_SHAPE`
regex guard) so the live preview needs no host round-trip on every
keystroke. **When `seedDetect.ts` changes, check whether this client-side
mirror needs the same change.**

### 6.4 `shellEnvPanel.ts`, `paramsPanel.ts`, `logViewerPanel.ts` — brief notes

- **`shellEnvPanel.ts`**: "Use My VS Code Terminal Shell" (`onDetect`) only
  leaves the "Auto-select shell arguments" checkbox checked when the
  detected args are byte-identical to what `defaultArgsForShell` would
  already produce for that shell (`arraysEqual`) — otherwise `onSave`'s
  `shellArgsAuto ? undefined : parseLines(...)` would silently discard the
  very args Detect just displayed (a real bug fixed in Phase 12). "Test
  Shell Setup" (`onTest`) spawns a real probe with a `TEST_MARKER` echo and
  a 15s timeout, capped output — same defensive shape as
  `toolIntrospect.ts`'s `runProbe`, duplicated rather than shared (different
  enough call site needs — this file also needs to track `this.testChild`
  for cleanup-on-panel-close). "Clean all logs" reads `JobRunner.getActiveLogPaths()`
  and passes it through as `exclude` to both `totalSize`/`cleanAllLogs`
  (see 5.6).
- **`paramsPanel.ts`**: the simplest panel — one array of `{name, value}`
  rows, Save replaces the whole `GlobalParam[]` list via
  `jobStore.setParams()`, then posts `{type:'saved'}` and stays open (6.1).
  Note the value-list section shares the screen with the parameter rows but
  persists *immediately* per action (Add/↻ Refresh/Remove each write and
  re-render), while parameters only persist on Save — which is exactly why
  both `draftParams` and `draftLists` exist: every list action re-renders the
  whole document underneath whatever the user was typing.
- **`logViewerPanel.ts`**: builds its table entirely from each log file's own
  header/trailer (`logIndex.ts`) via `readHeadTail` (cached, see 5.6) — **no
  separate persisted index of runs exists**; the log files on disk ARE the
  index. `gatherRows`/`search` both bound concurrency
  (`READ_CONCURRENCY = 20`) so a workspace with hundreds of logs doesn't open
  that many file handles at once. Full-text search (`searchOne`) reads a
  capped 5MB per file (`SEARCH_FILE_CAP`) across at most 300 files
  (`SEARCH_FILE_LIMIT`) — scoped to whatever's already filtered
  (job/folder/status/seed/date), not the whole log set — with the query
  lowercased once by `search()` and passed to `matchesLowercased()` rather
  than re-lowercased per file. The seed column falls back to `detectSeed()`
  (the `# seed:` header field is only ever populated when a job's Command used
  `${randomSeed}` directly).

  Client-side, `render()` rebuilds all of `#groups` and every run appears
  **twice** (once under "All logs", once under its job's group), so the row
  count is 2× the run count: it uses **one delegated `click` listener on
  `#groups`** rather than one per `<tr>`, the free-text filters are debounced
  ~150ms, and each `<details>`' open/closed state is tracked in `OPEN_GROUPS`
  (keyed by `data-group`, captured via a capture-phase `toggle` listener since
  `toggle` doesn't bubble) and re-applied on render — without that, expanding a
  job group and then touching any filter silently collapsed it again.

## 7. `package.json` contribution surface (the extension manifest)

- **Activation**: `onView:edaJobRunnerView` only — lazy, no eager activation.
- **View**: one activity-bar container (`eda-job-runner`, wrench-ish icon)
  holding one tree view (`edaJobRunnerView`, titled "Jobs"). `viewsWelcome`
  covers the empty/no-workspace states.
- **~29 commands**, all prefixed `eda-job-runner.*`. Most are hidden from the
  command palette (`"when": "false"` in the `commandPalette` menu section)
  since they only make sense with a specific tree item as context — the
  handful left visible in the palette are the "global" ones: `addJob`,
  `refresh`, `configureShell`, `configureTools`, `configureParams`,
  `openLogViewer`, `addFolder`, `runDefaultJob`. Every command is registered
  in `extension.ts`'s `activate()` — see 5.1 for what each calls.
- **Context-menu wiring** (`view/item/context`) uses `viewItem` regex
  matching against `contextValue` strings set in `treeProvider.ts`:
  `edaJob-<state>` (plain job row), `edaJobRun-<state>` (a lane inside an
  expanded group), `edaJobGroup-<running|idle>` (group header),
  `edaFolder`. Two duplicate group blocks exist per command
  (`inline@N` for the hover-icon row, `1_run@N`/`2_modification@N`/
  `1_folder@N` for the actual right-click menu) — **when adding a new
  per-item command, you generally need both an `inline` entry (if it should
  show as a hover icon) and a numbered-group entry (for the right-click
  menu itself)**.
- **One keybinding**: F5 → `runDefaultJob`, gated by the
  `edaJobRunner.hasDefaultJob` context key (set in `extension.ts`) AND
  `!inDebugMode` (never steals F5 from an actual debug session).
- **Settings** (`contributes.configuration`, prefix `eda-job-runner.`):
  `shellPath`, `shellArgs` (nullable array), `env` (object), `killSignals`
  (array of `{signal, graceSeconds}`), `killGracePeriodSeconds`,
  `logMaxSizeMB` (parse-cap, confusingly named — see 5.4.6/5.6, do NOT
  rename, it's a shipped setting name, sharpen its description instead),
  `logRetentionCount`, `logRetentionMaxSizeMB`, `stripAnsiCodes` (dead since
  v0.30.0, kept registered for `settings.json` backward-compat only),
  `failOnLogErrors`, `postSetupCwd`, `logsDirectory`,
  `experimentalMultipleRuns`, `experimentalAutoSaveJobConfig`.

## 8. Build, test, and CI

### 8.1 Build

`esbuild ./src/extension.ts --bundle --outfile=dist/extension.js
--external:vscode --format=cjs --platform=node --target=node16` (npm script
`esbuild-base`; `compile` adds `--sourcemap`, `vscode:prepublish` adds
`--minify` instead). **One single bundled output file** — no other build
artifacts matter for running the extension. `tsconfig.json`'s own `outDir:
"out"` is essentially vestigial (used only by `tsc --noEmit` for
typechecking, via the `typecheck` npm script) — esbuild does the real
bundling and never touches `out/`.

### 8.2 Tests — the `test-fixtures/run-*-tests.mjs` convention

Every pure module (section 5.10) has a matching standalone Node test
harness: `test-fixtures/run-<name>-tests.mjs`. Each one:

1. `execSync('npx esbuild ./src/<module>.ts --bundle --format=esm
   --outfile=/tmp/<module>.mjs', { stdio: 'inherit' })` — bundles just that
   one module (and its pure-module dependencies) to a temp ESM file.
2. `await import('/tmp/<module>.mjs')` — dynamic-imports it.
3. A tiny local `check(cond, msg)` helper prints `ok: <msg>` or
   `FAIL: <msg>` and increments a `failures` counter.
4. A flat list of assertions, each with a descriptive message explaining
   the *scenario*, not just the mechanical assertion.
5. Exits `1` if any failure, `0` otherwise.

Run any single one directly: `node test-fixtures/run-log-retention-tests.mjs`.
Run the whole suite (what CI does): loop over `test-fixtures/run-*-tests.mjs`
— **this is glob-discovered, not a hardcoded list**, so a newly-added test
file needs no CI/workflow edit, just the file itself. When adding a new pure
module, **always add its own `run-<name>-tests.mjs`** following this exact
shape — it's the primary regression coverage this codebase has.
`jobRunner.ts`'s actual spawn/IO plumbing isn't unit-tested this way (see
8.3 for how the webview panels get covered instead — as of Phase 16, one
of those two harnesses, `run-webview-smoke-tests.mjs`, *is* itself
glob-discovered and runs in this exact loop, so it's really a
`test-fixtures/run-*-tests.mjs` file that happens to test webview panels
rather than a pure decision module).

Some `test-fixtures/*.log` files are **captured real tool output** (DSim,
Icarus, Questa, Verilator) checked in specifically to ground
`logParser.ts`'s regexes in reality rather than guesses — `.gitignore` has
an explicit exception (`!test-fixtures/*.log`) since the repo otherwise
ignores `*.log`.

### 8.3 The visual-test harness (`scripts/render-webviews.mjs` + `screenshot-webviews.mjs`)

Added in the Phase 12 review specifically to test the 5 webview panels
(section 6) without needing a full VS Code Extension Development Host (which
needs a real VS Code Electron download not always available in a sandboxed
environment — that path is intentionally left as a backlog item, not
implemented).

**How it works**: each panel's `renderHtml` export is esbuild-bundled with
`--alias:vscode=scripts/vscode-webview-shim.mjs` (a trivial `export default
{}` — safe because every panel imports `vscode` only as `import * as vscode
from 'vscode'`, namespace form, and none of them touch `vscode.*` at module
load time or inside `renderHtml` itself — only `webview.cspSource`, which
the harness's fake `{ cspSource: 'vscode-resource:' }` object supplies
directly). `render-webviews.mjs` calls each bundled `renderHtml` with
realistic hand-written sample data (a tool with variants/favorites/a
choices-metavar/an attached list, a job with custom args/param overrides/a
post-run command, templates, global params, a full Shell&Env `PanelState`)
and writes the resulting HTML to `.webview-preview/html/*.html` (gitignored
AND vscodeignored — **this output directory must never ship in the VSIX**;
it once did by accident until `.vscodeignore` was updated, see `PLAN.md`'s
Phase 12).

`screenshot-webviews.mjs` then loads each of those static HTML files in
headless Chromium via `playwright-core` (chosen specifically because it
never auto-downloads a browser — `executablePath` points at whatever
Chromium is already cached on the machine running this), injects the
`--vscode-*` CSS theme variables for both a dark and a light theme via
`page.addStyleTag`, stubs `window.acquireVsCodeApi` via
`context.addInitScript` (runs before any page script, matching how a real
VS Code webview host behaves), and screenshots each page — plus a handful
of **scripted interactions** exercising exactly the paths recent bugs were
found in: toggling the jobConfig var/choices button, loading a template,
hovering a help icon, toggling a Tool Setup favorite star (and toggling it
back off, to check idempotency), checking both Shell&Env retention boxes,
posting synthetic rows into the Log Viewer. Runs at `deviceScaleFactor: 2`
(HiDPI) specifically because the original bug report that started the
help-icon-sizing fix (section 5.11's `webviewHelp.ts` note) was about
illegible text on a high-DPI display.

**Usage**: `node scripts/render-webviews.mjs && node
scripts/screenshot-webviews.mjs`, then inspect the PNGs in
`.webview-preview/screenshots/` (an image-capable model views them directly;
a text-only model would need a human, or a separate vision-capable pass, to
actually interpret them — this harness only *produces* the screenshots, it
doesn't itself judge correctness). This has already caught two real bugs
this way: a template Load leaking a stale parameter override into the newly
loaded job (`jobConfigPanel.ts`), and a non-idempotent client-side re-sort
in the Tool Setup favorite-toggle patch (section 6.3) — both fixed, see
`PLAN.md`'s Phase 12 section for full detail.

**If extending this harness**: keep `.vscodeignore` in sync with anything
new under `scripts/` or any new generated-output directory — this is the
exact category of mistake that already happened once.

**The crash gate (added v0.42.1).** For a full release, the harness only
*produced* screenshots — nothing actually asserted the panel's inline
script ran without throwing, so a v0.42.0 regression (an unguarded DOM
lookup, only reachable in a branch of Tool Setup's HTML this harness had
never rendered) shipped with every screenshot looking pixel-identical to a
healthy panel. `screenshot-webviews.mjs` now attaches `page.on('pageerror',
...)` and `page.on('console', ...)` listeners **before** `page.goto(...)`
(the panels' scripts are inline and run *during* navigation, so listeners
registered afterwards would miss the failure), collects failures into a
module-scope array keyed `name (theme)`, and sets `process.exitCode = 1` —
never `process.exit()`, since the `finally { browser.close() }` block must
still run. Console errors are gated too, not just uncaught exceptions: a
CSP violation blocking the whole inline script surfaces only as a
`console.error`, never a `pageerror`, and produces an equally inert panel.
`IGNORED_CONSOLE` is an explicit allowlist (empty by default) for any
console error that's expected/harmless — every entry needs its own
justification, never a blanket silence.

**State-coverage rule.** Every branch of a `renderHtml` conditional that
changes *which top-level element ids exist* must have its own rendered
state in `render-webviews.mjs`. A branch with no rendered state is a
branch whose script has never actually been executed by this harness —
exactly how the v0.42.0 crash went undetected. `render-webviews.mjs` now
renders 12 states across the 5 panels (up from 5), including
`toolSetup-pending` (the exact branch that crashed), `toolSetup-addvariant`
and `toolSetup-empty` (other never-rendered branches), `jobConfig-new` and
`jobConfig-nolists`, and `params-empty`. One of the sample value lists is
deliberately named `a</script>b` so the script-escaping fix (`jsonLit` in
`jobConfigPanel.ts`) stays covered permanently, not just at the moment it
was fixed.

**Usage as a gate**: `npm run webview-check` runs both scripts in sequence
and exits non-zero on any page error, in any rendered state, in either
theme. **Test the test before trusting it**: temporarily reintroduce an
unguarded `addBrowseButton($('nonexistent'), 'file')` at the top of
`toolSetupPanel.ts`'s inline script, confirm `webview-check` fails and
names `toolSetup-pending` among the failing states, then revert. A gate
never observed failing is not a gate.

**The browser-free sibling gate (added Phase 16, v0.43.0):**
`test-fixtures/run-webview-smoke-tests.mjs` applies the exact same
principle — bundle each panel with the same `--alias:vscode` shim trick,
execute its real `renderHtml` output's inline `<script>` for real, fail on
any uncaught error — but inside `jsdom` instead of headless Chromium, so
it needs no locally-cached browser and can run as a real, unattended CI
gate (`ci.yml`'s regression step already globs
`test-fixtures/run-*-tests.mjs`, so this needed zero workflow changes).
`acquireVsCodeApi` and a `window.addEventListener('error', ...)` collector
are stubbed via jsdom's `beforeParse(window)` option — the only hook that
runs before a classic inline `<script>` executes during
`runScripts: 'dangerously'` parsing (setting them after `new JSDOM(...)`
returns would be too late, same ordering constraint as
`screenshot-webviews.mjs`'s `page.on('pageerror')` needing to be
registered before `page.goto`). `jsdom` reports its own "not implemented"
browser-API stubs (e.g. `window.scrollTo`) as a `jsdomError` on a
`VirtualConsole` — filtered out by message text, since that's a jsdom
limitation, not a real script bug; a genuine thrown error still reaches
the `window` `error` event exactly like it would in a real browser, which
is what this gate actually asserts on. `jsdom` is a dev-only dependency
(`node_modules/**` is already vscodeignored, so nothing new ships).
Covers the same 12 states as `render-webviews.mjs`, verified as a real gate
the identical way: reintroduce the crash, confirm all five `toolSetup-*`
states fail and name the exact error, revert, confirm green.

This gate and the Playwright one are deliberately **not** merged into one:
the Playwright harness also produces the screenshots a human (or a
vision-capable model) inspects for actual visual regressions, which jsdom
fundamentally cannot do (no real layout/rendering engine) — jsdom only
ever proves the script didn't throw. Keep both; they check different
things.

### 8.4 CI / Release workflows

- **`.github/workflows/ci.yml`** (every push to any branch + every PR):
  `npm ci` → `npm run typecheck` → `npm run compile` → every
  `test-fixtures/run-*-tests.mjs` (glob loop) → `npx vsce package` (a dry
  run — never actually publishes). This is the full local verification
  sequence to run by hand before considering any change done:
  ```
  npm run typecheck
  npm run compile
  for f in test-fixtures/run-*-tests.mjs; do node "$f"; done
  npx vsce package --no-dependencies -o /tmp/some-path.vsix   # dry run, don't commit the .vsix
  ```
- **`.github/workflows/release.yml`** (triggered on pushing a tag matching
  `v*`): rebuilds, `vsce package`s, then creates-or-updates a GitHub Release
  for that tag with the built `.vsix` attached. This is **this (private)
  repo's own release mechanism** — entirely separate from the Marketplace
  publish flow (section 9), which runs from the OTHER (public) repo.

## 9. The two-repo Marketplace publishing setup

This is a manual, human-triggered (not automated in CI) process, but it's
worth understanding the shape even if you're never asked to run it:

- **This repo** (`vscode-verilog-manager`, private on GitHub) is where all
  the actual development happens — the messy iteration, `PLAN.md`/
  `STATUS.md`, `.github/`, `.claude/`. Its own `release.yml` (section 8.4)
  is unaffected by any of this.
- **A separate public repo**, `github.com/CaioPlazas/eda-job-runner`, local
  clone at `~/eda-job-runner-public` (a sibling directory, NOT nested inside
  this repo), is a clean release-only snapshot: source + `media/` +
  `examples/`/`sample-projects/`/`docs/`/`test-fixtures/` (all user-facing) +
  `README.md`/`CHANGELOG.md`/`LICENSE`/`package.json`. **Deliberately
  excludes** `PLAN.md`/`STATUS.md`/`.claude/`/`.github/` — this is the repo
  `vsce publish` actually runs from, and the one linked from the
  Marketplace listing's `repository`/`bugs`/`homepage` fields (this repo's
  own `package.json` mirrors those same URLs, so both repos' user-facing
  links point at the same public place).
- **Sync is manual, not automated**: `rsync -a --exclude node_modules/
  --exclude dist/ --exclude '*.vsix' --exclude .git/ --exclude .claude/
  --exclude .github/ --exclude PLAN.md --exclude STATUS.md --exclude
  .webview-preview/ ./ ~/eda-job-runner-public/`, then reapply the public
  clone's own `package.json`-only fields that rsync always overwrites
  (`galleryBanner`, `keywords` — `repository`/`bugs`/`homepage`/`icon` are
  actually IDENTICAL in both repos already, no reapplication needed for
  those), update `CHANGELOG.md`, verify (typecheck/tests/compile/package)
  in the public clone too, commit, `git tag vX.Y.Z`, push, `gh release
  create vX.Y.Z *.vsix --repo CaioPlazas/eda-job-runner`, then `npx vsce
  publish --pre-release` from that clone.
- **Published pre-release channel ONLY** — by explicit standing user
  instruction, never publish a non-pre-release version of this extension
  unless told otherwise.
- **`vsce unpublish` deletes the ENTIRE Marketplace listing** (all versions,
  reviews, install counts) — there is no per-version removal via the CLI. A
  bad version should be superseded by a corrected higher version instead
  (Marketplace serves the highest version to pre-release opt-ins), not
  unpublished.
- Before assuming any of this needs doing, **check actual state directly**
  (`git tag`, `gh run list --workflow=release.yml`, `npx vsce show
  CaioPlazas.eda-job-runner`) rather than trusting a possibly-stale claim in
  `STATUS.md` about what has or hasn't been published — this has been wrong
  before (a `STATUS.md` note claimed a whole batch was still unpublished
  when it had, in fact, already gone out).

## 10. House conventions worth internalizing before editing anything

These are the load-bearing idioms that show up over and over. Following them
is what keeps a change looking like it belongs in this codebase rather than
bolted on.

1. **Extract decision logic into a pure, `vscode`-free module whenever
   possible**, and give it a `test-fixtures/run-*-tests.mjs` harness (section
   8.2). This is the single highest-value habit in this codebase.
2. **Read config fresh on every use, never cache it at construction time** —
   every `vscode.workspace.getConfiguration('eda-job-runner', ...)` call
   happens right where the value is needed, so a `settings.json` edit takes
   effect on the very next relevant action with no window reload required.
3. **A field is only stored in JSON when it differs from the default** — the
   common pattern throughout `normalize()`/`updateJob`/message-building code
   is `value.trim() || undefined`, so the on-disk file stays minimal and
   `undefined` consistently means "use the default," never a separately
   -tracked boolean.
4. **A user-supplied regex is always compiled case-insensitively and never
   allowed to throw** — `compilePattern()`/`compileSeedPattern()`'s shape
   (trim → blank check → `try/catch` around `new RegExp(...)` → return
   `undefined` on failure) is copy-pasted intentionally rather than shared,
   but should stay consistent if you add another user-regex field.
5. **Cap anything that reads a user-controlled or potentially-huge input**:
   `SCAN_OUTPUT_CAP`, `TEST_OUTPUT_CAP`, `LIST_FILE_CAP`, `HEAD_TAIL_CAP`,
   `SEARCH_FILE_CAP`, `MAX_LIST_VALUES`, `MAX_STORED_ISSUES`,
   `CUSTOM_PATTERN_TEXT_CAP`, `MAX_LANES_PER_JOB`, `HEAD_TAIL_CACHE_CAP` —
   every one of these exists because an unbounded version of that operation
   was identified as a real hang/memory/perf risk. When adding a new
   "read/process something workspace- or user-controlled" path, ask whether
   it needs the same treatment.
6. **Bound every spawned child process with a timeout and clean it up on
   panel/extension disposal** — `runProbe`'s `SCAN_TIMEOUT_MS`,
   `shellEnvPanel.ts`'s `TEST_TIMEOUT_MS`, `jobRunner.ts`'s
   `POST_RUN_TIMEOUT_MS` all SIGKILL on expiry; each panel/class that owns a
   child process kills it in its own `cleanup()`/`dispose()`. The one
   deliberate exception is the job's own main child process, which is
   intentionally left running detached across a window reload/close (section
   5.4.8) — don't "fix" that into also being killed on dispose.
7. **Never call a full webview re-render for a high-frequency interaction**
   if a targeted client-side DOM patch is feasible — see section 6.3's
   favorite-toggle pattern as the template to follow, including its
   `data-orig-idx` idempotency trick if the patch involves reordering. In a
   list the user can type-filter, also delegate the row listener to the
   container instead of wiring one per row, and debounce the text input.
7b. **Charge a budget *before* doing the work it bounds, not after** — see
   5.4.6. A cap computed from the result of an expensive operation documents
   the cost instead of preventing it.
7d. **Never put anything self-changing into a rendered surface that has to be
   rebuilt wholesale to update.** A tree row's text, a status string baked
   into a webview's HTML — if it contains a clock or a counter, keeping it
   honest means repainting the whole surface on a timer, which the user sees.
   Put live values where updating is cheap and local (a single status-bar
   item, a tooltip resolved on hover via `resolveTreeItem`, a targeted DOM
   patch) and leave the rebuilt surface static. See 5.5 and `statusText.ts`.
7c. **Any state that can only be left by closing a panel or reloading the
   window is a bug, not an edge case.** The recurring shapes to check for
   when adding code here: a guard flag set before an `await` with no
   `finally` to clear it (`saving`, `probing`, `finalizing`); a cleanup step
   written as the last statement of a long `async` method rather than in a
   `finally` (see 5.4.5); a client-side overlay whose only teardown is the
   next successful render (6.1); and a `void`ed async call with no `.catch`,
   which makes all of the above invisible when they happen.
8. **When embedding data into an inline `<script>` block, always
   `.replace(/</g, '\\u003c')` the JSON-stringified payload.**
9. **Never special-case a specific EDA tool's name or CLI syntax** anywhere
   outside of `logParser.ts`'s *output-format* recognition (which is about
   parsing text shapes, not about knowing how to invoke any tool). If a new
   feature seems to need "if the tool is Questa, do X," it almost certainly
   means the feature needs a new generic, user-configurable primitive
   instead (a regex field, a value list, a template) — this is the
   tool-agnostic-core locked decision from `PLAN.md`.
10. **Keep `PLAN.md`/`STATUS.md`/`CHANGELOG.md` (and this file, if the change
    is architectural) updated alongside the code**, and follow the existing
    commit/tag/release cadence described in `STATUS.md`'s "Working
    agreement" — one git commit per meaningful change/release, a tag per
    release (`vX.Y.Z`), never hand-build and attach a VSIX yourself (the tag
    push triggers `release.yml` to do that automatically for this repo; the
    public repo's own release is the manual sequence in section 9).
