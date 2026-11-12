-- Checks for cccc/supabase/012_release_1_5.sql (release 1.5, Wave 3), ported by Z 2026-11-12 from the database
-- work's scratch checks (db15-tests.sql, 348 checks), plus Z's own B17 checks at the end (section Z).
-- Needs a database with 004..012 on which 10_behaviour_tests + 11_qr_tests have JUST run:
--   tests/reset_db.sh "" cccc
--   P="psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1"
--   $P -f tests/sql/10_behaviour_tests.sql && $P -f tests/sql/11_qr_tests.sql && $P -f tests/sql/42_release_1_5_tests.sql
-- (tests/run_all.sh does exactly this.) Prints "ok ..." / "FAIL ..." per check and keeps going.
-- Two-sessions-at-once checks for 1.5 are in tests/conc15_checks.sh (run right after this file, same database).
create schema if not exists test;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', '{}', false);
end $$;
grant usage on schema test to anon, authenticated;
\set QUIET on
\pset tuples_only on
\pset format unaligned
create or replace function test.chk(cond boolean, msg text, got text default null) returns text language plpgsql as $$
begin return case when coalesce(cond, false) then 'ok  ' || msg else 'FAIL ' || msg || coalesce('   [got: ' || got || ']', '') end; end $$;
create or replace function test.err(q text) returns text language plpgsql as $$
begin execute q; return 'NO ERROR'; exception when others then return sqlerrm; end $$;
create or replace function test.op(p_type text, p_data jsonb, p_opid uuid default gen_random_uuid()) returns jsonb language sql as $$
  select public.fo_sync('device-key-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id', p_opid, 'type', p_type, 'data', p_data)))->0
$$;
create or replace function test.stock(p_ing uuid) returns numeric language sql as $$
  select coalesce((select stock from public.v_ingredient_stock where ingredient_id = p_ing), 0)
$$;
-- place a QR order as phone c<n>
create or replace function test.place(p_uid uuid, tok text, guest boolean default false) returns jsonb language sql as $$
  select r from (select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, false) x,
    public.qr_place_order(tok, '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]', null, null, guest) r) y
$$;
grant execute on all functions in schema test to anon, authenticated;
\ir 41a_old_get_qr_menu.sql

select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select business_id as biz2 from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset
select qr_token as tok5 from dining_tables where label = 'Table 5' \gset
select qr_token as tokta from dining_tables where business_id = :'biz' and kind = 'TAKEAWAY' limit 1 \gset
-- re-pair the counter (suite 11 removed it), sign the cashier in online
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select (public.create_device_pairing_code('Front Counter'))->>'code' as paircode \gset
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select (public.redeem_device_pairing(:'paircode', 'device-key-0001-abcdef', 'Front Counter')->'device'->>'active') as x \gset
select (public.staff_pin_login('1111'))->>'token' as cashier_token \gset
reset role;
delete from auth_attempts;
select id as shift_id from shifts where business_id = :'biz' and status = 'ACTIVE' limit 1 \gset
insert into auth.users (id, is_anonymous) select ('00000000-0000-0000-0000-0000000c15' || lpad(g::text, 2, '0'))::uuid, true from generate_series(1, 20) g
  on conflict do nothing;

-- ============================ R. live rules widened ============================
select test.chk(pg_get_constraintdef(oid) like '%PARTNER_RETURN%' and pg_get_constraintdef(oid) like '%SALE_REVERSAL%', 'R: stock line types + PARTNER_RETURN, old ones kept')
  from pg_constraint where conname = 'inventory_transactions_transaction_type_check';
select test.chk(pg_get_constraintdef(oid) like '%stock_count%' and pg_get_constraintdef(oid) like '%waste%' and pg_get_constraintdef(oid) like '%INSERT%', 'R: upload kinds + stock_count, old ones kept')
  from pg_constraint where conname = 'sync_operations_operation_type_check';
select test.chk(pg_get_constraintdef(oid) like '%RND%' and pg_get_constraintdef(oid) like '%COUNT_SHORTAGE%' and pg_get_constraintdef(oid) like '%CALIBRATION%', 'R: waste reasons + RND, COUNT_SHORTAGE')
  from pg_constraint where conname = 'waste_logs_reason_check';
select test.chk((select count(*) from pg_constraint where conrelid = 'public.inventory_transactions'::regclass and contype = 'c'
                 and pg_get_constraintdef(oid) like '%transaction_type%') = 1, 'R: exactly one type rule on stock lines');

-- ============================ A. usernames (Q2) ============================
select test.chk((select username from customers where nickname = 'Zed' and merged_into is null) ~ '^Zed the [A-Za-z ]+$', 'A: existing customer got a coffee username', (select username from customers where nickname = 'Zed'));
select test.chk((select username from customers where nickname = 'Walk-in Wendy') is null, 'A: merged-away record has no username');
select test.chk(public._clean_username('  Mika   the  Bean ') = 'Mika the Bean', 'A: spaces tidied');
select test.chk(public._clean_username('0917 123 4567') is null and public._clean_username('Mika 12345') is null, 'A: phone numbers refused (> 4 digits)');
select test.chk(public._clean_username('Mika 2026') = 'Mika 2026', 'A: up to 4 digits fine');
select test.chk(public._clean_username('mika.com') is null and public._clean_username('www mika') is null and public._clean_username('http cafe') is null
            and public._clean_username('mika@x') is null and public._clean_username('a/b c') is null, 'A: links / @ / slashes refused');
select test.chk(public._clean_username('Jr. Mika') = 'Jr. Mika' and public._clean_username('Ñoño Café') = 'Ñoño Café', 'A: a dot before a space and accented letters are fine');
select test.chk(public._clean_username('ab') is null and public._clean_username(repeat('a', 51)) is null and public._clean_username('1. 2') is null, 'A: length 3..50, at least 2 letters');
select test.chk(public._username_base('  mika<script> 2 ') = 'Mikascript' and public._username_base('123') = 'Kape', 'A: name part = first word, letters only');
-- a new QR customer gets one
select test.login('00000000-0000-0000-0000-0000000c1501'); set role authenticated;
select public.qr_register(:'tok5', 'Mika', '0917 555 0001', true) as r1 \gset
select test.chk((:'r1'::jsonb->'customer'->>'username') ~ '^Mika the ', 'A: new QR customer gets "Mika the ..."', :'r1'::jsonb->'customer'->>'username');
select test.chk(public.qr_session(:'tok5')->>'state' = 'REGISTERED', 'A: session state REGISTERED');
select test.chk(public.qr_set_username(:'tok5', 'Mika the Bean Queen')->'customer'->>'username' = 'Mika the Bean Queen', 'A: customer changes username');
select test.chk(public.qr_set_username(:'tok5', 'call 09171234567')->>'error' = 'BAD_USERNAME', 'A: phone number in username -> BAD_USERNAME');
reset role;
select username as zed_un from customers where nickname = 'Zed' and merged_into is null \gset
select test.login('00000000-0000-0000-0000-0000000c1501'); set role authenticated;
select test.chk(public.qr_set_username(:'tok5', upper(:'zed_un'))->>'error' = 'USERNAME_TAKEN', 'A: someone else''s username (other case) -> USERNAME_TAKEN');
select test.chk(public.qr_set_username(:'tok5', 'Mika the Bean Queen')->'customer'->>'username' = 'Mika the Bean Queen', 'A: own name again is fine');
-- rate limit: 10 refused tries per 15 minutes (2 so far)
select count(*) from (select public.qr_set_username(:'tok5', 'x') from generate_series(1, 8)) z;
select test.chk(public.qr_set_username(:'tok5', 'Mika the Fine Name')->>'error' = 'TOO_MANY_ATTEMPTS', 'A: after 10 refused tries -> TOO_MANY_ATTEMPTS');
reset role;
delete from auth_attempts where kind = 'USERNAME';
-- owner / any writer: same rules
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select id as mika from customers where nickname = 'Mika' \gset
select test.chk(test.err(format($$select public.apply_changes('[{"op":"update","table":"customers","row":{"id":"%s","username":"%s"}}]')$$, :'mika', lower(:'zed_un'))) like 'USERNAME_TAKEN%', 'A: Back Office save of a taken name -> USERNAME_TAKEN');
select test.chk(test.err(format($$select public.apply_changes('[{"op":"update","table":"customers","row":{"id":"%s","username":"see x.com"}}]')$$, :'mika')) like 'BAD_USERNAME%', 'A: Back Office save of a link -> BAD_USERNAME');
select test.chk(test.err(format($$select public.apply_changes('[{"op":"update","table":"customers","row":{"id":"%s","notes":"vip"}}]')$$, :'mika')) = 'NO ERROR'
   and (select username from customers where id = :'mika') = 'Mika the Bean Queen', 'A: other edits keep the username');
reset role;
-- the same name in ANOTHER shop is fine
insert into customers(business_id, nickname, username, source) values (:'biz2', 'Mika', 'Mika the Bean Queen', 'COUNTER');
select test.chk((select count(*) from customers where lower(username) = 'mika the bean queen') = 2, 'A: unique per shop only');

-- ============================ G. guests (Q1/A6, Q3, Q4) ============================
select test.login('00000000-0000-0000-0000-0000000c1502'); set role authenticated;
select test.chk(public.qr_session(:'tok5') = '{"customer":null,"state":"GUEST"}'::jsonb, 'G: a new phone is a GUEST');
reset role;
select test.chk(test.place('00000000-0000-0000-0000-0000000c1502', :'tok5')->>'error' = 'REGISTER_FIRST', 'G: without p_guest a guest still gets REGISTER_FIRST (old QR page)');
select test.place('00000000-0000-0000-0000-0000000c1502', :'tok5', true) as g1 \gset
select test.chk((:'g1'::jsonb->'order'->>'is_guest')::boolean and (:'g1'::jsonb->'order'->>'customer_id') is null
            and (:'g1'::jsonb->'order'->>'customer_nickname') is null and (:'g1'::jsonb->'order'->>'total')::numeric = 165, 'G: guest order: no customer, server price', :'g1');
select test.chk(test.place('00000000-0000-0000-0000-0000000c1502', :'tok5', true) ? 'order', 'G: the same guest may order again (per-phone limit 3)');
select test.chk(test.place('00000000-0000-0000-0000-0000000c1503', :'tok5', true)->>'error' = 'GUEST_TABLE_BUSY', 'G: a 2nd guest at the same table -> GUEST_TABLE_BUSY');
select test.chk(test.place('00000000-0000-0000-0000-0000000c1503', :'tokta', true) ? 'order', 'G: ... but may order at another table');

-- ===== T. "Takeaway / Counter" code: no table limits (owner decision 2026-11-10) =====
-- several guests at once (a real table allows one) and more than 4 open tickets
select test.chk(test.place('00000000-0000-0000-0000-0000000c1504', :'tokta', true) ? 'order', 'T: a 2nd guest at Takeaway / Counter is fine (no GUEST_TABLE_BUSY)');
select test.chk(test.place('00000000-0000-0000-0000-0000000c1505', :'tokta', true) ? 'order'
            and test.place('00000000-0000-0000-0000-0000000c1506', :'tokta', true) ? 'order'
            and test.place('00000000-0000-0000-0000-0000000c1507', :'tokta', true) ? 'order', 'T: 3rd, 4th, 5th guest too');
select count(*) as ta_open from qr_orders where table_id = (select id from dining_tables where business_id = :'biz' and kind = 'TAKEAWAY')
  and status in ('PENDING','PREPARING','READY') and paid_at is null \gset
select test.chk(:ta_open >= 5, 'T: Takeaway / Counter holds 5 open unpaid tickets (a real table stops at 4)', :'ta_open');
select test.chk(test.place('00000000-0000-0000-0000-0000000c1508', :'tokta', true) ? 'order', 'T: ... and takes a 6th');
-- the per-person limits still apply there
select test.chk(test.place('00000000-0000-0000-0000-0000000c1504', :'tokta', true) ? 'order'
            and test.place('00000000-0000-0000-0000-0000000c1504', :'tokta', true) ? 'order', 'T: one phone, 2nd and 3rd open order');
select test.chk(test.place('00000000-0000-0000-0000-0000000c1504', :'tokta', true)->>'error' = 'TOO_MANY_OPEN_ORDERS', 'T: 4th open order of one phone -> TOO_MANY_OPEN_ORDERS (3 unpaid per person)');
update qr_orders set paid_at = now() where auth_user_id = '00000000-0000-0000-0000-0000000c1504';
-- 10 orders per hour per phone: add 7 finished copies (3 real + 7 = 10)
insert into qr_orders select (jsonb_populate_record(null::qr_orders, to_jsonb(o) || jsonb_build_object('id', gen_random_uuid(), 'status', 'COMPLETED',
       'paid_at', now(), 'customer_note', 't15-fill'))).*
  from (select * from qr_orders where auth_user_id = '00000000-0000-0000-0000-0000000c1504' limit 1) o, generate_series(1, 7);
select test.chk(test.place('00000000-0000-0000-0000-0000000c1504', :'tokta', true)->>'error' = 'TOO_MANY_ORDERS', 'T: 11th order in an hour from one phone -> TOO_MANY_ORDERS (10 per hour per person)');
-- 60 orders per shop per 10 minutes
insert into qr_orders select (jsonb_populate_record(null::qr_orders, to_jsonb(o) || jsonb_build_object('id', gen_random_uuid(), 'status', 'COMPLETED',
       'paid_at', now(), 'customer_note', 't15-fill', 'auth_user_id', null))).*
  from (select * from qr_orders where auth_user_id = '00000000-0000-0000-0000-0000000c1504' limit 1) o,
       generate_series(1, greatest(0, 60 - (select count(*) from qr_orders where business_id = :'biz' and created_at > now() - interval '10 minutes'))::int);
select test.chk(test.place('00000000-0000-0000-0000-0000000c1509', :'tokta', true)->>'error' = 'TOO_MANY_ORDERS', 'T: shop limit (60 per 10 min) still applies at Takeaway / Counter');
delete from qr_orders where customer_note = 't15-fill';
select test.chk(test.place('00000000-0000-0000-0000-0000000c1509', :'tokta', true) ? 'order', 'T: (fill removed: the same phone may order again)');
-- the code still marks these orders TAKEAWAY
select test.chk((select bool_and(order_type = 'TAKEAWAY') from qr_orders where table_id = (select id from dining_tables where business_id = :'biz' and kind = 'TAKEAWAY')), 'T: orders there are TAKEAWAY');
select test.chk(test.place('00000000-0000-0000-0000-0000000c1501', :'tok5', true) ? 'order'
            and not (test.place('00000000-0000-0000-0000-0000000c1501', :'tok5', true)->'order'->>'is_guest')::boolean, 'G: a registered phone orders as itself (p_guest ignored), not limited by the guest rule');
-- table now has 4 open unpaid tickets (2 guest + 2 Mika) -> the 5th is refused
select test.chk(test.place('00000000-0000-0000-0000-0000000c1501', :'tok5')->>'error' = 'TABLE_FULL', 'G: 5th open unpaid ticket at a table -> TABLE_FULL (Q3)');
update qr_orders set status = 'PREPARING' where table_id = (select id from dining_tables where label = 'Table 5') and status = 'PENDING';
select test.chk(test.place('00000000-0000-0000-0000-0000000c1501', :'tok5')->>'error' = 'TABLE_FULL', 'G: accepted but unpaid tickets still count');
update qr_orders set paid_at = now() where id = (:'g1'::jsonb->'order'->>'id')::uuid;
select test.chk(test.place('00000000-0000-0000-0000-0000000c1501', :'tok5') ? 'order', 'G: a paid ticket frees a place');
select test.chk(test.place('00000000-0000-0000-0000-0000000c1503', :'tok5', true)->>'error' = 'TABLE_FULL', 'G: table limit checked before the guest rule');
-- guest registers on the same phone: later orders are theirs, earlier stay guest
select test.login('00000000-0000-0000-0000-0000000c1502'); set role authenticated;
select test.chk(public.qr_register(:'tok5', 'Gina', null, true)->'customer'->>'username' ~ '^Gina the ', 'G: guest registers on the same phone');
select test.chk(public.qr_session(:'tok5')->>'state' = 'REGISTERED', 'G: ... and is REGISTERED');
reset role;
select test.chk((select bool_and(is_guest and customer_id is null) from qr_orders where auth_user_id = '00000000-0000-0000-0000-0000000c1502'), 'G: orders made as a guest stay guest orders (no stamps)');
select test.chk((select count(*) from customers where nickname = 'Gina' and phone is null) = 1, 'G: guest record only exists after registering');

