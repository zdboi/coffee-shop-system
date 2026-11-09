-- Seed for tests/e2e/fo_release14.e2e.js (release 1.4 counter: oat milk, cups / lids, option library groups). Applied by that test on top of tests/sql/20_seed_e2e.sql.
do $$
declare v_biz uuid;
begin
  select business_id into v_biz from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';
  insert into public.ingredients(id, business_id, name, category_id, base_unit, reorder_level) values
    ('22222222-0000-0000-0000-0000000000a1', v_biz, 'Oat milk', '11111111-0000-0000-0000-000000000001', 'ml', 500),
    ('22222222-0000-0000-0000-0000000000a2', v_biz, 'Iced cup 16oz', '11111111-0000-0000-0000-000000000001', 'pcs', 10),
    ('22222222-0000-0000-0000-0000000000a3', v_biz, 'Iced lid', '11111111-0000-0000-0000-000000000001', 'pcs', 10);
  insert into public.purchases(id, business_id, ingredient_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit) values
    ('45454545-0000-0000-0000-0000000000a1', v_biz, '22222222-0000-0000-0000-0000000000a1', '2026-10-01', 1, 'L', 1000, 200, 0.2),
    ('45454545-0000-0000-0000-0000000000a2', v_biz, '22222222-0000-0000-0000-0000000000a2', '2026-10-01', 50, 'pcs', 50, 250, 5),
    ('45454545-0000-0000-0000-0000000000a3', v_biz, '22222222-0000-0000-0000-0000000000a3', '2026-10-01', 50, 'pcs', 50, 100, 2);
  insert into public.inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date) values
    ('55555555-0000-0000-0000-0000000000a1', v_biz, '22222222-0000-0000-0000-0000000000a1', 'PURCHASE', 1000, '45454545-0000-0000-0000-0000000000a1', '2026-10-01'),
    ('55555555-0000-0000-0000-0000000000a2', v_biz, '22222222-0000-0000-0000-0000000000a2', 'PURCHASE', 50, '45454545-0000-0000-0000-0000000000a2', '2026-10-01'),
    ('55555555-0000-0000-0000-0000000000a3', v_biz, '22222222-0000-0000-0000-0000000000a3', 'PURCHASE', 50, '45454545-0000-0000-0000-0000000000a3', '2026-10-01');
  insert into public.option_groups(id, business_id, name, required, multi_select, options, applies_to, sort_order) values
    ('88888888-0000-0000-0000-000000000001', v_biz, 'Hot / Iced', true, false,
     '[{"id":"hot","label":"Hot","price_delta":0,"kind":"PLAIN"},{"id":"iced","label":"Iced","price_delta":10,"kind":"EXTRA","extras":[{"ingredient_id":"22222222-0000-0000-0000-0000000000a2","quantity":1},{"ingredient_id":"22222222-0000-0000-0000-0000000000a3","quantity":1}]}]',
     '{"recipe_types":["DRINKS"]}', 1),
    ('88888888-0000-0000-0000-000000000002', v_biz, 'Milk', false, false,
     '[{"id":"oat","label":"Oat milk","price_delta":30,"kind":"SWAP","swap_from_ingredient_id":"22222222-0000-0000-0000-000000000002","swap_to_ingredient_id":"22222222-0000-0000-0000-0000000000a1"}]',
     '{"recipe_types":["DRINKS"]}', 2);
  -- Americano is not served iced here: untick Hot / Iced on it
  insert into public.option_group_recipes(business_id, group_id, recipe_id, mode) values
    (v_biz, '88888888-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003', 'EXCLUDE');
end $$;
