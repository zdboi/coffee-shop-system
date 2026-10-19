-- Fix-round checks 2026-10-12 / -13 (adopted from the database engineer's fix_checks.sql, 130 checks):
--   QR order paid once (QR_ORDER_ALREADY_PAID), refund caps for every login incl. the owner (deferred triggers),
--   pro-rated partial refunds, SALE_LOCKED, PIN_AMBIGUOUS, a sign-in token approves only its own staff member,
--   refunds.imported_at, refused pairings, centavo rounding.
-- Needs a FRESH database (run_all.sh does this):
--   tests/reset_db.sh "" cccc && psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1 -f tests/sql/32_fix_round_tests.sql
-- Stops at the first failed check (ASSERT FAILED). One "ERROR: REFUND_TOO_LARGE" line in the output is expected
-- (a direct table insert over the cap, refused at commit, around line 306). tests/conc_checks.sh runs on the data it leaves.
\set QUIET on
create schema if not exists test;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', case when p_token is null then '{}' else json_build_object('x-staff-token', p_token)::text end, false);
end $$;
create or replace function test.ok(cond boolean, msg text) returns text language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'ASSERT FAILED: %', msg; end if; return 'ok  ' || msg; end $$;
create or replace function test.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'NO ERROR'; exception when others then return sqlerrm; end $$;
-- one fo_sync op -> {status, message}
create or replace function test.op(p_key text, p_type text, p_data jsonb) returns jsonb language sql as $$
  select public.fo_sync(p_key, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', p_type, 'data', p_data)))->0
$$;
create or replace function test.res(p jsonb) returns text language sql as $$
  select case when p->>'status' = 'error' then p->>'message' else p->>'status' end
$$;
create or replace function test.inv(p_id uuid, p_ing uuid, p_qty numeric) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'ingredient_id', p_ing, 'quantity', p_qty, 'transaction_date', '2026-10-12')
$$;
create or replace function test.it(p_id uuid, p_recipe uuid, p_unit numeric, p_qty numeric) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'recipe_id', p_recipe, 'name', 'X', 'quantity', p_qty, 'unit_price', p_unit,
                            'line_total', p_unit * p_qty, 'modifiers', '[]'::jsonb)
$$;
-- a counter sale op's data
create or replace function test.sale(p_sale uuid, p_fields jsonb, p_items jsonb, p_inv jsonb default '[]', p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object(
    'sale', jsonb_build_object('id', p_sale, 'transaction_number', 'POS-A-2026-' || left(p_sale::text, 8), 'transaction_date', now(),
       'status', 'COMPLETED', 'cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy',
       'shift_id', '88888888-0000-0000-0000-000000000001', 'discount_amount', 0, 'tax_amount', 0, 'service_charge_amount', 0) || p_fields,
    'items', p_items,
    'payment', jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', p_fields->'grand_total', 'status', 'CONFIRMED'),
    'inventory', p_inv) || p_extra
$$;
create or replace function test.ri(p_item uuid, p_qty numeric) returns jsonb language sql as $$
  select jsonb_build_object('sale_item_id', p_item, 'quantity', p_qty)
$$;
-- a counter refund op's data
create or replace function test.refund(p_ref uuid, p_sale uuid, p_type text, p_amount numeric, p_items jsonb, p_appr uuid, p_tok text,
   p_inv jsonb default '[]', p_performer uuid default null) returns jsonb language sql as $$
  select jsonb_build_object(
    'refund', jsonb_build_object('id', p_ref, 'sale_id', p_sale, 'shift_id', '88888888-0000-0000-0000-000000000001', 'type', p_type,
       'amount', p_amount, 'reason', 'test', 'items', p_items, 'approved_by', p_appr, 'approved_by_name', 'Fake', 'date', now(),
       'performed_by', coalesce(p_performer, p_appr)),
    'inventory', p_inv, 'approval_token', p_tok)
$$;
-- Back Office (apply_changes) refund ops: refund row, its stock lines, the sale's new status
create or replace function test.bo_refund(p_ref uuid, p_sale uuid, p_type text, p_amount numeric, p_items jsonb,
   p_inv jsonb default '[]', p_status text default 'PARTIALLY_REFUNDED') returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('op', 'upsert', 'table', 'refunds', 'row', jsonb_build_object(
           'id', p_ref, 'sale_id', p_sale, 'type', p_type, 'amount', p_amount, 'reason', 'BO test', 'items', p_items,
           'approved_by', null, 'approved_by_name', 'Zed', 'date', now())))
      || coalesce((select jsonb_agg(jsonb_build_object('op', 'upsert', 'table', 'inventory_transactions', 'row',
           x || jsonb_build_object('transaction_type', 'SALE_REVERSAL', 'reference_id', p_ref))) from jsonb_array_elements(p_inv) x), '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'sales', 'row', jsonb_build_object('id', p_sale, 'status', p_status)))
$$;
-- run apply_changes; 'ok' or the error text
create or replace function test.bo(p_ops jsonb) returns text language plpgsql as $$
begin perform public.apply_changes(p_ops); return 'ok'; exception when others then return sqlerrm; end $$;
create or replace function test.rev(p jsonb) returns jsonb language sql as $$
  select coalesce((select jsonb_agg(x order by o desc) from jsonb_array_elements(p) with ordinality t(x, o)), '[]'::jsonb)
$$;
grant usage on schema test to anon, authenticated; grant execute on all functions in schema test to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

-- ================= setup (as the database owner) =================
\set beans '22222222-0000-0000-0000-000000000001'
\set milk  '22222222-0000-0000-0000-000000000002'
\set latte '33333333-0000-0000-0000-000000000001'
\set amer  '33333333-0000-0000-0000-000000000003'
\set cashier '66666666-0000-0000-0000-000000000001'
\set manager '66666666-0000-0000-0000-000000000002'
\set mara '66666666-0000-0000-0000-000000000003'
\set owner_uid '00000000-0000-0000-0000-0000000000a1'
\set d1 '00000000-0000-0000-0000-0000000000d1'
\set d2 '00000000-0000-0000-0000-0000000000d2'
\set d3 '00000000-0000-0000-0000-0000000000d3'
\set key1 'device-key-0001-abcdef'
\set key2 'device-key-0002-abcdef'
\set key3 'device-key-0003-abcdef'
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000b1', 'other@example.com', '{"business_name":"Other Shop","admin_name":"Olga"}');
insert into auth.users (id, is_anonymous) select x::uuid, true from unnest(array[
  '00000000-0000-0000-0000-0000000000c1', :'d1', :'d2', :'d3', '00000000-0000-0000-0000-0000000000f9',
  '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2']) x;
select business_id as biz from profiles where id = :'owner_uid' \gset
select business_id as biz2 from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset
select id as owner_staff from staff where profile_id = :'owner_uid' \gset
select qr_token as tok from dining_tables where business_id = :'biz' \gset
select qr_token as tok2 from dining_tables where business_id = :'biz2' \gset
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
     '[{"id":"g-size","name":"Size","required":true,"options":[{"id":"o-12","label":"12oz","price_delta":0}]}]'),
    ('33333333-0000-0000-0000-000000000003', v_biz, 'Americano', 'DRINKS', 110, '[]'),
    ('33333333-0000-0000-0000-0000000000b2', v_biz2, 'Other latte', 'DRINKS', 100, '[]');
  insert into public.inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, transaction_date) values
    ('55555555-0000-0000-0000-000000000001', v_biz, '22222222-0000-0000-0000-000000000001', 'INITIAL_STOCK', 5000, '2026-10-01'),
    ('55555555-0000-0000-0000-000000000002', v_biz, '22222222-0000-0000-0000-000000000002', 'INITIAL_STOCK', 50000, '2026-10-01');
  insert into public.staff(id, business_id, name, role) values
    ('66666666-0000-0000-0000-000000000001', v_biz, 'Cathy Cashier', 'CASHIER'),
    ('66666666-0000-0000-0000-000000000002', v_biz, 'Manny Manager', 'MANAGER'),
    ('66666666-0000-0000-0000-000000000003', v_biz, 'Mara Manager', 'MANAGER'),
    ('66666666-0000-0000-0000-000000000004', v_biz, 'Carl Cashier', 'CASHIER');
  insert into public.staff_pins(staff_id, pin_hash) values
    ('66666666-0000-0000-0000-000000000001', extensions.crypt('1111', extensions.gen_salt('bf', 4))),
    ('66666666-0000-0000-0000-000000000002', extensions.crypt('2222', extensions.gen_salt('bf', 4))),
    ('66666666-0000-0000-0000-000000000003', extensions.crypt('3333', extensions.gen_salt('bf', 4))),
    (v_owner_staff, extensions.crypt('9999', extensions.gen_salt('bf', 4)));
  insert into public.device_pairing_codes(code, business_id, device_name, expires_at) values
    ('PAIRA1', v_biz, 'Front', now() + interval '1 hour'), ('PAIRA2', v_biz, 'Back bar', now() + interval '1 hour'),
    ('PAIRA3', v_biz, 'Spare', now() + interval '1 hour'), ('PAIRA4', v_biz, 'Spare 2', now() + interval '1 hour'),
    ('PAIRA5', v_biz, 'Spare 3', now() + interval '1 hour'),
    ('PAIRB1', v_biz2, 'Other', now() + interval '1 hour'), ('PAIRB2', v_biz2, 'Other 2', now() + interval '1 hour');
  insert into public.sales(id, business_id, status, grand_total, subtotal) values ('99999999-0000-0000-0000-0000000000b1', v_biz2, 'COMPLETED', 50, 50);
