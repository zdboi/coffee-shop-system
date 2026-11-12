// Parity (release 1.5, B9): logic.js buildStockCountData + countDifferences vs the server's stock_count (fo_sync, 012).
// Run: node tests/unit/count_parity_check.js <repo> <database>   (needs a freshly seeded shop: tests/e2e_reset.sh <db>; it changes
// data: ticks items, opens and closes a shift; adopted by Z 2026-11-12 from the shared-core work)
// Also: count queued BEFORE shift_close in one upload is accepted; shift_close alone -> COUNT_REQUIRED;
// same op_id -> duplicate; same data.id + new op_id -> skipped.
const fs = require('fs'), vm = require('vm'), {execFileSync} = require('child_process'), crypto = require('crypto');
const path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..'), DB = process.argv[3] || 'cccc';
if(!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('database name must be plain lowercase');
const psqlRaw = (args) => execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1'].concat(args), {encoding: 'utf8', env: Object.assign({}, process.env, {PGOPTIONS: '-c client_min_messages=warning'})}).trim();
const BIZ = psqlRaw(['-c', "select business_id from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'"]);
if(!BIZ) throw new Error('no seeded shop in ' + DB + ' (run tests/e2e_reset.sh ' + DB + ' first)');
// the fixture (once per database)
if(psqlRaw(['-c', "select count(*) from public.ingredients where id = 'a0000000-0000-0000-0000-000000000001'"]) === '0') psqlRaw(['-q', '-f', path.join(__dirname, 'parity15', 'fixture.sql')]);
if(psqlRaw(['-c', "select count(*) from public.devices where device_name = 'Core counter'"]) === '0') psqlRaw(['-q', '-f', path.join(__dirname, 'parity15', 'count_setup.sql')]);
const DEV_UID = '00000000-0000-0000-0000-0000000000c5', KEY = 'device-key-core-0001-abcdef';
const CASHIER = '66666666-0000-0000-0000-000000000001';
const psql = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {encoding: 'utf8'}).trim();
const q = (sql) => JSON.parse(psql(sql) || 'null');
const sync = (ops) => JSON.parse(psql(`select set_config('request.jwt.claims', json_build_object('sub', '${DEV_UID}', 'role', 'authenticated')::text, false); select public.fo_sync('${KEY}', '${JSON.stringify(ops).replace(/'/g, "''")}'::jsonb)`).split('\n').pop());
const ctx = {console, Intl, Date, Cloud: {uuid: () => crypto.randomUUID()}, localStorage: {getItem: () => null, setItem() {}, removeItem() {}}};
ctx.window = ctx; vm.createContext(ctx);
for(const f of ['ui.js', 'logic.js']) vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/' + f, 'utf8'), ctx);
let checks = 0, failed = 0;
const eq = (name, got, want) => { checks++; const g = JSON.stringify(got), w = JSON.stringify(want);
  if(g === w) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name + '\n     got  ' + g + '\n     want ' + w); } };
const A = (n) => 'a0000000-0000-0000-0000-00000000000' + n;
// tick Sugar (kg), Milk (mL) and Vanilla (mL); give them stock
psql(`update ingredients set count_at_close = (id in ('${A(1)}','${A(2)}','${A(5)}')) where business_id = '${BIZ}';
  insert into inventory_transactions(business_id, ingredient_id, transaction_type, quantity, transaction_date)
  values ('${BIZ}','${A(1)}','INITIAL_STOCK',4.25,'2026-11-10'),('${BIZ}','${A(2)}','INITIAL_STOCK',2000,'2026-11-10'),
         ('${BIZ}','${A(5)}','INITIAL_STOCK',100,'2026-11-10'),('${BIZ}','${A(2)}','PARTNER_RETURN',333.3,'2026-11-10')`);
