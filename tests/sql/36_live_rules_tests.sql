-- QA (2026-10-20): the test database has the same CHECK rules as live after 004 + 005 + 006.
-- Run on a database built by tests/reset_db.sh (default = 01 live schema + 004, 005, 006):
--   tests/reset_db.sh "" cccc && psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1 -f tests/sql/36_live_rules_tests.sql
-- Prints "ok  ..." / "FAIL ..." per check and keeps going. Read-only.
\set QUIET on
\pset tuples_only on
\pset format unaligned
with want(tbl, col, must_have, must_not_have) as (values
  -- table, column, values that must be allowed, values that must not appear in the rule
  ('profiles','role',                       array['ADMIN','MANAGER','CASHIER','DEVICE'], array[]::text[]),
  ('recipes','recipe_type',                 array['DRINKS','SAUCES_SYRUPS','PASTRY','FOOD'], array[]::text[]),
  ('inventory_transactions','transaction_type', array['PURCHASE','INITIAL_STOCK','USAGE','WASTE','ADJUSTMENT','PRODUCTION','PRODUCTION_USE','SALE_USAGE','SALE_REVERSAL'], array[]::text[]),
  ('shifts','status',                       array['ACTIVE','CLOSED'], array[]::text[]),
  ('cash_movements','type',                 array['PAY_IN','PAY_OUT'], array[]::text[]),
  ('sales','source',                        array['COUNTER','QR'], array[]::text[]),
  ('sales','status',                        array['HELD','COMPLETED','VOIDED','REFUNDED','PARTIALLY_REFUNDED'], array[]::text[]),
  ('payments','method',                     array['CASH','GCASH','MAYA','CARD','BANK','OTHER'], array[]::text[]),
  ('refunds','type',                        array['VOID','FULL_REFUND','PARTIAL_REFUND'], array[]::text[]),
  ('staff','role',                          array['ADMIN','MANAGER','CASHIER'], array['DEVICE']),
  ('dining_tables','kind',                  array['DINE_IN','TAKEAWAY'], array[]::text[]),
  ('qr_orders','order_type',                array['DINE_IN','TAKEAWAY'], array[]::text[]),
  ('qr_orders','status',                    array['PENDING','PREPARING','READY','COMPLETED','REJECTED','CANCELLED'], array[]::text[]),
  ('reconciliation_issues','status',        array['OPEN','ACKNOWLEDGED','RESOLVED'], array[]::text[]),
  -- 005 replaced the stand-in live rule ('POS','KDS'): no stored rows, so only our words remain
  ('devices','device_type',                 array['COUNTER','BACK_OFFICE','KITCHEN'], array['POS','KDS']),
  -- 006 replaced ('INSERT','UPDATE','DELETE') with old words + the 8 counter upload kinds
  ('sync_operations','operation_type',      array['INSERT','UPDATE','DELETE','shift_open','shift_close','cash_movement','sale','held_delete','refund','audit','sold_out'], array[]::text[])
), got as (
  select w.*, (select string_agg(pg_get_constraintdef(c.oid), ' | ')
               from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
               where c.conrelid = format('public.%I', w.tbl)::regclass and c.contype = 'c' and a.attname = w.col) as defs,
              (select count(*) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
               where c.conrelid = format('public.%I', w.tbl)::regclass and c.contype = 'c' and a.attname = w.col) as n
  from want w
)
select case when n = 1
             and (select bool_and(defs like '%''' || v || '''%') from unnest(must_have) v)
             and coalesce((select bool_and(defs not like '%''' || v || '''%') from unnest(must_not_have) v), true)
       then 'ok  ' else 'FAIL ' end || tbl || '.' || col || ': one CHECK rule allowing ' || array_to_string(must_have, ',')
       || case when cardinality(must_not_have) > 0 then ' (and not ' || array_to_string(must_not_have, ',') || ')' else '' end
       || case when n = 1 and (select bool_and(defs like '%''' || v || '''%') from unnest(must_have) v) then '' else '   [got: ' || coalesce(defs, 'no rule') || ']' end
from got order by tbl, col;

select case when exists (select 1 from pg_constraint where conrelid = 'public.cash_movements'::regclass and contype = 'c'
                          and pg_get_constraintdef(oid) like '%amount > (0)%')
       then 'ok  ' else 'FAIL ' end || 'cash_movements.amount > 0 (live rule) is still there';
