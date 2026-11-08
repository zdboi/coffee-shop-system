-- Checks for cccc/supabase/010_release_1_4.sql (release 1.4), ported by QA 2026-11-03 from the database engineer.
-- Needs a database with 004..010 on which 10_behaviour_tests + 11_qr_tests have JUST run:
--   tests/reset_db.sh "" cccc
--   P="psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1"
--   $P -f tests/sql/10_behaviour_tests.sql && $P -f tests/sql/11_qr_tests.sql && $P -f tests/sql/40_release_1_4_tests.sql
-- (tests/run_all.sh does exactly this.)
-- Prints "ok ..." / "FAIL ..." per check and keeps going.
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
-- one fo_sync op from the counter
create or replace function test.op(p_type text, p_data jsonb, p_opid uuid default gen_random_uuid()) returns jsonb language sql as $$
  select public.fo_sync('device-key-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id', p_opid, 'type', p_type, 'data', p_data)))->0
$$;
create or replace function test.stock(p_ing uuid) returns numeric language sql as $$
  select coalesce((select stock from public.v_ingredient_stock where ingredient_id = p_ing), 0)
$$;
grant execute on all functions in schema test to anon, authenticated;

select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select qr_token as tok from dining_tables where business_id = :'biz' and kind = 'TAKEAWAY' limit 1 \gset
-- re-pair the counter (suite 11 removed it) and sign the cashier in online
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select (public.create_device_pairing_code('Front Counter'))->>'code' as paircode \gset
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select (public.redeem_device_pairing(:'paircode', 'device-key-0001-abcdef', 'Front Counter')->'device'->>'active') as x \gset
select (public.staff_pin_login('1111'))->>'token' as cashier_token \gset
reset role;
delete from auth_attempts;
-- an open shift so the QR page is open
select id as shift_id from shifts where business_id = :'biz' and status = 'ACTIVE' limit 1 \gset

-- ============================ U. units ============================
select test.chk(public._to_base_qty(1.5, 'kg', 'g') = 1500, 'U: 1.5 kg -> 1500 g');
select test.chk(public._to_base_qty(150, 'mL', 'L') = 0.15, 'U: 150 mL -> 0.15 L');
select test.chk(public._to_base_qty(125, 'g', 'ml', 1.25) = 100, 'U: 125 g -> 100 mL with weighs 1.25');
select test.chk(public._to_base_qty(1, 'L', 'g', 1.25) = 1250, 'U: 1 L -> 1250 g with weighs 1.25');
select test.chk(public._to_base_qty(5, 'g', 'ml') is null, 'U: g -> mL without weighs = null');
select test.chk(public._to_base_qty(2, 'box', 'pcs') is null and public._to_base_qty(2, null, 'pcs') = 2, 'U: count units only match themselves');

-- ============================ W. weighs (A10) ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"ingredients","row":{"id":"22222222-0000-0000-0000-000000000002","weight_g_per_ml":1.03}}]')$$) like 'WEIGHS_PRODUCED_ONLY%', 'W: weighs refused on a bought ingredient');
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','a1000000-0000-0000-0000-000000000001','name','Caramel sauce (house)','base_unit','ml','is_produced_item',true,'weight_g_per_ml',1.25)),
  jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object('id','a2000000-0000-0000-0000-000000000001','name','Caramel Latte','recipe_type','DRINKS','category','Iced','selling_price',170)),
  jsonb_build_object('op','upsert','table','recipe_ingredients','row', jsonb_build_object('id','a3000000-0000-0000-0000-000000000001','recipe_id','a2000000-0000-0000-0000-000000000001','ingredient_id','a1000000-0000-0000-0000-000000000001','entered_quantity',25,'unit','g','quantity',999)),
  jsonb_build_object('op','upsert','table','recipe_ingredients','row', jsonb_build_object('id','a3000000-0000-0000-0000-000000000002','recipe_id','a2000000-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000002','entered_quantity',0.2,'unit','L','quantity',0))));
select test.chk((select quantity from recipe_ingredients where id = 'a3000000-0000-0000-0000-000000000001') = 20, 'W: 25 g of caramel (1.25 g/mL) saved as 20 mL', (select quantity::text from recipe_ingredients where id = 'a3000000-0000-0000-0000-000000000001'));
select test.chk((select quantity from recipe_ingredients where id = 'a3000000-0000-0000-0000-000000000002') = 200, 'W: 0.2 L of milk saved as 200 mL');
select public.apply_changes('[{"op":"update","table":"ingredients","row":{"id":"a1000000-0000-0000-0000-000000000001","weight_g_per_ml":1.0}}]');
select test.chk((select quantity from recipe_ingredients where id = 'a3000000-0000-0000-0000-000000000001') = 25, 'W: weighs changed -> recipe line converted again (25 mL)');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"recipe_ingredients","row":{"id":"a3000000-0000-0000-0000-000000000009","recipe_id":"a2000000-0000-0000-0000-000000000001","ingredient_id":"22222222-0000-0000-0000-000000000002","entered_quantity":5,"unit":"g","quantity":5}}]')$$) like 'BAD_UNIT%', 'W: grams on a bought mL ingredient -> BAD_UNIT');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"ingredients","row":{"id":"a1000000-0000-0000-0000-000000000001","is_produced_item":false}}]')$$) like 'WEIGHS_PRODUCED_ONLY%', 'W: can''t turn a weighed item into a bought one');
-- old-style line (no entered_quantity) is stored as sent
select public.apply_changes('[{"op":"update","table":"recipe_ingredients","row":{"id":"a3000000-0000-0000-0000-000000000002","entered_quantity":null,"quantity":180,"unit":"ml"}}]');
select test.chk((select quantity from recipe_ingredients where id = 'a3000000-0000-0000-0000-000000000002') = 180, 'W: old apps: quantity kept as sent');

-- ============================ L. option library (A9) ============================
-- stock items: cups / lids (pcs), oat milk (mL)
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','a1000000-0000-0000-0000-000000000011','name','Iced cup 16oz','base_unit','pcs')),
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','a1000000-0000-0000-0000-000000000012','name','Dome lid','base_unit','pcs')),
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','a1000000-0000-0000-0000-000000000013','name','Non-dairy Milk','base_unit','L')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','a4000000-0000-0000-0000-000000000011','ingredient_id','a1000000-0000-0000-0000-000000000011','transaction_type','INITIAL_STOCK','quantity',100,'transaction_date','2026-11-01')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','a4000000-0000-0000-0000-000000000012','ingredient_id','a1000000-0000-0000-0000-000000000012','transaction_type','INITIAL_STOCK','quantity',100,'transaction_date','2026-11-01')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','a4000000-0000-0000-0000-000000000013','ingredient_id','a1000000-0000-0000-0000-000000000013','transaction_type','INITIAL_STOCK','quantity',5,'transaction_date','2026-11-01'))));
select modifier_groups::text as latte_groups_before from recipes where id = '33333333-0000-0000-0000-000000000001' \gset
select updated_at::text as latte_upd_before from recipes where id = '33333333-0000-0000-0000-000000000001' \gset
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"option_groups","row":{"id":"b1000000-0000-0000-0000-000000000009","name":"Bad","options":[{"id":"x","label":"A","kind":"SWAP","swap_from_ingredient_id":"22222222-0000-0000-0000-000000000002"}]}}]')$$) like 'BAD_OPTION_GROUP%', 'L: swap without "to" -> BAD_OPTION_GROUP');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"option_groups","row":{"id":"b1000000-0000-0000-0000-000000000009","name":"Bad","options":[{"id":"x","label":"A"},{"id":"y","label":"a"}]}}]')$$) like 'BAD_OPTION_GROUP%', 'L: same label twice -> BAD_OPTION_GROUP');
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','option_groups','row', jsonb_build_object('id','b1000000-0000-0000-0000-000000000001','name','Hot / Iced','required',true,'sort_order',1,
     'applies_to', '{"recipe_types":["DRINKS"],"subcategories":[]}'::jsonb,
     'options', '[{"id":"hot","label":"Hot"},{"id":"iced","label":"Iced","price_delta":10}]'::jsonb)),
  jsonb_build_object('op','upsert','table','option_groups','row', jsonb_build_object('id','b1000000-0000-0000-0000-000000000002','name','Take-away cup','sort_order',2,
     'applies_to', '{"recipe_types":["DRINKS"]}'::jsonb,
     'options', '[{"id":"cup","label":"Iced cup","kind":"EXTRA","extras":[{"ingredient_id":"a1000000-0000-0000-0000-000000000011","quantity":1},{"ingredient_id":"a1000000-0000-0000-0000-000000000012","quantity":1}]}]'::jsonb)),
  jsonb_build_object('op','upsert','table','option_groups','row', jsonb_build_object('id','b1000000-0000-0000-0000-000000000003','name','Milk','sort_order',3,
     'applies_to', '{"recipe_types":[],"subcategories":["iced"]}'::jsonb,
     'options', '[{"id":"oat","label":"Non-dairy milk","kind":"SWAP","price_delta":30,"swap_from_ingredient_id":"22222222-0000-0000-0000-000000000002","swap_to_ingredient_id":"a1000000-0000-0000-0000-000000000013"}]'::jsonb))));
