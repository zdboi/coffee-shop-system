// Browser unit check (Chromium): sessionFromUrl clears the real address bar, saves the
// session under cccc.admin.session, updatePassword request shape; friendlyError in-page.
// Everything is served from memory/disk through page.route - no stand-in, no database.
// Run:  node tests/unit/core_browser.js [repo path]      (default: this repository)
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>BO test</title></head><body>
<script src="../shared/config.js"></script><script src="../shared/cloud.js"></script><script src="../shared/ui.js"></script>
<script>window.cloud = Cloud.createClient({storageKey: 'cccc.admin.session'});</script></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ locale: 'en-PH', timezoneId: 'Asia/Manila' });
  const authCalls = [];
  page.on('pageerror', e => { console.error('PAGE ERROR', e); process.exitCode = 1; });
  await page.route('http://app.test/**', async route => {
    const u = new URL(route.request().url());
    if(u.pathname === '/cccc/back/' || u.pathname === '/cccc/back/index.html') return route.fulfill({contentType: 'text/html', body: PAGE});
    if(u.pathname === '/cccc/shared/config.js') return route.fulfill({contentType: 'application/javascript',
      body: "window.CCCC_CONFIG = {SUPABASE_URL: 'http://sb.test', SUPABASE_ANON_KEY: 'anon-key', APP_VERSION: 'test'};"});
    const f = path.join(ROOT, u.pathname);
    if(f.startsWith(ROOT) && fs.existsSync(f)) return route.fulfill({contentType: 'application/javascript', body: fs.readFileSync(f)});
    return route.fulfill({status: 404, body: 'nf'});
  });
  const user = {id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com'};
  await page.route('http://sb.test/**', async route => {
    const r = route.request();
    const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'};
    if(r.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    authCalls.push({method: r.method(), url: r.url(), auth: r.headers()['authorization'], apikey: r.headers()['apikey'], body: r.postData()});
    if(r.url() === 'http://sb.test/auth/v1/user') return route.fulfill({status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify(r.method() === 'PUT' ? Object.assign({}, user, {updated_at: '2026-10-12T00:00:00Z'}) : user)});
    return route.fulfill({status: 404, headers: cors, body: '{}'});
  });

  const results = [];
  const check = (cond, name) => { results.push((cond ? 'ok - ' : 'NOT OK - ') + name); if(!cond) process.exitCode = 1; };

  await page.goto('http://app.test/cccc/back/?shop=1#access_token=ATX&expires_at=1900000000&expires_in=3600&refresh_token=RTX&token_type=bearer&type=recovery');
  const r = await page.evaluate(async () => {
    const before = history.length;
    const res = await cloud.sessionFromUrl();
    window.__histDelta = history.length - before;
    return {type: res.type, token: res.session && res.session.access_token, href: location.href, hash: location.hash,
            saved: JSON.parse(localStorage.getItem('cccc.admin.session')), user: cloud.user()};
  });
  check(r.type === 'recovery', 'type reported: ' + r.type);
  check(r.token === 'ATX' && r.saved.refresh_token === 'RTX' && r.saved.expires_at === 1900000000, 'session saved under cccc.admin.session');
  check(r.href === 'http://app.test/cccc/back/?shop=1' && r.hash === '', 'address bar cleaned: ' + r.href);
  check(r.user && r.user.email === 'owner@example.com', 'user loaded');
  const u = await page.evaluate(async () => { const x = await cloud.updatePassword('Brand-new-pass1'); return {x, s: cloud.user()}; });
  const put = authCalls.find(c => c.method === 'PUT');
  check(!!put && put.url === 'http://sb.test/auth/v1/user' && put.auth === 'Bearer ATX' && put.apikey === 'anon-key', 'PUT /auth/v1/user with bearer + apikey');
  check(put && put.body === JSON.stringify({password: 'Brand-new-pass1'}), 'PUT body = {"password":…}');
  check(u.s.updated_at === '2026-10-12T00:00:00Z', 'session user refreshed after update');
  // back button must not bring the token back
  const histDelta = await page.evaluate(() => window.__histDelta);
  check(histDelta === 0, 'no new history entry (token cannot come back with Back button), delta ' + histDelta);

  const fe = await page.evaluate(() => ({
    a: friendlyError({message: 'APPROVAL_INVALID'}),
    b: friendlyError({op_id: 'x', status: 'error', message: 'REFUND_TOO_LARGE: 120.00 > 100.00'}),
    c: friendlyError({error: 'TOO_MANY_ATTEMPTS', locked_until: new Date(Date.now() + 30*60000).toISOString()}),
    d: friendlyError(new Cloud.CloudError('SALE_TOTALS_MISMATCH', {status: 400, code: 'P0001'})),
  }));
  check(fe.a === 'The manager approval expired or was already used. Ask the manager to enter their PIN again.', 'in-page APPROVAL_INVALID');
  check(/^The refund is more than/.test(fe.b), 'in-page REFUND_TOO_LARGE with extra text');
  check(/^Too many wrong PINs\. Try again at \d{1,2}:\d{2}\s?[AP]M \(about 30 minutes\)/i.test(fe.c), 'in-page lock text: ' + fe.c);
  check(/^The sale total does not match/.test(fe.d), 'in-page SALE_TOTALS_MISMATCH');

  // expired link in a real browser
  await page.goto('http://app.test/cccc/back/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  const e = await page.evaluate(async () => { localStorage.clear(); const x = await cloud.sessionFromUrl(); return {x, href: location.href, saved: localStorage.getItem('cccc.admin.session')}; });
  check(e.x.error_code === 'otp_expired' && /expired/.test(e.x.error) && e.saved === null && e.href === 'http://app.test/cccc/back/', 'expired link handled, address cleaned');

  console.log(results.join('\n'));
  console.log(`SUMMARY unit/core_browser: ${results.length} checks, ${results.filter(r => r.startsWith('NOT OK')).length} failed`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
