// Money + stock reconciliation across the three apps, on ONE database (fresh e2e seed).
// Settings for this test: tax 12% (added on top), service charge 10%.
//   Counter (1280 px), cashier Cathy, opening cash ₱2,000:
//     A  Iced Latte 16oz + Extra shot (150+20+30) + Ensaymada 65      sub 265  tax 31.80 svc 26.50  = 323.30 cash
//     B  QR order from a phone (390x844): Iced Latte 16oz x2 + Americano, accepted, paid by GCash at the
//        counter, ready, served                                     sub 450  tax 54.00 svc 45.00  = 549.00 GCash
//     C  Americano x2 + Ensaymada, 20% discount approved by manager PIN
//                                                     sub 285 disc 57  tax 27.36 svc 22.80  = 278.16 cash
//     V  Americano, then voided with manager PIN                     sub 110  tax 13.20 svc 11.00  = 134.20 cash
//     pay in ₱100, pay out ₱50
//     counter partial refund of A's Iced Latte (manager PIN), pro-rated (owner decision 2026-10-12):
//        200 x 323.30 / 265 = ₱244.00 cash out of the drawer
//   Back Office (owner): refund of ONE Americano from C, pro-rated 110 x 278.16 / 285 = ₱107.36, from the drawer
// Expected (one shift, all on one day):
//   counted sales 1,150.46 (A+B+C) · refunds 351.36 · voids 134.20 · net 799.10 · transactions 3
//   cash 601.46 · GCash 549.00 · expected cash 2000 + (601.46 - 351.36) + 100 - 50 = 2,300.10 (declared at close)
// Labels (SALES_LABELS): X-report "Item sales (before discounts)" 1,000.00, "Sales" 1,150.46, "Net sales";
//   Back Office calendar sub-text "Sales ₱1,150.46 − refunds ₱351.36".
//   stock beans 1000 - 144 + 72 = 928 g · milk 5000 - 720 + 240 = 4,520 ml (option extras included)
// Compared: counter shift screen + X-report + close-shift (Z) record, counter "Today · all counters",
// Back Office dashboard + calendar day view + calendar shift view, sales_report(), the database.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/money.e2e.js
const H = require('./lib/h');
const B = require('./bo/bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const {BASE, sql, one, ok, must, until, typePin, money, r2} = H;
const NAME = 'money.e2e';
const BEANS = '22222222-0000-0000-0000-000000000001', MILK = '22222222-0000-0000-0000-000000000002';
const LATTE = '33333333-0000-0000-0000-000000000001', AMERICANO = '33333333-0000-0000-0000-000000000003';
const MANNY = '66666666-0000-0000-0000-000000000002';
const eq2 = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const stock = (id) => Number(sql(`select stock from v_ingredient_stock where ingredient_id='${id}'`));
const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});

// expected values, worked out by hand (see the header)
const X = {
  A: {sub: 265, disc: 0, tax: 31.80, svc: 26.50, total: 323.30},
  B: {sub: 450, disc: 0, tax: 54.00, svc: 45.00, total: 549.00},
  C: {sub: 285, disc: 57, tax: 27.36, svc: 22.80, total: 278.16},
  V: {sub: 110, disc: 0, tax: 13.20, svc: 11.00, total: 134.20},
  refundA: 244.00, refundC: 107.36,
};
X.counted = r2(X.A.total + X.B.total + X.C.total);                 // 1150.46
X.refunds = r2(X.refundA + X.refundC);                               // 351.36
X.net = r2(X.counted - X.refunds);                                   // 799.10
X.cash = r2(X.A.total + X.C.total);                                  // 601.46
X.other = X.B.total;                                                 // 549
X.grossSubtotals = X.A.sub + X.B.sub + X.C.sub;                      // 1000 ("Item sales (before discounts)" = subtotals)
X.expectedCash = r2(2000 + (X.cash - X.refunds) + 100 - 50);         // 2300.10
X.cashLessRefunds = r2(X.cash - X.refunds);                          // 250.10 (drawer "Cash Sales" line)
X.items = 2 + 3 + 3;                                                 // A 2, B 3, C 3
// stock (seed: beans 1000 g, milk 5000 ml; latte = 18 g + 180 ml, 16oz +60 ml, extra shot +18 g, americano 18 g)
X.beansUsed = 36 + 54 + 36 + 18;     // A, B, C, V = 144
X.beansBack = 36 + 18 + 18;          // A refund (latte + shot), C refund (1 americano), V void = 72
X.milkUsed = 240 + 480;              // A, B = 720
X.milkBack = 240;                    // A refund (180 + 60)