end $$;
select test.login(:'d1'); set role authenticated;
select test.ok(public.redeem_device_pairing('PAIRA1', :'key1', 'Front')->'device' is not null, 'setup: d1 paired'); reset role;
select test.login(:'d2'); set role authenticated;
select test.ok(public.redeem_device_pairing('PAIRA2', :'key2', 'Back bar')->'device' is not null, 'setup: d2 paired'); reset role;
select test.login(:'d3'); set role authenticated;
select test.ok(public.redeem_device_pairing('PAIRB1', :'key3', 'Other')->'device' is not null, 'setup: d3 paired (other shop)'); reset role;
select test.login(:'d1'); set role authenticated;
select (public.staff_pin_login('1111'))->>'token' as cashier_login \gset
select (public.staff_pin_login('2222'))->>'token' as mgr_login \gset
select test.ok(test.res(test.op(:'key1', 'shift_open', jsonb_build_object('id','88888888-0000-0000-0000-000000000001','shift_number','SHIFT-A-2026-0001',
  'cashier_id', :'cashier', 'cashier_name','Cathy','opened_at', now(), 'opening_cash', 1000))) = 'ok', 'setup: shift opened');
reset role;

-- ================= grants =================
select test.ok(bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')),
  'new internal functions are not callable through the API')
from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('_to_num','_to_uuid','_refund_items_cap','_check_refund','_check_sale_returns','_check_sale_refund_total','_stock_line_sale','_refund_caps_trigger');
select test.ok((select count(*) from pg_trigger where tgname in ('refunds_cap_check_ins','refunds_cap_check_upd','stock_cap_check_ins','stock_cap_check_upd','stock_cap_check_del','sales_cap_check_upd')
                and tgdeferrable and tginitdeferred) = 6, 'six deferred refund-cap triggers installed');

-- ================= 6. a signed-in manager's LOGIN token approves (not used up) =================
select test.login(:'d1'); set role authenticated;
-- P1: Americano x2 (110) + Latte (150), 20% discount, 12% tax, 10% service: S 370, disc 74, tax 35.52, svc 29.60, G 361.12
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000001',
   jsonb_build_object('subtotal', 370, 'discount_type', 'percent', 'discount_value', 20, 'discount_amount', 74, 'tax_amount', 35.52,
                      'service_charge_amount', 29.60, 'grand_total', 361.12, 'discount_approved_by', :'manager', 'cashier_id', :'manager'),
   jsonb_build_array(test.it('aaaaaaaa-0000-0000-0000-000000000011', :'latte', 150, 1), test.it('aaaaaaaa-0000-0000-0000-000000000012', :'amer', 110, 2)),
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18), test.inv(gen_random_uuid(), :'milk', 180), test.inv(gen_random_uuid(), :'beans', 36)),
   jsonb_build_object('discount_approval_token', :'mgr_login')))) = 'ok', '6: discount on the manager''s OWN sale approved with their LOGIN token');
-- P2: Latte 200 + Americano 65, 12% tax + 10% service: S 265, G 323.30 (like money.e2e sale A)
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000002',
   '{"subtotal":265,"tax_amount":31.80,"service_charge_amount":26.50,"grand_total":323.30}',
   jsonb_build_array(test.it('aaaaaaaa-0000-0000-0000-000000000021', :'latte', 200, 1), test.it('aaaaaaaa-0000-0000-0000-000000000022', :'amer', 65, 1)),
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 36), test.inv(gen_random_uuid(), :'milk', 180))))) = 'ok', 'setup: sale P2 (G 323.30)');
-- P3: Latte 150 + 10% service = 165
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000003',
   '{"subtotal":150,"service_charge_amount":15,"grand_total":165}', jsonb_build_array(test.it('aaaaaaaa-0000-0000-0000-000000000031', :'latte', 150, 1)),
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18), test.inv(gen_random_uuid(), :'milk', 180))))) = 'ok', 'setup: sale P3 (₱165)');
-- P4: free (100% discount)
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000004',
   jsonb_build_object('subtotal', 150, 'discount_type', 'percent', 'discount_value', 100, 'discount_amount', 150, 'grand_total', 0, 'discount_approved_by', :'manager', 'cashier_id', :'manager'),
   jsonb_build_array(test.it('aaaaaaaa-0000-0000-0000-000000000041', :'latte', 150, 1)), '[]', jsonb_build_object('discount_approval_token', :'mgr_login')))) = 'ok', 'setup: free sale P4 (LOGIN token used again)');
