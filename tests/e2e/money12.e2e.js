// Release 1.2 money / stock / cash reconciliation across the counter and the Back Office, on ONE database
// (fresh e2e seed + the 1.2 counter seed tests/sql/21_seed_release12_fo.sql, applied by this test).
// Settings: tax 12% (added on top), service charge 10%, loyalty on (default card: 5 = ₱10 off, 10 = ₱50 off, 15 = free item).
// Customers from the seed: Mika 7 stamps (₱10 ready), Rico 15 stamps (₱10, ₱50 and the free item ready).
// Counter (1280 px), cashier Cathy, opening cash ₱1,000:
//   N1 Iced Latte 16oz + Extra shot (150+20+30) + Ensaymada 65, cash    sub 265            tax 31.80 svc 26.50 = 323.30
//   N2 Americano, GCash                                                sub 110            tax 13.20 svc 11.00 = 134.20
//   D  Mika: Americano x2 + Ensaymada, 20% discount (manager PIN) + ₱10 reward, cash
//                                              sub 285  disc 57  reward 10  base 218  tax 26.16 svc 21.80 = 265.96
//   F  Rico: Americano alone with the free-item reward -> ₱0, no payment step   sub 110  reward 110  = 0.00
//   V  Rico: Iced Latte 12oz + Ensaymada with the ₱50 reward, cash, then VOIDED (manager PIN) -> reward released
//                                              sub 215  reward 50  base 165  tax 19.80 svc 16.50 = 201.30
//   partial refund of ONE Americano from D (the rewarded sale), manager PIN:
//      110 x 265.96 / 285 = ₱102.65 cash (the customer's share after discount + reward, plus tax and service)
// Expected for the shift (shared words, salesSummaryRows):
//   Item sales 770.00 − Discounts 57.00 − Loyalty rewards 120.00 + Tax & service 130.46 = Sales 723.46
//   Refunds 102.65 · Net sales 620.81 · Voids 201.30 · Transactions 4
//   Cash 589.26 (N1 + D + F) · GCash 134.20 · expected cash 1000 + 589.26 − 102.65 = 1,486.61 (declared at close, variance 0)
// Stock (seed: beans 1000 g, milk 5000 ml; latte 18 g + 180 ml, 16oz +60 ml, shot +18 g, americano 18 g):
//   beans used 36 + 18 + 36 + 18 + 18 = 126, back 18 (D refund) + 18 (void) = 36 · milk used 240 + 180 = 420, back 180
// Brand FIFO on beans: seed lot (1000 g, 2026-10-01) = brand "Kape Amadeo", waste −950 g, second lot 500 g (2026-10-15)
//   = "Batangas Barako". Start 550 g: in use Kape Amadeo (50 left) -> after N1 Kape Amadeo (14 left) -> after N2 the
//   first lot is used up -> in use Batangas Barako; at the end 460 g, all Batangas Barako.
// Stamps: Mika 7 -> 9 (drink + food today; the partial refund leaves one Americano, so both stay), Rico stays 15
//   (008: a sale counts only when its total is above ₱0, so the free F earns nothing; the voided V earns nothing).
// Compared: counter carts, X-report, close-shift Shift Report (#sr-sales) and the Z record, Back Office
// sales_report(), "Loyalty rewards" report, calendar shift view, ingredient detail + ingredient_brand_stock(), the database.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/money12.e2e.js
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./lib/h');
const B = require('./bo/bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const {sql, one, ok, must, until, typePin, money, r2} = H;
const NAME = 'money12.e2e';
const BEANS = '22222222-0000-0000-0000-000000000001', MILK = '22222222-0000-0000-0000-000000000002';
const MANNY = '66666666-0000-0000-0000-000000000002';
const MIKA = '88888888-0000-0000-0000-000000000001', RICO = '88888888-0000-0000-0000-000000000002';
const BR_A = '12121212-0000-0000-0000-00000000000a', BR_B = '12121212-0000-0000-0000-00000000000b';
const eq2 = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const stock = (id) => Number(sql(`select stock from v_ingredient_stock where ingredient_id='${id}'`));
const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});

