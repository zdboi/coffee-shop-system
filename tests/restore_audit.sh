#!/bin/bash
# Part 3 audit G3 (Z): backup -> restore drill on two throw-away databases (never the real Supabase).
#   1. source shop: fresh seed + the money suites (sales with options, discounts, Senior/PWD, charges,
#      refunds, shifts, cash) as data makers, plus investors and start-up costs;
#   2. tests/e2e/bo_restore_audit.e2e.js: Back Office backup of that shop -> import into a NEW empty
#      shop on an empty database -> compare.
# Usage: tests/restore_audit.sh [port]     default port 8787 (QA's; run when run_all.sh is not running)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8787}"; SRC=db_rev_rsrc; DST=db_rev_rdst
export PGOPTIONS="-c client_min_messages=warning"
export QA_SHOTS="${QA_SHOTS:-${TMPDIR:-/tmp}/cccc-qa-shots}"
"$DIR/e2e_reset.sh" "$SRC" > /dev/null || { echo "SUMMARY restore_audit: 1 checks, 1 failed (source reset)"; exit 1; }
"$DIR/reset_db.sh" "" "$DST" > /dev/null || { echo "SUMMARY restore_audit: 1 checks, 1 failed (target reset)"; exit 1; }
"$DIR/restart_fake.sh" "$PORT" "$SRC" > /dev/null || exit 1
# data makers (their own checks are not counted here)
for s in money16.e2e.js money14.e2e.js; do
  FAKE_PORT=$PORT FAKE_DB=$SRC timeout 900 node "$DIR/e2e/$s" > "$QA_SHOTS/restore_audit_maker_${s%.js}.log" 2>&1 || echo "# data maker $s did not pass all its checks (see $QA_SHOTS/restore_audit_maker_${s%.js}.log); data is still used"
done
psql -h /tmp -p 54329 -U postgres -d "$SRC" -q -v ON_ERROR_STOP=1 -c "
  insert into investors(business_id, name, amount, invested_on) select business_id, n, a, current_date - 30
    from profiles, (values ('Investor One', 50000), ('Investor Two', 30000)) v(n, a) where id = '00000000-0000-0000-0000-0000000000a1';
  insert into startup_costs(business_id, name, amount) select business_id, 'Espresso machine', 85000 from profiles where id = '00000000-0000-0000-0000-0000000000a1';"
FAKE_PORT=$PORT SRC_DB=$SRC DST_DB=$DST FAKE_DB=$SRC node "$DIR/e2e/bo_restore_audit.e2e.js"
