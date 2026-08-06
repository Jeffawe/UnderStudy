#!/usr/bin/env bash
# Talk to whichever CockroachDB target is selected, and always say which one.
#
#   ./scripts/db.sh                      → interactive SQL shell on the default target
#   ./scripts/db.sh -e "SELECT 1;"       → run a statement
#   ./scripts/db.sh -f db/schema.sql     → run a file
#   TARGET=cloud ./scripts/db.sh ...     → override for one command
#
# Default target comes from UNDERSTUDY_TARGET in .env.
# The banner is not decoration: the failure mode this prevents is running the
# right command against the wrong database.

set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "no .env — copy .env.example and fill it in" >&2; exit 1; }
set -a; source .env; set +a

TARGET="${TARGET:-${UNDERSTUDY_TARGET:-local}}"

case "$TARGET" in
  local) URL="$CRDB_LOCAL_URL"; COLOR=$'\033[32m' ;;   # green
  cloud) URL="$CRDB_URL";       COLOR=$'\033[33m' ;;   # amber — you are on shared infra
  *)     echo "TARGET must be 'local' or 'cloud', got '$TARGET'" >&2; exit 1 ;;
esac

[ -n "${URL:-}" ] || { echo "no connection string for target '$TARGET' in .env" >&2; exit 1; }

# Host without credentials, so the banner is safe to screenshot.
HOST=$(printf '%s' "$URL" | sed -E 's#.*@([^/?]+).*#\1#')
printf '%s▸ %s  %s\033[0m\n' "$COLOR" "$(echo "$TARGET" | tr '[:lower:]' '[:upper:]')" "$HOST" >&2

exec cockroach sql --url "$URL" "$@"
