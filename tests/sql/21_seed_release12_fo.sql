-- Release 1.2 counter seed (adopted from front-office-dev's seed_12.sql). Applied ON TOP of 20_seed_e2e.sql
-- by tests/e2e/fo_release12.e2e.js: sub-category colours, extra menu items, floor plan (tables + shapes),
-- customers Mika 7 stamps, Rico 15 (all rewards ready), Paolo 2, 'Zed <b>x</b>' 0 (HTML nickname).
\set QUIET on
do $$
declare v_biz uuid; v_c uuid; d int; v_s uuid;
  latte uuid := '33333333-0000-0000-0000-000000000001'; amer uuid := '33333333-0000-0000-0000-000000000003'; ens uuid := '33333333-0000-0000-0000-000000000004';
begin
  select business_id into v_biz from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';
  update public.settings set loyalty_enabled = true, qr_ordering_enabled = true,
    subcategory_colors = '{"Iced":"terracotta","Hot":"cocoa","Pastry":"butter","Non-coffee":"sage","Rice meals":"olive"}'::jsonb
    where business_id = v_biz;
  insert into public.recipes(id, business_id, name, recipe_type, category, selling_price, modifier_groups, sort_order) values
    ('33333333-0000-0000-0000-000000000011', v_biz, 'Spanish Latte', 'DRINKS', 'Hot', 165, '[]', 2),
    ('33333333-0000-0000-0000-000000000012', v_biz, 'Cappuccino', 'DRINKS', 'Hot', 150, '[]', 1),
    ('33333333-0000-0000-0000-000000000013', v_biz, 'Iced Mocha', 'DRINKS', 'Iced', 180, '[]', 3),
    ('33333333-0000-0000-0000-000000000014', v_biz, 'Matcha Latte', 'DRINKS', 'Non-coffee', 170, '[]', 1),
    ('33333333-0000-0000-0000-000000000015', v_biz, 'Banana Bread', 'PASTRY', 'Pastry', 95, '[]', 2),
    ('33333333-0000-0000-0000-000000000016', v_biz, 'Tapsilog', 'FOOD', 'Rice meals', 189, '[]', 1),
    ('33333333-0000-0000-0000-000000000017', v_biz, 'Hazelnut Syrup', 'SAUCES_SYRUPS', 'Add-ons', 25, '[]', 1);
  update public.recipes set category = 'Pastry' where id = ens;
  -- floor plan
  update public.dining_tables set label = 'T5', shape = 'RECT', pos_x = 80, pos_y = 560, width = 360, height = 120, seats = 8 where id = '77777777-0000-0000-0000-000000000005';
  insert into public.dining_tables(id, business_id, label, kind, qr_token, sort_order, shape, pos_x, pos_y, width, height, seats) values
    ('77777777-0000-0000-0000-000000000001', v_biz, 'T1', 'DINE_IN', 'tabletoken1', 1, 'SQUARE', 80, 300, 140, 140, 4),
    ('77777777-0000-0000-0000-000000000002', v_biz, 'T2', 'DINE_IN', 'tabletoken2', 2, 'SQUARE', 300, 300, 140, 140, 4),
    ('77777777-0000-0000-0000-000000000003', v_biz, 'T3', 'DINE_IN', 'tabletoken3', 3, 'ROUND', 520, 290, 160, 160, 2),
    ('77777777-0000-0000-0000-000000000004', v_biz, 'T4', 'DINE_IN', 'tabletoken4', 4, 'ROUND', 750, 290, 160, 160, 2),
    ('77777777-0000-0000-0000-000000000006', v_biz, 'Bar 1', 'DINE_IN', 'tabletoken6', 6, 'SQUARE', null, null, 80, 80, null);
  insert into public.floor_shapes(id, business_id, kind, label, shape, pos_x, pos_y, width, height, rotation, sort_order) values
    (gen_random_uuid(), v_biz, 'WALL', '', 'RECT', 0, 0, 1000, 14, 0, 1),
    (gen_random_uuid(), v_biz, 'COUNTER', 'Counter & bar', 'RECT', 60, 60, 420, 110, 0, 2),
    (gen_random_uuid(), v_biz, 'DOOR', 'Door', 'RECT', 760, 60, 150, 60, 0, 3),
    (gen_random_uuid(), v_biz, 'PLANT', '', 'ROUND', 900, 700, 60, 60, 0, 4),
    (gen_random_uuid(), v_biz, 'LABEL', 'Patio', 'RECT', 700, 580, 200, 60, 0, 5);
  -- customers: Mika 7 stamps (₱10 ready), Rico 15 stamps (all three ready), Paolo 2 stamps, Zed <b>x</b> 0
  insert into public.customers(id, business_id, nickname, phone, source, consent_at) values
    ('88888888-0000-0000-0000-000000000001', v_biz, 'Mika', '+639171234567', 'COUNTER', now()),
    ('88888888-0000-0000-0000-000000000002', v_biz, 'Rico', '+639958888830', 'COUNTER', now()),
    ('88888888-0000-0000-0000-000000000003', v_biz, 'Paolo', '+639281111102', 'COUNTER', now()),
    ('88888888-0000-0000-0000-000000000004', v_biz, 'Zed <b>x</b>', null, 'COUNTER', now());
  for v_c, d in select * from (values ('88888888-0000-0000-0000-000000000001'::uuid, 7), ('88888888-0000-0000-0000-000000000002'::uuid, 15), ('88888888-0000-0000-0000-000000000003'::uuid, 2)) t loop
    for i in 1..d loop
      v_s := gen_random_uuid();
      -- stamps: alternate drink-only days and drink+food days so the count is exact
      insert into public.sales(id, business_id, transaction_number, transaction_date, status, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total, customer_id, source, cashier_name)
        values (v_s, v_biz, 'POS-Z-2026-' || lpad((i + d*10)::text, 6, '0') || substr(v_c::text, 36), now() - (i * interval '1 day') - interval '2 hours', 'COMPLETED', 110, 0, 0, 0, 110, v_c, 'COUNTER', 'Seed');
      insert into public.sale_items(id, business_id, sale_id, recipe_id, name, quantity, unit_price, line_total, modifiers)
        values (gen_random_uuid(), v_biz, v_s, case when i % 3 = 0 then latte else amer end, case when i % 3 = 0 then 'Iced Latte' else 'Americano' end, 1, 110, 110, '[]');
    end loop;
  end loop;
end $$;
-- run the deferred loyalty refresh for everyone
select public._refresh_customer_loyalty(id) from public.customers;

