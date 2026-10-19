// Optional CAPTCHA (Cloudflare Turnstile, CLAUDE.md decision 10) in all three apps.
// Adopted + merged from the developers' hand checks (counter, QR page, Back Office), 2026-10-20.
//
//   A. Key empty (the shipped default): no request to challenges.cloudflare.com anywhere and no
//      gotrue_meta_security in any auth body (counter pairing, QR first visit, Back Office
//      sign-in / forgot password / sign-up).
//   B. Key set, counter pairing (#su-captcha); C. QR page first sign-in (#w-captcha-box);
//   D. Back Office sign-in / forgot / sign-up (#li-captcha / #fp-captcha / #su-captcha). Each:
//      blocked script -> no-connection message; widget failure -> plain message, typed input kept,
//      nothing sent; server refusal (error_code captcha_failed) -> plain message; "Try again" /
//      sending again works; a fresh token for every attempt; the token reaches the auth body;
//      no Turnstile load after sign-in, while selling / ordering, or on other screens.
//
// How the key is turned on: /cccc/shared/config.js is fulfilled with CAPTCHA_SITE_KEY added,
// service workers are blocked in the context, and challenges.cloudflare.com is never reached:
// every request to it is answered by a fake turnstile.render (mode per page: window.__tsMode =
// 'ok' | 'fail' | 'hang') or aborted (st.cfMode = 'abort', i.e. the script is blocked).
//
// Needs:  tests/e2e_reset.sh [db]  then  tests/restart_fake.sh [port] [db]
// Run:    node tests/e2e/captcha.e2e.js            (QA: 8787 / cccc)
//         FAKE_PORT=8792 FAKE_DB=db_qr node tests/e2e/captcha.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const NAME = 'captcha.e2e';
const KEY = '1x00000000000000000000AA';          // Cloudflare's public "always passes" test site key
const QR_URL = H.BASE + '/cccc/order/?t=tabletoken5';
const PERSON = /confirm you're a person/;

// Fake Turnstile: each render gives a new token ("tok-<n>-<random>") unless the page set
// window.__tsMode to 'fail' (error-callback) or 'hang' (never answers).
const STUB = `(function(){ let n = 0;
  window.turnstile = {
    render(el, o){ n++; const m = window.__tsMode || 'ok';
      const w = document.createElement('div'); w.className = 'fake-turnstile'; w.textContent = 'fake check ' + n; el.appendChild(w);
      setTimeout(() => { if(m === 'ok') o.callback('tok-' + n + '-' + Math.random().toString(36).slice(2, 8));
                         else if(m === 'fail') o['error-callback']('300030'); }, 60);
      return 'w' + n; },
    remove(){ document.querySelectorAll('.fake-turnstile').forEach(x => x.remove()); } }; })();`;

const errors = [];
const capTok = (a) => (a && a.body && a.body.gotrue_meta_security && a.body.gotrue_meta_security.captcha_token) || null;

// One browser context = one device. key: '' = shipped default, otherwise the fake site key.
async function device(browser, key, opts){
  const ctx = await browser.newContext(Object.assign({viewport: {width: 1280, height: 900}, serviceWorkers: 'block'}, opts || {}));
  const st = {cf: [], cfMode: 'stub', auth: [], outside: []};
  await ctx.route('**/cccc/shared/config.js', async r => {
    const res = await r.fetch();
    const body = (await res.text()) + `\nwindow.CCCC_CONFIG.CAPTCHA_SITE_KEY = ${JSON.stringify(key)};`;
    r.fulfill({response: res, body, headers: Object.assign({}, res.headers(), {'cache-control': 'no-store'})});
  });
  await ctx.route(/^https?:\/\/challenges\.cloudflare\.com\//, r => {
    st.cf.push(r.request().url());
    if(st.cfMode === 'abort') return r.abort('internetdisconnected');
    r.fulfill({status: 200, contentType: 'application/javascript', body: STUB});
  });
  ctx.on('request', q => {
    const u = q.url();
    if(!/^https?:\/\/localhost[:/]/.test(u) && !/^(data|blob):/.test(u) && !/fonts\.(googleapis|gstatic)\.com|challenges\.cloudflare\.com/.test(u)) st.outside.push(u);
    const m = /\/auth\/v1\/(signup|token|recover)/.exec(u);
    if(!m || q.method() !== 'POST') return;
    let body = {}; try{ body = JSON.parse(q.postData() || '{}'); }catch(e){}
    const grant = (/grant_type=([a-z_]+)/.exec(u) || [])[1] || null;
    if(grant === 'refresh_token') return;
    st.auth.push({path: m[1], grant, email: body.email || null, body});
  });
  return {ctx, st};
}
const scriptTags = (page) => page.$$eval('script[src*="challenges.cloudflare.com"]', e => e.length);
const setMode = (page, m) => page.evaluate(m => { window.__tsMode = m; }, m);
// Answer the next request to an auth endpoint with Supabase's CAPTCHA refusal (once).
async function refuseOnce(page, glob){
  await page.route(glob, r => r.fulfill({status: 400, contentType: 'application/json',
    body: JSON.stringify({code: 400, error_code: 'captcha_failed', msg: 'captcha protection: request disallowed (timeout-or-duplicate)'})}), {times: 1});
}

