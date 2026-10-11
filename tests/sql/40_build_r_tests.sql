-- Build R (supabase/004_cccc_frontoffice_backoffice_qr.sql) behaviour tests.
-- Run on a FRESH database made with:
--   tests/reset_db.sh supabase/004_cccc_frontoffice_backoffice_qr.sql rbuild
--   psql -h /tmp -p 54329 -U postgres -d rbuild -v ON_ERROR_STOP=1 -f tests/sql/40_build_r_tests.sql
-- (or just tests/run_build_r.sh)
--
-- Every check is recorded as ok / FAILED and the run continues; a summary and the list of
-- failures are printed at the end, and the script exits non-zero if anything failed.
-- Writes are made the way Build R's apps make them:
--   * Back Office / Front Office tables: supabase-js upsert = INSERT .. ON CONFLICT (id)
--     DO UPDATE (or DO NOTHING for append-only tables), see shared/data.js _send()
--   * "update" stores (orders, devices, profiles, settings): UPDATE .. WHERE id/business_id
--   * everything else: the RPCs named in the JS.
\set QUIET on
create schema if not exists test;
create table if not exists test.results (n serial primary key, ok boolean, msg text, detail text);
truncate test.results restart identity;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', case when p_token is null then '{}' else json_build_object('x-staff-token', p_token)::text end, false);
end $$;
-- record a check (definer, so it can write the results table whatever role is active)
create or replace function test.check(cond boolean, msg text, detail text default null) returns text
language plpgsql security definer set search_path = test, pg_catalog as $$
begin
  insert into test.results(ok, msg, detail) values (coalesce(cond, false), msg, detail);
  return case when coalesce(cond, false) then 'ok      ' else 'FAILED  ' end || msg
      || case when not coalesce(cond, false) and detail is not null then '   [got: ' || left(detail, 300) || ']' else '' end;
end $$;
-- the rest run with the CALLER's role (so RLS / grants apply)
create or replace function test.j(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin execute p_sql into r; return r;
exception when others then return jsonb_build_object('__error', sqlstate, 'message', sqlerrm);
end $$;
create or replace function test.run(p_sql text) returns text language plpgsql as $$
declare n bigint;
begin execute p_sql; get diagnostics n = row_count; return 'ok ' || n;
exception when others then return 'ERR ' || sqlstate || ': ' || sqlerrm;
end $$;
create or replace function test.n(p_sql text) returns bigint language plpgsql as $$
declare r bigint;
begin execute p_sql into r; return r;
exception when others then return -1;
end $$;
-- supabase-js .upsert(row, {onConflict:'id', ignoreDuplicates}) with defaultToNull:false
create or replace function test.upsert(p_table text, p_row jsonb, p_ignore boolean default false) returns text language plpgsql as $$
declare cols text; sets text;
begin
  select string_agg(quote_ident(k), ', '), string_agg(format('%I = excluded.%I', k, k), ', ')
    into cols, sets from jsonb_object_keys(p_row) k;
  return test.run(format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, %L::jsonb) on conflict (id) do %s',
    p_table, cols, cols, p_table, p_row, case when p_ignore then 'nothing' else 'update set ' || sets end));
end $$;
-- supabase-js .update(patch).eq('id', id)
create or replace function test.patch(p_table text, p_id uuid, p_patch jsonb) returns text language plpgsql as $$
declare sets text;
begin
  select string_agg(format('%I = r.%I', k, k), ', ') into sets from jsonb_object_keys(p_patch) k;
  return test.run(format('update public.%I t set %s from jsonb_populate_record(null::public.%I, %L::jsonb) r where t.id = %L',
    p_table, sets, p_table, p_patch, p_id));
end $$;
-- every table/view in public that shows at least one row to the current role
create or replace function test.visible() returns jsonb language plpgsql as $$
declare t record; c bigint; out jsonb := '{}'::jsonb;
begin
  for t in select c2.relname from pg_class c2 join pg_namespace n on n.oid = c2.relnamespace
           where n.nspname = 'public' and c2.relkind in ('r', 'v') order by 1 loop
    begin
      execute format('select count(*) from public.%I', t.relname) into c;
      if c > 0 then out := out || jsonb_build_object(t.relname, c); end if;
    exception when others then null;  -- permission denied = not visible
    end;
  end loop;
  return out;
end $$;
grant usage on schema test to anon, authenticated;
grant execute on all functions in schema test to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

-- ===================================================================================
-- 1. Sign-ups: email signup creates a business; anonymous logins do not
-- ===================================================================================
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select id as store from stores where business_id = :'biz' \gset
select id as owner_staff from staff where profile_id = '00000000-0000-0000-0000-0000000000a1' \gset
select test.check((select count(*) from businesses) = 1 and (select count(*) from staff) = 1, 'existing owner backfilled as an ADMIN staff member');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000b1', 'other@example.com', '{"business_name":"Other Shop","admin_name":"Olga"}');
select test.check((select count(*) from businesses) = 2, 'email signup creates a business');
select test.check((select role from profiles where id = '00000000-0000-0000-0000-0000000000b1') = 'ADMIN'
  and (select count(*) from staff where profile_id = '00000000-0000-0000-0000-0000000000b1' and role = 'ADMIN') = 1
  and (select count(*) from settings s join profiles p on p.business_id = s.business_id where p.id = '00000000-0000-0000-0000-0000000000b1' and s.business_name = 'Other Shop') = 1,
  'new owner gets ADMIN profile + staff row + settings');
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-0000000000c1', true), ('00000000-0000-0000-0000-0000000000c2', true), ('00000000-0000-0000-0000-0000000000c3', true),
  ('00000000-0000-0000-0000-0000000000d1', true), ('00000000-0000-0000-0000-0000000000d2', true), ('00000000-0000-0000-0000-000000000099', true);
select test.check((select count(*) from businesses) = 2, 'anonymous logins (customers, tablets) create no business');
select test.check((select count(*) from profiles where id::text like '00000000-0000-0000-0000-0000000000c%' or id::text like '00000000-0000-0000-0000-0000000000d%') = 0, 'anonymous logins get no profile');
select business_id as biz2 from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset
select test.check(:'biz' <> :'biz2', 'two separate businesses');

-- ===================================================================================
-- 2. Owner sets up the shop through the Back Office write path (upsert / update)
-- ===================================================================================
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select test.check(public.current_role_rank() = 3, 'owner email login has admin rank 3');
select test.check(test.run(format($q$update public.settings set business_name = 'Cavite City Coffee Club', tax_pct = 0, service_charge_pct = 10, qr_ordering_enabled = true where business_id = %L$q$, :'biz')) = 'ok 1', 'owner saves settings (service 10%, QR on)');
select test.check(test.upsert('categories', jsonb_build_object('id','11111111-0000-0000-0000-000000000001','name','Coffee','business_id',:'biz')) = 'ok 1', 'owner adds category');
select test.check(test.upsert('ingredients', jsonb_build_object('id','22222222-0000-0000-0000-000000000001','name','Espresso beans','base_unit','g','reorder_level',100,'category_id','11111111-0000-0000-0000-000000000001','business_id',:'biz')) = 'ok 1'
  and test.upsert('ingredients', jsonb_build_object('id','22222222-0000-0000-0000-000000000002','name','Milk','base_unit','ml','reorder_level',1000,'business_id',:'biz')) = 'ok 1', 'owner adds ingredients');
select test.upsert('recipes', jsonb_build_object('id','33333333-0000-0000-0000-000000000001','name','Iced Latte','recipe_type','DRINKS','category','Iced','selling_price',150,'business_id',:'biz',
  'modifier_groups', '[{"id":"g-size","name":"Size","required":true,"multiSelect":false,"options":[{"id":"o-12","label":"12oz","priceDelta":0,"ingredientId":null,"ingredientQtyDelta":0},{"id":"o-16","label":"16oz","priceDelta":20,"ingredientId":"22222222-0000-0000-0000-000000000002","ingredientQtyDelta":60}]},{"id":"g-add","name":"Add-ons","required":false,"multiSelect":true,"options":[{"id":"o-shot","label":"Extra shot","priceDelta":30,"ingredientId":"22222222-0000-0000-0000-000000000001","ingredientQtyDelta":18},{"id":"o-oat","label":"Oat milk","priceDelta":25,"ingredientId":null,"ingredientQtyDelta":0}]}]'::jsonb)) as r1 \gset
