-- Behaviour tests for 004. Run with: psql -v ON_ERROR_STOP=1 -f 10_behaviour_tests.sql
\set QUIET on
create schema if not exists test;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', case when p_token is null then '{}' else json_build_object('x-staff-token', p_token)::text end, false);
end $$;
create or replace function test.ok(cond boolean, msg text) returns text language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'ASSERT FAILED: %', msg; end if; return 'ok  ' || msg; end $$;
grant usage on schema test to anon, authenticated; grant execute on all functions in schema test to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

-- ===== 1. signup trigger =====
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000b1', 'other@example.com', '{"business_name":"Other Shop","admin_name":"Olga"}');
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0000-0000000000c1', true);   -- a QR customer
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0000-0000000000c2', true);   -- second customer phone
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0000-0000000000d1', true);   -- counter tablet
select test.ok((select count(*) from businesses) = 2, 'anonymous logins create no business (2 real owners -> 2 businesses)');
select test.ok((select count(*) from profiles where id = '00000000-0000-0000-0000-0000000000c1') = 0, 'customer has no profile');
select test.ok((select count(*) from staff where role='ADMIN') = 2, 'owner staff rows exist (backfill + new signup)');
select test.ok((select count(*) from dining_tables) = 2, 'each business has a Takeaway table');
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select business_id as biz2 from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset
select id as owner_staff from staff where profile_id = '00000000-0000-0000-0000-0000000000a1' \gset
select qr_token as tok from dining_tables where business_id = :'biz' \gset

-- ===== 2. owner builds the menu through apply_changes =====
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select test.ok(public.app_rank() = 3, 'owner rank = 3');
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','categories','row', jsonb_build_object('id','11111111-0000-0000-0000-000000000001','name','Coffee')),
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','22222222-0000-0000-0000-000000000001','name','Espresso beans','category_id','11111111-0000-0000-0000-000000000001','base_unit','g','reorder_level',100)),
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','22222222-0000-0000-0000-000000000002','name','Milk','base_unit','ml','reorder_level',1000)),
  jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object('id','33333333-0000-0000-0000-000000000001','name','Iced Latte','recipe_type','DRINKS','category','Iced','selling_price',150,
     'modifier_groups', '[{"id":"g-size","name":"Size","required":true,"multi_select":false,"options":[{"id":"o-12","label":"12oz","price_delta":0},{"id":"o-16","label":"16oz","price_delta":20,"ingredient_id":"22222222-0000-0000-0000-000000000002","ingredient_qty_delta":60}]},{"id":"g-add","name":"Add-ons","required":false,"multi_select":true,"options":[{"id":"o-shot","label":"Extra shot","price_delta":30,"ingredient_id":"22222222-0000-0000-0000-000000000001","ingredient_qty_delta":18},{"id":"o-oat","label":"Oat milk","price_delta":25}]}]'::jsonb)),
  jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object('id','33333333-0000-0000-0000-000000000002','name','Caramel Sauce','recipe_type','SAUCES_SYRUPS','selling_price',0,'is_production_recipe',true)),
  jsonb_build_object('op','upsert','table','recipe_ingredients','row', jsonb_build_object('id','44444444-0000-0000-0000-000000000001','recipe_id','33333333-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','quantity',18,'unit','g')),
  jsonb_build_object('op','upsert','table','recipe_ingredients','row', jsonb_build_object('id','44444444-0000-0000-0000-000000000002','recipe_id','33333333-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000002','quantity',180,'unit','ml')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','55555555-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','INITIAL_STOCK','quantity',1000,'transaction_date','2026-10-09T02:00:00.000Z')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','55555555-0000-0000-0000-000000000002','ingredient_id','22222222-0000-0000-0000-000000000002','transaction_type','INITIAL_STOCK','quantity',5000,'transaction_date','2026-10-09'))
));
select test.ok((select stock from v_ingredient_stock where ingredient_id = '22222222-0000-0000-0000-000000000001') = 1000, 'stock view (ISO timestamp accepted for a date column)');
-- upsert only touches the columns sent
select public.apply_changes('[{"op":"update","table":"ingredients","row":{"id":"22222222-0000-0000-0000-000000000002","reorder_level":500}}]');
select test.ok((select name from ingredients where id='22222222-0000-0000-0000-000000000002') = 'Milk' and (select reorder_level from ingredients where id='22222222-0000-0000-0000-000000000002') = 500, 'partial update keeps other columns');
select public.apply_changes('[{"op":"upsert","table":"settings","row":{"tax_pct":0,"service_charge_pct":10,"business_name":"Cavite City Coffee Club"}}]');
select test.ok((select service_charge_pct from settings where business_id = :'biz') = 10, 'settings upsert by business_id');
select public.apply_changes('[{"op":"upsert","table":"businesses","row":{"name":"Cavite City Coffee Club"}}]');
select test.ok((select name from businesses where id = :'biz') = 'Cavite City Coffee Club', 'shop name updated');
-- staff
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','staff','row', jsonb_build_object('id','66666666-0000-0000-0000-000000000001','name','Cathy Cashier','role','CASHIER')),
  jsonb_build_object('op','upsert','table','staff','row', jsonb_build_object('id','66666666-0000-0000-0000-000000000002','name','Manny Manager','role','MANAGER'))));
