// Back Office test helpers (on top of ../lib/h.js). Adopted from the back-office developer's helpers.js.
//   BO_VIEWPORT=1280x900 (default) or 768x1024 -> size of the Back Office window in every part.
const H = require('../lib/h');

function boViewport(){
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.BO_VIEWPORT || '1280x900');
  if(!m) throw new Error('BO_VIEWPORT must look like 1280x900');
  return {width: Number(m[1]), height: Number(m[2])};
}
const COUNTER_VIEWPORT = {width: 1280, height: 860};

async function confirm(page){ await page.waitForSelector('#active-modal-overlay [data-ok]'); await page.click('#active-modal-overlay [data-ok]'); }
async function toastText(page, type){
  await page.waitForSelector('.toast' + (type ? '.' + type : ''), {timeout: 10000});
  return page.$$eval('.toast' + (type ? '.' + type : ''), ns => ns.map(n => n.textContent).join(' | '));
}
async function clearToasts(page){ await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); }
async function go(page, route, param){ await page.evaluate(([r, p]) => navigate(r, p), [route, param == null ? null : param]); await page.waitForTimeout(400); }
async function modalGone(page){ await page.waitForSelector('#active-modal-overlay', {state: 'detached', timeout: 15000}); }
async function statValue(p, label){
  return p.$$eval('.stat-card', (cards, label) => {
    const c = cards.find(x => x.querySelector('.label') && x.querySelector('.label').textContent.trim().toLowerCase() === label.toLowerCase());
    return c ? c.querySelector('.value').textContent : null;
  }, label);
}
// browser context for the Back Office at the size chosen by BO_VIEWPORT
async function boContext(browser, extra){
  return browser.newContext(Object.assign({viewport: boViewport(), timezoneId: 'Asia/Manila', acceptDownloads: true}, extra || {}));
}
async function counterContext(browser){ return browser.newContext({viewport: COUNTER_VIEWPORT, timezoneId: 'Asia/Manila'}); }
const sizeTag = () => { const v = boViewport(); return v.width + 'x' + v.height; };

module.exports = Object.assign({}, H, {boViewport, COUNTER_VIEWPORT, confirm, toastText, clearToasts, go, modalGone, statValue, boContext, counterContext, sizeTag});
