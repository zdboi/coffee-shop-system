-- Seed data for the browser end-to-end tests (run as superuser after reset_db.sh).
\set QUIET on
update auth.users set encrypted_password = extensions.crypt('secret123', extensions.gen_salt('bf')) where email = 'owner@example.com';
do $$
declare v_biz uuid; v_owner_staff uuid;
begin
  select business_id into v_biz from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';
  select id into v_owner_staff from public.staff where profile_id = '00000000-0000-0000-0000-0000000000a1';
  update public.settings set business_name = 'Cavite City Coffee Club', service_charge_pct = 0, tax_pct = 0 where business_id = v_biz;
  insert into public.categories(id, business_id, name) values ('11111111-0000-0000-0000-000000000001', v_biz, 'Coffee');
  insert into public.ingredients(id, business_id, name, category_id, base_unit, reorder_level) values
    ('22222222-0000-0000-0000-000000000001', v_biz, 'Espresso beans', '11111111-0000-0000-0000-000000000001', 'g', 100),
    ('22222222-0000-0000-0000-000000000002', v_biz, 'Milk', '11111111-0000-0000-0000-000000000001', 'ml', 1000);
  insert into public.recipes(id, business_id, name, recipe_type, category, selling_price, modifier_groups, description) values
    ('33333333-0000-0000-0000-000000000001', v_biz, 'Iced Latte', 'DRINKS', 'Iced', 150,
     '[{"id":"g-size","name":"Size","required":true,"multi_select":false,"options":[{"id":"o-12","label":"12oz","price_delta":0},{"id":"o-16","label":"16oz","price_delta":20,"ingredient_id":"22222222-0000-0000-0000-000000000002","ingredient_qty_delta":60}]},{"id":"g-add","name":"Add-ons","required":false,"multi_select":true,"options":[{"id":"o-shot","label":"Extra shot","price_delta":30,"ingredient_id":"22222222-0000-0000-0000-000000000001","ingredient_qty_delta":18}]}]',
     'Double shot over milk and ice.'),
    ('33333333-0000-0000-0000-000000000003', v_biz, 'Americano', 'DRINKS', 'Hot', 110, '[]', null),
    ('33333333-0000-0000-0000-000000000004', v_biz, 'Ensaymada', 'PASTRY', null, 65, '[]', 'Buttery brioche with cheese.');
  insert into public.recipe_ingredients(id, business_id, recipe_id, ingredient_id, quantity, unit) values
    ('44444444-0000-0000-0000-000000000001', v_biz, '33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 18, 'g'),
    ('44444444-0000-0000-0000-000000000002', v_biz, '33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 180, 'ml'),
    ('44444444-0000-0000-0000-000000000003', v_biz, '33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000001', 18, 'g');
  insert into public.purchases(id, business_id, ingredient_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit) values
    ('45454545-0000-0000-0000-000000000001', v_biz, '22222222-0000-0000-0000-000000000001', '2026-10-01', 1, 'kg', 1000, 900, 0.9),
    ('45454545-0000-0000-0000-000000000002', v_biz, '22222222-0000-0000-0000-000000000002', '2026-10-01', 5, 'L', 5000, 500, 0.1);
  insert into public.inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date) values
    ('55555555-0000-0000-0000-000000000001', v_biz, '22222222-0000-0000-0000-000000000001', 'PURCHASE', 1000, '45454545-0000-0000-0000-000000000001', '2026-10-01'),
    ('55555555-0000-0000-0000-000000000002', v_biz, '22222222-0000-0000-0000-000000000002', 'PURCHASE', 5000, '45454545-0000-0000-0000-000000000002', '2026-10-01');
  insert into public.staff(id, business_id, name, role) values
    ('66666666-0000-0000-0000-000000000001', v_biz, 'Cathy Cashier', 'CASHIER'),
    ('66666666-0000-0000-0000-000000000002', v_biz, 'Manny Manager', 'MANAGER');
  insert into public.staff_pins(staff_id, pin_hash) values
    ('66666666-0000-0000-0000-000000000001', extensions.crypt('1111', extensions.gen_salt('bf', 8))),
    ('66666666-0000-0000-0000-000000000002', extensions.crypt('2222', extensions.gen_salt('bf', 8))),
    (v_owner_staff, extensions.crypt('9999', extensions.gen_salt('bf', 8)));
  insert into public.dining_tables(id, business_id, label, kind, qr_token, sort_order) values
    ('77777777-0000-0000-0000-000000000005', v_biz, 'Table 5', 'DINE_IN', 'tabletoken5', 5);
  insert into public.device_pairing_codes(code, business_id, device_name, expires_at) values ('TESTAB', v_biz, 'Front Counter', now() + interval '1 day');
end $$;
