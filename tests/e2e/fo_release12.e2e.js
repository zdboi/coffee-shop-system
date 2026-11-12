// Release 1.2 counter checks (adopted from front-office-dev's fo12_checks.js): menu grouped by sub-category,
// tile colours, Customers tab (cashier: no money / manager: money with the LOGIN token), stamp rewards
// (₱10 off, free item -> ₱0 sale with no payment step, hold drops the reward, half-quantity line not offered,
// offline reward from the saved card, REWARD_NOT_AVAILABLE in plain words), Customers offline message,
// QR floor plan (table colours by state, accept from a table, list view), erased/merged customer's saved card deleted
// (NOT_FOUND), saved cards dropped after 30 days, offline rewards only from copies under 48 hours old, neutral ₱0 wording
// + payment reference "Nothing to pay", lock clears the Customers view, no browser errors.
// Screenshots at 1280x800, 1024x768 (tablet) and 390x844 in $QA_SHOTS (fo12-*.png).
// Needs a fresh seed + the 1.2 counter seed (this test applies tests/sql/21_seed_release12_fo.sql itself):
//   tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
//   FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_release12.e2e.js
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, ok, until, must, typePin} = H;
const NAME = 'fo_release12.e2e';
const SIZES = {desk: [1280, 800], tab: [1024, 768], phone: [390, 844]};
const MIKA = '88888888-0000-0000-0000-000000000001', RICO = '88888888-0000-0000-0000-000000000002', PAOLO = '88888888-0000-0000-0000-000000000003';
execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', H.DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(__dirname, '..', 'sql', '21_seed_release12_fo.sql')], {stdio: 'ignore'});
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 800}});
  const page = await ctx.newPage();
  const errors = []; const net = H.attach(page, errors, 'FO');
  ctx.on('page', p => { if(p !== page) p.waitForLoadState().then(() => p.close()).catch(() => {}); });
  const rpc = []; page.on('request', r => { const u = r.url(); if(u.includes('/rest/v1/rpc/')) rpc.push({name: u.split('/rpc/')[1].split('?')[0], body: r.postData() || ''}); });
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  const shots = async (name, sizes) => {
    for(const s of (sizes || ['desk', 'tab', 'phone'])){ await page.setViewportSize({width: SIZES[s][0], height: SIZES[s][1]}); await page.waitForTimeout(350); await H.shot(page, `fo12-${name}-${s}`); }
    await page.setViewportSize({width: 1280, height: 800}); await page.waitForTimeout(150);
  };
  const cartTotal = async () => H.money(await page.textContent('.pos-cart-summary .total'));
  const go = async (route) => { await page.click(`.nav-item[data-route="${route}"]`); await page.waitForTimeout(250); };
  const sellCash = async () => { await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn'); };

  await page.goto(H.BASE + '/cccc/front/');
  await page.waitForSelector('#su-code');
  await page.fill('#su-code', 'TESTAB'); await page.click('#su-pair');
  await page.waitForSelector('#pin-gate', {state: 'visible'});
  ok(await page.$('#pin-title img.pin-wordmark[alt="Cavite City Coffee Club"]'), 'PIN card title is the cream wordmark image (alt = shop name)');
  await shots('01-pin');
  await typePin(page, '1111');
  await H.startShift(page, 1000);

  // ---- sidebar / nav
  const side = await page.evaluate(() => ({wm: !!document.querySelector('#sidebar .brand img.wm[src*="wordmark-dark"]'), mark: !!document.querySelector('#sidebar .brand img.mark'),
    typed: document.querySelector('#sidebar .brand').textContent.includes('Cavite'), nav: [...document.querySelectorAll('#nav .nav-item .label')].map(n => n.textContent.trim()),
    svg: document.querySelectorAll('#nav .nav-item svg').length, title: document.getElementById('topbar-title').textContent}));
  ok(side.wm && side.mark && !side.typed, 'sidebar: tile icon + dark wordmark image, shop name not typed', side);
  ok(JSON.stringify(side.nav) === JSON.stringify(['Orders', 'QR orders', 'Customers', 'Sales', 'Shift & cash']) && side.svg === 5, 'nav: Orders, QR orders, Customers, Sales, Shift & cash with line icons', side.nav);
  ok(side.title === 'Orders', 'route title "Orders"', side.title);
  const emoji = await page.evaluate(() => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(document.getElementById('app').innerText));
  ok(!emoji, 'no emoji on the Orders screen');

  // ---- grouping + tile colours
  const groups = await page.$$eval('.pos-group', gs => gs.map(g => ({name: g.dataset.group, head: g.querySelector('.pos-group-title').textContent, count: g.querySelector('.pos-group-count').textContent,
    items: [...g.querySelectorAll('.pname')].map(x => x.textContent), bg: getComputedStyle(g.querySelector('.pos-product-card')).backgroundColor, font: getComputedStyle(g.querySelector('.pos-group-title')).fontFamily})));
  ok(JSON.stringify(groups.map(g => g.name)) === JSON.stringify(['Hot', 'Iced', 'Non-coffee', 'Pastry', 'Rice meals', 'Add-ons']), 'All: groups by sub-category, drinks first, then pastry, food, the rest (1.3 A16, lead-approved 2026-11-02)', groups.map(g => g.name));
  const hot = groups.find(g => g.name === 'Hot');
  ok(JSON.stringify(hot.items) === JSON.stringify(['Americano', 'Cappuccino', 'Spanish Latte']) && hot.count === '3 items', 'Hot: sort_order then name, "3 items"', hot);
  ok(/Brunson/.test(hot.font), 'group headings in Brunson', hot.font);
  const col = Object.fromEntries(groups.map(g => [g.name, g.bg]));
  ok(col.Iced === 'rgb(181, 67, 43)' && col.Hot === 'rgb(90, 58, 42)' && col.Pastry === 'rgb(241, 228, 179)' && col['Non-coffee'] === 'rgb(185, 196, 160)', 'tile colours per sub-category (terracotta / cocoa / butter / sage)', col);
  ok(col['Add-ons'] === 'rgb(255, 253, 248)', 'no colour set -> card style', col['Add-ons']);
  const chip = await page.evaluate(() => { const a = document.querySelector('.pos-cat-btn.active'); const s = getComputedStyle(a); return [a.textContent, s.backgroundColor, a.getBoundingClientRect().height]; });
  ok(chip[0] === 'All' && chip[1] === 'rgb(31, 27, 25)' && chip[2] >= 48, 'active chip = ink, 48px tall', chip);
  const minTile = await page.$$eval('.pos-product-card, .pos-cat-btn, #cust-add, .btn-checkout, .btn-hold', els => Math.min(...els.map(e => e.getBoundingClientRect().height)));
  ok(minTile >= 48, 'Orders tap targets at least 48 px', minTile);
  await page.click('.pos-cat-btn[data-cat="Iced"]');
  ok(JSON.stringify(await page.$$eval('.pos-group', gs => gs.map(g => g.dataset.group))) === '["Iced"]', 'one chip -> only that group');
  await page.click('.pos-cat-btn[data-cat="ALL"]');
  await page.fill('#pos-search', 'latte');
  const sres = await page.$$eval('.pos-group', gs => gs.map(g => g.dataset.group + ':' + [...g.querySelectorAll('.pname')].map(x => x.textContent).join('+')));
  ok(JSON.stringify(sres) === JSON.stringify(['Hot:Spanish Latte', 'Iced:Iced Latte', 'Non-coffee:Matcha Latte']), 'search "latte" still grouped', sres);
  await page.fill('#pos-search', '');
  await shots('02-orders-all');

  // ---- Customers as CASHIER (no money)
  await go('customers');
  await page.waitForSelector('.cust-row');
  const list = await page.$$eval('.cust-row', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
  ok(list.some(t => /Mika ?0917 ••• 4567 · last visit (yesterday|2 days ago)/.test(t)), 'list: nickname, masked phone, last visit', list);
  // 1.5 (owner decision B6): 'Zed <b>x</b>' has no phone number, so it is under "Archived", not in the main list
  ok(!list.some(t => t.includes('Zed')), '1.5: the customer without a phone is not in the main list', list);
  await page.click('#cust-which [data-arch="1"]'); await page.waitForTimeout(900);
  const archList = await page.$$eval('.cust-row', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
  ok(archList.some(t => t.includes('Zed <b>x</b>')) && !(await page.$('.cust-row b b')), 'nickname with HTML shown as text (Archived list)', archList);
  await page.click('#cust-which [data-arch="0"]'); await page.waitForTimeout(900);
  const lastList = rpc.filter(r => r.name === 'fo_customer_list').pop();
  ok(lastList && JSON.parse(lastList.body).p_staff_token === null, 'cashier: no staff token sent');
  await page.click(`.cust-row[data-cust="${RICO}"]`);
  await page.waitForSelector('#cust-spent');
  const det = await page.evaluate(() => ({spent: document.getElementById('cust-spent').textContent.replace(/\s+/g, ' '), body: document.getElementById('cust-detail').innerText,
    locks: document.querySelectorAll('.cust-orders .lock-cell').length, rows: document.querySelectorAll('.cust-orders tbody tr').length, cells: document.querySelectorAll('.card15 .s15').length,
    filled: document.querySelectorAll('.card15 .s15.d').length, ready: document.querySelectorAll('.rw .rtag.ready').length}));
  ok(/Managers only/.test(det.spent) && !/₱/.test(det.spent), 'cashier: total spent = "Managers only", no amount', det.spent);
  ok(det.locks === det.rows && det.rows > 0 && !/₱\d/.test(det.body.split('Recent orders')[1] || ''), 'cashier: order totals locked, no peso amounts in recent orders', det);
  ok(det.cells === 15 && det.filled === 15 && det.ready === 3, 'Rico: 15-stamp card full, 3 rewards ready', det);
  ok(/VISITS\s*15/i.test(det.body) && /Americano/.test(det.body), 'visits 15, favourites / orders listed', det.body.slice(0, 200));
  await page.click(`.cust-row[data-cust="${MIKA}"]`);
  await page.waitForFunction(() => /7 \/ 15/.test(document.getElementById('cust-detail').innerText));
  await shots('03-customers-cashier');

  // ---- rewards: ₱10 off (Mika) via "Use for this order"
  await page.click('#cust-use');
  await page.waitForSelector('.pos-product-card');
  await page.click('.pos-product-card:has-text("Americano")');
  await page.click('.pos-product-card:has-text("Ensaymada")');
  await page.waitForSelector('.reward-chip');
  const box = await page.textContent('.cart-customer');
  ok(/Mika/.test(box) && /0917 ••• 4567/.test(box) && /7 \/ 15/.test(box) && /₱10 off ready/.test(box), 'cart customer box: name, masked phone, 7 / 15, "₱10 off ready"', box.replace(/\s+/g, ' '));
  ok(await cartTotal() === 175, 'cart 110 + 65 = 175');
  await page.click('.reward-chip'); await page.waitForFunction(() => !document.querySelector('.reward-chip[disabled]'), null, {timeout: 9000}).catch(() => {}); await page.waitForTimeout(300);   // 1.5 (B16): the counter re-checks the card with the server before applying
  ok(await cartTotal() === 165 && /Stamp reward/.test(await page.textContent('#reward-row')), 'reward applied: Stamp reward line, total 165');
  await page.click('[data-inc]');
  ok(await cartTotal() === 275, 'recomputed after qty change: 220 + 65 - 10 = 275');
  await page.click('[data-dec]');
  await shots('04-cart-reward');
  await sellCash();
  await must(() => sql(`select loyalty_discount from sales where customer_id='${MIKA}' and status='COMPLETED' and grand_total=165`) === '10.00', 'Mika sale with ₱10 reward accepted by the server', 20000);
  ok(sql(`select count(*) from loyalty_redemptions where customer_id='${MIKA}' and milestone=5`) === '1', 'redemption recorded');

  // ---- Rico: free item on a lone Americano -> ₱0, "Complete sale (nothing to pay)"
  await page.evaluate((id) => attachCustomer({id, nickname: 'Rico'}), RICO);
  await page.click('.pos-product-card:has-text("Americano")');
  await page.waitForSelector('.reward-chip:has-text("free")');
  ok((await page.$$('.reward-chip')).length === 3, 'Rico: 3 rewards offered');
  await page.click('.reward-chip:has-text("free")'); await page.waitForFunction(() => !document.querySelector('.reward-chip[disabled]'), null, {timeout: 9000}).catch(() => {}); await page.waitForTimeout(300);   // 1.5 (B16): the counter re-checks the card with the server before applying
  ok(await cartTotal() === 0 && /nothing to pay/.test(await page.textContent('#checkout-btn')), 'free item covers the order: total ₱0, button "Complete sale (nothing to pay)"');
  await page.click('#checkout-btn');
  await page.waitForSelector('#complete-sale-btn');
  ok(!(await page.$('#pay-methods')), '₱0: no payment step');
  await page.click('#complete-sale-btn');
  await must(() => sql(`select grand_total::numeric(10,2)||' '||loyalty_discount::numeric(10,2) from sales where customer_id='${RICO}' and status='COMPLETED' and received_at is not null`) === '0.00 110.00', 'Rico ₱0 sale accepted (loyalty 110)', 20000);

  // ---- Rico: hold drops the reward
  await page.click('.pos-product-card:has-text("Ensaymada")');
  await page.evaluate((id) => attachCustomer({id, nickname: 'Rico'}), RICO);
  await page.waitForSelector('.reward-chip');
  const offered = await page.$$eval('.reward-chip', cs => cs.map(c => c.textContent.trim()));
  ok(offered.length === 2 && !offered.some(t => /free/i.test(t)), 'used free-item reward no longer offered', offered);
  await page.click('.reward-chip:has-text("₱50")'); await page.waitForFunction(() => !document.querySelector('.reward-chip[disabled]'), null, {timeout: 9000}).catch(() => {}); await page.waitForTimeout(300);   // 1.5 (B16): the counter re-checks the card with the server before applying
  ok(await cartTotal() === 15, '₱50 off 65 -> 15');
  await page.click('#hold-order-btn');
  ok(await until(async () => /Held orders don't keep a stamp reward/.test(await toasts()), 4000), 'hold: warning shown');
  await must(() => sql(`select loyalty_discount::numeric(10,2) from sales where status='HELD'`) === '0.00', 'held sale uploaded without a reward', 15000);

  // ---- FREE_ITEM choice between lines + ₱50 with a whole-number check
  await page.click('#held-orders-btn'); await page.click('[data-resume]');
  await page.waitForSelector('.cart-cust:has-text("Rico")');
  await page.waitForSelector('.reward-chip');
  await page.click('.pos-product-card:has-text("Iced Latte")'); await page.click('.mod-opt:has-text("16oz")'); await page.click('#mod-add');
  const elig = await page.evaluate(() => { posState.cart.push({lineId:'x', recipe_id:'33333333-0000-0000-0000-000000000003', name:'Americano', unit_price:110, quantity:0.5, modifiers:[]}); const n = freeItemLines().map(l => l.quantity); posState.cart.pop(); return n; });
  ok(!elig.includes(0.5), 'free item: a line with quantity 0.5 is not offered', elig);
  await page.click('.reward-chip:has-text("₱50")'); await page.waitForFunction(() => !document.querySelector('.reward-chip[disabled]'), null, {timeout: 9000}).catch(() => {}); await page.waitForTimeout(300);   // 1.5 (B16): the counter re-checks the card with the server before applying
  ok(await cartTotal() === 65 + 170 - 50, '₱50 off 235 -> 185');
  await sellCash();
  await must(() => sql(`select count(*) from loyalty_redemptions where customer_id='${RICO}' and released_at is null`) === '2', 'Rico: 2 rewards used on the server', 20000);

  // ---- offline: the last ready reward from the saved card
  await page.evaluate((id) => attachCustomer({id, nickname: 'Rico'}), RICO);
  await page.waitForSelector('.reward-chip');
  await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.evaluate(() => { posState.customer = null; });
  await page.evaluate((id) => attachCustomer({id, nickname: 'Rico'}), RICO);
  await page.click('.pos-product-card:has-text("Ensaymada")');
  await until(async () => !!(await page.$('.reward-chip')), 10000);
  const offNote = await page.textContent('.cart-customer');
  ok(/checked when online/.test(offNote) && (await page.$$('.reward-chip')).length === 1, 'offline: only the saved ready reward (₱10), "checked when online"', offNote.replace(/\s+/g, ' '));
  await page.click('.reward-chip'); await page.waitForFunction(() => !document.querySelector('.reward-chip[disabled]'), null, {timeout: 9000}).catch(() => {}); await page.waitForTimeout(300);   // 1.5 (B16): the counter re-checks the card with the server before applying
  ok(await cartTotal() === 55, 'offline ₱10 off 65 -> 55');
  await shots('05-cart-reward-offline', ['desk']);
  await sellCash();
  await ctx.setOffline(false); await page.evaluate(() => { window.dispatchEvent(new Event('online')); Sync.run(); });
  await must(() => sql(`select count(*) from sales where customer_id='${RICO}' and grand_total=55 and loyalty_discount=10`) === '1', 'offline reward sale accepted after reconnecting', 30000);

  // ---- refused reward upload -> failed list in plain words
  await page.evaluate((pid) => {
    const now = new Date().toISOString(), id = uid(), sh = activeShift();
    return Sync.queue('sale', {sale: {id, transaction_number: 'POS-A-2026-999999', transaction_date: now, status: 'COMPLETED', cashier_id: posState.currentUser.id, cashier_name: posState.currentUser.name,
      shift_id: sh.id, subtotal: 65, discount_type: null, discount_value: 0, discount_amount: 0, tax_amount: 0, service_charge_amount: 0, grand_total: 55, source: 'COUNTER', customer_id: pid,
      loyalty_reward: {customer_id: pid, card_no: 1, milestone: 5}, loyalty_discount: 10, created_at: now, updated_at: now},
      items: [{id: uid(), sale_id: id, recipe_id: '33333333-0000-0000-0000-000000000004', name: 'Ensaymada', quantity: 1, unit_price: 65, modifiers: [], line_total: 65, created_at: now}],
      payment: {id: uid(), sale_id: id, method: 'CASH', amount: 55, tendered: 55, change: 0, status: 'CONFIRMED', created_at: now}, inventory: []});
  }, PAOLO);
  await must(async () => (await page.evaluate(() => LocalDB.failedAll())).length === 1, 'refused reward sale in failed uploads', 20000);
  await page.click('#sync-pill');
  const failedText = await page.textContent('#active-modal-overlay');
  ok(/This reward can't be used on this sale/.test(failedText), 'failed list: plain words for REWARD_NOT_AVAILABLE', failedText.replace(/\s+/g, ' ').slice(0, 300));
  await page.click('#active-modal-overlay [data-drop]'); await page.click('#active-modal-overlay [data-ok]');
  await page.click('#active-modal-overlay [data-close]').catch(() => {});

  // ---- Customers offline message
  await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.evaluate(() => cloud.isReachable && 0);
  await go('customers');
  await until(async () => !!(await page.$('.offline-panel')), 8000);
  ok(/needs the internet/.test(await page.textContent('.offline-panel')), 'Customers offline: clear message');
  await ctx.setOffline(false); await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
  await page.evaluate(() => cloud.rpc('fo_floor_plan', {}).catch(()=>{}));
  await page.waitForTimeout(800);

  // ---- floor plan: two QR orders
  const biz = sql(`select business_id from dining_tables limit 1`);
  sql(`insert into qr_orders(id, business_id, order_number, order_day, table_id, table_label, order_type, status, items, subtotal, tax_amount, service_charge_amount, total, customer_nickname, created_at, updated_at)
       values ('99999999-0000-0000-0000-000000000001', '${biz}', 'Q-018', current_date, '77777777-0000-0000-0000-000000000002', 'T2', 'DINE_IN', 'PENDING', '[{"recipe_id":"33333333-0000-0000-0000-000000000003","name":"Americano","quantity":2,"unit_price":110,"modifiers":[]}]', 220, 0, 0, 220, 'Mika', now(), now()),
              ('99999999-0000-0000-0000-000000000002', '${biz}', 'Q-017', current_date, '77777777-0000-0000-0000-000000000004', 'T4', 'DINE_IN', 'PREPARING', '[{"recipe_id":"33333333-0000-0000-0000-000000000004","name":"Ensaymada","quantity":1,"unit_price":65,"modifiers":[]}]', 65, 0, 0, 65, 'Paolo', now() - interval '5 minutes', now())`);
  sql(`update qr_orders set paid_at = now() where id = '99999999-0000-0000-0000-000000000002'`);
  await go('qr');
  await page.evaluate(() => pollQrOrders());
  await must(async () => !!(await page.$('.fp-table.st-wait')), 'T2 lights up', 15000);
  const fp = await page.$$eval('.fp-table', ts => ts.map(t => t.className.replace('fp-table ', '') + ' ' + t.textContent.replace(/\s+/g, ' ').trim()));
  ok(fp.some(t => /st-wait/.test(t) && /T2/.test(t) && /Q-018/.test(t) && /₱220\.00/.test(t)), 'T2 terracotta: waiting for payment, order number + total', fp);
  ok(fp.some(t => /st-serve/.test(t) && /T4/.test(t) && /Q-017/.test(t)), 'T4 butter: paid, being made', fp);
  ok(fp.some(t => /round/.test(t) && /T3/.test(t) && /st-free/.test(t) && /2 seats/.test(t)), 'T3 free (paper), round, seats', fp);
  ok(await page.$('.fp-unplaced .fp-table:has-text("Bar 1")'), 'table without a position in "Not placed"');
  ok(/Waiting for payment.*Being made.*Free/.test(await page.textContent('.fp-legend')), 'legend');
  ok((await page.$$('.fp-shape')).length === 5, 'floor shapes drawn (5)');
  const rpcNames = rpc.map(r => r.name);
  ok(!(await page.evaluate(() => JSON.stringify(state.tables).includes('qr_token'))), 'tables on the counter have no qr_token');
  await shots('06-qr-floor-plan');
  await page.click('.fp-table:has-text("T2")');
  await page.waitForSelector('#active-modal-overlay [data-qr-act="ACCEPT"]');
  await shots('07-qr-table-open', ['desk']);
  await page.click('#active-modal-overlay [data-qr-act="ACCEPT"]');
  await must(() => sql(`select status from qr_orders where order_number='Q-018'`) === 'PREPARING', 'accept from the table popup reached the server', 10000);
  await page.click('.fp-table:has-text("T1")');
  ok(await until(async () => /T1 is free/.test(await toasts()), 3000), 'free table tap: "T1 is free"');
  await page.click('#qr-view-list');
  ok(await page.$('.qr-board .qr-col') && await page.$('[data-qr-act="READY"]'), 'List view: the board with the same actions');
  await shots('08-qr-list', ['desk']);
  await page.click('#qr-view-plan');

  // ---- shift & sales screenshots
  await go('shift'); await page.waitForSelector('#cash-mgmt-btn'); await shots('09-shift');
  await go('sales'); await page.waitForSelector('tr[data-id]'); await shots('10-sales');

  // ---- MANAGER: money on the Customers tab
  await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'});
  await typePin(page, '222222'); await page.waitForSelector('#app', {state: 'visible'});
  await go('customers');
  await page.waitForSelector('.cust-row');
  await page.click(`.cust-row[data-cust="${RICO}"]`);
  await page.waitForFunction(() => { const e = document.getElementById('cust-spent'); return e && /₱/.test(e.textContent); });
  const mgr = await page.evaluate(() => ({spent: document.getElementById('cust-spent').textContent.replace(/\s+/g, ' '), totals: [...document.querySelectorAll('.cust-orders td.num')].map(t => t.textContent.trim()), token: cloud.getStaffToken()}));
  const lastDetail = rpc.filter(r => r.name === 'fo_customer_detail').pop();
  ok(JSON.parse(lastDetail.body).p_staff_token === mgr.token && mgr.token, 'manager: own sign-in (LOGIN) token sent');
  const expSpent = sql(`select to_char(sum(grand_total), 'FM999,990.00') from sales where customer_id='${RICO}' and status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')`);
  ok(mgr.spent.includes(expSpent) && !/Managers only/.test(mgr.spent), `manager: total spent ₱${expSpent}`, mgr.spent);
  ok(mgr.totals.length > 0 && mgr.totals.every(t => /₱/.test(t)), 'manager: per-order totals', mgr.totals.slice(0, 4));
  await shots('11-customers-manager');
  await page.click('.cust-row:has-text("Mika")');
  await page.waitForFunction(() => { const e = document.getElementById('cust-detail'); return e && /Used/.test(e.innerText); });
  ok(/Reward used/.test(await page.textContent('#cust-detail')), 'Mika: ₱10 milestone shown as used, order marked "Reward used"');

  // ---- L2: an erased / merged customer's saved stamp card is deleted on the server's NOT_FOUND
  await page.evaluate((id) => attachCustomer({id, nickname: 'Paolo'}), PAOLO);
  await must(async () => !!(await page.evaluate((id) => loadCustomerCards().then(m => !!m[id]), PAOLO)), 'Paolo card saved', 10000);
  sql(`update customers set merged_into = '${MIKA}' where id = '${PAOLO}'`);
  await page.evaluate(() => { posState.customer = null; });
  await page.evaluate((id) => attachCustomer({id, nickname: 'Paolo'}), PAOLO);
  await must(async () => !(await page.evaluate((id) => loadCustomerCards().then(m => !!m[id]), PAOLO)), 'saved card deleted after NOT_FOUND', 10000);
  ok(!(await page.$('.stamp-chip')), 'L2: NOT_FOUND -> saved card deleted, no stamp card shown');
  const old = await page.evaluate(async () => { const m = await loadCustomerCards(); m['x-old'] = {c: {id: 'x-old'}, at: new Date(Date.now() - 31*24*3600*1000).toISOString()}; await LocalDB.set('fo.customerCards', m); return !!(await loadCustomerCards())['x-old']; });
  ok(old === false, 'L2: saved cards older than 30 days are dropped');
  const stale = await page.evaluate(() => { posState.customer = {id: 'z', nickname: 'Z', summary: {ready_rewards: [{card_no: 1, stamp: 5, type: 'AMOUNT_OFF', amount: 10}]}, summaryOffline: true, summaryAt: new Date(Date.now() - 49*3600*1000).toISOString()}; const n = usableRewards().length; posState.customer.summaryAt = new Date().toISOString(); const m = usableRewards().length; posState.customer = null; return [n, m]; });
  ok(stale[0] === 0 && stale[1] === 1, 'L2: offline rewards only from copies saved in the last 48 hours', stale);
  // ---- L4: ₱0 from a 100% discount -> neutral words, reference "Nothing to pay"
  await go('pos');
  await page.click('.pos-product-card:has-text("Ensaymada")');
  await page.click('#add-discount-link');
  await page.waitForSelector('#disc-value');
  await page.fill('#disc-value', '100'); await page.click('#disc-apply');
  await page.click('#checkout-btn');
  await page.waitForSelector('#complete-sale-btn');
  const freeText = await page.textContent('#active-modal-overlay');
  ok(/The total is ₱0\.00/.test(freeText) && !/stamp reward/i.test(freeText), 'L4: 100% discount -> neutral wording', freeText.replace(/\s+/g, ' ').slice(0, 200));
  await page.click('#complete-sale-btn');
  await must(() => sql(`select count(*) from payments where reference = 'Nothing to pay'`) === '1', 'L4: payment reference "Nothing to pay"', 20000);
  ok(sql(`select count(*) from payments where reference = 'Stamp reward (nothing to pay)'`) === '1', 'L4: the reward ₱0 sale kept "Stamp reward (nothing to pay)"');
  // ---- L3: locking forgets the Customers view (manager's money)
  await go('customers'); await page.waitForSelector('.cust-row'); await page.click(`.cust-row[data-cust="${RICO}"]`);
  await page.waitForFunction(() => { const e = document.getElementById('cust-spent'); return e && /₱/.test(e.textContent); });
  const seq = await page.evaluate(() => custView.detailSeq);
  await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'});
  const after = await page.evaluate(() => ({list: custView.list, detail: custView.detail, seq: custView.detailSeq, content: document.getElementById('content').innerHTML}));
  ok(after.list === null && after.detail === null && after.seq > seq && after.content === '', 'L3: lock clears the Customers data, bumps request numbers, empties the screen', after);

  net.disallow();
  ok(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
