// Release 1.5 counter checks (adopted by Z 2026-11-12 from the counter work's scratch fo15-checks.js; applies
// sql/21_seed_release12_fo.sql): Barista drink button + kit, blind count before Close shift (no expected amounts,
// double-check lists only the items that differ), stock_count queued before shift_close, archived customers,
// saved stamps + past cards, Guest on QR orders, shop-day (Manila) dates.
// Needs a fresh seed:  tests/e2e_reset.sh db_fo && tests/restart_fake.sh 8790 db_fo
//   FAKE_PORT=8790 FAKE_DB=db_fo QA_SHOTS=<dir> node tests/e2e/fo_release15.e2e.js
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const H = require(ROOT + '/tests/e2e/lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, ok, until, must, typePin} = H;
const NAME = 'fo_release15';
const BEANS = '22222222-0000-0000-0000-000000000001', MILK = '22222222-0000-0000-0000-000000000002';
const MIKA = '88888888-0000-0000-0000-000000000001', RICO = '88888888-0000-0000-0000-000000000002';
execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', H.DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'tests', 'sql', '21_seed_release12_fo.sql')], {stdio: 'ignore'});
const biz = sql(`select id from businesses limit 1`);
sql(`update settings set barista_kit='[]'::jsonb`);
sql(`update ingredients set count_at_close=false`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 800}});
  const page = await ctx.newPage();
  const errors = []; const net = H.attach(page, errors, 'FO');
  ctx.on('page', p => { if(p !== page) p.waitForLoadState().then(() => p.close()).catch(() => {}); });
  const rpc = []; page.on('request', r => { const u = r.url(); if(u.includes('/rest/v1/rpc/')) rpc.push({name: u.split('/rpc/')[1].split('?')[0], body: r.postData() || ''}); });
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  const modalText = () => page.evaluate(() => { const m = document.getElementById('active-modal-overlay'); return m ? m.innerText : ''; });
  const shot = (n) => H.shot(page, 'fo15-' + n);
  const go = async (route) => { await page.click(`.nav-item[data-route="${route}"]`); await page.waitForTimeout(300); };
  const offline = async () => { await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); };
  const online = async () => { await ctx.setOffline(false); await page.evaluate(() => { window.dispatchEvent(new Event('online')); Sync.run(); }); };
  const minTap = (sel) => page.$$eval(sel, els => Math.min(...els.filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height)));
  const reloadSignIn = async () => {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app').style.display === 'flex' || document.getElementById('pin-gate').style.display === 'flex', null, {timeout: 20000});
    if(!(await page.isVisible('#app'))){ await typePin(page, '1111'); await page.waitForSelector('#app', {state: 'visible'}); }
    await page.waitForTimeout(500);
    await page.click('.nav-item[data-route="pos"]');
    await page.waitForSelector('.pos-product-card', {timeout: 15000});
  };
  const outbox = () => page.evaluate(async () => (await LocalDB.outboxAll()).map(o => o.type));
  const sellCash = async () => { await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn'); await page.waitForTimeout(400); await page.keyboard.press('Escape').catch(()=>{}); };
  try{
    await page.goto(H.BASE + '/cccc/front/');
    await page.waitForSelector('#su-code');
    await page.fill('#su-code', 'TESTAB'); await page.click('#su-pair');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '1111');
    await H.startShift(page, 1000);

    // ---- fo15-barista: no kit set
    ok(await page.isVisible('#barista-btn') && await page.isVisible('#waste-btn'), 'fo15-barista: "Barista drink" next to "Log waste" on Orders');
    await page.click('#barista-btn');
    await page.waitForSelector('#bd-to-waste');
    ok(/Ask the owner to set the barista drink kit in the Back Office\./.test(await modalText()), 'fo15-barista: no kit -> "Ask the owner to set the barista drink kit in the Back Office."');
    await shot('barista-nokit');
    await page.click('[data-close]');

    // ---- fo15-barista: kit set in Back Office (stand-in: SQL), opened, adjusted, saved
    sql(`update settings set barista_kit='[{"ingredient_id":"${BEANS}","quantity":18,"unit":"g"},{"ingredient_id":"${MILK}","quantity":0.2,"unit":"L"}]'::jsonb`);
    await reloadSignIn();
    const beans0 = Number(sql(`select coalesce(sum(case when transaction_type in ('PURCHASE','ADJUSTMENT','SALE_REVERSAL','PRODUCTION') then quantity else -quantity end),0) from inventory_transactions where ingredient_id='${BEANS}'`));
    await page.click('#barista-btn');
    await page.waitForSelector('#bd-save');
    const kit = await page.$$eval('#bd-lines .waste-line', ls => ls.map(l => [l.querySelector('b').textContent, l.querySelector('input').value, l.querySelector('select').value]));
    ok(JSON.stringify(kit) === JSON.stringify([['Espresso beans', '18', 'g'], ['Milk', '0.2', 'L']]), 'fo15-barista: one tap shows the kit with usual amounts and units', kit);
    await page.fill('[data-bqty="1"]', '250'); await page.selectOption('[data-bunit="1"]', 'ml');
    // reload keeps the adjusted amounts
    await reloadSignIn();
    await page.click('#barista-btn'); await page.waitForSelector('#bd-save');
    ok(await page.inputValue('[data-bqty="1"]') === '250' && await page.inputValue('[data-bunit="1"]') === 'ml', 'fo15-barista: adjusted amounts survive a reload');
    const tap = await minTap('#active-modal-overlay input, #active-modal-overlay select, #active-modal-overlay .modal-foot .btn, #active-modal-overlay button.btn');
    ok(tap >= 44, 'fo15-barista: inputs and buttons at least 44 px', tap);
    await shot('barista');
    await page.click('#bd-save');
    await must(() => sql(`select count(*) from waste_logs where reason='CALIBRATION'`) === '1', 'barista waste uploaded', 20000);
    const wl = sql(`select string_agg(round(abs(t.quantity),3)::text || ':' || t.ingredient_id, ',' order by t.ingredient_id) from inventory_transactions t join waste_logs w on w.id::text = t.reference_id::text where w.reason='CALIBRATION'`);
    ok(wl === `18.000:${BEANS},250.000:${MILK}`, 'fo15-barista: saved as waste CALIBRATION, 18 g beans + 250 mL milk taken off stock', wl);
    ok(sql(`select approved_by is null from waste_logs where reason='CALIBRATION'`) === 't', 'fo15-barista: no manager approval needed');
    ok(rpc.some(r => r.name === 'fo_sync' && /"type":"waste"/.test(r.body) && /CALIBRATION/.test(r.body)), 'fo15-barista: sent as the existing waste op');
    await page.click('#barista-btn'); await page.waitForSelector('#bd-save');
    ok(/Already logged today at/.test(await modalText()), 'fo15-barista: second open says it was already logged today');
    await page.click('[data-close]');

    // ---- fo15-archived: Customers tab main list vs Archived
    await go('customers');
    await page.waitForSelector('.cust-row');
    let names = await page.$$eval('.cust-row b', bs => bs.map(b => b.textContent));
    ok(!names.some(n => n.startsWith('Zed')), 'fo15-archived: main list hides customers without a phone', names);
    const lastList = rpc.filter(r => r.name === 'fo_customer_list').pop();
    ok(lastList && JSON.parse(lastList.body).p_archived === false, 'fo15-archived: main list asks p_archived false');
    await page.click('#cust-which [data-arch="1"]');
    await until(async () => (await page.$$eval('.cust-row b', bs => bs.map(b => b.textContent))).some(n => n.startsWith('Zed')), 8000);
    names = await page.$$eval('.cust-row b', bs => bs.map(b => b.textContent));
    ok(names.includes('Zed <b>x</b>') && !(await page.$('.cust-row b b')) && !names.includes('Mika'), 'fo15-archived: "Archived" shows only no-phone customers, nickname as text', names);
    ok(JSON.parse(rpc.filter(r => r.name === 'fo_customer_list').pop().body).p_archived === true, 'fo15-archived: Archived asks p_archived true');
    ok(await minTap('#cust-which .seg-btn') >= 44, 'fo15-archived: filter buttons at least 44 px');
    await shot('archived');
    await page.click('#cust-which [data-arch="0"]');

    // attach-customer picker hides archived matches until asked
    await go('pos');
    await page.click('#cust-add'); await page.waitForSelector('#cp-q');
    await page.fill('#cp-q', 'Zed');
    await until(async () => !!(await page.$('#cp-show-arch')), 8000);
    ok(!(await page.$('.cp-row')) && /Show 1 archived/.test(await page.textContent('#cp-results')), 'fo15-archived: picker hides archived match, offers "Show 1 archived"');
    await page.click('#cp-show-arch');
    ok(/no phone · archived/.test(await page.textContent('#cp-results')), 'fo15-archived: after tapping, archived match shown');
    await page.click('[data-cancel]');

    // ---- fo15-cards: Rico (card 1 full, free drink unused) buys again -> 1 stamp saved
    await page.evaluate((id) => attachCustomer({id, nickname: 'Rico'}), RICO);
    await page.click('.pos-product-card:has-text("Americano")');
    await page.waitForSelector('.reward-chip');
    await sellCash();
    await must(() => sql(`select count(*) from sales where customer_id='${RICO}' and received_at is not null and loyalty_discount=0 and transaction_date::date >= current_date - 1`) !== '0', 'Rico sale uploaded', 20000);
    const sum1 = JSON.parse(sql(`select public._loyalty_summary('${biz}', '${RICO}')::text`));
    await go('customers');
    await page.waitForSelector(`.cust-row[data-cust="${RICO}"]`);
    await page.click(`.cust-row[data-cust="${RICO}"]`);
    await page.waitForSelector('#cust-spent');
    const det1 = await page.textContent('#cust-detail');
    const saved = sum1.card.saved_stamps;
    ok(saved > 0 && new RegExp(saved + ' stamps? saved for the next card').test(det1), `fo15-cards: "${saved} stamp(s) saved for the next card" when saved_stamps > 0`, det1.replace(/\s+/g, ' ').slice(0, 300));
    await page.$eval('.saved-stamps', e => e.scrollIntoView({block: 'center'})); await page.waitForTimeout(300);
    await shot('saved-stamps');

    // ---- fo15-reward-recheck: online, a reward the server no longer lists is refused before it is applied
    await go('pos');
    await page.evaluate((id) => attachCustomer({id, nickname: 'Mika'}), MIKA);
    await page.click('.pos-product-card:has-text("Ensaymada")');
    await page.waitForSelector('.reward-chip');
    await page.evaluate(() => { posState.customer.summary.ready_rewards = posState.customer.summary.ready_rewards.concat([{card_no: 2, stamp: 5, type: 'AMOUNT_OFF', amount: 10, label: '₱10 off'}]); renderCartPanel(); });
    await page.click('.reward-chip:has-text("₱10")');
    await page.waitForFunction(() => !document.querySelector('.reward-chip[disabled]'));
    // the first ₱10 chip is card 1's (real) one -> applied after the server check
    ok(rpc.filter(r => r.name === 'fo_customer_detail').length > 0 && /Stamp reward/.test(await page.textContent('.pos-cart-summary')), 'fo15-reward-recheck: card refreshed from the server, card-1 reward applied');
    await page.click('#reward-remove');
    await page.evaluate(() => { posState.customer.summary.ready_rewards = [{card_no: 2, stamp: 5, type: 'AMOUNT_OFF', amount: 10, label: '₱10 off'}]; renderCartPanel(); });
    // Mika's card 1 reward was refreshed back in above, so put back only the fake card-2 one and tap it
    await page.evaluate(() => { const b = document.querySelector('[data-reward="2:5"]'); if(b) b.click(); });
    await page.waitForTimeout(1500);
    ok(!(await page.$('#reward-row')) && /not ready on the customer's card any more/.test(await toasts()), 'fo15-reward-recheck: an unissued card-2 reward is refused with plain words', await toasts());

    // ---- fo15-card-not-issued: offline sale with a card-2 reward -> CARD_NOT_ISSUED in the failed list
    await offline();
    await page.evaluate(() => { posState.customer.summary.ready_rewards = [{card_no: 2, stamp: 5, type: 'AMOUNT_OFF', amount: 10, label: '₱10 off'}]; posState.customer.summaryOffline = true; posState.customer.summaryAt = new Date().toISOString(); renderCartPanel(); });
    await page.evaluate(() => { const b = document.querySelector('[data-reward="2:5"]'); if(b) b.click(); });
    await page.waitForSelector('#reward-row');
    await sellCash();
    await online();
    await must(() => page.evaluate(async () => (await LocalDB.failedAll()).length > 0), 'CARD_NOT_ISSUED refusal', 20000);
    const failed = await page.evaluate(async () => { const f = (await LocalDB.failedAll())[0]; return {code: f.error, text: failedReasonText(f), retry: rewardRefused(f)}; });
    ok(/CARD_NOT_ISSUED/.test(failed.code) && /next card/.test(failed.text) && failed.retry, 'fo15-card-not-issued: plain words + "Retry without the reward" path', failed);
    await page.evaluate(() => showFailedOps()); await page.waitForTimeout(300);
    ok(/A manager can retry this sale without the stamp reward/.test(await modalText()), 'fo15-card-not-issued: cashier sees that a manager can retry');
    await shot('card-not-issued');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => { for(const f of await LocalDB.failedAll()) await LocalDB.failedRemove(f.seq); await rebuildUsedRewardKeys(); await Sync.refreshCounts(); closeModal && closeModal(); });

    // ---- fo15-cards: Rico uses the free drink -> card 2 opens, card 1 in Past cards
    await go('pos');
    await page.evaluate(() => clearCart());
    await page.evaluate((id) => attachCustomer({id, nickname: 'Rico'}), RICO);
    await page.click('.pos-product-card:has-text("Americano")');
    await page.waitForSelector('.reward-chip:has-text("free")');
    await page.click('.reward-chip:has-text("free")');
    await page.waitForSelector('#reward-row');
    await page.click('#checkout-btn'); await page.waitForSelector('#complete-sale-btn'); await page.click('#complete-sale-btn'); await page.waitForTimeout(400); await page.keyboard.press('Escape').catch(()=>{});
    await must(() => sql(`select count(*) from sales where customer_id='${RICO}' and loyalty_discount=110 and received_at is not null`) === '1', 'Rico free drink uploaded', 20000);
    await go('customers');
    await page.click(`.cust-row[data-cust="${RICO}"]`);
    await page.waitForSelector('.past-cards');
    await page.click('.past-cards summary');
    const det2 = (await page.textContent('#cust-detail')).replace(/\s+/g, ' ');
    ok(/Card 2/.test(det2) && /Past cards \(1\)/.test(det2) && /Card 1 filled \w+ \d+, \d{4} · completed \w+ \d+, \d{4}/.test(det2) && /free drink/i.test(det2.split('Past cards')[1]), 'fo15-cards: card 2 open; Past cards lists card 1, date filled, date completed, rewards used', det2.slice(0, 600));
    await page.$eval('.past-cards', e => e.scrollIntoView({block: 'center'})); await page.waitForTimeout(300);
    await shot('past-cards');

    // ---- fo15-guest: QR board shows guest orders as "Guest"
    sql(`insert into qr_orders(business_id, order_number, order_day, table_label, order_type, customer_nickname, status, items, subtotal, total, is_guest)
      values ('${biz}', 'Q-G1', current_date, 'Table 5', 'DINE_IN', null, 'PENDING', '[{"recipe_id":"33333333-0000-0000-0000-000000000003","name":"Americano","quantity":1,"unit_price":110,"modifiers":[],"notes":null}]'::jsonb, 110, 110, true)`);
    await go('qr');
    await page.evaluate(() => pollQrOrders());
    await until(async () => /Q-G1/.test(await page.textContent('#content')), 10000);
    await page.evaluate(() => setQrView('list')).catch(()=>{});
    await page.waitForTimeout(300);
    const card = await page.evaluate(() => { const c = [...document.querySelectorAll('.qr-card')].find(x => /Q-G1/.test(x.textContent)); return c ? c.querySelector('.qr-meta').textContent : ''; });
    ok(/Guest/.test(card), 'fo15-guest: guest QR order shows "Guest"', card);
    const tk = await page.evaluate(() => ticketHtml(state.qrOrders.find(o => o.order_number === 'Q-G1'), {}));
    ok(/Guest/.test(tk), 'fo15-guest: ticket names a guest order "Guest"');

    // ---- fo15-count: blind count before Close shift, offline
    sql(`update ingredients set count_at_close=true where id in ('${BEANS}','${MILK}')`);
    await reloadSignIn();
    await go('pos');
    await offline();
    const exp = await page.evaluate((ids) => ids.map(i => state.stock[i]), [BEANS, MILK]);
    await go('shift');
    await page.click('#close-shift-btn');
    await page.waitForSelector('#count-next', {timeout: 15000});
    const cl = await page.$$eval('#count-lines .count-line b', bs => bs.map(b => b.textContent));
    ok(JSON.stringify(cl) === JSON.stringify(['Espresso beans', 'Milk']), 'fo15-count: Close shift first opens the count list of the ticked items only', cl);
    const ct = await modalText();
    ok(!exp.some(v => ct.includes(String(Math.round(v)))) && !/expected:|in stock/i.test(ct), 'fo15-count: no expected amounts shown', {exp, ct: ct.slice(0, 300)});
    ok(await minTap('#active-modal-overlay input, #active-modal-overlay select, #active-modal-overlay .btn') >= 44, 'fo15-count: inputs and buttons at least 44 px');
    await shot('count');
    await page.click('#count-next');
    ok(/Enter a count for/.test(await toasts()), 'fo15-count: empty counts refused with the item names');
    await page.fill(`[data-cqty="${BEANS}"]`, String(exp[0]));
    await page.fill(`[data-cqty="${MILK}"]`, String(exp[1] - 100));
    await page.click('#count-next');
    await page.waitForSelector('#recount-ok');
    const rc = await page.$$eval('#recount-lines .count-line b', bs => bs.map(b => b.textContent));
    const rt = await modalText();
    ok(JSON.stringify(rc) === JSON.stringify(['Milk']) && !rt.includes(String(Math.round(exp[1]))), 'fo15-count: double-check lists only the item that differs, still blind', {rc, rt: rt.slice(0, 200)});
    await shot('recount');
    await page.fill(`[data-rqty="${MILK}"]`, String(exp[1] - 120));
    await page.click('#recount-ok');
    await page.waitForSelector('#cs-confirm');
    ok(/Stock count done: 2 item\(s\), 1 recounted/.test(await modalText()), 'fo15-count: close dialog says the count is done');
    const cash = await page.evaluate(() => shiftMetrics(activeShift()).expectedCash);
    await page.fill('#cs-declared', String(cash));
    await page.click('#cs-confirm');
    await page.waitForSelector('[data-done]', {timeout: 15000});
    const ob = await outbox();
    ok(ob.indexOf('stock_count') >= 0 && ob.indexOf('stock_count') < ob.indexOf('shift_close'), 'fo15-count: stock_count queued before shift_close (offline)', ob);
    const milkLocal = await page.evaluate((i) => state.stock[i], MILK);
    ok(Math.abs(milkLocal - (exp[1] - 120)) < 1e-6, 'fo15-count: this counter\'s stock goes to the counted amount', [milkLocal, exp[1] - 120]);
    await shot('count-closed');
    await page.click('[data-done]');
    await online();
    await must(async () => (await outbox()).length === 0, 'uploads cleared after reconnecting', 30000);
    ok(await page.evaluate(async () => (await LocalDB.failedAll()).length) === 0, 'fo15-count: nothing failed after reconnecting');
    const sc = H.one(`select status, needs_review, (select count(*) from stock_count_lines l where l.count_id = c.id) as n from stock_counts c`);
    ok(sc && sc.n === 2 && sc.status === 'SUBMITTED', 'fo15-count: server has the count with 2 lines', sc);
    ok(sql(`select round(sum(abs(t.quantity)),3)::text from inventory_transactions t join waste_logs w on w.stock_count_id::text = t.reference_id::text where w.reason='COUNT_SHORTAGE' and t.transaction_type='WASTE'`) === '120.000', 'fo15-count: 120 mL missing recorded as "Missing at count"', sql(`select string_agg(reason,',') from waste_logs`));
    ok(sql(`select status from shifts where status='CLOSED' order by closed_at desc limit 1`) === 'CLOSED', 'fo15-count: the shift closed on the server');

    // ---- fo15-failed-words: plain words for refused counts / closes
    const fw = await page.evaluate(() => ({
      bad: failedReasonText({type: 'stock_count', error: 'BAD_COUNT', data: {lines: [{}, {}]}}),
      req: failedReasonText({type: 'stock_count', error: 'COUNT_REQUIRED', data: {lines: [{}]}}),
      fr: failedReasonText({type: 'stock_count', error: 'FORBIDDEN_ROW', data: {lines: [{}]}}),
      close: failedReasonText({type: 'shift_close', error: 'COUNT_REQUIRED', data: {}}),
      label: opTypeLabel('stock_count')}));
    ok(/changed which items are counted/.test(fw.bad) && /left out an item/.test(fw.req) && /clashes with a record/.test(fw.fr) && /stock count is missing or was refused/.test(fw.close) && fw.label === 'Stock count', 'fo15-failed-words: BAD_COUNT / COUNT_REQUIRED / FORBIDDEN_ROW / refused close in plain words', fw);

    // ---- fo15-tz: "Today · all counters" uses the shop's day on a tablet set to another time zone
    sql(`insert into device_pairing_codes(code, business_id, device_name, expires_at) values ('TESTTZ', '${biz}', 'LA tablet', now() + interval '1 day')`);
    const ctx2 = await browser.newContext({viewport: {width: 1280, height: 800}, timezoneId: 'America/Los_Angeles'});
    const p2 = await ctx2.newPage();
    const rpc2 = []; p2.on('request', r => { const u = r.url(); if(u.includes('/rest/v1/rpc/sales_report')) rpc2.push(r.postData() || ''); });
    await p2.goto(H.BASE + '/cccc/front/');
    await p2.waitForSelector('#su-code'); await p2.fill('#su-code', 'TESTTZ'); await p2.click('#su-pair');
    await p2.waitForSelector('#pin-gate', {state: 'visible'}); await typePin(p2, '1111');
    await H.startShift(p2, 0);
    await p2.click('.nav-item[data-route="sales"]'); await p2.waitForTimeout(300);
    await p2.click('[data-view="today"]');
    await until(() => rpc2.length > 0, 8000);
    const manilaKey = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const want = new Date(manilaKey + 'T00:00:00+08:00').toISOString();
    const got = rpc2.length ? JSON.parse(rpc2[0]).p_from : null;
    ok(got && new Date(got).toISOString() === want, 'fo15-tz: Today · all counters starts at Manila midnight on a Los Angeles tablet', {got, want});
    ok(await p2.evaluate(() => todayISO()) === manilaKey, 'fo15-tz: todayISO() is the Manila day there');
    await ctx2.close();

    ok(!errors.length, 'no browser errors', errors);
  }catch(e){ H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})();
