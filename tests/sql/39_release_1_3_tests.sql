-- Checks for cccc/supabase/009_release_1_3.sql (release 1.3, wave 1), ported by QA 2026-11-02.
-- Needs a database with 004..009 on which 10_behaviour_tests + 11_qr_tests have JUST run
-- (their shop, counter, staff, customers, the open shift of suite 10 and the QR takeaway table):
--   tests/reset_db.sh "" cccc
--   P="psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1"
--   $P -f tests/sql/10_behaviour_tests.sql && $P -f tests/sql/11_qr_tests.sql && $P -f tests/sql/39_release_1_3_tests.sql
-- (tests/run_all.sh does exactly this.)
-- Prints "ok  ..." / "FAIL ..." for every check and keeps going.
--   S. settings.subcategory_order (validation, bootstrap)
--   Q. QR menu: is_open / items by open shift, colours, order, recipe_type; SHOP_CLOSED
--   C. counter customers tab sort (name / recent / frequent)
--   O. OUT_OF_STOCK review flag on counter sales (and QR orders paid at the counter)
--   F. start_fresh_preview / start_fresh
--   R. security review fixes (M2, L3, L4, L6; L2 index) -- needs F to have run
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
-- one counter sale through fo_sync (Iced Latte 150 + 10% service = 165, cash 165),
-- taking p_milk ml of Milk off stock. Returns the op answer {op_id, status, message}.
create or replace function test.sale9(p_sale uuid, p_at timestamptz, p_milk numeric, p_cust uuid default null,
                                      p_qr uuid default null, p_shift uuid default null) returns jsonb language sql as $$
  select public.fo_sync('device-key-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', 'sale', 'data', jsonb_build_object(
    'sale', jsonb_build_object('id', p_sale, 'transaction_number', 'POS-T-' || left(p_sale::text, 8), 'transaction_date', p_at, 'status', 'COMPLETED',
       'cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy', 'shift_id', p_shift,
       'subtotal', 150, 'discount_amount', 0, 'tax_amount', 0, 'service_charge_amount', 15, 'grand_total', 165,
       'customer_id', p_cust, 'qr_order_id', p_qr, 'source', case when p_qr is null then 'COUNTER' else 'QR' end),
    'items', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'recipe_id', '33333333-0000-0000-0000-000000000001', 'name', 'Iced Latte',
       'quantity', 1, 'unit_price', 150, 'line_total', 150)),
    'payment', jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', 165),
    'inventory', case when p_milk > 0 then jsonb_build_array(jsonb_build_object('id', gen_random_uuid(),
       'ingredient_id', '22222222-0000-0000-0000-000000000002', 'quantity', p_milk, 'transaction_date', (p_at at time zone 'Asia/Manila')::date))
       else '[]'::jsonb end))))->0
$$;
grant execute on all functions in schema test to anon, authenticated;
\set ON_ERROR_STOP on

select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select business_id as biz2 from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset
select qr_token as tok from dining_tables where business_id = :'biz' and kind = 'TAKEAWAY' limit 1 \gset

-- re-pair the counter (suite 11 removed it at its end) and sign in the cashier online
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select (public.create_device_pairing_code('Front Counter'))->>'code' as paircode \gset
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select (public.redeem_device_pairing(:'paircode', 'device-key-0001-abcdef', 'Front Counter')->'device'->>'active') as x \gset
select (public.staff_pin_login('1111'))->>'token' as cashier_token \gset
reset role;
delete from auth_attempts;

-- ======================= S. sub-category order =======================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk((select subcategory_order from settings where business_id = :'biz') = '[]'::jsonb, 'S: default is an empty list');
select test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":["Iced","Hot","Pastry"]}}]')$$) as e \gset
select test.chk(:'e' = 'NO ERROR' and (select subcategory_order from settings where business_id = :'biz') = '["Iced","Hot","Pastry"]'::jsonb, 'S: owner saves an order through apply_changes update', :'e');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":["Iced"," iced "]}}]')$$) = 'BAD_SUBCATEGORY_ORDER', 'S: duplicate ignoring case / spaces refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":["   "]}}]')$$) = 'BAD_SUBCATEGORY_ORDER', 'S: empty name refused');
select test.chk(test.err(format($$select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":["%s"]}}]')$$, repeat('x', 41))) = 'BAD_SUBCATEGORY_ORDER', 'S: 41-char name refused');
select test.chk(test.err(format($$select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":["%s"]}}]')$$, repeat('x', 40))) = 'NO ERROR', 'S: 40-char name fine');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":{"Iced":1}}}]')$$) = 'BAD_SUBCATEGORY_ORDER', 'S: object refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":[1,2]}}]')$$) = 'BAD_SUBCATEGORY_ORDER', 'S: numbers refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":null}}]')$$) <> 'NO ERROR', 'S: null refused');
select test.chk(test.err(format($$select public.apply_changes(%L::jsonb)$$, jsonb_build_array(jsonb_build_object('op','update','table','settings','row',
  jsonb_build_object('subcategory_order', (select jsonb_agg('c' || g) from generate_series(1, 101) g)))))) = 'BAD_SUBCATEGORY_ORDER', 'S: 101 names refused');
