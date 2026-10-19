-- Checks for the security fix round of 2026-10-19 (F1 F2 F4/decision 8 F5 F6 F7 F8 F9 F10 F11 F13 + qr_cancel_order).
-- Adopted into the QA regression (tests/run_all.sh) on 2026-10-19 from the database engineer's round-3 checks.
-- Needs a FRESH database:  tests/reset_db.sh "" db_sec && psql ... -d db_sec -f this file
-- Prints "ok  ..." / "FAIL ..." for every check and keeps going.
\set QUIET on
create schema if not exists test;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
end $$;
create or replace function test.chk(cond boolean, msg text, got text default null) returns text language sql as $$
  select case when coalesce(cond, false) then 'ok  ' || msg else 'FAIL ' || msg || coalesce('   [got: ' || got || ']', '') end
$$;
create or replace function test.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'NO ERROR'; exception when others then return sqlerrm; end $$;
create or replace function test.op(p_key text, p_type text, p_data jsonb) returns jsonb language sql as $$
  select public.fo_sync(p_key, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', p_type, 'data', p_data)))->0
$$;
create or replace function test.res(p jsonb) returns text language sql as $$
  select case when p->>'status' = 'error' then p->>'message' else p->>'status' end
$$;
-- a finished ₱p_sub sale of one Iced Latte; p_fields / p_pay override sale fields / the payment
create or replace function test.sale(p_sale uuid, p_cashier uuid, p_fields jsonb default '{}', p_pay jsonb default null) returns jsonb language sql as $$
  select jsonb_build_object(
    'sale', jsonb_build_object('id', p_sale, 'transaction_number', 'POS-A-2026-' || left(p_sale::text, 8), 'transaction_date', now(),
       'status', 'COMPLETED', 'cashier_id', p_cashier, 'cashier_name', 'X', 'shift_id', '88888888-0000-0000-0000-000000000001',
       'subtotal', 150, 'discount_amount', 0, 'tax_amount', 0, 'service_charge_amount', 0, 'grand_total', 150) || p_fields,
    'items', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'recipe_id', '33333333-0000-0000-0000-000000000001', 'name', 'Iced Latte',
       'quantity', 1, 'unit_price', 150, 'line_total', 150, 'modifiers', '[]'::jsonb)),
    'payment', coalesce(p_pay, jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', coalesce((p_fields->>'grand_total')::numeric, 150), 'status', 'CONFIRMED')),
    'inventory', '[]'::jsonb)
$$;
grant usage on schema test to anon, authenticated; grant execute on all functions in schema test to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

\set cashier '66666666-0000-0000-0000-000000000001'
\set manager '66666666-0000-0000-0000-000000000002'
\set owner_uid '00000000-0000-0000-0000-0000000000a1'
\set d1 '00000000-0000-0000-0000-0000000000d1'
\set d2 '00000000-0000-0000-0000-0000000000d2'
\set key1 'device-key-0001-abcdef'
\set key2 'device-key-0002-abcdef'
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000b1', 'other@example.com', '{"business_name":"Other Shop","admin_name":"Olga"}');
insert into auth.users (id, is_anonymous) select x::uuid, true from unnest(array[:'d1', :'d2']) x;
insert into auth.users (id, is_anonymous) select ('00000000-0000-0000-0000-0000000c' || lpad(g::text, 4, '0'))::uuid, true from generate_series(1, 80) g;   -- QR phones
select business_id as biz from profiles where id = :'owner_uid' \gset
select business_id as biz2 from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset
select id as owner_staff from staff where profile_id = :'owner_uid' \gset
do $$
declare v_biz uuid; v_biz2 uuid;
begin
  select business_id into v_biz from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';
  select business_id into v_biz2 from public.profiles where id = '00000000-0000-0000-0000-0000000000b1';
  insert into public.recipes(id, business_id, name, recipe_type, selling_price) values
    ('33333333-0000-0000-0000-000000000001', v_biz, 'Iced Latte', 'DRINKS', 150);
  insert into public.suppliers(business_id, name) values (v_biz, 'Bean Co');
  insert into public.ingredients(id, business_id, name, base_unit) values ('22222222-0000-0000-0000-000000000001', v_biz, 'Beans', 'g');
  insert into public.purchases(business_id, ingredient_id, purchase_date) values (v_biz, '22222222-0000-0000-0000-000000000001', '2026-10-01');
  insert into public.waste(business_id, ingredient_id, quantity) values (v_biz, '22222222-0000-0000-0000-000000000001', 1);
  insert into public.production_batches(business_id) values (v_biz);
  insert into public.audit_log(business_id, action) values (v_biz, 'seed');
  insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) values (v_biz, '22222222-0000-0000-0000-000000000001', 'INITIAL_STOCK', 100, '2026-10-01');
  insert into public.staff(id, business_id, name, role) values
    ('66666666-0000-0000-0000-000000000001', v_biz, 'Cathy Cashier', 'CASHIER'),
    ('66666666-0000-0000-0000-000000000002', v_biz, 'Manny Manager', 'MANAGER'),
    ('66666666-0000-0000-0000-000000000003', v_biz, 'Mara Manager', 'MANAGER'),   -- old 4-digit PIN, length unknown
    ('66666666-0000-0000-0000-000000000004', v_biz, 'Carl Cashier', 'CASHIER');
  insert into public.staff_pins(staff_id, pin_hash) values
    ('66666666-0000-0000-0000-000000000003', extensions.crypt('3333', extensions.gen_salt('bf', 4)));
  insert into public.device_pairing_codes(code, business_id, device_name, expires_at) values
    ('PAIRA1', v_biz, 'Front', now() + interval '1 hour'), ('PAIRA2', v_biz, 'Back bar', now() + interval '1 hour');
  insert into public.dining_tables(id, business_id, label, kind, qr_token) values ('77777777-0000-0000-0000-000000000001', v_biz, 'Table 1', 'DINE_IN', 'tok-t1'),
    ('77777777-0000-0000-0000-000000000002', v_biz, 'Table 2', 'DINE_IN', 'tok-t2');
  insert into public.sales(id, business_id, status, grand_total) values ('99999999-0000-0000-0000-0000000000b1', v_biz2, 'COMPLETED', 50);
  insert into public.categories(id, business_id, name) values ('11111111-0000-0000-0000-0000000000b1', v_biz2, 'Other cat');
