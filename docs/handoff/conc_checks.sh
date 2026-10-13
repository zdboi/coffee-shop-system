#!/bin/bash
# Two sessions at the same moment (run right after fix_checks.sql on db_sec):
#  (a) two Back Office refunds of ₱100 on the same ₱150 sale -> only one may pass
#  (b) two counters paying the same QR order -> only one may pass
S=/tmp/claude-0/-home-claude-coffee-shop-system/87e71ae2-6bc5-5944-baf1-422d60cc0268/scratchpad
export PGOPTIONS="-c client_min_messages=warning"
P="psql -h /tmp -p 54329 -U postgres -d db_sec -At -v ON_ERROR_STOP=1"
QID=$($P -c "select id from qr_orders where status='PENDING' and sale_id is null and business_id=(select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1') order by created_at desc limit 1")
echo "QR order: $QID"
bo(){ # refund id, sleep
  $P <<SQL
begin;
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select 'BO $1: ' || test.bo(test.bo_refund('$1', '99999999-0000-0000-0000-000000000008', 'PARTIAL_REFUND', 100, '[]'));
select pg_sleep($2);
commit;
SQL
}
qr(){ # login, key, sale id, sleep
  $P <<SQL
begin;
select test.login('$1');
set role authenticated;
select 'QR $3: ' || test.qr_sale('$2', '$3', '$QID', null);
select pg_sleep($4);
commit;
SQL
}
bo dddddddd-0000-0000-0000-00000000cc01 3 > $S/conc_a.txt 2>&1 &
sleep 1
bo dddddddd-0000-0000-0000-00000000cc02 0 > $S/conc_b.txt 2>&1
wait
grep BO $S/conc_a.txt $S/conc_b.txt
echo "refunds on the ₱150 sale: $($P -c "select count(*) || ' rows, ₱' || coalesce(sum(amount),0) from refunds where sale_id='99999999-0000-0000-0000-000000000008'")"
qr 00000000-0000-0000-0000-0000000000e1 device-key-0001-abcdef 99999999-0000-0000-0000-0000000000f1 3 > $S/conc_c.txt 2>&1 &
sleep 1
qr 00000000-0000-0000-0000-0000000000d2 device-key-0002-abcdef 99999999-0000-0000-0000-0000000000f2 0 > $S/conc_d.txt 2>&1
wait
grep QR $S/conc_c.txt $S/conc_d.txt
echo "completed sales for that QR order: $($P -c "select count(*) from sales where qr_order_id='$QID' and status='COMPLETED'"), order points at $($P -c "select sale_id from qr_orders where id='$QID'")"
