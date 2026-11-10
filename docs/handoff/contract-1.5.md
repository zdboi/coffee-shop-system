# Release 1.5 (Wave 3): database contract (`cccc/supabase/012_release_1_5.sql`)
From db-security-engineer, 2026-11-10. If the script and this file disagree, the script wins; tell the lead.
"Owner only" = the owner's email login (profile ADMIN, rank 3); anything else gets `NOT_ALLOWED` (`NOT_A_MEMBER` without a shop).
Errors of owner-only RPCs are **raised** (the call fails with the code as the message, like `save_supplied_item`); QR RPCs **return** `{error: CODE}` (like 1.4); `fo_sync` answers per op `{status:'error', message: CODE}`.

## 0. Live rules changed (allowed words; every stored word kept)
| Column | Added |
|---|---|
| `inventory_transactions.transaction_type` | `PARTNER_RETURN` |
| `sync_operations.operation_type` | `stock_count` |
| `waste_logs.reason` (010 rule) | `RND`, `COUNT_SHORTAGE` |

Everything else new is a new column or a new table. **core (logic.js):** `TXN_SIGN` must add `PARTNER_RETURN: -1` (stock goes down). Back Office stock badges: label "Returned to partner".

---
## Part A. QR accounts

### A1. Guest vs registered (Q1/A6)
- A **guest** = a phone (anonymous sign-in) with **no customer record**. Guests never get a customer row, so they can't get stamps, and they never appear in customer lists.
- `qr_session(p_token)` → `{customer: {...} | null, state: 'GUEST' | 'REGISTERED'}` (+ `{error:'TABLE_NOT_FOUND'}`).
- `customer` (from `qr_session`, `qr_register`, `qr_relink`, `qr_set_phone`, `qr_set_username`) adds **`username`**.
- Registering later on the same phone: `qr_register` exactly as today (nickname, optional phone, consent). Orders placed **before** registering stay guest orders (no stamps); orders after it are the customer's.

### A2. Placing an order: `qr_place_order(p_token, p_items, p_note, p_order_type, p_guest boolean default false)`
- New 5th argument. Old 4-argument version removed (callers without `p_guest` keep working).
- Phone **without** an account: `p_guest:false` → `REGISTER_FIRST` (as before); `p_guest:true` → guest order.
- Phone **with** an account: always orders as that customer (`p_guest` ignored).
- Answer unchanged (`{order}` through `_qr_order_public`), order adds **`is_guest`** (boolean). Guest order: `customer_id` null, `customer_nickname` null.
- Checks, in this order (all inside the shop lock):
  1. per phone: 3 open unpaid → `TOO_MANY_OPEN_ORDERS`; 10 per hour → `TOO_MANY_ORDERS` (unchanged);
  2. **Q3** table: open unpaid tickets (`PENDING`/`PREPARING`/`READY`, `paid_at` null) at this table ≥ **4** → **`TABLE_FULL`** (was: 10 waiting → `TOO_MANY_ORDERS`). Accepted-but-unpaid tickets count; a paid one frees a place.
  3. **Q4** guests only: another phone already has an open unpaid **guest** ticket at this table → **`GUEST_TABLE_BUSY`** ("Register, or wait until that order is paid"). Registered customers are not limited by this.
  4. shop: 60 orders / 10 min → `TOO_MANY_ORDERS` (unchanged).
- Limits live in `_qr_limits()`: `table_open_orders 4`, `table_guests 1`. **They apply to every table, including "Takeaway / Counter"** (see open decision 1).
- `qr_orders.is_guest` is readable by counters (table read + `fo_bootstrap.qr_orders`). Counter shows "Guest" when `is_guest`.

