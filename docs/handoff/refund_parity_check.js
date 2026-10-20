// Parity check: refundAmountForItems() in cccc/shared/logic.js against the database's
// _refund_items_cap() (cccc/supabase/004_cccc_online_qr.sql) on the LOCAL test database.
// Random realistic sales (made with computeSaleTotals, stored the way the counter sends them),
// earlier refunds, then one more refund; the server's answer must equal the JS answer.
// Everything runs inside one transaction that is rolled back.
// Run:  node refund_parity_check.js [repo path] [database] [cases]
const fs = require('fs');
const vm = require('vm');
const {execFileSync} = require('child_process');
const crypto = require('crypto');
const ROOT = process.argv[2] || '/home/claude/coffee-shop-system';
const DB = process.argv[3] || 'db_core';
const N = Number(process.argv[4] || 500);
// 'rounded': store the subtotal rounded to centavos (what the database would see if the counter, or
// _refund_items_cap, rounded it) - shows that the float noise in stored subtotals is the only difference.
const ROUNDED = process.argv[5] === 'rounded';

const ctx = {console, Math, JSON, Number, Object, Array, isFinite, Cloud: {uuid: () => crypto.randomUUID()},
  localStorage: {getItem: () => null, setItem: () => {}, removeItem: () => {}}};
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/ui.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/logic.js', 'utf8'), ctx);
const {refundAmountForItems, refundPriorFor, computeSaleTotals} = ctx;

let seed = 20261012;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const psql = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-Atq'], {input: sql, encoding: 'utf8', maxBuffer: 1 << 26});
const biz = psql('select id from public.businesses order by created_at limit 1;').trim();
if(!biz) throw new Error('no business in ' + DB + ' (run tests/e2e_reset.sh ' + DB + ')');
const lit = (v) => v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'";

const cases = [];
let sql = 'begin;\n';
for(let c = 0; c < N; c++){
  const nLines = 1 + Math.floor(rnd() * 4);
  const lines = [];
  for(let i = 0; i < nLines; i++){
    const price = pick([35, 49.5, 55, 65.25, 89.99, 95.5, 110, 120, 135.75, 150, 165, 180, 199.95, 245.33, 0]) + (rnd() < 0.2 ? Math.floor(rnd() * 100) / 100 : 0);
    lines.push({price: Math.round(price * 100) / 100, qty: 1 + Math.floor(rnd() * 3)});
  }
  const discount = pick([null, null, {type: 'percent', value: pick([5, 10, 12.5, 15, 20, 33, 50])}, {type: 'fixed', value: pick([10, 25, 33.33, 50, 77.77])}]);
  const settings = {tax_pct: pick([0, 12, 12]), service_charge_pct: pick([0, 5, 10]), tax_inclusive: rnd() < 0.2};
  const t = computeSaleTotals(lines.map(l => ({unit_price: l.price, quantity: l.qty})), discount, settings);
  const saleId = crypto.randomUUID();
  if(ROUNDED) t.subtotal = ctx.roundMoney(t.subtotal);
  const sale = {id: saleId, subtotal: t.subtotal, grand_total: t.grandTotal};
  const items = lines.map(l => ({id: crypto.randomUUID(), unit_price: l.price, quantity: l.qty, line_total: l.price * l.qty}));
  sql += `insert into public.sales(id, business_id, status, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total) values (${lit(saleId)}, ${lit(biz)}, 'COMPLETED', ${JSON.stringify(t.subtotal)}, ${JSON.stringify(t.discountAmt)}, ${JSON.stringify(t.tax)}, ${JSON.stringify(t.serviceCharge)}, ${JSON.stringify(t.grandTotal)});\n`;
  items.forEach(it => {
    sql += `insert into public.sale_items(id, business_id, sale_id, name, quantity, unit_price, line_total) values (${lit(it.id)}, ${lit(biz)}, ${lit(saleId)}, 'x', ${JSON.stringify(it.quantity)}, ${JSON.stringify(it.unit_price)}, ${JSON.stringify(it.line_total)});\n`;
  });
  // 0-2 earlier refunds, each returning some of what is still there
  const refunds = [];
  const nPrior = Math.floor(rnd() * 3);
  for(let p = 0; p < nPrior; p++){
    const prior = refundPriorFor(saleId, refunds);
    const ri = [];
    items.forEach(it => { const leftQ = it.quantity - (prior.quantities[it.id] || 0); if(leftQ > 0 && rnd() < 0.4) ri.push({sale_item_id: it.id, quantity: 1 + Math.floor(rnd() * leftQ)}); });
    if(!ri.length) continue;
    const amount = refundAmountForItems(sale, items, ri, prior);
    const r = {id: crypto.randomUUID(), sale_id: saleId, amount, items: ri};
    refunds.push(r);
    sql += `insert into public.refunds(id, business_id, sale_id, type, amount, items) values (${lit(r.id)}, ${lit(biz)}, ${lit(saleId)}, 'PARTIAL_REFUND', ${JSON.stringify(amount)}, ${lit(JSON.stringify(ri))}::jsonb);\n`;
  }
  // the refund now: random lines, sometimes too many, sometimes everything, sometimes a foreign line
  const prior = refundPriorFor(saleId, refunds);
  let now = [];
  const mode = rnd();
  if(mode < 0.2) now = items.map(it => ({sale_item_id: it.id, quantity: it.quantity}));            // everything (void-like)
  else items.forEach(it => { if(rnd() < 0.5) now.push({sale_item_id: it.id, quantity: 1 + Math.floor(rnd() * (it.quantity + (mode > 0.9 ? 2 : 0)))}); });
  if(mode > 0.95) now.push({sale_item_id: crypto.randomUUID(), quantity: 1});
  if(!now.length) now.push({sale_item_id: items[0].id, quantity: 1});
  const js = refundAmountForItems(sale, items, now, prior);
  const refundId = crypto.randomUUID();
  cases.push({c, js, sale, lines, discount, settings, prior, now});
  sql += `select ${c} || '|' || coalesce(public._refund_items_cap(s, ${lit(refundId)}::uuid, ${lit(JSON.stringify(now))}::jsonb,
            greatest(coalesce(s.grand_total, 0) - (select coalesce(sum(amount), 0) from public.refunds where sale_id = s.id), 0))::text, 'null')
          from public.sales s where s.id = ${lit(saleId)};\n`;
}
sql += 'rollback;\n';
const out = psql(sql).trim().split('\n').filter(Boolean);
let failed = 0, exact = 0;
const byCase = new Map(out.map(l => { const [c, v] = l.split('|'); return [Number(c), v]; }));
for(const k of cases){
  const sv = byCase.get(k.c);
  const server = sv === 'null' ? null : Number(sv);
  if(server !== null && Math.abs(server - k.js) < 0.000001){ exact++; continue; }
  failed++;
  if(failed <= 10) console.log('MISMATCH case ' + k.c + ': js ' + k.js + ' server ' + sv + ' ' + JSON.stringify({sale: k.sale, discount: k.discount, settings: k.settings, prior: k.prior, now: k.now}));
}
console.log(`${exact} of ${cases.length} random refunds: logic.js and the database give the same amount`);
console.log(`SUMMARY refund_parity_check: ${cases.length} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
