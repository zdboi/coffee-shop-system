-- =============================================================================
-- Cavite City Coffee Club — 004: online POS, QR ordering, customers, security fixes
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- It is safe to run more than once (it only adds or replaces its own objects).
-- It runs inside one transaction: if anything fails, nothing is changed.
--
-- What it does, in plain words:
--   1. Fixes the signup function so customer / counter logins never create
--      a new business.
--   2. Blocks staff from promoting themselves to ADMIN.
--   3. Moves staff PINs into a locked table (bcrypt hashed, never readable).
--   4. Adds: staff, counter devices (pairing codes), customers, tables with
--      QR codes, QR orders, and the functions the apps call.
--   5. Replaces the old "anyone in the business can change anything" rules
--      with: everyone in the business can READ, only admins can CHANGE.
--      Counter sales go through one checked function (fo_sync).
--   6. Security decisions of 2026-10-12:
--      * Admin rights come ONLY from the owner's email login (profile role
--        ADMIN). A staff PIN on a counter never gives admin rights.
--      * Counters join only with a pairing code (no owner sign-in on a counter).
--      * Refunds, voids, discounts and closing someone else's shift must carry
--        a manager approval token that the server checks; refunds can't exceed
--        what is left of the sale.
--      * A finished counter sale must add up (items, discount, tax, total);
--        sales below the menu price are flagged "needs review" for the owner.
--      * Counters never see full customer phone numbers (only masked ones).
--      * Answers that reveal whether a phone number is registered are
--        rate-limited per login; wrong PINs lock the counter for longer
--        and longer.
-- =============================================================================
begin;

create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- 1. Core helper: which business does the logged-in user belong to?
-- -----------------------------------------------------------------------------
create or replace function public.current_business_id() returns uuid
language sql stable security definer set search_path = public as $$
  select business_id from public.profiles where id = auth.uid()
$$;

-- -----------------------------------------------------------------------------
-- 2. New tables
-- -----------------------------------------------------------------------------
create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  profile_id uuid,                 -- set on the owner's own row (their email login)
  local_id text,                   -- id from the old offline app, if imported
  name text not null,
  role text not null default 'CASHIER' check (role in ('ADMIN','MANAGER','CASHIER')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists staff_business_idx on public.staff(business_id);

-- PIN hashes live here. Row Level Security is ON with NO policies, so nobody can
-- read this table through the API — only the PIN functions below can.
create table if not exists public.staff_pins (
  staff_id uuid primary key references public.staff(id) on delete cascade,
  pin_hash text,                   -- bcrypt
  legacy_sha256 text,              -- imported from the old offline app; upgraded on first login
  updated_at timestamptz not null default now()
);

-- One row per PIN login on a counter. The app keeps the secret token; we only
-- store its fingerprint (sha256), so a database leak can't be replayed.
--   purpose LOGIN    = staff member signed in on the counter (16 hours)
--   purpose OVERRIDE = one-time manager approval for a refund / void / discount
create table if not exists public.staff_sessions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  device_user_id uuid not null,
  token_hash text not null unique,
  purpose text not null default 'LOGIN',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
-- When an OVERRIDE approval was spent, and on what (e.g. 'refund:<id>').
-- A spent approval can never approve a second action.
alter table public.staff_sessions add column if not exists used_at timestamptz;
alter table public.staff_sessions add column if not exists used_for text;

-- Failed PIN / pairing / phone-relink attempts (and counter phone look-ups),
-- for rate limiting.
create table if not exists public.auth_attempts (
  id bigint generated always as identity primary key,
  subject uuid not null,
  kind text not null,
  success boolean not null,
  at timestamptz not null default now()
);
create index if not exists auth_attempts_subject_idx on public.auth_attempts(subject, kind, at);

create table if not exists public.device_pairing_codes (
  code text primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  device_name text,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  nickname text not null,
  phone text,
  notes text,
  source text not null default 'QR',
  consent_at timestamptz,
  visit_count integer not null default 0,
  total_spent numeric not null default 0,
  stamps integer not null default 0,
  points numeric not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_order_at timestamptz,
  merged_into uuid references public.customers(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_business_idx on public.customers(business_id);
create unique index if not exists customers_business_phone_key on public.customers(business_id, phone)
  where phone is not null and merged_into is null;

-- Which phone/browser (anonymous login) belongs to which customer.
create table if not exists public.customer_devices (
  auth_user_id uuid not null,
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (auth_user_id, business_id)
);

create table if not exists public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  label text not null,
  kind text not null default 'DINE_IN' check (kind in ('DINE_IN','TAKEAWAY')),
  qr_token text not null default encode(extensions.gen_random_bytes(8), 'hex'),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists dining_tables_qr_token_key on public.dining_tables(qr_token);
create index if not exists dining_tables_business_idx on public.dining_tables(business_id);

create table if not exists public.qr_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_number text not null,
  order_day date not null,
  table_id uuid references public.dining_tables(id) on delete set null,
  table_label text,
  order_type text not null default 'DINE_IN' check (order_type in ('DINE_IN','TAKEAWAY')),
  customer_id uuid references public.customers(id) on delete set null,
  customer_nickname text,
  auth_user_id uuid,
  status text not null default 'PENDING' check (status in ('PENDING','PREPARING','READY','COMPLETED','REJECTED','CANCELLED')),
  items jsonb not null default '[]'::jsonb,
  subtotal numeric not null default 0,
  tax_amount numeric not null default 0,
  service_charge_amount numeric not null default 0,
  total numeric not null default 0,
  customer_note text,
  reject_reason text,
  sale_id uuid,
  paid_at timestamptz,
  handled_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz
);
create index if not exists qr_orders_business_created_idx on public.qr_orders(business_id, created_at desc);
create index if not exists qr_orders_business_updated_idx on public.qr_orders(business_id, updated_at);
create index if not exists qr_orders_auth_user_idx on public.qr_orders(auth_user_id);
create index if not exists qr_orders_customer_idx on public.qr_orders(customer_id);

create table if not exists public.qr_order_counters (
  business_id uuid not null references public.businesses(id) on delete cascade,
  day date not null,
  last_no integer not null default 0,
  primary key (business_id, day)
);

-- -----------------------------------------------------------------------------
-- 3. Additions to existing tables (all additive)
-- -----------------------------------------------------------------------------
alter table public.devices add column if not exists auth_user_id uuid;
alter table public.devices add column if not exists device_key text;
alter table public.devices add column if not exists active boolean not null default true;
alter table public.devices add column if not exists paired_at timestamptz;
create unique index if not exists devices_device_key_key on public.devices(device_key);

alter table public.recipes add column if not exists description text;
alter table public.recipes add column if not exists image_url text;
alter table public.recipes add column if not exists qr_visible boolean not null default true;
alter table public.recipes add column if not exists sold_out boolean not null default false;
alter table public.recipes add column if not exists sort_order integer not null default 0;

alter table public.sales add column if not exists customer_id uuid;
alter table public.sales add column if not exists qr_order_id uuid;
alter table public.sales add column if not exists source text not null default 'COUNTER';
alter table public.sales add column if not exists offline boolean not null default false;
alter table public.sales add column if not exists discount_approved_by uuid;
alter table public.sales add column if not exists discount_approved_by_name text;
-- Set by the server when a counter sale looks odd (e.g. sold below the menu price),
-- so the owner can check it in the Back Office ("Needs review"). The owner clears
-- it after checking (apply_changes update: needs_review = false).
alter table public.sales add column if not exists needs_review boolean not null default false;
alter table public.sales add column if not exists review_reason text;
create index if not exists sales_business_date_idx on public.sales(business_id, transaction_date);
create index if not exists sales_shift_idx on public.sales(shift_id);
create index if not exists sales_customer_idx on public.sales(customer_id);
create index if not exists sales_needs_review_idx on public.sales(business_id, transaction_date) where needs_review;

alter table public.sale_items add column if not exists notes text;
create index if not exists sale_items_sale_idx on public.sale_items(sale_id);
create index if not exists payments_sale_idx on public.payments(sale_id);
create index if not exists refunds_sale_idx on public.refunds(sale_id);
create index if not exists inventory_tx_ingredient_idx on public.inventory_transactions(ingredient_id);
create index if not exists inventory_tx_business_date_idx on public.inventory_transactions(business_id, transaction_date);
create index if not exists inventory_tx_reference_idx on public.inventory_transactions(reference_id);

alter table public.waste add column if not exists created_at timestamptz not null default now();
alter table public.shifts add column if not exists closed_by uuid;
alter table public.shifts add column if not exists closed_by_name text;

alter table public.settings add column if not exists qr_ordering_enabled boolean not null default true;
alter table public.settings add column if not exists qr_welcome_message text default 'Order from your phone, pay at the counter.';
alter table public.settings add column if not exists qr_payment_note text default 'Please pay at the counter when your order is called.';
alter table public.settings add column if not exists qr_hide_out_of_stock boolean not null default false;
alter table public.settings add column if not exists loyalty_enabled boolean not null default false;
alter table public.settings add column if not exists stamps_per_reward integer not null default 10;
alter table public.settings add column if not exists timezone text not null default 'Asia/Manila';
alter table public.settings add column if not exists theme text not null default 'light';
alter table public.settings add column if not exists order_page_url text;

create unique index if not exists sync_operations_operation_id_key on public.sync_operations(operation_id);
create unique index if not exists settings_business_id_key on public.settings(business_id);

-- New rows get the right business automatically, plus ids / timestamps.
do $$
declare t text;
begin
  foreach t in array array['audit_log','cash_movements','categories','devices','ingredients','inventory_transactions',
    'payments','production_batches','purchases','recipe_ingredients','recipes','reconciliation_issues','refunds',
    'sale_items','sales','shifts','stores','suppliers','sync_operations','waste'] loop
    execute format('alter table public.%I alter column business_id set default public.current_business_id()', t);
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name=t and column_name='id' and data_type='uuid') then
      execute format('alter table public.%I alter column id set default gen_random_uuid()', t);
    end if;
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name=t and column_name='created_at') then
      execute format('alter table public.%I alter column created_at set default now()', t);
    end if;
  end loop;
end $$;

-- CHECK constraints: replace whatever exists on these columns with the full list of
-- values the apps use (the old lists could be missing e.g. 'DEVICE' or 'MAYA').
do $$
declare
  spec text[];
  specs text[][] := array[
    array['profiles','role',              $c$role in ('ADMIN','MANAGER','CASHIER','DEVICE')$c$],
    array['inventory_transactions','transaction_type', $c$transaction_type in ('PURCHASE','INITIAL_STOCK','USAGE','WASTE','ADJUSTMENT','PRODUCTION','PRODUCTION_USE','SALE_USAGE','SALE_REVERSAL')$c$],
    array['sales','status',               $c$status in ('HELD','COMPLETED','VOIDED','REFUNDED','PARTIALLY_REFUNDED')$c$],
    array['payments','method',            $c$method in ('CASH','GCASH','MAYA','CARD','BANK','OTHER')$c$],
    array['refunds','type',               $c$type in ('VOID','FULL_REFUND','PARTIAL_REFUND')$c$],
    array['cash_movements','type',        $c$type in ('PAY_IN','PAY_OUT')$c$],
    array['shifts','status',              $c$status in ('ACTIVE','CLOSED')$c$],
    array['recipes','recipe_type',        $c$recipe_type in ('DRINKS','SAUCES_SYRUPS','PASTRY','FOOD')$c$],
    array['sales','source',               $c$source in ('COUNTER','QR')$c$]
  ];
  r record;
begin
  foreach spec slice 1 in array specs loop
    for r in
      select c.conname from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.conrelid = format('public.%I', spec[1])::regclass and c.contype = 'c' and a.attname = spec[2]
    loop
      execute format('alter table public.%I drop constraint %I', spec[1], r.conname);
    end loop;
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[1] || '_' || spec[2] || '_check', spec[3]);
  end loop;
end $$;

-- "Who did it" columns now point at staff members (staff table), not login accounts.
-- Drop any old foreign keys from those columns to profiles.
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    join (values ('public.sales'::regclass,'cashier_id'), ('public.shifts'::regclass,'cashier_id'),
                 ('public.cash_movements'::regclass,'performed_by'), ('public.refunds'::regclass,'approved_by'),
                 ('public.audit_log'::regclass,'actor_id'), ('public.reconciliation_issues'::regclass,'resolved_by')) v(tbl, col)
      on v.tbl = c.conrelid and v.col = a.attname
    where c.contype = 'f'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Who is calling? (owner / counter device / staff PIN session)