### A3. Usernames (Q2)
- Column `customers.username` (text). Unique per shop **ignoring case**; merged-away records have none.
- Made automatically for every customer without one (backfill at install, then on every new customer from QR, counter or Back Office): `"<first word of nickname> the <coffee word> <title>"`, e.g. `Mika the Coffee Devourer`; a number is added after 20 taken tries (`Mika the Mocha Lover 42`). Nickname letters only, max 12 chars; `Kape` when nothing usable.
- Rules for a chosen username (checked by the database for **every** writer, incl. `apply_changes`): spaces trimmed / collapsed; **3–50** chars; letters (any language), digits, space, `.` `'` `-` `_` only; ≥ 2 letters; **≤ 4 digits** in total (no phone numbers); a `.` only before a space or at the end (no `x.com`); no `http`/`https`/`www` word. Else `BAD_USERNAME`; taken → `USERNAME_TAKEN`.
- **`qr_set_username(p_token text, p_username text)`** (signed-in QR customers only) → `{customer}` or `{error}`: `TABLE_NOT_FOUND`, `NOT_SIGNED_IN`, `REGISTER_FIRST`, `BAD_USERNAME`, `USERNAME_TAKEN`, `TOO_MANY_ATTEMPTS` (10 refused tries / 15 min per phone).
- Back Office edits `username` with `Ops.update('customers', {id, username})`; map `BAD_USERNAME` / `USERNAME_TAKEN`.
- Apps must not copy usernames into free text (notes, audit details): "delete customer data" only blanks nicknames in free text.

### A4. One phone per account + switching (Q5)
- **`qr_switch_account(p_token text, p_confirm boolean default false)`** (signed-in QR customers only):
  - unpaid open orders of this phone at this shop (`PENDING`/`PREPARING`/`READY`, not paid) and `p_confirm` false → `{error:'UNPAID_ORDERS', unpaid: n}`, **nothing changes**. Show "You still have unpaid orders. Do you still want to proceed?".
  - "Yes" → call again with `p_confirm:true` → those orders become `CANCELLED` (`reject_reason` "Cancelled by the customer (account switched on the phone)"), the phone is signed out → `{ok:true, cancelled:n}`.
  - no unpaid orders → `{ok:true, cancelled:0}` straight away.
- **`qr_forget_device(p_token)`** ("Not you?") = `qr_switch_account(p_token, false)`; the 1.5 page should call `qr_switch_account` directly.
- **`qr_relink`** changes: a phone that is already signed in → **`SIGN_OUT_FIRST`** (sign out with `qr_switch_account` first; answered before any number is looked at). On success the account's link on any **other** phone is removed (one phone per account; that phone becomes a guest, its unpaid orders stay payable at the counter). Rate limit / `NO_MATCH` unchanged.
- Counter: orders cancelled this way arrive as `CANCELLED` through the normal `updated_at` polling, including ones already `PREPARING`/`READY` (see open decision 2).
- Honest limit (unchanged): clearing browser data / private browsing = a new phone (a new guest).

### A5. Archived customers (B6)
- **Archived = no phone number** (`customers.phone is null`). No stored flag: adding a number un-archives automatically; merge / delete unchanged.
- **`fo_customer_list(p_search, p_limit, p_staff_token, p_sort, p_archived boolean default false)`**: `false` = main list (customers WITH a phone), `true` = the "Archived" filter (without). Search now also matches `username`. Answer adds `archived` (echo) and per customer `username`, `archived`. Old 4-arg version removed. Same rate limit / masking / money rules.
- `fo_customer_detail` unchanged (cards add `username`, `archived`). `search_customers` rows add `archived` (and `username` via the row).
- Back Office reads `customers` directly: main list = `phone` not null and `merged_into` null; "Archived" filter = `phone` null.

---
## Part B. Counter & stock

