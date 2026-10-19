-- Security checks for the 2026-10-12 decisions (C1 C2 C4 C5 C6 C7 C8): pairing-only counters,
-- no admin rights from a PIN, server-checked manager approvals, cashier-only offline PINs,
-- masked phones, refund caps, rate limits. Adopted from the database engineer's sec_checks.sql.
-- Needs its OWN fresh database (it creates its own shop data; do not run after 10/11):
--   tests/reset_db.sh "" cccc_sec
--   psql -h /tmp -p 54329 -U postgres -d cccc_sec -v ON_ERROR_STOP=1 -f tests/sql/30_security_tests.sql
\set QUIET on
create schema if not exists test;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', case when p_token is null then '{}' else json_build_object('x-staff-token', p_token)::text end, false);
end $$;
create or replace function test.ok(cond boolean, msg text) returns text language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'ASSERT FAILED: %', msg; end if; return 'ok  ' || msg; end $$;
-- run a statement, return the error text (or NO ERROR)
create or replace function test.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'NO ERROR'; exception when others then return sqlerrm; end $$;
-- one fo_sync op -> its result {status, message}
create or replace function test.op(p_key text, p_type text, p_data jsonb) returns jsonb language sql as $$
  select public.fo_sync(p_key, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', p_type, 'data', p_data)))->0
$$;
create or replace function test.inv(p_id uuid, p_ing uuid, p_qty numeric) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'ingredient_id', p_ing, 'quantity', p_qty, 'transaction_date', '2026-10-12')
$$;
create or replace function test.sale_data(p_sale uuid, p_total numeric, p_inv jsonb,
   p_item uuid default gen_random_uuid(), p_pay uuid default gen_random_uuid(), p_status text default 'COMPLETED',
   p_discount numeric default 0, p_appr uuid default null, p_tok text default null, p_cust uuid default null, p_cashier uuid default '66666666-0000-0000-0000-000000000001')
returns jsonb language sql as $$
  select jsonb_build_object(
    'sale', jsonb_build_object('id', p_sale, 'transaction_number', 'POS-A-2026-' || left(p_sale::text, 6), 'transaction_date', now(),
       'status', p_status, 'cashier_id', p_cashier, 'cashier_name', 'Cathy Cashier',
       'shift_id', '88888888-0000-0000-0000-000000000001', 'subtotal', p_total + p_discount,
       'discount_type', case when p_discount > 0 then 'fixed' end, 'discount_value', p_discount, 'discount_amount', p_discount,
       'discount_approved_by', p_appr, 'discount_approved_by_name', 'Fake Name', 'tax_amount', 0, 'service_charge_amount', 0,
       'grand_total', p_total, 'customer_id', p_cust),
    'items', jsonb_build_array(jsonb_build_object('id', p_item, 'recipe_id', '33333333-0000-0000-0000-000000000001', 'name', 'Iced Latte',
       'quantity', 1, 'unit_price', p_total + p_discount, 'line_total', p_total + p_discount)),
    'payment', jsonb_build_object('id', p_pay, 'method', 'CASH', 'amount', p_total, 'status', 'CONFIRMED'),
    'inventory', p_inv,
    'discount_approval_token', p_tok)
$$;
create or replace function test.refund_data(p_ref uuid, p_sale uuid, p_type text, p_amount numeric, p_appr uuid, p_tok text,
   p_inv jsonb default '[]', p_status text default 'REFUNDED', p_performer uuid default null) returns jsonb language sql as $$
  select jsonb_build_object(
    'refund', jsonb_build_object('id', p_ref, 'sale_id', p_sale, 'shift_id', '88888888-0000-0000-0000-000000000001', 'type', p_type,
       'amount', p_amount, 'reason', 'test', 'approved_by', p_appr, 'approved_by_name', 'Fake Name', 'date', now(), 'performed_by', p_performer),
    'sale_status', p_status, 'inventory', p_inv, 'approval_token', p_tok)
$$;
-- a completed sale with exactly the given sale fields and items (no stock lines)
create or replace function test.raw_sale(p_sale uuid, p_fields jsonb, p_items jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'sale', jsonb_build_object('id', p_sale, 'transaction_number', 'POS-A-2026-' || left(p_sale::text, 6), 'transaction_date', now(),
       'status', 'COMPLETED', 'cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy Cashier',
       'shift_id', '88888888-0000-0000-0000-000000000001') || p_fields,
    'items', p_items, 'inventory', '[]'::jsonb)
$$;
create or replace function test.item(p_unit numeric, p_qty numeric, p_line numeric default null, p_mods jsonb default '[]',
   p_recipe uuid default '33333333-0000-0000-0000-000000000001') returns jsonb language sql as $$
  select jsonb_build_object('id', gen_random_uuid(), 'recipe_id', p_recipe, 'name', 'X', 'quantity', p_qty, 'unit_price', p_unit,
    'line_total', coalesce(p_line, p_unit * p_qty), 'modifiers', p_mods)
$$;
grant usage on schema test to anon, authenticated; grant execute on all functions in schema test to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

-- ============ setup (as the database owner, like the e2e seed) ============
\set beans '22222222-0000-0000-0000-000000000001'
\set milk  '22222222-0000-0000-0000-000000000002'
\set cashier '66666666-0000-0000-0000-000000000001'
\set manager '66666666-0000-0000-0000-000000000002'
\set manager2 '66666666-0000-0000-0000-000000000003'
\set owner_uid '00000000-0000-0000-0000-0000000000a1'
\set d1 '00000000-0000-0000-0000-0000000000d1'
\set d2 '00000000-0000-0000-0000-0000000000d2'
\set d3 '00000000-0000-0000-0000-0000000000d3'
\set key1 'device-key-0001-abcdef'
\set key2 'device-key-0002-abcdef'
\set key3 'device-key-0003-abcdef'
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000b1', 'other@example.com', '{"business_name":"Other Shop","admin_name":"Olga"}');
insert into auth.users (id, is_anonymous) select x::uuid, true from unnest(array[
  '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000c3',
  '00000000-0000-0000-0000-0000000000c4', :'d1', :'d2', :'d3']) x;
