// Counter refunds (1280 px), adopted from the counter developer's hand_refund.js:
//   pro-rated partial refunds (owner decision 2026-10-12: the customer's share after discount + tax + service),
//   the dialog shows the amount before confirming, several partial refunds add up to the sale, a refund made in
//   Back Office is picked up before the amount is worked out (Void then refused), refund.performed_by, a manager's
//   own void, and the warning about queued approvals when the manager's sign-in is about to end (offline).
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_refunds.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {BASE, sql, one, ok, must, until, typePin, money} = H;
const MANNY = '66666666-0000-0000-0000-000000000002', CATHY = '66666666-0000-0000-0000-000000000001';
const eq2 = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
(async () => {
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  sql(`update settings set tax_pct = 12, tax_inclusive = false, service_charge_pct = 10 where business_id = '${biz}'`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila', serviceWorkers: 'block'});
  const page = await ctx.newPage(); const errors = []; H.attach(page, errors, 'FO');
  ctx.on('page', p => { p.waitForLoadState().then(() => p.close()).catch(() => {}); });
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  const sellA = async () => {
    await page.click('.nav-item[data-route="pos"]'); await page.waitForSelector('.pos-product-card');
    await page.click('.pos-product-card:has-text("Iced Latte")');
    await page.click('.mod-opt:has-text("16oz")'); await page.click('.mod-opt:has-text("Extra shot")'); await page.click('#mod-add');
    await page.click('.pos-product-card:has-text("Ensaymada")');
    await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn');
  };
  try{
    await H.pairCounter(page, 'TESTAB');
    await typePin(page, '1111');                                   // Cathy, a cashier
    await H.startShift(page, 2000);
    await sellA();
    await must(() => sql(`select count(*) from sales where status='COMPLETED'`) === '1', 'sale A on server', 20000);
    const A = one(`select id, grand_total, subtotal from sales`);
    ok(eq2(A.grand_total, 323.30), 'sale A = 323.30');

    // ---- partial refund of the latte line by cashier + manager PIN
    await page.click('.nav-item[data-route="sales"]'); await page.click(`tr[data-id="${A.id}"]`);
    ok(await page.isVisible('#void-btn') && await page.isVisible('#refund-btn'), 'a finished sale offers Void and Refund');
    await page.click('#refund-btn');
    await page.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(page, '222222');
    await page.waitForSelector('.rv-qty');
    ok(eq2(money(await page.textContent('#rv-amount')), 0), 'dialog starts at ₱0.00 (nothing chosen)');
    await page.fill('tr[data-item]:has-text("Iced Latte") .rv-qty', '1');
    await page.dispatchEvent('tr[data-item]:has-text("Iced Latte") .rv-qty', 'input');
    ok(eq2(money(await page.textContent('#rv-amount')), 244.00), 'dialog shows the customer\'s amount BEFORE confirming: ₱244.00 (200 x 323.30/265)', await page.textContent('#rv-amount'));
    await page.fill('#rv-reason', 'wrong milk'); await page.click('#rv-confirm');
    await must(() => sql(`select count(*) from refunds`) === '1', 'refund on server', 20000);
    const r1 = one(`select type, amount, items, approved_by, performed_by, performed_by_name, approved_by_name from refunds`);
    ok(r1.type === 'PARTIAL_REFUND' && eq2(r1.amount, 244) && r1.approved_by === MANNY && r1.performed_by === CATHY && r1.performed_by_name === 'Cathy Cashier', 'refund 1: PARTIAL_REFUND ₱244.00, approved by Manny (PIN), performed by Cathy', r1);
    ok(Array.isArray(r1.items) && r1.items.length === 1 && r1.items[0].sale_item_id && Number(r1.items[0].quantity) === 1, 'refund.items = [{sale_item_id, quantity}]', r1.items);
    ok(/Customer gets back ₱244\.00/.test(await toasts()), 'confirmation toast says what the customer gets back', await toasts());
    ok(sql(`select status from sales where id='${A.id}'`) === 'PARTIALLY_REFUNDED', 'sale is PARTIALLY_REFUNDED');

    // ---- the rest: second refund is the remainder, FULL_REFUND; a void is no longer offered
    ok(await page.isVisible('#refund-btn') && !(await page.isVisible('#void-btn')), 'a partly refunded sale offers Refund (not Void)');
    await page.click('#refund-btn');
    await page.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(page, '222222');
    await page.waitForSelector('.rv-qty');
    const latteRow = await page.textContent('tr[data-item]:has-text("Iced Latte")');
    ok(/IcedLatte11/.test(latteRow.replace(/\s+/g, '')) && await page.isDisabled('tr[data-item]:has-text("Iced Latte") .rv-qty'), 'latte row shows 1 sold / 1 already refunded and cannot be refunded again', latteRow);
    await page.fill('tr[data-item]:has-text("Ensaymada") .rv-qty', '1'); await page.dispatchEvent('tr[data-item]:has-text("Ensaymada") .rv-qty', 'input');
    ok(eq2(money(await page.textContent('#rv-amount')), 79.30), 'second dialog: ₱79.30 (what is left)', await page.textContent('#rv-amount'));
    await page.fill('#rv-reason', 'rest'); await page.click('#rv-confirm');
    await must(() => sql(`select count(*) from refunds`) === '2', 'second refund on server', 20000);
    ok(sql(`select type||'|'||amount::numeric(12,2) from refunds order by created_at desc limit 1`) === 'FULL_REFUND|79.30', 'refund 2: FULL_REFUND ₱79.30', sql(`select type||'|'||amount::numeric(12,2) from refunds order by created_at desc limit 1`));
    ok(sql(`select status from sales where id='${A.id}'`) === 'REFUNDED', 'sale is REFUNDED, total refunded = 323.30');

    // ---- a refund made elsewhere (Back Office) after the counter loaded: picked up before the amount is worked out
    await sellA();
    await must(() => sql(`select count(*) from sales where status='COMPLETED'`) === '1', 'sale B on server', 20000);
    const Bs = one(`select id, grand_total from sales where status='COMPLETED'`);
    const shiftId = sql(`select id from shifts where status='ACTIVE'`);
    const ens = sql(`select id from sale_items where sale_id='${Bs.id}' and name='Ensaymada'`);
    sql(`insert into refunds(id, business_id, sale_id, shift_id, type, amount, reason, items, approved_by, approved_by_name, date)
         values (gen_random_uuid(), '${biz}', '${Bs.id}', '${shiftId}', 'PARTIAL_REFUND', 79.30, 'owner refund in Back Office', jsonb_build_array(jsonb_build_object('sale_item_id', '${ens}', 'quantity', 1)), '${MANNY}', 'Owner', now())`);
    sql(`update sales set status='PARTIALLY_REFUNDED' where id='${Bs.id}'`);
    await page.click('.nav-item[data-route="sales"]'); await page.click(`tr[data-id="${Bs.id}"]`);
    ok(await page.isVisible('#void-btn'), '(the counter still shows Void: its copy of the sale is out of date)');
    await page.click('#void-btn');
    ok(await until(async () => /already refunded, so it cannot be voided/.test(await toasts()), 5000), 'Void is refused: part of the sale was already refunded in Back Office', await toasts());
    ok(!(await page.isVisible('#pin-gate')), 'no PIN asked');
    ok(await page.isVisible('#refund-btn') && !(await page.isVisible('#void-btn')), 'sale detail re-drawn with the right buttons (Refund only)');
    await page.click('#refund-btn');
    await page.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(page, '222222');
    await page.waitForSelector('.rv-qty');
    ok(/Ensaymada11/.test((await page.textContent('tr[data-item]:has-text("Ensaymada")')).replace(/\s+/g, '')), 'the owner\'s refund shows as "already refunded" for the Ensaymada');
    await page.fill('tr[data-item]:has-text("Iced Latte") .rv-qty', '1'); await page.dispatchEvent('tr[data-item]:has-text("Iced Latte") .rv-qty', 'input');
    ok(eq2(money(await page.textContent('#rv-amount')), 244.00), 'amount for the latte = ₱244.00 (all that is left)', await page.textContent('#rv-amount'));
    await page.fill('#rv-reason', 'x'); await page.click('#rv-confirm');
    await must(() => sql(`select count(*) from refunds where sale_id='${Bs.id}'`) === '2', 'refund accepted', 20000);
    ok(sql(`select status from sales where id='${Bs.id}'`) === 'REFUNDED' && sql(`select count(*) from sync_operations where result_summary not in ('ok','skipped')`) === '0', 'accepted by the server: sale REFUNDED, no refused uploads');

    // ---- full void by a signed-in manager sets performed_by too
    await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(page, '222222');
    await page.waitForSelector('.pos-product-card');
    await page.click('.pos-product-card:has-text("Americano")'); await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn');
    await must(() => sql(`select count(*) from sales where status='COMPLETED'`) === '1', 'sale V on server', 20000);
    const V = one(`select id, grand_total from sales where status='COMPLETED'`);
    await page.click('.nav-item[data-route="sales"]'); await page.click(`tr[data-id="${V.id}"]`);
    await page.click('#void-btn'); await page.waitForSelector('#rv-reason');
    ok(eq2(money(await page.textContent('#rv-amount')), V.grand_total), 'void dialog shows what the customer gets back (' + V.grand_total + ')', await page.textContent('#rv-amount'));
    await page.fill('#rv-reason', 'oops'); await page.click('#rv-confirm');
    await must(() => sql(`select count(*) from refunds where sale_id='${V.id}'`) === '1', 'void on server', 20000);
    ok(sql(`select type||'|'||performed_by_name||'|'||approved_by_name from refunds where sale_id='${V.id}'`) === 'VOID|Manny Manager|Manny Manager', 'manager\'s own void: performed_by + approved_by = Manny (own sign-in accepted)');

    // ---- warning about queued approvals when the manager's sign-in is close to its end
    const goOff = async () => { await ctx.route(/\/(rest|auth)\/v1\//, (r) => r.abort('internetdisconnected')); await page.evaluate(() => cloud.select('qr_orders', {limit: 1}).catch(() => {})); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); };
    await page.click('.nav-item[data-route="pos"]'); await page.waitForSelector('.pos-product-card');
    await goOff();
    await page.click('.pos-product-card:has-text("Americano")');
    await page.click('#add-discount-link'); await page.waitForSelector('#disc-value'); await page.fill('#disc-value', '10'); await page.click('#disc-apply');
    await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn');
    await must(async () => (await page.evaluate(() => LocalDB.outboxCount())) >= 1, 'queued', 5000);
    await page.evaluate(() => updateApprovalBanner());
    ok(!(await page.isVisible('#approval-banner')), 'no warning while the sign-in has hours left');
    await page.evaluate(async () => { const m = await LocalDB.get('fo.loginTokens'); Object.values(m).forEach(v => { v.exp = new Date(Date.now() + 40 * 60000).toISOString(); }); await LocalDB.set('fo.loginTokens', m); await updateApprovalBanner(); });
    const w1 = (await page.textContent('#approval-banner')).replace(/\s+/g, ' ');
    ok(await page.isVisible('#approval-banner') && /1 approved action is waiting to upload/.test(w1) && /Manny Manager's sign-in ends at/.test(w1) && /Reconnect to the internet before then/.test(w1), 'warning when the sign-in ends within 2 hours', w1);
    await page.evaluate(async () => { const m = await LocalDB.get('fo.loginTokens'); Object.values(m).forEach(v => { v.exp = new Date(Date.now() - 60000).toISOString(); }); await LocalDB.set('fo.loginTokens', m); await updateApprovalBanner(); });
    const w2 = (await page.textContent('#approval-banner')).replace(/\s+/g, ' ');
    ok(/sign-in ended at/.test(w2) && /Reconnect to the internet now/.test(w2), 'stronger warning after it ended', w2);
    // the manager's sign-in has run out: offline approval is refused with a clear sentence
    await page.evaluate(() => { posState.loginExpiresAt = new Date(Date.now() - 1000).toISOString(); });
    await page.click('.pos-product-card:has-text("Ensaymada")'); await page.click('#add-discount-link');
    ok(await until(async () => /sign-in has run out/.test(await toasts()), 4000), 'ended sign-in offline: "Your sign-in has run out…" and no PIN pad', await toasts());
    ok(!(await page.isVisible('#pin-gate')), 'no PIN pad offline');
    await ctx.unroute(/\/(rest|auth)\/v1\//); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    ok(await until(async () => !(await page.isVisible('#approval-banner')), 20000), 'warning goes away once the queue has uploaded');
    ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  }catch(e){ console.log('STOPPED', e.stack.split('\n').slice(0,3).join(' | ')); await H.shot(page, 'hand-refund'); ok(false, 'stopped: ' + e.message); }
  await browser.close();
  process.exit(H.summary('fo_refunds.e2e'));
})();
