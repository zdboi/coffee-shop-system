// Fixture for tests/e2e/bo/part5_import_refunds.js (adopted from the back-office developer's make_refund_backup.js): an old-app (offline Inventory + POS) backup with refunds, to try the importer's refund checks.
// Ids differ from old-backup.json (part3) so both can be imported into the same shop. Rebuild: node tests/e2e/bo/fixtures/make-old-refunds.js
//   sale_p  discount 20% + 12% tax + 10% service, total 400.16. The old POS refunded the Americano at its line
//           price (110; the new pro-rated rule would give 107.36) -> breaks only the NEW rule, must import.
//   sale_h  total 253.76, refunded by lines (110 + 150 = 260) -> more than the sale had -> hard cap, left out.
//   sale_s  total 110, refund 110 but 36 g of beans put back where the sale took 18 g -> stock cap, left out.
//   sale_v  a void of a plain sale (110) -> imports.
//   sale_ok a plain sale, no refund.
// The stock lines are listed with the "put back" lines FIRST and 160 filler lines between, so that without
// the "sales first" ordering the put-back lines would reach the database before their sale's own lines.
const fs = require('fs');
const d = (s) => new Date(s).toISOString();
const data = {
  categories: [{id: 'cat_r1', name: 'Coffee'}],
  suppliers: [],
  ingredients: [
    {id: 'ing_rbeans', name: 'Old House Beans', categoryId: 'cat_r1', base_unit: 'g', reorder_level: 500, active: true, created_at: d('2026-01-02'), updated_at: d('2026-01-02')},
    {id: 'ing_rmilk', name: 'Old Fresh Milk', categoryId: 'cat_r1', base_unit: 'ml', reorder_level: 1000, active: true, created_at: d('2026-01-02'), updated_at: d('2026-01-02')},
  ],
  recipes: [
    {id: 'rec_ramer', name: 'Old Americano', recipe_type: 'DRINKS', category: 'Hot', selling_price: 110, active: true, created_at: d('2026-01-04'), updated_at: d('2026-01-04')},
    {id: 'rec_rlatte', name: 'Old Latte', recipe_type: 'DRINKS', category: 'Iced', selling_price: 150, active: true, created_at: d('2026-01-04'), updated_at: d('2026-01-04')},
  ],
  recipeIngredients: [
    {id: 'rri_1', recipeId: 'rec_ramer', ingredientId: 'ing_rbeans', quantity: 18, unit: 'g'},
    {id: 'rri_2', recipeId: 'rec_rlatte', ingredientId: 'ing_rbeans', quantity: 18, unit: 'g'},
    {id: 'rri_3', recipeId: 'rec_rlatte', ingredientId: 'ing_rmilk', quantity: 180, unit: 'ml'},
  ],
  purchases: [], productionBatches: [], waste: [],
  users: [{id: 'user_rc', name: 'Old Cashier', role: 'CASHIER', active: true, created_at: d('2026-01-01')}],
  shifts: [{id: 'shift_r1', shift_number: 'SHIFT-OLD-R001', cashier_id: 'user_rc', cashier_name: 'Old Cashier', opened_at: d('2026-01-08T00:00:00Z'), closed_at: d('2026-01-08T09:00:00Z'), status: 'CLOSED',
    opening_cash: 1000, declared_cash: 1000, expected_cash: 1000, cash_variance: 0, gross_sales: 0, net_sales: 0, cash_sales: 0, card_sales: 0, other_sales: 0, refunds_total: 0, voids_total: 0, transaction_count: 5, created_at: d('2026-01-08T00:00:00Z')}],
  sales: [], saleItems: [], payments: [], refunds: [], inventoryTransactions: [], cashMovements: [], auditLog: [],
};
let n = 0;
const sale = (id, no, hour, o) => {
  const t = d(`2026-01-08T0${hour}:00:00Z`);
  data.sales.push(Object.assign({id, transaction_number: no, transaction_date: t, status: 'COMPLETED', cashier: 'Old Cashier', shift_id: 'shift_r1', discount_type: null, discount_value: 0, discount_amount: 0, tax_amount: 0, service_charge_amount: 0, created_at: t}, o));
  data.payments.push({id: 'pay_' + id, saleId: id, method: 'CASH', amount: o.grand_total, tendered: o.grand_total, change: 0, status: 'COMPLETED', created_at: t});
  return t;
};
const line = (id, saleId, recipeId, name, qty, price) => data.saleItems.push({id, saleId, recipeId, name, quantity: qty, unit_price: price, modifiers: [], line_total: qty * price});
const usage = []; const reversal = [];
const use = (saleId, ing, q, t) => usage.push({id: 'ruse_' + (++n), ingredientId: ing, transaction_type: 'SALE_USAGE', quantity: q, reference_id: saleId, transaction_date: '2026-01-08', notes: 'Sold', created_at: t});
const back = (refId, ing, q, t) => reversal.push({id: 'rrev_' + (++n), ingredientId: ing, transaction_type: 'SALE_REVERSAL', quantity: q, reference_id: refId, transaction_date: '2026-01-08', notes: 'Refund', created_at: t});

