# Release 1.6: what to do

The "Money" update (Wave 4). It takes about 20 minutes. **Do it when the shop is closed**, because counters must be updated together with the database.

Your current live version (1.5) is saved as the **last working version** (`docs/checkpoints.md`). If anything goes wrong, tell C: **"Go back to the last working version."**

> Status: **ready** (Z: PASS on 2026-11-13, 9,044 checks, none failing).

## What's new

**Payment methods (counter checkout)**
- The checkout buttons come from your own list: **Cash, GCash, QR payment, Card, Bank transfer** to start. Maya and Other are switched off (old sales keep their method).
- Back Office → **Settings → Payments & discounts**: add, rename, reorder or switch off methods, and choose which ones ask for a reference number.
- **Extra charge per method:** none, a % or a peso amount. At checkout it shows as its own line with an **"Add the … charge"** tick. Untick it to waive the charge for that sale; the shop absorbs it.
  - In the Accounting overview the charge counts as that method's **payment fee** on every sale. When it's added, the customer pays it back, so it cancels out; when it's waived, your income is lower by that amount. **Don't also log these fees in Expenses.**
  - Reminder: you chose this knowing the DTI rule (DAO 21-03) about charging more for card or e-wallet payments.

**Senior / PWD discount (counter)**
- A **Senior / PWD discount → add** link in the order. Choose Senior citizen or PWD, type the **name and ID number** (required) and tick that customer's own items. Any cashier can apply it; no manager PIN.
- The % comes from Settings (20% to start; you can change it). When your prices include VAT, the VAT is taken out of those items first.
- It can't be combined with another discount or a stamp reward on the same sale.
- The receipt shows the discount, the VAT exempt amount, the name, the last 4 characters of the ID and a signature line.
- Back Office → **Money → Senior / PWD report**: every Senior / PWD sale with the full name and ID number, for your accountant. Only you can open it.

**Smart stock count (counter)**
- At Close shift, staff count only the ticked items **whose stock changed** since their last count (sales, waste, purchases, production, corrections…). Items that didn't change are still asked **once a week**.
- Nothing changed = no count step.
- Back Office → **Stock counts** shows each ticked item's last count and whether it will be asked, and lets you change "once a week" to another number of days.

**Accounting overview (Back Office, replaces Net income)**
- Money → **Accounting overview**: any dates (today, this month, last month, or your own dates), with "Compare with the period before".
- Sales, discounts, stamp rewards, Senior / PWD, tax, service charge, payment charges, refunds, net sales, payment fees, ingredients used and wasted, expenses, **net income**. Plus voids, cash over / short, items sold (drinks and food / pastries), each payment method, and the list of waived charges with who waived them. CSV download.

**Investors & start-up costs (Back Office → Money)**
- Your investors with their amounts and **share (%)**, worked out from the amounts. Add, edit (to replace someone) or remove an investor and everyone's share updates by itself.
- Your **start-up costs** (what you spent to open), each with a category and an optional date. They are **not** taken off any month's net income.
- **Invested − start-up costs = left from the investments**.
- **Share of net income** for any dates, per investor (for information).
- **Paste from Excel:** select the two columns (name and amount) in your sheet, copy, and paste. The "?" row with no amount is skipped.

**"Weighs" on bought sauces and syrups**
- A sauce or syrup you buy (counted in mL) can now say how much it weighs: Ingredients → open it → **Weighs** (for example "1 L weighs 1,250 g"). Then drinks and options can use it in **grams**. Stock and cost stay in mL.

**Sales calendar (Back Office)**
- The month calendar **stays on screen** while you scroll the details.
- **Tap a day** to see that day. **Tap a second day** (use the arrows for another month in between) to see everything from the first day to the second.
- Cards: Sales, **Net sales** (instead of Average sale), Net income, Items sold (**drinks** and **food / pastries**), Refunds, Voids, Waste, Expenses. A day-by-day table below.
- The numbers are the same as the Accounting overview for those days.

## Before you start
- **Close all shifts** on every counter, and make sure each counter shows "0 waiting" (everything uploaded).
- Do steps 2 and 3 **back to back**.

## Steps

### 1. Download a backup (2 min)
Back Office → **Backup & import** → **Download a backup**. Keep the file.

### 2. Run the database script 013 (5 min)
1. Sign in to supabase.com with the **business account** (cavitecitycoffeeclub@gmail.com).
2. C will send you the file `013_release_1_6.sql`. Open it in Notepad (or on GitHub, click **Copy raw file**).
3. Select everything (Ctrl+A) and copy it (Ctrl+C).
4. In Supabase, open the project → **SQL Editor** → **New query**.
5. Paste the script and click **Run**.
6. Wait for **Success. No rows returned**.
   - If you see a red error, don't run it again. Copy the message and send it to C.
   - You don't need to save or rename the query (Supabase may say "request entity too large"; that's fine).

### 3. Publish the apps (2 min)
1. Open the pull request link C sends you.
2. Click **Merge pull request**, then **Confirm merge**.
3. Wait about 2 minutes for the site to update.

### 4. Reload every device (1 min each)
On each counter, your computer and your phone: open the app and reload the page twice.

### 5. Set up (5 min)
1. Back Office → **Settings → Payments & discounts**: check the payment methods. If you want an extra charge (for example GCash 2%), set it here and save. Check the **Senior / PWD %**.
2. Back Office → **Stock counts**: check the list and the "ask again every … days" number.
3. Back Office → **Money → Investors & start-up**:
   - Open your sheet "CCCC Initial Funds and Expense". Select the investor names and amounts (D4:E9), copy, then click **Paste from Excel** under Investors, paste, choose the date if you know it, and click **Add**.
   - Do the same for the start-up costs: first H4:I34, then K4:L33 (two pastes). Pick a category for each batch or leave "Other"; you can change each item afterwards.
   - Check the totals against your sheet: invested, start-up costs, and what's left.

### 6. Quick check (5 min)
1. **Counter:** ring up a drink, tap **Senior / PWD discount → add**, fill it in, pay. The receipt shows the discount and a signature line.
2. **Counter:** ring up another, choose GCash. If you set a charge, the charge line appears; untick it and see the total drop.
3. **Back Office → Accounting overview → Today:** both sales are there.
4. **Back Office → Sales calendar:** tap yesterday, then today. You see both days together.
5. **Back Office → Senior / PWD report:** the test sale is listed with the full ID.
6. Void the test sales if you don't want them in your numbers.

## Good to know
- **Senior / PWD names and ID numbers** are personal data. They are kept only in your report; counters never show them again after the sale (the receipt shows only the last 4 characters of the ID). Keep exported CSV files somewhere safe.
- **Importing a backup** doesn't change your payment methods and doesn't bring back Senior / PWD records (those stay only in the database, for privacy).
- **Held orders** don't keep a Senior / PWD discount; apply it again when finishing the order.
- A counter that hasn't reloaded yet uses the old payment list. Its sales are saved and marked "needs review" if the method or charge differs; just reload it.
- The calendar's net income and the Accounting overview use your ingredient costs as of the last day shown, so a day's net income can shift slightly after a new purchase changes the average cost.

## If something goes wrong
Tell C what you see (a photo of the screen helps). To undo the apps, tell C: **"Go back to the last working version."**
