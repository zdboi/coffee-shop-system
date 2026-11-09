-- Seed for tests/e2e/menu_public.e2e.js (release 1.4.1 public menu page): a rich menu + the menu link settings. Applied by that test on top of tests/sql/20_seed_e2e.sql. (From customer-qr-dev, 2026-11-09.)
-- Photo URLs http://localhost:8893/... are placeholders: the test points them at files the stand-in serves
-- (tile icon; "missing.jpg" -> a 404 path) once it knows its port.
select id as bid from businesses limit 1 \gset
\set B '''':bid''''
update recipes set sort_order = 10, category='Hot', image_url='http://localhost:8893/latte.jpg' where name='Americano';
update recipes set sort_order = 20, image_url='http://localhost:8893/iced.jpg' where name='Iced Latte';
update recipes set sort_order = 50, image_url='http://localhost:8893/ensaymada.jpg' where name='Ensaymada';
insert into recipes (business_id,name,recipe_type,category,selling_price,sort_order,description,image_url,sold_out,modifier_groups) values
 (:B,'Café latte','DRINKS','Hot',120,5,'Smooth espresso with steamed milk.','http://localhost:8893/latte.jpg',false,
  '[{"id":"s","name":"Size","required":true,"multi_select":false,"options":[{"id":"a","label":"12oz","price_delta":0},{"id":"b","label":"16oz","price_delta":20}]},{"id":"m","name":"Milk","required":false,"multi_select":false,"options":[{"id":"c","label":"Oat milk","price_delta":30,"ingredient_id":"22222222-0000-0000-0000-000000000001","kind":"SWAP"}]},{"id":"x","name":"Extras","required":false,"multi_select":true,"options":[{"id":"d","label":"Extra shot","price_delta":40,"kind":"EXTRA"}]}]'),
 (:B,'Iced caramel macchiato','DRINKS','Iced',160,25,null,null,true,'[{"id":"s","name":"Size","required":true,"multi_select":false,"options":[{"id":"a","label":"16oz","price_delta":0}]}]'),
 (:B,'Iced Spanish latte','DRINKS','Iced',150,22,null,'http://localhost:8893/missing.jpg',false,'[{"id":"m","name":"Milk","required":false,"multi_select":false,"options":[{"id":"c","label":"Oat milk","price_delta":30}]}]'),
 (:B,'Matcha latte','DRINKS','Non-coffee',140,30,null,null,false,'[{"id":"t","name":"Temp","required":true,"multi_select":false,"options":[{"id":"h","label":"Hot","price_delta":0},{"id":"i","label":"Iced","price_delta":10}]}]'),
 (:B,'Ube cheese pandesal','PASTRY',null,55,55,null,null,false,'[]'),
 (:B,'<img src=x onerror=alert(1)> "Pwn" & co','PASTRY',null,99.5,56,'<script>alert(2)</script>',null,true,'[]'),
 (:B,'Tapsilog','FOOD','Rice meals',180,60,'Beef tapa, garlic rice, egg.','http://localhost:8893/tapsilog.jpg',false,'[{"id":"e","name":"Add","required":false,"multi_select":true,"options":[{"id":"e1","label":"Extra egg","price_delta":20}]}]'),
 (:B,'Hidden item','DRINKS','Hot',100,1,null,null,false,'[]');
update recipes set qr_visible=false where name='Hidden item';
update settings set menu_public=true,
  subcategory_order='["Hot","Iced","Non-coffee"]'::jsonb,
  subcategory_colors='{"Hot":"olive","Iced":"sky","Non-coffee":"sage","Pastry":"gold","Rice meals":"terracotta"}'::jsonb,
  public_address=E'123 P. Burgos Ave., Caridad\nCavite City',
  public_hours='Tue–Sun · 7:00 AM – 9:00 PM',
  public_map_url='https://maps.google.com/?q=Cavite+City',
  public_facebook_url='https://www.facebook.com/cavitecitycoffeeclub',
  public_instagram_url=null,
  menu_highlight_recipe_id=(select id from recipes where name='Ensaymada'),
  menu_highlight_label=null,
  menu_highlight_blurb='Fresh from the oven every morning. Best with a hot café latte.';
