// Customer QR page extra checks (phone 390x844; one 360 px phone), adopted from the QR developer's check.js:
// toast placement (never over a button), PHONE_TAKEN -> "connect this phone" relink with the number filled in,
// TOO_MANY_ATTEMPTS wording on register / relink / save-number, NOT_SIGNED_IN, quiet refreshes keep what
// was typed (and focus), refused cancel message, reduced motion, nicknames with HTML / & / quotes shown as text.
// Needs a fresh seed:   tests/e2e_reset.sh [db]  &&  tests/restart_fake.sh [port] [db]
// Run:                  FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/order_extra.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const path = require('path');
const NAME = 'order_extra.e2e';
const BASE = H.BASE;
const URL = BASE + '/cccc/order/?t=tabletoken5';
const SHOTS = H.SHOTS;
const shotPath = (n) => path.join(SHOTS, 'qr-extra-' + n);
const TAKEN = '0917 123 4567';
const ok = H.ok;
async function sql(q){ const r = await fetch(BASE + '/__sql', {method: 'POST', body: `select to_jsonb((${q}))`}); const t = await r.text(); if(!r.ok) throw new Error(t); return JSON.parse(t); }
async function until(fn, ms){ const end = Date.now() + (ms || 10000); while(Date.now() < end){ try{ if(await fn()) return true; }catch(e){} await new Promise(r => setTimeout(r, 150)); } return false; }
const errors = [];
let browser;

