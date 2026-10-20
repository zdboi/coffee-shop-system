// QR page: shop-wide / per-table flood limits (security review 2026-10-19, F5) and the non-blocking web font
// (phone 390x844).
//   1  TOO_MANY_SIGNUPS from the server (40 QR sign-ups in the last hour, real) -> plain message, nothing saved;
//      the same answer simulated by intercepting qr_register -> same message; after the rush the sign-up works
//   2  TOO_MANY_ORDERS from the server (10 orders waiting at the table, real) -> plain message, cart kept,
//      button usable again; the same answer simulated by intercepting qr_place_order; after the rush the order goes in
//   3  the page is usable while the web font never arrives (font request held open)
// Needs a fresh seed:   tests/e2e_reset.sh [db]  &&  tests/restart_fake.sh [port] [db]
// Run:                  FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/order_limits.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {BASE, sql, ok, until} = H;
const NAME = 'order_limits.e2e';
const URL = BASE + '/cccc/order/?t=tabletoken5';
const TABLE = '77777777-0000-0000-0000-000000000005';
const SIGNUPS_TEXT = 'Lots of people are joining right now. Please wait a few minutes, or order at the counter.';
const ORDERS_TEXT = "We're getting a lot of orders right now. Please wait a few minutes or order at the counter.";

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  try{
    // ---- 3. web font held open: the first screen still shows and works
    const fctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
    await fctx.route(/fonts\.(googleapis|gstatic)\.com/, () => { /* never answered */ });
    const fp = await fctx.newPage(); H.attach(fp, errors, 'QR-font');
    const t0 = Date.now();
    await fp.goto(URL, {waitUntil: 'commit'});
    const shown = await fp.waitForSelector('#w-name', {timeout: 8000}).then(() => true).catch(() => false);
    ok(shown && Date.now() - t0 < 8000, `first screen shows while the font never arrives (${Date.now() - t0} ms)`);
    ok(await fp.evaluate(() => getComputedStyle(document.querySelector('#w-name')).visibility !== 'hidden'), 'name box visible and usable');
    await fctx.close();

    const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
    const page = await ctx.newPage(); H.attach(page, errors, 'QR');
    await page.goto(URL);
    await page.waitForSelector('#w-name', {timeout: 15000});

    // ---- 1. TOO_MANY_SIGNUPS (real server answer)
    sql(`insert into customers(business_id, nickname, source) select '${biz}', 'Rush ' || g, 'QR' from generate_series(1, 40) g`);
    await page.fill('#w-name', 'Gina'); await page.check('#w-consent'); await page.click('#w-go');
    ok(await until(async () => (await page.textContent('#w-err')) === SIGNUPS_TEXT, 6000), 'server TOO_MANY_SIGNUPS -> "' + SIGNUPS_TEXT + '"', await page.textContent('#w-err'));
    ok(sql(`select count(*) from customers where nickname='Gina'`) === '0', 'not saved');
    ok(!(await page.isDisabled('#w-go')), 'button usable again');
    await H.shot(page, 'qr-limits-signups');
    sql(`delete from customers where nickname like 'Rush %'`);
    // simulated
    const signupsFull = (r) => r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({error: 'TOO_MANY_SIGNUPS'})});
    await page.route(/\/rest\/v1\/rpc\/qr_register$/, signupsFull);
    await page.evaluate(() => { document.querySelector('#w-err').textContent = ''; });
    await page.click('#w-go');
    ok(await until(async () => (await page.textContent('#w-err')) === SIGNUPS_TEXT, 6000), 'intercepted TOO_MANY_SIGNUPS -> same message', await page.textContent('#w-err'));
    await page.unroute(/\/rest\/v1\/rpc\/qr_register$/, signupsFull);
    await page.click('#w-go');
    ok(await until(async () => await page.isVisible('#not-me'), 10000), 'after the rush: Gina signs up');
    ok(sql(`select count(*) from customers where nickname='Gina' and source='QR'`) === '1', 'Gina saved once');

    // ---- 2. TOO_MANY_ORDERS (real: 10 orders waiting at Table 5)
    sql(`insert into qr_orders(business_id, order_number, order_day, table_id, table_label, status, items, total)
         select '${biz}', 'Q-9' || lpad(g::text, 2, '0'), current_date, '${TABLE}', 'Table 5', 'PENDING', '[]', 0 from generate_series(1, 10) g`);
    await page.waitForTimeout(3300);                 // let the welcome toast go
    await page.click('.item[data-item="33333333-0000-0000-0000-000000000003"]');
    await page.waitForSelector('#it-add'); await page.click('#it-add');
    await page.waitForSelector('#view-cart');
    await page.click('#view-cart');
    await page.click('#c-place');
    ok(await until(async () => (await page.textContent('#c-err')) === ORDERS_TEXT, 6000), 'server TOO_MANY_ORDERS -> "' + ORDERS_TEXT + '"', await page.textContent('#c-err'));
    ok(!(await page.isDisabled('#c-place')) && /Place order/.test(await page.textContent('#c-place')), 'Place order button usable again', await page.textContent('#c-place'));
    ok(sql(`select count(*) from qr_orders where customer_nickname='Gina'`) === '0', 'no order saved');
    await H.shot(page, 'qr-limits-orders');
    sql(`delete from qr_orders where order_number like 'Q-9%'`);
    // simulated
    const ordersFull = (r) => r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({error: 'TOO_MANY_ORDERS'})});
    await page.route(/\/rest\/v1\/rpc\/qr_place_order$/, ordersFull);
    await page.evaluate(() => { document.querySelector('#c-err').textContent = ''; });
    await page.click('#c-place');
    ok(await until(async () => (await page.textContent('#c-err')) === ORDERS_TEXT, 6000), 'intercepted TOO_MANY_ORDERS -> same message', await page.textContent('#c-err'));
    await page.unroute(/\/rest\/v1\/rpc\/qr_place_order$/, ordersFull);
    await page.click('#c-place');
    ok(await until(async () => await page.isVisible('.ticket-no'), 10000), 'after the rush: the order goes in (ticket shown)');
    ok(sql(`select count(*)||'|'||min(total)::numeric(12,0) from qr_orders where customer_nickname='Gina'`) === '1|110', 'one order saved, priced by the server (₱110)', sql(`select count(*)||'|'||min(total)::numeric(12,0) from qr_orders where customer_nickname='Gina'`));

    ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  }catch(e){ console.log('STOPPED', e.message); H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
