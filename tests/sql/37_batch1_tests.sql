-- Checks for cccc/supabase/007_batch1.sql + the batch-1 audit (database engineer, 2026-10-25).
-- Needs a FRESH database with 004 + 005 + 006 + 007 installed:
--   tests/reset_db.sh "" db_sec        (installs 004..007)
--   psql -h /tmp -p 54329 -U postgres -d db_sec -v ON_ERROR_STOP=1 -f tests/sql/37_batch1_tests.sql
-- Prints "ok  ..." / "FAIL ..." for every check and keeps going.
--   1. T2: counter pay-in / pay-out of ₱0 or less -> AMOUNT_NOT_POSITIVE (nothing saved, next ops still run)
--   2. Back Office categories manager via apply_changes (add / rename / move ingredients / delete)
--   3. Deleting several recipes in one apply_changes call; what a recipe still in use answers
--   4. A big Excel-import call (70 recipes, 150 ingredients, 600 recipe lines, 150 "starting price" purchases)
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
-- run SQL; 'NO ERROR' or '<sqlstate> <message>'
create or replace function test.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'NO ERROR'; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
-- one counter pay-in / pay-out upload -> 'ok' or the error code
create or replace function test.cm(p_id uuid, p_data jsonb) returns text language sql as $$
  select case when r->>'status' = 'error' then r->>'message' else r->>'status' end
  from (select public.fo_sync('device-key-37-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(),
          'type', 'cash_movement', 'data', jsonb_build_object('id', p_id, 'shift_id', '88888888-0000-0000-0037-000000000001',
          'type', 'PAY_OUT', 'reason', 'Ice', 'performed_by', '66666666-0000-0000-0037-000000000001', 'at', now()) || p_data)))->0 as r) x
$$;
grant usage on schema test to anon, authenticated; grant execute on all functions in schema test to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

-- ===== 0. a shop with a cashier, a paired counter and an open shift =====
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
insert into public.staff(id, business_id, name, role) values ('66666666-0000-0000-0037-000000000001', :'biz', 'Cathy Cashier', 'CASHIER');
insert into public.device_pairing_codes(code, business_id, device_name, expires_at) values ('PAIR37', :'biz', 'Front', now() + interval '1 hour');
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0037-0000000000d1', true);
select test.login('00000000-0000-0000-0037-0000000000d1'); set role authenticated;
select test.chk(public.redeem_device_pairing('PAIR37', 'device-key-37-0001-abcdef', 'Front')->'device' is not null, 'setup: counter paired');
select test.chk(public.fo_sync('device-key-37-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', 'shift_open',
  'data', jsonb_build_object('id', '88888888-0000-0000-0037-000000000001', 'shift_number', 'SHIFT-37', 'cashier_id', '66666666-0000-0000-0037-000000000001',
  'cashier_name', 'Cathy Cashier', 'opened_at', now(), 'opening_cash', 1000))))->0->>'status' = 'ok', 'setup: shift opened');

-- ===== 1. T2: pay-in / pay-out amount must be above ₱0 =====
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000001', '{"amount":0}') = 'AMOUNT_NOT_POSITIVE', 'T2: amount 0 -> AMOUNT_NOT_POSITIVE',
                test.cm('cdcd0037-0000-0000-0000-000000000001', '{"amount":0}'));
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000002', '{"amount":-5}') = 'AMOUNT_NOT_POSITIVE', 'T2: amount -5 -> AMOUNT_NOT_POSITIVE');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000003', '{}') = 'AMOUNT_NOT_POSITIVE', 'T2: no amount -> AMOUNT_NOT_POSITIVE');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000004', '{"amount":null}') = 'AMOUNT_NOT_POSITIVE', 'T2: amount null -> AMOUNT_NOT_POSITIVE');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000005', '{"amount":"abc"}') = 'AMOUNT_NOT_POSITIVE', 'T2: amount "abc" -> AMOUNT_NOT_POSITIVE');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000006', '{"amount":true}') = 'AMOUNT_NOT_POSITIVE', 'T2: amount true -> AMOUNT_NOT_POSITIVE');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000007', '{"amount":"-0.01"}') = 'AMOUNT_NOT_POSITIVE', 'T2: amount "-0.01" -> AMOUNT_NOT_POSITIVE');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000010', '{"amount":50}') = 'ok', 'T2: amount 50 still ok');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000011', '{"amount":"75.5","type":"PAY_IN"}') = 'ok', 'T2: amount as text "75.5" still ok');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000012', '{"amount":0.01}') = 'ok', 'T2: amount 0.01 still ok');
reset role;
select test.chk((select count(*) from cash_movements where id::text like 'cdcd0037-0000-0000-0000-00000000000%') = 0, 'T2: refused pay-outs saved nothing');
select test.chk((select string_agg(amount::text, ',' order by id) from cash_movements where id::text like 'cdcd0037-0000-0000-0000-00000000001%') = '50,75.5,0.01',
                'T2: good ones saved with their amounts', (select string_agg(amount::text, ',' order by id) from cash_movements));
