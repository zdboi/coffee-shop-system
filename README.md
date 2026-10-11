# Cavite City Coffee Club — POS, Inventory & QR Ordering

One system, three doors:

| Page | Who uses it | Address (GitHub Pages) |
|---|---|---|
| **Front Office** | Staff at the counter, signing in with a PIN | `…/coffee-shop-system/frontoffice/` |
| **Back Office** | Admins only (email + password) | `…/coffee-shop-system/backoffice/` |
| **QR order page** | Customers, from the QR code on their table | `…/coffee-shop-system/order/?b=…&t=…` (made for you) |

All three use **one Supabase database**. The counter keeps selling if the internet drops: sales wait on the tablet and upload by themselves when it's back. The Back Office and the QR order page need the internet.

Everything from the previous version is kept: ingredients, purchases, production (house-made syrups/sauces with live costing), recipes and costing, inventory with waste and adjustments, suppliers, reports, branding, backups (file, folder and Google Drive), the POS with modifiers, held orders, discounts, checkout, receipts, refunds and voids that put stock back, shifts with pay-in/pay-out and cash variance, sales history and the audit log. The **sales calendar** (day / week / month / shift, hourly chart, items-by-hour, CSV) has been rebuilt.

---

## One-time setup (about 20 minutes)

### 1. Update the database
1. Open your Supabase project → **SQL Editor** → **New query**.
2. Open `supabase/004_cccc_frontoffice_backoffice_qr.sql` from this folder, copy all of it, paste, and press **Run**.
3. You should see "Success. No rows returned". It is safe to run again if you're unsure.

This also fixes two security problems in the earlier setup (any new sign-up created a business; any signed-in staff member could make themselves ADMIN).

### 2. Turn on anonymous sign-ins
Supabase → **Authentication** → **Sign In / Providers** → turn on **Allow anonymous sign-ins** → Save.

Counter tablets and customers' phones sign in this way. Without it, pairing a tablet and QR ordering will not work.

### 3. Set the website address for emails
Supabase → **Authentication** → **URL Configuration**:
- **Site URL**: `https://zdboi.github.io/coffee-shop-system/backoffice/`
- **Redirect URLs**: add the same address.

This makes "Forgot password?" and invite confirmation emails open the Back Office.

### 4. (Recommended) Check the sign-in rate limit
Supabase → **Authentication** → **Rate Limits** → *anonymous sign-ins*. Customers on your shop Wi-Fi share one internet address, so a low hourly limit can block new customers on a busy day. Raise it if needed.

### 5. Put the files on GitHub
Upload these folders and files to the `coffee-shop-system` repository, next to the existing ones: `index.html`, `config.js`, `shared/`, `backoffice/`, `frontoffice/`, `order/`, `supabase/`, `README.md`. **Keep the old `Inventory/` and `POS/` folders** until you've imported your old data.

GitHub Pages updates within a minute or two.

---

## First run

1. **Back Office** → sign in with your owner email and password.
2. **Settings**
   - *Customization*: Business Name **Cavite City Coffee Club**, app name, logo, colours (these also style the QR order page).
   - *Counter & receipts*: address, contact number, tax %, service charge %, receipt footer.
3. **Bring in your old data** (if you used the old apps): open Back Office in the *same browser* you used the old apps in → **Settings → Import / Restore**. It finds the old data in the browser automatically, or you can choose a backup `.json` file. It's safe to run twice. Old staff come in without PINs; set them in the next step.
4. **Staff & PINs**: set **your own PIN** first, then add staff. Each person needs a different 4–6 digit PIN.
   - *Cashier*: sells. *Manager*: also approves discounts, refunds and voids, and sees reports and the calendar. *Admin*: everything at the counter.
