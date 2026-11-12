// Release 1.5 money / stock reconciliation across the Back Office and the counter, on ONE database (Z, 2026-11-12;
// like money14). Fresh e2e seed + its own stock items (seeded here; the browser seed's tax / service are 0):
//   Sugar (g)   bought 2,000 g for ₱200  -> ₱0.10 / g
//   Cream (mL)  bought 4,000 mL for ₱800 -> ₱0.20 / mL
//   Caramel sauce (mL, house-made): recipe 1× = 1,000 mL from 500 g sugar + 200 mL cream -> ₱90 a batch, ₱0.09 / mL
//   TCO = a supplier ticked "Partner branch"; R&D project "Ube latte".
// Back Office (owner), every step on the screens:
//   P1 own batch ½×            sugar 250, cream 100 out · caramel +500    cost 45.00
//   P2 own batch 2×            sugar 1000, cream 400 out · caramel +2000  cost 180.00
//   T1 TCO batch 1×, ingredients back   caramel +1000, OUR stock untouched; owed sugar 500 g + cream 200 mL (worth 90.00)
//   T2 TCO batch ½×, pesos              caramel +500, owed ₱45.00
//   RET return 300 g sugar to TCO       sugar −300 as "Returned to partner" (not used, not waste, not an expense)
//   PAY ₱20.00 of the ₱45.00            not an expense
//   RND "Ube latte": caramel 100 mL + sugar 50 g      waste (R&D) 9.00 + 5.00 = 14.00
//   W1 record waste cream 100 mL (20.00), then EDIT it to 150 mL        -> 30.00, cream −150 in all
//   W2 record waste sugar 40 g (4.00), then DELETE it                   -> gone, sugar back
// Counter (cashier Cathy, opening cash ₱1,000, no sales), Sugar + Caramel sauce ticked "Count at closing":
//   blind count: sugar 380 (expected 400 -> 20 g missing = waste "Missing at count" 2.00),
//                caramel 3,950 (expected 3,900 -> 50 mL extra: stock raised, flagged COUNT_EXTRA, never negative waste)
//   close shift: expected cash 1,000.00, counted the same, variance 0.
// Hand math:
//   stock      sugar 2000 − 250 − 1000 − 300 − 50 − 20 = 380 g · cream 4000 − 100 − 400 − 150 = 3,350 mL
//              caramel 500 + 2000 + 1000 + 500 − 100 + 50 = 3,950 mL
//   waste report (today): R&D 14.00 + Expired 30.00 + Missing at count 2.00 = 46.00 (the deleted 4.00 is gone)
//   net income (this month): no sales; ingredients wasted 46.00 (of which R&D 14.00, missing at count 2.00), sold 0,
//              expenses 0 -> net income −46.00. The 300 g returned (30.00) and the ₱20 paid are NOT in it; neither is
//              the TCO batches' 135.00 (it reaches the report only through the caramel that gets used: 9.00 above).
//   to return: sugar 200 g (20.00) + cream 200 mL (40.00) on T1; ₱25.00 on T2 -> 85.00 still owed.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/money15.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {sql, one, rows, ok, must, until, typePin} = H;
const NAME = 'money15.e2e';
const SUGAR = '2615aaaa-0000-0000-0000-000000000001', CREAM = '2615aaaa-0000-0000-0000-000000000002', CARAMEL = '2615aaaa-0000-0000-0000-000000000003';
const CARAMEL_R = '3615aaaa-0000-0000-0000-000000000001', TCO = '2615aaaa-0000-0000-0000-0000000000c0', PROJ = '2615aaaa-0000-0000-0000-0000000000d0';
const eq2 = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const eq6 = (a, b) => Math.abs(Number(a) - Number(b)) < 0.000001;
const stock = (id) => Number(sql(`select coalesce((select stock from v_ingredient_stock where ingredient_id='${id}'), 0)`));

