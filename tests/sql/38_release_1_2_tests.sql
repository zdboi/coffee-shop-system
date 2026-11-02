-- Checks for cccc/supabase/008_release_1_2.sql (release 1.2; contract: docs/handoff/contract-1.2.md).
-- Adopted into the QA regression on 2026-10-29 from the database engineer's 008 checks (100 checks).
-- Needs a database with 004..008 on which 10_behaviour_tests + 11_qr_tests have JUST run (it uses their shop,
-- counter, staff, customers and the QR takeaway table):
--   tests/reset_db.sh "" cccc        (installs 004..008)
--   P="psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1"
--   $P -f tests/sql/10_behaviour_tests.sql && $P -f tests/sql/11_qr_tests.sql && $P -f tests/sql/38_release_1_2_tests.sql
-- Prints "ok  ..." / "FAIL ..." for every check and keeps going.
--   A. floor plan (dining_tables plan columns, floor_shapes, fo_floor_plan; counters never see qr_token)
--   B. tile colours (settings.subcategory_colors)
--   C. ingredient brands + FIFO brand stock (ingredient_brand_stock)
--   D. stamps (visits / drink / food stamps per Manila day), theme 'CCCC' | 'CUSTOM'
--   E. counter customers tab (fo_customer_list / fo_customer_detail; money only with a manager token)
--   R. stamp-card rewards at the counter (loyalty_redemptions)
create schema if not exists test;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', case when p_token is null then '{}' else json_build_object('x-staff-token', p_token)::text end, false);
end $$;
grant usage on schema test to anon, authenticated;
\set QUIET on
\pset tuples_only on
\pset format unaligned
create or replace function test.chk(cond boolean, msg text, got text default null) returns text language plpgsql as $$
begin return case when coalesce(cond, false) then 'ok  ' || msg else 'FAIL ' || msg || coalesce('   [got: ' || got || ']', '') end; end $$;
create or replace function test.err(q text) returns text language plpgsql as $$
begin execute q; return 'NO ERROR'; exception when others then return sqlerrm; end $$;
grant execute on all functions in schema test to anon, authenticated;
\set ON_ERROR_STOP on

select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select business_id as biz2 from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset

-- re-pair the counter (suite 11 removed it at its end)
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select (public.create_device_pairing_code('Front Counter'))->>'code' as paircode \gset
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select (public.redeem_device_pairing(:'paircode', 'device-key-0001-abcdef', 'Front Counter')->'device'->>'active') as x \gset
reset role;
delete from auth_attempts;

-- ======================= A. floor plan =======================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','update','table','dining_tables','row', jsonb_build_object('id','77777777-0000-0000-0000-000000000005','shape','ROUND','pos_x',100,'pos_y',200,'width',90,'height',90,'rotation',45,'seats',4)),
  jsonb_build_object('op','upsert','table','floor_shapes','row', jsonb_build_object('id','f0000000-0000-0000-0000-000000000001','kind','COUNTER','label','Bar','shape','RECT','pos_x',0,'pos_y',0,'width',400,'height',60))));
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"dining_tables","row":{"id":"77777777-0000-0000-0000-000000000005","pos_x":1001}}]')$$) like '%dining_tables_pos_x_check%', 'A: pos_x > 1000 refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"dining_tables","row":{"id":"77777777-0000-0000-0000-000000000005","rotation":360}}]')$$) like '%rotation%', 'A: rotation 360 refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"floor_shapes","row":{"id":"f0000000-0000-0000-0000-000000000002","kind":"SOFA"}}]')$$) like '%floor_shapes_kind_check%', 'A: unknown shape kind refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"floor_shapes","row":{"id":"f0000000-0000-0000-0000-000000000002","kind":"LABEL","label":"12345678901234567890123456789012345678901"}}]')$$) like '%label%', 'A: 41-char label refused');
select test.chk(jsonb_array_length(public.bo_bootstrap()->'floor_shapes') = 1 and (select bool_and(t ? 'qr_token') from jsonb_array_elements(public.bo_bootstrap()->'tables') t), 'A: bo_bootstrap has floor_shapes, owner tables keep qr_token');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select public.fo_floor_plan() as fp \gset
select test.chk(jsonb_array_length(:'fp'::jsonb->'shapes') = 1 and jsonb_array_length(:'fp'::jsonb->'tables') >= 2
  and not exists (select 1 from jsonb_array_elements(:'fp'::jsonb->'tables') t where t ? 'qr_token')
  and exists (select 1 from jsonb_array_elements(:'fp'::jsonb->'tables') t where t->>'shape' = 'ROUND' and (t->>'seats')::int = 4 and (t->>'pos_x')::numeric = 100),
  'A: counter fo_floor_plan: tables with plan columns, NO qr_token, shapes', left(:'fp', 300));
select test.chk(not exists (select 1 from jsonb_array_elements(public.fo_bootstrap('device-key-0001-abcdef')->'tables') t where t ? 'qr_token')
  and jsonb_array_length(public.fo_bootstrap('device-key-0001-abcdef')->'floor_shapes') = 1, 'A: fo_bootstrap tables without qr_token + floor_shapes');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"floor_shapes","row":{"kind":"WALL"}}]')$$) = 'ADMIN_ONLY', 'A: counter cannot write floor_shapes');
select test.chk((select count(*) from dining_tables) = 0 and test.err('select qr_token from dining_tables') = 'NO ERROR', 'A: counter reads no dining_tables rows directly (no QR codes)');
select test.chk(test.err($$insert into floor_shapes(kind) values ('WALL')$$) like '%row-level security%', 'A: counter cannot insert floor_shapes directly');
reset role;
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.chk(jsonb_array_length(public.fo_floor_plan()->'shapes') = 0 and (select count(*) from floor_shapes) = 0, 'A: other shop sees none of our shapes');
reset role;
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select test.chk(test.err('select public.fo_floor_plan()') in ('NOT_A_MEMBER', 'NOT_ALLOWED'), 'A: a QR customer cannot read the floor plan');
reset role;
set role anon;
select test.chk(test.err('select public.fo_floor_plan()') like 'permission denied%', 'A: anon cannot call fo_floor_plan');
reset role;

-- ======================= B. tile colours =======================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes('[{"op":"upsert","table":"settings","row":{"subcategory_colors":{"Iced":"terracotta","Hot":"deep_terracotta","Pastry":"sky"}}}]');
select test.chk((select subcategory_colors->>'Iced' from settings where business_id = :'biz') = 'terracotta', 'B: valid colours saved');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"settings","row":{"subcategory_colors":{"Iced":"#ff0000"}}}]')$$) = 'BAD_SUBCATEGORY_COLORS', 'B: hex value refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"settings","row":{"subcategory_colors":["terracotta"]}}]')$$) = 'BAD_SUBCATEGORY_COLORS', 'B: array refused');
select test.chk(test.err(format($$select public.apply_changes('[{"op":"upsert","table":"settings","row":{"subcategory_colors":{"%s":"olive"}}}]')$$, repeat('x', 41))) = 'BAD_SUBCATEGORY_COLORS', 'B: 41-char key refused');
select test.chk(test.err(format($$select public.apply_changes(%L::jsonb)$$, jsonb_build_array(jsonb_build_object('op','upsert','table','settings','row',
  jsonb_build_object('subcategory_colors', (select jsonb_object_agg('c' || g, 'olive') from generate_series(1, 101) g)))))) = 'BAD_SUBCATEGORY_COLORS', 'B: 101 entries refused');
select test.chk(test.err($$update settings set subcategory_colors = '{"Iced":"olive"}' where business_id = current_business_id()$$) = 'NO ERROR', 'B: owner direct update works (trigger needs no API rights)');
select test.chk(test.err($$update settings set subcategory_colors = '{"Iced":"red"}' where business_id = current_business_id()$$) = 'BAD_SUBCATEGORY_COLORS', 'B: owner direct update also validated');
reset role;

