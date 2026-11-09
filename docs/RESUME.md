# Resume here (save point: 2026-11-09, checkpoint 14, release 1.4 READY; live = 1.3)

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

## Now: release 1.4 is READY, waiting for the owner to publish (`docs/RELEASE_1.4.md`: backup → run 010 → merge PR → reload → photo-limit check → connect USB printer → set up)
- **Contents:**
  - A12 merge ingredients; A10 weighs; A9 option library + LINE_TOTAL swap + cups/lids; A8 supplied items; A15 counter waste log;
  - A11 expenses, net income, waste report;
  - **owner addition:** USB thermal printing on the Mac (receipt, barista ticket with a fixed PAID / NOT PAID line, QR tickets on arrival (off by default, one counter), Z on close, X on tap; no print dialog by itself).
- **Contract:** `docs/handoff/contract-1.4.md`.
- **QA gate:** 65/65 suites, 4,019 checks, 0 failing. money14 matches the server to the centavo.
- **Security:** 010 (2 rounds + 2 deltas) and screens + printing all passed; every finding is fixed.
- **After the owner runs 010:**
  - freeze 010 in CLAUDE.md (next script 011);
  - checkpoint 15 "1.4 live"; changelog.
- **Next waves (owner decides when):**
  - Wave 3 = 1.5 QR accounts & security;
  - Wave 4 = 1.6 "Money & owners": B1 Accounting overview, B2 investor equity, B4 editable payment methods, B5 per-method charge (option C, shown in the Accounting overview);
  - later: B3 referrals with RPG loyalty. See `docs/owner-feedback.md`.

## Now: release 1.3 is LIVE (owner ran 009 + merged PR #4, 2026-11-02 23:00; commit abcff5b = last working version, checkpoint 13). Next: Wave 2 = release 1.4 (owner said go, 2026-11-02); next DB script 010.

### Release 1.3 (done)
- **Owner steps:** `docs/RELEASE_1.3.md` (backup → run `009_release_1_3.sql` → merge the PR → reload → set up → Start fresh before Nov 8).
- **Built:**
  - P1 printing (`cccc/shared/printer.js`, counter printer screen);
  - A7 closed QR page;
  - A2/A5 ticket colours and pickup banner;
  - A16/A3/A14 sub-category order and colours;
  - Q6 out-of-stock at payment;
  - A17 customers sort;
  - P2 retry without the reward;
  - A13 tick-and-remove ingredients;
  - A18 branded QR cards;
  - A4 Start fresh.
- **Also fixed:** a Back Office window race (a late closeModal after a save's reload closed a newer window; test `bo_modal_race`).
- **QA:** `tests/run_all.sh --runs 1` gives 54/54 suites, 3,414 checks, 0 failing.
- **Security:** 009 passed two rounds. The client review said "ready", and its 3 low items (receipt line breaks, drawer setting manager-only + audited, last-sale button cleared on lock) are fixed.
- **After the owner runs 009:** mark 009 frozen in CLAUDE.md (next script 010), add checkpoint 13 ("1.3 live"), and update the changelog.
- **Open, optional:** a password re-check before Start fresh (offered; the owner hasn't answered).
- **Waves 2 and 3** (releases 1.4 and 1.5) start only when the owner says.

## Release 1.3 plan (all waves; Wave 1 done)
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