const X = {
  sugar: 380, cream: 3350, caramel: 3950,
  rnd: 14.00, office: 30.00, shortage: 2.00,
  ownHalf: 45.00, ownDouble: 180.00, tcoIng: 90.00, tcoPesos: 45.00,
  returned: 30.00, paid: 20.00,
  owedIng: 60.00, owedPesos: 25.00,
};
X.waste = X.rnd + X.office + X.shortage;      // 46.00
X.netIncome = -X.waste;                        // -46.00

function seed(){
  const biz = sql(`select business_id from profiles where id = '00000000-0000-0000-0000-0000000000a1'`);
  sql(`insert into ingredients(id, business_id, name, base_unit, active) values ('${SUGAR}','${biz}','M15 Sugar','g',true), ('${CREAM}','${biz}','M15 Cream','ml',true)`);
  sql(`insert into purchases(id, business_id, ingredient_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit) values
    ('5615aaaa-0000-0000-0000-000000000001','${biz}','${SUGAR}', current_date - 1, 2, 'kg', 2000, 200, 0.10),
    ('5615aaaa-0000-0000-0000-000000000002','${biz}','${CREAM}', current_date - 1, 4, 'L', 4000, 800, 0.20)`);
  sql(`insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date) values
    ('${biz}','${SUGAR}','PURCHASE',2000,'5615aaaa-0000-0000-0000-000000000001',current_date - 1),
    ('${biz}','${CREAM}','PURCHASE',4000,'5615aaaa-0000-0000-0000-000000000002',current_date - 1)`);
  sql(`insert into recipes(id, business_id, name, recipe_type, selling_price, is_production_recipe, expected_yield, yield_unit, active) values ('${CARAMEL_R}','${biz}','M15 Caramel sauce','SAUCES_SYRUPS',0,true,1000,'ml',true)`);
  sql(`insert into ingredients(id, business_id, name, base_unit, is_produced_item, source_recipe_id, active) values ('${CARAMEL}','${biz}','M15 Caramel sauce','ml',true,'${CARAMEL_R}',true)`);
  sql(`update recipes set produced_ingredient_id='${CARAMEL}' where id='${CARAMEL_R}'`);
  sql(`insert into recipe_ingredients(business_id, recipe_id, ingredient_id, quantity, unit) values ('${biz}','${CARAMEL_R}','${SUGAR}',500,'g'), ('${biz}','${CARAMEL_R}','${CREAM}',200,'ml')`);
  sql(`insert into suppliers(id, business_id, name, is_partner_branch) values ('${TCO}','${biz}','TCO',true)`);
  sql(`insert into rnd_projects(id, business_id, name, status) values ('${PROJ}','${biz}','Ube latte','ACTIVE')`);
  sql(`update ingredients set count_at_close = (id in ('${SUGAR}','${CARAMEL}')) where business_id='${biz}'`);
  return biz;
}

