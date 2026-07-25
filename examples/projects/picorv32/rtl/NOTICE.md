# Vendored: PicoRV32

`picorv32.v` and `COPYING` in this directory are vendored, unmodified,
from [YosysHQ/picorv32](https://github.com/YosysHQ/picorv32), a small
RV32I(MC) RISC-V CPU core by Claire Xenia Wolf.

- Pinned commit: `87c89acc18994c8cf9a2311e871818e87d304568` (2024-06-17)
- License: ISC (see `COPYING` in this directory)

`../tb/smoke_tb.v` is original to this repo (see its own header), written
to exercise the real core above with a hand-assembled RV32I program — it
is not part of upstream picorv32 and is not upstream's own testbench.
