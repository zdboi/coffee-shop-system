// Front Office end-to-end: pair, PIN, shift, sale with modifiers, offline sale + sync, void.
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const BASE = 'http://localhost:8787';
async function sql(q){ const r = await fetch(BASE + '/__sql', {method:'POST', body: `select to_jsonb((${q}))`}); const t = await r.text(); if(!r.ok) throw new Error(t); return JSON.parse(t); }
function ok(cond, msg){ if(!cond) throw new Error('FAILED: ' + msg); console.log('ok  ' + msg); }
async function until(fn, msg, ms){ const end = Date.now() + (ms||20000); while(Date.now() < end){ try{ if(await fn()) return true; }catch(e){} await new Promise(r=>setTimeout(r, 300)); } throw new Error('TIMEOUT waiting for: ' + msg); }
async function typePin(page, pin){ for(const d of pin) await page.click(`#pin-pad button[data-k="${d}"]`); await page.click('#pin-enter'); }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if(m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  ctx.on('page', p => { p.waitForLoadState().then(()=>p.close()).catch(()=>{}); });   // receipt popups

  await page.goto(BASE + '/cccc/front/');
  await page.waitForSelector('#su-code', {timeout: 10000});
  ok(true, 'setup screen shown for an unpaired counter');
  await page.fill('#su-code', 'wrong1');
  await page.click('#su-pair');
  await page.waitForFunction(() => document.getElementById('su-error').textContent.length > 0);
  ok((await page.textContent('#su-error')).includes('wrong or has expired'), 'bad code shows a clear message');
  await page.fill('#su-code', 'testab');
  await page.click('#su-pair');
  await page.waitForSelector('#pin-gate', {state: 'visible', timeout: 15000});
  ok(true, 'paired; PIN screen shown');
  ok((await sql(`select count(*) from devices where device_name='Front Counter' and device_tag='A'`)) === 1, 'device row created (tag A)');

  await typePin(page, '1234');
  await page.waitForFunction(() => /Incorrect/.test(document.getElementById('pin-error').textContent));
  ok(true, 'wrong PIN rejected');
  await typePin(page, '1111');
  await page.waitForSelector('#ss-opening-cash', {timeout: 10000});
  ok(true, 'cashier signed in -> start shift screen');
  await page.fill('#ss-opening-cash', '2000');
  await page.click('#ss-start-btn');
  await page.waitForSelector('.pos-product-card');
  ok((await page.$$('.pos-product-card')).length === 3, 'menu shows 3 sellable items');

  // sale 1: Iced Latte 16oz + extra shot (150+20+30=200)
  await page.click('.pos-product-card:has-text("Iced Latte")');
  await page.waitForSelector('.mod-opt');
  await page.click('#mod-add');                       // size is required -> error toast
  await page.waitForSelector('.toast.error');
  await page.click('.mod-opt:has-text("16oz")');
  await page.click('.mod-opt:has-text("Extra shot")');
  ok((await page.textContent('#mod-total-price')).includes('200.00'), 'modifier pricing 150+20+30 = 200');
  await page.click('#mod-add');
  await page.click('.pos-product-card:has-text("Ensaymada")');
  ok((await page.textContent('.pos-cart-summary .total')).includes('265.00'), 'cart total 265');
  await page.click('#checkout-btn');
  await page.click('[data-quick]');                   // Exact
  await page.click('#complete-sale-btn');
  await until(async()=> (await sql(`select count(*) from sales where status='COMPLETED'`)) === 1, 'sale 1 on server');
  const s1 = await sql(`select jsonb_build_object('n', count(*), 'total', sum(grand_total)) from sales where status='COMPLETED'`);
  ok(s1.n === 1 && Number(s1.total) === 265, 'sale uploaded to Supabase (₱265)');
  const beans = await sql(`select stock from v_ingredient_stock where ingredient_id='22222222-0000-0000-0000-000000000001'`);
  ok(Number(beans) === 1000 - 18 - 18, 'beans deducted incl. extra-shot modifier (964 g)');
  const milk = await sql(`select stock from v_ingredient_stock where ingredient_id='22222222-0000-0000-0000-000000000002'`);
  ok(Number(milk) === 5000 - 180 - 60, 'milk deducted incl. 16oz modifier (4760 ml)');
  ok((await sql(`select transaction_number from sales limit 1`)) === 'POS-A-2026-000001', 'transaction number POS-A-2026-000001');

  // sale 2 while OFFLINE
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.click('.pos-product-card:has-text("Americano")');
  await page.click('#checkout-btn');
  await page.fill('#cash-tendered', '200');
  ok((await page.textContent('#change-val')).includes('90.00'), 'change ₱90 on ₱200');
  await page.click('#complete-sale-btn');
  await until(async()=> (await page.evaluate(() => LocalDB.outboxCount())) >= 1, 'offline sale queued', 5000);
  ok(true, 'offline sale queued on the counter');
  await until(async()=> (await page.textContent('#sync-pill')).includes('Offline'), 'pill shows Offline', 8000); ok(true, 'status shows Offline (detected from failed requests, not just the browser flag)');
  ok((await sql(`select count(*) from sales`)) === 1, 'server has not received it yet');
  // reload while offline: app must still open from cache + snapshot
  await page.reload();
  await page.waitForFunction(() => document.getElementById('app').style.display === 'flex' || document.getElementById('pin-gate').style.display === 'flex', null, {timeout: 20000});
  const appVisible = await page.isVisible('#app');
  if(!appVisible){ await typePin(page, '1111'); await page.waitForSelector('#app', {state:'visible'}); }
  ok(true, 'counter re-opens while offline');
  await page.click('.nav-item[data-route="sales"]');
  await page.waitForSelector('tr[data-id]');
  ok((await page.$$('tr[data-id]')).length === 2, 'offline sale still listed after reload');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async()=> (await sql(`select count(*) from sales where status='COMPLETED'`)) === 2, 'offline sale uploaded');
  ok((await sql(`select count(*) from sales where status='COMPLETED'`)) === 2, 'offline sale uploaded after reconnect');
  ok((await sql(`select bool_or(offline) from sales`)) === true, 'sale flagged as made offline');

  // void sale 1 with manager PIN
  await page.click('tr[data-id]:has-text("POS-A-2026-000001")');
  await page.click('#void-btn');
  await page.waitForSelector('#pin-gate', {state: 'visible'});
  await typePin(page, '1111');
  await page.waitForFunction(() => /manager/.test(document.getElementById('pin-error').textContent));
  ok(true, 'cashier PIN cannot approve a void');
  await typePin(page, '2222');
  await page.waitForSelector('#rv-reason');
  await page.fill('#rv-reason', 'test void');
  await page.click('#rv-confirm');
  await until(async()=> (await sql(`select count(*) from refunds`)) === 1, 'void on server');
  ok((await sql(`select status from sales where transaction_number='POS-A-2026-000001'`)) === 'VOIDED', 'void synced');
  ok(Number(await sql(`select stock from v_ingredient_stock where ingredient_id='22222222-0000-0000-0000-000000000001'`)) === 1000 - 18, 'void returned beans incl. extra shot');
  ok((await sql(`select approved_by_name from refunds limit 1`)) === 'Manny Manager', 'approver recorded');

  // close shift
  await page.click('.nav-item[data-route="shift"]');
  await page.waitForSelector('#close-shift-btn');
  const expected = await page.textContent('.drawer-card .drow.total');
  ok(expected.includes('2,110.00'), 'expected cash = 2000 + 110 (voided sale excluded)');
  await page.click('#close-shift-btn');
  await page.fill('#cs-declared', '2110');
  await page.click('#cs-confirm');
  await page.waitForSelector('#sr-print');
  await until(async()=> (await sql(`select status from shifts limit 1`)) === 'CLOSED', 'shift closed on server');
  const sh = await sql(`select jsonb_build_object('st', status, 'v', cash_variance, 'n', transaction_count) from shifts limit 1`);
  ok(sh.st === 'CLOSED' && Number(sh.v) === 0 && sh.n === 1, 'shift closed, balanced, 1 transaction');
  ok((await sql(`select count(*) from audit_log`)) >= 6, 'audit log entries uploaded');

  ok(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log('FRONT OFFICE E2E PASSED');
})().catch(async e => { console.error(e); process.exit(1); });
