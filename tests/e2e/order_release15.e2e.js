// Release 1.5 QR page checks (adopted by Z 2026-11-12 from the QR page work's scratch qr15-check.e2e.js): register or
// order as guest, greyed stamp card, usernames, table limits (4 unpaid tickets, 1 guest), account switch with unpaid
// orders, signed out elsewhere, saved stamps + past cards, highlighted item, "Lactose intolerant?" swap prompt.
// Needs a fresh seed:  tests/e2e_reset.sh db_qr && tests/restart_fake.sh 8792 db_qr
//   FAKE_PORT=8792 FAKE_DB=db_qr QA_SHOTS=<dir> node tests/e2e/order_release15.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const path = require('path');
const fs = require('fs');
const NAME = 'order_release15';
const DIR = path.join(H.SHOTS, 'order15'); fs.mkdirSync(DIR, {recursive: true});
const URL = H.BASE + '/cccc/order/?t=tabletoken5';
const {sql, ok, sleep, until} = H;
const BIZ = '(select id from businesses limit 1)';
const AMER = '33333333-0000-0000-0000-000000000003', LATTE = '33333333-0000-0000-0000-000000000001';
const SEED14 = path.join(__dirname, '..', 'sql', '23_seed_release14_qr.sql');

(async () => {
  sql(`update settings set loyalty_enabled = true, theme = 'CCCC', menu_highlight_recipe_id = null`);
  sql(`delete from qr_orders`);
  H.openShopForQr();
  const browser = await chromium.launch();
  const errors = [];
  async function phone(w, h, opts){
    const ctx = await browser.newContext(Object.assign({viewport: {width: w || 390, height: h || 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2}, opts || {}));
    const page = await ctx.newPage(); H.attach(page, errors, 'P' + (w || 390));
    return {ctx, page};
  }
  const shot = async (page, n, full) => { await sleep(450); await page.screenshot({path: path.join(DIR, n + '.png'), fullPage: !!full}); };
  const noH = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  // (Z: measured only after the sheet's slide-up animation has ended; mid-slide the boxes can read a hair under 44 px)
  const small = (page, sel) => page.evaluate(async (s) => { const sh = document.querySelector('.sheet'); if(sh) await Promise.all(sh.getAnimations().map(a => a.finished.catch(() => {}))); return [...document.querySelectorAll(s || 'button, input:not([type=checkbox]), summary')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.height < 44 || r.width < 44); }).map(e => (e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().height)); }, sel);
  async function addAmericano(page){
    await page.click(`.item[data-item="${AMER}"]`); await page.waitForSelector('#it-add'); await page.click('#it-add');
    await page.waitForSelector('#view-cart');
  }
  async function register(page, nick, ph){
    await page.waitForSelector('#w-name'); await page.fill('#w-name', nick);
    if(ph) await page.fill('#w-phone', ph);
    await page.check('#w-consent'); await page.click('#w-go');
    return until(async () => await page.isVisible('#not-me'), 10000);
  }
  try{
    // ---------- 1. first visit: the choice
    const A = await phone();
    const placeBodies = [];
    A.page.on('request', r => { if(r.url().includes('/rpc/qr_place_order')) placeBodies.push(JSON.parse(r.postData() || '{}')); });
    await A.page.goto(URL);
    await A.page.waitForSelector('#w-guest');
    await A.page.evaluate(() => document.fonts.ready);
    ok(await A.page.isVisible('#w-choose-reg') && await A.page.isVisible('#w-name'), 'first visit: "Register" choice + name form shown');
    ok(/Order as guest/.test(await A.page.textContent('#w-guest')), 'first visit: "Order as guest" offered');
    ok(await A.page.evaluate(() => { const r = document.getElementById('w-guest').getBoundingClientRect(); return r.bottom <= innerHeight; }), 'guest choice is on the first screen (no scrolling)');
    ok(await noH(A.page), 'no sideways scroll at 390 (welcome)');
    ok((await small(A.page)).length === 0, '44 px tap targets on the welcome', await small(A.page));
    await shot(A.page, '01-first-visit-choice');
    await shot(A.page, '01b-first-visit-full', true);
    const P360 = await phone(360, 740); await P360.page.goto(URL); await P360.page.waitForSelector('#w-guest');
    ok(await noH(P360.page), 'no sideways scroll at 360 (welcome)'); await shot(P360.page, '01c-first-visit-360'); await P360.ctx.close();

    // ---------- 2. guest
    await A.page.click('#w-guest');
    ok(await until(() => A.page.isVisible('#guest-card'), 5000), 'guest: greyed stamp card shown');
    ok(await A.page.$eval('#guest-card', e => e.classList.contains('is-guest') && getComputedStyle(e.querySelector('.stamps')).filter.includes('grayscale')), 'guest: card is greyed');
    ok(/Register to collect stamps/.test(await A.page.textContent('#guest-register')), 'guest: "Register to collect stamps"');
    ok(!(await A.page.isVisible('#w-name')), 'guest: name form gone');
    await sleep(3300);
    await shot(A.page, '02-guest-greyed-card');
    await addAmericano(A.page);
    await A.page.click('#view-cart');
    ok(/won't collect stamps/.test(await A.page.textContent('.sheet')), 'guest cart says no stamps');
    await A.page.click('#c-place');
    ok(await until(() => A.page.isVisible('.ticket-no'), 8000), 'guest order placed (ticket)');
    ok(placeBodies.length && placeBodies[placeBodies.length - 1].p_guest === true, 'qr_place_order sent p_guest:true', placeBodies[placeBodies.length - 1]);
    ok(!placeBodies.some(b => JSON.stringify(b).includes('price')), 'no price sent to the server');
    ok(sql(`select is_guest::text || '|' || coalesce(customer_id::text, 'null') from qr_orders order by created_at desc limit 1`) === 'true|null', 'saved as a guest order (no customer)');
    ok(/Guest/.test(await A.page.textContent('.ticket-where')), 'ticket says Guest');
    ok(await A.page.isVisible('#guest-join-card'), 'ticket offers "Collect stamps next time"');
    await shot(A.page, '03-guest-ticket', true);
    await A.page.reload(); await A.page.waitForSelector('.ticket-no');
    await A.page.click('#order-more');
    ok(await until(() => A.page.isVisible('#guest-card'), 5000) && !(await A.page.isVisible('#w-name')), 'reload: still a guest (no welcome again)');

    // ---------- 3. a second guest at the same table -> GUEST_TABLE_BUSY, register to order
    const B = await phone();
    await B.page.goto(URL); await B.page.waitForSelector('#w-guest'); await B.page.click('#w-guest');
    await B.page.waitForSelector('#guest-card'); await sleep(3300);
    await addAmericano(B.page); await B.page.click('#view-cart'); await B.page.click('#c-place');
    ok(await until(async () => /already ordering as a guest/.test(await B.page.textContent('#c-err')), 6000), 'second guest: GUEST_TABLE_BUSY in plain words', await B.page.textContent('#c-err'));
    ok(await B.page.isVisible('#c-register'), 'second guest: "Register to order" offered');
    await shot(B.page, '04-guest-table-busy');
    await B.page.click('#c-register');
    ok(await B.page.isVisible('#w-name') && /Back to guest/.test(await B.page.textContent('#w-guest')), 'register form opens from the cart (with "Back to guest")');
    await shot(B.page, '04b-guest-register-later');
    ok(await register(B.page, 'Nia', '0917 555 0199'), 'second guest registers as Nia');
    ok(await B.page.isVisible('#view-cart'), 'cart kept after registering');
    const nia = sql(`select username from customers where nickname = 'Nia'`);
    ok(nia.length > 3 && (await B.page.textContent('.un-name')) === nia, 'username shown: ' + nia, await B.page.textContent('.username-line'));
    await B.page.click('#view-cart'); await B.page.click('#c-place');
    ok(await until(() => B.page.isVisible('.ticket-no'), 8000), 'Nia (registered) can order at the table with a guest');

    // ---------- 4. the guest registers later on the same phone; username change
    await A.page.click('#guest-register');
    ok(await register(A.page, 'Gus'), 'guest registers later as Gus');
    ok(sql(`select count(*) from qr_orders where is_guest and customer_id is null`) === '1', 'the earlier guest order stays a guest order');
    await A.page.click('#un-change'); await A.page.waitForSelector('#un-input');
    await A.page.fill('#un-input', 'Gus the admin'); await A.page.click('#un-save');
    ok(await until(async () => /can't be used/.test(await A.page.textContent('#un-err')), 5000), 'BAD_USERNAME in plain words', await A.page.textContent('#un-err'));
    await A.page.fill('#un-input', nia.toUpperCase()); await A.page.click('#un-save');
    ok(await until(async () => /already has that username/.test(await A.page.textContent('#un-err')), 5000), 'USERNAME_TAKEN in plain words (case ignored)', await A.page.textContent('#un-err'));
    await shot(A.page, '05-username-taken');
    await A.page.fill('#un-input', 'Gus the Latte Lover'); await A.page.click('#un-save');
    ok(await until(async () => (await A.page.textContent('.un-name')) === 'Gus the Latte Lover', 5000), 'username changed');
    await shot(A.page, '05b-member-username');
    // TOO_MANY_ATTEMPTS (simulated) for username
    await A.page.route('**/rpc/qr_set_username', r => r.fulfill({status: 200, contentType: 'application/json', body: '{"error":"TOO_MANY_ATTEMPTS"}'}));
    await A.page.click('#un-change'); await A.page.fill('#un-input', 'Gus Two'); await A.page.click('#un-save');
    ok(await until(async () => /Too many tries/.test(await A.page.textContent('#un-err')), 5000), 'username TOO_MANY_ATTEMPTS in plain words', await A.page.textContent('#un-err'));
    await A.page.unroute('**/rpc/qr_set_username'); await A.page.keyboard.press('Escape');

    // ---------- 5. TABLE_FULL
    sql(`insert into qr_orders(business_id, order_number, order_day, table_id, table_label, status, items, total)
         select ${BIZ}, 'Q-8' || g, current_date, (select id from dining_tables where qr_token='tabletoken5'), 'Table 5', 'PENDING', '[]', 0 from generate_series(1, 4) g`);
    await sleep(3300);
    await addAmericano(A.page); await A.page.click('#view-cart'); await A.page.click('#c-place');
    ok(await until(async () => /already has 4 orders waiting/.test(await A.page.textContent('#c-err')), 6000), 'TABLE_FULL in plain words', await A.page.textContent('#c-err'));
    await shot(A.page, '06-table-full');
    sql(`delete from qr_orders where order_number like 'Q-8%'`);
    await A.page.click('#c-place');
    ok(await until(() => A.page.isVisible('.ticket-no'), 8000), 'Gus orders once a place is free');
    await A.page.click('#order-more');

    // ---------- 6. switch account with unpaid orders
    // Gus's phone: the guest order (PENDING) + Gus's order -> make Gus's PREPARING.
    sql(`update qr_orders set status = 'PREPARING' where customer_nickname = 'Gus'`);
    const waiting = sql(`select count(*) from qr_orders where status='PENDING' and auth_user_id = (select auth_user_id from customer_devices cd join customers c on c.id = cd.customer_id where c.nickname='Gus')`);
    await A.page.click('#not-me'); await A.page.click('#nm-go');
    ok(await until(async () => /You still have unpaid orders\. Do you still want to proceed\?/.test(await A.page.textContent('.sheet')), 5000), 'switch: "You still have unpaid orders. Do you still want to proceed?"');
    const ask = await A.page.textContent('.ask-list');
    ok(/1 order still waiting.*cancelled/.test(ask) && /1 order is already being made.*pay at the counter/.test(ask), 'switch: says waiting will be cancelled, being made can be paid at the counter', ask + ' | waiting=' + waiting);
    ok((await small(A.page, '.sheet button')).length === 0, 'switch: 44 px buttons', await small(A.page, '.sheet button'));
    await shot(A.page, '07-switch-unpaid-prompt');
    await A.page.click('#sw-no');
    ok(await A.page.isVisible('#not-me') && sql(`select count(*) from qr_orders where status='CANCELLED'`) === '0', 'No: still signed in, nothing cancelled');
    await A.page.click('#not-me'); await A.page.click('#nm-go'); await A.page.waitForSelector('#sw-yes'); await A.page.click('#sw-yes');
    ok(await until(() => A.page.isVisible('#w-name'), 6000), 'Yes: signed out (welcome screen)');
    const note = await A.page.textContent('.note-info');
    ok(/Signed out\. 1 waiting order was cancelled\. 1 order is still being made/.test(note), 'Yes: message uses cancelled / kept', note);
    ok(sql(`select string_agg(status, ',' order by status) from qr_orders where auth_user_id = (select auth_user_id from qr_orders where customer_nickname='Gus' limit 1)`) === 'CANCELLED,PREPARING', 'server: waiting cancelled, being made kept');
    ok(await A.page.isVisible('.my-order'), 'the kept order is still listed on this phone');
    await shot(A.page, '08-switch-done', true);
    // a phone with no unpaid orders: straight out
    // ---------- 7. signed out elsewhere (relink on another phone)
    const C = await phone();
    await C.page.goto(URL); await C.page.waitForSelector('#w-relink'); await C.page.click('#w-relink');
    await C.page.fill('#r-phone', '0917 555 0199'); await C.page.fill('#r-name', 'Nia'); await C.page.click('#r-go');
    ok(await until(() => C.page.isVisible('#not-me'), 8000), 'Nia opens her account on phone C');
    await B.page.goto(URL + '&view=menu');
    ok(await until(async () => /opened on another phone/.test(await B.page.textContent('#main')), 8000), 'phone B: "Your account was opened on another phone"');
    await shot(B.page, '09-signed-out-elsewhere');
    await B.page.reload(); await B.page.waitForSelector('#w-guest');
    ok(!/opened on another phone/.test(await B.page.textContent('#main')), 'shown once (gone after reload)');

    // ---------- 8. SIGN_OUT_FIRST + relink TOO_MANY wording
    const D = await phone();
    await D.page.goto(URL); ok(await register(D.page, 'Ola'), 'Ola registers (no number)');
    await sleep(3300); await addAmericano(D.page); await D.page.click('#view-cart'); await D.page.click('#c-place');
    await D.page.waitForSelector('#pc-phone');
    await D.page.fill('#pc-phone', '0917 555 0199'); await D.page.click('#pc-save');
    await D.page.waitForSelector('#pc-help .taken button'); await D.page.click('#pc-help .taken button');
    await D.page.waitForSelector('#r-go'); await D.page.fill('#r-name', 'Nia'); await D.page.click('#r-go');
    ok(await until(async () => /Sign out first/.test(await D.page.textContent('#r-err')), 5000), 'SIGN_OUT_FIRST in plain words', await D.page.textContent('#r-err'));
    ok(await D.page.isVisible('#r-signout'), '"Sign out of Ola" offered');
    await shot(D.page, '10-sign-out-first');
    await D.page.click('#r-signout');
    ok(await until(() => D.page.isVisible('#nm-go'), 3000), '"Sign out of Ola" opens the sign-out sheet');
    await D.page.click('#nm-go');
    ok(await until(async () => /unpaid orders/.test(await D.page.textContent('.sheet')), 5000), 'then asks about unpaid orders');
    await D.page.keyboard.press('Escape');
    const E = await phone();
    await E.page.goto(URL); await E.page.waitForSelector('#w-relink');
    await E.page.route('**/rpc/qr_relink', r => r.fulfill({status: 200, contentType: 'application/json', body: '{"error":"TOO_MANY_ATTEMPTS"}'}));
    await E.page.click('#w-relink'); await E.page.fill('#r-phone', '0917 000 0000'); await E.page.fill('#r-name', 'X'); await E.page.click('#r-go');
    ok(await until(async () => (await E.page.textContent('#r-err')) === 'Too many tries. Please ask our staff at the counter, or try again later.', 5000), 'relink TOO_MANY_ATTEMPTS: ask staff at the counter', await E.page.textContent('#r-err'));
    await E.ctx.close();

    // ---------- 9. B16 saved stamps + past cards (Nia on phone C)
    const nid = sql(`select id from customers where nickname='Nia'`);
    for(let n = 0; n < 20; n++){
      const day = 80 - Math.floor(n / 2), food = n % 2 === 1;
      sql(`with s as (insert into sales(business_id, customer_id, status, transaction_date, subtotal, grand_total)
           values (${BIZ}, '${nid}', 'COMPLETED', now() - interval '${day} days', 100, 100) returning id)
          insert into sale_items(sale_id, business_id, recipe_id, quantity, unit_price) select id, ${BIZ}, '${food ? '33333333-0000-0000-0000-000000000004' : AMER}', 1, 100 from s`);
    }
    await C.page.reload(); await C.page.waitForSelector('#stamp-card');
    const saved = await C.page.textContent('.stamp-saved');
    ok(/^5 stamps saved for your next card\. Use your free drink or food to start card 2\.$/.test(saved.trim()), 'saved: "5 stamps saved for your next card…"', saved);
    ok(/5 stamps saved/.test(await C.page.getAttribute('.stamps[role=img]', 'aria-label')), 'saved: in the screen-reader text');
    await C.page.locator('#stamp-card').screenshot({path: path.join(DIR, '11-saved-stamps.png')});
    // use rewards 5, 10, 15 of card 1 -> card 2 opens, card 1 in history
    for(const [m, t, a, d] of [[5, 'AMOUNT_OFF', 10, 70], [10, 'AMOUNT_OFF', 50, 60], [15, 'FREE_ITEM', 150, 50]]){
      const sid = sql(`insert into sales(business_id, customer_id, status, transaction_date, subtotal, grand_total) values (${BIZ}, '${nid}', 'COMPLETED', now() - interval '${d} days', 0, 0) returning id`).split('\n')[0];
      sql(`insert into loyalty_redemptions(business_id, customer_id, card_no, milestone, reward_type, sale_id, amount, created_at) values (${BIZ}, '${nid}', 1, ${m}, '${t}', '${sid}', ${a}, now() - interval '${d} days')`);
    }
    await C.page.reload(); await C.page.waitForSelector('#past-cards');
    ok(/Card 2/.test(await C.page.textContent('.stampcard-head')) && (await C.page.$$('.stamp.got')).length === 5, 'card 2 opens with the 5 saved stamps');
    ok(!(await C.page.isVisible('.stamp-saved')), 'no saved line on card 2');
    await C.page.click('#past-cards summary');
    const pc = (await C.page.textContent('.pc-list')).replace(/\s+/g, ' ');
    ok(/Card 1 · filled \w{3} \d{1,2}, \d{4} · completed \w{3} \d{1,2}, \d{4}/.test(pc) && /₱10 off\s*·?\s*used/.test(pc) && /₱50 off\s*·?\s*used/.test(pc) && /Free drink or food \(₱150 value\)\s*·?\s*used/.test(pc), 'past cards: card 1, dates, rewards used', pc);
    ok((await small(C.page, '#past-cards summary')).length === 0, 'past cards toggle is 44 px+');
    await C.page.locator('#stamp-card').screenshot({path: path.join(DIR, '12-past-cards.png')});

    // ---------- 10. B11 highlight
    sql(`update settings set menu_highlight_recipe_id = '${AMER}', menu_highlight_label = null, menu_highlight_blurb = 'Bold and smooth, made with our house beans.'`);
    await C.page.reload(); await C.page.waitForSelector('#highlight');
    ok(await C.page.evaluate(() => { const h = document.getElementById('highlight'), c = document.querySelector('.cats'); return !!(h.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'highlight sits at the top of the menu (before the sections)');
    ok(/Today's pick/.test(await C.page.textContent('#highlight')) && /Americano/.test(await C.page.textContent('#highlight')), 'highlight: label + name');
    ok(await noH(C.page), 'no sideways scroll with the highlight');
    await C.page.locator('#highlight').scrollIntoViewIfNeeded(); await shot(C.page, '13-highlight');
    await sleep(3000);
    await C.page.click('#highlight');
    ok(await until(async () => /Americano/.test(await C.page.textContent('.sheet-head h3')), 3000), 'tapping the highlight opens the item');
    await C.page.keyboard.press('Escape');
    sql(`update recipes set sold_out = true where id = '${AMER}'`);
    await C.page.reload(); await C.page.waitForSelector('#highlight');
    ok(await C.page.$eval('#highlight', e => e.classList.contains('off')) && /Sold out today/.test(await C.page.textContent('#highlight')), 'sold out: greyed, "Sold out today"');
    await C.page.click('#highlight', {force: true}); await sleep(400);
    ok(!(await C.page.isVisible('#it-add')), 'sold out: tapping does not open the item');
    await C.page.locator('#highlight').scrollIntoViewIfNeeded(); await shot(C.page, '14-highlight-sold-out');
    sql(`update recipes set sold_out = false where id = '${AMER}'`);
    sql(`update recipes set qr_visible = false where id = '${AMER}'`);
    await C.page.reload(); await C.page.waitForSelector('.cats');
    ok(!(await C.page.$('#highlight')), 'highlight not on the QR menu: hidden');
    sql(`update recipes set qr_visible = true where id = '${AMER}'`);

    // ---------- 11. B12 lactose prompt
    require('child_process').execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', H.DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', SEED14], {stdio: 'ignore'});
    const G2 = 'lib_44444444-0000-0000-0000-000000000002';
    await C.page.reload(); await C.page.waitForSelector(`.item[data-item="${LATTE}"]`);
    await C.page.click(`.item[data-item="${LATTE}"]`); await C.page.waitForSelector('#it-add');
    ok(!(await C.page.$(`.group[data-group="${G2}"]`)) && !/Lactose/.test(await C.page.textContent('.sheet')), 'oat milk out of stock: no prompt, Milk group hidden');
    await C.page.keyboard.press('Escape');
    sql(`insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date) values (${BIZ}, '22222222-0000-0000-0000-0000000000b1', 'PURCHASE', 5000, current_date)`);
    await C.page.reload(); await C.page.waitForSelector(`.item[data-item="${LATTE}"]`);
    await C.page.click(`.item[data-item="${LATTE}"]`); await C.page.waitForSelector('#it-add');
    const grp = await C.page.textContent(`.group[data-group="${G2}"]`);
    ok(/Lactose intolerant\? Have this instead/.test(grp) && /Non-dairy milk \(oat\)/.test(grp) && !/In place of the usual/.test(await C.page.textContent('.sheet')), 'in stock: "Lactose intolerant? Have this instead" + oat', grp);
    await C.page.locator(`.group[data-group="${G2}"]`).scrollIntoViewIfNeeded(); await shot(C.page, '15-lactose-prompt');
    await C.page.keyboard.press('Escape');

    ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  }catch(e){ console.log('STOPPED', e.stack); H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
