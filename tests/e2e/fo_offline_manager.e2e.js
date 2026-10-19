// Offline manager self-approval (security decision 3, owner decision 2026-10-12), adopted from hand_offline_mgr.js:
//   a manager signed in ONLINE approves their OWN discount and refund while the counter is offline (no PIN pad);
//   the queued ops carry their LOGIN token + performed_by; after reconnecting the server accepts both, once.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_offline_manager.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {BASE, sql, ok, must, until, typePin} = H;
const MANNY = '66666666-0000-0000-0000-000000000002';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila', serviceWorkers: 'block'});
  const page = await ctx.newPage();
  const errors = []; H.attach(page, errors, 'FO');
  ctx.on('page', p => { p.waitForLoadState().then(() => p.close()).catch(() => {}); });
  const rpc = []; page.on('request', r => { const u = r.url(); if(u.includes('/rest/v1/rpc/')) rpc.push(u.split('/rpc/')[1] + ' ' + (r.postData()||'').slice(0,200)); });
  // Offline = every call to the server fails (reliable even when receipt pop-ups open and close).
  const block = (r) => r.abort('internetdisconnected');
  const goOffline = async () => { await ctx.route(/\/(rest|auth)\/v1\//, block); await page.evaluate(() => cloud.select('qr_orders', {limit: 1}).catch(() => {})); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); };
  const goOnline = async () => { await ctx.unroute(/\/(rest|auth)\/v1\//, block); await page.evaluate(() => window.dispatchEvent(new Event('online'))); };
  const toastText = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  try{
    await H.pairCounter(page, 'TESTAB');
    await typePin(page, '2222');                       // Manny, a manager, signs in online
    await H.startShift(page, 500);
    await must(() => sql(`select count(*) from shifts where status='ACTIVE'`) === '1', 'shift up', 15000);
    // ---- go offline, sell with a discount approved by Manny himself (no PIN pad)
    await goOffline();
    await page.click('.pos-product-card:has-text("Americano")');
    const before = rpc.length;
    await page.click('#add-discount-link');
    await page.waitForSelector('#disc-value', {timeout: 3000});
    ok(!(await page.isVisible('#pin-gate')), 'offline manager: discount opens without a PIN pad');
    await page.fill('#disc-value', '10'); await page.click('#disc-apply');
    ok((await page.textContent('.pos-cart-summary .total')).includes('99.00'), 'offline: cart 110 - 10% = 99');
    await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn');
    await must(async () => (await page.evaluate(() => LocalDB.outboxCount())) >= 1, 'sale queued offline', 5000);
    ok(sql(`select count(*) from sales where status='COMPLETED'`) === '0', 'sale still only on the counter');
    // the receipt pop-up that just opened and closed makes Chromium think it is online again: switch it off again
    await page.waitForTimeout(600); await goOffline();
    ok(await until(async () => !(await page.evaluate(() => isOnline())), 5000), 'counter is offline', await page.evaluate(() => [navigator.onLine, cloud.isReachable()]));
    // ---- refund the same sale offline (manager's own sign-in again)
    await page.click('.nav-item[data-route="sales"]');
    await page.click('tr[data-id]');
    await page.click('#refund-btn');
    await page.waitForSelector('.rv-qty', {timeout: 5000});
    ok(!(await page.isVisible('#pin-gate')), 'offline manager: refund dialog opens without a PIN pad');
    ok(/No internet/.test(await page.textContent('.modal')), 'offline refund dialog warns that other refunds are not counted');
    await page.fill('.rv-qty', '1'); await page.fill('#rv-reason', 'offline test');
    ok((await page.textContent('#rv-amount')).includes('99.00'), 'refund dialog shows what the customer gets back (99.00)', await page.textContent('#rv-amount'));
    await page.click('#rv-confirm');
    await page.waitForTimeout(500);
    ok((await page.evaluate(() => LocalDB.outboxCount())) >= 2, 'refund queued offline too');
    // queued ops carry the manager's LOGIN token and performed_by
    const ops = await page.evaluate(async () => (await LocalDB.outboxAll()).map(o => ({type: o.type, d: o.data})));
    const saleOp = ops.find(o => o.type === 'sale'), refOp = ops.find(o => o.type === 'refund');
    ok(saleOp.d.discount_approval_token && saleOp.d.sale.discount_approved_by === MANNY && saleOp.d.sale.cashier_id === MANNY, 'sale op: LOGIN token + approver = cashier = Manny');
    ok(refOp.d.approval_token === saleOp.d.discount_approval_token && refOp.d.refund.performed_by === MANNY && refOp.d.refund.approved_by === MANNY, 'refund op: same LOGIN token, performed_by = Manny');
    ok(refOp.d.refund.items.every(i => i.sale_item_id && i.quantity), 'refund.items keep sale_item_id + quantity');
    ok(refOp.d.refund.type === 'FULL_REFUND' && Math.abs(refOp.d.refund.amount - 99) < 0.005, 'refund type FULL_REFUND, amount 99', refOp.d.refund);
    // ---- back online: both upload and are accepted
    await goOnline();
    ok(await until(async () => sql(`select count(*) from sales where status in ('REFUNDED','COMPLETED')`) === '1' && sql(`select count(*) from refunds`) === '1', 20000), 'both uploaded after reconnect');
    ok(sql(`select status from sales limit 1`) === 'REFUNDED', 'sale is REFUNDED on the server');
    ok(sql(`select discount_approved_by||'|'||discount_approved_by_name from sales limit 1`) === `${MANNY}|Manny Manager`, 'server accepted the discount approval from the LOGIN token');
    ok(sql(`select approved_by_name||'|'||performed_by_name||'|'||amount::numeric(12,2) from refunds limit 1`) === 'Manny Manager|Manny Manager|99.00', 'refund recorded: approved by + performed by Manny, 99.00', sql(`select approved_by_name||'|'||performed_by_name||'|'||amount::numeric(12,2) from refunds limit 1`));
    ok(sql(`select count(*) from sync_operations where result_summary not in ('ok','skipped')`) === '0', 'no refused uploads');
    ok(sql(`select count(*) from staff_sessions where staff_id='${MANNY}' and purpose='LOGIN' and used_at is not null`) === '0', 'LOGIN token is not used up (still valid)');
    ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  }catch(e){ console.log('STOPPED', e.message); await H.shot(page, 'hand-offline-mgr'); H.ok(false, 'stopped: ' + e.message); }
  await browser.close();
  process.exit(H.summary('fo_offline_manager.e2e'));
})();
