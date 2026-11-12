// Back Office release 1.3 Wave 1 (adopted from back-office-dev's check13.js, 2026-11-02).
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo_release13.e2e.js
const path = require('path');
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {ok, sql, one} = H;
const SH = path.join(H.SHOTS, 'bo13') + '/';
require('fs').mkdirSync(SH, {recursive: true});
const NAME = 'bo13-own';

function seed(){
  const biz = sql(`select id from businesses limit 1`);
  // more recipes: sub-categories in all blocks (+ a production recipe), colours set
  sql(`insert into recipes(id, business_id, name, category, recipe_type, selling_price, active, sort_order) values
    ('3333aaaa-0000-0000-0000-000000000001','${biz}','Spanish Latte','Iced','DRINKS',160,true,2),
    ('3333aaaa-0000-0000-0000-000000000002','${biz}','Cappuccino','Hot','DRINKS',130,true,2),
    ('3333aaaa-0000-0000-0000-000000000003','${biz}','Matcha Latte','Non-coffee','DRINKS',150,true,1),
    ('3333aaaa-0000-0000-0000-000000000004','${biz}','Croissant','Bread','PASTRY',90,true,1),
    ('3333aaaa-0000-0000-0000-000000000005','${biz}','Clubhouse','Sandwiches','FOOD',180,true,1),
    ('3333aaaa-0000-0000-0000-000000000006','${biz}','Caramel sauce','Sauces','SAUCES_SYRUPS',0,true,1)
    on conflict (id) do nothing`);
  sql(`update settings set subcategory_colors = '{"Iced":"terracotta","Hot":"butter","Non-coffee":"sage","Bread":"gold","Sandwiches":"olive"}'::jsonb where business_id='${biz}'`);
  // ingredients for tick-and-remove: free (delete), with a brand (delete + brand), with purchase history, used by active recipe, option extra
  sql(`insert into ingredients(id, business_id, name, base_unit, active) values
    ('2222aaaa-0000-0000-0000-000000000001','${biz}','Old syrup','ml',true),
    ('2222aaaa-0000-0000-0000-000000000002','${biz}','Test cups','pcs',true),
    ('2222aaaa-0000-0000-0000-000000000003','${biz}','Cocoa powder','g',true),
    ('2222aaaa-0000-0000-0000-000000000004','${biz}','Caramel base','g',true),
    ('2222aaaa-0000-0000-0000-000000000005','${biz}','Vanilla syrup','ml',true)
    on conflict (id) do nothing`);
  sql(`insert into ingredient_brands(id, business_id, ingredient_id, name, active, sort_order) values ('2b2b0000-0000-0000-0000-000000000001','${biz}','2222aaaa-0000-0000-0000-000000000002','CupCo',true,1) on conflict do nothing`);
  sql(`insert into purchases(id, business_id, ingredient_id, purchase_date, quantity, total_price) values ('5a5a0000-0000-0000-0000-000000000001','${biz}','2222aaaa-0000-0000-0000-000000000003', current_date, 1000, 500) on conflict do nothing`);
  sql(`insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date) values ('5b5b0000-0000-0000-0000-000000000001','${biz}','2222aaaa-0000-0000-0000-000000000003','PURCHASE',1000,'5a5a0000-0000-0000-0000-000000000001',current_date) on conflict do nothing`);
  sql(`insert into recipe_ingredients(id, business_id, recipe_id, ingredient_id, quantity) values ('4444aaaa-0000-0000-0000-000000000001','${biz}','3333aaaa-0000-0000-0000-000000000006','2222aaaa-0000-0000-0000-000000000004',100) on conflict do nothing`);
  sql(`update recipes set is_production_recipe = true where id='3333aaaa-0000-0000-0000-000000000006'`);
  sql(`update recipes set modifier_groups = '[{"id":"g1","name":"Add-ons","required":false,"multi_select":true,"options":[{"id":"o1","label":"Vanilla","price_delta":20,"ingredient_id":"2222aaaa-0000-0000-0000-000000000005","ingredient_qty_delta":15}]}]'::jsonb where id='3333aaaa-0000-0000-0000-000000000002'`);
  // Start fresh data: an old closed shift with a sale (milk 200), payment, pay-in, a QR order; a kept sale today
  sql(`insert into shifts(id, business_id, status, opened_at, closed_at, cashier_name, shift_number) values ('8888aaaa-0000-0000-0000-000000000001','${biz}','CLOSED', now() - interval '3 days', now() - interval '3 days' + interval '8 hours', 'Cathy Cashier', 'S-OLD') on conflict do nothing`);
  sql(`insert into sales(id, business_id, shift_id, transaction_number, transaction_date, status, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total) values
    ('9999aaaa-0000-0000-0000-000000000001','${biz}','8888aaaa-0000-0000-0000-000000000001','OLD-1', now() - interval '3 days' + interval '1 hour','COMPLETED',150,0,0,0,150),
    ('9999aaaa-0000-0000-0000-000000000002','${biz}',null,'KEEP-1', now() - interval '1 minute','COMPLETED',110,0,0,0,110) on conflict do nothing`);
  sql(`insert into sale_items(id, business_id, sale_id, recipe_id, name, quantity, unit_price, line_total) values
    ('5900aaaa-0000-0000-0000-000000000001','${biz}','9999aaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','Iced Latte',1,150,150),
    ('5900aaaa-0000-0000-0000-000000000002','${biz}','9999aaaa-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000003','Americano',1,110,110) on conflict do nothing`);
  sql(`insert into payments(business_id, sale_id, method, amount) values ('${biz}','9999aaaa-0000-0000-0000-000000000001','CASH',150)`);
  sql(`insert into inventory_transactions(id, business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date) values
    ('cc90aaaa-0000-0000-0000-000000000001','${biz}','22222222-0000-0000-0000-000000000002','SALE_USAGE',200,'9999aaaa-0000-0000-0000-000000000001',current_date - 3) on conflict do nothing`);
  sql(`insert into cash_movements(id, business_id, shift_id, type, amount, at) values ('ca90aaaa-0000-0000-0000-000000000001','${biz}','8888aaaa-0000-0000-0000-000000000001','PAY_IN',100, now() - interval '3 days' + interval '2 hours') on conflict do nothing`);
  sql(`insert into qr_orders(id, business_id, order_number, order_day, status, items, subtotal, total, created_at) values ('a900aaaa-0000-0000-0000-000000000001','${biz}','Q-901', current_date - 3, 'PENDING','[]',150,150, now() - interval '3 days') on conflict do nothing`);
  return biz;
}