select test.check(:'r1' = 'ok 1', 'owner adds Iced Latte with Size (required) + Add-ons (camelCase options, as the Back Office editor saves them)', :'r1');
select test.check(test.upsert('recipes', jsonb_build_object('id','33333333-0000-0000-0000-000000000002','name','Caramel Sauce','recipe_type','SAUCES_SYRUPS','selling_price',0,'is_production_recipe',true,'business_id',:'biz')) = 'ok 1'
  and test.upsert('recipes', jsonb_build_object('id','33333333-0000-0000-0000-000000000003','name','Americano','recipe_type','DRINKS','category','Hot','selling_price',110,'modifier_groups','[]'::jsonb,'business_id',:'biz')) = 'ok 1'
  and test.upsert('recipes', jsonb_build_object('id','33333333-0000-0000-0000-000000000004','name','Matcha','recipe_type','DRINKS','category','Iced','selling_price',160,'sold_out',true,'business_id',:'biz')) = 'ok 1', 'owner adds production recipe, Americano, sold-out Matcha');
select test.check(test.upsert('recipe_ingredients', jsonb_build_object('id','44444444-0000-0000-0000-000000000001','recipe_id','33333333-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','quantity',18,'unit','g','business_id',:'biz')) = 'ok 1'
  and test.upsert('recipe_ingredients', jsonb_build_object('id','44444444-0000-0000-0000-000000000002','recipe_id','33333333-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000002','quantity',180,'unit','ml','business_id',:'biz')) = 'ok 1'
  and test.upsert('recipe_ingredients', jsonb_build_object('id','44444444-0000-0000-0000-000000000003','recipe_id','33333333-0000-0000-0000-000000000003','ingredient_id','22222222-0000-0000-0000-000000000001','quantity',18,'unit','g','business_id',:'biz')) = 'ok 1', 'owner adds recipe lines');
select test.check(test.upsert('inventory_transactions', jsonb_build_object('id','55555555-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','INITIAL_STOCK','quantity',1000,'transaction_date','2026-10-01','business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','55555555-0000-0000-0000-000000000002','ingredient_id','22222222-0000-0000-0000-000000000002','transaction_type','INITIAL_STOCK','quantity',5000,'transaction_date','2026-10-01','business_id',:'biz'), true) = 'ok 1', 'owner adds starting stock');
select test.check(test.upsert('staff', jsonb_build_object('id','66666666-0000-0000-0000-000000000001','name','Cathy Cashier','role','CASHIER','active',true,'business_id',:'biz')) = 'ok 1'
  and test.upsert('staff', jsonb_build_object('id','66666666-0000-0000-0000-000000000002','name','Manny Manager','role','MANAGER','active',true,'business_id',:'biz')) = 'ok 1', 'owner adds cashier + manager');
select test.check(test.upsert('dining_tables', jsonb_build_object('id','77777777-0000-0000-0000-000000000005','label','Table 5','code','T5CODE','kind','TABLE','active',true,'sort_order',5,'business_id',:'biz')) = 'ok 1'
  and test.upsert('dining_tables', jsonb_build_object('id','77777777-0000-0000-0000-000000000006','label','Take-away','code','TAKE01','kind','TAKEAWAY','active',true,'sort_order',999,'business_id',:'biz')) = 'ok 1'
  and test.upsert('dining_tables', jsonb_build_object('id','77777777-0000-0000-0000-000000000007','label','Old table','code','OLDTAB','kind','TABLE','active',false,'sort_order',7,'business_id',:'biz')) = 'ok 1', 'owner adds QR tables (one inactive)');

-- ===================================================================================
-- 3. Staff PINs
-- ===================================================================================
select test.check((public.set_staff_pin('66666666-0000-0000-0000-000000000001', '1111')->>'ok')::boolean, 'set cashier PIN 1111');
select test.check((public.set_staff_pin('66666666-0000-0000-0000-000000000002', '2222')->>'ok')::boolean, 'set manager PIN 2222');
select test.check((public.set_staff_pin(:'owner_staff', '9999')->>'ok')::boolean, 'set owner PIN 9999');
select test.check(public.set_staff_pin('66666666-0000-0000-0000-000000000002', '1111')->>'error' = 'pin_in_use', 'duplicate PIN rejected');
select test.check(public.set_staff_pin('66666666-0000-0000-0000-000000000001', '12a4')->>'error' = 'invalid_pin'
  and public.set_staff_pin('66666666-0000-0000-0000-000000000001', '123')->>'error' = 'invalid_pin'
  and public.set_staff_pin('66666666-0000-0000-0000-000000000001', '1234567')->>'error' = 'invalid_pin', 'PIN must be 4-6 digits');
select test.check(jsonb_array_length(public.staff_pin_status()) = 3, 'staff_pin_status lists who has a PIN');
select test.check(test.n('select count(*) from public.staff_pins') = -1 and test.n('select count(*) from public.business_secrets') = -1, 'owner cannot read PIN hashes or the PIN secret');
select test.check(test.j(format('select to_jsonb(public.pin_hmac(%L, %L))', :'biz', '1111')) ? '__error', 'PIN hashing helper is not callable from the API');
reset role;
select test.check((select bool_and(pin_hmac !~ '^[0-9]{4,6}$' and length(pin_hmac) = 64) from staff_pins), 'PINs are stored scrambled (HMAC-SHA256), not as digits');

-- ===================================================================================
-- 4. Invites, and nobody can promote themselves to ADMIN
-- ===================================================================================
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public.create_staff_invite('MANAGER')->>'code' as invite \gset
select test.check(public.create_staff_invite('CASHIER')->>'error' = 'invalid_role', 'invite role must be ADMIN or MANAGER');
reset role;
select test.login(null);
set role anon;
select test.check((test.j(format('select public.check_invite(%L)', lower(substr(:'invite',1,5)) || '-' || lower(substr(:'invite',6)))) ->> 'valid')::boolean, 'invite code check works before sign-in (any case, with dash)');
reset role;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000f1', 'manny@example.com', jsonb_build_object('invite_code', :'invite', 'admin_name', 'Manny Login'));
select test.check((select business_id = :'biz'::uuid and role = 'MANAGER' from profiles where id = '00000000-0000-0000-0000-0000000000f1')
  and (select count(*) from businesses) = 2, 'invite signup joins the shop as MANAGER, creates no business');
do $$ begin
  insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000f2', 'x@example.com',
     jsonb_build_object('invite_code', (select code from public.staff_invites limit 1)));
  perform test.check(false, 'used invite code rejected');