-- ============================ S. switching account (Q5, owner decision 2026-11-10) ============================
-- Mika (phone c1501) has open unpaid orders at Table 5: some PREPARING (accepted above), one PENDING.
-- Make one of them READY so all three statuses are covered.
update qr_orders set status = 'READY', ready_at = now() where id = (select id from qr_orders where auth_user_id = '00000000-0000-0000-0000-0000000c1501'
  and status = 'PREPARING' and paid_at is null order by created_at limit 1);
select count(*) filter (where status = 'PENDING') as m_wait, count(*) filter (where status in ('PREPARING','READY')) as m_prog,
       count(*) filter (where status = 'READY') as m_ready, count(*) as m_open
  from qr_orders where auth_user_id = '00000000-0000-0000-0000-0000000c1501' and status in ('PENDING','PREPARING','READY') and paid_at is null \gset
select test.chk(:m_wait >= 1 and :m_prog >= 2 and :m_ready = 1, 'S: set-up: Mika has waiting, being-made and ready orders', :'m_wait' || '/' || :'m_prog');
create temp table s_before as select id, status from qr_orders where auth_user_id = '00000000-0000-0000-0000-0000000c1501' and status in ('PENDING','PREPARING','READY') and paid_at is null;
grant select on s_before to authenticated;
select test.login('00000000-0000-0000-0000-0000000c1501'); set role authenticated;
select public.qr_switch_account(:'tok5') as ask \gset
select test.chk(:'ask'::jsonb->>'error' = 'UNPAID_ORDERS' and (:'ask'::jsonb->>'unpaid')::int = :m_open
            and (:'ask'::jsonb->>'waiting')::int = :m_wait and (:'ask'::jsonb->>'in_progress')::int = :m_prog,
            'S: switch with unpaid orders -> UNPAID_ORDERS + unpaid / waiting / in_progress', :'ask');
select test.chk(public.qr_forget_device(:'tok5')->>'error' = 'UNPAID_ORDERS', 'S: "Not you?" asks too');
select test.chk(public.qr_session(:'tok5')->>'state' = 'REGISTERED', 'S: ... and nothing changed');
select test.chk(public.qr_relink(:'tok5', '0917 123 4567', 'Zed')->>'error' = 'SIGN_OUT_FIRST', 'S: a signed-in phone can''t jump to another account (SIGN_OUT_FIRST)');
select public.qr_switch_account(:'tok5', true) as sw \gset
select test.chk((:'sw'::jsonb->>'ok')::boolean and (:'sw'::jsonb->>'cancelled')::int = :m_wait and (:'sw'::jsonb->>'kept')::int = :m_prog,
            'S: "Yes" cancels only the waiting orders, keeps the rest, signs out', :'sw');
select test.chk(public.qr_session(:'tok5')->>'state' = 'GUEST', 'S: phone is a guest now');
reset role;
select test.chk((select bool_and(o.status = 'CANCELLED' and o.reject_reason like '%account switched%') from s_before b join qr_orders o on o.id = b.id where b.status = 'PENDING'),
            'S: every PENDING order -> CANCELLED (counter sees it)');
select test.chk((select bool_and(o.status = b.status and o.paid_at is null) from s_before b join qr_orders o on o.id = b.id where b.status in ('PREPARING','READY')),
            'S: PREPARING / READY orders untouched (still unpaid, same status)');
-- a kept order is still paid at the counter as usual
select o.id as kept_id, o.subtotal as k_sub, o.service_charge_amount as k_svc, o.tax_amount as k_tax, o.total as k_tot, o.customer_id as k_cust
  from qr_orders o join s_before b on b.id = o.id where b.status = 'PREPARING' limit 1 \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('sale', jsonb_build_object(
   'sale', jsonb_build_object('id', gen_random_uuid(), 'transaction_number', 'POS-A-2026-015001', 'transaction_date', now(), 'status', 'COMPLETED', 'source', 'QR',
     'cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy', 'shift_id', :'shift_id',
     'subtotal', :k_sub, 'discount_amount', 0, 'tax_amount', :k_tax, 'service_charge_amount', :k_svc, 'grand_total', :k_tot,
     'qr_order_id', :'kept_id', 'customer_id', nullif(:'k_cust', '')),
   'items', jsonb_build_array(jsonb_build_object('recipe_id', '33333333-0000-0000-0000-000000000001', 'name', 'Iced Latte', 'quantity', 1,
      'unit_price', :k_sub, 'line_total', :k_sub, 'modifiers', '[]'::jsonb)),
   'payment', jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', :k_tot, 'status', 'CONFIRMED'),
   'inventory', '[]'::jsonb)) as kp \gset
select test.chk(:'kp'::jsonb->>'status' = 'ok' and (select paid_at is not null from qr_orders where id = :'kept_id'), 'S: a kept order is still paid at the counter', :'kp');
reset role;
-- a guest phone has no account to sign out of: ok, its orders are not touched
select count(*) as g_open from qr_orders where auth_user_id = '00000000-0000-0000-0000-0000000c1503' and status = 'PENDING' and paid_at is null \gset
select test.login('00000000-0000-0000-0000-0000000c1503'); set role authenticated;
select public.qr_switch_account(:'tokta', true) as gsw \gset
select test.chk(:'gsw'::jsonb = '{"ok":true,"cancelled":0,"kept":0}'::jsonb, 'S: a guest phone -> ok, nothing cancelled', :'gsw');
reset role;
select test.chk(:g_open >= 1 and (select count(*) from qr_orders where auth_user_id = '00000000-0000-0000-0000-0000000c1503' and status = 'PENDING' and paid_at is null) = :g_open,
            'S: ... the guest''s orders stay', :'g_open');

-- one phone per account (qr_relink), same rule for the phone that loses the account:
-- Zed signs in on phone c1510 and orders twice at the counter code; one gets accepted.
select test.login('00000000-0000-0000-0000-0000000c1510'); set role authenticated;
select test.chk(public.qr_relink(:'tokta', '0917 123 4567', 'Zed')->'customer'->>'nickname' = 'Zed', 'S: Zed signs in on phone c1510');
reset role;
select test.place('00000000-0000-0000-0000-0000000c1510', :'tokta')->'order'->>'id' as z_wait \gset
select test.place('00000000-0000-0000-0000-0000000c1510', :'tokta')->'order'->>'id' as z_prog \gset
update qr_orders set status = 'PREPARING', accepted_at = now() where id = :'z_prog';
-- now Mika's phone c1501 (signed out above) signs in as Zed
select test.login('00000000-0000-0000-0000-0000000c1501'); set role authenticated;
select public.qr_relink(:'tok5', '0917 123 4567', 'Zed') as rl \gset
select test.chk(:'rl'::jsonb->'customer'->>'nickname' = 'Zed' and not (:'rl'::jsonb ? 'cancelled_elsewhere'), 'S: relink after signing out', :'rl');
reset role;
select test.chk((select array_agg(cd.auth_user_id::text) from customer_devices cd join customers c on c.id = cd.customer_id where c.nickname = 'Zed') = array['00000000-0000-0000-0000-0000000c1501'],
            'S: the account is on ONE phone only (old link removed)');
select test.chk((select status = 'PENDING' and paid_at is null from qr_orders where id = :'z_wait'), 'S: old phone''s waiting order stays (nobody there said Yes)');
select test.chk((select status = 'PREPARING' and paid_at is null from qr_orders where id = :'z_prog'), 'S: old phone''s order being made stays (paid at the counter)');
update qr_orders set paid_at = now() where id in (:'z_wait', :'z_prog');
update qr_orders set paid_at = now() where auth_user_id = '00000000-0000-0000-0000-0000000c1501' and paid_at is null;  -- Mika's kept orders paid at the counter
select test.login('00000000-0000-0000-0000-0000000c1501'); set role authenticated;
select test.chk(public.qr_switch_account(:'tok5')->>'ok' = 'true', 'S: no unpaid orders -> signs out straight away');
reset role;
drop table s_before;

-- ============================ B6. archived customers ============================
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select public.fo_customer_list('', 50) as cl \gset
select test.chk(not exists (select 1 from jsonb_array_elements(:'cl'::jsonb->'customers') c where (c->>'archived')::boolean or c->>'nickname' = 'Gina')
            and exists (select 1 from jsonb_array_elements(:'cl'::jsonb->'customers') c where c->>'nickname' = 'Mika'), 'B6: main list = customers with a phone only');
select public.fo_customer_list('', 50, null, 'name', true) as ca \gset
select test.chk(exists (select 1 from jsonb_array_elements(:'ca'::jsonb->'customers') c where c->>'nickname' = 'Gina' and (c->>'archived')::boolean)
            and not exists (select 1 from jsonb_array_elements(:'ca'::jsonb->'customers') c where c->>'phone' is not null), 'B6: Archived filter = customers without a phone');
select test.chk(jsonb_array_length(public.fo_customer_list('Bean Queen', 50)->'customers') = 1, 'B6: search matches the username');
select test.chk((public.fo_customer_list('', 50)->'customers'->0) ? 'username' and not ((public.fo_customer_list('', 50)->'customers'->0) ? 'phone_full'), 'B6: card has username');
select test.chk(exists (select 1 from jsonb_array_elements(public.search_customers('Gina')) c where (c->>'archived')::boolean), 'B6: search_customers marks archived');
reset role;

-- ============================ M. QR menu (B11, B12) ============================
-- same answer as before, apart from the new highlight and option "available"
create or replace function test.strip(j jsonb) returns jsonb language sql as $$
  select (j - 'highlight') || jsonb_build_object('items', coalesce((select jsonb_agg(it || jsonb_build_object('modifier_groups',
      coalesce((select jsonb_agg(g || jsonb_build_object('options', coalesce((select jsonb_agg(o - 'available' order by oo) from jsonb_array_elements(g->'options') with ordinality y(o, oo)), '[]'::jsonb)) order by go)
                from jsonb_array_elements(it->'modifier_groups') with ordinality x(g, go)), '[]'::jsonb)) order by io)
      from jsonb_array_elements(j->'items') with ordinality z(it, io)), '[]'::jsonb))
$$;
select test.chk(test.strip(public.get_qr_menu(:'tok5')) = test.old_get_qr_menu(:'tok5') and jsonb_array_length(public.get_qr_menu(:'tok5')->'items') > 0, 'M: get_qr_menu = old answer + highlight + option available');
select test.chk(public.get_qr_menu(:'tok5')->'highlight' = 'null'::jsonb, 'M: no highlight set -> null');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','d1500000-0000-0000-0000-000000000001','name','Oat milk 15','base_unit','L')),
  jsonb_build_object('op','upsert','table','option_groups','row', jsonb_build_object('id','d1500000-0000-0000-0000-000000000002','name','Lactose free','sort_order',9,
     'applies_to', '{"recipe_types":["DRINKS"]}'::jsonb,
     'options', '[{"id":"oat15","label":"Oat milk","kind":"SWAP","price_delta":30,"swap_from_ingredient_id":"22222222-0000-0000-0000-000000000002","swap_to_ingredient_id":"d1500000-0000-0000-0000-000000000001"}]'::jsonb)),
  jsonb_build_object('op','update','table','settings','row', jsonb_build_object('menu_highlight_recipe_id','33333333-0000-0000-0000-000000000001','menu_highlight_blurb','Try it'))));
reset role;
create or replace function test.swap_av(tok text) returns text language sql as $$
  select string_agg(o->>'available', ',') from jsonb_array_elements(public.get_qr_menu(tok)->'items') it,
    jsonb_array_elements(it->'modifier_groups') g, jsonb_array_elements(g->'options') o where o->>'id' = 'oat15'
$$;
select test.chk(test.swap_av(:'tok5') = 'false', 'M: swap with no stock -> available false', test.swap_av(:'tok5'));
insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) values (:'biz', 'd1500000-0000-0000-0000-000000000001', 'INITIAL_STOCK', 0.1, current_date);
select test.chk(test.swap_av(:'tok5') = 'false', 'M: less than one drink''s amount (0.1 L < 0.18 L) -> false');
insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) values (:'biz', 'd1500000-0000-0000-0000-000000000001', 'INITIAL_STOCK', 1, current_date);
select test.chk(test.swap_av(:'tok5') = 'true', 'M: enough stock -> true');
select test.chk(not (public.get_qr_menu(:'tok5')::text ~ '"(stock|quantity|swap_to_ingredient_id|extras)"'), 'M: no stock amounts / ingredient ids in the QR menu');
select test.chk((select bool_and((o->>'available')::boolean) from jsonb_array_elements(public.get_qr_menu(:'tok5')->'items') it,
    jsonb_array_elements(it->'modifier_groups') g, jsonb_array_elements(g->'options') o where coalesce(o->>'kind', 'PLAIN') <> 'SWAP'), 'M: non-swap options always available');
update ingredients set active = false where id = 'd1500000-0000-0000-0000-000000000001';
select test.chk(test.swap_av(:'tok5') = 'false', 'M: switched-off swap ingredient -> false');
update ingredients set active = true where id = 'd1500000-0000-0000-0000-000000000001';
select public.get_qr_menu(:'tok5')->'highlight' as hl \gset
select test.chk(:'hl'::jsonb @> '{"item_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","available":true,"sold_out":false,"label":"Today''s pick","blurb":"Try it"}'::jsonb, 'B11: highlight on the QR menu', :'hl');
update recipes set qr_visible = false where id = '33333333-0000-0000-0000-000000000001';
select test.chk(public.get_qr_menu(:'tok5')->'highlight' = 'null'::jsonb, 'B11: hidden from QR -> no highlight');
update recipes set qr_visible = true where id = '33333333-0000-0000-0000-000000000001';
update recipes set sold_out = true where id = '33333333-0000-0000-0000-000000000001';
select test.chk((public.get_qr_menu(:'tok5')->'highlight'->>'sold_out')::boolean, 'B11: sold out highlight stays, sold_out true');
update recipes set sold_out = false where id = '33333333-0000-0000-0000-000000000001';

