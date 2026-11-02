/* =====================================================================
   PRINTER — receipt printing straight to a thermal receipt printer
   (release 1.3, P1). Used by the counter (Front Office).

   Connection types (chosen per counter, saved on this device only):
     'bluetooth' : Web Bluetooth (BLE printers). Chrome / Edge on Android, Windows, Mac.
     'serial'    : Web Serial (Chrome / Edge on a computer): a printer paired as a
                   Bluetooth (classic / SPP) or USB serial port, e.g. a COM port on Windows.
     'dialog'    : the browser's print screen (receiptHtml + openPrintWindow). Works
                   everywhere, incl. iPad / iPhone. Also the fallback when direct printing fails.
   Printers: any ESC/POS receipt printer (Xprinter, Epson TM, Star in ESC/POS mode,
   Rongta, GOOJPRT, MUNBYN, HOIN, generic "Printer001" / "BlueTooth Printer" / "MTP-…" / "PT-210").

   Text is sent as plain ASCII only (cheap printers have no ₱ and different code pages):
   ₱ becomes "P" (or "PHP ", setting peso_style), accents are dropped (ñ -> n), other
   characters become "?". Control bytes from shop / customer text are removed, so a name
   can never send a printer command.

   Money: every amount printed is the sale's saved figure (subtotal, discount_amount,
   loyalty_discount, tax_amount, service_charge_amount, grand_total, payments) — the
   same numbers receiptHtml shows. Nothing is recalculated here.

   Needs (loaded before this file): local.js (LocalDB), logic.js (state, receiptHtml,
   openPrintWindow, PAYMENT_METHODS, businessName). The ESC/POS builder itself needs nothing.
   ===================================================================== */