-- -----------------------------------------------------------------------------
-- Permission level of the caller: 3 = admin, 2 = manager, 1 = cashier, 0 = none.
-- It depends ONLY on the login's profile role:
--  * Owner's email login (profile role ADMIN)    -> 3  (Back Office)
--  * Old-style MANAGER / CASHIER email profiles  -> 2 / 1
--  * Paired counter device (profile role DEVICE) -> 0, whatever staff PIN is
--    entered on it. A staff PIN never gives admin rights; counter work goes
--    through fo_sync(), which checks each action itself.
create or replace function public.app_rank() returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select case p.role when 'ADMIN' then 3 when 'MANAGER' then 2 when 'CASHIER' then 1 else 0 end
                   from public.profiles p where p.id = auth.uid()), 0)
$$;

-- Left over from the live schema (001). Kept so nothing that still refers to it
-- breaks, but now with a fixed search_path (a SECURITY DEFINER function without
-- one could be tricked into using someone else's "profiles" table).
create or replace function public.current_role_rank() returns integer
language sql stable security definer set search_path = public as $$
  select case (select p.role from public.profiles p where p.id = auth.uid())
    when 'ADMIN' then 3 when 'MANAGER' then 2 when 'CASHIER' then 1 else 0 end
$$;

-- True only for the owner's own email login.
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'ADMIN')
$$;

create or replace function public._role_rank(p_role text) returns integer
language sql immutable as $$
  select case p_role when 'ADMIN' then 3 when 'MANAGER' then 2 when 'CASHIER' then 1 else 0 end
$$;

create or replace function public._too_many_attempts(p_subject uuid, p_kind text, p_max integer, p_window interval)
returns boolean language sql stable security definer set search_path = public as $$
  select count(*) >= p_max from public.auth_attempts
  where subject = p_subject and kind = p_kind and not success and at > now() - p_window
$$;

-- Wrong-PIN lock for one counter login, getting longer the more wrong PINs:
--    5 wrong in 15 minutes -> locked for  5 minutes after the last wrong PIN
--   10 wrong in 1 hour     -> locked for 30 minutes after the last wrong PIN
--   20 wrong in 24 hours   -> locked for  4 hours   after the last wrong PIN
-- A correct PIN does NOT reset the count (otherwise someone who knows one PIN
-- could keep guessing another). Returns when the lock ends, or null if not locked.
create or replace function public._pin_locked_until(p_subject uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select case when x.until > now() then x.until end
  from (
    select greatest(
             case when count(*) >= 20 then max(at) + interval '4 hours' end,
             case when count(*) filter (where at > now() - interval '1 hour') >= 10 then max(at) + interval '30 minutes' end,
             case when count(*) filter (where at > now() - interval '15 minutes') >= 5 then max(at) + interval '5 minutes' end
           ) as until
    from public.auth_attempts
    where subject = p_subject and kind = 'PIN' and not success and at > now() - interval '24 hours'
  ) x
$$;

-- How a COUNTER sees a customer's mobile number: local format with the middle
-- hidden, e.g. +639171234567 -> '0917 ••• 4567'. Only the owner sees full numbers.
create or replace function public._mask_phone(p text) returns text
language sql immutable as $$
  select case
    when p is null then null
    when p ~ '^\+639\d{9}$' then '0' || substr(p, 4, 3) || ' ••• ' || right(p, 4)
    else '••• ' || right(p, 2)
  end
$$;

-- A customer row as a counter may see it (phone masked unless the caller is the owner).
create or replace function public._customer_for_staff(p_c public.customers, p_owner boolean) returns jsonb
language sql immutable as $$
  select case when p_c.id is null then null
    else to_jsonb(p_c) || jsonb_build_object('phone', case when p_owner then p_c.phone else public._mask_phone(p_c.phone) end,
                                             'phone_masked', not p_owner and p_c.phone is not null) end
$$;

-- Counters may look up a customer by a FULL mobile number (e.g. at the till).
-- Each such look-up is counted, max 60 per hour per counter login, so nobody can
-- guess the hidden digits of a masked number by trying numbers one by one.
-- Returns true when the look-up is allowed (and records it).
create or replace function public._phone_lookup_allowed(p_subject uuid) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if (select count(*) from public.auth_attempts
      where subject = p_subject and kind = 'PHONE_LOOKUP' and at > now() - interval '1 hour') >= 60 then
    return false;
  end if;
  insert into public.auth_attempts(subject, kind, success) values (p_subject, 'PHONE_LOOKUP', true);
  return true;
end $$;

-- Philippine mobile numbers -> +639XXXXXXXXX (returns null when not valid).
create or replace function public._norm_phone(p text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d ~ '^639\d{9}$' then return '+' || d; end if;
  if d ~ '^09\d{9}$' then return '+63' || substr(d, 2); end if;
  if d ~ '^9\d{9}$' then return '+63' || d; end if;
  return null;
end $$;

create or replace function public._clean_name(p text) returns text
language sql immutable as $$
  select nullif(left(regexp_replace(btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:]<>]', '', 'g')), '\s+', ' ', 'g'), 30), '')
$$;

-- -----------------------------------------------------------------------------
-- 5. Signup fix + profile protection
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user_signup() returns trigger
language plpgsql security definer set search_path to '' as $function$
declare
  new_business_id uuid;
  provided_business_name text;
  provided_admin_name text;
begin
  -- Customers ordering by QR and paired counter devices log in anonymously.
  -- They must NEVER get a business of their own.
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;
  provided_business_name := coalesce(nullif(new.raw_user_meta_data->>'business_name', ''), 'My Coffee Shop');
  provided_admin_name := coalesce(nullif(new.raw_user_meta_data->>'admin_name', ''), new.email);
  insert into public.businesses (name) values (provided_business_name) returning id into new_business_id;
  insert into public.stores (business_id, name) values (new_business_id, 'Main Store');
  insert into public.settings (business_id, business_name) values (new_business_id, provided_business_name);
  insert into public.profiles (id, business_id, name, role) values (new.id, new_business_id, provided_admin_name, 'ADMIN');
  insert into public.staff (business_id, profile_id, name, role) values (new_business_id, new.id, provided_admin_name, 'ADMIN');
  insert into public.dining_tables (business_id, label, kind, sort_order) values (new_business_id, 'Takeaway / Counter', 'TAKEAWAY', 0);
  return new;
end;
$function$;

-- Only the owner can change roles or move a profile to another business.
create or replace function public.protect_profile_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;     -- SQL editor / service role
  if current_setting('cccc.trusted_write', true) = 'on' then return new; end if;  -- set only inside our own functions
  if (new.role is distinct from old.role or new.business_id is distinct from old.business_id or new.id is distinct from old.id)
     and not public.is_owner() then
    raise exception 'Only the owner can change roles';
  end if;
  return new;
end $$;
drop trigger if exists protect_profile_columns on public.profiles;
create trigger protect_profile_columns before update on public.profiles
  for each row execute function public.protect_profile_columns();

-- Keep updated_at fresh on QR orders (the counter polls by updated_at).
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists qr_orders_touch on public.qr_orders;
create trigger qr_orders_touch before update on public.qr_orders for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 6. Stock on hand (sum of all inventory movements per ingredient)
-- -----------------------------------------------------------------------------
create or replace view public.v_ingredient_stock with (security_invoker = true) as
select business_id, ingredient_id,
  sum(case
        when transaction_type = 'ADJUSTMENT' then quantity
        when transaction_type in ('PURCHASE','INITIAL_STOCK','PRODUCTION','SALE_REVERSAL') then abs(quantity)
        else -abs(quantity)
      end) as stock
from public.inventory_transactions
group by business_id, ingredient_id;

-- -----------------------------------------------------------------------------
-- 7. Row Level Security
-- -----------------------------------------------------------------------------
do $$
declare
  t text; p record;
  std_tables text[] := array['categories','suppliers','ingredients','recipes','recipe_ingredients','purchases',
    'production_batches','waste','inventory_transactions','stores','dining_tables','staff','settings','devices',
    'reconciliation_issues','sales','sale_items','payments','refunds','shifts','cash_movements','audit_log',
    'customers','qr_orders','sync_operations'];
begin
  foreach t in array std_tables || array['businesses','profiles','staff_pins','staff_sessions','auth_attempts',
      'device_pairing_codes','customer_devices','qr_order_counters'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;

  foreach t in array std_tables loop
    if t = 'customers' then
      -- Customer records hold full phone numbers: only the owner's login reads them
      -- directly. Counters use search_customers() / fo_add_customer(), which mask numbers.
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_read', t);
    else
      -- Everyone who belongs to the business (owner, counter devices) can read.
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()))', t || '_read', t);
    end if;
    -- Changes through the API need admin level (the owner's email login only).
    -- Counter sales/shifts do NOT use these: they go through fo_sync() below.
    if t not in ('sync_operations') then
      execute format('create policy %I on public.%I for insert to authenticated with check (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_admin_insert', t);
      execute format('create policy %I on public.%I for update to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3) with check (business_id = (select public.current_business_id()))', t || '_admin_update', t);
      if t <> 'audit_log' then
        execute format('create policy %I on public.%I for delete to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_admin_delete', t);
      end if;
    end if;
  end loop;
end $$;

-- Customers can read their own QR orders (to see "Preparing / Ready").
create policy qr_orders_customer_read on public.qr_orders for select to authenticated
  using (auth_user_id = auth.uid());

create policy businesses_read on public.businesses for select to authenticated
  using (id = (select public.current_business_id()));
create policy businesses_owner_update on public.businesses for update to authenticated
  using (id = (select public.current_business_id()) and (select public.app_rank()) >= 3)
  with check (id = (select public.current_business_id()));

create policy profiles_read on public.profiles for select to authenticated
  using (business_id = (select public.current_business_id()));
create policy profiles_owner_insert on public.profiles for insert to authenticated
  with check (business_id = (select public.current_business_id()) and (select public.is_owner()));
create policy profiles_update on public.profiles for update to authenticated
  using (business_id = (select public.current_business_id()) and (id = auth.uid() or (select public.is_owner())))
  with check (business_id = (select public.current_business_id()));
create policy profiles_owner_delete on public.profiles for delete to authenticated
  using (business_id = (select public.current_business_id()) and (select public.is_owner()) and id <> auth.uid());
-- staff_pins, staff_sessions, auth_attempts, device_pairing_codes, customer_devices,
-- qr_order_counters: RLS on, no policies => only the functions below can touch them.

grant select on public.v_ingredient_stock to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Generic writer used by the Back Office and the counter sync
-- -----------------------------------------------------------------------------
create or replace function public._writable_tables() returns text[]
language sql immutable as $$
  select array['categories','suppliers','ingredients','recipes','recipe_ingredients','purchases','production_batches',
    'waste','inventory_transactions','settings','stores','dining_tables','staff','devices','customers','sales',
    'sale_items','payments','refunds','shifts','cash_movements','audit_log','qr_orders','businesses']
$$;

-- Insert-or-update ONE row from JSON. Only columns present in the JSON are written,
-- so missing columns keep their defaults / current values. Runs with the CALLER's
-- rights (Row Level Security applies), except when called from fo_sync.
-- p_conflict = what to do when a row with the same key already exists:
--   'update'  -> overwrite it            'nothing' -> leave it as it is
--   'error'   -> refuse (FORBIDDEN_ROW). Used for a sale's / refund's child rows,
--                so they can never overwrite a row that belongs to something else.
create or replace function public._write_row(p_table text, p_row jsonb, p_key text default 'id',
  p_conflict text default 'update', p_biz uuid default null)
returns void language plpgsql security invoker set search_path = public as $$
declare v_cols text; v_set text; v_owner uuid;
begin
  if not (p_table = any(public._writable_tables())) then raise exception 'TABLE_NOT_ALLOWED: %', p_table; end if;
  if p_conflict not in ('update', 'nothing', 'error') then raise exception 'BAD_CONFLICT_MODE'; end if;
  if p_biz is not null and p_key = 'id' and (p_row ? 'id') then
    execute format('select business_id from public.%I where id = $1', p_table) into v_owner using (p_row->>'id')::uuid;
    if v_owner is not null and v_owner <> p_biz then raise exception 'FORBIDDEN_ROW'; end if;
  end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
         string_agg(case when a.attname = p_key or a.attname in ('business_id','created_at') then null
                         else format('%1$I = excluded.%1$I', a.attname) end, ', ' order by a.attnum)
    into v_cols, v_set
  from pg_attribute a
  where a.attrelid = format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped
    and a.attgenerated = '' and p_row ? a.attname::text;
  if v_cols is null then return; end if;
  if p_conflict = 'error' then
    -- plain insert: an id that already exists anywhere is refused
    begin
      execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I, $1)',
                     p_table, v_cols)
        using p_row;
    exception when unique_violation then
      raise exception 'FORBIDDEN_ROW';
    end;
    return;
  end if;
  execute format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I, $1) on conflict (%3$I) do %4$s',
                 p_table, v_cols, p_key,
                 case when p_conflict = 'nothing' or v_set is null then 'nothing' else 'update set ' || v_set end)
    using p_row;