end $$;
select test.login(:'d1'); set role authenticated;
select test.chk(public.redeem_device_pairing('PAIRA1', :'key1', 'Front')->'device' is not null, 'setup: d1 paired'); reset role;
select test.login(:'d2'); set role authenticated;
select test.chk(public.redeem_device_pairing('PAIRA2', :'key2', 'Back bar')->'device' is not null, 'setup: d2 paired'); reset role;

-- ================= F1: old profiles.pin_hash =================
select test.chk((select count(*) from profiles where pin_hash is not null) = 0, 'F1: profiles.pin_hash is empty after the install');
update profiles set pin_hash = 'deadbeef' where id = :'owner_uid';
select test.chk((select pin_hash is null from profiles where id = :'owner_uid'), 'F1: writing profiles.pin_hash keeps it empty (trigger)');
select test.login(:'d1'); set role authenticated;
select test.chk((select count(*) from profiles) = 1 and (select count(*) from profiles where id = :'d1') = 1, 'F1/F9: a counter reads only its own profile row', (select count(*) from profiles)::text);
reset role;

-- ================= decision 8 / F4: 6-digit manager PINs =================
select test.login(:'owner_uid'); set role authenticated;
select test.chk(public.staff_set_pin(:'manager', '2222')->>'error' = 'PIN_TOO_SHORT', 'D8: 4-digit manager PIN -> PIN_TOO_SHORT');
select test.chk(public.staff_set_pin(:'manager', '22222')->>'error' = 'PIN_TOO_SHORT', 'D8: 5-digit manager PIN -> PIN_TOO_SHORT');
select test.chk(public.staff_set_pin(:'owner_staff', '9999')->>'error' = 'PIN_TOO_SHORT', 'D8: 4-digit owner (ADMIN) PIN -> PIN_TOO_SHORT');
select test.chk(public.staff_set_pin(:'manager', '22a222')->>'error' = 'PIN_FORMAT', 'D8: not digits -> PIN_FORMAT');
select test.chk((public.staff_set_pin(:'manager', '222222')->>'ok')::boolean, 'D8: 6-digit manager PIN accepted');
select test.chk((public.staff_set_pin(:'owner_staff', '999999')->>'ok')::boolean, 'D8: 6-digit owner PIN accepted');
select test.chk((public.staff_set_pin(:'cashier', '1111')->>'ok')::boolean, 'D8: 4-digit cashier PIN still fine');
select test.chk((public.staff_set_pin('66666666-0000-0000-0000-000000000004', '44444')->>'ok')::boolean, 'D8: 5-digit cashier PIN still fine');
select public.apply_changes('[{"op":"upsert","table":"staff","row":{"id":"66666666-0000-0000-0000-000000000005","name":"Leo Legacy","role":"MANAGER"}},
                              {"op":"upsert","table":"staff","row":{"id":"66666666-0000-0000-0000-000000000006","name":"Sam Six","role":"MANAGER"}},
                              {"op":"upsert","table":"staff","row":{"id":"66666666-0000-0000-0000-000000000007","name":"Cora Cashier","role":"CASHIER"}}]');
select test.chk(test.err(format('select public.staff_import_legacy_pin(%L, %L)', '66666666-0000-0000-0000-000000000005', encode(extensions.digest('coffeepos:0123', 'sha256'), 'hex'))) = 'PIN_TOO_SHORT',
  'D8: importing a 4-digit old-app PIN for a MANAGER -> PIN_TOO_SHORT (leading zero kept)');
select test.chk(test.err(format('select public.staff_import_legacy_pin(%L, %L)', '66666666-0000-0000-0000-000000000005', encode(extensions.digest('coffeepos:01234', 'sha256'), 'hex'))) = 'PIN_TOO_SHORT',
  'D8: ... and a 5-digit one');
select test.chk(test.err(format('select public.staff_import_legacy_pin(%L, %L)', '66666666-0000-0000-0000-000000000006', encode(extensions.digest('coffeepos:654321', 'sha256'), 'hex'))) = 'NO ERROR',
  'D8: a 6-digit old-app PIN for a MANAGER is imported');
select test.chk(test.err(format('select public.staff_import_legacy_pin(%L, %L)', '66666666-0000-0000-0000-000000000007', encode(extensions.digest('coffeepos:7777', 'sha256'), 'hex'))) = 'NO ERROR',
  'D8: a 4-digit old-app PIN for a cashier is imported');
reset role;
select test.chk((select pin_length from staff_pins where staff_id = :'manager') = 6 and (select pin_length from staff_pins where staff_id = '66666666-0000-0000-0000-000000000006') = 6
           and (select pin_length from staff_pins where staff_id = '66666666-0000-0000-0000-000000000007') = 4 and (select pin_length from staff_pins where staff_id = '66666666-0000-0000-0000-000000000004') = 5
           and (select pin_length is null from staff_pins where staff_id = '66666666-0000-0000-0000-000000000003'), 'D8: pin_length recorded (null = unknown for old rows)');
