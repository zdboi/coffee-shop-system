// QR page release 1.3 (adopted from customer-qr-dev's check.js, 2026-11-02): closed screen with no open shift
// ("Sarado pa po kami!", stamps still shown, cart kept, re-check), ticket colours, pickup banner, sub-category order + colours.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/order_release13.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const path = require('path');
const DIR = path.join(H.SHOTS, 'qr13'); require('fs').mkdirSync(DIR, {recursive: true});
const URL = H.BASE + '/cccc/order/?t=tabletoken5';
const sql = H.sql, ok = H.ok, sleep = H.sleep, until = H.until;
const BIZ = "(select id from businesses limit 1)";
const openShift = () => sql(`insert into shifts(business_id, status, opened_at, cashier_name) values (${BIZ}, 'ACTIVE', now(), 'Test')`);
const closeShifts = () => sql(`update shifts set status='CLOSED', closed_at=now() where status='ACTIVE'`);
(async () => {
  sql(`update settings set loyalty_enabled = true, theme = 'CCCC'`);
  sql(`delete from qr_orders`); closeShifts();
  const browser = await chromium.launch();
  const errors = [];
  async function phone(size, storage, reduced){
    const vp = size === 360 ? {width: 360, height: 740} : {width: 390, height: 844};
    const ctx = await browser.newContext({viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2, storageState: storage, reducedMotion: reduced ? 'reduce' : 'no-preference'});
    const page = await ctx.newPage(); H.attach(page, errors, 'QR' + size);
    return {ctx, page};
  }
  const shot = async (page, n, full) => { await sleep(700); await page.screenshot({path: path.join(DIR, n + '.png'), fullPage: !!full}); };
  const noH = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  try{
    // ---------- 1. closed, not signed in
    let {ctx, page} = await phone(390);
    await page.goto(URL);
    await page.waitForSelector('#closed', {timeout: 15000});
    ok(/Sarado pa po kami/i.test(await page.textContent('#closed-title')), 'closed: Sarado pa po kami! title');
    ok(await page.evaluate(() => getComputedStyle(document.getElementById('closed-title')).fontFamily.includes('Brunson')), 'closed: title in Brunson');
    ok(await page.$$eval('.item, .cats, #view-cart', e => e.length) === 0, 'closed: no menu, no cart');
    ok(await page.isVisible('.closed-mark') && await page.isVisible('.closed-wordmark'), 'closed: logo tile + wordmark');
    ok(await page.isVisible('#w-name') && /Join the stamp card/.test(await page.textContent('#w-go')), 'closed: can still join (name form, "Join the stamp card")');
    ok(await page.isVisible('#w-relink'), 'closed: "I\'ve ordered here before" offered');
    ok(await noH(page), 'closed 390: no sideways scroll');
    const small = await page.evaluate(() => [...document.querySelectorAll('button, input:not([type=checkbox]), a')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.height < 44 || r.width < 44); }).map(e => e.id || e.className));
    ok(small.length === 0, 'closed: tap targets 44 px', small.join(','));
    await shot(page, '01-closed-new-390', true);
    await page.fill('#w-name', 'Zed'); await page.check('#w-consent'); await page.click('#w-go');
    await page.waitForSelector('#not-me');
    ok(await page.isVisible('#closed') && await page.isVisible('#stamp-card'), 'closed: after joining, closed sign + stamp card');
    ok(await page.$$eval('.item', e => e.length) === 0, 'closed: still no menu after joining');
    ok(/Get your first stamp on your next visit/.test(await page.textContent('.stamp-line')) && !/today/.test(await page.textContent('#stamp-card')), 'closed: stamp line says "on your next visit", no "today"', await page.textContent('.stamp-line'));
    await shot(page, '02-closed-signed-in-390', true);
    const storage = await ctx.storageState();
    await ctx.close();
    ({ctx, page} = await phone(360, storage));
    await page.goto(URL); await page.waitForSelector('#closed');
    ok(await page.isVisible('#stamp-card'), 'closed 360 returning: stamp card'); ok(await noH(page), 'closed 360: no sideways scroll');
    await shot(page, '03-closed-signed-in-360', true);
    await ctx.close();
    ({ctx, page} = await phone(360));
    await page.goto(URL); await page.waitForSelector('#closed');
    ok(await noH(page), 'closed 360 new: no sideways scroll');
    await shot(page, '04-closed-new-360', false);
    await ctx.close();

    // ---------- 2. sub-category colours + order (custom order; raw values ignored)
    sql(`insert into recipes(id, business_id, name, recipe_type, category, selling_price, modifier_groups, description) values
      ('33333333-0000-0000-0000-0000000000a1', ${BIZ}, 'Spanish Latte', 'DRINKS', 'Iced', 160, '[]', 'Sweet and creamy.'),
      ('33333333-0000-0000-0000-0000000000a2', ${BIZ}, 'Matcha', 'DRINKS', 'Non-coffee', 170, '[]', null),
      ('33333333-0000-0000-0000-0000000000a3', ${BIZ}, 'Clubhouse', 'FOOD', 'Sandwiches', 210, '[]', 'Triple decker.')
      on conflict (id) do nothing`);
    sql(`update settings set subcategory_colors = '{"Iced":"olive","hot":"butter","Pastry":"sage","Sandwiches":"terracotta"}'::jsonb,
         subcategory_order = '["Non-coffee","Hot","Iced","Sandwiches","Pastry"]'::jsonb`);
    openShift();
    ({ctx, page} = await phone(390, storage));
    await page.goto(URL); await page.waitForSelector('.menu-section');
    ok(/with today's order/.test(await page.textContent('.stamp-line')), 'open: stamp line keeps "with today\'s order"');
    const order = await page.$$eval('.menu-section h2', e => e.map(x => x.textContent.trim()));
    ok(JSON.stringify(order) === JSON.stringify(['Non-coffee','Hot','Iced','Pastry','Sandwiches']), 'menu: custom order, drinks first, then pastry, then food', order);
    const chips = await page.$$eval('.cat', e => e.map(x => x.textContent.trim()));
    ok(JSON.stringify(chips) === JSON.stringify(order), 'chips in the same order', chips);
    const bg = (id) => page.$eval(`.item[data-item="${id}"]`, e => getComputedStyle(e).backgroundColor + '|' + getComputedStyle(e).color);
    ok(await bg('33333333-0000-0000-0000-000000000001') === 'rgb(110, 98, 51)|rgb(251, 246, 234)', 'Iced items on olive tile, paper text', await bg('33333333-0000-0000-0000-000000000001'));
    ok((await bg('33333333-0000-0000-0000-000000000003')).startsWith('rgb(241, 228, 179)'), 'Hot (case-insensitive match) on butter', await bg('33333333-0000-0000-0000-000000000003'));
    ok(await page.$eval('.item[data-item="33333333-0000-0000-0000-000000000003"]', e => getComputedStyle(e).borderTopColor !== 'rgba(0, 0, 0, 0)' && e.classList.contains('tile-light')), 'light tile has the border');
    ok(await page.$eval('.item[data-item="33333333-0000-0000-0000-0000000000a2"]', e => !e.classList.contains('tiled')), 'no colour set: plain card');
    await shot(page, '05-menu-colours-390', true);
    await page.click('#not-me').catch(()=>{}); await page.keyboard.press('Escape');
    // raw values must be ignored. The DB check refuses them, so feed them through a fake answer.
    await page.route('**/rest/v1/rpc/get_qr_menu', async route => {
      const resp = await route.fetch(); const j = await resp.json();
      j.subcategory_colors = {Iced: '#ff0000', Hot: 'red;background:url(x)', Pastry: 'var(--cc-danger)', Sandwiches: 'toString', 'Non-coffee': 'constructor'};
      await route.fulfill({response: resp, json: j});
    });
    await page.reload(); await page.waitForSelector('.menu-section');
    const tiled = await page.$$eval('.tiled, [style*="--t-bg"]', e => e.length);
    ok(tiled === 0, 'raw colour values / odd keys ignored (no tiles, no style)', tiled);
    const html = await page.$eval('#main', e => e.innerHTML);
    ok(!/ff0000|url\(x\)|cc-danger/.test(html), 'raw values never reach the page');
    await page.unroute('**/rest/v1/rpc/get_qr_menu');
    await ctx.close();
    ({ctx, page} = await phone(360, storage));
    await page.goto(URL); await page.waitForSelector('.menu-section');
    ok(await noH(page), 'menu 360: no sideways scroll');
    await page.evaluate(() => window.scrollTo(0, 420));
    await shot(page, '06-menu-colours-360', false);

    // ---------- 3. SHOP_CLOSED mid-order: cart kept
    await page.click('.item[data-item="33333333-0000-0000-0000-000000000003"]'); await page.click('#it-add');
    await page.waitForSelector('#view-cart'); await page.click('#view-cart'); await page.waitForSelector('#c-place');
    closeShifts();
    await page.click('#c-place');
    await page.waitForSelector('#closed', {timeout: 10000});
    ok(!(await page.isVisible('.sheet')), 'SHOP_CLOSED: cart sheet closed, closed screen shown');
    ok(/saved on this phone/.test(await page.textContent('#toast')), 'SHOP_CLOSED: toast says the order is saved', await page.textContent('#toast'));
    ok(/1 item/.test(await page.textContent('.closed-cart')), 'SHOP_CLOSED: closed screen mentions the saved cart');
    ok(Number(sql(`select count(*) from qr_orders`)) === 0, 'SHOP_CLOSED: no order created');
    await shot(page, '07-shop-closed-mid-order-360', false);
    // reopen: comes back by itself on focus
    openShift();
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', {value: false, configurable: true}); window.dispatchEvent(new Event('focus')); });
    let back = await until(async () => await page.isVisible('#view-cart'), 6000);
    if(!back){ await sleep(15500); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); back = await until(async () => await page.isVisible('#view-cart'), 6000); }
    ok(back && /1 item/.test(await page.textContent('#view-cart')), 'reopened: menu and saved cart back without reload');
    // closing while browsing (periodic / focus check)
    closeShifts(); await sleep(15500);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    ok(await until(async () => await page.isVisible('#closed'), 6000), 'closed while browsing: the page switches to the closed screen on focus');
    openShift(); await sleep(15500); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => await page.isVisible('#view-cart'), 6000);
    await ctx.close();

    // ---------- 4. ticket colours per stage + ready banner
    ({ctx, page} = await phone(390, storage));
    await page.goto(URL); await page.waitForSelector('.menu-section');
    await page.click('.item[data-item="33333333-0000-0000-0000-000000000003"]'); await page.click('#it-add');
    await page.click('#view-cart'); await page.click('#c-place'); await page.waitForSelector('.ticket-no');
    const no = (await page.textContent('.ticket-no')).trim();
    const tbg = () => page.$eval('#t-ticket', e => getComputedStyle(e).backgroundColor);
    ok(await until(async () => await tbg() === 'rgb(241, 228, 179)', 3000), 'PENDING: butter ticket', await tbg());
    ok(/Pick it up at the counter/.test(await page.textContent('.ticket')) && !/bring it to your table/.test(await page.textContent('.ticket')), 'dine-in: "Pick it up at the counter"');
    await shot(page, '08-ticket-pending-390', true);
    sql(`update qr_orders set status='PREPARING', accepted_at=now() where order_number='${no}'`);
    ok(await until(async () => await tbg() === 'rgb(110, 98, 51)', 9000), 'PREPARING: olive ticket', await tbg());
    ok(await page.$eval('.ticket-no', e => getComputedStyle(e).color) === 'rgb(241, 228, 179)', 'PREPARING: number in butter on olive');
    await shot(page, '09-ticket-preparing-390', true);
    sql(`update qr_orders set status='READY', ready_at=now() where order_number='${no}'`);
    ok(await until(async () => await tbg() === 'rgb(185, 196, 160)', 9000), 'READY: sage ticket', await tbg());
    ok(await page.isVisible('#ready-banner') && (await page.textContent('#ready-banner')).includes('Ready for pickup at the counter — Order ' + no), 'READY: banner with order number', await page.textContent('#ready-banner'));
    ok((await page.title()).startsWith('Ready: ' + no), 'READY: tab title');
    await shot(page, '10-ticket-ready-banner-390', false);
    await page.click('#ready-x');
    ok(!(await page.isVisible('#ready-banner')), 'banner dismissed');
    await page.click('#order-more'); await page.waitForSelector('.menu-section');
    ok(!(await page.isVisible('#ready-banner')), 'banner stays hidden on the menu after closing it');
    await page.reload(); await page.waitForSelector('.ticket-no');
    ok(await page.isVisible('#ready-banner'), 'banner back after reload while READY');
    await page.click('#order-more'); await page.waitForSelector('.menu-section');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(300);
    const bannerBox = await page.$eval('#ready-banner', e => e.getBoundingClientRect().top);
    const catsTop = await page.$eval('.cats', e => e.getBoundingClientRect().top);
    const bH = await page.$eval('#top-wrap', e => e.getBoundingClientRect().bottom);
    ok(bannerBox >= 0 && Math.abs(catsTop - bH) < 2, 'menu: banner sticky, chips sit just under it', [bannerBox, catsTop, bH]);
    await shot(page, '11-menu-ready-banner-390', false);
    await ctx.close();
    ({ctx, page} = await phone(360, storage, true));
    await page.goto(URL); await page.waitForSelector('.ticket-no');
    ok(await page.$eval('#t-ticket', e => getComputedStyle(e).transitionDuration) === '0s', 'reduced motion: no colour fade');
    ok(await noH(page), 'ticket 360: no sideways scroll');
    await shot(page, '12-ticket-ready-360', false);
    sql(`update qr_orders set status='COMPLETED', paid_at=now(), completed_at=now() where order_number='${no}'`);
    ok(await until(async () => await tbg() === 'rgb(255, 255, 255)' || !(await page.isVisible('#ready-banner')), 9000), 'COMPLETED: banner gone');
    const plain = await tbg();
    ok(!['rgb(241, 228, 179)','rgb(110, 98, 51)','rgb(185, 196, 160)'].includes(plain), 'COMPLETED: neutral ticket', plain);
    await shot(page, '13-ticket-done-360', false);
    await ctx.close();
    // preparing at 360
    ({ctx, page} = await phone(360, storage));
    await page.goto(URL); await page.waitForSelector('.menu-section');
    await page.click('.item[data-item="33333333-0000-0000-0000-000000000004"]'); await page.click('#it-add');
    await page.click('#view-cart'); await page.click('#c-place'); await page.waitForSelector('.ticket-no');
    const no2 = (await page.textContent('.ticket-no')).trim();
    await shot(page, '14-ticket-pending-360', false);
    sql(`update qr_orders set status='PREPARING' where order_number='${no2}'`);
    await until(async () => await tbg() === 'rgb(110, 98, 51)', 9000);
    await shot(page, '15-ticket-preparing-360', false);
    sql(`update qr_orders set status='READY' where order_number='${no2}'`);
    await until(async () => await page.isVisible('#ready-banner'), 9000);
    await shot(page, '16-ticket-ready-banner-360', false);
    // closed while an order is READY: ticket and banner stay
    closeShifts(); await page.click('#order-more'); await sleep(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(16000); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    ok(await until(async () => await page.isVisible('#closed'), 6000), 'closed with READY order: closed screen');
    ok(await page.isVisible('#ready-banner') && await page.isVisible('.my-order'), 'closed with READY order: banner + order button still there');
    await shot(page, '17-closed-with-ready-360', true);
    await ctx.close();
  }catch(e){ H.abort('qr13', e); }
  ok(errors.length === 0, 'no page errors', errors);
  await browser.close();
  process.exit(H.summary('qr13'));
})();
