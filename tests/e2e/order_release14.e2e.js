// QR page release 1.4 checks (adopted from customer-qr-dev's lib14.js, 2026-11-03).
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]   (this test applies tests/sql/23_seed_release14_qr.sql)
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/order_release14.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const path = require('path');
const DIR = path.join(H.SHOTS, 'qr14'); require('fs').mkdirSync(DIR, {recursive: true});
const URL = H.BASE + '/cccc/order/?t=tabletoken5';
const {sql, ok, sleep, until} = H;
const LATTE = '33333333-0000-0000-0000-000000000001', AMER = '33333333-0000-0000-0000-000000000003', MATCHA = '33333333-0000-0000-0000-0000000000a2';
const G = (n) => 'lib_44444444-0000-0000-0000-00000000000' + n;
require('child_process').execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', H.DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(__dirname, '..', 'sql', '23_seed_release14_qr.sql')], {stdio: 'ignore'});
(async () => {
  sql(`update settings set loyalty_enabled = true, theme = 'CCCC'`);
  sql(`delete from qr_orders`);
  H.openShopForQr();
  const browser = await chromium.launch();
  const errors = [], restHits = [];
  async function phone(w, h, storage){
    const ctx = await browser.newContext({viewport: {width: w, height: h}, isMobile: w < 700, hasTouch: true, deviceScaleFactor: 2, storageState: storage});
    const page = await ctx.newPage(); H.attach(page, errors, 'QR' + w);
    page.on('request', r => { if(/\/rest\/v1\/(?!rpc\/)/.test(r.url())) restHits.push(r.url()); });
    return {ctx, page};
  }
  const shot = async (page, n, full) => { await sleep(500); await page.screenshot({path: path.join(DIR, n + '.png'), fullPage: !!full}); };
  const noH = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const smallTargets = (page, root) => page.evaluate((r) => [...document.querySelectorAll((r || '') + ' button, ' + (r || '') + ' input:not([type=checkbox])')].filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.height < 44 || b.width < 44); }).map(e => (e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().height)), root);
  try{
    let {ctx, page} = await phone(390, 844);
    await page.goto(URL);
    await page.waitForSelector('#w-name');
    await page.fill('#w-name', 'Lia'); await page.check('#w-consent'); await page.click('#w-go');
    await page.waitForSelector('#not-me');
    // menu groups as sent
    const menu = await page.evaluate(async () => null);
    // ---- Iced Latte: library + own groups
    await page.click(`.item[data-item="${LATTE}"]`); await page.waitForSelector('#it-add');
    const names = await page.$$eval('.group', gs => gs.map(g => g.querySelector('h4').textContent));
    ok(JSON.stringify(names) === JSON.stringify(['Hot or iced','Milk','Take-away cup','Sweetness','Add a flavour','Size','Add-ons']), 'latte: library groups (library order) then own groups', names);
    ok(await page.$eval(`.group[data-group="${G(1)}"] .opts`, e => e.classList.contains('opts-2')), 'Hot or iced: two per row');
    const swapTxt = await page.textContent(`.opt[data-g="${G(2)}"][data-o="oat"]`);
    ok(/Non-dairy milk \(oat\)/.test(swapTxt) && /In place of the usual/.test(swapTxt) && /\+₱30\.00/.test(swapTxt), 'swap option shows label, "in place of the usual", +₱30.00', swapTxt);
    ok(/Required · choose 1/.test(await page.textContent(`.group[data-group="${G(1)}"] small`)), 'Hot or iced says Required · choose 1');
    ok(/Optional · choose any/.test(await page.textContent(`.group[data-group="${G(5)}"] small`)), 'flavours say Optional · choose any');
    await shot(page, '390-01-sheet-top');
    ok(await page.isVisible('#it-add') && await page.evaluate(() => { const b = document.getElementById('it-add').getBoundingClientRect(); return b.bottom <= innerHeight && b.top > innerHeight - 120; }), 'add button pinned to the bottom of the screen');
    // Add without required
    await page.click('#it-add');
    ok(await until(async () => /Choose Hot or iced and Size first/.test(await page.textContent('#it-msg')), 2000), 'message: Choose Hot or iced and Size first.', await page.textContent('#it-msg'));
    ok(await until(() => page.evaluate((g) => document.activeElement && document.activeElement.dataset.group === g, G(1)), 2000), 'focus moved to the Hot or iced group');
    ok(await page.$eval(`.group[data-group="${G(1)}"]`, e => e.classList.contains('need')) && await page.$eval(`.group[data-group="g-size"]`, e => e.classList.contains('need')), 'both empty required groups marked');
    ok(/Please choose 1/.test(await page.textContent('.group[data-group="g-size"] small')), 'size hint says Please choose 1');
    ok(!(await page.isVisible('#view-cart')), 'nothing added');
    await shot(page, '390-02-sheet-required-missing');
    // single choice: Hot then Iced -> only Iced
    await page.click(`.opt[data-g="${G(1)}"][data-o="hot"]`);
    ok(/Choose Size first/.test(await page.textContent('#it-msg')), 'message updates to the remaining group');
    await page.click(`.opt[data-g="${G(1)}"][data-o="iced"]`);
    ok(await page.$$eval(`.opt[data-g="${G(1)}"][aria-pressed="true"]`, e => e.map(x => x.dataset.o).join()) === 'iced', 'pick-one: only Iced chosen');
    await page.click(`.opt[data-g="${G(1)}"][data-o="iced"]`);
    ok(await page.$$eval(`.opt[data-g="${G(1)}"][aria-pressed="true"]`, e => e.length) === 1, 'required pick-one: tapping again keeps it');
    // optional single: tap twice clears
    await page.click(`.opt[data-g="${G(4)}"][data-o="s50"]`); await page.click(`.opt[data-g="${G(4)}"][data-o="s0"]`);
    ok(await page.$$eval(`.opt[data-g="${G(4)}"][aria-pressed="true"]`, e => e.map(x => x.dataset.o).join()) === 's0', 'optional pick-one: one at a time');
    await page.click(`.opt[data-g="${G(4)}"][data-o="s0"]`);
    ok(await page.$$eval(`.opt[data-g="${G(4)}"][aria-pressed="true"]`, e => e.length) === 0, 'optional pick-one: tap again clears');
    await page.click(`.opt[data-g="${G(4)}"][data-o="s50"]`);
    // multi
    await page.click(`.opt[data-g="${G(5)}"][data-o="car"]`); await page.click(`.opt[data-g="${G(5)}"][data-o="van"]`);
    ok(await page.$$eval(`.opt[data-g="${G(5)}"][aria-pressed="true"]`, e => e.length) === 2, 'multi: two flavours chosen');
    await page.click(`.opt[data-g="${G(2)}"][data-o="oat"]`);
    await page.click('.opt[data-g="g-size"][data-o="o-16"]');
    ok(await page.textContent('#it-msg') === '', 'message gone once all required chosen');
    ok(/Chosen/.test(await page.textContent(`.group[data-group="${G(1)}"] small`)), 'required group shows Chosen');
    // 150 + 10 iced + 30 oat + 0 + 20 car + 20 van + 20 16oz = 250
    const addTxt = await page.textContent('#it-add');
    ok(addTxt.includes('₱250.00'), 'display price 150+10+30+20+20+20 = ₱250.00', addTxt);
    ok((await smallTargets(page, '.sheet')).length === 0, 'sheet tap targets ≥ 44 px', (await smallTargets(page, '.sheet')).join(','));
    ok(await noH(page), '390: no sideways scroll');
    await page.evaluate(() => document.querySelector('.sheet-body').scrollTo(0, 1e5));
    await shot(page, '390-03-sheet-bottom');
    await page.click('#it-add'); await page.waitForSelector('#view-cart');
    // Americano: Hot only
    await page.click(`.item[data-item="${AMER}"]`); await page.waitForSelector('#it-add');
    await page.click(`.opt[data-g="${G(1)}"][data-o="hot"]`); await page.click('#it-add');
    await page.waitForSelector('#view-cart');
    await page.click('#view-cart'); await page.waitForSelector('#c-place');
    const cartTxt = await page.textContent('.sheet-body');
    ok(/Iced, Non-dairy milk \(oat\), Half sweet, Caramel drizzle, Vanilla, 16oz/.test(cartTxt), 'cart lists choices in menu order', cartTxt.replace(/\s+/g, ' ').slice(0, 300));
    await shot(page, '390-04-cart');
    await page.click('#c-place');
    await page.waitForSelector('.ticket-no', {timeout: 8000});
    const o = JSON.parse(sql(`select row_to_json(t) from (select subtotal, items from qr_orders order by created_at desc limit 1) t`));
    ok(Number(o.subtotal) === 250 + 110, 'server subtotal 250 + 110 = 360', o.subtotal);
    const latte = o.items.find(i => i.recipe_id === LATTE);
    const oat = latte && latte.modifiers.find(m => m.label === 'Non-dairy milk (oat)');
    ok(oat && oat.kind === 'SWAP' && Array.isArray(oat.removes) && oat.removes.length === 1, 'stored order keeps the swap with removes (for the counter)', oat);
    const ticket = await page.textContent('.ticket-items');
    ok(/Iced, Non-dairy milk \(oat\), Half sweet, Caramel drizzle, Vanilla, 16oz/.test(ticket) && /Hot/.test(ticket), 'ticket shows option labels', ticket);
    const reply = await page.evaluate(async () => null);
    await shot(page, '390-05-ticket', true);
    // replies: only group/label/price_delta/kind
    const r = await page.evaluaterequire('child_process').execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', H.DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(__dirname, '..', 'sql', '23_seed_release14_qr.sql')], {stdio: 'ignore'});
(async () => {
      const k = Object.keys(localStorage).find(x => x.startsWith('cccc.customer.session'));
      return null;
    });
    // ---- menu changed: Sweetness becomes required while a cart is saved
    await page.click('#order-more');
    await page.click(`.item[data-item="${AMER}"]`); await page.waitForSelector('#it-add');
    await page.click(`.opt[data-g="${G(1)}"][data-o="hot"]`); await page.click('#it-add'); await page.waitForSelector('#view-cart');
    await page.click('#view-cart'); await page.waitForSelector('#c-place');
    sql(`update option_groups set required = true where id = '44444444-0000-0000-0000-000000000004'`);
    await page.click('#c-place');
    ok(await until(async () => await page.isVisible('[data-fix]'), 6000), 'server OPTION_REQUIRED -> cart reopened with "Choose again"');
    ok(/Some choices changed/.test(await page.textContent('#c-err')), 'cart says some choices changed', await page.textContent('#c-err'));
    await shot(page, '390-06-cart-choose-again');
    await page.click('#c-place');
    ok(/Choose again" on Americano first/.test(await page.textContent('#c-err')), 'place blocked until fixed');
    await page.click('[data-fix]'); await page.waitForSelector('#it-add');
    ok(/^Update/.test(await page.textContent('#it-add')), 'sheet in update mode');
    ok(await page.$$eval(`.opt[data-g="${G(1)}"][aria-pressed="true"]`, e => e.map(x => x.dataset.o).join()) === 'hot', 'keeps the earlier choice (Hot)');
    await page.click(`.opt[data-g="${G(4)}"][data-o="s100"]`); await page.click('#it-add');
    await page.waitForSelector('#c-place');
    ok(!(await page.isVisible('[data-fix]')), 'line fixed');
    ok(await page.$$eval('.cart-line', e => e.length) === 1, 'still one line');
    await page.click('#c-place');
    ok(await until(() => page.isVisible('.ticket-no'), 8000), 'order placed after choosing again');
    sql(`update option_groups set required = false where id = '44444444-0000-0000-0000-000000000004'`);
    // ---- saved cart after reload with a removed option
    await page.click('#order-more');
    await page.click(`.item[data-item="${MATCHA}"]`); await page.waitForSelector('#it-add');
    await page.click(`.opt[data-g="${G(1)}"][data-o="iced"]`); await page.click(`.opt[data-g="${G(4)}"][data-o="s0"]`); await page.click(`.opt[data-g="${G(5)}"][data-o="haz"]`); await page.click("#it-add"); await page.waitForSelector("#view-cart");
    sql(`update option_groups set options = options - 2 where id = '44444444-0000-0000-0000-000000000005'`);  // drop Hazelnut
    await page.goto(URL + '&view=menu'); await page.waitForSelector('#view-cart'); await page.click('#view-cart');
    ok(await until(() => page.isVisible('[data-fix]'), 3000), 'saved cart with a removed option: "Choose again" before sending');
    const storage = await ctx.storageState();
    await ctx.close();
    // ---- 768 tablet + 360
    for(const [w, h] of [[768, 1024], [360, 740]]){
      ({ctx, page} = await phone(w, h, storage));
      await page.goto(URL + '&view=menu'); await page.waitForSelector('#not-me');
      await shot(page, `${w}-01-menu`);
      ok(await noH(page), `${w}: no sideways scroll on the menu`);
      await page.click(`.item[data-item="${LATTE}"]`); await page.waitForSelector('#it-add');
      await page.click('#it-add');
      await shot(page, `${w}-02-sheet-required-missing`);
      ok(await noH(page), `${w}: no sideways scroll in the sheet`);
      ok(await page.evaluate(() => { const b = document.getElementById('it-add').getBoundingClientRect(); return b.bottom <= innerHeight; }), `${w}: add button visible`);
      await page.keyboard.press('Escape');
      await page.click('#view-cart'); await page.waitForSelector('#c-place');
      await shot(page, `${w}-03-cart`);
      await ctx.close();
    }
    ok(restHits.length === 0, 'page read no table directly (only rpc)', restHits);
    ok(errors.length === 0, 'no browser errors', errors);
  }catch(e){ H.abort('lib14', e); }
  await browser.close();
  process.exit(H.summary('lib14'));
})();
