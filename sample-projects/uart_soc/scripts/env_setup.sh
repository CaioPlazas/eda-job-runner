#!/usr/bin/env bash
# Per-workspace environment setup, sourced before every job (stands in for a
# real site's module-load / license setup). Activates the real tools installed
# on this machine if present; silently skipped elsewhere.
if [ -f "$HOME/AltairDSim/2026/shell_activate.bash" ]; then
  source "$HOME/AltairDSim/2026/shell_activate.bash"
  if [ -f "$HOME/metrics-ca/dsim-license.json" ]; then
    export DSIM_LICENSE="$HOME/metrics-ca/dsim-license.json"
  fi
fi
if [ -d "$HOME/altera/25.1std/questa_fse/bin" ]; then
  export PATH="$HOME/altera/25.1std/questa_fse/bin:$PATH"
fi
if [ -f "$HOME/altera/licenses/LR-177672_License.dat" ]; then
  export SALT_LICENSE_SERVER="$HOME/altera/licenses/LR-177672_License.dat"
fi
