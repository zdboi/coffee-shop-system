-- =============================================================================
-- Cavite City Coffee Club — 005: fixes found on the live database
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004 (already done on 2026-10-20). It is safe to run more than
-- once. It runs inside one transaction: if anything fails, nothing is changed.
--
-- What it fixes, in plain words:
--   Pairing a counter failed with
--     new row for relation "devices" violates check constraint
--     "devices_device_type_check"
--   The live database has an old rule ("CHECK constraint") that only allows a
--   few words in devices.device_type, and 'COUNTER' (what pairing writes) is
--   not one of them.
--
--   This script replaces such rules with a new one that allows:
--     * every word our apps write (for devices: 'COUNTER', plus 'BACK_OFFICE'
--       and 'KITCHEN' for later), and
--     * every word ALREADY stored in that column, so no existing row breaks.
--   The rule is rebuilt from what is in the table each time the script runs,
--   so running it twice gives the same result.
--
-- What it does NOT change: no data, no functions, no permissions.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Allowed-values rules ("CHECK constraints")
-- -----------------------------------------------------------------------------
-- For each (table, column, words our apps need) listed below:
--   a) find EVERY check rule on that column, whatever it is called, and drop it;
--   b) collect the words already stored in the column (ignoring empty values);
--   c) add one rule named <table>_<column>_check that allows (our words +
--      stored words). Empty values (NULL) stay allowed, as before.
-- "always" = true: add the rule even if the column had none (devices.device_type).
-- "always" = false: only REPLACE a rule that already exists; a column without
--   one is left free, so this script never adds new limits there.
-- A table or column that doesn't exist is skipped (nothing to fix there).
do $$
declare
  spec record;
  r record;
  v_tbl regclass;
  v_vals text[];
  v_list text;
  v_had boolean;
begin
  for spec in
    select * from (values
      -- table      column         always  words our apps write (or will write)
      ('devices',  'device_type',  true,   array['COUNTER','BACK_OFFICE','KITCHEN'])
    ) as s(tbl, col, always, wanted)
  loop
    v_tbl := to_regclass(format('public.%I', spec.tbl));
    if v_tbl is null or not exists (
         select 1 from pg_attribute
         where attrelid = v_tbl and attname = spec.col and attnum > 0 and not attisdropped) then
      raise notice '005: skipped %.% (not in this database)', spec.tbl, spec.col;
      continue;
    end if;

    -- Hold the table still while we swap the rule, so no row sneaks in between
    -- "read the stored words" and "add the new rule".
    execute format('lock table %s in access exclusive mode', v_tbl);

    -- a) drop every check rule that looks at this column
    v_had := false;
    for r in
      select c.conname from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.conrelid = v_tbl and c.contype = 'c' and a.attname = spec.col
    loop
      execute format('alter table %s drop constraint %I', v_tbl, r.conname);
      raise notice '005: dropped % on %.%', r.conname, spec.tbl, spec.col;
      v_had := true;
    end loop;
    if not v_had and not spec.always then
      raise notice '005: %.% has no rule, left as it is', spec.tbl, spec.col;
      continue;
    end if;

    -- b) our words + the words already stored, without duplicates
    execute format('select array(select distinct v from (select unnest($1) as v union select %I::text from %s where %I is not null) x order by v)',
                   spec.col, v_tbl, spec.col)
      into v_vals using spec.wanted;
    select string_agg(quote_literal(v), ', ') into v_list from unnest(v_vals) as v;

    -- c) the new rule
    execute format('alter table %s add constraint %I check (%I in (%s))',
                   v_tbl, spec.tbl || '_' || spec.col || '_check', spec.col, v_list);
    raise notice '005: %.% now allows %', spec.tbl, spec.col, v_list;
  end loop;
end $$;

commit;

-- Tell the API to refresh (harmless if nothing it knows about changed).
notify pgrst, 'reload schema';
