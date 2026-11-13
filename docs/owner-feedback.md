# Owner feedback from testing the live product

Collected while the owner browses and tests. **Batch 1 (#1–#6, T1, T2) started 2026-10-25** on the owner's go.
New items after this go into the next batch.

| # | Date | App | Feedback | Owner file |
|---|---|---|---|---|
| 1 | 2026-10-20 | Counter (Front Office) | Move the **Back Office** button to the bottom of the side menu. Right under "Shift & Cash" it's easy to click by accident. | front-office-dev (`cccc/front/front.js`, nav) |
| 2 | 2026-10-21 | All (project) | A **developer's changelog only the owner can access**: what changed, when, and why, release by release. Note: the GitHub repo is **public**, so it can't live there. Options: Obsidian only (private), or a separate private GitHub repo. **Owner decided (2026-10-25): Obsidian only** (never in the public repo; C also keeps a private copy in the owner's Claude project to check requests against). **Also used by C as the feature list to check every new request against** (owner, 2026-10-25), so it must cover every existing feature, not only new releases. | lead (C) |
| 3 | 2026-10-25 | Back Office: Kitchen & Stock | **Mass and volume conversion everywhere** (1000 g = 1 kg, 1000 mL = 1 L). Enter any matching unit in recipes, stock add/subtract (waste, adjustments), production and purchases, and the stock is converted automatically. Example: a recipe uses 100 g of a powder stocked in kg, so 0.1 kg is deducted. **⚠️ Partly exists:** **Purchases** already convert (buy in kg or L, stocked in g or mL; boxes ask units per box). **New:** recipes (incl. option extras), waste, adjustments and production only accept the ingredient's own base unit today. **Owner confirmed (2026-10-25):** "there will be times that the products I bought will be per Liter but the recipe will go for milliliters. I want the ease of using the unit I want and the system to automatically convert, and subtract or add it." So: any matching unit is accepted everywhere and converted to the stock unit for every deduction and addition. | core-sync (`logic.js` conversions), back-office-dev |
| 4 | 2026-10-25 | Back Office: Ingredients | Add a **"Raw materials"** ingredient category. **⚠️ Note:** the Ingredients tab already has a separate **Raw / Produced** type filter (raw = bought, produced = made in-house), so a "Raw materials" category may overlap it. Also, there's **no screen to add or rename categories** today; only 8 starter categories plus "House-Made / Produced". Suggest a small category manager so new ones can be added anytime. **Owner decided (2026-10-25):** build the **category manager** ("a nice addition"): add, rename and remove ingredient categories; then add "Raw materials" through it. | back-office-dev |
| 5 | 2026-10-25 | Back Office: Recipes & menu | **Import recipes from my Excel costing file.** Map to the recipe fields; unknown recipe categories → **Uncategorized** for me to assign; find ingredients in the file that are missing from my list and add them (unknown category → Uncategorized). **New:** today's importer only reads the app's own JSON backups. Needs the file and a decision: a one-time import done by C, or an import button in the app (that needs a spreadsheet reader bundled into the app). **Owner decided (2026-10-25):** "add an import/export from/to excel button just like what you did in my Daily Cashflow app." So: **Import from Excel** and **Export to Excel** buttons on Recipes & menu. The apps can't load outside scripts, so a spreadsheet reader (e.g. SheetJS) is bundled into `cccc/shared/vendor/` (lead). Owner sent 3 costing files (cafe, cold brew, pastry; kept privately, never committed). Layout: one sheet per recipe; columns item / UOM (pack size, no unit letters) / Unit price / quantity / Amount; yield, total cost, mark up, selling price rows. Export uses the same layout so files round-trip. | back-office-dev (+ lead for `vendor/`) |
| 6 | 2026-10-25 | Back Office: Recipes & menu | **Easily remove recipes I don't need.** **⚠️ Partly exists:** each recipe has a Delete button inside its edit window (recipes with sales/production history are hidden instead). **Owner decided:** add tick boxes on the Recipes list + "Remove selected", same safety rules. | back-office-dev |

## Team fixes queued for the same batch (found by QA, not from the owner)
| # | Date | Fix | Owner file |
|---|---|---|---|
| T1 | 2026-10-20 | Old-backup import stops on live if a cash pay-in/out is ₱0 or less (live rule `cash_movements.amount > 0`). Skip such lines and count them as "broken line skipped"; keep the test fixture as is (lead decision). | back-office-dev (`cccc/back/bo-import.js` ~272) |
| T2 | 2026-10-20 | `fo_sync` `cash_movement` should refuse amount ≤ 0 with a clear code instead of a raw constraint error (007). | db-security-engineer |

## Next batch (found during batch 1, not started)
| # | Date | Item | Owner file |
|---|---|---|---|
| T3 | 2026-10-25 | Security review (low): before 007, a counter could save a pay-in/out with no amount or "NaN" (live rule `amount > 0` lets both through). 007 blocks new ones. At release, the owner runs a read-only check for old bad rows; then a later script (008+) adds `not null` + no-NaN rules on `cash_movements.amount` (after fixing any rows found). | db-security-engineer |
| T4 | 2026-10-25 | Optional: flag very large pay-ins for review too (today only pay-outs above the limit are flagged). Ask the owner. | db-security-engineer |

## Release 1.3: QR ordering security (owner request 2026-10-29, decisions 2026-11-02; build AFTER 1.2 ships)
Reason: a photo of a table QR code lets people order from far away. Already in place (live): sign-in before ordering, one customer account per phone (server), every QR order waits for payment at the counter and can be declined, QR orders don't hold stock (stock drops only when paid), limits (3 unpaid per person, 10/hour per person, 10 waiting per table, 60 per shop per 10 min). The 1.2 counter Customers tab covers "I forgot my phone, put it under my name".

| # | Item | Owner decision |
|---|---|---|
| Q1 | **Guest or registered** sign-in on the QR page. Guests: no stamp card. Registered: stamp card + a **unique username** (two people can share a name). | Build. |
| Q2 | **Usernames for existing customers:** auto-made from the nickname, **coffee-themed**, e.g. "Mika the Coffee Devourer"; the customer can change it later. Must stay unique. | Decided 2026-11-02. |
| Q3 | **Max 4 open (unpaid) tickets per table QR** (today 10). | Build. |
| Q4 | **Only 1 guest at a time per table QR.** | Build. |
| Q5 | **One phone per account; account switching:** signing out and into another account on the same phone asks "You still have unpaid orders. Do you still want to proceed? Yes / No"; Yes removes that phone's unpaid orders. Honest limit: a web page can't read a hardware ID; each phone gets its own sign-in key tied to one account, so private browsing / clearing data looks like a new phone (per-table limits + pay-at-counter still cap it). | Build. |
| Q6 | **Stock check when paying:** if an item ran out after the order was placed, the counter is warned and **must remove the out-of-stock items** before payment goes through. Same rule for ordinary counter sales: no more "Add anyway?" for sold-out / out-of-stock items. | Decided 2026-11-02: must remove. |
| Q7 | Counter rejects/removes rogue orders (exists: Decline). Keep, restyled in 1.2. | Exists. |

## Later (planning first, don't build): RPG loyalty
Owner (2026-10-29): remake the stamp card as RPG-style mechanics: levels, perks, different rewards, tied to future promotional items (e.g. +1 stamp for a promo item). Owner will expand on it; plan together before any work. The 1.2 15-stamp card stays until then.

## Release 1.3: thermal receipt printing (owner request 2026-11-02)
Today: the counter opens an 80 mm receipt in a print window and the browser's normal print dialog (works only if the printer has a driver and is picked every time; no detection, no 58 mm, no auto cut, no cash drawer).
Owner's setup: counters on **iPad/iPhone, Android, Windows and MacBook**; printers on **Bluetooth and network (LAN/Wi-Fi)**. Build in 1.3.

| # | Item | Notes for planning |
|---|---|---|
| P1 | Find/pair the shop's receipt printers from the counter and remember them per counter; print receipts (58/80 mm), cut paper, open the cash drawer; optional kitchen/bar ticket. | Browser limits: iPad/iPhone allow no Bluetooth/USB access at all, and no browser can open a raw network printer port. So the plan must use one of: (a) **network printers with a built-in web print service** (Epson TM with ePOS-Print, Star with WebPRNT/CloudPRNT): work from every device incl. iPad, the best fit; (b) Web Bluetooth (Chrome on Android/Windows/Mac only, BLE printers only, not iPad); (c) a small print-helper app on one shop PC/Android box. Ask the owner for the exact printer brand/model before building. Keep the print-dialog version as the fallback. |
| P2 | Manager-only "Retry without the reward" for a sale refused with REWARD_NOT_AVAILABLE / REWARD_AMOUNT_MISMATCH (records full price with the real payment; the server flags it for review). | Found by front-office-dev in 1.2. |

**Printing decisions (2026-11-02):** printer is an **Xprinter 58 mm** (exact model unknown; no sticker). Make the counter ready for other common ESC/POS receipt printers too (Epson, Star, Rongta, GOOJPRT, MUNBYN, HOIN…). It must **find printers available for pairing automatically** (browsers still require one tap in their printer chooser the first time; after that it reconnects by itself). **Print helper: skipped for now**, so 1.3 = direct Bluetooth from Chrome/Edge on Android, Windows and Mac (BLE printers; build for both Bluetooth types where the browser allows and test with the owner's printer), 58/80 mm, cut, cash drawer; print dialog stays as the fallback. iPad/iPhone counters and network (LAN) printers can't print directly without the helper; the owner knows.

## Release 1.3: more owner additions (2026-11-02, after 1.2 went live)
Owner: **don't start 1.3 until I say so.**

| # | Item | Status / decision |
|---|---|---|
| A1 | Upload pictures of menu items, shrunk automatically so the app stays fast. | **Already exists** (1.0): Recipes & menu → Choose a photo, shrunk to ~600 px before upload. Owner: **keep as it is**. Nothing to build. |
| A2 | QR order ticket background colour by stage: **order received = butter, being prepared = olive, ready = sage**. | New. Text on olive must stay readable (use `--tile-olive-*` pair: dark olive bg + paper text). |
| A3 | Customer QR page uses the **same sub-category tile colours** as the counter; sub-category items sit on tiles of that colour. | New (colours come from `settings.subcategory_colors`, already sent to the counter; add to `get_qr_menu`). |
| A4 | **"Start fresh" before opening day (Nov 8, 2026):** clear all test data before a date the owner picks: sales, refunds, payments, shifts, cash pay-ins/outs, QR orders, loyalty redemptions and the stock movements from sales/refunds. **Keep** menu, recipes, ingredients, purchases, production, staff, devices, settings, floor plan, customers (their stamps/visits reset to 0 because their sales are gone). Owner-only, typed confirmation, backup first. | Owner decided: **one-time Start fresh** (not per-shift delete). **Separate small update, can ship before Nov 8, apart from 1.3**; needs its own go-ahead. |
| A5 | When an order is ready, show a **"Ready for pickup at the counter"** banner on the customer's phone. **Every order (dine-in too) is picked up at the counter.** | Partly exists: ticket says "Ready!" + tab title; dine-in wrongly says "We'll bring it to your table". Fix wording + add banner. |
| A6 | **Anonymous ordering**; the stamp card is greyed out (inactive) while anonymous. | **Overlaps Q1:** "guest" = anonymous (no name needed, stamp card greyed out). Q4 (1 guest per table) and Q3 (max 4 open tickets per table) still apply. |
| A7 | **No open shift = QR ordering closed:** show the logo and "Sarado pa po kami!"; customers can still see their stamp card and progress, but no menu and no ordering. | Partly exists (manual "pause QR ordering" switch). Owner decided: closed **automatically whenever no counter has an open shift**; opens when anyone starts a shift. Server must enforce it too (qr_place_order refuses when closed). |
| A8 | **Supplied (ready-made) food and pastries: simple "buy and resell" items.** Most food/pastries are bought from suppliers. Adding one should be one simple form: name, sub-category, supplier, unit (pcs), what I pay per piece, selling price, photo, show on counter/QR. Costing = **what I paid vs what I sell it for** (margin shown). It is an **inventory item**, not a produced item: purchases add pieces, each sale deducts 1 piece, waste and counts work as for other stock, out-of-stock = sold out. **Keep the house-made / production costing** for foods made in-house later. | **Partly possible today but clunky:** you'd have to create an ingredient (pcs), record a purchase, then create a recipe that uses 1 piece of it. 1.3 adds a **"Supplied item"** shortcut that creates and manages both as one item (one screen to add, restock, price and see margin); existing recipe and production costing unchanged. Decision on layout during 1.3 planning. |
| A9 | **Shared options ("option library")**: create option groups once and apply them to many items, then untick the items where they don't apply. Examples for Drinks: **Hot / Iced**, **take-away cup (hot cup / iced cup)**, **add extra double shot espresso**, **swap to non-dairy milk**. | **Today options are per item only** (each recipe has its own option groups; no copy or shared groups). New in 1.3: an Options library in Recipes & menu; each group is ticked on for a whole type/sub-category by default (e.g. all Drinks) with per-item untick; editing a library group updates every item using it; items can still have their own extra groups. **Planning notes:** (1) extras already deduct stock (e.g. +18 g beans for a shot); (2) a **swap** (dairy → oat milk) needs a new kind of option that takes one ingredient off and puts another on, in the amount the item's recipe uses (12 oz vs 16 oz differ), affecting stock, cost and the server's price/stock checks; (3) take-away cups can deduct cup stock; (4) Hot/Iced can be a required choice. Details to confirm with the owner in 1.3 planning. |
| A10 | **Weigh house-made sauces/syrups in grams.** Some produced sauces/syrups are weighed when making drinks, not measured by volume. Let me enter the **weight of the produced item** (e.g. "1 L of caramel weighs 1,250 g") so recipes can use **grams** for it accurately. | **New.** Today units convert only inside one family (g↔kg, mL↔L); grams and mL can't be mixed for one ingredient. 1.3: a "weighs" field on the item (weigh a measured amount once; optionally record each production batch's weight too). Recipe lines (and option extras) can then use g or mL for that item; stock stays in its own unit, and cost and stock convert through the weight. Offer it for bought liquids too (e.g. condensed milk), unless the owner says produced items only. |
| A11 | **Operational expenses.** Utility/miscellaneous items (aluminium foil, dishwashing liquid, sponges…, today in the "Others" category) cost money but their use can't be tracked accurately. Make them a **separate category that counts as an operational expense**, plus (owner, 2026-11-02) a **simple expenses log for other costs** (rent, electricity, water, internet, wages, etc.) so reports show **net income per month**. | **New** (no expenses feature today; every purchase is stock). 1.3: (1) an "Operating supplies" category: buying these records an **expense**, not stock (no stock count or low-stock alerts, not in inventory value or recipe costs); existing "Others" items can be moved there; (2) an **Expenses** screen in the Back Office: date, category (supplies, rent, utilities, internet, wages, repairs, other), amount, note, optional receipt photo; (3) a **monthly report**: sales − cost of ingredients used − operating expenses = net income. Owner-only (Back Office). Wages here are a simple amount per entry, not payroll. |
| A12 | **Generalised ingredients: merge same-kind ingredients into one with brands under it**, so menu making is easier and new brands go under the same ingredient. Owner's groups: **Full Cream Milk** (Arla, Laciate); **Non-dairy Milk** (oat, soya… as brands of ONE ingredient: owner keeps one type in stock at a time, and whichever is in stock is the swap option); **Non-Coffee Milk** (Selecta); **Cocoa Powder** (Bensdorp, + JB15 if used); **Coffee Beans** (60-40 Arabica, South City Coffee Roasters); **Butter** (Magnolia, Queensland); **Cream** (Bunge, Monna Lisa). | **Brands under one ingredient already exist** (1.2: FIFO stock per brand, cost follows the brand in use, recipes use the general name). **New in 1.3:** a **Merge ingredients** tool (Back Office): pick ingredients → name the general one → each becomes a brand keeping its purchases/stock (g/kg, mL/L converted) → every recipe line, option extra/swap and production line is repointed → preview first, all-or-nothing save. Owner chose **1.3** (not with Start fresh). The non-dairy swap option (A9) uses Non-dairy Milk, so it draws from whatever brand is in stock (FIFO). |
| A13 | **Remove several ingredients at once with tick boxes.** | **Partly exists:** each ingredient's edit window has Delete / Make inactive; tick-and-remove exists for Recipes (1.1) but not Ingredients. 1.3: tick boxes on the Ingredients list + "Remove selected", same safety rules as recipes: an ingredient with history (purchases, stock movements, production) is **made inactive** instead of deleted; one still used by an active recipe, option or production recipe is listed first so the owner can fix those recipes (or cancel); brands of removed ingredients go with them. One confirmation, all-or-nothing save. |
| A14 | **Recipes list grouped by sub-category, with the sub-category colours** (like the counter's Orders screen). | **Partly exists:** the Recipes list has a sub-category filter and a small colour dot per recipe (1.2), but it's one flat list. 1.3: section headings per sub-category (with count), recipe cards coloured in their sub-category's tile colour, same order as the counter; filter and tick-and-remove still work. |
| A15 | **Daily wastage at the counter (Front Office).** Reasons such as: calibration / barista drinks, spillage, complimentary, stamp freebies, etc. | **New at the counter** (waste today is Back Office only, per ingredient; production has its own shortfall reasons). 1.3: a "Log waste" button on the counter. Staff pick **menu items** (with options) or single ingredients, a quantity and a reason (Calibration / barista drink, Spillage, Complimentary, Expired / spoiled, Other + note). Stock is deducted the same way a sale would (recipe + option extras), cost is shown in Back Office waste reports per day and per reason, and it works offline (uploads later). **Stamp freebies:** a free item given through the stamp card is already recorded as a ₱0 sale with a "Loyalty reward" (1.2), and its stock is already deducted, so logging it again as waste would count it twice. Freebies stay on the reward path; the waste list only offers "Stamp freebie (given outside the app)" if the owner wants it. **Suggested default:** Complimentary needs a manager's approval (it's free product), the other reasons don't. |
| A16 | **Arrange the order of sub-categories on the menu**, on the counter AND the customer's QR page. General rule: **drinks always come first, then pastries and food.** | **New** (today the counter sorts sub-categories A–Z; items inside keep their own sort order). 1.3: a drag-to-arrange list in Recipes & menu (next to Sub-category colours), saved once for the shop and used by the counter, the QR page and the Back Office recipes list (A14). Drinks sub-categories are always kept above pastry/food ones: the owner arranges within each block. New sub-categories go to the end of their block until moved. |
| A17 | **Counter Customers tab: sort by name (A–Z), most recent visitors, or most frequent visitors.** | **New** (today the list comes in one fixed order with a nickname search). 1.3: a sort switch on the Customers tab; the server sorts (so it works with the 50-per-page limit and the search); the choice is remembered on that counter. Same masking/money rules as 1.2. |
| A18 | **QR code printouts in the café's theme** (logo, Brunson wordmark, brand colours). | Partly exists: Tables & QR codes prints plain QR cards. Wave 1 (1.3). |

## Release 1.4 (Wave 2) decisions (owner, 2026-11-02 23:10)
- Owner: "009 is live… proceed with the next wave."
- **A9, non-dairy swap price:** **one extra price for all** (e.g. +₱30), set once in the option library.
- **A9, take-away cups:** **counted as stock.** Cups and lids are stock items, a take-away choice deducts them, and low-stock warnings apply.
- **A15, waste approval:** **only Complimentary** needs a manager's PIN. Calibration, spillage and expired don't.
- **A10, "weighs":** **house-made (produced) sauces only.** Bought liquids stay in mL.

## Release 1.4 addition: thermal printing on Mac (owner, 2026-11-08 20:34)
- Owner: "Before we put 1.4 live, fix the thermal printer logic. MacBooks are having a hard time recognizing the printer; the app must automatically print orders and the shift report on the thermal printer, not prompt to save as PDF."
- **Mac counter browser:** Brave. Brave blocks some device access by default. Chrome is recommended.
- **Connection:** Xprinter 58 mm over a **USB cable** (WebUSB, reconnected silently).
- **Prints automatically:** the receipt after payment, a barista order ticket, QR orders when they arrive (one counter only), and the shift (Z) report when the shift closes. The X report prints on tap.
- **No print dialog on its own.** "Use print screen" only appears as an explicit button after a failure.

## New items for after 1.4 (owner, 2026-11-09 02:00), not yet planned
- **B1. Accounting overview:** one page showing gross sales, net sales, expenses, waste amount, discounts, voids and more.
  - Overlaps the 1.4 Net income page, the Waste report, and Reports (sales summary, Discounts, Refunds & voids).
  - Proposal: grow Net income into this page instead of adding a duplicate.
- **B2. Investor equity:** new; nothing like it exists. Details still to settle: capital contributions, ownership %, profit share and payouts, payback. Capital must never be counted as an expense or as sales.
- **B3. Referrals and other perks (future):** new.
  - Can reuse the stamp-card rewards (1.2) for referral rewards.
  - Can reuse the Wave 3 usernames and registration as referral codes.
  - Overlaps the planned RPG loyalty perks, so plan the two together.
- **B4. Edit payment methods (owner, 2026-11-09 02:03):** the owner wants Cash, GCash, QR payment, Card and Bank transfer, and to be able to edit the list.
  - Today the list is fixed in code: Cash, GCash, Maya, Card, Other. The database also accepts BANK.
  - There is no edit screen. It overlaps nothing.
- **B5. Extra charge per payment method (owner, 2026-11-09 02:03):** new; only the shop-wide service charge exists today.
  - PH rules (DTI DAO 21-03, DAO 10 s.2006, Consumer Act) appear to bar charging card/digital buyers more than the displayed price. A cash discount is allowed.
  - Waiting for the owner to choose among:
    - a surcharge anyway;
    - a cash discount instead;
    - tracking the provider's fee as the shop's cost.
- **B5 decision (owner, 2026-11-09 02:06):** "go for C and put it in accounting overview."
  - Build an extra charge per payment method, set by the owner per method (amount or %), shown on the counter screen and on the receipt.
  - It is calculated in the shared totals (`computeSaleTotals`) and checked by the server like tax and the service charge.
  - The Accounting overview shows payment-method charges collected as their own line.
  - The owner was told about DTI DAO 21-03 and takes responsibility for using it.
- **Planned placement (pending the owner's go):**
  - Wave 3 (1.5) = QR accounts and security.
  - Wave 4 (1.6) "Money & owners" = B1 Accounting overview, B2 investor equity, B4 editable payment methods, B5 payment-method charges.
  - Later, planned together: B3 referrals and RPG loyalty.

## New items for Wave 3 (owner, 2026-11-09 10:55); decided
- **B6. Customers with or without a phone number (owner):** "segregate customers who input their numbers and those who don't; for those who don't, automatically archive their data."
  - **Decision: hide right away.** Customers with no phone never show in the main lists, only under "Archived"; their data is kept.
  - Overlaps the Wave 3 guest/registered work (Q1/A6), which changes the same customer data, so it is built there.
- **B7. "Barista drink" button (owner):** "houses the calibration pull, milk, sauces and syrups used; all counts as wastage; done every day for coffee quality."
  - **Decision: a one-tap daily preset.** The owner sets the usual kit once in the Back Office. Staff tap the button, adjust amounts and save.
  - It saves as a waste entry with reason CALIBRATION.
  - Overlaps the 1.4 waste log (reason "Calibration / barista drink"), which it reuses.
- **B8. R&D (owner):** "input ingredients/items to an R&D section; all used for research and development of new products; counts as wastage."
  - **Decision: a Back Office R&D log.** Ingredients used are logged with a project name. They count as waste (new reason RND) and show as R&D cost per project in reports.
  - Overlaps the waste log and Waste report (1.4), which it reuses.
- **Placement:** all three join **Wave 3 (1.5)**, with QR accounts & security.
- **B9. End-of-shift stock count (owner, 2026-11-09 11:03):** "a checklist on the POS to input the actual count/weight of products before closing shift; missing stock counts as waste; prompt to double check before confirming; only the admin can revise."
  - **Overlap:** the Back Office already has "Adjust stock" (one item at a time) and "Record waste". There is no counter count and no count list.
  - **Decisions:**
    - **Which items:** the owner ticks "Count at closing" per ingredient or item in the Back Office, and only those appear.
    - **Blind count:** staff don't see expected amounts. The double-check prompt then lists only the items that differ, so staff recount those before confirming.
    - **Required before Close shift.** It works offline and uploads later.
    - **Missing amounts** are recorded as waste with a new reason, COUNT_SHORTAGE (shown as "Missing at count").
    - **Extra stock** raises stock to the count and is flagged in "Needs review". It is never negative waste.
    - **Only the owner (ADMIN)** can revise a submitted count, in the Back Office, with an audit entry.
  - **Placement:** Wave 3 (1.5).

## Brand: tagline dropped (owner, 2026-11-09 16:39)
- Owner: "Drop the Bienvenido na Kapihan. I don't want that to be our catchphrase anymore."
- **Done:** the HD logos and banners (given as a ZIP) no longer have the tagline. The stacked logo also loses the two rules and stars around it, and the horizontal logo's name is re-centred.
- **Still in the app:**
  - the "Bienvenido na Kapihan!" footer on the branded QR table cards (`cccc/back/bo-admin.js`);
  - the web-size wide/stacked logo images in `cccc/shared/brand/`, which aren't shown on any screen;
  - the QR stamp card header says "Bienvenido!", a different phrase.
- Waiting for the owner on whether to change these now or in Wave 3.

## B10. Public menu link for social media (owner, 2026-11-09 19:07)
- Owner: "Design a simple visual menu that changes with the current available menu, integrated in the app, so when somebody on social media asks for a menu I can send a link."
- **Overlap:** the QR order page already shows the live menu, but only through a table QR token, and that link allows ordering. A view-only public link is new.
- **Decisions (19:08):**
  - **Link:** a view-only page with no ordering, no sign-in and no customer data.
  - **It shows:** prices (including option prices), photos, and location & hours (typed once in Settings). Open/closed status is not wanted.
  - **Sold-out items** are shown greyed out as "Sold out today".
  - **First step:** a design mock on the design canvas (phone view + link preview), then build.
- **Build needs** (when approved):
  - a new anonymous read-only RPC, e.g. `public_menu(p_shop)`, returning display data only (no stock amounts, no ids that matter);
  - a new page under `cccc/menu/`;
  - Settings fields for address, map link, hours and socials.
- **B10 addition (owner, 2026-11-09 19:23):** "include an option where I can put a highlight product among the products available."
  - **Overlap:** none (no featured-item feature exists).
  - **Lead defaults:**
    - **One** highlighted item, chosen in Back Office → Settings → Menu link.
    - Optional label (default "Today's pick") and a short blurb.
    - Shown as a large photo card at the top of the menu link.
    - If it's sold out today it stays, greyed, with "Sold out today".
    - Menu link only (not the QR order page) unless the owner asks.
- **B11 (owner, 2026-11-09 19:24):** "put [the highlighted product] on the QR ordering page too, but in the Wave 3 update."
  - Wave 3 (1.5) shows the same highlighted item (set in Settings → Menu link) at the top of the QR order page, so customers can tap it to order.
- **B12 (owner, 2026-11-09 23:46), for Wave 3:**
  - **QR table cards:** remove "Bienvenido na Kapihan!" from the printed cards. The stamp card's "Bienvenido!" was not mentioned, so it stays.
  - **Non-dairy swap wording on the QR page:** replace "In place of the usual" with a prompt, "Lactose intolerant? Have this instead", followed by the non-dairy swap options that are available right now (in stock, not sold out).
  - Lead note: availability per swap option may need `get_qr_menu` to say whether each swap's milk is in stock (display flag only, no amounts).

## Menu link QR + swipeable tabs (owner, 2026-11-09 23:53), now part of Wave 3
- PR #6 (1.4.1) was already merged when this came in, so these go into a small **1.4.2** with no database change.
- **B13. QR code for the menu link:** Back Office → Settings → Menu link shows the QR, with Download PNG/SVG and Print card. The card is branded, says "Scan for our menu", and has no tagline.
  - **Overlap:** the table QR cards already exist (1.3). They are reused for the look, but they are table-order codes, not the menu link.
- **B14. Shorter menu page:** sub-categories become tabs, with one panel each that people can swipe left and right. This replaces the long single scroll.
- **Open question:** did the owner run `011_release_1_4_1.sql` before merging? Until it is run, the menu link shows "not available".
- **Owner (2026-11-09 23:55):** B13 and B14 move to **Wave 3 (1.5)**. Building them now is fine, but they are released together with Wave 3, not as a separate 1.4.2.
- **Owner (2026-11-10 00:00):** ran 011 before merging #6, so 1.4.1 is live. On B13/B14: "then you can proceed if only a pull request is needed". Release them as **1.4.2** (a PR only, no DB) once tested, not with Wave 3.

## B15. Partial & multiple production + TCO procurement (owner, 2026-11-10 00:11), Wave 3
- Owner: "allow Partial & Multiple production. I need to be able to produce sauces/syrups based on what are the available amount of ingredients. If some ingredients are currently scarce, I might produce a half-production… Also, allow me to be able to procure productions from TCO (my first coffee shop branch)… TCO will produce some of our sauces using their own ingredients. Keep a 'to return' list so I will know what ingredients I need to give back to TCO."
- **Overlap check (lead):** Back Office → Production already scales ingredients by *expected yield ÷ the recipe's normal yield*, so typing half the normal yield already makes a half batch, and double makes two batches. What's new:
  - quick batch-size buttons (½×, 1×, 2×, custom);
  - "how much can I make with what's in stock?" (the biggest batch the scarcest ingredient allows, with that ingredient named);
  - producing from TCO: adds the product to stock without taking our ingredients, and records what's owed to TCO;
  - a "To return to TCO" list, cleared when ingredients are given back (logged as stock leaving).
- **Owner decisions (2026-11-10):**
  - Batch size: ½×, 1× and 2× buttons, a custom size, and **"Max I can make"**, which fills in the biggest batch current stock allows and names the scarce ingredient.
  - TCO debt: **chosen per batch**. Either the same ingredients back (worked out from the recipe) or a peso amount (valued at our ingredient costs).
  - TCO is **just a name in our list** for now, a supplier-like contact. It doesn't join as a second shop in the app.

## Team fix queued for Wave 3 (QA, 2026-11-10)
- Counter dates stock lines and the "Today · all counters" view by the device's own clock day, not by Manila time. There's no effect while the tablet is set to Philippine time. Fix: use the shop time zone (front-office-dev, with core-sync-engineer for `todayISO`).

## Wave 3 decisions (owner, 2026-11-10 11:2x)
- **Takeaway / Counter QR:** exempt from the 4-tickets and 1-guest-per-table limits. The per-person and per-shop limits still apply.
- **Account switch:** cancels **only orders still waiting**. Orders already being made or ready stay, and are paid at the counter.
- **Lead defaults accepted:**
  - signing in on a new phone signs the old phone out;
  - no undo for a TCO batch with a debt;
  - counts and TCO debts aren't restored by backup import.
- **Accounts move (owner question, 11:20):** the owner wants the app under the business email (cavitecitycoffeeclub@gmail.com) on Supabase and GitHub, and a more professional link. Plan given:
  - transfer the Supabase project to a business organization;
  - move the GitHub repository to a business account/organization, or use their own domain;
  - leave a forwarding page at the old address;
  - re-pair the counters.
  - Not started; waiting for the owner to choose the address.
- **Supabase moved (owner, 2026-11-10 12:29):** the owner transferred the Supabase project to the business account. The project URL is unchanged (`qtkoxzuedxvqoktobtyg`), and the Back Office and counter uploads work. No app change is needed. From now on, 012 and later scripts are run from the business account. The GitHub move/address change is still pending the owner's choice.

## B16. New stamp card after the last reward + card history (owner, 2026-11-10 15:20), Wave 3
- Owner: "when stamp cards are completed by certain customers, they will be issued another stamp card. Their previous stamp card will be kept along with the date it's been completed. Only issue another stamp card after the customer took the last reward."
- **Overlap (lead):**
  - Since 1.2, stamps already roll onto card 2 automatically: stamp 16 starts card 2, even if the stamp-15 reward wasn't taken.
  - Rewards of earlier cards stay available.
  - There is no card history screen and no completion date.
- **Owner decisions (2026-11-10):**
  - The next card is issued only once the customer takes the card's **last reward**.
  - Stamps earned while the full card waits are **saved** and land on the new card as soon as it's issued. Nobody loses a stamp.
  - A finished card shows **both dates**: when it was filled (15th stamp) and when the last reward was taken.
  - Old cards are visible **everywhere**: the QR page, the counter Customers tab and the Back Office.

## B17. Edit the waste report (owner, 2026-11-11 20:09), Wave 3
- Owner: "I also want to be able to edit the wastage report."
- **Overlap (lead):** waste entries can't be changed or deleted after saving today (counter waste log, Back Office "Record waste"). Wave 3 already adds "revise a stock count" (owner only) and "delete an R&D entry"; this extends the same idea to every waste entry.
- **Owner decisions (2026-11-11):**
  - **Edit everything + delete:** amount, reason, note and date; or delete the entry. Stock and cost reports correct themselves to match.
  - **Owner only, with a record:** Back Office owner login only. Each edit or delete needs a short note and is saved in the audit log with the old and new values. The entry shows an "Edited" mark.
- **Lead notes:**
  - "Missing at count" waste is changed by revising its stock count, not edited directly (one source of truth).
  - Complimentary waste keeps its manager approval record.
  - Finished sales stay unchangeable; this is waste only.

## B18. Sales calendar overhaul (owner, 2026-11-12 16:51), **next wave (Wave 4 / 1.6)**
- Owner: "I want a more thorough overview of the Sales Calendar: I want to see voids/refunds. I want to see the net income. the wastages. Fixate the calendar so I always see it. Also, I want to be able to check all the collective data from a span of days by clicking an initial date and an ending date. You can check the calendar logic of the Infusion Gem app. I don't need the average sales so you can put the Net sales there. In the Items Sold, separate the Drinks from Food/Pastries."
- **What it means:**
  - Per day and per selected range: voids/refunds, net income, waste.
  - The calendar stays fixed on screen (always visible while the details scroll).
  - Range selection: click a start date, then an end date (across months, like the owner's Infusion Gem app calendar); totals for the whole span.
  - Replace "Average sale" with **Net sales**.
  - Items sold split into **Drinks** and **Food / pastries**.
- **Overlap (lead):**
  - The Sales calendar exists (day, week, month views; 1.0).
  - Net income (monthly) and the Waste report exist (1.4).
  - Wave 4's B1 Accounting overview already plans "any date range" with voids, waste and net income. B18 puts the same numbers on the calendar; both should read one shared server report so they always agree.
- Not started. Build with Wave 4.

## Wave 4 scope change (owner, 2026-11-12 17:24)
- Owner: "dont include B2 yet. Include the Senior/PWD discount but allow us to change the percentage."
- **B2 Investor equity: taken out of Wave 4** (later, not dropped).
- **B19. Senior/PWD discount: added to Wave 4**, with a percentage the owner can change (default 20%).
  - **Overlap (lead):** today a manager can already type any % or ₱ discount at the counter (the box even suggests "20 (Senior/PWD)"). That is a general discount with a manager PIN. B19 adds a dedicated Senior/PWD button with the owner's set %, and keeps the general discount as it is.
  - To settle at planning: manager PIN or not; whether to record the ID number and name (and who may see them); VAT exemption on top of the 20% (PH law, RA 9994 / RA 10754); per item vs whole order (group orders where only some diners are senior/PWD); how it shows on the receipt and in reports.
- **Wave 4 (1.6) "Money" now = B1 Accounting overview, B4 editable payment methods, B5 payment-method charges, B18 Sales calendar overhaul, B19 Senior/PWD discount.**

## B5 change: add or waive (owner, 2026-11-12 17:30)
- Owner: "as for the extra charge per payment, allow us to tick a box whether we add it or waive it and absorb the charge."
- Meaning: the charge can be added to the customer's bill, or waived so the shop absorbs it. Waived charges show in the Accounting overview as a shop cost (not hidden).
- To confirm at planning: tick per sale at the counter, with a default per payment method in Settings; whether waiving needs a manager.

## B19 question (owner, 2026-11-12 17:30)
- Owner asked why the Senior/PWD perk keeps being suggested if a manual discount already exists.
- Lead answer: the manual % discount already gives the 20% off. A dedicated button would only add the legal record-keeping (VAT exemption, ID number/name log, a Senior/PWD report). It sat in the "optional extras" list because of that overlap. Waiting for the owner: keep B19 (with those legal parts) or drop it and keep using the manual discount.

## B19 decision (owner, 2026-11-12 17:32)
- Owner: "okay we keep the modification on that discount for the POS to be more proper documentation."
- **B19 stays in Wave 4**: a Senior/PWD button with the owner's set % (default 20%), VAT exemption, a record of name + ID number per sale (owner-only to read in full), and a Senior/PWD report for the accountant. The general manual discount stays as it is.
- Still to settle at planning: manager PIN or not; group orders (only the senior/PWD's own items); receipt wording.

## B20. Smart stock count (owner, 2026-11-12 17:35), Wave 4 (1.6)
- Owner: "I also want the new stock checklist to be a smart stock checklist. Only ask for the current count of stocks that have moved. I don't want to count daily even the stocks or ingredients that has not moved."
- **Overlap (lead):** the 1.5 blind count asks every item ticked "Count at closing" at every Close shift (client `countAtCloseIngredients`, server `COUNT_REQUIRED`). B20 changes which ticked items are asked; nothing else repeats.
- **Owner decisions (17:3x):**
  - "Moved" = **any change at all** since the item was last counted (sales, production, waste, R&D, purchases, deliveries, corrections, TCO).
  - Items that haven't moved are still asked **once a week** (safety check for stock that goes missing unlogged).
  - Build **with Wave 4 (1.6)**, not as a separate update.
- Lead notes: the server must decide which items are due (same rule on counter and server; offline counters use the last list they downloaded plus their own sales). Count stays blind.
- **Wave 4 (1.6) now = B1, B4, B5 (add-or-waive), B18, B19 Senior/PWD, B20 smart stock count.**

## Wave 4 go-ahead and decisions (owner, 2026-11-12 17:37)
- Owner: "You can now start with wave 4".
- **B19 Senior/PWD:** any cashier can apply it, no manager PIN; the name and ID number are required; every use shows in the Senior/PWD report. On a group order it applies **only to the items the cashier ticks**.
- **B5 waive:** any cashier can tick "waive" on a sale; waived charges are listed in the Accounting overview with who waived them.
- **B4 starting list:** Cash, GCash, QR payment, Card, Bank transfer. Maya and Other are switched off (old sales keep their method). The owner can edit the list afterwards.

## B2 back in Wave 4: investors + start-up costs (owner, 2026-11-13 10:13)
- Owner (with the sheet "CCCC Initial Funds and Expense"): "Can I also integrate this data in the app. these are the initial investments and the initial expenses made. also make it so that I can add/remove/replace investors and their investment values."
- Overlap (lead): this is B2 investor equity, moved out of Wave 4 on 2026-11-12; Expenses (1.4) exists but is for running costs.
- Sheet: 5 investors = ₱200,000 (Mama Lorna 50,000; Jake 30,000; Renan 40,000; Jom 40,000; Zed 40,000; a "?" row with no amount, left out); 61 start-up costs = ₱195,871 (no dates); cash left ₱4,129.
- **Owner decisions (10:1x):** build it **in Wave 4 now**; start-up costs are **separate "start-up costs", NOT taken off any month's net income**; ownership % **follows the amounts** (amount ÷ total, updates by itself).
- Lead scope: Back Office → Money → Investors & start-up: investors (add / edit / remove, amount, date, note), start-up costs (add / edit / delete, date, category, note), paste rows straight from Excel (name + amount), totals: invested, start-up costs, cash left, each person's %, and each person's share of net income for any dates (information only). Payouts / payback tracking: later.

## Supplied sauces / syrups (owner, 2026-11-13 10:31)
- Owner: "Include sauces, syrups, and foods to Supplied items". Asked what for: **"Use them in drinks"**.
- Lead: already supported, nothing to build. Food is already a supplied item type (resold per piece). Bought-ready sauces and syrups used in drinks are normal (raw) ingredients: Ingredients → + Add ingredient (category Syrups & Sauces, stock in mL or g), then Purchases, then in recipes / the Options library. Told the owner how.
- Owner (10:32): **"I need it in grams too"** → bought sauces / syrups (counted in mL) may now have "Weighs", so drinks can use them in grams. This reverses the 1.4 owner decision of 2026-11-02 ("bought liquids stay in mL"). Built into 1.6: 013 re-makes `_ingredient_check` without WEIGHS_PRODUCED_ONLY; the Back Office shows "Weighs" when editing any item counted in g / mL.

## Release 1.6 live + profit split (owner, 2026-11-13 15:03)
- 1.6 is live: owner ran 013 and merged PR #9 (14:54).
- Owner: "the investor's percentage to the net income is only 30%, 20% goes to the managers (Jake & I, yes we also get from the previous 30% aside from this), 50% goes to the coffee shop".
- Decisions: managers' 20% **split equally** (10% each); the split (30 / 20 / 50) and the managers' names are **editable** in the Back Office; investors' 30% still follows each investor's amount; managers also get their investor part.
- Built as **1.6.1** with database script **014** (013 was already run).
- Owner (15:33): "the calendar in sales calendar is a little bit awkwardly small… it cant even fit the numbers properly." → 1.6.1: calendar column about half the page (min 480px), taller day boxes, bigger day numbers and amounts that never wrap; cards beside it wrap to fit; below 1,150px wide the calendar goes full width above the details (not pinned). CSS only (back.css).
- Owner (15:35): "you can put the tiles, texts, and data below the calendar." → 1.6.1: calendar full width on top, all cards and the day-by-day table below it. The calendar is no longer pinned while scrolling (this replaces the B18 "fixed calendar" layout; owner's newer instruction).

## Saved ideas for later (owner, 2026-11-13 21:09)
- Owner asked about cloning the POS for a client restaurant (20:56): **standalone copy (option 2)**, no loyalty card, so no customer data. Three-way system: **BOH** kitchen inventory with production; **FOH** bar inventory, POS, QR ordering; **Management** overview of all + accounting. Lead answered what carries over and what is new (see RESUME "Saved ideas").
- Owner asked (21:06): "can other people currently copy my coffee shop app?" Lead: most likely yes, the repo is public for free GitHub Pages; data is safe; options: LICENSE file, private repo + Cloudflare Pages, or private repo + GitHub Pro.
- Owner (21:09): **"Save this Idea. I'll come back to it later."** → both ideas saved; nothing to build until the owner says so.
