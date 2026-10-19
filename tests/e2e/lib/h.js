// Shared helpers for the browser tests (test-only, never part of the app).
//   Stand-in + database come from the environment (defaults are QA's):
//     FAKE_PORT=8787  FAKE_DB=cccc  QA_SHOTS=<folder for screenshots>
//   Every check prints "ok   <text>" or "FAIL <text>"; summary() prints one line
//   "SUMMARY <name>: <n> checks, <f> failed" (read by tests/run_all.sh) and sets the exit code.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.FAKE_PORT || 8787);
const DB = process.env.FAKE_DB || 'cccc';
if(!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('FAKE_DB must be a plain lowercase database name');
const BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'cccc-qa-shots');
fs.mkdirSync(SHOTS, {recursive: true});
const PLAYWRIGHT = '/opt/npm-tools/node_modules/playwright';

// ---- database (local test database only; superuser psql, like the seed scripts)
function sql(q){ return execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', DB, '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c', q], {encoding: 'utf8'}).trim(); }
function rows(q){ return JSON.parse(sql(`select coalesce(json_agg(t), '[]') from (${q}) t`)); }
function one(q){ return rows(q)[0]; }
function num(q){ return Number(sql(q)); }

// ---- checks
const results = [];
function ok(cond, msg, got){
  results.push(!!cond);
  console.log((cond ? 'ok   ' : 'FAIL ') + msg + (!cond && got !== undefined ? '   [got: ' + String(typeof got === 'object' ? JSON.stringify(got) : got).slice(0, 400) + ']' : ''));
  return !!cond;
}
function failures(){ return results.filter(x => !x).length; }
function summary(name){
  const f = failures();
  console.log(`SUMMARY ${name}: ${results.length} checks, ${f} failed`);
  return f ? 1 : 0;
}
// A step that cannot continue: record it, print the summary, exit 1.
function abort(name, e){
  results.push(false);
  console.log('FAIL (stopped) ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  summary(name);
  process.exit(1);
}

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
// wait until fn() is truthy; returns true / false (never throws)
async function until(fn, ms, every){
  const end = Date.now() + (ms || 15000);
  while(Date.now() < end){ try{ if(await fn()) return true; }catch(e){} await sleep(every || 200); }
  return false;
}
// same, but throws (for setup steps the rest of a test depends on)
async function must(fn, what, ms){ if(!(await until(fn, ms))) throw new Error('TIMEOUT waiting for: ' + what); return true; }

// ---- browser
const IGNORED = /favicon|fonts\.(googleapis|gstatic)\.com/;
// Collects browser errors for one page: uncaught exceptions, console.error, unexpected dialogs,
// and HTTP responses >= 400. Chromium's own "Failed to load resource" console lines are not
// counted twice: failed HTTP answers are tracked from the responses instead, so a test can
// allow the one refusal it provokes on purpose:
//   const net = H.attach(page, errors, 'FO');  net.allow(/rpc\/search_customers/);  ...  net.disallow();
// Requests that fail because the test switched the network off are not errors.
function attach(page, errors, tag){
  let allowed = [];
  page.on('pageerror', e => errors.push(tag + ' pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type() !== 'error') return;
    const where = (m.location() && m.location().url) || '';
    if(IGNORED.test(m.text()) || IGNORED.test(where)) return;
    if(/^Failed to load resource/.test(m.text())) return;
    errors.push(tag + ' console: ' + m.text() + (where ? ' @ ' + where : ''));
  });
  page.on('response', r => {
    const s = r.status(), u = r.url();
    if(s < 400 || IGNORED.test(u) || allowed.some(re => re.test(u))) return;
    errors.push(`${tag} HTTP ${s} ${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, '')}`);
  });
  page.on('dialog', d => { errors.push(tag + ' unexpected dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  return {allow(re){ allowed.push(re); }, disallow(){ allowed = []; }};
}
// A 6-digit PIN is sent by the pad itself after the 6th digit; shorter ones need Enter.
async function typePin(page, pin){ for(const d of pin) await page.click(`#pin-pad button[data-k="${d}"]`); if(pin.length < 6) await page.click('#pin-enter'); }
const money = (t) => Number(String(t == null ? '' : t).replace(/[^0-9.\-]/g, ''));
const r2 = (n) => Math.round(Number(n) * 100) / 100;
async function shot(page, name, opts){ try{ await page.screenshot(Object.assign({path: path.join(SHOTS, name + '.png')}, opts || {})); }catch(e){} }

// Front Office: pair with a code, sign in with a PIN, optionally start a shift.
async function pairCounter(page, code){
  await page.goto(BASE + '/cccc/front/');
  await page.waitForSelector('#su-code', {timeout: 15000});
  await page.fill('#su-code', code);
  await page.click('#su-pair');
  await page.waitForSelector('#pin-gate', {state: 'visible', timeout: 20000});
}
async function startShift(page, opening){
  await page.waitForSelector('#ss-opening-cash', {timeout: 15000});
  await page.fill('#ss-opening-cash', String(opening));
  await page.click('#ss-start-btn');
  await page.waitForSelector('.pos-product-card', {timeout: 15000});
}
// The apps move the keyboard focus to the first box 30-50 ms after a form or dialog appears
// (Back Office sign-in / sign-up / set PIN). A test that types faster than that can have its text
// land in the first box, so wait until that focus has happened before typing.
async function focusSettled(page, id, ms){
  await page.waitForFunction((x) => document.activeElement && document.activeElement.id === x, id, {timeout: ms || 3000}).catch(() => {});
}
// Back Office: owner email login
async function boLogin(page, email, pass){
  await page.goto(BASE + '/cccc/back/');
  await page.waitForSelector('#li-email', {timeout: 15000});
  await focusSettled(page, 'li-email');
  await page.fill('#li-email', email || 'owner@example.com');
  await page.fill('#li-pass', pass || 'secret123');
  await page.click('#f-login button[type=submit]');
  await page.waitForSelector('#app', {state: 'visible', timeout: 20000});
}

module.exports = {PORT, DB, BASE, SHOTS, PLAYWRIGHT, sql, rows, one, num, ok, failures, summary, abort, sleep, until, must,
  attach, typePin, money, r2, shot, pairCounter, startShift, boLogin, focusSettled};
