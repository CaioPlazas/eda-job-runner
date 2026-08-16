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