(async () => {
  await H.waitClearOfManilaMidnight(12);
  const biz = seed();
  const browser = await chromium.launch();
  const errors = [];
  const bctx = await browser.newContext({viewport: {width: 1280, height: 900}, timezoneId: 'Asia/Manila'});
  const bo = await bctx.newPage(); H.attach(bo, errors, 'BO');
  const go = async (r) => { await bo.evaluate((r) => navigate(r), r); await bo.waitForTimeout(900); };
  const gone = async (page) => { const done = await until(async () => !(await page.$('#active-modal-overlay')), 15000); if(!done) throw new Error('a window did not close: ' + (await page.textContent('#toast-wrap').catch(() => ''))); };
  const today = sql(`select public._shop_day('${biz}', now())`);
  const rpc = (name, args) => bo.evaluate(([n, a]) => cloud.rpc(n, a), [name, args]);
  const produce = async ({scale, partner, pesos}) => {
    await bo.click('#btn-new-production'); await bo.waitForSelector('#pr-recipe');
    await bo.selectOption('#pr-recipe', CARAMEL_R); await bo.waitForTimeout(200);
    if(partner){ await bo.click('[data-src="PARTNER"]'); if(pesos) await bo.check('input[name="pr-debt"][value="PESOS"]'); }
    await bo.click(`[data-scale="${scale}"]`); await bo.waitForTimeout(partner ? 900 : 200);
    if(!partner) await bo.fill('#pr-actual', await bo.inputValue('#pr-expected'));
    await bo.click('#btn-save-prod'); await gone(bo); await bo.waitForTimeout(700);
  };
  try{
    await H.boLogin(bo); await bo.waitForTimeout(800);
    ok(stock(SUGAR) === 2000 && stock(CREAM) === 4000 && stock(CARAMEL) === 0, 'start: sugar 2,000 g, cream 4,000 mL, caramel 0');

    /* ---------- production: half and double (our own), then two TCO batches ---------- */
    await go('production');
    await produce({scale: 0.5});
    ok(stock(SUGAR) === 1750 && stock(CREAM) === 3900 && stock(CARAMEL) === 500, 'P1 ½× batch: sugar −250, cream −100, caramel +500', [stock(SUGAR), stock(CREAM), stock(CARAMEL)]);
    await produce({scale: 2});
    ok(stock(SUGAR) === 750 && stock(CREAM) === 3500 && stock(CARAMEL) === 2500, 'P2 2× batch: sugar −1,000, cream −400, caramel +2,000', [stock(SUGAR), stock(CREAM), stock(CARAMEL)]);
    const own = rows(`select scale, expected_yield, actual_yield, raw_cost_total, actual_cost_per_unit from production_batches where recipe_id='${CARAMEL_R}' and source='OWN' order by created_at`);
    ok(own.length === 2 && eq2(own[0].raw_cost_total, X.ownHalf) && eq2(own[1].raw_cost_total, X.ownDouble) && Number(own[0].scale) === 0.5 && Number(own[1].scale) === 2
      && eq6(own[0].actual_cost_per_unit, 0.09) && eq6(own[1].actual_cost_per_unit, 0.09), 'own batches cost 45.00 and 180.00 (₱0.09 / mL), sizes 0.5 and 2 saved', own);
    await produce({scale: 1, partner: true});
    ok(stock(SUGAR) === 750 && stock(CREAM) === 3500 && stock(CARAMEL) === 3500, 'T1 TCO batch 1×: caramel +1,000, OUR sugar and cream untouched', [stock(SUGAR), stock(CREAM), stock(CARAMEL)]);
    await produce({scale: 0.5, partner: true, pesos: true});
    ok(stock(SUGAR) === 750 && stock(CREAM) === 3500 && stock(CARAMEL) === 4000, 'T2 TCO batch ½× (pesos): caramel +500, our stock untouched', [stock(SUGAR), stock(CREAM), stock(CARAMEL)]);
    const debts = rows(`select d.kind, d.status, d.value, d.amount_owed, d.amount_paid, b.raw_cost_total, b.actual_cost_per_unit, b.scale from partner_debts d join production_batches b on b.id = d.batch_id order by d.created_at`);
    ok(debts.length === 2 && debts[0].kind === 'INGREDIENTS' && eq2(debts[0].value, X.tcoIng) && eq2(debts[0].raw_cost_total, X.tcoIng)
      && debts[1].kind === 'PESOS' && eq2(debts[1].amount_owed, X.tcoPesos) && eq2(debts[1].raw_cost_total, X.tcoPesos)
      && eq6(debts[0].actual_cost_per_unit, 0.09) && eq6(debts[1].actual_cost_per_unit, 0.09), 'TCO batches: cost = what we owe (90.00 in ingredients, ₱45.00), ₱0.09 / mL like our own', debts);
    ok(sql(`select count(*) from inventory_transactions where transaction_type='PRODUCTION_USE' and ingredient_id in ('${SUGAR}','${CREAM}')`) === '4', 'ingredients taken only for the two own batches (4 lines)');

    /* ---------- return 300 g sugar, pay ₱20 ---------- */
    await bo.waitForSelector('#to-return-list');
    await bo.click('[data-debt-return]'); await bo.waitForSelector('#pr-ret-save');
    await bo.fill(`[data-ret="${SUGAR}"]`, '300'); await bo.fill(`[data-ret="${CREAM}"]`, '');
    await bo.click('#pr-ret-save'); await gone(bo); await bo.waitForTimeout(700);
    ok(stock(SUGAR) === 450 && stock(CREAM) === 3500, 'RET: 300 g sugar left our stock', [stock(SUGAR), stock(CREAM)]);
    ok(sql(`select string_agg(transaction_type || ':' || quantity::numeric(12,2), ',') from inventory_transactions where ingredient_id='${SUGAR}' and transaction_type not in ('PURCHASE','PRODUCTION_USE')`) === 'PARTNER_RETURN:300.00', '... as one "Returned to partner" line (no waste, no usage)');
    await bo.waitForSelector('[data-debt-pay]');
    await bo.click('[data-debt-pay]'); await bo.waitForSelector('#pp-save');
    await bo.fill('#pp-amount', '20'); await bo.click('#pp-save'); await gone(bo); await bo.waitForTimeout(700);
    ok(eq2(sql(`select amount_paid from partner_debts where kind='PESOS'`), X.paid) && sql(`select count(*) from expenses`) === '0', 'PAY: ₱20.00 recorded on the debt, no expense row');

    /* ---------- R&D usage ---------- */
    await go('rnd');
    await bo.click('#btn-rnd-log'); await bo.waitForSelector('#ru-save');
    await bo.selectOption('#ru-rows tr[data-k="0"] [data-ru-id]', CARAMEL); await bo.fill('#ru-rows tr[data-k="0"] [data-ru-qty]', '100');
    await bo.click('#ru-add'); await bo.waitForSelector('#ru-rows tr[data-k="1"]');
    await bo.selectOption('#ru-rows tr[data-k="1"] [data-ru-id]', SUGAR); await bo.fill('#ru-rows tr[data-k="1"] [data-ru-qty]', '50');
    await bo.click('#ru-save'); await gone(bo); await bo.waitForTimeout(700);
    const rl = one(`select total_cost, rnd_project_id from waste_logs where reason='RND'`);
    ok(rl && eq2(rl.total_cost, X.rnd) && rl.rnd_project_id === PROJ && stock(CARAMEL) === 3900 && stock(SUGAR) === 400, 'RND: caramel 100 mL + sugar 50 g = 14.00, off stock', [rl, stock(CARAMEL), stock(SUGAR)]);

    /* ---------- waste: record + edit, record + delete ---------- */
    const recordWaste = async (ing, qty, note) => {
      await go('inventory');
      await bo.click('#btn-new-waste'); await bo.waitForSelector('#w-ing');
      await bo.selectOption('#w-ing', ing); await bo.fill('#w-qty', String(qty)); await bo.fill('#w-notes', note);
      await bo.click('#btn-save-waste'); await gone(bo); await bo.waitForTimeout(500);
      return sql(`select id from waste where ingredient_id='${ing}' order by created_at desc limit 1`);
    };
    const w1 = await recordWaste(CREAM, 100, 'money15 W1');
    ok(stock(CREAM) === 3400, 'W1: cream 100 mL wasted', stock(CREAM));
    const w2 = await recordWaste(SUGAR, 40, 'money15 W2');
    ok(stock(SUGAR) === 360, 'W2: sugar 40 g wasted', stock(SUGAR));
    let wr = await rpc('waste_report', {p_from: today, p_to: today});
    ok(eq2(wr.total_cost, 14 + 20 + 4), 'waste report before the changes: 14.00 + 20.00 + 4.00 = 38.00', wr.total_cost);
    await go('wasteReport'); await bo.waitForSelector(`[data-wr-edit="${w1}"]`);
    await bo.click(`[data-wr-edit="${w1}"]`); await bo.waitForSelector('#we-save');
    await bo.fill('[data-we-q="0"]', '150'); await bo.fill('#we-why', 'money15: it was 150 mL');
    await bo.click('#we-save'); await gone(bo); await bo.waitForTimeout(900);
    ok(stock(CREAM) === X.cream, 'W1 edited to 150 mL: cream is 150 mL down in all (3,350 mL)', stock(CREAM));
    ok(sql(`select count(*) from inventory_transactions where reference_id='${w1}'`) === '1' && Number(sql(`select quantity from inventory_transactions where reference_id='${w1}'`)) === 150, '... one stock line of 150 mL (the old 100 mL line replaced, not added to)');
    await bo.waitForSelector(`[data-wr-del="${w2}"]`);
    await bo.click(`[data-wr-del="${w2}"]`); await bo.waitForSelector('#wd-ok');
    await bo.fill('#wd-why', 'money15: logged by mistake'); await bo.click('#wd-ok'); await gone(bo); await bo.waitForTimeout(900);
    ok(stock(SUGAR) === 400 && sql(`select count(*) from waste where id='${w2}'`) === '0' && sql(`select count(*) from inventory_transactions where reference_id='${w2}'`) === '0', 'W2 deleted: sugar back to 400 g, its row and stock line gone', stock(SUGAR));
    ok(sql(`select string_agg(action, ',' order by at) from audit_log where reference_id in ('${w1}','${w2}') and action in ('Waste edited','Waste deleted')`) === 'Waste edited,Waste deleted', 'audit: Waste edited + Waste deleted');

    /* ---------- counter: blind count (20 g sugar missing, 50 mL caramel extra), close shift ---------- */
    const fctx = await browser.newContext({viewport: {width: 1280, height: 800}, timezoneId: 'Asia/Manila'});
    const fo = await fctx.newPage(); H.attach(fo, errors, 'FO');
    fctx.on('page', p => { if(p !== fo) p.waitForLoadState().then(() => p.close()).catch(() => {}); });
    await H.pairCounter(fo, 'TESTAB');
    await typePin(fo, '1111');
    await H.startShift(fo, 1000);
    ok(await fo.evaluate(([s, c]) => state.stock[s] === 400 && state.stock[c] === 3900, [SUGAR, CARAMEL]), 'counter starts with sugar 400 g, caramel 3,900 mL on its copy');
    await fo.click('.nav-item[data-route="shift"]'); await fo.waitForTimeout(300);
    await fo.click('#close-shift-btn');
    await fo.waitForSelector('#count-next', {timeout: 15000});
    const names = await fo.$$eval('#count-lines .count-line b', bs => bs.map(b => b.textContent).sort());
    const listText = await fo.evaluate(() => document.getElementById('active-modal-overlay').innerText);
    ok(JSON.stringify(names) === JSON.stringify(['M15 Caramel sauce', 'M15 Sugar']) && !/400|3,?900/.test(listText), 'count list: the two ticked items, no expected amounts on the screen', listText.slice(0, 300));
    await fo.fill(`[data-cqty="${SUGAR}"]`, '380'); await fo.fill(`[data-cqty="${CARAMEL}"]`, '3950');
    await fo.click('#count-next');
    await fo.waitForSelector('#recount-ok');
    const reText = await fo.evaluate(() => document.getElementById('active-modal-overlay').innerText);
    ok(!/400|3,?900|\b20\b|\b50\b|missing|extra|short|more|less/i.test(reText.replace(/380|3950/g, '')), 'double-check: says the items differ, not by how much or which way', reText.slice(0, 400));
    await fo.click('#recount-ok');
    await fo.waitForSelector('#cs-confirm');
    await fo.fill('#cs-declared', '1000');
    await fo.click('#cs-confirm');
    await fo.waitForSelector('[data-done]', {timeout: 15000});
    await fo.click('[data-done]');
    await must(() => sql(`select count(*) from shifts where status='CLOSED' and device_id is not null and closed_at > now() - interval '5 minutes'`) === '1', 'shift closed on the server (count uploaded first)', 30000);
    const sc = one(`select id, status, needs_review, review_reason, shortage_cost from stock_counts`);
    const scl = rows(`select name, counted, expected, difference, cost from stock_count_lines where count_id='${sc && sc.id}' order by name`);
    ok(sc && scl.length === 2 && eq6(scl[0].expected, 3900) && eq6(scl[0].difference, 50) && eq6(scl[1].expected, 400) && eq6(scl[1].difference, -20), 'server count: caramel expected 3,900 (+50), sugar expected 400 (−20)', scl);
    ok(sc && eq2(sc.shortage_cost, X.shortage) && sc.needs_review === true && /COUNT_EXTRA/.test(sc.review_reason || '') && !/LARGE_SHORTAGE/.test(sc.review_reason || ''), 'missing value 2.00; flagged COUNT_EXTRA for the owner', sc);
    const cw = rows(`select reason, total_cost from waste_logs where stock_count_id='${sc && sc.id}'`);
    ok(cw.length === 1 && cw[0].reason === 'COUNT_SHORTAGE' && eq2(cw[0].total_cost, X.shortage), 'one "Missing at count" waste entry of 2.00 (the extra is NOT negative waste)', cw);
    ok(sql(`select string_agg(transaction_type || ':' || quantity::numeric(12,2), ',' order by transaction_type) from inventory_transactions where reference_id='${sc && sc.id}'`) === 'ADJUSTMENT:50.00,WASTE:20.00', 'count stock lines: WASTE 20 g sugar, ADJUSTMENT +50 mL caramel');
    const sh = one(`select opening_cash, expected_cash, declared_cash, cash_variance from shifts where status='CLOSED' and device_id is not null order by closed_at desc limit 1`);
    ok(sh && eq2(sh.expected_cash, 1000) && eq2(sh.declared_cash, 1000) && eq2(sh.cash_variance, 0), 'shift: expected cash 1,000.00, counted 1,000.00, variance 0', sh);
    await fctx.close();

    /* ---------- reconciliation ---------- */
    ok(stock(SUGAR) === X.sugar && stock(CREAM) === X.cream && stock(CARAMEL) === X.caramel, 'STOCK: sugar 380 g, cream 3,350 mL, caramel 3,950 mL (hand math)', [stock(SUGAR), stock(CREAM), stock(CARAMEL)]);
    wr = await rpc('waste_report', {p_from: today, p_to: today});
    const byReason = Object.fromEntries((wr.by_reason || []).map(x => [x.reason, Number(x.cost)]));
    ok(eq2(wr.total_cost, X.waste), 'WASTE REPORT total 46.00', wr.total_cost);
    ok(eq2(byReason.RND, X.rnd) && eq2(byReason.Expired, X.office) && eq2(byReason.COUNT_SHORTAGE, X.shortage) && Object.keys(byReason).length === 3, '... by reason: R&D 14.00, Expired 30.00, Missing at count 2.00, nothing else', byReason);
    ok((wr.by_project || []).length === 1 && wr.by_project[0].project_id === PROJ && eq2(wr.by_project[0].cost, X.rnd), '... R&D by project: Ube latte 14.00', wr.by_project);
    const e1 = (wr.entries || []).find(e => e.id === w1), eShort = (wr.entries || []).find(e => e.reason === 'COUNT_SHORTAGE');
    ok(wr.entries.length === 3 && e1 && e1.edited === true && e1.edit_note === 'money15: it was 150 mL' && eq2(e1.cost, 30) && !wr.entries.some(e => e.id === w2), '... 3 entries: W1 marked Edited (30.00), the deleted W2 not listed', (wr.entries || []).map(e => [e.reason, e.cost, e.edited]));
    ok(eShort && eShort.editable === false && eShort.source === 'COUNTER', '... the count shortage is not editable here (revise its count)', eShort);
    ok(eq2((wr.entries || []).reduce((s, e) => s + Number(e.cost), 0), X.waste) && eq2((wr.by_day || []).reduce((s, d) => s + Number(d.cost), 0), X.waste), '... entries and days both add up to 46.00');
    // every WASTE stock line, costed by hand, is the same 46.00 (nothing counted twice, nothing left out)
    const lines = rows(`select ingredient_id, sum(quantity) as q from inventory_transactions where business_id='${biz}' and transaction_type='WASTE' group by ingredient_id`);
    const unit = {[SUGAR]: 0.10, [CREAM]: 0.20, [CARAMEL]: 0.09};
    ok(lines.length === 3 && eq2(lines.reduce((s, l) => s + Number(l.q) * unit[l.ingredient_id], 0), X.waste), 'WASTE stock lines × hand costs = 46.00 (sugar 70 g, cream 150 mL, caramel 100 mL)', lines);
    const ni = await rpc('net_income_report', {p_month: today.slice(0, 7) + '-01'});
    ok(eq2(ni.sales.gross, 0) && eq2(ni.ingredients.sold, 0) && eq2(ni.ingredients.wasted, X.waste) && eq2(ni.ingredients.used, X.waste), 'NET INCOME: no sales, ingredients wasted 46.00 = the waste report', ni.ingredients);
    ok(eq2(ni.ingredients.rnd, X.rnd) && eq2(ni.ingredients.count_shortage, X.shortage) && (ni.rnd_projects || []).length === 1 && eq2(ni.rnd_projects[0].cost, X.rnd), '... of which R&D 14.00 (Ube latte) and missing at count 2.00, inside the 46.00', [ni.ingredients, ni.rnd_projects]);
    ok(eq2(ni.expenses.total, 0) && eq2(ni.net_income, X.netIncome), '... expenses 0.00 (the ₱20 payment is not one); net income −46.00', [ni.expenses, ni.net_income]);
    ok(eq2(ni.net_income, -(Number(ni.ingredients.used) + Number(ni.expenses.total))), '... no double counting: net income = −(ingredients used + expenses); the return (30.00), the payment (20.00) and the TCO batches (135.00) are not in it');
    const owed = rows(`select kind, ingredient_id, remaining, value_remaining from v_partner_to_return order by kind, ingredient_name`);
    const ing = owed.filter(o => o.kind === 'INGREDIENTS'), pes = owed.filter(o => o.kind === 'PESOS');
    ok(ing.length === 2 && eq6(ing.find(o => o.ingredient_id === CREAM).remaining, 200) && eq6(ing.find(o => o.ingredient_id === SUGAR).remaining, 200)
      && eq2(ing.reduce((s, o) => s + Number(o.value_remaining), 0), X.owedIng), 'TO RETURN: sugar 200 g + cream 200 mL still owed (60.00)', ing);
    ok(pes.length === 1 && eq2(pes[0].remaining, X.owedPesos) && eq2(pes[0].value_remaining, X.owedPesos), 'TO RETURN: ₱25.00 still owed', pes);
    // the Back Office screens show the same numbers
    await go('wasteReport'); await bo.waitForSelector('.wr-entries');
    const wrText = await bo.textContent('#content');
    ok(/₱46\.00/.test(wrText) && /Edited/.test(wrText) && /Missing at count/.test(wrText), 'Waste report screen: ₱46.00, Edited mark, Missing at count', wrText.slice(0, 300));
    await go('netIncome'); await bo.waitForSelector('#ni-body'); await bo.waitForTimeout(600);
    const niText = (await bo.textContent('#ni-body')).replace(/\s+/g, ' ');
    ok(/46\.00/.test(niText) && /R&D/.test(niText) && /missing at count/i.test(niText), 'Net income screen: 46.00 wasted with the R&D and missing-at-count parts', niText.slice(0, 500));
    await go('production'); await bo.waitForSelector('#to-return-list');
    const trText = (await bo.textContent('#prod-to-return')).replace(/\s+/g, ' ');
    ok(/₱85\.00/.test(trText) && /₱25\.00/.test(trText), 'Production screen: "To return to TCO" worth ₱85.00, ₱25.00 of the pesos left', trText.slice(0, 300));
    await H.shot(bo, 'money15-to-return', {fullPage: true});
    ok(errors.length === 0, 'no browser errors', errors);
  }catch(e){ H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})();
