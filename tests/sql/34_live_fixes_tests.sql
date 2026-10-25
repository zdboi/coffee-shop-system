-- Checks for cccc/supabase/005_live_fixes.sql (database engineer, 2026-10-20).
-- Live bug: pairing a counter failed with
--   new row for relation "devices" violates check constraint "devices_device_type_check"
-- This file makes the test database look like the live one (an old CHECK rule on
-- devices.device_type that doesn't allow 'COUNTER', plus an existing 'POS' row),
-- shows pairing fails, runs 005 (twice) and shows pairing then works.
-- Needs a database with 004 installed (005 may or may not be installed already):
--   tests/reset_db.sh "" db_sec && psql -h /tmp -p 54329 -U postgres -d db_sec -v ON_ERROR_STOP=1 -f tests/sql/34_live_fixes_tests.sql
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
-- runs a statement; returns 'NO ERROR' or the error text (the statement's changes are undone on error)
create or replace function test.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'NO ERROR'; exception when others then return sqlerrm; end $$;
-- the CHECK rules on one column, as text, sorted
create or replace function test.checks_on(p_tbl regclass, p_col text) returns text language sql as $$
  select coalesce(string_agg(c.conname || ': ' || pg_get_constraintdef(c.oid), ' | ' order by c.conname), '')
  from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.conrelid = p_tbl and c.contype = 'c' and a.attname = p_col
$$;
grant usage on schema test to anon, authenticated; grant execute on all functions in schema test to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

-- ===== 1. make devices look like the live database =====
-- remove whatever rules are there (e.g. from an earlier 005 run), then add live-like ones:
-- the named one from the error message, plus a second one with another name.
do $$ declare r record; begin
  for r in select c.conname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
           where c.conrelid = 'public.devices'::regclass and c.contype = 'c' and a.attname = 'device_type' loop
    execute format('alter table public.devices drop constraint %I', r.conname);
  end loop;
end $$;
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
insert into public.devices(id, business_id, device_tag, device_name, device_type)
  values ('dddddddd-0000-0000-0000-000000000001', :'biz', 'Z', 'Old tablet', 'POS'),
         ('dddddddd-0000-0000-0000-000000000002', :'biz', 'Y', 'Old tablet 2', null);
alter table public.devices add constraint devices_device_type_check check (device_type in ('POS','KDS'));
alter table public.devices add constraint devices_type_not_blank check (device_type <> '');
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0000-0000000034d1', true) on conflict do nothing;

-- owner makes a pairing code
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select (public.create_device_pairing_code('Front Counter'))->>'code' as paircode \gset
reset role;

-- ===== 2. the live bug: pairing fails =====
select test.login('00000000-0000-0000-0000-0000000034d1');
set role authenticated;
select test.err(format($q$select public.redeem_device_pairing(%L, 'device-key-34-0001-abcdef', 'Front Counter')$q$, :'paircode')) as e \gset
reset role;
select test.chk(:'e' like '%devices_device_type_check%', 'before 005: pairing fails on devices_device_type_check (live bug reproduced)', :'e');

-- ===== 3. run 005 =====
\ir ../../cccc/supabase/005_live_fixes.sql
select test.checks_on('public.devices', 'device_type') as c1 \gset
select test.chk((select count(*) from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
                 where c.conrelid = 'public.devices'::regclass and c.contype = 'c' and a.attname = 'device_type') = 1,
                'after 005: exactly one rule on device_type (both old rules dropped, whatever their name)', :'c1');
select test.chk(:'c1' like 'devices_device_type_check:%', 'the rule is called devices_device_type_check', :'c1');
select test.chk(:'c1' like '%''COUNTER''%' and :'c1' like '%''BACK_OFFICE''%' and :'c1' like '%''KITCHEN''%',
                'rule allows COUNTER, BACK_OFFICE, KITCHEN', :'c1');
select test.chk(:'c1' like '%''POS''%', 'rule keeps the value already stored (POS)', :'c1');
select test.chk(:'c1' not like '%''KDS''%', 'unused old value (KDS) is not carried over', :'c1');

-- ===== 4. pairing now works (same code: the failed try changed nothing) =====
select test.login('00000000-0000-0000-0000-0000000034d1');
set role authenticated;
select public.redeem_device_pairing(:'paircode', 'device-key-34-0001-abcdef', 'Front Counter') as res \gset
reset role;
select test.chk((:'res'::jsonb)->'device'->>'device_type' = 'COUNTER', 'after 005: pairing works and writes device_type COUNTER', :'res');
select test.chk((select count(*) from devices where device_key = 'device-key-34-0001-abcdef' and active) = 1, 'paired counter row is active');

-- ===== 5. run 005 a second time: same result, nothing lost =====
\ir ../../cccc/supabase/005_live_fixes.sql
select test.checks_on('public.devices', 'device_type') as c2 \gset
select test.chk(:'c2' = :'c1', 'second run of 005 leaves the same single rule', :'c2');
select test.chk((select device_type from devices where id = 'dddddddd-0000-0000-0000-000000000001') = 'POS', 'old POS row untouched');
select test.chk((select count(*) from devices where id = 'dddddddd-0000-0000-0000-000000000002' and device_type is null) = 1, 'old row with no type untouched');

-- ===== 6. the rule still does its job =====
select test.chk(test.err(format($q$insert into public.devices(business_id, device_type) values (%L, 'BOGUS')$q$, :'biz')) like '%devices_device_type_check%',
                'an unknown device_type is still refused');
select test.chk(test.err(format($q$insert into public.devices(business_id, device_type) values (%L, 'KITCHEN')$q$, :'biz')) = 'NO ERROR',
                'KITCHEN is accepted');
delete from public.devices where device_type = 'KITCHEN';
