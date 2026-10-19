// Back Office part 5 (after parts 1-4): importing an old-app backup that has refunds (fixtures/old-refunds.json), twice.
// Adopted from the back-office developer's import_refunds.js. Refunds that break only the NEW pro-rated rule come in
// marked imported_at (the money was already handed back); refunds over the hard caps (more than the sale, more stock
// than the sale took) are left out with a plain-words list, and so are their put-back stock lines.
// Every query is limited to this file's records (sales POS-OLD-*, ingredients ing_rbeans / ing_rmilk).
// Run all parts in order with tests/e2e/bo.e2e.js (BO_VIEWPORT=1280x900 or 768x1024).
const H = require('./bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo/part5_import_refunds@' + H.sizeTag();
const {sql, rows, ok, confirm, go} = H;
const FILE = require('path').join(__dirname, 'fixtures', 'old-refunds.json');
const SHOTS = require('path').join(H.SHOTS, 'bo-' + H.sizeTag() + '-');
const MINE = `s.transaction_number like 'POS-OLD-2026-%'`;
const MY_INGS = `(select id from ingredients where local_id in ('ing_rbeans','ing_rmilk'))`;
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await H.boContext(browser);
  const page = await ctx.newPage(); H.attach(page, errors, 'BO');
  await H.boLogin(page);
  const run = async () => {
    await go(page, 'backup');
    await page.setInputFiles('#imp-file', FILE);
    await page.waitForSelector('#imp-go');
    if(await page.$('#imp-settings')) await page.uncheck('#imp-settings');
    await page.click('#imp-go'); await confirm(page);
    await page.waitForSelector('#imp-progress .notice.ok, #imp-progress .text-red', {timeout: 60000});
    return (await page.textContent('#imp-progress')).replace(/\s+/g, ' ');
  };
  try{
    let t = await run();
    console.log('     run 1: ' + t.trim().slice(0, 600));
    await H.shot(page, 'bo-' + H.sizeTag() + '-import-refunds-1', {fullPage: true});
    const refunds = rows(`select s.transaction_number as sale, r.type, r.amount::float8 as amount, r.imported_at is not null as imported
                          from refunds r join sales s on s.id = r.sale_id where ${MINE} order by s.transaction_number`);
    ok(refunds.length === 2 && refunds[0].sale === 'POS-OLD-2026-000001' && refunds[0].amount === 110 && refunds[0].imported
       && refunds[1].sale === 'POS-OLD-2026-000004' && refunds[1].type === 'VOID' && refunds[1].imported,
      'only the refund that breaks just the NEW rule (sale 1, ₱110 where the pro-rated share is ₱107.36) and the void come in, both marked imported_at', refunds);
    ok(/2 old refunds were not brought in/.test(t) && /POS-OLD-2026-000002/.test(t) && /POS-OLD-2026-000003/.test(t) && /₱260\.00 refund/.test(t) && /₱110\.00 refund/.test(t),
      'the summary lists the two left out (sale number, amount, why)', t.slice(0, 600));
    ok(/gave back ₱260\.00, which is more than the whole sale \(₱253\.76\)/.test(t), 'money reason in plain words', t.slice(0, 600));
    ok(/put back 36\.00 g of Old House Beans but the sale only took out 18\.00 g/.test(t), 'stock reason in plain words', t.slice(0, 600));
    ok(/The stock it put back \(2 stock lines\) was left out too/.test(t) && /The stock it put back \(1 stock line\) was left out too/.test(t), 'their put-back stock lines were left out too', t.slice(0, 600));
    const rev = rows(`select s.transaction_number as sale, sum(abs(it.quantity))::float8 as q from inventory_transactions it join refunds r on it.reference_id = r.id::text
                      join sales s on s.id = r.sale_id where it.transaction_type='SALE_REVERSAL' and ${MINE} group by 1 order by 1`);
    ok(rev.length === 2 && rev[0].q === 18 && rev[1].q === 18, 'stock put back only for the two refunds that came in (18 g each), though the put-back lines came first in the file', rev);
    ok(sql(`select count(*) from inventory_transactions where transaction_type='SALE_USAGE' and ingredient_id in ${MY_INGS}`) === '10', 'all 10 sale stock lines imported',
      sql(`select count(*) from inventory_transactions where transaction_type='SALE_USAGE' and ingredient_id in ${MY_INGS}`));
    ok(sql(`select count(*) from sales s where ${MINE}`) === '5', 'all 5 old sales imported (also those whose refund was left out)');
    // beans: 5000 start - 144 sold (sales 1-5: 54 + 36 + 18 + 18 + 18) + 36 put back (refund of sale 1 + the void)
    ok(Number(sql(`select stock from v_ingredient_stock where ingredient_id=(select id from ingredients where local_id='ing_rbeans')`)) === 5000 - 144 + 36,
      'old beans stock adds up: 5000 − 144 sold + 36 put back = 4,892 g', sql(`select stock from v_ingredient_stock where ingredient_id=(select id from ingredients where local_id='ing_rbeans')`));
    const count = () => sql(`select (select count(*) from sales)||'/'||(select count(*) from refunds)||'/'||(select count(*) from inventory_transactions)||'/'||(select count(*) from sale_items)`);
    const before = count();
    t = await run();
    console.log('     run 2: ' + t.trim().slice(0, 300));
    ok(/^\s*Done\. 0 new records added/.test(t) && before === count(), 'second run adds nothing', [before, count(), t.slice(0, 200)]);
    ok(/2 old refunds were not brought in/.test(t), 'second run lists the same two left out');
    await go(page, 'transactions');
  }catch(e){ await H.shot(page, 'bo-' + H.sizeTag() + '-import-refunds-stopped'); await browser.close(); H.abort(NAME, e); }
  ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