select test.chk(test.err(format($$select public.apply_changes(%L::jsonb)$$, jsonb_build_array(jsonb_build_object('op','update','table','settings','row',
  jsonb_build_object('subcategory_order', (select jsonb_agg('c' || g) from generate_series(1, 100) g)))))) = 'NO ERROR', 'S: 100 names fine');
select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":["Iced","Hot"],"subcategory_colors":{"Iced":"olive"}}}]');
select test.chk(test.err($$update settings set subcategory_order = '["a","A"]' where business_id = current_business_id()$$) = 'BAD_SUBCATEGORY_ORDER', 'S: owner direct update also validated');
select test.chk(public.bo_bootstrap()->'settings'->'subcategory_order' = '["Iced","Hot"]'::jsonb, 'S: bo_bootstrap settings has subcategory_order');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(public.fo_bootstrap('device-key-0001-abcdef')->'settings'->'subcategory_order' = '["Iced","Hot"]'::jsonb, 'S: fo_bootstrap settings has subcategory_order');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"subcategory_order":["X"]}}]')$$) = 'ADMIN_ONLY', 'S: counter cannot change it');
reset role;

-- ======================= Q. QR menu + shop open =======================
select test.chk(public._shop_is_open(:'biz') and (select count(*) from shifts where business_id = :'biz' and status = 'ACTIVE') >= 1, 'Q: suite 10 left an open shift -> open');
set role anon;
select public.get_qr_menu(:'tok') as m \gset
reset role;
select test.chk((:'m'::jsonb->>'is_open')::boolean and jsonb_array_length(:'m'::jsonb->'items') >= 1, 'Q: open -> is_open true, items listed');
select test.chk(:'m'::jsonb->'subcategory_order' = '["Iced","Hot"]'::jsonb and :'m'::jsonb->'subcategory_colors' = '{"Iced":"olive"}'::jsonb, 'Q: menu has subcategory_order + subcategory_colors');
select test.chk(exists (select 1 from jsonb_array_elements(:'m'::jsonb->'items') i
                        where i->>'id' = '33333333-0000-0000-0000-000000000001' and i->>'recipe_type' = 'DRINKS' and i->>'subcategory' = 'Iced' and i->>'category' = 'Iced'),
  'Q: item has recipe_type, subcategory and category', :'m'::jsonb->>'items');
