// Counter checks for the security fix round of 2026-10-19 (counter 1280 px):
//   1  a manager with an old 4-digit PIN signs in online -> "Your PIN needs updating" note (decision 8);
//      a manager with a 6-digit PIN does not get it
//   2  consent box: "Save customer" without the tick is blocked (no fo_add_customer call);
//      with the tick the call carries p_consent:true and the customer is saved with consent_at
//   3  the shop-wide sign-up limit at the counter (TOO_MANY_SIGNUPS) is shown in plain words
//   4  F2: an online sign-in while an action approved with the manager's own sign-in is still
//      waiting AND the server refuses uploads -> "Signing in now will cancel those approvals";
//      "Upload first" while still refused -> "still couldn't upload", nothing signed in;
//      "Upload first" once the server answers -> uploaded, then signed in; the approval was accepted
//   5  same situation, "Sign in anyway" -> signed in; the waiting approval is refused by the server
//      on upload (the earlier sign-in was ended) and lands in "Uploads that need attention"
// Needs a fresh seed:   tests/e2e_reset.sh [db]  &&  tests/restart_fake.sh [port] [db]
// Run:                  FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_round3.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {BASE, sql, ok, must, until, typePin} = H;
const NAME = 'fo_round3.e2e';
const MANNY = '66666666-0000-0000-0000-000000000002', CATHY = '66666666-0000-0000-0000-000000000001', MAX = '66666666-0000-0000-0000-000000000004';