select test.chk((select count(*) from staff_pins where staff_id = '66666666-0000-0000-0000-000000000005') = 0, 'D8: the refused import stored nothing');
-- role change: Carl (5-digit PIN) becomes MANAGER -> kept, but needs a new PIN
select test.login(:'owner_uid'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"staff","row":{"id":"66666666-0000-0000-0000-000000000004","role":"MANAGER"}}]')$$) = 'NO ERROR', 'D8: role change to MANAGER with a 5-digit PIN is kept');
select public.bo_bootstrap() as bo \gset
select test.chk((:'bo'::jsonb->'pin_update_needed') @> jsonb_build_array('66666666-0000-0000-0000-000000000004', '66666666-0000-0000-0000-000000000003')
           and jsonb_array_length(:'bo'::jsonb->'pin_update_needed') = 2, 'D8: bo_bootstrap.pin_update_needed = Carl (5 digits) + Mara (unknown length)', :'bo'::jsonb->>'pin_update_needed');
select test.chk((select bool_and(((s->>'pin_update_needed')::boolean) = (s->>'id' in ('66666666-0000-0000-0000-000000000004','66666666-0000-0000-0000-000000000003')))
                 from jsonb_array_elements(:'bo'::jsonb->'staff') s), 'D8: staff rows carry pin_update_needed');
reset role;
select test.chk((select role from staff where id = '66666666-0000-0000-0000-000000000004') = 'MANAGER', 'D8: role really changed');
select test.login(:'d1'); set role authenticated;
select test.chk((public.staff_pin_login('3333')->'staff'->>'name') = 'Mara Manager', 'D8: an existing short manager PIN still signs in (no lock-out on day one)');
select test.chk((public.staff_pin_login('44444', 'OVERRIDE', 'MANAGER')->'staff'->>'name') = 'Carl Cashier', 'D8: ... and still approves');
select test.chk(public.bo_bootstrap()->'pin_update_needed' = '[]'::jsonb and public.bo_bootstrap()->'pin_lockouts' = '[]'::jsonb, 'D8: a counter gets no pin_update_needed / pin_lockouts');
reset role;
select test.chk((select pin_length from staff_pins where staff_id = '66666666-0000-0000-0000-000000000003') = 4, 'D8: the sign-in filled in Mara''s unknown PIN length (4)');

-- ================= F2: a new sign-in ends the counter's earlier sign-ins =================
delete from auth_attempts;
select test.login(:'d2'); set role authenticated;
select (public.staff_pin_login('1111'))->>'token' as d2_cathy \gset
reset role;
select test.login(:'d1'); set role authenticated;
select (public.staff_pin_login('1111'))->>'token' as l_cathy \gset
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_m \gset
select (public.staff_pin_login('222222'))->>'token' as l_manny \gset
reset role;
create or replace function test.sess(p text) returns public.staff_sessions language sql as $$
  select * from public.staff_sessions where token_hash = encode(extensions.digest(p, 'sha256'), 'hex') $$;
select test.chk((test.sess(:'l_cathy')).revoked_at is not null, 'F2: Manny signing in ended Cathy''s earlier sign-in on the same counter');
select test.chk((test.sess(:'l_manny')).revoked_at is null, 'F2: Manny''s new sign-in is active');
select test.chk((test.sess(:'ov_m')).revoked_at is null, 'F2: OVERRIDE approvals are not touched');
select test.chk((test.sess(:'d2_cathy')).revoked_at is null, 'F2: another counter''s sign-in is not touched');
select test.chk((select count(*) from staff_sessions where device_user_id = :'d1' and purpose = 'LOGIN' and revoked_at is null) = 1, 'F2: one active sign-in per counter');
select test.login(:'d1'); set role authenticated;
select test.chk(test.res(test.op(:'key1', 'shift_open', jsonb_build_object('id','88888888-0000-0000-0000-000000000001','shift_number','SHIFT-A-2026-0001',
  'cashier_id', :'manager', 'cashier_name','Manny','opened_at', now(), 'opening_cash', 1000))) = 'ok', 'setup: shift opened');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000001', :'manager', '{"subtotal":150,"discount_type":"fixed","discount_value":10,"discount_amount":10,"grand_total":140}'::jsonb
   || jsonb_build_object('discount_approved_by', :'cashier'))
   || jsonb_build_object('discount_approval_token', :'l_cathy'))) = 'ROLE_TOO_LOW', 'F2: (control) cashier can''t approve');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000001', :'manager', '{"subtotal":150,"discount_type":"fixed","discount_value":10,"discount_amount":10,"grand_total":140}'::jsonb
   || jsonb_build_object('discount_approved_by', :'manager'))
   || jsonb_build_object('discount_approval_token', :'l_manny'))) = 'ok', 'F2: the current manager sign-in still approves own discount');
reset role;

-- ================= F6 F7 F8: review flags =================
select test.chk((select not needs_review and review_reason is null and signed_in_staff_id = :'manager'::uuid from sales where id = '99999999-0000-0000-0000-000000000001'),
  'F8: a sale by the signed-in person is not flagged; signed_in_staff_id stored', (select coalesce(review_reason, '-') from sales where id = '99999999-0000-0000-0000-000000000001'));
update settings set tax_pct = 12, service_charge_pct = 10, tax_inclusive = false where business_id = :'biz';
select test.login(:'d1'); set role authenticated;
-- 150: tax 18, service 15, total 183
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000002', :'manager', '{"tax_amount":18,"service_charge_amount":15,"grand_total":183}')))
   = 'ok', 'F6: correct 12% tax + 10% service');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000003', :'manager', '{"tax_amount":0,"service_charge_amount":15,"grand_total":165}'))) = 'ok', 'F6: sale without the 12% tax accepted ...');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000004', :'manager', '{"tax_amount":18.03,"service_charge_amount":15,"grand_total":183.03}'))) = 'ok', 'F6: tax 3 centavos off accepted ...');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000005', :'manager', '{"tax_amount":18.02,"service_charge_amount":14.99,"grand_total":183.01}'))) = 'ok', 'F6: within 2 centavos');
