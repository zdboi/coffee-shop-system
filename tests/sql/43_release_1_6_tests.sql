-- Release 1.6 (Wave 4 "Money"), database script 013: payment methods + charge, Senior / PWD, smart stock count, reports.
-- Needs a database with 004..013 on which 10_behaviour_tests + 11_qr_tests have JUST run (like 38..42):
--   tests/reset_db.sh "" cccc; P="psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1"
--   $P -f tests/sql/10_behaviour_tests.sql && $P -f tests/sql/11_qr_tests.sql && $P -f tests/sql/43_release_1_6_tests.sql
-- Part 1 (A, B, S, R, D, G): adopted from the database work's 90 checks (scratchpad w4/db16-tests.sql), unchanged.
-- Part 2 (Z...): Z's security-gate probes, 2026-11-13. Prints ok / FAIL lines and keeps going.
create schema if not exists test;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', '{}', false);
end $$;
grant usage on schema test to anon, authenticated;
\set QUIET on
\pset tuples_only on
\pset format unaligned
create or replace function test.chk(cond boolean, msg text, got text default null) returns text language plpgsql as $$
begin return case when coalesce(cond, false) then 'ok  ' || msg else 'FAIL ' || msg || coalesce('   [got: ' || got || ']', '') end; end $$;
create or replace function test.err(q text) returns text language plpgsql as $$
begin execute q; return 'NO ERROR'; exception when others then return sqlerrm; end $$;
create or replace function test.op(p_type text, p_data jsonb, p_opid uuid default gen_random_uuid()) returns jsonb language sql as $$
  select public.fo_sync('device-key-0001-abcdef', jsonb_build_array(jsonb_build_object('op_id', p_opid, 'type', p_type, 'data', p_data)))->0
$$;
-- a finished sale; p_x = extra sale fields; p_items; p_pay = payment method; p_senior = data.senior (or null)
create or replace function test.sale16(p_sale uuid, p_items jsonb, p_x jsonb, p_method text, p_senior jsonb, p_shift uuid) returns jsonb language sql as $$
  select test.op('sale', jsonb_build_object(
    'sale', jsonb_build_object('id', p_sale, 'transaction_number', 'POS-A-2026-' || right(p_sale::text, 6), 'transaction_date', now(), 'status', 'COMPLETED',
       'cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy Cashier', 'shift_id', p_shift,
       'discount_amount', 0, 'loyalty_discount', 0, 'tax_amount', 0) || p_x,
    'items', p_items,
    'payment', jsonb_build_object('id', gen_random_uuid(), 'method', p_method, 'amount', (p_x->>'grand_total')::numeric),
    'inventory', '[]'::jsonb) || case when p_senior is null then '{}'::jsonb else jsonb_build_object('senior', p_senior) end)
$$;
grant execute on all functions in schema test to anon, authenticated;

select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
-- re-pair the counter (suite 11 removed it), sign the cashier in online, open a shift
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select (public.create_device_pairing_code('Front Counter'))->>'code' as paircode \gset
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select (public.redeem_device_pairing(:'paircode', 'device-key-0001-abcdef', 'Front Counter')->'device'->>'active') as x \gset
select (public.staff_pin_login('1111'))->>'token' as cashier_token \gset
reset role;
delete from auth_attempts;
update ingredients set count_at_close = false where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('shift_open', jsonb_build_object('id','d1600000-0000-0000-0000-0000000005a1','shift_number','SHIFT-W4-0001',
  'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0))->>'status' = 'ok', 'setup: shift opened');
reset role;
\set sh 'd1600000-0000-0000-0000-0000000005a1'

-- ============================ A. settings ============================
select test.chk((select jsonb_array_length(payment_methods) = 7 and payment_methods->0->>'id' = 'CASH' and payment_methods->2->>'label' = 'QR payment'
  and (payment_methods->5->>'active')::boolean = false and senior_discount_pct = 20 and count_recheck_days = 7 from settings where business_id = :'biz'),
  'A: defaults: 7 methods (Cash first, QR payment, Maya off), Senior/PWD 20%, recheck 7 days');
select test.chk(test.err($$update settings set payment_methods = '[]'::jsonb$$) = 'BAD_PAYMENT_METHODS', 'A: empty list refused');
select test.chk(test.err($$update settings set payment_methods = '[{"id":"GCASH","label":"GCash","active":true,"charge_type":"NONE","charge_value":0}]'$$) = 'BAD_PAYMENT_METHODS', 'A: list without Cash refused');
select test.chk(test.err($$update settings set payment_methods = '[{"id":"CASH","label":"Cash","active":false,"charge_type":"NONE","charge_value":0}]'$$) = 'BAD_PAYMENT_METHODS', 'A: Cash switched off refused');
select test.chk(test.err($$update settings set payment_methods = '[{"id":"CASH","label":"Cash","active":true,"charge_type":"PERCENT","charge_value":2}]'$$) = 'BAD_PAYMENT_METHODS', 'A: a charge on Cash refused');
select test.chk(test.err($$update settings set payment_methods = '[{"id":"CASH","label":"Cash","active":true,"charge_type":"NONE","charge_value":0},{"id":"gcash","label":"GCash","active":true,"charge_type":"NONE","charge_value":0}]'$$) = 'BAD_PAYMENT_METHODS', 'A: lower-case id refused');
select test.chk(test.err($$update settings set payment_methods = '[{"id":"CASH","label":"Cash","active":true,"charge_type":"NONE","charge_value":0},{"id":"CASH","label":"Cash 2","active":true,"charge_type":"NONE","charge_value":0}]'$$) = 'BAD_PAYMENT_METHODS', 'A: same id twice refused');
select test.chk(test.err($$update settings set payment_methods = '[{"id":"CASH","label":"Cash","active":true,"charge_type":"NONE","charge_value":0},{"id":"GCASH","label":"GCash","active":true,"charge_type":"PERCENT","charge_value":26}]'$$) = 'BAD_PAYMENT_METHODS', 'A: 26% refused');
select test.chk(test.err($$update settings set payment_methods = '[{"id":"CASH","label":"Cash","active":true,"charge_type":"NONE","charge_value":0},{"id":"GCASH","label":"GCash","active":true,"charge_type":"PERCENT","charge_value":0}]'$$) = 'BAD_PAYMENT_METHODS', 'A: 0% charge refused');
select test.chk(test.err($$update settings set payment_methods = '[{"id":"CASH","label":"Cash","active":true,"charge_type":"NONE","charge_value":0},{"id":"GCASH","label":"","active":true,"charge_type":"NONE","charge_value":0}]'$$) = 'BAD_PAYMENT_METHODS', 'A: empty label refused');
select test.chk(test.err($$update settings set payment_methods = '{"id":"CASH"}'$$) = 'BAD_PAYMENT_METHODS', 'A: not a list refused');
select test.chk(test.err($$update settings set senior_discount_pct = 101$$) = 'BAD_SENIOR_PCT', 'A: Senior/PWD 101% refused');
select test.chk(test.err($$update settings set count_recheck_days = 0$$) = 'BAD_RECHECK_DAYS', 'A: recheck 0 days refused');
-- the owner sets a 2% charge on GCash (added by default) through apply_changes
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes(jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'settings', 'row', jsonb_build_object('business_id', :'biz',
  'payment_methods', '[{"id":"CASH","label":" Cash ","active":true,"charge_type":"NONE","charge_value":0},
    {"id":"GCASH","label":"GCash","active":true,"reference":true,"charge_type":"PERCENT","charge_value":2,"charge_default":"ADD"},
    {"id":"CARD","label":"Card","active":true,"charge_type":"FIXED","charge_value":15,"charge_default":"WAIVE"},
    {"id":"MAYA","label":"Maya","active":false,"charge_type":"NONE","charge_value":0}]'::jsonb)))) as x \gset
reset role;
select test.chk((select payment_methods->0->>'label' = 'Cash' and payment_methods->0->>'charge_default' = 'ADD' and (payment_methods->1->>'charge_value')::numeric = 2
  and payment_methods->2->>'charge_default' = 'WAIVE' and jsonb_array_length(payment_methods) = 4 from settings where business_id = :'biz'),
  'A: owner saved a new list (label trimmed, defaults filled in)');
select test.chk(pg_get_constraintdef(oid) like '%A-Z%', 'A: payments.method is a format rule now', pg_get_constraintdef(oid)) from pg_constraint where conname = 'payments_method_check';
select test.chk(test.err($$insert into payments(business_id, sale_id, method, amount) select business_id, id, 'gcash', 1 from sales limit 1$$) like '%payments_method_check%', 'A: a lower-case method is refused by the table');

-- ============================ B. payment charge ============================
-- test shop: tax 0, service charge 10%. Iced Latte 150.
select '[{"id":"e1600000-0000-0000-0000-000000000001","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]' as latte \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale16('16000000-0000-0000-0000-000000000001', :'latte', '{"subtotal":150,"service_charge_amount":15,"grand_total":165}', 'CASH', null, :'sh') as r \gset
select test.chk(:'r'::jsonb->>'status' = 'ok', 'B: cash sale, no charge: ok', :'r');
select test.sale16('16000000-0000-0000-0000-000000000002', replace(:'latte', 'e1600000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000002')::jsonb,
  '{"subtotal":150,"service_charge_amount":15,"payment_fee":3.30,"payment_charge":3.30,"grand_total":168.30}', 'GCASH', null, :'sh') as r \gset
select test.chk(:'r'::jsonb->>'status' = 'ok', 'B: GCash 2% added: ok', :'r');
select test.sale16('16000000-0000-0000-0000-000000000003', replace(:'latte', 'e1600000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000003')::jsonb,
  '{"subtotal":150,"service_charge_amount":15,"payment_fee":3.30,"payment_charge":0,"grand_total":165}', 'GCASH', null, :'sh') as r \gset
select test.chk(:'r'::jsonb->>'status' = 'ok', 'B: GCash 2% waived: ok', :'r');
select test.sale16('16000000-0000-0000-0000-000000000004', replace(:'latte', 'e1600000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000004')::jsonb,
  '{"subtotal":150,"service_charge_amount":15,"payment_fee":3.30,"payment_charge":1,"grand_total":166}', 'GCASH', null, :'sh') as r \gset
select test.chk(:'r'::jsonb->>'message' = 'SALE_TOTALS_MISMATCH', 'B: a charge that is neither 0 nor the fee is refused', :'r');
select test.sale16('16000000-0000-0000-0000-000000000005', replace(:'latte', 'e1600000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000005')::jsonb,
  '{"subtotal":150,"service_charge_amount":15,"payment_fee":3.30,"payment_charge":3.30,"grand_total":165}', 'GCASH', null, :'sh') as r \gset
select test.chk(:'r'::jsonb->>'message' = 'SALE_TOTALS_MISMATCH', 'B: charge not in the total is refused', :'r');
select test.sale16('16000000-0000-0000-0000-000000000006', replace(:'latte', 'e1600000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000006')::jsonb,
  '{"subtotal":150,"service_charge_amount":15,"grand_total":165}', 'GCASH', null, :'sh') as r \gset
select test.sale16('16000000-0000-0000-0000-000000000007', replace(:'latte', 'e1600000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000007')::jsonb,
  '{"subtotal":150,"service_charge_amount":15,"grand_total":165}', 'MAYA', null, :'sh') as r2 \gset
select test.sale16('16000000-0000-0000-0000-000000000008', replace(:'latte', 'e1600000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000008')::jsonb,
  '{"subtotal":150,"service_charge_amount":15,"payment_fee":15,"payment_charge":0,"grand_total":165}', 'CARD', null, :'sh') as r3 \gset
select test.sale16('16000000-0000-0000-0000-000000000009', replace(:'latte', 'e1600000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000009')::jsonb,
  '{"subtotal":150,"service_charge_amount":15,"grand_total":165}', 'PAYMAYA_X', null, :'sh') as r4 \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'ok' and (select needs_review and review_reason ~ 'CHARGE_MISMATCH' from sales where id = '16000000-0000-0000-0000-000000000006'),
  'B: GCash sale without the fee (old counter): saved, flagged CHARGE_MISMATCH', (select review_reason from sales where id = '16000000-0000-0000-0000-000000000006'));
select test.chk(:'r2'::jsonb->>'status' = 'ok' and (select needs_review and review_reason ~ 'PAYMENT_METHOD_OFF' from sales where id = '16000000-0000-0000-0000-000000000007'),
  'B: a switched-off method: saved, flagged PAYMENT_METHOD_OFF', (select review_reason from sales where id = '16000000-0000-0000-0000-000000000007'));
select test.chk(:'r3'::jsonb->>'status' = 'ok' and (select not needs_review and payment_fee = 15 and payment_charge = 0 from sales where id = '16000000-0000-0000-0000-000000000008'),
  'B: Card ₱15 fixed, waived: ok, not flagged', (select review_reason from sales where id = '16000000-0000-0000-0000-000000000008'));
select test.chk(:'r4'::jsonb->>'status' = 'ok' and (select review_reason ~ 'PAYMENT_METHOD_OFF' from sales where id = '16000000-0000-0000-0000-000000000009'),
  'B: a method not in the list: saved, flagged');
select test.chk((select not needs_review and payment_fee = 3.30 and payment_charge = 3.30 from sales where id = '16000000-0000-0000-0000-000000000002')
  and (select not needs_review and payment_fee = 3.30 and payment_charge = 0 from sales where id = '16000000-0000-0000-0000-000000000003'), 'B: added and waived sales are not flagged; fee kept on both');
select test.chk(test.err($$update sales set payment_fee = 0 where id = '16000000-0000-0000-0000-000000000003'$$) = 'SALE_LOCKED'
  and test.err($$update sales set payment_charge = 1 where id = '16000000-0000-0000-0000-000000000003'$$) = 'SALE_LOCKED'
  and test.err($$update sales set senior_discount = 1 where id = '16000000-0000-0000-0000-000000000003'$$) = 'SALE_LOCKED'
  and test.err($$update sales set vat_exempt_amount = 1 where id = '16000000-0000-0000-0000-000000000003'$$) = 'SALE_LOCKED'
  and test.err($$update sales set senior_kind = 'PWD' where id = '16000000-0000-0000-0000-000000000003'$$) = 'SALE_LOCKED', 'B: the new money columns are locked on a finished sale');

-- ============================ S. Senior / PWD ============================
-- no tax: latte 150, 20% -> discount 30, base 120, service 12, total 132
select '[{"id":"e1600000-0000-0000-0000-000000000011","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30}]' as slatte \gset
select '{"subtotal":150,"service_charge_amount":12,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"grand_total":132}' as sx \gset
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', :'sx', 'CASH', null, :'sh')->>'message' = 'BAD_SENIOR', 'S: without the name and ID -> BAD_SENIOR');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', :'sx', 'CASH', '{"kind":"SENIOR","holder_name":"L","id_number":"12345"}', :'sh')->>'message' = 'BAD_SENIOR', 'S: a 1-letter name -> BAD_SENIOR');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', :'sx', 'CASH', '{"kind":"SENIOR","holder_name":"Lola Remedios","id_number":"  "}', :'sh')->>'message' = 'BAD_SENIOR', 'S: an empty ID -> BAD_SENIOR');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', :'sx', 'CASH', '{"kind":"PWD","holder_name":"Lola Remedios","id_number":"12345"}', :'sh')->>'message' = 'BAD_SENIOR', 'S: kind differs from the sale -> BAD_SENIOR');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', (:'sx'::jsonb || '{"senior_kind":"VIP"}'), 'CASH', '{"kind":"VIP","holder_name":"Lola Remedios","id_number":"12345"}', :'sh')->>'message' = 'BAD_SENIOR', 'S: unknown kind -> BAD_SENIOR');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', (:'sx'::jsonb || '{"discount_type":"fixed","discount_value":10,"discount_amount":10,"service_charge_amount":11,"grand_total":121}'), 'CASH', '{"kind":"SENIOR","holder_name":"Lola Remedios","id_number":"12345"}', :'sh')->>'message' = 'BAD_SENIOR',
  'S: with a manager discount -> BAD_SENIOR (checked before the approval)');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', replace(:'slatte', '"senior_discount":30', '"senior_discount":10')::jsonb, :'sx', 'CASH', '{"kind":"SENIOR","holder_name":"Lola Remedios","id_number":"12345"}', :'sh')->>'message' = 'BAD_SENIOR', 'S: lines don''t add up to the discount -> BAD_SENIOR');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', replace(:'slatte', ',"senior_discount":30', '')::jsonb, :'sx', 'CASH', '{"kind":"SENIOR","holder_name":"Lola Remedios","id_number":"12345"}', :'sh')->>'message' = 'BAD_SENIOR', 'S: no Senior/PWD line -> BAD_SENIOR');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', '{"subtotal":150,"service_charge_amount":15,"grand_total":165}', 'CASH', null, :'sh')->>'message' = 'BAD_SENIOR', 'S: a Senior/PWD line on a sale without the discount -> BAD_SENIOR');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'latte'::jsonb, '{"subtotal":150,"service_charge_amount":15,"grand_total":165,"senior_kind":"SENIOR"}', 'CASH', null, :'sh')->>'message' = 'BAD_SENIOR', 'S: a kind without a discount -> BAD_SENIOR');
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', (:'sx'::jsonb || '{"grand_total":130}'), 'CASH', '{"kind":"SENIOR","holder_name":"Lola Remedios","id_number":"12345"}', :'sh')->>'message' = 'SALE_TOTALS_MISMATCH', 'S: total that doesn''t add up -> SALE_TOTALS_MISMATCH');
select test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', :'sx', 'CASH', '{"kind":"SENIOR","holder_name":"  Lola Remedios ","id_number":"SC-0012345"}', :'sh') as r \gset
select test.chk(:'r'::jsonb->>'status' = 'ok', 'S: Senior sale, no approval token: ok', :'r');
-- the same sale again (new op id): skipped, still one record
select test.chk(test.sale16('16000000-0000-0000-0000-000000000011', :'slatte', :'sx', 'CASH', '{"kind":"SENIOR","holder_name":"Someone Else","id_number":"99999"}', :'sh')->>'status' = 'skipped', 'S: same sale again: skipped');
-- wrong % (10%): saved but flagged
select test.sale16('16000000-0000-0000-0000-000000000012', '[{"id":"e1600000-0000-0000-0000-000000000012","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":15}]',
  '{"subtotal":150,"service_charge_amount":13.5,"senior_kind":"PWD","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":15,"grand_total":148.5}', 'CASH', '{"kind":"PWD","holder_name":"Juan Cruz","id_number":"PWD-778"}', :'sh') as r2 \gset
