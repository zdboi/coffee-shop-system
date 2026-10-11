-- =====================================================================
-- 004 — Cavite City Coffee Club: Front Office, Back Office, QR ordering,
--        customer nicknames (loyalty groundwork) and security fixes.
--
-- HOW TO RUN: Supabase dashboard → SQL Editor → New query → paste this
-- whole file → Run. It is safe to run more than once. Everything runs in
-- one transaction: if anything fails, nothing is changed.
--
-- What it does, in plain words:
--   1. Fixes two security holes in the earlier setup:
--      a) every new sign-up (including QR customers) would have created a
--         brand-new business — anonymous sign-ins now create nothing;
--      b) any signed-in staff member could promote themselves to ADMIN.
--   2. Adds counter staff with PINs (checked on the server, not the device),
--      paired counter devices, QR tables, customers, and QR orders.
--   3. Rewrites the row-level security rules so that:
--      - customers (anonymous phone sessions) can read NOTHING directly and
--        can only use a few safe functions (see the menu, order, see their
--        own orders);
--      - counter devices can sell, but cannot change recipes, prices,
--        stock records, staff or settings;
--      - only Back Office admins (email login) can change those.
-- =====================================================================
begin;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Remove foreign keys that no longer fit
--    • "who did it" columns now point to public.staff (PIN users), not to
--      profiles (email logins), so cashier/approver ids can be staff ids.
--    • the two-way link recipe <-> produced ingredient is saved in two
--      steps by the app, so a hard foreign key in both directions blocks it.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.conname, t.relname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.contype = 'f' and n.nspname = 'public'
      and (
        (c.confrelid = 'public.profiles'::regclass
           and t.relname in ('sales','shifts','cash_movements','refunds','audit_log','reconciliation_issues'))
        or (t.relname = 'ingredients' and exists (
              select 1 from pg_attribute a where a.attrelid = t.oid and a.attnum = any(c.conkey) and a.attname = 'source_recipe_id'))
        or (t.relname = 'recipes' and exists (
              select 1 from pg_attribute a where a.attrelid = t.oid and a.attnum = any(c.conkey) and a.attname = 'produced_ingredient_id'))
      )
  loop
    execute format('alter table public.%I drop constraint %I', r.relname, r.conname);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. New columns on existing tables
-- ---------------------------------------------------------------------
alter table public.devices add column if not exists auth_user_id uuid;
alter table public.devices add column if not exists active boolean not null default true;
alter table public.devices add column if not exists current_staff_id uuid;
alter table public.devices add column if not exists staff_signed_in_at timestamptz;
alter table public.devices add column if not exists pin_failures integer not null default 0;
alter table public.devices add column if not exists pin_locked_until timestamptz;
alter table public.devices add column if not exists paired_at timestamptz;
create unique index if not exists devices_auth_user_id_uq on public.devices(auth_user_id) where auth_user_id is not null;

alter table public.sales add column if not exists customer_id uuid;
alter table public.sales add column if not exists order_id uuid;

alter table public.recipes add column if not exists description text;
alter table public.recipes add column if not exists image_url text;
alter table public.recipes add column if not exists qr_visible boolean not null default true;
alter table public.recipes add column if not exists sold_out boolean not null default false;
alter table public.recipes add column if not exists sort_order integer not null default 0;

alter table public.waste add column if not exists created_at timestamptz default now();

alter table public.settings add column if not exists qr_ordering_enabled boolean not null default false;
alter table public.settings add column if not exists qr_hide_out_of_stock boolean not null default false;
alter table public.settings add column if not exists qr_welcome_text text;
alter table public.settings add column if not exists qr_closed_message text default 'We''re not taking phone orders right now — please order at the counter.';
alter table public.settings add column if not exists qr_pay_note text default 'Please pay at the counter.';
alter table public.settings add column if not exists qr_max_open_orders integer not null default 3;
alter table public.settings add column if not exists timezone text not null default 'Asia/Manila';
alter table public.settings add column if not exists extra jsonb not null default '{}'::jsonb;

-- Server-side "arrived at" time. The apps use it to fetch only what is new
-- since their last refresh (a tablet's own clock can be wrong).
do $$
declare t text;
begin
  foreach t in array array['sale_items','payments','refunds','inventory_transactions','cash_movements',
                           'audit_log','purchases','production_batches','waste'] loop
    execute format('alter table public.%I add column if not exists inserted_at timestamptz not null default now()', t);
    execute format('create index if not exists %I on public.%I(business_id, inserted_at)', t || '_inserted_idx', t);
  end loop;
end $$;
create index if not exists sales_business_updated_idx on public.sales(business_id, updated_at);
create index if not exists shifts_business_updated_idx on public.shifts(business_id, updated_at);

-- Indexes for the date-window loading the apps do
create index if not exists sales_business_date_idx on public.sales(business_id, transaction_date);
create index if not exists sales_customer_idx on public.sales(customer_id) where customer_id is not null;
create index if not exists sale_items_business_created_idx on public.sale_items(business_id, created_at);
create index if not exists sale_items_sale_idx on public.sale_items(sale_id);
create index if not exists payments_business_created_idx on public.payments(business_id, created_at);
create index if not exists payments_sale_idx on public.payments(sale_id);
create index if not exists refunds_sale_idx on public.refunds(sale_id);
create index if not exists refunds_business_date_idx on public.refunds(business_id, date);
create index if not exists inv_tx_business_date_idx on public.inventory_transactions(business_id, transaction_date);
create index if not exists inv_tx_ingredient_idx on public.inventory_transactions(ingredient_id);
create index if not exists audit_log_business_at_idx on public.audit_log(business_id, at);
create index if not exists shifts_business_opened_idx on public.shifts(business_id, opened_at);
create index if not exists cash_movements_business_at_idx on public.cash_movements(business_id, at);

-- ---------------------------------------------------------------------
-- 3. New tables
-- ---------------------------------------------------------------------
-- Counter staff. They sign in at the counter with a PIN. (Back Office
-- logins with email/password stay in public.profiles; an owner has both.)
create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  role text not null default 'CASHIER' check (role in ('CASHIER','MANAGER','ADMIN')),
  active boolean not null default true,
  profile_id uuid unique,
  local_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists staff_business_idx on public.staff(business_id);

-- Secret used to scramble PINs. Nobody can read this table directly.
create table if not exists public.business_secrets (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  pin_pepper text not null default encode(extensions.gen_random_bytes(32), 'hex')
);

-- Scrambled PINs. Nobody can read this table directly.
create table if not exists public.staff_pins (
  staff_id uuid primary key references public.staff(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  pin_hmac text not null,
  pin_set_at timestamptz not null default now()
);
create index if not exists staff_pins_lookup_idx on public.staff_pins(business_id, pin_hmac);

-- One-time codes used to pair a counter tablet with the shop.
create table if not exists public.device_pairing_codes (
  code text primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  store_id uuid,
  device_name text,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_device uuid
);

-- Invite codes for adding another Back Office admin (e.g. a co-owner).
create table if not exists public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  code text not null unique,
  role text not null default 'ADMIN' check (role in ('ADMIN','MANAGER')),
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid
);

-- QR tables (one QR code each). kind TAKEAWAY = a pickup QR at the counter.
create table if not exists public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  label text not null,
  code text not null,
  kind text not null default 'TABLE' check (kind in ('TABLE','TAKEAWAY')),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (business_id, code)
);

