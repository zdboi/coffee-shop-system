# Cavite City Coffee Club (CCCC) — POS + Inventory + QR Ordering

The rulebook for everyone working in this repository: the lead (C) and the independent checker (Z).

**Team model (owner decision 2026-11-11):** C builds everything itself (database, shared core, counter,
Back Office, QR page, docs). **Z** (`.claude/agents/z.md`) is the one independent agent: security reviewer
and final QA tester, who counter-checks everything C does. The earlier specialist agents are retired
(`.claude/agents-retired/`).
Read this file fully before touching anything.

## What this is
A web-based POS + inventory system for **Cavite City Coffee Club**, a coffee shop in the
Philippines, built to grow into a multi-shop SaaS. Three apps share one Supabase database:

| App | Folder | Who | Needs internet? |
|---|---|---|---|
| **Front Office** (counter POS) | `cccc/front/` | Staff, signing in with a 4–6 digit PIN on a paired counter | No for selling (queues and uploads later); yes for manager approvals |
| **Back Office** (admin) | `cccc/back/` | The owner's email login (profile role ADMIN) | Yes |
| **QR order page** | `cccc/order/` | Customers on their own phones | Yes |

Plain static files (HTML/CSS/vanilla JS), hosted on GitHub Pages
(`https://zdboi.github.io/coffee-shop-system/`). No build step, no npm at runtime, no CDN
scripts (the Supabase client is our own `cccc/shared/cloud.js`).
The owner is a beginner: anything they must do (Supabase settings, uploading files) needs
plain-language, step-by-step instructions.

## Current state
- **Build C (`cccc/`) is the chosen build** (owner decision, 2026-10-12).
- The competing Build R is archived in `_archive/build-r/` — **read-only reference**. Its Back Office
  screens, sales calendar and importer are the source for building `cccc/back/` (they use a different
  data style: camelCase fields + `DB.put`; convert to this file's conventions when porting).
- **The owner ran `cccc/supabase/004_cccc_online_qr.sql` on the live project on 2026-10-20** ("Success").
  It is now **frozen**: every database change goes in a new numbered script, per golden rule 6.
- The owner also ran **`005_live_fixes.sql`** and **`006_live_fix_sync_operations.sql`** on live (2026-10-20); both
  are frozen too. **`007_batch1.sql`** (release 1.1, run 2026-10-29) and **`008_release_1_2.sql`** (release 1.2, run 2026-11-02)
  and **`009_release_1_3.sql`** (release 1.3, run 2026-11-02) and **`010_release_1_4.sql`** (release 1.4, run 2026-11-09) and **`011_release_1_4_1.sql`** (release 1.4.1, run 2026-11-09) and **`012_release_1_5.sql`** (release 1.5, run 2026-11-12) are frozen. The next script is **`013_…sql`**; it may be edited until the owner runs it. The live database has older CHECK rules than our reconstruction:
  any new value written to a live column must be checked against the live rule list first.

## Golden rules (everyone)
1. **Own only your files.** C owns everything except `tests/**`, which Z owns. Z never edits app code,
   SQL or docs; it reports what needs changing and C fixes it.
2. **Never modify** `_archive/**` (incl. the retired old apps, moved to `_archive/old-apps/` on 2026-10-20).
3. **Never** put a Supabase `service_role` key (or any secret) in any file. The anon key in
   `cccc/shared/config.js` is public by design.
4. **Never connect to the real Supabase project** (`qtkoxzuedxvqoktobtyg.supabase.co`), never run
   SQL against it. The owner runs database scripts themselves. Test only on the local test DB.
5. **Only C** does git work (commit, push, PRs). Z never commits, pushes or switches branches.
6. **Database scripts are append-only once the owner has run one.** Changes then go in a new
   numbered file (`005_…sql`). Until then, the 004 script may be edited.
7. Don't weaken security to make something work (RLS, grants, PIN checks, server-side prices).
8. Don't edit tests to make them pass (only Z edits tests; expected numbers change only with
   C's approval, and C tells the owner when a change reflects an owner decision).

## Security decisions (2026-10-12, from the security review — binding)
1. **Counters join only by pairing code** (anonymous device login + `redeem_device_pairing`).
   No owner email sign-in on a counter; `fo_register_device` is removed; `fo_sync` accepts only
   DEVICE logins.
2. **Back Office = email login with profile role ADMIN only.** A staff PIN never gives Back Office
   (or any admin) rights; a DEVICE login has admin rank 0 whatever PIN is entered.
3. **Manager approvals are verified by the server.** Refunds, voids and discounts carry a one-time
   approval token from `staff_pin_login(pin, 'OVERRIDE', 'MANAGER')`; `fo_sync` checks it belongs to the
   named approver (MANAGER/ADMIN, same shop) and marks it used. These actions need internet, with one
   exception (owner decision 2026-10-12): a MANAGER/ADMIN who is the one signed in at the counter (with a
   LOGIN token from an online sign-in) may approve their own actions offline; the counter sends that
   LOGIN token and the server checks it when the op uploads. A cashier still can't get approval offline,
   and manager PINs are still never checked against offline copies.
4. **Offline PIN copies on counters are for CASHIER staff only.** Never cache manager/admin PINs.
5. **Counters never see full customer phone numbers** (masked, e.g. `0917 ••• 4567`). Only the
   owner's Back Office login reads full numbers.
6. **Refund caps:** a refund can't exceed what's left of the sale, and returned stock can't exceed
   what that sale deducted, for every login including the owner's Back Office (enforced by the
   server, not only the screen). Child rows (items, payments, stock lines) can never overwrite rows of
   another sale. A partial refund gives back what the customer actually paid for those items: their
   share after the sale's discount, plus tax and service charge (owner decision 2026-10-12); one shared
   function computes it for the counter and the Back Office.