-- ============================ K. barista kit (B7) ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"barista_kit":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":36,"unit":"g","extra":"x"},{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":0.4,"unit":"L"}]}}]')$$) = 'NO ERROR', 'K: owner saves a kit');
select test.chk((select barista_kit from settings where business_id = :'biz') = '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":36,"unit":"g"},{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":0.4,"unit":"L"}]'::jsonb, 'K: stored tidied');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"barista_kit":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":36,"unit":"ml"}]}}]')$$) like 'BAD_BARISTA_KIT%', 'K: unit that doesn''t convert -> BAD_BARISTA_KIT');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"barista_kit":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":0}]}}]')$$) like 'BAD_BARISTA_KIT%', 'K: zero amount -> BAD_BARISTA_KIT');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"barista_kit":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1},{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":2}]}}]')$$) like 'BAD_BARISTA_KIT%', 'K: same item twice -> BAD_BARISTA_KIT');
reset role;
insert into ingredients(id, business_id, name, base_unit) values ('d1500000-0000-0000-0000-0000000000b2', :'biz2', 'Other shop beans', 'g') on conflict do nothing;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"barista_kit":[{"ingredient_id":"d1500000-0000-0000-0000-0000000000b2","quantity":1}]}}]')$$) like 'BAD_BARISTA_KIT%', 'K: another shop''s ingredient -> BAD_BARISTA_KIT');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(jsonb_array_length(public.fo_bootstrap('device-key-0001-abcdef')->'settings'->'barista_kit') = 2, 'K: counter reads the kit (fo_bootstrap settings)');
select test.chk(test.op('waste', jsonb_build_object('id', 'd1500000-0000-0000-0000-0000000000a1', 'reason', 'CALIBRATION', 'staff_id', '66666666-0000-0000-0000-000000000001',
   'shift_id', :'shift_id', 'logged_at', now(), 'items', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":36,"unit":"g"}]'::jsonb))->>'status' = 'ok', 'K: kit saved as waste CALIBRATION (existing op)');
select test.chk(test.op('waste', jsonb_build_object('id', 'd1500000-0000-0000-0000-0000000000a2', 'reason', 'RND', 'staff_id', '66666666-0000-0000-0000-000000000001',
   'items', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]'::jsonb))->>'message' = 'BAD_WASTE_REASON', 'K: a counter can''t log RND');
reset role;

-- ============================ D. R&D (B8) ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','purchases','row', jsonb_build_object('id','d1500000-0000-0000-0000-0000000000c1','ingredient_id','22222222-0000-0000-0000-000000000001','purchase_date','2026-11-01','quantity',1,'purchase_unit','kg','base_quantity',1000,'total_price',1000,'price_per_base_unit',1)),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','d1500000-0000-0000-0000-0000000000c2','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','PURCHASE','quantity',1000,'reference_id','d1500000-0000-0000-0000-0000000000c1','transaction_date','2026-11-01')),
  jsonb_build_object('op','upsert','table','rnd_projects','row', jsonb_build_object('id','d1500000-0000-0000-0000-0000000000d1','name','Ube latte')),
  jsonb_build_object('op','upsert','table','rnd_projects','row', jsonb_build_object('id','d1500000-0000-0000-0000-0000000000d2','name','Old idea','status','DONE'))));
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"rnd_projects","row":{"name":" UBE LATTE "}}]')$$) like 'PROJECT_NAME_TAKEN%', 'D: project names unique per shop (any case) -> PROJECT_NAME_TAKEN');
select test.stock('22222222-0000-0000-0000-000000000001') as beans0 \gset
select public.log_rnd_usage(jsonb_build_object('id','d1500000-0000-0000-0000-0000000000e1','project_id','d1500000-0000-0000-0000-0000000000d1','note','trial 1',
  'items', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":0.05,"unit":"kg"},{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]'::jsonb)) as rd \gset
select test.chk((:'rd'::jsonb->>'total_cost')::numeric = 68, 'D: R&D cost worked out by the server (50 g + a latte''s 18 g at 1/g)', :'rd');
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :beans0 - 68, 'D: stock taken off');
select test.chk((select reason = 'RND' and rnd_project_id = 'd1500000-0000-0000-0000-0000000000d1' and device_id is null from waste_logs where id = 'd1500000-0000-0000-0000-0000000000e1'), 'D: saved as waste reason RND, linked to the project');
select test.chk(public.log_rnd_usage(jsonb_build_object('id','d1500000-0000-0000-0000-0000000000e1','project_id','d1500000-0000-0000-0000-0000000000d1','items','[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]'::jsonb))->>'duplicate' = 'true'
            and test.stock('22222222-0000-0000-0000-000000000001') = :beans0 - 68, 'D: same id again -> duplicate, nothing new');
select test.chk(test.err($$select public.log_rnd_usage('{"id":"d1500000-0000-0000-0000-0000000000e2","project_id":"d1500000-0000-0000-0000-0000000000d2","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]}')$$) like 'PROJECT_CLOSED%', 'D: closed project -> PROJECT_CLOSED');
select test.chk(test.err($$select public.log_rnd_usage('{"id":"d1500000-0000-0000-0000-0000000000e2","project_id":"d1500000-0000-0000-0000-0000000000d1","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1,"unit":"ml"}]}')$$) like 'BAD_UNIT%', 'D: bad unit -> BAD_UNIT');
select test.chk(test.err($$select public.log_rnd_usage('{"id":"d1500000-0000-0000-0000-0000000000e2","project_id":"d1500000-0000-0000-0000-0000000000d1","items":[]}')$$) like 'BAD_RND%', 'D: no items -> BAD_RND');
select public.waste_report(current_date - 1, current_date + 1) as wr \gset
select test.chk(:'wr'::jsonb->'by_project' @> '[{"name":"Ube latte","entries":1,"cost":68}]'::jsonb
            and exists (select 1 from jsonb_array_elements(:'wr'::jsonb->'entries') e where e->>'reason' = 'RND' and e->>'source' = 'OFFICE' and e->>'project_name' = 'Ube latte'), 'D: waste report: R&D per project, source OFFICE', :'wr'::jsonb->>'by_project');
select public.net_income_report(current_date) as ni \gset
select test.chk((:'ni'::jsonb->'ingredients'->>'rnd')::numeric = 68 and :'ni'::jsonb->'rnd_projects' @> '[{"name":"Ube latte","cost":68}]'::jsonb
            and (:'ni'::jsonb->'ingredients'->>'wasted')::numeric >= 68, 'D: net income: R&D cost inside waste, per project', :'ni'::jsonb->>'ingredients');
select test.chk(test.err($$select public.apply_changes('[{"op":"delete","table":"rnd_projects","id":"d1500000-0000-0000-0000-0000000000d1"}]')$$) like 'PROJECT_HAS_USAGE%', 'D: project with usage can''t be deleted');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.log_rnd_usage('{"id":"d1500000-0000-0000-0000-0000000000e3","project_id":"d1500000-0000-0000-0000-0000000000d1","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]}')$$) like 'NOT_ALLOWED%', 'D: a counter can''t log R&D');
select test.chk((select count(*) from rnd_projects) = 0, 'D: a counter can''t read R&D projects');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.log_rnd_usage(jsonb_build_object('id','d1500000-0000-0000-0000-0000000000e4','project_id','d1500000-0000-0000-0000-0000000000d1',
  'items', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":10}]'::jsonb)) is not null as x \gset
select public.delete_rnd_usage('d1500000-0000-0000-0000-0000000000e4')->>'deleted' as del \gset
select test.chk(:'del' = 'true' and test.stock('22222222-0000-0000-0000-000000000001') = :beans0 - 68
            and exists (select 1 from audit_log where action = 'R&D usage removed'), 'D: delete a mistaken entry: stock back + audit');
reset role;

-- ============================ C. count at closing (B9) ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes('[{"op":"update","table":"ingredients","row":{"id":"22222222-0000-0000-0000-000000000001","count_at_close":true}},{"op":"update","table":"ingredients","row":{"id":"22222222-0000-0000-0000-000000000002","count_at_close":true}}]');
reset role;
select test.stock('22222222-0000-0000-0000-000000000001') as beans1 \gset
select test.stock('22222222-0000-0000-0000-000000000002') as milk1 \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('shift_close', jsonb_build_object('id', :'shift_id', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 0))->>'message' = 'COUNT_REQUIRED', 'C: close without a count -> COUNT_REQUIRED');
select test.chk(test.op('stock_count', jsonb_build_object('id', 'd1500000-0000-0000-0000-0000000000f1', 'shift_id', :'shift_id', 'staff_id', '66666666-0000-0000-0000-000000000001',
   'counted_at', now(), 'lines', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1,"unit":"kg"},{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":2}]'::jsonb))->>'message' = 'BAD_COUNT', 'C: same item twice -> BAD_COUNT');
select test.chk(test.op('stock_count', jsonb_build_object('id', 'd1500000-0000-0000-0000-0000000000f1', 'shift_id', :'shift_id', 'staff_id', '66666666-0000-0000-0000-000000000001',
   'counted_at', now(), 'lines', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1,"unit":"ml"}]'::jsonb))->>'message' = 'BAD_UNIT', 'C: unit that doesn''t convert -> BAD_UNIT');
select test.chk(test.op('stock_count', jsonb_build_object('id', 'd1500000-0000-0000-0000-0000000000f1', 'shift_id', 'd1500000-0000-0000-0000-000000000099', 'staff_id', '66666666-0000-0000-0000-000000000001',
   'counted_at', now(), 'lines', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]'::jsonb))->>'message' = 'SHIFT_NOT_FOUND', 'C: unknown shift -> SHIFT_NOT_FOUND');
-- the real count: beans 100 g less than expected, milk 50 mL MORE; the counter's "expected" is ignored
select test.op('stock_count', jsonb_build_object('id', 'd1500000-0000-0000-0000-0000000000f1', 'shift_id', :'shift_id', 'staff_id', '66666666-0000-0000-0000-000000000001',
   'counted_at', now(), 'note', 'end of day',
   'lines', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', (:beans1 - 100) / 1000.0, 'unit','kg', 'expected', 0),
                              jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000002','quantity', :milk1 + 50, 'expected', 99999))), 'd1500000-0000-0000-0000-0000000000f9') as sc \gset
select test.chk(:'sc'::jsonb->>'status' = 'ok', 'C: count uploaded', :'sc');
select test.chk(test.op('stock_count', jsonb_build_object('id', 'd1500000-0000-0000-0000-0000000000f1'), 'd1500000-0000-0000-0000-0000000000f9')->>'status' = 'duplicate', 'C: same op again -> duplicate');
select test.chk(test.op('stock_count', jsonb_build_object('id', 'd1500000-0000-0000-0000-0000000000f1', 'shift_id', :'shift_id', 'staff_id', '66666666-0000-0000-0000-000000000001',
   'lines', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":0}]'::jsonb))->>'status' = 'skipped', 'C: same count id, new op -> skipped (nothing applied twice)');
reset role;
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :beans1 - 100 and test.stock('22222222-0000-0000-0000-000000000002') = :milk1 + 50, 'C: stock now equals the count');
select test.chk((select expected = :beans1 and difference = -100 and counted = :beans1 - 100 from stock_count_lines where count_id = 'd1500000-0000-0000-0000-0000000000f1' and ingredient_id = '22222222-0000-0000-0000-000000000001'), 'C: expected / difference are the server''s');
select test.chk((select reason = 'COUNT_SHORTAGE' and total_cost = 100 and stock_count_id = 'd1500000-0000-0000-0000-0000000000f1' from waste_logs where stock_count_id = 'd1500000-0000-0000-0000-0000000000f1'), 'C: shortage = waste COUNT_SHORTAGE, costed');
select test.chk((select count(*) from inventory_transactions where reference_id = 'd1500000-0000-0000-0000-0000000000f1' and transaction_type = 'ADJUSTMENT' and quantity = 50) = 1
            and (select needs_review and review_reason like '%COUNT_EXTRA%' from stock_counts where id = 'd1500000-0000-0000-0000-0000000000f1'), 'C: extra = adjustment up + needs review (never negative waste)');
select test.chk((select count(*) from inventory_transactions where reference_id = 'd1500000-0000-0000-0000-0000000000f1' and transaction_type = 'WASTE' and quantity < 0) = 0, 'C: no negative waste lines');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('shift_close', jsonb_build_object('id', :'shift_id', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 0))->>'status' = 'ok', 'C: with a count the shift closes');
select test.chk((select count(*) from stock_counts) = 0, 'C: a counter can''t read counts directly');
select test.chk(test.err($$insert into public.stock_counts(id, business_id, counted_at, count_date) values (gen_random_uuid(), public.current_business_id(), now(), current_date)$$) like '%permission denied%' , 'C: ... nor write them');
select test.chk(test.err($$select public.revise_stock_count('d1500000-0000-0000-0000-0000000000f1', '[]')$$) like 'NOT_ALLOWED%', 'C: a counter can''t revise');
reset role;
select test.chk((select status from shifts where id = :'shift_id') = 'CLOSED', 'C: shift closed');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.revise_stock_count('d1500000-0000-0000-0000-0000000000f1', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":5000}]')$$) like 'NOTE_REQUIRED%', 'C: revise without a reason -> NOTE_REQUIRED');
select test.chk(test.err($$select public.revise_stock_count('d1500000-0000-0000-0000-0000000000f1', '[{"ingredient_id":"d1500000-0000-0000-0000-000000000001","quantity":1}]', 'x')$$) like 'BAD_COUNT%', 'C: revise an item not in the count -> BAD_COUNT');
select public.revise_stock_count('d1500000-0000-0000-0000-0000000000f1', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', :beans1 - 40)), 'recounted: 60 g were in the grinder') as rv \gset
select test.chk(:'rv'::jsonb->'count'->>'status' = 'REVISED' and not (:'rv'::jsonb->'count'->>'needs_review')::boolean, 'C: owner revised; review flag cleared', :'rv'::jsonb->>'count');
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :beans1 - 40, 'C: stock follows the revised count');
select test.chk((select total_cost from waste_logs where stock_count_id = 'd1500000-0000-0000-0000-0000000000f1') = 40, 'C: shortage waste re-worked (40)');
select test.chk((select original_counted from stock_count_lines where count_id = 'd1500000-0000-0000-0000-0000000000f1' and ingredient_id = '22222222-0000-0000-0000-000000000001') = :beans1 - 100, 'C: first count kept');
select test.chk(exists (select 1 from audit_log where action = 'Stock count revised' and reference_id = 'd1500000-0000-0000-0000-0000000000f1' and details like '%grinder%'), 'C: audit entry');
select public.revise_stock_count('d1500000-0000-0000-0000-0000000000f1', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', :beans1 + 10)), 'found a bag') as rv2 \gset
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :beans1 + 10 and not exists (select 1 from waste_logs where stock_count_id = 'd1500000-0000-0000-0000-0000000000f1' and exists (select 1 from waste_log_items i where i.waste_log_id = waste_logs.id and i.ingredient_id = '22222222-0000-0000-0000-000000000001')), 'C: revised to more than expected: shortage gone, stock raised');
-- a second count (shift already closed): only beans, all of them missing -> incomplete + large shortage + shift closed
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('stock_count', jsonb_build_object('id', 'd1500000-0000-0000-0000-0000000000f2', 'shift_id', :'shift_id', 'staff_id', '66666666-0000-0000-0000-000000000001',
   'counted_at', now(), 'lines', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":0}]'::jsonb))->>'status' = 'ok', 'C: second count accepted');
reset role;
select test.chk((select review_reason from stock_counts where id = 'd1500000-0000-0000-0000-0000000000f2') = 'COUNT_INCOMPLETE, SHIFT_CLOSED, LARGE_SHORTAGE',
   'C: flags: incomplete, after closing, large shortage', (select review_reason from stock_counts where id = 'd1500000-0000-0000-0000-0000000000f2'));
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = 0, 'C: stock follows the latest count');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.revise_stock_count('d1500000-0000-0000-0000-0000000000f2', '[]') is not null as x \gset
select test.chk((select not needs_review and status = 'SUBMITTED' from stock_counts where id = 'd1500000-0000-0000-0000-0000000000f2')
            and exists (select 1 from audit_log where action = 'Stock count reviewed' and reference_id = 'd1500000-0000-0000-0000-0000000000f2'), 'C: owner marks reviewed (no change) + audit');
select public.revise_stock_count('d1500000-0000-0000-0000-0000000000f2', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', :beans1 + 10)), 'undo test') is not null as x \gset
select public.waste_report(current_date - 1, current_date + 1) as wr2 \gset
select test.chk(not exists (select 1 from jsonb_array_elements(:'wr2'::jsonb->'entries') e where e->>'reason' = 'COUNT_SHORTAGE'), 'C: waste report follows the revision');
reset role;

-- ============================ P. partner production (B15) ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','suppliers','row', jsonb_build_object('id','d1500000-0000-0000-0000-000000000101','name','TCO','is_partner_branch',true)),
  jsonb_build_object('op','upsert','table','suppliers','row', jsonb_build_object('id','d1500000-0000-0000-0000-000000000102','name','Bean Co')),
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','d1500000-0000-0000-0000-000000000103','name','Coffee syrup','base_unit','ml','is_produced_item',true)),
  jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object('id','d1500000-0000-0000-0000-000000000104','name','Coffee syrup batch','recipe_type','SAUCES_SYRUPS','is_production_recipe',true,
     'expected_yield',1,'yield_unit','L','produced_ingredient_id','d1500000-0000-0000-0000-000000000103','selling_price',0)),
  jsonb_build_object('op','upsert','table','recipe_ingredients','row', jsonb_build_object('id','d1500000-0000-0000-0000-000000000105','recipe_id','d1500000-0000-0000-0000-000000000104','ingredient_id','22222222-0000-0000-0000-000000000001','quantity',200,'unit','g'))));
select test.stock('22222222-0000-0000-0000-000000000001') as beans2 \gset
select test.chk(test.err($$select public.partner_batch_preview('{"recipe_id":"d1500000-0000-0000-0000-000000000104","supplier_id":"d1500000-0000-0000-0000-000000000102","debt_kind":"INGREDIENTS","scale":1}')$$) like 'NOT_A_PARTNER%', 'P: ordinary supplier -> NOT_A_PARTNER');
select test.chk(test.err($$select public.partner_batch_preview('{"recipe_id":"33333333-0000-0000-0000-000000000001","supplier_id":"d1500000-0000-0000-0000-000000000101","debt_kind":"INGREDIENTS","scale":1}')$$) like 'NOT_A_PRODUCTION_RECIPE%', 'P: menu recipe -> NOT_A_PRODUCTION_RECIPE');
select test.chk(test.err($$select public.partner_batch_preview('{"recipe_id":"d1500000-0000-0000-0000-000000000104","supplier_id":"d1500000-0000-0000-0000-000000000101","debt_kind":"FREE","scale":1}')$$) like 'BAD_DEBT_KIND%', 'P: bad debt kind');
select test.chk(test.err($$select public.partner_batch_preview('{"recipe_id":"d1500000-0000-0000-0000-000000000104","supplier_id":"d1500000-0000-0000-0000-000000000101","debt_kind":"PESOS","scale":0}')$$) like 'BAD_SCALE%', 'P: scale 0 -> BAD_SCALE');
select public.partner_batch_preview('{"recipe_id":"d1500000-0000-0000-0000-000000000104","supplier_id":"d1500000-0000-0000-0000-000000000101","debt_kind":"INGREDIENTS","expected_yield":2}') as pv \gset
select test.chk((:'pv'::jsonb->>'scale')::numeric = 2 and (:'pv'::jsonb->'lines'->0->>'quantity')::numeric = 400 and (:'pv'::jsonb->>'value')::numeric = 400
            and (:'pv'::jsonb->>'produced_quantity')::numeric = 2000, 'P: preview 2x: owe 400 g beans worth 400; 2 L = 2000 mL of product', :'pv');
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :beans2, 'P: preview saves nothing');
select public.produce_partner_batch('{"id":"d1500000-0000-0000-0000-000000000110","recipe_id":"d1500000-0000-0000-0000-000000000104","supplier_id":"d1500000-0000-0000-0000-000000000101","debt_kind":"INGREDIENTS","scale":2,"actual_yield":1.9}') as pb \gset
select test.chk(test.stock('d1500000-0000-0000-0000-000000000103') = 1900 and test.stock('22222222-0000-0000-0000-000000000001') = :beans2, 'P: product stock up (1.9 L), our beans NOT taken');
select test.chk((select source = 'PARTNER' and scale = 2 and raw_cost_total = 400 and round(actual_cost_per_unit, 4) = round(400 / 1.9, 4) and debt_kind = 'INGREDIENTS'
                 from production_batches where id = 'd1500000-0000-0000-0000-000000000110'), 'P: batch cost = what we owe (400)');
select test.chk(public.produce_partner_batch('{"id":"d1500000-0000-0000-0000-000000000110","recipe_id":"d1500000-0000-0000-0000-000000000104","supplier_id":"d1500000-0000-0000-0000-000000000101","debt_kind":"INGREDIENTS","scale":2}')->>'duplicate' = 'true'
            and test.stock('d1500000-0000-0000-0000-000000000103') = 1900, 'P: same batch id again -> duplicate');
select (:'pb'::jsonb->>'debt_id') as debt1 \gset
select test.chk((select count(*) from v_partner_to_return where debt_id = :'debt1' and ingredient_name = 'Espresso beans' and remaining = 400) = 1, 'P: "To return" lists 400 g of beans');
select public.net_income_report(current_date) as ni0 \gset
select test.chk(test.err(format($$select public.partner_return('{"id":"d1500000-0000-0000-0000-000000000120","debt_id":"%s","lines":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":0.5,"unit":"kg"}]}')$$, :'debt1')) like 'RETURN_EXCEEDS_DEBT%', 'P: returning more than owed -> RETURN_EXCEEDS_DEBT');
select test.chk(test.err(format($$select public.partner_return('{"id":"d1500000-0000-0000-0000-000000000120","debt_id":"%s","lines":[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":1}]}')$$, :'debt1')) like 'NOT_IN_DEBT%', 'P: an ingredient not owed -> NOT_IN_DEBT');
select test.chk(test.err(format($$select public.partner_pay('{"id":"d1500000-0000-0000-0000-000000000120","debt_id":"%s","amount":10}')$$, :'debt1')) like 'WRONG_DEBT_KIND%', 'P: paying pesos on an ingredients debt -> WRONG_DEBT_KIND');
select public.partner_return(format('{"id":"d1500000-0000-0000-0000-000000000120","debt_id":"%s","lines":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":0.15,"unit":"kg"}]}', :'debt1')::jsonb) as rt1 \gset
select test.chk(:'rt1'::jsonb->>'status' = 'OPEN' and (:'rt1'::jsonb->'lines'->0->>'remaining')::numeric = 250 and test.stock('22222222-0000-0000-0000-000000000001') = :beans2 - 150, 'P: partial return: stock down 150 g, 250 g still owed', :'rt1');
select test.chk((select count(*) from inventory_transactions where reference_id = 'd1500000-0000-0000-0000-000000000120' and transaction_type = 'PARTNER_RETURN' and quantity = 150) = 1, 'P: new stock line type PARTNER_RETURN');
select test.chk(public.partner_return(format('{"id":"d1500000-0000-0000-0000-000000000120","debt_id":"%s","lines":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]}', :'debt1')::jsonb)->>'duplicate' = 'true'
            and test.stock('22222222-0000-0000-0000-000000000001') = :beans2 - 150, 'P: same return id again -> duplicate');
select public.partner_return(format('{"id":"d1500000-0000-0000-0000-000000000121","debt_id":"%s","lines":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":250}]}', :'debt1')::jsonb) as rt2 \gset
select test.chk(:'rt2'::jsonb->>'status' = 'SETTLED' and not exists (select 1 from v_partner_to_return where debt_id = :'debt1'), 'P: rest returned -> SETTLED, off the list');
select test.chk(test.err(format($$select public.partner_return('{"id":"d1500000-0000-0000-0000-000000000122","debt_id":"%s","lines":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]}')$$, :'debt1')) like 'DEBT_NOT_OPEN%', 'P: settled debt -> DEBT_NOT_OPEN');
select public.net_income_report(current_date) as ni1 \gset
select test.chk(:'ni1'::jsonb->'ingredients' = :'ni0'::jsonb->'ingredients' and :'ni1'::jsonb->'expenses' = :'ni0'::jsonb->'expenses', 'P: returns are NOT ingredients used / waste / expense (net income unchanged)', :'ni1'::jsonb->>'ingredients');
-- pesos
select public.produce_partner_batch('{"recipe_id":"d1500000-0000-0000-0000-000000000104","supplier_id":"d1500000-0000-0000-0000-000000000101","debt_kind":"PESOS","scale":0.5}') as pb2 \gset
select (:'pb2'::jsonb->>'debt_id') as debt2 \gset
select test.chk((:'pb2'::jsonb->>'amount_owed')::numeric = 100 and (select amount_owed from partner_debts where id = :'debt2') = 100
            and (select count(*) from partner_debt_lines where debt_id = :'debt2') = 0, 'P: half batch, pesos: owe 100 (our cost), no ingredient lines');
select test.chk((select remaining from v_partner_to_return where debt_id = :'debt2') = 100 and (select unit from v_partner_to_return where debt_id = :'debt2') = 'PHP', 'P: peso debt on the "To return" list');
select test.chk(test.err(format($$select public.partner_pay('{"id":"d1500000-0000-0000-0000-000000000130","debt_id":"%s","amount":100.02}')$$, :'debt2')) like 'PAYMENT_TOO_LARGE%', 'P: paying more than owed -> PAYMENT_TOO_LARGE');
select test.chk(test.err(format($$select public.partner_pay('{"id":"d1500000-0000-0000-0000-000000000130","debt_id":"%s","amount":0}')$$, :'debt2')) like 'BAD_AMOUNT%', 'P: ₱0 -> BAD_AMOUNT');
select test.chk(public.partner_pay(format('{"id":"d1500000-0000-0000-0000-000000000130","debt_id":"%s","amount":60}', :'debt2')::jsonb) @> '{"status":"OPEN","remaining":40}'::jsonb, 'P: partial payment');
select test.chk(public.partner_pay(format('{"id":"d1500000-0000-0000-0000-000000000131","debt_id":"%s","amount":40}', :'debt2')::jsonb) @> '{"status":"SETTLED","remaining":0}'::jsonb, 'P: paid in full -> SETTLED');
select test.chk((select count(*) from expenses) = 0, 'P: payments are not expenses');
select test.chk(test.err($$select public.apply_changes('[{"op":"delete","table":"suppliers","id":"d1500000-0000-0000-0000-000000000101"}]')$$) like 'PARTNER_HAS_DEBTS%', 'P: partner with debts can''t be deleted');
select test.chk(test.err($$select public.apply_changes('[{"op":"delete","table":"production_batches","id":"d1500000-0000-0000-0000-000000000110"}]')$$) like 'PARTNER_BATCH_HAS_DEBT%', 'P: partner batch can''t be deleted');
select test.chk(test.err($$insert into public.partner_debts(business_id, batch_id, supplier_id, kind) values (public.current_business_id(), 'd1500000-0000-0000-0000-000000000110', 'd1500000-0000-0000-0000-000000000101', 'PESOS')$$) like '%permission denied%', 'P: owner can''t write debts directly (functions only)');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"partner_debts","row":{"kind":"PESOS"}}]')$$) like 'TABLE_NOT_ALLOWED%', 'P: ... nor through apply_changes');
-- own batches carry the scale too
select test.err($$select public.apply_changes('[{"op":"upsert","table":"production_batches","row":{"id":"d1500000-0000-0000-0000-000000000140","recipe_id":"d1500000-0000-0000-0000-000000000104","scale":0.5,"production_date":"2026-11-10"}}]')$$) as ob \gset
select test.chk(:'ob' = 'NO ERROR' and (select source = 'OWN' and scale = 0.5 from production_batches where id = 'd1500000-0000-0000-0000-000000000140'), 'P: own batch saves scale, source OWN by default', :'ob');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"production_batches","row":{"id":"d1500000-0000-0000-0000-000000000140","scale":0}}]')$$) like '%production_batches_scale_check%', 'P: scale 0 refused');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.partner_batch_preview('{}')$$) like 'NOT_ALLOWED%' and (select count(*) from partner_debts) = 0 and (select count(*) from v_partner_to_return) = 0, 'P: a counter can''t use or read partner debts');
reset role;
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.chk(test.err(format($$select public.partner_pay('{"id":"d1500000-0000-0000-0000-000000000150","debt_id":"%s","amount":1}')$$, :'debt2')) like 'DEBT_NOT_FOUND%' and (select count(*) from v_partner_to_return) = 0, 'P: another shop sees / settles nothing');
reset role;

-- ============================ Z. security gate fixes (M1, M2, L1-L5) ============================
-- ---- M1: ids shared between waste entries, counts, R&D and stock lines ----
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('shift_open', jsonb_build_object('id','d1500000-0000-0000-0000-0000000005a1','shift_number','SHIFT-Z-0001',
   'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy','opened_at', now(),'opening_cash',0))->>'status' = 'ok', 'Z: set-up: a new shift');
select test.chk(test.op('waste', jsonb_build_object('id','d1500000-0000-0000-0000-0000000005b1','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'shift_id','d1500000-0000-0000-0000-0000000005a1','items','[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":10,"unit":"g"}]'::jsonb))->>'status' = 'ok', 'Z: set-up: a counter waste');
reset role;
select count(*) as w_lines from inventory_transactions where reference_id = 'd1500000-0000-0000-0000-0000000005b1' \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('stock_count', jsonb_build_object('id','d1500000-0000-0000-0000-0000000005b1','shift_id','d1500000-0000-0000-0000-0000000005a1','staff_id','66666666-0000-0000-0000-000000000001',
   'lines','[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":1}]'::jsonb))->>'message' = 'FORBIDDEN_ROW', 'M1: a count reusing a waste entry''s id -> FORBIDDEN_ROW');
select test.chk(test.op('stock_count', jsonb_build_object('id','d1500000-0000-0000-0000-0000000000c1','shift_id','d1500000-0000-0000-0000-0000000005a1','staff_id','66666666-0000-0000-0000-000000000001',
   'lines','[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":1}]'::jsonb))->>'message' = 'FORBIDDEN_ROW', 'M1: a count reusing any stock line''s reference (a purchase) -> FORBIDDEN_ROW');
select test.chk(test.op('waste', jsonb_build_object('id','d1500000-0000-0000-0000-0000000000f1','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'shift_id','d1500000-0000-0000-0000-0000000005a1','items','[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1,"unit":"g"}]'::jsonb))->>'message' = 'FORBIDDEN_ROW', 'M1: a counter waste reusing a count''s id -> FORBIDDEN_ROW');
reset role;
select test.chk((select count(*) from inventory_transactions where reference_id = 'd1500000-0000-0000-0000-0000000005b1') = :w_lines and :w_lines > 0
            and not exists (select 1 from stock_counts where id = 'd1500000-0000-0000-0000-0000000005b1'), 'M1: the waste entry''s stock lines are untouched');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.log_rnd_usage('{"id":"d1500000-0000-0000-0000-0000000000f1","project_id":"d1500000-0000-0000-0000-0000000000d1","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]}')$$) like 'FORBIDDEN_ROW%', 'M1: R&D reusing a count''s id -> FORBIDDEN_ROW');
select test.chk(test.err($$select public.log_rnd_usage('{"id":"d1500000-0000-0000-0000-0000000000c1","project_id":"d1500000-0000-0000-0000-0000000000d1","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]}')$$) like 'FORBIDDEN_ROW%', 'M1: R&D reusing a stock line''s reference -> FORBIDDEN_ROW');
reset role;
-- a stock line of ANOTHER record that happens to carry the count's / R&D entry's reference (e.g. left by an older version) survives a revise / delete
insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date, notes) values
  ('d1500000-0000-0000-0000-0000000005c1', :'biz', '22222222-0000-0000-0000-000000000002', 'WASTE', 7, 'd1500000-0000-0000-0000-0000000000f2', current_date, 'foreign line'),
  ('d1500000-0000-0000-0000-0000000005c2', :'biz', '22222222-0000-0000-0000-000000000002', 'WASTE', 3, 'd1500000-0000-0000-0000-0000000000e1', current_date, 'foreign line');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.revise_stock_count('d1500000-0000-0000-0000-0000000000f2', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', 1)), 'M1 test') is not null as x \gset
select public.delete_rnd_usage('d1500000-0000-0000-0000-0000000000e1')->>'deleted' as del1 \gset
reset role;
select test.chk(exists (select 1 from inventory_transactions where id = 'd1500000-0000-0000-0000-0000000005c1'), 'M1: revise_stock_count removes only the lines its count made');
select test.chk(:'del1' = 'true' and exists (select 1 from inventory_transactions where id = 'd1500000-0000-0000-0000-0000000005c2')
            and not exists (select 1 from inventory_transactions t where t.reference_id = 'd1500000-0000-0000-0000-0000000000e1' and t.id <> 'd1500000-0000-0000-0000-0000000005c2'),
            'M1: delete_rnd_usage removes only its own lines (all of them)');
select test.chk((select count(*) from stock_line_owners o join stock_counts c on c.id = o.owner_id where o.owner_kind = 'COUNT') > 0
            and not exists (select 1 from stock_line_owners o join inventory_transactions t on t.id = o.txn_id where t.notes = 'foreign line'), 'M1: counts'' own lines are listed, foreign ones not');
delete from inventory_transactions where notes = 'foreign line';

-- ---- M2 + L1: usernames ----
select test.chk(public._clean_username(u) is null, 'M2/L1: refused: ' || u)
  from unnest(array['Cora 0917 123 4567', E'０９１７１２３４５６７ Cora', E'Cora ٠٩١٧١٢٣٤٥٦٧',
                    E'Cora 12٣٤', E'Coraｘ.ｃｏｍ', E'Cora\U0001F642', E'Cora​X', E'Сora', E'Ωmega Mika', 'Mika Петрова',
                    'CCCC Staff', 'Manager Manny', 'The Barista', 'Mika the owner', 'ADMIN', 'cashier joe', 'Official Mika', 'cavite city coffee fan', E'Mika the Öwner',
                    'Mika the 0wner']) u;
select test.chk(public._clean_username(E'Ｃｏｒａ the Bean') = 'Cora the Bean', 'M2: full-width letters made standard (NFKC) first');
select test.chk(public._clean_username(E'Mika the Bean') = 'Mika the Bean', 'M2: special spaces become normal spaces');
select test.chk(public._clean_username('Staffy Mika') = 'Staffy Mika' and public._clean_username('Ñoño Café') = 'Ñoño Café' and public._clean_username('Ownership Fan') = 'Ownership Fan',
            'L1: accents fine; staff words only refused as whole words');
select test.chk(public._username_key('Míka_the-Bean  QUEEN') = public._username_key('mika the bean queen')
            and public._username_key('Mika 2O1O') = public._username_key('Mika 2010') and public._username_key('Bárn') = public._username_key('bam'), 'L1: look-alike key: case, accents, punctuation, 0/O, 1/l, rn/m');
select test.login('00000000-0000-0000-0000-0000000c1502'); set role authenticated;
select test.chk(public.qr_set_username(:'tok5', 'Míka the Bean Queen')->>'error' = 'USERNAME_TAKEN', 'L1: same name with an accent -> USERNAME_TAKEN');
select test.chk(public.qr_set_username(:'tok5', 'Mika_the-Bean  Queen')->>'error' = 'USERNAME_TAKEN', 'L1: same name with _ / - / double space -> USERNAME_TAKEN');
select test.chk(public.qr_set_username(:'tok5', 'Gina Manager')->>'error' = 'BAD_USERNAME', 'L1: a staff word -> BAD_USERNAME');
reset role;
delete from auth_attempts where kind = 'USERNAME';
select test.chk(public._username_base('Admin') = 'Kape' and public._username_base('Manager Joe') = 'Kape' and public._username_base(E'Сергей') = 'Kape'
            and public._username_base('Ñoño') = 'Ñoño', 'L1: name part never a staff word / another script');
select test.login('00000000-0000-0000-0000-0000000c1519'); set role authenticated;
select public.qr_register(:'tok5', 'Staff', null, true)->'customer'->>'username' as staffname \gset
reset role;
select test.chk(:'staffname' ~ '^Kape the ' and public._clean_username(:'staffname') = :'staffname', 'L1: nickname "Staff" gets a "Kape the ..." username', :'staffname');
select test.chk((select count(*) filter (where public._clean_username(public._new_username(:'biz', n, null)) is null) from unnest(array['Admin','Owner','CCCC','Сora','Mika','x','Official']) n, generate_series(1, 20)) = 0,
            'L1: the generator never makes a refused name (140 tries)');
select test.chk((select count(*) from customers where username is not null and public._clean_username(username) is distinct from username) = 0, 'L1: every stored username passes the rules');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err(format($$select public.apply_changes('[{"op":"update","table":"customers","row":{"id":"%s","username_key":"zed the x"}}]')$$, :'mika')) = 'NO ERROR', 'L1: set-up: a writer sends its own username_key');
reset role;
select test.chk((select username_key = public._username_key(username) from customers where id = :'mika'), 'L1: ... it is replaced by the real key (only the trigger sets it)');
select test.chk((select count(*) from customers where username is not null and username_key is distinct from public._username_key(username)) = 0, 'L1: every key is right');

-- ---- L2: per-phone limits checked under the shop's order lock ----
select test.chk((select position('pg_advisory_xact_lock' in prosrc) between 1 and position('TOO_MANY_OPEN_ORDERS' in prosrc)
                 from pg_proc where proname = 'qr_place_order' and pronamespace = 'public'::regnamespace), 'L2: the lock comes before the per-phone checks');

-- ---- L3: relink tries per number, "opened on another phone" ----
create or replace function test.relink_as(p_uid uuid, tok text, ph text, nick text) returns text language plpgsql as $f$
begin perform test.login(p_uid); return coalesce(public.qr_relink(tok, ph, nick)->>'error', 'ok'); end $f$;
select test.chk(string_agg(test.relink_as(('00000000-0000-0000-0000-0000000c15' || (20 + g))::uuid, :'tok5', '0917 555 0001', 'Not Mika'), ',' order by g) = 'NO_MATCH,NO_MATCH,NO_MATCH,NO_MATCH,NO_MATCH',
            'L3: set-up: 5 phones, 1 wrong try each on Mika''s number') from generate_series(1, 5) g;
select test.login('00000000-0000-0000-0000-0000000c1526'); set role authenticated;
select test.chk(public.qr_relink(:'tok5', '0917 555 0001', 'Mika')->>'error' = 'TOO_MANY_ATTEMPTS', 'L3: 5 wrong tries on a number from 5 phones -> the right nickname is refused too (TOO_MANY_ATTEMPTS)');
reset role;
select test.chk(string_agg(test.relink_as(('00000000-0000-0000-0000-0000000c15' || (30 + g))::uuid, :'tok5', '0917 999 0000', 'Nobody'), ',' order by g) = 'NO_MATCH,NO_MATCH,NO_MATCH,NO_MATCH,NO_MATCH',
            'L3: set-up: 5 phones, 1 wrong try each on an unused number') from generate_series(1, 5) g;
select test.login('00000000-0000-0000-0000-0000000c1536'); set role authenticated;
select test.chk(public.qr_relink(:'tok5', '0917 999 0000', 'Nobody')->>'error' = 'TOO_MANY_ATTEMPTS', 'L3: same answer for a number nobody has (does not reveal registered numbers)');
select test.chk(public.qr_relink(:'tok5', '0917 123 4567', 'Zed')->>'relinked' = 'true', 'L3: other numbers unaffected (phone c1536 opens Zed)');
reset role;
select test.chk(not exists (select 1 from auth_attempts where kind = 'RELINK_NUMBER' and subject::text like '%5550001%'), 'L3: the number itself is not stored');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(exists (select 1 from jsonb_array_elements(public.fo_customer_list('Mika', 20)->'customers') c where c->>'nickname' = 'Mika'), 'L3: the counter can still find the customer');
reset role;
select test.login('00000000-0000-0000-0000-0000000c1537'); set role authenticated;
select test.chk(public.qr_relink(:'tok5', '0917 123 4567', 'Zed')->>'relinked' = 'true' and not (public.qr_session(:'tok5') ? 'signed_out_elsewhere'), 'L3: Zed opened on phone c1537 (no note there)');
select test.login('00000000-0000-0000-0000-0000000c1536');
select public.qr_session(:'tok5') as so1 \gset
select test.chk(:'so1'::jsonb = '{"customer":null,"state":"GUEST","signed_out_elsewhere":true}'::jsonb, 'L3: the old phone is told once: signed_out_elsewhere', :'so1');
select test.chk(public.qr_session(:'tok5') = '{"customer":null,"state":"GUEST"}'::jsonb, 'L3: ... only once');
reset role;
select test.chk(not exists (select 1 from qr_signout_notices where auth_user_id = '00000000-0000-0000-0000-0000000c1536'), 'L3: note removed after it was shown');

-- ---- L5: delete customer data also blanks the username ----
select test.login('00000000-0000-0000-0000-0000000c1538'); set role authenticated;
select public.qr_register(:'tok5', 'Lina', '0917 555 0038', true) is not null as x \gset
select test.chk(public.qr_set_username(:'tok5', 'Bubbly Queen Bee')->'customer'->>'username' = 'Bubbly Queen Bee', 'L5: set-up: Lina is "Bubbly Queen Bee"');
select public.qr_place_order(:'tokta', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]', 'for bubbly queen bee, thanks') -> 'order' ->> 'id' as lina_order \gset
reset role;
select id as lina from customers where nickname = 'Lina' \gset
insert into audit_log(business_id, action, details) values (:'biz', 'Note', 'Bubbly Queen Bee asked for oat milk; Bubbly Queen Beehive is a drink');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(public.delete_customer_data(:'lina') = '{"deleted":1}'::jsonb, 'L5: delete customer data works as before');
reset role;
select test.chk((select customer_note from qr_orders where id = :'lina_order') = 'for [deleted customer], thanks', 'L5: username blanked in the QR order note', (select customer_note from qr_orders where id = :'lina_order'));
select test.chk((select details from audit_log where action = 'Note' and business_id = :'biz' order by at desc limit 1) = '[deleted customer] asked for oat milk; Bubbly Queen Beehive is a drink',
            'L5: username blanked in the audit log (whole words only)', (select details from audit_log where action = 'Note' and business_id = :'biz' order by at desc limit 1));
select test.chk(not exists (select 1 from customers where id = :'lina') and (select customer_id is null and customer_nickname is null from qr_orders where id = :'lina_order'), 'L5: record gone, order unlinked (as 004)');

-- ---- L4: counts ----
-- give beans plenty of stock so the shortages below are real
insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date, notes)
  values (:'biz', '22222222-0000-0000-0000-000000000001', 'INITIAL_STOCK', 5000, current_date, 'L4 set-up');
select test.stock('22222222-0000-0000-0000-000000000001') as zb \gset
select test.stock('22222222-0000-0000-0000-000000000002') as zm \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('stock_count', jsonb_build_object('id','d1500000-0000-0000-0000-0000000005d1','shift_id','d1500000-0000-0000-0000-0000000005a1','staff_id','66666666-0000-0000-0000-000000000001',
   'lines', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', :zb),
                              jsonb_build_object('ingredient_id','d1500000-0000-0000-0000-000000000001','quantity', 0))))->>'message' = 'BAD_COUNT', 'L4: an item that is not ticked -> BAD_COUNT');
-- count 1: beans only, 600 missing (₱600, under the ₱1000 limit)
select test.chk(test.op('stock_count', jsonb_build_object('id','d1500000-0000-0000-0000-0000000005d2','shift_id','d1500000-0000-0000-0000-0000000005a1','staff_id','66666666-0000-0000-0000-000000000001',
   'lines', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', :zb - 600))))->>'status' = 'ok', 'L4: count of beans only accepted');
select test.chk(test.op('shift_close', jsonb_build_object('id','d1500000-0000-0000-0000-0000000005a1','closed_by','66666666-0000-0000-0000-000000000001','closed_at', now(),'declared_cash',0))->>'message' = 'COUNT_REQUIRED',
            'L4: a count that misses a ticked item does not allow closing (COUNT_REQUIRED)');
-- count 2: both items, another 600 missing: ₱1200 for the shift
select test.chk(test.op('stock_count', jsonb_build_object('id','d1500000-0000-0000-0000-0000000005d3','shift_id','d1500000-0000-0000-0000-0000000005a1','staff_id','66666666-0000-0000-0000-000000000001',
   'lines', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', :zb - 1200),
                              jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000002','quantity', :zm))))->>'status' = 'ok', 'L4: full count accepted');
reset role;
select test.chk((select coalesce(review_reason, '') not like '%LARGE_SHORTAGE%' and shortage_cost = 600 from stock_counts where id = 'd1500000-0000-0000-0000-0000000005d2')
            and (select review_reason like '%LARGE_SHORTAGE%' and shortage_cost = 600 from stock_counts where id = 'd1500000-0000-0000-0000-0000000005d3'),
            'L4: LARGE_SHORTAGE on the shift''s total (600 + 600 > 1000), not only per count',
            (select string_agg(id::text || ':' || coalesce(review_reason, '-') || ':' || shortage_cost, ' | ') from stock_counts where shift_id = 'd1500000-0000-0000-0000-0000000005a1'));
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('shift_close', jsonb_build_object('id','d1500000-0000-0000-0000-0000000005a1','closed_by','66666666-0000-0000-0000-000000000001','closed_at', now(),'declared_cash',0))->>'status' = 'ok',
            'L4: with a count of every ticked item the shift closes');
reset role;
update ingredients set count_at_close = false where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('stock_count', jsonb_build_object('id','d1500000-0000-0000-0000-0000000005d4','shift_id','d1500000-0000-0000-0000-0000000005a1','staff_id','66666666-0000-0000-0000-000000000001',
   'lines', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1}]'::jsonb))->>'message' = 'BAD_COUNT', 'L4: nothing ticked -> BAD_COUNT');
reset role;

-- ============================ B16. next card after the last reward, card history ============================
update settings set loyalty_enabled = true where business_id = :'biz';
select test.chk(public._loyalty_config(:'biz') @> '{"card_size":15}'::jsonb and public._loyalty_last_stamp(public._loyalty_config(:'biz')) = 15, 'B16: set-up: card of 15, last reward at 15');
-- a stamp = a drink sale on its own day; a "used reward" = a sale without items (no stamp) + its redemption row
create or replace function test.b16_stamp(p_cust uuid, p_day int) returns void language plpgsql as $f$
declare v_biz uuid := (select business_id from customers where id = p_cust); v_id uuid := gen_random_uuid();
begin
  insert into sales(id, business_id, transaction_number, transaction_date, status, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total, customer_id)
    values (v_id, v_biz, 'B16-' || left(v_id::text, 8), '2026-09-01 10:00+08'::timestamptz + make_interval(days => p_day), 'COMPLETED', 150, 0, 0, 0, 150, p_cust);
  insert into sale_items(id, business_id, sale_id, recipe_id, name, quantity, unit_price, line_total)
    values (gen_random_uuid(), v_biz, v_id, '33333333-0000-0000-0000-000000000001', 'Iced Latte', 1, 150, 150);
end $f$;
create or replace function test.b16_use(p_cust uuid, p_card int, p_ms int, p_at timestamptz) returns uuid language plpgsql as $f$
declare v_biz uuid := (select business_id from customers where id = p_cust); v_id uuid := gen_random_uuid();
begin
  insert into sales(id, business_id, transaction_number, transaction_date, status, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total, customer_id)
    values (v_id, v_biz, 'B16R-' || left(v_id::text, 8), p_at, 'COMPLETED', 100, 0, 0, 0, 100, p_cust);
  insert into loyalty_redemptions(business_id, customer_id, card_no, milestone, reward_type, sale_id, amount)
    values (v_biz, p_cust, p_card, p_ms, case when p_ms = 15 then 'FREE_ITEM' else 'AMOUNT_OFF' end, v_id, case p_ms when 5 then 10 when 10 then 50 else 150 end);
  return v_id;
end $f$;
create or replace function test.b16_try(p_cust uuid, p_card int, p_ms int) returns text language plpgsql as $f$
begin
  return public._loyalty_reward_amount((select business_id from customers where id = p_cust), gen_random_uuid(),
           jsonb_build_object('customer_id', p_cust, 'subtotal', 150, 'discount_amount', 0), '[]'::jsonb,
           jsonb_build_object('customer_id', p_cust, 'card_no', p_card, 'milestone', p_ms))::text;
exception when others then return sqlerrm;
end $f$;
create or replace function test.ls(p_cust uuid) returns jsonb language sql as $f$
  select public._loyalty_summary((select business_id from customers where id = p_cust), p_cust)
$f$;
create or replace function test.ready(p_cust uuid) returns text language sql as $f$
  select coalesce(string_agg((r->>'card_no') || '/' || (r->>'stamp'), ',' order by (r->>'card_no')::int, (r->>'stamp')::int), '')
  from jsonb_array_elements(test.ls(p_cust)->'ready_rewards') r
$f$;
insert into customers(id, business_id, nickname, phone, source) values ('b1600000-0000-0000-0000-0000000000c1', :'biz', 'Cardy', '+639181116001', 'COUNTER');
select count(*) from (select test.b16_stamp('b1600000-0000-0000-0000-0000000000c1', d) from generate_series(1, 20) d) z;
-- existing customer past stamp 15 with the last reward unused (also how live customers look after 012)
select test.chk(test.ls('b1600000-0000-0000-0000-0000000000c1')->'card' @> '{"card_no":1,"stamps_on_card":15,"saved_stamps":5,"last_reward_stamp":15}'::jsonb
            and test.ready('b1600000-0000-0000-0000-0000000000c1') = '1/5,1/10,1/15' and test.ls('b1600000-0000-0000-0000-0000000000c1')->'history' = '[]'::jsonb,
            'B16: 20 stamps, stamp-15 reward unused -> card 1 at 15/15, 5 saved, no card-2 reward ready', test.ls('b1600000-0000-0000-0000-0000000000c1')::text);
select test.chk(test.b16_try('b1600000-0000-0000-0000-0000000000c1', 2, 5) = 'CARD_NOT_ISSUED', 'B16: card 2 reward refused by the server -> CARD_NOT_ISSUED', test.b16_try('b1600000-0000-0000-0000-0000000000c1', 2, 5));
select test.chk(public._fo_error_code('CARD_NOT_ISSUED') = 'CARD_NOT_ISSUED', 'B16: CARD_NOT_ISSUED reaches the counter as is');
select test.chk(test.b16_try('b1600000-0000-0000-0000-0000000000c1', 1, 5) = '10.00', 'B16: card 1 rewards still usable');
select test.b16_use('b1600000-0000-0000-0000-0000000000c1', 1, 5, '2026-09-25 10:00+08') is not null as x \gset
select test.chk((test.ls('b1600000-0000-0000-0000-0000000000c1')->'card'->>'card_no')::int = 1 and test.ready('b1600000-0000-0000-0000-0000000000c1') = '1/10,1/15',
            'B16: using an earlier reward does not issue the next card');
-- the last reward is used -> card 2 opens with the 5 saved stamps, its stamp-5 reward ready at once
select test.b16_use('b1600000-0000-0000-0000-0000000000c1', 1, 15, '2026-09-26 10:00+08') as last1 \gset
select test.chk(test.ls('b1600000-0000-0000-0000-0000000000c1')->'card' @> '{"card_no":2,"stamps_on_card":5,"saved_stamps":0}'::jsonb
            and test.ready('b1600000-0000-0000-0000-0000000000c1') = '1/10,2/5', 'B16: last reward used -> card 2 shows the 5 saved stamps; card 2 stamp 5 ready; card 1 stamp 10 still ready',
            test.ready('b1600000-0000-0000-0000-0000000000c1'));
select test.ls('b1600000-0000-0000-0000-0000000000c1')->'history' as h1 \gset
select test.chk(jsonb_array_length(:'h1'::jsonb) = 1 and (:'h1'::jsonb->0->>'card_no')::int = 1
            and (:'h1'::jsonb->0->>'filled_at')::timestamptz = '2026-09-16 10:00+08'
            and (:'h1'::jsonb->0->>'completed_at')::timestamptz = '2026-09-26 10:00+08'
            and (select string_agg(r->>'stamp', ',' order by (r->>'stamp')::int) from jsonb_array_elements(:'h1'::jsonb->0->'rewards') r) = '5,15',
            'B16: history: card 1, filled at the 15th stamp, completed when the free drink was used, rewards 5 + 15', :'h1');
select test.chk(test.b16_try('b1600000-0000-0000-0000-0000000000c1', 2, 5) = '10.00', 'B16: card 2 reward now usable');
select test.b16_use('b1600000-0000-0000-0000-0000000000c1', 2, 5, '2026-09-27 10:00+08') is not null as x \gset
-- void the sale that used card 1's last reward: card 2 closes again
update sales set status = 'VOIDED' where id = :'last1';
select test.chk(test.ls('b1600000-0000-0000-0000-0000000000c1')->'card' @> '{"card_no":1,"stamps_on_card":15,"saved_stamps":5}'::jsonb
            and test.ready('b1600000-0000-0000-0000-0000000000c1') = '1/10,1/15' and test.ls('b1600000-0000-0000-0000-0000000000c1')->'history' = '[]'::jsonb,
            'B16: void of that sale -> back on card 1 (15/15, 5 saved), free drink ready again, history empty', test.ls('b1600000-0000-0000-0000-0000000000c1')->>'card');
select test.chk((select released_at is null from loyalty_redemptions where customer_id = 'b1600000-0000-0000-0000-0000000000c1' and card_no = 2 and milestone = 5)
            and test.b16_try('b1600000-0000-0000-0000-0000000000c1', 2, 10) = 'CARD_NOT_ISSUED', 'B16: ... the reward used on card 2 stays used; card 2 rewards refused again');
select test.b16_use('b1600000-0000-0000-0000-0000000000c1', 1, 15, '2026-09-28 10:00+08') is not null as x \gset
select test.chk((select m->>'status' from jsonb_array_elements(test.ls('b1600000-0000-0000-0000-0000000000c1')->'card'->'milestones') m where (m->>'stamp')::int = 5) = 'redeemed'
            and (test.ls('b1600000-0000-0000-0000-0000000000c1')->'card'->>'card_no')::int = 2
            and (test.ls('b1600000-0000-0000-0000-0000000000c1')->'history'->0->>'completed_at')::timestamptz = '2026-09-28 10:00+08',
            'B16: free drink used again -> card 2 reopens, its stamp 5 still shown used; completed_at = the new use');
-- several cards' worth saved: 20 more stamps (40 in all) -> card 2 full, 10 saved; each card waits for its own last reward
select count(*) from (select test.b16_stamp('b1600000-0000-0000-0000-0000000000c1', d) from generate_series(31, 50) d) z;
select test.chk(test.ls('b1600000-0000-0000-0000-0000000000c1')->'card' @> '{"card_no":2,"stamps_on_card":15,"saved_stamps":10}'::jsonb
            and test.ready('b1600000-0000-0000-0000-0000000000c1') = '1/10,2/10,2/15', 'B16: 40 stamps -> card 2 at 15/15 with 10 saved, nothing of card 3 ready', test.ready('b1600000-0000-0000-0000-0000000000c1'));
select test.chk(test.b16_try('b1600000-0000-0000-0000-0000000000c1', 3, 5) = 'CARD_NOT_ISSUED', 'B16: card 3 not issued yet');
select test.b16_use('b1600000-0000-0000-0000-0000000000c1', 2, 15, '2026-10-25 10:00+08') is not null as x \gset
select test.chk(test.ls('b1600000-0000-0000-0000-0000000000c1')->'card' @> '{"card_no":3,"stamps_on_card":10,"saved_stamps":0}'::jsonb
            and test.ready('b1600000-0000-0000-0000-0000000000c1') = '1/10,2/10,3/5,3/10' and jsonb_array_length(test.ls('b1600000-0000-0000-0000-0000000000c1')->'history') = 2,
            'B16: card 2''s last reward used -> card 3 with 10 stamps, stamps 5 and 10 ready at once; history has 2 cards', test.ready('b1600000-0000-0000-0000-0000000000c1'));
select count(*) from (select test.b16_stamp('b1600000-0000-0000-0000-0000000000c1', 60)) z;
select test.chk((test.ls('b1600000-0000-0000-0000-0000000000c1')->>'total_stamps')::int = 41 and (test.ls('b1600000-0000-0000-0000-0000000000c1')->'card'->>'stamps_on_card')::int = 11,
            'B16: no stamp lost: 41 stamps = 15 + 15 + 11', test.ls('b1600000-0000-0000-0000-0000000000c1')->>'card');
-- every app reads the same answer
select test.chk((public._counter_customer_json(c, false)->'history') = test.ls(c.id)->'history' and (public._counter_customer_json(c, false)->'card') = test.ls(c.id)->'card'
            and (public._qr_customer_json(c)->'history') = test.ls(c.id)->'history', 'B16: counter card and QR page get the same card + history')
  from customers c where c.id = 'b1600000-0000-0000-0000-0000000000c1';
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.bo_customer_loyalty(array['b1600000-0000-0000-0000-0000000000c1'::uuid, '00000000-0000-0000-0000-000000000000'::uuid]) as bl \gset
reset role;
select test.chk(:'bl'::jsonb->'b1600000-0000-0000-0000-0000000000c1' = test.ls('b1600000-0000-0000-0000-0000000000c1') and (select count(*) from jsonb_object_keys(:'bl'::jsonb)) = 1,
            'B16: Back Office bo_customer_loyalty = the same summary (unknown ids left out)');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.bo_customer_loyalty(array['b1600000-0000-0000-0000-0000000000c1'::uuid])$$) like 'NOT_ALLOWED%', 'B16: a counter can''t call bo_customer_loyalty');
reset role;
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.chk(public.bo_customer_loyalty(array['b1600000-0000-0000-0000-0000000000c1'::uuid]) = '{}'::jsonb, 'B16: another shop''s owner gets nothing');
reset role;
-- merge (1.2 rules): the merged record's stamps and used rewards move; the card is worked out again
insert into customers(id, business_id, nickname, phone, source) values
  ('b1600000-0000-0000-0000-0000000000d1', :'biz', 'Keepy', '+639181116002', 'COUNTER'),
  ('b1600000-0000-0000-0000-0000000000d2', :'biz', 'Moved', '+639181116003', 'COUNTER');
select count(*) from (select test.b16_stamp('b1600000-0000-0000-0000-0000000000d1', d) from generate_series(1, 3) d) z;
select count(*) from (select test.b16_stamp('b1600000-0000-0000-0000-0000000000d2', d) from generate_series(11, 26) d) z;
select test.b16_use('b1600000-0000-0000-0000-0000000000d2', 1, 15, '2026-10-01 10:00+08') is not null as x \gset
select test.chk(test.ls('b1600000-0000-0000-0000-0000000000d1')->'card' @> '{"card_no":1,"stamps_on_card":3}'::jsonb
            and test.ls('b1600000-0000-0000-0000-0000000000d2')->'card' @> '{"card_no":2,"stamps_on_card":1}'::jsonb, 'B16: set-up for merge (3 stamps / 16 stamps + card 1 done)');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.merge_customers('b1600000-0000-0000-0000-0000000000d1', 'b1600000-0000-0000-0000-0000000000d2') is not null as x \gset
reset role;
select test.chk(test.ls('b1600000-0000-0000-0000-0000000000d1')->'card' @> '{"card_no":2,"stamps_on_card":4,"saved_stamps":0}'::jsonb
            and jsonb_array_length(test.ls('b1600000-0000-0000-0000-0000000000d1')->'history') = 1,
            'B16: after the merge: 19 stamps, the moved free drink completes card 1 -> card 2 at 4', test.ls('b1600000-0000-0000-0000-0000000000d1')->>'card');
-- erase: the card and its history go with the record
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.delete_customer_data('b1600000-0000-0000-0000-0000000000d1') is not null as x \gset
reset role;
select test.chk(not exists (select 1 from loyalty_redemptions where customer_id in ('b1600000-0000-0000-0000-0000000000d1', 'b1600000-0000-0000-0000-0000000000d2')),
            'B16: delete customer data removes the used rewards (no card, no history left)');
-- guests have no card
select test.login('00000000-0000-0000-0000-0000000c1509'); set role authenticated;
select test.chk(public.qr_session(:'tokta')->'customer' = 'null'::jsonb, 'B16: a guest has no card');
reset role;
select test.chk(public._qr_customer_json(null::customers) is null, 'B16: ... and no card answer at all');

-- ============================ RC. security re-check fixes (2026-11-10) ============================
-- ---- Low 1: merge when both records used the same free drink ----
insert into customers(id, business_id, nickname, phone, source) values
  ('b1600000-0000-0000-0000-0000000000e1', :'biz', 'Ann', '+639181116011', 'COUNTER'),
  ('b1600000-0000-0000-0000-0000000000e2', :'biz', 'Ann Two', '+639181116012', 'COUNTER');
select count(*) from (select test.b16_stamp('b1600000-0000-0000-0000-0000000000e1', d) from generate_series(101, 115) d) z;
select count(*) from (select test.b16_stamp('b1600000-0000-0000-0000-0000000000e2', d) from generate_series(121, 135) d) z;
select test.b16_use('b1600000-0000-0000-0000-0000000000e1', 1, 15, '2027-02-01 10:00+08') is not null as x \gset
select test.b16_use('b1600000-0000-0000-0000-0000000000e2', 1, 15, '2027-02-02 10:00+08') is not null as x \gset
select test.b16_use('b1600000-0000-0000-0000-0000000000e2', 1, 5, '2027-02-03 10:00+08') as e2v \gset
update sales set status = 'VOIDED' where id = :'e2v';      -- a given-back reward (moves as history only, as 008)
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.merge_customers('b1600000-0000-0000-0000-0000000000e1', 'b1600000-0000-0000-0000-0000000000e2') is not null as x \gset
reset role;
select test.chk((select string_agg(card_no || '/' || milestone, ',' order by card_no) from loyalty_redemptions
                 where customer_id = 'b1600000-0000-0000-0000-0000000000e1' and milestone = 15 and released_at is null and merged_from is null) = '1/15,2/15',
            'Low1: both used free drinks count: kept on card 1 and card 2', (select string_agg(card_no || '/' || milestone || ':' || coalesce(merged_from::text, '-'), ',') from loyalty_redemptions where customer_id = 'b1600000-0000-0000-0000-0000000000e1'));
select test.chk(test.ls('b1600000-0000-0000-0000-0000000000e1')->'card' @> '{"card_no":3,"stamps_on_card":0,"saved_stamps":0}'::jsonb
            and test.ready('b1600000-0000-0000-0000-0000000000e1') = '1/5,1/10,2/5,2/10',
            'Low1: 30 stamps + 2 free drinks used -> card 3, no third free drink', test.ready('b1600000-0000-0000-0000-0000000000e1'));
select test.chk((select merged_from = 'b1600000-0000-0000-0000-0000000000e2' and released_at is not null from loyalty_redemptions where sale_id = :'e2v'),
            'Low1: a given-back reward moves as history only (008 rule kept)');
select test.chk(test.b16_try('b1600000-0000-0000-0000-0000000000e1', 2, 15) = 'REWARD_NOT_AVAILABLE' and test.b16_try('b1600000-0000-0000-0000-0000000000e1', 3, 15) = 'REWARD_NOT_AVAILABLE',
            'Low1: no extra free drink can be used after the merge');
-- ---- Low 2: look-alike letters ----
select test.chk(public._clean_username(u) is null, 'Low2: refused: ' || u)
  from unnest(array[E'Rina ǃ', E'Rinaǀx', E'ǁRina', E'Miƨa', E'Riȝna', 'Rina the Bar1sta', 'Rina offic1al', E'Rina Sŧaff', 'Rina Barisŧa', E'Mika the Øwner', 'Owŋer Jo']) u;
select test.chk(public._username_key(a) = public._username_key(b), 'Low2: same key: ' || a || ' = ' || b)
  from (values (E'Miħa', 'Miha'), (E'Mıka', 'Mika'), (E'MƗka', 'Mika'), (E'Ŧom', 'Tom'), (E'Đan', 'Dan'), (E'Boƀ', 'Bob'),
               (E'Caƚr', 'Calr'), (E'Øla', 'Ola'), (E'Miła', 'Mila'), (E'Joɇ', 'Joe')) v(a, b);
select test.chk(public._clean_username(E'MƗka Rose') = E'MƗka Rose' and public._clean_username('Ñoño Café') = 'Ñoño Café' and public._clean_username('Rina 2010') = 'Rina 2010',
            'Low2: ordinary accented / stroke names still allowed');
select test.login('00000000-0000-0000-0000-0000000c1502'); set role authenticated;
select test.chk(public.qr_set_username(:'tok5', 'Miĸa the Bean Queen')->>'error' = 'USERNAME_TAKEN', 'Low2: "Miĸa the Bean Queen" (kra) = "Mika the Bean Queen" -> USERNAME_TAKEN');
reset role;
-- ---- relink race: the customer row is locked ----
select test.chk((select prosrc ~ 'for update' from pg_proc where proname = 'qr_relink' and pronamespace = 'public'::regnamespace), 'Race: qr_relink locks the customer row');

-- ============================ B17. edit / delete waste (owner only) ============================
create or replace function test.owned(p_id uuid) returns text language sql as $f$
  select coalesce(string_agg(o.owner_kind || ':' || trim(to_char(t.quantity, 'FM999999990.999999'), '.') || '@' || t.transaction_date, ',' order by t.ingredient_id, t.quantity), '')
  from stock_line_owners o join inventory_transactions t on t.id = o.txn_id where o.owner_id = p_id
$f$;
create or replace function test.wr(p_id uuid) returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  perform test.login('00000000-0000-0000-0000-0000000000a1');
  select e into r from jsonb_array_elements(public.waste_report(current_date - 60, current_date + 1)->'entries') e where e->>'id' = p_id::text;
  return r;
end $f$;
select test.stock('22222222-0000-0000-0000-000000000001') as b0 \gset
select test.stock('22222222-0000-0000-0000-000000000002') as m0 \gset
-- set-up: two counter entries (an ingredient, a menu item), an R&D entry, two Back Office rows (one without a stock line)
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('waste', jsonb_build_object('id','b1700000-0000-0000-0000-000000000001','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":10,"unit":"g"}]'::jsonb))->>'status' = 'ok'
  and test.op('waste', jsonb_build_object('id','b1700000-0000-0000-0000-000000000002','reason','CALIBRATION','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]'::jsonb))->>'status' = 'ok', 'B17: set-up: two counter waste entries');
reset role;
select test.chk(test.owned('b1700000-0000-0000-0000-000000000001') = 'WASTE:10@' || (select waste_date from waste_logs where id = 'b1700000-0000-0000-0000-000000000001'),
            'B17: a counter upload notes its own stock lines', test.owned('b1700000-0000-0000-0000-000000000001'));
select total_cost as w2cost from waste_logs where id = 'b1700000-0000-0000-0000-000000000002' \gset
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.log_rnd_usage(jsonb_build_object('id','b1700000-0000-0000-0000-000000000003','project_id','d1500000-0000-0000-0000-0000000000d1',
  'items', '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":30}]'::jsonb)) is not null as x \gset
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','waste','row', jsonb_build_object('id','b1700000-0000-0000-0000-000000000004','ingredient_id','22222222-0000-0000-0000-000000000001','quantity',40,'unit','g','reason','Expired','date',current_date,'notes','old bag')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','b1700000-0000-0000-0000-0000000000a4','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','WASTE','quantity',40,'reference_id','b1700000-0000-0000-0000-000000000004','transaction_date',current_date,'notes','Expired — old bag')),
  jsonb_build_object('op','upsert','table','waste','row', jsonb_build_object('id','b1700000-0000-0000-0000-000000000005','ingredient_id','22222222-0000-0000-0000-000000000001','quantity',5,'unit','g','reason','Spillage','date',current_date,'notes','')))) is not null as x \gset
reset role;
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :b0 - 10 - 18 - 30 - 40, 'B17: set-up stock (10 + 18 + 30 + 40 g of beans off)');
select id as shortage from waste_logs where reason = 'COUNT_SHORTAGE' and business_id = :'biz' limit 1 \gset