select business_id as biz from profiles where id = :'owner_uid' \gset
select business_id as biz2 from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset
select id as owner_staff from staff where profile_id = :'owner_uid' \gset
select qr_token as tok from dining_tables where business_id = :'biz' \gset
do $$
declare v_biz uuid; v_biz2 uuid; v_owner_staff uuid;
begin
  select business_id into v_biz from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';
  select business_id into v_biz2 from public.profiles where id = '00000000-0000-0000-0000-0000000000b1';
  select id into v_owner_staff from public.staff where profile_id = '00000000-0000-0000-0000-0000000000a1';
  insert into public.ingredients(id, business_id, name, base_unit) values
    ('22222222-0000-0000-0000-000000000001', v_biz, 'Espresso beans', 'g'),
    ('22222222-0000-0000-0000-000000000002', v_biz, 'Milk', 'ml'),
    ('22222222-0000-0000-0000-0000000000b2', v_biz2, 'Other shop beans', 'g');
  insert into public.recipes(id, business_id, name, recipe_type, selling_price, modifier_groups) values
    ('33333333-0000-0000-0000-000000000001', v_biz, 'Iced Latte', 'DRINKS', 150,
     '[{"id":"g-size","name":"Size","options":[{"id":"o-12","label":"12oz","price_delta":0},{"id":"o-16","label":"16oz","price_delta":20}]},
       {"id":"g-add","name":"Add-ons","multi_select":true,"options":[{"id":"o-shot","label":"Extra shot","price_delta":30},{"id":"o-nomilk","label":"No milk","price_delta":-10}]}]'),
    ('33333333-0000-0000-0000-0000000000b2', v_biz2, 'Other shop latte', 'DRINKS', 10, '[]');
  insert into public.staff(id, business_id, name, role) values ('66666666-0000-0000-0000-000000000004', v_biz, 'Carl Cashier', 'CASHIER');
  insert into public.inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, transaction_date) values
    ('55555555-0000-0000-0000-000000000001', v_biz, '22222222-0000-0000-0000-000000000001', 'INITIAL_STOCK', 1000, '2026-10-01'),
    ('55555555-0000-0000-0000-000000000002', v_biz, '22222222-0000-0000-0000-000000000002', 'INITIAL_STOCK', 5000, '2026-10-01');
  insert into public.staff(id, business_id, name, role) values
    ('66666666-0000-0000-0000-000000000001', v_biz, 'Cathy Cashier', 'CASHIER'),
    ('66666666-0000-0000-0000-000000000002', v_biz, 'Manny Manager', 'MANAGER'),
    ('66666666-0000-0000-0000-000000000003', v_biz, 'Mara Manager', 'MANAGER');
  insert into public.staff_pins(staff_id, pin_hash) values
    ('66666666-0000-0000-0000-000000000001', extensions.crypt('1111', extensions.gen_salt('bf', 4))),
    ('66666666-0000-0000-0000-000000000002', extensions.crypt('222222', extensions.gen_salt('bf', 4))),
    ('66666666-0000-0000-0000-000000000003', extensions.crypt('333333', extensions.gen_salt('bf', 4))),
    (v_owner_staff, extensions.crypt('999999', extensions.gen_salt('bf', 4)));
  insert into public.device_pairing_codes(code, business_id, device_name, expires_at) values
    ('PAIRA1', v_biz, 'Front', now() + interval '1 hour'), ('PAIRA2', v_biz, 'Back bar', now() + interval '1 hour'),
    ('PAIRB1', v_biz2, 'Other', now() + interval '1 hour');
  -- the other shop has a sale with child rows (ids we will try to steal)
  insert into public.sales(id, business_id, status, grand_total) values ('99999999-0000-0000-0000-0000000000b1', v_biz2, 'COMPLETED', 50);
  insert into public.sale_items(id, business_id, sale_id, name, quantity) values ('aaaaaaaa-0000-0000-0000-0000000000b1', v_biz2, '99999999-0000-0000-0000-0000000000b1', 'Other', 1);
  insert into public.customers(id, business_id, nickname, phone) values ('cccccccc-0000-0000-0000-0000000000b1', v_biz2, 'OtherCust', '+639990000000');
end $$;

-- pair counters d1, d2 (our shop) and d3 (other shop)
select test.login(:'d1'); set role authenticated;
select test.ok(public.redeem_device_pairing('PAIRA1', :'key1', 'Front')->'device' is not null, 'd1 paired'); reset role;
select test.login(:'d2'); set role authenticated;
select test.ok(public.redeem_device_pairing('PAIRA2', :'key2', 'Back bar')->'device' is not null, 'd2 paired'); reset role;
select test.login(:'d3'); set role authenticated;
select test.ok(public.redeem_device_pairing('PAIRB1', :'key3', 'Other')->'device' is not null, 'd3 paired (other shop)'); reset role;

-- ============ C4 / C8: admin rank only from the owner's email login ============
select test.login(:'owner_uid'); set role authenticated;
select test.ok(public.app_rank() = 3, 'owner email login -> rank 3');
select test.ok(test.err($$select public.fo_sync('device-key-0001-abcdef', '[]'::jsonb)$$) = 'NOT_ALLOWED', 'owner login cannot use fo_sync (counters only)');
reset role;
select test.login(:'d1'); set role authenticated;
select (public.staff_pin_login('999999'))->>'token' as admin_login \gset
select (public.staff_pin_login('1111'))->>'token' as cashier_login \gset
select (public.staff_pin_login('222222'))->>'token' as mgr_login \gset
reset role;
select test.login(:'d1', :'admin_login'); set role authenticated;
select test.ok(public.app_rank() = 0, 'counter + owner''s PIN -> rank 0 (no elevation from x-staff-token)');
select test.ok(test.err($$select public.apply_changes('[{"op":"upsert","table":"categories","row":{"name":"Hack"}}]')$$) = 'ADMIN_ONLY', 'counter + admin PIN cannot use apply_changes');
select test.ok(test.err($$insert into categories(name) values ('Hack2')$$) like '%row-level security%', 'counter + admin PIN cannot insert directly');
select test.ok(test.err(format('select public.staff_set_pin(%L, %L)', '66666666-0000-0000-0000-000000000001', '4444')) = 'NO ERROR'
               and (public.staff_set_pin('66666666-0000-0000-0000-000000000001', '4444')->>'error') = 'ADMIN_ONLY', 'counter + admin PIN cannot set PINs');
select test.ok(test.err($$select public.create_device_pairing_code('x')$$) = 'ADMIN_ONLY', 'counter + admin PIN cannot pair counters');
select test.ok(public.bo_bootstrap()->>'rank' = '0', 'bo_bootstrap reports rank 0 on a counter');
reset role;
select test.login(:'d1', :'mgr_login'); set role authenticated;
select test.ok(public.app_rank() = 0, 'counter + manager PIN -> rank 0');
reset role;
select test.ok(to_regprocedure('public.fo_register_device(text,text)') is null, 'fo_register_device removed');
select test.ok((select proconfig::text from pg_proc where oid = 'public.current_role_rank()'::regprocedure) like '%search_path=public%', 'current_role_rank has a fixed search_path');
select test.ok(not has_function_privilege('anon', 'public.current_role_rank()', 'execute'), 'anon cannot run current_role_rank');
select test.ok(not has_function_privilege('authenticated', 'public._use_approval(uuid,uuid,uuid,text,text,uuid)', 'execute')
           and not has_function_privilege('authenticated', 'public._phone_lookup_allowed(uuid)', 'execute')
           and not has_function_privilege('authenticated', 'public._pin_locked_until(uuid)', 'execute')
           and not has_function_privilege('authenticated', 'public._customer_for_staff(public.customers,boolean)', 'execute')
           and not has_function_privilege('authenticated', 'public._require_ingredient(uuid,jsonb)', 'execute'), 'new helpers are internal only');
