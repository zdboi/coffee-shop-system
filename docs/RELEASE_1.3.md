# Release 1.3: what to do

This update takes about 25 minutes. Do it when the shop is quiet (ideally after closing). Every counter should have uploaded its sales first.

Your current live version (1.2) is saved as the **last working version** (see `docs/checkpoints.md`). If anything goes wrong, tell C: **"Go back to the last working version."**

## What's new
- **Receipt printer (counter):** connect your Xprinter 58 mm (or another receipt printer) directly from the counter.
  - **What it can do:** print each receipt automatically, cut the paper, and open the cash drawer on cash sales.
  - **Which devices:** works on Chrome/Edge on Android, Windows and Mac. iPad/iPhone still use the normal print screen.
- **"Sarado pa po kami!" (QR page):** when no counter has an open shift, customers see this instead of the menu.
  - Their stamp card still shows.
  - Orders can't be placed while the shop is closed.
- **QR ticket colours and pickup banner:**
  - ticket colours: butter = received, olive = being made, sage = ready;
  - a **"Ready for pickup at the counter"** banner shows when an order is ready.
- **Sub-category order:**
  - You choose the order in which sub-categories appear, with drinks always first.
  - The counter, the QR page and the Recipes list all follow it.
  - In the Back Office, recipes are grouped and coloured by sub-category.
- **Out-of-stock check at payment (counter):**
  - If an item ran out, the counter asks you to remove it, or lower the quantity, before taking payment. This includes QR orders.
  - "Add anyway?" is gone. Sold-out items can't be added.
- **Customers tab sorting:** name A–Z, most recent, most frequent.
- **"Retry without the reward"** (managers): fixes a sale the server refused because of a stamp reward. The sale is saved at full price and marked for you to review.
- **Tick-and-remove ingredients** (Back Office), like recipes.
- **Branded QR table cards:** printouts in the café's look, 1, 2 or 4 per page.
- **Start fresh:** a one-time clear of your test sales before opening day (step 7).
- **Warning about forgotten shifts:** the Back Office warns you when a shift has been left open for more than a day. Close such shifts, or the QR page stays "open".

**Good to know:**
- With automatic printing off, the receipt window no longer pops up after every sale. Tap **Print receipt** on the empty order instead, or turn automatic printing on in the printer screen.
- Only a manager or the owner can change **"Open the cash drawer on cash sales"**, and every change is written to the log.

## Steps

### 1. Let every counter finish uploading (1 min)
On each counter, check that the upload status says **"all saved"**.

### 2. Download a backup (2 min)
Back Office → **Backup & import** → **Download a backup**. Keep the file.

### 3. Run the database script 009 (3 min)
1. On GitHub, open `cccc/supabase/009_release_1_3.sql` on the branch `wip/cccc-online-qr`.
2. Click **Raw**, select everything (Ctrl+A) and copy it (Ctrl+C).
3. On supabase.com, open your project and click **SQL Editor** → **New query**.
4. Paste the script and click **Run**.
5. Wait for **Success. No rows returned**.
   - If you see a red error, don't run it again. Copy the message and send it to C.

**From now on, the QR page shows "Sarado pa po kami!" whenever no shift is open.** That is expected.

### 4. Publish the apps (2 min)
**Do this right after step 3.**
1. Open the pull request link C sends you.
2. Click **Merge pull request**, then **Confirm merge**.
3. Wait about 2 minutes for the site to update.

### 5. Load the new version (1 min per device)
On each counter, your computer and your phone, open the app and reload the page twice.

You should see a printer button at the bottom of the counter's side menu ("Printer not set up").

### 6. Set it up (10 min)
1. **Sub-category order:**
   1. Back Office → **Recipes & menu** → **Arrange sub-categories**.
   2. Drag the sub-categories into the order you want (drinks stay first), then click **Save order**.
2. **QR table cards:**
   1. Back Office → **Tables & QR codes** → **Print QR codes**.
   2. Choose 1 per page (poster), 2 per page (A5) or 4 per page (table tents).
3. **Receipt printer** (on each counter that has one):
   1. Turn the Xprinter on.
   2. On the counter, tap the **printer button** at the bottom of the side menu, then **Connect Bluetooth printer**.
   3. Pick the printer from the list. If it isn't listed, tap **Show all Bluetooth devices**.
   4. Tap **Print test slip**.
   5. Switch on **"Print the receipt after each sale"** if you want automatic receipts. A manager can also switch on **"Open the cash drawer on cash sales"**.
   - **Still not listed on a Windows or Mac computer?** Many Xprinter 58 mm models use the older kind of Bluetooth:
     1. Pair the printer in the computer's Bluetooth settings first (PIN is usually `0000` or `1234`).
     2. Back on the counter, tap **Connect printer port** and pick the printer from the list.
   - On an Android tablet, the printer must be listed under **Connect Bluetooth printer**. If it isn't, tell C the printer's model.

### 7. Start fresh before opening day (5 min, once, before Nov 8)
This deletes your **test** sales, shifts, cash movements and QR orders before a date you choose.

- **Kept:** the menu, recipes, ingredients and stock setup, staff, tables and customers.
- **Reset:** customers' stamps and visits go back to zero.

**When:** after your last test sale, and before the first real sale. The best time is the night before opening, or the morning of **Nov 8** before you open. The date and time you pick can't be in the future.

1. On every counter: let it upload, then **close every open shift**. Start fresh refuses to run while any shift is open.
2. Back Office → **Backup & import** → **Open Start fresh** (owner login only).
3. **Step 1:** click **Download a backup**, or tick that you already have one from today.
4. **Step 2:** leave the date and time at **now** (everything rung up before this moment is removed). Click **Check what will be removed** and read the list: how many sales, shifts and orders will go, and how stock changes.
5. **Step 3:** type `START FRESH` and confirm.

It can't be undone, except by restoring the backup, so do it only once and only when you're ready.

### 8. Quick check (3 min)
1. **Counter:**
   1. Open a shift.
   2. Sell one item and check that the receipt prints.
   3. Void the sale.
2. **QR page:** on your phone, scan a table card. The menu should show, with drinks first.
3. Close the shift, then reload the QR page. It should show **"Sarado pa po kami!"**.

## If something goes wrong
Tell C what you see (a photo of the screen helps). To undo the whole update, tell C: **"Go back to the last working version."**

The database script doesn't need undoing, because the old apps keep working with it.