end $$;

-- Update ONE existing row: only the columns present in the JSON change.
create or replace function public._update_row(p_table text, p_row jsonb, p_key text default 'id', p_biz uuid default null)
returns integer language plpgsql security invoker set search_path = public as $$
declare v_set text; v_n integer;
begin
  if not (p_table = any(public._writable_tables())) then raise exception 'TABLE_NOT_ALLOWED: %', p_table; end if;
  select string_agg(format('%1$I = r.%1$I', a.attname), ', ' order by a.attnum) into v_set
  from pg_attribute a
  where a.attrelid = format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped
    and a.attgenerated = '' and p_row ? a.attname::text and a.attname not in (p_key, 'business_id', 'created_at');
  if v_set is null then return 0; end if;
  execute format('update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I, $1) r where t.%3$I = r.%3$I%4$s',
                 p_table, v_set, p_key, case when p_biz is null then '' else ' and t.business_id = $2' end)
    using p_row, p_biz;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Back Office: apply several changes at once, all-or-nothing.
-- ops = [{op:'upsert', table, row} (full row) | {op:'update', table, row} (id + changed columns)
--        | {op:'insert_ignore', table, row} | {op:'delete', table, id}
--        | {op:'delete_where', table, where:{col:value,...}}]
create or replace function public.apply_changes(p_ops jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare
  v_op jsonb; v_table text; v_n integer := 0; v_biz uuid := public.current_business_id();
  v_sql text; k text; v_key text; v_row jsonb;
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  if public.app_rank() < 3 then raise exception 'ADMIN_ONLY'; end if;
  for v_op in select value from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) loop
    v_table := v_op->>'table';
    if not (v_table = any(public._writable_tables())) then raise exception 'TABLE_NOT_ALLOWED: %', v_table; end if;
    v_key := case v_table when 'settings' then 'business_id' else 'id' end;
    v_row := coalesce(v_op->'row', '{}'::jsonb) || jsonb_build_object('business_id', v_biz);
    if v_table = 'businesses' then
      -- only the shop name can be changed here
      if v_op->>'op' = 'upsert' and coalesce(btrim(v_row->>'name'), '') <> '' then
        update public.businesses set name = left(btrim(v_row->>'name'), 80) where id = v_biz;
      end if;
      v_n := v_n + 1;
      continue;
    end if;
    case v_op->>'op'
      when 'upsert' then perform public._write_row(v_table, v_row, v_key, 'update');
      when 'update' then perform public._update_row(v_table, v_row, v_key);
      when 'insert_ignore' then perform public._write_row(v_table, v_row, v_key, 'nothing');
      when 'delete' then
        execute format('delete from public.%I where id = $1', v_table) using (v_op->>'id')::uuid;
      when 'delete_where' then
        v_sql := format('delete from public.%I where business_id = $1', v_table);
        for k in select jsonb_object_keys(coalesce(v_op->'where', '{}'::jsonb)) loop
          if not exists (select 1 from pg_attribute where attrelid = format('public.%I', v_table)::regclass
                         and attname = k and attnum > 0 and not attisdropped) then
            raise exception 'BAD_COLUMN: %', k;
          end if;
          v_sql := v_sql || format(' and %I::text = %L', k, v_op->'where'->>k);
        end loop;
        execute v_sql using v_biz;
      else raise exception 'BAD_OP: %', v_op->>'op';
    end case;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('applied', v_n);
end $$;

-- -----------------------------------------------------------------------------
-- 9. Staff PINs and sessions
-- -----------------------------------------------------------------------------
create or replace function public.staff_pin_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select sp.staff_id from public.staff_pins sp join public.staff s on s.id = sp.staff_id
  where s.business_id = public.current_business_id() and (sp.pin_hash is not null or sp.legacy_sha256 is not null)
$$;

