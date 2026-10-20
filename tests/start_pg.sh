#!/bin/bash
# Start (or create) the throw-away PostgreSQL 16 used ONLY for tests (port 54329, socket /tmp).
# Never points at the real Supabase project.
set -e
PGDATA="${PGDATA:-/home/claude/tests/pgdata}"
BIN=/usr/lib/postgresql/16/bin
if pg_isready -h /tmp -p 54329 -q 2>/dev/null; then echo "test postgres: running"; exit 0; fi
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA"; chown -R postgres "$PGDATA"
  su postgres -c "$BIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
fi
su postgres -c "$BIN/pg_ctl -D $PGDATA -o '-p 54329 -k /tmp' -l $PGDATA/server.log start" >/dev/null || true
sleep 2
pg_isready -h /tmp -p 54329 && echo "test postgres: started"
