// Unit checks (node, no browser, no database) for the optional CAPTCHA (CLAUDE.md decision 10):
//   cccc/shared/captcha.js  Captcha.enabled() / Captcha.getToken(box, {timeoutMs}):
//     key empty or blank -> off, nothing loaded, token null; key set -> Turnstile script URL,
//     rendered with the site key, widget removed, script loaded once; widget error / timeout ->
//     CAPTCHA_FAILED; script that cannot load -> offline.
//   cccc/shared/cloud.js  signInAnonymously / signInWithPassword / signUp / resetPassword:
//     {captchaToken} -> body.gotrue_meta_security.captcha_token; no / empty token -> body unchanged;
//     a server "captcha_failed" answer -> CloudError CAPTCHA_FAILED with the plain message.
//   cccc/shared/ui.js  friendlyError(CAPTCHA_FAILED).
// Mock browser in a vm context; the Turnstile script is a fake that never touches the network.
// Run:  node tests/unit/captcha_check.js [repo path]   (adopted from the core developer, 2026-10-20)
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');
let pass = 0; const ok = (c, n) => { assert.ok(c, n); pass++; console.log('ok - ' + n); };

function env(key, opts){
  opts = opts || {};
  const appended = [], calls = [], removed = [];
  const mkEl = tag => ({nodeType: 1, tag, parentNode: null, removeChild(c){ c.parentNode = null; }});
  const head = Object.assign(mkEl('head'), {appendChild(el){ el.parentNode = head; appended.push(el);
    setTimeout(() => {
      if(opts.loadFails) return el.onerror && el.onerror();
      ctx.turnstile = { render(box, o){ calls.push({box, o}); setTimeout(() => opts.widget ? opts.widget(o) : o.callback('tok-123'), 5); return 'w1'; },
                        remove(id){ removed.push(id); } };
      el.onload && el.onload();
    }, 5); }});
  const ctx = { console, setTimeout, clearTimeout, URL, URLSearchParams, Promise, JSON, Date, Math,
    navigator: {onLine: true}, localStorage: {getItem: () => null, setItem(){}, removeItem(){}},
    document: { head, body: Object.assign(mkEl('body'), {appendChild(e){ e.parentNode = this; }}), createElement: mkEl },
    location: {hash: '', search: '', pathname: '/'}, history: {},
    fetch: async (u, o) => { ctx._fetch = {u, o}; return {ok: opts.authStatus ? false : true, status: opts.authStatus || 200,
      text: async () => JSON.stringify(opts.authBody || {access_token: 'a', refresh_token: 'r', expires_in: 3600, user: {id: 'u', is_anonymous: true}})}; },
  };
  ctx.window = ctx; ctx.addEventListener = () => {};
  ctx.CCCC_CONFIG = {SUPABASE_URL: 'http://sb.test', SUPABASE_ANON_KEY: 'anon', CAPTCHA_SITE_KEY: key};
  vm.createContext(ctx);
  for(const f of ['cloud.js', 'ui.js', 'captcha.js'])
    vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/' + f, 'utf8'), ctx, {filename: f});
  return {ctx, appended, calls, removed};
}

