// Unit checks (node, no browser, no database) for cccc/shared/logic.js:
//   roundMoney, refundLeft, refundPriorFor, refundAmountForItems (owner decision 2026-10-12),
//   shiftMetrics clear sales names, SALES_LABELS, salesSummaryRows, receiptHtml words.
// Run:  node logic_refund_check.js [repo path]
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const ROOT = process.argv[2] || '/home/claude/coffee-shop-system';

let pass = 0;
function ok(cond, name){ assert.ok(cond, name); pass++; console.log('ok - ' + name); }
const norm = (x) => (x && typeof x === 'object') ? JSON.parse(JSON.stringify(x)) : x;
function eq(a, b, name){ assert.deepStrictEqual(norm(a), norm(b), name + '\n   got: ' + JSON.stringify(a) + '\n   want: ' + JSON.stringify(b)); pass++; console.log('ok - ' + name); }

const ctx = {console, Date, JSON, Math, Number, String, Object, Array, isFinite, isNaN, Set, Map,
  localStorage: {getItem: () => null, setItem: () => {}, removeItem: () => {}},
  Cloud: {uuid: () => require('crypto').randomUUID()}};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/ui.js', 'utf8'), ctx, {filename: 'ui.js'});
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/logic.js', 'utf8'), ctx, {filename: 'logic.js'});
const G = (name) => vm.runInContext(name, ctx);
const roundMoney = G('roundMoney'), refundLeft = G('refundLeft'), refundPriorFor = G('refundPriorFor');
const refundAmountForItems = G('refundAmountForItems'), computeSaleTotals = G('computeSaleTotals');
const shiftMetrics = G('shiftMetrics'), salesSummaryRows = G('salesSummaryRows'), SALES_LABELS = G('SALES_LABELS');
const receiptHtml = G('receiptHtml');
const state = G('state');

// A sale stored the way the counter stores it (computeSaleTotals -> sales row + sale_items rows).
let n = 0;
function makeSale(lines, discount, settings){
  const t = computeSaleTotals(lines.map(l => ({unit_price: l.price, quantity: l.qty})), discount || null, settings || {tax_pct: 0, service_charge_pct: 0});
  const id = 'sale-' + (++n);
  const items = lines.map((l, i) => ({id: id + '-it' + i, sale_id: id, name: l.name || ('Item ' + i), unit_price: l.price, quantity: l.qty, line_total: l.price * l.qty}));
  return {sale: {id, subtotal: t.subtotal, discount_amount: t.discountAmt, tax_amount: t.tax, service_charge_amount: t.serviceCharge, grand_total: t.grandTotal}, items};
}
const TAXSVC = {tax_pct: 12, service_charge_pct: 10, tax_inclusive: false};

/* ---------------- roundMoney ---------------- */
eq(roundMoney(1.005), 1.01, 'roundMoney(1.005) = 1.01 (naive Math.round(x*100)/100 gives 1.00)');
eq(roundMoney(2.675), 2.68, 'roundMoney(2.675) = 2.68');
eq(roundMoney(4.015), 4.02, 'roundMoney(4.015) = 4.02');
eq(roundMoney(0.125), 0.13, 'roundMoney(0.125) = 0.13 (half away from zero, like Postgres round)');
eq(roundMoney(1.00499), 1.00, 'roundMoney(1.00499) = 1.00');
eq(roundMoney(107.35999999999999), 107.36, 'binary noise removed');
eq(roundMoney(0.1 + 0.2), 0.3, '0.1 + 0.2 -> 0.30');
eq(roundMoney(-1.005), -1.01, 'negative half -> away from zero');
ok(Object.is(roundMoney(-0.001), 0), 'tiny negative -> 0 (not -0)');
eq(roundMoney('12.345'), 12.35, 'numeric text');
eq(roundMoney(NaN), 0, 'NaN -> 0'); eq(roundMoney(undefined), 0, 'undefined -> 0'); eq(roundMoney(1e-9), 0, '1e-9 -> 0');
eq(roundMoney(1234567.885), 1234567.89, 'large amount half');
eq(roundMoney(1e21), 1e21, 'huge number returned unchanged'); eq(roundMoney(12345678901234.567), 12345678901234.567, 'over ₱10 trillion unchanged'); eq(roundMoney(999999999999.995), 1000000000000, 'just under: still rounded');

