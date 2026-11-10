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
  - **L3:** a phone that was signed out because its account was opened on another phone (`qr_relink`) gets **`signed_out_elsewhere: true`** with `state:'GUEST'`, **once** (the next call no longer has it). Show "Your account was opened on another phone". The note is also dropped when the phone signs in again or signs out itself.
- `customer` (from `qr_session`, `qr_register`, `qr_relink`, `qr_set_phone`, `qr_set_username`) adds **`username`**.
- Registering later on the same phone: `qr_register` exactly as today (nickname, optional phone, consent). Orders placed **before** registering stay guest orders (no stamps); orders after it are the customer's.

### A2. Placing an order: `qr_place_order(p_token, p_items, p_note, p_order_type, p_guest boolean default false)`
- New 5th argument. Old 4-argument version removed (callers without `p_guest` keep working).
- Phone **without** an account: `p_guest:false` → `REGISTER_FIRST` (as before); `p_guest:true` → guest order.
- Phone **with** an account: always orders as that customer (`p_guest` ignored).
- Answer unchanged (`{order}` through `_qr_order_public`), order adds **`is_guest`** (boolean). Guest order: `customer_id` null, `customer_nickname` null.
- Checks, in this order (all inside the shop's order lock, **including the per-phone ones** (L2), so two tabs of one phone can't both slip past a limit):
  1. per phone: 3 open unpaid → `TOO_MANY_OPEN_ORDERS`; 10 per hour → `TOO_MANY_ORDERS` (unchanged);
  2. **Q3** table (real tables only, not "Takeaway / Counter"): open unpaid tickets (`PENDING`/`PREPARING`/`READY`, `paid_at` null) at this table ≥ **4** → **`TABLE_FULL`** (was: 10 waiting → `TOO_MANY_ORDERS`). Accepted-but-unpaid tickets count; a paid one frees a place.
  3. **Q4** guests only, real tables only: another phone already has an open unpaid **guest** ticket at this table → **`GUEST_TABLE_BUSY`** ("Register, or wait until that order is paid"). Registered customers are not limited by this.
  4. shop: 60 orders / 10 min → `TOO_MANY_ORDERS` (unchanged).
- Limits live in `_qr_limits()`: `table_open_orders 4`, `table_guests 1`. **They apply to real tables only.** The "Takeaway / Counter" code (`dining_tables.kind = 'TAKEAWAY'`) never gets `TABLE_FULL` or `GUEST_TABLE_BUSY` (decision D1); the per-phone limits (3 unpaid → `TOO_MANY_OPEN_ORDERS`, 10 per hour → `TOO_MANY_ORDERS`) and the shop limit (60 per 10 min → `TOO_MANY_ORDERS`) still apply there.
- `qr_orders.is_guest` is readable by counters (table read + `fo_bootstrap.qr_orders`). Counter shows "Guest" when `is_guest`.