select test.ok(not has_function_privilege('anon', 'public.search_customers(text,integer)', 'execute')
           and not has_function_privilege('anon', 'public.fo_add_customer(text,text,boolean)', 'execute'), 'anon cannot search / add customers');
-- another counter can't upload with d1's key
select test.login(:'d2'); set role authenticated;
select test.ok(test.err($$select public.fo_sync('device-key-0001-abcdef', '[]'::jsonb)$$) = 'DEVICE_MISMATCH', 'd2 cannot upload as d1');
reset role;

-- ============ C1: approvals ============
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'shift_open', jsonb_build_object('id','88888888-0000-0000-0000-000000000001','shift_number','SHIFT-A-2026-0001',
  'cashier_id', :'cashier', 'cashier_name','Cathy','opened_at', now(), 'opening_cash', 1000))->>'status' = 'ok', 'shift opened');
select test.ok(public.staff_pin_login('1111', 'OVERRIDE')->>'error' = 'ROLE_TOO_LOW', 'OVERRIDE always needs a manager (even without p_min_role)');
select test.ok(public.staff_pin_login('222222', 'SUPERUSER')->>'error' = 'BAD_PURPOSE', 'unknown PIN purpose rejected');
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov1 \gset
-- discount without / with bad approvals
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000101', 140, '[]', p_discount => 10, p_appr => :'manager'))->>'message' = 'APPROVAL_REQUIRED', 'discount without token -> APPROVAL_REQUIRED');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000101', 140, '[]', p_discount => 10))->>'message' = 'APPROVAL_REQUIRED', 'discount without approver -> APPROVAL_REQUIRED');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000101', 140, '[]', p_discount => 10, p_appr => :'cashier', p_tok => :'cashier_login'))->>'message' = 'ROLE_TOO_LOW', 'discount approved by a cashier -> ROLE_TOO_LOW');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000101', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => 'deadbeef'))->>'message' = 'APPROVAL_INVALID', 'made-up token -> APPROVAL_INVALID');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000101', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => :'cashier_login'))->>'message' = 'APPROVAL_INVALID', 'cashier''s own token naming the manager -> APPROVAL_INVALID');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000101', 140, '[]', p_discount => 10, p_appr => :'owner_staff', p_tok => :'ov1'))->>'message' = 'APPROVAL_INVALID', 'manager''s token naming another approver -> APPROVAL_INVALID');
reset role;
select test.ok((select used_at is null from staff_sessions where purpose = 'OVERRIDE'), 'failed ops did not use up the token');
select test.login(:'d1'); set role authenticated;
select test.ok((select count(*) from staff_sessions) = 0, 'counter cannot read staff_sessions');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000101', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => :'ov1'))->>'status' = 'ok', 'discount with manager OVERRIDE token -> ok');
reset role;
select test.ok((select discount_approved_by_name from sales where id = '99999999-0000-0000-0000-000000000101') = 'Manny Manager', 'approver name taken from the staff list, not the counter');
select test.ok((select used_at is not null and used_for = 'discount:99999999-0000-0000-0000-000000000101' from staff_sessions where purpose = 'OVERRIDE'), 'OVERRIDE token marked used');
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000102', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => :'ov1'))->>'message' = 'APPROVAL_INVALID', 'same OVERRIDE token cannot approve a second discount');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000102', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => :'mgr_login', p_cashier => :'manager'))->>'status' = 'ok', 'manager''s own LOGIN token approves (signed in on this counter)');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000103', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => :'mgr_login', p_cashier => :'manager'))->>'status' = 'ok', 'LOGIN token is not used up');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000104', 140, '[]', p_status => 'HELD', p_discount => 10, p_appr => :'cashier'))->>'status' = 'ok', 'HELD sale with a discount needs no approval yet');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000104', 140, '[]', p_discount => 10, p_appr => :'cashier'))->>'message' = 'ROLE_TOO_LOW', '... but completing it does');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000105', 150, '[]'))->>'status' = 'ok', 'sale without discount needs no approval');
reset role;
-- token issued on ANOTHER counter (d2)
select test.login(:'d2'); set role authenticated;
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_d2 \gset
reset role;
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000106', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => :'ov_d2'))->>'message' = 'APPROVAL_INVALID', 'token from another counter -> APPROVAL_INVALID');
-- late upload: token expired (10 min) but issued < 24 h ago -> accepted; issued > 24 h ago -> refused
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_late \gset
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_old \gset
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_revoked \gset
select (public.staff_pin_login('333333', 'OVERRIDE', 'MANAGER'))->>'token' as ov_mara \gset
reset role;
update staff_sessions set created_at = now() - interval '20 hours', expires_at = now() + interval '4 hours'
  where token_hash = encode(extensions.digest(:'ov_late', 'sha256'), 'hex');
update staff_sessions set created_at = now() - interval '25 hours', expires_at = now() - interval '24 hours'
  where token_hash = encode(extensions.digest(:'ov_old', 'sha256'), 'hex');
select test.login(:'d1'); set role authenticated;
select public.staff_logout(:'ov_revoked');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000106', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => :'ov_late'))->>'status' = 'ok', 'late upload (token expired, issued 20 h ago) accepted');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000107', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => :'ov_old'))->>'message' = 'APPROVAL_INVALID', 'token issued 25 h ago -> APPROVAL_INVALID');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000107', 140, '[]', p_discount => 10, p_appr => :'manager', p_tok => :'ov_revoked'))->>'message' = 'APPROVAL_INVALID', 'revoked token -> APPROVAL_INVALID');
reset role;
update staff set active = false where id = :'manager2';
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000107', 140, '[]', p_discount => 10, p_appr => :'manager2', p_tok => :'ov_mara'))->>'message' = 'APPROVAL_INVALID', 'switched-off manager -> APPROVAL_INVALID');
reset role;
update staff set active = true where id = :'manager2';

