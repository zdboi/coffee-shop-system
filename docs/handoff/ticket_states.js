const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const SHOTS = process.argv[2];
const URL = 'http://localhost:8792/cccc/order/?t=tabletoken5';
const psql = (q) => execFileSync('psql', ['-h','/tmp','-p','54329','-U','postgres','-d','db_qr','-At','-v','ON_ERROR_STOP=1','-c',q]).toString().trim();
let fails = 0;
const ok = (c, m, got) => { if(!c) fails++; console.log((c ? 'ok      ' : 'FAILED  ') + m + (!c && got !== undefined ? '   [got: ' + String(got).slice(0,300) + ']' : '')); };
async function until(fn, ms){ const end = Date.now() + (ms || 12000); while(Date.now() < end){ try{ if(await fn()) return true; }catch(e){} await new Promise(r => setTimeout(r, 200)); } return false; }
const isFont = (u) => /fonts\.(googleapis|gstatic)\.com/.test(u || '');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if(m.type() === 'error' && !isFont(m.location().url)) errors.push('console: ' + m.text()); });
  const shot = async (n) => { await page.waitForTimeout(400); await page.screenshot({path: path.join(SHOTS, n), fullPage: true}); };
  const ticket = () => page.textContent('.ticket');
  const payLine = () => page.textContent('.ticket-pay');
  await page.goto(URL);
  await page.waitForSelector('#w-name', {timeout: 15000});
  await page.fill('#w-name', 'Zed'); await page.check('#w-consent'); await page.click('#w-go');
  await page.waitForSelector('#not-me');
  await page.waitForTimeout(3500);
  const place = async () => {
    await page.click('.item[data-item="33333333-0000-0000-0000-000000000001"]');
    await page.click('.opt[data-g="g-size"][data-o="o-16"]');
    await page.click('#it-add'); await page.waitForSelector('#view-cart'); await page.click('#view-cart');
    await page.click('#c-place'); await page.waitForSelector('.ticket-no', {timeout: 10000});
  };

  // 1. open, unpaid
  await place();
  const no1 = (await page.textContent('.ticket-no')).trim();
  ok(/pay at the counter/i.test(await payLine()), 'open + unpaid: pay-at-counter line shown', await payLine());
  ok(!/Paid|Not charged/.test(await payLine()), 'open + unpaid: no "Paid"/"Not charged"');
  await shot('1-open-unpaid.png');

  // 2. open, paid (counter took payment -> PREPARING + paid_at)
  psql(`update qr_orders set status='PREPARING', paid_at=now(), accepted_at=now() where order_number='${no1}'`);
  ok(await until(async () => /Paid — thank you!/.test(await payLine()), 12000), 'open + paid: "Paid — thank you!"', await payLine());
  ok(!/counter/i.test(await payLine()), 'open + paid: no pay-at-counter line');
  await shot('2-open-paid-preparing.png');

  // 3. completed and paid
  psql(`update qr_orders set status='COMPLETED', completed_at=now() where order_number='${no1}'`);
  ok(await until(async () => /Enjoy/.test(await ticket()), 12000), 'completed: ticket says Enjoy');
  ok(/Paid — thank you!/.test(await payLine()) && !/counter/i.test(await payLine()), 'completed + paid: "Paid — thank you!" only', await payLine());
  await shot('3-completed-paid.png');

  // 4. cancelled by the customer
  await page.click('#order-more'); await place();
  const no2 = (await page.textContent('.ticket-no')).trim();
  await page.click('#cancel-order');
  ok(await until(async () => /You cancelled this order/.test(await ticket()), 8000), 'cancelled: ticket says "You cancelled this order."');
  const t4 = (await ticket()).replace(/\s+/g, ' ');
  ok(/You cancelled this order\.\s*Nothing to pay\./.test(t4), 'cancelled: "Nothing to pay." under it', t4);
  ok(!/pay at the counter/i.test(t4) && !/Paid/.test(t4), 'cancelled: no pay-at-counter / Paid wording', t4);
  ok(/Not charged/.test(await payLine()), 'cancelled: money line says Not charged', await payLine());
  await page.waitForTimeout(3500);
  await shot('4-cancelled.png');

  // 5. rejected, with a reason that has HTML in it
  await page.click('#order-more'); await place();
  const no3 = (await page.textContent('.ticket-no')).trim();
  const reason = `Out of <b>oat</b> milk & "beans" <img src=x onerror=alert(1)>`;
  psql(`update qr_orders set status='REJECTED', reject_reason=$$${reason}$$ where order_number='${no3}'`);
  ok(await until(async () => /couldn't take this order/.test(await ticket()), 12000), 'rejected: ticket says "Sorry, we couldn\'t take this order."');
  const t5 = (await ticket()).replace(/\s+/g, ' ');
  ok(t5.includes(reason), 'rejected: reason shown as plain text (escaped)', t5);
  ok(await page.evaluate(() => !document.querySelector('.ticket-note img') && document.querySelectorAll('.ticket-note b').length === 1), 'rejected: no HTML was injected from the reason');
  ok(!/pay at the counter/i.test(t5) && !/Paid/.test(t5) && /Not charged/.test(await payLine()), 'rejected: no pay-at-counter wording; money line says Not charged', t5);
  await shot('5-rejected-with-reason.png');

  // 6. rejected without a reason
  await page.click('#order-more'); await place();
  const no4 = (await page.textContent('.ticket-no')).trim();
  psql(`update qr_orders set status='REJECTED', reject_reason='' where order_number='${no4}'`);
  ok(await until(async () => /couldn't take this order/.test(await ticket()), 12000), 'rejected (no reason): headline shown');
  ok(await page.evaluate(() => document.querySelectorAll('.ticket-note p').length === 0), 'rejected (no reason): no empty reason line');
  await shot('6-rejected-no-reason.png');

  // menu list pill + no horizontal scroll
  await page.click('#order-more');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
  ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
