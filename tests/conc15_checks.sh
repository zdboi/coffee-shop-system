#!/bin/bash
# Release 1.5 concurrency checks: two / three sessions at the same moment.
#   (a) two phones opening the same QR account at once (qr_relink) -> the account ends on ONE phone (the later
#       one), the other is told "signed out elsewhere"   (from the database work's db15-race.sh)
#   (b) B17: two owner edits and a delete of the same waste entry at once -> handled one after the other:
#       both edits audited, then deleted, stock exactly back, no stock line left behind   (Z, 2026-11-12)
# Needs the data left by tests/sql/42_release_1_5_tests.sql, so run right after it on the same database:
#   tests/reset_db.sh "" cccc; P="psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1"
#   $P -f tests/sql/10_behaviour_tests.sql && $P -f tests/sql/11_qr_tests.sql && $P -f tests/sql/42_release_1_5_tests.sql
#   tests/conc15_checks.sh cccc
# Prints "ok ..." / "FAIL ..." lines; exit code 0 only when every check passed.
set -u
DB="${1:-cccc}"
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "database name must be plain lowercase"; exit 2; }
S=$(mktemp -d "${TMPDIR:-/tmp}/cccc-conc15.XXXXXX")
export PGOPTIONS="-c client_min_messages=warning"
P="psql -h /tmp -p 54329 -U postgres -d $DB -v ON_ERROR_STOP=1 -Atq"
FAILS=0; N=0
check(){ N=$((N+1)); if [ "$1" = "$2" ]; then echo "ok  $3"; else echo "FAIL $3   [got: $1, expected: $2]"; FAILS=$((FAILS+1)); fi; }

# ---------- (a) relink race ----------
A=00000000-0000-0000-0000-0000000f1601; B=00000000-0000-0000-0000-0000000f1602
$P -c "insert into auth.users(id, is_anonymous) values ('$A', true), ('$B', true) on conflict do nothing; delete from auth_attempts; delete from customer_devices cd using customers c where c.id = cd.customer_id and c.nickname = 'Zed'; delete from qr_signout_notices;" >/dev/null
TOK=$($P -c "select qr_token from dining_tables where label = 'Table 5'")
cat > "$S/a.sql" <<SQL
select set_config('request.jwt.claims', '{"sub":"$A","role":"authenticated"}', false);
begin;
select public.qr_relink('$TOK', '0917 123 4567', 'Zed');
select pg_sleep(3);
commit;
SQL
cat > "$S/b.sql" <<SQL
select pg_sleep(1);
select set_config('request.jwt.claims', '{"sub":"$B","role":"authenticated"}', false);
select public.qr_relink('$TOK', '0917 123 4567', 'Zed');
SQL
$P -f "$S/a.sql" > "$S/a.out" 2>&1 &
$P -f "$S/b.sql" > "$S/b.out" 2>&1
wait
check "$($P -c "select string_agg(cd.auth_user_id::text, ',') from customer_devices cd join customers c on c.id = cd.customer_id where c.nickname = 'Zed'")" "$B" "relink race: two phones at once -> the account is on one phone (the later)"
check "$($P -c "select count(*) from qr_signout_notices where auth_user_id = '$A'")" 1 "... and the other phone is told it was signed out"

# ---------- (b) B17: two edits + a delete of one waste entry ----------
W=b1730000-0000-0000-0000-000000000001; BEANS=22222222-0000-0000-0000-000000000001
OWNER='{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}'
B0=$($P -c "select test.stock('$BEANS')")
st=$($P -c "select set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-0000-0000-0000000000d1\",\"role\":\"authenticated\"}', false);" -c "select test.op('waste', jsonb_build_object('id','$W','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001','items','[{\"ingredient_id\":\"$BEANS\",\"quantity\":10,\"unit\":\"g\"}]'::jsonb))->>'status'" | tail -1)
check "$st" ok "B17 race set-up: a counter waste entry (10 g beans)"
cat > "$S/e1.sql" <<SQL
select set_config('request.jwt.claims', '$OWNER', false);
begin;
select 'E1 ' || (public.revise_waste('{"id":"$W","edit_note":"A","items":[{"ingredient_id":"$BEANS","quantity":30,"unit":"g"}]}')->>'total_cost');
select pg_sleep(2);
commit;
SQL
cat > "$S/e2.sql" <<SQL
select pg_sleep(0.6);
select set_config('request.jwt.claims', '$OWNER', false);
select 'E2 ' || (public.revise_waste('{"id":"$W","edit_note":"B","items":[{"ingredient_id":"$BEANS","quantity":50,"unit":"g"}]}')->>'total_cost');
SQL
cat > "$S/e3.sql" <<SQL
select pg_sleep(1.2);
select set_config('request.jwt.claims', '$OWNER', false);
select 'E3 ' || (public.delete_waste('$W', 'C')->>'cost');
SQL
$P -f "$S/e1.sql" > "$S/e1.out" 2>&1 &
$P -f "$S/e2.sql" > "$S/e2.out" 2>&1 &
$P -f "$S/e3.sql" > "$S/e3.out" 2>&1
wait
cat "$S/e1.out" "$S/e2.out" "$S/e3.out" | grep -E '^E[123]|ERROR' | sed 's/^/     /'
check "$(grep -h '^E' "$S/e1.out" "$S/e2.out" "$S/e3.out" | sort | tr '\n' ',')" "E1 30.00,E2 50.00,E3 50.00," "B17 race: edit, edit, delete of one entry run one after the other (costs 30, 50, deleted at 50)"
check "$($P -c "select test.stock('$BEANS') - $B0")" 0.000000 "... stock exactly back"
check "$($P -c "select (select count(*) from inventory_transactions where reference_id = '$W') + (select count(*) from stock_line_owners where owner_id = '$W') + (select count(*) from waste_logs where id = '$W')")" 0 "... no entry, stock line or owner note left"
check "$($P -c "select string_agg(action || ':' || right(details, 1), ',' order by at) from audit_log where reference_id = '$W'")" "Waste edited:A,Waste edited:B,Waste deleted:C" "... three audit entries, in order"
rm -rf "$S"
echo "SUMMARY conc15_checks: $N checks, $FAILS failed"
[ "$FAILS" -eq 0 ]
