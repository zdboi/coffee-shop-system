-- =============================================================================
-- Cavite City Coffee Club — 014: release 1.6.1 (profit split)
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004 … 013 (all already done). It is safe to run more than
-- once. It runs inside one transaction: if anything fails, nothing is changed.
--
-- What it adds (owner decision 2026-11-13):
--   settings.profit_split: how net income is shared, for the Back Office's
--   "Investors & start-up" page (information only, nothing is paid out):
--     {"investors_pct": 30, "managers_pct": 20, "shop_pct": 50, "managers": ["Jake", "Zed"]}
--   - investors_pct: shared among the investors by the amounts they put in
--   - managers_pct:  shared equally among the managers named in "managers"
--                    (a manager who also invested gets both parts)
--   - shop_pct:      kept by the coffee shop
--   The three must add up to 100. Owner only (settings are owner-only already).
-- =============================================================================

begin;

alter table public.settings add column if not exists profit_split jsonb not null default
  '{"investors_pct": 30, "managers_pct": 20, "shop_pct": 50, "managers": []}'::jsonb;

-- true when p is a good profit split (see above).
create or replace function public._valid_profit_split(p jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
declare k text; v numeric; t numeric := 0; m jsonb; names text[] := '{}'; n text;
begin
  if jsonb_typeof(p) is distinct from 'object' then return false; end if;
  -- only these four keys
  if exists (select 1 from jsonb_object_keys(p) x where x not in ('investors_pct', 'managers_pct', 'shop_pct', 'managers')) then return false; end if;
  foreach k in array array['investors_pct', 'managers_pct', 'shop_pct'] loop
    if jsonb_typeof(p->k) is distinct from 'number' then return false; end if;
    v := (p->>k)::numeric;
    if v < 0 or v > 100 then return false; end if;
    t := t + v;
  end loop;
  if abs(t - 100) > 0.001 then return false; end if;
  m := p->'managers';
  if jsonb_typeof(m) is distinct from 'array' or jsonb_array_length(m) > 10 then return false; end if;
  for n in select value #>> '{}' from jsonb_array_elements(m) loop
    if n is null or length(btrim(n)) not between 1 and 80 or n ~ '[\x01-\x1F\x7F]' then return false; end if;
    if lower(btrim(n)) = any(names) then return false; end if;
    names := names || lower(btrim(n));
  end loop;
  if exists (select 1 from jsonb_array_elements(m) e where jsonb_typeof(e) <> 'string') then return false; end if;
  return true;
exception when others then
  return false;
end $$;

-- BAD_PROFIT_SPLIT = the three parts don't add up to 100, a part is outside
-- 0..100, or a manager's name is empty, too long or there twice.
create or replace function public._settings_profit_split_check() returns trigger
language plpgsql set search_path = public as $$
begin
  if not public._valid_profit_split(new.profit_split) then raise exception 'BAD_PROFIT_SPLIT'; end if;
  -- tidy the names (trimmed)
  new.profit_split := jsonb_set(new.profit_split, '{managers}',
    coalesce((select jsonb_agg(btrim(e #>> '{}') order by o) from jsonb_array_elements(new.profit_split->'managers') with ordinality x(e, o)), '[]'::jsonb));
  return new;
end $$;
drop trigger if exists settings_profit_split_check on public.settings;
create trigger settings_profit_split_check before insert or update of profit_split on public.settings
  for each row execute function public._settings_profit_split_check();

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('_valid_profit_split', '_settings_profit_split_check')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

commit;

-- Tell the API about the new column right away.
notify pgrst, 'reload schema';