select modifier_groups as lg from recipes where id = '33333333-0000-0000-0000-000000000001' \gset
select test.chk((select array_agg(g->>'name' order by o) from jsonb_array_elements(:'lg'::jsonb) with ordinality x(g, o))::text = '{"Hot / Iced","Take-away cup",Milk,Size,Add-ons}', 'L: library groups first (library order), then the recipe''s own', (select array_agg(g->>'name' order by o) from jsonb_array_elements(:'lg'::jsonb) with ordinality x(g, o))::text);
select test.chk((select g->>'id' from jsonb_array_elements(:'lg'::jsonb) g where g->>'name' = 'Hot / Iced') = 'lib_b1000000-0000-0000-0000-000000000001'
   and (select (g->>'required')::boolean from jsonb_array_elements(:'lg'::jsonb) g where g->>'name' = 'Hot / Iced'), 'L: group id lib:<id>, required kept');
select test.chk((select o from jsonb_array_elements(:'lg'::jsonb) g, jsonb_array_elements(g->'options') o where o->>'id' = 'cup')
   @> '{"kind":"EXTRA","ingredient_id":"a1000000-0000-0000-0000-000000000011","ingredient_qty_delta":1}'::jsonb
   and jsonb_array_length((select o->'extras' from jsonb_array_elements(:'lg'::jsonb) g, jsonb_array_elements(g->'options') o where o->>'id' = 'cup')) = 2,
   'L: cup option: two extras (cup + lid), first copied for old apps');
select test.chk((select o from jsonb_array_elements(:'lg'::jsonb) g, jsonb_array_elements(g->'options') o where o->>'id' = 'oat')
   @> '{"kind":"SWAP","price_delta":30,"ingredient_id":null,"removes":[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":180}],"extras":[{"ingredient_id":"a1000000-0000-0000-0000-000000000013","quantity":0.18}]}'::jsonb,
   'L: swap on Iced Latte = 180 mL milk off, 0.18 L non-dairy on', (select o::text from jsonb_array_elements(:'lg'::jsonb) g, jsonb_array_elements(g->'options') o where o->>'id' = 'oat'));
select test.chk((select o->'removes'->0->>'quantity' from recipes r, jsonb_array_elements(r.modifier_groups) g, jsonb_array_elements(g->'options') o
                 where r.id = 'a2000000-0000-0000-0000-000000000001' and o->>'id' = 'oat') = '180', 'L: swap uses each recipe''s OWN amount (Caramel Latte 180 mL)');
select test.chk(not exists (select 1 from recipes r, jsonb_array_elements(r.modifier_groups) g where r.id = '33333333-0000-0000-0000-000000000002' and g ? 'library_group_id'), 'L: production recipe gets no library groups');
select test.chk((select updated_at::text from recipes where id = '33333333-0000-0000-0000-000000000001') <> :'latte_upd_before', 'L: recipe updated_at moves when its options change (counters refresh)');
-- untick on one item, tick on another
select public.apply_changes('[{"op":"upsert","table":"option_group_recipes","row":{"id":"b2000000-0000-0000-0000-000000000001","group_id":"b1000000-0000-0000-0000-000000000002","recipe_id":"a2000000-0000-0000-0000-000000000001","mode":"EXCLUDE"}},
                              {"op":"upsert","table":"option_group_recipes","row":{"id":"b2000000-0000-0000-0000-000000000002","group_id":"b1000000-0000-0000-0000-000000000001","recipe_id":"33333333-0000-0000-0000-000000000002","mode":"INCLUDE"}}]');
select test.chk(not exists (select 1 from recipes r, jsonb_array_elements(r.modifier_groups) g where r.id = 'a2000000-0000-0000-0000-000000000001' and g->>'name' = 'Take-away cup'), 'L: EXCLUDE unticks the group on that item');
select test.chk(exists (select 1 from recipes r, jsonb_array_elements(r.modifier_groups) g where r.id = '33333333-0000-0000-0000-000000000002' and g->>'name' = 'Hot / Iced'), 'L: INCLUDE ticks it on for another item');
select public.apply_changes('[{"op":"delete","table":"option_group_recipes","id":"b2000000-0000-0000-0000-000000000002"}]');
select test.chk(not exists (select 1 from recipes r, jsonb_array_elements(r.modifier_groups) g where r.id = '33333333-0000-0000-0000-000000000002' and g ? 'library_group_id'), 'L: removing the tick takes it off again');
-- editing the library updates every item
select public.apply_changes('[{"op":"update","table":"option_groups","row":{"id":"b1000000-0000-0000-0000-000000000003","options":[{"id":"oat","label":"Non-dairy milk","kind":"SWAP","price_delta":35,"swap_from_ingredient_id":"22222222-0000-0000-0000-000000000002","swap_to_ingredient_id":"a1000000-0000-0000-0000-000000000013"}]}}]');
select test.chk((select count(*) from recipes r, jsonb_array_elements(r.modifier_groups) g, jsonb_array_elements(g->'options') o
                 where r.business_id = :'biz' and o->>'id' = 'oat' and (o->>'price_delta')::numeric = 35) = 2, 'L: new swap price on every item using it');
-- an old Back Office saving the recipe with an edited copy of a library group: the library wins, own groups kept
select public.apply_changes(jsonb_build_array(jsonb_build_object('op','update','table','recipes','row', jsonb_build_object('id','33333333-0000-0000-0000-000000000001',
  'modifier_groups', (select jsonb_agg(case when g->>'name' = 'Hot / Iced' then jsonb_set(g - 'library_group_id', '{options,1,price_delta}', '0') else g end)
                      from recipes r, jsonb_array_elements(r.modifier_groups) g where r.id = '33333333-0000-0000-0000-000000000001')))));
select modifier_groups as lg2 from recipes where id = '33333333-0000-0000-0000-000000000001' \gset
select test.chk(jsonb_array_length(:'lg2'::jsonb) = 5 and (select o->>'price_delta' from jsonb_array_elements(:'lg2'::jsonb) g, jsonb_array_elements(g->'options') o where o->>'id' = 'iced') = '10',
   'L: old app re-saving a library group: no duplicate, library price kept');
-- recipe line change -> swap amount follows
select public.apply_changes('[{"op":"update","table":"recipe_ingredients","row":{"id":"44444444-0000-0000-0000-000000000002","quantity":200}}]');
select test.chk((select o->'removes'->0->>'quantity' from recipes r, jsonb_array_elements(r.modifier_groups) g, jsonb_array_elements(g->'options') o
                 where r.id = '33333333-0000-0000-0000-000000000001' and o->>'id' = 'oat') = '200', 'L: recipe now uses 200 mL -> swap removes 200');