-- PIN login. Returns {token, expires_at, staff:{id,name,role}} or {error:'...'}.
--   p_purpose 'LOGIN'    = staff member signs in on this counter (16 hours).
--   p_purpose 'OVERRIDE' = one-time manager approval for ONE refund / void /
--                          discount (needs a MANAGER or ADMIN PIN). fo_sync()
--                          accepts it for up to 24 hours, once.
--   p_min_role = lowest role allowed (e.g. 'MANAGER').
-- Too many wrong PINs: {error:'TOO_MANY_ATTEMPTS', locked_until:<time>}.
create or replace function public.staff_pin_login(p_pin text, p_purpose text default 'LOGIN', p_min_role text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_biz uuid := public.current_business_id();
  v_purpose text := upper(coalesce(nullif(btrim(p_purpose), ''), 'LOGIN'));
  v_min_role text := upper(coalesce(nullif(btrim(p_min_role), ''), 'CASHIER'));
  s record; v_id uuid; v_name text; v_role text; v_token text; v_ttl interval; v_locked timestamptz;
begin
  if v_uid is null or v_biz is null then return jsonb_build_object('error', 'NOT_A_MEMBER'); end if;
  if v_purpose not in ('LOGIN', 'OVERRIDE') then return jsonb_build_object('error', 'BAD_PURPOSE'); end if;
  -- an approval always needs at least a manager
  if v_purpose = 'OVERRIDE' and public._role_rank(v_min_role) < 2 then v_min_role := 'MANAGER'; end if;
  v_locked := public._pin_locked_until(v_uid);
  if v_locked is not null then
    return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS', 'locked_until', v_locked);
  end if;
  if p_pin is null or p_pin !~ '^\d{4,6}$' then return jsonb_build_object('error', 'WRONG_PIN'); end if;
  for s in
    select st.id, st.name, st.role, sp.pin_hash, sp.legacy_sha256
    from public.staff st join public.staff_pins sp on sp.staff_id = st.id
    where st.business_id = v_biz and st.active
  loop
    if s.pin_hash is not null and s.pin_hash = crypt(p_pin, s.pin_hash) then
      v_id := s.id; v_name := s.name; v_role := s.role; exit;
    end if;
    if s.pin_hash is null and s.legacy_sha256 is not null
       and s.legacy_sha256 = encode(digest('coffeepos:' || p_pin, 'sha256'), 'hex') then
      update public.staff_pins set pin_hash = crypt(p_pin, gen_salt('bf', 8)), legacy_sha256 = null, updated_at = now()
        where staff_id = s.id;
      v_id := s.id; v_name := s.name; v_role := s.role; exit;
    end if;
  end loop;
  insert into public.auth_attempts(subject, kind, success) values (v_uid, 'PIN', v_id is not null);
  delete from public.auth_attempts where at < now() - interval '2 days';
  if v_id is null then
    v_locked := public._pin_locked_until(v_uid);
    if v_locked is not null then
      return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS', 'locked_until', v_locked);
    end if;
    return jsonb_build_object('error', 'WRONG_PIN');
  end if;
  if public._role_rank(v_role) < public._role_rank(v_min_role) then
    return jsonb_build_object('error', 'ROLE_TOO_LOW', 'staff', jsonb_build_object('id', v_id, 'name', v_name, 'role', v_role));
  end if;
  v_token := encode(gen_random_bytes(32), 'hex');
  v_ttl := case when v_purpose = 'OVERRIDE' then interval '10 minutes' else interval '16 hours' end;
  insert into public.staff_sessions(staff_id, business_id, device_user_id, token_hash, purpose, expires_at)
    values (v_id, v_biz, v_uid, encode(digest(v_token, 'sha256'), 'hex'), v_purpose, now() + v_ttl);
  delete from public.staff_sessions where expires_at < now() - interval '2 days';
  return jsonb_build_object('token', v_token, 'expires_at', now() + v_ttl,
    'staff', jsonb_build_object('id', v_id, 'name', v_name, 'role', v_role));
end $$;

create or replace function public.staff_logout(p_token text) returns void
language sql volatile security definer set search_path = public, extensions as $$
  update public.staff_sessions set revoked_at = now()
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and device_user_id = auth.uid()
$$;

-- Admin sets / resets a staff member's PIN. Returns {ok:true} or {error:'...'}.
create or replace function public.staff_set_pin(p_staff_id uuid, p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_biz uuid := public.current_business_id(); r record;
begin
  if v_biz is null or public.app_rank() < 3 then return jsonb_build_object('error', 'ADMIN_ONLY'); end if;
  if not exists (select 1 from public.staff where id = p_staff_id and business_id = v_biz) then
    return jsonb_build_object('error', 'UNKNOWN_STAFF');
  end if;
  if p_pin is null or p_pin !~ '^\d{4,6}$' then return jsonb_build_object('error', 'PIN_FORMAT'); end if;
  for r in
    select sp.pin_hash, sp.legacy_sha256 from public.staff_pins sp join public.staff s on s.id = sp.staff_id
    where s.business_id = v_biz and s.active and s.id <> p_staff_id
  loop
    if (r.pin_hash is not null and r.pin_hash = crypt(p_pin, r.pin_hash))
       or (r.legacy_sha256 is not null and r.legacy_sha256 = encode(digest('coffeepos:' || p_pin, 'sha256'), 'hex')) then
      return jsonb_build_object('error', 'PIN_IN_USE');
    end if;
  end loop;
  insert into public.staff_pins(staff_id, pin_hash, legacy_sha256, updated_at)
    values (p_staff_id, crypt(p_pin, gen_salt('bf', 8)), null, now())
    on conflict (staff_id) do update set pin_hash = excluded.pin_hash, legacy_sha256 = null, updated_at = now();
  update public.staff_sessions set revoked_at = now() where staff_id = p_staff_id and revoked_at is null;
  return jsonb_build_object('ok', true);
end $$;

-- Used only when importing from the old offline app: keeps everyone's old PIN working.
create or replace function public.staff_import_legacy_pin(p_staff_id uuid, p_sha256 text) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if public.app_rank() < 3 then raise exception 'ADMIN_ONLY'; end if;
  if not exists (select 1 from public.staff where id = p_staff_id and business_id = public.current_business_id()) then
    raise exception 'UNKNOWN_STAFF';
  end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'BAD_HASH'; end if;
  insert into public.staff_pins(staff_id, legacy_sha256) values (p_staff_id, p_sha256)
    on conflict (staff_id) do nothing;
end $$;

-- -----------------------------------------------------------------------------
-- 10. Counter devices (pairing)
-- -----------------------------------------------------------------------------
create or replace function public.create_device_pairing_code(p_device_name text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_biz uuid := public.current_business_id();
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text; v_bytes bytea; i integer;
begin
  if v_biz is null or public.app_rank() < 3 then raise exception 'ADMIN_ONLY'; end if;
  loop
    v_bytes := gen_random_bytes(6); v_code := '';
    for i in 0..5 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.device_pairing_codes where code = v_code);
  end loop;
  delete from public.device_pairing_codes where expires_at < now() - interval '1 day';
  insert into public.device_pairing_codes(code, business_id, device_name, created_by, expires_at)
    values (v_code, v_biz, public._clean_name(p_device_name), auth.uid(), now() + interval '15 minutes');
  return jsonb_build_object('code', v_code, 'expires_at', now() + interval '15 minutes');
end $$;

create or replace function public._next_device_tag(p_biz uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ'; i integer; j integer; v_tag text;
begin
  for i in 1..length(v_letters) loop
    v_tag := substr(v_letters, i, 1);
    if not exists (select 1 from public.devices where business_id = p_biz and device_tag = v_tag) then return v_tag; end if;
  end loop;
  for i in 1..length(v_letters) loop
    for j in 1..length(v_letters) loop
      v_tag := substr(v_letters, i, 1) || substr(v_letters, j, 1);
      if not exists (select 1 from public.devices where business_id = p_biz and device_tag = v_tag) then return v_tag; end if;
    end loop;
  end loop;
  return upper(substr(md5(random()::text), 1, 3));
end $$;

-- Called on the counter tablet right after it logs in anonymously.
create or replace function public.redeem_device_pairing(p_code text, p_device_key text, p_device_name text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_pc public.device_pairing_codes%rowtype; v_role text; v_dev public.devices%rowtype;
  v_store uuid; v_name text;
begin
  if v_uid is null then return jsonb_build_object('error', 'NOT_SIGNED_IN'); end if;
  if coalesce(length(p_device_key), 0) < 16 then return jsonb_build_object('error', 'BAD_DEVICE_KEY'); end if;
  if public._too_many_attempts(v_uid, 'PAIR', 5, interval '10 minutes') then return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS'); end if;
  select * into v_pc from public.device_pairing_codes
    where code = upper(btrim(p_code)) and used_at is null and expires_at > now();
  if not found then
    insert into public.auth_attempts(subject, kind, success) values (v_uid, 'PAIR', false);
    return jsonb_build_object('error', 'BAD_CODE');
  end if;
  select role into v_role from public.profiles where id = v_uid;
  if v_role is not null and v_role <> 'DEVICE' then return jsonb_build_object('error', 'ALREADY_A_USER'); end if;
  v_name := coalesce(public._clean_name(p_device_name), v_pc.device_name, 'Counter');
  perform set_config('cccc.trusted_write', 'on', true);
  insert into public.profiles(id, business_id, name, role) values (v_uid, v_pc.business_id, v_name, 'DEVICE')
    on conflict (id) do update set business_id = excluded.business_id, name = excluded.name, role = 'DEVICE';
  select id into v_store from public.stores where business_id = v_pc.business_id order by created_at limit 1;
  select * into v_dev from public.devices where device_key = p_device_key;
  if found and v_dev.business_id <> v_pc.business_id then return jsonb_build_object('error', 'DEVICE_KEY_TAKEN'); end if;
  if found then
    update public.devices set auth_user_id = v_uid, device_name = v_name, active = true, paired_at = now(), last_seen_at = now()
      where id = v_dev.id returning * into v_dev;
  else
    insert into public.devices(business_id, store_id, device_tag, device_name, device_type, auth_user_id, device_key, active, paired_at, last_seen_at)
      values (v_pc.business_id, v_store, public._next_device_tag(v_pc.business_id), v_name, 'COUNTER', v_uid, p_device_key, true, now(), now())
      returning * into v_dev;
  end if;
  update public.device_pairing_codes set used_at = now(), used_by = v_uid where code = v_pc.code;
  insert into public.auth_attempts(subject, kind, success) values (v_uid, 'PAIR', true);
  return jsonb_build_object('device', to_jsonb(v_dev));
end $$;

-- Counters join ONLY with a pairing code (security decision 1). The old
-- "owner signs in on a counter" function is removed; drop it if an earlier
-- test copy of this script created it.
drop function if exists public.fo_register_device(text, text);

-- Remove a counter: it immediately loses all access.
create or replace function public.revoke_device(p_device_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_dev public.devices%rowtype;
begin
  if public.app_rank() < 3 then raise exception 'ADMIN_ONLY'; end if;
  select * into v_dev from public.devices where id = p_device_id and business_id = public.current_business_id();
  if not found then raise exception 'UNKNOWN_DEVICE'; end if;
  update public.devices set active = false where id = v_dev.id;
  if v_dev.auth_user_id is not null then
    delete from public.staff_sessions where device_user_id = v_dev.auth_user_id;
    delete from public.profiles where id = v_dev.auth_user_id and role = 'DEVICE';
  end if;
end $$;

-- Owner only: lift a wrong-PIN lock on a counter right away (e.g. after someone
-- kept typing wrong PINs and the counter is locked for hours).
-- Returns {ok:true, cleared:<number of wrong PINs forgotten>} or {error:'...'}.
create or replace function public.unlock_device_pin(p_device_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_dev public.devices%rowtype; v_n integer;
begin
  if public.app_rank() < 3 then return jsonb_build_object('error', 'ADMIN_ONLY'); end if;
  select * into v_dev from public.devices where id = p_device_id and business_id = public.current_business_id();
  if not found then return jsonb_build_object('error', 'UNKNOWN_DEVICE'); end if;
  delete from public.auth_attempts where subject = v_dev.auth_user_id and kind = 'PIN' and not success;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'cleared', v_n);
end $$;

-- -----------------------------------------------------------------------------
-- 11. Data loading for the apps (read-only, Row Level Security applies)
-- -----------------------------------------------------------------------------
create or replace function public._next_numbers(p_biz uuid, p_tag text) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'year', extract(year from now())::int,
    'pos', coalesce((select max(nullif(regexp_replace(split_part(transaction_number, '-', 4), '\D', '', 'g'), '')::int)
                     from public.sales where business_id = p_biz
                       and transaction_number like 'POS-' || p_tag || '-' || extract(year from now())::int || '-%'), 0),
    'shift', coalesce((select max(nullif(regexp_replace(split_part(shift_number, '-', 4), '\D', '', 'g'), '')::int)
                       from public.shifts where business_id = p_biz
                         and shift_number like 'SHIFT-' || p_tag || '-' || extract(year from now())::int || '-%'), 0))
$$;

create or replace function public.fo_bootstrap(p_device_key text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_biz uuid := public.current_business_id();
  v_dev public.devices%rowtype;
  v_shift_ids uuid[]; v_sale_ids uuid[];
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  select * into v_dev from public.devices where device_key = p_device_key and business_id = v_biz;
  select coalesce(array_agg(id), '{}') into v_shift_ids from public.shifts where business_id = v_biz and status = 'ACTIVE';
  select coalesce(array_agg(id), '{}') into v_sale_ids from public.sales
    where business_id = v_biz and (shift_id = any(v_shift_ids) or status = 'HELD');
  return jsonb_build_object(
    'server_time', now(),
    'business', (select to_jsonb(b) from public.businesses b where b.id = v_biz),
    'settings', (select to_jsonb(s) from public.settings s where s.business_id = v_biz),
    'device', case when v_dev.id is null then null else to_jsonb(v_dev) end,
    'next_numbers', case when v_dev.id is null then null else public._next_numbers(v_biz, v_dev.device_tag) end,
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name, 'role', st.role, 'active', st.active,
                         'has_pin', st.id in (select public.staff_pin_ids())) order by st.name)
                       from public.staff st where st.business_id = v_biz), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(to_jsonb(x)) from public.categories x where x.business_id = v_biz), '[]'::jsonb),
    'ingredients', coalesce((select jsonb_agg(to_jsonb(x)) from public.ingredients x where x.business_id = v_biz), '[]'::jsonb),
    'recipes', coalesce((select jsonb_agg(to_jsonb(x)) from public.recipes x where x.business_id = v_biz), '[]'::jsonb),
    'recipe_ingredients', coalesce((select jsonb_agg(to_jsonb(x)) from public.recipe_ingredients x where x.business_id = v_biz), '[]'::jsonb),
    'stock', coalesce((select jsonb_agg(jsonb_build_object('ingredient_id', v.ingredient_id, 'stock', v.stock))
                       from public.v_ingredient_stock v where v.business_id = v_biz), '[]'::jsonb),
    'shifts', coalesce((select jsonb_agg(to_jsonb(x)) from public.shifts x where x.id = any(v_shift_ids)), '[]'::jsonb),
    'sales', coalesce((select jsonb_agg(to_jsonb(x)) from public.sales x where x.id = any(v_sale_ids)), '[]'::jsonb),
    'sale_items', coalesce((select jsonb_agg(to_jsonb(x)) from public.sale_items x where x.sale_id = any(v_sale_ids)), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(x)) from public.payments x where x.sale_id = any(v_sale_ids)), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(to_jsonb(x)) from public.refunds x where x.business_id = v_biz and x.shift_id = any(v_shift_ids)), '[]'::jsonb),
    'cash_movements', coalesce((select jsonb_agg(to_jsonb(x)) from public.cash_movements x where x.business_id = v_biz and x.shift_id = any(v_shift_ids)), '[]'::jsonb),
    'tables', coalesce((select jsonb_agg(to_jsonb(x) order by x.sort_order, x.label) from public.dining_tables x where x.business_id = v_biz), '[]'::jsonb),
    'qr_orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.qr_orders x
                           where x.business_id = v_biz and (x.status in ('PENDING','PREPARING','READY')
                             or x.updated_at > now() - interval '3 hours')), '[]'::jsonb)
  );
end $$;

create or replace function public.bo_bootstrap() returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v_biz uuid := public.current_business_id();
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  return jsonb_build_object(
    'server_time', now(),
    'is_owner', public.is_owner(),
    'rank', public.app_rank(),
    'business', (select to_jsonb(b) from public.businesses b where b.id = v_biz),
    'settings', (select to_jsonb(s) from public.settings s where s.business_id = v_biz),
    'staff', coalesce((select jsonb_agg(to_jsonb(st) || jsonb_build_object('has_pin', st.id in (select public.staff_pin_ids())) order by st.name)
                       from public.staff st where st.business_id = v_biz), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(to_jsonb(x)) from public.categories x where x.business_id = v_biz), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(to_jsonb(x)) from public.suppliers x where x.business_id = v_biz), '[]'::jsonb),
    'ingredients', coalesce((select jsonb_agg(to_jsonb(x)) from public.ingredients x where x.business_id = v_biz), '[]'::jsonb),
    'recipes', coalesce((select jsonb_agg(to_jsonb(x)) from public.recipes x where x.business_id = v_biz), '[]'::jsonb),
    'recipe_ingredients', coalesce((select jsonb_agg(to_jsonb(x)) from public.recipe_ingredients x where x.business_id = v_biz), '[]'::jsonb),
    'purchases', coalesce((select jsonb_agg(to_jsonb(x)) from public.purchases x where x.business_id = v_biz), '[]'::jsonb),
    'production_batches', coalesce((select jsonb_agg(to_jsonb(x)) from public.production_batches x where x.business_id = v_biz), '[]'::jsonb),
    'waste', coalesce((select jsonb_agg(to_jsonb(x)) from public.waste x where x.business_id = v_biz), '[]'::jsonb),
    'stock', coalesce((select jsonb_agg(jsonb_build_object('ingredient_id', v.ingredient_id, 'stock', v.stock))
                       from public.v_ingredient_stock v where v.business_id = v_biz), '[]'::jsonb),
    'tables', coalesce((select jsonb_agg(to_jsonb(x) order by x.sort_order, x.label) from public.dining_tables x where x.business_id = v_biz), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(to_jsonb(x) order by x.device_tag) from public.devices x where x.business_id = v_biz), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(to_jsonb(x)) from public.stores x where x.business_id = v_biz), '[]'::jsonb),
    'open_qr_orders', (select count(*) from public.qr_orders where business_id = v_biz and status in ('PENDING','PREPARING','READY')),
    'customer_count', (select count(*) from public.customers where business_id = v_biz and merged_into is null)
  );
end $$;

-- Everything needed for sales reports / the calendar, for a time range.
create or replace function public.sales_report(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v_biz uuid := public.current_business_id(); v_sale_ids uuid[];
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  select coalesce(array_agg(id), '{}') into v_sale_ids from public.sales
    where business_id = v_biz and transaction_date >= p_from and transaction_date < p_to and status <> 'HELD';
  return jsonb_build_object(
    'sales', coalesce((select jsonb_agg(to_jsonb(x) order by x.transaction_date) from public.sales x where x.id = any(v_sale_ids)), '[]'::jsonb),
    'sale_items', coalesce((select jsonb_agg(to_jsonb(x)) from public.sale_items x where x.sale_id = any(v_sale_ids)), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(x)) from public.payments x where x.sale_id = any(v_sale_ids)), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(to_jsonb(x)) from public.refunds x
                         where x.business_id = v_biz and (x.sale_id = any(v_sale_ids) or (x.date >= p_from and x.date < p_to))), '[]'::jsonb),
    'shifts', coalesce((select jsonb_agg(to_jsonb(x) order by x.opened_at) from public.shifts x
                        where x.business_id = v_biz and x.opened_at < p_to and coalesce(x.closed_at, now()) >= p_from), '[]'::jsonb),
    'cash_movements', coalesce((select jsonb_agg(to_jsonb(x)) from public.cash_movements x
                                where x.business_id = v_biz and x.at >= p_from and x.at < p_to), '[]'::jsonb),
    'qr_orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.qr_orders x
                           where x.business_id = v_biz and x.created_at >= p_from and x.created_at < p_to), '[]'::jsonb)
  );