-- close every shift of the shop (as if the last counter closed)
create temp table q_open as select id from shifts where business_id = :'biz' and status = 'ACTIVE';
update shifts set status = 'CLOSED', closed_at = now() where id in (select id from q_open);
set role anon;
select public.get_qr_menu(:'tok') as m \gset
reset role;
select test.chk(not (:'m'::jsonb->>'is_open')::boolean and :'m'::jsonb->'items' = '[]'::jsonb, 'Q: no open shift -> is_open false, NO items');
select test.chk(:'m'::jsonb ?& array['business','theme','table','loyalty_enabled','loyalty_rewards','subcategory_colors','subcategory_order','ordering_enabled'],
  'Q: closed menu still has shop, look and stamp card settings');
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select test.chk(public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-large"}]}]')->>'error' = 'SHOP_CLOSED', 'Q: qr_place_order -> SHOP_CLOSED');
select test.chk(public.qr_session(:'tok')->'customer' ? 'card', 'Q: stamp card (qr_session) still works when closed');
reset role;
select test.login(null); set role anon;
select test.chk(public.qr_place_order(:'tok', '[]')->>'error' = 'NOT_SIGNED_IN', 'Q: not signed in still answered first');
reset role;
update settings set qr_ordering_enabled = false where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select test.chk(public.qr_place_order(:'tok', '[]')->>'error' = 'ORDERING_OFF', 'Q: manual switch off -> ORDERING_OFF (before SHOP_CLOSED)');
reset role;
update settings set qr_ordering_enabled = true where business_id = :'biz';
-- another shop's open shift does not open ours
insert into shifts(id, business_id, status, opened_at) values ('88888888-0000-0000-0000-0000000009b2', :'biz2', 'ACTIVE', now());
select test.chk(not public._shop_is_open(:'biz') and public._shop_is_open(:'biz2'), 'Q: open shift of another shop does not open ours');
delete from shifts where id = '88888888-0000-0000-0000-0000000009b2';
update shifts set status = 'ACTIVE', closed_at = null where id in (select id from q_open);
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-large"}]}]') as o \gset
reset role;
select test.chk(:'o'::jsonb ? 'order' or :'o'::jsonb->>'error' in ('TOO_MANY_OPEN_ORDERS','OPTION_REQUIRED','BAD_OPTION'), 'Q: shift open again -> ordering works (no SHOP_CLOSED)', :'o');
select test.chk(coalesce(:'o'::jsonb->>'error', '') <> 'SHOP_CLOSED', 'Q: not SHOP_CLOSED once open');

-- ======================= C. customers tab sort =======================
insert into customers(id, business_id, nickname, phone, source, visit_count, last_order_at, last_seen_at) values
  ('c9000000-0000-0000-0000-000000000001', :'biz', 'Srt bravo',   '+639170000001', 'COUNTER', 5, now() - interval '3 days', now() - interval '3 days'),
  ('c9000000-0000-0000-0000-000000000002', :'biz', 'srt Alpha',   '+639170000002', 'COUNTER', 1, now(),                     now()),
  ('c9000000-0000-0000-0000-000000000003', :'biz', 'Srt charlie', '+639170000003', 'COUNTER', 5, now() - interval '1 day',  now() - interval '1 day');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk((select string_agg(c->>'nickname', ',' order by o) from jsonb_array_elements(public.fo_customer_list('srt', 10, null, 'name')->'customers') with ordinality x(c, o))
                = 'srt Alpha,Srt bravo,Srt charlie', 'C: name = A to Z, case ignored',
                (select string_agg(c->>'nickname', ',' order by o) from jsonb_array_elements(public.fo_customer_list('srt', 10, null, 'name')->'customers') with ordinality x(c, o)));
select test.chk((select string_agg(c->>'nickname', ',' order by o) from jsonb_array_elements(public.fo_customer_list('srt', 10, null, 'recent')->'customers') with ordinality x(c, o))
                = 'srt Alpha,Srt charlie,Srt bravo', 'C: recent = last visit first');
select test.chk((select string_agg(c->>'nickname', ',' order by o) from jsonb_array_elements(public.fo_customer_list('srt', 10, null, 'frequent')->'customers') with ordinality x(c, o))
                = 'Srt charlie,Srt bravo,srt Alpha', 'C: frequent = most visits, then last visit');
select test.chk((select string_agg(c->>'nickname', ',' order by o) from jsonb_array_elements(public.fo_customer_list('srt', 10, null, 'bogus')->'customers') with ordinality x(c, o))
                = 'srt Alpha,Srt charlie,Srt bravo' and public.fo_customer_list('srt', 10, null, 'bogus')->>'sort' = 'recent', 'C: unknown sort -> recent');
select test.chk((select string_agg(c->>'nickname', ',' order by o) from jsonb_array_elements(public.fo_customer_list(p_search => 'srt', p_limit => 10, p_staff_token => null)->'customers') with ordinality x(c, o))
                = 'srt Alpha,Srt charlie,Srt bravo', 'C: old call with the 3 named params still works (recent)');
select test.chk(jsonb_array_length(public.fo_customer_list('srt', 2, null, 'name')->'customers') = 2
            and (public.fo_customer_list('srt', 1, null, 'frequent')->'customers'->0->>'nickname') = 'Srt charlie', 'C: limit applies after sorting');
select test.chk(public.fo_customer_list('srt', 10, null, 'name')::text not like '%+6391700%'
            and public.fo_customer_list('srt', 10, null, 'name')->'customers'->0->>'phone' like '0917 ••• %'
            and not (public.fo_customer_list('srt', 10, null, 'name')->'customers'->0 ? 'total_spent'), 'C: phones masked, no money without a manager token');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.fo_customer_list('', 10, null, 'name')$$) = 'NOT_ALLOWED', 'C: owner login still refused (counters only)');
reset role;
set role anon;
select test.chk(test.err($$select public.fo_customer_list('', 10, null, 'name')$$) like 'permission denied%', 'C: anon cannot call it');
reset role;
select test.chk((select count(*) from pg_proc where proname = 'fo_customer_list' and pronamespace = 'public'::regnamespace) = 1, 'C: only one fo_customer_list (no ambiguous overloads)');
delete from auth_attempts;

-- ======================= O. OUT_OF_STOCK =======================
select coalesce((select stock from v_ingredient_stock where business_id = :'biz' and ingredient_id = '22222222-0000-0000-0000-000000000002'), 0) as milk0 \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale9('99999999-0000-0000-0000-0000000009a1', now(), 180) as r \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'ok' and coalesce((select review_reason from sales where id = '99999999-0000-0000-0000-0000000009a1'), '') not like '%OUT_OF_STOCK%',
  'O: enough milk -> ok, no OUT_OF_STOCK', :'r'::text || ' / ' || coalesce((select review_reason from sales where id = '99999999-0000-0000-0000-0000000009a1'), '-'));
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale9('99999999-0000-0000-0000-0000000009a2', now(), (:'milk0'::numeric - 180) + 50) as r \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'ok' and (select needs_review and review_reason like '%OUT_OF_STOCK%' and status = 'COMPLETED' from sales where id = '99999999-0000-0000-0000-0000000009a2'),
  'O: sale taking milk 50 below 0 -> saved (ok) but needs_review OUT_OF_STOCK', :'r'::text || ' / ' || coalesce((select review_reason from sales where id = '99999999-0000-0000-0000-0000000009a2'), '-'));
