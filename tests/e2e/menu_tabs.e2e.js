// Public menu page release 1.4.2: sub-category tabs + swipe panels (adopted from customer-qr-dev's menu142-check.js, 2026-11-10).
// Applies its own seed (tests/sql/24_seed_menu.sql) on top of the browser seed.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/menu_tabs.e2e.js
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { execSync } = require('child_process');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = process.env.FAKE_PORT || 8787, DB = process.env.FAKE_DB || 'cccc';
if(!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('FAKE_DB must be a plain lowercase database name');
const ORIGIN = 'http://localhost:' + PORT, BASE = ORIGIN + '/cccc/menu/';
const OUT = path.join(process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'cccc-qa-shots'), 'menu142') + '/';
const SQL = (q) => execSync(`psql -h /tmp -p 54329 -U postgres -d ${DB} -Atqc "${q}"`).toString();
require('fs').mkdirSync(OUT, {recursive: true});
execSync(`psql -h /tmp -p 54329 -U postgres -d ${DB} -q -v ON_ERROR_STOP=1 -f ${ROOT}/tests/sql/24_seed_menu.sql`, {stdio: 'ignore'});
SQL(`update recipes set image_url = case when image_url like '%/missing.jpg' then '${ORIGIN}/tests/fixtures/no-such-photo.jpg' else '${ORIGIN}/cccc/shared/brand/tile-icon-192.png' end where image_url like 'http://localhost:8893/%'`);
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + m); if(!c) fails++; };
const CATS = ['Hot','Iced','Non-coffee','Pastry','Rice meals'];

