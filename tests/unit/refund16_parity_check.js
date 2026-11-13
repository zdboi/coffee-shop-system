// Release 1.6 parity check (Z, 2026-11-13; asked for by the lead with the gate fixes): refundAmountForItems() in
// cccc/shared/logic.js against the database's _refund_items_cap() (013) on sales WITH Senior / PWD lines, in shops
// with no tax, 12% VAT inside the prices and 12% tax on top, service charge 0/5/10%, sometimes a GCash 2% charge
// (added or waived). Sales made with computeSaleTotals (as the counter sends them). Per sale:
//   (a) a random partial refund (after 0-2 earlier ones): server = JS to the centavo
//   (b) every line refunded on its own (from a fresh sale): the shares add up to at most the grand total (+1 centavo
//       a line for rounding), and the TAX inside those refunds (_refund_tax_part, used by accounting_report) adds up
//       to at most the sale's tax, with nothing taken back on a Senior / PWD line in a tax-on-top shop
//   (c) a Senior / PWD line refunded on its own in a tax-on-top shop gives back no tax: share x tax-free factor
// Everything runs inside one transaction that is rolled back.
// Run (needs a seeded database, e.g. tests/e2e_reset.sh cccc):  node tests/unit/refund16_parity_check.js [repo] [database] [cases]
const fs = require('fs');
const vm = require('vm');
const {execFileSync} = require('child_process');
const crypto = require('crypto');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const DB = process.argv[3] || process.env.FAKE_DB || 'cccc';
if(!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('database name must be plain lowercase');
const N = Number(process.argv[4] || 300);
const ctx = {console, Math, JSON, Number, Object, Array, isFinite, Cloud: {uuid: () => crypto.randomUUID()},
  localStorage: {getItem: () => null, setItem: () => {}, removeItem: () => {}}};
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/ui.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/logic.js', 'utf8'), ctx);
const {refundAmountForItems, refundPriorFor, computeSaleTotals} = ctx;
let seed = 20261113;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const psql = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-Atq'], {input: sql, encoding: 'utf8', maxBuffer: 1 << 26});
const biz = psql(`select business_id from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';`).trim();
if(!biz) throw new Error('no shop in ' + DB + ' (run tests/e2e_reset.sh ' + DB + ')');
const lit = (v) => v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'";
const J = (v) => JSON.stringify(v);
const PM = [{id: 'CASH', label: 'Cash', active: true, charge_type: 'NONE', charge_value: 0},
  {id: 'GCASH', label: 'GCash', active: true, charge_type: 'PERCENT', charge_value: 2, charge_default: 'ADD'}];

const cases = [];
let sql = 'begin;\n';
const insSale = (id, t, kind, items) => {
  let q = `insert into public.sales(id, business_id, status, subtotal, discount_amount, loyalty_discount, tax_amount, service_charge_amount, grand_total, senior_kind, senior_items_amount, vat_exempt_amount, senior_discount, payment_charge, payment_fee)
    values (${lit(id)}, ${lit(biz)}, 'COMPLETED', ${J(t.subtotal)}, 0, 0, ${J(t.tax)}, ${J(t.serviceCharge)}, ${J(t.grandTotal)}, ${lit(kind)}, ${J(t.seniorItems)}, ${J(t.vatExempt)}, ${J(t.seniorDiscount)}, ${J(t.paymentCharge)}, ${J(t.paymentFee)});\n`;
  items.forEach(it => { q += `insert into public.sale_items(id, business_id, sale_id, name, quantity, unit_price, line_total, senior_discount) values (${lit(it.id)}, ${lit(biz)}, ${lit(id)}, 'x', ${J(it.quantity)}, ${J(it.unit_price)}, ${J(it.line_total)}, ${J(it.senior_discount)});\n`; });
  return q;
};
for(let c = 0; c < N; c++){
  const nLines = 2 + Math.floor(rnd() * 3);
  const lines = [];
  for(let i = 0; i < nLines; i++) lines.push({unit_price: pick([55, 65.25, 89.99, 110, 120, 135.75, 150, 165, 199.95]), quantity: 1 + Math.floor(rnd() * 3), senior: false});
  lines.forEach(l => { if(rnd() < 0.45) l.senior = true; });
  if(!lines.some(l => l.senior)) lines[0].senior = true;
  if(lines.every(l => l.senior) && rnd() < 0.7) lines[lines.length - 1].senior = false;
  const shop = pick(['none', 'inclusive', 'ontop', 'ontop']);
  const settings = {tax_pct: shop === 'none' ? 0 : 12, tax_inclusive: shop === 'inclusive', service_charge_pct: pick([0, 5, 10]), senior_discount_pct: 20, payment_methods: PM};
  const pay = rnd() < 0.4 ? {payment: {method: 'GCASH', waive: rnd() < 0.3}} : undefined;
  const t = computeSaleTotals(lines, null, settings, 0, pay);
  const saleId = crypto.randomUUID();
  const items = lines.map((l, i) => ({id: crypto.randomUUID(), unit_price: l.unit_price, quantity: l.quantity, line_total: l.unit_price * l.quantity, senior_discount: t.seniorLineDiscounts[i] || 0, senior: l.senior}));
  const sale = {id: saleId, subtotal: t.subtotal, grand_total: t.grandTotal, tax_amount: t.tax, vat_exempt_amount: t.vatExempt, senior_discount: t.seniorDiscount};
  sql += insSale(saleId, t, 'SENIOR', items);
  // (a) earlier refunds, then one more
  const refunds = [];
  for(let p = 0, n = Math.floor(rnd() * 3); p < n; p++){
    const prior = refundPriorFor(saleId, refunds);
    const ri = [];
    items.forEach(it => { const leftQ = it.quantity - (prior.quantities[it.id] || 0); if(leftQ > 0 && rnd() < 0.4) ri.push({sale_item_id: it.id, quantity: 1 + Math.floor(rnd() * leftQ)}); });
    if(!ri.length) continue;
    const amount = refundAmountForItems(sale, items, ri, prior);
    const r = {id: crypto.randomUUID(), sale_id: saleId, amount, items: ri};
    refunds.push(r);
    sql += `insert into public.refunds(id, business_id, sale_id, type, amount, items) values (${lit(r.id)}, ${lit(biz)}, ${lit(saleId)}, 'PARTIAL_REFUND', ${J(amount)}, ${lit(J(ri))}::jsonb);\n`;
  }
  const prior = refundPriorFor(saleId, refunds);
  const now = [];
  items.forEach(it => { if(rnd() < 0.5) now.push({sale_item_id: it.id, quantity: 1 + Math.floor(rnd() * it.quantity)}); });
  if(!now.length) now.push({sale_item_id: items[0].id, quantity: 1});
  const js = refundAmountForItems(sale, items, now, prior);
  sql += `select 'A|${c}|' || coalesce(public._refund_items_cap(s, gen_random_uuid(), ${lit(J(now))}::jsonb,
            greatest(coalesce(s.grand_total, 0) - (select coalesce(sum(amount), 0) from public.refunds where sale_id = s.id), 0))::text, 'null')
          from public.sales s where s.id = ${lit(saleId)};\n`;
  // (b) + (c) a fresh copy of the sale: each line refunded on its own (one refund row per line)
  const copyId = crypto.randomUUID();
  const copyItems = items.map(it => Object.assign({}, it, {id: crypto.randomUUID()}));
  sql += insSale(copyId, t, 'SENIOR', copyItems);
  const copySale = Object.assign({}, sale, {id: copyId});
  const perLine = copyItems.map(it => refundAmountForItems(copySale, copyItems, [{sale_item_id: it.id, quantity: it.quantity}], {amount: 0, quantities: {}}));
  copyItems.forEach((it, i) => {
    sql += `insert into public.refunds(id, business_id, sale_id, type, amount, items) values (gen_random_uuid(), ${lit(biz)}, ${lit(copyId)}, 'PARTIAL_REFUND', ${J(perLine[i])}, ${lit(J([{sale_item_id: it.id, quantity: it.quantity}]))}::jsonb);\n`;
  });
  sql += `select 'B|${c}|' || coalesce(sum(public._refund_tax_part(s, r)), 0)::text || '|' || coalesce(sum(public._refund_tax_part(s, r)) filter (where exists (select 1 from public.sale_items si where si.sale_id = s.id and si.senior_discount > 0 and r.items->0->>'sale_item_id' = si.id::text)), 0)::text
          from public.sales s join public.refunds r on r.sale_id = s.id where s.id = ${lit(copyId)} group by s.id;\n`;
  cases.push({c, js, t, shop, items, perLine, now, prior, settings, pay});
}
sql += 'rollback;\n';
const out = psql(sql).trim().split('\n').filter(Boolean);
const A = new Map(), B = new Map();
out.forEach(l => { const p = l.split('|'); if(p[0] === 'A') A.set(Number(p[1]), p[2]); else if(p[0] === 'B') B.set(Number(p[1]), [Number(p[2]), Number(p[3])]); });
let checks = 0, failed = 0, shown = 0;
const fail = (name, info) => { failed++; if(shown++ < 8) console.log('FAIL ' + name + ' ' + JSON.stringify(info).slice(0, 600)); };
for(const k of cases){
  checks++;
  const sv = A.get(k.c);
  if(!(sv !== undefined && sv !== 'null' && Math.abs(Number(sv) - k.js) < 0.000001)) fail(`(a) case ${k.c}: server ${sv} js ${k.js}`, {shop: k.shop, t: k.t, now: k.now, prior: k.prior});
  checks++;
  const sum = k.perLine.reduce((s, x) => s + x, 0);
  if(sum > k.t.grandTotal + 0.01 * k.items.length + 1e-9) fail(`(b) case ${k.c}: line shares ${sum.toFixed(2)} > total ${k.t.grandTotal}`, {shop: k.shop, perLine: k.perLine});
  checks++;
  const [taxBack, taxOnSenior] = B.get(k.c) || [NaN, NaN];
  if(!(taxBack <= k.t.tax + 0.01 && (k.shop !== 'ontop' || Math.abs(taxOnSenior) < 0.000001))) fail(`(b) case ${k.c}: tax in refunds ${taxBack} (tax ${k.t.tax}), on Senior lines ${taxOnSenior}`, {shop: k.shop});
  // (c) tax on top: a Senior line alone gives back its share of (grand total - tax) only
  if(k.shop === 'ontop'){
    k.items.forEach((it, i) => {
      if(!(it.senior_discount > 0) || k.items.length < 2) return;
      checks++;
      const S = Math.round((k.t.subtotal - k.t.vatExempt - k.t.seniorDiscount) * 100) / 100;
      const T = Math.min(k.t.grandTotal, Math.round(k.t.tax * 100) / 100);   // the tax as stored, in centavos
      const want = Math.round((it.line_total - it.senior_discount) * (k.t.grandTotal - T) / S * 100) / 100;
      if(Math.abs(k.perLine[i] - want) > 0.000001) fail(`(c) case ${k.c} line ${i}: ${k.perLine[i]} want ${want}`, {t: k.t});
    });
  }
}
console.log(`${cases.length} Senior / PWD sales (${cases.filter(k => k.shop === 'ontop').length} tax on top, ${cases.filter(k => k.shop === 'inclusive').length} VAT inside, ${cases.filter(k => k.pay).length} with a GCash charge)`);
console.log(`SUMMARY unit/refund16_parity_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