select public.apply_changes('[{"op":"update","table":"recipe_ingredients","row":{"id":"44444444-0000-0000-0000-000000000002","quantity":180}}]');
reset role;
-- server stock lines (used by waste) for Iced + cup + oat swap, 2 items
select test.chk(public._recipe_stock_lines(:'biz', '33333333-0000-0000-0000-000000000001', 2,
     '[{"group_id":"lib_b1000000-0000-0000-0000-000000000002","option_id":"cup"},{"group":"Milk","label":"Non-dairy milk"}]'::jsonb)
   = '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":36},{"ingredient_id":"a1000000-0000-0000-0000-000000000011","quantity":2},{"ingredient_id":"a1000000-0000-0000-0000-000000000012","quantity":2},{"ingredient_id":"a1000000-0000-0000-0000-000000000013","quantity":0.36}]'::jsonb,
   'L: stock lines: beans x2, cup + lid x2, non-dairy 0.36 L, NO dairy milk',
   public._recipe_stock_lines(:'biz', '33333333-0000-0000-0000-000000000001', 2, '[{"group_id":"lib_b1000000-0000-0000-0000-000000000002","option_id":"cup"},{"group":"Milk","label":"Non-dairy milk"}]'::jsonb)::text);
-- QR page
select test.login(null); set role anon;
select public.get_qr_menu(:'tok') as qm \gset
reset role;
select test.chk((select o->>'kind' from jsonb_array_elements(:'qm'::jsonb->'items') i, jsonb_array_elements(i->'modifier_groups') g, jsonb_array_elements(g->'options') o
                 where i->>'id' = '33333333-0000-0000-0000-000000000001' and o->>'id' = 'oat') = 'SWAP'
   and not exists (select 1 from jsonb_array_elements(:'qm'::jsonb->'items') i, jsonb_array_elements(i->'modifier_groups') g, jsonb_array_elements(g->'options') o
                   where o ? 'extras' or o ? 'removes' or o ? 'ingredient_id'), 'L: QR menu shows the swap kind, never stock amounts');
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]') as q1 \gset
select public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"},{"group_id":"lib_b1000000-0000-0000-0000-000000000001","option_id":"iced"},{"group_id":"lib_b1000000-0000-0000-0000-000000000003","option_id":"oat"}]}]') as q2 \gset
reset role;
select test.chk(:'q1'::jsonb->>'error' = 'OPTION_REQUIRED' and :'q1'::jsonb->>'group' = 'Hot / Iced', 'L: required library group enforced on QR orders', :'q1');
select test.chk((:'q2'::jsonb->'order'->'items'->0->>'unit_price')::numeric = (select selling_price from recipes where id = '33333333-0000-0000-0000-000000000001') + 10 + 35
   and (select items->0->'modifiers'->2 from qr_orders where id = (:'q2'::jsonb->'order'->>'id')::uuid) @> '{"kind":"SWAP","removes":[{"quantity":180}]}'::jsonb,
   'L: QR price = menu + Iced 10 + swap 35 (database price); the swap''s stock is stored with the order', :'q2');
select id as q2id from qr_orders where id = (:'q2'::jsonb->'order'->>'id')::uuid \gset
-- counter sale with library options at the menu price is NOT flagged; below it is
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select selling_price + 45 as lp from recipes where id = '33333333-0000-0000-0000-000000000001' \gset
select test.op('sale', jsonb_build_object('sale', jsonb_build_object('id','c1000000-0000-0000-0000-000000000001','transaction_number','POS-L-1','transaction_date', now(),'status','COMPLETED',
     'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy','subtotal', :'lp','discount_amount',0,'tax_amount',0,'service_charge_amount', :'lp'::numeric * 0.1,'grand_total', :'lp'::numeric * 1.1),
  'items', jsonb_build_array(jsonb_build_object('id','c1000000-0000-0000-0000-0000000000a1','recipe_id','33333333-0000-0000-0000-000000000001','name','Iced Latte','quantity',1,'unit_price', :'lp','line_total', :'lp',
     'modifiers','[{"group":"Hot / Iced","label":"Iced","price_delta":10},{"group":"Milk","label":"Non-dairy milk","price_delta":35}]'::jsonb)),
  'payment', jsonb_build_object('id','c1000000-0000-0000-0000-0000000000b1','method','CASH','amount', :'lp'::numeric * 1.1),
  'inventory', '[{"id":"c1000000-0000-0000-0000-0000000000c1","ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":18,"transaction_date":"2026-11-03"},{"id":"c1000000-0000-0000-0000-0000000000c2","ingredient_id":"a1000000-0000-0000-0000-000000000013","quantity":0.18,"transaction_date":"2026-11-03"}]'::jsonb)) as s1 \gset
select test.op('sale', jsonb_build_object('sale', jsonb_build_object('id','c1000000-0000-0000-0000-000000000002','transaction_number','POS-L-2','transaction_date', now(),'status','COMPLETED',
     'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy','subtotal', :'lp'::numeric - 35,'discount_amount',0,'tax_amount',0,'service_charge_amount', (:'lp'::numeric - 35) * 0.1,'grand_total', (:'lp'::numeric - 35) * 1.1),
  'items', jsonb_build_array(jsonb_build_object('id','c1000000-0000-0000-0000-0000000000a2','recipe_id','33333333-0000-0000-0000-000000000001','name','Iced Latte','quantity',1,'unit_price', :'lp'::numeric - 35,'line_total', :'lp'::numeric - 35,
     'modifiers','[{"group":"Hot / Iced","label":"Iced","price_delta":10},{"group":"Milk","label":"Non-dairy milk","price_delta":0}]'::jsonb)),
  'payment', jsonb_build_object('id','c1000000-0000-0000-0000-0000000000b2','method','CASH','amount', (:'lp'::numeric - 35) * 1.1), 'inventory', '[]'::jsonb)) as s2 \gset
reset role;
select test.chk(:'s1'::jsonb->>'status' = 'ok' and coalesce((select review_reason from sales where id = 'c1000000-0000-0000-0000-000000000001'), '') not like '%PRICE_BELOW_MENU%', 'L: counter sale at library price: ok, not below menu', :'s1' || ' ' || coalesce((select review_reason from sales where id = 'c1000000-0000-0000-0000-000000000001'), ''));
select test.chk((select review_reason from sales where id = 'c1000000-0000-0000-0000-000000000002') like '%PRICE_BELOW_MENU%', 'L: swap sold without its price -> PRICE_BELOW_MENU');

-- ============================ WA. counter waste log (A15) ============================
select test.stock('22222222-0000-0000-0000-000000000001') as beans0 \gset
select test.stock('a1000000-0000-0000-0000-000000000011') as cups0 \gset
select test.stock('22222222-0000-0000-0000-000000000002') as milk0 \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000001','reason','CALIBRATION','staff_id','66666666-0000-0000-0000-000000000001','shift_id', :'shift_id','logged_at', now(),
   'items', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":2,"modifiers":[{"group":"Take-away cup","label":"Iced cup"},{"group":"Size","label":"12oz"},{"group":"Hot / Iced","label":"Hot"}]},{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":0.5,"unit":"L"}]'::jsonb),
   'e1000000-0000-0000-0000-000000000001') as w1 \gset
reset role;
select test.chk(:'w1'::jsonb->>'status' = 'ok', 'WA: calibration waste uploaded', :'w1');
select test.chk(test.stock('22222222-0000-0000-0000-000000000001') = :'beans0'::numeric - 36 and test.stock('a1000000-0000-0000-0000-000000000011') = :'cups0'::numeric - 2
   and test.stock('22222222-0000-0000-0000-000000000002') = :'milk0'::numeric - 360 - 500, 'WA: stock taken off like a sale (2 lattes + cups) + 0.5 L milk as 500 mL',
   (test.stock('22222222-0000-0000-0000-000000000002') - :'milk0'::numeric)::text);
