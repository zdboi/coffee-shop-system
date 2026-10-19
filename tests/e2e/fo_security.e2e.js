// Front Office security checks (counter 1280 px), adopted from the front-office developer's fo_hand.js.
// Covers the 2026-10-12 security decisions on the counter:
//   1  setup is pairing-only (no owner email/password, fo_register_device never called)
//   2-3 offline PIN copies are kept for CASHIERS only (a planted manager copy is removed at start-up)
//   4  a discount approved with a manager PIN: staff_pin_login(pin,'OVERRIDE','MANAGER'), token marked used
//   5  approvals tried offline show "Manager approval needs internet" (no PIN pad)
//   6  a full refund of a discounted sale = the sale total (₱88, not the ₱110 menu price)
//   7  customer search: masked phone, nickname escaped, phone look-up limit messages
//   8-9 a manager signed in online approves with their own login token; locking while that void
//      waits offline defers staff_logout until the upload
//   10 closing another cashier's shift needs a manager approval (token used, closer recorded)
//   11 PIN lockout text says until when
// Needs a fresh seed:   tests/e2e_reset.sh [db]  &&  tests/restart_fake.sh [port] [db]
// Run:                  FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_security.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {BASE, sql, ok, must, until, typePin} = H;
const NAME = 'fo_security.e2e';
const MANNY = '66666666-0000-0000-0000-000000000002', CATHY = '66666666-0000-0000-0000-000000000001', CARL = '66666666-0000-0000-0000-000000000003';