const Printer = (() => {
  const SETTINGS_KEY = 'cccc.printer.settings';   // LocalDB (this counter only, never the server)
  const DEFAULTS = {
    connection: 'dialog',        // 'dialog' | 'bluetooth' | 'serial'
    paper_width: 58,             // 58 | 80 (mm)
    peso_style: 'P',             // 'P' -> P150.00 | 'PHP' -> PHP 150.00 | 'none' -> 150.00
    auto_print: false,           // print the receipt right after a sale
    open_drawer_on_cash: false,  // kick the cash drawer (ESC p) on a cash sale
    copies: 1,                   // 1..3
    cut: true,                   // cut the paper after each copy (printers without a cutter ignore it)
    device_id: '',               // remembered Bluetooth printer (id from the browser)
    device_name: '',
    serial_baud: 9600,           // Bluetooth SPP ignores it; USB serial printers often use 9600 or 115200
    ble_chunk: 180,              // bytes per Bluetooth write (drops to 20 by itself if the printer needs it)
    ble_delay_ms: 20,            // pause between Bluetooth writes (cheap printers have small buffers)
  };
  const CHARS = {58: 32, 80: 48};   // characters per line, font A

  // Known receipt-printer Bluetooth services (16-bit numbers or full ids) and their
  // usual "write" characteristics (preferred when present).
  const BLE_SERVICES = [
    0x18F0, 0xFF00, 0xFFE0, 0xFFF0, 0xFEE7, 0xAE30, 0xAF30, 0xFF12, 0xFFB0,
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',   // many Chinese printers (Xprinter, GOOJPRT, "Printer001")
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',   // Microchip / ISSC transparent UART (MUNBYN, Rongta, HOIN …)
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '000018f0-0000-1000-8000-00805f9b34fb',
  ];
  const BLE_FILTER_SERVICES = [0x18F0, 0xFF00, 0xFFE0, 0xFFF0, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455'];
  const BLE_NAME_PREFIXES = ['Printer', 'BlueTooth Printer', 'Bluetooth Printer', 'BT Printer', 'MTP', 'PT-', 'XP-', 'Xprinter', 'XPrinter',
    'TM-', 'EPSON', 'Star', 'mPOP', 'SM-', 'TSP', 'RPP', 'Rongta', 'RP-', 'GOOJPRT', 'MUNBYN', 'HOIN', 'HOP-', 'POS', 'P58', 'P80',
    'MPT', 'QS', 'InnerPrinter', 'Thermal'];
  const BLE_WRITE_CHARS = ['00002af1-0000-1000-8000-00805f9b34fb', '0000ff02-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb',
    '0000fff2-0000-1000-8000-00805f9b34fb', '0000ae01-0000-1000-8000-00805f9b34fb',
    'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', '49535343-8841-43f4-a8d4-ecbe34729bb3'];
  const SPP_CLASS = '00001101-0000-1000-8000-00805f9b34fb';   // Bluetooth serial port profile

  function uuidOf(u){
    if(typeof u === 'number') return '0000' + u.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb';
    return String(u).toLowerCase();
  }

  /* ------------------------------------------------------------------
     Text: ASCII only
     ------------------------------------------------------------------ */
  const CHAR_MAP = {
    '₱': 'P', '‘': "'", '’': "'", '‚': "'", '′': "'", '“': '"', '”': '"', '„': '"', '″': '"',
    '–': '-', '—': '-', '−': '-', '‐': '-', '‑': '-', '…': '...', '×': 'x', '•': '*', '·': '.',
    ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '‌': '', '‍': '', '﻿': '',
    '→': '->', '←': '<-', '©': '(c)', '®': '(R)', '™': 'TM', '½': '1/2', '¼': '1/4', '¾': '3/4',
    '°': ' deg', '€': 'EUR', '£': 'GBP', '¥': 'JPY', 'ß': 'ss', 'Æ': 'AE', 'æ': 'ae', 'Ø': 'O', 'ø': 'o',
    'Œ': 'OE', 'œ': 'oe', '✓': 'v', '✔': 'v', '✕': 'x', '✖': 'x', '«': '<<', '»': '>>',
  };
  // Any text -> printable ASCII (0x20..0x7E). pesoText: what ₱ becomes.
  // Line breaks (\r, \n, U+2028, U+2029, \v, \f, U+0085) become a space, so a data field
  // (item note, nickname, modifier label, reference, table, cashier) can never print extra
  // receipt lines (e.g. a fake TOTAL). keepBreaks = true keeps real \n line breaks; only the
  // shop's own settings text (receipt_header / receipt_footer) uses it, via b.lines().
  function toAscii(s, pesoText, keepBreaks){
    s = String(s == null ? '' : s).replace(/\r\n|[\r\n\u2028\u2029\u000B\u000C\u0085]/g, '\n').replace(/\t/g, ' ');
    if(!keepBreaks) s = s.replace(/\n/g, ' ');
    let out = '';
    for(const ch of s){
      if(ch === '₱'){ out += (pesoText == null ? 'P' : pesoText); continue; }
      if(ch === '\n'){ out += '\n'; continue; }
      const c = ch.codePointAt(0);
      if(c >= 0x20 && c <= 0x7E){ out += ch; continue; }
      if(c < 0x20 || (c >= 0x7F && c <= 0x9F)) continue;            // control bytes (ESC, GS …): dropped
      if(Object.prototype.hasOwnProperty.call(CHAR_MAP, ch)){ out += CHAR_MAP[ch]; continue; }
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if(base && /^[\x20-\x7E]+$/.test(base)){ out += base; continue; }
      if(/\p{Extended_Pictographic}|[️⃣]/u.test(ch)) continue;  // emoji: dropped
      out += '?';
    }
    return out;
  }
  function pesoPrefix(style){
    const st = String(style || 'P').toUpperCase();
    return st === 'PHP' ? 'PHP ' : st === 'NONE' ? '' : 'P';
  }
  // 1234.5 -> "P1,234.50" (style 'P'), "PHP 1,234.50", "1,234.50"; negative: "-P10.00".
  function money(n, style){
    let v = Number(n); if(!isFinite(v)) v = 0;
    const neg = v < 0 && Math.abs(v) >= 0.005;
    const fixed = Math.abs(v).toFixed(2);
    const [i, d] = fixed.split('.');
    return (neg ? '-' : '') + pesoPrefix(style) + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + d;
  }
  // Word wrap to width columns (long words are cut). Returns lines (at least one).
  function wrap(text, width){
    width = Math.max(1, width | 0);
    const out = [];
    String(text == null ? '' : text).split('\n').forEach(para0 => {
      // leading spaces (e.g. "  - Oat milk") indent every line of the paragraph
      const lead = Math.min(para0.length - para0.replace(/^ +/, '').length, Math.floor(width / 2));
      const pad = ' '.repeat(lead);
      if(lead){ wrap(para0.trim(), width - lead).forEach(l => out.push(l ? pad + l : '')); return; }
      const para = para0;
      const words = para.split(' ').filter(w => w !== '');
      let line = '';
      words.forEach(w => {
        while(w.length > width){
          if(line){ out.push(line); line = ''; }
          out.push(w.slice(0, width)); w = w.slice(width);
        }
        if(!w) return;
        if(!line) line = w;
        else if(line.length + 1 + w.length <= width) line += ' ' + w;
        else { out.push(line); line = w; }
      });
      out.push(line);
    });
    return out.length ? out : [''];
  }
  // Left text + right text on one width-wide line; a long left side wraps (the right side
  // stays on the first line, continuation lines are indented by `indent`).
  function leftRight(left, right, width, indent){
    left = String(left == null ? '' : left); right = String(right == null ? '' : right);
    indent = indent || 0;
    if(right.length >= width) return wrap(left, width).concat([' '.repeat(Math.max(0, width - right.length)) + right.slice(0, width)]);
    const room = width - right.length - 1;
    if(left.length <= room) return [left + ' '.repeat(width - left.length - right.length) + right];
    const all = wrap(left, room);
    const head = all[0];
    const rest = wrap(all.slice(1).join(' '), Math.max(1, width - indent)).filter(l => l !== '').map(l => ' '.repeat(indent) + l);
    return [head + ' '.repeat(width - head.length - right.length) + right].concat(rest);
  }

  /* ------------------------------------------------------------------
     ESC/POS builder (pure: no browser needed; unit-tested in node)
     ------------------------------------------------------------------ */
  const ESC = 0x1B, GS = 0x1D;
  function EscPos(opts){
    opts = opts || {};
    const paper = Number(opts.paper_width) === 80 ? 80 : 58;
    const b = {
      bytes: [], paper, width: Number(opts.width) || CHARS[paper], peso: pesoPrefix(opts.peso_style),
      _wide: false,
      raw(arr){ for(const x of arr) this.bytes.push(x & 0xFF); return this; },
      init(){ return this.raw([ESC, 0x40]); },                                   // ESC @
      align(a){ return this.raw([ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0]); },   // ESC a n
      bold(on){ return this.raw([ESC, 0x45, on ? 1 : 0]); },                    // ESC E n
      // size(w, h): 1 or 2 times wide / tall (GS ! n)
      size(w, h){ w = w === 2 ? 2 : 1; h = h === 2 ? 2 : 1; this._wide = w === 2; return this.raw([GS, 0x21, ((w - 1) << 4) | (h - 1)]); },
      cols(){ return this._wide ? Math.floor(this.width / 2) : this.width; },
      // Text as ASCII (₱ -> the peso prefix). No line end.
      text(s){ const t = toAscii(s, this.peso); for(let i = 0; i < t.length; i++) this.bytes.push(t.charCodeAt(i)); return this; },
      // One data field as printed line(s): line breaks in s become spaces; long text wraps.
      line(s){ wrap(toAscii(s, this.peso), this.cols()).forEach(l => { this.text(l); this.bytes.push(0x0A); }); return this; },
      // Shop settings text (receipt_header / receipt_footer): keeps the owner's own line breaks.
      lines(s){ wrap(toAscii(s, this.peso, true), this.cols()).forEach(l => { this.text(l); this.bytes.push(0x0A); }); return this; },
      lr(left, right, indent){ leftRight(toAscii(left, this.peso), toAscii(right, this.peso), this.cols(), indent).forEach(l => { this.text(l); this.bytes.push(0x0A); }); return this; },
      sep(ch){ return this.text((ch || '-').repeat(this.cols())).raw([0x0A]); },
      feed(n){ return this.raw([ESC, 0x64, Math.max(0, Math.min(255, n == null ? 1 : n))]); },  // ESC d n
      cut(){ return this.raw([GS, 0x56, 0x01]); },                              // GS V 1: partial cut
      drawer(){ return this.raw([ESC, 0x70, 0x00, 0x19, 0xFA]); },              // ESC p 0 25 250: kick drawer pin 2
      // QR code (GS ( k, model 2). Printers without QR support skip it.
      qr(data, dot){
        const d = toAscii(data, ''); const len = d.length + 3;
        this.raw([GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
        this.raw([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, Math.max(1, Math.min(16, dot || 6))]);
        this.raw([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x30]);
        this.raw([GS, 0x28, 0x6B, len & 0xFF, (len >> 8) & 0xFF, 0x31, 0x50, 0x30]); this.text(d);
        return this.raw([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]);
      },
      money(n){ return money(n, opts.peso_style); },
      toUint8(){ return Uint8Array.from(this.bytes); },
    };
    return b;
  }
  // Readable view of ESC/POS bytes, for tests and support: commands as [TAGS], text as is.
  function describe(bytes){
    const a = Array.from(bytes || []); let out = '', i = 0;
    while(i < a.length){
      const x = a[i];
      if(x === ESC && a[i+1] === 0x40){ out += '[INIT]'; i += 2; }
      else if(x === ESC && a[i+1] === 0x61){ out += '[ALIGN ' + (['L','C','R'][a[i+2]] || a[i+2]) + ']'; i += 3; }
      else if(x === ESC && a[i+1] === 0x45){ out += a[i+2] ? '[B]' : '[/B]'; i += 3; }
      else if(x === GS && a[i+1] === 0x21){ out += '[SIZE ' + ((a[i+2] >> 4) + 1) + 'x' + ((a[i+2] & 15) + 1) + ']'; i += 3; }
      else if(x === ESC && a[i+1] === 0x64){ out += '[FEED ' + a[i+2] + ']'; i += 3; }
      else if(x === GS && a[i+1] === 0x56){ out += '[CUT]'; i += (a[i+2] === 0x41 || a[i+2] === 0x42) ? 4 : 3; }
      else if(x === ESC && a[i+1] === 0x70){ out += '[DRAWER]'; i += 5; }
      else if(x === GS && a[i+1] === 0x28 && a[i+2] === 0x6B){ const n = a[i+3] | (a[i+4] << 8); if(a[i+6] === 0x50) out += '[QR ' + String.fromCharCode(...a.slice(i+8, i+5+n)) + ']'; i += 5 + n; }
      else if(x === 0x0A){ out += '\n'; i++; }
      else if(x >= 0x20 && x <= 0x7E){ out += String.fromCharCode(x); i++; }
      else { out += '[0x' + x.toString(16).padStart(2, '0') + ']'; i++; }
    }
    return out;
  }

  /* ------------------------------------------------------------------
     Receipt content (same lines as receiptHtml in logic.js)
     ------------------------------------------------------------------ */
  function _shop(){ return (typeof state !== 'undefined' && state && state.settings) || {}; }
  function _shopName(){
    try{ if(typeof businessName === 'function'){ const n = businessName() || (typeof appDisplayName === 'function' ? appDisplayName() : ''); if(n) return n; } }catch(e){}
    return _shop().business_name || '';
  }
  function _tz(){ return _shop().timezone || 'Asia/Manila'; }
  function _dateText(d){
    const dt = new Date(d); if(!d || isNaN(dt)) return '';
    try{ return new Intl.DateTimeFormat('en-PH', {timeZone: _tz(), year: 'numeric', month: 'short', day: 'numeric'}).format(dt); }
    catch(e){ return dt.toISOString().slice(0, 10); }
  }
  function _timeText(d){
    const dt = new Date(d); if(!d || isNaN(dt)) return '';
    try{ return new Intl.DateTimeFormat('en-PH', {timeZone: _tz(), hour: 'numeric', minute: '2-digit'}).format(dt); }
    catch(e){ return dt.toISOString().slice(11, 16); }
  }
  function _methodLabel(m){
    const list = (typeof PAYMENT_METHODS !== 'undefined' && PAYMENT_METHODS) || [];
    return (list.find(x => x.id === m) || {}).label || m || '-';
  }
  // The receipt body (one copy) into builder b. Mirrors receiptHtml line by line.
  function _receiptBody(b, sale, items, payments, opts){
    const s = _shop();
    b.align('center').bold(true).size(2, 2).line(_shopName() || 'Receipt').size(1, 1).bold(false);
    if(s.business_address) b.line(s.business_address);
    if(s.business_contact) b.line(s.business_contact);
    if(s.business_tin) b.line('TIN: ' + s.business_tin);
    if(s.receipt_header) b.lines(s.receipt_header);
    b.align('left').sep();
    b.lr(sale.transaction_number || '', _dateText(sale.transaction_date));
    b.lr('Cashier: ' + (sale.cashier_name || ''), _timeText(sale.transaction_date));
    if(opts.qrOrder) b.lr('QR ' + (opts.qrOrder.order_number || ''), opts.qrOrder.table_label || '');
    if(opts.customerName) b.lr('Customer', opts.customerName);
    b.sep();
    (items || []).forEach(it => {
      b.lr(Number(it.quantity) + ' x ' + (it.name || ''), b.money(it.line_total), 2);
      (it.modifiers || []).forEach(m => b.line('  - ' + (m.label || '') + (Number(m.price_delta) ? ' (+' + b.money(m.price_delta) + ')' : '')));
      if(it.notes) b.line('  "' + it.notes + '"');
    });
    b.sep();
    b.lr('Subtotal', b.money(sale.subtotal));
    if(Number(sale.discount_amount) > 0) b.lr('Discount', '-' + b.money(sale.discount_amount));
    if(Number(sale.loyalty_discount) > 0) b.lr(opts.rewardLabel ? 'Stamp reward: ' + opts.rewardLabel : 'Stamp reward', '-' + b.money(sale.loyalty_discount));
    if(Number(sale.tax_amount) > 0) b.lr('Tax', b.money(sale.tax_amount));
    if(Number(sale.service_charge_amount) > 0) b.lr('Service charge', b.money(sale.service_charge_amount));
    b.bold(true).size(1, 2).lr('TOTAL', b.money(sale.grand_total)).size(1, 1).bold(false);
    b.sep();
    const pays = (payments && payments.length) ? payments : [{}];
    pays.forEach(pay => {
      b.lr('Payment (' + _methodLabel(pay.method) + ')', b.money(pay.amount || sale.grand_total));
      if(pay.method === 'CASH'){ b.lr('Cash received', b.money(pay.tendered)); b.lr('Change', b.money(pay.change)); }
      if(pay.reference) b.lr('Ref#', pay.reference);
    });
    b.sep();
    b.align('center').lines(s.receipt_footer || 'Thank you!');
    if(sale.status && sale.status !== 'COMPLETED') b.bold(true).line('*** ' + String(sale.status).replace(/_/g, ' ') + ' ***').bold(false);
    if(opts.qrText){ b.feed(1).qr(opts.qrText, 5); b.raw([0x0A]); }
    if(opts.reprint) b.line('(Reprint)');
    b.align('left');
  }
  function _hasCash(payments){ return (payments || []).some(p => p && p.method === 'CASH'); }
  // All bytes for a receipt job: init, drawer kick (first copy only), copies x (body + feed + cut).
  //   opts: {qrOrder, customerName, rewardLabel} as for receiptHtml, plus
  //         openDrawer (true/false; default: setting open_drawer_on_cash and a CASH payment, never on a reprint),
  //         copies (default setting), reprint, qrText, and any setting to override (paper_width, peso_style, cut).
  function receiptBytes(sale, items, payments, opts){
    opts = opts || {};
    const st = Object.assign({}, current, _pick(opts));
    const b = EscPos(st);
    b.init();
    const drawer = opts.openDrawer === true || (opts.openDrawer === undefined && !opts.reprint && st.open_drawer_on_cash && _hasCash(payments));
    if(drawer) b.drawer();
    const copies = Math.max(1, Math.min(3, Number(opts.copies || st.copies) || 1));
    for(let c = 0; c < copies; c++){
      _receiptBody(b, sale || {}, items, payments, opts);
      b.feed(4);
      if(st.cut !== false) b.cut();
    }
    return b.toUint8();
  }
  function testBytes(opts){
    opts = opts || {};
    const st = Object.assign({}, current, _pick(opts));
    const b = EscPos(st);
    const w = b.width;
    b.init();
    if(opts.openDrawer) b.drawer();
    b.align('center').bold(true).size(2, 2).line(_shopName() || 'Printer test').size(1, 1).bold(false);
    b.line('Printer test').line(st.paper_width + ' mm paper, ' + w + ' per line');
    b.align('left').sep();
    b.line('1234567890'.repeat(Math.ceil(w / 10)).slice(0, w));
    b.lr('Left', 'Right');
    b.lr('Peso sign', b.money(1234.5));
    b.bold(true).line('Bold text').bold(false);
    b.size(1, 2).lr('TOTAL', b.money(150)).size(1, 1);
    b.align('center').line('Centre').align('right').line('Right').align('left');
    const now = new Date();
    b.sep().line(_dateText(now) + ' ' + _timeText(now));
    if(state_device_name()) b.line('Printer: ' + state_device_name());
    b.align('center').line('If you can read this, the printer works.').align('left');
    b.feed(4);
    if(st.cut !== false) b.cut();
    return b.toUint8();
  }
  function state_device_name(){ return conn.name || current.device_name || ''; }
  const SETTING_KEYS = Object.keys(DEFAULTS);
  function _pick(o){ const out = {}; SETTING_KEYS.forEach(k => { if(o && o[k] !== undefined) out[k] = o[k]; }); return out; }
  // Cut bytes into pieces of at most size (>= 1).
  function chunk(bytes, size){
    size = Math.max(1, size | 0);
    const out = [];
    for(let i = 0; i < bytes.length; i += size) out.push(bytes.subarray ? bytes.subarray(i, i + size) : bytes.slice(i, i + size));
    return out;
  }

  /* ------------------------------------------------------------------
     Settings (this counter only, LocalDB)
     ------------------------------------------------------------------ */
  let current = Object.assign({}, DEFAULTS);
  function cleanSettings(o){
    const s = Object.assign({}, DEFAULTS, _pick(o || {}));
    if(!['dialog', 'bluetooth', 'serial'].includes(s.connection)) s.connection = 'dialog';
    s.paper_width = Number(s.paper_width) === 80 ? 80 : 58;
    s.peso_style = ['P', 'PHP', 'none'].includes(s.peso_style) ? s.peso_style : 'P';
    s.auto_print = !!s.auto_print; s.open_drawer_on_cash = !!s.open_drawer_on_cash; s.cut = s.cut !== false;
    s.copies = Math.max(1, Math.min(3, Math.round(Number(s.copies)) || 1));
    s.serial_baud = [9600, 19200, 38400, 57600, 115200].includes(Number(s.serial_baud)) ? Number(s.serial_baud) : 9600;
    s.ble_chunk = Math.max(20, Math.min(512, Math.round(Number(s.ble_chunk)) || 180));
    s.ble_delay_ms = Math.max(0, Math.min(200, Math.round(Number(s.ble_delay_ms)) || 0));
    s.device_id = String(s.device_id || ''); s.device_name = String(s.device_name || '');
    return s;
  }
  async function loadSettings(){
    try{ if(typeof LocalDB !== 'undefined'){ const v = await LocalDB.get(SETTINGS_KEY); if(v) current = cleanSettings(v); } }catch(e){}
    return settings();
  }
  function settings(){ return Object.assign({}, current); }
  async function saveSettings(patch){
    current = cleanSettings(Object.assign({}, current, patch || {}));
    try{ if(typeof LocalDB !== 'undefined') await LocalDB.set(SETTINGS_KEY, Object.assign({}, current)); }catch(e){}
    emit('status');
    return settings();
  }

  /* ------------------------------------------------------------------
     Status + events
     ------------------------------------------------------------------ */
  const conn = {type: null, connected: false, connecting: false, name: '', device: null, characteristic: null, withoutResponse: false, port: null, writer: null};
  let lastError = '', lastPrintedAt = null, busy = false;
  const listeners = {status: [], error: [], printed: []};
  function on(type, fn){ (listeners[type] = listeners[type] || []).push(fn); return () => off(type, fn); }
  function off(type, fn){ listeners[type] = (listeners[type] || []).filter(f => f !== fn); }
  function emit(type, detail){
    const st = status();
    (listeners[type] || []).forEach(fn => { try{ fn(detail === undefined ? st : detail, st); }catch(e){} });
    if(type !== 'status') (listeners.status || []).forEach(fn => { try{ fn(st, st); }catch(e){} });
  }
  function setError(msg){ lastError = msg || ''; if(msg) emit('error', msg); else emit('status'); }

  function _nav(){ return (typeof navigator !== 'undefined' && navigator) || {}; }
  function isAppleMobile(){
    const n = _nav(); const ua = String(n.userAgent || '');
    return /iPad|iPhone|iPod/.test(ua) || (n.platform === 'MacIntel' && Number(n.maxTouchPoints) > 1);
  }
  function support(){
    const n = _nav();
    const secure = typeof window === 'undefined' || window.isSecureContext !== false;
    return {
      bluetooth: !!(n.bluetooth && typeof n.bluetooth.requestDevice === 'function') && secure,
      bluetooth_remember: !!(n.bluetooth && typeof n.bluetooth.getDevices === 'function'),
      serial: !!(n.serial && typeof n.serial.requestPort === 'function') && secure,
      dialog: true, apple_mobile: isAppleMobile(), secure,
    };
  }
  // Plain words about what this browser can do (for the counter's printer settings).
  function supportText(){
    const s = support();
    if(s.apple_mobile) return 'iPad and iPhone don\'t let any browser connect to Bluetooth or USB printers. Receipts open the print screen instead (works with AirPrint printers).';
    if(!s.secure) return 'Direct printing needs the secure (https) address of the app. Receipts open the print screen instead.';
    if(s.bluetooth && s.serial) return 'This browser can print by Bluetooth or through a printer port (Bluetooth or USB).';
    if(s.bluetooth) return 'This browser can print to Bluetooth (BLE) receipt printers.';
    if(s.serial) return 'This browser can print through a printer port (Bluetooth or USB), but not Bluetooth directly.';
    return 'This browser can\'t connect to receipt printers. Use Chrome or Edge on an Android tablet or a Windows / Mac computer. Receipts open the print screen instead.';
  }
  function status(){
    return {
      connection: current.connection, connected: !!conn.connected, connecting: !!conn.connecting,
      type: conn.type, name: conn.name || current.device_name || '', remembered: !!(current.device_id || current.device_name),
      paper_width: current.paper_width, chars: CHARS[current.paper_width], busy, last_error: lastError, last_printed_at: lastPrintedAt,
      support: support(), support_text: supportText(),
    };
  }

  function friendly(e, where){
    const name = e && e.name, msg = String((e && e.message) || e || '');
    if(name === 'NotFoundError' && /cancel|chosen|no device|User/i.test(msg)) return 'No printer was chosen.';
    if(name === 'NotFoundError' && where === 'serial') return 'No printer port was chosen.';
    if(name === 'NotFoundError') return 'No printer was chosen.';
    if(name === 'SecurityError') return 'The browser blocked the printer connection. Open the app from its https address and tap the button again.';
    if(name === 'NotAllowedError') return 'The browser didn\'t allow the printer connection. Tap Connect Bluetooth printer and allow it.';
    if(name === 'InvalidStateError' && where === 'serial') return 'The printer port is in use by another app or browser tab. Close it and try again.';
    if(name === 'NetworkError' || /disconnect|GATT|connection/i.test(msg) || (e && e.code === 'NOT_CONNECTED' && state_device_name())) return 'Couldn\'t reach the printer' + (state_device_name() ? ' "' + state_device_name() + '"' : '') + '. Check it is switched on, has paper and is close by, then tap Connect Bluetooth printer.';
    if(e && e.code === 'NO_WRITE') return 'This Bluetooth device doesn\'t accept print data. Choose your receipt printer (or tap "Show all Bluetooth devices").';
    if(e && e.code === 'BT_OFF') return 'Bluetooth is off on this device. Turn it on and try again.';
    if(e && e.code === 'NOT_SUPPORTED') return supportText();
    if(e && e.code === 'NOT_CONNECTED') return 'The printer isn\'t connected. Tap Connect Bluetooth printer.';
    return msg ? 'Printing failed: ' + msg : 'Printing failed.';
  }
  function fail(code){ const e = new Error(code); e.code = code; return e; }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function withTimeout(p, ms){ return Promise.race([p, new Promise((_, rej) => setTimeout(() => { const e = new Error('connection timed out'); e.name = 'NetworkError'; rej(e); }, ms))]); }

  /* ------------------------------------------------------------------
     Web Bluetooth
     ------------------------------------------------------------------ */
  function _onGattDisconnected(){ if(conn.type === 'bluetooth'){ conn.connected = false; conn.characteristic = null; emit('status'); } }
  async function _findWriteCharacteristic(server){
    let services = [];
    try{ services = await server.getPrimaryServices(); }catch(e){ services = []; }
    if(!services.length){
      for(const u of BLE_SERVICES){ try{ services.push(await server.getPrimaryService(u)); }catch(e){} }
    }
    let best = null, bestScore = -1;
    for(const svc of services){
      let chars = [];
      try{ chars = await svc.getCharacteristics(); }catch(e){ continue; }
      for(const ch of chars){
        const p = ch.properties || {};
        if(!(p.writeWithoutResponse || p.write)) continue;
        const score = (BLE_WRITE_CHARS.includes(String(ch.uuid).toLowerCase()) ? 10 : 0)
          + (BLE_SERVICES.map(uuidOf).includes(String(svc.uuid).toLowerCase()) ? 4 : 0) + (p.writeWithoutResponse ? 2 : 0);
        if(score > bestScore){ best = ch; bestScore = score; }
      }
    }
    return best;
  }
  async function _connectBle(device){
    conn.connecting = true; emit('status');
    try{
      if(!device._ccccListening){ device.addEventListener('gattserverdisconnected', _onGattDisconnected); device._ccccListening = true; }
      const server = await withTimeout(device.gatt.connect(), 12000);
      const ch = await _findWriteCharacteristic(server);
      if(!ch){ try{ device.gatt.disconnect(); }catch(e){} throw fail('NO_WRITE'); }
      Object.assign(conn, {type: 'bluetooth', device, characteristic: ch, connected: true, name: device.name || 'Bluetooth printer',
        withoutResponse: !!(ch.properties && ch.properties.writeWithoutResponse)});
      lastError = '';
      return true;
    } finally { conn.connecting = false; emit('status'); }
  }
  // Opens the browser's Bluetooth chooser (must run from a tap). opts.showAll: list every device.
  async function choose(opts){
    opts = opts || {};
    const s = support();
    if(!s.bluetooth){ const m = friendly(fail('NOT_SUPPORTED')); setError(m); throw Object.assign(new Error(m), {friendly: m}); }
    try{
      const bt = _nav().bluetooth;
      if(typeof bt.getAvailability === 'function'){ try{ if(await bt.getAvailability() === false) throw fail('BT_OFF'); }catch(e){ if(e.code === 'BT_OFF') throw e; } }
      const req = opts.showAll ? {acceptAllDevices: true, optionalServices: BLE_SERVICES}
        : {filters: BLE_FILTER_SERVICES.map(u => ({services: [u]})).concat(BLE_NAME_PREFIXES.map(p => ({namePrefix: p}))), optionalServices: BLE_SERVICES};
      const device = await bt.requestDevice(req);
      await _disconnectQuiet();
      await _connectBle(device);
      await saveSettings({connection: 'bluetooth', device_id: device.id || '', device_name: device.name || 'Bluetooth printer'});
      return status();
    }catch(e){
      const m = friendly(e, 'bluetooth'); setError(m);
      throw Object.assign(e instanceof Error ? e : new Error(m), {friendly: m});
    }
  }
  // Silent reconnect to the remembered Bluetooth printer (no chooser; needs getDevices()).
  async function _reconnectBle(){
    if(conn.type === 'bluetooth' && conn.device && conn.device.gatt && conn.device.gatt.connected && conn.characteristic){ conn.connected = true; return true; }
    if(conn.device && conn.type === 'bluetooth'){ try{ return await _connectBle(conn.device); }catch(e){} }
    const bt = _nav().bluetooth;
    if(!bt || typeof bt.getDevices !== 'function') return false;
    let list = [];
    try{ list = await bt.getDevices(); }catch(e){ return false; }
    const dev = list.find(d => current.device_id && d.id === current.device_id) || list.find(d => current.device_name && d.name === current.device_name);
    if(!dev) return false;
    try{ return await _connectBle(dev); }
    catch(e){
      // Not in range yet: wait briefly for it to advertise, then try once more.
      if(typeof dev.watchAdvertisements === 'function'){
        try{
          const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const seen = new Promise(res => dev.addEventListener('advertisementreceived', res, {once: true}));
          await dev.watchAdvertisements(ctl ? {signal: ctl.signal} : undefined);
          await withTimeout(seen, 6000).finally(() => { try{ ctl && ctl.abort(); }catch(e){} });
          return await _connectBle(dev);
        }catch(e2){}
      }
      return false;
    }
  }
  async function _writeBle(bytes){
    let size = current.ble_chunk, off = 0, retried = false;
    const delay = current.ble_delay_ms;
    while(off < bytes.length){
      const part = bytes.subarray ? bytes.subarray(off, off + size) : bytes.slice(off, off + size);
      const ch = conn.characteristic;
      try{
        if(!ch) throw fail('NOT_CONNECTED');
        if(conn.withoutResponse && typeof ch.writeValueWithoutResponse === 'function') await ch.writeValueWithoutResponse(part);
        else if(typeof ch.writeValueWithResponse === 'function') await ch.writeValueWithResponse(part);
        else await ch.writeValue(part);
        off += part.length;
        if(delay && off < bytes.length) await sleep(delay);
      }catch(e){
        const stillUp = conn.device && conn.device.gatt && conn.device.gatt.connected && ch;
        if(stillUp && size > 20){ size = 20; await saveSettings({ble_chunk: 20}); continue; }   // printer wants small pieces
        if(!stillUp && !retried){                                                              // dropped: reconnect once, carry on from here
          retried = true; conn.connected = false;
          let ok = false; try{ ok = await _connectBle(conn.device); }catch(e2){ ok = false; }
          if(ok) continue;
        }
        conn.connected = !!(conn.device && conn.device.gatt && conn.device.gatt.connected);
        throw _withWritten(e, off);
      }
    }
  }

  /* ------------------------------------------------------------------
     Web Serial (Bluetooth SPP / USB serial printers)
     ------------------------------------------------------------------ */
  async function _openPort(port){
    conn.connecting = true; emit('status');
    try{
      if(!port.writable){
        try{ await port.open({baudRate: current.serial_baud}); }
        catch(e){ if(!(e && e.name === 'InvalidStateError' && port.writable)) throw e; }
      }
      const info = (typeof port.getInfo === 'function' && port.getInfo()) || {};
      const name = info.bluetoothServiceClassId ? 'Bluetooth printer port' : (info.usbVendorId ? 'USB printer (' + info.usbVendorId.toString(16) + ':' + (info.usbProductId || 0).toString(16) + ')' : 'Printer port');
      Object.assign(conn, {type: 'serial', port, connected: true, name});
      lastError = '';
      return true;
    } finally { conn.connecting = false; emit('status'); }
  }
  async function chooseSerial(){
    const s = support();
    if(!s.serial){ const m = s.apple_mobile || !s.secure ? supportText() : 'This browser can\'t open printer ports. Use Chrome or Edge on a Windows or Mac computer.'; setError(m); throw Object.assign(new Error(m), {friendly: m}); }
    try{
      const ser = _nav().serial;
      let port;
      try{ port = await ser.requestPort({allowedBluetoothServiceClassIds: [SPP_CLASS]}); }
      catch(e){ if(e && e.name === 'TypeError') port = await ser.requestPort(); else throw e; }
      await _disconnectQuiet();
      await _openPort(port);
      const info = (typeof port.getInfo === 'function' && port.getInfo()) || {};
      await saveSettings({connection: 'serial', device_id: info.usbVendorId ? info.usbVendorId + ':' + (info.usbProductId || 0) : (info.bluetoothServiceClassId || 'serial'), device_name: conn.name});
      return status();
    }catch(e){
      const m = friendly(e, 'serial'); setError(m);
      throw Object.assign(e instanceof Error ? e : new Error(m), {friendly: m});
    }
  }
  async function _reconnectSerial(){
    if(conn.type === 'serial' && conn.port && conn.port.writable){ conn.connected = true; return true; }
    const ser = _nav().serial;
    if(!ser || typeof ser.getPorts !== 'function') return false;
    let ports = [];
    try{ ports = await ser.getPorts(); }catch(e){ return false; }
    const match = ports.find(p => { const i = (p.getInfo && p.getInfo()) || {}; return current.device_id && (i.usbVendorId ? i.usbVendorId + ':' + (i.usbProductId || 0) : (i.bluetoothServiceClassId || 'serial')) === current.device_id; }) || ports[0];
    if(!match) return false;
    try{ return await _openPort(match); }catch(e){ return false; }
  }
  async function _writeSerial(bytes){
    const port = conn.port;
    if(!port || !port.writable) throw fail('NOT_CONNECTED');
    const w = port.writable.getWriter();
    let off = 0;
    try{ for(const part of chunk(bytes, 512)){ await w.write(part); off += part.length; } }
    catch(e){ throw _withWritten(e, off); }
    finally { try{ w.releaseLock(); }catch(e){} }
  }

  /* ------------------------------------------------------------------
     Connect / print
     ------------------------------------------------------------------ */
  async function _disconnectQuiet(){
    try{ if(conn.type === 'bluetooth' && conn.device && conn.device.gatt && conn.device.gatt.connected) conn.device.gatt.disconnect(); }catch(e){}
    try{ if(conn.type === 'serial' && conn.port && conn.port.writable) await conn.port.close(); }catch(e){}
    Object.assign(conn, {type: null, connected: false, device: null, characteristic: null, port: null, name: ''});
  }
  // Reconnects to the remembered printer without asking (page load / before printing).
  // Returns true when connected. Never opens a chooser.
  async function reconnect(){
    if(current.connection === 'bluetooth' && support().bluetooth) return !!(await _reconnectBle());
    if(current.connection === 'serial' && support().serial) return !!(await _reconnectSerial());
    return false;
  }
  async function disconnect(){ await _disconnectQuiet(); emit('status'); }
  // Forget the printer on this counter (back to the print screen).
  async function forget(){
    const dev = conn.device;
    await _disconnectQuiet();
    try{ if(dev && typeof dev.forget === 'function') await dev.forget(); }catch(e){}
    await saveSettings({connection: 'dialog', device_id: '', device_name: ''});
    lastError = ''; emit('status');
  }
  // Load settings and reconnect quietly. Call once when the counter starts.
  async function init(){
    await loadSettings();
    if(typeof navigator !== 'undefined' && navigator.serial && typeof navigator.serial.addEventListener === 'function'){
      try{ navigator.serial.addEventListener('disconnect', (e) => { if(conn.type === 'serial' && (!e || e.target === conn.port || e.port === conn.port)){ conn.connected = false; conn.port = null; emit('status'); } }); }catch(e){}
    }
    reconnect().catch(() => false);
    return status();
  }
  function directMode(){ return (current.connection === 'bluetooth' && support().bluetooth) || (current.connection === 'serial' && support().serial); }

  // Errors from a print job carry how many bytes reached the printer before it stopped
  // (e.written; 0 = nothing was sent, so nothing came out of the printer).
  function _withWritten(e, n){
    if(!(e instanceof Error)) e = new Error(String(e || 'write failed'));
    try{ e.written = Math.max(0, n | 0); }catch(x){}
    return e;
  }
  let queue = Promise.resolve();
  // Send raw bytes (one job at a time). Reconnects quietly first.
  function sendBytes(bytes){
    const job = queue.then(async () => {
      busy = true; emit('status');
      try{
        if(!conn.connected && !(await reconnect())) throw fail('NOT_CONNECTED');
        if(conn.type === 'bluetooth') await _writeBle(bytes);
        else if(conn.type === 'serial') await _writeSerial(bytes);
        else throw fail('NOT_CONNECTED');
        lastPrintedAt = new Date().toISOString(); lastError = '';
        emit('printed', {at: lastPrintedAt, bytes: bytes.length});
        return true;
      } catch(e){
        e = _withWritten(e, e && e.written);
        e.partial = e.written > 0;
        throw e;
      } finally { busy = false; emit('status'); }
    });
    queue = job.catch(() => null);
    return job;
  }
  function _dialog(sale, items, payments, opts){
    if(typeof receiptHtml !== 'function' || typeof openPrintWindow !== 'function') return null;
    return openPrintWindow(receiptHtml(sale, items, payments, Object.assign({paperWidth: current.paper_width}, opts)), opts.autoPrint !== false);
  }
  // Was the drawer-kick command (ESC p, sent right after ESC @) among the bytes that reached the printer?
  const DRAWER_END = 7;   // ESC @ (2 bytes) + ESC p 0 25 250 (5 bytes)
  function _drawerSent(bytes, written){
    return written >= DRAWER_END && bytes[2] === ESC && bytes[3] === 0x70;
  }
  // Print a receipt. Same arguments as receiptHtml, plus the extra opts of receiptBytes, and:
  //   auto: true      -> printing by itself after a sale: never opens the print screen on failure
  //   fallback: false -> never open the print screen on failure (same as auto)
  // Returns {ok, method: 'bluetooth'|'serial'|'dialog', partial?, error?, drawer_kick_sent}.
  //   Print screen chosen (or direct printing impossible here) -> the print screen, ok true
  //     (for auto prints too: that is the counter's chosen way to print).
  //   Direct printing fails BEFORE any byte reached the printer -> last_error set; the print
  //     screen opens (unless auto / fallback false): {ok:false, method:'dialog', error}.
  //   Fails PART-WAY (some paper came out) -> never the print screen by itself (it would
  //     print a second copy): {ok:false, partial:true, method, error}. The counter offers
  //     "Print again" / "Use print screen" (printReceipt(..., {fallback:false}) / receiptHtml).
  //   drawer_kick_sent: the cash drawer command reached the printer (the drawer opened).
  async function printReceipt(sale, items, payments, opts){
    opts = opts || {};
    if(!directMode()){ _dialog(sale, items, payments, opts); return {ok: true, method: 'dialog', drawer_kick_sent: false}; }
    const bytes = receiptBytes(sale, items, payments, opts);
    try{
      await sendBytes(bytes);
      return {ok: true, method: conn.type, drawer_kick_sent: _drawerSent(bytes, bytes.length)};
    }catch(e){
      const written = (e && e.written) || 0;
      const partial = written > 0;
      const m = partial ? 'Printing stopped part-way. ' + friendly(e, current.connection) : friendly(e, current.connection);
      setError(m);
      const drawer = _drawerSent(bytes, written);
      if(partial) return {ok: false, partial: true, method: current.connection, error: m, drawer_kick_sent: drawer};
      if(opts.fallback !== false && !opts.auto){ _dialog(sale, items, payments, opts); return {ok: false, partial: false, method: 'dialog', error: m, drawer_kick_sent: false}; }
      return {ok: false, partial: false, method: current.connection, error: m, drawer_kick_sent: false};
    }
  }
  // A short test slip. opts.openDrawer: also kick the drawer (the counter makes that
  // manager-only and writes the audit entry). Returns
  //   {ok, method, partial, error?, drawer_requested, drawer_kick_sent, printer_name, at}
  //   drawer_kick_sent: true when the drawer command reached the printer (even if the slip
  //   then stopped part-way), so the counter knows to write "Cash drawer opened (test slip)".
  async function printTest(opts){
    opts = opts || {};
    const base = {drawer_requested: !!opts.openDrawer, drawer_kick_sent: false, printer_name: state_device_name(), at: new Date().toISOString()};
    if(!directMode()) return Object.assign(base, {ok: false, partial: false, method: current.connection, error: current.connection === 'dialog' ? 'Choose a Bluetooth printer or printer port first.' : supportText()});
    const bytes = testBytes(opts);
    try{
      await sendBytes(bytes);
      return Object.assign(base, {ok: true, partial: false, method: conn.type, printer_name: state_device_name(), drawer_kick_sent: !!opts.openDrawer && _drawerSent(bytes, bytes.length)});
    }catch(e){
      const written = (e && e.written) || 0;
      const m = (written > 0 ? 'Printing stopped part-way. ' : '') + friendly(e, current.connection); setError(m);
      return Object.assign(base, {ok: false, partial: written > 0, method: current.connection, error: m, drawer_kick_sent: !!opts.openDrawer && _drawerSent(bytes, written)});
    }
  }

  return {
    // setup
    init, loadSettings, settings, saveSettings, DEFAULTS: Object.freeze(Object.assign({}, DEFAULTS)),
    // connection
    choose, chooseSerial, reconnect, disconnect, forget, support, supportText, status, on, off,
    // printing
    printReceipt, printTest, sendBytes, receiptBytes, testBytes,
    // building blocks (pure; tests and other tickets)
    EscPos, describe, chunk, toAscii, money, wrap, leftRight, CHARS,
    BLE_SERVICES, BLE_FILTER_SERVICES, BLE_NAME_PREFIXES, cleanSettings,
  };
})();