select test.chk((select count(*) from inventory_transactions where reference_id = 'd1000000-0000-0000-0000-000000000001' and transaction_type = 'WASTE') = 5
   and (select count(*) from waste_log_items where waste_log_id = 'd1000000-0000-0000-0000-000000000001') = 2, 'WA: 5 WASTE stock lines (beans, milk, cup, lid + milk), 2 items');
select test.chk((select approved_by from waste_logs where id = 'd1000000-0000-0000-0000-000000000001') is null
   and (select staff_name from waste_logs where id = 'd1000000-0000-0000-0000-000000000001') = 'Cathy Cashier', 'WA: no approval needed for calibration; staff name from the server');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('waste', '{}'::jsonb, 'e1000000-0000-0000-0000-000000000001')->>'status' = 'duplicate', 'WA: same op_id again -> duplicate');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000001','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001','items','[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":1}]'::jsonb))->>'status' = 'skipped', 'WA: same waste id with a new op_id -> skipped (no double stock)');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000002','reason','OTHER','staff_id','66666666-0000-0000-0000-000000000001','items','[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":1}]'::jsonb))->>'message' = 'NOTE_REQUIRED', 'WA: OTHER needs a note');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000002','reason','STAMP','staff_id','66666666-0000-0000-0000-000000000001','items','[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":1}]'::jsonb))->>'message' = 'BAD_WASTE_REASON', 'WA: unknown reason');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000002','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001','items','[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":5,"unit":"g"}]'::jsonb))->>'message' = 'BAD_UNIT', 'WA: grams of milk -> BAD_UNIT');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000002','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001','items','[{"ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":-5}]'::jsonb))->>'message' = 'BAD_QUANTITY', 'WA: negative quantity');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000002','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001','items','[]'::jsonb))->>'message' = 'BAD_WASTE', 'WA: no items');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000002','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001','items','[{"recipe_id":"00000000-0000-0000-0000-00000000ffff","quantity":1}]'::jsonb))->>'message' = 'UNKNOWN_RECIPE', 'WA: unknown recipe');
-- complimentary: needs a manager's approval
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000003','reason','COMPLIMENTARY','staff_id','66666666-0000-0000-0000-000000000001','items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"},{"group":"Hot / Iced","label":"Hot"}]}]'::jsonb))->>'message' = 'APPROVAL_REQUIRED', 'WA: complimentary without approval -> APPROVAL_REQUIRED');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000003','reason','COMPLIMENTARY','staff_id','66666666-0000-0000-0000-000000000001','approved_by','66666666-0000-0000-0000-000000000001','approval_token', :'cashier_token','items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"},{"group":"Hot / Iced","label":"Hot"}]}]'::jsonb))->>'message' = 'ROLE_TOO_LOW', 'WA: a cashier can''t approve (own sign-in token)');
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ovr \gset
select test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000003','reason','COMPLIMENTARY','note','Regular''s birthday','staff_id','66666666-0000-0000-0000-000000000001','approved_by','66666666-0000-0000-0000-000000000002','approval_token', :'ovr','items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"},{"group":"Hot / Iced","label":"Hot"}]}]'::jsonb)) as w3 \gset
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000004','reason','COMPLIMENTARY','staff_id','66666666-0000-0000-0000-000000000001','approved_by','66666666-0000-0000-0000-000000000002','approval_token', :'ovr','items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"},{"group":"Hot / Iced","label":"Hot"}]}]'::jsonb))->>'message' = 'APPROVAL_INVALID', 'WA: a used approval can''t approve a second one');
-- the manager signed in on the counter approves their OWN complimentary (offline rule)
select (public.staff_pin_login('222222'))->>'token' as mgr_login \gset
select test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000005','reason','COMPLIMENTARY','staff_id','66666666-0000-0000-0000-000000000002','approved_by','66666666-0000-0000-0000-000000000002','approval_token', :'mgr_login','items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"},{"group":"Hot / Iced","label":"Hot"}]}]'::jsonb)) as w5 \gset
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-000000000006','reason','COMPLIMENTARY','staff_id','66666666-0000-0000-0000-000000000001','approved_by','66666666-0000-0000-0000-000000000002','approval_token', :'mgr_login','items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"},{"group":"Hot / Iced","label":"Hot"}]}]'::jsonb))->>'message' = 'APPROVAL_INVALID', 'WA: manager''s sign-in token can''t approve the cashier''s entry');
reset role;
select test.chk(:'w3'::jsonb->>'status' = 'ok' and (select approved_by_name from waste_logs where id = 'd1000000-0000-0000-0000-000000000003') = 'Manny Manager'
   and (select used_for from staff_sessions where used_for = 'waste:d1000000-0000-0000-0000-000000000003') is not null, 'WA: complimentary with a manager OVERRIDE: ok, token used', :'w3');
select test.chk(:'w5'::jsonb->>'status' = 'ok', 'WA: manager''s own complimentary with own sign-in token', :'w5');
select test.chk((select total_cost from waste_logs where id = 'd1000000-0000-0000-0000-000000000001') >= 0
   and (select cost from waste_log_items where waste_log_id = 'd1000000-0000-0000-0000-000000000001' and ingredient_id is not null)
       = round(500 * public._ingredient_unit_cost(:'biz', '22222222-0000-0000-0000-000000000002', current_date), 4), 'WA: cost recorded per item');
-- reports
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.waste_report(current_date - 1, current_date + 1) as wr \gset
reset role;
select test.chk(exists (select 1 from jsonb_array_elements(:'wr'::jsonb->'by_reason') r where r->>'reason' = 'COMPLIMENTARY' and (r->>'entries')::int = 2)
   and jsonb_array_length(:'wr'::jsonb->'entries') >= 3, 'WA: waste_report by reason', left(:'wr', 300));
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.waste_report(current_date, current_date)$$) like 'NOT_ALLOWED%', 'WA: a counter can''t read the waste report');
select test.chk((select count(*) from waste_logs) = 0, 'WA: a counter reads no waste logs directly');
reset role;

-- ============================ S. supplied items (A8) ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.save_supplied_item('{"name":"Ensaymada","recipe_type":"PASTRY","subcategory":"Pastries","cost_per_piece":35,"selling_price":65,"restock":{"quantity":12,"cost_per_piece":36}}') as sp \gset
select (:'sp'::jsonb->>'recipe_id') as sp_r, (:'sp'::jsonb->>'ingredient_id') as sp_i \gset
select test.chk((select base_unit from ingredients where id = :'sp_i') = 'pcs' and (select supplied_ingredient_id::text from recipes where id = :'sp_r') = :'sp_i'
   and (select count(*) from recipe_ingredients where recipe_id = :'sp_r' and quantity = 1) = 1, 'S: menu item + stock item in pcs + one line of 1 pc');
select test.chk(test.stock(:'sp_i') = 12 and (:'sp'::jsonb->>'cost_per_piece')::numeric = 36 and (:'sp'::jsonb->>'margin')::numeric = 29, 'S: restock 12 pcs, margin = 65 - 36', :'sp');
select test.chk(test.err(format($$select public.save_supplied_item('{"recipe_id":"%s","ingredient_id":"22222222-0000-0000-0000-000000000001","name":"X","selling_price":1}')$$, :'sp_r')) like 'NOT_A_SUPPLIED_ITEM%', 'S: ids that don''t belong together are refused');
select public.save_supplied_item(jsonb_build_object('recipe_id', :'sp_r', 'ingredient_id', :'sp_i', 'name', 'Ensaymada (special)', 'selling_price', 70, 'qr_visible', false)) as sp2 \gset
select test.chk((select name || '/' || selling_price || '/' || qr_visible from recipes where id = :'sp_r') = 'Ensaymada (special)/70/false' and (select name from ingredients where id = :'sp_i') = 'Ensaymada (special)', 'S: edit keeps both in step');
select test.chk(test.err(format($$select public.apply_changes('[{"op":"update","table":"ingredients","row":{"id":"%s","base_unit":"g"}}]')$$, :'sp_i')) like 'SUPPLIED_NEEDS_PCS%', 'S: stock item must stay in pcs');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.save_supplied_item('{"name":"Hack","selling_price":1}')$$) like 'NOT_ALLOWED%', 'S: a counter can''t save supplied items');
reset role;

