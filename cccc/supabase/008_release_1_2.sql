-- =============================================================================
-- Cavite City Coffee Club — 008: release 1.2
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004, 005, 006 and 007 (all already done). It is safe to run more
-- than once. It runs inside one transaction: if anything fails, nothing is
-- changed.
--
-- What it adds, in plain words:
--   A. Floor plan: tables get a place, size, shape, turn and seats on a
--      1000 x 1000 plan; new table floor_shapes for the counter bar, walls,
--      doors, plants and labels. Counters read the plan with fo_floor_plan()
--      (never the tables' QR codes).
--   B. Sub-category tile colours: settings.subcategory_colors, a list like
--      {"Iced": "terracotta"} using a fixed set of brand colour names.
--   C. Ingredient brands: new table ingredient_brands; purchases (and starting
--      stock / stock added by hand) can name the brand. Stock per brand is
--      worked out "first in, first out" (FIFO): the oldest stock is used up
--      first, so what is left belongs to the newest deliveries.
--   D. Stamp card: per customer and per day (Manila time) one stamp if they
--      bought a drink that day and one if they bought food (at most 2 a day),
--      worked out from the sales themselves. One card of 15 stamps: stamp 5 =
--      ₱10 off, stamp 10 = ₱50 off, stamp 15 = one free drink or food item
--      (settings.loyalty_rewards). Rewards are used at the counter as part of
--      a sale; the server checks each one (new table loyalty_redemptions).
--   E. Counter customers tab: fo_customer_list() and fo_customer_detail().
--      Everyone sees name, masked number, visits, stamps, favourites and
--      recent orders; only a manager / admin (with their sign-in token) sees
--      money.
--   F. settings.theme is now 'CCCC' (the brand design; the old saved colours
--      are ignored) or 'CUSTOM' (dark mode is dropped). Every existing shop
--      becomes 'CCCC'.
--
-- What it does NOT change: refunds, stock lines, the refund caps, PIN rules,
-- approvals and the QR ordering rules. The counter upload (_fo_apply) only
-- learns the stamp-card reward on a sale. No live CHECK rule is changed.
-- =============================================================================

begin;

-- =============================================================================
-- 0. Small helpers
-- =============================================================================
-- A number from text, or null when it isn't one (never raises an error).
-- Same as 004, except that any number of decimals is now read: a counter may
-- send 2.7191125000000005, which 004 read as "not a number" (and so as ₱0).
-- Still at most 15 digits before the point, an optional exponent, and text
-- of at most 200 characters.
create or replace function public._to_num(p text) returns numeric
language sql immutable as $$
  select case when length(btrim(p)) <= 200
               and btrim(p) ~ '^-?(\d{1,15}(\.\d*)?|\.\d+)([eE][-+]?\d{1,3})?$' then btrim(p)::numeric end
$$;

-- A time from text, or null when it isn't one (never raises an error).
create or replace function public._to_ts(p text) returns timestamptz
language plpgsql stable as $$
begin
  return p::timestamptz;
exception when others then
  return null;
end $$;

-- =============================================================================
-- A. FLOOR PLAN
-- =============================================================================

-- A1. New columns on dining_tables. The plan is a square grid 0..1000 wide and
-- 0..1000 high (the screens scale it to fit). pos_x / pos_y = top-left corner.
-- pos_x / pos_y empty (null) = "not placed on the plan yet" (the Back Office
-- shows such tables in a tray), so existing tables don't all pile up in a corner.
alter table public.dining_tables add column if not exists shape text not null default 'SQUARE';
alter table public.dining_tables add column if not exists pos_x numeric;
alter table public.dining_tables add column if not exists pos_y numeric;
alter table public.dining_tables add column if not exists width numeric not null default 80;
alter table public.dining_tables add column if not exists height numeric not null default 80;
alter table public.dining_tables add column if not exists rotation integer not null default 0;
alter table public.dining_tables add column if not exists seats smallint;

-- A2. Things on the plan that are not tables.
create table if not exists public.floor_shapes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  kind text not null default 'OTHER',
  label text,
  shape text not null default 'RECT',
  pos_x numeric not null default 0,
  pos_y numeric not null default 0,
  width numeric not null default 100,
  height numeric not null default 100,
  rotation integer not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists floor_shapes_business_idx on public.floor_shapes(business_id);

-- =============================================================================
-- B. SUB-CATEGORY TILE COLOURS
-- =============================================================================
alter table public.settings add column if not exists subcategory_colors jsonb not null default '{}'::jsonb;

-- The colour NAMES a sub-category tile may use (the hex values live in the
-- apps' style sheet, so the look can change without touching data).
create or replace function public._tile_color_keys() returns text[]
language sql immutable as $$
  select array['terracotta','deep_terracotta','olive','gold','butter','ink','sage','clay','cocoa','sky']
$$;

-- True when p is a valid colour list: a JSON object, at most 100 entries, each
-- key 1..40 characters, each value one of the colour names above.
create or replace function public._valid_subcategory_colors(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select p is not null and jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p)) <= 100
     and not exists (select 1 from jsonb_each(p) e
                     where length(btrim(e.key)) = 0 or length(e.key) > 40
                        or jsonb_typeof(e.value) <> 'string'
                        or not ((e.value #>> '{}') = any(public._tile_color_keys())))
$$;

-- True when p is a valid stamp card: {card_size: 1..100 (whole number),
-- rewards: 1..10 entries of {stamp: 1..card_size, each stamp once,
-- type: 'AMOUNT_OFF' (with amount above 0, at most 10000) or 'FREE_ITEM',
-- label: optional text up to 40 characters}}.
create or replace function public._valid_loyalty_rewards(p jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
declare v_size numeric; r jsonb; v_stamp numeric; v_seen numeric[] := '{}';
begin
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p->'card_size') is distinct from 'number' then return false; end if;
  v_size := (p->>'card_size')::numeric;
  if v_size < 1 or v_size > 100 or v_size <> trunc(v_size) then return false; end if;
  if jsonb_typeof(p->'rewards') is distinct from 'array' or jsonb_array_length(p->'rewards') not between 1 and 10 then return false; end if;
  for r in select value from jsonb_array_elements(p->'rewards') loop
    if jsonb_typeof(r) <> 'object' or jsonb_typeof(r->'stamp') is distinct from 'number' then return false; end if;
    v_stamp := (r->>'stamp')::numeric;
    if v_stamp < 1 or v_stamp > v_size or v_stamp <> trunc(v_stamp) or v_stamp = any(v_seen) then return false; end if;
    v_seen := v_seen || v_stamp;
    if coalesce(r->>'type', '') not in ('AMOUNT_OFF', 'FREE_ITEM') then return false; end if;
    if r->>'type' = 'AMOUNT_OFF' then
      if jsonb_typeof(r->'amount') is distinct from 'number' or (r->>'amount')::numeric <= 0 or (r->>'amount')::numeric > 10000 then
        return false;
      end if;
    end if;
    if coalesce(jsonb_typeof(r->'label'), 'null') not in ('null', 'string') or length(coalesce(r->>'label', '')) > 40 then
      return false;
    end if;
  end loop;
  return true;
end $$;

-- =============================================================================
-- C. INGREDIENT BRANDS (stock per brand, first in first out)
-- =============================================================================
create table if not exists public.ingredient_brands (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  -- Deleting an ingredient removes its brands ONLY when nothing uses them: a
  -- brand named on a purchase / stock line can't be deleted (BRAND_IN_USE, see
  -- the trigger below), and an ingredient with purchases can't be deleted anyway.
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ingredient_brands_business_idx on public.ingredient_brands(business_id);
-- one name per ingredient, whatever the upper/lower case or extra spaces
create unique index if not exists ingredient_brands_name_key on public.ingredient_brands(ingredient_id, lower(btrim(name)));
-- needed so purchases / stock lines can point at (brand, ingredient, shop) together
create unique index if not exists ingredient_brands_id_ing_biz_key on public.ingredient_brands(id, ingredient_id, business_id);

alter table public.purchases add column if not exists brand_id uuid;
alter table public.inventory_transactions add column if not exists brand_id uuid;
create index if not exists purchases_brand_idx on public.purchases(brand_id) where brand_id is not null;
create index if not exists inventory_tx_brand_idx on public.inventory_transactions(brand_id) where brand_id is not null;

-- =============================================================================
-- D. STAMPS (settings + cached numbers on customers)
-- =============================================================================
-- The stamp card and its rewards (owner decision 2026-10-29). One card of
-- card_size stamps (drink and food stamps together). rewards = which stamp on
-- the card gives what:
--   AMOUNT_OFF = that many pesos off a sale; FREE_ITEM = one drink or food item
--   of the customer's choice (the price of ONE of that item in the sale).
-- Change it later in Back Office settings; the database checks it (see
-- _valid_loyalty_rewards). The old stamps_per_reward stays for older apps.
alter table public.settings add column if not exists loyalty_rewards jsonb not null default
  '{"card_size": 15, "rewards": [
     {"stamp": 5,  "type": "AMOUNT_OFF", "amount": 10, "label": "₱10 off"},
     {"stamp": 10, "type": "AMOUNT_OFF", "amount": 50, "label": "₱50 off"},
     {"stamp": 15, "type": "FREE_ITEM", "label": "One free drink or food"}]}'::jsonb;

-- Which look the apps use (lead decision 2026-10-29), in the existing column
-- settings.theme (004 used it for 'light' / 'dark'; dark mode is dropped in 1.2):
--   'CCCC'   = the Cavite City Coffee Club brand design; the old saved colours
--              (primary_color, ...) are ignored;
--   'CUSTOM' = the shop's own saved colours (for other shops later).
-- Every value that is not one of these two ('light', 'dark', empty...) becomes
-- 'CCCC'. A shop already on 'CUSTOM' keeps it when this script runs again.
-- (The allowed-values rule settings_theme_check is added further down, after
-- this update.)
alter table public.settings alter column theme set default 'CCCC';
update public.settings set theme = 'CCCC' where theme is null or theme not in ('CCCC', 'CUSTOM');

-- Copies on each customer, kept up to date by the database (section D below).
-- The real numbers are always worked out from the sales; these copies are for
-- the Back Office lists. stamps = all stamps ever earned (drink + food).
alter table public.customers add column if not exists drink_stamps integer not null default 0;
-- When the SERVER received a finished counter sale (set only by fo_sync, the
-- counter can't choose it). Bounds the stamp day (see _customer_loyalty).
alter table public.sales add column if not exists received_at timestamptz;
alter table public.customers add column if not exists food_stamps integer not null default 0;

-- =============================================================================
-- Allowed-values rules for the NEW columns / tables (re-made on every run)
-- =============================================================================
-- None of these columns existed on live before, so no stored value can break.
do $$
declare spec text[];
  specs text[][] := array[
    array['dining_tables', 'dining_tables_shape_check',    $c$shape in ('SQUARE','ROUND','RECT')$c$],
    array['dining_tables', 'dining_tables_pos_x_check',    $c$pos_x is null or (pos_x >= 0 and pos_x <= 1000)$c$],
    array['dining_tables', 'dining_tables_pos_y_check',    $c$pos_y is null or (pos_y >= 0 and pos_y <= 1000)$c$],
    array['dining_tables', 'dining_tables_width_check',    $c$width >= 10 and width <= 1000$c$],
    array['dining_tables', 'dining_tables_height_check',   $c$height >= 10 and height <= 1000$c$],
    array['dining_tables', 'dining_tables_rotation_check', $c$rotation >= 0 and rotation <= 359$c$],
    array['dining_tables', 'dining_tables_seats_check',    $c$seats is null or (seats >= 1 and seats <= 99)$c$],
    array['floor_shapes',  'floor_shapes_kind_check',      $c$kind in ('COUNTER','WALL','DOOR','PLANT','LABEL','OTHER')$c$],
    array['floor_shapes',  'floor_shapes_label_check',     $c$label is null or length(label) <= 40$c$],
    array['floor_shapes',  'floor_shapes_shape_check',     $c$shape in ('RECT','ROUND')$c$],
    array['floor_shapes',  'floor_shapes_pos_x_check',     $c$pos_x >= 0 and pos_x <= 1000$c$],
    array['floor_shapes',  'floor_shapes_pos_y_check',     $c$pos_y >= 0 and pos_y <= 1000$c$],
    array['floor_shapes',  'floor_shapes_width_check',     $c$width >= 1 and width <= 1000$c$],
    array['floor_shapes',  'floor_shapes_height_check',    $c$height >= 1 and height <= 1000$c$],
    array['floor_shapes',  'floor_shapes_rotation_check',  $c$rotation >= 0 and rotation <= 359$c$],
    array['ingredient_brands', 'ingredient_brands_name_check', $c$length(btrim(name)) between 1 and 60$c$],
    array['settings', 'settings_theme_check', $c$theme in ('CCCC','CUSTOM')$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
end $$;

-- A purchase / stock line that names a brand must name a brand of the SAME
-- ingredient in the SAME shop (the database refuses anything else).
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.purchases'::regclass and conname = 'purchases_brand_fk') then
    alter table public.purchases add constraint purchases_brand_fk
      foreign key (brand_id, ingredient_id, business_id) references public.ingredient_brands(id, ingredient_id, business_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_transactions'::regclass and conname = 'inventory_tx_brand_fk') then
    alter table public.inventory_transactions add constraint inventory_tx_brand_fk
      foreign key (brand_id, ingredient_id, business_id) references public.ingredient_brands(id, ingredient_id, business_id);
  end if;
end $$;

-- Clear answers instead of database error texts (the rules above stay as the
-- safety net):
--   settings:   BAD_SUBCATEGORY_COLORS = the colour list is not valid
--               BAD_LOYALTY_REWARDS    = the stamp card settings are not valid
--   purchases / stock lines: BRAND_MISMATCH = the brand is not one of this
--               ingredient's brands in this shop
--   stock lines: BRAND_NOT_ALLOWED = a brand may only be named on starting
--               stock (INITIAL_STOCK) and stock added by hand (ADJUSTMENT
--               above 0). A purchase's brand is saved on the purchase itself.
--               Sales and refunds never carry a brand.
--   ingredient_brands: BRAND_IN_USE = a brand that a purchase / stock line
--               names can't be deleted or moved to another ingredient (turn it
--               off with active = false instead).
create or replace function public._settings_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public._valid_subcategory_colors(new.subcategory_colors) then raise exception 'BAD_SUBCATEGORY_COLORS'; end if;
  if not public._valid_loyalty_rewards(new.loyalty_rewards) then raise exception 'BAD_LOYALTY_REWARDS'; end if;
  -- An older Back Office still sends theme 'light' / 'dark' (dark mode is
  -- dropped in 1.2): keep the shop's current look instead of refusing the
  -- whole settings save. Any other unknown word is refused by settings_theme_check.
  if new.theme is null or new.theme in ('light', 'dark') then
    new.theme := case when tg_op = 'UPDATE' and old.theme in ('CCCC', 'CUSTOM') then old.theme else 'CCCC' end;
  end if;
  return new;
end $$;
drop trigger if exists settings_check on public.settings;
create trigger settings_check before insert or update on public.settings
  for each row execute function public._settings_check();

create or replace function public._brand_line_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.brand_id is null then return new; end if;
  if tg_table_name = 'inventory_transactions' then
    -- (a separate IF: purchases rows have no transaction_type)
    if not (new.transaction_type = 'INITIAL_STOCK' or (new.transaction_type = 'ADJUSTMENT' and new.quantity > 0)) then
      raise exception 'BRAND_NOT_ALLOWED';
    end if;
  end if;
  if not exists (select 1 from public.ingredient_brands b
                 where b.id = new.brand_id and b.ingredient_id = new.ingredient_id and b.business_id = new.business_id) then
    raise exception 'BRAND_MISMATCH';
  end if;
  return new;
end $$;
drop trigger if exists purchases_brand_check on public.purchases;
create trigger purchases_brand_check before insert or update on public.purchases
  for each row execute function public._brand_line_check();
drop trigger if exists inventory_tx_brand_check on public.inventory_transactions;
create trigger inventory_tx_brand_check before insert or update on public.inventory_transactions
  for each row execute function public._brand_line_check();

create or replace function public._brand_in_use_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    -- other changes (name, active, sort order...) are always fine
    if new.ingredient_id is not distinct from old.ingredient_id and new.business_id is not distinct from old.business_id then
      return new;
    end if;
  end if;
  if exists (select 1 from public.purchases where brand_id = old.id)
     or exists (select 1 from public.inventory_transactions where brand_id = old.id) then
    raise exception 'BRAND_IN_USE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists ingredient_brands_in_use on public.ingredient_brands;
create trigger ingredient_brands_in_use before update or delete on public.ingredient_brands
  for each row execute function public._brand_in_use_check();

-- -----------------------------------------------------------------------------
-- C2. Stock per brand, first in first out
-- -----------------------------------------------------------------------------
-- A "lot" = one delivery of stock: a purchase, starting stock (INITIAL_STOCK),
-- a production batch (PRODUCTION) or stock added by hand (ADJUSTMENT above 0).
-- Its brand: the purchase's brand_id for purchases, the stock line's brand_id
-- for the others (empty = "Not set").
-- How much of each lot is LEFT: the ingredient's total stock (the same sum as
-- v_ingredient_stock) is given to the NEWEST lots first, because the oldest
-- stock is used up first. Each lot gets at most its own quantity. Lot order =
-- its date (transaction_date), then when it was saved (created_at), then id.
-- If the total is more than all lots together (rare: e.g. stock put back by
-- refunds after old data without lots) the extra is "Not set" (lot_id null).
-- Internal: only the functions below use it (it filters by the shop passed in).
create or replace function public._brand_lots(p_biz uuid, p_ingredient uuid default null)
returns table(ingredient_id uuid, lot_id uuid, purchase_id uuid, source text, lot_date date, created_at timestamptz,
              brand_id uuid, quantity numeric, remaining numeric, price_per_base_unit numeric)
language sql stable security definer set search_path = public as $$
  with tx as (
    select it.* from public.inventory_transactions it
    where it.business_id = p_biz and (p_ingredient is null or it.ingredient_id = p_ingredient)
  ),
  stock as (
    select t.ingredient_id,
           greatest(sum(case when t.transaction_type = 'ADJUSTMENT' then t.quantity
                             when t.transaction_type in ('PURCHASE','INITIAL_STOCK','PRODUCTION','SALE_REVERSAL') then abs(t.quantity)
                             else -abs(t.quantity) end), 0) as total
    from tx t group by t.ingredient_id
  ),
  lots as (
    select t.ingredient_id, t.id as lot_id, p.id as purchase_id, t.transaction_type as source, t.transaction_date as lot_date,
           t.created_at,
           case when t.transaction_type = 'PURCHASE' then coalesce(p.brand_id, t.brand_id) else t.brand_id end as brand_id,
           case when t.transaction_type = 'ADJUSTMENT' then t.quantity else abs(t.quantity) end as quantity,
           case when t.transaction_type = 'PURCHASE' then p.price_per_base_unit end as price_per_base_unit
    from tx t
    left join public.purchases p
      on t.transaction_type = 'PURCHASE' and p.id = public._to_uuid(t.reference_id) and p.business_id = t.business_id
    where t.transaction_type in ('PURCHASE','INITIAL_STOCK','PRODUCTION')
       or (t.transaction_type = 'ADJUSTMENT' and t.quantity > 0)
  ),
  ranked as (
    select l.*,
           coalesce(sum(l.quantity) over (partition by l.ingredient_id
                      order by l.lot_date desc nulls last, l.created_at desc nulls last, l.lot_id desc
                      rows between unbounded preceding and 1 preceding), 0) as newer
    from lots l where l.quantity > 0
  )
  select r.ingredient_id, r.lot_id, r.purchase_id, r.source, r.lot_date, r.created_at, r.brand_id, r.quantity,
         least(r.quantity, greatest(s.total - r.newer, 0)) as remaining, r.price_per_base_unit
  from ranked r join stock s on s.ingredient_id = r.ingredient_id
  union all
  -- stock that no lot covers -> "Not set"
  select s.ingredient_id, null, null, 'UNASSIGNED', null, null, null, 0,
         s.total - coalesce((select sum(l.quantity) from lots l where l.ingredient_id = s.ingredient_id and l.quantity > 0), 0), null
  from stock s
  where s.total - coalesce((select sum(l.quantity) from lots l where l.ingredient_id = s.ingredient_id and l.quantity > 0), 0) > 0
$$;

-- The brand stock of a shop as JSON, one entry per ingredient that has stock
-- or lots:
-- [{ingredient_id, stock,
--   in_use: {brand_id, brand_name, lot_id, lot_date, remaining, price_per_base_unit} | null,
--   brands: [{brand_id, brand_name, remaining}],         (brand_id null = "Not set")
--   lots:   [{lot_id, purchase_id, source, lot_date, brand_id, quantity, remaining, price_per_base_unit}]}]
-- in_use = the OLDEST lot that still has stock (the one being used now).
-- lots lists only lots that still have stock, oldest first.
-- Internal: bo_bootstrap and ingredient_brand_stock() call it.
create or replace function public._brand_stock_json(p_biz uuid, p_ingredient uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
  with l as (select * from public._brand_lots(p_biz, p_ingredient)),
  names as (select id, name from public.ingredient_brands where business_id = p_biz),
  per_ing as (
    select l.ingredient_id, sum(l.remaining) as stock from l group by l.ingredient_id
  ),
  in_use as (
    select distinct on (l.ingredient_id) l.*
    from l where l.remaining > 0 and l.lot_id is not null
    order by l.ingredient_id, l.lot_date asc nulls first, l.created_at asc nulls first, l.lot_id asc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'ingredient_id', pi.ingredient_id,
    'stock', pi.stock,
    'in_use', (select jsonb_build_object('brand_id', u.brand_id, 'brand_name', (select n.name from names n where n.id = u.brand_id),
                                         'lot_id', u.lot_id, 'lot_date', u.lot_date, 'remaining', u.remaining,
                                         'price_per_base_unit', u.price_per_base_unit)
               from in_use u where u.ingredient_id = pi.ingredient_id),
    'brands', (select coalesce(jsonb_agg(jsonb_build_object('brand_id', b.brand_id, 'brand_name', (select n.name from names n where n.id = b.brand_id),
                                                            'remaining', b.remaining) order by b.brand_id nulls last), '[]'::jsonb)
               from (select l.brand_id, sum(l.remaining) as remaining from l
                     where l.ingredient_id = pi.ingredient_id group by l.brand_id having sum(l.remaining) > 0) b),
    'lots', (select coalesce(jsonb_agg(jsonb_build_object('lot_id', x.lot_id, 'purchase_id', x.purchase_id, 'source', x.source,
                                                          'lot_date', x.lot_date, 'brand_id', x.brand_id, 'quantity', x.quantity,
                                                          'remaining', x.remaining, 'price_per_base_unit', x.price_per_base_unit)
                                       order by x.lot_date asc nulls first, x.created_at asc nulls first, x.lot_id asc), '[]'::jsonb)
             from l x where x.ingredient_id = pi.ingredient_id and x.remaining > 0 and x.lot_id is not null)
  ) order by pi.ingredient_id), '[]'::jsonb)
  from per_ing pi
$$;

-- Back Office: brand stock now (for one ingredient, or all with null).
-- Only the owner's email login (rank 3) gets it.
create or replace function public.ingredient_brand_stock(p_ingredient_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public.current_business_id();
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  if public.app_rank() < 3 then raise exception 'NOT_ALLOWED'; end if;
  return public._brand_stock_json(v_biz, p_ingredient_id);
end $$;

-- =============================================================================
-- D. STAMPS = DAILY VISITS, worked out from the sales
-- =============================================================================
-- How many of one sale line were given back by the sale's refunds (refunds
-- that list items: {sale_item_id, quantity}). Same reading as _refund_items_cap.
create or replace function public._sale_item_refunded_qty(p_sale_id uuid, p_item_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(greatest(coalesce(public._to_num(it->>'quantity'), 0), 0)), 0)
  from public.refunds o,
       jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) it
  where o.sale_id = p_sale_id and it->>'sale_item_id' = p_item_id::text
$$;

-- One customer's loyalty numbers, from their sales (owner decision 2026-10-29,
-- security review 2026-10-29 M1):
--   * a sale counts when it is finished and not voided / fully refunded
--     (status COMPLETED or PARTIALLY_REFUNDED), its total is above ₱0, and it
--     is not waiting for the owner's check because of a price below the menu
--     (needs_review with PRICE_BELOW_MENU / NOT_ON_MENU; once the owner clears
--     needs_review it counts). QR orders count once they are paid at the counter.
--   * a line counts when its unit price is above ₱0, its quantity is at least 1
--     and not all of it was given back.
--   * a day = a calendar day in the shop's time zone (Asia/Manila), taken from
--     the sale's time, but never trusted from the counter alone: for counter
--     sales the server notes when it RECEIVED the sale (sales.received_at), and
--     the day used is kept between 7 days before that and that day itself (the
--     offline allowance). Sales without received_at (before 008, Back Office
--     entries, imports) use their own time.
--   visits       = number of days with at least one such sale
--   drink_stamps = number of days with at least one such DRINK line (recipe type DRINKS)
--   food_stamps  = same for food (recipe types PASTRY and FOOD)
--   So a drink and a pastry on one day = 1 drink + 1 food stamp; two drinks on
--   one day = 1 drink stamp. A partial refund takes a day's stamp away only
--   when EVERY drink (or every food) line of that day was given back.
--   last_visit_at = the (bounded) time of their latest such sale.
--   All stamps go on ONE card (drink + food together, at most 2 per day):
--   total stamps = drink_stamps + food_stamps.
-- p_exclude_sale: leave this one sale out (used to check a reward "before
-- this sale": the sale's own stamps never unlock a reward on itself).
-- (An earlier test copy had this function without p_exclude_sale: removed.)
drop function if exists public._customer_loyalty(uuid, uuid);
create or replace function public._customer_loyalty(p_biz uuid, p_customer uuid, p_exclude_sale uuid default null)
returns table(visits integer, drink_stamps integer, food_stamps integer, last_visit_at timestamptz)
language sql stable security definer set search_path = public as $$
  with tz as (
    select coalesce((select nullif(btrim(timezone), '') from public.settings where business_id = p_biz), 'Asia/Manila') as zone
  ),
  s0 as (
    select x.id, coalesce(x.transaction_date, x.received_at, x.created_at) as t, x.received_at
    from public.sales x
    where x.business_id = p_biz and x.customer_id = p_customer and x.status in ('COMPLETED', 'PARTIALLY_REFUNDED')
      and coalesce(x.grand_total, 0) > 0
      and not (coalesce(x.needs_review, false) and coalesce(x.review_reason, '') ~ '(PRICE_BELOW_MENU|NOT_ON_MENU)')
      and (p_exclude_sale is null or x.id <> p_exclude_sale)
  ),
  s as (
    select s0.id, b.at, (b.at at time zone (select zone from tz))::date as day
    from s0, lateral (select case when s0.received_at is null then s0.t
                                  else least(greatest(s0.t, s0.received_at - interval '7 days'), s0.received_at) end as at) b
  ),
  lines as (
    select s.day, r.recipe_type
    from s
    join public.sale_items si on si.sale_id = s.id and si.business_id = p_biz
    join public.recipes r on r.id = si.recipe_id and r.business_id = p_biz
    where coalesce(si.unit_price, 0) > 0 and coalesce(si.quantity, 0) >= 1
      and coalesce(si.quantity, 0) - public._sale_item_refunded_qty(s.id, si.id) > 0.0001
  )
  select (select count(distinct day) from s)::int,
         (select count(distinct day) from lines where recipe_type = 'DRINKS')::int,
         (select count(distinct day) from lines where recipe_type in ('PASTRY', 'FOOD'))::int,
         (select max(at) from s)
$$;

-- Bring one customer's stored copies (visit_count, stamps, drink_stamps,
-- food_stamps) in line with the sales. Never fails (they are only copies).
create or replace function public._refresh_customer_loyalty(p_customer uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_biz uuid; l record;
begin
  if p_customer is null then return; end if;
  select business_id into v_biz from public.customers where id = p_customer;
  if v_biz is null then return; end if;
  select * into l from public._customer_loyalty(v_biz, p_customer);
  update public.customers
     set visit_count = l.visits, drink_stamps = l.drink_stamps, food_stamps = l.food_stamps,
         stamps = l.drink_stamps + l.food_stamps, updated_at = now()
   where id = p_customer
     and (visit_count, drink_stamps, food_stamps, stamps)
         is distinct from (l.visits, l.drink_stamps, l.food_stamps, l.drink_stamps + l.food_stamps);
exception when others then
  raise warning 'loyalty refresh for % failed: %', p_customer, sqlerrm;
end $$;

-- Keeps the copies right (security review M4: each customer once per save).
--   1. After every statement that changes sales, sale lines or refunds, the
--      customers concerned are noted ONCE in loyalty_pending (statement-level
--      triggers with the changed rows; "on conflict do nothing").
--   2. When the save ENDS, a deferred trigger on loyalty_pending works each
--      noted customer out again (after everything of that save is in, so e.g.
--      the counter's own "+1 visit" is replaced by the real number) and
--      removes the note. fo_sync and apply_changes do not change this timing.
-- A counter upload that fails is undone with its notes.
create table if not exists public.loyalty_pending (customer_id uuid primary key);
alter table public.loyalty_pending enable row level security;   -- no rules: only these functions use it

-- (Earlier test copies had per-row triggers: removed.)
drop trigger if exists sales_loyalty on public.sales;
drop trigger if exists sale_items_loyalty on public.sale_items;
drop trigger if exists refunds_loyalty on public.refunds;
drop function if exists public._loyalty_trigger();

create or replace function public._loyalty_note() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if tg_table_name = 'sales' then
      if tg_op in ('INSERT', 'UPDATE') then
        insert into public.loyalty_pending(customer_id) select distinct customer_id from new_rows where customer_id is not null
          on conflict do nothing;
      end if;
      if tg_op in ('UPDATE', 'DELETE') then
        insert into public.loyalty_pending(customer_id) select distinct customer_id from old_rows where customer_id is not null
          on conflict do nothing;
      end if;
    else
      -- sale_items / refunds: the customer of their sale
      if tg_op in ('INSERT', 'UPDATE') then
        insert into public.loyalty_pending(customer_id)
          select distinct s.customer_id from public.sales s where s.customer_id is not null
            and s.id in (select sale_id from new_rows)
          on conflict do nothing;
      end if;
      if tg_op in ('UPDATE', 'DELETE') then
        insert into public.loyalty_pending(customer_id)
          select distinct s.customer_id from public.sales s where s.customer_id is not null
            and s.id in (select sale_id from old_rows)
          on conflict do nothing;
      end if;
    end if;
  exception when others then
    raise warning 'loyalty note failed: %', sqlerrm;   -- never blocks a save
  end;
  return null;
end $$;

do $$
declare t text; ev text;
begin
  foreach t in array array['sales', 'sale_items', 'refunds'] loop
    foreach ev in array array['insert', 'update', 'delete'] loop
      execute format('drop trigger if exists %I on public.%I', t || '_loyalty_' || ev, t);
      execute format('create trigger %I after %s on public.%I referencing %s for each statement execute function public._loyalty_note()',
                     t || '_loyalty_' || ev, ev, t,
                     case ev when 'insert' then 'new table as new_rows'
                             when 'delete' then 'old table as old_rows'
                             else 'old table as old_rows new table as new_rows' end);
    end loop;
  end loop;
end $$;

create or replace function public._loyalty_pending_run() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public._refresh_customer_loyalty(new.customer_id);
  exception when others then
    raise warning 'loyalty refresh failed: %', sqlerrm;
  end;
  delete from public.loyalty_pending where customer_id = new.customer_id;
  return null;
end $$;
drop trigger if exists loyalty_pending_run on public.loyalty_pending;
create constraint trigger loyalty_pending_run after insert on public.loyalty_pending
  deferrable initially deferred for each row execute function public._loyalty_pending_run();


-- =============================================================================
-- D3. THE STAMP CARD AND ITS REWARDS
-- =============================================================================
-- Card numbering (one rule for every app), with S = card_size (15) and
-- T = total stamps:
--   card_no        = the card the latest stamp is on: 1 while T <= S, 2 while
--                    T <= 2S, ...  (T = 0 -> card 1)   = greatest(ceil(T / S), 1)
--   stamps_on_card = T - (card_no - 1) x S, so 0..S. A full card shows S
--                    (15/15) until the NEXT stamp arrives; that stamp is 1/15
--                    on card card_no + 1.
--   reward at stamp m of card c is reached when T >= (c - 1) x S + m.
-- Rewards of earlier cards that were reached but not used stay available
-- (listed in ready_rewards); they don't expire.

-- One reward used on one sale. A used reward counts while released_at is
-- empty. Voiding / fully refunding that sale fills released_at, so the reward
-- can be used again. merged_from = the customer it came from when two customer
-- records were merged and the kept record had ALREADY used the same reward
-- (kept as history only; it does not count).
create table if not exists public.loyalty_redemptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,   -- erased customer -> rows go too
  card_no integer not null,
  milestone integer not null,
  reward_type text,
  recipe_id uuid references public.recipes(id),
  sale_id uuid not null references public.sales(id) on delete cascade,
  amount numeric not null default 0,
  released_at timestamptz,
  merged_from uuid,
  created_at timestamptz not null default now()
);
create index if not exists loyalty_redemptions_business_idx on public.loyalty_redemptions(business_id);
create index if not exists loyalty_redemptions_sale_idx on public.loyalty_redemptions(sale_id);
-- each reward of each card can be used ONCE (two sales can't both use it) ...
create unique index if not exists loyalty_redemptions_once_key on public.loyalty_redemptions(customer_id, card_no, milestone)
  where released_at is null and merged_from is null;
-- ... and a sale uses at most one reward
create unique index if not exists loyalty_redemptions_one_per_sale_key on public.loyalty_redemptions(sale_id)
  where released_at is null and merged_from is null;
do $$
declare spec text[];
  specs text[][] := array[
    array['loyalty_redemptions', 'loyalty_redemptions_card_no_check',   $c$card_no >= 1$c$],
    array['loyalty_redemptions', 'loyalty_redemptions_milestone_check', $c$milestone between 1 and 100$c$],
    array['loyalty_redemptions', 'loyalty_redemptions_amount_check',    $c$amount >= 0$c$],
    array['loyalty_redemptions', 'loyalty_redemptions_type_check',      $c$reward_type is null or reward_type in ('AMOUNT_OFF','FREE_ITEM')$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
end $$;

-- The money a reward took off a sale (server-set, see _fo_apply). 0 = none.
alter table public.sales add column if not exists loyalty_discount numeric not null default 0;

-- The shop's stamp card settings, with the owner's defaults if missing.
create or replace function public._loyalty_config(p_biz uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select case when public._valid_loyalty_rewards(loyalty_rewards) then loyalty_rewards end
                   from public.settings where business_id = p_biz),
    '{"card_size": 15, "rewards": [{"stamp": 5, "type": "AMOUNT_OFF", "amount": 10, "label": "₱10 off"},
      {"stamp": 10, "type": "AMOUNT_OFF", "amount": 50, "label": "₱50 off"},
      {"stamp": 15, "type": "FREE_ITEM", "label": "One free drink or food"}]}'::jsonb)
$$;

-- Everything about one customer's stamps, as JSON:
--   {visits, last_visit_at, total_stamps, drink_stamps_earned, food_stamps_earned,
--    card: {card_size, card_no, stamps_on_card,
--           milestones: [{stamp, type, amount, label, status}]},   status = locked | ready | redeemed
--    ready_rewards: [{card_no, stamp, type, amount, label}]}        every reward reached and not used yet
--                                                                   (this card and earlier ones), oldest first
create or replace function public._loyalty_summary(p_biz uuid, p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l record; v_cfg jsonb := public._loyalty_config(p_biz); v_size integer; v_total integer; v_card integer;
begin
  select * into l from public._customer_loyalty(p_biz, p_customer);
  v_size := (v_cfg->>'card_size')::int;
  v_total := coalesce(l.drink_stamps, 0) + coalesce(l.food_stamps, 0);
  v_card := greatest(ceil(v_total::numeric / v_size)::int, 1);
  return jsonb_build_object(
    'visits', coalesce(l.visits, 0), 'last_visit_at', l.last_visit_at,
    'total_stamps', v_total, 'drink_stamps_earned', coalesce(l.drink_stamps, 0), 'food_stamps_earned', coalesce(l.food_stamps, 0),
    'card', jsonb_build_object('card_size', v_size, 'card_no', v_card, 'stamps_on_card', v_total - (v_card - 1) * v_size,
      'milestones', (select coalesce(jsonb_agg(jsonb_build_object('stamp', (r->>'stamp')::int, 'type', r->>'type',
                         'amount', r->'amount', 'label', r->>'label',
                         'status', case when exists (select 1 from public.loyalty_redemptions x
                                                     where x.business_id = p_biz and x.customer_id = p_customer and x.card_no = v_card
                                                       and x.milestone = (r->>'stamp')::int
                                                       and x.released_at is null and x.merged_from is null) then 'redeemed'
                                        when v_total >= (v_card - 1) * v_size + (r->>'stamp')::int then 'ready'
                                        else 'locked' end) order by (r->>'stamp')::int), '[]'::jsonb)
                     from jsonb_array_elements(v_cfg->'rewards') r)),
    'ready_rewards', (select coalesce(jsonb_agg(jsonb_build_object('card_no', c, 'stamp', (r->>'stamp')::int, 'type', r->>'type',
                          'amount', r->'amount', 'label', r->>'label') order by c, (r->>'stamp')::int), '[]'::jsonb)
                      from generate_series(1, v_card) c, jsonb_array_elements(v_cfg->'rewards') r
                      where v_total >= (c - 1) * v_size + (r->>'stamp')::int
                        and not exists (select 1 from public.loyalty_redemptions x
                                        where x.business_id = p_biz and x.customer_id = p_customer and x.card_no = c and x.milestone = (r->>'stamp')::int
                                          and x.released_at is null and x.merged_from is null)));
end $$;

-- How much a reward takes off a counter sale. Called by _fo_apply for a
-- finished sale whose data.sale.loyalty_reward = {customer_id, card_no,
-- milestone, recipe_id (FREE_ITEM only)}. Anything wrong -> REWARD_NOT_AVAILABLE:
--   loyalty is switched off for the shop; the reward's customer is not the
--   sale's customer (or not this shop's, or merged away); no such reward on
--   the card; not reached BEFORE this sale (the sale's own stamps don't
--   count); already used on another sale (and not released by a void /
--   full refund); FREE_ITEM: the chosen item is not a drink / food item of
--   this shop that is in this sale.
-- Amount (all server prices, never the counter's):
--   AMOUNT_OFF -> the reward's amount (₱10 / ₱50);
--   FREE_ITEM  -> the price of ONE of the chosen item: its menu price now
--                 (recipe price + the options chosen on that line), but not
--                 more than that line's own unit price nor its line total.
--                 Only lines with a whole quantity of 1 or more count; if the
--                 item is on several such lines, the dearest one.
--   Then never more than what is left after the manager discount:
--   least(amount, subtotal - discount_amount), rounded to centavos.
-- Locks the customer row, so two sales using the same reward at the same
-- moment are checked one after the other (the unique index is the backstop).
create or replace function public._loyalty_reward_amount(p_biz uuid, p_sale_id uuid, p_sale jsonb, p_items jsonb, p_rw jsonb)
returns numeric language plpgsql volatile security definer set search_path = public as $$
declare
  v_cust uuid := public._to_uuid(p_rw->>'customer_id'); v_card integer; v_ms integer; v_cfg jsonb; v_size integer;
  v_r jsonb; v_total integer; v_amt numeric; v_rid uuid; v_rec public.recipes%rowtype; v_s public.settings%rowtype;
begin
  select * into v_s from public.settings where business_id = p_biz;
  if not coalesce(v_s.loyalty_enabled, false) then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  if v_cust is null or v_cust is distinct from public._to_uuid(p_sale->>'customer_id') then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  perform 1 from public.customers where id = v_cust and business_id = p_biz and merged_into is null for update;
  if not found then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  v_card := case when (p_rw->>'card_no') ~ '^\d{1,6}$' then (p_rw->>'card_no')::int end;
  v_ms := case when (p_rw->>'milestone') ~ '^\d{1,3}$' then (p_rw->>'milestone')::int end;
  if v_card is null or v_card < 1 or v_ms is null then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  v_cfg := public._loyalty_config(p_biz);
  v_size := (v_cfg->>'card_size')::int;
  select r into v_r from jsonb_array_elements(v_cfg->'rewards') r where (r->>'stamp')::int = v_ms limit 1;
  if v_r is null then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  select coalesce(drink_stamps, 0) + coalesce(food_stamps, 0) into v_total from public._customer_loyalty(p_biz, v_cust, p_sale_id);
  if v_total < (v_card - 1) * v_size + v_ms then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  if exists (select 1 from public.loyalty_redemptions x
             where x.business_id = p_biz
               and (x.customer_id = v_cust and x.card_no = v_card and x.milestone = v_ms or x.sale_id = p_sale_id)
               and x.released_at is null and x.merged_from is null) then
    raise exception 'REWARD_NOT_AVAILABLE';
  end if;
  if v_r->>'type' = 'AMOUNT_OFF' then
    v_amt := (v_r->>'amount')::numeric;
  else
    v_rid := public._to_uuid(p_rw->>'recipe_id');
    select * into v_rec from public.recipes where id = v_rid and business_id = p_biz and recipe_type in ('DRINKS', 'PASTRY', 'FOOD');
    if not found then raise exception 'REWARD_NOT_AVAILABLE'; end if;
    select max(least(public._menu_unit_price(v_rec.selling_price, v_rec.modifier_groups, it->'modifiers'),
                     greatest(coalesce(public._to_num(it->>'unit_price'), 0), 0),
                     greatest(coalesce(public._to_num(it->>'line_total'), 0), 0)))
      into v_amt
      from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) it
      where it->>'recipe_id' = v_rid::text
        and public._to_num(it->>'quantity') >= 1
        and public._to_num(it->>'quantity') = trunc(public._to_num(it->>'quantity'));
    if v_amt is null then raise exception 'REWARD_NOT_AVAILABLE'; end if;
  end if;
  return round(least(greatest(v_amt, 0),
                     greatest(coalesce(public._to_num(p_sale->>'subtotal'), 0) - coalesce(public._to_num(p_sale->>'discount_amount'), 0), 0)), 2);
end $$;

-- Voiding / fully refunding a sale gives its reward back (usable again).
create or replace function public._release_reward_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.loyalty_redemptions set released_at = now()
    where sale_id = new.id and business_id = new.business_id and released_at is null;
  return null;
end $$;
drop trigger if exists sales_release_reward on public.sales;
create trigger sales_release_reward after update on public.sales
  for each row when (new.status in ('VOIDED', 'REFUNDED') and old.status is distinct from new.status)
  execute function public._release_reward_trigger();

-- Merging two customer records (merge_customers, or the Back Office setting
-- merged_into): the merged record's used rewards move to the kept record. One
-- the kept record already used too is kept as history only (merged_from set).
create or replace function public._merge_rewards_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.loyalty_redemptions r set merged_from = r.customer_id, customer_id = new.merged_into
    where r.customer_id = new.id and r.business_id = new.business_id
      and (r.released_at is not null or r.merged_from is not null
           or exists (select 1 from public.loyalty_redemptions k
                      where k.business_id = new.business_id and k.customer_id = new.merged_into and k.card_no = r.card_no and k.milestone = r.milestone
                        and k.released_at is null and k.merged_from is null));
  update public.loyalty_redemptions set customer_id = new.merged_into where customer_id = new.id and business_id = new.business_id;
  return null;
end $$;
drop trigger if exists customers_merge_rewards on public.customers;
create trigger customers_merge_rewards after update on public.customers
  for each row when (old.merged_into is null and new.merged_into is not null)
  execute function public._merge_rewards_trigger();

-- -----------------------------------------------------------------------------
-- D4. Counter sales with a reward: the money checks know about it
-- -----------------------------------------------------------------------------
-- Same as 004, plus the reward (sale.loyalty_discount, 0 when none). The
-- reward comes AFTER the manager discount and BEFORE tax / service charge:
--   discount       = as before (on the subtotal, at most the subtotal)
--   loyalty        = 0 .. (subtotal - discount)
--   grand_total    = subtotal - discount - loyalty + tax + service charge
create or replace function public._check_sale_totals(p_sale jsonb, p_items jsonb) returns void
language plpgsql immutable set search_path = public as $$
declare
  c_tol constant numeric := 0.02;
  v_it jsonb; v_qty numeric; v_unit numeric; v_line numeric; v_sum numeric := 0;
  v_sub numeric; v_disc numeric; v_dtype text; v_dval numeric; v_expect numeric;
  v_tax numeric; v_svc numeric; v_grand numeric; v_bad boolean := false; v_loy numeric;
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
    v_loy   := coalesce((p_sale->>'loyalty_discount')::numeric, 0);
    v_expect := least(case v_dtype when 'percent' then v_sub * v_dval / 100 when 'fixed' then v_dval else 0 end, v_sub);
    if abs(v_sub - v_sum) > c_tol
       or v_disc < 0 or v_disc > v_sub + c_tol or abs(v_disc - v_expect) > c_tol
       or v_loy < 0 or v_loy > v_sub - v_disc + c_tol
       or v_tax < 0 or v_svc < 0
       or v_grand is null or abs(v_grand - (v_sub - v_disc - v_loy + v_tax + v_svc)) > c_tol then
      v_bad := true;
    end if;
  exception when data_exception then
    v_bad := true;   -- e.g. a "number" that isn't a number
  end;
  if v_bad then raise exception 'SALE_TOTALS_MISMATCH'; end if;
end $$;

-- Same as 004; tax / service charge are now expected on
-- (subtotal - discount - loyalty).
create or replace function public._sale_money_review(p_biz uuid, p_sale jsonb, p_payment jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  c_tol constant numeric := 0.02;
  v_s public.settings%rowtype; v_reasons text[] := '{}';
  v_after numeric; v_tax numeric; v_svc numeric; v_grand numeric;
  v_amt numeric; v_tend numeric; v_change numeric; v_method text;
begin
  select * into v_s from public.settings where business_id = p_biz;
  v_after := coalesce(public._to_num(p_sale->>'subtotal'), 0) - coalesce(public._to_num(p_sale->>'discount_amount'), 0)
             - coalesce(public._to_num(p_sale->>'loyalty_discount'), 0);
  v_tax := case when coalesce(v_s.tax_inclusive, false) then 0 else v_after * coalesce(v_s.tax_pct, 0) / 100 end;
  v_svc := v_after * coalesce(v_s.service_charge_pct, 0) / 100;
  if abs(coalesce(public._to_num(p_sale->>'tax_amount'), 0) - v_tax) > c_tol
     or abs(coalesce(public._to_num(p_sale->>'service_charge_amount'), 0) - v_svc) > c_tol then
    v_reasons := v_reasons || 'TAX_MISMATCH'::text;
  end if;
  v_grand := round(coalesce(public._to_num(p_sale->>'grand_total'), 0), 2);
  if jsonb_typeof(p_payment) is distinct from 'object' then
    if v_grand > c_tol then v_reasons := v_reasons || 'PAYMENT_MISMATCH'::text; end if;
  else
    v_amt := public._to_num(p_payment->>'amount');
    v_tend := public._to_num(p_payment->>'tendered');
    v_change := public._to_num(p_payment->>'change');
    v_method := upper(coalesce(p_payment->>'method', ''));
    if v_amt is null or v_amt < v_grand - c_tol
       or (v_method <> 'CASH' and v_amt > v_grand + c_tol)
       or (v_method = 'CASH' and v_tend is not null and v_tend < v_grand - c_tol)
       or (v_method = 'CASH' and coalesce(v_change, 0) > greatest(coalesce(v_tend, v_amt, 0), v_amt) - v_grand + c_tol) then
      v_reasons := v_reasons || 'PAYMENT_MISMATCH'::text;
    end if;
  end if;
  return nullif(array_to_string(v_reasons, ', '), '');
end $$;

-- Same as 004, plus loyalty_discount: a finished sale's money can't change.
create or replace function public._lock_finished_sale() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status in ('COMPLETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED')
     and (new.subtotal is distinct from old.subtotal
          or new.discount_type is distinct from old.discount_type
          or new.discount_value is distinct from old.discount_value
          or new.discount_amount is distinct from old.discount_amount
          or new.loyalty_discount is distinct from old.loyalty_discount
          or new.tax_amount is distinct from old.tax_amount
          or new.service_charge_amount is distinct from old.service_charge_amount
          or new.grand_total is distinct from old.grand_total
          or new.status is null or new.status = 'HELD') then
    raise exception 'SALE_LOCKED';
  end if;
  return new;
end $$;

-- Error codes a counter may see: same as 007, plus
--   REWARD_NOT_AVAILABLE   (the reward can't be used on this sale, see above)
--   REWARD_AMOUNT_MISMATCH (the counter's loyalty_discount is not the server's amount)
create or replace function public._fo_error_code(p_msg text) returns text
language sql immutable as $$
  select case when c = any(array['DEVICE_MISMATCH','SHIFT_NOT_FOUND','UNKNOWN_STAFF','ROLE_TOO_LOW','APPROVAL_REQUIRED',
      'APPROVAL_INVALID','BAD_SALE','BAD_SALE_STATUS','QR_ORDER_ALREADY_PAID','SALE_TOTALS_MISMATCH','UNKNOWN_RECIPE',
      'UNKNOWN_INGREDIENT','FORBIDDEN_ROW','BAD_REFUND','SALE_NOT_FOUND','SALE_NOT_REFUNDABLE','BAD_REFUND_TYPE','BAD_AMOUNT',
      'REFUND_TOO_LARGE','RETURN_TOO_LARGE','SALE_LOCKED','UNKNOWN_OP','BAD_OP','PIN_UPDATE_NEEDED',
      'AMOUNT_NOT_POSITIVE','REWARD_NOT_AVAILABLE','REWARD_AMOUNT_MISMATCH'])
    then c else 'SERVER_ERROR' end
  from (select substring(coalesce(p_msg, '') from '^[A-Z][A-Z_]+') as c) x
$$;

-- -----------------------------------------------------------------------------
-- D5. Apply ONE counter upload: same as 007, with the stamp-card reward on
-- 'sale' (marked "008"). Everything else (shifts, pay-ins, refunds,
-- approvals, stock lines, refund caps) is word-for-word the same as in 007.
-- -----------------------------------------------------------------------------
create or replace function public._fo_apply(p_biz uuid, p_dev public.devices, p_type text, p_d jsonb) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_sale jsonb; v_id uuid; v_old text; v_r jsonb; v_cust uuid; v_qr uuid; v_amount numeric;
  v_shift public.shifts%rowtype; v_ref jsonb; v_status text;
  v_appr public.staff; v_sale_row public.sales%rowtype; v_prev numeric; v_type text; v_new_status text;
  v_closer_name text; v_reason text; v_qo public.qr_orders%rowtype; v_performer uuid; v_performer_name text;
  v_signed uuid := public._signed_in_staff(p_dev.auth_user_id);   -- who signed in online on this counter (F8)
  v_limit numeric;
  v_rw jsonb; v_loy numeric := 0;   -- 008: loyalty reward on a sale
begin
  -- fo_sync only lets a paired counter call us with its own device row
  if p_dev.auth_user_id is distinct from auth.uid() then raise exception 'DEVICE_MISMATCH'; end if;
  -- Refund caps (section 8b) are checked right after each row here, so a counter
  -- action that breaks one fails on its own (the next actions still run).
  set constraints public.refunds_cap_check_ins, public.refunds_cap_check_upd, public.stock_cap_check_ins,
    public.stock_cap_check_upd, public.stock_cap_check_del, public.sales_cap_check_upd immediate;
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
      -- The manager closing it is the one doing it (so their own sign-in token works).
      v_appr := public._use_approval(p_biz, p_dev.auth_user_id, nullif(p_d->>'closed_by', '')::uuid,
                                     p_d->>'approval_token', 'shift_close:' || v_shift.id,
                                     nullif(p_d->>'closed_by', '')::uuid);
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
    -- 007: a pay-in / pay-out must be a real amount above ₱0. Missing, not a
    -- number, 0 or less -> AMOUNT_NOT_POSITIVE (before, the live rule
    -- "amount > 0" refused it with a database error, shown as SERVER_ERROR).
    if coalesce(public._to_num(p_d->>'amount'), 0) <= 0 then raise exception 'AMOUNT_NOT_POSITIVE'; end if;
    -- A pay-out above the shop's limit (settings.payout_review_limit, ₱1000 by
    -- default) is flagged for the owner to check (needs_review). Only the server sets it.
    select coalesce(payout_review_limit, 1000) into v_limit from public.settings where business_id = p_biz;
    perform public._write_row('cash_movements', p_d || jsonb_build_object('business_id', p_biz,
      'needs_review', upper(coalesce(p_d->>'type', '')) = 'PAY_OUT'
                      and coalesce(public._to_num(p_d->>'amount'), 0) > coalesce(v_limit, 1000)), 'id', 'nothing', p_biz);
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
    -- the same sale sent again (e.g. a retry after a lost answer): nothing to do
    if v_old in ('COMPLETED','VOIDED','REFUNDED','PARTIALLY_REFUNDED') then return 'skipped'; end if;
    perform public._require_staff(p_biz, (v_sale->>'cashier_id')::uuid, 1);
    -- A QR order is paid ONCE. If it is already linked to ANOTHER sale (paid at a
    -- second counter, or twice offline), this sale is refused: QR_ORDER_ALREADY_PAID.
    -- (Paying it again is fine only if that earlier sale was voided.)
    -- "for update" makes two counters paying the same order at once wait for each other.
    -- A QR order of another shop (or one that doesn't exist) is simply not linked.
    v_qr := nullif(v_sale->>'qr_order_id', '')::uuid;
    if v_qr is not null then
      select * into v_qo from public.qr_orders where id = v_qr and business_id = p_biz for update;
      if not found then
        v_sale := v_sale || jsonb_build_object('qr_order_id', null);
        v_qr := null;
      elsif v_status = 'COMPLETED' and v_qo.sale_id is not null and v_qo.sale_id <> v_id
            and exists (select 1 from public.sales where id = v_qo.sale_id and status <> 'VOIDED') then
        raise exception 'QR_ORDER_ALREADY_PAID';
      end if;
    end if;
    -- A finished sale with a discount needs a manager approval that the server checks.
    if v_status = 'COMPLETED' and coalesce((v_sale->>'discount_amount')::numeric, 0) > 0 then
      -- The one doing it = the sale's cashier: a manager's own sign-in token approves
      -- only a sale rung up by that manager; for anyone else's sale, the manager's PIN.
      v_appr := public._use_approval(p_biz, p_dev.auth_user_id, nullif(v_sale->>'discount_approved_by', '')::uuid,
                                     p_d->>'discount_approval_token', 'discount:' || v_id,
                                     nullif(v_sale->>'cashier_id', '')::uuid);
      v_sale := v_sale || jsonb_build_object('discount_approved_by', v_appr.id, 'discount_approved_by_name', v_appr.name);
    end if;
    -- 008: a stamp-card reward used on this sale (data.sale.loyalty_reward =
    -- {customer_id, card_no, milestone, recipe_id}). Only a FINISHED sale uses
    -- one; the server checks it and works out its amount (_loyalty_reward_amount,
    -- else REWARD_NOT_AVAILABLE). The counter's sale.loyalty_discount must be that
    -- amount (else REWARD_AMOUNT_MISMATCH). Without a reward, loyalty_discount = 0.
    v_rw := v_sale->'loyalty_reward';
    v_sale := v_sale - 'loyalty_reward';
    if v_status = 'COMPLETED' and jsonb_typeof(v_rw) = 'object' then
      v_loy := public._loyalty_reward_amount(p_biz, v_id, v_sale, p_d->'items', v_rw);
      if public._to_num(v_sale->>'loyalty_discount') is null
         or abs(public._to_num(v_sale->>'loyalty_discount') - v_loy) > 0.02 then
        raise exception 'REWARD_AMOUNT_MISMATCH';
      end if;
    else
      v_rw := null;
    end if;
    v_sale := v_sale || jsonb_build_object('loyalty_discount', v_loy);
    -- 008 (M1): the server notes when it received a finished sale; the counter
    -- can't set it. A HELD sale gets none yet.
    v_sale := (v_sale - 'received_at') || case when v_status = 'COMPLETED'
                                                then jsonb_build_object('received_at', now()) else '{}'::jsonb end;
    -- A finished sale must add up (else SALE_TOTALS_MISMATCH). It is FLAGGED for
    -- review (not refused) when: sold below the menu (PRICE_BELOW_MENU /
    -- NOT_ON_MENU), tax / service charge differ from the settings (TAX_MISMATCH),
    -- the payment doesn't cover it (PAYMENT_MISMATCH), or its cashier is not the
    -- person the server knows signed in on this counter (STAFF_MISMATCH).
    -- Only the server sets the review flag and signed_in_staff_id.
    if v_status = 'COMPLETED' then
      perform public._check_sale_totals(v_sale, p_d->'items');
      v_reason := nullif(concat_ws(', ',
        public._sale_review_reason(p_biz, p_d->'items'),
        public._sale_money_review(p_biz, v_sale, p_d->'payment'),
        -- 008 (M1): a sale dated more than 1 hour in the future is flagged
        case when public._to_ts(v_sale->>'transaction_date') > now() + interval '1 hour' then 'FUTURE_DATE' end,
        case when v_signed is null or v_signed is distinct from nullif(v_sale->>'cashier_id', '')::uuid
             then 'STAFF_MISMATCH' end), '');
    end if;
    v_sale := v_sale || jsonb_build_object('needs_review', v_reason is not null, 'review_reason', v_reason,
                                           'signed_in_staff_id', v_signed);
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
      -- 008: remember the reward as used (once per reward: a second sale using
      -- the same one -> REWARD_NOT_AVAILABLE)
      if v_rw is not null then
        begin
          insert into public.loyalty_redemptions(business_id, customer_id, card_no, milestone, reward_type, recipe_id, sale_id, amount)
            values (p_biz, public._to_uuid(v_rw->>'customer_id'), (v_rw->>'card_no')::int, (v_rw->>'milestone')::int,
                    (select r->>'type' from jsonb_array_elements(public._loyalty_config(p_biz)->'rewards') r
                      where (r->>'stamp')::int = (v_rw->>'milestone')::int limit 1),
                    case when public._to_uuid(v_rw->>'recipe_id') is not null
                          and exists (select 1 from jsonb_array_elements(public._loyalty_config(p_biz)->'rewards') r
                                      where (r->>'stamp')::int = (v_rw->>'milestone')::int and r->>'type' = 'FREE_ITEM')
                          and exists (select 1 from public.recipes where id = public._to_uuid(v_rw->>'recipe_id') and business_id = p_biz)
                         then public._to_uuid(v_rw->>'recipe_id') end,
                    v_id, v_loy);
        exception when unique_violation then
          raise exception 'REWARD_NOT_AVAILABLE';
        end;
      end if;
      if v_qr is not null then
        update public.qr_orders
          set sale_id = v_id, paid_at = case when sale_id = v_id then coalesce(paid_at, now()) else now() end,
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
    -- data = {refund:{id, sale_id, type, amount, items, approved_by, performed_by, ...},
    --         inventory:[...], approval_token: '...'}
    --   performed_by = the staff member signed in on the counter who does the refund.
    --   (sale_status is worked out here, not taken from the counter)
    v_ref := p_d->'refund';
    if jsonb_typeof(v_ref) is distinct from 'object' then raise exception 'BAD_REFUND'; end if;
    -- Only the owner's Back Office may mark a refund as imported old-app history.
    v_ref := v_ref - 'imported_at' - 'performed_by_name';
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
    -- Who does it (optional with a typed manager PIN; needed with a sign-in token).
    v_performer := nullif(v_ref->>'performed_by', '')::uuid;
    if v_performer is not null then
      perform public._require_staff(p_biz, v_performer, 1);
      select name into v_performer_name from public.staff where id = v_performer;
    end if;
    -- Manager approval, checked by the server (and used up if it is a one-time token).
    -- A manager's own sign-in token works only when that manager does the refund.
    v_appr := public._use_approval(p_biz, p_dev.auth_user_id, nullif(v_ref->>'approved_by', '')::uuid,
                                   p_d->>'approval_token', 'refund:' || v_id, v_performer);
    -- Money cap: no more than what is left of the sale (1 centavo rounding allowed).
    v_amount := (v_ref->>'amount')::numeric;
    if v_amount is null or v_amount < 0 then raise exception 'BAD_AMOUNT'; end if;
    select round(coalesce(sum(greatest(amount, 0)), 0), 2) into v_prev from public.refunds where sale_id = v_sale_row.id;
    if v_amount > round(greatest(coalesce(v_sale_row.grand_total, 0) - v_prev, 0), 2) + 0.01 then raise exception 'REFUND_TOO_LARGE'; end if;
    -- Flag (not refuse) a refund whose performed_by is not the person the server
    -- knows signed in on this counter: STAFF_MISMATCH.
    v_reason := case when v_signed is null or v_signed is distinct from v_performer then 'STAFF_MISMATCH' end;
    perform public._write_row('refunds', v_ref || jsonb_build_object('business_id', p_biz, 'sale_id', v_sale_row.id,
      'amount', v_amount, 'approved_by', v_appr.id, 'approved_by_name', v_appr.name,
      'performed_by', v_performer, 'performed_by_name', v_performer_name,
      'signed_in_staff_id', v_signed, 'needs_review', v_reason is not null, 'review_reason', v_reason), 'id', 'error', p_biz);
    -- A refund that lists items gives back at most what the customer paid for
    -- them (after the discount, with tax / service charge): REFUND_TOO_LARGE.
    -- Same rule as the Back Office (section 8b). VOID / FULL_REFUND of everything
    -- = the whole amount left; a refund without items is capped only by that.
    perform public._check_refund(v_id);
    -- Stock put back: inserted only (never overwrites another row) ...
    for v_r in select value from jsonb_array_elements(coalesce(p_d->'inventory', '[]'::jsonb)) loop
      perform public._require_ingredient(p_biz, v_r);
      perform public._write_row('inventory_transactions', v_r || jsonb_build_object('business_id', p_biz,
        'reference_id', v_id::text, 'transaction_type', 'SALE_REVERSAL'), 'id', 'error', p_biz);
    end loop;
    -- ... and, per ingredient, all refunds of this sale together can't put back
    -- more than this sale took out (RETURN_TOO_LARGE).
    perform public._check_sale_returns(v_sale_row.id);
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
    perform public._write_row('audit_log', p_d || jsonb_build_object('business_id', p_biz, 'signed_in_staff_id', v_signed), 'id', 'nothing', p_biz);
    return 'ok';

  when 'sold_out' then
    update public.recipes set sold_out = coalesce((p_d->>'sold_out')::boolean, false), updated_at = now()
      where id = (p_d->>'recipe_id')::uuid and business_id = p_biz;
    return 'ok';

  else
    raise exception 'UNKNOWN_OP: %', p_type;
  end case;
end $$;

-- =============================================================================
-- Row Level Security for the new tables
-- =============================================================================
--   floor_shapes:      everyone of the shop reads (counters show the plan);
--                      only the owner's email login changes (through apply_changes).
--   ingredient_brands: office data: only the owner's email login (rank 3)
--                      reads; a paired counter reads nothing. Owner changes.
--   loyalty_redemptions: customer data, like customers: only the owner's
--                      login reads directly (counters get reward status from
--                      fo_customer_list / fo_customer_detail). Counters add
--                      rows only through fo_sync.
do $$
declare t text; p record;
begin
  foreach t in array array['floor_shapes', 'ingredient_brands', 'loyalty_redemptions'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    if t = 'ingredient_brands' then
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_read', t);
    elsif t = 'loyalty_redemptions' then
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_read', t);
    else
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()))', t || '_read', t);
    end if;
    execute format('create policy %I on public.%I for insert to authenticated with check (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_admin_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3) with check (business_id = (select public.current_business_id()))', t || '_admin_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_admin_delete', t);
  end loop;
end $$;

-- Counters can't read table QR codes (lead decision 2026-10-29). A table's QR
-- code (qr_token) lets anyone order as that table, so only the owner's email
-- login (rank 3) reads dining_tables directly (Back Office, bo_bootstrap). A paired
-- counter (DEVICE login, rank 0) gets the tables WITHOUT qr_token from
-- fo_floor_plan() / fo_bootstrap(). The QR page finds its table by token
-- inside its own functions (_qr_table), which this rule doesn't affect.
-- Writing stays owner-only (004's rules are kept).
drop policy if exists dining_tables_read on public.dining_tables;
create policy dining_tables_read on public.dining_tables for select to authenticated
  using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3);

-- Tables the Back Office may write through apply_changes: same as 004, plus
-- ingredient_brands, floor_shapes and loyalty_redemptions (backup / import).
create or replace function public._writable_tables() returns text[]
language sql immutable as $$
  select array['categories','suppliers','ingredients','recipes','recipe_ingredients','purchases','production_batches',
    'waste','inventory_transactions','settings','stores','dining_tables','staff','devices','customers','sales',
    'sale_items','payments','refunds','shifts','cash_movements','audit_log','qr_orders','businesses',
    'ingredient_brands','floor_shapes','loyalty_redemptions']
$$;

-- =============================================================================
-- A3. The floor plan for counters
-- =============================================================================
-- (An earlier test copy of this script had a helper _table_for_counter: removed.
-- The QR code is now left out right where the tables are read.)
drop function if exists public._table_for_counter(public.dining_tables);

-- Returns {tables:[...], shapes:[...]} for the caller's shop. tables = every
-- dining table (active or not) with its plan columns and NO qr_token; shapes =
-- floor_shapes rows. Callers: any login of the shop (a paired counter, the
-- owner). Customers (no shop login) get NOT_A_MEMBER.
-- This is how a counter reads the tables: since 008 it can't read the
-- dining_tables table itself (see "Counters can't read table QR codes" below).
create or replace function public.fo_floor_plan() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public.current_business_id();
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  return jsonb_build_object(
    'tables', coalesce((select jsonb_agg(to_jsonb(x) - 'qr_token' order by x.sort_order, x.label)
                        from public.dining_tables x where x.business_id = v_biz), '[]'::jsonb),
    'shapes', coalesce((select jsonb_agg(to_jsonb(f) order by f.sort_order, f.created_at)
                        from public.floor_shapes f where f.business_id = v_biz), '[]'::jsonb));
end $$;

-- Counter start-up data: same as 004, except
--   * 'tables' comes from fo_floor_plan(): no QR codes (qr_token), and
--   * new 'floor_shapes' (the floor plan's other shapes).
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
    -- the highest receipt / shift numbers this counter has used this year
    'next_numbers', case when v_dev.id is null then null else jsonb_build_object(
      'year', extract(year from now())::int,
      'pos', coalesce((select max(nullif(regexp_replace(split_part(transaction_number, '-', 4), '\D', '', 'g'), '')::int)
                       from public.sales where business_id = v_biz
                         and transaction_number like 'POS-' || v_dev.device_tag || '-' || extract(year from now())::int || '-%'), 0),
      'shift', coalesce((select max(nullif(regexp_replace(split_part(shift_number, '-', 4), '\D', '', 'g'), '')::int)
                         from public.shifts where business_id = v_biz
                           and shift_number like 'SHIFT-' || v_dev.device_tag || '-' || extract(year from now())::int || '-%'), 0)) end,
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
    -- tables + shapes through fo_floor_plan (a counter can't read dining_tables itself)
    'tables', public.fo_floor_plan()->'tables',
    'floor_shapes', public.fo_floor_plan()->'shapes',
    'qr_orders', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.qr_orders x
                           where x.business_id = v_biz and (x.status in ('PENDING','PREPARING','READY')
                             or x.updated_at > now() - interval '3 hours')), '[]'::jsonb)
  );
end $$;

-- Back Office start-up data: same as 004, plus
--   floor_shapes      = the floor plan's other shapes
--   ingredient_brands = every brand of every ingredient
--   brand_stock       = stock per brand, first in first out (see _brand_stock_json)
-- (ingredient_brands / brand_stock are empty for a counter login.)
create or replace function public.bo_bootstrap() returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v_biz uuid := public.current_business_id(); v_upd uuid[];
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  select coalesce(array_agg(x), '{}') into v_upd from public.staff_pin_update_needed() x;
  return jsonb_build_object(
    'server_time', now(),
    'is_owner', public.is_owner(),
    'pin_update_needed', to_jsonb(v_upd),
    'pin_lockouts', coalesce((select jsonb_agg(jsonb_build_object('device_id', e.device_id, 'device_name', e.device_name,
                        'locked_at', e.locked_at, 'locked_until', e.locked_until) order by e.locked_at desc)
                      from (select * from public.pin_lock_events
                            where business_id = v_biz and locked_at > now() - interval '7 days'
                            order by locked_at desc limit 100) e), '[]'::jsonb),
    'rank', public.app_rank(),
    'business', (select to_jsonb(b) from public.businesses b where b.id = v_biz),
    'settings', (select to_jsonb(s) from public.settings s where s.business_id = v_biz),
    'staff', coalesce((select jsonb_agg(to_jsonb(st) || jsonb_build_object('has_pin', st.id in (select public.staff_pin_ids()),
                                                                          'pin_update_needed', st.id = any(v_upd)) order by st.name)
                       from public.staff st where st.business_id = v_biz), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(to_jsonb(x)) from public.categories x where x.business_id = v_biz), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(to_jsonb(x)) from public.suppliers x where x.business_id = v_biz), '[]'::jsonb),
    'ingredients', coalesce((select jsonb_agg(to_jsonb(x)) from public.ingredients x where x.business_id = v_biz), '[]'::jsonb),
    'ingredient_brands', coalesce((select jsonb_agg(to_jsonb(x) order by x.ingredient_id, x.sort_order, x.name)
                                   from public.ingredient_brands x where x.business_id = v_biz), '[]'::jsonb),
    'brand_stock', case when public.app_rank() >= 3 then public.ingredient_brand_stock(null) else '[]'::jsonb end,
    'recipes', coalesce((select jsonb_agg(to_jsonb(x)) from public.recipes x where x.business_id = v_biz), '[]'::jsonb),
    'recipe_ingredients', coalesce((select jsonb_agg(to_jsonb(x)) from public.recipe_ingredients x where x.business_id = v_biz), '[]'::jsonb),
    'purchases', coalesce((select jsonb_agg(to_jsonb(x)) from public.purchases x where x.business_id = v_biz), '[]'::jsonb),
    'production_batches', coalesce((select jsonb_agg(to_jsonb(x)) from public.production_batches x where x.business_id = v_biz), '[]'::jsonb),
    'waste', coalesce((select jsonb_agg(to_jsonb(x)) from public.waste x where x.business_id = v_biz), '[]'::jsonb),
    'stock', coalesce((select jsonb_agg(jsonb_build_object('ingredient_id', v.ingredient_id, 'stock', v.stock))
                       from public.v_ingredient_stock v where v.business_id = v_biz), '[]'::jsonb),
    'tables', coalesce((select jsonb_agg(to_jsonb(x) order by x.sort_order, x.label) from public.dining_tables x where x.business_id = v_biz), '[]'::jsonb),
    'floor_shapes', coalesce((select jsonb_agg(to_jsonb(f) order by f.sort_order, f.created_at) from public.floor_shapes f where f.business_id = v_biz), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(to_jsonb(x) order by x.device_tag) from public.devices x where x.business_id = v_biz), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(to_jsonb(x)) from public.stores x where x.business_id = v_biz), '[]'::jsonb),
    'open_qr_orders', (select count(*) from public.qr_orders where business_id = v_biz and status in ('PENDING','PREPARING','READY')),
    'customer_count', (select count(*) from public.customers where business_id = v_biz and merged_into is null)
  );
