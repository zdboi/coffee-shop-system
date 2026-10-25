-- Checks for cccc/supabase/006_live_fix_sync_operations.sql (database engineer, 2026-10-20).
-- Live bug: every counter upload failed with
--   new row for relation "sync_operations" violates check constraint "sync_operations_operation_type_check"
-- This file makes the test database look like the live one (old rule
-- operation_type IN ('INSERT','UPDATE','DELETE') + an existing 'INSERT' row),
-- shows a counter upload fails, runs 006 (twice) and shows a full upload batch
-- (shift_open, sale, cash_movement, audit, shift_close) then works.
-- Needs a FRESH database with 004 installed (005 optional):
--   tests/reset_db.sh "" db_sec && psql -h /tmp -p 54329 -U postgres -d db_sec -v ON_ERROR_STOP=1 -f tests/sql/35_live_fix_sync_ops_tests.sql
-- Prints "ok  ..." / "FAIL ..." for every check and keeps going.
\set QUIET on
create schema if not exists test;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', case when p_token is null then '{}' else json_build_object('x-staff-token', p_token)::text end, false);
end $$;
create or replace function test.chk(cond boolean, msg text, got text default null) returns text language sql as $$
  select case when coalesce(cond, false) then 'ok  ' || msg else 'FAIL ' || msg || coalesce('   [got: ' || got || ']', '') end
$$;
create or replace function test.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'NO ERROR'; exception when others then return sqlerrm; end $$;
create or replace function test.checks_on(p_tbl regclass, p_col text) returns text language sql as $$
  select coalesce(string_agg(c.conname || ': ' || pg_get_constraintdef(c.oid), ' | ' order by c.conname), '')
  from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.conrelid = p_tbl and c.contype = 'c' and a.attname = p_col
$$;
-- one upload batch like the counter sends: open shift, a ₱150 cash sale, a pay-out, an audit note, close shift
create or replace function test.batch(p_n int) returns jsonb language sql as $$
  select public.fo_sync('device-key-35-0001-abcdef', jsonb_build_array(
    jsonb_build_object('op_id', gen_random_uuid(), 'type', 'shift_open', 'data', jsonb_build_object(
       'id', ('88888888-0000-0000-0035-00000000000' || p_n)::uuid, 'shift_number', 'SHIFT-A-2026-35' || p_n,
       'cashier_id', '66666666-0000-0000-0035-000000000001', 'cashier_name', 'Cathy Cashier', 'opened_at', now(), 'opening_cash', 2000)),
    jsonb_build_object('op_id', gen_random_uuid(), 'type', 'sale', 'data', jsonb_build_object(
       'sale', jsonb_build_object('id', ('99999999-0000-0000-0035-00000000000' || p_n)::uuid, 'transaction_number', 'POS-A-2026-35' || p_n,
          'transaction_date', now(), 'status', 'COMPLETED', 'cashier_id', '66666666-0000-0000-0035-000000000001', 'cashier_name', 'Cathy Cashier',
          'shift_id', ('88888888-0000-0000-0035-00000000000' || p_n)::uuid,
          'subtotal', 150, 'discount_amount', 0, 'tax_amount', 0, 'service_charge_amount', 0, 'grand_total', 150),
       'items', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'recipe_id', '33333333-0000-0000-0035-000000000001', 'name', 'Iced Latte',
          'quantity', 1, 'unit_price', 150, 'line_total', 150, 'modifiers', '[]'::jsonb)),
       'payment', jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', 150, 'tendered', 200, 'change', 50, 'status', 'CONFIRMED'),
       'inventory', '[]'::jsonb)),
    jsonb_build_object('op_id', gen_random_uuid(), 'type', 'cash_movement', 'data', jsonb_build_object(
       'id', gen_random_uuid(), 'shift_id', ('88888888-0000-0000-0035-00000000000' || p_n)::uuid, 'type', 'PAY_OUT', 'amount', 50, 'reason', 'Bought ice',
       'performed_by', '66666666-0000-0000-0035-000000000001', 'performed_by_name', 'Cathy Cashier', 'at', now())),
    jsonb_build_object('op_id', gen_random_uuid(), 'type', 'audit', 'data', jsonb_build_object(
       'id', gen_random_uuid(), 'action', 'Drawer opened', 'actor_name', 'Cathy Cashier', 'details', 'test', 'at', now())),
    jsonb_build_object('op_id', gen_random_uuid(), 'type', 'shift_close', 'data', jsonb_build_object(
       'id', ('88888888-0000-0000-0035-00000000000' || p_n)::uuid, 'closed_by', '66666666-0000-0000-0035-000000000001', 'closed_at', now(),
       'declared_cash', 2100, 'expected_cash', 2100, 'cash_variance', 0))))
$$;
-- the per-op answers as one line, e.g. "ok,ok,ok,ok,ok"
create or replace function test.statuses(p jsonb) returns text language sql as $$
  select string_agg(case when e->>'status' = 'error' then e->>'message' else e->>'status' end, ',' order by n)
  from jsonb_array_elements(p) with ordinality as t(e, n)
$$;
grant usage on schema test to anon, authenticated; grant execute on all functions in schema test to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