select test.chk((select stock from v_ingredient_stock where business_id = :'biz' and ingredient_id = '22222222-0000-0000-0000-000000000002') = -50, 'O: stock really is -50 (stock lines written)');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale9('99999999-0000-0000-0000-0000000009a3', now(), 0) as r \gset
reset role;
select test.chk(coalesce((select review_reason from sales where id = '99999999-0000-0000-0000-0000000009a3'), '') not like '%OUT_OF_STOCK%', 'O: sale without stock lines -> no flag');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale9('99999999-0000-0000-0000-0000000009a4', now(), 1) as r \gset
reset role;
select test.chk((select review_reason like '%OUT_OF_STOCK%' from sales where id = '99999999-0000-0000-0000-0000000009a4'), 'O: milk already below 0 and used again -> flagged');
-- a QR order paid at the counter goes through the same sale path
insert into qr_orders(id, business_id, order_number, order_day, status, items, subtotal, total)
  values ('a9000000-0000-0000-0000-000000000001', :'biz', 'Q-901', current_date, 'PENDING', '[]', 150, 165);
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale9('99999999-0000-0000-0000-0000000009a5', now(), 10, null, 'a9000000-0000-0000-0000-000000000001') as r \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'ok' and (select review_reason like '%OUT_OF_STOCK%' from sales where id = '99999999-0000-0000-0000-0000000009a5')
            and (select sale_id from qr_orders where id = 'a9000000-0000-0000-0000-000000000001') = '99999999-0000-0000-0000-0000000009a5',
  'O: QR order paid at the counter with too little stock -> paid, flagged OUT_OF_STOCK', :'r');
-- the same sale sent again is still just skipped
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.sale9('99999999-0000-0000-0000-0000000009a2', now(), 99999)->>'status' = 'skipped', 'O: re-sent sale -> skipped');
reset role;
-- an owner-cleared review stays cleared, and the flag doesn't stop stamps
select test.chk(not (coalesce((select review_reason from sales where id = '99999999-0000-0000-0000-0000000009a2'), '') ~ '(PRICE_BELOW_MENU|NOT_ON_MENU|PAYMENT_MISMATCH)'),
  'O: OUT_OF_STOCK is not one of the reasons that hold back stamps');
-- put the milk back to positive for the next part
insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, transaction_date)
  values ('cc900000-0000-0000-0000-000000000001', :'biz', '22222222-0000-0000-0000-000000000002', 'PURCHASE', 10000, current_date - 30);

-- ======================= F. START FRESH =======================
-- data: old sales dated 2 days ago (removed), one sale dated in 30 min (kept) with its old shift
select id as zed from customers where nickname = 'Zed' and business_id = :'biz' \gset
-- move all of today's test sales / shifts / pay-ins / QR orders 2 days back (as old test data)
update sales set transaction_date = transaction_date - interval '2 days', created_at = created_at - interval '2 days' where business_id = :'biz';
update refunds set date = date - interval '2 days', created_at = created_at - interval '2 days' where business_id = :'biz';
update cash_movements set at = at - interval '2 days', created_at = created_at - interval '2 days' where business_id = :'biz';
update shifts set opened_at = opened_at - interval '2 days', created_at = created_at - interval '2 days' where business_id = :'biz';
update qr_orders set created_at = created_at - interval '2 days' where business_id = :'biz';
update inventory_transactions set transaction_date = transaction_date - 2 where business_id = :'biz' and transaction_type in ('SALE_USAGE','SALE_REVERSAL');
-- a reward used on an old sale (removed with it)
insert into loyalty_redemptions(business_id, customer_id, card_no, milestone, reward_type, sale_id, amount)
  values (:'biz', :'zed', 1, 5, 'AMOUNT_OFF', '99999999-0000-0000-0000-0000000009a1', 10);
update sales set customer_id = :'zed' where id = '99999999-0000-0000-0000-0000000009a3';
-- the KEPT sale: in 30 minutes, in an old CLOSED shift (so that shift is kept), with milk 100 and a partial refund dated before the cut
insert into shifts(id, business_id, status, opened_at, closed_at) values ('88888888-0000-0000-0000-0000000009f1', :'biz', 'CLOSED', now() - interval '3 days', now() - interval '3 days');
insert into sales(id, business_id, shift_id, transaction_number, transaction_date, status, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total, customer_id)
  values ('99999999-0000-0000-0000-0000000009f1', :'biz', '88888888-0000-0000-0000-0000000009f1', 'KEEP-1', now() + interval '30 minutes', 'PARTIALLY_REFUNDED', 150, 0, 0, 15, 165, :'zed');
insert into sale_items(id, business_id, sale_id, recipe_id, name, quantity, unit_price, line_total)
  values ('59000000-0000-0000-0000-0000000009f1', :'biz', '99999999-0000-0000-0000-0000000009f1', '33333333-0000-0000-0000-000000000001', 'Iced Latte', 1, 150, 150);
insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date)
  values ('cc900000-0000-0000-0000-0000000009f1', :'biz', '22222222-0000-0000-0000-000000000002', 'SALE_USAGE', 100, '99999999-0000-0000-0000-0000000009f1', current_date);
insert into refunds(id, business_id, sale_id, shift_id, type, amount, date)
  values ('dd900000-0000-0000-0000-0000000009f1', :'biz', '99999999-0000-0000-0000-0000000009f1', '88888888-0000-0000-0000-0000000009f1', 'PARTIAL_REFUND', 10, now() - interval '3 days');
insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date)
  values ('cc900000-0000-0000-0000-0000000009f2', :'biz', '22222222-0000-0000-0000-000000000002', 'SALE_REVERSAL', 40, 'dd900000-0000-0000-0000-0000000009f1', current_date - 3);
-- a QR order paid by the kept sale (kept), an old pending QR order (removed), an old counter for a day with no orders left
insert into qr_orders(id, business_id, order_number, order_day, status, items, subtotal, total, sale_id, created_at)
  values ('a9000000-0000-0000-0000-0000000009f1', :'biz', 'Q-902', current_date - 3, 'COMPLETED', '[]', 150, 165, '99999999-0000-0000-0000-0000000009f1', now() - interval '3 days'),
         ('a9000000-0000-0000-0000-0000000009f2', :'biz', 'Q-903', current_date - 4, 'PENDING', '[]', 150, 165, null, now() - interval '4 days');
insert into qr_order_counters(business_id, day, last_no) values (:'biz', current_date - 10, 7) on conflict do nothing;
-- an old pay-in in a removable shift
insert into shifts(id, business_id, status, opened_at, closed_at) values ('88888888-0000-0000-0000-0000000009f2', :'biz', 'CLOSED', now() - interval '5 days', now() - interval '5 days');
insert into cash_movements(id, business_id, shift_id, type, amount, at) values ('ca900000-0000-0000-0000-0000000009f2', :'biz', '88888888-0000-0000-0000-0000000009f2', 'PAY_IN', 100, now() - interval '5 days');
-- other shop: an old sale that must stay
insert into sales(id, business_id, transaction_number, transaction_date, status, subtotal, grand_total) values ('99999999-0000-0000-0000-0000000009b2', :'biz2', 'OTHER-1', now() - interval '5 days', 'COMPLETED', 10, 10);

-- expected stock after = every stock line that is NOT a sale / refund line of a removed sale = all lines minus removed ones
select (select coalesce(sum(case when transaction_type = 'ADJUSTMENT' then quantity
                                 when transaction_type in ('PURCHASE','INITIAL_STOCK','PRODUCTION','SALE_REVERSAL') then abs(quantity) else -abs(quantity) end), 0)
        from inventory_transactions t where business_id = :'biz' and ingredient_id = '22222222-0000-0000-0000-000000000002'
          and not (transaction_type in ('SALE_USAGE','SALE_REVERSAL') and coalesce(reference_id, '') not in ('99999999-0000-0000-0000-0000000009f1','dd900000-0000-0000-0000-0000000009f1'))) as milk_expect \gset
select count(*) as n_recipes from recipes where business_id = :'biz' \gset
select count(*) as n_staff from staff where business_id = :'biz' \gset
select count(*) as n_ing from ingredients where business_id = :'biz' \gset
select count(*) as n_purch from purchases where business_id = :'biz' \gset
select count(*) as n_dev from devices where business_id = :'biz' \gset
select count(*) as n_tab from dining_tables where business_id = :'biz' \gset
select count(*) as n_cust from customers where business_id = :'biz' \gset
select count(*) as n_audit from audit_log where business_id = :'biz' \gset
select count(*) as n_sync from sync_operations where business_id = :'biz' \gset
select count(*) as n_other from sales where business_id = :'biz2' \gset
select count(*) as n_sales_old from sales where business_id = :'biz' and id <> '99999999-0000-0000-0000-0000000009f1' \gset
select count(*) as n_items_old from sale_items si join sales s on s.id = si.sale_id where s.business_id = :'biz' and s.id <> '99999999-0000-0000-0000-0000000009f1' \gset
select count(*) as n_cash_old from cash_movements where business_id = :'biz' \gset

-- who may call it
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.start_fresh_preview(now())$$) = 'NOT_ALLOWED' and test.err($$select public.start_fresh(now(), 'START FRESH')$$) = 'NOT_ALLOWED', 'F: paired counter refused (NOT_ALLOWED)');
select test.chk((select count(*) from start_fresh_runs) = 0, 'F: counter reads no start_fresh_runs');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1', :'cashier_token'); set role authenticated;
select test.chk(test.err($$select public.start_fresh(now(), 'START FRESH')$$) = 'NOT_ALLOWED', 'F: counter with a signed-in staff token still refused');
reset role;
select test.login('00000000-0000-0000-0000-0000000000c1'); set role authenticated;
select test.chk(test.err($$select public.start_fresh_preview(now())$$) in ('NOT_A_MEMBER','NOT_ALLOWED'), 'F: QR customer refused');
reset role;
set role anon;
select test.chk(test.err($$select public.start_fresh_preview(now())$$) like 'permission denied%' and test.err($$select public.start_fresh(now(), 'START FRESH')$$) like 'permission denied%', 'F: anon cannot call it');
reset role;
-- an old-style MANAGER email login of our shop
select test.login(null);
insert into auth.users(id, email) values ('00000000-0000-0000-0000-0000000009a9', 'mgr9@example.com') on conflict do nothing;
insert into profiles(id, business_id, name, role) values ('00000000-0000-0000-0000-0000000009a9', :'biz', 'Mgr email', 'MANAGER') on conflict (id) do update set role = 'MANAGER', business_id = excluded.business_id;
select test.login('00000000-0000-0000-0000-0000000009a9'); set role authenticated;
select test.chk(test.err($$select public.start_fresh(now(), 'START FRESH')$$) = 'NOT_ALLOWED', 'F: manager email login refused');
reset role;
delete from profiles where id = '00000000-0000-0000-0000-0000000009a9';

