# EDA Job Runner

A tool-agnostic sidebar for running and tracking EDA compile/simulation
jobs (Xcelium, Questa, or any custom Makefile/script) without leaving
VS Code. Built for ASIC/RTL engineers working over Remote-SSH on Linux
build servers.

The extension has no built-in knowledge of any specific EDA tool — a job
is just a shell command and a working directory. It adds value around
*running, tracking, and reading the output* of that command: a sidebar
list of jobs, one-click run/stop, per-job status, and logs you can open
without leaving the editor.

See [PLAN.md](PLAN.md) for the full phased implementation plan.

## Status: Phase 4 (alpha)

Currently implemented:

- Activity bar view listing jobs defined in `.vscode/eda-jobs.json`
- Add / configure / duplicate / delete jobs from the sidebar. Add
  (`+` button) and Configure (right-click a job) both open a form in a
  normal editor tab — Name / Command / Working Directory, with a Save
  and Cancel button — rather than a sequence of quick-pick prompts
  where a stray Enter can commit the wrong thing
- **Folders** — group related jobs under a named folder in the sidebar
  (e.g. "Compile", "Simulation ADDER"), a single flat level (not nested).
  The folder icon in the view title adds one; a job's Configure form has
  a **Folder** field (type an existing name or a new one — new names
  create the folder) and a job's right-click menu has **Move to
  Folder...** for quick reassignment without opening Configure. A folder
  itself can be renamed or deleted from its own right-click menu —
  deleting a folder never deletes its jobs, they just move back to the
  top level. Jobs with no folder show flat at the top, exactly as before
  this feature existed.
- **Drag a job to reorder it** in the sidebar — within its folder, into a
  different folder, or back out to the root/ungrouped list. Additive to
  "Move to Folder...", not a replacement for it.
- Mark one job per workspace as the **default job** (checkbox in the
  configure form). Run it any time with the **EDA: Run Default Job**
  command, or just press **F5** — while a default is set, F5 runs it
  instead of starting the debugger (only in workspaces that have one, so
  debugging is untouched elsewhere; press F5 again mid-run does nothing
  new since only one job runs at a time). The default is stored per
  workspace in `.vscode/eda-jobs.json`, so the same F5 runs a different
  job in each project.
- `.vscode/eda-jobs.json` is hand-editable — the sidebar stays in sync
  with external edits via a file watcher
- Run / stop jobs from the sidebar (▶ / ■). Jobs run in the configured
  shell, invoked per shell family so `module load`, sourced dotfiles, and
  license env vars are available — bash/zsh as a login shell (`-lc`),
  tcsh/csh as `-c` (which still sources `~/.tcshrc`/`~/.cshrc`). The shell,
  its arguments, and extra environment variables are all configurable (see
  the **Shell & Environment** panel — the terminal icon in the EDA Jobs
  view — which can also copy your VS Code terminal shell in one click).
  Jobs also run in their own process group, so **Stop** sends
  SIGTERM to the whole `make → shell → simulator` tree (SIGKILL after a
  configurable grace period if it doesn't exit) — this is what actually
  frees the EDA license instead of leaving an orphaned simulator behind.
  Only one job runs at a time by default (license pressure) — Run is
  disabled on other jobs while one is active, unless you turn on
  **Experimental: multiple jobs** (see below).
- **Experimental: multiple concurrent jobs.** Turn on
  `eda-job-runner.experimentalMultipleRuns` to lift the one-job-at-a-time
  restriction — run `testA` and `testB` at once, or start a second
  instance of the *same* job while the first is still going. A job with
  more than one run tracked at once becomes an expandable group in the
  sidebar (▷ icon) instead of a flat row, with each run shown underneath
  and its own Stop/Open Log; "Stop All Runs" stops every lane at once.
  This is in-memory/live-session only — the extra lanes don't survive a
  window reload the way the primary run does (Known limitation, below).
- **Repeat count (sequential).** A job's Advanced settings (in its
  Configure form) include a **Repeat count**: run it N times in a row —
  e.g. 10 back-to-back runs of the same test with a random seed — one
  after another, never in parallel, and always sequential regardless of
  the experimental setting above. Also renders as an expandable group so
  you can see each iteration's own pass/fail, not just the last one.