7. **Only `qr_relink` links a phone to an existing customer.** Any answer that reveals whether a
   number is registered is rate-limited per login.

8. **Manager/admin PINs are 6 digits** (owner decision 2026-10-19). Cashier PINs stay 4–6 digits.
   Existing 4–5 digit manager/admin PINs must be changed (Back Office shows who needs a new one).
   Until changed (owner decision 2026-10-19): they can still sign in and sell, but can NOT approve
   anything (OVERRIDE refused, and their own sign-in token can't approve) → `PIN_UPDATE_NEEDED`.
9. **Hosting** (owner decision 2026-10-19): before go-live, the old `POS/`, `Inventory/` and
   `connection-test.html` pages are taken off the live site (they share browser storage with the
   apps). The lead does this as a move into `_archive/`, never by editing them.

10. **CAPTCHA** (lead decision 2026-10-19): the one allowed outside script is Cloudflare Turnstile
   (`https://challenges.cloudflare.com/turnstile/v0/api.js`), loaded lazily ONLY when
   `CCCC_CONFIG.CAPTCHA_SITE_KEY` is set and ONLY right before a Supabase auth request that
   CAPTCHA protects (QR page first visit, counter pairing, Back Office email sign-in / sign-up /
   password reset). With the key empty, nothing loads and behaviour is unchanged. The site key
   is public; the secret key lives only in Supabase.

## Lead housekeeping
- **Before building any owner request, check whether the app already does it, fully or partly** (owner decision
  2026-10-25: they may forget earlier changes). If it repeats or overlaps an existing feature, tell the owner
  and wait for their decision. Never build a repeated feature without asking.
  Once the owner's private developer changelog exists (feedback #2), check each request against it first
  (owner decision 2026-10-25), and keep it updated with every release.
- **Keep the last working version** (owner decision 2026-10-25, for every app): before any update goes live, the
  version currently live and working is saved as a checkpoint in `docs/checkpoints.md` (commit link + ZIP, marked
  "last working version"). Only after that is the new release merged. If a release goes wrong, the owner says
  "Go back to the last working version" and the lead restores it as a new commit (nothing in the history is deleted).
- **Use savepoints for debugging and side-by-side comparison, only when necessary** (owner decision 2026-10-25):
  e.g. a bug the normal tests can't explain, or a risky change where old vs new behaviour must be compared.
  Not a routine step for every release (keeping the last working version, above, still always happens). The lead opens any
  savepoint as a separate read-only copy with `git worktree add /home/claude/savepoints/<short-sha> <sha>`
  (agents still never switch branches or edit that copy). Then:
  - **Debugging:** when something breaks, run the same test or steps on the last working version and on the new
    one; whatever differs is where to look. For "when did this start?", the lead checks older savepoints in turn.
  - **A/B comparison:** serve both versions at once on the local test setup (e.g. old on port 8793, new on 8794,
    each with its own test database) and compare test results, screenshots, speed and behaviour before release.
    Never split real customers or the live database between two versions; the live site always runs one version.
  - Remove the copy when done (`git worktree remove`).
- **Memory (owner decision 2026-11-11):** C's long-term memory lives in two places, kept in step:
  1. **GitHub (this repo):** `docs/RESUME.md` (where we are + next steps), `docs/owner-feedback.md` (every request and
     decision), `docs/PLAN_*.md`, `docs/handoff/contract-*.md`, `docs/checkpoints.md`, `docs/obsidian/`.
  2. **The owner's Obsidian vault on their PC** (`Documents/Obsidian Vault/CCCC POS/`, written through the desktop
     link when this session is linked): the session log, decisions and progress notes.
  At every checkpoint, and whenever a session might end (usage limits), C updates RESUME, the project changelog doc,
  and the Obsidian notes. A new session starts by reading `CLAUDE.md` then `docs/RESUME.md`.
- **Skills (owner decision 2026-11-11):** use the skills available for the task (code review, testing, debugging,
  design, docs…), install new ones when a task needs them, and check the skill catalogue now and then for better ones.