select test.chk((select count(*) from sync_operations where entity_id::text like 'cdcd0037-0000-0000-0000-00000000000%') = 0,
                'T2: no upload receipt for a refused pay-out (same as every other refused op)');
-- one batch: bad pay-out between two good ones -> only the bad one fails
select test.login('00000000-0000-0000-0037-0000000000d1'); set role authenticated;
select string_agg(case when e->>'status' = 'error' then e->>'message' else e->>'status' end, ',' order by n) as b1
from jsonb_array_elements(public.fo_sync('device-key-37-0001-abcdef', jsonb_build_array(
  jsonb_build_object('op_id', gen_random_uuid(), 'type', 'cash_movement', 'data', jsonb_build_object('id', 'cdcd0037-0000-0000-0000-000000000020', 'shift_id', '88888888-0000-0000-0037-000000000001', 'type', 'PAY_IN', 'amount', 10, 'performed_by', '66666666-0000-0000-0037-000000000001')),
  jsonb_build_object('op_id', gen_random_uuid(), 'type', 'cash_movement', 'data', jsonb_build_object('id', 'cdcd0037-0000-0000-0000-000000000021', 'shift_id', '88888888-0000-0000-0037-000000000001', 'type', 'PAY_OUT', 'amount', 0, 'performed_by', '66666666-0000-0000-0037-000000000001')),
  jsonb_build_object('op_id', gen_random_uuid(), 'type', 'audit', 'data', jsonb_build_object('id', gen_random_uuid(), 'action', 'Drawer opened', 'actor_name', 'Cathy', 'at', now()))
))) with ordinality as t(e, n) \gset
select test.chk(:'b1' = 'ok,AMOUNT_NOT_POSITIVE,ok', 'T2: in one upload batch only the bad pay-out fails', :'b1');
-- other answers unchanged
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000030', '{"amount":0,"performed_by":"66666666-0000-0000-0037-00000000ffff"}') = 'UNKNOWN_STAFF',
                'T2: unknown staff is still checked first (UNKNOWN_STAFF)', test.cm('cdcd0037-0000-0000-0000-000000000030', '{"amount":0,"performed_by":"66666666-0000-0000-0037-00000000ffff"}'));
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000031', '{"performed_by":"not-a-uuid"}') = 'SERVER_ERROR', 'T2: a broken staff id still SERVER_ERROR (suite 33 F13)');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000032', jsonb_build_object('amount', 5, 'shift_id', gen_random_uuid())) = 'SERVER_ERROR', 'T2: unknown shift still SERVER_ERROR');
select test.chk(test.cm('cdcd0037-0000-0000-0000-000000000033', '{"amount":5,"type":"BOGUS"}') = 'SERVER_ERROR', 'T2: unknown type still refused by its rule');
reset role;
select test.chk(public._fo_error_code('AMOUNT_NOT_POSITIVE') = 'AMOUNT_NOT_POSITIVE' and public._fo_error_code('PIN_UPDATE_NEEDED') = 'PIN_UPDATE_NEEDED'
                and public._fo_error_code('new row violates check constraint') = 'SERVER_ERROR', '_fo_error_code knows AMOUNT_NOT_POSITIVE, keeps the rest');
-- the internal helpers stay internal
select test.chk(not has_function_privilege('authenticated', 'public._fo_apply(uuid, public.devices, text, jsonb)', 'execute')
                and not has_function_privilege('anon', 'public._fo_apply(uuid, public.devices, text, jsonb)', 'execute')
                and not has_function_privilege('authenticated', 'public._fo_error_code(text)', 'execute')
                and not has_function_privilege('anon', 'public._fo_error_code(text)', 'execute')
                and has_function_privilege('authenticated', 'public.fo_sync(text, jsonb)', 'execute')
                and not has_function_privilege('anon', 'public.fo_sync(text, jsonb)', 'execute'), 'grants: _fo_apply / _fo_error_code internal, fo_sync for logins only');