/* ---------------- refundLeft ---------------- */
eq(refundLeft({grand_total: 100}, 30.333), 69.67, 'refundLeft: G - prior, centavos');
eq(refundLeft({grand_total: 100}), 100, 'refundLeft: no prior -> G');
eq(refundLeft({grand_total: 100}, 130), 0, 'refundLeft: never below 0');
eq(refundLeft({grand_total: 100}, {amount: 10}), 90, 'refundLeft: accepts {amount}');
eq(refundLeft({grand_total: 100}, -5), 100, 'refundLeft: negative prior ignored');
eq(refundLeft({grand_total: 253.76}, 107.36), 146.4, 'refundLeft: float noise removed (253.76 - 107.36)');
eq(refundLeft(null, 0), 0, 'refundLeft: no sale -> 0');

/* ---------------- QA examples ---------------- */
{
  // one ₱110 Americano from a sale with 20% off, 12% tax and 10% service -> ₱107.36
  const {sale, items} = makeSale([{name: 'Americano', price: 110, qty: 1}, {name: 'Latte', price: 150, qty: 1}], {type: 'percent', value: 20}, TAXSVC);
  eq(sale.grand_total, 253.76, 'QA ex.1 sale: S 260, -20%, +12% tax, +10% service = 253.76');
  const a = refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 1}]);
  eq(a, 107.36, 'QA ex.1: Americano gives back ₱107.36');
  const prior = {amount: a, quantities: {[items[0].id]: 1}};
  const b = refundAmountForItems(sale, items, [{sale_item_id: items[1].id, quantity: 1}], prior);
  eq(b, 146.4, 'QA ex.1: then the latte = what is left (₱146.40)');
  eq(roundMoney(a + b), sale.grand_total, 'QA ex.1: both refunds add up to the grand total');
}
{
  // a ₱200 latte, tax and service totalling ₱244, the only item -> ₱244.00
  const {sale, items} = makeSale([{name: 'Latte', price: 200, qty: 1}], null, TAXSVC);
  eq(sale.grand_total, 244, 'QA ex.2 sale total 244');
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 1}]), 244, 'QA ex.2: only item -> ₱244.00');
}

/* ---------------- discounts, tax + service ---------------- */
{
  const {sale, items} = makeSale([{price: 100, qty: 1}, {price: 200, qty: 1}], {type: 'fixed', value: 50});
  eq([sale.subtotal, sale.grand_total], [300, 250], 'fixed ₱50 off ₱300');
  const a = refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 1}]);
  eq(a, 83.33, 'fixed discount: ₱100 item -> 100 x 250/300 = ₱83.33');
  const b = refundAmountForItems(sale, items, [{sale_item_id: items[1].id, quantity: 1}], {amount: a, quantities: {[items[0].id]: 1}});
  eq(b, 166.67, 'fixed discount: rest -> what is left ₱166.67');
}
{
  const {sale, items} = makeSale([{price: 150, qty: 1}, {price: 50, qty: 1}], {type: 'percent', value: 10});
  eq(sale.grand_total, 180, '10% off ₱200');
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[1].id, quantity: 1}]), 45, 'percent discount: ₱50 item -> ₱45.00');
}
{
  const {sale, items} = makeSale([{price: 110, qty: 1}, {price: 90, qty: 1}], null, TAXSVC);
  eq(sale.grand_total, 244, 'tax+service sale 244');
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 1}]), 134.2, 'tax + service: ₱110 item -> ₱134.20');
}
{
  // tax-inclusive shop: no tax added, service still added
  const {sale, items} = makeSale([{price: 120, qty: 1}, {price: 80, qty: 1}], null, {tax_pct: 12, service_charge_pct: 10, tax_inclusive: true});
  eq(sale.grand_total, 220, 'tax-inclusive: only service added');
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[1].id, quantity: 1}]), 88, 'tax-inclusive: ₱80 item -> ₱88.00');
}

