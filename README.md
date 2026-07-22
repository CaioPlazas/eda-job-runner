# EDA Job Runner

A VS Code sidebar for running and tracking EDA compile/simulation jobs —
Xcelium, Questa, DSim, Icarus, Verilator, or any in-house script — without
leaving the editor or losing your place in a terminal scrollback.

## Why this exists

ASIC/RTL work usually happens over Remote-SSH, on a shared build server,
against tools that were never designed with an IDE in mind. In practice
that means: a terminal tab per job, `bsub`/`qsub` output you have to go
find, `tail -f` on a log file whose name you have to remember, a simulator
that keeps a license checked out even after you think you killed it, and
a UVM run that exits 0 while its log is full of `UVM_ERROR`. None of that
is a tooling problem the simulator vendor is going to fix — it's a
workflow problem, and a workflow problem is exactly what an editor
extension is good at.

The extension is deliberately **tool-agnostic**. It has no built-in
concept of Xcelium, Questa, or any other simulator — a job is just a name,
a shell command, and a working directory. Everything the extension adds
value on top of that is generic: running the command, watching it, killing
it cleanly, and helping you read what it printed. That constraint is load-
bearing, not incidental — it's what lets the same extension work at a site
running DSim and at a site running Xcelium without either one needing a
plugin.

## What it does

**A sidebar list of jobs**, defined per workspace and hand-editable at
`.vscode/eda-jobs.json` (the sidebar and the file stay in sync both ways).
Add one, configure it in a real editor tab — not a sequence of quick-pick
prompts where a stray Enter commits the wrong thing — and run it with a
click. Jobs can be grouped into flat folders, dragged to reorder, marked
default (F5 runs it), and a folder itself can be run top to bottom with
one click.

**Running is careful about how EDA tools actually behave.** The shell is
invoked per shell family (bash/zsh as a login shell so `module load` and
site dotfiles are available; tcsh/csh accordingly) and every job spawns in
its own process group, so Stop sends the kill signal to the whole
`make → shell → simulator` tree instead of leaving an orphaned simulator
holding a license. Only one instance of a job can ever run at a time —
its own **Repeat count** is the only way to run it again, always
sequentially — though two *different* jobs can run side by side if you
opt into it.

**Parametrized runs** let a job's command use `${param:NAME}` to prompt
for a value on every run (remembering the last one you typed) and
`${randomSeed}` to fill in a fresh seed on every actual spawn with no
prompt at all — so "run this test 10 times with a different seed" needs
no hand-editing between runs, and **Re-run Last** replays one exact prior
run verbatim when you need to chase a specific failing seed.

**Parameters** are a different, quieter kind of placeholder for values
that shouldn't need a prompt at all — a shared testbench path, say. The
Parameters panel (a third view-title icon) holds global name/value pairs;
referencing one in a job's command as `${var:NAME}` resolves it silently,
every run, from whatever's currently configured. `${param:...}` and
`${var:...}` are independent and can be mixed freely in the same command.

**Output is scanned, not just captured.** Full stdout/stderr streams to a
log file per run (never buffered in memory, size-capped, ANSI-stripped),
and simultaneously fed to a line parser that recognizes UVM messages and
common compiler error formats, turning them into clickable entries in the
Problems panel. Because a simulator's exit code often has nothing to do
with whether the test actually passed, a job whose log contains real
errors is marked **failed** regardless of exit code — and for a tool whose
pass/fail signal is neither the exit code nor one of the built-in
patterns, a job can set its own **Fail pattern** / **Pass pattern** (a
plain regex matched against every output line), which is the tool-agnostic
escape hatch for literally anything that prints its own verdict.

**Live Log** tails a running job's output in real time, including jobs
that detach to a farm scheduler (`bsub -o`/`qsub -o`) — point it at the
scheduler's output file and it polls that instead, which also works over
NFS where filesystem-change notifications don't.