end $$;

-- Find customers by nickname or mobile number. Returns a list of customer rows.
--  * Owner (Back Office login): search by name or ANY part of the number;
--    full numbers are returned.
--  * Counter (DEVICE login): search by name, by the last 3-4 digits, or by the
--    FULL number (each full-number look-up is counted, max 60 per hour). Numbers
--    come back masked, e.g. phone = '0917 ••• 4567' with phone_masked = true.
--    (Searching by middle digits is not allowed: it would reveal hidden digits.)
-- VOLATILE because counting a look-up writes a row.
create or replace function public.search_customers(p_q text default '', p_limit integer default 50) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_biz uuid := public.current_business_id();
  v_role text;
  v_owner boolean := public.is_owner();
  v_q text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  v_full text := public._norm_phone(p_q);
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 500);
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  select role into v_role from public.profiles where id = auth.uid();
  if coalesce(v_role, '') not in ('DEVICE', 'ADMIN') then raise exception 'NOT_ALLOWED'; end if;
  if not v_owner and v_full is not null and not public._phone_lookup_allowed(auth.uid()) then
    raise exception 'TOO_MANY_ATTEMPTS';
  end if;
  return coalesce((
    select jsonb_agg(public._customer_for_staff(c.x, v_owner) order by (c.x).last_seen_at desc)
    from (
      select x from public.customers x
      where x.business_id = v_biz and x.merged_into is null
        and (v_q = ''
             or x.nickname ilike '%' || v_q || '%'
             or (v_full is not null and x.phone = v_full)
             -- owner: any part of the number (+63… or 09… style)
             or (v_owner and length(v_digits) >= 3
                 and (x.phone like '%' || v_digits || '%' or ('0' || substr(x.phone, 4)) like '%' || v_digits || '%'))
             -- counter: only the last 3-4 digits (already visible in the masked number)
             or (not v_owner and length(v_digits) between 3 and 4 and right(x.phone, length(v_digits)) = v_digits))
      order by x.last_seen_at desc
      limit v_lim
    ) c), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- 12. Counter sync: every counter write goes through here (works for queued offline sales)
-- -----------------------------------------------------------------------------
create or replace function public._require_staff(p_biz uuid, p_staff uuid, p_min integer) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_role text;
begin
  select role into v_role from public.staff where id = p_staff and business_id = p_biz;
  if v_role is null then raise exception 'UNKNOWN_STAFF'; end if;
  if public._role_rank(v_role) < p_min then raise exception 'ROLE_TOO_LOW'; end if;
end $$;

-- Checks the manager approval sent with a refund / void / discount and returns
-- the approving staff member. Called only from fo_sync (through _fo_apply).
--   p_approver = the staff id the counter says approved it
--                (refund.approved_by or sale.discount_approved_by)
--   p_token    = the approval token sent with the action
-- The token must be a PIN session of THAT staff member, who must be an active
-- MANAGER or ADMIN of this shop. It must have been issued to THIS counter login,
-- at most 24 hours ago (uploads can be late), and not cancelled. Two kinds:
--   * OVERRIDE token (a manager typed their PIN to approve): works ONCE. It is
--     marked used here, so it can never approve a second action.
--   * LOGIN token of the approver (a manager approving their own action while
--     signed in on this counter): not used up.
-- Errors: APPROVAL_REQUIRED (no approver or no token sent), UNKNOWN_STAFF,
--         ROLE_TOO_LOW, APPROVAL_INVALID (wrong / used / too old / cancelled /
--         from another counter / approver switched off).
create or replace function public._use_approval(p_biz uuid, p_device_user uuid, p_approver uuid,
  p_token text, p_used_for text)
returns public.staff language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_s public.staff%rowtype; v_sess public.staff_sessions%rowtype;
begin
  if p_approver is null then raise exception 'APPROVAL_REQUIRED'; end if;
  select * into v_s from public.staff where id = p_approver and business_id = p_biz;
  if not found then raise exception 'UNKNOWN_STAFF'; end if;
  if public._role_rank(v_s.role) < 2 then raise exception 'ROLE_TOO_LOW'; end if;
  if coalesce(btrim(p_token), '') = '' then raise exception 'APPROVAL_REQUIRED'; end if;
  -- "for update" makes two uploads that use the same token wait for each other,
  -- so a single-use token can't be spent twice at the same moment.
  select * into v_sess from public.staff_sessions
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    for update;
  if not found
     or v_sess.staff_id <> v_s.id
     or v_sess.business_id <> p_biz
     or v_sess.device_user_id is distinct from p_device_user
     or v_sess.revoked_at is not null
     or v_sess.created_at < now() - interval '24 hours'
     or not v_s.active
     or v_sess.purpose not in ('LOGIN', 'OVERRIDE')
     or (v_sess.purpose = 'OVERRIDE' and v_sess.used_at is not null) then
    raise exception 'APPROVAL_INVALID';
  end if;
  if v_sess.purpose = 'OVERRIDE' then
    update public.staff_sessions set used_at = now(), used_for = left(p_used_for, 80) where id = v_sess.id;
  end if;
  return v_s;
end $$;

-- A FINISHED counter sale must add up. Same maths as computeSaleTotals() in
-- cccc/shared/logic.js:
--   each item:   quantity > 0, unit_price >= 0, line_total = unit_price x quantity
--   subtotal   = sum of the items' line totals
--   discount   = none -> 0;  'percent' -> subtotal x value / 100;  'fixed' -> value;
--                never more than the subtotal (and never below 0)
--   tax >= 0 and service charge >= 0. Their RATES are not re-checked: the shop's
--                settings may have changed while the counter was offline.
--                (Tax-inclusive shops send tax 0, which is fine.)
--   grand_total = subtotal - discount + tax + service charge
-- Every comparison allows +/- 0.02 pesos for rounding (the counter rounds only the
-- grand total). Anything else -> SALE_TOTALS_MISMATCH.
create or replace function public._check_sale_totals(p_sale jsonb, p_items jsonb) returns void
language plpgsql immutable set search_path = public as $$
declare
  c_tol constant numeric := 0.02;
  v_it jsonb; v_qty numeric; v_unit numeric; v_line numeric; v_sum numeric := 0;
  v_sub numeric; v_disc numeric; v_dtype text; v_dval numeric; v_expect numeric;
  v_tax numeric; v_svc numeric; v_grand numeric; v_bad boolean := false;
begin
  begin
    for v_it in select value from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) loop
      v_qty  := (v_it->>'quantity')::numeric;
      v_unit := (v_it->>'unit_price')::numeric;
      v_line := (v_it->>'line_total')::numeric;
      if v_qty is null or v_qty <= 0 or v_unit is null or v_unit < 0 or v_line is null
         or abs(v_line - v_unit * v_qty) > c_tol then
        v_bad := true;
      end if;
      v_sum := v_sum + coalesce(v_line, 0);
    end loop;
    v_sub   := coalesce((p_sale->>'subtotal')::numeric, 0);
    v_disc  := coalesce((p_sale->>'discount_amount')::numeric, 0);
    v_dtype := lower(nullif(btrim(p_sale->>'discount_type'), ''));
    v_dval  := coalesce((p_sale->>'discount_value')::numeric, 0);
    v_tax   := coalesce((p_sale->>'tax_amount')::numeric, 0);
    v_svc   := coalesce((p_sale->>'service_charge_amount')::numeric, 0);
    v_grand := (p_sale->>'grand_total')::numeric;
    v_expect := least(case v_dtype when 'percent' then v_sub * v_dval / 100 when 'fixed' then v_dval else 0 end, v_sub);
    if abs(v_sub - v_sum) > c_tol
       or v_disc < 0 or v_disc > v_sub + c_tol or abs(v_disc - v_expect) > c_tol
       or v_tax < 0 or v_svc < 0
       or v_grand is null or abs(v_grand - (v_sub - v_disc + v_tax + v_svc)) > c_tol then
      v_bad := true;
    end if;
  exception when data_exception then
    v_bad := true;   -- e.g. a "number" that isn't a number
  end;
  if v_bad then raise exception 'SALE_TOTALS_MISMATCH'; end if;
end $$;

-- The menu price of ONE sold item: the recipe's CURRENT selling price plus the
-- price changes of the options chosen. Each chosen option is looked up on the
-- recipe's current menu (same group name + label) and the menu's price change is
-- used. An option that is no longer on the menu counts with the item's own price
-- change, but never below 0 (so a made-up "-100 pesos" option can't hide a cheap price).
create or replace function public._menu_unit_price(p_selling numeric, p_groups jsonb, p_mods jsonb) returns numeric
language sql immutable as $$
  select coalesce(p_selling, 0) + coalesce((
    select sum(coalesce(
             (select coalesce((o->>'price_delta')::numeric, 0)
                from jsonb_array_elements(case when jsonb_typeof(p_groups) = 'array' then p_groups else '[]'::jsonb end) g,
                     jsonb_array_elements(case when jsonb_typeof(g->'options') = 'array' then g->'options' else '[]'::jsonb end) o
               where g->>'name' = m->>'group' and o->>'label' = m->>'label'
               limit 1),
             greatest(coalesce((m->>'price_delta')::numeric, 0), 0)))
    from jsonb_array_elements(case when jsonb_typeof(p_mods) = 'array' then p_mods else '[]'::jsonb end) m), 0)
$$;

-- Prices below the menu are NOT refused (a counter may have sold at an old price
-- while offline); the sale is FLAGGED for the owner to review instead.
-- Returns null (all fine) or the reasons, comma separated:
--   PRICE_BELOW_MENU = an item was sold below its menu price (0.02 peso tolerance)
--   NOT_ON_MENU      = an item has no recipe at all
-- An item whose recipe belongs to ANOTHER shop is refused: UNKNOWN_RECIPE.
create or replace function public._sale_review_reason(p_biz uuid, p_items jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_it jsonb; v_rid uuid; v_r public.recipes%rowtype; v_reasons text[] := '{}';
begin
  for v_it in select value from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) loop
    v_rid := nullif(v_it->>'recipe_id', '')::uuid;
    if v_rid is null then
      if not ('NOT_ON_MENU' = any(v_reasons)) then v_reasons := v_reasons || 'NOT_ON_MENU'::text; end if;
      continue;
    end if;
    select * into v_r from public.recipes where id = v_rid and business_id = p_biz;
    if not found then raise exception 'UNKNOWN_RECIPE'; end if;
    begin
      if (v_it->>'unit_price')::numeric < public._menu_unit_price(v_r.selling_price, v_r.modifier_groups, v_it->'modifiers') - 0.02
         and not ('PRICE_BELOW_MENU' = any(v_reasons)) then
        v_reasons := v_reasons || 'PRICE_BELOW_MENU'::text;
      end if;
    exception when data_exception then
      -- a price we can't read: let the owner look at it
      if not ('PRICE_BELOW_MENU' = any(v_reasons)) then v_reasons := v_reasons || 'PRICE_BELOW_MENU'::text; end if;
    end;
  end loop;
  return nullif(array_to_string(v_reasons, ', '), '');
end $$;

-- Stock lines from a counter must use one of THIS shop's ingredients.
create or replace function public._require_ingredient(p_biz uuid, p_line jsonb) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.ingredients
                 where id = nullif(p_line->>'ingredient_id', '')::uuid and business_id = p_biz) then
    raise exception 'UNKNOWN_INGREDIENT';
  end if;
end $$;

-- Applies ONE counter action. Any error undoes everything this action did
-- (fo_sync runs each action in its own savepoint).
create or replace function public._fo_apply(p_biz uuid, p_dev public.devices, p_type text, p_d jsonb) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_sale jsonb; v_id uuid; v_old text; v_r jsonb; v_cust uuid; v_qr uuid; v_amount numeric;
  v_shift public.shifts%rowtype; v_ref jsonb; v_status text;
  v_appr public.staff; v_sale_row public.sales%rowtype; v_prev numeric; v_type text; v_new_status text;
  v_closer_name text; v_reason text;
