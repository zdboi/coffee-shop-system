// Unit checks for cccc/shared/printer.js (release 1.3, P1): ESC/POS bytes, ASCII folding,
// 58 / 80 mm golden receipts, cut + drawer bytes, chunked Bluetooth writes with a fake
// device (small-MTU fallback, one reconnect after a drop), Web Serial, print-dialog fallback,
// unsupported browsers. No hardware, no database.
// Run:  node tests/unit/printer_check.js   (REPO=<repo> optional; tests/run_all.sh runs it)
const {makeEnv, SAMPLE} = require('./printer_env.js');

let checks = 0, failed = 0;
function eq(name, got, exp){
  checks++;
  const good = JSON.stringify(got) === JSON.stringify(exp);
  if(!good) failed++;
  console.log((good ? 'ok   ' : 'FAIL ') + name + (good ? '' : '\n   got:      ' + JSON.stringify(got) + '\n   expected: ' + JSON.stringify(exp)));
}
const hex = (a) => Array.from(a).map(x => x.toString(16).padStart(2, '0')).join(' ');
function indexOfSeq(arr, seq){ outer: for(let i = 0; i <= arr.length - seq.length; i++){ for(let j = 0; j < seq.length; j++) if(arr[i+j] !== seq[j]) continue outer; return i; } return -1; }
function countSeq(arr, seq){ let n = 0, i = -1, a = Array.from(arr); while(true){ const k = indexOfSeq(a.slice(i + 1), seq); if(k < 0) return n; n++; i += k + 1; } }

/* ---------- fake Web Bluetooth ---------- */
function fakeBle(o){
  o = o || {};
  const log = {writes: [], requests: [], connects: 0};
  const listeners = {};
  const device = {
    id: 'dev-1', name: o.name || 'Printer001',
    addEventListener(t, fn){ (listeners[t] = listeners[t] || []).push(fn); },
    gatt: {
      connected: false,
      async connect(){ log.connects++; if(o.refuseConnect && log.connects > (o.refuseAfter || 0)) throw Object.assign(new Error('GATT connection failed'), {name: 'NetworkError'}); this.connected = true; return server; },
      disconnect(){ this.connected = false; },
    },
    drop(){ device.gatt.connected = false; (listeners.gattserverdisconnected || []).forEach(f => f()); },
  };
  const ch = {
    uuid: '00002af1-0000-1000-8000-00805f9b34fb', properties: {write: true, writeWithoutResponse: true},
    async writeValueWithoutResponse(v){
      if(!device.gatt.connected) throw Object.assign(new Error('GATT Server is disconnected.'), {name: 'NetworkError'});
      if(o.mtu && v.length > o.mtu) throw Object.assign(new Error('GATT operation failed for unknown reason.'), {name: 'NotSupportedError'});
      log.writes.push(Array.from(v));
      if(o.dropAfter && log.writes.length === o.dropAfter && !log.dropped){ log.dropped = true; device.drop(); }
    },
  };
  const readOnly = {uuid: '00002af0-0000-1000-8000-00805f9b34fb', properties: {notify: true}};
  const svc = {uuid: '000018f0-0000-1000-8000-00805f9b34fb', async getCharacteristics(){ return [readOnly, ch]; }};
  const server = {async getPrimaryServices(){ return [svc]; }, async getPrimaryService(){ return svc; }};
  const bluetooth = {
    async getAvailability(){ return true; },
    async requestDevice(req){ log.requests.push(req); if(o.cancel) throw Object.assign(new Error('User cancelled the requestDevice() chooser.'), {name: 'NotFoundError'}); return device; },
    async getDevices(){ return o.noRemember ? [] : [device]; },
  };
  return {bluetooth, device, log, all: () => [].concat(...log.writes)};
}