-- ---- who may ----
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","reason":"EXPIRED"}')$$) like 'NOT_ALLOWED%'
            and test.err($$select public.delete_waste('b1700000-0000-0000-0000-000000000001', 'x')$$) like 'NOT_ALLOWED%', 'B17: a counter can''t edit or delete waste (NOT_ALLOWED)');
reset role;
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","reason":"EXPIRED"}')$$) like 'WASTE_NOT_FOUND%'
            and test.err($$select public.delete_waste('b1700000-0000-0000-0000-000000000004', 'x')$$) like 'WASTE_NOT_FOUND%', 'B17: another shop''s owner -> WASTE_NOT_FOUND');
reset role;
select test.login('00000000-0000-0000-0000-0000000c1503'); set role authenticated;
select test.chk(test.err($$select public.delete_waste('b1700000-0000-0000-0000-000000000001', 'x')$$) ~ '^(NOT_ALLOWED|NOT_A_MEMBER)', 'B17: a QR customer can''t', test.err($$select public.delete_waste('b1700000-0000-0000-0000-000000000001', 'x')$$));
reset role;
select test.chk(not has_function_privilege('anon', 'public.revise_waste(jsonb)', 'execute') and not has_function_privilege('anon', 'public.delete_waste(uuid,text)', 'execute')
            and not has_function_privilege('authenticated', 'public._adopt_waste_lines(uuid,uuid,text)', 'execute'), 'B17: no sign-in -> no access; the helper is internal');

