# Tests (developer use only — not part of the website)

Nothing here connects to the real Supabase project. Everything runs against a throw-away
PostgreSQL 16 on port 54329 and a small local stand-in for Supabase (`fake-supabase/server.js`).

## Full regression (QA)
```bash
tests/run_all.sh                 # everything; the browser suites run twice to catch flaky checks
tests/run_all.sh --runs 1        # browser suites once
tests/run_all.sh --no-browser    # database + unit checks only (about 10 seconds)
```
Uses database `cccc` + the stand-in on port 8787 (both belong to QA). Ends with a table of every suite
(PASS/FAIL, checks, failed, seconds); exit code 0 only when everything passed. One log per suite and
the screenshots go to `$QA_SHOTS` (default `${TMPDIR:-/tmp}/cccc-qa-shots`, logs in `logs/`).
A full run with two browser rounds takes about 25 minutes (2026-10-19: 39 suites, 2,673 checks).

## What is checked

| Suite | What | Size |
|---|---|---|
| 004..007 install (x2) | the live order `004_cccc_online_qr.sql` → `005_live_fixes.sql` → `006_live_fix_sync_operations.sql`, then `007_batch1.sql` (batch 1, not yet on live), installs on the live-schema copy (`sql/01`, incl. the live CHECK rules) and again on top of itself | — |
| `sql/36_live_rules_tests.sql` | after the install: every CHECK rule matches the owner's live list (one rule per column; 005 replaced the stand-in device_type rule, 006 the sync_operations rule; `cash_movements.amount > 0` kept) (17) | — |
| `sql/10_behaviour_tests.sql` | sign-up trigger, menu via `apply_changes`, pairing, PIN logins (no rank from a PIN), lockout, `fo_sync` sale / duplicate / discount refusal / void with approval token | — |
| `sql/11_qr_tests.sql` | QR menu, register / relink / forget, server-side prices, counter accept → pay → ready → complete, customers, `sales_report`, merge, legacy PIN, device removal | — |
| `sql/31_qa_extra_tests.sql` | QA extras (after 10 + 11): a refused pairing must leave nothing behind | — |
| `sql/30_security_tests.sql` | 172 checks for the 2026-10-12 security decisions (own fresh database) | — |
| `sql/32_fix_round_tests.sql` | 130 fix-round checks (own fresh database): QR order paid once (`QR_ORDER_ALREADY_PAID`), refund caps for every login incl. the owner, pro-rated refunds, `SALE_LOCKED`, `PIN_AMBIGUOUS`, sign-in token approves only its own staff member, `refunds.imported_at` | — |
| `sql/33_security_round3_tests.sql` | 169 checks for the 2026-10-19 security round (own fresh database; adopted from the database engineer): F1 F2 F4 / 6-digit manager PINs, F5 QR flood limits, F6–F11, F13, `qr_cancel_order`, customer erasure (incl. sale item notes, refund reason / notes) | — |
| `sql/34_live_fixes_tests.sql` | 005 (own fresh database): re-creates the live `devices_device_type_check`, pairing fails, 005 x2 fixes it (13) | — |
| `sql/35_live_fix_sync_ops_tests.sql` | 006 (own fresh database): re-creates the live `sync_operations_operation_type_check`, uploads fail, 006 x2 fixes them (16) | — |
| `sql/37_batch1_tests.sql` | 007 + batch 1 (own fresh database; adopted from the database engineer): pay-in / pay-out of ₱0 or less → `AMOUNT_NOT_POSITIVE`, nothing saved, next ops still run; categories add / rename / move + delete in one call; several recipes deleted in one call, in-use ones refused (all-or-nothing); a big Excel-import call; starting-price purchases add no stock (43) | — |
| `conc_checks.sh` | two sessions at the same moment (on the data 32 leaves): two owner refunds of one sale, two counters paying one QR order -> only one passes | — |
| `unit/core_check.js` | `friendlyError` / `ERROR_TEXT`, `parseAuthRedirect`, `sessionFromUrl`, `updatePassword`, `resetPassword` (node, mocked fetch) | — |
| `unit/error_codes_check.js` | every error code the database can send to an app has a plain-language text in that app | — |
| `unit/core_browser.js` | the same auth helpers in a real browser (address bar cleaned, session key) | — |
| `unit/logic_refund_check.js` | `refundAmountForItems` / `refundLeft` / `refundPriorFor`, `SALES_LABELS`, `salesSummaryRows`, receipt words (96) | — |
| `unit/email_link_check.js` | email links: only recovery / signup links sign in, never over another signed-in account (53) | — |
| `unit/captcha_check.js` | optional CAPTCHA, shared code: `Captcha.enabled()` / `getToken()` (key empty → nothing loaded; script URL, site key, widget removed, loaded once; error / timeout / empty token → `CAPTCHA_FAILED`; blocked script or offline → offline), `{captchaToken}` → `gotrue_meta_security.captcha_token` in the four auth calls (bodies unchanged without), server `captcha_failed` → plain message (30) | — |
| `unit/units_check.js` | batch-1 unit helpers in `logic.js`: `compatibleUnits`, `convertQuantity`, `toBaseUnit`, `fromBaseUnit` (incl. a 32-case typed → stored → shown round trip), `unitLabel`, `formatQuantity`; `toBaseQuantity` (purchases) unchanged; `CATEGORY_SEED` has Raw materials (48) | — |
| `unit/refund_parity_check.js` | 500 random refunds: `logic.js` and the database's `_refund_items_cap` give the same amount (seeded db, rolled back) | — |
| `e2e/fo.e2e.js` | counter: pair, PIN, shift, sale with options, offline sale → reload → uploads once, void, close shift | 1280 |
| `e2e/fo_security.e2e.js` | counter security: pairing only, cashier-only offline PINs, manager-PIN discount (token used), offline approval message, full refund of a discounted sale, masked phones + escaping + look-up limit, manager's own token + deferred logout, closing another cashier's shift, PIN lockout text | 1280 |
| `e2e/fo_refunds.e2e.js` | counter: pro-rated partial refunds, refunds add up, Back Office refund picked up (Void refused), `performed_by`, approval-expiry warning | 1280 |
| `e2e/fo_offline_manager.e2e.js` | counter offline: a signed-in manager approves their own discount + refund, uploaded later and accepted once | 1280 |
| `e2e/fo_offline_pin.e2e.js` | counter offline PINs: shared PIN refused, 5 wrong tries lock 5 min then 15, survives reload | 1280 |
| `e2e/fo_qr_paid_once.e2e.js` | two counters, one QR order: online "already paid" before charging; offline second payment refused by the server with a banner | 1280 |
| `e2e/order_ticket_states.e2e.js` | QR ticket wording per state (open/paid/ready/completed/cancelled/rejected) on the 5-second refresh, without a reload | 390×844 |
| `e2e/order.e2e.js` | QR page: first visit, register, welcome back, size required, server price, ticket, READY shown | 390×844 |
| `e2e/order_extra.e2e.js` | QR page: toasts never over buttons, PHONE_TAKEN → relink, limits, NOT_SIGNED_IN, typed values kept, escaping | 390×844 (+360) |
| `e2e/bo.e2e.js` | Back Office parts 0–6 in order (`e2e/bo/`): every screen, stock / menu / options / photos / production, staff + PINs, pairing, tables + QR sheet, sales vs counter, owner refund + void, customers, settings, reports, importer, password reset, new shop, suppliers, escaping; part 5 old-app refunds in the importer (`fixtures/old-refunds.json`); part 6 `SALE_LOCKED` + "Mark as reviewed" | 1280 and 768 |
| `e2e/bo_calendar_tips.e2e.js` | calendar day view: the hover label sits over the hour it describes | 1280 and 768 |
| `e2e/money.e2e.js` | one shift across all three apps: sale with options, QR order paid at the counter, manager-approved discount, void, counter partial refund (pro-rated ₱244.00), owner refund in the Back Office (₱107.36); X-report = calendar day + shift view = `sales_report` = closed shift, to the centavo; stock = start − deducted + returned (incl. option extras) | 1280 / 390×844 |
| `e2e/fo_round3.e2e.js` | counter, 2026-10-19 round: 4-digit manager sees the 6-digit PIN note; consent tick required (`p_consent`); QR sign-up limit doesn't block the counter; sign-in while a manager-approved item waits and the server refuses uploads → "cancel those approvals" warning, "Upload first" / "Sign in anyway" | 1280 |
| `e2e/bo_round3.e2e.js` | Back Office, 2026-10-19 round (+ one counter): PIN banner + `PIN_TOO_SHORT`, promoting a cashier asks for 6 digits, lockout alert + unlock (survives reload), review reasons in plain words, pay-out / refund "Mark as reviewed", pay-out limit setting, "Net sales today", full customer delete across a merge chain | 1280 |
| `e2e/captcha.e2e.js` | optional CAPTCHA in all three apps (config.js fulfilled with a test key, service workers blocked, `challenges.cloudflare.com` answered by a fake `turnstile.render` or blocked — never reached). Key empty: no Cloudflare request, no `gotrue_meta_security` in any auth body. Key set — counter pairing, QR first sign-in (+ "Not me?"), Back Office sign-in / forgot password / sign-up: blocked script → no-connection message; failed check → plain message, typed input kept, nothing sent; server `captcha_failed` → plain message; try again works; a fresh token every attempt; no Turnstile after sign-in, while selling / ordering, after a reload or on other Back Office screens (77) | 1280 / 390×844 |
| `e2e/fo_batch1.e2e.js` | counter, batch 1: Back Office link last in the menu, well below Shift & Cash, ADMIN only (not cashier / manager); role tooltip, lock label; pay-in ₱0 / -₱5 / ₱0.004 refused (nothing queued or saved), ₱12.345 → ₱12.35; a ₱0 pay-in refused by the server → "Pay in / pay out" + "The amount must be more than ₱0." under "Uploads that need attention"; 800 px footer fits (27) | 1280 (+800) |
| `e2e/bo_batch1.e2e.js` | Back Office, batch 1: category manager (Raw materials one click, duplicates refused in any case, rename, remove unused, remove used with move in ONE call, House-Made locked, "+ New category" in the ingredient form); units (starting stock in kg, recipe line + option extra in L for an mL ingredient → base + unit, re-opened the same, production yield / batch in L, waste in kg, adjustment / count in L); counter sale with the L extra takes off the base mL; tick-and-remove (2 deleted, 3 hidden incl. one sold once next to one sold 1501 times, ONE call, ONE audit "Recipes removed", Cancel = nothing); a typed number keeps its value on a unit change, a saved one converts, "saved as …" hints (78) | 1280 |
| `e2e/bo_excel.e2e.js` | Back Office Excel (fixtures in `tests/fixtures/`, FAKE data): demo import → 6 recipes / 15 new ingredients / 2 skipped / 1 house-made, hidden by default, starting prices = quantity-0 purchases with no stock; again → 0; HTML + formula-looking text shown as text, leading = + - @ stripped, names cut to 80, "show right away" tick on → visible; > 5 MB, .xls, not a zip, other type, > 500 rows, 11 files refused in plain words; export writes "=1+1" as text, report CSV writes `'=1+1`; export → empty new shop round trip; own export back into the same shop → 0 new | 1280 |
| `e2e/order_limits.e2e.js` | QR page: `TOO_MANY_SIGNUPS` / `TOO_MANY_ORDERS` (real server limits + intercepted answers), page usable while the web font never arrives | 390×844 |