(async () => {
  // a second manager (Max) who already has a 6-digit PIN
  sql(`insert into staff(id, business_id, name, role) select '${MAX}', business_id, 'Max Manager', 'MANAGER' from staff where id='${CATHY}'`);
  sql(`insert into staff_pins(staff_id, pin_hash, pin_length) values ('${MAX}', extensions.crypt('454545', extensions.gen_salt('bf', 8)), 6)`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila'});
  const page = await ctx.newPage();
  const errors = [], rpc = [];
  const net = H.attach(page, errors, 'FO');
  page.on('request', r => { const u = r.url(); if(u.includes('/rest/v1/rpc/')) rpc.push({name: u.split('/rpc/')[1], body: r.postData() || ''}); });
  ctx.on('page', p => { p.waitForLoadState().then(() => p.close()).catch(() => {}); });   // receipt pop-ups
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
  const outbox = () => page.evaluate(() => LocalDB.outboxCount());
  const pinChoice = () => page.evaluate(() => { const b = document.getElementById('pin-choice'); return b && b.style.display !== 'none' ? b.textContent.replace(/\s+/g, ' ').trim() : ''; });
  // "Refusing server": fo_sync answers HTTP 500 (the counter is online, uploads fail).
  const refuse = (r) => r.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({code: 'XX000', message: 'test: server refuses uploads'})});
  const startRefusing = async () => { net.allow(/\/rpc\/fo_sync$/); await page.route(/\/rest\/v1\/rpc\/fo_sync$/, refuse); };
  const stopRefusing = async () => { await page.unroute(/\/rest\/v1\/rpc\/fo_sync$/, refuse); };
  // a discounted Americano sold by the signed-in manager (approved with their own sign-in, no PIN pad)
  const discountedSale = async (pct) => {
    await page.click('.nav-item[data-route="pos"]').catch(() => {});
    await page.waitForSelector('.pos-product-card');
    await page.click('.pos-product-card:has-text("Americano")');
    await page.click('#add-discount-link');
    await page.waitForSelector('#disc-value', {timeout: 5000});
    await page.fill('#disc-value', String(pct)); await page.click('#disc-apply');
    await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn');
  };

  try{
    // ---- 1. old 4-digit manager PIN -> note; 6-digit manager -> no note
    await H.pairCounter(page, 'TESTAB');
    await typePin(page, '2222');
    await H.startShift(page, 1000);
    ok(await until(async () => /Your PIN needs updating\..*6-digit PIN/.test(await page.textContent('#alert-banner')), 5000), '4-digit manager sees "Your PIN needs updating. Ask the owner to give you a new 6-digit PIN."', await page.textContent('#alert-banner'));
    ok(await page.isVisible('#alert-banner'), 'the PIN note is visible');
    await H.shot(page, 'fo-r3-pin-note');
    await page.click('#alert-ok');
    ok(await until(async () => !(await page.isVisible('#alert-banner')), 3000), '"Got it" closes the note');
    await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'});
    for(const d of '454545') await page.click(`#pin-pad button[data-k="${d}"]`);     // 6 digits sign in by themselves
    await page.waitForSelector('.pos-product-card', {timeout: 15000});
    await page.waitForTimeout(600);
    ok(!/PIN needs updating/.test((await page.textContent('#alert-banner')) || ''), 'manager with a 6-digit PIN: no PIN note', await page.textContent('#alert-banner'));

    // ---- 2. consent box
    await page.click('#cust-add');
    await page.click('.cp-new summary');
    await page.fill('#cp-name', 'Lia'); await page.fill('#cp-phone', '0918 222 3344');
    const nAdd = rpc.filter(c => c.name === 'fo_add_customer').length;
    await page.click('#cp-create');
    ok(await until(async () => /Tick the box once the customer agrees/.test(await toasts()), 4000), 'no tick -> "Tick the box once the customer agrees…"', await toasts());
    ok(rpc.filter(c => c.name === 'fo_add_customer').length === nAdd && sql(`select count(*) from customers where nickname='Lia'`) === '0', 'no tick -> nothing sent, nothing saved');
    await clearToasts();
    await page.check('#cp-consent'); await page.click('#cp-create');
    await must(async () => sql(`select count(*) from customers where nickname='Lia'`) === '1', 'customer saved after the tick', 8000);
    const call = rpc.filter(c => c.name === 'fo_add_customer').pop();
    ok(call && JSON.parse(call.body).p_consent === true, 'fo_add_customer sent with p_consent: true', call && call.body);
    ok(sql(`select (consent_at is not null)||'|'||source||'|'||phone from customers where nickname='Lia'`) === 'true|COUNTER|+639182223344', 'saved with consent_at, source COUNTER, number normalised');
    ok(await until(async () => /Lia/.test((await page.textContent('.customer-chip').catch(() => '')) || ''), 4000), 'the new customer is on the sale');
    await page.click('#cust-remove');

    // ---- 3. shop-wide sign-up limit (40 new customers in the last hour) -> TOO_MANY_SIGNUPS in plain words
    sql(`insert into customers(business_id, nickname, source) select business_id, 'Bulk ' || g, 'QR' from staff, generate_series(1, 40) g where staff.id='${CATHY}'`);
    await page.click('#cust-add');
    await page.click('.cp-new summary');
    await page.fill('#cp-name', 'Nina'); await page.check('#cp-consent'); await page.click('#cp-create');
    ok(await until(async () => /Lots of new customers are joining right now/.test(await toasts()), 5000), 'counter: TOO_MANY_SIGNUPS -> "Lots of new customers are joining right now…"', await toasts());
    ok(sql(`select count(*) from customers where nickname='Nina'`) === '0', 'over the limit: not saved');
    await page.click('[data-cancel]');
    sql(`delete from customers where nickname like 'Bulk %'`);
    await clearToasts();

    // ---- 4. manager-approved sale waiting + refusing server -> warning; "Upload first"
    await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '2222');                                    // Manny again (Max's sign-in ended)
    await page.waitForSelector('.pos-product-card', {timeout: 15000});
    await startRefusing();
    await discountedSale(10);
    await must(async () => (await outbox()) >= 1, 'sale waiting on the counter', 8000);
    ok(sql(`select count(*) from sales where grand_total=99`) === '0', 'server refused the upload: the ₱99 sale is only on the counter');
    const ops4 = await page.evaluate(async () => (await LocalDB.outboxAll()).filter(o => o.type === 'sale').map(o => o.data));
    ok(ops4.length === 1 && ops4[0].discount_approval_token && ops4[0].sale.discount_approved_by === MANNY, 'waiting sale carries Manny\'s own sign-in as the discount approval');
    await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'});
    const pinCalls4 = rpc.filter(c => c.name === 'staff_pin_login').length;
    await typePin(page, '1111');                                    // Cathy wants to sign in
    ok(await until(async () => /Signing in now will cancel those approvals/.test(await pinChoice()), 8000), 'warning shown: "Some approved actions haven\'t uploaded yet. Signing in now will cancel those approvals."', await pinChoice());
    ok(await page.isVisible('#pin-upload-first') && await page.isVisible('#pin-sign-anyway'), '"Upload first" and "Sign in anyway" offered');
    ok(rpc.filter(c => c.name === 'staff_pin_login').length === pinCalls4, 'PIN not sent to the server yet (nobody signed in)');
    await H.shot(page, 'fo-r3-upload-first-choice');
    await page.click('#pin-upload-first');
    ok(await until(async () => /1 approved action still couldn't upload/.test(await pinChoice()), 25000), '"Upload first" while still refused -> "1 approved action still couldn\'t upload. Check the internet and try again."', await pinChoice());
    ok(await page.isVisible('#pin-gate') && rpc.filter(c => c.name === 'staff_pin_login').length === pinCalls4, 'still on the PIN pad, nobody signed in');
    await stopRefusing();
    await page.click('#pin-upload-first');
    await page.waitForSelector('.pos-product-card', {timeout: 25000});
    ok(sql(`select status||'|'||discount_approved_by from sales where grand_total=99`) === `COMPLETED|${MANNY}`, '"Upload first" once the server answers: the sale uploaded with Manny\'s approval accepted');
    ok(await until(async () => /Cathy/.test(await page.textContent('body')), 5000), '... then Cathy is signed in');
    ok((await outbox()) === 0 && (await page.evaluate(async () => (await LocalDB.failedAll()).length)) === 0, 'nothing waiting, nothing failed');

    // ---- 5. same situation, "Sign in anyway"
    await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '2222');
    await page.waitForSelector('.pos-product-card', {timeout: 15000});
    const mannyLogin = sql(`select id from staff_sessions where staff_id='${MANNY}' and purpose='LOGIN' order by created_at desc limit 1`);
    await startRefusing();
    await discountedSale(20);                                       // ₱88
    await must(async () => (await outbox()) >= 1, 'second sale waiting', 8000);
    await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '1111');
    ok(await until(async () => /Signing in now will cancel those approvals/.test(await pinChoice()), 8000), 'warning shown again', await pinChoice());
    await page.click('#pin-sign-anyway');
    await page.waitForSelector('.pos-product-card', {timeout: 20000});
    ok(/Cathy/.test(await page.textContent('body')), '"Sign in anyway" -> Cathy is signed in');
    ok(sql(`select revoked_at is not null from staff_sessions where id='${mannyLogin}'`) === 't', 'the server ended Manny\'s earlier sign-in (F2)');
    await stopRefusing();
    await page.evaluate(() => Sync.run());
    ok(await until(async () => (await outbox()) === 0 && (await page.evaluate(async () => (await LocalDB.failedAll()).length)) === 1, 15000), 'the waiting sale uploads and is refused: it moves to "Uploads that need attention"');
    const failed = await page.evaluate(async () => (await LocalDB.failedAll()).map(f => f.type + ':' + f.error));
    ok(failed.length === 1 && /^sale:/.test(failed[0]) && /APPROVAL/i.test(failed[0]), 'refused because the approval is no longer valid', failed);
    ok(sql(`select count(*) from sales where grand_total=88`) === '0', 'the ₱88 sale with the cancelled approval is not on the server');
    ok(sql(`select count(*) from audit_log where details like '%signed in before 1 approved action(s) uploaded%'`) === '1', 'the sign-in is logged as "signed in before 1 approved action(s) uploaded"', sql(`select string_agg(details, ' / ') from audit_log where action='User login'`));

    // the only provoked errors: the HTTP 500s and the "sync failed" console lines while refusing / the refused toast
    const unexpected = errors.filter(e => !/console: sync failed/.test(e));
    ok(unexpected.length === 0, 'no other browser errors', unexpected.join(' | '));
  }catch(e){ await H.shot(page, 'fo-r3-stopped'); await browser.close(); H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