### A3. Usernames (Q2)
- Column `customers.username` (text). Merged-away records have none.
- **Unique per shop on a look-alike key** (L1), kept in `customers.username_key` (set only by the database; anything an app sends for it is replaced; apps never need to read or send it). Two names are "the same" when they match after: accents removed and lower case (`Míka` = `mika`); letters with a stroke / hook / bar mapped to the plain letter (`ø ð đ ħ ı ĸ ł ŋ ŧ ƀ Ɨ ƚ ƒ ɇ …` → `o d d h i k l n t b i l f e …`), `ß æ œ þ ƕ` → `ss ae oe th hv`; `.` `'` `-` `_` and runs of spaces = one space; `0` = `o`, `1` = `l`, `rn` = `m`. Taken → `USERNAME_TAKEN`.
- Made automatically for every customer without one (backfill at install, then on every new customer from QR, counter or Back Office): `"<first word of nickname> the <coffee word> <title>"`, e.g. `Mika the Coffee Devourer`; a number is added after 20 taken tries (`Mika the Mocha Lover 42`). Name part = first word of the nickname, Latin letters only, max 12 chars; `Kape` when nothing usable or when that word is a staff / shop word (nickname "Admin" → `Kape the …`). Every made-up name passes the rules below.
- Rules for a chosen username (checked by the database for **every** writer, incl. `apply_changes`):
  - first made **standard (Unicode NFKC)**, so full-width `０９１７` = `0917`, `Ｃｏｒａ` = `Cora`, special spaces = spaces (M2);
  - spaces trimmed / collapsed; **3–50** chars;
  - **Latin letters only** (a–z, with accents such as é ñ ü; Greek, Cyrillic, other scripts refused, L1), digits **0–9 only** (other digit systems refused, M2), space, `.` `'` `-` `_`; no emoji / invisible characters; the click letters `ǀ ǁ ǂ ǃ` (look like `|` and `!`) and any letter without a plain a–z form (e.g. `ƨ ȝ ƿ`) refused (re-check Low 2);
  - ≥ 2 letters; **≤ 4 digits** (0–9) in total (no phone numbers);
  - a `.` only before a space or at the end (no `x.com`); no `http`/`https`/`www` word;
  - **no staff / shop word** as a whole word, any case, accents / look-alikes ignored (L1), checked with `1` read as `l` and as `i`: `staff`, `manager`, `admin`, `owner`, `cashier`, `barista`, `cccc`, `official`, and the phrase `cavite city coffee` (`Staffy Mika` is fine; `Mika the 0wner`, `Rina the Bar1sta`, `Rina Sŧaff` are not).
  - Else `BAD_USERNAME`.
- **`qr_set_username(p_token text, p_username text)`** (signed-in QR customers only) → `{customer}` or `{error}`: `TABLE_NOT_FOUND`, `NOT_SIGNED_IN`, `REGISTER_FIRST`, `BAD_USERNAME`, `USERNAME_TAKEN`, `TOO_MANY_ATTEMPTS` (10 refused tries / 15 min per phone).
- Back Office edits `username` with `Ops.update('customers', {id, username})`; map `BAD_USERNAME` / `USERNAME_TAKEN`.
- **"Delete customer data" (`delete_customer_data`, L5)**: now blanks the customer's **username** in free text too, exactly like the nickname (whole name / whole words, any case → `[deleted customer]`: QR order notes and item notes, their sales' notes and item notes, refund reason / notes, audit details). Same signature, rights and answer as 004.

### A4. One phone per account + switching (Q5)
**Order status words used here** (`qr_orders.status`, unpaid = `paid_at` null):
| Status | Meaning | On "switch account" / "Not you?" after "Yes" |
|---|---|---|
| `PENDING` | waiting (the counter has not accepted it) | **cancelled** (`CANCELLED`) |
| `PREPARING` | being made (accepted) | **stays**, still paid at the counter |
| `READY` | ready to collect | **stays**, still paid at the counter |
| `COMPLETED` / `REJECTED` / `CANCELLED`, or already paid | finished | not counted, not touched |

- **`qr_switch_account(p_token text, p_confirm boolean default false)`** (signed-in QR customers only):
  - phone has unpaid `PENDING`/`PREPARING`/`READY` orders at this shop and `p_confirm` false → `{error:'UNPAID_ORDERS', unpaid: n, waiting: w, in_progress: k}` (n = w + k; w = `PENDING`, k = `PREPARING` + `READY`), **nothing changes**. Show "You still have unpaid orders. Do you still want to proceed?" and, when w > 0, that waiting orders will be cancelled; when k > 0, that orders being made can still be paid at the counter.
  - "Yes" → call again with `p_confirm:true` → only the **`PENDING`** ones become `CANCELLED` (`reject_reason` "Cancelled by the customer (account switched on the phone)"); `PREPARING`/`READY` stay as they are; the phone is signed out → `{ok:true, cancelled: w, kept: k}`. (Orders are locked first: one the counter accepts at the same moment is either cancelled before the accept or kept.)
  - no unpaid orders → `{ok:true, cancelled:0, kept:0}` straight away.
  - a phone with no account (guest) → `{ok:true, cancelled:0, kept:0}`; its guest orders are not touched.
