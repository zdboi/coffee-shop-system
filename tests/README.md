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
| 004 installs (x2) | `cccc/supabase/004_cccc_online_qr.sql` installs on the live-schema copy (`sql/01`) and again on top of itself | — |
| `sql/10_behaviour_tests.sql` | sign-up trigger, menu via `apply_changes`, pairing, PIN logins (no rank from a PIN), lockout, `fo_sync` sale / duplicate / discount refusal / void with approval token | — |
| `sql/11_qr_tests.sql` | QR menu, register / relink / forget, server-side prices, counter accept → pay → ready → complete, customers, `sales_report`, merge, legacy PIN, device removal | — |
| `sql/31_qa_extra_tests.sql` | QA extras (after 10 + 11): a refused pairing must leave nothing behind | — |
| `sql/30_security_tests.sql` | 172 checks for the 2026-10-12 security decisions (own fresh database) | — |
| `sql/32_fix_round_tests.sql` | 130 fix-round checks (own fresh database): QR order paid once (`QR_ORDER_ALREADY_PAID`), refund caps for every login incl. the owner, pro-rated refunds, `SALE_LOCKED`, `PIN_AMBIGUOUS`, sign-in token approves only its own staff member, `refunds.imported_at` | — |
| `conc_checks.sh` | two sessions at the same moment (on the data 32 leaves): two owner refunds of one sale, two counters paying one QR order -> only one passes | — |
| `unit/core_check.js` | `friendlyError` / `ERROR_TEXT`, `parseAuthRedirect`, `sessionFromUrl`, `updatePassword`, `resetPassword` (node, mocked fetch) | — |
| `unit/error_codes_check.js` | every error code the database can send to an app has a plain-language text in that app | — |
| `unit/core_browser.js` | the same auth helpers in a real browser (address bar cleaned, session key) | — |
| `unit/logic_refund_check.js` | `refundAmountForItems` / `refundLeft` / `refundPriorFor`, `SALES_LABELS`, `salesSummaryRows`, receipt words (96) | — |
| `unit/email_link_check.js` | email links: only recovery / signup links sign in, never over another signed-in account (53) | — |
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

A browser suite fails on any page error, `console.error`, unexpected dialog, or HTTP answer ≥ 400 — except a
refusal the test provokes on purpose (allowed with `net.allow(...)` around that one step).

## Pieces
- `sql/00_supabase_stub.sql` — stand-in for Supabase internals (auth schema, roles, storage).
- `sql/01_existing_schema.sql` — reconstruction of the **live** schema; the 004 script must install on top of it.
- `sql/20_seed_e2e.sql` — browser-test seed: owner `owner@example.com` / `secret123`, Cathy (cashier, PIN 1111),
  Manny (manager, 2222), owner PIN 9999, Iced Latte / Americano / Ensaymada, beans 1000 g, milk 5000 ml,
  Table 5 (`tabletoken5`), pairing code `TESTAB`.
- `fake-supabase/server.js` — Auth (anonymous + password sign-in, refresh, recover, `GET`/`PUT /auth/v1/user`),
  PostgREST subset (RPC + table reads with RLS), Storage, plus the app files. Port from `PORT`, database from `FAKE_DB`.
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
- Unit checks: `node tests/unit/core_check.js`, `node tests/unit/error_codes_check.js`, `node tests/unit/core_browser.js`.
- Log for each stand-in: `tests/fake-<port>.log`. App pages are read from disk on every request, so editing them
  needs no restart; after editing `fake-supabase/server.js`, restart the stand-in.
- Try a different migration file: `tests/reset_db.sh path/to/file.sql db_bo` (no seed data).
- Don't use `cccc` or port 8787 — those are QA's regression runs.
