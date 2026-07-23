# EDA Job Runner

Run and track your EDA compile/simulation jobs — Xcelium, Questa, DSim,
Icarus, Verilator, or any in-house script — from a VS Code sidebar, without
juggling terminal tabs or hunting for the right log file.

The extension has **no built-in knowledge of any specific tool.** A job is
just a name, a shell command, and a working directory — everything else it
does (running, killing cleanly, parsing output, tracking history) is
generic. That's deliberate: the same extension works whether your site runs
DSim, Xcelium, or a homegrown `sim_run.py`.

## Install

Search **"EDA Job Runner"** in the Extensions view, or get it from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=CaioPlazas.eda-job-runner).
It's **pre-release only** for now — click "Switch to Pre-Release Version"
to install it.

## What it does

- **Sidebar job list.** Add a job, configure it in a real form (not a
  chain of quick-pick prompts), run it with a click. Group jobs into
  folders, drag to reorder, mark one as the workspace default (F5 runs it).
- **Kills cleanly.** Every job runs in its own process group, so Stop
  actually frees the EDA license instead of leaving an orphaned simulator
  behind. The signal sequence is configurable (`killSignals`) and defaults
  to SIGINT before SIGTERM before SIGKILL, since many EDA tools release
  their license cleanly on ctrl+c but not on SIGTERM.
- **Survives closing VS Code by mistake.** A running job's output keeps
  being captured to its log file at the OS level, independent of the
  extension — reopening the workspace resumes live tailing, error/warning
  counts, and Problems-panel diagnostics automatically, and correctly
  records pass/fail once it finishes, even though there's no way to get a
  real exit code back for a job VS Code wasn't open to see exit.
- **Never runs itself twice.** A job can't run concurrently with itself —
  its own **Repeat count** setting is the only way to run it again
  (always sequentially). Different jobs can still run side by side if you
  turn that on.
- **Parametrized runs.** `${param:NAME}` prompts for a value every run and
  remembers what you typed last; `${randomSeed}` fills in a fresh seed with
  no prompt; **Re-run Last** replays one exact prior run to chase down a
  specific failing seed.
- **Parameters panel.** Global name/value pairs, referenced as
  `${var:NAME}` and resolved silently — no prompt. Override any of them
  for a single job, or define one that job alone uses.
- **Problems panel integration.** UVM messages and common compiler errors
  become clickable diagnostics. A log full of `UVM_ERROR` marks the job
  failed even if the simulator exited 0. Anything the built-in patterns
  miss, catch with your own **Fail pattern** / **Pass pattern** regex.
- **Live Log.** Tails a running job in real time — including jobs that
  detach to a farm scheduler (`bsub`/`qsub`).
- **Log Viewer.** Every past run across every job, newest first, in one
  page. Filter by job, folder, pass/fail, seed, or date. Search log
  contents for something like a specific `UVM_ERROR`.
- **Tool Setup.** Point it at an in-house run script once; it scans
  `--help` into checkable flags so nobody has to memorize a long CLI.
  Handles dispatcher sub-commands, value lists (e.g. "pick a test"), and
  colleagues who keep separate copies of the same script in different
  folders.

## A minimal job file

Jobs live in `.vscode/eda-jobs.json` and stay in sync with the sidebar
both ways — hand-edit it or use the UI, whichever's faster:

```jsonc
{
  "version": 1,
  "jobs": [
    { "id": "...", "name": "Compile", "command": "make compile", "cwd": "sim" },
    { "id": "...", "name": "smoke_test", "command": "make sim TEST=smoke_test",
      "cwd": "sim", "default": true },
    { "id": "...", "name": "regress_seeds", "command": "make sim TEST=regress SEED=${randomSeed}",
      "cwd": "sim", "runCount": 10 }
  ]
}
```

`id` is generated for you. Everything else — folders, tool bindings,
fail/pass patterns — is normally set through the Configure form, not typed
by hand. Registered tools for Tool Setup live in their own file,
`.vscode/eda-tools.json`.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `shellPath` | `bash` | Shell used to run jobs |
| `shellArgs` | auto | Override the shell's argument vector |
| `env` | `{}` | Extra environment variables for every job |
| `postSetupCwd` | `""` | Base directory a job's `cwd` resolves against, instead of the workspace root |
| `killSignals` | SIGINT → SIGTERM → SIGKILL | Ordered kill signal escalation, each with its own grace period |
| `killGracePeriodSeconds` | `5` | Fallback grace period for a `killSignals` stage that doesn't set its own |
| `logMaxSizeMB` | `200` | Cap on how much of a run's output is parsed for error/warning counts (the log file itself isn't size-limited — see `logRetentionCount`) |
| `logsDirectory` | `""` | Where logs are stored, instead of `.eda-runner/logs` under the workspace root |
| `logRetentionCount` | `20` | Past runs kept per job by count (`0` = unlimited) |
| `logRetentionMaxSizeMB` | `0` | Past runs kept per job by total size (`0` = off) |
| `failOnLogErrors` | `true` | Fail a job on log errors, even if it exited 0 |
| `experimentalMultipleRuns` | `false` | Let *different* jobs run at once |

(Full list — including ANSI stripping and an experimental auto-save
toggle — in the Settings UI. Search `eda-job-runner`.)

## Farm jobs and slow logs

Two things trip people up with `bsub`/`qsub`-style jobs:

- If output arrives in delayed bursts, the tool is probably block-buffering
  because it's writing to a pipe, not a terminal. Prefix the command with
  `stdbuf -oL -eL` to force line buffering.
- A detached submit (`bsub … make sim`) returns as soon as the job is
  queued — its real output goes to the farm's own `-o` file, which this
  extension never sees. Either submit blocking (`bsub -I`, `qsub -sync y`),
  or point the job's **Live log file to tail** at that `-o` file (use a
  fixed filename, not `%J`).

## Known rough edges

- If VS Code reloads or closes mid-run, the job briefly shows as "running
  (detached)" until reattachment kicks back in (near-instant in practice),
  then "running (resumed)" — live capture, counts, and Problems resume
  automatically. A job that finishes while VS Code is closed can't produce
  a real exit code (nothing was open to see it exit), so its pass/fail is
  inferred from its own output instead — an unproven run defaults to
  failed rather than being credited as a pass, unless a **Pass pattern**
  matched.
- Windows: a shell can be pointed at via `shellArgs`, but Stop and the
  setup-script chain aren't supported there. Linux/macOS (including
  Remote-SSH) is the target.

## Try it without an EDA tool installed

Open [examples/](examples/) as its own workspace — mock pass/fail/
killable jobs that exercise every feature, no simulator required. For
real designs, [sample-projects/](sample-projects/) has a UART subsystem
and a full UVM environment (needs the actual tools — see
[docs/eda-tools-setup.md](docs/eda-tools-setup.md)).

## How this was built

Vibe-coded: a Claude instance as architect/orchestrator, paired with a
local Qwen3.6 model for a lot of the mechanical implementation. Every
feature went through a real typecheck/test/package loop before being
called done — but "verified" mostly means an AI checked its own work, not
exhaustive human QA. If something looks off, it probably is — issue
reports are genuinely useful.

## Development

```bash
npm install
npm run compile   # or `npm run watch`
```

Press F5 for an Extension Development Host. `npm run package` builds a
`.vsix`.
