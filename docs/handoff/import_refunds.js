// Scratch: importing an old-app backup that has refunds (hard caps), twice.
process.env.FAKE_PORT = process.env.FAKE_PORT || '8791'; process.env.FAKE_DB = process.env.FAKE_DB || 'db_bo';
const H = require('/home/claude/coffee-shop-system/tests/e2e/lib/h');
const B = require('/home/claude/coffee-shop-system/tests/e2e/bo/bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const {sql, one, rows, ok} = H;
const SHOTS = '/tmp/claude-0/-home-claude-coffee-shop-system/87e71ae2-6bc5-5944-baf1-422d60cc0268/scratchpad/shots';
const FILE = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await B.boContext(browser);
  const page = await ctx.newPage(); H.attach(page, errors, 'BO');
  await H.boLogin(page);
  const run = async () => {
    await B.go(page, 'backup');
    await page.setInputFiles('#imp-file', FILE);
    await page.waitForSelector('#imp-go');
    if(await page.$('#imp-settings')) await page.uncheck('#imp-settings');
    await page.click('#imp-go'); await B.confirm(page);
    await page.waitForSelector('#imp-progress .notice.ok, #imp-progress .text-red', {timeout: 60000});
    return page.textContent('#imp-progress');
  };
  let t = await run();
  console.log('     RUN 1:', t.replace(/\s+/g, ' ').trim());
  await (await page.$('#imp-progress')).screenshot({path: SHOTS + '/import-summary.png'});
  const refunds = rows(`select s.transaction_number as sale, r.type, r.amount::float8 as amount, r.imported_at is not null as imported from refunds r join sales s on s.id = r.sale_id order by s.transaction_number`);
  console.log('     refunds in the shop:', JSON.stringify(refunds));
  ok(refunds.length === 2 && refunds[0].sale === 'POS-OLD-2026-000001' && refunds[0].amount === 110 && refunds[0].imported && refunds[1].sale === 'POS-OLD-2026-000004' && refunds[1].type === 'VOID' && refunds[1].imported,
    'only the refund that breaks just the NEW rule (sale 1, ₱110 where the pro-rated max is ₱107.36) and the void come in, both marked imported_at', refunds);
  ok(/2 old refunds were not brought in/.test(t) && /POS-OLD-2026-000002/.test(t) && /POS-OLD-2026-000003/.test(t) && /₱260\.00 refund/.test(t) && /₱110\.00 refund/.test(t), 'the summary lists the two left out (sale number, amount, why)', t.slice(0, 400));
  ok(/gave back ₱260\.00, which is more than the whole sale \(₱253\.76\)/.test(t), 'money reason in plain words');
  ok(/put back 36\.00 g of Old House Beans but the sale only took out 18\.00 g/.test(t), 'stock reason in plain words');
  ok(/The stock it put back \(2 stock lines\) was left out too/.test(t) && /The stock it put back \(1 stock line\) was left out too/.test(t), 'their put-back stock lines were left out too');
  const rev = rows(`select s.transaction_number as sale, sum(abs(it.quantity))::float8 as q from inventory_transactions it join refunds r on it.reference_id = r.id::text join sales s on s.id = r.sale_id where it.transaction_type='SALE_REVERSAL' group by 1 order by 1`);
  ok(rev.length === 2 && rev[0].q === 18 && rev[1].q === 18, 'stock put back only for the two refunds that came in (18 g each) - even though the put-back lines came first in the file', rev);
  ok(Number(sql(`select count(*) from inventory_transactions where transaction_type='SALE_USAGE'`)) === Number(10), 'all 10 sale stock lines imported', sql(`select count(*) from inventory_transactions where transaction_type='SALE_USAGE'`));
  ok(Number(sql(`select count(*) from sales where transaction_number like 'POS-OLD%'`)) === 5, 'all 5 old sales imported (even those whose refund was left out)');
  const before = sql(`select (select count(*) from sales)||'/'||(select count(*) from refunds)||'/'||(select count(*) from inventory_transactions)||'/'||(select count(*) from sale_items)`);
  t = await run();
  console.log('     RUN 2:', t.replace(/\s+/g, ' ').trim());
  const after = sql(`select (select count(*) from sales)||'/'||(select count(*) from refunds)||'/'||(select count(*) from inventory_transactions)||'/'||(select count(*) from sale_items)`);
  ok(/^\s*Done\. 0 new records added/.test(t) && before === after, 'second run adds nothing', [before, after]);
  ok(/2 old refunds were not brought in/.test(t), 'second run lists the same two left out');
  await (await page.$('#imp-progress')).screenshot({path: SHOTS + '/import-summary-2.png'});
  // the shop's stock still adds up: beans 5000 - usage (18+36+18+18+18+18+18+18 = 162 ... ) + put back 36
  const beans = Number(sql(`select stock from v_ingredient_stock where ingredient_id=(select id from ingredients where local_id='ing_beans')`));
  console.log('     beans stock now:', beans);
  await B.go(page, 'transactions');
  ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  await browser.close();
  process.exit(H.summary('import_refunds'));
})().catch(e => H.abort('import_refunds', e));
