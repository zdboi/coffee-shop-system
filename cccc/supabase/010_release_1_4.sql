-- =============================================================================
-- Cavite City Coffee Club — 010: release 1.4 ("Menu & inventory", Wave 2)
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004 … 009 (all already done). It is safe to run more than
-- once. It runs inside one transaction: if anything fails, nothing is changed.
--
-- What it adds, in plain words:
--   A12. MERGE INGREDIENTS (owner only): pick ingredients of the same kind
--        (e.g. "Arla milk" and "Laciate milk"), name the general one ("Full
--        Cream Milk"); each picked ingredient becomes a BRAND of it and keeps
--        its purchases and stock (kg / g and L / mL are converted). Every
--        recipe line, option extra / swap, production recipe line, stock line
--        and open QR order is pointed at the general ingredient. A preview
--        shows everything first; the merge is all-or-nothing.
--   A10. "WEIGHS" for house-made (produced) items: e.g. 1 mL of caramel sauce
--        weighs 1.25 g. Recipe lines and option extras can then be typed in
--        grams OR millilitres; the stock stays in the item's own unit and the
--        database converts.
--   A9.  OPTION LIBRARY: shared option groups (Hot / Iced, take-away cup, extra
--        shot, non-dairy swap) applied to recipe types / sub-categories, with
--        per-item untick (or tick-on). The database copies them into each
--        recipe's options automatically, so the counter, the QR page and the
--        server's price checks see them like any other option. New option
--        kind SWAP: takes the item's own amount of one ingredient off and puts
--        the same amount of another on (one extra price for all). An option can
--        take several ingredients off stock (e.g. a cup AND a lid).
--   A8.  SUPPLIED ITEMS: buy-and-resell food / pastries saved in one go
--        (save_supplied_item): a menu item + its stock item counted in pieces
--        (one piece per sale) + optional restock purchase.
--   A15. COUNTER WASTE LOG: a new counter upload type 'waste' (menu items with
--        options, or single ingredients; quantity; reason). The server takes
--        the stock off like a sale and records what it cost. Complimentary
--        needs a manager's approval (checked like a discount). Back Office
--        report: waste_report(from, to).
--   A11. EXPENSES: an ingredient category can be marked as an EXPENSE category
--        ("Operating supplies"): its items are not stock (buying them is an
--        expense). New table expenses (supplies, rent, utilities, internet,
--        wages, repairs, other). Owner-only monthly report
--        net_income_report(month) = sales − ingredients used − expenses.
--
-- What it does NOT change: prices, refunds, refund caps, approvals, PIN rules,
-- stamps, the QR limits. Every change is ADDED, so the 1.3 apps keep working
-- (see "Old apps" notes in docs/handoff/contract-1.4.md).
-- ONE live allowed-words rule is widened: sync_operations.operation_type
-- gets the new upload kind 'waste' (section 7, same method as 006). The other
-- new value written to an old column, stock line type 'WASTE', is already
-- allowed by the live rule.
-- =============================================================================

begin;

-- =============================================================================
-- 0. UNITS: one place that converts amounts (same rules as logic.js)
-- =============================================================================
-- Unit "families": g / kg are weights, mL / L are volumes, anything else
-- (pcs, box, pack...) is a count that only matches itself.
create or replace function public._unit_family(p_unit text) returns text
language sql immutable as $$
  select case lower(btrim(coalesce(p_unit, '')))
    when 'g' then 'weight' when 'kg' then 'weight'
    when 'ml' then 'volume' when 'l' then 'volume'
    else 'count' end
$$;

-- How many of the family's small unit one unit is (kg = 1000 g, L = 1000 mL).
-- Count units: 1.
create or replace function public._unit_factor(p_unit text) returns numeric
language sql immutable as $$
  select case lower(btrim(coalesce(p_unit, '')))
    when 'kg' then 1000 when 'l' then 1000 else 1 end::numeric
$$;

-- An amount typed in p_unit, converted to the stock unit p_base.
--   * same unit (or no unit typed)          -> unchanged
--   * same family (g <-> kg, mL <-> L)      -> converted
--   * grams <-> millilitres                 -> only through "weighs"
--     (p_g_per_ml = how many grams 1 mL weighs, see A10)
--   * anything else                         -> null (the caller says BAD_UNIT)
-- Rounded to 6 decimals, like logic.js (_unitRound).
create or replace function public._to_base_qty(p_qty numeric, p_unit text, p_base text, p_g_per_ml numeric default null)
returns numeric language plpgsql immutable as $$
declare u text := lower(btrim(coalesce(nullif(btrim(p_unit), ''), p_base, ''))); b text := lower(btrim(coalesce(p_base, '')));
        fu text := public._unit_family(u); fb text := public._unit_family(b);
begin
  if p_qty is null then return null; end if;
  if u = b then return p_qty; end if;
  if fu = fb and fu <> 'count' then
    return round(p_qty * public._unit_factor(u) / public._unit_factor(b), 6);
  end if;
  if coalesce(p_g_per_ml, 0) > 0 then
    if fu = 'weight' and fb = 'volume' then
      return round(p_qty * public._unit_factor(u) / p_g_per_ml / public._unit_factor(b), 6);
    elsif fu = 'volume' and fb = 'weight' then
      return round(p_qty * public._unit_factor(u) * p_g_per_ml / public._unit_factor(b), 6);
    end if;
  end if;
  return null;
end $$;

-- =============================================================================
-- 1. NEW COLUMNS on existing tables (all additive, all empty to start with)
-- =============================================================================
-- A10: how many grams ONE millilitre of a house-made item weighs (1 L of
-- caramel = 1,250 g -> 1.25). Empty = not weighed. Produced items only.
alter table public.ingredients add column if not exists weight_g_per_ml numeric;
-- A12: an ingredient that was merged into another one: which one, and when.
-- It stays (switched off) so old offline counters can still upload sales that
-- name it: the server sends those amounts to the general ingredient.
alter table public.ingredients add column if not exists merged_into uuid;
alter table public.ingredients add column if not exists merged_at timestamptz;
-- A8: "price paid per piece" typed on the supplied-item form; used as the cost
-- only while the item has no purchases yet.
alter table public.ingredients add column if not exists standard_cost numeric;
-- A10 (+ owner request #3): the amount AS TYPED, in recipe_ingredients.unit.
-- When it is filled, the database works out quantity (stock unit) from it,
-- also again later if the item's "weighs" changes. Empty (old apps) = the
-- app already sent quantity in the stock unit, as before.
alter table public.recipe_ingredients add column if not exists entered_quantity numeric;
-- A8: a supplied (buy-and-resell) menu item: its stock item, counted in pieces.
alter table public.recipes add column if not exists supplied_ingredient_id uuid;
-- A11: 'STOCK' (normal) or 'EXPENSE' (operating supplies: not counted as stock).
alter table public.categories add column if not exists kind text not null default 'STOCK';

create index if not exists ingredients_merged_into_idx on public.ingredients(merged_into) where merged_into is not null;
create index if not exists recipes_supplied_idx on public.recipes(supplied_ingredient_id) where supplied_ingredient_id is not null;

-- Links (they also make apply_changes check that they stay inside the shop).
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ingredients'::regclass and conname = 'ingredients_merged_into_fk') then
    alter table public.ingredients add constraint ingredients_merged_into_fk
      foreign key (merged_into) references public.ingredients(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.recipes'::regclass and conname = 'recipes_supplied_ingredient_fk') then
    alter table public.recipes add constraint recipes_supplied_ingredient_fk
      foreign key (supplied_ingredient_id) references public.ingredients(id) on delete set null;
  end if;
end $$;

-- Allowed values for the NEW columns (none existed on live, so no stored
-- value can break; re-made on every run).
do $$
declare spec text[];
  specs text[][] := array[
    array['ingredients', 'ingredients_weight_g_per_ml_check', $c$weight_g_per_ml is null or (weight_g_per_ml > 0 and weight_g_per_ml <= 10)$c$],
    array['ingredients', 'ingredients_standard_cost_check',   $c$standard_cost is null or (standard_cost >= 0 and standard_cost <= 1000000)$c$],
    array['ingredients', 'ingredients_merged_into_check',     $c$merged_into is null or merged_into <> id$c$],
    array['recipe_ingredients', 'recipe_ingredients_entered_quantity_check', $c$entered_quantity is null or (entered_quantity >= 0 and entered_quantity <= 1000000)$c$],
    array['categories', 'categories_kind_check',              $c$kind in ('STOCK','EXPENSE')$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
end $$;

-- =============================================================================
-- 2. A10 "WEIGHS" + amounts typed in any unit
-- =============================================================================
-- Ingredient rules (clear answers instead of database errors):
--   WEIGHS_PRODUCED_ONLY = "weighs" is only for house-made items (owner
--                          decision 2026-11-02: bought liquids stay in mL)
--   WEIGHS_BAD_UNIT      = "weighs" needs an item counted in g, kg, mL or L
--   SUPPLIED_NEEDS_PCS   = the stock item of a supplied menu item must stay
--                          counted in pieces
create or replace function public._ingredient_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.weight_g_per_ml is not null then
    if not coalesce(new.is_produced_item, false) then raise exception 'WEIGHS_PRODUCED_ONLY'; end if;
    if public._unit_family(new.base_unit) = 'count' then raise exception 'WEIGHS_BAD_UNIT'; end if;
  end if;
  if tg_op = 'UPDATE' and new.base_unit is distinct from old.base_unit
     and exists (select 1 from public.recipes where supplied_ingredient_id = new.id)
     and lower(btrim(coalesce(new.base_unit, ''))) <> 'pcs' then
    raise exception 'SUPPLIED_NEEDS_PCS';
  end if;
  return new;
end $$;
drop trigger if exists ingredients_check on public.ingredients;
create trigger ingredients_check before insert or update on public.ingredients
  for each row execute function public._ingredient_check();

-- A recipe line typed in another unit (entered_quantity + unit): the database
-- works out quantity in the ingredient's stock unit (g <-> kg, mL <-> L, and
-- g <-> mL through "weighs"). A unit that can't be converted -> BAD_UNIT.
create or replace function public._recipe_line_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ing public.ingredients%rowtype; v_q numeric;
begin
  if new.entered_quantity is null then return new; end if;
  select * into v_ing from public.ingredients where id = new.ingredient_id;
  if not found then return new; end if;            -- the foreign key answers
  v_q := public._to_base_qty(new.entered_quantity, new.unit, v_ing.base_unit, v_ing.weight_g_per_ml);
  if v_q is null then raise exception 'BAD_UNIT'; end if;
  new.quantity := v_q;
  return new;
end $$;
drop trigger if exists recipe_ingredients_check on public.recipe_ingredients;
create trigger recipe_ingredients_check before insert or update on public.recipe_ingredients
  for each row execute function public._recipe_line_check();

-- When an ingredient's stock unit or "weighs" changes, every amount typed in
-- another unit is converted again: recipe lines (above) and option extras
-- (the recipes' options are rebuilt, see section 3).
create or replace function public._ingredient_units_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.recipe_ingredients set entered_quantity = entered_quantity
    where ingredient_id = new.id and entered_quantity is not null;
  update public.option_groups set options = options
    where business_id = new.business_id and options::text like '%' || new.id::text || '%';
  update public.recipes set modifier_groups = modifier_groups
    where business_id = new.business_id and modifier_groups::text like '%' || new.id::text || '%';
  return null;
end $$;

-- =============================================================================
-- 3. A9 OPTION LIBRARY
-- =============================================================================
-- One row per shared option group, e.g. "Hot / Iced".
--   applies_to = {"recipe_types": ["DRINKS"], "subcategories": ["Iced coffee"]}
--                (the group is on every item of these types OR sub-categories)
--   options    = [{id, label, price_delta, kind, extras, swap_from_ingredient_id,
--                  swap_to_ingredient_id}], see _valid_library_options below.
create table if not exists public.option_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  name text not null,
  required boolean not null default false,
  multi_select boolean not null default false,
  options jsonb not null default '[]'::jsonb,
  applies_to jsonb not null default '{"recipe_types": [], "subcategories": []}'::jsonb,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists option_groups_business_idx on public.option_groups(business_id);

-- Per item: 'EXCLUDE' = untick the group on this item; 'INCLUDE' = tick it on
-- for an item outside the group's types / sub-categories.
create table if not exists public.option_group_recipes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  group_id uuid not null references public.option_groups(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  mode text not null default 'EXCLUDE',
  created_at timestamptz not null default now()
);
create unique index if not exists option_group_recipes_key on public.option_group_recipes(group_id, recipe_id);
create index if not exists option_group_recipes_recipe_idx on public.option_group_recipes(recipe_id);

do $$
declare spec text[];
  specs text[][] := array[
    array['option_groups', 'option_groups_name_check', $c$length(btrim(name)) between 1 and 40$c$],
    array['option_group_recipes', 'option_group_recipes_mode_check', $c$mode in ('EXCLUDE','INCLUDE')$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
end $$;

-- Checks one library group. Returns null when fine, else the reason (the
-- trigger answers BAD_OPTION_GROUP: <reason>). Rules:
--   applies_to: {recipe_types: [DRINKS|SAUCES_SYRUPS|PASTRY|FOOD...],
--                subcategories: [text 1..40, at most 100]}
--   options: 1..30, each an object with
--     id      text 1..64, unique in the group
--     label   text 1..40, unique in the group (upper / lower case ignored)
--     price_delta  number, -100000..100000 (a SWAP: 0 or more)
--     kind    'PLAIN' (price only, the default), 'EXTRA' (takes extra stock) or 'SWAP'
--     extras  (PLAIN / EXTRA) at most 5 of {ingredient_id, quantity} or
--             {ingredient_id, entered_quantity, unit}: stock taken per item
--             (quantity in the ingredient's stock unit; entered_quantity in unit)
--     swap_from_ingredient_id, swap_to_ingredient_id (SWAP only, both needed,
--             different, both this shop's ingredients)
create or replace function public._library_group_problem(p_biz uuid, p_options jsonb, p_applies jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare o jsonb; e jsonb; v_ids text[] := '{}'; v_labels text[] := '{}'; v_kind text; v_p numeric;
begin
  if jsonb_typeof(p_applies) is distinct from 'object' then return 'applies_to'; end if;
  if jsonb_typeof(coalesce(p_applies->'recipe_types', '[]')) <> 'array'
     or jsonb_typeof(coalesce(p_applies->'subcategories', '[]')) <> 'array' then return 'applies_to'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_applies->'recipe_types', '[]')) t
             where jsonb_typeof(t) <> 'string' or (t #>> '{}') not in ('DRINKS','SAUCES_SYRUPS','PASTRY','FOOD')) then
    return 'recipe_types';
  end if;
  if jsonb_array_length(coalesce(p_applies->'subcategories', '[]')) > 100
     or exists (select 1 from jsonb_array_elements(coalesce(p_applies->'subcategories', '[]')) t
                where jsonb_typeof(t) <> 'string' or length(btrim(t #>> '{}')) not between 1 and 40) then
    return 'subcategories';
  end if;
  if jsonb_typeof(p_options) is distinct from 'array' or jsonb_array_length(p_options) not between 1 and 30 then return 'options'; end if;
  for o in select value from jsonb_array_elements(p_options) loop
    if jsonb_typeof(o) <> 'object' then return 'option'; end if;
    if length(coalesce(o->>'id', '')) not between 1 and 64 or (o->>'id') = any(v_ids) then return 'option id'; end if;
    v_ids := v_ids || (o->>'id');
    if length(btrim(coalesce(o->>'label', ''))) not between 1 and 40 or lower(btrim(o->>'label')) = any(v_labels) then return 'option label'; end if;
    v_labels := v_labels || lower(btrim(o->>'label'));
    v_p := public._to_num(coalesce(o->>'price_delta', '0'));
    if v_p is null or v_p < -100000 or v_p > 100000 then return 'price_delta'; end if;
    v_kind := upper(coalesce(o->>'kind', 'PLAIN'));
    if v_kind not in ('PLAIN', 'EXTRA', 'SWAP') then return 'kind'; end if;
    if v_kind = 'SWAP' then
      if v_p < 0 then return 'price_delta'; end if;
      if public._to_uuid(o->>'swap_from_ingredient_id') is null or public._to_uuid(o->>'swap_to_ingredient_id') is null
         or o->>'swap_from_ingredient_id' = o->>'swap_to_ingredient_id' then return 'swap'; end if;
      if (select count(*) from public.ingredients where business_id = p_biz
            and id in (public._to_uuid(o->>'swap_from_ingredient_id'), public._to_uuid(o->>'swap_to_ingredient_id'))) <> 2 then
        return 'swap';
      end if;
    else
      if o ? 'extras' then
        if jsonb_typeof(o->'extras') <> 'array' or jsonb_array_length(o->'extras') > 5 then return 'extras'; end if;
        for e in select value from jsonb_array_elements(o->'extras') loop
          if jsonb_typeof(e) <> 'object'
             or not exists (select 1 from public.ingredients where id = public._to_uuid(e->>'ingredient_id') and business_id = p_biz)
             or coalesce(public._to_num(coalesce(e->>'entered_quantity', e->>'quantity')), 0) <= 0
             or coalesce(public._to_num(coalesce(e->>'entered_quantity', e->>'quantity')), 0) > 1000000 then
            return 'extras';
          end if;
        end loop;
      end if;
    end if;
  end loop;
  return null;
end $$;

create or replace function public._option_group_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_problem text;
begin
  new.name := btrim(new.name);
  v_problem := public._library_group_problem(new.business_id, new.options, new.applies_to);
  if v_problem is not null then raise exception 'BAD_OPTION_GROUP: %', v_problem; end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;
drop trigger if exists option_groups_check on public.option_groups;
create trigger option_groups_check before insert or update on public.option_groups
  for each row execute function public._option_group_check();

-- A per-item tick must be the same shop's group and recipe (else FORBIDDEN_ROW).
create or replace function public._option_group_recipe_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.option_groups where id = new.group_id and business_id = new.business_id)
     or not exists (select 1 from public.recipes where id = new.recipe_id and business_id = new.business_id) then
    raise exception 'FORBIDDEN_ROW';
  end if;
  return new;
end $$;
drop trigger if exists option_group_recipes_check on public.option_group_recipes;
create trigger option_group_recipes_check before insert or update on public.option_group_recipes
  for each row execute function public._option_group_recipe_check();

-- The stock an option takes per item, as [{ingredient_id, quantity}] in each
-- ingredient's stock unit. From "extras" when the option has them (an amount
-- typed with a unit is converted here), else from the old single pair
-- ingredient_id + ingredient_qty_delta. Lines that can't be read are left out.
create or replace function public._option_extras(p_biz uuid, p_option jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when jsonb_typeof(p_option->'extras') = 'array' then coalesce((
      select jsonb_agg(jsonb_build_object('ingredient_id', i.id,
                       'quantity', case when e ? 'entered_quantity'
                                        then public._to_base_qty(public._to_num(e->>'entered_quantity'), e->>'unit', i.base_unit, i.weight_g_per_ml)
                                        else public._to_num(e->>'quantity') end)
                       || case when e ? 'entered_quantity' then jsonb_build_object('entered_quantity', e->'entered_quantity', 'unit', e->'unit')
                               else '{}'::jsonb end
                       order by x.ord)
      from jsonb_array_elements(p_option->'extras') with ordinality x(e, ord)
      join public.ingredients i on i.id = public._to_uuid(e->>'ingredient_id') and i.business_id = p_biz
      where coalesce(case when e ? 'entered_quantity'
                          then public._to_base_qty(public._to_num(e->>'entered_quantity'), e->>'unit', i.base_unit, i.weight_g_per_ml)
                          else public._to_num(e->>'quantity') end, 0) > 0), '[]'::jsonb)
    when public._to_uuid(p_option->>'ingredient_id') is not null
         and coalesce(public._to_num(p_option->>'ingredient_qty_delta'), 0) <> 0 then
      jsonb_build_array(jsonb_build_object('ingredient_id', p_option->>'ingredient_id',
                                           'quantity', public._to_num(p_option->>'ingredient_qty_delta')))
    else '[]'::jsonb end
$$;

-- The library groups that apply to ONE recipe, in the shape of
-- recipes.modifier_groups (so every app and the server's checks read them like
-- the recipe's own groups):
--   {id: 'lib_<group id>', library_group_id, name, required, multi_select,
--    options: [{id, label, price_delta, kind,
--               ingredient_id, ingredient_qty_delta,   (the first extra, for old apps)
--               extras:  [{ingredient_id, quantity}],  (stock taken per item)
--               removes: [{ingredient_id, quantity}],  (SWAP: stock NOT taken per item)
--               swap_from_ingredient_id, swap_to_ingredient_id (SWAP)}]}
-- A group applies when it is active and: the item ticks it on (INCLUDE), or the
-- item's type / sub-category is in applies_to and the item doesn't untick it
-- (EXCLUDE). Production recipes (house-made sauces) never get library groups
-- unless ticked on.
-- SWAP on one item: takes off what THIS recipe uses of swap_from (all its
-- lines of it together) and puts on the same amount of swap_to (converted to
-- swap_to's stock unit). A recipe that doesn't use swap_from (or whose amount
-- can't be converted) doesn't get that option. The swap carries no stock for
-- old 1.3 counters (ingredient_id empty): they deduct the recipe as if no swap.
-- A group left with no options for an item is left out for that item.
-- (The id uses '_' not ':' because qr_place_order keeps 'group:option' pairs.)
create or replace function public._library_groups_for(p_r public.recipes) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g public.option_groups%rowtype; o jsonb; v_out jsonb := '[]'::jsonb; v_opts jsonb; v_kind text;
        v_mode text; v_applies boolean; v_amt numeric; v_to numeric; v_x public.ingredients%rowtype; v_y public.ingredients%rowtype;
        v_extras jsonb;
begin
  if p_r.id is null then return '[]'::jsonb; end if;
  for g in select * from public.option_groups where business_id = p_r.business_id and active order by sort_order, lower(name), id loop
    select mode into v_mode from public.option_group_recipes where group_id = g.id and recipe_id = p_r.id;
    v_applies := case
      when v_mode = 'INCLUDE' then true
      when v_mode = 'EXCLUDE' then false
      when coalesce(p_r.is_production_recipe, false) then false
      else exists (select 1 from jsonb_array_elements_text(coalesce(g.applies_to->'recipe_types', '[]')) t
                   where t = coalesce(p_r.recipe_type, 'DRINKS'))
        or exists (select 1 from jsonb_array_elements_text(coalesce(g.applies_to->'subcategories', '[]')) t
                   where lower(btrim(t)) = lower(btrim(coalesce(p_r.category, ''))) and btrim(coalesce(p_r.category, '')) <> '')
    end;
    if not v_applies then continue; end if;
    v_opts := '[]'::jsonb;
    for o in select value from jsonb_array_elements(g.options) loop
      v_kind := upper(coalesce(o->>'kind', 'PLAIN'));
      if v_kind = 'SWAP' then
        select * into v_x from public.ingredients where id = public._to_uuid(o->>'swap_from_ingredient_id') and business_id = p_r.business_id;
        select * into v_y from public.ingredients where id = public._to_uuid(o->>'swap_to_ingredient_id') and business_id = p_r.business_id;
        select sum(quantity) into v_amt from public.recipe_ingredients where recipe_id = p_r.id and ingredient_id = v_x.id and quantity > 0;
        v_to := public._to_base_qty(v_amt, v_x.base_unit, v_y.base_unit, coalesce(v_y.weight_g_per_ml, v_x.weight_g_per_ml));
        if v_x.id is null or v_y.id is null or coalesce(v_amt, 0) <= 0 or coalesce(v_to, 0) <= 0 then continue; end if;
        v_opts := v_opts || jsonb_build_array(jsonb_build_object(
          'id', o->>'id', 'label', btrim(o->>'label'), 'price_delta', coalesce(public._to_num(o->>'price_delta'), 0),
          'kind', 'SWAP', 'ingredient_id', null, 'ingredient_qty_delta', 0,
          'extras', jsonb_build_array(jsonb_build_object('ingredient_id', v_y.id, 'quantity', v_to)),
          'removes', jsonb_build_array(jsonb_build_object('ingredient_id', v_x.id, 'quantity', v_amt)),
          'swap_from_ingredient_id', v_x.id, 'swap_to_ingredient_id', v_y.id));
      else
        v_extras := public._option_extras(p_r.business_id, o);
        v_opts := v_opts || jsonb_build_array(jsonb_build_object(
          'id', o->>'id', 'label', btrim(o->>'label'), 'price_delta', coalesce(public._to_num(o->>'price_delta'), 0),
          'kind', case when jsonb_array_length(v_extras) > 0 then 'EXTRA' else 'PLAIN' end,
          'ingredient_id', v_extras->0->'ingredient_id',
          'ingredient_qty_delta', coalesce(v_extras->0->'quantity', '0'::jsonb),
          'extras', v_extras, 'removes', '[]'::jsonb));
      end if;
    end loop;
    if jsonb_array_length(v_opts) = 0 then continue; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', 'lib_' || g.id, 'library_group_id', g.id, 'name', g.name,
      'required', g.required, 'multi_select', g.multi_select, 'options', v_opts));
  end loop;
  return v_out;
end $$;

-- Every save of a recipe rebuilds its options = the library groups that apply
-- (first, in library order) + the recipe's OWN groups. Groups that came from the
-- library (id 'lib_...' or a library_group_id) are never kept from what the app
-- sent: they are made again from the library. Own groups are kept as sent,
-- except that an option with "extras" gets its first extra copied into
-- ingredient_id / ingredient_qty_delta (for the 1.3 counter) and amounts typed
-- with a unit converted. When nothing changes, the recipe is left exactly as it is.
create or replace function public._recipe_options_build() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_own jsonb; v_new jsonb;
begin
  select coalesce(jsonb_agg(
           case when jsonb_typeof(g->'options') = 'array'
                     and exists (select 1 from jsonb_array_elements(g->'options') o where jsonb_typeof(o->'extras') = 'array')
                then g || jsonb_build_object('options', (
                       select jsonb_agg(case when jsonb_typeof(o->'extras') = 'array'
                                             then o || jsonb_build_object('extras', public._option_extras(new.business_id, o))
                                                    || jsonb_build_object(
                                                         'ingredient_id', public._option_extras(new.business_id, o)->0->'ingredient_id',
                                                         'ingredient_qty_delta', coalesce(public._option_extras(new.business_id, o)->0->'quantity', '0'::jsonb))
                                             else o end order by x.ord)
                       from jsonb_array_elements(g->'options') with ordinality x(o, ord)))
                else g end
           order by y.ord), '[]'::jsonb)
    into v_own
  from jsonb_array_elements(case when jsonb_typeof(new.modifier_groups) = 'array' then new.modifier_groups else '[]'::jsonb end)
       with ordinality y(g, ord)
  where not (coalesce(g->>'id', '') like 'lib\_%' or g ? 'library_group_id');
  v_new := public._library_groups_for(new) || v_own;
  -- keep "no options" exactly as the app stored it (null / '[]')
  if v_new = '[]'::jsonb and (new.modifier_groups is null or jsonb_typeof(new.modifier_groups) <> 'array') then
    return new;
  end if;
  if v_new is distinct from new.modifier_groups then
    new.modifier_groups := v_new;
    if tg_op = 'UPDATE' and v_new is distinct from old.modifier_groups then new.updated_at := now(); end if;
  end if;
  return new;
end $$;
drop trigger if exists recipes_options_build on public.recipes;
create trigger recipes_options_build before insert or update on public.recipes
  for each row execute function public._recipe_options_build();

-- Rebuild the options of the recipes concerned when the library changes,
-- when an item is ticked / unticked, or when a recipe's lines change (a
-- swap uses the recipe's own amount).
create or replace function public._library_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'option_groups' then
    update public.recipes set modifier_groups = modifier_groups
      where business_id = coalesce(new.business_id, old.business_id);
  elsif tg_table_name = 'option_group_recipes' then
    update public.recipes set modifier_groups = modifier_groups
      where id in (new.recipe_id, old.recipe_id);
  elsif tg_table_name = 'recipe_ingredients' then
    if exists (select 1 from public.option_groups where business_id = coalesce(new.business_id, old.business_id) and active) then
      update public.recipes set modifier_groups = modifier_groups
        where id in (new.recipe_id, old.recipe_id);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists option_groups_changed on public.option_groups;
create trigger option_groups_changed after insert or update or delete on public.option_groups
  for each row execute function public._library_changed();
drop trigger if exists option_group_recipes_changed on public.option_group_recipes;
create trigger option_group_recipes_changed after insert or update or delete on public.option_group_recipes
  for each row execute function public._library_changed();
drop trigger if exists recipe_ingredients_library on public.recipe_ingredients;
create trigger recipe_ingredients_library after insert or update or delete on public.recipe_ingredients
  for each row execute function public._library_changed();

-- (section 2) "weighs" / stock unit changed -> convert typed amounts again
drop trigger if exists ingredients_units_changed on public.ingredients;
create trigger ingredients_units_changed after update on public.ingredients
  for each row when (old.weight_g_per_ml is distinct from new.weight_g_per_ml or old.base_unit is distinct from new.base_unit)
  execute function public._ingredient_units_changed();

-- The QR page's view of options: same as 004, plus each option's kind
-- (PLAIN / EXTRA / SWAP) so the page can say "swap". Never the stock amounts.
create or replace function public._public_modifier_groups(p_groups jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', g->>'id', 'name', g->>'name',
      'required', coalesce((g->>'required')::boolean, false),
      'multi_select', coalesce((g->>'multi_select')::boolean, false),
      'options', (select coalesce(jsonb_agg(jsonb_build_object('id', o->>'id', 'label', o->>'label',
                      'price_delta', coalesce((o->>'price_delta')::numeric, 0),
                      'kind', coalesce(o->>'kind', 'PLAIN'))), '[]'::jsonb)
                  from jsonb_array_elements(case when jsonb_typeof(g->'options') = 'array' then g->'options' else '[]'::jsonb end) o))), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_groups) = 'array' then p_groups else '[]'::jsonb end) g
$$;

-- =============================================================================
-- 4. STOCK HELPERS (merged ingredients, operating supplies, recipe stock, cost)
-- =============================================================================
-- Where an ingredient's stock lives now: itself, or (after a merge) the
-- ingredient it was merged into (followed up to 10 steps), with the number to
-- multiply its amounts by (e.g. merged from kg into g -> 1000). No row when the
-- ingredient isn't one of shop p_biz's.
create or replace function public._merge_target(p_biz uuid, p_id uuid)
returns table(id uuid, factor numeric) language plpgsql stable security definer set search_path = public as $$
declare v_id uuid := p_id; v_f numeric := 1; v_row public.ingredients%rowtype; v_next text; i integer := 0;
begin
  if p_id is null then return; end if;
  loop
    select * into v_row from public.ingredients x where x.id = v_id and x.business_id = p_biz;
    if not found then return; end if;
    exit when v_row.merged_into is null or i >= 10;
    select x.base_unit into v_next from public.ingredients x where x.id = v_row.merged_into and x.business_id = p_biz;
    if not found then exit; end if;
    v_f := v_f * public._unit_factor(v_row.base_unit) / public._unit_factor(v_next);
    v_id := v_row.merged_into; i := i + 1;
  end loop;
  id := v_id; factor := v_f;
  return next;
end $$;

-- The ingredient row where p_id's stock lives now (see above); all fields
-- empty when p_id is not one of the shop's ingredients.
create or replace function public._ingredient_final(p_biz uuid, p_id uuid) returns public.ingredients
language sql stable security definer set search_path = public as $$
  select i.* from public._merge_target(p_biz, p_id) t join public.ingredients i on i.id = t.id
$$;

-- True when the ingredient is an operating supply (its category is an
-- EXPENSE category): it is never counted as stock.
create or replace function public._is_expense_item(p_ingredient uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ingredients i join public.categories c on c.id = i.category_id
                 where i.id = p_ingredient and c.kind = 'EXPENSE')
$$;

-- A counter's stock lines, cleaned before they are saved:
--   * a line of a MERGED ingredient goes to the general ingredient, its amount
--     converted (an old offline counter may still name the old one);
--   * a line of an operating supply is left out (not stock);
--   * everything else is unchanged (an unknown ingredient stays, so the usual
--     UNKNOWN_INGREDIENT answer still comes).
create or replace function public._clean_stock_lines(p_biz uuid, p jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(
           case when t.id is null or t.id = public._to_uuid(l->>'ingredient_id') then l
                else l || jsonb_build_object('ingredient_id', t.id,
                                             'quantity', round(public._to_num(l->>'quantity') * t.factor, 6)) end
           order by x.ord), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) with ordinality x(l, ord)
  left join lateral public._merge_target(p_biz, public._to_uuid(l->>'ingredient_id')) t on true
  where not public._is_expense_item(coalesce(t.id, public._to_uuid(l->>'ingredient_id')))
$$;

-- The stock that p_qty of a recipe with these options takes off, worked out by
-- the SERVER from the recipe as it is now (same rule as inventoryLinesForSaleLine
-- in logic.js): the recipe's lines x p_qty, plus each chosen option's extras
-- x p_qty, minus each chosen option's removes x p_qty (a swap), summed per
-- ingredient; only amounts above 0 are kept. Returns [{ingredient_id, quantity}].
-- A chosen option is found on the recipe's options by group_id + option_id,
-- or by group name + label (the shape of sale_items.modifiers). An option that
-- is no longer on the menu takes nothing.
create or replace function public._recipe_stock_lines(p_biz uuid, p_recipe uuid, p_qty numeric, p_mods jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  with r as (select * from public.recipes where id = p_recipe and business_id = p_biz),
  sel as (select m from jsonb_array_elements(case when jsonb_typeof(p_mods) = 'array' then p_mods else '[]'::jsonb end) m
          where jsonb_typeof(m) = 'object'),
  opt as (
    select (select o from r,
                   jsonb_array_elements(case when jsonb_typeof(r.modifier_groups) = 'array' then r.modifier_groups else '[]'::jsonb end) g,
                   jsonb_array_elements(case when jsonb_typeof(g->'options') = 'array' then g->'options' else '[]'::jsonb end) o
            where (g->>'id' = s.m->>'group_id' and o->>'id' = s.m->>'option_id')
               or (g->>'name' = s.m->>'group' and o->>'label' = s.m->>'label')
            order by (g->>'id' = s.m->>'group_id' and o->>'id' = s.m->>'option_id') desc nulls last
            limit 1) as o
    from sel s),
  lines as (
    select ri.ingredient_id, ri.quantity * p_qty as q
      from public.recipe_ingredients ri join r on r.id = ri.recipe_id
      where ri.quantity > 0
    union all
    select public._to_uuid(e->>'ingredient_id'), public._to_num(e->>'quantity') * p_qty
      from opt, jsonb_array_elements(public._option_extras(p_biz, opt.o)) e
      where opt.o is not null
    union all
    select public._to_uuid(e->>'ingredient_id'), -public._to_num(e->>'quantity') * p_qty
      from opt, jsonb_array_elements(case when jsonb_typeof(opt.o->'removes') = 'array' then opt.o->'removes' else '[]'::jsonb end) e
      where opt.o is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('ingredient_id', s.ingredient_id, 'quantity', s.q) order by s.ingredient_id), '[]'::jsonb)
  from (select ingredient_id, round(sum(q), 6) as q from lines where ingredient_id is not null and q is not null
        group by ingredient_id having round(sum(q), 6) > 0) s
$$;

-- What ONE stock unit of an ingredient cost, as of a day (for waste and the
-- monthly report). Same idea as the Back Office's costing:
--   bought items:    the shop's costing method over purchases up to that day:
--                    'latest' = the last purchase's price per unit; otherwise
--                    the weighted average (money spent / units bought).
--                    No purchases yet -> standard_cost (typed on a supplied
--                    item), else 0.
--   house-made items: the production recipe's cost / its expected yield; when
--                    there is no usable recipe, the production batches'
--                    weighted average up to that day; else 0.
-- (The Back Office screens may show the cost of the brand "in use"; reports use
-- these averages so a month is costed the same way every time it is opened.)
create or replace function public._ingredient_unit_cost(p_biz uuid, p_ingredient uuid, p_as_of date, p_depth integer default 0)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare v_i public.ingredients%rowtype; v_r public.recipes%rowtype; v_c numeric; v_method text;
begin
  select * into v_i from public.ingredients where id = p_ingredient and business_id = p_biz;
  if not found then return 0; end if;
  if coalesce(v_i.is_produced_item, false) then
    if p_depth < 5 then
      select * into v_r from public.recipes
        where business_id = p_biz and coalesce(expected_yield, 0) > 0
          and (id = v_i.source_recipe_id or (produced_ingredient_id = v_i.id and coalesce(is_production_recipe, false)))
        order by (id = v_i.source_recipe_id) desc limit 1;
      if found then
        select coalesce(sum(ri.quantity * public._ingredient_unit_cost(p_biz, ri.ingredient_id, p_as_of, p_depth + 1)), 0) / v_r.expected_yield
          into v_c from public.recipe_ingredients ri where ri.recipe_id = v_r.id and ri.quantity > 0;
        return coalesce(v_c, 0);
      end if;
    end if;
    select sum(coalesce(raw_cost_total, 0)) / nullif(sum(coalesce(actual_yield, 0)), 0) into v_c
      from public.production_batches
      where business_id = p_biz and produced_ingredient_id = v_i.id and (production_date is null or production_date <= p_as_of);
    return coalesce(v_c, 0);
  end if;
  select costing_method into v_method from public.settings where business_id = p_biz;
  if v_method = 'latest' then
    select price_per_base_unit into v_c from public.purchases
      where business_id = p_biz and ingredient_id = v_i.id and purchase_date <= p_as_of and price_per_base_unit is not null
      order by purchase_date desc, created_at desc limit 1;
  else
    select coalesce(sum(coalesce(total_price, 0)) / nullif(sum(coalesce(base_quantity, 0)), 0),
                    (array_agg(price_per_base_unit order by purchase_date desc, created_at desc))[1])
      into v_c from public.purchases
      where business_id = p_biz and ingredient_id = v_i.id and purchase_date <= p_as_of;
  end if;
  return coalesce(v_c, v_i.standard_cost, 0);
end $$;

-- =============================================================================
-- 5. A11 OPERATING SUPPLIES + EXPENSES
-- =============================================================================
-- Items in an EXPENSE category are not stock: buying them is an expense (the
-- Back Office writes an expenses row), so a purchase of one, or stock added by
-- hand / as starting stock, is refused -> EXPENSE_ITEM_NOT_STOCK. (Taking old
-- stock OFF, e.g. setting it to 0 after moving an item into the category, is
-- still allowed.) Counter sales / refunds / waste simply leave such lines out
-- (_clean_stock_lines).
create or replace function public._expense_item_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'inventory_transactions' then
    if not (new.transaction_type in ('PURCHASE', 'INITIAL_STOCK', 'PRODUCTION')
            or (new.transaction_type = 'ADJUSTMENT' and new.quantity > 0)) then
      return new;
    end if;
  end if;
  if public._is_expense_item(new.ingredient_id) then raise exception 'EXPENSE_ITEM_NOT_STOCK'; end if;
  return new;
end $$;
drop trigger if exists purchases_expense_check on public.purchases;
create trigger purchases_expense_check before insert on public.purchases
  for each row execute function public._expense_item_check();
drop trigger if exists inventory_tx_expense_check on public.inventory_transactions;
create trigger inventory_tx_expense_check before insert on public.inventory_transactions
  for each row execute function public._expense_item_check();

-- Every existing shop gets the category "Operating supplies" (kind EXPENSE),
-- once. The owner can rename it or add more in the category manager.
insert into public.categories (business_id, name, kind)
select b.id, 'Operating supplies', 'EXPENSE' from public.businesses b
where not exists (select 1 from public.categories c where c.business_id = b.id and lower(btrim(c.name)) = 'operating supplies');
update public.categories set kind = 'EXPENSE' where lower(btrim(name)) = 'operating supplies' and kind <> 'EXPENSE';

-- The expenses log (owner only). One row per cost:
--   category    SUPPLIES (operating supplies bought), RENT, UTILITIES (power,
--               water), INTERNET, WAGES (a simple amount, not payroll),
--               REPAIRS, OTHER
--   amount      pesos, above 0
--   ingredient_id / quantity / unit / supplier_id: optional, for a supplies
--               purchase (which item, how many, from whom)
--   photo_path  optional receipt photo in the private storage bucket
--               'expense-photos' (path "<business id>/<file>")
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.current_business_id() references public.businesses(id) on delete cascade,
  expense_date date not null,
  category text not null default 'OTHER',
  amount numeric not null,
  note text,
  photo_path text,
  ingredient_id uuid references public.ingredients(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  quantity numeric,
  unit text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists expenses_business_date_idx on public.expenses(business_id, expense_date);
do $$
declare spec text[];
  specs text[][] := array[
    array['expenses', 'expenses_category_check', $c$category in ('SUPPLIES','RENT','UTILITIES','INTERNET','WAGES','REPAIRS','OTHER')$c$],
    array['expenses', 'expenses_amount_check',   $c$amount > 0 and amount <= 100000000$c$],
    array['expenses', 'expenses_note_check',     $c$note is null or length(note) <= 500$c$],
    array['expenses', 'expenses_photo_check',    $c$photo_path is null or (length(photo_path) <= 300 and photo_path !~ '\.\.')$c$],
    array['expenses', 'expenses_quantity_check', $c$quantity is null or (quantity > 0 and quantity <= 1000000)$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
end $$;

-- Receipt photos: a PRIVATE bucket (not on the internet); only the owner's
-- login reads / writes, and only inside the shop's own folder.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('expense-photos', 'expense-photos', false)
      on conflict (id) do update set public = false;
    execute 'drop policy if exists cccc_expense_photos_read on storage.objects';
    execute 'drop policy if exists cccc_expense_photos_insert on storage.objects';
    execute 'drop policy if exists cccc_expense_photos_update on storage.objects';
    execute 'drop policy if exists cccc_expense_photos_delete on storage.objects';
    execute $p$create policy cccc_expense_photos_read on storage.objects for select to authenticated
      using (bucket_id = 'expense-photos' and (storage.foldername(name))[1] = public.current_business_id()::text and public.app_rank() >= 3)$p$;
    execute $p$create policy cccc_expense_photos_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'expense-photos' and (storage.foldername(name))[1] = public.current_business_id()::text and public.app_rank() >= 3)$p$;
    execute $p$create policy cccc_expense_photos_update on storage.objects for update to authenticated
      using (bucket_id = 'expense-photos' and (storage.foldername(name))[1] = public.current_business_id()::text and public.app_rank() >= 3)$p$;
    execute $p$create policy cccc_expense_photos_delete on storage.objects for delete to authenticated
      using (bucket_id = 'expense-photos' and (storage.foldername(name))[1] = public.current_business_id()::text and public.app_rank() >= 3)$p$;
  end if;
end $$;

-- =============================================================================
-- 6. A15 COUNTER WASTE LOG (tables; the upload itself is in _fo_apply below)
-- =============================================================================
-- One row per "Log waste" entry from a counter.
--   reason: CALIBRATION (calibration / barista drink), SPILLAGE, COMPLIMENTARY,
--           EXPIRED (expired / spoiled), OTHER (note required)
--   total_cost: what the stock taken off cost (server's costing, section 4)
--   approved_by: the manager who approved a COMPLIMENTARY entry
--   needs_review / review_reason: STAFF_MISMATCH when the staff member named is
--           not the person the server knows signed in on that counter
create table if not exists public.waste_logs (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  device_id uuid,
  shift_id uuid references public.shifts(id) on delete set null,
  staff_id uuid,
  staff_name text,
  reason text not null,
  note text,
  logged_at timestamptz not null default now(),
  waste_date date not null,
  approved_by uuid,
  approved_by_name text,
  signed_in_staff_id uuid,
  total_cost numeric not null default 0,
  needs_review boolean not null default false,
  review_reason text,
  received_at timestamptz not null default now()
);
create index if not exists waste_logs_business_date_idx on public.waste_logs(business_id, waste_date);
-- What was wasted in one entry: a menu item (recipe_id + modifiers) or one
-- ingredient (ingredient_id + quantity in unit), the stock lines it took
-- ([{ingredient_id, quantity}] in stock units) and their cost.
create table if not exists public.waste_log_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  waste_log_id uuid not null references public.waste_logs(id) on delete cascade,
  recipe_id uuid references public.recipes(id) on delete set null,
  ingredient_id uuid references public.ingredients(id) on delete set null,
  name text,
  quantity numeric not null,
  unit text,
  modifiers jsonb not null default '[]'::jsonb,
  stock_lines jsonb not null default '[]'::jsonb,
  cost numeric not null default 0
);
create index if not exists waste_log_items_log_idx on public.waste_log_items(waste_log_id);
do $$
declare spec text[];
  specs text[][] := array[
    array['waste_logs', 'waste_logs_reason_check', $c$reason in ('CALIBRATION','SPILLAGE','COMPLIMENTARY','EXPIRED','OTHER')$c$],
    array['waste_logs', 'waste_logs_note_check',   $c$note is null or length(note) <= 200$c$],
    array['waste_log_items', 'waste_log_items_quantity_check', $c$quantity > 0$c$]
  ];
begin
  foreach spec slice 1 in array specs loop
    execute format('alter table public.%I drop constraint if exists %I', spec[1], spec[2]);
    execute format('alter table public.%I add constraint %I check (%s)', spec[1], spec[2], spec[3]);
  end loop;
end $$;

-- =============================================================================
-- 7. COUNTER UPLOADS (fo_sync): the new 'waste' op + merged ingredients
-- =============================================================================
-- LIVE RULE CHANGE (the only one in this script): every counter upload leaves
-- a receipt in sync_operations, whose operation_type column has a live
-- allowed-words rule (made by 006). It does not know the new upload kind
-- 'waste', so the rule is re-made exactly as 006 did, with 'waste' added:
-- every word already allowed AND every word already stored stays allowed.
do $$
declare
  c_wanted text[] := array['INSERT', 'UPDATE', 'DELETE', 'shift_open', 'shift_close', 'cash_movement', 'sale',
                           'held_delete', 'refund', 'audit', 'sold_out', 'waste'];
  r record; v_tbl regclass := to_regclass('public.sync_operations'); v_vals text[]; v_list text;
begin
  if v_tbl is null then return; end if;
  lock table public.sync_operations in access exclusive mode;
  for r in
    select c.conname from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.conrelid = v_tbl and c.contype = 'c' and a.attname = 'operation_type'
  loop
    execute format('alter table public.sync_operations drop constraint %I', r.conname);
  end loop;
  select array(select distinct v from (select unnest(c_wanted) as v
                                       union select operation_type::text from public.sync_operations where operation_type is not null) x
               order by v) into v_vals;
  select string_agg(quote_literal(v), ', ') into v_list from unnest(v_vals) as v;
  execute format('alter table public.sync_operations add constraint sync_operations_operation_type_check check (operation_type in (%s))', v_list);
end $$;

-- Error codes a counter may see: same as 008, plus (010)
--   BAD_WASTE         the waste entry is not readable (no id, no items, > 30 items)
--   BAD_WASTE_REASON  reason is not one of the five
--   NOTE_REQUIRED     reason OTHER without a note
--   BAD_QUANTITY      quantity missing, 0 or less, or too big
--   BAD_UNIT          an ingredient amount in a unit that doesn't convert
create or replace function public._fo_error_code(p_msg text) returns text
language sql immutable as $$
  select case when c = any(array['DEVICE_MISMATCH','SHIFT_NOT_FOUND','UNKNOWN_STAFF','ROLE_TOO_LOW','APPROVAL_REQUIRED',
      'APPROVAL_INVALID','BAD_SALE','BAD_SALE_STATUS','QR_ORDER_ALREADY_PAID','SALE_TOTALS_MISMATCH','UNKNOWN_RECIPE',
      'UNKNOWN_INGREDIENT','FORBIDDEN_ROW','BAD_REFUND','SALE_NOT_FOUND','SALE_NOT_REFUNDABLE','BAD_REFUND_TYPE','BAD_AMOUNT',
      'REFUND_TOO_LARGE','RETURN_TOO_LARGE','SALE_LOCKED','UNKNOWN_OP','BAD_OP','PIN_UPDATE_NEEDED',
      'AMOUNT_NOT_POSITIVE','REWARD_NOT_AVAILABLE','REWARD_AMOUNT_MISMATCH',
      'BAD_WASTE','BAD_WASTE_REASON','NOTE_REQUIRED','BAD_QUANTITY','BAD_UNIT'])
    then c else 'SERVER_ERROR' end
  from (select substring(coalesce(p_msg, '') from '^[A-Z][A-Z_]+') as c) x
$$;

-- Apply ONE counter upload: same as 009, with (marked "010"):
--   * sale / refund: stock lines go through _clean_stock_lines (a merged
--     ingredient's line goes to the general ingredient; operating supplies are
--     left out). Everything else about sales and refunds is unchanged.
--   * new op 'waste' (A15), see inside.
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
  v_fresh timestamptz := public._fresh_start_before(p_biz);   -- 009: latest Start fresh moment (or null)
  v_inv jsonb;                                                  -- 010: the counter's stock lines, cleaned
  v_wid uuid; v_reason_code text; v_staff uuid; v_staff_name text; v_item jsonb; v_item_id uuid;   -- 010: waste
  v_qty numeric; v_lines jsonb; v_cost numeric; v_total_cost numeric := 0; v_day date; v_ing public.ingredients%rowtype;
  v_shift_id uuid; v_at timestamptz; v_name text; v_unit text;
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
    if not found then
      -- 009: removed by Start fresh
      if v_fresh is not null and public._to_ts(p_d->>'closed_at') < v_fresh then return 'skipped'; end if;
      raise exception 'SHIFT_NOT_FOUND';
    end if;
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
    -- 010: stock lines of a merged ingredient go to the ingredient it was merged
    -- into (amount converted); lines of operating supplies are left out.
    v_inv := public._clean_stock_lines(p_biz, p_d->'inventory');
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
    -- the payment doesn't cover it (PAYMENT_MISMATCH), its cashier is not the
    -- person the server knows signed in on this counter (STAFF_MISMATCH), or
    -- (009) it takes an ingredient's stock below 0 (OUT_OF_STOCK: the money is
    -- already taken, so the sale is never refused for stock).
    -- Only the server sets the review flag and signed_in_staff_id.
    if v_status = 'COMPLETED' then
      perform public._check_sale_totals(v_sale, p_d->'items');
      v_reason := nullif(concat_ws(', ',
        public._sale_review_reason(p_biz, p_d->'items'),
        public._sale_money_review(p_biz, v_sale, p_d->'payment'),
        -- 008 (M1): a sale dated more than 1 hour in the future is flagged
        case when public._to_ts(v_sale->>'transaction_date') > now() + interval '1 hour' then 'FUTURE_DATE' end,
        case when v_signed is null or v_signed is distinct from nullif(v_sale->>'cashier_id', '')::uuid
             then 'STAFF_MISMATCH' end,
        -- 009: stock below 0 because of this sale
        public._sale_stock_review(p_biz, v_id, v_inv),
        -- 009: a sale (new, or a HELD one finished now) dated before the shop's
        -- latest Start fresh moment (a counter that was offline, or whose clock
        -- is wrong). Saved, never dropped (it may be a real sale), but the
        -- owner checks it.
        case when v_fresh is not null
                  and public._to_ts(v_sale->>'transaction_date') < v_fresh then 'BEFORE_START_FRESH' end), '');
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
      for v_r in select value from jsonb_array_elements(v_inv) loop
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
    if not found then
      -- 009: the sale was removed by Start fresh
      if v_fresh is not null and public._to_ts(v_ref->>'date') < v_fresh then return 'skipped'; end if;
      raise exception 'SALE_NOT_FOUND';
    end if;
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
    -- 010: merged ingredients / operating supplies, the same as for sales
    v_inv := public._clean_stock_lines(p_biz, p_d->'inventory');
    for v_r in select value from jsonb_array_elements(v_inv) loop
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

  when 'waste' then
    -- 010 (A15): waste logged at the counter (works offline: uploaded later).
    -- data = {id, reason, note, staff_id, shift_id, logged_at,
    --         items: [{recipe_id, quantity, modifiers:[...]}          a menu item (with its options)
    --               | {ingredient_id, quantity, unit}],               a single ingredient
    --         approved_by, approval_token}                           only for COMPLIMENTARY
    -- The SERVER works out the stock to take off (recipe + option extras / swaps,
    -- exactly like a sale) and what it cost; the counter's own numbers are not used.
    v_wid := public._to_uuid(p_d->>'id');
    if v_wid is null then raise exception 'BAD_WASTE'; end if;
    -- The same entry sent again (e.g. a retry after a lost answer): nothing to do.
    -- Checked BEFORE the approval, so a retry never needs a second manager PIN.
    if exists (select 1 from public.waste_logs where id = v_wid and business_id = p_biz) then return 'skipped'; end if;
    if exists (select 1 from public.waste_logs where id = v_wid) then raise exception 'FORBIDDEN_ROW'; end if;
    v_reason_code := upper(btrim(coalesce(p_d->>'reason', '')));
    if v_reason_code not in ('CALIBRATION', 'SPILLAGE', 'COMPLIMENTARY', 'EXPIRED', 'OTHER') then
      raise exception 'BAD_WASTE_REASON';
    end if;
    if v_reason_code = 'OTHER' and coalesce(btrim(p_d->>'note'), '') = '' then raise exception 'NOTE_REQUIRED'; end if;
    v_staff := public._to_uuid(p_d->>'staff_id');
    perform public._require_staff(p_biz, v_staff, 1);
    select name into v_staff_name from public.staff where id = v_staff;
    if jsonb_typeof(p_d->'items') is distinct from 'array' or jsonb_array_length(p_d->'items') not between 1 and 30 then
      raise exception 'BAD_WASTE';
    end if;
    -- a shift of ANOTHER shop (or one that doesn't exist) is simply not linked
    v_shift_id := public._to_uuid(p_d->>'shift_id');
    if v_shift_id is not null and not exists (select 1 from public.shifts where id = v_shift_id and business_id = p_biz) then
      v_shift_id := null;
    end if;
    v_at := coalesce(public._to_ts(p_d->>'logged_at'), now());
    v_day := (v_at at time zone coalesce((select nullif(btrim(timezone), '') from public.settings where business_id = p_biz), 'Asia/Manila'))::date;
    -- Complimentary = free product given away: a manager's approval, checked
    -- exactly like a discount (one-time OVERRIDE token, or the manager's own
    -- sign-in token when the manager is the one logging it, also offline).
    -- The other reasons need no approval (owner decision 2026-11-02).
    if v_reason_code = 'COMPLIMENTARY' then
      v_appr := public._use_approval(p_biz, p_dev.auth_user_id, public._to_uuid(p_d->>'approved_by'),
                                     p_d->>'approval_token', 'waste:' || v_wid, v_staff);
    end if;
    insert into public.waste_logs(id, business_id, device_id, shift_id, staff_id, staff_name, reason, note, logged_at, waste_date,
                                  approved_by, approved_by_name, signed_in_staff_id, needs_review, review_reason)
      values (v_wid, p_biz, p_dev.id, v_shift_id, v_staff, v_staff_name, v_reason_code, left(nullif(btrim(p_d->>'note'), ''), 200),
              v_at, v_day, v_appr.id, v_appr.name, v_signed,
              v_signed is null or v_signed is distinct from v_staff,
              case when v_signed is null or v_signed is distinct from v_staff then 'STAFF_MISMATCH' end);
    for v_item in select value from jsonb_array_elements(p_d->'items') loop
      if jsonb_typeof(v_item) is distinct from 'object' then raise exception 'BAD_WASTE'; end if;
      v_qty := public._to_num(v_item->>'quantity');
      if v_qty is null or v_qty <= 0 then raise exception 'BAD_QUANTITY'; end if;
      v_unit := null; v_name := null; v_item_id := null; v_ing := null;
      if public._to_uuid(v_item->>'recipe_id') is not null then
        -- a menu item: what a sale of v_qty of it (with these options) takes off
        v_item_id := public._to_uuid(v_item->>'recipe_id');
        select name into v_name from public.recipes where id = v_item_id and business_id = p_biz;
        if v_name is null then raise exception 'UNKNOWN_RECIPE'; end if;
        if v_qty > 100 then raise exception 'BAD_QUANTITY'; end if;
        v_lines := public._recipe_stock_lines(p_biz, v_item_id, v_qty, v_item->'modifiers');
      elsif public._to_uuid(v_item->>'ingredient_id') is not null then
        -- a single ingredient, in any unit that converts to its stock unit
        v_ing := public._ingredient_final(p_biz, public._to_uuid(v_item->>'ingredient_id'));
        if v_ing.id is null then raise exception 'UNKNOWN_INGREDIENT'; end if;
        v_unit := nullif(btrim(v_item->>'unit'), '');
        v_name := v_ing.name;
        v_qty := public._to_base_qty(v_qty, coalesce(v_unit, (select base_unit from public.ingredients
                                                               where id = public._to_uuid(v_item->>'ingredient_id'))),
                                     v_ing.base_unit, v_ing.weight_g_per_ml);
        if v_qty is null then raise exception 'BAD_UNIT'; end if;
        if v_qty > 1000000 then raise exception 'BAD_QUANTITY'; end if;
        v_lines := jsonb_build_array(jsonb_build_object('ingredient_id', v_ing.id, 'quantity', v_qty));
        v_qty := public._to_num(v_item->>'quantity');   -- keep what was typed for the record
      else
        raise exception 'BAD_WASTE';
      end if;
      v_lines := public._clean_stock_lines(p_biz, v_lines);
      v_cost := coalesce((select sum(public._to_num(l->>'quantity') * public._ingredient_unit_cost(p_biz, public._to_uuid(l->>'ingredient_id'), v_day))
                          from jsonb_array_elements(v_lines) l), 0);
      insert into public.waste_log_items(business_id, waste_log_id, recipe_id, ingredient_id, name, quantity, unit, modifiers, stock_lines, cost)
        values (p_biz, v_wid,
                case when public._to_uuid(v_item->>'recipe_id') is not null then v_item_id end,
                case when public._to_uuid(v_item->>'recipe_id') is null then v_ing.id end,
                v_name, v_qty, v_unit,
                case when jsonb_typeof(v_item->'modifiers') = 'array' then v_item->'modifiers' else '[]'::jsonb end,
                v_lines, round(v_cost, 4));
      for v_r in select value from jsonb_array_elements(v_lines) loop
        perform public._require_ingredient(p_biz, v_r);
        insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date, notes)
          values (p_biz, (v_r->>'ingredient_id')::uuid, 'WASTE', abs(public._to_num(v_r->>'quantity')), v_wid::text, v_day,
                  'Counter waste: ' || initcap(v_reason_code));
      end loop;
      v_total_cost := v_total_cost + v_cost;
    end loop;
    update public.waste_logs set total_cost = round(v_total_cost, 2) where id = v_wid;
    return 'ok';

  else
    raise exception 'UNKNOWN_OP: %', p_type;
  end case;
end $$;

-- =============================================================================
-- 8. A12 MERGE INGREDIENTS (owner only)
-- =============================================================================
-- Replaces the ingredient p_from with p_to everywhere inside a JSON value
-- (recipe options, library options, sale item options, QR order items, waste
-- stock lines). In every object whose ingredient_id is p_from: ingredient_id
-- becomes p_to and its amounts (ingredient_qty_delta, quantity) are multiplied
-- by p_factor (e.g. kg -> g = 1000). swap_from_ingredient_id /
-- swap_to_ingredient_id are replaced too. Amounts typed with a unit
-- (entered_quantity + unit) stay as typed. Anything else is unchanged.
create or replace function public._jsonb_swap_ingredient(j jsonb, p_from uuid, p_to uuid, p_factor numeric) returns jsonb
language plpgsql immutable as $$
declare v jsonb; k text;
begin
  if j is null then return null; end if;
  if jsonb_typeof(j) = 'array' then
    return (select coalesce(jsonb_agg(public._jsonb_swap_ingredient(e, p_from, p_to, p_factor) order by ord), '[]'::jsonb)
            from jsonb_array_elements(j) with ordinality x(e, ord));
  end if;
  if jsonb_typeof(j) <> 'object' then return j; end if;
  select coalesce(jsonb_object_agg(key, public._jsonb_swap_ingredient(value, p_from, p_to, p_factor)), '{}'::jsonb)
    into v from jsonb_each(j);
  if v->>'ingredient_id' = p_from::text then
    v := v || jsonb_build_object('ingredient_id', p_to);
    foreach k in array array['ingredient_qty_delta', 'quantity'] loop
      if jsonb_typeof(v->k) = 'number' then v := v || jsonb_build_object(k, round((v->>k)::numeric * p_factor, 6)); end if;
    end loop;
  end if;
  foreach k in array array['swap_from_ingredient_id', 'swap_to_ingredient_id'] loop
    if v->>k = p_from::text then v := v || jsonb_build_object(k, p_to); end if;
  end loop;
  return v;
end $$;

-- A brand name that is not taken yet (upper / lower case and spaces ignored):
-- the name itself, else "name (2)", "name (3)"... At most 60 characters.
create or replace function public._free_brand_name(p_taken text[], p_name text) returns text
language plpgsql immutable as $$
declare v_base text := left(btrim(coalesce(nullif(btrim(p_name), ''), 'Brand')), 60); v text := v_base; n integer := 1;
begin
  while lower(btrim(v)) = any(coalesce(p_taken, '{}')) and n < 1000 loop
    n := n + 1;
    v := left(v_base, 60 - length(' (' || n || ')')) || ' (' || n || ')';
  end loop;
  return v;
end $$;

-- Works out (and checks) a merge WITHOUT changing anything. Used by both the
-- preview and the merge itself, so they always agree.
--   p_ids         the ingredients picked (2 or more; or 1 or more with p_into)
--   p_name        the general ingredient's name (needed for a NEW one; for
--                 p_into, empty = keep its name)
--   p_into        optional: merge INTO this existing ingredient (it keeps its
--                 own purchases, brands and stock as they are). Empty = a NEW
--                 general ingredient is made.
--   p_base_unit   optional, new general ingredient only: its stock unit (same
--                 family as the picked ones). Empty = the first picked one's.
--   p_brand_names optional {"<picked id>": "Arla", ...}: the brand name each
--                 picked ingredient becomes (default: its own name)
-- Errors: NOT_A_MEMBER / NOT_ALLOWED (only the owner), MERGE_TOO_FEW,
--   MERGE_TOO_MANY (more than 30), MERGE_UNKNOWN_INGREDIENT (not this shop's),
--   MERGE_ALREADY_MERGED, MERGE_PRODUCED_NOT_ALLOWED (house-made items can't be
--   merged), MERGE_SUPPLIED_NOT_ALLOWED (the stock item of a supplied menu item),
--   MERGE_UNIT_MISMATCH (g/kg with mL/L, or two different count units),
--   BAD_NAME (missing / longer than 80), NAME_TAKEN (another ingredient
--   already has that name).
create or replace function public._merge_plan(p_biz uuid, p_ids uuid[], p_name text, p_into uuid,
                                              p_base_unit text, p_brand_names jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_into public.ingredients%rowtype; v_src public.ingredients%rowtype; v_ids uuid[]; v_sources uuid[];
  v_name text := nullif(btrim(coalesce(p_name, '')), ''); v_base text; v_family text; v_taken text[] := '{}';
  v_out jsonb := '[]'::jsonb; v_brands jsonb; v_bname text; v_has_loose boolean; v_has_brands boolean; v_f numeric;
  b record; v_stock numeric; v_total numeric := 0; v_id uuid; v_first public.ingredients%rowtype;
begin
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_ids, '{}')) x where x is not null;
  if p_into is not null then
    select * into v_into from public.ingredients where id = p_into and business_id = p_biz;
    if not found then raise exception 'MERGE_UNKNOWN_INGREDIENT'; end if;
    if v_into.merged_into is not null then raise exception 'MERGE_ALREADY_MERGED'; end if;
    if coalesce(v_into.is_produced_item, false) then raise exception 'MERGE_PRODUCED_NOT_ALLOWED'; end if;
    if exists (select 1 from public.recipes where supplied_ingredient_id = v_into.id) then raise exception 'MERGE_SUPPLIED_NOT_ALLOWED'; end if;
  end if;
  select coalesce(array_agg(x order by x), '{}') into v_sources from unnest(v_ids) x where x is distinct from p_into;
  if cardinality(v_sources) < (case when p_into is null then 2 else 1 end) then raise exception 'MERGE_TOO_FEW'; end if;
  if cardinality(v_sources) > 30 then raise exception 'MERGE_TOO_MANY'; end if;
  -- every picked ingredient: this shop's, not merged yet, bought (not house-made), not a supplied item
  foreach v_id in array v_sources loop
    select * into v_src from public.ingredients where id = v_id and business_id = p_biz;
    if not found then raise exception 'MERGE_UNKNOWN_INGREDIENT'; end if;
    if v_src.merged_into is not null then raise exception 'MERGE_ALREADY_MERGED'; end if;
    if coalesce(v_src.is_produced_item, false) then raise exception 'MERGE_PRODUCED_NOT_ALLOWED'; end if;
    if exists (select 1 from public.recipes where supplied_ingredient_id = v_src.id) then raise exception 'MERGE_SUPPLIED_NOT_ALLOWED'; end if;
  end loop;
  -- the general ingredient's stock unit
  select * into v_first from public.ingredients where id = v_sources[1];
  if p_into is not null then
    v_base := v_into.base_unit;
  else
    v_base := coalesce(nullif(btrim(coalesce(p_base_unit, '')), ''), v_first.base_unit);
  end if;
  v_family := public._unit_family(v_base);
  foreach v_id in array v_sources loop
    select * into v_src from public.ingredients where id = v_id;
    if public._unit_family(v_src.base_unit) <> v_family
       or (v_family = 'count' and lower(btrim(coalesce(v_src.base_unit, ''))) <> lower(btrim(coalesce(v_base, '')))) then
      raise exception 'MERGE_UNIT_MISMATCH';
    end if;
  end loop;
  -- the name
  if p_into is null and v_name is null then raise exception 'BAD_NAME'; end if;
  if length(coalesce(v_name, '')) > 80 then raise exception 'BAD_NAME'; end if;
  if v_name is not null and exists (select 1 from public.ingredients
        where business_id = p_biz and merged_into is null and coalesce(active, true)
          and lower(btrim(name)) = lower(v_name) and not (id = any(v_ids)) and id is distinct from p_into) then
    raise exception 'NAME_TAKEN';
  end if;
  -- brands the general ingredient already has (merging into an existing one)
  if p_into is not null then
    select coalesce(array_agg(lower(btrim(name))), '{}') into v_taken from public.ingredient_brands where ingredient_id = p_into;
  end if;
  foreach v_id in array v_sources loop
    select * into v_src from public.ingredients where id = v_id;
    v_f := public._unit_factor(v_src.base_unit) / public._unit_factor(v_base);
    v_has_brands := exists (select 1 from public.ingredient_brands where ingredient_id = v_src.id);
    -- stock not tied to one of its brands (purchases / starting stock / stock added without a brand)
    v_has_loose := exists (select 1 from public.purchases where ingredient_id = v_src.id and brand_id is null)
                or exists (select 1 from public.inventory_transactions where ingredient_id = v_src.id and brand_id is null
                           and (transaction_type in ('INITIAL_STOCK', 'PURCHASE') or (transaction_type = 'ADJUSTMENT' and quantity > 0)));
    -- its existing brands move over (name kept unless taken)
    v_brands := '[]'::jsonb;
    for b in select * from public.ingredient_brands where ingredient_id = v_src.id order by sort_order, name, id loop
      v_bname := public._free_brand_name(v_taken, case when lower(btrim(b.name)) = any(v_taken)
                                                       then left(b.name, 40) || ' (' || left(v_src.name, 15) || ')' else b.name end);
      v_taken := v_taken || lower(btrim(v_bname));
      v_brands := v_brands || jsonb_build_array(jsonb_build_object('id', b.id, 'name', b.name, 'new_name', v_bname));
    end loop;
    -- the ingredient itself becomes a brand (unless it only had branded stock)
    if v_has_loose or not v_has_brands then
      v_bname := public._free_brand_name(v_taken, coalesce(nullif(btrim(p_brand_names->>v_src.id::text), ''), v_src.name));
      v_taken := v_taken || lower(btrim(v_bname));
    else
      v_bname := null;
    end if;
    select coalesce(stock, 0) into v_stock from public.v_ingredient_stock where ingredient_id = v_src.id;
    v_stock := coalesce(v_stock, 0);
    v_total := v_total + v_stock * v_f;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_src.id, 'name', v_src.name, 'base_unit', v_src.base_unit, 'factor', v_f,
      'stock', round(v_stock, 6), 'stock_in_general_unit', round(v_stock * v_f, 6),
      'purchases', (select count(*) from public.purchases where ingredient_id = v_src.id),
      'stock_lines', (select count(*) from public.inventory_transactions where ingredient_id = v_src.id),
      'becomes_brand', v_bname, 'brands', v_brands,
      'reorder_level', v_src.reorder_level, 'category_id', v_src.category_id, 'supplier_id', v_src.supplier_id));
  end loop;
  if p_into is not null then
    v_total := v_total + coalesce((select stock from public.v_ingredient_stock where ingredient_id = p_into), 0);
  end if;
  return jsonb_build_object(
    'general', jsonb_build_object(
      'id', p_into, 'is_new', p_into is null,
      'name', coalesce(v_name, v_into.name), 'base_unit', v_base,
      'category_id', case when p_into is null then v_first.category_id else v_into.category_id end,
      'stock_now', case when p_into is null then 0 else round(coalesce((select stock from public.v_ingredient_stock where ingredient_id = p_into), 0), 6) end,
      'stock_after', round(v_total, 6)),
    'sources', v_out,
    'recipes', coalesce((
      select jsonb_agg(jsonb_build_object('recipe_id', r.id, 'name', r.name, 'is_production_recipe', coalesce(r.is_production_recipe, false),
                                          'lines', x.n, 'lines_combined', greatest(x.n - 1, 0)
                                                    + case when p_into is not null and exists (select 1 from public.recipe_ingredients z
                                                                                               where z.recipe_id = r.id and z.ingredient_id = p_into)
                                                           then 1 else 0 end)
                       order by r.name)
      from (select recipe_id, count(*) as n from public.recipe_ingredients where ingredient_id = any(v_sources) group by recipe_id) x
      join public.recipes r on r.id = x.recipe_id), '[]'::jsonb),
    'option_recipes', coalesce((
      select jsonb_agg(jsonb_build_object('recipe_id', r.id, 'name', r.name) order by r.name)
      from public.recipes r
      where r.business_id = p_biz
        and exists (select 1 from unnest(v_sources) s where r.modifier_groups::text like '%' || s::text || '%')), '[]'::jsonb),
    'library_groups', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.name)
      from public.option_groups g
      where g.business_id = p_biz
        and exists (select 1 from unnest(v_sources) s where g.options::text like '%' || s::text || '%')), '[]'::jsonb),
    'open_qr_orders', (select count(*) from public.qr_orders q
                       where q.business_id = p_biz and q.status in ('PENDING', 'PREPARING', 'READY')
                         and exists (select 1 from unnest(v_sources) s where q.items::text like '%' || s::text || '%')),
    'waste_records', (select count(*) from public.waste where ingredient_id = any(v_sources)));
end $$;

-- Back Office: what a merge WOULD do (nothing is changed). Returns the plan
-- above: {general:{id, is_new, name, base_unit, category_id, stock_now,
-- stock_after}, sources:[{id, name, base_unit, factor, stock,
-- stock_in_general_unit, purchases, stock_lines, becomes_brand,
-- brands:[{id, name, new_name}], ...}], recipes:[{recipe_id, name,
-- is_production_recipe, lines, lines_combined}], option_recipes:[...],
-- library_groups:[...], open_qr_orders, waste_records}.
create or replace function public.merge_ingredients_preview(p_ids uuid[], p_name text, p_into uuid default null,
                                                            p_base_unit text default null, p_brand_names jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public._require_owner();
begin
  return public._merge_plan(v_biz, p_ids, p_name, p_into, p_base_unit, coalesce(p_brand_names, '{}'::jsonb));
end $$;

-- Back Office: merge (all-or-nothing). Same arguments as the preview.
-- For each picked ingredient S (amounts multiplied by S's factor into the
-- general ingredient G's stock unit):
--   * S's existing brands become brands of G (with all their purchases and
--     stock lines); S itself becomes a brand of G for its other purchases and
--     starting stock / stock added by hand (FIFO stock per brand keeps working);
--   * every purchase, stock line (sales, refunds, waste, production use, counts),
--     waste record, recipe line (menu AND production recipes), option extra /
--     swap (recipe options and the option library), sale item option and QR
--     order item that names S now names G; two lines of one recipe that end up
--     on G are combined into one;
--   * S stays, switched off (active = false, merged_into = G), so an offline
--     counter that still names S uploads fine (its amounts go to G).
-- Writes one audit row "Merge ingredients". Returns the plan plus
-- {done: true, ingredient_id: G}.
-- Extra errors: BUSY_TRY_AGAIN (counters were uploading: try again).
create or replace function public.merge_ingredients(p_ids uuid[], p_name text, p_into uuid default null,
                                                    p_base_unit text default null, p_brand_names jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_biz uuid := public._require_owner();
  v_plan jsonb; v_g uuid; s jsonb; b jsonb; v_src uuid; v_f numeric; v_nb uuid; v_sb uuid; r record;
  v_actor public.staff%rowtype; v_name text; v_sort integer;
begin
  -- one merge at a time per shop, and no counter upload in between
  perform pg_advisory_xact_lock(hashtext('cccc.merge_ingredients:' || v_biz::text));
  perform set_config('lock_timeout', '5s', true);
  begin
    lock table public.inventory_transactions, public.purchases in share row exclusive mode;
  exception when lock_not_available or deadlock_detected then
    raise exception 'BUSY_TRY_AGAIN';
  end;
  perform set_config('lock_timeout', '0', true);
  v_plan := public._merge_plan(v_biz, p_ids, p_name, p_into, p_base_unit, coalesce(p_brand_names, '{}'::jsonb));

  -- the general ingredient: the chosen one (renamed if a name was given), or a new one
  if p_into is not null then
    v_g := p_into;
    update public.ingredients set name = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name), updated_at = now()
      where id = v_g;
  else
    insert into public.ingredients(business_id, name, base_unit, category_id, supplier_id, reorder_level, notes, active)
      values (v_biz, btrim(p_name), v_plan->'general'->>'base_unit',
              public._to_uuid(v_plan->'sources'->0->>'category_id'), public._to_uuid(v_plan->'sources'->0->>'supplier_id'),
              (select max(coalesce(public._to_num(x->>'reorder_level'), 0) * public._to_num(x->>'factor'))
                 from jsonb_array_elements(v_plan->'sources') x),
              left('Merged from: ' || (select string_agg(x->>'name', ', ') from jsonb_array_elements(v_plan->'sources') x), 500),
              true)
      returning id into v_g;
  end if;
  select coalesce(max(sort_order), 0) into v_sort from public.ingredient_brands where ingredient_id = v_g;

  for s in select value from jsonb_array_elements(v_plan->'sources') loop
    v_src := (s->>'id')::uuid;
    v_f := (s->>'factor')::numeric;
    -- its existing brands -> new brands of G, taking their purchases / stock lines along
    for b in select value from jsonb_array_elements(s->'brands') loop
      v_sort := v_sort + 1;
      insert into public.ingredient_brands(business_id, ingredient_id, name, active, sort_order, notes)
        select v_biz, v_g, b->>'new_name', x.active, v_sort, x.notes from public.ingredient_brands x where x.id = (b->>'id')::uuid
        returning id into v_nb;
      update public.purchases set brand_id = v_nb, ingredient_id = v_g,
             base_quantity = base_quantity * v_f, price_per_base_unit = price_per_base_unit / v_f
        where brand_id = (b->>'id')::uuid;
      update public.inventory_transactions set brand_id = v_nb, ingredient_id = v_g, quantity = quantity * v_f
        where brand_id = (b->>'id')::uuid;
      delete from public.ingredient_brands where id = (b->>'id')::uuid;
    end loop;
    -- the ingredient itself -> a brand of G
    v_sb := null;
    if s->>'becomes_brand' is not null then
      v_sort := v_sort + 1;
      insert into public.ingredient_brands(business_id, ingredient_id, name, sort_order, notes)
        values (v_biz, v_g, s->>'becomes_brand', v_sort, left('Was the ingredient "' || (s->>'name') || '"', 500))
        returning id into v_sb;
    end if;
    update public.purchases set ingredient_id = v_g, brand_id = coalesce(brand_id, v_sb),
           base_quantity = base_quantity * v_f, price_per_base_unit = price_per_base_unit / v_f
      where ingredient_id = v_src and business_id = v_biz;
    update public.inventory_transactions
       set ingredient_id = v_g, quantity = quantity * v_f,
           brand_id = case when brand_id is null and v_sb is not null
                            and (transaction_type = 'INITIAL_STOCK' or (transaction_type = 'ADJUSTMENT' and quantity > 0))
                           then v_sb else brand_id end
      where ingredient_id = v_src and business_id = v_biz;
    -- recipe lines (menu and production recipes)
    update public.recipe_ingredients set ingredient_id = v_g, quantity = quantity * v_f
      where ingredient_id = v_src and business_id = v_biz;
    update public.waste set ingredient_id = v_g, quantity = quantity * v_f where ingredient_id = v_src and business_id = v_biz;
    update public.reconciliation_issues set ingredient_id = v_g, expected_stock = expected_stock * v_f,
           actual_stock = actual_stock * v_f, discrepancy = discrepancy * v_f
      where ingredient_id = v_src and business_id = v_biz;
    update public.waste_log_items set ingredient_id = v_g where ingredient_id = v_src and business_id = v_biz;
    update public.waste_log_items set stock_lines = public._jsonb_swap_ingredient(stock_lines, v_src, v_g, v_f)
      where business_id = v_biz and stock_lines::text like '%' || v_src::text || '%';
    update public.expenses set ingredient_id = v_g where ingredient_id = v_src and business_id = v_biz;
    -- options (library first, then each recipe's own), sale items, QR orders
    update public.option_groups set options = public._jsonb_swap_ingredient(options, v_src, v_g, v_f)
      where business_id = v_biz and options::text like '%' || v_src::text || '%';
    update public.recipes set modifier_groups = public._jsonb_swap_ingredient(modifier_groups, v_src, v_g, v_f)
      where business_id = v_biz and modifier_groups::text like '%' || v_src::text || '%';
    update public.sale_items set modifiers = public._jsonb_swap_ingredient(modifiers, v_src, v_g, v_f)
      where business_id = v_biz and modifiers::text like '%' || v_src::text || '%';
    update public.qr_orders set items = public._jsonb_swap_ingredient(items, v_src, v_g, v_f)
      where business_id = v_biz and items::text like '%' || v_src::text || '%';
    -- S stays, switched off, pointing at G
    update public.ingredients set active = false, merged_into = v_g, merged_at = now(), updated_at = now()
      where id = v_src;
  end loop;

  -- two lines of one recipe on G -> one line (amounts added; typed amount dropped)
  for r in select recipe_id, min(id::text)::uuid as keep_id, sum(quantity) as q
           from public.recipe_ingredients where ingredient_id = v_g and business_id = v_biz
           group by recipe_id having count(*) > 1 loop
    delete from public.recipe_ingredients where recipe_id = r.recipe_id and ingredient_id = v_g and id <> r.keep_id;
    update public.recipe_ingredients set quantity = r.q, entered_quantity = null,
           unit = (select base_unit from public.ingredients where id = v_g)
      where id = r.keep_id;
  end loop;
  -- rebuild every recipe's options (swaps use the recipes' amounts)
  update public.recipes set modifier_groups = modifier_groups where business_id = v_biz;
  -- refund / stock caps are checked now, on the moved lines
  set constraints public.refunds_cap_check_ins, public.refunds_cap_check_upd, public.stock_cap_check_ins,
    public.stock_cap_check_upd, public.stock_cap_check_del, public.sales_cap_check_upd immediate;

  select * into v_actor from public.staff where business_id = v_biz and profile_id = auth.uid() limit 1;
  v_name := coalesce(v_actor.name, (select name from public.profiles where id = auth.uid()));
  insert into public.audit_log(business_id, action, actor_id, actor_name, details, reference_id, at)
    values (v_biz, 'Merge ingredients', v_actor.id, v_name,
            left('Merged ' || (select string_agg((x->>'name') || ' (' || (x->>'base_unit') || ')', ', ')
                               from jsonb_array_elements(v_plan->'sources') x)
                 || ' into "' || (v_plan->'general'->>'name') || '" (' || (v_plan->'general'->>'base_unit') || ')', 2000),
            v_g::text, now());
  return v_plan || jsonb_build_object('done', true, 'ingredient_id', v_g);
end $$;

-- =============================================================================
-- 9. A8 SUPPLIED ITEMS (owner only)
-- =============================================================================
-- Saves a buy-and-resell item in one go (all-or-nothing):
--   a menu item (recipes row, recipe_type PASTRY or FOOD) + its stock item
--   (ingredients row, counted in pcs) + ONE recipe line "1 pcs of it", and
--   optionally a restock purchase.
-- p_item = {
--   recipe_id, ingredient_id   both empty = new item; both given = edit that item
--   name (1..80), recipe_type ('PASTRY' default, or 'FOOD'), subcategory,
--   supplier_id, cost_per_piece (what you pay, >= 0), selling_price (>= 0),
--   image_url, description, pos_visible, qr_visible, active, sort_order,
--   category_id (ingredient category), reorder_level,
--   restock: {quantity (pieces, > 0), cost_per_piece or total_price,
--             purchase_date (default today, Manila), invoice_number, notes, brand_id}
-- }
-- Returns {recipe_id, ingredient_id, purchase_id (or null), cost_per_piece,
--          selling_price, margin, margin_pct}
-- cost_per_piece in the answer = the latest purchase price (else the typed
-- cost). The item's stock is ingredient stock (purchases add pieces, each sale
-- takes 1, waste and counts as for any stock); no stock = sold out.
-- Errors: NOT_ALLOWED, BAD_NAME, BAD_TYPE, BAD_PRICE, BAD_QUANTITY,
--   NOT_A_SUPPLIED_ITEM (the ids given are not one supplied item of this shop),
--   FORBIDDEN_ROW (a supplier / category / brand of another shop).
create or replace function public.save_supplied_item(p_item jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_biz uuid := public._require_owner();
  v_rid uuid := public._to_uuid(p_item->>'recipe_id'); v_iid uuid := public._to_uuid(p_item->>'ingredient_id');
  v_name text := btrim(coalesce(p_item->>'name', '')); v_type text := upper(coalesce(nullif(btrim(p_item->>'recipe_type'), ''), 'PASTRY'));
  v_cost numeric := public._to_num(p_item->>'cost_per_piece'); v_price numeric := public._to_num(p_item->>'selling_price');
  v_rs jsonb := p_item->'restock'; v_pid uuid; v_q numeric; v_total numeric; v_unit_cost numeric; v_date date;
  v_tz text;
begin
  if jsonb_typeof(p_item) is distinct from 'object' then raise exception 'BAD_NAME'; end if;
  if length(v_name) not between 1 and 80 then raise exception 'BAD_NAME'; end if;
  if v_type not in ('PASTRY', 'FOOD') then raise exception 'BAD_TYPE'; end if;
  if (p_item ? 'cost_per_piece' and p_item->>'cost_per_piece' is not null and (v_cost is null or v_cost < 0 or v_cost > 1000000))
     or v_price is null or v_price < 0 or v_price > 1000000 then
    raise exception 'BAD_PRICE';
  end if;
  -- links must be this shop's
  perform public._check_links('ingredients', jsonb_build_object('supplier_id', p_item->'supplier_id', 'category_id', p_item->'category_id'), v_biz);
  if (v_rid is null) <> (v_iid is null) then raise exception 'NOT_A_SUPPLIED_ITEM'; end if;
  if v_rid is not null and not exists (select 1 from public.recipes where id = v_rid and business_id = v_biz and supplied_ingredient_id = v_iid)
     then raise exception 'NOT_A_SUPPLIED_ITEM'; end if;
  if v_rid is null then
    v_rid := gen_random_uuid(); v_iid := gen_random_uuid();
    insert into public.ingredients(id, business_id, name, base_unit, is_produced_item, active)
      values (v_iid, v_biz, v_name, 'pcs', false, true);
    insert into public.recipes(id, business_id, name, recipe_type, selling_price, is_production_recipe, supplied_ingredient_id)
      values (v_rid, v_biz, v_name, v_type, v_price, false, v_iid);
  end if;
  update public.ingredients
     set name = v_name, base_unit = 'pcs',
         supplier_id = case when p_item ? 'supplier_id' then public._to_uuid(p_item->>'supplier_id') else supplier_id end,
         category_id = case when p_item ? 'category_id' then public._to_uuid(p_item->>'category_id') else category_id end,
         reorder_level = coalesce(public._to_num(p_item->>'reorder_level'), reorder_level),
         standard_cost = case when p_item ? 'cost_per_piece' then v_cost else standard_cost end,
         active = coalesce((p_item->>'active')::boolean, active, true),
         updated_at = now()
   where id = v_iid;
  update public.recipes
     set name = v_name, recipe_type = v_type, selling_price = v_price,
         category = case when p_item ? 'subcategory' then nullif(btrim(p_item->>'subcategory'), '') else category end,
         image_url = case when p_item ? 'image_url' then nullif(btrim(p_item->>'image_url'), '') else image_url end,
         description = case when p_item ? 'description' then left(nullif(btrim(p_item->>'description'), ''), 500) else description end,
         pos_visible = coalesce((p_item->>'pos_visible')::boolean, pos_visible, true),
         qr_visible = coalesce((p_item->>'qr_visible')::boolean, qr_visible, true),
         active = coalesce((p_item->>'active')::boolean, active, true),
         sort_order = coalesce(public._to_num(p_item->>'sort_order')::integer, sort_order, 0),
         is_production_recipe = false, supplied_ingredient_id = v_iid,
         updated_at = now()
   where id = v_rid;
  -- exactly one recipe line: 1 piece of the stock item
  delete from public.recipe_ingredients where recipe_id = v_rid and ingredient_id <> v_iid;
  if exists (select 1 from public.recipe_ingredients where recipe_id = v_rid) then
    update public.recipe_ingredients set quantity = 1, unit = 'pcs', entered_quantity = null where recipe_id = v_rid;
    delete from public.recipe_ingredients where recipe_id = v_rid
      and id <> (select min(id::text)::uuid from public.recipe_ingredients where recipe_id = v_rid);
  else
    insert into public.recipe_ingredients(business_id, recipe_id, ingredient_id, quantity, unit) values (v_biz, v_rid, v_iid, 1, 'pcs');
  end if;
  -- optional restock: a purchase in pieces + its stock line
  if jsonb_typeof(v_rs) = 'object' then
    v_q := public._to_num(v_rs->>'quantity');
    if v_q is null or v_q <= 0 or v_q > 100000 then raise exception 'BAD_QUANTITY'; end if;
    v_total := coalesce(public._to_num(v_rs->>'total_price'), public._to_num(v_rs->>'cost_per_piece') * v_q, coalesce(v_cost, 0) * v_q);
    if v_total is null or v_total < 0 or v_total > 100000000 then raise exception 'BAD_PRICE'; end if;
    select nullif(btrim(timezone), '') into v_tz from public.settings where business_id = v_biz;
    v_date := coalesce(public._to_ts(v_rs->>'purchase_date')::date, (now() at time zone coalesce(v_tz, 'Asia/Manila'))::date);
    perform public._check_links('purchases', jsonb_build_object('brand_id', v_rs->'brand_id'), v_biz);
    v_pid := gen_random_uuid();
    insert into public.purchases(id, business_id, ingredient_id, supplier_id, purchase_date, invoice_number, quantity, purchase_unit,
                                 base_quantity, total_price, price_per_base_unit, notes, brand_id)
      values (v_pid, v_biz, v_iid, (select supplier_id from public.ingredients where id = v_iid), v_date,
              left(nullif(btrim(v_rs->>'invoice_number'), ''), 60), v_q, 'pcs', v_q, round(v_total, 2), v_total / v_q,
              left(nullif(btrim(v_rs->>'notes'), ''), 500), public._to_uuid(v_rs->>'brand_id'));
    insert into public.inventory_transactions(business_id, ingredient_id, transaction_type, quantity, reference_id, transaction_date, notes)
      values (v_biz, v_iid, 'PURCHASE', v_q, v_pid::text, v_date, 'Supplied item restock');
    if not (p_item ? 'cost_per_piece') or p_item->>'cost_per_piece' is null then
      update public.ingredients set standard_cost = round(v_total / v_q, 4) where id = v_iid;
    end if;
  end if;
  v_unit_cost := coalesce((select price_per_base_unit from public.purchases where ingredient_id = v_iid
                           order by purchase_date desc, created_at desc limit 1),
                          (select standard_cost from public.ingredients where id = v_iid), 0);
  return jsonb_build_object('recipe_id', v_rid, 'ingredient_id', v_iid, 'purchase_id', v_pid,
    'cost_per_piece', round(v_unit_cost, 4), 'selling_price', v_price,
    'margin', round(v_price - v_unit_cost, 2),
    'margin_pct', case when v_price > 0 then round((v_price - v_unit_cost) / v_price * 100, 1) end);
end $$;

-- =============================================================================
-- 10. REPORTS (owner only): waste, monthly net income
-- =============================================================================
-- Waste between two days (both included, shop's dates). Two sources:
--   COUNTER = waste logged on a counter (waste_logs, 010), cost worked out when
--             it uploaded;
--   OFFICE  = waste entered in the Back Office (waste table), costed here at
--             that day's average cost.
-- Returns {from, to, total_cost,
--   by_reason: [{reason, entries, cost}],
--   by_day:    [{day, reason, source, entries, cost}],
--   entries:   [{id, source, day, reason, note, staff_name, approved_by_name,
--                needs_review, cost, items:[{name, quantity, unit, recipe_id,
--                ingredient_id, modifiers, cost}]}]  (newest first, at most 500)}
-- COUNTER reasons are the five codes; OFFICE reasons are the Back Office's own words.
create or replace function public.waste_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public._require_owner();
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_DATE'; end if;
  return (
    with e as (
      select l.id, 'COUNTER'::text as source, l.waste_date as day, l.reason, l.note, l.staff_name, l.approved_by_name,
             l.needs_review, l.total_cost as cost, l.received_at as at,
             coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity, 'unit', i.unit,
                                                           'recipe_id', i.recipe_id, 'ingredient_id', i.ingredient_id,
                                                           'modifiers', i.modifiers, 'cost', i.cost))
                       from public.waste_log_items i where i.waste_log_id = l.id), '[]'::jsonb) as items
      from public.waste_logs l
      where l.business_id = v_biz and l.waste_date between p_from and p_to
      union all
      select w.id, 'OFFICE', w.date, coalesce(nullif(btrim(w.reason), ''), 'Other'), w.notes, null, null, false,
             round(coalesce(w.quantity, 0) * public._ingredient_unit_cost(v_biz, w.ingredient_id, w.date), 4), w.created_at,
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
      'entries', coalesce((select jsonb_agg(to_jsonb(x) - 'at' order by x.day desc, x.at desc)
                           from (select * from e order by day desc, at desc limit 500) x), '[]'::jsonb)));
end $$;

-- The month's net income (owner only). p_month = any day of the month.
-- Days are the shop's (Asia/Manila unless set otherwise).
--   sales.gross    = grand totals of the month's finished sales (voided ones
--                    don't count; HELD ones aren't finished)
--   sales.refunds  = money given back in the month on those kinds of sales
--                    (full / partial refunds; a void is not a refund here)
--   sales.net      = gross - refunds
--   sales.tax / service_charge / count: for information (tax is not taken out)
--   ingredients.sold    = cost of the stock the month's sales took, minus what
--                         refunds / voids put back (stock lines of the month)
--   ingredients.wasted  = cost of the month's waste stock lines (counter and Back Office)
--   ingredients.used    = sold + wasted
--   expenses.total / by_category = the month's expenses log
--   net_income = sales.net - ingredients.used - expenses.total
-- Costs per unit: _ingredient_unit_cost as of the month's last day.
-- Stock counts (adjustments) and production are not costs here (production
-- turns ingredients into house-made items, which are costed when sold).
create or replace function public.net_income_report(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_biz uuid := public._require_owner();
  v_tz text; v_from date; v_to date; v_from_ts timestamptz; v_to_ts timestamptz;
  v_gross numeric; v_tax numeric; v_svc numeric; v_count integer; v_ref numeric;
  v_sold numeric; v_wasted numeric; v_exp numeric; v_by jsonb;
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
  select coalesce(sum(r.amount), 0) into v_ref
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
  select coalesce(sum(amount), 0) into v_exp from public.expenses
    where business_id = v_biz and expense_date between v_from and v_to;
  select coalesce(jsonb_object_agg(category, round(t, 2)), '{}'::jsonb) into v_by
    from (select category, sum(amount) as t from public.expenses
          where business_id = v_biz and expense_date between v_from and v_to group by category) x;
  return jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'), 'from', v_from, 'to', v_to,
    'sales', jsonb_build_object('gross', round(v_gross, 2), 'refunds', round(v_ref, 2), 'net', round(v_gross - v_ref, 2),
                                'tax', round(v_tax, 2), 'service_charge', round(v_svc, 2), 'count', v_count),
    'ingredients', jsonb_build_object('sold', round(v_sold, 2), 'wasted', round(v_wasted, 2), 'used', round(v_sold + v_wasted, 2)),
    'expenses', jsonb_build_object('total', round(v_exp, 2), 'by_category', v_by),
    'net_income', round(v_gross - v_ref, 2) - round(v_sold + v_wasted, 2) - round(v_exp, 2));
end $$;

-- =============================================================================
-- 11. BACK OFFICE: writable tables, start-up data
-- =============================================================================
-- Same as 008, plus the option library, expenses and the waste log (the last
-- for backup / import only: counters write it through fo_sync).
create or replace function public._writable_tables() returns text[]
language sql immutable as $$
  select array['categories','suppliers','ingredients','recipes','recipe_ingredients','purchases','production_batches',
    'waste','inventory_transactions','settings','stores','dining_tables','staff','devices','customers','sales',
    'sale_items','payments','refunds','shifts','cash_movements','audit_log','qr_orders','businesses',
    'ingredient_brands','floor_shapes','loyalty_redemptions',
    'option_groups','option_group_recipes','expenses','waste_logs','waste_log_items']
$$;

-- Back Office start-up data: same as 009, plus option_groups and option_group_recipes (010).
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
    'customer_count', (select count(*) from public.customers where business_id = v_biz and merged_into is null),
    -- 009: shifts still open for more than 24 hours (they no longer keep the QR
    -- page open, but they still block Start fresh until someone closes them)
    'stale_open_shifts', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'shift_number', x.shift_number,
                              'cashier_id', x.cashier_id, 'cashier_name', x.cashier_name, 'device_id', x.device_id,
                              'device_name', (select d.device_name from public.devices d where d.id = x.device_id),
                              'opened_at', coalesce(x.opened_at, x.created_at)) order by coalesce(x.opened_at, x.created_at))
                            from public.shifts x
                            where x.business_id = v_biz and x.status = 'ACTIVE'
                              and coalesce(x.opened_at, x.created_at) <= now() - interval '24 hours'), '[]'::jsonb),
    -- 010: the option library and the per-item ticks
    'option_groups', coalesce((select jsonb_agg(to_jsonb(g) order by g.sort_order, lower(g.name))
                               from public.option_groups g where g.business_id = v_biz), '[]'::jsonb),
    'option_group_recipes', coalesce((select jsonb_agg(to_jsonb(x)) from public.option_group_recipes x where x.business_id = v_biz), '[]'::jsonb)
  );
