// Captures prototype screenshots of all three apps against the lead's demo database
// (db_lead on port 8795, loaded with demo_seed.sql). Order: customer orders on the QR page ->
// the counter takes it, accepts, takes payment, marks ready -> customer sees Ready ->
// Back Office screens. Usage: node capture.js
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
const BASE = 'http://localhost:8795';
const OUT = path.join(__dirname, 'shots');
const log = [];
const errors = [];
function note(m){ console.log(m); log.push(m); }
async function sql(q){ const r = await fetch(BASE + '/__sql', {method: 'POST', body: `select to_jsonb((${q}))`}); const t = await r.text(); if(!r.ok) throw new Error(t); return JSON.parse(t); }
async function until(fn, ms){ const end = Date.now() + (ms || 15000); while(Date.now() < end){ try{ if(await fn()) return true; }catch(e){} await new Promise(r => setTimeout(r, 200)); } return false; }
async function shot(page, name, opts){
  try{ await page.waitForTimeout(450); await page.screenshot(Object.assign({path: path.join(OUT, name + '.png')}, opts || {})); note('shot ' + name); }
  catch(e){ note('MISSED ' + name + ': ' + e.message.split('\n')[0]); }
}
async function step(name, fn){ try{ await fn(); } catch(e){ note('STEP FAILED ' + name + ': ' + e.message.split('\n')[0]); } }
function watch(page, tag){
  page.on('pageerror', e => errors.push(tag + ' pageerror: ' + e.message));
  page.on('console', m => { if(m.type() === 'error' && !/favicon|Failed to load resource|fonts\.g|net::ERR/.test(m.text())) errors.push(tag + ' console: ' + m.text()); });
}
const LATTE = '33333333-0000-0000-0000-000000000005';   // Spanish Latte
const PANDESAL = '33333333-0000-0000-0000-000000000011';