-- Customers who ordered by QR (nickname required, phone optional).
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 40),
  phone text,
  consent_at timestamptz,
  order_count integer not null default 0,
  visit_count integer not null default 0,
  total_spent numeric not null default 0,
  first_visit_at timestamptz,
  last_visit_at timestamptz,
  last_seen_at timestamptz,
  notes text,
  merged_into uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_business_idx on public.customers(business_id);
create unique index if not exists customers_business_phone_uq
  on public.customers(business_id, phone) where phone is not null and merged_into is null;

-- Which phone session (anonymous login) belongs to which customer.
create table if not exists public.customer_devices (
  auth_user_id uuid not null,
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz,
  primary key (auth_user_id, business_id)
);
create index if not exists customer_devices_customer_idx on public.customer_devices(customer_id);

-- Limits guessing when someone re-links with a phone number.
create table if not exists public.customer_link_attempts (
  auth_user_id uuid not null,
  business_id uuid not null,
  attempts integer not null default 0,
  window_start timestamptz not null default now(),
  primary key (auth_user_id, business_id)
);

-- QR orders and their lines.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_number text not null,
  customer_id uuid references public.customers(id) on delete set null,
  customer_auth_id uuid,
  customer_name text,
  table_id uuid references public.dining_tables(id) on delete set null,
  table_label text,
  order_type text not null check (order_type in ('DINE_IN','TAKEAWAY')),
  status text not null default 'NEW' check (status in ('NEW','ACCEPTED','READY','COMPLETED','REJECTED','CANCELLED')),
  note text,
  subtotal numeric not null default 0,
  item_count integer not null default 0,
  sale_id uuid,
  status_reason text,
  handled_by_name text,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists orders_business_created_idx on public.orders(business_id, created_at);
create index if not exists orders_business_status_idx on public.orders(business_id, status);
create index if not exists orders_customer_idx on public.orders(customer_id);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  recipe_id uuid,
  name text not null,
  quantity integer not null check (quantity between 1 and 50),
  unit_price numeric not null,
  modifiers jsonb not null default '[]'::jsonb,
  line_total numeric not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists order_items_order_idx on public.order_items(order_id);
create index if not exists order_items_business_created_idx on public.order_items(business_id, created_at);

-- ---------------------------------------------------------------------
-- 4. Helper functions used by the security rules
-- ---------------------------------------------------------------------
create or replace function public.current_business_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.business_id from public.profiles p where p.id = auth.uid() and coalesce(p.active, true)),
    (select d.business_id from public.devices d where d.auth_user_id = auth.uid() and d.active)
  )
$$;

-- Rank of a Back Office (email) login. Counter devices are always 0 here:
-- what a device may do is decided by the table rules, not by who typed a PIN.
create or replace function public.current_role_rank()
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case p.role when 'ADMIN' then 3 when 'MANAGER' then 2 when 'CASHIER' then 1 else 0 end
    from public.profiles p where p.id = auth.uid() and coalesce(p.active, true)), 0)
$$;

create or replace function public.current_device_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select d.id from public.devices d where d.auth_user_id = auth.uid() and d.active
$$;

create or replace function public.pin_hmac(p_business uuid, p_pin text)
returns text language sql stable security definer set search_path = '' as $$
  select encode(extensions.hmac(coalesce(p_pin, ''), s.pin_pepper, 'sha256'), 'hex')
  from public.business_secrets s where s.business_id = p_business
$$;

create or replace function public.normalize_phone(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare d text;
begin
  d := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
  if d = '' then return null; end if;
  if left(d, 2) = '09' and length(d) = 11 then d := '63' || substr(d, 2); end if;  -- 0917… → 63917…
  if left(d, 1) = '9' and length(d) = 10 then d := '63' || d; end if;             -- 917…  → 63917…
  if length(d) < 10 or length(d) > 15 then return null; end if;
  return d;
end $$;

create or replace function public.random_code(p_len integer)
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no 0/O/1/I/L
  b bytea := extensions.gen_random_bytes(p_len);
  out text := '';
begin
  for i in 0 .. p_len - 1 loop
    out := out || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return out;
end $$;

create or replace function public.jerr(p_code text, p_message text default null)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('ok', false, 'error', p_code, 'message', p_message)
$$;

-- Current stock per ingredient for one business (same signs the app uses).
create or replace function public.stock_levels(p_business uuid, p_before date default null)
returns table(ingredient_id uuid, qty numeric) language sql stable security definer set search_path = '' as $$
  select t.ingredient_id,
         sum(case
               when t.transaction_type = 'ADJUSTMENT' then t.quantity
               when t.transaction_type in ('PURCHASE','INITIAL_STOCK','PRODUCTION','SALE_REVERSAL') then abs(t.quantity)
               else -abs(t.quantity) end)
  from public.inventory_transactions t
  where t.business_id = p_business and (p_before is null or t.transaction_date < p_before)
  group by t.ingredient_id
$$;

create or replace function public.server_time()
returns timestamptz language sql stable set search_path = '' as $$ select now() $$;

-- Used by the apps: stock carried forward from before the loaded date window.
create or replace function public.stock_balances_before(p_before date)
returns table(ingredient_id uuid, qty numeric) language sql stable security definer set search_path = '' as $$
  select s.ingredient_id, s.qty from public.stock_levels(public.current_business_id(), p_before) s
  where public.current_business_id() is not null
$$;

-- ---------------------------------------------------------------------
-- 5. Sign-up trigger (replaces the old one) and the role guard
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user_signup()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_business uuid;
  v_name text;
  v_code text;
  v_invite public.staff_invites%rowtype;
begin
  -- QR customers and counter devices sign in anonymously: never create a business for them.
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;

  v_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'admin_name'), ''), new.email, 'Owner');
  v_code := upper(regexp_replace(coalesce(new.raw_user_meta_data ->> 'invite_code', ''), '[^A-Za-z0-9]', '', 'g'));

  if v_code <> '' then
    select * into v_invite from public.staff_invites
      where code = v_code and used_at is null and expires_at > now() for update;
    if not found then
      raise exception 'This invite code is invalid or has expired.';
    end if;
    insert into public.profiles (id, business_id, name, role) values (new.id, v_invite.business_id, v_name, v_invite.role);
    insert into public.staff (business_id, name, role, profile_id) values (v_invite.business_id, v_name, v_invite.role, new.id);
    update public.staff_invites set used_at = now(), used_by = new.id where id = v_invite.id;
    return new;
  end if;

  insert into public.businesses (name)
    values (coalesce(nullif(trim(new.raw_user_meta_data ->> 'business_name'), ''), 'My Coffee Shop'))
    returning id into v_business;
  insert into public.stores (business_id, name) values (v_business, 'Main Store');
  insert into public.settings (business_id, business_name)
    values (v_business, coalesce(nullif(trim(new.raw_user_meta_data ->> 'business_name'), ''), 'My Coffee Shop'));
  insert into public.business_secrets (business_id) values (v_business) on conflict do nothing;
  insert into public.profiles (id, business_id, name, role) values (new.id, v_business, v_name, 'ADMIN');
  insert into public.staff (business_id, name, role, profile_id) values (v_business, v_name, 'ADMIN', new.id);
  return new;
