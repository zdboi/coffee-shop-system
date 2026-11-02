# Release 1.3 plan: 20 owner items grouped into 3 waves

Owner (2026-11-02): "Let's run it… plan, analyze, and see what builds together instead of running it from 1–20."
Item details and decisions: `docs/owner-feedback.md` (Q1–Q7, P1–P2, A1–A17, T3–T4).

## Why waves
The items fall into three groups that each change the same parts of the system. Building a group together means each database area is changed once, tested once and security-reviewed once. Shipping in waves keeps every update small enough to test properly and to roll back on its own. It also lets the opening-day items reach the shop **before Nov 8**.

Each wave is a normal release with its own database script, last-working-version checkpoint, QA run, security review and owner steps.

## Wave 1: "Opening day" (release 1.3, target before Nov 8)
Things the shop needs on day one. Mostly screens; small, low-risk database changes.

| Item | What | Touches |
|---|---|---|
| A4 | **Start fresh**: one-time clear of test sales, shifts, cash and QR orders before a chosen date; keeps menu, stock setup, staff, customers (stamps reset) | DB function (owner only), Back Office screen |
| P1 | **Thermal printing**: Bluetooth receipt printers (Xprinter 58 mm + common ESC/POS brands), browser printer chooser, auto-reconnect, 58/80 mm, cut, cash drawer; print dialog fallback | shared core, counter |
| A7 | **"Sarado pa po kami!"** when no counter has an open shift (stamps still visible, no menu); server refuses orders when closed | DB (menu + place order), QR page |
| A2, A5 | **QR ticket colours by stage** (butter / olive / sage) + **"Ready for pickup at the counter"** banner; every order is picked up at the counter | QR page |
| A16, A3, A14 | **Sub-category order** (drinks first; drag to arrange) and **colours** on the counter, the QR page and a **grouped, coloured Recipes list** | settings (DB), shared core, all three apps |
| Q6 | **Out-of-stock check at payment**: items that ran out must be removed before payment (QR and counter sales; no more "Add anyway?") | counter, shared core, server flag |
| A17 | **Customers tab sort**: name A–Z, most recent, most frequent | DB function, counter |
| A13 | **Tick-and-remove ingredients** | Back Office |
| P2 | Manager **"retry without the reward"** | counter |
| A18 | **Branded QR code printouts**: table QR cards in the café's look (logo tile, Brunson wordmark, terracotta/butter colours, table name, "Scan to order" + short how-to) | Back Office print screen |

## Wave 2: "Menu & inventory" (release 1.4)
All change how menu items, ingredients, stock and costs work, so they must be designed together: one ingredient model, and one way a sale takes stock off, on the counter, the server and the QR page.

| Item | What |
|---|---|
| A12 | **Merge ingredients** into general ingredients with brands (Full Cream Milk, Non-dairy Milk, Non-Coffee Milk, Cocoa Powder, Coffee Beans, Butter, Cream) |
| A9 | **Option library**: shared option groups applied to many items, untick per item; new **swap** option (e.g. dairy → non-dairy milk in the drink's own amount) |
| A10 | **Grams for sauces/syrups**: a "weighs" value so recipes use g or mL |
| A8 | **Supplied items**: one-form buy-and-resell food and pastries (cost vs price, stock in pieces) |
| A15 | **Counter waste log** with reasons (complimentary needs a manager) |
| A11 | **Expenses**: Operating supplies as an expense (not stock), an expenses log, monthly net income |

Build order inside the wave:
1. Merge (A12) and grams (A10) first, since they settle the ingredient model.
2. Then options and swaps (A9), supplied items (A8) and waste (A15), which use it.
3. Expenses (A11) last, since it is mostly separate.

## Wave 3: "QR accounts & security" (release 1.5)
Everything about who can order from a table, built and reviewed as one security unit.

| Item | What |
|---|---|
| Q1, A6 | **Guest (anonymous) or registered** sign-in; guests have a greyed-out stamp card |
| Q2 | Unique **coffee-themed usernames** (existing customers get one automatically) |
| Q3, Q4 | **Max 4 open tickets per table**, **1 guest per table** |
| Q5 | **One phone per account**; switching accounts warns and removes that phone's unpaid orders |

**Owner (2026-11-02): approved; start Wave 1 now, plus A18. No optional extras for now.**

## Optional extras (owner: none for now)
- **T3:** cash amount rules; needs the owner's read-only check first (wave 1).
- **T4:** large pay-in flag (wave 1).
- **Senior/PWD 20% discount** (wave 2, with the menu and money work).
- **Drop `profiles.pin_hash`** (any wave).

## Not in 1.3–1.5
- **RPG-style loyalty:** plan together first.
- **Print helper:** owner skipped it for now.
