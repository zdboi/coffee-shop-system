// Back Office checks for the security fix round of 2026-10-19 (Back Office 1280 px + one counter):
//   1  PIN banner: managers/admins with a PIN shorter than 6 digits (or not yet known) are listed (#pin-update-banner),
//      with the wording "can still sell … but can't approve refunds, voids or discounts";
//      "Set new PIN" refuses 4 digits on the screen, the server answers PIN_TOO_SHORT in plain words,
//      a 6-digit PIN is saved and that person leaves the banner
//   2  promoting a cashier to manager asks for a 6-digit PIN (#sf-pin-block); nothing changes without one
//   3  lockout alert: 5 wrong PINs on a counter -> #pin-lockout-alert; "Unlock PIN pad" -> unlocked,
//      still shown as unlocked after a reload, and the counter accepts PINs again
//   4  review reasons in plain words (TAX_MISMATCH / PAYMENT_MISMATCH / STAFF_MISMATCH) + "Mark as reviewed"
//   5  large pay-out (over ₱1,000 by default) flagged by the server -> #tx-payouts -> "Mark as reviewed";
//      flagged refund -> #tx-flagged-refunds -> "Mark as reviewed"
//   6  pay-out limit setting (#set-payout-limit) saved and used by the server for the next pay-outs
//   7  "Net sales today" on the dashboard
//   8  full customer delete across a merge chain (C merged into B merged into A): every record deleted,
//      QR orders and sales unlinked, nicknames scrubbed from order notes and audit entries
// Needs a fresh seed:   tests/e2e_reset.sh [db]  &&  tests/restart_fake.sh [port] [db]
// Run:                  FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo_round3.e2e.js
const H = require('./bo/bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const {BASE, sql, ok, must, until, typePin, confirm, toastText, clearToasts, go, modalGone, statValue} = H;
const NAME = 'bo_round3.e2e';
const MANNY = '66666666-0000-0000-0000-000000000002', CATHY = '66666666-0000-0000-0000-000000000001', MAX = '66666666-0000-0000-0000-000000000004';
const OWNER_STAFF = () => sql(`select id from staff where profile_id='00000000-0000-0000-0000-0000000000a1'`);

(async () => {
  // a manager who still has an old 4-digit PIN (Manny has 222222 in the seed)
  sql(`insert into staff(id, business_id, name, role) select '${MAX}', business_id, 'Max Manager', 'MANAGER' from staff where id='${CATHY}'`);
  sql(`insert into staff_pins(staff_id, pin_hash) values ('${MAX}', extensions.crypt('4545', extensions.gen_salt('bf', 8)))`);
  const browser = await chromium.launch();
  const errors = [];
  // ---- counter
  const cctx = await H.counterContext(browser);
  const fo = await cctx.newPage(); const fnet = H.attach(fo, errors, 'FO');
  cctx.on('page', p => { if(p !== fo) p.waitForLoadState().then(() => p.close()).catch(() => {}); });
  // ---- Back Office
  const bctx = await H.boContext(browser);
  const bo = await bctx.newPage(); const bnet = H.attach(bo, errors, 'BO');
  const banner = async (sel) => (await bo.$(sel)) ? (await bo.textContent(sel)).replace(/\s+/g, ' ').trim() : '';
  const payout = async (amount, reason) => {
    await fo.click('.nav-item[data-route="shift"]');
    await fo.click('#cash-mgmt-btn');
    await fo.click('[data-mode="PAY_OUT"]');
    await fo.fill('#cm-amount', String(amount)); await fo.fill('#cm-reason', reason);
    await fo.click('#cm-save');
    await must(() => sql(`select count(*) from cash_movements where reason='${reason}'`) === '1', 'pay-out ' + reason + ' uploaded', 15000);
  };
  const reviewList = async () => {
    await go(bo, 'transactions');
    await bo.waitForSelector('#tx-review');
    if(!(await bo.isChecked('#tx-review'))) await bo.check('#tx-review');
    await bo.waitForFunction(() => !document.querySelector('#tx-wrap .loading-line') && !document.querySelector('#tx-wrap.dim'));
    await bo.waitForTimeout(300);
  };

  try{
    // ======== counter: a sale, two pay-outs, a refund, then 5 wrong PINs
    await H.pairCounter(fo, 'TESTAB');
    await typePin(fo, '1111');
    await H.startShift(fo, 1000);
    await fo.click('.pos-product-card:has-text("Americano")');
    await fo.click('#checkout-btn'); await fo.click('[data-quick]'); await fo.click('#complete-sale-btn');
    await must(() => sql(`select count(*) from sales where status='COMPLETED'`) === '1', 'counter sale uploaded', 15000);
    await fo.click('.pos-product-card:has-text("Ensaymada")');
    await fo.click('#checkout-btn'); await fo.click('[data-quick]'); await fo.click('#complete-sale-btn');
    await must(() => sql(`select count(*) from sales where status='COMPLETED'`) === '2', 'second counter sale uploaded', 15000);
    ok(sql(`select count(*) from sales where needs_review or review_reason is not null`) === '0', 'normal counter sales (cashier signed in online) are not flagged', sql(`select string_agg(review_reason, ' / ') from sales`));
    await payout(1500, 'New blender');
    await payout(200, 'Ice');
    ok(sql(`select string_agg(reason || '=' || needs_review, ',' order by amount) from cash_movements`) === 'Ice=false,New blender=true', 'server flags only the pay-out above ₱1,000 (default limit)', sql(`select string_agg(reason || '=' || needs_review, ',') from cash_movements`));
    // refund the Ensaymada with Manny's approval (normal flow: not flagged)
    await fo.click('.nav-item[data-route="sales"]');
    await fo.click('tr[data-id]:has-text("₱65.00")');
    await fo.click('#refund-btn');
    await fo.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(fo, '222222');
    await fo.waitForSelector('.rv-qty');
    await fo.fill('.rv-qty', '1'); await fo.fill('#rv-reason', 'cold');
    await fo.click('#rv-confirm');
    await must(() => sql(`select count(*) from refunds`) === '1', 'refund uploaded', 15000);
    ok(sql(`select needs_review||'|'||coalesce(review_reason,'') from refunds`) === 'false|', 'normal refund (done by the signed-in cashier, manager PIN) is not flagged', sql(`select needs_review||'|'||coalesce(review_reason,'') from refunds`));
    // 5 wrong PINs -> counter locked
    await fo.click('#lock-btn'); await fo.waitForSelector('#pin-gate', {state: 'visible'});
    for(let i = 0; i < 5; i++){ await typePin(fo, '0000'); await until(async () => !/Checking/.test(await fo.textContent('#pin-error')), 5000); }
    ok(/Too many wrong PINs/.test(await fo.textContent('#pin-error')), 'counter locked after 5 wrong PINs', await fo.textContent('#pin-error'));
    ok(sql(`select count(*) from pin_lock_events where locked_until > now()`) === '1', 'server recorded the lock');

    // what the server flagged, made into review cases for the screens:
    //   the Americano sale -> TAX_MISMATCH + PAYMENT_MISMATCH + STAFF_MISMATCH; the refund -> STAFF_MISMATCH
    sql(`update sales set needs_review = true, review_reason = 'TAX_MISMATCH, PAYMENT_MISMATCH, STAFF_MISMATCH', signed_in_staff_id = '${MANNY}' where grand_total = 110`);
    sql(`update refunds set needs_review = true, review_reason = 'STAFF_MISMATCH', signed_in_staff_id = '${MANNY}'`);
    const sale110 = sql(`select id from sales where grand_total = 110`);
    const refundId = sql(`select id from refunds`);

    // ======== Back Office
    await H.boLogin(bo);
    await bo.waitForFunction(() => document.querySelector('#dash-today .stat-card .value') && !/…/.test(document.querySelector('#dash-today .stat-card .value').textContent), null, {timeout: 15000});

    // ---- 7. "Net sales today" = 110 + 65 - 65 refunded = 110
    ok(H.money(await statValue(bo, 'Net sales today')) === 110, 'dashboard "Net sales today" ₱110 (₱175 sales − ₱65 refund)', await statValue(bo, 'Net sales today'));
    ok((await statValue(bo, 'Sales today')) === null, 'the old "Sales today" label is gone');

    // ---- 1. PIN banner on the dashboard: Max (old 4-digit PIN 4545) and the owner (seed PIN never used, length unknown)
    const b1 = await banner('#pin-update-banner');
    ok(/2 people need a new 6-digit PIN/.test(b1) && /Max Manager/.test(b1) && !/Cathy/.test(b1), 'PIN banner: 2 people need a new 6-digit PIN (Max + owner), not the cashier', b1);
    ok(/can still sell at the counter but can't approve refunds, voids or discounts/.test(b1), 'banner says they can still sell but can\'t approve', b1);
    ok(await bo.$(`#pin-update-banner [data-newpin="${MAX}"]`) && await bo.$(`#pin-update-banner [data-newpin="${OWNER_STAFF()}"]`), 'banner has "Set new PIN" for each');
    await H.shot(bo, 'bo-r3-pin-banner');
    await bo.click(`#pin-update-banner [data-newpin="${MAX}"]`);
    await bo.waitForSelector('#sp-pin');
    ok(/exactly 6 digits/.test(await bo.textContent('#active-modal-overlay')), 'set-PIN window says managers need exactly 6 digits');
    await H.focusSettled(bo, 'sp-pin');      // the window moves focus to the first box shortly after opening
    await bo.fill('#sp-pin', '2468'); await bo.fill('#sp-pin2', '2468'); await bo.click('#sp-save');
    const t4 = await toastText(bo, 'error').catch(() => '');
    ok(/Managers and admins need a PIN of exactly 6 digits/.test(t4), '4 digits refused on the screen', t4);
    await clearToasts(bo);
    ok(sql(`select extensions.crypt('4545', pin_hash) = pin_hash from staff_pins where staff_id='${MAX}'`) === 't', 'old PIN unchanged');
    // the server's own answer (as an older screen / another tab would get it)
    const srv = await bo.evaluate(async (id) => { const r = await cloud.rpc('staff_set_pin', {p_staff_id: id, p_pin: '2468'}); return {r, text: friendlyError(r)}; }, MAX);
    ok(srv.r && srv.r.error === 'PIN_TOO_SHORT' && srv.text === 'Managers and the owner need a 6-digit PIN.', 'server: PIN_TOO_SHORT -> "Managers and the owner need a 6-digit PIN."', srv);
    // a server refusal reaching the window is shown in plain words (simulated: the screen already blocks short PINs)
    const tooShort = (r) => r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({error: 'PIN_TOO_SHORT'})});
    await bo.route(/\/rest\/v1\/rpc\/staff_set_pin$/, tooShort);
    await bo.fill('#sp-pin', '246813'); await bo.fill('#sp-pin2', '246813'); await bo.click('#sp-save');
    ok(/Managers and the owner need a 6-digit PIN/.test(await toastText(bo, 'error')), 'PIN_TOO_SHORT from the server shown in plain words in the window');
    await bo.unroute(/\/rest\/v1\/rpc\/staff_set_pin$/, tooShort);
    await clearToasts(bo);
    await bo.click('#sp-save');
    await modalGone(bo);
    ok(sql(`select pin_length from staff_pins where staff_id='${MAX}'`) === '6', 'Max\'s new 6-digit PIN saved (pin_length 6)');
    ok(await until(async () => { const t = await banner('#pin-update-banner'); return /One person needs/.test(t) && !/Max/.test(t); }, 5000), 'banner now lists only the owner', await banner('#pin-update-banner'));
    await go(bo, 'staff');
    const staffRow = await bo.textContent(`tr:has([data-pin="${MAX}"])`);
    ok(/Set/.test(staffRow) && !/Needs a new 6-digit PIN/.test(staffRow), 'Staff list: Max\'s PIN shows as set', staffRow);
    ok(/Needs a new 6-digit PIN/.test(await bo.textContent(`tr:has([data-pin="${OWNER_STAFF()}"])`)), 'Staff list: owner still "Needs a new 6-digit PIN"');

    // ---- 2. promoting a cashier asks for a 6-digit PIN
    await bo.click(`[data-edit="${CATHY}"]`);
    await bo.waitForSelector('#sf-role');
    ok(!(await bo.isVisible('#sf-pin-block')), 'editing a cashier: no PIN boxes');
    await bo.selectOption('#sf-role', 'MANAGER');
    ok(await bo.isVisible('#sf-pin-block') && /New PIN \(6 digits\)/.test(await bo.textContent('#sf-pin-label')), 'role -> Manager: PIN boxes appear, "New PIN (6 digits)"', await bo.textContent('#sf-pin-label'));
    await bo.click('#sf-save');
    ok(/Set a 6-digit PIN for Cathy Cashier/.test(await toastText(bo, 'error')), 'saving without a PIN is refused');
    await clearToasts(bo);
    await bo.fill('#sf-pin', '1357'); await bo.fill('#sf-pin2', '1357'); await bo.click('#sf-save');
    ok(/exactly 6 digits/.test(await toastText(bo, 'error')), '4-digit PIN for a new manager refused');
    await clearToasts(bo);
    ok(sql(`select role from staff where id='${CATHY}'`) === 'CASHIER', 'nothing saved yet: still a cashier');
    await bo.selectOption('#sf-role', 'CASHIER');
    ok(!(await bo.isVisible('#sf-pin-block')), 'back to Cashier: PIN boxes hidden again');
    await bo.selectOption('#sf-role', 'MANAGER');
    await bo.fill('#sf-pin', '135790'); await bo.fill('#sf-pin2', '135790'); await bo.click('#sf-save');
    await modalGone(bo);
    ok(sql(`select s.role||'|'||p.pin_length from staff s join staff_pins p on p.staff_id=s.id where s.id='${CATHY}'`) === 'MANAGER|6', 'Cathy promoted to Manager with a 6-digit PIN');
    ok(!/Cathy/.test(await banner('#pin-update-banner')), 'the promoted manager is not in the PIN banner');

    // ---- 3. lockout alert + unlock, still unlocked after a reload
    await go(bo, 'dashboard');
    await bo.waitForSelector('#pin-lockout-alert');
    const la = await banner('#pin-lockout-alert');
    ok(/A counter was locked after wrong PINs/.test(la) && /Front Counter/.test(la) && /still locked until/.test(la), 'dashboard lockout alert: Front Counter, still locked until …', la);
    await H.shot(bo, 'bo-r3-lockout');
    await clearToasts(bo);
    await bo.click('#pin-lockout-alert [data-lock-unlock]');
    ok(await until(async () => /Unlocked — 5 wrong PINs forgotten/.test(await toastText(bo).catch(() => '')), 5000), 'Unlock -> "Unlocked — 5 wrong PINs forgotten"', await toastText(bo).catch(() => ''));
    ok(await until(async () => /unlocked since/.test(await banner('#pin-lockout-alert')), 5000), 'alert now says "unlocked since"', await banner('#pin-lockout-alert'));
    ok(sql(`select count(*) from pin_lock_events where locked_until > now()`) === '0', 'server: lock ended');
    await bo.reload(); await bo.waitForSelector('#app', {state: 'visible', timeout: 20000});
    await bo.waitForSelector('#pin-lockout-alert');
    const la2 = await banner('#pin-lockout-alert');
    ok(/unlocked since/.test(la2) && !/still locked/.test(la2), 'after a reload: still shown as unlocked', la2);
    await typePin(fo, '246813');                       // Max's new PIN on the counter
    await fo.waitForSelector('.pos-product-card', {timeout: 15000});
    ok(true, 'the counter accepts PINs again (Max signs in with his new 6-digit PIN)');
    ok(!/PIN needs updating/.test((await fo.textContent('#alert-banner')) || ''), 'no "PIN needs updating" note for the new 6-digit PIN');
    await clearToasts(bo);

    // ---- 4 + 5. review list: sale reasons in plain words, pay-out, refund
    await reviewList();
    const why = await bo.textContent('#tx-wrap');
    ok(why.includes("Tax or service charge doesn't match your settings; Payments don't add up to the total; Recorded cashier differs from who was signed in"), 'sale review reasons in plain words', why.slice(0, 400));
    ok(!/TAX_MISMATCH|PAYMENT_MISMATCH|STAFF_MISMATCH/.test(why), 'no raw codes on the screen');
    ok(/signed in: Manny Manager/.test(why), 'shows who was signed in at the counter');
    const pay = await bo.textContent('#tx-payouts');
    ok(/New blender/.test(pay) && /1,500\.00/.test(pay) && !/Ice/.test(pay), 'pay-outs to review: only the ₱1,500 "New blender"', pay);
    const ref = await bo.textContent('#tx-flagged-refunds');
    ok(/Recorded cashier differs from who was signed in/.test(ref) && /65\.00/.test(ref) && /signed in: Manny Manager/.test(ref), 'refunds to review: ₱65, reason in plain words, signed-in person shown', ref);
    await H.shot(bo, 'bo-r3-review');
    // sale window: reason + hint, then mark reviewed
    await bo.click(`tr[data-sale="${sale110}"]`);
    await bo.waitForSelector('#sm-reviewed');
    const notice = await bo.textContent('#active-modal-overlay .notice.warn');
    ok(/To check: compare the tax and service charge with Settings → Receipts & tax; compare the payments with the total; check who was signed in at the counter/.test(notice), 'sale window explains what to check for each reason', notice);
    await bo.click('#sm-reviewed'); await modalGone(bo);
    ok(await until(() => sql(`select needs_review from sales where id='${sale110}'`) === 'f', 8000), 'sale marked as reviewed');
    await bo.click('#tx-payouts [data-payout-reviewed]');
    ok(await until(() => sql(`select needs_review from cash_movements where reason='New blender'`) === 'f', 8000), 'pay-out "Mark as reviewed" saved');
    ok(await until(async () => !(await bo.$('#tx-payouts')), 5000), 'pay-out list gone');
    await bo.click('#tx-flagged-refunds [data-refund-reviewed]');
    ok(await until(() => sql(`select needs_review from refunds where id='${refundId}'`) === 'f', 8000), 'refund "Mark as reviewed" saved');
    ok(await until(async () => /Nothing needs review/.test(await bo.textContent('#tx-wrap')), 5000), 'review list empty: "Nothing needs review"', await bo.textContent('#tx-wrap'));
    ok(sql(`select string_agg(action, ',' order by action) from audit_log where action in ('Sale reviewed','Pay-out reviewed','Refund reviewed')`) === 'Pay-out reviewed,Refund reviewed,Sale reviewed', 'each review written to the audit log');

    // ---- 6. pay-out limit setting
    await go(bo, 'settings');
    if(await bo.$('[data-tab="general"]')) await bo.click('[data-tab="general"]');
    await bo.waitForSelector('#set-payout-limit');
    ok(H.money(await bo.inputValue('#set-payout-limit')) === 1000 && !(await bo.isDisabled('#set-payout-limit')), 'pay-out limit shows ₱1,000 (default)');
    await bo.fill('#set-payout-limit', ''); await bo.click('#save-general');
    ok(/Enter the pay-out amount to review/.test(await toastText(bo, 'error')), 'empty limit refused');
    await clearToasts(bo);
    await bo.fill('#set-payout-limit', '2000'); await bo.click('#save-general');
    ok(await until(() => sql(`select payout_review_limit from settings`) === '2000', 8000), 'limit saved: ₱2,000');
    await payout(1500, 'Repairs');
    await payout(2500, 'Supplier cash');
    ok(sql(`select string_agg(reason || '=' || needs_review, ',' order by amount) from cash_movements where reason in ('Repairs','Supplier cash')`) === 'Repairs=false,Supplier cash=true', 'with ₱2,000: ₱1,500 not flagged, ₱2,500 flagged');

    // ---- 8. full customer delete across a merge chain
    const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
    const A = 'cccccccc-0000-0000-0000-00000000000a', B = 'cccccccc-0000-0000-0000-00000000000b', C = 'cccccccc-0000-0000-0000-00000000000c', D = 'cccccccc-0000-0000-0000-00000000000d';
    sql(`insert into customers(id, business_id, nickname, phone, source) values ('${A}', '${biz}', 'Rosalind', '+639171110000', 'QR'), ('${B}', '${biz}', 'Roz', null, 'QR'), ('${C}', '${biz}', 'Rozzy', null, 'COUNTER'), ('${D}', '${biz}', 'Other Person', '+639172220000', 'QR')`);
    sql(`update customers set merged_into='${A}' where id='${B}'; update customers set merged_into='${B}' where id='${C}'`);
    sql(`insert into qr_orders(business_id, order_number, order_day, table_label, customer_id, customer_nickname, status, customer_note, items, total)
         values ('${biz}', 'Q-701', current_date, 'Table 5', '${C}', 'Rozzy', 'COMPLETED', 'for Rozzy, no sugar', '[{"name":"Americano","quantity":1,"notes":"Roz likes it hot"}]', 110),
                ('${biz}', 'Q-702', current_date, 'Table 5', '${D}', 'Other Person', 'COMPLETED', 'Other Person here', '[]', 65)`);
    sql(`update sales set customer_id='${B}' where id='${sale110}'`);
    sql(`insert into audit_log(business_id, action, actor_name, details, reference_id) values ('${biz}', 'Customers merged', 'Owner', 'Roz → Rosalind', '${A}'), ('${biz}', 'Customer updated', 'Owner', 'Rozzy', '${C}'), ('${biz}', 'Customer updated', 'Owner', 'Other Person', '${D}')`);
    await go(bo, 'customers');
    await bo.waitForSelector(`[data-cust="${A}"]`);
    ok(!(await bo.$(`[data-cust="${B}"]`)) && !(await bo.$(`[data-cust="${C}"]`)), 'merged records are not listed');
    await bo.click(`[data-cust="${A}"]`); await bo.waitForSelector('#cu-delete');
    await bo.click('#cu-delete'); await confirm(bo);
    const deleted = await until(() => sql(`select count(*) from customers where id in ('${A}','${B}','${C}')`) === '0', 10000);
    ok(deleted, 'all 3 records of the merge chain deleted (A, B merged into A, C merged into B)', [sql(`select string_agg(nickname, ',') from customers where id in ('${A}','${B}','${C}')`), await bo.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '))]);
    if(!deleted){ await H.shot(bo, 'bo-r3-customer-delete-failed'); bnet.allow(/\/rpc\/apply_changes$/); }
    ok(sql(`select count(*) from customers where id='${D}'`) === '1', 'the unrelated customer stays');
    ok(sql(`select coalesce(customer_id::text,'-')||'|'||coalesce(customer_nickname,'-')||'|'||customer_note||'|'||(items->0->>'notes') from qr_orders where order_number='Q-701'`) === '-|-|for [deleted customer], no sugar|[deleted customer] likes it hot', 'QR order of the deepest record: unlinked, name scrubbed from the note and item notes', sql(`select coalesce(customer_id::text,'-')||'|'||coalesce(customer_nickname,'-')||'|'||customer_note||'|'||(items->0->>'notes') from qr_orders where order_number='Q-701'`));
    ok(sql(`select coalesce(customer_id::text,'-') from sales where id='${sale110}'`) === '-' && sql(`select grand_total from sales where id='${sale110}'`) === '110', 'sale of the middle record unlinked, its money unchanged');
    ok(sql(`select count(*) from audit_log where details ~ '(Rosalind|Rozzy|Roz)([^a-z]|$)'`) === '0', 'nicknames scrubbed from earlier audit entries', sql(`select string_agg(details, ' / ') from audit_log where details ~ 'Ro[sz]'`));
    ok(sql(`select details from audit_log where reference_id='${D}'`) === 'Other Person' && sql(`select customer_note from qr_orders where order_number='Q-702'`) === 'Other Person here', 'other customers\' records untouched');
    ok(sql(`select count(*) from audit_log where action='Customer data deleted on request' and (details like '3 customer record(s)%' or details like '1 customer record + 2 merged record(s)%')`) === '1', 'delete logged once with all 3 records of the chain', sql(`select string_agg(details, ' / ') from audit_log where action='Customer data deleted on request'`));

    ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  }catch(e){ await H.shot(bo, 'bo-r3-stopped'); await H.shot(fo, 'bo-r3-counter-stopped'); await browser.close(); H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