end $$;

create or replace function public.guard_profile_changes()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Changes made from the SQL editor / server (no signed-in user) are allowed.
  if auth.uid() is null then return new; end if;
  if (new.role is distinct from old.role
      or new.business_id is distinct from old.business_id
      or new.id is distinct from old.id
      or new.active is distinct from old.active)
     and public.current_role_rank() < 3 then
    raise exception 'Only an admin can change roles or access.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_profile_changes on public.profiles;
create trigger guard_profile_changes before update on public.profiles
  for each row execute function public.guard_profile_changes();

-- ---------------------------------------------------------------------
-- 6. Housekeeping triggers
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['sales','shifts','orders','customers','staff','recipes','ingredients','settings'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before insert or update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- Order status timestamps
create or replace function public.orders_status_times()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'ACCEPTED' then new.accepted_at := coalesce(new.accepted_at, now()); end if;
    if new.status = 'READY' then new.ready_at := coalesce(new.ready_at, now()); end if;
    if new.status = 'COMPLETED' then new.completed_at := coalesce(new.completed_at, now()); end if;
    if new.status in ('CANCELLED','REJECTED') then new.cancelled_at := coalesce(new.cancelled_at, now()); end if;
  end if;
  return new;
end $$;
drop trigger if exists orders_status_times on public.orders;
create trigger orders_status_times before update on public.orders
  for each row execute function public.orders_status_times();

-- Loyalty groundwork: keep each customer's order count, visit days and spend up to date.
create or replace function public.refresh_customer_stats(p_customer uuid)
returns void language sql security definer set search_path = '' as $$
  update public.customers c set
    order_count = s.cnt,
    visit_count = s.days,
    total_spent = s.total,
    first_visit_at = s.first_at,
    last_visit_at = s.last_at
  from (
    select count(*) as cnt,
           count(distinct (x.transaction_date at time zone coalesce(st.timezone, 'Asia/Manila'))::date) as days,
           coalesce(sum(x.grand_total - coalesce(rf.amt, 0)), 0) as total,
           min(x.transaction_date) as first_at,
           max(x.transaction_date) as last_at
    from public.sales x
    left join public.settings st on st.business_id = x.business_id
    left join lateral (
      select sum(r.amount) as amt from public.refunds r where r.sale_id = x.id and r.type <> 'VOID'
    ) rf on true
    where x.customer_id = p_customer and x.status in ('COMPLETED', 'PARTIALLY_REFUNDED')
  ) s
  where c.id = p_customer
$$;

create or replace function public.trg_sales_customer_stats()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and new.customer_id is not null then
    perform public.refresh_customer_stats(new.customer_id);
  end if;
  if tg_op = 'DELETE' and old.customer_id is not null then
    perform public.refresh_customer_stats(old.customer_id);
  elsif tg_op = 'UPDATE' and old.customer_id is not null and old.customer_id is distinct from new.customer_id then
    perform public.refresh_customer_stats(old.customer_id);
  end if;
  return null;
end $$;
drop trigger if exists sales_customer_stats on public.sales;
create trigger sales_customer_stats after insert or update or delete on public.sales
  for each row execute function public.trg_sales_customer_stats();

-- ---------------------------------------------------------------------
-- 7. Staff PINs, device pairing, invites
-- ---------------------------------------------------------------------
create or replace function public.set_staff_pin(p_staff uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_staff public.staff%rowtype; v_hash text;
begin
  if public.current_role_rank() < 3 then return public.jerr('not_allowed', 'Only an admin can set PINs.'); end if;
  select * into v_staff from public.staff where id = p_staff and business_id = public.current_business_id();
  if not found then return public.jerr('not_found', 'Staff member not found.'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4,6}$' then return public.jerr('invalid_pin', 'PIN must be 4 to 6 digits.'); end if;
  insert into public.business_secrets (business_id) values (v_staff.business_id) on conflict do nothing;
  v_hash := public.pin_hmac(v_staff.business_id, p_pin);
  if exists (
    select 1 from public.staff_pins sp join public.staff s on s.id = sp.staff_id
    where sp.business_id = v_staff.business_id and sp.pin_hmac = v_hash and sp.staff_id <> p_staff and s.active
  ) then
    return public.jerr('pin_in_use', 'Another staff member already uses that PIN. Choose a different one.');
  end if;
  insert into public.staff_pins (staff_id, business_id, pin_hmac, pin_set_at)
    values (p_staff, v_staff.business_id, v_hash, now())
    on conflict (staff_id) do update set pin_hmac = excluded.pin_hmac, pin_set_at = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.staff_pin_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('staff_id', sp.staff_id, 'pin_set_at', sp.pin_set_at)), '[]'::jsonb)
  from public.staff_pins sp
  where sp.business_id = public.current_business_id() and public.current_role_rank() >= 3
$$;

-- Sign in at the counter (p_switch = true) or check a manager/admin PIN for
-- an override (p_switch = false). Locks the device for a while after 5 wrong PINs.
create or replace function public.staff_pin_login(p_pin text, p_min_role text default null, p_switch boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dev public.devices%rowtype;
  v_staff public.staff%rowtype;
  v_hash text;
  v_rank integer;
  v_need integer;
  v_fail integer;
begin
  select * into v_dev from public.devices where auth_user_id = auth.uid() and active for update;
  if not found then return public.jerr('device_not_paired', 'This device is not paired with the shop.'); end if;
  if v_dev.pin_locked_until is not null and v_dev.pin_locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked',
      'retry_in', ceil(extract(epoch from (v_dev.pin_locked_until - now())))::integer,
      'message', 'Too many wrong PINs. Please wait a moment and try again.');
  end if;
  v_hash := public.pin_hmac(v_dev.business_id, p_pin);
  select s.* into v_staff
  from public.staff_pins sp join public.staff s on s.id = sp.staff_id
  where sp.business_id = v_dev.business_id and sp.pin_hmac = v_hash and s.active
  limit 1;
  if not found then
    v_fail := v_dev.pin_failures + 1;
    update public.devices set
      pin_failures = v_fail,
      pin_locked_until = case when v_fail >= 5
        then now() + make_interval(secs => least(900, 30 * power(2, v_fail - 5)))
        else null end
    where id = v_dev.id;
    return public.jerr('wrong_pin', 'Incorrect PIN.');
  end if;
  update public.devices set pin_failures = 0, pin_locked_until = null, last_seen_at = now() where id = v_dev.id;
  v_rank := case v_staff.role when 'ADMIN' then 3 when 'MANAGER' then 2 else 1 end;
  v_need := case upper(coalesce(p_min_role, '')) when 'ADMIN' then 3 when 'MANAGER' then 2 else 1 end;
  if v_rank < v_need then
    return jsonb_build_object('ok', false, 'error', 'role_too_low',
      'message', 'This needs a ' || lower(p_min_role) || ' PIN.');
  end if;
  if p_switch then
    update public.devices set current_staff_id = v_staff.id, staff_signed_in_at = now() where id = v_dev.id;
  end if;
  return jsonb_build_object('ok', true, 'staff',
    jsonb_build_object('id', v_staff.id, 'name', v_staff.name, 'role', v_staff.role));
