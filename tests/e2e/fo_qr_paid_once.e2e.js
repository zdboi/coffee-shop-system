// A QR order is paid ONCE across two counters (QR_ORDER_ALREADY_PAID, QA defect D2), adopted from hand_qr_paid.js:
//   (1) online: counter B with an out-of-date board is told "already paid, do not charge again" before charging;
//   (2) offline: B takes payment while A pays first; B's queued sale is refused by the server, the cashier gets a
//       red banner + dialog (survives a reload until "Got it"), B's figures drop the refused sale.
//   Also: ?pair=CODE pairing leaves the counter-name box empty (Back Office name used).
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_qr_paid_once.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {BASE, sql, one, ok, must, until, typePin} = H;
const AMERICANO = '33333333-0000-0000-0000-000000000003';
(async () => {
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  sql(`update device_pairing_codes set device_name='Bar Counter' where code='TESTAB'`);
  sql(`insert into device_pairing_codes(code, business_id, device_name, expires_at) values ('TESTBB', '${biz}', 'Second Counter', now() + interval '1 day')`);
  const mkOrder = (no) => sql(`insert into qr_orders(business_id, order_number, order_day, table_label, order_type, customer_nickname, status, items, subtotal, total)
    values ('${biz}', '${no}', current_date, 'Table 5', 'DINE_IN', 'Mara', 'PENDING',
    '[{"recipe_id":"${AMERICANO}","name":"Americano","quantity":1,"unit_price":110,"modifiers":[],"notes":null}]'::jsonb, 110, 110) returning id`);
  const browser = await chromium.launch();
  const mk = async (tag) => {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila', serviceWorkers: 'block'});
    const page = await ctx.newPage(); const errors = []; H.attach(page, errors, tag);
    ctx.on('page', p => { p.waitForLoadState().then(() => p.close()).catch(() => {}); });
    return {ctx, page, errors};
  };
  const A = await mk('A'), B = await mk('B');
  const block = (r) => r.abort('internetdisconnected');
  const off = async (c) => { await c.ctx.route(/\/(rest|auth)\/v1\//, block); await c.page.evaluate(() => cloud.select('qr_orders', {limit: 1}).catch(() => {})); await c.page.evaluate(() => window.dispatchEvent(new Event('offline'))); };
  const on = async (c) => { await c.ctx.unroute(/\/(rest|auth)\/v1\//, block); await c.page.evaluate(() => window.dispatchEvent(new Event('online'))); };
  const hasOrder = (c, id) => c.page.evaluate((i) => state.qrOrders.some(o => o.id === i), id);
  const poll = (c) => c.page.evaluate(() => pollQrOrders());
  const modalText = async (c) => (await c.page.textContent('#active-modal-overlay')).replace(/\s+/g, ' ');
  try{
    // ---- pairing from a QR link: the name box is empty and the owner's name is used
    await A.page.goto(BASE + '/cccc/front/?pair=TESTAB');
    await A.page.waitForSelector('#su-code');
    ok((await A.page.inputValue('#su-devname')) === '' && (await A.page.inputValue('#su-code')) === 'TESTAB', '?pair=CODE: code filled in, counter name box empty');
    ok(/Leave empty to use the name from Back Office/.test(await A.page.getAttribute('#su-devname', 'placeholder')), 'name box explains an empty name uses the Back Office name');
    await A.page.click('#su-pair');
    await A.page.waitForSelector('#pin-gate', {state: 'visible', timeout: 20000});
    ok(sql(`select device_name from devices limit 1`) === 'Bar Counter', 'device named with the name typed in Back Office ("Bar Counter")', sql(`select device_name from devices limit 1`));
    // second counter paired the old way (typed code, name box prefilled)
    await H.pairCounter(B.page, 'TESTBB');
    ok(sql(`select count(*) from devices where device_name='Front Counter'`) === '1', 'typed code keeps the prefilled "Front Counter" name box (unchanged behaviour)');
    for(const c of [A, B]){ await typePin(c.page, '1111'); await H.startShift(c.page, 1000); }
    await must(() => sql(`select count(*) from shifts where status='ACTIVE'`) === '2', 'two shifts', 15000);

    // ---- 1. online: counter B is told the order is already paid
    const q1 = mkOrder('Q-T1');
    for(const c of [A, B]){ await poll(c); await must(() => hasOrder(c, q1), 'order on board', 10000); }
    await B.page.evaluate(() => { window.__origPoll = window.pollQrOrders; window.pollQrOrders = async () => {}; });       // B's board stays out of date, as if the poll were late
    await A.page.click('.nav-item[data-route="qr"]');
    await A.page.click(`[data-qr-act="ACCEPT"][data-id="${q1}"]`);
    await must(() => sql(`select status from qr_orders where id='${q1}'`) === 'PREPARING', 'accepted', 10000);
    await A.page.click(`[data-qr-act="PAY"][data-id="${q1}"]`);
    await A.page.waitForSelector('#checkout-btn'); await A.page.click('#checkout-btn'); await A.page.click('[data-quick]'); await A.page.click('#complete-sale-btn');
    await must(() => sql(`select (paid_at is not null)::text from qr_orders where id='${q1}'`) === 'true', 'paid on A', 20000);
    await B.page.click('.nav-item[data-route="qr"]');
    ok(await B.page.isVisible(`[data-qr-act="PAY"][data-id="${q1}"]`), 'B still shows "Take payment" (its board is out of date)');
    await B.page.click(`[data-qr-act="PAY"][data-id="${q1}"]`);
    await B.page.waitForSelector('#active-modal-overlay');
    const t1 = await modalText(B);
    ok(/already paid/i.test(t1) && /Do not charge the customer again/.test(t1), 'B is told: already paid, do not charge again', t1);
    ok(await B.page.evaluate(() => posState.cart.length === 0 && !posState.qrOrder), 'B did not load the order into the cart');
    await B.page.click('[data-ok]');
    ok(await B.page.isVisible('.badge-green:has-text("PAID")'), 'B\'s board now shows the order as PAID');

    // ---- 2. offline: B takes payment, A pays first, B's sale is refused when it uploads
    const q2 = mkOrder('Q-T2');
    await A.page.evaluate(() => pollQrOrders());
    await B.page.evaluate(() => { window.pollQrOrders = window.__origPoll || window.pollQrOrders; });
    await B.page.evaluate(async () => { const rows = await cloud.select('qr_orders', {eq: {order_number: 'Q-T2'}}); rows.forEach(mergeQrOrder); });
    await must(() => hasOrder(B, q2), 'Q-T2 on B', 10000);
    await off(B);
    await B.page.click('.nav-item[data-route="qr"]');
    await B.page.click(`[data-qr-act="PAY"][data-id="${q2}"]`);
    await B.page.waitForSelector('#checkout-btn');
    await B.page.click('#checkout-btn'); await B.page.click('[data-quick]'); await B.page.click('#complete-sale-btn');
    await must(async () => (await B.page.evaluate(() => LocalDB.outboxCount())) >= 1, 'B queued the payment offline', 8000);
    const bMetricsBefore = await B.page.evaluate(() => shiftMetrics(activeShift()).expectedCash);
    ok(Math.abs(bMetricsBefore - 1110) < 0.005, 'B (offline) counts the sale: expected cash 1,110', bMetricsBefore);
    await A.page.click('.nav-item[data-route="qr"]'); await A.page.evaluate(() => pollQrOrders());
    await must(() => hasOrder(A, q2), 'Q-T2 on A', 10000);
    await A.page.click(`[data-qr-act="ACCEPT"][data-id="${q2}"]`);
    await must(() => sql(`select status from qr_orders where id='${q2}'`) === 'PREPARING', 'A accepted Q2', 10000);
    await A.page.click(`[data-qr-act="PAY"][data-id="${q2}"]`);
    await A.page.waitForSelector('#checkout-btn'); await A.page.click('#checkout-btn'); await A.page.click('[data-quick]'); await A.page.click('#complete-sale-btn');
    await must(() => sql(`select (paid_at is not null)::text from qr_orders where id='${q2}'`) === 'true', 'A paid Q2', 20000);
    await B.page.waitForTimeout(500); await off(B);
    await on(B);
    ok(await until(async () => (await B.page.evaluate(async () => (await LocalDB.failedAll()).length)) === 1, 20000), 'B\'s payment was refused by the server (in the failed list)');
    ok(await until(async () => await B.page.isVisible('#alert-banner'), 5000), 'B shows a red notice banner');
    const banner = (await B.page.textContent('#alert-banner')).replace(/\s+/g, ' ');
    ok(/QR order Q-T2 was already paid/.test(banner) && /NOT recorded/.test(banner) && /Do not charge the customer again/.test(banner) && /give it back/.test(banner), 'banner: order number, "NOT recorded", "Do not charge again", "give it back"', banner);
    ok(await until(async () => await B.page.isVisible('#active-modal-overlay'), 3000), 'and a dialog asks B to read it');
    ok(/Do not charge the customer again/.test(await modalText(B)), 'dialog text', await modalText(B));
    await B.page.click('[data-ok]');
    ok(sql(`select count(*) from sales where qr_order_id='${q2}'`) === '1', 'the server has exactly ONE sale for Q-T2 (A\'s)');
    ok(sql(`select count(*) from sales s join devices d on d.id = s.device_id where s.qr_order_id='${q2}' and d.device_name='Front Counter'`) === '0', 'B\'s sale is not on the server');
    const bAfter = await B.page.evaluate(() => ({exp: shiftMetrics(activeShift()).expectedCash, sales: state.sales.length, beans: state.stock['22222222-0000-0000-0000-000000000001']}));
    ok(Math.abs(bAfter.exp - 1000) < 0.005 && bAfter.sales === 0, 'B\'s figures no longer count the refused sale (expected cash back to 1,000)', bAfter);
    // the notice survives a reload until "Got it"
    await B.page.reload();
    await B.page.waitForFunction(() => document.getElementById('app').style.display === 'flex' || document.getElementById('pin-gate').style.display === 'flex', null, {timeout: 20000});
    if(!(await B.page.isVisible('#app'))) await typePin(B.page, '1111');
    await B.page.waitForSelector('#app', {state: 'visible'});
    ok(await until(async () => await B.page.isVisible('#alert-banner'), 8000), 'after a reload the notice is still there');
    await B.page.click('#alert-ok');
    ok(await until(async () => !(await B.page.isVisible('#alert-banner')), 3000), '"Got it" clears it');
    await B.page.reload(); await B.page.waitForSelector('#app', {state: 'visible', timeout: 20000}); await B.page.waitForTimeout(800);
    ok(!(await B.page.isVisible('#alert-banner')), 'and it stays cleared after another reload');
    for(const c of [A, B]) ok(c.errors.length === 0, 'no browser errors (' + c.errors.length + ')', c.errors.join(' | '));
  }catch(e){ console.log('STOPPED', e.stack.split('\n').slice(0,3).join(' | ')); await H.shot(B.page, 'hand-qr-paid-B'); await H.shot(A.page, 'hand-qr-paid-A'); ok(false, 'stopped: ' + e.message); }
  await browser.close();
  process.exit(H.summary('fo_qr_paid_once.e2e'));
})();
