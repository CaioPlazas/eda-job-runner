# sample-projects

Larger, realistic RTL/verification projects for trying the EDA Job Runner
extension on something closer to real work than the mock
[../examples/](../examples/) workspace. **Open each subfolder as its own VS
Code workspace** (not this parent directory) — each has its own
`.vscode/eda-jobs.json`.

| Project | What it is | Tools it runs on |
| --- | --- | --- |
| [uart_soc/](uart_soc/) | A synthesizable multi-module UART subsystem (FIFO + TX + RX + top) with a self-checking loopback testbench | Icarus, Verilator, Questa, DSim |
| [uvm_alu/](uvm_alu/) | A full UVM 1.2 environment (driver / monitor / scoreboard / coverage / sequences / tests) verifying an ALU DUT, with a bug-injection job that shows real `UVM_ERROR`s in the Problems panel | DSim (Questa compiles it; see its README) |

Both were built and verified end-to-end on the real tools installed on this
machine — see [../docs/eda-tools-setup.md](../docs/eda-tools-setup.md) for how
those are set up.
