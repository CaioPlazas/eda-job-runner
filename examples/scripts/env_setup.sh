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
