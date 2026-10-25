# Resume here (save point: 2026-10-26, checkpoint 8, release 1.1 ready)

Owner: to continue, open this project and tell C: **"Resume from docs/RESUME.md"**.

## Where we are
- **Live:** release 1.0, commit a53238e (merged PR #1 on 2026-10-20). This is the **last working version** (see `docs/checkpoints.md`).
- **Release 1.1 (batch 1) is built, tested and reviewed** on `wip/cccc-online-qr`. It's waiting for the owner to follow `docs/RELEASE_1.1.md`:
  1. download a backup;
  2. run the read-only cash check and tell C the answer;
  3. run `007_batch1.sql`;
  4. merge the new pull request;
  5. reload the counters.
- **Batch 1 contents** (`docs/owner-feedback.md` #1–#6, T1, T2):
  - Back Office button at the bottom of the counter menu;
  - unit conversion everywhere (stored amounts stay in base units, the typed unit is only for display);
  - category manager plus Raw materials;
  - Excel import/export for recipes (`cccc/back/bo-excel.js`, vendored JSZip; imported menu items hidden by default);
  - tick-and-remove recipes;
  - ₱0 cash lines skipped in the old-backup import;
  - `fo_sync` refuses ₱0 pay-ins and pay-outs (`AMOUNT_NOT_POSITIVE`, script 007).
- **QA:** `tests/run_all.sh --runs 2` gives 60 suites and 3,716 checks, all green after the fixes. Security verdict: ready (all low findings fixed).
- **The owner's private files** are in `/home/claude/private/`: costing spreadsheets and the developer changelog. They are never committed. The changelog also lives in the Claude project docs (`claude/developer-changelog.md`) and in the owner's Obsidian.

## After the owner releases 1.1
- Mark 007 as run and frozen in CLAUDE.md; the next script is 008.
- Add checkpoint 9 "Release 1.1 live" and make it the new last working version.
- Update the changelog (1.1 = live) and send the owner the Obsidian notes.

## Next batch (not started)
- T3: `not null` and no-NaN rules on `cash_movements.amount` (008), after the owner's check.
- T4: optional review flag for large pay-ins (ask the owner).
- Later list: drop `profiles.pin_hash`, Senior/PWD discount button, loyalty stamps, prototype walkthrough, CAPTCHA only if fake orders appear.

## How the team works
Rules and file owners: `CLAUDE.md`. Tests: `tests/README.md`. Save points: `docs/checkpoints.md`.
- Each agent has its own database and port: FO `db_fo`/8790, BO `db_bo`/8791 (batch 1 also used `db_bo2`/8793 and `db_bo_a`/8799), QR `db_qr`/8792, DB `db_sec`, QA `cccc`/8787.
- Start PostgreSQL with `tests/start_pg.sh` after a restart.
- Test PINs: cashier 1111, manager 222222, owner 999999.
- The Obsidian notes live in `docs/obsidian/` (session log, public repo). The **developer changelog is private** and is never put in the repo.