- **Parametrized runs.** A job's Command can use `${param:NAME}` (or
  `${param:NAME=default}`) to prompt for a value on every Run — remembering
  the last value entered per job+name as next time's default — and
  `${randomSeed}` to fill in a fresh random integer on every actual spawn
  with no prompt at all, including every iteration of a repeat-count batch,
  so "10 runs with a random seed" needs no hand-editing between runs.
  Right-click a job (or one run inside a group) → **Re-run Last** replays
  that exact prior resolved command verbatim — no new prompt, no fresh
  seed, always a single run — to reproduce one specific prior run (e.g.
  chase a failing seed) exactly. A job using neither placeholder is
  completely unaffected.
- Per-job status (idle / running with live elapsed time / passed /
  failed with exit code / killed), persisted across window reloads
- Full stdout/stderr streamed straight to a log file per run (never
  buffered in memory), with a configurable size cap so a runaway job
  can't fill the disk — capture stops, the job keeps running. ANSI color
  codes are stripped by default so logs read cleanly as plain text.
- Click a job to open its Configure form; click the 📄 icon (or a run
  inside an expanded group) to open its log as a plain editor tab. Older
  run logs are pruned automatically past a configurable count.
  Right-click → "Open Log History..." to browse and open any past run,
  not just the latest.
- Right-click a running job → "Follow Running Log" to auto-scroll its
  open log tab as new output arrives