-- ======================= C. brands + FIFO =======================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','22222222-0000-0000-0000-0000000000f1','name','Beans FIFO','base_unit','g')),
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','22222222-0000-0000-0000-0000000000f2','name','Cups','base_unit','pc')),
  jsonb_build_object('op','upsert','table','ingredient_brands','row', jsonb_build_object('id','bbbb0000-0000-0000-0000-00000000000a','ingredient_id','22222222-0000-0000-0000-0000000000f1','name','Alpha')),
  jsonb_build_object('op','upsert','table','ingredient_brands','row', jsonb_build_object('id','bbbb0000-0000-0000-0000-00000000000b','ingredient_id','22222222-0000-0000-0000-0000000000f1','name','Bravo')),
  jsonb_build_object('op','upsert','table','ingredient_brands','row', jsonb_build_object('id','bbbb0000-0000-0000-0000-00000000000c','ingredient_id','22222222-0000-0000-0000-0000000000f2','name','CupCo')),
  -- lot 1: starting stock 1000 g Alpha (oldest)
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','cccc0000-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-0000000000f1','transaction_type','INITIAL_STOCK','quantity',1000,'transaction_date','2026-10-01','brand_id','bbbb0000-0000-0000-0000-00000000000a')),
  -- lot 2: purchase 500 g Bravo @ 2/g
  jsonb_build_object('op','upsert','table','purchases','row', jsonb_build_object('id','dddd0000-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-0000000000f1','purchase_date','2026-10-05','quantity',500,'base_quantity',500,'total_price',1000,'price_per_base_unit',2,'brand_id','bbbb0000-0000-0000-0000-00000000000b')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','cccc0000-0000-0000-0000-000000000002','ingredient_id','22222222-0000-0000-0000-0000000000f1','transaction_type','PURCHASE','quantity',500,'reference_id','dddd0000-0000-0000-0000-000000000001','transaction_date','2026-10-05')),
  -- lot 3: purchase 300 g Alpha @ 3/g (newest)
  jsonb_build_object('op','upsert','table','purchases','row', jsonb_build_object('id','dddd0000-0000-0000-0000-000000000002','ingredient_id','22222222-0000-0000-0000-0000000000f1','purchase_date','2026-10-10','quantity',300,'base_quantity',300,'total_price',900,'price_per_base_unit',3,'brand_id','bbbb0000-0000-0000-0000-00000000000a')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','cccc0000-0000-0000-0000-000000000003','ingredient_id','22222222-0000-0000-0000-0000000000f1','transaction_type','PURCHASE','quantity',300,'reference_id','dddd0000-0000-0000-0000-000000000002','transaction_date','2026-10-10')),
  -- a sale used 1200 g (no brand on sales)
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','cccc0000-0000-0000-0000-000000000004','ingredient_id','22222222-0000-0000-0000-0000000000f1','transaction_type','SALE_USAGE','quantity',1200,'reference_id','x-sale','transaction_date','2026-10-12'))));
select public.ingredient_brand_stock('22222222-0000-0000-0000-0000000000f1')->0 as bs \gset
select test.chk((:'bs'::jsonb->>'stock')::numeric = 600, 'C: total stock 1800 - 1200 = 600', :'bs'::jsonb->>'stock');
select test.chk((select (b->>'remaining')::numeric from jsonb_array_elements(:'bs'::jsonb->'brands') b where b->>'brand_name' = 'Alpha') = 300
            and (select (b->>'remaining')::numeric from jsonb_array_elements(:'bs'::jsonb->'brands') b where b->>'brand_name' = 'Bravo') = 300,
  'C: FIFO: Alpha 300 (newest lot) + Bravo 300 (old Alpha starting stock used up)', :'bs'::jsonb->>'brands');
select test.chk(:'bs'::jsonb->'in_use'->>'brand_name' = 'Bravo' and (:'bs'::jsonb->'in_use'->>'price_per_base_unit')::numeric = 2
            and (:'bs'::jsonb->'in_use'->>'remaining')::numeric = 300, 'C: in use = oldest lot with stock (Bravo @ 2)', :'bs'::jsonb->>'in_use');
select test.chk(jsonb_array_length(:'bs'::jsonb->'lots') = 2, 'C: open lots listed (2)');
-- put 100 back (refund-like) and use 650 more: 600 + 100 - 650 = 50 -> only Alpha (newest) left, in use Alpha @ 3
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','cccc0000-0000-0000-0000-000000000005','ingredient_id','22222222-0000-0000-0000-0000000000f1','transaction_type','USAGE','quantity',650,'transaction_date','2026-10-13'))));
select public.ingredient_brand_stock('22222222-0000-0000-0000-0000000000f1')->0 as bs \gset
select test.chk((:'bs'::jsonb->>'stock')::numeric = 0 and :'bs'::jsonb->'in_use' = 'null'::jsonb and jsonb_array_length(:'bs'::jsonb->'brands') = 0, 'C: stock 600-650 < 0 -> 0, nothing in use', :'bs');
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','cccc0000-0000-0000-0000-000000000006','ingredient_id','22222222-0000-0000-0000-0000000000f1','transaction_type','ADJUSTMENT','quantity',100,'transaction_date','2026-10-14'))));
select public.ingredient_brand_stock('22222222-0000-0000-0000-0000000000f1')->0 as bs \gset
select test.chk((:'bs'::jsonb->>'stock')::numeric = 50 and (select b->>'brand_id' is null and (b->>'remaining')::numeric = 50 from jsonb_array_elements(:'bs'::jsonb->'brands') b)
            and :'bs'::jsonb->'in_use'->>'brand_id' is null, 'C: -50 + adjustment 100 without brand = 50 "Not set" (newest lot)', :'bs'::jsonb->>'brands');
-- errors
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"purchases","row":{"id":"dddd0000-0000-0000-0000-000000000009","ingredient_id":"22222222-0000-0000-0000-0000000000f1","purchase_date":"2026-10-15","brand_id":"bbbb0000-0000-0000-0000-00000000000c"}}]')$$) = 'BRAND_MISMATCH', 'C: brand of another ingredient refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"inventory_transactions","row":{"id":"cccc0000-0000-0000-0000-000000000009","ingredient_id":"22222222-0000-0000-0000-0000000000f1","transaction_type":"SALE_USAGE","quantity":1,"transaction_date":"2026-10-15","brand_id":"bbbb0000-0000-0000-0000-00000000000a"}}]')$$) = 'BRAND_NOT_ALLOWED', 'C: brand on a sale line refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"inventory_transactions","row":{"id":"cccc0000-0000-0000-0000-000000000009","ingredient_id":"22222222-0000-0000-0000-0000000000f1","transaction_type":"ADJUSTMENT","quantity":-5,"transaction_date":"2026-10-15","brand_id":"bbbb0000-0000-0000-0000-00000000000a"}}]')$$) = 'BRAND_NOT_ALLOWED', 'C: brand on a negative adjustment refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"delete","table":"ingredient_brands","id":"bbbb0000-0000-0000-0000-00000000000a"}]')$$) = 'BRAND_IN_USE', 'C: used brand cannot be deleted');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"ingredient_brands","row":{"id":"bbbb0000-0000-0000-0000-00000000000a","ingredient_id":"22222222-0000-0000-0000-0000000000f2"}}]')$$) = 'BRAND_IN_USE', 'C: used brand cannot move to another ingredient');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"ingredient_brands","row":{"id":"bbbb0000-0000-0000-0000-00000000000a","active":false}}]')$$) = 'NO ERROR', 'C: used brand can be switched off');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"ingredient_brands","row":{"id":"bbbb0000-0000-0000-0000-0000000000a2","ingredient_id":"22222222-0000-0000-0000-0000000000f1","name":" alpha "}}]')$$) like '%ingredient_brands_name_key%', 'C: duplicate name (case/space-insensitive) refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"ingredient_brands","row":{"id":"bbbb0000-0000-0000-0000-0000000000a3","ingredient_id":"22222222-0000-0000-0000-0000000000f2","name":"Alpha"}}]')$$) = 'NO ERROR', 'C: same name on another ingredient is fine');
select test.chk(test.err($$select public.apply_changes('[{"op":"delete","table":"ingredient_brands","id":"bbbb0000-0000-0000-0000-0000000000a3"}]')$$) = 'NO ERROR', 'C: unused brand can be deleted');
select test.chk(jsonb_array_length(public.bo_bootstrap()->'ingredient_brands') = 3 and jsonb_typeof(public.bo_bootstrap()->'brand_stock') = 'array'
            and exists (select 1 from jsonb_array_elements(public.bo_bootstrap()->'brand_stock') x where x->>'ingredient_id' = '22222222-0000-0000-0000-0000000000f1'),
  'C: bo_bootstrap returns ingredient_brands + brand_stock');