-- ---- counter entry: the note, guard rails ----
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","reason":"EXPIRED"}')$$) like 'NOTE_REQUIRED%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"  ","reason":"EXPIRED"}')$$) like 'NOTE_REQUIRED%'
            and test.err($$select public.delete_waste('b1700000-0000-0000-0000-000000000001', '')$$) like 'NOTE_REQUIRED%'
            and test.err($$select public.delete_waste('b1700000-0000-0000-0000-000000000004', null)$$) like 'NOTE_REQUIRED%', 'B17: no note -> NOTE_REQUIRED (edit and delete, both kinds)');
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","reason":"RND"}')$$) like 'BAD_WASTE_REASON%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","reason":"COUNT_SHORTAGE"}')$$) like 'BAD_WASTE_REASON%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","reason":"Whatever"}')$$) like 'BAD_WASTE_REASON%', 'B17: reason RND / COUNT_SHORTAGE / unknown -> BAD_WASTE_REASON');
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","reason":"OTHER"}')$$) like 'ENTRY_NOTE_REQUIRED%', 'B17: OTHER without the entry''s note -> ENTRY_NOTE_REQUIRED');
select test.chk(test.err(format($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","waste_date":"%s"}')$$, current_date + 2)) like 'BAD_DATE%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","waste_date":"nonsense"}')$$) like 'BAD_DATE%', 'B17: a future / unreadable date -> BAD_DATE');
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":0}]}')$$) like 'BAD_QUANTITY%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":-3}]}')$$) like 'BAD_QUANTITY%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","items":[]}')$$) like 'BAD_WASTE%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1,"unit":"ml"}]}')$$) like 'BAD_UNIT%', 'B17: amounts must be above 0, list not empty, unit must convert');
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","reason":"spillage","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":10,"unit":"g"}]}')$$) like 'NO_CHANGE%', 'B17: nothing different -> NO_CHANGE');
select test.chk(test.err(format($$select public.revise_waste('{"id":"%s","edit_note":"x","reason":"SPILLAGE"}')$$, :'shortage')) like 'USE_COUNT_REVISION%'
            and test.err(format($$select public.delete_waste('%s', 'x')$$, :'shortage')) like 'USE_COUNT_REVISION%', 'B17: "missing at count" entries -> USE_COUNT_REVISION (edit and delete)');
