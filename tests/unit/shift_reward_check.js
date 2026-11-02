// Release 1.2 unit check (adopted from core-sync-engineer's shift_reward_check.js), node only, no database:
// shiftMetrics with stamp rewards (loyaltyRewards sum, voids excluded; Item sales - Discounts - Loyalty rewards
// + Tax & service = Sales; expected cash = cash takings), salesSummaryRows (the "Loyalty rewards" row only when
// there are rewards), receiptHtml reward line (escaped) and no reward line without a reward.
// Run: node tests/unit/shift_reward_check.js [repo]
const vm = require('vm'), fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..');
const c = {Cloud: {uuid(){}}, localStorage: {getItem(){ return null; }, setItem(){}}, escapeHtml: s => String(s).replace(/</g, '&lt;')};
vm.createContext(c);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'cccc/shared/logic.js'), 'utf8') + ';this.st=state;', c);
let n = 0, f = 0;
const ok = (x, name) => { n++; if(!x){ f++; console.log('FAIL ' + name); } else console.log('ok   ' + name); };
const S = {tax_pct: 12, service_charge_pct: 10, tax_inclusive: false};
const t = c.computeSaleTotals([{unit_price: 150, quantity: 2}, {unit_price: 65, quantity: 1}], {type: 'percent', value: 10}, S, 50);
const t2 = c.computeSaleTotals([{unit_price: 110, quantity: 1}], null, S);
const sale = (id, t, st) => ({id, shift_id: 'sh', status: st || 'COMPLETED', subtotal: t.subtotal, discount_amount: t.discountAmt, loyalty_discount: t.loyaltyDiscount, tax_amount: t.tax, service_charge_amount: t.serviceCharge, grand_total: t.grandTotal});
const data = {sales: [sale('a', t), sale('b', t2), sale('v', t, 'VOIDED')], payments: [{sale_id: 'a', method: 'CASH'}, {sale_id: 'b', method: 'CASH'}], refunds: [], cashMovements: []};
const m = c.shiftMetrics({id: 'sh', status: 'ACTIVE', opening_cash: 0}, data);
ok(m.loyaltyRewards === 50, 'loyaltyRewards sum (void excluded)');
ok(Math.abs(m.itemSales - m.discounts - m.loyaltyRewards + m.taxAndService - m.sales) < 0.01, 'adds up ' + [m.itemSales, m.discounts, m.loyaltyRewards, m.taxAndService, m.sales]);
ok(Math.abs(m.expectedCash - (t.grandTotal + t2.grandTotal)) < 1e-9, 'expected cash = sum of the cash sales grand totals');
const rows = c.salesSummaryRows(m);
ok(rows.map(r => r.key).join() === 'itemSales,discounts,loyaltyRewards,taxAndService,sales,refunds,netSales' && rows[2].label === 'Loyalty rewards' && rows[2].sign === '-', 'summary rows with a "Loyalty rewards" (minus) row');
const m0 = c.shiftMetrics({id: 'sh', status: 'ACTIVE'}, {sales: [sale('b', t2)], payments: [], refunds: [], cashMovements: []});
ok(c.salesSummaryRows(m0).length === 6 && m0.loyaltyRewards === 0, 'no rewards = the old rows (no Loyalty rewards row)');
c.st.settings = c.DEFAULT_SETTINGS || {};
const h = c.receiptHtml(Object.assign(sale('a', t), {transaction_date: '2026-10-29T02:00:00Z'}), [], [], {rewardLabel: '₱10 <b>off'});
ok(h.includes('Stamp reward: ₱10 &lt;b>off') && h.includes('-₱50.00'), 'receipt reward line, label escaped');
ok(!c.receiptHtml(Object.assign(sale('b', t2), {transaction_date: '2026-10-29T02:00:00Z'}), [], []).includes('Stamp reward'), 'no reward line without a reward');
console.log(`SUMMARY shift_reward_check: ${n} checks, ${f} failed`);
process.exit(f ? 1 : 0);
