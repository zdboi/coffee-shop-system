// Unit checks (node, no browser, no database) for cloud.js sessionFromUrl() hardening (2026-10-12):
//   * only type=recovery / signup links sign in; other logins in the address are ignored but cleared;
//   * a link never replaces the login of a DIFFERENT user already signed in on this client
//     -> {type, conflict:true, error:'You are signed in as another account. …'};
//   * the same user's login is refreshed; existing shapes unchanged.
// Same mock browser as tests/unit/core_check.js, plus atob (real browsers have it) unless noAtob.
// Run:  node tests/unit/email_link_check.js [repo path]   (adopted from the core developer)
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');

let pass = 0;
function ok(cond, name){ assert.ok(cond, name); pass++; console.log('ok - ' + name); }
const norm = (x) => (x && typeof x === 'object') ? JSON.parse(JSON.stringify(x)) : x;
function eq(a, b, name){ assert.deepStrictEqual(norm(a), norm(b), name + '\n   got: ' + JSON.stringify(a)); pass++; console.log('ok - ' + name); }

function makeEnv(href, opts){
  opts = opts || {};
  const store = new Map();
  const calls = [];
  let handler = null;
  const url = new URL(href);
  const loc = { get href(){ return url.href; }, get hash(){ return url.hash; }, get search(){ return url.search; }, get pathname(){ return url.pathname; } };
  const hist = { state: null, replaced: [],
    replaceState(state, title, u){ this.replaced.push(u); const n = new URL(u, url.href); url.hash = n.hash; url.search = n.search; url.pathname = n.pathname; } };
  const ctx = {
    console, URL, URLSearchParams, setTimeout, clearTimeout, AbortController, Date, JSON, Math, Promise,
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    location: loc, history: hist, document: { title: 'Back Office' }, navigator: { onLine: true },
    fetch: async (u, o) => {
      calls.push({url: u, method: o.method, headers: o.headers, body: o.body});
      if(!handler) throw new TypeError('network down');
      const r = await handler(u, o);
      if(r === 'NETWORK') throw new TypeError('network down');
      const text = r.body === undefined ? '' : JSON.stringify(r.body);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text };
    },
  };
  if(!opts.noAtob) ctx.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  ctx.window = ctx; ctx.addEventListener = () => {};
  ctx.crypto = require('crypto').webcrypto;
  ctx.CCCC_CONFIG = { SUPABASE_URL: 'http://sb.test', SUPABASE_ANON_KEY: 'anon-key' };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/cloud.js', 'utf8'), ctx, {filename: 'cloud.js'});
  return { ctx, store, calls, hist, url, setHandler(h){ handler = h; } };
}
// A token like Supabase's (header.payload.signature, base64url); only "sub" matters here.
function jwt(sub, extra){
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64u({alg: 'HS256', typ: 'JWT'}) + '.' + b64u(Object.assign({sub, role: 'authenticated', aud: 'authenticated', exp: 1900000000}, extra || {})) + '.c2ln';
}
const OWNER = {id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com'};
const OTHER = {id: '22222222-2222-4222-8222-222222222222', email: 'someone@example.com'};
const userHandler = (user) => async (u, o) => (u === 'http://sb.test/auth/v1/user' && o.method === 'GET') ? {status: 200, body: user} : {status: 404, body: {}};
const linkUrl = (token, type, extra) => 'http://x.test/cccc/back/index.html?shop=1#access_token=' + token + '&expires_at=1900000000&expires_in=3600&refresh_token=RTL&token_type=bearer' + (type ? '&type=' + type : '') + (extra || '');
const CONFLICT = 'You are signed in as another account. Sign out first, then ask for a new email link.';
const saved = (env) => JSON.parse(env.store.get('cccc.admin.session') || 'null');

(async () => {
  /* ---- other link types are ignored (and cleared) ---- */
  for(const type of ['magiclink', 'invite', 'email_change', 'email', null]){
    const env = makeEnv(linkUrl(jwt(OWNER.id), type));
    env.setHandler(async () => { throw new Error('should not call the server'); });
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    const r = await cloud.sessionFromUrl();
    eq(r, {type, ignored: true}, `type=${type}: ignored`);
    eq(env.calls.length, 0, `type=${type}: no server call`);
    eq(env.store.size, 0, `type=${type}: nothing saved`);
    eq(cloud.session, null, `type=${type}: not signed in`);
    eq(env.hist.replaced, ['/cccc/back/index.html?shop=1'], `type=${type}: login removed from the address, query kept`);
  }
  {
    // ignored link with someone signed in: their login is untouched
    const env = makeEnv(linkUrl(jwt(OTHER.id), 'magiclink'));
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id), refresh_token: 'R0', expires_at: 1900000000, user: OWNER}));
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    const r = await cloud.sessionFromUrl();
    ok(r.ignored && saved(env).refresh_token === 'R0' && cloud.userId() === OWNER.id, 'magic link while signed in: login untouched');
  }
  eq([...makeEnv('http://x.test/').ctx.Cloud.EMAIL_LINK_TYPES], ['recovery', 'signup'], 'Cloud.EMAIL_LINK_TYPES = recovery, signup');

  /* ---- recovery / signup with nobody signed in: unchanged behaviour ---- */
  for(const type of ['recovery', 'signup']){
    const env = makeEnv(linkUrl(jwt(OWNER.id), type));
    env.setHandler(userHandler(OWNER));
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    let changes = 0; cloud.onChange(() => changes++);
    const r = await cloud.sessionFromUrl();
    eq([r.type, !!r.session, r.conflict, r.error, r.ignored], [type, true, undefined, undefined, undefined], `${type}, nobody signed in: {type, session}`);
    eq([saved(env).refresh_token, cloud.userId(), changes], ['RTL', OWNER.id, 1], `${type}: saved once, user filled`);
    eq(env.url.hash, '', `${type}: address cleared`);
  }

  /* ---- a DIFFERENT user is signed in: refused, nothing changes ---- */
  {
    const env = makeEnv(linkUrl(jwt(OTHER.id), 'recovery'));
    const before = JSON.stringify({access_token: jwt(OWNER.id), refresh_token: 'R0', expires_at: 1900000000, user: OWNER});
    env.store.set('cccc.admin.session', before);
    env.setHandler(userHandler(OTHER));
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    let changes = 0; cloud.onChange(() => changes++);
    const r = await cloud.sessionFromUrl();
    eq(r, {type: 'recovery', conflict: true, error: CONFLICT}, 'other user signed in: {type, conflict:true, error}');
    eq(env.store.get('cccc.admin.session'), before, 'other user signed in: saved login untouched');
    eq([cloud.userId(), changes], [OWNER.id, 0], 'other user signed in: still the same login, no change event');
    eq(env.url.hash, '', 'other user signed in: address still cleared');
    eq(await cloud.sessionFromUrl(), null, 'second call -> null');
  }
  {
    // signup link of another account
    const env = makeEnv(linkUrl(jwt(OTHER.id), 'signup'));
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id), refresh_token: 'R0', expires_at: 1900000000, user: OWNER}));
    env.setHandler(userHandler(OTHER));
    const r = await env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'}).sessionFromUrl();
    ok(r.conflict === true && r.type === 'signup' && r.error === CONFLICT && saved(env).refresh_token === 'R0', 'signup link of another account: refused');
  }
  {
    // the signed-in login has no user details saved (e.g. saved offline): its token tells who it is
    const env = makeEnv(linkUrl(jwt(OTHER.id), 'recovery'));
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id), refresh_token: 'R0', expires_at: 1900000000, user: null}));
    env.setHandler(userHandler(OTHER));
    const r = await env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'}).sessionFromUrl();
    ok(r.conflict === true && saved(env).refresh_token === 'R0', 'signed-in login without user details: identified from its token -> refused');
  }
  {
    // an anonymous (counter / customer) login on this client is also "another account"
    const env = makeEnv(linkUrl(jwt(OWNER.id), 'recovery'));
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt('33333333-3333-4333-8333-333333333333', {is_anonymous: true}), refresh_token: 'RA', expires_at: 1900000000, user: {id: '33333333-3333-4333-8333-333333333333', is_anonymous: true}}));
    env.setHandler(userHandler(OWNER));
    const r = await env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'}).sessionFromUrl();
    ok(r.conflict === true && saved(env).refresh_token === 'RA', 'anonymous login signed in: refused');
  }
  {
    // another TAB signed in after this page loaded (seen through localStorage)
    const env = makeEnv(linkUrl(jwt(OTHER.id), 'recovery'));
    env.setHandler(userHandler(OTHER));
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id), refresh_token: 'RT', expires_at: 1900000000, user: OWNER}));
    const r = await cloud.sessionFromUrl();
    ok(r.conflict === true && saved(env).refresh_token === 'RT', 'login made in another tab: refused');
  }
  {
    // unknown identity on either side: refused (never guess)
    const env = makeEnv(linkUrl('not-a-jwt', 'recovery'));
    env.store.set('cccc.admin.session', JSON.stringify({access_token: 'opaque', refresh_token: 'R0', expires_at: 1900000000, user: null}));
    env.setHandler(async () => 'NETWORK');
    const r = await env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'}).sessionFromUrl();
    ok(r.conflict === true && saved(env).refresh_token === 'R0', 'offline + unreadable tokens while signed in: refused');
  }
  {
    // offline, someone else signed in: the link token's own "sub" shows it is another user
    const env = makeEnv(linkUrl(jwt(OTHER.id), 'recovery'));
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id), refresh_token: 'R0', expires_at: 1900000000, user: OWNER}));
    env.setHandler(async () => 'NETWORK');
    const r = await env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'}).sessionFromUrl();
    ok(r.conflict === true && saved(env).refresh_token === 'R0', 'offline, another user signed in: refused');
  }
  {
    // browser without atob and no user details: cannot tell -> refused
    const env = makeEnv(linkUrl(jwt(OWNER.id), 'recovery'), {noAtob: true});
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id), refresh_token: 'R0', expires_at: 1900000000, user: null}));
    env.setHandler(async () => 'NETWORK');
    const r = await env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'}).sessionFromUrl();
    ok(r.conflict === true, 'no way to tell who is signed in: refused');
  }

  /* ---- the SAME user is signed in: the link refreshes their login ---- */
  {
    const env = makeEnv(linkUrl(jwt(OWNER.id), 'recovery'));
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id, {iat: 1}), refresh_token: 'R0', expires_at: 1900000000, user: OWNER}));
    env.setHandler(userHandler(OWNER));
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    const r = await cloud.sessionFromUrl();
    eq([r.type, !!r.session, r.conflict], ['recovery', true, undefined], 'same user signed in: {type, session}');
    eq(saved(env).refresh_token, 'RTL', 'same user: login replaced by the link (fresh recovery login)');
  }
  {
    // same user, offline: identified from both tokens
    const env = makeEnv(linkUrl(jwt(OWNER.id), 'recovery'));
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id, {iat: 1}), refresh_token: 'R0', expires_at: 1900000000, user: null}));
    env.setHandler(async () => 'NETWORK');
    const r = await env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'}).sessionFromUrl();
    ok(r.session && saved(env).refresh_token === 'RTL', 'same user, offline: link login kept');
  }

  /* ---- existing results unchanged ---- */
  {
    // refused token while someone is signed in: still the "link did not work" error, login untouched
    const env = makeEnv(linkUrl('FORGED', 'recovery'));
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id), refresh_token: 'R0', expires_at: 1900000000, user: OWNER}));
    env.setHandler(async () => ({status: 401, body: {code: 401, error_code: 'bad_jwt', msg: 'invalid JWT'}}));
    const r = await env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'}).sessionFromUrl();
    ok(r.error && !r.conflict && !r.session && /expired or was already used/.test(r.error) && r.error_code === 'bad_jwt', 'refused token: same error result as before');
    eq(saved(env).refresh_token, 'R0', 'refused token: login untouched');
  }
  {
    // expired link while signed in: error shape unchanged, login untouched
    const env = makeEnv('http://x.test/cccc/back/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    env.store.set('cccc.admin.session', JSON.stringify({access_token: jwt(OWNER.id), refresh_token: 'R0', expires_at: 1900000000, user: OWNER}));
    const r = await env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'}).sessionFromUrl();
    eq([r.type, r.error_code, r.conflict], [null, 'otp_expired', undefined], 'expired link: unchanged shape');
    eq(saved(env).refresh_token, 'R0', 'expired link: login untouched');
  }
  eq(await makeEnv('http://x.test/cccc/back/#/sales').ctx.Cloud.createClient({storageKey: 'k'}).sessionFromUrl(), null, 'no login in the address -> null');

  console.log('\nALL ' + pass + ' CHECKS PASSED');
  console.log(`SUMMARY unit/email_link_check: ${pass} checks, 0 failed`);
})().catch(e => { console.error('FAILED:', e.message); console.log(`SUMMARY unit/email_link_check: ${pass + 1} checks, 1 failed`); process.exit(1); });