-- P5 HELD; P6, P7, P8, P9 plain ₱150 sales
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000005', '{"status":"HELD","subtotal":150,"grand_total":150}',
   jsonb_build_array(test.it(gen_random_uuid(), :'latte', 150, 1))))) = 'ok', 'setup: held sale P5');
select test.ok(bool_and(test.res(test.op(:'key1', 'sale', test.sale(('99999999-0000-0000-0000-00000000000' || n)::uuid, '{"subtotal":150,"grand_total":150}',
   jsonb_build_array(test.it(('aaaaaaaa-0000-0000-0000-0000000000' || n || '1')::uuid, :'latte', 150, 1)),
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18), test.inv(gen_random_uuid(), :'milk', 180))))) = 'ok'), 'setup: sales P6-P9 (₱150)')
from generate_series(6, 9) n;
reset role;
select test.ok((select used_at is null from staff_sessions where token_hash = encode(extensions.digest(:'mgr_login', 'sha256'), 'hex')), '6: LOGIN token not used up by approvals');
select test.ok((select discount_approved_by_name from sales where id = '99999999-0000-0000-0000-000000000001') = 'Manny Manager', '6: approver name from the staff list');

-- ================= 4. pro-rated partial refunds, counter (fo_sync) =================
select test.login(:'d1'); set role authenticated;
select (public.staff_pin_login('2222', 'OVERRIDE', 'MANAGER'))->>'token' as ov1 \gset
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000021', '99999999-0000-0000-0000-000000000002', 'PARTIAL_REFUND', 244.03,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000021', 1)), :'manager', :'ov1'))) = 'REFUND_TOO_LARGE',
   '4 counter: latte 200 of a sale with tax+service -> share 200 x 323.30/265 = 244.00; 244.03 refused');
reset role;
select test.ok((select used_at is null from staff_sessions where token_hash = encode(extensions.digest(:'ov1', 'sha256'), 'hex')), '4 counter: refused refund did not use up the OVERRIDE token');
select test.login(:'d1'); set role authenticated;
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000021', '99999999-0000-0000-0000-000000000002', 'PARTIAL_REFUND', 244.02,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000021', 1)), :'manager', :'ov1',
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18), test.inv(gen_random_uuid(), :'milk', 180))))) = 'ok',
   '4 counter: 244.02 (within 2 centavos) accepted with an OVERRIDE token');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000022', '99999999-0000-0000-0000-000000000002', 'PARTIAL_REFUND', 79.29,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000022', 1)), :'manager', :'mgr_login',
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18))))) = 'ok',
   '4 counter + 6: last item back -> the whole rest (79.28 left, 79.29 within 1 centavo) with the manager LOGIN token');
reset role;
select test.ok((select status from sales where id = '99999999-0000-0000-0000-000000000002') = 'REFUNDED', '4 counter: sale fully refunded');
select test.login(:'d1'); set role authenticated;
-- P1 at the counter: one Americano of the discounted sale: share 110 x 361.12 / 370 = 107.36
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000011', '99999999-0000-0000-0000-000000000001', 'PARTIAL_REFUND', 110,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000012', 1)), :'manager', :'mgr_login'))) = 'REFUND_TOO_LARGE',
   '4 counter: one Americano of a 20%-discounted sale at the line price (110) refused (share 107.36)');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000011', '99999999-0000-0000-0000-000000000001', 'FULL_REFUND', 361.12,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000012', 1)), :'manager', :'mgr_login'))) = 'REFUND_TOO_LARGE',
   '4 counter: calling it FULL_REFUND does not lift the cap when not every item comes back');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000011', '99999999-0000-0000-0000-000000000001', 'PARTIAL_REFUND', 250,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000012', 7)), :'manager', :'mgr_login'))) = 'REFUND_TOO_LARGE',
   '4 counter: listing 7 Americanos (2 sold) counts only 2 (cap 214.72; 250 refused)');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000011', '99999999-0000-0000-0000-000000000001', 'PARTIAL_REFUND', 5,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000031', 1)), :'manager', :'mgr_login'))) = 'REFUND_TOO_LARGE',
   '4 counter: an item of ANOTHER sale counts as nothing');
-- P4 free sale: items listed -> 0; VOID of everything -> 0 fine
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000041', '99999999-0000-0000-0000-000000000004', 'PARTIAL_REFUND', 1,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000041', 1)), :'manager', :'mgr_login'))) = 'REFUND_TOO_LARGE',
   '4 counter: nothing to give back on a free sale');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000041', '99999999-0000-0000-0000-000000000004', 'VOID', 0,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000041', 1)), :'manager', :'mgr_login'))) = 'ok',
   '4 counter + 6: VOID of a free sale (₱0) with the manager LOGIN token');
-- P9: VOID with all items -> the whole amount
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-000000000091', '99999999-0000-0000-0000-000000000009', 'VOID', 150,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000091', 1)), :'manager', :'mgr_login',
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18), test.inv(gen_random_uuid(), :'milk', 180))))) = 'ok',
   '6: VOID approved with the manager LOGIN token (whole amount, all items)');
reset role;

-- ================= 3 + 4. Back Office (apply_changes): same caps, one call, any order =================
select test.login(:'owner_uid'); set role authenticated;
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000003', 'PARTIAL_REFUND', 665, '[]')) = 'REFUND_TOO_LARGE',
   '3: owner refund of ₱665 on a ₱165 sale refused (QA D6)');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000012', '99999999-0000-0000-0000-000000000001', 'PARTIAL_REFUND', 110,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000012', 1)), jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18)))) = 'REFUND_TOO_LARGE',
   '4 BO: one Americano of the discounted sale at the line price (110) refused');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000012', '99999999-0000-0000-0000-000000000001', 'PARTIAL_REFUND', 107.39,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000012', 1)))) = 'REFUND_TOO_LARGE', '4 BO: 107.39 refused (share 107.36 + 2 centavos)');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000012', '99999999-0000-0000-0000-000000000001', 'PARTIAL_REFUND', 107.36,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000012', 1)), jsonb_build_array(test.inv('eeeeeeee-0000-0000-0000-000000000121', :'beans', 18)))) = 'ok',
   '3+4 BO: refund 107.36 + its stock line + the sale status in ONE call -> ok');
reset role;
select test.ok((select status from sales where id = '99999999-0000-0000-0000-000000000001') = 'PARTIALLY_REFUNDED'
           and (select count(*) from refunds where sale_id = '99999999-0000-0000-0000-000000000001') = 1, '3 BO: saved, sale partly refunded');
