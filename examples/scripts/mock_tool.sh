#!/usr/bin/env bash
# A synthetic, but genuinely runnable and genuinely scannable, dispatcher-
# style CLI -- specifically so Tool Setup's real "Scan" pipeline (spawn
# the command, parse real --help output) has something to exercise beyond
# the two already-installed real tools (dsim, verilator) this workspace
# happens to have. Register this exact path in Tool Setup and click Scan
# to see it for yourself, rather than trusting a hand-written JSON fixture.
#
# `mock_tool.sh --help` prints a dispatcher-shaped usage line
# (`{compile,sim,report}`) that Tool Setup auto-detects as three variants.
# Each subcommand has its own `--help` with a different parser-exercising
# shape:
#   compile  -- plain GNU-style flags (metavars, a repeatable-looking one)
#   sim      -- a value-taking flag with a NON-standard seed spelling
#               (--rng-init, deliberately not one of the built-in
#               patterns in seedDetect.ts) plus an argparse choices=
#               metavar (renders as a dropdown, not free text)
#   report   -- almost no flags, to show a variant can be this simple
#
# Running `sim`/`compile`/`report` for real (without --help) actually
# executes a short mock run and echoes back whichever flags it was given,
# so a job built against this tool produces real, inspectable output.
set -uo pipefail

SUBCOMMAND="${1:-}"
[ $# -gt 0 ] && shift

usage_top() {
  cat <<'EOF'
usage: mock_tool.sh {compile,sim,report} [options]

A synthetic EDA-style dispatcher tool for exercising this extension's Tool
Setup scanner -- not a real simulator.

commands:
  compile               Compile the design
  sim                    Run a simulation
  report                Show the last run's summary

  -h, --help             show this help message and exit
EOF
}

usage_compile() {
  cat <<'EOF'
usage: mock_tool.sh compile [options]

options:
  -o OUTPUT, --output OUTPUT    Output directory for compiled objects
  -I DIR, --include DIR         Additional include directory
  -v, --verbose                 Verbose compile output
  -j N, --jobs N                Number of parallel compile jobs
  -h, --help                    show this help message and exit
EOF
}

usage_sim() {
  cat <<'EOF'
usage: mock_tool.sh sim [options]

options:
  -t TEST, --test TEST                    Test name to run
  --rng-init SEED                         Seed the run's random number generator
  --std {v1995,v2001,v2005,v2012}          SystemVerilog standard to compile against
  --gui                                   Launch waveform viewer
  --parallel N                            Number of parallel simulation jobs
  -o OUTPUT, --output OUTPUT               Log output directory
  -h, --help                              show this help message and exit
EOF
}

usage_report() {
  cat <<'EOF'
usage: mock_tool.sh report [options]

options:
  -h, --help             show this help message and exit
EOF
}

case "$SUBCOMMAND" in
  --help|-h|"")
    usage_top
    exit 0
    ;;
  compile)
    for a in "$@"; do
      if [ "$a" = "--help" ] || [ "$a" = "-h" ]; then usage_compile; exit 0; fi
    done
    echo "mock_tool: compiling with args: $*"
    sleep 0.5
    echo "mock_tool: compile finished, 0 errors"
    exit 0
    ;;
  sim)
    for a in "$@"; do
      if [ "$a" = "--help" ] || [ "$a" = "-h" ]; then usage_sim; exit 0; fi
    done
    echo "mock_tool: sim starting with args: $*"
    sleep 0.3
    echo "mock_tool: elaborating..."
    sleep 0.5
    echo "mock_tool: running..."
    sleep 0.5
    echo "mock_tool: RESULT: PASS"
    exit 0
    ;;
  report)
    for a in "$@"; do
      if [ "$a" = "--help" ] || [ "$a" = "-h" ]; then usage_report; exit 0; fi
    done
    echo "mock_tool: last run summary -- 1 test, 0 failures"
    exit 0
    ;;
  *)
    echo "mock_tool: unknown command '$SUBCOMMAND' (expected compile|sim|report)" >&2
    exit 2
    ;;
esac
