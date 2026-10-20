#!/bin/bash
# Concurrency checks: two sessions at the same moment (adopted from the database engineer's conc_checks.sh).
#   (a) two Back Office refunds of ₱100 on the same ₱150 sale -> only one may pass
#   (b) two counters paying the same QR order -> only one may pass
# Needs the data left by tests/sql/32_fix_round_tests.sql, so run right after it on the same database:
#   tests/reset_db.sh "" cccc && psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1 -f tests/sql/32_fix_round_tests.sql
#   tests/conc_checks.sh cccc
# Prints "ok ..." / "FAIL ..." lines; exit code 0 only when every check passed.
set -u
DB="${1:-cccc}"
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "database name must be plain lowercase"; exit 2; }
S=$(mktemp -d "${TMPDIR:-/tmp}/cccc-conc.XXXXXX")
export PGOPTIONS="-c client_min_messages=warning"
P="psql -h /tmp -p 54329 -U postgres -d $DB -At -v ON_ERROR_STOP=1"
FAILS=0
check(){ if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3   [got: $1, want: $2]"; FAILS=$((FAILS+1)); fi; }

QID=$($P -c "select id from qr_orders where status='PENDING' and sale_id is null and business_id=(select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1') order by created_at desc limit 1")
[ -n "$QID" ] || { echo "FAIL no pending QR order (run tests/sql/32_fix_round_tests.sql first)"; exit 1; }
bo(){ # refund id, seconds to hold the transaction open
  $P <<SQL
begin;
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select 'BO $1: ' || test.bo(test.bo_refund('$1', '99999999-0000-0000-0000-000000000008', 'PARTIAL_REFUND', 100, '[]'));
select pg_sleep($2);
commit;
SQL
}
qr(){ # login, counter key, sale id, seconds to hold the transaction open
  $P <<SQL
begin;
select test.login('$1');
set role authenticated;
select 'QR $3: ' || test.qr_sale('$2', '$3', '$QID', null);
select pg_sleep($4);
commit;
SQL
}
# (a) two owner refunds at once
bo dddddddd-0000-0000-0000-00000000cc01 3 > "$S/a.txt" 2>&1 &
sleep 1
bo dddddddd-0000-0000-0000-00000000cc02 0 > "$S/b.txt" 2>&1
wait
cat "$S/a.txt" "$S/b.txt" | grep -E '^BO|ERROR' | sed 's/^/     /'
n_ok=$(cat "$S/a.txt" "$S/b.txt" | grep -cE '^BO .*: ok$')
check "$n_ok" 1 "two ₱100 owner refunds of one ₱150 sale at the same moment: exactly one accepted"
check "$($P -c "select count(*) || '/' || coalesce(sum(amount),0)::numeric(12,2) from refunds where sale_id='99999999-0000-0000-0000-000000000008'")" "1/100.00" "the sale has one refund of ₱100"
# (b) two counters pay one QR order at once (counter A = login e1 after its re-pairing, counter B = d2)
qr 00000000-0000-0000-0000-0000000000e1 device-key-0001-abcdef 99999999-0000-0000-0000-0000000000f1 3 > "$S/c.txt" 2>&1 &
sleep 1
qr 00000000-0000-0000-0000-0000000000d2 device-key-0002-abcdef 99999999-0000-0000-0000-0000000000f2 0 > "$S/d.txt" 2>&1
wait
cat "$S/c.txt" "$S/d.txt" | grep -E '^QR|ERROR' | sed 's/^/     /'
check "$(cat "$S/c.txt" "$S/d.txt" | grep -cE '^QR .*: ok$')" 1 "two counters paying one QR order at the same moment: exactly one accepted"
check "$(cat "$S/c.txt" "$S/d.txt" | grep -cE '^QR .*: QR_ORDER_ALREADY_PAID$')" 1 "... the other is told QR_ORDER_ALREADY_PAID"
check "$($P -c "select count(*) from sales where qr_order_id='$QID' and status='COMPLETED'")" 1 "one completed sale for that QR order"
check "$($P -c "select sale_id from qr_orders where id='$QID'")" 99999999-0000-0000-0000-0000000000f1 "the order points at the first counter's sale"
rm -rf "$S"
N=6
echo "SUMMARY conc_checks: $N checks, $FAILS failed"
[ "$FAILS" -eq 0 ]