**Tool Setup** is a GUI builder for a job's Command field, for the common
case of an in-house run script with a large flag set nobody wants to
memorize. Register the script; the extension runs its `--help` and parses
the output into a list of checkable flags (favorites float to the top,
everything is searchable/filterable); checking one writes it into the
Command field live. A dispatcher script whose flags depend on a first
"which mode" argument is handled too — argparse-style sub-commands are
auto-detected as selectable variants, each scanned independently. A value
list (say, a list of available tests, sourced from a file or a command's
own output) can attach to a specific flag as its dropdown of legal values.
None of this changes what a job actually *is* — the builder only assists
composing a plain shell command string, and a hand-edit to that field
always wins over the builder.

## How it's put together, under the hood

The extension is a single bundled TypeScript file (esbuild → CJS,
targeting old `vscode` engine versions so it works on the ancient VS Code
Server builds some Remote-SSH hosts are stuck on) with no native
dependencies and no `node-pty` — jobs are spawned with plain `child_process`,
detached, in their own process group, and killed with `kill(-pid,
SIGTERM)` then `SIGKILL` after a grace period. That's the whole trick
behind clean license release: it has nothing to do with the simulator and
everything to do with signaling the right process group.

Two design choices show up everywhere else in the codebase:

- **The core is pure, the shell is thin.** Anything that's actually a
  decision — how to reorder a dragged job, how to decide pass/fail from a
  regex match plus an exit code, how to parse an argparse `--help` block,
  how to substitute a `${param:...}` placeholder — lives in a small module
  with zero `vscode` import, so it can be unit-tested with a plain Node
  script instead of a VS Code extension host. `src/*.ts` pure modules pair
  with a `test-fixtures/run-*-tests.mjs` harness each (esbuild-bundle to a
  temp file, `import()` it, assert). The `vscode`-dependent code — tree
  views, webviews, command registration — is orchestration only, calling
  into logic that's already been checked.
- **Regex-based, not tool-specific.** The built-in error/warning patterns
  (UVM messages, a handful of common compiler formats) are all just
  regexes tested against real captured tool output, not calls into any
  simulator's API — because there isn't one, and there won't be a
  consistent one across vendors. Every built-in pattern is validated
  against a fixture file of real tool output committed alongside the
  parser, and the fail/pass-pattern override exists specifically so a
  tool the built-in patterns get wrong isn't a dead end.

Job configuration and Tool Setup are VS Code webviews — a form in a real
editor tab, CSP-locked with a nonced script, talking back to the extension
host over `postMessage`. State (the job list, folders, registered tools)
is a hand-editable JSON file per workspace, watched for external edits, so
nothing about the extension's data is locked inside VS Code's own storage.

## How this was built

This extension was vibe-coded — a **Claude** instance acting as the
architect/orchestrator (reading the actual current source before
proposing a design, breaking work into reviewable batches, writing the
plan, doing the trickier edits itself) paired with a **Qwen3.6** model
running locally for a lot of the mechanical implementation work. Nearly
every feature above went through a real build-test-verify loop before
being called done — typecheck, the unit-test harnesses, a packaged VSIX —
but "verified" here mostly means verified by an AI reading its own output
and captured tool logs, not by exhaustive human QA on every code path.
If something looks or behaves oddly, that's the most likely reason, and
an issue report is genuinely useful.

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

