-- =============================================================================
-- Cavite City Coffee Club — 006: let counters upload their work again
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004 and 005. It is safe to run more than once. It runs inside
-- one transaction: if anything fails, nothing is changed.
--
-- What it fixes, in plain words:
--   Every counter upload (start shift, sale, pay-in/out, ...) failed with
--     new row for relation "sync_operations" violates check constraint
--     "sync_operations_operation_type_check"
--   The server keeps a receipt of every upload in the table sync_operations,
--   so the same upload is never applied twice. Its "operation_type" column
--   has an old rule from the first version of the app that only allows
--   'INSERT', 'UPDATE' or 'DELETE'. Our server writes the kind of upload
--   there instead ('shift_open', 'sale', 'refund', ...), so the rule refused it.
--
--   This script replaces that rule with one that allows:
--     * the old words 'INSERT', 'UPDATE', 'DELETE',
--     * every kind of counter upload: shift_open, shift_close, cash_movement,
--       sale, held_delete, refund, audit, sold_out,
--     * every word ALREADY stored in that column, so no existing row breaks.
--
-- What it does NOT change: no data, no functions, no permissions.
-- (Checked at the same time, nothing to fix: the server never writes a pay-in /
--  pay-out of ₱0 or less itself, and never writes reconciliation_issues.status.)
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Allowed-values rule on sync_operations.operation_type
-- -----------------------------------------------------------------------------
-- Same steps as 005:
--   a) find EVERY check rule on the column, whatever it is called, and drop it;
--   b) collect the words already stored in the column (ignoring empty values);
--   c) add one rule named sync_operations_operation_type_check that allows
--      (our words + stored words). Empty values (NULL) stay allowed.
-- If the table or column doesn't exist, nothing is done.
do $$
declare
  c_tbl text := 'sync_operations';
  c_col text := 'operation_type';
  c_wanted text[] := array[
    'INSERT', 'UPDATE', 'DELETE',                                 -- old app words
    'shift_open', 'shift_close', 'cash_movement', 'sale',         -- counter upload kinds
    'held_delete', 'refund', 'audit', 'sold_out'];
  r record;
  v_tbl regclass := to_regclass(format('public.%I', c_tbl));
  v_vals text[];
  v_list text;
begin
  if v_tbl is null or not exists (
       select 1 from pg_attribute
       where attrelid = v_tbl and attname = c_col and attnum > 0 and not attisdropped) then
    raise notice '006: skipped %.% (not in this database)', c_tbl, c_col;
    return;
  end if;

  -- Hold the table still while we swap the rule, so no row sneaks in between
  -- "read the stored words" and "add the new rule".
  execute format('lock table %s in access exclusive mode', v_tbl);

  -- a) drop every check rule that looks at this column
  for r in
    select c.conname from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.conrelid = v_tbl and c.contype = 'c' and a.attname = c_col
  loop
    execute format('alter table %s drop constraint %I', v_tbl, r.conname);
    raise notice '006: dropped % on %.%', r.conname, c_tbl, c_col;
  end loop;

  -- b) our words + the words already stored, without duplicates
  execute format('select array(select distinct v from (select unnest($1) as v union select %I::text from %s where %I is not null) x order by v)',
                 c_col, v_tbl, c_col)
    into v_vals using c_wanted;
  select string_agg(quote_literal(v), ', ') into v_list from unnest(v_vals) as v;

  -- c) the new rule
  execute format('alter table %s add constraint %I check (%I in (%s))',
                 v_tbl, c_tbl || '_' || c_col || '_check', c_col, v_list);
  raise notice '006: %.% now allows %', c_tbl, c_col, v_list;
end $$;

commit;

-- Tell the API to refresh (harmless if nothing it knows about changed).
notify pgrst, 'reload schema';
