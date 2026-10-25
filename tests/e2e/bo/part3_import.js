// Back Office part 3 (after parts 1-2): importer (old apps' backup file twice, old browser data in
// IndexedDB, own backup round trip), imported cashier's old PIN at the counter, non-owner login refused,
// forgot / reset password screens, expired link, new shop sign-up, tablet + phone layouts.
// Run all parts in order with tests/e2e/bo.e2e.js (BO_VIEWPORT=1280x900 or 768x1024).
const H = require('./bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'bo/part3_import@' + H.sizeTag();
const {sql, rows, one, ok, must: until, confirm, toastText, clearToasts, go, modalGone} = H;
const BASE = H.BASE, SHOTS = require('path').join(H.SHOTS, 'bo-' + H.sizeTag() + '-');
async function typePin(p, pin){ for(const d of pin) await p.click(`#pin-pad button[data-k="${d}"]`); await p.click('#pin-enter'); }
async function login(page, email, pass){ await page.goto(BASE + '/cccc/back/'); await page.waitForSelector('#li-email'); await H.focusSettled(page, 'li-email'); await page.fill('#li-email', email); await page.fill('#li-pass', pass); await page.click('#f-login button[type=submit]'); }
async function runFileImport(page, file){
  await go(page, 'backup');
  await page.setInputFiles('#imp-file', file);
  await page.waitForSelector('#imp-go');
  if(await page.$('#imp-settings')) await page.uncheck('#imp-settings');
  await page.click('#imp-go'); await confirm(page);
  await page.waitForSelector('#imp-progress .notice.ok, #imp-progress .text-red', {timeout: 60000});
  return page.textContent('#imp-progress');
}
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await H.boContext(browser);
  const page = await ctx.newPage(); H.attach(page, errors, 'BO');
  await login(page, 'owner@example.com', 'secret123');
  await page.waitForSelector('#app', {state: 'visible', timeout: 20000});
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  const before = Number(sql(`select (select count(*) from ingredients)+(select count(*) from recipes)+(select count(*) from sales)+(select count(*) from inventory_transactions)`));

  // ---- old apps' backup file
  let t = await runFileImport(page, __dirname + '/fixtures/old-backup.json');
  console.log('     result: ' + t.replace(/\s+/g, ' ').trim());
  ok(/1 staff member keeps their old PIN/.test(t) && /Zed already had a PIN here/.test(t), 'PIN note: Lia keeps her old PIN; Zed (owner) keeps his current one');
  // batch 1 (lead-approved 2026-10-26): the fixture's ₱0 pay-in is now skipped as a broken line -> 29 new (was 30)
  ok(/29 new records added, 3 were already here/.test(t) && /1 skipped because what they belong to is missing/.test(t), 'old backup: 29 new records, 3 already here (Coffee, House-Made, owner Zed), 1 line whose parent is missing skipped');
  ok(/1 skipped because it is a broken line \(a pay-in or pay-out of ₱0 or less\)/.test(t), 'old backup: the ₱0 pay-in is skipped as "a broken line (a pay-in or pay-out of ₱0 or less)" and the import finishes');
  ok(sql(`select count(*) from cash_movements where amount <= 0`) === '0', 'no ₱0 cash movement saved');
  await page.screenshot({path: SHOTS + 'f-import-done.png', fullPage: true});
  const syrupIng = one(`select id, source_recipe_id, local_id from ingredients where name='Brown Sugar Syrup'`);
  const syrupRec = one(`select id, produced_ingredient_id, local_id from recipes where name='Brown Sugar Syrup'`);
  ok(syrupIng.source_recipe_id === syrupRec.id && syrupRec.produced_ingredient_id === syrupIng.id && syrupIng.local_id === 'ing_syrup' && syrupRec.local_id === 'rec_syrup', 'produced item <-> its recipe linked both ways; old ids kept in local_id');
  const bsl = one(`select modifier_groups from recipes where local_id='rec_bsl'`);
  const lg = bsl.modifier_groups[0].options[1];
  ok(bsl.modifier_groups[0].multi_select === false && bsl.modifier_groups[0].required === true && lg.label === 'Large' && Number(lg.price_delta) === 25 && lg.ingredient_id === syrupIng.id && Number(lg.ingredient_qty_delta) === 10, 'old option groups converted (priceDelta -> price_delta, ingredientId -> new id)');
  const sale = one(`select s.id, s.cashier_id, s.cashier_name, s.shift_id, st.name as cashier from sales s left join staff st on st.id=s.cashier_id where s.local_id='sale_1'`);
  ok(sale && sale.cashier === 'Lia Barista' && sale.shift_id === sql(`select id from shifts where local_id='shift_1'`), 'old sale linked to its shift and to the cashier (by name)');
  ok(sql(`select count(*) from sales where local_id='sale_held'`) === '0', 'held (unfinished) old order left out');
  const si = one(`select modifiers from sale_items where local_id='sit_1'`).modifiers[0];
  ok(si.price_delta === 25 && si.ingredient_id === syrupIng.id && si.ingredient_qty_delta === 10, 'sold line options converted to the new shape');
  ok(sql(`select reference_id from inventory_transactions where local_id='txn_6'`) === sale.id, 'stock line still points at its sale (new id)');
  ok(sql(`select supplier_id from purchases where local_id='pur_1'`) === sql(`select id from suppliers where local_id='sup_2'`), 'purchase keeps its supplier');
  ok(sql(`select count(*) from categories where name='Coffee'`) === '1', 'same-name category reused, not duplicated');
  ok(sql(`select count(*) from staff where name='Zed'`) === '1', 'old admin "Zed" matched to the owner, not duplicated');
  ok(sql(`select (legacy_sha256 is not null)::text from staff_pins where staff_id=(select id from staff where local_id='user_lia')`) === 'true', "old cashier's PIN brought in (legacy hash)");
  ok(Number(sql(`select stock from v_ingredient_stock where ingredient_id=(select id from ingredients where local_id='ing_beans')`)) === 1000 - 20 - 18 - 12, 'old stock history adds up (1000 - 20 waste - 18 sold - 12 count = 950)');

  // ---- run it again: nothing new
  t = await runFileImport(page, __dirname + '/fixtures/old-backup.json');
  console.log('     second result: ' + t.replace(/\s+/g, ' ').trim().slice(0, 300));
  ok(/^\s*Done\. 0 new records added, 32 were already here/.test(t), 'second import of the same file adds nothing (32 already here)');
  const after = Number(sql(`select (select count(*) from ingredients)+(select count(*) from recipes)+(select count(*) from sales)+(select count(*) from inventory_transactions)`));
  ok(after === before + 3 + 2 + 1 + 8, 'record counts unchanged by the second run');

  // ---- the old PIN works at the counter
  const fctx = await H.counterContext(browser);
  const fo = await fctx.newPage(); H.attach(fo, errors, 'FO');
  await go(page, 'devices'); await page.click('#pair-new'); await page.click('#pd-make'); await page.waitForSelector('.big-code');
  const code = (await page.textContent('.big-code')).trim(); await page.click('#active-modal-overlay [data-cancel]');
  await fo.goto(BASE + '/cccc/front/?pair=' + code); await fo.waitForSelector('#su-code'); await fo.click('#su-pair');
  await fo.waitForSelector('#pin-gate', {state: 'visible', timeout: 20000});
  await typePin(fo, '4321');
  await fo.waitForSelector('#app', {state: 'visible', timeout: 15000});
  ok((await fo.textContent('#sidebar')).includes('Lia Barista'), "imported cashier signs in at the counter with her OLD PIN (4321)");
  ok(sql(`select (pin_hash is not null and legacy_sha256 is null)::text from staff_pins where staff_id=(select id from staff where local_id='user_lia')`) === 'true', 'old PIN upgraded to a bcrypt hash on first sign-in');
  await fctx.close();

  // ---- old apps' data still in this browser (IndexedDB "coffeeShopDB")
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('coffeeShopDB', 4);
    req.onupgradeneeded = () => { const db = req.result; ['categories','ingredients','purchases','inventoryTransactions'].forEach(s => db.createObjectStore(s, {keyPath: 'id'})); db.createObjectStore('settings', {keyPath: 'key'}); db.createObjectStore('deviceConfig', {keyPath: 'key'}); };
    req.onsuccess = () => { const db = req.result; const tx = db.transaction(['categories','ingredients','inventoryTransactions','settings'], 'readwrite');
      tx.objectStore('categories').put({id: 'cat_tea', name: 'Tea & Powders'});
      tx.objectStore('ingredients').put({id: 'ing_matcha', name: 'Matcha Powder', categoryId: 'cat_tea', base_unit: 'g', reorder_level: 50, active: true});
      tx.objectStore('inventoryTransactions').put({id: 'txn_m1', ingredientId: 'ing_matcha', transaction_type: 'INITIAL_STOCK', quantity: 250, transaction_date: new Date().toISOString(), notes: 'Starting stock'});
      tx.objectStore('settings').put({key: 'app', business_name: 'Browser Shop'});
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    req.onerror = () => reject(req.error);
  }));
  await go(page, 'backup');
  await page.waitForSelector('#imp-use-local', {timeout: 10000});
  ok((await page.textContent('#imp-local')).includes('1 ingredients'), 'old app data found in this browser');
  await page.click('#imp-use-local'); await page.waitForSelector('#imp-go');
  await page.uncheck('#imp-settings').catch(() => {});
  await page.click('#imp-go'); await confirm(page);
  await page.waitForSelector('#imp-progress .notice.ok', {timeout: 30000});
  ok(sql(`select i.local_id || '/' || c.name || '/' || v.stock from ingredients i join categories c on c.id=i.category_id join v_ingredient_stock v on v.ingredient_id=i.id where i.name='Matcha Powder'`) === 'ing_matcha/Tea & Powders/250', 'browser data imported (Matcha, its category and its starting stock)');
  ok(sql(`select business_name from settings where business_id='${biz}'`) !== 'Browser Shop', 'settings not replaced when the box is left unticked');

  // ---- this Back Office's own backup: download, then import it back
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-backup')]);
  const backupFile = await dl.path();
  const payload = JSON.parse(require('fs').readFileSync(backupFile, 'utf8'));
  ok(payload.format === 'cccc-backup' && payload.data.sales.length === Number(sql('select count(*) from sales')) && payload.data.devices.every(d => !('device_key' in d)), 'backup file has every table (counter keys left out)');
  const ownBackup = require('path').join(H.SHOTS, 'cccc-backup-' + process.pid + '.json');   // temp copy, outside the repo
  require('fs').copyFileSync(backupFile, ownBackup);
  t = await runFileImport(page, ownBackup);
  ok(/^\s*Done\. 0 new records added/.test(t), 'importing our own backup into the same shop adds nothing (insert-only, no overwrites)');

  // ---- not the owner -> refused
  sql(`insert into auth.users(id, email, encrypted_password) values ('00000000-0000-0000-0000-0000000000b2','mgr@example.com', extensions.crypt('secret123', extensions.gen_salt('bf'))) on conflict do nothing`);
  sql(`update profiles set business_id='${biz}', role='MANAGER', name='Manny email' where id='00000000-0000-0000-0000-0000000000b2'`);   // the sign-up trigger gave it its own shop first
  const c2 = await H.boContext(browser);
  const p2 = await c2.newPage(); H.attach(p2, errors, 'MGR');
  await login(p2, 'mgr@example.com', 'secret123');
  await p2.waitForSelector('#no-signout', {timeout: 15000});
  ok((await p2.textContent('#auth-screen')).includes("This page is for the shop owner's login"), 'a non-owner login gets "This page is for the shop owner\'s login"');
  await p2.screenshot({path: SHOTS + 'f-not-owner.png'});
  await p2.click('#no-signout'); await p2.waitForSelector('#li-email');
  ok(true, 'sign out from the refusal screen');
  // ---- forgot password + reset screen
  await p2.click('[data-view="forgot"]'); await p2.fill('#fp-email', 'owner@example.com'); await p2.click('#f-forgot button[type=submit]');
  await p2.waitForFunction(() => /reset link is on its way/.test(document.getElementById('auth-msg').textContent));
  ok(true, 'forgot password sends the email (plain confirmation shown)');
  const tok = await (await fetch(BASE + '/auth/v1/token?grant_type=password', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: 'owner@example.com', password: 'secret123'})})).json();
  await p2.goto('about:blank');
  await p2.goto(BASE + '/cccc/back/#access_token=' + tok.access_token + '&refresh_token=' + tok.refresh_token + '&expires_in=3600&token_type=bearer&type=recovery');
  await p2.waitForSelector('#np-1', {timeout: 15000});
  ok(!(await p2.evaluate(() => location.hash)).includes('access_token'), 'email-link login removed from the address bar');
  ok(true, 'reset link opens "Choose a new password"');
  await p2.screenshot({path: SHOTS + 'f-new-password.png'});
  // set the new password through the screen (cloud.updatePassword -> PUT /auth/v1/user)
  const putsBefore = [];
  p2.on('request', r => { if(/\/auth\/v1\/user$/.test(r.url()) && r.method() === 'PUT') putsBefore.push(r.url()); });
  await H.focusSettled(p2, 'np-1');
  await p2.fill('#np-1', 'short'); await p2.fill('#np-2', 'short'); await p2.click('#f-newpass button[type=submit]');
  await p2.waitForTimeout(500);
  ok(await p2.evaluate(() => document.getElementById('np-1').validity.tooShort) && putsBefore.length === 0 && await p2.isVisible('#np-1'), 'new password: too short -> not sent (the form asks for 8+ characters)');
  await p2.fill('#np-1', 'newsecret456'); await p2.fill('#np-2', 'newsecret457'); await p2.click('#f-newpass button[type=submit]');
  ok(await H.until(async () => /two passwords are different/.test(await p2.textContent('#auth-msg')), 5000), 'new password: the two boxes differ -> plain message');
  await p2.fill('#np-2', 'newsecret456'); await p2.click('#f-newpass button[type=submit]');
  ok(await H.until(async () => await p2.isVisible('#app'), 20000), 'new password saved -> Back Office opens');
  const tokenOk = async (pw) => (await fetch(BASE + '/auth/v1/token?grant_type=password', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: 'owner@example.com', password: pw})})).ok;
  ok(await tokenOk('newsecret456') && !(await tokenOk('secret123')), 'the owner signs in with the new password only');
  sql(`update auth.users set encrypted_password = extensions.crypt('secret123', extensions.gen_salt('bf')) where email = 'owner@example.com'`);   // later parts use secret123
  await p2.goto('about:blank');
  await p2.goto(BASE + '/cccc/back/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await p2.waitForFunction(() => /expired/.test(document.getElementById('auth-msg') && document.getElementById('auth-msg').textContent));
  ok(true, 'an expired email link shows a plain message');
  await c2.close();

  // ---- create a new shop account -> starter data
  const c3 = await H.boContext(browser);
  const p3 = await c3.newPage(); H.attach(p3, errors, 'NEW');
  await p3.goto(BASE + '/cccc/back/'); await p3.waitForSelector('[data-view="signup"]'); await p3.click('[data-view="signup"]');
  await H.focusSettled(p3, 'su-biz');
  await p3.fill('#su-biz', 'Second Shop'); await p3.fill('#su-name', 'Bea'); await p3.fill('#su-email', 'bea@example.com'); await p3.fill('#su-pass', 'longpassword');
  await p3.click('#f-signup button[type=submit]');
  const opened = await H.until(async () => await p3.isVisible('#app'), 25000);
  if(!opened) await p3.screenshot({path: SHOTS + 'f-signup-stuck.png', fullPage: true});
  ok(opened, 'new shop account: sign-up opens the Back Office', opened ? '' : (await p3.textContent('body')).replace(/\s+/g, ' ').slice(0, 300));
  if(opened){
    const nb = sql(`select business_id from profiles p join auth.users u on u.id=p.id where u.email='bea@example.com'`);
    ok(nb !== biz && sql(`select count(*) from categories where business_id='${nb}'`) === '10' && sql(`select name from suppliers where business_id='${nb}'`) === 'Local Supplier', 'new shop account: own shop with the starter categories (9 incl. Raw materials + House-Made) and a default supplier');
    ok(sql(`select count(*) from categories where business_id='${nb}' and name='Raw materials'`) === '1', 'new shop account: "Raw materials" is one of the starter categories');
    ok((await p3.textContent('#sidebar')).includes('Second Shop'), 'new shop opens on its own dashboard');
  }
  await c3.close();

  // ---- tablet and phone layouts
  for(const [w, h, tag] of [[768, 1024, 'tablet'], [390, 844, 'phone']]){
    await page.setViewportSize({width: w, height: h});
    for(const r of ['dashboard', 'recipes', 'calendar', 'transactions']){
      await go(page, r); await page.waitForTimeout(700);
      const overflow = await page.evaluate(() => document.getElementById('main').scrollWidth - document.getElementById('main').clientWidth);
      if(overflow > 2) console.log(`     note: ${tag} ${r} main area overflows by ${overflow}px`);
      await page.screenshot({path: SHOTS + `${tag}-${r}.png`});
    }
  }
  await page.setViewportSize({width: 390, height: 844});
  await page.click('#nav-toggle'); await page.waitForTimeout(300);
  ok(await page.isVisible('.nav-item[data-route="settings"]'), 'phone: the menu opens from the ☰ button');
  await page.screenshot({path: SHOTS + 'phone-menu.png'});
  await page.click('.nav-item[data-route="staff"]'); await page.waitForTimeout(500);
  ok(!(await page.evaluate(() => document.body.classList.contains('nav-open'))) && (await page.textContent('#topbar-title')) === 'Staff & PINs', 'phone: choosing a screen closes the menu');

  ok(errors.length === 0, 'no browser errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
