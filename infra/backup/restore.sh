#!/usr/bin/env bash
#
# Restore MongoDB, PostgreSQL, and ClickHouse from a backup created by
# infra/backup/backup.sh.
#
# Usage: infra/backup/restore.sh <timestamp>
#        (timestamp = directory name under ./backups/, e.g. 20260812-030000)
#
# DESTRUCTIVE: mongorestore --drop replaces collections, pg_restore --clean
# drops and recreates objects, ClickHouse tables are truncated before insert.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUPS="${BACKUP_DIR:-$REPO_ROOT/backups}"

MONGO_CONTAINER="${MONGO_CONTAINER:-tropis_mongodb}"
PG_CONTAINER="${PG_CONTAINER:-tropis_postgres}"
CH_CONTAINER="${CH_CONTAINER:-tropis_clickhouse}"
PG_USER="${PG_USER:-tropis}"
PG_DB="${PG_DB:-tropis}"
CH_DB="${CH_DB:-logs}"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <timestamp>" >&2
  echo "Available backups:" >&2
  ls -1 "$BACKUPS" 2>/dev/null | sed 's/^/  /' >&2 || echo "  (none)" >&2
  exit 1
fi

SRC="$BACKUPS/$1"
[ -d "$SRC" ] || { echo "ERROR: backup dir not found: $SRC" >&2; exit 1; }

require_running() {
  local name="$1"
  if [ -z "$(docker ps -q -f "name=^${name}$" -f status=running)" ]; then
    echo "ERROR: container '${name}' is not running — start it with 'make up' first." >&2
    exit 1
  fi
}

require_running "$MONGO_CONTAINER"
require_running "$PG_CONTAINER"
require_running "$CH_CONTAINER"

echo "About to restore from: $SRC"
echo "This DROPS and REPLACES data in MongoDB, PostgreSQL ($PG_DB), and ClickHouse ($CH_DB)."
read -r -p "Type 'yes' to continue: " CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "Aborted."; exit 1; }

# ── MongoDB ──────────────────────────────────────────────────────────
if [ -f "$SRC/mongodb.archive.gz" ]; then
  echo "==> MongoDB (mongorestore --drop)"
  docker exec -i "$MONGO_CONTAINER" mongorestore --quiet --archive --gzip --drop \
    < "$SRC/mongodb.archive.gz"
else
  echo "==> Skipping MongoDB (no mongodb.archive.gz in backup)"
fi

# ── PostgreSQL ───────────────────────────────────────────────────────
if [ -f "$SRC/postgres-${PG_DB}.dump" ]; then
  echo "==> PostgreSQL (pg_restore --clean)"
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" \
    --clean --if-exists --no-owner \
    < "$SRC/postgres-${PG_DB}.dump"
else
  echo "==> Skipping PostgreSQL (no postgres-${PG_DB}.dump in backup)"
fi

# ── ClickHouse ───────────────────────────────────────────────────────
if [ -d "$SRC/clickhouse" ]; then
  echo "==> ClickHouse (recreate + native insert)"
  docker exec "$CH_CONTAINER" clickhouse-client --query \
    "CREATE DATABASE IF NOT EXISTS ${CH_DB}"
  for schema in "$SRC/clickhouse/"*.schema.sql; do
    [ -e "$schema" ] || continue
    t="$(basename "$schema" .schema.sql)"
    echo "    - ${CH_DB}.${t}"
    docker exec -i "$CH_CONTAINER" clickhouse-client --multiquery < "$schema" \
      2>/dev/null || true   # table may already exist
    docker exec "$CH_CONTAINER" clickhouse-client --query \
      "TRUNCATE TABLE ${CH_DB}.${t}"
    docker exec -i "$CH_CONTAINER" clickhouse-client --query \
      "INSERT INTO ${CH_DB}.${t} FORMAT Native" \
      < "$SRC/clickhouse/${t}.native"
  done
else
  echo "==> Skipping ClickHouse (no clickhouse/ dir in backup)"
fi

echo "==> Restore complete from $1"
echo "    Verify: curl -s http://localhost:3100/api/health | jq ."
