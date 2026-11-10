-- =============================================================================
-- Cavite City Coffee Club — 012: release 1.5 ("QR accounts, counts & production", Wave 3)
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004 … 011 (all already done). It is safe to run more than
-- once. It runs inside one transaction: if anything fails, nothing is changed.
--
-- What it adds, in plain words (details: docs/handoff/contract-1.5.md):
--   PART A  QR ACCOUNTS
--     Q1/A6  GUEST or REGISTERED. A guest orders without a name and has no
--            customer record, so a guest can never collect stamps. A guest can
--            register later on the same phone (orders after that earn stamps).
--     Q2     USERNAMES. Every customer gets a unique, coffee-themed username made
--            from the nickname ("Mika the Coffee Devourer"); the customer can
--            change it (checked here: length, letters, no phone numbers, no links,
--            unique per shop ignoring upper / lower case).
--     Q3     At most 4 open (unpaid) tickets per table (was 10 waiting).
--     Q4     One guest with an open ticket per table at a time.
--     Q5     One phone per account: signing out / switching on a phone with
--            unpaid orders needs a "Yes", which cancels those orders here.
--     B6     Customers without a phone number are "archived": the counter's list
--            hides them unless asked for the archived ones.
--   PART B  COUNTER & STOCK
--     B7     Barista calibration kit (settings.barista_kit), readable by counters;
--            saving it uses the existing waste upload with reason CALIBRATION.
--     B8     R&D projects (owner only) and R&D usage, saved as waste with the new
--            reason RND; R&D cost per project in the waste report and net income.
--     B9     "Count at closing": a blind stock count uploaded by the counter (new
--            upload kind stock_count). The SERVER works out what was expected.
--            Missing = waste COUNT_SHORTAGE; extra = stock raised + "Needs review".
--            A shift can't be closed without a count while items are ticked.
--            Only the owner can revise a count (with an audit entry).
--     B15    Production: batch size kept on each batch; a supplier can be a
--            "partner branch" (TCO); a batch made by the partner adds the product
--            without taking our ingredients and records what we owe (ingredients
--            or pesos, valued at OUR costs); returning / paying settles it.
--   PART C  QR MENU
--     B11    get_qr_menu also returns the highlighted item (as the menu link).
--     B12    every swap choice on the QR menu says whether it is available now.
--
-- LIVE RULES WIDENED (same safe method as 006 / 010: every word already
-- allowed AND every word already stored stays allowed):
--   inventory_transactions.transaction_type  + 'PARTNER_RETURN'
--   sync_operations.operation_type           + 'stock_count'
--   waste_logs.reason (010 rule)             + 'RND', 'COUNT_SHORTAGE'
-- Every other new value goes into a NEW column or a NEW table.
-- =============================================================================

begin;

-- =============================================================================
-- 0. ALLOWED-WORDS RULES (live CHECK rules), widened safely
-- =============================================================================
-- Re-makes the allowed-words rule of one column: the wanted words + every word
-- already stored in that column (so no existing row can break the new rule).
-- Used only by this script (dropped again at the end).
create or replace function public._tmp_widen_check(p_table text, p_col text, p_name text, p_wanted text[]) returns void
language plpgsql as $$
declare r record; v_tbl regclass := to_regclass('public.' || p_table); v_vals text[]; v_list text;
begin
  if v_tbl is null then return; end if;
  execute format('lock table %s in access exclusive mode', v_tbl);
  for r in
    select c.conname from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.conrelid = v_tbl and c.contype = 'c' and a.attname = p_col
  loop
    execute format('alter table %s drop constraint %I', v_tbl, r.conname);
  end loop;
  execute format('select array(select distinct v from (select unnest($1) as v union select %I::text from %s where %I is not null) x order by v)',
                 p_col, v_tbl, p_col) into v_vals using p_wanted;
  select string_agg(quote_literal(v), ', ') into v_list from unnest(v_vals) as v;
  execute format('alter table %s add constraint %I check (%I in (%s))', v_tbl, p_name, p_col, v_list);
end $$;

-- Stock line types: + PARTNER_RETURN (ingredients given back to a partner
-- branch, B15). Stock goes DOWN; it is NOT ingredients used, NOT waste.
do $$ begin perform public._tmp_widen_check('inventory_transactions', 'transaction_type', 'inventory_transactions_transaction_type_check',
  array['PURCHASE','INITIAL_STOCK','USAGE','WASTE','ADJUSTMENT','PRODUCTION','PRODUCTION_USE','SALE_USAGE','SALE_REVERSAL',
        'PARTNER_RETURN']); end $$;
-- Counter upload kinds: + stock_count (B9).
do $$ begin perform public._tmp_widen_check('sync_operations', 'operation_type', 'sync_operations_operation_type_check',
  array['INSERT','UPDATE','DELETE','shift_open','shift_close','cash_movement','sale','held_delete','refund','audit',
        'sold_out','waste','stock_count']); end $$;
-- Waste reasons (rule made by 010): + RND (B8) and COUNT_SHORTAGE (B9).
do $$ begin perform public._tmp_widen_check('waste_logs', 'reason', 'waste_logs_reason_check',
  array['CALIBRATION','SPILLAGE','COMPLIMENTARY','EXPIRED','OTHER','RND','COUNT_SHORTAGE']); end $$;

-- =============================================================================
-- 1. SMALL SHARED HELPERS
-- =============================================================================
-- The shop's own day for a moment (Asia/Manila unless set otherwise).
create or replace function public._shop_day(p_biz uuid, p_at timestamptz) returns date
language sql stable security definer set search_path = public as $$
  select (coalesce(p_at, now()) at time zone coalesce((select nullif(btrim(timezone), '') from public.settings where business_id = p_biz),
                                                     'Asia/Manila'))::date
$$;

-- Stock on hand of ONE ingredient right now (same sum as v_ingredient_stock).
create or replace function public._stock_of(p_biz uuid, p_ingredient uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case
           when t.transaction_type = 'ADJUSTMENT' then t.quantity
           when t.transaction_type in ('PURCHASE','INITIAL_STOCK','PRODUCTION','SALE_REVERSAL') then abs(t.quantity)
           else -abs(t.quantity) end), 0)
  from public.inventory_transactions t
  where t.business_id = p_biz and t.ingredient_id = p_ingredient
$$;

-- The owner's own staff row (the Back Office login's person), for "who did it".
create or replace function public._owner_staff(p_biz uuid) returns public.staff
language sql stable security definer set search_path = public as $$
  select s.* from public.staff s where s.business_id = p_biz and s.profile_id = auth.uid() limit 1
$$;

-- =============================================================================
-- PART A. QR ACCOUNTS (Q1–Q5, A6, B6)
-- =============================================================================
-- A1. New columns
-- customers.username: unique per shop, ignoring upper / lower case. Merged-away
-- records lose theirs (so the name is free again).
alter table public.customers add column if not exists username text;
create unique index if not exists customers_business_username_key on public.customers(business_id, lower(username))
  where username is not null;
-- qr_orders.is_guest: placed by a guest (a phone with no customer account).
-- Kept separately from customer_id (which is also cleared when a customer's
-- data is deleted on request).
alter table public.qr_orders add column if not exists is_guest boolean not null default false;
create index if not exists qr_orders_table_open_idx on public.qr_orders(table_id) where paid_at is null and status in ('PENDING','PREPARING','READY');

-- A2. Usernames
-- A username as a customer typed it, cleaned, or null when it isn't allowed:
--   * spaces at the ends removed, runs of spaces made one;
--   * 3..50 characters; letters (any language), digits, spaces and . ' - _ only;
--   * at least 2 letters; at most 4 digits in total (so no phone numbers);
--   * a "." only before a space or at the end (so no web addresses like x.com);
--   * no "http" / "www" word (no links).
create or replace function public._clean_username(p text) returns text
language plpgsql immutable set search_path = public as $$
declare v text := btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g'));
begin
  if length(v) < 3 or length(v) > 50 then return null; end if;
  if v !~ '^[[:alpha:][:digit:] .''_-]+$' then return null; end if;
  if length(regexp_replace(v, '[^[:alpha:]]', '', 'g')) < 2 then return null; end if;
  if length(regexp_replace(v, '[^0-9]', '', 'g')) > 4 then return null; end if;
  if v ~ '\.[^ ]' then return null; end if;
  if v ~* '(^|[^[:alpha:]])(https?|www)([^[:alpha:]]|$)' then return null; end if;
  return v;
end $$;

-- The first word of the nickname, letters only, capital first (e.g. "mika"
-- -> "Mika"); "Kape" when nothing usable is left.
create or replace function public._username_base(p_nickname text) returns text
language plpgsql immutable set search_path = public as $$
declare v text := split_part(btrim(regexp_replace(regexp_replace(coalesce(p_nickname, ''), '[^[:alpha:] ''-]', '', 'g'), '\s+', ' ', 'g')), ' ', 1);
begin
  v := left(btrim(v, ' ''-'), 12);
  v := btrim(v, ' ''-');
  if length(v) < 2 then return 'Kape'; end if;
  return upper(left(v, 1)) || substr(v, 2);
end $$;

-- A new coffee-themed username for a customer of shop p_biz that nobody else
-- of the shop has: "<Name> the <coffee word> <title>", e.g.
-- "Mika the Coffee Devourer". After 20 taken tries a number is added
-- ("Mika the Mocha Lover 42"). p_self = the customer's own id (or null).
create or replace function public._new_username(p_biz uuid, p_nickname text, p_self uuid) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  a text[] := array['Coffee','Espresso','Latte','Mocha','Caramel','Cold Brew','Barako','Arabica','Cappuccino',
                    'Macchiato','Cortado','Americano','Hazelnut','Vanilla','Frappe','Affogato','Flat White','Kapeng'];
  n text[] := array['Devourer','Lover','Sipper','Connoisseur','Enthusiast','Whisperer','Champion','Explorer','Hero',
                    'Wizard','Aficionado','Dreamer','Knight','Ranger','Legend','Guardian','Adventurer','Master'];
  v_base text := public._username_base(p_nickname); v text; i integer;
begin
  for i in 1..60 loop
    v := v_base || ' the ' || a[1 + floor(random() * array_length(a, 1))::int] || ' ' || n[1 + floor(random() * array_length(n, 1))::int];
    if i > 20 then v := v || ' ' || (2 + floor(random() * 998))::int; end if;
    if not exists (select 1 from public.customers c
                   where c.business_id = p_biz and lower(c.username) = lower(v) and c.id is distinct from p_self) then
      return v;
    end if;
  end loop;
  return v_base || ' the Coffee Lover ' || (1000 + floor(random() * 8999))::int;
end $$;

-- Every save of a customer (any way: QR page, counter, Back Office, backup):
--   * a merged-away record has no username;
--   * no username yet -> one is made (this is also how existing customers get
--     theirs, see the fill below);
--   * a changed username is cleaned and checked: BAD_USERNAME (rules above) or
--     USERNAME_TAKEN (another customer of the shop has it, any upper / lower case).
-- Two saves of the same new name at the same moment: the second waits, then
-- gets USERNAME_TAKEN (not a raw "duplicate key" error).
create or replace function public._customer_username_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_gen boolean := false; v_clean text; i integer;
begin
  if new.merged_into is not null then new.username := null; return new; end if;
  if new.username is null or btrim(new.username) = '' then
    new.username := public._new_username(new.business_id, new.nickname, new.id);
    v_gen := true;
  elsif tg_op = 'INSERT' or new.username is distinct from old.username then
    v_clean := public._clean_username(new.username);
    if v_clean is null then raise exception 'BAD_USERNAME'; end if;
    new.username := v_clean;
  else
    return new;                                   -- unchanged
  end if;
  for i in 1..5 loop
    -- (the one-time fill of made-up names takes no lock: one per customer
    -- would be too many locks in one go; the unique index still guards it)
    if not (tg_op = 'UPDATE' and v_gen) then
      perform pg_advisory_xact_lock(hashtext('cccc.username:' || new.business_id::text || ':' || lower(new.username)));
    end if;
    exit when not exists (select 1 from public.customers c
                          where c.business_id = new.business_id and lower(c.username) = lower(new.username) and c.id <> new.id);
    if not v_gen then raise exception 'USERNAME_TAKEN'; end if;
    new.username := public._new_username(new.business_id, new.nickname, new.id);
  end loop;
  return new;
end $$;
drop trigger if exists customers_username on public.customers;
create trigger customers_username before insert or update on public.customers
  for each row execute function public._customer_username_check();

-- A3. QR limits (004 section 13a), all numbers in this one place:
--   table_open_orders  4   open (not paid, not finished / declined / cancelled)
--                          tickets at ONE table (Q3; was 10 waiting)
--   table_guests       1   guests with an open ticket at one table (Q4)
--   shop_orders_10min 60   new QR orders for the whole shop in 10 minutes
--   shop_signups_hour 40   new QR sign-ups for the whole shop in 1 hour
-- (Per login, unchanged: 3 open orders, 10 orders per hour.)
create or replace function public._qr_limits() returns jsonb
language sql immutable as $$
  select '{"table_open_orders": 4, "table_guests": 1, "shop_orders_10min": 60, "shop_signups_hour": 40}'::jsonb
$$;

-- A4. What the phone sees of its customer: as 008, plus the username.
create or replace function public._qr_customer_json(p_c public.customers) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if p_c.id is null then return null; end if;
  v := public._loyalty_summary(p_c.business_id, p_c.id);
  return jsonb_build_object(
    'id', p_c.id, 'nickname', p_c.nickname, 'username', p_c.username,
    'phone_hint', case when p_c.phone is null then null else '•••• ' || right(p_c.phone, 3) end,
    'visit_count', v->'visits', 'stamps', v->'total_stamps',
    'total_stamps', v->'total_stamps', 'drink_stamps_earned', v->'drink_stamps_earned', 'food_stamps_earned', v->'food_stamps_earned',
    'card', v->'card', 'ready_rewards', v->'ready_rewards',
    'loyalty_rewards', public._loyalty_config(p_c.business_id),
    'first_seen_at', p_c.first_seen_at);
end $$;