- **`qr_forget_device(p_token)`** ("Not you?") = `qr_switch_account(p_token, false)` (same rule); the 1.5 page should call `qr_switch_account` directly.
- **`qr_relink`** changes: a phone that is already signed in → **`SIGN_OUT_FIRST`** (sign out with `qr_switch_account` first; answered before any number is looked at). On success the account's link on any **other** phone is removed (one phone per account, decision D3; that phone becomes a guest and its next `qr_session` says `signed_out_elsewhere`, see A1). **None of that phone's orders are cancelled** (nobody there said "Yes"; usually it is the same person on a new phone): waiting, being made or ready, they stay and are paid at the counter. Answer unchanged (`{customer, relinked:true}`).
  - Limits: 5 wrong tries per phone per 15 min (unchanged) **and (L3) 5 wrong tries per typed number per 24 hours, counted over all phones**. After that, that number answers **`TOO_MANY_ATTEMPTS`** (the same answer as the per-phone limit) for the rest of the 24 hours, even with the right nickname. It is counted per number whether or not anyone has it, so the answer never tells whether a number is registered (decision 7). The lock ends by itself; meanwhile staff serve the customer at the counter as usual (find them in Customers and add the sale to their card). The database stores a fingerprint of shop + number for this, never the number.
  - Two phones opening the same account at the same moment: the database handles them one after the other (the customer row is locked), so the account ends up on **one** phone (the later one); the other is signed out and told (`signed_out_elsewhere`). No unique rule on phone links: after a merge of two customer records both their phones legitimately point at the kept record.
  - Page copy for `TOO_MANY_ATTEMPTS` (both limits): "Too many tries. Please ask our staff at the counter, or try again later." 
- Counter: orders cancelled this way arrive as `CANCELLED` through the normal `updated_at` polling (only ever ones that were `PENDING`, so nothing the barista already started).
- Honest limit (unchanged): clearing browser data / private browsing = a new phone (a new guest).

### A5. Archived customers (B6)
- **Archived = no phone number** (`customers.phone is null`). No stored flag: adding a number un-archives automatically; merge / delete unchanged.
- **`fo_customer_list(p_search, p_limit, p_staff_token, p_sort, p_archived boolean default false)`**: `false` = main list (customers WITH a phone), `true` = the "Archived" filter (without). Search now also matches `username`. Answer adds `archived` (echo) and per customer `username`, `archived`. Old 4-arg version removed. Same rate limit / masking / money rules.
- `fo_customer_detail` unchanged (cards add `username`, `archived`). `search_customers` rows add `archived` (and `username` via the row).
- Back Office reads `customers` directly: main list = `phone` not null and `merged_into` null; "Archived" filter = `phone` null.

### A6. Next stamp card only after the last reward + card history (B16)
**The rule (one rule, worked out by the database; apps only display it).** S = card size (15), L = the **last reward** = the highest stamp in the reward list (15), T = all stamps.
- Card 1 is always issued. **Card N+1 is issued only when card N's last reward has been used** (used = a redemption not given back by a void / full refund).
- Stamps are never lost. Card c holds stamps (c−1)·S+1 … c·S. While card N is full and its last reward is not used, the card shows **N at S/S** and the stamps above N·S are **saved** (`saved_stamps`). The moment the last reward is used, card N+1 shows those saved stamps, and every reward they reach is **ready at once**. With several cards' worth saved, each new card waits for its own last reward.
- Rewards of a card not issued yet are never ready and never usable: the counter's sale upload is refused with **`CARD_NOT_ISSUED`** ("This reward is on the next stamp card. The customer gets that card after using the free drink."). Rewards of earlier cards still unused (e.g. card 1's ₱10 at stamp 5) stay usable, as before.
- Nothing new is stored: card state comes from the stamps (sales) and the used rewards, so voids, refunds and merges always agree everywhere.

