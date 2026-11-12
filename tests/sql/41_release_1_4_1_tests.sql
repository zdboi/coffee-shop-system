-- Checks for cccc/supabase/011_release_1_4_1.sql (release 1.4.1: public menu link), ported by QA 2026-11-09 from the database engineer.
-- Needs a database with 004..011 on which 10_behaviour_tests + 11_qr_tests have JUST run:
--   tests/reset_db.sh "" cccc
--   P="psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1"
--   $P -f tests/sql/10_behaviour_tests.sql && $P -f tests/sql/11_qr_tests.sql && $P -f tests/sql/41_release_1_4_1_tests.sql
-- (tests/run_all.sh does exactly this.) Prints "ok ..." / "FAIL ..." per check and keeps going.
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
-- every key path in a JSON value, array positions written as []
create or replace function test.paths(j jsonb) returns setof text language sql immutable as $$
  with recursive w(p, v) as (
    select '', j
    union all
    select case when jsonb_typeof(w.v) = 'object' then w.p || '.' || e.key else w.p || '[]' end,
           case when jsonb_typeof(w.v) = 'object' then e.value else a.value end
    from w
    left join lateral jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v end) e on true
    left join lateral jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v end) a on true
    where jsonb_typeof(w.v) in ('object', 'array') and (e.key is not null or a.value is not null)
  )
  select distinct p from w where p <> ''
$$;
-- every string value inside a JSON value
create or replace function test.strings(j jsonb) returns setof text language sql immutable as $$
  select v #>> '{}' from jsonb_path_query(j, 'strict $.**') v where jsonb_typeof(v) = 'string'
$$;
grant execute on all functions in schema test to anon, authenticated;

select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select business_id as biz2 from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset

-- ===== 0. install state =====
select test.chk((select public_code from settings where business_id = :'biz') = 'cccc', 'first shop got code cccc');
select test.chk((select menu_public from settings where business_id = :'biz') = false, 'menu link starts OFF');
select test.chk(public.public_menu('cccc') = '{"error":"NOT_FOUND"}'::jsonb, 'switched off -> NOT_FOUND');

-- ===== 1. owner sets up the menu (more items, a library, the link) =====
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public.apply_changes(jsonb_build_array(
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','c1000000-0000-0000-0000-000000000011','name','Iced cup','base_unit','pcs')),
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','c1000000-0000-0000-0000-000000000013','name','Oat milk','base_unit','ml')),
  jsonb_build_object('op','upsert','table','ingredients','row', jsonb_build_object('id','c1000000-0000-0000-0000-000000000014','name','Flour','base_unit','g')),
  jsonb_build_object('op','upsert','table','option_groups','row', jsonb_build_object('id','c2000000-0000-0000-0000-000000000001','name','Hot / Iced','required',true,'sort_order',1,
     'applies_to', '{"recipe_types":["DRINKS"],"subcategories":[]}'::jsonb,
     'options', '[{"id":"hot","label":"Hot"},{"id":"iced","label":"Iced","price_delta":10}]'::jsonb)),
  jsonb_build_object('op','upsert','table','option_groups','row', jsonb_build_object('id','c2000000-0000-0000-0000-000000000002','name','Take-away cup','sort_order',2,
     'applies_to', '{"recipe_types":["DRINKS"]}'::jsonb,
     'options', '[{"id":"cup","label":"Iced cup","kind":"EXTRA","price_delta":5,"extras":[{"ingredient_id":"c1000000-0000-0000-0000-000000000011","quantity":1}]}]'::jsonb)),
  jsonb_build_object('op','upsert','table','option_groups','row', jsonb_build_object('id','c2000000-0000-0000-0000-000000000003','name','Milk','sort_order',3,
     'applies_to', '{"recipe_types":[],"subcategories":["iced"]}'::jsonb,
     'options', '[{"id":"oat","label":"Non-dairy milk","kind":"SWAP","price_delta":30,"swap_from_ingredient_id":"22222222-0000-0000-0000-000000000002","swap_to_ingredient_id":"c1000000-0000-0000-0000-000000000013"}]'::jsonb)),
  jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object('id','c3000000-0000-0000-0000-000000000001','name','Croissant','recipe_type','PASTRY','category','Pastries','selling_price',95,'sort_order',1,
     'description','Buttery <b>flaky</b>','image_url','https://example.supabase.co/storage/v1/object/public/menu-images/x/croissant.jpg')),
  jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object('id','c3000000-0000-0000-0000-000000000002','name','Hidden on QR','recipe_type','FOOD','selling_price',50,'qr_visible',false)),
  jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object('id','c3000000-0000-0000-0000-000000000003','name','Old item','recipe_type','FOOD','selling_price',50,'active',false)),
  jsonb_build_object('op','upsert','table','recipes','row', jsonb_build_object('id','c3000000-0000-0000-0000-000000000004','name','Banana bread','recipe_type','PASTRY','category','Pastries','selling_price',80,'sort_order',1,
     'image_url','data:image/png;base64,AAAA')),
  jsonb_build_object('op','upsert','table','recipe_ingredients','row', jsonb_build_object('id','c4000000-0000-0000-0000-000000000001','recipe_id','c3000000-0000-0000-0000-000000000004','ingredient_id','c1000000-0000-0000-0000-000000000014','quantity',100,'unit','g'))
));
update recipes set sort_order = 5 where id = '33333333-0000-0000-0000-000000000001';  -- Iced Latte after the pastries

