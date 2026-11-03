// Release 1.4 money / stock / cash reconciliation across the counter and the Back Office, on ONE database
// (QA, 2026-11-03; like money12). Fresh e2e seed + the 1.4 counter seed tests/sql/22_seed_release14_fo.sql
// (applied here): library groups "Hot / Iced" (required; Iced +₱10 = cup + lid) and "Milk" (swap dairy -> Oat +₱30),
// Hot / Iced unticked on Americano. Settings: tax 12% (added on top), service 10%, weighted-average costing.
// Unit costs: beans ₱0.90/g, milk ₱0.10/mL (seed 5 L for ₱500), oat ₱0.20/mL, cup ₱5, lid ₱2.
// Recipes: Iced Latte 150 = beans 18 g + milk 180 mL; own groups Size (12oz +0, 16oz +20 = +60 mL milk), Extra shot +30 (+18 g beans).
//
// Back Office before the shift: supplied item "Ube Cheese Pandesal" (cost ₱25, price ₱45, restock 24 pcs).
// Counter (cashier Cathy, opening cash ₱1,000):
//   S1 Iced Latte Iced 12oz Oat  190, cash     tax 22.80 svc 19.00 = 231.80  stock beans 18, oat 180, cup 1, lid 1 (no dairy)
//   S2 Iced Latte Hot 16oz Oat + shot 230, GCash  tax 27.60 svc 23.00 = 280.60  beans 36, oat 180, milk 60 (the swap
//      takes away only the recipe's 180 mL; the 16oz +60 mL stays dairy, per contract 1.4 "removes = the recipe's lines")
//   S3 Americano x2 + Ensaymada 285, cash      tax 34.20 svc 28.50 = 347.70  beans 36
//   S4 Ube Cheese Pandesal x2 90, cash         tax 10.80 svc  9.00 = 109.80  pandesal 2 pcs
//   refund ONE Americano from S3 (manager PIN): 110 x 347.70 / 285 = 134.20, beans 18 back (tax share 134.20 x 34.20 / 347.70 = 13.20)
//   W1 waste SPILLAGE: Iced Latte Iced 12oz            beans 18, milk 180, cup 1, lid 1
//   W2 waste COMPLIMENTARY (manager PIN): beans 18 g
//   close shift: expected cash 1000 + 231.80 + 347.70 + 109.80 - 134.20 = 1,555.10 (counted the same, variance 0)
// Back Office after the shift:
//   merge dairy Milk (mL) + "Arla milk" (L; bought 5 L for ₱700 today) into a new "Full Cream Milk" (mL):
//      every stock line moves over -> one ingredient at (500 + 700) / (5000 + 5000) = ₱0.12/mL
//   buy foil (an Operating supplies item) for ₱150 -> a SUPPLIES expense, no stock; expenses Rent 5,000 + Utilities 1,234.56
// Net income for this month (hand math):
//   gross 231.80 + 280.60 + 347.70 + 109.80 = 969.90 · refunds 134.20 · tax 95.40 - 13.20 = 82.20 · net 753.50
//   sold: usage beans 90 g = 81.00, oat 360 = 72.00, milk 60 x 0.12 = 7.20, cup 5, lid 2, pandesal 2 x 25 = 50 -> 217.20
//         minus refund beans 18 = 16.20 -> 201.00
//   wasted (month-end costs): beans 36 = 32.40, milk 180 x 0.12 = 21.60, cup 5, lid 2 -> 61.00 · used 262.00
//   expenses 150 + 5000 + 1234.56 = 6,384.56 · net income 753.50 - 262.00 - 6384.56 = -5,893.06
// Waste report (cost stored when logged, at THAT day's costs, before the merge): W1 16.20 + 18.00 + 5 + 2 = 41.20, W2 16.20 -> 57.40
// Stock at the end: beans 1000 - 90 + 18 - 36 = 892 · Full Cream Milk 5000 + 5000 - 60 - 180 = 9,760 mL · oat 640 · cups 48 · lids 48 · pandesal 22
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/money14.e2e.js
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./lib/h');
const B = require('./bo/bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const {sql, one, rows, ok, must, until, typePin, money, r2} = H;
const NAME = 'money14.e2e';
const BEANS = '22222222-0000-0000-0000-000000000001', MILK = '22222222-0000-0000-0000-000000000002';
const OAT = '22222222-0000-0000-0000-0000000000a1', CUP = '22222222-0000-0000-0000-0000000000a2', LID = '22222222-0000-0000-0000-0000000000a3';
const ARLA = '2414bbbb-0000-0000-0000-000000000001', FOIL = '2414bbbb-0000-0000-0000-000000000002';
const LATTE = '33333333-0000-0000-0000-000000000001', AMER = '33333333-0000-0000-0000-000000000003';
const MANNY = '66666666-0000-0000-0000-000000000002';
const eq2 = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const stock = (id) => Number(sql(`select coalesce((select stock from v_ingredient_stock where ingredient_id='${id}'), 0)`));
const peso = (n) => (n < 0 ? '−' : '') + '₱' + Math.abs(Number(n)).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});