exception when others then perform test.check(true, 'used invite code rejected');
end $$;
select test.check((select count(*) from profiles where id = '00000000-0000-0000-0000-0000000000f2') = 0 and (select count(*) from businesses) = 2, 'failed invite signup leaves nothing behind');
-- manager login tries to escalate
select test.login('00000000-0000-0000-0000-0000000000f1');
set role authenticated;
select test.check(public.current_role_rank() = 2, 'manager login has rank 2');
select test.run($q$update public.profiles set role = 'ADMIN' where id = '00000000-0000-0000-0000-0000000000f1'$q$) as esc1 \gset
select test.check(:'esc1' like 'ERR 42501%', 'manager cannot change own profile role to ADMIN', :'esc1');
select test.check(test.run($q$update public.staff set role = 'ADMIN' where profile_id = '00000000-0000-0000-0000-0000000000f1'$q$) = 'ok 0', 'manager cannot change own staff role');
select test.check(test.run($q$update public.profiles set active = false where id = '00000000-0000-0000-0000-0000000000a1'$q$) = 'ok 0', 'manager cannot deactivate the owner');
select test.check(test.upsert('staff', jsonb_build_object('id','66666666-0000-0000-0000-0000000000ee','name','Evil','role','ADMIN','business_id',:'biz')) like 'ERR 42501%', 'manager cannot add an ADMIN staff member');
select test.check(public.set_staff_pin('66666666-0000-0000-0000-000000000001', '4444')->>'error' = 'not_allowed', 'manager cannot set PINs');
select test.check(public.create_pairing_code('x')->>'error' = 'not_allowed' and public.create_staff_invite('ADMIN')->>'error' = 'not_allowed', 'manager cannot pair devices or invite admins');
select test.check(test.upsert('recipes', jsonb_build_object('id','33333333-0000-0000-0000-000000000003','selling_price',1,'business_id',:'biz')) like 'ERR 42501%', 'manager cannot change prices');
reset role;
select test.check((select role from profiles where id = '00000000-0000-0000-0000-0000000000f1') = 'MANAGER'
  and (select role from staff where profile_id = '00000000-0000-0000-0000-0000000000f1') = 'MANAGER', 'manager is still MANAGER after the attempts');

-- ===================================================================================
-- 5. Another business sees nothing of ours
-- ===================================================================================
select test.login('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select test.check((select count(*) from recipes) = 0 and (select count(*) from ingredients) = 0 and (select count(*) from dining_tables) = 0
  and (select count(*) from staff) = 1 and (select count(*) from profiles) = 1 and (select count(*) from settings) = 1, 'other business sees only its own rows');
select test.check(public.set_staff_pin('66666666-0000-0000-0000-000000000001', '5555')->>'error' = 'not_found', 'other business cannot set our staff PINs');
select test.check(test.run($q$update public.recipes set selling_price = 1 where id = '33333333-0000-0000-0000-000000000001'$q$) = 'ok 0', 'other business cannot change our prices');
select test.check(test.upsert('recipes', jsonb_build_object('id','33333333-0000-0000-0000-0000000000bb','name','Planted','selling_price',1,'business_id',:'biz')) like 'ERR 42501%', 'other business cannot insert into our menu');
reset role;

