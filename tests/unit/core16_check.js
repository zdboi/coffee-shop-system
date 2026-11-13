// Unit checks (node, no browser, no database) for the release 1.6 shared core (cccc/shared/logic.js):
// computeSaleTotals with the payment charge (added / waived) and Senior / PWD lines (no tax, VAT inclusive,
// tax on top), refundAmountForItems with Senior lines, payment method helpers, maskIdNumber, Senior %.
// The numbers are the same as tests/sql/43_release_1_6_tests.sql (the server side).
// Run: node tests/unit/core16_check.js [repo]
// Adopted by Z 2026-11-13 from the shared-core work's 16 scratch checks (w4/core16.js) + Z's own.
const fs = require('fs');
const vm = require('vm');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const ctx = {console, state: {settings: {}, ingredients: [], stock: {}, recipes: [], recipeIngredients: []}, window: undefined,
  localStorage: {getItem(){ return null; }, setItem(){}, removeItem(){}}, document: undefined, navigator: {}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/logic.js', 'utf8') + '\nthis.T = {computeSaleTotals, refundAmountForItems, paymentMethodList, activePaymentMethods, paymentMethodLabel, paymentChargeFor, seniorDiscountPct, maskIdNumber, toCSV};', ctx);
const T = ctx.T; let checks = 0, failed = 0;
const chk = (c, m, got) => { checks++; if(c) console.log('ok   ' + m); else { failed++; console.log('FAIL ' + m + (got === undefined ? '' : '   [got: ' + JSON.stringify(got) + ']')); } };
const pm = [{id:'CASH',label:'Cash',active:true,charge_type:'NONE',charge_value:0},{id:'GCASH',label:'GCash',active:true,reference:true,charge_type:'PERCENT',charge_value:2,charge_default:'ADD'},
  {id:'CARD',label:'Card',active:true,charge_type:'FIXED',charge_value:15,charge_default:'WAIVE'},{id:'MAYA',label:'Maya',active:false,charge_type:'NONE',charge_value:0}];
const S0 = {tax_pct: 0, tax_inclusive: false, service_charge_pct: 10, senior_discount_pct: 20, payment_methods: pm};
let t = T.computeSaleTotals([{unit_price:150, quantity:1}], null, S0, 0);
chk(t.grandTotal === 165 && t.paymentFee === 0 && t.seniorDiscount === 0, 'plain sale unchanged (165)', t);
t = T.computeSaleTotals([{unit_price:150, quantity:1}], null, S0, 0, {payment:{method:'GCASH', waive:false}});
chk(t.paymentFee === 3.3 && t.paymentCharge === 3.3 && t.grandTotal === 168.3, 'GCash 2% added: 168.30', t);
t = T.computeSaleTotals([{unit_price:150, quantity:1}], null, S0, 0, {payment:{method:'GCASH', waive:true}});
chk(t.paymentFee === 3.3 && t.paymentCharge === 0 && t.grandTotal === 165, 'GCash 2% waived: fee kept, total 165', t);
t = T.computeSaleTotals([{unit_price:150, quantity:1}], null, S0, 0, {payment:{method:'CARD', waive:true}});
chk(t.paymentFee === 15 && t.grandTotal === 165, 'Card ₱15 fixed, waived', t);
t = T.computeSaleTotals([{unit_price:150, quantity:1, senior:true}], {type:'percent', value:10}, S0, 20);
chk(t.seniorDiscount === 30 && t.vatExempt === 0 && t.discountAmt === 0 && t.loyaltyDiscount === 0 && t.grandTotal === 132 && t.seniorLineDiscounts[0] === 30, 'Senior, no tax: 132; other discount and reward ignored', t);
t = T.computeSaleTotals([{unit_price:150, quantity:1, senior:true},{unit_price:150, quantity:1}], null, S0, 0, {payment:{method:'GCASH'}});
chk(t.seniorDiscount === 30 && t.paymentFee === 5.94 && t.grandTotal === 302.94 && t.seniorItems === 150, 'mixed Senior + GCash: 302.94', t);
t = T.computeSaleTotals([{unit_price:150, quantity:1, senior:true}], null, Object.assign({}, S0, {tax_pct:12, tax_inclusive:true}), 0);
chk(t.vatExempt === 16.07 && t.seniorDiscount === 26.79 && t.grandTotal === 117.85 && t.seniorLineDiscounts[0] === 42.86, 'VAT inclusive: VAT out 16.07, 20% 26.79, total 117.85', t);
t = T.computeSaleTotals([{unit_price:150, quantity:1, senior:true},{unit_price:150, quantity:1}], null, Object.assign({}, S0, {tax_pct:12}), 0);
chk(Math.abs(t.tax - 18) < 1e-9 && t.grandTotal === 315, 'tax on top: no tax on the Senior item, 315', t);
t = T.computeSaleTotals([{unit_price:100, quantity:1, senior:true},{unit_price:55, quantity:2, senior:true},{unit_price:33.33, quantity:1, senior:true}], null, Object.assign({}, S0, {tax_pct:12, tax_inclusive:true}), 0);
chk(Math.abs(t.seniorLineDiscounts.reduce((a,b)=>a+b,0) - (t.vatExempt + t.seniorDiscount)) < 0.005, 'line shares add up to VAT out + discount', t);
t = T.computeSaleTotals([{unit_price:150, quantity:1, senior:true}], null, Object.assign({}, S0, {senior_discount_pct:0}), 0);
chk(t.seniorDiscount === 0 && t.grandTotal === 165, '0% = not offered', t);
// refund shares (same numbers as the server's _refund_items_cap in suite 43)
const sale = {subtotal:300, vat_exempt_amount:0, senior_discount:30, grand_total:302.94};
const items = [{id:'a', unit_price:150, quantity:1, line_total:150, senior_discount:30},{id:'b', unit_price:150, quantity:1, line_total:150}];
chk(T.refundAmountForItems(sale, items, [{sale_item_id:'a', quantity:1}]) === 134.64, 'refund share: Senior line 134.64', T.refundAmountForItems(sale, items, [{sale_item_id:'a', quantity:1}]));
chk(T.refundAmountForItems(sale, items, [{sale_item_id:'b', quantity:1}]) === 168.3, 'refund share: other line 168.30');
chk(T.refundAmountForItems(sale, items, [{sale_item_id:'a', quantity:1},{sale_item_id:'b', quantity:1}]) === 302.94, 'refund everything = 302.94');
chk(T.refundAmountForItems({subtotal:300, grand_total:330}, [{id:'a', unit_price:150, quantity:2}], [{sale_item_id:'a', quantity:1}]) === 165, 'a sale without Senior: share unchanged (165)');
chk(T.paymentMethodList({}).length === 7 && T.activePaymentMethods({}).length === 5 && T.paymentMethodLabel('QR', {}) === 'QR payment' && T.paymentMethodLabel('PAYMAYA_X', {}) === 'Paymaya x', 'default list (7, 5 on) + labels');
chk(T.maskIdNumber('SC-0012345') === '•••• 2345' && T.seniorDiscountPct({}) === 20 && T.seniorDiscountPct({senior_discount_pct: 0}) === 0, 'ID masked to the last 4; Senior % default 20, 0 = off');
// ---- Z (2026-11-13)
const S5 = {subtotal:175, vat_exempt_amount:0, senior_discount:13, grand_total:178.7};
const it5 = [{id:'am', unit_price:110, quantity:1, line_total:110},{id:'en', unit_price:65, quantity:1, line_total:65, senior_discount:13}];
t = T.computeSaleTotals([{unit_price:110, quantity:1},{unit_price:65, quantity:1, senior:true}], null, {tax_pct:12, tax_inclusive:false, service_charge_pct:0, senior_discount_pct:20, payment_methods:pm}, 0, {payment:{method:'GCASH'}});
chk(t.seniorDiscount === 13 && Math.abs(t.tax - 13.2) < 1e-9 && t.paymentFee === 3.5 && t.grandTotal === 178.7, 'Z: tax on top + Senior pastry + GCash: tax 13.20 on the Americano only, fee 3.50, total 178.70 (money16 sale S5)', t);
chk(T.refundAmountForItems(S5, it5, [{sale_item_id:'en', quantity:1}]) + T.refundAmountForItems(S5, it5, [{sale_item_id:'am', quantity:1}]) <= 178.7 + 0.01, 'Z: the two partial shares never add up to more than was paid');
chk(T.refundAmountForItems({subtotal:150, vat_exempt_amount:0, senior_discount:30, grand_total:120}, [{id:'x', unit_price:150, quantity:3, line_total:450, senior_discount:30}], [{sale_item_id:'x', quantity:9}]) === 120, 'Z: naming more pieces than sold gives at most what is left');
chk(T.toCSV(['n'], [['=HYPERLINK("x")'], ['+63917'], ['-5.00'], ['@SUM(A1)']]) === '"n"\n"\'=HYPERLINK(""x"")"\n"+63917"\n"-5.00"\n"\'@SUM(A1)"', 'Z: CSV cells (Senior report) can\'t start a formula; plain numbers stay numbers', T.toCSV(['n'], [['=HYPERLINK("x")'], ['+63917'], ['-5.00'], ['@SUM(A1)']]));
chk(T.paymentMethodList({payment_methods:[{id:'CASH', label:'Cash', active:true, charge_type:'BOGUS', charge_value:99}]})[0].charge_value === 0, 'Z: an unknown charge type counts as no charge');
// Z (gate fix 7): the thermal receipt masks the ID the same way as the screen (last 4, or last 2 for a short ID)
{
  const {makeEnv, SAMPLE} = require('./printer_env.js');
  const e = makeEnv(); e.r(SAMPLE);
  const idLine = (idno) => e.r('Printer.describe(Printer.receiptBytes(Object.assign({}, SALE, {senior_kind: "SENIOR", senior_discount: 20}), ITEMS, PAYS, {senior: {holder_name: "Lola", id_number: ' + JSON.stringify(idno) + '}}))').split('\n').filter(l => /ID no/.test(l))[0];
  chk(idLine('SC-0012345') === 'ID no.: **** 2345' && idLine('ABC') === 'ID no.: **BC' && idLine('A1B2') === 'ID no.: **B2', 'Z: thermal receipt ID masked like the screen (**** 2345, short IDs **BC)', [idLine('SC-0012345'), idLine('ABC'), idLine('A1B2')]);
}
console.log(`SUMMARY unit/core16_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