/* ---------------- several partial refunds that finish the sale ---------------- */
{
  const {sale, items} = makeSale([{price: 55, qty: 3}, {price: 95.5, qty: 1}], {type: 'percent', value: 15}, TAXSVC);
  eq(sale.grand_total, 270.14, 'multi: grand total 270.14');
  const refunds = [];
  const steps = [[0, 1], [0, 1], [1, 1], [0, 1]];
  const got = [];
  steps.forEach(([i, q]) => {
    const prior = refundPriorFor(sale.id, refunds);
    const amt = refundAmountForItems(sale, items, [{sale_item_id: items[i].id, quantity: q}], prior);
    got.push(amt);
    refunds.push({id: 'r' + refunds.length, sale_id: sale.id, amount: amt, items: [{sale_item_id: items[i].id, quantity: q}]});
  });
  eq(got, [57.04, 57.04, 99.03, 57.03], 'multi: 55 x 270.14/260.5 = 57.04 (twice), 95.50 -> 99.03, last one = what is left 57.03');
  eq(roundMoney(got.reduce((s, x) => s + x, 0)), sale.grand_total, 'multi: refunds add up to the grand total exactly');
  eq(refundLeft(sale, refundPriorFor(sale.id, refunds)), 0, 'multi: nothing left afterwards');
}
{
  // two lines returned in ONE refund, the rest later
  const {sale, items} = makeSale([{price: 120, qty: 2}, {price: 65, qty: 1}, {price: 45, qty: 2}], {type: 'fixed', value: 33.33}, TAXSVC);
  const r1 = [{sale_item_id: items[0].id, quantity: 1}, {sale_item_id: items[2].id, quantity: 2}];
  const a = refundAmountForItems(sale, items, r1);
  eq(a, roundMoney((120 + 90) * sale.grand_total / sale.subtotal), 'two lines in one refund -> their share');
  const prior = refundPriorFor(sale.id, [{sale_id: sale.id, amount: a, items: r1}]);
  const b = refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 1}, {sale_item_id: items[1].id, quantity: 1}], prior);
  eq(roundMoney(a + b), sale.grand_total, 'finishing refund gives back exactly the rest');
}

/* ---------------- rounding inside the function ---------------- */
{
  // L x G / S = 1 x 201 / 200 = 1.005 -> 1.01 (database round), not 1.00
  const sale = {subtotal: 200, grand_total: 201};
  const items = [{id: 'a', unit_price: 1, quantity: 1, line_total: 1}, {id: 'b', unit_price: 199, quantity: 1, line_total: 199}];
  eq(refundAmountForItems(sale, items, [{sale_item_id: 'a', quantity: 1}]), 1.01, 'exact half centavo rounds up (1.005 -> 1.01)');
  eq(refundAmountForItems({subtotal: 200, grand_total: 200.99}, items, [{sale_item_id: 'a', quantity: 1}]), 1, 'just under half rounds down (1.00495 -> 1.00)');
  eq(refundAmountForItems({subtotal: 200.00000000000003, grand_total: 201}, items, [{sale_item_id: 'a', quantity: 1}]), 1.01, 'S and G count in centavos: noisy subtotal 200.00000000000003 = 200 -> 1.01');
  eq(refundAmountForItems({subtotal: 3, grand_total: 3.01}, [{id: 'a', unit_price: 1, quantity: 3, line_total: 3}], [{sale_item_id: 'a', quantity: 1}]), 1, '1 x 3.01 / 3 = 1.00333 -> 1.00');
  eq(refundAmountForItems({subtotal: 3, grand_total: 3.02}, [{id: 'a', unit_price: 1, quantity: 3, line_total: 3}], [{sale_item_id: 'a', quantity: 2}]), 2.01, '2 x 3.02 / 3 = 2.01333 -> 2.01');
  // a subtotal stored with float noise (the counter sends 0.1 + 0.2 style sums)
  const s2 = {subtotal: 0.1 + 0.2 + 99.7, grand_total: 122};
  eq(refundAmountForItems(s2, [{id: 'x', unit_price: 50, quantity: 1}, {id: 'y', unit_price: 50.000000000000004, quantity: 1}], [{sale_item_id: 'x', quantity: 1}]), 61, 'noisy subtotal: 50 x 122/100 = 61.00');
}