-- ============================ E. operating supplies + expenses (A11) ============================
select id as opsup from categories where business_id = :'biz' and kind = 'EXPENSE' limit 1 \gset
select test.chk(:'opsup' is not null and (select name from categories where id = :'opsup') = 'Operating supplies', 'E: "Operating supplies" category made (EXPENSE)');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','a1000000-0000-0000-0000-000000000021','name','Dishwashing liquid','base_unit','ml','category_id', :'opsup'))));
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"purchases","row":{"id":"a5000000-0000-0000-0000-000000000021","ingredient_id":"a1000000-0000-0000-0000-000000000021","purchase_date":"2026-11-02","quantity":1,"base_quantity":1000,"total_price":120,"price_per_base_unit":0.12}}]')$$) like 'EXPENSE_ITEM_NOT_STOCK%', 'E: buying an operating supply as stock is refused');
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','expenses','row', jsonb_build_object('id','a6000000-0000-0000-0000-000000000001','expense_date', current_date,'category','SUPPLIES','amount',120,'ingredient_id','a1000000-0000-0000-0000-000000000021','quantity',1,'unit','L','note','Joy 1L')),
  jsonb_build_object('op','upsert','table','expenses','row', jsonb_build_object('id','a6000000-0000-0000-0000-000000000002','expense_date', current_date,'category','RENT','amount',15000))));
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"expenses","row":{"id":"a6000000-0000-0000-0000-000000000009","expense_date":"2026-11-02","category":"FOOD","amount":1}}]')$$) like '%expenses_category_check%', 'E: unknown expense category refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"expenses","row":{"id":"a6000000-0000-0000-0000-000000000009","expense_date":"2026-11-02","category":"OTHER","amount":0}}]')$$) like '%expenses_amount_check%', 'E: amount must be above 0');
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','purchases','row', jsonb_build_object('id','a5000000-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','purchase_date', current_date - 1,'quantity',1,'purchase_unit','kg','base_quantity',1000,'total_price',1000,'price_per_base_unit',1)),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','a4000000-0000-0000-0000-000000000001','ingredient_id','22222222-0000-0000-0000-000000000001','transaction_type','PURCHASE','quantity',1000,'reference_id','a5000000-0000-0000-0000-000000000001','transaction_date', current_date - 1))));
select public.net_income_report(current_date) as ni \gset
reset role;
select test.chk((:'ni'::jsonb->'expenses'->>'total')::numeric = 15120 and (:'ni'::jsonb->'expenses'->'by_category'->>'RENT')::numeric = 15000
   and (:'ni'::jsonb->>'net_income')::numeric = (:'ni'::jsonb->'sales'->>'net')::numeric - (:'ni'::jsonb->'ingredients'->>'used')::numeric - 15120
   and (:'ni'::jsonb->'sales'->>'net')::numeric = (:'ni'::jsonb->'sales'->>'gross')::numeric - (:'ni'::jsonb->'sales'->>'refunds')::numeric - (:'ni'::jsonb->'sales'->>'tax')::numeric
   and (:'ni'::jsonb->'ingredients'->>'wasted')::numeric > 0, 'E: net income = net sales - ingredients used - expenses', :'ni');
-- a counter sale line for an operating supply is left out (not stock)
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('sale', jsonb_build_object('sale', jsonb_build_object('id','c1000000-0000-0000-0000-000000000003','transaction_number','POS-L-3','transaction_date', now(),'status','COMPLETED',
     'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy','subtotal', 150,'discount_amount',0,'tax_amount',0,'service_charge_amount', 15,'grand_total', 165),
  'items', jsonb_build_array(jsonb_build_object('id','c1000000-0000-0000-0000-0000000000a3','recipe_id','33333333-0000-0000-0000-000000000001','name','Iced Latte','quantity',1,'unit_price',150,'line_total',150)),
  'payment', jsonb_build_object('id','c1000000-0000-0000-0000-0000000000b3','method','CASH','amount',165),
  'inventory', '[{"id":"c1000000-0000-0000-0000-0000000000c3","ingredient_id":"a1000000-0000-0000-0000-000000000021","quantity":5,"transaction_date":"2026-11-03"}]'::jsonb))->>'status' = 'ok'
  and not exists (select 1 from inventory_transactions where id = 'c1000000-0000-0000-0000-0000000000c3'), 'E: sale line of an operating supply left out, sale saved');
select test.chk((select count(*) from expenses) = 0, 'E: a counter reads no expenses');
select test.chk(test.err($$select public.net_income_report(current_date)$$) like 'NOT_ALLOWED%', 'E: a counter can''t run the net income report');
reset role;
select test.login(null); set role anon;
select test.chk(test.err($$select public.net_income_report(current_date)$$) like '%permission denied%', 'E: anon can''t call owner reports');
select test.chk(test.err($$select count(*) from public.expenses$$) like '%permission denied%', 'E: anon can''t read expenses');
reset role;

-- ============================ M. merge ingredients (A12) ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
-- Arla (L, with a purchase), Laciate (mL, with a brand + starting stock), both in recipes / options
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','a1000000-0000-0000-0000-000000000031','name','Arla Full Cream','base_unit','L','reorder_level',2)),
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','a1000000-0000-0000-0000-000000000032','name','Laciate Full Cream','base_unit','ml','reorder_level',1000)),
  jsonb_build_object('op','upsert','table','ingredient_brands','row', jsonb_build_object('id','a7000000-0000-0000-0000-000000000032','ingredient_id','a1000000-0000-0000-0000-000000000032','name','Laciate 3.2%')),
  jsonb_build_object('op','upsert','table','purchases','row', jsonb_build_object('id','a5000000-0000-0000-0000-000000000031','ingredient_id','a1000000-0000-0000-0000-000000000031','purchase_date','2026-11-01','quantity',10,'purchase_unit','L','base_quantity',10,'total_price',1000,'price_per_base_unit',100)),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','a4000000-0000-0000-0000-000000000031','ingredient_id','a1000000-0000-0000-0000-000000000031','transaction_type','PURCHASE','quantity',10,'reference_id','a5000000-0000-0000-0000-000000000031','transaction_date','2026-11-01')),
  jsonb_build_object('op','upsert','table','inventory_transactions','row', jsonb_build_object('id','a4000000-0000-0000-0000-000000000032','ingredient_id','a1000000-0000-0000-0000-000000000032','transaction_type','INITIAL_STOCK','quantity',3000,'brand_id','a7000000-0000-0000-0000-000000000032','transaction_date','2026-10-30')),
  jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object('id','a2000000-0000-0000-0000-000000000031','name','Flat white','recipe_type','DRINKS','category','Hot','selling_price',140,
     'modifier_groups','[{"id":"g-x","name":"Extra milk","options":[{"id":"o-x","label":"Extra milk","price_delta":15,"ingredient_id":"a1000000-0000-0000-0000-000000000031","ingredient_qty_delta":0.05}]}]'::jsonb)),
  jsonb_build_object('op','upsert','table','recipe_ingredients','row', jsonb_build_object('id','a3000000-0000-0000-0000-000000000031','recipe_id','a2000000-0000-0000-0000-000000000031','ingredient_id','a1000000-0000-0000-0000-000000000031','quantity',0.1,'unit','L')),
  jsonb_build_object('op','upsert','table','recipe_ingredients','row', jsonb_build_object('id','a3000000-0000-0000-0000-000000000032','recipe_id','a2000000-0000-0000-0000-000000000031','ingredient_id','a1000000-0000-0000-0000-000000000032','quantity',50,'unit','ml'))));