-- ===================================================================================
-- 6. Anonymous visitors and customers read nothing directly
-- ===================================================================================
select test.login(null);
set role anon;
select test.visible() as vis \gset
select test.check(:'vis' = '{}', 'anon key alone reads no table', :'vis');
select test.check((test.j(format('select public.public_menu(%L, %L)', :'biz', 'T5CODE'))->>'ok')::boolean, 'menu loads without login');
select test.check(test.j(format('select public.customer_register(%L, %L, null, true)', :'biz', 'X')) ? '__error', 'customer functions need a (anonymous) sign-in first');
reset role;
select test.login('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
select test.visible() as vis \gset
select test.check(:'vis' = '{}', 'signed-in customer phone reads no table', :'vis');
select test.check(test.upsert('orders', jsonb_build_object('id','12121212-0000-0000-0000-000000000001','business_id',:'biz','order_number','Q999','order_type','DINE_IN','status','NEW','subtotal',1)) like 'ERR 42501%', 'customer cannot write an order directly');
select test.check(test.upsert('customers', jsonb_build_object('id','12121212-0000-0000-0000-000000000002','business_id',:'biz','nickname','Sneaky')) like 'ERR 42501%', 'customer cannot write customers directly');
select test.check(public.staff_pin_login('1111')->>'error' = 'device_not_paired', 'customer phone cannot use staff PINs');
select test.check(public.create_pairing_code('x')->>'error' = 'not_allowed' and public.merge_customers(gen_random_uuid(), gen_random_uuid())->>'error' = 'not_allowed', 'customer cannot use admin functions');
select test.check(test.n('select count(*) from public.stock_balances_before(current_date + 1)') = 0, 'customer gets no stock figures');
reset role;
select test.check((select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')) = 'check_invite,current_business_id,current_device_id,current_role_rank,public_menu',
  'only the menu, invite check and rule helpers are callable without login');

-- ===================================================================================
-- 7. Counter device pairing
-- ===================================================================================
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public.create_pairing_code('Front Counter') as pc \gset
select test.check(:'pc'::jsonb->>'code' ~ '^[A-Z2-9]{8}$' and (:'pc'::jsonb->>'expires_at')::timestamptz between now() + interval '14 minutes' and now() + interval '16 minutes', 'pairing code: 8 characters, lasts 15 minutes');
select :'pc'::jsonb->>'code' as code1 \gset
select test.check(public.pair_device(:'code1', 'x')->>'error' = 'not_a_device', 'an email login cannot pair as a counter device');
select public.create_pairing_code('Expired one')->>'code' as code2 \gset
select public.create_pairing_code('Back Counter')->>'code' as code3 \gset
reset role;
update device_pairing_codes set expires_at = now() - interval '1 minute' where code = :'code2';
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.check(public.pair_device('WRONG234', 'Front')->>'error' = 'invalid_code', 'wrong pairing code rejected');
select test.j(format('select public.pair_device(%L, %L)', lower(substr(:'code1',1,4)) || '-' || lower(substr(:'code1',5)), 'Front Counter')) as paired \gset
select test.check((:'paired'::jsonb->>'ok')::boolean and :'paired'::jsonb->'device'->>'device_tag' = 'A', 'device paired (code typed lower-case with dash) -> letter A', :'paired');
select test.check((public.device_info()->>'paired')::boolean and public.current_business_id() = :'biz'::uuid and public.current_role_rank() = 0, 'paired device belongs to the shop, rank 0');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d2');
set role authenticated;
select test.check(public.pair_device(:'code1', 'Again')->>'error' = 'invalid_code', 'pairing code works only once');
select test.check(public.pair_device(:'code2', 'Late')->>'error' = 'invalid_code', 'expired pairing code rejected');
select test.check(public.pair_device(:'code3', 'Back Counter')->'device'->>'device_tag' = 'B', 'second device -> letter B');
reset role;
select id as dev_a from devices where auth_user_id = '00000000-0000-0000-0000-0000000000d1' \gset
select id as dev_b from devices where auth_user_id = '00000000-0000-0000-0000-0000000000d2' \gset

-- ===================================================================================
-- 8. PIN sign-in at the counter, lockout
-- ===================================================================================
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.check(public.staff_pin_login('0000')->>'error' = 'wrong_pin', 'wrong PIN rejected');
select test.check(public.staff_pin_login('1111')->'staff'->>'name' = 'Cathy Cashier', 'cashier signs in with PIN');
select test.check(public.staff_pin_login('1111', 'MANAGER', false)->>'error' = 'role_too_low', 'cashier PIN cannot approve manager actions');
select test.check(public.staff_pin_login('2222', 'MANAGER', false)->'staff'->>'role' = 'MANAGER', 'manager PIN approves an override');
select test.check(public.current_role_rank() = 0, 'a PIN sign-in gives the device no extra database rights (rank stays 0)');
select test.check(test.n('select count(*) from public.staff_pins') = -1, 'counter device cannot read PIN hashes');
reset role;
select test.check((select current_staff_id from devices where id = :'dev_a') = '66666666-0000-0000-0000-000000000001', 'device remembers who is signed in (switch), not the override');
select test.login('00000000-0000-0000-0000-0000000000d2');
set role authenticated;
select public.staff_pin_login('0001') \g /dev/null
select public.staff_pin_login('0002') \g /dev/null
select public.staff_pin_login('0003') \g /dev/null
select public.staff_pin_login('0004') \g /dev/null
select public.staff_pin_login('0005') \g /dev/null
select public.staff_pin_login('1111') as lk \gset
select test.check(:'lk'::jsonb->>'error' = 'locked' and (:'lk'::jsonb->>'retry_in')::int between 1 and 30, '5 wrong PINs lock the device (even the right PIN is refused for ~30 s)', :'lk');
reset role;
select test.check((select pin_failures = 5 and pin_locked_until > now() from devices where id = :'dev_b'), 'lock is stored on the device row');
select test.check((select pin_failures from devices where id = :'dev_a') = 0, 'lockout is per device (counter A unaffected)');
update devices set pin_locked_until = now() - interval '1 second' where id = :'dev_b';
select test.login('00000000-0000-0000-0000-0000000000d2');
set role authenticated;
select test.check(public.staff_pin_login('0006')->>'error' = 'wrong_pin', 'after the wait a wrong PIN counts again');
select test.check(public.staff_pin_login('1111')->>'error' = 'locked', 'sixth wrong PIN locks again straight away (60 s)');
reset role;
update devices set pin_locked_until = null, pin_failures = 0 where id = :'dev_b';

-- ===================================================================================
-- 9. What a paired counter device can and cannot change
-- ===================================================================================
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.check((select count(*) from recipes) = 4 and (select count(*) from staff) = 4 and (select count(*) from dining_tables) = 3, 'device reads menu, staff list, tables');
select test.check(test.run($q$update public.recipes set selling_price = 1 where id = '33333333-0000-0000-0000-000000000003'$q$) = 'ok 0', 'device cannot change prices');
select test.check(test.upsert('recipes', jsonb_build_object('id','33333333-0000-0000-0000-0000000000aa','name','Free coffee','selling_price',1,'business_id',:'biz')) like 'ERR 42501%', 'device cannot add menu items');
select test.check(test.run($q$update public.settings set tax_pct = 50$q$) = 'ok 0' and test.run($q$update public.businesses set name = 'Hacked'$q$) = 'ok 0', 'device cannot change settings or shop name');
select test.check(test.run($q$update public.staff set role = 'ADMIN' where id = '66666666-0000-0000-0000-000000000001'$q$) = 'ok 0', 'device cannot promote staff');
select test.check(test.upsert('profiles', jsonb_build_object('id','00000000-0000-0000-0000-0000000000d1','business_id',:'biz','name','Me','role','ADMIN')) like 'ERR 42501%', 'device cannot give itself an ADMIN profile');
select test.check(test.run($q$update public.devices set pin_failures = 0, active = true$q$) = 'ok 0', 'device cannot edit device records');
select test.check(test.upsert('dining_tables', jsonb_build_object('id','77777777-0000-0000-0000-0000000000aa','label','X','code','XX','business_id',:'biz')) like 'ERR 42501%', 'device cannot add QR tables');
select test.check(test.upsert('purchases', jsonb_build_object('id','45454545-0000-0000-0000-0000000000aa','ingredient_id','22222222-0000-0000-0000-000000000001','purchase_date','2026-10-01','business_id',:'biz')) like 'ERR 42501%', 'device cannot record purchases');
select test.check(test.run($q$delete from public.inventory_transactions$q$) = 'ok 0' and test.run($q$update public.inventory_transactions set quantity = 0$q$) = 'ok 0', 'device cannot edit or delete stock records');
-- the README promises "can't change ... stock records": a device can still ADD any kind
select test.upsert('inventory_transactions', jsonb_build_object('id','56565656-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','ADJUSTMENT','quantity',500,'transaction_date','2026-10-02','business_id',:'biz'), true) as adj \gset
select test.check(:'adj' like 'ERR%', 'device cannot add stock adjustments/purchases (only sale usage/returns)', :'adj');
reset role;
delete from inventory_transactions where id = '56565656-0000-0000-0000-000000000001';  -- keep the stock maths below clean

-- ===================================================================================
-- 10. Front Office: shift, sale with a stock-using modifier, retry, void, more sales
--     (rows exactly as frontoffice/pos-app.js + shared/data.js send them)
-- ===================================================================================
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.check(test.upsert('shifts', jsonb_build_object('id','88888888-0000-0000-0000-000000000001','shift_number','SHIFT-A-2026-0001','cashier_id','66666666-0000-0000-0000-000000000001',
  'cashier_name','Cathy Cashier','opened_at',now(),'closed_at',null,'status','ACTIVE','device_id',:'dev_a','store_id',:'store','opening_cash',2000,'declared_cash',null,'notes','',
  'created_at',now(),'updated_at',now(),'business_id',:'biz')) = 'ok 1', 'shift opened (opening cash 2000)');
select test.check(test.upsert('audit_log', jsonb_build_object('id','f0000000-0000-0000-0000-000000000001','action','Shift opened','actor_name','Cathy Cashier','actor_id','66666666-0000-0000-0000-000000000001','details','SHIFT-A-2026-0001','reference_id','88888888-0000-0000-0000-000000000001','at',now(),'business_id',:'biz'), true) = 'ok 1', 'audit entry written');
-- sale 1: Iced Latte 16oz + Extra shot = 150+20+30 = 200, service 10% = 20, total 220, cash
\set s1 '99999999-0000-0000-0000-000000000001'
select jsonb_build_object('id',:'s1','transaction_number','POS-A-2026-000001','transaction_date',now(),'status','COMPLETED','cashier_name','Cathy Cashier','cashier_id','66666666-0000-0000-0000-000000000001',
  'shift_id','88888888-0000-0000-0000-000000000001','device_id',:'dev_a','store_id',:'store','customer_id',null,'order_id',null,'subtotal',200,'discount_type',null,'discount_value',0,
  'discount_amount',0,'tax_amount',0,'service_charge_amount',20,'grand_total',220,'notes','','created_at',now(),'business_id',:'biz') as sale1 \gset
select test.upsert('sales', :'sale1') as w1 \gset
select test.check(:'w1' = 'ok 1', 'sale uploaded', :'w1');
select test.check(test.upsert('sale_items', jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000001','sale_id',:'s1','recipe_id','33333333-0000-0000-0000-000000000001','name','Iced Latte','quantity',1,'unit_price',200,'line_total',200,
  'modifiers','[{"group":"Size","label":"16oz","priceDelta":20,"ingredientId":"22222222-0000-0000-0000-000000000002","ingredientQtyDelta":60},{"group":"Add-ons","label":"Extra shot","priceDelta":30,"ingredientId":"22222222-0000-0000-0000-000000000001","ingredientQtyDelta":18}]'::jsonb,
  'created_at',now(),'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('payments', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-000000000001','sale_id',:'s1','method','CASH','amount',220,'tendered',500,'change',280,'reference','','status','CONFIRMED','created_at',now(),'business_id',:'biz'), true) = 'ok 1',
  'sale line + cash payment uploaded');
select test.check(test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','SALE_USAGE','quantity',18,'reference_id',:'s1','transaction_date',current_date,'notes','Sold','business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000002','ingredient_id','22222222-0000-0000-0000-000000000002','transaction_type','SALE_USAGE','quantity',180,'reference_id',:'s1','transaction_date',current_date,'notes','Sold','business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000003','ingredient_id','22222222-0000-0000-0000-000000000002','transaction_type','SALE_USAGE','quantity',60,'reference_id',:'s1','transaction_date',current_date,'notes','Modifier 16oz','business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000004','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','SALE_USAGE','quantity',18,'reference_id',:'s1','transaction_date',current_date,'notes','Modifier Extra shot','business_id',:'biz'), true) = 'ok 1',
  'stock usage uploaded (recipe + modifier extras)');
select test.check((select qty from public.stock_balances_before(current_date + 1) where ingredient_id = '22222222-0000-0000-0000-000000000001') = 964
  and (select qty from public.stock_balances_before(current_date + 1) where ingredient_id = '22222222-0000-0000-0000-000000000002') = 4760, 'stock after sale: beans 1000-18-18 = 964, milk 5000-180-60 = 4760');
-- the tablet resends the same records (outbox retry after a dropped connection)
select test.check(test.upsert('sales', :'sale1') = 'ok 1'
  and test.upsert('payments', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-000000000001','sale_id',:'s1','method','CASH','amount',220,'business_id',:'biz'), true) = 'ok 0'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','SALE_USAGE','quantity',18,'transaction_date',current_date,'business_id',:'biz'), true) = 'ok 0', 'resending the same sale is accepted and ignored');
