// Release 1.6 (013 section 7c, owner 2026-11-13): "Weighs" on BOUGHT items too, Back Office ingredient form.
// Adopted by Z 2026-11-13 from the Back Office work's 3 scratch checks (w4/bo16-weighs.js) + Z: a bought item switched to
// pieces loses its "weighs" (WEIGHS_BAD_UNIT never reaches the owner).
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo16_weighs.e2e.js
const H = require('./lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, ok} = H;
const NAME = 'bo16_weighs.e2e';
const MILK = '22222222-0000-0000-0000-000000000002', SYRUP = '16e00000-0000-0000-0000-000000000001';
const biz = sql(`select business_id from profiles where id = '00000000-0000-0000-0000-0000000000a1'`);
sql(`update ingredients set weight_g_per_ml = null where id = '${MILK}';
     insert into ingredients(id, business_id, name, base_unit, weight_g_per_ml, category_id) values ('${SYRUP}', '${biz}', 'Bought syrup W16', 'ml', 1.3, '11111111-0000-0000-0000-000000000001')`);
(async () => {
  const browser = await chromium.launch(); const page = await (await browser.newContext({viewport: {width: 1300, height: 900}})).newPage();
  const errors = []; H.attach(page, errors, 'BO');
  const open = async (id) => { await page.evaluate((x) => { navigate('ingredients'); setTimeout(() => openIngredientForm(x), 600); }, id); await page.waitForTimeout(1500); };
  try{
    await H.boLogin(page); await page.waitForTimeout(800);
    await open(MILK);
    ok(!!(await page.$('#f-weighs')), 'bought milk (mL): "Weighs" field shown');
    await page.fill('#f-weighs', '1030'); await page.click('#btn-save-ing'); await page.waitForTimeout(1500);
    ok(sql(`select weight_g_per_ml from ingredients where id = '${MILK}'`) === '1.03', 'saved 1 L = 1,030 g');
    ok(sql(`select count(*) from audit_log where action = 'Weighs changed'`) !== '0', 'audited');
    // Z: a bought item switched to pieces: "weighs" cleared, saved without an error
    await open(SYRUP);
    ok(!!(await page.$('#f-weighs')), 'Z: bought syrup (mL, weighs 1.3): field shown');
    await page.selectOption('#f-unit', 'pcs'); await page.waitForTimeout(300);
    await page.click('#btn-save-ing'); await page.waitForTimeout(400);
    if(await page.$('[data-ok]')) await page.click('[data-ok]');
    await page.waitForTimeout(1500);
    const row = H.one(`select base_unit, weight_g_per_ml from ingredients where id = '${SYRUP}'`);
    const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|'));
    ok(row.base_unit === 'pcs' && row.weight_g_per_ml === null && !/house-made|Weighs/.test(toasts), 'Z: switched to pieces -> saved with no "weighs" (no WEIGHS_BAD_UNIT shown)', JSON.stringify(row) + ' ' + toasts);
  }catch(e){ ok(false, 'stopped: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
  ok(errors.length === 0, 'no console errors', errors.slice(0, 5));
  const rc = H.summary(NAME); await browser.close(); process.exit(rc);
})();