reset role;
-- a counter sale of the old Arla (0.1 L) before the merge, to refund afterwards
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('sale', jsonb_build_object('sale', jsonb_build_object('id','c1000000-0000-0000-0000-000000000031','transaction_number','POS-M-1','transaction_date', now(),'status','COMPLETED',
     'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy','subtotal',140,'discount_amount',0,'tax_amount',0,'service_charge_amount',14,'grand_total',154),
  'items', jsonb_build_array(jsonb_build_object('id','c1000000-0000-0000-0000-0000000000a4','recipe_id','a2000000-0000-0000-0000-000000000031','name','Flat white','quantity',1,'unit_price',140,'line_total',140)),
  'payment', jsonb_build_object('id','c1000000-0000-0000-0000-0000000000b4','method','CASH','amount',154),
  'inventory', '[{"id":"c1000000-0000-0000-0000-0000000000c4","ingredient_id":"a1000000-0000-0000-0000-000000000031","quantity":0.1,"transaction_date":"2026-11-03"}]'::jsonb))->>'status' as m0 \gset
select test.chk(test.err($$select public.merge_ingredients_preview(array['a1000000-0000-0000-0000-000000000031','a1000000-0000-0000-0000-000000000032']::uuid[], 'Full Cream Milk')$$) like 'NOT_ALLOWED%', 'M: a counter can''t merge');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.merge_ingredients_preview(array['a1000000-0000-0000-0000-000000000031']::uuid[], 'X')$$) like 'MERGE_TOO_FEW%', 'M: one ingredient -> MERGE_TOO_FEW');
select test.chk(test.err($$select public.merge_ingredients_preview(array['a1000000-0000-0000-0000-000000000031','22222222-0000-0000-0000-000000000001']::uuid[], 'X')$$) like 'MERGE_UNIT_MISMATCH%', 'M: L with g -> MERGE_UNIT_MISMATCH');
select test.chk(test.err($$select public.merge_ingredients_preview(array['a1000000-0000-0000-0000-000000000031','a1000000-0000-0000-0000-000000000001']::uuid[], 'X')$$) like 'MERGE_PRODUCED_NOT_ALLOWED%', 'M: house-made item -> refused');
select test.chk(test.err($$select public.merge_ingredients_preview(array['a1000000-0000-0000-0000-000000000031','a1000000-0000-0000-0000-000000000032']::uuid[], 'Milk')$$) like 'NAME_TAKEN%', 'M: name of another ingredient -> NAME_TAKEN');
select test.stock('a1000000-0000-0000-0000-000000000031') as arla0 \gset
select test.stock('a1000000-0000-0000-0000-000000000032') as lac0 \gset
select public.merge_ingredients_preview(array['a1000000-0000-0000-0000-000000000031','a1000000-0000-0000-0000-000000000032']::uuid[], 'Full Cream Milk', null, 'ml',
                                        '{"a1000000-0000-0000-0000-000000000031":"Arla"}') as mp \gset
select test.chk((:'mp'::jsonb->'general'->>'stock_after')::numeric = :'arla0'::numeric * 1000 + :'lac0'::numeric
   and (select x->>'becomes_brand' from jsonb_array_elements(:'mp'::jsonb->'sources') x where x->>'id' = 'a1000000-0000-0000-0000-000000000031') = 'Arla'
   and (select x->>'becomes_brand' from jsonb_array_elements(:'mp'::jsonb->'sources') x where x->>'id' = 'a1000000-0000-0000-0000-000000000032') is null
   and (select (x->>'factor')::numeric from jsonb_array_elements(:'mp'::jsonb->'sources') x where x->>'id' = 'a1000000-0000-0000-0000-000000000031') = 1000
   and (:'mp'::jsonb->'recipes'->0->>'lines_combined')::int = 1, 'M: preview: stock in mL, brand names, factor 1000, a recipe line combined', :'mp');
select test.chk(not exists (select 1 from ingredients where name = 'Full Cream Milk'), 'M: preview changes nothing');
select public.merge_ingredients(array['a1000000-0000-0000-0000-000000000031','a1000000-0000-0000-0000-000000000032']::uuid[], 'Full Cream Milk', null, 'ml',
                                '{"a1000000-0000-0000-0000-000000000031":"Arla"}') as mg \gset
select (:'mg'::jsonb->>'ingredient_id') as fcm \gset
reset role;
select test.chk(test.stock(:'fcm') = :'arla0'::numeric * 1000 + :'lac0'::numeric and test.stock('a1000000-0000-0000-0000-000000000031') = 0, 'M: all stock now on the general ingredient (mL)', test.stock(:'fcm')::text);
select test.chk((select string_agg(name, ',' order by name) from ingredient_brands where ingredient_id = :'fcm') = 'Arla,Laciate 3.2%', 'M: brands = Arla (was an ingredient) + Laciate 3.2% (moved)');
select test.chk((select base_quantity = 10000 and price_per_base_unit = 0.1 from purchases where id = 'a5000000-0000-0000-0000-000000000031')
   and (select brand_id from purchases where id = 'a5000000-0000-0000-0000-000000000031') = (select id from ingredient_brands where ingredient_id = :'fcm' and name = 'Arla'), 'M: purchase converted to mL and branded Arla');
select test.chk((select count(*) from recipe_ingredients where recipe_id = 'a2000000-0000-0000-0000-000000000031') = 1
   and (select quantity from recipe_ingredients where recipe_id = 'a2000000-0000-0000-0000-000000000031') = 150, 'M: 0.1 L + 50 mL -> one line of 150 mL');
select test.chk((select o->>'ingredient_id' = :'fcm' and (o->>'ingredient_qty_delta')::numeric = 50 from recipes r, jsonb_array_elements(r.modifier_groups) g, jsonb_array_elements(g->'options') o
                 where r.id = 'a2000000-0000-0000-0000-000000000031' and o->>'id' = 'o-x'), 'M: option extra repointed and converted (0.05 L -> 50 mL)');
select test.chk((select merged_into::text || '/' || active from ingredients where id = 'a1000000-0000-0000-0000-000000000031') = :'fcm' || '/false', 'M: old ingredient switched off, points at the general one');
select test.chk(exists (select 1 from audit_log where action = 'Merge ingredients' and reference_id = :'fcm'), 'M: audit row');
-- an OLD offline counter uploads a sale naming Arla (L): its 0.2 L go to the general ingredient as 200 mL
select test.stock(:'fcm') as fcm0 \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('sale', jsonb_build_object('sale', jsonb_build_object('id','c1000000-0000-0000-0000-000000000032','transaction_number','POS-M-2','transaction_date', now(),'status','COMPLETED',
     'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy','subtotal',140,'discount_amount',0,'tax_amount',0,'service_charge_amount',14,'grand_total',154),
  'items', jsonb_build_array(jsonb_build_object('id','c1000000-0000-0000-0000-0000000000a5','recipe_id','a2000000-0000-0000-0000-000000000031','name','Flat white','quantity',1,'unit_price',140,'line_total',140)),
  'payment', jsonb_build_object('id','c1000000-0000-0000-0000-0000000000b5','method','CASH','amount',154),
  'inventory', '[{"id":"c1000000-0000-0000-0000-0000000000c5","ingredient_id":"a1000000-0000-0000-0000-000000000031","quantity":0.2,"transaction_date":"2026-11-03"}]'::jsonb))->>'status' as m2 \gset