select test.check((select count(*) from sales where id = :'s1') = 1 and (select count(*) from payments where sale_id = :'s1') = 1
  and (select qty from public.stock_balances_before(current_date + 1) where ingredient_id = '22222222-0000-0000-0000-000000000001') = 964, 'no duplicate sale, payment or stock deduction after a resend');
-- void, approved by the manager (approved_by = manager staff id, as the app sends it)
select test.check(test.upsert('refunds', jsonb_build_object('id','dddddddd-0000-0000-0000-000000000001','sale_id',:'s1','shift_id','88888888-0000-0000-0000-000000000001','type','VOID','amount',220,'reason','Wrong order',
  'items','[]'::jsonb,'approved_by','66666666-0000-0000-0000-000000000002','approved_by_name','Manny Manager','date',now(),'notes','','created_at',now(),'business_id',:'biz'), true) = 'ok 1', 'void record uploaded');
select test.check(test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000011','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','SALE_REVERSAL','quantity',18,'reference_id','dddddddd-0000-0000-0000-000000000001','transaction_date',current_date,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000012','ingredient_id','22222222-0000-0000-0000-000000000002','transaction_type','SALE_REVERSAL','quantity',180,'reference_id','dddddddd-0000-0000-0000-000000000001','transaction_date',current_date,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000013','ingredient_id','22222222-0000-0000-0000-000000000002','transaction_type','SALE_REVERSAL','quantity',60,'reference_id','dddddddd-0000-0000-0000-000000000001','transaction_date',current_date,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000014','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','SALE_REVERSAL','quantity',18,'reference_id','dddddddd-0000-0000-0000-000000000001','transaction_date',current_date,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('sales', (:'sale1'::jsonb) || '{"status":"VOIDED"}') = 'ok 1', 'void returns stock incl. modifier extras, sale marked VOIDED');
select test.check((select status from sales where id = :'s1') = 'VOIDED'
  and (select qty from public.stock_balances_before(current_date + 1) where ingredient_id = '22222222-0000-0000-0000-000000000001') = 1000
  and (select qty from public.stock_balances_before(current_date + 1) where ingredient_id = '22222222-0000-0000-0000-000000000002') = 5000, 'after the void stock is back to 1000 g / 5000 ml');
-- sale 2: Iced Latte 12oz + Oat milk (175) + Americano (110) = 285, service 28.50, total 313.50, cash
select test.check(test.upsert('sales', jsonb_build_object('id','99999999-0000-0000-0000-000000000002','transaction_number','POS-A-2026-000002','transaction_date',now(),'status','COMPLETED','cashier_name','Cathy Cashier','cashier_id','66666666-0000-0000-0000-000000000001',
    'shift_id','88888888-0000-0000-0000-000000000001','device_id',:'dev_a','store_id',:'store','subtotal',285,'discount_value',0,'discount_amount',0,'tax_amount',0,'service_charge_amount',28.5,'grand_total',313.5,'notes','','created_at',now(),'business_id',:'biz')) = 'ok 1'
  and test.upsert('sale_items', jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000021','sale_id','99999999-0000-0000-0000-000000000002','recipe_id','33333333-0000-0000-0000-000000000001','name','Iced Latte','quantity',1,'unit_price',175,'line_total',175,
    'modifiers','[{"group":"Size","label":"12oz","priceDelta":0,"ingredientId":null,"ingredientQtyDelta":0},{"group":"Add-ons","label":"Oat milk","priceDelta":25,"ingredientId":null,"ingredientQtyDelta":0}]'::jsonb,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('sale_items', jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000022','sale_id','99999999-0000-0000-0000-000000000002','recipe_id','33333333-0000-0000-0000-000000000003','name','Americano','quantity',1,'unit_price',110,'line_total',110,'modifiers','[]'::jsonb,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('payments', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-000000000002','sale_id','99999999-0000-0000-0000-000000000002','method','CASH','amount',313.5,'tendered',500,'change',186.5,'reference','','status','CONFIRMED','business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000021','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','SALE_USAGE','quantity',18,'reference_id','99999999-0000-0000-0000-000000000002','transaction_date',current_date,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000022','ingredient_id','22222222-0000-0000-0000-000000000002','transaction_type','SALE_USAGE','quantity',180,'reference_id','99999999-0000-0000-0000-000000000002','transaction_date',current_date,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000023','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','SALE_USAGE','quantity',18,'reference_id','99999999-0000-0000-0000-000000000002','transaction_date',current_date,'business_id',:'biz'), true) = 'ok 1',
  'sale 2 (cash, 313.50) uploaded');
