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

## Part B: security hardening
Waiting for Z's full audit (Part 3) of 1.6.1; the plan is written from its findings plus the known gaps.
