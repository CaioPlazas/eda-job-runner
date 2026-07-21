#!/usr/bin/env bash
# Produces far more output than the default 200 MB log cap in a hurry, to
# exercise EDA Job Runner's truncation behavior without needing a real
# long regression. Lower eda-job-runner.logMaxSizeMB in workspace settings
# to something small (e.g. 1) to see truncation kick in quickly.
for i in $(seq 1 200000); do
  echo "line $i: 0123456789abcdefghijklmnopqrstuvwxyz"
done
echo "done"
