# uart_soc — a multi-module UART subsystem (sample project)

A realistic, synthesizable RTL project to try the EDA Job Runner extension on
something bigger than a one-file toy. Open **this folder** as its own VS Code
workspace; the jobs are in `.vscode/eda-jobs.json`.

## What it is

A UART transmit/receive subsystem wired together from several modules:

| File | Module | Role |
| --- | --- | --- |
| `rtl/sync_fifo.v` | `sync_fifo` | Parameterized first-word-fall-through FIFO, used on both TX and RX sides |
| `rtl/uart_tx.v` | `uart_tx` | Transmitter FSM (start / 8 data / stop, baud-timed) |
| `rtl/uart_rx.v` | `uart_rx` | Receiver FSM with start-bit detect, mid-bit sampling, 2-flop input synchronizer, framing-error flag |
| `rtl/uart_top.v` | `uart_top` | Ties TX+RX+FIFOs into a byte-in/byte-out subsystem with serial pins |
| `tb/tb_uart_top.v` | `tb_uart_top` | Self-checking testbench |

The testbench loops the serial TX pin straight back into RX, streams a
directed pattern (corner bytes + a walking-one) plus a randomized burst
through the whole datapath, and scoreboards every byte that comes back.
It prints `** TEST PASSED **` / `** TEST FAILED **` and a byte/error count.

## Jobs (sidebar)

All five are verified working on this machine's tools:

| Job | Tool | Notes |
| --- | --- | --- |
| `Lint (Verilator)` | Verilator | `--lint-only -Wall`, clean |
| `Icarus: build + run TB` | Icarus Verilog | **default job** (runs on F5) — should print `** TEST PASSED **` |
| `Questa: compile` | Questa `vlog` | compile into `work/` |
| `Questa: run TB` | Questa `vsim` | run the compiled TB (needs `Questa: compile` first) |
| `DSim: build + run TB` | Altair DSim | single-invocation compile+run |

Run `Icarus: build + run TB` first for a quick end-to-end check (no license
needed). The Questa/DSim jobs need their licenses set up — see the repo's
[docs/eda-tools-setup.md](../../docs/eda-tools-setup.md).

## Trying the Problems-panel parsing

This design is deliberately correct, so a clean run shows 0 errors/0 warnings.
To see the Phase 4 error parsing in action, introduce a typo in one of the
`rtl/*.v` files (e.g. delete a semicolon) and run a compile job — the compile
error should appear in the Problems panel, clickable to the offending line,
and the job should show as failed.