-- A5. Who am I at this shop? Same as 004, plus state:
--   'GUEST'      this phone has no account (customer = null)
--   'REGISTERED' this phone is signed in to an account (customer = {...})
create or replace function public.qr_session(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_t public.dining_tables; v_c public.customers%rowtype; i integer;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('customer', null, 'state', 'GUEST'); end if;
  select c.* into v_c from public.customer_devices cd join public.customers c on c.id = cd.customer_id
    where cd.auth_user_id = v_uid and cd.business_id = v_t.business_id;
  if not found then return jsonb_build_object('customer', null, 'state', 'GUEST'); end if;
  for i in 1..5 loop
    exit when v_c.merged_into is null;
    select * into v_c from public.customers where id = v_c.merged_into;
  end loop;
  update public.customer_devices set customer_id = v_c.id, last_seen_at = now()
    where auth_user_id = v_uid and business_id = v_t.business_id;
  update public.customers set last_seen_at = now() where id = v_c.id;
  return jsonb_build_object('customer', public._qr_customer_json(v_c), 'state', 'REGISTERED');
end $$;

-- A6. The customer changes their username (Q2).
-- Returns {customer:{...}} or {error: NOT_SIGNED_IN | TABLE_NOT_FOUND |
-- REGISTER_FIRST | BAD_USERNAME | USERNAME_TAKEN | TOO_MANY_ATTEMPTS}.
-- Refused tries count: at most 10 per 15 minutes per login (so nobody can test
-- many names quickly).
create or replace function public.qr_set_username(p_token text, p_username text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_t public.dining_tables; v_cid uuid; v_c public.customers%rowtype; v_err text;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('error', 'NOT_SIGNED_IN'); end if;
  select customer_id into v_cid from public.customer_devices where auth_user_id = v_uid and business_id = v_t.business_id;
  if v_cid is null then return jsonb_build_object('error', 'REGISTER_FIRST'); end if;
  if public._too_many_attempts(v_uid, 'USERNAME', 10, interval '15 minutes') then
    return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS');
  end if;
  if public._clean_username(p_username) is null then
    insert into public.auth_attempts(subject, kind, success) values (v_uid, 'USERNAME', false);
    return jsonb_build_object('error', 'BAD_USERNAME');
  end if;
  begin
    update public.customers set username = public._clean_username(p_username), updated_at = now()
      where id = v_cid and business_id = v_t.business_id returning * into v_c;
  exception when others then
    v_err := substring(sqlerrm from '^[A-Z_]+');
    if v_err in ('USERNAME_TAKEN', 'BAD_USERNAME') or sqlstate = '23505' then
      insert into public.auth_attempts(subject, kind, success) values (v_uid, 'USERNAME', false);
      return jsonb_build_object('error', coalesce(nullif(v_err, ''), 'USERNAME_TAKEN'));
    end if;
    raise;
  end;
  return jsonb_build_object('customer', public._qr_customer_json(v_c));
end $$;

-- A7. "I've ordered here before" on a new phone (004), with Q5:
--   * a phone that is already signed in to an account must sign out first
--     (qr_switch_account): SIGN_OUT_FIRST (answered before any number is
--     looked at, so it says nothing about numbers);
--   * one phone per account: linking the account here removes its link on
--     any other phone (that phone becomes a guest; its unpaid orders stay
--     payable at the counter).
-- Everything else as 004 (5 wrong tries per 15 minutes, shared with
-- qr_register / qr_set_phone; NO_MATCH never says which part was wrong).
create or replace function public.qr_relink(p_token text, p_phone text, p_nickname text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_t public.dining_tables; v_phone text := public._norm_phone(p_phone); v_c public.customers%rowtype;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('error', 'NOT_SIGNED_IN'); end if;
  if exists (select 1 from public.customer_devices where auth_user_id = v_uid and business_id = v_t.business_id) then
    return jsonb_build_object('error', 'SIGN_OUT_FIRST');
  end if;
  if public._too_many_attempts(v_uid, 'RELINK', 5, interval '15 minutes') then return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS'); end if;
  if v_phone is null then return jsonb_build_object('error', 'BAD_PHONE'); end if;
  select * into v_c from public.customers
    where business_id = v_t.business_id and phone = v_phone and merged_into is null
      and lower(nickname) = lower(coalesce(public._clean_name(p_nickname), ''));
  if not found then
    insert into public.auth_attempts(subject, kind, success) values (v_uid, 'RELINK', false);
    return jsonb_build_object('error', 'NO_MATCH');
  end if;
  delete from public.customer_devices
    where business_id = v_t.business_id and customer_id = v_c.id and auth_user_id <> v_uid;
  insert into public.customer_devices(auth_user_id, business_id, customer_id) values (v_uid, v_t.business_id, v_c.id)
    on conflict (auth_user_id, business_id) do update set customer_id = excluded.customer_id, last_seen_at = now();
  update public.customers set last_seen_at = now() where id = v_c.id;
  return jsonb_build_object('customer', public._qr_customer_json(v_c), 'relinked', true);
end $$;

-- A8. Sign out / switch account on this phone (Q5).
-- When this phone has unpaid open orders (waiting, being made or ready, not
-- paid) at this shop:
--   p_confirm false -> {error:'UNPAID_ORDERS', unpaid: n} and NOTHING changes
--                      (the page asks "You still have unpaid orders. Do you
--                      still want to proceed?")
--   p_confirm true  -> those orders are CANCELLED here (the counter sees them
--                      cancelled), then the phone is signed out.
-- Returns {ok:true, cancelled:n}. A phone with no account just gets ok.
create or replace function public.qr_switch_account(p_token text, p_confirm boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_t public.dining_tables; v_n integer; v_ids uuid[];
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('error', 'NOT_SIGNED_IN'); end if;
  select coalesce(array_agg(x.id), '{}') into v_ids from (
    select o.id from public.qr_orders o
    where o.auth_user_id = v_uid and o.business_id = v_t.business_id
      and o.status in ('PENDING','PREPARING','READY') and o.paid_at is null
    for update) x;
  v_n := cardinality(v_ids);
  if v_n > 0 and not coalesce(p_confirm, false) then
    return jsonb_build_object('error', 'UNPAID_ORDERS', 'unpaid', v_n);
  end if;
  if v_n > 0 then
    update public.qr_orders set status = 'CANCELLED', reject_reason = 'Cancelled by the customer (account switched on the phone)'
      where id = any(v_ids) and paid_at is null;
    get diagnostics v_n = row_count;
  end if;
  delete from public.customer_devices where auth_user_id = v_uid and business_id = v_t.business_id;
  return jsonb_build_object('ok', true, 'cancelled', v_n);
end $$;

-- "Not you?" (004) now goes through the same check: with unpaid orders it
-- answers UNPAID_ORDERS (use qr_switch_account(token, true) after the "Yes").
create or replace function public.qr_forget_device(p_token text) returns jsonb
language sql volatile security definer set search_path = public as $$
  select public.qr_switch_account(p_token, false)
$$;

-- A9. Place an order: same as 010, plus (marked "012")
--   * p_guest = true: a phone WITHOUT an account orders as a guest (no name,
--     no stamps). Without it such a phone still gets REGISTER_FIRST (as before,
--     so an older QR page behaves the same). A phone WITH an account always
--     orders as itself (p_guest is ignored).
--   * Q3: at most 4 open unpaid tickets per table -> TABLE_FULL
--   * Q4: a guest at a table where ANOTHER guest has an open unpaid ticket
--     -> GUEST_TABLE_BUSY (register, or wait until that ticket is paid)
-- (The old 4-argument version is removed so the API never has to choose.)
drop function if exists public.qr_place_order(text, jsonb, text, text);
create or replace function public.qr_place_order(p_token text, p_items jsonb, p_note text default null,
                                                 p_order_type text default null, p_guest boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_t public.dining_tables; v_s public.settings%rowtype;
  v_cid uuid; v_c public.customers%rowtype; v_guest boolean := false;
  v_it jsonb; v_r public.recipes%rowtype; v_qty integer; v_groups jsonb; v_g jsonb; v_o jsonb; v_sel jsonb;
  v_unit numeric; v_mods jsonb; v_lines jsonb := '[]'::jsonb; v_subtotal numeric := 0;
  v_tax numeric; v_service numeric; v_total numeric; v_day date; v_no integer; v_type text; v_order public.qr_orders%rowtype;
  v_count integer; v_seen text[];
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('error', 'NOT_SIGNED_IN'); end if;
  select * into v_s from public.settings where business_id = v_t.business_id;
  if not coalesce(v_s.qr_ordering_enabled, true) then return jsonb_build_object('error', 'ORDERING_OFF'); end if;
  if not public._shop_is_open(v_t.business_id) then return jsonb_build_object('error', 'SHOP_CLOSED'); end if;
  select customer_id into v_cid from public.customer_devices where auth_user_id = v_uid and business_id = v_t.business_id;
  if v_cid is null then
    -- 012: a guest order only when the page asks for it
    if not coalesce(p_guest, false) then return jsonb_build_object('error', 'REGISTER_FIRST'); end if;
    v_guest := true;
  else
    select * into v_c from public.customers where id = v_cid;
  end if;

  select count(*) into v_count from public.qr_orders
    where auth_user_id = v_uid and business_id = v_t.business_id and status in ('PENDING','PREPARING','READY') and paid_at is null;
  if v_count >= 3 then return jsonb_build_object('error', 'TOO_MANY_OPEN_ORDERS'); end if;
  select count(*) into v_count from public.qr_orders where auth_user_id = v_uid and created_at > now() - interval '1 hour';
  if v_count >= 10 then return jsonb_build_object('error', 'TOO_MANY_ORDERS'); end if;
  -- Table and shop limits. Orders of one shop are placed one at a time
  -- (advisory lock), so two phones at the same moment can't both slip past a limit.
  perform pg_advisory_xact_lock(hashtext('cccc.qr_order:' || v_t.business_id::text));
  -- 012 (Q3): open, unpaid tickets at this table
  select count(*) into v_count from public.qr_orders
    where table_id = v_t.id and status in ('PENDING','PREPARING','READY') and paid_at is null;
  if v_count >= (public._qr_limits()->>'table_open_orders')::int then return jsonb_build_object('error', 'TABLE_FULL'); end if;
  -- 012 (Q4): one guest with an open ticket per table
  if v_guest then
    select count(distinct auth_user_id) into v_count from public.qr_orders
      where table_id = v_t.id and is_guest and auth_user_id is distinct from v_uid
        and status in ('PENDING','PREPARING','READY') and paid_at is null;
    if v_count >= (public._qr_limits()->>'table_guests')::int then return jsonb_build_object('error', 'GUEST_TABLE_BUSY'); end if;
  end if;
  select count(*) into v_count from public.qr_orders where business_id = v_t.business_id and created_at > now() - interval '10 minutes';
  if v_count >= (public._qr_limits()->>'shop_orders_10min')::int then return jsonb_build_object('error', 'TOO_MANY_ORDERS'); end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('error', 'EMPTY_ORDER');
  end if;
  if jsonb_array_length(p_items) > 30 then return jsonb_build_object('error', 'ORDER_TOO_BIG'); end if;

  for v_it in select value from jsonb_array_elements(p_items) loop
    select * into v_r from public.recipes
      where id = public._to_uuid(v_it->>'recipe_id') and business_id = v_t.business_id
        and coalesce(active, true) and coalesce(pos_visible, true) and coalesce(qr_visible, true) and coalesce(selling_price, 0) > 0;
    if not found then return jsonb_build_object('error', 'ITEM_UNAVAILABLE'); end if;
    if coalesce(v_r.sold_out, false) or (coalesce(v_s.qr_hide_out_of_stock, false) and not public._recipe_makeable(v_r.id)) then
      return jsonb_build_object('error', 'ITEM_UNAVAILABLE', 'name', v_r.name);
    end if;
    begin v_qty := (v_it->>'quantity')::integer; exception when others then v_qty := 0; end;
    if v_qty is null or v_qty < 1 or v_qty > 20 then return jsonb_build_object('error', 'BAD_QUANTITY', 'name', v_r.name); end if;

    v_groups := case when jsonb_typeof(v_r.modifier_groups) = 'array' then v_r.modifier_groups else '[]'::jsonb end;
    v_unit := v_r.selling_price; v_mods := '[]'::jsonb; v_seen := '{}';
    for v_sel in select value from jsonb_array_elements(case when jsonb_typeof(v_it->'modifiers') = 'array' then v_it->'modifiers' else '[]'::jsonb end) loop
      select g.value into v_g from jsonb_array_elements(v_groups) g where g.value->>'id' = v_sel->>'group_id';
      if v_g is null then return jsonb_build_object('error', 'BAD_OPTION', 'name', v_r.name); end if;
      select o.value into v_o from jsonb_array_elements(coalesce(v_g->'options', '[]'::jsonb)) o where o.value->>'id' = v_sel->>'option_id';
      if v_o is null then return jsonb_build_object('error', 'BAD_OPTION', 'name', v_r.name); end if;
      if (v_sel->>'group_id') || ':' || (v_sel->>'option_id') = any(v_seen) then return jsonb_build_object('error', 'BAD_OPTION', 'name', v_r.name); end if;
      if not coalesce((v_g->>'multi_select')::boolean, false)
         and exists (select 1 from unnest(v_seen) x where split_part(x, ':', 1) = v_sel->>'group_id') then
        return jsonb_build_object('error', 'BAD_OPTION', 'name', v_r.name);
      end if;
      v_seen := v_seen || ((v_sel->>'group_id') || ':' || (v_sel->>'option_id'));
      v_unit := v_unit + coalesce((v_o->>'price_delta')::numeric, 0);
      v_mods := v_mods || jsonb_build_array(jsonb_build_object(
        'group', v_g->>'name', 'label', v_o->>'label', 'price_delta', coalesce((v_o->>'price_delta')::numeric, 0),
        'ingredient_id', nullif(v_o->>'ingredient_id', ''), 'ingredient_qty_delta', coalesce((v_o->>'ingredient_qty_delta')::numeric, 0))
        || case when jsonb_typeof(v_o->'extras') = 'array' then jsonb_build_object('extras', v_o->'extras') else '{}'::jsonb end
        || case when jsonb_typeof(v_o->'removes') = 'array' then jsonb_build_object('removes', v_o->'removes') else '{}'::jsonb end
        || case when v_o ? 'kind' then jsonb_build_object('kind', v_o->'kind') else '{}'::jsonb end
        || case when upper(coalesce(v_o->>'kind', '')) = 'SWAP'
                then jsonb_build_object('swap_from_ingredient_id', v_o->'swap_from_ingredient_id',
                                        'swap_to_ingredient_id', v_o->'swap_to_ingredient_id',
                                        'swap_rule', coalesce(v_o->'swap_rule', '"LINE_TOTAL"'::jsonb))
                else '{}'::jsonb end);
      v_g := null; v_o := null;
    end loop;
    for v_g in select value from jsonb_array_elements(v_groups) loop
      if coalesce((v_g->>'required')::boolean, false)
         and not exists (select 1 from unnest(v_seen) x where split_part(x, ':', 1) = v_g->>'id') then
        return jsonb_build_object('error', 'OPTION_REQUIRED', 'name', v_r.name, 'group', v_g->>'name');
      end if;
    end loop;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'recipe_id', v_r.id, 'name', v_r.name, 'quantity', v_qty, 'unit_price', v_unit,
      'line_total', v_unit * v_qty, 'modifiers', v_mods, 'notes', left(nullif(btrim(v_it->>'notes'), ''), 140)));
    v_subtotal := v_subtotal + v_unit * v_qty;
  end loop;

  v_tax := case when coalesce(v_s.tax_inclusive, false) then 0 else v_subtotal * coalesce(v_s.tax_pct, 0) / 100 end;
  v_service := v_subtotal * coalesce(v_s.service_charge_pct, 0) / 100;
  v_total := round(v_subtotal + v_tax + v_service, 2);
  v_type := case when v_t.kind = 'TAKEAWAY' then 'TAKEAWAY'
                 when upper(coalesce(p_order_type, '')) = 'TAKEAWAY' then 'TAKEAWAY' else 'DINE_IN' end;
  v_day := (now() at time zone coalesce(nullif(v_s.timezone, ''), 'Asia/Manila'))::date;
  insert into public.qr_order_counters(business_id, day, last_no) values (v_t.business_id, v_day, 1)
    on conflict (business_id, day) do update set last_no = public.qr_order_counters.last_no + 1
    returning last_no into v_no;

  insert into public.qr_orders(business_id, order_number, order_day, table_id, table_label, order_type, customer_id,
      customer_nickname, auth_user_id, status, items, subtotal, tax_amount, service_charge_amount, total, customer_note, is_guest)
    values (v_t.business_id, 'Q-' || lpad(v_no::text, 3, '0'), v_day, v_t.id, v_t.label, v_type, v_c.id,
      v_c.nickname, v_uid, 'PENDING', v_lines, v_subtotal, round(v_tax, 2), round(v_service, 2), v_total,
      left(nullif(btrim(p_note), ''), 200), v_guest)
    returning * into v_order;
  if not v_guest then update public.customers set last_seen_at = now() where id = v_c.id; end if;
  return jsonb_build_object('order', public._qr_order_public(v_order));
end $$;

-- A10. B6: customers without a phone number are "archived".
-- There is no separate flag: archived = no phone (phone is null). A customer
-- who adds a number later is listed again automatically; delete / merge keep
-- working unchanged. Guests have no customer record, so they are never listed.
-- How the counter sees one customer: as 004, plus archived.
create or replace function public._customer_for_staff(p_c public.customers, p_owner boolean) returns jsonb
language sql immutable as $$
  select case when p_c.id is null then null
    else to_jsonb(p_c) || jsonb_build_object('phone', case when p_owner then p_c.phone else public._mask_phone(p_c.phone) end,
                                             'phone_masked', not p_owner and p_c.phone is not null,
                                             'archived', p_c.phone is null) end
$$;

-- The counter's Customers tab card: as 008, plus username and archived.
create or replace function public._counter_customer_json(p_c public.customers, p_money boolean) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l jsonb := public._loyalty_summary(p_c.business_id, p_c.id); v jsonb;
begin
  v := jsonb_build_object(
    'id', p_c.id, 'nickname', p_c.nickname, 'username', p_c.username,
    'phone', public._mask_phone(p_c.phone), 'phone_masked', p_c.phone is not null, 'archived', p_c.phone is null,
    'visits', l->'visits', 'last_visit_at', l->'last_visit_at', 'first_seen_at', p_c.first_seen_at,
    'total_stamps', l->'total_stamps', 'drink_stamps_earned', l->'drink_stamps_earned', 'food_stamps_earned', l->'food_stamps_earned',
    'card', l->'card', 'ready_rewards', l->'ready_rewards');
  if p_money then
    v := v || jsonb_build_object('total_spent', (
      select round(coalesce(sum(greatest(coalesce(s.grand_total, 0)
               - coalesce((select sum(greatest(r.amount, 0)) from public.refunds r where r.sale_id = s.id), 0), 0)), 0), 2)
      from public.sales s
      where s.business_id = p_c.business_id and s.customer_id = p_c.id
        and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')));
  end if;
  return v;
end $$;

-- Counter Customers tab: same as 009, plus
--   p_archived false (default) = customers WITH a phone number (main list)
--              true            = the "Archived" filter: customers without one
--   the search also matches the username.
-- (The old 4-argument version is removed so the API never has to choose.)
drop function if exists public.fo_customer_list(text, integer, text, text);
create or replace function public.fo_customer_list(p_search text default '', p_limit integer default 30,
                                                   p_staff_token text default null, p_sort text default 'recent',
                                                   p_archived boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_biz uuid := public.current_business_id();
  v_q text := left(btrim(coalesce(p_search, '')), 30);
  v_pat text;
  v_lim integer := least(greatest(coalesce(p_limit, 30), 1), 50);
  v_sort text := lower(btrim(coalesce(p_sort, '')));
  v_arch boolean := coalesce(p_archived, false);
  v_money_chk text; v_money boolean; v_s public.settings%rowtype;
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  if not public._is_active_counter(v_biz) then raise exception 'NOT_ALLOWED'; end if;
  if not public._customer_view_allowed(auth.uid()) then return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS'); end if;
  if v_sort not in ('name', 'recent', 'frequent') then v_sort := 'recent'; end if;
  v_money_chk := public._money_view_check(v_biz, p_staff_token);
  v_money := coalesce(v_money_chk = 'OK', false);
  select * into v_s from public.settings where business_id = v_biz;
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return jsonb_build_object(
    'customers', coalesce((
      select jsonb_agg(public._counter_customer_json(c.x, v_money) order by c.rn)
      from (select x, row_number() over (order by
                     case when v_sort = 'name' then lower((x).nickname) end asc,
                     case when v_sort = 'frequent' then (x).visit_count end desc nulls last,
                     coalesce((x).last_order_at, (x).last_seen_at) desc nulls last,
                     lower((x).nickname), (x).id) as rn
            from public.customers x
            where x.business_id = v_biz and x.merged_into is null
              and ((x.phone is null) = v_arch)
              and (v_q = '' or x.nickname ilike v_pat or x.username ilike v_pat)
            order by rn
            limit v_lim) c), '[]'::jsonb),
    'sort', v_sort,
    'archived', v_arch,
    'show_money', v_money,
    'money_refused', case when v_money then null else v_money_chk end,
    'loyalty_enabled', coalesce(v_s.loyalty_enabled, false),
    'loyalty_rewards', public._loyalty_config(v_biz));
end $$;

-- =============================================================================
-- PART C. QR MENU (B11 highlight, B12 swap availability)
-- =============================================================================
-- The QR page's options: same as _public_modifier_groups (010), plus a
-- DISPLAY-ONLY "available" per option:
--   SWAP options: true when the swap's ingredient ("to") is a switched-on
--     ingredient with at least this item's amount in stock now (p_stock =
--     {ingredient id: stock} for those ingredients only); never any amount.
--   every other option: true.
create or replace function public._qr_menu_groups(p_groups jsonb, p_stock jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', g->>'id', 'name', g->>'name',
      'required', coalesce((g->>'required')::boolean, false),
      'multi_select', coalesce((g->>'multi_select')::boolean, false),
      'options', (select coalesce(jsonb_agg(jsonb_build_object('id', o->>'id', 'label', o->>'label',
                      'price_delta', coalesce((o->>'price_delta')::numeric, 0),
                      'kind', coalesce(o->>'kind', 'PLAIN'),
                      'available', case when upper(coalesce(o->>'kind', '')) <> 'SWAP' then true
                        else coalesce(public._to_num(p_stock->>(o->>'swap_to_ingredient_id')), 0) >= greatest(coalesce((
                               select sum(coalesce(public._to_num(e->>'quantity'), 0))
                               from jsonb_array_elements(case when jsonb_typeof(o->'extras') = 'array' then o->'extras' else '[]'::jsonb end) e
                               where e->>'ingredient_id' = o->>'swap_to_ingredient_id'), 0), 0.000001) end)), '[]'::jsonb)
                  from jsonb_array_elements(case when jsonb_typeof(g->'options') = 'array' then g->'options' else '[]'::jsonb end) o))), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_groups) = 'array' then p_groups else '[]'::jsonb end) g
$$;

-- Public menu for a table QR code: same answer as 011, plus
--   highlight  the item picked in Settings → Menu link (same rules as the
--              menu link: only when it is one of this menu's items, so it is
--              null when the shop is closed or the item is hidden):
--              {item_id, name, image_url, price, available, sold_out, label, blurb}
--   items[].modifier_groups[].options[].available   (see above; B12)
-- The stock is added up once per call: for "hide items we can't make" (as
-- 011) and for the swap ingredients only.
create or replace function public.get_qr_menu(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_t public.dining_tables; v_s public.settings%rowtype; v_b public.businesses%rowtype; v_open boolean;
  v_unmake uuid[] := '{}'; v_ids uuid[] := '{}'; v_stock jsonb := '{}'::jsonb; v_hl jsonb;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  select * into v_b from public.businesses where id = v_t.business_id;
  select * into v_s from public.settings where business_id = v_t.business_id;
  v_open := public._shop_is_open(v_t.business_id);
  if v_open then
    v_ids := array(select r.id from public.recipes r
                   where r.business_id = v_t.business_id and coalesce(r.active, true) and coalesce(r.pos_visible, true)
                     and coalesce(r.qr_visible, true) and coalesce(r.selling_price, 0) > 0);
    if coalesce(v_s.qr_hide_out_of_stock, false) then v_unmake := public._unmakeable_recipes(v_ids); end if;
    -- stock of the swap ingredients of these items (switched-on ones only)
    select coalesce(jsonb_object_agg(i.id::text, public._stock_of(v_t.business_id, i.id)), '{}'::jsonb) into v_stock
      from public.ingredients i
      where i.business_id = v_t.business_id and coalesce(i.active, true) and i.merged_into is null
        and i.id in (select public._to_uuid(o->>'swap_to_ingredient_id')
                     from public.recipes r,
                          jsonb_array_elements(case when jsonb_typeof(r.modifier_groups) = 'array' then r.modifier_groups else '[]'::jsonb end) g,
                          jsonb_array_elements(case when jsonb_typeof(g->'options') = 'array' then g->'options' else '[]'::jsonb end) o
                     where r.id = any(v_ids) and upper(coalesce(o->>'kind', '')) = 'SWAP');
    -- B11: the highlighted item, only when it is on this menu
    select jsonb_build_object('item_id', r.id, 'name', r.name, 'image_url', r.image_url, 'price', r.selling_price,
             'available', not coalesce(r.sold_out, false) and not (r.id = any(v_unmake)),
             'sold_out', coalesce(r.sold_out, false) or r.id = any(v_unmake),
             'label', coalesce(v_s.menu_highlight_label, 'Today''s pick'), 'blurb', v_s.menu_highlight_blurb)
      into v_hl
      from public.recipes r where r.id = v_s.menu_highlight_recipe_id and r.id = any(v_ids);
  end if;
  return jsonb_build_object(
    'business', jsonb_build_object('name', coalesce(nullif(v_s.business_name, ''), v_b.name), 'logo_url', v_s.logo_url),
    'theme', jsonb_build_object('primary_color', v_s.primary_color, 'secondary_color', v_s.secondary_color,
      'accent_color', v_s.accent_color, 'background_color', v_s.background_color, 'card_color', v_s.card_color,
      'text_color', v_s.text_color, 'theme', coalesce(v_s.theme, 'CCCC')),
    'table', jsonb_build_object('label', v_t.label, 'kind', v_t.kind),
    'is_open', v_open,
    'ordering_enabled', coalesce(v_s.qr_ordering_enabled, true),
    'welcome_message', v_s.qr_welcome_message,
    'payment_note', v_s.qr_payment_note,
    'tax_pct', coalesce(v_s.tax_pct, 0), 'service_charge_pct', coalesce(v_s.service_charge_pct, 0),
    'tax_inclusive', coalesce(v_s.tax_inclusive, false),
    'loyalty_enabled', coalesce(v_s.loyalty_enabled, false), 'stamps_per_reward', v_s.stamps_per_reward,
    'loyalty_rewards', public._loyalty_config(v_t.business_id),
    'subcategory_colors', coalesce(v_s.subcategory_colors, '{}'::jsonb),
    'subcategory_order', coalesce(v_s.subcategory_order, '[]'::jsonb),
    'highlight', coalesce(v_hl, 'null'::jsonb),
    'items', case when not v_open then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name,
        'category', coalesce(nullif(btrim(r.category), ''), public._type_label(r.recipe_type)),
        'subcategory', nullif(btrim(r.category), ''),
        'recipe_type', coalesce(r.recipe_type, 'DRINKS'),
        'description', r.description, 'image_url', r.image_url, 'price', r.selling_price,
        'available', not coalesce(r.sold_out, false) and not (r.id = any(v_unmake)),
        'modifier_groups', public._qr_menu_groups(r.modifier_groups, v_stock)
      ) order by r.sort_order, r.name)
      from public.recipes r
      where r.id = any(v_ids)), '[]'::jsonb) end
  );