begin
  -- fo_sync only lets a paired counter call us with its own device row
  if p_dev.auth_user_id is distinct from auth.uid() then raise exception 'DEVICE_MISMATCH'; end if;
  case p_type
  when 'shift_open' then
    perform public._require_staff(p_biz, (p_d->>'cashier_id')::uuid, 1);
    perform public._write_row('shifts', p_d || jsonb_build_object('business_id', p_biz, 'device_id', p_dev.id,
      'store_id', p_dev.store_id, 'status', 'ACTIVE'), 'id', 'nothing', p_biz);
    return 'ok';

  when 'shift_close' then
    -- data = {id, closed_by, closed_at, declared_cash, ..., approval_token (only when
    --         closing SOMEONE ELSE's shift)}
    select * into v_shift from public.shifts where id = (p_d->>'id')::uuid and business_id = p_biz for update;
    if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
    if v_shift.status = 'CLOSED' then return 'skipped'; end if;
    if nullif(p_d->>'closed_by', '')::uuid is distinct from v_shift.cashier_id then
      -- Closing another cashier's shift needs a manager approval, checked like refunds.
      v_appr := public._use_approval(p_biz, p_dev.auth_user_id, nullif(p_d->>'closed_by', '')::uuid,
                                     p_d->>'approval_token', 'shift_close:' || v_shift.id);
      v_closer_name := v_appr.name;
    else
      -- Closing your own shift: no approval needed.
      perform public._require_staff(p_biz, v_shift.cashier_id, 1);
      select name into v_closer_name from public.staff where id = v_shift.cashier_id;
    end if;
    perform public._update_row('shifts', (p_d - 'cashier_id' - 'device_id' - 'opened_at' - 'opening_cash' - 'approval_token')
      || jsonb_build_object('status', 'CLOSED', 'closed_by_name', coalesce(v_closer_name, p_d->>'closed_by_name')), 'id', p_biz);
    return 'ok';

  when 'cash_movement' then
    perform public._require_staff(p_biz, (p_d->>'performed_by')::uuid, 1);
    perform public._write_row('cash_movements', p_d || jsonb_build_object('business_id', p_biz), 'id', 'nothing', p_biz);
    return 'ok';

  when 'sale' then
    -- data = {sale:{...}, items:[...], payment:{...}, inventory:[...],
    --         discount_approval_token: '...' (when the sale has a discount)}
    v_sale := p_d->'sale';
    if jsonb_typeof(v_sale) is distinct from 'object' then raise exception 'BAD_SALE'; end if;
    v_id := (v_sale->>'id')::uuid;
    if v_id is null then raise exception 'BAD_SALE'; end if;
    v_status := v_sale->>'status';
    if v_status is null or v_status not in ('HELD','COMPLETED') then raise exception 'BAD_SALE_STATUS'; end if;
    select status into v_old from public.sales where id = v_id and business_id = p_biz for update;
    if v_old in ('COMPLETED','VOIDED','REFUNDED','PARTIALLY_REFUNDED') then return 'skipped'; end if;
    perform public._require_staff(p_biz, (v_sale->>'cashier_id')::uuid, 1);
    -- A finished sale with a discount needs a manager approval that the server checks.
    if v_status = 'COMPLETED' and coalesce((v_sale->>'discount_amount')::numeric, 0) > 0 then
      v_appr := public._use_approval(p_biz, p_dev.auth_user_id, nullif(v_sale->>'discount_approved_by', '')::uuid,
                                     p_d->>'discount_approval_token', 'discount:' || v_id);
      v_sale := v_sale || jsonb_build_object('discount_approved_by', v_appr.id, 'discount_approved_by_name', v_appr.name);
    end if;
    -- A finished sale must add up (else SALE_TOTALS_MISMATCH), and is flagged for
    -- review when sold below the menu. Only the server sets the review flag.
    if v_status = 'COMPLETED' then
      perform public._check_sale_totals(v_sale, p_d->'items');
      v_reason := public._sale_review_reason(p_biz, p_d->'items');
    end if;
    v_sale := v_sale || jsonb_build_object('needs_review', v_reason is not null, 'review_reason', v_reason);
    -- A customer link must point at one of THIS shop's customers (else it is dropped).
    v_cust := nullif(v_sale->>'customer_id', '')::uuid;
    if v_cust is not null and not exists (select 1 from public.customers where id = v_cust and business_id = p_biz) then
      v_sale := v_sale || jsonb_build_object('customer_id', null);
    end if;
    perform public._write_row('sales', v_sale || jsonb_build_object('business_id', p_biz, 'device_id', p_dev.id,
      'store_id', p_dev.store_id), 'id', 'update', p_biz);
    -- Replace THIS sale's own child rows. New child rows are only ever INSERTED:
    -- an id that already exists anywhere (another sale, a refund...) makes the
    -- whole action fail with FORBIDDEN_ROW, so nothing else can be overwritten.
    delete from public.sale_items where sale_id = v_id;
    for v_r in select value from jsonb_array_elements(coalesce(p_d->'items', '[]'::jsonb)) loop
      perform public._write_row('sale_items', v_r || jsonb_build_object('business_id', p_biz, 'sale_id', v_id), 'id', 'error', p_biz);
    end loop;
    delete from public.payments where sale_id = v_id;
    if jsonb_typeof(p_d->'payment') = 'object' then
      perform public._write_row('payments', (p_d->'payment') || jsonb_build_object('business_id', p_biz, 'sale_id', v_id), 'id', 'error', p_biz);
    end if;
    delete from public.inventory_transactions
      where business_id = p_biz and reference_id = v_id::text and transaction_type = 'SALE_USAGE';
    if v_status = 'COMPLETED' then
      for v_r in select value from jsonb_array_elements(coalesce(p_d->'inventory', '[]'::jsonb)) loop
        perform public._require_ingredient(p_biz, v_r);
        perform public._write_row('inventory_transactions', v_r || jsonb_build_object('business_id', p_biz,
          'reference_id', v_id::text, 'transaction_type', 'SALE_USAGE'), 'id', 'error', p_biz);
      end loop;
      v_qr := nullif(v_sale->>'qr_order_id', '')::uuid;
      if v_qr is not null then
        update public.qr_orders
          set sale_id = v_id, paid_at = coalesce(paid_at, now()),
              status = case when status = 'PENDING' then 'PREPARING' else status end,
              accepted_at = coalesce(accepted_at, now())
          where id = v_qr and business_id = p_biz;
      end if;
      v_cust := nullif(v_sale->>'customer_id', '')::uuid;
      if v_cust is not null then
        update public.customers
          set visit_count = visit_count + 1,
              total_spent = total_spent + coalesce((v_sale->>'grand_total')::numeric, 0),
              last_order_at = greatest(coalesce(last_order_at, '-infinity'::timestamptz), coalesce((v_sale->>'transaction_date')::timestamptz, now())),
              updated_at = now()
          where id = v_cust and business_id = p_biz;
      end if;
    end if;
    return 'ok';

  when 'held_delete' then
    v_id := (p_d->>'id')::uuid;
    if exists (select 1 from public.sales where id = v_id and business_id = p_biz and status = 'HELD') then
      delete from public.sale_items where sale_id = v_id;
      delete from public.sales where id = v_id;
      return 'ok';
    end if;
    return 'skipped';

  when 'refund' then
    -- data = {refund:{id, sale_id, type, amount, approved_by, ...}, inventory:[...],
    --         approval_token: '...'}   (sale_status is worked out here, not taken from the counter)
    v_ref := p_d->'refund';
    if jsonb_typeof(v_ref) is distinct from 'object' then raise exception 'BAD_REFUND'; end if;
    v_id := (v_ref->>'id')::uuid;
    if v_id is null then raise exception 'BAD_REFUND'; end if;
    if exists (select 1 from public.refunds where id = v_id) then return 'skipped'; end if;
    -- Lock the sale: two refunds of the same sale are then checked one after the other.
    select * into v_sale_row from public.sales where id = (v_ref->>'sale_id')::uuid and business_id = p_biz for update;
    if not found then raise exception 'SALE_NOT_FOUND'; end if;
    if v_sale_row.status = 'VOIDED' then return 'skipped'; end if;
    if v_sale_row.status not in ('COMPLETED','PARTIALLY_REFUNDED') then raise exception 'SALE_NOT_REFUNDABLE'; end if;
    v_cust := v_sale_row.customer_id;
    v_type := v_ref->>'type';
    if v_type is null or v_type not in ('VOID','FULL_REFUND','PARTIAL_REFUND') then raise exception 'BAD_REFUND_TYPE'; end if;
    -- Manager approval, checked by the server (and used up if it is a one-time token).
    v_appr := public._use_approval(p_biz, p_dev.auth_user_id, nullif(v_ref->>'approved_by', '')::uuid,
                                   p_d->>'approval_token', 'refund:' || v_id);
    -- Money cap: no more than what is left of the sale (1 centavo rounding allowed).
    v_amount := (v_ref->>'amount')::numeric;
    if v_amount is null or v_amount < 0 then raise exception 'BAD_AMOUNT'; end if;
    select coalesce(sum(amount), 0) into v_prev from public.refunds where sale_id = v_sale_row.id;
    if v_amount > coalesce(v_sale_row.grand_total, 0) - v_prev + 0.01 then raise exception 'REFUND_TOO_LARGE'; end if;
    perform public._write_row('refunds', v_ref || jsonb_build_object('business_id', p_biz, 'sale_id', v_sale_row.id,
      'amount', v_amount, 'approved_by', v_appr.id, 'approved_by_name', v_appr.name), 'id', 'error', p_biz);
    -- Stock put back: inserted only (never overwrites another row) ...
    for v_r in select value from jsonb_array_elements(coalesce(p_d->'inventory', '[]'::jsonb)) loop
      perform public._require_ingredient(p_biz, v_r);
      perform public._write_row('inventory_transactions', v_r || jsonb_build_object('business_id', p_biz,
        'reference_id', v_id::text, 'transaction_type', 'SALE_REVERSAL'), 'id', 'error', p_biz);
    end loop;
    -- ... and, per ingredient, all refunds of this sale together can't put back
    -- more than this sale took out.
    if exists (
      select 1
      from (select it.ingredient_id, sum(abs(it.quantity)) as put_back
            from public.inventory_transactions it
            join public.refunds r on it.reference_id = r.id::text
            where r.sale_id = v_sale_row.id and it.business_id = p_biz and it.transaction_type = 'SALE_REVERSAL'
            group by it.ingredient_id) b
      left join (select ingredient_id, sum(abs(quantity)) as taken
                 from public.inventory_transactions
                 where business_id = p_biz and reference_id = v_sale_row.id::text and transaction_type = 'SALE_USAGE'
                 group by ingredient_id) s on s.ingredient_id = b.ingredient_id
      where b.put_back > coalesce(s.taken, 0) + 0.001) then
      raise exception 'RETURN_TOO_LARGE';
    end if;
    -- New status of the sale, from ALL its refunds: VOID -> VOIDED; refunded in
    -- full -> REFUNDED; otherwise PARTIALLY_REFUNDED.
    v_new_status := case when v_type = 'VOID' then 'VOIDED'
                         when v_prev + v_amount >= coalesce(v_sale_row.grand_total, 0) - 0.01 then 'REFUNDED'
                         else 'PARTIALLY_REFUNDED' end;
    update public.sales set status = v_new_status, updated_at = now() where id = v_sale_row.id;
    if v_cust is not null then
      update public.customers
        set total_spent = greatest(0, total_spent - v_amount),
            visit_count = case when v_type in ('VOID','FULL_REFUND') then greatest(0, visit_count - 1) else visit_count end,
            updated_at = now()
        where id = v_cust and business_id = p_biz;
    end if;
    return 'ok';

  when 'audit' then
    perform public._write_row('audit_log', p_d || jsonb_build_object('business_id', p_biz), 'id', 'nothing', p_biz);
    return 'ok';

  when 'sold_out' then
    update public.recipes set sold_out = coalesce((p_d->>'sold_out')::boolean, false), updated_at = now()
      where id = (p_d->>'recipe_id')::uuid and business_id = p_biz;
    return 'ok';

  else
    raise exception 'UNKNOWN_OP: %', p_type;
  end case;
end $$;

-- ops = [{op_id, type, data}, ...] in the order they happened on the counter.
-- Returns one result per op: ok | duplicate | skipped | error (with message).
-- Only a PAIRED COUNTER (DEVICE login) may call this, and only with its own device key.
-- Each op is applied on its own: an op that fails leaves no trace (its approval
-- token is not used up either) and the next ops still run.
create or replace function public.fo_sync(p_device_key text, p_ops jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_biz uuid := public.current_business_id();
  v_role text; v_dev public.devices%rowtype;
  v_op jsonb; v_d jsonb; v_opid uuid; v_type text; v_status text; v_entity uuid;
  v_out jsonb := '[]'::jsonb;
begin
  if v_uid is null or v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  select role into v_role from public.profiles where id = v_uid;
  if v_role is distinct from 'DEVICE' then raise exception 'NOT_ALLOWED'; end if;
  select * into v_dev from public.devices where device_key = p_device_key and business_id = v_biz;
  if not found or not v_dev.active then raise exception 'DEVICE_NOT_REGISTERED'; end if;
  if v_dev.auth_user_id is distinct from v_uid then raise exception 'DEVICE_MISMATCH'; end if;
  update public.devices set last_seen_at = now() where id = v_dev.id;

  for v_op in select value from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) loop
    v_opid := (v_op->>'op_id')::uuid;
    v_type := v_op->>'type';
    v_d := coalesce(v_op->'data', '{}'::jsonb);
    if exists (select 1 from public.sync_operations where operation_id = v_opid) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_opid, 'status', 'duplicate'));
      continue;
    end if;
    begin
      v_status := public._fo_apply(v_biz, v_dev, v_type, v_d);
      v_entity := coalesce(nullif(v_d->>'id', ''), nullif(v_d->'sale'->>'id', ''), nullif(v_d->'refund'->>'id', ''), nullif(v_d->>'recipe_id', ''))::uuid;
      insert into public.sync_operations(operation_id, business_id, device_id, entity_type, entity_id, operation_type, processed_at, result_summary)
        values (v_opid, v_biz, v_dev.id, v_type, v_entity, v_type, now(), v_status);
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_opid, 'status', v_status));
    exception when others then
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_opid, 'status', 'error', 'message', sqlerrm));
    end;
  end loop;
  return v_out;