reset role;
-- cross-shop: other owner can't use our brand, sees nothing of ours
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.chk((select count(*) from ingredient_brands) = 0 and public.ingredient_brand_stock() = '[]'::jsonb, 'C: other shop sees no brands / brand stock');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"ingredient_brands","row":{"id":"bbbb0000-0000-0000-0000-00000000000a","ingredient_id":"22222222-0000-0000-0000-0000000000f1","name":"Stolen"}}]')$$) = 'FORBIDDEN_ROW', 'C: other shop cannot overwrite our brand');
reset role;
-- counter: no brands, no brand stock
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk((select count(*) from ingredient_brands) = 0 and test.err('select public.ingredient_brand_stock()') = 'NOT_ALLOWED'
            and public.bo_bootstrap()->'brand_stock' = '[]'::jsonb, 'C: counter reads no brands / brand stock');
reset role;
-- ingredient delete with an unused brand: brand goes with it
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','22222222-0000-0000-0000-0000000000f3','name','Tmp','base_unit','g')),
  jsonb_build_object('op','upsert','table','ingredient_brands','row', jsonb_build_object('id','bbbb0000-0000-0000-0000-0000000000d1','ingredient_id','22222222-0000-0000-0000-0000000000f3','name','Tmp brand'))));
select test.err($$select public.apply_changes('[{"op":"delete","table":"ingredients","id":"22222222-0000-0000-0000-0000000000f3"}]')$$) as e \gset
select test.chk(:'e' = 'NO ERROR' and (select count(*) from ingredient_brands where id = 'bbbb0000-0000-0000-0000-0000000000d1') = 0, 'C: deleting an unused ingredient removes its brands', :'e');
reset role;

-- ======================= D. stamps =======================
-- recipes: Iced Latte (DRINKS) exists; add a pastry
insert into recipes(id, business_id, name, recipe_type, selling_price) values ('33333333-0000-0000-0000-0000000000a1', :'biz', 'Ensaymada', 'PASTRY', 80) on conflict do nothing;
create or replace function test.mk_sale(p_id text, p_cust uuid, p_at timestamptz, p_status text, p_drink int, p_food int) returns void language plpgsql as $$
declare v_biz uuid := (select business_id from customers where id = p_cust);
begin
  insert into sales(id, business_id, transaction_number, transaction_date, status, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total, customer_id)
    values (p_id::uuid, v_biz, 'T-' || left(p_id, 8), p_at, p_status, 100, 0, 0, 0, 100, p_cust);
  if p_drink > 0 then insert into sale_items(id, business_id, sale_id, recipe_id, name, quantity, unit_price, line_total)
    values (gen_random_uuid(), v_biz, p_id::uuid, '33333333-0000-0000-0000-000000000001', 'Iced Latte', p_drink, 50, 50 * p_drink); end if;
  if p_food > 0 then insert into sale_items(id, business_id, sale_id, recipe_id, name, quantity, unit_price, line_total)
    values (gen_random_uuid(), v_biz, p_id::uuid, '33333333-0000-0000-0000-0000000000a1', 'Ensaymada', p_food, 50, 50 * p_food); end if;
end $$;
insert into customers(id, business_id, nickname, phone, source) values ('c5000000-0000-0000-0000-000000000001', :'biz', 'Stampy', '+639181112233', 'COUNTER');
-- D1 drink only
select test.mk_sale('5a000000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000001', '2026-10-01 10:00+08', 'COMPLETED', 1, 0);
-- D2 drink + pastry in one sale
select test.mk_sale('5a000000-0000-0000-0000-000000000002', 'c5000000-0000-0000-0000-000000000001', '2026-10-02 10:00+08', 'COMPLETED', 1, 1);
-- D3 two drink sales
select test.mk_sale('5a000000-0000-0000-0000-000000000003', 'c5000000-0000-0000-0000-000000000001', '2026-10-03 09:00+08', 'COMPLETED', 2, 0);
select test.mk_sale('5a000000-0000-0000-0000-000000000004', 'c5000000-0000-0000-0000-000000000001', '2026-10-03 15:00+08', 'COMPLETED', 1, 0);
-- D4 voided drink sale (no visit, no stamp) + fully refunded one
select test.mk_sale('5a000000-0000-0000-0000-000000000005', 'c5000000-0000-0000-0000-000000000001', '2026-10-04 10:00+08', 'VOIDED', 1, 1);
select test.mk_sale('5a000000-0000-0000-0000-00000000005b', 'c5000000-0000-0000-0000-000000000001', '2026-10-04 11:00+08', 'REFUNDED', 1, 0);
-- D5 drink + food, the food line given back by a partial refund
select test.mk_sale('5a000000-0000-0000-0000-000000000006', 'c5000000-0000-0000-0000-000000000001', '2026-10-05 10:00+08', 'COMPLETED', 1, 2);
-- D6 just before / after Manila midnight (same UTC day 2026-10-06): two Manila days
select test.mk_sale('5a000000-0000-0000-0000-000000000007', 'c5000000-0000-0000-0000-000000000001', '2026-10-06 23:30+08', 'COMPLETED', 1, 0);
select test.mk_sale('5a000000-0000-0000-0000-000000000008', 'c5000000-0000-0000-0000-000000000001', '2026-10-07 00:30+08', 'COMPLETED', 0, 1);
-- HELD sale: nothing
select test.mk_sale('5a000000-0000-0000-0000-000000000009', 'c5000000-0000-0000-0000-000000000001', '2026-10-08 10:00+08', 'HELD', 1, 1);
select test.chk((select visit_count = 6 and drink_stamps = 5 and food_stamps = 3 and stamps = 8 from customers where id = 'c5000000-0000-0000-0000-000000000001'),
  'D: before refund: 6 visits, 5 drink, 3 food', (select format('%s visits, %s drink, %s food, %s stamps', visit_count, drink_stamps, food_stamps, stamps) from customers where id = 'c5000000-0000-0000-0000-000000000001'));
-- partial refund of the 2 pastries of D5 (by items)
update sales set status = 'PARTIALLY_REFUNDED' where id = '5a000000-0000-0000-0000-000000000006';
insert into refunds(id, business_id, sale_id, type, amount, items, date)
  select gen_random_uuid(), :'biz', '5a000000-0000-0000-0000-000000000006', 'PARTIAL_REFUND', 50,
         jsonb_build_array(jsonb_build_object('sale_item_id', si.id, 'quantity', 1)), now()
  from sale_items si where si.sale_id = '5a000000-0000-0000-0000-000000000006' and si.recipe_id = '33333333-0000-0000-0000-0000000000a1';
