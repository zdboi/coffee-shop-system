# Release 1.4: what to do

This update takes about 20 minutes, plus set-up time you can spread over a few days. Do it when the shop is quiet (ideally after closing). Every counter should have uploaded its sales first.

Your current live version (1.3) is saved as the **last working version** (see `docs/checkpoints.md`). If anything goes wrong, tell C: **"Go back to the last working version."**

## What's new
- **Merge ingredients** (Back Office → Ingredients → tick several → **Merge into one**): combine same-kind ingredients into one general ingredient, such as Full Cream Milk or Coffee Beans.
  - Each old ingredient becomes a brand of the new one, keeping its stock and purchases.
  - Recipes and options are updated for you.
  - You see exactly what will change before anything is saved.
- **Options library** (Recipes & menu → **Options library**): make an option group once and use it on many items.
  - Starters: **Hot or iced** (required), **Take-away cup** (takes off a cup and a lid), **Extra shot**, **Non-dairy milk swap** (one extra price for every drink).
  - You choose which types or sub-categories each group applies to, and can untick it on any single item.
- **Supplied items** (Recipes & menu → **+ Supplied item**): one form for pastries and food you buy and resell. It shows what you pay, what you sell for, and your margin. Each sale takes off one piece.
- **Grams for house-made sauces:** give a sauce a **"weighs"** value (for example, 1 L of caramel weighs 1,250 g). Recipes can then use grams for it.
- **Waste log at the counter** (**Log waste** button):
  - Log menu items (with their options) or single ingredients, with a reason: calibration, spillage, complimentary, expired or other.
  - Stock goes down the same way a sale takes it off. It also works offline.
  - **"Complimentary" needs a manager's PIN**, like a discount.
- **Money** section in the Back Office:
  - **Expenses:** rent, utilities, internet, wages, repairs, operating supplies and other, with an optional receipt photo that only you can open.
  - **Net income:** per month. Sales without tax, minus the ingredients used (sold and wasted), minus expenses.
  - **Waste report:** per day and per reason, with its cost.
- **Operating supplies** (foil, dish soap, sponges…): put them in the **Operating supplies** category. Buying them then counts as an expense, not stock.
- **Safety:**
  - Counters never see what you pay suppliers.
  - Customers' phones only see option names and prices, never recipe amounts.
  - Only your owner login can change menu photos.

**Good to know:**
- **"Less …" options:** an option that uses less of an ingredient now lowers the amount taken off. Before, it wrongly took that amount off.
- **Cups and lids:** take-away cups and lids are now counted stock. Add them as ingredients counted in pieces (see step 6) so they can run low and warn you.

## Steps

### 1. Let every counter finish uploading (1 min)
On each counter, check that the upload status says **"all saved"**.

### 2. Download a backup (2 min)
Back Office → **Backup & import** → **Download a backup**. Keep the file.

### 3. Run the database script 010 (3 min)
1. On GitHub, open `cccc/supabase/010_release_1_4.sql` on the branch `wip/cccc-online-qr`.
2. Click **Raw**, select everything (Ctrl+A) and copy it (Ctrl+C).
3. On supabase.com, open your project → **SQL Editor** → **New query**.
4. Paste the script and click **Run**.
5. Wait for **Success. No rows returned**.
   - If you see a red error, don't run it again. Copy the message and send it to C.

### 4. Publish the apps (2 min)
**Do this right after step 3.**
1. Open the pull request link C sends you.
2. Click **Merge pull request**, then **Confirm merge**.
3. Wait about 2 minutes for the site to update.

### 5. Load the new version and check the photo limit (3 min)
1. On each counter, your computer and your phone, open the app and reload the page twice.
2. In Supabase → **SQL Editor** → **New query**, run this. It only reads:
   ```sql
   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'expense-photos';
   ```
   You should see `false`, `5242880` and `{image/jpeg,image/png,image/webp}`. Send C a screenshot if it looks different.

### 6. Set it up (in this order; take your time)
1. **Operating supplies:**
   1. Back Office → **Ingredients** → **Manage categories**.
   2. Move foil, dish soap, sponges and similar items from "Others" into **Operating supplies**.
2. **Merge ingredients:** Ingredients → tick the ones that belong together → **Merge into one**. Name the general ingredient, check the brand names, click **Show what will change**, read it, then click **Merge**. One group at a time:
   - Full Cream Milk (Arla, Laciate)
   - Non-dairy Milk (oat, soya…)
   - Non-Coffee Milk (Selecta)
   - Cocoa Powder (Bensdorp, JB15)
   - Coffee Beans (60-40 Arabica, South City Coffee Roasters)
   - Butter (Magnolia, Queensland)
   - Cream (Bunge, Monna Lisa)
3. **Cups and lids:**
   1. Add **Hot cup**, **Iced cup** and **Lid** as ingredients counted in **pcs**.
   2. Record a purchase or starting stock for them.
4. **Options library:**
   1. Recipes & menu → **Options library**.
   2. Use the starters: Hot or iced, Take-away cup (pick the cup and the lid), Extra shot, and Non-dairy milk swap (from Full Cream Milk to Non-dairy Milk; set the one extra price).
   3. Choose which types or sub-categories each applies to, then untick any item where it doesn't fit.
   4. Afterwards, remove the same options from items that had their own copies, so they don't show twice.
5. **Sauces:** on each house-made sauce or syrup you weigh, fill in **"weighs"**.
6. **Supplied items:**
   1. Recipes & menu → **+ Supplied item**, once for each pastry or food you buy and resell.
   2. Enter the restock amount to start its stock.

### 7. Quick check (5 min)
1. **Counter:**
   1. Open a shift.
   2. Sell an iced latte with oat milk to take away, and check the receipt.
   3. Log one "Spillage" waste.
   4. Void the sale.
2. **Back Office:**
   1. **Waste report** shows the spillage.
   2. **Inventory** shows a cup and a lid taken off, then put back by the void.
3. **QR page:** on your phone, open a drink. "Hot or iced" must be chosen before you can add it.
4. Close the shift.

## If something goes wrong
Tell C what you see (a photo of the screen helps). To undo the apps, tell C: **"Go back to the last working version."**
