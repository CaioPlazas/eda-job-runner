# Vendored: VeeR EH1 (formerly Western Digital "SweRV" EH1)

`design/`, `configs/`, `testbench/`, `tools/`, `LICENSE`, `release-notes.md`,
and `docs/RISC-V_VeeR_EH1_PRM.pdf` in this directory are vendored,
unmodified, from
[chipsalliance/Cores-VeeR-EH1](https://github.com/chipsalliance/Cores-VeeR-EH1)
— a real, silicon-proven 32-bit RISC-V CPU core originally developed by
Western Digital under the name "SweRV" (used in WD's own manufactured
flash controllers), later donated to CHIPS Alliance and rebranded VeeR.
Unlike PicoRV32's simple sequential core, EH1 is a 9-stage, dual-issue
in-order pipeline with dynamic branch prediction, a multiplier/divider,
a programmable interrupt controller, an AHB-Lite bus interface, and a
JTAG debug module — dozens of RTL files across `design/{ifu,dec,exu,lsu,
dbg,dmi,lib}/`, not a single file.

- Pinned commit: `d04b1c7ae675a63dc4307cacfd10547ec937b928`
- License: Apache-2.0 (see `LICENSE` in this directory)

Upstream's own build (`tools/Makefile`, driven by the Perl script
`configs/veer.config`) is used as-is, unmodified — see the "Real
Projects" folder's two VeeR EH1 jobs for the exact commands. The canned
test programs under `testbench/hex/` (a "Hello World", the classic
Dhrystone benchmark, and CoreMark) are upstream's own, not written for
this repo. No RISC-V cross-compiler is needed: the build automatically
falls back to these prebuilt `.hex` files whenever
`riscv64-unknown-elf-gcc` isn't on `PATH`, which is the expected case on
most machines trying this extension out — confirmed working end to end
in a sandbox with no RISC-V toolchain installed, only `verilator`, `g++`,
`make`, and `perl`.
