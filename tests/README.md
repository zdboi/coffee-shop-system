# Tests (developer use only — not part of the website)

- `sql/` — a stand-in for Supabase internals (`00`), a reconstruction of the current live schema (`01`),
  and behaviour tests for the 004 migration (`10`, `11`). Run against a local PostgreSQL 16.
- `fake-supabase/server.js` — a small local stand-in for Supabase login + data API, backed by that
  local database, so the real app pages can be tested in a headless browser.
- `e2e/` — browser tests (Playwright) for the Front Office, including offline selling.

Nothing here connects to the real Supabase project.
