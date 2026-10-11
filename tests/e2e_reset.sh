#!/bin/bash
# Fresh test DB with the cccc/ migration + browser-test seed data.
# Usage: tests/e2e_reset.sh [database]      default database: cccc (QA's regression runs)
#   Use your own name for your own work, e.g.  tests/e2e_reset.sh db_bo
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DB="${1:-cccc}"
"$DIR/reset_db.sh" "" "$DB" >/dev/null
psql -h /tmp -p 54329 -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -f "$DIR/sql/20_seed_e2e.sql"
echo "seeded '$DB'"
