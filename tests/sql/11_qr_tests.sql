-- QR ordering + customers. Runs after 10_behaviour_tests.sql on the same database.
\pset tuples_only on
\pset format unaligned
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select qr_token as tok from dining_tables where business_id = :'biz' and kind = 'TAKEAWAY' \gset
select qr_token as tok5 from dining_tables where label = 'Table 5' \gset

-- ===== not signed in at all (anon key only) =====
select test.login(null);
set role anon;
select test.ok((public.get_qr_menu(:'tok')->'business'->>'name') = 'Cavite City Coffee Club', 'menu loads without login');
select test.ok(jsonb_array_length(public.get_qr_menu(:'tok')->'items') = 1, 'menu shows only sellable items (production recipe hidden)');
select test.ok(public.get_qr_menu(:'tok')->'items'->0->'modifier_groups'->0->'options'->1 ? 'ingredient_id' = false, 'public menu hides ingredient ids');
select test.ok(public.get_qr_menu('nope')->>'error' = 'TABLE_NOT_FOUND', 'unknown QR token');
select test.ok((public.qr_session(:'tok')->'customer') = 'null'::jsonb, 'no login -> no customer');
select test.ok((select count(*) from recipes) = 0, 'anon role reads nothing directly');
reset role;

-- ===== customer phone #1 (anonymous login) =====
select test.login('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
select test.ok((public.qr_session(:'tok')->'customer') = 'null'::jsonb, 'first scan: unknown customer');
select test.ok(public.qr_register(:'tok', 'Zed', '0917 123 4567', false)->>'error' = 'CONSENT_REQUIRED', 'consent required');
select test.ok(public.qr_register(:'tok', 'Zed', '12345', true)->>'error' = 'BAD_PHONE', 'bad phone rejected');
select test.ok(public.qr_register(:'tok', '   ', null, true)->>'error' = 'NAME_REQUIRED', 'blank nickname rejected');
select test.ok((public.qr_register(:'tok', 'Zed', '0917 123 4567', true)->'customer'->>'nickname') = 'Zed', 'registered as Zed');
select test.ok((public.qr_session(:'tok')->'customer'->>'nickname') = 'Zed', 'next scan: "Welcome back, Zed"');
select test.ok((public.qr_session(:'tok')->'customer'->>'phone_hint') = '•••• 567', 'phone shown masked');
select test.ok(public.qr_place_order(:'tok', '[]'::jsonb)->>'error' = 'EMPTY_ORDER', 'empty order rejected');
select test.ok(public.qr_place_order(:'tok', null)->>'error' = 'EMPTY_ORDER', 'null order rejected');
select test.ok(public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1}]')->>'error' = 'OPTION_REQUIRED', 'required size enforced');
select test.ok(public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"},{"group_id":"g-size","option_id":"o-16"}]}]')->>'error' = 'BAD_OPTION', 'two sizes rejected');
select test.ok(public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000002","quantity":1}]')->>'error' = 'ITEM_UNAVAILABLE', 'non-menu item rejected');
select test.ok(public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":99,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]')->>'error' = 'BAD_QUANTITY', 'silly quantity rejected');
select public.qr_place_order(:'tok5',
  '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":2,"price":1,"unit_price":1,"modifiers":[{"group_id":"g-size","option_id":"o-16"},{"group_id":"g-add","option_id":"o-shot"},{"group_id":"g-add","option_id":"o-oat"}],"notes":"less ice"}]',
  'Pls hurry') -> 'order' as ord \gset
select test.ok((:'ord'::jsonb->>'subtotal')::numeric = 450, 'server price: (150+20+30+25) x 2 = 450, phone-sent price ignored');
select test.ok((:'ord'::jsonb->>'service_charge_amount')::numeric = 45 and (:'ord'::jsonb->>'total')::numeric = 495, '10% service charge applied');
select test.ok((:'ord'::jsonb->>'order_number') = 'Q-001' and (:'ord'::jsonb->>'table_label') = 'Table 5', 'order number + table');
select test.ok((:'ord'::jsonb->'items'->0->'modifiers'->0->>'ingredient_id') = '22222222-0000-0000-0000-000000000002', 'order keeps modifier stock links for the counter');
select (:'ord'::jsonb->>'id') as order_id \gset
select test.ok((select count(*) from qr_orders) = 1, 'customer can read own order (RLS)');
select test.ok((select count(*) from customers) = 0 and (select count(*) from sales) = 0, 'customer cannot read shop tables');
select test.ok(jsonb_array_length(public.qr_my_orders(:'tok')->'orders') = 1, 'qr_my_orders');
select public.qr_place_order(:'tok', '[{"recipe_id":"33333333-0000-0000-0000-000000000001","quantity":1,"modifiers":[{"group_id":"g-size","option_id":"o-12"}]}]') -> 'order' ->> 'id' as order2 \gset
select test.ok((public.qr_cancel_order(:'tok', :'order2')->'order'->>'status') = 'CANCELLED', 'customer can cancel a pending order');
reset role;

-- ===== customer phone #2: same person, new phone =====
select test.login('00000000-0000-0000-0000-0000000000c2');
set role authenticated;
select test.ok(public.qr_register(:'tok', 'Zack', '09171234567', true)->>'error' = 'PHONE_TAKEN', 'phone taken by a different nickname');
select test.ok(public.qr_relink(:'tok', '+639171234567', 'Zedd')->>'error' = 'NO_MATCH', 'relink needs the right nickname');
select test.ok((public.qr_relink(:'tok', '+63 917 123 4567', 'zed')->'customer'->>'nickname') = 'Zed', 'relink with phone + nickname (case-insensitive)');
select test.ok((select count(*) from qr_orders) = 0, 'new phone does not see the old phone''s orders');
select test.ok((public.qr_forget_device(:'tok')->>'ok')::boolean and (public.qr_session(:'tok')->'customer') = 'null'::jsonb, '"Not Zed?" unlinks this phone');
reset role;

-- ===== counter handles the QR order =====
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.ok((select count(*) from qr_orders where status = 'PENDING') = 1, 'counter sees the pending QR order');
select test.ok((public.qr_update_order(:'order_id', 'ACCEPT', 'Cathy')->'order'->>'status') = 'PREPARING', 'accept -> preparing');
select test.ok(public.qr_update_order(:'order_id', 'COMPLETE', 'Cathy')->>'error' = 'NOT_PAID', 'cannot complete before payment');
select customer_id as cust from qr_orders where id = :'order_id' \gset
select test.ok((public.fo_sync('device-key-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id','a0000000-0000-0000-0000-000000000010','type','sale','data', jsonb_build_object(
   'sale', jsonb_build_object('id','99999999-0000-0000-0000-000000000010','transaction_number','POS-A-2026-000003','transaction_date',now(),'status','COMPLETED','source','QR',
     'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy','shift_id','88888888-0000-0000-0000-000000000001',
     'subtotal',450,'discount_amount',0,'tax_amount',0,'service_charge_amount',45,'grand_total',495,'qr_order_id',:'order_id','customer_id',:'cust'),
   'items','[]'::jsonb,
   'payment', jsonb_build_object('id','bbbbbbbb-0000-0000-0000-000000000010','method','GCASH','amount',495,'reference','123','status','CONFIRMED'),
   'inventory','[]'::jsonb))))->0->>'status') = 'ok', 'QR order paid at the counter');
select test.ok((select paid_at is not null and sale_id = '99999999-0000-0000-0000-000000000010' from qr_orders where id = :'order_id'), 'order marked paid + linked to sale');
select test.ok((public.qr_update_order(:'order_id', 'READY', 'Cathy')->'order'->>'status') = 'READY', 'ready');
select test.ok((public.qr_update_order(:'order_id', 'COMPLETE', 'Cathy')->'order'->>'status') = 'COMPLETED', 'completed');
select test.ok((select visit_count = 1 and total_spent = 495 from customers where id = :'cust'), 'customer visit + spend tracked');
select test.ok(jsonb_array_length(public.search_customers('zed')) = 1 and jsonb_array_length(public.search_customers('1234')) = 1 and jsonb_array_length(public.search_customers('xyz')) = 0, 'customer search by name / phone digits');
select test.ok((public.fo_add_customer('Walk-in Wendy', '0918-000-1111')->'customer'->>'source') = 'COUNTER', 'walk-in customer added at counter');
select test.ok((public.fo_add_customer('Someone', '09180001111')->>'existing')::boolean, 'same phone finds the existing customer');
select test.ok(jsonb_array_length(public.sales_report(now() - interval '1 day', now() + interval '1 day')->'sales') = 2, 'sales_report');
select test.ok(jsonb_array_length(public.sales_report(now() - interval '1 day', now() + interval '1 day')->'qr_orders') = 2, 'sales_report includes QR orders');
reset role;

-- ===== owner merges duplicates, legacy PIN import, device removal =====
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select id as wendy from customers where nickname = 'Walk-in Wendy' \gset
select test.ok((public.merge_customers(:'cust', :'wendy')->>'visit_count')::int = 1, 'merge customers');
select test.ok((select merged_into from customers where id = :'wendy') = :'cust'::uuid, 'merged record points to the kept one');
select public.apply_changes('[{"op":"upsert","table":"staff","row":{"id":"66666666-0000-0000-0000-000000000009","name":"Old Timer","role":"CASHIER","local_id":"user_abc"}}]');
select public.staff_import_legacy_pin('66666666-0000-0000-0000-000000000009', encode(extensions.digest('coffeepos:4321', 'sha256'), 'hex'));
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.ok((public.staff_pin_login('4321')->'staff'->>'name') = 'Old Timer', 'old offline-app PIN still works after import');
reset role;
select test.ok((select pin_hash like '$2%' and legacy_sha256 is null from staff_pins where staff_id = '66666666-0000-0000-0000-000000000009'), 'legacy PIN upgraded to bcrypt');
select test.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select id as dev_id from devices where device_key = 'device-key-0001-abcdef' \gset
select public.revoke_device(:'dev_id');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select test.ok((select count(*) from recipes) = 0, 'removed device loses all access');
reset role;
-- new owner signup still works end to end
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000e1', 'third@example.com', '{"business_name":"Third","admin_name":"Tess"}');
select test.ok((select count(*) from businesses) = 3, 'normal email signup still creates a business');
select 'ALL QR TESTS PASSED';