end $$;

-- Everything needed for sales reports / the calendar, for a time range.
-- Same as 004, plus 'totals' (008; see below). The sales rows also carry the
-- new loyalty_discount and received_at columns.
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
                           where x.business_id = v_biz and x.created_at >= p_from and x.created_at < p_to), '[]'::jsonb),
    -- 008: money totals of the range, worked out here so every report adds up the same way.
    -- Counted: the range's sales except HELD and VOIDED (a void's reward is given back,
    -- so it counts nowhere). For these sales:
    --   item_sales - discounts - loyalty_rewards + tax + service_charge = sales
    -- (each to the centavo; sums of the sales' own saved amounts). refunds = what the
    -- non-voided refunds of these sales gave back; net_sales = sales - refunds.
    'totals', (select jsonb_build_object(
                 'sale_count', count(*),
                 'item_sales', round(coalesce(sum(x.subtotal), 0), 2),
                 'discounts', round(coalesce(sum(x.discount_amount), 0), 2),
                 'loyalty_rewards', round(coalesce(sum(x.loyalty_discount), 0), 2),
                 'loyalty_reward_count', count(*) filter (where coalesce(x.loyalty_discount, 0) > 0),
                 'tax', round(coalesce(sum(x.tax_amount), 0), 2),
                 'service_charge', round(coalesce(sum(x.service_charge_amount), 0), 2),
                 'sales', round(coalesce(sum(x.grand_total), 0), 2),
                 'refunds', round(coalesce((select sum(greatest(r.amount, 0)) from public.refunds r
                                            where r.business_id = v_biz and r.type <> 'VOID'
                                              and r.sale_id = any(array_agg(x.id))), 0), 2),
                 'net_sales', round(coalesce(sum(x.grand_total), 0)
                                    - coalesce((select sum(greatest(r.amount, 0)) from public.refunds r
                                                where r.business_id = v_biz and r.type <> 'VOID'
                                                  and r.sale_id = any(array_agg(x.id))), 0), 2))
               from public.sales x where x.id = any(v_sale_ids) and x.status <> 'VOIDED')
  );
