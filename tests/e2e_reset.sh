#!/bin/bash
# Fresh 'cccc' test DB with the cccc/ migration + browser-test seed data.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/reset_db.sh" >/dev/null
psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1 -q -f "$DIR/sql/20_seed_e2e.sql"
echo "seeded"
