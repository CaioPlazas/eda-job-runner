# uvm_alu — a full UVM environment (sample project)

A complete UVM 1.2 testbench verifying an ALU DUT — the sample project for
verification-flow features, and the best way to see the Phase 4 Problems-panel
error parsing in action. Open **this folder** as its own VS Code workspace.

## What it is

| File | Role |
| --- | --- |
| `rtl/alu.sv` | DUT: a registered ALU (ADD/SUB/AND/OR/XOR/SLL/SRL/SLT). Has a `bug_en` input that deliberately breaks SUB when asserted. |
| `tb/alu_if.sv` | Interface bundling the DUT pins. |
| `tb/alu_pkg.sv` | The UVM environment: transaction, driver, monitor, scoreboard (independent reference model), functional coverage, agent, env, sequences, and tests. |
| `tb/tb_top.sv` | Top: clock/reset, DUT + interface, `run_test()`. Drives `bug_en` from a `+BUG` plusarg. |

The scoreboard is an independent reference model: it recomputes each result and
raises a `` `uvm_error `` on any mismatch. The monitor pairs each driven
operation with its result through a queue, so it's robust to the DUT's pipeline
latency.

## Jobs (sidebar)

| Job | What it does |
| --- | --- |
| `DSim UVM: random test (PASS)` | **default (F5)** — directed corners + 300 random ops, all checked, 0 mismatches |
| `DSim UVM: random test +BUG (fails -> Problems panel)` | Same test with `+BUG`, which breaks the DUT's SUB. The scoreboard raises ~46 real `UVM_ERROR`s. |
| `DSim UVM: smoke test` | Shorter directed-only test |
| `Questa: compile/elaborate UVM` | Compiles the whole env with Questa (elaboration/syntax check) — see the Questa note below |

## Seeing Phase 4 in action

Run **`DSim UVM: random test +BUG`**. Even though `dsim` exits 0 (EDA
simulators don't return non-zero on a failed UVM test), the extension:

- parses the `UVM_ERROR` lines out of the log — and correctly ignores the
  `UVM_ERROR :   46` end-of-run summary row, which only *looks* like an error,
- drops ~46 clickable diagnostics into the **Problems panel**, each pointing at
  the scoreboard's `` `uvm_error `` call in `tb/alu_pkg.sv`,
- shows the error count on the job in the sidebar, and
- marks the job **failed** (via the `failOnLogErrors` setting) despite the
  clean exit code.

Compare with the PASS job, which shows 0 errors and passes.

## A note on Questa here

DSim is the UVM simulator used in this project and runs everything cleanly.
Questa-Altera Starter Edition **compiles/elaborates** the environment fine (the
compile job above), but on this Ubuntu 24.04 / WSL2 box its *runtime* UVM DPI
step fails to link — its bundled gcc-10.3 `ld` can't handle the newer
`.relr.dyn` section in the system's `ld-linux-x86-64.so.2`. That's a
Questa/toolchain-vs-libc issue unrelated to the extension, so there's no Questa
"run" job here. Use DSim to run the UVM tests.