select test.login(:'owner_uid'); set role authenticated;
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000013', '99999999-0000-0000-0000-000000000001', 'PARTIAL_REFUND', 100,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000012', 1)), jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 37)))) = 'RETURN_TOO_LARGE',
   '3 BO: putting back 18 + 37 g beans when the sale took 54 g -> RETURN_TOO_LARGE');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000013', '99999999-0000-0000-0000-000000000001', 'PARTIAL_REFUND', 150,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000012', 5)))) = 'REFUND_TOO_LARGE',
   '4 BO: listing 5 Americanos when 1 is left counts only that 1 (cap 107.36)');
-- the rest of P1, ops in REVERSED order (status first, refund last): latte + 1 Americano = everything left = 253.76
select test.ok(test.bo(test.rev(test.bo_refund('dddddddd-0000-0000-0000-000000000013', '99999999-0000-0000-0000-000000000001', 'FULL_REFUND', 253.76,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000011', 1), test.ri('aaaaaaaa-0000-0000-0000-000000000012', 1)),
   jsonb_build_array(test.inv('eeeeeeee-0000-0000-0000-000000000131', :'beans', 36), test.inv('eeeeeeee-0000-0000-0000-000000000132', :'milk', 180)), 'REFUNDED'))) = 'ok',
   '3+4 BO: the rest (every item back -> all that is left, 253.76), ops in reversed order -> ok');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000014', '99999999-0000-0000-0000-000000000001', 'PARTIAL_REFUND', 0, '[]', '[]', 'REFUNDED')) = 'SALE_NOT_REFUNDABLE',
   '3 BO: nothing left -> SALE_NOT_REFUNDABLE');
select test.ok(test.bo('[{"op":"update","table":"refunds","row":{"id":"dddddddd-0000-0000-0000-000000000012","amount":120}}]') = 'REFUND_TOO_LARGE',
   '3 BO: raising an existing refund''s amount -> REFUND_TOO_LARGE');
select test.ok(test.bo('[{"op":"update","table":"inventory_transactions","row":{"id":"eeeeeeee-0000-0000-0000-000000000121","quantity":40}}]') = 'RETURN_TOO_LARGE',
   '3 BO: raising a put-back stock line -> RETURN_TOO_LARGE');
select test.ok(test.bo('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000001","grand_total":300}}]') = 'SALE_LOCKED',
   '3 BO: changing a refunded sale''s total -> SALE_LOCKED');
select test.ok(test.bo('[{"op":"update","table":"refunds","row":{"id":"dddddddd-0000-0000-0000-000000000012","reason":"typo fixed"}}]') = 'ok',
   '3 BO: editing a refund''s reason still works');
-- refunds without items: capped only by what is left
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000032', '99999999-0000-0000-0000-000000000003', 'PARTIAL_REFUND', 50, '[]')) = 'ok',
   '3 BO: goodwill refund ₱50 (no items) on the ₱165 sale');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000033', '99999999-0000-0000-0000-000000000003', 'PARTIAL_REFUND', 115.02, '[]')) = 'REFUND_TOO_LARGE',
   '3 BO: 115.02 when 115 is left -> REFUND_TOO_LARGE');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000033', '99999999-0000-0000-0000-000000000003', 'VOID', 115,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000031', 1)), jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18)), 'VOIDED')) = 'ok',
   '3 BO: void of the rest after a partial refund');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000034', '99999999-0000-0000-0000-000000000003', 'PARTIAL_REFUND', 0, '[]', '[]', 'VOIDED')) = 'SALE_NOT_REFUNDABLE',
   '3 BO: refund on a voided sale -> SALE_NOT_REFUNDABLE');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000051', '99999999-0000-0000-0000-000000000005', 'VOID', 150, '[]', '[]', 'HELD')) = 'SALE_NOT_REFUNDABLE',
   '3 BO: refund on a HELD sale -> SALE_NOT_REFUNDABLE');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000061', '99999999-0000-0000-0000-000000000006', 'VOID', 150,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-000000000061', 1)), jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18), test.inv(gen_random_uuid(), :'milk', 180)), 'VOIDED')) = 'ok',
   '3 BO: void of P6');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-000000000062', '99999999-0000-0000-0000-000000000006', 'PARTIAL_REFUND', 0, '[]', '[]', 'VOIDED')) = 'SALE_NOT_REFUNDABLE',
   '3 BO: second refund of a voided sale -> SALE_NOT_REFUNDABLE');
select test.ok(test.bo(jsonb_build_array(jsonb_build_object('op','upsert','table','refunds','row', jsonb_build_object('id','dddddddd-0000-0000-0000-0000000000b1',
   'sale_id','99999999-0000-0000-0000-0000000000b1','type','PARTIAL_REFUND','amount',1)))) = 'FORBIDDEN_ROW',
   '3 BO: refund pointing at another shop''s sale -> FORBIDDEN_ROW (R2, approved 2026-10-19)');
select test.ok(test.bo(jsonb_build_array(jsonb_build_object('op','upsert','table','refunds','row', jsonb_build_object('id','dddddddd-0000-0000-0000-000000000071',
   'sale_id','99999999-0000-0000-0000-000000000007','type','PARTIAL_REFUND','amount',-1)))) = 'BAD_AMOUNT', '3 BO: negative refund -> BAD_AMOUNT');
select test.ok(test.bo(jsonb_build_array(jsonb_build_object('op','insert_ignore','table','refunds','row', jsonb_build_object('id','dddddddd-0000-0000-0000-000000000071',
   'sale_id','99999999-0000-0000-0000-000000000007','type','PARTIAL_REFUND','amount',151)))) = 'REFUND_TOO_LARGE', '3 BO: insert_ignore is checked too');
reset role;
select test.ok((select count(*) from refunds where id in ('dddddddd-0000-0000-0000-000000000031','dddddddd-0000-0000-0000-000000000014','dddddddd-0000-0000-0000-000000000034',
   'dddddddd-0000-0000-0000-000000000051','dddddddd-0000-0000-0000-000000000062','dddddddd-0000-0000-0000-0000000000b1','dddddddd-0000-0000-0000-000000000071')) = 0
   and (select amount from refunds where id = 'dddddddd-0000-0000-0000-000000000012') = 107.36
   and (select quantity from inventory_transactions where id = 'eeeeeeee-0000-0000-0000-000000000121') = 18
   and (select grand_total from sales where id = '99999999-0000-0000-0000-000000000001') = 361.12, '3 BO: refused calls left nothing behind');
select test.ok((select stock from v_ingredient_stock where ingredient_id = :'beans') = 4964   -- 5000 - 180 taken + 144 back
   and (select status from sales where id = '99999999-0000-0000-0000-000000000003') = 'VOIDED', '3: stock and statuses add up');
-- a direct table insert by the owner (RLS allows it) is checked when the save ends
\set ON_ERROR_STOP off
select test.login(:'owner_uid');
set role authenticated;
insert into refunds(id, sale_id, type, amount) values ('dddddddd-0000-0000-0000-000000000072', '99999999-0000-0000-0000-000000000007', 'PARTIAL_REFUND', 500);
reset role;
\set ON_ERROR_STOP on
select test.ok((select count(*) from refunds where id = 'dddddddd-0000-0000-0000-000000000072') = 0, '3: a direct table insert over the cap is refused at commit');