select test.chk((select food_stamps from customers where id = 'c5000000-0000-0000-0000-000000000001') = 3, 'D: 1 of 2 pastries given back -> D5 keeps its food stamp');
insert into refunds(id, business_id, sale_id, type, amount, items, date)
  select gen_random_uuid(), :'biz', '5a000000-0000-0000-0000-000000000006', 'PARTIAL_REFUND', 0,
         jsonb_build_array(jsonb_build_object('sale_item_id', si.id, 'quantity', 1)), now()
  from sale_items si where si.sale_id = '5a000000-0000-0000-0000-000000000006' and si.recipe_id = '33333333-0000-0000-0000-0000000000a1';
select format('%s visits, %s drink, %s food, %s stamps', visit_count, drink_stamps, food_stamps, stamps) as got from customers where id = 'c5000000-0000-0000-0000-000000000001' \gset
select test.chk(:'got' = '6 visits, 5 drink, 2 food, 7 stamps',
  'D: visits = D1,D2,D3,D5,D6a,D6b = 6; drink = D1,D2,D3,D5,D6a = 5; food = D2,D6b = 2 (D5 food all given back; D4 void/refunded, HELD ignored)', :'got');
select test.chk((select visits = 6 and drink_stamps = 5 and food_stamps = 2 from public._customer_loyalty(:'biz', 'c5000000-0000-0000-0000-000000000001')), 'D: derived function = stored copy');
-- a void later takes the day away
update sales set status = 'VOIDED' where id = '5a000000-0000-0000-0000-000000000001';
select test.chk((select visit_count = 5 and drink_stamps = 4 from customers where id = 'c5000000-0000-0000-0000-000000000001'), 'D: voiding D1 -> 5 visits, 4 drink stamps');
-- someone editing the copy by hand is put right on the next change
update customers set visit_count = 99 where id = 'c5000000-0000-0000-0000-000000000001';
update sales set notes = 'x', updated_at = now() where id = '5a000000-0000-0000-0000-000000000002';
select test.chk((select visit_count from customers where id = 'c5000000-0000-0000-0000-000000000001') = 5, 'D: copy recomputed on the next sale change');

-- counter path: two fo_sync sales the same day for one customer = 1 visit, 1 drink stamp
select id as zed from customers where nickname = 'Zed' and business_id = :'biz' \gset
select test.chk((select visit_count = 1 and drink_stamps = 1 and stamps = 1 from customers where id = :'zed'), 'D: Zed after suite 11 (one QR sale): 1 visit, 1 drink stamp',
   (select format('%s/%s/%s', visit_count, drink_stamps, stamps) from customers where id = :'zed'));
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select (public.staff_pin_login('1111')) ->> 'token' as cashier_token \gset
select public.fo_sync('device-key-0001-abcdef', jsonb_build_array(
  jsonb_build_object('op_id','a0000000-0000-0000-0000-0000000008a0','type','shift_open','data', jsonb_build_object(
     'id','88888888-0000-0000-0000-0000000008a0','shift_number','SHIFT-A-2026-0099','cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0)),
  jsonb_build_object('op_id','a0000000-0000-0000-0000-0000000008a1','type','sale','data', jsonb_build_object(
   'sale', jsonb_build_object('id','99999999-0000-0000-0000-0000000008a1','transaction_number','POS-A-2026-000801','transaction_date',now(),'status','COMPLETED',
     'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy','shift_id','88888888-0000-0000-0000-0000000008a0',
     'subtotal',150,'discount_amount',0,'tax_amount',0,'service_charge_amount',15,'grand_total',165,'customer_id',:'zed'),
   'items', jsonb_build_array(jsonb_build_object('recipe_id','33333333-0000-0000-0000-000000000001','name','Iced Latte','quantity',1,'unit_price',150,'line_total',150)),
   'payment', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-0000000008a1','method','CASH','amount',165),
   'inventory','[]'::jsonb)),
  jsonb_build_object('op_id','a0000000-0000-0000-0000-0000000008a2','type','sale','data', jsonb_build_object(
   'sale', jsonb_build_object('id','99999999-0000-0000-0000-0000000008a2','transaction_number','POS-A-2026-000802','transaction_date',now(),'status','COMPLETED',
     'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy','shift_id','88888888-0000-0000-0000-0000000008a0',
     'subtotal',80,'discount_amount',0,'tax_amount',0,'service_charge_amount',8,'grand_total',88,'customer_id',:'zed'),
   'items', jsonb_build_array(jsonb_build_object('recipe_id','33333333-0000-0000-0000-0000000000a1','name','Ensaymada','quantity',1,'unit_price',80,'line_total',80)),
   'payment', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-0000000008a2','method','CASH','amount',88),
   'inventory','[]'::jsonb)))) as r \gset
reset role;
select test.chk(:'r'::jsonb @> '[{"status":"ok"},{"status":"ok"},{"status":"ok"}]', 'D: fo_sync ops ok', :'r');
select format('%s/%s/%s/%s', visit_count, drink_stamps, food_stamps, stamps) as got from customers where id = :'zed' \gset
select test.chk(:'got' = '1/1/1/2', 'D: same day: drink + pastry at the counter -> still 1 visit, 1 drink + 1 food stamp (old rule gave 3 visits)', :'got');
-- QR page sees the new fields
select qr_token as tok from dining_tables where business_id = :'biz' and kind = 'TAKEAWAY' \gset
select test.chk((public._qr_customer_json((select c from customers c where id = :'zed')) @> '{"visit_count":1,"stamps":2,"total_stamps":2,"drink_stamps_earned":1,"food_stamps_earned":1,"card":{"card_no":1,"stamps_on_card":2,"card_size":15}}'::jsonb)
            and public._qr_customer_json((select c from customers c where id = :'zed')) ?& array['ready_rewards','loyalty_rewards'], 'D: QR customer json has the stamp card');
select test.chk(public.get_qr_menu(:'tok') ?& array['stamps_per_reward','loyalty_rewards'] and public.get_qr_menu(:'tok')->'theme'->>'theme' = 'CCCC', 'D/F: get_qr_menu has loyalty_rewards + theme.brand_theme CCCC');
select test.chk((select theme from settings where business_id = :'biz') = 'CCCC', 'F: existing shop starts on brand_theme CCCC');
select test.chk(test.err($$update settings set theme = 'PINK' where business_id = (select business_id from profiles where id = '00000000-0000-0000-0000-0000000000a1')$$) like '%settings_theme_check%', 'F: unknown brand_theme refused');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes('[{"op":"upsert","table":"settings","row":{"theme":"dark","tax_pct":0}}]');
select test.chk((select theme from settings where business_id = :'biz') = 'CCCC', 'F: an old Back Office sending theme dark still saves; look stays CCCC');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"settings","row":{"theme":"CUSTOM"}}]')$$) = 'NO ERROR', 'F: owner can switch brand_theme');
select public.apply_changes('[{"op":"upsert","table":"settings","row":{"theme":"CCCC","loyalty_enabled":true}}]');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"settings","row":{"loyalty_rewards":{"card_size":15,"rewards":[{"stamp":16,"type":"AMOUNT_OFF","amount":10}]}}}]')$$) = 'BAD_LOYALTY_REWARDS', 'D: reward beyond the card refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"settings","row":{"loyalty_rewards":{"card_size":15,"rewards":[{"stamp":5,"type":"AMOUNT_OFF","amount":"x"}]}}}]')$$) = 'BAD_LOYALTY_REWARDS', 'D: text amount refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"settings","row":{"loyalty_rewards":{"card_size":15,"rewards":[{"stamp":5,"type":"AMOUNT_OFF","amount":10},{"stamp":5,"type":"FREE_ITEM"}]}}}]')$$) = 'BAD_LOYALTY_REWARDS', 'D: same stamp twice refused');
reset role;