end $$;

-- =============================================================================
-- PART B1. B7 BARISTA CALIBRATION KIT (setting)
-- =============================================================================
-- settings.barista_kit = the usual daily calibration kit, set once by the
-- owner: [{ingredient_id, quantity, unit}] (unit = any unit that converts to the
-- ingredient's stock unit; empty = its stock unit). At most 20 lines.
-- Counters already read settings (fo_bootstrap), so they get it offline too.
-- Saving the kit at the counter = the existing waste upload, reason CALIBRATION,
-- items = these lines (as adjusted by staff). Nothing else is added.
alter table public.settings add column if not exists barista_kit jsonb not null default '[]'::jsonb;

-- What is wrong with a kit (null = fine). p_full = also check that every
-- ingredient is one of the shop's switched-on stock items (done only when the
-- kit itself changes, so a later settings save never fails because an item was
-- switched off since).
create or replace function public._barista_kit_problem(p_biz uuid, p_kit jsonb, p_full boolean) returns text
language plpgsql stable security definer set search_path = public as $$
declare l jsonb; v_ing public.ingredients%rowtype; v_seen uuid[] := '{}'; v_id uuid; v_q numeric;
begin
  if jsonb_typeof(p_kit) is distinct from 'array' or jsonb_array_length(p_kit) > 20 then return 'shape'; end if;
  for l in select value from jsonb_array_elements(p_kit) loop
    if jsonb_typeof(l) <> 'object' then return 'shape'; end if;
    v_id := public._to_uuid(l->>'ingredient_id');
    v_q := public._to_num(l->>'quantity');
    if v_id is null or v_q is null or v_q <= 0 or v_q > 100000 then return 'line'; end if;
    if v_id = any(v_seen) then return 'twice'; end if;
    v_seen := v_seen || v_id;
    if p_full then
      select * into v_ing from public.ingredients where id = v_id and business_id = p_biz;
      if not found or not coalesce(v_ing.active, true) or v_ing.merged_into is not null
         or public._is_expense_item(p_biz, v_id) then
        return 'ingredient';
      end if;
      if public._to_base_qty(v_q, coalesce(nullif(btrim(l->>'unit'), ''), v_ing.base_unit), v_ing.base_unit, v_ing.weight_g_per_ml) is null then
        return 'unit';
      end if;
    end if;
  end loop;
  return null;
end $$;

-- The settings check: same as 011, plus the barista kit (BAD_BARISTA_KIT).
-- The kit is stored tidied: [{ingredient_id, quantity, unit}] only.
create or replace function public._settings_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public._valid_subcategory_colors(new.subcategory_colors) then raise exception 'BAD_SUBCATEGORY_COLORS'; end if;
  if not public._valid_subcategory_order(new.subcategory_order) then raise exception 'BAD_SUBCATEGORY_ORDER'; end if;
  if not public._valid_loyalty_rewards(new.loyalty_rewards) then raise exception 'BAD_LOYALTY_REWARDS'; end if;
  if new.theme is null or new.theme in ('light', 'dark') then
    new.theme := case when tg_op = 'UPDATE' and old.theme in ('CCCC', 'CUSTOM') then old.theme else 'CCCC' end;
  end if;

  -- 011: the menu link fields
  new.menu_public := coalesce(new.menu_public, false);
  new.public_code := nullif(lower(btrim(new.public_code)), '');
  new.public_address := nullif(btrim(replace(replace(new.public_address, E'\r\n', E'\n'), E'\r', E'\n')), '');
  new.public_hours := nullif(btrim(replace(replace(new.public_hours, E'\r\n', E'\n'), E'\r', E'\n')), '');
  new.public_map_url := nullif(btrim(new.public_map_url), '');
  new.public_facebook_url := nullif(btrim(new.public_facebook_url), '');
  new.public_instagram_url := nullif(btrim(new.public_instagram_url), '');
  if new.public_code is not null and new.public_code !~ '^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$' then
    raise exception 'BAD_PUBLIC_CODE';
  end if;
  if new.public_code is not null and (tg_op = 'INSERT' or old.public_code is distinct from new.public_code) then
    perform pg_advisory_xact_lock(hashtext('cccc.public_code:' || new.public_code));
  end if;
  if new.public_code is not null and exists (select 1 from public.settings
       where public_code = new.public_code and business_id <> new.business_id) then
    raise exception 'PUBLIC_CODE_TAKEN';
  end if;
  if new.menu_public and new.public_code is null then raise exception 'MENU_CODE_NEEDED'; end if;
  if not public._valid_public_text(new.public_address, 200) then raise exception 'BAD_PUBLIC_ADDRESS'; end if;
  if not public._valid_public_text(new.public_hours, 300) then raise exception 'BAD_PUBLIC_HOURS'; end if;
  if not public._valid_public_url(new.public_map_url) then raise exception 'BAD_MAP_URL'; end if;
  if not public._valid_public_url(new.public_facebook_url,
       array['facebook.com','www.facebook.com','m.facebook.com','web.facebook.com','fb.com','www.fb.com','fb.me']) then
    raise exception 'BAD_FACEBOOK_URL';
  end if;
  if not public._valid_public_url(new.public_instagram_url, array['instagram.com','www.instagram.com']) then
    raise exception 'BAD_INSTAGRAM_URL';
  end if;

  -- 011: the highlighted item
  new.menu_highlight_label := nullif(btrim(regexp_replace(new.menu_highlight_label, '[\x01-\x1F\x7F]', ' ', 'g')), '');
  new.menu_highlight_blurb := nullif(btrim(regexp_replace(new.menu_highlight_blurb, '[\x01-\x1F\x7F]', ' ', 'g')), '');
  if length(new.menu_highlight_label) > 30 then raise exception 'BAD_HIGHLIGHT_LABEL'; end if;
  if length(new.menu_highlight_blurb) > 140 then raise exception 'BAD_HIGHLIGHT_BLURB'; end if;
  if new.menu_highlight_recipe_id is not null then
    if not exists (select 1 from public.recipes where id = new.menu_highlight_recipe_id and business_id = new.business_id) then
      raise exception 'BAD_HIGHLIGHT';
    end if;
    if (tg_op = 'INSERT' or old.menu_highlight_recipe_id is distinct from new.menu_highlight_recipe_id)
       and not exists (select 1 from public.recipes where id = new.menu_highlight_recipe_id
                         and coalesce(active, true) and coalesce(pos_visible, true) and coalesce(qr_visible, true)
                         and coalesce(selling_price, 0) > 0) then
      raise exception 'BAD_HIGHLIGHT';
    end if;
  end if;

  -- 012: the barista calibration kit
  if new.barista_kit is null or jsonb_typeof(new.barista_kit) = 'null' then new.barista_kit := '[]'::jsonb; end if;
  if public._barista_kit_problem(new.business_id, new.barista_kit,
                                 tg_op = 'INSERT' or old.barista_kit is distinct from new.barista_kit) is not null then
    raise exception 'BAD_BARISTA_KIT';
  end if;
  new.barista_kit := coalesce((select jsonb_agg(jsonb_build_object('ingredient_id', public._to_uuid(l->>'ingredient_id'),
                                                                   'quantity', public._to_num(l->>'quantity'),
                                                                   'unit', nullif(btrim(l->>'unit'), '')) order by o)
                               from jsonb_array_elements(new.barista_kit) with ordinality x(l, o)), '[]'::jsonb);
  return new;
