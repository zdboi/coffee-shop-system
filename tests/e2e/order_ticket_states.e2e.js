// QR page ticket wording per order state (phone 390x844), adopted from the QR developer's ticket_states.js.
// Every change is made in the database while the ticket is open; the page must pick it up on its own
// 5-second refresh, WITHOUT a reload (checked with a marker on window + a count of page loads).
//   open + unpaid  -> "pay at the counter"            open + paid (PREPARING) -> "Paid — thank you!"
//   READY          -> step "Ready"                     COMPLETED + paid        -> "Enjoy", "Paid — thank you!" only
//   cancelled by the customer -> "You cancelled this order. Nothing to pay." + "Not charged"
//   rejected with a reason (with HTML in it) -> "Sorry, we couldn't take this order." + reason as plain text
//   rejected without a reason -> no empty reason line
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/order_ticket_states.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {BASE, sql, ok, until} = H;
const NAME = 'order_ticket_states.e2e';
const URL = BASE + '/cccc/order/?t=tabletoken5';
const REFRESH_MS = 11000;     // 5-second refresh: allow two rounds + rendering

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
  const page = await ctx.newPage();
  const errors = []; H.attach(page, errors, 'QR');
  let loads = 0;
  page.on('framenavigated', f => { if(f === page.mainFrame()) loads++; });
  const ticket = async () => ((await page.textContent('.ticket')) || '').replace(/\s+/g, ' ');
  const payLine = async () => ((await page.textContent('.ticket-pay')) || '').replace(/\s+/g, ' ');
  const shot = async (n) => { await page.waitForTimeout(300); await H.shot(page, 'ticket-' + n, {fullPage: true}); };
  // the page must not have been reloaded since mark()
  const mark = () => page.evaluate(() => { window.__ticketMarker = 'still-here'; });
  const notReloaded = async (loadsBefore) => loads === loadsBefore && await page.evaluate(() => window.__ticketMarker === 'still-here');
  // a database change shows up by itself; returns seconds taken or null
  const shows = async (re, getter) => { const t0 = Date.now(); const y = await until(async () => re.test(await (getter || ticket)()), REFRESH_MS + 2000, 250); return y ? (Date.now() - t0) / 1000 : null; };
  const place = async () => {
    await page.click('.item[data-item="33333333-0000-0000-0000-000000000001"]');
    await page.click('.opt[data-g="g-size"][data-o="o-16"]');
    await page.click('#it-add'); await page.waitForSelector('#view-cart'); await page.click('#view-cart');
    await page.click('#c-place'); await page.waitForSelector('.ticket-no', {timeout: 10000});
    return (await page.textContent('.ticket-no')).trim();
  };
  try{
    await page.goto(URL);
    await page.waitForSelector('#w-name', {timeout: 15000});
    await page.fill('#w-name', 'Zed'); await page.check('#w-consent'); await page.click('#w-go');
    await page.waitForSelector('#not-me');

    // 1. open, unpaid
    const no1 = await place();
    ok(/pay at the counter/i.test(await payLine()), 'open + unpaid: pay-at-counter line shown', await payLine());
    ok(!/Paid|Not charged/.test(await payLine()), 'open + unpaid: no "Paid" / "Not charged"', await payLine());
    ok(/Waiting for the barista/i.test(await ticket()), 'open + unpaid: "Waiting for the barista"', await ticket());
    await shot('1-open-unpaid');
    await mark(); const l0 = loads;

    // 2. open, paid (the counter took payment: PREPARING + paid_at)
    sql(`update qr_orders set status='PREPARING', paid_at=now(), accepted_at=now() where order_number='${no1}'`);
    let s = await shows(/Paid — thank you!/, payLine);
    ok(s !== null, `open + paid: "Paid — thank you!" appears by itself (${s} s)`, await payLine());
    ok(!/counter/i.test(await payLine()), 'open + paid: no pay-at-counter line', await payLine());
    ok(await notReloaded(l0), 'open + paid: picked up without reloading the page');
    await shot('2-open-paid-preparing');

    // 3. ready
    sql(`update qr_orders set status='READY', ready_at=now() where order_number='${no1}'`);
    s = await shows(/Ready/, async () => (await page.textContent('.step.now')) || '');
    ok(s !== null, `ready: the "Ready" step is shown by itself (${s} s)`, await ticket());
    ok(await notReloaded(l0), 'ready: without reloading the page');
    await shot('3-ready');

    // 4. completed and paid
    sql(`update qr_orders set status='COMPLETED', completed_at=now() where order_number='${no1}'`);
    s = await shows(/Enjoy/);
    ok(s !== null, `completed: ticket says "Enjoy" (${s} s)`, await ticket());
    ok(/Paid — thank you!/.test(await payLine()) && !/counter/i.test(await payLine()), 'completed + paid: "Paid — thank you!" only', await payLine());
    ok(await notReloaded(l0), 'completed: without reloading the page');
    await shot('4-completed-paid');

    // 5. cancelled by the customer
    await page.click('#order-more'); await place();
    await page.click('#cancel-order');
    ok(await until(async () => /You cancelled this order/.test(await ticket()), 8000), 'cancelled: "You cancelled this order."', await ticket());
    const t5 = await ticket();
    ok(/You cancelled this order\.\s*Nothing to pay\./.test(t5), 'cancelled: "Nothing to pay." under it', t5);
    ok(!/pay at the counter/i.test(t5) && !/Paid/.test(t5), 'cancelled: no pay-at-counter / Paid wording', t5);
    ok(/Not charged/.test(await payLine()), 'cancelled: money line says "Not charged"', await payLine());
    ok(/Back to the menu/.test(await page.textContent('#order-more')) && !(await page.isVisible('#cancel-order')), 'cancelled: "Back to the menu", no cancel button');
    await page.waitForTimeout(5500);           // one refresh later it still says the same
    ok(/You cancelled this order/.test(await ticket()), 'cancelled: wording stays after a refresh round');
    await shot('5-cancelled');

    // 6. rejected by the shop, with a reason that has HTML in it
    await page.click('#order-more'); const no3 = await place();
    await mark(); const l6 = loads;
    const reason = `Out of <b>oat</b> milk & "beans" <img src=x onerror=alert(1)>`;
    sql(`update qr_orders set status='REJECTED', reject_reason=$$${reason}$$ where order_number='${no3}'`);
    s = await shows(/couldn't take this order/);
    ok(s !== null, `rejected: "Sorry, we couldn't take this order." appears by itself (${s} s)`, await ticket());
    const t6 = await ticket();
    ok(t6.includes(reason), 'rejected: the reason is shown as plain text', t6);
    ok(await page.evaluate(() => !document.querySelector('.ticket img') && !document.querySelector('.ticket-note b b, .ticket-note p b')), 'rejected: no HTML from the reason got into the page');
    ok(!/pay at the counter/i.test(t6) && !/Paid/.test(t6) && /Not charged/.test(await payLine()), 'rejected: no pay-at-counter wording; money line says "Not charged"', t6);
    ok(await notReloaded(l6), 'rejected: without reloading the page');
    await shot('6-rejected-with-reason');

    // 7. rejected without a reason
    await page.click('#order-more'); const no4 = await place();
    sql(`update qr_orders set status='REJECTED', reject_reason='' where order_number='${no4}'`);
    ok(await shows(/couldn't take this order/) !== null, 'rejected (no reason): headline shown');
    ok(await page.evaluate(() => document.querySelectorAll('.ticket-note p').length === 0), 'rejected (no reason): no empty reason line');
    await shot('7-rejected-no-reason');

    await page.click('#order-more');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at 390 px');
  }catch(e){ await H.shot(page, 'ticket-stopped', {fullPage: true}); await browser.close(); H.abort(NAME, e); }
  ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
