# Release 1.5: what to do

A big update ("Wave 3"). It takes about 30 minutes. **Do it when the shop is closed**, because counters must be updated together with the database.

Your current live version (1.4.2) is saved as the **last working version** (`docs/checkpoints.md`). If anything goes wrong, tell C: **"Go back to the last working version."**

## What's new

**QR order page (customers)**
- **Guest or registered:** customers choose "Register" (collects stamps) or "Order as guest" (no name, no stamps, stamp card greyed).
- **Coffee-themed usernames:** every registered customer gets a unique one, such as "Mika the Coffee Devourer". They can change it.
- **Table limits:** at most 4 unpaid tickets per table, and one guest per table at a time. The Takeaway / Counter QR has no table limit.
- **One phone per account:** signing in on a new phone signs the old one out, and the old phone is told. Switching accounts with unpaid orders asks first; "Yes" cancels only orders still waiting.
- **Your highlighted item** shows at the top of the menu.
- **"Lactose intolerant? Have this instead"** lists the non-dairy swaps you have in stock.

**Stamp cards**
- A full card stays at 15/15 until the customer takes the last reward. Then a new card starts.
- Stamps earned in between are saved and go onto the new card.
- **Past cards** are kept with the date filled and the date completed. They show on the QR page, the counter's Customers tab and the Back Office.

**Counter**
- **Barista drink** button: one tap logs the daily calibration kit as waste.
- **Blind stock count before Close shift**, for the items you tick. Staff don't see the expected amounts. Items that differ are shown once for a recount.
- Customers without a phone number are under **Archived**.
- Sales are dated by Philippine time even if a tablet's time zone is wrong.

**Back Office**
- **Stock counts:** see each count, what was missing or extra, and revise it (needs a note).
- **R&D log:** projects, ingredients used per project, and R&D cost per project.
- **Production:** ½×, 1×, 2× or custom batch size, and **Max I can make**.
- **Made by TCO:** adds the product to stock without using your ingredients. You choose per batch what you owe: the same ingredients or pesos. A **To return to TCO** list tracks it.
- **Waste report:** **Edit** and **Delete** on each entry. Both ask why, and stock and costs correct themselves.
- **Barista drink kit** setting, **Archived** customers, usernames, and past stamp cards.
- QR table cards no longer say "Bienvenido na Kapihan!".

## Before you start
- **Close all shifts** on every counter, and make sure each counter shows "0 waiting" (everything uploaded).
- Do steps 2 and 3 **back to back**. Between them, counters on the old version can get stuck on stamp rewards.

## Steps

### 1. Download a backup (2 min)
Back Office → **Backup & import** → **Download a backup**. Keep the file.

### 2. Run the database script 012 (5 min)
1. Sign in to supabase.com with the **business account** (cavitecitycoffeeclub@gmail.com).
2. On GitHub, open `cccc/supabase/012_release_1_5.sql` on the branch `wip/cccc-online-qr`.
3. Click **Raw**, select everything (Ctrl+A) and copy it (Ctrl+C).
4. In Supabase, open the project → **SQL Editor** → **New query**.
5. Paste the script and click **Run**.
6. Wait for **Success. No rows returned**. It can take up to a minute.
   - If you see a red error, don't run it again. Copy the message and send it to C.

### 3. Publish the apps (2 min)
1. Open the pull request link C sends you.
2. Click **Merge pull request**, then **Confirm merge**.
3. Wait about 2 minutes for the site to update.

### 4. Reload every device (1 min each)
On each counter, your computer and your phone: open the app and reload the page twice.

### 5. Set up the new features (10 min)
1. **Barista drink kit:** Back Office → **Waste report** → **Barista drink kit**. Add the ingredients and amounts of one daily calibration, then save.
2. **TCO:** Back Office → **Suppliers** → add or open "TCO" → tick **Partner branch** → save.
3. **Count at closing:** Back Office → **Ingredients** → open an item → tick **Count at closing** → save. Start with 3–5 important items.
   - **Only tick items after every counter is reloaded** (step 4). An old counter can't close its shift once items are ticked.

### 6. Quick check (5 min)
1. **Counter:** start a shift, tap **Barista drink**, save. Tap **Close shift**: the count list appears. Type the amounts and close.
2. **Back Office → Stock counts:** your count is listed.
3. **Back Office → Waste report:** the barista drink is listed. Click **Edit**, change the amount, type why, save. The row shows "Edited".
4. **Phone:** scan a table QR. You should see "Register" and "Order as guest".

## Good to know
- **Customers already past 15 stamps** who haven't taken the free drink will see the card at 15/15 plus "stamps saved for your next card". The new card starts when they take the free drink. Tell your staff, so they can explain.
- **Customers with no phone number** move to **Archived**. Nothing is deleted.
- **Counts and TCO debts are not restored** by importing a backup. They live only in the database.
- **Reconnecting on a new phone:** after 5 wrong tries for one number, reconnecting is locked for that number for 24 hours. Staff can still find the customer at the counter and add sales to their card.

## If something goes wrong
Tell C what you see (a photo of the screen helps). To undo the apps, tell C: **"Go back to the last working version."**