async function phone(name, opts){
  const ctx = await browser.newContext(Object.assign({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2}, opts || {}));
  const page = await ctx.newPage();
  H.attach(page, errors, name);
  await page.goto(URL);
  await page.waitForSelector('#w-name', {timeout: 15000});
  return page;
}
async function register(page, nick, num){
  await page.fill('#w-name', nick);
  if(num) await page.fill('#w-phone', num);
  await page.check('#w-consent');
  await page.click('#w-go');
}
async function registered(page){ return until(async () => await page.isVisible('#not-me'), 10000); }
async function placeOrder(page){
  await page.click('.item[data-item="33333333-0000-0000-0000-000000000001"]');
  await page.click('.opt[data-g="g-size"][data-o="o-16"]');
  await page.click('#it-add');
  await page.waitForSelector('#view-cart');
  await page.click('#view-cart');
  await page.click('#c-place');
  await page.waitForSelector('.ticket-no', {timeout: 10000});
}
// Is the toast showing, and does it overlap anything you can tap?
async function toastState(page){
  return page.evaluate(() => {
    const t = document.getElementById('toast');
    const shown = t.classList.contains('show');
    const tr = t.getBoundingClientRect();
    const hits = [];
    document.querySelectorAll('button, a, input, [role="button"]').forEach(el => {
      if(t.contains(el)) return;
      const r = el.getBoundingClientRect();
      if(!r.width || !r.height) return;
      if(r.left < tr.right && r.right > tr.left && r.top < tr.bottom && r.bottom > tr.top) hits.push((el.id || el.className || el.tagName) + '@' + Math.round(r.top));
    });
    const bar = document.getElementById('topbar').getBoundingClientRect();
    return {shown, text: t.textContent, hits, top: Math.round(tr.top), bottom: Math.round(tr.bottom), barBottom: Math.round(bar.bottom)};
  });
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  browser = await chromium.launch();

  // ---- A. first phone registers Zed with the number
  const a = await phone('A');
  await a.waitForTimeout(350); await a.screenshot({path: shotPath('01-first-visit.png'), fullPage: true});
  await register(a, 'Zed', TAKEN);
  ok(await registered(a), 'A: Zed registered with ' + TAKEN);
  let ts = await toastState(a);
  ok(ts.shown && /Welcome, Zed/.test(ts.text) && ts.hits.length === 0 && ts.bottom <= ts.barBottom, 'A: "Welcome, Zed!" toast sits inside the top bar, over no button', JSON.stringify(ts));
  await a.waitForTimeout(350); await a.screenshot({path: shotPath('02-registered-toast.png')});

  // ---- B. second phone, same number (and same name) -> PHONE_TAKEN -> relink with the number filled in
  const b = await phone('B');
  await b.fill('#w-name', 'Zed');
  await b.fill('#w-phone', TAKEN);
  // returning from another app must not wipe what was typed
  await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await b.waitForTimeout(700);
  ok(await b.inputValue('#w-name') === 'Zed' && await b.inputValue('#w-phone') === TAKEN, 'B: typed name/number survive returning to the tab');
  await b.check('#w-consent');
  await b.click('#w-go');
  ok(await until(async () => /already registered/i.test(await b.textContent('#w-err')), 5000), 'B: PHONE_TAKEN says the number is already registered', await b.textContent('#w-err'));
  ok(await b.isVisible('#w-help .taken button'), 'B: offers "Yes, connect this phone"');
  ok((await sql(`select count(*) from customers where phone = '+639171234567'`)) === 1 && (await sql(`select count(*) from customer_devices`)) === 1, 'B: no new customer, phone B not linked');
  await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await b.waitForTimeout(700);
  ok(await b.isVisible('#w-help .taken button'), 'B: the offer survives a quiet refresh');
  await b.locator('#w-err').scrollIntoViewIfNeeded();
  await b.waitForTimeout(350); await b.screenshot({path: shotPath('03-register-phone-taken.png')});
  await b.click('#w-help .taken button');
  await b.waitForSelector('#r-go');
  ok(await b.inputValue('#r-phone') === TAKEN && await b.inputValue('#r-name') === 'Zed', 'B: relink sheet has the number (and the typed name) filled in');
  ok(await b.evaluate(() => document.activeElement && document.activeElement.id === 'r-go'), 'B: focus moves into the sheet (Connect button)');
  ok(!/Didn't give us a number/.test(await b.textContent('.sheet')), 'B: prefilled sheet drops the "no number before" note');
  await b.waitForTimeout(350); await b.screenshot({path: shotPath('04-relink-prefilled.png')});
  await b.click('#r-go');
  ok(await until(async () => /Welcome back/.test(await b.textContent('.member-hello')), 8000) && (await b.textContent('.member-name')).includes('Zed'), 'B: relinked -> "Welcome back, Zed!" member card');
  ok((await sql(`select count(*) from customer_devices cd join customers c on c.id = cd.customer_id where c.phone = '+639171234567'`)) === 2 && (await sql(`select count(*) from customers`)) === 1, 'B: both phones now point at the one Zed record');
  ts = await toastState(b);
  ok(ts.shown && /Welcome back, Zed/.test(ts.text) && ts.hits.length === 0, 'B: welcome-back toast shown, covers no button', JSON.stringify(ts));
  await b.waitForTimeout(350); await b.screenshot({path: shotPath('05-relinked.png')});

  // ---- C. new customer without a number orders; toast + view change; save a taken number on the ticket
  const c = await phone('C');
  await register(c, 'Ann');
  ok(await registered(c), 'C: Ann registered without a number');
  await c.waitForTimeout(3400);   // let the welcome toast go
  await c.click('.item[data-item="33333333-0000-0000-0000-000000000001"]');
  await c.click('.opt[data-g="g-size"][data-o="o-16"]');
  await c.click('#it-add');
  await c.waitForSelector('#view-cart');
  ts = await toastState(c);
  ok(ts.shown && /Added/.test(ts.text) && ts.hits.length === 0, 'C: "Added" toast over the top bar, covers no button (incl. category chips and order bar)', JSON.stringify(ts));
  await c.waitForTimeout(350); await c.screenshot({path: shotPath('06-added-toast-menu.png')});
  await c.click('#view-cart');
  await c.waitForTimeout(350); await c.screenshot({path: shotPath('07-cart.png')});
  ok((await toastState(c)).shown, 'C: (setup) the "Added" toast is still showing when the order is placed');
  await c.click('#c-place');
  await c.waitForSelector('.ticket-no', {timeout: 10000});
  ts = await toastState(c);
  ok(!ts.shown, 'C: the "Added" toast is cleared when the ticket opens', JSON.stringify(ts));
  await c.waitForTimeout(300);
  await c.waitForTimeout(350); await c.screenshot({path: shotPath('08-ticket-no-toast.png'), fullPage: true});
  ok(await noHScroll(c), 'C: no sideways scroll on the ticket');

  await c.fill('#pc-phone', TAKEN);
  await c.click('#pc-save');
  ok(await until(async () => /already registered/i.test(await c.textContent('#pc-err')), 5000), 'C: save number -> PHONE_TAKEN message', await c.textContent('#pc-err'));
  ok(await c.isVisible('#pc-help .taken button'), 'C: offers "Yes, connect this phone" on the ticket');
  await c.focus('#pc-phone');
  await c.waitForTimeout(6500);   // at least one 5-second refresh of the ticket
  ok(await c.inputValue('#pc-phone') === TAKEN && /already registered/i.test(await c.textContent('#pc-err')) && await c.isVisible('#pc-help .taken button'),
    'C: the number, message and offer survive the ticket refresh');
  ok(await c.evaluate(() => document.activeElement && document.activeElement.id === 'pc-phone'), 'C: the number field keeps focus through the refresh (keyboard stays up)');
  await c.locator('#phone-card').scrollIntoViewIfNeeded();
  await c.waitForTimeout(350); await c.screenshot({path: shotPath('09-ticket-phone-taken.png')});
  await c.click('#pc-help .taken button');
  await c.waitForSelector('#r-go');
  ok(await c.inputValue('#r-phone') === TAKEN && await c.inputValue('#r-name') === 'Ann', 'C: relink sheet prefilled with the number and current name');
  await c.click('#r-go');
  ok(await until(async () => /No match/i.test(await c.textContent('#r-err')), 5000), 'C: wrong name -> NO_MATCH message');
  await c.waitForTimeout(350); await c.screenshot({path: shotPath('10-relink-no-match.png')});
  await c.fill('#r-name', 'Zed');
  await c.click('#r-go');
  ok(await until(async () => !(await c.isVisible('#r-go')), 8000), 'C: right name -> sheet closes');
  ok(await c.isVisible('.ticket-no') && !(await c.isVisible('#phone-card')), 'C: still on the ticket, number card gone (number known now)');
  ok(/for Zed/.test(await c.textContent('.ticket-where')), 'C: ticket now says "for Zed"');
  ts = await toastState(c);
  ok(ts.shown && /Welcome back, Zed/.test(ts.text) && ts.hits.length === 0, 'C: welcome-back toast on the ticket covers no button', JSON.stringify(ts));
  await c.waitForTimeout(350); await c.screenshot({path: shotPath('11-ticket-after-relink.png'), fullPage: true});

  // cancel -> toast must not cover "Cancel this order" / "Order something else"
  await c.waitForTimeout(3400);
  await c.click('#cancel-order');
  ok(await until(async () => /You cancelled/.test(await c.textContent('.ticket')), 5000), 'C: order cancelled');
  ts = await toastState(c);
  ok(ts.shown && /cancelled/i.test(ts.text) && ts.hits.length === 0, 'C: "Order cancelled" toast covers no button', JSON.stringify(ts));
  await c.waitForTimeout(350); await c.screenshot({path: shotPath('12-cancelled-toast.png')});

  // a cancel the shop refuses: message next to the buttons, kept through refreshes
  await c.click('#order-more');
  await placeOrder(c);
  await c.route('**/rest/v1/rpc/qr_cancel_order', r => r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({error: 'CANNOT_CANCEL'})}));
  await c.click('#cancel-order');
  ok(await until(async () => /can't be cancelled here/.test(await c.textContent('.inline-alert')), 5000), 'C: refused cancel shows a message under the buttons (not a toast)');
  await c.waitForTimeout(6000);
  ok(await c.isVisible('.inline-alert') && await c.isEnabled('#cancel-order'), 'C: message stays through the refresh; cancel button usable again');
  await c.locator('.inline-alert').scrollIntoViewIfNeeded();
  await c.waitForTimeout(350); await c.screenshot({path: shotPath('13-cancel-refused.png')});
  await c.unroute('**/rest/v1/rpc/qr_cancel_order');
  await c.click('#order-more');
  ok(!(await c.isVisible('.inline-alert')), 'C: message cleared when leaving the ticket');

  // ---- D. 360 px phone hits the limit on register, then on relink
  const d = await phone('D', {viewport: {width: 360, height: 740}});
  for(let i = 0; i < 5; i++){
    if(i === 0) await register(d, 'Bob', TAKEN); else await d.click('#w-go');
    await until(async () => /already registered/i.test(await d.textContent('#w-err')), 5000);
    await d.evaluate(() => { document.getElementById('w-err').textContent = ''; });
  }
  await d.click('#w-go');
  ok(await until(async () => /Too many tries with a mobile number/.test(await d.textContent('#w-err')), 5000), 'D: 6th try -> TOO_MANY_ATTEMPTS (register wording: wait, or leave the number blank)', await d.textContent('#w-err'));
  ok(!(await d.isVisible('#w-help .taken')), 'D: no connect offer with the limit message');
  ok(await noHScroll(d), 'D: no sideways scroll at 360 px');
  await d.locator('#w-err').scrollIntoViewIfNeeded();
  await d.waitForTimeout(350); await d.screenshot({path: shotPath('14-register-too-many-360.png')});
  await d.click('#w-relink');
  await d.fill('#r-phone', TAKEN); await d.fill('#r-name', 'Zed');
  await d.click('#r-go');
  ok(await until(async () => /Too many tries\. Please wait about 15 minutes, or ask our staff/.test(await d.textContent('#r-err')), 5000), 'D: relink -> TOO_MANY_ATTEMPTS (relink wording)', await d.textContent('#r-err'));
  await d.waitForTimeout(350); await d.screenshot({path: shotPath('15-relink-too-many-360.png')});
  await d.click('#sheet-x');
  // leaving the number blank still works
  await d.fill('#w-phone', '');
  await d.click('#w-go');
  ok(await registered(d), 'D: can still join with the number left blank');

  // ---- E. save-number limit + NOT_SIGNED_IN
  const e = await phone('E', {reducedMotion: 'reduce'});
  await register(e, 'Cy');
  ok(await registered(e), 'E: Cy registered');
  ok(await e.evaluate(() => getComputedStyle(document.getElementById('toast')).transitionDuration.split(',').every(s => parseFloat(s) === 0)), 'E: reduced motion -> toast has no animation');
  await placeOrder(e);
  for(let i = 0; i < 5; i++){
    await e.fill('#pc-phone', TAKEN); await e.click('#pc-save');
    await until(async () => /already registered/i.test(await e.textContent('#pc-err')), 5000);
  }
  await e.click('#pc-save');
  ok(await until(async () => /^Too many tries\. Please wait about 15 minutes, then try again\.$/.test(await e.textContent('#pc-err')), 5000), 'E: save number -> TOO_MANY_ATTEMPTS (save wording)', await e.textContent('#pc-err'));
  await e.locator('#phone-card').scrollIntoViewIfNeeded();
  await e.waitForTimeout(350); await e.screenshot({path: shotPath('16-save-too-many.png')});
  await e.route('**/rest/v1/rpc/qr_set_phone', r => r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({error: 'NOT_SIGNED_IN'})}));
  await e.fill('#pc-phone', '0918 765 4321'); await e.click('#pc-save');
  ok(await until(async () => /isn't connected\. Reload the page/.test(await e.textContent('#pc-err')), 5000), 'E: NOT_SIGNED_IN -> plain "reload" message', await e.textContent('#pc-err'));
  await e.waitForTimeout(350); await e.screenshot({path: shotPath('17-save-not-signed-in.png')});
  await e.unroute('**/rest/v1/rpc/qr_set_phone');
  // keyboard focus is visible on the offer button
  await e.fill('#pc-phone', '0917 123 4567');
  await e.evaluate(() => { document.getElementById('pc-err').textContent = ''; });

  // ---- F. customer text with HTML in it is shown as text
  const f = await phone('F');
  await register(f, '<img src=x onerror=alert(1)>Al');
  ok(await registered(f), 'F: odd nickname registered');
  ok(await f.evaluate(() => !document.querySelector('.member-name img, #toast img, #not-me img')), 'F: nickname shown as text (no HTML injected)');
  await f.click('#not-me'); await f.click('#nm-go');
  await f.waitForSelector('#w-name');
  await register(f, `Al & "Bo" 'x'`);
  ok(await registered(f), 'F: nickname with & and quotes registered');
  ok((await f.textContent('.member-name')).includes(`Al & "Bo" 'x'`) && (await f.textContent('#not-me')).includes(`Al & "Bo" 'x'`), 'F: & and quotes shown literally (escaped, not eaten)', await f.textContent('.member-name'));

  ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(async e => { try{ await browser.close(); }catch(_){} H.abort(NAME, e); });
