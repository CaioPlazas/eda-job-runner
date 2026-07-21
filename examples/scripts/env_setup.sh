#!/usr/bin/env bash
# Stands in for a real site setup script (module load, license env vars,
# sourced dotfiles). Its own output lands in the job's log too, which is
# useful for debugging environment problems on a real site.
export EDA_JOB_RUNNER_EXAMPLE=1
echo "[env_setup] example environment loaded"

# Optional: activate a real DSim install if present (see docs/eda-tools-setup.md).
# Silently skipped on machines without it -- other jobs are unaffected.
if [ -f "$HOME/AltairDSim/2026/shell_activate.bash" ]; then
  source "$HOME/AltairDSim/2026/shell_activate.bash"
  if [ -f "$HOME/metrics-ca/dsim-license.json" ]; then
    export DSIM_LICENSE="$HOME/metrics-ca/dsim-license.json"
  fi
fi

# Optional: put a real Questa-Altera FPGA Starter Edition install on PATH if
# present (see docs/eda-tools-setup.md), and point it at a node-locked
# license file if one exists at the conventional path below. Silently
# skipped on machines without either -- other jobs are unaffected.
if [ -d "$HOME/altera/25.1std/questa_fse/bin" ]; then
  export PATH="$HOME/altera/25.1std/questa_fse/bin:$PATH"
fi
if [ -f "$HOME/altera/licenses/LR-177672_License.dat" ]; then
  export SALT_LICENSE_SERVER="$HOME/altera/licenses/LR-177672_License.dat"
fi