-- ============ C1: refunds need approval + caps ============
select test.login(:'d1'); set role authenticated;
-- sale S2: 165, took 18 g beans + 180 ml milk
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000201', 165, jsonb_build_array(
   test.inv('cccccccc-0000-0000-0000-000000000201', :'beans', 18), test.inv('cccccccc-0000-0000-0000-000000000202', :'milk', 180)),
   p_item => 'aaaaaaaa-0000-0000-0000-000000000201', p_pay => 'bbbbbbbb-0000-0000-0000-000000000201'))->>'status' = 'ok', 'sale S2 (165, 18 g + 180 ml)');
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000201', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', 100, :'manager', null))->>'message' = 'APPROVAL_REQUIRED', 'refund without token -> APPROVAL_REQUIRED');
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000201', '99999999-0000-0000-0000-000000000201', 'VOID', 165, :'manager', :'ov1'))->>'message' = 'APPROVAL_INVALID', 'void with a used token -> APPROVAL_INVALID');
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov2 \gset
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000201', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', 200, :'manager', :'ov2'))->>'message' = 'REFUND_TOO_LARGE', 'refund above the sale total -> REFUND_TOO_LARGE');
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000201', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', -5, :'manager', :'ov2'))->>'message' = 'BAD_AMOUNT', 'negative refund -> BAD_AMOUNT');
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000201', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', 100, :'manager', :'ov2',
   jsonb_build_array(test.inv('eeeeeeee-0000-0000-0000-000000000201', :'beans', 19))))->>'message' = 'RETURN_TOO_LARGE', 'returning 19 g when the sale took 18 g -> RETURN_TOO_LARGE');
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000201', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', 100, :'manager', :'ov2',
   jsonb_build_array(test.inv('eeeeeeee-0000-0000-0000-000000000201', '22222222-0000-0000-0000-0000000000b2', 1))))->>'message' = 'UNKNOWN_INGREDIENT', 'another shop''s ingredient -> UNKNOWN_INGREDIENT');
reset role;
select test.ok((select count(*) from refunds) = 0 and (select used_at is null from staff_sessions where token_hash = encode(extensions.digest(:'ov2', 'sha256'), 'hex')), 'failed refunds left nothing behind and did not use up the token');
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000201', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', 100, :'manager', :'ov2',
   jsonb_build_array(test.inv('eeeeeeee-0000-0000-0000-000000000201', :'beans', 10)), 'VOIDED'))->>'status' = 'ok', 'partial refund 100 (10 g back) -> ok');
reset role;
select test.ok((select status from sales where id = '99999999-0000-0000-0000-000000000201') = 'PARTIALLY_REFUNDED', 'sale status worked out by the server (counter said VOIDED)');
select test.ok((select approved_by_name from refunds where id = 'dddddddd-0000-0000-0000-000000000201') = 'Manny Manager', 'refund approver name from the staff list');
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000202', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', 70, :'manager', :'mgr_login', p_performer => :'manager'))->>'message' = 'REFUND_TOO_LARGE', 'second refund 70 when 65 is left -> REFUND_TOO_LARGE');
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000202', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', 65, :'manager', :'mgr_login',
   jsonb_build_array(test.inv('eeeeeeee-0000-0000-0000-000000000202', :'beans', 9)), p_performer => :'manager'))->>'message' = 'RETURN_TOO_LARGE', 'returns of all refunds together over 18 g (10 + 9) -> RETURN_TOO_LARGE');
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000202', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', 65.005, :'manager', :'mgr_login',
   jsonb_build_array(test.inv('eeeeeeee-0000-0000-0000-000000000202', :'beans', 8), test.inv('eeeeeeee-0000-0000-0000-000000000203', :'milk', 180)), p_performer => :'manager'))->>'status' = 'ok', 'rest of the sale (65.005, within rounding) with 8 g + 180 ml -> ok');
reset role;
select test.ok((select status from sales where id = '99999999-0000-0000-0000-000000000201') = 'REFUNDED', 'fully refunded -> REFUNDED');
select test.ok((select stock from v_ingredient_stock where ingredient_id = :'beans') = 1000 and (select stock from v_ingredient_stock where ingredient_id = :'milk') = 5000, 'stock fully restored, not more');
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000203', '99999999-0000-0000-0000-000000000201', 'PARTIAL_REFUND', 0, :'manager', :'mgr_login'))->>'message' = 'SALE_NOT_REFUNDABLE', 'no refunds on a fully refunded sale');
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000204', '99999999-0000-0000-0000-000000000104', 'VOID', 140, :'manager', :'mgr_login'))->>'message' = 'SALE_NOT_REFUNDABLE', 'no refunds on a HELD sale');
-- void: needs approval, returns stock, then a second void is skipped
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov3 \gset
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000205', '99999999-0000-0000-0000-000000000105', 'VOID', 150, :'manager', :'ov3', '[]', 'REFUNDED'))->>'status' = 'ok', 'void with OVERRIDE token -> ok');
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000206', '99999999-0000-0000-0000-000000000105', 'VOID', 150, :'manager', :'ov3'))->>'status' = 'skipped', 'second void of a voided sale -> skipped (token not needed)');
reset role;
select test.ok((select status from sales where id = '99999999-0000-0000-0000-000000000105') = 'VOIDED', 'VOID -> VOIDED');

-- ============ C2: child rows never overwrite other rows ============
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000301', 150, '[]', p_item => 'aaaaaaaa-0000-0000-0000-000000000201'))->>'message' = 'FORBIDDEN_ROW', 'item id of another sale -> FORBIDDEN_ROW');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000301', 150, '[]', p_pay => 'bbbbbbbb-0000-0000-0000-000000000201'))->>'message' = 'FORBIDDEN_ROW', 'payment id of another sale -> FORBIDDEN_ROW');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000301', 150, jsonb_build_array(test.inv('cccccccc-0000-0000-0000-000000000201', :'beans', 1))))->>'message' = 'FORBIDDEN_ROW', 'stock line id of another sale -> FORBIDDEN_ROW');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000301', 150, jsonb_build_array(test.inv('eeeeeeee-0000-0000-0000-000000000201', :'beans', 1))))->>'message' = 'FORBIDDEN_ROW', 'stock line id of a refund -> FORBIDDEN_ROW');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000301', 150, jsonb_build_array(test.inv('55555555-0000-0000-0000-000000000001', :'beans', 1))))->>'message' = 'FORBIDDEN_ROW', 'stock line id of a purchase/initial stock -> FORBIDDEN_ROW');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000301', 150, '[]', p_item => 'aaaaaaaa-0000-0000-0000-0000000000b1'))->>'message' = 'FORBIDDEN_ROW', 'item id of another SHOP''s sale -> FORBIDDEN_ROW');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000301', 150, jsonb_build_array(test.inv(gen_random_uuid(), '22222222-0000-0000-0000-0000000000b2', 1))))->>'message' = 'UNKNOWN_INGREDIENT', 'another shop''s ingredient in a sale -> UNKNOWN_INGREDIENT');
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov4 \gset
select test.ok(test.op(:'key1', 'refund', test.refund_data('dddddddd-0000-0000-0000-000000000301', '99999999-0000-0000-0000-000000000102', 'PARTIAL_REFUND', 1, :'manager', :'ov4',
   jsonb_build_array(test.inv('55555555-0000-0000-0000-000000000002', :'milk', 1))))->>'message' = 'FORBIDDEN_ROW', 'refund stock line id of an existing row -> FORBIDDEN_ROW');