end $$;

create or replace function public.staff_sign_out()
returns jsonb language sql security definer set search_path = '' as $$
  update public.devices set current_staff_id = null where auth_user_id = auth.uid();
  select jsonb_build_object('ok', true);
$$;

create or replace function public.device_info()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dev public.devices%rowtype; v_name text;
begin
  select * into v_dev from public.devices where auth_user_id = auth.uid() and active;
  if not found then return jsonb_build_object('ok', true, 'paired', false); end if;
  update public.devices set last_seen_at = now() where id = v_dev.id;
  select name into v_name from public.businesses where id = v_dev.business_id;
  return jsonb_build_object('ok', true, 'paired', true, 'device', jsonb_build_object(
    'id', v_dev.id, 'business_id', v_dev.business_id, 'store_id', v_dev.store_id,
    'device_tag', v_dev.device_tag, 'device_name', v_dev.device_name, 'business_name', v_name));
end $$;

create or replace function public.create_pairing_code(p_device_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text; v_business uuid; v_store uuid; v_expires timestamptz := now() + interval '15 minutes';
begin
  if public.current_role_rank() < 3 then return public.jerr('not_allowed', 'Only an admin can pair devices.'); end if;
  v_business := public.current_business_id();
  select id into v_store from public.stores where business_id = v_business order by created_at limit 1;
  loop
    v_code := public.random_code(8);
    exit when not exists (select 1 from public.device_pairing_codes where code = v_code);
  end loop;
  insert into public.device_pairing_codes (code, business_id, store_id, device_name, created_by, expires_at)
    values (v_code, v_business, v_store, nullif(trim(p_device_name), ''), auth.uid(), v_expires);
  return jsonb_build_object('ok', true, 'code', v_code, 'expires_at', v_expires);
end $$;

-- Called by a counter tablet after it signs in anonymously.
create or replace function public.pair_device(p_code text, p_device_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_pc public.device_pairing_codes%rowtype;
  v_anon boolean;
  v_tag text;
  v_n integer;
  v_dev_id uuid := gen_random_uuid();
  v_name text;
  v_bname text;
begin
  if auth.uid() is null then return public.jerr('not_signed_in', 'Not signed in.'); end if;
  v_anon := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  if not v_anon then
    select coalesce(is_anonymous, false) into v_anon from auth.users where id = auth.uid();
  end if;
  if not coalesce(v_anon, false) then
    return public.jerr('not_a_device', 'Pair from the Front Office page, not with an email login.');
  end if;
  select * into v_pc from public.device_pairing_codes
    where code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')) for update;
  if not found or v_pc.used_at is not null or v_pc.expires_at < now() then
    return public.jerr('invalid_code', 'That pairing code is wrong or has expired. Make a new one in the Back Office.');
  end if;
  update public.devices set active = false, auth_user_id = null where auth_user_id = auth.uid();
  select count(*) into v_n from public.devices where business_id = v_pc.business_id;
  loop
    v_tag := case when v_n < 26 then chr(65 + v_n) else 'T' || v_n::text end;
    exit when not exists (select 1 from public.devices where business_id = v_pc.business_id and device_tag = v_tag);
    v_n := v_n + 1;
  end loop;
  v_name := coalesce(nullif(trim(p_device_name), ''), v_pc.device_name, 'Counter ' || v_tag);
  insert into public.devices (id, business_id, store_id, device_tag, device_name, device_type, auth_user_id, active, paired_at, last_seen_at)
    values (v_dev_id, v_pc.business_id, v_pc.store_id, v_tag, v_name, 'FRONT_OFFICE', auth.uid(), true, now(), now());
  update public.device_pairing_codes set used_at = now(), used_by_device = v_dev_id where code = v_pc.code;
  insert into public.business_secrets (business_id) values (v_pc.business_id) on conflict do nothing;
  select name into v_bname from public.businesses where id = v_pc.business_id;
  return jsonb_build_object('ok', true, 'device', jsonb_build_object(
    'id', v_dev_id, 'business_id', v_pc.business_id, 'store_id', v_pc.store_id,
    'device_tag', v_tag, 'device_name', v_name, 'business_name', v_bname));
end $$;

-- Unpair this tablet (needs an admin PIN typed at the counter).
create or replace function public.unpair_this_device(p_admin_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_check jsonb;
begin
  v_check := public.staff_pin_login(p_admin_pin, 'ADMIN', false);
  if not coalesce((v_check ->> 'ok')::boolean, false) then return v_check; end if;
  update public.devices set active = false, auth_user_id = null, current_staff_id = null where auth_user_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.create_staff_invite(p_role text default 'ADMIN')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text; v_expires timestamptz := now() + interval '7 days';
begin
  if public.current_role_rank() < 3 then return public.jerr('not_allowed', 'Only an admin can invite.'); end if;
  if coalesce(p_role, '') not in ('ADMIN', 'MANAGER') then return public.jerr('invalid_role', 'Role must be ADMIN or MANAGER.'); end if;
  loop
    v_code := public.random_code(10);
    exit when not exists (select 1 from public.staff_invites where code = v_code);
  end loop;
  insert into public.staff_invites (business_id, code, role, created_by, expires_at)
    values (public.current_business_id(), v_code, p_role, auth.uid(), v_expires);
  return jsonb_build_object('ok', true, 'code', v_code, 'expires_at', v_expires);
end $$;

create or replace function public.check_invite(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('ok', true, 'valid', true, 'role', i.role, 'business_name', b.name)
     from public.staff_invites i join public.businesses b on b.id = i.business_id
     where i.code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
       and i.used_at is null and i.expires_at > now()),
    jsonb_build_object('ok', true, 'valid', false))
$$;

-- ---------------------------------------------------------------------
-- 8. Customer (QR) functions. Customers never touch tables directly.
-- ---------------------------------------------------------------------
create or replace function public.customer_json(c public.customers)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'nickname', c.nickname,
    'has_phone', c.phone is not null,
    'phone_hint', case when c.phone is null then null else '•••• ' || right(c.phone, 4) end,
    'order_count', c.order_count, 'visit_count', c.visit_count,
    'member_since', c.created_at)
$$;

create or replace function public.my_customer(p_business uuid)
returns public.customers language sql stable security definer set search_path = '' as $$
  select c.* from public.customer_devices cd
  join public.customers c on c.id = cd.customer_id
  where cd.auth_user_id = auth.uid() and cd.business_id = p_business and c.merged_into is null
  limit 1
$$;

-- Public menu for the QR page (works before sign-in).
create or replace function public.public_menu(p_business uuid, p_table_code text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.settings%rowtype;
  v_t public.dining_tables%rowtype;
  v_table jsonb := null;
  v_table_error text := null;
  v_items jsonb;
begin
  select * into v_s from public.settings where business_id = p_business;
  if not found then return public.jerr('unknown_shop', 'This shop could not be found.'); end if;

  if nullif(trim(coalesce(p_table_code, '')), '') is not null then
    select * into v_t from public.dining_tables
      where business_id = p_business and code = upper(trim(p_table_code)) and active;
    if found then
      v_table := jsonb_build_object('id', v_t.id, 'label', v_t.label, 'kind', v_t.kind, 'code', v_t.code);
    else
      v_table_error := 'unknown_table';
    end if;
  end if;

  with stock as (
    select * from public.stock_levels(p_business) where v_s.qr_hide_out_of_stock
  ), makeable as (
    select ri.recipe_id, min(floor(coalesce(s.qty, 0) / ri.quantity)) as n
    from public.recipe_ingredients ri left join stock s on s.ingredient_id = ri.ingredient_id
    where ri.business_id = p_business and ri.quantity > 0 and v_s.qr_hide_out_of_stock
    group by ri.recipe_id
  )
  select coalesce(jsonb_agg(item order by sort_order, category, name), '[]'::jsonb) into v_items
  from (
    select r.sort_order, r.name,
      coalesce(nullif(trim(r.category), ''),
        case r.recipe_type when 'DRINKS' then 'Drinks' when 'SAUCES_SYRUPS' then 'Sauces / Syrups'
          when 'PASTRY' then 'Pastry' when 'FOOD' then 'Food' else coalesce(r.recipe_type, 'Other') end) as category,
      jsonb_build_object(
        'id', r.id, 'name', r.name,
        'category', coalesce(nullif(trim(r.category), ''),
          case r.recipe_type when 'DRINKS' then 'Drinks' when 'SAUCES_SYRUPS' then 'Sauces / Syrups'
            when 'PASTRY' then 'Pastry' when 'FOOD' then 'Food' else coalesce(r.recipe_type, 'Other') end),
        'price', r.selling_price,
        'description', r.description,
        'image_url', r.image_url,
        'available', (not r.sold_out) and (not v_s.qr_hide_out_of_stock or coalesce(m.n, 1) >= 1),
        'modifier_groups', case when jsonb_typeof(r.modifier_groups) = 'array' then (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', g ->> 'id', 'name', g ->> 'name',
            'required', coalesce(g ->> 'required', 'false') = 'true',
            'multiSelect', coalesce(g ->> 'multiSelect', 'false') = 'true',
            'options', case when jsonb_typeof(g -> 'options') = 'array' then (
              select coalesce(jsonb_agg(jsonb_build_object(
                'id', o ->> 'id', 'label', o ->> 'label',
                'priceDelta', case when (o ->> 'priceDelta') ~ '^-?[0-9]+(\.[0-9]+)?$' then (o ->> 'priceDelta')::numeric else 0 end)), '[]'::jsonb)
              from jsonb_array_elements(g -> 'options') o) else '[]'::jsonb end)), '[]'::jsonb)
          from jsonb_array_elements(r.modifier_groups) g) else '[]'::jsonb end
      ) as item
    from public.recipes r
    left join makeable m on m.recipe_id = r.id
    where r.business_id = p_business
      and coalesce(r.active, true) and coalesce(r.pos_visible, true) and r.qr_visible
      and coalesce(r.selling_price, 0) > 0
  ) x;

  return jsonb_build_object(
    'ok', true,
    'shop', jsonb_build_object(
      'name', coalesce(nullif(v_s.business_name, ''), (select name from public.businesses where id = p_business)),
      'logo', v_s.logo_url,
      'colors', jsonb_build_object('primary', v_s.primary_color, 'secondary', v_s.secondary_color, 'accent', v_s.accent_color,
                                   'background', v_s.background_color, 'card', v_s.card_color, 'text', v_s.text_color),
      'welcome', v_s.qr_welcome_text,
      'ordering_open', v_s.qr_ordering_enabled,
      'closed_message', v_s.qr_closed_message,
      'pay_note', v_s.qr_pay_note,
      'tax_pct', coalesce(v_s.tax_pct, 0), 'service_charge_pct', coalesce(v_s.service_charge_pct, 0),
      'tax_inclusive', coalesce(v_s.tax_inclusive, false)),
    'table', v_table,
    'table_error', v_table_error,
    'items', v_items);