reset role;
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :b0 - 98 and (select edited_at is null from waste_logs where id = 'b1700000-0000-0000-0000-000000000001'), 'B17: refused edits change nothing');

-- ---- counter entry: amount (the server works out stock + cost; what the app sends for them is ignored) ----
-- a line of ANOTHER record that carries this entry's reference must survive
insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date, notes)
  values ('b1700000-0000-0000-0000-0000000000f1', :'biz', '22222222-0000-0000-0000-000000000002', 'WASTE', 7, 'b1700000-0000-0000-0000-000000000001', current_date, 'foreign line');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"it was the whole scoop",
  "items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":0.025,"unit":"kg","stock_lines":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":99999}],"cost":0}],
  "total_cost":0,"stock_lines":[]}') as r1 \gset
reset role;
select test.chk((:'r1'::jsonb->>'total_cost')::numeric = 25 and :'r1'::jsonb->'changed' = '["items"]'::jsonb and test.stock('22222222-0000-0000-0000-000000000001') = :b0 - 98 - 15,
            'B17: amount 10 g -> 0.025 kg: 15 g more off stock, cost 25 (server''s numbers)', :'r1');
select test.chk(test.owned('b1700000-0000-0000-0000-000000000001') = 'WASTE:25@' || current_date and exists (select 1 from inventory_transactions where id = 'b1700000-0000-0000-0000-0000000000f1'),
            'B17: exactly its own stock line re-made; another record''s line with the same reference untouched', test.owned('b1700000-0000-0000-0000-000000000001'));