reset role;
select test.ok((select sale_id from sale_items where id = 'aaaaaaaa-0000-0000-0000-000000000201') = '99999999-0000-0000-0000-000000000201'
           and (select sale_id from payments where id = 'bbbbbbbb-0000-0000-0000-000000000201') = '99999999-0000-0000-0000-000000000201'
           and (select reference_id from inventory_transactions where id = 'cccccccc-0000-0000-0000-000000000201') = '99999999-0000-0000-0000-000000000201'
           and (select transaction_type || quantity from inventory_transactions where id = '55555555-0000-0000-0000-000000000001') = 'INITIAL_STOCK1000'
           and (select sale_id from sale_items where id = 'aaaaaaaa-0000-0000-0000-0000000000b1') = '99999999-0000-0000-0000-0000000000b1', 'all those rows are untouched');
select test.ok((select count(*) from sales where id = '99999999-0000-0000-0000-000000000301') = 0, 'refused sale left no partial rows');
-- a HELD sale re-sent with its OWN child ids still works (they are replaced)
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000302', 150, '[]', p_status => 'HELD', p_item => 'aaaaaaaa-0000-0000-0000-000000000302', p_pay => 'bbbbbbbb-0000-0000-0000-000000000302'))->>'status' = 'ok', 'held sale saved');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000302', 150, jsonb_build_array(test.inv('cccccccc-0000-0000-0000-000000000302', :'beans', 18)), p_item => 'aaaaaaaa-0000-0000-0000-000000000302', p_pay => 'bbbbbbbb-0000-0000-0000-000000000302'))->>'status' = 'ok', 'same held sale completed with its own child ids');
select test.ok(test.op(:'key1', 'sale', test.sale_data('99999999-0000-0000-0000-000000000303', 150, '[]', p_cust => 'cccccccc-0000-0000-0000-0000000000b1'))->>'status' = 'ok', 'sale naming another shop''s customer is accepted ...');
reset role;
select test.ok((select customer_id from sales where id = '99999999-0000-0000-0000-000000000303') is null
           and (select visit_count from customers where id = 'cccccccc-0000-0000-0000-0000000000b1') = 0, '... but the foreign customer link is dropped');

-- ============ Lead decision 1a: completed sales must add up ============
select test.login(:'d1'); set role authenticated;
-- valid sales (counter maths incl. float noise, tax-inclusive, rounding of grand total only)
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000401',
   '{"subtotal":0.30000000000000004,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":0.3}',
   jsonb_build_array(test.item(0.1, 3, 0.30000000000000004, p_recipe => null))))->>'status' = 'ok', 'float noise (0.1 x 3) passes');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000402',
   jsonb_build_object('subtotal',340,'discount_type','percent','discount_value',20,'discount_amount',68,'tax_amount',0,'service_charge_amount',27.2,'grand_total',299.2,
                      'discount_approved_by', :'manager', 'cashier_id', :'manager'),
   jsonb_build_array(test.item(170, 2, p_mods => '[{"group":"Size","label":"16oz","price_delta":20}]'))) || jsonb_build_object('discount_approval_token', :'mgr_login'))->>'status' = 'ok',
   'tax-inclusive + 10% service + 20% discount passes');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000403',
   jsonb_build_object('subtotal',450,'discount_type','percent','discount_value',3.3,'discount_amount',14.85,'tax_amount',52.218,'service_charge_amount',43.515,'grand_total',530.88,
                      'discount_approved_by', :'manager', 'cashier_id', :'manager'),
   jsonb_build_array(test.item(150, 3))) || jsonb_build_object('discount_approval_token', :'mgr_login'))->>'status' = 'ok',
   '12% tax + 10% service + 3.3% discount, grand total rounded to 530.88, passes');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000404',
   jsonb_build_object('subtotal',150,'discount_type','percent','discount_value',100,'discount_amount',150,'tax_amount',0,'service_charge_amount',0,'grand_total',0,
                      'discount_approved_by', :'manager', 'cashier_id', :'manager'),
   jsonb_build_array(test.item(150, 1))) || jsonb_build_object('discount_approval_token', :'mgr_login'))->>'status' = 'ok', '100% discount passes');
-- broken sales
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":150,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":150}',
   jsonb_build_array(test.item(150, 2, 150))))->>'message' = 'SALE_TOTALS_MISMATCH', 'line total <> price x quantity -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":200,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":200}',
   jsonb_build_array(test.item(150, 1))))->>'message' = 'SALE_TOTALS_MISMATCH', 'subtotal <> sum of lines -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":0,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":0}',
   jsonb_build_array(test.item(150, 1, 0))))->>'message' = 'SALE_TOTALS_MISMATCH', 'items with a zero line total -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   jsonb_build_object('subtotal',150,'discount_type','fixed','discount_value',200,'discount_amount',200,'tax_amount',0,'service_charge_amount',0,'grand_total',-50,'discount_approved_by', :'manager', 'cashier_id', :'manager'),
   jsonb_build_array(test.item(150, 1))) || jsonb_build_object('discount_approval_token', :'mgr_login'))->>'message' = 'SALE_TOTALS_MISMATCH', 'discount above the subtotal -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   jsonb_build_object('subtotal',150,'discount_type','percent','discount_value',10,'discount_amount',20,'tax_amount',0,'service_charge_amount',0,'grand_total',130,'discount_approved_by', :'manager', 'cashier_id', :'manager'),
   jsonb_build_array(test.item(150, 1))) || jsonb_build_object('discount_approval_token', :'mgr_login'))->>'message' = 'SALE_TOTALS_MISMATCH', 'discount not matching 10% -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   jsonb_build_object('subtotal',150,'discount_amount',20,'tax_amount',0,'service_charge_amount',0,'grand_total',130,'discount_approved_by', :'manager', 'cashier_id', :'manager'),
   jsonb_build_array(test.item(150, 1))) || jsonb_build_object('discount_approval_token', :'mgr_login'))->>'message' = 'SALE_TOTALS_MISMATCH', 'discount without a discount type -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":150,"discount_amount":0,"tax_amount":-20,"service_charge_amount":0,"grand_total":130}',
   jsonb_build_array(test.item(150, 1))))->>'message' = 'SALE_TOTALS_MISMATCH', 'negative tax -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":150,"discount_amount":0,"tax_amount":0,"service_charge_amount":-20,"grand_total":130}',
   jsonb_build_array(test.item(150, 1))))->>'message' = 'SALE_TOTALS_MISMATCH', 'negative service charge -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":150,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":100}',
   jsonb_build_array(test.item(150, 1))))->>'message' = 'SALE_TOTALS_MISMATCH', 'grand total too low -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":150,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":150.03}',
   jsonb_build_array(test.item(150, 1))))->>'message' = 'SALE_TOTALS_MISMATCH', 'off by 0.03 (over the 0.02 tolerance) -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":150,"discount_amount":0,"tax_amount":0,"service_charge_amount":0}',
   jsonb_build_array(test.item(150, 1))))->>'message' = 'SALE_TOTALS_MISMATCH', 'missing grand total -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":150,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":"lots"}',
   jsonb_build_array(test.item(150, 1))))->>'message' = 'SALE_TOTALS_MISMATCH', 'non-number grand total -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":0,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":0}',
   jsonb_build_array(test.item(150, 1), test.item(150, -1))))->>'message' = 'SALE_TOTALS_MISMATCH', 'negative quantity -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000410',
   '{"subtotal":0,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":0}',
   jsonb_build_array(test.item(150, 1), test.item(-150, 1))))->>'message' = 'SALE_TOTALS_MISMATCH', 'negative price -> SALE_TOTALS_MISMATCH');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000411',
   '{"status":"HELD","subtotal":999,"grand_total":1}', jsonb_build_array(test.item(150, 1))))->>'status' = 'ok', 'HELD sales are not checked yet');
