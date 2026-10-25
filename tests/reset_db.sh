#!/bin/bash
# Build a throw-away test database:
#   Supabase stand-in (00) + reconstruction of the LIVE schema (01, incl. the live CHECK rules)
#   + the scripts the owner ran on live, in the live order: 004, then 005, then 006, then 007 (batch 1, not yet on live).
# Usage: tests/reset_db.sh [path/to/migration.sql] [database-name]
#   no migration (or ""): 004 + 005 + 006 (what live has) + 007   default database: cccc
#   a migration path:     ONLY that script on top of 01 (e.g. to try a single script)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$DIR")"
SUP="$REPO/cccc/supabase"
if [ -n "${1:-}" ]; then MIGS=("$1")
else MIGS=("$SUP/004_cccc_online_qr.sql" "$SUP/005_live_fixes.sql" "$SUP/006_live_fix_sync_operations.sql" "$SUP/007_batch1.sql"); fi
DB="${2:-cccc}"
if ! [[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || [[ "$DB" =~ ^(postgres|template0|template1)$ ]]; then
  echo "reset_db: bad database name '$DB' (lowercase letters, digits, _; not a system database)" >&2; exit 1
fi
"$DIR/start_pg.sh" >/dev/null
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"   # hide "already exists, skipping" notices
P="psql -h /tmp -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
psql -h /tmp -p 54329 -U postgres -q -c "drop database if exists $DB with (force)" -c "create database $DB" >/dev/null
psql -h /tmp -p 54329 -U postgres -q -d "$DB" -f "$DIR/sql/00_supabase_stub.sql" 2>&1 | grep -vE "already exists|already been granted|NOTICE" || true
$P -d "$DB" -f "$DIR/sql/01_existing_schema.sql"
names=()
for m in "${MIGS[@]}"; do $P -d "$DB" -f "$m"; names+=("$(basename "$m")"); done
echo "test db '$DB' ready with ${names[*]}"