`run_all.sh` also writes `logs/review_flags.log`: every sale / refund / pay-out the server flagged for review in
each browser suite (a normal, correct flow should not appear there).

A browser suite fails on any page error, `console.error`, unexpected dialog, or HTTP answer ≥ 400 — except a
refusal the test provokes on purpose (allowed with `net.allow(...)` around that one step).

## Pieces
- `sql/00_supabase_stub.sql` — stand-in for Supabase internals (auth schema, roles, storage).
- `sql/01_existing_schema.sql` — reconstruction of the **live** schema incl. the CHECK rules live had before our scripts
  (`devices.device_type in ('POS','KDS')` is a stand-in: the real live list is unknown). `reset_db.sh` installs 004, 005, 006 on it
  (the live order), then 007 (batch 1); every suite runs on that.
- `sql/20_seed_e2e.sql` — browser-test seed: owner `owner@example.com` / `secret123`, Cathy (cashier, PIN 1111),
  Manny (manager, 2222), owner PIN 9999, Iced Latte / Americano / Ensaymada, beans 1000 g, milk 5000 ml,
  Table 5 (`tabletoken5`), pairing code `TESTAB`.
- `fake-supabase/server.js` — Auth (anonymous + password sign-in, refresh, recover, `GET`/`PUT /auth/v1/user`),
  PostgREST subset (RPC + table reads with RLS), Storage, plus the app files. Port from `PORT`, database from `FAKE_DB`.
