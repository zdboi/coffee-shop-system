// Back Office release 1.4 checks (adopted from back-office-dev's bo14.e2e.js, 2026-11-03).
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo_release14.e2e.js
const path = require('path');
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {ok, sql, one, rows} = H;
const SH = path.join(H.SHOTS, 'bo14') + '/';
require('fs').mkdirSync(SH, {recursive: true});
const MILK = '22222222-0000-0000-0000-000000000002', BEANS = '22222222-0000-0000-0000-000000000001';
const LATTE = '33333333-0000-0000-0000-000000000001', AMER = '33333333-0000-0000-0000-000000000003';
const ARLA = '2414aaaa-0000-0000-0000-000000000001', OAT = '2414aaaa-0000-0000-0000-000000000002', CUP = '2414aaaa-0000-0000-0000-000000000003',
  LID = '2414aaaa-0000-0000-0000-000000000004', FOIL = '2414aaaa-0000-0000-0000-000000000005', CARAMEL = '2414aaaa-0000-0000-0000-000000000006', SUGAR = '2414aaaa-0000-0000-0000-000000000007';
const CARAMEL_R = '3414aaaa-0000-0000-0000-000000000001';
function seed(){
  const biz = sql(`select id from businesses limit 1`);
  sql(`insert into categories(id, business_id, name) values ('c414aaaa-0000-0000-0000-000000000001','${biz}','Others') on conflict do nothing`);
  sql(`insert into ingredients(id, business_id, name, base_unit, active, category_id) values
    ('${ARLA}','${biz}','Arla milk','L',true,null), ('${OAT}','${biz}','Oat milk','ml',true,null),
    ('${CUP}','${biz}','Hot cup 12oz','pcs',true,null), ('${LID}','${biz}','Cup lid','pcs',true,null),
    ('${FOIL}','${biz}','Aluminium foil','pcs',true,'c414aaaa-0000-0000-0000-000000000001'), ('${SUGAR}','${biz}','Sugar','g',true,null) on conflict do nothing`);
  sql(`insert into purchases(id, business_id, ingredient_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit) values
    ('5414aaaa-0000-0000-0000-000000000001','${biz}','${ARLA}', current_date, 2, 'L', 2, 200, 100) on conflict do nothing`);
  sql(`insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date) values
    ('${biz}','${ARLA}','PURCHASE',2,'5414aaaa-0000-0000-0000-000000000001',current_date), ('${biz}','${CUP}','INITIAL_STOCK',100,null,current_date), ('${biz}','${LID}','INITIAL_STOCK',100,null,current_date), ('${biz}','${OAT}','INITIAL_STOCK',1000,null,current_date)`);
  // a house-made caramel (L) with its production recipe
  sql(`insert into recipes(id, business_id, name, recipe_type, selling_price, is_production_recipe, expected_yield, yield_unit, active) values ('${CARAMEL_R}','${biz}','Caramel sauce','SAUCES_SYRUPS',0,true,1,'L',true) on conflict do nothing`);
  sql(`insert into ingredients(id, business_id, name, base_unit, is_produced_item, source_recipe_id, active) values ('${CARAMEL}','${biz}','Caramel sauce','L',true,'${CARAMEL_R}',true) on conflict do nothing`);
  sql(`update recipes set produced_ingredient_id='${CARAMEL}' where id='${CARAMEL_R}'`);
  sql(`insert into recipe_ingredients(business_id, recipe_id, ingredient_id, quantity, unit) values ('${biz}','${CARAMEL_R}','${SUGAR}',500,'g')`);
  // a counter waste log flagged for review (with an option label that must be escaped)
  sql(`insert into waste_logs(id, business_id, staff_name, reason, note, logged_at, waste_date, total_cost, needs_review, review_reason) values
    ('7414aaaa-0000-0000-0000-000000000001','${biz}','Cathy <b>X</b>','SPILLAGE','<img src=x onerror=alert(1)>', now(), current_date, 12.5, true, 'STAFF_MISMATCH,FUTURE_DATE'),
    ('7414aaaa-0000-0000-0000-000000000002','${biz}','Mike','COMPLIMENTARY',null, now(), current_date, 40, false, null) on conflict do nothing`);
  sql(`insert into waste_log_items(business_id, waste_log_id, recipe_id, name, quantity, modifiers, cost) values
    ('${biz}','7414aaaa-0000-0000-0000-000000000001','${LATTE}','Iced Latte',1,'[{"group":"Size","label":"<script>x</script>"}]',12.5),
    ('${biz}','7414aaaa-0000-0000-0000-000000000002','${AMER}','Americano',1,'[]',40)`);
  return biz;
}
(async () => {
  const biz = seed();
  const browser = await chromium.launch();
  const errors = [];
  const open = async (vp) => {
    const ctx = await browser.newContext({viewport: vp, timezoneId: 'Asia/Manila', acceptDownloads: true});
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror ' + e.message));
    page.on('console', m => { if(m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
    page.on('dialog', d => { errors.push('dialog ' + d.message()); d.dismiss(); });
    await H.boLogin(page); await page.waitForTimeout(800);
    return {ctx, page};
  };
  const go = async (page, r, p) => { await page.evaluate(([r, p]) => navigate(r, p), [r, p == null ? null : p]); await page.waitForTimeout(700); };
  const gone = async (page) => H.until(async () => !(await page.$('#active-modal-overlay')), 15000);
  const shot = (page, n) => page.screenshot({path: SH + n + '.png', fullPage: true});
  try{
    const {page} = await open({width: 1280, height: 860});

    /* ---- A9 option library ---- */
    await go(page, 'recipes');
    await page.click('#btn-option-library'); await page.waitForTimeout(500);
    ok(await page.$('[data-starter="hoticed"]'), 'library: starter buttons shown');
    ok((await page.$$eval('#lib-list .lib-card', n => n.length)) === 0, 'library: no group made automatically');
    await shot(page, 'lib-empty-1280');
    await page.click('[data-starter="hoticed"]'); await page.waitForSelector('#lg-name');
    ok((await page.inputValue('#lg-name')) === 'Hot or iced' && await page.isChecked('#lg-req'), 'starter fills Hot or iced (required)');
    await page.click('#lg-save'); await gone(page);
    const hi = one(`select * from option_groups where name='Hot or iced'`);
    ok(hi && hi.required && hi.options.length === 2, 'Hot or iced saved', hi);
    const latte = one(`select modifier_groups from recipes where id='${LATTE}'`);
    ok(latte.modifier_groups.some(g => g.id === 'lib_' + hi.id), 'Iced Latte got the library group (database)');
    // take-away cup with two extras
    await page.click('[data-starter="cup"]'); await page.waitForSelector('#lg-name');
    const o1 = '#lg-opts .lib-opt:nth-child(1)';
    await page.selectOption(o1 + ' .lib-extra:nth-child(1) .lx-ing', CUP); await page.fill(o1 + ' .lib-extra:nth-child(1) .lx-qty', '1');
    if(!(await page.$(o1 + ' .lib-extra:nth-child(2)'))) await page.click(o1 + ' .lx-add');
    await page.selectOption(o1 + ' .lib-extra:nth-child(2) .lx-ing', LID); await page.fill(o1 + ' .lib-extra:nth-child(2) .lx-qty', '1');
    // second option: remove it to keep it simple
    await page.click('#lg-opts .lib-opt:nth-child(2) .lo-rm');
    await shot(page, 'lib-form-cup-1280');
    await page.click('#lg-save'); await gone(page);
    const cupG = one(`select * from option_groups where name='Take-away cup'`);
    ok(cupG && cupG.options[0].extras.length === 2, 'cup option has cup + lid extras', cupG && cupG.options);
    // swap Milk -> Oat
    await page.click('[data-starter="nondairy"]'); await page.waitForSelector('#lg-name');
    await page.selectOption('#lg-opts .lib-opt:nth-child(1) .ls-from', MILK);
    await page.selectOption('#lg-opts .lib-opt:nth-child(1) .ls-to', OAT);
    await page.click('#lg-save'); await gone(page);
    const sw = one(`select * from option_groups where name='Milk'`);
    ok(sw && sw.options[0].kind === 'SWAP' && Number(sw.options[0].price_delta) === 30, 'swap saved with one price', sw && sw.options);
    const latte2 = one(`select modifier_groups from recipes where id='${LATTE}'`).modifier_groups;
    const swapOpt = latte2.find(g => g.library_group_id === sw.id);
    ok(swapOpt && swapOpt.options[0].removes[0].ingredient_id === MILK, 'Iced Latte (uses milk) gets the swap with removes', latte2);
    // a bad group from the form: same option twice
    await page.click('#btn-new-libgroup'); await page.waitForSelector('#lg-name');
    await page.fill('#lg-name', 'Bad');
    await page.fill('#lg-opts .lib-opt:nth-child(1) .lo-label', 'Same'); await page.fill('#lg-opts .lib-opt:nth-child(2) .lo-label', 'same');
    await page.click('#lg-save'); await page.waitForTimeout(500);
    ok(/no two options/i.test(await page.textContent('#lg-problem')), 'form check (optionGroupProblem): duplicate label in plain words', await page.textContent('#lg-problem'));
    await page.click('[data-cancel]'); await gone(page);
    await page.waitForTimeout(300);
    await shot(page, 'lib-list-1280');
    // per item untick in the recipe form (Americano: untick Hot or iced)
    await go(page, 'recipeDetail', AMER);
    await page.click('#edit-rec-btn'); await page.waitForSelector('#lib-ticks');
    const libGroupsInEditor = await page.$$eval('#mod-editor .mod-ed-group .mg-name', n => n.map(x => x.value));
    ok(!libGroupsInEditor.includes('Hot or iced'), 'library groups are not editable inside the recipe', libGroupsInEditor);
    ok(await page.isChecked(`[data-lib-tick="${hi.id}"]`), 'Hot or iced ticked (default for drinks)');
    await page.uncheck(`[data-lib-tick="${hi.id}"]`);
    await shot(page, 'recipe-form-ticks-1280');
    await page.click('#btn-save-rec'); await gone(page);
    ok(one(`select mode from option_group_recipes where group_id='${hi.id}' and recipe_id='${AMER}'`)?.mode === 'EXCLUDE', 'untick saved as EXCLUDE');
    ok(!one(`select modifier_groups from recipes where id='${AMER}'`).modifier_groups.some(g => g.library_group_id === hi.id), 'Americano no longer has Hot or iced');
    await shot(page, 'recipe-detail-1280');

    /* ---- A10 weighs ---- */
    await go(page, 'ingredientDetail', CARAMEL);
    await page.click('#edit-ing-btn'); await page.waitForSelector('#f-weighs');
    await page.fill('#f-weighs', '1250');
    await shot(page, 'weighs-form-1280');
    await page.click('#btn-save-ing'); await gone(page);
    ok(Number(sql(`select weight_g_per_ml from ingredients where id='${CARAMEL}'`)) === 1.25, '1 L weighs 1250 g saved as 1.25 g/mL');
    // recipe line in g for caramel on Iced Latte
    await go(page, 'recipeDetail', LATTE);
    await page.click('#edit-rec-btn'); await page.waitForSelector('#ri-body tr');
    await page.click('#ri-add-row');
    const last = '#ri-body tr:last-child';
    await page.selectOption(last + ' .ri-ing', CARAMEL);
    const units = await page.$$eval(last + ' .ri-unit option', o => o.map(x => x.value));
    ok(units.includes('g') && units.includes('ml'), 'caramel line offers g and mL', units);
    await page.selectOption(last + ' .ri-unit', 'g'); await page.fill(last + ' .ri-qty', '25');
    ok(/saved as 0\.02 L/.test(await page.textContent(last + ' .ri-saved')), 'hint: 25 g saved as 0.02 L', await page.textContent(last + ' .ri-saved'));
    await page.click('#btn-save-rec'); await gone(page);
    const cl = one(`select quantity, entered_quantity, unit from recipe_ingredients where recipe_id='${LATTE}' and ingredient_id='${CARAMEL}'`);
    ok(cl && Number(cl.entered_quantity) === 25 && cl.unit === 'g' && Math.abs(Number(cl.quantity) - 0.02) < 1e-6, 'line sent as 25 g, database stored 0.02 L', cl);
    ok(one(`select modifier_groups from recipes where id='${LATTE}'`).modifier_groups.some(g => g.library_group_id === hi.id), 'Iced Latte keeps the library group after a save');

    /* ---- A8 supplied item ---- */
    await go(page, 'recipes');
    await page.click('#btn-new-supplied'); await page.waitForSelector('#si-name');
    await page.fill('#si-name', 'Ube Cheese Pandesal'); await page.fill('#si-sub', 'Bread');
    await page.fill('#si-cost', '25'); await page.fill('#si-price', '45');
    await page.waitForTimeout(200);
    ok(/₱20\.00/.test(await page.textContent('#si-margin')) && /44\.4%/.test(await page.textContent('#si-margin')), 'margin shown live (₱20, 44.4%)', await page.textContent('#si-margin'));
    await page.fill('#si-rq', '24');
    await shot(page, 'supplied-form-1280');
    await page.click('#si-save'); await gone(page); await page.waitForTimeout(500);
    const sr = one(`select r.id, r.supplied_ingredient_id, r.selling_price, i.base_unit, (select standard_cost from ingredient_costs c where c.ingredient_id=i.id) as standard_cost from recipes r join ingredients i on i.id=r.supplied_ingredient_id where r.name='Ube Cheese Pandesal'`);
    ok(sr && sr.base_unit === 'pcs' && Number(sr.standard_cost) === 25, 'supplied item created (pcs, standard_cost 25)', sr);
    ok(Number(sql(`select coalesce(sum(quantity),0) from inventory_transactions where ingredient_id='${sr.supplied_ingredient_id}'`)) === 24, 'restock of 24 pcs recorded');
    ok(/Margin per piece/.test(await page.textContent('#content')), 'opens the supplied item page with margin');
    await shot(page, 'supplied-detail-1280');
    await go(page, 'recipes');
    ok(/Supplied · 24 pcs/.test(await page.textContent('#rec-grid-wrap')), 'recipe list marks supplied items');
    await page.click(`.rec-card[data-id="${sr.id}"]`); await page.waitForTimeout(500);
    await page.click('#edit-rec-btn'); await page.waitForSelector('#si-name');
    ok((await page.inputValue('#si-name')) === 'Ube Cheese Pandesal', 'editing opens the supplied-item form');
    await page.fill('#si-price', '50'); await page.click('#si-save'); await gone(page);
    ok(Number(sql(`select selling_price from recipes where id='${sr.id}'`)) === 50, 'supplied item edit saved');

    /* ---- A12 merge ---- */
    await go(page, 'ingredients');
    // conflict: Milk + Oat (swap from/to)
    await page.check(`[data-ing-pick="${MILK}"]`); await page.check(`[data-ing-pick="${OAT}"]`);
    await page.click('#ing-merge-picked'); await page.waitForSelector('#mg-name');
    await page.fill('#mg-name', 'All milk');
    await page.click('#mg-preview-btn'); await page.waitForTimeout(800);
    ok(/swap an ingredient for itself/i.test(await page.textContent('#mg-preview')), 'MERGE_SWAP_CONFLICT in plain words', await page.textContent('#mg-preview'));
    ok(await page.isDisabled('#mg-go'), 'Merge button stays off after an error');
    await shot(page, 'merge-conflict-1280');
    await page.click('[data-cancel]'); await gone(page);
    await go(page, 'ingredients');
    await page.evaluate(() => { ingPicked.clear(); renderIngredientsTable(); });
    await page.check(`[data-ing-pick="${MILK}"]`); await page.check(`[data-ing-pick="${ARLA}"]`);
    await page.click('#ing-merge-picked'); await page.waitForSelector('#mg-name');
    await page.fill('#mg-name', 'Full Cream Milk');
    await page.fill(`[data-mg-brand="${MILK}"]`, 'Laciate');
    await page.click('#mg-preview-btn'); await page.waitForSelector('.mg-plan');
    const pv = await page.textContent('.mg-plan');
    ok(/Full Cream Milk/.test(pv) && /Laciate/.test(pv) && /Arla milk/.test(pv) && /Iced Latte/.test(pv), 'preview lists brands and recipes', pv.replace(/\s+/g, ' ').slice(0, 400));
    ok(/×1000|= 2000 mL/.test(pv), 'preview shows L converted to mL', pv.replace(/\s+/g, ' ').slice(0, 600));
    await shot(page, 'merge-preview-1280');
    await page.click('#mg-go'); await gone(page); await page.waitForTimeout(800);
    const G = one(`select id, base_unit from ingredients where name='Full Cream Milk' and merged_into is null`);
    ok(G && G.base_unit === 'ml', 'general ingredient made in mL', G);
    ok(sql(`select count(*) from ingredients where merged_into='${G.id}'`) === '2', 'both picked ingredients merged into it');
    ok(sql(`select count(*) from recipe_ingredients where ingredient_id='${MILK}'`) === '0', 'recipe lines repointed');
    await go(page, 'ingredients');
    ok(!(await page.textContent('#ing-table-wrap')).includes('Arla milk'), 'merged ingredients hidden from the list');
    await page.check('#ing-inactive'); await page.waitForTimeout(300);
    ok(/Merged into Full Cream Milk/.test(await page.textContent('#ing-table-wrap')), 'Show inactive: "Merged into Full Cream Milk"');
    await shot(page, 'ingredients-merged-1280');
    await page.uncheck('#ing-inactive');
    // pickers hide merged ones
    const pickOk = await page.evaluate((m) => !ingredientPickerList().some(i => i.id === m), MILK);
    ok(pickOk, 'pickers hide merged ingredients');

    /* ---- A11 operating supplies ---- */
    const opsCat = one(`select id, kind from categories where name='Operating supplies'`);
    ok(opsCat && opsCat.kind === 'EXPENSE', 'Operating supplies category exists (EXPENSE)', opsCat);
    await page.click('#btn-manage-categories'); await page.waitForSelector('[data-cat-move]');
    await shot(page, 'categories-1280');
    await page.click(`[data-cat-move="c414aaaa-0000-0000-0000-000000000001"]`); await page.waitForSelector('#cm-to');
    await page.selectOption('#cm-to', opsCat.id); await page.check(`[data-cm="${FOIL}"]`);
    await page.click('#cm-go'); await page.waitForTimeout(1200);
    ok(sql(`select category_id from ingredients where id='${FOIL}'`) === opsCat.id, 'foil moved to Operating supplies');
    await page.click('[data-cancel]'); await gone(page);
    // buying foil -> expense
    await go(page, 'purchases');
    await page.click('#btn-new-purchase'); await page.waitForSelector('#p-ing');
    await page.selectOption('#p-ing', FOIL);
    ok(await page.isVisible('#p-expense-note'), 'purchase form says it becomes an expense');
    await page.fill('#p-price', '150'); await page.fill('#p-qty', '3');
    await page.click('#btn-save-pur'); await gone(page);
    ok(one(`select category, amount, ingredient_id from expenses where ingredient_id='${FOIL}'`)?.category === 'SUPPLIES', 'foil purchase saved as a SUPPLIES expense');
    ok(sql(`select count(*) from purchases where ingredient_id='${FOIL}'`) === '0', 'no stock purchase for foil');
    // expenses screen
    await go(page, 'expenses');
    await page.click('#btn-new-expense'); await page.waitForSelector('#ex-amount');
    await page.selectOption('#ex-cat', 'RENT'); await page.fill('#ex-amount', '12000'); await page.fill('#ex-note', '=HYPERLINK("x") rent');
    await page.click('#ex-save'); await gone(page); await page.waitForTimeout(800);
    ok(/₱12,150\.00/.test(await page.textContent('#exp-body')), 'expenses list total ₱12,150', (await page.textContent('#exp-body')).slice(0, 200));
    await shot(page, 'expenses-1280');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exp-csv')]);
    const csv = require('fs').readFileSync(await dl.path(), 'utf8');
    ok(/"'=HYPERLINK/.test(csv), 'expenses CSV is formula-safe', csv.slice(0, 300));
    // receipt photo: upload (private bucket, path only), view (cloud.download), replace -> old file removed, delete -> removed
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const rent = one(`select id from expenses where category='RENT'`).id;
    const storeReq = []; page.on('request', q => { if(/\/storage\/v1\/object\//.test(q.url())) storeReq.push(q.method() + ' ' + q.url().replace(/^https?:\/\/[^/]+/, '') + ' ' + (q.postData() && q.method() === 'DELETE' ? q.postData() : '')); });
    await page.click(`[data-exp-edit="${rent}"]`); await page.waitForSelector('#ex-amount');
    await page.setInputFiles('#ex-photo', {name: 'r.png', mimeType: 'image/png', buffer: png}); await page.waitForTimeout(400);
    await page.click('#ex-save'); await gone(page); await page.waitForTimeout(800);
    const ph1 = sql(`select photo_path from expenses where id='${rent}'`);
    ok(ph1.startsWith(biz + '/' + rent + '-') && !/^http/.test(ph1), "receipt saved as a path in the shop folder", ph1);
    await page.click(`[data-exp-photo="${rent}"]`); await page.waitForTimeout(800);
    ok(await page.$('.exp-receipt'), 'receipt opens (cloud.download)');
    await page.click('[data-cancel]'); await gone(page);
    await page.click(`[data-exp-edit="${rent}"]`); await page.waitForSelector('#ex-amount');
    await page.setInputFiles('#ex-photo', {name: 'r2.png', mimeType: 'image/png', buffer: png}); await page.waitForTimeout(400);
    await page.click('#ex-save'); await gone(page); await page.waitForTimeout(1000);
    const ph2 = sql(`select photo_path from expenses where id='${rent}'`);
    ok(ph2 !== ph1 && storeReq.some(r => /^DELETE/.test(r) && r.includes(ph1)), 'replacing the photo removes the old file', storeReq);
    await shot(page, 'expenses-photo-1280');
    const nDel = storeReq.filter(r => /^DELETE/.test(r)).length;
    await page.click(`[data-exp-del="${rent}"]`); await page.waitForSelector('[data-ok]'); await page.click('[data-ok]'); await page.waitForTimeout(1200);
    ok(sql(`select count(*) from expenses where id='${rent}'`) === '0' && storeReq.filter(r => /^DELETE/.test(r)).length > nDel, 'deleting the expense removes its photo', storeReq);
    await page.click('[data-exp-edit]'); await page.waitForSelector('#ex-amount'); await page.click('[data-cancel]'); await gone(page);
    // net income
    await go(page, 'netIncome'); await page.waitForTimeout(800);
    const ni = await page.textContent('#ni-body');
    ok(/Net income/.test(ni) && /Operating supplies/.test(ni) && /Tax collected/.test(ni), 'net income report shows lines', ni.replace(/\s+/g, ' ').slice(0, 300));
    const r = await page.evaluate(() => NET_LAST);
    ok(r && Math.abs(r.expenses.total - 150) < 0.01, 'net income: expenses 150 from the server (rent deleted above)', r && r.expenses);
    await shot(page, 'netincome-1280');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#ni-csv')]);
    ok(/Net income/.test(require('fs').readFileSync(await dl2.path(), 'utf8')), 'net income CSV downloads');

    /* ---- A15 waste report ---- */
    await go(page, 'wasteReport'); await page.waitForTimeout(1000);
    const wr = await page.textContent('#wr-body');
    ok(/Spillage/.test(wr) && /Complimentary/.test(wr), 'waste report by reason', wr.slice(0, 200));
    ok(/Recorded cashier differs/.test(wr) && /Dated in the future/.test(wr), 'review flags in plain words');
    ok(await page.$('#wr-body img') === null && await page.$('#wr-body script') === null && /<script>x<\/script>/.test(wr) && /<b>X<\/b>/.test(wr), 'stored text is escaped (shown as text)');
    await shot(page, 'waste-1280');

    /* ---- backup includes the new tables ---- */
    const bk = await page.evaluate(async () => { const b = await buildCloudBackup(); return Object.fromEntries(['option_groups','option_group_recipes','expenses','waste_logs','waste_log_items','ingredient_costs'].map(t => [t, (b.data[t] || []).length])); });
    ok(bk.option_groups === 3 && bk.expenses === 1 && bk.waste_logs === 2 && bk.waste_log_items === 2 && bk.option_group_recipes >= 1 && bk.ingredient_costs === 1, 'backup includes the 1.4 tables (incl. ingredient_costs)', bk);

    /* ---- 768 ---- */
    const {page: p2} = await open({width: 768, height: 1024});
    for(const r of ['optionLibrary', 'expenses', 'netIncome', 'wasteReport', 'ingredients']){ await go(p2, r); await p2.waitForTimeout(800); await shot(p2, r + '-768'); }
    const wide = await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    ok(!wide, '768: no sideways scrolling on the last screen');
    await go(p2, 'optionLibrary'); await p2.click('[data-lib-edit]'); await p2.waitForSelector('#lg-name'); await shot(p2, 'lib-form-768');
    await p2.click('[data-cancel]');
    await go(p2, 'recipes'); await p2.click('#btn-new-supplied'); await p2.waitForSelector('#si-name'); await shot(p2, 'supplied-form-768');
  }catch(e){ H.abort('bo14', e); }
  ok(!errors.length, 'no browser errors', errors);
  await browser.close();
  process.exit(H.summary('bo14'));
})();