const X = {
  N1: {sub: 265, disc: 0, rw: 0, tax: 31.80, svc: 26.50, total: 323.30},
  N2: {sub: 110, disc: 0, rw: 0, tax: 13.20, svc: 11.00, total: 134.20},
  D: {sub: 285, disc: 57, rw: 10, tax: 26.16, svc: 21.80, total: 265.96},
  F: {sub: 110, disc: 0, rw: 110, tax: 0, svc: 0, total: 0},
  V: {sub: 215, disc: 0, rw: 50, tax: 19.80, svc: 16.50, total: 201.30},
  refundD: 102.65,
};
const counted = [X.N1, X.N2, X.D, X.F];
X.itemSales = counted.reduce((s, x) => s + x.sub, 0);                       // 770
X.discounts = 57;
X.rewards = 120;
X.taxSvc = r2(counted.reduce((s, x) => s + x.tax + x.svc, 0));              // 130.46
X.sales = r2(counted.reduce((s, x) => s + x.total, 0));                      // 723.46
X.net = r2(X.sales - X.refundD);                                             // 620.81
X.cash = r2(X.N1.total + X.D.total + X.F.total);                             // 589.26
X.other = X.N2.total;                                                        // 134.20
X.expectedCash = r2(1000 + X.cash - X.refundD);                              // 1486.61
X.beansUsed = 126; X.beansBack = 36; X.milkUsed = 420; X.milkBack = 180;

async function manilaClock(){
  for(;;){
    const t = new Date(Date.now() + 8 * 3600e3);
    if(t.getUTCHours() * 60 + t.getUTCMinutes() < 23 * 60 + 50) return;
    console.log('     (waiting for Manila midnight to pass)'); await H.sleep(60000);
  }
}

