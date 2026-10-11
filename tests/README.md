# Tests (developer use only — not part of the website)

- `sql/` — a stand-in for Supabase internals (`00`), a reconstruction of the current live schema (`01`),
  and behaviour tests for the 004 migration (`10`, `11`), plus browser-test seed data (`20`).
  Run against a local PostgreSQL 16 (port 54329).
- `fake-supabase/server.js` — a small local stand-in for Supabase login + data API, backed by a local
  test database, so the real app pages can be tested in a headless browser. Port from `PORT`
  (default 8787), database from `FAKE_DB` (default `cccc`).
- `e2e/` — browser tests (Playwright): Front Office (`fo.e2e.js`, incl. offline selling) and the
  customer QR page (`order.e2e.js`).

Nothing here connects to the real Supabase project.

## Full regression (QA)
```bash
tests/run_all.sh          # uses database cccc + stand-in on :8787 (both belong to QA)
```

## Running in parallel (one stand-in per developer)
Each developer uses their **own database and port**. `restart_fake.sh` only restarts the stand-in on
the port you give it; stand-ins on other ports keep running. Run each line as its own command.

| Who | Reset + seed your database, then (re)start your stand-in | Open |
|---|---|---|
| Front Office | `tests/e2e_reset.sh db_fo && tests/restart_fake.sh 8790 db_fo` | `http://localhost:8790/cccc/front/` |
| Back Office | `tests/e2e_reset.sh db_bo && tests/restart_fake.sh 8791 db_bo` | `http://localhost:8791/cccc/back/` |
| QR page | `tests/e2e_reset.sh db_qr && tests/restart_fake.sh 8792 db_qr` | `http://localhost:8792/cccc/order/?t=tabletoken5` |

- Log for each stand-in: `tests/fake-<port>.log`.
- App pages are read from disk on every request, so editing them needs no restart. After a change to a
  database script, run `tests/e2e_reset.sh <db>` again (this wipes that database's data); the stand-in
  can keep running.
- Run a browser test against your own stand-in:
  `FAKE_PORT=8792 FAKE_DB=db_qr node tests/e2e/order.e2e.js`
- Try a different migration file on your own database: `tests/reset_db.sh path/to/file.sql db_bo`
  (no seed data), or `tests/e2e_reset.sh db_bo` for the default 004 script + seed data.
- Don't use `cccc` or port 8787 — those are QA's regression runs.
- No arguments = port 8787 + database `cccc` (what `run_all.sh` uses).
