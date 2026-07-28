# EDA Job Runner — test workspace

A self-contained workspace for trying out the EDA Job Runner extension,
laid out in three parts:

- **`Real Projects`** (the one sidebar folder) — two real, well-known
  open-source CPU designs, each with a genuine self-checking testbench:
  [PicoRV32](https://github.com/YosysHQ/picorv32) (a small sequential
  RV32I core, compiled/simulated by four different real tools) and
  [VeeR EH1](https://github.com/chipsalliance/Cores-VeeR-EH1) (a real,
  silicon-proven 9-stage dual-issue RISC-V core, formerly Western
  Digital's "SweRV," running an actual CoreMark benchmark). Start here
  if you want to see what using this extension on a real design looks
  like — see [Real project: PicoRV32](#real-project-picorv32) and
  [Real project: VeeR EH1](#real-project-veer-eh1) below.
- **Feature-showcase jobs** (ungrouped, deliberately kept out of `Real
  Projects`) — jobs built to exercise one specific extension mechanism
  each: `${randomSeed}`, `${param:NAME}` prompts, the Tool Setup builder
  (including a per-job value-list override), custom Fail/Pass patterns,
  a post-run command, and per-job `logsDirectory`/`postSetupCwd`
  overrides. See [Feature-showcase jobs](#feature-showcase-jobs) below.
- **Dev-testing fixtures** — mock/fixture jobs (bash scripts that mimic
  real tool output, plus a trivial hand-written counter) built to
  exercise Stop, log truncation, log history, and similar extension-only
  behaviors in isolation. See [Dev-testing fixtures](#dev-testing-fixtures)
  below.

See [docs/eda-tools-setup.md](../docs/eda-tools-setup.md) for installing
Icarus Verilog, Verilator, Questa-Altera FPGA Starter Edition, and Altair
DSim yourself — DSim and Questa's simulator both need a free license from
your own account; Questa's compiler and both Icarus and Verilator need
no license at all. VeeR EH1's own jobs need only Verilator, `g++`, `make`,
and `perl` — all four already need to be installed for the rest of this
workspace to be useful, and VeeR's build falls back to prebuilt test
binaries automatically when no RISC-V cross-compiler is present (the
expected case), so there's nothing extra to install for it specifically.

## Real project: PicoRV32

[`projects/picorv32`](projects/picorv32) vendors the actual
[PicoRV32](https://github.com/YosysHQ/picorv32) RV32I RISC-V CPU core
(`rtl/picorv32.v`, unmodified, ISC license — see
[`projects/picorv32/rtl/NOTICE.md`](projects/picorv32/rtl/NOTICE.md) for
the pinned commit) alongside an original, self-checking testbench
(`tb/smoke_tb.v`) that preloads a small hand-assembled RV32I program (no
RISC-V cross-compiler needed) and watches for it to write the right
result to a memory-mapped address. It prints `TEST PASSED: ...` or
`TEST FAILED: ...`, real pass/fail output from a real CPU core actually
executing instructions — not a canned message.

The `Real Projects` folder in the sidebar runs that same design through
four different tools, each split into a Compile job and a Test job (see
[why they're split](#compiletest-job-pairs-depend-on-each-other-running-in-order)
below — the same reasoning applies here):

| Job | What it exercises |
| --- | --- |
| `Icarus Compile` / `Icarus Test` | Real `iverilog`/`vvp` — no license needed |
| `Verilator Compile` / `Verilator Test` | Real Verilator, built with `--binary` for an actual simulation run (not just `--lint-only`) |
| `Questa Compile` / `Questa Test` | Real Questa-Altera FPGA Starter Edition `vlog`/`vsim` — compiler needs no license |
| `DSim Compile+Test` | Real Altair DSim — needs a license (DSim combines compile+elaborate+run into one invocation, so it isn't split) |

Run any tool's Compile job then its matching Test job (in that order) —
the log should end with `TEST PASSED: RV32I loop wrote result=10 to
0x400`.

## Real project: VeeR EH1

[`projects/veer-eh1`](projects/veer-eh1) vendors the actual
[VeeR EH1](https://github.com/chipsalliance/Cores-VeeR-EH1) core
(unmodified, Apache-2.0 license — see
[`projects/veer-eh1/NOTICE.md`](projects/veer-eh1/NOTICE.md) for the
pinned commit), upstream's own build (`tools/Makefile`, driven by the
Perl script `configs/veer.config`), and its own canned test programs.
Where PicoRV32 is one file and a simple sequential core, VeeR EH1 is
dozens of RTL files (`design/{ifu,dec,exu,lsu,dbg,dmi,lib}/`) implementing
a real, silicon-proven 9-stage, dual-issue in-order pipeline with dynamic
branch prediction — originally developed by Western Digital under the
name "SweRV" and used in WD's own manufactured chips, later donated to
CHIPS Alliance. If PicoRV32 is "a real project," VeeR EH1 is "a real
project that's actually complex."

The two `Real Projects` jobs for it:

| Job | What it exercises |
| --- | --- |
| `VeeR EH1 Build+Run (Verilator, CoreMark)` | Runs upstream's `tools/Makefile` to generate the core's configuration, builds a Verilator model of the *whole testbench* (not just the core), then runs the actual [CoreMark](https://github.com/eembc/coremark) benchmark against it — a genuine ~5s simulation, not an instant toy, ending in a real self-checked `Correct operation validated` |
| `VeeR EH1 Re-run (no rebuild)` | Re-executes the already-built `obj_dir/Vtb_top` binary directly — same Compile/Test-pair dependency as PicoRV32 above: run the Build+Run job at least once first |

No RISC-V cross-compiler is needed — the build automatically falls back
to `testbench/hex/cmark.hex`, a prebuilt program checked into the
upstream repo, whenever `riscv64-unknown-elf-gcc` isn't on `PATH` (the
expected case). The log ends with `TEST_PASSED` and
`Finished : minstret = 303700, mcycle = 586649` — real retired-instruction
and cycle counts from a real (simulated) CPU, not a canned string.

## Feature-showcase jobs

Ungrouped on purpose — `Real Projects` stays reserved for the two real
designs above. Each job here is built to exercise exactly one mechanism:

| Job | What it exercises |
| --- | --- |
| `long_regression (pass, ~28s)` / `(fail, ~28s)` | A genuinely longer mock run (`scripts/mock_regression.sh`, 5 staged sub-tests, ~28s total, output streamed incrementally rather than printed all at once) — use these instead of `smoke_test`/`regression` above to actually watch the live elapsed-time ticker or "Follow Running Log" do something over time. Uses `${randomSeed}` — try **Re-run Last** afterward, and check the Log Viewer's Seed column picks it up |
| `mock_tool: sim (param prompt + seed, no builder link)` | `${param:TESTNAME=smoke_test}` — prompts once and remembers the answer for next time, independent of `${randomSeed}` in the same command |
| `mock_tool: sim (Tool Setup builder demo)` | A job actually linked to a registered tool (`toolId`/`toolVariantLabel`) with a custom argument (`--parallel 2`) added via the builder's escape hatch — open Configure to see the real checkbox builder pre-populated, not just a typed Command string |
| `mock_tool: sim (per-job value-list override)` | Same tool/variant, but this job's `-t/--test` flag is overridden (`optionListOverrides`) to source its dropdown from the `smoke_subset` list instead of the tool's own default `test` list — open Configure's ⚙ on the Test flag to see the difference |
| `fail_pattern (exits 0 but really failed)` | Exits `0` but prints a real `UVM_ERROR` line; a custom **Fail pattern** on the job overrides the sidebar to failed anyway |
| `pass_pattern (exits nonzero but really passed)` | The inverse: exits `3` but prints `ALL TESTS PASSED`; a custom **Pass pattern** overrides the sidebar to passed |
| `post_run_demo (notification after finish)` | A checkbox-gated post-run command, fired once the job itself finishes |
| `custom_logs_dir (per-job logsDirectory override)` | This job's logs land in `scratch-logs/` instead of the workspace's normal logs directory |
| `custom_cwd (per-job postSetupCwd override)` | This job's shell starts inside `projects/picorv32` instead of the workspace root — `pwd`/`ls` in its own log prove it |
| `mock_tool: sim (global parameter reference)` | `${var:PROJECT_TAG}` — a workspace-wide **Parameter** (Parameters & Value Lists panel), resolved silently into the command every run, unlike `${param:...}` above which prompts |
| `mock_tool: sim (per-job parameter override)` | Same `${var:PROJECT_TAG}` reference, but this job overrides the value to `regression-v2` for itself only (`paramOverrides`) — every other job keeps seeing the workspace-wide value |
| `mock_tool: compile (variant demo)` | Links to `mock_tool.sh`'s `compile` sub-command (a different variant than `sim` above) — open Configure to see a completely different set of checkboxes for the same registered tool |
| `mock_tool: report (variant demo, no flags)` | The `report` sub-command, which takes no flags at all — the simplest possible variant, and the third of `mock_tool.sh`'s three registered variants exercised here |

`uvm_testname` (Parameters & Value Lists panel) is a value list deliberately
left **unattached** to any tool flag — it shows up as its own row in every
job's Configure form, with its picked value written in as
`+UVM_TESTNAME=${value}` (its custom insert template) instead of a plain
`--flag value`, matching a real plusarg-style CLI convention.

`smoke_test (pass)` is this workspace's default job (F5 / **EDA: Run
Default Job**) — the fastest, always-passing one, so F5 always does
something safe.

Two job **templates** (Configure → Save as Template / the "New Job"
template picker) are also included: "Mock UVM smoke test" and "Mock Tool
sim (builder)" — the latter pre-fills a tool/variant link, not just a
Command string.

## Dev-testing fixtures

The rest of this workspace: mock scripts that mimic real tool behavior
(including colorized, UVM-shaped output) closely enough to exercise
every feature end to end without any EDA tool installed, plus a trivial
hand-written counter design run through the same four real tools as
PicoRV32 above (kept as a smaller/faster fixture for extension
development — prefer the PicoRV32 jobs above if you want a realistic
example to point someone at).

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
   not the repo root. `.vscode/eda-jobs.json` here defines every job in
   this section and both real-project sections above.
3. Open the "EDA Jobs" view in the activity bar and click ▶ on a job.

## Fixture jobs

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
- Run `VeeR EH1 Build+Run (Verilator, CoreMark)` — takes a few seconds
  longer than anything else here (real Verilator + g++ compile, then a
  real ~5s simulation); the log should end `TEST_PASSED`. Then run
  `VeeR EH1 Re-run (no rebuild)` — much faster, same result, no rebuild.
- Run `long_regression (pass, ~28s)` and actually watch it via "Follow
  Running Log" — output should stream in over the full ~28s, not appear
  as one burst at the end. Try **Re-run Last** afterward.
- Open Configure on `mock_tool: sim (Tool Setup builder demo)` — the
  checkbox builder should already show `Test`/`--rng-init`/`--std`
  checked, matching the job's Command, plus a custom argument row for
  `--parallel 2`.
- Run `fail_pattern (exits 0 but really failed)` — sidebar shows
  **failed** despite a real exit code of 0. Run `pass_pattern (exits
  nonzero but really passed)` — the inverse, sidebar shows **passed**
  despite a real nonzero exit.
- Run `mock_tool: sim (global parameter reference)` and `mock_tool: sim
  (per-job parameter override)` back to back — the log should show
  `smoke-v1` for the first and `regression-v2` for the second, both from
  the same `${var:PROJECT_TAG}` in the Command.
- Open Configure on `mock_tool: compile (variant demo)` and `mock_tool:
  report (variant demo, no flags)` — each should show the checkbox
  builder for its own sub-command's flags (or none, for `report`), not
  `sim`'s.
- Press F5 (or **EDA: Run Default Job**) with no job selected — it
  should run `smoke_test (pass)`, this workspace's default job.

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