-- ================= 1. a QR order is paid once =================
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select (public.qr_register(:'tok', 'Pia', null, true)->'customer'->>'id') as qcust \gset
select public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]')->'order'->>'id' as qid \gset
reset role;
create or replace function test.qr_sale(p_key text, p_sale uuid, p_qr uuid, p_cust uuid, p_status text default 'COMPLETED') returns text language sql as $$
  select test.res(test.op(p_key, 'sale', test.sale(p_sale, jsonb_build_object('subtotal', 150, 'grand_total', 150, 'source', 'QR', 'status', p_status,
     'qr_order_id', p_qr, 'customer_id', p_cust), jsonb_build_array(test.it(gen_random_uuid(), '33333333-0000-0000-0000-000000000001', 150, 1)))))
$$;
grant execute on function test.qr_sale(text, uuid, uuid, uuid, text) to authenticated;
select test.login(:'d1'); set role authenticated;
select test.ok(test.qr_sale(:'key1', '99999999-0000-0000-0000-0000000000a1', :'qid', :'qcust') = 'ok', '1: QR order paid at counter 1');
select test.ok(public.fo_sync(:'key1', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', 'sale', 'data',
   test.sale('99999999-0000-0000-0000-0000000000a1', jsonb_build_object('subtotal', 150, 'grand_total', 150, 'qr_order_id', :'qid', 'customer_id', :'qcust'),
   jsonb_build_array(test.it(gen_random_uuid(), :'latte', 150, 1))))))->0->>'status' = 'skipped', '1: the SAME sale sent again -> skipped (idempotent)');
reset role;
select test.login(:'d2'); set role authenticated;
select test.ok(test.qr_sale(:'key2', '99999999-0000-0000-0000-0000000000a2', :'qid', :'qcust') = 'QR_ORDER_ALREADY_PAID', '1: a second sale for the same QR order (counter 2) -> QR_ORDER_ALREADY_PAID');
select test.ok(test.qr_sale(:'key2', '99999999-0000-0000-0000-0000000000a3', :'qid', :'qcust', 'HELD') = 'ok', '1: holding a cart for that order is fine ...');
select test.ok(test.qr_sale(:'key2', '99999999-0000-0000-0000-0000000000a3', :'qid', :'qcust') = 'QR_ORDER_ALREADY_PAID', '1: ... but finishing it is refused');
reset role;
select test.ok((select count(*) from sales where qr_order_id = :'qid' and status = 'COMPLETED') = 1
           and (select sale_id from qr_orders where id = :'qid') = '99999999-0000-0000-0000-0000000000a1'
           and (select visit_count = 1 and total_spent = 150 from customers where id = :'qcust'), '1: one paid sale, order points at it, customer counted once');
-- after a void the order may be paid again
select test.login(:'d1'); set role authenticated;
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000a1', '99999999-0000-0000-0000-0000000000a1', 'VOID', 150, '[]', :'manager', :'mgr_login'))) = 'ok', '1: the paying sale is voided');
select test.ok(test.qr_sale(:'key1', '99999999-0000-0000-0000-0000000000a4', :'qid', :'qcust') = 'ok', '1: after a void the order can be paid again');
reset role;
select test.ok((select sale_id from qr_orders where id = :'qid') = '99999999-0000-0000-0000-0000000000a4', '1: order now points at the new sale');
-- another shop's QR order is not linked
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select (public.qr_register(:'tok2', 'Pia B', null, true)->'customer'->>'id') as qcust2 \gset
select public.qr_place_order(:'tok2', '[{"recipe_id":"33333333-0000-0000-0000-0000000000b2","quantity":1}]')->'order'->>'id' as qid2 \gset
reset role;
select test.login(:'d1'); set role authenticated;
select test.ok(test.qr_sale(:'key1', '99999999-0000-0000-0000-0000000000a5', :'qid2', null) = 'ok', '1: a sale naming another shop''s QR order is accepted ...');
reset role;
select test.ok((select qr_order_id is null from sales where id = '99999999-0000-0000-0000-0000000000a5')
           and (select sale_id is null and paid_at is null from qr_orders where id = :'qid2'), '1: ... without linking (or paying) that order');
-- second QR order for the concurrency check (run_fix_checks.sh)
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]')->'order'->>'id' as qid3 \gset
reset role;

-- ================= 6. expired / ended tokens =================
select test.login(:'d1'); set role authenticated;
select (public.staff_pin_login('3333'))->>'token' as mara_login \gset
select (public.staff_pin_login('2222'))->>'token' as mgr_login2 \gset
select (public.staff_pin_login('2222', 'OVERRIDE', 'MANAGER')) as ov_full \gset
reset role;
select test.ok((:'ov_full'::jsonb->>'expires_at')::timestamptz between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute', '6: OVERRIDE token lives 24 hours (late uploads)');
select (:'ov_full'::jsonb->>'token') as ov_expired \gset
update staff_sessions set created_at = now() - interval '17 hours', expires_at = now() - interval '1 hour'
  where token_hash = encode(extensions.digest(:'mara_login', 'sha256'), 'hex');
update staff_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
  where token_hash = encode(extensions.digest(:'ov_expired', 'sha256'), 'hex');
select test.login(:'d1'); set role authenticated;
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-0000000000c1',
   jsonb_build_object('subtotal', 150, 'discount_type', 'fixed', 'discount_value', 10, 'discount_amount', 10, 'grand_total', 140, 'discount_approved_by', :'mara', 'cashier_id', :'mara',
                      'transaction_date', now() - interval '20 hours'),
   jsonb_build_array(test.it(gen_random_uuid(), :'latte', 150, 1)), '[]', jsonb_build_object('discount_approval_token', :'mara_login')))) = 'APPROVAL_INVALID',
   '6: expired LOGIN token -> APPROVAL_INVALID for a discount (even if the sale says it was made before the expiry)');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000007', 'VOID', 150, '[]', :'mara', :'mara_login'))) = 'APPROVAL_INVALID',
   '6: expired LOGIN token -> APPROVAL_INVALID for a void');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000007', 'VOID', 150, '[]', :'manager', :'ov_expired'))) = 'APPROVAL_INVALID',
   '6: expired OVERRIDE token -> APPROVAL_INVALID');
select public.staff_logout(:'mgr_login2');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000007', 'VOID', 150, '[]', :'manager', :'mgr_login2'))) = 'APPROVAL_INVALID',
   '6: LOGIN token ended (signed out) -> APPROVAL_INVALID');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000007', 'VOID', 150, '[]', :'cashier', :'cashier_login'))) = 'ROLE_TOO_LOW',
   '6: a cashier''s LOGIN token can''t approve');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000007', 'VOID', 150, '[]', :'manager', :'cashier_login'))) = 'APPROVAL_INVALID',
   '6: a cashier''s LOGIN token naming the manager -> APPROVAL_INVALID');
