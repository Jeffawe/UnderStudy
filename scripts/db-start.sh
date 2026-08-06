#!/usr/bin/env bash
# Start the local CockroachDB node DETACHED so it survives the shell that
# launched it. Without nohup+disown the node dies with the parent process,
# which means every new terminal session finds the database gone.
#
#   ./scripts/db-start.sh     start (no-op if already running)
#   ./scripts/db-stop.sh      stop
#
# Admin UI is on 8081, not 8080 — 8080 is taken by a PHP process.

set -euo pipefail
cd "$(dirname "$0")/.."

if pgrep -f "cockroach start-single-node" >/dev/null; then
  echo "already running"
  exit 0
fi

mkdir -p .understudy/tmp
nohup cockroach start-single-node \
  --insecure \
  --listen-addr=localhost:26257 \
  --http-addr=localhost:8081 \
  --store=./cockroach-data \
  >.understudy/tmp/cockroach.log 2>&1 &
disown

for _ in $(seq 1 30); do
  if cockroach sql --insecure -e "SELECT 1;" >/dev/null 2>&1; then
    echo "up — sql localhost:26257 · ui http://localhost:8081"
    exit 0
  fi
  sleep 1
done

echo "failed to come up; see .understudy/tmp/cockroach.log" >&2
exit 1