const X = {
  S1: {sub: 190, tax: 22.80, svc: 19.00, total: 231.80},
  S2: {sub: 230, tax: 27.60, svc: 23.00, total: 280.60},
  S3: {sub: 285, tax: 34.20, svc: 28.50, total: 347.70},
  S4: {sub: 90, tax: 10.80, svc: 9.00, total: 109.80},
  refund: 134.20, refundTax: 13.20,
};
X.gross = r2(X.S1.total + X.S2.total + X.S3.total + X.S4.total);        // 969.90
X.tax = r2(X.S1.tax + X.S2.tax + X.S3.tax + X.S4.tax - X.refundTax);    // 82.20
X.net = r2(X.gross - X.refund - X.tax);                                 // 753.50
X.sold = 201.00; X.wasted = 61.00; X.used = 262.00;
X.expenses = 6384.56;
X.netIncome = r2(X.net - X.used - X.expenses);                          // -5893.06
X.cash = r2(X.S1.total + X.S3.total + X.S4.total);                      // 689.30
X.expectedCash = r2(1000 + X.cash - X.refund);                          // 1555.10
X.wasteReport = 57.40;

async function manilaClock(){
  for(;;){
    const t = new Date(Date.now() + 8 * 3600e3);
    if(t.getUTCHours() * 60 + t.getUTCMinutes() < 23 * 60 + 45) return;
    console.log('     (waiting for Manila midnight to pass)'); await H.sleep(60000);
  }
}

