// Release 1.2 Back Office checks (adopted from back-office-dev's features.js + lib.js):
//   1. floor plan editor: tray, add tables/shapes, mouse drag + grid snap, corner resize, keyboard nudge/rotate,
//      unsaved-changes warning, ONE apply_changes per "Save layout", reload keeps the layout, delete / unplace;
//   1b. touch drag on a 1024x768 tablet (real touch events);
//   2. sub-category colours (one settings update); 3. ingredient brands (add, same-name refused, purchase +
//      adjustment with a brand, "In use now", switch off, BRAND_IN_USE wording, new ingredient + brand + stock
//      in one call); 4. loyalty stamp-card settings; 5. CCCC / Custom theme; 6. customers stamp card + rewards
//      used; 7. backup v6 includes brands / floor shapes / rewards used, has exported_at, and re-import is a no-op.
// Screenshots: $QA_SHOTS/bo12-*.png.   Needs a fresh seed:
//   tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
//   FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo_release12.e2e.js
const path = require('path');
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo_release12.e2e';
async function login(opts){
  opts = opts || {};
  const browser = await chromium.launch();
  const ctx = await browser.newContext(Object.assign({viewport: opts.viewport || {width: 1280, height: 800}, timezoneId: 'Asia/Manila', acceptDownloads: true}, opts.ctx || {}));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  page.on('console', m => { if(m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
  await H.boLogin(page);
  await page.waitForTimeout(500);
  return {browser, ctx, page, errors};
}
async function go(page, r, p){ await page.evaluate(([r, p]) => navigate(r, p), [r, p == null ? null : p]); await page.waitForTimeout(500); }
const L = Object.assign({}, H, {login, go, SHOTS: path.join(H.SHOTS, 'bo12-')});
const {ok, sql} = L;
const SH = L.SHOTS;
const BIZ = () => sql(`select id from businesses limit 1`);
async function countApply(page, fn){
  let n = 0; const h = (req) => { if(/\/rpc\/apply_changes/.test(req.url())) n++; };
  page.on('request', h); await fn(); await page.waitForTimeout(1500); page.off('request', h); return n;
}
async function confirmOk(page){ await page.waitForSelector('#active-modal-overlay [data-ok]'); await page.click('#active-modal-overlay [data-ok]'); }
(async () => {
  const {browser, page, errors} = await L.login();
  const biz = BIZ();
  // ---------- 1. floor plan ----------
  await L.go(page, 'tables');
  ok(await page.$('#fp-plan') && await page.$('[data-fp-tray]'), 'floor plan shows; Table 5 (not placed) is in the tray');
  await page.click('[data-fp-tray]');                                   // tap -> free spot
  ok(await page.$('#fp-plan .fp-table'), 'tapping a tray table puts it on the plan');
  await page.click('[data-fp-add-table="ROUND"]');
  await page.click('[data-fp-add-table="RECT"]');
  await page.selectOption('#fp-add-shape', 'COUNTER');
  await page.selectOption('#fp-add-shape', 'DOOR');
  ok((await page.$$('#fp-plan .fp-item')).length === 5, '5 items on the plan (3 tables, counter, door)');
  ok((await page.textContent('#fp-status')).includes('Unsaved'), 'status says "Unsaved changes"');
  // mouse drag Table 5
  const t5 = sql(`select id from dining_tables where label='Table 5'`);
  const el = await page.$(`[data-fp="t:${t5}"]`);
  const plan = await (await page.$('#fp-plan')).boundingBox();
  const b0 = await el.boundingBox();
  await page.mouse.move(b0.x + b0.width/2, b0.y + b0.height/2); await page.mouse.down();
  await page.mouse.move(b0.x + b0.width/2 + plan.width*0.3, b0.y + b0.height/2 + plan.height*0.4, {steps: 8}); await page.mouse.up();
  const d5 = await page.evaluate((id) => { const d = FP.tables.get(id); return {x: d.pos_x, y: d.pos_y, w: d.width, h: d.height}; }, t5);
  ok(d5.x >= 300 && d5.y >= 400 && d5.x % 10 === 0 && d5.y % 10 === 0, 'mouse drag moved Table 5 and snapped to the 10-unit grid', d5);
  // resize with the corner handle
  const se = await page.$(`[data-fp="t:${t5}"] .fp-h-se`);
  const hb = await se.boundingBox();
  await page.mouse.move(hb.x + hb.width/2, hb.y + hb.height/2); await page.mouse.down();
  await page.mouse.move(hb.x + plan.width*0.06, hb.y + plan.height*0.04, {steps: 5}); await page.mouse.up();
  const d5b = await page.evaluate((id) => { const d = FP.tables.get(id); return {w: d.width, h: d.height}; }, t5);
  ok(d5b.w > d5.w && d5b.h > d5.h, 'corner handle made it bigger', [d5, d5b]);
  // keyboard: arrows nudge, R rotates
  await page.focus(`[data-fp="t:${t5}"]`);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowUp');
  await page.keyboard.press('r'); await page.keyboard.press('r');
  const d5c = await page.evaluate((id) => { const d = FP.tables.get(id); return {x: d.pos_x, y: d.pos_y, r: d.rotation}; }, t5);
  ok(d5c.x === d5.x + 20 && d5c.y === d5.y - 10 && d5c.r === 30, 'keyboard: arrows move by 10, R turns 15°', d5c);
  // inspector: label + seats
  await page.fill('#fp-label', 'Table 5 Window'); await page.fill('#fp-seats', '4');
  ok((await page.textContent(`[data-fp="t:${t5}"]`)).includes('4 seats'), 'seats show on the table');
  // unsaved warning
  await page.evaluate(() => navigate('dashboard'));
  await page.waitForSelector('#active-modal-overlay [data-cancel]');
  ok((await page.textContent('#active-modal-overlay')).includes('not saved'), 'leaving with unsaved changes asks first');
  await page.click('#active-modal-overlay [data-cancel]'); await page.waitForTimeout(300);
  ok(await page.evaluate(() => state.route) === 'tables' && await page.$(`[data-fp="t:${t5}"]`), 'Cancel stays on the plan with the draft kept');
  // a table with a duplicate name is refused before saving
  const before = await page.evaluate(() => [...FP.tables.values()].find(d => d.label === 'Table 6') ? 1 : 0);
  await page.screenshot({path: SH + 'fp-editing-1280.png'});
  const calls = await countApply(page, async () => { await page.click('#fp-save'); });
  ok(calls === 1, `"Save layout" = ONE apply_changes call (got ${calls})`);
  const row5 = L.one(`select label, shape, pos_x::int x, pos_y::int y, width::int w, height::int h, rotation, seats from dining_tables where id='${t5}'`);
  ok(row5.label === 'Table 5 Window' && row5.x === d5c.x && row5.y === d5c.y && row5.rotation === 30 && row5.seats === 4 && row5.w === d5b.w, 'Table 5 saved: name, place, size, rotation, seats', row5);
  ok(Number(sql(`select count(*) from dining_tables where kind='DINE_IN' and pos_x is not null`)) === 3 && Number(sql(`select count(*) from dining_tables where qr_token is not null and kind='DINE_IN'`)) === 3, 'two new tables saved with their own QR codes');
  ok(sql(`select string_agg(kind, ',' order by kind) from floor_shapes`) === 'COUNTER,DOOR', 'counter + door saved in floor_shapes');
  ok((await page.textContent('#fp-status')).includes('All changes saved'), 'status back to "All changes saved"');
  // reload: same layout
  await page.reload(); await page.waitForSelector('#app', {state: 'visible'}); await L.go(page, 'tables');
  const after = await page.evaluate((id) => { const d = FP.tables.get(id); const el = document.querySelector(`[data-fp="t:${id}"]`); return {x: d.pos_x, r: d.rotation, style: el && el.getAttribute('style')}; }, t5);
  ok(after.x === d5c.x && after.r === 30 && /rotate\(30deg\)/.test(after.style), 'after reload the plan is the same', after);
  // delete a shape + take a table off the plan -> tray
  const door = sql(`select id from floor_shapes where kind='DOOR'`);
  await page.click(`[data-fp="s:${door}"]`); await page.click('#fp-delete');
  await page.click(`[data-fp="t:${t5}"]`); await page.click('#fp-unplace');
  ok(await page.$(`[data-fp-tray="${t5}"]`), 'taken off the plan -> back in the tray');
  await page.click('#fp-save'); await page.waitForTimeout(1500);
  ok(sql(`select count(*) from floor_shapes where kind='DOOR'`) === '0' && sql(`select coalesce(pos_x::text,'null') from dining_tables where id='${t5}'`) === 'null', 'door deleted, Table 5 not placed (pos_x empty) after save');
  await browser.close();

  // ---------- 1b. touch drag on a tablet (real touch events through CDP) ----------
  {
    const T = await L.login({viewport: {width: 1024, height: 768}, ctx: {hasTouch: true, isMobile: false}});
    const p = T.page;
    await L.go(p, 'tables');
    const cdp = await p.context().newCDPSession(p);
    const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x, y}]});
    // drag Table 5 from the tray onto the plan
    const chip = await (await p.$(`[data-fp-tray="${t5}"]`)).boundingBox();
    const pl = await (await p.$('#fp-plan')).boundingBox();
    await touch('touchStart', chip.x + 20, chip.y + chip.height/2);
    for(let i = 1; i <= 10; i++) await touch('touchMove', chip.x + 20 + (pl.x + pl.width*0.75 - chip.x - 20) * i/10, chip.y + chip.height/2 + (pl.y + pl.height*0.2 - chip.y - chip.height/2) * i/10);
    await touch('touchEnd');
    await p.waitForTimeout(300);
    const dt = await p.evaluate((id) => { const d = FP.tables.get(id); return {x: d.pos_x, y: d.pos_y}; }, t5);
    ok(dt.x != null && dt.x > 600 && dt.y < 300, 'touch: dragged Table 5 from the tray onto the plan where the finger lifted', dt);
    // touch-drag it again on the plan
    const eb = await (await p.$(`[data-fp="t:${t5}"]`)).boundingBox();
    await touch('touchStart', eb.x + eb.width/2, eb.y + eb.height/2);
    for(let i = 1; i <= 8; i++) await touch('touchMove', eb.x + eb.width/2 - pl.width*0.2*i/8, eb.y + eb.height/2 + pl.height*0.3*i/8);
    await touch('touchEnd'); await p.waitForTimeout(300);
    const dt2 = await p.evaluate((id) => { const d = FP.tables.get(id); return {x: d.pos_x, y: d.pos_y}; }, t5);
    ok(dt2.x < dt.x - 100 && dt2.y > dt.y + 200, 'touch: dragging a table on the plan moves it', [dt, dt2]);
    await p.screenshot({path: SH + 'fp-touch-1024.png'});
    await p.click('#fp-save'); await p.waitForTimeout(1500);
    ok(Number(sql(`select pos_x from dining_tables where id='${t5}'`)) === dt2.x, 'touch layout saved');
    ok(!T.errors.length, 'no browser errors (tablet)', T.errors);
    await T.browser.close();
  }

  // ---------- 2. sub-category colours ----------
  const S2 = await L.login(); const q = S2.page;
  await L.go(q, 'recipes');
  await q.click('#btn-subcat-colors'); await q.waitForSelector('.sc-row');
  const names = await q.$$eval('.sc-name', ns => ns.map(n => n.textContent.trim()));
  ok(names.some(n => n.startsWith('Hot')) && names.some(n => n.startsWith('Iced')) && names.some(n => n.startsWith('Pastry')), 'colour manager lists Hot, Iced and Pastry (type name as fallback)', names);
  const rows = await q.$$('.sc-row');
  const idx = {};
  for(let i = 0; i < names.length; i++) idx[names[i].split(' (')[0]] = i;
  await q.click(`.sc-row[data-sc="${idx.Hot}"] label.sc-sw:has(input[value="olive"]) span`);
  await q.click(`.sc-row[data-sc="${idx.Pastry}"] label.sc-sw:has(input[value="butter"]) span`);
  ok(/tile-olive-bg/.test(await q.getAttribute(`#sc-prev-${idx.Hot} .sc-tile`, 'style')), 'preview tile takes the picked colour');
  await q.screenshot({path: SH + 'colours-1280.png'});
  const c2 = await countApply(q, async () => { await q.click('#sc-save'); });
  ok(c2 === 1 && sql(`select subcategory_colors::text from settings where business_id='${biz}'`) === '{"Hot": "olive", "Pastry": "butter"}', 'colours saved with one update on settings.subcategory_colors', sql(`select subcategory_colors::text from settings`));
  await q.waitForTimeout(500);
  // 1.3 (A14, lead-approved 2026-11-02): the colour dot became a card header in the sub-category's tile colour
  const heads = await q.$$eval('.rec-card.tinted .rec-card-head', hs => hs.map(h => {
    const probe = document.createElement('div'); probe.style.background = 'var(--tile-olive-bg)'; document.body.appendChild(probe);
    const olive = getComputedStyle(probe).backgroundColor; probe.remove();
    return {name: (h.querySelector('.rec-name') || {}).textContent, sub: (h.querySelector('.rec-sub') || {}).textContent || '', bg: getComputedStyle(h).backgroundColor, olive};
  }));
  const hotHead = heads.find(h => /· Hot\b/.test(h.sub));
  ok(hotHead && hotHead.bg === hotHead.olive && hotHead.bg !== 'rgba(0, 0, 0, 0)', 'recipe cards: a "Hot" card header has the olive tile background (picked colour)', heads);

  // ---------- 3. brands ----------
  const milk = '22222222-0000-0000-0000-000000000002';
  await L.go(q, 'ingredientDetail', milk);
  await q.fill('#brand-new-name', 'Laciate'); await q.click('#brand-add'); await q.waitForTimeout(1200);
  await q.fill('#brand-new-name', 'Alaska'); await q.click('#brand-add'); await q.waitForTimeout(1200);
  await q.fill('#brand-new-name', 'alaska '); await q.click('#brand-add'); await q.waitForTimeout(600);
  ok(sql(`select string_agg(name, ',' order by sort_order) from ingredient_brands where ingredient_id='${milk}'`) === 'Laciate,Alaska', 'two brands added; a same-name brand (other case) refused');
  const laciate = sql(`select id from ingredient_brands where name='Laciate'`), alaska = sql(`select id from ingredient_brands where name='Alaska'`);
  // purchase with brand Alaska
  await q.click('#buy-btn'); await q.waitForSelector('#p-brand');
  const opts = await q.$$eval('#p-brand option', os => os.map(o => o.textContent));
  ok(opts.join('|') === 'No brand / not sure|Laciate|Alaska', 'purchase form: Brand dropdown with the active brands', opts);
  await q.selectOption('#p-brand', alaska); await q.fill('#p-qty', '1'); await q.selectOption('#p-unit', 'L'); await q.fill('#p-price', '95');
  await q.screenshot({path: SH + 'purchase-form-1280.png'});
  await q.click('#btn-save-pur'); await q.waitForTimeout(1500);
  ok(sql(`select brand_id from purchases where brand_id is not null`) === alaska, 'purchase saved with purchases.brand_id = Alaska');
  // positive adjustment with brand Laciate
  await L.go(q, 'inventory'); await q.click(`[data-adjust="${milk}"]`); await q.waitForSelector('#a-qty');
  await q.fill('#a-qty', '500'); await q.waitForTimeout(200);
  ok(await q.isVisible('#a-brand'), 'adjustment: Brand shows for stock added');
  await q.selectOption('#a-brand', laciate); await q.click('#btn-save-adj'); await q.waitForTimeout(1500);
  ok(sql(`select brand_id from inventory_transactions where transaction_type='ADJUSTMENT' and quantity>0 order by created_at desc limit 1`) === laciate, 'stock added with brand Laciate');
  await q.click(`[data-adjust="${milk}"]`); await q.waitForSelector('#a-qty'); await q.fill('#a-qty', '-10'); await q.waitForTimeout(200);
  ok(!(await q.isVisible('#a-brand')), 'adjustment: no Brand for stock taken off'); await q.click('#active-modal-overlay [data-cancel]');
  await L.go(q, 'ingredientDetail', milk);
  const card = await q.textContent('#brand-card');
  ok(/In use now:/.test(card) && /oldest stock first/.test(card), 'detail: "In use now: … (oldest stock first)"', card.replace(/\s+/g, ' ').slice(0, 200));
  const stockRows = await q.$$eval('[data-brand-row]', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ')));
  ok(stockRows.some(r => /Alaska.*1000\.00 ml/.test(r)) && stockRows.some(r => /Laciate.*500\.00 ml|Laciate.*490\.00 ml/.test(r)), 'stock per brand shown', stockRows);
  ok(!(await q.$(`[data-brand-del="${alaska}"]`)), 'a used brand has no Delete button');
  await q.click(`[data-brand-toggle="${laciate}"]`); await q.waitForTimeout(1200);
  ok(sql(`select active from ingredient_brands where id='${laciate}'`) === 'f', '"Switch off" turns the brand off');
  await q.screenshot({path: SH + 'ingredient-brands-1280.png', fullPage: true});
  // the server refuses deleting a used brand (BRAND_IN_USE) -> plain message
  const msg = await q.evaluate(async (id) => { try{ await applyChanges([Ops.del('ingredient_brands', id)]); return 'deleted'; }catch(e){ return friendlyError(e); } }, alaska);
  ok(/Switch it off/.test(msg), 'deleting a used brand -> "Switch it off instead"', msg);
  await L.go(q, 'ingredients');
  ok((await q.textContent('#ing-table-wrap')).includes('Alaska') || (await q.textContent('#ing-table-wrap')).includes('Laciate') || (await q.textContent('#ing-table-wrap')).includes('Brand not set'), 'ingredients list shows the brand in use next to the stock');
  // new ingredient with starting stock + brand in ONE call
  await q.evaluate(() => openIngredientForm());
  await q.fill('#f-name', 'Oat milk'); await q.selectOption('#f-unit', 'ml'); await q.fill('#f-initial', '2'); await q.selectOption('#f-initial-unit', 'L'); await q.fill('#f-initial-brand', 'Oatside');
  const c3 = await countApply(q, async () => { await q.click('#btn-save-ing'); });
  ok(c3 === 1 && sql(`select b.name from inventory_transactions t join ingredient_brands b on b.id=t.brand_id where t.transaction_type='INITIAL_STOCK'`) === 'Oatside', 'new ingredient + its brand + starting stock with that brand in ONE call');

  // ---------- 4. loyalty settings ----------
  await L.go(q, 'settings'); await q.click('[data-tab="loyalty"]');
  ok(await q.$('#ly-stamps') === null && (await q.textContent('#content')).includes('One stamp for a drink and one for food, each day (max 2 a day).'), 'loyalty: old "stamps for one reward" gone; the rule in one line');
  await q.click('label:has(#ly-on) .slider-tog');
  await q.fill('#ly-amount-0', '15'); await q.fill('#ly-label-0', '₱15 off');
  await q.fill('#ly-stamp-1', '5'); await q.waitForTimeout(100);
  await q.click('#ly-save'); await q.waitForTimeout(600);
  ok(sql(`select loyalty_rewards->'rewards'->0->>'amount' from settings`) === '10', 'two rewards on stamp 5 -> refused, nothing saved');
  await q.fill('#ly-stamp-1', '10');
  await q.screenshot({path: SH + 'settings-loyalty-1280.png', fullPage: true});
  await q.click('#ly-save'); await q.waitForTimeout(1500);
  ok(sql(`select loyalty_enabled::text || ' ' || (loyalty_rewards->>'card_size') || ' ' || (loyalty_rewards->'rewards'->0->>'amount') || ' ' || (loyalty_rewards->'rewards'->2->>'type') from settings`) === 'true 15 15 FREE_ITEM', 'loyalty on + stamp card saved (stamp 5 = ₱15 off)', sql(`select loyalty_rewards::text from settings`));

  // ---------- 5. theme ----------
  await q.click('[data-tab="branding"]');
  ok(!(await q.isVisible('[data-preset="Forest"]')), 'CCCC theme: colour presets hidden');
  ok(!(await q.$('#set-dark')), 'dark-mode switch removed');
  await q.check('#cz-theme-custom');
  ok(await q.isVisible('[data-preset="Forest"]'), 'Custom colours: presets + pickers show');
  await q.click('[data-preset="Forest"]'); await q.click('#cz-save'); await q.waitForTimeout(1500);
  ok(sql(`select theme || ' ' || secondary_color from settings`) === 'CUSTOM #33513f', 'theme CUSTOM saved with the Forest colours');
  const custVar = await q.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cc-terracotta').trim());
  ok(custVar.toLowerCase() === '#33513f', 'custom colours applied', custVar);
  await q.click('[data-tab="branding"]');
  await q.check('#cz-theme-cccc'); await q.click('#cz-save'); await q.waitForTimeout(1500);
  ok(sql(`select theme from settings`) === 'CCCC' && (await q.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cc-terracotta').trim())).toUpperCase() === '#B5432B', 'back to the CCCC theme (brand colours again)');

  // ---------- 6. customers ----------
  const cust = sql(`insert into customers(business_id, nickname, phone, source) values ('${biz}', 'Mika', '+639171234567', 'QR') returning id`).split('\n')[0];
  for(let d = 1; d <= 6; d++){
    const sid = sql(`insert into sales(business_id, transaction_number, transaction_date, status, customer_id, subtotal, grand_total) values ('${biz}', 'POS-T-${d}', now() - interval '${d} days', 'COMPLETED', '${cust}', 175, 175) returning id`).split('\n')[0];
    sql(`insert into sale_items(business_id, sale_id, recipe_id, name, quantity, unit_price, line_total) values ('${biz}','${sid}','33333333-0000-0000-0000-000000000001','Iced Latte',1,110,110), ('${biz}','${sid}','33333333-0000-0000-0000-000000000004','Ensaymada',1,65,65)`);
    if(d === 6) sql(`insert into loyalty_redemptions(business_id, customer_id, card_no, milestone, reward_type, sale_id, amount) values ('${biz}','${cust}',1,5,'AMOUNT_OFF','${sid}',15)`);
  }
  ok(sql(`select visit_count || '/' || stamps from customers where id='${cust}'`) === '6/12', 'server triggers: 6 visits, 12 stamps', sql(`select visit_count || '/' || stamps from customers where id='${cust}'`));
  await L.go(q, 'customers'); await q.waitForSelector('[data-cust]');
  const crow = (await q.textContent(`[data-cust="${cust}"]`)).replace(/\s+/g, ' ');
  ok(/12 \/ 15/.test(crow) && /₱50 off/.test(crow) && !/₱15 off/.test(crow), 'customers list: stamps on card 12 / 15, ready reward ₱50 off (₱15 off already used)', crow);
  await q.screenshot({path: SH + 'customers-1280.png'});
  await q.click(`[data-cust="${cust}"]`); await q.waitForSelector('.stampcard');
  const modal = (await q.textContent('#active-modal-overlay')).replace(/\s+/g, ' ');
  ok(/Rewards used/.test(modal) && /card 1, stamp 5/.test(modal) && /Used/.test(modal), 'customer: rewards used listed', modal.slice(0, 300));
  await q.screenshot({path: SH + 'customer-detail-1280.png'});
  await q.click('#active-modal-overlay [data-cancel]');

  // ---------- 7. backup includes the new tables ----------
  const backup = await q.evaluate(async () => { const b = await buildCloudBackup(); return {brands: b.data.ingredient_brands.length, shapes: b.data.floor_shapes.length, red: b.data.loyalty_redemptions.length, v: b.version}; });
  const exp = await q.evaluate(async () => { const t0 = Date.now(); const b = await buildCloudBackup(); return {at: b.exported_at, ms: Date.parse(b.exported_at), t0}; });
  ok(typeof exp.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(exp.at) && Math.abs(exp.ms - exp.t0) < 120000, 'a new backup has exported_at (ISO time, now)', exp);
  ok(backup.brands === 3 && backup.shapes === 1 && backup.red === 1 && backup.v === 6, 'backup has brands, floor shapes, rewards used', backup);
  // import the same backup again: nothing new, nothing broken
  const imp = await q.evaluate(async () => { const b = await buildCloudBackup(); const r = await runImport(b, {}); return {imported: r.imported, already: r.already}; });
  ok(imp.imported === 0 && imp.already > 0, 'importing our own backup again: nothing new (safe to run twice)', imp);

  ok(!errors.length && !S2.errors.length, 'no browser errors', errors.concat(S2.errors));
  await S2.browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
