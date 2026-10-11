// Test-only stand-in for Supabase (Auth + PostgREST subset + Storage) backed by the local
// PostgreSQL test database. Also serves the app files. NOT part of the delivered app.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 8787);
// Test database this stand-in talks to (default 'cccc'). Lets several stand-ins run side by side,
// each on its own port + database:  PORT=8791 FAKE_DB=db_bo node tests/fake-supabase/server.js
const DB = process.env.FAKE_DB || 'cccc';
if(!/^[a-z_][a-z0-9_]*$/.test(DB)){ console.error('FAKE_DB must be a plain lowercase database name, got: ' + DB); process.exit(1); }
const ROOT = path.resolve(__dirname, '..', '..');   // the repository root
const ANON_KEY = 'test-anon-key';
const storage = new Map();
let requestLog = [];

function lit(v){
  if(v === null || v === undefined) return 'NULL';
  if(typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function runSql(sql){
  return new Promise((resolve) => {
    const child = execFile('psql', ['-h','/tmp','-p','54329','-U','postgres','-d',DB,'-At','-q','-v','ON_ERROR_STOP=1','-f','-'],
      {maxBuffer: 64*1024*1024}, (err, stdout, stderr) => {
        const line = (stdout||'').split('\n').find(l => l.startsWith('@@R@@'));
        if(err || !line){
          const m = /ERROR:\s+(.*)/.exec(stderr||'') || [null, (stderr||String(err)).trim()];
          resolve({error: m[1]});
        } else resolve({data: line.slice(5)});
      });
    child.stdin.end(sql);
  });
}
function b64(o){ return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function unb64(s){ try{ return JSON.parse(Buffer.from(s, 'base64url').toString()); }catch(e){ return null; } }
function issueSession(user){
  const exp = Math.floor(Date.now()/1000) + Number(process.env.TOKEN_TTL || 3600);
  return {
    access_token: 'fake.' + b64({sub: user.id, is_anonymous: !!user.is_anonymous, exp}),
    refresh_token: 'refresh.' + b64({sub: user.id, is_anonymous: !!user.is_anonymous, n: Math.random()}),
    token_type: 'bearer', expires_in: 3600, expires_at: exp,
    user: {id: user.id, email: user.email || null, is_anonymous: !!user.is_anonymous},
  };
}
function claimsFrom(req){
  const auth = req.headers['authorization'] || '';
  const tok = auth.replace(/^Bearer\s+/i, '');
  if(!tok.startsWith('fake.')) return null;
  const c = unb64(tok.slice(5));
  if(!c || c.exp < Date.now()/1000) return {expired: true};
  return c;
}
function wrap(req, inner){
  const c = claimsFrom(req);
  const claims = c && !c.expired ? JSON.stringify({sub: c.sub, role: 'authenticated', is_anonymous: c.is_anonymous}) : '';
  const headers = JSON.stringify(Object.fromEntries(Object.entries(req.headers).map(([k,v]) => [k.toLowerCase(), String(v)])));
  const role = c && !c.expired ? 'authenticated' : 'anon';
  return `begin;
select set_config('request.jwt.claims', ${lit(claims)}, true);
select set_config('request.headers', ${lit(headers)}, true);
set local role ${role};
select '@@R@@' || coalesce((${inner})::text, 'null');
commit;`;
}
function send(res, status, body, headers){
  res.writeHead(status, Object.assign({'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}, headers || {}));
  res.end(body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)));
}
function readBody(req){
  return new Promise(r => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => r(Buffer.concat(chunks))); });
}
function errStatus(msg){
  if(/row-level security|permission denied/i.test(msg)) return [403, '42501'];
  return [400, 'P0001'];
}

const OPS = {eq:'=', neq:'<>', gt:'>', gte:'>=', lt:'<', lte:'<=', like:'like', ilike:'ilike'};
function buildSelect(table, params){
  if(!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('bad table');
  const where = []; let order = ''; let limit = ''; let offset = '';
  for(const [k, v] of params){
    if(k === 'select') continue;
    if(k === 'order'){
      order = ' order by ' + v.split(',').map(p => { const [c, d] = p.split('.'); if(!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error('bad col'); return `"${c}" ${d==='desc'?'desc':'asc'}`; }).join(', ');
      continue;
    }
    if(k === 'limit'){ limit = ' limit ' + Number(v); continue; }
    if(k === 'offset'){ offset = ' offset ' + Number(v); continue; }
    if(!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error('bad col ' + k);
    const dot = v.indexOf('.'); const op = v.slice(0, dot); const val = v.slice(dot+1);
    if(OPS[op]) where.push(`"${k}" ${OPS[op]} ${lit(op.endsWith('like') ? val.replace(/\*/g, '%') : val)}`);
    else if(op === 'in'){
      const inner = val.replace(/^\(/, '').replace(/\)$/, '');
      const items = inner.match(/"([^"]*)"|[^,]+/g) || [];
      where.push(`"${k}" in (${items.map(i => lit(i.replace(/^"|"$/g, ''))).join(',')})`);
    } else if(op === 'is') where.push(`"${k}" is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`);
    else throw new Error('unsupported op ' + op);
  }
  return `(select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select * from public."${table}"${where.length ? ' where ' + where.join(' and ') : ''}${order}${limit}${offset}) t)`;
}

const MIME = {'.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png'};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if(req.method === 'OPTIONS'){ return send(res, 204, '', {'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'}); }
  requestLog.push(req.method + ' ' + p);
  try{
    // ---------- test helpers ----------
    if(p === '/__log'){ const l = requestLog; requestLog = []; return send(res, 200, l); }
    if(p === '/__sql' && req.method === 'POST'){
      const sql = (await readBody(req)).toString();
      const r = await runSql(`select '@@R@@' || coalesce((${sql})::text, 'null');`);
      return r.error ? send(res, 400, {message: r.error}) : send(res, 200, r.data);
    }
    // ---------- auth ----------
    if(p.startsWith('/auth/v1/')){
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if(p === '/auth/v1/signup'){
        if(!body.email){
          if(process.env.NO_ANON) return send(res, 422, {code: 422, error_code: 'anonymous_provider_disabled', msg: 'Anonymous sign-ins are disabled'});
          const r = await runSql(`with u as (insert into auth.users(is_anonymous, raw_user_meta_data) values (true, ${lit(body.data||{})}) returning id) select '@@R@@' || id::text from u;`);
          if(r.error) return send(res, 500, {msg: r.error});
          return send(res, 200, issueSession({id: r.data, is_anonymous: true}));
        }
        const r = await runSql(`with u as (insert into auth.users(email, encrypted_password, raw_user_meta_data) values (${lit(body.email)}, extensions.crypt(${lit(body.password)}, extensions.gen_salt('bf')), ${lit(body.data||{})}) returning id) select '@@R@@' || id::text from u;`);
        if(r.error) return send(res, 422, {code: 422, msg: 'User already registered'});
        return send(res, 200, issueSession({id: r.data, email: body.email}));
      }
      if(p === '/auth/v1/token'){
        const grant = url.searchParams.get('grant_type');
        if(grant === 'password'){
          const r = await runSql(`select '@@R@@' || coalesce((select id::text from auth.users where email = ${lit(body.email)} and encrypted_password = extensions.crypt(${lit(body.password)}, encrypted_password)), 'none');`);
          if(r.data === 'none' || r.error) return send(res, 400, {code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials'});
          return send(res, 200, issueSession({id: r.data, email: body.email}));
        }
        if(grant === 'refresh_token'){
          const c = unb64(String(body.refresh_token||'').replace(/^refresh\./, ''));
          if(!c) return send(res, 400, {error: 'invalid_grant', error_description: 'Invalid Refresh Token'});
          return send(res, 200, issueSession({id: c.sub, is_anonymous: c.is_anonymous}));
        }
      }
      if(p === '/auth/v1/logout') return send(res, 204, '');
      if(p === '/auth/v1/recover') return send(res, 200, {});
      return send(res, 404, {msg: 'not found'});
    }
    // ---------- REST ----------
    if(p.startsWith('/rest/v1/')){
      const c = claimsFrom(req);
      if(c && c.expired) return send(res, 401, {code: 'PGRST301', message: 'JWT expired'});
      if(p.startsWith('/rest/v1/rpc/')){
        const fn = p.slice('/rest/v1/rpc/'.length);
        if(!/^[a-z_][a-z0-9_]*$/.test(fn)) return send(res, 400, {message: 'bad fn'});
        const args = JSON.parse((await readBody(req)).toString() || '{}');
        const argSql = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
        const r = await runSql(wrap(req, `select to_jsonb(public."${fn}"(${argSql}))`));
        if(r.error){ const [st, code] = errStatus(r.error); return send(res, st, {code, message: r.error}); }
        return send(res, 200, r.data);
      }
      const table = p.slice('/rest/v1/'.length);
      if(req.method !== 'GET') return send(res, 405, {message: 'only GET supported in the fake'});
      const r = await runSql(wrap(req, buildSelect(table, url.searchParams)));
      if(r.error){ const [st, code] = errStatus(r.error); return send(res, st, {code, message: r.error}); }
      return send(res, 200, r.data);
    }
    // ---------- storage ----------
    if(p.startsWith('/storage/v1/object/')){
      if(req.method === 'POST'){
        const key = p.slice('/storage/v1/object/'.length);
        storage.set(key, {type: req.headers['content-type'], body: await readBody(req)});
        return send(res, 200, {Key: key});
      }
      const key = p.slice('/storage/v1/object/public/'.length);
      const f = storage.get(key);
      if(!f) return send(res, 404, {message: 'not found'});
      res.writeHead(200, {'Content-Type': f.type}); return res.end(f.body);
    }
    // ---------- static app files ----------
    if(p === '/cccc/shared/config.js'){
      res.writeHead(200, {'Content-Type': MIME['.js']});
      return res.end(`window.CCCC_CONFIG = {SUPABASE_URL: 'http://localhost:${PORT}', SUPABASE_ANON_KEY: '${ANON_KEY}', APP_VERSION: 'test'};`);
    }
    let file = path.join(ROOT, decodeURIComponent(p));
    if(!file.startsWith(ROOT)) return send(res, 403, 'no');
    if(fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if(!fs.existsSync(file)) return send(res, 404, 'not found', {'Content-Type': 'text/plain'});
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
    fs.createReadStream(file).pipe(res);
  }catch(e){
    console.error(e);
    send(res, 500, {message: String(e.message || e)});
  }
});
server.listen(PORT, () => console.log('fake supabase on ' + PORT + ' (database ' + DB + ', pid ' + process.pid + ')'));
