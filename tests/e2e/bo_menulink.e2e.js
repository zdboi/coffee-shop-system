// Back Office 1.4.1 menu link settings (adopted from back-office-dev's ml.e2e.js + imp.e2e.js, 2026-11-09):
//   part 1: Settings -> Menu link (link, switch, texts, highlight, shop code, import mapping, 1280 / 768 / 390)
//   part 2: a backup import brings in the menu texts only (switch, code, highlight and unsafe links untouched)
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo_menulink.e2e.js
const path = require('path');
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {ok, sql, one} = H;
// ---- part 2: backup import (back-office-dev's imp.e2e.js). The menu-link fields go back to the
// shop's starting values first (part 1 changed them), as on the fresh database it was written for.
async function part2(){
  sql(`update settings set menu_public = false, public_code = 'cccc', menu_highlight_recipe_id = null, public_instagram_url = null`);
  const b = await chromium.launch(); const p = await b.newPage(); const errors = []; H.attach(p, errors, 'BO');
  await H.boLogin(p);
  const res = await p.evaluate(async () => {
    const payload = {format: 'cccc-backup', exported_at: nowISO(), business: state.business, data: {recipe_ingredients: [], inventory_transactions: [],
      settings: {business_name: 'Cavite City Coffee Club', public_address: 'From backup', public_hours: 'Daily 7–9',
        public_facebook_url: 'https://fb.me/cccc', public_instagram_url: 'https://evil.com/x', menu_public: true, public_code: 'other', menu_highlight_label: 'Try me',
        menu_highlight_recipe_id: '33333333-0000-0000-0000-000000000003'}}};
    const r = await runImport(payload, {includeSettings: true});
    return r.notes;
  });
  console.log(res);
  const s = one(`select * from settings`);
  ok(s.public_address === 'From backup' && s.public_hours === 'Daily 7–9' && s.public_facebook_url === 'https://fb.me/cccc' && s.menu_highlight_label === 'Try me', 'menu text imported', s);
  ok(s.public_instagram_url === null && s.menu_public === false && s.public_code === 'cccc' && s.menu_highlight_recipe_id === null, 'switch / code / highlight / bad url untouched');
  ok(!errors.length, 'no errors', errors);
  await b.close();
}