-- refund of the pre-merge sale, old counter still naming Arla 0.1 L
select (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token' as ovr2 \gset
select test.op('refund', jsonb_build_object('refund', jsonb_build_object('id','c2000000-0000-0000-0000-000000000031','sale_id','c1000000-0000-0000-0000-000000000031','type','VOID','amount',154,
     'approved_by','66666666-0000-0000-0000-000000000002','performed_by','66666666-0000-0000-0000-000000000002','date', now()),
  'approval_token', :'ovr2',
  'inventory', '[{"id":"c2000000-0000-0000-0000-0000000000c1","ingredient_id":"a1000000-0000-0000-0000-000000000031","quantity":0.1,"transaction_date":"2026-11-03"}]'::jsonb)) as m3 \gset
reset role;
select test.chk(:'m2' = 'ok' and test.stock(:'fcm') = :'fcm0'::numeric - 200 + 100, 'M: old counter''s lines go to the general ingredient (-200 mL sale, +100 mL void)', :'m2' || ' ' || :'m3' || ' ' || test.stock(:'fcm')::text);
select test.chk(:'m3'::jsonb->>'status' = 'ok', 'M: void of a pre-merge sale passes the stock cap', :'m3');
-- merge INTO an existing ingredient
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes('[{"op":"upsert","table":"ingredients","row":{"id":"a1000000-0000-0000-0000-000000000033","name":"Magnolia full cream","base_unit":"L"}}]');
select public.merge_ingredients(array['a1000000-0000-0000-0000-000000000033']::uuid[], '', :'fcm') as mg2 \gset
reset role;
select test.chk((select merged_into::text from ingredients where id = 'a1000000-0000-0000-0000-000000000033') = :'fcm'
   and (select name from ingredients where id = :'fcm') = 'Full Cream Milk'
   and exists (select 1 from ingredient_brands where ingredient_id = :'fcm' and name = 'Magnolia full cream'), 'M: merge into an existing general ingredient (name kept, new brand)');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err(format($$select public.merge_ingredients(array['a1000000-0000-0000-0000-000000000033']::uuid[], '', '%s')$$, :'fcm')) like 'MERGE_ALREADY_MERGED%', 'M: an ingredient merges only once');
select test.chk(jsonb_array_length((select x->'brands' from jsonb_array_elements(public.ingredient_brand_stock(:'fcm')) x)) >= 2, 'M: FIFO brand stock lists the brands');
reset role;

-- ============================ T. net income excludes tax ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.net_income_report(current_date) as t0 \gset
reset role;
-- a sale of 112 incl. 12 tax, refunded 56 (half): tax counted = 12 - 6 = 6
insert into sales(id, business_id, transaction_date, status, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total)
  values ('c1000000-0000-0000-0000-0000000000f1', :'biz', now(), 'COMPLETED', 100, 0, 12, 0, 112);
insert into refunds(id, business_id, sale_id, type, amount, date) values ('c2000000-0000-0000-0000-0000000000f1', :'biz', 'c1000000-0000-0000-0000-0000000000f1', 'PARTIAL_REFUND', 56, now());
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.net_income_report(current_date) as t1 \gset
reset role;
select test.chk((:'t1'::jsonb->'sales'->>'tax')::numeric - (:'t0'::jsonb->'sales'->>'tax')::numeric = 6
   and (:'t1'::jsonb->'sales'->>'net')::numeric - (:'t0'::jsonb->'sales'->>'net')::numeric = 50
   and (:'t1'::jsonb->>'net_income')::numeric - (:'t0'::jsonb->>'net_income')::numeric = 50, 'T: tax (net of the refund''s share) is taken out of net sales', :'t1');

-- ============================ R. security review fixes ============================
-- L1 / L3: waste options checked against the menu, only resolved ones kept
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-0000000000a1','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"}]}]'::jsonb))->>'message' = 'BAD_WASTE', 'R L1: required group missing -> BAD_WASTE');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-0000000000a1','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"},{"group":"Size","label":"16oz"},{"group":"Hot / Iced","label":"Hot"}]}]'::jsonb))->>'message' = 'BAD_WASTE', 'R L1: two in a pick-one group -> BAD_WASTE');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-0000000000a1','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"},{"group":"Hot / Iced","label":"Hot"},{"group":"Add-ons","label":"Extra shot"},{"group":"Add-ons","label":"Extra shot"}]}]'::jsonb))->>'message' = 'BAD_WASTE', 'R L1: same option twice -> BAD_WASTE');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-0000000000a1','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz"},{"group":"Hot / Iced","label":"Hot"},{"group":"Fake","label":"Free gold","ingredient_id":"x","removes":[1]}]}]'::jsonb))->>'message' = 'BAD_WASTE', 'R L1: unknown option -> BAD_WASTE');
select test.chk(test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-0000000000a2','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001','logged_at', now() + interval '3 hours',
   'items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"12oz","junk":"x"},{"group":"Hot / Iced","label":"Hot"}]}]'::jsonb))->>'status' = 'ok', 'R L2: future-dated waste saved');
reset role;
select test.chk((select review_reason from waste_logs where id = 'd1000000-0000-0000-0000-0000000000a2') like '%FUTURE_DATE%', 'R L2: ... flagged FUTURE_DATE');
select test.chk((select modifiers from waste_log_items where waste_log_id = 'd1000000-0000-0000-0000-0000000000a2')
   = '[{"group":"Size","label":"12oz","group_id":"g-size","option_id":"o-12"},{"group":"Hot / Iced","label":"Hot","group_id":"lib_b1000000-0000-0000-0000-000000000001","option_id":"hot"}]'::jsonb, 'R L3: only resolved options stored');
-- M1: customer replies carry only group / label / price_delta / kind
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select public.qr_my_orders(:'tok') as mo \gset
reset role;
select test.chk(not exists (select 1 from jsonb_array_elements(:'mo'::jsonb->'orders') o, jsonb_array_elements(o->'items') i, jsonb_array_elements(i->'modifiers') m
                            where exists (select 1 from jsonb_object_keys(m) k where k not in ('group','label','price_delta','kind')))
   and exists (select 1 from jsonb_array_elements(:'mo'::jsonb->'orders') o, jsonb_array_elements(o->'items') i, jsonb_array_elements(i->'modifiers') m where m->>'kind' = 'SWAP'),
   'R M1: qr_my_orders options = {group, label, price_delta, kind} only');
select test.chk(not ((:'q2'::jsonb->'order'->'items'->0->'modifiers'->2) ? 'removes') and (select items->0->'modifiers'->2 ? 'removes' from qr_orders where id = :'q2id'), 'R M1: qr_place_order reply stripped; stored order keeps the stock details');
-- H1: links of the new columns can't point at another shop
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select public.apply_changes('[{"op":"upsert","table":"ingredients","row":{"id":"bbbbbbbb-0000-0000-0000-000000000001","name":"B secret beans","base_unit":"pcs"}}]');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$update recipes set supplied_ingredient_id = 'bbbbbbbb-0000-0000-0000-000000000001' where id = '33333333-0000-0000-0000-000000000001'$$) like 'FORBIDDEN_ROW%', 'R H1: direct update to another shop''s ingredient refused');
select test.chk(test.err($$update ingredients set merged_into = 'bbbbbbbb-0000-0000-0000-000000000001' where id = '22222222-0000-0000-0000-000000000001'$$) like 'FORBIDDEN_ROW%', 'R H1: merged_into another shop refused');
select test.chk(test.err($$insert into expenses(expense_date, category, amount, ingredient_id) values (current_date, 'SUPPLIES', 1, 'bbbbbbbb-0000-0000-0000-000000000001')$$) like 'FORBIDDEN_ROW%', 'R H1: expense linked to another shop refused');
select test.chk(test.err($$select public.save_supplied_item('{"recipe_id":"33333333-0000-0000-0000-000000000001","ingredient_id":"bbbbbbbb-0000-0000-0000-000000000001","name":"Hijack","selling_price":10}')$$) like 'NOT_A_SUPPLIED_ITEM%', 'R H1: save_supplied_item with another shop''s ingredient refused');
reset role;
select test.chk((select name from ingredients where id = 'bbbbbbbb-0000-0000-0000-000000000001') = 'B secret beans', 'R H1: other shop''s ingredient untouched');
-- L7: an own option can't carry "removes"
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes('[{"op":"update","table":"recipes","row":{"id":"a2000000-0000-0000-0000-000000000031","modifier_groups":[{"id":"g-x","name":"Extra milk","options":[{"id":"o-x","label":"Extra milk","price_delta":15,"removes":[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":-500}]}]}]}}]');
reset role;
select test.chk(not exists (select 1 from recipes r, jsonb_array_elements(r.modifier_groups) g, jsonb_array_elements(g->'options') o where r.id = 'a2000000-0000-0000-0000-000000000031' and o ? 'removes' and not (g ? 'library_group_id')), 'R L7: removes dropped from own options');
-- (a) merge swap conflict
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.merge_ingredients_preview(array['22222222-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000013']::uuid[], 'All milk')$$) like 'MERGE_SWAP_CONFLICT%', 'R a: merging a swap''s from + to -> MERGE_SWAP_CONFLICT');
reset role;
-- (c) a counter can't write menu photos
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err(format($$insert into storage.objects(bucket_id, name) values ('menu-images', '%s/x.jpg')$$, :'biz')) like '%row-level security%', 'R c: counter can''t upload menu photos');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err(format($$insert into storage.objects(bucket_id, name) values ('menu-images', '%s/x.jpg')$$, :'biz')) = 'NO ERROR', 'R c: owner still can');
reset role;

