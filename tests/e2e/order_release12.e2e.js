// Release 1.2 QR page checks (adopted from customer-qr-dev's check.js), phone 390x844 + 360x740 + desktop 1280x800:
// CCCC theme (wordmark, theme-color, terracotta header, Brunson from the same site, capital section titles),
// no sideways scroll, 44 px tap targets, stamp card 0 -> 4 -> 5 (₱10 ready) -> 7 -> redeemed -> 15 -> card 2,
// screen-reader text, item options / cart / order status at three sizes, ticket turns Ready by itself,
// loyalty off hides the card, CUSTOM theme (escaped business name, saved colours), back to CCCC,
// no request leaves the site, no page errors.   Screenshots: $QA_SHOTS/qr12/.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
//   FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/order_release12.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const path = require('path');
const fs = require('fs');
const NAME = 'order_release12.e2e';
const BASE = H.BASE, URL = BASE + '/cccc/order/?t=tabletoken5';
const SHOTS = path.join(H.SHOTS, 'qr12'); fs.mkdirSync(SHOTS, {recursive: true});
const BIZ = "(select id from businesses limit 1)";
const psql = (q) => H.sql(q);
const ok = (c, m, d) => H.ok(c, m, d);
const sleep = H.sleep;
async function until(fn, ms){ const end = Date.now() + (ms || 10000); while(Date.now() < end){ try{ if(await fn()) return true; }catch(e){} await sleep(150); } return false; }
const SIZES = {p390: {width: 390, height: 844}, p360: {width: 360, height: 740}, d1280: {width: 1280, height: 800}};
let stampCount = 0, custId = null;
function addStamps(k){   // each stamp = one sale on its own (day, kind): drink then food, a new day every 2
  for(let i = 0; i < k; i++){
    const n = stampCount++;
    const day = 60 - Math.floor(n / 2), food = n % 2 === 1;
    const rid = food ? '33333333-0000-0000-0000-000000000004' : '33333333-0000-0000-0000-000000000003';
    psql(`with s as (insert into sales(business_id, customer_id, status, transaction_date, subtotal, grand_total)
           values (${BIZ}, '${custId}', 'COMPLETED', now() - interval '${day} days', 100, 100) returning id)
          insert into sale_items(sale_id, business_id, recipe_id, quantity, unit_price) select id, ${BIZ}, '${rid}', 1, 100 from s`);
  }
}
H.openShopForQr();   // 1.3: QR ordering needs an open shift (see lib/h.js)
(async () => {
  psql(`update settings set loyalty_enabled = true, theme = 'CCCC'`);
  const browser = await chromium.launch();
  const outside = [], errors = [];
  async function phone(size, storage){
    const ctx = await browser.newContext({viewport: SIZES[size], isMobile: size !== 'd1280', hasTouch: size !== 'd1280', deviceScaleFactor: 2, storageState: storage});
    const page = await ctx.newPage();
    page.on('request', r => { if(!r.url().startsWith(BASE) && !r.url().startsWith('data:')) outside.push(r.url()); });
    page.on('pageerror', e => errors.push(size + ': ' + e.message));
    page.on('console', m => { if(m.type() === 'error') errors.push(size + ' console: ' + m.text()); });
    return {ctx, page};
  }
  const shot = (page, n, full) => page.screenshot({path: path.join(SHOTS, n + '.png'), fullPage: !!full});
  const noH = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // ---- first visit at three sizes
  const main = await phone('p390');
  let page = main.page;
  await page.goto(URL); await page.waitForSelector('#w-name');
  await page.evaluate(() => document.fonts.ready); await sleep(300);
  ok(await page.evaluate(() => !!document.querySelector('#brand-name img.brand-wordmark') && /wordmark-terracotta/.test(document.querySelector('#brand-name img').src)), 'CCCC: wordmark image in the header');
  ok(await page.evaluate(() => document.querySelector('meta[name=theme-color]').content) === '#B5432B', 'CCCC: theme-color #B5432B');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('topbar')).backgroundColor) === 'rgb(181, 67, 43)', 'CCCC: terracotta header');
  ok(await page.evaluate(() => document.fonts.check('16px Brunson')), 'Brunson loaded (same site)');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.menu-section h2')).textTransform) === 'uppercase', 'section titles in capitals');
  ok(await page.evaluate(() => !/Brunson/.test(getComputedStyle(document.body).fontFamily)), 'body in the system font');
  ok(await noH(page), 'no sideways scroll at 390 (welcome)');
  await page.fill('#w-name', 'Mika');
  await shot(page, '390-01-first-visit', true); await shot(page, '390-01-first-visit-top');
  for(const sz of ['p360', 'd1280']){
    const o = await phone(sz); await o.page.goto(URL); await o.page.waitForSelector('#w-name'); await o.page.evaluate(() => document.fonts.ready); await sleep(300);
    ok(await noH(o.page), `no sideways scroll at ${sz} (welcome)`);
    await shot(o.page, sz.replace('p', '').replace('d', '') + '-01-first-visit'); await o.ctx.close();
  }
  // tap targets
  const small = await page.evaluate(() => [...document.querySelectorAll('button, input:not([type=checkbox]), a')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.height < 44 || r.width < 44); }).map(e => (e.id || e.className) + ' ' + Math.round(e.getBoundingClientRect().height)));
  ok(small.length === 0, 'every tap target on the first screen is 44 px or more', small.join(', '));

  // ---- register
  await page.check('#w-consent'); await page.click('#w-go');
  ok(await until(async () => await page.isVisible('#not-me'), 10000), 'registered Mika');
  custId = psql(`select id from customers where nickname = 'Mika'`);
  ok(await until(async () => await page.isVisible('#stamp-card'), 3000), 'stamp card shown (loyalty on)');
  const lbl = async () => page.getAttribute('.stamps[role=img]', 'aria-label');
  const line = async () => (await page.textContent('.stamp-line')).trim();
  ok(/^0 of 15 stamps/.test(await lbl()), '0 stamps: screen-reader text', await lbl());
  await sleep(300); await shot(page, '390-02-stamps-0');

  const states = [[4, '04'], [1, '05-ready'], [2, '07']];
  for(const [k, name] of states){
    addStamps(k); await page.reload(); await page.waitForSelector('#stamp-card'); await page.evaluate(() => document.fonts.ready); await sleep(250);
    ok(await page.$$eval('.stamp.got', a => a.length) === stampCount, `${stampCount} stamps drawn filled`);
    console.log('     line: ' + await line() + '  |  sr: ' + await lbl());
    await page.locator('#stamp-card').screenshot({path: path.join(SHOTS, '390-03-stamps-' + name + '.png')});
  }
  ok(/^7 of 15 · your ₱10-off reward is ready\. Ask at the counter\.$/.test(await line()), '7: "your ₱10-off reward is ready"', await line());
  ok((await lbl()) === '7 of 15 stamps. ₱10 off is ready. Ask at the counter.', '7: screen-reader text', await lbl());
  ok(await page.$$eval('.stamp.ms.ready', a => a.map(x => x.textContent)).then(t => t.join() === '₱10'), 'milestone 5 marked ready (₱10)');
  ok(await page.$$eval('.stamp.ms.locked', a => a.map(x => x.textContent).join()) === '₱50,FREE', 'milestones 10 / 15 locked (₱50, FREE)');
  await shot(page, '390-04-menu-welcome-back');
  const p360 = await phone('p360', await main.ctx.storageState());
  await p360.page.goto(URL); await p360.page.waitForSelector('#stamp-card'); await p360.page.evaluate(() => document.fonts.ready); await sleep(300);
  ok(await noH(p360.page), 'no sideways scroll at 360 (menu + stamp card)');
  await shot(p360.page, '360-04-menu-welcome-back');
  const d = await phone('d1280', await main.ctx.storageState());
  await d.page.goto(URL); await d.page.waitForSelector('#stamp-card'); await d.page.evaluate(() => document.fonts.ready); await sleep(300);
  await shot(d.page, '1280-04-menu-welcome-back');

  // redeem the ₱10 reward
  const saleId = psql(`select id from sales where customer_id = '${custId}' order by transaction_date desc limit 1`);
  psql(`insert into loyalty_redemptions(business_id, customer_id, card_no, milestone, reward_type, sale_id, amount) values (${BIZ}, '${custId}', 1, 5, 'AMOUNT_OFF', '${saleId}', 10)`);
  await page.reload(); await page.waitForSelector('#stamp-card'); await sleep(250);
  ok(await page.$$('.stamp.ms.redeemed').then(a => a.length === 1), 'after redemption: milestone 5 shows used');
  ok(/^7 of 15 · 3 more stamps to ₱50 off\.$/.test(await line()), 'after redemption: "3 more stamps to ₱50 off"', await line());
  await page.locator('#stamp-card').screenshot({path: path.join(SHOTS, '390-03-stamps-07-redeemed.png')});
  addStamps(8); await page.reload(); await page.waitForSelector('#stamp-card'); await sleep(250);
  console.log('     15 line: ' + await line() + '  |  sr: ' + await lbl());
  ok(/^15 of 15 · 2 rewards are ready/.test(await line()), '15: two rewards ready (₱50 and free)', await line());
  await page.locator('#stamp-card').screenshot({path: path.join(SHOTS, '390-03-stamps-15.png')});
  addStamps(1); await page.reload(); await page.waitForSelector('#stamp-card'); await sleep(250);
  console.log('     16 line: ' + await line() + '  |  head: ' + await page.textContent('.stampcard-head'));
  // 1.5 (owner decision B16, 2026-11-10): the next card opens only after the last reward (the free drink) is used. With 16 stamps
  // and the free drink unused the card stays card 1 at 15 of 15, the 16th stamp is saved for card 2, both rewards stay ready.
  // (Before 1.5: "1 of 15" on "Card 2". Expected value changed 2026-11-12 with C's approval.)
  const saved16 = await page.textContent('.stamp-saved').catch(() => '');
  ok(/^15 of 15 · 2 rewards are ready/.test(await line()) && !/Card 2/.test(await page.textContent('.stampcard-head'))
    && /1 stamp saved for your next card\. Use your free drink or food to start card 2\./.test(saved16 || ''), '16: still card 1 at 15 of 15, 1 stamp saved for card 2, both rewards still ready (1.5, B16)', (await line()) + ' | ' + saved16);
  await page.locator('#stamp-card').screenshot({path: path.join(SHOTS, '390-03-stamps-16-card2.png')});

  // ---- item options, cart, order status
  for(const [o, pre] of [[main, '390'], [p360, '360'], [d, '1280']]){
    const pg = o.page;
    await pg.goto(URL + '&view=menu'); await pg.waitForSelector('#stamp-card');
    await pg.click('.item[data-item="33333333-0000-0000-0000-000000000001"]'); await pg.waitForSelector('#it-add');
    await pg.click('.opt[data-g="g-size"][data-o="o-16"]'); await sleep(300);
    await shot(pg, pre + '-05-item-options');
    await pg.click('#it-add'); await pg.waitForSelector('#view-cart'); await sleep(300);
    await shot(pg, pre + '-06-menu-with-cart');
    await pg.click('#view-cart'); await pg.waitForSelector('#c-place'); await sleep(300);
    ok(await noH(pg), `${pre}: no sideways scroll (cart)`);
    await shot(pg, pre + '-07-cart');
    await pg.click('#c-place'); await pg.waitForSelector('.ticket-no', {timeout: 10000}); await sleep(400);
    await shot(pg, pre + '-08-order-status', true);
  }
  psql(`update qr_orders set status = 'READY', ready_at = now(), accepted_at = now() where order_number = 'Q-001'`);
  ok(await until(async () => /Ready/.test(await page.textContent('.step.now') || ''), 12000), 'ticket shows Ready by itself');
  await sleep(300); await shot(page, '390-09-order-ready', true);

  // ---- loyalty off -> no card
  psql(`update settings set loyalty_enabled = false`);
  await page.goto(BASE + '/cccc/order/?t=tabletoken5&view=menu'); await page.waitForSelector('#not-me');
  ok(!(await page.$('#stamp-card')), 'loyalty off: no stamp card');
  psql(`update settings set loyalty_enabled = true`);

  // ---- theme CUSTOM
  psql(`update settings set theme = 'CUSTOM', primary_color = '#1f2e22', secondary_color = '#33513f', accent_color = '#e9d8a6', background_color = '#f1f4ee', card_color = '#ffffff', text_color = '#20281f', business_name = 'Kape <b>Test</b> & Co'`);
  await page.goto(BASE + '/cccc/order/?t=tabletoken5&view=menu'); await page.waitForSelector('#stamp-card'); await sleep(300);
  ok(await page.evaluate(() => !document.querySelector('#brand-name img') && document.querySelector('#brand-name .brand-name-text').textContent === 'Kape <b>Test</b> & Co'), 'CUSTOM: business name as text, escaped, no wordmark');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('topbar')).backgroundColor) === 'rgb(51, 81, 63)', 'CUSTOM: header uses the saved colour');
  ok(await page.evaluate(() => document.querySelector('meta[name=theme-color]').content) === '#33513f', 'CUSTOM: theme-color from settings');
  ok(await page.evaluate(() => !document.querySelector('#brand-logo img')), 'CUSTOM without a logo: no CCCC tile');
  await shot(page, '390-10-theme-custom');
  psql(`update settings set theme = 'CCCC'`);
  await page.reload(); await page.waitForSelector('#stamp-card'); await sleep(300);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('topbar')).backgroundColor === 'rgb(181, 67, 43)' && !!document.querySelector('#brand-name img')), 'CCCC again: saved colours ignored, wordmark back');
  psql(`update settings set primary_color = '#241209', secondary_color = '#33513f', accent_color = '#c17a3d', background_color = '#f7f1e6', card_color = '#fffdf9', text_color = '#2c1e14', business_name = 'Cavite City Coffee Club'`);

  ok(outside.length === 0, 'no request leaves the site (no outside fonts)', outside.join(' '));
  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
