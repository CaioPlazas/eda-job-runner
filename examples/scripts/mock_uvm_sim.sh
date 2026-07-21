#!/usr/bin/env bash
# Emits output shaped like a real UVM testbench run (Questa/Xcelium-style),
# including the "UVM_ERROR :    N" summary-table line that looks like a real
# UVM_ERROR message but isn't — a known parser gotcha, kept here on purpose
# as a fixture for later work. Pass --fail to make the run end with real
# UVM_ERROR lines and a non-zero exit code; otherwise it passes cleanly.
#
# Also emits ANSI color codes on purpose, to exercise log capture's ANSI
# stripping (EDA tools and Makefiles commonly colorize their output).
set -uo pipefail

FAIL=0
for arg in "$@"; do
  case "$arg" in
    --fail) FAIL=1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TB_FILE="$SCRIPT_DIR/../tb/scoreboard.sv"
RTL_FILE="$SCRIPT_DIR/../rtl/dut.sv"

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
RESET='\033[0m'

log() {
  echo -e "$1"
  sleep 0.2
}

log "UVM_INFO @ 0: reporter [RNTST] Running test uvm_test_top..."
log "UVM_INFO ${TB_FILE}(11) @ 0: uvm_test_top.env [BUILD] Building environment"
log "UVM_INFO ${TB_FILE}(29) @ 100: uvm_test_top.env.agent.driver [DRV] Driver started"
log "UVM_INFO ${TB_FILE}(44) @ 250: uvm_test_top.env.agent.monitor [MON] Monitor started"

for i in $(seq 1 5); do
  log "UVM_INFO ${RTL_FILE}(20) @ $((i * 100)): uvm_test_top.env.scoreboard [SB] Transaction $i checked"
done

warnings=1
log "${YELLOW}UVM_WARNING${RESET} ${RTL_FILE}(34) @ 550: uvm_test_top.env.scoreboard [SB] Latency higher than expected (12ns)"

errors=0
if [ "$FAIL" -eq 1 ]; then
  errors=2
  log "${RED}UVM_ERROR${RESET} ${RTL_FILE}(41) @ 700: uvm_test_top.env.scoreboard [SB] Data mismatch: expected 32'hDEAD_BEEF got 32'h0000_0000"
  log "${RED}UVM_ERROR${RESET} ${TB_FILE}(51) @ 900: uvm_test_top.env.scoreboard [SB] Data mismatch: expected 32'hCAFE_F00D got 32'hFFFF_FFFF"
fi

log ""
log "--- UVM Report Summary ---"
log ""
log "** Report counts by severity"
log "UVM_INFO :   12"
log "UVM_WARNING :    ${warnings}"
log "UVM_ERROR :    ${errors}"
log "UVM_FATAL :    0"
log ""

if [ "$errors" -gt 0 ]; then
  echo -e "${RED}** TEST FAILED **${RESET}"
  exit 1
fi
echo -e "${GREEN}** TEST PASSED **${RESET}"
exit 0
