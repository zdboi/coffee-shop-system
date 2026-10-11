#!/bin/bash
# Full regression for the cccc/ build: database behaviour tests + Front Office browser test.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "== database behaviour tests"
"$DIR/reset_db.sh" >/dev/null
psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1 -f "$DIR/sql/10_behaviour_tests.sql" 2>&1 | grep -E "^ok|ASSERT|ERROR" | tail -3
psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1 -f "$DIR/sql/11_qr_tests.sql" 2>&1 | grep -E "ASSERT|ERROR|PASSED"
echo "== front office browser test"
"$DIR/e2e_reset.sh" >/dev/null
"$DIR/restart_fake.sh" >/dev/null
node "$DIR/e2e/fo.e2e.js" 2>&1 | tail -3