-- ===== 2. Ingredient categories manager (Back Office, apply_changes) =====
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[
  {"op":"upsert","table":"categories","row":{"id":"c0000037-0000-0000-0000-000000000001","name":"Dairy"}},
  {"op":"upsert","table":"categories","row":{"id":"c0000037-0000-0000-0000-000000000002","name":"Syrups"}},
  {"op":"upsert","table":"ingredients","row":{"id":"10000037-0000-0000-0000-000000000001","name":"Milk","base_unit":"ml","category_id":"c0000037-0000-0000-0000-000000000001"}},
  {"op":"upsert","table":"ingredients","row":{"id":"10000037-0000-0000-0000-000000000002","name":"Cream","base_unit":"ml","category_id":"c0000037-0000-0000-0000-000000000001"}}]')$$) = 'NO ERROR', 'categories: add two + ingredients in them');
select test.err($$select public.apply_changes('[{"op":"update","table":"categories","row":{"id":"c0000037-0000-0000-0000-000000000002","name":"Syrups & sauces"}}]')$$) as e0 \gset
select test.chk(:'e0' = 'NO ERROR' and (select name from categories where id = 'c0000037-0000-0000-0000-000000000002') = 'Syrups & sauces', 'categories: rename', :'e0');
select test.err($$select public.apply_changes('[{"op":"delete","table":"categories","id":"c0000037-0000-0000-0000-000000000001"}]')$$) as e1 \gset
select test.chk(:'e1' like '23503 %foreign key%', 'categories: deleting one still used by ingredients -> 23503 foreign key (nothing deleted)', :'e1');
select test.chk(test.err($$select public.apply_changes('[
  {"op":"update","table":"ingredients","row":{"id":"10000037-0000-0000-0000-000000000001","category_id":"c0000037-0000-0000-0000-000000000002"}},
  {"op":"update","table":"ingredients","row":{"id":"10000037-0000-0000-0000-000000000002","category_id":null}},
  {"op":"delete","table":"categories","id":"c0000037-0000-0000-0000-000000000001"}]')$$) = 'NO ERROR', 'categories: move one ingredient, clear the other, then delete, in one call');
select test.chk((select category_id from ingredients where id = '10000037-0000-0000-0000-000000000001') = 'c0000037-0000-0000-0000-000000000002'
                and (select category_id from ingredients where id = '10000037-0000-0000-0000-000000000002') is null
                and not exists (select 1 from categories where id = 'c0000037-0000-0000-0000-000000000001'), 'categories: ... moved, cleared, deleted');
select test.chk(test.err($$select public.apply_changes('[{"op":"delete_where","table":"ingredients","where":{"category_id":"c0000037-0000-0000-0000-000000000002"}},{"op":"delete","table":"categories","id":"c0000037-0000-0000-0000-000000000002"}]')$$) = 'NO ERROR', 'categories: delete_where by category works too');
reset role;

-- ===== 3. Deleting several recipes at once =====
insert into ingredients(id, business_id, name, base_unit) values ('10000037-0000-0000-0000-000000000010', :'biz', 'Espresso beans', 'g');
insert into recipes(id, business_id, name, recipe_type, selling_price) values
  ('20000037-0000-0000-0000-000000000001', :'biz', 'R1 free', 'DRINKS', 100), ('20000037-0000-0000-0000-000000000002', :'biz', 'R2 free', 'DRINKS', 100),
  ('20000037-0000-0000-0000-000000000003', :'biz', 'R3 sold', 'DRINKS', 100), ('20000037-0000-0000-0000-000000000004', :'biz', 'R4 produced', 'SAUCES_SYRUPS', 0),
  ('20000037-0000-0000-0000-000000000005', :'biz', 'R5 source', 'SAUCES_SYRUPS', 0);
insert into recipe_ingredients(business_id, recipe_id, ingredient_id, quantity, unit)
  select :'biz', r, '10000037-0000-0000-0000-000000000010', 18, 'g' from unnest(array['20000037-0000-0000-0000-000000000001','20000037-0000-0000-0000-000000000002',
    '20000037-0000-0000-0000-000000000003','20000037-0000-0000-0000-000000000004','20000037-0000-0000-0000-000000000005']::uuid[]) r;
insert into sales(id, business_id, status, grand_total, subtotal) values ('99999999-0000-0000-0037-000000000001', :'biz', 'COMPLETED', 100, 100);
insert into sale_items(business_id, sale_id, recipe_id, name, quantity, unit_price, line_total) values (:'biz', '99999999-0000-0000-0037-000000000001', '20000037-0000-0000-0000-000000000003', 'R3', 1, 100, 100);
insert into production_batches(business_id, recipe_id, batch_number) values (:'biz', '20000037-0000-0000-0000-000000000004', 'B1');
insert into ingredients(id, business_id, name, base_unit, is_produced_item, source_recipe_id) values ('10000037-0000-0000-0000-000000000011', :'biz', 'House syrup', 'ml', true, '20000037-0000-0000-0000-000000000005');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.err($$select public.apply_changes('[
  {"op":"delete_where","table":"recipe_ingredients","where":{"recipe_id":"20000037-0000-0000-0000-000000000001"}},{"op":"delete","table":"recipes","id":"20000037-0000-0000-0000-000000000001"},
  {"op":"delete_where","table":"recipe_ingredients","where":{"recipe_id":"20000037-0000-0000-0000-000000000002"}},{"op":"delete","table":"recipes","id":"20000037-0000-0000-0000-000000000002"}]')$$) as e2 \gset
select test.chk(:'e2' = 'NO ERROR'
  and not exists (select 1 from recipes where id in ('20000037-0000-0000-0000-000000000001','20000037-0000-0000-0000-000000000002'))
  and not exists (select 1 from recipe_ingredients where recipe_id in ('20000037-0000-0000-0000-000000000001','20000037-0000-0000-0000-000000000002')),
  'recipes: two unused recipes + their lines deleted in one call');
select test.err($$select public.apply_changes('[{"op":"delete","table":"recipes","id":"20000037-0000-0000-0000-000000000003"}]')$$) as e3 \gset
select test.chk(:'e3' like '23503 %sale_items%', 'recipes: one on a past sale -> 23503 foreign key (sale_items)', :'e3');
select test.err($$select public.apply_changes('[{"op":"delete","table":"recipes","id":"20000037-0000-0000-0000-000000000004"}]')$$) as e4 \gset
select test.chk(:'e4' like '23503 %production_batches%', 'recipes: one with production batches -> 23503 (production_batches)', :'e4');
select test.err($$select public.apply_changes('[{"op":"delete","table":"recipes","id":"20000037-0000-0000-0000-000000000005"}]')$$) as e5 \gset
select test.chk(:'e5' like '23503 %ingredients%', 'recipes: one that is an ingredient''s source recipe -> 23503 (ingredients)', :'e5');
-- one bad recipe in a multi-delete call undoes the WHOLE call
select test.err($$select public.apply_changes('[{"op":"delete","table":"recipes","id":"20000037-0000-0000-0000-000000000005"},
  {"op":"delete_where","table":"recipe_ingredients","where":{"recipe_id":"20000037-0000-0000-0000-000000000003"}},{"op":"delete","table":"recipes","id":"20000037-0000-0000-0000-000000000003"}]')$$) as e6 \gset
select test.chk(:'e6' like '23503 %' and (select count(*) from recipe_ingredients where recipe_id = '20000037-0000-0000-0000-000000000003') = 1,
                'recipes: a multi-delete with one in-use recipe changes nothing (all-or-nothing)', :'e6');
-- the fallback: make them inactive
select test.err($$select public.apply_changes('[{"op":"update","table":"recipes","row":{"id":"20000037-0000-0000-0000-000000000003","active":false,"pos_visible":false,"qr_visible":false}},
  {"op":"update","table":"recipes","row":{"id":"20000037-0000-0000-0000-000000000004","active":false,"pos_visible":false,"qr_visible":false}}]')$$) as e9 \gset
select test.chk(:'e9' = 'NO ERROR' and (select count(*) from recipes where id in ('20000037-0000-0000-0000-000000000003','20000037-0000-0000-0000-000000000004') and not active) = 2, 'recipes: fallback "make inactive" works');
-- an ingredient still used by a recipe can't be deleted either
select test.err($$select public.apply_changes('[{"op":"delete","table":"ingredients","id":"10000037-0000-0000-0000-000000000010"}]')$$) as e7 \gset
select test.chk(:'e7' like '23503 %recipe_ingredients%', 'ingredients: one used in a recipe -> 23503 (recipe_ingredients)', :'e7');
reset role;

-- ===== 4. Big Excel import in ONE apply_changes call =====
-- 70 recipes ('Uncategorized' + each recipe_type), 150 ingredients, 600 recipe lines (base-unit
-- quantities + the unit the owner typed), 150 "starting price" purchases (quantity 0, no stock).
select jsonb_agg(op order by grp, n) as ops from (
  select 1 grp, n, jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object(
    'id', ('11000037-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'name', 'Import ing ' || n, 'base_unit', (array['g','ml','pc'])[1 + n % 3], 'active', true)) op
  from generate_series(1, 150) n
  union all
  select 2, n, jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object(
    'id', ('21000037-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'name', 'Import recipe ' || n,
    'recipe_type', (array['DRINKS','SAUCES_SYRUPS','PASTRY','FOOD'])[1 + n % 4], 'category', case when n % 2 = 0 then 'Uncategorized' else 'Coffee' end,
    'selling_price', 120, 'active', true, 'pos_visible', true, 'modifier_groups', '[]'::jsonb))
  from generate_series(1, 70) n
  union all
  select 3, n, jsonb_build_object('op','upsert','table','recipe_ingredients','row', jsonb_build_object(
    'id', gen_random_uuid(), 'recipe_id', ('21000037-0000-0000-0000-' || lpad((1 + n % 70)::text, 12, '0'))::uuid,
    'ingredient_id', ('11000037-0000-0000-0000-' || lpad((1 + n % 150)::text, 12, '0'))::uuid, 'quantity', 18.5, 'unit', 'tbsp'))
  from generate_series(1, 600) n
  union all
  select 4, n, jsonb_build_object('op','upsert','table','purchases','row', jsonb_build_object(
    'id', gen_random_uuid(), 'ingredient_id', ('11000037-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'purchase_date', '2026-10-25',
    'quantity', 0, 'base_quantity', 0, 'total_price', 0, 'price_per_base_unit', 0.85, 'notes', 'Starting price (import)'))
  from generate_series(1, 150) n
) x \gset
select octet_length(:'ops') as ops_bytes \gset
select clock_timestamp() as t0 \gset
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.err(format('select public.apply_changes(%L::jsonb)', :'ops')) as e8 \gset
reset role;
select round(extract(epoch from clock_timestamp() - :'t0'::timestamptz) * 1000) as ms \gset
select test.chk(:'e8' = 'NO ERROR', 'import: one call with 970 ops (' || :'ops_bytes' || ' bytes) applied in ' || :'ms' || ' ms', :'e8');
select test.chk((select count(*) from recipes where id::text like '21000037-%') = 70 and (select count(*) from ingredients where id::text like '11000037-%') = 150
                and (select count(*) from recipe_ingredients where recipe_id::text like '21000037-%') = 600
                and (select count(*) from purchases where notes = 'Starting price (import)' and quantity = 0 and base_quantity = 0) = 150, 'import: 70 recipes, 150 ingredients, 600 lines, 150 price rows saved');
select test.chk((select count(*) from inventory_transactions where ingredient_id::text like '11000037-%') = 0
                and not exists (select 1 from v_ingredient_stock where ingredient_id::text like '11000037-%'), 'import: starting-price purchases create NO stock movement (stock stays 0)');
select test.chk((select count(*) from recipes where id::text like '21000037-%' and category = 'Uncategorized') = 35
                and (select count(distinct recipe_type) from recipes where id::text like '21000037-%') = 4, 'import: category ''Uncategorized'' and all 4 recipe types accepted');
select test.chk((select bool_and(quantity = 18.5 and unit = 'tbsp') from recipe_ingredients where recipe_id::text like '21000037-%'), 'import: recipe line quantity kept as sent, unit stored as display text only');
-- the QR menu's "can we make it" check uses the quantity only (base unit), never the unit text
select test.chk(public._recipe_makeable('21000037-0000-0000-0000-000000000001') = false, 'base units: no stock -> not makeable');
insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date)
  select :'biz', ingredient_id, 'PURCHASE', 18.5, current_date from recipe_ingredients where recipe_id = '21000037-0000-0000-0000-000000000001' group by ingredient_id;
select test.chk(public._recipe_makeable('21000037-0000-0000-0000-000000000001') = (select bool_and(n = 1) from (select count(*) n from recipe_ingredients where recipe_id = '21000037-0000-0000-0000-000000000001' group by ingredient_id) x),
                'base units: 18.5 in stock per ingredient = one recipe''s 18.5 -> makeable (unit text ignored)');
-- not a member / not the owner: the import is refused
select test.login('00000000-0000-0000-0037-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"categories","row":{"name":"x"}}]')$$) like '%ADMIN_ONLY%', 'a counter login can''t use apply_changes (ADMIN_ONLY)');
reset role;