## Counter → server contract (`fo_sync` ops)
Each op is `{op_id, type, data}`; types: `shift_open`, `shift_close`, `cash_movement`, `sale`,
`held_delete`, `refund`, `audit`, `sold_out`. Approval fields:
- `sale` with a discount: `data.sale.discount_approved_by` (staff id) + `data.discount_approval_token`.
- `refund` (incl. VOID): `data.refund.approved_by` (staff id) + `data.approval_token`.
The server answers per op: `ok | duplicate | skipped | error` (+ `message`).

## Conventions
- **Data shape:** JavaScript objects use the exact Supabase column names (snake_case:
  `ingredient_id`, `recipe_id`, `sale_id`, `modifier_groups`, `price_delta`…). Ids are UUIDs made
  on the client (`uid()` / `Cloud.uuid()`).
- **Money:** all totals go through the shared logic (`computeSaleTotals`, `shiftMetrics`,
  `recipeCost`, `inventoryLinesForSaleLine`). Never re-implement these formulas in a screen.
  Customer-facing prices are calculated by the **database**; the QR page only displays them.
- **Stock** is the sum of `inventory_transactions` (view `v_ingredient_stock`). Sales deduct
  recipe ingredients **plus modifier extras**; refunds/voids put the same amounts back.
- **Back Office writes** go through `apply_changes(p_ops)` (all-or-nothing): ops `upsert` (full row),
  `update` (id + changed columns), `insert_ignore`, `delete`, `delete_where`. Reads: `bo_bootstrap()`,
  `sales_report(p_from, p_to)`, plain table reads via `cloud.select`.
- **Sessions:** each app has its own storage key so logins never mix on one browser:
  counter `cccc.staff.session`, Back Office `cccc.admin.session`, customer `cccc.customer.session`.
- **Safety in pages:** every piece of user/customer text inserted into HTML goes through
  `escapeHtml` / `esc`. Errors shown to people use plain words (`friendlyError`).
- **Philippines:** currency ₱ (en-PH formatting), timezone Asia/Manila, mobile numbers
  `09XX XXX XXXX` normalised to `+639XXXXXXXXX`.
- **Copy:** sentence case, plain verbs, no jargon; buttons say what happens ("Start shift").

## File ownership
| Owner | Paths |
|---|---|
| **C** (lead, builds everything) | everything not listed below: `cccc/**` (incl. `cccc/supabase/*.sql`), `docs/**`, `CLAUDE.md`, `.claude/**`, `README.md`, `index.html`, `_config.yml`, `.gitignore`, `menu/**`, `_archive/**` (moves only) |
| **Z** (independent security + final QA) | `tests/**` only; read-only everywhere else |

## How work flows
1. C checks the request against the changelog and existing features, settles open questions with the owner, and
   writes the plan (`docs/PLAN_*.md`) and contract (`docs/handoff/contract-*.md`).
2. C builds the database script first → **Z security gate** on the script.
3. C builds the shared core and the screens (counter, Back Office, QR page), testing as it goes on its own
   databases/ports, leaving new checks in the scratchpad for Z to port.
4. **Z** runs the full regression + new tests + reconciliation, and a security review of the screens when data,
   logins or customer information changed.
5. C fixes every finding; Z re-checks; repeat until Z says PASS. C then packages the release for the owner.

Z ends every check with a short report to C: verdict, findings (most severe first), what was fine, suites run with
counts, and any expected-value changes needing approval. Security findings are reported as weakness + effect + fix,
without step-by-step abuse instructions.

## Testing (local only)
```bash
tests/start_pg.sh                    # local PostgreSQL 16 on port 54329 (test only)
tests/reset_db.sh [migration.sql] [db]   # stand-in Supabase + live-schema copy + the 004 script
tests/e2e_reset.sh [db]              # reset + seed data for browser tests (default db: cccc)
tests/restart_fake.sh [port] [db]    # local Supabase stand-in + file server (default 8787 / cccc)
tests/run_all.sh                     # full regression (QA; uses 8787 / cccc)
```
- `tests/sql/01_existing_schema.sql` reconstructs the **live** schema (from the owner's Supabase
  output). The 004 script must install on top of it and run twice without errors.
- Browser tests use Playwright from `/opt/npm-tools/node_modules/playwright` (Chromium preinstalled).
- The sandbox blocks npm and most CDNs.
- C and Z test at the same time on separate databases and ports. C uses `db_fo` / 8790 (counter),
  `db_bo` / 8791 (Back Office), `db_qr` / 8792 (QR page) and `db_sec` (database work). Z uses `cccc` / 8787
  and `db_rev*` for security probes. Until Z wires the newest script into the reset scripts, install it after a
  reset: `psql -h /tmp -p 54329 -U postgres -d <db> -q -f cccc/supabase/012_release_1_5.sql`. Example: `tests/e2e_reset.sh db_bo && tests/restart_fake.sh 8791 db_bo`,
  then open `http://localhost:8791/cccc/back/`. Browser tests: `FAKE_PORT=8790 FAKE_DB=db_fo node tests/e2e/fo.e2e.js`.