end $$;

-- =============================================================================
-- PART B2. B8 R&D (owner only)
-- =============================================================================
-- R&D projects: a name and a status. ACTIVE = usage can be logged; DONE /
-- DROPPED = closed (reopen it to log more). Owner only (read and write,
-- through apply_changes like other Back Office data).
create table if not exists public.rnd_projects (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  name text not null,
  status text not null default 'ACTIVE',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists rnd_projects_name_key on public.rnd_projects(business_id, lower(name));
do $$
declare spec text[];
  specs text[][] := array[
    array['rnd_projects', 'rnd_projects_name_check',   $c$length(btrim(name)) between 1 and 80$c$],
    array['rnd_projects', 'rnd_projects_status_check', $c$status in ('ACTIVE','DONE','DROPPED')$c$],
    array['rnd_projects', 'rnd_projects_notes_check',  $c$notes is null or length(notes) <= 500$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
end $$;

-- Two projects of the shop can't have the same name (any upper / lower case):
-- PROJECT_NAME_TAKEN (instead of a raw "duplicate key" error).
create or replace function public._rnd_project_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.name := btrim(new.name);
  if exists (select 1 from public.rnd_projects where business_id = new.business_id and lower(name) = lower(new.name) and id <> new.id) then
    raise exception 'PROJECT_NAME_TAKEN';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists rnd_projects_check on public.rnd_projects;
create trigger rnd_projects_check before insert or update on public.rnd_projects
  for each row execute function public._rnd_project_check();

-- R&D usage and count shortages are saved in the waste log (010), linked to
-- their project / stock count. (stock_counts is made in Part B3.)
alter table public.waste_logs add column if not exists rnd_project_id uuid;
alter table public.waste_logs add column if not exists stock_count_id uuid;
create index if not exists waste_logs_rnd_idx on public.waste_logs(rnd_project_id) where rnd_project_id is not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'waste_logs_rnd_project_fk') then
    alter table public.waste_logs add constraint waste_logs_rnd_project_fk
      foreign key (rnd_project_id) references public.rnd_projects(id);
  end if;
end $$;

-- A project that has logged usage can't be deleted (its cost stays in the
-- reports): PROJECT_HAS_USAGE. Mark it DONE or DROPPED instead.
create or replace function public._rnd_project_delete_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.waste_logs where rnd_project_id = old.id) then raise exception 'PROJECT_HAS_USAGE'; end if;
  return old;
end $$;
drop trigger if exists rnd_projects_delete_check on public.rnd_projects;
create trigger rnd_projects_delete_check before delete on public.rnd_projects
  for each row execute function public._rnd_project_delete_check();

