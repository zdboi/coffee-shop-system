// Checks of the local Supabase stand-in itself (tests/fake-supabase/server.js), release 1.4 additions:
//   - RPC parameters of an array type (uuid[]) accept a JSON array (like PostgREST) and a "{...}" literal
//   - private storage (expense-photos): upload / authenticated read / delete go through the storage
//     policies of the scripts (owner of the shop only); public URLs refused for a private bucket;
//     the public menu-images bucket still works.
// If these fail, the Back Office receipt-photo and merge checks can't be trusted.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fake_standin.e2e.js
const H = require('./lib/h');
const {BASE, sql, ok} = H;
const NAME = 'fake_standin.e2e';
const KEY = 'test-anon-key';
async function call(method, path, opts){
  opts = opts || {};
  const headers = Object.assign({apikey: KEY}, opts.token ? {Authorization: 'Bearer ' + opts.token} : {}, opts.headers || {});
  let body = opts.body;
  if(body !== undefined && !(body instanceof Buffer) && typeof body !== 'string'){ body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + path, {method, headers, body});
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try{ json = JSON.parse(buf.toString()); }catch(e){}
  return {status: r.status, buf, json};
}
(async () => {
  try{
    const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
    const owner = (await call('POST', '/auth/v1/token?grant_type=password', {body: {email: 'owner@example.com', password: 'secret123'}})).json.access_token;
    const anon = (await call('POST', '/auth/v1/signup', {body: {data: {}}})).json.access_token;   // e.g. a counter / phone login
    ok(owner && anon, 'owner and anonymous logins');

    // ---- RPC array parameters (merge_ingredients_preview(p_ids uuid[], ...))
    const ids = ['22222222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'];
    const a = await call('POST', '/rest/v1/rpc/merge_ingredients_preview', {token: owner, body: {p_ids: ids, p_name: 'QA merged', p_into: null, p_base_unit: 'g', p_brand_names: {}}});
    // g + ml can't be merged: the function itself answers MERGE_UNIT_MISMATCH, which proves the array got through
    ok(a.json && a.json.message === 'MERGE_UNIT_MISMATCH', 'uuid[] parameter as a JSON array reaches the function (its own MERGE_UNIT_MISMATCH, not "malformed array literal")', a.json);
    const b = await call('POST', '/rest/v1/rpc/merge_ingredients_preview', {token: owner, body: {p_ids: '{' + ids.join(',') + '}', p_name: 'QA merged', p_into: null, p_base_unit: 'g', p_brand_names: {}}});
    ok(a.status === b.status && JSON.stringify(a.json) === JSON.stringify(b.json), 'the same call with a "{...}" literal gives the same answer', [a.status, b.status]);

    // ---- private bucket: expense-photos/<business id>/<file>
    const img = Buffer.from('fake-jpeg-bytes-' + Date.now());
    const path = `expense-photos/${biz}/qa-receipt.jpg`;
    const up = await call('POST', '/storage/v1/object/' + path, {token: owner, body: img, headers: {'Content-Type': 'image/jpeg', 'x-upsert': 'true'}});
    ok(up.status === 200, 'owner uploads a receipt photo into their own shop folder', up.json);
    ok(sql(`select count(*) from storage.objects where bucket_id='expense-photos' and name='${biz}/qa-receipt.jpg'`) === '1', '... recorded in storage.objects');
    const other = await call('POST', '/storage/v1/object/expense-photos/00000000-0000-0000-0000-000000000000/x.jpg', {token: owner, body: img, headers: {'Content-Type': 'image/jpeg'}});
    ok(other.status >= 400, 'owner cannot upload into another shop\'s folder', other.status);
    const upAnon = await call('POST', `/storage/v1/object/expense-photos/${biz}/anon.jpg`, {token: anon, body: img, headers: {'Content-Type': 'image/jpeg'}});
    const upNoLogin = await call('POST', `/storage/v1/object/expense-photos/${biz}/nologin.jpg`, {body: img, headers: {'Content-Type': 'image/jpeg'}});
    ok(upAnon.status >= 400 && upNoLogin.status >= 400, 'an anonymous login and no login cannot upload', [upAnon.status, upNoLogin.status]);

    const pub = await call('GET', '/storage/v1/object/public/' + path);
    ok(pub.status >= 400, 'private bucket: the public URL does not serve the photo', pub.status);
    const get = await call('GET', '/storage/v1/object/authenticated/' + path, {token: owner});
    ok(get.status === 200 && get.buf.equals(img), 'owner downloads it (authenticated URL), same bytes', get.status);
    const get2 = await call('GET', '/storage/v1/object/' + path, {token: owner});
    ok(get2.status === 200 && get2.buf.equals(img), 'owner downloads it (plain object URL)', get2.status);
    const getAnon = await call('GET', '/storage/v1/object/authenticated/' + path, {token: anon});
    const getNo = await call('GET', '/storage/v1/object/authenticated/' + path);
    ok(getAnon.status >= 400 && getNo.status >= 400 && !getAnon.buf.equals(img), 'anonymous login / no login cannot download it', [getAnon.status, getNo.status]);

    const delAnon = await call('DELETE', '/storage/v1/object/expense-photos', {token: anon, body: {prefixes: [`${biz}/qa-receipt.jpg`]}});
    ok(Array.isArray(delAnon.json) && delAnon.json.length === 0 && sql(`select count(*) from storage.objects where name='${biz}/qa-receipt.jpg'`) === '1', 'anonymous delete removes nothing (answer [])', delAnon.json);
    const del = await call('DELETE', '/storage/v1/object/expense-photos', {token: owner, body: {prefixes: [`${biz}/qa-receipt.jpg`]}});
    ok(Array.isArray(del.json) && del.json.length === 1 && del.json[0].name === `${biz}/qa-receipt.jpg`, 'owner deletes it (answer lists the removed object)', del.json);
    const after = await call('GET', '/storage/v1/object/authenticated/' + path, {token: owner});
    ok(after.status >= 400 && sql(`select count(*) from storage.objects where name='${biz}/qa-receipt.jpg'`) === '0', 'gone after the delete', after.status);

    // ---- public bucket still works (menu photos)
    const mpath = `menu-images/${biz}/qa-menu.jpg`;
    const mup = await call('POST', '/storage/v1/object/' + mpath, {token: owner, body: img, headers: {'Content-Type': 'image/jpeg', 'x-upsert': 'true'}});
    const mget = await call('GET', '/storage/v1/object/public/' + mpath);
    ok(mup.status === 200 && mget.status === 200 && mget.buf.equals(img), 'menu-images: owner upload + public URL work', [mup.status, mget.status]);
    const mAnon = await call('POST', `/storage/v1/object/menu-images/${biz}/anon.jpg`, {token: anon, body: img, headers: {'Content-Type': 'image/jpeg'}});
    ok(mAnon.status >= 400, 'menu-images: an anonymous login cannot upload', mAnon.status);
  }catch(e){ H.abort(NAME, e); }
  process.exit(H.summary(NAME));
})();