(async () => {
  const browser = await chromium.launch();
  async function open(url, w, h, o = {}){
    const ctx = await browser.newContext({viewport: {width: w, height: h || 844}, deviceScaleFactor: 2, isMobile: w < 700, hasTouch: w < 700, reducedMotion: o.reduce ? 'reduce' : 'no-preference'});
    const page = await ctx.newPage();
    const log = {errors: [], dialogs: 0};
    page.on('pageerror', e => log.errors.push(String(e)));
    page.on('dialog', d => { log.dialogs++; d.dismiss(); });
    await page.goto(url, {waitUntil: 'networkidle'});
    await page.waitForTimeout(300);
    return {ctx, page, log};
  }
  const state = (page) => page.evaluate(() => {
    const t = document.getElementById('track');
    const tabs = [...document.querySelectorAll('#chips [role=tab]')];
    const panels = [...document.querySelectorAll('#track > .panel')];
    const act = tabs.findIndex(b => b.getAttribute('aria-selected') === 'true');
    return {
      tabs: tabs.map(b => b.textContent), act, on: tabs.findIndex(b => b.classList.contains('on')),
      onCount: tabs.filter(b => b.classList.contains('on')).length,
      tabIdx: tabs.map(b => b.tabIndex), sl: t ? t.scrollLeft : null, w: t ? t.clientWidth : null,
      th: t ? t.offsetHeight : null, ph: panels.map(p => p.offsetHeight), inert: panels.map(p => p.hasAttribute('inert')),
      hash: location.hash, over: document.documentElement.scrollWidth - innerWidth, y: scrollY,
      focus: document.activeElement && (document.activeElement.id || document.activeElement.className)
    };
  });
  const atPanel = (s, i) => s.act === i && s.on === i && s.onCount === 1 && Math.abs(s.sl - i * s.w) <= 4 && s.th === s.ph[i]
    && s.inert.every((x, j) => x === (j !== i)) && s.tabIdx.every((x, j) => x === (j === i ? 0 : -1));

  // ---- 1. tabs, order, roles ----
  let {ctx, page, log} = await open(BASE, 390);
  let s = await state(page);
  ok(JSON.stringify(s.tabs) === JSON.stringify(CATS), 'tabs in subcategory order: ' + s.tabs);
  ok(await page.$eval('#chips .chips-in', e => e.getAttribute('role') === 'tablist' && !!e.getAttribute('aria-label')), 'role=tablist with label');
  ok(await page.$$eval('#chips [role=tab]', a => a.every((b, i) => b.getAttribute('aria-controls') === 'sec-' + i && document.getElementById('sec-' + i).getAttribute('role') === 'tabpanel' && document.getElementById('sec-' + i).getAttribute('aria-labelledby') === b.id)), 'tabs ↔ panels wired (aria-controls / aria-labelledby)');
  ok(atPanel(s, 0) && s.hash === '', 'starts on first tab, track height = first panel, others inert');
  ok(await page.$eval('#track', e => getComputedStyle(e).scrollSnapType.includes('x') && getComputedStyle(e).scrollSnapType.includes('mandatory')), 'scroll-snap x mandatory');
  ok(await page.$$eval('#track > .panel', a => a.every(p => getComputedStyle(p).overflowY === 'visible')), 'panels do not scroll on their own (no nested vertical scroll)');
  // visit box sits right after the active panel
  const gap = await page.evaluate(() => document.querySelector('.visit').getBoundingClientRect().top - document.getElementById('track').getBoundingClientRect().bottom);
  ok(gap >= 0 && gap < 40, 'visit box right below active panel (gap ' + gap + ')');
  await page.screenshot({path: OUT + 'menu142-390-tab1.png'});
  await page.screenshot({path: OUT + 'menu142-390-tab1-full.png', fullPage: true});

  // ---- 2. tap a tab -> its panel ----
  await page.click('#tab-btn-2'); await page.waitForTimeout(900);
  s = await state(page);
  ok(atPanel(s, 2) && s.hash === '#tab-3', 'tap "Non-coffee" → panel 3 shown, hash #tab-3 ' + JSON.stringify({act: s.act, sl: s.sl, hash: s.hash}));
  const gap2 = await page.evaluate(() => document.querySelector('.visit').getBoundingClientRect().top - document.getElementById('track').getBoundingClientRect().bottom);
  ok(gap2 >= 0 && gap2 < 40, 'visit box follows the shorter panel (gap ' + gap2 + ')');
  // ---- 3. programmatic swipe ----
  await page.evaluate(() => { const t = document.getElementById('track'); t.scrollLeft = t.clientWidth * 4; });
  await page.waitForTimeout(700);
  s = await state(page);
  ok(atPanel(s, 4) && s.hash === '#tab-5', 'swipe (scrollLeft) to panel 5 → tab "Rice meals" active, hash #tab-5');
  const tabInView = await page.evaluate(() => { const b = document.getElementById('tab-btn-4').getBoundingClientRect(), r = document.querySelector('.chips-in').getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; });
  ok(tabInView, 'active tab scrolled into view in the tab row');
  await page.evaluate(() => { const t = document.getElementById('track'); t.scrollLeft = t.clientWidth * 1; });
  await page.waitForTimeout(700);
  s = await state(page);
  ok(atPanel(s, 1), 'swipe back to panel 2 → "Iced" active');
  // pnav buttons
  await page.click('#sec-1 .pbtn.next'); await page.waitForTimeout(900);
  s = await state(page);
  ok(atPanel(s, 2) && s.focus === 'sec-2', 'panel "next" button → panel 3, focus on the new panel');
  await page.screenshot({path: OUT + 'menu142-390-tab3.png'});
  // ---- 4. keyboard ----
  await page.focus('#tab-btn-2');
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(700);
  s = await state(page);
  ok(atPanel(s, 3) && s.focus === 'tab-btn-3', 'ArrowRight → next tab focused + shown');
  await page.keyboard.press('Home'); await page.waitForTimeout(700);
  s = await state(page); ok(atPanel(s, 0) && s.focus === 'tab-btn-0', 'Home → first tab');
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(700);
  s = await state(page); ok(atPanel(s, 4) && s.focus === 'tab-btn-4', 'ArrowLeft on first wraps to last');
  await page.keyboard.press('Tab');
  ok(await page.evaluate(() => document.activeElement.id === 'sec-4'), 'Tab from tab row → active panel (inactive tabs skipped)');
  await page.click('#tab-btn-3'); await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(200);
  ok(await page.evaluate(() => { const h = document.querySelector('.hl'), c = document.getElementById('chips'), t = document.getElementById('track');
    return [!!(h.compareDocumentPosition(c) & 4), !!(c.compareDocumentPosition(t) & 4), Math.round(c.getBoundingClientRect().top), scrollY]; }).then(r => { console.log('  order/sticky', r); return r[0] && r[1] && Math.abs(r[2]) <= 1; }), 'DOM/visual order: highlight → tabs → panels, tabs sticky at top while in a panel');
  await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(100);
  await page.screenshot({path: OUT + 'menu142-390-focus.png'});
  // ---- 5. highlight jump ----
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);
  await page.click('.hl'); await page.waitForTimeout(150);
  ok(await page.$eval('#item-6', e => e.classList.contains('flash')), 'highlight → item flashes');
  await page.waitForTimeout(900);
  s = await state(page);
  const inView = await page.$eval('#item-6', e => { const r = e.getBoundingClientRect(); return r.top >= 60 && r.bottom <= innerHeight; });
  ok(atPanel(s, 3) && s.hash === '#tab-4' && s.focus === 'item-6' && inView, 'highlight → Pastry panel, item in view + focused, hash #tab-4');
  await page.screenshot({path: OUT + 'menu142-390-pastry-jump.png'});
  // ---- 6. back button ----
  await page.click('#tab-btn-1'); await page.waitForTimeout(700);
  await page.click('#tab-btn-4'); await page.waitForTimeout(700);
  await page.goBack(); await page.waitForTimeout(600);
  s = await state(page); ok(atPanel(s, 1) && s.hash === '#tab-2', 'back button → previous tab (Iced)');
  await page.goForward(); await page.waitForTimeout(600);
  s = await state(page); ok(atPanel(s, 4), 'forward → Rice meals again');
  ok(log.errors.length === 0 && log.dialogs === 0, 'no page errors / dialogs ' + log.errors);
  await ctx.close();

  // ---- 7. hash restore (shared link) + legacy #sec-N / #item-N ----
  ({ctx, page, log} = await open(BASE + '#tab-4', 390));
  s = await state(page);
  const tabsTop = await page.$eval('#chips', e => e.getBoundingClientRect().top);
  ok(atPanel(s, 3) && s.y > 0 && Math.abs(tabsTop) <= 1, 'shared link #tab-4 → Pastry, page scrolled to the tabs');
  await ctx.close();
  ({ctx, page, log} = await open(BASE + '#sec-2', 390)); s = await state(page);
  ok(atPanel(s, 2), 'old link #sec-2 → Non-coffee'); await ctx.close();
  ({ctx, page, log} = await open(BASE + '#item-9', 390)); s = await state(page);
  ok(atPanel(s, 4) && await page.$eval('#item-9', e => e.getBoundingClientRect().top < innerHeight), 'old link #item-9 → Rice meals, item in view'); await ctx.close();
  for(const bad of ['#tab-99', '#tab-0', '#tab-x', '#%3Cimg%3E']){
    ({ctx, page, log} = await open(BASE + bad, 390)); s = await state(page);
    ok(atPanel(s, 0) && log.errors.length === 0, 'bad hash ' + bad + ' → first tab, no errors'); await ctx.close();
  }

  // ---- 8. widths: no sideways page scroll, on first and last tab ----
  for(const w of [360, 390, 768, 1280]){
    ({ctx, page, log} = await open(BASE, w, w > 700 ? 900 : 780));
    let o1 = (await state(page)).over;
    await page.click('#tab-btn-4'); await page.waitForTimeout(900);
    s = await state(page);
    ok(o1 <= 0 && s.over <= 0 && atPanel(s, 4), `no sideways scroll at ${w} (${o1}/${s.over})`);
    if(w === 1280){
      await page.click('#tab-btn-0'); await page.waitForTimeout(900);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({path: OUT + 'menu142-1280.png'});
      await page.screenshot({path: OUT + 'menu142-1280-full.png', fullPage: true});
    }
    ok(log.errors.length === 0, 'no errors at ' + w);
    await ctx.close();
  }

  // ---- 9. reduced motion: instant ----
  ({ctx, page, log} = await open(BASE, 390, 844, {reduce: true}));
  await page.click('#tab-btn-3'); await page.waitForTimeout(60);
  s = await state(page);
  ok(atPanel(s, 3), 'reduced motion: tab jump is instant (no slide)');
  ok(await page.$eval('#track', e => getComputedStyle(e).scrollBehavior === 'auto') && await page.$eval('.hl', e => getComputedStyle(e).transitionDuration.split(',').every(x => parseFloat(x) === 0)), 'reduced motion: no smooth scroll / transitions');
  await page.click('.hl'); await page.waitForTimeout(60);
  ok(await page.$eval('#item-6', e => getComputedStyle(e).animationName === 'none'), 'reduced motion: no flash animation');
  ok(log.errors.length === 0, 'reduced motion: no errors');
  await ctx.close();

  // ---- 10. offline from saved copy ----
  ({ctx, page, log} = await open(BASE, 390));
  await page.route('**/rpc/public_menu', r => r.abort());
  await page.goto(BASE + '#tab-2', {waitUntil: 'domcontentloaded'}); await page.reload({waitUntil: 'domcontentloaded'}); await page.waitForTimeout(700);
  s = await state(page);
  ok(await page.$('.stale') !== null && atPanel(s, 1), 'offline (saved copy): stale notice, #tab-2 restored');
  await page.click('#tab-btn-4'); await page.waitForTimeout(800);
  s = await state(page); ok(atPanel(s, 4) && log.errors.length === 0, 'offline: tabs still work, no JS errors ' + log.errors);
  await page.screenshot({path: OUT + 'menu142-390-offline.png'});
  await ctx.close();

  // ---- 11. menu refresh keeps the tab ----
  ({ctx, page, log} = await open(BASE + '#tab-3', 390));
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await page.click('#tab-btn-1'); await page.waitForTimeout(700);
  SQL("update recipes set selling_price = selling_price where false");
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Date.now = ((n) => () => n() + 120000)(Date.now); Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(900);
  s = await state(page); ok(atPanel(s, 1), 'after a live refresh the same tab stays open');
  await ctx.close();

  // ---- 12. many sub-categories ----
  SQL("update recipes set category = 'Signature ' || chr(64 + (sort_order % 12) + 1) || ' blends' where recipe_type = 'DRINKS' and qr_visible");
  SQL("insert into recipes (business_id,name,recipe_type,category,selling_price,sort_order) select business_id,'Many '||g,'DRINKS','Signature '||chr(64+g)||' blends',100,200+g from settings, generate_series(1,12) g");
  ({ctx, page, log} = await open(BASE, 360, 780));
  s = await state(page);
  const row = await page.$eval('.chips-in', e => ({sw: e.scrollWidth, cw: e.clientWidth}));
  ok(s.tabs.length >= 12 && row.sw > row.cw && s.over <= 0, `many tabs (${s.tabs.length}): tab row scrolls, page does not`);
  const last = s.tabs.length - 1;
  await page.focus('#tab-btn-0'); await page.keyboard.press('End'); await page.waitForTimeout(900);
  s = await state(page);
  const lastInView = await page.evaluate((i) => { const b = document.getElementById('tab-btn-' + i).getBoundingClientRect(), r = document.querySelector('.chips-in').getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; }, last);
  ok(atPanel(s, last) && lastInView && log.errors.length === 0, 'many: End → last tab shown and scrolled into view ' + JSON.stringify({act: s.act, last, sl: s.sl, w: s.w, th: s.th, ph: s.ph[last], lastInView}));
  await page.screenshot({path: OUT + 'menu142-360-many.png'});
  await ctx.close();
  SQL("delete from recipes where name like 'Many %'");

  // ---- 13. one sub-category ----
  SQL("update recipes set category = 'Everything' where qr_visible");
  ({ctx, page, log} = await open(BASE + '#tab-2', 390));
  s = await state(page);
  ok(await page.$('#chips') === null && s.tabs.length === 0 && await page.$('#track.single') !== null && await page.$('.pbtn') === null && await page.$('[role=tabpanel]') === null, 'one sub-category: no tabs, no swipe, no prev/next');
  ok(await page.$eval('#track', e => getComputedStyle(e).overflowX === 'visible' && e.style.height === ''), 'one sub-category: track not a scroller, natural height');
  ok(s.over <= 0 && log.errors.length === 0 && (await page.$$('.card, .gcard')).length > 5, 'one sub-category: renders, no errors');
  await page.screenshot({path: OUT + 'menu142-390-single.png', fullPage: true});
  await ctx.close();

  await browser.close();
  console.log(`SUMMARY menu_tabs.e2e: ${n} checks, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