-- two lines, only one Senior: 300, discount 30, base 270, service 27, total 297; paid by GCash, charge added: 2% of 297 = 5.94
select test.sale16('16000000-0000-0000-0000-000000000013', '[{"id":"e1600000-0000-0000-0000-000000000013","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30},
   {"id":"e1600000-0000-0000-0000-000000000014","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]',
  '{"subtotal":300,"service_charge_amount":27,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"payment_fee":5.94,"payment_charge":5.94,"grand_total":302.94}', 'GCASH', '{"kind":"SENIOR","holder_name":"Lolo Ben","id_number":"SC-555"}', :'sh') as r3 \gset
reset role;
select test.chk((select kind = 'SENIOR' and holder_name = 'Lola Remedios' and id_number = 'SC-0012345' and pct = 20 and discount_amount = 30 and items_amount = 150
  and cashier_name = 'Cathy Cashier' from senior_discount_records where sale_id = '16000000-0000-0000-0000-000000000011')
  and (select count(*) = 1 from senior_discount_records where sale_id = '16000000-0000-0000-0000-000000000011')
  and (select not needs_review and senior_kind = 'SENIOR' and senior_discount = 30 and discount_approved_by is null from sales where id = '16000000-0000-0000-0000-000000000011'),
  'S: the record is saved once (name trimmed, 20%), sale not flagged', (select review_reason from sales where id = '16000000-0000-0000-0000-000000000011'));
select test.chk(:'r2'::jsonb->>'status' = 'ok' and (select needs_review and review_reason ~ 'SENIOR_MISMATCH' from sales where id = '16000000-0000-0000-0000-000000000012')
  and (select pct = 10 from senior_discount_records where sale_id = '16000000-0000-0000-0000-000000000012'), 'S: 10% instead of the shop''s 20%: saved, flagged SENIOR_MISMATCH, record says 10%');
select test.chk(:'r3'::jsonb->>'status' = 'ok' and (select not needs_review from sales where id = '16000000-0000-0000-0000-000000000013'), 'S: mixed sale + GCash charge: ok, not flagged',
  (select review_reason from sales where id = '16000000-0000-0000-0000-000000000013'));
-- refund shares on the mixed sale: Senior line (150 - 30) x 302.94 / 270 = 134.64; other line 150 x 302.94 / 270 = 168.30
select test.chk(public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000013","quantity":1}]', 302.94) = 134.64
  and public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000014","quantity":1}]', 302.94) = 168.30
  and public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000013","quantity":1},{"sale_item_id":"e1600000-0000-0000-0000-000000000014","quantity":1}]', 302.94) = 302.94,
  'S: refund share: Senior line 134.64, other line 168.30, both = everything',
  public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000013","quantity":1}]', 302.94)::text)
  from sales s where s.id = '16000000-0000-0000-0000-000000000013';
select test.chk(public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000002","quantity":1}]', 168.30) = 168.30,
  'S: refund share of a normal one-line sale is unchanged') from sales s where s.id = '16000000-0000-0000-0000-000000000002';
-- prices include 12% VAT: latte 150 -> VAT out 16.07, discount 26.79, base 107.14, service 10.71, total 117.85
update settings set tax_pct = 12, tax_inclusive = true where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale16('16000000-0000-0000-0000-000000000015', '[{"id":"e1600000-0000-0000-0000-000000000015","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":42.86}]',
  '{"subtotal":150,"service_charge_amount":10.714,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":16.07,"senior_discount":26.79,"grand_total":117.85}', 'CASH', '{"kind":"SENIOR","holder_name":"Lola Vat","id_number":"SC-900"}', :'sh') as r \gset
-- VAT not taken out although prices include it: flagged
select test.sale16('16000000-0000-0000-0000-000000000016', '[{"id":"e1600000-0000-0000-0000-000000000016","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30}]',
  '{"subtotal":150,"service_charge_amount":12,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"grand_total":132}', 'CASH', '{"kind":"SENIOR","holder_name":"Lola Vat","id_number":"SC-900"}', :'sh') as r2 \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'ok' and (select not needs_review and vat_exempt_amount = 16.07 from sales where id = '16000000-0000-0000-0000-000000000015'), 'S: VAT-inclusive prices: VAT out + 20%: ok, not flagged',
  :'r' || coalesce((select review_reason from sales where id = '16000000-0000-0000-0000-000000000015'), ''));
select test.chk((select needs_review and review_reason ~ 'SENIOR_MISMATCH' from sales where id = '16000000-0000-0000-0000-000000000016'), 'S: VAT not taken out: flagged SENIOR_MISMATCH');
-- tax added on top (12%): two lattes, one Senior: discount 30, base 270, tax only on the other 150 = 18, service 27, total 315
update settings set tax_pct = 12, tax_inclusive = false where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale16('16000000-0000-0000-0000-000000000017', '[{"id":"e1600000-0000-0000-0000-000000000017","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30},
   {"id":"e1600000-0000-0000-0000-000000000018","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]',
  '{"subtotal":300,"tax_amount":18,"service_charge_amount":27,"senior_kind":"PWD","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"grand_total":315}', 'CASH', '{"kind":"PWD","holder_name":"Ana Reyes","id_number":"PWD-1"}', :'sh') as r \gset
-- tax charged on the Senior items too (32.40): flagged TAX_MISMATCH
select test.sale16('16000000-0000-0000-0000-000000000019', '[{"id":"e1600000-0000-0000-0000-000000000019","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30},
   {"id":"e1600000-0000-0000-0000-00000000001a","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]',
  '{"subtotal":300,"tax_amount":32.4,"service_charge_amount":27,"senior_kind":"PWD","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"grand_total":329.4}', 'CASH', '{"kind":"PWD","holder_name":"Ana Reyes","id_number":"PWD-1"}', :'sh') as r2 \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'ok' and (select not needs_review from sales where id = '16000000-0000-0000-0000-000000000017'), 'S: tax on top: no tax on the Senior/PWD item: ok, not flagged',
  :'r' || coalesce((select review_reason from sales where id = '16000000-0000-0000-0000-000000000017'), ''));
select test.chk((select needs_review and review_reason ~ 'TAX_MISMATCH' from sales where id = '16000000-0000-0000-0000-000000000019'), 'S: tax charged on the Senior/PWD item: flagged TAX_MISMATCH');
update settings set tax_pct = 0, tax_inclusive = false where business_id = :'biz';
-- who can read the ID numbers
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select count(*) from public.senior_discount_records$$) like '%permission denied%', 'S: a counter can''t read the records table');
select test.chk(test.err($$select public.senior_report(current_date - 1, current_date + 1)$$) = 'NOT_ALLOWED', 'S: a counter can''t call senior_report');
select test.chk(test.err($$select public.accounting_report(current_date - 1, current_date + 1)$$) = 'NOT_ALLOWED', 'S: a counter can''t call accounting_report');
select test.chk(not (public.fo_bootstrap('device-key-0001-abcdef')::text ~ 'SC-0012345|Lola Remedios'), 'S: fo_bootstrap never carries the name or ID');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select count(*) from public.senior_discount_records$$) like '%permission denied%', 'S: even the owner can''t read the table directly (report only)');
select public.senior_report((now() at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date) as sr \gset
select test.chk(jsonb_array_length(:'sr'::jsonb) = 7 and (select bool_or(x->>'id_number' = 'SC-0012345' and x->>'holder_name' = 'Lola Remedios' and (x->>'discount')::numeric = 30) from jsonb_array_elements(:'sr'::jsonb) x),
  'S: senior_report (owner): 7 sales with full ID numbers', jsonb_array_length(:'sr'::jsonb)::text);
select test.chk(test.err($$select public.senior_report(current_date, current_date - 1)$$) = 'BAD_RANGE' and test.err($$select public.accounting_report(current_date - 500, current_date)$$) = 'BAD_RANGE', 'S: bad ranges refused');
reset role;
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.chk(jsonb_array_length(public.senior_report(current_date - 1, current_date + 1)) = 0, 'S: another shop''s owner sees none of them');
reset role;

-- ============================ R. accounting_report ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.accounting_report((now() at time zone 'Asia/Manila')::date - 2, (now() at time zone 'Asia/Manila')::date) as ar \gset
reset role;
select :'ar'::jsonb->'totals' as t \gset
select test.chk(jsonb_array_length(:'ar'::jsonb->'days') = 3, 'R: one row per day (3 days)');
-- totals against the tables
select test.chk((:'t'::jsonb->>'sales')::numeric = (select round(sum(grand_total), 2) from sales where business_id = :'biz' and status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
    and (transaction_date at time zone 'Asia/Manila')::date between (now() at time zone 'Asia/Manila')::date - 2 and (now() at time zone 'Asia/Manila')::date)
  and (:'t'::jsonb->>'payment_fees')::numeric = (select round(sum(payment_fee), 2) from sales where business_id = :'biz' and status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
    and (transaction_date at time zone 'Asia/Manila')::date between (now() at time zone 'Asia/Manila')::date - 2 and (now() at time zone 'Asia/Manila')::date),
  'R: sales and payment fees = the tables', :'t');
select test.chk((:'t'::jsonb->>'payment_charges')::numeric = 9.24 and (:'t'::jsonb->>'payment_fees')::numeric = 27.54 and (:'t'::jsonb->>'charges_waived')::numeric = 18.30,
  'R: charges collected 9.24 (3.30 + 5.94), fees 27.54, waived 18.30 (3.30 + 15)', :'t');
select test.chk((:'t'::jsonb->>'senior_discounts')::numeric = 30 + 15 + 30 + 26.79 + 30 + 30 + 30 and (:'t'::jsonb->>'vat_exempt')::numeric = 16.07, 'R: Senior/PWD discounts and VAT exempt', :'t');
select test.chk((:'t'::jsonb->>'net_sales')::numeric = (:'t'::jsonb->>'sales')::numeric - (:'t'::jsonb->>'refunds')::numeric
  and (:'t'::jsonb->>'net_income')::numeric = (:'t'::jsonb->>'net_sales')::numeric - (:'t'::jsonb->>'tax_owed')::numeric - (:'t'::jsonb->>'payment_fees')::numeric
      - (:'t'::jsonb->>'ingredients_sold')::numeric - (:'t'::jsonb->>'ingredients_wasted')::numeric - (:'t'::jsonb->>'expenses')::numeric,
  'R: net sales = sales - refunds; net income = net sales - tax owed - fees - ingredients - expenses', :'t');
select test.chk((select sum((d->>'sales')::numeric) from jsonb_array_elements(:'ar'::jsonb->'days') d) = (:'t'::jsonb->>'sales')::numeric
  and (select sum((d->>'net_income')::numeric) from jsonb_array_elements(:'ar'::jsonb->'days') d) = (:'t'::jsonb->>'net_income')::numeric
  and (select sum((d->>'waste')::numeric) from jsonb_array_elements(:'ar'::jsonb->'days') d) = (:'t'::jsonb->>'ingredients_wasted')::numeric
  and (select sum((d->>'drinks')::numeric) from jsonb_array_elements(:'ar'::jsonb->'days') d) = (:'t'::jsonb->'items'->>'drinks')::numeric,
  'R: the day rows add up to the totals exactly');
select test.chk((select bool_and(m ? 'label' and m ? 'fees' and m ? 'waived') and bool_or(m->>'method' = 'GCASH' and m->>'label' = 'GCash' and (m->>'waived')::numeric = 3.30)
    and bool_or(m->>'method' = 'PAYMAYA_X' and m->>'label' = 'Paymaya X') from jsonb_array_elements(:'ar'::jsonb->'payment_methods') m),
  'R: payment methods: labels from the list (or tidied id), waived per method', (:'ar'::jsonb->'payment_methods')::text);
select test.chk(jsonb_array_length(:'ar'::jsonb->'waived_list') = 2 and (select bool_and(w->>'cashier_name' = 'Cathy Cashier') from jsonb_array_elements(:'ar'::jsonb->'waived_list') w),
  'R: waived list: 2 sales, with who', (:'ar'::jsonb->'waived_list')::text);
select test.chk((:'t'::jsonb->'items'->>'drinks')::numeric >= 13, 'R: items sold: drinks counted', (:'t'::jsonb->'items')::text);

-- ============================ D. smart stock count ============================
-- tick beans + milk
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.apply_changes('[{"op":"update","table":"ingredients","row":{"id":"22222222-0000-0000-0000-000000000001","count_at_close":true}},{"op":"update","table":"ingredients","row":{"id":"22222222-0000-0000-0000-000000000002","count_at_close":true}}]') as x \gset
select public.bo_count_status() as bs \gset
reset role;
select test.chk(jsonb_array_length(:'bs'::jsonb) = 2 and (select bool_and((x->>'due')::boolean and x->>'why' = 'NEVER') from jsonb_array_elements(:'bs'::jsonb) x), 'D: never counted: both due (NEVER)', :'bs');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select public.fo_count_due(:'sh') as fd \gset
select test.chk(jsonb_array_length(:'fd'::jsonb->'items') = 2 and (:'fd'::jsonb->>'recheck_days')::int = 7 and not (:'fd'::text ~ 'NEVER|stock|expected'), 'D: fo_count_due: 2 ids, nothing else', :'fd');
select test.chk(test.op('shift_close', jsonb_build_object('id', :'sh', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 0))->>'message' = 'COUNT_REQUIRED',
  'D: items due and no count -> COUNT_REQUIRED');
-- count ONLY the beans: saved, flagged incomplete (milk is due too)
select test.op('stock_count', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000000f1', 'shift_id', :'sh', 'staff_id', '66666666-0000-0000-0000-000000000001', 'counted_at', now(),
  'lines', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', (select stock from v_ingredient_stock where ingredient_id = '22222222-0000-0000-0000-000000000001'))))) as c1 \gset
reset role;
select test.chk(:'c1'::jsonb->>'status' = 'ok' and (select review_reason ~ 'COUNT_INCOMPLETE' from stock_counts where id = 'd1600000-0000-0000-0000-0000000000f1'), 'D: a count that misses a due item: saved, flagged COUNT_INCOMPLETE',
  (select review_reason from stock_counts where id = 'd1600000-0000-0000-0000-0000000000f1'));
-- a second count of the same shift with the milk: complete now
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('stock_count', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000000f2', 'shift_id', :'sh', 'staff_id', '66666666-0000-0000-0000-000000000001', 'counted_at', now(),
  'lines', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000002','quantity', (select stock from v_ingredient_stock where ingredient_id = '22222222-0000-0000-0000-000000000002'))))) as c2 \gset
select public.fo_count_due(:'sh') as fd \gset
select public.fo_count_due(null) as fd0 \gset
reset role;
select test.chk(:'c2'::jsonb->>'status' = 'ok' and (select coalesce(review_reason, '') !~ 'COUNT_INCOMPLETE' from stock_counts where id = 'd1600000-0000-0000-0000-0000000000f2'), 'D: the second count covers the rest: not flagged incomplete',
  (select review_reason from stock_counts where id = 'd1600000-0000-0000-0000-0000000000f2'));
select test.chk(jsonb_array_length(:'fd'::jsonb->'items') = 2 and jsonb_array_length(:'fd0'::jsonb->'items') = 0, 'D: for this shift the list stays the same; for a new shift nothing is due', :'fd' || :'fd0');
-- the shift closes
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('shift_close', jsonb_build_object('id', :'sh', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 0))->>'status' = 'ok', 'D: counted -> the shift closes');
-- next shift: nothing moved -> closes without a count
select test.chk(test.op('shift_open', jsonb_build_object('id','d1600000-0000-0000-0000-0000000005a2','shift_number','SHIFT-W4-0002',
  'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0))->>'status' = 'ok', 'D: next shift opened');
select test.chk(test.op('shift_close', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000005a2', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 0))->>'status' = 'ok',
  'D: nothing moved since the count -> closes with no count');
select test.chk(test.op('shift_open', jsonb_build_object('id','d1600000-0000-0000-0000-0000000005a3','shift_number','SHIFT-W4-0003',
  'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0))->>'status' = 'ok', 'D: third shift opened');
-- a sale that uses milk (the counter's own clock says last year: the server's arrival time counts)
select test.op('sale', jsonb_build_object(
    'sale', jsonb_build_object('id', '16000000-0000-0000-0000-000000000031', 'transaction_number', 'POS-A-2026-000031', 'transaction_date', now(), 'status', 'COMPLETED',
       'cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy Cashier', 'shift_id', 'd1600000-0000-0000-0000-0000000005a3',
       'subtotal', 150, 'discount_amount', 0, 'loyalty_discount', 0, 'tax_amount', 0, 'service_charge_amount', 15, 'grand_total', 165),
    'items', '[{"id":"e1600000-0000-0000-0000-000000000031","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]'::jsonb,
    'payment', jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', 165),
    'inventory', '[{"id":"e1600000-0000-0000-0000-0000000000b1","ingredient_id":"22222222-0000-0000-0000-000000000002","quantity":150,"transaction_date":"2025-01-01","created_at":"2025-01-01T00:00:00Z","received_at":"2025-01-01T00:00:00Z"}]'::jsonb)) as r \gset
select public.fo_count_due('d1600000-0000-0000-0000-0000000005a3') as fd \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'ok' and (select received_at > now() - interval '1 minute' from inventory_transactions where id = 'e1600000-0000-0000-0000-0000000000b1'),
  'D: a stock line''s received_at is the server''s time, whatever the counter sent', :'r');
select test.chk(:'fd'::jsonb->'items' = '["22222222-0000-0000-0000-000000000002"]'::jsonb, 'D: only the milk moved -> only the milk is due', :'fd');
select test.chk(test.err($$update inventory_transactions set received_at = '2020-01-01' where id = 'e1600000-0000-0000-0000-0000000000b1'$$) = 'NO ERROR'
  and (select received_at > now() - interval '1 minute' from inventory_transactions where id = 'e1600000-0000-0000-0000-0000000000b1'), 'D: received_at can''t be changed afterwards');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('shift_close', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000005a3', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 0))->>'message' = 'COUNT_REQUIRED',
  'D: milk moved and no count -> COUNT_REQUIRED');
-- count the milk, 50 short: its own waste lines don't make it due again
select test.op('stock_count', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000000f3', 'shift_id', 'd1600000-0000-0000-0000-0000000005a3', 'staff_id', '66666666-0000-0000-0000-000000000001', 'counted_at', now(),
  'lines', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000002','quantity', (select stock - 50 from v_ingredient_stock where ingredient_id = '22222222-0000-0000-0000-000000000002'))))) as c3 \gset
select public.fo_count_due(null) as fd \gset
select test.chk(test.op('shift_close', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000005a3', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 0))->>'status' = 'ok',
  'D: milk counted -> closes');
reset role;
select test.chk(:'c3'::jsonb->>'status' = 'ok' and (select coalesce(review_reason, '') !~ 'COUNT_INCOMPLETE' from stock_counts where id = 'd1600000-0000-0000-0000-0000000000f3')
  and jsonb_array_length(:'fd'::jsonb->'items') = 0, 'D: counting only the due item is complete; the count''s own lines don''t make it due again',
  coalesce((select review_reason from stock_counts where id = 'd1600000-0000-0000-0000-0000000000f3'), '') || :'fd');
-- 7 days later (the counts were received 7 days ago): both are due again (RECHECK)
update stock_counts set received_at = received_at - interval '7 days' where business_id = :'biz';
update inventory_transactions set created_at = created_at where false;
alter table inventory_transactions disable trigger inventory_transactions_received;
update inventory_transactions set received_at = received_at - interval '7 days' where business_id = :'biz';
alter table inventory_transactions enable trigger inventory_transactions_received;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.bo_count_status() as bs \gset
reset role;
select test.chk((select bool_and((x->>'due')::boolean and x->>'why' = 'RECHECK' and x->>'last_counted_at' is not null) from jsonb_array_elements(:'bs'::jsonb) x), 'D: 7 days after the last count: due again (RECHECK)', :'bs');
update settings set count_recheck_days = 8 where business_id = :'biz';
select test.chk((select count(*) = 0 from public._count_due(:'biz', null) d where d.why is not null), 'D: with 8 re-check days nothing is due yet');
update settings set count_recheck_days = 7 where business_id = :'biz';
-- a purchase in the Back Office makes the beans due (MOVED)
insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) values (:'biz', '22222222-0000-0000-0000-000000000001', 'PURCHASE', 500, current_date);
update settings set count_recheck_days = 30 where business_id = :'biz';
select test.chk((select string_agg(d.why, ',') = 'MOVED' and bool_and(d.ingredient_id = '22222222-0000-0000-0000-000000000001') from public._count_due(:'biz', null) d where d.why is not null), 'D: a purchase makes the beans due (MOVED)');
update settings set count_recheck_days = 7 where business_id = :'biz';
-- only ticked items may be counted (as 1.5)
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.bo_count_status()$$) = 'NOT_ALLOWED', 'D: a counter can''t call bo_count_status');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.fo_count_due(null)$$) = 'NOT_ALLOWED', 'D: fo_count_due is for paired counters only');
reset role;
select test.chk((select count(*) = 0 from information_schema.routine_privileges where routine_schema = 'public' and grantee in ('anon', 'PUBLIC')
  and routine_name in ('accounting_report','senior_report','bo_count_status','fo_count_due','_fo_apply_16','_count_due','_payment_method','_valid_payment_methods')), 'G: nothing new is callable without signing in');
select test.chk((select count(*) = 0 from information_schema.routine_privileges where routine_schema = 'public' and grantee = 'authenticated'
  and routine_name in ('_fo_apply_16','_count_due','_payment_method','_valid_payment_methods','_stamp_stock_received')), 'G: helpers are not callable through the API');
update ingredients set count_at_close = false where business_id = :'biz';

-- =====================================================================================================
-- Part 2: Z's security-gate probes (2026-11-13)
-- =====================================================================================================
-- ---- Z1: money written in a form the database reads as a number but the server's own reader (_to_num) does not
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select business_id as bizb from profiles where id = '00000000-0000-0000-0000-0000000000b1' \gset
update settings set service_charge_pct = 0 where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.op('shift_open', jsonb_build_object('id','d1600000-0000-0000-0000-0000000005b1','shift_number','SHIFT-Z-0001',
  'cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0))->>'status' = 'ok', 'Z setup: shift opened');
\set sh 'd1600000-0000-0000-0000-0000000005b1'
-- Z1: numbers written in a form ::numeric reads but _to_num does not
select test.sale16('16000000-0000-0000-0000-0000000000a1', '[{"id":"e1600000-0000-0000-0000-0000000000a1","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":150}]',
  '{"subtotal":150,"service_charge_amount":0,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":"+150","grand_total":0}', 'CASH', null, :'sh') as r \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'error', 'Z1: senior_discount "+150" with no name/ID is refused', :'r' || ' sale=' || coalesce((select row(senior_discount, grand_total, needs_review, review_reason)::text from sales where id = '16000000-0000-0000-0000-0000000000a1'),'-') || ' records=' || (select count(*) from senior_discount_records where sale_id = '16000000-0000-0000-0000-0000000000a1'));
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale16('16000000-0000-0000-0000-0000000000a2', '[{"id":"e1600000-0000-0000-0000-0000000000a2","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":75}]',
  '{"subtotal":150,"service_charge_amount":0,"senior_kind":"PWD","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":"0x4B","grand_total":75}', 'CASH', null, :'sh') as r \gset
reset role;
select test.chk(:'r'::jsonb->>'status' = 'error', 'Z1b: senior_discount "0x4B" (=75) with no name/ID is refused', :'r' || ' sale=' || coalesce((select row(senior_discount, grand_total, needs_review, review_reason)::text from sales where id = '16000000-0000-0000-0000-0000000000a2'),'-'));
-- Z1c: same root cause, older fields: subtotal etc as "+..." -> money review reads 0
update settings set tax_pct = 12, tax_inclusive = false where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale16('16000000-0000-0000-0000-0000000000a3', '[{"id":"e1600000-0000-0000-0000-0000000000a3","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]',
  '{"subtotal":"+150","service_charge_amount":0,"tax_amount":0,"grand_total":150}', 'CASH', null, :'sh') as r \gset
reset role;
update settings set tax_pct = 0 where business_id = :'biz';
select test.chk(:'r'::jsonb->>'status' = 'error' or (select needs_review and review_reason ~ 'TAX_MISMATCH' from sales where id = '16000000-0000-0000-0000-0000000000a3'), 'Z1c: subtotal "+150" and no tax in a 12% shop is refused or flagged', :'r' || coalesce((select review_reason from sales where id = '16000000-0000-0000-0000-0000000000a3'),' (no flag)'));
-- Z1d: payment_fee hidden from the money review
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale16('16000000-0000-0000-0000-0000000000a4', '[{"id":"e1600000-0000-0000-0000-0000000000a4","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]',
  '{"subtotal":150,"service_charge_amount":0,"payment_fee":"+0","payment_charge":0,"grand_total":150}', 'GCASH', null, :'sh') as r \gset
reset role;
-- 1.6 gate fix 1 (_num_strict; changed 2026-11-13, approved by C): a fee written "+0" is now refused outright (was: saved + flagged CHARGE_MISMATCH)
select test.chk(:'r'::jsonb->>'message' = 'SALE_TOTALS_MISMATCH' and not exists (select 1 from sales where id = '16000000-0000-0000-0000-0000000000a4'), 'Z1d: a fee written "+0" is refused (SALE_TOTALS_MISMATCH), nothing saved', :'r');
-- Z2: where do the name / ID end up?  (checked from the shell with pg_dump)
-- Z3: rights
select test.chk(count(*) = 0, 'Z3: no function in public is callable by anon that was not before', string_agg(p.oid::regprocedure::text, ', '))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')
   and p.proname in ('_stamp_stock_received','_valid_payment_methods','_payment_method','_settings_check','_count_due','fo_count_due','bo_count_status','_fo_error_code','_fo_apply_16','_fo_apply_15','_fo_apply','fo_sync','accounting_report','senior_report','_check_sale_totals','_sale_money_review','_lock_finished_sale','_refund_items_cap');
select test.chk(count(*) = 0, 'Z3: no helper (_...) is callable by authenticated or anon', string_agg(p.oid::regprocedure::text, ', '))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
select test.chk(count(*) = 0, 'Z3: every SECURITY DEFINER function in public has a fixed search_path', string_agg(p.oid::regprocedure::text, ', '))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
select test.chk(count(*) = 0, 'Z3: every table in public has RLS on', string_agg(c.relname, ', ')) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity;
select test.chk(not has_table_privilege('anon', 'public.senior_discount_records', 'select,insert,update,delete,truncate,references,trigger')
  and not has_table_privilege('authenticated', 'public.senior_discount_records', 'select,insert,update,delete,truncate,references,trigger')
  and (select count(*) = 0 from pg_policies where tablename = 'senior_discount_records'), 'Z3: senior_discount_records: no rights for anon / authenticated, no policy');
select test.chk((select string_agg(pg_get_constraintdef(oid), ' | ') from pg_constraint where conrelid = 'public.payments'::regclass and contype = 'c') = $$CHECK (((method IS NULL) OR (method ~ '^[A-Z][A-Z0-9_]{1,19}$'::text)))$$, 'Z3: payments has exactly one CHECK rule (the format rule)', (select string_agg(conname || ': ' || pg_get_constraintdef(oid), ' | ') from pg_constraint where conrelid = 'public.payments'::regclass and contype = 'c'));
-- Z4: owner via apply_changes on the records table
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"delete","table":"senior_discount_records","id":"00000000-0000-0000-0000-000000000001"}]')$$) <> 'NO ERROR', 'Z4: apply_changes can''t touch senior_discount_records', test.err($$select public.apply_changes('[{"op":"delete","table":"senior_discount_records","id":"00000000-0000-0000-0000-000000000001"}]')$$));
select test.chk(not (public.bo_bootstrap()::text ~ 'SC-0012345'), 'Z4: bo_bootstrap does not carry ID numbers');
reset role;
-- Z5: counter rights on settings / records
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$insert into public.senior_discount_records(business_id, sale_id, kind, holder_name, id_number) select business_id, id, 'SENIOR', 'x y', '123' from sales limit 1$$) like '%permission denied%', 'Z5: a counter can''t write the records table');
with u as (update public.settings set senior_discount_pct = 100 returning 1) select test.chk(count(*) = 0, 'Z5: a counter can''t change the settings (Senior %)') from u;
with u as (update public.settings set payment_methods = '[{"id":"CASH","label":"Cash","active":true,"charge_type":"NONE","charge_value":0}]' returning 1) select test.chk(count(*) = 0, 'Z5: a counter can''t change the payment methods') from u;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"senior_discount_pct":100}}]')$$) <> 'NO ERROR', 'Z5: a counter can''t use apply_changes');
with u as (update public.inventory_transactions set quantity = quantity returning 1) select test.chk(count(*) = 0, 'Z5: a counter can''t update stock lines directly') from u;
select test.chk(public.fo_count_due((select id from shifts where business_id = :'bizb' limit 1))->'items' = public.fo_count_due(null)->'items', 'Z5: another shop''s shift id changes nothing in fo_count_due');
reset role;
-- Z6: other shop's owner
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select public.accounting_report((now() at time zone 'Asia/Manila')::date - 2, (now() at time zone 'Asia/Manila')::date) as arb \gset
select test.chk(jsonb_array_length(public.bo_count_status()) = 0 or not exists (select 1 from jsonb_array_elements(public.bo_count_status()) x join ingredients i on i.id = (x->>'ingredient_id')::uuid where i.business_id = :'biz'), 'Z6: another shop''s owner sees none of this shop''s count status');
reset role;
select test.chk((:'arb'::jsonb->'totals'->>'sale_count')::int = (select count(*) from sales where business_id = :'bizb' and status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED') and (coalesce(transaction_date, created_at) at time zone 'Asia/Manila')::date >= (now() at time zone 'Asia/Manila')::date - 2)
  and jsonb_array_length(:'arb'::jsonb->'waived_list') = 0 and (:'arb'::jsonb->'totals'->>'payment_fees')::numeric = 0, 'Z6: another shop''s accounting_report has none of this shop''s money', :'arb'::jsonb->>'totals');
select test.login(null); set role anon;
select test.chk(test.err($$select public.accounting_report(current_date, current_date)$$) like '%permission denied%' and test.err($$select public.senior_report(current_date, current_date)$$) like '%permission denied%'
  and test.err($$select public.fo_count_due(null)$$) like '%permission denied%' and test.err($$select public.bo_count_status()$$) like '%permission denied%' and test.err($$select count(*) from public.senior_discount_records$$) like '%permission denied%', 'Z6: anon can call none of the new functions nor read the records');
reset role;
-- ---- ZR: refunds through fo_sync on the mixed Senior + GCash-charge sale 13 (paid 302.94; Senior line share 134.64, other 168.30).
--      (The refund checks of 004 allow 1-2 centavos of rounding, so "too large" is tried 3 centavos above.)
\set sh 'd1600000-0000-0000-0000-0000000005b1'
create or replace function test.refund16(p_id uuid, p_sale uuid, p_type text, p_amount numeric, p_items jsonb) returns jsonb language sql as $f$
  select test.op('refund', jsonb_build_object('refund', jsonb_build_object('id', p_id, 'sale_id', p_sale, 'type', p_type, 'amount', p_amount, 'items', p_items,
     'approved_by','66666666-0000-0000-0000-000000000002','performed_by','66666666-0000-0000-0000-000000000002','date', now()),
     'approval_token', (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token', 'inventory', '[]'::jsonb))
$f$;
grant execute on all functions in schema test to anon, authenticated;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.refund16('f1600000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000013', 'PARTIAL_REFUND', 134.67, '[{"sale_item_id":"e1600000-0000-0000-0000-000000000013","quantity":1}]') as r1 \gset
select test.chk(:'r1'::jsonb->>'message' = 'REFUND_TOO_LARGE', 'ZR: 3 centavos above the Senior line''s share -> REFUND_TOO_LARGE', :'r1');
select test.refund16('f1600000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000013', 'PARTIAL_REFUND', 134.64, '[{"sale_item_id":"e1600000-0000-0000-0000-000000000013","quantity":1}]') as r2 \gset
select test.chk(:'r2'::jsonb->>'status' = 'ok', 'ZR: the Senior line''s share exactly (134.64) is refunded', :'r2');
select test.refund16('f1600000-0000-0000-0000-000000000002', '16000000-0000-0000-0000-000000000013', 'PARTIAL_REFUND', 134.64, '[{"sale_item_id":"e1600000-0000-0000-0000-000000000013","quantity":1}]') as r3 \gset
select test.chk(:'r3'::jsonb->>'status' = 'error', 'ZR: the same Senior line a second time is refused', :'r3');
select test.refund16('f1600000-0000-0000-0000-000000000003', '16000000-0000-0000-0000-000000000013', 'PARTIAL_REFUND', 168.33, '[{"sale_item_id":"e1600000-0000-0000-0000-000000000014","quantity":1}]') as r4 \gset
select test.chk(:'r4'::jsonb->>'message' = 'REFUND_TOO_LARGE', 'ZR: the rest + 3 centavos -> REFUND_TOO_LARGE', :'r4');
select test.refund16('f1600000-0000-0000-0000-000000000003', '16000000-0000-0000-0000-000000000013', 'PARTIAL_REFUND', 168.30, '[{"sale_item_id":"e1600000-0000-0000-0000-000000000014","quantity":1}]') as r5 \gset
reset role;
select test.chk(:'r5'::jsonb->>'status' = 'ok' and (select sum(amount) = 302.94 from refunds where sale_id = '16000000-0000-0000-0000-000000000013') and (select status = 'REFUNDED' from sales where id = '16000000-0000-0000-0000-000000000013'),
  'ZR: both lines refunded = exactly what was paid (302.94), sale REFUNDED', :'r5' || (select status from sales where id = '16000000-0000-0000-0000-000000000013'));
-- tax on top (sale 17, paid 315): the two shares never add up to more than was paid.
-- Z finding (2026-11-13, CLAUDE.md security decision 6: a partial refund gives back what the customer actually paid for
-- those items): the Senior line was paid 132.00 (120 + 12 service, no tax) but the contract-B formula gives 140.00; the other
-- line was paid 183.00 (150 + 18 tax + 15 service) and gets 175.00. Fails until _refund_items_cap / refundAmountForItems
-- count the tax only on the lines that carried it.
select test.chk(public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000017","quantity":1}]', 315) between 131.98 and 132.02,
  'ZR: tax on top: the Senior line''s refund share = what was paid for it (132.00: no tax on it)',
  public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000017","quantity":1}]', 315)::text) from sales s where s.id = '16000000-0000-0000-0000-000000000017';
select test.chk(public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000017","quantity":1}]', 315)
  + public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000018","quantity":1}]', 315) <= 315.00,
  'ZR: tax on top: the two lines'' refund shares together are not above what was paid (315.00)') from sales s where s.id = '16000000-0000-0000-0000-000000000017';
select test.chk(public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000015","quantity":1}]', 117.85) = 117.85, 'ZR: VAT-inclusive Senior sale: the line = everything paid') from sales s where s.id = '16000000-0000-0000-0000-000000000015';
select test.chk(public._refund_items_cap(s, gen_random_uuid(), '[{"sale_item_id":"e1600000-0000-0000-0000-000000000013","quantity":5}]', 50) <= 50, 'ZR: a share is never above what is left of the sale, whatever quantity is named') from sales s where s.id = '16000000-0000-0000-0000-000000000013';
-- void of a Senior sale: it leaves the report
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.refund16('f1600000-0000-0000-0000-000000000004', '16000000-0000-0000-0000-000000000011', 'VOID', 132, null) as r6 \gset
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(:'r6'::jsonb->>'status' = 'ok' and not (public.senior_report((now() at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date)::text ~ 'SC-0012345'), 'ZR: a voided Senior sale leaves the report', :'r6');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"sales","row":{"id":"16000000-0000-0000-0000-000000000012","senior_items_amount":1}}]')$$) ~ 'SALE_LOCKED', 'ZL: the owner can''t change senior_items_amount of a finished sale');
reset role;
-- HELD sale with Senior fields, then finished
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('sale', jsonb_build_object('sale', jsonb_build_object('id','16000000-0000-0000-0000-0000000000c1','transaction_number','POS-A-2026-0000c1','transaction_date', now(),'status','HELD','cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','shift_id', :'sh',
   'subtotal',150,'senior_kind','SENIOR','senior_items_amount',150,'senior_discount',30,'grand_total',120),
   'items','[{"id":"e1600000-0000-0000-0000-0000000000c1","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30}]'::jsonb,
   'senior','{"kind":"SENIOR","holder_name":"Held Person","id_number":"H-1"}'::jsonb, 'inventory','[]'::jsonb)) as h1 \gset
select test.sale16('16000000-0000-0000-0000-0000000000c1', '[{"id":"e1600000-0000-0000-0000-0000000000c1","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30}]',
  '{"subtotal":150,"service_charge_amount":0,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"grand_total":120}', 'CASH', null, :'sh') as h2 \gset
reset role;
select test.chk(:'h1'::jsonb->>'status' = 'ok' and :'h2'::jsonb->>'message' = 'BAD_SENIOR' and (select count(*) = 0 from senior_discount_records where sale_id = '16000000-0000-0000-0000-0000000000c1'),
  'ZH: a held Senior sale saves no record; finishing it without the name + ID -> BAD_SENIOR', :'h1' || :'h2');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale16('16000000-0000-0000-0000-0000000000c1', '[{"id":"e1600000-0000-0000-0000-0000000000c1","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30}]',
  '{"subtotal":150,"service_charge_amount":0,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"grand_total":120}', 'CASH', '{"kind":"SENIOR","holder_name":"Held Person","id_number":"H-1"}', :'sh') as h3 \gset
reset role;
select test.chk(:'h3'::jsonb->>'status' = 'ok' and (select count(*) = 1 from senior_discount_records where sale_id = '16000000-0000-0000-0000-0000000000c1' and holder_name = 'Held Person'),
  'ZH: finished with the name + ID: one record', :'h3');
-- a sale id of ANOTHER shop
insert into sales(id, business_id, status, grand_total, subtotal) select 'bbbb0000-0000-0000-0000-00000000aa01', business_id, 'HELD', 0, 0 from profiles where id = '00000000-0000-0000-0000-0000000000b1';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale16('bbbb0000-0000-0000-0000-00000000aa01', '[{"id":"e1600000-0000-0000-0000-0000000000c2","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30}]',
  '{"subtotal":150,"service_charge_amount":0,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"grand_total":120}', 'CASH', '{"kind":"SENIOR","holder_name":"Cross Shop","id_number":"X-1"}', :'sh') as x1 \gset
select test.chk(not (test.sale16('16000000-0000-0000-0000-0000000000c3', '[]', '{"subtotal":150,"senior_kind":"SENIOR","senior_items_amount":150,"senior_discount":30,"grand_total":120}', 'CASH', '{"kind":"SENIOR","holder_name":"Leaky Name","id_number":"LEAK-1"}', :'sh')::text ~ 'Leaky|LEAK'), 'ZE: a refused Senior sale''s answer doesn''t echo the name / ID');
reset role;
select test.chk(:'x1'::jsonb->>'status' = 'error' and (select count(*) = 0 from senior_discount_records where holder_name = 'Cross Shop') and (select status = 'HELD' and grand_total = 0 from sales where id = 'bbbb0000-0000-0000-0000-00000000aa01'),
  'ZX: a Senior sale naming another shop''s sale id is refused: no record, that sale untouched', :'x1');
-- the name / ID are stored in ONE place only
select test.chk((select count(*) = 0 from sales where to_jsonb(sales)::text ~ 'Lola Remedios|SC-0012345|Held Person|H-1"') and (select count(*) = 0 from sync_operations where to_jsonb(sync_operations)::text ~ 'Lola Remedios|SC-0012345|Held Person')
  and (select count(*) = 0 from audit_log where to_jsonb(audit_log)::text ~ 'Lola Remedios|SC-0012345|Held Person') and (select count(*) = 0 from sale_items where to_jsonb(sale_items)::text ~ 'Lola Remedios|SC-0012345|Held Person'),
  'ZE: the name / ID are in no sales, sale_items, sync_operations or audit_log row');
-- ---- ZC / ZF: smart count + received_at
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
\set sh 'd1600000-0000-0000-0000-0000000005b1'
\set beans '22222222-0000-0000-0000-000000000001'
\set milk '22222222-0000-0000-0000-000000000002'
update ingredients set count_at_close = (id in (:'beans', :'milk')) where business_id = :'biz';
update settings set count_recheck_days = 60 where business_id = :'biz';
-- bring both to "counted, nothing due": one count of both for shift b1
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('stock_count', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000000e1', 'shift_id', :'sh', 'staff_id', '66666666-0000-0000-0000-000000000001', 'counted_at', now(),
  'lines', jsonb_build_array(jsonb_build_object('ingredient_id', :'beans','quantity', (select stock from v_ingredient_stock where ingredient_id = :'beans')),
                             jsonb_build_object('ingredient_id', :'milk','quantity', (select stock from v_ingredient_stock where ingredient_id = :'milk'))))) as c0 \gset
select test.chk(:'c0'::jsonb->>'status' = 'ok' and jsonb_array_length(public.fo_count_due(null)->'items') = 0, 'ZC setup: both counted, nothing due', :'c0');
select test.chk(test.op('shift_close', jsonb_build_object('id', :'sh', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 0))->>'status' = 'ok', 'ZC setup: shift closed');
select test.chk(test.op('shift_open', jsonb_build_object('id','d1600000-0000-0000-0000-0000000005b2','shift_number','SHIFT-Z-0002','cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0))->>'status' = 'ok', 'ZC: shift 2 opened');
-- ONE upload (one transaction) of an offline counter: a sale using milk, the count of the milk, then ANOTHER sale using milk
select public.fo_sync('device-key-0001-abcdef', jsonb_build_array(
  jsonb_build_object('op_id', gen_random_uuid(), 'type', 'sale', 'data', jsonb_build_object(
    'sale', jsonb_build_object('id', '16000000-0000-0000-0000-0000000000d1', 'transaction_number', 'POS-A-2026-0000d1', 'transaction_date', now(), 'status', 'COMPLETED','cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy Cashier', 'shift_id', 'd1600000-0000-0000-0000-0000000005b2',
       'subtotal', 150, 'discount_amount', 0, 'loyalty_discount', 0, 'tax_amount', 0, 'service_charge_amount', 0, 'grand_total', 150),
    'items', '[{"id":"e1600000-0000-0000-0000-0000000000d1","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]'::jsonb,
    'payment', jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', 150),
    'inventory', jsonb_build_array(jsonb_build_object('id','e1600000-0000-0000-0000-0000000000d2','ingredient_id', :'milk','quantity',150,'transaction_date', current_date)))),
  jsonb_build_object('op_id', gen_random_uuid(), 'type', 'stock_count', 'data', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000000e2', 'shift_id', 'd1600000-0000-0000-0000-0000000005b2', 'staff_id', '66666666-0000-0000-0000-000000000001', 'counted_at', now(),
    'lines', jsonb_build_array(jsonb_build_object('ingredient_id', :'milk','quantity', 1)))),
  jsonb_build_object('op_id', gen_random_uuid(), 'type', 'shift_close', 'data', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000005b2', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 150)),
  jsonb_build_object('op_id', gen_random_uuid(), 'type', 'shift_open', 'data', jsonb_build_object('id','d1600000-0000-0000-0000-0000000005b3','shift_number','SHIFT-Z-0003','cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0)),
  jsonb_build_object('op_id', gen_random_uuid(), 'type', 'sale', 'data', jsonb_build_object(
    'sale', jsonb_build_object('id', '16000000-0000-0000-0000-0000000000d3', 'transaction_number', 'POS-A-2026-0000d3', 'transaction_date', now(), 'status', 'COMPLETED','cashier_id', '66666666-0000-0000-0000-000000000001', 'cashier_name', 'Cathy Cashier', 'shift_id', 'd1600000-0000-0000-0000-0000000005b3',
       'subtotal', 150, 'discount_amount', 0, 'loyalty_discount', 0, 'tax_amount', 0, 'service_charge_amount', 0, 'grand_total', 150),
    'items', '[{"id":"e1600000-0000-0000-0000-0000000000d3","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]'::jsonb,
    'payment', jsonb_build_object('id', gen_random_uuid(), 'method', 'CASH', 'amount', 150),
    'inventory', jsonb_build_array(jsonb_build_object('id','e1600000-0000-0000-0000-0000000000d4','ingredient_id', :'milk','quantity',150,'transaction_date', current_date)))))) as batch \gset
select public.fo_count_due('d1600000-0000-0000-0000-0000000005b3') as fd \gset
select test.op('shift_close', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000005b3', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 150)) as cl \gset
reset role;
select test.chk((select bool_and(x->>'status' = 'ok') from jsonb_array_elements(:'batch'::jsonb) x), 'ZC: the batch (sale, count, close, open, sale) is all ok', :'batch');
select test.chk(:'fd'::jsonb->'items' @> to_jsonb(:'milk'::text), 'ZC: milk sold AFTER its count in the same upload is due again', :'fd');
select test.chk(:'cl'::jsonb->>'message' = 'COUNT_REQUIRED', 'ZC: ... so the next shift can''t close without counting it', :'cl');
-- a count of a NOT-due ticked item only: closes but flagged
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('shift_open', jsonb_build_object('id','d1600000-0000-0000-0000-0000000005b4','shift_number','SHIFT-Z-0004','cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0)) as o4 \gset
reset role;
insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) values (:'biz', :'milk', 'PURCHASE', 10, current_date);
select test.chk((select string_agg(ingredient_id::text, ',') = :'milk' from public._count_due(:'biz', null) where why = 'MOVED'), 'ZC: a purchase makes only the milk due');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('stock_count', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000000e4', 'shift_id', 'd1600000-0000-0000-0000-0000000005b4', 'staff_id', '66666666-0000-0000-0000-000000000001', 'counted_at', now(),
  'lines', jsonb_build_array(jsonb_build_object('ingredient_id', :'beans','quantity', (select stock from v_ingredient_stock where ingredient_id = :'beans'))))) as c4 \gset
select test.op('shift_close', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000005b4', 'closed_by', '66666666-0000-0000-0000-000000000001', 'closed_at', now(), 'declared_cash', 0)) as cl4 \gset
select public.fo_count_due(null) as fd4 \gset
reset role;
select test.chk(:'c4'::jsonb->>'status' = 'ok' and :'cl4'::jsonb->>'status' = 'ok' and (select needs_review and review_reason ~ 'COUNT_INCOMPLETE' and (length(review_reason) - length(replace(review_reason, 'COUNT_INCOMPLETE', ''))) = 16 from stock_counts where id = 'd1600000-0000-0000-0000-0000000000e4')
  and :'fd4'::jsonb->'items' @> to_jsonb(:'milk'::text), 'ZC: counting only an item that is not due: the shift closes, the count is flagged once, the milk stays due',
  :'c4' || :'cl4' || coalesce((select review_reason from stock_counts where id = 'd1600000-0000-0000-0000-0000000000e4'), '-') || :'fd4');
-- a count sent for an already CLOSED shift does not go unnoticed
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('stock_count', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000000e5', 'shift_id', 'd1600000-0000-0000-0000-0000000005b4', 'staff_id', '66666666-0000-0000-0000-000000000001', 'counted_at', now(),
  'lines', jsonb_build_array(jsonb_build_object('ingredient_id', :'milk','quantity', 0)))) as c5 \gset
reset role;
select test.chk(:'c5'::jsonb->>'status' = 'ok' and (select review_reason ~ 'SHIFT_CLOSED' from stock_counts where id = 'd1600000-0000-0000-0000-0000000000e5'), 'ZC: a count for a closed shift is flagged SHIFT_CLOSED', :'c5');
-- received_at forgery by the owner / counter
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.err($$select public.apply_changes('[{"op":"upsert","table":"inventory_transactions","row":{"id":"e1600000-0000-0000-0000-0000000000f1","ingredient_id":"22222222-0000-0000-0000-000000000001","transaction_type":"ADJUSTMENT","quantity":1,"transaction_date":"2026-11-13","received_at":"2020-01-01T00:00:00Z","created_at":"2020-01-01T00:00:00Z"}}]')$$) as e1 \gset
select test.err($$select public.apply_changes('[{"op":"update","table":"inventory_transactions","row":{"id":"e1600000-0000-0000-0000-0000000000f1","received_at":"2020-01-01T00:00:00Z"}}]')$$) as e2 \gset
reset role;
select test.chk((select received_at > now() - interval '1 minute' from inventory_transactions where id = 'e1600000-0000-0000-0000-0000000000f1'), 'ZF: Back Office insert / update can''t back-date received_at', :'e1' || ' / ' || :'e2' || ' ' || coalesce((select received_at::text from inventory_transactions where id = 'e1600000-0000-0000-0000-0000000000f1'), 'no row'));
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('waste', jsonb_build_object('id','d1600000-0000-0000-0000-0000000000a9','reason','SPILLAGE','staff_id','66666666-0000-0000-0000-000000000001','received_at','2020-01-01T00:00:00Z','created_at','2020-01-01T00:00:00Z','date','2020-01-01',
  'items', jsonb_build_array(jsonb_build_object('ingredient_id', :'beans','quantity',1,'unit','g','received_at','2020-01-01T00:00:00Z')))) as w1 \gset
reset role;
select test.chk(:'w1'::jsonb->>'status' = 'ok' and (select bool_and(received_at > now() - interval '1 minute') from inventory_transactions where reference_id = 'd1600000-0000-0000-0000-0000000000a9'), 'ZF: a counter waste entry can''t back-date received_at', :'w1');
update settings set count_recheck_days = 7 where business_id = :'biz';
-- ---- ZS: payment method list validation
create or replace function test.pm(p text) returns text language sql as $f$ select test.err(format($$update settings set payment_methods = %L::jsonb where business_id = (select business_id from profiles where id = '00000000-0000-0000-0000-0000000000a1')$$, p)) $f$;
\set cash '{"id":"CASH","label":"Cash","active":true,"charge_type":"NONE","charge_value":0}'
select test.chk(test.pm('[' || :'cash' || ',{"id":"X1","label":"' || repeat('a', 25) || '","active":true,"charge_type":"NONE"}]') = 'BAD_PAYMENT_METHODS', 'ZS: 25-character label refused');
select test.chk(test.pm('[' || :'cash' || ',{"id":"X1","label":"a\nb","active":true,"charge_type":"NONE"}]') = 'BAD_PAYMENT_METHODS', 'ZS: label with a line break refused');
select test.chk(test.pm('[' || :'cash' || ',{"id":"X1","label":"ok","active":"true","charge_type":"NONE"}]') = 'BAD_PAYMENT_METHODS', 'ZS: active as text refused');
select test.chk(test.pm('[' || :'cash' || ',{"id":"X1","label":"ok","active":true,"charge_type":"PERCENT","charge_value":"2"}]') = 'BAD_PAYMENT_METHODS', 'ZS: charge value as text refused');
select test.chk(test.pm('[' || :'cash' || ',{"id":"X1","label":"ok","active":true,"charge_type":"FIXED","charge_value":1000.01}]') = 'BAD_PAYMENT_METHODS', 'ZS: fixed charge above 1000 refused');
select test.chk(test.pm('[' || :'cash' || ',{"id":"X1","label":"ok","active":true,"charge_type":"FIXED","charge_value":-5}]') = 'BAD_PAYMENT_METHODS', 'ZS: negative charge refused');
select test.chk(test.pm('[' || :'cash' || ',{"id":"X1","label":"ok","active":true,"charge_type":"NONE","charge_value":3}]') = 'BAD_PAYMENT_METHODS', 'ZS: NONE with a value refused');
select test.chk(test.pm('[' || :'cash' || ',{"id":"X1","label":"ok","active":true,"charge_type":"NONE","charge_default":"MAYBE"}]') = 'BAD_PAYMENT_METHODS', 'ZS: unknown charge_default refused');
select test.chk(test.pm('[' || :'cash' || ',{"id":"' || 'A' || repeat('B', 20) || '","label":"ok","active":true,"charge_type":"NONE"}]') = 'BAD_PAYMENT_METHODS', 'ZS: 21-character id refused');
select test.chk(test.pm('[' || :'cash' || ',{"id":"X1; drop table x","label":"ok","active":true,"charge_type":"NONE"}]') = 'BAD_PAYMENT_METHODS', 'ZS: id with other characters refused');
select test.chk(test.pm('[' || :'cash' || ',"GCASH"]') = 'BAD_PAYMENT_METHODS', 'ZS: an item that is not an object refused');
select test.chk(test.pm('[' || :'cash' || (select string_agg(',{"id":"M' || g || '","label":"m","active":true,"charge_type":"NONE"}', '') from generate_series(1, 12) g) || ']') = 'BAD_PAYMENT_METHODS', 'ZS: 13 methods refused');
select test.chk(test.pm('null') = 'BAD_PAYMENT_METHODS' and test.pm('"x"') = 'BAD_PAYMENT_METHODS', 'ZS: null / text refused');
select test.chk(test.err($$update settings set senior_discount_pct = -1$$) = 'BAD_SENIOR_PCT' and test.err($$update settings set senior_discount_pct = 'NaN'$$) = 'BAD_SENIOR_PCT' and test.err($$update settings set count_recheck_days = 61$$) = 'BAD_RECHECK_DAYS', 'ZS: Senior % -1 / NaN and 61 re-check days refused', test.err($$update settings set senior_discount_pct = 'NaN'$$));
select payment_methods as keep from settings where business_id = :'biz' \gset
select test.pm('[' || :'cash' || ',{"id":"X1","label":"<b>x</b>","active":true,"charge_type":"PERCENT","charge_value":25,"extra":{"a":1},"reference":true}]') as good \gset
select test.chk(:'good' = 'NO ERROR' and (select payment_methods->1 = '{"id":"X1","label":"<b>x</b>","active":true,"reference":true,"charge_type":"PERCENT","charge_value":25,"charge_default":"ADD"}'::jsonb from settings where business_id = :'biz'), 'ZS: a good list is saved in the standard shape (unknown keys dropped; labels are plain text for the pages to escape)', (select payment_methods::text from settings where business_id = :'biz'));
update settings set payment_methods = :'keep' where business_id = :'biz';
update ingredients set count_at_close = false where business_id = :'biz';

-- =====================================================================================================
-- Part 3: B2 investors + start-up costs (013 section 7b): the database work's 12 checks + Z's
-- =====================================================================================================
-- ============================ I. investors + start-up costs (B2) ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select (public.accounting_report(date_trunc('month', now() at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date)->'totals'->>'net_income') as ni_before \gset
select (public.net_income_report(date_trunc('month', now() at time zone 'Asia/Manila')::date)->>'net_income') as nir_before \gset
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000001","name":"Mama Lorna","amount":50000,"invested_on":"2026-08-01"}},
  {"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000002","name":"Jake","amount":30000}},
  {"op":"upsert","table":"startup_costs","row":{"id":"16c00000-0000-0000-0000-000000000011","name":"Milesto EM19-M4","amount":29990,"category":"EQUIPMENT","cost_date":"2026-08-05"}},
  {"op":"upsert","table":"startup_costs","row":{"id":"16c00000-0000-0000-0000-000000000012","name":"sent to jek","amount":3000,"category":"SENT_TO_STAFF"}}]')$$) = 'NO ERROR', 'I: owner adds 2 investors and 2 start-up costs');
select test.chk((select count(*) = 2 from public.investors) and (select sum(amount) = 32990 from public.startup_costs), 'I: owner reads them back');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000003","name":" mama lorna ","amount":1}}]')$$) like '%investors_name_key%' or test.err($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000003","name":" mama lorna ","amount":1}}]')$$) like '%duplicate%', 'I: the same name twice is refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000004","name":"Zero","amount":0}}]')$$) like '%amount_check%', 'I: amount 0 refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"startup_costs","row":{"id":"16c00000-0000-0000-0000-000000000013","name":"x","amount":5,"category":"PARTY"}}]')$$) like '%category_check%', 'I: unknown category refused');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000002","name":"Jake Cruz","amount":35000}},{"op":"delete","table":"startup_costs","id":"16c00000-0000-0000-0000-000000000012"}]')$$) = 'NO ERROR', 'I: edit + delete accepted');
select test.chk((select amount = 35000 and name = 'Jake Cruz' from public.investors where id = '16c00000-0000-0000-0000-000000000002') and (select count(*) = 1 from public.startup_costs), 'I: owner edits an investor and deletes a cost');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk((public.accounting_report(date_trunc('month', now() at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date)->'totals'->>'net_income') = :'ni_before'
  and (public.net_income_report(date_trunc('month', now() at time zone 'Asia/Manila')::date)->>'net_income') = :'nir_before',
  'I: start-up costs change neither accounting_report''s nor net_income_report''s net income (Z: replaces an always-true check)');
reset role;
-- a counter and another shop see nothing; nobody signed in sees nothing
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk((select count(*) = 0 from public.investors) and (select count(*) = 0 from public.startup_costs), 'I: a counter reads no investors or start-up costs');
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000005","name":"Hacker","amount":1}}]')$$) <> 'NO ERROR', 'I: a counter can''t add an investor');
reset role;
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.chk((select count(*) = 0 from public.investors), 'I: another shop''s owner reads none');
select test.chk(test.err($$update public.investors set amount = 1$$) = 'NO ERROR' and (select count(*) = 0 from public.investors where amount = 1), 'I: another shop''s owner changes none');
reset role;
select test.login(null); set role anon;
select test.chk(test.err($$select count(*) from public.investors$$) like '%permission denied%' and test.err($$select count(*) from public.startup_costs$$) like '%permission denied%', 'I: no access without signing in');
reset role;
select test.chk((select amount = 35000 from investors where id = '16c00000-0000-0000-0000-000000000002'), 'I: still 35000 after the other shop''s try');
-- ---- Z (2026-11-13): investors + start-up costs, more refusals and rights
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000021","name":"Big","amount":100000000.01}}]')$$) like '%amount_check%'
  and test.err($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000021","name":"Big","amount":"NaN"}}]')$$) <> 'NO ERROR'
  and test.err($$select public.apply_changes('[{"op":"upsert","table":"startup_costs","row":{"id":"16c00000-0000-0000-0000-000000000022","name":"Big","amount":"Infinity","category":"OTHER"}}]')$$) <> 'NO ERROR'
  and test.err($$select public.apply_changes('[{"op":"upsert","table":"startup_costs","row":{"id":"16c00000-0000-0000-0000-000000000022","name":"Neg","amount":-5,"category":"OTHER"}}]')$$) <> 'NO ERROR',
  'ZI: amounts above ₱100,000,000, NaN, Infinity and negative are refused');
select test.chk(test.err(format($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000023","name":"A%sB","amount":1}}]')$$, '\u0007')) like '%name_check%'
  and test.err($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000023","name":"   ","amount":1}}]')$$) like '%name_check%'
  and test.err(format($$select public.apply_changes('[{"op":"upsert","table":"startup_costs","row":{"id":"16c00000-0000-0000-0000-000000000024","name":"x","amount":1,"notes":"%s"}}]')$$, repeat('n', 501))) like '%notes_check%',
  'ZI: a name with a control character or only spaces, and notes over 500 characters, are refused');
-- another shop's owner can't put a row into THIS shop (apply_changes sets their own shop)
reset role;
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.err(format($$select public.apply_changes('[{"op":"upsert","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000025","business_id":"%s","name":"Planted","amount":7}}]')$$, :'biz')) as planted \gset
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"investors","row":{"id":"16c00000-0000-0000-0000-000000000002","amount":1}}]')$$) <> 'NO ERROR'
  or (select count(*) = 0 from public.investors where id = '16c00000-0000-0000-0000-000000000002'), 'ZI: another shop''s owner can''t edit this shop''s investor through apply_changes');
reset role;
select test.chk((select count(*) = 0 from investors where id = '16c00000-0000-0000-0000-000000000025' and business_id = :'biz')
  and (select amount = 35000 from investors where id = '16c00000-0000-0000-0000-000000000002'), 'ZI: ... nor plant a row in this shop (row lands in their own shop or is refused)', :'planted');
-- a counter: no direct read / write either
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err(format($$insert into public.investors(business_id, name, amount) values ('%s', 'Direct', 1)$$, :'biz')) <> 'NO ERROR'
  and test.err($$insert into public.startup_costs(name, amount) values ('Direct', 1)$$) <> 'NO ERROR', 'ZI: a counter can''t insert into either table directly');
with u as (update public.startup_costs set amount = 1 returning 1) select test.chk(count(*) = 0, 'ZI: a counter can''t update start-up costs') from u;
with d as (delete from public.investors returning 1) select test.chk(count(*) = 0, 'ZI: a counter can''t delete investors') from d;
select test.chk(not (public.fo_bootstrap('device-key-0001-abcdef')::text ~ 'Mama Lorna|Milesto'), 'ZI: fo_bootstrap carries no investor or start-up cost');
reset role;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(not has_table_privilege('anon', 'public.investors', 'select') and not has_table_privilege('anon', 'public.startup_costs', 'insert')
  and (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.investors'::regclass, 'public.startup_costs'::regclass)), 'ZI: RLS on both tables; no rights for anon');
reset role;
select test.chk((select count(*) from investors where business_id = :'biz') = 2 and (select count(*) from startup_costs where business_id = :'biz') = 1, 'ZI: after all the tries: this shop still has 2 investors and 1 start-up cost');

-- =====================================================================================================
-- Part 4: "weighs" on bought items too (013 section 7c, owner 2026-11-13): the database work's 3 checks + Z's
-- =====================================================================================================
-- ============================ W. "weighs" on bought items (owner 2026-11-13) ============================
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"ingredients","row":{"id":"22222222-0000-0000-0000-000000000002","weight_g_per_ml":1.03}}]')$$) = 'NO ERROR', 'W: a bought item (milk, mL) may now say how much it weighs');
reset role;
select test.chk((select weight_g_per_ml = 1.03 and not coalesce(is_produced_item, false) from ingredients where id = '22222222-0000-0000-0000-000000000002'), 'W: saved on the bought item');
select test.chk(test.err($$update ingredients set base_unit = 'pcs' where id = '22222222-0000-0000-0000-000000000002'$$) = 'WEIGHS_BAD_UNIT', 'W: still refused for an item counted in pieces');
update ingredients set weight_g_per_ml = null where id = '22222222-0000-0000-0000-000000000002';
-- Z: a recipe line typed in grams on a bought item with weighs is converted; without weighs it is still BAD_UNIT
update ingredients set weight_g_per_ml = 1.03 where id = '22222222-0000-0000-0000-000000000002';
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"recipe_ingredients","row":{"id":"16d00000-0000-0000-0000-000000000001","recipe_id":"33333333-0000-0000-0000-000000000001","ingredient_id":"22222222-0000-0000-0000-000000000002","entered_quantity":103,"unit":"g","quantity":0}}]')$$) = 'NO ERROR', 'ZW: 103 g of the bought milk on a recipe line is accepted');
reset role;
select test.chk((select quantity = 100 from recipe_ingredients where id = '16d00000-0000-0000-0000-000000000001'), 'ZW: ... saved as 100 mL (1.03 g/mL)', (select quantity::text from recipe_ingredients where id = '16d00000-0000-0000-0000-000000000001'));
update ingredients set weight_g_per_ml = 1.0 where id = '22222222-0000-0000-0000-000000000002';
select test.chk((select quantity = 103 from recipe_ingredients where id = '16d00000-0000-0000-0000-000000000001'), 'ZW: weighs changed on the bought item -> the line is converted again (103 mL)');
delete from recipe_ingredients where id = '16d00000-0000-0000-0000-000000000001';
update ingredients set weight_g_per_ml = null where id = '22222222-0000-0000-0000-000000000002';
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"upsert","table":"recipe_ingredients","row":{"id":"16d00000-0000-0000-0000-000000000002","recipe_id":"33333333-0000-0000-0000-000000000001","ingredient_id":"22222222-0000-0000-0000-000000000002","entered_quantity":5,"unit":"g","quantity":5}}]')$$) like 'BAD_UNIT%', 'ZW: without weighs, grams on a mL item are still BAD_UNIT');
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"ingredients","row":{"id":"22222222-0000-0000-0000-000000000002","weight_g_per_ml":-1}}]')$$) <> 'NO ERROR'
  or (select weight_g_per_ml is null from ingredients where id = '22222222-0000-0000-0000-000000000002'), 'ZW: a negative weighs is not saved');