reset role;
select test.ok((select count(*) from sales where id = '99999999-0000-0000-0000-000000000410') = 0, 'refused sales left nothing behind');

-- ============ Lead decision 1b: below-menu prices are flagged, not refused ============
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000501',
   '{"subtotal":120,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":120,"needs_review":false,"review_reason":null}',
   jsonb_build_array(test.item(120, 1))))->>'status' = 'ok', 'sale below the menu price is accepted ...');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000502',
   '{"subtotal":200,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":200,"needs_review":true,"review_reason":"FAKE"}',
   jsonb_build_array(test.item(200, 1, p_mods => '[{"group":"Size","label":"16oz","price_delta":20},{"group":"Add-ons","label":"Extra shot","price_delta":30}]'))))->>'status' = 'ok', 'menu price with options (150+20+30)');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000503',
   '{"subtotal":140,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":140}',
   jsonb_build_array(test.item(140, 1, p_mods => '[{"group":"Add-ons","label":"No milk","price_delta":-10}]'))))->>'status' = 'ok', 'menu option that lowers the price (No milk -10)');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000504',
   '{"subtotal":50,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":50}',
   jsonb_build_array(test.item(50, 1, p_mods => '[{"group":"Promo","label":"Free","price_delta":-100}]'))))->>'status' = 'ok', 'made-up -100 option');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000505',
   '{"subtotal":150,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":150}',
   jsonb_build_array(test.item(150, 1, p_mods => '[{"group":"Size","label":"16oz","price_delta":0}]'))))->>'status' = 'ok', '16oz sold with a claimed +0');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000506',
   '{"subtotal":175,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":175}',
   jsonb_build_array(test.item(175, 1, p_mods => '[{"group":"Seasonal","label":"Pumpkin","price_delta":25}]'))))->>'status' = 'ok', 'option no longer on the menu, charged +25');
select test.ok(test.op(:'key1', 'sale', test.raw_sale('99999999-0000-0000-0000-000000000507',
   '{"subtotal":150,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":150}',
   jsonb_build_array(test.item(150, 1, p_recipe => '33333333-0000-0000-0000-0000000000b2'))))->>'message' = 'UNKNOWN_RECIPE', 'another shop''s recipe -> UNKNOWN_RECIPE');
reset role;
select test.ok((select needs_review and review_reason like '%PRICE_BELOW_MENU%' from sales where id = '99999999-0000-0000-0000-000000000501'), '... and flagged PRICE_BELOW_MENU (counter''s needs_review=false ignored)');
select test.ok((select coalesce(review_reason, '') not like '%PRICE%' from sales where id = '99999999-0000-0000-0000-000000000502'), 'options matched to the menu: not flagged (counter''s needs_review=true ignored)');
select test.ok((select coalesce(review_reason, '') not like '%PRICE%' from sales where id = '99999999-0000-0000-0000-000000000503'), 'menu''s own negative option: not flagged');
select test.ok((select needs_review and review_reason like '%PRICE_BELOW_MENU%' from sales where id = '99999999-0000-0000-0000-000000000504'), 'made-up negative option can''t hide a cheap price: flagged');
select test.ok((select needs_review from sales where id = '99999999-0000-0000-0000-000000000505'), 'option price taken from the menu (16oz = +20): flagged');
select test.ok((select coalesce(review_reason, '') not like '%PRICE%' from sales where id = '99999999-0000-0000-0000-000000000506'), 'option gone from the menu counts with its own +25: not flagged');
select test.ok((select needs_review and review_reason like '%NOT_ON_MENU%' from sales where id = '99999999-0000-0000-0000-000000000401'), 'item without a recipe: flagged NOT_ON_MENU');
select test.ok((select coalesce(review_reason, '') !~ 'PRICE|MENU' from sales where id = '99999999-0000-0000-0000-000000000402')
           and (select coalesce(review_reason, '') !~ 'PRICE|MENU' from sales where id = '99999999-0000-0000-0000-000000000201'), 'normal sales are not flagged');
select test.login(:'owner_uid'); set role authenticated;
select public.apply_changes('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000501","needs_review":false}}]');
select test.ok((select not needs_review from sales where id = '99999999-0000-0000-0000-000000000501'), 'owner marks a flagged sale as reviewed');
reset role;

-- ============ Lead decision 3: closing ANOTHER cashier's shift needs approval ============
select test.login(:'d1'); set role authenticated;
select test.ok(test.op(:'key1', 'shift_open', jsonb_build_object('id','88888888-0000-0000-0000-000000000002','shift_number','SHIFT-A-2026-0002',
  'cashier_id', :'cashier', 'cashier_name','Cathy','opened_at', now(), 'opening_cash', 500))->>'status' = 'ok', 'shift 2 opened (Cathy)');
select test.ok(test.op(:'key1', 'shift_open', jsonb_build_object('id','88888888-0000-0000-0000-000000000003','shift_number','SHIFT-A-2026-0003',
  'cashier_id', :'cashier', 'cashier_name','Cathy','opened_at', now(), 'opening_cash', 500))->>'status' = 'ok', 'shift 3 opened (Cathy)');