-- ONE wasted / used item, worked out by the server exactly like the counter's
-- waste upload (010): a menu item {recipe_id, quantity (<= 100), modifiers} ->
-- the stock a sale would take (recipe + option extras / swaps); or one
-- ingredient {ingredient_id, quantity, unit} in any unit that converts.
-- Returns {recipe_id, ingredient_id, name, quantity, unit, modifiers,
-- stock_lines:[{ingredient_id, quantity}], cost} (cost as of p_day).
-- Errors: BAD_WASTE, BAD_QUANTITY, BAD_UNIT, UNKNOWN_RECIPE, UNKNOWN_INGREDIENT.
create or replace function public._waste_item(p_biz uuid, p_item jsonb, p_day date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_qty numeric; v_typed numeric; v_unit text; v_name text; v_rid uuid; v_ing public.ingredients%rowtype;
  v_mods jsonb; v_lines jsonb; v_cost numeric;
begin
  if jsonb_typeof(p_item) is distinct from 'object' then raise exception 'BAD_WASTE'; end if;
  v_typed := public._to_num(p_item->>'quantity');
  if v_typed is null or v_typed <= 0 then raise exception 'BAD_QUANTITY'; end if;
  v_rid := public._to_uuid(p_item->>'recipe_id');
  if v_rid is not null then
    select name into v_name from public.recipes where id = v_rid and business_id = p_biz;
    if v_name is null then raise exception 'UNKNOWN_RECIPE'; end if;
    if v_typed > 100 then raise exception 'BAD_QUANTITY'; end if;
    v_mods := public._resolve_options(p_biz, v_rid, p_item->'modifiers');
    v_lines := public._recipe_stock_lines(p_biz, v_rid, v_typed, v_mods);
  elsif public._to_uuid(p_item->>'ingredient_id') is not null then
    v_ing := public._ingredient_final(p_biz, public._to_uuid(p_item->>'ingredient_id'));
    if v_ing.id is null then raise exception 'UNKNOWN_INGREDIENT'; end if;
    v_unit := nullif(btrim(p_item->>'unit'), '');
    v_name := v_ing.name;
    v_qty := public._to_base_qty(v_typed, coalesce(v_unit, (select base_unit from public.ingredients
                                                           where id = public._to_uuid(p_item->>'ingredient_id'))),
                                 v_ing.base_unit, v_ing.weight_g_per_ml);
    if v_qty is null then raise exception 'BAD_UNIT'; end if;
    if v_qty > 1000000 then raise exception 'BAD_QUANTITY'; end if;
    v_lines := jsonb_build_array(jsonb_build_object('ingredient_id', v_ing.id, 'quantity', v_qty));
  else
    raise exception 'BAD_WASTE';
  end if;
  v_lines := public._clean_stock_lines(p_biz, v_lines);
  v_cost := coalesce((select sum(public._to_num(l->>'quantity') * public._ingredient_unit_cost(p_biz, public._to_uuid(l->>'ingredient_id'), p_day))
                      from jsonb_array_elements(v_lines) l), 0);
  return jsonb_build_object('recipe_id', v_rid, 'ingredient_id', case when v_rid is null then v_ing.id end,
                            'name', v_name, 'quantity', v_typed, 'unit', v_unit, 'modifiers', coalesce(v_mods, '[]'::jsonb),
                            'stock_lines', v_lines, 'cost', round(v_cost, 4));
end $$;

-- Back Office: log ingredients (or menu items) used for an R&D project.
-- p = {id (uuid made by the app; the same id again = nothing new, answer has
--      duplicate:true), project_id, used_on (date, default today), note,
--      items:[{ingredient_id, quantity, unit} | {recipe_id, quantity, modifiers}] (1..30)}
-- Saved as waste (reason RND): a waste_logs row linked to the project + its
-- items + WASTE stock lines; the server works out the stock and the cost.
-- Returns {id, project_id, used_on, total_cost, items:[{name, quantity, unit, cost}]}.
-- Errors: NOT_ALLOWED (not the owner), BAD_RND, UNKNOWN_PROJECT, PROJECT_CLOSED,
--   FORBIDDEN_ROW (the id belongs to another shop's record), + the item errors above.
create or replace function public.log_rnd_usage(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_biz uuid := public._require_owner(); v_id uuid; v_pr public.rnd_projects%rowtype; v_day date;
  v_me public.staff; v_item jsonb; v_w jsonb; v_total numeric := 0; v_out jsonb := '[]'::jsonb; l jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'BAD_RND'; end if;
  v_id := public._to_uuid(p->>'id');
  if v_id is null then raise exception 'BAD_RND'; end if;
  if exists (select 1 from public.waste_logs where id = v_id and business_id = v_biz) then
    return jsonb_build_object('id', v_id, 'duplicate', true);
  end if;
  if exists (select 1 from public.waste_logs where id = v_id) then raise exception 'FORBIDDEN_ROW'; end if;
  select * into v_pr from public.rnd_projects where id = public._to_uuid(p->>'project_id') and business_id = v_biz;
  if not found then raise exception 'UNKNOWN_PROJECT'; end if;
  if v_pr.status <> 'ACTIVE' then raise exception 'PROJECT_CLOSED'; end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') not between 1 and 30 then
    raise exception 'BAD_RND';
  end if;
  if length(p->>'note') > 200 then raise exception 'BAD_RND'; end if;
  begin v_day := coalesce(nullif(p->>'used_on', '')::date, public._shop_day(v_biz, now()));
  exception when others then raise exception 'BAD_DATE'; end;
  if v_day > public._shop_day(v_biz, now()) + 1 or v_day < public._shop_day(v_biz, now()) - 400 then raise exception 'BAD_DATE'; end if;
  v_me := public._owner_staff(v_biz);
  insert into public.waste_logs(id, business_id, staff_id, staff_name, reason, note, logged_at, waste_date, rnd_project_id)
    values (v_id, v_biz, v_me.id, coalesce(v_me.name, 'Owner'), 'RND', left(nullif(btrim(p->>'note'), ''), 200), now(), v_day, v_pr.id);
  for v_item in select value from jsonb_array_elements(p->'items') loop
    v_w := public._waste_item(v_biz, v_item, v_day);
    insert into public.waste_log_items(business_id, waste_log_id, recipe_id, ingredient_id, name, quantity, unit, modifiers, stock_lines, cost)
      values (v_biz, v_id, public._to_uuid(v_w->>'recipe_id'), public._to_uuid(v_w->>'ingredient_id'), v_w->>'name',
              (v_w->>'quantity')::numeric, v_w->>'unit', v_w->'modifiers', v_w->'stock_lines', (v_w->>'cost')::numeric);
    for l in select value from jsonb_array_elements(v_w->'stock_lines') loop
      insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date, notes)
        values (v_biz, public._to_uuid(l->>'ingredient_id'), 'WASTE', abs(public._to_num(l->>'quantity')), v_id::text, v_day,
                left('R&D: ' || v_pr.name, 200));
    end loop;
    v_total := v_total + (v_w->>'cost')::numeric;
    v_out := v_out || jsonb_build_array(jsonb_build_object('name', v_w->>'name', 'quantity', v_w->'quantity', 'unit', v_w->'unit',
                                                           'cost', v_w->'cost'));
  end loop;
  update public.waste_logs set total_cost = round(v_total, 2) where id = v_id;
  return jsonb_build_object('id', v_id, 'project_id', v_pr.id, 'used_on', v_day, 'total_cost', round(v_total, 2), 'items', v_out);
end $$;

-- Back Office: remove an R&D usage entry typed by mistake (its stock comes
-- back). One audit entry. Returns {deleted: true|false}.
create or replace function public.delete_rnd_usage(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_biz uuid := public._require_owner(); v_w public.waste_logs%rowtype; v_me public.staff;
begin
  select * into v_w from public.waste_logs where id = p_id and business_id = v_biz and reason = 'RND' for update;
  if not found then return jsonb_build_object('deleted', false); end if;
  delete from public.inventory_transactions where business_id = v_biz and reference_id = v_w.id::text and transaction_type = 'WASTE';
  delete from public.waste_logs where id = v_w.id;
  v_me := public._owner_staff(v_biz);
  insert into public.audit_log(business_id, action, actor_id, actor_name, details, reference_id, at)
    values (v_biz, 'R&D usage removed', v_me.id, coalesce(v_me.name, 'Owner'),
            format('%s, %s, cost %s', (select name from public.rnd_projects where id = v_w.rnd_project_id), v_w.waste_date, v_w.total_cost),
            v_w.id::text, now());
  return jsonb_build_object('deleted', true);
end $$;

-- =============================================================================
-- PART B3. B9 COUNT AT CLOSING
-- =============================================================================
-- Ticked items: counted by staff before closing a shift.
alter table public.ingredients add column if not exists count_at_close boolean not null default false;

-- One submitted count (from a counter). expected / difference are the SERVER's
-- numbers (the counter never sends what it expected).
--   status       SUBMITTED, or REVISED after the owner changed amounts
--   needs_review / review_reason (comma separated): COUNT_EXTRA (more than
--                expected: stock raised), COUNT_INCOMPLETE (a ticked item was not
--                counted), LARGE_SHORTAGE (missing stock worth more than the
--                shop's pay-out review limit, ₱1000 by default), STAFF_MISMATCH, FUTURE_DATE, OLD_DATE,
--                BEFORE_START_FRESH, SHIFT_CLOSED (counted after the shift closed)
create table if not exists public.stock_counts (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  shift_id uuid references public.shifts(id) on delete set null,
  device_id uuid,
  staff_id uuid,
  staff_name text,
  signed_in_staff_id uuid,
  counted_at timestamptz not null,
  count_date date not null,
  note text,
  status text not null default 'SUBMITTED',
  shortage_cost numeric not null default 0,
  needs_review boolean not null default false,
  review_reason text,
  received_at timestamptz not null default now(),
  revised_at timestamptz,
  revised_by_name text,
  revision_note text,
  reviewed_at timestamptz
);
create index if not exists stock_counts_shift_idx on public.stock_counts(shift_id);
create index if not exists stock_counts_business_date_idx on public.stock_counts(business_id, count_date);
-- One line per counted item, all amounts in the item's stock unit.
--   entered_quantity / entered_unit = what staff typed
--   counted     = that, in the stock unit
--   expected    = stock the server had for it when the count arrived
--   difference  = counted - expected (minus = missing)
--   original_counted = the first counted amount (kept when the owner revises)
--   cost        = what the missing amount cost (0 when nothing is missing)
create table if not exists public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  count_id uuid not null references public.stock_counts(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id),
  name text,
  unit text,
  entered_quantity numeric,
  entered_unit text,
  counted numeric not null,
  expected numeric not null,
  difference numeric not null,
  original_counted numeric,
  cost numeric not null default 0
);
create index if not exists stock_count_lines_count_idx on public.stock_count_lines(count_id);
do $$
declare spec text[];
  specs text[][] := array[
    array['stock_counts', 'stock_counts_status_check', $c$status in ('SUBMITTED','REVISED')$c$],
    array['stock_counts', 'stock_counts_note_check',   $c$note is null or length(note) <= 200$c$],
    array['stock_count_lines', 'stock_count_lines_counted_check', $c$counted >= 0$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'waste_logs_stock_count_fk') then
    alter table public.waste_logs add constraint waste_logs_stock_count_fk
      foreign key (stock_count_id) references public.stock_counts(id) on delete cascade;
  end if;
end $$;

-- The ingredients the counter must count at closing: ticked, switched on, not
-- merged away, not an operating supply.
create or replace function public._count_items(p_biz uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(i.id), '{}') from public.ingredients i
  where i.business_id = p_biz and i.count_at_close and coalesce(i.active, true) and i.merged_into is null
    and not public._is_expense_item(p_biz, i.id)
$$;

-- Puts a count's effect on stock (again) from its lines: removes the count's
-- own earlier stock lines and waste entry, then
--   missing (difference < 0) -> one waste entry, reason COUNT_SHORTAGE
--                               ("Missing at count"), WASTE stock lines;
--   extra   (difference > 0) -> an ADJUSTMENT raising stock to the count.
-- Stock lines: reference = the count's id, dated the count's day.
-- Used when a count arrives and when the owner revises it.
create or replace function public._apply_count_effects(p_count_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare c public.stock_counts%rowtype; l public.stock_count_lines%rowtype; v_wid uuid; v_cost numeric; v_total numeric := 0;
  c_tol constant numeric := 0.000001;
begin
  select * into c from public.stock_counts where id = p_count_id;
  if not found then return; end if;
  delete from public.inventory_transactions
    where business_id = c.business_id and reference_id = c.id::text and transaction_type in ('WASTE', 'ADJUSTMENT');
  delete from public.waste_logs where business_id = c.business_id and stock_count_id = c.id;
  for l in select * from public.stock_count_lines where count_id = c.id order by name, id loop
    v_cost := 0;
    if l.difference < -c_tol then
      if v_wid is null then
        v_wid := gen_random_uuid();
        insert into public.waste_logs(id, business_id, device_id, shift_id, staff_id, staff_name, reason, note, logged_at, waste_date,
                                      signed_in_staff_id, needs_review, review_reason, stock_count_id)
          values (v_wid, c.business_id, c.device_id, c.shift_id, c.staff_id, c.staff_name, 'COUNT_SHORTAGE',
                  left(coalesce(c.note, 'Missing at count'), 200), c.counted_at, c.count_date, c.signed_in_staff_id, false, null, c.id);
      end if;
      v_cost := round(-l.difference * public._ingredient_unit_cost(c.business_id, l.ingredient_id, c.count_date), 4);
      insert into public.waste_log_items(business_id, waste_log_id, ingredient_id, name, quantity, unit, stock_lines, cost)
        values (c.business_id, v_wid, l.ingredient_id, l.name, round(-l.difference, 6), l.unit,
                jsonb_build_array(jsonb_build_object('ingredient_id', l.ingredient_id, 'quantity', round(-l.difference, 6))), v_cost);
      insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date, notes)
        values (c.business_id, l.ingredient_id, 'WASTE', round(-l.difference, 6), c.id::text, c.count_date, 'Missing at count');
    elsif l.difference > c_tol then
      insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date, notes)
        values (c.business_id, l.ingredient_id, 'ADJUSTMENT', round(l.difference, 6), c.id::text, c.count_date, 'Extra at count (needs review)');
    end if;
    update public.stock_count_lines set cost = v_cost where id = l.id;
    v_total := v_total + v_cost;
  end loop;
  if v_wid is not null then update public.waste_logs set total_cost = round(v_total, 2) where id = v_wid; end if;
  update public.stock_counts set shortage_cost = round(v_total, 2) where id = c.id;
end $$;

-- Owner (Back Office): revise a submitted count, or just mark it reviewed.
--   p_lines = [{ingredient_id, quantity, unit}]: NEW counted amounts for lines
--             of this count (other lines stay); [] = only "reviewed".
--   p_note  = why (needed when an amount changes: NOTE_REQUIRED).
-- The expected amounts stay as the server had them when the count arrived; the
-- missing / extra stock is worked out again from the new amounts. The review
-- flag is cleared (the owner has looked at it). One audit entry
-- "Stock count revised" (old -> new per item) or "Stock count reviewed".
-- Returns {count:{...}, lines:[...]}.
-- Errors: NOT_ALLOWED, COUNT_NOT_FOUND, BAD_COUNT (not a line of this count,
--   twice, bad shape), BAD_QUANTITY, BAD_UNIT, NOTE_REQUIRED.
create or replace function public.revise_stock_count(p_count_id uuid, p_lines jsonb default '[]'::jsonb, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_biz uuid := public._require_owner(); c public.stock_counts%rowtype; l jsonb; v_line public.stock_count_lines%rowtype;
  v_ing public.ingredients%rowtype; v_q numeric; v_typed numeric; v_seen uuid[] := '{}'; v_changes text[] := '{}';
  v_me public.staff; v_note text := left(nullif(btrim(p_note), ''), 200);
begin
  select * into c from public.stock_counts where id = p_count_id and business_id = v_biz for update;
  if not found then raise exception 'COUNT_NOT_FOUND'; end if;
  if p_lines is null or jsonb_typeof(p_lines) = 'null' then p_lines := '[]'::jsonb; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 300 then raise exception 'BAD_COUNT'; end if;
  for l in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(l) <> 'object' then raise exception 'BAD_COUNT'; end if;
    v_ing := public._ingredient_final(v_biz, public._to_uuid(l->>'ingredient_id'));
    select * into v_line from public.stock_count_lines where count_id = c.id and ingredient_id = v_ing.id;
    if v_ing.id is null or v_line.id is null or v_ing.id = any(v_seen) then raise exception 'BAD_COUNT'; end if;
    v_seen := v_seen || v_ing.id;
    v_typed := public._to_num(l->>'quantity');
    if v_typed is null or v_typed < 0 or v_typed > 10000000 then raise exception 'BAD_QUANTITY'; end if;
    v_q := public._to_base_qty(v_typed, coalesce(nullif(btrim(l->>'unit'), ''), v_ing.base_unit), v_ing.base_unit, v_ing.weight_g_per_ml);
    if v_q is null then raise exception 'BAD_UNIT'; end if;
    if abs(v_q - v_line.counted) > 0.000001 then
      v_changes := v_changes || format('%s: %s -> %s %s', v_line.name, round(v_line.counted, 3), round(v_q, 3), v_line.unit);
      update public.stock_count_lines
         set original_counted = coalesce(original_counted, counted), counted = v_q,
             entered_quantity = v_typed, entered_unit = nullif(btrim(l->>'unit'), ''),
             difference = round(v_q - expected, 6)
       where id = v_line.id;
    end if;
    v_line := null;
  end loop;
  if cardinality(v_changes) > 0 and v_note is null then raise exception 'NOTE_REQUIRED'; end if;
  v_me := public._owner_staff(v_biz);
  if cardinality(v_changes) > 0 then
    perform public._apply_count_effects(c.id);
    update public.stock_counts set status = 'REVISED', revised_at = now(), revised_by_name = coalesce(v_me.name, 'Owner'),
           revision_note = v_note, needs_review = false, reviewed_at = now()
     where id = c.id;
  else
    update public.stock_counts set needs_review = false, reviewed_at = now() where id = c.id;
  end if;
  insert into public.audit_log(business_id, action, actor_id, actor_name, details, reference_id, at)
    values (v_biz, case when cardinality(v_changes) > 0 then 'Stock count revised' else 'Stock count reviewed' end,
            v_me.id, coalesce(v_me.name, 'Owner'),
            left(concat_ws(' | ', 'Count of ' || to_char(c.count_date, 'YYYY-MM-DD') || coalesce(' by ' || c.staff_name, ''),
                           nullif(array_to_string(v_changes, '; '), ''), 'Note: ' || v_note), 2000),
            c.id::text, now());
  return jsonb_build_object(
    'count', (select to_jsonb(x) from public.stock_counts x where x.id = c.id),
    'lines', coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from public.stock_count_lines x where x.count_id = c.id), '[]'::jsonb));
end $$;

-- =============================================================================
-- PART B4. COUNTER UPLOADS: stock_count + "count before closing"
-- =============================================================================
-- Error codes a counter may see: same as 010, plus (012)
--   COUNT_REQUIRED  shift_close refused: items are ticked "Count at closing"
--                   and this shift has no count yet (upload the count first)
--   BAD_COUNT       the count is not readable (no id, no lines, > 300 lines,
--                   an item twice, an operating supply)
create or replace function public._fo_error_code(p_msg text) returns text
language sql immutable as $$
  select case when c = any(array['DEVICE_MISMATCH','SHIFT_NOT_FOUND','UNKNOWN_STAFF','ROLE_TOO_LOW','APPROVAL_REQUIRED',
      'APPROVAL_INVALID','BAD_SALE','BAD_SALE_STATUS','QR_ORDER_ALREADY_PAID','SALE_TOTALS_MISMATCH','UNKNOWN_RECIPE',
      'UNKNOWN_INGREDIENT','FORBIDDEN_ROW','BAD_REFUND','SALE_NOT_FOUND','SALE_NOT_REFUNDABLE','BAD_REFUND_TYPE','BAD_AMOUNT',
      'REFUND_TOO_LARGE','RETURN_TOO_LARGE','SALE_LOCKED','UNKNOWN_OP','BAD_OP','PIN_UPDATE_NEEDED',
      'AMOUNT_NOT_POSITIVE','REWARD_NOT_AVAILABLE','REWARD_AMOUNT_MISMATCH',
      'BAD_WASTE','BAD_WASTE_REASON','NOTE_REQUIRED','BAD_QUANTITY','BAD_UNIT',
      'COUNT_REQUIRED','BAD_COUNT'])
    then c else 'SERVER_ERROR' end
  from (select substring(coalesce(p_msg, '') from '^[A-Z][A-Z_]+') as c) x
$$;

-- Applies ONE counter upload (012). The new kind and the closing rule are
-- handled here; every other kind goes to _fo_apply (010) unchanged.
--   stock_count  data = {id (uuid made on the counter), shift_id, staff_id,
--                        counted_at, note, lines:[{ingredient_id, quantity, unit}]}
--     * same op_id again -> duplicate (fo_sync); same data.id with a new op_id
--       -> skipped; data.id of another shop's count -> FORBIDDEN_ROW
--     * expected = the server's stock for that item when the count arrives
--       (the counter's own numbers are never used); then see _apply_count_effects
--     * saved but flagged (needs_review) like waste: see stock_counts above
--   shift_close  refused with COUNT_REQUIRED while ticked items exist and the
--                shift has no count; otherwise exactly as before.
create or replace function public._fo_apply_15(p_biz uuid, p_dev public.devices, p_type text, p_d jsonb) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_shift public.shifts%rowtype; v_cid uuid; v_staff uuid; v_staff_name text; v_at timestamptz; v_day date;
  v_fresh timestamptz; v_signed uuid; l jsonb; v_ing public.ingredients%rowtype; v_typed numeric; v_q numeric; v_exp numeric;
  v_seen uuid[] := '{}'; v_ticked uuid[]; v_reason text; v_extra boolean := false; v_orig_unit text;
begin
  if p_dev.auth_user_id is distinct from auth.uid() then raise exception 'DEVICE_MISMATCH'; end if;
  if p_type = 'shift_close' then
    select * into v_shift from public.shifts where id = public._to_uuid(p_d->>'id') and business_id = p_biz;
    if found and v_shift.status <> 'CLOSED' and cardinality(public._count_items(p_biz)) > 0
       and not exists (select 1 from public.stock_counts where business_id = p_biz and shift_id = v_shift.id) then
      raise exception 'COUNT_REQUIRED';
    end if;
    return public._fo_apply(p_biz, p_dev, p_type, p_d);
  elsif p_type is distinct from 'stock_count' then
    return public._fo_apply(p_biz, p_dev, p_type, p_d);
  end if;

  -- ---- stock_count ----
  v_cid := public._to_uuid(p_d->>'id');
  if v_cid is null then raise exception 'BAD_COUNT'; end if;
  if exists (select 1 from public.stock_counts where id = v_cid and business_id = p_biz) then return 'skipped'; end if;
  if exists (select 1 from public.stock_counts where id = v_cid) then raise exception 'FORBIDDEN_ROW'; end if;
  v_fresh := public._fresh_start_before(p_biz);
  v_at := coalesce(public._to_ts(p_d->>'counted_at'), now());
  select * into v_shift from public.shifts where id = public._to_uuid(p_d->>'shift_id') and business_id = p_biz;
  if not found then
    if v_fresh is not null and v_at < v_fresh then return 'skipped'; end if;   -- removed by Start fresh
    raise exception 'SHIFT_NOT_FOUND';
  end if;
  v_staff := public._to_uuid(p_d->>'staff_id');
  perform public._require_staff(p_biz, v_staff, 1);
  select name into v_staff_name from public.staff where id = v_staff;
  if jsonb_typeof(p_d->'lines') is distinct from 'array' or jsonb_array_length(p_d->'lines') not between 1 and 300 then
    raise exception 'BAD_COUNT';
  end if;
  v_day := public._shop_day(p_biz, v_at);
  v_signed := public._signed_in_staff(p_dev.auth_user_id);
  insert into public.stock_counts(id, business_id, shift_id, device_id, staff_id, staff_name, signed_in_staff_id,
                                  counted_at, count_date, note)
    values (v_cid, p_biz, v_shift.id, p_dev.id, v_staff, v_staff_name, v_signed, v_at, v_day,
            left(nullif(btrim(p_d->>'note'), ''), 200));
  for l in select value from jsonb_array_elements(p_d->'lines') loop
    if jsonb_typeof(l) <> 'object' then raise exception 'BAD_COUNT'; end if;
    v_ing := public._ingredient_final(p_biz, public._to_uuid(l->>'ingredient_id'));
    if v_ing.id is null then raise exception 'UNKNOWN_INGREDIENT'; end if;
    if v_ing.id = any(v_seen) or public._is_expense_item(p_biz, v_ing.id) then raise exception 'BAD_COUNT'; end if;
    v_seen := v_seen || v_ing.id;
    v_typed := public._to_num(l->>'quantity');
    if v_typed is null or v_typed < 0 or v_typed > 10000000 then raise exception 'BAD_QUANTITY'; end if;
    -- no unit typed = the stock unit of the item the counter named (an old
    -- counter may still name an ingredient that was merged since)
    select base_unit into v_orig_unit from public.ingredients where id = public._to_uuid(l->>'ingredient_id');
    v_q := public._to_base_qty(v_typed, coalesce(nullif(btrim(l->>'unit'), ''), v_orig_unit), v_ing.base_unit, v_ing.weight_g_per_ml);
    if v_q is null then raise exception 'BAD_UNIT'; end if;
    v_exp := round(public._stock_of(p_biz, v_ing.id), 6);
    if v_q - v_exp > 0.000001 then v_extra := true; end if;
    insert into public.stock_count_lines(business_id, count_id, ingredient_id, name, unit, entered_quantity, entered_unit,
                                         counted, expected, difference)
      values (p_biz, v_cid, v_ing.id, v_ing.name, v_ing.base_unit, v_typed, nullif(btrim(l->>'unit'), ''),
              v_q, v_exp, round(v_q - v_exp, 6));
  end loop;
  v_ticked := public._count_items(p_biz);
  v_reason := nullif(concat_ws(', ',
    case when v_extra then 'COUNT_EXTRA' end,
    case when exists (select 1 from unnest(v_ticked) t where not (t = any(v_seen))) then 'COUNT_INCOMPLETE' end,
    case when v_signed is null or v_signed is distinct from v_staff then 'STAFF_MISMATCH' end,
    case when v_at > now() + interval '1 hour' then 'FUTURE_DATE' end,
    case when v_at < now() - interval '7 days' then 'OLD_DATE' end,
    case when v_fresh is not null and v_at < v_fresh then 'BEFORE_START_FRESH' end,
    case when v_shift.status = 'CLOSED' then 'SHIFT_CLOSED' end), '');
  update public.stock_counts set needs_review = v_reason is not null, review_reason = v_reason where id = v_cid;
  perform public._apply_count_effects(v_cid);
  -- a large amount missing (more than the shop's pay-out review limit, ₱1000
  -- by default) is flagged too, so a big write-off never goes unnoticed
  update public.stock_counts
     set needs_review = true, review_reason = concat_ws(', ', review_reason, 'LARGE_SHORTAGE')
   where id = v_cid
     and shortage_cost > coalesce((select payout_review_limit from public.settings where business_id = p_biz), 1000);
  return 'ok';
end $$;

-- fo_sync: exactly as 004, but each upload goes through _fo_apply_15.
create or replace function public.fo_sync(p_device_key text, p_ops jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_biz uuid := public.current_business_id();
  v_role text; v_dev public.devices%rowtype;
  v_op jsonb; v_d jsonb; v_opid uuid; v_type text; v_status text; v_entity uuid; v_code text;
  v_out jsonb := '[]'::jsonb;
begin
  if v_uid is null or v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  select role into v_role from public.profiles where id = v_uid;
  if v_role is distinct from 'DEVICE' then raise exception 'NOT_ALLOWED'; end if;
  select * into v_dev from public.devices where device_key = p_device_key and business_id = v_biz;
  if not found or not v_dev.active then raise exception 'DEVICE_NOT_REGISTERED'; end if;
  if v_dev.auth_user_id is distinct from v_uid then raise exception 'DEVICE_MISMATCH'; end if;
  update public.devices set last_seen_at = now() where id = v_dev.id;

  if jsonb_typeof(p_ops) is distinct from 'array' then p_ops := '[]'::jsonb; end if;
  for v_op in select value from jsonb_array_elements(p_ops) loop
    v_opid := public._to_uuid(v_op->>'op_id');
    if v_opid is null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_op->'op_id', 'status', 'error', 'message', 'BAD_OP'));
      continue;
    end if;
    v_type := v_op->>'type';
    v_d := case when jsonb_typeof(v_op->'data') = 'object' then v_op->'data' else '{}'::jsonb end;
    if exists (select 1 from public.sync_operations where operation_id = v_opid) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_opid, 'status', 'duplicate'));
      continue;
    end if;
    begin
      v_status := public._fo_apply_15(v_biz, v_dev, v_type, v_d);
      v_entity := public._to_uuid(coalesce(nullif(v_d->>'id', ''), nullif(v_d->'sale'->>'id', ''), nullif(v_d->'refund'->>'id', ''), nullif(v_d->>'recipe_id', '')));
      insert into public.sync_operations(operation_id, business_id, device_id, entity_type, entity_id, operation_type, processed_at, result_summary)
        values (v_opid, v_biz, v_dev.id, v_type, v_entity, v_type, now(), v_status);
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_opid, 'status', v_status));
    exception when others then
      v_code := public._fo_error_code(sqlerrm);
      if v_code = 'SERVER_ERROR' then
        raise log 'fo_sync op % (%) failed: % [%]', v_opid, v_type, sqlerrm, sqlstate;
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_opid, 'status', 'error', 'message', v_code));
    end;
  end loop;
  return v_out;