-- ======================= E. counter customers tab =======================
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select public.fo_customer_list('', 50, null) as l \gset
select test.chk(:'l'::jsonb->>'show_money' = 'false' and :'l'::jsonb->'money_refused' = 'null'::jsonb and :'l'::text not like '%+639%'
            and not exists (select 1 from jsonb_array_elements(:'l'::jsonb->'customers') c where c ? 'total_spent' or c ? 'notes')
            and exists (select 1 from jsonb_array_elements(:'l'::jsonb->'customers') c where c->>'nickname' = 'Stampy' and c->>'phone' = '0918 ••• 2233'
                        and (c->>'drink_stamps_earned')::int = 4 and (c->>'food_stamps_earned')::int = 2 and c ? 'card'),
  'E: list without token: masked phone, visits/stamps, NO total_spent / notes', left(:'l', 400));
select test.chk(jsonb_array_length(public.fo_customer_list('stam', 10, null)->'customers') = 1 and jsonb_array_length(public.fo_customer_list('0918', 10, null)->'customers') = 0
            and jsonb_array_length(public.fo_customer_list('%', 10, null)->'customers') = 0, 'E: search by nickname only (not phone; % is not a wildcard)');
select test.chk((select public.fo_customer_list('', 10, :'cashier_token')->>'money_refused') = 'ROLE_TOO_LOW', 'E: cashier token -> no money (ROLE_TOO_LOW)');
select public.fo_customer_detail('c5000000-0000-0000-0000-000000000001', null) as d \gset
select test.chk(:'d'::jsonb->>'show_money' = 'false' and :'d'::text not like '%grand_total%' and :'d'::text not like '%total_spent%' and :'d'::text not like '%refunded"%'
            and jsonb_array_length(:'d'::jsonb->'recent_orders') = 9
            and (select string_agg((f->>'name') || '=' || (f->>'count'), ',') from jsonb_array_elements(:'d'::jsonb->'favourites') f) = 'Iced Latte=6,Ensaymada=2',
  'E: detail without token: favourites net of refunds/voids, 9 recent orders (HELD left out), no money',
  (select string_agg((f->>'name') || '=' || (f->>'count'), ',') from jsonb_array_elements(:'d'::jsonb->'favourites') f) || ' / ' || jsonb_array_length(:'d'::jsonb->'recent_orders'));
-- manager signs in: LOGIN token shows money and is not used up
select (public.staff_pin_login('222222')) ->> 'token' as mgr_token \gset
select public.fo_customer_detail('c5000000-0000-0000-0000-000000000001', :'mgr_token') as d \gset
select test.chk(:'d'::jsonb->>'show_money' = 'true' and (:'d'::jsonb->'customer'->>'total_spent')::numeric = 650
            and (select bool_and(o ? 'grand_total' and o ? 'refunded') from jsonb_array_elements(:'d'::jsonb->'recent_orders') o),
  'E: manager LOGIN token -> total_spent (7 x 100 counted, D1/D4 voids excluded, minus 50 refunded = 650) + per-order money', :'d'::jsonb->'customer'->>'total_spent');
select test.chk((public.fo_customer_list('', 5, :'mgr_token')->>'show_money')::boolean
            and (public.fo_customer_list('', 5, :'mgr_token')->>'show_money')::boolean, 'E: LOGIN token reusable');
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER')) ->> 'token' as ovr_token \gset
select test.chk(public.fo_customer_list('', 5, :'ovr_token')->>'money_refused' = 'APPROVAL_INVALID' and not (public.fo_customer_list('', 5, :'ovr_token')->>'show_money')::boolean, 'E: an OVERRIDE token is NOT accepted for the money view (only the current LOGIN)');
reset role;
select test.chk((select used_at is null from staff_sessions where token_hash = encode(extensions.digest(:'ovr_token', 'sha256'), 'hex')), 'E: viewing does not use up the OVERRIDE token');
-- short PIN manager: no money
update staff_pins set pin_length = 5 where staff_id = '66666666-0000-0000-0000-000000000002';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(public.fo_customer_list('', 5, :'mgr_token')->>'money_refused' = 'PIN_UPDATE_NEEDED', 'E: manager with a short PIN -> PIN_UPDATE_NEEDED, no money');
reset role;
update staff_pins set pin_length = 6 where staff_id = '66666666-0000-0000-0000-000000000002';
-- token ended (new sign-in on the counter) -> invalid
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select public.staff_pin_login('1111') is not null as x \gset
select test.chk(public.fo_customer_list('', 5, :'mgr_token')->>'money_refused' = 'APPROVAL_INVALID', 'E: manager token ended by the next sign-in -> APPROVAL_INVALID');
select test.chk(public.fo_customer_list('', 5, 'garbage')->>'money_refused' = 'APPROVAL_INVALID', 'E: made-up token -> APPROVAL_INVALID');
reset role;
-- token used from another login (the other shop's owner / a customer) -> nothing
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err('select public.fo_customer_list()') = 'NOT_ALLOWED', 'E: owner Back Office login cannot use the counter function');
reset role;
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select test.chk(test.err('select public.fo_customer_list()') in ('NOT_A_MEMBER','NOT_ALLOWED') and test.err($$select public.fo_customer_detail('c5000000-0000-0000-0000-000000000001')$$) in ('NOT_A_MEMBER','NOT_ALLOWED'), 'E: QR customer cannot call it');
reset role;
set role anon;
select test.chk(test.err('select public.fo_customer_list()') like 'permission denied%', 'E: anon cannot call it');
reset role;
-- cross-shop: a customer of the other shop
insert into customers(id, business_id, nickname, source) values ('c5000000-0000-0000-0000-0000000000b2', :'biz2', 'OtherShopGuy', 'QR');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(public.fo_customer_detail('c5000000-0000-0000-0000-0000000000b2')->>'error' = 'NOT_FOUND'
            and jsonb_array_length(public.fo_customer_list('OtherShop', 10)->'customers') = 0, 'E: other shop''s customer not visible');
reset role;
-- ======================= R. rewards at the counter =======================
create or replace function test.sale_op(p_op text, p_sale text, p_cust uuid, p_items jsonb, p_sub numeric, p_loy numeric, p_grand numeric, p_rw jsonb)
returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('op_id', p_op, 'type', 'sale', 'data', jsonb_build_object(
    'sale', jsonb_build_object('id', p_sale, 'transaction_number', 'POS-A-2026-' || right(p_sale, 6), 'transaction_date', now(), 'status', 'COMPLETED',
       'cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy', 'shift_id', '88888888-0000-0000-0000-0000000008a0',
       'subtotal', p_sub, 'discount_amount', 0, 'loyalty_discount', p_loy, 'tax_amount', 0,
       'service_charge_amount', round((p_sub - p_loy) * 0.10, 2), 'grand_total', p_grand, 'customer_id', p_cust)
       || case when p_rw is null then '{}'::jsonb else jsonb_build_object('loyalty_reward', p_rw) end,
    'items', p_items,
    'payment', jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', p_grand),
    'inventory', '[]'::jsonb)))
$$;
grant execute on all functions in schema test to anon, authenticated;
select '[{"recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]' as latte \gset
select public._loyalty_summary(:'biz', 'c5000000-0000-0000-0000-000000000001') as ls \gset
select test.chk((:'ls'::jsonb->>'total_stamps')::int = 6 and (:'ls'::jsonb->'card'->>'stamps_on_card')::int = 6
  and (select string_agg((m->>'stamp') || ':' || (m->>'status'), ',') from jsonb_array_elements(:'ls'::jsonb->'card'->'milestones') m) = '5:ready,10:locked,15:locked',
  'R: Stampy 6 stamps: card 1, 6/15, 5 ready, 10/15 locked', :'ls');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