select test.ok(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000002','closed_at', now(),'declared_cash',500,
  'closed_by', :'manager', 'closed_by_name', 'Fake'))->>'message' = 'APPROVAL_REQUIRED', 'closing another cashier''s shift without token -> APPROVAL_REQUIRED');
select test.ok(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000002','closed_at', now(),'declared_cash',500,
  'closed_by', '66666666-0000-0000-0000-000000000004', 'approval_token', :'cashier_login'))->>'message' = 'ROLE_TOO_LOW', 'another CASHIER closing it -> ROLE_TOO_LOW');
select test.ok(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000002','closed_at', now(),'declared_cash',500,
  'closed_by', :'manager', 'approval_token', :'cashier_login'))->>'message' = 'APPROVAL_INVALID', 'manager named with the cashier''s token -> APPROVAL_INVALID');
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_close \gset
select test.ok(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000002','closed_at', now(),'declared_cash',500,
  'closed_by', :'manager', 'closed_by_name', 'Fake', 'approval_token', :'ov_close'))->>'status' = 'ok', 'manager closes it with an OVERRIDE token -> ok');
select test.ok(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000003','closed_at', now(),'declared_cash',500,
  'closed_by', :'manager', 'approval_token', :'ov_close'))->>'message' = 'APPROVAL_INVALID', 'the same token can''t close a second shift');
select test.ok(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000003','closed_at', now(),'declared_cash',500,
  'closed_by', :'cashier', 'closed_by_name', 'Fake'))->>'status' = 'ok', 'closing your OWN shift needs no token');
