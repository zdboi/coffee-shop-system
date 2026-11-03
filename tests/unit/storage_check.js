// cloud.download / cloud.remove with a fake fetch (no network). Run: node tests/unit/storage_check.js [repo]   (adopted from core-sync-engineer 2026-11-03)
const fs = require('fs'), vm = require('vm');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const calls = []; let reply = () => ({status: 200, body: 'IMG'});
const store = {};
const ctx = {console, JSON, Math, Date, Promise, setTimeout, clearTimeout, AbortController, Blob, TextEncoder, encodeURIComponent, atob,
  navigator: {onLine: true}, localStorage: {getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; }},
  CCCC_CONFIG: {SUPABASE_URL: 'https://x.test', SUPABASE_ANON_KEY: 'anon'}};
ctx.window = ctx; ctx.addEventListener = () => {};
ctx.fetch = async (url, o) => { calls.push({url, method: o.method, headers: o.headers, body: o.body}); const r = reply(url, o); return new Response(r.body, {status: r.status}); };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/ui.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/cloud.js', 'utf8'), ctx);
let n = 0, bad = 0; const ok = (c, m) => { n++; if(!c){ bad++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
(async () => {
  store['k'] = JSON.stringify({access_token: 'TOK', refresh_token: 'R', expires_at: Math.floor(Date.now()/1000) + 3600, user: {id: 'u'}});
  const c = vm.runInContext(`Cloud.createClient({storageKey: 'k'})`, ctx);
  const blob = await c.download('expense-photos', 'biz-1/receipt 1.jpg');
  ok(await blob.text() === 'IMG', 'download returns a Blob');
  ok(calls[0].url === 'https://x.test/storage/v1/object/authenticated/expense-photos/biz-1/receipt%201.jpg' && calls[0].method === 'GET', 'authenticated GET url, segments encoded');
  ok(calls[0].headers.Authorization === 'Bearer TOK' && !calls[0].headers['x-staff-token'], 'session token sent');
  for(const p of ['../x', 'a/../b', '/biz/x', 'biz//x', 'biz\\x', '', 'a/./b', 'a\u0000b', null]){
    let code = null; try{ await c.download('expense-photos', p); }catch(e){ code = e.code; } ok(code === 'BAD_STORAGE_PATH', 'refused path ' + JSON.stringify(p));
  }
  let code = null; try{ await c.remove('../b', ['x']); }catch(e){ code = e.code; } ok(code === 'BAD_STORAGE_PATH', 'refused bucket ..');
  code = null; try{ await c.remove('expense-photos', ['ok/x', 'bad/../y']); }catch(e){ code = e.code; } ok(code === 'BAD_STORAGE_PATH', 'one bad path refuses the whole remove');
  ok(calls.length === 1, 'nothing sent for refused names');
  reply = () => ({status: 200, body: JSON.stringify([{name: 'biz-1/a.jpg'}])});
  const out = await c.remove('expense-photos', ['biz-1/a.jpg']);
  const last = calls[calls.length - 1];
  ok(last.url === 'https://x.test/storage/v1/object/expense-photos' && last.method === 'DELETE' && last.body === JSON.stringify({prefixes: ['biz-1/a.jpg']}) && last.headers['Content-Type'] === 'application/json', 'remove: DELETE with {prefixes}');
  ok(out.length === 1, 'remove returns the server list');
  ok((await c.remove('expense-photos', [])).length === 0 && calls[calls.length - 1] === last, 'empty list: nothing sent');
  reply = () => ({status: 400, body: JSON.stringify({statusCode: '404', error: 'not_found', message: 'Object not found'})});
  try{ await c.download('expense-photos', 'biz-1/gone.jpg'); }catch(e){ code = e.code; ctx.__e = e; }
  ok(code === 'FILE_NOT_FOUND' && vm.runInContext('friendlyError(__e)', ctx) === vm.runInContext('ERROR_TEXT.FILE_NOT_FOUND', ctx), 'not found -> FILE_NOT_FOUND plain text');
  reply = () => ({status: 400, body: JSON.stringify({statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy'})});
  try{ await c.remove('expense-photos', ['other-biz/x.jpg']); }catch(e){ code = e.code; } ok(code === 'FILE_NOT_ALLOWED', 'policy refusal -> FILE_NOT_ALLOWED');
  let k = 0; const before = calls.length;
  reply = (url) => { if(url.includes('/auth/v1/token')) return {status: 200, body: JSON.stringify({access_token: 'NEW', refresh_token: 'R2', expires_in: 3600})}; return (k++ === 0) ? {status: 400, body: JSON.stringify({statusCode: '403', error: 'Unauthorized', message: 'jwt expired'})} : {status: 200, body: 'IMG2'}; };
  const b2 = await c.download('expense-photos', 'biz-1/a.jpg');
  ok(await b2.text() === 'IMG2' && calls[calls.length - 1].headers.Authorization === 'Bearer NEW' && calls.length - before === 3, 'expired token: refreshed once and retried');
  reply = () => ({status: 200, body: '{}'});
  const nb = calls.length;
  const url = await c.upload('expense-photos', 'biz-1/e1-123.jpg', new Blob(['x']), 'image/jpeg');
  ok(calls.length === nb + 1 && calls[nb].url === 'https://x.test/storage/v1/object/expense-photos/biz-1/e1-123.jpg' && calls[nb].method === 'POST' && url.endsWith('/public/expense-photos/biz-1/e1-123.jpg'), 'upload with a good path works as before');
  for(const p of ['../x.jpg', 'biz/../x.jpg', '/biz/x.jpg', 'biz//x.jpg']){
    let code = null; try{ await c.upload('expense-photos', p, new Blob(['x'])); }catch(e){ code = e.code; } ok(code === 'BAD_STORAGE_PATH', 'upload refuses ' + p);
  }
  ok(calls.length === nb + 1, 'nothing uploaded for refused paths');
  console.log(`SUMMARY unit/storage_check: ${n} checks, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log('CRASH', e); process.exit(1); });