-- ₱10 off: subtotal 150, reward 10, service 10% of 140 = 14, total 154
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009a1', '99999999-0000-0000-0000-0000000009a1',
  'c5000000-0000-0000-0000-000000000001', :'latte', 150, 10, 154, '{"customer_id":"c5000000-0000-0000-0000-000000000001","card_no":1,"milestone":5}')) as r \gset
select test.chk(:'r'::jsonb->0->>'status' = 'ok', 'R: ₱10 reward accepted', :'r');
-- same reward again on another sale
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009a2', '99999999-0000-0000-0000-0000000009a2',
  'c5000000-0000-0000-0000-000000000001', :'latte', 150, 10, 154, '{"customer_id":"c5000000-0000-0000-0000-000000000001","card_no":1,"milestone":5}')) as r \gset
select test.chk(:'r'::jsonb->0->>'message' = 'REWARD_NOT_AVAILABLE', 'R: same reward twice -> REWARD_NOT_AVAILABLE', :'r');
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009a3', '99999999-0000-0000-0000-0000000009a3',
  'c5000000-0000-0000-0000-000000000001', :'latte', 150, 50, 110, '{"customer_id":"c5000000-0000-0000-0000-000000000001","card_no":1,"milestone":10}')) as r \gset
select test.chk(:'r'::jsonb->0->>'message' = 'REWARD_NOT_AVAILABLE', 'R: stamp 10 not reached -> REWARD_NOT_AVAILABLE', :'r');
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009a4', '99999999-0000-0000-0000-0000000009a4',
  :'zed', :'latte', 150, 10, 154, '{"customer_id":"c5000000-0000-0000-0000-000000000001","card_no":1,"milestone":5}')) as r \gset
select test.chk(:'r'::jsonb->0->>'message' = 'REWARD_NOT_AVAILABLE', 'R: reward of another customer than the sale''s -> REWARD_NOT_AVAILABLE', :'r');
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009a5', '99999999-0000-0000-0000-0000000009a5',
  'c5000000-0000-0000-0000-000000000001', :'latte', 150, 10, 154, null)) as r \gset
select test.chk(:'r'::jsonb->0->>'message' = 'SALE_TOTALS_MISMATCH', 'R: loyalty_discount without a reward is not accepted (SALE_TOTALS_MISMATCH)', :'r');
reset role;
select test.chk((select count(*) from sales where id in ('99999999-0000-0000-0000-0000000009a2','99999999-0000-0000-0000-0000000009a3','99999999-0000-0000-0000-0000000009a4','99999999-0000-0000-0000-0000000009a5')) = 0,
  'R: refused sales saved nothing');
select test.chk((select loyalty_discount = 10 and grand_total = 154 from sales where id = '99999999-0000-0000-0000-0000000009a1')
  and (select count(*) = 1 from loyalty_redemptions where sale_id = '99999999-0000-0000-0000-0000000009a1' and card_no = 1 and milestone = 5 and amount = 10 and reward_type = 'AMOUNT_OFF'),
  'R: sale has loyalty_discount 10, redemption row saved');
select test.chk((select string_agg((m->>'stamp') || ':' || (m->>'status'), ',') from jsonb_array_elements(public._loyalty_summary(:'biz', 'c5000000-0000-0000-0000-000000000001')->'card'->'milestones') m) = '5:redeemed,10:locked,15:locked',
  'R: stamp 5 now redeemed');
select test.chk(test.err($$update sales set loyalty_discount = 0 where id = '99999999-0000-0000-0000-0000000009a1'$$) = 'SALE_LOCKED', 'R: loyalty_discount locked on a finished sale');
-- void releases it
update sales set status = 'VOIDED' where id = '99999999-0000-0000-0000-0000000009a1';
select test.chk((select released_at is not null from loyalty_redemptions where sale_id = '99999999-0000-0000-0000-0000000009a1'), 'R: void releases the reward');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009a6', '99999999-0000-0000-0000-0000000009a6',
  'c5000000-0000-0000-0000-000000000001', :'latte', 150, 5, 159.5, '{"customer_id":"c5000000-0000-0000-0000-000000000001","card_no":1,"milestone":5}')) as r \gset
select test.chk(:'r'::jsonb->0->>'message' = 'REWARD_AMOUNT_MISMATCH', 'R: counter amount ₱5 for a ₱10 reward -> REWARD_AMOUNT_MISMATCH', :'r');
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009a7', '99999999-0000-0000-0000-0000000009a7',
  'c5000000-0000-0000-0000-000000000001', :'latte', 150, 10, 154, '{"customer_id":"c5000000-0000-0000-0000-000000000001","card_no":1,"milestone":5}')) as r \gset
select test.chk(:'r'::jsonb->0->>'status' = 'ok', 'R: released reward can be used again', :'r');
reset role;
-- 15 stamps: 9 more drink days -> 6 + 1 (today) + 9 = 16? today already has Stampy's drink from 9a7 -> 7; add 8 days -> 15
do $$ declare i int; begin
  for i in 1..8 loop
    perform test.mk_sale(format('5b000000-0000-0000-0000-%s', lpad(i::text, 12, '0')), 'c5000000-0000-0000-0000-000000000001', ('2026-09-01 10:00+08'::timestamptz + make_interval(days => i)), 'COMPLETED', 1, 0);
  end loop; end $$;
select public._loyalty_summary(:'biz', 'c5000000-0000-0000-0000-000000000001') as ls \gset
select test.chk((:'ls'::jsonb->>'total_stamps')::int = 15 and (:'ls'::jsonb->'card'->>'card_no')::int = 1 and (:'ls'::jsonb->'card'->>'stamps_on_card')::int = 15
  and (select string_agg((m->>'stamp') || ':' || (m->>'status'), ',') from jsonb_array_elements(:'ls'::jsonb->'card'->'milestones') m) = '5:redeemed,10:ready,15:ready'
  and jsonb_array_length(:'ls'::jsonb->'ready_rewards') = 2,
  'R: 15 stamps: card 1 full (15/15), 10 + 15 ready', :'ls'::jsonb->>'card');
-- free item: 2 Iced Latte 16oz + shot + oat at 225 -> reward 225 (one unit, server menu price)
select '[{"recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":2,"unit_price":225,"line_total":450,"modifiers":[{"group":"Size","label":"16oz","price_delta":20},{"group":"Add-ons","label":"Extra shot","price_delta":30},{"group":"Add-ons","label":"Oat milk","price_delta":25}]}]' as big \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009a8', '99999999-0000-0000-0000-0000000009a8',
  'c5000000-0000-0000-0000-000000000001', :'big', 450, 225, 247.5, '{"customer_id":"c5000000-0000-0000-0000-000000000001","card_no":1,"milestone":15,"recipe_id":"33333333-0000-0000-0000-000000000001"}')) as r \gset
select test.chk(:'r'::jsonb->0->>'status' = 'ok', 'R: free item = one unit at the server price (225)', :'r');
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009a9', '99999999-0000-0000-0000-0000000009a9',
  'c5000000-0000-0000-0000-000000000001', :'latte', 150, 50, 110, '{"customer_id":"c5000000-0000-0000-0000-000000000001","card_no":1,"milestone":10,"recipe_id":"33333333-0000-0000-0000-0000000000a1"}')) as r \gset
select test.chk(:'r'::jsonb->0->>'status' = 'ok', 'R: ₱50 reward on a ₱150 sale', :'r');
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009b1', '99999999-0000-0000-0000-0000000009b1',
  'c5000000-0000-0000-0000-000000000001', :'latte', 150, 80, 77, '{"customer_id":"c5000000-0000-0000-0000-000000000001","card_no":2,"milestone":5}')) as r \gset
