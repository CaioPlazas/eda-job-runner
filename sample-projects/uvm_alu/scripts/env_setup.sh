#!/usr/bin/env bash
# Per-workspace environment setup, sourced before every job. Activates DSim
# (the UVM simulator used here) and Questa if present; silently skipped
# elsewhere. Also exports UVM_SRC for the Questa compile job.
if [ -f "$HOME/AltairDSim/2026/shell_activate.bash" ]; then
  source "$HOME/AltairDSim/2026/shell_activate.bash"
  if [ -f "$HOME/metrics-ca/dsim-license.json" ]; then
    export DSIM_LICENSE="$HOME/metrics-ca/dsim-license.json"
  fi
fi
if [ -d "$HOME/altera/25.1std/questa_fse/bin" ]; then
  export PATH="$HOME/altera/25.1std/questa_fse/bin:$PATH"
  export UVM_SRC="$HOME/altera/25.1std/questa_fse/verilog_src/uvm-1.2/src"
fi
# Whichever license file is present. The filename embeds a per-user license
# request ID, so it is discovered rather than hardcoded -- this file is public.
# An unmatched glob stays literal, and the -f test then simply fails.
for _lic in "$HOME"/altera/licenses/*_License.dat; do
  if [ -f "$_lic" ]; then
    export SALT_LICENSE_SERVER="$_lic"
    break
  fi
done
unset _lic
