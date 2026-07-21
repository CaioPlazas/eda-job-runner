# EDA Job Runner — test workspace

A self-contained workspace for trying out the EDA Job Runner extension.
Most jobs here are bash scripts that mimic real tool behavior (including
colorized, UVM-shaped output) closely enough to exercise every feature
end to end without any EDA tool installed. Several jobs run **real**
tools — Icarus Verilog and Questa-Altera FPGA Starter Edition each split
into a Compile job and a Test job against a trivial counter design,
Verilator linting the same design (compile-only, no sim), and Altair
DSim running genuine UVM 1.2 (real `UVM_INFO`/`UVM_WARNING`/`UVM_ERROR`
output, not a mock). See [docs/eda-tools-setup.md](../docs/eda-tools-setup.md)
for installing these yourself — DSim and Questa's simulator both need a
free license from your own account; Questa's compiler needs no license.

### Compile/Test job pairs depend on each other running in order

`Icarus Compile`/`Icarus Test` and `Questa Compile`/`Questa Test` are
split into two jobs each (matching how you'd actually use these tools —
compile once, run/re-run separately) rather than one combined job. This
means **the Compile job must be run at least once before its matching
Test job** — Test just runs against whatever `build/` or `work/`
library is already on disk; it doesn't recompile. Run Compile, then
Test, in that order. (DSim combines compile+elaborate+run into one
`dsim` invocation by design, so its jobs don't split this way; Verilator
here is lint-only, with no sim counterpart.)

## How to use

1. Install the extension (`.vsix` from the latest GitHub release, or F5
   from the main repo to launch an Extension Development Host).
2. Open **this folder** (`examples/`) as its own VS Code workspace —
   not the repo root. `.vscode/eda-jobs.json` here defines the jobs
   below.
3. Open the "EDA Jobs" view in the activity bar and click ▶ on a job.

## Jobs

| Job | What it exercises |
| --- | --- |
| `Compile (mock)` | A quick, always-passing job — baseline sanity check |
| `smoke_test (pass)` | Realistic UVM-shaped log output (info/warning), colorized, exits 0 |
| `regression (fail)` | Same, but with real `UVM_ERROR` lines and a non-zero exit — also includes the `UVM_ERROR :    N` report-summary line, which looks like an error message but isn't (a known parsing gotcha kept here as a fixture) |
| `long_running (stop me)` | Never finishes on its own — use it to test **Stop** (traps SIGTERM and exits cleanly if the signal actually reaches it) and the live elapsed-time ticker |
| `noisy (truncation test)` | Emits ~7 MB of output fast — lower `eda-job-runner.logMaxSizeMB` in workspace settings to see truncation kick in without waiting |
| `Verilator Compile (lint — no sim, tool limitation)` | Runs real `verilator --lint-only` against `rtl/counter.v` — requires Verilator installed |
| `Icarus Compile` | Compiles `rtl/counter.v` + `tb/counter_tb.v` with real `iverilog` into `build/counter_sim` — requires Icarus Verilog installed |
| `Icarus Test` | Runs `vvp build/counter_sim` — requires `Icarus Compile` to have run first |
| `DSim UVM Compile+Test (pass)` | Runs a genuine UVM 1.2 test (`tb/uvm_smoke_test.sv`) through real DSim — real `UVM_INFO`/`UVM_WARNING` output, real report summary table. Requires DSim installed + licensed (see docs) |
| `DSim UVM Compile+Test (fail — watch the exit code)` | Same test with `+FAIL`, which raises a real `UVM_ERROR`. **Read the note below before assuming this job is broken.** |
| `Questa Compile` | Compiles `rtl/counter.v` + `tb/counter_tb.v` with real Questa `vlog` into a `work/` library — no license needed. Requires Questa-Altera FPGA Starter Edition installed |
| `Questa Test` | Runs `vsim -c -do "run -all; quit" counter_tb` against that library — requires `Questa Compile` to have run first, and a valid `SALT_LICENSE_SERVER` (see docs) |

The `setup.script` (`scripts/env_setup.sh`) runs before every job and
exports a dummy env var, standing in for a real `module load` /
site-setup script — its own output shows up in the log too. It also
conditionally activates real DSim and Questa installs if present
(`~/AltairDSim/2026`, `~/altera/25.1std/questa_fse`), so those jobs
work without any per-job setup.

### Important: real DSim confirms exit code alone can't detect UVM failures