reset role;
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
with u as (update public.ingredients set weight_g_per_ml = 5 returning 1) select test.chk(count(*) = 0, 'ZW: a counter can''t set weighs') from u;
reset role;


-- =====================================================================================================
-- Part 5: rechecks of the gate fixes (commit eeac8b8, Z 2026-11-13)
-- =====================================================================================================
-- fix 8a: an owner edit of an OLD stock line's amount makes the item due again (MOVED); a note-only edit doesn't
update ingredients set count_at_close = (id = '22222222-0000-0000-0000-000000000001') where business_id = :'biz';
update settings set count_recheck_days = 60 where business_id = :'biz';
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.op('shift_open', jsonb_build_object('id','d1600000-0000-0000-0000-0000000005f1','shift_number','SHIFT-Z5-0001','cashier_id','66666666-0000-0000-0000-000000000001','cashier_name','Cathy Cashier','opened_at', now(),'opening_cash',0))->>'status' as so \gset
select test.op('stock_count', jsonb_build_object('id', 'd1600000-0000-0000-0000-0000000000f9', 'shift_id', 'd1600000-0000-0000-0000-0000000005f1', 'staff_id', '66666666-0000-0000-0000-000000000001', 'counted_at', now(),
  'lines', jsonb_build_array(jsonb_build_object('ingredient_id','22222222-0000-0000-0000-000000000001','quantity', (select stock from v_ingredient_stock where ingredient_id = '22222222-0000-0000-0000-000000000001'))))) ->>'status' as sc \gset
