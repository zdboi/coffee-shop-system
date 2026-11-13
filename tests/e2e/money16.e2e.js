// Release 1.6 money reconciliation (Z, 2026-11-13). Sales rung up on the COUNTER screens (its shared maths:
// computeSaleTotals with the payment charge and Senior / PWD lines); partial refunds uploaded through fo_sync
// by the same paired counter with a manager approval (server caps: _refund_items_cap); then the server tables,
// accounting_report, the Back Office Accounting overview and the Sales calendar must agree to the centavo.
// Seed: tests/sql/20_seed_e2e.sql (Americano 110 = 18 g beans at ₱0.90/g; Ensaymada 65, PASTRY, no stock lines).
// Payment methods: GCash 2% (added by default), Card ₱15 (waived by default). Senior / PWD 20%. Service charge 0.
//
// Phase 1, no tax:
//   S1 2 Americano, GCash, charge added       fee = charge = 4.40          total 224.40
//   S2 1 Americano, GCash, charge UNticked    fee 2.20, charge 0           total 110.00
//   S3 1 Ensaymada, Card (waived by default)  fee 15.00, charge 0          total  65.00
// Phase 2, prices include 12% VAT:
//   S4 2 Americano, Senior on ONE (line split), cash
//        A 110, VAT out 110 - 110/1.12 = 11.79, 20% of 98.21 = 19.64, tax 0      total 188.57
// Phase 3, 12% tax added on top:
//   S5 Americano + Ensaymada, PWD on the Ensaymada, GCash added
//        A 65, VAT out 0, 20% = 13.00, base 162, tax 12% of (162 - 52) = 13.20, pre 175.20, fee 3.50   total 178.70
// Partial refunds (manager approval), share = returned value x grand total / (subtotal - VAT out - Senior discount):
//   R1 S1, 1 Americano:            110 x 224.40 / 220     = 112.20   (beans +18 g)
//   R2 S4, the NON-Senior Americano: 110 x 188.57 / 188.57 = 110.00   (beans +18 g)
//   R3 S5, the PWD Ensaymada:        52 x 178.70 / 162     =  57.36   (57.39 refused first: REFUND_TOO_LARGE)
// Today: sales 766.67 · refunds 279.56 · net sales 487.11 · payment charges 7.90 · fees 25.10 · waived 17.20
//        Senior/PWD discounts 32.64 · VAT exempt 11.79 · tax 13.20 · tax owed 13.20 - 57.36 x 13.20 / 178.70 = 8.96
//        ingredients sold 6 x 18 g = 108 g (97.20) - 36 g back (32.40) = 64.80
//        net income 487.11 - 8.96 - 25.10 - 64.80 = 388.25
//   by method: GCASH 3 sales 513.10 (charges 7.90, fees 10.10, waived 2.20) · CARD 1 sale 65.00 (fee 15, waived 15)
//              CASH 1 sale 188.57
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/money16.e2e.js
const H = require('./lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, one, rows, ok, must, typePin} = H;
const NAME = 'money16.e2e';
const eq2 = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const BEANS = '22222222-0000-0000-0000-000000000001';
const AMERICANO = '33333333-0000-0000-0000-000000000003', ENSAYMADA = '33333333-0000-0000-0000-000000000004';
const MANNY = '66666666-0000-0000-0000-000000000002';
const biz = sql(`select business_id from profiles where id = '00000000-0000-0000-0000-0000000000a1'`);
const METHODS = `[{"id":"CASH","label":"Cash","active":true,"charge_type":"NONE","charge_value":0},
  {"id":"GCASH","label":"GCash","active":true,"reference":true,"charge_type":"PERCENT","charge_value":2,"charge_default":"ADD"},
  {"id":"QR","label":"QR payment","active":true,"reference":true,"charge_type":"NONE","charge_value":0},
  {"id":"CARD","label":"Card","active":true,"reference":true,"charge_type":"FIXED","charge_value":15,"charge_default":"WAIVE"},
  {"id":"BANK","label":"Bank transfer","active":true,"reference":true,"charge_type":"NONE","charge_value":0}]`;
sql(`update settings set service_charge_pct = 0, tax_pct = 0, tax_inclusive = false, senior_discount_pct = 20, payment_methods = '${METHODS}'::jsonb where business_id = '${biz}'`);
sql(`update ingredients set count_at_close = false where business_id = '${biz}'`);
const today = () => sql(`select (now() at time zone 'Asia/Manila')::date`);
// as the owner / as the paired counter (the stand-in's JWT claims, like the API)
const lastLine = (t) => String(t).trim().split('\n').pop();
const asOwner = (q) => lastLine(sql(`select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false); set role authenticated; ${q}`));
function refundOp(dev, saleId, amount, items, inventory){
  return JSON.parse(lastLine(sql(`select set_config('request.jwt.claims', json_build_object('sub', '${dev.auth_user_id}', 'role', 'authenticated')::text, false);
    select set_config('request.headers', '{}', false); set role authenticated;
    select (public.fo_sync('${dev.device_key}', jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'type', 'refund', 'data', jsonb_build_object(
      'refund', jsonb_build_object('id', gen_random_uuid(), 'sale_id', '${saleId}', 'type', 'PARTIAL_REFUND', 'amount', ${amount}, 'reason', 'money16',
        'items', '${JSON.stringify(items)}'::jsonb, 'approved_by', '${MANNY}', 'performed_by', '${MANNY}', 'date', now()),
      'approval_token', (public.staff_pin_login('222222', 'OVERRIDE', 'MANAGER'))->>'token',
      'inventory', '${JSON.stringify(inventory)}'::jsonb))))->0)::text`)));
}

(async () => {
  await H.waitClearOfManilaMidnight(40);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila'});
  const page = await ctx.newPage();
  const errors = []; H.attach(page, errors, 'FO');
  ctx.on('page', p => { if(p !== page) p.waitForLoadState().then(() => p.close()).catch(() => {}); });
  const add = async (name, n) => { for(let i = 0; i < (n || 1); i++){ await page.click(`.pos-product-card:has-text("${name}")`); await page.waitForTimeout(250);
    if(await page.$('#active-modal-overlay')){ const b = await page.$('#active-modal-overlay .btn-primary'); if(b) await b.click(); await page.waitForTimeout(250); } } };
  const closeModals = async () => { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(300);
    if(await page.$('#active-modal-overlay')) await page.click('#active-modal-overlay [data-cancel], #active-modal-overlay [data-close]').catch(() => {}); await page.waitForTimeout(200); };
  const nSales = () => Number(sql(`select count(*) from sales where business_id = '${biz}' and status = 'COMPLETED'`));
  const finish = async (n) => { await page.click('#complete-sale-btn'); await must(() => nSales() === n, `sale ${n} uploaded`, 20000); await closeModals(); };
  const pay = async (method, opts) => {
    await page.click('#checkout-btn'); await page.waitForSelector('#pay-methods');
    if(method !== 'CASH'){ await page.click(`[data-method="${method}"]`); await page.waitForTimeout(200); }
    if(opts && opts.untick) await page.uncheck('#pay-charge-add');
    const due = H.money(await page.textContent('#due-val'));
    if(method === 'CASH') await page.click('[data-quick]'); else await page.check('#pay-confirmed');
    return due;
  };
  const senior = async (kind, name, idno, lineText, qty) => {
    await page.click('#senior-add'); await page.waitForSelector('#sn-save');
    if(kind === 'PWD') await page.click('[data-kind="PWD"]');
    await page.fill('#sn-name', name); await page.fill('#sn-id', idno);
    await page.check(`.sn-item:has-text("${lineText}") [data-sn-line]`);
    if(qty){ const q = await page.$(`.sn-item:has-text("${lineText}") [data-sn-qty]`); if(q) await q.fill(String(qty)); }
    await page.click('#sn-save'); await page.waitForTimeout(300);
  };
  const reloadCounter = async () => {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app').style.display === 'flex' || document.getElementById('pin-gate').style.display === 'flex', null, {timeout: 20000});
    if(!(await page.isVisible('#app'))){ await typePin(page, '1111'); await page.waitForSelector('#app', {state: 'visible'}); }
    await page.waitForSelector('.pos-product-card', {timeout: 15000});
  };
  const sale = (n) => one(`select s.*, (select method from payments p where p.sale_id = s.id limit 1) as method from sales s
                           where business_id = '${biz}' and status <> 'HELD' order by created_at, transaction_number offset ${n - 1} limit 1`);
  try{
    await H.pairCounter(page, 'TESTAB');
    await typePin(page, '1111');
    await H.startShift(page, 1000);
    // ---- phase 1: no tax
    await add('Americano', 2); let due = await pay('GCASH'); await finish(1);
    let s = sale(1);
    ok(eq2(due, 224.40) && eq2(s.grand_total, 224.40) && eq2(s.payment_fee, 4.40) && eq2(s.payment_charge, 4.40) && s.method === 'GCASH' && !s.needs_review, 'S1 GCash added: 224.40 (fee = charge = 4.40), not flagged', s);
    await add('Americano', 1); due = await pay('GCASH', {untick: true}); await finish(2);
    s = sale(2);
    ok(eq2(due, 110) && eq2(s.grand_total, 110) && eq2(s.payment_fee, 2.20) && eq2(s.payment_charge, 0) && !s.needs_review, 'S2 GCash waived: 110.00, fee 2.20 kept, not flagged', s);
    await add('Ensaymada', 1); due = await pay('CARD'); await finish(3);
    s = sale(3);
    ok(eq2(due, 65) && eq2(s.grand_total, 65) && eq2(s.payment_fee, 15) && eq2(s.payment_charge, 0) && s.method === 'CARD' && !s.needs_review, 'S3 Card waived by default: 65.00, fee 15.00', s);
    // ---- phase 2: prices include 12% VAT
    sql(`update settings set tax_pct = 12, tax_inclusive = true where business_id = '${biz}'`);
    await reloadCounter();
    await add('Americano', 2); await senior('SENIOR', 'Lola Money', 'SC-160001', 'Americano', 1);
    due = await pay('CASH'); await finish(4);
    s = sale(4);
    ok(eq2(due, 188.57) && eq2(s.grand_total, 188.57) && eq2(s.vat_exempt_amount, 11.79) && eq2(s.senior_discount, 19.64) && eq2(s.senior_items_amount, 110) && eq2(s.tax_amount, 0) && !s.needs_review,
       'S4 VAT inclusive, Senior on 1 of 2: VAT out 11.79, 20% 19.64, total 188.57, not flagged', s);
    const s4items = rows(`select id, quantity, senior_discount from sale_items where sale_id = '${s.id}' order by senior_discount`);
    ok(s4items.length === 2 && eq2(s4items[0].senior_discount, 0) && eq2(s4items[1].senior_discount, 31.43), 'S4: the line was split; the Senior line carries 31.43 (11.79 + 19.64)', s4items);
    // ---- phase 3: 12% tax added on top
    sql(`update settings set tax_pct = 12, tax_inclusive = false where business_id = '${biz}'`);
    await reloadCounter();
    await add('Americano', 1); await add('Ensaymada', 1); await senior('PWD', 'Juan Money', 'PWD-160002', 'Ensaymada');
    due = await pay('GCASH'); await finish(5);
    s = sale(5);
    ok(eq2(due, 178.70) && eq2(s.grand_total, 178.70) && eq2(s.senior_discount, 13) && eq2(s.tax_amount, 13.20) && eq2(s.payment_fee, 3.50) && eq2(s.payment_charge, 3.50) && s.senior_kind === 'PWD' && !s.needs_review,
       'S5 tax on top, PWD Ensaymada, GCash: tax 13.20 (Americano only), fee 3.50, total 178.70, not flagged', s);
    ok(sql(`select count(*) from senior_discount_records where business_id = '${biz}'`) === '2', 'two Senior / PWD records (S4, S5)');
    ok(Number(sql(`select coalesce(sum(abs(quantity)), 0) from inventory_transactions where ingredient_id = '${BEANS}' and transaction_type = 'SALE_USAGE'`)) === 108, 'beans: 6 Americanos = 108 g used');

    // ---- partial refunds through fo_sync (the same paired counter, manager approval)
    const dev = one(`select auth_user_id, device_key from devices where business_id = '${biz}' and active order by created_at desc limit 1`);
    const it = (n, recipe, seniorLine) => sql(`select id from sale_items where sale_id = '${sale(n).id}' and recipe_id = '${recipe}' ${seniorLine === undefined ? '' : seniorLine ? 'and senior_discount > 0' : 'and senior_discount = 0'} limit 1`);
    const inv = (g) => [{id: require('crypto').randomUUID(), ingredient_id: BEANS, quantity: g, transaction_date: today()}];
    let r = refundOp(dev, sale(1).id, 112.20, [{sale_item_id: it(1, AMERICANO), quantity: 1}], inv(18));
    ok(r.status === 'ok', 'R1: 1 of 2 Americanos of the GCash-charged sale: 112.20 (half the charge too)', r);
    r = refundOp(dev, sale(4).id, 110.00, [{sale_item_id: it(4, AMERICANO, false), quantity: 1}], inv(18));
    ok(r.status === 'ok', 'R2: the non-Senior Americano of the VAT-inclusive Senior sale: 110.00', r);
    r = refundOp(dev, sale(5).id, 57.39, [{sale_item_id: it(5, ENSAYMADA), quantity: 1}], []);
    ok(r.message === 'REFUND_TOO_LARGE', 'R3: 3 centavos above the PWD line\'s share is refused (REFUND_TOO_LARGE)', r);
    r = refundOp(dev, sale(5).id, 57.36, [{sale_item_id: it(5, ENSAYMADA), quantity: 1}], []);
    ok(r.status === 'ok', 'R3: the PWD Ensaymada: 57.36', r);
    ok(sql(`select string_agg(status, ',' order by created_at, transaction_number) from sales where business_id = '${biz}' and status <> 'HELD'`) === 'PARTIALLY_REFUNDED,COMPLETED,COMPLETED,PARTIALLY_REFUNDED,PARTIALLY_REFUNDED',
       'sale statuses: S1, S4, S5 partly refunded');

    // ---- the server tables (hand math)
    const T = one(`select round(sum(grand_total), 2) as sales, round(sum(payment_charge), 2) as charges, round(sum(payment_fee), 2) as fees,
                          round(sum(senior_discount), 2) as senior, round(sum(vat_exempt_amount), 2) as vat, round(sum(tax_amount), 2) as tax,
                          (select round(sum(amount), 2) from refunds where business_id = '${biz}') as refunds
                   from sales where business_id = '${biz}' and status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')`);
    ok(eq2(T.sales, 766.67) && eq2(T.refunds, 279.56) && eq2(T.charges, 7.90) && eq2(T.fees, 25.10) && eq2(T.senior, 32.64) && eq2(T.vat, 11.79) && eq2(T.tax, 13.20),
       'tables: sales 766.67, refunds 279.56, charges 7.90, fees 25.10, Senior/PWD 32.64, VAT exempt 11.79, tax 13.20', T);
    // ---- accounting_report (owner) = the tables = hand math
    const d = today();
    const A = JSON.parse(asOwner(`select public.accounting_report('${d}', '${d}')::text`));
    const t = A.totals;
    ok(eq2(t.sales, T.sales) && eq2(t.refunds, T.refunds) && eq2(t.payment_charges, T.charges) && eq2(t.payment_fees, T.fees) && eq2(t.senior_discounts, T.senior) && eq2(t.vat_exempt, T.vat) && eq2(t.tax, T.tax),
       'accounting_report totals = the tables', t);
    ok(eq2(t.net_sales, 487.11) && eq2(t.charges_waived, 17.20) && eq2(t.tax_owed, 8.96) && eq2(t.ingredients_sold, 64.80) && eq2(t.net_income, 388.25) && t.sale_count === 5 && t.void_count === 0,
       'accounting_report: net sales 487.11, waived 17.20, tax owed 8.96, ingredients 64.80, net income 388.25', t);
    ok(A.days.length === 1 && eq2(A.days[0].sales, t.sales) && eq2(A.days[0].net_income, t.net_income) && eq2(A.days[0].refunds, t.refunds), 'the one day row = the totals', A.days);
    const pm = Object.fromEntries(A.payment_methods.map(m => [m.method, m]));
    ok(pm.GCASH && pm.GCASH.count === 3 && eq2(pm.GCASH.total, 513.10) && eq2(pm.GCASH.charges, 7.90) && eq2(pm.GCASH.fees, 10.10) && eq2(pm.GCASH.waived, 2.20)
       && pm.CARD && pm.CARD.count === 1 && eq2(pm.CARD.total, 65) && eq2(pm.CARD.waived, 15) && pm.CASH && pm.CASH.count === 1 && eq2(pm.CASH.total, 188.57),
       'by method: GCash 3 / 513.10 / waived 2.20 · Card 1 / 65.00 / waived 15.00 · Cash 1 / 188.57', A.payment_methods);
    ok(A.waived_list.length === 2 && eq2(A.waived_list.reduce((x, w) => x + Number(w.amount), 0), 17.20), 'waived list: S2 (2.20) + S3 (15.00)', A.waived_list);
    const sr = JSON.parse(asOwner(`select public.senior_report('${d}', '${d}')::text`));
    ok(sr.length === 2 && eq2(sr.reduce((x, r) => x + Number(r.discount) + Number(r.vat_exempt), 0), 32.64 + 11.79), 'senior_report: 2 sales, discounts + VAT out = 44.43 (= accounting)', sr);

    // ---- Back Office screens show the same numbers
    const boCtx = await browser.newContext({viewport: {width: 1280, height: 900}, timezoneId: 'Asia/Manila'});
    const bo = await boCtx.newPage(); H.attach(bo, errors, 'BO');
    await H.boLogin(bo);
    await bo.evaluate(() => navigate('netIncome')); await bo.waitForSelector('#ac-table', {timeout: 15000}); await bo.waitForTimeout(800);
    // this month: the shop has no other sales, so the month = today
    const acc = await bo.textContent('#ac-body');
    ok(['₱766.67', '₱279.56', '₱487.11', '₱388.25', '₱25.10', '₱8.96'].every(x => acc.includes(x)), 'Accounting overview (this month): 766.67 sales, 279.56 refunds, 487.11 net sales, 388.25 net income, 25.10 fees, 8.96 tax owed', acc.slice(0, 900));
    await H.shot(bo, 'money16-accounting', {fullPage: true});
    await bo.evaluate(() => navigate('calendar')); await bo.waitForSelector('.cal-split', {timeout: 15000}); await bo.waitForTimeout(800);
    await bo.click(`[data-pick="${d}"]`); await bo.waitForTimeout(800);
    await bo.click(`[data-pick="${d}"]`).catch(() => {}); await bo.waitForTimeout(1500);   // one day = start and end on the same day
    const det = await bo.textContent('.cal-details');
    ok(['₱766.67', '₱487.11', '₱388.25', '₱279.56'].every(x => det.includes(x)), 'Sales calendar, today: sales 766.67, net sales 487.11, net income 388.25, refunds 279.56 (= the overview)', det.slice(0, 900));
    await H.shot(bo, 'money16-calendar', {fullPage: false});
  }catch(e){ ok(false, 'stopped: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); await H.shot(page, 'money16-abort'); }
  ok(errors.length === 0, 'no console errors', errors.slice(0, 6));
  const rc = H.summary(NAME);
  await browser.close();
  process.exit(rc);
})();