select test.ok(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000003','closed_by', :'cashier'))->>'status' = 'skipped', 'closing a closed shift -> skipped');
reset role;
select test.ok((select status = 'CLOSED' and closed_by = :'manager'::uuid and closed_by_name = 'Manny Manager' from shifts where id = '88888888-0000-0000-0000-000000000002'), 'shift 2 closed by Manny (name from the staff list)');
select test.ok((select used_for = 'shift_close:88888888-0000-0000-0000-000000000002' from staff_sessions where token_hash = encode(extensions.digest(:'ov_close', 'sha256'), 'hex')), 'close token marked used');
select test.ok((select status = 'CLOSED' and closed_by_name = 'Cathy Cashier' from shifts where id = '88888888-0000-0000-0000-000000000003'), 'shift 3 closed by Cathy herself');

-- ============ C5: counters never see full phone numbers ============
insert into customers(id, business_id, nickname, phone) values
  ('cccccccc-0000-0000-0000-000000000001', :'biz', 'Zed', '+639171234567'),
  ('cccccccc-0000-0000-0000-000000000002', :'biz', 'Wendy', '+639180001111');
select test.login(:'d1'); set role authenticated;
select test.ok((select count(*) from customers) = 0, 'counter cannot read the customers table directly');
select test.ok((public.search_customers('zed')->0->>'phone') = '0917 ••• 4567' and (public.search_customers('zed')->0->>'phone_masked')::boolean, 'search by name: phone masked 0917 ••• 4567');
select test.ok(jsonb_array_length(public.search_customers('1234')) = 0, 'counter cannot search by middle digits');
select test.ok(jsonb_array_length(public.search_customers('0917')) = 0, 'counter cannot search by the first digits either');
select test.ok(jsonb_array_length(public.search_customers('4567')) = 1, 'counter can search by the last 4 digits');
select test.ok((public.search_customers('0917 123 4567')->0->>'nickname') = 'Zed' and (public.search_customers('09171234567')->0->>'phone') = '0917 ••• 4567', 'counter can search by the full number (answer still masked)');
select test.ok(public.search_customers('')::text not like '%+639%' and public.search_customers('')::text not like '%1234567%', 'no full number anywhere in a counter search');
select test.ok((public.fo_add_customer('Someone', '0918 000 1111', true)->'customer'->>'phone') = '0918 ••• 1111', 'fo_add_customer (existing) masked');
select test.ok((public.fo_add_customer('Newbie', '0919 555 0000', true)->'customer'->>'phone') = '0919 ••• 0000', 'fo_add_customer (new) masked');
select test.ok(public.fo_bootstrap(:'key1')::text not like '%+639%', 'fo_bootstrap has no full numbers');
select test.ok(public.sales_report(now() - interval '1 day', now() + interval '1 day')::text not like '%+639%', 'sales_report has no full numbers');
reset role;
select test.login(:'owner_uid'); set role authenticated;
select test.ok((select count(*) from customers) = 3, 'owner reads the customers table');
select test.ok((public.search_customers('1234')->0->>'phone') = '+639171234567', 'owner: search by any digits, full number');
select test.ok(jsonb_array_length(public.search_customers('0917')) = 1, 'owner: 09.. style digits match too');
select test.ok((public.fo_add_customer('Zed', '09171234567', true)->'customer'->>'phone') = '+639171234567', 'owner: fo_add_customer returns the full number');
reset role;
-- full-number look-ups by a counter are limited (60 per hour)
select test.ok((select count(*) from auth_attempts where subject = :'d1' and kind = 'PHONE_LOOKUP') = 4, 'only the 4 full-number look-ups were counted');
insert into auth_attempts(subject, kind, success) select :'d1', 'PHONE_LOOKUP', true
  from generate_series(1, 60 - (select count(*) from auth_attempts where subject = :'d1' and kind = 'PHONE_LOOKUP'));
select test.login(:'d1'); set role authenticated;
select test.ok(test.err($$select public.search_customers('09171234567')$$) = 'TOO_MANY_ATTEMPTS', '61st full-number search in an hour -> TOO_MANY_ATTEMPTS');
select test.ok(public.fo_add_customer('X', '09170000000', true)->>'error' = 'TOO_MANY_ATTEMPTS', 'fo_add_customer by number also limited');
select test.ok(jsonb_array_length(public.search_customers('zed')) = 1 and jsonb_array_length(public.search_customers('4567')) = 1, 'name / last-digit searches still work');
reset role;
select test.login(:'d2'); set role authenticated;
select test.ok(jsonb_array_length(public.search_customers('09171234567')) = 1, 'the limit is per counter login');
reset role;
-- other logins
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select test.ok(test.err($$select public.search_customers('zed')$$) = 'NOT_A_MEMBER', 'a customer login cannot search customers');
reset role;

-- ============ C6: phone linking only via qr_relink; reveals are rate-limited ============
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select test.ok(public.qr_register(:'tok', 'Zed', '0917 123 4567', true)->>'error' = 'PHONE_TAKEN', 'qr_register with a registered number + SAME nickname -> PHONE_TAKEN (no relink)');
select test.ok((select count(*) from customer_devices) = 0, '... and nothing was linked');
select public.qr_register(:'tok', 'Zed', '0917 123 4567', true);
select public.qr_register(:'tok', 'Zed', '0917 123 4567', true);
select public.qr_register(:'tok', 'Zed', '0917 123 4567', true);
select test.ok(public.qr_register(:'tok', 'Zed', '0917 123 4567', true)->>'error' = 'PHONE_TAKEN', '5th PHONE_TAKEN still answered');
select test.ok(public.qr_register(:'tok', 'Zed', '0917 123 4567', true)->>'error' = 'TOO_MANY_ATTEMPTS', '6th -> TOO_MANY_ATTEMPTS');
select test.ok(public.qr_relink(:'tok', '0917 123 4567', 'Zed')->>'error' = 'TOO_MANY_ATTEMPTS', 'the limit is shared with qr_relink');
select test.ok((public.qr_register(:'tok', 'Zed', null, true)->'customer'->>'nickname') = 'Zed', 'registering without a number still works');
reset role;
select test.login('00000000-0000-0000-0000-0000000000c2'); set role authenticated;
select test.ok((public.qr_register(:'tok', 'Zoe', null, true)->'customer'->>'nickname') = 'Zoe', 'c2 registered without phone');
select test.ok(public.qr_set_phone(:'tok', '09180001111')->>'error' = 'PHONE_TAKEN', 'qr_set_phone with a registered number -> PHONE_TAKEN');
select public.qr_set_phone(:'tok', '09180001111'); select public.qr_set_phone(:'tok', '09180001111'); select public.qr_set_phone(:'tok', '09180001111'); select public.qr_set_phone(:'tok', '09180001111');
select test.ok(public.qr_set_phone(:'tok', '09180001111')->>'error' = 'TOO_MANY_ATTEMPTS', 'qr_set_phone limited after 5 reveals');
select test.ok(public.qr_set_phone(:'tok', '09175550000')->>'error' = 'TOO_MANY_ATTEMPTS', '... for any number (while locked)');
reset role;
select test.login('00000000-0000-0000-0000-0000000000c3'); set role authenticated;
select test.ok((public.qr_register(:'tok', 'Yna', '09175550000', true)->'customer'->>'phone_hint') = '•••• 000', 'a new number registers fine');
reset role;
select test.login('00000000-0000-0000-0000-0000000000c4'); set role authenticated;
select test.ok((public.qr_relink(:'tok', '+63 917 123 4567', 'zed')->'customer'->>'nickname') = 'Zed', 'qr_relink (phone + nickname) still links a new phone');
reset role;

-- ============ C7: progressive PIN lockout ============
delete from auth_attempts where kind = 'PIN';
select test.login(:'d1'); set role authenticated;
select public.staff_pin_login('0001'); select public.staff_pin_login('0002'); select public.staff_pin_login('0003');
select test.ok(public.staff_pin_login('0004')->>'error' = 'WRONG_PIN', '4 wrong PINs: still just WRONG_PIN');
select test.ok(public.staff_pin_login('0005')->>'error' = 'TOO_MANY_ATTEMPTS', '5th wrong PIN in 15 min -> locked');
select test.ok((public.staff_pin_login('1111')->>'locked_until')::timestamptz between now() + interval '4 minutes' and now() + interval '5 minutes', 'correct PIN refused while locked; lock is ~5 minutes');
reset role;
select test.login(:'d2'); set role authenticated;
select test.ok(public.staff_pin_login('1111')->>'token' is not null, 'the lock is per counter (d2 unaffected)');
reset role;
update auth_attempts set at = at - interval '6 minutes' where subject = :'d1' and kind = 'PIN';
select test.login(:'d1'); set role authenticated;
select test.ok(public.staff_pin_login('1111')->>'token' is not null, 'after 5 minutes the counter works again');
reset role;
-- 10 wrong in an hour -> 30 minutes
delete from auth_attempts where kind = 'PIN';
insert into auth_attempts(subject, kind, success, at) select :'d1', 'PIN', false, now() - interval '50 minutes' + (g * interval '4 minutes') from generate_series(0, 9) g;  -- last one 14 min ago
select test.login(:'d1'); set role authenticated;
select test.ok((public.staff_pin_login('1111')->>'locked_until')::timestamptz between now() + interval '15 minutes' and now() + interval '17 minutes', '10 wrong in an hour -> locked 30 min after the last one');
reset role;
-- 20 wrong in a day -> 4 hours
delete from auth_attempts where kind = 'PIN';
insert into auth_attempts(subject, kind, success, at) select :'d1', 'PIN', false, now() - interval '20 hours' + (g * interval '50 minutes') from generate_series(0, 19) g;  -- last one ~4h10m.. ago? -> compute below
update auth_attempts set at = now() - interval '2 hours' where id = (select max(id) from auth_attempts where kind = 'PIN');
select test.login(:'d1'); set role authenticated;
select test.ok((public.staff_pin_login('1111')->>'locked_until')::timestamptz between now() + interval '119 minutes' and now() + interval '121 minutes', '20 wrong in a day -> locked 4 h after the last one');
reset role;
delete from auth_attempts where kind = 'PIN';
insert into auth_attempts(subject, kind, success, at) select :'d1', 'PIN', false, now() - interval '1 minute' from generate_series(1, 4);
insert into auth_attempts(subject, kind, success, at) select :'d1', 'PIN', true, now() from generate_series(1, 3);
select test.login(:'d1'); set role authenticated;
select test.ok(public.staff_pin_login('0009')->>'error' = 'TOO_MANY_ATTEMPTS', 'correct PINs in between do not reset the count');
select id as dev1 from devices where device_key = :'key1' \gset
select test.ok(public.unlock_device_pin(:'dev1')->>'error' = 'ADMIN_ONLY', 'a counter cannot lift its own PIN lock');
reset role;
select test.login(:'owner_uid'); set role authenticated;
select test.ok(public.unlock_device_pin(:'dev1')->>'cleared' = '5', 'owner lifts the PIN lock');
select test.ok(public.unlock_device_pin('00000000-0000-0000-0000-000000000000')->>'error' = 'UNKNOWN_DEVICE', 'unknown device');
reset role;
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.ok(public.unlock_device_pin(:'dev1')->>'error' = 'UNKNOWN_DEVICE', 'another shop''s owner cannot touch our counter');
reset role;
select test.login(:'d1'); set role authenticated;
select test.ok(public.staff_pin_login('1111')->>'token' is not null, 'counter works again after the owner unlocked it');
reset role;
select 'ALL SECURITY CHECKS PASSED';
