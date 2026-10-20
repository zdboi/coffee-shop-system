-- QA extra checks. Runs AFTER 10_behaviour_tests.sql and 11_qr_tests.sql on the same database
-- (uses their shops: CCCC = owner a1, "Other Shop" = owner b1; CCCC's counter key device-key-0001-abcdef).
-- Every check prints "ok  ..." or "FAIL ..."; the file does not stop at a failure (all checks run).
--   psql -h /tmp -p 54329 -U postgres -d cccc -f tests/sql/31_qa_extra_tests.sql
\set QUIET on
create or replace function test.chk(cond boolean, msg text, got text default null) returns text language sql as $$
  select case when coalesce(cond, false) then 'ok  ' || msg else 'FAIL ' || msg || coalesce('   [got: ' || got || ']', '') end
$$;
-- run a statement; returns the error text, or null when it worked
create or replace function test.raises(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;
grant execute on function test.chk(boolean, text, text) to anon, authenticated;
grant execute on function test.raises(text) to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

-- ===== pairing refused because the counter key belongs to ANOTHER shop =====
-- A tablet that was paired to one shop tries to pair with another shop's code. The server answers
-- DEVICE_KEY_TAKEN; that refusal must leave nothing behind: no shop membership for the login,
-- the pairing code still usable, no data readable.
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0000-0000000000f9', true);
select test.login('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select (public.create_device_pairing_code('Other counter'))->>'code' as code2 \gset
reset role;
select test.login('00000000-0000-0000-0000-0000000000f9');
set role authenticated;
select public.redeem_device_pairing(:'code2', 'device-key-0001-abcdef', 'Moved tablet')->>'error' as pair_err \gset
select test.chk(:'pair_err' = 'DEVICE_KEY_TAKEN', 'pairing with another shop''s counter key is refused (DEVICE_KEY_TAKEN)', :'pair_err');
select test.chk(public.current_business_id() is null, 'refused pairing: the login is NOT a member of the shop', coalesce(public.current_business_id()::text, 'null'));
select test.chk((select count(*) from staff) = 0 and (select count(*) from dining_tables) = 0, 'refused pairing: the login reads no staff / tables',
  (select count(*) from staff)::text || ' staff, ' || (select count(*) from dining_tables)::text || ' tables');
select test.chk(test.raises($q$select public.fo_bootstrap('device-key-0001-abcdef')$q$) is not null, 'refused pairing: fo_bootstrap refuses this login',
  'it answered with the shop''s start-up data');
reset role;
select test.chk((select count(*) from profiles where id = '00000000-0000-0000-0000-0000000000f9') = 0, 'refused pairing: no profile row left behind',
  (select role || ' of ' || coalesce((select name from businesses b where b.id = p.business_id), '?') from profiles p where id = '00000000-0000-0000-0000-0000000000f9'));
select test.chk((select used_at is null from device_pairing_codes where code = :'code2'), 'refused pairing: the code is still usable for the right tablet');
select test.chk((select count(*) from devices where auth_user_id = '00000000-0000-0000-0000-0000000000f9') = 0, 'refused pairing: no counter row created');
delete from profiles where id = '00000000-0000-0000-0000-0000000000f9';   -- clean up whatever the refusal left

-- ===== a QR order is paid once =====
-- Two counters (or one counter that took payment offline) can both send a sale for the same QR order.
-- Only the first may count: the second must not be accepted as a new sale, the order keeps pointing at
-- the first sale, and the customer's visit + spend are counted once.
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select qr_token as tok from dining_tables where business_id = :'biz' and kind = 'TAKEAWAY' \gset
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0000-0000000000c7', true), ('00000000-0000-0000-0000-0000000000d8', true);
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select (public.create_device_pairing_code('Counter B'))->>'code' as code3 \gset
reset role;
select test.login('00000000-0000-0000-0000-0000000000d8');
set role authenticated;
select public.redeem_device_pairing(:'code3', 'device-key-0008-abcdef', 'Counter B') is not null as paired \gset
select test.chk(public.fo_sync('device-key-0008-abcdef', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', 'shift_open', 'data', jsonb_build_object(
  'id', '88888888-0000-0000-0000-000000000031', 'shift_number', 'SHIFT-B-2026-0001', 'cashier_id', '66666666-0000-0000-0000-000000000001',
  'cashier_name', 'Cathy Cashier', 'opened_at', now(), 'opening_cash', 1000))))->0->>'status' = 'ok', 'setup: a second counter paired, shift opened');
