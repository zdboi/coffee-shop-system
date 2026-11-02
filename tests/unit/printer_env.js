// Shared test environment for tests/unit/printer_check.js + menu_stock_check.js (release 1.3, from core-sync-engineer): loads ui.js, local.js, logic.js, printer.js into a vm context
// with fake browser globals. makeEnv({nav}) -> {ctx, r, printed}
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = process.env.REPO || path.resolve(__dirname, '..', '..');   // tests/unit -> repo

function makeEnv(opts){
  opts = opts || {};
  const printed = [];   // print-dialog fallbacks
  const ctx = {console, setTimeout, clearTimeout, Promise, Date, JSON, Math, Intl, Uint8Array, AbortController, URL};
  ctx.window = ctx;
  ctx.document = {currentScript: null, documentElement: {style: {setProperty(){}, removeProperty(){}}}, body: {classList: {toggle(){}}}, getElementById(){ return null; }};
  ctx.localStorage = {getItem(){ return null; }, setItem(){}, removeItem(){}};
  ctx.navigator = opts.nav || {userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130'};
  ctx.isSecureContext = true;
  vm.createContext(ctx);
  for(const f of ['ui.js', 'local.js', 'logic.js', 'printer.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'cccc/shared', f), 'utf8'), ctx, {filename: f});
  // the print dialog: record instead of opening a window
  vm.runInContext('openPrintWindow = function(html, auto){ __printed.push({html, auto}); return {}; };', Object.assign(ctx, {__printed: printed}));
  const r = (s) => vm.runInContext(s, ctx);
  return {ctx, r, printed, ROOT};
}

// A sample shop + sale used by the golden checks.
const SAMPLE = `
  state.settings = Object.assign({}, DEFAULT_SETTINGS, {business_name: 'Cavite City Coffee Club',
    business_address: '123 P. Burgos Ave., Caridad, Cavite City', business_contact: '0917 123 4567',
    business_tin: '123-456-789-000', receipt_header: '', receipt_footer: 'Salamat po! Balik kayo ☕', timezone: 'Asia/Manila'});
  var SALE = {id: 's1', transaction_number: 'TXN-0042', transaction_date: '2026-11-02T07:05:00Z', cashier_name: 'Ana Señora',
    subtotal: 410, discount_amount: 41, loyalty_discount: 10, tax_amount: 0, service_charge_amount: 0, grand_total: 359, status: 'COMPLETED'};
  var ITEMS = [
    {id: 'i1', name: 'Iced Spanish Latte', quantity: 2, unit_price: 150, line_total: 300,
      modifiers: [{label: 'Oat milk', price_delta: 20}, {label: 'Less ice', price_delta: 0}], notes: 'For Kuya “Jun”'},
    {id: 'i2', name: 'Ube Cheese Pandesal (box of 6) — special', quantity: 1, unit_price: 110, line_total: 110, modifiers: []},
  ];
  var PAYS = [{method: 'CASH', amount: 359, tendered: 500, change: 141}];
`;
module.exports = {makeEnv, SAMPLE, ROOT};