-- customers can't read qr_orders directly (policy dropped); qr_my_orders still works
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select test.chk((select count(*) from qr_orders) = 0 and jsonb_array_length(public.qr_my_orders(:'tok')->'orders') >= 1, 'R: customer reads no qr_orders rows directly; qr_my_orders still lists them');
reset role;
select test.chk(not exists (select 1 from pg_policies where tablename = 'qr_orders' and policyname = 'qr_orders_customer_read'), 'R: qr_orders_customer_read is gone');

-- screens review M1: counters never see the typed cost per piece
select test.chk(not exists (select 1 from information_schema.columns where table_name = 'ingredients' and column_name = 'standard_cost'), 'R2 M1: no standard_cost column on ingredients');
select test.chk((select standard_cost from ingredient_costs where ingredient_id = :'sp_i') is not null, 'R2 M1: typed cost kept in ingredient_costs');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk((select count(*) from ingredient_costs) = 0
   and not exists (select 1 from jsonb_array_elements(public.fo_bootstrap('device-key-0001-abcdef')->'ingredients') x where x ? 'standard_cost')
   and (select count(*) from ingredients where id = :'sp_i') = 1, 'R2 M1: counter reads ingredients but no costs (table or fo_bootstrap)');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk((select (x->>'standard_cost') is not null from jsonb_array_elements(public.bo_bootstrap()->'ingredients') x where x->>'id' = :'sp_i'), 'R2 M1: owner gets standard_cost in bo_bootstrap rows');
reset role;
select test.chk((select not public from storage.buckets where id = 'expense-photos'), 'R2 L3: expense-photos stays private (limits set where Supabase has the columns)');

-- ============================ SW. swap = whole line (lead decision 2026-11-03) ============================
-- 16oz (+60 mL milk extra) + non-dairy swap: all 240 mL dairy become 0.24 L non-dairy
select test.chk(public._recipe_stock_lines(:'biz', '33333333-0000-0000-0000-000000000001', 1,
     '[{"group_id":"g-size","option_id":"o-16"},{"group_id":"lib_b1000000-0000-0000-0000-000000000003","option_id":"oat"}]'::jsonb)
   = '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":18},{"ingredient_id":"a1000000-0000-0000-0000-000000000013","quantity":0.24}]'::jsonb,
   'SW: 16oz + swap -> no dairy at all, 0.24 L non-dairy',
   public._recipe_stock_lines(:'biz', '33333333-0000-0000-0000-000000000001', 1, '[{"group_id":"g-size","option_id":"o-16"},{"group_id":"lib_b1000000-0000-0000-0000-000000000003","option_id":"oat"}]'::jsonb)::text);
-- option order doesn't matter (swap applied after all extras)
select test.chk(public._recipe_stock_lines(:'biz', '33333333-0000-0000-0000-000000000001', 3,
     '[{"group":"Milk","label":"Non-dairy milk"},{"group":"Size","label":"16oz"}]'::jsonb)
   = '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":54},{"ingredient_id":"a1000000-0000-0000-0000-000000000013","quantity":0.72}]'::jsonb,
   'SW: swap chosen first still converts the size''s extra milk (x3)');
-- a second swap of the same "from": only the first moves stock
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','a1000000-0000-0000-0000-000000000014','name','Soy milk','base_unit','ml')),
  jsonb_build_object('op','upsert','table','option_groups','row', jsonb_build_object('id','b1000000-0000-0000-0000-000000000004','name','Soy','sort_order',4,
     'applies_to', '{"subcategories":["Iced"]}'::jsonb,
     'options', '[{"id":"soy","label":"Soy milk","kind":"SWAP","price_delta":20,"swap_from_ingredient_id":"22222222-0000-0000-0000-000000000002","swap_to_ingredient_id":"a1000000-0000-0000-0000-000000000014"}]'::jsonb))));
reset role;
select test.chk(public._recipe_stock_lines(:'biz', '33333333-0000-0000-0000-000000000001', 1,
     '[{"group":"Soy","label":"Soy milk"},{"group":"Milk","label":"Non-dairy milk"}]'::jsonb)
   = '[{"ingredient_id":"22222222-0000-0000-0000-000000000001","quantity":18},{"ingredient_id":"a1000000-0000-0000-0000-000000000014","quantity":180}]'::jsonb,
   'SW: two swaps of the same "from": only the first (soy) moves stock');
select test.chk((select o->>'swap_rule' from recipes r, jsonb_array_elements(r.modifier_groups) g, jsonb_array_elements(g->'options') o
                 where r.id = '33333333-0000-0000-0000-000000000001' and o->>'id' = 'oat') = 'LINE_TOTAL', 'SW: swap options carry swap_rule LINE_TOTAL');
-- waste follows the rule; a QR order stores the swap ids for the counter
select test.stock('a1000000-0000-0000-0000-000000000013') as nd0 \gset
select test.stock('22222222-0000-0000-0000-000000000002') as dm0 \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('waste', jsonb_build_object('id','d1000000-0000-0000-0000-0000000000b1','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001',
   'items','[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group":"Size","label":"16oz"},{"group":"Hot / Iced","label":"Hot"},{"group":"Milk","label":"Non-dairy milk"}]}]'::jsonb))->>'status' as sw1 \gset
reset role;
select test.chk(:'sw1' = 'ok' and test.stock('22222222-0000-0000-0000-000000000002') = :'dm0'::numeric
   and test.stock('a1000000-0000-0000-0000-000000000013') = :'nd0'::numeric - 0.24, 'SW: waste of a 16oz non-dairy latte takes 0.24 L non-dairy, no dairy', :'sw1');
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-16"},{"group_id":"lib_b1000000-0000-0000-0000-000000000001","option_id":"hot"},{"group_id":"lib_b1000000-0000-0000-0000-000000000003","option_id":"oat"}]}]')->'order'->>'id' as swq \gset
reset role;
select test.chk((select m from qr_orders q, jsonb_array_elements(q.items->0->'modifiers') m where q.id = :'swq' and m->>'kind' = 'SWAP')
   @> '{"swap_from_ingredient_id":"22222222-0000-0000-0000-000000000002","swap_to_ingredient_id":"a1000000-0000-0000-0000-000000000013","swap_rule":"LINE_TOTAL"}'::jsonb,
   'SW: stored QR order keeps swap from / to / rule for the counter');