end $$;

-- =============================================================================
-- D2. What the QR page shows a customer
-- =============================================================================
-- Same fields as 004 (id, nickname, phone_hint, visit_count, stamps,
-- first_seen_at), now worked out from the sales, plus the stamp card:
--   visit_count = days with a paid sale; stamps = total_stamps (all ever)
--   total_stamps, drink_stamps_earned, food_stamps_earned,
--   card {card_size, card_no, stamps_on_card, milestones [{stamp, type, amount, label, status}]},
--   ready_rewards [{card_no, stamp, type, amount, label}], loyalty_rewards (the shop's card settings)
create or replace function public._qr_customer_json(p_c public.customers) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if p_c.id is null then return null; end if;
  v := public._loyalty_summary(p_c.business_id, p_c.id);
  return jsonb_build_object(
    'id', p_c.id, 'nickname', p_c.nickname,
    'phone_hint', case when p_c.phone is null then null else '•••• ' || right(p_c.phone, 3) end,
    'visit_count', v->'visits', 'stamps', v->'total_stamps',
    'total_stamps', v->'total_stamps', 'drink_stamps_earned', v->'drink_stamps_earned', 'food_stamps_earned', v->'food_stamps_earned',
    'card', v->'card', 'ready_rewards', v->'ready_rewards',
    'loyalty_rewards', public._loyalty_config(p_c.business_id),
    'first_seen_at', p_c.first_seen_at);
end $$;

-- Public menu for a table QR code: same as 004, plus loyalty_rewards (the
-- stamp card settings) and theme.theme ('CCCC' = ignore the saved colours,
-- use the brand design; 'CUSTOM' = use them).
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
      'text_color', v_s.text_color, 'theme', coalesce(v_s.theme, 'CCCC')),
    'table', jsonb_build_object('label', v_t.label, 'kind', v_t.kind),
    'ordering_enabled', coalesce(v_s.qr_ordering_enabled, true),
    'welcome_message', v_s.qr_welcome_message,
    'payment_note', v_s.qr_payment_note,
    'tax_pct', coalesce(v_s.tax_pct, 0), 'service_charge_pct', coalesce(v_s.service_charge_pct, 0),
    'tax_inclusive', coalesce(v_s.tax_inclusive, false),
    'loyalty_enabled', coalesce(v_s.loyalty_enabled, false), 'stamps_per_reward', v_s.stamps_per_reward,
    'loyalty_rewards', public._loyalty_config(v_t.business_id),
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

