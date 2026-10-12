// Back Office part 0 (fresh e2e seed): wrong password message, owner login, then every screen opens
// without an error box or a browser error, with no sideways overflow of the main area.
// Adopted from the back-office developer's smoke.js. Run all parts with tests/e2e/bo.e2e.js.
const H = require('./bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo/part0_smoke@' + H.sizeTag();
const {ok, go} = H;
const ROUTES = ['dashboard','calendar','transactions','qrOrders','customers','ingredients','purchases','production','recipes','inventory','costing','suppliers','reports','tables','staff','devices','auditLog','settings','backup'];
(async () => {
  const browser = await chromium.launch();
  const ctx = await H.boContext(browser);
  const page = await ctx.newPage();
  const errors = [];
  const net = H.attach(page, errors, 'BO');
  await page.goto(H.BASE + '/cccc/back/');
  await page.waitForSelector('#li-email', {timeout: 15000});
  await H.shot(page, 'bo-' + H.sizeTag() + '-00-login');
  net.allow(/\/auth\/v1\/token\?grant_type=password$/);        // the wrong password is refused with HTTP 400 on purpose
  await H.focusSettled(page, 'li-email');
  await page.fill('#li-email', 'owner@example.com'); await page.fill('#li-pass', 'wrong');
  await page.click('#f-login button[type=submit]');
  ok(await H.until(async () => /Wrong email/.test(await page.textContent('#auth-msg')), 10000), 'wrong password -> plain "Wrong email or password" message', await page.textContent('#auth-msg'));
  net.disallow();
  await page.fill('#li-pass', 'secret123');
  await page.click('#f-login button[type=submit]');
  await page.waitForSelector('#app', {state: 'visible', timeout: 20000});
  ok(true, 'owner signed in');
  for(const r of ROUTES){
    const before = errors.length;
    await go(page, r);
    await page.waitForTimeout(700);
    const txt = await page.textContent('#content');
    const overflow = await page.evaluate(() => { const m = document.getElementById('main'); return m ? m.scrollWidth - m.clientWidth : 0; });
    ok(!/could not be shown|Something went wrong/.test(txt) && errors.length === before, `screen "${r}" opens (${(await page.textContent('#topbar-title')).trim()})`, errors.slice(before).join(' | ') || txt.slice(0, 200));
    ok(overflow <= 2, `screen "${r}" has no sideways overflow at ${H.sizeTag()}`, overflow + 'px');
    await H.shot(page, 'bo-' + H.sizeTag() + '-r-' + r);
  }
  ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
