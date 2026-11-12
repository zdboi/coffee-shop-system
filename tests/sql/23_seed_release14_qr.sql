-- Seed for tests/e2e/order_release14.e2e.js (release 1.4 QR page: library option groups, swaps). Applied by that test on top of tests/sql/20_seed_e2e.sql.
\set ON_ERROR_STOP 1
do $$
declare b uuid := (select id from businesses limit 1);
begin
insert into recipes(id, business_id, name, recipe_type, category, selling_price, modifier_groups, description) values
 ('33333333-0000-0000-0000-0000000000a1', b, 'Spanish Latte', 'DRINKS', 'Iced', 160, '[]', 'Sweet and creamy.'),
 ('33333333-0000-0000-0000-0000000000a2', b, 'Matcha', 'DRINKS', 'Non-coffee', 170, '[]', null)
 on conflict (id) do nothing;
insert into ingredients(id,business_id,name,base_unit) values
 ('22222222-0000-0000-0000-0000000000b1',b,'Oat milk','ml'),
 ('22222222-0000-0000-0000-0000000000b2',b,'Iced cup 16oz','pcs'),
 ('22222222-0000-0000-0000-0000000000b3',b,'Dome lid','pcs'),
 ('22222222-0000-0000-0000-0000000000b4',b,'Caramel syrup','ml')
 on conflict (id) do nothing;
-- 1.5 (owner item B12): the QR page lists a swap only while its milk is in stock, so the oat milk gets stock here
insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date)
  select b, '22222222-0000-0000-0000-0000000000b1', 'INITIAL_STOCK', 5000, current_date
  where not exists (select 1 from inventory_transactions where ingredient_id = '22222222-0000-0000-0000-0000000000b1');
-- Matcha uses milk too, so the swap shows there
insert into recipe_ingredients(business_id,recipe_id,ingredient_id,quantity) values (b,'33333333-0000-0000-0000-0000000000a2','22222222-0000-0000-0000-000000000002',150) on conflict do nothing;
insert into option_groups(id,business_id,name,required,multi_select,sort_order,applies_to,options) values
 ('44444444-0000-0000-0000-000000000001',b,'Hot or iced',true,false,1,'{"recipe_types":["DRINKS"],"subcategories":[]}',
  '[{"id":"hot","label":"Hot","price_delta":0,"kind":"PLAIN"},{"id":"iced","label":"Iced","price_delta":10,"kind":"PLAIN"}]'),
 ('44444444-0000-0000-0000-000000000002',b,'Milk',false,false,2,'{"recipe_types":["DRINKS"],"subcategories":[]}',
  '[{"id":"oat","label":"Non-dairy milk (oat)","price_delta":30,"kind":"SWAP","swap_from_ingredient_id":"22222222-0000-0000-0000-000000000002","swap_to_ingredient_id":"22222222-0000-0000-0000-0000000000b1"}]'),
 ('44444444-0000-0000-0000-000000000003',b,'Take-away cup',false,false,3,'{"recipe_types":["DRINKS"],"subcategories":[]}',
  '[{"id":"cup","label":"Iced cup with lid","price_delta":5,"kind":"EXTRA","extras":[{"ingredient_id":"22222222-0000-0000-0000-0000000000b2","quantity":1},{"ingredient_id":"22222222-0000-0000-0000-0000000000b3","quantity":1}]}]'),
 ('44444444-0000-0000-0000-000000000004',b,'Sweetness',false,false,4,'{"recipe_types":["DRINKS"],"subcategories":[]}',
  '[{"id":"s0","label":"No sugar","price_delta":0},{"id":"s50","label":"Half sweet","price_delta":0},{"id":"s100","label":"Regular","price_delta":0},{"id":"s125","label":"Extra sweet","price_delta":0}]'),
 ('44444444-0000-0000-0000-000000000005',b,'Add a flavour',false,true,5,'{"recipe_types":[],"subcategories":["Iced"," non-coffee "]}',
  '[{"id":"car","label":"Caramel drizzle","price_delta":20,"kind":"EXTRA","extras":[{"ingredient_id":"22222222-0000-0000-0000-0000000000b4","quantity":15}]},{"id":"van","label":"Vanilla","price_delta":20},{"id":"haz","label":"Hazelnut","price_delta":25},{"id":"sea","label":"Sea salt cream foam","price_delta":35},{"id":"cin","label":"Cinnamon","price_delta":0}]');
end $$;
select name, jsonb_path_query_array(modifier_groups,'$[*].name') from recipes order by name;