end $$;

-- Staff adds a walk-in customer at the counter (or finds the existing one by phone).
-- Callers: a paired counter (DEVICE) or the owner. Returns {customer:{...}} or
-- {customer:{...}, existing:true}; on a counter the phone comes back masked
-- ('0917 ••• 4567', phone_masked = true). Look-ups by number are counted
-- (max 60 per hour per counter) -> {error:'TOO_MANY_ATTEMPTS'}.
create or replace function public.fo_add_customer(p_nickname text, p_phone text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_biz uuid := public.current_business_id(); v_name text := public._clean_name(p_nickname); v_phone text;
  v_c public.customers%rowtype; v_role text; v_owner boolean := public.is_owner();
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  select role into v_role from public.profiles where id = auth.uid();
  if coalesce(v_role, '') not in ('DEVICE', 'ADMIN') then raise exception 'NOT_ALLOWED'; end if;
  if v_name is null then return jsonb_build_object('error', 'NAME_REQUIRED'); end if;
  if coalesce(btrim(p_phone), '') <> '' then
    v_phone := public._norm_phone(p_phone);
    if v_phone is null then return jsonb_build_object('error', 'BAD_PHONE'); end if;
    if not v_owner and not public._phone_lookup_allowed(auth.uid()) then
      return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS');
    end if;
    select * into v_c from public.customers where business_id = v_biz and phone = v_phone and merged_into is null;
    if found then return jsonb_build_object('customer', public._customer_for_staff(v_c, v_owner), 'existing', true); end if;
  end if;
  insert into public.customers(business_id, nickname, phone, source, consent_at)
    values (v_biz, v_name, v_phone, 'COUNTER', now()) returning * into v_c;
  return jsonb_build_object('customer', public._customer_for_staff(v_c, v_owner));
end $$;

-- QR order status changes from the counter (paired counter, or the owner).
create or replace function public.qr_update_order(p_order_id uuid, p_action text, p_staff_name text default null, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_biz uuid := public.current_business_id(); v_o public.qr_orders%rowtype; v_role text;
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  select role into v_role from public.profiles where id = auth.uid();
  if coalesce(v_role, '') not in ('DEVICE', 'ADMIN') then raise exception 'NOT_ALLOWED'; end if;
  select * into v_o from public.qr_orders where id = p_order_id and business_id = v_biz for update;
  if not found then return jsonb_build_object('error', 'NOT_FOUND'); end if;
  case upper(p_action)
    when 'ACCEPT' then
      if v_o.status <> 'PENDING' then return jsonb_build_object('error', 'BAD_STATE', 'order', to_jsonb(v_o)); end if;
      update public.qr_orders set status = 'PREPARING', accepted_at = now(), handled_by_name = coalesce(p_staff_name, handled_by_name)
        where id = p_order_id returning * into v_o;
    when 'READY' then
      if v_o.status not in ('PENDING','PREPARING') then return jsonb_build_object('error', 'BAD_STATE', 'order', to_jsonb(v_o)); end if;
      update public.qr_orders set status = 'READY', ready_at = now(), accepted_at = coalesce(accepted_at, now()),
        handled_by_name = coalesce(p_staff_name, handled_by_name) where id = p_order_id returning * into v_o;
    when 'COMPLETE' then
      if v_o.status in ('REJECTED','CANCELLED','COMPLETED') then return jsonb_build_object('error', 'BAD_STATE', 'order', to_jsonb(v_o)); end if;
      if v_o.paid_at is null then return jsonb_build_object('error', 'NOT_PAID', 'order', to_jsonb(v_o)); end if;
      update public.qr_orders set status = 'COMPLETED', completed_at = now(), handled_by_name = coalesce(p_staff_name, handled_by_name)
        where id = p_order_id returning * into v_o;
    when 'REJECT' then
      if v_o.status not in ('PENDING','PREPARING','READY') or v_o.paid_at is not null then
        return jsonb_build_object('error', 'BAD_STATE', 'order', to_jsonb(v_o));
      end if;
      update public.qr_orders set status = 'REJECTED', reject_reason = left(coalesce(p_reason, ''), 200),
        handled_by_name = coalesce(p_staff_name, handled_by_name) where id = p_order_id returning * into v_o;
    else return jsonb_build_object('error', 'BAD_ACTION');
  end case;
  return jsonb_build_object('order', to_jsonb(v_o));
end $$;

-- Owner merges two customer records (e.g. someone who changed phones).
create or replace function public.merge_customers(p_keep uuid, p_merge uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_biz uuid := public.current_business_id(); v_keep public.customers%rowtype; v_m public.customers%rowtype;
begin
  if v_biz is null or public.app_rank() < 3 then raise exception 'ADMIN_ONLY'; end if;
  if p_keep = p_merge then raise exception 'SAME_CUSTOMER'; end if;
  select * into v_keep from public.customers where id = p_keep and business_id = v_biz and merged_into is null;
  select * into v_m from public.customers where id = p_merge and business_id = v_biz and merged_into is null;
  if v_keep.id is null or v_m.id is null then raise exception 'UNKNOWN_CUSTOMER'; end if;
  update public.customer_devices set customer_id = p_keep where customer_id = p_merge;
  update public.qr_orders set customer_id = p_keep where customer_id = p_merge;
  update public.sales set customer_id = p_keep where customer_id = p_merge;
  update public.customers set merged_into = p_keep, phone = null, updated_at = now() where id = p_merge;
  update public.customers set
      visit_count = v_keep.visit_count + v_m.visit_count,
      total_spent = v_keep.total_spent + v_m.total_spent,
      stamps = v_keep.stamps + v_m.stamps,
      points = v_keep.points + v_m.points,
      phone = coalesce(v_keep.phone, v_m.phone),
      first_seen_at = least(v_keep.first_seen_at, v_m.first_seen_at),
      last_seen_at = greatest(v_keep.last_seen_at, v_m.last_seen_at),
      last_order_at = greatest(v_keep.last_order_at, v_m.last_order_at),
      updated_at = now()
    where id = p_keep returning * into v_keep;
  return to_jsonb(v_keep);
end $$;

-- -----------------------------------------------------------------------------
-- 13. QR ordering (customer side). Customers log in anonymously; every function
--     takes the table's QR token so it knows which shop/table they are at.
-- -----------------------------------------------------------------------------
create or replace function public._type_label(p_type text) returns text
language sql immutable as $$
  select case p_type when 'DRINKS' then 'Drinks' when 'SAUCES_SYRUPS' then 'Sauces / Syrups'
    when 'PASTRY' then 'Pastry' when 'FOOD' then 'Food' else coalesce(p_type, 'Drinks') end
$$;

create or replace function public._public_modifier_groups(p_groups jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', g->>'id', 'name', g->>'name',
      'required', coalesce((g->>'required')::boolean, false),
      'multi_select', coalesce((g->>'multi_select')::boolean, false),
      'options', (select coalesce(jsonb_agg(jsonb_build_object('id', o->>'id', 'label', o->>'label',
                      'price_delta', coalesce((o->>'price_delta')::numeric, 0))), '[]'::jsonb)
                  from jsonb_array_elements(case when jsonb_typeof(g->'options') = 'array' then g->'options' else '[]'::jsonb end) o))), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_groups) = 'array' then p_groups else '[]'::jsonb end) g
$$;

create or replace function public._recipe_makeable(p_recipe uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_and(coalesce(v.stock, 0) >= ri.quantity), true)
  from public.recipe_ingredients ri
  left join public.v_ingredient_stock v on v.ingredient_id = ri.ingredient_id and v.business_id = ri.business_id
  where ri.recipe_id = p_recipe and ri.quantity > 0
$$;

create or replace function public._qr_table(p_token text) returns public.dining_tables
language sql stable security definer set search_path = public as $$
  select * from public.dining_tables where qr_token = p_token and active limit 1
$$;

create or replace function public._qr_customer_json(p_c public.customers) returns jsonb
language sql immutable as $$
  select case when p_c.id is null then null else jsonb_build_object(
    'id', p_c.id, 'nickname', p_c.nickname,
    'phone_hint', case when p_c.phone is null then null else '•••• ' || right(p_c.phone, 3) end,
    'visit_count', p_c.visit_count, 'stamps', p_c.stamps, 'first_seen_at', p_c.first_seen_at) end
$$;

-- Public menu for a table QR code (no login needed).
create or replace function public.get_qr_menu(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_t public.dining_tables; v_s public.settings%rowtype; v_b public.businesses%rowtype;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  select * into v_b from public.businesses where id = v_t.business_id;
  select * into v_s from public.settings where business_id = v_t.business_id;
  return jsonb_build_object(
    'business', jsonb_build_object('name', coalesce(nullif(v_s.business_name, ''), v_b.name), 'logo_url', v_s.logo_url),
    'theme', jsonb_build_object('primary_color', v_s.primary_color, 'secondary_color', v_s.secondary_color,
      'accent_color', v_s.accent_color, 'background_color', v_s.background_color, 'card_color', v_s.card_color,
      'text_color', v_s.text_color),
    'table', jsonb_build_object('label', v_t.label, 'kind', v_t.kind),
    'ordering_enabled', coalesce(v_s.qr_ordering_enabled, true),
    'welcome_message', v_s.qr_welcome_message,
    'payment_note', v_s.qr_payment_note,
    'tax_pct', coalesce(v_s.tax_pct, 0), 'service_charge_pct', coalesce(v_s.service_charge_pct, 0),
    'tax_inclusive', coalesce(v_s.tax_inclusive, false),
    'loyalty_enabled', coalesce(v_s.loyalty_enabled, false), 'stamps_per_reward', v_s.stamps_per_reward,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name,
        'category', coalesce(nullif(btrim(r.category), ''), public._type_label(r.recipe_type)),
        'description', r.description, 'image_url', r.image_url, 'price', r.selling_price,
        'available', not coalesce(r.sold_out, false)
                     and (not coalesce(v_s.qr_hide_out_of_stock, false) or public._recipe_makeable(r.id)),
        'modifier_groups', public._public_modifier_groups(r.modifier_groups)
      ) order by r.sort_order, r.name)
      from public.recipes r
      where r.business_id = v_t.business_id and coalesce(r.active, true) and coalesce(r.pos_visible, true)
        and coalesce(r.qr_visible, true) and coalesce(r.selling_price, 0) > 0), '[]'::jsonb)
  );
end $$;