-- ===== 1. a shop with a menu item, a cashier and a paired counter =====
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
insert into public.recipes(id, business_id, name, recipe_type, selling_price) values ('33333333-0000-0000-0035-000000000001', :'biz', 'Iced Latte', 'DRINKS', 150);
insert into public.staff(id, business_id, name, role) values ('66666666-0000-0000-0035-000000000001', :'biz', 'Cathy Cashier', 'CASHIER');
insert into public.device_pairing_codes(code, business_id, device_name, expires_at) values ('PAIR35', :'biz', 'Front', now() + interval '1 hour');
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0035-0000000000d1', true);
select test.login('00000000-0000-0000-0035-0000000000d1'); set role authenticated;
select test.chk(public.redeem_device_pairing('PAIR35', 'device-key-35-0001-abcdef', 'Front')->'device' is not null, 'setup: counter paired');
reset role;

-- ===== 2. make sync_operations look like the live database =====
do $$ declare r record; begin
  for r in select c.conname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
           where c.conrelid = 'public.sync_operations'::regclass and c.contype = 'c' and a.attname = 'operation_type' loop
    execute format('alter table public.sync_operations drop constraint %I', r.conname);
  end loop;
end $$;
insert into public.sync_operations(operation_id, business_id, entity_type, operation_type, result_summary)
  values ('35350000-0000-0000-0000-000000000001', :'biz', 'sales', 'INSERT', 'old app row');
alter table public.sync_operations add constraint sync_operations_operation_type_check check (operation_type in ('INSERT','UPDATE','DELETE'));

-- ===== 3. the live bug: every counter upload fails =====
select test.chk(test.err(format($q$insert into public.sync_operations(operation_id, business_id, operation_type) values (gen_random_uuid(), %L, 'shift_open')$q$, :'biz'))
                like '%sync_operations_operation_type_check%', 'before 006: writing an upload receipt fails on sync_operations_operation_type_check (live bug reproduced)');
select test.login('00000000-0000-0000-0035-0000000000d1'); set role authenticated;
select test.statuses(test.batch(1)) as s0 \gset
reset role;
select test.chk(:'s0' not like '%ok%' and :'s0' like 'SERVER_ERROR,%', 'before 006: every op of the counter batch fails', :'s0');
select test.chk((select count(*) from shifts where id = '88888888-0000-0000-0035-000000000001') = 0, 'before 006: no shift was saved');

-- ===== 4. run 006 =====
\ir ../../cccc/supabase/006_live_fix_sync_operations.sql
select test.checks_on('public.sync_operations', 'operation_type') as c1 \gset
select test.chk((select count(*) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
                 where c.conrelid = 'public.sync_operations'::regclass and c.contype = 'c' and a.attname = 'operation_type') = 1
                and :'c1' like 'sync_operations_operation_type_check:%', 'after 006: exactly one rule, sync_operations_operation_type_check', :'c1');
select test.chk(:'c1' like '%''INSERT''%' and :'c1' like '%''UPDATE''%' and :'c1' like '%''DELETE''%', 'rule keeps INSERT, UPDATE, DELETE', :'c1');
select test.chk(:'c1' like '%''shift_open''%' and :'c1' like '%''shift_close''%' and :'c1' like '%''cash_movement''%' and :'c1' like '%''sale''%'
                and :'c1' like '%''held_delete''%' and :'c1' like '%''refund''%' and :'c1' like '%''audit''%' and :'c1' like '%''sold_out''%',
                'rule allows all 8 counter upload kinds', :'c1');

-- ===== 5. the counter's batch now goes through =====
select test.login('00000000-0000-0000-0035-0000000000d1'); set role authenticated;
select test.statuses(test.batch(2)) as s1 \gset
reset role;
select test.chk(:'s1' = 'ok,ok,ok,ok,ok', 'after 006: shift_open, sale, cash_movement, audit, shift_close all ok', :'s1');
select test.chk((select status from shifts where id = '88888888-0000-0000-0035-000000000002') = 'CLOSED', 'shift opened and closed');
select test.chk((select grand_total from sales where id = '99999999-0000-0000-0035-000000000002') = 150, 'sale saved');
select test.chk((select count(*) from cash_movements where shift_id = '88888888-0000-0000-0035-000000000002' and type = 'PAY_OUT' and amount = 50) = 1, 'pay-out saved');
select test.chk((select count(*) from sync_operations where device_id is not null and operation_type in ('shift_open','sale','cash_movement','audit','shift_close')) = 5,
                'five upload receipts written');

-- ===== 6. run 006 a second time: same result, nothing lost =====
\ir ../../cccc/supabase/006_live_fix_sync_operations.sql
select test.checks_on('public.sync_operations', 'operation_type') as c2 \gset
select test.chk(:'c2' = :'c1', 'second run of 006 leaves the same single rule', :'c2');
select test.chk((select operation_type from sync_operations where operation_id = '35350000-0000-0000-0000-000000000001') = 'INSERT', 'old app receipt untouched');
select test.login('00000000-0000-0000-0035-0000000000d1'); set role authenticated;
select test.statuses(test.batch(3)) as s2 \gset
reset role;
select test.chk(:'s2' = 'ok,ok,ok,ok,ok', 'after the second run: another batch is all ok', :'s2');

-- ===== 7. the rule still does its job =====
select test.chk(test.err(format($q$insert into public.sync_operations(operation_id, business_id, operation_type) values (gen_random_uuid(), %L, 'BOGUS')$q$, :'biz'))
                like '%sync_operations_operation_type_check%', 'an unknown operation_type is still refused');
