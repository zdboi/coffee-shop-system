// Release 1.6 Back Office (browser): Settings -> Payments & discounts (charge limits, a new method with its own
// code, audit, Senior %), Accounting overview (+ compare), Senior / PWD report (full ID, names as text, CSV that
// can't start a spreadsheet formula: Z), span calendar (two taps, sticky, = overview), Stock counts due box.
// Adopted by Z 2026-11-13 from the Back Office work's scratch checks (w4/bo16-checks.js, 18 checks).
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo16.e2e.js
const H = require('./lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, ok, until, must} = H;
const SH = H.SHOTS + '/bo16-';
require('fs').mkdirSync(SH, {recursive: true});
const biz = sql(`select id from businesses limit 1`);
const owner = sql(`select id from profiles where business_id = '${biz}' and role = 'ADMIN' limit 1`);
// seed: two sales today (one Senior, one GCash with a waived charge) + one yesterday + one void
sql(`update settings set tax_pct = 0, service_charge_pct = 0, senior_discount_pct = 20`);
const mk = (id, day, total, extra, method, status) => sql(`
  insert into sales(id, business_id, transaction_number, transaction_date, status, cashier_name, subtotal, discount_amount, loyalty_discount, tax_amount, service_charge_amount, grand_total,
    senior_kind, senior_items_amount, senior_discount, payment_charge, payment_fee)
  values ('${id}', '${biz}', 'POS-T-${id.slice(-4)}', (current_date - ${day}) + time '10:00' at time zone 'Asia/Manila', '${status || 'COMPLETED'}', 'Cathy', ${extra.sub}, 0, 0, 0, 0, ${total},
    ${extra.kind ? `'${extra.kind}'` : 'null'}, ${extra.a || 0}, ${extra.sd || 0}, ${extra.chg || 0}, ${extra.fee || 0});
  insert into sale_items(id, business_id, sale_id, recipe_id, name, quantity, unit_price, line_total, senior_discount)
    values (gen_random_uuid(), '${biz}', '${id}', '33333333-0000-0000-0000-000000000003', 'Americano', ${extra.q || 1}, 110, ${extra.sub}, ${extra.sd || 0});
  insert into payments(id, business_id, sale_id, method, amount) values (gen_random_uuid(), '${biz}', '${id}', '${method}', ${total});`);
mk('16b00000-0000-0000-0000-000000000001', 0, 88, {sub: 110, kind: 'SENIOR', a: 110, sd: 22}, 'CASH');
sql(`insert into senior_discount_records(business_id, sale_id, kind, holder_name, id_number, pct, items_amount, discount_amount, cashier_name)
     values ('${biz}', '16b00000-0000-0000-0000-000000000001', 'SENIOR', 'Lola <i>R</i>', 'SC-77-0012345', 20, 110, 22, 'Cathy')`);
mk('16b00000-0000-0000-0000-000000000002', 0, 220, {sub: 220, q: 2, fee: 4.4}, 'GCASH');
mk('16b00000-0000-0000-0000-000000000003', 1, 110, {sub: 110}, 'CASH');
mk('16b00000-0000-0000-0000-000000000004', 1, 110, {sub: 110}, 'CASH', 'VOIDED');
sql(`insert into refunds(id, business_id, sale_id, type, amount, date, reason) values (gen_random_uuid(), '${biz}', '16b00000-0000-0000-0000-000000000004', 'VOID', 110, (current_date - 1) + time '11:00' at time zone 'Asia/Manila', 'mistake')`);
mk('16b00000-0000-0000-0000-000000000005', 0, 44, {sub: 55, kind: 'PWD', a: 55, sd: 11}, 'CASH');
sql(`insert into senior_discount_records(business_id, sale_id, kind, holder_name, id_number, pct, items_amount, discount_amount, cashier_name)
     values ('${biz}', '16b00000-0000-0000-0000-000000000005', 'PWD', '=1+2 Juan', '@PWD-1', 20, 55, 11, 'Cathy')`);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1366, height: 900}, timezoneId: 'Asia/Manila'});
  const page = await ctx.newPage(); const errors = []; H.attach(page, errors, 'BO');
  const go = async (r) => { await page.evaluate((x) => navigate(x), r); await page.waitForTimeout(1500); };
  try{
    await H.boLogin(page); await page.waitForTimeout(800);
    // ---- Settings → Payments & discounts
    await page.evaluate(() => { BO_SETTINGS_TAB = 'payments'; navigate('settings'); }); await page.waitForTimeout(800);
    ok(await page.$$eval('.pm-row', r => r.length) === 7, 'payment methods: 7 rows (5 on, Maya + Other off)');
    await page.selectOption('[data-pm-type="1"]', 'PERCENT'); await page.waitForTimeout(150);
    await page.fill('[data-pm-val="1"]', '30');
    await page.click('#pm-save'); await page.waitForTimeout(500);
    ok(/25%/.test(await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|'))), 'a 30% charge is refused with plain words');
    await page.fill('[data-pm-val="1"]', '2');
    await page.click('#pm-add'); await page.waitForTimeout(150);
    await page.fill('.pm-row:last-child .pm-label', 'PayMaya <b>2</b>');
    await page.click('#pm-save'); await page.waitForTimeout(1500);
    const pm = JSON.parse(sql(`select payment_methods::text from settings where business_id = '${biz}'`));
    ok(pm[1].id === 'GCASH' && pm[1].charge_type === 'PERCENT' && pm[1].charge_value === 2 && pm[7] && /^PAYMAYA_B_2/.test(pm[7].id) && pm[7].label === 'PayMaya <b>2</b>', 'saved: GCash 2%, new method with its own code', pm.map(m => m.id + ':' + m.label).join(', '));
    ok(sql(`select count(*) from audit_log where action = 'Payment methods saved'`) === '1', 'audit entry for payment methods');
    await page.screenshot({path: SH + 'payments.png', fullPage: true});
    await page.fill('#sn-pct', '25'); await page.click('#sn-save'); await page.waitForTimeout(1200);
    ok(sql(`select senior_discount_pct from settings where business_id = '${biz}'`) === '25', 'Senior / PWD % saved (25)');
    // ---- Accounting overview (this month)
    await go('netIncome');
    await page.waitForSelector('#ac-table', {timeout: 15000});
    const acc = await page.textContent('#ac-body');
    ok(/Senior \/ PWD discounts/.test(acc) && /Payment fees/.test(acc) && /Of which waived/.test(acc) && /Net income/.test(acc), 'overview shows Senior/PWD, payment fees, waived, net income');
    ok(/1 void/.test(acc) && /Drinks|drinks/.test(acc), 'overview shows voids and drinks');
    ok(await page.$$eval('#ac-body b i, #ac-body i', x => x.length) === 0, 'no HTML from data');
    await page.click('#ac-compare'); await page.waitForTimeout(1500);
    ok(/Before/.test(await page.textContent('#ac-table')), 'compare adds a "Before" column');
    await page.screenshot({path: SH + 'accounting.png', fullPage: true});
    // ---- Senior / PWD report
    await go('seniorReport');
    await page.waitForSelector('#sr-body table', {timeout: 15000});
    const sr = await page.textContent('#sr-body');
    ok(/SC-77-0012345/.test(sr) && /Lola <i>R<\/i>/.test(sr), 'Senior report shows full ID and name as text');
    // Z: the CSV is the owner's own copy of personal data: a name / ID that starts like a formula is made plain text
    const [dl] = await Promise.all([page.waitForEvent('download', {timeout: 10000}), page.click('#sr-csv')]);
    const csvText = require('fs').readFileSync(await dl.path(), 'utf8');
    ok(/"'=1\+2 Juan"/.test(csvText) && /"'@PWD-1"/.test(csvText) && /"SC-77-0012345"/.test(csvText) && /"Lola <i>R<\/i>"/.test(csvText),
       'Z: Senior CSV: full IDs for the owner; a cell starting with = or @ gets a leading quote', csvText.slice(0, 500));
    await page.screenshot({path: SH + 'senior.png', fullPage: true});
    // ---- Sales calendar: tap yesterday then today
    await go('calendar');
    await page.waitForSelector('.cal-split', {timeout: 15000});
    const today = sql(`select (now() at time zone 'Asia/Manila')::date`), yday = sql(`select (now() at time zone 'Asia/Manila')::date - 1`);
    ok(!(await page.textContent('.cal-details')).includes('Average sale'), 'no "Average sale" card');
    await page.click(`[data-pick="${yday}"]`); await page.waitForTimeout(1500);
    ok(/Now tap the end date/.test(await page.textContent('#cal-pick-hint')), 'first tap: asks for the end date');
    await page.click(`[data-pick="${today}"]`); await page.waitForTimeout(1500);
    const det = await page.textContent('.cal-details');
    ok(/₱462\.00/.test(det) && /1 void/.test(det), 'span yesterday..today: sales 462.00 (418 + Z\'s ₱44 PWD sale), 1 void', det.slice(0, 500));
    ok(await page.$$eval('.cal-day.sel', x => x.length) === 2, 'both days marked');
    const pos = await page.evaluate(() => getComputedStyle(document.querySelector('.cal-fixed')).position);
    ok(pos === 'sticky', 'calendar stays on screen (sticky)');
    await page.screenshot({path: SH + 'calendar.png', fullPage: false});
    // ---- the same totals as the overview for that span
    await page.click('#cal-go-acct'); await page.waitForSelector('#ac-table', {timeout: 15000});
    ok(/₱462\.00/.test(await page.textContent('#ac-body')), 'overview for the same span: sales 462.00 too');
    // ---- Stock counts: smart count box
    sql(`update ingredients set count_at_close = true where id = '22222222-0000-0000-0000-000000000001'`);
    await page.evaluate(() => boLoad()); await go('stockCounts');
    await page.waitForSelector('#sc-due table', {timeout: 15000});
    ok(/never counted yet/.test(await page.textContent('#sc-due')), 'stock counts: beans "To count", never counted');
    await page.fill('#sc-recheck', '3'); await page.click('#sc-recheck-save'); await page.waitForTimeout(1500);
    ok(sql(`select count_recheck_days from settings where business_id = '${biz}'`) === '3', 'recheck days saved (3)');
    await page.screenshot({path: SH + 'counts.png', fullPage: true});
  }catch(e){ ok(false, 'stopped: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); await page.screenshot({path: SH + 'abort.png'}); }
  console.log('errors:', errors.slice(0, 8).join('\n'));
  H.summary('bo16.e2e');
  process.exit(H.failures() ? 1 : 0);
  await browser.close();
})();