select test.chk(:'r'::jsonb->0->>'message' = 'REWARD_NOT_AVAILABLE', 'R: card 2 stamp 5 not reached yet', :'r');
reset role;
select public._loyalty_summary(:'biz', 'c5000000-0000-0000-0000-000000000001') as ls \gset
select test.chk((:'ls'::jsonb->'card'->>'card_no')::int = 1 and jsonb_array_length(:'ls'::jsonb->'ready_rewards') = 0
  and (select bool_and(m->>'status' = 'redeemed') from jsonb_array_elements(:'ls'::jsonb->'card'->'milestones') m), 'R: card 1 all redeemed', :'ls'::jsonb->>'card');
insert into customers(id, business_id, nickname, source) values ('c5000000-0000-0000-0000-0000000000e1', :'biz', 'Edge', 'COUNTER');
do $$ declare i int; begin
  for i in 1..4 loop
    perform test.mk_sale(format('5c000000-0000-0000-0000-%s', lpad(i::text, 12, '0')), 'c5000000-0000-0000-0000-0000000000e1', ('2026-08-01 10:00+08'::timestamptz + make_interval(days => i)), 'COMPLETED', 1, 0);
  end loop; end $$;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009c1', '99999999-0000-0000-0000-0000000009c1',
  'c5000000-0000-0000-0000-0000000000e1', :'latte', 150, 10, 154, '{"customer_id":"c5000000-0000-0000-0000-0000000000e1","card_no":1,"milestone":5}')) as r \gset
select test.chk(:'r'::jsonb->0->>'message' = 'REWARD_NOT_AVAILABLE', 'R: the 5th stamp from THIS sale does not unlock stamp 5 on it', :'r');
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009c2', '99999999-0000-0000-0000-0000000009c2',
  'c5000000-0000-0000-0000-0000000000e1', :'latte', 150, 0, 165, null)) as r \gset
select public.fo_sync('device-key-0001-abcdef', test.sale_op('a0000000-0000-0000-0000-0000000009c3', '99999999-0000-0000-0000-0000000009c3',
  'c5000000-0000-0000-0000-0000000000e1', :'latte', 150, 10, 154, '{"customer_id":"c5000000-0000-0000-0000-0000000000e1","card_no":1,"milestone":5}')) as r \gset
select test.chk(:'r'::jsonb->0->>'status' = 'ok', 'R: ... but works on the next sale', :'r');
reset role;
-- merge: Edge merged into Stampy; Edge's card-1 stamp-5 conflicts (Stampy used it) -> history only
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.merge_customers('c5000000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-0000000000e1') is not null as x \gset
reset role;
select test.chk((select count(*) from loyalty_redemptions where customer_id = 'c5000000-0000-0000-0000-0000000000e1') = 0
  and (select count(*) from loyalty_redemptions where customer_id = 'c5000000-0000-0000-0000-000000000001' and merged_from = 'c5000000-0000-0000-0000-0000000000e1') = 1,
  'R: merge moves rewards; a reward both used is kept as history');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk((select count(*) from loyalty_redemptions) = 0, 'R: counter cannot read loyalty_redemptions directly');
reset role;

-- merged / deleted customers
update customers set merged_into = :'zed' where id = 'c5000000-0000-0000-0000-000000000001';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(public.fo_customer_detail('c5000000-0000-0000-0000-000000000001')->>'error' = 'NOT_FOUND', 'E: merged-away customer -> NOT_FOUND');
reset role;
update customers set merged_into = null where id = 'c5000000-0000-0000-0000-000000000001';
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.delete_customer_data('c5000000-0000-0000-0000-000000000001') is not null as x \gset
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(public.fo_customer_detail('c5000000-0000-0000-0000-000000000001')->>'error' = 'NOT_FOUND'
            and jsonb_array_length(public.fo_customer_list('Stampy', 10)->'customers') = 0, 'E: erased customer gone from the counter');
reset role;
select test.chk((select count(*) from loyalty_redemptions where customer_id = 'c5000000-0000-0000-0000-000000000001') = 0, 'R: erasing a customer deletes their reward rows');
set role authenticated;
reset role;
-- rate limit
insert into auth_attempts(subject, kind, success) select '00000000-0000-0000-0000-0000000000d1', 'CUSTOMER_VIEW', true from generate_series(1, 120);
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(public.fo_customer_list()->>'error' = 'TOO_MANY_ATTEMPTS', 'E: 120 calls per hour per counter, then TOO_MANY_ATTEMPTS');
reset role;
-- grants
select test.chk(not has_function_privilege('authenticated', 'public._customer_loyalty(uuid,uuid,uuid)', 'execute')
            and not has_function_privilege('authenticated', 'public._brand_lots(uuid,uuid)', 'execute')
            and not has_function_privilege('authenticated', 'public._money_view_check(uuid,text)', 'execute')
            and not has_function_privilege('anon', 'public.fo_customer_detail(uuid,text)', 'execute')
            and has_function_privilege('anon', 'public.get_qr_menu(text)', 'execute')
            and has_function_privilege('authenticated', 'public.fo_floor_plan()', 'execute'), 'grants: helpers internal, member fns for logins, QR menu public');

-- ======================= S. security review fixes (M1, M3, _to_num, sales_report) =======================
select id as zed from customers where nickname = 'Zed' and business_id = :'biz' \gset
create or replace function test.zed_op(p_op text, p_sale text, p_at timestamptz, p_unit numeric, p_grand numeric, p_cust uuid) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('op_id', p_op, 'type', 'sale', 'data', jsonb_build_object(
    'sale', jsonb_build_object('id', p_sale, 'transaction_number', 'POS-A-2026-' || right(p_sale, 6), 'transaction_date', p_at, 'status', 'COMPLETED',
       'cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy', 'shift_id', '88888888-0000-0000-0000-0000000008a0',
       'subtotal', p_unit, 'discount_amount', 0, 'tax_amount', 0, 'service_charge_amount', round(p_unit * 0.10, 2), 'grand_total', p_grand,
       'customer_id', p_cust, 'received_at', '2020-01-01T00:00:00Z'),
    'items', jsonb_build_array(jsonb_build_object('recipe_id', '33333333-0000-0000-0000-000000000001', 'name', 'Iced Latte', 'quantity', 1, 'unit_price', p_unit, 'line_total', p_unit)),
    'payment', jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', p_grand),
    'inventory', '[]'::jsonb)))
$$;
grant execute on all functions in schema test to anon, authenticated;
select visits as v0, drink_stamps as d0 from public._customer_loyalty(:'biz', :'zed') \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
-- two sales dated 30 and 20 days ago: the server bounds both to (received - 7 days) -> ONE day
select public.fo_sync('device-key-0001-abcdef', test.zed_op('a0000000-0000-0000-0000-000000000ab1', '99999999-0000-0000-0000-000000000ab1', now() - interval '30 days', 150, 165, :'zed')) as r1 \gset
select public.fo_sync('device-key-0001-abcdef', test.zed_op('a0000000-0000-0000-0000-000000000ab2', '99999999-0000-0000-0000-000000000ab2', now() - interval '20 days', 150, 165, :'zed')) as r2 \gset
-- a ₱0 sale 3 days ago: no stamp
select public.fo_sync('device-key-0001-abcdef', test.zed_op('a0000000-0000-0000-0000-000000000ab3', '99999999-0000-0000-0000-000000000ab3', now() - interval '3 days', 0, 0, :'zed')) as r3 \gset
-- sold below the menu 2 days ago: flagged, no stamp until the owner clears the flag
select public.fo_sync('device-key-0001-abcdef', test.zed_op('a0000000-0000-0000-0000-000000000ab4', '99999999-0000-0000-0000-000000000ab4', now() - interval '2 days', 100, 110, :'zed')) as r4 \gset
-- dated 2 days in the future: flagged FUTURE_DATE, stamp day bounded to today
select public.fo_sync('device-key-0001-abcdef', test.zed_op('a0000000-0000-0000-0000-000000000ab5', '99999999-0000-0000-0000-000000000ab5', now() + interval '2 days', 150, 165, :'zed')) as r5 \gset
reset role;
select test.chk(:'r1'::jsonb->0->>'status' = 'ok' and :'r2'::jsonb->0->>'status' = 'ok' and :'r3'::jsonb->0->>'status' = 'ok' and :'r4'::jsonb->0->>'status' = 'ok' and :'r5'::jsonb->0->>'status' = 'ok', 'S: five test sales uploaded');
select test.chk((select bool_and(received_at > now() - interval '5 minutes') from sales where id in ('99999999-0000-0000-0000-000000000ab1','99999999-0000-0000-0000-000000000ab5')), 'S/M1: received_at set by the server (the counter''s value is ignored)');
select test.chk((select visits = :v0 + 1 and drink_stamps = :d0 + 1 from public._customer_loyalty(:'biz', :'zed')), 'S/M1: back-dated (30 + 20 days) sales count as ONE day (received - 7 days); ₱0, below-menu and future-dated sales add nothing',
  (select format('%s visits / %s drink (was %s / %s)', visits, drink_stamps, :v0, :d0) from public._customer_loyalty(:'biz', :'zed')));
