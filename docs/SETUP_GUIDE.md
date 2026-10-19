# Going live: step-by-step setup (for the owner)

This guide switches your shop to the new system. Take your time; it takes about 45 minutes.
Do it on a quiet day, after closing. You need: a computer, your Supabase login, your GitHub login.

> Tip: do the steps in order and tick them off. If anything looks different from what is
> described, stop and ask C before continuing.

---

## Part 1 — Back up first (5 min)

1. Go to **supabase.com** → sign in → open your project (**qtkoxzuedxvqoktobtyg**).
2. Left menu → **Database** → **Backups**. If your plan shows a backup from today, you're covered.
   If not, open **Table Editor**, and for each table with data (sales, ingredients, recipes…)
   click **Export → CSV**. Keep the files in a folder named `CCCC backup <today's date>`.
3. If you still use the old POS or Inventory app on a tablet, open it and use its **Backup /
   Export** button too. You will import that file into the new Back Office later (Part 5).

## Part 2 — Run the database script (10 min)

1. Open the file `cccc/supabase/004_cccc_online_qr.sql` on GitHub
   (github.com/zdboi/coffee-shop-system → branch `wip/cccc-online-qr` → `cccc` → `supabase`).
   Click **Raw**, then select everything (Ctrl+A) and copy (Ctrl+C).
2. In Supabase: left menu → **SQL Editor** → **New query**. Paste (Ctrl+V).
3. Click **Run**. Wait until it says **Success. No rows returned**.
   - If you see a red error, **don't run it again**: copy the message and send it to C.
4. Running it a second time is safe (it was tested twice in a row), but not needed.

## Part 3 — Supabase settings (10 min)

**A. Allow customer and counter logins without email**
1. Left menu → **Authentication** → **Sign In / Providers**.
2. Find **Allow anonymous sign-ins** and switch it **ON**. Click **Save**.
   (Customers' phones and your counters use this; they never see an email form.)

**B. Protect against fake sign-ups (CAPTCHA)** — ⚠️ **skip this for now.** Turning it on before
the apps support it would block every counter and customer from signing in. C will tell you
when the apps are ready; then:
1. Still in **Authentication** → **Attack Protection** (sometimes under **Settings**).
2. Turn on **Enable CAPTCHA protection**, choose **Cloudflare Turnstile**, and follow the link to
   create a free Turnstile key. Paste the **secret key** into Supabase and save.
3. Send C the **site key** (the public one). C adds it to the apps — this one is safe to share.

**C. Rate limits**
1. **Authentication** → **Rate Limits**.
2. Set **Anonymous sign-ins per hour** to **30** (per address). Save.

**D. Where email links go**
1. **Authentication** → **URL Configuration**.
2. **Site URL**: `https://zdboi.github.io/coffee-shop-system/cccc/back/`
3. Under **Redirect URLs**, click **Add URL** and add the same address. Save.
   (So "Forgot password?" emails bring you back to the Back Office.)

## Part 4 — Publish the new apps (5 min)

C prepares this for you (moving the finished work to the main branch and taking the old
POS, Inventory and test pages off the live site, as you decided). When C says it's ready:
1. Open **github.com/zdboi/coffee-shop-system** → **Pull requests** → open the one C made.
2. Click **Merge pull request** → **Confirm merge**.
3. Wait 2 minutes. Your apps are now at:
   - **Back Office:** `https://zdboi.github.io/coffee-shop-system/cccc/back/`
   - **Counter:** `https://zdboi.github.io/coffee-shop-system/cccc/front/`
   - **QR order page:** opened by scanning a table's QR code (you print these in Part 5).

## Part 5 — First setup in the Back Office (15 min)

1. Open the Back Office address and **sign in with your owner email and password**.
2. **Backup & import** → import the old app's backup file from Part 1 (if you have one).
   It's safe to run twice — nothing gets doubled.
3. **Staff & PINs** — give yourself and every manager a **new 6-digit PIN**
   (cashiers can keep 4–6 digits). The yellow banner shows who still needs one.
   Until they change it, managers can sell but can't approve refunds, voids or discounts.
4. **Settings** — check shop name, logo, tax and service charge, receipt text, QR ordering on,
   and the pay-out review limit (₱1,000 to start).
5. **Recipes & menu** — check prices, options (sizes, add-ons), photos, and which items show
   on the counter and on the QR menu.
6. **Tables & QR codes** — add your tables, then **Print QR codes** and stick one on each table.
7. **Devices** → **Pair a counter** → a 6-letter code appears. On the counter tablet open the
   Counter address and type the code (or scan the QR shown). Repeat for each counter.

## Part 6 — Test before opening (5 min)

1. On the counter: sign in with a cashier PIN → **Start shift** → sell one item → pay cash.
2. With your phone: scan a table QR → enter a nickname → order something.
   The order appears on the counter's **QR Orders** screen → Accept → Take payment → Ready.
3. In the Back Office: **Sales calendar** shows both sales. Refund one of them to see it work.
4. On the counter: **Shift & Cash** → close the shift.

All good? You're live. 🎉 If anything didn't work, note what you clicked and what you saw,
and tell C.

---

### If something goes wrong
- **Nothing is lost**: every saved step is in GitHub (see `docs/checkpoints.md`) and you made a
  backup in Part 1.
- The counter keeps selling without internet and uploads later; only manager approvals need internet.
- To unpair a lost tablet: Back Office → **Devices** → **Remove**.
- A counter locked by wrong PINs: Back Office → **Devices** → **Unlock PIN pad**.