end $$;

-- =============================================================================
-- PART B5. B15 PRODUCTION: batch size, partner branch (TCO), what we owe
-- =============================================================================
-- Suppliers: "partner branch" (e.g. TCO, the owner's first shop). Just a name
-- in our list (it doesn't join the app as a second shop).
alter table public.suppliers add column if not exists is_partner_branch boolean not null default false;

-- Production batches:
--   scale               batch size as a multiple of the recipe (0.5, 1, 2, ...);
--                       the Back Office sends it for our own batches too
--   source              OWN (made here from our stock) or PARTNER (made by a
--                       partner branch from its own ingredients)
--   partner_supplier_id the partner branch (PARTNER only)
--   debt_kind           PARTNER only: INGREDIENTS (we give the same ingredients
--                       back) or PESOS (we pay their value at our costs)
alter table public.production_batches add column if not exists scale numeric;
alter table public.production_batches add column if not exists source text not null default 'OWN';
alter table public.production_batches add column if not exists partner_supplier_id uuid;
alter table public.production_batches add column if not exists debt_kind text;
do $$
declare spec text[];
  specs text[][] := array[
    array['production_batches', 'production_batches_scale_check',     $c$scale is null or (scale > 0 and scale <= 100)$c$],
    array['production_batches', 'production_batches_source_check',    $c$source in ('OWN','PARTNER')$c$],
    array['production_batches', 'production_batches_debt_kind_check', $c$debt_kind is null or debt_kind in ('INGREDIENTS','PESOS')$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'production_batches_partner_fk') then
    alter table public.production_batches add constraint production_batches_partner_fk
      foreign key (partner_supplier_id) references public.suppliers(id) on delete set null;
  end if;
end $$;

-- What we owe a partner for ONE batch.
--   kind         INGREDIENTS or PESOS (chosen per batch)
--   value        what the batch is worth at OUR ingredient costs on its day
--                (= the batch's cost: production_batches.raw_cost_total)
--   amount_owed  PESOS: the pesos owed (= value); INGREDIENTS: null
--   amount_paid  PESOS: paid so far
--   status       OPEN until fully returned / paid, then SETTLED
create table if not exists public.partner_debts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  batch_id uuid not null references public.production_batches(id),
  supplier_id uuid not null references public.suppliers(id),
  kind text not null,
  status text not null default 'OPEN',
  value numeric not null default 0,
  amount_owed numeric,
  amount_paid numeric not null default 0,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create unique index if not exists partner_debts_batch_key on public.partner_debts(batch_id);
create index if not exists partner_debts_open_idx on public.partner_debts(business_id, supplier_id) where status = 'OPEN';
-- INGREDIENTS debts: one line per ingredient (amounts in its stock unit).
create table if not exists public.partner_debt_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  debt_id uuid not null references public.partner_debts(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id),
  unit text,
  quantity_owed numeric not null,
  quantity_returned numeric not null default 0,
  unit_cost numeric not null default 0
);
create index if not exists partner_debt_lines_debt_idx on public.partner_debt_lines(debt_id);
-- Each return of ingredients (RETURN) or payment (PAYMENT).
--   value  RETURN: what the returned ingredients are worth at the debt's costs;
--          PAYMENT: the pesos paid
--   lines  RETURN: [{ingredient_id, quantity}] in stock units
-- NOT an expense and NOT ingredients used: it settles what the batch already cost.
create table if not exists public.partner_settlements (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  debt_id uuid not null references public.partner_debts(id) on delete cascade,
  kind text not null,
  settled_on date not null,
  value numeric not null default 0,
  lines jsonb not null default '[]'::jsonb,
  note text,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists partner_settlements_debt_idx on public.partner_settlements(debt_id);
do $$
declare spec text[];
  specs text[][] := array[
    array['partner_debts', 'partner_debts_kind_check',   $c$kind in ('INGREDIENTS','PESOS')$c$],
    array['partner_debts', 'partner_debts_status_check', $c$status in ('OPEN','SETTLED')$c$],
    array['partner_debts', 'partner_debts_money_check',  $c$value >= 0 and amount_paid >= 0 and (amount_owed is null or amount_paid <= amount_owed + 0.01)$c$],
    array['partner_debt_lines', 'partner_debt_lines_qty_check', $c$quantity_owed > 0 and quantity_returned >= 0 and quantity_returned <= quantity_owed + 0.000001$c$],
    array['partner_settlements', 'partner_settlements_kind_check', $c$kind in ('RETURN','PAYMENT')$c$],
    array['partner_settlements', 'partner_settlements_note_check', $c$note is null or length(note) <= 200$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
end $$;

-- A partner with recorded debts can't be deleted (PARTNER_HAS_DEBTS), and a
-- partner batch can't be deleted (PARTNER_BATCH_HAS_DEBT): the history stays.
create or replace function public._partner_delete_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'suppliers' and exists (select 1 from public.partner_debts where supplier_id = old.id) then
    raise exception 'PARTNER_HAS_DEBTS';
  end if;
  if tg_table_name = 'production_batches' and exists (select 1 from public.partner_debts where batch_id = old.id) then
    raise exception 'PARTNER_BATCH_HAS_DEBT';
  end if;
  return old;
end $$;
drop trigger if exists suppliers_partner_delete on public.suppliers;
create trigger suppliers_partner_delete before delete on public.suppliers
  for each row execute function public._partner_delete_check();
drop trigger if exists production_batches_partner_delete on public.production_batches;
create trigger production_batches_partner_delete before delete on public.production_batches
  for each row execute function public._partner_delete_check();

-- The plan of a partner batch (nothing is saved). p = {recipe_id, supplier_id,
-- debt_kind, scale | expected_yield, actual_yield, production_date}.
--   scale     = p.scale, else expected_yield / the recipe's normal yield (0 < scale <= 100)
--   expected  = the recipe's normal yield x scale; actual = p.actual_yield
--               (default: expected), both in the recipe's yield unit
--   lines     = the recipe's ingredient lines x scale (operating supplies left
--               out), valued at OUR cost per unit on the production day
--   value     = the sum (rounded to centavos) = what we owe = the batch's cost
-- Errors: NOT_A_PRODUCTION_RECIPE, NOT_A_PARTNER, BAD_DEBT_KIND, BAD_SCALE,
--   BAD_YIELD, BAD_DATE, BAD_UNIT (yield unit doesn't convert to the product's
--   stock unit), NO_INGREDIENTS, DEBT_VALUE_ZERO (pesos but no costs known).
create or replace function public._partner_batch_plan(p_biz uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_r public.recipes%rowtype; v_prod public.ingredients%rowtype; v_sup public.suppliers%rowtype;
  v_kind text := upper(btrim(coalesce(p->>'debt_kind', ''))); v_scale numeric; v_exp numeric; v_act numeric; v_day date;
  v_pq numeric; v_lines jsonb := '[]'::jsonb; v_value numeric := 0; r record; v_q numeric; v_c numeric;
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'NOT_A_PRODUCTION_RECIPE'; end if;
  select * into v_r from public.recipes where id = public._to_uuid(p->>'recipe_id') and business_id = p_biz;
  if not found or not coalesce(v_r.is_production_recipe, false) or coalesce(v_r.expected_yield, 0) <= 0 then
    raise exception 'NOT_A_PRODUCTION_RECIPE';
  end if;
  select * into v_prod from public.ingredients where id = v_r.produced_ingredient_id and business_id = p_biz;
  if not found then raise exception 'NOT_A_PRODUCTION_RECIPE'; end if;
  select * into v_sup from public.suppliers where id = public._to_uuid(p->>'supplier_id') and business_id = p_biz;
  if not found or not v_sup.is_partner_branch then raise exception 'NOT_A_PARTNER'; end if;
  if v_kind not in ('INGREDIENTS', 'PESOS') then raise exception 'BAD_DEBT_KIND'; end if;
  v_scale := coalesce(public._to_num(p->>'scale'), public._to_num(p->>'expected_yield') / v_r.expected_yield);
  if v_scale is null or v_scale <= 0 or v_scale > 100 then raise exception 'BAD_SCALE'; end if;
  v_scale := round(v_scale, 6);
  v_exp := round(v_r.expected_yield * v_scale, 6);
  v_act := coalesce(public._to_num(p->>'actual_yield'), v_exp);
  if v_act <= 0 or v_act > 10000000 then raise exception 'BAD_YIELD'; end if;
  begin v_day := coalesce(nullif(p->>'production_date', '')::date, public._shop_day(p_biz, now()));
  exception when others then raise exception 'BAD_DATE'; end;
  if v_day > public._shop_day(p_biz, now()) + 1 then raise exception 'BAD_DATE'; end if;
  v_pq := public._to_base_qty(v_act, coalesce(nullif(btrim(v_r.yield_unit), ''), v_prod.base_unit), v_prod.base_unit, v_prod.weight_g_per_ml);
  if v_pq is null then raise exception 'BAD_UNIT'; end if;
  for r in select f.id, f.name, f.base_unit, sum(ri.quantity * t.factor) as q
           from public.recipe_ingredients ri
           join lateral public._merge_target(p_biz, ri.ingredient_id) t on true
           join public.ingredients f on f.id = t.id
           where ri.recipe_id = v_r.id and ri.business_id = p_biz and ri.quantity > 0
             and not public._is_expense_item(p_biz, t.id)
           group by f.id, f.name, f.base_unit
           order by f.name loop
    v_q := round(r.q * v_scale, 6);
    if v_q <= 0 then continue; end if;
    v_c := coalesce(public._ingredient_unit_cost(p_biz, r.id, v_day), 0);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ingredient_id', r.id, 'name', r.name, 'unit', r.base_unit,
                                                               'quantity', v_q, 'unit_cost', round(v_c, 6), 'value', round(v_q * v_c, 2)));
    v_value := v_value + v_q * v_c;
  end loop;
  v_value := round(v_value, 2);
  if v_kind = 'INGREDIENTS' and jsonb_array_length(v_lines) = 0 then raise exception 'NO_INGREDIENTS'; end if;
  if v_kind = 'PESOS' and v_value <= 0 then raise exception 'DEBT_VALUE_ZERO'; end if;
  return jsonb_build_object('recipe_id', v_r.id, 'recipe_name', v_r.name, 'produced_ingredient_id', v_prod.id,
    'produced_name', v_prod.name, 'produced_quantity', v_pq, 'produced_unit', v_prod.base_unit,
    'supplier_id', v_sup.id, 'supplier_name', v_sup.name, 'debt_kind', v_kind, 'scale', v_scale,
    'expected_yield', v_exp, 'actual_yield', v_act, 'yield_unit', v_r.yield_unit, 'production_date', v_day,
    'lines', v_lines, 'value', v_value, 'cost_per_unit', round(v_value / v_act, 6),
    'amount_owed', case when v_kind = 'PESOS' then v_value end);
end $$;

-- Back Office: what a partner batch WOULD record (nothing is saved). Same p
-- and errors as produce_partner_batch; returns the plan above.
create or replace function public.partner_batch_preview(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public._require_owner();
begin
  return public._partner_batch_plan(v_biz, p);
end $$;

-- Back Office: record a batch MADE BY A PARTNER BRANCH, all-or-nothing.
-- p = the plan input (above) + {id (uuid made by the app, optional), batch_number, notes}.
--   * the product's stock goes up (PRODUCTION line); our ingredients are NOT taken;
--   * the batch's cost (raw_cost_total) = the value of what we owe, so its cost
--     per unit flows into recipe costs / net income only when the product is used;
--   * the debt (+ its ingredient lines) is recorded; one audit entry.
-- The same id again -> {duplicate:true, batch_id, debt_id}. Returns the plan +
-- {batch_id, debt_id, batch_number}. Errors: as the plan, + NOT_ALLOWED, FORBIDDEN_ROW.
create or replace function public.produce_partner_batch(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_biz uuid := public._require_owner(); v_plan jsonb; v_bid uuid; v_did uuid := gen_random_uuid(); v_no text;
  v_me public.staff; l jsonb; v_owner uuid;
begin
  v_bid := coalesce(public._to_uuid(p->>'id'), gen_random_uuid());
  select business_id into v_owner from public.production_batches where id = v_bid;
  if v_owner is not null then
    if v_owner <> v_biz then raise exception 'FORBIDDEN_ROW'; end if;
    return jsonb_build_object('duplicate', true, 'batch_id', v_bid,
                              'debt_id', (select id from public.partner_debts where batch_id = v_bid));
  end if;
  v_plan := public._partner_batch_plan(v_biz, p);
  v_no := left(nullif(btrim(p->>'batch_number'), ''), 40);
  if v_no is null then
    v_no := 'PB-' || to_char((v_plan->>'production_date')::date, 'YYYYMMDD') || '-'
            || lpad((1 + (select count(*) from public.production_batches
                           where business_id = v_biz and production_date = (v_plan->>'production_date')::date))::text, 3, '0');
  end if;
  insert into public.production_batches(id, business_id, recipe_id, produced_ingredient_id, batch_number, production_date,
      expected_yield, actual_yield, yield_unit, raw_cost_total, actual_cost_per_unit, notes, scale, source, partner_supplier_id, debt_kind)
    values (v_bid, v_biz, (v_plan->>'recipe_id')::uuid, (v_plan->>'produced_ingredient_id')::uuid, v_no,
            (v_plan->>'production_date')::date, (v_plan->>'expected_yield')::numeric, (v_plan->>'actual_yield')::numeric,
            v_plan->>'yield_unit', (v_plan->>'value')::numeric, (v_plan->>'cost_per_unit')::numeric,
            left(nullif(btrim(p->>'notes'), ''), 500), (v_plan->>'scale')::numeric, 'PARTNER',
            (v_plan->>'supplier_id')::uuid, v_plan->>'debt_kind');
  insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date, notes)
    values (v_biz, (v_plan->>'produced_ingredient_id')::uuid, 'PRODUCTION', (v_plan->>'produced_quantity')::numeric, v_bid::text,
            (v_plan->>'production_date')::date, left('Batch ' || v_no || ' made by ' || (v_plan->>'supplier_name'), 200));
  insert into public.partner_debts(id, business_id, batch_id, supplier_id, kind, value, amount_owed)
    values (v_did, v_biz, v_bid, (v_plan->>'supplier_id')::uuid, v_plan->>'debt_kind', (v_plan->>'value')::numeric,
            public._to_num(v_plan->>'amount_owed'));
  if v_plan->>'debt_kind' = 'INGREDIENTS' then
    for l in select value from jsonb_array_elements(v_plan->'lines') loop
      insert into public.partner_debt_lines(business_id, debt_id, ingredient_id, unit, quantity_owed, unit_cost)
        values (v_biz, v_did, (l->>'ingredient_id')::uuid, l->>'unit', (l->>'quantity')::numeric, (l->>'unit_cost')::numeric);
    end loop;
  end if;
  v_me := public._owner_staff(v_biz);
  insert into public.audit_log(business_id, action, actor_id, actor_name, details, reference_id, at)
    values (v_biz, 'Batch produced by partner', v_me.id, coalesce(v_me.name, 'Owner'),
            format('%s: %s %s of %s by %s; we owe %s (value %s)', v_no, round((v_plan->>'actual_yield')::numeric, 3),
                   coalesce(v_plan->>'yield_unit', ''), v_plan->>'produced_name', v_plan->>'supplier_name',
                   case when v_plan->>'debt_kind' = 'PESOS' then 'pesos' else 'ingredients' end, v_plan->>'value'),
            v_bid::text, now());
  return v_plan || jsonb_build_object('batch_id', v_bid, 'debt_id', v_did, 'batch_number', v_no);
end $$;

-- Back Office: give ingredients back to the partner for an INGREDIENTS debt
-- (all of it or part of it).
-- p = {id (uuid made by the app; same id again -> {duplicate:true}), debt_id,
--      returned_on (date, default today), note,
--      lines:[{ingredient_id, quantity, unit}]}  (any unit that converts)
--   * each line must be one of the debt's ingredients and at most what is
--     still owed of it (RETURN_EXCEEDS_DEBT);
--   * stock goes DOWN with the new stock line type PARTNER_RETURN: it is NOT
--     counted as ingredients used, waste or an expense (the batch already
--     carries the cost);
--   * the debt becomes SETTLED when nothing is owed any more.
-- Returns {id, debt_id, status, value, lines:[{ingredient_id, name, quantity, unit, remaining}],
--          stock_below_zero:[ingredient ids now below 0 (a warning, not refused)]}.
-- Errors: NOT_ALLOWED, DEBT_NOT_FOUND, DEBT_NOT_OPEN, WRONG_DEBT_KIND, BAD_RETURN,
--   NOT_IN_DEBT, BAD_QUANTITY, BAD_UNIT, RETURN_EXCEEDS_DEBT, BAD_DATE, FORBIDDEN_ROW.
create or replace function public.partner_return(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_biz uuid := public._require_owner(); v_sid uuid; v_d public.partner_debts%rowtype; v_day date; l jsonb;
  v_ing public.ingredients%rowtype; dl public.partner_debt_lines%rowtype; v_t record; v_typed numeric; v_q numeric;
  v_left numeric; v_seen uuid[] := '{}'; v_out jsonb := '[]'::jsonb; v_value numeric := 0; v_sup text; v_me public.staff;
  v_below uuid[] := '{}'; v_saved jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'BAD_RETURN'; end if;
  v_sid := public._to_uuid(p->>'id');
  if v_sid is null then raise exception 'BAD_RETURN'; end if;
  if exists (select 1 from public.partner_settlements where id = v_sid and business_id = v_biz) then
    return jsonb_build_object('id', v_sid, 'duplicate', true);
  end if;
  if exists (select 1 from public.partner_settlements where id = v_sid) then raise exception 'FORBIDDEN_ROW'; end if;
  select * into v_d from public.partner_debts where id = public._to_uuid(p->>'debt_id') and business_id = v_biz for update;
  if not found then raise exception 'DEBT_NOT_FOUND'; end if;
  if v_d.kind <> 'INGREDIENTS' then raise exception 'WRONG_DEBT_KIND'; end if;
  if v_d.status <> 'OPEN' then raise exception 'DEBT_NOT_OPEN'; end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') not between 1 and 100 then
    raise exception 'BAD_RETURN';
  end if;
  if length(p->>'note') > 200 then raise exception 'BAD_RETURN'; end if;
  begin v_day := coalesce(nullif(p->>'returned_on', '')::date, public._shop_day(v_biz, now()));
  exception when others then raise exception 'BAD_DATE'; end;
  if v_day > public._shop_day(v_biz, now()) + 1 then raise exception 'BAD_DATE'; end if;
  select name into v_sup from public.suppliers where id = v_d.supplier_id;
  for l in select value from jsonb_array_elements(p->'lines') loop
    if jsonb_typeof(l) <> 'object' then raise exception 'BAD_RETURN'; end if;
    v_ing := public._ingredient_final(v_biz, public._to_uuid(l->>'ingredient_id'));
    if v_ing.id is null then raise exception 'NOT_IN_DEBT'; end if;
    -- the debt line of this ingredient (also when it was merged since)
    dl := null; v_t := null;
    select x.* into dl from public.partner_debt_lines x
      where x.debt_id = v_d.id and (select t.id from public._merge_target(v_biz, x.ingredient_id) t) = v_ing.id
      limit 1;
    if dl.id is null or v_ing.id = any(v_seen) then raise exception 'NOT_IN_DEBT'; end if;
    v_seen := v_seen || v_ing.id;
    select * into v_t from public._merge_target(v_biz, dl.ingredient_id);
    v_typed := public._to_num(l->>'quantity');
    if v_typed is null or v_typed <= 0 then raise exception 'BAD_QUANTITY'; end if;
    v_q := public._to_base_qty(v_typed, coalesce(nullif(btrim(l->>'unit'), ''), v_ing.base_unit), v_ing.base_unit, v_ing.weight_g_per_ml);
    if v_q is null then raise exception 'BAD_UNIT'; end if;
    v_left := (dl.quantity_owed - dl.quantity_returned) * v_t.factor;      -- what is still owed, in v_ing's unit
    if v_q > v_left + 0.000001 then raise exception 'RETURN_EXCEEDS_DEBT'; end if;
    v_q := least(v_q, v_left);
    update public.partner_debt_lines set quantity_returned = least(quantity_owed, quantity_returned + v_q / v_t.factor) where id = dl.id;
    insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date, notes)
      values (v_biz, v_ing.id, 'PARTNER_RETURN', round(v_q, 6), v_sid::text, v_day, left('Returned to ' || coalesce(v_sup, 'partner'), 200));
    v_value := v_value + v_q / v_t.factor * dl.unit_cost;
    v_saved := v_saved || jsonb_build_array(jsonb_build_object('ingredient_id', v_ing.id, 'quantity', round(v_q, 6)));
    v_out := v_out || jsonb_build_array(jsonb_build_object('ingredient_id', v_ing.id, 'name', v_ing.name, 'quantity', round(v_q, 6),
                                                           'unit', v_ing.base_unit, 'remaining', round(greatest(v_left - v_q, 0), 6)));
    if public._stock_of(v_biz, v_ing.id) < -0.000001 then v_below := v_below || v_ing.id; end if;
  end loop;
  v_me := public._owner_staff(v_biz);
  insert into public.partner_settlements(id, business_id, debt_id, kind, settled_on, value, lines, note, created_by_name)
    values (v_sid, v_biz, v_d.id, 'RETURN', v_day, round(v_value, 2), v_saved, left(nullif(btrim(p->>'note'), ''), 200),
            coalesce(v_me.name, 'Owner'));
  if not exists (select 1 from public.partner_debt_lines where debt_id = v_d.id and quantity_owed - quantity_returned > 0.000001) then
    update public.partner_debts set status = 'SETTLED', settled_at = now() where id = v_d.id;
  end if;
  insert into public.audit_log(business_id, action, actor_id, actor_name, details, reference_id, at)
    values (v_biz, 'Ingredients returned to partner', v_me.id, coalesce(v_me.name, 'Owner'),
            format('%s: %s line(s), value %s', coalesce(v_sup, 'partner'), jsonb_array_length(v_saved), round(v_value, 2)),
            v_sid::text, now());
  return jsonb_build_object('id', v_sid, 'debt_id', v_d.id, 'status', (select status from public.partner_debts where id = v_d.id),
                            'value', round(v_value, 2), 'lines', v_out, 'stock_below_zero', to_jsonb(v_below));
end $$;

-- Back Office: pay pesos on a PESOS debt (all of it or part of it).
-- p = {id (uuid made by the app; same id again -> {duplicate:true}), debt_id,
--      paid_on (date, default today), amount (> 0), note}
--   * never more than what is still owed (PAYMENT_TOO_LARGE; 1 centavo allowed);
--   * NOT an expense (the batch already carries the cost); SETTLED when paid in full.
-- Returns {id, debt_id, status, amount, amount_paid, remaining}.
-- Errors: NOT_ALLOWED, DEBT_NOT_FOUND, DEBT_NOT_OPEN, WRONG_DEBT_KIND, BAD_PAYMENT,
--   BAD_AMOUNT, PAYMENT_TOO_LARGE, BAD_DATE, FORBIDDEN_ROW.
create or replace function public.partner_pay(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_biz uuid := public._require_owner(); v_sid uuid; v_d public.partner_debts%rowtype; v_day date; v_amt numeric;
  v_left numeric; v_me public.staff; v_sup text;
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'BAD_PAYMENT'; end if;
  v_sid := public._to_uuid(p->>'id');
  if v_sid is null then raise exception 'BAD_PAYMENT'; end if;
  if exists (select 1 from public.partner_settlements where id = v_sid and business_id = v_biz) then
    return jsonb_build_object('id', v_sid, 'duplicate', true);
  end if;
  if exists (select 1 from public.partner_settlements where id = v_sid) then raise exception 'FORBIDDEN_ROW'; end if;
  select * into v_d from public.partner_debts where id = public._to_uuid(p->>'debt_id') and business_id = v_biz for update;
  if not found then raise exception 'DEBT_NOT_FOUND'; end if;
  if v_d.kind <> 'PESOS' then raise exception 'WRONG_DEBT_KIND'; end if;
  if v_d.status <> 'OPEN' then raise exception 'DEBT_NOT_OPEN'; end if;
  v_amt := round(public._to_num(p->>'amount'), 2);
  if v_amt is null or v_amt <= 0 then raise exception 'BAD_AMOUNT'; end if;
  v_left := round(coalesce(v_d.amount_owed, 0) - v_d.amount_paid, 2);
  if v_amt > v_left + 0.01 then raise exception 'PAYMENT_TOO_LARGE'; end if;
  v_amt := least(v_amt, v_left);
  if length(p->>'note') > 200 then raise exception 'BAD_PAYMENT'; end if;
  begin v_day := coalesce(nullif(p->>'paid_on', '')::date, public._shop_day(v_biz, now()));
  exception when others then raise exception 'BAD_DATE'; end;
  if v_day > public._shop_day(v_biz, now()) + 1 then raise exception 'BAD_DATE'; end if;
  v_me := public._owner_staff(v_biz);
  insert into public.partner_settlements(id, business_id, debt_id, kind, settled_on, value, note, created_by_name)
    values (v_sid, v_biz, v_d.id, 'PAYMENT', v_day, v_amt, left(nullif(btrim(p->>'note'), ''), 200), coalesce(v_me.name, 'Owner'));
  update public.partner_debts
     set amount_paid = amount_paid + v_amt,
         status = case when coalesce(amount_owed, 0) - (amount_paid + v_amt) <= 0.005 then 'SETTLED' else 'OPEN' end,
         settled_at = case when coalesce(amount_owed, 0) - (amount_paid + v_amt) <= 0.005 then now() end
   where id = v_d.id returning * into v_d;
  select name into v_sup from public.suppliers where id = v_d.supplier_id;
  insert into public.audit_log(business_id, action, actor_id, actor_name, details, reference_id, at)
    values (v_biz, 'Partner paid', v_me.id, coalesce(v_me.name, 'Owner'),
            format('%s: %s paid, %s left', coalesce(v_sup, 'partner'), v_amt, round(coalesce(v_d.amount_owed, 0) - v_d.amount_paid, 2)),
            v_sid::text, now());
  return jsonb_build_object('id', v_sid, 'debt_id', v_d.id, 'status', v_d.status, 'amount', v_amt,
                            'amount_paid', v_d.amount_paid, 'remaining', round(coalesce(v_d.amount_owed, 0) - v_d.amount_paid, 2));
end $$;

-- "To return to TCO": every OPEN debt, one row per ingredient still owed, plus
-- one row per peso debt. Owner only (the tables under it are owner only).
--   kind INGREDIENTS: owed / returned / remaining in the ingredient's stock unit
--                     (unit), value_remaining = remaining x the debt's cost
--   kind PESOS:       owed / returned / remaining in pesos (unit 'PHP'),
--                     value_remaining = remaining
drop view if exists public.v_partner_to_return;
create view public.v_partner_to_return with (security_invoker = true) as
select d.business_id, d.supplier_id, s.name as supplier_name, d.id as debt_id, d.batch_id, b.batch_number, b.production_date,
       b.produced_ingredient_id, pi.name as product_name, d.kind, d.created_at,
       l.ingredient_id, i.name as ingredient_name, l.unit,
       l.quantity_owed as owed, l.quantity_returned as returned,
       round(greatest(l.quantity_owed - l.quantity_returned, 0), 6) as remaining,
       l.unit_cost, round(greatest(l.quantity_owed - l.quantity_returned, 0) * l.unit_cost, 2) as value_remaining
from public.partner_debts d
join public.partner_debt_lines l on l.debt_id = d.id
left join public.suppliers s on s.id = d.supplier_id
left join public.production_batches b on b.id = d.batch_id
left join public.ingredients pi on pi.id = b.produced_ingredient_id
left join public.ingredients i on i.id = l.ingredient_id
where d.status = 'OPEN' and d.kind = 'INGREDIENTS' and l.quantity_owed - l.quantity_returned > 0.000001
union all
select d.business_id, d.supplier_id, s.name, d.id, d.batch_id, b.batch_number, b.production_date,
       b.produced_ingredient_id, pi.name, d.kind, d.created_at,
       null::uuid, null::text, 'PHP',
       d.amount_owed, d.amount_paid, round(greatest(coalesce(d.amount_owed, 0) - d.amount_paid, 0), 6),
       1::numeric, round(greatest(coalesce(d.amount_owed, 0) - d.amount_paid, 0), 2)
from public.partner_debts d
left join public.suppliers s on s.id = d.supplier_id
left join public.production_batches b on b.id = d.batch_id
left join public.ingredients pi on pi.id = b.produced_ingredient_id
where d.status = 'OPEN' and d.kind = 'PESOS';

-- =============================================================================
-- PART B6. REPORTS: waste (R&D per project, count shortages) and net income
-- =============================================================================
-- Waste report: same as 010, plus
--   source:   COUNTER for entries uploaded by a counter (incl. COUNT_SHORTAGE),
--             OFFICE for the Back Office (the waste table AND R&D usage)
--   entries[].project_id / project_name (R&D), entries[].stock_count_id (count)
--   by_project: [{project_id, name, status, entries, cost}]  (R&D only)
create or replace function public.waste_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public._require_owner();
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_DATE'; end if;
  return (
    with e as (
      select l.id, case when l.device_id is null then 'OFFICE' else 'COUNTER' end::text as source, l.waste_date as day, l.reason,
             l.note, l.staff_name, l.approved_by_name, l.needs_review, l.total_cost as cost, l.received_at as at,
             l.rnd_project_id as project_id, (select p.name from public.rnd_projects p where p.id = l.rnd_project_id) as project_name,
             l.stock_count_id,
             coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity, 'unit', i.unit,
                                                           'recipe_id', i.recipe_id, 'ingredient_id', i.ingredient_id,
                                                           'modifiers', i.modifiers, 'cost', i.cost))
                       from public.waste_log_items i where i.waste_log_id = l.id and i.business_id = v_biz), '[]'::jsonb) as items
      from public.waste_logs l
      where l.business_id = v_biz and l.waste_date between p_from and p_to
      union all
      select w.id, 'OFFICE', w.date, coalesce(nullif(btrim(w.reason), ''), 'Other'), w.notes, null, null, false,
             round(coalesce(w.quantity, 0) * public._ingredient_unit_cost(v_biz, w.ingredient_id, w.date), 4), w.created_at,
             null::uuid, null::text, null::uuid,
             jsonb_build_array(jsonb_build_object('name', (select name from public.ingredients where id = w.ingredient_id),
                                                  'quantity', w.quantity, 'unit', w.unit, 'recipe_id', null,
                                                  'ingredient_id', w.ingredient_id, 'modifiers', '[]'::jsonb,
                                                  'cost', round(coalesce(w.quantity, 0) * public._ingredient_unit_cost(v_biz, w.ingredient_id, w.date), 4)))
      from public.waste w
      where w.business_id = v_biz and w.date between p_from and p_to
    )
    select jsonb_build_object(
      'from', p_from, 'to', p_to,
      'total_cost', round(coalesce((select sum(cost) from e), 0), 2),
      'by_reason', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'entries', n, 'cost', round(c, 2)) order by c desc)
                             from (select reason, count(*) as n, sum(cost) as c from e group by reason) x), '[]'::jsonb),
      'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'reason', reason, 'source', source, 'entries', n, 'cost', round(c, 2))
                                           order by day, reason)
                          from (select day, reason, source, count(*) as n, sum(cost) as c from e group by day, reason, source) x), '[]'::jsonb),
      'by_project', coalesce((select jsonb_agg(jsonb_build_object('project_id', p.id, 'name', p.name, 'status', p.status,
                                                                  'entries', x.n, 'cost', round(x.c, 2)) order by x.c desc, p.name)
                              from (select project_id, count(*) as n, sum(cost) as c from e where project_id is not null group by project_id) x
                              join public.rnd_projects p on p.id = x.project_id), '[]'::jsonb),
      'entries', coalesce((select jsonb_agg(to_jsonb(x) - 'at' order by x.day desc, x.at desc)
                           from (select * from e order by day desc, at desc limit 500) x), '[]'::jsonb)));