-- Who am I at this shop? Returns {customer:{...}|null}. Follows merged records.
create or replace function public.qr_session(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_t public.dining_tables; v_c public.customers%rowtype; i integer;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('customer', null); end if;
  select c.* into v_c from public.customer_devices cd join public.customers c on c.id = cd.customer_id
    where cd.auth_user_id = v_uid and cd.business_id = v_t.business_id;
  if not found then return jsonb_build_object('customer', null); end if;
  for i in 1..5 loop
    exit when v_c.merged_into is null;
    select * into v_c from public.customers where id = v_c.merged_into;
  end loop;
  update public.customer_devices set customer_id = v_c.id, last_seen_at = now()
    where auth_user_id = v_uid and business_id = v_t.business_id;
  update public.customers set last_seen_at = now() where id = v_c.id;
  return jsonb_build_object('customer', public._qr_customer_json(v_c));
end $$;

-- First visit: save nickname (+ optional phone). This NEVER links the phone to an
-- existing customer (only qr_relink does that). If the number is already
-- registered the answer is PHONE_TAKEN; because that answer reveals a number is
-- registered, it counts toward the same per-login limit as qr_relink
-- (5 per 15 minutes), after which the answer is TOO_MANY_ATTEMPTS.
create or replace function public.qr_register(p_token text, p_nickname text, p_phone text default null, p_consent boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_t public.dining_tables; v_name text := public._clean_name(p_nickname);
  v_phone text; v_c public.customers%rowtype;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('error', 'NOT_SIGNED_IN'); end if;
  if v_name is null then return jsonb_build_object('error', 'NAME_REQUIRED'); end if;
  if not coalesce(p_consent, false) then return jsonb_build_object('error', 'CONSENT_REQUIRED'); end if;
  if exists (select 1 from public.customer_devices where auth_user_id = v_uid and business_id = v_t.business_id) then
    return public.qr_session(p_token);
  end if;
  if coalesce(btrim(p_phone), '') <> '' then
    v_phone := public._norm_phone(p_phone);
    if v_phone is null then return jsonb_build_object('error', 'BAD_PHONE'); end if;
    if public._too_many_attempts(v_uid, 'RELINK', 5, interval '15 minutes') then
      return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS');
    end if;
    if exists (select 1 from public.customers where business_id = v_t.business_id and phone = v_phone and merged_into is null) then
      insert into public.auth_attempts(subject, kind, success) values (v_uid, 'RELINK', false);
      return jsonb_build_object('error', 'PHONE_TAKEN');
    end if;
  end if;
  insert into public.customers(business_id, nickname, phone, source, consent_at)
    values (v_t.business_id, v_name, v_phone, 'QR', now()) returning * into v_c;
  insert into public.customer_devices(auth_user_id, business_id, customer_id) values (v_uid, v_t.business_id, v_c.id);
  return jsonb_build_object('customer', public._qr_customer_json(v_c));
end $$;

-- "I've ordered here before" on a new phone: phone number + the same nickname.
-- The ONLY way a phone gets linked to an existing customer. Wrong answers are
-- limited to 5 per 15 minutes per login (shared with qr_register / qr_set_phone).
create or replace function public.qr_relink(p_token text, p_phone text, p_nickname text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_t public.dining_tables; v_phone text := public._norm_phone(p_phone); v_c public.customers%rowtype;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('error', 'NOT_SIGNED_IN'); end if;
  if public._too_many_attempts(v_uid, 'RELINK', 5, interval '15 minutes') then return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS'); end if;
  if v_phone is null then return jsonb_build_object('error', 'BAD_PHONE'); end if;
  select * into v_c from public.customers
    where business_id = v_t.business_id and phone = v_phone and merged_into is null
      and lower(nickname) = lower(coalesce(public._clean_name(p_nickname), ''));
  if not found then
    insert into public.auth_attempts(subject, kind, success) values (v_uid, 'RELINK', false);
    return jsonb_build_object('error', 'NO_MATCH');
  end if;
  insert into public.customer_devices(auth_user_id, business_id, customer_id) values (v_uid, v_t.business_id, v_c.id)
    on conflict (auth_user_id, business_id) do update set customer_id = excluded.customer_id, last_seen_at = now();
  update public.customers set last_seen_at = now() where id = v_c.id;
  return jsonb_build_object('customer', public._qr_customer_json(v_c), 'relinked', true);
end $$;

-- A registered customer adds / changes their number. PHONE_TAKEN reveals that a
-- number is registered, so it counts toward the same per-login limit as qr_relink.
create or replace function public.qr_set_phone(p_token text, p_phone text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_t public.dining_tables; v_phone text := public._norm_phone(p_phone); v_cid uuid; v_c public.customers%rowtype;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('error', 'NOT_SIGNED_IN'); end if;
  select customer_id into v_cid from public.customer_devices where auth_user_id = v_uid and business_id = v_t.business_id;
  if v_cid is null then return jsonb_build_object('error', 'REGISTER_FIRST'); end if;
  if v_phone is null then return jsonb_build_object('error', 'BAD_PHONE'); end if;
  if public._too_many_attempts(v_uid, 'RELINK', 5, interval '15 minutes') then
    return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS');
  end if;
  if exists (select 1 from public.customers where business_id = v_t.business_id and phone = v_phone and merged_into is null and id <> v_cid) then
    insert into public.auth_attempts(subject, kind, success) values (v_uid, 'RELINK', false);
    return jsonb_build_object('error', 'PHONE_TAKEN');
  end if;
  update public.customers set phone = v_phone, updated_at = now() where id = v_cid returning * into v_c;
  return jsonb_build_object('customer', public._qr_customer_json(v_c));
end $$;

-- "Not you?" — unlink this phone from the customer.
create or replace function public.qr_forget_device(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_t public.dining_tables;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  delete from public.customer_devices where auth_user_id = auth.uid() and business_id = v_t.business_id;
  return jsonb_build_object('ok', true);
end $$;

-- Place an order. Prices are calculated HERE from the recipes table — whatever
-- the phone sends as a price is ignored.
-- p_items = [{recipe_id, quantity, notes, modifiers:[{group_id, option_id}]}]
create or replace function public.qr_place_order(p_token text, p_items jsonb, p_note text default null, p_order_type text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_t public.dining_tables; v_s public.settings%rowtype;
  v_cid uuid; v_c public.customers%rowtype;
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
  select customer_id into v_cid from public.customer_devices where auth_user_id = v_uid and business_id = v_t.business_id;
  if v_cid is null then return jsonb_build_object('error', 'REGISTER_FIRST'); end if;
  select * into v_c from public.customers where id = v_cid;

  select count(*) into v_count from public.qr_orders
    where auth_user_id = v_uid and business_id = v_t.business_id and status in ('PENDING','PREPARING','READY') and paid_at is null;
  if v_count >= 3 then return jsonb_build_object('error', 'TOO_MANY_OPEN_ORDERS'); end if;
  select count(*) into v_count from public.qr_orders where auth_user_id = v_uid and created_at > now() - interval '1 hour';
  if v_count >= 10 then return jsonb_build_object('error', 'TOO_MANY_ORDERS'); end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('error', 'EMPTY_ORDER');
  end if;
  if jsonb_array_length(p_items) > 30 then return jsonb_build_object('error', 'ORDER_TOO_BIG'); end if;

  for v_it in select value from jsonb_array_elements(p_items) loop
    select * into v_r from public.recipes
      where id = nullif(v_it->>'recipe_id', '')::uuid and business_id = v_t.business_id
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
        'ingredient_id', nullif(v_o->>'ingredient_id', ''), 'ingredient_qty_delta', coalesce((v_o->>'ingredient_qty_delta')::numeric, 0)));
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
      customer_nickname, auth_user_id, status, items, subtotal, tax_amount, service_charge_amount, total, customer_note)
    values (v_t.business_id, 'Q-' || lpad(v_no::text, 3, '0'), v_day, v_t.id, v_t.label, v_type, v_c.id,
      v_c.nickname, v_uid, 'PENDING', v_lines, v_subtotal, round(v_tax, 2), round(v_service, 2), v_total,
      left(nullif(btrim(p_note), ''), 200))
    returning * into v_order;
  update public.customers set last_seen_at = now() where id = v_c.id;
  return jsonb_build_object('order', to_jsonb(v_order));
end $$;

create or replace function public.qr_my_orders(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_t public.dining_tables;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  return jsonb_build_object('orders', coalesce((
    select jsonb_agg(to_jsonb(o) - 'auth_user_id' order by o.created_at desc) from public.qr_orders o
    where o.auth_user_id = auth.uid() and o.business_id = v_t.business_id
      and (o.status in ('PENDING','PREPARING','READY') or o.created_at > now() - interval '12 hours')), '[]'::jsonb));
end $$;

create or replace function public.qr_cancel_order(p_token text, p_order_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_t public.dining_tables; v_o public.qr_orders%rowtype;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  update public.qr_orders set status = 'CANCELLED'
    where id = p_order_id and auth_user_id = auth.uid() and business_id = v_t.business_id and status = 'PENDING'
    returning * into v_o;
  if v_o.id is null then return jsonb_build_object('error', 'CANNOT_CANCEL'); end if;
  return jsonb_build_object('order', to_jsonb(v_o) - 'auth_user_id');
end $$;

-- -----------------------------------------------------------------------------
-- 14. Who may call what
-- -----------------------------------------------------------------------------
-- public_fns: anyone with the shop's QR code (customers, even before login).
-- member_fns: logged-in users; each function checks the caller's shop/role itself.
-- Everything else in the list below: internal only (no direct API access).
do $$
declare f record;
  public_fns text[] := array['get_qr_menu','qr_session','qr_register','qr_relink','qr_set_phone','qr_forget_device',
                             'qr_place_order','qr_my_orders','qr_cancel_order'];
  member_fns text[] := array['current_business_id','current_role_rank','app_rank','is_owner','apply_changes','staff_pin_ids','staff_pin_login',
    'staff_logout','staff_set_pin','staff_import_legacy_pin','create_device_pairing_code','redeem_device_pairing',
    'revoke_device','unlock_device_pin','fo_bootstrap','bo_bootstrap','sales_report','search_customers','fo_sync',
    'fo_add_customer','qr_update_order','merge_customers','_write_row','_update_row','_writable_tables','_role_rank','_norm_phone','_clean_name','_next_numbers'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any(public_fns || member_fns || array['_too_many_attempts','_pin_locked_until','_phone_lookup_allowed',
        '_mask_phone','_customer_for_staff','_use_approval','_require_ingredient','_check_sale_totals','_menu_unit_price',
        '_sale_review_reason','_next_device_tag','_next_numbers',
        '_require_staff','_fo_apply','_type_label','_public_modifier_groups','_recipe_makeable','_qr_table','_qr_customer_json',
        'handle_new_user_signup','protect_profile_columns','touch_updated_at'])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any(public_fns) then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif f.proname = any(member_fns) then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
-- RLS policies call these while running as the logged-in user:
grant execute on function public.current_business_id() to anon;
grant execute on function public.app_rank() to anon;
grant execute on function public.is_owner() to anon;

-- -----------------------------------------------------------------------------
-- 15. Menu photos (public bucket; each business can only upload into its own folder)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('menu-images', 'menu-images', true)
      on conflict (id) do update set public = true;
    execute 'drop policy if exists cccc_menu_images_insert on storage.objects';
    execute 'drop policy if exists cccc_menu_images_update on storage.objects';
    execute 'drop policy if exists cccc_menu_images_delete on storage.objects';
    execute $p$create policy cccc_menu_images_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'menu-images' and (storage.foldername(name))[1] = public.current_business_id()::text)$p$;
    execute $p$create policy cccc_menu_images_update on storage.objects for update to authenticated
      using (bucket_id = 'menu-images' and (storage.foldername(name))[1] = public.current_business_id()::text)$p$;
    execute $p$create policy cccc_menu_images_delete on storage.objects for delete to authenticated
      using (bucket_id = 'menu-images' and (storage.foldername(name))[1] = public.current_business_id()::text)$p$;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 16. One-time fill for your EXISTING business
-- -----------------------------------------------------------------------------
insert into public.staff (business_id, profile_id, name, role)
select p.business_id, p.id, p.name, 'ADMIN' from public.profiles p
where p.role = 'ADMIN' and not exists (select 1 from public.staff s where s.profile_id = p.id);

insert into public.dining_tables (business_id, label, kind, sort_order)
select b.id, 'Takeaway / Counter', 'TAKEAWAY', 0 from public.businesses b
where not exists (select 1 from public.dining_tables t where t.business_id = b.id);

update public.settings s set business_name = b.name
from public.businesses b where b.id = s.business_id and coalesce(s.business_name, '') = '';

commit;

-- Tell the API about the new tables/functions right away.
notify pgrst, 'reload schema';
