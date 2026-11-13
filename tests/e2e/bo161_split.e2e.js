// Release 1.6.1 (014): profit split on "Investors & start-up" (Back Office). Adopted by Z 2026-11-13 from the Back Office
// work's 5 scratch checks (w4/bo161-split.js), with made-up names, + Z: a manager name with HTML is shown as text (cards,
// table, form) and saved / audited as plain text.
// Hand math: investors 50,000 / 30,000 / 40,000 / 40,000 / 40,000 (Ben 15%, Zed 20%); one ₱1,000 sale today, no costs.
//   Ben = 15% of the investors' 30% + half the managers' 20%; Zed = 20% of 30% + half of 20%; the shop 50%.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo161_split.e2e.js
const H = require('./lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, ok} = H;
const NAME = 'bo161_split.e2e';
const biz = sql(`select business_id from profiles where id = '00000000-0000-0000-0000-0000000000a1'`);
sql(`delete from investors; insert into investors(business_id, name, amount) values
 ('${biz}','Ana Example',50000),('${biz}','Ben',30000),('${biz}','Carla Demo',40000),('${biz}','Dino Test',40000),('${biz}','Zed',40000);
 update settings set tax_pct = 0, service_charge_pct = 0; delete from expenses;`);
sql(`insert into sales(id, business_id, transaction_number, transaction_date, status, cashier_name, subtotal, discount_amount, loyalty_discount, tax_amount, service_charge_amount, grand_total)
  values ('16d00000-0000-0000-0000-000000000001','${biz}','POS-P-0001', now(), 'COMPLETED','Cathy',1000,0,0,0,0,1000)`);
(async () => {
  await H.waitClearOfManilaMidnight(10);
  const browser = await chromium.launch(); const page = await (await browser.newContext({viewport: {width: 1366, height: 900}, timezoneId: 'Asia/Manila'})).newPage();
  const errors = []; H.attach(page, errors, 'BO');
  let dialogs = 0; page.on('dialog', d => { dialogs++; d.dismiss().catch(() => {}); });
  const money = (v) => '₱' + v.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  try{
    await H.boLogin(page); await page.waitForTimeout(800);
    await page.evaluate(() => { INV.share.preset = 'today'; navigate('investors'); }); await page.waitForTimeout(2500);
    const ni = Number(await page.evaluate(async () => (await cloud.rpc('accounting_report', {p_from: shopTodayKey(), p_to: shopTodayKey()})).totals.net_income));
    let t = await page.textContent('#inv-share');
    ok(/Name the managers/.test(t), 'no managers yet: asks to name them');
    await page.click('#ps-edit'); await page.fill('#ps-names', 'Ben\nZed'); await page.fill('#ps-shop', '40'); await page.click('#ps-save'); await page.waitForTimeout(500);
    ok(/must add up to 100/.test(await page.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join('|'))), '90% total refused');
    await page.fill('#ps-shop', '50'); await page.click('#ps-save'); await page.waitForTimeout(2500);
    ok(sql(`select profit_split::text from settings where business_id = '${biz}'`).includes('"managers": ["Ben", "Zed"]'), 'saved: managers Ben + Zed');
    t = await page.textContent('#inv-share');
    const ben = ni * 0.30 * 0.15 + ni * 0.20 / 2, zed = ni * 0.30 * 0.20 + ni * 0.20 / 2;
    ok(ni === 1000 && t.includes(money(ni * 0.5)) && t.includes(money(ben)) && t.includes(money(zed)), `parts: shop ${money(ni * 0.5)}, Ben ${money(ben)}, Zed ${money(zed)} (net income ${ni})`, t.slice(0, 600));
    ok(sql(`select count(*) from audit_log where action = 'Profit split saved'`) === '1', 'audited');
    // Z: a manager name with HTML is text everywhere
    const XSS = '<img src=x onerror=window.__ps_xss=1>Mo <b>B</b>';
    await page.click('#ps-edit'); await page.fill('#ps-names', 'Ben\n' + XSS); await page.click('#ps-save'); await page.waitForTimeout(2500);
    t = await page.textContent('#content');
    ok(t.includes(XSS) && await page.$$eval('#content img, #content b b', x => x.length) === 0 && !(await page.evaluate(() => window.__ps_xss)) && dialogs === 0, 'Z: a manager name with HTML is shown as text in the cards and the table');
    ok(sql(`select profit_split->'managers'->>1 from settings where business_id = '${biz}'`) === XSS && sql(`select details from audit_log where action = 'Profit split saved' order by at desc limit 1`).includes(XSS), 'Z: ... and saved / audited as plain text');
    await page.click('#ps-edit'); await page.waitForSelector('#ps-names');
    ok((await page.inputValue('#ps-names')).includes(XSS) && await page.$$eval('#active-modal-overlay img', x => x.length) === 0, 'Z: ... and in the form');
    await H.shot(page, 'bo161-split', {fullPage: true});
  }catch(e){ ok(false, 'stopped: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
  ok(errors.length === 0, 'no console errors', errors.slice(0, 5));
  const rc = H.summary(NAME); await browser.close(); process.exit(rc);
})();