select test.ok((public.staff_set_pin('66666666-0000-0000-0000-000000000001','1111')->>'ok')::boolean, 'set cashier PIN');
select test.ok((public.staff_set_pin('66666666-0000-0000-0000-000000000002','2222')->>'ok')::boolean, 'set manager PIN');
select test.ok((public.staff_set_pin(:'owner_staff','9999')->>'ok')::boolean, 'set owner PIN');
select test.ok(public.staff_set_pin('66666666-0000-0000-0000-000000000002','1111')->>'error' = 'PIN_IN_USE', 'duplicate PIN rejected');
select test.ok((select count(*) from staff_pins) = 0, 'staff_pins is unreadable through the API (RLS, no policy)');
select (public.create_device_pairing_code('Front Counter'))->>'code' as paircode \gset
reset role;

-- other business cannot see CCCC data
select test.login('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select test.ok((select count(*) from recipes) = 0, 'other business sees none of our recipes');
select test.ok((select count(*) from staff) = 1, 'other business sees only its own staff');
reset role;

-- ===== 3. counter device pairing =====
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.ok(public.redeem_device_pairing('WRONG1', 'device-key-0001-abcdef', 'Front')->>'error' = 'BAD_CODE', 'bad pairing code rejected');
select test.ok((public.redeem_device_pairing(lower(:'paircode'), 'device-key-0001-abcdef', 'Front Counter')->'device'->>'device_tag') = 'A', 'device paired with tag A');
select test.ok(public.app_rank() = 0, 'device without staff PIN has rank 0');
select test.ok((select count(*) from recipes) = 2, 'device can READ the menu');
select test.ok(public.redeem_device_pairing(:'paircode', 'device-key-0002-abcdef', 'Again')->>'error' = 'BAD_CODE', 'pairing code is single-use');
\set ON_ERROR_STOP off
select public.apply_changes('[{"op":"upsert","table":"categories","row":{"name":"Hack"}}]');
insert into categories(name) values ('Hack2');
update profiles set role = 'ADMIN' where id = '00000000-0000-0000-0000-0000000000d1';
\set ON_ERROR_STOP on
select test.ok((select count(*) from categories where name like 'Hack%') = 0, 'device without admin PIN cannot change data');
select test.ok((select role from profiles where id = '00000000-0000-0000-0000-0000000000d1') = 'DEVICE', 'device cannot promote itself (role escalation fixed)');
-- PIN logins
select test.ok(public.staff_pin_login('0000')->>'error' = 'WRONG_PIN', 'wrong PIN');
select (public.staff_pin_login('1111')) ->> 'token' as cashier_token \gset
select (public.staff_pin_login('9999')) ->> 'token' as admin_token \gset
select test.ok(public.staff_pin_login('1111', 'OVERRIDE', 'MANAGER')->>'error' = 'ROLE_TOO_LOW', 'cashier PIN cannot approve manager actions');
select test.ok((public.staff_pin_login('2222', 'OVERRIDE', 'MANAGER')->'staff'->>'role') = 'MANAGER', 'manager override works');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1', :'cashier_token');
set role authenticated;
select test.ok(public.app_rank() = 1, 'cashier token -> rank 1');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1', :'admin_token');
set role authenticated;
select test.ok(public.app_rank() = 3, 'admin PIN on the counter -> rank 3 (Back Office allowed)');
select public.apply_changes('[{"op":"upsert","table":"dining_tables","row":{"id":"77777777-0000-0000-0000-000000000005","label":"Table 5","kind":"DINE_IN","sort_order":5}}]');
select test.ok((select count(*) from dining_tables where label='Table 5') = 1, 'admin PIN session can edit Back Office data');
reset role;
-- token stolen onto another login does nothing
select test.login('00000000-0000-0000-0000-0000000000c1', :'admin_token');
set role authenticated;
select test.ok(public.app_rank() = 0, 'staff token is useless from another login');
reset role;
-- rate limiting of wrong PINs
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select public.staff_pin_login('0001'); select public.staff_pin_login('0002'); select public.staff_pin_login('0003'); select public.staff_pin_login('0004');
select test.ok(public.staff_pin_login('1111')->>'error' = 'TOO_MANY_ATTEMPTS', '5 wrong PINs in 5 minutes -> locked');
reset role;
delete from auth_attempts;

-- ===== 4. counter sync =====
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.ok((public.fo_bootstrap('device-key-0001-abcdef')->'device'->>'device_tag') = 'A', 'fo_bootstrap returns device');
select test.ok(jsonb_array_length(public.fo_bootstrap('device-key-0001-abcdef')->'staff') = 3, 'fo_bootstrap returns staff list');
select test.ok((select bool_and((s->>'has_pin')::boolean) from jsonb_array_elements(public.fo_bootstrap('device-key-0001-abcdef')->'staff') s), 'has_pin flags');
select public.fo_sync('device-key-0001-abcdef', jsonb_build_array(
  jsonb_build_object('op_id','a0000000-0000-0000-0000-000000000001','type','shift_open','data', jsonb_build_object(
     'id','88888888-0000-0000-0000-000000000001','shift_number','SHIFT-A-2026-0001','cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',2000)),
  jsonb_build_object('op_id','a0000000-0000-0000-0000-000000000002','type','sale','data', jsonb_build_object(
     'sale', jsonb_build_object('id','99999999-0000-0000-0000-000000000001','transaction_number','POS-A-2026-000001','transaction_date', now(),'status','COMPLETED',
        'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','shift_id','88888888-0000-0000-0000-000000000001',
        'subtotal',150,'discount_amount',0,'tax_amount',0,'service_charge_amount',15,'grand_total',165,'offline',true),
     'items', jsonb_build_array(jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000001','recipe_id','33333333-0000-0000-0000-000000000001','name','Iced Latte','quantity',1,'unit_price',150,'line_total',150,'modifiers','[]'::jsonb)),
     'payment', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-000000000001','method','CASH','amount',165,'tendered',200,'change',35,'status','CONFIRMED'),
     'inventory', jsonb_build_array(
        jsonb_build_object('id','cccccccc-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','quantity',18,'transaction_date','2026-10-09'),
        jsonb_build_object('id','cccccccc-0000-0000-0000-000000000002','ingredient_id','22222222-0000-0000-0000-000000000002','quantity',180,'transaction_date','2026-10-09'))))
)) as r1 \gset
select test.ok(:'r1'::jsonb @> '[{"status":"ok"},{"status":"ok"}]', 'shift opened + sale synced: ' || :'r1');
select test.ok((select stock from v_ingredient_stock where ingredient_id='22222222-0000-0000-0000-000000000001') = 982, 'sale deducted beans');
select test.ok((public.fo_sync('device-key-0001-abcdef', '[{"op_id":"a0000000-0000-0000-0000-000000000002","type":"sale","data":{}}]')->0->>'status') = 'duplicate', 'same op twice = duplicate (no double sale)');
select test.ok((public.fo_sync('device-key-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id','a0000000-0000-0000-0000-000000000003','type','sale','data',
   jsonb_build_object('sale', jsonb_build_object('id','99999999-0000-0000-0000-000000000001','status','HELD','cashier_id','66666666-0000-0000-0000-000000000001')))))->0->>'status') = 'skipped',
   'completed sale cannot be turned back into a held order');
