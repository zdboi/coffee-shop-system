#!/bin/bash
# (Re)start ONE local Supabase stand-in. It serves the repo's files and talks to a local
# test database — never to the real Supabase.
#
# Usage: tests/restart_fake.sh [port] [database]      defaults: 8787  cccc
#   Only the stand-in listening on <port> is stopped and started again; stand-ins on other
#   ports are never touched. Log: tests/fake-<port>.log
#   Example (Back Office developer):  tests/e2e_reset.sh db_bo && tests/restart_fake.sh 8791 db_bo
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8787}"
DB="${2:-cccc}"
LOG="$DIR/fake-$PORT.log"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "restart_fake: port must be a number from 1024 to 65535 (got '$PORT')" >&2; exit 1
fi
if ! [[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "restart_fake: database name must be lowercase letters, digits or _ (got '$DB')" >&2; exit 1
fi
if [ "$(psql -h /tmp -p 54329 -U postgres -d postgres -Atqc "select 1 from pg_database where datname = '$DB'" 2>/dev/null)" != "1" ]; then
  echo "restart_fake: test database '$DB' not found (or test postgres not running) - run tests/e2e_reset.sh $DB first" >&2; exit 1
fi

# pids listening on this TCP port (and nothing else)
listeners(){ lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u; }

for pid in $(listeners); do
  if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "fake-supabase/server\.js"; then
    kill "$pid" 2>/dev/null
  else
    echo "restart_fake: port $PORT is used by another program (pid $pid), not a stand-in - pick another port" >&2; exit 1
  fi
done
for _ in $(seq 1 50); do [ -z "$(listeners)" ] && break; sleep 0.1; done
for pid in $(listeners); do kill -9 "$pid" 2>/dev/null; done   # still there after 5 s
sleep 0.2

PORT="$PORT" FAKE_DB="$DB" nohup node "$DIR/fake-supabase/server.js" > "$LOG" 2>&1 &
NEW=$!

code=000
for _ in $(seq 1 50); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/cccc/front/")
  [ "$code" = "200" ] && break
  kill -0 "$NEW" 2>/dev/null || break
  sleep 0.1
done
if [ "$code" != "200" ]; then
  echo "restart_fake: stand-in on port $PORT did not start (HTTP $code) - see $LOG" >&2
  tail -5 "$LOG" >&2; exit 1
fi
echo "fake supabase: HTTP $code on http://localhost:$PORT (database $DB, pid $NEW, log $LOG)"
