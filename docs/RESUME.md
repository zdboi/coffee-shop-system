# Resume here (save point: 2026-10-20, checkpoint 7 — LIVE)

Owner: to continue, open this project and tell C: **"Resume from docs/RESUME.md"**.

## Where we are: LIVE (2026-10-20, checkpoint 7)
- Live site https://zdboi.github.io/coffee-shop-system/ shows the new apps (PR #1 merged).
- The owner ran 004, 005 and 006 on the live Supabase, and all three are frozen. The next database script is `007`.
- The owner signed in to the Back Office, set the shop details and their 6-digit PIN, paired a test PC as a counter,
  and test sales uploaded fine.
- Two live-only issues were found and fixed:
  - pairing (`devices.device_type` rule, fixed by 005);
  - every upload failing (`sync_operations.operation_type` rule, fixed by 006).
- The owner will add the menu and shop data later.

## Next steps
1. Owner:
   - void the test sales;
   - remove the test PC when the real tablet is paired;
   - do one QR order test once the menu is in.
2. QA:
   - add the live-only CHECK rules to `tests/sql/01_existing_schema.sql`;
   - wire tests 34 and 35 into `run_all.sh`.
3. Later:
   - `007` drops `profiles.pin_hash`;
   - Senior/PWD discount button;
   - loyalty stamps;
   - prototype walkthrough;
   - CAPTCHA only if fake orders appear;
   - copy polish ("CAPTCHA" wording in `captcha.js`).
4. App changes from now on go out through a new pull request `wip/cccc-online-qr` → `main`, which the owner merges.

## Saving to Obsidian
The session note lives at `docs/obsidian/CCCC POS — session log.md` and is updated at every
checkpoint. The owner's local Claude Code copies it into the vault: "Pull the latest from GitHub and
copy docs/obsidian/CCCC POS — session log.md into my vault."

## How the team works
Rules and file owners: `CLAUDE.md`. Tests: `tests/README.md` (`tests/run_all.sh --runs 2`, about 30 min).
Save points: `docs/checkpoints.md`.
- Each agent uses its own database and port: FO `db_fo`/8790, BO `db_bo`/8791, QR `db_qr`/8792,
  DB `db_sec`, QA `cccc`/8787.
- Start PostgreSQL with `tests/start_pg.sh` after a restart.
- Test PINs: cashier 1111, manager 222222, owner 999999.