const st = vm.runInContext('state', ctx);
const cats = q(`select json_agg(c) from categories c where business_id = '${BIZ}'`);
Object.assign(st, {settings: {timezone: 'Asia/Manila'}, categories: cats, ingredients: q(`select json_agg(i) from ingredients i where business_id = '${BIZ}'`), recipes: [], recipeIngredients: []});
vm.runInContext(`setStockFromServer(${psql(`select json_agg(json_build_object('ingredient_id', ingredient_id, 'stock', stock)) from v_ingredient_stock where business_id = '${BIZ}'`)})`, ctx);
eq('client stock copy includes PARTNER_RETURN (-333.3 mL)', vm.runInContext(`state.stock['${A(2)}']`, ctx), Number(q(`select to_json(public._stock_of('${BIZ}', '${A(2)}'))`)));
// open a shift
const shift = crypto.randomUUID();
{ const so = sync([{op_id: crypto.randomUUID(), type: 'shift_open', data: {id: shift, cashier_id: CASHIER, opened_at: new Date().toISOString(), opening_cash: 0}}])[0]; eq('shift_open ok', so.status + (so.message ? ' ' + so.message : ''), 'ok'); }
// close without a count -> COUNT_REQUIRED
const closeData = {id: shift, closed_by: CASHIER, closed_at: new Date().toISOString(), declared_cash: 0};
eq('shift_close without a count -> COUNT_REQUIRED', sync([{op_id: crypto.randomUUID(), type: 'shift_close', data: closeData}])[0].message, 'COUNT_REQUIRED');
// the count, typed in mixed units
const S = (n) => vm.runInContext(`state.stock['${A(n)}']`, ctx);
ctx.__in = {shift_id: shift, staff_id: CASHIER, lines: [{ingredient_id: A(1), quantity: Math.round((S(1) - 0.15) * 1000 * 1e6) / 1e6, unit: 'g'}, {ingredient_id: A(2), quantity: (S(2) + 33.3) / 1000, unit: 'L'}, {ingredient_id: A(5), quantity: S(5)}]};
const data = vm.runInContext('buildStockCountData(__in)', ctx);
const diffs = vm.runInContext('countDifferences(__in.lines)', ctx);
eq('client differences (only the 2 that differ)', diffs.map(d => [d.ingredient_id, d.difference]), [[A(1), -0.15], [A(2), 33.3]]);
const opCount = {op_id: crypto.randomUUID(), type: 'stock_count', data};
const res = sync([opCount, {op_id: crypto.randomUUID(), type: 'shift_close', data: closeData}]);
eq('stock_count then shift_close in ONE upload: both ok', res.map(r => r.status), ['ok', 'ok']);
const lines = q(`select json_agg(json_build_object('id', ingredient_id, 'counted', counted, 'expected', expected, 'difference', difference) order by name) from stock_count_lines where count_id = '${data.id}'`);
const srvDiff = lines.filter(l => Math.abs(l.difference) > 1e-6).map(l => [l.id, Number(l.difference)]).sort();
eq('server differences = client countDifferences', srvDiff, diffs.map(d => [d.ingredient_id, d.difference]).sort());
eq('server counted (stock units) = client countLineBase', lines.map(l => [l.id, Number(l.counted)]).sort(), ctx.__in.lines.map(l => [l.ingredient_id, vm.runInContext(`countLineBase(${JSON.stringify(l)}).quantity`, ctx)]).sort());
// local stock after applying the deltas = server stock after the count
vm.runInContext('applyStockDeltas(stockCountDeltas(__in.lines))', ctx);
for(const n of [1, 2, 5]) eq('stock after count, ingredient ' + n, vm.runInContext(`Math.round(state.stock['${A(n)}'] * 1e6) / 1e6`, ctx), Number(q(`select to_json(round(public._stock_of('${BIZ}', '${A(n)}'), 6))`)));
eq('server flags COUNT_EXTRA', q(`select to_json(review_reason) from stock_counts where id = '${data.id}'`).split(', ').includes('COUNT_EXTRA'), true);
eq('same op_id again -> duplicate', sync([opCount])[0].status, 'duplicate');
eq('same data.id, new op_id -> skipped', sync([{op_id: crypto.randomUUID(), type: 'stock_count', data}])[0].status, 'skipped');
eq('fo_sync error codes all have texts', ['COUNT_REQUIRED', 'BAD_COUNT', 'FORBIDDEN_ROW'].every(c => vm.runInContext(`!!ERROR_TEXT['${c}']`, ctx)), true);
console.log(`SUMMARY unit/count_parity_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