end $$;

create or replace function public.customer_me(p_business uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c public.customers;
begin
  if auth.uid() is null then return jsonb_build_object('ok', true, 'customer', null); end if;
  v_c := public.my_customer(p_business);
  if v_c.id is null then return jsonb_build_object('ok', true, 'customer', null); end if;
  update public.customers set last_seen_at = now() where id = v_c.id;
  update public.customer_devices set last_seen_at = now() where auth_user_id = auth.uid() and business_id = p_business;
  return jsonb_build_object('ok', true, 'customer', public.customer_json(v_c));
end $$;

create or replace function public.customer_register(p_business uuid, p_nickname text, p_phone text default null, p_consent boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c public.customers;
  v_nick text := left(regexp_replace(trim(coalesce(p_nickname, '')), '[[:cntrl:]]', '', 'g'), 30);
  v_phone text;
begin
  if auth.uid() is null then return public.jerr('not_signed_in', 'Please reload the page.'); end if;
  if not exists (select 1 from public.businesses where id = p_business) then return public.jerr('unknown_shop', 'Shop not found.'); end if;
  if not coalesce(p_consent, false) then return public.jerr('consent_required', 'Please agree to continue.'); end if;
  if v_nick = '' then return public.jerr('nickname_required', 'Please enter a name or nickname.'); end if;
  v_c := public.my_customer(p_business);
  if v_c.id is not null then
    return jsonb_build_object('ok', true, 'customer', public.customer_json(v_c));
  end if;
  if nullif(trim(coalesce(p_phone, '')), '') is not null then
    v_phone := public.normalize_phone(p_phone);
    if v_phone is null then return public.jerr('invalid_phone', 'Please check the mobile number.'); end if;
    if exists (select 1 from public.customers where business_id = p_business and phone = v_phone and merged_into is null) then
      return public.jerr('phone_exists', 'That number already has an account. Tap "I''ve been here before".');
    end if;
  end if;
  insert into public.customers (business_id, nickname, phone, consent_at, last_seen_at)
    values (p_business, v_nick, v_phone, now(), now()) returning * into v_c;
  insert into public.customer_devices (auth_user_id, business_id, customer_id, last_seen_at)
    values (auth.uid(), p_business, v_c.id, now())
    on conflict (auth_user_id, business_id) do update set customer_id = excluded.customer_id, linked_at = now();
  return jsonb_build_object('ok', true, 'customer', public.customer_json(v_c));
end $$;

-- "I've been here before": re-link a new phone/browser using nickname + mobile number.
create or replace function public.customer_link_phone(p_business uuid, p_nickname text, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_att public.customer_link_attempts%rowtype;
  v_c public.customers;
  v_phone text := public.normalize_phone(p_phone);
begin
  if auth.uid() is null then return public.jerr('not_signed_in', 'Please reload the page.'); end if;
  insert into public.customer_link_attempts (auth_user_id, business_id) values (auth.uid(), p_business)
    on conflict (auth_user_id, business_id) do nothing;
  select * into v_att from public.customer_link_attempts
    where auth_user_id = auth.uid() and business_id = p_business for update;
  if v_att.window_start < now() - interval '1 hour' then
    update public.customer_link_attempts set attempts = 0, window_start = now()
      where auth_user_id = auth.uid() and business_id = p_business;
    v_att.attempts := 0;
  end if;
  if v_att.attempts >= 5 then
    return public.jerr('too_many_attempts', 'Too many tries. Please ask the staff at the counter for help.');
  end if;
  update public.customer_link_attempts set attempts = attempts + 1
    where auth_user_id = auth.uid() and business_id = p_business;
  if v_phone is null then return public.jerr('invalid_phone', 'Please check the mobile number.'); end if;
  select * into v_c from public.customers
    where business_id = p_business and phone = v_phone and merged_into is null
      and lower(trim(nickname)) = lower(trim(coalesce(p_nickname, '')))
    limit 1;
  if v_c.id is null then
    return public.jerr('no_match', 'We couldn''t find that name and number together. Check both, or ask the staff.');
  end if;
  insert into public.customer_devices (auth_user_id, business_id, customer_id, last_seen_at)
    values (auth.uid(), p_business, v_c.id, now())
    on conflict (auth_user_id, business_id) do update set customer_id = excluded.customer_id, linked_at = now();
  update public.customer_link_attempts set attempts = 0 where auth_user_id = auth.uid() and business_id = p_business;
  update public.customers set last_seen_at = now() where id = v_c.id;
  return jsonb_build_object('ok', true, 'customer', public.customer_json(v_c));
end $$;

create or replace function public.customer_update_me(p_business uuid, p_nickname text default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_c public.customers;
  v_nick text := left(regexp_replace(trim(coalesce(p_nickname, '')), '[[:cntrl:]]', '', 'g'), 30);
  v_phone text;
begin
  v_c := public.my_customer(p_business);
  if v_c.id is null then return public.jerr('not_registered', 'Please enter your nickname first.'); end if;
  if nullif(trim(coalesce(p_phone, '')), '') is not null then
    v_phone := public.normalize_phone(p_phone);
    if v_phone is null then return public.jerr('invalid_phone', 'Please check the mobile number.'); end if;
    if exists (select 1 from public.customers where business_id = p_business and phone = v_phone and id <> v_c.id and merged_into is null) then
      return public.jerr('phone_exists', 'That number is already used by another account. Ask the staff to merge them.');
    end if;
  end if;
  update public.customers set
    nickname = case when v_nick <> '' then v_nick else nickname end,
    phone = coalesce(v_phone, phone)
  where id = v_c.id returning * into v_c;
  return jsonb_build_object('ok', true, 'customer', public.customer_json(v_c));
end $$;

create or replace function public.customer_forget_device(p_business uuid)
returns jsonb language sql security definer set search_path = '' as $$
  delete from public.customer_devices where auth_user_id = auth.uid() and business_id = p_business;
  select jsonb_build_object('ok', true);
$$;

-- Place a QR order. Prices are always worked out here from the menu,
-- never taken from the phone.
create or replace function public.place_order(p_business uuid, p_table_code text, p_order_type text, p_items jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_s public.settings%rowtype;
  v_t public.dining_tables%rowtype;
  v_c public.customers;
  v_item jsonb;
  v_r public.recipes%rowtype;
  v_qty integer;
  v_unit numeric;
  v_mods jsonb;
  v_groups jsonb;
  v_g jsonb;
  v_o jsonb;
  v_sel jsonb;
  v_picks integer;
  v_lines jsonb := '[]'::jsonb;
  v_subtotal numeric := 0;
  v_count integer := 0;
  v_open integer;
  v_num integer;
  v_type text;
  v_order_id uuid := gen_random_uuid();
  v_number text;
  v_uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_makeable numeric;
begin
  if auth.uid() is null then return public.jerr('not_signed_in', 'Please reload the page.'); end if;
  select * into v_s from public.settings where business_id = p_business;
  if not found then return public.jerr('unknown_shop', 'Shop not found.'); end if;
  if not v_s.qr_ordering_enabled then return public.jerr('ordering_closed', v_s.qr_closed_message); end if;

  v_c := public.my_customer(p_business);
  if v_c.id is null then return public.jerr('not_registered', 'Please enter your nickname first.'); end if;

  select * into v_t from public.dining_tables
    where business_id = p_business and code = upper(trim(coalesce(p_table_code, ''))) and active;
  if not found then return public.jerr('unknown_table', 'Please scan the QR code on your table again.'); end if;

  v_type := case when v_t.kind = 'TAKEAWAY' then 'TAKEAWAY'
                 when upper(coalesce(p_order_type, '')) = 'TAKEAWAY' then 'TAKEAWAY'
                 else 'DINE_IN' end;

  select count(*) into v_open from public.orders
    where customer_id = v_c.id and status in ('NEW', 'ACCEPTED', 'READY');
  if v_open >= greatest(1, v_s.qr_max_open_orders) then
    return public.jerr('too_many_open_orders', 'You already have orders in progress. Please wait for them first.');
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    return public.jerr('empty_order', 'Your order is empty.');
  end if;
  if jsonb_array_length(p_items) > 30 then return public.jerr('too_many_items', 'That''s a lot! Please order at the counter.'); end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if coalesce(v_item ->> 'recipe_id', '') !~ v_uuid_re then return public.jerr('invalid_item', 'An item in your order is no longer available.'); end if;
    select * into v_r from public.recipes
      where id = (v_item ->> 'recipe_id')::uuid and business_id = p_business
        and coalesce(active, true) and coalesce(pos_visible, true) and qr_visible and coalesce(selling_price, 0) > 0;
    if not found then return public.jerr('invalid_item', 'An item in your order is no longer available.'); end if;
    if v_r.sold_out then return public.jerr('sold_out', v_r.name || ' is sold out.'); end if;
    if v_s.qr_hide_out_of_stock then
      select min(floor(coalesce(s.qty, 0) / ri.quantity)) into v_makeable
      from public.recipe_ingredients ri
      left join public.stock_levels(p_business) s on s.ingredient_id = ri.ingredient_id
      where ri.recipe_id = v_r.id and ri.quantity > 0;
      if v_makeable is not null and v_makeable < 1 then return public.jerr('sold_out', v_r.name || ' is sold out.'); end if;
    end if;
    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,2}$' then return public.jerr('invalid_quantity', 'Please check the quantities.'); end if;
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty < 1 or v_qty > 20 then return public.jerr('invalid_quantity', 'Please check the quantities.'); end if;

    v_groups := case when jsonb_typeof(v_r.modifier_groups) = 'array' then v_r.modifier_groups else '[]'::jsonb end;
    v_unit := coalesce(v_r.selling_price, 0);
    v_mods := '[]'::jsonb;
    -- every selected option must belong to one of this item's groups
    for v_sel in select * from jsonb_array_elements(case when jsonb_typeof(v_item -> 'options') = 'array' then v_item -> 'options' else '[]'::jsonb end) loop
      if not exists (
        select 1 from jsonb_array_elements(v_groups) g, jsonb_array_elements(case when jsonb_typeof(g -> 'options') = 'array' then g -> 'options' else '[]'::jsonb end) o
        where g ->> 'id' = v_sel ->> 'group_id' and o ->> 'id' = v_sel ->> 'option_id'
      ) then
        return public.jerr('invalid_option', 'An option for ' || v_r.name || ' is no longer available.');
      end if;
    end loop;
    for v_g in select * from jsonb_array_elements(v_groups) loop
      v_picks := 0;
      for v_o in select * from jsonb_array_elements(case when jsonb_typeof(v_g -> 'options') = 'array' then v_g -> 'options' else '[]'::jsonb end) loop
        if exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_item -> 'options') = 'array' then v_item -> 'options' else '[]'::jsonb end) s
                   where s ->> 'group_id' = v_g ->> 'id' and s ->> 'option_id' = v_o ->> 'id') then
          v_picks := v_picks + 1;
          v_unit := v_unit + case when (v_o ->> 'priceDelta') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_o ->> 'priceDelta')::numeric else 0 end;
          v_mods := v_mods || jsonb_build_array(jsonb_build_object(
            'group', v_g ->> 'name', 'label', v_o ->> 'label',
            'priceDelta', case when (v_o ->> 'priceDelta') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_o ->> 'priceDelta')::numeric else 0 end,
            'ingredientId', nullif(v_o ->> 'ingredientId', ''),
            'ingredientQtyDelta', case when (v_o ->> 'ingredientQtyDelta') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_o ->> 'ingredientQtyDelta')::numeric else 0 end));
        end if;
      end loop;
      if v_picks = 0 and coalesce(v_g ->> 'required', 'false') = 'true' then
        return public.jerr('missing_option', 'Please choose ' || coalesce(v_g ->> 'name', 'an option') || ' for ' || v_r.name || '.');
      end if;
      if v_picks > 1 and coalesce(v_g ->> 'multiSelect', 'false') <> 'true' then
        return public.jerr('invalid_option', 'Please choose only one ' || coalesce(v_g ->> 'name', 'option') || ' for ' || v_r.name || '.');
      end if;
    end loop;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'recipe_id', v_r.id, 'name', v_r.name, 'quantity', v_qty, 'unit_price', v_unit,
      'modifiers', v_mods, 'line_total', v_unit * v_qty,
      'note', nullif(left(trim(coalesce(v_item ->> 'note', '')), 140), '')));
    v_subtotal := v_subtotal + v_unit * v_qty;
    v_count := v_count + v_qty;
  end loop;

  perform pg_advisory_xact_lock(hashtext('cccc-order-number-' || p_business::text));
  select count(*) + 1 into v_num from public.orders
    where business_id = p_business
      and (created_at at time zone v_s.timezone)::date = (now() at time zone v_s.timezone)::date;
  v_number := 'Q' || lpad(v_num::text, 3, '0');

  insert into public.orders (id, business_id, order_number, customer_id, customer_auth_id, customer_name,
                             table_id, table_label, order_type, status, note, subtotal, item_count)
    values (v_order_id, p_business, v_number, v_c.id, auth.uid(), v_c.nickname,
            v_t.id, v_t.label, v_type, 'NEW', nullif(left(trim(coalesce(p_note, '')), 300), ''), v_subtotal, v_count);
  insert into public.order_items (business_id, order_id, recipe_id, name, quantity, unit_price, modifiers, line_total, note)
    select p_business, v_order_id, (l ->> 'recipe_id')::uuid, l ->> 'name', (l ->> 'quantity')::integer,
           (l ->> 'unit_price')::numeric, l -> 'modifiers', (l ->> 'line_total')::numeric, l ->> 'note'
    from jsonb_array_elements(v_lines) l;
  update public.customers set last_seen_at = now() where id = v_c.id;

  return jsonb_build_object('ok', true, 'order', jsonb_build_object(
    'id', v_order_id, 'order_number', v_number, 'status', 'NEW', 'subtotal', v_subtotal,
    'order_type', v_type, 'table_label', v_t.label));
