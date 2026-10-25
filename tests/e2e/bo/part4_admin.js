// Back Office part 4 (after parts 1-3): suppliers, delete-or-deactivate rules (ingredients, recipes),
// staff deactivate / reactivate, costing method (weighted average vs latest), dark theme, logo upload,
// names with HTML shown as text on every screen, report CSV.
// Run all parts in order with tests/e2e/bo.e2e.js (BO_VIEWPORT=1280x900 or 768x1024).
const H = require('./bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo/part4_admin@' + H.sizeTag();
const {sql, rows, one, ok, must: until, confirm, toastText, clearToasts, go, modalGone} = H;
const BASE = H.BASE, SHOTS = require('path').join(H.SHOTS, 'bo-' + H.sizeTag() + '-');
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await H.boContext(browser);
  const page = await ctx.newPage(); const net = H.attach(page, errors, 'BO');
  let dialogs = 0; page.on('dialog', () => { dialogs++; });   // H.attach dismisses it and reports it
  await page.goto(BASE + '/cccc/back/'); await page.waitForSelector('#li-email'); await H.focusSettled(page, 'li-email'); await page.fill('#li-email', 'owner@example.com'); await page.fill('#li-pass', 'secret123'); await page.click('#f-login button[type=submit]');
  await page.waitForSelector('#app', {state: 'visible', timeout: 20000});
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  const XSS = `<img src=x onerror="window.__xss=1"><b id="xss">X</b>`;

  // suppliers
  await go(page, 'suppliers');
  await page.click('#btn-new-supplier'); await page.fill('#s-name', 'Kape Co ' + XSS); await page.fill('#s-phone', '0917 222 3333'); await page.click('#s-save'); await modalGone(page);
  const sup = one(`select id from suppliers where name like 'Kape Co%'`);
  ok(!!sup, 'supplier added');
  await page.click(`[data-edit="${sup.id}"]`); await page.fill('#s-contact', 'Ben'); await page.click('#s-save'); await modalGone(page);
  ok(sql(`select contact from suppliers where id='${sup.id}'`) === 'Ben', 'supplier edited');
  await page.click(`[data-edit="${sup.id}"]`); await page.click('#s-delete'); await confirm(page);
  await until(() => sql(`select count(*) from suppliers where id='${sup.id}'`) === '0', 'supplier deleted'); await modalGone(page);
  ok(true, 'unused supplier deleted');
  const used = sql(`select id from suppliers where local_id='sup_2'`);
  await page.waitForSelector(`[data-edit="${used}"]`); await page.click(`[data-edit="${used}"]`); await page.waitForTimeout(500); await page.click('#s-delete');
  ok((await toastText(page, 'error')).includes('purchase history'), 'supplier with purchases cannot be deleted');
  await clearToasts(page); await page.click('#active-modal-overlay [data-cancel]');

  // ingredients: unused -> deleted; with history -> made inactive (history kept)
  await go(page, 'ingredients');
  await page.click('#btn-new-ingredient'); await page.fill('#f-name', 'Temp ' + XSS); await page.click('#btn-save-ing'); await modalGone(page);
  const tmp = one(`select id from ingredients where name like 'Temp%'`).id;
  await page.click(`[data-edit="${tmp}"]`); await page.click('#btn-delete-ing'); await confirm(page);
  await until(() => sql(`select count(*) from ingredients where id='${tmp}'`) === '0', 'ingredient deleted'); await modalGone(page);
  ok(true, 'unused ingredient deleted');
  const cups = sql(`select id from ingredients where name='Cups 16oz'`);
  // the list redraws after the delete above: a click on the old row can be lost, so click until the window opens
  for(let i = 0; i < 5 && !(await page.isVisible('#btn-delete-ing')); i++){
    await page.waitForSelector(`[data-edit="${cups}"]`); await page.click(`[data-edit="${cups}"]`).catch(() => {});
    await page.waitForSelector('#btn-delete-ing', {timeout: 3000}).catch(() => {});
  }
  await page.click('#btn-delete-ing'); await confirm(page);
  await until(() => sql(`select active from ingredients where id='${cups}'`) === 'f', 'inactive');
  ok(sql(`select count(*) from purchases where ingredient_id='${cups}'`) === '1', 'ingredient with purchases made INACTIVE instead (history kept)');
  await page.check('#ing-inactive'); await page.click(`[data-edit="${cups}"]`); await page.click('#btn-reactivate-ing');
  await until(() => sql(`select active from ingredients where id='${cups}'`) === 't', 'active again'); await modalGone(page);
  ok(true, 'ingredient made active again');

  // recipe with sales can't be deleted -> hidden instead. Batch 1: the history is checked FIRST, so Delete
  // goes straight to one "Hide it" dialog (no delete is tried, so no refused call any more).
  await page.waitForTimeout(500);
  await go(page, 'recipeDetail', '33333333-0000-0000-0000-000000000004');
  const auditsBefore = Number(sql(`select count(*) from audit_log where action='Recipe hidden'`));
  await page.click('#edit-rec-btn'); await page.click('#btn-delete-rec');
  await page.waitForSelector('#active-modal-overlay [data-ok]', {timeout: 10000});
  const firstDialog = await page.textContent('#active-modal-overlay [data-ok]');
  ok(/Hide it/.test(firstDialog), 'recipe with sales history: the first dialog after Delete is "Hide it" (no "Delete?" step first)', firstDialog);
  await confirm(page);
  await until(() => sql(`select active::text||pos_visible::text||qr_visible::text from recipes where id='33333333-0000-0000-0000-000000000004'`) === 'falsefalsefalse', 'hidden');
  await modalGone(page); await page.waitForTimeout(400);
  ok(sql(`select count(*) from recipes where id='33333333-0000-0000-0000-000000000004'`) === '1' && Number(sql(`select count(*) from audit_log where action='Recipe hidden'`)) === auditsBefore + 1, 'recipe with sales history: kept, hidden from both menus, audit "Recipe hidden"');

  // staff deactivate / reactivate
  await go(page, 'staff');
  const pia = sql(`select id from staff where name='Pia Cashier'`);
  await page.click(`[data-toggle="${pia}"]`); await confirm(page);
  await until(() => sql(`select active from staff where id='${pia}'`) === 'f', 'deactivated');
  ok(true, 'staff member deactivated');
  await page.waitForSelector(`[data-toggle="${pia}"]:has-text("Reactivate")`); await page.click(`[data-toggle="${pia}"]`);
  await until(() => sql(`select active from staff where id='${pia}'`) === 't', 'reactivated');
  ok(true, 'staff member reactivated');
  await page.click('#add-staff'); await page.fill('#sf-name', 'Rey ' + XSS); await page.selectOption('#sf-role', 'MANAGER'); await page.click('#sf-save'); await modalGone(page);
  ok(sql(`select role from staff where name like 'Rey%'`) === 'MANAGER', 'manager added without a PIN (PIN can be set later)');

  // costing method: weighted average vs latest purchase
  const beans = '22222222-0000-0000-0000-000000000001';
  sql(`insert into purchases(business_id, ingredient_id, purchase_date, quantity, purchase_unit, base_quantity, total_price, price_per_base_unit) values ('${biz}','${beans}', current_date, 1, 'kg', 1000, 1500, 1.5)`);
  await page.click('#btn-refresh'); await page.waitForTimeout(1500);
  const avg = await page.evaluate((id) => ingredientCosting(id).current, beans);
  await go(page, 'settings'); await page.click('[data-tab="general"]');
  await page.selectOption('#set-costing', 'latest'); await page.click('#save-general'); await page.waitForTimeout(1500);
  const latest = await page.evaluate((id) => ingredientCosting(id).current, beans);
  ok(Math.abs(avg - 1.2) < 1e-9 && latest === 1.5, `costing: weighted average ₱${avg}/g ((900+1500)/2000) → latest purchase ₱${latest}/g`);
  await page.selectOption('#set-costing', 'weighted_average'); await page.click('label:has(#set-dark) .slider-tog'); await page.click('#save-general'); await page.waitForTimeout(1500);
  ok(await page.evaluate(() => document.body.classList.contains('dark')) && sql(`select theme from settings where business_id='${biz}'`) === 'dark', 'dark theme saved and applied');
  await go(page, 'dashboard'); await page.waitForTimeout(800);
  await page.screenshot({path: SHOTS + 'f-dark-dashboard.png'});
  await go(page, 'settings'); await page.click('[data-tab="general"]'); await page.click('label:has(#set-dark) .slider-tog'); await page.click('#save-general'); await page.waitForTimeout(1200);

  // logo upload (stored in the shop's folder, shown in the sidebar)
  const LOGO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAKklEQVR4nGP8z4AKGBkYGP6jCjAyMDAwMDAyMjIyMjAyMDAwMDIyAgAAMgAJ7Ivd4gAAAABJRU5ErkJggg==', 'base64');
  await go(page, 'settings'); await page.click('[data-tab="branding"]');
  await page.setInputFiles('#cz-logo-input', {name: 'logo.png', mimeType: 'image/png', buffer: LOGO});
  await page.waitForSelector('#cz-logo-preview img');
  await page.click('#cz-save'); await page.waitForTimeout(1500);
  const logoUrl = sql(`select logo_url from settings where business_id='${biz}'`);
  ok(logoUrl.includes('/menu-images/' + biz + '/logo-') && await page.$('#sidebar .brand img'), 'logo uploaded to the shop folder and shown in the sidebar');

  // customer with HTML in the name (as if typed on the QR page), then visit every screen
  sql(`insert into customers(business_id, nickname, phone, source, notes) values ('${biz}', $$<b id="xss">Eve</b>$$, '+639201112222', 'QR', $$<img src=x onerror="window.__xss=1">$$)`);
  sql(`update sales set cashier_name = $$<b id="xss">C</b>$$ where grand_total = 235`);
  for(const r of ['dashboard','calendar','transactions','qrOrders','customers','ingredients','purchases','production','recipes','inventory','costing','suppliers','reports','tables','staff','devices','auditLog','settings','backup']){
    await go(page, r); await page.waitForTimeout(700);
    if(await page.$('#xss')) errors.push('unescaped HTML on ' + r);
  }
  await go(page, 'customers'); await page.waitForSelector('[data-cust]');
  await page.click('[data-cust]:has-text("Eve")'); await page.waitForSelector('#cu-notes');
  if(await page.$('#xss')) errors.push('unescaped HTML in customer detail');
  await page.click('#active-modal-overlay [data-cancel]');
  await go(page, 'transactions'); await page.waitForSelector('tr[data-sale]'); await page.click('tr[data-sale]:has-text("235.00")');
  await page.waitForSelector('#sm-print'); if(await page.$('#xss')) errors.push('unescaped HTML in sale detail');
  await page.click('#active-modal-overlay [data-close]'); await modalGone(page);
  ok(!(await page.evaluate(() => window.__xss)) && dialogs === 0, 'names with HTML are shown as text everywhere (nothing injected)');

  // report CSV
  await go(page, 'reports'); await page.click('[data-report="inventoryValue"]'); await page.waitForSelector('#report-body table');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-report-csv')]);
  const csv = require('fs').readFileSync(await dl.path(), 'utf8');
  ok(csv.startsWith('"Ingredient","Stock","Unit cost","Inventory value"') && /"Total","","",/.test(csv), 'report CSV keeps plain numbers + a total row');

  ok(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
