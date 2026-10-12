-- Demo shop for the prototype screenshots (lead's own database db_lead only; never the real project).
-- Runs after tests/e2e_reset.sh db_lead. Adds a fuller menu, stock, tables, customers and
-- two weeks of sales history so the Back Office screens look like a real shop.
\set QUIET on
\set ON_ERROR_STOP on
do $$
declare
  v_biz uuid; v_today date := (now() at time zone 'Asia/Manila')::date;
  v_day date; v_shift uuid; v_sale uuid; v_n int; v_lines int; v_seq int := 0;
  v_t timestamptz; v_hour numeric; v_r record; v_sub numeric; v_disc numeric; v_total numeric;
  v_method text; v_pick numeric; v_qty int; v_unit numeric; v_mods jsonb; v_cust uuid; v_src text;
  v_open timestamptz; v_close timestamptz; v_cash numeric; v_noncash numeric; v_count int;
  v_menu uuid[] := array['33333333-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000005',
    '33333333-0000-0000-0000-000000000006','33333333-0000-0000-0000-000000000003','33333333-0000-0000-0000-000000000007',
    '33333333-0000-0000-0000-000000000008','33333333-0000-0000-0000-000000000009','33333333-0000-0000-0000-000000000010',
    '33333333-0000-0000-0000-000000000004','33333333-0000-0000-0000-000000000011','33333333-0000-0000-0000-000000000012']::uuid[];
  v_weight numeric[] := array[18, 14, 10, 9, 7, 5, 8, 4, 9, 8, 6];
  v_custs uuid[] := array['88888888-0000-0000-0000-000000000001','88888888-0000-0000-0000-000000000002',
    '88888888-0000-0000-0000-000000000003','88888888-0000-0000-0000-000000000004','88888888-0000-0000-0000-000000000005']::uuid[];
  v_rid uuid; v_acc numeric; v_tot_w numeric;
  SIZE jsonb := '{"id":"g-size","name":"Size","required":true,"multi_select":false,"options":[{"id":"o-12","label":"12oz","price_delta":0},{"id":"o-16","label":"16oz","price_delta":20,"ingredient_id":"22222222-0000-0000-0000-000000000002","ingredient_qty_delta":60}]}';
  MILK jsonb := '{"id":"g-milk","name":"Milk","required":false,"multi_select":false,"options":[{"id":"o-oat","label":"Oat milk","price_delta":25,"ingredient_id":"22222222-0000-0000-0000-000000000003","ingredient_qty_delta":180}]}';
  ADDS jsonb := '{"id":"g-add","name":"Add-ons","required":false,"multi_select":true,"options":[{"id":"o-shot","label":"Extra shot","price_delta":30,"ingredient_id":"22222222-0000-0000-0000-000000000001","ingredient_qty_delta":18},{"id":"o-van","label":"Vanilla syrup","price_delta":20,"ingredient_id":"22222222-0000-0000-0000-000000000011","ingredient_qty_delta":15}]}';
begin
  perform setseed(0.42);
  select business_id into v_biz from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';

  -- categories, suppliers, ingredients
  insert into public.categories(id, business_id, name) values
    ('11111111-0000-0000-0000-000000000002', v_biz, 'Dairy'),
    ('11111111-0000-0000-0000-000000000003', v_biz, 'Bakery'),
    ('11111111-0000-0000-0000-000000000004', v_biz, 'Syrups & sauces');
  insert into public.suppliers(id, business_id, name, contact, phone, notes) values
    ('99999999-0000-0000-0000-000000000001', v_biz, 'Batangas Barako Roasters', 'Lito', '0917 555 0101', 'Delivers Tuesdays'),
    ('99999999-0000-0000-0000-000000000002', v_biz, 'Cavite Dairy Co-op', 'Ana', '0918 555 0202', null),
    ('99999999-0000-0000-0000-000000000003', v_biz, 'Panaderia San Roque', 'Mang Ben', '0919 555 0303', 'Daily 6am');
  update public.ingredients set supplier_id = '99999999-0000-0000-0000-000000000001', reorder_level = 1500 where id = '22222222-0000-0000-0000-000000000001';
  update public.ingredients set supplier_id = '99999999-0000-0000-0000-000000000002', category_id = '11111111-0000-0000-0000-000000000002', reorder_level = 4000 where id = '22222222-0000-0000-0000-000000000002';
  insert into public.ingredients(id, business_id, name, category_id, supplier_id, base_unit, reorder_level) values
    ('22222222-0000-0000-0000-000000000003', v_biz, 'Oat milk', '11111111-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000002', 'ml', 2000),
    ('22222222-0000-0000-0000-000000000004', v_biz, 'Condensed milk', '11111111-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000002', 'ml', 500),
    ('22222222-0000-0000-0000-000000000005', v_biz, 'Caramel sauce', '11111111-0000-0000-0000-000000000004', null, 'ml', 300),
    ('22222222-0000-0000-0000-000000000006', v_biz, 'Matcha powder', '11111111-0000-0000-0000-000000000001', null, 'g', 100),
    ('22222222-0000-0000-0000-000000000007', v_biz, 'Tablea (cacao)', '11111111-0000-0000-0000-000000000001', null, 'g', 300),
    ('22222222-0000-0000-0000-000000000008', v_biz, 'Ensaymada', '11111111-0000-0000-0000-000000000003', '99999999-0000-0000-0000-000000000003', 'pc', 6),
    ('22222222-0000-0000-0000-000000000009', v_biz, 'Ube cheese pandesal', '11111111-0000-0000-0000-000000000003', '99999999-0000-0000-0000-000000000003', 'pc', 10),
    ('22222222-0000-0000-0000-000000000010', v_biz, 'Banana bread (slice)', '11111111-0000-0000-0000-000000000003', '99999999-0000-0000-0000-000000000003', 'pc', 50),
    ('22222222-0000-0000-0000-000000000011', v_biz, 'Vanilla syrup', '11111111-0000-0000-0000-000000000004', null, 'ml', 250);

  -- purchases + stock (two buys of beans and milk at different prices so costing has a history)
  for v_r in select * from (values
      ('22222222-0000-0000-0000-000000000001', 10, 'kg', 10000, 9500, '99999999-0000-0000-0000-000000000001'),
      ('22222222-0000-0000-0000-000000000002', 130, 'L', 130000, 13650, '99999999-0000-0000-0000-000000000002'),
      ('22222222-0000-0000-0000-000000000003', 1.5, 'L', 1500, 285, '99999999-0000-0000-0000-000000000002'),
      ('22222222-0000-0000-0000-000000000004', 6, 'L', 6000, 1140, '99999999-0000-0000-0000-000000000002'),
      ('22222222-0000-0000-0000-000000000005', 2, 'L', 2000, 900, null),
      ('22222222-0000-0000-0000-000000000006', 1, 'kg', 1000, 1800, null),
      ('22222222-0000-0000-0000-000000000007', 3, 'kg', 3000, 1650, null),
      ('22222222-0000-0000-0000-000000000008', 120, 'pc', 120, 3600, '99999999-0000-0000-0000-000000000003'),
      ('22222222-0000-0000-0000-000000000009', 200, 'pc', 200, 3000, '99999999-0000-0000-0000-000000000003'),
      ('22222222-0000-0000-0000-000000000010', 80, 'pc', 80, 2400, '99999999-0000-0000-0000-000000000003'),
      ('22222222-0000-0000-0000-000000000011', 2, 'L', 2000, 760, null)
    ) as t(ing, qty, unit, base, price, sup) loop
    v_rid := gen_random_uuid();
    insert into public.purchases(id, business_id, ingredient_id, supplier_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit)
      values (v_rid, v_biz, v_r.ing::uuid, v_r.sup::uuid, v_today - 15, v_r.qty, v_r.unit, v_r.base, v_r.price, round(v_r.price / v_r.base, 4));
    insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date)
      values (v_biz, v_r.ing::uuid, 'PURCHASE', v_r.base, v_rid::text, v_today - 15);
  end loop;

  -- menu
  update public.recipes set category = 'Iced coffee', modifier_groups = jsonb_build_array(SIZE, MILK, ADDS), sort_order = 1,
    description = 'Double shot of Batangas barako over cold milk and ice.' where id = '33333333-0000-0000-0000-000000000001';
  update public.recipes set category = 'Hot coffee', sort_order = 10, modifier_groups = jsonb_build_array(SIZE, ADDS),
    description = 'Two shots and hot water. Strong and clean.' where id = '33333333-0000-0000-0000-000000000003';
  update public.recipes set category = 'Pastries', sort_order = 30, description = 'Soft brioche, butter, sugar and grated cheese.' where id = '33333333-0000-0000-0000-000000000004';
  insert into public.recipes(id, business_id, name, recipe_type, category, selling_price, modifier_groups, description, sort_order) values
    ('33333333-0000-0000-0000-000000000005', v_biz, 'Spanish Latte', 'DRINKS', 'Iced coffee', 165, jsonb_build_array(SIZE, MILK, ADDS), 'Espresso, milk and a little condensed milk. Our best seller.', 2),
    ('33333333-0000-0000-0000-000000000006', v_biz, 'Caramel Macchiato', 'DRINKS', 'Iced coffee', 175, jsonb_build_array(SIZE, MILK, ADDS), 'Vanilla milk, espresso on top, caramel drizzle.', 3),
    ('33333333-0000-0000-0000-000000000007', v_biz, 'Cappuccino', 'DRINKS', 'Hot coffee', 140, jsonb_build_array(SIZE, MILK, ADDS), 'Equal parts espresso, steamed milk and foam.', 11),
    ('33333333-0000-0000-0000-000000000008', v_biz, 'Flat White', 'DRINKS', 'Hot coffee', 150, jsonb_build_array(MILK, ADDS), 'Ristretto shots with silky milk.', 12),
    ('33333333-0000-0000-0000-000000000009', v_biz, 'Matcha Latte', 'DRINKS', 'Not coffee', 170, jsonb_build_array(SIZE, MILK), 'Ceremonial-grade matcha whisked with milk.', 20),
    ('33333333-0000-0000-0000-000000000010', v_biz, 'Tablea Chocolate', 'DRINKS', 'Not coffee', 130, jsonb_build_array(SIZE, MILK), 'Thick hot chocolate from Batangas tablea.', 21),
    ('33333333-0000-0000-0000-000000000011', v_biz, 'Ube Cheese Pandesal', 'PASTRY', 'Pastries', 45, '[]', 'Purple yam pandesal with a melty cheese centre.', 31),
    ('33333333-0000-0000-0000-000000000012', v_biz, 'Banana Bread', 'PASTRY', 'Pastries', 85, '[]', 'Moist, with walnuts. Served warm.', 32);
  insert into public.recipe_ingredients(business_id, recipe_id, ingredient_id, quantity, unit) values
    (v_biz, '33333333-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000008', 1, 'pc'),
    (v_biz, '33333333-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000001', 18, 'g'),
    (v_biz, '33333333-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', 150, 'ml'),
    (v_biz, '33333333-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000004', 30, 'ml'),
    (v_biz, '33333333-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000001', 18, 'g'),
    (v_biz, '33333333-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', 180, 'ml'),
    (v_biz, '33333333-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000005', 20, 'ml'),
    (v_biz, '33333333-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000011', 10, 'ml'),
    (v_biz, '33333333-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000001', 18, 'g'),
    (v_biz, '33333333-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002', 120, 'ml'),
    (v_biz, '33333333-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000001', 20, 'g'),
    (v_biz, '33333333-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', 140, 'ml'),
    (v_biz, '33333333-0000-0000-0000-000000000009', '22222222-0000-0000-0000-000000000006', 5, 'g'),
    (v_biz, '33333333-0000-0000-0000-000000000009', '22222222-0000-0000-0000-000000000002', 200, 'ml'),
    (v_biz, '33333333-0000-0000-0000-000000000010', '22222222-0000-0000-0000-000000000007', 25, 'g'),
    (v_biz, '33333333-0000-0000-0000-000000000010', '22222222-0000-0000-0000-000000000002', 200, 'ml'),
    (v_biz, '33333333-0000-0000-0000-000000000011', '22222222-0000-0000-0000-000000000009', 1, 'pc'),
    (v_biz, '33333333-0000-0000-0000-000000000012', '22222222-0000-0000-0000-000000000010', 1, 'pc');

  -- tables
  insert into public.dining_tables(business_id, label, kind, qr_token, sort_order)
    select v_biz, 'Table ' || i, 'DINE_IN', 'demo-table-' || i, i from generate_series(1, 6) i where i <> 5;
  if not exists (select 1 from public.dining_tables where business_id = v_biz and kind = 'TAKEAWAY') then
    insert into public.dining_tables(business_id, label, kind, qr_token, sort_order) values (v_biz, 'Takeaway', 'TAKEAWAY', 'demo-takeaway', 0);
  end if;

  -- loyalty customers
  insert into public.customers(id, business_id, nickname, phone, source, consent_at, first_seen_at, notes) values
    (v_custs[1], v_biz, 'Mika', '+639171110001', 'QR', now() - interval '40 days', now() - interval '40 days', 'Oat milk always'),
    (v_custs[2], v_biz, 'Paolo', '+639182220002', 'QR', now() - interval '25 days', now() - interval '25 days', null),
    (v_custs[3], v_biz, 'Bea', '+639193330003', 'COUNTER', now() - interval '60 days', now() - interval '60 days', 'Works nearby'),
    (v_custs[4], v_biz, 'Jun', null, 'QR', null, now() - interval '12 days', null),
    (v_custs[5], v_biz, 'Carla', '+639054440005', 'QR', now() - interval '9 days', now() - interval '9 days', null);

  -- two weeks of history: one closed shift a day, Cathy at the counter
  select sum(w) into v_tot_w from unnest(v_weight) w;
  for d in reverse 13..1 loop
    v_day := v_today - d;
    v_shift := gen_random_uuid();
    v_open := (v_day + time '06:45') at time zone 'Asia/Manila';
    v_close := (v_day + time '21:15') at time zone 'Asia/Manila';
    insert into public.shifts(id, business_id, cashier_id, cashier_name, shift_number, opened_at, closed_at, status, opening_cash)
      values (v_shift, v_biz, '66666666-0000-0000-0000-000000000001', 'Cathy Cashier', 'SH-A-' || to_char(v_day, 'YYYYMMDD'), v_open, v_close, 'CLOSED', 2000);
    v_n := case when extract(isodow from v_day) in (6, 7) then 34 + floor(random() * 12) else 20 + floor(random() * 10) end;
    for s in 1..v_n loop
      v_seq := v_seq + 1;
      -- busy mornings (8-10am) and afternoons (3-5pm)
      v_pick := random();
      v_hour := case when v_pick < 0.38 then 7.5 + random() * 3 when v_pick < 0.72 then 14.5 + random() * 3 else 7 + random() * 14 end;
      v_t := (v_day + make_interval(secs => (v_hour * 3600)::double precision)) at time zone 'Asia/Manila';
      v_sale := gen_random_uuid();
      v_cust := case when random() < 0.12 then v_custs[1 + floor(random() * 5)::int] else null end;
      v_src := case when random() < 0.3 then 'QR' else 'COUNTER' end;
      v_sub := 0;
      insert into public.sales(id, business_id, shift_id, transaction_number, transaction_date, status, cashier_id, cashier_name,
          subtotal, discount_amount, tax_amount, service_charge_amount, grand_total, customer_id, source, offline, created_at)
        values (v_sale, v_biz, v_shift, 'POS-A-2026-' || lpad(v_seq::text, 6, '0'), v_t, 'COMPLETED', '66666666-0000-0000-0000-000000000001',
          'Cathy Cashier', 0, 0, 0, 0, 0, v_cust, v_src, false, v_t);
      v_lines := 1 + floor(random() * random() * 3)::int;
      for l in 1..v_lines loop
        v_pick := random() * v_tot_w; v_acc := 0; v_rid := v_menu[1];
        for i in 1..array_length(v_menu, 1) loop
          v_acc := v_acc + v_weight[i];
          if v_pick <= v_acc then v_rid := v_menu[i]; exit; end if;
        end loop;
        select selling_price, modifier_groups into v_unit, v_mods from public.recipes where id = v_rid;
        v_qty := case when random() < 0.15 then 2 else 1 end;
        v_mods := case when v_mods @> '[{"id":"g-size"}]' then
            case when random() < 0.45 then '[{"group":"Size","label":"16oz","price_delta":20,"ingredient_id":"22222222-0000-0000-0000-000000000002","ingredient_qty_delta":60}]'::jsonb
                 else '[{"group":"Size","label":"12oz","price_delta":0,"ingredient_id":null,"ingredient_qty_delta":0}]'::jsonb end
          else '[]'::jsonb end;
        if v_mods @> '[{"label":"16oz"}]' then v_unit := v_unit + 20; end if;
        insert into public.sale_items(business_id, sale_id, recipe_id, name, quantity, unit_price, modifiers, line_total, created_at)
          select v_biz, v_sale, v_rid, name, v_qty, v_unit, v_mods, v_unit * v_qty, v_t from public.recipes where id = v_rid;
        v_sub := v_sub + v_unit * v_qty;
        insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date)
          select v_biz, ri.ingredient_id, 'SALE_USAGE', -(ri.quantity * v_qty), v_sale::text, v_day from public.recipe_ingredients ri where ri.recipe_id = v_rid;
        if v_mods @> '[{"label":"16oz"}]' then
          insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date)
            values (v_biz, '22222222-0000-0000-0000-000000000002', 'SALE_USAGE', -(60 * v_qty), v_sale::text, v_day);
        end if;
      end loop;
      v_disc := case when random() < 0.06 then round(v_sub * 0.10, 2) else 0 end;
      v_total := v_sub - v_disc;
      v_pick := random();
      v_method := case when v_pick < 0.55 then 'CASH' when v_pick < 0.85 then 'GCASH' when v_pick < 0.93 then 'MAYA' else 'CARD' end;
      update public.sales set subtotal = v_sub, discount_type = case when v_disc > 0 then 'percent' end,
        discount_value = case when v_disc > 0 then 10 end, discount_amount = v_disc, grand_total = v_total,
        discount_approved_by = case when v_disc > 0 then '66666666-0000-0000-0000-000000000002'::uuid end,
        discount_approved_by_name = case when v_disc > 0 then 'Manny Manager' end
        where id = v_sale;
      insert into public.payments(business_id, sale_id, method, amount, tendered, change, status, created_at)
        values (v_biz, v_sale, v_method, v_total,
          case when v_method = 'CASH' then ceil(v_total / 100) * 100 else v_total end,
          case when v_method = 'CASH' then ceil(v_total / 100) * 100 - v_total else 0 end, 'COMPLETED', v_t);
    end loop;
    -- close the shift with the totals
    select coalesce(sum(p.amount) filter (where p.method = 'CASH'), 0), coalesce(sum(p.amount) filter (where p.method <> 'CASH'), 0), count(distinct s.id)
      into v_cash, v_noncash, v_count
      from public.sales s join public.payments p on p.sale_id = s.id where s.shift_id = v_shift;
    update public.shifts set gross_sales = v_cash + v_noncash, net_sales = v_cash + v_noncash, cash_sales = v_cash,
      card_sales = (select coalesce(sum(p.amount), 0) from public.sales s join public.payments p on p.sale_id = s.id where s.shift_id = v_shift and p.method = 'CARD'),
      other_sales = (select coalesce(sum(p.amount), 0) from public.sales s join public.payments p on p.sale_id = s.id where s.shift_id = v_shift and p.method in ('GCASH','MAYA')),
      refunds_total = 0, voids_total = 0, transaction_count = v_count,
      expected_cash = 2000 + v_cash, declared_cash = 2000 + v_cash - case when d = 4 then 20 else 0 end,
      cash_variance = - case when d = 4 then 20 else 0 end, closed_by = '66666666-0000-0000-0000-000000000001', closed_by_name = 'Cathy Cashier'
      where id = v_shift;
  end loop;

  -- two sales sold below the menu price, flagged for the owner to review
  update public.sales set needs_review = true, review_reason = 'PRICE_BELOW_MENU'
    where id in (select id from public.sales where business_id = v_biz order by transaction_date desc limit 2 offset 7);

  -- loyalty numbers from the history
  update public.customers c set visit_count = x.n, total_spent = x.spent, last_order_at = x.last, last_seen_at = x.last,
      stamps = least(x.n, 7)
    from (select customer_id, count(*) n, sum(grand_total) spent, max(transaction_date) last from public.sales where customer_id is not null group by customer_id) x
    where x.customer_id = c.id;
end $$;
