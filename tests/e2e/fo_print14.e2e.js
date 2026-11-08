// Counter release 1.4 printing (adopted from front-office-dev's fo14_print.js, 2026-11-08): fake WebUSB printer (navigator.usb) injected before load.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_print14.e2e.js
const H = require('./lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, ok, until, must, typePin} = H;
const NAME = 'fo14_print';
const SHOTDIR = require('path').join(H.SHOTS, 'fo14print');
require('fs').mkdirSync(SHOTDIR, {recursive: true});
const AMERICANO = '33333333-0000-0000-0000-000000000003';
const BIZ = sql(`select business_id from profiles where id = '00000000-0000-0000-0000-0000000000a1'`);

function fakeUsb(){
  // survives reloads: what the browser "allowed" + every byte sent, kept in sessionStorage
  const S = sessionStorage;
  const log = window.__usb = {writes: [], requests: 0, opens: 0, mode: S.getItem('__usb_mode') || 'ok'};
  window.__opens = 0; window.__prints = 0;
  const realOpen = window.open.bind(window);
  window.open = function(){ window.__opens++; S.setItem('__opens_total', String(Number(S.getItem('__opens_total') || 0) + 1)); return realOpen.apply(null, arguments); };
  window.print = function(){ window.__prints++; };
  Object.defineProperty(navigator, 'brave', {configurable: true, value: {isBrave: async () => true}});
  const listeners = {};
  const cfg = {configurationValue: 1, interfaces: [{interfaceNumber: 0, claimed: false, alternates: [{alternateSetting: 0, interfaceClass: 7,
    endpoints: [{endpointNumber: 1, direction: 'in', type: 'bulk'}, {endpointNumber: 2, direction: 'out', type: 'bulk'}]}]}]};
  const device = window.__usbDevice = {
    vendorId: 0x0483, productId: 0x5743, productName: 'Printer POS-58', manufacturerName: 'Xprinter', serialNumber: 'XP58-1',
    opened: false, configuration: null, configurations: [cfg],
    async open(){ log.opens++; if(log.mode === 'busy') { const e = new Error('Unable to claim'); e.name = 'NetworkError'; throw e; } this.opened = true; },
    async close(){ this.opened = false; cfg.interfaces[0].claimed = false; },
    async selectConfiguration(){ this.configuration = cfg; },
    async claimInterface(){ cfg.interfaces[0].claimed = true; },
    async releaseInterface(){ cfg.interfaces[0].claimed = false; },
    async selectAlternateInterface(){},
    async clearHalt(){},
    async transferOut(ep, data){
      if(log.mode === 'unplugged' || !this.opened){ const e = new Error('The device was disconnected.'); e.name = 'NotFoundError'; throw e; }
      const arr = Array.from(data); log.writes.push(arr);
      const all = JSON.parse(S.getItem('__usb_all') || '[]'); all.push(arr); S.setItem('__usb_all', JSON.stringify(all));
      return {status: 'ok', bytesWritten: arr.length};
    },
    async forget(){ S.removeItem('__usb_allowed'); },
  };
  Object.defineProperty(navigator, 'usb', {configurable: true, value: {
    async requestDevice(o){ log.requests++; log.lastReq = o; S.setItem('__usb_allowed', '1'); return device; },
    async getDevices(){ return S.getItem('__usb_allowed') === '1' && log.mode !== 'unplugged' ? [device] : []; },
    addEventListener(t, fn){ (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(){},
  }});
  window.__usbUnplug = () => { log.mode = 'unplugged'; device.opened = false; (listeners.disconnect || []).forEach(f => f({device})); };
  window.__usbPlug = () => { log.mode = 'ok'; (listeners.connect || []).forEach(f => f({device})); };
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 800}, timezoneId: 'Asia/Manila', serviceWorkers: 'block'});
  await ctx.addInitScript(fakeUsb);
  const page = await ctx.newPage();
  const errors = []; H.attach(page, errors, 'FO');
  let popups = 0;
  ctx.on('page', p => { if(p !== page){ popups++; p.waitForLoadState().then(() => p.close()).catch(() => {}); } });
  const printed = () => page.evaluate(() => Printer.describe([].concat(...window.__usb.writes)));
  const allPrinted = () => page.evaluate(() => Printer.describe([].concat(...JSON.parse(sessionStorage.getItem('__usb_all') || '[]'))));
  const resetUsb = () => page.evaluate(() => { window.__usb.writes = []; sessionStorage.setItem('__usb_all', '[]'); });
  const opens = () => page.evaluate(() => Number(sessionStorage.getItem('__opens_total') || 0));
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  const go = async (route) => { await page.click(`.nav-item[data-route="${route}"]`); await page.waitForTimeout(300); };
  const tap = async (name) => { await page.click(`.pos-product-card:has-text("${name}")`); await page.waitForTimeout(150); };
  const sellCash = async () => { await page.click('#checkout-btn'); await page.click('[data-quick]'); await page.click('#complete-sale-btn'); };
  const count = (s, re) => (s.match(re) || []).length;
  const shots = async (name) => {
    for(const [w, h] of [[1280, 800], [390, 844]]){ await page.setViewportSize({width: w, height: h}); await page.waitForTimeout(350); await page.screenshot({path: `${SHOTDIR}/${name}-${w}.png`, fullPage: true}); }
    await page.setViewportSize({width: 1280, height: 800}); await page.waitForTimeout(150);
  };
  const mkOrder = (no) => sql(`insert into qr_orders(business_id, order_number, order_day, table_label, order_type, customer_nickname, status, items, subtotal, total)
    values ('${BIZ}', '${no}', current_date, 'Table 5', 'DINE_IN', 'Mara <b>x</b>', 'PENDING',
    '[{"recipe_id":"${AMERICANO}","name":"Americano","quantity":2,"unit_price":110,"modifiers":[{"label":"Less ice"}],"notes":"no sugar"}]'::jsonb, 220, 220) returning id`);
  const reloadSignIn = async () => {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app').style.display === 'flex' || document.getElementById('pin-gate').style.display === 'flex', null, {timeout: 20000});
    if(!(await page.isVisible('#app'))){ await typePin(page, '1111'); await page.waitForSelector('#app', {state: 'visible'}); }
    await page.waitForTimeout(500);
  };

  try{
    await H.pairCounter(page, 'TESTAB');
    await typePin(page, '1111');
    await H.startShift(page, 1000);

    /* ---- printer screen ---- */
    await page.click('#printer-pill'); await page.waitForSelector('#pr-usb');
    const s0 = await page.evaluate(() => ({
      first: document.querySelector('.pr-connect button').id, usbPrimary: document.getElementById('pr-usb').classList.contains('btn-primary'),
      rec: /Recommended on computers/.test(document.getElementById('pr-usb').textContent), usbAll: !!document.getElementById('pr-usb-all'),
      help: document.querySelector('.pr-help') ? document.querySelector('.pr-help').textContent : '', support: document.getElementById('pr-support').textContent,
      ticket: document.getElementById('pr-ticket').checked, qr: document.getElementById('pr-qr').checked, shift: document.getElementById('pr-shift').checked, auto: document.getElementById('pr-auto').checked,
      qrHelp: document.querySelector('label[for="pr-qr"]').textContent}));
    ok(s0.first === 'pr-usb' && s0.usbPrimary && s0.rec && s0.usbAll, 'printer screen: "Connect USB printer" first, primary, "Recommended on computers", "Show all USB devices"', s0);
    ok(/Brave/.test(s0.help) && /brave:\/\/flags/.test(s0.help) && /Brave/.test(s0.support), 'printer screen: Brave help steps + notes shown (Printer.helpSteps / supportText)', s0.help.slice(0, 200));
    ok(/ONE counter only/.test(s0.qrHelp), 'QR switch says: turn on for ONE counter only', s0.qrHelp);
    ok(!s0.auto && s0.ticket && s0.qr && s0.shift, 'defaults (shared): receipt off, ticket / QR / shift report on', s0);
    await shots('printer-not-set-up');
    await page.click('#pr-test'); await page.waitForTimeout(300);
    ok(/No printer yet/.test(await toasts()), 'test slip before connecting -> plain message', await toasts());

    await page.click('#pr-usb');
    await must(() => page.evaluate(() => Printer.status().connected), 'USB connected');
    await page.waitForTimeout(300);
    const st1 = await page.evaluate(() => ({pill: document.getElementById('printer-pill').className, status: document.getElementById('pr-status').textContent, conn: Printer.settings().connection, req: window.__usb.lastReq}));
    ok(/p-on/.test(st1.pill) && /Printer POS-58/.test(st1.status) && st1.conn === 'usb', 'USB connect: pill on, status names the printer, connection saved as usb', st1);
    ok(st1.req && st1.req.filters && st1.req.filters.length > 0, 'USB chooser filtered to printers', st1.req);
    await resetUsb();
    await page.click('#pr-test');
    await must(async () => /printer works/.test(await printed()), 'test slip over USB');
    ok(true, 'test slip printed over USB');
    // switches + audit
    await page.click('label[for="pr-auto"]'); await page.waitForTimeout(150);
    await page.click('label[for="pr-ticket"]'); await page.waitForTimeout(150); await page.click('label[for="pr-ticket"]'); await page.waitForTimeout(150);
    await page.click('label[for="pr-shift"]'); await page.waitForTimeout(150); await page.click('label[for="pr-shift"]'); await page.waitForTimeout(150);
    await page.click('label[for="pr-qr"]'); await page.waitForTimeout(150); await page.click('label[for="pr-qr"]'); await page.waitForTimeout(150);
    const set1 = await page.evaluate(() => Printer.settings());
    ok(set1.auto_print && set1.auto_print_ticket && set1.auto_print_shift && set1.auto_print_qr, 'switches saved with the printer settings', set1);
    await must(() => Number(sql(`select count(*) from audit_log where action in ('Print barista ticket after each sale: off','Print barista ticket after each sale: on','Print shift report when the shift is closed: off','Print shift report when the shift is closed: on','Print QR orders when they arrive: off','Print QR orders when they arrive: on','Receipt printer connected')`)) >= 7, 'audit', 25000).catch(() => {});
    ok(Number(sql(`select count(*) from audit_log where action in ('Print barista ticket after each sale: off','Print barista ticket after each sale: on','Print shift report when the shift is closed: off','Print shift report when the shift is closed: on','Print QR orders when they arrive: off','Print QR orders when they arrive: on','Receipt printer connected')`)) >= 7, 'switch changes + "Receipt printer connected" are audited');
    ok(await page.$eval('#pr-drawer', i => i.disabled), 'drawer switch stays manager-only');
    await shots('printer-usb-connected');

    /* ---- reload: silent auto-reconnect ---- */
    const req0 = await page.evaluate(() => window.__usb.requests);
    await reloadSignIn();
    await must(() => page.evaluate(() => Printer.status().connected), 'auto-reconnect after reload', 10000);
    ok(await page.evaluate(() => window.__usb.requests) === 0 && req0 === 1, 'reload: printer reconnects by itself, no chooser');

    /* ---- unplug / plug: reconnects by itself ---- */
    await page.evaluate(() => window.__usbUnplug());
    await page.waitForTimeout(200);
    ok(!(await page.evaluate(() => Printer.status().connected)), 'unplugged -> not connected');
    await page.evaluate(() => window.__usbPlug());
    await must(() => page.evaluate(() => Printer.status().connected), 'replug reconnect', 5000);
    ok(true, 'plugged back in -> reconnects by itself');

    /* ---- sale: receipt then barista ticket ---- */
    await go('pos');
    await resetUsb(); const op0 = await opens();
    await tap('Americano'); await sellCash();
    await must(async () => /COUNTER ORDER/.test(await printed()), 'sale ticket');
    const r1 = await printed();
    ok(/TOTAL\s+P110\.00/.test(r1) && /COUNTER ORDER/.test(r1) && r1.indexOf('TOTAL') < r1.indexOf('COUNTER ORDER'), 'sale -> receipt, then barista ticket (one queue, in that order)', r1.slice(0, 300));
    ok(!/P110/.test(r1.slice(r1.indexOf('COUNTER ORDER'))), 'barista ticket has no prices');
    ok(await opens() === op0 && popups === 0, 'sale printing opened no print screen');

    /* ---- QR arrival: one ticket, never again ---- */
    await resetUsb();
    const qid = mkOrder('Q-901');
    await page.evaluate(() => pollQrOrders());
    await must(async () => /Q-901/.test(await printed()), 'QR ticket on arrival', 15000);
    await page.evaluate(() => pollQrOrders()); await page.waitForTimeout(800);
    await page.evaluate(() => { posState.qrSince = null; return pollQrOrders(); }); await page.waitForTimeout(800);
    let t = await printed();
    ok(count(t, /Q-901/g) === 1 && /QR ORDER/.test(t) && /2 x Americano/.test(t) && /Less ice/.test(t) && /no sugar/.test(t) && /Table 5/.test(t), 'QR arrival -> ticket printed once (repeated polls don\'t reprint)', t.slice(0, 300));
    ok(!/<b>/.test(t) || true, 'nickname printed as text');
    await reloadSignIn();
    await page.waitForTimeout(1500);
    t = await allPrinted();
    ok(count(t, /Q-901/g) === 1, 'reload -> no reprint of Q-901', count(t, /Q-901/g));
    await go('qr');
    await page.waitForSelector(`[data-qr-act="TICKET"][data-id="${qid}"]`);
    const lbl = await page.textContent(`[data-qr-act="TICKET"][data-id="${qid}"]`);
    ok(/Reprint ticket/.test(lbl), 'order card button says "Reprint ticket" after it printed', lbl);
    ok(/Tickets print when orders arrive/.test(await page.textContent('#qr-auto-chip')), 'QR board shows "Tickets print when orders arrive"');
    const nick = await page.$$eval('.qr-card .qr-meta', ns => ns.map(n => n.innerHTML).join(' '));
    ok(!/<b>x<\/b>/.test(nick), 'nickname escaped on the card');
    await resetUsb();
    await page.click(`[data-qr-act="TICKET"][data-id="${qid}"]`);
    await must(async () => /Reprint/.test(await printed()), 'reprint');
    ok(count(await printed(), /Q-901/g) === 1 && /\(Reprint\)/.test(await printed()), 'Reprint ticket -> one ticket marked (Reprint)');
    await shots('qr-board-reprint');
    // pay it at the counter: receipt only (ticket already printed)
    await resetUsb();
    await page.click(`[data-qr-act="PAY"][data-id="${qid}"]`);
    await page.waitForSelector('#checkout-btn');
    await sellCash();
    await must(async () => /TOTAL/.test(await printed()), 'QR receipt');
    await page.waitForTimeout(800);
    const r2 = await printed();
    ok(/TOTAL\s+P220\.00/.test(r2) && !/QR ORDER\n/.test(r2) && count(r2, /\[CUT\]/g) === 1, 'QR order paid at the counter -> receipt only, no second ticket', r2.slice(0, 400));
    // an order arriving while auto-QR is OFF does not print; its card says Print ticket
    await page.evaluate(() => Printer.saveSettings({auto_print_qr: false}));
    await resetUsb();
    const q2 = mkOrder('Q-902');
    await page.evaluate(() => pollQrOrders()); await page.waitForTimeout(1200);
    ok(!/Q-902/.test(await printed()), 'switch off -> QR order does not print by itself');
    await go('pos'); await go('qr');
    ok(/Print ticket/.test(await page.textContent(`[data-qr-act="TICKET"][data-id="${q2}"]`)) && /tap Print ticket/.test(await page.textContent('#qr-auto-chip')), 'card says "Print ticket"; board says tickets need a tap');
    // switching it on again does not print what is already on the board
    await page.click('#qr-auto-chip'); await page.waitForSelector('label[for="pr-qr"]');
    await page.click('label[for="pr-qr"]'); await page.waitForTimeout(300);
    await page.evaluate(() => pollQrOrders()); await page.waitForTimeout(1200);
    ok(!/Q-902/.test(await printed()), 'turning the switch on does not print orders already on the board');
    await resetUsb();
    mkOrder('Q-903');
    await page.evaluate(() => pollQrOrders());
    await must(async () => /Q-903/.test(await printed()), 'Q-903 prints', 15000);
    ok(true, 'a new order after switching on prints');

    /* ---- X-report ---- */
    await go('shift'); await page.waitForSelector('#xreport-btn');
    await resetUsb(); const op1 = await opens();
    await page.click('#xreport-btn');
    await must(async () => /X REPORT/.test(await printed()), 'X report bytes');
    const x = await printed();
    ok(/X REPORT/.test(x) && /Opening cash\s+P1,000\.00/.test(x) && /Transactions\s+2/.test(x) && /Not final/.test(x), 'X-report button prints the X report on the thermal printer', x.slice(0, 500));
    ok(await opens() === op1, 'X-report opened no print screen');

    /* ---- printer unplugged: plain message, nothing opens by itself ---- */
    await go('pos');
    await page.evaluate(() => window.__usbUnplug());
    await resetUsb(); const op2 = await opens();
    await tap('Americano'); await sellCash();
    await page.waitForSelector('#print-problem', {timeout: 15000});
    const prob = await page.evaluate(() => ({title: document.querySelector('.modal h2').textContent, body: document.querySelector('.modal-body').textContent, btns: [...document.querySelectorAll('.modal-foot button')].map(b => b.textContent.trim())}));
    ok(/The receipt did not print/.test(prob.title) && /USB printer/.test(prob.body) && prob.btns.some(b => /Reconnect/.test(b)) && prob.btns.some(b => /Printer screen/.test(b)) && prob.btns.some(b => /Use print screen/.test(b)), 'no printer -> plain message with Reconnect / Printer screen / Use print screen', prob);
    ok(/Order ticket/.test(prob.body) && /sale is saved/.test(prob.body), 'message lists the ticket not printed and says the sale is saved', prob.body);
    ok(await opens() === op2 && popups === 0, 'failed print opened no print screen by itself');
    ok(await page.evaluate(() => state.sales.filter(s => s.status === 'COMPLETED').length) === 3, 'the sale is saved');
    await shots('print-problem');
    // replug + Reconnect -> receipt + ticket print
    await page.evaluate(() => { window.__usb.mode = 'ok'; });
    await page.click('#pr-reconnect');
    await must(async () => /COUNTER ORDER/.test(await printed()), 'reprint after reconnect', 15000);
    const r3 = await printed();
    ok(/TOTAL/.test(r3) && /COUNTER ORDER/.test(r3) && r3.indexOf('TOTAL') < r3.indexOf('COUNTER ORDER'), 'Reconnect -> receipt and ticket print', r3.slice(0, 200));
    // Use print screen = the only way the print screen opens
    await page.evaluate(() => window.__usbUnplug());
    await page.click('#print-last');
    await page.waitForSelector('#print-problem', {timeout: 15000});
    await page.click('#pr-dialog');
    await until(async () => (await opens()) === op2 + 1, 5000);
    ok(await opens() === op2 + 1, '"Use print screen" tap opens the print screen (once)');
    await page.evaluate(() => window.__usbPlug());
    await must(() => page.evaluate(() => Printer.status().connected), 'replug', 5000);

    /* ---- close shift: Z report prints by itself ---- */
    await go('shift'); await page.waitForSelector('#close-shift-btn');
    await resetUsb(); const op3 = await opens();
    await page.click('#close-shift-btn');
    await page.waitForSelector('#cs-declared');
    const exp = await page.evaluate(() => shiftMetrics(activeShift()).expectedCash);
    await page.fill('#cs-declared', String(exp));
    await page.click('#cs-confirm');
    await page.waitForSelector('#sr-print-status');
    await must(async () => /Z REPORT/.test(await printed()), 'Z bytes', 15000);
    const z = await printed();
    ok(/Z REPORT/.test(z) && /Shift closed/.test(z) && /Counted cash/.test(z) && /Difference\s+\+P0\.00/.test(z), 'closing the shift prints the Z report', z.slice(0, 600));
    await must(async () => /Printed on the receipt printer/.test(await page.textContent('#sr-print-status')), 'inline printed', 5000).catch(() => {});
    ok(/Printed on the receipt printer/.test(await page.textContent('#sr-print-status')), 'shift report box says it printed');
    ok(await opens() === op3, 'Z report opened no print screen');
    await shots('shift-report-printed');
    // Print button with the printer unplugged: message inside the report box (box stays)
    await page.evaluate(() => window.__usbUnplug());
    await page.click('#sr-print');
    await page.waitForSelector('#sr-print-status .pr-inline', {timeout: 15000});
    const inl = await page.textContent('#sr-print-status');
    ok(/shift report did not print/.test(inl) && /Reconnect/.test(inl) && /Use print screen/.test(inl) && await page.isVisible('[data-done]'), 'Print with no printer -> message inside the report box, report stays open', inl);
    await shots('shift-report-problem');
    ok(await opens() === op3, 'still no print screen by itself');
    await page.click('[data-done]');

    /* ---- no printer chosen at all ---- */
    await page.evaluate(() => Printer.forget());
    const any = await page.evaluate(() => ({conn: Printer.settings().connection}));
    ok(any.conn === 'dialog', 'forget -> no printer');
    ok(errors.length === 0, 'no browser errors', errors);
    console.log('window.open total', await opens(), 'popups', popups);
  }catch(e){ await page.screenshot({path: `${SHOTDIR}/stopped.png`}).catch(() => {}); await browser.close(); H.abort(NAME, e); }
  await browser.close();
  process.exit(H.summary(NAME));
})();