(async () => {
  /* ---------- text helpers ---------- */
  {
    const {r} = makeEnv();
    eq('toAscii: peso sign -> P', r("Printer.toAscii('₱150 off')"), 'P150 off');
    eq('toAscii: peso sign -> PHP (style)', r("Printer.toAscii('₱150', 'PHP ')"), 'PHP 150');
    eq('toAscii: n-tilde / accents folded', r("Printer.toAscii('Señora Café Ñ')"), 'Senora Cafe N');
    eq('toAscii: quotes, dashes, ellipsis, times', r("Printer.toAscii('“Jun” — 2×… ‘a’')"), '"Jun" - 2x... \'a\'');
    eq('toAscii: emoji dropped, CJK -> ?', r("Printer.toAscii('Latte ☕🍰 拿铁')"), 'Latte  ??');
    eq('toAscii: ESC / GS / NUL in text are removed (no printer commands from names)', r("Printer.toAscii('A\\x1b@B\\x1dV\\x00C\\x7f')"), 'A@BVC');
    eq('toAscii: narrow no-break space (Chrome time format) -> space', r("Printer.toAscii('3:05\\u202fPM')"), '3:05 PM');
    // Security L1: data fields are one line (no fake receipt lines)
    eq('toAscii: \\n, \\r\\n, \\r, U+2028, U+2029 -> space', r("Printer.toAscii('A\\nB\\r\\nC\\rD\\u2028E\\u2029F')"), 'A B C D E F');
    eq('toAscii keepBreaks: real line breaks kept (settings text)', r("Printer.toAscii('A\\nB\\u2028C', 'P', true)"), 'A\nB\nC');
    eq('b.line(): nickname "A\\nTOTAL P0.00" prints on one line', r("Printer.describe(Printer.EscPos({paper_width:58}).line('A\\nTOTAL P0.00').toUint8())"), 'A TOTAL P0.00\n');
    eq('b.lines(): header keeps its two lines', r("Printer.describe(Printer.EscPos({paper_width:58}).lines('Line one\\nLine two').toUint8())"), 'Line one\nLine two\n');
    eq('money P', r("Printer.money(1234.5, 'P')"), 'P1,234.50');
    eq('money PHP', r("Printer.money(1234567.891, 'PHP')"), 'PHP 1,234,567.89');
    eq('money none', r("Printer.money(0, 'none')"), '0.00');
    eq('money negative', r("Printer.money(-10, 'P')"), '-P10.00');
    eq('money bad input -> 0', r("Printer.money('x', 'P')"), 'P0.00');
    eq('leftRight fits exactly 32', r("Printer.leftRight('Subtotal', 'P410.00', 32)"), ['Subtotal                 P410.00']);
    eq('leftRight wraps a long left side, price on first line', r("Printer.leftRight('1 x Ube Cheese Pandesal (box of 6) special', 'P110.00', 32, 2)"),
      ['1 x Ube Cheese Pandesal  P110.00', '  (box of 6) special']);
    eq('wrap keeps the indent of "  - option" lines', r("Printer.wrap('  - a very long modifier label that wraps around', 20)"), ['  - a very long', '  modifier label', '  that wraps around']);
    eq('wrap cuts a word longer than the line', r("Printer.wrap('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 10)"), ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ']);
  }

  /* ---------- builder bytes ---------- */
  {
    const {r} = makeEnv();
    eq('init = ESC @', hex(r("Printer.EscPos({}).init().toUint8()")), '1b 40');
    eq('align centre = ESC a 1, right = ESC a 2', hex(r("Printer.EscPos({}).align('center').align('right').align('left').toUint8()")), '1b 61 01 1b 61 02 1b 61 00');
    eq('bold on/off = ESC E 1 / 0', hex(r("Printer.EscPos({}).bold(true).bold(false).toUint8()")), '1b 45 01 1b 45 00');
    eq('double size = GS ! 0x11, tall only = GS ! 0x01, normal = GS ! 0', hex(r("Printer.EscPos({}).size(2,2).size(1,2).size(1,1).toUint8()")), '1d 21 11 1d 21 01 1d 21 00');
    eq('feed 4 = ESC d 4', hex(r("Printer.EscPos({}).feed(4).toUint8()")), '1b 64 04');
    eq('partial cut = GS V 1', hex(r("Printer.EscPos({}).cut().toUint8()")), '1d 56 01');
    eq('drawer kick = ESC p 0 25 250', hex(r("Printer.EscPos({}).drawer().toUint8()")), '1b 70 00 19 fa');
    eq('separator = 32 dashes at 58 mm', r("Printer.describe(Printer.EscPos({paper_width:58}).sep().toUint8())"), '-'.repeat(32) + '\n');
    eq('separator = 48 dashes at 80 mm', r("Printer.describe(Printer.EscPos({paper_width:80}).sep().toUint8())"), '-'.repeat(48) + '\n');
    eq('double-width text wraps at 16 (58 mm)', r("Printer.describe(Printer.EscPos({paper_width:58}).size(2,2).line('Cavite City Coffee Club').toUint8())"), '[SIZE 2x2]Cavite City\nCoffee Club\n');
    eq('QR code bytes (GS ( k model 2, store, print)', hex(r("Printer.EscPos({}).qr('AB', 5).toUint8()")),
      '1d 28 6b 04 00 31 41 32 00 1d 28 6b 03 00 31 43 05 1d 28 6b 03 00 31 45 30 1d 28 6b 05 00 31 50 30 41 42 1d 28 6b 03 00 31 51 30');
    eq('chunk 45 bytes by 20 -> 20/20/5', r("Printer.chunk(new Uint8Array(45), 20).map(c => c.length)"), [20, 20, 5]);
    eq('chunk empty -> none', r("Printer.chunk(new Uint8Array(0), 20).length"), 0);
    eq('only bytes 0x0a and 0x20..0x7e outside commands (sample receipt)', (() => {
      const e = makeEnv(); e.r(SAMPLE);
      const d = e.r("Printer.describe(Printer.receiptBytes(SALE, ITEMS, PAYS, {}))");
      return /\[0x/.test(d);
    })(), false);
  }

  /* ---------- golden receipts ---------- */
  const GOLD58 = [
    '[INIT][DRAWER][ALIGN C][B][SIZE 2x2]Cavite City',
    'Coffee Club',
    '[SIZE 1x1][/B]123 P. Burgos Ave., Caridad,',
    'Cavite City',
    '0917 123 4567',
    'TIN: 123-456-789-000',
    '[ALIGN L]--------------------------------',
    'TXN-0042             Nov 2, 2026',
    'Cashier: Ana Senora      3:05 PM',
    'QR Q-17                  Table 4',
    'Customer                     Bea',
    '--------------------------------',
    '2 x Iced Spanish Latte   P300.00',
    '  - Oat milk (+P20.00)',
    '  - Less ice',
    '  "For Kuya "Jun""',
    '1 x Ube Cheese Pandesal  P110.00',
    '  (box of 6) - special',
    '--------------------------------',
    'Subtotal                 P410.00',
    'Discount                 -P41.00',
    'Stamp reward: P10 off    -P10.00',
    '[B][SIZE 1x2]TOTAL                    P359.00',
    '[SIZE 1x1][/B]--------------------------------',
    'Payment (Cash)           P359.00',
    'Cash received            P500.00',
    'Change                   P141.00',
    '--------------------------------',
    '[ALIGN C]Salamat po! Balik kayo',
    '[ALIGN L][FEED 4][CUT]',
  ].join('\n');
  const GOLD80 = [
    '[INIT][DRAWER][ALIGN C][B][SIZE 2x2]Cavite City Coffee Club',
    '[SIZE 1x1][/B]123 P. Burgos Ave., Caridad, Cavite City',
    '0917 123 4567',
    'TIN: 123-456-789-000',
    '[ALIGN L]------------------------------------------------',
    'TXN-0042                             Nov 2, 2026',
    'Cashier: Ana Senora                      3:05 PM',
    'QR Q-17                                  Table 4',
    'Customer                                     Bea',
    '------------------------------------------------',
    '2 x Iced Spanish Latte                   P300.00',
    '  - Oat milk (+P20.00)',
    '  - Less ice',
    '  "For Kuya "Jun""',
    '1 x Ube Cheese Pandesal (box of 6) -     P110.00',
    '  special',
    '------------------------------------------------',
    'Subtotal                                 P410.00',
    'Discount                                 -P41.00',
    'Stamp reward: P10 off                    -P10.00',
    '[B][SIZE 1x2]TOTAL                                    P359.00',
    '[SIZE 1x1][/B]------------------------------------------------',
    'Payment (Cash)                           P359.00',
    'Cash received                            P500.00',
    'Change                                   P141.00',
    '------------------------------------------------',
    '[ALIGN C]Salamat po! Balik kayo',
    '[ALIGN L][FEED 4][CUT]',
  ].join('\n');
  {
    const e = makeEnv(); e.r(SAMPLE);
    const OPTS = `{customerName: 'Bea', rewardLabel: '₱10 off', qrOrder: {order_number: 'Q-17', table_label: 'Table 4'}, openDrawer: true}`;
    const d58 = e.r(`Printer.describe(Printer.receiptBytes(SALE, ITEMS, PAYS, Object.assign({paper_width: 58}, ${OPTS})))`);
    const d80 = e.r(`Printer.describe(Printer.receiptBytes(SALE, ITEMS, PAYS, Object.assign({paper_width: 80}, ${OPTS})))`);
    eq('golden receipt 58 mm (32 characters)', d58, GOLD58);
    eq('golden receipt 80 mm (48 characters)', d80, GOLD80);
    const widthOk = (d, w) => d.split('\n').every(l => { const t = l.replace(/\[[A-Z0-9 x\/]+\]/g, ''); return t.length <= w; });
    eq('every 58 mm line fits 32 characters', widthOk(d58, 32), true);
    eq('every 80 mm line fits 48 characters', widthOk(d80, 48), true);
    // money on the paper = the sale's saved numbers (no recomputation)
    eq('receipt total = sale.grand_total formatted', /TOTAL +P359\.00/.test(d58), true);
    {
      const e2 = makeEnv(); e2.r(SAMPLE);
      e2.r(`state.settings.receipt_header = 'Open daily\\nFree wifi'; state.settings.receipt_footer = 'Salamat Balik kayo';
            SALE.cashier_name = 'Ana\\nTOTAL P0.00'; ITEMS[0].notes = 'x\\r\\nTOTAL P0.00'; ITEMS[0].modifiers[0].label = 'Oat TOTAL P0.00';
            PAYS[0].reference = 'R1\\nTOTAL P0.00'`);
      const dx = e2.r(`Printer.describe(Printer.receiptBytes(SALE, ITEMS, PAYS, {paper_width: 80, customerName: 'A\\nTOTAL P0.00', qrOrder: {order_number: 'Q-1', table_label: 'T\\nTOTAL P0.00'}}))`);
      const totalLines = dx.split('\n').filter(l => /^(\[[A-Z0-9 x\/]+\])*TOTAL\b/.test(l));
      eq('injected line breaks in data fields: only the one real TOTAL line', totalLines.length, 1);
      eq('customer nickname "A\\nTOTAL P0.00" prints on one line', /Customer +A TOTAL P0\.00\n/.test(dx), true);
      eq('header line breaks kept', /Open daily\nFree wifi\n/.test(dx), true);
      eq('footer U+2028 kept as a real line break', /Salamat\nBalik kayo\n/.test(dx), true);
    }
    eq('PHP style on the receipt', /TOTAL +PHP 359\.00/.test(e.r(`Printer.describe(Printer.receiptBytes(SALE, ITEMS, PAYS, {peso_style: 'PHP'}))`)), true);
    eq('no-sign style on the receipt', /TOTAL +359\.00\n/.test(e.r(`Printer.describe(Printer.receiptBytes(SALE, ITEMS, PAYS, {peso_style: 'none'}))`)), true);
    // byte level: begins with ESC @, ends with feed 4 + partial cut
    const bytes = Array.from(e.r(`Printer.receiptBytes(SALE, ITEMS, PAYS, {})`));
    eq('starts with ESC @', hex(bytes.slice(0, 2)), '1b 40');
    eq('ends with ESC d 4 + GS V 1', hex(bytes.slice(-6)), '1b 64 04 1d 56 01');
    // drawer rules
    const has = (o) => indexOfSeq(Array.from(e.r(`Printer.receiptBytes(SALE, ITEMS, ${o})`)), [0x1b, 0x70, 0x00, 0x19, 0xfa]);
    eq('drawer: setting off -> no kick on a cash sale', has(`PAYS, {}`), -1);
    e.r(`Printer.saveSettings({open_drawer_on_cash: true})`);
    await new Promise(r => setTimeout(r, 5));
    eq('drawer: setting on + cash -> kick right after ESC @', has(`PAYS, {}`), 2);
    eq('drawer: setting on + GCash -> no kick', has(`[{method:'GCASH', amount:359, reference:'123'}], {}`), -1);
    eq('drawer: reprint -> no kick', has(`PAYS, {reprint: true}`), -1);
    eq('drawer: openDrawer:false overrides', has(`PAYS, {openDrawer: false}`), -1);
    // copies + cut
    const two = e.r(`Printer.receiptBytes(SALE, ITEMS, PAYS, {copies: 2})`);
    eq('2 copies -> 2 cuts, 1 drawer kick', [countSeq(two, [0x1d, 0x56, 0x01]), countSeq(two, [0x1b, 0x70, 0x00, 0x19, 0xfa])], [2, 1]);
    eq('cut off -> no GS V', countSeq(e.r(`Printer.receiptBytes(SALE, ITEMS, PAYS, {cut: false})`), [0x1d, 0x56]), 0);
    // status lines, payment reference, tax/service, voided sale
    const dv = e.r(`Printer.describe(Printer.receiptBytes(Object.assign({}, SALE, {status: 'VOIDED', tax_amount: 12, service_charge_amount: 5.5}), ITEMS, [{method:'GCASH', amount: 359, reference: 'GC-998'}], {reprint: true}))`);
    eq('voided -> *** VOIDED ***, tax + service lines, Ref#, reprint mark',
      [/\*\*\* VOIDED \*\*\*/.test(dv), /Tax +P12\.00/.test(dv), /Service charge +P5\.50/.test(dv), /Ref# +GC-998/.test(dv), /Payment \(GCash\)/.test(dv), /\(Reprint\)/.test(dv), /Cash received/.test(dv)],
      [true, true, true, true, true, true, false]);
    eq('test slip has the 32-char ruler and the peso check', (() => { const t = e.r(`Printer.describe(Printer.testBytes({paper_width: 58}))`); return /12345678901234567890123456789012\n/.test(t) && /P1,234\.50/.test(t) && /\[CUT\]$/.test(t); })(), true);
  }

  /* ---------- settings ---------- */
  {
    const {r} = makeEnv();
    eq('defaults', r(`(function(){ const s = Printer.settings(); return [s.connection, s.paper_width, s.peso_style, s.auto_print, s.open_drawer_on_cash, s.copies]; })()`), ['dialog', 58, 'P', false, false, 1]);
    eq('cleanSettings fixes bad values', r(`(function(){ const s = Printer.cleanSettings({connection:'wifi', paper_width:72, peso_style:'$', copies: 9, ble_chunk: 5}); return [s.connection, s.paper_width, s.peso_style, s.copies, s.ble_chunk]; })()`), ['dialog', 58, 'P', 3, 20]);
    await r(`Printer.saveSettings({paper_width: 80, auto_print: true})`);
    eq('saved in LocalDB (this counter only)', await r(`LocalDB.get('cccc.printer.settings').then(v => [v.paper_width, v.auto_print])`), [80, true]);
    eq('receiptHtml follows the counter paper setting (80)', /width:80mm/.test(r(`(state.settings = Object.assign({}, DEFAULT_SETTINGS), receiptHtml({transaction_number:'T', status:'COMPLETED'}, [], []))`)), true);
    await r(`Printer.saveSettings({paper_width: 58})`);
    const h = r(`receiptHtml({transaction_number:'T', status:'COMPLETED'}, [], [])`);
    eq('receiptHtml 58 mm print layout (@page size 58mm)', [/@page\{size:58mm auto/.test(h), /width:58mm/.test(h), /width:80mm/.test(h)], [true, true, false]);
    eq('receiptHtml opts.paperWidth wins', /width:80mm/.test(r(`receiptHtml({transaction_number:'T', status:'COMPLETED'}, [], [], {paperWidth: 80})`)), true);
  }

  /* ---------- unsupported browsers -> print dialog ---------- */
  {
    const e = makeEnv({nav: {userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/605', platform: 'iPad', maxTouchPoints: 5}}); e.r(SAMPLE);
    eq('iPad: no bluetooth, no serial', e.r(`(function(){ const s = Printer.support(); return [s.bluetooth, s.serial, s.apple_mobile]; })()`), [false, false, true]);
    eq('iPad: plain message', /iPad and iPhone/.test(e.r(`Printer.supportText()`)), true);
    await e.r(`Printer.saveSettings({connection: 'bluetooth'})`);
    const res = await e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('iPad + bluetooth setting -> print dialog used', [res.method, e.printed.length, /Receipt TXN-0042/.test(e.printed[0] && e.printed[0].html)], ['dialog', 1, true]);
    let threw = null; try{ await e.r(`Printer.choose()`); }catch(x){ threw = x.friendly; }
    eq('iPad: choose() refuses in plain words', /iPad and iPhone/.test(threw || ''), true);
    const ff = makeEnv({nav: {userAgent: 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/131.0'}});
    eq('Firefox: plain message names Chrome / Edge', /Chrome or Edge/.test(ff.r(`Printer.supportText()`)), true);
    const ffr = await ff.r(`Printer.printTest({openDrawer: true})`);
    eq('Firefox: printTest explains, drawer not sent', [/Choose a Bluetooth printer/.test(ffr.error), ffr.drawer_requested, ffr.drawer_kick_sent], [true, true, false]);
  }

  /* ---------- fake Bluetooth printer ---------- */
  {
    const f = fakeBle();
    const e = makeEnv({nav: {userAgent: 'Chrome Android', bluetooth: f.bluetooth}}); e.r(SAMPLE);
    await e.r(`Printer.saveSettings({ble_delay_ms: 0})`);
    const events = []; e.ctx.__ev = events; e.r(`Printer.on('status', s => __ev.push(s.connected))`);
    const st = await e.r(`Printer.choose()`);
    const req = f.log.requests[0];
    eq('chooser filters: services + name prefixes', [req.filters.some(x => x.services && x.services[0] === 0x18F0), req.filters.some(x => x.namePrefix === 'Printer'), req.filters.some(x => x.namePrefix === 'MTP'), req.filters.some(x => x.namePrefix === 'PT-')], [true, true, true, true]);
    eq('optionalServices include the known printer services', ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', 0xFF00, 0xFFE0, 0xFFF0].every(u => req.optionalServices.includes(u)), true);
    eq('connected + remembered', [st.connected, st.name, e.r(`Printer.settings().connection`), e.r(`Printer.settings().device_id`)], [true, 'Printer001', 'bluetooth', 'dev-1']);
    eq('status events fired', events.includes(true), true);
    const expected = Array.from(e.r(`Printer.receiptBytes(SALE, ITEMS, PAYS, {})`));
    const res = await e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('printed by bluetooth, no dialog', [res.ok, res.method, e.printed.length], [true, 'bluetooth', 0]);
    eq('all bytes arrived in order', hex(f.all()) === hex(expected), true);
    eq('chunks are at most 180 bytes, and more than one', [f.log.writes.every(w => w.length <= 180), f.log.writes.length > 1], [true, true]);
    eq('writes use the write characteristic (not the notify one)', f.log.writes.length > 0, true);
    const before = f.log.writes.length;
    const tr = await e.r(`Printer.printTest()`);
    e.ctx.__slip = f.log.writes.slice(before).flat();
    eq('test slip prints by bluetooth', [tr.ok, /Printer test/.test(e.r(`Printer.describe(__slip)`)), /\[CUT\]$/.test(e.r(`Printer.describe(__slip)`))], [true, true, true]);
    eq('test slip result: no drawer asked', [tr.drawer_requested, tr.drawer_kick_sent, tr.printer_name, tr.partial, typeof tr.at], [false, false, 'Printer001', false, 'string']);
    const before2 = f.log.writes.length;
    const trd = await e.r(`Printer.printTest({openDrawer: true})`);
    e.ctx.__slip2 = f.log.writes.slice(before2).flat();
    eq('test slip with drawer: drawer_kick_sent true + ESC p right after ESC @ (for the audit entry)',
      [trd.ok, trd.drawer_requested, trd.drawer_kick_sent, e.ctx.__slip2.slice(0, 7).map(x => x.toString(16)).join(' ')], [true, true, true, '1b 40 1b 70 0 19 fa']);

    const f2 = fakeBle({mtu: 20});
    const e2 = makeEnv({nav: {userAgent: 'Chrome', bluetooth: f2.bluetooth}}); e2.r(SAMPLE);
    await e2.r(`Printer.saveSettings({ble_delay_ms: 0})`);
    await e2.r(`Printer.choose()`);
    const exp2 = Array.from(e2.r(`Printer.receiptBytes(SALE, ITEMS, PAYS, {})`));
    const res2 = await e2.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('small-MTU printer: falls back to 20-byte writes, complete output', [res2.ok, f2.log.writes.every(w => w.length <= 20), hex(f2.all()) === hex(exp2)], [true, true, true]);
    eq('small-MTU printer: 20 bytes remembered', e2.r(`Printer.settings().ble_chunk`), 20);

    const f3 = fakeBle({dropAfter: 3});
    const e3 = makeEnv({nav: {userAgent: 'Chrome', bluetooth: f3.bluetooth}}); e3.r(SAMPLE);
    await e3.r(`Printer.saveSettings({ble_delay_ms: 0, ble_chunk: 40})`);
    await e3.r(`Printer.choose()`);
    const exp3 = Array.from(e3.r(`Printer.receiptBytes(SALE, ITEMS, PAYS, {})`));
    const res3 = await e3.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('dropped mid-print: one reconnect, carries on, nothing lost or doubled', [res3.ok, f3.log.connects, hex(f3.all()) === hex(exp3)], [true, 2, true]);

    const f4 = fakeBle({dropAfter: 2, refuseConnect: true, refuseAfter: 1});
    const e4 = makeEnv({nav: {userAgent: 'Chrome', bluetooth: f4.bluetooth, }}); e4.r(SAMPLE);
    await e4.r(`Printer.saveSettings({ble_delay_ms: 0, ble_chunk: 40})`);
    await e4.r(`Printer.choose()`);
    const res4 = await e4.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('stopped part-way (2 writes, then gone): partial, plain words, NO print screen (no second copy)',
      [res4.ok, res4.partial, res4.method, e4.printed.length, /^Printing stopped part-way\. Couldn't reach the printer "Printer001"/.test(res4.error), /part-way/.test(e4.r(`Printer.status().last_error`)), res4.drawer_kick_sent],
      [false, true, 'bluetooth', 0, true, true, false]);
    // printer gone before anything was sent
    const res4b = await e4.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('failed before any byte -> print screen fallback', [res4b.ok, res4b.partial, res4b.method, e4.printed.length, /^Couldn't reach the printer "Printer001"/.test(res4b.error)], [false, false, 'dialog', 1, true]);
    const res4c = await e4.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {fallback: false})`);
    eq('fallback:false -> no print screen', [res4c.ok, res4c.partial, e4.printed.length], [false, false, 1]);
    const res4d = await e4.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {auto: true})`);
    eq('auto-print after a sale never opens the print screen on failure', [res4d.ok, res4d.method, e4.printed.length, !!res4d.error], [false, 'bluetooth', 1, true]);
    // drawer reached the printer, then it stopped part-way
    const f4e = fakeBle({dropAfter: 1, refuseConnect: true, refuseAfter: 1});
    const e4e = makeEnv({nav: {userAgent: 'Chrome', bluetooth: f4e.bluetooth}}); e4e.r(SAMPLE);
    await e4e.r(`Printer.saveSettings({ble_delay_ms: 0, ble_chunk: 40, open_drawer_on_cash: true})`);
    await e4e.r(`Printer.choose()`);
    const r4e = await e4e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('partial cash receipt: drawer_kick_sent true (first 40 bytes had ESC p)', [r4e.partial, r4e.drawer_kick_sent, e4e.printed.length], [true, true, 0]);

    // silent reconnect (page reload): a new page with the same saved settings
    const f5 = fakeBle();
    const e5 = makeEnv({nav: {userAgent: 'Chrome', bluetooth: f5.bluetooth}}); e5.r(SAMPLE);
    await e5.r(`LocalDB.set('cccc.printer.settings', {connection: 'bluetooth', device_id: 'dev-1', device_name: 'Printer001', ble_delay_ms: 0})`);
    await e5.r(`Printer.init()`);
    await new Promise(r => setTimeout(r, 20));
    eq('init(): reconnects to the remembered printer without a chooser', [e5.r(`Printer.status().connected`), f5.log.requests.length], [true, 0]);
    const res5 = await e5.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('…and prints', [res5.ok, res5.method], [true, 'bluetooth']);
    await e5.r(`Printer.forget()`);
    eq('forget(): back to the print dialog, device cleared', [e5.r(`Printer.settings().connection`), e5.r(`Printer.settings().device_id`), e5.r(`Printer.status().connected`)], ['dialog', '', false]);

    const f6 = fakeBle({cancel: true});
    const e6 = makeEnv({nav: {userAgent: 'Chrome', bluetooth: f6.bluetooth}});
    let m6 = null; try{ await e6.r(`Printer.choose()`); }catch(x){ m6 = x.friendly; }
    eq('chooser cancelled -> "No printer was chosen."', m6, 'No printer was chosen.');
    const f7 = fakeBle();
    const e7 = makeEnv({nav: {userAgent: 'Chrome', bluetooth: f7.bluetooth}});
    await e7.r(`Printer.choose({showAll: true})`);
    eq('showAll -> acceptAllDevices + optionalServices', [f7.log.requests[0].acceptAllDevices, Array.isArray(f7.log.requests[0].optionalServices)], [true, true]);
    // two receipts at once never mix
    const f8 = fakeBle();
    const e8 = makeEnv({nav: {userAgent: 'Chrome', bluetooth: f8.bluetooth}}); e8.r(SAMPLE);
    await e8.r(`Printer.saveSettings({ble_delay_ms: 1, ble_chunk: 30})`);
    await e8.r(`Printer.choose()`);
    const a = Array.from(e8.r(`Printer.receiptBytes(SALE, ITEMS, PAYS, {})`)), b = Array.from(e8.r(`Printer.receiptBytes(Object.assign({}, SALE, {transaction_number: 'TXN-0043'}), ITEMS, PAYS, {})`));
    await Promise.all([e8.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`), e8.r(`Printer.printReceipt(Object.assign({}, SALE, {transaction_number: 'TXN-0043'}), ITEMS, PAYS, {})`)]);
    eq('two receipts at once print one after the other', hex(f8.all()) === hex(a.concat(b)), true);
  }

  /* ---------- fake Web Serial ---------- */
  {
    const written = []; let reqOpts = null, opened = null;
    const port = {writable: null, getInfo(){ return {bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb'}; },
      async open(o){ opened = o; this.writable = {getWriter(){ return {async write(v){ written.push(...v); }, releaseLock(){}}; }}; },
      async close(){ this.writable = null; }};
    const serial = {async requestPort(o){ reqOpts = o; return port; }, async getPorts(){ return [port]; }, addEventListener(){}};
    const e = makeEnv({nav: {userAgent: 'Chrome Windows', serial}}); e.r(SAMPLE);
    const st = await e.r(`Printer.chooseSerial()`);
    eq('serial: asks for Bluetooth serial ports too, opens at 9600', [reqOpts.allowedBluetoothServiceClassIds[0], opened.baudRate, st.connected, e.r(`Printer.settings().connection`)], ['00001101-0000-1000-8000-00805f9b34fb', 9600, true, 'serial']);
    const exp = Array.from(e.r(`Printer.receiptBytes(SALE, ITEMS, PAYS, {})`));
    const res = await e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {})`);
    eq('serial: printed, all bytes', [res.ok, res.method, hex(written) === hex(exp)], [true, 'serial', true]);
    let n = 0; const realOpen = port.open;
    port.writable = {getWriter(){ return {async write(v){ if(++n === 2) throw Object.assign(new Error('The device has been lost.'), {name: 'NetworkError'}); written.push(...v); }, releaseLock(){}}; }};
    const before = e.printed.length;
    const rs = await e.r(`Printer.printReceipt(SALE, ITEMS, PAYS, {copies: 2})`);
    eq('serial: lost after the first 512 bytes -> partial, no print screen', [rs.ok, rs.partial, rs.method, e.printed.length - before], [false, true, 'serial', 0]);
    port.open = realOpen;
    const old = makeEnv({nav: {userAgent: 'Chrome', serial: {async requestPort(o){ if(o) throw new TypeError('bad option'); return port; }, async getPorts(){ return []; }}}});
    port.writable = null;
    eq('serial: older browser without the Bluetooth option still works', (await old.r(`Printer.chooseSerial()`)).connected, true);
  }

  console.log(`\nSUMMARY unit/printer_check: ${checks} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); console.log(`SUMMARY unit/printer_check: ${checks} checks, ${failed + 1} failed`); process.exit(1); });
