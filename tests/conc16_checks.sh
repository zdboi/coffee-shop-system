#!/bin/bash
# Release 1.6 concurrency checks (Z, 2026-11-13): two sessions at the same moment.
#   (a) the same Senior / PWD sale uploaded twice at once (an upload retried while the first is still running), with
#       different names -> ONE sale, ONE record (the first one's name), the other upload refused or skipped
#   (b) two partial refunds of the same Senior line at once, each for that line's full share -> only one passes;
#       the sale's refunds never exceed what was paid
# Needs the data left by tests/sql/43_release_1_6_tests.sql, so run right after it on the same database:
#   tests/reset_db.sh "" cccc; P="psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1"
#   $P -f tests/sql/10_behaviour_tests.sql && $P -f tests/sql/11_qr_tests.sql && $P -f tests/sql/43_release_1_6_tests.sql
#   tests/conc16_checks.sh cccc
# Prints "ok ..." / "FAIL ..." lines and a SUMMARY line; exit code 0 only when every check passed.
set -u
DB="${1:-cccc}"
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "database name must be plain lowercase"; exit 2; }
S=$(mktemp -d "${TMPDIR:-/tmp}/cccc-conc16.XXXXXX")
export PGOPTIONS="-c client_min_messages=warning"
P="psql -h /tmp -p 54329 -U postgres -d $DB -v ON_ERROR_STOP=1 -Atq"
FAILS=0; N=0
check(){ N=$((N+1)); if [ "$1" = "$2" ]; then echo "ok  $3"; else echo "FAIL $3   [got: $1, expected: $2]"; FAILS=$((FAILS+1)); fi; }
DEV='{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}'
SH=c1600000-0000-0000-0000-0000000005e1; SALE=c1600000-0000-0000-0000-0000000000a1; LINE=c1600000-0000-0000-0000-0000000000b1
LOGIN="select set_config('request.jwt.claims', '$DEV', false); select set_config('request.headers', '{}', false); set role authenticated;"
$P -c "update settings set tax_pct = 0, tax_inclusive = false, service_charge_pct = 0, senior_discount_pct = 20; delete from auth_attempts;" >/dev/null
st=$($P -c "$LOGIN" -c "select test.op('shift_open', jsonb_build_object('id','$SH','shift_number','SHIFT-C16-1','cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0))->>'status'" | tail -1)
check "$st" ok "set-up: shift opened"
ITEMS='[{"id":"'$LINE'","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30}]'
X='{"subtotal":150,"service_charge_amount":0,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"grand_total":120}'

# ---------- (a) the same Senior sale twice at once ----------
cat > "$S/a.sql" <<SQL
$LOGIN
begin;
select 'A ' || (test.sale16('$SALE', '$ITEMS', '$X', 'CASH', '{"kind":"SENIOR","holder_name":"First Upload","id_number":"SC-A-1"}', '$SH')::text);
select pg_sleep(2);
commit;
SQL
cat > "$S/b.sql" <<SQL
select pg_sleep(0.6);
$LOGIN
select 'B ' || (test.sale16('$SALE', '$ITEMS', '$X', 'CASH', '{"kind":"SENIOR","holder_name":"Second Upload","id_number":"SC-B-2"}', '$SH')::text);
SQL
$P -f "$S/a.sql" > "$S/a.out" 2>&1 &
$P -f "$S/b.sql" > "$S/b.out" 2>&1
wait
check "$($P -c "select count(*) from sales where id = '$SALE'")|$($P -c "select count(*) || ':' || string_agg(holder_name, ',') from senior_discount_records where sale_id = '$SALE'")" "1|1:First Upload" "same Senior sale uploaded twice at once -> one sale, one record (the first upload's name)"
bst=$(grep '^B ' "$S/b.out" | sed 's/^B //' | $P -c "select (\$\$$(grep '^B ' "$S/b.out" | sed 's/^B //')\$\$::jsonb)->>'status'" 2>/dev/null)
case "$bst" in error|skipped) bres=refused ;; *) bres="$bst" ;; esac
check "$bres" refused "... the second upload is refused or skipped, not saved twice  ($(grep -h '^[AB] ' "$S/a.out" "$S/b.out" | tr '\n' ' ' | cut -c1-200))"

# ---------- (b) two refunds of the same Senior line at once ----------
cat > "$S/r.sql" <<'SQL'
create or replace function test.c16_refund(p_id uuid, p_amount numeric) returns text language sql as $f$
  select (test.op('refund', jsonb_build_object('refund', jsonb_build_object('id', p_id, 'sale_id', 'c1600000-0000-0000-0000-0000000000a1', 'type', 'PARTIAL_REFUND',
     'amount', p_amount, 'items', '[{"sale_item_id":"c1600000-0000-0000-0000-0000000000b1","quantity":1}]'::jsonb,
     'approved_by','66666666-0000-0000-0000-000000000002','performed_by','66666666-0000-0000-0000-000000000002','date', now()),
     'approval_token', (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token', 'inventory', '[]'::jsonb)))::text
$f$;
grant execute on function test.c16_refund(uuid, numeric) to authenticated;
SQL
$P -f "$S/r.sql" >/dev/null
$P -c "delete from auth_attempts" >/dev/null
cat > "$S/r1.sql" <<SQL
$LOGIN
begin;
select 'R1 ' || test.c16_refund('c1600000-0000-0000-0000-0000000000f1', 120);
select pg_sleep(2);
commit;
SQL
cat > "$S/r2.sql" <<SQL
select pg_sleep(0.6);
$LOGIN
select 'R2 ' || test.c16_refund('c1600000-0000-0000-0000-0000000000f2', 120);
SQL
$P -f "$S/r1.sql" > "$S/r1.out" 2>&1 &
$P -f "$S/r2.sql" > "$S/r2.out" 2>&1
wait
check "$($P -c "select count(*) || '|' || coalesce(sum(amount), 0) from refunds where sale_id = '$SALE'")" "1|120" "two refunds of the same Senior line at once -> one passes; refunded 120 = what was paid  ($(grep -h '^R[12] ' "$S/r1.out" "$S/r2.out" | tr '\n' ' ' | cut -c1-240))"
rm -rf "$S"
echo "SUMMARY conc16_checks: $N checks, $FAILS failed"
[ $FAILS -eq 0 ]
