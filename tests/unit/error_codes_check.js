// Unit check (node, no browser, no database): every error code the database script can send to an app
// has a plain-language text in THAT app (CLAUDE.md: "Errors shown to people use plain words").
//   Counter (cccc/front)     -> ERROR_TEXT in cccc/shared/ui.js (friendlyError)
//   Back Office (cccc/back)  -> ERROR_TEXT + the extra texts added in cccc/back/bo-core.js
//   QR page (cccc/order)     -> MSG / errText in cccc/order/order.js
// Codes are read from cccc/supabase/004_cccc_online_qr.sql and later scripts (005, 006, 007...) ("raise exception 'CODE'" and
// "'error', 'CODE'"), per server function, following calls to other public.<function>(...) inside it.
// The functions each app calls are read from its cloud.rpc('<name>' ...) calls.
// Run:  node tests/unit/error_codes_check.js [repo path]
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Codes that only appear when OUR OWN app sends a malformed request (a programming mistake, not
// something a person can cause), so a generic "Something went wrong" is acceptable:
const INTERNAL = new Set(['BAD_CONFLICT_MODE', 'UNKNOWN_OP', 'BAD_ACTION', 'BAD_OP', 'BAD_COLUMN', 'TABLE_NOT_ALLOWED', 'BAD_PURPOSE',
  'BAD_DEVICE_KEY',      // the counter always makes a 36-character key
  'ALREADY_A_USER']);    // the counter always pairs with its own anonymous login

// 004, then every later numbered script (005, 006, 007...): a function re-created in a later script
// replaces the earlier definition (as on the database).
const SQL_FILES = fs.readdirSync(path.join(ROOT, 'cccc/supabase')).filter(f => /^\d{3}_.*\.sql$/.test(f) && f >= '004').sort();
const blocks = {};
// create or replace function public.<name>(...) ... as $$ <body> $$;
const re = /create or replace function public\.([a-z_0-9]+)\s*\([\s\S]*?\$\$([\s\S]*?)\$\$;/g;
for(const f of SQL_FILES){
  const sqlText = read('cccc/supabase/' + f), here = {};
  let m;
  while((m = re.exec(sqlText))) here[m[1]] = (here[m[1]] || '') + m[2];
  Object.assign(blocks, here);
}
const own = {};
for(const [fn, body] of Object.entries(blocks)){
  const codes = new Set();
  for(const x of body.matchAll(/raise exception '([A-Z][A-Z_]{2,})/g)) codes.add(x[1]);
  for(const x of body.matchAll(/'error',\s*'([A-Z][A-Z_]{2,})'/g)) codes.add(x[1]);
  own[fn] = {codes, calls: new Set([...body.matchAll(/public\.([a-z_0-9]+)\s*\(/g)].map(x => x[1]).filter(n => n !== fn && blocks[n]))};
}
function reach(fn, seen){
  seen = seen || new Set(); if(seen.has(fn) || !own[fn]) return new Set(); seen.add(fn);
  const out = new Set(own[fn].codes);
  own[fn].calls.forEach(c => reach(c, seen).forEach(x => out.add(x)));
  return out;
}
function rpcsOf(files){ const s = files.map(read).join('\n'); return [...new Set([...s.matchAll(/rpc\('([a-z_0-9]+)'/g)].map(x => x[1]))]; }

// texts available in each app
const ctx = {console}; ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(read('cccc/shared/ui.js'), ctx);
const ERROR_TEXT = Object.assign({}, vm.runInContext('ERROR_TEXT', ctx));
const boExtra = read('cccc/back/bo-core.js').match(/const extra = \{([\s\S]*?)\};/);
const boKeys = new Set(boExtra ? [...boExtra[1].matchAll(/([A-Z][A-Z_]{2,}):/g)].map(x => x[1]) : []);
const orderSrc = read('cccc/order/order.js');
const qrKeys = new Set([...orderSrc.matchAll(/\b([A-Z][A-Z_]{2,})\s*:/g)].map(x => x[1]).concat([...orderSrc.matchAll(/code === '([A-Z_]+)'/g)].map(x => x[1])));

const backDir = fs.readdirSync(path.join(ROOT, 'cccc/back')).filter(f => f.endsWith('.js')).map(f => 'cccc/back/' + f);
const APPS = [
  {name: 'counter (cccc/front)', rpcs: rpcsOf(['cccc/front/front.js']), has: (c) => !!ERROR_TEXT[c]},
  {name: 'Back Office (cccc/back)', rpcs: rpcsOf(backDir), has: (c) => !!ERROR_TEXT[c] || boKeys.has(c)},
  {name: 'QR page (cccc/order)', rpcs: rpcsOf(['cccc/order/order.js']), has: (c) => qrKeys.has(c)},
];
let checks = 0, failed = 0;
for(const app of APPS){
  const missing = [];
  for(const fn of app.rpcs){
    if(!own[fn]){ checks++; failed++; console.log(`FAIL ${app.name}: calls ${fn}() which the database script does not define`); continue; }
    [...reach(fn)].filter(c => !INTERNAL.has(c) && !app.has(c)).forEach(c => missing.push(c + ' (from ' + fn + ')'));
  }
  checks++;
  if(missing.length){ failed++; console.log(`FAIL ${app.name}: server codes shown without a plain-language text: ${[...new Set(missing)].join(', ')}`); }
  else console.log(`ok   ${app.name}: every server code from ${app.rpcs.length} functions has a plain-language text`);
}
// the later scripts are really read: 007's pay-in / pay-out code reaches the counter's fo_sync
checks++;
if(reach('fo_sync').has('AMOUNT_NOT_POSITIVE') && ERROR_TEXT.AMOUNT_NOT_POSITIVE) console.log('ok   007: AMOUNT_NOT_POSITIVE reachable from fo_sync and has a counter text: ' + ERROR_TEXT.AMOUNT_NOT_POSITIVE);
else { failed++; console.log('FAIL 007: AMOUNT_NOT_POSITIVE not reachable from fo_sync, or no counter text'); }
console.log(`SUMMARY unit/error_codes_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