**Answer** (`_loyalty_summary`, in `qr_session` / `qr_register` / … `customer`, the counter's `fo_customer_list` / `fo_customer_detail` cards, and the new Back Office read below). Same as 1.2, plus:
- `card.saved_stamps` (integer ≥ 0) and `card.last_reward_stamp` (L). `card.card_no` = the card in use; `card.stamps_on_card` 0…S; `card.milestones` statuses for that card.
- `ready_rewards`: only cards 1 … `card_no`.
- **`history`**: completed cards, oldest first: `[{card_no, filled_at, completed_at, rewards: [{stamp, type, label, amount, used_at}]}]`
  - `filled_at` = when the card's S-th stamp was earned (the time of the first sale of that stamp's shop day). Null only if the last reward is set below the card size and was used before the card was full.
  - `completed_at` = when its last reward was used (the time of that sale).
  - `rewards` = the rewards used on that card (`amount` = pesos taken off; free item = the item's price).
- Display: "Card 1 · 15/15 · 5 stamps saved for your next card. Use your free drink to start card 2." Old cards: "Card 1 · filled 16 Sep 2026 · completed 26 Sep 2026".

**Back Office read (new): `bo_customer_loyalty(p_customer_ids uuid[])`** (owner only) → `{"<customer id>": <summary>, …}` for 1…500 ids of this shop (others left out; `BAD_REQUEST` for none / > 500; `NOT_ALLOWED` for anyone else). The Back Office must use this instead of working the card out from `customers.stamps` (bo-sales.js does that today).

**Edge cases (decided):**
- **Void / full refund of the sale that used card N's last reward**: the reward is given back (1.2 rule), so **card N+1 closes again**: the customer is back on card N at S/S, the free drink is ready again, the stamps of card N+1 show as saved again, card N leaves the history. Rewards already used on card N+1 **stay used** (they were real sales) and show as used when card N+1 opens again; until then card N+1 rewards are refused (`CARD_NOT_ISSUED`). Voids keep working; nobody gets a reward twice.
- **Customer merges**: the merged record's sales and used rewards move to the kept record and the card is worked out again from the combined stamps and rewards. **Changed in 012 (re-check Low 1):** a reward BOTH records had used (same card, same stamp) is no longer kept as history only: it moves to the kept record's **lowest card where that reward is still free** (both used card 1's free drink → card 1 and card 2 free drinks used). So two used free drinks always count as two: two cards' worth of stamps give two free drinks, never three. Unchanged 1.2 rules: a reward given back by a void / refund, or already history, moves as history only (`merged_from`).
- **Delete customer data**: the used rewards are deleted with the record (as 1.2); the sales stay unlinked. No card or history is left.
- **Guests**: no customer record, so no card and no history.
- **Existing customers already past stamp 15 with the free drink unused** (live data): the same rule applies from the moment 012 is installed. They show card 1 at 15/15 with their later stamps saved; card 2 rewards that the 1.4 apps showed as ready are no longer ready until they use the free drink (nothing is lost: the moment they use it, card 2 opens with all saved stamps and its reached rewards ready). Rewards already used on card 2 under the old rule stay used.

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
  - Errors: `NOT_ALLOWED`, `BAD_RND`, `UNKNOWN_PROJECT`, `PROJECT_CLOSED` (status not ACTIVE), `BAD_DATE`, `FORBIDDEN_ROW` (the id belongs to another shop's record, **or (M1) is already used by a stock count or as the reference of any stock line**), `BAD_WASTE`, `BAD_QUANTITY`, `BAD_UNIT`, `UNKNOWN_RECIPE`, `UNKNOWN_INGREDIENT`. Apps always make a new `Cloud.uuid()` per entry, so they never hit this.
- **`delete_rnd_usage(p_id uuid)`** → `{deleted: true|false}`: removes an R&D entry and **only the stock lines it made** (M1; stock comes back); audit "R&D usage removed".
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
- Same `op_id` → `duplicate`; same `data.id` with a new op_id → `skipped`; another shop's id → `FORBIDDEN_ROW`; **(M1) an id already used by a waste entry or as the reference of any stock line → `FORBIDDEN_ROW`** (a fresh `Cloud.uuid()` per count never hits this).
- **(L4) Only ticked items may be counted:** a line for an item that is not ticked (or not switched on / merged away / an operating supply) → `BAD_COUNT`; a count while **nothing** is ticked → `BAD_COUNT`. The count screen lists exactly the ticked items from `fo_bootstrap().ingredients` (`count_at_close`).
- **Expected = the server's stock for that item when the op arrives**; the counter sends no expected numbers (anything extra is ignored). Per line: `difference = counted − expected` (stock units).
  - missing → one `waste_logs` entry `reason:'COUNT_SHORTAGE'` (costed, `stock_count_id` set) + `WASTE` lines;
  - extra → `ADJUSTMENT` up to the count, count flagged `COUNT_EXTRA`. Never negative waste.
  - Stock lines: `reference_id` = count id, dated the shop day of `counted_at`.
- Saved but flagged (`needs_review`, `review_reason`, comma separated): `COUNT_EXTRA`, `COUNT_INCOMPLETE` (a ticked item not in the lines), `LARGE_SHORTAGE` (missing stock worth more than `settings.payout_review_limit`, ₱1000 default, **in this count or in all counts of the shift together**, L4), `STAFF_MISMATCH`, `FUTURE_DATE` (> 1 h ahead), `OLD_DATE` (> 7 days back), `BEFORE_START_FRESH`, `SHIFT_CLOSED` (shift already closed).
- Errors: `BAD_COUNT` (no id / no lines / > 300 / item twice / operating supply / item not ticked / nothing ticked), `FORBIDDEN_ROW`, `SHIFT_NOT_FOUND`, `UNKNOWN_STAFF`, `ROLE_TOO_LOW`, `UNKNOWN_INGREDIENT`, `BAD_QUANTITY` (missing, < 0, > 10,000,000), `BAD_UNIT`.
- Several counts for one shift are allowed; each is measured against the stock at its arrival (the latest count wins in effect).
- **Order matters:** the outbox must upload `stock_count` **before** that shift's `shift_close` (normal FIFO). A counter that names a merged ingredient still works (moved to the general one).
- Limit (inherent to offline): a sale made **before** the count on **another** counter that uploads **after** the count lowers stock again. One-counter shops are not affected; the owner can revise.

**`shift_close` change:** refused with **`COUNT_REQUIRED`** when ticked items exist and the shift has **no count that has a line for every ticked item** (L4: a count of only some items doesn't count; if the owner ticks another item during the shift, a new full count is needed). Otherwise unchanged.

**Counter `waste` op change (M1):** an id already used by a stock count → `FORBIDDEN_ROW`. Otherwise unchanged (010). ⚠ Old 1.4 counters can't send counts: the owner must not tick items until the 1.5 counter is live.

**Blind count:** a UI rule. Counters can technically still read stock (`fo_bootstrap.stock`, `v_ingredient_stock`, needed for "can make"); the count screen must not show it.

**Stock lines of counts and R&D (M1):** the database lists the stock lines each count / R&D entry made in its own table (`stock_line_owners`, nobody reads or writes it through the API) and only ever removes those when a count is revised or an R&D entry deleted, never "every line with this reference".

**Tables (office data, read by the owner's login; nobody writes them through the API):**
- `stock_counts`: `id, business_id, shift_id, device_id, staff_id, staff_name, signed_in_staff_id, counted_at, count_date, note, status ('SUBMITTED'|'REVISED'), shortage_cost, needs_review, review_reason, received_at, revised_at, revised_by_name, revision_note, reviewed_at`
- `stock_count_lines`: `id, business_id, count_id, ingredient_id, name, unit (stock unit), entered_quantity, entered_unit, counted, expected, difference, original_counted (first count, kept on revision), cost (shortage cost)`

**`revise_stock_count(p_count_id uuid, p_lines jsonb default '[]', p_note text default null)`** (owner only) → `{count:{...}, lines:[...]}`
- `p_lines = [{ingredient_id, quantity, unit}]`: new counted amounts for lines **of this count** (others unchanged). `[]` = only "mark reviewed".
- Expected stays as stored; missing/extra stock is re-worked from the new amounts (old count lines replaced). Clears `needs_review`; with changes sets `status:'REVISED'`.
- Audit: "Stock count revised" (`Name: old -> new unit; ...` + note) or "Stock count reviewed".
- Errors: `NOT_ALLOWED`, `COUNT_NOT_FOUND`, `BAD_COUNT`, `BAD_QUANTITY`, `BAD_UNIT`, `NOTE_REQUIRED` (an amount changes without a note).
- Back Office "Needs review": `stock_counts` where `needs_review`.

New counter error codes: `COUNT_REQUIRED` "Count the ticked items before closing the shift", `BAD_COUNT`, `CARD_NOT_ISSUED` (B16, sale upload).

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
- New owner functions (`log_rnd_usage`, `delete_rnd_usage`, `revise_stock_count`, `partner_batch_preview`, `produce_partner_batch`, `partner_return`, `partner_pay`, `bo_customer_loyalty`): authenticated, owner checked inside.
- New tables: RLS on; `anon` nothing; counters read none of them; no API writes except `rnd_projects` (owner). `apply_changes` adds only `rnd_projects`.
- Internal tables with **no API access at all** (not even the owner): `stock_line_owners` (M1), `qr_signout_notices` (L3).
- New internal helpers (no API access): `_username_letters`, `_username_key`, `_username_reserved`, `_relink_subject`, `_stock_ref_taken`. `delete_customer_data` re-made with its 004 rights (owner checked inside).
- QA's F10 allow-list (suite 33) must add: `qr_set_username, qr_switch_account, log_rnd_usage, delete_rnd_usage, revise_stock_count, partner_batch_preview, produce_partner_batch, partner_return, partner_pay, bo_customer_loyalty`.
- Re-made internal (no API access, as 008): `_loyalty_summary`, `_loyalty_reward_amount`; new internal: `_loyalty_last_stamp`, `_loyalty_current_card`, `_customer_stamp_times`.

## Decisions (owner, 2026-11-10)
- **D1** "Takeaway / Counter" QR code is exempt from the per-table limits (4 open tickets, 1 guest). Per-phone and per-shop limits still apply. Real tables keep both (A2).
- **D2** Switching account / "Not you?" cancels only orders still waiting (`PENDING`); `PREPARING` / `READY` stay and are paid at the counter (A4 table). `qr_relink` cancels nothing on the phone it signs out.
- **D3** Signing in on a new phone (`qr_relink`) signs the old phone out (one phone per account).
- **D4** No undo for a partner batch with a debt (`PARTNER_BATCH_HAS_DEBT`; settle it with returns / payments).
- **D5** Stock counts and partner debts can't be restored by a backup import (they are written only by their own functions, never by `apply_changes`).
- **D6 (B16)** Next stamp card only after the last reward is used; stamps meanwhile saved; card history with both dates (A6).

## Security gate fixes (2026-11-10, lead decisions)
- **M1** Ids can't be shared between a count, a waste / R&D entry and other stock lines; counts and R&D remove only the stock lines they made (B8, B9).
- **M2** Usernames: NFKC first, digits 0–9 only, counted the same way (A3).
- **L1** Latin letters only; uniqueness on the look-alike key; no staff / shop words; made-up names always pass (A3).
- **L2** Per-phone order limits checked inside the shop's order lock (A2).
- **L3** Relink: 5 wrong tries per number per 24 h over all phones → `TOO_MANY_ATTEMPTS`; old phone told `signed_out_elsewhere` once (A1, A4).
- **L4** Counts: ticked items only; nothing ticked → `BAD_COUNT`; closing needs a count of every ticked item; `LARGE_SHORTAGE` also on the shift total (B9).
- **L5** "Delete customer data" also blanks the username in free text (A3).

## Security re-check fixes (2026-11-10)
- **Low 1** Merge: a reward both records used moves to the kept record's lowest free card (A6), instead of history only.
- **Low 2** Usernames: `ǀ ǁ ǂ ǃ` refused; stroke letters mapped in the look-alike key; letters without a plain a–z form refused; staff words also checked with `1` = `i` (A3).
- **Relink race** The customer row is locked in `qr_relink`, so simultaneous relinks end on one phone (A4).

## Old apps (1.4) against 012
- QR 1.4 page: works; never sends `p_guest`, so unregistered phones still get `REGISTER_FIRST`. "Not you?" with unpaid orders now gets `UNPAID_ORDERS` (the old page ignores it; the phone stays signed in). The table limit is now 4 unpaid tickets on real tables (`TABLE_FULL`, shown as a generic error); none at "Takeaway / Counter".
- Counter 1.4: works until an item is ticked "Count at closing" (then Close shift → `COUNT_REQUIRED`).
- QR 1.4 page: ignores `signed_out_elsewhere` (the phone just shows as signed out, as before).
- B16 with the 1.4 apps: the QR page and the counter show the server's card (now the new rule; they ignore `saved_stamps` / `history`). A 1.4 counter that sends a card-2 reward too early gets `CARD_NOT_ISSUED` (a generic error on 1.4). The 1.4 Back Office still works the card out itself from `customers.stamps` (old rule) until the 1.5 screens use `bo_customer_loyalty`.
- Back Office 1.4: works; customers lists still show archived customers until the 1.5 screens.

## Expected changes to QA's existing suites (no regressions otherwise; all other suites pass on 004–012)
- 33 F10: new functions above. 33 F5: table limit is 4 unpaid tickets (`TABLE_FULL`), accepted tickets still count.
- 39 / 40: they use phone c1 as Zed after suite 11 re-linked Zed on phone c2; with "one phone per account" c1 is a guest by then. Re-link c1 first (both suites then pass fully).
- 41 HIGH1: `get_qr_menu` now adds `highlight` and options' `available`; compare with those removed (equal).
- 38 (B16): exactly one check, **"R: card 1 all redeemed"** (customer Stampy has 15 stamps and has used all three card-1 rewards, incl. stamp 15): it expects `card_no` 1 with all milestones `redeemed`; under B16 card 1 is complete, so the answer is `card_no` 2, 0/15, all milestones `locked`, `ready_rewards` empty, and card 1 in `history`. - 38 (re-check Low 1): exactly one more check, **"R: merge moves rewards; a reward both used is kept as history"**: it expects Edge's clashing card-1 stamp-5 reward to be kept with `merged_from` set. Now it moves to Stampy's card 2 stamp 5 (counted, `merged_from` null); the count of rows left on Edge (0) is unchanged.
Every other 1.2 loyalty check passes unchanged.

## Owner steps (Supabase)
None besides running `012_release_1_5.sql` (SQL Editor → New query → paste the whole file → Run; "Success"). It is safe to run twice. Then: tick "Count at closing" only after the 1.5 counter is live; mark TCO as "Partner branch" in Suppliers.
- **Stamp cards (B16), for the owner to know:** customers who already have more than 15 stamps but haven't used their free drink will see card 1 full, with their extra stamps "saved for the next card", instead of card 2. As soon as they use the free drink, card 2 opens with all their saved stamps (nobody loses a stamp). Staff can tell them: "Use your free drink and your next card starts with your saved stamps." 
