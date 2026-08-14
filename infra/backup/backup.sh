#!/usr/bin/env bash
#
# Local backup of the three stateful stores that matter:
#   MongoDB    (tropis_mongodb)    → mongodump archive
#   PostgreSQL (tropis_postgres)   → pg_dump custom-format dump
#   ClickHouse (tropis_clickhouse) → per-table native-format exports of the `logs` DB
#
# NOT backed up (rebuildable / derived):
#   Redis (cache), Pulsar (transient events — outbox in Mongo is the source of
#   truth), Elasticsearch (re-indexable from Mongo), Aerospike (sessions),
#   MinIO (use `mc mirror` separately if uploads matter), Temporal Postgres.
#
# Output: ./backups/<UTC timestamp>/  (relative to the repo root)
# Restore: infra/backup/restore.sh <timestamp>
#
# Optional S3/MinIO sync: set MC_ALIAS (a configured `mc` alias, e.g.
# `mc alias set backup https://s3... KEY SECRET`) and the whole timestamp dir
# is mirrored to ${MC_ALIAS}/${MC_BUCKET:-backups}/.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TS="$(date -u +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR:-$REPO_ROOT/backups}/$TS"

MONGO_CONTAINER="${MONGO_CONTAINER:-tropis_mongodb}"
PG_CONTAINER="${PG_CONTAINER:-tropis_postgres}"
CH_CONTAINER="${CH_CONTAINER:-tropis_clickhouse}"
PG_USER="${PG_USER:-tropis}"
PG_DB="${PG_DB:-tropis}"
CH_DB="${CH_DB:-logs}"

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

mkdir -p "$DEST"
echo "==> Backing up to $DEST"

# ── MongoDB ──────────────────────────────────────────────────────────
echo "==> MongoDB (mongodump)"
docker exec "$MONGO_CONTAINER" mongodump --quiet --archive --gzip \
  > "$DEST/mongodb.archive.gz"

# ── PostgreSQL ───────────────────────────────────────────────────────
echo "==> PostgreSQL (pg_dump, custom format)"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc \
  > "$DEST/postgres-${PG_DB}.dump"

# ── ClickHouse ───────────────────────────────────────────────────────
# Pragmatic per-table export: Native format preserves types exactly and
# restores with a plain INSERT. Schemas are saved as SHOW CREATE TABLE.
echo "==> ClickHouse (native export of database '$CH_DB')"
mkdir -p "$DEST/clickhouse"
TABLES=$(docker exec "$CH_CONTAINER" clickhouse-client --query \
  "SELECT name FROM system.tables WHERE database='${CH_DB}' AND engine NOT LIKE '%View%'")
for t in $TABLES; do
  echo "    - ${CH_DB}.${t}"
  docker exec "$CH_CONTAINER" clickhouse-client --query \
    "SHOW CREATE TABLE ${CH_DB}.${t} FORMAT TSVRaw" \
    > "$DEST/clickhouse/${t}.schema.sql"
  docker exec "$CH_CONTAINER" clickhouse-client --query \
    "SELECT * FROM ${CH_DB}.${t} FORMAT Native" \
    > "$DEST/clickhouse/${t}.native"
done

echo "==> Done:"
du -sh "$DEST"/* | sed 's/^/    /'

# ── Optional: sync to S3/MinIO via mc ───────────────────────────────
if [ -n "${MC_ALIAS:-}" ]; then
  echo "==> Syncing to ${MC_ALIAS}/${MC_BUCKET:-backups}/$TS"
  mc mirror "$DEST" "${MC_ALIAS}/${MC_BUCKET:-backups}/$TS"
fi
# To enable: mc alias set backup https://s3.example.com ACCESS_KEY SECRET_KEY
#            MC_ALIAS=backup MC_BUCKET=backups ./infra/backup/backup.sh

echo "==> Backup complete: $TS"
