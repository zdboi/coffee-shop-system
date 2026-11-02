# Resume here (save point: 2026-11-02, checkpoint 11, release 1.2 LIVE)

Owner: to continue, open this project and tell C: **"Resume from docs/RESUME.md"**.

## Where we are
- **Live:** release 1.2, commit a44a123 (PR #3; 008 run on 2026-11-02). This is the **last working version** (`docs/checkpoints.md`). The next database script is 009.
- **Release 1.2** was released by the owner following `docs/RELEASE_1.2.md`:
  1. counters uploaded;
  2. backup;
  3. run `008_release_1_2.sql`;
  4. merge the pull request;
  5. reload devices;
  6. set up loyalty, floor plan, colours and brands.
- **Contents of 1.2:**
  - full redesign (tokens in `cccc/shared/brand/tokens.css`, Brunson display font, wordmark images; `docs/design/`);
  - counter: Orders grouped by sub-category, tile colours, Customers tab, stamp rewards at checkout, floor plan on QR orders;
  - Back Office: floor plan editor, sub-category colours, ingredient brands with FIFO stock and "in use" cost, loyalty settings, loyalty rewards in reports;
  - QR page: restyle and the 15-stamp card.
  - Database contract: `docs/handoff/contract-1.2.md`.
- **QA:** `tests/run_all.sh --runs 2` passes 69/71 suites (4,295 checks). The 2 failures were one counter defect (D1), since fixed and re-tested. The money, stock, cash and brand-FIFO reconciliation (`tests/e2e/money12.e2e.js`) matches to the centavo. **Final run on the finished code (2026-11-02, `run_all.sh --runs 1`): 47 suites, 3,007 checks, 0 failing.**
- **Security:** 008 passed two review rounds (all findings fixed). The 1.2 screens review found 4 low items, all fixed.

## Next: wait for the owner's go-ahead (owner: "don't proceed with 1.3 unless I say so")
Full list with decisions: `docs/owner-feedback.md` (sections "Release 1.3 …").
- **Start fresh (A4):** a one-time clear of test sales, shifts, cash and QR orders before opening day, **Nov 8, 2026**. It keeps the menu, stock setup, staff and customers. It is a separate small update and can ship before 1.3, but needs its own go-ahead.
- **Release 1.3:**
  - **QR security (Q1–Q7):** guest (= anonymous, stamp card greyed out) vs registered with a coffee-themed username; max 4 open tickets per table; 1 guest per table; one phone per account with an account-switch warning; out-of-stock items must be removed at payment (counter sales too).
  - **QR page:**
    - ticket background by stage: butter = received, olive = preparing, sage = ready (A2);
    - sub-category tile colours (A3);
    - a "Ready for pickup at the counter" banner, since every order is picked up (A5);
    - "Sarado pa po kami!" when no counter has an open shift, with stamps still visible (A7).
  - **Thermal printing (P1):** Xprinter 58 mm and other ESC/POS printers. Direct Bluetooth from Chrome/Edge on Android, Windows and Mac, found with the browser's printer chooser and reconnected automatically; 58/80 mm, paper cut, cash drawer. **No print helper for now**, so iPad and LAN printers use the print dialog.
  - **Supplied items (A8):** a one-form "buy and resell" item for supplier food and pastries (cost = price paid, margin vs selling price; stock in pieces, one per sale); house-made costing stays.
  - **Option library (A9):** shared option groups (Hot/Iced, take-away cup, extra shot, non-dairy milk swap) applied to many items with per-item untick; a new "swap ingredient" option kind.
  - **Grams for sauces (A10):** a "weighs" value per produced (and liquid) item, so recipes can use g or mL; stock and cost convert.
  - **Expenses (A11):** an "Operating supplies" category counted as an expense (not stock), an Expenses log (rent, utilities, internet, wages…) and a monthly net income report.
  - **Merge ingredients (A12):** combine same-kind ingredients into one general ingredient with brands (Full Cream Milk, Non-dairy Milk, Non-Coffee Milk, Cocoa Powder, Coffee Beans, Butter, Cream); recipes and options repointed.
  - **Tick-and-remove ingredients (A13):** like recipes; history → inactive; used-in-recipe warning.
  - **Recipes grouped + coloured (A14)** by sub-category in the Back Office.
  - **Counter waste log (A15):** menu items or ingredients, with reasons (calibration, spillage, complimentary with manager approval…); stock deducted like a sale; Back Office waste report by reason. Stamp freebies already go through rewards.
  - **Sub-category order (A16):** drag to arrange; drinks always first, then pastries/food; used on counter, QR page and recipes list.
  - **Customers tab sorting (A17):** name A–Z, most recent, most frequent.
  - **P2:** manager "retry without the reward".
  - **Optional:** T3, T4, Senior/PWD, drop `profiles.pin_hash`.
- **Menu photos (A1):** already exist; no change (owner).
- **Later, plan first:** RPG-style loyalty.

## How the team works
Rules and file owners: `CLAUDE.md`. Tests: `tests/README.md`. Save points: `docs/checkpoints.md`.
- **Databases and ports:** FO `db_fo`/8790, BO `db_bo`/8791, QR `db_qr`/8792, DB `db_sec`, core `db_core`/8795, review `db_rev`, QA `cccc`/8787.
- Start PostgreSQL with `tests/start_pg.sh` after a restart.
- **Test PINs:** cashier 1111, manager 222222, owner 999999.
- Brand source files (logo prototype zip, Brunson font) came from the owner's Downloads; the shipped copies are in `cccc/shared/brand/`.