async function manilaClock(){
  // Don't start within 8 minutes of midnight in Manila (the day views would split the test's sales).
  for(;;){
    const t = new Date(Date.now() + 8 * 3600e3);
    const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
    if(mins < 23 * 60 + 52) return;
    console.log('     (waiting for Manila midnight to pass)'); await H.sleep(60000);
  }
}

(async () => {
  await manilaClock();
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  sql(`update settings set tax_pct = 12, tax_inclusive = false, service_charge_pct = 10 where business_id = '${biz}'`);
  const start = {beans: stock(BEANS), milk: stock(MILK)};
  ok(start.beans === 1000 && start.milk === 5000, 'starting stock from the seed: beans 1000 g, milk 5000 ml', start);

  const browser = await chromium.launch();
  const errors = [];
  // ---------- counter ----------
  const fctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila'});
  const fo = await fctx.newPage(); H.attach(fo, errors, 'FO');
  const popups = []; fctx.on('page', p => popups.push(p));      // receipts / X-report open in new windows
  const cartTotal = async () => money(await fo.textContent('.pos-cart-summary .total'));
  const sellCash = async () => { await fo.click('#checkout-btn'); await fo.click('[data-quick]'); await fo.click('#complete-sale-btn'); };
  const saleByNo = (no) => one(`select * from sales where transaction_number='${no}'`);
  const newestSaleNo = () => sql(`select transaction_number from sales order by created_at desc limit 1`);
  let shiftId, A, Bs, C, V, qrId;
  try{
    await H.pairCounter(fo, 'TESTAB');
    await typePin(fo, '1111');
    await H.startShift(fo, 2000);
    await must(() => sql(`select count(*) from shifts where status='ACTIVE'`) === '1', 'shift on the server', 20000);
    shiftId = sql(`select id from shifts where status='ACTIVE'`);

    // ---- A: sale with options
    await fo.click('.pos-product-card:has-text("Iced Latte")');
    await fo.click('.mod-opt:has-text("16oz")'); await fo.click('.mod-opt:has-text("Extra shot")'); await fo.click('#mod-add');
    await fo.click('.pos-product-card:has-text("Ensaymada")');
    ok(eq2(await cartTotal(), X.A.total), `A: counter cart total ${peso(X.A.total)} (265 + 12% tax + 10% service)`, await cartTotal());
    await sellCash();
    await must(() => sql(`select count(*) from sales where status='COMPLETED'`) === '1', 'sale A uploaded', 20000);
    A = saleByNo(newestSaleNo());
    ok(eq2(A.subtotal, X.A.sub) && eq2(A.tax_amount, X.A.tax) && eq2(A.service_charge_amount, X.A.svc) && eq2(A.grand_total, X.A.total), 'A: saved with subtotal 265, tax 31.80, service 26.50, total 323.30', A);

    // ---- pay in / pay out
    await fo.click('.nav-item[data-route="shift"]'); await fo.waitForSelector('#cash-mgmt-btn');
    await fo.click('#cash-mgmt-btn'); await fo.fill('#cm-amount', '100'); await fo.fill('#cm-reason', 'Change fund'); await fo.click('#cm-save');
    await fo.waitForSelector('#active-modal-overlay', {state: 'detached'});
    await fo.click('#cash-mgmt-btn'); await fo.click('[data-mode="PAY_OUT"]'); await fo.fill('#cm-amount', '50'); await fo.fill('#cm-reason', 'Ice'); await fo.click('#cm-save');
    await must(() => sql(`select count(*) from cash_movements`) === '2', 'pay in + pay out uploaded', 20000);

    // ---- B: QR order from a phone
    const pctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2, timezoneId: 'Asia/Manila'});
    const ph = await pctx.newPage(); H.attach(ph, errors, 'QR');
    await ph.goto(BASE + '/cccc/order/?t=tabletoken5');
    await ph.waitForSelector('#w-name', {timeout: 15000});
    await ph.fill('#w-name', 'Mara'); await ph.fill('#w-phone', '0917 555 1234'); await ph.check('#w-consent'); await ph.click('#w-go');
    await must(async () => await ph.isVisible('#not-me'), 'QR customer registered', 10000);
    await ph.click(`.item[data-item="${LATTE}"]`); await ph.click('.opt[data-g="g-size"][data-o="o-16"]'); await ph.click('#q-plus'); await ph.click('#it-add');
    await ph.waitForSelector('#view-cart');
    await ph.click(`.item[data-item="${AMERICANO}"]`); await ph.waitForSelector('#it-add'); await ph.click('#it-add');
    await ph.click('#view-cart'); await ph.waitForSelector('#c-place'); await ph.click('#c-place');
    await ph.waitForSelector('.ticket-no', {timeout: 10000});
    const qr = one(`select id, order_number, subtotal, tax_amount, service_charge_amount, total from qr_orders`);
    qrId = qr.id;
    ok(eq2(qr.subtotal, X.B.sub) && eq2(qr.tax_amount, X.B.tax) && eq2(qr.service_charge_amount, X.B.svc) && eq2(qr.total, X.B.total), 'B: the database priced the QR order 450 + 54 tax + 45 service = 549.00', qr);
    ok((await ph.textContent('.ticket-pay b')).includes('549.00'), 'B: the phone shows ₱549.00', await ph.textContent('.ticket-pay b'));

    // counter: accept -> take payment (GCash) -> ready -> served
    await fo.click('.nav-item[data-route="qr"]');
    await must(async () => !!(await fo.$(`[data-qr-act="ACCEPT"][data-id="${qrId}"]`)), 'QR order on the counter board', 20000);
    await fo.click(`[data-qr-act="ACCEPT"][data-id="${qrId}"]`);
    await must(() => sql(`select status from qr_orders where id='${qrId}'`) === 'PREPARING', 'accepted', 10000);
    await fo.click(`[data-qr-act="PAY"][data-id="${qrId}"]`);
    await fo.waitForSelector('#checkout-btn');
    ok(eq2(await cartTotal(), X.B.total), 'B: the counter charges the same ₱549.00 as the QR ticket', await cartTotal());
    await fo.click('#checkout-btn'); await fo.click('[data-method="GCASH"]'); await fo.fill('#pay-ref', 'GC-777'); await fo.check('#pay-confirmed'); await fo.click('#complete-sale-btn');
    await must(() => sql(`select (paid_at is not null)::text from qr_orders where id='${qrId}'`) === 'true', 'QR order paid on the server', 20000);
    Bs = one(`select * from sales where qr_order_id='${qrId}'`);
    ok(Bs && eq2(Bs.grand_total, X.B.total) && eq2(Bs.tax_amount, X.B.tax) && eq2(Bs.service_charge_amount, X.B.svc) && Bs.source === 'QR', 'B: sale saved with the QR order\'s total 549.00 (source QR)', Bs);
    ok(sql(`select method||' '||amount::numeric(12,2) from payments where sale_id='${Bs.id}'`) === 'GCASH 549.00', 'B: paid by GCash ₱549.00');
    await must(async () => !!(await fo.$(`[data-qr-act="READY"][data-id="${qrId}"]`)), 'Ready button', 15000);
    await fo.click(`[data-qr-act="READY"][data-id="${qrId}"]`);
    await must(() => sql(`select status from qr_orders where id='${qrId}'`) === 'READY', 'ready', 10000);
    await must(async () => { const b = await fo.$(`[data-qr-act="COMPLETE"][data-id="${qrId}"]`); return b && await b.isEnabled(); }, 'Served button', 15000);
    await fo.click(`[data-qr-act="COMPLETE"][data-id="${qrId}"]`);
    ok(await until(() => sql(`select status from qr_orders where id='${qrId}'`) === 'COMPLETED', 10000), 'B: QR order accepted -> paid -> ready -> served');
    const cust = one(`select visit_count, total_spent from customers where nickname='Mara'`);
    ok(cust && cust.visit_count === 1 && eq2(cust.total_spent, X.B.total), 'B: customer Mara: 1 visit, ₱549 spent (counted once)', cust);
    ok(await until(async () => /Served|Enjoy|Completed|picked up/i.test(await ph.textContent('.ticket')), 12000), 'B: the phone ticket shows the order was served', (await ph.textContent('.ticket')).slice(0, 160));
    await pctx.close();

    // ---- C: discount approved with the manager's PIN
    await fo.click('.nav-item[data-route="pos"]'); await fo.waitForSelector('.pos-product-card');
    await fo.click('.pos-product-card:has-text("Americano")'); await fo.click('.pos-product-card:has-text("Americano")');
    await fo.click('.pos-product-card:has-text("Ensaymada")');
    await fo.click('#add-discount-link');
    await fo.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(fo, '2222');
    await fo.waitForSelector('#disc-value');
    await fo.selectOption('#disc-type', 'percent'); await fo.fill('#disc-value', '20'); await fo.click('#disc-apply');
    ok(eq2(await cartTotal(), X.C.total), `C: cart 285 - 20% = 228, + 12% tax + 10% service = ${peso(X.C.total)}`, await cartTotal());
    await sellCash();
    await must(() => sql(`select count(*) from sales where status='COMPLETED'`) === '3', 'sale C uploaded', 20000);
    C = saleByNo(newestSaleNo());
    ok(eq2(C.subtotal, X.C.sub) && eq2(C.discount_amount, X.C.disc) && eq2(C.tax_amount, X.C.tax) && eq2(C.service_charge_amount, X.C.svc) && eq2(C.grand_total, X.C.total), 'C: saved with discount 57, tax 27.36, service 22.80, total 278.16', C);
    ok(C.discount_approved_by === MANNY && sql(`select count(*) from staff_sessions where used_for='discount:${C.id}'`) === '1', 'C: discount approver checked by the server, approval used once');

    // ---- V: sale then void (manager PIN)
    await fo.click('.pos-product-card:has-text("Americano")');
    ok(eq2(await cartTotal(), X.V.total), `V: cart total ${peso(X.V.total)}`, await cartTotal());
    await sellCash();
    await must(() => sql(`select count(*) from sales where status='COMPLETED'`) === '4', 'sale V uploaded', 20000);
    V = saleByNo(newestSaleNo());
    await fo.click('.nav-item[data-route="sales"]');
    await fo.click(`tr[data-id="${V.id}"]`);
    await fo.click('#void-btn');
    await fo.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(fo, '2222');
    await fo.waitForSelector('#rv-reason'); await fo.fill('#rv-reason', 'Rang up by mistake'); await fo.click('#rv-confirm');
    ok(await until(() => sql(`select status from sales where id='${V.id}'`) === 'VOIDED', 20000), 'V: voided at the counter with the manager PIN');
    ok(eq2(sql(`select amount from refunds where sale_id='${V.id}' and type='VOID'`), X.V.total), 'V: void recorded for ₱134.20');

    // ---- counter partial refund of A's Iced Latte (with its options)
    await fo.click('.nav-item[data-route="sales"]');
    await fo.click(`tr[data-id="${A.id}"]`);
    await fo.click('#refund-btn');
    await fo.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(fo, '2222');
    await fo.waitForSelector('.rv-qty');
    await fo.fill('tr[data-item]:has-text("Iced Latte") .rv-qty', '1');
    await fo.fill('#rv-reason', 'Wrong milk'); await fo.click('#rv-confirm');
    ok(await until(() => sql(`select count(*) from refunds where sale_id='${A.id}'`) === '1', 20000), 'A: partial refund uploaded');
    const rfA = one(`select type, amount, shift_id, approved_by from refunds where sale_id='${A.id}'`);
    ok(rfA.type === 'PARTIAL_REFUND' && eq2(rfA.amount, X.refundA) && rfA.shift_id === shiftId && rfA.approved_by === MANNY, `A: counter refund ${peso(X.refundA)} (the latte line, pro-rated), from this shift, approved by the manager`, rfA);
    ok(sql(`select status from sales where id='${A.id}'`) === 'PARTIALLY_REFUNDED', 'A: sale marked partly refunded');
  }catch(e){ await H.shot(fo, 'money-stopped-counter'); await browser.close(); H.abort(NAME, e); }

  // ---------- Back Office: owner refund of one Americano from C, out of the open drawer ----------
  const bctx = await B.boContext(browser);
  const bo = await bctx.newPage(); H.attach(bo, errors, 'BO');
  try{
    await H.boLogin(bo);
    await B.go(bo, 'transactions');
    await bo.waitForSelector(`tr[data-sale="${C.id}"]`, {timeout: 15000});
    await bo.click(`tr[data-sale="${C.id}"]`);
    await bo.waitForSelector('#sm-refund'); await bo.click('#sm-refund');
    await bo.waitForSelector('[data-item] .rv-qty');
    const row = '[data-item]:has-text("Americano") .rv-qty';
    await bo.fill(row, '1'); await bo.dispatchEvent(row, 'input');
    ok(eq2(await bo.inputValue('#rv-amount'), X.refundC), `BO: refund amount worked out from the line: ${peso(X.refundC)} (110 x 278.16 / 285, pro-rated)`, await bo.inputValue('#rv-amount'));
    await bo.fill('#rv-reason', 'Too bitter'); await bo.selectOption('#rv-shift', shiftId);
    await bo.click('#rv-confirm'); await B.modalGone(bo);
    const rfC = one(`select type, amount, shift_id from refunds where sale_id='${C.id}'`);
    ok(rfC && rfC.type === 'PARTIAL_REFUND' && eq2(rfC.amount, X.refundC) && rfC.shift_id === shiftId, `BO: owner refund ${peso(X.refundC)} saved against the open shift's drawer`, rfC);
  }catch(e){ await H.shot(bo, 'money-stopped-bo'); await browser.close(); H.abort(NAME, e); }

  // ---------- the counter must see the owner's refund before the drawer is counted ----------
  try{
    let seen = null;
    const live = await until(async () => {
      await fo.click('.nav-item[data-route="pos"]'); await fo.click('.nav-item[data-route="shift"]');
      await fo.waitForSelector('.drawer-card .drow.total');
      seen = money(await fo.textContent('.drawer-card .drow.total'));
      return eq2(seen, X.expectedCash);
    }, 25000, 2000);
    ok(live, `counter (still running) shows the owner's drawer refund: expected cash ${peso(X.expectedCash)}`, 'counter shows ' + peso(seen) + ' (without the owner\'s ' + peso(X.refundC) + ' refund)');
    await fo.click('#close-shift-btn');
    await fo.waitForSelector('#cs-declared');
    const atClose = money(await fo.textContent('.modal .drawer-card .drow.total'));
    ok(eq2(atClose, X.expectedCash), `close-shift screen (no restart) expects ${peso(X.expectedCash)} in the drawer`, peso(atClose));
    await fo.click('#active-modal-overlay [data-cancel]');
    // restart the counter so the rest of the comparison runs on fresh data
    await fo.reload();
    await fo.waitForFunction(() => document.getElementById('app').style.display === 'flex' || document.getElementById('pin-gate').style.display === 'flex', null, {timeout: 20000});
    if(!(await fo.isVisible('#app'))){ await typePin(fo, '1111'); await fo.waitForSelector('#app', {state: 'visible'}); }
    await fo.click('.nav-item[data-route="shift"]'); await fo.waitForSelector('.drawer-card .drow.total');

    // ---- counter shift screen + X-report
    const stat = (label) => fo.$$eval('.stat-card', (cards, l) => { const c = cards.find(x => x.querySelector('.label') && x.querySelector('.label').textContent.trim() === l); return c ? c.querySelector('.value').textContent : null; }, label);
    const drawer = await fo.$$eval('.drawer-card .drow', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
    ok(eq2(money(await stat('Net sales')), X.net) && Number(await stat('Transactions')) === 3 && eq2(money(await stat('Refunds')), X.refunds), `counter shift screen: net ${peso(X.net)}, 3 transactions, refunds ${peso(X.refunds)}`, [await stat('Net sales'), await stat('Transactions'), await stat('Refunds')]);
    ok(eq2(money(await stat('Cash')), X.cash) && eq2(money(await stat('GCash / Maya / Other')), X.other) && eq2(money(await stat('Card')), 0), `counter payment breakdown: cash ${peso(X.cash)}, GCash ${peso(X.other)}`);
    ok(eq2(money(drawer[drawer.length - 1]), X.expectedCash) && drawer.some(d => new RegExp('Cash Sales.*' + X.cashLessRefunds.toFixed(2).replace('.', '\\.')).test(d)) && drawer.some(d => /Pay Ins \(1\).*100\.00/.test(d)) && drawer.some(d => /Pay Outs \(1\).*50\.00/.test(d)), `counter drawer: 2000 + ${X.cashLessRefunds} (cash sales less cash refunds) + 100 - 50 = ${peso(X.expectedCash)} after restart`, drawer);
    const [xr] = await Promise.all([fctx.waitForEvent('page'), fo.click('#xreport-btn')]);
    await xr.waitForLoadState();
    const xrow = await xr.$$eval('.row', rs => Object.fromEntries(rs.map(r => [r.querySelector('span').textContent.trim(), r.querySelector('b').textContent.trim()])));
    const xv = (k) => money(xrow[k]);
    ok(eq2(xv('Net sales'), X.net) && Number(xrow['Transactions']) === 3 && eq2(-xv('Refunds'), X.refunds) && eq2(xv('Voids'), X.V.total), `X-report: net ${peso(X.net)}, 3 transactions, refunds ${peso(X.refunds)}, voids ${peso(X.V.total)}`, xrow);
    ok(eq2(xv('Cash'), X.cash) && eq2(xv('Card'), 0) && eq2(xv('GCash / Maya / Other'), X.other) && eq2(xv('Opening Cash'), 2000) && eq2(xv('Expected Cash'), X.expectedCash), `X-report: cash ${peso(X.cash)}, GCash ${peso(X.other)}, opening ₱2,000, expected cash ${peso(X.expectedCash)}`, xrow);
    ok(/\+₱100\.00 \/ -₱50\.00/.test(xrow['Pay Ins / Outs'] || ''), 'X-report: pay ins / outs +₱100 / -₱50', xrow['Pay Ins / Outs']);
    ok(eq2(xv('Item sales (before discounts)'), X.grossSubtotals) && eq2(xv('Sales'), X.counted), 'X-report: Item sales 1,000.00 and Sales 1,150.46', xrow);
    await xr.close();
    // counter "Today · all counters"
    await fo.click('.nav-item[data-route="sales"]'); await fo.click('[data-view="today"]'); await fo.waitForSelector('.stat-card');
    ok(eq2(money(await stat('Total')), X.counted) && Number(await stat('Transactions')) === 3, `counter "Today · all counters": ${peso(X.counted)} before refunds, 3 transactions`, [await stat('Total'), await stat('Transactions')]);
    await fo.click('[data-view="shift"]');
  }catch(e){ await H.shot(fo, 'money-stopped-xreport'); await browser.close(); H.abort(NAME, e); }

  // ---------- Back Office: dashboard, calendar day + shift view, sales_report ----------
  try{
    await B.go(bo, 'dashboard');
    await bo.waitForFunction(() => !/…/.test(document.querySelector('#dash-today .stat-card .value').textContent), null, {timeout: 15000});
    ok(eq2(money(await B.statValue(bo, 'Net sales today')), X.net), `BO dashboard "Net sales today" ${peso(X.net)}`, await B.statValue(bo, 'Net sales today'));
    await B.go(bo, 'calendar'); await bo.click('[data-view="day"]'); await bo.waitForSelector('.cal-kpis');
    const kp = async (l) => B.statValue(bo, l);
    const netCard = await bo.$$eval('.stat-card', cs => { const c = cs.find(x => x.querySelector('.label').textContent.trim() === 'Net sales'); return c ? c.textContent.replace(/\s+/g, ' ') : ''; });
    ok(eq2(money(await kp('Net sales')), X.net) && netCard.includes('Sales ' + peso(X.counted) + ' − refunds ' + peso(X.refunds)), `BO calendar day: net ${peso(X.net)}, sub-text "Sales ${peso(X.counted)} − refunds ${peso(X.refunds)}"`, netCard);
    ok(Number(await kp('Transactions')) === 3 && Number(await kp('Items sold')) === X.items && eq2(money(await kp('Average sale')), r2(X.counted / 3)), `BO calendar day: 3 transactions (void left out), ${X.items} items, average ${peso(r2(X.counted / 3))}`, [await kp('Transactions'), await kp('Items sold'), await kp('Average sale')]);
    const payRows = await bo.$$eval('.cal-card', cards => { const c = cards.find(x => /Payment methods/.test(x.querySelector('h3') ? x.querySelector('h3').textContent : '')); return c ? [...c.querySelectorAll('tbody tr')].map(r => [...r.children].map(td => td.textContent.trim())) : []; });
    const pay = Object.fromEntries(payRows.map(r => [r[0], r]));
    ok(pay.Cash && pay.Cash[1] === '2' && eq2(money(pay.Cash[2]), X.cash) && pay.GCash && pay.GCash[1] === '1' && eq2(money(pay.GCash[2]), X.other), `BO calendar day payments: cash 2 / ${peso(X.cash)}, GCash 1 / ${peso(X.other)}`, payRows);
    await bo.click('[data-view="shift"]'); await bo.waitForSelector('#cal-shift-pick');
    await bo.selectOption('#cal-shift-pick', shiftId); await bo.waitForTimeout(300);
    ok(eq2(money(await kp('Expected cash')), X.expectedCash), `BO calendar shift: expected cash ${peso(X.expectedCash)} (same as the counter)`, await kp('Expected cash'));
    ok(eq2(money(await kp('Cash sales')), X.cash) && eq2(money(await kp('Card')), 0) && eq2(money(await kp('GCash / Maya / other')), X.other), `BO calendar shift: cash ${peso(X.cash)}, card ₱0, GCash ${peso(X.other)}`);
    ok((await kp('Refunds / voids')).replace(/\s/g, '') === (peso(X.refunds) + '/' + peso(X.V.total)).replace(/\s/g, ''), `BO calendar shift: refunds / voids ${peso(X.refunds)} / ${peso(X.V.total)}`, await kp('Refunds / voids'));
    ok(eq2(money(await kp('Net sales')), X.net), `BO calendar shift: net ${peso(X.net)}`, await kp('Net sales'));
    // sales_report for the shop's day, read from the Back Office login
    const rep = await bo.evaluate(async () => { const r = dayRange(shopTodayKey(), shopTodayKey()); return cloud.rpc('sales_report', {p_from: r.from.toISOString(), p_to: r.to.toISOString()}); });
    const counted = rep.sales.filter(s => s.status !== 'HELD' && s.status !== 'VOIDED');
    const sum = (a, f) => r2(a.reduce((s, x) => s + Number(f(x) || 0), 0));
    ok(counted.length === 3 && eq2(sum(counted, s => s.grand_total), X.counted), `sales_report: 3 counted sales = ${peso(X.counted)}`, sum(counted, s => s.grand_total));
    ok(eq2(sum(rep.refunds.filter(r => r.type !== 'VOID'), r => r.amount), X.refunds) && eq2(sum(rep.refunds.filter(r => r.type === 'VOID'), r => r.amount), X.V.total), `sales_report: refunds ${peso(X.refunds)}, voids ${peso(X.V.total)}`);
    const pm = (m) => sum(rep.payments.filter(p => p.method === m && counted.some(s => s.id === p.sale_id)), p => p.amount);
    ok(eq2(pm('CASH'), X.cash) && eq2(pm('GCASH'), X.other), `sales_report payments: cash ${peso(X.cash)}, GCash ${peso(X.other)}`, [pm('CASH'), pm('GCASH')]);
    ok(eq2(sum(counted, s => s.discount_amount), X.C.disc) && eq2(sum(counted, s => s.tax_amount), r2(X.A.tax + X.B.tax + X.C.tax)) && eq2(sum(counted, s => s.service_charge_amount), r2(X.A.svc + X.B.svc + X.C.svc)), 'sales_report: discounts ₱57, tax ₱113.16, service ₱94.30');
    ok(eq2(sum(rep.cash_movements.filter(m => m.type === 'PAY_IN'), m => m.amount), 100) && eq2(sum(rep.cash_movements.filter(m => m.type === 'PAY_OUT'), m => m.amount), 50), 'sales_report: pay in ₱100, pay out ₱50');
    ok((rep.qr_orders || []).length === 1 && eq2(rep.qr_orders[0].total, X.B.total), 'sales_report: the QR order (₱549)');
  }catch(e){ await H.shot(bo, 'money-stopped-calendar'); await browser.close(); H.abort(NAME, e); }

  // ---------- close the shift at the counter: counted = expected -> no variance ----------
  try{
    await fo.click('.nav-item[data-route="shift"]');
    await fo.click('#close-shift-btn'); await fo.waitForSelector('#cs-declared');
    await fo.fill('#cs-declared', String(X.expectedCash));
    await fo.click('#cs-confirm');
    await must(() => sql(`select status from shifts where id='${shiftId}'`) === 'CLOSED', 'shift closed on the server', 20000);
    const z = one(`select * from shifts where id='${shiftId}'`);
    ok(eq2(z.expected_cash, X.expectedCash) && eq2(z.declared_cash, X.expectedCash) && eq2(z.cash_variance, 0), `Z (closed shift): expected ${peso(X.expectedCash)}, counted ${peso(X.expectedCash)}, variance ₱0`, z);
    ok(eq2(z.net_sales, X.net) && eq2(z.refunds_total, X.refunds) && eq2(z.voids_total, X.V.total) && eq2(z.cash_sales, X.cash) && eq2(z.other_sales, X.other) && Number(z.transaction_count) === 3, 'Z (closed shift): net, refunds, voids, cash, GCash and transactions stored as on the X-report', z);
    await B.go(bo, 'calendar'); await bo.click('[data-view="shift"]'); await bo.waitForSelector('#cal-shift-pick');
    await bo.evaluate(() => { BO.salesCache.clear(); }); await bo.click('[data-view="day"]'); await bo.click('[data-view="shift"]'); await bo.waitForSelector('#cal-shift-pick');
    await bo.selectOption('#cal-shift-pick', shiftId); await bo.waitForTimeout(300);
    ok(eq2(money(await B.statValue(bo, 'Expected cash')), X.expectedCash) && eq2(money(await B.statValue(bo, 'Counted cash')), X.expectedCash), `BO shift view after closing: expected = counted = ${peso(X.expectedCash)}`);
    ok(/balanced/.test(await bo.$$eval('.stat-card', cs => cs.map(c => c.textContent).join(' '))) && !(await bo.$('#cal-body .notice.warn')), 'BO shift view after closing: balanced, no "changed after closing" warning');
  }catch(e){ await H.shot(fo, 'money-stopped-close'); await browser.close(); H.abort(NAME, e); }

  // ---------- stock ----------
  const usage = (id, type) => Number(sql(`select coalesce(sum(abs(quantity)),0) from inventory_transactions where ingredient_id='${id}' and transaction_type='${type}'`));
  ok(usage(BEANS, 'SALE_USAGE') === X.beansUsed && usage(BEANS, 'SALE_REVERSAL') === X.beansBack, `beans: ${X.beansUsed} g deducted (incl. extra shot), ${X.beansBack} g put back`, [usage(BEANS, 'SALE_USAGE'), usage(BEANS, 'SALE_REVERSAL')]);
  ok(usage(MILK, 'SALE_USAGE') === X.milkUsed && usage(MILK, 'SALE_REVERSAL') === X.milkBack, `milk: ${X.milkUsed} ml deducted (incl. 16oz +60 ml), ${X.milkBack} ml put back`, [usage(MILK, 'SALE_USAGE'), usage(MILK, 'SALE_REVERSAL')]);
  ok(stock(BEANS) === start.beans - X.beansUsed + X.beansBack, `v_ingredient_stock beans = 1000 - ${X.beansUsed} + ${X.beansBack} = ${start.beans - X.beansUsed + X.beansBack} g`, stock(BEANS));
  ok(stock(MILK) === start.milk - X.milkUsed + X.milkBack, `v_ingredient_stock milk = 5000 - ${X.milkUsed} + ${X.milkBack} = ${start.milk - X.milkUsed + X.milkBack} ml`, stock(MILK));
  ok(sql(`select count(*) from sync_operations where result_summary not in ('ok','skipped')`) === '0', 'no counter upload was refused');
  ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  await H.shot(bo, 'money-bo-shift');
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