select test.chk(test.wr('b1700000-0000-0000-0000-000000000001') @> '{"edited":true,"editable":true,"entry_table":"waste_logs","edit_note":"it was the whole scoop","cost":25}'::jsonb
            and (test.wr('b1700000-0000-0000-0000-000000000001')->>'edited_at') is not null and (test.wr('b1700000-0000-0000-0000-000000000001')->>'edited_by_name') is not null,
            'B17: waste report shows the Edited mark + new cost', test.wr('b1700000-0000-0000-0000-000000000001')::text);
select test.chk(test.wr('b1700000-0000-0000-0000-000000000002') @> '{"edited":false,"editable":true}'::jsonb and test.wr(:'shortage') @> '{"editable":false,"edited":false}'::jsonb, 'B17: untouched entries: not edited; count shortage not editable');
select test.chk(exists (select 1 from audit_log where action = 'Waste edited' and reference_id = 'b1700000-0000-0000-0000-000000000001'
                        and details like '%amount: %10 g -> %0.025 kg%' and details like '%cost: 10.00 -> 25.00%' and details like '%Note: it was the whole scoop%'),
            'B17: audit entry with old -> new values and the note', (select details from audit_log where action = 'Waste edited' order by at desc limit 1));
-- ---- reason + note only: no stock change; line label follows ----
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"wrong reason picked","reason":"OTHER","note":"fell behind the fridge"}') as r2 \gset
reset role;
select test.chk(:'r2'::jsonb->'changed' = '["reason","note"]'::jsonb and test.stock('22222222-0000-0000-0000-000000000001') = :b0 - 113
            and (select reason = 'OTHER' and note = 'fell behind the fridge' and total_cost = 25 from waste_logs where id = 'b1700000-0000-0000-0000-000000000001')
            and (select notes from inventory_transactions t join stock_line_owners o on o.txn_id = t.id where o.owner_id = 'b1700000-0000-0000-0000-000000000001') = 'Counter waste: Other',
            'B17: reason + note changed, stock and cost untouched', :'r2');
-- ---- date: stock line re-dated, date flag by the upload rules ----
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.revise_waste(jsonb_build_object('id','b1700000-0000-0000-0000-000000000001','edit_note','it happened last week','waste_date', current_date - 10)) as r3 \gset
reset role;
select test.chk(test.owned('b1700000-0000-0000-0000-000000000001') = 'WASTE:25@' || (current_date - 10) and test.stock('22222222-0000-0000-0000-000000000001') = :b0 - 113
            and (select waste_date = current_date - 10 and needs_review and review_reason like '%OLD_DATE%' from waste_logs where id = 'b1700000-0000-0000-0000-000000000001'),
            'B17: date moved 10 days back: line re-dated, same stock, OLD_DATE flag', (select review_reason from waste_logs where id = 'b1700000-0000-0000-0000-000000000001'));
-- ---- complimentary keeps its approval ----
update waste_logs set reason = 'COMPLIMENTARY', approved_by = '66666666-0000-0000-0000-000000000002', approved_by_name = 'Manny' where id = 'b1700000-0000-0000-0000-000000000002';
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000002","edit_note":"two cups, not one","items":[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":2,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]}') as r4 \gset
select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"it was given away","reason":"COMPLIMENTARY"}') is not null as x \gset
reset role;
select test.chk((select approved_by_name = 'Manny' and approved_by = '66666666-0000-0000-0000-000000000002' and reason = 'COMPLIMENTARY' from waste_logs where id = 'b1700000-0000-0000-0000-000000000002'),
            'B17: an edited COMPLIMENTARY entry keeps its approval record');
select test.chk((select approved_by is not null and approved_by_name is not null from waste_logs where id = 'b1700000-0000-0000-0000-000000000001'), 'B17: changed TO complimentary: recorded as approved by the owner');
select test.chk((:'r4'::jsonb->>'total_cost')::numeric = 2 * :w2cost and test.stock('22222222-0000-0000-0000-000000000001') = :b0 - 113 - 18
            and (select count(*) from stock_line_owners where owner_id = 'b1700000-0000-0000-0000-000000000002')
                = (select count(*) from inventory_transactions where reference_id = 'b1700000-0000-0000-0000-000000000002'),
            'B17: menu item 1 -> 2: recipe stock and cost doubled by the server', :'r4');
-- ---- R&D entry ----
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000003","edit_note":"x","reason":"SPILLAGE"}')$$) like 'BAD_WASTE_REASON%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000003","edit_note":"x","project_id":"d1500000-0000-0000-0000-0000000000d2"}')$$) like 'PROJECT_CLOSED%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000001","edit_note":"x","project_id":"d1500000-0000-0000-0000-0000000000d1"}')$$) like 'BAD_WASTE%',
            'B17: R&D stays R&D; a closed project is refused; other entries can''t get a project');
select (public.waste_report(current_date - 1, current_date + 1)->'by_project'->0->>'cost')::numeric as pc0 \gset
select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000003","edit_note":"used less","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":12}]}') is not null as x \gset
select test.chk((public.waste_report(current_date - 1, current_date + 1)->'by_project'->0->>'cost')::numeric = :pc0 - 18, 'B17: the project''s R&D cost follows the edit (30 -> 12)');
reset role;
select test.chk(test.owned('b1700000-0000-0000-0000-000000000003') = 'RND:12@' || current_date and test.stock('22222222-0000-0000-0000-000000000001') = :b0 - 131 + 18, 'B17: R&D stock line re-made (18 g back)');
-- ---- Back Office rows ----
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000004","edit_note":"x","reason":"rnd"}')$$) like 'BAD_WASTE_REASON%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000004","edit_note":"x","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":1}]}')$$) like 'BAD_WASTE%'
            and test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000004","edit_note":"x","items":[{"quantity":0}]}')$$) like 'BAD_QUANTITY%',
            'B17: office row: reason RND refused, ingredient can''t be swapped, amount above 0');
select public.revise_waste(jsonb_build_object('id','b1700000-0000-0000-0000-000000000004','edit_note','weighed it again','reason','Spoiled','note','half bag',
  'waste_date', current_date - 1, 'items', '[{"quantity":0.1,"unit":"kg"}]'::jsonb)) as r5 \gset
reset role;
select test.chk(:'r5'::jsonb @> '{"entry_table":"waste","source":"OFFICE","reason":"Spoiled","total_cost":100}'::jsonb
            and (select quantity = 100 and unit = 'kg' and reason = 'Spoiled' and notes = 'half bag' and date = current_date - 1 and edited_at is not null and edit_note = 'weighed it again' from waste where id = 'b1700000-0000-0000-0000-000000000004')
            and test.owned('b1700000-0000-0000-0000-000000000004') = 'OFFICE:100@' || (current_date - 1)
            and not exists (select 1 from inventory_transactions where id = 'b1700000-0000-0000-0000-0000000000a4')
            and test.stock('22222222-0000-0000-0000-000000000001') = :b0 - 113 - 60, 'B17: office row 40 g -> 0.1 kg, new reason / note / date: line replaced, stock follows', :'r5');
select test.chk(test.wr('b1700000-0000-0000-0000-000000000004') @> '{"edited":true,"entry_table":"waste","reason":"Spoiled","cost":100}'::jsonb, 'B17: ... and the report shows it edited');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000005","edit_note":"x","items":[{"quantity":9}]}')$$) like 'WASTE_NOT_LINKED%', 'B17: old row without a stock line: amount change -> WASTE_NOT_LINKED');
select test.chk(public.revise_waste('{"id":"b1700000-0000-0000-0000-000000000005","edit_note":"typo","reason":"Prep error"}')->'changed' = '["reason"]'::jsonb, 'B17: ... its reason can still be changed');
-- ---- delete ----
select public.net_income_report(current_date)->'ingredients'->>'wasted' as nw0 \gset
select public.delete_waste('b1700000-0000-0000-0000-000000000002', 'logged by mistake') as d1 \gset
select test.chk(((:'nw0')::numeric - (public.net_income_report(current_date)->'ingredients'->>'wasted')::numeric) = 2 * :w2cost, 'B17: net income''s waste goes down by the deleted entry''s cost');
select public.delete_waste('b1700000-0000-0000-0000-000000000001', 'duplicate entry') as d2 \gset
select public.delete_waste('b1700000-0000-0000-0000-000000000004', 'not waste after all') as d3 \gset
select public.delete_waste('b1700000-0000-0000-0000-000000000005', 'old test row') as d4 \gset
select public.delete_waste('b1700000-0000-0000-0000-000000000003', 'wrong project day') as d5 \gset
reset role;
select test.chk(:'d1'::jsonb @> '{"deleted":true,"entry_table":"waste_logs","stock_restored":true}'::jsonb and :'d3'::jsonb @> '{"deleted":true,"entry_table":"waste","stock_restored":true}'::jsonb
            and :'d4'::jsonb @> '{"deleted":true,"stock_restored":false}'::jsonb and :'d5'::jsonb @> '{"deleted":true,"stock_restored":true}'::jsonb, 'B17: delete answers', :'d4');
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :b0 and test.stock('22222222-0000-0000-0000-000000000002') = :m0 - 7,
            'B17: all five deleted: stock exactly back (only the other record''s 7 mL line remains)', test.stock('22222222-0000-0000-0000-000000000001')::text);
