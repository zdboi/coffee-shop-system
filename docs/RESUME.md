# Resume here (save point: 2026-11-11, checkpoint 19, release 1.4.2 LIVE, Wave 3 building)

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

## Now (2026-11-11 20:30): Wave 3 (1.5) building. Team model changed: C builds everything, Z checks.
- **Live:** 1.4.2 (8b522f2, checkpoint 19 = last working version). Supabase project now under the business account (same URL).
- **012 (`cccc/supabase/012_release_1_5.sql`) is complete**, not yet run on live. It covers:
  - Q1–Q5, B6 QR accounts; B7 barista kit; B8 R&D; B9 counts; B11/B12 QR menu;
  - B15 production scale + TCO; B16 stamp card cycling + history; B17 waste editing.
  - Security passed everything except B17, which still needs Z's gate.
  - Contract: `docs/handoff/contract-1.5.md`. DB tests for Z to port: scratchpad `db15-tests.sql` (348 checks).
- **Shared core done.** Screens built (agent hand-off, 2026-11-11). For each, C must still review the code and Z must run the regression:
  - **Counter (`front.js`/`front.css`):** all 7 items. Expected test updates: `fo_release12` (Zed archived; wait for reward chip), `fo_release13`, `money12`. New checks: scratchpad `fo15-checks.js`.
  - **Back Office:** all items; new `bo-counts.js`, `bo-partner.js`. The BO regression suites haven't been run. Expected: `bo_release13` (tagline gone), `bo_release14` (needs 012). New checks: scratchpad `bo15.e2e.js`.
  - **QR page (`order.js`/`order.css`):** all 9 items. Expected updates: `order_extra`, `order_limits`, `order_release12`, `order_release14` (oat milk seed + lactose prompt), `captcha` step 6. New checks: scratchpad `qr15-check.e2e.js`.
- **C's next steps:**
  1. Review the three screens' code.
  2. Lead calls:
     - accept "sign out keeps the phone's anonymous login";
     - accept the counter attach-picker keeping `search_customers`;
     - keep backup format 7.
  3. ~~Build the B17 Back Office waste edit/delete UI.~~ **Done 2026-11-12** (`bo-money.js`: Edit/Delete on Waste report rows, "Why?" required, Edited mark; checks in scratchpad `b17-bo.e2e.js`, 18/18; `bo_release14` 55/55 on 012).
  4. **Z:** security gate on B17 SQL + screens review, port the db15/fo15/bo15/qr15 checks, approve the expected changes, wire 012 into the reset scripts, full `run_all.sh`.
  5. Fix findings, then the release package (`docs/RELEASE_1.5.md`, checkpoint, PR).
- **Open, waiting for the owner:** the GitHub move and nicer address (business account / own domain).
- **Usage note:** the weekly limit hit agents on 2026-11-11; it resets Nov 15, 8 PM (Manila).

### Z final run 2026-11-12 ~14:10: 82 suites, 5,406 checks, 0 failing (`scratchpad/z15/run3.out`)
- It includes Z's new checks for the gate fixes (sql/42, conc15, fo_release15). Z hit the usage limit before writing its verdict on the fixes; ask for it when it can resume (no code depends on it).
- **Wave 4 addition recorded:** B18 Sales calendar overhaul (see owner-feedback.md).

### 1.5 READY for the owner (2026-11-12 ~13:30, checkpoint 20)
- Z verdict: PASS WITH FIXES (5 Lows). C fixed Lows 1–4 (012 waste audit/`WASTE_NOT_LINKED`/cost; counter one recount round + no stock amount for counted items); Low 5 (`PHONE_TAKEN` on register) is unchanged 1.4 behaviour allowed by decision 7. After the fixes C re-ran: 012 twice, sql/42 361/0, `fo_release15` 40/0, `fo_release13` 68/0, `bo_waste_edit15` 18/0, `money15` 45/0.
- **Still to do:** Z re-check of the four fixes (42, conc15, bo_waste_edit15, money15, fo_release15) and a final full run; then PR `wip/cccc-online-qr` → main. Owner guide: `docs/RELEASE_1.5.md`. After the owner runs 012 + merges: mark 012 frozen in CLAUDE.md (next 013), checkpoint 21 = last working version, changelog, Obsidian.

