#!/usr/bin/env bash
# Stop the local CockroachDB node started by db-start.sh.
#
#   ./scripts/db-stop.sh      stop (no-op if not running)
#   ./scripts/db-start.sh     start
#
# Sends SIGTERM first so CockroachDB shuts down cleanly (flushes, releases the
# store lock) rather than getting SIGKILLed mid-write.

set -euo pipefail

PID="$(pgrep -f "cockroach start-single-node" || true)"

if [ -z "$PID" ]; then
  echo "not running"
  exit 0
fi

kill "$PID"

for _ in $(seq 1 15); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "stopped"
    exit 0
  fi
  sleep 1
done

echo "still running after 15s — sending SIGKILL" >&2
kill -9 "$PID" 2>/dev/null || true
echo "stopped (forced)"
