#!/usr/bin/env bash
# Apply the schema to one target. Same file to both — schema.sql is the only
# source of truth, so local and cloud cannot drift.
#
#   ./scripts/apply-schema.sh            → default target from .env
#   TARGET=cloud ./scripts/apply-schema.sh
#
# Idempotent: every statement is CREATE ... IF NOT EXISTS, so re-running is safe.
# It will NOT alter an existing table — for a shape change, reset the database.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "== enabling vector indexes (once per cluster; harmless if already on) =="
./scripts/db.sh -f db/00-enable-vector.sql || \
  echo "   ! could not set it — checking whether it's already enabled" >&2
./scripts/db.sh -e "SHOW CLUSTER SETTING feature.vector_index.enabled;"

echo
echo "== applying schema =="
./scripts/db.sh -f db/schema.sql

echo
echo "== verifying =="
./scripts/db.sh -e "SELECT count(*) AS tables FROM [SHOW TABLES];"
./scripts/db.sh -e "SELECT index_name FROM [SHOW INDEXES FROM memory_chunks] WHERE index_name = 'mc_embed_idx' LIMIT 1;"