select test.chk((select review_reason like '%FUTURE_DATE%' and needs_review from sales where id = '99999999-0000-0000-0000-000000000ab5')
            and (select review_reason like '%PRICE_BELOW_MENU%' from sales where id = '99999999-0000-0000-0000-000000000ab4'), 'S/M1: future date flagged FUTURE_DATE; below-menu flagged');
update sales set needs_review = false where id = '99999999-0000-0000-0000-000000000ab4';
select test.chk((select visits = :v0 + 2 and drink_stamps = :d0 + 2 from public._customer_loyalty(:'biz', :'zed')), 'S/M1: owner clears the below-menu flag -> that day counts');
select test.chk((select visit_count = :v0 + 2 from customers where id = :'zed'), 'S/M4: stored copy follows (pending-customer trigger)');
select test.chk((select count(*) from loyalty_pending) = 0, 'S/M4: nothing left pending after the save');
-- M3: free item needs a whole quantity >= 1, capped at unit price and line total
insert into customers(id, business_id, nickname, source) values ('c5000000-0000-0000-0000-0000000000f1', :'biz', 'Freebie', 'COUNTER');
do $$ declare i int; begin
  for i in 1..15 loop
    perform test.mk_sale(format('5d000000-0000-0000-0000-%s', lpad(i::text, 12, '0')), 'c5000000-0000-0000-0000-0000000000f1',
                         ('2026-06-01 10:00+08'::timestamptz + make_interval(days => i)), 'COMPLETED', 1, 0);
  end loop; end $$;
select test.chk(test.err(format($q$select public._loyalty_reward_amount(%L, gen_random_uuid(), %L::jsonb, '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":0.5,"unit_price":150,"line_total":75}]', %L::jsonb)$q$,
   :'biz', jsonb_build_object('customer_id', 'c5000000-0000-0000-0000-0000000000f1', 'subtotal', 75, 'discount_amount', 0), jsonb_build_object('customer_id', 'c5000000-0000-0000-0000-0000000000f1', 'card_no', 1, 'milestone', 15, 'recipe_id', '33333333-0000-0000-0000-000000000001'))) = 'REWARD_NOT_AVAILABLE',
  'S/M3: free item on a half-quantity line refused');
select test.chk(public._loyalty_reward_amount(:'biz', gen_random_uuid(), jsonb_build_object('customer_id', 'c5000000-0000-0000-0000-0000000000f1', 'subtotal', 300, 'discount_amount', 0),
   '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":0.5,"unit_price":150,"line_total":75},{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":2,"unit_price":112.5,"line_total":225}]',
   jsonb_build_object('customer_id', 'c5000000-0000-0000-0000-0000000000f1', 'card_no', 1, 'milestone', 15, 'recipe_id', '33333333-0000-0000-0000-000000000001')) = 112.5,
  'S/M3: only whole-quantity lines count; one unit capped at that line''s unit price');
-- _to_num reads long decimals: no false TAX_MISMATCH
select test.chk(public._sale_money_review(:'biz', '{"subtotal":27.191125000000005,"discount_amount":0,"tax_amount":0,"service_charge_amount":2.7191125000000005,"grand_total":29.91}'::jsonb,
   '{"method":"CASH","amount":29.91}'::jsonb) is null and public._to_num('2.7191125000000005') = 2.7191125000000005 and public._to_num('1234567890123456') is null,
  'S: _to_num reads any number of decimals (no false TAX_MISMATCH), still max 15 digits before the point');
-- sales_report totals
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.sales_report(now() - interval '2 years', now() + interval '1 year')->'totals' as tot \gset
reset role;
select test.chk(abs((:'tot'::jsonb->>'item_sales')::numeric - (:'tot'::jsonb->>'discounts')::numeric - (:'tot'::jsonb->>'loyalty_rewards')::numeric
                    + (:'tot'::jsonb->>'tax')::numeric + (:'tot'::jsonb->>'service_charge')::numeric - (:'tot'::jsonb->>'sales')::numeric) < 0.01
            and (:'tot'::jsonb->>'loyalty_rewards')::numeric = (select sum(loyalty_discount) from sales where business_id = :'biz' and status not in ('HELD','VOIDED'))
            and (:'tot'::jsonb->>'loyalty_rewards')::numeric > 0,
  'S: sales_report totals: item_sales - discounts - loyalty_rewards + tax + service_charge = sales', :'tot');
-- L3: counters and other rank-0 logins read no brands / tables; owner still does
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk((select count(*) from dining_tables) > 0 and (select count(*) from ingredient_brands) > 0, 'S/L3: owner still reads tables and brands');
reset role;

-- N1: a real-price sale that was not paid in full (PAYMENT_MISMATCH) earns no stamp until the owner clears the flag
select visits as v1, drink_stamps as d1s from public._customer_loyalty(:'biz', :'zed') \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select public.fo_sync('device-key-0001-abcdef', jsonb_set(test.zed_op('a0000000-0000-0000-0000-000000000ab6', '99999999-0000-0000-0000-000000000ab6', now() - interval '4 days', 150, 165, :'zed'),
  '{0,data,payment,amount}', '1')) as r6 \gset
reset role;
select test.chk(:'r6'::jsonb->0->>'status' = 'ok' and (select needs_review and review_reason like '%PAYMENT_MISMATCH%' from sales where id = '99999999-0000-0000-0000-000000000ab6')
            and (select visits = :v1 and drink_stamps = :d1s from public._customer_loyalty(:'biz', :'zed')), 'S/N1: unpaid real-price sale (PAYMENT_MISMATCH) earns no stamp', :'r6');
update sales set needs_review = false where id = '99999999-0000-0000-0000-000000000ab6';
select test.chk((select visits = :v1 + 1 and drink_stamps = :d1s + 1 from public._customer_loyalty(:'biz', :'zed')), 'S/N1: ... counts once the owner clears the flag');
-- received_at can't be changed (or emptied) on a finished sale, even by the owner's Back Office
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000ab1","received_at":"2020-01-01T00:00:00Z"}}]')$$) = 'SALE_LOCKED'
            and test.err($$select public.apply_changes('[{"op":"update","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000ab1","received_at":null}}]')$$) = 'SALE_LOCKED',
  'S/low: received_at can''t be changed or emptied on a finished sale');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"sales","row":{"id":"99999999-0000-0000-0000-000000000ab9","transaction_number":"IMP-1","transaction_date":"2025-01-01T00:00:00Z","status":"COMPLETED","subtotal":100,"discount_amount":0,"tax_amount":0,"service_charge_amount":0,"grand_total":100,"received_at":"2025-01-01T00:05:00Z"}}]')$$) = 'NO ERROR',
  'S/low: an imported (new) finished sale may still bring its own received_at');
reset role;