reset role;
select test.login('00000000-0000-0000-0000-0000000000c7');
set role authenticated;
select (public.qr_register(:'tok', 'Pia', '0918 222 3333', true)->'customer'->>'nickname') = 'Pia' as reg \gset
select public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]')->'order' as qord \gset
reset role;
select (:'qord'::jsonb->>'id') as qid, (:'qord'::jsonb->>'total')::numeric as qtotal \gset
select customer_id as qcust from qr_orders where id = :'qid' \gset
create or replace function test.qr_sale(p_sale uuid, p_no text, p_qr uuid, p_cust uuid, p_total numeric, p_method text) returns jsonb language sql as $$
  select public.fo_sync('device-key-0008-abcdef', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', 'sale', 'data', jsonb_build_object(
    'sale', jsonb_build_object('id', p_sale, 'transaction_number', p_no, 'transaction_date', now(), 'status', 'COMPLETED', 'source', 'QR',
      'cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy Cashier', 'shift_id', '88888888-0000-0000-0000-000000000031',
      'subtotal', 150, 'discount_amount', 0, 'tax_amount', 0, 'service_charge_amount', p_total - 150, 'grand_total', p_total,
      'qr_order_id', p_qr, 'customer_id', p_cust),
    'items', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'recipe_id', '33333333-0000-0000-0000-000000000001', 'name', 'Iced Latte',
      'quantity', 1, 'unit_price', 150, 'line_total', 150, 'modifiers', '[{"group":"Size","label":"12oz","price_delta":0}]'::jsonb)),
    'payment', jsonb_build_object('id', gen_random_uuid(), 'method', p_method, 'amount', p_total, 'status', 'CONFIRMED'),
    'inventory', '[]'::jsonb))))->0
$$;
grant execute on function test.qr_sale(uuid, text, uuid, uuid, numeric, text) to authenticated;
select test.login('00000000-0000-0000-0000-0000000000d8');
set role authenticated;
select test.chk(test.qr_sale('99999999-0000-0000-0000-000000000031', 'POS-B-2026-000001', :'qid', :'qcust', :'qtotal', 'CASH')->>'status' = 'ok', 'QR order paid at the counter (first payment accepted)');
select test.qr_sale('99999999-0000-0000-0000-000000000032', 'POS-B-2026-000002', :'qid', :'qcust', :'qtotal', 'GCASH') as second \gset
select test.chk(:'second'::jsonb->>'status' in ('error', 'skipped'), 'a second sale for the SAME QR order is not accepted', :'second');
reset role;
select test.chk((select count(*) from sales where qr_order_id = :'qid' and status = 'COMPLETED') = 1, 'only one completed sale for that QR order',
  (select count(*) || ' sales, ₱' || sum(grand_total) from sales where qr_order_id = :'qid'));
select test.chk((select sale_id from qr_orders where id = :'qid') = '99999999-0000-0000-0000-000000000031', 'the QR order still points at the first sale',
  (select sale_id::text from qr_orders where id = :'qid'));
select test.chk((select visit_count = 1 and total_spent = :'qtotal'::numeric from customers where id = :'qcust'), 'the customer''s visit and spend are counted once',
  (select visit_count || ' visits, ₱' || total_spent from customers where id = :'qcust'));

-- ===== refund cap also on the owner's Back Office path (security decision 6) =====
-- "A refund can't exceed what's left of the sale." The Back Office saves refunds through apply_changes;
-- the server should refuse more than what is left there too, not only in fo_sync.
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select coalesce(test.raises(format($q$select public.apply_changes('[{"op":"upsert","table":"refunds","row":{"id":"dddddddd-0000-0000-0000-000000000031","sale_id":"99999999-0000-0000-0000-000000000031","type":"PARTIAL_REFUND","amount":%s,"reason":"QA: more than the sale","date":"2026-10-12T08:00:00Z"}}]')$q$, :'qtotal'::numeric + 500)), 'no error') as over_err \gset
reset role;
select test.chk((select count(*) from refunds where id = 'dddddddd-0000-0000-0000-000000000031') = 0, 'owner refund of more than what is left of the sale is refused by the server',
  coalesce('accepted: ₱' || (select amount from refunds where id = 'dddddddd-0000-0000-0000-000000000031') || ' on a ₱' || :'qtotal' || ' sale', :'over_err'));

select 'QA EXTRA SQL CHECKS DONE';