end $$;

-- The month's net income: same as 010, plus a breakdown of the waste line
-- (it is still all inside ingredients.wasted / used, nothing is counted twice):
--   ingredients.rnd            cost of R&D usage stock lines of the month
--   ingredients.count_shortage cost of "missing at count" stock lines
--   rnd_projects: [{project_id, name, status, cost}]
-- Not counted (B15 money rule): PARTNER_RETURN stock lines (ingredients given
-- back to a partner) and partner payments; the partner batch's cost reaches
-- the report only when its product is sold or wasted.
create or replace function public.net_income_report(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_biz uuid := public._require_owner();
  v_tz text; v_from date; v_to date; v_from_ts timestamptz; v_to_ts timestamptz;
  v_gross numeric; v_tax numeric; v_svc numeric; v_count integer; v_ref numeric; v_ref_tax numeric;
  v_sold numeric; v_wasted numeric; v_exp numeric; v_by jsonb; v_rnd numeric; v_short numeric; v_projects jsonb;
begin
  if p_month is null then raise exception 'BAD_DATE'; end if;
  select coalesce(nullif(btrim(timezone), ''), 'Asia/Manila') into v_tz from public.settings where business_id = v_biz;
  v_tz := coalesce(v_tz, 'Asia/Manila');
  v_from := date_trunc('month', p_month)::date;
  v_to := (v_from + interval '1 month')::date - 1;
  v_from_ts := v_from::timestamp at time zone v_tz;
  v_to_ts := (v_to + 1)::timestamp at time zone v_tz;
  select coalesce(sum(grand_total), 0), coalesce(sum(tax_amount), 0), coalesce(sum(service_charge_amount), 0), count(*)
    into v_gross, v_tax, v_svc, v_count
    from public.sales
    where business_id = v_biz and status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
      and coalesce(transaction_date, created_at) >= v_from_ts and coalesce(transaction_date, created_at) < v_to_ts;
  select coalesce(sum(r.amount), 0),
         coalesce(sum(case when coalesce(s.grand_total, 0) > 0 then r.amount * coalesce(s.tax_amount, 0) / s.grand_total else 0 end), 0)
    into v_ref, v_ref_tax
    from public.refunds r join public.sales s on s.id = r.sale_id
    where r.business_id = v_biz and r.type <> 'VOID' and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
      and coalesce(r.date, r.created_at) >= v_from_ts and coalesce(r.date, r.created_at) < v_to_ts;
  with c as (
    select t.ingredient_id, t.transaction_type, sum(abs(t.quantity)) as q
    from public.inventory_transactions t
    where t.business_id = v_biz and t.transaction_date between v_from and v_to
      and t.transaction_type in ('SALE_USAGE', 'SALE_REVERSAL', 'WASTE')
    group by t.ingredient_id, t.transaction_type
  ), u as (
    select c.*, public._ingredient_unit_cost(v_biz, c.ingredient_id, v_to) as unit_cost from c
  )
  select coalesce(sum(case when transaction_type = 'SALE_USAGE' then q * unit_cost
                           when transaction_type = 'SALE_REVERSAL' then -q * unit_cost else 0 end), 0),
         coalesce(sum(case when transaction_type = 'WASTE' then q * unit_cost else 0 end), 0)
    into v_sold, v_wasted from u;
  -- 012: the R&D and count-shortage parts of the waste (same costs as above)
  with w as (
    select t.ingredient_id, abs(t.quantity) as q, wl.rnd_project_id, sc.id as count_id
    from public.inventory_transactions t
    left join public.waste_logs wl on wl.business_id = v_biz and wl.reason = 'RND' and wl.id::text = t.reference_id
    left join public.stock_counts sc on sc.business_id = v_biz and sc.id::text = t.reference_id
    where t.business_id = v_biz and t.transaction_date between v_from and v_to and t.transaction_type = 'WASTE'
      and (wl.id is not null or sc.id is not null)
  ), wc as (
    select w.*, w.q * public._ingredient_unit_cost(v_biz, w.ingredient_id, v_to) as cost from w
  )
  select coalesce(sum(cost) filter (where rnd_project_id is not null), 0),
         coalesce(sum(cost) filter (where count_id is not null), 0),
         coalesce((select jsonb_agg(jsonb_build_object('project_id', p.id, 'name', p.name, 'status', p.status, 'cost', round(x.c, 2))
                                    order by x.c desc, p.name)
                   from (select rnd_project_id, sum(cost) as c from wc where rnd_project_id is not null group by rnd_project_id) x
                   join public.rnd_projects p on p.id = x.rnd_project_id), '[]'::jsonb)
    into v_rnd, v_short, v_projects from wc;
  select coalesce(sum(amount), 0) into v_exp from public.expenses
    where business_id = v_biz and expense_date between v_from and v_to;
  select coalesce(jsonb_object_agg(category, round(t, 2)), '{}'::jsonb) into v_by
    from (select category, sum(amount) as t from public.expenses
          where business_id = v_biz and expense_date between v_from and v_to group by category) x;
  return jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'), 'from', v_from, 'to', v_to,
    'sales', jsonb_build_object('gross', round(v_gross, 2), 'refunds', round(v_ref, 2),
                                'tax', round(v_tax - v_ref_tax, 2),
                                'net', round(v_gross - v_ref, 2) - round(v_tax - v_ref_tax, 2),
                                'service_charge', round(v_svc, 2), 'count', v_count),
    'ingredients', jsonb_build_object('sold', round(v_sold, 2), 'wasted', round(v_wasted, 2), 'used', round(v_sold + v_wasted, 2),
                                      'rnd', round(v_rnd, 2), 'count_shortage', round(v_short, 2)),
    'rnd_projects', v_projects,
    'expenses', jsonb_build_object('total', round(v_exp, 2), 'by_category', v_by),
    'net_income', round(v_gross - v_ref, 2) - round(v_tax - v_ref_tax, 2) - round(v_sold + v_wasted, 2) - round(v_exp, 2));
