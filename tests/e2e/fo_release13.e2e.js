// front-office-dev checks for release 1.3 (counter): printer screen + fake Bluetooth printer,
// auto-print, drawer, partial / failed prints, manager drawer test + audit, stock check at
// payment (counter + QR), sold-out tiles, customer sort, retry without the reward, sub-category order.
// (adopted from front-office-dev's fo13_checks.js, 2026-11-02)
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_release13.e2e.js
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, ok, until, must, typePin} = H;
const NAME = 'fo13_checks';
const SIZES = {desk: [1280, 800], tab: [1024, 768], phone: [390, 844]};
const LATTE = '33333333-0000-0000-0000-000000000001', AMER = '33333333-0000-0000-0000-000000000003', MILK = '22222222-0000-0000-0000-000000000002';
execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', H.DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(__dirname, '..', 'sql', '21_seed_release12_fo.sql')], {stdio: 'ignore'});
const BIZ = sql(`select business_id from profiles where id = '00000000-0000-0000-0000-0000000000a1'`);

function fakeBluetooth(){
  const log = window.__ble = {writes: [], mode: 'ok', connects: 0, requests: 0, jobWrites: 0};
  const listeners = {};
  const netErr = (m) => Object.assign(new Error(m), {name: 'NetworkError'});
  let server;
  const device = window.__bleDevice = {
    id: 'dev-xp58', name: 'XP-58 Printer',
    addEventListener(t, fn){ (listeners[t] = listeners[t] || []).push(fn); },
    gatt: {
      connected: false,
      async connect(){ log.connects++; if(log.mode === 'down') throw netErr('GATT connection failed'); this.connected = true; return server; },
      disconnect(){ this.connected = false; },
    },
  };
  const ch = {
    uuid: '00002af1-0000-1000-8000-00805f9b34fb', properties: {write: true, writeWithoutResponse: true},
    async writeValueWithoutResponse(v){
      if(!device.gatt.connected) throw netErr('GATT Server is disconnected.');
      if(log.mode === 'partial' && log.jobWrites >= 2){
        device.gatt.connected = false; log.mode = 'down';
        (listeners.gattserverdisconnected || []).forEach(f => f());
        throw netErr('GATT Server is disconnected.');
      }
      log.writes.push(Array.from(v)); log.jobWrites++;
    },
  };
  const svc = {uuid: '000018f0-0000-1000-8000-00805f9b34fb', async getCharacteristics(){ return [ch]; }};
  server = {async getPrimaryServices(){ return [svc]; }, async getPrimaryService(){ return svc; }};
  Object.defineProperty(navigator, 'bluetooth', {configurable: true, value: {
    async getAvailability(){ return true; },
    async requestDevice(req){ log.requests++; log.lastReq = req; return device; },
    async getDevices(){ return [device]; },
  }});
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 800}, timezoneId: 'Asia/Manila', serviceWorkers: 'block'});
  await ctx.addInitScript(fakeBluetooth);
  const page = await ctx.newPage();
  const errors = []; const net = H.attach(page, errors, 'FO');
  let popups = 0;
  ctx.on('page', p => { if(p !== page){ popups++; p.waitForLoadState().then(() => p.close()).catch(() => {}); } });
  const rpc = []; page.on('request', r => { const u = r.url(); if(u.includes('/rest/v1/rpc/')) rpc.push({name: u.split('/rpc/')[1].split('?')[0], body: r.postData() || ''}); });
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  const shots = async (name, sizes) => {
    for(const s of (sizes || ['desk', 'tab', 'phone'])){ await page.setViewportSize({width: SIZES[s][0], height: SIZES[s][1]}); await page.waitForTimeout(350); await H.shot(page, `fo13-${name}-${s}`, {fullPage: false}); }
    await page.setViewportSize({width: 1280, height: 800}); await page.waitForTimeout(150);
  };
  const go = async (route) => { await page.click(`.nav-item[data-route="${route}"]`); await page.waitForTimeout(300); };
  const printed = () => page.evaluate(() => Printer.describe([].concat(...window.__ble.writes)));
  const resetBle = (mode) => page.evaluate((m) => { window.__ble.writes = []; window.__ble.jobWrites = 0; window.__ble.mode = m || 'ok'; }, mode);
  const sellCash = async () => { await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn'); };
  const tap = async (name) => { await page.click(`.pos-product-card:has-text("${name}")`); await page.waitForTimeout(150); };
  const pickLatte12 = async () => { await tap('Iced Latte'); await page.click('.mod-opt[data-opt="o-12"]'); await page.click('#mod-add'); await page.waitForTimeout(150); };
  const signIn = async (pin) => { await page.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(page, pin); await page.waitForSelector('#app', {state: 'visible'}); await page.waitForTimeout(400); };
  const lock = async () => { await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'}); };

  try{
    await H.pairCounter(page, 'TESTAB');
    await typePin(page, '1111');
    await H.startShift(page, 1000);

    /* ---------- A16: sub-category order ---------- */
    {
      const groups = await page.$$eval('.pos-group', gs => gs.map(g => g.dataset.group));
      const chips = await page.$$eval('.pos-cat-btn', bs => bs.map(b => b.dataset.cat));
      ok(JSON.stringify(groups) === JSON.stringify(['Hot', 'Iced', 'Non-coffee', 'Pastry', 'Rice meals', 'Add-ons']), 'A16: no order saved -> drinks A-Z, then pastry, food, then the rest', groups);
      ok(JSON.stringify(chips) === JSON.stringify(['ALL'].concat(groups)), 'A16: chips follow the same order', chips);
      sql(`update settings set subcategory_order = '["Rice meals","Iced","Pastry","Non-coffee","Hot"]'::jsonb where business_id = '${BIZ}'`);
      await page.evaluate(async () => { const d = await cloud.rpc('fo_bootstrap', {p_device_key: deviceKey()}); await applyBootstrap(d); navigatePOS('pos'); });
      await page.waitForTimeout(300);
      const g2 = await page.$$eval('.pos-group', gs => gs.map(g => g.dataset.group));
      ok(JSON.stringify(g2) === JSON.stringify(['Iced', 'Non-coffee', 'Hot', 'Pastry', 'Rice meals', 'Add-ons']), "A16: owner's order inside each block, drinks still first", g2);
      await shots('orders-subcat-order');
    }

    /* ---------- P1: printer status + screen ---------- */
    {
      const pill = await page.$eval('#printer-pill', b => ({cls: b.className, txt: b.textContent.trim()}));
      ok(/p-none/.test(pill.cls) && /not set up/i.test(pill.txt), 'P1: sidebar pill says "Printer not set up" at first', pill);
      await page.click('#printer-pill');
      await page.waitForSelector('#pr-ble');
      ok((await page.textContent('#topbar-title')) === 'Receipt printer', 'P1: printer screen opens from the sidebar pill');
      const s0 = await page.evaluate(() => ({w: document.querySelector('[data-seg="paper_width"] .active').dataset.v, peso: document.querySelector('[data-seg="peso_style"] .active').dataset.v,
        copies: document.querySelector('[data-seg="copies"] .active').dataset.v, auto: document.getElementById('pr-auto').checked, drawer: document.getElementById('pr-drawer').checked,
        drawerTest: !!document.getElementById('pr-test-drawer'), all: !!document.getElementById('pr-ble-all'), support: document.getElementById('pr-support').textContent}));
      ok(s0.w === '58' && s0.peso === 'P' && s0.copies === '1' && !s0.auto && !s0.drawer, 'P1: defaults 58 mm, P, 1 copy, auto-print off, drawer off', s0);
      ok(!s0.drawerTest, 'P1: cashier has no "test slip + open drawer" button', s0);
      ok(s0.all && /Bluetooth/.test(s0.support), 'P1: "Show all Bluetooth devices" + support text shown', s0);
      await shots('printer-not-set-up');
      await page.click('#pr-test');
      await page.waitForTimeout(300);
      ok(/Connect a Bluetooth printer/.test(await toasts()), 'P1: test slip before connecting -> plain message', await toasts());
      await page.click('#pr-ble');
      await must(() => page.evaluate(() => Printer.status().connected), 'printer connected');
      await page.waitForTimeout(300);
      const pill2 = await page.$eval('#printer-pill', b => ({cls: b.className, txt: b.textContent.trim()}));
      ok(/p-on/.test(pill2.cls) && /connected/i.test(pill2.txt), 'P1: pill turns "Printer connected"', pill2);
      ok(/XP-58 Printer/.test(await page.textContent('#pr-status')), 'P1: status card names the printer', await page.textContent('#pr-status'));
      const req = await page.evaluate(() => window.__ble.lastReq);
      ok(req && Array.isArray(req.filters) && req.filters.length > 3, 'P1: chooser filtered to receipt printers', req);
      await resetBle();
      await page.click('#pr-test');
      await must(async () => /printer works[\s\S]*\[CUT\]/.test(await printed()), 'test slip bytes');
      const slip = await printed();
      ok(/58 mm paper, 32 per line/.test(slip) && /\[CUT\]/.test(slip) && !/\[DRAWER\]/.test(slip), 'P1: test slip on 58 mm, cut, no drawer for a cashier', slip.slice(0, 200));
      await page.click('[data-seg="paper_width"] [data-v="80"]'); await page.waitForTimeout(150);
      ok(await page.evaluate(() => Printer.settings().paper_width) === 80, 'P1: 80 mm saved');
      await page.click('[data-seg="paper_width"] [data-v="58"]');
      await page.click('[data-seg="peso_style"] [data-v="PHP"]'); await page.waitForTimeout(150);
      ok(await page.evaluate(() => Printer.settings().peso_style) === 'PHP', 'P1: peso style saved');
      await page.click('[data-seg="peso_style"] [data-v="P"]');
      await page.click('label[for="pr-auto"]'); await page.waitForTimeout(150);
      ok(await page.evaluate(() => Printer.settings().auto_print) === true, 'P1: auto-print saved');
      ok(await page.$eval('#pr-drawer', i => i.disabled) && /Only a manager can change this/.test(await page.textContent('label[for="pr-drawer"]')), 'L2: cashier sees the drawer setting read-only');
      await page.click('[data-seg="copies"] [data-v="2"]'); await page.waitForTimeout(150); await page.click('[data-seg="copies"] [data-v="1"]'); await page.waitForTimeout(150);
      await must(() => Number(sql(`select count(*) from audit_log where action in ('Print receipt after each sale: on', 'Receipt copies changed')`)) >= 3, 'settings audit', 20000).catch(() => {});
      ok(Number(sql(`select count(*) from audit_log where action in ('Print receipt after each sale: on', 'Receipt copies changed')`)) >= 3, 'L2: auto-print and copies changes are audited');
      await shots('printer-connected');
    }

    /* ---------- auto-print after a sale, drawer ---------- */
    {
      await go('pos');
      await resetBle(); const pop0 = popups;
      await tap('Americano'); await sellCash();
      await must(async () => /Americano/.test(await printed()), 'auto-printed receipt');
      const r = await printed();
      ok(/1 x Americano\s+P110\.00/.test(r) && /TOTAL\s+P110\.00/.test(r) && !/\[DRAWER\]/.test(r) && !/Reprint/.test(r), 'P1: receipt printed by itself after the sale (58 mm, no drawer while the setting is off)', r.slice(0, 400));
      await page.waitForTimeout(500);
      ok(popups === pop0, 'P1: no print screen opened when the printer printed', popups - pop0);
      await page.evaluate(() => Printer.saveSettings({open_drawer_on_cash: true}));
      await resetBle();
      await tap('Americano'); await sellCash();
      await must(async () => /Americano/.test(await printed()), 'second receipt');
      ok(/^\[INIT\]\[DRAWER\]/.test(await printed()), 'P1: cash sale with the drawer setting -> drawer kick first');
      // GCash sale: no drawer
      await resetBle();
      await tap('Americano'); await page.click('#checkout-btn'); await page.click('[data-method="GCASH"]'); await page.check('#pay-confirmed'); await page.click('#complete-sale-btn');
      await must(async () => /Americano/.test(await printed()), 'gcash receipt');
      ok(!/\[DRAWER\]/.test(await printed()), 'P1: GCash sale -> no drawer kick');
      // auto-print off + direct printer: drawer only on cash, receipt by the button
      // 1.4 (lead-approved 2026-11-08): the barista ticket switch is on by default now; switch it off too, so this
      // check is still only about the receipt's auto-print setting
      await page.evaluate(() => Printer.saveSettings({auto_print: false, auto_print_ticket: false}));
      await resetBle(); const pop1 = popups;
      await tap('Americano'); await sellCash();
      await must(async () => /\[DRAWER\]/.test(await printed()), 'drawer kick only');
      ok(!/Americano/.test(await printed()), 'P1: auto-print off -> only the drawer opens, nothing printed', await printed());
      await page.waitForTimeout(400);
      ok(popups === pop1, 'P1: auto-print off with a printer -> no print screen either');
      await page.waitForSelector('#print-last');
      ok(/Print receipt/.test(await page.textContent('#print-last')), 'P1: empty order shows "Print receipt" for the last sale');
      await resetBle();
      await page.click('#print-last');
      await must(async () => /Americano/.test(await printed()), 'print-last receipt');
      ok(!/\[DRAWER\]/.test(await printed()) && !/Reprint/.test(await printed()), 'P1: "Print receipt" prints without the drawer and without "(Reprint)"');
      await H.shot(page, 'fo13-print-last-desk');
      // reprint from Sales
      await go('sales');
      await resetBle();
      await page.click('[data-reprint]');
      await must(async () => /Reprint/.test(await printed()), 'reprint');
      ok(!/\[DRAWER\]/.test(await printed()), 'P1: reprint is marked (Reprint), no drawer');
      await page.evaluate(() => Printer.saveSettings({auto_print: true, open_drawer_on_cash: true}));
    }

    /* ---------- partial and failed prints ---------- */
    {
      await go('pos');
      await resetBle('partial');
      await tap('Americano'); await sellCash();
      await page.waitForSelector('.modal h2:has-text("Printing stopped part-way")', {timeout: 15000});
      const btns = await page.$$eval('.modal-foot button', bs => bs.map(b => b.textContent.trim()));
      ok(btns.some(b => /Print again/.test(b)) && btns.some(b => /Use print screen/.test(b)), 'P1: part-way failure -> "Print again" + "Use print screen"', btns);
      ok(await page.evaluate(() => state.sales.filter(s => s.status === 'COMPLETED').length) >= 1, 'P1: the sale is saved even though printing stopped');
      await shots('print-partial');
      await page.evaluate(() => { window.__ble.mode = 'ok'; window.__ble.jobWrites = 0; window.__ble.writes = []; });
      await page.click('#pr-again');
      await must(async () => /THANK|Thank/i.test(await printed()), 'print again finished');
      const again = await printed();
      ok(/Americano/.test(again) && !/\[DRAWER\]/.test(again), 'P1: "Print again" prints the whole receipt, drawer not opened twice', again.slice(0, 120));
      // fails before any byte
      await page.evaluate(() => { window.__ble.mode = 'down'; window.__bleDevice.gatt.connected = false; window.__ble.writes = []; });
      const pop2 = popups;
      await tap('Americano'); await sellCash();
      await page.waitForSelector('.modal h2:has-text("The receipt did not print")', {timeout: 20000});
      ok(/Couldn.t reach the printer/.test(await page.textContent('.modal-body')), 'P1: failure before printing -> plain error', await page.textContent('.modal-body'));
      await page.waitForTimeout(300);
      ok(popups === pop2, 'P1: auto-print failure does not open the print screen by itself');
      await shots('print-failed', ['desk', 'phone']);
      await page.click('#pr-dialog');
      await until(() => popups > pop2, 5000);
      ok(popups === pop2 + 1, 'P1: "Use print screen" opens the print screen');
      await page.waitForTimeout(300);
      const pill = await page.$eval('#printer-pill', b => b.className);
      ok(/p-off/.test(pill), 'P1: pill shows not connected', pill);
      await page.evaluate(() => { window.__ble.mode = 'ok'; });
    }

    /* ---------- manager: test slip + drawer, audit ---------- */
    {
      await lock(); await signIn('222222');
      ok(!(await page.$('#print-last')) && (await page.evaluate(() => posState.lastSaleId)) === null, 'L3: lock clears "Print receipt" for the previous person');
      await page.click('#printer-pill'); await page.waitForSelector('#pr-test-drawer');
      ok(!(await page.$eval('#pr-drawer', i => i.disabled)), 'L2: manager can change the drawer setting');
      await page.click('label[for="pr-drawer"]'); await page.waitForTimeout(200); await page.click('label[for="pr-drawer"]');
      await must(() => Number(sql(`select count(*) from audit_log where action like 'Cash drawer on cash sales: %' and details like '%Manny Manager%'`)) === 2, 'drawer setting audit', 20000).catch(() => {});
      ok(Number(sql(`select count(*) from audit_log where action like 'Cash drawer on cash sales: %' and details like '%Manny Manager%'`)) === 2, 'L2: drawer setting changes audited with the manager name');
      await page.evaluate(() => Printer.reconnect());
      await resetBle();
      await page.click('#pr-test-drawer');
      await must(async () => /\[DRAWER\]/.test(await printed()), 'drawer test slip');
      ok(/^\[INIT\]\[DRAWER\]/.test(await printed()) && /Printer test/.test(await printed()), 'P1: manager test slip + drawer kick');
      await must(() => Number(sql(`select count(*) from audit_log where action = 'Cash drawer opened (test slip)' and actor_name = 'Manny Manager'`)) === 1, 'audit uploaded', 20000).catch(() => {});
      ok(Number(sql(`select count(*) from audit_log where action = 'Cash drawer opened (test slip)' and actor_name = 'Manny Manager'`)) === 1, 'P1: audit "Cash drawer opened (test slip)" with the manager name');
      await shots('printer-manager', ['desk']);
    }

    /* ---------- Q6: stock check at payment ---------- */
    {
      await go('pos');
      await page.evaluate(() => { clearCart(); renderCartPanel(); });
      // leave 100 mL of milk
      const milk = Number(sql(`select stock from v_ingredient_stock where ingredient_id = '${MILK}'`));
      sql(`insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, transaction_date) values (gen_random_uuid(), '${BIZ}', '${MILK}', 'ADJUSTMENT', ${100 - milk}, current_date)`);
      await page.evaluate(() => refreshStockQuietly());
      await page.waitForTimeout(300);
      const latteTile = await page.$eval(`.pos-product-card[data-recipe="${LATTE}"]`, b => b.className);
      ok(/unavailable/.test(latteTile), 'Q6: Iced Latte tile shows out of stock', latteTile);
      await tap('Iced Latte');
      await page.waitForTimeout(200);
      ok(!(await page.$('.modal')) && (await page.evaluate(() => posState.cart.length)) === 0, 'Q6: out-of-stock tile cannot be added');
      ok(/out of stock, so it can't be added \(needs 180 mL Milk, 100 mL left\)/.test(await toasts()), 'Q6: tap says what is short', await toasts());
      // put enough for 2 lattes (400 mL), add 3 + an Americano -> dialog
      sql(`insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, transaction_date) values (gen_random_uuid(), '${BIZ}', '${MILK}', 'ADJUSTMENT', 300, current_date)`);
      await page.evaluate(() => refreshStockQuietly());
      await page.waitForTimeout(300);
      await pickLatte12();
      await page.click('[data-inc]'); await page.click('[data-inc]');
      await tap('Americano');
      await page.click('#checkout-btn');
      await page.waitForSelector('.modal h2:has-text("Out of stock")');
      const rows = await page.$$eval('.stock-row', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
      ok(rows.length === 1 && /3 × Iced Latte/.test(rows[0]) && /needs 540 mL Milk, 400 mL left/.test(rows[0]), 'Q6: payment blocked; line + short ingredient listed', rows);
      ok(!!(await page.$('[data-stock-fit][data-qty="2"]')) && !!(await page.$('[data-stock-rm]')), 'Q6: "Make it 2" and "Remove" offered');
      ok(!(await page.$('#complete-sale-btn')), 'Q6: no payment screen while blocked');
      await shots('stock-problem');
      await page.click('[data-stock-fit]');
      await page.waitForSelector('#stock-pay');
      await page.click('#stock-pay');
      await page.waitForSelector('#complete-sale-btn');
      ok(/₱410\.00/.test(await page.textContent('.checkout-due')), 'Q6: after "Make it 2" -> payment screen with the new total (2x150 + 110)', await page.textContent('.checkout-due'));
      await page.click('[data-cancel]');
      // Remove path
      await page.evaluate(() => { posState.cart[0].quantity = 3; renderCartPanel(); });
      await page.click('#checkout-btn');
      await page.waitForSelector('[data-stock-rm]');
      await page.click('[data-stock-rm]');
      await page.waitForSelector('#stock-pay');
      ok((await page.evaluate(() => posState.cart.map(l => l.name).join(','))) === 'Americano', 'Q6: "Remove" takes the line off the order');
      await page.click('[data-cancel]');
      // offline note
      await page.evaluate(() => { posState.cart = []; renderCartPanel(); });
      await pickLatte12(); await page.click('[data-inc]'); await page.click('[data-inc]');
      await ctx.setOffline(true);
      await page.evaluate(() => cloud.select('qr_orders', {limit: 1}).catch(() => {}));
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.waitForTimeout(300);
      await page.click('#checkout-btn');
      await page.waitForSelector('.modal h2:has-text("Out of stock")');
      ok(/offline, so these stock numbers are from its last update/.test(await page.textContent('.modal-body')), 'Q6: offline -> same check with an out-of-date note');
      ok(!(await page.$('#stock-recheck')), 'Q6: no "Check stock again" offline');
      await page.click('[data-cancel]');
      await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.evaluate(() => cloud.rpc('fo_floor_plan', {}).catch(() => {}));
      await page.waitForTimeout(600);
      await page.evaluate(() => { clearCart(); renderCartPanel(); });
      // sold-out tile
      sql(`update recipes set sold_out = true where id = '${AMER}'`);
      await page.evaluate(() => { state.recipes.find(r => r.id === '33333333-0000-0000-0000-000000000003').sold_out = true; renderProductGrid(); });
      await tap('Americano');
      ok((await page.evaluate(() => posState.cart.length)) === 0 && !(await page.$('.modal')), 'Q6: sold-out tile cannot be added (no "Add anyway?")');
      ok(/Americano is sold out, so it can't be added/.test(await toasts()), 'Q6: sold-out tap explains plainly', await toasts());
      sql(`update recipes set sold_out = false where id = '${AMER}'`);
      await page.evaluate(() => { state.recipes.find(r => r.id === '33333333-0000-0000-0000-000000000003').sold_out = false; renderProductGrid(); });
      // QR order with 3 lattes (only 2 fit) -> warned at Take payment
      const qid = '99999999-0000-0000-0000-000000000031';
      sql(`insert into qr_orders(id, business_id, order_number, order_day, table_id, table_label, order_type, status, items, subtotal, tax_amount, service_charge_amount, total, customer_nickname, created_at, updated_at)
           values ('${qid}', '${BIZ}', 'Q-031', current_date, '77777777-0000-0000-0000-000000000001', 'T1', 'DINE_IN', 'PENDING',
           '[{"recipe_id":"${LATTE}","name":"Iced Latte","quantity":3,"unit_price":150,"modifiers":[{"group":"Size","label":"12oz","price_delta":0}]},{"recipe_id":"${AMER}","name":"Americano","quantity":1,"unit_price":110,"modifiers":[]}]',
           560, 0, 0, 560, 'Mika <i>', now(), now())`);
      await go('qr');
      await page.evaluate(() => pollQrOrders());
      await must(() => page.evaluate((i) => state.qrOrders.some(o => o.id === i), qid), 'QR order arrived');
      await page.evaluate(() => setQrView('list'));
      await page.waitForSelector(`[data-qr-act="PAY"][data-id="${qid}"]`);
      await page.click(`[data-qr-act="PAY"][data-id="${qid}"]`);
      await page.waitForSelector('.modal h2:has-text("Out of stock")');
      ok(/QR order Q-031/.test(await page.textContent('.modal-body')) && /Tell the customer/.test(await page.textContent('.modal-body')), 'Q6: QR order -> warned at Take payment, plain words');
      await shots('stock-problem-qr', ['desk', 'phone']);
      await page.click('[data-stock-fit]');
      await page.click('#stock-pay');
      await page.waitForSelector('#complete-sale-btn');
      await page.click('[data-quick]'); await page.click('#complete-sale-btn');
      await must(() => sql(`select count(*) from sales where qr_order_id = '${qid}'`) === '1', 'QR sale uploaded', 20000);
      const qs = H.one(`select grand_total::float g, coalesce(review_reason,'') rr from sales where qr_order_id = '${qid}'`);
      ok(qs.g === 410 && !/OUT_OF_STOCK/.test(qs.rr), 'Q6: QR sale saved with what was left (2 lattes + Americano = 410), not flagged out of stock', qs);
    }

    /* ---------- A17: customer sort ---------- */
    {
      await go('customers');
      await page.waitForSelector('#cust-sort');
      await page.waitForSelector('.cust-row');
      const lastBody = () => { const c = rpc.filter(x => x.name === 'fo_customer_list'); return c.length ? JSON.parse(c[c.length - 1].body) : {}; };
      ok(lastBody().p_sort === 'recent' && /active/.test(await page.$eval('#cust-sort [data-sort="recent"]', b => b.className)), 'A17: default "Most recent"', lastBody());
      const n0 = rpc.filter(x => x.name === 'fo_customer_list').length;
      await page.click('#cust-sort [data-sort="name"]');
      await must(() => lastBody().p_sort === 'name', 'name sort sent');
      await page.waitForTimeout(500);
      const names = await page.$$eval('.cust-row b', bs => bs.map(b => b.textContent));
      const sorted = names.slice().sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
      ok(JSON.stringify(names) === JSON.stringify(sorted), 'A17: Name (A–Z) list in order', names);
      await page.click('#cust-sort [data-sort="frequent"]');
      await must(() => lastBody().p_sort === 'frequent', 'frequent sort sent');
      await page.waitForTimeout(500);
      const f = await page.$$eval('.cust-row', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
      ok(/Rico/.test(f[0]) && /15 visits/.test(f[0]), 'A17: Most frequent -> Rico first with visit count', f);
      ok(f.some(t => /Zed <b>x<\/b>/.test(t)), 'A17: HTML nickname shown as text', f);
      await shots('customers-sort');
      await page.reload();
      await page.waitForFunction(() => document.getElementById('app').style.display !== 'none' || document.getElementById('pin-gate').style.display !== 'none');
      if(await page.isVisible('#pin-gate')) await signIn('222222'); else await page.waitForTimeout(500);
      await go('customers');
      await page.waitForSelector('#cust-sort .active');
      ok((await page.$eval('#cust-sort .active', b => b.dataset.sort)) === 'frequent', 'A17: choice remembered after reload');
      const calls1 = rpc.filter(x => x.name === 'fo_customer_list').length;
      await page.waitForTimeout(8000);
      ok(rpc.filter(x => x.name === 'fo_customer_list').length === calls1, 'A17: no polling of the customer list');
      ok(n0 >= 1, 'A17: list loaded once on open');
    }

    /* ---------- P2: retry without the reward ---------- */
    {
      await go('pos');
      await page.evaluate(() => { clearCart(); renderCartPanel(); });
      // a sale with a reward that the server refused (made here: cash sale, then turned into a refused reward sale)
      await ctx.setOffline(true);
      await page.evaluate(() => cloud.select('qr_orders', {limit: 1}).catch(() => {}));
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await tap('Americano'); await sellCash();
      await page.waitForTimeout(400);
      const fail = await page.evaluate(async () => {
        const ops = await LocalDB.outboxAll();
        const op = ops.filter(o => o.type === 'sale').pop();
        const d = JSON.parse(JSON.stringify(op.data));
        d.sale.customer_id = '88888888-0000-0000-0000-000000000001';
        d.sale.loyalty_reward = {customer_id: d.sale.customer_id, card_no: 1, milestone: 5, recipe_id: null};
        d.sale.loyalty_discount = 10; d.sale.grand_total = 100; d.payment.amount = 100; d.payment.tendered = 100; d.payment.change = 0;
        await LocalDB.outboxRemove([op.seq]);
        await LocalDB.failedAdd(Object.assign({}, op, {data: d, error: 'REWARD_NOT_AVAILABLE', failed_at: new Date().toISOString(), queued_at: new Date().toISOString()}));
        const s = state.sales.find(x => x.id === d.sale.id); Object.assign(s, d.sale);
        await Sync.refreshCounts();
        return {id: d.sale.id, no: d.sale.transaction_number, opId: op.op_id};
      });
      await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.evaluate(() => cloud.rpc('fo_floor_plan', {}).catch(() => {}));
      await page.waitForTimeout(800);
      // cashier: no button
      await lock(); await signIn('1111');
      await page.click('#sync-pill');
      await page.waitForSelector('.modal h2:has-text("Uploads that need attention")');
      ok(!(await page.$('[data-noreward]')) && /A manager can retry this sale without the stamp reward/.test(await page.textContent('.modal-body')), 'P2: cashier sees no button, only a note');
      await page.click('[data-close]');
      await lock(); await signIn('222222');
      await page.click('#sync-pill');
      await page.waitForSelector('[data-noreward]');
      await H.shot(page, 'fo13-failed-list-desk');
      await page.click('[data-noreward]');
      await page.waitForSelector('.modal h2:has-text("Retry without the reward")');
      const txt = (await page.textContent('.modal-body')).replace(/\s+/g, ' ');
      ok(/saved at full price ₱110\.00\. The customer paid ₱100\.00, so it will be marked for the owner to review\./.test(txt), 'P2: confirm in plain words with full price + paid', txt);
      await shots('retry-no-reward');
      await page.click('[data-ok]');
      await must(() => sql(`select count(*) from sales where id = '${fail.id}'`) === '1', 'retried sale uploaded', 20000);
      const s = H.one(`select grand_total::float g, loyalty_discount::float l, coalesce(review_reason,'') rr, needs_review nr, (select amount::float from payments where sale_id = '${fail.id}') paid,
        (select count(*) from loyalty_redemptions where sale_id = '${fail.id}') red from sales where id = '${fail.id}'`);
      ok(s.g === 110 && s.l === 0 && s.paid === 100 && s.red === 0, 'P2: saved at full price, no reward, the real payment', s);
      ok(s.nr === true && /PAYMENT_MISMATCH/.test(s.rr), 'P2: flagged for review (payment less than the total)', s);
      const opIds = sql(`select count(*) from sync_operations where operation_id = '${fail.opId}'`);
      ok(opIds === '0', 'P2: a new upload id was used (the refused one never reached the server here)', opIds);
      ok(Number(sql(`select count(*) from audit_log where action = 'Sale retried without the stamp reward'`)) === 1, 'P2: audit entry');
      ok((await page.evaluate(() => LocalDB.failedAll())).length === 0, 'P2: removed from the failed list');
    }

    ok(errors.length === 0, 'no browser errors', errors);
  }catch(e){ H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})();
