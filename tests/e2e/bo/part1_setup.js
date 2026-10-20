// Back Office part 1 (fresh e2e seed): ingredients + starting stock, purchases (kg -> g, box -> pcs),
// production recipe with its produced item, a drink with option groups (+ stock extras) and a photo,
// a production batch, waste and a stock count, staff + PINs, pairing a counter from Devices (code + QR
// link), rename / unlock / remove a counter, tables + printable QR sheet, QR menu on/off, audit log.
// Run all parts in order with tests/e2e/bo.e2e.js (BO_VIEWPORT=1280x900 or 768x1024).
const H = require('./bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo/part1_setup@' + H.sizeTag();
const {sql, rows, one, ok, must: until, confirm, toastText, clearToasts, go, modalGone} = H;
const BASE = H.BASE, SHOTS = require('path').join(H.SHOTS, 'bo-' + H.sizeTag() + '-');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAKklEQVR4nGP8z4AKGBkYGP6jCjAyMDAwMDAyMjIyMjAyMDAwMDIyAgAAMgAJ7Ivd4gAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const browser = await chromium.launch();
  const ctx = await H.boContext(browser);
  const page = await ctx.newPage();
  const errors = []; H.attach(page, errors, 'BO');
  await page.goto(BASE + '/cccc/back/');
  await H.focusSettled(page, 'li-email');
  await page.fill('#li-email', 'owner@example.com'); await page.fill('#li-pass', 'secret123');
  await page.click('#f-login button[type=submit]');
  await page.waitForSelector('#app', {state: 'visible', timeout: 20000});
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  ok(sql(`select count(*) from categories where name='House-Made / Produced' and business_id='${biz}'`) === '1', 'first open adds the "House-Made / Produced" category');

  // --- ingredient with starting stock
  await go(page, 'ingredients');
  await page.click('#btn-new-ingredient');
  await page.fill('#f-name', 'Muscovado Sugar');
  await page.selectOption('#f-unit', 'g');
  await page.fill('#f-initial', '1000');
  await page.click('#btn-save-ing'); await modalGone(page);
  const mus = one(`select id from ingredients where name='Muscovado Sugar'`).id;
  ok(sql(`select quantity from inventory_transactions where ingredient_id='${mus}' and transaction_type='INITIAL_STOCK'`) === '1000', 'new ingredient + starting stock saved together');
  await page.click('#btn-new-ingredient');
  await page.fill('#f-name', 'Cups 16oz'); await page.selectOption('#f-unit', 'pcs');
  await page.click('#btn-save-ing'); await modalGone(page);
  const cups = one(`select id from ingredients where name='Cups 16oz'`).id;

  // --- purchases (kg -> g, and box -> pcs with conversion)
  await go(page, 'purchases');
  await page.click('#btn-new-purchase');
  await page.selectOption('#p-ing', mus);
  await page.fill('#p-qty', '2'); await page.selectOption('#p-unit', 'kg'); await page.fill('#p-price', '300');
  ok((await page.textContent('#p-preview-text')).includes('₱0.15 per g'), 'purchase preview shows ₱0.15 per g');
  await page.click('#btn-save-pur'); await modalGone(page);
  const p1 = one(`select id, base_quantity, price_per_base_unit from purchases where ingredient_id='${mus}'`);
  ok(Number(p1.base_quantity) === 2000 && Math.abs(Number(p1.price_per_base_unit) - 0.15) < 1e-9, 'purchase 2 kg -> 2000 g at ₱0.15/g');
  ok(sql(`select quantity from inventory_transactions where reference_id='${p1.id}' and transaction_type='PURCHASE'`) === '2000', 'purchase stock line saved with the purchase');
  await page.click('#btn-new-purchase');
  await page.selectOption('#p-ing', cups);
  await page.fill('#p-qty', '2'); await page.selectOption('#p-unit', 'box'); await page.fill('#p-price', '500');
  ok(await page.isVisible('#p-conversion-row'), 'box purchase asks for units per box');
  await page.click('#btn-save-pur'); await page.waitForSelector('.toast.error'); await clearToasts(page);
  await page.fill('#p-conversion', '50');
  await page.click('#btn-save-pur'); await modalGone(page);
  ok(sql(`select base_quantity from purchases where ingredient_id='${cups}'`) === '100', 'box of 50 x2 -> 100 pcs');

  // --- production recipe (auto-creates its produced ingredient)
  const milk = '22222222-0000-0000-0000-000000000002', beans = '22222222-0000-0000-0000-000000000001';
  await go(page, 'recipes');
  await page.click('#btn-new-recipe');
  await page.fill('#r-name', 'Caramel Sauce');
  await page.selectOption('#r-type', 'SAUCES_SYRUPS');
  ok(await page.isChecked('#r-produces'), 'sauces/syrups start as "produces an inventory item"');
  await page.fill('#r-yield', '800'); await page.selectOption('#r-yield-unit', 'ml');
  await page.selectOption('#ri-body tr:nth-child(1) .ri-ing', mus); await page.fill('#ri-body tr:nth-child(1) .ri-qty', '400');
  await page.click('#ri-add-row');
  await page.selectOption('#ri-body tr:nth-child(2) .ri-ing', milk); await page.fill('#ri-body tr:nth-child(2) .ri-qty', '200');
  await page.click('#btn-save-rec'); await modalGone(page);
  const sauce = one(`select r.id, r.produced_ingredient_id, i.source_recipe_id, i.is_produced_item, i.base_unit from recipes r join ingredients i on i.id=r.produced_ingredient_id where r.name='Caramel Sauce'`);
  ok(sauce && sauce.source_recipe_id === sauce.id && sauce.is_produced_item && sauce.base_unit === 'ml', 'production recipe and its produced ingredient point at each other');
  ok(sql(`select count(*) from recipe_ingredients where recipe_id='${sauce.id}'`) === '2', 'recipe ingredient lines saved with the recipe');

  // --- drink with options, description, photo
  ok(await page.isVisible('#edit-rec-btn'), 'after saving, the recipe page opens');
  await go(page, 'recipes');
  await page.click('#btn-new-recipe');
  await page.fill('#r-name', 'Caramel Macchiato');
  await page.fill('#r-cat', 'Iced'); await page.fill('#r-price', '160');
  await page.fill('#r-desc', 'Espresso, milk & house caramel'); await page.fill('#r-sort', '1');
  await page.selectOption('#ri-body tr:nth-child(1) .ri-ing', beans); await page.fill('#ri-body tr:nth-child(1) .ri-qty', '18');
  await page.click('#ri-add-row'); await page.selectOption('#ri-body tr:nth-child(2) .ri-ing', milk); await page.fill('#ri-body tr:nth-child(2) .ri-qty', '180');
  await page.click('#ri-add-row'); await page.selectOption('#ri-body tr:nth-child(3) .ri-ing', sauce.produced_ingredient_id); await page.fill('#ri-body tr:nth-child(3) .ri-qty', '30');
  // group 1: Size (pick one, required)
  await page.click('#mod-add-group');
  let g = '#mod-editor .mod-ed-group:nth-child(1)';
  await page.fill(g + ' .mg-name', 'Size'); await page.check(g + ' .mg-req');
  await page.fill(g + ' tbody tr:nth-child(1) .mo-label', '12oz');
  await page.click(g + ' .mo-add');
  await page.fill(g + ' tbody tr:nth-child(2) .mo-label', '16oz'); await page.fill(g + ' tbody tr:nth-child(2) .mo-price', '20');
  await page.selectOption(g + ' tbody tr:nth-child(2) .mo-ing', milk);
  // forgot the amount -> clear error
  await page.click('#btn-save-rec');
  ok((await toastText(page, 'error')).includes('extra amount'), 'option using an ingredient needs an extra amount');
  await clearToasts(page);
  await page.fill(g + ' tbody tr:nth-child(2) .mo-qty', '60');
  // group 2: Add-ons (pick many)
  await page.click('#mod-add-group');
  g = '#mod-editor .mod-ed-group:nth-child(2)';
  await page.fill(g + ' .mg-name', 'Add-ons'); await page.selectOption(g + ' .mg-multi', 'many');
  await page.fill(g + ' tbody tr:nth-child(1) .mo-label', 'Extra shot'); await page.fill(g + ' tbody tr:nth-child(1) .mo-price', '30');
  await page.selectOption(g + ' tbody tr:nth-child(1) .mo-ing', beans); await page.fill(g + ' tbody tr:nth-child(1) .mo-qty', '18');
  await page.click(g + ' .mo-add');
  await page.fill(g + ' tbody tr:nth-child(2) .mo-label', 'Caramel drizzle'); await page.fill(g + ' tbody tr:nth-child(2) .mo-price', '15');
  await page.selectOption(g + ' tbody tr:nth-child(2) .mo-ing', sauce.produced_ingredient_id); await page.fill(g + ' tbody tr:nth-child(2) .mo-qty', '10');
  await page.setInputFiles('#r-photo', {name: 'macchiato.png', mimeType: 'image/png', buffer: PNG});
  await page.waitForSelector('#r-photo-prev img');
  await page.screenshot({path: SHOTS + 'f-recipe-form.png', fullPage: true});
  await page.click('#btn-save-rec'); await modalGone(page);
  const mac = one(`select id, modifier_groups, image_url, description, sort_order, selling_price from recipes where name='Caramel Macchiato'`);
  const mg = mac.modifier_groups;
  ok(mg.length === 2 && mg[0].name === 'Size' && mg[0].required === true && mg[0].multi_select === false && mg[1].multi_select === true, 'option groups saved (Size pick-one required, Add-ons pick-many)');
  ok(mg[0].options[1].label === '16oz' && Number(mg[0].options[1].price_delta) === 20 && mg[0].options[1].ingredient_id === milk && Number(mg[0].options[1].ingredient_qty_delta) === 60, '16oz option: +₱20, +60 ml milk');
  ok(mg[1].options[0].ingredient_id === beans && Number(mg[1].options[0].ingredient_qty_delta) === 18, 'Extra shot option uses +18 g beans');
  ok(mac.image_url && mac.image_url.includes('/storage/v1/object/public/menu-images/' + biz + '/' + mac.id + '-'), 'photo uploaded to menu-images/<shop>/<recipe>-<time>.jpg');
  const img = await page.evaluate(async (u) => { const r = await fetch(u); return {status: r.status, type: r.headers.get('content-type')}; }, mac.image_url);
  ok(img.status === 200 && img.type === 'image/jpeg', 'photo is served back as a JPEG');
  ok(mac.description === 'Espresso, milk & house caramel' && mac.sort_order === 1, 'description and menu order saved');
  await page.screenshot({path: SHOTS + 'f-recipe-detail.png', fullPage: true});

  // --- produce a batch
  await go(page, 'production');
  await page.click('#btn-new-production');
  await page.selectOption('#pr-recipe', sauce.id);
  ok((await page.inputValue('#pr-expected')) === '800', 'expected yield defaults to the recipe yield');
  await page.fill('#pr-actual', '760');
  ok(await page.isVisible('#pr-waste-row'), 'shortfall asks why');
  await page.click('#btn-save-prod'); await modalGone(page);
  const bat = one(`select id, raw_cost_total, actual_cost_per_unit, actual_yield from production_batches where recipe_id='${sauce.id}'`);
  ok(Math.abs(Number(bat.raw_cost_total) - 80) < 1e-6, 'batch cost = 400 g x ₱0.15 + 200 ml x ₱0.10 = ₱80 (live costing)');
  ok(Math.abs(Number(bat.actual_cost_per_unit) - 80/760) < 1e-9, 'cost per ml uses the actual yield (80 / 760)');
  const bl = rows(`select ingredient_id, transaction_type, quantity from inventory_transactions where reference_id='${bat.id}' order by transaction_type, ingredient_id`);
  ok(bl.length === 3 && bl.some(x => x.transaction_type === 'PRODUCTION' && Number(x.quantity) === 760) && bl.some(x => x.ingredient_id === mus && Number(x.quantity) === 400) && bl.some(x => x.ingredient_id === milk && Number(x.quantity) === 200), 'batch + ingredients used + yield saved together');
  await page.screenshot({path: SHOTS + 'f-production.png'});

  // --- waste and a stock count
  await go(page, 'inventory');
  await page.click('#btn-new-waste');
  await page.selectOption('#w-ing', milk); await page.fill('#w-qty', '50');
  await page.click('#btn-save-waste'); await modalGone(page);
  const w = one(`select id from waste where ingredient_id='${milk}'`);
  ok(w && sql(`select quantity from inventory_transactions where reference_id='${w.id}' and transaction_type='WASTE'`) === '50', 'waste + its stock line');
  const beansBefore = Number(sql(`select stock from v_ingredient_stock where ingredient_id='${beans}'`));
  await page.click('#btn-new-adjustment');
  await page.selectOption('#a-ing', beans);
  await page.click('[data-mode="count"]');
  await page.fill('#a-count', '900');
  await page.click('#btn-save-adj'); await modalGone(page);
  ok(Number(sql(`select stock from v_ingredient_stock where ingredient_id='${beans}'`)) === 900 && beansBefore === 1000, 'stock count 900 -> adjustment of -100');
  await page.screenshot({path: SHOTS + 'f-inventory.png'});

  // --- ingredient detail history
  await go(page, 'ingredientDetail', mus);
  await page.waitForSelector('#ing-history table');
  ok((await page.textContent('#ing-history')).includes('2600.00 g'), 'ingredient history shows the running stock (1000 + 2000 - 400 = 2600 g)');
  await page.screenshot({path: SHOTS + 'f-ingredient-detail.png', fullPage: true});

  // --- staff & PINs
  await go(page, 'staff');
  ok(!(await page.$('[data-toggle="' + sql(`select id from staff where profile_id='00000000-0000-0000-0000-0000000000a1'`) + '"]')), 'owner row has no Deactivate button');
  await page.click('#add-staff');
  await page.fill('#sf-name', 'Pia Cashier'); await page.fill('#sf-pin', '5555'); await page.fill('#sf-pin2', '5555');
  await page.click('#sf-save'); await modalGone(page);
  const pia = one(`select s.id, s.role, exists(select 1 from staff_pins p where p.staff_id=s.id and p.pin_hash is not null) as has_pin from staff s where name='Pia Cashier'`);
  ok(pia && pia.role === 'CASHIER' && pia.has_pin, 'staff added with a PIN (stored hashed by the server)');
  await page.click(`[data-pin="${pia.id}"]`);
  await H.focusSettled(page, 'sp-pin');
  await page.fill('#sp-pin', '1111'); await page.fill('#sp-pin2', '1111'); await page.click('#sp-save');
  const pinToast = await toastText(page, 'error');
  ok(pinToast.includes('already uses that PIN'), 'a PIN already used by someone else is refused', pinToast);
  await clearToasts(page);
  await page.fill('#sp-pin', '6666'); await page.fill('#sp-pin2', '6666'); await page.click('#sp-save'); await modalGone(page);
  const ownerId = sql(`select id from staff where profile_id='00000000-0000-0000-0000-0000000000a1'`);
  await page.click(`[data-edit="${ownerId}"]`);
  ok(await page.isDisabled('#sf-role'), "owner's own role can't be changed");
  await page.click('[data-cancel]');
  await page.screenshot({path: SHOTS + 'f-staff.png'});

  // --- devices: pair a counter from the Back Office
  await go(page, 'devices');
  await page.click('#pair-new');
  await page.fill('#pd-name', 'Bar iPad');
  await page.click('#pd-make');
  await page.waitForSelector('.big-code');
  const code = (await page.textContent('.big-code')).trim();
  ok(/^[A-Z2-9]{6}$/.test(code), 'pairing code shown big (' + code + ')');
  ok(await page.$('.pair-box .qr-img svg'), 'pairing QR code shown');
  await page.screenshot({path: SHOTS + 'f-pairing.png'});
  const ctx2 = await H.counterContext(browser);
  const fo = await ctx2.newPage(); H.attach(fo, errors, 'FO2');
  await fo.goto(BASE + '/cccc/front/?pair=' + code);
  await fo.waitForSelector('#su-code');
  ok((await fo.inputValue('#su-code')) === code, 'the QR link fills the code in on the counter');
  await fo.click('#su-pair');
  await fo.waitForSelector('#pin-gate', {state: 'visible', timeout: 20000});
  ok(true, 'counter paired with the Back Office code');
  for(const d of '6666') await fo.click(`#pin-pad button[data-k="${d}"]`);
  await fo.click('#pin-enter');
  await fo.waitForSelector('#ss-opening-cash', {timeout: 15000});
  ok(true, "new staff member's PIN works at the counter");
  await ctx2.close();
  await page.click('#active-modal-overlay [data-cancel]');
  await page.waitForTimeout(1200);
  const dev = one(`select id, device_name, active from devices order by paired_at desc nulls last limit 1`);
  console.log('     (counter named on its own screen: ' + (dev && dev.device_name) + ')');
  ok(dev && dev.active, 'paired counter listed');
  await page.click(`[data-rename="${dev.id}"]`); await page.fill('#dv-name', 'Bar tablet'); await page.click('#dv-save'); await modalGone(page);
  ok(sql(`select device_name from devices where id='${dev.id}'`) === 'Bar tablet', 'counter renamed');
  await clearToasts(page);
  await page.click(`[data-unlock="${dev.id}"]`);
  const ut = await toastText(page); console.log('     toast: ' + ut);
  ok(/Unlocked/.test(ut), 'unlock PIN pad');
  await page.click(`[data-remove="${dev.id}"]`); await confirm(page);
  await until(() => sql(`select active from devices where id='${dev.id}'`) === 'f', 'device removed');
  ok(true, 'counter removed (revoke_device)');
  await page.screenshot({path: SHOTS + 'f-devices.png'});

  // --- tables & QR codes
  await go(page, 'tables');
  await page.click('#add-tables');
  await page.fill('#at-from', '1'); await page.fill('#at-to', '3');
  await page.click('#at-save'); await modalGone(page);
  ok(sql(`select string_agg(label, ',' order by sort_order) from dining_tables where label like 'Table _'`) === 'Table 1,Table 2,Table 3,Table 5', 'tables 1-3 added (Table 5 already there)');
  const t1 = one(`select id, qr_token from dining_tables where label='Table 1'`);
  await page.click(`[data-recode="${t1.id}"]`); await confirm(page);
  await until(() => sql(`select qr_token from dining_tables where id='${t1.id}'`) !== t1.qr_token, 'new code');
  ok(/^[0-9a-f]{16}$/.test(sql(`select qr_token from dining_tables where id='${t1.id}'`)), 'new QR code made for Table 1');
  await page.waitForTimeout(500);
  const [popup] = await Promise.all([ctx.waitForEvent('page'), (async () => { await page.click('#print-qr'); await page.click('#pq-go'); })()]);
  await popup.waitForLoadState();
  const svgs = await popup.$$eval('.card svg', n => n.length);
  const html = await popup.content();
  ok(svgs === 5, 'printable QR sheet with one card per active table (' + svgs + ')');
  await popup.screenshot({path: SHOTS + 'f-qr-sheet.png', fullPage: true});
  await popup.close();
  const link = await page.evaluate((id) => tableOrderUrl(state.tables.find(t => t.id === id)), t1.id);
  ok(link === BASE + '/cccc/order/?t=' + sql(`select qr_token from dining_tables where id='${t1.id}'`), 'order link = …/cccc/order/?t=<code>');
  await page.screenshot({path: SHOTS + 'f-tables.png', fullPage: true});
  // hide an item from the QR menu
  await page.click(`label:has([data-qrvis="33333333-0000-0000-0000-000000000004"]) .slider-tog`);
  await until(() => sql(`select qr_visible from recipes where id='33333333-0000-0000-0000-000000000004'`) === 'f', 'qr hidden');
  await page.waitForTimeout(800); await page.click(`label:has([data-qrvis="33333333-0000-0000-0000-000000000004"]) .slider-tog`);
  await until(() => sql(`select qr_visible from recipes where id='33333333-0000-0000-0000-000000000004'`) === 't', 'qr shown');
  ok(true, 'QR menu on/off toggles save straight away');

  ok(Number(sql(`select count(*) from audit_log where actor_name='Zed'`)) >= 15, 'Back Office actions are in the audit log');
  ok(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
