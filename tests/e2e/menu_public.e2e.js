// Public menu page (release 1.4.1, cccc/menu/), adopted from customer-qr-dev's menu_check.js 2026-11-09.
// Applies its own seed (tests/sql/24_seed_menu.sql) on top of the browser seed.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/menu_public.e2e.js
const path = require('path');
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { execSync } = require('child_process');
const PORT = process.env.FAKE_PORT || 8787, DB = process.env.FAKE_DB || 'cccc';
if(!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('FAKE_DB must be a plain lowercase database name');
const BASE = 'http://localhost:' + PORT + '/cccc/menu/';
const OUT = path.join(process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'cccc-qa-shots'), 'menu141') + '/';
const SQL = (q) => execSync(`psql -h /tmp -p 54329 -U postgres -d ${DB} -Atqc "${q}"`).toString();
require('fs').mkdirSync(OUT, {recursive: true});
execSync(`psql -h /tmp -p 54329 -U postgres -d ${DB} -q -v ON_ERROR_STOP=1 -f ${path.join(__dirname, '..', 'sql', '24_seed_menu.sql')}`, {stdio: 'ignore'});
// Menu photos: the seed names http://localhost:8893/...; point them at files this stand-in really serves
// (the shop's tile icon), and "missing.jpg" at a path that does not exist (404), so both cases are real.
const ORIGIN = 'http://localhost:' + PORT;
SQL(`update recipes set image_url = case when image_url like '%/missing.jpg' then '${ORIGIN}/tests/fixtures/no-such-photo.jpg' else '${ORIGIN}/cccc/shared/brand/tile-icon-192.png' end where image_url like 'http://localhost:8893/%'`);
let fails = 0, checks = 0;
const ok = (c, m) => { checks++; console.log((c ? 'ok   ' : 'FAIL ') + m); if(!c) fails++; };