-- payments
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000006', :'manager', '{"tax_amount":18,"service_charge_amount":15,"grand_total":183}',
   '{"method":"GCASH","amount":150,"status":"CONFIRMED"}'))) = 'ok', 'F7: GCash payment below the total accepted ...');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000007', :'manager', '{"tax_amount":18,"service_charge_amount":15,"grand_total":183}',
   '{"method":"CASH","amount":183,"tendered":200,"change":17,"status":"CONFIRMED"}'))) = 'ok', 'F7: cash 200 for 183, change 17');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000008', :'manager', '{"tax_amount":18,"service_charge_amount":15,"grand_total":183}',
   '{"method":"CASH","amount":200,"status":"CONFIRMED"}'))) = 'ok', 'F7: cash amount above the total (no change recorded)');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000009', :'manager', '{"tax_amount":18,"service_charge_amount":15,"grand_total":183}',
   '{"method":"CASH","amount":183,"tendered":200,"change":50,"status":"CONFIRMED"}'))) = 'ok', 'F7: cash with too much change accepted ...');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000010', :'manager', '{"tax_amount":18,"service_charge_amount":15,"grand_total":183}',
   '{"method":"CARD","amount":250,"status":"CONFIRMED"}'))) = 'ok', 'F7: card charged above the total accepted ...');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000011', :'manager', '{"tax_amount":18,"service_charge_amount":15,"grand_total":183}') - 'payment')) = 'ok', 'F7: no payment at all accepted ...');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000012', :'cashier', '{"tax_amount":18,"service_charge_amount":15,"grand_total":183}'))) = 'ok', 'F8: Cathy''s sale while Manny is signed in accepted ...');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000013', :'cashier', '{"tax_amount":0,"service_charge_amount":0,"grand_total":100,"subtotal":150}'
   ) || '{"items":[{"recipe_id":"33333333-0000-0000-0000-000000000001","name":"x","quantity":1,"unit_price":100,"line_total":100}]}'::jsonb
   || jsonb_build_object('payment', jsonb_build_object('method','GCASH','amount',50)))) = 'SALE_TOTALS_MISMATCH', '(control) totals still refused');
reset role;
create or replace function test.reason(p uuid) returns text language sql as $$ select coalesce(review_reason, '-') from public.sales where id = p $$;
select test.chk(test.reason('99999999-0000-0000-0000-000000000002') = '-', 'F6: correct tax not flagged', test.reason('99999999-0000-0000-0000-000000000002'));
select test.chk(test.reason('99999999-0000-0000-0000-000000000003') = 'TAX_MISMATCH', 'F6: ... missing tax flagged TAX_MISMATCH', test.reason('99999999-0000-0000-0000-000000000003'));
select test.chk(test.reason('99999999-0000-0000-0000-000000000004') = 'TAX_MISMATCH', 'F6: ... 3 centavos off flagged', test.reason('99999999-0000-0000-0000-000000000004'));
select test.chk(test.reason('99999999-0000-0000-0000-000000000005') = '-', 'F6: 2 centavos not flagged', test.reason('99999999-0000-0000-0000-000000000005'));
select test.chk(test.reason('99999999-0000-0000-0000-000000000006') = 'PAYMENT_MISMATCH', 'F7: ... underpaid flagged PAYMENT_MISMATCH', test.reason('99999999-0000-0000-0000-000000000006'));
select test.chk(test.reason('99999999-0000-0000-0000-000000000007') = '-' and test.reason('99999999-0000-0000-0000-000000000008') = '-', 'F7: cash above the total not flagged');
select test.chk(test.reason('99999999-0000-0000-0000-000000000009') = 'PAYMENT_MISMATCH', 'F7: ... too much change flagged', test.reason('99999999-0000-0000-0000-000000000009'));
select test.chk(test.reason('99999999-0000-0000-0000-000000000010') = 'PAYMENT_MISMATCH', 'F7: ... card over the total flagged', test.reason('99999999-0000-0000-0000-000000000010'));
select test.chk(test.reason('99999999-0000-0000-0000-000000000011') = 'PAYMENT_MISMATCH', 'F7: ... no payment flagged', test.reason('99999999-0000-0000-0000-000000000011'));
select test.chk(test.reason('99999999-0000-0000-0000-000000000012') = 'STAFF_MISMATCH'
           and (select signed_in_staff_id = :'manager'::uuid and cashier_id = :'cashier'::uuid from sales where id = '99999999-0000-0000-0000-000000000012'), 'F8: ... flagged STAFF_MISMATCH, server-known staff stored', test.reason('99999999-0000-0000-0000-000000000012'));
update settings set tax_inclusive = true where business_id = :'biz';
select test.login(:'d1'); set role authenticated;
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000014', :'manager', '{"tax_amount":0,"service_charge_amount":15,"grand_total":165}'))) = 'ok', 'F6: tax-inclusive shop, tax 0');
select test.chk(test.res(test.op(:'key1', 'sale', test.sale('99999999-0000-0000-0000-000000000015', :'cashier', '{"tax_amount":18,"service_charge_amount":0,"grand_total":168,"needs_review":false,"review_reason":null,"signed_in_staff_id":"66666666-0000-0000-0000-000000000001"}',
   '{"method":"GCASH","amount":100}'))) = 'ok', 'F6-F8: everything wrong at once (and fake flags / signed_in_staff_id sent)');