end $$;

-- QR ordering: same as 009; each chosen option now also carries its kind, extras and removes (010).
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
  -- 009: closed when no counter has an open shift
  if not public._shop_is_open(v_t.business_id) then return jsonb_build_object('error', 'SHOP_CLOSED'); end if;
  select customer_id into v_cid from public.customer_devices where auth_user_id = v_uid and business_id = v_t.business_id;
  if v_cid is null then return jsonb_build_object('error', 'REGISTER_FIRST'); end if;
  select * into v_c from public.customers where id = v_cid;

  select count(*) into v_count from public.qr_orders
    where auth_user_id = v_uid and business_id = v_t.business_id and status in ('PENDING','PREPARING','READY') and paid_at is null;
  if v_count >= 3 then return jsonb_build_object('error', 'TOO_MANY_OPEN_ORDERS'); end if;
  select count(*) into v_count from public.qr_orders where auth_user_id = v_uid and created_at > now() - interval '1 hour';
  if v_count >= 10 then return jsonb_build_object('error', 'TOO_MANY_ORDERS'); end if;
  -- Shop-wide limits (section 13a of 004). Orders of one shop are placed one at a time
  -- (advisory lock), so two phones at the same moment can't both slip past a limit.
  perform pg_advisory_xact_lock(hashtext('cccc.qr_order:' || v_t.business_id::text));
  select count(*) into v_count from public.qr_orders where table_id = v_t.id and status = 'PENDING';
  if v_count >= (public._qr_limits()->>'table_open_orders')::int then return jsonb_build_object('error', 'TOO_MANY_ORDERS'); end if;
  select count(*) into v_count from public.qr_orders where business_id = v_t.business_id and created_at > now() - interval '10 minutes';
  if v_count >= (public._qr_limits()->>'shop_orders_10min')::int then return jsonb_build_object('error', 'TOO_MANY_ORDERS'); end if;

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
        'ingredient_id', nullif(v_o->>'ingredient_id', ''), 'ingredient_qty_delta', coalesce((v_o->>'ingredient_qty_delta')::numeric, 0))
        -- 010: an option's stock (several extras, or a swap) travels with the order
        -- so the counter deducts the same stock when it is paid
        || case when jsonb_typeof(v_o->'extras') = 'array' then jsonb_build_object('extras', v_o->'extras') else '{}'::jsonb end
        || case when jsonb_typeof(v_o->'removes') = 'array' then jsonb_build_object('removes', v_o->'removes') else '{}'::jsonb end
        || case when v_o ? 'kind' then jsonb_build_object('kind', v_o->'kind') else '{}'::jsonb end);
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

