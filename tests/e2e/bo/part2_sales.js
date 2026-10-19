// Back Office part 2 (after part 1, same database): counter sales -> dashboard / calendar day, week and
// shift view agree with the counter; owner partial refund (from an open drawer) and void put the exact
// stock back incl. option extras; expected cash agrees with the counter; needs-review, reprint, QR order
// history, customers (phone clash, merge, delete on request, CSV), settings, reports, audit log.
// Run all parts in order with tests/e2e/bo.e2e.js (BO_VIEWPORT=1280x900 or 768x1024).
const H = require('./bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo/part2_sales@' + H.sizeTag();
const {sql, rows, one, ok, must: until, confirm, toastText, clearToasts, go, modalGone} = H;
const BASE = H.BASE, SHOTS = require('path').join(H.SHOTS, 'bo-' + H.sizeTag() + '-');
const money = (t) => Number(String(t).replace(/[^0-9.\-]/g, ''));
async function typePin(p, pin){ for(const d of pin) await p.click(`#pin-pad button[data-k="${d}"]`); await p.click('#pin-enter'); }
async function statValue(p, label){ return p.$$eval('.stat-card', (cards, label) => { const c = cards.find(x => x.querySelector('.label').textContent.trim().toLowerCase() === label.toLowerCase()); return c ? c.querySelector('.value').textContent : null; }, label); }
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  // ---------- the counter: pair (TESTAB), PIN 1111, shift, two cash sales ----------
  const fctx = await H.counterContext(browser);
  const fo = await fctx.newPage(); H.attach(fo, errors, 'FO');
  fctx.on('page', p => { p.waitForLoadState().then(() => p.close()).catch(() => {}); });   // receipt pop-ups
  await fo.goto(BASE + '/cccc/front/');
  await fo.waitForSelector('#su-code'); await fo.fill('#su-code', 'TESTAB'); await fo.click('#su-pair');
  await fo.waitForSelector('#pin-gate', {state: 'visible', timeout: 20000});
  await typePin(fo, '1111');
  await fo.waitForSelector('#ss-opening-cash'); await fo.fill('#ss-opening-cash', '2000'); await fo.click('#ss-start-btn');
  await fo.waitForSelector('.pos-product-card');
  await fo.click('.pos-product-card:has-text("Iced Latte")'); await fo.click('.mod-opt:has-text("16oz")'); await fo.click('#mod-add');
  await fo.click('.pos-product-card:has-text("Ensaymada")');
  await fo.click('#checkout-btn'); await fo.click('[data-quick]'); await fo.click('#complete-sale-btn');
  await until(() => sql(`select count(*) from sales where status='COMPLETED'`) === '1', 'sale 1 uploaded', 20000);
  await fo.click('.pos-product-card:has-text("Caramel Macchiato")'); await fo.click('.mod-opt:has-text("16oz")'); await fo.click('.mod-opt:has-text("Extra shot")'); await fo.click('#mod-add');
  await fo.click('#checkout-btn'); await fo.click('[data-quick]'); await fo.click('#complete-sale-btn');
  await until(() => sql(`select count(*) from sales where status='COMPLETED'`) === '2', 'sale 2 uploaded', 20000);
  ok(sql(`select string_agg(grand_total::text, ',' order by transaction_number) from sales`) === '235,210', 'counter sales on the server: ₱235 (Iced Latte 16oz + Ensaymada) and ₱210 (Caramel Macchiato 16oz + extra shot)');
  await fo.click('.nav-item[data-route="sales"]'); await fo.click('[data-view="today"]');
  await fo.waitForSelector('.stat-card');
  const foToday = money(await statValue(fo, 'Total'));
  const foCount = Number(await statValue(fo, 'Transactions'));

  // ---------- Back Office ----------
  const ctx = await H.boContext(browser);
  const page = await ctx.newPage(); H.attach(page, errors, 'BO');
  await page.goto(BASE + '/cccc/back/');
  await page.waitForSelector('#li-email'); await H.focusSettled(page, 'li-email');
  await page.fill('#li-email', 'owner@example.com'); await page.fill('#li-pass', 'secret123'); await page.click('#f-login button[type=submit]');
  await page.waitForSelector('#app', {state: 'visible', timeout: 20000});
  await page.waitForFunction(() => !/…/.test(document.querySelector('#dash-today .stat-card .value').textContent));
  ok(money(await statValue(page, 'Net sales today')) === foToday && foToday === 445, `dashboard "Net sales today" ₱445 = counter's "Today · all counters" total (${foToday})`);

  // calendar: day view for today
  await go(page, 'calendar');
  await page.click('[data-view="day"]');
  await page.waitForSelector('.cal-kpis');
  const calNet = money(await statValue(page, 'Net sales')), calCount = Number(await statValue(page, 'Transactions'));
  ok(calNet === foToday && calCount === foCount && calCount === 2, `calendar day: net ₱${calNet}, ${calCount} transactions — same as the counter`);
  ok(await page.$('.cal-svg .cal-bar'), 'hourly bar chart drawn');
  ok((await page.textContent('.cal-matrix')).includes('Caramel Macchiato'), 'items-by-hour table lists the items sold');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cal-export')]);
  const csv = require('fs').readFileSync(await dl.path(), 'utf8');
  ok(csv.split('\n')[0].startsWith('"Item"') && csv.includes('Ensaymada'), 'calendar CSV export (items by hour)');
  await page.hover('.cal-hit[data-tip]:not([data-tip=""])').catch(() => {});
  await page.screenshot({path: SHOTS + 'f-calendar-day.png', fullPage: true});
  await page.click('[data-view="month"]'); await page.waitForSelector('.cal-month');
  await page.screenshot({path: SHOTS + 'f-calendar-month.png', fullPage: true});
  await page.click('[data-view="week"]'); await page.waitForSelector('.cal-kpis');
  ok(money(await statValue(page, 'Net sales')) === 445, 'calendar week shows the same ₱445');
  await page.screenshot({path: SHOTS + 'f-calendar-week.png', fullPage: true});
  await page.click('[data-view="shift"]'); await page.waitForSelector('#cal-shift-pick');
  ok(money(await statValue(page, 'Expected cash')) === 2445, 'shift view: expected cash ₱2,445 (2,000 + 445 cash), same maths as the counter');
  await page.screenshot({path: SHOTS + 'f-calendar-shift.png', fullPage: true});

  // transactions: refund one line of sale 1 from the drawer, void sale 2
  const s1 = one(`select id, transaction_number from sales where grand_total=235`), s2 = one(`select id, transaction_number from sales where grand_total=210`);
  const shiftId = sql(`select id from shifts where status='ACTIVE' limit 1`);
  const stock = (id) => Number(sql(`select stock from v_ingredient_stock where ingredient_id='${id}'`));
  const beans = '22222222-0000-0000-0000-000000000001', milk = '22222222-0000-0000-0000-000000000002';
  const sauceIng = sql(`select produced_ingredient_id from recipes where name='Caramel Sauce'`);
  const before = {beans: stock(beans), milk: stock(milk), sauce: stock(sauceIng)};
  await go(page, 'transactions');
  await page.waitForSelector(`tr[data-sale="${s1.id}"]`);
  await page.screenshot({path: SHOTS + 'f-transactions.png'});
  await page.click(`tr[data-sale="${s1.id}"]`);
  await page.waitForSelector('#sm-refund');
  await page.screenshot({path: SHOTS + 'f-sale-detail.png'});
  await page.click('#sm-refund');
  await page.waitForSelector('[data-item] .rv-qty');
  const latteRow = `[data-item]:has-text("Iced Latte") .rv-qty`;
  await page.fill(latteRow, '1'); await page.dispatchEvent(latteRow, 'input');
  ok(Number(await page.inputValue('#rv-amount')) === 170, 'refund amount worked out from the line: ₱170');
  await page.fill('#rv-reason', 'Wrong milk');
  await page.selectOption('#rv-shift', shiftId);
  await page.click('#rv-confirm'); await modalGone(page);
  const rf = one(`select id, type, amount, shift_id, approved_by_name from refunds where sale_id='${s1.id}'`);
  ok(rf && rf.type === 'PARTIAL_REFUND' && Number(rf.amount) === 170 && rf.shift_id === shiftId && rf.approved_by_name === 'Zed', 'partial refund saved (₱170, from the open shift drawer, approved by the owner)');
  ok(sql(`select status from sales where id='${s1.id}'`) === 'PARTIALLY_REFUNDED', 'sale marked partly refunded');
  ok(stock(beans) === before.beans + 18 && stock(milk) === before.milk + 240, 'refund put back 18 g beans and 240 ml milk (180 + 16oz option 60)');
  await page.waitForSelector(`tr[data-sale="${s2.id}"]`);
  await page.click(`tr[data-sale="${s2.id}"]`);
  await page.waitForSelector('#sm-void'); await page.click('#sm-void');
  await page.fill('#rv-reason', 'Rang up twice');
  await page.click('#rv-confirm'); await modalGone(page);
  ok(sql(`select status from sales where id='${s2.id}'`) === 'VOIDED', 'sale 2 voided');
  ok(stock(beans) === before.beans + 18 + 36 && stock(milk) === before.milk + 240 + 240 && stock(sauceIng) === before.sauce + 30, 'void put back beans 18+18 (extra shot), milk 180+60, sauce 30');
  // the counter sees the same expected cash after it reloads
  await fo.reload();
  await fo.waitForSelector('#app', {state: 'visible', timeout: 20000}).catch(async () => { await typePin(fo, '1111'); await fo.waitForSelector('#app', {state: 'visible'}); });
  await fo.click('.nav-item[data-route="shift"]'); await fo.waitForSelector('.drawer-card .drow.total');
  const foExpected = money(await fo.textContent('.drawer-card .drow.total'));
  await go(page, 'calendar'); await page.click('[data-view="shift"]'); await page.waitForSelector('#cal-shift-pick');
  const boExpected = money(await statValue(page, 'Expected cash'));
  ok(boExpected === foExpected && boExpected === 2065, `expected cash after refund + void: Back Office ₱${boExpected} = counter ₱${foExpected} (2,000 + 235 − 170)`);
  await go(page, 'calendar'); await page.click('[data-view="day"]'); await page.waitForSelector('.cal-kpis');
  ok(money(await statValue(page, 'Net sales')) === 65, 'calendar day after refund + void: ₱235 − ₱170 refund = ₱65 (voided sale left out)');
  await go(page, 'dashboard');
  await page.waitForFunction(() => !/…/.test(document.querySelector('#dash-today .stat-card .value').textContent));
  ok(money(await statValue(page, 'Net sales today')) === 65, 'dashboard "Net sales today" agrees after the refund + void (₱65)');

  // needs review
  sql(`update sales set needs_review = true, review_reason = 'PRICE_BELOW_MENU' where id='${s1.id}'`);
  await go(page, 'transactions');
  await page.check('#tx-review');
  await page.waitForSelector(`tr[data-sale="${s1.id}"] .review-flag`);
  await page.click(`tr[data-sale="${s1.id}"]`);
  await page.waitForSelector('#sm-reviewed');
  ok((await page.textContent('#active-modal-overlay')).includes('Sold below the menu price'), 'review reason shown in plain words');
  await page.screenshot({path: SHOTS + 'f-needs-review.png'});
  await page.click('#sm-reviewed'); await modalGone(page);
  ok(sql(`select needs_review::text || '/' || review_reason from sales where id='${s1.id}'`) === 'false/PRICE_BELOW_MENU', 'marked reviewed (reason kept as history)');
  await page.uncheck('#tx-review');
  // reprint (wait until the list has reloaded after the untick, so the click lands on the new row)
  await page.waitForFunction(() => { const w = document.getElementById('tx-wrap'); return w && !w.classList.contains('dim'); });
  await page.waitForTimeout(500);
  await page.waitForSelector(`[data-reprint="${s1.id}"]`);
  const [rp] = await Promise.all([ctx.waitForEvent('page'), page.click(`[data-reprint="${s1.id}"]`)]);
  await rp.waitForLoadState();
  ok((await rp.content()).includes(s1.transaction_number) && (await rp.content()).includes('PARTIALLY REFUNDED'), 'receipt reprint opens with the sale');
  await rp.close();

  // QR orders history
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  sql(`insert into customers(id, business_id, nickname, phone, source) values ('aaaaaaaa-0000-0000-0000-000000000001','${biz}','Ana','+639171234567','QR'),('aaaaaaaa-0000-0000-0000-000000000002','${biz}','Ana B',null,'COUNTER')`);
  sql(`insert into qr_orders(business_id, order_number, order_day, table_label, status, items, subtotal, total, customer_id, customer_nickname) values ('${biz}','Q-001',current_date,'Table 5','COMPLETED','[{"name":"Iced Latte","quantity":1,"unit_price":150,"line_total":150,"modifiers":[{"label":"12oz"}]}]',150,150,'aaaaaaaa-0000-0000-0000-000000000002','Ana B')`);
  await go(page, 'qrOrders');
  await page.waitForSelector('[data-order]');
  await page.click('[data-order]'); await page.waitForSelector('#active-modal-overlay');
  ok((await page.textContent('#active-modal-overlay')).includes('Iced Latte'), 'QR order history + detail');
  await page.click('#active-modal-overlay [data-close]');
  await page.screenshot({path: SHOTS + 'f-qr-orders.png'});

  // customers: edit, phone clash, merge, delete on request
  await go(page, 'customers');
  await page.waitForSelector('[data-cust]');
  await page.screenshot({path: SHOTS + 'f-customers.png'});
  await page.click('[data-cust="aaaaaaaa-0000-0000-0000-000000000002"]'); await page.waitForSelector('#cu-phone');
  await page.fill('#cu-phone', '0917 123 4567'); await page.click('#cu-save');
  ok((await toastText(page, 'error')).includes('already has that number'), 'a mobile number already used by another customer is refused');
  await clearToasts(page);
  await page.fill('#cu-phone', '0918 555 0000'); await page.fill('#cu-nick', 'Ana Bee'); await page.click('#cu-save'); await modalGone(page);
  ok(sql(`select nickname || ' ' || phone from customers where id='aaaaaaaa-0000-0000-0000-000000000002'`) === 'Ana Bee +639185550000', 'customer edited; 0918 555 0000 stored as +639185550000');
  await page.waitForSelector('[data-cust="aaaaaaaa-0000-0000-0000-000000000001"]');
  await page.click('[data-cust="aaaaaaaa-0000-0000-0000-000000000001"]'); await page.waitForSelector('#cu-merge');
  await page.selectOption('#cu-merge', 'aaaaaaaa-0000-0000-0000-000000000002'); await page.click('#cu-merge-btn'); await confirm(page);
  await until(() => sql(`select merged_into from customers where id='aaaaaaaa-0000-0000-0000-000000000002'`) === 'aaaaaaaa-0000-0000-0000-000000000001', 'merged');
  ok(sql(`select customer_id from qr_orders where order_number='Q-001'`) === 'aaaaaaaa-0000-0000-0000-000000000001', 'merge moved the QR order to the kept customer');
  await page.waitForTimeout(800);
  await page.click('[data-cust="aaaaaaaa-0000-0000-0000-000000000001"]'); await page.waitForSelector('#cu-delete');
  await page.click('#cu-delete'); await confirm(page);
  await until(() => sql(`select count(*) from customers`) === '0', 'customer deleted');
  ok(sql(`select coalesce(customer_nickname,'(none)') || '/' || coalesce(customer_id::text,'(none)') from qr_orders where order_number='Q-001'`) === '(none)/(none)', 'delete on request also removed the name from their QR orders');
  const [cdl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('#cust-csv'); await confirm(page); })()]);
  ok(require('fs').readFileSync(await cdl.path(), 'utf8').startsWith('"Nickname","Mobile"'), 'customer CSV download (after a privacy reminder)');

  // settings: shop name -> businesses, QR ordering, tax
  await go(page, 'settings');
  await page.click('[data-tab="branding"]');
  await page.fill('#cz-business', 'CCCC Test Shop');
  await page.click('[data-preset="Forest"]');
  await page.click('#cz-save'); await page.waitForTimeout(1500);
  ok(sql(`select name from businesses where id='${biz}'`) === 'CCCC Test Shop' && sql(`select business_name || ' ' || secondary_color from settings where business_id='${biz}'`) === 'CCCC Test Shop #33513f', 'shop name saved in settings AND businesses; colours saved');
  await page.screenshot({path: SHOTS + 'f-settings-branding.png', fullPage: true});
  await page.click('[data-tab="qr"]');
  await page.click('label:has(#qr-on) .slider-tog');
  await page.fill('#qr-welcome', 'Mabuhay! Order here.');
  await page.click('#qr-save'); await page.waitForTimeout(1200);
  ok(sql(`select qr_ordering_enabled::text || '|' || qr_welcome_message from settings where business_id='${biz}'`) === 'false|Mabuhay! Order here.', 'QR ordering switched off + welcome message saved');
  await page.click('label:has(#qr-on) .slider-tog'); await page.click('#qr-save'); await page.waitForTimeout(1200);
  ok(sql(`select qr_ordering_enabled from settings where business_id='${biz}'`) === 't', 'QR ordering back on');
  await page.click('[data-tab="receipt"]');
  await page.fill('#set-tax', '12'); await page.click('#save-receipt'); await page.waitForTimeout(1200);
  ok(sql(`select tax_pct from settings where business_id='${biz}'`) === '12', 'tax % saved');
  const [sr] = await Promise.all([ctx.waitForEvent('page'), page.click('#preview-receipt')]);
  await sr.waitForLoadState(); ok((await sr.content()).includes('Tax'), 'sample receipt shows tax'); await sr.close();
  await page.fill('#set-tax', '0'); await page.click('#save-receipt'); await page.waitForTimeout(1000);
  await page.click('[data-tab="loyalty"]');
  await page.click('label:has(#ly-on) .slider-tog'); await page.fill('#ly-stamps', '8'); await page.click('#ly-save'); await page.waitForTimeout(1000);
  ok(sql(`select loyalty_enabled::text || '/' || stamps_per_reward from settings where business_id='${biz}'`) === 'true/8', 'loyalty on, 8 stamps per reward');

  // reports
  await go(page, 'reports');
  for(const id of ['priceChanges','inventoryValue','recipeCosting','salesByDay','salesByItem','salesByCategory','salesByHour','payments','cashiers','shifts','refunds','discounts']){
    await page.click(`[data-report="${id}"]`);
    await page.waitForFunction(() => !document.querySelector('#report-body .loading-line') && !document.querySelector('#report-body.dim'));
  }
  await page.click('[data-report="salesByItem"]'); await page.selectOption('#rep-preset', 'today');
  await page.waitForSelector('#report-body table');
  ok((await page.textContent('#report-body')).includes('Iced Latte'), 'sales by item report for today');
  await page.screenshot({path: SHOTS + 'f-report-sales-item.png', fullPage: true});
  await page.click('[data-report="shifts"]'); await page.waitForSelector('#report-body table');
  ok((await page.textContent('#report-body')).includes('₱2,065.00'), 'shifts report expected cash ₱2,065 (open shift, live)');
  const [pr] = await Promise.all([ctx.waitForEvent('page'), page.click('#print-report')]);
  await pr.waitForLoadState(); ok((await pr.content()).includes('Shifts &amp; cash report'), 'printable report'); await pr.close();

  await go(page, 'auditLog'); await page.waitForSelector('#au-wrap table');
  ok((await page.textContent('#au-wrap')).includes('Refund'), 'audit log lists the refund');
  await page.screenshot({path: SHOTS + 'f-audit.png'});
  ok(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