reset role;
select test.chk(test.reason('99999999-0000-0000-0000-000000000014') = '-', 'F6: tax-inclusive respected', test.reason('99999999-0000-0000-0000-000000000014'));
select test.chk(test.reason('99999999-0000-0000-0000-000000000015') = 'TAX_MISMATCH, PAYMENT_MISMATCH, STAFF_MISMATCH'
           and (select needs_review and signed_in_staff_id = :'manager'::uuid from sales where id = '99999999-0000-0000-0000-000000000015'), 'F6-F8: reasons joined with ", "; counter''s values ignored', test.reason('99999999-0000-0000-0000-000000000015'));
update settings set tax_pct = 0, service_charge_pct = 0, tax_inclusive = false where business_id = :'biz';
-- refunds
select test.login(:'d1'); set role authenticated;
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_r1 \gset
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ov_r2 \gset
select test.chk(test.res(test.op(:'key1', 'refund', jsonb_build_object('refund', jsonb_build_object('id','dddddddd-0000-0000-0000-000000000001','sale_id','99999999-0000-0000-0000-000000000002',
   'type','VOID','amount',183,'approved_by', :'manager','performed_by', :'manager','date', now(), 'needs_review', true, 'review_reason', 'FAKE', 'signed_in_staff_id', :'cashier'), 'approval_token', :'ov_r1'))) = 'ok', 'F8: refund by the signed-in manager');
select test.chk(test.res(test.op(:'key1', 'refund', jsonb_build_object('refund', jsonb_build_object('id','dddddddd-0000-0000-0000-000000000002','sale_id','99999999-0000-0000-0000-000000000007',
   'type','VOID','amount',183,'approved_by', :'manager','performed_by', :'cashier','date', now()), 'approval_token', :'ov_r2'))) = 'ok', 'F8: refund performed by Cathy while Manny is signed in accepted ...');
reset role;
select test.chk((select not needs_review and review_reason is null and signed_in_staff_id = :'manager'::uuid from refunds where id = 'dddddddd-0000-0000-0000-000000000001'), 'F8: matching refund not flagged (counter''s fake flag ignored)');
select test.chk((select needs_review and review_reason = 'STAFF_MISMATCH' and signed_in_staff_id = :'manager'::uuid from refunds where id = 'dddddddd-0000-0000-0000-000000000002'), 'F8: ... flagged STAFF_MISMATCH');
-- audit + pay-outs
select test.login(:'d1'); set role authenticated;
select test.chk(test.res(test.op(:'key1', 'audit', jsonb_build_object('id','abababab-0000-0000-0000-000000000001','action','Test','actor_id', :'cashier','signed_in_staff_id', :'cashier'))) = 'ok', 'F8: audit row');
select test.chk(test.res(test.op(:'key1', 'cash_movement', jsonb_build_object('id','cdcdcdcd-0000-0000-0000-000000000001','shift_id','88888888-0000-0000-0000-000000000001','type','PAY_OUT','amount',1000,'performed_by', :'manager','at', now()))) = 'ok'
           and test.res(test.op(:'key1', 'cash_movement', jsonb_build_object('id','cdcdcdcd-0000-0000-0000-000000000002','shift_id','88888888-0000-0000-0000-000000000001','type','PAY_OUT','amount',1000.01,'performed_by', :'manager','at', now(),'needs_review',false))) = 'ok'
           and test.res(test.op(:'key1', 'cash_movement', jsonb_build_object('id','cdcdcdcd-0000-0000-0000-000000000003','shift_id','88888888-0000-0000-0000-000000000001','type','PAY_IN','amount',5000,'performed_by', :'manager','at', now()))) = 'ok', 'F8: pay-outs / pay-in saved');
reset role;
select test.chk((select signed_in_staff_id = :'manager'::uuid from audit_log where id = 'abababab-0000-0000-0000-000000000001'), 'F8: audit row stores the server-known staff (counter''s value ignored)');
select test.chk((select not needs_review from cash_movements where id = 'cdcdcdcd-0000-0000-0000-000000000001')
           and (select needs_review from cash_movements where id = 'cdcdcdcd-0000-0000-0000-000000000002')
           and (select not needs_review from cash_movements where id = 'cdcdcdcd-0000-0000-0000-000000000003'), 'F8: PAY_OUT above settings.payout_review_limit (1000) flagged; at the limit / pay-ins not');
update settings set payout_review_limit = 5000 where business_id = :'biz';
select test.login(:'d1'); set role authenticated;
select test.res(test.op(:'key1', 'cash_movement', jsonb_build_object('id','cdcdcdcd-0000-0000-0000-000000000004','shift_id','88888888-0000-0000-0000-000000000001','type','PAY_OUT','amount',2000,'performed_by', :'manager','at', now())));
reset role;
select test.chk((select not needs_review from cash_movements where id = 'cdcdcdcd-0000-0000-0000-000000000004'), 'F8: the limit comes from settings (5000)');
select test.login(:'owner_uid'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"cash_movements","row":{"id":"cdcdcdcd-0000-0000-0000-000000000002","needs_review":false}},{"op":"update","table":"refunds","row":{"id":"dddddddd-0000-0000-0000-000000000002","needs_review":false}}]')$$) = 'NO ERROR', 'F8: owner clears the flags');
reset role;
select test.chk((select not needs_review from cash_movements where id = 'cdcdcdcd-0000-0000-0000-000000000002') and (select not needs_review from refunds where id = 'dddddddd-0000-0000-0000-000000000002'), 'F8: ... cleared');

