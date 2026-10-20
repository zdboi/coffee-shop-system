// Back Office part 6 (after parts 1-5): a finished sale's money is locked (SALE_LOCKED), while "Mark as reviewed"
// and notes still work.
//   * Transactions -> "Needs review only" -> open the sale -> "Mark as reviewed": saved, flag gone, money unchanged.
//   * The Back Office's own save path (applyChanges) refuses a money change before anything is sent.
//   * The server refuses it too when apply_changes is called directly from the signed-in owner's page
//     (total, discount, back to HELD), with the plain-words text; a notes change on the same sale is saved.
// Run all parts in order with tests/e2e/bo.e2e.js (BO_VIEWPORT=1280x900 or 768x1024).
const H = require('./bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo/part6_sale_lock@' + H.sizeTag();
const {sql, one, ok, go, toastText, clearToasts, until} = H;
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await H.boContext(browser);
  const page = await ctx.newPage(); const net = H.attach(page, errors, 'BO');
  const sends = []; page.on('request', r => { if(/rpc\/apply_changes/.test(r.url())) sends.push(r.postData() || ''); });
  const S = one(`select id, transaction_number, grand_total::float8 as g, subtotal::float8 as sub, status from sales
                 where status = 'COMPLETED' and not exists (select 1 from refunds r where r.sale_id = sales.id) order by transaction_date desc limit 1`);
  if(!S) H.abort(NAME, new Error('no completed sale left by parts 1-5'));
  const money = () => sql(`select subtotal::numeric(12,2)||'/'||coalesce(discount_amount,0)::numeric(12,2)||'/'||grand_total::numeric(12,2)||'/'||status from sales where id='${S.id}'`);
  const money0 = money();
  sql(`update sales set needs_review = true, review_reason = 'PRICE_BELOW_MENU' where id = '${S.id}'`);
  try{
    await H.boLogin(page);
    // ---- Mark as reviewed
    await go(page, 'transactions');
    await page.check('#tx-review');
    await page.waitForSelector(`tr[data-sale="${S.id}"]`, {timeout: 15000});
    ok(/Needs review/.test(await page.textContent(`tr[data-sale="${S.id}"]`)), `${S.transaction_number} is listed with "Needs review"`);
    await page.click(`tr[data-sale="${S.id}"]`);
    await page.waitForSelector('#sm-reviewed', {timeout: 10000});
    const note = (await page.textContent('#active-modal-overlay .notice.warn')).replace(/\s+/g, ' ');
    ok(/Needs review:/.test(note) && !/PRICE_BELOW_MENU/.test(note), 'sale window explains the review in plain words', note);
    await clearToasts(page);
    await page.click('#sm-reviewed');
    const t = await toastText(page);
    ok(/Marked as reviewed/.test(t), '"Mark as reviewed" -> "Marked as reviewed"', t);
    ok(await until(() => sql(`select needs_review::text from sales where id='${S.id}'`) === 'false', 10000), 'saved: needs_review is off');
    ok(money() === money0, 'reviewing did not touch the sale\'s money', [money0, money()]);
    ok(sql(`select count(*) from audit_log where action='Sale reviewed' and reference_id='${S.id}'`) === '1', 'audit log: "Sale reviewed"');
    await page.keyboard.press('Escape').catch(() => {});

    // ---- the Back Office's own save path refuses money changes before sending
    const n0 = sends.length;
    const guard = await page.evaluate(async (id) => {
      try{ await applyChanges([{op: 'update', table: 'sales', row: {id, grand_total: 1}}]); return 'saved'; }
      catch(e){ return (e.code || e.message) + '|' + friendlyError(e); }
    }, S.id);
    ok(/^SALE_LOCKED\|A finished sale's amounts can't be changed\.$/.test(guard), 'applyChanges refuses a total change with the plain-words text', guard);
    ok(sends.length === n0, 'nothing was sent to the server for it');
    // the guard logs one console.error on purpose ("Blocked a change to the money of a sale"): not counted as a page error
    for(let i = errors.length - 1; i >= 0; i--) if(/console: Blocked a change to the money of a sale/.test(errors[i])) errors.splice(i, 1);

    // ---- the server refuses it too (calling apply_changes directly from the owner's page)
    net.allow(/rpc\/apply_changes/);
    const direct = (row) => page.evaluate(async (row) => {
      try{ await cloud.rpc('apply_changes', {p_ops: [{op: 'update', table: 'sales', row}]}); return 'saved'; }
      catch(e){ return String(e.message || e) + '|' + friendlyError(e); }
    }, row);
    const r1 = await direct({id: S.id, grand_total: Number(S.g) + 100});
    ok(/SALE_LOCKED/.test(r1) && /A finished sale's amounts can't be changed\./.test(r1), 'server: owner can\'t change a finished sale\'s total -> SALE_LOCKED', r1);
    const r2 = await direct({id: S.id, discount_type: 'fixed', discount_value: 10, discount_amount: 10});
    ok(/SALE_LOCKED/.test(r2), 'server: ... nor add a discount', r2);
    const r3 = await direct({id: S.id, status: 'HELD'});
    ok(/SALE_LOCKED/.test(r3), 'server: ... nor turn it back into a held sale', r3);
    net.disallow();
    ok(money() === money0, 'the sale\'s money is unchanged', [money0, money()]);
    const r4 = await direct({id: S.id, notes: 'checked by QA'});
    ok(r4 === 'saved' && sql(`select notes from sales where id='${S.id}'`) === 'checked by QA', 'server: a notes change on the same sale is saved', r4);
    ok(money() === money0, 'and the money is still unchanged', [money0, money()]);
  }catch(e){ await H.shot(page, 'bo-' + H.sizeTag() + '-sale-lock-stopped'); await browser.close(); H.abort(NAME, e); }
  ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
