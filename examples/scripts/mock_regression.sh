#!/usr/bin/env bash
# A longer, multi-test mock regression (~25-30s), for exercising the live
# log viewer / elapsed-time ticker / Stop over something more substantial
# than mock_uvm_sim.sh's ~2s single run. Streams output incrementally
# (each line lands with a real sleep between it and the next) rather than
# printing everything at once, so "Follow Running Log" / the status bar's
# ticking elapsed time actually has something to show while it runs.
#
# Runs 5 sub-tests in sequence, each with its own UVM-shaped
# build/elaborate/run phases and its own seed (real: takes the seed as
# $1, e.g. from a job command's `${randomSeed}` -- see the "Regression
# (longer, ~25s)" job). Pass --fail to make the 4th sub-test fail with a
# real UVM_ERROR and a non-zero exit code; otherwise every sub-test
# passes and the script exits 0.
set -uo pipefail

SEED="${1:-1}"
FAIL=0
for arg in "$@"; do
  case "$arg" in
    --fail) FAIL=1 ;;
  esac
done

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RESET='\033[0m'

log() {
  echo -e "$1"
  sleep "${2:-0.3}"
}

TESTS=(smoke_test alu_random mem_stress interrupt_stress corner_case_wrap)

log "${CYAN}=== Mock Regression: 5 tests, seed=${SEED} ===${RESET}" 0.2
log "UVM_INFO @ 0: reporter [RNTST] Compiling testbench..." 0.8
log "UVM_INFO @ 0: reporter [RNTST] Elaborating design..." 1.0

total_errors=0
total_warnings=0
test_num=0

for t in "${TESTS[@]}"; do
  test_num=$((test_num + 1))
  test_seed=$((SEED + test_num))
  log ""
  log "${CYAN}--- [$test_num/${#TESTS[@]}] Running test: ${t} (seed=${test_seed}) ---${RESET}" 0.3
  log "UVM_INFO @ 0: reporter [RNTST] Running test uvm_test_top (${t})..." 0.5
  log "UVM_INFO tb/scoreboard.sv(11) @ 0: uvm_test_top.env [BUILD] Building environment" 0.4
  log "UVM_INFO tb/scoreboard.sv(29) @ 100: uvm_test_top.env.agent.driver [DRV] Driver started, seed=${test_seed}" 0.4

  # A handful of transaction-check lines per test, paced to feel like a
  # real simulation actually making progress rather than a canned burst.
  n_transactions=$((4 + (test_seed % 4)))
  for i in $(seq 1 "$n_transactions"); do
    log "UVM_INFO rtl/dut.sv(20) @ $((i * 137)): uvm_test_top.env.scoreboard [SB] Transaction $i checked (${t})" 0.35
  done

  # Test 3 (mem_stress) always throws in one benign warning, for variety.
  if [ "$test_num" -eq 3 ]; then
    total_warnings=$((total_warnings + 1))
    log "${YELLOW}UVM_WARNING${RESET} rtl/dut.sv(34) @ 900: uvm_test_top.env.scoreboard [SB] FIFO occupancy near threshold (was this seed unlucky?)" 0.4
  fi

  # --fail makes test 4 (interrupt_stress) actually fail with real UVM_ERRORs.
  if [ "$FAIL" -eq 1 ] && [ "$test_num" -eq 4 ]; then
    total_errors=$((total_errors + 2))
    log "${RED}UVM_ERROR${RESET} rtl/dut.sv(41) @ 1100: uvm_test_top.env.scoreboard [SB] Data mismatch: expected 32'hDEAD_BEEF got 32'h0000_0000" 0.4
    log "${RED}UVM_ERROR${RESET} tb/scoreboard.sv(51) @ 1300: uvm_test_top.env.scoreboard [SB] Interrupt not observed within timeout" 0.4
    log "${RED}** TEST FAILED: ${t} **${RESET}" 0.3
  else
    log "${GREEN}** TEST PASSED: ${t} **${RESET}" 0.3
  fi
done

log ""
log "${CYAN}--- UVM Report Summary (all ${#TESTS[@]} tests) ---${RESET}" 0.2
log "** Report counts by severity"
log "UVM_INFO :   $(( (test_num * 6) + 3 ))"
log "UVM_WARNING :    ${total_warnings}"
log "UVM_ERROR :    ${total_errors}"
log "UVM_FATAL :    0"
log ""

if [ "$total_errors" -gt 0 ]; then
  echo -e "${RED}** REGRESSION FAILED: ${total_errors} error(s) across ${#TESTS[@]} tests **${RESET}"
  exit 1
fi
echo -e "${GREEN}** REGRESSION PASSED: ${#TESTS[@]}/${#TESTS[@]} tests **${RESET}"
exit 0