/* ---------------- caps and odd inputs ---------------- */
{
  const {sale, items} = makeSale([{price: 100, qty: 2}, {price: 50, qty: 1}], null, TAXSVC); // S 250, G 305
  eq(sale.grand_total, 305, 'caps sale 305');
  // returning more than was sold counts only what was sold
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[1].id, quantity: 5}]), 61, 'qty above sold counts only the sold qty (50 x 1.22)');
  // already returned 1 of 2: returning 2 now counts only the 1 left
  const prior = {amount: 122, quantities: {[items[0].id]: 1}};
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 2}], prior), 122, 'already-returned units are not paid twice');
  // returning everything that is left -> left, even with a too-big quantity
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 2}, {sale_item_id: items[1].id, quantity: 1}], prior), 183, 'everything back -> what is left (305 - 122)');
  // lines of another sale count 0
  eq(refundAmountForItems(sale, items, [{sale_item_id: 'other-sale-line', quantity: 1}]), 0, 'line of another sale -> 0');
  // the same line listed twice is added up
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 1}, {sale_item_id: items[0].id, quantity: 1}]), 244, 'same line twice -> quantities added (2 x 122)');
  // negative / bad quantities count 0
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: -3}, {sale_item_id: items[1].id, quantity: 'x'}]), 0, 'negative / bad quantities -> 0');
  // no items listed
  eq(refundAmountForItems(sale, items, []), 0, 'nothing returned -> 0');
  eq(refundAmountForItems(sale, items, null), 0, 'refundItems null -> 0');
  // share bigger than what is left -> capped at left
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 1}], {amount: 250, quantities: {}}), 55, 'share capped at what is left (305 - 250)');
  // prior refunds already took everything
  eq(refundAmountForItems(sale, items, [{sale_item_id: items[0].id, quantity: 1}], {amount: 305}), 0, 'nothing left -> 0');
  // void = every line, full quantities
  eq(refundAmountForItems(sale, items, items.map(i => ({sale_item_id: i.id, quantity: i.quantity}))), 305, 'void / full refund -> grand total');
  // unit price missing -> line_total / quantity
  eq(refundAmountForItems({subtotal: 60, grand_total: 60}, [{id: 'p', unit_price: null, quantity: 3, line_total: 30}, {id: 'q', unit_price: 30, quantity: 1, line_total: 30}],
    [{sale_item_id: 'p', quantity: 1}]), 10, 'unit_price null -> line_total / quantity');
  // numeric text from the database
  eq(refundAmountForItems({subtotal: '260', grand_total: '253.76'}, [{id: 'a', unit_price: '110', quantity: '1'}, {id: 'b', unit_price: '150', quantity: '1'}],
    [{sale_item_id: 'a', quantity: '1'}]), 107.36, 'numbers as text work');
  // sale with no items (only "left" applies)
  eq(refundAmountForItems({subtotal: 0, grand_total: 12.5}, [], []), 12.5, 'sale without item rows -> what is left');
}

/* ---------------- S = 0 ---------------- */
{
  const sale = {subtotal: 0, grand_total: 0};
  const items = [{id: 'f1', unit_price: 0, quantity: 1, line_total: 0}, {id: 'f2', unit_price: 0, quantity: 1, line_total: 0}];
  eq(refundAmountForItems(sale, items, [{sale_item_id: 'f1', quantity: 1}]), 0, 'S = 0, partial -> 0');
  eq(refundAmountForItems(sale, items, [{sale_item_id: 'f1', quantity: 1}, {sale_item_id: 'f2', quantity: 1}]), 0, 'S = 0, everything -> left = 0');
  const odd = {subtotal: 0, grand_total: 20};
  eq(refundAmountForItems(odd, items, [{sale_item_id: 'f1', quantity: 1}]), 0, 'S = 0 but G > 0, partial -> 0 (no division by zero)');
  eq(refundAmountForItems(odd, items, [{sale_item_id: 'f1', quantity: 1}, {sale_item_id: 'f2', quantity: 1}]), 20, 'S = 0 but G > 0, everything -> left');
  eq(refundAmountForItems({subtotal: 100, grand_total: 100}, [{id: 'a', unit_price: 0, quantity: 1}, {id: 'b', unit_price: 100, quantity: 1}], [{sale_item_id: 'a', quantity: 1}]), 0, 'free item -> 0');
}