-- discount needs a manager
select test.ok((public.fo_sync('device-key-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id','a0000000-0000-0000-0000-000000000004','type','sale','data',
   jsonb_build_object('sale', jsonb_build_object('id','99999999-0000-0000-0000-000000000002','transaction_number','POS-A-2026-000002','transaction_date',now(),'status','COMPLETED',
     'cashier_id','66666666-0000-0000-0000-000000000001','discount_amount',10,'discount_approved_by','66666666-0000-0000-0000-000000000001','grand_total',140)))))->0->>'message') = 'ROLE_TOO_LOW',
   'discount approved by a cashier is rejected');
select test.ok((select count(*) from sales where id='99999999-0000-0000-0000-000000000002') = 0, 'rejected op left no partial rows');
-- void by manager restores stock
select test.ok((public.fo_sync('device-key-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id','a0000000-0000-0000-0000-000000000005','type','refund','data', jsonb_build_object(
   'refund', jsonb_build_object('id','dddddddd-0000-0000-0000-000000000001','sale_id','99999999-0000-0000-0000-000000000001','shift_id','88888888-0000-0000-0000-000000000001','type','VOID','amount',165,'reason','test','approved_by','66666666-0000-0000-0000-000000000002','approved_by_name','Manny','date',now()),
   'sale_status','VOIDED',
   'inventory', jsonb_build_array(jsonb_build_object('id','eeeeeeee-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','quantity',18,'transaction_date','2026-10-09')))))) ->0->>'status') = 'ok', 'void synced');
select test.ok((select status from sales where id='99999999-0000-0000-0000-000000000001') = 'VOIDED', 'sale marked VOIDED');
select test.ok((select stock from v_ingredient_stock where ingredient_id='22222222-0000-0000-0000-000000000001') = 1000, 'void returned beans to stock');
do $$ begin
  perform public.fo_sync('wrong-device-key-123456', '[]'::jsonb);
  raise exception 'ASSERT FAILED: unregistered device key accepted';
exception when others then
  if sqlerrm like 'ASSERT%' then raise; end if;
end $$;
select 'ok  unregistered device key rejected';
reset role;