-- sale 3: 2 x Americano = 220, service 22, total 242, GCash; then 1 Americano refunded (110)
select test.check(test.upsert('sales', jsonb_build_object('id','99999999-0000-0000-0000-000000000003','transaction_number','POS-A-2026-000003','transaction_date',now(),'status','COMPLETED','cashier_name','Cathy Cashier','cashier_id','66666666-0000-0000-0000-000000000001',
    'shift_id','88888888-0000-0000-0000-000000000001','device_id',:'dev_a','store_id',:'store','subtotal',220,'discount_value',0,'discount_amount',0,'tax_amount',0,'service_charge_amount',22,'grand_total',242,'notes','','created_at',now(),'business_id',:'biz')) = 'ok 1'
  and test.upsert('sale_items', jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000031','sale_id','99999999-0000-0000-0000-000000000003','recipe_id','33333333-0000-0000-0000-000000000003','name','Americano','quantity',2,'unit_price',110,'line_total',220,'modifiers','[]'::jsonb,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('payments', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-000000000003','sale_id','99999999-0000-0000-0000-000000000003','method','GCASH','amount',242,'reference','123','status','CONFIRMED','business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000031','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','SALE_USAGE','quantity',36,'reference_id','99999999-0000-0000-0000-000000000003','transaction_date',current_date,'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('refunds', jsonb_build_object('id','dddddddd-0000-0000-0000-000000000003','sale_id','99999999-0000-0000-0000-000000000003','shift_id','88888888-0000-0000-0000-000000000001','type','PARTIAL_REFUND','amount',110,'reason','Spilled',
     'items','[{"quantity":1}]'::jsonb,'approved_by','66666666-0000-0000-0000-000000000002','approved_by_name','Manny Manager','date',now(),'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('inventory_transactions', jsonb_build_object('id','cccccccc-0000-0000-0000-000000000032','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','SALE_REVERSAL','quantity',18,'reference_id','dddddddd-0000-0000-0000-000000000003','transaction_date',current_date,'business_id',:'biz'), true) = 'ok 1'
  and test.patch('sales', '99999999-0000-0000-0000-000000000003', '{"status":"PARTIALLY_REFUNDED"}') = 'ok 1',
  'sale 3 (GCash 242) + partial refund 110 uploaded');
select test.check(test.upsert('cash_movements', jsonb_build_object('id','eeeeeeee-0000-0000-0000-000000000001','shift_id','88888888-0000-0000-0000-000000000001','type','PAY_IN','amount',100,'reason','Change fund','performed_by','66666666-0000-0000-0000-000000000001','performed_by_name','Cathy Cashier','at',now(),'business_id',:'biz'), true) = 'ok 1'
  and test.upsert('cash_movements', jsonb_build_object('id','eeeeeeee-0000-0000-0000-000000000002','shift_id','88888888-0000-0000-0000-000000000001','type','PAY_OUT','amount',50,'reason','Ice','performed_by','66666666-0000-0000-0000-000000000001','performed_by_name','Cathy Cashier','at',now(),'business_id',:'biz'), true) = 'ok 1',
  'pay-in 100 and pay-out 50 uploaded');
-- held order: park it, then cancel it (lines + sale removed while HELD)
select test.check(test.upsert('sales', jsonb_build_object('id','99999999-0000-0000-0000-000000000004','transaction_number','POS-A-2026-000004','transaction_date',now(),'status','HELD','cashier_name','Cathy Cashier','cashier_id','66666666-0000-0000-0000-000000000001','device_id',:'dev_a','subtotal',110,'grand_total',121,'business_id',:'biz')) = 'ok 1'
  and test.upsert('sale_items', jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000041','sale_id','99999999-0000-0000-0000-000000000004','recipe_id','33333333-0000-0000-0000-000000000003','name','Americano','quantity',1,'unit_price',110,'line_total',110,'business_id',:'biz'), true) = 'ok 1'
  and test.run($q$delete from public.sale_items where business_id = public.current_business_id() and id in ('aaaaaaaa-0000-0000-0000-000000000041')$q$) = 'ok 1'
  and test.run($q$delete from public.sales where business_id = public.current_business_id() and id in ('99999999-0000-0000-0000-000000000004')$q$) = 'ok 1', 'held order parked, then cancelled (deleted) at the counter');
select test.check(test.run($q$delete from public.sale_items where id = 'aaaaaaaa-0000-0000-0000-000000000021'$q$) = 'ok 0'
  and test.run($q$delete from public.sales where id = '99999999-0000-0000-0000-000000000002'$q$) = 'ok 0'
  and test.run($q$delete from public.payments where sale_id = '99999999-0000-0000-0000-000000000002'$q$) = 'ok 0', 'a completed sale, its lines and payment cannot be deleted directly');
reset role;

-- ===================================================================================
-- 11. Controls a counter device can get around (expected secure behaviour)
--     A paired tablet's login is enough; no staff PIN is involved in any of these.
-- ===================================================================================
-- (a) changing a completed sale's money
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.upsert('sales', jsonb_build_object('id','99999999-0000-0000-0000-000000000005','transaction_number','POS-A-2026-000005','transaction_date',now(),'status','COMPLETED','cashier_name','Cathy Cashier','cashier_id','66666666-0000-0000-0000-000000000001','device_id',:'dev_a','subtotal',500,'service_charge_amount',50,'grand_total',550,'business_id',:'biz')) \g /dev/null
select test.upsert('payments', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-000000000005','sale_id','99999999-0000-0000-0000-000000000005','method','CASH','amount',550,'business_id',:'biz'), true) \g /dev/null
select test.patch('sales', '99999999-0000-0000-0000-000000000005', '{"grand_total":1}') as tamper \gset
select test.check(:'tamper' <> 'ok 1', 'counter cannot change the total of a completed sale', :'tamper');
-- (b) turning a completed sale back into a held order, then deleting it (payment goes with it)
select test.patch('sales', '99999999-0000-0000-0000-000000000005', '{"status":"HELD"}') as reheld \gset
select test.run($q$delete from public.sales where id = '99999999-0000-0000-0000-000000000005'$q$) as erase \gset
reset role;
select test.check((select count(*) from sales where id = '99999999-0000-0000-0000-000000000005') = 1
  and (select count(*) from payments where sale_id = '99999999-0000-0000-0000-000000000005') = 1,
  'completed cash sale cannot be made to disappear (re-hold + delete)', 'update: ' || :'reheld' || ' / delete: ' || :'erase' || ' / sale rows left: ' || (select count(*) from sales where id = '99999999-0000-0000-0000-000000000005') || ', payments left: ' || (select count(*) from payments where sale_id = '99999999-0000-0000-0000-000000000005'));
-- (c) a void/refund approved by a cashier
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.upsert('refunds', jsonb_build_object('id','dddddddd-0000-0000-0000-0000000000c5','sale_id','99999999-0000-0000-0000-000000000002','type','FULL_REFUND','amount',313.5,'reason','cashier did it',
   'approved_by','66666666-0000-0000-0000-000000000001','approved_by_name','Cathy Cashier','date',now(),'business_id',:'biz'), true) as cashier_refund \gset
select test.check(:'cashier_refund' like 'ERR%', 'a refund approved by a CASHIER is refused by the database', :'cashier_refund');
reset role;
delete from refunds where id = 'dddddddd-0000-0000-0000-0000000000c5';  -- keep the shift maths below clean

-- ===================================================================================
-- 12. QR customer flow
-- ===================================================================================
select test.login(null);
set role anon;
select public.public_menu(:'biz', 't5code') as menu \gset
reset role;
select test.check(:'menu'::jsonb->'table'->>'label' = 'Table 5' and (:'menu'::jsonb->'shop'->>'ordering_open')::boolean, 'menu: table code is case-insensitive, ordering open');
select test.check(jsonb_array_length(:'menu'::jsonb->'items') = 3, 'menu shows sellable items only (production recipe hidden)');
select test.check((select bool_and(not (o ? 'ingredientId') and not (o ? 'ingredientQtyDelta')) from jsonb_array_elements(:'menu'::jsonb->'items') i,
   jsonb_array_elements(i->'modifier_groups') g, jsonb_array_elements(g->'options') o)
   and not (:'menu'::jsonb::text ~ '22222222-0000'), 'public menu hides ingredient links and costs');
select test.check((select (i->>'available')::boolean from jsonb_array_elements(:'menu'::jsonb->'items') i where i->>'name' = 'Matcha') = false, 'sold-out item shown as unavailable');
select test.login(null);
set role anon;
select test.check(public.public_menu(:'biz', 'OLDTAB')->>'table_error' = 'unknown_table' and public.public_menu(gen_random_uuid(), 'T5CODE')->>'error' = 'unknown_shop', 'inactive table / unknown shop');
reset role;
-- customer phone #1
select test.login('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
select test.check(public.customer_me(:'biz')->'customer' = 'null'::jsonb, 'first visit: customer unknown');
select test.check(public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000003","quantity":1}]')->>'error' = 'not_registered', 'cannot order before giving a nickname');
select test.check(public.customer_register(:'biz', 'Zed', '0917 123 4567', false)->>'error' = 'consent_required', 'consent required');
select test.check(public.customer_register(:'biz', '   ', null, true)->>'error' = 'nickname_required', 'blank nickname rejected');
select test.check(public.customer_register(:'biz', 'Zed', '12345', true)->>'error' = 'invalid_phone', 'bad phone rejected');
select public.customer_register(:'biz', 'Zed', '0917 123 4567', true) as reg \gset
select test.check(:'reg'::jsonb->'customer'->>'nickname' = 'Zed' and :'reg'::jsonb->'customer'->>'phone_hint' = '•••• 4567', 'registered with nickname + phone (shown masked)', :'reg');
select test.check(public.customer_me(:'biz')->'customer'->>'nickname' = 'Zed', 'returning visit on the same phone: recognised (Welcome back)');
reset role;
select test.check((select phone = '639171234567' and consent_at is not null from customers where nickname = 'Zed'), 'phone stored normalised (639171234567) with consent time');
-- price tampering + option rules
select test.login('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
select test.check(public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[]')->>'error' = 'empty_order', 'empty order rejected');
select test.check(public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1}]')->>'error' = 'missing_option', 'required Size enforced');
select test.check(public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"options":[{"group_id":"g-size","option_id":"o-12"},{"group_id":"g-size","option_id":"o-16"}]}]')->>'error' = 'invalid_option', 'two sizes rejected');
select test.check(public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"options":[{"group_id":"g-size","option_id":"o-12"},{"group_id":"g-size","option_id":"o-free"}]}]')->>'error' = 'invalid_option', 'made-up option rejected');
select test.check(public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000002","quantity":1}]')->>'error' = 'invalid_item', 'non-menu (production) item rejected');
select test.check(public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000004","quantity":1}]')->>'error' = 'sold_out', 'sold-out item rejected');
select test.check(public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000003","quantity":0}]')->>'error' = 'invalid_quantity'
  and public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000003","quantity":21}]')->>'error' = 'invalid_quantity'
  and public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000003","quantity":"1; drop"}]')->>'error' = 'invalid_quantity', 'silly quantities rejected');
select test.check(public.place_order(:'biz', 'OLDTAB', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000003","quantity":1}]')->>'error' = 'unknown_table', 'inactive table cannot order');
select public.place_order(:'biz', 'T5CODE', 'DINE_IN',
  '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":2,"price":1,"unit_price":1,"line_total":1,"priceDelta":-150,
     "options":[{"group_id":"g-size","option_id":"o-16","priceDelta":-999},{"group_id":"g-add","option_id":"o-shot"}],"note":"less ice"}]', 'Pls hurry') as ord \gset
select test.check((:'ord'::jsonb->>'ok')::boolean and (:'ord'::jsonb->'order'->>'subtotal')::numeric = 400, 'server price: (150+20+30) x 2 = 400, prices sent by the phone ignored', :'ord');
select test.check(:'ord'::jsonb->'order'->>'order_number' = 'Q001' and :'ord'::jsonb->'order'->>'table_label' = 'Table 5', 'order number Q001 + table label');
select :'ord'::jsonb->'order'->>'id' as order1 \gset
select test.check(jsonb_array_length(public.my_orders(:'biz')->'orders') = 1 and public.my_orders(:'biz')->'orders'->0->>'status' = 'NEW', 'customer sees own order');
select test.check((select count(*) from orders) = 0 and (select count(*) from order_items) = 0, 'customer still cannot read the orders table directly');
select public.place_order(:'biz', 'T5CODE', 'TAKEAWAY', '[{"recipe_id":"33333333-0000-0000-0000-000000000003","quantity":1}]')->'order'->>'id' as order2 \gset
select test.check(public.cancel_my_order(:'biz', :'order2')->>'ok' = 'true', 'customer cancels a NEW order');
select test.check(public.cancel_my_order(:'biz', :'order2')->>'error' = 'cannot_cancel', 'cannot cancel twice');
reset role;
select test.check((select status = 'CANCELLED' and cancelled_at is not null and order_type = 'TAKEAWAY' from orders where id = :'order2'), 'cancel stored with time');
-- customer #3 (a different person) sees none of Zed's orders and cannot cancel them
select test.login('00000000-0000-0000-0000-0000000000c3');
set role authenticated;
select test.check((public.customer_register(:'biz', 'Ana', null, true)->>'ok')::boolean, 'second customer registers without a phone');
select test.check(jsonb_array_length(public.my_orders(:'biz')->'orders') = 0, 'another customer cannot see Zed''s orders');
select test.check(public.cancel_my_order(:'biz', :'order1')->>'error' = 'cannot_cancel', 'another customer cannot cancel Zed''s order');
reset role;
-- customer phone #2: same person on a new phone
select test.login('00000000-0000-0000-0000-0000000000c2');
set role authenticated;
select test.check(public.customer_register(:'biz', 'Zack', '09171234567', true)->>'error' = 'phone_exists', 'phone already used by another nickname');
select test.check(public.customer_link_phone(:'biz', 'Zedd', '+639171234567')->>'error' = 'no_match', 'relink needs the right nickname');
select test.check(public.customer_link_phone(:'biz', 'zed', '+63 917 123 4567')->'customer'->>'nickname' = 'Zed', 'relink with nickname (any case) + phone');
select test.check(public.customer_me(:'biz')->'customer'->>'nickname' = 'Zed', 'new phone now greets Zed');
select test.check(jsonb_array_length(public.my_orders(:'biz')->'orders') = 2, 'relinked phone sees Zed''s orders (same customer)');
select test.check((public.customer_forget_device(:'biz')->>'ok')::boolean and public.customer_me(:'biz')->'customer' = 'null'::jsonb, '"Not Zed?" unlinks this phone only');
reset role;
select test.login('00000000-0000-0000-0000-000000000099');
set role authenticated;
select public.customer_link_phone(:'biz', 'a', '09170000001') \g /dev/null
select public.customer_link_phone(:'biz', 'b', '09170000002') \g /dev/null
select public.customer_link_phone(:'biz', 'c', '09170000003') \g /dev/null
select public.customer_link_phone(:'biz', 'd', '09170000004') \g /dev/null
select public.customer_link_phone(:'biz', 'e', '09170000005') \g /dev/null
select test.check(public.customer_link_phone(:'biz', 'zed', '09171234567')->>'error' = 'too_many_attempts', 'relink guessing limited to 5 tries an hour per login');
reset role;
-- ordering switched off
update settings set qr_ordering_enabled = false where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
select test.check(public.place_order(:'biz', 'T5CODE', 'DINE_IN', '[{"recipe_id":"33333333-0000-0000-0000-000000000003","quantity":1}]')->>'error' = 'ordering_closed', 'no orders while QR ordering is off');
reset role;
update settings set qr_ordering_enabled = true where business_id = :'biz';

-- ===================================================================================
-- 13. Counter handles the QR order through to completion (fo-extra.js / pos-app.js)
-- ===================================================================================
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.check((select count(*) from orders where status in ('NEW','ACCEPTED','READY')) = 1, 'counter sees the open QR order');
select test.check((select (modifiers->0->>'ingredientId') = '22222222-0000-0000-0000-000000000002' and (modifiers->0->>'ingredientQtyDelta')::numeric = 60 and unit_price = 200 and quantity = 2
   from order_items where order_id = :'order1'), 'order line keeps the server price and the modifier stock links');
select test.check(test.patch('orders', :'order1', '{"status":"ACCEPTED","status_reason":null,"handled_by_name":"Cathy Cashier","sale_id":null}') = 'ok 1', 'accept');
reset role;
select test.login('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
select test.check(public.my_orders(:'biz')->'orders'->0->>'status' = 'ACCEPTED' and public.cancel_my_order(:'biz', :'order1')->>'error' = 'cannot_cancel', 'customer sees ACCEPTED and can no longer cancel');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.check(test.patch('orders', :'order1', '{"status":"READY","handled_by_name":"Cathy Cashier"}') = 'ok 1', 'mark ready');
-- ring up & pay: cart built from order_items, totals 400 + 10% = 440, cash
select customer_id as cust from orders where id = :'order1' \gset
select jsonb_build_object('id','99999999-0000-0000-0000-000000000006','transaction_number','POS-A-2026-000006','transaction_date',now(),'status','COMPLETED','cashier_name','Cathy Cashier','cashier_id','66666666-0000-0000-0000-000000000001',
    'shift_id','88888888-0000-0000-0000-000000000001','device_id',:'dev_a','store_id',:'store','customer_id',:'cust','order_id',:'order1','subtotal',400,'discount_value',0,'discount_amount',0,'tax_amount',0,'service_charge_amount',40,'grand_total',440,'notes','','created_at',now(),'business_id',:'biz') as qsale \gset
select test.check(test.upsert('sales', :'qsale') = 'ok 1'
  and test.upsert('sale_items', (select jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000061','sale_id','99999999-0000-0000-0000-000000000006','recipe_id',recipe_id,'name',name,'quantity',quantity,'unit_price',unit_price,'line_total',unit_price*quantity,'modifiers',modifiers,'business_id',:'biz') from order_items where order_id = :'order1'), true) = 'ok 1'
  and test.upsert('payments', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-000000000006','sale_id','99999999-0000-0000-0000-000000000006','method','CASH','amount',440,'tendered',500,'change',60,'status','CONFIRMED','business_id',:'biz'), true) = 'ok 1',
  'QR order rung up and paid (440 cash)');
select coalesce(qty, 0) as beans_before from public.stock_balances_before(current_date + 1) where ingredient_id = '22222222-0000-0000-0000-000000000001' \gset
select coalesce(qty, 0) as milk_before from public.stock_balances_before(current_date + 1) where ingredient_id = '22222222-0000-0000-0000-000000000002' \gset
-- stock: recipe lines x qty + each modifier's ingredientQtyDelta x qty (completeSale())
select bool_and(test.upsert('inventory_transactions', jsonb_build_object('id', gen_random_uuid(), 'ingredient_id', x.ing, 'transaction_type', 'SALE_USAGE', 'quantity', x.q, 'reference_id', '99999999-0000-0000-0000-000000000006', 'transaction_date', current_date, 'business_id', :'biz'), true) = 'ok 1') as inv_ok
from (
  select ri.ingredient_id as ing, ri.quantity * oi.quantity as q from order_items oi join recipe_ingredients ri on ri.recipe_id = oi.recipe_id where oi.order_id = :'order1'
  union all
  select (m->>'ingredientId')::uuid, (m->>'ingredientQtyDelta')::numeric * oi.quantity from order_items oi, jsonb_array_elements(oi.modifiers) m
   where oi.order_id = :'order1' and m->>'ingredientId' is not null and (m->>'ingredientQtyDelta')::numeric <> 0
) x \gset
select test.check(:'inv_ok'::boolean
  and (select qty from public.stock_balances_before(current_date + 1) where ingredient_id = '22222222-0000-0000-0000-000000000001') = :'beans_before'::numeric - 72
  and (select qty from public.stock_balances_before(current_date + 1) where ingredient_id = '22222222-0000-0000-0000-000000000002') = :'milk_before'::numeric - 480,
  'QR sale deducts (18+18) x 2 = 72 g beans and (180+60) x 2 = 480 ml milk');
select test.check(test.patch('orders', :'order1', jsonb_build_object('status','COMPLETED','sale_id','99999999-0000-0000-0000-000000000006','handled_by_name','Cathy Cashier')) = 'ok 1', 'order completed and linked to the sale');
reset role;
select test.check((select status = 'COMPLETED' and accepted_at is not null and ready_at is not null and completed_at is not null and sale_id = '99999999-0000-0000-0000-000000000006' from orders where id = :'order1'), 'order times + sale link stored');
select test.check((select visit_count = 1 and order_count = 1 and total_spent = 440 from customers where id = :'cust'), 'customer visit + spend counted (1 visit, 440)');
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.upsert('sales', :'qsale') \g /dev/null
select test.upsert('sales', (:'qsale'::jsonb) || '{"notes":"receipt reprinted"}') \g /dev/null
reset role;
select test.check((select visit_count = 1 and order_count = 1 and total_spent = 440 from customers where id = :'cust'), 'resending / re-saving the sale does not count the visit twice');
select test.login('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
select test.check(public.my_orders(:'biz')->'orders'->0->>'status' = 'COMPLETED' and (public.customer_me(:'biz')->'customer'->>'visit_count')::int = 1, 'customer sees COMPLETED and 1 visit on the club card');
reset role;
-- a device may also edit loyalty numbers directly (expected: only the database should)
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.patch('customers', :'cust', '{"visit_count":99,"total_spent":99999}') as loyal \gset
reset role;
select test.check((select visit_count from customers where id = :'cust') = 1, 'counter cannot overwrite a customer''s visit count / spend', :'loyal' || ', visit_count now ' || (select visit_count from customers where id = :'cust'));
update customers set visit_count = 1, total_spent = 440 where id = :'cust';

-- ===================================================================================
-- 14. Shift close and reconciliation
-- ===================================================================================
-- expected (original shiftMetrics): non-voided sales 2 (313.50 cash), 3 (242 GCash), 6 (440 cash)
--   gross subtotal 905, grand totals 995.50, refunds 110 (GCash -> not from drawer), voids 220
--   expected cash = 2000 + 313.50 + 440 + 100 - 50 = 2803.50; declared 2800 -> variance -3.50
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.check(test.upsert('shifts', jsonb_build_object('id','88888888-0000-0000-0000-000000000001','shift_number','SHIFT-A-2026-0001','cashier_id','66666666-0000-0000-0000-000000000001',
  'cashier_name','Cathy Cashier','opened_at',(select opened_at from shifts where id = '88888888-0000-0000-0000-000000000001'),'closed_at',now(),'status','CLOSED','device_id',:'dev_a','store_id',:'store','opening_cash',2000,
  'declared_cash',2800,'expected_cash',2803.5,'cash_variance',-3.5,'gross_sales',905,'net_sales',885.5,'cash_sales',753.5,'card_sales',0,'other_sales',242,'refunds_total',110,'voids_total',220,'transaction_count',3,
  'notes','','created_at',now(),'updated_at',now(),'business_id',:'biz')) = 'ok 1', 'shift closed by the counter');
reset role;
with s as (select * from shifts where id = '88888888-0000-0000-0000-000000000001'),
     nv as (select x.*, (select method from payments p where p.sale_id = x.id order by created_at limit 1) as m from sales x, s where x.shift_id = s.id and x.status not in ('HELD','VOIDED')),
     rv as (select r.*, (select method from payments p where p.sale_id = r.sale_id order by created_at limit 1) as m from refunds r, s where r.shift_id = s.id)
select test.check(
  (select sum(subtotal) from nv) = 905 and (select sum(grand_total) from nv) = 995.5 and (select count(*) from nv) = 3
  and (select coalesce(sum(amount),0) from rv where type <> 'VOID') = 110 and (select coalesce(sum(amount),0) from rv where type = 'VOID') = 220
  and (select s.opening_cash + (select coalesce(sum(grand_total),0) from nv where m = 'CASH') - (select coalesce(sum(amount),0) from rv where type <> 'VOID' and m = 'CASH')
        + (select coalesce(sum(case when type='PAY_IN' then amount else -amount end),0) from cash_movements c where c.shift_id = s.id) from s) = 2803.5
  and (select expected_cash = 2803.5 and cash_variance = -3.5 and status = 'CLOSED' from s),
  'database rows reconcile with the closed shift: expected cash 2803.50 (void not double-counted), variance -3.50');
select test.check((select qty from stock_levels(:'biz') where ingredient_id = '22222222-0000-0000-0000-000000000001') = 1000 - 36 - 36 + 18 - 72
  and (select qty from stock_levels(:'biz') where ingredient_id = '22222222-0000-0000-0000-000000000002') = 5000 - 180 - 480,
  'final stock: beans 874 g, milk 4340 ml');

-- ===================================================================================
-- 15. Unpairing and removing devices
-- ===================================================================================
select test.login('00000000-0000-0000-0000-0000000000d2');
set role authenticated;
select test.check(public.unpair_this_device('0000')->>'error' = 'wrong_pin', 'unpair needs a PIN');
select test.check(public.unpair_this_device('2222')->>'error' = 'role_too_low', 'unpair needs an ADMIN PIN (manager refused)');
select test.check((public.unpair_this_device('9999')->>'ok')::boolean and (public.device_info()->>'paired')::boolean = false, 'admin PIN unpairs the tablet');
select test.check((select count(*) from recipes) = 0, 'unpaired tablet reads nothing');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select test.check(test.patch('devices', :'dev_a', '{"active":false}') = 'ok 1', 'owner removes counter A in the Back Office');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.check((select count(*) from recipes) = 0 and public.staff_pin_login('1111')->>'error' = 'device_not_paired', 'removed tablet loses access at once');
select test.check(test.upsert('sales', jsonb_build_object('id','99999999-0000-0000-0000-0000000000ff','status','COMPLETED','grand_total',1,'business_id',:'biz')) like 'ERR 42501%', 'removed tablet cannot upload sales');
reset role;

-- ===================================================================================
-- summary
-- ===================================================================================
\echo
select format('BUILD R DATABASE TESTS: %s checks, %s ok, %s FAILED', count(*), count(*) filter (where ok), count(*) filter (where not ok)) from test.results;
select format('  FAILED #%s: %s%s', n, msg, coalesce('   [got: ' || left(detail, 300) || ']', '')) from test.results where not ok order by n;
do $$ begin if exists (select 1 from test.results where not ok) then raise exception 'some Build R checks FAILED (see list above)'; end if; end $$;