`cwd` is relative to the workspace root (`.` for the root itself) — or to
`postSetupCwd` (Shell & Environment panel) when that's set. `id` is
generated automatically; everything here is normally set through the
Configure form or the sidebar's folder commands, not hand-edited, though
the file itself is plain JSON and safe to touch directly (the sidebar
picks up external edits via a file watcher). Registered tools for Tool
Setup live separately, in `.vscode/eda-tools.json`, managed entirely
through its own panel.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `eda-job-runner.shellPath` | `bash` | Shell used to run jobs (name on PATH or absolute path). Invocation is chosen per shell family — bash/zsh `-lc`, tcsh/csh `-c` |
| `eda-job-runner.shellArgs` | `null` (auto) | Override the shell argument vector. Put `${command}` where the command goes (appended if absent). E.g. `["-c", "${command}"]` for csh sites |
| `eda-job-runner.env` | `{}` | Extra environment variables merged into every job. Supports `${workspaceFolder}` and `${env:NAME}` |
| `eda-job-runner.postSetupCwd` | `""` | Directory a job's shell starts in (its Working Directory then resolves against this instead of the workspace root). Supports `${workspaceFolder}`/`${env:NAME}`. A job can override it individually |
| `eda-job-runner.experimentalMultipleRuns` | `false` | **Experimental.** Allow more than one *different* job to run at the same time. A single job can never run concurrently with itself either way — its own **Repeat count** is the only way to run it again, always sequentially |
| `eda-job-runner.experimentalAutoSaveJobConfig` | `false` | **Experimental.** Auto-save a job's Configure form as you edit, instead of requiring an explicit Save click |
| `eda-job-runner.killGracePeriodSeconds` | `5` | Wait time after SIGTERM before SIGKILL |
| `eda-job-runner.logMaxSizeMB` | `200` | Per-run log capture cap |
| `eda-job-runner.logRetentionCount` | `20` | Past runs kept per job |
| `eda-job-runner.stripAnsiCodes` | `true` | Strip ANSI color/cursor codes from captured output |
| `eda-job-runner.failOnLogErrors` | `true` | Mark a job failed when its log has errors, even if it exited 0 |

## Real-time logs & schedulers

The captured log is fed from the job process's stdout/stderr pipe, which
has two practical wrinkles the **Live Log** viewer and a per-job setting
exist to work around:

- **Block buffering.** A tool's stdout typically switches from line- to
  block-buffering once it's writing to a pipe instead of a terminal, so
  output arrives in delayed bursts. Prefix the command with `stdbuf -oL
  -eL` (or `unbuffer`) to force line buffering back on.
- **Detached scheduler jobs.** `bsub … make sim` / `qsub …` that return as
  soon as the job is queued run on a farm host and write to their own
  `-o`/`-e` file — those bytes never reach the pipe this extension reads,
  so capture stops after the submission message. Either submit blocking
  (`bsub -I`/`-Is`/`-K`, `qsub -sync y`), which keeps everything flowing
  through the normal pipe, or set the job's **Live log file to tail** to
  the scheduler's output file (use a *fixed* `-o` filename, not a
  `%J`/`$JOB_ID` pattern) and Live Log will poll that file directly. With
  a fully detached submit, pass/fail status still reflects the submit
  process, not the farm job — use a blocking submit if you need accurate
  status.

## Known rough edges

If the extension host restarts (a window reload, or VS Code itself
restarting) while a job is running, the sidebar shows it as "running
(detached)" — the live output stream and the "it just finished" event are
both gone, though **Stop still works** since the process id is still
known. Full reattachment (resuming live capture) is still on the backlog.
A repeat-count batch's per-iteration history is in-memory only and doesn't
survive a reload either, though the jobs themselves keep running
regardless. The extension targets POSIX shells on Linux/macOS (including
over Remote-SSH); a Windows shell can be pointed at via `shellArgs`, but
Stop and the setup-script chaining aren't supported there.

## Try it

- **No EDA tool needed:** open [examples/](examples/) as its own VS Code
  workspace — mock jobs (pass, fail, killable long-runner, truncation
  stress test) that exercise every feature. See
  [examples/README.md](examples/README.md).
- **Bigger, real designs:** [sample-projects/](sample-projects/) has a
  multi-module UART subsystem (`uart_soc`, runs on Icarus/Verilator/
  Questa/DSim) and a full UVM ALU environment (`uvm_alu`, runs on DSim) —
  each its own workspace. Requires the relevant tools installed
  ([docs/eda-tools-setup.md](docs/eda-tools-setup.md)).

## Install

Published on the VS Code Marketplace as
[EDA Job Runner](https://marketplace.visualstudio.com/items?itemName=CaioPlazas.eda-job-runner)
(`CaioPlazas.eda-job-runner`), **pre-release channel only** — click
"Switch to Pre-Release Version" on the Marketplace page, or install from
the Extensions view and use its "Switch to Pre-Release Version" action.

## Development

```bash
npm install
npm run compile   # or `npm run watch` for incremental builds
```

Press F5 in VS Code to launch an Extension Development Host. To package a
`.vsix`: `npm run package`.