-- =============================================================================
-- E. COUNTER CUSTOMERS TAB
-- =============================================================================
-- Is the caller a paired, switched-on counter of this shop?
create or replace function public._is_active_counter(p_biz uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'DEVICE' and p.business_id = p_biz)
     and exists (select 1 from public.devices d where d.auth_user_id = auth.uid() and d.business_id = p_biz and d.active)
$$;

-- May this counter show MONEY (totals spent, order totals)? Only with the
-- LOGIN token (staff_pin_login 'LOGIN') of the staff member CURRENTLY signed in
-- on this counter login (its latest sign-in, not ended, not expired, at most
-- 24 hours old), and that person must be an active MANAGER / ADMIN of this
-- shop (security review M2). OVERRIDE approval tokens are NOT accepted, so
-- viewing never involves an approval token. Nothing is used up.
-- A manager / admin whose PIN is shorter than 6 digits gets no money view
-- (security decision 8). Returns 'OK', or why not: null (no token sent),
-- 'APPROVAL_INVALID', 'ROLE_TOO_LOW' or 'PIN_UPDATE_NEEDED'.
create or replace function public._money_view_check(p_biz uuid, p_token text) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_sess public.staff_sessions%rowtype; v_s public.staff%rowtype; v_latest uuid;
begin
  if coalesce(btrim(p_token), '') = '' then return null; end if;
  select * into v_sess from public.staff_sessions
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  select id into v_latest from public.staff_sessions
    where device_user_id = auth.uid() and purpose = 'LOGIN' order by created_at desc limit 1;
  if v_sess.id is null
     or v_sess.purpose <> 'LOGIN'
     or v_sess.id is distinct from v_latest
     or v_sess.business_id <> p_biz
     or v_sess.device_user_id is distinct from auth.uid()
     or v_sess.revoked_at is not null
     or v_sess.expires_at <= now()
     or v_sess.created_at < now() - interval '24 hours' then
    return 'APPROVAL_INVALID';
  end if;
  select * into v_s from public.staff where id = v_sess.staff_id and business_id = p_biz;
  if not found or not v_s.active then return 'APPROVAL_INVALID'; end if;
  if public._role_rank(v_s.role) < 2 then return 'ROLE_TOO_LOW'; end if;
  if coalesce((select pin_length from public.staff_pins where staff_id = v_s.id), 0) < public._min_pin_length(v_s.role) then
    return 'PIN_UPDATE_NEEDED';
  end if;
  return 'OK';