(async () => {
  await manilaClock();
  execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', H.DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(__dirname, '..', 'sql', '22_seed_release14_fo.sql')], {stdio: 'ignore'});
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  sql(`update settings set tax_pct = 12, tax_inclusive = false, service_charge_pct = 10, costing_method = 'weighted_average' where business_id = '${biz}'`);
  const opsCat = sql(`select id from categories where business_id='${biz}' and name='Operating supplies' and kind='EXPENSE'`);
  ok(!!opsCat, 'shop has the "Operating supplies" category (EXPENSE)');
  sql(`insert into ingredients(id, business_id, name, base_unit) values ('${ARLA}', '${biz}', 'Arla milk', 'L')`);
  sql(`insert into purchases(id, business_id, ingredient_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit)
       values ('4514bbbb-0000-0000-0000-000000000001', '${biz}', '${ARLA}', (now() at time zone 'Asia/Manila')::date, 5, 'L', 5, 700, 140)`);
  sql(`insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date)
       values ('${biz}', '${ARLA}', 'PURCHASE', 5, '4514bbbb-0000-0000-0000-000000000001', (now() at time zone 'Asia/Manila')::date)`);
  sql(`insert into ingredients(id, business_id, name, base_unit, category_id) values ('${FOIL}', '${biz}', 'Aluminium foil', 'pcs', '${opsCat}')`);
  const start = {beans: stock(BEANS), milk: stock(MILK), oat: stock(OAT), cup: stock(CUP), lid: stock(LID), arla: stock(ARLA)};
  ok(start.beans === 1000 && start.milk === 5000 && start.oat === 1000 && start.cup === 50 && start.lid === 50 && start.arla === 5, 'starting stock: beans 1000 g, milk 5000 mL, oat 1000 mL, cups 50, lids 50, Arla 5 L', start);

  const browser = await chromium.launch();
  const errors = [];
  const bctx = await B.boContext(browser, {timezoneId: 'Asia/Manila', acceptDownloads: true});
  const bo = await bctx.newPage(); H.attach(bo, errors, 'BO');
  const bgo = async (r, p) => { await bo.evaluate(([r, p]) => navigate(r, p), [r, p == null ? null : p]); await bo.waitForTimeout(700); };
  const bgone = () => H.until(async () => !(await bo.$('#active-modal-overlay')), 15000);
  let PAN = null, shiftId = null;
  const sales = {};

  // ---------- Back Office: supplied item ----------
  try{
    await H.boLogin(bo); await bo.waitForTimeout(500);
    await bgo('recipes');
    await bo.click('#btn-new-supplied'); await bo.waitForSelector('#si-name');
    await bo.fill('#si-name', 'Ube Cheese Pandesal'); await bo.fill('#si-sub', 'Bread');
    await bo.fill('#si-cost', '25'); await bo.fill('#si-price', '45'); await bo.fill('#si-rq', '24');
    await bo.click('#si-save'); await bgone(); await bo.waitForTimeout(500);
    PAN = one(`select r.id as recipe_id, r.supplied_ingredient_id as ing from recipes r where r.name='Ube Cheese Pandesal'`);
    ok(PAN && stock(PAN.ing) === 24, 'supplied item made in the Back Office, 24 pcs in stock', PAN);
  }catch(e){ await H.shot(bo, 'money14-stopped-bo1'); await browser.close(); H.abort(NAME, e); }

  // ---------- counter ----------
  const fctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila'});
  const fo = await fctx.newPage(); H.attach(fo, errors, 'FO');
  fctx.on('page', p => { if(p !== fo) p.waitForLoadState().then(() => p.close()).catch(() => {}); });
  const go = async (route) => { await fo.click(`.nav-item[data-route="${route}"]`); await fo.waitForTimeout(250); };
  const cartTotal = async () => money(await fo.textContent('.pos-cart-summary .total'));
  const sellCash = async () => { await fo.click('#checkout-btn'); await fo.click('[data-quick]'); await fo.click('#complete-sale-btn'); };
  const done = (n, what) => must(() => Number(sql(`select count(*) from sales where shift_id='${shiftId}' and status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED','VOIDED')`)) === n, what, 20000);
  const newest = () => one(`select * from sales where shift_id='${shiftId}' and status <> 'HELD' order by created_at desc limit 1`);
  const lines = (saleId) => Object.fromEntries(rows(`select ingredient_id, sum(abs(quantity))::float8 q from inventory_transactions where reference_id = '${saleId}' and transaction_type='SALE_USAGE' group by 1`).map(r => [r.ingredient_id, r.q]));
  const savedOk = (s, x, label) => ok(s && eq2(s.subtotal, x.sub) && eq2(s.tax_amount, x.tax) && eq2(s.service_charge_amount, x.svc) && eq2(s.grand_total, x.total) && !s.needs_review,
    `${label}: saved sub ${x.sub}, tax ${x.tax}, service ${x.svc}, total ${x.total}, not flagged`, s);
  const pick = async (...opts) => { await fo.waitForSelector('.mod-opt'); for(const o of opts) await fo.click(`.mod-opt[data-opt="${o}"]`); await fo.click('#mod-add'); };
  try{
    await H.pairCounter(fo, 'TESTAB');
    await typePin(fo, '1111');
    await H.startShift(fo, 1000);
    await must(() => sql(`select count(*) from shifts where status='ACTIVE'`) === '1', 'shift on the server', 20000);
    shiftId = sql(`select id from shifts where status='ACTIVE'`);

    // S1: Iced 12oz Oat, cash
    await fo.click('.pos-product-card:has-text("Iced Latte")'); await pick('iced', 'o-12', 'oat');
    ok(eq2(await cartTotal(), X.S1.total), `S1: cart 150 + 10 + 30 = 190, + tax + service = ${peso(X.S1.total)}`, await cartTotal());
    await sellCash(); await done(1, 'S1 uploaded');
    sales.S1 = newest(); savedOk(sales.S1, X.S1, 'S1');
    const l1 = lines(sales.S1.id);
    ok(l1[BEANS] === 18 && l1[OAT] === 180 && l1[CUP] === 1 && l1[LID] === 1 && !l1[MILK], 'S1 stock: beans 18 g, oat 180 mL, cup 1, lid 1, no dairy milk', l1);

    // S2: Hot 16oz Oat + Extra shot, GCash
    await fo.click('.pos-product-card:has-text("Iced Latte")'); await pick('hot', 'o-16', 'oat', 'o-shot');
    ok(eq2(await cartTotal(), X.S2.total), `S2: cart 150 + 20 + 30 + 30 = 230, + tax + service = ${peso(X.S2.total)}`, await cartTotal());
    await fo.click('#checkout-btn'); await fo.click('[data-method="GCASH"]'); await fo.fill('#pay-ref', 'GC-1401'); await fo.check('#pay-confirmed'); await fo.click('#complete-sale-btn');
    await done(2, 'S2 uploaded');
    sales.S2 = newest(); savedOk(sales.S2, X.S2, 'S2');
    const l2 = lines(sales.S2.id);
    ok(l2[BEANS] === 36 && l2[OAT] === 180 && l2[MILK] === 60 && !l2[CUP], 'S2 stock: beans 36 g, oat 180 mL, dairy 60 mL (the 16oz extra), no cup', l2);

    // S3: Americano x2 + Ensaymada, cash
    await fo.click('.pos-product-card:has-text("Americano")'); await fo.waitForTimeout(200);
    ok(!(await fo.$('.modal .mod-opt')), 'Americano has no options (Hot / Iced unticked, no milk to swap)');
    await fo.click('.pos-product-card:has-text("Americano")'); await fo.click('.pos-product-card:has-text("Ensaymada")');
    ok(eq2(await cartTotal(), X.S3.total), `S3: cart 285, + tax + service = ${peso(X.S3.total)}`, await cartTotal());
    await sellCash(); await done(3, 'S3 uploaded');
    sales.S3 = newest(); savedOk(sales.S3, X.S3, 'S3');

    // S4: supplied item x2, cash
    await fo.evaluate(() => typeof refreshMenuQuietly === 'function' ? refreshMenuQuietly() : null).catch(() => {});
    await fo.waitForSelector('.pos-product-card:has-text("Ube Cheese Pandesal")', {timeout: 15000});
    await fo.click('.pos-product-card:has-text("Ube Cheese Pandesal")'); await fo.click('.pos-product-card:has-text("Ube Cheese Pandesal")');
    ok(eq2(await cartTotal(), X.S4.total), `S4: 2 pandesal 90, + tax + service = ${peso(X.S4.total)}`, await cartTotal());
    await sellCash(); await done(4, 'S4 uploaded');
    sales.S4 = newest(); savedOk(sales.S4, X.S4, 'S4');
    ok(lines(sales.S4.id)[PAN.ing] === 2, 'S4 stock: 2 pcs of the supplied item');

    // partial refund of one Americano from S3
    await go('sales');
    await fo.click(`tr[data-id="${sales.S3.id}"]`); await fo.click('#refund-btn');
    await fo.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(fo, '222222');
    await fo.waitForSelector('.rv-qty');
    await fo.fill('tr[data-item]:has-text("Americano") .rv-qty', '1');
    await fo.fill('#rv-reason', 'Too strong'); await fo.click('#rv-confirm');
    ok(await until(() => sql(`select count(*) from refunds where sale_id='${sales.S3.id}'`) === '1', 20000), 'S3: partial refund uploaded');
    const rf = one(`select type, amount, approved_by from refunds where sale_id='${sales.S3.id}'`);
    ok(rf.type === 'PARTIAL_REFUND' && eq2(rf.amount, X.refund) && rf.approved_by === MANNY, `refund of one Americano = ${peso(X.refund)} (110 x 347.70 / 285)`, rf);
    ok(Number(sql(`select coalesce(sum(quantity),0) from inventory_transactions where ingredient_id='${BEANS}' and transaction_type='SALE_REVERSAL'`)) === 18, 'refund put 18 g beans back');

    // W1: spillage, Iced Latte Iced 12oz
    await go('pos');
    await fo.click('#waste-btn'); await fo.waitForSelector('#waste-add-menu');
    await fo.click('#waste-add-menu'); await fo.click(`[data-wrec="${LATTE}"]`); await pick('iced', 'o-12');
    await fo.waitForSelector('[data-reason="SPILLAGE"]'); await fo.click('[data-reason="SPILLAGE"]'); await fo.click('#waste-save');
    ok(await until(() => sql(`select count(*) from waste_logs where reason='SPILLAGE'`) === '1', 20000), 'W1 spillage uploaded');
    // W2: complimentary beans 18 g (manager PIN)
    await fo.click('#waste-btn'); await fo.waitForSelector('#waste-add-ing');
    await fo.click('#waste-add-ing'); await fo.click(`[data-wing="${BEANS}"]`);
    await fo.waitForSelector('[data-wqty="0"]'); await fo.fill('[data-wqty="0"]', '18');
    await fo.click('[data-reason="COMPLIMENTARY"]'); await fo.click('#waste-save');
    await fo.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(fo, '222222');
    ok(await until(() => sql(`select count(*) from waste_logs where reason='COMPLIMENTARY'`) === '1', 20000), 'W2 complimentary uploaded');
    ok(sql(`select approved_by_name from waste_logs where reason='COMPLIMENTARY'`) === 'Manny Manager', 'W2 approved by the manager');
    const wl = Object.fromEntries(rows(`select ingredient_id, sum(abs(quantity))::float8 q from inventory_transactions where transaction_type='WASTE' and reference_id in (select id::text from waste_logs) group by 1`).map(r => [r.ingredient_id, r.q]));
    ok(wl[BEANS] === 36 && wl[MILK] === 180 && wl[CUP] === 1 && wl[LID] === 1, 'waste stock lines: beans 36 g, milk 180 mL, cup 1, lid 1', wl);
    ok(eq2(sql(`select sum(total_cost) from waste_logs`), X.wasteReport), `waste costs stored when logged: 41.20 + 16.20 = ${X.wasteReport}`, sql(`select string_agg(reason||' '||total_cost, ', ') from waste_logs`));

    // close the shift
    await go('shift');
    await fo.click('#close-shift-btn'); await fo.waitForSelector('#cs-declared');
    ok(eq2(money(await fo.textContent('.modal .drawer-card .drow.total')), X.expectedCash), `close-shift screen expects ${peso(X.expectedCash)} (1000 + cash ${X.cash} - refund ${X.refund})`, await fo.textContent('.modal .drawer-card .drow.total'));
    await fo.fill('#cs-declared', String(X.expectedCash)); await fo.click('#cs-confirm');
    await must(() => sql(`select status from shifts where id='${shiftId}'`) === 'CLOSED', 'shift closed on the server', 20000);
    const z = one(`select * from shifts where id='${shiftId}'`);
    ok(eq2(z.expected_cash, X.expectedCash) && eq2(z.declared_cash, X.expectedCash) && eq2(z.cash_variance, 0) && eq2(z.cash_sales, X.cash) && eq2(z.other_sales, X.S2.total) && eq2(z.refunds_total, X.refund),
      `Z record: expected ${peso(X.expectedCash)}, variance 0, cash ${X.cash}, GCash ${X.S2.total}, refunds ${X.refund}`, z);
    await fo.click('#active-modal-overlay [data-done]').catch(() => {});
  }catch(e){ await H.shot(fo, 'money14-stopped-counter'); await browser.close(); H.abort(NAME, e); }

  // ---------- Back Office after the shift: merge, operating supplies, expenses ----------
  let G = null;
  try{
    await bgo('ingredients');
    await bo.check(`[data-ing-pick="${MILK}"]`); await bo.check(`[data-ing-pick="${ARLA}"]`);
    await bo.click('#ing-merge-picked'); await bo.waitForSelector('#mg-name');
    await bo.fill('#mg-name', 'Full Cream Milk');
    await bo.click('#mg-preview-btn'); await bo.waitForSelector('.mg-plan');
    await bo.click('#mg-go'); await bgone(); await bo.waitForTimeout(800);
    G = sql(`select id from ingredients where name='Full Cream Milk' and merged_into is null`);
    ok(!!G && sql(`select count(*) from ingredients where merged_into='${G}'`) === '2', 'merged dairy Milk + Arla milk into "Full Cream Milk"');
    ok(sql(`select base_unit from ingredients where id='${G}'`) === 'ml' && stock(G) === 5000 + 5000 - 60 - 180 && stock(MILK) === 0 && stock(ARLA) === 0,
      'Full Cream Milk: 5000 + 5000 (5 L Arla) - 60 sold - 180 wasted = 9,760 mL; nothing left on the old ones', [stock(G), stock(MILK), stock(ARLA)]);
    ok(Number(sql(`select coalesce(sum(abs(quantity)),0) from inventory_transactions where ingredient_id='${G}' and transaction_type='SALE_USAGE'`)) === 60
       && Number(sql(`select coalesce(sum(abs(quantity)),0) from inventory_transactions where ingredient_id='${G}' and transaction_type='WASTE'`)) === 180, 'the sale (60 mL) and waste (180 mL) lines moved to Full Cream Milk');
    const uc = Number(sql(`select public._ingredient_unit_cost('${biz}', '${G}', (now() at time zone 'Asia/Manila')::date)`));
    ok(Math.abs(uc - 0.12) < 1e-9, 'Full Cream Milk costs (500 + 700) / 10,000 mL = ₱0.12/mL', uc);
    ok(sql(`select count(*) from sales where needs_review`) === '0', 'no sale flagged for review');

    // foil (Operating supplies) bought -> expense, no stock
    await bgo('purchases');
    await bo.click('#btn-new-purchase'); await bo.waitForSelector('#p-ing');
    await bo.selectOption('#p-ing', FOIL);
    await bo.fill('#p-price', '150'); await bo.fill('#p-qty', '3');
    await bo.click('#btn-save-pur'); await bgone(); await bo.waitForTimeout(500);
    ok(eq2(sql(`select coalesce(sum(amount),0) from expenses where ingredient_id='${FOIL}' and category='SUPPLIES'`), 150) && sql(`select count(*) from purchases where ingredient_id='${FOIL}'`) === '0' && stock(FOIL) === 0,
      'foil bought: a ₱150 SUPPLIES expense, no purchase, no stock');
    await bgo('expenses');
    for(const [cat, amt] of [['RENT', '5000'], ['UTILITIES', '1234.56']]){
      await bo.click('#btn-new-expense'); await bo.waitForSelector('#ex-amount');
      await bo.selectOption('#ex-cat', cat); await bo.fill('#ex-amount', amt);
      await bo.click('#ex-save'); await bgone(); await bo.waitForTimeout(500);
    }
    ok(eq2(sql(`select sum(amount) from expenses`), X.expenses), `expenses: 150 + 5,000 + 1,234.56 = ${peso(X.expenses)}`, sql(`select string_agg(category||' '||amount, ', ') from expenses`));
  }catch(e){ await H.shot(bo, 'money14-stopped-bo2'); await browser.close(); H.abort(NAME, e); }

  // ---------- net income + waste report vs hand math ----------
  try{
    await bgo('netIncome'); await bo.waitForTimeout(1200);
    const r = await bo.evaluate(() => NET_LAST);
    ok(r && eq2(r.sales.gross, X.gross) && eq2(r.sales.refunds, X.refund) && eq2(r.sales.tax, X.tax) && eq2(r.sales.net, X.net) && r.sales.count === 4,
      `net income sales: gross ${X.gross}, refunds ${X.refund}, tax ${X.tax} (95.40 - 13.20 refund share), net ${X.net}, 4 sales`, r && r.sales);
    ok(r && eq2(r.ingredients.sold, X.sold) && eq2(r.ingredients.wasted, X.wasted) && eq2(r.ingredients.used, X.used),
      `net income ingredients: sold ${X.sold}, wasted ${X.wasted} (month-end costs, milk at ₱0.12 after the merge), used ${X.used}`, r && r.ingredients);
    ok(r && eq2(r.expenses.total, X.expenses) && eq2(r.expenses.by_category.SUPPLIES, 150) && eq2(r.expenses.by_category.RENT, 5000) && eq2(r.expenses.by_category.UTILITIES, 1234.56),
      `net income expenses ${X.expenses} by category`, r && r.expenses);
    ok(r && eq2(r.net_income, X.netIncome), `net income = ${X.net} - ${X.used} - ${X.expenses} = ${X.netIncome}`, r && r.net_income);
    const page = (await bo.textContent('#ni-body')).replace(/\s+/g, ' ');
    const fmt = (n) => Math.abs(n).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    ok([X.gross, X.refund, X.tax, X.used, X.expenses, X.netIncome].every(n => page.includes(fmt(n))), 'net income screen shows gross, refunds, tax, ingredients used, expenses and the result', page.slice(0, 500));
    await H.shot(bo, 'money14-net-income');
    const today = sql(`select (now() at time zone 'Asia/Manila')::date`);
    const wr = await bo.evaluate(async (d) => cloud.rpc('waste_report', {p_from: d, p_to: d}), today);
    const byR = Object.fromEntries(wr.by_reason.map(x => [x.reason, Number(x.cost)]));
    ok(eq2(wr.total_cost, X.wasteReport) && eq2(byR.SPILLAGE, 41.20) && eq2(byR.COMPLIMENTARY, 16.20), `waste report: spillage 41.20 + complimentary 16.20 = ${X.wasteReport} (costs when logged)`, wr.by_reason);
  }catch(e){ await H.shot(bo, 'money14-stopped-net'); await browser.close(); H.abort(NAME, e); }

  // ---------- stock at the end ----------
  const end = {beans: stock(BEANS), milk: stock(G), oat: stock(OAT), cup: stock(CUP), lid: stock(LID), pan: stock(PAN.ing)};
  ok(end.beans === 892 && end.milk === 9760 && end.oat === 640 && end.cup === 48 && end.lid === 48 && end.pan === 22,
    'stock at the end: beans 892 g, Full Cream Milk 9,760 mL, oat 640 mL, cups 48, lids 48, pandesal 22', end);
  ok(!errors.length, 'no browser errors', errors);
  await browser.close();
  process.exit(H.summary(NAME));
})();