reset role;
select test.login(:'d2'); set role authenticated;
select (public.staff_pin_login('2222'))->>'token' as mgr_login_d2 \gset
reset role;
select test.login(:'d1'); set role authenticated;
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000007', 'VOID', 150, '[]', :'manager', :'mgr_login_d2'))) = 'APPROVAL_INVALID',
   '6: the manager''s LOGIN token from ANOTHER counter -> APPROVAL_INVALID');
-- shift close by a manager with their own LOGIN token (closing Cathy's shift)
select (public.staff_pin_login('2222'))->>'token' as mgr_login \gset
select test.ok(test.res(test.op(:'key1', 'shift_open', jsonb_build_object('id','88888888-0000-0000-0000-000000000002','shift_number','SHIFT-A-2026-0002',
  'cashier_id', :'cashier', 'cashier_name','Cathy','opened_at', now(), 'opening_cash', 500))) = 'ok', 'setup: shift 2 (Cathy)');
select test.ok(test.res(test.op(:'key1', 'shift_open', jsonb_build_object('id','88888888-0000-0000-0000-000000000003','shift_number','SHIFT-A-2026-0003',
  'cashier_id', :'cashier', 'cashier_name','Cathy','opened_at', now(), 'opening_cash', 500))) = 'ok', 'setup: shift 3 (Cathy)');
select test.ok(test.res(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000002','closed_at', now(),'declared_cash',500,
  'closed_by', :'mara', 'approval_token', :'mara_login'))) = 'APPROVAL_INVALID', '6: expired LOGIN token can''t close someone else''s shift');
select test.ok(test.res(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000002','closed_at', now(),'declared_cash',500,
  'closed_by', :'manager', 'approval_token', :'mgr_login'))) = 'ok', '6: manager closes Cathy''s shift with their own LOGIN token');
select test.ok(test.res(test.op(:'key1', 'shift_close', jsonb_build_object('id','88888888-0000-0000-0000-000000000003','closed_at', now(),'declared_cash',500,
  'closed_by', :'manager', 'approval_token', :'mgr_login'))) = 'ok', '6: ... and the same LOGIN token closes another one (not used up)');
reset role;
select test.ok((select closed_by_name from shifts where id = '88888888-0000-0000-0000-000000000002') = 'Manny Manager'
           and (select used_at is null from staff_sessions where token_hash = encode(extensions.digest(:'mgr_login', 'sha256'), 'hex')), '6: closer from the staff list; LOGIN token still unused');
-- a PIN change ends the person's sign-ins (and their approvals)
select test.login(:'d1'); set role authenticated;
select (public.staff_pin_login('3333'))->>'token' as mara_login2 \gset
reset role;
select test.login(:'owner_uid'); set role authenticated;
select test.ok((public.staff_set_pin(:'mara', '343434')->>'ok')::boolean, 'setup: owner gives Mara a new PIN');
reset role;
select test.login(:'d1'); set role authenticated;
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000007', 'VOID', 150, '[]', :'mara', :'mara_login2'))) = 'APPROVAL_INVALID',
   '6: LOGIN token ended by a PIN change -> APPROVAL_INVALID');
reset role;

-- ================= 5. a PIN that matches two staff members =================
select test.login(:'owner_uid'); set role authenticated;
select public.apply_changes('[{"op":"upsert","table":"staff","row":{"id":"66666666-0000-0000-0000-000000000009","name":"Lia Legacy","role":"CASHIER","local_id":"user_lia"}},
                              {"op":"upsert","table":"staff","row":{"id":"66666666-0000-0000-0000-000000000010","name":"Old Timer","role":"CASHIER","local_id":"user_old"}}]');
select public.staff_import_legacy_pin('66666666-0000-0000-0000-000000000009', encode(extensions.digest('coffeepos:1111', 'sha256'), 'hex'));  -- same as Cathy's PIN
select public.staff_import_legacy_pin('66666666-0000-0000-0000-000000000010', encode(extensions.digest('coffeepos:4321', 'sha256'), 'hex'));  -- unique
reset role;
delete from auth_attempts;
select count(*) as sessions_before from staff_sessions \gset
select test.login(:'d1'); set role authenticated;
select test.ok(public.staff_pin_login('1111') = '{"error":"PIN_AMBIGUOUS"}'::jsonb, '5: PIN shared by Cathy and an imported old PIN -> PIN_AMBIGUOUS, nobody named');
select test.ok(public.staff_pin_login('1111', 'OVERRIDE', 'MANAGER')->>'error' = 'PIN_AMBIGUOUS', '5: same for an approval');
select public.staff_pin_login('1111'); select public.staff_pin_login('1111'); select public.staff_pin_login('1111');
select test.ok(public.staff_pin_login('1111')->>'error' = 'TOO_MANY_ATTEMPTS', '5: PIN_AMBIGUOUS counts as a wrong PIN (5th one locks the counter)');
reset role; delete from auth_attempts; select test.login(:'d1'); set role authenticated;
select test.ok((public.staff_pin_login('4321')->'staff'->>'name') = 'Old Timer', '5: a unique old PIN still signs in (and is upgraded)');
reset role;
select test.ok((select pin_hash is null and legacy_sha256 is not null from staff_pins where staff_id = '66666666-0000-0000-0000-000000000009'), '5: the ambiguous old PIN was NOT upgraded');
select test.ok((select pin_hash like '$2%' and legacy_sha256 is null from staff_pins where staff_id = '66666666-0000-0000-0000-000000000010'), '5: the unique old PIN was upgraded to bcrypt');
select test.ok((select count(*) from staff_sessions) = :sessions_before + 1, '5: no sign-in made for the ambiguous PIN');
-- two current (bcrypt) PINs the same (only possible by hand, but must not pick one)
insert into staff_pins(staff_id, pin_hash) values ('66666666-0000-0000-0000-000000000004', extensions.crypt('2222', extensions.gen_salt('bf', 4))) on conflict (staff_id) do update set pin_hash = excluded.pin_hash;
select test.login(:'d1'); set role authenticated;
select test.ok(public.staff_pin_login('2222')->>'error' = 'PIN_AMBIGUOUS', '5: two bcrypt PINs the same -> PIN_AMBIGUOUS');
reset role;
update staff set active = false where id = '66666666-0000-0000-0000-000000000004';
select test.login(:'d1'); set role authenticated;
select test.ok((public.staff_pin_login('2222')->'staff'->>'name') = 'Manny Manager', '5: a switched-off staff member''s PIN does not count');
reset role;
-- the owner's fix: give one of them a new PIN
select test.login(:'owner_uid'); set role authenticated;
select test.ok(public.staff_set_pin('66666666-0000-0000-0000-000000000009', '1111')->>'error' = 'PIN_IN_USE', '5: owner can''t give the shared PIN again');
select test.ok((public.staff_set_pin('66666666-0000-0000-0000-000000000009', '5555')->>'ok')::boolean, '5: owner gives Lia a new PIN');
reset role;
select test.login(:'d1'); set role authenticated;
select test.ok((public.staff_pin_login('1111')->'staff'->>'name') = 'Cathy Cashier' and (public.staff_pin_login('5555')->'staff'->>'name') = 'Lia Legacy', '5: both sign in again');
reset role;

