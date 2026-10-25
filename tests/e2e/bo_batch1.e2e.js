// Back Office batch 1 checks, on a fresh e2e seed (Espresso beans in g, Milk in ml; category Coffee):
//   A. category manager on Ingredients: Raw materials suggestion (one click), add (duplicates refused,
//      any letter case), rename (to a taken name refused), remove an unused one, remove a used one with
//      "move to" (ONE apply_changes call), House-Made can't be renamed/removed, "+ New category" in the
//      ingredient form refreshes its dropdown
//   B. units: starting stock typed in kg (base g); recipe line typed in L for an mL ingredient (saved in
//      base mL + unit L, re-opened the same); option extra in L (saved as base mL); waste in kg; adjustment
//      and stock count in L; production recipe yield edited in L; a batch typed in L
//   C. counter sale with the L option extra: stock goes down by the base mL amounts
//   D. tick-and-remove: deletable + history + produced recipes -> right ones deleted / hidden, one audit
//      entry "Recipes removed"; Cancel changes nothing
// Run:  tests/e2e_reset.sh && tests/restart_fake.sh && node tests/e2e/bo_batch1.e2e.js
//       (FAKE_PORT / FAKE_DB for another stand-in; BO_VIEWPORT=1280x900 default)
const H = require('./bo/bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo_batch1.e2e@' + H.sizeTag();
const {sql, rows, one, num, ok, until, must, confirm, toastText, clearToasts, go, modalGone} = H;
const SHOT = (p, n) => H.shot(p, 'bo-batch1-' + n);
const MILK = '22222222-0000-0000-0000-000000000002', BEANS = '22222222-0000-0000-0000-000000000001', COFFEE = '11111111-0000-0000-0000-000000000001';
const stock = (id) => Number(sql(`select coalesce((select stock from v_ingredient_stock where ingredient_id='${id}'), 0)`));
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
// The category manager saves, reloads, THEN draws itself again (a new window): wait for that new window
// before typing, or the text lands in the old box and is wiped (seen 2026-10-26, see the QA report).
async function managerRedrawn(page, action){
  const old = await page.$('#cat-new-name');
  await action();
  if(old) await page.waitForFunction((e) => !e.isConnected, old, {timeout: 15000});
  await page.waitForSelector('#cat-new-name', {timeout: 15000});
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await H.boContext(browser);
  const page = await ctx.newPage(); H.attach(page, errors, 'BO');
  const applyCalls = [];
  page.on('request', r => { if(/\/rpc\/apply_changes$/.test(r.url())) applyCalls.push(JSON.parse(r.postData() || '{}')); });
  await H.boLogin(page);
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  const cat = (name) => sql(`select coalesce(string_agg(id::text, ','), '') from categories where business_id='${biz}' and name='${name.replace(/'/g, "''")}'`);
  const catCount = () => Number(sql(`select count(*) from categories where business_id='${biz}'`));
  const audits = (action) => Number(sql(`select count(*) from audit_log where business_id='${biz}' and action='${action}'`));

  // ================= A. categories =================
  await go(page, 'ingredients');
  await page.click('#btn-manage-categories');
  await page.waitForSelector('#cat-new-name');
  ok(await page.isVisible('#cat-suggest') && /Raw materials/.test(await page.textContent('#cat-suggest')), 'categories: "Raw materials" is suggested when the shop has none');
  const houseRow = await page.$eval('#active-modal-overlay', (m) => {
    const tr = [...m.querySelectorAll('tr[data-cat-row]')].find(t => /House-Made/.test(t.textContent));
    return tr ? {rename: !!tr.querySelector('[data-cat-rename]'), remove: !!tr.querySelector('[data-cat-remove]'), text: tr.textContent} : null;
  });
  ok(houseRow && !houseRow.rename && !houseRow.remove, 'categories: "House-Made / Produced" has no Rename / Remove (kept for production)', houseRow);
  await SHOT(page, 'categories');
  let calls0 = applyCalls.length;
  await managerRedrawn(page, () => page.click('#cat-suggest-add'));
  await must(() => cat('Raw materials') !== '', '"Raw materials" added');
  ok(applyCalls.length === calls0 + 1 && !(await page.$('#cat-suggest')), 'categories: "Raw materials" added with one click (one call); the suggestion goes away');
  // add + duplicates
  await page.fill('#cat-new-name', '  Syrups   Extra ');
  await managerRedrawn(page, () => page.click('#cat-add'));
  await must(() => cat('Syrups Extra') !== '', 'Syrups Extra added');
  ok(true, 'categories: a new category is added (spaces tidied: "Syrups Extra")');
  const n1 = catCount(); calls0 = applyCalls.length;
  for(const dup of ['syrups extra', 'RAW MATERIALS', 'coffee']){
    await clearToasts(page);
    await page.fill('#cat-new-name', dup); await page.click('#cat-add');
    const t = await toastText(page, 'error').catch(() => '');
    ok(/already a category called/.test(t), `categories: "${dup}" refused as a duplicate (letter case ignored)`, t);
  }
  ok(catCount() === n1 && applyCalls.length === calls0, 'categories: nothing saved for the duplicates');
  await clearToasts(page);
  // rename
  const syrId = cat('Syrups Extra');
  await page.click(`[data-cat-rename="${syrId}"]`); await page.waitForSelector('#cat-rename');
  await page.fill('#cat-rename', 'COFFEE'); await page.click('#cat-rename-save');
  ok(/already a category called/.test(await toastText(page, 'error').catch(() => '')), 'categories: rename to a taken name (any case) refused');
  await clearToasts(page);
  await page.fill('#cat-rename', 'Syrups & Sauces'); await page.click('#cat-rename-save');
  await must(() => sql(`select name from categories where id='${syrId}'`) === 'Syrups & Sauces', 'renamed');
  await page.waitForSelector(`tr[data-cat-row="${syrId}"]:has-text("Syrups & Sauces")`, {timeout: 15000});
  ok(audits('Category renamed') === 1, 'categories: renamed (same id), audit "Category renamed"');
  // remove an unused one
  await page.waitForSelector(`[data-cat-remove="${syrId}"]`);
  await page.click(`[data-cat-remove="${syrId}"]`); await confirm(page);
  await must(() => sql(`select count(*) from categories where id='${syrId}'`) === '0', 'unused removed');
  await page.waitForSelector('#cat-new-name'); await page.waitForSelector(`tr[data-cat-row="${syrId}"]`, {state: 'detached', timeout: 15000});
  ok(true, 'categories: an unused category is removed after one confirmation');
  // remove a used one (Coffee: beans + milk) -> move to Raw materials, in ONE call
  await page.waitForSelector(`[data-cat-remove="${COFFEE}"]`);
  await page.click(`[data-cat-remove="${COFFEE}"]`);
  await page.waitForSelector('#cat-move-to');
  const moveText = await page.textContent('#active-modal-overlay .modal-body');
  ok(/used by 2 ingredients/.test(moveText) && /Espresso beans/.test(moveText) && /Milk/.test(moveText), 'categories: removing a used category says which ingredients use it', moveText.replace(/\s+/g, ' ').slice(0, 200));
  const raw = cat('Raw materials');
  await page.selectOption('#cat-move-to', raw);
  calls0 = applyCalls.length;
  await page.click('#cat-move-go');
  await must(() => sql(`select count(*) from categories where id='${COFFEE}'`) === '0', 'Coffee removed');
  await page.waitForSelector('#cat-new-name'); await page.waitForSelector(`tr[data-cat-row="${COFFEE}"]`, {state: 'detached', timeout: 15000});
  ok(sql(`select string_agg(distinct category_id::text, ',') from ingredients where id in ('${MILK}','${BEANS}')`) === raw, 'categories: both ingredients moved to "Raw materials" and "Coffee" removed');
  const moveCall = applyCalls.slice(calls0);
  const ops = moveCall.length === 1 ? (moveCall[0].p_ops || []) : [];
  const kinds = ops.map(o => (o.op || o.action) + ':' + o.table);
  ok(moveCall.length === 1 && kinds.indexOf('delete:categories') > kinds.lastIndexOf('update:ingredients') && kinds.filter(k => k === 'update:ingredients').length === 2, 'categories: moves + delete sent in ONE all-or-nothing call (moves first)', kinds);
  ok(audits('Category removed') === 2, 'categories: audit "Category removed" for each removal');
  await page.click('#active-modal-overlay [data-cancel]'); await modalGone(page);
  // the ingredients list filter follows
  const filterOpts = await page.$$eval('#ing-cat-filter option', os => os.map(o => o.textContent));
  ok(filterOpts.includes('Raw materials') && !filterOpts.includes('Coffee'), 'Ingredients filter lists the new categories (Coffee gone)', filterOpts);

  // ingredient form: "+ New category" refreshes the dropdown and picks it; starting stock in kg
  await page.click('#btn-new-ingredient');
  await page.fill('#f-name', 'Flour');
  await page.selectOption('#f-unit', 'g');
  await page.click('#f-cat-new'); await page.fill('#f-cat-new-name', 'Baking'); await page.click('#f-cat-new-save');
  await must(async () => (await page.$eval('#f-cat', s => s.options[s.selectedIndex] && s.options[s.selectedIndex].textContent)) === 'Baking', 'dropdown shows Baking');
  ok(await page.isVisible('#f-name') && (await page.inputValue('#f-name')) === 'Flour', 'ingredient form: "+ New category" adds it, the dropdown refreshes and picks it, the form keeps what was typed');
  const unitOpts = await page.$$eval('#f-initial-unit option', os => os.map(o => o.value));
  ok(JSON.stringify(unitOpts) === JSON.stringify(['g', 'kg']), 'starting stock unit offers g / kg for a g ingredient', unitOpts);
  // lead decision 2026-10-26: a number the owner TYPED keeps its number when the unit changes
  await page.fill('#f-initial', '1500'); await page.selectOption('#f-initial-unit', 'kg');
  ok((await page.inputValue('#f-initial')) === '1500', 'starting stock: typed 1500, then kg -> stays 1500 (1500 kg)', await page.inputValue('#f-initial'));
  ok(/saved as 1500000 g|saved as 1,500,000 g/.test(await page.textContent('#f-initial-hint')), 'starting stock: hint says "saved as 1500000 g"', await page.textContent('#f-initial-hint'));
  await page.fill('#f-initial', '1.5');
  ok(/saved as 1500 g/.test(await page.textContent('#f-initial-hint')), 'starting stock: 1.5 kg -> hint says "saved as 1500 g"', await page.textContent('#f-initial-hint'));
  await page.click('#btn-save-ing'); await modalGone(page);
  const flour = one(`select i.id, c.name as cat, i.base_unit from ingredients i join categories c on c.id=i.category_id where i.name='Flour'`);
  ok(flour && flour.cat === 'Baking' && flour.base_unit === 'g', 'Flour saved in the new category, base unit g', flour);
  ok(near(sql(`select quantity from inventory_transactions where ingredient_id='${flour.id}' and transaction_type='INITIAL_STOCK'`), 1500), 'starting stock 1.5 kg saved as 1500 g (base unit)');

  // ================= B. units in recipes =================
  await go(page, 'recipes');
  await page.click('#btn-new-recipe');
  await page.fill('#r-name', 'Unit Latte'); await page.fill('#r-price', '120');
  await page.selectOption('#ri-body tr:nth-child(1) .ri-ing', MILK);
  ok(JSON.stringify(await page.$$eval('#ri-body tr:nth-child(1) .ri-unit option', os => os.map(o => o.value))) === '["ml","L"]', 'recipe line: Milk (ml) offers mL / L');
  await page.selectOption('#ri-body tr:nth-child(1) .ri-unit', 'L');
  await page.fill('#ri-body tr:nth-child(1) .ri-qty', '0.2');
  await page.click('#ri-add-row');
  await page.selectOption('#ri-body tr:nth-child(2) .ri-ing', BEANS); await page.fill('#ri-body tr:nth-child(2) .ri-qty', '18');
  ok(JSON.stringify(await page.$$eval('#ri-body tr:nth-child(2) .ri-unit option', os => os.map(o => o.value))) === '["g","kg"]', 'recipe line: beans (g) offers g / kg');
  // a TYPED number keeps its number when the unit changes (lead decision 2026-10-26); the hint shows what is saved
  await page.selectOption('#ri-body tr:nth-child(2) .ri-unit', 'kg');
  ok((await page.inputValue('#ri-body tr:nth-child(2) .ri-qty')) === '18', 'recipe line: typed 18, then kg -> stays 18 (18 kg)', await page.inputValue('#ri-body tr:nth-child(2) .ri-qty'));
  ok(/saved as 18000 g/.test(await page.textContent('#ri-body tr:nth-child(2) .ri-saved')), 'recipe line: hint says "saved as 18000 g"', await page.textContent('#ri-body tr:nth-child(2) .ri-saved'));
  await page.selectOption('#ri-body tr:nth-child(2) .ri-unit', 'g');
  ok((await page.inputValue('#ri-body tr:nth-child(2) .ri-qty')) === '18', 'recipe line: back to g stays 18 (18 g)');
  ok((await page.textContent('#ri-body tr:nth-child(2) .ri-saved')).trim() === '', 'recipe line: no "saved as" hint when typed in the base unit');
  ok(/saved as 200 mL/.test(await page.textContent('#ri-body tr:nth-child(1) .ri-saved')), 'recipe line: 0.2 L shows "saved as 200 mL"', await page.textContent('#ri-body tr:nth-child(1) .ri-saved'));
  // option group with an extra in L
  await page.click('#mod-add-group');
  const g = '#mod-editor .mod-ed-group:nth-child(1)';
  await page.fill(g + ' .mg-name', 'Size'); await page.check(g + ' .mg-req');
  await page.fill(g + ' tbody tr:nth-child(1) .mo-label', 'Regular');
  await page.click(g + ' .mo-add');
  await page.fill(g + ' tbody tr:nth-child(2) .mo-label', 'Large'); await page.fill(g + ' tbody tr:nth-child(2) .mo-price', '20');
  await page.selectOption(g + ' tbody tr:nth-child(2) .mo-ing', MILK);
  await page.selectOption(g + ' tbody tr:nth-child(2) .mo-unit', 'L');
  await page.fill(g + ' tbody tr:nth-child(2) .mo-qty', '0.06');
  await SHOT(page, 'recipe-units');
  await page.click('#btn-save-rec'); await modalGone(page);
  const ul = one(`select id, modifier_groups from recipes where name='Unit Latte'`);
  const lines = rows(`select ingredient_id, quantity, unit from recipe_ingredients where recipe_id='${ul.id}' order by unit`);
  const ml = lines.find(l => l.ingredient_id === MILK), bl = lines.find(l => l.ingredient_id === BEANS);
  ok(ml && near(ml.quantity, 200) && ml.unit === 'L', 'recipe line typed as 0.2 L saved as 200 (base mL) + unit "L"', lines);
  ok(bl && near(bl.quantity, 18) && bl.unit === 'g', 'recipe line 18 g saved as 18 + unit "g"', lines);
  const large = ul.modifier_groups[0].options.find(o => o.label === 'Large');
  ok(large && large.ingredient_id === MILK && near(large.ingredient_qty_delta, 60) && large.unit === 'L', 'option extra typed as 0.06 L saved as ingredient_qty_delta 60 (base mL) + unit "L"', large);
  const regular = ul.modifier_groups[0].options.find(o => o.label === 'Regular');
  ok(regular && !regular.ingredient_id && Number(regular.ingredient_qty_delta) === 0, 'option without an extra: no ingredient, 0 amount', regular);
  // re-open: shown the same way
  await go(page, 'recipeDetail', ul.id);
  await page.click('#edit-rec-btn'); await page.waitForSelector('#ri-body tr');
  const shown = await page.$$eval('#ri-body tr', trs => trs.map(tr => [tr.querySelector('.ri-ing').value, tr.querySelector('.ri-qty').value, tr.querySelector('.ri-unit').value]));
  ok(shown.some(r => r[0] === '22222222-0000-0000-0000-000000000002' && r[1] === '0.2' && r[2] === 'L') && shown.some(r => r[1] === '18' && r[2] === 'g'), 'recipe re-opened: Milk shows 0.2 L, beans 18 g (as typed)', shown);
  const optShown = await page.$eval(g + ' tbody tr:nth-child(2)', tr => [tr.querySelector('.mo-qty').value, tr.querySelector('.mo-unit').value]);
  ok(optShown[0] === '0.06' && optShown[1] === 'L', 'recipe re-opened: the Large extra shows 0.06 L', optShown);
  ok(/saved as 60 mL/.test(await page.textContent(g + ' tbody tr:nth-child(2) .mo-saved')), 'recipe re-opened: the extra shows "saved as 60 mL"', await page.textContent(g + ' tbody tr:nth-child(2) .mo-saved'));
  // a SAVED value that has not been edited DOES convert when its unit changes (0.2 L -> 200 mL, 0.06 L -> 60 mL)
  const milkRow = await page.evaluate(() => [...document.querySelectorAll('#ri-body tr')].findIndex(tr => tr.querySelector('.ri-ing').value === '22222222-0000-0000-0000-000000000002') + 1);
  await page.selectOption(`#ri-body tr:nth-child(${milkRow}) .ri-unit`, 'ml');
  ok((await page.inputValue(`#ri-body tr:nth-child(${milkRow}) .ri-qty`)) === '200', 'recipe re-opened: the saved 0.2 L converts to 200 when switched to mL', await page.inputValue(`#ri-body tr:nth-child(${milkRow}) .ri-qty`));
  await page.selectOption(g + ' tbody tr:nth-child(2) .mo-unit', 'ml');
  ok((await page.inputValue(g + ' tbody tr:nth-child(2) .mo-qty')) === '60', 'recipe re-opened: the saved 0.06 L extra converts to 60 when switched to mL');
  await page.selectOption(`#ri-body tr:nth-child(${milkRow}) .ri-unit`, 'L');
  await page.selectOption(g + ' tbody tr:nth-child(2) .mo-unit', 'L');
  ok((await page.inputValue(`#ri-body tr:nth-child(${milkRow}) .ri-qty`)) === '0.2' && (await page.inputValue(g + ' tbody tr:nth-child(2) .mo-qty')) === '0.06', 'and back to L: 0.2 and 0.06 again');
  // saving again unchanged keeps the base amounts (no double conversion)
  await page.click('#btn-save-rec'); await modalGone(page);
  ok(near(sql(`select quantity from recipe_ingredients where recipe_id='${ul.id}' and ingredient_id='${MILK}'`), 200)
     && near(one(`select modifier_groups from recipes where id='${ul.id}'`).modifier_groups[0].options[1].ingredient_qty_delta, 60), 'saving the re-opened recipe unchanged keeps 200 mL and +60 mL (no double conversion)');
  const detail = (await page.textContent('#content')).replace(/\s+/g, ' ');
  ok(/\+0\.06 L Milk/.test(detail) && /Milk Raw ingredient 0\.2 ?L ?₱100\.00 \/ L ?₱20\.00/.test(detail.slice(detail.indexOf('Ingredient breakdown'))), 'recipe page shows the option extra as +0.06 L and the milk line "0.2 L · ₱100.00 / L · ₱20.00" (unit cost per shown unit)', detail.slice(detail.indexOf('Ingredient breakdown'), detail.indexOf('Ingredient breakdown') + 400));

  // production recipe: yield typed in mL, then edited in L; a batch typed in L
  await go(page, 'recipes');
  await page.click('#btn-new-recipe');
  await page.fill('#r-name', 'Simple Syrup'); await page.selectOption('#r-type', 'SAUCES_SYRUPS');
  await page.fill('#r-yield', '1000'); await page.selectOption('#r-yield-unit', 'ml');
  await page.selectOption('#ri-body tr:nth-child(1) .ri-ing', flour.id);
  await page.selectOption('#ri-body tr:nth-child(1) .ri-unit', 'kg'); await page.fill('#ri-body tr:nth-child(1) .ri-qty', '0.3');
  await page.click('#btn-save-rec'); await modalGone(page);
  const syr = one(`select r.id, r.expected_yield, r.yield_unit, r.produced_ingredient_id, i.base_unit from recipes r join ingredients i on i.id=r.produced_ingredient_id where r.name='Simple Syrup'`);
  ok(syr && near(syr.expected_yield, 1000) && syr.yield_unit === 'ml' && syr.base_unit === 'ml', 'production recipe: yield 1000 mL, produced item counted in mL', syr);
  ok(near(sql(`select quantity from recipe_ingredients where recipe_id='${syr.id}'`), 300), 'production recipe line 0.3 kg saved as 300 g');
  await go(page, 'recipeDetail', syr.id);
  await page.click('#edit-rec-btn'); await page.waitForSelector('#r-yield-unit');
  ok(JSON.stringify(await page.$$eval('#r-yield-unit option', os => os.map(o => o.value))) === '["ml","L"]', 'linked production recipe: yield unit offers mL / L (its item\'s family only)');
  await page.selectOption('#r-yield-unit', 'L');
  ok((await page.inputValue('#r-yield')) === '1', 'saved (unedited) yield converts: 1000 mL shown as 1 L after switching the unit');
  await page.fill('#r-yield', '1.2');
  ok(/saved as 1200 mL/.test(await page.textContent('#r-yield-saved')), 'yield 1.2 L: hint says "saved as 1200 mL"', await page.textContent('#r-yield-saved'));
  await page.click('#btn-save-rec'); await modalGone(page);
  const syr2 = one(`select expected_yield, yield_unit from recipes where id='${syr.id}'`);
  ok(near(syr2.expected_yield, 1200) && syr2.yield_unit === 'ml', 'yield edited as 1.2 L saved as 1200 (base mL)', syr2);
  // a batch typed in L
  await go(page, 'production');
  await page.click('#btn-new-production');
  await page.selectOption('#pr-recipe', syr.id);
  ok((await page.inputValue('#pr-expected')) === '1200' && (await page.inputValue('#pr-expected-unit')) === 'ml', 'production form: expected yield defaults to 1200 mL');
  await page.selectOption('#pr-expected-unit', 'L');
  ok((await page.inputValue('#pr-expected')) === '1.2', 'production form: switching to L shows 1.2');
  await page.selectOption('#pr-actual-unit', 'L'); await page.fill('#pr-actual', '1.1');
  await page.click('#btn-save-prod'); await modalGone(page);
  const bat = one(`select id, expected_yield, actual_yield, yield_unit from production_batches where recipe_id='${syr.id}'`);
  ok(bat && near(bat.expected_yield, 1200) && near(bat.actual_yield, 1100) && bat.yield_unit === 'ml', 'batch typed as 1.2 L / 1.1 L saved as 1200 / 1100 mL', bat);
  const bl2 = rows(`select ingredient_id, transaction_type, quantity from inventory_transactions where reference_id='${bat.id}'`);
  ok(bl2.some(x => x.transaction_type === 'PRODUCTION' && x.ingredient_id === syr.produced_ingredient_id && near(x.quantity, 1100))
     && bl2.some(x => x.transaction_type === 'PRODUCTION_USE' && x.ingredient_id === flour.id && near(x.quantity, 300)), 'batch: +1100 mL syrup, -300 g flour (base units)', bl2);

  // waste in kg on a g ingredient; adjustment and stock count in L
  await go(page, 'inventory');
  await page.click('#btn-new-waste');
  await page.selectOption('#w-ing', flour.id);
  await page.selectOption('#w-unit', 'kg'); await page.fill('#w-qty', '0.25');
  await page.click('#btn-save-waste'); await modalGone(page);
  const w = one(`select id, quantity, unit from waste where ingredient_id='${flour.id}'`);
  ok(w && near(w.quantity, 250) && w.unit === 'kg', 'waste typed as 0.25 kg saved as 250 (base g) + unit "kg"', w);
  ok(near(sql(`select quantity from inventory_transactions where reference_id='${w.id}' and transaction_type='WASTE'`), 250), 'waste stock line takes off 250 g');
  ok(near(stock(flour.id), 1500 - 300 - 250), 'Flour stock = 1500 - 300 (batch) - 250 (waste) = 950 g', stock(flour.id));
  await page.waitForTimeout(500);
  const wasteRow = (await page.textContent('#content')).replace(/\s+/g, ' ');
  ok(/0\.25 kg/.test(wasteRow), 'recent waste shows "0.25 kg" (as typed)');
  const milk0 = stock(MILK);
  await page.click('#btn-new-adjustment');
  await page.selectOption('#a-ing', MILK);
  await page.selectOption('#a-qty-unit', 'L'); await page.fill('#a-qty', '-0.5');
  await page.click('#btn-save-adj'); await modalGone(page);
  ok(near(stock(MILK), milk0 - 500), 'adjustment typed as -0.5 L takes off 500 mL', [milk0, stock(MILK)]);
  await page.click('#btn-new-adjustment');
  await page.selectOption('#a-ing', MILK);
  await page.click('[data-mode="count"]');
  await page.selectOption('#a-count-unit', 'L'); await page.fill('#a-count', '4');
  ok(/Change: −500 mL/.test(await page.textContent('#a-count-hint')) || /Change: -500 mL/.test(await page.textContent('#a-count-hint')), 'count of 4 L previews the change in mL', await page.textContent('#a-count-hint'));
  await page.click('#btn-save-adj'); await modalGone(page);
  ok(near(stock(MILK), 4000), 'stock count typed as 4 L sets Milk to 4000 mL', stock(MILK));
  ok(/counted 4 L/.test(sql(`select details from audit_log where action='Stock adjusted' order by at desc limit 1`)), 'audit says "counted 4 L"');

  // ================= C. counter sale with the L option extra =================
  const fctx = await H.counterContext(browser);
  const fo = await fctx.newPage(); H.attach(fo, errors, 'FO');
  fctx.on('page', p => { p.waitForLoadState().then(() => p.close()).catch(() => {}); });
  await H.pairCounter(fo, 'TESTAB');
  await H.typePin(fo, '1111');
  await H.startShift(fo, 500);
  const milkBefore = stock(MILK), beansBefore = stock(BEANS);
  await fo.click('.pos-product-card:has-text("Unit Latte")');
  await fo.waitForSelector('.mod-opt');
  await fo.click('.mod-opt:has-text("Large")');
  ok((await fo.textContent('#mod-total-price')).includes('140.00'), 'counter: Unit Latte Large = ₱120 + ₱20 = ₱140');
  await fo.click('#mod-add');
  await fo.click('#checkout-btn'); await fo.click('[data-quick]'); await fo.click('#complete-sale-btn');
  ok(await until(() => sql(`select count(*) from sales where status='COMPLETED' and grand_total=140`) === '1', 20000), 'counter: the sale is uploaded (₱140)');
  ok(near(stock(MILK), milkBefore - 200 - 60), `counter sale takes off 200 + 60 = 260 mL of Milk (L amounts stored in mL): ${milkBefore} -> ${stock(MILK)}`);
  ok(near(stock(BEANS), beansBefore - 18), 'counter sale takes off 18 g of beans');
  await fctx.close();

  // ================= D. tick-and-remove =================
  // two recipes without history + Unit Latte (sold) + Simple Syrup (makes an item, has a batch)
  for(const nm of ['Remove Me A', 'Remove Me B']){
    await go(page, 'recipes'); await page.click('#btn-new-recipe');
    await page.fill('#r-name', nm); await page.fill('#r-price', '50');
    await page.selectOption('#ri-body tr:nth-child(1) .ri-ing', BEANS); await page.fill('#ri-body tr:nth-child(1) .ri-qty', '5');
    await page.click('#btn-save-rec'); await modalGone(page);
  }
  const ra = sql(`select id from recipes where name='Remove Me A'`), rb = sql(`select id from recipes where name='Remove Me B'`);
  // the history check asks per recipe: Unit Latte gets 1500 more sold lines, "Remove Me C" only one --
  // C's single sale must still be found (security follow-up: a recipe with many sales can't hide another's)
  await go(page, 'recipes'); await page.click('#btn-new-recipe');
  await page.fill('#r-name', 'Remove Me C'); await page.fill('#r-price', '50');
  await page.selectOption('#ri-body tr:nth-child(1) .ri-ing', BEANS); await page.fill('#ri-body tr:nth-child(1) .ri-qty', '5');
  await page.click('#btn-save-rec'); await modalGone(page);
  const rc = sql(`select id from recipes where name='Remove Me C'`);
  const cols = sql(`select string_agg(quote_ident(column_name), ',') from information_schema.columns where table_schema='public' and table_name='sale_items' and column_name not in ('id','recipe_id','local_id')`);
  sql(`insert into sale_items(id, recipe_id, ${cols}) select gen_random_uuid(), recipe_id, ${cols} from sale_items, generate_series(1, 1500) where recipe_id='${ul.id}'`);
  sql(`insert into sale_items(id, recipe_id, ${cols}) select gen_random_uuid(), '${rc}', ${cols} from sale_items where recipe_id='${ul.id}' limit 1`);
  ok(sql(`select count(*) from sale_items where recipe_id='${ul.id}'`) === '1501' && sql(`select count(*) from sale_items where recipe_id='${rc}'`) === '1', 'setup: Unit Latte has 1501 sold lines, "Remove Me C" one');
  await page.click('#btn-refresh'); await page.waitForTimeout(1000);
  await go(page, 'recipes'); await page.waitForSelector('[data-pick]');
  ok(await page.isDisabled('#rec-remove-picked'), 'tick-and-remove: "Remove selected (0)" is off until something is ticked');
  for(const id of [ra, rb, rc, ul.id, syr.id]) await page.check(`[data-pick="${id}"]`);
  ok((await page.textContent('#rec-remove-picked')).includes('(5)'), 'tick-and-remove: the button counts 5 ticked');
  // Cancel first: nothing changes
  calls0 = applyCalls.length;
  await page.click('#rec-remove-picked');
  await page.waitForSelector('#active-modal-overlay .rec-rm-list');
  const dlg = (await page.textContent('#active-modal-overlay .modal-body')).replace(/\s+/g, ' ');
  ok(/2 recipes will be deleted/.test(dlg) && /3 recipes will be hidden instead/.test(dlg), 'tick-and-remove: dialog says 2 deleted, 3 hidden', dlg.slice(0, 400));
  ok(/Unit Latte — has sales history/.test(dlg) && /Simple Syrup — makes an inventory item/.test(dlg), 'tick-and-remove: says why each one is hidden', dlg.slice(0, 600));
  ok(/Remove Me C — has sales history/.test(dlg), 'tick-and-remove: a recipe with ONE sale is found even next to one with 1501 sold lines', dlg.slice(0, 600));
  await SHOT(page, 'remove-dialog');
  await page.click('#active-modal-overlay [data-cancel]'); await modalGone(page);
  ok(applyCalls.length === calls0 && sql(`select count(*) from recipes where id in ('${ra}','${rb}')`) === '2', 'tick-and-remove: Cancel changes nothing');
  // now really
  await page.click('#rec-remove-picked');
  await page.waitForSelector('#active-modal-overlay .rec-rm-list');
  calls0 = applyCalls.length;
  await page.click('#active-modal-overlay [data-ok]');
  await must(() => sql(`select count(*) from recipes where id in ('${ra}','${rb}')`) === '0', 'deleted');
  ok(sql(`select count(*) from recipe_ingredients where recipe_id in ('${ra}','${rb}')`) === '0', 'tick-and-remove: the 2 unused recipes are deleted with their ingredient lines');
  const hidden = rows(`select name, active, pos_visible, qr_visible from recipes where id in ('${ul.id}','${syr.id}','${rc}') order by name`);
  ok(hidden.length === 3 && hidden.every(r => r.active === false && r.pos_visible === false && r.qr_visible === false), 'tick-and-remove: the sold recipe and the produced-item recipe are kept but hidden (inactive, off both menus)', hidden);
  ok(sql(`select count(*) from recipe_ingredients where recipe_id='${ul.id}'`) === '2' && sql(`select count(*) from sale_items where recipe_id='${ul.id}'`) === '1501', 'tick-and-remove: the hidden recipe keeps its lines and its sale history');
  ok(applyCalls.length === calls0 + 1, 'tick-and-remove: everything in ONE call', applyCalls.length - calls0);
  const au = rows(`select details from audit_log where action='Recipes removed'`);
  ok(au.length === 1 && /Deleted: .*Remove Me A/.test(au[0].details) && /Remove Me B/.test(au[0].details) && /Hidden \(has history\): .*Remove Me C/.test(au[0].details) && /Simple Syrup/.test(au[0].details) && /Unit Latte/.test(au[0].details), 'tick-and-remove: ONE audit entry "Recipes removed" naming what was deleted and hidden', au);
  await page.waitForTimeout(500);
  ok((await page.textContent('#rec-remove-picked')).includes('(0)'), 'tick-and-remove: ticks cleared afterwards');
  // a single history recipe through its own Delete button goes straight to "Hide it" (covered in bo/part4 too)

  ok(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