-- =============================================================================
-- 12. ROW LEVEL SECURITY for the new tables
-- =============================================================================
--   option_groups, option_group_recipes: everyone of the shop reads (like
--     recipes; nothing secret: the options are copied into the recipes anyway);
--     only the owner writes (apply_changes).
--   expenses: only the owner reads and writes.
--   waste_logs, waste_log_items: office data (like purchases): logins with a
--     staff-type profile (the owner's email login) read them; counters write
--     them only through fo_sync; the owner may write them for backup / import.
do $$
declare t text; p record;
begin
  foreach t in array array['option_groups','option_group_recipes','expenses','waste_logs','waste_log_items'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    if t in ('option_groups', 'option_group_recipes') then
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()))', t || '_read', t);
    elsif t = 'expenses' then
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_read', t);
    else
      execute format('create policy %I on public.%I for select to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 1)', t || '_read', t);
    end if;
    execute format('create policy %I on public.%I for insert to authenticated with check (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_admin_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3) with check (business_id = (select public.current_business_id()))', t || '_admin_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3)', t || '_admin_delete', t);
    -- customers (anonymous logins) and the public never touch them directly
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- =============================================================================
-- Who may call the new / re-made functions
-- =============================================================================
-- Every function this script makes is first locked, then opened only where meant:
--   logged-in users (each checks the caller's shop / role itself):
--     merge_ingredients_preview, merge_ingredients, save_supplied_item,
--     waste_report, net_income_report (owner only, checked inside),
--     bo_bootstrap (as in 004)
--   anyone with a table QR code: qr_place_order (as in 004)
--   everything else here is internal (no API access). fo_sync itself is not
--   re-made (it calls _fo_apply).
do $$
declare f record;
  mine text[] := array['_unit_family','_unit_factor','_to_base_qty','_ingredient_check','_recipe_line_check',
    '_ingredient_units_changed','_library_group_problem','_option_group_check','_option_group_recipe_check',
    '_option_extras','_library_groups_for','_recipe_options_build','_library_changed','_public_modifier_groups',
    '_merge_target','_ingredient_final','_is_expense_item','_clean_stock_lines','_recipe_stock_lines',
    '_ingredient_unit_cost','_expense_item_check','_fo_error_code','_fo_apply','_jsonb_swap_ingredient',
    '_free_brand_name','_merge_plan','merge_ingredients_preview','merge_ingredients','save_supplied_item',
    'waste_report','net_income_report','_writable_tables','bo_bootstrap','qr_place_order'];
  member_fns text[] := array['merge_ingredients_preview','merge_ingredients','save_supplied_item','waste_report',
    'net_income_report','bo_bootstrap'];
  public_fns text[] := array['qr_place_order'];
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

-- Existing recipes get their options rebuilt once (nothing changes until the
-- owner adds library groups; own options with "extras" are tidied).
update public.recipes set modifier_groups = modifier_groups
  where modifier_groups::text like '%"extras"%' or modifier_groups::text like '%"lib\_%';

commit;

-- Tell the API about the new tables / functions right away.
notify pgrst, 'reload schema';