end $$;

-- Each customers-tab call is counted: at most 120 per hour per counter login
-- (so nobody can copy the whole customer list quickly). Returns true when the
-- call is allowed (and records it).
create or replace function public._customer_view_allowed(p_subject uuid) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if (select count(*) from public.auth_attempts
      where subject = p_subject and kind = 'CUSTOMER_VIEW' and at > now() - interval '1 hour') >= 120 then
    return false;
  end if;
  insert into public.auth_attempts(subject, kind, success) values (p_subject, 'CUSTOMER_VIEW', true);
  return true;
end $$;

-- One customer as the counter's customers tab shows them. Phone ALWAYS masked
-- (security decision 5); no notes. total_spent only when p_money.
--   total_spent = what they paid for finished sales minus what was given back
--   (voided sales count 0).
create or replace function public._counter_customer_json(p_c public.customers, p_money boolean) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l jsonb := public._loyalty_summary(p_c.business_id, p_c.id); v jsonb;
begin
  v := jsonb_build_object(
    'id', p_c.id, 'nickname', p_c.nickname,
    'phone', public._mask_phone(p_c.phone), 'phone_masked', p_c.phone is not null,
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

-- Counter: list customers, newest visit first, optionally only nicknames
-- containing p_search (NOT phone numbers: that could tell whether a number is
-- registered, security decision 7). p_limit 1..50 (default 30).
-- p_staff_token: the signed-in manager / admin's LOGIN token (see _money_view_check) to also get
-- total_spent. Returns
--   {customers:[{id, nickname, phone (masked), phone_masked, visits, last_visit_at, first_seen_at,
--                total_stamps, drink_stamps_earned, food_stamps_earned, card, ready_rewards
--                (as in _loyalty_summary), total_spent (manager only)}],
--    show_money: true|false, money_refused: null|'APPROVAL_INVALID'|'ROLE_TOO_LOW'|'PIN_UPDATE_NEEDED',
--    loyalty_enabled, loyalty_rewards}
-- or {error:'TOO_MANY_ATTEMPTS'}. Only a paired counter may call it.
create or replace function public.fo_customer_list(p_search text default '', p_limit integer default 30, p_staff_token text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_biz uuid := public.current_business_id();
  v_q text := left(btrim(coalesce(p_search, '')), 30);
  v_pat text;
  v_lim integer := least(greatest(coalesce(p_limit, 30), 1), 50);
  v_money_chk text; v_money boolean; v_s public.settings%rowtype;
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  if not public._is_active_counter(v_biz) then raise exception 'NOT_ALLOWED'; end if;
  if not public._customer_view_allowed(auth.uid()) then return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS'); end if;
  v_money_chk := public._money_view_check(v_biz, p_staff_token);
  v_money := coalesce(v_money_chk = 'OK', false);
  select * into v_s from public.settings where business_id = v_biz;
  -- % and _ typed by staff are plain characters, not wildcards
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return jsonb_build_object(
    'customers', coalesce((
      select jsonb_agg(public._counter_customer_json(c.x, v_money) order by c.ord desc nulls last, (c.x).nickname)
      from (select x, coalesce(x.last_order_at, x.last_seen_at) as ord from public.customers x
            where x.business_id = v_biz and x.merged_into is null
              and (v_q = '' or x.nickname ilike v_pat)
            order by coalesce(x.last_order_at, x.last_seen_at) desc nulls last, x.nickname
            limit v_lim) c), '[]'::jsonb),
    'show_money', v_money,
    'money_refused', case when v_money then null else v_money_chk end,
    'loyalty_enabled', coalesce(v_s.loyalty_enabled, false),
    'loyalty_rewards', public._loyalty_config(v_biz));
end $$;

-- Counter: one customer's card. Returns
--   {customer:{...same as in fo_customer_list...},
--    favourites:[{recipe_id, name, count}]       top 5 by how many they bought
--                                                (finished sales, minus items given back)
--    recent_orders:[{sale_id, order_number, qr_order_number, transaction_date, status, source,
--                    items:[{name, quantity, refunded_quantity}],
--                    grand_total, refunded (manager only)}]   last 20, newest first
--    show_money, money_refused, loyalty_enabled, loyalty_rewards}
-- or {error:'NOT_FOUND'} (not this shop's, merged away, or deleted) or
-- {error:'TOO_MANY_ATTEMPTS'}. No peso amounts at all without a manager token.
create or replace function public.fo_customer_detail(p_customer_id uuid, p_staff_token text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_biz uuid := public.current_business_id();
  v_c public.customers%rowtype; v_money_chk text; v_money boolean; v_s public.settings%rowtype;
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  if not public._is_active_counter(v_biz) then raise exception 'NOT_ALLOWED'; end if;
  if not public._customer_view_allowed(auth.uid()) then return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS'); end if;
  select * into v_c from public.customers where id = p_customer_id and business_id = v_biz and merged_into is null;
  if not found then return jsonb_build_object('error', 'NOT_FOUND'); end if;
  v_money_chk := public._money_view_check(v_biz, p_staff_token);
  v_money := coalesce(v_money_chk = 'OK', false);
  select * into v_s from public.settings where business_id = v_biz;
  return jsonb_build_object(
    'customer', public._counter_customer_json(v_c, v_money),
    'favourites', coalesce((
      select jsonb_agg(jsonb_build_object('recipe_id', f.recipe_id, 'name', f.name, 'count', f.cnt) order by f.cnt desc, f.name)
      from (select si.recipe_id, coalesce(max(r.name), max(si.name)) as name,
                   sum(greatest(coalesce(si.quantity, 0) - public._sale_item_refunded_qty(s.id, si.id), 0)) as cnt
            from public.sales s
            join public.sale_items si on si.sale_id = s.id and si.business_id = v_biz
            left join public.recipes r on r.id = si.recipe_id and r.business_id = v_biz
            where s.business_id = v_biz and s.customer_id = v_c.id and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED')
              and si.recipe_id is not null
            group by si.recipe_id
            having sum(greatest(coalesce(si.quantity, 0) - public._sale_item_refunded_qty(s.id, si.id), 0)) > 0
            order by 3 desc, 2
            limit 5) f), '[]'::jsonb),
    'recent_orders', coalesce((
      select jsonb_agg(o.j order by o.at desc)
      from (select coalesce(s.transaction_date, s.created_at) as at,
                   jsonb_build_object(
                     'sale_id', s.id, 'order_number', s.transaction_number,
                     'qr_order_number', (select q.order_number from public.qr_orders q where q.id = s.qr_order_id and q.business_id = v_biz),
                     'transaction_date', coalesce(s.transaction_date, s.created_at), 'status', s.status, 'source', s.source,
                     'reward', (select jsonb_build_object('card_no', x.card_no, 'milestone', x.milestone, 'type', x.reward_type,
                                                          'released', x.released_at is not null)
                                from public.loyalty_redemptions x where x.sale_id = s.id and x.merged_from is null
                                order by x.created_at desc limit 1),
                     'items', coalesce((select jsonb_agg(jsonb_build_object('name', si.name, 'quantity', si.quantity,
                                                     'refunded_quantity', public._sale_item_refunded_qty(s.id, si.id))
                                                     order by si.created_at, si.id)
                                        from public.sale_items si where si.sale_id = s.id and si.business_id = v_biz), '[]'::jsonb))
                   || case when v_money then jsonb_build_object(
                        'grand_total', s.grand_total, 'loyalty_discount', s.loyalty_discount,
                        'refunded', (select round(coalesce(sum(greatest(r.amount, 0)), 0), 2) from public.refunds r where r.sale_id = s.id))
                      else '{}'::jsonb end as j
            from public.sales s
            where s.business_id = v_biz and s.customer_id = v_c.id and s.status <> 'HELD'
            order by coalesce(s.transaction_date, s.created_at) desc
            limit 20) o), '[]'::jsonb),
    'show_money', v_money,
    'money_refused', case when v_money then null else v_money_chk end,
    'loyalty_enabled', coalesce(v_s.loyalty_enabled, false),
    'loyalty_rewards', public._loyalty_config(v_biz));
end $$;

-- =============================================================================
-- Who may call the new / re-made functions
-- =============================================================================
-- New functions get "anyone may run it" by default, so every function this
-- script makes is first locked, then opened only where meant:
--   logged-in users (each checks the caller's shop / role itself):
--     fo_floor_plan, ingredient_brand_stock, fo_customer_list, fo_customer_detail,
--     fo_bootstrap, bo_bootstrap (as in 004)
--   anyone with a table QR code: get_qr_menu (as in 004)
--   everything else here is internal (no API access).
do $$
declare f record;
  mine text[] := array['_tile_color_keys','_valid_subcategory_colors','_valid_loyalty_rewards','_loyalty_config',
    '_loyalty_summary','_loyalty_reward_amount','_release_reward_trigger','_merge_rewards_trigger','_check_sale_totals',
    '_sale_money_review','_lock_finished_sale','_fo_error_code','_fo_apply','_settings_check','_brand_line_check','_brand_in_use_check',
    '_brand_lots','_brand_stock_json','ingredient_brand_stock','_sale_item_refunded_qty','_customer_loyalty',
    '_refresh_customer_loyalty','_loyalty_note','_loyalty_pending_run','_to_num','_to_ts','sales_report','_writable_tables','fo_floor_plan','fo_bootstrap',
    'bo_bootstrap','_qr_customer_json','get_qr_menu','_is_active_counter','_money_view_check','_customer_view_allowed',
    '_counter_customer_json','fo_customer_list','fo_customer_detail'];
  member_fns text[] := array['sales_report','fo_floor_plan','ingredient_brand_stock','fo_customer_list','fo_customer_detail','fo_bootstrap','bo_bootstrap'];
  public_fns text[] := array['get_qr_menu'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any(mine)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any(public_fns) then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif f.proname = any(member_fns) then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- =============================================================================
-- One-time fill: work out every existing customer's visits and stamps from
-- their sales (the old visit_count counted every sale; now it is days).
-- Safe to run again: it gives the same numbers.
-- =============================================================================
do $$
declare r record;
begin
  for r in select id from public.customers where merged_into is null loop
    perform public._refresh_customer_loyalty(r.id);
  end loop;
end $$;

commit;

-- Tell the API about the new tables / columns / functions right away.
notify pgrst, 'reload schema';
