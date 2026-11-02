// Back Office: a window the owner opens while an earlier save is still finishing must stay open.
// (QA 2026-11-02, from the bo.e2e@1280 part 4 flake.) After "Delete supplier" / "Make inactive" the save
// first writes, then reloads everything (bo_bootstrap), then calls closeModal(). The confirm dialog has
// already closed the first window, so during the reload the page is free to use; if the owner opens
// another Edit window in that moment, the late closeModal() closes THAT window ("my click did nothing").
// The reload is slowed to 1.5 s here (a normal mobile connection) so the moment is always hit.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo_modal_race.e2e.js
const H = require('./bo/bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo_modal_race.e2e';
const {sql, ok, must, confirm, go} = H;
const SA = '5e5e5e5e-0000-0000-0000-000000000001', SB = '5e5e5e5e-0000-0000-0000-000000000002';
const IA = '5e5e5e5e-0000-0000-0000-000000000011', IB = '5e5e5e5e-0000-0000-0000-000000000012';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try{
    const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
    sql(`insert into suppliers(id, business_id, name) values ('${SA}', '${biz}', 'QA supplier to delete'), ('${SB}', '${biz}', 'QA supplier to edit') on conflict do nothing`);
    // two ingredients with stock history: Delete -> "Make inactive"
    sql(`insert into ingredients(id, business_id, name, base_unit) values ('${IA}', '${biz}', 'QA ingredient A', 'g'), ('${IB}', '${biz}', 'QA ingredient B', 'g') on conflict do nothing`);
    sql(`insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) values ('${biz}', '${IA}', 'ADJUSTMENT', 5, current_date), ('${biz}', '${IB}', 'ADJUSTMENT', 5, current_date)`);
    const ctx = await H.boContext(browser); const page = await ctx.newPage(); H.attach(page, errors, 'BO');
    await H.boLogin(page);
    let slow = false;
    await page.route(/\/rest\/v1\/rpc\/bo_bootstrap/, async r => { if(slow) await new Promise(x => setTimeout(x, 1500)); r.continue(); });

    // ---- 1. suppliers: delete A, open B while the delete is still reloading
    await go(page, 'suppliers');
    await page.click(`[data-edit="${SA}"]`); await page.click('#s-delete');
    slow = true; await confirm(page);
    await must(() => sql(`select count(*) from suppliers where id='${SA}'`) === '0', 'supplier A deleted');
    await page.click(`[data-edit="${SB}"]`);
    ok(await page.isVisible('#s-delete'), 'suppliers: the Edit window for B opens during the reload');
    await page.waitForTimeout(3000);
    ok(await page.isVisible('#s-delete') && (await page.inputValue('#s-name')) === 'QA supplier to edit', 'suppliers: B\'s Edit window is still open after the delete finished');
    slow = false; await page.evaluate(() => closeModal()); await page.waitForTimeout(300);

    // ---- 2. ingredients: make A inactive, open B while that save is still reloading
    await go(page, 'ingredients');
    await page.click(`[data-edit="${IA}"]`); await page.click('#btn-delete-ing');
    slow = true; await confirm(page);
    await must(() => sql(`select active::text from ingredients where id='${IA}'`) === 'false', 'ingredient A inactive');
    await page.click(`[data-edit="${IB}"]`).catch(() => {});
    const opened = await page.waitForSelector('#btn-delete-ing', {timeout: 1000}).then(() => true).catch(() => false);
    ok(opened, 'ingredients: the Edit window for B opens during the reload');
    await page.waitForTimeout(3000);
    ok(await page.isVisible('#btn-delete-ing'), 'ingredients: B\'s Edit window is still open after "Make inactive" finished');
    slow = false;
    await H.shot(page, 'bo-modal-race-end');
    ok(!errors.length, 'no browser errors', errors);
  }catch(e){ H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})();