-- the owner
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.start_fresh_preview(now()) as pv \gset
select test.chk(not (:'pv'::jsonb->>'can_start_fresh')::boolean and (:'pv'::jsonb->>'open_shifts')::int >= 1, 'F: preview says a shift is still open', :'pv'::jsonb->>'open_shifts');
select test.chk(test.err($$select public.start_fresh(now(), 'START FRESH')$$) = 'SHIFT_STILL_OPEN', 'F: open shift -> SHIFT_STILL_OPEN');
select test.chk(test.err($$select public.start_fresh(now(), 'start fresh')$$) = 'CONFIRM_REQUIRED' and test.err($$select public.start_fresh(now(), null)$$) = 'CONFIRM_REQUIRED'
            and test.err($$select public.start_fresh(now(), 'START FRESH ')$$) = 'CONFIRM_REQUIRED', 'F: wrong / missing confirmation -> CONFIRM_REQUIRED');
select test.chk(test.err($$select public.start_fresh(now() + interval '1 day', 'START FRESH')$$) = 'BAD_DATE' and test.err($$select public.start_fresh_preview(null)$$) = 'BAD_DATE'
            and test.err($$select public.start_fresh_preview(now() + interval '1 day')$$) = 'BAD_DATE', 'F: future / missing date -> BAD_DATE');
reset role;
update shifts set status = 'CLOSED', closed_at = now() - interval '2 days' where business_id = :'biz' and status = 'ACTIVE';
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.start_fresh_preview(now()) as pv \gset
select test.chk((:'pv'::jsonb->>'can_start_fresh')::boolean, 'F: all closed -> can_start_fresh');
select test.chk((:'pv'::jsonb->'remove'->>'sales')::int = :'n_sales_old' and (:'pv'::jsonb->'remove'->>'sale_items')::int = :'n_items_old'
            and (:'pv'::jsonb->'remove'->>'cash_movements')::int = :'n_cash_old' and (:'pv'::jsonb->'remove'->>'loyalty_redemptions')::int = 1
            and (:'pv'::jsonb->'remove'->>'qr_orders')::int >= 1 and (:'pv'::jsonb->'keep'->>'sales')::int = 1,
  'F: preview counts (old sales, items, pay-ins, the reward; 1 sale kept)', :'pv'::jsonb->>'remove');
select test.chk(exists (select 1 from jsonb_array_elements(:'pv'::jsonb->'stock_changes') x
                        where x->>'ingredient_id' = '22222222-0000-0000-0000-000000000002' and (x->>'stock_after')::numeric = :'milk_expect'::numeric),
  'F: preview stock_changes: milk after = stock without the removed sales', :'pv'::jsonb->>'stock_changes');
reset role;
select test.chk((select count(*) from sales where business_id = :'biz') = :'n_sales_old'::int + 1, 'F: preview changed nothing');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.start_fresh(now(), 'START FRESH') as sf \gset
reset role;
select test.chk((:'sf'::jsonb->>'done')::boolean and :'sf'::jsonb->'removed' = :'pv'::jsonb->'remove', 'F: start_fresh removed exactly what the preview said', :'sf'::jsonb->>'removed');
select test.chk((select count(*) from sales where business_id = :'biz') = 1 and exists (select 1 from sales where id = '99999999-0000-0000-0000-0000000009f1'), 'F: only the sale after the cut is left');
select test.chk((select count(*) from refunds where business_id = :'biz') = 1 and (select count(*) from payments p join sales s on s.id = p.sale_id where s.business_id = :'biz') = 0
            and (select count(*) from sale_items where business_id = :'biz') = 1, 'F: refunds / payments / items of removed sales gone; kept sale keeps its own');
select test.chk((select count(*) from cash_movements where business_id = :'biz') = 0, 'F: old pay-ins gone');
select test.chk((select count(*) from shifts where business_id = :'biz') = 1 and exists (select 1 from shifts where id = '88888888-0000-0000-0000-0000000009f1'), 'F: old shifts gone; the kept sale''s shift stays');
select test.chk((select count(*) from qr_orders where business_id = :'biz') = 1 and exists (select 1 from qr_orders where id = 'a9000000-0000-0000-0000-0000000009f1'), 'F: old QR orders gone; the one paid by the kept sale stays');
select test.chk(not exists (select 1 from qr_order_counters k where k.business_id = :'biz'
                            and not exists (select 1 from qr_orders q where q.business_id = k.business_id and q.order_day = k.day)), 'F: QR number counters of days without orders reset');