### Z gate on 1.5: status 2026-11-12 12:45
- Z stopped twice on the 5-hour limit (next reset 14:30). Its test work is committed (253c2cf). **Z's security findings (B17 SQL + 1.5 screens) have NOT been delivered yet**: ask for them first when resuming Z.
- C ran `tests/run_all.sh --runs 1` at 12:00: **82 suites, 5,395 checks, 3 failing**, all three old expectations that Z must update (C never edits tests):
  1. `sql/38` "R: merge moves rewards; a reward both used is kept as history" → approved change (security Low 1: the clashing reward moves to the kept record's next free card and counts).
  2. `e2e/order_extra` "D: relink -> TOO_MANY_ATTEMPTS (relink wording)" → approved: new wording "Too many tries. Please ask our staff at the counter, or try again later." (L3).
  3. `e2e/captcha` step 6 '"Not me?": the new sign-in carries its own fresh token' → **C decision: approved.** In 1.5 a phone keeps its anonymous login when signing out (one phone per account, Q5), so there is no new sign-up and no CAPTCHA at that point. The check should assert that no new sign-up happens and the name form shows.
- After Z: fix findings → Z re-check → `docs/RELEASE_1.5.md`, checkpoint, changelog, Obsidian, PR.

## Earlier:  1.4.2 is LIVE (PR #7 merged 2026-11-10 10:54, 8b522f2 = last working version, checkpoint 19). **Wave 3 (1.5) STARTED** on the owner's go (11:06): plan `docs/PLAN_1.5.md`, DB script `012_release_1_5.sql`, contract `docs/handoff/contract-1.5.md`. Step 1 = database (db-security-engineer).

## Earlier: 1.4.2 was READY (checkpoint 18). It's a PR only, no DB; owner steps are in `docs/RELEASE_1.4.2.md` (merge → reload → check). QA: 70/70 suites, 4,283 checks, 0 failing. After the merge: checkpoint 19 "1.4.2 live" = last working version, then mark it live in the changelog. Wave 3 is still waiting for the owner's go; it includes B15 (partial/multiple production + TCO "to return" list, decided 2026-11-10) and the counter time-zone fix (QA).

## Earlier: 1.4.1 is LIVE (caecffa = last working version, checkpoint 17; 011 frozen, next script 012). Building 1.4.2 (no DB): menu link QR code (B13) and swipeable sub-category tabs (B14). The owner said on 2026-11-10 00:00 to release it as a PR once done (they first said Wave 3, then changed it). Wave 3 = everything else, not started.

## Earlier: release 1.4.1 (public menu link) was READY, waiting for the owner (`docs/RELEASE_1.4.1.md`: backup → run 011 → merge PR → reload → Settings → Menu link)
- **Contents:**
  - `public_menu` (anon, display data only, ~130 ms) and the menu link settings (011);
  - `cccc/menu/` (view-only page);
  - `/menu/` (short link + social preview tags);
  - Back Office Settings → Menu link (highlighted item, Visit us);
  - `get_qr_menu` speed-up;
  - anon table rights revoked.
- **Contract:** `docs/handoff/contract-1.4.1.md`.
- **QA:** 68/68 suites, 4,183 checks. **Security:** 011 and the client side passed (2 rounds).
- **After the owner runs 011:** freeze 011 in CLAUDE.md (next script 012, Wave 3 = 1.5), checkpoint 17, changelog.

## Earlier: release 1.4 is LIVE (PR #5 merged 2026-11-09 10:41; 651e706 = last working version, checkpoint 15; next DB script 011).
- **Lead to-do:** in the project changelog `claude/developer-changelog.md`, mark row 1.4 as live (2026-11-09, 010 run) and set "Database scripts: 004–010 run on live". Wave 3 (1.5) is NOT started: the owner said "do not start wave 3 yet". Its items: Q1–Q5 plus B6–B9 in owner-feedback.md.

### Release 1.4 (done; was waiting for the owner to publish (`docs/RELEASE_1.4.md`: backup → run 010 → merge PR → reload → photo-limit check → connect USB printer → set up)
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

## 2026-11-12 17:09: owner ran 012 on live ("Success")
- 012 is now frozen (CLAUDE.md updated); next script is 013.
- Still to do: owner merges PR #8 → then checkpoint 21 "Release 1.5 live", changelog doc, Obsidian notes.
- Note for owner guides: Supabase can't rename/save a snippet this big ("request entity too large"); harmless, the script lives on GitHub.