// sale_p
let t = sale('sale_p', 'POS-OLD-2026-000001', 1, {status: 'PARTIALLY_REFUNDED', subtotal: 410, discount_type: 'percent', discount_value: 20, discount_amount: 82, tax_amount: 39.36, service_charge_amount: 32.8, grand_total: 400.16});
line('sit_p1', 'sale_p', 'rec_ramer', 'Old Americano', 1, 110); line('sit_p2', 'sale_p', 'rec_rlatte', 'Old Latte', 2, 150);
use('sale_p', 'ing_rbeans', 18, t); use('sale_p', 'ing_rbeans', 36, t); use('sale_p', 'ing_rmilk', 360, t);
data.refunds.push({id: 'ref_p', saleId: 'sale_p', shift_id: 'shift_r1', type: 'PARTIAL_REFUND', amount: 110, reason: 'Too bitter', items: [{saleItemId: 'sit_p1', quantity: 1, recipeId: 'rec_ramer', modifiers: []}], approved_by: 'Old Cashier', date: d('2026-01-08T02:00:00Z'), notes: ''});
back('ref_p', 'ing_rbeans', 18, d('2026-01-08T02:00:00Z'));
// sale_h
t = sale('sale_h', 'POS-OLD-2026-000002', 3, {status: 'REFUNDED', subtotal: 260, discount_type: 'percent', discount_value: 20, discount_amount: 52, tax_amount: 24.96, service_charge_amount: 20.8, grand_total: 253.76});
line('sit_h1', 'sale_h', 'rec_ramer', 'Old Americano', 1, 110); line('sit_h2', 'sale_h', 'rec_rlatte', 'Old Latte', 1, 150);
use('sale_h', 'ing_rbeans', 18, t); use('sale_h', 'ing_rbeans', 18, t); use('sale_h', 'ing_rmilk', 180, t);
data.refunds.push({id: 'ref_h', saleId: 'sale_h', shift_id: 'shift_r1', type: 'FULL_REFUND', amount: 260, reason: 'Customer left', items: [{saleItemId: 'sit_h1', quantity: 1, recipeId: 'rec_ramer'}, {saleItemId: 'sit_h2', quantity: 1, recipeId: 'rec_rlatte'}], approved_by: 'Old Cashier', date: d('2026-01-08T04:00:00Z'), notes: ''});
back('ref_h', 'ing_rbeans', 36, d('2026-01-08T04:00:00Z')); back('ref_h', 'ing_rmilk', 180, d('2026-01-08T04:00:00Z'));
// sale_s
t = sale('sale_s', 'POS-OLD-2026-000003', 5, {status: 'REFUNDED', subtotal: 110, grand_total: 110});
line('sit_s1', 'sale_s', 'rec_ramer', 'Old Americano', 1, 110);
use('sale_s', 'ing_rbeans', 18, t);
data.refunds.push({id: 'ref_s', saleId: 'sale_s', shift_id: 'shift_r1', type: 'FULL_REFUND', amount: 110, reason: 'Wrong order', items: [{saleItemId: 'sit_s1', quantity: 1, recipeId: 'rec_ramer'}], approved_by: 'Old Cashier', date: d('2026-01-08T06:00:00Z'), notes: ''});
back('ref_s', 'ing_rbeans', 36, d('2026-01-08T06:00:00Z'));
// sale_v (void)
t = sale('sale_v', 'POS-OLD-2026-000004', 6, {status: 'VOIDED', subtotal: 110, grand_total: 110});
line('sit_v1', 'sale_v', 'rec_ramer', 'Old Americano', 1, 110);
use('sale_v', 'ing_rbeans', 18, t);
data.refunds.push({id: 'ref_v', saleId: 'sale_v', shift_id: 'shift_r1', type: 'VOID', amount: 110, reason: 'Entered by mistake', items: [{saleItemId: 'sit_v1', quantity: 1, recipeId: 'rec_ramer'}], approved_by: 'Old Cashier', date: d('2026-01-08T07:00:00Z'), notes: ''});
back('ref_v', 'ing_rbeans', 18, d('2026-01-08T07:00:00Z'));
// sale_ok
t = sale('sale_ok', 'POS-OLD-2026-000005', 7, {subtotal: 150, grand_total: 150});
line('sit_ok1', 'sale_ok', 'rec_rlatte', 'Old Latte', 1, 150);
use('sale_ok', 'ing_rbeans', 18, t); use('sale_ok', 'ing_rmilk', 180, t);
// stock history: purchases + filler so the put-back lines would land in an earlier batch than their sales' lines
const filler = Array.from({length: 160}, (_, i) => ({id: 'radj_' + i, ingredientId: 'ing_rmilk', transaction_type: 'ADJUSTMENT', quantity: 1, reference_id: null, transaction_date: '2026-01-07', notes: 'Count ' + i, created_at: d('2026-01-07')}));
const start = [{id: 'rbuy_1', ingredientId: 'ing_rbeans', transaction_type: 'INITIAL_STOCK', quantity: 5000, reference_id: null, transaction_date: '2026-01-02', notes: 'Start', created_at: d('2026-01-02')},
  {id: 'rbuy_2', ingredientId: 'ing_rmilk', transaction_type: 'INITIAL_STOCK', quantity: 9000, reference_id: null, transaction_date: '2026-01-02', notes: 'Start', created_at: d('2026-01-02')}];
data.inventoryTransactions = [...reversal, ...filler, ...start, ...usage];
const payload = {app: 'Coffee Shop System (Inventory + POS)', version: 4, exported_at: d('2026-01-10'), app_name_at_export: 'Old Shop', data};
const OUT = process.argv[2] || require('path').join(__dirname, 'old-refunds.json');
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
console.log('wrote', OUT, 'sales', data.sales.length, 'refunds', data.refunds.length, 'stock lines', data.inventoryTransactions.length);