(async () => {
  const browser = await chromium.launch();
  async function open(url, w, h, opts = {}){
    const ctx = await browser.newContext({viewport: {width: w, height: h || 844}, deviceScaleFactor: 2, isMobile: w < 700, hasTouch: w < 700, reducedMotion: opts.reduce ? 'reduce' : 'no-preference'});
    const page = await ctx.newPage();
    const log = {dialogs: 0, auth: [], rpc: [], errors: []};
    page.on('dialog', d => { log.dialogs++; d.dismiss(); });
    page.on('pageerror', e => log.errors.push(String(e)));
    page.on('request', r => { const u = r.url(); if(u.includes('/auth/v1')) log.auth.push(u); if(u.includes('/rpc/')) log.rpc.push({u, auth: r.headers()['authorization'], apikey: r.headers()['apikey']}); });
    await page.goto(url, {waitUntil: 'networkidle'});
    await page.waitForTimeout(300);
    return {ctx, page, log};
  }

  // ---- main render at 390 ----
  let {ctx, page, log} = await open(BASE, 390);
  const secs = await page.$$eval('.sec-h span:last-child', a => a.map(x => x.textContent));
  ok(JSON.stringify(secs) === JSON.stringify(['Hot','Iced','Non-coffee','Pastry','Rice meals']), 'section order ' + secs);
  const chips = await page.$$eval('#chips .chip', a => a.map(x => x.textContent));
  ok(JSON.stringify(chips) === JSON.stringify(secs), 'chips match sections');
  const names = await page.$$eval('.iname', a => a.map(x => x.textContent));
  ok(names.join('|') === 'Café latte|Americano|Iced Latte|Iced Spanish latte|Iced caramel macchiato|Matcha latte|Ensaymada|Ube cheese pandesal|<img src=x onerror=alert(1)> "Pwn" & co|Tapsilog', 'items in order: ' + names.join('|'));
  ok(!names.includes('Hidden item'), 'hidden item not shown');
  const hl = await page.$eval('.hl', e => ({href: e.getAttribute('href'), text: e.innerText}));
  ok(hl.href === '#item-6' && /Today's pick/i.test(hl.text) && /Ensaymada/i.test(hl.text) && hl.text.includes('₱65') && hl.text.includes('Fresh from the oven'), 'highlight card: ' + JSON.stringify(hl));
  const latte = await page.$$eval('#item-0 .iopts', a => a.map(x => x.textContent));
  ok(JSON.stringify(latte) === JSON.stringify(['12oz · 16oz +₱20','Oat milk +₱30','Extra shot +₱40']), 'option summary ' + JSON.stringify(latte));
  const matcha = await page.$$eval('#item-5 .iopts', a => a.map(x => x.textContent));
  ok(matcha[0] === 'Hot · Iced +₱10', 'matcha options ' + matcha);
  const off = await page.$$eval('.off', a => a.map(x => x.id + ':' + x.innerText.includes('Sold out today')));
  ok(off.join(',') === 'item-4:true,item-8:true', 'sold out cards ' + off);
  ok(await page.$eval('#item-4', e => e.querySelectorAll('.iopts').length === 0), 'sold-out card hides options');
  ok(log.dialogs === 0 && (await page.$$('img[src="x"]')).length === 0 && (await page.$$('main script')).length === 0, 'XSS name/description escaped (no dialog, no injected nodes)');
  ok(await page.$eval('#item-8 .iname', e => e.textContent) === '<img src=x onerror=alert(1)> "Pwn" & co', 'XSS name shown as text');
  ok(await page.$eval('#item-8 .iprice', e => e.textContent) === '₱99.50', 'decimal price ₱99.50');
  // visit box
  const v = await page.$eval('.visit', e => ({t: e.innerText, links: [...e.querySelectorAll('a')].map(a => ({h: a.href, tg: a.target, rel: a.rel, txt: a.textContent}))}));
  ok(v.t.includes('123 P. Burgos') && v.t.includes('Cavite City') && v.t.includes('7:00 AM'), 'visit address + hours');
  ok(v.links.length === 2 && v.links.every(l => l.tg === '_blank' && /noopener/.test(l.rel)) && /Open in Maps/.test(v.links[0].txt) && /Facebook/.test(v.links[1].txt), 'visit links: maps + facebook only, new tab, noopener');
  ok(!/Instagram/.test(v.t), 'no Instagram button when not set');
  // no auth
  ok(log.auth.length === 0, 'no /auth/v1 calls');
  ok(log.rpc.length >= 1 && log.rpc.every(r => r.auth === 'Bearer ' + r.apikey), 'rpc sent with anon key only');
  const ls = await page.evaluate(() => Object.keys(localStorage));
  ok(!ls.some(k => /session/.test(k)), 'no session in storage: ' + ls);
  ok(ls.includes('cccc.menu.cache.cccc'), 'menu cached');
  // tap targets
  // 1.4.2 (lead-approved 2026-11-10): the sub-category tabs are <button role="tab" class="chip"> inside <main>
  const tabs = await page.$$eval('main button[role="tab"].chip', a => a.length);
  ok(tabs === 5, 'tap-target check covers the 5 sub-category tabs', tabs);
  const small = await page.$$eval('main button[role="tab"].chip, .visit a, .hl', a => a.filter(x => x.getBoundingClientRect().height < 44).map(x => x.textContent));
  ok(small.length === 0, '44px targets ' + small);
  ok(log.errors.length === 0, 'no page errors ' + log.errors);
  // broken image -> no-photo tile
  ok(await page.$eval('#item-3 .thumb', e => e.classList.contains('nophoto')), 'broken photo turns into no-photo tile');
  // a real photo loads (item 0, Cafe latte, and the highlight photo)
  await page.locator('#item-0 .thumb img').scrollIntoViewIfNeeded();
  const loaded = async (sel) => page.waitForFunction((q) => { const i = document.querySelector(q); return i && i.complete && i.naturalWidth > 0; }, sel, {timeout: 8000}).then(() => true).catch(() => false);
  ok(await loaded('#item-0 .thumb img'), 'item photo actually loads (naturalWidth > 0)');
  ok(await loaded('.hl-photo img'), 'highlight photo actually loads (naturalWidth > 0)');
  // lazy images
  ok(await page.$$eval('.thumb img, .gphoto img', a => a.every(i => i.loading === 'lazy')), 'item photos lazy');
  await page.screenshot({path: OUT + '390-top.png'});
  await page.screenshot({path: OUT + '390-full.png', fullPage: true});
  // chip jump
  await page.click('#chips .chip:nth-child(4)');
  await page.waitForTimeout(900);
  ok(await page.$eval('#chips .chip:nth-child(4)', e => e.classList.contains('on')), 'chip becomes active after jump');
  await page.screenshot({path: OUT + '390-after-chip.png'});
  // keyboard focus visible
  await page.keyboard.press('Tab');
  await page.screenshot({path: OUT + '390-focus.png'});
  // offline with cache -> stale banner
  await page.route('**/rpc/public_menu', r => r.abort());
  await page.reload({waitUntil: 'domcontentloaded'}); await page.waitForTimeout(600);
  ok(await page.$('.stale') !== null && (await page.$$('.card')).length > 0, 'offline: cached menu + stale notice');
  await page.screenshot({path: OUT + '390-offline-cached.png'});
  await ctx.close();

  // offline no cache
  ({ctx, page, log} = await open('about:blank', 390));
  await page.route('**/rpc/public_menu', r => r.abort());
  await page.goto(BASE, {waitUntil: 'domcontentloaded'}); await page.waitForTimeout(600);
  ok(/couldn't open the menu/i.test(await page.innerText('main')), 'offline, no cache: try-again screen');
  await page.screenshot({path: OUT + '390-offline-empty.png'});
  await ctx.close();

  // widths
  for(const w of [360, 768, 1280]){
    ({ctx, page, log} = await open(BASE, w, w > 700 ? 900 : 780));
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(over <= 0, `no sideways scroll at ${w} (${over})`);
    await page.screenshot({path: OUT + w + '-full.png', fullPage: true});
    await ctx.close();
  }

  // highlight sold out + not found + bad code
  SQL("update recipes set sold_out=true where name='Ensaymada'; update settings set menu_highlight_label='Bagong luto', public_facebook_url=null, public_map_url=null, public_hours=null, public_address=null, service_charge_pct=10");
  ({ctx, page, log} = await open(BASE + '?shop=CCCC', 390));
  ok(await page.$eval('.hl', e => e.classList.contains('off') && e.innerText.includes('Sold out today') && /Bagong luto/i.test(e.innerText)), 'sold-out highlight greyed with custom label');
  ok(await page.$('.visit') === null, 'visit box hidden when all fields empty');
  ok(/10% service charge/.test(await page.innerText('.foot')), 'service charge note');
  await page.screenshot({path: OUT + '390-hl-soldout.png'});
  await ctx.close();
  SQL("update recipes set sold_out=false where name='Ensaymada'");

  for(const q of ['?shop=nope', '?shop=%3Cscript%3E']){
    ({ctx, page, log} = await open(BASE + q, 390));
    ok(/isn't available right now/i.test(await page.innerText('main')), 'NOT_FOUND page for ' + q);
    ok(log.auth.length === 0 && log.dialogs === 0, 'no auth/dialog on ' + q);
    if(q === '?shop=nope') await page.screenshot({path: OUT + '390-notfound.png'});
    await ctx.close();
  }
  // switched off -> not found, cache dropped
  ({ctx, page, log} = await open(BASE, 390));
  SQL('update settings set menu_public=false');
  await page.reload({waitUntil: 'networkidle'}); await page.waitForTimeout(300);
  ok(/isn't available right now/i.test(await page.innerText('main')), 'switched off -> not available');
  ok(!(await page.evaluate(() => Object.keys(localStorage))).includes('cccc.menu.cache.cccc'), 'cache dropped when switched off');
  SQL('update settings set menu_public=true');
  await ctx.close();
  // reduced motion still works
  ({ctx, page, log} = await open(BASE, 390, 844, {reduce: true}));
  ok((await page.$$('.card')).length > 0 && log.errors.length === 0, 'reduced motion render');
  await ctx.close();

  // truncated note: absent normally, shown when the database cut the list
  ({ctx, page, log} = await open(BASE, 390));
  ok(await page.$('.foot-more') === null, 'no "some items" note when not truncated');
  await ctx.close();
  SQL("insert into recipes (business_id,name,recipe_type,category,selling_price,sort_order) select business_id,'Extra '||g,'DRINKS','Hot',100,100+g from settings, generate_series(1,300) g");
  ({ctx, page, log} = await open(BASE, 390));
  ok(/Some items aren't shown here/.test(await page.innerText('main')) && (await page.$$('.card, .gcard')).length === 300, 'truncated note shown with 300 items');
  await page.screenshot({path: OUT + '390-truncated-end.png', fullPage: false, clip: undefined});
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(200);
  await page.screenshot({path: OUT + '390-truncated-end.png'});
  await ctx.close();
  SQL("delete from recipes where name like 'Extra %'");
  // CUSTOM theme with null colours -> brand tokens, no errors
  SQL("update settings set theme='CUSTOM', primary_color=null, secondary_color=null, accent_color=null, background_color=null, card_color=null, text_color=null");
  ({ctx, page, log} = await open(BASE, 390));
  const bg = await page.$eval('.mhead', e => getComputedStyle(e).backgroundColor);
  ok(bg === 'rgb(181, 67, 43)' && log.errors.length === 0 && (await page.$$('.card')).length > 0, 'CUSTOM theme with null colours falls back to brand (' + bg + ')');
  await page.screenshot({path: OUT + '390-custom-null.png'});
  await ctx.close();
  await browser.close();
  console.log(`SUMMARY menu_public.e2e: ${checks} checks, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