5. **Recipes & Menu**: open each drink and add **Options** (Size, Milk, Extra shot…), a short description and a photo. An option can use extra ingredients (e.g. *Large* uses +60 ml milk), so stock stays right.
6. **Devices → Pair a counter device**: you get a code like `K7QM-2XHD`. On the counter tablet, open the Front Office address and type the code. Do this once per tablet.
7. **QR Ordering**
   - **Add tables** (e.g. 1–8) and **Add take-away code** for the counter.
   - **Print QR codes**, cut them out, put one on each table.
   - Switch on **Take QR orders** and press **Save**.

---

## Daily use at the counter

1. Enter your PIN → **Start Shift** with the opening cash.
2. Sell as before. Tap **+ Add customer** on an order to give a regular their visit.
3. **QR Orders** (a sound plays and a badge shows new ones):
   **Accept** → **Mark ready** → **Ring up & pay** (puts the order in the cart; take payment as usual).
   Rejecting asks for a reason, which the customer sees on their phone.
4. **Close Shift** counts the drawer and shows over/short.
5. **Lock / Switch User** between staff.

The dot at the bottom of the menu shows the connection:
- *Online · all saved*: everything is in the database.
- *Offline · 3 waiting to upload*: keep selling; they upload by themselves.
- *1 couldn't upload*: open **This Device** to retry, and tell an admin.

---

## How customers are remembered

- The first time, a customer types a **nickname** (mobile number optional) and ticks the consent box. Their phone gets a private login, so next time the page says **"Welcome back, Zed!"** with no sign-in.
- Each visit counts on their **club card** (10 stamps per row). The numbers (visits, orders, total spent) are kept in Back Office → **Customers**, ready for a points or stamp reward later.
- **When a phone forgets them** (cleared browser, new phone, private browsing, or iPhone Safari clearing data for a site that hasn't been visited in about a week): they tap **"I've been here before"** and enter the same nickname and mobile number. That's why the page asks for the number.
- **Duplicates**: if someone signs up twice, merge them in Back Office → Customers.
- "Not Zed?" lets a different person use the same phone.

Collecting names and numbers is personal data. Check the Philippine Data Privacy Act requirements for your shop (privacy notice, how long you keep it, deleting on request).

---

## Security in plain words

- Customers' phones can't read any table. They can only see the menu, order, and see **their own** orders. Prices are always worked out by the database, never taken from the phone.
- Counter tablets can sell, but can't change prices, recipes, stock records, staff or settings.
- PINs are checked by the database and stored scrambled. After 5 wrong PINs the tablet locks for a while.
- The audit log can't be edited or deleted by anyone.
- The key in `config.js` is the *public* key. **Never put the `service_role` key in any file here.**

---

## Troubleshooting

| You see | Do this |
|---|---|
| "Anonymous sign-ins are turned off" when pairing, or "Ordering by phone is not set up yet" on a phone | Setup step 2. |
| "That pairing code is wrong or has expired" | Codes last 15 minutes and work once. Make a new one in Devices. |
| "Too many wrong PINs" | Wait the time shown. |
| "The Back Office is for admins only" | That login is a manager or blocked. Use the Front Office with a PIN. |
| Customers' orders don't appear at the counter | Check Back Office → QR Ordering → *Take QR orders* is on and the table's code is *Active*. The counter checks every 12 seconds. |
| A tablet was lost | Back Office → Devices → **Remove**. It stops working immediately. |

---

## For a developer

```
config.js                  Supabase URL + public key
shared/logic.js            costing, stock, shifts, numbering (same engine for every app)
shared/data.js             Supabase data layer: strict (Back Office) / queued with offline outbox (Front Office)
shared/import.js           importer for old-app data and backups (idempotent)
shared/calendar.js         sales calendar
shared/supa.js             client creation, phone formatting, helpers
backoffice/                app.js (previous Inventory app, adapted) + bo-extra.js (new screens)
frontoffice/               pos-app.js (previous POS, adapted) + fo-extra.js (pairing, PINs, QR queue) + sw.js
order/                     customer QR page
supabase/004_….sql         schema, row-level security and database functions
Inventory/, POS/           the old on-device apps (only needed to export old data)
```