select test.chk(not exists (select 1 from waste_logs where id in ('b1700000-0000-0000-0000-000000000001','b1700000-0000-0000-0000-000000000002','b1700000-0000-0000-0000-000000000003'))
            and not exists (select 1 from waste_log_items where waste_log_id in ('b1700000-0000-0000-0000-000000000001','b1700000-0000-0000-0000-000000000002'))
            and not exists (select 1 from waste where id in ('b1700000-0000-0000-0000-000000000004','b1700000-0000-0000-0000-000000000005'))
            and not exists (select 1 from stock_line_owners where owner_id::text like 'b1700000-%')
            and exists (select 1 from inventory_transactions where id = 'b1700000-0000-0000-0000-0000000000f1'), 'B17: entries, items and their own lines gone; nothing else');
select test.chk((select count(*) from audit_log where action = 'Waste deleted' and reference_id like 'b1700000-%' and details like '%Note: %') = 5
            and exists (select 1 from audit_log where action = 'Waste deleted' and reference_id = 'b1700000-0000-0000-0000-000000000002' and details like '%Iced Latte 2%' and details like '%logged by mistake%')
            and exists (select 1 from audit_log where action = 'Waste deleted' and reference_id = 'b1700000-0000-0000-0000-000000000005' and details like '%no stock line found%'),
            'B17: one audit entry per delete, saying what the entry was', (select details from audit_log where action = 'Waste deleted' and reference_id = 'b1700000-0000-0000-0000-000000000002'));
select test.chk(test.wr('b1700000-0000-0000-0000-000000000001') is null and test.wr('b1700000-0000-0000-0000-000000000004') is null, 'B17: deleted entries leave the report');
delete from inventory_transactions where id = 'b1700000-0000-0000-0000-0000000000f1';
-- ---- ids can't be shared with Back Office waste rows ----
insert into waste(id, business_id, ingredient_id, quantity, unit, reason, date) values ('b1700000-0000-0000-0000-000000000006', :'biz', '22222222-0000-0000-0000-000000000001', 1, 'g', 'Other', current_date);
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('waste', jsonb_build_object('id','b1700000-0000-0000-0000-000000000006','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1,"unit":"g"}]'::jsonb))->>'message' = 'FORBIDDEN_ROW', 'B17: a counter waste can''t reuse a Back Office waste row''s id');
select test.chk(test.op('waste', jsonb_build_object('id','b1700000-0000-0000-0000-000000000007','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1,"unit":"g"}]'::jsonb))->>'status' = 'ok'
  and test.op('waste', jsonb_build_object('id','b1700000-0000-0000-0000-000000000007','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":1,"unit":"g"}]'::jsonb))->>'status' = 'skipped', 'B17: the same counter entry sent again is still skipped');
reset role;
delete from waste where id = 'b1700000-0000-0000-0000-000000000006';

-- ============================ X. rights ============================
select test.chk(count(*) = 0, 'X: anon (no sign-in) can run no new function', string_agg(p.oid::regprocedure::text, ', '))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')
   and p.proname in ('qr_set_username','qr_switch_account','log_rnd_usage','delete_rnd_usage','revise_stock_count','partner_batch_preview',
                     'produce_partner_batch','partner_return','partner_pay','_fo_apply_15','_apply_count_effects','_partner_batch_plan','_waste_item',
                     '_new_username','_clean_username','_stock_of','_shop_day','_owner_staff','_count_items','_qr_menu_groups','_barista_kit_problem',
                     '_username_key','_username_letters','_username_reserved','_relink_subject','_stock_ref_taken',
                     '_loyalty_last_stamp','_loyalty_current_card','_customer_stamp_times','_loyalty_summary','_loyalty_reward_amount');
select test.chk(count(*) = 0, 'X: internal helpers not callable by anyone', string_agg(p.oid::regprocedure::text, ', '))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')
   and p.proname in ('_fo_apply_15','_apply_count_effects','_partner_batch_plan','_waste_item','_new_username','_clean_username','_stock_of',
                     '_shop_day','_owner_staff','_count_items','_qr_menu_groups','_barista_kit_problem','_customer_username_check','_tmp_widen_check',
                     '_username_key','_username_letters','_username_reserved','_relink_subject','_stock_ref_taken',
                     '_loyalty_last_stamp','_loyalty_current_card','_customer_stamp_times','_loyalty_summary','_loyalty_reward_amount');
select test.chk(not has_table_privilege('anon', t, 'select'), 'X: anon has no rights on ' || t)
  from unnest(array['public.rnd_projects','public.stock_counts','public.stock_count_lines','public.partner_debts','public.partner_debt_lines','public.partner_settlements','public.v_partner_to_return','public.stock_line_owners','public.qr_signout_notices']) t;
select test.chk(not has_table_privilege('authenticated', t, 'select') and not has_table_privilege('authenticated', t, 'insert'), 'X: no API rights on ' || t)
  from unnest(array['public.stock_line_owners','public.qr_signout_notices']) t;
select test.chk(to_regprocedure('public._tmp_widen_check(text,text,text,text[])') is null, 'X: install helper removed');
select test.login('00000000-0000-0000-0000-0000000c1503'); set role authenticated;
select test.chk((select count(*) from stock_counts) + (select count(*) from rnd_projects) + (select count(*) from partner_debts) + (select count(*) from customers) = 0, 'X: a QR customer reads none of the new tables');
reset role;
-- ============================ Z. B17 extras (Z's security gate, 2026-11-12) ============================
-- who may: a MANAGER email profile, a counter's direct table access, the public key; fixed search_path; nothing for PUBLIC
select test.stock('22222222-0000-0000-0000-000000000001') as zb0 \gset
set session_replication_role = replica;      -- (no sign-up trigger: just a second, non-owner profile in shop A and an ingredient in shop B)
insert into auth.users(id) values ('00000000-0000-0000-0000-0000000000f7') on conflict do nothing;
insert into profiles(id, business_id, name, role) values ('00000000-0000-0000-0000-0000000000f7', :'biz', 'Manager mail', 'MANAGER') on conflict do nothing;
insert into ingredients(id, business_id, name, base_unit) values ('b1720000-0000-0000-0000-000000000009', :'biz2', 'Other shop sugar', 'g') on conflict do nothing;
set session_replication_role = origin;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('waste', jsonb_build_object('id','b1720000-0000-0000-0000-000000000001','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":10,"unit":"g"}]'::jsonb))->>'status' = 'ok', 'Z: set-up: a counter waste entry (10 g beans)');
reset role;
select test.login('00000000-0000-0000-0000-0000000000f7'); set role authenticated;
select test.chk(test.err($$select public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000001","edit_note":"x","reason":"EXPIRED"}')$$) like 'NOT_ALLOWED%'
  and test.err($$select public.delete_waste('b1720000-0000-0000-0000-000000000001','x')$$) like 'NOT_ALLOWED%'
  and test.err($$select public.waste_report(current_date - 1, current_date + 1)$$) like 'NOT_ALLOWED%', 'Z: a MANAGER email profile can''t edit, delete or read the waste report (NOT_ALLOWED)');
update public.waste_logs set edit_note = 'x', total_cost = 0 where id = 'b1720000-0000-0000-0000-000000000001';
delete from public.waste_logs where id = 'b1720000-0000-0000-0000-000000000001';
reset role;
select test.chk((select edit_note is null and total_cost = 10 from waste_logs where id = 'b1720000-0000-0000-0000-000000000001'), 'Z: ... and its direct table update / delete changes nothing');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk((select count(*) from public.waste_logs) = 0 and (select count(*) from public.waste) = 0 and (select count(*) from public.waste_log_items) = 0,
  'Z: a counter reads no waste rows directly (so no edit notes either)');
select test.chk(test.err($$select 1 from public.stock_line_owners$$) like '%permission denied%', 'Z: a counter has no access to stock_line_owners');
delete from public.waste_logs where id = 'b1720000-0000-0000-0000-000000000001';
reset role;
select test.chk(exists (select 1 from waste_logs where id = 'b1720000-0000-0000-0000-000000000001'), 'Z: a counter''s direct delete removes nothing');
set role anon;
select test.chk(test.err($$select public.revise_waste('{}')$$) like '%permission denied%' and test.err($$select public.delete_waste(gen_random_uuid(), 'x')$$) like '%permission denied%'
  and test.err($$select public._adopt_waste_lines(gen_random_uuid(), gen_random_uuid(), 'WASTE')$$) like '%permission denied%', 'Z: the public key alone: permission denied on revise_waste, delete_waste and the helper');
reset role;
select test.chk(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('revise_waste','delete_waste','_adopt_waste_lines','waste_report','net_income_report')
  and (not p.prosecdef or p.proconfig is null or p.proconfig::text not like '%search_path=public%')), 'Z: the B17 functions are SECURITY DEFINER with a fixed search_path');
select test.chk(not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.pronamespace = 'public'::regnamespace and p.proname in ('revise_waste','delete_waste','_adopt_waste_lines') and a.grantee = 0), 'Z: nothing granted to PUBLIC on them');
-- the server's numbers only: anything else the app sends is ignored
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000001","edit_note":"probe","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":15,"unit":"g","cost":99999,"total_cost":5,"stock_lines":[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":5000}]}],"total_cost":1,"business_id":"00000000-0000-0000-0000-000000000000","staff_name":"Evil","approved_by_name":"Evil"}') as zr1 \gset
reset role;
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :zb0 - 15 and (:'zr1'::jsonb->>'total_cost')::numeric = 15
  and (select stock_lines from waste_log_items where waste_log_id = 'b1720000-0000-0000-0000-000000000001') = '[{"quantity": 15, "ingredient_id": "22222222-0000-0000-0000-000000000001"}]'::jsonb
  and (select staff_name <> 'Evil' and approved_by_name is null and total_cost = 15 from waste_logs where id = 'b1720000-0000-0000-0000-000000000001'),
  'Z: stock lines, cost, shop and names sent by the app are ignored (server''s: 15 g, cost 15)', :'zr1');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000001","edit_note":"x","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":"NaN","unit":"g"}]}')$$) ~ '^BAD_'
  and test.err($$select public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000001","edit_note":"x","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":"Infinity","unit":"g"}]}')$$) ~ '^BAD_',
  'Z: NaN / Infinity amounts refused');
select test.chk(test.err($$select public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000001","edit_note":"x","items":[{"ingredient_id":"b1720000-0000-0000-0000-000000000009","quantity":1}]}')$$) like 'UNKNOWN_INGREDIENT%'
  and test.err($$select public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000001","edit_note":"x","items":[{"recipe_id":"b1720000-0000-0000-0000-000000000009","quantity":1}]}')$$) like 'UNKNOWN_RECIPE%',
  'Z: another shop''s ingredient / an unknown recipe in the new item list refused');
reset role;
-- ---- gate fixes 2026-11-12 (Z's Lows 1-3) ----
-- Low 1: the "why" note comes right after the header, so a long item list can't push it past the 2,000-character cut
update ingredients set name = repeat('Very long ingredient name ', 3) || 'xx' where id = '22222222-0000-0000-0000-000000000001';
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.revise_waste(jsonb_build_object('id','b1720000-0000-0000-0000-000000000001','edit_note','WHY-EDIT-1','items',
  (select jsonb_agg(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity',g + 0.123456,'unit','g')) from generate_series(1,30) g))) is not null as zx \gset
select public.revise_waste(jsonb_build_object('id','b1720000-0000-0000-0000-000000000001','edit_note','WHY-EDIT-2','items',
  (select jsonb_agg(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity',g + 0.654321,'unit','g')) from generate_series(1,30) g))) is not null as zx \gset
reset role;
select test.chk(length(details) = 2000 and details like 'Waste of % | Note: WHY-EDIT-2 | amount: %',
  'Z Low 1: a 30-item edit with long names: the audit line, cut at 2,000 characters, still has the note (then the old amounts)', length(details)::text || ' ' || left(details, 90))
  from audit_log where reference_id = 'b1720000-0000-0000-0000-000000000001' and action = 'Waste edited' order by at desc, details desc limit 1;
-- Low 2: a counter entry whose stock lines are gone: amount / date -> WASTE_NOT_LINKED, stock untouched; reason + note still editable
create temp table z_lines as select t.* from inventory_transactions t where t.reference_id = 'b1720000-0000-0000-0000-000000000001';
create temp table z_owners as select o.* from stock_line_owners o where o.owner_id = 'b1720000-0000-0000-0000-000000000001';
delete from inventory_transactions where reference_id = 'b1720000-0000-0000-0000-000000000001';
select test.stock('22222222-0000-0000-0000-000000000001') as zb1 \gset
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err(format($$select public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000001","edit_note":"x","waste_date":"%s"}')$$, (select waste_date - 1 from public.waste_logs where id = 'b1720000-0000-0000-0000-000000000001'))) like 'WASTE_NOT_LINKED%'
  and test.err($$select public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000001","edit_note":"x","items":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":5,"unit":"g"}]}')$$) like 'WASTE_NOT_LINKED%',
  'Z Low 2: counter entry without its stock lines: date / amount change -> WASTE_NOT_LINKED');
select test.chk(public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000001","edit_note":"reason only","reason":"EXPIRED","note":"old bag"}')->'changed' = '["reason", "note"]'::jsonb,
  'Z Low 2: ... its reason and note can still be changed');
reset role;
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :zb1 and not exists (select 1 from inventory_transactions where reference_id = 'b1720000-0000-0000-0000-000000000001'),
  'Z Low 2: ... and stock was not taken a second time');
insert into inventory_transactions select * from z_lines;
insert into stock_line_owners select * from z_owners;
update ingredients set name = 'Espresso beans' where id = '22222222-0000-0000-0000-000000000001';
-- Low 3: a Back Office "Record waste" row: the audit line has the cost pair too
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','waste','row', jsonb_build_object('id','b1720000-0000-0000-0000-000000000004','ingredient_id','22222222-0000-0000-0000-000000000001','quantity',40,'unit','g','reason','Expired','date',current_date,'notes','z')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','b1720000-0000-0000-0000-0000000000a4','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','WASTE','quantity',40,'reference_id','b1720000-0000-0000-0000-000000000004','transaction_date',current_date,'notes','Expired — z')))) is not null as zx \gset
select (public.revise_waste('{"id":"b1720000-0000-0000-0000-000000000004","edit_note":"WHY-ROW","items":[{"quantity":0.1,"unit":"kg"}]}')->>'total_cost')::numeric as zrow \gset
reset role;
select test.chk(:zrow = 100 and details like 'Waste of % | Note: WHY-ROW | %amount: 40 g -> 100 g%' and details ~ 'cost: 40(\.00)? -> 100(\.00)?',
  'Z Low 3: Back Office row 40 g -> 0.1 kg: audit has the note, the amounts and cost 40 -> 100', details)
  from audit_log where reference_id = 'b1720000-0000-0000-0000-000000000004' and action = 'Waste edited';
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.delete_waste('b1720000-0000-0000-0000-000000000004', 'WHY-ROW-DEL') is not null as zx \gset
select (public.delete_waste('b1720000-0000-0000-0000-000000000001', 'Z clean-up')->>'stock_restored')::boolean as zdel \gset
reset role;
select test.chk(:'zdel' and test.stock('22222222-0000-0000-0000-000000000001') = :zb0, 'Z: deleted: stock exactly back');
select test.chk((select bool_and(details like 'Waste of % | Note: % | was: %') and count(*) = 2 from audit_log where action = 'Waste deleted' and reference_id in ('b1720000-0000-0000-0000-000000000001','b1720000-0000-0000-0000-000000000004'))
  and (select length(details) = 2000 and details like '% | Note: Z clean-up | was: cost %' from audit_log where action = 'Waste deleted' and reference_id = 'b1720000-0000-0000-0000-000000000001'),
  'Z Low 1: delete audit lines: note first, then what the entry was (30 long items: cut at 2,000 with the note and cost kept)',
  (select left(details, 120) from audit_log where action = 'Waste deleted' and reference_id = 'b1720000-0000-0000-0000-000000000001'));
delete from ingredients where id = 'b1720000-0000-0000-0000-000000000009';
delete from profiles where id = '00000000-0000-0000-0000-0000000000f7';
select 'DB15 DONE';