(async () => {
  const browser = await chromium.launch();
  try{
    const BIZ = H.sql(`select business_id from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'`);
    H.sql(`insert into public.device_pairing_codes(code, business_id, device_name, expires_at) values ('CAPFO1', '${BIZ}', 'Captcha Counter', now() + interval '1 day') on conflict do nothing`);

    /* =============================== A. key empty =============================== */
    console.log('-- A. key empty (default): nothing changes');
    {
      // A1 counter pairing
      const {ctx, st} = await device(browser, '');
      const page = await ctx.newPage(); H.attach(page, errors, 'A-FO');
      await H.pairCounter(page, 'TESTAB');
      H.ok(!(await page.evaluate(() => Captcha.enabled())), 'counter: Captcha.enabled() is false with the key empty');
      const su = st.auth.filter(a => a.path === 'signup');
      H.ok(su.length === 1 && !('gotrue_meta_security' in su[0].body) && JSON.stringify(su[0].body) === '{"data":{}}', 'counter: pairing sign-up body unchanged ({"data":{}})', su);
      await H.typePin(page, '1111');
      await H.startShift(page, 1000);
      H.ok(st.cf.length === 0 && (await scriptTags(page)) === 0, 'counter: no Turnstile request or script tag', st.cf);
      await ctx.close();
    }
    {
      // A2 QR page first visit + register
      const {ctx, st} = await device(browser, '', {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
      const page = await ctx.newPage(); H.attach(page, errors, 'A-QR');
      await page.goto(QR_URL);
      await page.waitForSelector('#w-name', {timeout: 15000});
      await H.until(() => st.auth.some(a => a.path === 'signup'), 5000);
      H.ok(await page.$eval('#w-captcha', e => e.hidden), 'QR: no CAPTCHA area on the welcome screen');
      await page.fill('#w-name', 'Ana'); await page.check('#w-consent');
      await page.click('#w-go');
      H.ok(await H.until(() => page.isVisible('.member-name'), 10000), 'QR: registered straight away (member card)');
      const su = st.auth.filter(a => a.path === 'signup');
      H.ok(su.length === 1 && !('gotrue_meta_security' in su[0].body), 'QR: one anonymous sign-up, no gotrue_meta_security', su);
      H.ok(st.cf.length === 0 && (await scriptTags(page)) === 0, 'QR: no Turnstile request or script tag', st.cf);
      await ctx.close();
    }
    {
      // A3 Back Office: forgot password, sign-up (answered by the test, no shop created), sign-in
      const {ctx, st} = await device(browser, '');
      const page = await ctx.newPage(); H.attach(page, errors, 'A-BO');
      await page.goto(H.BASE + '/cccc/back/');
      await page.waitForSelector('#li-email', {timeout: 15000});
      H.ok(!(await page.evaluate(() => Captcha.enabled())), 'Back Office: Captcha.enabled() is false');
      H.ok(await page.$eval('#li-captcha', e => e.childElementCount === 0 && getComputedStyle(e).display === 'none'), 'Back Office: sign-in CAPTCHA box empty and hidden');
      await page.click('[data-view=forgot]');
      await H.focusSettled(page, 'fp-email');
      await page.fill('#fp-email', 'owner@example.com');
      await page.click('#f-forgot button[type=submit]');
      await H.must(async () => /reset link/.test(await page.textContent('#auth-msg')), 'reset-link message');
      await page.click('#f-forgot [data-view=login], [data-view=login]');
      await page.click('[data-view=signup]');
      await H.focusSettled(page, 'su-biz');
      await page.fill('#su-biz', 'No Key Shop'); await page.fill('#su-name', 'Nok'); await page.fill('#su-email', 'nokey@example.com'); await page.fill('#su-pass', 'secret123');
      await page.route('**/auth/v1/signup', r => r.fulfill({contentType: 'application/json', body: JSON.stringify({id: 'x', email: 'nokey@example.com'})}), {times: 1});
      await page.click('#f-signup button[type=submit]');
      await page.waitForSelector('#f-login', {timeout: 10000});
      await H.focusSettled(page, 'li-email');
      await page.fill('#li-email', 'owner@example.com'); await page.fill('#li-pass', 'secret123');
      await page.click('#f-login button[type=submit]');
      await page.waitForSelector('#app', {state: 'visible', timeout: 20000});
      const by = (p) => st.auth.filter(a => a.path === p && (p !== 'token' || a.grant === 'password'));
      H.ok(by('recover').length === 1 && JSON.stringify(by('recover')[0].body) === '{"email":"owner@example.com"}', 'Back Office: forgot-password body unchanged', by('recover'));
      H.ok(by('signup').length === 1 && !('gotrue_meta_security' in by('signup')[0].body), 'Back Office: sign-up body has no gotrue_meta_security', by('signup'));
      H.ok(by('token').length === 1 && JSON.stringify(by('token')[0].body) === '{"email":"owner@example.com","password":"secret123"}', 'Back Office: sign-in body unchanged', by('token').map(a => Object.keys(a.body)));
      H.ok(st.cf.length === 0 && (await scriptTags(page)) === 0, 'Back Office: no Turnstile request or script tag', st.cf);
      H.ok(st.outside.length === 0, 'key empty: no request to any outside site (fonts aside)', st.outside);
      await ctx.close();
    }

    /* =============================== B. counter pairing, key set =============================== */
    console.log('-- B. counter pairing with the key set');
    {
      const {ctx, st} = await device(browser, KEY);
      const page = await ctx.newPage(); const net = H.attach(page, errors, 'B-FO');
      const signups = () => st.auth.filter(a => a.path === 'signup');
      const errText = () => page.textContent('#su-error');
      const waitErr = async (re, what) => H.until(async () => re.test(await errText()) && !(await page.$eval('#su-pair', b => b.disabled)), 10000) || console.log('   (waited for ' + what + ')');
      await page.goto(H.BASE + '/cccc/front/');
      await page.waitForSelector('#su-code', {timeout: 15000});
      H.ok(await page.evaluate(() => Captcha.enabled()), 'counter: Captcha.enabled() true with the key set');
      H.ok(st.cf.length === 0, 'counter: opening the set-up screen loads nothing from Cloudflare', st.cf);
      H.ok((await page.$eval('#su-captcha', e => getComputedStyle(e).display)) === 'none', 'counter: CAPTCHA box hidden while empty');

      // 1. script blocked
      st.cfMode = 'abort';
      await page.fill('#su-code', 'capfo1');
      await page.click('#su-pair');
      await waitErr(/internet/i, 'no-connection message');
      const t1 = await errText();
      H.ok(/internet/i.test(t1) && !PERSON.test(t1), 'counter: blocked script -> no-connection message', t1);
      H.ok((await page.inputValue('#su-code')) === 'capfo1', 'counter: typed code kept (blocked script)');
      H.ok(signups().length === 0 && st.cf.length === 1, 'counter: script tried once, no sign-up sent', {cf: st.cf.length, su: signups().length});
      H.ok((await scriptTags(page)) === 0, 'counter: the failed script tag is removed (next try loads again)');

      // 2. widget failure
      st.cfMode = 'stub'; await setMode(page, 'fail');
      await page.click('#su-pair');
      await waitErr(PERSON, 'CAPTCHA failure message');
      H.ok(PERSON.test(await errText()), 'counter: failed check -> "We couldn\'t confirm you\'re a person…"', await errText());
      H.ok((await page.inputValue('#su-code')) === 'capfo1' && (await page.textContent('#su-pair')).trim() === 'Pair this counter', 'counter: code kept, button back to "Pair this counter"');
      H.ok(signups().length === 0, 'counter: nothing sent when the check failed', signups());
      H.ok(await page.$eval('#su-captcha', e => e.childElementCount === 0), 'counter: widget removed after the failure');

      // 3. server refuses the token
      await setMode(page, 'ok');
      net.allow(/\/auth\/v1\/signup/);
      await refuseOnce(page, '**/auth/v1/signup');
      await page.click('#su-pair');
      await H.until(() => signups().length === 1, 10000);
      await waitErr(PERSON, 'server refusal message');
      H.ok(PERSON.test(await errText()), 'counter: server "captcha_failed" -> the same plain message', await errText());
      H.ok((await page.inputValue('#su-code')) === 'capfo1', 'counter: code kept (server refusal)');
      H.ok(H.num(`select count(*) from public.devices where device_name = 'Captcha Counter'`) === 0, 'counter: not paired after the refusal');
      net.disallow();

      // 4. try again -> fresh token, paired
      await page.click('#su-pair');
      await page.waitForSelector('#pin-gate', {state: 'visible', timeout: 20000});
      const toks = signups().map(capTok);
      H.ok(toks.length === 2 && toks.every(t => /^tok-/.test(t || '')), 'counter: the token reaches the sign-up body (gotrue_meta_security.captcha_token)', toks);
      H.ok(toks[0] !== toks[1], 'counter: a fresh token for each attempt', toks);
      H.ok(H.num(`select count(*) from public.devices where device_name = 'Captcha Counter'`) === 1, 'counter: paired on "try again"');

      // 5. after pairing: PIN sign-in, sale, lock, reload -> no Turnstile
      const cf0 = st.cf.length, su0 = signups().length;
      await H.typePin(page, '1111');
      await H.startShift(page, 2000);
      await page.click('.pos-product-card:has-text("Ensaymada")');
      await page.click('#checkout-btn');
      await page.click('[data-quick]');
      await page.click('#complete-sale-btn');
      H.ok(await H.until(() => H.num(`select count(*) from public.sales s join public.devices d on d.id = s.device_id where d.device_name = 'Captcha Counter' and s.status = 'COMPLETED'`) === 1, 15000)
        || await H.until(() => H.num(`select count(*) from public.sales where status = 'COMPLETED' and grand_total = 65`) >= 1, 3000), 'counter: sale uploaded');
      await page.reload();
      await page.waitForSelector('.pos-product-card, #pin-gate', {timeout: 15000});
      await H.sleep(1500);
      if(await page.isVisible('#pin-gate')){ await H.typePin(page, '1111'); await page.waitForSelector('.pos-product-card', {timeout: 15000}); }
      H.ok(st.cf.length === cf0 && (await scriptTags(page)) === 0, 'counter: no Turnstile after pairing (PIN sign-in, sale, reload)', st.cf.slice(cf0));
      H.ok(signups().length === su0, 'counter: no further anonymous sign-ups', signups().length);
      await H.shot(page, 'captcha-fo-after');
      await ctx.close();
    }

    /* =============================== C. QR page, key set =============================== */
    console.log('-- C. QR page first sign-in with the key set');
    {
      const {ctx, st} = await device(browser, KEY, {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
      const page = await ctx.newPage(); const net = H.attach(page, errors, 'C-QR');
      const signups = () => st.auth.filter(a => a.path === 'signup');
      const alertText = async () => { const a = await page.$('#w-captcha-fail .inline-alert'); return a ? (await a.textContent()).trim() : ''; };
      const retry = async () => { await page.click('#w-captcha-retry'); };

      // 1. script blocked on the first visit
      st.cfMode = 'abort';
      await page.goto(QR_URL);
      await page.waitForSelector('#w-name', {timeout: 15000});
      H.ok(await H.until(async () => /internet/i.test(await alertText()), 10000), 'QR: blocked script -> no-connection message + Try again', await alertText());
      H.ok(/^No connection\. Check your internet and try again\./.test(await alertText()) && await page.isVisible('#w-captcha-retry'), 'QR: exact no-connection wording, "Try again" button shown', await alertText());
      H.ok(signups().length === 0, 'QR: no sign-up sent with the script blocked');
      await page.fill('#w-name', 'Bea'); await page.fill('#w-phone', '0917 555 0101'); await page.check('#w-consent');
      await page.click('#w-go');
      await H.sleep(300);
      H.ok((await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'w-captcha-retry', 'QR: "Start ordering" while failed moves focus to "Try again"');
      H.ok(H.num(`select count(*) from public.customers where nickname = 'Bea'`) === 0 && !(await page.$eval('#w-go', b => b.disabled)), 'QR: nothing registered, button usable');

      // 2. widget failure on "Try again"
      st.cfMode = 'stub'; await setMode(page, 'fail');
      await retry();
      H.ok(await H.until(async () => PERSON.test(await alertText()), 10000), 'QR: failed check -> "We couldn\'t confirm you\'re a person…"', await alertText());
      H.ok(signups().length === 0, 'QR: nothing sent when the check failed');

      // 3. server refuses the token
      await setMode(page, 'ok');
      net.allow(/\/auth\/v1\/signup/);
      await refuseOnce(page, '**/auth/v1/signup');
      await retry();
      await H.until(() => signups().length === 1, 10000);
      H.ok(await H.until(async () => PERSON.test(await alertText()), 10000), 'QR: server "captcha_failed" -> the same plain message', await alertText());
      net.disallow();

      // 4. try again -> signed in with a fresh token
      await retry();
      H.ok(await H.until(async () => (await alertText()) === '' && await page.$eval('#w-captcha', e => e.hidden), 10000), 'QR: "Try again" works: message gone, CAPTCHA area hidden');
      await H.until(() => signups().length === 2, 5000);
      const toks = signups().map(capTok);
      H.ok(toks.length === 2 && toks.every(t => /^tok-/.test(t || '')), 'QR: the token reaches the sign-up body', toks);
      H.ok(toks[0] !== toks[1], 'QR: a fresh token for each attempt', toks);
      H.ok((await page.inputValue('#w-name')) === 'Bea' && (await page.inputValue('#w-phone')) === '0917 555 0101' && await page.isChecked('#w-consent'), 'QR: typed name, number and consent kept through all failures');
      await page.click('#w-go');
      H.ok(await H.until(() => page.isVisible('.member-name'), 10000), 'QR: registered after the check passed');
      H.ok(H.num(`select count(*) from public.customers where nickname = 'Bea'`) === 1, 'QR: one customer "Bea" in the database');
      await H.shot(page, 'captcha-qr-registered');

      // 5. ordering + reload: no Turnstile
      const cf0 = st.cf.length, su0 = signups().length;
      await page.click('.item[data-item="33333333-0000-0000-0000-000000000004"]');
      await page.waitForSelector('#it-add', {timeout: 5000});
      await page.click('#it-add');
      await page.waitForSelector('#view-cart', {timeout: 5000});
      await page.click('#view-cart');
      await page.waitForSelector('#c-place', {timeout: 5000});
      await page.click('#c-place');
      H.ok(await H.until(() => page.isVisible('.ticket-no'), 10000), 'QR: order placed');
      await page.reload();
      await H.until(() => page.isVisible('.ticket-no'), 10000);
      await H.sleep(1000);
      H.ok(st.cf.length === cf0 && (await scriptTags(page)) === 0, 'QR: no Turnstile while ordering or after a reload', st.cf.slice(cf0));
      H.ok(signups().length === su0, 'QR: no further sign-ups (same phone login)', signups().length);

      // 6. "Not Bea?" -> a new sign-in on this phone gets its own fresh token
      await page.goto(QR_URL + '&view=menu');
      await page.waitForSelector('#not-me', {timeout: 10000});
      await page.click('#not-me');
      await page.click('#nm-go');
      await page.waitForSelector('#w-name', {timeout: 10000});
      await H.until(() => signups().length === su0 + 1, 10000);
      const t3 = capTok(signups()[su0]);
      H.ok(/^tok-/.test(t3 || '') && !toks.includes(t3), '"Not me?": the new sign-in carries its own fresh token', t3);
      H.ok(await H.until(async () => await page.$eval('#w-captcha', e => e.hidden), 5000), '"Not me?": check passed, no message');
      await ctx.close();
    }

    /* =============================== D. Back Office, key set =============================== */
    console.log('-- D. Back Office sign-in / forgot password / sign-up with the key set');
    {
      const {ctx, st} = await device(browser, KEY);
      const page = await ctx.newPage(); const net = H.attach(page, errors, 'D-BO');
      const by = (p) => st.auth.filter(a => a.path === p && (p !== 'token' || a.grant === 'password'));
      const msg = async () => (await page.textContent('#auth-msg')).trim();
      const waitMsg = (re) => H.until(async () => re.test(await msg()) && (await page.$$('#auth-screen button[type=submit][disabled]')).length === 0, 10000);
      const fillLogin = async () => { await page.fill('#li-email', 'owner@example.com'); await page.fill('#li-pass', 'secret123'); };
      const loginKept = async () => (await page.inputValue('#li-email')) === 'owner@example.com' && (await page.inputValue('#li-pass')) === 'secret123';

      await page.goto(H.BASE + '/cccc/back/');
      await page.waitForSelector('#li-email', {timeout: 15000});
      await H.focusSettled(page, 'li-email');
      H.ok(st.cf.length === 0, 'Back Office: the sign-in screen alone loads nothing from Cloudflare', st.cf);

      // 1. sign-in, script blocked
      st.cfMode = 'abort';
      await fillLogin();
      await page.click('#f-login button[type=submit]');
      H.ok(await waitMsg(/internet/i), 'Back Office: blocked script -> no-connection message', await msg());
      H.ok(!PERSON.test(await msg()) && await page.$eval('#auth-msg', e => e.classList.contains('err')), 'Back Office: shown as an error, not the "person" text', await msg());
      H.ok(await loginKept() && by('token').length === 0, 'Back Office: email + password kept, nothing sent');

      // 2. sign-in, widget failure
      st.cfMode = 'stub'; await setMode(page, 'fail');
      await page.click('#f-login button[type=submit]');
      H.ok(await waitMsg(PERSON), 'Back Office sign-in: failed check -> "We couldn\'t confirm you\'re a person…"', await msg());
      H.ok(await loginKept() && by('token').length === 0, 'Back Office sign-in: typed text kept, nothing sent');
      H.ok(await page.$eval('#li-captcha', e => e.childElementCount === 0), 'Back Office: widget removed after the failure');

      // 3. sign-in, server refuses the token
      await setMode(page, 'ok');
      net.allow(/\/auth\/v1\/token/);
      await refuseOnce(page, '**/auth/v1/token?grant_type=password');
      await page.click('#f-login button[type=submit]');
      H.ok(await waitMsg(PERSON), 'Back Office sign-in: server "captcha_failed" -> the same plain message', await msg());
      H.ok(by('token').length === 1 && /^tok-/.test(capTok(by('token')[0]) || '') && await loginKept(), 'Back Office sign-in: refused attempt carried a token; typed text kept');
      net.disallow();

      // 4. forgot password: failure, then two sends with fresh tokens
      await page.click('[data-view=forgot]');
      await page.waitForSelector('#fp-email');
      H.ok((await page.inputValue('#fp-email')) === 'owner@example.com', 'forgot password: email carried over');
      await setMode(page, 'fail');
      await page.click('#f-forgot button[type=submit]');
      H.ok(await waitMsg(PERSON) && by('recover').length === 0, 'forgot password: failed check -> plain message, nothing sent', await msg());
      await setMode(page, 'ok');
      await page.click('#f-forgot button[type=submit]');
      H.ok(await waitMsg(/reset link/), 'forgot password: "Try again" (send again) works');
      await page.click('#f-forgot button[type=submit]');
      await H.until(() => by('recover').length === 2, 10000); await waitMsg(/reset link/);
      const rt = by('recover').map(capTok);
      H.ok(rt.length === 2 && rt.every(t => /^tok-/.test(t || '')) && rt[0] !== rt[1], 'forgot password: token in each request, fresh each time', rt);
      net.allow(/\/auth\/v1\/recover/);
      await refuseOnce(page, '**/auth/v1/recover**');
      await page.click('#f-forgot button[type=submit]');
      H.ok(await waitMsg(PERSON), 'forgot password: server "captcha_failed" -> plain message', await msg());
      net.disallow();

      // 5. sign-up: failure keeps the fields; then the token reaches /signup (answered by the test)
      await page.click('[data-view=login]');
      await page.click('[data-view=signup]');
      await H.focusSettled(page, 'su-biz');
      const em = 'cap' + Date.now() + '@example.com';
      await page.fill('#su-biz', 'Cap Test Shop'); await page.fill('#su-name', 'Cap'); await page.fill('#su-email', em); await page.fill('#su-pass', 'secret123');
      await setMode(page, 'fail');
      await page.click('#f-signup button[type=submit]');
      H.ok(await waitMsg(PERSON), 'sign-up: failed check -> plain message', await msg());
      H.ok((await page.inputValue('#su-biz')) === 'Cap Test Shop' && (await page.inputValue('#su-name')) === 'Cap' && (await page.inputValue('#su-email')) === em && (await page.inputValue('#su-pass')) === 'secret123' && by('signup').length === 0,
        'sign-up: all four fields kept, nothing sent');
      await setMode(page, 'ok');
      await page.route('**/auth/v1/signup', r => r.fulfill({contentType: 'application/json', body: JSON.stringify({id: 'x', email: em})}), {times: 1});
      await page.click('#f-signup button[type=submit]');
      await page.waitForSelector('#f-login', {timeout: 10000});
      const st1 = by('signup').map(capTok);
      H.ok(st1.length === 1 && /^tok-/.test(st1[0] || ''), 'sign-up: the token reaches the sign-up body', st1);
      H.ok(H.num(`select count(*) from auth.users where email = '${em}'`) === 0, 'sign-up: (test answered the request, no shop created)');

      // 6. sign-in succeeds with a fresh token
      await H.focusSettled(page, 'li-email');
      await fillLogin();
      await page.click('#f-login button[type=submit]');
      await page.waitForSelector('#app', {state: 'visible', timeout: 20000});
      const lt = by('token').map(capTok);
      H.ok(lt.length === 2 && /^tok-/.test(lt[1] || '') && lt[1] !== lt[0], 'sign-in: the token reaches the password sign-in, fresh after the refused one', lt);
      const all = [...lt, ...rt, ...st1, ...by('recover').slice(2).map(capTok)];
      H.ok(new Set(all).size === all.length, 'Back Office: every attempt used a different token', all);

      // 7. signed in: every screen, then a reload -> no Turnstile
      const cf0 = st.cf.length;
      const walk = async () => {
        const routes = await page.$$eval('[data-route]', els => [...new Set(els.map(e => e.dataset.route))]);
        for(const r of routes){ const el = await page.$(`[data-route="${r}"]`); if(el && await el.isVisible()){ await el.click(); await H.sleep(350); } }
        return routes;
      };
      const routes = await walk();
      await page.reload();
      await page.waitForSelector('#app', {state: 'visible', timeout: 20000});
      await walk();
      H.ok(routes.length >= 5 && st.cf.length === cf0 && (await scriptTags(page)) === 0, `Back Office: no Turnstile on other screens or after a reload (${routes.length} screens: ${routes.join(', ')})`, st.cf.slice(cf0));
      H.ok(by('token').length === 2 && by('signup').length === 1, 'Back Office: no extra sign-in requests after signing in', st.auth.map(a => a.path + (a.grant ? ':' + a.grant : '')));
      H.ok(st.outside.length === 0, 'key set: no request to any outside site except the (stubbed) Turnstile', st.outside);
      await ctx.close();
    }

    H.ok(errors.length === 0, 'no browser errors', errors);
  }catch(e){ await browser.close(); H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})();