-- ================= round 2 / 4: a sign-in token approves only its OWN staff member's actions =================
select test.login(:'d1'); set role authenticated; select (public.staff_pin_login('2222'))->>'token' as mgr_login \gset
reset role;
select test.login(:'d1'); set role authenticated;
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-0000000000d1',
   jsonb_build_object('subtotal', 150, 'discount_type', 'fixed', 'discount_value', 10, 'discount_amount', 10, 'grand_total', 140, 'discount_approved_by', :'manager'),
   jsonb_build_array(test.it(gen_random_uuid(), :'latte', 150, 1)), '[]', jsonb_build_object('discount_approval_token', :'mgr_login')))) = 'APPROVAL_INVALID',
   'own: the manager''s sign-in token can''t approve a discount on CATHY''s sale');
select (public.staff_pin_login('2222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_own1 \gset
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-0000000000d1',
   jsonb_build_object('subtotal', 150, 'discount_type', 'fixed', 'discount_value', 10, 'discount_amount', 10, 'grand_total', 140, 'discount_approved_by', :'manager'),
   jsonb_build_array(test.it('aaaaaaaa-0000-0000-0000-0000000000d1', :'latte', 150, 1)),
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18)), jsonb_build_object('discount_approval_token', :'ov_own1')))) = 'ok',
   'own: ... the manager''s typed PIN (OVERRIDE) can');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000d1', 'VOID', 140, '[]', :'manager', :'mgr_login')
   #- '{refund,performed_by}')) = 'APPROVAL_INVALID', 'own: sign-in token refund that doesn''t say who does it -> APPROVAL_INVALID');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000d1', 'VOID', 140, '[]', :'manager', :'mgr_login',
   p_performer => :'cashier'))) = 'APPROVAL_INVALID', 'own: sign-in token refund done by Cathy -> APPROVAL_INVALID');
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000d1', 'VOID', 140, '[]', :'manager', :'ov_own1',
   p_performer => :'cashier'))) = 'APPROVAL_INVALID', 'own: (the OVERRIDE token used for the discount is spent)');
select (public.staff_pin_login('2222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_own2 \gset
select test.ok(test.res(test.op(:'key1', 'refund', test.refund('dddddddd-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000d1', 'VOID', 140, '[]', :'manager', :'ov_own2',
   p_performer => '66666666-0000-0000-0000-00000000dead'))) = 'UNKNOWN_STAFF', 'own: a performer who is not our staff -> UNKNOWN_STAFF');
select test.ok(test.res(test.op(:'key1', 'refund', jsonb_set(test.refund('dddddddd-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000d1', 'VOID', 140, '[]', :'manager', :'ov_own2',
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18)), p_performer => :'cashier'), '{refund,performed_by_name}', '"Fake"'))) = 'ok',
   'own: Cathy voids with the manager''s typed PIN -> ok');
reset role;
select test.ok((select performed_by = :'cashier'::uuid and performed_by_name = 'Cathy Cashier' and approved_by_name = 'Manny Manager'
                from refunds where id = 'dddddddd-0000-0000-0000-0000000000d1'), 'own: who did it and who approved it are stored (names from the staff list)');

-- ================= round 2 / 3: a finished sale's money is locked =================
select test.login(:'owner_uid'); set role authenticated;
select test.ok(test.bo('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000007","grand_total":999}}]') = 'SALE_LOCKED', 'lock: owner can''t change a finished sale''s total');
select test.ok(test.bo('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000007","discount_amount":10,"discount_type":"fixed","discount_value":10}}]') = 'SALE_LOCKED', 'lock: ... or its discount');
select test.ok(test.bo('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000007","status":"HELD"}}]') = 'SALE_LOCKED', 'lock: ... or turn it back into a held sale');
select test.ok(test.bo('[{"op":"upsert","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000007","subtotal":150,"grand_total":150,"status":"COMPLETED","notes":"same money"}}]') = 'ok',
   'lock: saving the same money again is fine');
select test.ok(test.bo('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000007","needs_review":true,"review_reason":"x","notes":"checked"}}]') = 'ok'
           and test.bo('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000007","needs_review":false}}]') = 'ok', 'lock: needs-review tick and notes still work');
select test.ok(test.bo('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000005","subtotal":300,"grand_total":300}}]') = 'ok', 'lock: a HELD sale can still change');
reset role;
select test.login(:'d1'); set role authenticated;
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000005', '{"subtotal":150,"grand_total":150}',
   jsonb_build_array(test.it(gen_random_uuid(), :'latte', 150, 1))))) = 'ok', 'lock: the counter finishes the held sale with its final money');
reset role;
select test.ok((select status = 'COMPLETED' and grand_total = 150 from sales where id = '99999999-0000-0000-0000-000000000005'), 'lock: held sale finished at ₱150');
select test.ok(test.err($$update public.sales set grand_total = 1 where id = '99999999-0000-0000-0000-000000000007'$$) = 'SALE_LOCKED', 'lock: also from the SQL editor');
select test.ok((select grand_total from sales where id = '99999999-0000-0000-0000-000000000007') = 150, 'lock: P7 still ₱150');

-- ================= round 2 / 2: refunds imported from the old app =================
select test.login(:'d1'); set role authenticated;
select (public.staff_pin_login('2222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_imp \gset
select test.ok(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-0000000000e1',
   jsonb_build_object('subtotal', 370, 'discount_type', 'percent', 'discount_value', 20, 'discount_amount', 74, 'tax_amount', 35.52,
                      'service_charge_amount', 29.60, 'grand_total', 361.12, 'discount_approved_by', :'manager'),
   jsonb_build_array(test.it('aaaaaaaa-0000-0000-0000-0000000000e1', :'latte', 150, 1), test.it('aaaaaaaa-0000-0000-0000-0000000000e2', :'amer', 110, 2)),
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 54), test.inv(gen_random_uuid(), :'milk', 180)),
   jsonb_build_object('discount_approval_token', :'ov_imp')))) = 'ok', 'setup: discounted sale PE (G 361.12)');
