# Cavite City Coffee Club (CCCC) — POS + Inventory + QR Ordering

The rulebook for everyone working in this repository: the lead (C) and every subagent.
Read this file fully before touching anything.

## What this is
A web-based POS + inventory system for **Cavite City Coffee Club**, a coffee shop in the
Philippines, built to grow into a multi-shop SaaS. Three apps share one Supabase database:

| App | Who | Needs internet? |
|---|---|---|
| **Front Office** (counter POS) | Staff, signing in with a 4–6 digit PIN | No — sells offline, uploads later |
| **Back Office** (admin) | Admins only | Yes |
| **QR order page** | Customers on their own phones | Yes |

Plain static files (HTML/CSS/vanilla JS), hosted on GitHub Pages
(`https://zdboi.github.io/coffee-shop-system/`). No build step, no npm at runtime.
The owner is a beginner: anything they must do (Supabase settings, uploading files) needs
plain-language, step-by-step instructions.

## Current state (read this)
There are **two competing in-progress builds**. Until the owner picks one, do not merge them
and do not delete either.

| | Build R (repository root) | Build C (`cccc/`) |
|---|---|---|
| Folders | `frontoffice/` `backoffice/` `order/` `shared/` `supabase/004_cccc_frontoffice_backoffice_qr.sql` `config.js` `index.html` `README.md` | `cccc/front/` `cccc/order/` `cccc/shared/` `cccc/supabase/004_cccc_online_qr.sql` `cccc/sw.js` (no Back Office yet) |
| Supabase client | supabase-js from jsDelivr CDN | in-house `cccc/shared/cloud.js` |
| Tests | none yet | `tests/` (SQL + Front Office browser test) |

`Inventory/` and `POS/` are the **original offline apps**. They stay untouched forever: shops
still need them to export old data from the browsers they used.

## Golden rules (everyone)
1. **Own only your files.** Each file has exactly one owner (table below). Need a change in
   someone else's file? Stop and report what you need to the lead.
2. **Never modify** `Inventory/`, `POS/`, `connection-test.html`.
3. **Never** put a Supabase `service_role` key (or any secret) in any file. The anon key in
   `config.js` / `cccc/shared/config.js` is public by design.
4. **Never connect to the real Supabase project** (`qtkoxzuedxvqoktobtyg.supabase.co`), never run
   SQL against it. The owner runs database scripts themselves. Test only on the local test DB.
5. **Never** `git commit`, `git push`, or switch branches. The lead does all git work.
6. **Database scripts are append-only once the owner has run one.** Changes then go in a new
   numbered file (`005_…sql`). Until then, the 004 script may be edited.
7. Don't weaken security to make something work (RLS, grants, PIN checks, server-side prices).
8. Don't edit tests to make them pass (only QA edits tests; expected numbers change only with
   the lead's approval).

## Conventions
- **Data shape:** JavaScript objects use the exact Supabase column names (snake_case:
  `ingredient_id`, `recipe_id`, `sale_id`, `modifier_groups`, `price_delta`…). Ids are UUIDs made
  on the client (`crypto.randomUUID`).
- **Money:** all totals go through the shared logic (`computeSaleTotals`, `shiftMetrics`,
  `recipeCost`, `inventoryLinesForSaleLine`). Never re-implement these formulas in a screen.
  Customer-facing prices are calculated by the **database**; the QR page only displays them.
- **Stock** is the sum of `inventory_transactions` (view `v_ingredient_stock`). Sales deduct
  recipe ingredients **plus modifier extras**; refunds/voids put the same amounts back.
- **Safety in pages:** every piece of user/customer text inserted into HTML goes through
  `escapeHtml` / `esc`. Errors shown to people use plain words (`friendlyError`).
- **Philippines:** currency ₱ (en-PH formatting), timezone Asia/Manila, mobile numbers
  `09XX XXX XXXX` normalised to `+639XXXXXXXXX`.
- **Copy:** sentence case, plain verbs, no jargon; buttons say what happens ("Start shift").

## File ownership
| Owner | Build C paths | Build R paths |
|---|---|---|
| `db-security-engineer` | `cccc/supabase/*.sql` | `supabase/*.sql` |
| `core-sync-engineer` | `cccc/shared/{cloud,local,logic,ui,config}.js`, `cccc/shared/styles.css`, `cccc/sw.js` | `shared/{supa,data,logic}.js`, `shared/styles.css`, `config.js` |
| `front-office-dev` | `cccc/front/**` | `frontoffice/**` |
| `back-office-dev` | `cccc/back/**` | `backoffice/**`, `shared/calendar.js`, `shared/import.js` |
| `customer-qr-dev` | `cccc/order/**` | `order/**` |
| `qa-test-engineer` | `tests/**` | `tests/**` |
| `security-reviewer` | nothing (read-only) | nothing (read-only) |
| lead (C) | `CLAUDE.md`, `.claude/**`, `README.md`, `index.html`, `docs/**`, `.gitignore`, vendored libs | same |

## How work flows
1. Lead writes a brief: goal, acceptance checks, files in scope.
2. Database changes first (`db-security-engineer`) → `security-reviewer` gate.
3. Shared core changes, if any (`core-sync-engineer`).
4. Screens in parallel: `front-office-dev`, `back-office-dev`, `customer-qr-dev`.
5. `qa-test-engineer` runs the full regression + new tests; `security-reviewer` again if data,
   logins or customer information changed.
6. Findings go back to the file's owner; repeat until clean. Lead integrates and delivers.

Every agent ends with a short report to the lead: what changed (files), how it was checked
(commands + results), anything left open or needing a decision.

## Testing (local only)
```bash
tests/start_pg.sh                    # local PostgreSQL 16 on port 54329 (test only)
tests/reset_db.sh [migration.sql] [db]   # stand-in Supabase + live-schema copy + one 004 script
tests/e2e_reset.sh                   # reset + seed data for browser tests (Build C)
tests/restart_fake.sh                # local Supabase stand-in + file server on :8787
tests/run_all.sh                     # full regression for Build C
```
- `tests/sql/01_existing_schema.sql` reconstructs the **live** schema (from the owner's Supabase
  output). Every 004 script must install on top of it and run twice without errors.
- Browser tests use Playwright from `/opt/npm-tools/node_modules/playwright` (Chromium preinstalled).
- The sandbox blocks npm and most CDNs (incl. jsDelivr): Build R's pages cannot load supabase-js here.
- Don't put `fake-supabase/server.js` or `pgrep -f "fake-supabase/server.js"` text in the same shell
  command that runs `restart_fake.sh` — the restart kills processes matching that text.
