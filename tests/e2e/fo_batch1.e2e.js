// Counter (Front Office) batch 1 checks, on a fresh e2e seed:
//   * Back Office link: last item of the side menu, well below "Shift & Cash", ADMIN only
//     (absent for a cashier and a manager); role badge tooltip; lock button label
//   * pay-in / pay-out form refuses ₱0, -₱5 and ₱0.004 (rounds to ₱0): nothing queued, nothing on the server
//   * a pay-in the server refuses with AMOUNT_NOT_POSITIVE (007) shows in "Uploads that need attention"
//     as "Pay in / pay out" + "The amount must be more than ₱0."
//   * narrow counter (800 px): footer fits, no sideways scrolling
// Run:  tests/e2e_reset.sh && tests/restart_fake.sh && node tests/e2e/fo_batch1.e2e.js
//       (FAKE_PORT / FAKE_DB for another stand-in, e.g. FAKE_PORT=8790 FAKE_DB=db_fo)
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'fo_batch1.e2e';
const {sql, ok, until, must, typePin} = H;
const SHOT = (p, n) => H.shot(p, 'fo-batch1-' + n);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila'});
  const page = await ctx.newPage();
  const errors = []; H.attach(page, errors, 'FO');
  ctx.on('page', p => { p.waitForLoadState().then(() => p.close()).catch(() => {}); });

  await H.pairCounter(page, 'TESTAB');
  await typePin(page, '999999');                           // the owner's staff row (ADMIN)
  await H.startShift(page, 1000);
  await must(() => sql(`select count(*) from shifts where status='ACTIVE'`) === '1', 'shift start uploaded', 20000);
  const shiftId = sql(`select id from shifts where status='ACTIVE' limit 1`);

  // ---- 1. Back Office link: last, at the bottom, ADMIN only
  const nav = await page.evaluate(() => {
    const navEl = document.getElementById('nav');
    const kids = [...navEl.children];
    const last = kids[kids.length - 1];
    const bo = navEl.querySelector('.nav-back-office');
    const shift = navEl.querySelector('.nav-item[data-route="shift"]');
    const foot = document.getElementById('sidebar-foot');
    const r = (e) => e ? e.getBoundingClientRect() : null;
    return {count: navEl.querySelectorAll('.nav-back-office').length, isLast: !!bo && last === bo, href: bo && bo.getAttribute('href'),
      label: bo && bo.getAttribute('aria-label'), text: bo && bo.textContent.trim(),
      boTop: r(bo) && r(bo).top, boBottom: r(bo) && r(bo).bottom, shiftBottom: r(shift) && r(shift).bottom, footTop: r(foot) && r(foot).top,
      order: kids.filter(k => k.classList.contains('nav-item')).map(k => k.dataset.route || 'back-office')};
  });
  ok(nav.count === 1 && nav.isLast, 'ADMIN: one Back Office link, the last item of the side menu', nav);
  ok(JSON.stringify(nav.order) === JSON.stringify(['pos', 'qr', 'sales', 'shift', 'back-office']), 'menu order: Sell, QR Orders, Sales, Shift & Cash, then Back Office', nav.order);
  ok(nav.href === '../back/' && /Back Office/.test(nav.text) && nav.label === 'Back Office', 'Back Office link goes to ../back/ and is labelled "Back Office"', nav);
  ok(nav.boTop - nav.shiftBottom >= 120, `Back Office link sits well below "Shift & Cash" (gap ${Math.round(nav.boTop - nav.shiftBottom)} px at 1280x860)`, nav);
  ok(nav.footTop - nav.boBottom >= 0 && nav.footTop - nav.boBottom < 60, 'Back Office link sits at the bottom of the menu, just above the footer (not overlapping it)', nav);
  const badge = await page.getAttribute('#sidebar-foot .role-badge', 'title');
  ok(/·\s*ADMIN/.test(badge || ''), 'role badge has a tooltip with the full name and role', badge);
  ok((await page.getAttribute('#lock-btn', 'aria-label')) === 'Lock / Switch User', 'lock button has the label "Lock / Switch User"');
  await SHOT(page, 'admin-menu');

  // ---- 2. pay-in / pay-out form refuses ₱0 or less (after rounding to the centavo)
  await page.click('.nav-item[data-route="shift"]');
  const outbox = () => page.evaluate(() => LocalDB.outboxCount());
  await must(async () => (await outbox()) === 0, 'shift start uploaded', 15000);
  const cmBtn = await page.waitForSelector('button:has-text("Pay In"), button:has-text("Cash Management"), #cash-mgmt-btn', {timeout: 10000});
  for(const [typed, label] of [['0', '₱0'], ['-5', '-₱5'], ['0.004', '₱0.004 (rounds to ₱0)']]){
    await cmBtn.click();
    await page.waitForSelector('#cm-amount');
    await page.fill('#cm-amount', typed); await page.fill('#cm-reason', 'Test ' + typed);
    await page.click('#cm-save');
    const t = await page.waitForSelector('.toast.error', {timeout: 5000}).then(x => x.textContent()).catch(() => '');
    ok(/more than ₱0/.test(t) && await page.isVisible('#cm-amount'), `pay-in of ${label} refused with "Enter an amount more than ₱0" (form stays open)`, t);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach(x => x.remove()));
    await page.click('#active-modal-overlay [data-cancel]');
    await page.waitForSelector('#active-modal-overlay', {state: 'detached'}).catch(() => {});
  }
  ok((await outbox()) === 0 && (await page.evaluate(async () => (await LocalDB.outboxAll()).filter(o => o.type === 'cash_movement').length)) === 0, 'nothing queued for the refused amounts');
  ok(sql(`select count(*) from cash_movements`) === '0', 'nothing saved on the server for the refused amounts');
  // a real one still works, rounded to the centavo
  await cmBtn.click(); await page.waitForSelector('#cm-amount');
  await page.fill('#cm-amount', '12.345'); await page.fill('#cm-reason', 'Change fund');
  await page.click('#cm-save');
  await page.waitForSelector('#active-modal-overlay', {state: 'detached'});
  ok(await until(() => sql(`select count(*) from cash_movements where shift_id='${shiftId}'`) === '1', 15000), 'a pay-in of ₱12.345 is recorded and uploaded');
  const amt = sql(`select amount from cash_movements where shift_id='${shiftId}'`);
  ok(Number(amt) === 12.35 || Number(amt) === 12.34, 'it is saved rounded to the centavo (₱12.35)', amt);

  // ---- 3. a pay-in the server refuses (₱0, sent past the form) -> plain words in "Uploads that need attention"
  // (stands in for an old counter or a stored op that skipped the form check)
  await page.evaluate(async (sid) => {
    const now = new Date().toISOString();
    await Sync.queue('cash_movement', {id: Cloud.uuid ? Cloud.uuid() : crypto.randomUUID(), shift_id: sid, type: 'PAY_IN', amount: 0, reason: 'Broken',
      performed_by: posState.currentUser.id, performed_by_name: posState.currentUser.name, at: now, created_at: now});
  }, shiftId);
  const failed = async () => page.evaluate(async () => (await LocalDB.failedAll()).map(f => f.type + ':' + f.error));
  ok(await until(async () => (await failed()).length === 1, 20000), 'the ₱0 pay-in is refused by the server and kept under "Uploads that need attention"', await failed());
  const f = await failed();
  ok(f.length === 1 && /^cash_movement:.*AMOUNT_NOT_POSITIVE/.test(f[0]), 'refused with AMOUNT_NOT_POSITIVE (007), not SERVER_ERROR', f);
  ok(sql(`select count(*) from cash_movements where shift_id='${shiftId}'`) === '1', 'nothing extra saved on the server');
  await page.click('#sync-pill');
  await page.waitForSelector('#active-modal-overlay table');
  const row = await page.$$eval('#active-modal-overlay tbody tr', trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
  ok(row.length === 1 && row[0][1] === 'Pay in / pay out', 'Type column shows "Pay in / pay out" (plain words, not cash_movement)', row);
  ok(row.length === 1 && row[0][2] === 'The amount must be more than ₱0.', 'Reason column shows "The amount must be more than ₱0."', row);
  await SHOT(page, 'failed-upload');
  const types = await page.evaluate(() => ['shift_open', 'shift_close', 'cash_movement', 'sale', 'held_delete', 'refund', 'audit', 'sold_out', 'something_new'].map(opTypeLabel));
  ok(JSON.stringify(types) === JSON.stringify(['Start shift', 'Close shift', 'Pay in / pay out', 'Sale', 'Remove held order', 'Refund / void', 'Activity note', 'Sold-out change', 'something_new']), 'every upload type has plain words (an unknown type shows as it is)', types);
  const xss = await page.evaluate(() => opTypeLabel('__proto__') + '|' + opTypeLabel('constructor') + '|' + opTypeLabel(null));
  ok(xss === '__proto__|constructor|', 'odd type names are shown as text, not looked up on the object', xss);
  // dismiss it
  await page.click('#active-modal-overlay [data-drop]');
  await page.waitForSelector('#active-modal-overlay [data-ok]'); await page.click('#active-modal-overlay [data-ok]');
  ok(await until(async () => (await failed()).length === 0, 8000), 'dismissed');
  await page.click('#active-modal-overlay [data-close]').catch(() => {});

  // ---- 4. narrow counter: footer fits (icon-only), no sideways scroll
  await page.setViewportSize({width: 800, height: 1280});
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(() => {
    const foot = document.getElementById('sidebar-foot'), side = document.getElementById('sidebar');
    return {docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      footOverflow: foot ? foot.scrollWidth - foot.clientWidth : null, sideW: side ? side.getBoundingClientRect().width : null,
      lockLabel: document.getElementById('lock-btn').getAttribute('aria-label'), boLabel: (document.querySelector('.nav-back-office') || {}).ariaLabel || document.querySelector('.nav-back-office').getAttribute('aria-label')};
  });
  ok(narrow.docOverflow <= 1 && narrow.footOverflow <= 1, 'narrow counter (800 px): no sideways scrolling, footer fits', narrow);
  ok(narrow.lockLabel === 'Lock / Switch User' && narrow.boLabel === 'Back Office', 'narrow counter: icon-only buttons keep their labels for screen readers', narrow);
  await SHOT(page, 'narrow-800');
  await page.setViewportSize({width: 1280, height: 860});

  // ---- 5. cashier and manager: no Back Office link
  for(const [pin, who] of [['1111', 'cashier'], ['222222', 'manager']]){
    await page.click('#lock-btn');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, pin);
    await page.waitForSelector('#app', {state: 'visible', timeout: 15000});
    await page.waitForSelector('#nav .nav-item[data-route="shift"]');
    const n = await page.evaluate(() => ({bo: document.querySelectorAll('#nav .nav-back-office, #nav a[href*="back"]').length, txt: document.getElementById('nav').textContent}));
    ok(n.bo === 0 && !/Back Office/.test(n.txt), `${who}: no Back Office link in the side menu`, n);
  }

  ok(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