end $$;

create or replace function public.my_orders(p_business uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_c public.customers;
begin
  v_c := public.my_customer(p_business);
  if v_c.id is null then return jsonb_build_object('ok', true, 'orders', '[]'::jsonb); end if;
  return jsonb_build_object('ok', true, 'orders', coalesce((
    select jsonb_agg(o order by (o ->> 'created_at') desc) from (
      select jsonb_build_object(
        'id', x.id, 'order_number', x.order_number, 'status', x.status, 'status_reason', x.status_reason,
        'order_type', x.order_type, 'table_label', x.table_label, 'subtotal', x.subtotal,
        'created_at', x.created_at, 'accepted_at', x.accepted_at, 'ready_at', x.ready_at, 'completed_at', x.completed_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity, 'line_total', i.line_total,
                   'modifiers', i.modifiers, 'note', i.note) order by i.created_at, i.name)
                 from public.order_items i where i.order_id = x.id), '[]'::jsonb)) as o
      from public.orders x
      where x.customer_id = v_c.id
        and (x.created_at > now() - interval '24 hours' or x.status in ('NEW', 'ACCEPTED', 'READY'))
      order by x.created_at desc
      limit 10
    ) q), '[]'::jsonb));
end $$;

create or replace function public.cancel_my_order(p_business uuid, p_order uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c public.customers; v_n integer;
begin
  v_c := public.my_customer(p_business);
  if v_c.id is null then return public.jerr('not_registered', 'Not signed in.'); end if;
  update public.orders set status = 'CANCELLED', status_reason = 'Cancelled by customer'
    where id = p_order and business_id = p_business and customer_id = v_c.id and status = 'NEW';
  get diagnostics v_n = row_count;
  if v_n = 0 then return public.jerr('cannot_cancel', 'This order is already being prepared. Please talk to the staff.'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Merge a duplicate customer into another (Back Office admins).
create or replace function public.merge_customers(p_keep uuid, p_merge uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_b uuid := public.current_business_id(); v_keep public.customers; v_old public.customers;
begin
  if public.current_role_rank() < 3 then return public.jerr('not_allowed', 'Only an admin can merge customers.'); end if;
  if p_keep = p_merge then return public.jerr('same_customer', 'Pick two different customers.'); end if;
  select * into v_keep from public.customers where id = p_keep and business_id = v_b;
  select * into v_old from public.customers where id = p_merge and business_id = v_b;
  if v_keep.id is null or v_old.id is null then return public.jerr('not_found', 'Customer not found.'); end if;
  update public.customer_devices set customer_id = p_keep where customer_id = p_merge;
  update public.orders set customer_id = p_keep where customer_id = p_merge;
  update public.sales set customer_id = p_keep where customer_id = p_merge;
  update public.customers set merged_into = p_keep, phone = null where id = p_merge;
  if v_keep.phone is null and v_old.phone is not null then
    update public.customers set phone = v_old.phone where id = p_keep;
  end if;
  perform public.refresh_customer_stats(p_keep);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 9. Row-level security (drop every old rule on these tables, recreate)
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  all_tables text[] := array[
    'businesses','stores','profiles','devices','settings','categories','suppliers','ingredients','purchases',
    'recipes','recipe_ingredients','inventory_transactions','waste','production_batches','sales','sale_items',
    'payments','refunds','audit_log','shifts','cash_movements','reconciliation_issues','sync_operations',
    'staff','business_secrets','staff_pins','device_pairing_codes','staff_invites','dining_tables',
    'customers','customer_devices','customer_link_attempts','orders','order_items'];
  t text;
begin
  foreach t in array all_tables loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  for r in select tablename, policyname from pg_policies where schemaname = 'public' and tablename = any(all_tables) loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

do $$
declare
  t text;
  member text := '(business_id = (select public.current_business_id()))';
  admin text := '((select public.current_role_rank()) >= 3)';
begin
  -- Back Office data: everyone in the shop can read; only admins can change.
  foreach t in array array['stores','settings','categories','suppliers','ingredients','purchases','recipes',
                           'recipe_ingredients','waste','production_batches','staff','dining_tables',
                           'reconciliation_issues','sync_operations'] loop
    execute format('create policy %I on public.%I for select to authenticated using %s', 'read_' || t, t, member);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s and %s)', 'admin_insert_' || t, t, member, admin);
    execute format('create policy %I on public.%I for update to authenticated using (%s and %s) with check (%s and %s)', 'admin_update_' || t, t, member, admin, member, admin);
    execute format('create policy %I on public.%I for delete to authenticated using (%s and %s)', 'admin_delete_' || t, t, member, admin);
  end loop;

  -- Counter data: the counter can add and update; only admins can delete.
  foreach t in array array['sales','shifts','orders','customers'] loop
    execute format('create policy %I on public.%I for select to authenticated using %s', 'read_' || t, t, member);
    execute format('create policy %I on public.%I for insert to authenticated with check %s', 'insert_' || t, t, member);
    execute format('create policy %I on public.%I for update to authenticated using %s with check %s', 'update_' || t, t, member, member);
    execute format('create policy %I on public.%I for delete to authenticated using (%s and %s)', 'admin_delete_' || t, t, member, admin);
  end loop;

  -- Append-only records: add and read; never edited. Admins may delete.
  foreach t in array array['sale_items','payments','refunds','inventory_transactions','cash_movements','order_items'] loop
    execute format('create policy %I on public.%I for select to authenticated using %s', 'read_' || t, t, member);
    execute format('create policy %I on public.%I for insert to authenticated with check %s', 'insert_' || t, t, member);
    execute format('create policy %I on public.%I for delete to authenticated using (%s and %s)', 'admin_delete_' || t, t, member, admin);
  end loop;
end $$;

-- A held (parked) order and its lines may be removed at the counter.
create policy delete_held_sales on public.sales for delete to authenticated
  using (business_id = (select public.current_business_id()) and status = 'HELD');
create policy delete_held_sale_items on public.sale_items for delete to authenticated
  using (business_id = (select public.current_business_id())
         and exists (select 1 from public.sales s where s.id = sale_id and s.status = 'HELD'));

-- Audit log: append-only for everyone (no edits, no deletes).
create policy read_audit_log on public.audit_log for select to authenticated
  using (business_id = (select public.current_business_id()));
create policy insert_audit_log on public.audit_log for insert to authenticated
  with check (business_id = (select public.current_business_id()));

create policy read_businesses on public.businesses for select to authenticated
  using (id = (select public.current_business_id()));
create policy admin_update_businesses on public.businesses for update to authenticated
  using (id = (select public.current_business_id()) and (select public.current_role_rank()) >= 3)
  with check (id = (select public.current_business_id()) and (select public.current_role_rank()) >= 3);

create policy read_profiles on public.profiles for select to authenticated
  using (business_id = (select public.current_business_id()));
create policy admin_insert_profiles on public.profiles for insert to authenticated
  with check (business_id = (select public.current_business_id()) and (select public.current_role_rank()) >= 3);
create policy update_profiles on public.profiles for update to authenticated
  using (business_id = (select public.current_business_id()) and (id = auth.uid() or (select public.current_role_rank()) >= 3))
  with check (business_id = (select public.current_business_id()));

create policy read_devices on public.devices for select to authenticated
  using (business_id = (select public.current_business_id()));
create policy admin_update_devices on public.devices for update to authenticated
  using (business_id = (select public.current_business_id()) and (select public.current_role_rank()) >= 3)
  with check (business_id = (select public.current_business_id()) and (select public.current_role_rank()) >= 3);
create policy admin_delete_devices on public.devices for delete to authenticated
  using (business_id = (select public.current_business_id()) and (select public.current_role_rank()) >= 3);

-- business_secrets, staff_pins, device_pairing_codes, staff_invites, customer_devices,
-- customer_link_attempts: no rules at all = no direct access. Only the functions above use them.

-- ---------------------------------------------------------------------
-- 10. Permissions on functions and private tables
-- ---------------------------------------------------------------------
revoke all on public.business_secrets, public.staff_pins, public.device_pairing_codes, public.staff_invites,
              public.customer_devices, public.customer_link_attempts from anon, authenticated;

do $$
declare f text;
begin
  -- internal helpers: nobody calls these directly
  foreach f in array array[
    'public.pin_hmac(uuid, text)', 'public.normalize_phone(text)', 'public.random_code(integer)',
    'public.jerr(text, text)', 'public.stock_levels(uuid, date)', 'public.refresh_customer_stats(uuid)',
    'public.trg_sales_customer_stats()', 'public.handle_new_user_signup()', 'public.guard_profile_changes()',
    'public.touch_updated_at()', 'public.orders_status_times()', 'public.customer_json(public.customers)',
    'public.my_customer(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- used inside security rules
  foreach f in array array['public.current_business_id()', 'public.current_role_rank()', 'public.current_device_id()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
  -- signed-in apps (Back Office, counter devices, QR customers)
  foreach f in array array[
    'public.server_time()', 'public.stock_balances_before(date)', 'public.set_staff_pin(uuid, text)', 'public.staff_pin_status()',
    'public.staff_pin_login(text, text, boolean)', 'public.staff_sign_out()', 'public.device_info()',
    'public.create_pairing_code(text)', 'public.pair_device(text, text)', 'public.unpair_this_device(text)',
    'public.create_staff_invite(text)', 'public.customer_me(uuid)', 'public.customer_register(uuid, text, text, boolean)',
    'public.customer_link_phone(uuid, text, text)', 'public.customer_update_me(uuid, text, text)',
    'public.customer_forget_device(uuid)', 'public.place_order(uuid, text, text, jsonb, text)',
    'public.my_orders(uuid)', 'public.cancel_my_order(uuid, uuid)', 'public.merge_customers(uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- open to anyone (menu before sign-in, invite check on the sign-up screen)
  foreach f in array array['public.public_menu(uuid, text)', 'public.check_invite(text)'] loop
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 11. Live updates for the QR order queue at the counter
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders') then
    execute 'alter publication supabase_realtime add table public.orders';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 12. Fill in rows for the business you already created
-- ---------------------------------------------------------------------
insert into public.business_secrets (business_id) select id from public.businesses on conflict do nothing;
insert into public.settings (business_id) select b.id from public.businesses b
  where not exists (select 1 from public.settings s where s.business_id = b.id);
update public.settings s set business_name = b.name from public.businesses b
  where b.id = s.business_id and coalesce(s.business_name, '') = '';
insert into public.staff (business_id, name, role, profile_id)
  select p.business_id, coalesce(nullif(p.name, ''), 'Owner'), coalesce(p.role, 'ADMIN'), p.id
  from public.profiles p
  where not exists (select 1 from public.staff s where s.profile_id = p.id);
update public.profiles p set store_id = (select st.id from public.stores st where st.business_id = p.business_id order by st.created_at limit 1)
  where p.store_id is null;

commit;