(async () => {
  // a second cashier (Carl, PIN 3333) and a customer whose nickname contains HTML
  sql(`insert into staff(id, business_id, name, role) select '${CARL}', business_id, 'Carl Cashier', 'CASHIER' from staff where id='${CATHY}'`);
  sql(`insert into staff_pins(staff_id, pin_hash) values ('${CARL}', extensions.crypt('3333', extensions.gen_salt('bf', 8)))`);
  sql(`insert into customers(business_id, nickname, phone, source) select business_id, 'Zed <b>x</b>', '+639171234567', 'COUNTER' from staff where id='${CATHY}'`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila'});
  const page = await ctx.newPage();
  const errors = [], rpc = [];
  const net = H.attach(page, errors, 'FO');
  page.on('request', r => { const u = r.url(); if(u.includes('/rest/v1/rpc/')) rpc.push({name: u.split('/rpc/')[1], body: r.postData() || ''}); });
  ctx.on('page', p => { p.waitForLoadState().then(() => p.close()).catch(() => {}); });   // receipt pop-ups
  const lastToast = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  const verifiers = () => page.evaluate(async () => ((await LocalDB.get('fo.pinVerifiers')) || []).map(v => v.staff_id));
  const goOffline = async () => { await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); };
  const goOnline = async () => { await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); };

  try{
    // ---- 1. setup screen: pairing only
    await page.goto(BASE + '/cccc/front/');
    await page.waitForSelector('#su-code', {timeout: 15000});
    const setupText = await page.textContent('#setup-screen');
    ok(!(await page.$('#su-email')) && !(await page.$('#su-login')) && !/Owner sign-in|password/i.test(setupText), 'setup screen shows pairing only (no email/password)');
    ok(/Back Office → Devices → Pair a counter/.test(setupText), 'setup screen explains where to get the code');
    await page.fill('#su-code', 'testab'); await page.click('#su-pair');
    await page.waitForSelector('#pin-gate', {state: 'visible', timeout: 15000});
    ok(!rpc.some(c => c.name === 'fo_register_device'), 'fo_register_device never called');
    ok(rpc.some(c => c.name === 'redeem_device_pairing'), 'paired with redeem_device_pairing');

    // ---- 2. cashier signs in -> offline copy saved for the cashier only
    await typePin(page, '1111');
    await H.startShift(page, 1000);
    ok(await until(async () => (await verifiers()).includes(CATHY), 10000), 'cashier offline PIN copy saved');

    // ---- 3. a manager copy planted on the counter is deleted on start-up
    await page.evaluate(async (m) => { const l = (await LocalDB.get('fo.pinVerifiers')) || []; l.push({staff_id: m, role: 'MANAGER', hash: 'x', cached_at: new Date().toISOString()}); await LocalDB.set('fo.pinVerifiers', l); }, MANNY);
    await page.reload();
    await page.waitForSelector('.pos-product-card', {timeout: 20000});
    ok(await until(async () => { const v = await verifiers(); return v.length === 1 && v[0] === CATHY; }, 10000), 'start-up deletes PIN copies that are not for active cashiers', await verifiers());

    // ---- 4. discount approved with a manager PIN -> sale uploads with the approval
    await page.click('.pos-product-card:has-text("Americano")');
    await page.click('#add-discount-link');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    ok(/This needs internet/.test(await page.textContent('#pin-sub')), 'approval pad says it needs internet');
    await typePin(page, '1111');
    ok(await until(async () => /manager/.test(await page.textContent('#pin-error')), 8000), 'cashier PIN refused for a discount', await page.textContent('#pin-error'));
    await typePin(page, '222222');
    await page.waitForSelector('#disc-value');
    ok(rpc.some(c => c.name === 'staff_pin_login' && /"p_purpose":"OVERRIDE"/.test(c.body) && /"p_min_role":"MANAGER"/.test(c.body)), "staff_pin_login(pin,'OVERRIDE','MANAGER') used");
    await page.fill('#disc-value', '20'); await page.click('#disc-apply');
    ok((await page.textContent('.pos-cart-summary .total')).includes('88.00'), 'cart total 110 - 20% = 88');
    await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn');
    await must(async () => sql(`select count(*) from sales where status='COMPLETED'`) === '1', 'discounted sale on server', 20000);
    const s = sql(`select grand_total::numeric(12,2)||'|'||discount_amount::numeric(12,2)||'|'||discount_approved_by||'|'||discount_approved_by_name from sales where status='COMPLETED'`);
    ok(s === `88.00|22.00|${MANNY}|Manny Manager`, 'discounted sale uploaded with server-checked approver', s);
    ok(sql(`select count(*) from staff_sessions where purpose='OVERRIDE' and used_at is not null and used_for like 'discount:%'`) === '1', 'one-time approval token marked used by the server');
    ok(sql(`select count(*) from sync_operations where result_summary not in ('ok','skipped')`) === '0', 'no failed uploads');

    // ---- 5. offline: approvals are refused with a plain message
    await goOffline();
    await page.click('.pos-product-card:has-text("Ensaymada")');
    await page.click('#add-discount-link');
    ok(await until(async () => /Manager approval needs internet/.test(await lastToast()), 5000), 'offline: discount shows "Manager approval needs internet"', await lastToast());
    ok(!(await page.isVisible('#pin-gate')), 'offline: no PIN pad for the discount');
    await page.click('#clear-cart'); await page.click('[data-ok]');
    await page.click('.nav-item[data-route="sales"]');
    await page.click('tr[data-id]:has-text("POS-A")');
    await page.click('#void-btn');
    await page.waitForTimeout(400);
    ok(!(await page.isVisible('#pin-gate')) && !(await page.$('#rv-reason')), 'offline: void is refused too (no approval possible)');
    await goOnline();
    await page.waitForTimeout(800);

    // ---- 6. full refund of the discounted sale: amount = what was paid (88), accepted by the server
    await page.click('#refund-btn');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '222222');
    await page.waitForSelector('.rv-qty');
    await page.fill('.rv-qty', '1'); await page.fill('#rv-reason', 'changed mind');
    await page.click('#rv-confirm');
    await must(async () => sql(`select count(*) from refunds`) === '1', 'refund on server', 20000);
    const rf = sql(`select r.amount::numeric(12,2)||'|'||r.type||'|'||r.approved_by_name||'|'||s.status from refunds r join sales s on s.id=r.sale_id`);
    ok(rf === '88.00|FULL_REFUND|Manny Manager|REFUNDED', 'full refund of the discounted sale = the sale total ₱88 (accepted by the server)', rf);

    // ---- 7. customers: masked phone, escaped nickname, look-up limit
    await page.click('.nav-item[data-route="pos"]');
    await page.waitForSelector('#cust-add');
    await page.click('#cust-add');
    ok((await page.getAttribute('#cp-q', 'placeholder')) === 'Name, last 4 digits or full number', 'customer search hint');
    await page.fill('#cp-q', '4567');
    await page.waitForSelector('.cp-row');
    const row = await page.textContent('.cp-row');
    ok(row.includes('0917 ••• 4567') && !row.includes('123'), 'search by last 4 digits shows the phone masked (0917 ••• 4567)', row);
    ok(row.includes('Zed <b>x</b>') && !(await page.$('.cp-row b b')), 'nickname with HTML shown as text', row);
    const dev = sql(`select auth_user_id from devices limit 1`);
    sql(`insert into auth_attempts(subject, kind, success) select '${dev}', 'PHONE_LOOKUP', true from generate_series(1,60)`);
    net.allow(/\/rpc\/search_customers$/);          // the server refuses the look-up with HTTP 400 on purpose here
    await page.fill('#cp-q', '0917 123 4567');
    ok(await until(async () => /search by name/.test(await page.textContent('#cp-results')), 8000), 'full-number search over the limit -> "You can still search by name"', await page.textContent('#cp-results'));
    await page.click('.cp-new summary');
    await page.fill('#cp-name', 'Ana'); await page.fill('#cp-phone', '0918 765 4321'); await page.check('#cp-consent'); await page.click('#cp-create');
    ok(await until(async () => /without a number/.test(await lastToast()), 5000), 'new customer with a number over the limit -> "Save them without a number"', await lastToast());
    await page.click('[data-cancel]');
    net.disallow();
    sql(`delete from auth_attempts where kind='PHONE_LOOKUP'`);

    // ---- 8. manager signed in online approves with their own login token (no PIN pad)
    await page.click('#lock-btn');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '222222');
    await page.waitForSelector('.pos-product-card', {timeout: 15000});
    ok((await verifiers()).every(v => v !== MANNY), 'manager sign-in does not save a PIN copy');
    await page.click('.pos-product-card:has-text("Ensaymada")');
    await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn');
    await must(async () => sql(`select count(*) from sales where grand_total=65 and status='COMPLETED'`) === '1', 'manager sale uploaded', 20000);
    await page.click('.nav-item[data-route="sales"]');
    await page.click('tr[data-id]:has-text("₱65.00")');
    const before = rpc.length;
    await page.click('#void-btn');
    await page.waitForSelector('#rv-reason');
    ok(!(await page.isVisible('#pin-gate')) && !rpc.slice(before).some(c => c.name === 'staff_pin_login'), 'manager: void approved with own login, no PIN asked');
    // approval taken online, then the internet drops before confirming -> queued with the token
    await goOffline();
    await page.fill('#rv-reason', 'mistake'); await page.click('#rv-confirm');
    await must(async () => (await page.evaluate(() => LocalDB.outboxCount())) >= 1, 'void queued offline', 5000);
    const mannyLogin = sql(`select id from staff_sessions where staff_id='${MANNY}' and purpose='LOGIN' order by created_at desc limit 1`);

    // ---- 9. lock while that void waits: the manager's login must NOT be ended yet
    const beforeLock = rpc.length;
    await page.click('#lock-btn');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    await page.waitForTimeout(1200);
    ok(!rpc.slice(beforeLock).some(c => c.name === 'staff_logout'), 'lock while offline with a waiting void: staff_logout not called');
    ok(sql(`select revoked_at is null from staff_sessions where id='${mannyLogin}'`) === 't', 'manager login still valid on the server');
    ok((await page.evaluate(async () => ((await LocalDB.get('fo.pendingLogouts')) || []).length)) === 1, 'login remembered to end later');
    await goOnline();
    ok(await until(async () => sql(`select status from sales where grand_total=65`) === 'VOIDED', 20000), 'queued void uploaded after reconnect');
    ok(sql(`select approved_by_name from refunds where type='VOID'`) === 'Manny Manager', 'queued void accepted with the manager login token');
    ok(await until(async () => sql(`select revoked_at is not null from staff_sessions where id='${mannyLogin}'`) === 't', 20000), 'manager login ended (staff_logout) only after the void uploaded');
    ok((await page.evaluate(async () => ((await LocalDB.get('fo.pendingLogouts')) || []).length)) === 0, 'nothing left to end');

    // ---- 10. another cashier closes Cathy's shift -> manager PIN, approval_token sent
    await typePin(page, '3333');
    await page.waitForSelector('.pos-product-card', {timeout: 15000});
    await page.click('.nav-item[data-route="shift"]');
    await page.click('#close-shift-btn');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '222222');
    await page.waitForSelector('#cs-declared');
    const expected = (await page.textContent('.modal .drawer-card .drow.total')).replace(/[^0-9.]/g, '');
    await page.fill('#cs-declared', expected);
    await page.click('#cs-confirm');
    ok(await until(async () => sql(`select status from shifts limit 1`) === 'CLOSED', 20000), 'shift closed on server');
    ok(sql(`select closed_by||'|'||closed_by_name from shifts limit 1`) === `${MANNY}|Manny Manager`, "closing another cashier's shift accepted with the manager's approval", sql(`select closed_by||'|'||closed_by_name from shifts limit 1`));
    ok(sql(`select count(*) from staff_sessions where used_for like 'shift_close:%'`) === '1', 'shift-close approval token used');
    await page.click('[data-done]').catch(() => {});

    // ---- 11. PIN lockout shows until when
    await page.click('#lock-btn');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    for(let i = 0; i < 5; i++){ await typePin(page, '0000'); await until(async () => !/Checking/.test(await page.textContent('#pin-error')), 5000); }
    const lockMsg = await page.textContent('#pin-error');
    ok(/Try again at .*\(about \d+ minutes?\)/.test(lockMsg), 'PIN lockout says until when', lockMsg);
    await H.shot(page, 'fo-security-lockout');

    ok(sql(`select count(*) from sync_operations where result_summary not in ('ok','skipped')`) === '0', 'no failed uploads overall');
    ok((await page.evaluate(async () => (await LocalDB.failedAll()).length)) === 0, 'nothing in the failed list on the counter');
    ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  }catch(e){ await H.shot(page, 'fo-security-stopped'); await browser.close(); H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