select test.chk((select count(*) from loyalty_redemptions where business_id = :'biz') = 0, 'F: rewards used on removed sales gone');
select test.chk((select count(*) from inventory_transactions where business_id = :'biz' and transaction_type in ('SALE_USAGE','SALE_REVERSAL')) = 2, 'F: only the kept sale''s stock lines are left');
select test.chk((select stock from v_ingredient_stock where business_id = :'biz' and ingredient_id = '22222222-0000-0000-0000-000000000002') = :'milk_expect'::numeric,
  'F: milk stock = stock without the removed sales (sales put back)', (select stock::text from v_ingredient_stock where business_id = :'biz' and ingredient_id = '22222222-0000-0000-0000-000000000002'));
select test.chk((select count(*) from inventory_transactions where id = 'cc900000-0000-0000-0000-000000000001') = 1, 'F: purchase stock line kept');
select test.chk((select count(*) from recipes where business_id = :'biz') = :'n_recipes'::int and (select count(*) from staff where business_id = :'biz') = :'n_staff'::int
            and (select count(*) from ingredients where business_id = :'biz') = :'n_ing'::int and (select count(*) from purchases where business_id = :'biz') = :'n_purch'::int
            and (select count(*) from devices where business_id = :'biz') = :'n_dev'::int and (select count(*) from dining_tables where business_id = :'biz') = :'n_tab'::int
            and (select count(*) from customers where business_id = :'biz') = :'n_cust'::int and (select count(*) from sync_operations where business_id = :'biz') = :'n_sync'::int,
  'F: menu, staff, ingredients, purchases, counters, tables, customers, upload receipts untouched');
select test.chk((select count(*) from audit_log where business_id = :'biz') = :'n_audit'::int + 1
            and (select count(*) from audit_log where business_id = :'biz' and action = 'Start fresh' and details like '%"sales"%') = 1, 'F: one audit row "Start fresh" with the counts');
select test.chk((select count(*) from sales where business_id = :'biz2') = :'n_other'::int, 'F: other shop untouched');
select test.chk((select visit_count = 1 and stamps = 1 and drink_stamps = 1 and food_stamps = 0 and total_spent = 155 from customers where id = :'zed'),
  'F: Zed (kept sale): 1 visit, 1 stamp, spent 165-10', (select format('%s/%s/%s', visit_count, stamps, total_spent) from customers where id = :'zed'));
select test.chk(not exists (select 1 from customers c where c.business_id = :'biz' and c.id <> :'zed' and ((c.visit_count <> 0 and c.id::text not like 'c9000000%') or c.stamps <> 0 or c.drink_stamps <> 0 or c.food_stamps <> 0)),
  'F: everyone else: 0 stamps (and 0 visits for those whose sales were removed)');
select test.chk((select count(*) from customers c where c.business_id = :'biz' and c.id::text not like 'c9000000%' and c.id <> :'zed' and (c.total_spent <> 0 or c.last_order_at is not null)) = 0,
  'F: removed customers'' money copies reset (total_spent 0, last_order_at empty)');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk((select count(*) from start_fresh_runs) = 1, 'F: owner reads the start_fresh_runs row');
select test.chk(test.err($$insert into start_fresh_runs(business_id, before_at) values (current_business_id(), now())$$) <> 'NO ERROR'
            and test.err($$delete from start_fresh_runs$$) <> 'NO ERROR', 'F: nobody writes start_fresh_runs through the API', test.err($$delete from start_fresh_runs$$));
select test.chk(test.err($$delete from audit_log where action = 'Start fresh'$$) = 'NO ERROR' and (select count(*) from audit_log where action = 'Start fresh') = 1, 'F: audit row cannot be deleted by the owner (RLS: 0 rows)');
select public.start_fresh_preview(now()) as pv2 \gset
select test.chk((:'pv2'::jsonb->'remove'->>'sales')::int = 0 and (:'pv2'::jsonb->'stock_changes') = '[]'::jsonb, 'F: preview afterwards: nothing left to remove');
reset role;
-- the other owner's Start fresh never touches our shop
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select public.start_fresh(now(), 'START FRESH') as sf2 \gset
reset role;
select test.chk((select count(*) from sales where business_id = :'biz') = 1 and (select count(*) from sales where business_id = :'biz2') = :'n_other'::int - 1,
  'F: other owner''s Start fresh removes only their own old sale');
-- after Start fresh: a counter that was offline uploads an old sale -> saved, flagged BEFORE_START_FRESH; a new sale is not flagged
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale9('99999999-0000-0000-0000-0000000009c1', now() - interval '1 day', 10) as r \gset
select test.sale9('99999999-0000-0000-0000-0000000009c2', now() + interval '1 minute', 10) as r2 \gset
select public.fo_sync('device-key-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', 'shift_close', 'data',
  jsonb_build_object('id', gen_random_uuid(), 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now() - interval '1 day'))))->0 as r3 \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'ok' and (select needs_review and review_reason like '%BEFORE_START_FRESH%' from sales where id = '99999999-0000-0000-0000-0000000009c1'),
  'F: old sale uploaded after Start fresh -> saved, flagged BEFORE_START_FRESH', :'r');
