// Release 1.4 counter checks (adopted from front-office-dev's fo14.e2e.js, 2026-11-03): library groups, required groups, swap,
// cups/lids offline, waste log online/offline, complimentary approvals, failed+retry, reload, screenshots.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]   (this test applies tests/sql/22_seed_release14_fo.sql)
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_release14.e2e.js
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const BASE = 'http://localhost:' + (process.env.FAKE_PORT || 8787);
const SHOTS = require('path').join(process.env.QA_SHOTS || require('path').join(require('os').tmpdir(), 'cccc-qa-shots'), 'fo14');
require('fs').mkdirSync(SHOTS, {recursive: true});
async function sql(q){ const r = await fetch(BASE + '/__sql', {method:'POST', body: `select to_jsonb((${q}))`}); const t = await r.text(); if(!r.ok) throw new Error(t); return JSON.parse(t); }
let checks = 0, failed = 0;
const { execFileSync } = require('child_process');
function psql(q){ return execFileSync('psql', ['-h','/tmp','-p','54329','-U','postgres','-d', process.env.FAKE_DB || 'cccc','-Atqc', q]).toString(); }
execFileSync('psql', ['-h','/tmp','-p','54329','-U','postgres','-d', process.env.FAKE_DB || 'cccc','-q','-v','ON_ERROR_STOP=1','-f', require('path').join(__dirname, '..', 'sql', '22_seed_release14_fo.sql')], {stdio: 'ignore'});
function ok(c, m, extra){ checks++; if(!c){ failed++; console.log('FAIL ' + m + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); } else console.log('ok   ' + m); }
async function until(fn, ms){ const end = Date.now() + (ms||20000); while(Date.now() < end){ try{ if(await fn()) return true; }catch(e){} await new Promise(r=>setTimeout(r, 300)); } return false; }
async function typePin(page, pin){ for(const d of pin) await page.click(`#pin-pad button[data-k="${d}"]`); if(pin.length < 6) await page.click('#pin-enter'); }
const ING = {beans:'22222222-0000-0000-0000-000000000001', milk:'22222222-0000-0000-0000-000000000002', oat:'22222222-0000-0000-0000-0000000000a1', cup:'22222222-0000-0000-0000-0000000000a2', lid:'22222222-0000-0000-0000-0000000000a3'};
const LATTE = '33333333-0000-0000-0000-000000000001';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if(m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(m.text())) errors.push(m.text()); });
  ctx.on('page', p => { p.waitForLoadState().then(()=>p.close()).catch(()=>{}); });
  const goOffline = async () => { await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); };
  const goOnline = async () => { await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await page.evaluate(() => Sync.run()).catch(()=>{}); };
  const stock = async () => page.evaluate((ids) => Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, Math.round((Number(state.stock[id])||0)*1000)/1000])), ING);
  const outbox = async () => page.evaluate(() => LocalDB.outboxCount());
  const lastToast = async () => page.evaluate(() => { const t = [...document.querySelectorAll('#toast-wrap .toast')]; return t.length ? t[t.length-1].textContent : ''; });
  const shot = async (name) => { await page.screenshot({path: `${SHOTS}/${name}.png`}); };

  try{
    await page.goto(BASE + '/cccc/front/');
    await page.waitForSelector('#su-code', {timeout: 15000});
    await page.fill('#su-code', 'testab'); await page.click('#su-pair');
    await page.waitForSelector('#pin-gate', {state: 'visible', timeout: 20000});
    await typePin(page, '1111');
    await page.waitForSelector('#ss-opening-cash', {timeout: 15000});
    await page.fill('#ss-opening-cash', '1000'); await page.click('#ss-start-btn');
    await page.waitForSelector('.pos-product-card');
    ok(await page.isVisible('#waste-btn'), 'Orders screen has a "Log waste" button');

    // ---- 1. library groups + required group + swap price
    await page.click('.pos-product-card:has-text("Iced Latte")');
    await page.waitForSelector('.mod-opt');
    const groupNames = await page.$$eval('.mod-group-title > span:first-child', ns => ns.map(n => n.textContent.trim()));
    ok(groupNames[0].startsWith('Hot / Iced') && groupNames[1].startsWith('Milk') && groupNames.some(n => n.startsWith('Size')), 'library groups shown before own groups', groupNames);
    ok(/Swap.*Oat milk.*\+₱30/.test(await page.textContent('.mod-opt[data-opt="oat"]')), 'swap option shows "Swap" and its price', await page.textContent('.mod-opt[data-opt="oat"]'));
    await page.click('#mod-add');
    await page.waitForTimeout(200);
    const miss = await page.textContent('#mod-missing');
    ok(/Choose Hot \/ Iced and Size first/.test(miss) && (await page.$$('.mod-group-missing')).length === 2, 'Add without required groups: plain message, both groups marked', miss);
    ok((await page.evaluate(() => posState.cart.length)) === 0, 'nothing added while required groups are missing');
    await shot('sheet-required-1280');
    await page.click('.mod-opt[data-opt="iced"]'); await page.click('.mod-opt[data-opt="o-12"]'); await page.click('.mod-opt[data-opt="oat"]');
    ok((await page.textContent('#mod-total-price')).includes('190'), 'price 150 + iced 10 + oat 30 = 190');
    ok(await page.isHidden('#mod-missing'), 'message clears once chosen');
    await shot('sheet-chosen-1280');
    await page.click('#mod-add');
    const line = await page.evaluate(() => posState.cart[0]);
    const iced = line.modifiers.find(m => m.label === 'Iced'), oat = line.modifiers.find(m => m.label === 'Oat milk');
    ok(iced && iced.extras.length === 2 && oat && oat.kind === 'SWAP' && oat.removes[0].ingredient_id === ING.milk && oat.removes[0].quantity === 180 && oat.ingredient_id === null, 'cart keeps the modifierFromOption snapshot (cup + lid extras, swap removes)', line.modifiers);
    ok(line.unit_price === 190, 'cart line price 190');

    // Americano: Hot/Iced unticked, no milk -> no options at all
    await page.click('.pos-product-card:has-text("Americano")');
    await page.waitForTimeout(300);
    ok(!(await page.$('.modal .mod-opt')) && (await page.evaluate(() => posState.cart.length)) === 2, 'Americano (group unticked, no milk to swap) goes straight to the cart');
    await page.click('[data-remove]:right-of(:text("Americano"))').catch(async () => { await page.evaluate(() => { posState.cart = posState.cart.filter(l => l.name !== 'Americano'); renderCartPanel(); }); });
    await page.evaluate(() => { posState.cart = posState.cart.filter(l => l.name !== 'Americano'); renderCartPanel(); });

    // ---- 2. sale offline: cups, lids and swap deducted locally; server matches after upload
    const s0 = await stock();
    await goOffline();
    await page.click('#checkout-btn');
    await page.fill('#cash-tendered', '200');
    await page.click('#complete-sale-btn');
    await until(async () => (await page.evaluate(() => posState.cart.length)) === 0, 5000);
    const s1 = await stock();
    ok(s0.cup - s1.cup === 1 && s0.lid - s1.lid === 1 && s0.oat - s1.oat === 180 && s0.milk === s1.milk && s0.beans - s1.beans === 18, 'offline sale: cup 1, lid 1, oat 180 mL, beans 18 g off; dairy milk untouched', {s0, s1});
    await goOnline();
    ok(await until(async () => (await sql(`select count(*) from sales where status='COMPLETED'`)) === 1, 20000), 'offline sale uploaded');
    const srv = await sql(`select jsonb_object_agg(ingredient_id, q) from (select ingredient_id, sum(quantity) q from inventory_transactions where transaction_type='SALE_USAGE' group by 1) x`);
    const exp = await sql(`select jsonb_object_agg(l->>'ingredient_id', (l->>'quantity')::numeric) from jsonb_array_elements(public._recipe_stock_lines((select business_id from recipes where id='${LATTE}'), '${LATTE}', 1, (select modifiers from sale_items limit 1))) l`);
    ok(JSON.stringify(Object.keys(srv).sort().map(k => [k, Number(srv[k])])) === JSON.stringify(Object.keys(exp).sort().map(k => [k, Number(exp[k])])), "sale's stock lines = the server's own _recipe_stock_lines for those options", {srv, exp});
    ok((await sql(`select grand_total from sales limit 1`)) === 190 && (await sql(`select coalesce(needs_review,false) from sales limit 1`)) === false, 'server accepted the price 190 (no review flag)');

    // ---- 3. cups out of stock -> Iced option marked, can't be added
    psql(`insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) select business_id, id, 'WASTE', 49, current_date from ingredients where id='${ING.cup}'`);
    await page.evaluate(() => refreshStockQuietly());
    await page.click('.pos-product-card:has-text("Iced Latte")');
    await page.waitForSelector('.mod-opt');
    ok(/Out of stock/.test(await page.textContent('.mod-opt[data-opt="iced"]')) && !/Out of stock/.test(await page.textContent('.mod-opt[data-opt="hot"]')), 'no cups left: "Iced" marked out of stock, "Hot" not');
    await page.click('.mod-opt[data-opt="iced"]'); await page.click('.mod-opt[data-opt="o-12"]'); await page.click('#mod-add');
    await page.waitForTimeout(200);
    ok((await page.evaluate(() => posState.cart.length)) === 0 && /can't be added/.test(await lastToast()), 'iced can\'t be added with no cups', await lastToast());
    await page.click('.mod-opt[data-opt="hot"]'); await page.click('#mod-add');
    ok((await page.evaluate(() => posState.cart.length)) === 1, 'hot one is still sold');
    await page.evaluate(() => { clearCart(); renderCartPanel(); });
    psql(`insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) select business_id, id, 'PURCHASE', 49, current_date from ingredients where id='${ING.cup}'`);
    await page.evaluate(() => refreshStockQuietly());

    // ---- 4. waste as a cashier, OFFLINE: menu item with options + an ingredient in another unit
    await goOffline();
    const w0 = await stock();
    await page.click('#waste-btn');
    await page.waitForSelector('#waste-add-menu');
    ok(!(await page.$('#waste-cost')), 'cashier: no cost preview');
    await page.click('#waste-add-menu');
    await page.click(`[data-wrec="${LATTE}"]`);
    await page.waitForSelector('.mod-opt');
    await page.click('#mod-add');
    await page.waitForTimeout(150);
    ok(/Choose Hot \/ Iced and Size first/.test(await page.textContent('#mod-missing')), 'waste sheet also enforces required groups');
    await page.click('.mod-opt[data-opt="iced"]'); await page.click('.mod-opt[data-opt="o-16"]'); await page.click('#mod-qty-plus');
    await page.click('#mod-add');
    await page.waitForSelector('#waste-add-ing');
    await page.click('#waste-add-ing');
    const ingList = await page.$$eval('[data-wing]', bs => bs.map(b => b.dataset.wing));
    ok(ingList.includes(ING.milk) && ingList.includes(ING.cup), 'ingredient picker lists stock items');
    await page.click(`[data-wing="${ING.milk}"]`);
    await page.waitForSelector('[data-wqty="1"]');
    await page.fill('[data-wqty="1"]', '0.5'); await page.selectOption('[data-wunit="1"]', 'L');
    // reload keeps the draft
    await page.reload(); await page.waitForFunction(() => document.getElementById('app').style.display === 'flex' || document.getElementById('pin-gate').style.display === 'flex', null, {timeout: 20000}); if(!(await page.isVisible('#app'))){ await typePin(page, '1111'); }
    await page.waitForSelector('#waste-btn'); await page.click('#waste-btn'); await page.waitForSelector('.waste-line');
    ok((await page.$$('.waste-line')).length === 2 && (await page.inputValue('[data-wqty="1"]')) === '0.5', 'draft survives a reload (offline)');
    await page.click('[data-reason="OTHER"]'); await page.click('#waste-save'); await page.waitForTimeout(200);
    ok(/note/i.test(await lastToast()) && (await outbox()) === 0, '"Other" without a note is refused with plain words', await lastToast());
    await page.click('[data-reason="SPILLAGE"]');
    await shot('waste-cashier-1280');
    await page.click('#waste-save');
    await until(async () => !(await page.$('#waste-save')), 4000);
    const w1 = await stock();
    ok(w0.beans - w1.beans === 36 && w0.milk - w1.milk === 2*240 + 500 && w0.cup - w1.cup === 2 && w0.lid - w1.lid === 2, 'offline waste taken off this counter\'s stock (2 iced 16oz + 0.5 L milk)', {w0, w1});
    ok((await page.evaluate(() => LocalDB.outboxAll().then(l => l.filter(o => o.type === 'waste').length))) === 1, 'waste queued as fo_sync op "waste"');
    // complimentary as a cashier offline: no approval possible
    await page.click('#waste-btn'); await page.click('#waste-add-ing'); await page.click(`[data-wing="${ING.beans}"]`);
    await page.fill('[data-wqty="0"]', '20'); await page.click('[data-reason="COMPLIMENTARY"]');
    ok(/needs internet/.test(await page.textContent('#waste-approval-note')), 'cashier offline: Complimentary says approval needs internet');
    const ob = await outbox();
    await page.click('#waste-save'); await page.waitForTimeout(400);
    ok((await outbox()) === ob && !(await page.isVisible('#pin-gate')), 'cashier offline: complimentary not queued, no PIN pad');
    await goOnline();
    ok(await until(async () => (await sql(`select count(*) from waste_logs`)) === 1, 20000), 'offline waste uploaded');
    const wl = await sql(`select jsonb_build_object('reason', reason, 'staff', staff_name, 'review', needs_review, 'lines', (select jsonb_object_agg(ingredient_id, q) from (select ingredient_id, sum(quantity) q from inventory_transactions where transaction_type='WASTE' and reference_id = w.id::text group by 1) x)) from waste_logs w`);
    ok(wl.reason === 'SPILLAGE' && wl.staff === 'Cathy Cashier' && wl.review === false && Number(wl.lines[ING.beans]) === 36 && Number(wl.lines[ING.milk]) === 980 && Number(wl.lines[ING.cup]) === 2 && Number(wl.lines[ING.lid]) === 2, 'server waste matches the counter (stock lines, reason, staff, not flagged)', wl);
    const sStock = await sql(`select jsonb_object_agg(ingredient_id, stock) from v_ingredient_stock`);
    await page.evaluate(() => refreshStockQuietly()); const w2 = await stock();
    ok(Math.abs(Number(sStock[ING.milk]) - w2.milk) < 0.001 && Math.abs(Number(sStock[ING.cup]) - w2.cup) < 0.001, 'counter stock = server stock after refresh');

    // ---- 5. complimentary as a cashier ONLINE: manager PIN on the pad
    await page.waitForTimeout(500);
    ok((await page.$$('.waste-line')).length === 1 && /Espresso/.test(await page.textContent('.waste-line')), 'refused complimentary entry is still there to log later');
    ok(/manager enters their PIN/.test(await page.textContent('#waste-approval-note')), 'online: says a manager will enter their PIN');
    await page.click('#waste-save');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '111111'.slice(0,4)); await page.waitForTimeout(800);
    ok(/manager/i.test(await page.textContent('#pin-error')), 'cashier PIN cannot approve complimentary', await page.textContent('#pin-error'));
    await typePin(page, '222222');
    ok(await until(async () => (await sql(`select count(*) from waste_logs where reason='COMPLIMENTARY'`)) === 1, 20000), 'complimentary uploaded');
    ok((await sql(`select approved_by_name from waste_logs where reason='COMPLIMENTARY'`)) === 'Manny Manager', 'server recorded Manny as approver');
    ok(await until(async () => (await sql(`select count(*) from audit_log where action='Waste logged'`)) === 2, 15000), 'audit entries "Waste logged" uploaded');

    // ---- 6. manager signed in, OFFLINE complimentary with their own sign-in; cost preview shown to managers
    await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(page, '222222');
    await page.waitForSelector('#waste-btn', {timeout: 15000});
    await goOffline();
    await page.click('#waste-btn'); await page.click('#waste-add-menu'); await page.click(`[data-wrec="${LATTE}"]`);
    await page.click('.mod-opt[data-opt="hot"]'); await page.click('.mod-opt[data-opt="o-12"]'); await page.click('.mod-opt[data-opt="oat"]'); await page.click('#mod-add');
    await page.waitForSelector('#waste-cost');
    await page.click('[data-reason="COMPLIMENTARY"]');
    ok(/approve this yourself/.test(await page.textContent('#waste-approval-note')), 'manager offline: approves own complimentary');
    const costTxt = await page.textContent('#waste-cost');
    ok(costTxt.length > 0, 'manager sees the cost line', costTxt);
    await shot('waste-manager-1280');
    await page.click('#waste-save'); await page.waitForTimeout(400);
    ok(!(await page.isVisible('#pin-gate')), 'no PIN pad for the signed-in manager');

    // ---- 7. failed upload + retry reuses the same data: menu changed while offline
    await page.click('#waste-btn'); await page.click('#waste-add-menu'); await page.click(`[data-wrec="${LATTE}"]`);
    await page.click('.mod-opt[data-opt="iced"]'); await page.click('.mod-opt[data-opt="o-12"]'); await page.click('#mod-add');
    await page.waitForSelector('[data-reason="CALIBRATION"]'); await page.click('[data-reason="CALIBRATION"]'); await page.click('#waste-save'); await page.waitForTimeout(300);
    const calId = await page.evaluate(() => LocalDB.outboxAll().then(l => l.filter(o => o.type === 'waste').pop().data.id));
    psql(`update option_groups set options = jsonb_set(options, '{1,id}', '"iced2"') where id='88888888-0000-0000-0000-000000000001'`);
    await goOnline();
    ok(await until(async () => (await sql(`select count(*) from waste_logs where reason='COMPLIMENTARY'`)) === 2, 20000), 'manager\'s offline complimentary accepted with own sign-in');
    ok((await sql(`select approved_by_name from waste_logs where reason='COMPLIMENTARY' order by logged_at desc limit 1`)) === 'Manny Manager', '... approver recorded');
    ok(await until(async () => (await page.evaluate(() => LocalDB.failedAll().then(l => l.length))) === 1, 15000), 'waste with an option no longer on the menu fails (BAD_WASTE)');
    await page.click('#sync-pill'); await page.waitForSelector('[data-retry]');
    const row = await page.textContent('.modal tbody tr');
    ok(/Waste log/.test(row) && /no longer on the menu/.test(row), 'failed list: "Waste log" with plain words', row);
    await shot('failed-waste-1280');
    psql(`update option_groups set options = jsonb_set(options, '{1,id}', '"iced"') where id='88888888-0000-0000-0000-000000000001'`);
    await page.click('[data-retry]');
    ok(await until(async () => (await sql(`select count(*) from waste_logs where id='${calId}'`)) === 1, 20000), 'retry reuses the same waste id and is accepted');

    // ---- 8. shift summary
    await page.click('.nav-item[data-route="shift"]');
    await page.waitForSelector('.waste-summary');
    const ws = await page.textContent('.waste-summary');
    ok(/4 \(5 lines\)/.test(ws) && /Complimentary\s*2/.test(ws) && /Cost/.test(ws), 'Shift & cash shows waste count, by reason, and cost line for a manager', ws);
    ok(await page.isVisible('#shift-waste-btn'), 'Shift & cash also has Log waste');
    await shot('shift-1280');

    // ---- screenshots at 1024 and 390
    for(const [w, h] of [[1024, 768], [390, 844]]){
      await page.setViewportSize({width: w, height: h});
      await page.click('.nav-item[data-route="shift"]'); await page.waitForSelector('.waste-summary'); await shot(`shift-${w}`);
      await page.click('.nav-item[data-route="pos"]'); await page.waitForSelector('#waste-btn'); await shot(`orders-${w}`);
      await page.click('.pos-product-card:has-text("Iced Latte")'); await page.waitForSelector('.mod-opt'); await page.click('#mod-add'); await page.waitForTimeout(150); await shot(`sheet-${w}`);
      await page.click('[data-cancel]');
      await page.click('#waste-btn'); await page.click('#waste-add-ing'); await page.click(`[data-wing="${ING.milk}"]`);
      await page.click('[data-reason="COMPLIMENTARY"]'); await page.waitForTimeout(150); await shot(`waste-${w}`);
      await page.click('#waste-add-menu'); await page.waitForTimeout(150); await shot(`waste-pick-${w}`);
      await page.click('[data-back]'); await page.click('#waste-clear'); await page.click('.modal [data-ok]');
    }
  }catch(e){ failed++; console.log('FAIL (stopped) ' + String(e.message || e).split('\n')[0]); await shot('stopped'); }
  ok(!errors.length, 'no browser errors', errors);
  console.log(`SUMMARY fo14: ${checks} checks, ${failed} failed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