- `fixtures/demo_cafe_costing.xlsx`, `fixtures/demo_pastry_costing.xlsx` — FAKE costing workbooks in the owner's layout (no real data;
  rebuild with `node tests/fixtures/make_fixture.js` while a stand-in runs on `FAKE_PORT`). Never put the owner's real files in tests.
- `e2e/lib/h.js` — shared browser-test helpers (checks, waits, error capture, PIN pad, logins).
- `e2e/bo/` — Back Office parts (`part0_smoke` … `part4_admin`), `bo_helpers.js`, `fixtures/old-backup.json`
  (old offline apps' backup; rebuild with `node tests/e2e/bo/fixtures/make-old-backup.js`), `fixtures/old-refunds.json`
  (old backup with refunds; rebuild with `node tests/e2e/bo/fixtures/make-old-refunds.js`).

## Running one suite on your own stand-in (parallel work)
Each developer uses their **own database and port**. `restart_fake.sh` only restarts the stand-in on the
port you give it. Run each line as its own command.

| Who | Reset + seed your database, then (re)start your stand-in | Open |
|---|---|---|
| Front Office | `tests/e2e_reset.sh db_fo && tests/restart_fake.sh 8790 db_fo` | `http://localhost:8790/cccc/front/` |
| Back Office | `tests/e2e_reset.sh db_bo && tests/restart_fake.sh 8791 db_bo` | `http://localhost:8791/cccc/back/` |
| QR page | `tests/e2e_reset.sh db_qr && tests/restart_fake.sh 8792 db_qr` | `http://localhost:8792/cccc/order/?t=tabletoken5` |

- Browser suites need a freshly seeded database each (they change data):
  `tests/e2e_reset.sh db_fo && FAKE_PORT=8790 FAKE_DB=db_fo node tests/e2e/fo_security.e2e.js`
- Back Office at tablet size: `tests/e2e_reset.sh db_bo && FAKE_PORT=8791 FAKE_DB=db_bo BO_VIEWPORT=768x1024 node tests/e2e/bo.e2e.js`
- One Back Office part on its own only works on the data the parts before it left behind (run `bo.e2e.js`).
- SQL suites: `tests/reset_db.sh "" db_sec && psql -h /tmp -p 54329 -U postgres -d db_sec -v ON_ERROR_STOP=1 -f tests/sql/30_security_tests.sql`
  (10, 11 and then 31 run one after the other on the same fresh database; 32 on its own fresh database, then `tests/conc_checks.sh <db>`).
- Unit checks: `node tests/unit/core_check.js`, `node tests/unit/error_codes_check.js`, `node tests/unit/core_browser.js`, `node tests/unit/captcha_check.js`, `node tests/unit/units_check.js`.
- CAPTCHA browser suite on your own stand-in: `tests/e2e_reset.sh db_qr && tests/restart_fake.sh 8792 db_qr && FAKE_PORT=8792 FAKE_DB=db_qr node tests/e2e/captcha.e2e.js`
  (needs a fresh seed: it pairs two counters and registers QR customers).
- Log for each stand-in: `tests/fake-<port>.log`. App pages are read from disk on every request, so editing them
  needs no restart; after editing `fake-supabase/server.js`, restart the stand-in.
- Try a different migration file: `tests/reset_db.sh path/to/file.sql db_bo` (ONLY that file on top of `sql/01`, no seed data).
- Don't use `cccc` or port 8787 — those are QA's regression runs.
