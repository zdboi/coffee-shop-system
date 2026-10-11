#!/bin/bash
# Build a throw-away test database:
#   Supabase stand-in (00) + reconstruction of the LIVE schema (01) + ONE 004 migration.
# Usage: tests/reset_db.sh [path/to/migration.sql] [database-name]
#   default migration: cccc/supabase/004_cccc_online_qr.sql   default database: cccc
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$DIR")"
MIG="${1:-$REPO/cccc/supabase/004_cccc_online_qr.sql}"
DB="${2:-cccc}"
"$DIR/start_pg.sh" >/dev/null
P="psql -h /tmp -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
psql -h /tmp -p 54329 -U postgres -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null
psql -h /tmp -p 54329 -U postgres -q -d "$DB" -f "$DIR/sql/00_supabase_stub.sql" 2>&1 | grep -vE "already exists|already been granted|NOTICE" || true
$P -d "$DB" -f "$DIR/sql/01_existing_schema.sql"
$P -d "$DB" -f "$MIG"
echo "test db '$DB' ready with $(basename "$MIG")"