(async () => {
  await H.waitClearOfManilaMidnight(10);   // makes sales, then reads Start fresh's "today 00:00" default: one Manila day
  const biz = seed();
  const browser = await chromium.launch();
  const errors = [];
  async function open(vp){
    const ctx = await browser.newContext({viewport: vp, timezoneId: 'Asia/Manila', acceptDownloads: true});
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror ' + e.message));
    page.on('console', m => { if(m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console ' + m.text()); });
    await H.boLogin(page);
    await page.waitForTimeout(600);
    return {ctx, page};
  }
  const go = async (page, r, p) => { await page.evaluate(([r, p]) => navigate(r, p), [r, p == null ? null : p]); await page.waitForTimeout(600); };
  const applyCount = async (page, fn) => { let n = 0; const h = (q) => { if(/\/rpc\/apply_changes/.test(q.url())) n++; }; page.on('request', h); await fn(); await page.waitForTimeout(1500); page.off('request', h); return n; };
  try{
    const {ctx, page} = await open({width: 1280, height: 800});

    /* ---- 3. grouped + coloured recipes ---- */
    await go(page, 'recipes');
    const groups = await page.$$eval('.rec-group', n => n.map(g => g.dataset.group));
    ok(JSON.stringify(groups.slice(0, 3)) === JSON.stringify(['Hot', 'Iced', 'Non-coffee']) && groups.indexOf('Bread') > groups.indexOf('Non-coffee') && groups.indexOf('Sandwiches') > groups.indexOf('Bread') && groups.indexOf('Sauces') === groups.length - 1,
      'recipes grouped: drinks (A-Z) → pastry → food → other', groups);
    const counts = await page.$$eval('.rec-group-count', n => n.map(x => x.textContent));
    ok(counts.every(c => /\d+ recipes?/.test(c)), 'group headings show counts', counts);
    const tinted = await page.$eval('.rec-group[data-group="Iced"] .rec-card-head', n => getComputedStyle(n).backgroundColor);
    ok(tinted === 'rgb(181, 67, 43)', 'Iced cards in terracotta tile colour', tinted);
    await H.shot(page, 'x'); await page.screenshot({path: SH + 'recipes-1280.png', fullPage: true});
    // search + filter still work
    await page.fill('#rec-search', 'latte'); await page.waitForTimeout(300);
    const shown = await page.$$eval('.rec-card b.rec-name', n => n.map(x => x.textContent));
    ok(shown.length === 3 && shown.every(x => /latte/i.test(x)), 'search still filters (grouped)', shown);
    await page.fill('#rec-search', ''); await page.waitForTimeout(300);
    await page.selectOption('#rec-cat-filter', 'Iced'); await page.waitForTimeout(300);
    ok((await page.$$eval('.rec-group', n => n.length)) === 1, 'sub-category filter shows one group');
    await page.selectOption('#rec-cat-filter', ''); await page.waitForTimeout(300);
    // tick a group -> Remove selected (N)
    await page.check('[data-pick-group="Iced"]'); await page.waitForTimeout(200);
    ok(/\(2\)/.test(await page.textContent('#rec-remove-picked')), 'group tick selects its 2 recipes');
    await page.uncheck('[data-pick-group="Iced"]'); await page.waitForTimeout(200);
    await page.check('[data-pick="3333aaaa-0000-0000-0000-000000000005"]');
    const n1 = await applyCount(page, async () => {
      await page.click('#rec-remove-picked');
      await page.waitForSelector('#active-modal-overlay [data-ok]'); await page.click('#active-modal-overlay [data-ok]');
    });
    ok(n1 === 1 && sql(`select count(*) from recipes where id='3333aaaa-0000-0000-0000-000000000005'`) === '0', 'tick-and-remove recipe still works (1 call)', n1);

    /* ---- 2. arrange sub-categories ---- */
    await page.click('#btn-subcat-order'); await page.waitForSelector('.so-block');
    const blocks = await page.$$eval('.so-block', n => n.map(b => b.querySelector('.so-block-head b').textContent));
    ok(JSON.stringify(blocks) === JSON.stringify(['Drinks', 'Pastry', 'Other']) || JSON.stringify(blocks) === JSON.stringify(['Drinks', 'Pastry', 'Food', 'Other']), 'blocks Drinks / Pastry / (Food) / Other', blocks);
    await page.screenshot({path: SH + 'arrange-1280.png'});
    // up button: Non-coffee to the top (2 moves)
    await page.click('[data-so="Non-coffee"] [data-so-up]'); await page.click('[data-so="Non-coffee"] [data-so-up]');
    // drag Iced above Hot
    await page.dragAndDrop('[data-so="Iced"] .so-chip', '[data-so="Hot"] .so-chip', {targetPosition: {x: 5, y: 2}});
    let drinks = await page.$$eval('[data-block-list="0"] [data-so]', n => n.map(x => x.dataset.so));
    ok(JSON.stringify(drinks) === JSON.stringify(['Non-coffee', 'Iced', 'Hot']), 'arrows + drag reorder inside Drinks', drinks);
    // try to drag Bread into the drinks block: refused
    await page.dragAndDrop('[data-so="Bread"] .so-chip', '[data-so="Non-coffee"] .so-chip', {targetPosition: {x: 5, y: 2}});
    drinks = await page.$$eval('[data-block-list="0"] [data-so]', n => n.map(x => x.dataset.so));
    ok(!drinks.includes('Bread'), 'cannot drag across blocks', drinks);
    const prev = await page.$$eval('#so-preview .so-chip', n => n.map(x => x.textContent));
    ok(prev[0] === 'Non-coffee' && prev.indexOf('Bread') > 2, 'preview shows the counter order', prev);
    await page.screenshot({path: SH + 'arrange-moved-1280.png'});
    const n2 = await applyCount(page, () => page.click('#so-save'));
    const saved = sql(`select subcategory_order::text from settings where business_id='${biz}'`);
    ok(n2 === 1 && /^\["Non-coffee", "Iced", "Hot", "Bread"/.test(saved), 'order saved with one apply_changes', saved);
    await page.reload(); await page.waitForSelector('#app', {state: 'visible'}); await page.waitForTimeout(800);
    await go(page, 'recipes');
    const g2 = await page.$$eval('.rec-group', n => n.map(g => g.dataset.group));
    ok(g2[0] === 'Non-coffee' && g2[1] === 'Iced' && g2[2] === 'Hot', 'after reload the Recipes list uses the saved order', g2);

    /* ---- 4. tick-and-remove ingredients ---- */
    await go(page, 'ingredients');
    for(const id of ['1', '2', '3', '4', '5']) await page.check(`[data-ing-pick="2222aaaa-0000-0000-0000-00000000000${id}"]`);
    ok(/\(5\)/.test(await page.textContent('#ing-remove-picked')), 'Remove selected (5)');
    await page.screenshot({path: SH + 'ingredients-1280.png', fullPage: true});
    await page.click('#ing-remove-picked');
    await page.waitForSelector('#active-modal-overlay .ing-rm-used');
    const dlg = await page.textContent('#active-modal-overlay .modal-body');
    ok(/Used in: Caramel sauce \(production recipe\)/.test(dlg) && /Used in: Cappuccino \(option extra\)/.test(dlg), 'used ingredients listed first with where they are used');
    ok(/2 ingredients will be deleted/.test(dlg) && /1 ingredient will be made inactive/.test(dlg) && /has purchases/.test(dlg), 'delete vs inactive split shown', dlg.slice(0, 600));
    await page.screenshot({path: SH + 'ingredients-dialog-1280.png'});
    ok(/Remove 3 ingredients/.test(await page.textContent('#active-modal-overlay [data-ok]')), 'default leaves used ones (Remove 3)');
    await page.check('input[name="ing-rm-used"][value="hide"]');
    ok(/Remove 5 ingredients/.test(await page.textContent('#active-modal-overlay [data-ok]')), 'choosing "inactive anyway" counts them (Remove 5)');
    const n3 = await applyCount(page, () => page.click('#active-modal-overlay [data-ok]'));
    const st = sql(`select string_agg(name || ':' || active, ',' order by name) from ingredients where id::text like '2222aaaa%'`);
    ok(n3 === 1 && st === 'Caramel base:false,Cocoa powder:false,Vanilla syrup:false', 'one call: 2 deleted, 3 made inactive', st);
    ok(sql(`select count(*) from ingredient_brands where id='2b2b0000-0000-0000-0000-000000000001'`) === '0', 'brand of the deleted ingredient removed too');
    ok(sql(`select count(*) from audit_log where action='Ingredients removed'`) === '1', 'one audit entry');

    /* ---- 5. QR printout ---- */
    await go(page, 'tables');
    await page.click('#print-qr'); await page.waitForSelector('[name="pq-per"]');
    await page.screenshot({path: SH + 'qr-picker-1280.png'});
    for(const per of ['4', '2', '1']){
      if(per !== '4'){ await page.click('#print-qr'); await page.waitForSelector('[name="pq-per"]'); }
      await page.check(`input[name="pq-per"][value="${per}"]`);
      const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('#pq-go')]);
      await pop.waitForLoadState(); await pop.waitForTimeout(800);
      const info = await pop.evaluate(() => ({cards: document.querySelectorAll('.card').length, svgs: document.querySelectorAll('.card svg').length,
        sheets: document.querySelectorAll('.sheet').length, wm: [...document.querySelectorAll('img.wm')].every(i => i.complete && i.naturalWidth > 0),
        mark: [...document.querySelectorAll('img.mark')].every(i => i.complete && i.naturalWidth > 0), font: document.fonts.check('20px Brunson'),
        text: document.body.innerText}));
      const urls = await page.evaluate(() => sortedTables().filter(t => t.active).map(t => tableOrderUrl(t)));
      ok(info.cards === 2 && info.svgs === 2 && info.sheets === Math.ceil(2 / Number(per)) && info.wm && info.mark, `QR printout ${per}/page: 2 cards, images loaded`, info);
      // 1.5 (owner decision B12, 2026-11-09): "Bienvenido na Kapihan!" is no longer on the printed table cards
      ok(/Scan to order/i.test(info.text) && !/Bienvenido na Kapihan/i.test(info.text) && /Pay & pick up at the counter/i.test(info.text), 'card texts (1.5: without the dropped tagline)', info.text.slice(0, 300));
      ok(urls.every(u => /\/cccc\/order\/\?t=[0-9a-z]+$/.test(u)) && urls.includes(H.BASE + '/cccc/order/?t=tabletoken5'), 'QR links unchanged', urls);
      await pop.screenshot({path: SH + `qr-print-${per}up.png`, fullPage: true});
      await pop.emulateMedia({media: 'print'}); await pop.screenshot({path: SH + `qr-print-${per}up-print.png`, fullPage: true});
      if(per === '4') await pop.pdf({path: SH + 'qr-print-4up.pdf', format: 'A4', printBackground: true, preferCSSPageSize: true});
      await pop.close();
    }

    /* ---- 1. Start fresh ---- */
    await go(page, 'backup');
    ok(await page.isVisible('#btn-open-fresh'), 'Start fresh card on Backup & import');
    await page.click('#btn-open-fresh'); await page.waitForSelector('.fresh-steps');
    ok(await page.isDisabled('#fresh-check') && await page.isDisabled('#fresh-when'), 'step 2 locked until a backup');
    ok((await page.inputValue('#fresh-when')).endsWith('T00:00'), 'default date today 00:00');
    await page.screenshot({path: SH + 'fresh-locked-1280.png', fullPage: true});
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fresh-backup')]);
    ok(/before-start-fresh/.test(dl.suggestedFilename()), 'backup downloaded', dl.suggestedFilename());
    await page.waitForSelector('#fresh-check:not([disabled])');
    // future date refused on the screen
    const fut = await page.evaluate(() => freshLocalValue(new Date(Date.now() + 86400000)));
    await page.fill('#fresh-when', fut); await page.click('#fresh-check'); await page.waitForTimeout(500);
    ok(/future/.test(await page.textContent('#fresh-date-msg')), 'future date refused');
    await page.fill('#fresh-when', await page.evaluate(() => freshDefaultValue()));
    // open shift: refusal
    sql(`insert into shifts(id, business_id, device_id, status, opened_at, cashier_name, shift_number) select '8888aaaa-0000-0000-0000-0000000000ff','${biz}', null, 'ACTIVE', now() - interval '30 hours', 'Cathy Cashier', 'S-OPEN' on conflict do nothing`);
    await page.click('#fresh-check'); await page.waitForSelector('#fresh-preview .fresh-preview');
    const pv = await page.textContent('#fresh-preview');
    ok(/Sales\s*1Items/.test(pv.replace(/\s+/g, ' ')) && /Espresso|Milk/.test(pv), 'preview counts + stock changes', pv.replace(/\s+/g, ' ').slice(0, 500));
    ok(await page.isVisible('#fresh-open-shifts') && /S-OPEN/.test(await page.textContent('#fresh-open-shifts')) && !(await page.$('#fresh-go')), 'open shift: refused, shows which', await page.textContent('#fresh-confirm'));
    await page.screenshot({path: SH + 'fresh-open-shift-1280.png', fullPage: true});
    sql(`update shifts set status='CLOSED', closed_at=now() where id='8888aaaa-0000-0000-0000-0000000000ff'`);
    await page.click('#fresh-recheck'); await page.waitForSelector('#fresh-type');
    // wrong confirmation
    await page.fill('#fresh-type', 'start fresh');
    ok(await page.isDisabled('#fresh-go'), 'wrong confirmation keeps the button off');
    ok(/exactly/.test(await page.textContent('#fresh-type-msg')), 'wrong-case hint');
    // a server call with the wrong words is refused too
    const err = await page.evaluate(async () => { try{ await cloud.rpc('start_fresh', {p_before: freshParseLocal(freshDefaultValue()).toISOString(), p_confirm: 'start fresh'}); return 'NO ERROR'; }catch(e){ return friendlyError(e); } });
    ok(/Type START FRESH/.test(err), 'server refuses wrong words (plain message)', err);
    await page.fill('#fresh-type', 'START FRESH');
    ok(!(await page.isDisabled('#fresh-go')), 'typed START FRESH enables the button');
    await page.screenshot({path: SH + 'fresh-ready-1280.png', fullPage: true});
    await page.click('#fresh-go'); await page.waitForSelector('#active-modal-overlay [data-ok]');
    await page.click('#active-modal-overlay [data-ok]');
    await page.waitForSelector('.fresh-result', {timeout: 30000});
    ok(sql(`select count(*) from sales where id='9999aaaa-0000-0000-0000-000000000001'`) === '0' && sql(`select count(*) from sales where id='9999aaaa-0000-0000-0000-000000000002'`) === '1', 'old sale removed, today\'s kept');
    ok(sql(`select count(*) from cash_movements where id='ca90aaaa-0000-0000-0000-000000000001'`) === '0' && sql(`select count(*) from qr_orders where id='a900aaaa-0000-0000-0000-000000000001'`) === '0', 'old pay-in + QR order removed');
    ok(/Done/.test(await page.textContent('.fresh-result')), 'result shown');
    await page.screenshot({path: SH + 'fresh-done-1280.png', fullPage: true});

    /* ---- 6 + stale shifts: dashboard ---- */
    sql(`insert into shifts(id, business_id, status, opened_at, cashier_name, shift_number) values ('8888aaaa-0000-0000-0000-0000000000fe','${biz}','ACTIVE', now() - interval '30 hours', 'Manny Manager', 'S-STALE') on conflict do nothing`);
    sql(`insert into sales(id, business_id, transaction_number, transaction_date, status, subtotal, grand_total, needs_review, review_reason) values ('9999aaaa-0000-0000-0000-000000000003','${biz}','LATE-1', now() - interval '2 minutes','COMPLETED',110,110,true,'OUT_OF_STOCK, BEFORE_START_FRESH') on conflict do nothing`);
    await page.reload(); await page.waitForSelector('#app', {state: 'visible'}); await page.waitForTimeout(800);
    await go(page, 'dashboard');
    ok(await page.isVisible('#stale-shifts') && /S-STALE/.test(await page.textContent('#stale-shifts')), 'dashboard warns about a shift open for 24 h+');
    await page.screenshot({path: SH + 'dashboard-stale-1280.png'});
    await go(page, 'transactions'); await page.check('#tx-review'); await page.waitForTimeout(1200);
    const why = await page.textContent('#content');
    ok(/ingredient had run out/.test(why) && /started fresh/.test(why), 'Needs review uses the shared labels for OUT_OF_STOCK + BEFORE_START_FRESH');
    await page.screenshot({path: SH + 'review-1280.png'});

    /* ---- phone size screenshots ---- */
    const m = await open({width: 390, height: 844});
    for(const r of ['recipes', 'ingredients', 'startFresh', 'tables', 'backup', 'dashboard']){
      await go(m.page, r); await m.page.waitForTimeout(400);
      await m.page.screenshot({path: SH + r + '-390.png', fullPage: true});
    }
    await go(m.page, 'recipes'); await m.page.click('#btn-subcat-order'); await m.page.waitForSelector('.so-block');
    await m.page.click('[data-so="Hot"] [data-so-up]');
    await m.page.screenshot({path: SH + 'arrange-390.png'});
    await m.page.keyboard.press('Escape');
    for(const r of ['startFresh', 'tables', 'backup']){ await go(page, r); await page.screenshot({path: SH + r + '-1280.png', fullPage: true}); }
    ok(errors.length === 0, 'no browser errors', errors);
  }catch(e){ H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})();