const SH = path.join(H.SHOTS, 'bo141') + '/'; require('fs').mkdirSync(SH, {recursive: true});
const NAME = 'bo_menulink.e2e';
const XSS = '9141aaaa-0000-0000-0000-000000000001', HIDDEN = '9141aaaa-0000-0000-0000-000000000002';
(async () => {
  const biz = sql(`select id from businesses limit 1`);
  sql(`update settings set business_address = '12 P. Burgos Ave, Cavite City' where business_id = '${biz}'`);
  sql(`insert into recipes(id, business_id, name, recipe_type, selling_price, active, pos_visible, qr_visible) values
     ('${XSS}','${biz}','<img src=x onerror=alert(1)>Mocha','DRINKS',140,true,true,true),
     ('${HIDDEN}','${biz}','Hidden cake','PASTRY',90,true,true,false) on conflict do nothing`);
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({viewport: {width: 1280, height: 900}, permissions: ['clipboard-read', 'clipboard-write']});
  const p = await ctx.newPage();
  H.attach(p, errors, 'BO');
  await H.boLogin(p);
  await p.evaluate(() => navigate('settings'));
  await p.click('[data-tab="menu"]');
  await p.waitForSelector('#ml-card');
  ok(await p.inputValue('#ml-link') === 'https://zdboi.github.io/coffee-shop-system/menu/', 'cccc code gives the short link');
  ok(!(await p.isChecked('#ml-on')), 'switch off by default');
  await H.shot(p, 'x'); await p.screenshot({path: SH + 'ml-1280-initial.png', fullPage: true});
  // copy
  await p.click('#ml-copy');
  ok(await H.until(async () => (await p.evaluate(() => navigator.clipboard.readText())) === 'https://zdboi.github.io/coffee-shop-system/menu/', 3000), 'copy puts the link on the clipboard');
  // receipt address
  await p.click('#ml-use-address');
  ok(await p.inputValue('#ml-address') === '12 P. Burgos Ave, Cavite City', 'receipt address prefilled');
  await p.fill('#ml-hours', 'Mon–Fri 7am–9pm\nSat–Sun 8am–10pm');
  await p.fill('#ml-map', 'maps.app.goo.gl/abc123');
  await p.fill('#ml-fb', 'http://www.facebook.com/cccc');
  await p.fill('#ml-ig', 'https://www.instagram.com/cccc');
  // picker: hidden item not offered, XSS name escaped
  await p.fill('#ml-search', 'cake');
  ok(await p.textContent('#ml-results').then(t => /No item matches/.test(t)), 'hidden item is not offered');
  await p.fill('#ml-search', 'moch');
  ok(await p.$$eval('#ml-results [data-pick]', b => b.length) === 1 && !(await p.$('#ml-results img')), 'XSS item listed as text');
  await p.fill('#ml-search', 'lat');
  await p.click('#ml-results [data-pick]');
  ok(/Iced Latte/.test(await p.textContent('#ml-pick-box')), 'Iced Latte picked');
  await p.fill('#ml-blurb', 'Our house latte, over ice.');
  await p.click('#ml-card .switch');
  ok(/Will be on/.test(await p.textContent('#ml-status')), 'status says unsaved');
  await p.screenshot({path: SH + 'ml-1280-filled.png', fullPage: true});
  await p.click('#ml-save');
  await H.until(async () => /link is on/.test(await p.textContent('#toast-wrap')), 5000);
  let s = one(`select * from settings where business_id='${biz}'`);
  ok(s.menu_public === true && s.public_code === 'cccc', 'saved on', s.menu_public);
  ok(s.public_map_url === 'https://maps.app.goo.gl/abc123' && s.public_facebook_url === 'https://www.facebook.com/cccc', 'urls tidied', [s.public_map_url, s.public_facebook_url]);
  ok(s.public_hours === 'Mon–Fri 7am–9pm\nSat–Sun 8am–10pm', 'hours multi-line kept', s.public_hours);
  ok(s.menu_highlight_recipe_id === '33333333-0000-0000-0000-000000000001' && s.menu_highlight_label === null && s.menu_highlight_blurb === 'Our house latte, over ice.', 'highlight saved');
  ok(Number(sql(`select count(*) from audit_log where action='Menu link saved'`)) === 1, 'audit written');
  const pm = JSON.parse(sql(`select public_menu('cccc')`));
  ok(pm.highlight && pm.highlight.name === 'Iced Latte' && pm.highlight.label === "Today's pick", 'public_menu shows highlight', pm.highlight);
  // other settings save doesn't wipe menu link
  await p.click('[data-tab="general"]'); await p.click('#save-general');
  await H.sleep(1500);
  ok(one(`select menu_public from settings`).menu_public === true, 'general save keeps the menu link');
  // client-side refusal: bad facebook
  await p.click('[data-tab="menu"]'); await p.waitForSelector('#ml-card');
  ok(await p.isChecked('#ml-on') && /On: anyone/.test(await p.textContent('#ml-status')), 'reload shows on');
  await p.fill('#ml-fb', 'https://evil.example.com/x');
  await p.click('#ml-save');
  ok(await H.until(async () => /facebook\.com/.test(await p.textContent('#toast-wrap')), 3000), 'bad facebook refused with plain words');
  await p.fill('#ml-fb', 'https://www.facebook.com/cccc');
  // server error mapping (bypassing the screen)
  const mapped = await p.evaluate(async () => {
    const out = {};
    for(const [k, v] of [['public_instagram_url', 'https://instagr.am/x'], ['public_code', '-bad'], ['public_address', 'a\u0001b'], ['menu_highlight_label', 'x'.repeat(31)], ['menu_highlight_recipe_id', '9141aaaa-0000-0000-0000-000000000002']]){
      try{ await applyChanges([Ops.update('settings', {[k]: v})]); out[k] = 'saved?'; }catch(e){ out[k] = menuFriendlyError(e); }
    }
    return out;
  });
  console.log(mapped);
  ok(Object.values(mapped).every(t => !/^[A-Z_]+$/.test(t) && t !== 'saved?'), 'server codes mapped to plain words');
  // code change with confirm
  await p.click('#ml-adv summary');
  await p.fill('#ml-code', 'My-Shop');
  await p.click('#ml-save');
  await p.waitForSelector('[data-ok]');
  ok(/stop working/.test(await p.textContent('.modal-body')), 'code change warns');
  await p.screenshot({path: SH + 'ml-1280-confirm.png'});
  await p.click('[data-ok]');
  await H.until(async () => one(`select public_code from settings`).public_code === 'my-shop', 5000);
  await p.waitForSelector('#ml-link');
  await H.until(async () => (await p.inputValue('#ml-link')).includes('?shop=my-shop'), 5000);
  ok(await p.inputValue('#ml-link') === 'https://zdboi.github.io/coffee-shop-system/cccc/menu/?shop=my-shop', 'link uses ?shop=', await p.inputValue('#ml-link'));
  // highlight hidden later: warning shown, save still works
  sql(`update recipes set qr_visible=false where id='33333333-0000-0000-0000-000000000001'`);
  await p.evaluate(() => boLoad().then(() => renderSettings()));
  await p.waitForSelector('.ml-pick-warn');
  await p.screenshot({path: SH + 'ml-1280-hidden.png', fullPage: true});
  await p.fill('#ml-label', 'Bestseller');
  await p.click('#ml-save');
  await H.until(async () => one(`select menu_highlight_label from settings`).menu_highlight_label === 'Bestseller', 5000);
  ok(one(`select menu_highlight_label from settings`).menu_highlight_label === 'Bestseller', 'save works with hidden highlight');
  sql(`update recipes set qr_visible=true where id='33333333-0000-0000-0000-000000000001'`);
  // clear
  await p.evaluate(() => boLoad().then(() => renderSettings()));
  await p.click('#ml-clear'); await p.click('#ml-save');
  await H.until(async () => one(`select menu_highlight_recipe_id from settings`).menu_highlight_recipe_id === null, 5000);
  ok(one(`select menu_highlight_recipe_id from settings`).menu_highlight_recipe_id === null, 'clear removes the highlight');
  // switch on with no code -> client message
  await p.click('#ml-adv summary').catch(() => {});
  await p.evaluate(() => { document.getElementById('ml-adv').open = true; });
  await p.fill('#ml-code', '');
  await p.click('#ml-save');
  ok(await H.until(async () => /needs a shop code/.test(await p.textContent('#toast-wrap')), 3000), 'on without code refused');
  // import mapping
  const imp = await p.evaluate(() => menuImportValues({public_address: 'A', public_hours: 'x'.repeat(301), public_map_url: 'javascript:alert(1)', public_facebook_url: 'https://fb.me/x', public_instagram_url: 'https://evil.com', menu_public: true, public_code: 'zzz', menu_highlight_label: 'Hi', menu_highlight_recipe_id: 'x'}));
  ok(JSON.stringify(imp) === JSON.stringify({public_address: 'A', public_facebook_url: 'https://fb.me/x', menu_highlight_label: 'Hi'}), 'import keeps only safe text', imp);
  // 768
  await p.setViewportSize({width: 768, height: 1000});
  await p.evaluate(() => renderSettings());
  await p.screenshot({path: SH + 'ml-768.png', fullPage: true});
  await p.setViewportSize({width: 390, height: 844});
  await p.evaluate(() => renderSettings());
  await p.screenshot({path: SH + 'ml-390.png', fullPage: true});
  ok(errors.filter(e => !/HTTP 4\d\d POST \/rest\/v1\/rpc\/apply_changes|save failed|menu link save failed/.test(e)).length === 0, 'no browser errors', errors);
  await browser.close();
  await part2();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
