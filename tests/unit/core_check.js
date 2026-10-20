// Unit checks (node, no browser, no database) for cccc/shared/ui.js friendlyError / ERROR_TEXT and
// cccc/shared/cloud.js (parseAuthRedirect, sessionFromUrl, updatePassword, resetPassword).
// Mocks the browser globals + fetch. Adopted from the core-sync engineer's core_check.js.
// Run:  node tests/unit/core_check.js [repo path]      (default: this repository)
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');

let pass = 0;
function ok(cond, name){ assert.ok(cond, name); pass++; console.log('ok - ' + name); }
function eq(a, b, name){ assert.deepStrictEqual(a, b, name + '\n   got: ' + JSON.stringify(a)); pass++; console.log('ok - ' + name); }

function makeEnv(href){
  const store = new Map();
  const calls = [];
  let handler = null;
  const url = new URL(href);
  const loc = {
    get href(){ return url.href; }, get hash(){ return url.hash; }, get search(){ return url.search; },
    get pathname(){ return url.pathname; },
  };
  const hist = { state: null, replaced: [],
    replaceState(state, title, u){ this.replaced.push(u); const n = new URL(u, url.href); url.hash = n.hash; url.search = n.search; url.pathname = n.pathname; } };
  const ctx = {
    console, URL, URLSearchParams, setTimeout, clearTimeout, AbortController, Date, JSON, Math, Promise,
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    location: loc, history: hist, document: { title: 'Back Office' },
    navigator: { onLine: true },
    fetch: async (u, opts) => {
      calls.push({url: u, method: opts.method, headers: opts.headers, body: opts.body});
      if(!handler) throw new TypeError('network down');
      const r = await handler(u, opts);
      if(r === 'NETWORK') throw new TypeError('network down');
      const text = r.body === undefined ? '' : JSON.stringify(r.body);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text };
    },
  };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.crypto = require('crypto').webcrypto;
  ctx.CCCC_CONFIG = { SUPABASE_URL: 'http://sb.test', SUPABASE_ANON_KEY: 'anon-key' };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/cloud.js', 'utf8'), ctx, {filename: 'cloud.js'});
  vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/ui.js', 'utf8'), ctx, {filename: 'ui.js'});
  return { ctx, store, calls, hist, url, setHandler(h){ handler = h; } };
}