select test.chk(:'r2'::jsonb->>'status' = 'ok' and coalesce((select review_reason from sales where id = '99999999-0000-0000-0000-0000000009c2'), '') not like '%BEFORE_START_FRESH%', 'F: new sale not flagged');
select test.chk(:'r3'::jsonb->>'status' = 'skipped', 'F: closing a shift Start fresh removed -> skipped (not an error)', :'r3');

-- ======================= R. security review fixes (M2, L3, L4, L6) =======================
-- L6: a HELD sale finished later with a date before Start fresh is flagged too
select test.login(null);
insert into sales(id, business_id, transaction_number, transaction_date, status, subtotal, grand_total, created_at)
  values ('99999999-0000-0000-0000-0000000009d1', :'biz', 'HELD-L6', now(), 'HELD', 150, 165, now());
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale9('99999999-0000-0000-0000-0000000009d1', now() - interval '1 day', 10) as r \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'ok' and (select status = 'COMPLETED' and review_reason like '%BEFORE_START_FRESH%' from sales where id = '99999999-0000-0000-0000-0000000009d1'),
  'L6: HELD sale finished with a back-dated date -> flagged BEFORE_START_FRESH', :'r');
-- M2: a sale the server received before the cut (clock ahead) and an old HELD cart dated later are removed too
insert into sales(id, business_id, transaction_number, transaction_date, status, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total, received_at)
  values ('99999999-0000-0000-0000-0000000009d2', :'biz', 'AHEAD-1', now() + interval '20 minutes', 'COMPLETED', 150, 0, 0, 15, 165, now() - interval '1 minute');
insert into sales(id, business_id, transaction_number, transaction_date, status, subtotal, grand_total, created_at)
  values ('99999999-0000-0000-0000-0000000009d3', :'biz', 'HELD-OLD', now() + interval '20 minutes', 'HELD', 150, 165, now() - interval '1 hour');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.start_fresh_preview(now()) as pv3 \gset
select public.start_fresh(now(), 'START FRESH') as sf3 \gset
reset role;
select test.chk(:'sf3'::jsonb->'removed' = :'pv3'::jsonb->'remove', 'M2: removed = preview again', :'sf3'::jsonb->>'removed');
select test.chk(not exists (select 1 from sales where id in ('99999999-0000-0000-0000-0000000009d2', '99999999-0000-0000-0000-0000000009d3')),
  'M2: sale received before the cut (clock ahead) and old HELD cart removed');
select test.chk(exists (select 1 from sales where id = '99999999-0000-0000-0000-0000000009f1'), 'M2: sale dated after the cut, never received by the server before it, kept');
-- L3: a shift open for more than 24 hours doesn't open the QR page, shows in bo_bootstrap, still blocks Start fresh
insert into shifts(id, business_id, status, opened_at, shift_number, cashier_name) values ('88888888-0000-0000-0000-0000000009e1', :'biz', 'ACTIVE', now() - interval '25 hours', 'SHIFT-OLD', 'Cathy Cashier');
select test.chk(not public._shop_is_open(:'biz'), 'L3: shift opened 25 hours ago -> shop not open');
set role anon;
select test.chk(not (public.get_qr_menu(:'tok')->>'is_open')::boolean and public.get_qr_menu(:'tok')->'items' = '[]'::jsonb, 'L3: QR menu closed');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(exists (select 1 from jsonb_array_elements(public.bo_bootstrap()->'stale_open_shifts') x
                        where x->>'id' = '88888888-0000-0000-0000-0000000009e1' and x->>'shift_number' = 'SHIFT-OLD' and x ? 'opened_at' and x ? 'device_name'),
  'L3: bo_bootstrap stale_open_shifts lists it', public.bo_bootstrap()->>'stale_open_shifts');
select test.chk(test.err($$select public.start_fresh(now(), 'START FRESH')$$) = 'SHIFT_STILL_OPEN', 'L3: an old open shift still blocks Start fresh');
reset role;
insert into shifts(id, business_id, status, opened_at) values ('88888888-0000-0000-0000-0000000009e2', :'biz', 'ACTIVE', now() - interval '23 hours');
select test.chk(public._shop_is_open(:'biz'), 'L3: shift opened 23 hours ago -> open');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(jsonb_array_length(public.bo_bootstrap()->'stale_open_shifts') = 1, 'L3: the 23-hour shift is not stale');
reset role;
delete from shifts where id in ('88888888-0000-0000-0000-0000000009e1', '88888888-0000-0000-0000-0000000009e2');
select test.chk(exists (select 1 from pg_indexes where indexname = 'shifts_open_idx'), 'L2: open-shift index exists');
-- L4: the API may only read start_fresh_runs
select test.chk(has_table_privilege('authenticated', 'public.start_fresh_runs', 'select')
            and not has_table_privilege('authenticated', 'public.start_fresh_runs', 'insert,update,delete,truncate,references,trigger')
            and not has_table_privilege('anon', 'public.start_fresh_runs', 'select,insert,update,delete,truncate,references,trigger'),
  'L4: authenticated select only; anon nothing');