-- ================= F13: only known error codes =================
select test.login(:'d1'); set role authenticated;
select test.chk(test.res(test.op(:'key1', 'explode', '{}')) = 'UNKNOWN_OP', 'F13: unknown op -> UNKNOWN_OP (no detail)', test.res(test.op(:'key1', 'explode', '{}')));
select test.chk(test.res(test.op(:'key1', 'cash_movement', '{"id":"cdcdcdcd-0000-0000-0000-000000000009","performed_by":"not-a-uuid"}')) = 'SERVER_ERROR', 'F13: a database error -> SERVER_ERROR',
  test.res(test.op(:'key1', 'cash_movement', '{"id":"cdcdcdcd-0000-0000-0000-000000000009","performed_by":"not-a-uuid"}')));
select test.chk(test.res(test.op(:'key1', 'shift_open', jsonb_build_object('id', gen_random_uuid(), 'cashier_id', :'cashier', 'store_id', gen_random_uuid(), 'device_id', null))) in ('ok', 'SERVER_ERROR'), 'F13: (shift_open sanity)');
select test.chk(test.res(test.op(:'key1', 'cash_movement', jsonb_build_object('id','cdcdcdcd-0000-0000-0000-00000000000a','shift_id', gen_random_uuid(),'type','PAY_IN','amount',1,'performed_by', :'manager'))) = 'SERVER_ERROR', 'F13: foreign key error -> SERVER_ERROR');
select test.chk(test.res(test.op(:'key1', 'sale', '{"sale":{"id":"x"}}')) = 'SERVER_ERROR', 'F13: bad sale id -> SERVER_ERROR');
select test.chk(public.fo_sync(:'key1', '[{"op_id":"nope","type":"audit","data":{}}]')->0->>'message' = 'BAD_OP', 'F13: an op without a valid op_id -> BAD_OP (whole call not broken)');
select test.chk(public.fo_sync(:'key1', '{"not":"an array"}') = '[]'::jsonb, 'F13: ops that are not a list -> nothing done');
select test.chk(test.res(test.op(:'key1', 'refund', jsonb_build_object('refund', jsonb_build_object('id', gen_random_uuid(), 'sale_id','99999999-0000-0000-0000-000000000003','type','VOID','amount',5,'approved_by', :'manager'), 'approval_token', 'zzz'))) = 'APPROVAL_INVALID', 'F13: known codes still pass through');
reset role;

-- ================= F9: what a counter can read =================
select test.login(:'d1'); set role authenticated;
select test.chk((select count(*) from suppliers) + (select count(*) from purchases) + (select count(*) from production_batches) + (select count(*) from waste)
           + (select count(*) from audit_log) + (select count(*) from reconciliation_issues) + (select count(*) from sync_operations) + (select count(*) from stores) + (select count(*) from customers) = 0,
  'F9: counter reads no suppliers / purchases / production / waste / audit_log / reconciliation / sync_operations / stores / customers');
select test.chk((select count(*) from devices) = 1 and (select device_key from devices) = :'key1', 'F9: counter reads only its own device row');
select test.chk((select count(*) from sales) > 0 and (select count(*) from refunds) > 0 and (select count(*) from cash_movements) > 0 and (select count(*) from payments) > 0
           and (select count(*) from sale_items) > 0 and (select count(*) from recipes) > 0 and (select count(*) from staff) > 0 and (select count(*) from settings) = 1
           and (select count(*) from v_ingredient_stock) = 1 and (select count(*) from dining_tables) > 0, 'F9: counter still reads what it needs (sales, refunds, cash, payments, items, menu, staff, settings, stock, tables)');
select public.fo_bootstrap(:'key1') as fb \gset
select test.chk((:'fb'::jsonb->'device'->>'device_tag') = 'A' and (:'fb'::jsonb->'next_numbers'->>'pos')::int > 0 and jsonb_array_length(:'fb'::jsonb->'sales') > 0, 'F9: fo_bootstrap still works (device, next_numbers, sales)', :'fb'::jsonb->>'next_numbers');
select test.chk(jsonb_array_length(public.sales_report(now() - interval '1 day', now() + interval '1 day')->'sales') > 0, 'F9: sales_report still works on a counter');
reset role;
select test.login(:'owner_uid'); set role authenticated;
select test.chk((select count(*) from suppliers) = 1 and (select count(*) from audit_log) > 0 and (select count(*) from devices) = 2 and (select count(*) from profiles) = 3, 'F9: owner still reads everything');
select test.chk(jsonb_array_length(public.bo_bootstrap()->'suppliers') = 1, 'F9: bo_bootstrap unchanged for the owner');
reset role;

-- ================= F10: internal helpers are not callable =================
select test.chk(count(*) = 0, 'F10: no internal function executable by anon / authenticated', string_agg(p.oid::regprocedure::text, ', '))
from pg_proc p where p.pronamespace = 'public'::regnamespace
  and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
  and p.proname not in ('get_qr_menu','qr_session','qr_register','qr_relink','qr_set_phone','qr_forget_device','qr_place_order','qr_my_orders','qr_cancel_order',
    'current_business_id','current_role_rank','app_rank','is_owner','apply_changes','staff_pin_ids','staff_pin_update_needed','staff_pin_login','staff_logout',
    'staff_set_pin','staff_import_legacy_pin','create_device_pairing_code','redeem_device_pairing','revoke_device','unlock_device_pin','fo_bootstrap',
    'bo_bootstrap','sales_report','search_customers','fo_sync','fo_add_customer','qr_update_order','merge_customers');
