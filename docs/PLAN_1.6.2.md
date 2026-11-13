# Release 1.6.2: Back Office clean-up + security hardening

Owner decisions: `docs/owner-feedback.md` (2026-11-14 01:52–02:01). Ships together (they don't touch the same things).

## Part A: Back Office clean-up (built, screens only, no database change)
26 menu items → 12. Every old screen is kept as a tab with the same logic; old routes, `#hash` links and the
Dashboard's links still land on the right tab.

| Menu item | Tabs |
|---|---|
| Dashboard | — (trimmed: 4 Today + 4 Stock tiles; lists kept) |
| Sales | Sales calendar (first) · Transactions · QR orders |
| Customers | — |
| Menu | Recipes · Options library · Costing |
| Stock | Ingredients · Stock levels (old Inventory) · Stock counts · Waste |
| Buying | Purchases · Suppliers |
| Kitchen | Production · R&D log |
| Money | Accounting overview · Expenses · Senior / PWD · Investors & start-up |
| Reports | — (removed the repeats: Waste, Low stock, Recipe costing) |
| Staff & devices | Staff & PINs · Devices |
| Shop setup | Settings · Tables & QR codes |
| Records | Audit log · Backup & import (Start fresh inside) |

- Each menu item reopens the tab last used on that browser (`localStorage` `cccc.bo.tab.<menu>`, wrapped in try/catch).
- One badge per menu item: Sales = needs review + open QR orders.
- Dashboard tiles removed: Total ingredients, Total recipes, Production today, Purchases this month, Production cost,
  Production waste, Highest cost recipe, and the Highest profit recipe box (all still in Reports / their pages).
  The two low-stock tiles became one "Low stock" (raw + house-made). Each stock tile links to its tab.
- Code: `bo-core.js` (`BO_NAV` with `tabs`, `BO_TAB_LABELS`, `boHubFor`, `boTabFor`, `boLastTab`, `#hub-tabs`),
  `index.html` (`#hub-tabs`), `back.css`, `bo-reports.js`. My checks: scratchpad `w5/bo162-nav.js` (125).
- **For Z:** tests that click `.nav-item[data-route="staff"|"settings"|…]` in the Back Office must now click the menu
  item (`people`, `shopSetup`, …) then the tab (`#hub-tabs [data-hubtab="staff"]`), or call `navigate('<old route>')`.
  The counter's `data-route` items are unchanged.

## Part B: security hardening (from Z's full audit of 1.6.1, 2026-11-14: rating NEEDS WORK, no critical)
Already done: **H1** investor details removed from public docs, `docs/` kept off the live site (hotfix PR #11, also on this
branch); **L8** `.gitignore` for `.env*`, zips, backups, CSV. History still holds the old text while the repo is public
(owner decision: make it private).

Database script **015** (owner runs it):
- **M2** profiles can't be inserted or promoted from the API: ADMIN/MANAGER only for email (non-anonymous) logins, a DEVICE
  profile never changes role (except trusted server code).
- **M3** (with screens) two-step sign-in: rank 3 (owner) needs `aal2` once the owner has enrolled an authenticator app.
- **L1** inactive staff refused in counter uploads (or flagged), `STAFF_MISMATCH` on `cash_movement` / `shift_open`.
- **L2** shop-wide hourly cap on "phone taken" answers.
- **L4** default privileges: future functions not executable by `anon` / `PUBLIC`.
- **L6** audit inside `staff_set_pin`, `revoke_device`, `unlock_device_pin`, `create_device_pairing_code`, `merge_customers`
  and a trigger on staff role / active changes.
- **L7** `menu-images` bucket: size and picture-type limits.
- **L10** `qr_place_order` idempotency key (a second tap after a lost answer returns the same ticket).
- **M1** owner-only read of Senior / PWD records for the backup.
- **L3** (if owner agrees) new email sign-ups don't create a shop unless allowed.

Screens:
- **M1** backup + import include investors, start-up costs, Senior / PWD records and every 1.6 setting (payment methods,
  Senior %, recheck days, profit split). Z's restore drill must pass.
- **M3** Back Office: set up and use an authenticator app (TOTP) at sign-in.
- **M4** Content Security Policy on every page; move inline scripts / `onclick` out; Google Drive backup and Google Fonts
  per owner decision.
- **M5** privacy notice page, linked from the QR sign-up and the menu page; retention stated.
- **L5** unknown errors shown in plain words, not raw server text.
- **L9** `SECURITY.md` + contact line.
- **L11** error alerts: failed counter uploads reported to the Back Office (Dashboard notice).
- Owner guide: Supabase settings (Security Advisor, email confirm, password length, refresh-token reuse, URLs, users),
  remove the test counter and test PINs, CAPTCHA on, weekly backups.
