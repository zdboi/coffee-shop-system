// Release 1.5 (B17) Back Office: edit / delete entries in the Waste report (adopted by Z 2026-11-12 from C's scratch
// b17-bo.e2e.js): "Record waste" row, counter-style and R&D entries; "Why?" required; Edited mark; stock follows.
// Needs a fresh seed:  tests/e2e_reset.sh db_bo && tests/restart_fake.sh 8791 db_bo
//   FAKE_PORT=8791 FAKE_DB=db_bo QA_SHOTS=<dir> node tests/e2e/bo_waste_edit15.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {ok, sql} = H;
const SH = require('path').join(process.env.B17_SHOTS || H.SHOTS, 'bo_waste_edit15') + '/';
require('fs').mkdirSync(SH, {recursive: true});
const BEANS = '22222222-0000-0000-0000-000000000001', MILK = '22222222-0000-0000-0000-000000000002';
const PROJ = 'b17b0000-0000-0000-0000-0000000000a1', RLOG = 'b17b0000-0000-0000-0000-0000000000a2';
const stock = (id) => Number(sql(`select coalesce((select stock from v_ingredient_stock where ingredient_id='${id}'),0)`));
(async () => {
  const biz = sql(`select id from businesses limit 1`);
  const browser = await chromium.launch(); const errors = [];
  const ctx = await browser.newContext({viewport: {width: 1280, height: 900}, timezoneId: 'Asia/Manila'});
  const page = await ctx.newPage(); H.attach(page, errors, 'BO');
  const gone = () => H.until(async () => !(await page.$('#active-modal-overlay')), 15000);
  const report = async () => { await page.evaluate(() => navigate('wasteReport')); await page.waitForTimeout(1200); };
  try{
    await H.boLogin(page); await page.waitForTimeout(800);
    const b0 = stock(BEANS), m0 = stock(MILK);
    /* ---- 1. old-style Back Office waste: record 100 g beans ---- */
    await page.evaluate(() => navigate('inventory')); await page.waitForTimeout(800);
    await page.click('#btn-new-waste'); await page.waitForTimeout(400);
    await page.selectOption('#w-ing', BEANS); await page.fill('#w-qty', '100'); await page.fill('#w-notes', 'old <b>bag</b>');
    await page.click('#btn-save-waste'); await gone();
    ok(stock(BEANS) === b0 - 100, 'record waste: 100 g beans off stock');
    await report();
    await page.screenshot({path: SH + '1-report.png', fullPage: true});
    ok(await page.$$eval('[data-wr-edit]', e => e.length) >= 1 && await page.$$eval('[data-wr-del]', e => e.length) >= 1, 'report rows have Edit and Delete');
    /* ---- 2. edit needs a reason; then 100 g -> 0.25 kg ---- */
    await page.click('[data-wr-edit]'); await page.waitForTimeout(400);
    await page.screenshot({path: SH + '2-edit.png'});
    await page.fill('[data-we-q="0"]', '0.25'); await page.selectOption('[data-we-unit="0"]', 'kg');
    await page.click('#we-save'); await page.waitForTimeout(400);
    ok(!!(await page.$('#active-modal-overlay')) && stock(BEANS) === b0 - 100, 'edit without "why" is refused, nothing changes');
    await page.fill('#we-why', 'Wrong amount <script>');
    await page.click('#we-save'); await gone(); await page.waitForTimeout(900);
    ok(stock(BEANS) === b0 - 250, 'edit to 0.25 kg: stock is now 250 g off (was 100)');
    ok(sql(`select count(*) from audit_log where business_id='${biz}' and details::text like '%Wrong amount%'`) !== '0', 'edit is in the audit log with the reason');
    ok((await page.textContent('.wr-entries')).includes('Edited') && (await page.textContent('.wr-entries')).includes('Wrong amount <script>'), 'row shows "Edited" and the reason as plain text');
    ok(await page.$$eval('.wr-entries script', e => e.length) === 0, 'no script injected by the reason');
    ok(/250\s*g/.test(await page.textContent('.wr-entries')), 'row shows 250 g after the edit');
    await page.screenshot({path: SH + '3-edited.png', fullPage: true});
    /* ---- 3. R&D entry: edit amount, stays R&D ---- */
    await page.evaluate(async ([P, L, M]) => {
      await cloud.rpc('apply_changes', {p_ops: [{op: 'upsert', table: 'rnd_projects', row: {id: P, name: 'Ube latte', status: 'ACTIVE'}}]});
      await cloud.rpc('log_rnd_usage', {p: {id: L, project_id: P, note: 'trial', items: [{ingredient_id: M, quantity: 300, unit: 'ml'}]}});
    }, [PROJ, RLOG, MILK]);
    ok(stock(MILK) === m0 - 300, 'R&D usage: 300 ml milk off');
    await report();
    await page.click(`[data-wr-edit="${RLOG}"]`); await page.waitForTimeout(500);
    ok(!(await page.$('#we-reason')) && !!(await page.$('#we-project')), 'R&D edit: reason fixed, project selectable');
    await page.fill('[data-we-q="0"]', '200'); await page.fill('#we-why', 'Measured again');
    await page.click('#we-save'); await gone(); await page.waitForTimeout(900);
    ok(stock(MILK) === m0 - 200, 'R&D edit to 200 ml: stock follows');
    ok(sql(`select reason from waste_logs where id='${RLOG}'`) === 'RND', 'still R&D');
    /* ---- 4. delete (needs a reason) puts stock back ---- */
    await page.click(`[data-wr-del="${RLOG}"]`); await page.waitForTimeout(400);
    await page.screenshot({path: SH + '4-delete.png'});
    await page.click('#wd-ok'); await page.waitForTimeout(400);
    ok(!!(await page.$('#active-modal-overlay')) && stock(MILK) === m0 - 200, 'delete without "why" is refused');
    await page.fill('#wd-why', 'Logged twice'); await page.click('#wd-ok'); await gone(); await page.waitForTimeout(900);
    ok(stock(MILK) === m0 && sql(`select count(*) from waste_logs where id='${RLOG}'`) === '0', 'delete: entry gone, milk back');
    ok(!(await page.$(`[data-wr-edit="${RLOG}"]`)), 'deleted row left the report');
    /* ---- 5. date can't be in the future (input max) ---- */
    await page.click('[data-wr-edit]'); await page.waitForTimeout(400);
    ok((await page.getAttribute('#we-date', 'max')) === sql(`select (now() at time zone 'Asia/Manila')::date`), 'date picker stops at today (shop day)');
    await page.click('[data-cancel]'); await gone();
    /* ---- 6. phone width: no sideways scroll ---- */
    await page.setViewportSize({width: 390, height: 800}); await report();
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways page scroll at 390 px');
    await page.screenshot({path: SH + '5-phone.png', fullPage: true});
  }catch(e){ ok(false, 'script error: ' + e.message.split('\n')[0]); }
  ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors[0] : ''));
  await browser.close(); process.exit(H.summary('bo_waste_edit15'));
})();