reset role;
select test.chk(:'so' = 'ok' and :'sc' = 'ok' and (select count(*) = 0 from public._count_due(:'biz', null) where why is not null), 'Z5: set-up: beans counted, nothing due', :'so' || :'sc');
select id as oldline from inventory_transactions where business_id = :'biz' and ingredient_id = '22222222-0000-0000-0000-000000000001' and transaction_type = 'PURCHASE' order by received_at limit 1 \gset
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.err(format($$select public.apply_changes('[{"op":"update","table":"inventory_transactions","row":{"id":"%s","notes":"just a note"}}]')$$, :'oldline')) as e1 \gset
reset role;
select test.chk(:'e1' = 'NO ERROR' and (select count(*) = 0 from public._count_due(:'biz', null) where why is not null), 'Z5 (fix 8a): a note-only edit of an old stock line does not make the item due', :'e1');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.err(format($$select public.apply_changes('[{"op":"update","table":"inventory_transactions","row":{"id":"%s","quantity":999}}]')$$, :'oldline')) as e2 \gset
reset role;
select test.chk(:'e2' = 'NO ERROR' and (select string_agg(why, ',') = 'MOVED' from public._count_due(:'biz', null) where why is not null), 'Z5 (fix 8a): an owner edit of an old stock line''s amount makes the item due (MOVED)', :'e2');
update settings set count_recheck_days = 7 where business_id = :'biz';
update ingredients set count_at_close = false where business_id = :'biz';
-- fix 6: the Senior / PWD record and the report name the cashier from the staff list, not what the counter typed
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.sale16('16000000-0000-0000-0000-0000000000e1', '[{"id":"e1600000-0000-0000-0000-0000000000e1","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"senior_discount":30}]',
  '{"subtotal":150,"service_charge_amount":0,"senior_kind":"SENIOR","senior_items_amount":150,"vat_exempt_amount":0,"senior_discount":30,"grand_total":120,"cashier_name":"Manny Manager"}', 'CASH', '{"kind":"SENIOR","holder_name":"Name Check","id_number":"SC-N-1"}', 'd1600000-0000-0000-0000-0000000005f1')->>'status' as nc \gset