(async () => {
  await manilaClock();
  execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', H.DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(__dirname, '..', 'sql', '21_seed_release12_fo.sql')], {stdio: 'ignore'});
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  sql(`update settings set tax_pct = 12, tax_inclusive = false, service_charge_pct = 10, loyalty_enabled = true where business_id = '${biz}'`);
  // two brands of beans, two lots (FIFO)
  sql(`insert into ingredient_brands(id, business_id, ingredient_id, name, sort_order) values ('${BR_A}', '${biz}', '${BEANS}', 'Kape Amadeo', 1), ('${BR_B}', '${biz}', '${BEANS}', 'Batangas Barako', 2)`);
  sql(`update purchases set brand_id = '${BR_A}' where id = '45454545-0000-0000-0000-000000000001'`);
  sql(`insert into purchases(id, business_id, ingredient_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit, brand_id)
       values ('45454545-0000-0000-0000-0000000000b2', '${biz}', '${BEANS}', '2026-10-15', 500, 'g', 500, 500, 1.0, '${BR_B}')`);
  sql(`insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date)
       values ('55555555-0000-0000-0000-0000000000b2', '${biz}', '${BEANS}', 'PURCHASE', 500, '45454545-0000-0000-0000-0000000000b2', '2026-10-15'),
              ('55555555-0000-0000-0000-0000000000e1', '${biz}', '${BEANS}', 'WASTE', -950, null, '2026-10-10')`);
  const start = {beans: stock(BEANS), milk: stock(MILK)};
  ok(start.beans === 550 && start.milk === 5000, 'starting stock: beans 1000 - 950 + 500 = 550 g, milk 5000 ml', start);
  const stamps = (id) => Number(sql(`select stamps from customers where id='${id}'`));
  ok(stamps(MIKA) === 7 && stamps(RICO) === 15, 'seed stamps: Mika 7, Rico 15', [stamps(MIKA), stamps(RICO)]);

  const browser = await chromium.launch();
  const errors = [];
  // ---------- Back Office (owner), used for the brand FIFO reads during the shift ----------
  const bctx = await B.boContext(browser);
  const bo = await bctx.newPage(); H.attach(bo, errors, 'BO');
  await H.boLogin(bo);
  const inUse = async () => {
    const r = await bo.evaluate(async (id) => cloud.rpc('ingredient_brand_stock', {p_ingredient_id: id}), BEANS);
    const row = Array.isArray(r) ? r[0] : r;
    return {stock: Number(row.stock), brand: row.in_use && row.in_use.brand_name, remaining: row.in_use && Number(row.in_use.remaining),
      brands: Object.fromEntries((row.brands || []).map(b => [b.brand_name, Number(b.remaining)]))};
  };
  let u = await inUse();
  ok(u.brand === 'Kape Amadeo' && u.remaining === 50 && u.brands['Batangas Barako'] === 500, 'FIFO before the shift: in use Kape Amadeo (50 g left of the oldest lot), Batangas Barako 500 g', u);

  // ---------- counter ----------
  const fctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila'});
  const fo = await fctx.newPage(); H.attach(fo, errors, 'FO');
  fctx.on('page', p => { if(p !== fo) p.waitForLoadState().catch(() => {}); });
  const cartTotal = async () => money(await fo.textContent('.pos-cart-summary .total'));
  const sellCash = async () => { await fo.click('#checkout-btn'); await fo.click('[data-quick]'); await fo.click('#complete-sale-btn'); };
  const newestSale = () => one(`select * from sales where shift_id='${shiftId}' and status <> 'HELD' order by created_at desc limit 1`);
  const countDone = (n, what) => must(() => Number(sql(`select count(*) from sales where shift_id='${shiftId}' and status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED','VOIDED')`)) === n, what, 20000);
  const go = async (route) => { await fo.click(`.nav-item[data-route="${route}"]`); await fo.waitForTimeout(250); };
  const useCustomer = async (id) => {
    await go('customers'); await fo.waitForSelector(`.cust-row[data-cust="${id}"]`, {timeout: 15000});
    await fo.click(`.cust-row[data-cust="${id}"]`); await fo.waitForSelector('#cust-use');
    await fo.click('#cust-use'); await fo.waitForSelector('.pos-product-card');
  };
  const savedOk = (s, x, label) => ok(s && eq2(s.subtotal, x.sub) && eq2(s.discount_amount || 0, x.disc) && eq2(s.loyalty_discount || 0, x.rw) && eq2(s.tax_amount, x.tax) && eq2(s.service_charge_amount, x.svc) && eq2(s.grand_total, x.total),
    `${label}: saved sub ${x.sub}, discount ${x.disc}, reward ${x.rw}, tax ${x.tax}, service ${x.svc}, total ${x.total}`, s);
  let shiftId, N1, N2, D, F, V;
  try{
    await H.pairCounter(fo, 'TESTAB');
    await typePin(fo, '1111');
    await H.startShift(fo, 1000);
    await must(() => sql(`select count(*) from shifts where status='ACTIVE'`) === '1', 'shift on the server', 20000);
    shiftId = sql(`select id from shifts where status='ACTIVE'`);

    // ---- N1: options, cash
    await fo.click('.pos-product-card:has-text("Iced Latte")');
    await fo.click('.mod-opt:has-text("16oz")'); await fo.click('.mod-opt:has-text("Extra shot")'); await fo.click('#mod-add');
    await fo.click('.pos-product-card:has-text("Ensaymada")');
    ok(eq2(await cartTotal(), X.N1.total), `N1: cart ${peso(X.N1.total)}`, await cartTotal());
    await sellCash(); await countDone(1, 'N1 uploaded');
    N1 = newestSale(); savedOk(N1, X.N1, 'N1');
    u = await inUse();
    ok(u.brand === 'Kape Amadeo' && u.remaining === 14 && u.stock === 514, 'FIFO after N1 (36 g): still Kape Amadeo, 14 g left of the first lot', u);

    // ---- N2: GCash
    await fo.click('.pos-product-card:has-text("Americano")');
    await fo.click('#checkout-btn'); await fo.click('[data-method="GCASH"]'); await fo.fill('#pay-ref', 'GC-1201'); await fo.check('#pay-confirmed'); await fo.click('#complete-sale-btn');
    await countDone(2, 'N2 uploaded');
    N2 = newestSale(); savedOk(N2, X.N2, 'N2');
    ok(sql(`select method||' '||amount::numeric(12,2) from payments where sale_id='${N2.id}'`) === 'GCASH 134.20', 'N2: paid by GCash ₱134.20');
    u = await inUse();
    ok(u.brand === 'Batangas Barako' && u.stock === 496 && u.remaining === 496 && !(u.brands['Kape Amadeo'] > 0), 'FIFO after N2: first lot used up -> "in use" moved to Batangas Barako (496 g)', u);

    // ---- D: Mika, 20% discount (manager PIN) + ₱10 reward
    await useCustomer(MIKA);
    await fo.click('.pos-product-card:has-text("Americano")'); await fo.click('.pos-product-card:has-text("Americano")');
    await fo.click('.pos-product-card:has-text("Ensaymada")');
    await fo.click('#add-discount-link');
    await fo.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(fo, '222222');
    await fo.waitForSelector('#disc-value');
    await fo.selectOption('#disc-type', 'percent'); await fo.fill('#disc-value', '20'); await fo.click('#disc-apply');
    await fo.waitForSelector('.reward-chip:has-text("₱10")', {timeout: 10000});
    await fo.click('.reward-chip:has-text("₱10")');
    ok(eq2(await cartTotal(), X.D.total) && /Stamp reward/.test(await fo.textContent('#reward-row')), `D: cart 285 - 57 - 10 = 218, + tax + service = ${peso(X.D.total)}`, await cartTotal());
    await sellCash(); await countDone(3, 'D uploaded');
    D = newestSale(); savedOk(D, X.D, 'D');
    ok(D.customer_id === MIKA && D.discount_approved_by === MANNY, 'D: Mika\'s sale, discount approved by the manager');
    ok(sql(`select reward_type||' '||milestone||' '||amount::numeric(10,2)||' '||(released_at is null) from loyalty_redemptions where sale_id='${D.id}'`) === 'AMOUNT_OFF 5 10.00 true', 'D: ₱10 redemption recorded (milestone 5)');

    // ---- F: Rico, free item -> ₱0, no payment step
    await useCustomer(RICO);
    await fo.click('.pos-product-card:has-text("Americano")');
    await fo.waitForSelector('.reward-chip:has-text("free")', {timeout: 10000});
    await fo.click('.reward-chip:has-text("free")');
    ok(eq2(await cartTotal(), 0) && /nothing to pay/.test(await fo.textContent('#checkout-btn')), 'F: free item covers the order: ₱0, "Complete sale (nothing to pay)"');
    await fo.click('#checkout-btn'); await fo.waitForSelector('#complete-sale-btn');
    ok(!(await fo.$('#pay-methods')), 'F: no payment step for ₱0');
    await fo.click('#complete-sale-btn'); await countDone(4, 'F uploaded');
    F = newestSale(); savedOk(F, X.F, 'F');
    const fPay = H.rows(`select method, amount from payments where sale_id='${F.id}'`);
    ok(fPay.every(p => eq2(p.amount, 0)), 'F: no money taken (payment rows, if any, are ₱0)', fPay);

    // ---- V: Rico, ₱50 reward, cash, then void -> reward released
    await useCustomer(RICO);
    await fo.click('.pos-product-card:has-text("Iced Latte")'); await fo.click('.mod-opt:has-text("12oz")'); await fo.click('#mod-add');
    await fo.click('.pos-product-card:has-text("Ensaymada")');
    await fo.waitForSelector('.reward-chip:has-text("₱50")', {timeout: 10000});
    await fo.click('.reward-chip:has-text("₱50")');
    ok(eq2(await cartTotal(), X.V.total), `V: cart 215 - 50 = 165, + tax + service = ${peso(X.V.total)}`, await cartTotal());
    await sellCash(); await countDone(5, 'V uploaded');
    V = newestSale(); savedOk(V, X.V, 'V');
    ok(sql(`select count(*) from loyalty_redemptions where sale_id='${V.id}' and released_at is null`) === '1', 'V: ₱50 redemption recorded');
    await go('sales');
    await fo.click(`tr[data-id="${V.id}"]`); await fo.click('#void-btn');
    await fo.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(fo, '222222');
    await fo.waitForSelector('#rv-reason'); await fo.fill('#rv-reason', 'Customer left'); await fo.click('#rv-confirm');
    ok(await until(() => sql(`select status from sales where id='${V.id}'`) === 'VOIDED', 20000), 'V: voided with the manager PIN');
    ok(eq2(sql(`select amount from refunds where sale_id='${V.id}' and type='VOID'`), X.V.total), `V: void recorded for ${peso(X.V.total)}`);
    ok(await until(() => sql(`select (released_at is not null)::text from loyalty_redemptions where sale_id='${V.id}'`) === 'true', 10000), 'V: the void released the ₱50 reward (released_at set)');
    const ricoReady = JSON.parse(sql(`select public._loyalty_summary('${biz}', '${RICO}')::text`)).ready_rewards || [];
    ok(ricoReady.some(r => r.stamp === 10) && !ricoReady.some(r => r.type === 'FREE_ITEM' && r.card_no === 1), 'V: Rico\'s ₱50 is ready again; the used free item is not', ricoReady);
    // the counter offers it again
    await useCustomer(RICO);
    await fo.click('.pos-product-card:has-text("Ensaymada")');
    ok(await until(async () => !!(await fo.$('.reward-chip:has-text("₱50")')), 10000), 'V: the counter offers Rico\'s ₱50 reward again after the void',
      (await fo.textContent('.cart-customer').catch(() => '')).replace(/\s+/g, ' '));
    await fo.click('#clear-cart'); await fo.click('#active-modal-overlay [data-ok]').catch(() => {});
    await fo.waitForSelector('#active-modal-overlay', {state: 'detached'}).catch(() => {});
    // after a restart of the counter page (its "used on this counter" list starts empty) it must be offered too
    await fo.reload();
    await fo.waitForFunction(() => document.getElementById('app').style.display === 'flex' || document.getElementById('pin-gate').style.display === 'flex', null, {timeout: 20000});
    if(!(await fo.isVisible('#app'))){ await typePin(fo, '1111'); await fo.waitForSelector('#app', {state: 'visible'}); }
    await useCustomer(RICO);
    await fo.click('.pos-product-card:has-text("Ensaymada")');
    ok(await until(async () => !!(await fo.$('.reward-chip:has-text("₱50")')), 10000), 'V: after restarting the counter page, Rico\'s ₱50 reward is offered', (await fo.textContent('.cart-customer').catch(() => '')).replace(/\s+/g, ' '));
    await fo.click('#clear-cart'); await fo.click('#active-modal-overlay [data-ok]').catch(() => {});
    await fo.waitForSelector('#active-modal-overlay', {state: 'detached'}).catch(() => {});

    // ---- partial refund of ONE Americano from D (the rewarded, discounted sale)
    await go('sales');
    await fo.click(`tr[data-id="${D.id}"]`); await fo.click('#refund-btn');
    await fo.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(fo, '222222');
    await fo.waitForSelector('.rv-qty');
    await fo.fill('tr[data-item]:has-text("Americano") .rv-qty', '1');
    await fo.fill('#rv-reason', 'Too bitter'); await fo.click('#rv-confirm');
    ok(await until(() => sql(`select count(*) from refunds where sale_id='${D.id}'`) === '1', 20000), 'D: partial refund uploaded');
    const rfD = one(`select type, amount, shift_id, approved_by from refunds where sale_id='${D.id}'`);
    ok(rfD.type === 'PARTIAL_REFUND' && eq2(rfD.amount, X.refundD) && rfD.shift_id === shiftId && rfD.approved_by === MANNY, `D: refund of one Americano = ${peso(X.refundD)} (110 x 265.96 / 285: share after discount + reward, plus tax and service)`, rfD);
    ok(sql(`select status from sales where id='${D.id}'`) === 'PARTIALLY_REFUNDED' && sql(`select (released_at is null)::text from loyalty_redemptions where sale_id='${D.id}'`) === 'true', 'D: partly refunded; its ₱10 reward stays used (only a void / full refund releases it)');
  }catch(e){ await H.shot(fo, 'money12-stopped-counter'); await browser.close(); H.abort(NAME, e); }

  // ---------- counter: shift screen + X-report ----------
  const xrow = {};
  try{
    await go('pos'); await go('shift'); await fo.waitForSelector('.drawer-card .drow.total');
    const stat = (label) => fo.$$eval('.stat-card', (cards, l) => { const c = cards.find(x => x.querySelector('.label') && x.querySelector('.label').textContent.trim() === l); return c ? c.querySelector('.value').textContent : null; }, label);
    ok(eq2(money(await stat('Sales')), X.sales) && eq2(money(await stat('Refunds')), X.refundD) && eq2(money(await stat('Net sales')), X.net) && Number(await stat('Transactions')) === 4,
      `counter shift screen: Sales ${peso(X.sales)}, Refunds ${peso(X.refundD)}, Net ${peso(X.net)}, 4 transactions`, [await stat('Sales'), await stat('Refunds'), await stat('Net sales'), await stat('Transactions')]);
    ok(eq2(money(await stat('Cash')), X.cash) && eq2(money(await stat('GCash / Maya / Other')), X.other), `counter payment breakdown: cash ${peso(X.cash)}, GCash ${peso(X.other)}`, [await stat('Cash'), await stat('GCash / Maya / Other')]);
    ok(eq2(money(await fo.textContent('.drawer-card .drow.total')), X.expectedCash), `counter drawer: expected cash 1000 + ${X.cash} - ${X.refundD} = ${peso(X.expectedCash)}`, await fo.textContent('.drawer-card .drow.total'));
    await fo.click('#xreport-btn');   // 1.4 (lead-approved 2026-11-08): no printer -> the counter asks first; "Use print screen" opens the pop-up
    await fo.waitForSelector('#pr-dialog', {timeout: 10000});
    const [xr] = await Promise.all([fctx.waitForEvent('page'), fo.click('#pr-dialog')]);
    await xr.waitForLoadState();
    Object.assign(xrow, await xr.$$eval('.row', rs => Object.fromEntries(rs.map(r => [r.querySelector('span').textContent.trim(), r.querySelector('b').textContent.trim()]))));
    const xv = (k) => money(xrow[k]);
    ok(eq2(xv('Item sales (before discounts)'), X.itemSales) && eq2(-xv('Discounts'), X.discounts) && eq2(-xv('Loyalty rewards'), X.rewards) && eq2(xv('Tax & service'), X.taxSvc) && eq2(xv('Sales'), X.sales),
      `X-report: Item sales ${X.itemSales} − Discounts ${X.discounts} − Loyalty rewards ${X.rewards} + Tax & service ${X.taxSvc} = Sales ${X.sales}`, xrow);
    ok(eq2(xv('Item sales (before discounts)') + xv('Discounts') + xv('Loyalty rewards') + xv('Tax & service'), xv('Sales')), 'X-report lines add up to Sales', xrow);
    const order = Object.keys(xrow);
    ok(order.indexOf('Discounts') + 1 === order.indexOf('Loyalty rewards') && order.indexOf('Loyalty rewards') + 1 === order.indexOf('Tax & service'), 'X-report: "Loyalty rewards" sits between Discounts and Tax & service', order);
    ok(eq2(-xv('Refunds'), X.refundD) && eq2(xv('Net sales'), X.net) && eq2(xv('Voids'), X.V.total) && Number(xrow['Transactions']) === 4, `X-report: refunds ${X.refundD}, net ${X.net}, voids ${X.V.total}, 4 transactions`, xrow);
    ok(eq2(xv('Cash'), X.cash) && eq2(xv('GCash / Maya / Other'), X.other) && eq2(xv('Expected Cash'), X.expectedCash), `X-report: cash ${X.cash}, GCash ${X.other}, expected cash ${X.expectedCash}`, xrow);
    await xr.close();
  }catch(e){ await H.shot(fo, 'money12-stopped-xreport'); await browser.close(); H.abort(NAME, e); }

  // ---------- Back Office while the shift is open: sales_report + Loyalty rewards report + calendar shift ----------
  try{
    const rep = await bo.evaluate(async () => { const r = dayRange(shopTodayKey(), shopTodayKey()); return cloud.rpc('sales_report', {p_from: r.from.toISOString(), p_to: r.to.toISOString()}); });
    const cs = rep.sales.filter(s => s.status !== 'HELD' && s.status !== 'VOIDED');
    const sum = (a, f) => r2(a.reduce((s, x) => s + Number(f(x) || 0), 0));
    ok(cs.length === 4 && eq2(sum(cs, s => s.grand_total), X.sales) && eq2(sum(cs, s => s.subtotal), X.itemSales), `sales_report: 4 counted sales, item sales ${X.itemSales}, sales ${peso(X.sales)}`, [cs.length, sum(cs, s => s.grand_total)]);
    ok(eq2(sum(cs, s => s.discount_amount), X.discounts) && eq2(sum(cs, s => s.loyalty_discount), X.rewards) && eq2(sum(cs, s => Number(s.tax_amount) + Number(s.service_charge_amount)), X.taxSvc),
      `sales_report: discounts ${X.discounts}, loyalty rewards ${X.rewards} (void left out), tax & service ${X.taxSvc}`, [sum(cs, s => s.discount_amount), sum(cs, s => s.loyalty_discount), sum(cs, s => Number(s.tax_amount) + Number(s.service_charge_amount))]);
    ok(eq2(sum(rep.refunds.filter(r => r.type !== 'VOID'), r => r.amount), X.refundD) && eq2(sum(rep.refunds.filter(r => r.type === 'VOID'), r => r.amount), X.V.total), `sales_report: refunds ${X.refundD}, voids ${X.V.total}`);
    const pm = (m) => sum(rep.payments.filter(p => p.method === m && cs.some(s => s.id === p.sale_id)), p => p.amount);
    ok(eq2(pm('CASH'), X.cash) && eq2(pm('GCASH'), X.other), `sales_report payments: cash ${X.cash}, GCash ${X.other}`, [pm('CASH'), pm('GCASH')]);
    await B.go(bo, 'reports');
    await bo.click('[data-report="loyaltyRewards"]'); await bo.selectOption('#rep-preset', 'today');
    await bo.waitForSelector('#report-body table', {timeout: 15000});
    const lyText = (await bo.textContent('#report-body')).replace(/\s+/g, ' ');
    const lyRows = await bo.$$eval('#report-body tbody tr', rs => rs.filter(r => /POS-/.test(r.textContent)).length);
    ok(lyRows === 2 && /2 rewards/.test(lyText) && lyText.includes('₱120.00') && !lyText.includes(V.transaction_number), 'BO "Loyalty rewards" report: 2 rewards, total ₱120.00, the voided sale left out', lyText.slice(0, 400));
    await B.go(bo, 'calendar'); await bo.click('[data-view="shift"]'); await bo.waitForSelector('#cal-shift-pick');
    await bo.selectOption('#cal-shift-pick', shiftId); await bo.waitForTimeout(400);
    ok(eq2(money(await B.statValue(bo, 'Expected cash')), X.expectedCash) && eq2(money(await B.statValue(bo, 'Net sales')), X.net), `BO calendar shift: expected cash ${peso(X.expectedCash)}, net ${peso(X.net)} (same as the counter)`, [await B.statValue(bo, 'Expected cash'), await B.statValue(bo, 'Net sales')]);
  }catch(e){ await H.shot(bo, 'money12-stopped-bo'); await browser.close(); H.abort(NAME, e); }

  // ---------- close the shift: counted = expected, Shift Report rows, Z record ----------
  try{
    await go('shift');
    await fo.click('#close-shift-btn'); await fo.waitForSelector('#cs-declared');
    ok(eq2(money(await fo.textContent('.modal .drawer-card .drow.total')), X.expectedCash), `close-shift screen expects ${peso(X.expectedCash)}`);
    await fo.fill('#cs-declared', String(X.expectedCash)); await fo.click('#cs-confirm');
    await must(() => sql(`select status from shifts where id='${shiftId}'`) === 'CLOSED', 'shift closed on the server', 20000);
    await fo.waitForSelector('#sr-sales', {timeout: 10000});
    const sr = await fo.$$eval('#sr-sales .drow', rs => rs.map(r => [r.querySelector('span').textContent.trim(), r.children[r.children.length - 1].textContent.trim()]));
    const srv = Object.fromEntries(sr.map(([k, v]) => [k, money(v)]));
    ok(eq2(srv['Item sales (before discounts)'], X.itemSales) && eq2(-srv['Discounts'], X.discounts) && eq2(-srv['Loyalty rewards'], X.rewards) && eq2(srv['Tax & service'], X.taxSvc) && eq2(srv['Sales'], X.sales) && eq2(-srv['Refunds'], X.refundD) && eq2(srv['Net sales'], X.net),
      'Shift Report after closing: Item sales − Discounts − Loyalty rewards + Tax & service = Sales; Refunds; Net sales', sr);
    const z = one(`select * from shifts where id='${shiftId}'`);
    ok(eq2(z.expected_cash, X.expectedCash) && eq2(z.declared_cash, X.expectedCash) && eq2(z.cash_variance, 0), `Z record: expected ${peso(X.expectedCash)}, counted the same, variance ₱0`, z);
    ok(eq2(z.gross_sales, X.itemSales) && eq2(z.net_sales, X.net) && eq2(z.refunds_total, X.refundD) && eq2(z.voids_total, X.V.total) && eq2(z.cash_sales, X.cash) && eq2(z.other_sales, X.other) && Number(z.transaction_count) === 4,
      'Z record: item sales, net, refunds, voids, cash, GCash, 4 transactions', z);
    await fo.click('#active-modal-overlay [data-done]').catch(() => {});
  }catch(e){ await H.shot(fo, 'money12-stopped-close'); await browser.close(); H.abort(NAME, e); }

  // ---------- stock, FIFO at the end, stamps ----------
  try{
    const usage = (id, type) => Number(sql(`select coalesce(sum(abs(quantity)),0) from inventory_transactions where ingredient_id='${id}' and transaction_type='${type}'`));
    ok(usage(BEANS, 'SALE_USAGE') === X.beansUsed && usage(BEANS, 'SALE_REVERSAL') === X.beansBack, `beans: ${X.beansUsed} g deducted (incl. extra shot and the free Americano), ${X.beansBack} g put back (refund + void)`, [usage(BEANS, 'SALE_USAGE'), usage(BEANS, 'SALE_REVERSAL')]);
    ok(usage(MILK, 'SALE_USAGE') === X.milkUsed && usage(MILK, 'SALE_REVERSAL') === X.milkBack, `milk: ${X.milkUsed} ml deducted (incl. 16oz +60 ml), ${X.milkBack} ml put back (void)`, [usage(MILK, 'SALE_USAGE'), usage(MILK, 'SALE_REVERSAL')]);
    ok(stock(BEANS) === start.beans - X.beansUsed + X.beansBack && stock(MILK) === start.milk - X.milkUsed + X.milkBack, `stock now: beans ${start.beans - X.beansUsed + X.beansBack} g, milk ${start.milk - X.milkUsed + X.milkBack} ml`, [stock(BEANS), stock(MILK)]);
    u = await inUse();
    ok(u.brand === 'Batangas Barako' && u.stock === 460 && u.brands['Batangas Barako'] === 460, 'FIFO at the end: 460 g, all Batangas Barako (in use)', u);
    // no reload: opening the screen must show the counter's sales (D2 fix, 2026-11-02)
    await B.go(bo, 'ingredientDetail', BEANS); await bo.waitForSelector('#brand-card');
    const card = (await bo.textContent('#brand-card')).replace(/\s+/g, ' ');
    ok(/In use now:\s*Batangas Barako/.test(card), 'BO ingredient detail: "In use now: Batangas Barako"', card.slice(0, 200));
    ok(stamps(MIKA) === 9 && stamps(RICO) === 15, 'stamps: Mika 7 -> 9 (drink + food today, partial refund keeps both), Rico stays 15 (a ₱0 sale and a voided sale earn nothing, 008 rule)', [stamps(MIKA), stamps(RICO)]);
    ok(sql(`select count(*) from sync_operations where result_summary not in ('ok','skipped')`) === '0', 'no counter upload was refused');
    ok(sql(`select count(*) from sales where review_reason is not null`) === '0', 'no sale flagged for review');
    ok(errors.length === 0, 'no browser errors', errors.join(' | '));
    await H.shot(fo, 'money12-shift-report');
  }catch(e){ await browser.close(); H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
