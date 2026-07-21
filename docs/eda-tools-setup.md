# EDA tools on WSL2 — setup guide

Four tools, all installed, licensed, and verified working in this
repo's [examples/](../examples/) workspace right now: Icarus Verilog,
Verilator, Altair DSim (real UVM 1.2), and Questa-Altera FPGA Starter
Edition (real `vlog`/`vsim`, licensed with a Fixed Node License).

## 1. Icarus Verilog — done, already installed

Confirmed installed (`iverilog 12.0-2build2`) and verified end-to-end
against `examples/rtl/counter.v` + `examples/tb/counter_tb.v` — real
compile, real simulation, deterministic pass. Nothing left to do here.

If you ever need it on a fresh machine:
```bash
sudo apt install -y iverilog
```

## 2. Verilator — done, already installed

Confirmed installed (`5.020`) and verified with
`verilator --lint-only -Wall rtl/counter.v` against the same example.
Nothing left to do here. If needed elsewhere:
```bash
sudo apt install -y verilator
```

Note: Verilator's UVM support is still experimental as of 5.x, so it's
wired up here as a lint/compile-style job, not a UVM sim job.

## 3. DSim Desktop (Altair) — free, full UVM support — done

**Fully working.** Installed at `/home/caioplazas/AltairDSim/2026`
(from `AltairDSim2026_linux64.bin`, run via its InstallAnywhere console
installer), licensed with a Free Individual License
(`~/metrics-ca/dsim-license.json`, from the Altair DSim Cloud Portal),
and verified against a real UVM 1.2 test — genuine `UVM_INFO`/
`UVM_WARNING`/`UVM_ERROR` output and a real report summary table, not
a mock. UVM 1.1b, 1.1d, 1.2, and 2020.3.1 are all bundled under
`AltairDSim/2026/uvm/`.

`examples/scripts/env_setup.sh` activates DSim automatically for every
job in that workspace (conditionally — skipped on machines without it),
so the `DSim UVM (real UVM, ...)` jobs there just work. To use it
outside that workspace:

```bash
source ~/AltairDSim/2026/shell_activate.bash
export DSIM_LICENSE=~/metrics-ca/dsim-license.json   # not auto-discovered -- must be set explicitly
dsim -uvm 1.2 your_test.sv +UVM_TESTNAME=your_test
```

**Two things worth knowing:**

- **The free on-prem license expires September 1st** (per DSim's own
  startup notice) — after that, on-prem free licensing and DSim Cloud
  are discontinued and Altair-managed licensing is needed instead. Cloud
  data is deleted October 15th. If DSim jobs stop working after that
  date, this is why — see altair.com/dsim for migration.
- **A real `UVM_ERROR` does not make `dsim`'s process exit non-zero** —
  confirmed directly, including with `-exit-on-error 1` passed. This is
  exactly the reason Phase 4's log-content parsing exists: exit code
  alone cannot detect a failed UVM test. See the callout in
  [examples/README.md](../examples/README.md) for the concrete
  repro (the `+FAIL` DSim job there shows "passed" in the sidebar
  despite a real `UVM_ERROR` in its log).

## 4. Questa-Altera FPGA Starter Edition — done

Installed from `QuestaSetup-25.1std.0.1129-linux.run` (2025.2 /
Quartus 25.1std release train — Intel's FPGA division is now the
independent company Altera again, hence "Questa-Altera" rather than
"Questa-Intel"). Unlike DSim's installer, this one has proper
`--mode unattended` support, so no interactive pty-driving was needed:

```bash
./QuestaSetup-25.1std.0.1129-linux.run \
  --mode unattended --unattendedmodeui minimal \
  --accept_eula 1 \
  --installdir ~/altera/25.1std \
  --questa_edition questa_fse   # FPGA Starter Edition (free); questa_fe is the other option
```

Installed to `~/altera/25.1std/questa_fse` (`bin/` has `vlog`, `vcom`,
`vsim`, `vmap`, etc.), confirmed via the log: `Installation completed
... Exiting with code 0`. Add it to `PATH`:

```bash
export PATH="$HOME/altera/25.1std/questa_fse/bin:$PATH"
```

**Verified split: compiling is free, simulating needs a license.**

```bash
vlog -version    # -> Questa Altera Starter FPGA Edition-64 vlog 2025.2 ... -- works, no license
vlog hello.sv     # -> compiles fine, no license needed
vsim -c -do "run -all; quit" top
# -> Unable to find the license file. It appears that your license file
#    environment variable (SALT_LICENSE_SERVER) is not set correctly.
#    Unable to checkout a license. Vsim is closing.
```

So `vlog`/`vcom` (compile) work right now with zero setup. `vsim`
(actually running a simulation) needs a license from **your own** Intel/
Altera Self-Service Licensing Center account — same boundary as DSim's
license, not something that can be done here. What I confirmed:

- The env var it actually reads is **`SALT_LICENSE_SERVER`**, not the
  generic `LM_LICENSE_FILE` I'd guessed before installing this. Set it
  to your license file path or `port@host` once you have one:
  ```bash
  export SALT_LICENSE_SERVER=/path/to/your/license.dat
  # or: export SALT_LICENSE_SERVER=port@host
  ```
- **For the SSLC's NIC ID / Host ID field, use Questa's own bundled
  tool rather than guessing from `ip addr`:**
  ```bash
  ~/altera/25.1std/questa_fse/linux_x86_64/lmhostid
  # -> The FlexNet host ID of this machine is
  #    "00155d90a4a9 f889d2da54e1 00155d5d3bc0 d85ed381d398"
  #    Only use ONE from the list of hostids.
  ```
  This lists every adapter FlexNet can see (no colons — that's
  FlexNet's native format). **Use `d85ed381d398`** — it's the same
  physical Ethernet MAC identified independently via `ipconfig.exe
  /all` (`d8:5e:d3:81:d3:98`), now confirmed authoritatively by the
  vendor's own licensing tool. The other three in that list are all
  synthetic/inactive: `00155d90a4a9` is a dead leftover Hyper-V NAT
  adapter, `f889d2da54e1` is the Wi-Fi adapter (disconnected on this
  machine), and `00155d5d3bc0` is a Hyper-V loopback artifact — none of
  those are safe to node-lock a license to, since they can regenerate
  or simply aren't the adapter actually in use.

  This works because this machine's `.wslconfig` already has
  `networkingMode=mirrored` set and active: instead of a synthetic
  Hyper-V NAT adapter (which *does* regenerate its MAC unpredictably),
  mirrored mode makes WSL's network interfaces mirror the Windows
  host's real ones directly, so both `ip addr` inside WSL and
  `lmhostid` see the actual physical adapter's real, permanent MAC.
  Since this machine has no Wi-Fi connected (wired-only), that MAC
  won't change across reboots, WSL updates, or Windows updates — it's
  tied to the network card, not to WSL at all.
- Once you have a value for `SALT_LICENSE_SERVER`, verify with:
  ```bash
  echo 'module top; initial $display("Hello"); endmodule' > /tmp/hello.sv
  vlog /tmp/hello.sv && vsim -c -do "run -all; quit" top
  ```
  Success prints `Hello` from inside the `vsim` run, not just from `vlog`.

**Done as of this session** — licensed with a Fixed Node License
(`LR-177672_License.dat`, node-locked to `d85ed381d398`, expires
19-Jul-2027), stored at `~/altera/licenses/LR-177672_License.dat`
(`chmod 600`). `examples/scripts/env_setup.sh` exports
`SALT_LICENSE_SERVER` to that path automatically when the file exists,
so `Questa Compile` and `Questa Test` in
`examples/.vscode/eda-jobs.json` both work with zero extra setup.
Verified end to end: `vlog` compiles, `vsim -c -do "run -all; quit"`
actually runs the simulation and prints real output, exit 0.