Confirmed directly against real DSim 2026: **a `UVM_ERROR` does not
make the simulator process exit non-zero.** Both `DSim UVM (real UVM,
pass)` and the `+FAIL` variant exit `0` — even with `-exit-on-error 1`
passed to `dsim`. The `+FAIL` job's log genuinely contains a real
`UVM_ERROR` line and `UVM_ERROR :    1` in the summary table, but the
sidebar will currently show it as **passed**, because Phase 1-3's
status detection is exit-code-only.

This isn't a bug to fix in Phase 3 — it's the concrete, now-verified
reason Phase 4's log-content parsing (reading `UVM_ERROR`/`UVM_WARNING`
lines, not just the exit code) is necessary rather than a nice-to-have.
Real EDA tools genuinely behave this way.

### Fixed: multi-step job commands (`&&`/`;`) were silently truncated

Building the Questa Compile+Test pair surfaced a real bug in
`JobRunner`: it ran every job command as `exec <command>`, and `exec`
replaces the shell process with the *first* simple command it's given.
For a job like `mkdir -p build && iverilog ... && vvp ...`, only
`mkdir -p build` ever actually ran — `exec` took over the process the
instant `mkdir` started, so there was no shell left alive to evaluate
anything after the first `&&`. Confirmed with a minimal repro
(`bash -lc 'echo a && exec echo b && echo c'` never printed `c`) before
touching the fix. This silently affected `Compile (mock)`'s `;`-chain
and the old combined `Icarus Sim` job across the Phase 1-3 releases —
neither ever ran past its first step in production, even though manual
testing during development (which didn't go through the real `exec`
wrapping) didn't catch it. Fixed in `src/jobRunner.ts` by dropping the
`exec` — the extra shell layer it saved is free, and `detached: true` +
`setsid` already puts the whole tree in one process group regardless,
so `Stop` still kills everything correctly.

## What to check

- Run `smoke_test (pass)` — status goes idle → running (spinner, ticking
  elapsed time) → passed, a notification appears, and the log opens
  clean of ANSI escape codes despite the script emitting color.
- Run `regression (fail)` — status goes to failed with the exit code
  shown, and the failure notification offers "Open Log".
- Run `long_running (stop me)`, then click Stop — the job should exit
  within a couple seconds (via the SIGTERM trap), and the log's last
  line should read `caught SIGTERM, shutting down cleanly`.
- Run any job twice, then right-click → "Open Log History..." to
  confirm past runs are listed and openable.
- While a job runs, check the status bar (bottom left) for the running
  job + elapsed time, and try right-click → "Follow Running Log" to see
  the editor auto-scroll as output arrives.
- Try starting a second job while one is running — it should be blocked
  with a message instead of running concurrently (sequential-only by
  design, for license reasons).
- Run `Verilator Compile` — same checks, against a real tool instead of
  a mock script.
- Run `Icarus Compile` then `Icarus Test` (in that order) — `Icarus
  Test` should print `PASS: counter reached expected value (19)` in
  the log and end in a "passed" status.
- Run both DSim jobs (needs DSim installed + licensed) — confirm the
  log for the `+FAIL` one really does contain a `UVM_ERROR` line, and
  that the sidebar nonetheless shows it as passed. See the callout
  above for why that's expected right now, not a bug.
- Run `Questa Compile` then `Questa Test` (in that order, needs a valid
  `SALT_LICENSE_SERVER`) — `Questa Test` should print `PASS: counter
  reached expected value (19)` from inside a real `vsim` run.

## Full Phase-3 testing checklist

Before moving on to Phase 4, this is the full pass worth running
through once:

1. Every job above runs and lands in the right terminal status
   (passed/failed/killed) with the right icon. In particular,
   `Compile (mock)`'s log should show all three lines
   (`Compiling...` / a 1s pause / `Compile OK`) — before the `exec` fix
   above, only `Compiling...` ever ran.
2. Stop actually kills `long_running (stop me)` within the grace
   period, not just the shell wrapper — check the log shows the
   SIGTERM-trap message, not a hang.
3. Reload the window (`Developer: Reload Window`) while a job is
   running (use `long_running (stop me)` for this) — the job should
   show as "running (detached)" afterward, not silently reset to idle,
   and clicking Stop should still work.
4. `.gitignore` prompt appears the first time a job runs in a fresh
   workspace (skip this check if you've already dismissed it once here).
5. Settings in `.vscode/settings.json` (workspace scope) actually take
   effect — e.g. set `eda-job-runner.logMaxSizeMB` low and confirm
   `noisy (truncation test)` truncates sooner.
6. The real-tool jobs behave identically to the mock ones from the
   sidebar's point of view — same status icons, same log-opening
   behavior, same notifications.
