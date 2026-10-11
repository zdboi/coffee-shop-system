// Build C customer QR page end-to-end (phone 390x844):
// first visit -> register (nickname + phone + consent) -> reload says "Welcome back" ->
// item that needs a size -> place order -> order in the database with the server's total ->
// set READY in the database -> page shows "Ready" within ~10 s. No browser errors.
//
// Needs:  tests/e2e_reset.sh   then (as its own command)  tests/restart_fake.sh
// Run:    QA_SHOTS=/some/folder node tests/e2e/order.e2e.js
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'http://localhost:8787';
const URL = BASE + '/cccc/order/?t=tabletoken5';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'cccc-qa-shots');
fs.mkdirSync(SHOTS, { recursive: true });

// read-only checks go through the stand-in's /__sql helper; status changes use psql directly
async function sql(q){ const r = await fetch(BASE + '/__sql', {method: 'POST', body: `select to_jsonb((${q}))`}); const t = await r.text(); if(!r.ok) throw new Error(t); return JSON.parse(t); }
function psql(q){ return execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', 'cccc', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim(); }

const results = [];
function ok(cond, msg, got){
  results.push({ok: !!cond, msg});
  console.log((cond ? 'ok      ' : 'FAILED  ') + msg + (!cond && got !== undefined ? '   [got: ' + String(got).slice(0, 300) + ']' : ''));
}
async function until(fn, ms){ const end = Date.now() + (ms || 15000); while(Date.now() < end){ try{ if(await fn()) return true; }catch(e){} await new Promise(r => setTimeout(r, 250)); } return false; }
const isFont = (u) => /fonts\.(googleapis|gstatic)\.com/.test(u || '');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if(m.type() === 'error' && !isFont(m.location().url)) errors.push('console: ' + m.text() + ' @ ' + m.location().url); });
  page.on('requestfailed', r => { const f = r.failure() ? r.failure().errorText : ''; if(!isFont(r.url()) && !/ERR_ABORTED/.test(f)) errors.push('request failed: ' + r.url() + ' ' + f); });
  const placeBodies = [];
  page.on('request', r => { if(r.url().includes('/rest/v1/rpc/qr_place_order')) placeBodies.push(r.postData() || ''); });
  const noHScroll = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // ---- 1. first visit
  await page.goto(URL);
  const welcomeShown = await until(async () => await page.isVisible('#w-name'), 15000);
  ok(welcomeShown, 'first visit shows the name form');
  if(!welcomeShown){ await page.screenshot({path: path.join(SHOTS, 'order-00-fail.png'), fullPage: true}); throw new Error('cannot continue'); }
  ok((await page.textContent('#brand-name')).includes('Cavite City Coffee Club') && (await page.textContent('#table-tag')).includes('Table 5'), 'shop name and table label shown');
  ok((await page.$$('.item[aria-disabled="true"]')).length >= 3, 'menu is shown as a preview (cannot add before giving a name)');
  ok(await noHScroll(), 'no sideways scrolling at 390 px (welcome)');
  await page.screenshot({path: path.join(SHOTS, 'order-01-first-visit.png'), fullPage: true});
  ok((await sql(`select count(*) from auth.users where is_anonymous`)) === 1, 'phone got one anonymous login, no account form');

  // ---- 2. register
  await page.fill('#w-name', 'Zed');
  await page.fill('#w-phone', '0917 123 4567');
  await page.click('#w-go');
  await until(async () => (await page.textContent('#w-err')).length > 0, 3000);
  ok(/tick the box/i.test(await page.textContent('#w-err')), 'consent box is required');
  await page.check('#w-consent');
  await page.click('#w-go');
  const registered = await until(async () => await page.isVisible('.member-name'), 10000);
  ok(registered && (await page.textContent('.member-name')).includes('Zed'), 'registered: member card shows Zed');
  const cust = await sql(`select jsonb_build_object('n', count(*), 'phone', max(phone), 'consent', bool_and(consent_at is not null), 'src', max(source)) from customers where nickname = 'Zed'`);
  ok(cust.n === 1 && cust.phone === '+639171234567' && cust.consent && cust.src === 'QR', 'customer saved: nickname, phone +639171234567, consent time, source QR', JSON.stringify(cust));
  ok((await sql(`select count(*) from customer_devices`)) === 1, 'this phone linked to the customer');

  // ---- 3. reload -> welcome back
  await page.reload();
  const back = await until(async () => /Welcome back/i.test(await page.textContent('.member-hello')), 10000);
  ok(back && (await page.textContent('.member-name')).includes('Zed'), 'reload greets "Welcome back, Zed!" with no sign-in');
  ok(!(await page.isVisible('#w-name')), 'name form not shown again');
  ok((await sql(`select count(*) from auth.users where is_anonymous`)) === 1, 'reload reused the same phone login');
  await page.screenshot({path: path.join(SHOTS, 'order-02-welcome-back.png'), fullPage: true});

  // ---- 4. item that needs a size
  await page.click('.item[data-item="33333333-0000-0000-0000-000000000001"]');
  await page.waitForSelector('#it-add', {timeout: 5000});
  await page.click('#it-add');
  ok(await until(async () => /Please choose/i.test(await page.textContent('.group[data-group="g-size"] small')), 3000), 'adding without a size asks to choose one');
  ok(!(await page.isVisible('#view-cart')), 'nothing added without the size');
  await page.click('.opt[data-g="g-size"][data-o="o-16"]');
  await page.click('.opt[data-g="g-add"][data-o="o-shot"]');
  await page.click('#q-plus');
  const addText = await page.textContent('#it-add');
  ok(/Add 2 to order/.test(addText) && addText.includes('₱400.00'), 'sheet shows (150 + 20 + 30) x 2 = ₱400.00', addText);
  await page.screenshot({path: path.join(SHOTS, 'order-03-size-choice.png')});
  await page.click('#it-add');
  await page.waitForSelector('#view-cart', {timeout: 5000});
  const bar = await page.textContent('#view-cart');
  ok(/2 items/.test(bar) && bar.includes('₱400.00'), 'order bar: 2 items, ₱400.00', bar);

  // ---- 5. place order
  await page.click('#view-cart');
  await page.waitForSelector('#c-place', {timeout: 5000});
  ok(await noHScroll(), 'no sideways scrolling at 390 px (order sheet)');
  await page.screenshot({path: path.join(SHOTS, 'order-04-cart.png')});
  await page.click('#c-place');
  const ticket = await until(async () => await page.isVisible('.ticket-no'), 10000);
  ok(ticket && (await page.textContent('.ticket-no')).trim() === 'Q-001', 'ticket shows order number Q-001');
  ok(placeBodies.length === 1 && !/price|total|amount/i.test(placeBodies[0]), 'the phone sends no prices, only items + options', placeBodies[0]);
  const ord = await sql(`select jsonb_build_object('n', count(*), 'status', max(status), 'subtotal', max(subtotal), 'total', max(total), 'nick', max(customer_nickname),
      'table', max(table_label), 'unit', max((items->0->>'unit_price')::numeric), 'qty', max((items->0->>'quantity')::int),
      'mods', max(jsonb_array_length(items->0->'modifiers')), 'milk', max(items->0->'modifiers'->0->>'ingredient_id')) from qr_orders`);
  ok(ord.n === 1 && ord.status === 'PENDING' && ord.nick === 'Zed' && ord.table === 'Table 5', 'order saved: PENDING, for Zed, Table 5', JSON.stringify(ord));
  ok(Number(ord.subtotal) === 400 && Number(ord.total) === 400 && Number(ord.unit) === 200 && ord.qty === 2, 'database worked out the price itself: 2 x 200 = 400', JSON.stringify(ord));
  ok(ord.mods === 2 && ord.milk === '22222222-0000-0000-0000-000000000002', 'order keeps both options and the 16oz milk link for the counter', JSON.stringify(ord));
  const shownTotal = await page.textContent('.ticket-pay b');
  ok(shownTotal.includes('₱400.00'), 'ticket total matches the database (₱400.00)', shownTotal);
  ok(/Waiting for the barista/i.test(await page.textContent('.steps')), 'ticket says waiting for the barista');
  await page.screenshot({path: path.join(SHOTS, 'order-05-ticket-pending.png'), fullPage: true});

  // ---- 6. shop marks it READY in the database
  const t0 = Date.now();
  psql(`update qr_orders set status = 'READY', ready_at = now(), accepted_at = now() where order_number = 'Q-001'`);
  const ready = await until(async () => /Ready/.test(await page.textContent('.step.now') || ''), 12000);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  ok(ready && Date.now() - t0 <= 11000, `page shows "Ready" by itself (${secs} s after the change)`);
  ok(/ready/i.test(await page.textContent('#toast')) || /Ready/.test(await page.title()), 'phone announces the order is ready (toast / tab title)');
  await page.screenshot({path: path.join(SHOTS, 'order-06-ready.png'), fullPage: true});

  ok(errors.length === 0, 'no browser errors (Google Fonts blocked by the sandbox ignored)', errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nBUILD C ORDER PAGE E2E: ${results.length} checks, ${results.length - failed} ok, ${failed} FAILED   (screenshots: ${SHOTS})`);
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error(e); process.exit(1); });