-- bad values are refused
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_public":true,"public_code":null}}]')$$) like '%MENU_CODE_NEEDED%', 'switch on without a code -> MENU_CODE_NEEDED');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_code":"a"}}]')$$) like '%BAD_PUBLIC_CODE%', 'code too short -> BAD_PUBLIC_CODE');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_code":"-cccc"}}]')$$) like '%BAD_PUBLIC_CODE%', 'code starting with - -> BAD_PUBLIC_CODE');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_code":"cc cc"}}]')$$) like '%BAD_PUBLIC_CODE%', 'code with a space -> BAD_PUBLIC_CODE');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_code":"abcdefghijabcdefghijabcdefghij1"}}]')$$) like '%BAD_PUBLIC_CODE%', 'code of 31 -> BAD_PUBLIC_CODE');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_map_url":"http://maps.google.com/x"}}]')$$) like '%BAD_MAP_URL%', 'http map link -> BAD_MAP_URL');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_map_url":"javascript:alert(1)"}}]')$$) like '%BAD_MAP_URL%', 'javascript: link -> BAD_MAP_URL');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_map_url":"https://maps.app.goo.gl/a\"onload=x"}}]')$$) like '%BAD_MAP_URL%', 'quote in link -> BAD_MAP_URL');
select test.chk(test.err(format($q$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_map_url":"https://x.com/%s"}}]')$q$, repeat('a', 500))) like '%BAD_MAP_URL%', 'link over 500 -> BAD_MAP_URL');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_facebook_url":"https://facebook.com@evil.example/x"}}]')$$) like '%BAD_FACEBOOK_URL%', 'facebook link with user@host -> BAD_FACEBOOK_URL');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_facebook_url":"https://evil.example/facebook.com"}}]')$$) like '%BAD_FACEBOOK_URL%', 'non-facebook host -> BAD_FACEBOOK_URL');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_instagram_url":"https://instagram.com.evil.example/x"}}]')$$) like '%BAD_INSTAGRAM_URL%', 'look-alike instagram host -> BAD_INSTAGRAM_URL');
select test.chk(test.err(format($q$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_address":"%s"}}]')$q$, repeat('a', 201))) like '%BAD_PUBLIC_ADDRESS%', 'address over 200 -> BAD_PUBLIC_ADDRESS');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_hours":"7am\u0007"}}]')$$) like '%BAD_PUBLIC_HOURS%', 'control character in hours -> BAD_PUBLIC_HOURS');
select test.chk(test.err(format($q$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_hours":"%s"}}]')$q$, repeat('a', 301))) like '%BAD_PUBLIC_HOURS%', 'hours over 300 -> BAD_PUBLIC_HOURS');

-- good values (code typed with capitals and spaces is tidied)
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_public":true,"public_code":"  CCCC ","public_address":"123 P. Burgos Ave\nCavite City","public_hours":"Mon-Sun 7am-10pm","public_map_url":"https://maps.app.goo.gl/abc123","public_facebook_url":"https://www.facebook.com/cavitecitycoffeeclub","public_instagram_url":"https://instagram.com/cccc","public_map_url":"https://maps.app.goo.gl/abc123"}}]')$$) = 'NO ERROR', 'owner saves the link settings');
select test.chk((select public_code from settings where business_id = :'biz') = 'cccc', 'code tidied to lower-case');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_facebook_url":""}}]')$$) = 'NO ERROR', 'empty link saved');
select test.chk((select public_facebook_url from settings where business_id = :'biz') is null, 'empty link = not set');
select public.apply_changes('[{"op":"update","table":"settings","row":{"public_facebook_url":"https://www.facebook.com/cavitecitycoffeeclub"}}]');
-- a 1.4 Back Office saving settings without the new columns keeps them
select public.apply_changes('[{"op":"upsert","table":"settings","row":{"tax_pct":0,"service_charge_pct":10,"business_name":"Cavite City Coffee Club"}}]');
select test.chk((select menu_public and public_code = 'cccc' and public_hours = 'Mon-Sun 7am-10pm' from settings where business_id = :'biz'), '1.4 settings upsert keeps the link fields');

-- highlight ("Today's pick")
reset role;
insert into recipes (id, business_id, name, selling_price) values ('c3000000-0000-0000-0000-000000000099', :'biz2', 'Other shop item', 100);
set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_highlight_recipe_id":"c3000000-0000-0000-0000-000000000099"}}]')$$) ~ '(FORBIDDEN_ROW|BAD_HIGHLIGHT)', 'highlight: other shop''s item refused',
   test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_highlight_recipe_id":"c3000000-0000-0000-0000-000000000099"}}]')$$));
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_highlight_recipe_id":"c3000000-0000-0000-0000-000000000002"}}]')$$) like '%BAD_HIGHLIGHT%', 'highlight: item hidden on QR refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_highlight_recipe_id":"c3000000-0000-0000-0000-000000000003"}}]')$$) like '%BAD_HIGHLIGHT%', 'highlight: inactive item refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_highlight_recipe_id":"c3000000-0000-0000-0000-0000000000ff"}}]')$$) ~ '(BAD_HIGHLIGHT|foreign key)', 'highlight: unknown item refused');
select test.chk(test.err(format($q$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_highlight_label":"%s"}}]')$q$, repeat('a', 31))) like '%BAD_HIGHLIGHT_LABEL%', 'label over 30 -> BAD_HIGHLIGHT_LABEL');
select test.chk(test.err(format($q$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_highlight_blurb":"%s"}}]')$q$, repeat('a', 141))) like '%BAD_HIGHLIGHT_BLURB%', 'blurb over 140 -> BAD_HIGHLIGHT_BLURB');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_highlight_recipe_id":"c3000000-0000-0000-0000-000000000001","menu_highlight_label":"  ","menu_highlight_blurb":"Fresh\nfrom the\u0007 oven "}}]')$$) = 'NO ERROR', 'owner picks Croissant as highlight');
select test.chk((select menu_highlight_label is null and menu_highlight_blurb = 'Fresh from the  oven' from settings where business_id = :'biz'), 'label empty -> not set; control chars in blurb -> spaces',
  (select coalesce(menu_highlight_label,'<null>') || '|' || menu_highlight_blurb from settings where business_id = :'biz'));
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;

-- the other shop can't take the code
select test.login('00000000-0000-0000-0000-0000000000b1');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_code":"cccc"}}]')$$) like '%PUBLIC_CODE_TAKEN%', 'other shop: same code -> PUBLIC_CODE_TAKEN');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_code":"other-shop","menu_public":false}}]')$$) = 'NO ERROR', 'other shop: own code, switched off');
reset role;

-- ===== 2. the public (anon) reads the menu =====
select test.login(null);
set role anon;
select public.public_menu('cccc') as m \gset
select test.chk(:'m'::jsonb ? 'items', 'anon gets the menu');
select test.chk(public.public_menu('CCCC ') = :'m'::jsonb, 'code is case / space insensitive');
select test.chk(test.err('select count(*) from public.settings') like '%permission denied%', 'anon reads no settings directly');
select test.chk(test.err('select count(*) from public.recipes') like '%permission denied%', 'anon reads no recipes directly');
select test.chk(test.err($$select public._public_menu_options('[]')$$) like '%permission denied%', 'anon can''t call the helpers');
select test.chk(test.err($$select public._settings_check()$$) like '%permission denied%' or test.err($$select public._settings_check()$$) like '%trigger%', 'anon can''t call the settings check');

-- whitelist of every key, at every depth
select test.chk(not exists (
  select 1 from test.paths(:'m'::jsonb) p
  where p not in ('.shop','.shop.code','.shop.name','.shop.logo_url',
    '.theme','.theme.primary_color','.theme.secondary_color','.theme.accent_color','.theme.background_color','.theme.card_color','.theme.text_color','.theme.theme',
    '.visit','.visit.address','.visit.hours','.visit.map_url','.visit.facebook_url','.visit.instagram_url',
    '.pricing','.pricing.tax_pct','.pricing.service_charge_pct','.pricing.tax_inclusive',
    '.subcategory_order','.subcategory_order[]','.subcategory_colors',
    '.truncated','.highlight','.highlight.item_index','.highlight.name','.highlight.image_url','.highlight.price','.highlight.sold_out','.highlight.label','.highlight.blurb',
    '.items','.items[]','.items[].name','.items[].recipe_type','.items[].subcategory','.items[].category','.items[].description',
    '.items[].image_url','.items[].price','.items[].sold_out','.items[].options','.items[].options[]',
    '.items[].options[].name','.items[].options[].required','.items[].options[].multi','.items[].options[].options',
    '.items[].options[].options[]','.items[].options[].options[].label','.items[].options[].options[].price_delta','.items[].options[].options[].kind')
    and p not like '.subcategory_colors.%'),
  'only whitelisted keys anywhere', (select string_agg(p, ', ') from test.paths(:'m'::jsonb) p));
select test.chk(not exists (select 1 from test.strings(:'m'::jsonb) s where s ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'),
  'no id (uuid) anywhere in the answer');
select test.chk(position('ingredient' in :'m') = 0 and position('extras' in :'m') = 0 and position('swap_' in :'m') = 0 and position('cost' in :'m') = 0
  and position('phone' in :'m') = 0 and position('stock' in :'m') = 0, 'no stock / cost / customer words');

-- items: which and in what order
select test.chk((select array_agg(i->>'name' order by o) from jsonb_array_elements(:'m'::jsonb->'items') with ordinality x(i, o))::text = '{"Banana bread",Croissant,"Iced Latte"}',
  'only QR items (no hidden / inactive / price 0), sort order then name', (select array_agg(i->>'name' order by o) from jsonb_array_elements(:'m'::jsonb->'items') with ordinality x(i, o))::text);
select (:'m'::jsonb->'items') as items \gset
select test.chk((select i from jsonb_array_elements(:'items'::jsonb) i where i->>'name' = 'Croissant')
   = '{"name":"Croissant","recipe_type":"PASTRY","subcategory":"Pastries","category":"Pastries","description":"Buttery <b>flaky</b>","image_url":"https://example.supabase.co/storage/v1/object/public/menu-images/x/croissant.jpg","price":95,"sold_out":false,"options":[]}'::jsonb,
   'Croissant row exactly', (select i::text from jsonb_array_elements(:'items'::jsonb) i where i->>'name' = 'Croissant'));
select test.chk((select i->'image_url' = 'null'::jsonb and i->'description' = 'null'::jsonb from jsonb_array_elements(:'items'::jsonb) i where i->>'name' = 'Banana bread'), 'data: photo and empty description left out');
-- options of the Iced Latte: library groups (incl. EXTRA and SWAP) + own groups
select test.chk((select i->'options' from jsonb_array_elements(:'items'::jsonb) i where i->>'name' = 'Iced Latte')
  = '[{"name":"Hot / Iced","required":true,"multi":false,"options":[{"label":"Hot","price_delta":0,"kind":"PLAIN"},{"label":"Iced","price_delta":10,"kind":"PLAIN"}]},
      {"name":"Take-away cup","required":false,"multi":false,"options":[{"label":"Iced cup","price_delta":5,"kind":"EXTRA"}]},
      {"name":"Milk","required":false,"multi":false,"options":[{"label":"Non-dairy milk","price_delta":30,"kind":"SWAP"}]},
      {"name":"Size","required":true,"multi":false,"options":[{"label":"12oz","price_delta":0,"kind":"PLAIN"},{"label":"16oz","price_delta":20,"kind":"PLAIN"}]},
      {"name":"Add-ons","required":false,"multi":true,"options":[{"label":"Extra shot","price_delta":30,"kind":"PLAIN"},{"label":"Oat milk","price_delta":25,"kind":"PLAIN"}]}]'::jsonb,
  'Iced Latte options: names, required, multi, labels, prices, kinds (in order)',
  (select (i->'options')::text from jsonb_array_elements(:'items'::jsonb) i where i->>'name' = 'Iced Latte'));
select test.chk((:'m'::jsonb->'visit') = '{"address":"123 P. Burgos Ave\nCavite City","hours":"Mon-Sun 7am-10pm","map_url":"https://maps.app.goo.gl/abc123","facebook_url":"https://www.facebook.com/cavitecitycoffeeclub","instagram_url":"https://instagram.com/cccc"}'::jsonb,
  'visit fields', (:'m'::jsonb->'visit')::text);
select test.chk((:'m'::jsonb->'highlight') = '{"item_index":1,"name":"Croissant","image_url":"https://example.supabase.co/storage/v1/object/public/menu-images/x/croissant.jpg","price":95,"sold_out":false,"label":"Today''s pick","blurb":"Fresh from the  oven"}'::jsonb
   and (:'m'::jsonb->'items'->1->>'name') = 'Croissant', 'highlight: points at items[1], default label', (:'m'::jsonb->'highlight')::text);
select test.chk((:'m'::jsonb->'shop'->>'name') = 'Cavite City Coffee Club' and (:'m'::jsonb->'shop'->>'code') = 'cccc', 'shop name + code');
select test.chk(length(:'m') < 20000, 'answer is small', length(:'m')::text);

-- bad / unknown / switched-off codes: same plain answer
select test.chk(public.public_menu('nope') = '{"error":"NOT_FOUND"}'::jsonb, 'unknown code -> NOT_FOUND');
select test.chk(public.public_menu('other-shop') = '{"error":"NOT_FOUND"}'::jsonb, 'switched-off shop -> NOT_FOUND (same answer)');
select test.chk(public.public_menu(null) = '{"error":"NOT_FOUND"}'::jsonb, 'null -> NOT_FOUND');
select test.chk(public.public_menu('') = '{"error":"NOT_FOUND"}'::jsonb, 'empty -> NOT_FOUND');
select test.chk(public.public_menu(repeat('a', 100000)) = '{"error":"NOT_FOUND"}'::jsonb, 'huge input -> NOT_FOUND');
select test.chk(public.public_menu($$cccc' or '1'='1$$) = '{"error":"NOT_FOUND"}'::jsonb, 'quote input -> NOT_FOUND');
select test.chk(public.public_menu('%') = '{"error":"NOT_FOUND"}'::jsonb, 'wildcard -> NOT_FOUND');
reset role;

-- ===== 3. sold out =====
update recipes set sold_out = true where id = 'c3000000-0000-0000-0000-000000000001';
set role anon;
select test.chk((select (i->>'sold_out')::boolean from jsonb_array_elements(public.public_menu('cccc')->'items') i where i->>'name' = 'Croissant'), 'marked sold out at the counter -> sold_out');
select test.chk((public.public_menu('cccc')->'highlight'->>'sold_out')::boolean and (public.public_menu('cccc')->'highlight'->>'name') = 'Croissant', 'sold-out highlight still shown, sold_out true');
-- Banana bread has no flour: still on sale while "hide items we can't make" is off (like QR)
select test.chk(not (select (i->>'sold_out')::boolean from jsonb_array_elements(public.public_menu('cccc')->'items') i where i->>'name' = 'Banana bread'), 'no stock, hide option off -> not sold out (as QR)');
reset role;
update settings set qr_hide_out_of_stock = true where business_id = :'biz';
set role anon;
select test.chk((select (i->>'sold_out')::boolean from jsonb_array_elements(public.public_menu('cccc')->'items') i where i->>'name' = 'Banana bread'), 'no stock, hide option on -> sold_out (as QR)');
select test.chk(not (select (i->>'sold_out')::boolean from jsonb_array_elements(public.public_menu('cccc')->'items') i where i->>'name' = 'Iced Latte'), 'enough stock -> not sold out');
reset role;
-- same answer as the QR menu's "available" (QR menu needs an open shop; compare formula on the flag)
select test.chk((select bool_and((pm->>'sold_out')::boolean = not (q->>'available')::boolean)
                 from jsonb_array_elements(public.public_menu('cccc')->'items') pm
                 join jsonb_array_elements((select public.get_qr_menu(qr_token) from dining_tables where business_id = :'biz' and active limit 1)->'items') q on q->>'name' = pm->>'name')
                or not public._shop_is_open(:'biz'::uuid), 'sold_out = not QR available (when the shop is open)');
update settings set qr_hide_out_of_stock = false where business_id = :'biz';

-- ===== 4. other callers =====
select test.login('00000000-0000-0000-0000-0000000000c1');   -- a QR customer
set role authenticated;
select test.chk(public.public_menu('cccc') ? 'items', 'signed-in customer may call it too');
select test.chk((select count(*) from public.settings) = 0, 'customer still reads no settings');
reset role;
select test.login('00000000-0000-0000-0000-0000000000b1');   -- another shop's owner
set role authenticated;
select test.chk(public.public_menu('cccc') ? 'items' and public.public_menu('other-shop') = '{"error":"NOT_FOUND"}'::jsonb, 'other shop owner: same view as the public, own switched-off menu hidden');
reset role;

-- turning the link off hides it at once
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public.apply_changes('[{"op":"update","table":"settings","row":{"menu_public":false}}]');
set role anon;
select test.chk(public.public_menu('cccc') = '{"error":"NOT_FOUND"}'::jsonb, 'owner switches it off -> NOT_FOUND');
reset role;
select test.chk(has_function_privilege('anon', 'public.public_menu(text)', 'execute'), 'anon has execute on public_menu');
select test.chk(not has_function_privilege('anon', 'public._public_image_url(text)', 'execute') and not has_function_privilege('authenticated', 'public._valid_public_url(text,text[])', 'execute'), 'helpers locked');
select test.chk((select provolatile = 's' and prosecdef and proconfig::text like '%search_path=public%' from pg_proc where oid = 'public.public_menu(text)'::regprocedure), 'public_menu is stable, security definer, fixed search_path');

-- highlight item hidden later: settings saves still work, link shows no highlight
update recipes set qr_visible = false where id = 'c3000000-0000-0000-0000-000000000001';
update settings set menu_public = true where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"settings","row":{"tax_pct":0,"service_charge_pct":10}}]')$$) = 'NO ERROR', 'settings save still works after the highlighted item was hidden');
set role anon;
select test.chk(public.public_menu('cccc')->'highlight' = 'null'::jsonb, 'hidden highlighted item -> highlight null');
reset role;
delete from recipes where id = 'c3000000-0000-0000-0000-000000000001';
select test.chk((select menu_highlight_recipe_id is null from settings where business_id = :'biz'), 'deleted item clears the highlight');

-- ===== 5. security review fixes =====
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_map_url":"https://maps.goo.gl/café"}}]')$$) like '%BAD_MAP_URL%', 'LOW4: non-ASCII link -> BAD_MAP_URL');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_facebook_url":"https://facebоok.com/x"}}]')$$) like '%BAD_FACEBOOK_URL%', 'LOW4: look-alike letter in host -> BAD_FACEBOOK_URL');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"public_hours":"Mon-Fri 7-9\r\nSat 8-10\rSun closed"}}]')$$) = 'NO ERROR', 'LOW5: Windows line breaks accepted');
select test.chk((select public_hours from settings where business_id = :'biz') = E'Mon-Fri 7-9\nSat 8-10\nSun closed', 'LOW5: line breaks normalised');
reset role;
-- LOW 6: two shops racing for one code -> the trigger waits (advisory lock); simulated: the code check
select test.chk(position('pg_advisory_xact_lock' in prosrc) > 0, 'LOW6: code change takes the per-code lock') from pg_proc where proname = '_settings_check';
-- MEDIUM 3: rights
select test.chk(not exists (select 1 from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'), 'MED3: anon has no table rights in public',
  (select string_agg(distinct table_name, ',') from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'));
select test.chk(not exists (select 1 from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER')), 'MED3: authenticated has no TRUNCATE/REFERENCES/TRIGGER');
select test.chk(has_table_privilege('authenticated', 'public.settings', 'select') and has_table_privilege('authenticated', 'public.recipes', 'insert'), 'MED3: authenticated keeps select / insert');
create table public.zz_new_table (id int); 
select test.chk(not has_table_privilege('anon', 'public.zz_new_table', 'select'), 'MED3: a table made later gives anon nothing');
drop table public.zz_new_table;
set role anon;
select test.chk(test.err('select count(*) from public.settings') like '%permission denied%', 'MED3: anon reading settings -> permission denied');
select test.chk(public.public_menu('cccc') ? 'items' or public.public_menu('cccc') = '{"error":"NOT_FOUND"}'::jsonb, 'MED3: public_menu still runs for anon');
reset role;
-- MEDIUM 2: colours and size budget
update settings set menu_public = true, primary_color = 'red;background:url(x)', accent_color = '#C17A3D' where business_id = :'biz';
set role anon;
select test.chk((public.public_menu('cccc')->'theme'->>'primary_color') is null and (public.public_menu('cccc')->'theme'->>'accent_color') = '#C17A3D', 'MED2: only #RRGGBB colours');
select test.chk((public.public_menu('cccc')->>'truncated')::boolean = false, 'MED2: small menu not truncated');
reset role;
insert into recipes (id, business_id, name, recipe_type, selling_price, sort_order, modifier_groups)
select gen_random_uuid(), :'biz', 'Big ' || lpad(n::text, 2, '0'), 'FOOD', 10, 50,
  (select jsonb_agg(jsonb_build_object('id', 'g' || g, 'name', 'G' || g, 'options',
     (select jsonb_agg(jsonb_build_object('id', 'o' || o, 'label', 'O' || o, 'price_delta', 1)) from generate_series(1, 25) o))) from generate_series(1, 12) g)
from generate_series(1, 15) n;
set role anon;
select public.public_menu('cccc') as big \gset
select test.chk((select max(jsonb_array_length(i->'options')) from jsonb_array_elements(:'big'::jsonb->'items') i) = 10
  and (select max(jsonb_array_length(g->'options')) from jsonb_array_elements(:'big'::jsonb->'items') i, jsonb_array_elements(i->'options') g) = 20, 'MED2: at most 10 groups x 20 options per item');
select test.chk((select count(*) from jsonb_array_elements(:'big'::jsonb->'items') i, jsonb_array_elements(i->'options') g, jsonb_array_elements(g->'options') o) <= 2000
  and (:'big'::jsonb->>'truncated')::boolean and length(:'big') < 600000, 'MED2: total options <= 2000, truncated = true',
  (select count(*) from jsonb_array_elements(:'big'::jsonb->'items') i, jsonb_array_elements(i->'options') g, jsonb_array_elements(g->'options') o)::text);
reset role;
delete from recipes where name like 'Big %';
-- HIGH 1: get_qr_menu gives the same answer as 009's version (open shop, hide option on and off)
\ir 41a_old_get_qr_menu.sql
-- 1.5 (012, owner items B11 + B12): get_qr_menu adds "highlight" and a display-only "available" flag per option.
-- The comparison with 009's answer is made with those two additions taken out; everything else must be equal.
create or replace function test.strip15(j jsonb) returns jsonb language sql as $$
  select (j - 'highlight') || case when j ? 'items' then jsonb_build_object('items', coalesce((
    select jsonb_agg(case when jsonb_typeof(i->'modifier_groups') = 'array' then i || jsonb_build_object('modifier_groups', coalesce((
        select jsonb_agg(case when jsonb_typeof(g->'options') = 'array' then g || jsonb_build_object('options', coalesce((select jsonb_agg(o - 'available' order by n) from jsonb_array_elements(g->'options') with ordinality x(o, n)), '[]'::jsonb)) else g end order by gn)
        from jsonb_array_elements(i->'modifier_groups') with ordinality y(g, gn)), '[]'::jsonb)) else i end order by inn)
    from jsonb_array_elements(j->'items') with ordinality z(i, inn)), '[]'::jsonb)) else '{}'::jsonb end
$$;
insert into shifts (business_id, status, opened_at) values (:'biz', 'ACTIVE', now());
update recipes set sold_out = true where name = 'Banana bread';
select qr_token as tok from dining_tables where business_id = :'biz' and active limit 1 \gset
select test.chk(test.strip15(public.get_qr_menu(:'tok')) = test.old_get_qr_menu(:'tok') and jsonb_array_length(public.get_qr_menu(:'tok')->'items') > 0
  and public.get_qr_menu(:'tok') ? 'highlight', 'HIGH1: get_qr_menu same as 009 (hide off), apart from 1.5''s highlight + option available');
update settings set qr_hide_out_of_stock = true where business_id = :'biz';
insert into recipes (id, business_id, name, recipe_type, selling_price) values ('c3000000-0000-0000-0000-0000000000a1', :'biz', 'Flour cake', 'PASTRY', 60);
insert into recipe_ingredients (id, business_id, recipe_id, ingredient_id, quantity, unit) values (gen_random_uuid(), :'biz', 'c3000000-0000-0000-0000-0000000000a1', 'c1000000-0000-0000-0000-000000000014', 50, 'g');
select test.chk(test.strip15(public.get_qr_menu(:'tok')) = test.old_get_qr_menu(:'tok'), 'HIGH1: get_qr_menu same as 009 (hide on), apart from 1.5''s highlight + option available');
select test.chk((select not (i->>'available')::boolean from jsonb_array_elements(public.get_qr_menu(:'tok')->'items') i where i->>'name' = 'Flour cake'), 'HIGH1: no-stock item unavailable (hide on)');
set role anon;
select test.chk((select (i->>'sold_out')::boolean from jsonb_array_elements(public.public_menu('cccc')->'items') i where i->>'name' = 'Flour cake'), 'HIGH1: public_menu agrees (sold out)');
reset role;