(async () => {
  /* ---------------- friendlyError ---------------- */
  const { ctx } = makeEnv('http://x.test/cccc/back/');
  const fe = ctx.friendlyError;
  const T = vm.runInContext('ERROR_TEXT', ctx);
  const codes = ['APPROVAL_REQUIRED','APPROVAL_INVALID','REFUND_TOO_LARGE','RETURN_TOO_LARGE','FORBIDDEN_ROW','UNKNOWN_INGREDIENT',
    'SALE_NOT_REFUNDABLE','BAD_AMOUNT','BAD_REFUND_TYPE','BAD_SALE','BAD_REFUND','SALE_TOTALS_MISMATCH','NOT_ALLOWED','BAD_PURPOSE',
    'UNKNOWN_STAFF','UNKNOWN_DEVICE','TOO_MANY_ATTEMPTS'];
  for(const c of codes){
    ok(typeof T[c] === 'string' && T[c].length > 10 && !/[A-Z]{2,}_[A-Z]/.test(T[c]), 'ERROR_TEXT has plain text for ' + c);
    eq(fe({message: c}), T[c], 'friendlyError({message:"' + c + '"})');
    eq(fe(c + ': extra detail here'), T[c], 'friendlyError(string "' + c + ': extra…")');
  }
  eq(fe({message: 'APPROVAL_INVALID'}), 'The manager approval expired or was already used. Ask the manager to enter their PIN again.', 'APPROVAL_INVALID exact wording');
  // whole-code matching: longer codes are not read as their shorter prefix
  eq(fe('BAD_REFUND_TYPE: x'), T.BAD_REFUND_TYPE, 'BAD_REFUND_TYPE not read as BAD_REFUND');
  eq(fe('BAD_REFUND (id missing)'), T.BAD_REFUND, 'BAD_REFUND with extra text');
  eq(fe('BAD_SALE_STATUS'), T.BAD_SALE_STATUS, 'BAD_SALE_STATUS not read as BAD_SALE');
  eq(fe('ADMIN_ONLY_PIN: x'), T.ADMIN_ONLY_PIN, 'ADMIN_ONLY_PIN not read as ADMIN_ONLY');
  eq(fe('BAD_SALEX'), 'BAD_SALEX', 'unknown code passes through unchanged');
  eq(fe('UNKNOWN_OP: foo'), 'UNKNOWN_OP: foo', 'unknown code with detail passes through');
  // shapes callers use
  const ce = new ctx.Cloud.CloudError('SALE_TOTALS_MISMATCH', {status: 400, code: 'P0001'});
  eq(fe(ce), T.SALE_TOTALS_MISMATCH, 'CloudError with code P0001 + code message');
  eq(fe({code: 'WRONG_PIN', message: 'whatever'}), T.WRONG_PIN, 'e.code still wins when it is a known code');
  eq(fe({error: 'NOT_ALLOWED'}), T.NOT_ALLOWED, 'RPC result object {error}');
  eq(fe({op_id: 'x', status: 'error', message: 'FORBIDDEN_ROW'}), T.FORBIDDEN_ROW, 'fo_sync per-op result object');
  eq(fe({message: 'TOO_MANY_ATTEMPTS'}), T.TOO_MANY_ATTEMPTS, 'TOO_MANY_ATTEMPTS without locked_until');
  const in5 = new Date(Date.now() + 4.5 * 60000).toISOString();
  const t5 = fe({error: 'TOO_MANY_ATTEMPTS', locked_until: in5});
  ok(/^Too many wrong PINs\. Try again at .+ \(about 5 minutes\), or ask the owner to unlock this counter/.test(t5), 'locked_until 5 min -> ' + t5);
  const t4h = fe({message: 'TOO_MANY_ATTEMPTS', locked_until: new Date(Date.now() + 4 * 3600e3).toISOString()});
  ok(/\(about 4 hours\)/.test(t4h), 'locked_until 4 h -> ' + t4h);
  eq(fe({message: 'TOO_MANY_ATTEMPTS', locked_until: 'garbage'}), T.TOO_MANY_ATTEMPTS, 'bad locked_until falls back to generic text');
  eq(fe({message: 'TOO_MANY_ATTEMPTS', locked_until: new Date(Date.now() - 1000).toISOString()}), 'Too many wrong PINs. You can try again now.', 'past locked_until');
  // unchanged behaviour
  eq(fe(null), 'Something went wrong.', 'null');
  eq(fe(''), 'Something went wrong.', 'empty string');
  eq(fe({}), 'Something went wrong.', 'empty object (was "[object Object]"-ish before)');
  eq(fe({offline: true, message: 'No internet connection.'}), 'No internet connection.', 'offline error keeps its message');
  eq(fe('new row violates row-level security policy for table "x"'), 'You do not have permission to change this.', 'RLS text');
  eq(fe('update or delete on table "x" violates foreign key constraint'), 'This record is still used elsewhere (e.g. in sales history), so it cannot be deleted.', 'FK text');
  eq(fe('duplicate key value violates unique constraint'), 'That already exists.', 'duplicate key text');
  eq(fe('Incorrect PIN (offline: only staff who signed in on this counter recently can sign in)'),
     'Incorrect PIN (offline: only staff who signed in on this counter recently can sign in)', 'plain sentence passes through');
  eq(fe({message: 'WRONG_PIN'}), T.WRONG_PIN, 'existing code WRONG_PIN');
  eq(fe(new Error('JWT expired')), 'JWT expired', 'non-code first word passes through');

  /* ---------------- parseAuthRedirect (pure) ---------------- */
  const P = ctx.Cloud.parseAuthRedirect;
  eq(P('', ''), null, 'empty address -> null');
  eq(P('#/sales', '?x=1'), null, 'hash route -> null');
  const r1 = P('#access_token=AT&expires_at=1900000000&expires_in=3600&refresh_token=RT&token_type=bearer&type=recovery', '');
  eq(JSON.parse(JSON.stringify(r1)), {type: 'recovery', from: 'hash', session: {access_token: 'AT', refresh_token: 'RT', expires_at: 1900000000, user: null}}, 'recovery fragment');
  const r2 = P('#access_token=AT&expires_in=600&refresh_token=RT&type=signup', '');
  const now = Math.floor(Date.now()/1000);
  ok(r2.type === 'signup' && r2.session.expires_at >= now + 599 && r2.session.expires_at <= now + 601, 'expires_in only -> expires_at = now + 600');
  ok(typeof r2.session.expires_at === 'number', 'expires_at is a number');
  const r3 = P('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', '');
  eq(r3.error_code, 'otp_expired', 'expired link -> error_code'); eq(r3.from, 'hash', 'expired link from hash');
  ok(/expired or was already used/.test(r3.error) && !/otp/.test(r3.error), 'expired link -> plain sentence: ' + r3.error);
  eq(r3.error_description, 'Email link is invalid or has expired', '+ decoded as spaces');
  const r4 = P('', '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&shop=1');
  eq(r4.from, 'search', 'error in query string detected');

  /* ---------------- sessionFromUrl ---------------- */
  {
    const env = makeEnv('http://x.test/cccc/back/index.html?shop=1#access_token=AT1&expires_at=1900000000&expires_in=3600&refresh_token=RT1&token_type=bearer&type=recovery');
    const user = {id: 'u-1', email: 'owner@example.com'};
    env.setHandler(async (u, o) => (u === 'http://sb.test/auth/v1/user' && o.method === 'GET') ? {status: 200, body: user} : {status: 404, body: {msg: 'nf'}});
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    let changes = 0; cloud.onChange(() => changes++);
    const res = await cloud.sessionFromUrl();
    eq(res.type, 'recovery', 'sessionFromUrl reports type');
    eq(res.session.access_token, 'AT1', 'sessionFromUrl returns the session');
    eq(cloud.session.user, user, 'user filled from GET /auth/v1/user');
    eq(JSON.parse(env.store.get('cccc.admin.session')).refresh_token, 'RT1', 'session saved under cccc.admin.session');
    eq(env.store.has('cccc.session'), false, 'nothing written under another key');
    eq(changes, 1, 'onChange fired once');
    eq(env.calls[0].headers.Authorization, 'Bearer AT1', 'GET /user uses the token from the address');
    eq(env.calls[0].headers.apikey, 'anon-key', 'GET /user sends apikey');
    eq(env.calls[0].body, undefined, 'GET /user has no body');
    eq(env.hist.replaced, ['/cccc/back/index.html?shop=1'], 'fragment cleared, query kept');
    eq(env.url.hash, '', 'address has no fragment now');
    eq(await cloud.sessionFromUrl(), null, 'second call -> null (address already clean)');

    /* ---------------- updatePassword ---------------- */
    env.calls.length = 0;
    env.setHandler(async (u, o) => {
      if(u === 'http://sb.test/auth/v1/user' && o.method === 'PUT') return {status: 200, body: Object.assign({}, user, {updated_at: 'now'})};
      return {status: 404, body: {msg: 'nf'}};
    });
    const upd = await cloud.updatePassword('n3w-Passw0rd');
    eq(env.calls.length, 1, 'updatePassword makes one request');
    const c = env.calls[0];
    eq([c.url, c.method], ['http://sb.test/auth/v1/user', 'PUT'], 'updatePassword -> PUT /auth/v1/user');
    eq(JSON.parse(c.body), {password: 'n3w-Passw0rd'}, 'body is {password}');
    eq(c.headers.Authorization, 'Bearer AT1', 'bearer = current access token');
    eq(c.headers['Content-Type'], 'application/json', 'JSON content type');
    eq(upd.updated_at, 'now', 'returns the updated user');
    eq(cloud.session.user.updated_at, 'now', 'session.user updated');

    env.setHandler(async () => ({status: 422, body: {code: 422, error_code: 'same_password', msg: 'New password should be different from the old password.'}}));
    await assert.rejects(cloud.updatePassword('n3w-Passw0rd'), e => e.message === 'Your new password must be different from your old one.' && e.code === 'same_password');
    pass++; console.log('ok - same_password -> plain message');
    env.setHandler(async () => ({status: 422, body: {code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.'}}));
    await assert.rejects(cloud.updatePassword('abc'), e => e.message === 'Password should be at least 6 characters.' && e.status === 422);
    pass++; console.log('ok - weak_password keeps the server sentence');
    await assert.rejects(cloud.updatePassword(''), e => e.code === 'NO_PASSWORD');
    pass++; console.log('ok - empty password refused before any request');

    // 401 -> refresh once -> retry
    env.calls.length = 0;
    let n = 0;
    env.setHandler(async (u, o) => {
      if(u.endsWith('/auth/v1/user') && o.method === 'PUT'){ n++; return n === 1 ? {status: 401, body: {code: 401, error_code: 'bad_jwt', msg: 'invalid JWT'}} : {status: 200, body: user}; }
      if(u.endsWith('/auth/v1/token?grant_type=refresh_token')) return {status: 200, body: {access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, user}};
      return {status: 404, body: {}};
    });
    await cloud.updatePassword('another-one');
    eq(env.calls.map(x => x.method + ' ' + x.url.replace('http://sb.test', '')),
       ['PUT /auth/v1/user', 'POST /auth/v1/token?grant_type=refresh_token', 'PUT /auth/v1/user'], '401 -> refresh -> retry');
    eq(env.calls[2].headers.Authorization, 'Bearer AT2', 'retry uses the refreshed token');

    // offline -> CloudError offline, nothing dropped
    env.setHandler(async () => 'NETWORK');
    await assert.rejects(cloud.updatePassword('x-offline'), e => e.offline === true);
    pass++; console.log('ok - offline updatePassword -> offline CloudError');
    ok(cloud.isReachable() === false, 'offline marks client unreachable');

    // signed out
    env.setHandler(async () => ({status: 204}));
    await cloud.signOut();
    await assert.rejects(cloud.updatePassword('x'), e => e.code === 'NO_SESSION');
    pass++; console.log('ok - no session -> NO_SESSION');
  }
  {
    // expired link: nothing saved, fragment cleared, plain error
    const env = makeEnv('http://x.test/cccc/back/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    env.setHandler(async () => { throw new Error('should not call the server'); });
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    const r = await cloud.sessionFromUrl();
    eq([r.type, r.error_code], [null, 'otp_expired'], 'expired link result');
    ok(/expired or was already used/.test(r.error), 'expired link plain text');
    eq(env.calls.length, 0, 'expired link: no server call');
    eq(env.store.size, 0, 'expired link: nothing saved');
    eq(env.url.hash, '', 'expired link: fragment cleared');
  }
  {
    // token the server refuses: not saved, existing session untouched
    const env = makeEnv('http://x.test/cccc/back/#access_token=FORGED&refresh_token=R&expires_in=3600&type=recovery');
    env.store.set('cccc.admin.session', JSON.stringify({access_token: 'OLD', refresh_token: 'OLDR', expires_at: 1900000000, user: {id: 'old'}}));
    env.setHandler(async () => ({status: 401, body: {code: 401, error_code: 'bad_jwt', msg: 'invalid JWT'}}));
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    const r = await cloud.sessionFromUrl();
    ok(r.error && r.type === 'recovery' && !r.session, 'refused token -> error result');
    eq(JSON.parse(env.store.get('cccc.admin.session')).access_token, 'OLD', 'refused token: saved session untouched');
    eq(env.url.hash, '', 'refused token: fragment cleared');
  }
  {
    // offline while landing: session kept (user filled later), fragment cleared
    const env = makeEnv('http://x.test/cccc/back/#access_token=AT&refresh_token=R&expires_in=3600&type=recovery');
    env.setHandler(async () => 'NETWORK');
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    const r = await cloud.sessionFromUrl();
    eq([r.type, r.session.access_token, r.session.user], ['recovery', 'AT', null], 'offline landing keeps the session');
  }
  {
    // error in the query string: only auth keys removed, hash route kept
    const env = makeEnv('http://x.test/cccc/back/?shop=1&error=access_denied&error_code=otp_expired&error_description=x#/settings');
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    const r = await cloud.sessionFromUrl();
    eq(r.error_code, 'otp_expired', 'query error detected');
    eq(env.hist.replaced, ['/cccc/back/?shop=1#/settings'], 'query error keys removed, other parts kept');
  }
  {
    // existing API unchanged: resetPassword request shape
    const env = makeEnv('http://x.test/cccc/back/');
    env.setHandler(async () => ({status: 200, body: {}}));
    const cloud = env.ctx.Cloud.createClient({storageKey: 'cccc.admin.session'});
    await cloud.resetPassword('owner@example.com', 'https://zdboi.github.io/coffee-shop-system/cccc/back/');
    eq([env.calls[0].method, env.calls[0].url], ['POST', 'http://sb.test/auth/v1/recover?redirect_to=https%3A%2F%2Fzdboi.github.io%2Fcoffee-shop-system%2Fcccc%2Fback%2F'], 'resetPassword unchanged');
    eq(JSON.parse(env.calls[0].body), {email: 'owner@example.com'}, 'resetPassword body unchanged');
    eq(env.calls[0].headers.Authorization, undefined, 'resetPassword sends no bearer');
    env.setHandler(async () => ({status: 429, body: {code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded'}}));
    await assert.rejects(cloud.resetPassword('owner@example.com'), e => /Too many emails/.test(e.message) && e.status === 429);
    pass++; console.log('ok - email rate limit -> plain message');
    const keys = Object.keys(cloud).sort();
    ok(['CloudError','storageKey','session','user','userId','isAnonymous','onChange','onNetwork','isReachable','setStaffToken','getStaffToken',
        'signInAnonymously','signInWithPassword','signUp','resetPassword','signOut','ensureSession','rpc','select','selectAll','upload','publicUrl',
        'sessionFromUrl','updatePassword'].every(k => keys.includes(k)), 'client API keeps every existing name + the two new ones');
  }
  console.log('\nALL ' + pass + ' CHECKS PASSED');
  console.log(`SUMMARY unit/core_check: ${pass} checks, 0 failed`);
})().catch(e => { console.error('FAILED:', e.message); console.log(`SUMMARY unit/core_check: ${pass + 1} checks, 1 failed (stopped at the first failure)`); process.exit(1); });