/* ---------------- refundPriorFor ---------------- */
{
  const refunds = [
    {id: 'r1', sale_id: 'S', amount: 10.105, items: [{sale_item_id: 'a', quantity: 1}]},
    {id: 'r2', sale_id: 'S', amount: '5', items: JSON.stringify([{sale_item_id: 'a', quantity: 2}, {sale_item_id: 'b', quantity: 1}])},
    {id: 'r3', sale_id: 'OTHER', amount: 99, items: [{sale_item_id: 'a', quantity: 9}]},
    {id: 'r4', sale_id: 'S', amount: 1, items: null},
    {id: 'r5', sale_id: 'S', amount: 2, items: [{sale_item_id: 'c', quantity: -1}, null]},
  ];
  eq(JSON.parse(JSON.stringify(refundPriorFor('S', refunds))), {amount: 18.11, quantities: {a: 3, b: 1}}, 'refundPriorFor: sums this sale only (text items parsed, bad lines skipped)');
  eq(JSON.parse(JSON.stringify(refundPriorFor('S', refunds, 'r2'))), {amount: 13.11, quantities: {a: 1}}, 'refundPriorFor: leaves one refund out');
  eq(JSON.parse(JSON.stringify(refundPriorFor('S', null))), {amount: 0, quantities: {}}, 'refundPriorFor: no refunds');
}

/* ---------------- shiftMetrics clear names ---------------- */
{
  const sh = {id: 'SH', status: 'ACTIVE', opening_cash: 1000};
  const data = {
    sales: [
      {id: 's1', shift_id: 'SH', status: 'COMPLETED', subtotal: 260, discount_amount: 52, tax_amount: 24.96, service_charge_amount: 20.8, grand_total: 253.76},
      {id: 's2', shift_id: 'SH', status: 'PARTIALLY_REFUNDED', subtotal: 200, discount_amount: 0, tax_amount: 24, service_charge_amount: 20, grand_total: 244},
      {id: 's3', shift_id: 'SH', status: 'VOIDED', subtotal: 100, discount_amount: 0, tax_amount: 0, service_charge_amount: 0, grand_total: 100},
      {id: 's4', shift_id: 'SH', status: 'HELD', subtotal: 999, discount_amount: 0, tax_amount: 0, service_charge_amount: 0, grand_total: 999},
      {id: 's5', shift_id: 'OTHER', status: 'COMPLETED', subtotal: 50, discount_amount: 0, tax_amount: 0, service_charge_amount: 0, grand_total: 50},
    ],
    payments: [{sale_id: 's1', method: 'CASH'}, {sale_id: 's2', method: 'GCASH'}, {sale_id: 's3', method: 'CASH'}],
    refunds: [{sale_id: 's2', shift_id: 'SH', type: 'PARTIAL_REFUND', amount: 134.2}, {sale_id: 's3', shift_id: 'SH', type: 'VOID', amount: 100}],
    cashMovements: [],
  };
  const m = shiftMetrics(sh, data);
  eq([m.itemSales, m.discounts, roundMoney(m.taxAndService), m.sales, m.refunds, roundMoney(m.netSales), m.voids], [460, 52, 89.76, 497.76, 134.2, 363.56, 100],
     'shiftMetrics: itemSales 460, discounts 52, tax & service 89.76, sales 497.76, refunds 134.20, net 363.56, voids 100');
  eq([m.grossSales, m.discountTotal, m.taxTotal, m.serviceTotal, m.refundsOnly, m.voidsOnly, m.netSales], [460, 52, 48.96, 40.8, 134.2, 100, m.netSales], 'older field names unchanged');
  eq(roundMoney(m.itemSales - m.discounts + m.taxAndService), m.sales, 'item sales - discounts + tax & service = sales');
  eq(roundMoney(m.sales - m.refunds), roundMoney(m.netSales), 'net sales = sales - refunds');
  eq([m.transactionCount, m.voidedCount, m.cashGross, m.expectedCash], [2, 1, 253.76, 1253.76], 'other figures unchanged (voids not double-counted)');

  const rows = salesSummaryRows(m, sh);
  eq(rows.map(r => r.label), ['Item sales (before discounts)', 'Discounts', 'Tax & service', 'Sales', 'Refunds', 'Net sales'], 'salesSummaryRows: the six words in order');
  eq(rows.map(r => roundMoney(r.amount)), [460, 52, 89.76, 497.76, 134.2, 363.56], 'salesSummaryRows: live amounts for an open shift');
  eq(rows.map(r => r.sign), ['', '-', '+', '', '-', ''], 'salesSummaryRows: signs');
  eq(rows.filter(r => r.total).map(r => r.key), ['sales', 'netSales'], 'salesSummaryRows: totals');
  ok(rows.every(r => typeof r.hint === 'string' && r.hint.length > 10), 'salesSummaryRows: every row has a hint');
  // closed shift: saved figures win; Sales = net_sales + refunds_total
  const closed = Object.assign({}, sh, {status: 'CLOSED', gross_sales: 400, net_sales: 300, refunds_total: 20});
  eq(salesSummaryRows(m, closed).map(r => roundMoney(r.amount)), [400, 52, 89.76, 320, 20, 300], 'closed shift: saved gross_sales / refunds_total / net_sales used');
  const closedOld = Object.assign({}, sh, {status: 'CLOSED', gross_sales: null, net_sales: null, refunds_total: null});
  eq(salesSummaryRows(m, closedOld).map(r => roundMoney(r.amount)), [460, 52, 89.76, 497.76, 134.2, 363.56], 'closed shift without saved figures: live');
  eq(salesSummaryRows(null), [], 'no metrics -> []');
  eq(Object.keys(SALES_LABELS).sort(), ['discounts', 'itemSales', 'netSales', 'refunds', 'sales', 'taxAndService', 'voids'], 'SALES_LABELS keys');
  ok(Object.keys(SALES_LABELS).every(k => typeof m[k] === 'number'), 'every SALES_LABELS key is a shiftMetrics field');
}