select test.chk(not has_function_privilege('authenticated', 'public._write_row(text,jsonb,text,text,uuid)', 'execute')
           and not has_function_privilege('authenticated', 'public._update_row(text,jsonb,text,uuid)', 'execute')
           and not has_function_privilege('authenticated', 'public._writable_tables()', 'execute')
           and to_regprocedure('public._next_numbers(uuid,text)') is null, 'F10: _write_row / _update_row / _writable_tables revoked, _next_numbers gone');
select test.chk(not has_function_privilege('anon', 'public.staff_pin_update_needed()', 'execute') and not has_function_privilege('anon', 'public.fo_add_customer(text,text,boolean)', 'execute'), 'F10: anon cannot call the member functions');
-- apply_changes (now SECURITY DEFINER) still keeps shops apart
select test.login(:'owner_uid'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"categories","row":{"id":"11111111-0000-0000-0000-0000000000b1","name":"Stolen"}}]')$$) = 'FORBIDDEN_ROW', 'F10: apply_changes can''t overwrite another shop''s row');
select test.chk(test.err($$select public.apply_changes('[{"op":"insert_ignore","table":"categories","row":{"id":"11111111-0000-0000-0000-0000000000b1","name":"Stolen"}}]')$$) = 'FORBIDDEN_ROW', 'F10: ... nor with insert_ignore');
select public.apply_changes('[{"op":"update","table":"categories","row":{"id":"11111111-0000-0000-0000-0000000000b1","name":"Stolen"}},{"op":"delete","table":"sales","id":"99999999-0000-0000-0000-0000000000b1"}]');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"categories","row":{"id":"11111111-0000-0000-0000-000000000001","name":"Coffee"}}]')$$) = 'NO ERROR', 'F10: owner still saves own rows');
reset role;
select test.chk((select name from categories where id = '11111111-0000-0000-0000-0000000000b1') = 'Other cat' and (select count(*) from sales where id = '99999999-0000-0000-0000-0000000000b1') = 1, 'F10: update / delete of another shop''s rows changed nothing');
select test.chk((select business_id from categories where id = '11111111-0000-0000-0000-000000000001') = :'biz'::uuid, 'F10: new rows get the owner''s shop');
select test.login(:'d1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"categories","row":{"name":"Hack"}}]')$$) = 'ADMIN_ONLY', 'F10: a counter still can''t use apply_changes');
reset role;

-- ================= F11: consent at the counter =================
select test.login(:'d1'); set role authenticated;
select test.chk(public.fo_add_customer('Nina', '0917 000 1111')->>'error' = 'CONSENT_REQUIRED', 'F11: no consent -> CONSENT_REQUIRED');
select test.chk(public.fo_add_customer('Nina', '0917 000 1111', false)->>'error' = 'CONSENT_REQUIRED', 'F11: consent false -> CONSENT_REQUIRED');
select test.chk((public.fo_add_customer('Nina', '0917 000 1111', true)->'customer'->>'consent_at') is not null, 'F11: with consent -> saved with consent_at');
reset role;
select test.chk((select count(*) from customers where nickname = 'Nina') = 1, 'F11: refused calls saved nothing');

-- ================= qr_cancel_order needs paid_at null =================
select test.login('00000000-0000-0000-0000-0000000c0001'); set role authenticated;
select test.chk((public.qr_register('tok-t1', 'Ana', null, true)->'customer') is not null, 'setup: QR customer');
select public.qr_place_order('tok-t1', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1}]')->'order'->>'id' as q1 \gset
reset role;
update qr_orders set paid_at = now() where id = :'q1';
select test.login('00000000-0000-0000-0000-0000000c0001'); set role authenticated;
select test.chk(public.qr_cancel_order('tok-t1', :'q1')->>'error' = 'CANNOT_CANCEL', 'cancel: a paid (still PENDING) order can''t be cancelled');
reset role;
update qr_orders set paid_at = null, status = 'CANCELLED' where id = :'q1';

-- ================= F5: QR flood limits =================
-- 12 phones register (one is already registered), each places 1 order at Table 1 -> the 11th open order at that table is refused
select test.chk(count(*) = 11, 'setup: 11 more QR customers') from (
  select set_config('request.jwt.claims', json_build_object('sub', ('00000000-0000-0000-0000-0000000c' || lpad(g::text, 4, '0')), 'role', 'authenticated')::text, false),
         public.qr_register('tok-t1', 'P' || g, null, true) r from generate_series(2, 12) g) x where x.r ? 'customer';
create or replace function test.place(g int, tok text) returns text language sql as $$
  select coalesce(r->>'error', 'ok') from (select set_config('request.jwt.claims', json_build_object('sub', ('00000000-0000-0000-0000-0000000c' || lpad(g::text, 4, '0')), 'role', 'authenticated')::text, false) x,
    public.qr_place_order(tok, '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1}]') r) y
$$;
select test.chk(string_agg(test.place(g, 'tok-t1'), ',' order by g) = 'ok,ok,ok,ok,ok,ok,ok,ok,ok,ok,TOO_MANY_ORDERS', 'F5: 10 PENDING orders at one table, the 11th -> TOO_MANY_ORDERS') from generate_series(2, 12) g;
select test.chk(test.place(12, 'tok-t2') = 'ok', 'F5: the same phone can still order at another table');
update qr_orders set status = 'PREPARING' where table_id = '77777777-0000-0000-0000-000000000001';
select test.chk(test.place(12, 'tok-t1') = 'ok', 'F5: once orders are accepted the table can order again');
-- shop-wide: 60 orders in 10 minutes (13 so far)
insert into qr_orders(business_id, order_number, order_day, status, created_at)
  select :'biz', 'Q-F' || g, current_date, 'COMPLETED', now() - interval '5 minutes' from generate_series(1, 60 - (select count(*) from qr_orders where business_id = :'biz' and created_at > now() - interval '10 minutes')) g;
