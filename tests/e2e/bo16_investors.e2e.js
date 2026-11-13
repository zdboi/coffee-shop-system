// Release 1.6 B2 Back Office (browser): Investors & start-up costs. Adopted by Z 2026-11-13 from the Back Office
// work's 11 scratch checks (w4/bo16-inv.js), with a FAKE sheet (tests/fixtures/paste16_fake.json; never the
// owner's real one) + Z's checks: names / notes with HTML shown as text (table, paste preview, confirm dialog,
// share table), CSV cells that can't start a formula, control characters stripped by the paste reader, an
// amount above the ₱100,000,000 limit refused in plain words with nothing saved, owner-only reads.
// Hand math: investors 50,000 + 30,000 + 40,000 + 40,000 + 40,000 = 200,000 (the "?" line 4 skipped) -> shares 25 / 15 / 20 %;
//            61 start-up costs = 130,967.00 (the TOTAL row left out) -> left 69,033.00.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo16_investors.e2e.js
const H = require('./lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, ok} = H;
const NAME = 'bo16_investors.e2e';
const P = require('../fixtures/paste16_fake.json');
const biz = sql(`select business_id from profiles where id = '00000000-0000-0000-0000-0000000000a1'`);
sql(`delete from investors; delete from startup_costs;`);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1366, height: 900}, timezoneId: 'Asia/Manila', acceptDownloads: true});
  const page = await ctx.newPage(); const errors = []; H.attach(page, errors, 'BO');
  let dialogs = 0; page.on('dialog', d => { dialogs++; d.dismiss().catch(() => {}); });
  const gone = () => H.until(async () => !(await page.$('#active-modal-overlay')), 15000);
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|'));
  try{
    await H.boLogin(page); await page.waitForTimeout(800);
    await page.evaluate(() => navigate('investors')); await page.waitForTimeout(1200);
    await page.click('#inv-paste'); await page.fill('#pr-text', P.inv); await page.waitForTimeout(200);
    ok(/5 investors, ₱200,000\.00/.test(await page.textContent('#pr-preview')) && /Skipped line 4/.test(await page.textContent('#pr-preview')), 'paste investors: 5 read, the "?" row skipped', await page.textContent('#pr-preview'));
    await page.fill('#pr-date', '2026-08-01'); await page.click('#pr-save'); await gone(); await page.waitForTimeout(1200);
    ok(sql(`select count(*) || '|' || sum(amount) from investors`) === '5|200000', 'saved 5 investors = 200,000');
    let t = await page.textContent('#content');
    ok(/Ana Example/.test(t) && /25%/.test(t) && /15%/.test(t) && /20%/.test(t), 'shares shown: 25% / 15% / 20%');
    await page.click('#sc-paste'); await page.fill('#pr-text', P.out); await page.waitForTimeout(200);
    ok(/61 items, ₱130,967\.00/.test(await page.textContent('#pr-preview')), 'paste costs: 61 items = 130,967 (₱ signs, commas, =1000+n and 2-space columns read; TOTAL row left out)', await page.textContent('#pr-preview'));
    await page.click('#pr-save'); await gone(); await page.waitForTimeout(1500);
    ok(sql(`select count(*) || '|' || sum(amount) from startup_costs`) === '61|130967', 'saved 61 costs = 130,967');
    ok(/₱69,033\.00/.test(await page.textContent('#content')), 'left from the investments: 69,033.00');
    const ben = sql(`select id from investors where name = 'Ben Sample'`);
    await page.click(`[data-inv-edit="${ben}"]`); await page.fill('#if-amt', '35000'); await page.click('#if-save'); await gone(); await page.waitForTimeout(1200);
    ok(sql(`select amount from investors where id = '${ben}'`) === '35000' && sql(`select count(*) from audit_log where action = 'Investor changed'`) === '1', 'edit Ben to 35,000 + audit');
    const fe = sql(`select id from investors where name = 'Fe Placeholder'`);
    await page.click(`[data-inv-del="${fe}"]`); await page.click('[data-ok]'); await page.waitForTimeout(1500);
    ok(sql(`select count(*) from investors`) === '4', 'removed Fe');
    await page.click('#inv-add'); await page.fill('#if-name', 'ana example'); await page.fill('#if-amt', '1'); await page.click('#if-save'); await page.waitForTimeout(400);
    ok(/already an investor/.test(await toasts()), 'same name (other case) refused with plain words');
    // ---- Z: a name / note with HTML is shown as text everywhere
    const XSS = '<img src=x onerror=window.__inv_xss=1>Fe <b>2</b>';
    await page.fill('#if-name', XSS); await page.fill('#if-amt', '40000'); await page.fill('#if-note', '<i>note</i> =1+1'); await page.click('#if-save'); await gone(); await page.waitForTimeout(1200);
    ok(sql(`select count(*) || '|' || sum(amount) from investors`) === '5|205000', 'added a fifth investor: 205,000');
    t = await page.textContent('#content');
    ok(t.includes(XSS) && t.includes('<i>note</i>') && await page.$$eval('#content img, #content b b, #content i', x => x.length) === 0 && !(await page.evaluate(() => window.__inv_xss)), 'Z: name and note with HTML shown as text in the table (no image, no script)');
    await page.waitForSelector('#inv-share table', {timeout: 10000});
    ok((await page.textContent('#inv-share')).includes(XSS) && await page.$$eval('#inv-share img', x => x.length) === 0, 'Z: ... and in the share-of-net-income table');
    const xid = sql(`select id from investors where amount = 40000 and name like '<img%'`);
    await page.click(`[data-inv-del="${xid}"]`); await page.waitForSelector('[data-ok]');
    ok((await page.textContent('#active-modal-overlay')).includes(XSS) && await page.$$eval('#active-modal-overlay img', x => x.length) === 0, 'Z: ... and in the "Remove?" dialog');
    await page.click('[data-cancel], #active-modal-overlay .btn-outline').catch(() => {}); await gone();
    // ---- Z: the CSV can't start a spreadsheet formula
    const [dl] = await Promise.all([page.waitForEvent('download', {timeout: 10000}), page.click('#btn-inv-csv')]);
    const csv = require('fs').readFileSync(await dl.path(), 'utf8');
    ok(csv.includes('"\'=1+1') === false && csv.includes('"<i>note</i> =1+1"') && /"Investor","Ana Example","50000\.00","24\.39%"/.test(csv), 'Z: CSV: shares from the amounts (Ana 24.39% of 205,000), notes as text', csv.slice(0, 400));
    // ---- Z: paste reader: control characters out; a formula-looking or huge amount
    await page.click('#sc-paste'); await page.fill('#pr-text', 'Bell\u0007 item\t500\n=HYPERLINK("x")\t=500+1\nToo big\t100000000.01'); await page.waitForTimeout(200);
    const pv = await page.textContent('#pr-preview');
    ok(/3 items/.test(pv) && pv.includes('Bell item') && !pv.includes('\u0007'), 'Z: paste reader strips control characters from names', pv);
    await page.click('#pr-save'); await page.waitForTimeout(1500);
    ok(sql(`select count(*) from startup_costs`) === '61' && !/SERVER_ERROR|startup_costs_amount_check/.test(await toasts()) && (await toasts()).length > 0,
       'Z: a pasted amount above ₱100,000,000 -> nothing saved (all or nothing), a message in plain words', await toasts());
    await page.click('#active-modal-overlay [data-cancel]').catch(() => {}); await gone();
    ok(sql(`select count(*) from startup_costs where name like '=HYPERLINK%'`) === '0', 'Z: ... the formula-looking row was not saved either');
    // monthly net income untouched by start-up costs
    const ex = await page.evaluate(async () => { const r = await cloud.rpc('accounting_report', {p_from: '2026-08-01', p_to: '2026-08-31'}); return r.totals.expenses; });
    ok(Number(ex) === 0, 'start-up costs are not in the accounting report expenses');
    ok(dialogs === 0, 'no browser dialogs (nothing ran from the data)');
    await H.shot(page, 'bo16-investors', {fullPage: true});
    // ---- Z: a counter (DEVICE login) reads none of it through the API
    const dev = await browser.newContext(); const dp = await dev.newPage();
    await H.pairCounter(dp, 'TESTAB');
    const seen = await dp.evaluate(async () => { const a = await cloud.select('investors', {}).catch(e => 'ERR ' + (e.code || e.message)); const b = await cloud.select('startup_costs', {}).catch(e => 'ERR ' + (e.code || e.message)); return [a, b]; });
    ok(seen.every(x => Array.isArray(x) ? x.length === 0 : /^ERR/.test(x)), 'Z: a paired counter reads no investors or start-up costs through the API', seen);
    await dev.close();
  }catch(e){ ok(false, 'stopped: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); await H.shot(page, 'bo16-investors-abort'); }
  // the refusal provoked on purpose above (amount over the limit) is the only error allowed
  const other = errors.filter(e => !/apply_changes|startup_costs_amount_check/.test(e));
  ok(other.length === 0, 'no console errors (apart from the refusal provoked on purpose)', other.slice(0, 6));
  const rc = H.summary(NAME);
  await browser.close();
  process.exit(rc);
})();
