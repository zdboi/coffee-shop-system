// Release 1.5 Back Office checks (adopted by Z 2026-11-12 from the Back Office work's scratch bo15.e2e.js): Count at
// closing ticks, Stock counts screen + revise, barista kit, R&D log, production batch size / "Max I can make" / partner
// branch (TCO) batches and the "To return" list, archived customers, usernames, stamp cards from the server, table cards.
// Needs a fresh seed:  tests/e2e_reset.sh db_bo && tests/restart_fake.sh 8791 db_bo
//   FAKE_PORT=8791 FAKE_DB=db_bo QA_SHOTS=<dir> node tests/e2e/bo_release15.e2e.js
const path = require('path');
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {ok, sql, one, rows} = H;
const SH = path.join(H.SHOTS, 'bo15') + '/';
require('fs').mkdirSync(SH, {recursive: true});
const BEANS = '22222222-0000-0000-0000-000000000001', MILK = '22222222-0000-0000-0000-000000000002', AMER = '33333333-0000-0000-0000-000000000003';
const SUGAR = '2515aaaa-0000-0000-0000-000000000001', CARAMEL = '2515aaaa-0000-0000-0000-000000000002', CARAMEL_R = '3515aaaa-0000-0000-0000-000000000001';
const TCO = '2515aaaa-0000-0000-0000-0000000000c0';
const CUST = '2515aaaa-0000-0000-0000-0000000000d1', NOPHONE = '2515aaaa-0000-0000-0000-0000000000d2';
const COUNT = '2515aaaa-0000-0000-0000-0000000000e1', SHIFT = '2515aaaa-0000-0000-0000-0000000000e2', DEV = '2515aaaa-0000-0000-0000-0000000000e3';
function seed(){
  const biz = sql(`select id from businesses limit 1`);
  sql(`insert into ingredients(id, business_id, name, base_unit, active) values ('${SUGAR}','${biz}','Sugar','g',true) on conflict do nothing`);
  sql(`insert into purchases(id, business_id, ingredient_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit) values
    ('5515aaaa-0000-0000-0000-000000000001','${biz}','${SUGAR}', current_date, 1, 'kg', 1000, 80, 0.08) on conflict do nothing`);
  sql(`insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date) values ('${biz}','${SUGAR}','PURCHASE',300,'5515aaaa-0000-0000-0000-000000000001',current_date)`);
  sql(`insert into recipes(id, business_id, name, recipe_type, selling_price, is_production_recipe, expected_yield, yield_unit, active) values ('${CARAMEL_R}','${biz}','Caramel sauce','SAUCES_SYRUPS',0,true,1000,'ml',true) on conflict do nothing`);
  sql(`insert into ingredients(id, business_id, name, base_unit, is_produced_item, source_recipe_id, active) values ('${CARAMEL}','${biz}','Caramel sauce','ml',true,'${CARAMEL_R}',true) on conflict do nothing`);
  sql(`update recipes set produced_ingredient_id='${CARAMEL}' where id='${CARAMEL_R}'`);
  sql(`insert into recipe_ingredients(business_id, recipe_id, ingredient_id, quantity, unit) values ('${biz}','${CARAMEL_R}','${SUGAR}',500,'g'), ('${biz}','${CARAMEL_R}','${MILK}',200,'ml')`);
  sql(`insert into suppliers(id, business_id, name) values ('${TCO}','${biz}','TCO') on conflict do nothing`);
  // customers: one with a phone and 20 stamps with the free drink (stamp 15) unused; one without a phone (archived)
  sql(`insert into customers(id, business_id, nickname, phone, source) values ('${CUST}','${biz}','Mika','+639171112222','QR'), ('${NOPHONE}','${biz}','Nophone',null,'QR') on conflict do nothing`);
  sql(`update settings set loyalty_enabled = true where business_id='${biz}'`);
  for(let d = 1; d <= 10; d++){
    const sid = sql(`insert into sales(business_id, transaction_number, transaction_date, status, customer_id, subtotal, grand_total) values ('${biz}', 'POS-B15-${d}', now() - interval '${d} days', 'COMPLETED', '${CUST}', 175, 175) returning id`).split('\n')[0];
    sql(`insert into sale_items(business_id, sale_id, recipe_id, name, quantity, unit_price, line_total) values ('${biz}','${sid}','33333333-0000-0000-0000-000000000001','Iced Latte',1,110,110), ('${biz}','${sid}','33333333-0000-0000-0000-000000000004','Ensaymada',1,65,65)`);
  }
  // a counter count with a shortage and an extra (flagged)
  sql(`insert into devices(id, business_id, device_name, device_type, device_tag, device_key, active) values ('${DEV}','${biz}','Front counter','COUNTER','B15','b15-device-key',true) on conflict do nothing`);
  sql(`insert into shifts(id, business_id, device_id, cashier_name, shift_number, opened_at, status, opening_cash) values ('${SHIFT}','${biz}','${DEV}','Cathy Cashier','SHIFT-B15-1', now() - interval '6 hours','ACTIVE',0) on conflict do nothing`);
  sql(`insert into stock_counts(id, business_id, shift_id, device_id, staff_id, staff_name, counted_at, count_date, status, needs_review, review_reason) values
    ('${COUNT}','${biz}','${SHIFT}','${DEV}','66666666-0000-0000-0000-000000000001','Cathy <b>Cashier</b>', now(), current_date, 'SUBMITTED', true, 'COUNT_EXTRA,LARGE_SHORTAGE') on conflict do nothing`);
  sql(`insert into stock_count_lines(business_id, count_id, ingredient_id, name, unit, entered_quantity, counted, expected, difference) values
    ('${biz}','${COUNT}','${MILK}','Milk','ml',4.5,4500,5000,-500), ('${biz}','${COUNT}','${BEANS}','Espresso beans','g',1100,1100,1000,100)`);
  sql(`select public._apply_count_effects('${COUNT}')`);
  return biz;
}
(async () => {
  const biz = seed();
  const browser = await chromium.launch();
  const errors = [];
  const open = async (vp) => {
    const ctx = await browser.newContext({viewport: vp, timezoneId: 'Asia/Manila', acceptDownloads: true});
    const page = await ctx.newPage();
    H.attach(page, errors, 'BO');
    await H.boLogin(page); await page.waitForTimeout(800);
    return {ctx, page};
  };
  const go = async (page, r, p) => { await page.evaluate(([r, p]) => navigate(r, p), [r, p == null ? null : p]); await page.waitForTimeout(900); };
  const gone = async (page) => H.until(async () => !(await page.$('#active-modal-overlay')), 15000);
  const shot = (page, n) => page.screenshot({path: SH + n + '.png', fullPage: true});
  try{
    const {page} = await open({width: 1280, height: 860});
    /* ---- B9 stock counts ---- */
    ok(sql(`select count(*) from waste_logs where stock_count_id='${COUNT}' and reason='COUNT_SHORTAGE'`) === '1', 'seed: shortage waste made');
    await go(page, 'stockCounts');
    const scText = await page.textContent('#content');
    ok(/Counters must be updated to 1\.5 before you tick items/.test(scText), 'counts: warning shown');
    ok(/Cathy <b>Cashier<\/b>/.test(scText) && !(await page.$('#content b:text("Cashier")')), 'counts: staff name escaped');
    ok(/More counted than expected/.test(scText) && /Missing stock worth more/.test(scText), 'counts: flags in plain words', scText.slice(0, 600));
    await shot(page, 'counts-list');
    await page.click('#btn-count-items'); await page.waitForSelector('[data-ci]');
    await page.check(`[data-ci="${MILK}"]`); await page.check(`[data-ci="${BEANS}"]`);
    await shot(page, 'counts-picker');
    await page.click('#ci-save'); await gone(page);
    ok(sql(`select string_agg(name, ',' order by name) from ingredients where count_at_close`) === 'Espresso beans,Milk', 'ticks saved (one call)');
    await go(page, 'stockCounts');
    await page.click(`tr[data-count="${COUNT}"]`); await page.waitForSelector('#sc-revise');
    await shot(page, 'count-modal');
    await page.fill(`[data-new="${MILK}"]`, '4.8'); await page.selectOption(`[data-new-unit="${MILK}"]`, 'L');
    // typed "4.8" then picked L: typed number keeps (4.8 L = 4800 ml)
    await page.click('#sc-revise'); await page.waitForTimeout(600);
    ok(await page.$('#active-modal-overlay'), 'revise without a note is refused on the screen');
    await page.fill('#sc-note', 'Recounted with the closer');
    await page.click('#sc-revise'); await gone(page); await page.waitForTimeout(800);
    const c1 = one(`select status, needs_review, shortage_cost from stock_counts where id='${COUNT}'`);
    ok(c1.status === 'REVISED' && c1.needs_review === false, 'count revised + review cleared', c1);
    ok(sql(`select counted from stock_count_lines where count_id='${COUNT}' and ingredient_id='${MILK}'`) .replace(/\.0+$/, '') === '4800', 'milk now 4800 ml');
    ok(sql(`select count(*) from audit_log where action='Stock count revised'`) === '1', 'audit: Stock count revised');

    /* ---- B7 barista kit ---- */
    await go(page, 'wasteReport');
    await page.click('#btn-barista-kit'); await page.waitForSelector('#kit-add');
    await page.click('#kit-add'); await page.click('#kit-add');
    const rowsK = await page.$$('#kit-rows tr[data-k]');
    await rowsK[0].$eval('[data-kit-ing]', (s, v) => { s.value = v; s.dispatchEvent(new Event('change')); }, BEANS);
    await (await rowsK[0].$('[data-kit-qty]')).fill('18');
    const rowsK2 = await page.$$('#kit-rows tr[data-k]');
    await rowsK2[1].$eval('[data-kit-ing]', (s, v) => { s.value = v; s.dispatchEvent(new Event('change')); }, MILK);
    await (await rowsK2[1].$('[data-kit-qty]')).fill('0.2'); await rowsK2[1].$eval('[data-kit-unit]', (s) => { s.value = 'L'; s.dispatchEvent(new Event('change')); });
    await shot(page, 'barista-kit');
    await page.click('#kit-save'); await gone(page);
    const kit = JSON.parse(sql(`select barista_kit::text from settings where business_id='${biz}'`));
    ok(kit.length === 2 && kit.some(l => l.ingredient_id === MILK && Number(l.quantity) === 0.2 && l.unit === 'L') && kit.some(l => l.ingredient_id === BEANS && l.unit === null), 'kit saved tidy', kit);

    /* ---- B8 R&D ---- */
    await go(page, 'rnd');
    await page.click('#btn-rnd-project'); await page.waitForSelector('#rp-name');
    await page.fill('#rp-name', 'Ube <i>latte</i>'); await page.click('#rp-save'); await gone(page);
    const proj = sql(`select id from rnd_projects limit 1`);
    ok(!!proj, 'project added');
    await go(page, 'rnd');
    await page.click('#btn-rnd-log'); await page.waitForSelector('#ru-save');
    await page.selectOption('#ru-rows [data-ru-id]', MILK); await page.fill('#ru-rows [data-ru-qty]', '300');
    await page.click('#ru-add-menu');
    await shot(page, 'rnd-log');
    await page.click('#ru-save'); await gone(page); await page.waitForTimeout(800);
    const rl = one(`select id, total_cost from waste_logs where reason='RND'`);
    ok(rl && Number(rl.total_cost) > 0, 'R&D usage logged with cost', rl);
    await shot(page, 'rnd');
    ok(/Ube <i>latte<\/i>/.test(await page.textContent('#content')), 'project name escaped');
    // project with usage can't be deleted
    await page.click('[data-rnd-edit]'); await page.waitForSelector('#rp-del'); await page.click('#rp-del'); await page.waitForTimeout(500);
    ok(/can't be deleted/.test(await page.textContent('#toast-wrap')), 'PROJECT_HAS_USAGE in plain words');
    await page.click('[data-cancel]'); await gone(page);
    // waste report: R&D + flags + office label
    await go(page, 'wasteReport'); await page.waitForTimeout(800);
    const wr = await page.textContent('#wr-body');
    ok(/R&D cost by project/.test(wr) && /Missing at count/.test(wr), 'waste report: R&D by project + missing at count', wr.slice(0, 400));
    await shot(page, 'waste-report');
    // delete usage
    await go(page, 'rnd');
    await page.click('[data-rnd-del]'); await page.waitForSelector('[data-ok]'); await page.click('[data-ok]'); await page.waitForTimeout(1200);
    ok(sql(`select count(*) from waste_logs where reason='RND'`) === '0', 'R&D usage deleted');
    // net income lines
    // 1.6 (owner decision B1; changed by Z 2026-11-13, needs C's approval): the Net income page is now the Accounting overview
    // (#ac-body, ACCT_LAST.r = accounting_report; zero lines such as "Tax collected" are not shown). Same hand-math numbers.
    await go(page, 'netIncome'); await page.waitForSelector('#ac-table', {timeout: 15000}); await page.waitForTimeout(800);
    ok(/missing at count/i.test(await page.textContent('#ac-body')), 'accounting overview: missing at count line');

    /* ---- B15 production ---- */
    await go(page, 'suppliers');
    await page.click(`[data-edit="${TCO}"]`); await page.waitForSelector('#s-partner'); await page.check('#s-partner'); await page.click('#s-save'); await gone(page);
    ok(sql(`select is_partner_branch from suppliers where id='${TCO}'`) === 't', 'TCO is a partner branch');
    await go(page, 'production');
    await page.click('#btn-new-production'); await page.waitForSelector('#pr-recipe');
    await page.selectOption('#pr-recipe', CARAMEL_R); await page.waitForTimeout(200);
    await page.click('[data-scale="0.5"]');
    ok(await page.inputValue('#pr-expected') === '500', '½× sets expected 500 ml', await page.inputValue('#pr-expected'));
    await page.click('#pr-max'); await page.waitForTimeout(200);
    const hint = await page.textContent('#pr-scale-hint');
    ok(/Max I can make: 0\.6×/.test(hint) && /Sugar/.test(hint), 'max I can make 0.6×, limited by Sugar', hint);
    ok(await page.inputValue('#pr-expected') === '600', 'expected follows the max', await page.inputValue('#pr-expected'));
    await shot(page, 'produce-max');
    await page.fill('#pr-actual', '580');
    await page.click('#btn-save-prod'); await gone(page);
    const ob = one(`select scale, expected_yield, source from production_batches where recipe_id='${CARAMEL_R}' order by created_at desc limit 1`);
    ok(ob && Number(ob.scale) === 0.6 && Number(ob.expected_yield) === 600 && ob.source === 'OWN', 'own batch saved with scale 0.6', ob);
    ok(Number(sql(`select stock from v_ingredient_stock where ingredient_id='${SUGAR}'`)) === 0, 'sugar used up (300 g)');
    // partner batch, ingredients back
    await page.click('#btn-new-production'); await page.waitForSelector('#pr-recipe');
    await page.selectOption('#pr-recipe', CARAMEL_R); await page.click('[data-src="PARTNER"]');
    await page.click('[data-scale="2"]'); await page.waitForTimeout(900);
    const uses = await page.textContent('#pr-uses');
    ok(/We give back/.test(uses) && /Sugar/.test(uses) && /1000 g/.test(uses), 'partner preview: give back 1000 g sugar', uses);
    await shot(page, 'produce-tco');
    await page.click('#btn-save-prod'); await gone(page); await page.waitForTimeout(800);
    const pb = one(`select b.source, b.scale, d.kind, d.status from production_batches b join partner_debts d on d.batch_id=b.id`);
    ok(pb && pb.source === 'PARTNER' && Number(pb.scale) === 2 && pb.kind === 'INGREDIENTS' && pb.status === 'OPEN', 'partner batch + debt', pb);
    // pesos batch
    await page.click('#btn-new-production'); await page.waitForSelector('#pr-recipe');
    await page.selectOption('#pr-recipe', CARAMEL_R); await page.click('[data-src="PARTNER"]');
    await page.check('input[name="pr-debt"][value="PESOS"]'); await page.click('[data-scale="1"]'); await page.waitForTimeout(900);
    await page.click('#btn-save-prod'); await gone(page); await page.waitForTimeout(1200);
    await page.waitForSelector('#to-return-list');
    await shot(page, 'to-return');
    const tr = await page.textContent('#prod-to-return');
    ok(/To return to TCO/.test(tr) && /Return ingredients/.test(tr) && /Pay/.test(tr), 'To return to TCO list', tr.slice(0, 300));
    // partial return
    await page.click('[data-debt-return]'); await page.waitForSelector('#pr-ret-save');
    await page.fill(`[data-ret="${SUGAR}"]`, '2000');
    await page.click('#pr-ret-save'); await page.waitForTimeout(500);
    ok(/more than we still owe/.test(await page.textContent('#toast-wrap')), 'too much: RETURN_EXCEEDS_DEBT in plain words');
    await page.fill(`[data-ret="${SUGAR}"]`, '0.4'); await page.selectOption(`[data-ret-unit="${SUGAR}"]`, 'kg');
    await page.fill(`[data-ret="${MILK}"]`, '');
    await page.click('#pr-ret-save'); await gone(page); await page.waitForTimeout(800);
    ok(sql(`select quantity_returned from partner_debt_lines l join ingredients i on i.id=l.ingredient_id where i.name='Sugar'`).replace(/\.0+$/, '') === '400', 'returned 400 g (partial)');
    ok(sql(`select count(*) from inventory_transactions where transaction_type='PARTNER_RETURN'`) === '1', 'PARTNER_RETURN stock line');
    // partial payment
    await page.click('[data-debt-pay]'); await page.waitForSelector('#pp-save');
    const owed = Number(await page.inputValue('#pp-amount'));
    await page.fill('#pp-amount', String(owed + 50)); await page.click('#pp-save'); await page.waitForTimeout(500);
    ok(/PAYMENT_TOO_LARGE|more than/i.test(await page.textContent('#toast-wrap')), 'pay too much refused');
    await page.fill('#pp-amount', '10'); await page.click('#pp-save'); await gone(page); await page.waitForTimeout(800);
    ok(Number(sql(`select amount_paid from partner_debts where kind='PESOS'`)) === 10, 'paid ₱10 (partial)');
    await shot(page, 'production-after');
    // ingredient history shows "Returned to partner"
    await go(page, 'ingredientDetail', SUGAR); await page.waitForTimeout(800);
    ok(/Returned to partner/.test(await page.textContent('#content')), 'stock history label Returned to partner');

    /* ---- B6 / B16 customers ---- */
    await go(page, 'customers'); await page.waitForTimeout(1500);
    const cl = await page.textContent('#cust-wrap');
    ok(/Mika/.test(cl) && !/Nophone/.test(cl), 'main list hides customers with no phone');
    const card = await page.evaluate((id) => CUST_LOYALTY.get(id), CUST);
    ok(card && card.card && Number(card.card.saved_stamps) === 5 && Number(card.card.stamps_on_card) === 15, 'card from bo_customer_loyalty: 15/15 + 5 saved', card && card.card);
    ok(/\+5 saved/.test(cl), 'list shows +5 saved', cl.slice(0, 300));
    await page.selectOption('#cust-list', 'archived'); await page.waitForTimeout(300);
    ok(/Nophone/.test(await page.textContent('#cust-wrap')) && !/Mika/.test(await page.textContent('#cust-wrap')), 'Archived filter shows them');
    await shot(page, 'customers-archived');
    await page.selectOption('#cust-list', '');
    await page.click(`[data-cust="${CUST}"]`); await page.waitForSelector('#cu-username');
    const un0 = await page.inputValue('#cu-username');
    ok(/ the /.test(un0), 'username shown (made by the server)', un0);
    await page.fill('#cu-username', 'Mika the 0wner'); await page.click('#cu-save'); await page.waitForTimeout(700);
    ok(/username/i.test(await page.textContent('#toast-wrap')), 'BAD_USERNAME in plain words', await page.textContent('#toast-wrap'));
    await page.fill('#cu-username', 'Mika Latte Queen'); await page.click('#cu-save'); await gone(page);
    ok(sql(`select username from customers where id='${CUST}'`) === 'Mika Latte Queen', 'username saved');
    // stamps: 10 days x 1 drink stamp? the seed sales have no items: check what the server says and show the modal
    await page.click(`[data-cust="${CUST}"]`); await page.waitForSelector('#cu-username');
    await shot(page, 'customer-card');
    ok(/5 stamps saved for the next card/.test(await page.textContent('#active-modal-overlay')), 'modal: saved stamps text');
    await page.click('[data-cancel]'); await gone(page);
    // the free drink used on the newest sale -> card 2 opens with the 5 saved stamps; card 1 in "Past cards"
    sql(`insert into loyalty_redemptions(business_id, customer_id, card_no, milestone, reward_type, sale_id, amount) select business_id, customer_id, 1, 15, 'FREE_ITEM', id, 110 from sales where transaction_number='POS-B15-1'`);
    await go(page, 'customers'); await page.waitForTimeout(1200);
    await page.click(`[data-cust="${CUST}"]`); await page.waitForSelector('#cu-username');
    const m2 = await page.textContent('#active-modal-overlay');
    ok(/Card 2/.test(m2) && /Past cards/.test(m2) && /filled/.test(m2) && /completed/.test(m2), 'past cards: card 1 filled + completed', m2.slice(0, 500));
    await page.$eval('.past-cards', el => el.scrollIntoView());
    await shot(page, 'customer-past-cards');
    await page.click('[data-cancel]'); await gone(page);

    /* ---- B12 QR card ---- */
    const html = await page.evaluate(() => qrCardHtml(state.tables[0], state.settings));
    ok(!/Bienvenido/.test(html) && /Scan to order/.test(html), 'QR card without the tagline');

    /* ---- needs review ---- */
    sql(`update stock_counts set needs_review = true, review_reason = 'COUNT_INCOMPLETE' where id='${COUNT}'`);
    await page.evaluate(() => refreshReviewCount()); await page.waitForTimeout(800);
    await page.evaluate(() => { txFilter.review = true; }); await go(page, 'transactions'); await page.waitForTimeout(1200);
    ok(/Stock counts to review/.test(await page.textContent('#tx-wrap')) && /An item that was due was not counted/.test(await page.textContent('#tx-wrap')), 'flagged count in Needs review');
    // ^ 1.6 (owner decision B20; changed by Z 2026-11-13, needs C's approval): COUNT_INCOMPLETE reads "An item that was due was not counted" (was "Not every ticked item...")
    await shot(page, 'needs-review');
    await page.click('[data-count-review]'); await page.waitForSelector('#sc-reviewed'); await page.click('#sc-reviewed'); await gone(page); await page.waitForTimeout(800);
    ok(sql(`select needs_review from stock_counts where id='${COUNT}'`) === 'f', 'mark reviewed clears it');
    /* ---- backup ---- */
    const bk = await page.evaluate(async () => { const b = await buildCloudBackup(); return Object.fromEntries(['rnd_projects','stock_counts','stock_count_lines','partner_debts','partner_debt_lines','partner_settlements'].map(t => [t, (b.data[t] || []).length])); });
    ok(bk.rnd_projects === 1 && bk.stock_counts === 1 && bk.partner_debts === 2 && bk.partner_settlements === 2, 'backup includes the 1.5 tables', bk);
    const imp = await page.evaluate(async () => { const b = await buildCloudBackup(); const r = await runImport(b, {}); return {imported: r.imported, notes: r.notes}; });
    ok(imp.imported === 1 || imp.imported === 0, 'importing the same backup again adds nothing new (audit line only)', imp);
    /* ---- 768 ---- */
    const {page: p2} = await open({width: 768, height: 1024});
    for(const r of ['stockCounts', 'rnd', 'production', 'customers']){ await go(p2, r); await p2.waitForTimeout(800); await shot(p2, r + '-768'); }
    ok(!(await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)), '768: no sideways scrolling');
  }catch(e){ H.abort('bo15', e); }
  // the one refusal provoked on purpose (Mika the 0wner -> BAD_USERNAME): the 400 answer and its console line
  const left = errors.filter((e, i) => !/BAD_USERNAME/.test(e) && !(/HTTP 400 POST \/rest\/v1\/rpc\/apply_changes/.test(e) && errors.some(x => /BAD_USERNAME/.test(x))));
  ok(!left.length, 'no browser errors (besides the BAD_USERNAME refusal on purpose)', left);
  await browser.close();
  process.exit(H.summary('bo_release15'));
})();