select (public.staff_pin_login('2222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_imp2 \gset
select test.ok(test.res(test.op(:'key1', 'refund', jsonb_set(test.refund('dddddddd-0000-0000-0000-0000000000e0', '99999999-0000-0000-0000-0000000000e1', 'PARTIAL_REFUND', 110,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-0000000000e2', 1)), :'manager', :'ov_imp2', p_performer => :'cashier'),
   '{refund,imported_at}', '"2026-01-01T00:00:00Z"'))) = 'REFUND_TOO_LARGE',
   'import: a counter can''t mark its refund as old-app history (imported_at ignored -> per-item rule applies)');
reset role;
select test.ok((select count(*) from refunds where imported_at is not null) = 0, 'import: nothing marked imported by the counter');
create or replace function test.imp(p jsonb) returns jsonb language sql as $$
  select jsonb_set(p, '{0,row}', (p->0->'row') || '{"imported_at":"2026-10-12T00:00:00Z"}'::jsonb)
$$;
grant execute on function test.imp(jsonb) to authenticated;
select test.login(:'owner_uid'); set role authenticated;
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-0000000000e1', '99999999-0000-0000-0000-0000000000e1', 'PARTIAL_REFUND', 110,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-0000000000e2', 1)))) = 'REFUND_TOO_LARGE', 'import: (control) owner refund of one Americano at line price is refused ...');
select test.ok(test.bo(test.imp(test.bo_refund('dddddddd-0000-0000-0000-0000000000e1', '99999999-0000-0000-0000-0000000000e1', 'PARTIAL_REFUND', 110,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-0000000000e2', 1)), jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 18))))) = 'ok',
   'import: ... but accepted as imported old-app history (money already handed back)');
select test.ok(test.bo(test.imp(test.bo_refund('dddddddd-0000-0000-0000-0000000000e2', '99999999-0000-0000-0000-0000000000e1', 'PARTIAL_REFUND', 251.14, '[]'))) = 'REFUND_TOO_LARGE',
   'import: imported refunds still can''t exceed the sale (251.14 when 251.12 is left)');
select test.ok(test.bo(test.imp(test.bo_refund('dddddddd-0000-0000-0000-0000000000e2', '99999999-0000-0000-0000-0000000000e1', 'PARTIAL_REFUND', 1, '[]',
   jsonb_build_array(test.inv(gen_random_uuid(), :'beans', 37))))) = 'RETURN_TOO_LARGE', 'import: ... nor put back more stock than the sale took (18 + 37 > 54 g)');
select test.ok(test.bo(test.bo_refund('dddddddd-0000-0000-0000-0000000000e3', '99999999-0000-0000-0000-0000000000e1', 'PARTIAL_REFUND', 107.36,
   jsonb_build_array(test.ri('aaaaaaaa-0000-0000-0000-0000000000e2', 1)))) = 'ok', 'import: a normal refund afterwards counts the imported one (last Americano, 107.36)');
reset role;
select test.ok((select imported_at is not null from refunds where id = 'dddddddd-0000-0000-0000-0000000000e1')
           and (select count(*) from refunds where sale_id = '99999999-0000-0000-0000-0000000000e1') = 2, 'import: stored with imported_at');

-- ================= round 2 / 1: centavo rounding matches refundAmountForItems =================
insert into sales(id, business_id, status, subtotal, grand_total) values ('99999999-0000-0000-0000-0000000000f9', :'biz', 'COMPLETED', 2.0000000000000004, 1.0000000000000002);
insert into sale_items(id, business_id, sale_id, name, quantity, unit_price, line_total) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', :'biz', '99999999-0000-0000-0000-0000000000f9', 'cent', 1, 0.01, 0.01),
  ('aaaaaaaa-0000-0000-0000-0000000000f2', :'biz', '99999999-0000-0000-0000-0000000000f9', 'rest', 1, 1.99, 1.99);
select test.ok(public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"aaaaaaaa-0000-0000-0000-0000000000f1","quantity":1}]', 1) = 0.01,
   'round: S 2.0000000000000004 counts as 2.00 (0.01 x 1 / 2 = 0.005 -> 0.01, like the counter)')
from sales s where s.id = '99999999-0000-0000-0000-0000000000f9';

-- ================= 2. a refused pairing leaves nothing behind =================
select test.login('00000000-0000-0000-0000-0000000000f9'); set role authenticated;
select test.ok(public.redeem_device_pairing('PAIRB2', :'key1', 'Moved tablet')->>'error' = 'DEVICE_KEY_TAKEN', '2: pairing with another shop''s counter key -> DEVICE_KEY_TAKEN');
select test.ok(public.current_business_id() is null and (select count(*) from staff) = 0, '2: the login is not a member and reads nothing');
reset role;
select test.ok((select count(*) from profiles where id = '00000000-0000-0000-0000-0000000000f9') = 0
           and (select count(*) from devices where auth_user_id = '00000000-0000-0000-0000-0000000000f9') = 0
           and (select used_at is null from device_pairing_codes where code = 'PAIRB2')
           and (select auth_user_id = :'d1'::uuid and active from devices where device_key = :'key1'), '2: no profile, no counter row, code unused, shop A''s counter untouched');
select test.ok((select count(*) from auth_attempts where subject = '00000000-0000-0000-0000-0000000000f9' and kind = 'PAIR' and not success) = 1, '2: counted as a failed pairing (rate limit)');
select test.login('00000000-0000-0000-0000-0000000000f9'); set role authenticated;
select test.ok(public.redeem_device_pairing('PAIRB2', 'device-key-00f9-abcdef', 'Other tablet')->'device' is not null, '2: the same code still pairs with the tablet''s own key');
reset role;
-- re-pairing a counter (same key) with a new login: the old login loses access
select test.login('00000000-0000-0000-0000-0000000000e1'); set role authenticated;
select test.ok((public.redeem_device_pairing('PAIRA3', :'key1', 'Front again')->'device'->>'device_tag') = 'A', '2: counter A re-paired with a new login (same key, same tag)');
reset role;
select test.ok((select count(*) from profiles where id = :'d1') = 0 and (select count(*) from staff_sessions where device_user_id = :'d1') = 0,
   '2: the counter''s old login has no shop membership and no staff sign-ins left');
select test.login(:'d1'); set role authenticated;
select test.ok((select count(*) from sales) = 0 and test.err($$select public.fo_sync('device-key-0001-abcdef', '[]'::jsonb)$$) <> 'NO ERROR', '2: old login reads nothing, can''t upload');
reset role;
-- one login = one counter
select test.login('00000000-0000-0000-0000-0000000000e2'); set role authenticated;
select test.ok(public.redeem_device_pairing('PAIRA4', 'device-key-00e2-first1', 'Tab 1')->'device' is not null, '2: login e2 pairs as one counter ...');
select test.ok(public.redeem_device_pairing('PAIRA5', 'device-key-00e2-second', 'Tab 2')->'device' is not null, '2: ... then with a new key');
reset role;
select test.ok((select auth_user_id is null and not active from devices where device_key = 'device-key-00e2-first1')
           and (select auth_user_id = '00000000-0000-0000-0000-0000000000e2'::uuid and active from devices where device_key = 'device-key-00e2-second'),
   '2: the earlier counter row of that login is switched off');

select 'ALL FIX CHECKS PASSED';
