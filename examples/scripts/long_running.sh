#!/usr/bin/env bash
# Never finishes on its own — use this to test Stop (process-group kill) and
# the live elapsed-time ticker in the sidebar. Traps SIGTERM to show that the
# graceful signal (not just SIGKILL) actually reaches the job.
trap 'echo "caught SIGTERM, shutting down cleanly"; exit 143' TERM

i=0
while true; do
  i=$((i + 1))
  echo "tick $i at $(date +%T)"
  sleep 2
done
