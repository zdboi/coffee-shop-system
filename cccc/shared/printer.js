/* =====================================================================
   PRINTER — receipt printing straight to a thermal receipt printer
   (release 1.3, P1). Used by the counter (Front Office).

   Connection types (chosen per counter, saved on this device only):
     'usb'       : WebUSB (release 1.4): a USB-cable receipt printer (USB printer class, e.g.
                   Xprinter XP-58). Chrome / Edge / Brave on a Mac or computer. Reconnects by
                   itself on page load and when the cable is plugged back in (no chooser).
     'bluetooth' : Web Bluetooth (BLE printers). Chrome / Edge on Android, Windows, Mac.
                   (Brave: off until brave://flags/#brave-web-bluetooth-api is Enabled.)
     'serial'    : Web Serial (Chrome / Edge / Brave 1.69+ on a computer): a printer paired as a
                   Bluetooth (classic / SPP) or USB serial port, e.g. a COM port on Windows.
     'dialog'    : no printer chosen. Release 1.4 (owner: "not prompt me to save it as PDF"):
                   NOTHING opens the browser's print screen by itself any more. printReceipt /
                   printTicket / printShiftReport open it only with opts.fallback === true (an
                   explicit staff tap on "Use print screen"); otherwise they answer
                   {ok:false, error:'NOT_CONNECTED'} straight away.
   Jobs: receipts, barista order tickets (printTicket) and X / Z shift reports
   (printShiftReport) go through one queue, so two jobs never mix on the paper.
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
   openPrintWindow, paymentMethodLabel, businessName). The ESC/POS builder itself needs nothing.
   ===================================================================== */
