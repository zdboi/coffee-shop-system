# Prototype walkthrough: paused (resume after Stage 3)

Goal: a click-through walkthrough of the three apps (customer QR page, counter, Back Office)
built from real screenshots of a demo shop, published as a page the owner can open anywhere.
Paused on 2026-10-12 at the owner's request: finish testing and fixes first.

## What is ready
- `demo_seed.sql`: a demo shop for screenshots. It adds:
  - 11 menu items, with Size / Milk / Add-on options, plus suppliers and stock (two items are low on purpose);
  - tables 1–6 plus Takeaway, and 5 loyalty customers;
  - 13 days of sales history (about 375 sales), with closed shifts and 2 sales flagged for review.

  It is loaded on top of the browser-test seed, on a local test database only.
- `capture.js`: a Playwright script that plays one full story and saves the screens.
  1. A customer registers on the QR page and orders.
  2. The counter pairs, signs in and starts a shift.
  3. The counter sells, accepts the QR order, takes GCash payment and marks it ready.
  4. The customer sees "Ready" and "Welcome back".
  5. It visits every Back Office screen, then the tablet and phone sizes.
- The last full run captured every customer and counter screen without errors. Back Office screens all captured on the run before that.

## How to run it
```bash
tests/e2e_reset.sh db_lead
psql -h /tmp -p 54329 -U postgres -d db_lead -q -v ON_ERROR_STOP=1 -f docs/prototype/demo_seed.sql
tests/restart_fake.sh 8795 db_lead
mkdir -p docs/prototype/shots && node docs/prototype/capture.js   # saves into docs/prototype/shots/
```

## What is left
1. Re-run once after the Stage 3 fixes, so the screens show the final version.
2. Look through every shot. One thing to check: in the Back Office calendar's day chart, the hover label may sit over the wrong hour's bar.
3. Build the walkthrough page with three tabs (Customer · Counter · Back Office), screens in story order and one plain sentence under each. Publish it as an artifact.
4. Note for the owner: the sandbox can't load Google Fonts, so the screenshots use fallback fonts. The live site looks slightly different.