(async () => {
  // 1. empty key: nothing loads, null
  let e = env('');
  ok(e.ctx.Captcha.enabled() === false, 'enabled() false with empty key');
  ok(await e.ctx.Captcha.getToken({nodeType: 1}) === null, 'getToken -> null when off');
  ok(e.appended.length === 0, 'no script appended when off');
  ok(env('   ').ctx.Captcha.enabled() === false, 'whitespace key counts as off');

  // 2. with key: right URL, token, widget removed, script loaded once
  e = env('0x4AAA-site');
  const box = {nodeType: 1};
  ok(e.ctx.Captcha.enabled() === true, 'enabled() true with key');
  const t = await e.ctx.Captcha.getToken(box);
  ok(t === 'tok-123', 'token resolved');
  ok(e.appended.length === 1 && e.appended[0].src === 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', 'script URL correct');
  ok(e.calls[0].box === box && e.calls[0].o.sitekey === '0x4AAA-site', 'rendered into container with site key');
  ok(e.removed[0] === 'w1', 'widget removed afterwards');
  ok(await e.ctx.Captcha.getToken(box) === 'tok-123' && e.appended.length === 1, 'script loaded only once');

  // 3. error / timeout / offline
  e = env('k', {widget: o => o['error-callback']('110100')});
  await e.ctx.Captcha.getToken({nodeType: 1}).then(() => assert.fail('should reject'), err => ok(err.code === 'CAPTCHA_FAILED' && err.name === 'CloudError', 'widget error -> CAPTCHA_FAILED'));
  ok(e.removed.length === 1, 'widget removed after error');
  e = env('k', {widget: () => {}});
  await e.ctx.Captcha.getToken({nodeType: 1}, {timeoutMs: 30}).then(() => assert.fail('x'), err => ok(err.code === 'CAPTCHA_FAILED', 'timeout -> CAPTCHA_FAILED'));
  e = env('k', {loadFails: true});
  await e.ctx.Captcha.getToken({nodeType: 1}).then(() => assert.fail('x'), err => ok(err.offline === true, 'script load fail -> offline'));
  // QA additions: offline browser, empty token, render without a widget id, script loads once for parallel calls
  e = env('k'); e.ctx.navigator.onLine = false;
  await e.ctx.Captcha.getToken({nodeType: 1}).then(() => assert.fail('x'), err => ok(err.offline === true && e.appended.length === 0, 'browser offline -> offline error, no script added'));
  e = env('k', {widget: o => o.callback('')});
  await e.ctx.Captcha.getToken({nodeType: 1}).then(() => assert.fail('x'), err => ok(err.code === 'CAPTCHA_FAILED', 'empty token from the widget -> CAPTCHA_FAILED'));
  e = env('k');
  const both = await Promise.all([e.ctx.Captcha.getToken({nodeType: 1}), e.ctx.Captcha.getToken({nodeType: 1})]);
  ok(both[0] === 'tok-123' && both[1] === 'tok-123' && e.appended.length === 1 && e.calls.length === 2, 'two calls at once: one script, two widgets');
  e = env('k', {loadFails: true});
  await e.ctx.Captcha.getToken({nodeType: 1}).catch(() => {});
  await e.ctx.Captcha.getToken({nodeType: 1}).catch(() => {});
  ok(e.appended.length === 2, 'after a failed load the next try loads the script again');
  ok(e.ctx.friendlyError({code: 'CAPTCHA_FAILED', message: 'x'}) === "We couldn't confirm you're a person. Check your internet and try again.", 'friendlyError CAPTCHA_FAILED');

  // 4. signInAnonymously body
  e = env('');
  const c = e.ctx.Cloud.createClient({storageKey: 't'});
  await c.signInAnonymously({captchaToken: 'x'});
  let body = JSON.parse(e.ctx._fetch.o.body);
  ok(e.ctx._fetch.u === 'http://sb.test/auth/v1/signup' && body.gotrue_meta_security.captcha_token === 'x' && JSON.stringify(body.data) === '{}', 'captcha_token sent');
  await c.signInAnonymously();
  ok(e.ctx._fetch.o.body === JSON.stringify({data: {}}), 'no token: body unchanged');
  // 5. password sign-in, sign-up, reset: token added; old calls unchanged
  const last = () => ({u: e.ctx._fetch.u, b: JSON.parse(e.ctx._fetch.o.body)});
  await c.signInWithPassword('a@b.c', 'pw', {captchaToken: 'p1'});
  let r = last();
  ok(r.u === 'http://sb.test/auth/v1/token?grant_type=password' && r.b.email === 'a@b.c' && r.b.password === 'pw' && r.b.gotrue_meta_security.captcha_token === 'p1', 'signInWithPassword sends captcha_token');
  await c.signInWithPassword('a@b.c', 'pw');
  ok(e.ctx._fetch.o.body === JSON.stringify({email: 'a@b.c', password: 'pw'}), 'signInWithPassword without token unchanged');
  await c.signUp('a@b.c', 'pw', {name: 'N'}, {captchaToken: 's1'});
  r = last();
  ok(r.u === 'http://sb.test/auth/v1/signup' && r.b.data.name === 'N' && r.b.gotrue_meta_security.captcha_token === 's1', 'signUp sends captcha_token');
  await c.signUp('a@b.c', 'pw');
  ok(e.ctx._fetch.o.body === JSON.stringify({email: 'a@b.c', password: 'pw', data: {}}), 'signUp without token unchanged');
  await c.resetPassword('a@b.c', 'http://x.test/back/', {captchaToken: 'r1'});
  r = last();
  ok(r.u === 'http://sb.test/auth/v1/recover?redirect_to=' + encodeURIComponent('http://x.test/back/') && r.b.email === 'a@b.c' && r.b.gotrue_meta_security.captcha_token === 'r1', 'resetPassword sends captcha_token');
  await c.resetPassword('a@b.c');
  ok(e.ctx._fetch.u === 'http://sb.test/auth/v1/recover' && e.ctx._fetch.o.body === JSON.stringify({email: 'a@b.c'}), 'resetPassword without token unchanged');
  await c.signInWithPassword('a@b.c', 'pw', {captchaToken: ''});
  ok(e.ctx._fetch.o.body === JSON.stringify({email: 'a@b.c', password: 'pw'}), 'empty token = no token');

  for(const ab of [{code: 400, error_code: 'captcha_failed', msg: 'captcha protection: request disallowed (timeout-or-duplicate)'},
                   {error: 'invalid_request', error_description: 'captcha verification process failed'}]){
    e = env('', {authStatus: 400, authBody: ab});
    await e.ctx.Cloud.createClient({storageKey: 't'}).signInAnonymously({captchaToken: 'bad'})
      .then(() => assert.fail('x'), err => ok(err.code === 'CAPTCHA_FAILED' && /person/.test(err.message), 'server captcha error -> CAPTCHA_FAILED (' + (ab.error_code || ab.error) + ')'));
  }
  console.log('\nALL ' + pass + ' CHECKS PASSED');
  console.log(`SUMMARY unit/captcha_check: ${pass} checks, 0 failed`);
})().catch(e => { console.error('FAILED:', e && e.message || e); console.log(`SUMMARY unit/captcha_check: ${pass + 1} checks, 1 failed`); process.exit(1); });
