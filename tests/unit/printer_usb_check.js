// Unit checks for cccc/shared/printer.js release 1.4 (adopted from core-sync-engineer 2026-11-09): USB printer (fake WebUSB), barista order ticket and X / Z
// report goldens at 58 + 80 mm, print queue, "no print screen unless fallback === true",
// Brave / Safari / Chrome detection and help text. No hardware, no database.
// Run: node tests/unit/printer_usb_check.js   (REPO=<repo> optional; goldens in tests/unit/printer_usb_goldens.json)
const path = require('path');
const ENV = process.env.PRINTER_ENV || path.join(__dirname, 'printer_env.js');
const {makeEnv, SAMPLE} = require(ENV);
const GOLD = require('./printer_usb_goldens.json');

let checks = 0, failed = 0;
function eq(name, got, exp){
  checks++;
  const good = JSON.stringify(got) === JSON.stringify(exp);
  if(!good) failed++;
  console.log((good ? 'ok   ' : 'FAIL ') + name + (good ? '' : '\n   got:      ' + JSON.stringify(got) + '\n   expected: ' + JSON.stringify(exp)));
}
const hex = (a) => Array.from(a).map(x => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function countSeq(arr, seq){ const a = Array.from(arr); let n = 0; for(let i = 0; i <= a.length - seq.length; i++){ if(seq.every((x, j) => a[i + j] === x)) n++; } return n; }

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';

/* ---------- fake WebUSB: an Xprinter-like device (HID interface 0, printer interface 1) ---------- */
function fakeUsb(o){
  o = o || {};
  const log = {writes: [], requests: [], opens: 0, claims: [], selects: 0, clearHalts: 0, transfers: 0, forgot: 0, resets: 0};
  const listeners = {};
  const device = {
    vendorId: o.vendorId || 0x0483, productId: 0x5743, serialNumber: o.serial === undefined ? 'XP58-0001' : o.serial,
    productName: 'Printer POS-58', manufacturerName: 'Xprinter',
    opened: false, configuration: null,
    configurations: [{configurationValue: 1}],
    async open(){ log.opens++; this.opened = true; },
    async close(){ this.opened = false; this.configuration = null; },
    async selectConfiguration(v){
      log.selects++;
      this.configuration = {configurationValue: v, interfaces: o.ifaces ? JSON.parse(JSON.stringify(o.ifaces)) : [
        {interfaceNumber: 0, claimed: false, alternates: [{alternateSetting: 0, interfaceClass: 3, endpoints: [{endpointNumber: 1, direction: 'out', type: 'interrupt'}]}]},
        {interfaceNumber: 1, claimed: false, alternates: [{alternateSetting: 0, interfaceClass: 7, endpoints: [
          {endpointNumber: 2, direction: 'in', type: 'bulk'}, {endpointNumber: 3, direction: 'out', type: 'bulk'}]}]},
      ]};
    },
    async claimInterface(n){
      log.claims.push(n);
      if(o.busy && (typeof o.busy !== 'number' || log.claims.length <= o.busy)) throw Object.assign(new Error('Unable to claim interface.'), {name: 'NetworkError', code: 19});
      this.configuration.interfaces.find(i => i.interfaceNumber === n).claimed = true;
    },
    async releaseInterface(n){ const i = this.configuration && this.configuration.interfaces.find(x => x.interfaceNumber === n); if(i) i.claimed = false; },
    async selectAlternateInterface(){},
    async clearHalt(){ log.clearHalts++; },
    async reset(){ log.resets++; },
    async forget(){ log.forgot++; },
    async transferOut(ep, data){
      log.transfers++;
      if(!this.opened) throw Object.assign(new Error('The device must be opened first.'), {name: 'InvalidStateError', code: 11});
      if(ep !== 3) throw Object.assign(new Error('wrong endpoint ' + ep), {name: 'NotFoundError', code: 8});
      if(o.stallAt && log.transfers === o.stallAt) return {status: 'stall', bytesWritten: 0};
      if(o.unplugAfter !== undefined && log.writes.length >= o.unplugAfter && !log.unplugged){ log.unplugged = true; this.opened = false; throw Object.assign(new Error('The device was disconnected.'), {name: 'NotFoundError', code: 8}); }
      if(o.delay) await sleep(o.delay);
      log.writes.push(Array.from(data));
      return {status: 'ok', bytesWritten: data.length};
    },
  };
  const usb = {
    async requestDevice(req){ log.requests.push(req); if(o.cancel) throw Object.assign(new Error('No device selected.'), {name: 'NotFoundError', code: 8}); return device; },
    async getDevices(){ return o.noRemember ? [] : [o.farbled ? Object.assign(device, {serialNumber: 'wYMGiwgvf2jwgvfu'}) : device]; },
    addEventListener(t, fn){ (listeners[t] = listeners[t] || []).push(fn); },
    fire(t){ (listeners[t] || []).forEach(fn => fn({device})); },
  };
  return {usb, device, log, all: () => [].concat(...log.writes)};
}

const DATA = `
var ORDER = {order_number: 'Q-17', table_label: 'Table 4', order_type: 'DINE_IN', customer_nickname: 'Bea', created_at: '2026-11-02T07:05:00Z', paid_at: '2026-11-02T07:06:00Z',
  customer_note: 'Less sweet\\nTOTAL P0.00', items: [
  {name: 'Iced Spanish Latte', quantity: 2, modifiers: [{label: 'Oat milk', price_delta: 20}, {label: 'Less ice'}], notes: 'For Kuya “Jun”'},
  {name: 'Ube Cheese Pandesal (box of 6) — special', quantity: 1, modifiers: []}]};
var SHIFT = {id: 'sh1', shift_number: 'SH-0007', cashier_name: 'Ana Señora', status: 'OPEN', opened_at: '2026-11-02T00:00:00Z', opening_cash: 1000};
var M = {transactionCount: 12, voidedCount: 1, itemSales: 5000, discounts: 250, loyaltyRewards: 50, taxAndService: 120, sales: 4820, refunds: 150, voids: 200, netSales: 4670,
  taxTotal: 100, serviceTotal: 20, cashGross: 3000, cardGross: 820, otherGross: 1000, netCashFromSales: 2900, payIns: 500, payOuts: 300, payInCount: 1, payOutCount: 2,
  openingCash: 1000, expectedCash: 4100, declaredCash: null, variance: null};
var ZSHIFT = Object.assign({}, SHIFT, {status: 'CLOSED', closed_at: '2026-11-02T09:30:00Z', closed_by_name: 'Mara Cruz', declared_cash: 4080, cash_variance: -20,
  expected_cash: 4100, cash_sales: 3000, card_sales: 820, other_sales: 1000, gross_sales: 5000, net_sales: 4670, refunds_total: 150, voids_total: 200, transaction_count: 12, notes: 'Coins short'});
var ZM = Object.assign({}, M, {declaredCash: 4080, variance: -20});
`;
const X_OPTS = (w) => `{paper_width: ${w}, now: new Date('2026-11-02T05:00:00Z')}`;
const Z_OPTS = (w) => `{paper_width: ${w}, now: new Date('2026-11-02T09:31:00Z')}`;

(async () => {
  /* ---------- goldens: ticket, X, Z at 58 + 80 mm ---------- */
  // 1.6 (owner decision B4; changed by Z 2026-11-13, needs C's approval): the non-cash line of the X / Z goldens reads
  // "Other methods" (was "GCash / Maya / Other"): the shop's method list is editable now.
  {
    const e = makeEnv(); e.r(SAMPLE); e.r(DATA);
    const widthOk = (d, w) => d.split('\n').every(l => { const t = l.replace(/\[[A-Z0-9 x\/]+\]/g, ''); return t.length <= w; });
    for(const w of [58, 80]){
      const t = e.r(`Printer.describe(Printer.ticketBytes(ORDER, {paper_width: ${w}}))`);
      const x = e.r(`Printer.describe(Printer.shiftReportBytes({shift: SHIFT, metrics: M, isX: true, device_name: 'Counter 1'}, ${X_OPTS(w)}))`);
      const z = e.r(`Printer.describe(Printer.shiftReportBytes({shift: ZSHIFT, metrics: ZM, device_name: 'Counter 1', waste_count: 3}, ${Z_OPTS(w)}))`);
      eq(`golden ticket ${w} mm`, t, GOLD['ticket' + w]);
      eq(`golden X report ${w} mm`, x, GOLD['x' + w]);
      eq(`golden Z report ${w} mm`, z, GOLD['z' + w]);
      const cols = w === 58 ? 32 : 48;
      eq(`every ${w} mm line fits ${cols} (ticket, X, Z; double-size lines fit ${cols / 2})`, [widthOk(t, cols), widthOk(x, cols), widthOk(z, cols), t.split('\n')[0].replace(/\[[^\]]+\]/g, '').length <= cols / 2], [true, true, true, true]);
    }
    const t = e.r(`Printer.describe(Printer.ticketBytes(Object.assign({}, ORDER, {customer_note: ''}), {}))`);
    eq('ticket: no prices (no P amounts, option +P20 not shown)', /P\d|20\.00/.test(t), false);
    eq('ticket: injected line breaks (note, nickname) stay on one line', [/Note: Less sweet TOTAL P0\.00\n/.test(e.r(`Printer.describe(Printer.ticketBytes(ORDER, {}))`)),
      /Bea TOTAL\n/.test(e.r(`Printer.describe(Printer.ticketBytes(Object.assign({}, ORDER, {customer_nickname: 'Bea\\nTOTAL'}), {}))`))], [true, true]);
    eq('ticket: control bytes in item names removed', /\[0x/.test(e.r(`Printer.describe(Printer.ticketBytes({order_number:'Q-1', items:[{name:'A\\x1b@\\x1dV1B', quantity:1}]}, {}))`)), false);
    const two = e.r(`Printer.ticketBytes(ORDER, {copies: 2, reprint: true})`);
    eq('ticket: 2 copies -> 2 cuts, (Reprint) on each', [countSeq(two, [0x1d, 0x56, 0x01]), (e.r(`Printer.describe(Printer.ticketBytes(ORDER, {copies: 2, reprint: true}))`).match(/\(Reprint\)/g) || []).length], [2, 2]);
    eq('ticket: setting ticket_copies used when opts.copies missing', await (async () => { await e.r(`Printer.saveSettings({ticket_copies: 3})`); const n = countSeq(e.r(`Printer.ticketBytes(ORDER, {})`), [0x1d, 0x56, 0x01]); await e.r(`Printer.saveSettings({ticket_copies: 1})`); return n; })(), 3);
    const ct = e.r(`Printer.describe(Printer.ticketBytes({transaction_number: 'TXN-0042', transaction_date: '2026-11-02T07:05:00Z', items: [{name: 'Americano', quantity: 1, modifiers: [{label: 'Hot'}]}]}, {}))`);
    eq('ticket: counter sale -> COUNTER ORDER + its transaction number, not PAID', [/^\[INIT\]\[ALIGN C\]\[B\]\[SIZE 2x2\]TXN-0042\n\[SIZE 1x1\]COUNTER ORDER\n/.test(ct), /PAID/.test(ct), /1 x Americano/.test(ct)], [true, false, true]);
    eq('ticket: opts.source wins', /QR ORDER/.test(e.r(`Printer.describe(Printer.ticketBytes({transaction_number: 'T1', items: []}, {source: 'QR'}))`)), true);
    eq('ticket: TAKEAWAY', /Table 4 - TAKEAWAY/.test(e.r(`Printer.describe(Printer.ticketBytes(Object.assign({}, ORDER, {order_type: 'TAKEAWAY'}), {}))`)), true);
    // Z uses the figures saved on the closed shift (like shiftReportHtml), X uses shiftMetrics
    const z2 = e.r(`Printer.describe(Printer.shiftReportBytes({shift: Object.assign({}, ZSHIFT, {cash_sales: 2999, expected_cash: 4099, net_sales: 4600}), metrics: ZM}, {paper_width: 80}))`);
    eq('Z: saved cash_sales / expected_cash / net_sales are printed (not live metrics)', [/Cash sales +P2,999\.00/.test(z2), /Expected cash +P4,099\.00/.test(z2), /Net sales +P4,600\.00/.test(z2), /Sales +P4,750\.00/.test(z2)], [true, true, true, true]);
    eq('Z: positive difference has +', /Difference +\+P5\.00/.test(e.r(`Printer.describe(Printer.shiftReportBytes({shift: Object.assign({}, ZSHIFT, {cash_variance: 5}), metrics: ZM}, {paper_width: 80}))`)), true);
    eq('X: no loyalty line when none used (same rows as the screen)', /Loyalty/.test(e.r(`Printer.describe(Printer.shiftReportBytes({shift: SHIFT, metrics: Object.assign({}, M, {loyaltyRewards: 0}), isX: true}, {}))`)), false);
    eq('X: no waste line unless given', /Waste/.test(e.r(`Printer.describe(Printer.shiftReportBytes({shift: SHIFT, metrics: M}, {}))`)), false);
    eq('report: a bare open shift = X; a bare closed shift = Z', [/X REPORT/.test(e.r(`Printer.describe(Printer.shiftReportBytes(SHIFT, {metrics: M}))`)), /Z REPORT/.test(e.r(`Printer.describe(Printer.shiftReportBytes(ZSHIFT, {metrics: ZM}))`))], [true, true]);
    // metrics from shiftMetrics(shift) when not given (state data)
    e.r(`state.sales = [{id:'a', shift_id:'sh1', status:'COMPLETED', subtotal:200, discount_amount:20, loyalty_discount:0, tax_amount:0, service_charge_amount:0, grand_total:180},
                        {id:'b', shift_id:'sh1', status:'COMPLETED', subtotal:100, discount_amount:0, loyalty_discount:0, tax_amount:0, service_charge_amount:0, grand_total:100}];
         state.payments = [{sale_id:'a', method:'CASH', amount:180}, {sale_id:'b', method:'GCASH', amount:100}];
         state.refunds = []; state.cashMovements = [{shift_id:'sh1', type:'PAY_OUT', amount:50, at:'2026-11-02T02:00:00Z'}];`);
    const live = e.r(`Printer.describe(Printer.shiftReportBytes(SHIFT, {paper_width: 80}))`);
    const m = e.r(`shiftMetrics(SHIFT)`);
    eq('report without metrics: figures = shiftMetrics(shift) (Sales, Cash, Other, Expected)', [/Sales +P280\.00/.test(live), /Cash +P180\.00/.test(live), /Other methods +P100\.00/.test(live), live.includes(e.r(`Printer.money(${m.expectedCash}, 'P')`)) && /Expected cash +P1,130\.00/.test(live), m.expectedCash], [true, true, true, true, 1130]);
  }

  /* ---------- no print screen unless fallback === true ---------- */
  {
    const e = makeEnv({nav: {userAgent: MAC_CHROME}}); e.r(SAMPLE); e.r(DATA);
    const t0 = Date.now();
    const a = await e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    const b = await e.r(`Printer.printTicket(ORDER, {})`);
    const c = await e.r(`Printer.printShiftReport({shift: ZSHIFT, metrics: ZM}, {})`);
    const d = await e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {auto: true})`);
    const f = await e.r(`Printer.printTicket(ORDER, {fallback: false})`);
    eq('no printer: receipt / ticket / report / auto -> {ok:false, error:NOT_CONNECTED}, plain message',
      [a, b, c, d, f].map(x => [x.ok, x.error, x.code, x.method, /No receipt printer is connected/.test(x.message)]), Array(5).fill([false, 'NOT_CONNECTED', 'NOT_CONNECTED', 'none', true]));
    eq('no printer: answered quickly, print screen NEVER opened', [Date.now() - t0 < 200, e.printed.length], [true, 0]);
    eq('no printer: no error event / last_error spam', e.r(`Printer.status().last_error`), '');
    const ra = await e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {fallback: true})`);
    const rb = await e.r(`Printer.printTicket(ORDER, {fallback: true})`);
    const rc = await e.r(`Printer.printShiftReport({shift: ZSHIFT, metrics: ZM}, {fallback: true, html: '<p>Z from the counter</p>'})`);
    const rd = await e.r(`Printer.printShiftReport({shift: SHIFT, metrics: M}, {fallback: true})`);
    eq('fallback:true (staff tapped "Use print screen") -> print screen, ok', [ra.ok, ra.method, rb.method, rc.method, rd.method, e.printed.length], [true, 'dialog', 'dialog', 'dialog', 'dialog', 4]);
    eq('fallback pages: receipt html, ticket text page, caller html, X text page (escaped)',
      [/Receipt TXN-0042/.test(e.printed[0].html), /Q-17/.test(e.printed[1].html) && /QR ORDER/.test(e.printed[1].html) && !/\[CUT\]/.test(e.printed[1].html), e.printed[2].html, /X REPORT/.test(e.printed[3].html)],
      [true, true, '<p>Z from the counter</p>', true]);
    eq('fallback text page escapes HTML in data', /&lt;b&gt;/.test(e.r(`Printer.textHtml('t', Printer.ticketBytes({order_number: 'Q-1', customer_nickname: '<b>x</b>', items: []}, {}))`)), true);
    const pt = await e.r(`Printer.printTest({})`);
    eq('printTest without a printer: plain words, nothing sent', [pt.ok, /Choose a Bluetooth printer, a USB printer or a printer port first/.test(pt.error)], [false, true]);
    // Safari / iPad with an old setting: NOT_CONNECTED + the browser's own words, no print screen
    const s = makeEnv({nav: {userAgent: MAC_SAFARI, vendor: 'Apple Computer, Inc.', platform: 'MacIntel', maxTouchPoints: 0}}); s.r(SAMPLE); s.r(DATA);
    await s.r(`Printer.saveSettings({connection: 'usb', usb_vendor_id: 0x0483, usb_product_id: 0x5743})`);
    const sr = await s.r(`Printer.printTicket(ORDER, {})`);
    eq('Safari + saved USB printer -> NOT_CONNECTED, Safari words, no print screen', [sr.error, /Safari can't print/.test(sr.message), s.printed.length], ['NOT_CONNECTED', true, 0]);
  }

  /* ---------- fake USB printer ---------- */
  {
    const f = fakeUsb();
    const e = makeEnv({nav: {userAgent: MAC_CHROME, platform: 'MacIntel', usb: f.usb}}); e.r(SAMPLE); e.r(DATA);
    await e.r(`Printer.init()`);
    eq('support(): usb on, browser chrome, mac', e.r(`(function(){ const s = Printer.support(); return [s.usb, s.browser, s.platform, s.brave, s.safari]; })()`), [true, 'chrome', 'mac', false, false]);
    const st = await e.r(`Printer.chooseUsb()`);
    const req = f.log.requests[0];
    eq('chooser filters: printer class 7 + Xprinter / Epson / Star vendor ids', [req.filters[0].classCode, [0x0483, 0x0416, 0x1fc9, 0x04b8, 0x0519, 0x1504].every(v => req.filters.some(x => x.vendorId === v))], [7, true]);
    eq('open + selectConfiguration(1) + claims the PRINTER interface (1), not HID (0)', [f.log.opens, f.log.selects, f.log.claims], [1, 1, [1]]);
    eq('connected + remembered (vendor / product / serial / name)', [st.connected, st.name, e.r(`Printer.settings().connection`), e.r(`Printer.settings().usb_vendor_id`), e.r(`Printer.settings().usb_product_id`), e.r(`Printer.settings().usb_serial`), e.r(`Printer.settings().device_id`)],
      [true, 'Printer POS-58', 'usb', 0x0483, 0x5743, 'XP58-0001', 'usb:0483:5743']);
    eq('isDirect() true with a USB printer', e.r(`Printer.isDirect()`), true);
    await e.r(`Printer.saveSettings({usb_chunk: 64})`);
    const exp = Array.from(e.r(`Printer.receiptBytes(SALE, ITEMS, PAYS, {})`));
    const res = await e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('receipt printed by USB, no print screen', [res.ok, res.method, res.code, e.printed.length], [true, 'usb', undefined, 0]);
    eq('chunked writes (<= 64 bytes, several), all bytes in order to bulk OUT endpoint 3', [f.log.writes.every(w => w.length <= 64), f.log.writes.length > 5, hex(f.all()) === hex(exp)], [true, true, true]);
    eq('never resets the device (macOS reset bug)', f.log.resets, 0);
    // ticket + receipt back to back: never interleave
    f.log.writes.length = 0;
    const tb = Array.from(e.r(`Printer.ticketBytes(ORDER, {})`));
    const [r1, r2] = await Promise.all([e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`), e.r(`Printer.printTicket(ORDER, {})`)]);
    eq('receipt + ticket at once: one after the other, nothing mixed', [r1.ok, r2.ok, hex(f.all()) === hex(exp.concat(tb))], [true, true, true]);
    const pend = []; e.ctx.__p = pend; e.r(`Printer.on('status', s => __p.push(s.pending))`);
    f.log.writes.length = 0;
    const xb = Array.from(e.r(`Printer.shiftReportBytes({shift: ZSHIFT, metrics: ZM}, {})`));
    const three = await Promise.all([e.r(`Printer.printTicket(ORDER, {})`), e.r(`Printer.printShiftReport({shift: ZSHIFT, metrics: ZM}, {})`), e.r(`Printer.printTicket(ORDER, {})`)]);
    eq('three jobs queued: in order, status.pending counted up to 3 and back to 0', [three.every(x => x.ok), hex(f.all()) === hex(tb.concat(xb, tb)), Math.max(...pend), e.r(`Printer.status().pending`)], [true, true, 3, 0]);
    // stall -> clearHalt -> carries on
    const fs = fakeUsb({stallAt: 2});
    const es = makeEnv({nav: {userAgent: MAC_CHROME, usb: fs.usb}}); es.r(SAMPLE); es.r(DATA);
    await es.r(`Printer.chooseUsb()`); await es.r(`Printer.saveSettings({usb_chunk: 100})`);
    const rs = await es.r(`Printer.printTicket(ORDER, {})`);
    eq('endpoint stall: clearHalt once, then the whole ticket (nothing lost or doubled)', [rs.ok, fs.log.clearHalts, hex(fs.all()) === hex(es.r(`Printer.ticketBytes(ORDER, {})`))], [true, 1, true]);
    // unplugged part-way: partial, no print screen; per-job errors; replug -> next job prints
    const fu = fakeUsb({unplugAfter: 2});
    const eu = makeEnv({nav: {userAgent: MAC_CHROME, platform: 'MacIntel', usb: fu.usb}}); eu.r(SAMPLE); eu.r(DATA);
    await eu.r(`Printer.init()`); await eu.r(`Printer.chooseUsb()`); await eu.r(`Printer.saveSettings({usb_chunk: 64})`);
    const [p1, p2] = await Promise.all([eu.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {fallback: true})`), eu.r(`Printer.printTicket(ORDER, {})`)]);
    eq('unplugged after 2 writes: receipt partial (plain words), never the print screen even with fallback:true',
      [p1.ok, p1.partial, p1.code, p1.method, /^Printing stopped part-way\. The USB printer was unplugged/.test(p1.error), eu.printed.length], [false, true, 'PARTIAL', 'usb', true, 0]);
    eq('…the queued ticket is its own job: reconnects quietly and prints in full', [p2.ok, p2.method, fu.log.requests.length, hex([].concat(...fu.log.writes.slice(2)).slice(-tb.length)) === hex(tb)], [true, 'usb', 1, true]);
    // disconnect + connect events (re-plug) -> reconnect, no chooser
    fu.device.opened = false; fu.usb.fire('disconnect');
    eq('disconnect event -> not connected', eu.r(`Printer.status().connected`), false);
    fu.usb.fire('connect');
    await sleep(400);
    eq('connect event (cable plugged back in) -> connected again without a chooser', [eu.r(`Printer.status().connected`), fu.log.requests.length], [true, 1]);
    // forget
    await eu.r(`Printer.forget()`);
    eq('forget(): device.forget(), settings cleared', [fu.log.forgot, eu.r(`Printer.settings().connection`), eu.r(`Printer.settings().usb_vendor_id`), eu.r(`Printer.status().connected`)], [1, 'dialog', 0, false]);
  }

  /* ---------- reconnect on page load without a prompt ---------- */
  {
    const saved = `{connection: 'usb', device_id: 'usb:0483:5743', device_name: 'Printer POS-58', usb_vendor_id: 0x0483, usb_product_id: 0x5743, usb_serial: 'XP58-0001'}`;
    const f = fakeUsb();
    const e = makeEnv({nav: {userAgent: MAC_CHROME, usb: f.usb}}); e.r(SAMPLE); e.r(DATA);
    await e.r(`LocalDB.set('cccc.printer.settings', ${saved})`);
    await e.r(`Printer.init()`); await sleep(30);
    eq('page load: reconnects to the remembered USB printer, no chooser', [e.r(`Printer.status().connected`), f.log.requests.length, f.log.claims], [true, 0, [1]]);
    const r = await e.r(`Printer.printTicket(ORDER, {})`);
    eq('…and prints', [r.ok, r.method], [true, 'usb']);
    const fb = fakeUsb({farbled: true});
    const eb = makeEnv({nav: {userAgent: MAC_CHROME, brave: {isBrave(){ return Promise.resolve(true); }}, usb: fb.usb}}); eb.r(SAMPLE);
    await eb.r(`LocalDB.set('cccc.printer.settings', ${saved})`);
    await eb.r(`Printer.init()`); await sleep(30);
    eq('Brave (serial number changed by the fingerprint shield): still reconnects by vendor / product', [eb.r(`Printer.status().connected`), fb.log.requests.length], [true, 0]);
    const fn = fakeUsb({noRemember: true});
    const en = makeEnv({nav: {userAgent: MAC_CHROME, usb: fn.usb}}); en.r(SAMPLE); en.r(DATA);
    await en.r(`LocalDB.set('cccc.printer.settings', ${saved})`);
    await en.r(`Printer.init()`); await sleep(30);
    const rn = await en.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('browser forgot the permission (no serial number / restarted): usb_needs_tap, NOT_CONNECTED "choose again", no chooser, no print screen',
      [en.r(`Printer.status().usb_needs_tap`), rn.error, /choose the USB printer again/.test(rn.message), fn.log.requests.length, en.printed.length], [true, 'NOT_CONNECTED', true, 0, 0]);
  }

  /* ---------- claimInterface fails (another app / driver holds it) ---------- */
  {
    const f = fakeUsb({busy: 1});
    const e = makeEnv({nav: {userAgent: MAC_CHROME, platform: 'MacIntel', usb: f.usb}}); e.r(SAMPLE); e.r(DATA);
    let err = null; try{ await e.r(`Printer.chooseUsb()`); }catch(x){ err = x; }
    eq('claim failure: plain Mac steps (Printers & Scanners, unplug, Connect USB printer)', [!!err, err && err.code, /Another program is using the USB printer/.test(err && err.friendly), /System Settings > Printers & Scanners/.test(err && err.friendly), /Tap Connect USB printer again/.test(err && err.friendly)], [true, 'USB_BUSY', true, true, true]);
    eq('claim failure: printer still remembered (it reconnects once free); last_error set', [e.r(`Printer.settings().connection`), e.r(`Printer.settings().usb_vendor_id`), /Another program/.test(e.r(`Printer.status().last_error`))], ['usb', 0x0483, true]);
    const r = await e.r(`Printer.printTicket(ORDER, {})`);
    eq('…next print: claim works now -> prints, no chooser', [r.ok, r.method, f.log.requests.length], [true, 'usb', 1]);
    const f2 = fakeUsb({busy: true});
    const e2 = makeEnv({nav: {userAgent: MAC_CHROME, platform: 'MacIntel', usb: f2.usb}}); e2.r(SAMPLE); e2.r(DATA);
    try{ await e2.r(`Printer.chooseUsb()`); }catch(x){}
    const r2 = await e2.r(`Printer.printTicket(ORDER, {})`);
    eq('still held: print answers code USB_BUSY with the same steps, no print screen', [r2.ok, r2.code, /Printers & Scanners/.test(r2.error), r2.error === r2.message, e2.printed.length], [false, 'USB_BUSY', true, true, 0]);
    const fc = fakeUsb({cancel: true});
    const ec = makeEnv({nav: {userAgent: MAC_CHROME, usb: fc.usb}});
    let mc = null; try{ await ec.r(`Printer.chooseUsb()`); }catch(x){ mc = x.friendly; }
    eq('chooser closed: "No printer was chosen." + what to check', /^No printer was chosen\. If your printer wasn't in the list/.test(mc || ''), true);
    const fa = fakeUsb();
    const ea = makeEnv({nav: {userAgent: MAC_CHROME, usb: fa.usb}});
    await ea.r(`Printer.chooseUsb({showAll: true})`);
    eq('showAll -> filters: [] (every USB device)', fa.log.requests[0].filters, []);
  }

  /* ---------- security L1: payment status line can't be faked by customer text ---------- */
  {
    const e = makeEnv(); e.r(SAMPLE); e.r(DATA);
    const d = (o, op) => e.r(`Printer.describe(Printer.ticketBytes(${o}, ${op || '{}'}))`);
    const unpaid = d(`Object.assign({}, ORDER, {paid_at: null, customer_nickname: 'Ana PAID'})`);
    const statusOf = (t) => { const m = t.match(/-{32}\n\[B\]\[SIZE 1x2\]([^\n]*)\n\[SIZE 1x1\]\[\/B\]-{32}\n/); return m ? m[1] : null; };
    eq('L1: unpaid QR order, nickname "Ana PAID" -> fixed status line NOT PAID, name labelled', [statusOf(unpaid), /\nName: Ana PAID\n/.test(unpaid), (unpaid.match(/^(\[[^\]]+\])*PAID$/gm) || []).length], ['NOT PAID - PAY AT COUNTER', true, 0]);
    eq('L1: paid QR order -> PAID status line', statusOf(d(`ORDER`)), 'PAID');
    eq('L1: counter sale with opts.paid -> PAID; without -> no status line', [statusOf(d(`{transaction_number: 'T1', items: []}`, `{paid: true}`)), statusOf(d(`{transaction_number: 'T1', items: []}`))], ['PAID', null]);
    eq('L1: status comes only from paid_at / opts.paid (customer fields "paid" ignored)', statusOf(d(`Object.assign({}, ORDER, {paid_at: null, paid: true, status: 'PAID', customer_note: 'PAID'})`)), 'NOT PAID - PAY AT COUNTER');
  }

  /* ---------- security L2: only receipt printers are printed to ---------- */
  {
    const IF = (n, cls, out) => ({interfaceNumber: n, claimed: false, alternates: [{alternateSetting: 0, interfaceClass: cls, endpoints: out ? [{endpointNumber: 3, direction: 'out', type: 'bulk'}] : []}]});
    const tryDev = async (o, showAll) => {
      const f = fakeUsb(o);
      const e = makeEnv({nav: {userAgent: MAC_CHROME, usb: f.usb}}); e.r(SAMPLE); e.r(DATA);
      let err = null; try{ await e.r(`Printer.chooseUsb(${showAll ? '{showAll: true}' : ''})`); }catch(x){ err = x; }
      return {err, f, e, conn: e.r(`Printer.status().connected`), setting: e.r(`Printer.settings().connection`)};
    };
    const a = await tryDev({ifaces: [IF(0, 0xFF, true)]});
    eq('L2: vendor-specific (0xFF) interface + known maker (0x0483), no class 7 -> accepted', [a.err, a.conn, a.f.log.claims], [null, true, [0]]);
    const b = await tryDev({vendorId: 0x1234, ifaces: [IF(0, 0xFF, true)]}, true);
    eq('L2: 0xFF interface, unknown maker (Show all) -> refused NO_USB_OUT, nothing claimed or saved', [b.err && b.err.code, /^That device isn't a receipt printer/.test(b.err && b.err.friendly), b.f.log.claims, b.conn, b.setting], ['NO_USB_OUT', true, [], false, 'dialog']);
    const c = await tryDev({ifaces: [IF(0, 7, false), IF(1, 0xFF, true)]});
    eq('L2: has a class-7 interface (no bulk OUT) -> the 0xFF one is NOT used -> NO_USB_OUT', [c.err && c.err.code, c.f.log.claims], ['NO_USB_OUT', []]);
    const d = await tryDev({vendorId: 0x046d, ifaces: [IF(0, 3, true), IF(1, 0x08, true), IF(2, 0x02, true), IF(3, 0x0A, true)]}, true);
    eq('L2: HID / storage / CDC device picked with Show all -> NO_USB_OUT', [d.err && d.err.code, d.f.log.claims], ['NO_USB_OUT', []]);
    const g = await tryDev({ifaces: [IF(0, 0xFF, true), IF(1, 7, true)]});
    eq('L2: class 7 preferred over 0xFF', [g.err, g.f.log.claims], [null, [1]]);
  }

  /* ---------- browsers: Brave, Safari, Chrome, Firefox ---------- */
  {
    const fb = fakeUsb();
    const btOff = {async getAvailability(){ return true; }, async requestDevice(){ throw Object.assign(new Error('Web Bluetooth API globally disabled.'), {name: 'NotFoundError', code: 8}); }, async getDevices(){ return []; }};
    const b = makeEnv({nav: {userAgent: MAC_CHROME, platform: 'MacIntel', brave: {isBrave(){ return Promise.resolve(true); }}, usb: fb.usb, bluetooth: btOff, serial: {requestPort(){}, getPorts(){ return []; }}}});
    eq('Brave detected (navigator.brave), usb on', b.r(`(function(){ const s = Printer.support(); return [s.browser, s.brave, s.usb]; })()`), ['brave', true, true]);
    const bt = b.r(`Printer.supportText()`);
    eq('Brave text: USB works, Bluetooth flag named, Chrome recommended', [/Connect USB printer/.test(bt), /brave:\/\/flags\/#brave-web-bluetooth-api/.test(bt), /Google Chrome is the most reliable/.test(bt)], [true, true, true]);
    const hs = b.r(`Printer.helpSteps()`);
    eq('Brave help steps: title, settings url, Shields note, flags, serial 1.69', [hs.title, hs.notes.some(n => /brave:\/\/settings\/content\/usbDevices/.test(n)), hs.notes.some(n => /Shields/.test(n)), hs.notes.some(n => /brave-web-bluetooth-api/.test(n)), hs.notes.some(n => /1\.69/.test(n)), hs.notes.some(n => /Printers & Scanners/.test(n))],
      ['Brave on a Mac + USB receipt printer', true, true, true, true, true]);
    let m = null; try{ await b.r(`Printer.choose()`); }catch(x){ m = x.friendly; }
    eq('Brave Bluetooth off -> exact flag steps', /brave:\/\/flags\/#brave-web-bluetooth-api.*Enabled.*Relaunch/.test(m || ''), true);
    const s = makeEnv({nav: {userAgent: MAC_SAFARI, vendor: 'Apple Computer, Inc.', platform: 'MacIntel', maxTouchPoints: 0}});
    eq('Safari on a Mac: detected, no usb / serial / bluetooth, plain words', [s.r(`Printer.support().safari`), s.r(`Printer.support().usb`), /Safari can't print straight to a receipt printer/.test(s.r(`Printer.supportText()`)), /Install Google Chrome/.test(s.r(`Printer.helpSteps()`).steps.join(' '))], [true, false, true, true]);
    let sm = null; try{ await s.r(`Printer.chooseUsb()`); }catch(x){ sm = x.friendly; }
    eq('Safari: chooseUsb refuses in plain words', /Safari can't print/.test(sm || ''), true);
    const c = makeEnv({nav: {userAgent: MAC_CHROME, platform: 'MacIntel', usb: fakeUsb().usb, bluetooth: btOff, serial: {requestPort(){}, getPorts(){ return []; }}}});
    eq('Chrome on a Mac: all three ways listed; help recommends Chrome', [c.r(`Printer.supportText()`), c.r(`Printer.helpSteps()`).title, c.r(`Printer.helpSteps()`).notes.some(n => /recommended/.test(n))],
      ['This browser can print by USB cable, Bluetooth or a printer port (Bluetooth or USB).', 'Chrome on a Mac + USB receipt printer', true]);
    const ff = makeEnv({nav: {userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:131.0) Gecko/20100101 Firefox/131.0'}});
    eq('Firefox: names Chrome or Edge', [/Chrome or Edge/.test(ff.r(`Printer.supportText()`)), ff.r(`Printer.support().browser`)], [true, 'firefox']);
    eq('Edge detected', makeEnv({nav: {userAgent: MAC_CHROME + ' Edg/141.0.0.0'}}).r(`Printer.browserName()`), 'edge');
  }

  /* ---------- settings ---------- */
  {
    const {r} = makeEnv();
    eq('new defaults: auto ticket + shift on, QR OFF (lead decision), 1 ticket copy, usb_chunk 1024', r(`(function(){ const s = Printer.settings(); return [s.auto_print_ticket, s.auto_print_qr, s.auto_print_shift, s.ticket_copies, s.usb_chunk, s.auto_print]; })()`), [true, false, true, 1, 1024, false]);
    eq('cleanSettings: usb kept, bad ids / chunk / copies fixed', r(`(function(){ const s = Printer.cleanSettings({connection:'usb', usb_vendor_id: -4, usb_product_id: 99999, usb_chunk: 3, ticket_copies: 7, auto_print_qr: 'yes'}); return [s.connection, s.usb_vendor_id, s.usb_product_id, s.usb_chunk, s.ticket_copies, s.auto_print_qr]; })()`), ['usb', 0, 0, 64, 3, false]);
  }

  console.log(`\nSUMMARY unit/printer_usb_check: ${checks} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); console.log(`SUMMARY unit/printer_usb_check: ${checks} checks, ${failed + 1} failed`); process.exit(1); });