end $$;

-- =============================================================================
-- 9. BACK OFFICE WRITES, SAME-SHOP LINKS, ROW LEVEL SECURITY
-- =============================================================================
-- apply_changes may write: same as 010, plus rnd_projects. (Stock counts,
-- partner debts / returns / payments and R&D usage are written ONLY by their
-- functions above, never directly.)
create or replace function public._writable_tables() returns text[]
language sql immutable as $$
  select array['categories','suppliers','ingredients','recipes','recipe_ingredients','purchases','production_batches',
    'waste','inventory_transactions','settings','stores','dining_tables','staff','devices','customers','sales',
    'sale_items','payments','refunds','shifts','cash_movements','audit_log','qr_orders','businesses',
    'ingredient_brands','floor_shapes','loyalty_redemptions',
    'option_groups','option_group_recipes','expenses','waste_logs','waste_log_items','ingredient_costs',
    'rnd_projects']
$$;

-- Links on the new columns must stay inside the shop, whoever writes them
-- (same trigger as 010, H1).
drop trigger if exists waste_logs_same_shop on public.waste_logs;
create trigger waste_logs_same_shop before insert or update on public.waste_logs
  for each row execute function public._same_shop_links('shift_id', 'shifts', 'rnd_project_id', 'rnd_projects', 'stock_count_id', 'stock_counts');
drop trigger if exists production_batches_same_shop on public.production_batches;
create trigger production_batches_same_shop before insert or update of partner_supplier_id, business_id on public.production_batches
  for each row execute function public._same_shop_links('partner_supplier_id', 'suppliers');
drop trigger if exists stock_counts_same_shop on public.stock_counts;
create trigger stock_counts_same_shop before insert or update on public.stock_counts
  for each row execute function public._same_shop_links('shift_id', 'shifts');
drop trigger if exists stock_count_lines_same_shop on public.stock_count_lines;
create trigger stock_count_lines_same_shop before insert or update on public.stock_count_lines
  for each row execute function public._same_shop_links('count_id', 'stock_counts', 'ingredient_id', 'ingredients');
drop trigger if exists partner_debts_same_shop on public.partner_debts;
create trigger partner_debts_same_shop before insert or update on public.partner_debts
  for each row execute function public._same_shop_links('batch_id', 'production_batches', 'supplier_id', 'suppliers');
drop trigger if exists partner_debt_lines_same_shop on public.partner_debt_lines;
create trigger partner_debt_lines_same_shop before insert or update on public.partner_debt_lines
  for each row execute function public._same_shop_links('debt_id', 'partner_debts', 'ingredient_id', 'ingredients');
drop trigger if exists partner_settlements_same_shop on public.partner_settlements;
create trigger partner_settlements_same_shop before insert or update on public.partner_settlements
  for each row execute function public._same_shop_links('debt_id', 'partner_debts');

-- Row Level Security for the new tables:
--   rnd_projects: owner reads and writes (apply_changes).
--   stock_counts, stock_count_lines: office data (like waste_logs): logins with
--     a staff-type profile (the owner's email login) read; NOBODY writes through
--     the API (counters upload through fo_sync, the owner revises through
--     revise_stock_count).
--   partner_debts, partner_debt_lines, partner_settlements: owner reads;
--     nobody writes through the API (only the partner functions).
-- Customers (anonymous logins) and the public never touch any of them.
do $$
declare t text; p record;
begin
  foreach t in array array['rnd_projects','stock_counts','stock_count_lines','partner_debts','partner_debt_lines','partner_settlements'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    if t in ('stock_counts', 'stock_count_lines') then
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 1)', t || '_read', t);
    else
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_read', t);
    end if;
    if t = 'rnd_projects' then
      execute format('create policy %I on public.%I for insert to authenticated with check (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_admin_insert', t);
      execute format('create policy %I on public.%I for update to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3) with check (business_id = (select public.current_business_id()))', t || '_admin_update', t);
      execute format('create policy %I on public.%I for delete to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_admin_delete', t);
    else
      execute format('revoke insert, update, delete on public.%I from authenticated', t);
    end if;
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);
  end loop;
end $$;
revoke all on public.v_partner_to_return from anon;
revoke all on public.v_partner_to_return from authenticated;
grant select on public.v_partner_to_return to authenticated;

-- =============================================================================
-- 10. ONE-TIME FILL: usernames for existing customers (Q2)
-- =============================================================================
-- Every customer without a username gets one (the trigger above makes it).
-- Running the script again changes nothing (they all have one by then).
update public.customers set username = null where username is null and merged_into is null;

-- =============================================================================
-- Who may call the new / re-made functions
-- =============================================================================
-- Every function this script makes is first locked, then opened only where meant:
--   logged-in shop users (each checks the caller's shop / role itself):
--     fo_sync, fo_customer_list (counters); log_rnd_usage, delete_rnd_usage,
--     revise_stock_count, partner_batch_preview, produce_partner_batch,
--     partner_return, partner_pay, waste_report, net_income_report (owner only,
--     checked inside)
--   QR customers (re-made, same rights as in 004): get_qr_menu, qr_session,
--     qr_relink, qr_forget_device, qr_place_order (anon + authenticated)
--   QR customers, NEW: qr_set_username, qr_switch_account (authenticated only:
--     a QR customer is always signed in, anonymously; the public key without
--     any sign-in gets nothing new)
--   everything else here is internal (no API access).
drop function if exists public._tmp_widen_check(text, text, text, text[]);
do $$
declare f record;
  mine text[] := array['_shop_day','_stock_of','_owner_staff','_clean_username','_username_base','_new_username',
    '_customer_username_check','_qr_limits','_qr_customer_json','qr_session','qr_set_username','qr_relink',
    'qr_switch_account','qr_forget_device','qr_place_order','_customer_for_staff','_counter_customer_json',
    'fo_customer_list','_qr_menu_groups','get_qr_menu','_barista_kit_problem','_settings_check',
    '_rnd_project_check','_rnd_project_delete_check','_waste_item','log_rnd_usage','delete_rnd_usage','_count_items','_apply_count_effects',
    'revise_stock_count','_fo_error_code','_fo_apply_15','fo_sync','_partner_delete_check','_partner_batch_plan',
    'partner_batch_preview','produce_partner_batch','partner_return','partner_pay','waste_report','net_income_report',
    '_writable_tables'];
  member_fns text[] := array['fo_sync','fo_customer_list','log_rnd_usage','delete_rnd_usage','revise_stock_count',
    'partner_batch_preview','produce_partner_batch','partner_return','partner_pay','waste_report','net_income_report'];
  public_fns text[] := array['get_qr_menu','qr_session','qr_relink','qr_forget_device','qr_place_order'];
  signed_in_fns text[] := array['qr_set_username','qr_switch_account'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any(mine)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any(public_fns) then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif f.proname = any(member_fns) or f.proname = any(signed_in_fns) then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

commit;

-- Tell the API about the new tables / columns / functions right away.
notify pgrst, 'reload schema';