reset role;
select test.chk(:'nc' = 'ok' and (select cashier_name = 'Cathy Cashier' from senior_discount_records where sale_id = '16000000-0000-0000-0000-0000000000e1'), 'Z5 (fix 6): the Senior / PWD record names the real cashier (Cathy), not the typed "Manny Manager"',
  :'nc' || ' ' || coalesce((select cashier_name from senior_discount_records where sale_id = '16000000-0000-0000-0000-0000000000e1'), '-'));
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk((select bool_and(x->>'cashier_name' = 'Cathy Cashier') from jsonb_array_elements(public.senior_report((now() at time zone 'Asia/Manila')::date, (now() at time zone 'Asia/Manila')::date)) x where x->>'holder_name' = 'Name Check'), 'Z5 (fix 6): ... and so does senior_report');
reset role;
-- fix 1: other number forms are refused as well (NaN, a number written with spaces inside, a hex quantity)
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.sale16('16000000-0000-0000-0000-0000000000e2', '[{"id":"e1600000-0000-0000-0000-0000000000e2","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]', '{"subtotal":150,"service_charge_amount":0,"grand_total":"NaN"}', 'CASH', null, 'd1600000-0000-0000-0000-0000000005f1')->>'message' = 'SALE_TOTALS_MISMATCH'
  and test.sale16('16000000-0000-0000-0000-0000000000e3', '[{"id":"e1600000-0000-0000-0000-0000000000e3","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":"0x1","unit_price":150,"line_total":150}]', '{"subtotal":150,"service_charge_amount":0,"grand_total":150}', 'CASH', null, 'd1600000-0000-0000-0000-0000000005f1')->>'message' = 'SALE_TOTALS_MISMATCH',
  'Z5 (fix 1): a grand total "NaN" or a quantity "0x1" is refused (SALE_TOTALS_MISMATCH)');
select test.chk(test.sale16('16000000-0000-0000-0000-0000000000e4', '[{"id":"e1600000-0000-0000-0000-0000000000e4","recipe_id":"33333333-0000-0000-0000-000000000001","name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150}]', '{"subtotal":150,"service_charge_amount":0,"grand_total":150}', 'CASH', null, 'd1600000-0000-0000-0000-0000000005f1')->>'status' = 'ok',
  'Z5 (fix 1): a plain sale still goes through');
reset role;