(async () => {
  const browser = await chromium.launch();

  // ================= Customer QR page (phone) =================
  const qctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2, timezoneId: 'Asia/Manila', locale: 'en-PH'});
  const q = await qctx.newPage(); watch(q, 'QR');
  await step('qr first visit', async () => {
    await q.goto(BASE + '/cccc/order/?t=tabletoken5');
    await q.waitForSelector('#w-name', {timeout: 15000});
    await shot(q, 'q01-first-visit');
    await q.fill('#w-name', 'Zed');
    await q.fill('#w-phone', '0917 123 4567');
    await q.check('#w-consent');
    await shot(q, 'q02-name-filled');
    await q.click('#w-go');
    await until(() => q.isVisible('#not-me'));
    await q.waitForTimeout(3600);           // let the welcome toast go
    await shot(q, 'q03-menu');
  });
  await step('qr item sheet', async () => {
    await q.click(`.item[data-item="${LATTE}"]`);
    await q.waitForSelector('#it-add');
    await q.click('.opt[data-g="g-size"][data-o="o-16"]');
    await q.click('.opt[data-g="g-milk"][data-o="o-oat"]');
    await shot(q, 'q04-item-options');
    await q.click('#it-add');
    await q.waitForSelector('#view-cart');
    await q.click(`.item[data-item="${PANDESAL}"]`);
    if(await until(() => q.isVisible('#it-add'), 2500)) await q.click('#it-add');
    await q.waitForTimeout(3600);
    await shot(q, 'q05-menu-with-bag');
    await q.click('#view-cart');
    await shot(q, 'q06-cart');
    await q.click('#c-place');
    await q.waitForSelector('.ticket-no', {timeout: 10000});
    await q.waitForTimeout(1500);
    await shot(q, 'q07-ticket-sent', {fullPage: true});
  });

  // ================= Front Office (counter) =================
  const fctx = await browser.newContext({viewport: {width: 1280, height: 800}, timezoneId: 'Asia/Manila', locale: 'en-PH'});
  const f = await fctx.newPage(); watch(f, 'FO');
  fctx.on('page', p => { if(p !== f) p.waitForLoadState().then(() => p.close()).catch(() => {}); });   // receipt popups
  const pin = async (digits) => { for(const d of digits) await f.click(`#pin-pad button[data-k="${d}"]`); await f.click('#pin-enter'); };
  const addItem = async (name, choose) => {
    await f.click(`.pos-product-card:has-text("${name}")`);
    if(await until(() => f.isVisible('#mod-add'), 1500)){
      for(const c of (choose || [])) await f.click(`.mod-opt:has-text("${c}")`);
      if(!(choose || []).length){ const first = await f.$('.mod-opt'); if(first) await first.click(); }
      await f.click('#mod-add');
    }
  };
  await step('fo setup + pin + shift', async () => {
    await f.goto(BASE + '/cccc/front/');
    await f.waitForSelector('#su-code', {timeout: 15000});
    await shot(f, 'f01-pair-counter');
    await f.fill('#su-code', 'testab');
    await f.click('#su-pair');
    await f.waitForSelector('#pin-gate', {state: 'visible', timeout: 20000});
    await f.click('#pin-pad button[data-k="1"]'); await f.click('#pin-pad button[data-k="1"]');
    await shot(f, 'f02-pin');
    await f.click('#pin-pad button[data-k="1"]'); await f.click('#pin-pad button[data-k="1"]'); await f.click('#pin-enter');
    await f.waitForSelector('#ss-opening-cash', {timeout: 15000});
    await f.fill('#ss-opening-cash', '2000');
    await shot(f, 'f03-start-shift');
    await f.click('#ss-start-btn');
    await f.waitForSelector('.pos-product-card');
    await shot(f, 'f04-sell');
  });
  await step('fo sale', async () => {
    await f.click('.pos-product-card:has-text("Caramel Macchiato")');
    await f.waitForSelector('#mod-add');
    await f.click('.mod-opt:has-text("16oz")');
    await f.click('.mod-opt:has-text("Extra shot")');
    await shot(f, 'f05-options');
    await f.click('#mod-add');
    await addItem('Ensaymada');
    await addItem('Americano', ['12oz']);
    await addItem('Banana Bread');
    await shot(f, 'f06-cart');
    await f.click('#checkout-btn');
    await f.waitForSelector('#complete-sale-btn');
    await f.fill('#cash-tendered', '500').catch(() => {});
    await shot(f, 'f07-checkout');
    await f.click('#complete-sale-btn');
    await until(async () => (await sql(`select count(*) from sales where transaction_date > now() - interval '10 minutes'`)) >= 1);
    await f.waitForTimeout(1200);
  });
  await step('fo qr board', async () => {
    await f.click('.nav-item[data-route="qr"]');
    await f.waitForSelector('.qr-card', {timeout: 15000});
    await shot(f, 'f08-qr-board-new');
    await f.click('[data-qr-act="ACCEPT"]');
    await f.waitForTimeout(1500);
    await f.click('[data-qr-act="PAY"]');
    await f.waitForSelector('#checkout-btn', {timeout: 10000});
    await f.waitForTimeout(800);
    await shot(f, 'f09a-qr-order-in-cart');
    await f.click('#checkout-btn');
    await f.waitForSelector('#complete-sale-btn', {timeout: 10000});
    await f.click('[data-method="GCASH"]');
    await f.waitForSelector('#pay-confirmed');
    await f.fill('#pay-ref', '5021 334 789').catch(() => {});
    await f.check('#pay-confirmed');
    await shot(f, 'f09-qr-take-payment');
    await f.click('#complete-sale-btn');
    await f.waitForTimeout(2500);
    await f.click('.nav-item[data-route="qr"]').catch(() => {});
    await f.waitForSelector('[data-qr-act="READY"]', {timeout: 15000});
    await f.click('[data-qr-act="READY"]');
    await f.waitForTimeout(2000);
    await shot(f, 'f10-qr-board-ready');
  });
  await step('qr ready + welcome back', async () => {
    await until(async () => /ready/i.test(await q.textContent('main')), 15000);
    await q.waitForTimeout(800);
    await shot(q, 'q08-ticket-ready', {fullPage: true});
    await q.reload();
    await q.waitForTimeout(3000);
    await shot(q, 'q09-welcome-back');
  });
  await step('fo sales + shift', async () => {
    await f.click('.nav-item[data-route="sales"]');
    await f.waitForSelector('tr[data-id]');
    await shot(f, 'f11-sales');
    await f.click('.nav-item[data-route="shift"]');
    await f.waitForSelector('#close-shift-btn');
    await shot(f, 'f12-shift-cash');
  });
  await step('fo manager approval', async () => {
    await f.click('.nav-item[data-route="sales"]');
    await f.waitForSelector('tr[data-id]');
    await f.click('tr[data-id]');
    await f.waitForSelector('#void-btn');
    await shot(f, 'f13-sale-detail');
    await f.click('#void-btn');
    await f.waitForSelector('#pin-gate', {state: 'visible'});
    await shot(f, 'f14-manager-approval');
  });

  // ================= Back Office =================
  const bctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila', locale: 'en-PH'});
  const b = await bctx.newPage(); watch(b, 'BO');
  const go = async (route, param) => { await b.evaluate(([r, p]) => navigate(r, p), [route, param == null ? null : param]); await b.waitForTimeout(1300); };
  await step('bo login', async () => {
    await b.goto(BASE + '/cccc/back/');
    await b.waitForSelector('#li-email', {timeout: 15000});
    await shot(b, 'b01-sign-in');
    await b.fill('#li-email', 'owner@example.com'); await b.fill('#li-pass', 'secret123');
    await b.click('#f-login button[type=submit]');
    await b.waitForSelector('#app', {state: 'visible', timeout: 20000});
    await b.waitForTimeout(1500);
    await shot(b, 'b02-dashboard');
  });
  await step('bo calendar', async () => {
    await go('calendar');
    await b.click('[data-view="month"]'); await b.waitForTimeout(900);
    await shot(b, 'b03-calendar-month', {fullPage: true});
    await b.click('[data-view="week"]'); await b.waitForTimeout(900);
    await shot(b, 'b04-calendar-week', {fullPage: true});
    await b.click('[data-view="day"]'); await b.waitForTimeout(700);
    // step back to the most recent Saturday for a busy day
    for(let i = 0; i < 7; i++){
      const t = await b.textContent('#content');
      if(/Sat,/.test(t)) break;
      await b.click('#content button:has-text("◀")'); await b.waitForTimeout(700);
    }
    await b.mouse.move(5, 5);
    await shot(b, 'b05-calendar-day', {fullPage: true});
    await b.click('[data-view="shift"]'); await b.waitForTimeout(900);
    await shot(b, 'b06-calendar-shift', {fullPage: true});
  });
  for(const [route, name, full] of [['transactions', 'b07-transactions'], ['qrOrders', 'b08-qr-orders'], ['customers', 'b09-customers'],
      ['ingredients', 'b10-ingredients'], ['purchases', 'b11-purchases'], ['recipes', 'b12-recipes'], ['inventory', 'b14-inventory'],
      ['costing', 'b15-costing'], ['suppliers', 'b16-suppliers'], ['reports', 'b17-reports'], ['tables', 'b18-tables'],
      ['staff', 'b20-staff'], ['devices', 'b21-devices'], ['auditLog', 'b23-audit-log'], ['settings', 'b24-settings'], ['backup', 'b25-backup'], ['production', 'b26-production']]){
    await step('bo ' + route, async () => { await go(route); await shot(b, name, full ? {fullPage: true} : undefined); });
  }
  await step('bo recipe editor', async () => {
    await go('recipeDetail', LATTE);
    await shot(b, 'b13a-recipe-page', {fullPage: true});
    await b.click('#edit-rec-btn');
    await b.waitForSelector('#mod-editor');
    await b.waitForTimeout(600);
    await shot(b, 'b13b-recipe-options-editor', {fullPage: true});
    await b.click('#active-modal-overlay [data-cancel]').catch(() => b.keyboard.press('Escape'));
    await b.waitForTimeout(500);
  });
  await step('bo qr sheet', async () => {
    await go('tables');
    const [popup] = await Promise.all([bctx.waitForEvent('page'), (async () => { await b.click('#print-qr'); await b.click('#pq-go'); })()]);
    await popup.waitForLoadState(); await popup.waitForTimeout(800);
    await popup.screenshot({path: path.join(OUT, 'b19-qr-print-sheet.png'), fullPage: true}); note('shot b19-qr-print-sheet');
    await popup.close();
  });
  await step('bo pairing', async () => {
    await go('devices');
    await b.click('#pair-new');
    await b.fill('#pd-name', 'Bar tablet');
    await b.click('#pd-make');
    await b.waitForSelector('.big-code');
    await shot(b, 'b22-pair-a-counter');
    await b.click('#active-modal-overlay [data-cancel]').catch(() => {});
  });
  await step('bo report', async () => {
    await go('reports');
    const btn = await b.$('#content button:has-text("Sales by item"), #content [data-report]:has-text("item")');
    if(btn){ await btn.click(); await b.waitForTimeout(1200); await shot(b, 'b17b-report-sales-by-item', {fullPage: true}); }
  });
  await step('bo tablet + phone', async () => {
    await b.setViewportSize({width: 768, height: 1024});
    await go('dashboard'); await shot(b, 'b30-tablet-dashboard');
    await b.setViewportSize({width: 390, height: 844});
    await go('dashboard'); await shot(b, 'b31-phone-dashboard');
  });

  await browser.close();
  note(errors.length ? 'BROWSER ERRORS:\n' + errors.join('\n') : 'no browser errors');
})().catch(e => { console.error(e); process.exit(1); });
