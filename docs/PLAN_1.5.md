# Release 1.5 plan: Wave 3 "QR accounts, counts & production"

Owner go-ahead: 2026-11-10 11:06 ("I already did the merging. we can proceed with wave 3").
- Item details and owner decisions: `docs/owner-feedback.md` (Q1–Q5, A6, B6–B9, B11, B12, B15, and the QA time-zone fix).
- Live = 1.4.2 (8b522f2, checkpoint 19). Next database script: `cccc/supabase/012_release_1_5.sql`.
- Live CHECK rules are older than our reconstruction. Every new value written to a live column (waste reasons, inventory transaction types, audit actions…) is checked against `tests/sql/01_existing_schema.sql` + 004–011 first.

## Items

### Part A: QR accounts & security
| Item | What | Decided |
|---|---|---|
| Q1/A6 | **Guest or registered** on the QR page. A guest orders with no name; the stamp card shows greyed ("Register to collect stamps"). A registered customer has a nickname, a unique username and the stamp card. A guest can register later from the same phone; orders made after registering earn stamps. | Owner. |
| Q2 | **Coffee-themed unique usernames.** Made automatically from the nickname for existing and new customers (e.g. "Mika the Coffee Devourer"). The customer can change it; it must stay unique per shop (case-insensitive) and be checked by the server (length, allowed characters, no phone numbers or links). | Owner. |
| Q3 | **At most 4 open (unpaid) tickets per table** (was 10). | Owner. |
| Q4 | **One guest per table at a time.** A second guest at a table that already has a guest with an open ticket is asked to register (or wait). Registered customers aren't limited by this rule (Q3 still applies). | Lead reading: "at a time" = while that guest has an open ticket. |
| Q5 | **One phone per account + account switch warning.** Each phone's sign-in is tied to one account. Signing out and into another account on a phone with unpaid orders asks "You still have unpaid orders. Do you still want to proceed?". Yes cancels that phone's unpaid orders (server-side). Limit noted: clearing browser data looks like a new phone. | Owner. |
| B6 | **Customers with no phone go straight to "Archived".** Hidden from the main lists (counter Customers tab, Back Office Customers) and shown under an "Archived" filter. Data kept. Guests are never listed as customers. | Owner: hide right away. |

### Part B: counter & stock
| Item | What | Decided |
|---|---|---|
| B7 | **Barista drink button** (counter). One tap opens today's calibration kit (set once in Back Office → Settings or Waste); staff adjust amounts and save. It saves as waste, reason CALIBRATION, through the existing waste op. Works offline. | Owner: one-tap daily preset. |
| B8 | **R&D log** (Back Office). Projects with a name and status; log ingredients used per project. They count as waste with a new reason RND. R&D cost per project shows in the Waste report and Net income (as waste). | Owner. |
| B9 | **Blind end-of-shift stock count.** Back Office: tick "Count at closing" per ingredient or supplied item. Counter: before Close shift, staff type the counted amount for each ticked item, without seeing what's expected. Confirming shows a double-check listing only the items that differ, for a recount. Missing stock becomes waste reason COUNT_SHORTAGE ("Missing at count"). Extra stock raises stock to the count and is flagged in "Needs review" (never negative waste). Works offline (new outbox op `stock_count`). Required before Close shift when any item is ticked. Only ADMIN can revise a submitted count, in the Back Office, with an audit entry. | Owner. |
| B15 | **Partial and multiple production.** The Produce form gets ½×, 1×, 2× buttons and a custom size, plus **"Max I can make"**, which fills in the biggest batch current stock allows and names the ingredient that limits it. **Production from TCO:** a batch can be marked "Made by TCO". It adds the product to stock without taking our ingredients. What we owe is chosen per batch: the same ingredients back (worked out from the recipe at that batch size) or a peso amount (valued at our ingredient costs). A **"To return to TCO"** list shows open debts. Returning ingredients records them as stock leaving (new type) and clears the debt, fully or partly. Paying pesos clears a peso debt. **Money rule (lead):** the TCO batch's cost is the value of what we owe, so its cost per unit flows into recipe costs and Net income only when the product is used. Returning ingredients or paying the pesos is settling that debt, so it is never counted again as ingredients used, waste or an expense. TCO is a supplier flagged "partner branch", not a second shop. | Owner. |
| QA fix | Counter dates stock lines and "Today · all counters" by Manila time, not the device's clock zone (`todayISO` → shop day). | Lead. |

### Part C: QR page & menu
| Item | What | Decided |
|---|---|---|
| B11 | The highlighted item (Settings → Menu link) also shows at the top of the QR order page; tapping it opens the item to order. Hidden if it's not on the QR menu. | Owner. |
| B12 | Remove "Bienvenido na Kapihan!" from the printed QR table cards (the stamp card's "Bienvenido!" stays). On the QR page, the non-dairy swap shows **"Lactose intolerant? Have this instead"** followed by the swap options available right now (in stock, not sold out). `get_qr_menu` sends a display-only "available" flag per swap choice (no amounts). | Owner. |

## Build order
1. **Database + contract** (`db-security-engineer`): `012_release_1_5.sql` + `docs/handoff/contract-1.5.md`. Then the `security-reviewer` gate.
2. **Shared core** (`core-sync-engineer`): shop-day helper (`todayISO` in Manila), outbox op `stock_count`, count shortage/extra maths in `logic.js`, production batch scaling and "max I can make" and TCO debt maths in `logic.js` (one shared function each, used by every screen).
3. **Screens, in parallel:**
   - **QR page** (`customer-qr-dev`): guest/registered, usernames, account-switch warning, greyed stamp card, highlight, lactose prompt.
   - **Counter** (`front-office-dev`): Barista drink button, blind count before Close shift, archived customers hidden, time-zone fix.
   - **Back Office** (`back-office-dev`): Count at closing ticks, count review and revise, R&D log, barista kit settings, Produce form scaling and TCO, To return list, Archived customers, table cards without the tagline.
4. **QA:** full regression, new suites, and a money/stock reconciliation covering counts, R&D, TCO batches and returns. Then a security review of the screens. Then the release package (`docs/RELEASE_1.5.md`).
