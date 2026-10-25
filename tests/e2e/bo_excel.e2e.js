// Back Office: recipes from / to Excel (batch 1, owner request #5 + the security follow-ups), on a fresh
// e2e seed. Uses the FAKE workbooks in tests/fixtures/ (made by tests/fixtures/make_fixture.js; no real data).
//   1. import demo_cafe_costing.xlsx + demo_pastry_costing.xlsx: preview "6 recipes, 15 new ingredients,
//      2 sheets skipped · 1 house-made"; menu items HIDDEN by default; starting-price purchases have
//      quantity 0 and no stock line; one audit entry
//   2. the same files again -> 0 recipes (Import button off)
//   3. HTML / formula-looking text in cells shown as text; leading = + - @ stripped; names cut to 80;
//      the "Show imported menu items ... right away" tick on -> visible on both menus
//   4. limits refused in plain words, nothing saved: > 5 MB, .xls, not a zip, > 500 rows, 11 files
//   5. export: text that looks like a formula ("=1+1") written as text; the report CSV puts ' in front
//   6. export -> import into an EMPTY new shop: names, prices, lines, quantities, units, yields round-trip
// Run:  tests/e2e_reset.sh && tests/restart_fake.sh && node tests/e2e/bo_excel.e2e.js
//       (FAKE_PORT / FAKE_DB for another stand-in)
const H = require('./bo/bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const fs = require('fs');
const path = require('path');
const NAME = 'bo_excel.e2e@' + H.sizeTag();
const {sql, rows, one, ok, until, must, confirm, toastText, clearToasts, go, modalGone} = H;
const SHOT = (p, n) => H.shot(p, 'bo-excel-' + n);
const FIX = path.join(__dirname, '..', 'fixtures');
const FILES = [path.join(FIX, 'demo_cafe_costing.xlsx'), path.join(FIX, 'demo_pastry_costing.xlsx')];
const BEANS = '22222222-0000-0000-0000-000000000001';

async function pickFiles(page, files){
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-excel-import')]);
  await chooser.setFiles(files);
}
async function errorToast(page){
  const t = await toastText(page, 'error').catch(() => '');
  await clearToasts(page);
  return t;
}
// recipes of a shop in a comparable shape
function shopRecipes(biz){
  return rows(`select r.name, r.selling_price::float as price, r.is_production_recipe as prod, r.expected_yield::float as yield, r.yield_unit,
      coalesce((select json_agg(json_build_object('ing', i.name, 'qty', round(ri.quantity::numeric, 6)::float, 'base', i.base_unit) order by i.name)
        from recipe_ingredients ri join ingredients i on i.id = ri.ingredient_id where ri.recipe_id = r.id), '[]') as lines
    from recipes r where r.business_id = '${biz}' and r.active order by r.name`);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await H.boContext(browser);
  const page = await ctx.newPage(); const net = H.attach(page, errors, 'BO');
  await H.boLogin(page);
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  const counts = () => sql(`select (select count(*) from recipes where business_id='${biz}')||'/'||(select count(*) from ingredients where business_id='${biz}')||'/'||(select count(*) from purchases where business_id='${biz}')||'/'||(select count(*) from inventory_transactions where business_id='${biz}')||'/'||(select count(*) from recipe_ingredients where business_id='${biz}')`);
  await go(page, 'recipes');

  // ================= 1. the two demo files =================
  const before = counts();
  const txBefore = Number(sql(`select count(*) from inventory_transactions where business_id='${biz}'`));
  const ingBefore = Number(sql(`select count(*) from ingredients where business_id='${biz}'`));
  const recBefore = Number(sql(`select count(*) from recipes where business_id='${biz}'`));
  await pickFiles(page, FILES);
  await page.waitForSelector('#xl-summary', {timeout: 20000});
  const summary = (await page.textContent('#xl-summary')).replace(/\s+/g, ' ').trim();
  ok(/^6 recipes, 15 new ingredients, 2 sheets skipped · 1 house-made\./.test(summary), 'preview: "6 recipes, 15 new ingredients, 2 sheets skipped · 1 house-made"', summary);
  ok(counts() === before, 'preview: nothing saved yet');
  ok(await page.isChecked('#xl-start') && !(await page.isChecked('#xl-show')), 'preview: "use the prices as starting costs" on, "show imported menu items right away" OFF by default');
  ok(/Import 6 recipes/.test(await page.textContent('#xl-go')), 'preview: button says "Import 6 recipes"');
  await SHOT(page, 'preview');
  await page.click('#xl-go');
  await page.waitForSelector('#active-modal-overlay .modal-title:has-text("Recipes imported"), #active-modal-overlay :text("Recipes imported")', {timeout: 30000});
  const done = (await page.textContent('#active-modal-overlay .modal-body')).replace(/\s+/g, ' ');
  ok(/6 recipes added/.test(done) && /15 new ingredients added/.test(done) && /hidden/.test(done), 'import done: 6 recipes, 15 new ingredients; says the menu items are hidden', done.slice(0, 500));
  await SHOT(page, 'imported');
  await page.click('#active-modal-overlay [data-ok]'); await modalGone(page);
  const imported = rows(`select name, pos_visible, qr_visible, is_production_recipe, selling_price::float as price from recipes where business_id='${biz}' and notes like 'Imported from Excel:%' order by name`);
  ok(imported.length === 6 && Number(sql(`select count(*) from recipes where business_id='${biz}'`)) === recBefore + 6, '6 recipes saved', imported.map(r => r.name));
  ok(imported.every(r => r.pos_visible === false && r.qr_visible === false), 'imported recipes are HIDDEN from the counter and the QR menu by default', imported);
  ok(imported.filter(r => r.is_production_recipe).length === 1 && Number(sql(`select count(*) from ingredients where business_id='${biz}' and is_produced_item and notes like '%Excel import%'`)) === 1, '1 house-made recipe with its produced ingredient');
  ok(Number(sql(`select count(*) from ingredients where business_id='${biz}' and notes = 'Added from an Excel import.'`)) === 15 && Number(sql(`select count(*) from ingredients where business_id='${biz}'`)) === ingBefore + 16, '15 new raw ingredients (+ 1 produced)');
  const starts = rows(`select p.id, p.quantity::float as q, p.base_quantity::float as bq, p.total_price::float as tp, p.price_per_base_unit::float as ppu from purchases p where p.business_id='${biz}' and p.notes='Starting price from Excel file'`);
  ok(starts.length > 0 && starts.every(p => p.q === 0 && p.bq === 0 && p.tp === 0 && p.ppu > 0), `starting prices: ${starts.length} purchases with quantity 0, ₱0 total and a price per unit`, starts.slice(0, 3));
  ok(Number(sql(`select count(*) from inventory_transactions where reference_id in (select id::text from purchases where notes='Starting price from Excel file')`)) === 0
     && Number(sql(`select count(*) from inventory_transactions where business_id='${biz}'`)) === txBefore, 'starting prices add NO stock (no inventory_transactions)');
  ok(Number(sql(`select count(*) from purchases where business_id='${biz}' and ingredient_id='${BEANS}' and notes='Starting price from Excel file'`)) === 0, 'an ingredient that already has purchases gets no starting price');
  ok(Number(sql(`select count(*) from audit_log where business_id='${biz}' and action='Recipes imported from Excel'`)) === 1, 'one audit entry "Recipes imported from Excel"');
  // nothing new on the counter: the counter's menu = active, priced, pos_visible
  ok(Number(sql(`select count(*) from recipes where business_id='${biz}' and notes like 'Imported from Excel:%' and (pos_visible or qr_visible)`)) === 0, 'none of them is on either menu until switched on');

  // ================= 2. same files again =================
  const after1 = counts();
  await pickFiles(page, FILES);
  await page.waitForSelector('#xl-summary', {timeout: 20000});
  const s2 = (await page.textContent('#xl-summary')).replace(/\s+/g, ' ').trim();
  ok(/^0 recipes/.test(s2) && await page.isDisabled('#xl-go'), 'second import of the same files: 0 recipes, Import button off', s2);
  await page.click('#active-modal-overlay [data-cancel]'); await modalGone(page);
  ok(counts() === after1, 'second import: nothing saved');

  // ================= 3. HTML / formula text; tick ON =================
  const LONG = 'Very Long Recipe Name ' + 'x'.repeat(100);
  await page.evaluate(async (LONG) => {
    const J = await loadJSZip();
    const table = (items, price) => {
      const r = [[], ['menu name', 'Whatever'], [], ['Ingredients'], [null, 'item', 'UOM', 'Unit price', 'quantity', 'Amount']];
      items.forEach(([n, pack, p, q]) => r.push([null, n, pack, p, q, p / pack * q]));
      r.push([null, 'total cost'], [null, 'selling price', null, null, null, price]);
      return r;
    };
    const b = await writeXlsx(J, [
      {name: '<img src=x onerror="window.__xss=1">Cake', rows: table([['<b id="xss">Sugar</b>', 1000, 80, 20]], 90)},
      {name: '=HYPERLINK("http://example.com")', rows: table([['+cmd|calc', 1000, 50, 10], ['@SUM(A1)', 1000, 40, 5]], 70)},
      {name: LONG, rows: table([['-2+3 flour', 1000, 60, 100]], 80)},
    ]);
    await xlReadFiles([new File([b], 'tricky <b>file</b>.xlsx')]);
  }, LONG);
  await page.waitForSelector('#xl-summary', {timeout: 20000});
  const prevTxt = await page.textContent('#xl-preview');
  ok(!(await page.$('#xss')) && !(await page.evaluate(() => window.__xss)), 'preview: HTML in cell text and sheet names is not run (no injected element)');
  ok(/<b id="xss">Sugar<\/b>|&lt;b/.test(prevTxt) || /<img src=x/.test(prevTxt) || /tricky <b>file<\/b>\.xlsx/.test(prevTxt), 'preview: HTML text is shown as plain text', prevTxt.replace(/\s+/g, ' ').slice(0, 300));
  await SHOT(page, 'tricky-preview');
  await page.check('#xl-show');
  await page.click('#xl-go');
  await page.waitForSelector('#active-modal-overlay :text("Recipes imported")', {timeout: 30000});
  const done3 = (await page.textContent('#active-modal-overlay .modal-body')).replace(/\s+/g, ' ');
  ok(/now on the counter and the QR menu/.test(done3), 'tick on: the done message says the menu items are on the counter and QR menu', done3.slice(0, 400));
  await page.click('#active-modal-overlay [data-ok]'); await modalGone(page);
  const tricky = rows(`select name, pos_visible, qr_visible from recipes where business_id='${biz}' and notes like 'Imported from Excel: tricky%' order by name`);
  ok(tricky.length === 3 && tricky.every(r => r.pos_visible && r.qr_visible), 'tick on: imported menu items are visible on the counter and the QR menu', tricky);
  ok(tricky.some(r => r.name === 'HYPERLINK("http://example.com")'), 'a sheet name starting with = is saved without the = (no formula when exported)', tricky.map(r => r.name));
  const longSaved = tricky.find(r => r.name.startsWith('Very Long'));
  ok(longSaved && longSaved.name.length <= 80 && longSaved.name === LONG.slice(0, 80).trim(), 'a name longer than 80 characters is cut to 80', longSaved && longSaved.name.length);
  const ingNames = rows(`select name from ingredients where business_id='${biz}' and notes='Added from an Excel import.' order by name`).map(r => r.name);
  ok(ingNames.includes('cmd|calc') && ingNames.includes('SUM(A1)') && ingNames.includes('2+3 flour') && ingNames.some(n => n === '<b id="xss">Sugar</b>'), 'ingredient names: leading + @ - stripped, HTML kept as plain text', ingNames.filter(n => /calc|SUM|flour|Sugar/.test(n)));
  ok(!ingNames.some(n => /^[=+\-@]/.test(n)) && !rows(`select name from recipes where business_id='${biz}'`).some(r => /^[=+\-@]/.test(r.name)), 'no imported name starts with = + - @');
  // the list and the detail show them as text
  await go(page, 'recipes'); await page.waitForTimeout(500);
  ok(!(await page.$('#xss')) && /<img src=x onerror="window.__xss=1">Cake/.test(await page.textContent('#rec-grid-wrap')), 'recipe list shows the HTML name as text');
  await go(page, 'ingredients'); await page.waitForTimeout(500);
  ok(!(await page.$('#xss')) && !(await page.evaluate(() => window.__xss)), 'ingredients list shows the HTML name as text');

  // ================= 4. limits =================
  await go(page, 'recipes');
  const c4 = counts();
  await page.evaluate(() => xlReadFiles([new File([new Uint8Array(5 * 1024 * 1024 + 10)], 'big.xlsx')]));
  ok(/"big\.xlsx" is larger than 5 MB, so it was not read\./.test(await errorToast(page)), 'a file over 5 MB is refused in plain words');
  // through the real file picker too
  const bigPath = path.join(H.SHOTS, 'qa-big-' + process.pid + '.xlsx');
  fs.writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 10));
  await pickFiles(page, [bigPath]);
  ok(/larger than 5 MB/.test(await errorToast(page)), 'a file over 5 MB picked with the file chooser is refused too');
  fs.unlinkSync(bigPath);
  await page.evaluate(() => xlReadFiles([new File(['x'], 'old menu.xls')]));
  ok(/"old menu\.xls" is an old Excel file \(\.xls\)\. Open it in Excel and save it as an Excel Workbook \(\.xlsx\) first\./.test(await errorToast(page)), '.xls refused with what to do');
  await page.evaluate(() => xlReadFiles([new File(['this is not a zip'], 'junk.xlsx')]));
  ok(/"junk\.xlsx" is not an Excel \(\.xlsx\) file, or it is damaged\./.test(await errorToast(page)), 'a file that is not a zip is refused in plain words');
  await page.evaluate(() => xlReadFiles([new File(['a,b'], 'menu.csv')]));
  ok(/"menu\.csv" is not an Excel \(\.xlsx\) file\./.test(await errorToast(page)), 'another file type is refused in plain words');
  await page.evaluate(async () => { const J = await loadJSZip(); const r = []; for(let i = 0; i < 501; i++) r.push(['row ' + i, i]); await xlReadFiles([new File([await writeXlsx(J, [{name: 'Huge', rows: r}])], 'rows.xlsx')]); });
  ok(/The sheet "Huge" in "rows\.xlsx" has more than 500 filled rows/.test(await errorToast(page)), 'a sheet with more than 500 rows is refused in plain words');
  await page.evaluate(async () => { const J = await loadJSZip(); const r = []; for(let i = 0; i < 500; i++) r.push(['row ' + i]); await xlReadFiles([new File([await writeXlsx(J, [{name: 'Ok', rows: r}])], 'rows500.xlsx')]); });
  const t500 = await errorToast(page);
  const opened500 = await page.waitForSelector('#xl-summary', {timeout: 8000}).then(() => true).catch(() => false);
  ok(!/more than 500/.test(t500) && opened500, 'exactly 500 rows is read (the preview opens: no recipe table on it)', t500);
  if(opened500){ ok(/^0 recipes/.test((await page.textContent('#xl-summary')).trim()) && await page.isDisabled('#xl-go'), 'a sheet without a recipe table: 0 recipes, nothing to import'); await page.click('#active-modal-overlay [data-cancel]'); await modalGone(page); }
  await page.evaluate(() => xlReadFiles(Array.from({length: 11}, (_, i) => new File(['x'], 'f' + i + '.xlsx'))));
  ok(/Pick up to 10 Excel files at a time \(you picked 11\)\./.test(await errorToast(page)), '11 files at once refused ("Pick up to 10 Excel files at a time")');
  {
    const tmpDir = path.join(H.SHOTS, 'qa-eleven-' + process.pid); fs.mkdirSync(tmpDir, {recursive: true});
    const eleven = Array.from({length: 11}, (_, i) => { const p = path.join(tmpDir, `copy${i}.xlsx`); fs.copyFileSync(FILES[0], p); return p; });
    await pickFiles(page, eleven);
    ok(/you picked 11/.test(await errorToast(page)) && !(await page.$('#xl-summary')), '11 real files picked: refused before reading any of them');
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
  // a mix: one good file + one bad -> the good one is previewed, the bad one listed
  await pickFiles(page, [FILES[1], path.join(FIX, 'make_fixture.js')]);
  await page.waitForSelector('#xl-summary', {timeout: 20000});
  ok(/Some files were not read/.test(await page.textContent('#xl-preview')) && /make_fixture\.js/.test(await page.textContent('#xl-preview')), 'a good + a bad file: the good one is previewed, the bad one listed as "not read"');
  await page.click('#active-modal-overlay [data-cancel]'); await modalGone(page);
  ok(counts() === c4, 'limits: nothing saved for any refused file');

  // ================= 5. export: formula-looking text stays text =================
  await go(page, 'ingredients');
  await page.click('#btn-new-ingredient');
  await page.fill('#f-name', '=1+1'); await page.selectOption('#f-unit', 'g');
  await page.click('#btn-save-ing'); await modalGone(page);
  const eq = sql(`select id from ingredients where business_id='${biz}' and name='=1+1'`);
  ok(!!eq, 'an ingredient can be called "=1+1" (typed by the owner)');
  sql(`insert into purchases(business_id, ingredient_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit) values ('${biz}','${eq}', current_date, 1, 'kg', 1000, 100, 0.1)`);
  sql(`insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) values ('${biz}','${eq}','PURCHASE',1000,current_date)`);
  await go(page, 'recipes'); await page.click('#btn-new-recipe');
  await page.fill('#r-name', '@Risky Drink'); await page.fill('#r-price', '99');
  await page.selectOption('#ri-body tr:nth-child(1) .ri-ing', eq); await page.fill('#ri-body tr:nth-child(1) .ri-qty', '5');
  await page.click('#btn-save-rec'); await modalGone(page);
  // a production recipe with a yield in the shop too (round trip of yields)
  await go(page, 'recipes'); await page.click('#btn-new-recipe');
  await page.fill('#r-name', 'Vanilla Syrup'); await page.selectOption('#r-type', 'SAUCES_SYRUPS');
  await page.fill('#r-yield', '750'); await page.selectOption('#r-yield-unit', 'ml');
  await page.selectOption('#ri-body tr:nth-child(1) .ri-ing', BEANS); await page.fill('#ri-body tr:nth-child(1) .ri-qty', '12.5');
  await page.click('#btn-save-rec'); await modalGone(page);
  await page.click('#btn-refresh').catch(() => {}); await page.waitForTimeout(800);
  await go(page, 'recipes');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-excel-export')]);
  const exportPath = path.join(H.SHOTS, 'qa-export-' + process.pid + '.xlsx');
  fs.copyFileSync(await dl.path(), exportPath);
  ok(/^cccc-recipes-\d{4}-\d{2}-\d{2}\.xlsx$/.test(dl.suggestedFilename()), 'export: file "cccc-recipes-<date>.xlsx" downloaded', dl.suggestedFilename());
  const xml = await page.evaluate(async (b64) => {
    const J = await loadJSZip();
    const z = await J.loadAsync(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    const out = {};
    for(const n of Object.keys(z.files).filter(n => /worksheets\/sheet\d+\.xml$|workbook\.xml$/.test(n))) out[n] = await z.file(n).async('string');
    return out;
  }, fs.readFileSync(exportPath).toString('base64'));
  const allSheets = Object.entries(xml).filter(([n]) => /sheet\d+/.test(n)).map(([, v]) => v).join('\n');
  const formulas = [...allSheets.matchAll(/<f>([^<]*)<\/f>/g)].map(m => m[1]);
  ok(/<c r="[A-Z]+\d+" t="inlineStr"><is><t xml:space="preserve">=1\+1<\/t>/.test(allSheets), 'export: "=1+1" is written as a TEXT cell');
  ok(formulas.length > 0 && formulas.every(f => /^(D\d+\/C\d+\*E\d+|SUM\(F\d+:F\d+\))$/.test(f)), 'export: the only formulas are the cost formulas the app writes (amount, total)', formulas.filter(f => !/^(D\d+\/C\d+\*E\d+|SUM\(F\d+:F\d+\))$/.test(f)));
  ok(/<t xml:space="preserve">@Risky Drink<\/t>/.test(allSheets) && !/<f>[^<]*Risky/.test(allSheets), 'export: a recipe name starting with @ is written as text');
  ok(!/<img src=x/.test(allSheets) && /&lt;img src=x/.test(allSheets), 'export: HTML in names is escaped in the file');
  // the export writes its audit entry in the background, after the download starts
  ok(await until(() => Number(sql(`select count(*) from audit_log where business_id='${biz}' and action='Recipes exported to Excel'`)) === 1, 10000), 'export: audit entry "Recipes exported to Excel"');
  // report CSV: text starting with = + - @ gets a ' in front (security L2)
  await go(page, 'reports'); await page.click('[data-report="inventoryValue"]'); await page.waitForSelector('#report-body table');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#export-report-csv')]);
  const csv = fs.readFileSync(await dl2.path(), 'utf8');
  const csvLines = csv.split(/\r?\n/);
  ok(csvLines.some(l => l.startsWith(`"'=1+1"`)), 'report CSV: the ingredient "=1+1" is written as "\'=1+1" (cannot run as a formula)', csvLines.filter(l => /1\+1/.test(l)));
  ok(csvLines.some(l => l.startsWith(`"'+cmd|calc"`) === false) && !csvLines.some(l => /^"[=+\-@]/.test(l)), 'report CSV: no cell starts with = + - @', csvLines.filter(l => /^"[=+\-@]/.test(l)));
  ok(/,"?-?\d/.test(csv) && csvLines.some(l => /^"Milk",/.test(l) && !/'\d/.test(l)), 'report CSV: numbers stay plain numbers (no \' added)', csvLines.filter(l => /^"Milk"/.test(l)));
  const shopA = shopRecipes(biz);

  // ================= 6. round trip into an EMPTY new shop =================
  const c3 = await H.boContext(browser);
  const p3 = await c3.newPage(); H.attach(p3, errors, 'NEW');
  await p3.goto(H.BASE + '/cccc/back/'); await p3.waitForSelector('[data-view="signup"]'); await p3.click('[data-view="signup"]');
  await H.focusSettled(p3, 'su-biz');
  await p3.fill('#su-biz', 'Round Trip Shop'); await p3.fill('#su-name', 'Rita'); await p3.fill('#su-email', 'rita@example.com'); await p3.fill('#su-pass', 'longpassword');
  await p3.click('#f-signup button[type=submit]');
  await must(async () => await p3.isVisible('#app'), 'new shop opens', 25000);
  const nb = sql(`select business_id from profiles p join auth.users u on u.id=p.id where u.email='rita@example.com'`);
  ok(nb && nb !== biz && sql(`select count(*) from recipes where business_id='${nb}'`) === '0', 'new shop starts with no recipes');
  await go(p3, 'recipes');
  await pickFiles(p3, [exportPath]);
  await p3.waitForSelector('#xl-summary', {timeout: 20000});
  const s6 = (await p3.textContent('#xl-summary')).replace(/\s+/g, ' ');
  console.log('     round-trip preview: ' + s6.slice(0, 200));
  await p3.check('#xl-show');
  await p3.click('#xl-go');
  await p3.waitForSelector('#active-modal-overlay :text("Recipes imported")', {timeout: 30000});
  await p3.click('#active-modal-overlay [data-ok]'); await modalGone(p3);
  const shopB = shopRecipes(nb);
  // what is EXPECTED to change on the way: leading = + - @ removed from names (safety); nothing else
  const clean = (s) => String(s).replace(/^[=+\-@\t\r\n\s]+/, '').replace(/\s+/g, ' ').trim();
  const norm = (list) => list.map(r => ({name: clean(r.name), price: r.prod && !r.price ? 0 : r.price, prod: r.prod, yield: r.prod ? r.yield : null, yield_unit: r.prod ? r.yield_unit : null,
    lines: r.lines.map(l => ({ing: clean(l.ing), qty: l.qty, base: l.base})).sort((a, b) => a.ing.localeCompare(b.ing))})).sort((a, b) => a.name.localeCompare(b.name));
  const A = norm(shopA), B = norm(shopB);
  const byName = new Map(B.map(r => [r.name, r]));
  // Excel sheet names are at most 31 characters and can't contain [ ] : * ? / \ -- names like that are the special case
  const sheetSafe = (n) => n.length <= 31 && !/[\[\]:*?\/\\]/.test(n);
  const plain = A.filter(r => sheetSafe(r.name)), special = A.filter(r => !sheetSafe(r.name));
  const diff = plain.filter(r => JSON.stringify(r) !== JSON.stringify(byName.get(r.name))).map(r => ({a: r, b: byName.get(r.name) || null}));
  ok(B.length === A.length, `round trip: every active recipe comes back (${A.length} -> ${B.length})`, {a: A.map(r => r.name), b: B.map(r => r.name)});
  ok(diff.length === 0, `round trip: names, prices, lines, quantities, base units and yields match for the ${plain.length} recipes with ordinary names`, diff.slice(0, 3));
  const specialDiff = special.filter(r => !byName.has(r.name)).map(r => r.name + '  ->  ' + ((B.find(b => !A.some(a => a.name === b.name) && (r.name.startsWith(b.name.replace(/ \(\d+\)$/, '')) || clean(b.name).split(' ')[0] === r.name.split(/[ "(]/)[0])) || {}).name || '?'));
  ok(specialDiff.length === 0, `round trip: recipe names longer than 31 characters or with [ ] : * ? / \\ keep their exact name (${special.length} such recipes)`, specialDiff);
  // the same file back into the SAME shop: everything is already there -> 0 new recipes
  await go(page, 'recipes');
  await pickFiles(page, [exportPath]);
  await page.waitForSelector('#xl-summary', {timeout: 20000});
  const sSame = (await page.textContent('#xl-summary')).replace(/\s+/g, ' ').trim();
  const newSheets = /^0 recipes/.test(sSame) ? [] : await page.$$eval('details.xl-sheet', ds => ds.map(d => d.querySelector('summary').textContent.replace(/\s+/g, ' ').trim()).filter(t => !/skip/i.test(t)));
  ok(/^0 recipes/.test(sSame), 'own export imported back into the same shop: 0 new recipes (no duplicates)', sSame.slice(0, 120) + ' :: ' + newSheets.join(' | ').slice(0, 600));
  await page.click('#active-modal-overlay [data-cancel]'); await modalGone(page);
  const vs = one(`select expected_yield::float as y, yield_unit from recipes where business_id='${nb}' and name='Vanilla Syrup'`);
  ok(vs && vs.y === 750 && vs.yield_unit === 'ml' && sql(`select base_unit from ingredients where business_id='${nb}' and name='Vanilla Syrup'`) === 'ml', 'round trip: a production recipe keeps its yield (750 mL) and makes its own produced item again', vs);
  ok(Number(sql(`select count(*) from inventory_transactions where business_id='${nb}'`)) === 0, 'round trip: the new shop gets no stock from the import (starting prices only)');
  const units = rows(`select name, base_unit from ingredients where business_id='${nb}' and name in ('Milk','Espresso beans','1+1')`);
  ok(units.length === 3 && units.find(u => u.name === 'Milk').base_unit === 'ml' && units.find(u => u.name === 'Espresso beans').base_unit === 'g' && units.find(u => u.name === '1+1').base_unit === 'g', 'round trip: ingredient base units come back (Milk mL, beans g; "=1+1" as "1+1")', units);
  await SHOT(p3, 'round-trip');
  await c3.close();
  fs.unlinkSync(exportPath);

  net.disallow();
  ok(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