/* ---------------- receipt words ---------------- */
{
  state.settings = {receipt_footer: 'Thanks'};
  const html = receiptHtml({transaction_number: 'T-1', transaction_date: '2026-10-12T02:00:00Z', cashier_name: 'Ana <b>', status: 'COMPLETED',
    subtotal: 260, discount_amount: 52, tax_amount: 24.96, service_charge_amount: 20.8, grand_total: 253.76},
    [{name: 'Latte', quantity: 1, line_total: 150, modifiers: []}], [{method: 'CASH', amount: 253.76, tendered: 300, change: 46.24}]);
  ok(/<span>Subtotal<\/span><span>₱260\.00/.test(html), 'receipt: Subtotal');
  ok(/<span>Service charge<\/span>/.test(html) && !/Service Charge/.test(html), 'receipt: "Service charge" (sentence case)');
  ok(/<span>Total<\/span><span>₱253\.76/.test(html) && !/>TOTAL</.test(html), 'receipt: "Total"');
  ok(/Payment \(Cash\)/.test(html), 'receipt: payment method label "Cash"');
  ok(/Cash received/.test(html), 'receipt: "Cash received"');
  ok(/Ana &lt;b&gt;/.test(html), 'receipt: cashier name still escaped');
  const h2 = receiptHtml({transaction_number: 'T-2', transaction_date: '2026-10-12T02:00:00Z', status: 'PARTIALLY_REFUNDED', subtotal: 1, grand_total: 1}, [], [{method: 'ODD<x>', amount: 1}]);
  ok(/Payment \(ODD&lt;x&gt;\)/.test(h2), 'receipt: unknown payment method shown escaped');
}

console.log('\nALL ' + pass + ' CHECKS PASSED');
console.log(`SUMMARY unit/logic_refund_check: ${pass} checks, 0 failed`);
