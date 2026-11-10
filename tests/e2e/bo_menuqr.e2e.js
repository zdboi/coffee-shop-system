// Back Office release 1.4.2: Settings -> Menu link -> QR code (adopted from back-office-dev's bo142-menuqr.e2e.js, 2026-11-10).
// The PNG / SVG / on-screen / printed QR codes are decoded with OpenCV (tests/tools/qr_decode.py) and must give the exact link.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo_menuqr.e2e.js
const path = require('path'), fs = require('fs'), {execFileSync} = require('child_process');
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const qrcode = require(path.join(__dirname, '..', '..', 'cccc', 'shared', 'vendor', 'qrcode.js'));
const {ok, sql, one} = H;
const SH = path.join(H.SHOTS, 'bo142') + '/'; fs.mkdirSync(SH, {recursive: true});
const decode = (f, scale) => execFileSync('python3', ['-I', path.join(__dirname, '..', 'tools', 'qr_decode.py'), f].concat(scale ? [String(scale)] : []), {encoding: 'utf8'}).trim().split('|');
const SHORT = 'https://zdboi.github.io/coffee-shop-system/menu/';
function nodeMatrixPath(link){ const q = qrcode(0, 'Q'); q.addData(link); q.make(); let d = ''; const n = q.getModuleCount();
  for(let r = 0; r < n; r++) for(let c = 0; c < n; c++) if(q.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`; return d; }
async function openTab(p){ await p.evaluate(() => navigate('settings')); await p.click('[data-tab="menu"]'); await p.waitForSelector('#ml-qr'); }
async function checkDownloads(p, link, tag){
  let [dl] = await Promise.all([p.waitForEvent('download'), p.click('#ml-qr-png')]);
  const png = SH + tag + '.png'; await dl.saveAs(png);
  ok(/menu-qr.*\.png$/.test(dl.suggestedFilename()), tag + ' png name', dl.suggestedFilename());
  const [wh, txt] = decode(png); const [w, h] = wh.split('x').map(Number);
  ok(w >= 1200 && w === h, tag + ' png >= 1200 square', wh);
  ok(txt === link, tag + ' PNG decodes to the exact link', txt);
  // quiet zone: corners + edge strip are white
  const px = await p.evaluate(async (link) => { const cv = menuQrCanvas(link); const g = cv.getContext('2d'); const n = menuQrMatrix(link).n + 8; const s = cv.width / n;
    const strip = g.getImageData(0, 0, cv.width, Math.floor(s * 4)).data; let dark = 0; for(let i = 0; i < strip.length; i += 4) if(strip[i] < 250) dark++;
    return {dark, s, int: Number.isInteger(s)}; }, link);
  ok(px.dark === 0 && px.int, tag + ' white quiet zone, whole pixels per square', px);
  [dl] = await Promise.all([p.waitForEvent('download'), p.click('#ml-qr-svg')]);
  const svgf = SH + tag + '.svg'; await dl.saveAs(svgf); const svg = fs.readFileSync(svgf, 'utf8');
  ok(/^<\?xml/.test(svg) && svg.includes(`d="${nodeMatrixPath(link)}"`), tag + ' SVG matrix = qrcode.js in node');
  // render the SVG to PNG in the browser and decode it too
  const b = await p.context().browser().newPage({viewport: {width: 1300, height: 1300}});
  await b.setContent(`<body style="margin:0">${svg.replace(/^<\?xml[^>]*>\n/, '')}</body>`); await b.screenshot({path: SH + tag + '-svg.png', clip: {x: 0, y: 0, width: 1200, height: 1200}}); await b.close();
  ok(decode(SH + tag + '-svg.png')[1] === link, tag + ' SVG decodes to the exact link');
  // on-screen
  await p.locator('#ml-qr-pic').screenshot({path: SH + tag + '-screen.png'});
  ok(decode(SH + tag + '-screen.png', 4)[1] === link, tag + ' on-screen QR decodes');
}
async function checkPrint(p, link, size, tag){
  await p.selectOption('#ml-qr-size', size);
  const [win] = await Promise.all([p.context().waitForEvent('page'), p.click('#ml-qr-print')]);
  const werr = []; H.attach(win, werr, 'PRINT');
  await win.waitForLoadState('load'); await win.setViewportSize({width: 900, height: 1300}); await win.waitForTimeout(400);
  const body = await win.textContent('body');
  ok(/scan for our menu/i.test(body), tag + ' heading');
  ok(body.includes(link.replace(/^https:\/\//, '')), tag + ' short link written');
  ok(!/Bienvenido/i.test(await win.content()), tag + ' no Bienvenido tagline');
  const cw = await win.$eval('.card', e => e.getBoundingClientRect().width);
  ok(Math.abs(cw - (size === 'A5' ? 148 : 105) * 96 / 25.4) < 2, tag + ' card width ' + size, cw);
  await win.locator('.card').screenshot({path: SH + tag + '-card.png'});
  ok(decode(SH + tag + '-card.png', 3)[1] === link, tag + ' printed card QR decodes', decode(SH + tag + '-card.png', 3));
  await win.screenshot({path: SH + tag + '-sheet.png', fullPage: true});
  ok(!werr.length, tag + ' print window clean', werr);
  await win.close();
}
(async () => {
  const biz = sql(`select id from businesses limit 1`);
  sql(`update settings set menu_public = false, public_code = 'cccc', theme = null, business_name = 'Cavite City Coffee Club'`);
  const browser = await chromium.launch(); const errors = [];
  const ctx = await browser.newContext({viewport: {width: 1280, height: 900}, acceptDownloads: true});
  const p = await ctx.newPage(); H.attach(p, errors, 'BO');
  await H.boLogin(p); await openTab(p);
  // off -> disabled
  ok(/Save and switch on the menu link first/.test(await p.textContent('#ml-qr')), 'off: plain note');
  ok(await p.isDisabled('#ml-qr-png') && await p.isDisabled('#ml-qr-svg') && await p.isDisabled('#ml-qr-print'), 'off: buttons disabled');
  ok(!(await p.$('#ml-qr-pic svg')), 'off: no QR drawn');
  await p.locator('#ml-card').screenshot({path: SH + 'bo142-off-1280.png'});
  // toggling the switch without saving keeps it disabled
  await p.click('#ml-card .switch'); ok(await p.isDisabled('#ml-qr-png'), 'unsaved switch: still disabled');
  await p.click('#ml-save'); await H.until(async () => /link is on/.test(await p.textContent('#toast-wrap')), 5000);
  await p.waitForSelector('#ml-qr-pic svg');
  ok(!(await p.isDisabled('#ml-qr-png')), 'on: enabled');
  ok((await p.textContent('#ml-qr-link')) === SHORT.replace('https://', ''), 'link text under the QR');
  await p.screenshot({path: SH + 'bo142-on-1280.png', fullPage: false});
  await p.locator('#ml-card').screenshot({path: SH + 'bo142-card-1280.png'});
  await checkDownloads(p, SHORT, 'bo142-short');
  await checkPrint(p, SHORT, 'A6', 'bo142-a6');
  await checkPrint(p, SHORT, 'A5', 'bo142-a5');
  const audits = Number(sql(`select count(*) from audit_log where action = 'Menu QR card printed'`));
  ok(audits === 2, 'print audited', audits);
  // other code -> long link
  await p.click('#ml-adv summary'); await p.fill('#ml-code', 'my-shop-2');
  await p.click('#ml-save');
  await p.click('[data-ok]');
  await H.until(async () => one(`select public_code from settings`).public_code === 'my-shop-2', 5000);
  await openTab(p);
  const LONG = 'https://zdboi.github.io/coffee-shop-system/cccc/menu/?shop=my-shop-2';
  ok(await p.inputValue('#ml-link') === LONG, 'long link');
  await checkDownloads(p, LONG, 'bo142-long');
  await checkPrint(p, LONG, 'A6', 'bo142-long-a6');
  // custom theme with a nasty business name -> escaped
  sql(`update settings set public_code = 'cccc', theme = 'CUSTOM', primary_color = '#2255aa', business_name = '<img src=x onerror=alert(1)>Shop'`);
  await p.reload(); await p.waitForSelector('#app', {state: 'visible'}); await openTab(p);
  await checkPrint(p, SHORT, 'A6', 'bo142-custom');
  // 390 wide
  await p.setViewportSize({width: 390, height: 844}); await p.locator('#ml-qr').scrollIntoViewIfNeeded();
  await p.locator('#ml-qr').screenshot({path: SH + 'bo142-390.png'});
  const ov = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(ov <= 0, '390: no sideways scroll', ov);
  // switch off -> disabled again
  sql(`update settings set menu_public = false, theme = null, business_name = 'Cavite City Coffee Club'`);
  await p.setViewportSize({width: 1280, height: 900}); await p.reload(); await p.waitForSelector('#app', {state: 'visible'}); await openTab(p);
  ok(await p.isDisabled('#ml-qr-print') && /switch on/.test(await p.textContent('#ml-qr')), 'off again: disabled');
  ok(!errors.length, 'no page errors', errors);
  await browser.close();
  process.exit(H.summary('bo_menuqr.e2e'));
})().catch(e => H.abort('bo_menuqr.e2e', e));