- **Live Log (tail)** — the ⚡ action (or right-click → "Live Log")
  streams a job's output into a viewer in real time, actively pushed as
  bytes land rather than waiting on the editor's passive disk-reload. For
  jobs that **detach to a farm** (LSF `bsub -o` / SGE `qsub -o`), set the
  job's *Live log file to tail* to the scheduler's output file and the
  viewer streams the real job output straight from there (polling-based,
  so it works over NFS where inotify doesn't). See
  [Real-time logs & schedulers](#real-time-logs--schedulers).
- A status bar item shows the currently running job with live elapsed
  time; click it to jump to the sidebar. A notification appears when a
  job passes or fails, with an "Open Log" action on failure.
- Workspace-level environment setup: a sourced script and/or literal
  shell commands, run before every job
- **Post-setup working directory.** The Shell & Environment panel has a
  field for the directory a job's shell starts in — after its own
  startup (sourcing `.bashrc`/`.zshrc`/`.cshrc`) and before workspace
  setup and the job's command run. A job's own Working Directory then
  resolves against this instead of the workspace root, for sites where
  the real EDA run tree (and its tool-load setup) lives outside the
  folder you have open in VS Code. A job can override it individually in
  its Advanced settings.
- `.eda-runner/` (where logs live) is offered for auto-add to your
  workspace's `.gitignore` the first time a job runs, so logs never get
  committed
- **Error/warning parsing into the Problems panel.** A job's output is
  scanned for UVM messages (`UVM_ERROR`/`UVM_WARNING`/`UVM_FATAL`) and
  common compile errors (Questa, Icarus, DSim, Verilator). Located ones
  become clickable diagnostics in the Problems panel; the per-job
  error/warning count shows in the sidebar (`· 2✗ 1⚠`) and status bar, live
  as output streams. The end-of-run summary row (e.g. `UVM_ERROR :    N`,
  or Verilator's `%Error: Exiting due to N error(s)`) is deliberately
  excluded so it can't inflate the count. Crucially, because EDA
  simulators exit 0 even on a failed UVM test, a job whose log contains
  real errors is marked **failed** regardless of exit code
  (`failOnLogErrors`, default on). Every pattern is validated against
  captured real tool output ([test-fixtures/](test-fixtures/),
  `run-parser-tests.mjs`). A per-job **"Scan output for errors/warnings"**
  checkbox turns this off as a safeguard for a tool the built-in patterns
  misread.
- **Fail pattern / Pass pattern — tool-agnostic pass/fail overrides.** A
  job's Advanced settings can set a **Fail pattern** and/or **Pass
  pattern** (case-insensitive regexes matched against every output line)
  for a tool whose own real verdict isn't exit code or one of the four
  built-in error patterns above — e.g. a custom script that prints
  `TEST RESULT: FAIL`/`PASS` on its own summary line. A **Fail pattern**
  match marks the job failed even on exit 0; a **Pass pattern**, when set,
  fully governs the outcome — passed only if it appears at least once
  (ignoring exit code, for tools that always exit non-zero even on
  success), failed if it never does. Both work independently of "Scan
  output for errors/warnings," and a Fail pattern match always wins over a
  Pass pattern match. The decision logic itself lives in a small, pure,
  unit-tested module (`jobOutcome.ts`, `run-decide-tests.mjs`) so the exact
  precedence is verified, not just described.
- A tool-agnostic [examples/](examples/) test workspace with mock
  UVM-shaped bash scripts (no EDA tool needed), plus two larger
  [sample-projects/](sample-projects/) — a synthesizable multi-module
  UART subsystem with a self-checking testbench, and a full UVM ALU
  environment — both verified on the real installed tools.
- **Tool Setup — a checkbox GUI builder for a job's Command.** The wrench
  icon in the EDA Jobs view opens a panel where you register a run
  script's command (e.g. `run_simulation.py` or a full path); its
  `--help` output is scanned into a list of flags, cached in
  `.vscode/eda-tools.json`, and re-scanned automatically on every window
  reload in case the tool's own flags changed. In a job's Configure form,
  pick that tool under **Tool builder** and each discovered flag becomes
  a checkbox (plus a value field for flags that take one, e.g. `--seed`)
  — checking one writes it into the Command field live. A dispatcher
  script whose flags depend on a first "which mode" choice (e.g. a
  `compile` sub-command taking different flags than a `regression`
  sub-command) is handled too: argparse subparsers are auto-detected as
  selectable **variants**, each scanned and built independently, with
  manual variant entry as a fallback for tools that dispatch on a flag
  instead of a sub-command. A hand-edit to
  the Command field always wins — the builder stops writing to it until
  you click "Sync command from builder" — so the two can coexist without
  the builder ever clobbering something you typed by hand. Star a flag in
  Tool Setup to mark it a **favorite** — favorites surface at the top of
  the builder (with the rest collapsed underneath), so a tool with a large
  flag set doesn't turn into a long scroll; the starred state survives a
  rescan. An already-registered tool's command/help-argument can be edited
  in place, and its variants added or removed individually, without
  removing and re-adding the whole tool. Parsing targets generic
  GNU/argparse/click `--help` conventions and is best-effort/tool-agnostic;
  verified primarily against Python (argparse/click) output, the common
  case for in-house run scripts.
  Nothing about this changes the tool-agnostic core — a job is still just
  `{name, command, cwd}`; the builder only assists composing `command`.
- **Choices dropdown.** A value-taking flag whose metavar is an argparse
  `choices=` brace list (e.g. `--tool {qrun,dsim}`) renders as a `<select>`
  in the builder instead of free text — no guessing at the valid values.
- **Test-list dropdowns.** A tool in Tool Setup can carry named value
  lists (e.g. "Test"), each read from a command's stdout or a file, with
  an optional regex to extract the value and an insert template
  (`${value}`, default bare) so no tool's flag syntax is assumed. A job's
  builder shows one dropdown per list; a per-job override lets one job
  insert a picked value differently from another sharing the same tool.

**Known limitations:**
- If VS Code reloads the window (or the extension host restarts) while a
  job is running, the sidebar shows it as "running (detached)" — we've
  lost the process handle and its live output, but we still know its
  pid, so **Stop still works**. We just can't tell when it finishes on
  its own; check its log directly, or stop it and re-run. Full
  reattachment (resuming live output capture) remains future work.
- The *extra* lanes of a multi-run group (concurrent extra instances, or
  a repeat-count batch's history of past iterations) are tracked in
  memory only — they don't survive a window reload the way the primary
  run's "running (detached)" state does. A window reload mid-batch loses
  the group's history (each lane keeps running underneath regardless;
  only the sidebar's memory of the group is lost).
- A concurrent extra instance of a job doesn't get its own Problems-panel
  entries — only the job's primary/most-recent run does, to avoid two
  simultaneous runs of the same job fighting over the same diagnostics.

**Platform:** the extension targets POSIX shells on Linux/macOS build
servers (including the remote host over Remote-SSH). **Stop** relies on
POSIX process groups (`kill(-pid)`) and `/proc` liveness, and the
workspace setup chain (sourced script + pre-commands joined with `&&`)
assumes a POSIX or csh-family shell. Windows shells (cmd/PowerShell) can
be launched via `shellArgs`, but Stop and setup chaining are not
supported there.

## Real-time logs & schedulers

The captured log (`.eda-runner/logs/…`) is fed from the job process's
stdout/stderr pipe. Two things affect how "live" it feels, and the **Live
Log (tail)** viewer plus a per-job setting address them:

- **Block buffering.** When a tool's stdout is a pipe rather than a
  terminal, it typically switches from line- to block-buffering, so output
  arrives in delayed bursts. Prefix the command with `stdbuf -oL -eL`
  (or `unbuffer`) to force line buffering for snappier logs.
- **Detached scheduler jobs.** `bsub … make sim` / `qsub …` that return as
  soon as the job is queued run on a farm host and write output to their
  own `-o/-e` file — those bytes never reach our pipe, so the captured log
  stops after the submission message. Two ways to see the real output:
  - **Blocking/interactive submit** (`bsub -I` / `-Is` / `-K`,
    `qsub -sync y`) keeps output flowing through the pipe for the whole
    run — capture, Problems parsing, and pass/fail all work as normal.
  - **Point the Live Log at the farm file:** set the job's *Live log file
    to tail* (config form, or `logFile` in `eda-jobs.json`) to the
    scheduler's output file — use a **fixed** `-o` filename (e.g.
    `bsub -o run.log`), not a `%J`/`$JOB_ID` pattern, so the path is known
    up front. The viewer tails it live. Note: with a fully
    detached submit, pass/fail status still reflects the *submit* process,
    not the farm job — use a blocking submit if you need accurate status.

## Job file format

Jobs live in `.vscode/eda-jobs.json` in your workspace root:

```jsonc
{
  "version": 1,
  "setup": {
    "script": "scripts/env_setup.sh",          // sourced before every job (optional)
    "commands": ["module load xcelium/24.03"]  // and/or literal commands (optional)
  },
  "folders": ["Compile", "Simulation ADDER"],   // sidebar folders (optional, flat -- not nested)
  "jobs": [
    { "id": "...", "name": "Compile TB", "command": "make compile", "cwd": "sim",
      "folder": "Compile" },
    { "id": "...", "name": "smoke_test", "command": "make sim TEST=smoke_test", "cwd": "sim",
      "default": true, "parseProblems": true },
    { "id": "...", "name": "regress (LSF)", "command": "bsub -o run.log make regress", "cwd": "sim",
      "logFile": "run.log" },  // Live Log tails this farm output file (use a fixed -o name, not %J)
    { "id": "...", "name": "regress_seeds", "command": "make sim TEST=regress SEED=random", "cwd": "sim",
      "runCount": 10 }   // 10 sequential runs, one after another, on Run
  ]
}
```

`cwd` is relative to the workspace root (`.` for the root itself) —
or to `postSetupCwd` (below) when that's set. `id` is generated
automatically — don't set it by hand. `default` (at most one job) marks
the F5 / "Run Default Job" target; `parseProblems: false` turns off
error/warning scanning for that job; `failPattern` / `passPattern`
(case-insensitive regexes matched per output line, tool-agnostic) override
pass/fail from the tool's own summary lines and work even with
`parseProblems` off — a `failPattern` match marks the job failed even on
exit 0, and a `passPattern` marks it passed only if the signal appears
(failed if it never does); `runCount` (>1) makes Run execute
the job that many times in a row, sequentially; `postSetupCwd` overrides
the workspace-wide post-setup directory for this job only; `folder`
groups the job under one of the top-level `folders` entries (a name not
present there is treated as ungrouped); `toolId` /
`toolVariantLabel` remember which registered tool (and sub-tool variant)
the Configure form's **Tool builder** should show for this job — a UI
convenience only, set by picking a tool in that dropdown, never
hand-edited; `listInsertOverrides` (keyed by a tool list's name) lets this
job insert a picked test-list value with its own template instead of the
tool's default one; `command` above is still what actually runs
regardless. All of these are normally set via the configure form or the
sidebar's Folder commands, not by hand. Logs are written to
`.eda-runner/logs/<job-id>/` in your workspace, offered for auto-add to
your `.gitignore` the first time a job runs.

Registered tools live separately, in `.vscode/eda-tools.json` — see
**Tool Setup** above; that file is managed entirely through its own panel,
not typically hand-edited either.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `eda-job-runner.shellPath` | `bash` | Shell used to run jobs (name on PATH or absolute path). Invocation is chosen per shell family — bash/zsh `-lc`, tcsh/csh `-c` |
| `eda-job-runner.shellArgs` | `null` (auto) | Override the shell argument vector. Put `${command}` where the command goes (appended if absent). E.g. `["-c", "${command}"]` for csh sites |
| `eda-job-runner.env` | `{}` | Extra environment variables merged into every job. Supports `${workspaceFolder}` and `${env:NAME}` |
| `eda-job-runner.postSetupCwd` | `""` | Directory a job's shell starts in (its Working Directory then resolves against this instead of the workspace root). Supports `${workspaceFolder}`/`${env:NAME}`. A job can override it individually |
| `eda-job-runner.experimentalMultipleRuns` | `false` | **Experimental.** Allow more than one job — or more than one instance of the same job — to run at once, instead of one-job-at-a-time |
| `eda-job-runner.killGracePeriodSeconds` | `5` | Wait time after SIGTERM before SIGKILL |
| `eda-job-runner.logMaxSizeMB` | `200` | Per-run log capture cap |
| `eda-job-runner.logRetentionCount` | `20` | Past runs kept per job |
| `eda-job-runner.stripAnsiCodes` | `true` | Strip ANSI color/cursor codes from captured output |
| `eda-job-runner.failOnLogErrors` | `true` | Mark a job failed when its log has errors, even if it exited 0 |

## Try it

- **No EDA tool needed:** open [examples/](examples/) as its own VS Code
  workspace — mock jobs (pass, fail, killable long-runner, truncation
  stress test) that exercise every feature. See
  [examples/README.md](examples/README.md).
- **Bigger, real designs:** [sample-projects/](sample-projects/) has a
  multi-module UART subsystem (`uart_soc`, runs on Icarus/Verilator/
  Questa/DSim) and a full UVM ALU environment (`uvm_alu`, runs on DSim) —
  each its own workspace. The UVM project's `+BUG` job is the best way to
  watch real `UVM_ERROR`s land in the Problems panel. Requires the
  relevant tools installed ([docs/eda-tools-setup.md](docs/eda-tools-setup.md)).

## Development

```bash
npm install
npm run compile   # or `npm run watch` for incremental builds
```

Then press F5 in VS Code to launch an Extension Development Host.

To package a `.vsix`:

```bash
npm run package
```