const Printer = (() => {
  const SETTINGS_KEY = 'cccc.printer.settings';   // LocalDB (this counter only, never the server)
  const DEFAULTS = {
    connection: 'dialog',        // 'dialog' (none chosen) | 'usb' | 'bluetooth' | 'serial'
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
    // release 1.4: USB printer + more auto prints
    usb_vendor_id: 0,            // remembered USB printer (vendor / product / serial number)
    usb_product_id: 0,
    usb_serial: '',              // Brave changes the serial it reports (fingerprint shield): matched only as a tie-breaker
    usb_chunk: 1024,             // bytes per USB write
    auto_print_ticket: true,     // barista order ticket after each counter sale
    auto_print_qr: false,        // barista order ticket when a QR order arrives (OFF by default, lead 2026-11-08: else every counter prints every QR order)
    auto_print_shift: true,      // Z report right after closing the shift
    ticket_copies: 1,            // 1..3
  };
  const CHARS = {58: 32, 80: 48};   // characters per line, font A

  // USB (release 1.4). Chooser filters: any USB printer-class device (class 7, matched on the
  // device or any of its interfaces), plus makers of ESC/POS receipt printers whose cheap
  // models report a vendor-specific class. The printer class filter is the main one.
  const USB_PRINTER_CLASS = 7;
  const USB_VENDORS = [
    0x0483,   // STMicroelectronics chip: Xprinter, many "POS-58" / "POS-80" printers
    0x0416,   // Winbond (Nuvoton) chip: Xprinter, ZJiang, GOOJPRT, HOIN "POS58"
    0x1fc9,   // NXP chip: newer Xprinter XP-58 / XP-80
    0x0fe6,   // ICS Advent chip: generic "USB Printer P", Xprinter, Rongta
    0x28e9,   // GigaDevice chip: newer Xprinter / Rongta
    0x6868,   // ZJiang / generic Chinese 58 mm printers
    0x154f,   // SNBC
    0x04b8,   // Epson (TM series)
    0x0519,   // Star Micronics
    0x1504,   // Bixolon
    0x0419,   // Samsung / older Bixolon SRP
    0x1d90,   // Citizen
    0x2730,   // Citizen (CT-S)
    0x0dd4,   // Custom Engineering
  ];
  const USB_FILTERS = [{classCode: USB_PRINTER_CLASS}].concat(USB_VENDORS.map(v => ({vendorId: v})));
  const USB_TIMEOUT_MS = 15000;    // one USB write: a printer out of paper stops taking data
  const USB_PLUG_DELAY_MS = 250;   // after the cable is plugged in, give the Mac a moment

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
      // One data field, wrapped lines after the first indented by `indent` (ticket item names).
      hang(s, indent){
        indent = Math.max(0, Math.min(8, indent | 0)); const w = this.cols();
        const all = wrap(toAscii(s, this.peso), w);
        const rest = all.length > 1 ? wrap(all.slice(1).join(' '), Math.max(1, w - indent)).map(l => ' '.repeat(indent) + l) : [];
        [all[0]].concat(rest).forEach(l => { this.text(l); this.bytes.push(0x0A); });
        return this;
      },
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
    if(typeof paymentMethodLabel === 'function') return paymentMethodLabel(m) || '-';
    return m || '-';
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
    const kind = sale.senior_kind === 'PWD' ? 'PWD' : 'Senior citizen';
    if(Number(sale.vat_exempt_amount) > 0) b.lr('VAT exempt (' + kind + ')', '-' + b.money(sale.vat_exempt_amount));
    if(Number(sale.senior_discount) > 0) b.lr(kind + ' discount', '-' + b.money(sale.senior_discount));
    if(Number(sale.tax_amount) > 0) b.lr('Tax', b.money(sale.tax_amount));
    if(Number(sale.service_charge_amount) > 0) b.lr('Service charge', b.money(sale.service_charge_amount));
    if(Number(sale.payment_charge) > 0) b.lr(_methodLabel(((payments || [])[0] || {}).method) + ' charge', b.money(sale.payment_charge));
    b.bold(true).size(1, 2).lr('TOTAL', b.money(sale.grand_total)).size(1, 1).bold(false);
    b.sep();
    const pays = (payments && payments.length) ? payments : [{}];
    pays.forEach(pay => {
      b.lr('Payment (' + _methodLabel(pay.method) + ')', b.money(pay.amount || sale.grand_total));
      if(pay.method === 'CASH'){ b.lr('Cash received', b.money(pay.tendered)); b.lr('Change', b.money(pay.change)); }
      if(pay.reference) b.lr('Ref#', pay.reference);
    });
    if(Number(sale.senior_discount) > 0){
      // Senior / PWD: name, the ID's last 4 characters, a line to sign
      const sn = opts.senior || {};
      const idText = String(sn.id_number || '').trim();
      b.sep();
      b.line(kind + (sn.holder_name ? ': ' + sn.holder_name : ''));
      // same masking as the screen receipt (maskIdNumber): last 4, or last 2 for a short ID; ASCII for the printer
      b.line('ID no.: ' + (idText ? (typeof maskIdNumber === 'function' ? maskIdNumber(idText) : '**** ' + idText.slice(-4)).replace(/•/g, '*') : 'on file'));
      b.feed(1).line('Signature: ____________________');
    }
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
  /* ------------------------------------------------------------------
     Barista order ticket (release 1.4). No prices.
     order: a QR order (qr_orders row: order_number, table_label, order_type, customer_nickname,
       created_at, paid_at, customer_note, items[{name, quantity, modifiers[{label}], notes}])
       or a counter sale ({transaction_number, transaction_date, items, ...}).
     opts: {copies, reprint, source: 'QR'|'COUNTER', customerName, paid, + any setting}.
     ------------------------------------------------------------------ */
  function _ticketSource(order, opts){
    const s = String(opts.source || order.source || (order.order_number ? 'QR' : 'COUNTER')).toUpperCase();
    return s === 'QR' ? 'QR' : 'COUNTER';
  }
  function _ticketBody(b, order, opts){
    const src = _ticketSource(order, opts);
    const num = order.order_number || order.ticket_number || order.transaction_number || '';
    b.align('center').bold(true).size(2, 2).line(num || 'ORDER').size(1, 1);
    b.line(src === 'QR' ? 'QR ORDER' : 'COUNTER ORDER');
    const type = order.order_type === 'TAKEAWAY' ? 'TAKEAWAY' : order.order_type === 'DINE_IN' ? 'DINE-IN' : '';
    const where = [order.table_label, type].filter(Boolean).join(' - ');
    if(where) b.size(1, 2).line(where).size(1, 1);
    b.bold(false);
    // Payment status (security L1): its own fixed line, computed ONLY from paid_at / opts.paid,
    // between two separators, so customer text (e.g. a nickname "Ana PAID") can never stand there.
    const paid = !!(order.paid_at || opts.paid);
    const status = paid ? 'PAID' : (src === 'QR' ? 'NOT PAID - PAY AT COUNTER' : '');
    if(status) b.sep().bold(true).size(1, 2).line(status).size(1, 1).bold(false).sep();
    const nick = order.customer_nickname || order.customer_name || opts.customerName || '';
    if(nick) b.line('Name: ' + nick);
    const when = order.created_at || order.transaction_date || '';
    const whenText = [_dateText(when), _timeText(when)].filter(Boolean).join(' ');
    if(whenText) b.line(whenText);
    b.align('left').sep();
    let count = 0;
    (order.items || []).forEach(it => {
      const q = Number(it.quantity != null ? it.quantity : it.qty) || 1;
      count += q;
      b.bold(true).size(1, 2).hang(q + ' x ' + (it.name || it.item_name || it.recipe_name || ''), 4).size(1, 1).bold(false);
      (it.modifiers || []).forEach(m => b.line('  - ' + ((m && (m.label || m.name)) || '')));
      if(it.notes) b.line('  "' + it.notes + '"');
    });
    b.sep();
    const note = order.customer_note || order.notes || '';
    if(note){ b.bold(true).line('Note: ' + note).bold(false).sep(); }
    b.line(count + (count === 1 ? ' item' : ' items'));
    if(opts.reprint) b.align('center').line('(Reprint)').align('left');
  }
  function ticketBytes(order, opts){
    opts = opts || {};
    const st = Object.assign({}, current, _pick(opts));
    const b = EscPos(st);
    b.init();
    const copies = Math.max(1, Math.min(3, Number(opts.copies || st.ticket_copies) || 1));
    for(let c = 0; c < copies; c++){
      _ticketBody(b, order || {}, opts);
      b.feed(4);
      if(st.cut !== false) b.cut();
    }
    return b.toUint8();
  }

  /* ------------------------------------------------------------------
     X / Z shift report (release 1.4). Same lines as the counter's X/Z report
     (front.js shiftReportHtml): salesSummaryRows + Voids + Transactions, Cash / Card /
     Other, then the cash drawer. For a CLOSED shift the figures saved when it closed are
     used (cash_sales, card_sales, other_sales, expected_cash, declared_cash, cash_variance,
     voids_total, transaction_count), exactly like that report. Nothing is recalculated
     here: every figure comes from shiftMetrics() / salesSummaryRows() (logic.js) or the shift.
     report: {shift, metrics (= shiftMetrics(shift)), isX, device_name, waste_count}
       or just the shift (metrics then come from shiftMetrics(shift), or opts.metrics).
     opts: {isX, metrics, device_name, waste_count, copies, + any setting}.
     ------------------------------------------------------------------ */
  function _shiftInput(report, opts){
    report = report || {}; opts = opts || {};
    const shift = report.shift || report;
    let m = report.metrics || report.m || opts.metrics || null;
    if(!m && typeof shiftMetrics === 'function'){ try{ m = shiftMetrics(shift); }catch(e){ m = null; } }
    const pick = (...xs) => xs.find(x => x !== undefined && x !== null);
    let isX = pick(report.shift ? report.isX : undefined, report.is_x, opts.isX);
    if(isX === undefined) isX = shift.status !== 'CLOSED';
    let dev = pick(report.shift ? report.device_name : undefined, opts.device_name);
    if(dev === undefined){ try{ dev = (typeof state !== 'undefined' && state && state.device && state.device.device_name) || ''; }catch(e){ dev = ''; } }
    const waste = pick(report.shift ? report.waste_count : undefined, opts.waste_count);
    return {shift, m: m || {}, isX: !!isX, device_name: dev || '', waste_count: waste};
  }
  function _dt(d){ return [_dateText(d), _timeText(d)].filter(Boolean).join(' '); }
  function _shiftBody(b, r, opts){
    const {shift, m, isX} = r;
    const closed = shift.status === 'CLOSED';
    const v = (k, live) => (closed && shift[k] !== null && shift[k] !== undefined && shift[k] !== '') ? Number(shift[k]) : Number(live);
    const signed = (n) => { n = Number(n) || 0; return (n >= 0 ? '+' : '') + b.money(n); };
    b.align('center').bold(true).size(2, 2).line(isX ? 'X REPORT' : 'Z REPORT').size(1, 1);
    b.line(_shopName() || 'Shift report').bold(false);
    b.line(isX ? 'Mid-shift (shift still open)' : (closed ? 'Shift closed' : 'Shift report'));
    b.align('left').sep();
    if(shift.shift_number) b.lr('Shift', shift.shift_number);
    b.lr('Cashier', shift.cashier_name || '');
    if(shift.closed_by_name && shift.closed_by_name !== shift.cashier_name) b.lr('Closed by', shift.closed_by_name);
    if(r.device_name) b.lr('Counter', r.device_name);
    b.lr('Opened', _dt(shift.opened_at));
    if(closed) b.lr('Closed', _dt(shift.closed_at));
    else b.lr('Up to', _dt(opts.now || new Date()));
    if(typeof shiftDuration === 'function' && shift.opened_at){
      try{ b.lr('Length', shiftDuration(closed ? shift : Object.assign({}, shift, {closed_at: new Date(opts.now || Date.now()).toISOString()}))); }catch(e){}
    }
    b.sep().bold(true).line('SALES').bold(false);
    const rows = typeof salesSummaryRows === 'function' ? salesSummaryRows(m, shift) : [];
    rows.forEach(row => {
      if(row.total) b.bold(true);
      b.lr(row.label, row.sign + b.money(row.amount));
      if(row.total) b.bold(false);
      if(row.key === 'taxAndService' && (Number(m.taxTotal) > 0 || Number(m.serviceTotal) > 0)){
        b.lr('  Tax', b.money(m.taxTotal));
        b.lr('  Service charge', b.money(m.serviceTotal));
      }
    });
    const voids = closed && shift.voids_total !== null && shift.voids_total !== undefined ? Number(shift.voids_total) : m.voids;
    const count = closed && shift.transaction_count !== null && shift.transaction_count !== undefined ? shift.transaction_count : m.transactionCount;
    b.lr((typeof SALES_LABELS !== 'undefined' && SALES_LABELS.voids) || 'Voids', b.money(voids));
    b.lr('Transactions', String(Number(count) || 0));
    b.sep().bold(true).line('PAYMENTS').bold(false);
    b.lr('Cash', b.money(v('cash_sales', m.cashGross)));
    b.lr('Card', b.money(v('card_sales', m.cardGross)));
    b.lr('Other methods', b.money(v('other_sales', m.otherGross)));
    b.sep().bold(true).line('CASH DRAWER').bold(false);
    b.lr('Opening cash', b.money(shift.opening_cash));
    b.lr('Cash sales', b.money(v('cash_sales', m.cashGross)));
    const cashRefunds = (Number(m.cashGross) || 0) - (Number(m.netCashFromSales) || 0);
    if(cashRefunds > 0.005) b.lr('Cash refunds', '-' + b.money(cashRefunds));
    b.lr('Pay ins (' + (Number(m.payInCount) || 0) + ')', '+' + b.money(m.payIns));
    b.lr('Pay outs (' + (Number(m.payOutCount) || 0) + ')', '-' + b.money(m.payOuts));
    b.bold(true).lr('Expected cash', b.money(v('expected_cash', m.expectedCash))).bold(false);
    if(closed){
      b.lr('Counted cash', b.money(shift.declared_cash));
      b.bold(true).size(1, 2).lr('Difference', signed(shift.cash_variance)).size(1, 1).bold(false);
    }
    if(r.waste_count !== undefined && r.waste_count !== null && r.waste_count !== ''){ b.sep(); b.lr('Waste entries', String(Number(r.waste_count) || 0)); }
    if(shift.notes){ b.sep(); b.line('Notes: ' + shift.notes); }
    b.sep().align('center');
    if(isX) b.line('Not final: the shift is still open.');
    b.line('Printed ' + _dt(opts.now || new Date()));
    if(opts.reprint) b.line('(Reprint)');
    b.align('left');
  }
  function shiftReportBytes(report, opts){
    opts = opts || {};
    const r = _shiftInput(report, opts);
    const st = Object.assign({}, current, _pick(opts));
    const b = EscPos(st);
    b.init();
    const copies = Math.max(1, Math.min(3, Number(opts.copies) || 1));
    for(let c = 0; c < copies; c++){
      _shiftBody(b, r, opts);
      b.feed(4);
      if(st.cut !== false) b.cut();
    }
    return b.toUint8();
  }
  // Plain print-screen page with the same text as the paper (only for opts.fallback === true
  // when the caller gives no opts.html of its own).
  function _escHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
  function textHtml(title, bytes, paper){
    const text = describe(bytes).replace(/\[(INIT|ALIGN [LCR]|B|\/B|SIZE \dx\d|FEED \d+|CUT|DRAWER)\]/g, '').replace(/\[QR [^\]]*\]/g, '');
    const w = Number(paper) === 80 ? 80 : 58;
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + _escHtml(title || 'Print') + '</title><style>@page{size:' + w + 'mm auto;margin:0}'
      + 'body{margin:0;padding:4mm;width:' + (w - 8) + 'mm;font:12px/1.35 "Courier New",monospace;white-space:pre-wrap;color:#000}</style></head><body>'
      + _escHtml(text) + '</body></html>';
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
    if(!['dialog', 'usb', 'bluetooth', 'serial'].includes(s.connection)) s.connection = 'dialog';
    const id16 = (x) => { const n = Math.round(Number(x)); return n >= 0 && n <= 0xFFFF ? n : 0; };
    s.usb_vendor_id = id16(s.usb_vendor_id); s.usb_product_id = id16(s.usb_product_id);
    s.usb_serial = String(s.usb_serial || '');
    s.usb_chunk = Math.max(64, Math.min(16384, Math.round(Number(s.usb_chunk)) || 1024));
    s.auto_print_ticket = s.auto_print_ticket !== false; s.auto_print_qr = s.auto_print_qr === true; s.auto_print_shift = s.auto_print_shift !== false;
    s.ticket_copies = Math.max(1, Math.min(3, Math.round(Number(s.ticket_copies)) || 1));
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
  const conn = {type: null, connected: false, connecting: false, name: '', device: null, characteristic: null, withoutResponse: false, port: null, writer: null,
    usb: null, usbInterface: null, usbEndpoint: null};
  let lastError = '', lastPrintedAt = null, busy = false, pending = 0;
  let usbNeedsTap = false;        // the remembered USB printer isn't in the browser's allowed list right now
  let reconnectError = null;      // why the last quiet reconnect failed (e.g. USB_BUSY), for the job's message
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
  // Which browser is this? Brave hides itself in the user agent (it says "Chrome"), but has
  // navigator.brave. 'brave' | 'edge' | 'chrome' | 'safari' | 'firefox' | 'other'
  function browserName(){
    const n = _nav(); const ua = String(n.userAgent || '');
    if(n.brave && typeof n.brave.isBrave === 'function') return 'brave';
    if(/Firefox\/|FxiOS/.test(ua)) return 'firefox';
    if(/Edg(e|A|iOS)?\//.test(ua)) return 'edge';
    if(/OPR\/|Opera/.test(ua)) return 'other';
    if(/Chrome\/|Chromium\/|CriOS/.test(ua)) return 'chrome';
    if(/Safari\//.test(ua) || /^Apple/.test(String(n.vendor || ''))) return 'safari';
    return 'other';
  }
  function _platform(){
    const n = _nav(); const ua = String(n.userAgent || ''); const p = String((n.userAgentData && n.userAgentData.platform) || n.platform || '');
    if(isAppleMobile()) return 'ios';
    if(/Mac/.test(p) || /Macintosh|Mac OS X/.test(ua)) return 'mac';
    if(/Win/.test(p) || /Windows/.test(ua)) return 'windows';
    if(/Android/.test(ua)) return 'android';
    return 'other';
  }
  function support(){
    const n = _nav();
    const secure = typeof window === 'undefined' || window.isSecureContext !== false;
    const browser = browserName();
    return {
      usb: !!(n.usb && typeof n.usb.requestDevice === 'function') && secure,
      usb_remember: !!(n.usb && typeof n.usb.getDevices === 'function'),
      bluetooth: !!(n.bluetooth && typeof n.bluetooth.requestDevice === 'function') && secure,
      bluetooth_remember: !!(n.bluetooth && typeof n.bluetooth.getDevices === 'function'),
      serial: !!(n.serial && typeof n.serial.requestPort === 'function') && secure,
      dialog: true, apple_mobile: isAppleMobile(), secure,
      browser, brave: browser === 'brave', safari: browser === 'safari', platform: _platform(),
    };
  }
  // Plain words about what this browser can do (for the counter's printer screen).
  // helpSteps() has the step-by-step version.
  function supportText(){
    const s = support();
    if(s.apple_mobile) return 'iPad and iPhone don\'t let any browser connect to USB or Bluetooth receipt printers. Use "Use print screen" to print (works with AirPrint printers).';
    if(s.safari) return 'Safari can\'t print straight to a receipt printer (Apple doesn\'t allow it). Open the counter app in Google Chrome on this Mac instead.';
    if(!s.secure) return 'Direct printing needs the secure (https) address of the app.';
    if(s.brave){
      return (s.usb ? 'Brave can print to a USB receipt printer: tap Connect USB printer. ' : '')
        + 'Bluetooth printers need a Brave setting (brave://flags/#brave-web-bluetooth-api, then Enabled and Relaunch). '
        + 'For the counter, Google Chrome is the most reliable browser.';
    }
    const ways = [];
    if(s.usb) ways.push('USB cable');
    if(s.bluetooth) ways.push('Bluetooth');
    if(s.serial) ways.push('a printer port (Bluetooth or USB)');
    if(ways.length) return 'This browser can print by ' + (ways.length > 1 ? ways.slice(0, -1).join(', ') + ' or ' + ways[ways.length - 1] : ways[0]) + '.';
    return 'This browser can\'t connect to receipt printers. Use Google Chrome or Edge on a Mac or Windows computer, or Chrome on an Android tablet.';
  }
  // Step-by-step help for this browser: {browser, platform, title, steps: [..], notes: [..]}.
  // Facts checked 2026-11-08 against Brave's own source and issue tracker:
  //   WebUSB: on in Brave (desktop); Brave's fingerprint shield changes the USB serial number a
  //     site sees (so we don't rely on it). Web Serial: on by default since Brave 1.69 (2024);
  //     before that it needed brave://flags/#brave-web-serial-api. Web Bluetooth: OFF by
  //     default; brave://flags/#brave-web-bluetooth-api.
  function helpSteps(){
    const s = support();
    const b = s.browser, mac = s.platform === 'mac';
    const comp = mac ? 'the Mac' : 'the computer';
    const settingsUrl = (b === 'brave' ? 'brave' : b === 'edge' ? 'edge' : 'chrome') + '://settings/content/usbDevices';
    if(s.apple_mobile) return {browser: b, platform: s.platform, title: 'iPad / iPhone', steps: [
      'iPad and iPhone can\'t connect to USB or Bluetooth receipt printers from any browser.',
      'To print, tap "Use print screen" and choose an AirPrint printer.',
      'For automatic printing, run the counter on a Mac or Windows computer with Google Chrome.'], notes: []};
    if(b === 'safari') return {browser: b, platform: s.platform, title: 'Safari', steps: [
      'Safari can\'t talk to USB, Bluetooth or printer-port receipt printers (Apple doesn\'t allow it).',
      'Install Google Chrome on this Mac (google.com/chrome), open the counter app there and pair the counter again.',
      'Then go to Printer and tap Connect USB printer.'], notes: []};
    if(b === 'firefox' || b === 'other' || (!s.usb && !s.serial && !s.bluetooth)) return {browser: b, platform: s.platform, title: 'This browser', steps: [
      'This browser can\'t connect to receipt printers.',
      'Install Google Chrome, open the counter app there and pair the counter again.',
      'Then go to Printer and tap Connect USB printer.'], notes: []};
    const name = b === 'brave' ? 'Brave' : b === 'edge' ? 'Edge' : 'Chrome';
    const steps = [
      'Plug the printer\'s USB cable into ' + comp + ', switch the printer on and check it has paper.',
      'Open the counter app in ' + name + ' (the https address), go to Printer and tap Connect USB printer.',
      name + ' shows a small box listing USB devices. Click the receipt printer (its name is often "Printer POS-58", "USB Printing Support", "XP-58" or similar), then click Connect.',
      'Tap Print test slip. If the slip comes out, you\'re done: receipts, order tickets, QR orders and the shift report now print by themselves (switches on the Printer screen).',
      name + ' remembers the printer for this app. It reconnects by itself when the page opens and when the cable is plugged back in. If the Printer screen ever says "Tap Connect USB printer", tap it once (printers without a serial number are only remembered until they are unplugged or ' + name + ' is closed).',
    ];
    const notes = [
      'If the box never appears or the printer is greyed out: open ' + settingsUrl + ' and choose "Sites can ask to connect to USB devices"; check the app\'s address isn\'t under "Not allowed".',
      'If it says another program is using the printer: ' + (mac ? 'open System Settings > Printers & Scanners, click the receipt printer, click Remove Printer, then ' : 'close the printer\'s own app and ') + 'unplug the cable, wait 5 seconds, plug it back in and tap Connect USB printer again.',
    ];
    if(b === 'brave'){
      notes.push('Brave Shields don\'t need to be changed for USB printing.');
      notes.push('Bluetooth printers in Brave: type brave://flags/#brave-web-bluetooth-api in the address bar, set "Web Bluetooth API" to Enabled, click Relaunch.');
      notes.push('Printer ports (Connect printer port) work in Brave 1.69 or newer. Older Brave: update it (brave://settings/help).');
      notes.push('For the counter, Google Chrome is the most reliable browser. Brave works for USB printing.');
    } else if(b === 'chrome'){
      notes.push('Chrome is the recommended browser for the counter.');
    }
    if(s.platform === 'windows') notes.push('On Windows the printer\'s own driver usually blocks USB printing from the browser. Use Connect printer port (USB serial) or a Bluetooth printer instead.');
    return {browser: b, platform: s.platform, title: name + (mac ? ' on a Mac' : '') + ' + USB receipt printer', steps, notes};
  }
  function status(){
    return {
      connection: current.connection, connected: !!conn.connected, connecting: !!conn.connecting,
      type: conn.type, name: conn.name || current.device_name || '', remembered: !!(current.device_id || current.device_name),
      paper_width: current.paper_width, chars: CHARS[current.paper_width], busy, pending, last_error: lastError, last_printed_at: lastPrintedAt,
      usb_needs_tap: current.connection === 'usb' && usbNeedsTap && !conn.connected,
      support: support(), support_text: supportText(),
    };
  }

  function _usbBusyText(){
    const p = _platform();
    if(p === 'windows') return 'Another program or the Windows printer driver is using the USB printer, so the app can\'t reach it. Close the printer\'s own app, unplug the cable, plug it back in and tap Connect USB printer. If it keeps happening, use Connect printer port instead.';
    return 'Another program is using the USB printer, so the app can\'t reach it. 1) Close other browser tabs or apps that print to it. '
      + '2) ' + (p === 'mac' ? 'On the Mac, open System Settings > Printers & Scanners; if the receipt printer is listed, click it and click Remove Printer (the app prints to it by itself). ' : 'Remove the receipt printer from the computer\'s printer list. ')
      + '3) Unplug the USB cable, wait 5 seconds, plug it back in. 4) Tap Connect USB printer again.';
  }
  function _notConnectedText(where){
    if(where === 'usb'){
      if(usbNeedsTap) return 'The browser needs you to choose the USB printer again (once). Tap Connect USB printer.';
      return 'The USB printer isn\'t connected. Check the cable is plugged in and the printer is switched on' + (state_device_name() ? ' ("' + state_device_name() + '")' : '') + ', then tap Connect USB printer.';
    }
    if(where === 'serial') return 'The printer port isn\'t open. Check the printer is switched on, then tap Connect printer port.';
    if(where === 'bluetooth') return 'The printer isn\'t connected. Tap Connect Bluetooth printer.';
    return 'No receipt printer is connected. Open the Printer screen and tap Connect USB printer.';
  }
  function friendly(e, where){
    const name = e && e.name, msg = String((e && e.message) || e || '');
    const code = _code(e);
    if(/globally disabled/i.test(msg) || (support().brave && where === 'bluetooth' && name === 'NotFoundError' && /disabled/i.test(msg)))
      return 'Bluetooth printing is switched off in Brave. Type brave://flags/#brave-web-bluetooth-api in the address bar, set "Web Bluetooth API" to Enabled, click Relaunch, then try again. (Or use Google Chrome.)';
    if(where === 'usb'){
      if(code === 'USB_BUSY') return _usbBusyText();
      if(code === 'NO_USB_OUT') return 'That device isn\'t a receipt printer, so nothing was sent to it. Tap Connect USB printer and choose the receipt printer (its name often has "Printer", "POS" or "XP-" in it).';
      if(code === 'USB_TIMEOUT') return 'The printer stopped taking data. Check it has paper, the lid is closed and its light isn\'t flashing, then print again.';
      if(code === 'USB_LOST') return 'The USB printer was unplugged or switched off while printing. Plug it back in (it reconnects by itself), then print again.';
      if(code === 'NOT_CONNECTED') return _notConnectedText('usb');
      if(code === 'NOT_SUPPORTED') return supportText();
      if(name === 'NotFoundError') return 'No printer was chosen. If your printer wasn\'t in the list, check the USB cable and that the printer is on, then try again (or tap "Show all USB devices").';
      if(name === 'SecurityError') return 'The browser blocked the USB printer. Open the app from its https address and try again.' + (_platform() === 'windows' ? ' On Windows the printer\'s own driver can block it: use Connect printer port instead.' : '');
      if(name === 'NotAllowedError') return 'The browser didn\'t allow the USB printer. Tap Connect USB printer and click Connect in the box.';
      if(name === 'NetworkError' && /claim/i.test(msg)) return _usbBusyText();
      return msg ? 'Printing failed: ' + msg : 'Printing failed.';
    }
    if(name === 'NotFoundError' && /cancel|chosen|no device|User/i.test(msg)) return 'No printer was chosen.';
    if(name === 'NotFoundError' && where === 'serial') return 'No printer port was chosen.';
    if(name === 'NotFoundError') return 'No printer was chosen.';
    if(name === 'SecurityError') return 'The browser blocked the printer connection. Open the app from its https address and tap the button again.';
    if(name === 'NotAllowedError') return 'The browser didn\'t allow the printer connection. Tap Connect Bluetooth printer and allow it.';
    if(name === 'InvalidStateError' && where === 'serial') return 'The printer port is in use by another app or browser tab. Close it and try again.';
    if(name === 'NetworkError' || /disconnect|GATT|connection/i.test(msg) || (code === 'NOT_CONNECTED' && where === 'bluetooth' && state_device_name())) return 'Couldn\'t reach the printer' + (state_device_name() ? ' "' + state_device_name() + '"' : '') + '. Check it is switched on, has paper and is close by, then tap Connect Bluetooth printer.';
    if(code === 'NO_WRITE') return 'This Bluetooth device doesn\'t accept print data. Choose your receipt printer (or tap "Show all Bluetooth devices").';
    if(code === 'BT_OFF') return 'Bluetooth is off on this device. Turn it on and try again.';
    if(code === 'NOT_SUPPORTED') return supportText();
    if(code === 'NOT_CONNECTED') return _notConnectedText(where);
    return msg ? 'Printing failed: ' + msg : 'Printing failed.';
  }
  function fail(code){ const e = new Error(code); e.code = code; return e; }
  // Our own error codes are strings (a browser DOMException has a NUMBER in e.code: ignored).
  function _code(e){ return e && typeof e.code === 'string' ? e.code : ''; }
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
     WebUSB (release 1.4): USB-cable receipt printers (printer class 7)
     Never calls device.reset(): on macOS (Chromium 157 / Brave 1.99 regression) a reset
     leaves the printer unusable until it is unplugged.
     ------------------------------------------------------------------ */
  function _hex4(n){ return (Number(n) || 0).toString(16).padStart(4, '0'); }
  function _usbId(d){ return 'usb:' + _hex4(d.vendorId) + ':' + _hex4(d.productId); }
  function _usbName(d){ return String(d.productName || d.manufacturerName || ('USB printer ' + _hex4(d.vendorId) + ':' + _hex4(d.productId))).trim(); }
  // The interface + bulk OUT endpoint to print to (security L2): ONLY a USB printer-class
  // (7) interface; a vendor-specific (0xFF) one only when the maker is in USB_VENDORS AND the
  // device has no printer-class interface at all. Anything else -> null (NO_USB_OUT), also
  // for devices picked with "Show all USB devices". -> {iface, alt, ep, cls, claimed} | null
  function _pickUsbInterface(cfg, device){
    const list = [];
    ((cfg && cfg.interfaces) || []).forEach(itf => {
      const alts = (itf.alternates && itf.alternates.length) ? itf.alternates : (itf.alternate ? [itf.alternate] : []);
      alts.forEach(alt => list.push({itf, alt, cls: Number(alt.interfaceClass)}));
    });
    const hasPrinterClass = list.some(x => x.cls === USB_PRINTER_CLASS);
    const knownMaker = !!device && USB_VENDORS.includes(Number(device.vendorId));
    let best = null, bestScore = -1;
    list.forEach(({itf, alt, cls}) => {
      const ok = cls === USB_PRINTER_CLASS || (cls === 0xFF && knownMaker && !hasPrinterClass);
      if(!ok) return;
      const ep = (alt.endpoints || []).find(e => e.direction === 'out' && e.type === 'bulk');
      if(!ep) return;
      const score = (cls === USB_PRINTER_CLASS ? 20 : 10) + (Number(alt.alternateSetting) === 0 ? 1 : 0);
      if(score > bestScore){ bestScore = score; best = {iface: itf.interfaceNumber, alt: Number(alt.alternateSetting) || 0, ep: ep.endpointNumber, cls, claimed: !!itf.claimed}; }
    });
    return best;
  }
  async function _openUsb(device){
    conn.connecting = true; emit('status');
    try{
      if(!device.opened) await device.open();
      if(!device.configuration){
        const cv = (device.configurations && device.configurations[0] && device.configurations[0].configurationValue) || 1;
        await device.selectConfiguration(cv);
      }
      const pick = _pickUsbInterface(device.configuration, device);
      if(!pick){ try{ await device.close(); }catch(e){} throw fail('NO_USB_OUT'); }
      if(!pick.claimed){
        try{ await device.claimInterface(pick.iface); }
        catch(e){ try{ await device.close(); }catch(x){} const err = fail('USB_BUSY'); err.cause = e; err.detail = String((e && e.message) || e); throw err; }
      }
      if(pick.alt){ try{ await device.selectAlternateInterface(pick.iface, pick.alt); }catch(e){} }
      Object.assign(conn, {type: 'usb', usb: device, usbInterface: pick.iface, usbEndpoint: pick.ep, connected: true, name: _usbName(device),
        device: null, characteristic: null, port: null});
      lastError = ''; usbNeedsTap = false; reconnectError = null;
      return true;
    } finally { conn.connecting = false; emit('status'); }
  }
  function _usbRemembered(){ return !!(current.usb_vendor_id || current.usb_product_id); }
  function _usbMatches(d){ return !!d && _usbRemembered() && d.vendorId === current.usb_vendor_id && d.productId === current.usb_product_id; }
  function _pickRemembered(list){
    const same = (list || []).filter(_usbMatches);
    return same.find(d => current.usb_serial && d.serialNumber === current.usb_serial) || same[0] || null;
  }
  async function _rememberUsb(device){
    await saveSettings({connection: 'usb', device_id: _usbId(device), device_name: _usbName(device),
      usb_vendor_id: device.vendorId || 0, usb_product_id: device.productId || 0, usb_serial: device.serialNumber || ''});
  }
  // Opens the browser's USB chooser (must run from a tap). opts.showAll: list every USB device.
  async function chooseUsb(opts){
    opts = opts || {};
    const s = support();
    if(!s.usb){ const m = s.apple_mobile || s.safari || !s.secure ? supportText() : 'This browser can\'t connect to USB printers. Use Google Chrome on this computer.'; setError(m); throw Object.assign(new Error(m), {friendly: m, code: 'NOT_SUPPORTED'}); }
    try{
      const device = await _nav().usb.requestDevice({filters: opts.showAll ? [] : USB_FILTERS});
      await _disconnectQuiet();
      try{ await _openUsb(device); }
      catch(e){ if(_code(e) === 'USB_BUSY') await _rememberUsb(device); throw e; }   // allowed: keep it, so it reconnects once free
      await _rememberUsb(device);
      return status();
    }catch(e){
      const m = friendly(e, 'usb'); setError(m);
      throw Object.assign(e instanceof Error ? e : new Error(m), {friendly: m});
    }
  }
  // Quiet reconnect to the remembered USB printer: getDevices() only lists printers this app
  // was allowed before, so no chooser ever opens.
  async function _reconnectUsb(){
    if(conn.type === 'usb' && conn.usb && conn.usb.opened && conn.connected) return true;
    const usb = _nav().usb;
    if(!usb || typeof usb.getDevices !== 'function') return false;
    let list = [];
    try{ list = await usb.getDevices(); }catch(e){ return false; }
    const dev = _pickRemembered(list);
    if(!dev){ usbNeedsTap = _usbRemembered(); emit('status'); return false; }
    try{ return await _openUsb(dev); }
    catch(e){
      reconnectError = e;
      lastError = friendly(e, 'usb'); emit('status');
      return false;
    }
  }
  // A USB write error as our own error: unplugged / switched off -> code USB_LOST.
  function _usbErr(e){
    if(_code(e)) return e;
    const name = e && e.name;
    const err = new Error(String((e && e.message) || e || 'USB write failed'));
    err.name = name || 'Error'; err.cause = e;
    if(name === 'NotFoundError' || name === 'NetworkError' || name === 'InvalidStateError') err.code = 'USB_LOST';
    return err;
  }
  async function _writeUsb(bytes){
    const d = conn.usb, ep = conn.usbEndpoint;
    if(!d || !d.opened) throw fail('NOT_CONNECTED');
    const size = current.usb_chunk || 1024;
    let off = 0, stalls = 0, empty = 0;
    while(off < bytes.length){
      const part = bytes.subarray ? bytes.subarray(off, off + size) : bytes.slice(off, off + size);
      let res;
      try{
        res = await Promise.race([d.transferOut(ep, part), new Promise((_, rej) => setTimeout(() => rej(fail('USB_TIMEOUT')), USB_TIMEOUT_MS))]);
      }catch(e){
        const err = _usbErr(e);
        if(err.code === 'USB_LOST'){ conn.connected = false; }
        throw _withWritten(err, off);
      }
      if(res && res.status === 'stall'){
        if(++stalls > 2) throw _withWritten(Object.assign(fail('USB_TIMEOUT'), {message: 'endpoint stalled'}), off);
        try{ await d.clearHalt('out', ep); }catch(e){}
        continue;
      }
      const n = res && typeof res.bytesWritten === 'number' ? res.bytesWritten : part.length;
      if(n <= 0){ if(++empty > 3) throw _withWritten(fail('USB_TIMEOUT'), off); continue; }
      off += n;
    }
  }
  function _onUsbConnect(e){
    const d = e && e.device;
    if(current.connection !== 'usb' || !_usbMatches(d)) return;
    if(conn.type === 'usb' && conn.connected && conn.usb && conn.usb.opened) return;
    setTimeout(() => { _openUsb(d).catch(err => { reconnectError = err; lastError = friendly(err, 'usb'); emit('status'); }); }, USB_PLUG_DELAY_MS);
  }
  function _onUsbDisconnect(e){
    const d = e && e.device;
    if(conn.type === 'usb' && (!d || d === conn.usb)){ conn.connected = false; conn.usb = null; emit('status'); }
  }

  /* ------------------------------------------------------------------
     Connect / print
     ------------------------------------------------------------------ */
  async function _disconnectQuiet(){
    try{ if(conn.type === 'bluetooth' && conn.device && conn.device.gatt && conn.device.gatt.connected) conn.device.gatt.disconnect(); }catch(e){}
    try{ if(conn.type === 'serial' && conn.port && conn.port.writable) await conn.port.close(); }catch(e){}
    try{
      if(conn.type === 'usb' && conn.usb && conn.usb.opened){
        try{ if(conn.usbInterface !== null && conn.usbInterface !== undefined) await conn.usb.releaseInterface(conn.usbInterface); }catch(e){}
        await conn.usb.close();
      }
    }catch(e){}
    Object.assign(conn, {type: null, connected: false, device: null, characteristic: null, port: null, name: '', usb: null, usbInterface: null, usbEndpoint: null});
  }
  // Reconnects to the remembered printer without asking (page load / before printing).
  // Returns true when connected. Never opens a chooser.
  async function reconnect(){
    reconnectError = null;
    if(current.connection === 'usb' && support().usb) return !!(await _reconnectUsb());
    if(current.connection === 'bluetooth' && support().bluetooth) return !!(await _reconnectBle());
    if(current.connection === 'serial' && support().serial) return !!(await _reconnectSerial());
    return false;
  }
  async function disconnect(){ await _disconnectQuiet(); emit('status'); }
  // Forget the printer on this counter.
  async function forget(){
    const dev = conn.device || conn.usb;
    await _disconnectQuiet();
    try{ if(dev && typeof dev.forget === 'function') await dev.forget(); }catch(e){}
    await saveSettings({connection: 'dialog', device_id: '', device_name: '', usb_vendor_id: 0, usb_product_id: 0, usb_serial: ''});
    usbNeedsTap = false; reconnectError = null;
    lastError = ''; emit('status');
  }
  let listening = false;
  // Load settings and reconnect quietly. Call once when the counter starts.
  async function init(){
    await loadSettings();
    const n = _nav();
    if(!listening){
      listening = true;
      if(n.serial && typeof n.serial.addEventListener === 'function'){
        try{ n.serial.addEventListener('disconnect', (e) => { if(conn.type === 'serial' && (!e || e.target === conn.port || e.port === conn.port)){ conn.connected = false; conn.port = null; emit('status'); } }); }catch(e){}
      }
      if(n.usb && typeof n.usb.addEventListener === 'function'){
        try{ n.usb.addEventListener('connect', _onUsbConnect); n.usb.addEventListener('disconnect', _onUsbDisconnect); }catch(e){}
      }
    }
    reconnect().catch(() => false);
    return status();
  }
  function directMode(){
    return (current.connection === 'usb' && support().usb) || (current.connection === 'bluetooth' && support().bluetooth) || (current.connection === 'serial' && support().serial);
  }

  // Errors from a print job carry how many bytes reached the printer before it stopped
  // (e.written; 0 = nothing was sent, so nothing came out of the printer).
  function _withWritten(e, n){
    if(!(e instanceof Error)) e = new Error(String(e || 'write failed'));
    try{ e.written = Math.max(0, n | 0); }catch(x){}
    return e;
  }
  let queue = Promise.resolve();
  // Send raw bytes. One job at a time (receipt, ticket, report never mix on the paper);
  // each job gets its own result / error. Reconnects quietly first.
  function sendBytes(bytes){
    pending++; emit('status');
    const job = queue.then(async () => {
      busy = true; emit('status');
      try{
        if(!conn.connected && !(await reconnect())) throw (_code(reconnectError) ? reconnectError : fail('NOT_CONNECTED'));
        if(conn.type === 'usb') await _writeUsb(bytes);
        else if(conn.type === 'bluetooth') await _writeBle(bytes);
        else if(conn.type === 'serial') await _writeSerial(bytes);
        else throw fail('NOT_CONNECTED');
        lastPrintedAt = new Date().toISOString(); lastError = '';
        emit('printed', {at: lastPrintedAt, bytes: bytes.length});
        return true;
      } catch(e){
        e = _withWritten(e, e && e.written);
        e.partial = e.written > 0;
        throw e;
      } finally { busy = false; pending = Math.max(0, pending - 1); emit('status'); }
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
  // One print job for printReceipt / printTicket / printShiftReport.
  //   makeBytes(): the ESC/POS bytes; openDialog(): the print screen (used ONLY when
  //   opts.fallback === true). Answer: {ok, method, partial, error, code, message, written}
  //   - no printer set up / not reachable: {ok:false, error:'NOT_CONNECTED', code:'NOT_CONNECTED', message}
  //   - failed before any byte for another reason: error = message (plain words), code = e.g. USB_BUSY
  //   - stopped part-way: {ok:false, partial:true, code:'PARTIAL', error: message} (never the print screen: it would print twice)
  async function _job(makeBytes, openDialog, opts){
    opts = opts || {};
    const allowDialog = opts.fallback === true && typeof openDialog === 'function';
    if(!directMode()){
      const m = friendly(fail('NOT_CONNECTED'), current.connection === 'dialog' ? '' : current.connection);
      if(allowDialog){ openDialog(); return {ok: true, partial: false, method: 'dialog', written: 0, bytes: null}; }
      return {ok: false, partial: false, method: 'none', error: 'NOT_CONNECTED', code: 'NOT_CONNECTED', message: current.connection === 'dialog' || directSupported() ? m : supportText(), written: 0, bytes: null};
    }
    const bytes = makeBytes();
    try{
      await sendBytes(bytes);
      return {ok: true, partial: false, method: conn.type, written: bytes.length, bytes};
    }catch(e){
      const written = (e && e.written) || 0;
      const partial = written > 0;
      const code = partial ? 'PARTIAL' : (_code(e) || 'PRINT_FAILED');
      const m = (partial ? 'Printing stopped part-way. ' : '') + friendly(e, current.connection);
      setError(m);
      const base = {ok: false, partial, code, message: m, written, bytes};
      if(partial) return Object.assign(base, {method: current.connection, error: m});
      const error = code === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : m;
      if(allowDialog){ openDialog(); return Object.assign(base, {method: 'dialog', error}); }
      return Object.assign(base, {method: current.connection, error});
    }
  }
  function directSupported(){ const s = support(); return s.usb || s.bluetooth || s.serial; }
  // Print a receipt. Same arguments as receiptHtml, plus the extra opts of receiptBytes, and:
  //   fallback: true -> only then may the print screen open (no printer, or it failed before
  //                     any paper came out). Nothing else ever opens it (release 1.4).
  //   auto: kept for older callers (same as the default now).
  // Returns {ok, method: 'usb'|'bluetooth'|'serial'|'dialog'|'none', partial, error, code, message, drawer_kick_sent}.
  //   No printer: {ok:false, method:'none', error:'NOT_CONNECTED', message}, at once.
  //   Fails PART-WAY: {ok:false, partial:true, ...}; the counter offers "Print again" /
  //     "Use print screen" (printReceipt(..., {fallback:true, openDrawer:false})).
  //   drawer_kick_sent: the cash drawer command reached the printer (the drawer opened).
  async function printReceipt(sale, items, payments, opts){
    opts = opts || {};
    const res = await _job(() => receiptBytes(sale, items, payments, opts), () => _dialog(sale, items, payments, opts), opts);
    res.drawer_kick_sent = !!res.bytes && _drawerSent(res.bytes, res.written);
    delete res.bytes;
    return res;
  }
  // Barista order ticket (no prices). order + opts: see ticketBytes. opts.fallback === true
  // allows the print screen (opts.html, else a plain text page). Same answers as printReceipt.
  async function printTicket(order, opts){
    opts = opts || {};
    const res = await _job(() => ticketBytes(order, opts), () => _openHtml(opts.html, () => textHtml('Order ' + ((order && (order.order_number || order.transaction_number)) || ''), ticketBytes(order, opts), current.paper_width)), opts);
    delete res.bytes;
    return res;
  }
  // X / Z shift report. report + opts: see shiftReportBytes. opts.fallback === true allows the
  // print screen (opts.html, e.g. the counter's shiftReportHtml, else a plain text page).
  async function printShiftReport(report, opts){
    opts = opts || {};
    const res = await _job(() => shiftReportBytes(report, opts), () => _openHtml(opts.html, () => textHtml(_shiftInput(report, opts).isX ? 'X report' : 'Z report', shiftReportBytes(report, opts), current.paper_width)), opts);
    delete res.bytes;
    return res;
  }
  function _openHtml(html, make){
    if(typeof openPrintWindow !== 'function') return null;
    return openPrintWindow(html || make(), true);
  }
  // A short test slip. opts.openDrawer: also kick the drawer (the counter makes that
  // manager-only and writes the audit entry). Returns
  //   {ok, method, partial, error?, drawer_requested, drawer_kick_sent, printer_name, at}
  //   drawer_kick_sent: true when the drawer command reached the printer (even if the slip
  //   then stopped part-way), so the counter knows to write "Cash drawer opened (test slip)".
  async function printTest(opts){
    opts = opts || {};
    const base = {drawer_requested: !!opts.openDrawer, drawer_kick_sent: false, printer_name: state_device_name(), at: new Date().toISOString()};
    if(!directMode()) return Object.assign(base, {ok: false, partial: false, method: current.connection, code: 'NOT_CONNECTED', error: current.connection === 'dialog' ? 'Choose a Bluetooth printer, a USB printer or a printer port first.' : supportText()});
    const bytes = testBytes(opts);
    try{
      await sendBytes(bytes);
      return Object.assign(base, {ok: true, partial: false, method: conn.type, printer_name: state_device_name(), drawer_kick_sent: !!opts.openDrawer && _drawerSent(bytes, bytes.length)});
    }catch(e){
      const written = (e && e.written) || 0;
      const m = (written > 0 ? 'Printing stopped part-way. ' : '') + friendly(e, current.connection); setError(m);
      return Object.assign(base, {ok: false, partial: written > 0, method: current.connection, code: written > 0 ? 'PARTIAL' : (_code(e) || 'PRINT_FAILED'), error: m, drawer_kick_sent: !!opts.openDrawer && _drawerSent(bytes, written)});
    }
  }

  return {
    // setup
    init, loadSettings, settings, saveSettings, DEFAULTS: Object.freeze(Object.assign({}, DEFAULTS)),
    // connection
    choose, chooseSerial, chooseUsb, reconnect, disconnect, forget, support, supportText, helpSteps, status, on, off,
    isDirect: directMode, browserName,
    // printing (one queue)
    printReceipt, printTicket, printShiftReport, printTest, sendBytes, receiptBytes, ticketBytes, shiftReportBytes, testBytes, textHtml,
    // building blocks (pure; tests and other tickets)
    EscPos, describe, chunk, toAscii, money, wrap, leftRight, CHARS,
    BLE_SERVICES, BLE_FILTER_SERVICES, BLE_NAME_PREFIXES, USB_FILTERS, USB_VENDORS, cleanSettings,
  };
})();