### B7. Barista calibration kit
- `settings.barista_kit` jsonb, default `[]`: `[{ingredient_id, quantity, unit}]`, ≤ 20 lines, `unit` optional (any unit converting to the item's stock unit). Saved by the owner with `Ops.update('settings', {barista_kit})`; stored tidied to exactly those 3 keys.
- `BAD_BARISTA_KIT`: not an array / > 20 / bad line / quantity ≤ 0 or > 100000 / same item twice / (when the kit changes) not this shop's switched-on, non-merged stock item / unit doesn't convert.
- Counters read it in `fo_bootstrap().settings.barista_kit` (offline-safe).
- **Saving at the counter = the existing `waste` op**, `reason:'CALIBRATION'`, `items:[{ingredient_id, quantity, unit}]` as adjusted by staff. No approval. Nothing new on the server.
- Merging ingredients doesn't rewrite the kit; a merged item in it still uploads fine (moved to the general item). The Back Office should re-save the kit after a merge.

### B8. R&D (owner only)
- Table **`rnd_projects`**: `id, business_id, name (1–80, unique per shop ignoring case → PROJECT_NAME_TAKEN), status ('ACTIVE'|'DONE'|'DROPPED', default ACTIVE), notes (≤ 500), created_at, updated_at`. Owner reads/writes via `apply_changes` (writable). Delete refused once it has usage → `PROJECT_HAS_USAGE` (mark DONE/DROPPED instead).
- **`log_rnd_usage(p jsonb)`** → `{id, project_id, used_on, total_cost, items:[{name, quantity, unit, cost}]}`
  - `p = {id (uuid from the app), project_id, used_on (date, default shop today; ≤ today+1, ≥ today−400), note (≤ 200), items: 1..30 of {ingredient_id, quantity, unit} | {recipe_id, quantity (≤ 100), modifiers}}`
  - Same `id` again → `{id, duplicate:true}` (nothing new).
  - The server works out stock + cost (same rules as the counter waste op). Saved as `waste_logs` (`reason 'RND'`, `rnd_project_id`, `device_id` null, staff = the owner's staff row) + `waste_log_items` + `WASTE` stock lines (`reference_id` = id).
  - Errors: `NOT_ALLOWED`, `BAD_RND`, `UNKNOWN_PROJECT`, `PROJECT_CLOSED` (status not ACTIVE), `BAD_DATE`, `FORBIDDEN_ROW`, `BAD_WASTE`, `BAD_QUANTITY`, `BAD_UNIT`, `UNKNOWN_RECIPE`, `UNKNOWN_INGREDIENT`.
- **`delete_rnd_usage(p_id uuid)`** → `{deleted: true|false}`: removes an R&D entry and its stock lines (stock comes back); audit "R&D usage removed".
- New `waste_logs` columns: `rnd_project_id`, `stock_count_id`.

### B8/B9 reports
- **`waste_report(p_from, p_to)`**: as 1.4, plus
  - `source`: `COUNTER` (uploaded by a counter, incl. `COUNT_SHORTAGE`) / `OFFICE` (waste table **and** R&D);
  - `entries[]` add `project_id`, `project_name`, `stock_count_id`;
  - `by_project: [{project_id, name, status, entries, cost}]` (R&D only).
- **`net_income_report(p_month)`**: as 1.4, plus `ingredients.rnd`, `ingredients.count_shortage` (both already inside `wasted` / `used`, not added again) and `rnd_projects: [{project_id, name, status, cost}]`.
- Labels: `RND` "R&D", `COUNT_SHORTAGE` "Missing at count".

### B9. Count at closing
**Setting:** `ingredients.count_at_close` boolean (default false). Owner ticks with `Ops.update('ingredients', {id, count_at_close})`. Counters read it in `fo_bootstrap().ingredients`. "Ticked items" = ticked, active, not merged, not an operating supply.

**New `fo_sync` op `stock_count`** (offline-safe):
```
{op_id, type:'stock_count', data:{
  id: uuid (made on the counter, one per count),
  shift_id, staff_id, counted_at (ISO), note (≤ 200, optional),
  lines: [{ingredient_id, quantity (≥ 0, as typed), unit (optional; default the item's stock unit)}]   // 1..300
}}
```
- Same `op_id` → `duplicate`; same `data.id` with a new op_id → `skipped`; another shop's id → `FORBIDDEN_ROW`.
- **Expected = the server's stock for that item when the op arrives**; the counter sends no expected numbers (anything extra is ignored). Per line: `difference = counted − expected` (stock units).
  - missing → one `waste_logs` entry `reason:'COUNT_SHORTAGE'` (costed, `stock_count_id` set) + `WASTE` lines;
  - extra → `ADJUSTMENT` up to the count, count flagged `COUNT_EXTRA`. Never negative waste.
  - Stock lines: `reference_id` = count id, dated the shop day of `counted_at`.
- Saved but flagged (`needs_review`, `review_reason`, comma separated): `COUNT_EXTRA`, `COUNT_INCOMPLETE` (a ticked item not in the lines), `LARGE_SHORTAGE` (missing stock worth more than `settings.payout_review_limit`, ₱1000 default), `STAFF_MISMATCH`, `FUTURE_DATE` (> 1 h ahead), `OLD_DATE` (> 7 days back), `BEFORE_START_FRESH`, `SHIFT_CLOSED` (shift already closed).
- Errors: `BAD_COUNT` (no id / no lines / > 300 / item twice / operating supply), `SHIFT_NOT_FOUND`, `UNKNOWN_STAFF`, `ROLE_TOO_LOW`, `UNKNOWN_INGREDIENT`, `BAD_QUANTITY` (missing, < 0, > 10,000,000), `BAD_UNIT`.
- Several counts for one shift are allowed; each is measured against the stock at its arrival (the latest count wins in effect).
- **Order matters:** the outbox must upload `stock_count` **before** that shift's `shift_close` (normal FIFO). A counter that names a merged ingredient still works (moved to the general one).
- Limit (inherent to offline): a sale made **before** the count on **another** counter that uploads **after** the count lowers stock again. One-counter shops are not affected; the owner can revise.

**`shift_close` change:** refused with **`COUNT_REQUIRED`** when ticked items exist and the shift has **no** count. Otherwise unchanged. ⚠ Old 1.4 counters can't send counts: the owner must not tick items until the 1.5 counter is live.

**Blind count:** a UI rule. Counters can technically still read stock (`fo_bootstrap.stock`, `v_ingredient_stock`, needed for "can make"); the count screen must not show it.

**Tables (office data, read by the owner's login; nobody writes them through the API):**
- `stock_counts`: `id, business_id, shift_id, device_id, staff_id, staff_name, signed_in_staff_id, counted_at, count_date, note, status ('SUBMITTED'|'REVISED'), shortage_cost, needs_review, review_reason, received_at, revised_at, revised_by_name, revision_note, reviewed_at`
- `stock_count_lines`: `id, business_id, count_id, ingredient_id, name, unit (stock unit), entered_quantity, entered_unit, counted, expected, difference, original_counted (first count, kept on revision), cost (shortage cost)`

**`revise_stock_count(p_count_id uuid, p_lines jsonb default '[]', p_note text default null)`** (owner only) → `{count:{...}, lines:[...]}`
- `p_lines = [{ingredient_id, quantity, unit}]`: new counted amounts for lines **of this count** (others unchanged). `[]` = only "mark reviewed".
- Expected stays as stored; missing/extra stock is re-worked from the new amounts (old count lines replaced). Clears `needs_review`; with changes sets `status:'REVISED'`.
- Audit: "Stock count revised" (`Name: old -> new unit; ...` + note) or "Stock count reviewed".
- Errors: `NOT_ALLOWED`, `COUNT_NOT_FOUND`, `BAD_COUNT`, `BAD_QUANTITY`, `BAD_UNIT`, `NOTE_REQUIRED` (an amount changes without a note).
- Back Office "Needs review": `stock_counts` where `needs_review`.

New counter error codes: `COUNT_REQUIRED` "Count the ticked items before closing the shift", `BAD_COUNT`.

### B15. Production: batch size, partner branch (TCO)
**Columns:**
- `suppliers.is_partner_branch` boolean (default false). Owner sets via `apply_changes`. Delete refused when it has debts → `PARTNER_HAS_DEBTS`.
- `production_batches.scale` numeric (null or 0 < scale ≤ 100): the Back Office sends it for **own** batches too (½× = 0.5). `source` `'OWN'` (default) | `'PARTNER'`; `partner_supplier_id`; `debt_kind` `'INGREDIENTS'|'PESOS'` (partner only). A partner batch can't be deleted (`PARTNER_BATCH_HAS_DEBT`).
- Own batches: unchanged (Back Office writes them through `apply_changes`; "Max I can make" is logic.js).

**Partner batch input** (`p`): `{id (uuid, optional), recipe_id, supplier_id, debt_kind ('INGREDIENTS'|'PESOS'), scale | expected_yield, actual_yield (default = expected), production_date (default shop today, ≤ today+1), batch_number (optional, default 'PB-YYYYMMDD-NNN'), notes}`. Yields are in the **recipe's yield unit**.

**`partner_batch_preview(p)`** (owner, saves nothing) and **`produce_partner_batch(p)`** (owner, all-or-nothing) return the plan:
```
{recipe_id, recipe_name, produced_ingredient_id, produced_name, produced_quantity, produced_unit,
 supplier_id, supplier_name, debt_kind, scale, expected_yield, actual_yield, yield_unit, production_date,
 lines:[{ingredient_id, name, unit, quantity, unit_cost, value}],    // recipe lines × scale, at OUR costs that day
 value, cost_per_unit, amount_owed (PESOS only, = value)}
 + produce only: {batch_id, debt_id, batch_number}     // same id again -> {duplicate:true, batch_id, debt_id}
```
- Produce: product stock **up** (`PRODUCTION` line, converted to its stock unit); our ingredients **not** taken; `raw_cost_total = value` (**batch cost = debt value**), `actual_cost_per_unit = value / actual_yield`; debt + lines saved; audit "Batch produced by partner".
- Errors: `NOT_ALLOWED`, `NOT_A_PRODUCTION_RECIPE`, `NOT_A_PARTNER`, `BAD_DEBT_KIND`, `BAD_SCALE`, `BAD_YIELD`, `BAD_DATE`, `BAD_UNIT`, `NO_INGREDIENTS`, `DEBT_VALUE_ZERO` (pesos but no costs known), `FORBIDDEN_ROW`.

**`partner_return(p)`** (owner; INGREDIENTS debts) → `{id, debt_id, status, value, lines:[{ingredient_id, name, quantity, unit, remaining}], stock_below_zero:[ingredient ids]}`
- `p = {id (uuid; same again → {duplicate:true}), debt_id, returned_on, note (≤ 200), lines: 1..100 of {ingredient_id, quantity, unit}}`
- Partial allowed; each line ≤ what is still owed (`RETURN_EXCEEDS_DEBT`). Stock goes down with **`PARTNER_RETURN`**: **not** ingredients used, **not** waste, **not** an expense. `SETTLED` when nothing is owed. `stock_below_zero` is a warning only.
- Errors: `NOT_ALLOWED`, `BAD_RETURN`, `DEBT_NOT_FOUND`, `WRONG_DEBT_KIND`, `DEBT_NOT_OPEN`, `NOT_IN_DEBT`, `BAD_QUANTITY`, `BAD_UNIT`, `RETURN_EXCEEDS_DEBT`, `BAD_DATE`, `FORBIDDEN_ROW`.

**`partner_pay(p)`** (owner; PESOS debts) → `{id, debt_id, status, amount, amount_paid, remaining}`
- `p = {id (uuid; same again → {duplicate:true}), debt_id, paid_on, amount (> 0), note}`. Partial allowed, never more than owed (`PAYMENT_TOO_LARGE`, 1 centavo tolerance). **Not an expense.**
- Errors: `NOT_ALLOWED`, `BAD_PAYMENT`, `BAD_AMOUNT`, `DEBT_NOT_FOUND`, `WRONG_DEBT_KIND`, `DEBT_NOT_OPEN`, `PAYMENT_TOO_LARGE`, `BAD_DATE`, `FORBIDDEN_ROW`.

**"To return to TCO": view `v_partner_to_return`** (owner, `cloud.select('v_partner_to_return', …)`), OPEN debts only:
`business_id, supplier_id, supplier_name, debt_id, batch_id, batch_number, production_date, produced_ingredient_id, product_name, kind, created_at, ingredient_id, ingredient_name, unit, owed, returned, remaining, unit_cost, value_remaining`.
INGREDIENTS rows: one per ingredient still owed, amounts in stock units. PESOS rows: `ingredient_*` null, `unit 'PHP'`, owed/returned/remaining in pesos.

**Tables** (owner reads; written only by the functions above, not by `apply_changes` or the API): `partner_debts (id, business_id, batch_id unique, supplier_id, kind, status 'OPEN'|'SETTLED', value, amount_owed, amount_paid, created_at, settled_at)`, `partner_debt_lines (id, business_id, debt_id, ingredient_id, unit, quantity_owed, quantity_returned, unit_cost)`, `partner_settlements (id, business_id, debt_id, kind 'RETURN'|'PAYMENT', settled_on, value, lines, note, created_by_name, created_at)`.

**Money rule (as PLAN_1.5):** the batch's cost = value owed, reaching recipe costs / net income only when the product is used. `PARTNER_RETURN` lines and partner payments are never counted in `net_income_report` (checked: net income unchanged after a return). Peso payments are not in `expenses`.

---
## Part C. QR menu
**`get_qr_menu(p_token)`**: same answer as 1.4.1, plus:
- **B11 `highlight`**: `null` or `{item_id, name, image_url, price, available, sold_out, label (default "Today's pick"), blurb}`. Only when the Settings → Menu link item is one of this menu's items (so `null` when the shop is closed or the item is hidden / inactive / not priced). A sold-out highlight stays (`available:false`, `sold_out:true`). Tap → open `items[]` entry with `id = item_id`.
- **B12** every option in `items[].modifier_groups[].options[]` adds **`available`** (display only). SWAP: `true` when the swap's ingredient is switched on and has at least this item's amount in stock now; every other kind: `true`. No amounts or ingredient ids are sent. Show "Lactose intolerant? Have this instead" + the SWAP options with `available:true`.
- Ordering a swap that shows unavailable is still accepted (display only, like 1.4); prices unchanged.

---
## Rights (summary)
- New QR functions `qr_set_username`, `qr_switch_account`: **authenticated only** (a QR customer is always anonymously signed in). Re-made QR functions keep their 004 rights (anon + authenticated).
- New owner functions (`log_rnd_usage`, `delete_rnd_usage`, `revise_stock_count`, `partner_batch_preview`, `produce_partner_batch`, `partner_return`, `partner_pay`): authenticated, owner checked inside.
- New tables: RLS on; `anon` nothing; counters read none of them; no API writes except `rnd_projects` (owner). `apply_changes` adds only `rnd_projects`.
- QA's F10 allow-list (suite 33) must add: `qr_set_username, qr_switch_account, log_rnd_usage, delete_rnd_usage, revise_stock_count, partner_batch_preview, produce_partner_batch, partner_return, partner_pay`.

## Old apps (1.4) against 012
- QR 1.4 page: works; never sends `p_guest`, so unregistered phones still get `REGISTER_FIRST`. "Not you?" with unpaid orders now gets `UNPAID_ORDERS` (the old page ignores it; the phone stays signed in). The table limit is now 4 unpaid tickets (`TABLE_FULL`, shown as a generic error).
- Counter 1.4: works until an item is ticked "Count at closing" (then Close shift → `COUNT_REQUIRED`).
- Back Office 1.4: works; customers lists still show archived customers until the 1.5 screens.

## Expected changes to QA's existing suites (no regressions otherwise; all other suites pass on 004–012)
- 33 F10: new functions above. 33 F5: table limit is 4 unpaid tickets (`TABLE_FULL`), accepted tickets still count.
- 39 / 40: they use phone c1 as Zed after suite 11 re-linked Zed on phone c2; with "one phone per account" c1 is a guest by then. Re-link c1 first (both suites then pass fully).
- 41 HIGH1: `get_qr_menu` now adds `highlight` and options' `available`; compare with those removed (equal).

## Owner steps (Supabase)
None besides running `012_release_1_5.sql` (SQL Editor → New query → paste the whole file → Run; "Success"). It is safe to run twice. Then: tick "Count at closing" only after the 1.5 counter is live; mark TCO as "Partner branch" in Suppliers.