select test.chk(test.place(11, 'tok-t2') = 'TOO_MANY_ORDERS', 'F5: the shop''s 61st order in 10 minutes -> TOO_MANY_ORDERS');
update qr_orders set created_at = now() - interval '11 minutes' where order_number like 'Q-F%';
select test.chk(test.place(11, 'tok-t2') = 'ok', 'F5: after 10 minutes orders come in again');
reset role;
-- shop-wide: 40 new customers per hour (QR + counter)
select count(*) as nc from customers where business_id = :'biz' and created_at > now() - interval '1 hour' \gset
insert into customers(business_id, nickname, source) select :'biz', 'Bulk' || g, 'QR' from generate_series(1, 40 - :nc - 1) g;
select test.login('00000000-0000-0000-0000-0000000c0020'); set role authenticated;
select test.chk((public.qr_register('tok-t1', 'Fortieth', null, true)->'customer') is not null, 'F5: the 40th new customer this hour registers');
reset role;
select test.login('00000000-0000-0000-0000-0000000c0021'); set role authenticated;
select test.chk(public.qr_register('tok-t1', 'FortyFirst', null, true)->>'error' = 'TOO_MANY_SIGNUPS', 'F5: the 41st -> TOO_MANY_SIGNUPS');
select test.chk((public.qr_session('tok-t1')->'customer') = 'null'::jsonb, 'F5: ... and nothing linked');
reset role;
select test.login(:'d1'); set role authenticated;
select test.chk(public.fo_add_customer('Walk-in', null, true)->>'error' = 'TOO_MANY_SIGNUPS', 'F5: counter add also limited -> TOO_MANY_SIGNUPS');
select test.chk((public.fo_add_customer('Nina again', '0917 000 1111', true)->>'existing')::boolean, 'F5: finding an EXISTING customer still works');
reset role;
select test.login(:'owner_uid'); set role authenticated;
select test.chk((public.fo_add_customer('Owner adds', null, true)->'customer') is not null, 'F5: the owner''s login is not limited');
reset role;
update customers set created_at = now() - interval '61 minutes' where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000c0021'); set role authenticated;
select test.chk((public.qr_register('tok-t1', 'FortyFirst', null, true)->'customer') is not null, 'F5: an hour later sign-ups work again');
reset role;

-- ================= F4: PIN_AMBIGUOUS counts toward the lock; owner alert =================
delete from auth_attempts;
insert into staff_pins(staff_id, pin_hash, pin_length) values ('66666666-0000-0000-0000-000000000007', extensions.crypt('1111', extensions.gen_salt('bf', 4)), 4)
  on conflict (staff_id) do update set pin_hash = excluded.pin_hash, legacy_sha256 = null;   -- Cora now shares Cathy's PIN
select test.login(:'d1'); set role authenticated;
select test.chk(string_agg(coalesce(public.staff_pin_login('1111')->>'error', 'ok'), ',') = 'PIN_AMBIGUOUS,PIN_AMBIGUOUS,PIN_AMBIGUOUS,PIN_AMBIGUOUS,PIN_AMBIGUOUS', 'F4: 5 ambiguous answers ...')
  from generate_series(1, 5);
select test.chk(public.staff_pin_login('222222')->>'error' = 'TOO_MANY_ATTEMPTS', 'F4: ... lock the counter like wrong PINs');
reset role;
select test.chk((select count(*) from pin_lock_events where device_user_id = :'d1') = 1, 'F4: one lock event recorded');
select test.login(:'d2'); set role authenticated;
select public.staff_pin_login('0001'); select public.staff_pin_login('0002'); select public.staff_pin_login('0003'); select public.staff_pin_login('0004');
select test.chk(public.staff_pin_login('0005')->>'error' = 'TOO_MANY_ATTEMPTS', 'F4: d2 locked by 5 wrong PINs');
select public.staff_pin_login('1111');   -- refused while locked: no second event
reset role;
select test.login(:'owner_uid'); set role authenticated;
select public.bo_bootstrap()->'pin_lockouts' as lk \gset
select test.chk(jsonb_array_length(:'lk'::jsonb) = 2 and (:'lk'::jsonb->0->>'device_name') = 'Back bar' and (:'lk'::jsonb->1->>'device_name') = 'Front'
           and (:'lk'::jsonb->0->>'locked_until')::timestamptz > now() and (:'lk'::jsonb->0->>'locked_at') is not null, 'F4: bo_bootstrap.pin_lockouts lists both counters, newest first', :'lk');
reset role;
select id as dev2 from devices where device_key = :'key2' \gset
select test.login(:'owner_uid'); set role authenticated;
select test.chk(public.unlock_device_pin(:'dev2')->>'ok' = 'true', 'F4: owner unlocks d2');
select test.chk((select (e->>'locked_until')::timestamptz <= now() from jsonb_array_elements(public.bo_bootstrap()->'pin_lockouts') e where e->>'device_name' = 'Back bar')
           and (select (e->>'locked_until')::timestamptz > now() from jsonb_array_elements(public.bo_bootstrap()->'pin_lockouts') e where e->>'device_name' = 'Front'),
  'F4: unlocking ends d2''s lock alert (locked_until = now), d1''s stays');
reset role;
update pin_lock_events set locked_at = now() - interval '8 days';
select test.login(:'owner_uid'); set role authenticated;
select test.chk(public.bo_bootstrap()->'pin_lockouts' = '[]'::jsonb, 'F4: only the last 7 days');
reset role;
select test.login(:'d1'); set role authenticated;
select test.chk((select count(*) from pin_lock_events) = 0, 'F4: a counter can''t read the lock events');
reset role;
select 'ROUND 3 CHECKS DONE';
