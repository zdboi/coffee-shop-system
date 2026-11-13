-- Part 3 security audit, item B8: the TWO-ACCOUNT TEST (Z, 2026-11-14, baseline for the
-- "security hardening" release). Copies shop A's ids and tries to read / change / delete
-- them as every other kind of login:
--   another shop's owner (email, ADMIN of shop B), shop B's counter (device login) with and
--   without a cashier / manager PIN session, shop A's OWN counter (rank 0: reads some, writes
--   nothing), QR customers (registered in A, another registered customer of A, a guest of A,
--   a customer of shop B), a stray anonymous login that never did anything, and no login
--   at all (Postgres role anon).
-- Every table in public is probed (one row per shop is put in each table first, so no probe
-- is empty), plus the API-callable functions that take ids.
-- Needs a FRESH database (it makes its own two shops):
--   tests/reset_db.sh "" db_rev_b8 && psql -h /tmp -p 54329 -U postgres -d db_rev_b8 -v ON_ERROR_STOP=1 -f tests/sql/45_audit_two_account_tests.sql
-- Prints "ok  ..." / "FAIL ..." for every check and keeps going (run_all.sh: run_sql_lines).
\set QUIET on
create schema if not exists test;
create table if not exists test.results(n serial, line text);
truncate test.results;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', case when p_token is null then '{}' else json_build_object('x-staff-token', p_token)::text end, false);
end $$;
create or replace function test.chk(cond boolean, msg text, got text default null) returns void language sql as $$
  insert into test.results(line) select case when coalesce(cond, false) then 'ok  ' || msg else 'FAIL ' || msg || coalesce('   [got: ' || left(got, 300) || ']', '') end
$$;
-- run p_sql as login p_uid under Postgres role p_role; $1 = p_biz, $2 = p_row.
-- Answer: 'ROWS:<n>' (rows read / changed; a change is ALWAYS rolled back) or 'ERR:<message>'.
create or replace function test.probe(p_uid uuid, p_role text, p_sql text, p_biz uuid default null, p_row jsonb default null)
returns text language plpgsql as $$
declare n bigint; r text;
begin
  perform test.login(p_uid);
  execute format('set role %I', p_role);
  begin
    if p_sql ~* '^\s*select' then
      execute p_sql into n using p_biz, p_row; r := 'ROWS:' || coalesce(n, 0);
    else
      execute p_sql using p_biz, p_row; get diagnostics n = row_count;
      raise exception 'PROBE_ROLLBACK:%', n;
    end if;
  exception when others then
    if sqlerrm like 'PROBE_ROLLBACK:%' then r := 'ROWS:' || split_part(sqlerrm, ':', 2); else r := 'ERR:' || sqlerrm; end if;
  end;
  reset role;
  perform test.login(null);
  return r;
end $$;
-- call an API function as a login (role authenticated, or anon when p_uid is null); answer = its jsonb as text, or ERR:<message>
create or replace function test.rpc(p_uid uuid, p_sql text, p_token text default null) returns text language plpgsql as $$
declare r text;
begin
  perform test.login(p_uid, p_token);
  execute format('set role %I', case when p_uid is null then 'anon' else 'authenticated' end);
  begin
    execute p_sql into r;
  exception when others then r := 'ERR:' || sqlerrm;
  end;
  reset role;
  perform test.login(null);
  return coalesce(r, 'NULL');
end $$;
-- one fo_sync op (as the device login) -> its {status, message}
create or replace function test.op(p_uid uuid, p_key text, p_type text, p_data jsonb) returns text language plpgsql as $$
begin
  return test.rpc(p_uid, format('select (public.fo_sync(%L, jsonb_build_array(jsonb_build_object(''op_id'', gen_random_uuid(), ''type'', %L, ''data'', %L::jsonb)))->0)::text',
                                p_key, p_type, p_data::text));
end $$;
-- put one made-up row for shop p_biz into table p_tbl (as the superuser, triggers and foreign
-- keys off), unless the shop already has one. Fills NOT NULL columns by type and retries with
-- the first value a CHECK rule allows.
create or replace function test.fill(p_tbl text, p_biz uuid) returns text language plpgsql as $$
declare a record; cols text[]; vals text[]; ov jsonb := '{}'; tries integer := 0; cname text; cdef text; lit text; ccol text; v text; t text;
begin
  if not exists (select 1 from pg_attribute where attrelid = format('public.%I', p_tbl)::regclass and attname = 'business_id' and not attisdropped) then
    return 'no business_id';
  end if;
  execute format('select count(*) > 0 from public.%I where business_id = $1', p_tbl) into a using p_biz;
  if (select a::text) = '(t)' then return 'have'; end if;
  loop
    tries := tries + 1; cols := '{}'; vals := '{}';
    for a in select attname::text as n, format_type(atttypid, atttypmod) as ty, attnotnull, atthasdef
             from pg_attribute where attrelid = format('public.%I', p_tbl)::regclass and attnum > 0 and not attisdropped and attgenerated = '' and attidentity = ''
             order by attnum loop
      t := a.ty;
      if a.n = 'business_id' then v := quote_literal(p_biz) || '::uuid';
      elsif ov ? a.n then v := quote_literal(ov->>a.n) || '::' || t;
      elsif a.attnotnull and not a.atthasdef then
        v := case when t = 'uuid' then 'gen_random_uuid()'
                  when t in ('text', 'character varying') or t like 'character%' then '''x'''
                  when t in ('numeric', 'integer', 'bigint', 'smallint', 'real', 'double precision') or t like 'numeric%' then '1'
                  when t = 'boolean' then 'false' when t = 'date' then 'current_date'
                  when t like 'timestamp%' then 'now()' when t in ('jsonb', 'json') then '''{}''::' || t
                  when t like '%[]' then '''{}''::' || t else 'null' end;
      else continue;
      end if;
      cols := cols || quote_ident(a.n); vals := vals || v;
    end loop;
    begin
      execute format('insert into public.%I (%s) values (%s)', p_tbl, array_to_string(cols, ','), array_to_string(vals, ','));
      return 'filled';
    exception when check_violation or not_null_violation or invalid_text_representation then
      if tries > 10 then return 'FAILED: ' || sqlerrm; end if;
      get stacked diagnostics cname = constraint_name, ccol = column_name;
      if ccol is not null and ccol <> '' then   -- not null with a default that is null... give it a value
        ov := ov || jsonb_build_object(ccol, 'x'); continue;
      end if;
      select pg_get_constraintdef(c.oid), (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1])
        into cdef, ccol from pg_constraint c where c.conrelid = format('public.%I', p_tbl)::regclass and c.conname = cname;
      lit := substring(cdef from '''([^'']*)''');
      if ccol is null then return 'FAILED: ' || sqlerrm; end if;
      if lit is null or ov->>ccol = lit then
        lit := case when cdef ~* 'array' then '[]' when cdef ~ '> *\(?0' then '1' else '1' end;
        if ov->>ccol = lit then return 'FAILED: ' || sqlerrm || ' / ' || cdef; end if;
      end if;
      ov := ov || jsonb_build_object(ccol, lit);
    when others then
      return 'FAILED: ' || sqlerrm;
    end;
  end loop;
end $$;
grant usage on schema test to anon, authenticated;
grant execute on all functions in schema test to anon, authenticated;
\set QUIET off
\pset tuples_only on
\pset format unaligned

-- ============================ the cast ============================
\set ownA  'a0000000-0000-0000-0000-00000000a001'
\set ownB  'b0000000-0000-0000-0000-00000000b001'
\set devA  'a0000000-0000-0000-0000-00000000d001'
\set devB  'b0000000-0000-0000-0000-00000000d001'
\set qrA1  'a0000000-0000-0000-0000-00000000c001'
\set qrA2  'a0000000-0000-0000-0000-00000000c002'
\set guestA 'a0000000-0000-0000-0000-00000000c003'
\set qrB1  'b0000000-0000-0000-0000-00000000c001'
\set stray 'f0000000-0000-0000-0000-00000000ffff'
\set keyA 'b8-device-key-shop-a-0001'
\set keyB 'b8-device-key-shop-b-0001'
\set cashA 'a0000000-0000-0000-0000-0000000005a1'
\set mgrA  'a0000000-0000-0000-0000-0000000005a2'
\set cashB 'b0000000-0000-0000-0000-0000000005b1'
\set mgrB  'b0000000-0000-0000-0000-0000000005b2'
\set recA  'a0000000-0000-0000-0000-0000000003a1'
\set recB  'b0000000-0000-0000-0000-0000000003b1'
\set ingA  'a0000000-0000-0000-0000-0000000002a1'
\set shiftA 'a0000000-0000-0000-0000-0000000008a1'
\set shiftB 'b0000000-0000-0000-0000-0000000008b1'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'ownA', 'b8-owner-a@example.com', '{"business_name":"Shop A","admin_name":"Ana"}'),
  (:'ownB', 'b8-owner-b@example.com', '{"business_name":"Shop B","admin_name":"Ben"}');
insert into auth.users (id, is_anonymous) select x::uuid, true from unnest(array[:'devA', :'devB', :'qrA1', :'qrA2', :'guestA', :'qrB1', :'stray']) x;
select business_id as biza from profiles where id = :'ownA' \gset
select business_id as bizb from profiles where id = :'ownB' \gset
insert into staff(id, business_id, name, role) values
  (:'cashA', :'biza', 'Cora A', 'CASHIER'), (:'mgrA', :'biza', 'Mio A', 'MANAGER'),
  (:'cashB', :'bizb', 'Cid B', 'CASHIER'), (:'mgrB', :'bizb', 'Max B', 'MANAGER');
insert into recipes(id, business_id, name, recipe_type, selling_price) values
  (:'recA', :'biza', 'Latte A', 'DRINKS', 150), (:'recB', :'bizb', 'Latte B', 'DRINKS', 140);
insert into ingredients(id, business_id, name, base_unit) values (:'ingA', :'biza', 'Beans A', 'g');
insert into dining_tables(business_id, label, kind, qr_token) values (:'biza', 'Table A1', 'DINE_IN', 'b8-token-shop-a-1'), (:'bizb', 'Table B1', 'DINE_IN', 'b8-token-shop-b-1');
insert into device_pairing_codes(code, business_id, device_name, expires_at) values ('B8PAIRA', :'biza', 'Front A', now() + interval '1 hour'), ('B8PAIRB', :'bizb', 'Front B', now() + interval '1 hour');
-- PINs set by each owner; counters paired with codes; shifts opened by the counters
select test.rpc(:'ownA', format('select public.staff_set_pin(%L, ''1111'')::text', :'cashA')) || test.rpc(:'ownA', format('select public.staff_set_pin(%L, ''222222'')::text', :'mgrA'))
    || test.rpc(:'ownB', format('select public.staff_set_pin(%L, ''3333'')::text', :'cashB')) || test.rpc(:'ownB', format('select public.staff_set_pin(%L, ''444444'')::text', :'mgrB')) as pins \gset
select test.chk(:'pins' = '{"ok": true}{"ok": true}{"ok": true}{"ok": true}', 'setup: PINs set by each owner', :'pins');
select test.chk(test.rpc(:'devA', format('select public.redeem_device_pairing(''B8PAIRA'', %L, ''Front A'')::text', :'keyA')) like '{"device"%', 'setup: counter A paired');
select test.chk(test.rpc(:'devB', format('select public.redeem_device_pairing(''B8PAIRB'', %L, ''Front B'')::text', :'keyB')) like '{"device"%', 'setup: counter B paired');
select test.chk(test.op(:'devA', :'keyA', 'shift_open', jsonb_build_object('id', :'shiftA', 'cashier_id', :'cashA', 'opened_at', now(), 'opening_cash', 500)) like '%"ok"%', 'setup: shift A open');
select test.chk(test.op(:'devB', :'keyB', 'shift_open', jsonb_build_object('id', :'shiftB', 'cashier_id', :'cashB', 'opened_at', now(), 'opening_cash', 500)) like '%"ok"%', 'setup: shift B open');
-- staff PIN sessions on the counters (sign-in tokens) and a one-time manager approval
select test.rpc(:'devA', 'select public.staff_pin_login(''1111'')->>''token''') as tok_casha \gset
select test.rpc(:'devA', 'select public.staff_pin_login(''222222'')->>''token''') as tok_mgra \gset
select test.rpc(:'devB', 'select public.staff_pin_login(''3333'')->>''token''') as tok_cashb \gset
select test.rpc(:'devB', 'select public.staff_pin_login(''444444'')->>''token''') as tok_mgrb \gset
select test.rpc(:'devA', 'select public.staff_pin_login(''222222'', ''OVERRIDE'', ''MANAGER'')->>''token''') as appr_mgra \gset
select test.chk(length(:'tok_casha') = 64 and length(:'tok_mgra') = 64 and length(:'tok_cashb') = 64 and length(:'tok_mgrb') = 64 and length(:'appr_mgra') = 64, 'setup: PIN sessions + approval token made');
-- QR customers: two registered in A, one guest in A, one registered in B
select test.chk(test.rpc(:'qrA1', 'select public.qr_register(''b8-token-shop-a-1'', ''Alma'', ''0917 111 0001'', true)::text') like '{"customer"%', 'setup: QR customer A1 registered');
select test.chk(test.rpc(:'qrA2', 'select public.qr_register(''b8-token-shop-a-1'', ''Bea'', ''0917 111 0002'', true)::text') like '{"customer"%', 'setup: QR customer A2 registered');
select test.chk(test.rpc(:'qrB1', 'select public.qr_register(''b8-token-shop-b-1'', ''Cora'', ''0917 222 0001'', true)::text') like '{"customer"%', 'setup: QR customer B1 registered');
select test.rpc(:'qrA1', format('select (public.qr_place_order(''b8-token-shop-a-1'', ''[{"recipe_id":"%s","quantity":1}]''::jsonb)->''order''->>''id'')', :'recA')) as orda1 \gset
select test.rpc(:'guestA', format('select (public.qr_place_order(''b8-token-shop-a-1'', ''[{"recipe_id":"%s","quantity":1}]''::jsonb, null, null, true)->''order''->>''id'')', :'recA')) as ordg \gset
select test.chk(:'orda1' ~ '^[0-9a-f-]{36}$' and :'ordg' ~ '^[0-9a-f-]{36}$', 'setup: QR orders placed (A1 registered, guest)', :'orda1' || ' / ' || :'ordg');
select id as custa1 from customers where business_id = :'biza' and nickname = 'Alma' \gset
select id as custb1 from customers where business_id = :'bizb' and nickname = 'Cora' \gset
select id as devrowa from devices where auth_user_id = :'devA' \gset

-- one row per shop in EVERY table (made-up values; triggers + foreign keys off for this only)
set session_replication_role = replica;
select test.chk(not exists (select 1 from (select c.relname, test.fill(c.relname, b) r from pg_class c, unnest(array[:'biza', :'bizb']::uuid[]) b
                                           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') x where r like 'FAILED%'),
                'setup: one row per shop put in every table that has a business_id',
                (select string_agg(relname || ': ' || r, '; ') from (select c.relname, test.fill(c.relname, b) r from pg_class c, unnest(array[:'biza', :'bizb']::uuid[]) b
                  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') x where r like 'FAILED%'));
set session_replication_role = origin;
-- the rows of shop A, kept as templates for the "write a copy into shop A" probes
create temp table b8_tables as
  select c.relname::text t from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped);
create temp table b8_tpl(t text, rowj jsonb, cols text);
do $$ declare r record; j jsonb; begin
  for r in select t from b8_tables loop
    execute format('select to_jsonb(x) from public.%I x where business_id = $1 limit 1', r.t) into j using (select business_id from public.profiles where id = 'a0000000-0000-0000-0000-00000000a001');
    if j ? 'id' then j := j || jsonb_build_object('id', gen_random_uuid()); end if;
    -- columns a client could send (not identity / generated)
    insert into b8_tpl values (r.t, j, (select string_agg(quote_ident(attname), ',' order by attnum) from pg_attribute
      where attrelid = format('public.%I', r.t)::regclass and attnum > 0 and not attisdropped and attgenerated = '' and attidentity = ''));
  end loop; end $$;
select test.chk((select count(*) from b8_tpl where rowj is not null) = (select count(*) from b8_tables), 'setup: shop A has a row in each of the ' || (select count(*) from b8_tables) || ' shop tables');
grant select on b8_tpl, b8_tables to anon, authenticated;

-- ============================ 1. tables: other logins vs shop A's rows ============================
-- who: shop B owner, shop B counter, A's QR customers / guest, shop B's QR customer, a stray anonymous login, no login (anon role)
create temp table b8_who(label text, uid uuid, role text);
insert into b8_who values ('shop B owner', :'ownB', 'authenticated'), ('shop B counter', :'devB', 'authenticated'),
  ('QR customer A1', :'qrA1', 'authenticated'), ('QR customer A2', :'qrA2', 'authenticated'), ('QR guest of A', :'guestA', 'authenticated'),
  ('QR customer of B', :'qrB1', 'authenticated'), ('stray anonymous login', :'stray', 'authenticated'), ('no login (anon)', null, 'anon');
create temp table b8_out(label text, t text, kind text, res text);
do $$ declare w record; r record; biza uuid := (select business_id from public.profiles where id = 'a0000000-0000-0000-0000-00000000a001'); begin
  for w in select * from b8_who loop
    for r in select b.t, p.rowj, p.cols from b8_tables b join b8_tpl p on p.t = b.t loop
      insert into b8_out values (w.label, r.t, 'read',   test.probe(w.uid, w.role, format('select count(*) from public.%I where business_id = $1', r.t), biza));
      insert into b8_out values (w.label, r.t, 'update', test.probe(w.uid, w.role, format('update public.%I set business_id = business_id where business_id = $1', r.t), biza));
      insert into b8_out values (w.label, r.t, 'delete', test.probe(w.uid, w.role, format('delete from public.%I where business_id = $1', r.t), biza));
      insert into b8_out values (w.label, r.t, 'insert', test.probe(w.uid, w.role, format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I, $2)', r.t, r.cols), biza, r.rowj));
    end loop;
    insert into b8_out values (w.label, 'businesses', 'read',   test.probe(w.uid, w.role, 'select count(*) from public.businesses where id = $1', biza));
    insert into b8_out values (w.label, 'businesses', 'update', test.probe(w.uid, w.role, 'update public.businesses set name = name where id = $1', biza));
    insert into b8_out values (w.label, 'businesses', 'delete', test.probe(w.uid, w.role, 'delete from public.businesses where id = $1', biza));
  end loop; end $$;
select test.chk(count(*) filter (where res not in ('ROWS:0') and res not like 'ERR:%') = 0,
                '1. ' || label || ': reads / changes / deletes / inserts NOTHING of shop A in ' || count(distinct t) || ' tables (' || count(*) || ' probes)',
                string_agg(case when res not in ('ROWS:0') and res not like 'ERR:%' then t || ' ' || kind || ' ' || res end, ', '))
  from b8_out group by label order by label;
-- an insert must be refused (an error), not just "0 rows"
select test.chk(count(*) filter (where res not like 'ERR:%') = 0, '1. ' || label || ': every insert of a copy into shop A is refused with an error',
                string_agg(case when res not like 'ERR:%' then t || ' ' || res end, ', '))
  from b8_out where kind = 'insert' group by label order by label;
select test.chk(count(*) filter (where res not like 'ERR:%permission denied%') = 0, '1. no login (anon role): permission denied on every table (no grants at all)',
                string_agg(case when res not like 'ERR:%permission denied%' then t || ' ' || kind || ' ' || res end, ', '))
  from b8_out where label = 'no login (anon)';

-- 1b. shop B's owner can't move its own rows INTO shop A (WITH CHECK)
create temp table b8_move(t text, res text);
do $$ declare r record; biza uuid := (select business_id from public.profiles where id = 'a0000000-0000-0000-0000-00000000a001');
  bizb uuid := (select business_id from public.profiles where id = 'b0000000-0000-0000-0000-00000000b001'); begin
  for r in select t from b8_tables loop
    insert into b8_move values (r.t, test.probe('b0000000-0000-0000-0000-00000000b001', 'authenticated',
      format('update public.%I set business_id = $1 where business_id = ''%s''', r.t, bizb), biza));
  end loop; end $$;
select test.chk(count(*) filter (where res not like 'ERR:%' and res <> 'ROWS:0') = 0, '1b. shop B owner: moving its own rows into shop A is refused in all ' || count(*) || ' tables',
                string_agg(case when res not like 'ERR:%' and res <> 'ROWS:0' then t || ' ' || res end, ', ')) from b8_move;
select test.chk(count(*) filter (where res = 'ROWS:0') = 0, '1b. ... and where the owner may update its own rows (' || count(*) || ' tables), it is an error (row-level security), not "0 rows"',
                string_agg(case when res = 'ROWS:0' then t end, ', '))
  from b8_move where t in (select c.relname from pg_class c join pg_policy p on p.polrelid = c.oid where c.relnamespace = 'public'::regnamespace and p.polcmd in ('w', '*'));

-- 1c. shop A's OWN counter (device login, rank 0): writes nothing directly; owner-only tables hidden
create temp table b8_own(t text, kind text, res text);
do $$ declare r record; biza uuid := (select business_id from public.profiles where id = 'a0000000-0000-0000-0000-00000000a001'); begin
  for r in select b.t, p.rowj, p.cols from b8_tables b join b8_tpl p on p.t = b.t loop
    insert into b8_own values (r.t, 'read',   test.probe('a0000000-0000-0000-0000-00000000d001', 'authenticated', format('select count(*) from public.%I where business_id = $1', r.t), biza));
    insert into b8_own values (r.t, 'update', test.probe('a0000000-0000-0000-0000-00000000d001', 'authenticated', format('update public.%I set business_id = business_id where business_id = $1', r.t), biza));
    insert into b8_own values (r.t, 'delete', test.probe('a0000000-0000-0000-0000-00000000d001', 'authenticated', format('delete from public.%I where business_id = $1', r.t), biza));
    insert into b8_own values (r.t, 'insert', test.probe('a0000000-0000-0000-0000-00000000d001', 'authenticated', format('insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I, $2)', r.t, r.cols), biza, r.rowj));
  end loop; end $$;
select test.chk(count(*) filter (where kind <> 'read' and res not like 'ERR:%' and res <> 'ROWS:0' and not (t = 'profiles' and kind = 'update' and res = 'ROWS:1')) = 0,
                '1c. shop A counter (no PIN needed for this: RLS ignores PIN sessions): changes / deletes / inserts nothing directly in any table',
                string_agg(case when kind <> 'read' and res not like 'ERR:%' and res <> 'ROWS:0' then t || ' ' || kind || ' ' || res end, ', ')) from b8_own;
select test.chk((select res from b8_own where t = 'profiles' and kind = 'update') = 'ROWS:1', '1c. shop A counter: may update its OWN profile row (rule profiles_update: id = auth.uid())');
select test.chk(test.probe(:'devA', 'authenticated', 'update public.profiles set role = ''ADMIN'' where id = auth.uid()') like 'ERR:%Only the owner can change roles%'
            and test.probe(:'devA', 'authenticated', 'update public.profiles set business_id = $1 where id = auth.uid()', :'bizb') like 'ERR:%'
            and test.probe(:'qrA1', 'authenticated', 'insert into public.profiles(id, business_id, name, role) values (auth.uid(), $1, ''x'', ''ADMIN'')', :'biza') like 'ERR:%'
            and test.probe(:'ownB', 'authenticated', format('insert into public.profiles(id, business_id, name, role) values (%L, $1, ''x'', ''ADMIN'')', :'qrA1'), :'biza') like 'ERR:%',
            '1c. ... but no login can make itself ADMIN, move to another shop, or give itself a profile');
select test.chk(count(*) filter (where res <> 'ROWS:0') = 0, '1c. shop A counter: owner-only tables read as empty (customers, expenses, investors, start-up costs, costs, partner debts, rewards, PIN locks, tables, R&D, brands)',
                string_agg(case when res <> 'ROWS:0' then t || ' ' || res end, ', '))
  from b8_own where kind = 'read' and t in ('customers', 'expenses', 'investors', 'startup_costs', 'ingredient_costs', 'partner_debts', 'partner_debt_lines',
    'partner_settlements', 'loyalty_redemptions', 'pin_lock_events', 'dining_tables', 'rnd_projects', 'start_fresh_runs', 'ingredient_brands');
select test.chk(count(*) filter (where res <> 'ROWS:0' and res not like 'ERR:%permission denied%') = 0, '1c. shop A counter: tables with no read rule at all are empty or refused (PINs, sessions, attempts, pairing codes, QR phone links, Senior/PWD IDs...)',
                string_agg(case when res <> 'ROWS:0' and res not like 'ERR:%permission denied%' then t || ' ' || res end, ', '))
  from b8_own where kind = 'read' and t in (select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity
                                            and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polcmd in ('r', '*')));
select test.chk((select res from b8_own where t = 'devices' and kind = 'read') = 'ROWS:1' and (select res from b8_own where t = 'profiles' and kind = 'read') = 'ROWS:1',
                '1c. shop A counter: sees only its OWN device row and profile', (select string_agg(t || '=' || res, ' ') from b8_own where kind = 'read' and t in ('devices', 'profiles')));
-- tables nobody may read straight (no business_id): staff PINs, attempts, signed-out notices, loyalty queue
select test.chk(count(*) filter (where r <> 'ROWS:0' and r not like 'ERR:%') = 0, '1d. staff_pins / auth_attempts / qr_signout_notices / loyalty_pending: no login reads a row',
                string_agg(case when r <> 'ROWS:0' and r not like 'ERR:%' then lbl || ' ' || tb || ' ' || r end, ', '))
  from (select w.label lbl, tb, test.probe(w.uid, w.role, format('select count(*) from public.%I', tb)) r
        from (select * from b8_who union all select 'shop A owner', :'ownA'::uuid, 'authenticated' union all select 'shop A counter', :'devA'::uuid, 'authenticated') w,
             unnest(array['staff_pins', 'auth_attempts', 'qr_signout_notices', 'loyalty_pending']) tb) x;
select test.chk(test.probe(:'ownA', 'authenticated', 'select count(*) from public.senior_discount_records') ~ '^(ROWS:0|ERR:.*permission denied)'
                and test.probe(:'devA', 'authenticated', 'select count(*) from public.senior_discount_records') ~ '^(ROWS:0|ERR:.*permission denied)',
                '1d. Senior/PWD ID records: not readable straight from the table by any login (only through the owner report)');
-- views
select test.chk(test.probe(:'ownB', 'authenticated', 'select count(*) from public.v_ingredient_stock where business_id = $1', :'biza') = 'ROWS:0'
                and test.probe(:'qrA1', 'authenticated', 'select count(*) from public.v_ingredient_stock') = 'ROWS:0'
                and test.probe(null, 'anon', 'select count(*) from public.v_ingredient_stock') like 'ERR:%',
                '1e. view v_ingredient_stock follows the table rules (security_invoker): nothing of shop A for shop B / QR / anon');
select test.chk(test.probe(:'ownB', 'authenticated', 'select count(*) from public.v_partner_to_return where business_id = $1', :'biza') in ('ROWS:0')
                or test.probe(:'ownB', 'authenticated', 'select count(*) from public.v_partner_to_return where business_id = $1', :'biza') like 'ERR:%',
                '1e. view v_partner_to_return: nothing of shop A for shop B');
-- storage: shop B owner can't write into shop A's photo folders
select test.chk(test.probe(:'ownB', 'authenticated', format('insert into storage.objects(bucket_id, name) values (''menu-images'', %L)', :'biza' || '/x.jpg')) like 'ERR:%'
            and test.probe(:'ownB', 'authenticated', format('insert into storage.objects(bucket_id, name) values (''expense-photos'', %L)', :'biza' || '/x.jpg')) like 'ERR:%'
            and test.probe(:'devA', 'authenticated', format('insert into storage.objects(bucket_id, name) values (''menu-images'', %L)', :'biza' || '/x.jpg')) like 'ERR:%',
            '1f. storage: shop B owner can''t upload into shop A''s folders; shop A''s counter can''t upload menu photos');

-- ============================ 2. API functions with shop A's ids ============================
-- 2a. shop B's OWNER (ADMIN of B)
select test.chk(test.rpc(:'ownB', format('select public.apply_changes(''[{"table":"recipes","op":"update","row":{"id":"%s","selling_price":1}}]'')::text', :'recA')) like '%applied%'
                and (select selling_price from recipes where id = :'recA') = 150, '2a. owner B: apply_changes "update" of A''s recipe changes nothing');
select test.chk(test.rpc(:'ownB', format('select public.apply_changes(''[{"table":"recipes","op":"upsert","row":{"id":"%s","name":"Hijack","selling_price":1}}]'')::text', :'recA')) like 'ERR:%FORBIDDEN_ROW%'
                and (select name from recipes where id = :'recA') = 'Latte A', '2a. owner B: apply_changes "upsert" of A''s recipe id -> FORBIDDEN_ROW');
select test.chk(test.rpc(:'ownB', format('select public.apply_changes(''[{"table":"recipes","op":"delete","id":"%s"}]'')::text', :'recA')) like '%applied%'
                and exists (select 1 from recipes where id = :'recA'), '2a. owner B: apply_changes "delete" of A''s recipe deletes nothing');
select test.chk(test.rpc(:'ownB', format('select public.apply_changes(''[{"table":"sale_items","op":"upsert","row":{"id":"%s","sale_id":"%s","recipe_id":"%s","name":"x","quantity":1,"unit_price":1,"line_total":1}}]'')::text',
                gen_random_uuid(), (select id from sales where business_id = :'biza' limit 1), :'recB')) like 'ERR:%FORBIDDEN_ROW%',
                '2a. owner B: a row of B linked to A''s sale -> FORBIDDEN_ROW');
select test.chk(test.rpc(:'ownB', format('select public.apply_changes(''[{"table":"customers","op":"upsert","row":{"id":"%s","nickname":"x","merged_into":"%s"}}]'')::text', gen_random_uuid(), :'custa1')) like 'ERR:%FORBIDDEN_ROW%',
                '2a. owner B: a customer of B "merged into" A''s customer -> FORBIDDEN_ROW');
select test.chk(test.rpc(:'ownB', format('select public.apply_changes(''[{"table":"settings","op":"upsert","row":{"business_id":"%s","business_name":"Hijack"}}]'')::text', :'biza')) not like 'ERR:%'
                and (select business_name from settings where business_id = :'biza') is distinct from 'Hijack', '2a. owner B: apply_changes on settings with A''s business_id writes B''s own settings, never A''s');
select test.chk(test.rpc(:'ownB', 'select public.apply_changes(''[{"table":"profiles","op":"upsert","row":{"id":"' || :'ownB' || '","role":"ADMIN"}}]'')::text') like 'ERR:%TABLE_NOT_ALLOWED%'
            and test.rpc(:'ownB', 'select public.apply_changes(''[{"table":"staff_pins","op":"upsert","row":{}}]'')::text') like 'ERR:%TABLE_NOT_ALLOWED%'
            and test.rpc(:'ownB', 'select public.apply_changes(''[{"table":"staff_sessions","op":"upsert","row":{}}]'')::text') like 'ERR:%TABLE_NOT_ALLOWED%',
            '2a. apply_changes refuses profiles / staff_pins / staff_sessions (TABLE_NOT_ALLOWED)');
select test.chk(test.rpc(:'ownB', format('select public.delete_customer_data(%L)::text', :'custa1')) like 'ERR:%' or test.rpc(:'ownB', format('select public.delete_customer_data(%L)::text', :'custa1')) like '%error%', '2a. owner B: delete_customer_data(A''s customer) refused');
select test.chk((select phone from customers where id = :'custa1') = '+639171110001', '2a. ... A''s customer still has their data');
select test.chk(test.rpc(:'ownB', format('select public.merge_customers(%L, %L)::text', :'custb1', :'custa1')) ~ '(ERR:|error)' and (select merged_into from customers where id = :'custa1') is null,
                '2a. owner B: merge_customers(B''s, A''s) refused');
select test.chk(test.rpc(:'ownB', format('select public.revoke_device(%L)::text', :'devrowa')) like 'ERR:%' and (select active from devices where id = :'devrowa'), '2a. owner B: revoke_device(A''s counter) refused; it stays active');
select test.chk(test.rpc(:'ownB', format('select public.unlock_device_pin(%L)::text', :'devrowa')) ~ '(ERR:|error)', '2a. owner B: unlock_device_pin(A''s counter) refused');
select test.chk(test.rpc(:'ownB', format('select public.staff_set_pin(%L, ''9876'')::text', :'cashA')) ~ '(ERR:|error)'
                and test.rpc(:'devA', 'select public.staff_pin_login(''9876'')->>''error''') = 'WRONG_PIN', '2a. owner B: staff_set_pin(A''s cashier) refused; the PIN is unchanged');
select test.chk(test.rpc(:'ownB', format('select public.staff_import_legacy_pin(%L, repeat(''a'', 64))::text', :'cashA')) ~ '(ERR:|error)', '2a. owner B: staff_import_legacy_pin(A''s cashier) refused');
select test.chk(coalesce(test.rpc(:'ownB', format('select public.bo_customer_loyalty(array[%L]::uuid[])::text', :'custa1')), '') not like '%' || :'custa1' || '%', '2a. owner B: bo_customer_loyalty(A''s customer) says nothing about them');
select test.chk(test.rpc(:'ownB', format('select public.ingredient_brand_stock(%L)::text', :'ingA')) not like '%Beans A%', '2a. owner B: ingredient_brand_stock(A''s ingredient) shows nothing of A');
select test.chk(test.rpc(:'ownB', format('select public.delete_waste(%L, ''x'')::text', (select id from waste_logs where business_id = :'biza' limit 1))) ~ '(ERR:|error)'
                and exists (select 1 from waste_logs where business_id = :'biza'), '2a. owner B: delete_waste(A''s waste entry) refused');
select test.chk(test.rpc(:'ownB', format('select public.revise_waste(''{"id":"%s","items":[]}'')::text', (select id from waste_logs where business_id = :'biza' limit 1))) ~ '(ERR:|error)', '2a. owner B: revise_waste(A''s waste entry) refused');
select test.chk(test.rpc(:'ownB', format('select public.revise_stock_count(%L)::text', (select id from stock_counts where business_id = :'biza' limit 1))) ~ '(ERR:|error)', '2a. owner B: revise_stock_count(A''s count) refused');
update waste_logs set reason = 'RND' where business_id = :'biza';
select test.chk(test.rpc(:'ownB', format('select public.delete_rnd_usage(%L)->>''deleted''', (select id from waste_logs where business_id = :'biza' limit 1))) = 'false'
                and exists (select 1 from waste_logs where business_id = :'biza'), '2a. owner B: delete_rnd_usage(A''s R&D entry) -> deleted: false; it stays');
select test.chk(test.rpc(:'ownB', format('select public.qr_update_order(%L, ''REJECT'')::text', :'orda1')) like '%NOT_FOUND%'
                and (select status from qr_orders where id = :'orda1') = 'PENDING', '2a. owner B: qr_update_order(A''s QR order) -> NOT_FOUND; order untouched');
select test.chk(test.rpc(:'ownB', format('select public.merge_ingredients(array[%L, %L]::uuid[], ''X'')::text', :'ingA', (select id from ingredients where business_id = :'bizb' limit 1))) ~ '(ERR:|error)'
                and exists (select 1 from ingredients where id = :'ingA' and business_id = :'biza'), '2a. owner B: merge_ingredients with A''s ingredient refused');
select test.chk(test.rpc(:'ownB', format('select public.partner_pay(''{"debt_id":"%s","amount":1}'')::text', (select id from partner_debts where business_id = :'biza' limit 1))) ~ '(ERR:|error)'
            and test.rpc(:'ownB', format('select public.partner_return(''{"debt_id":"%s","amount":1}'')::text', (select id from partner_debts where business_id = :'biza' limit 1))) ~ '(ERR:|error)',
            '2a. owner B: partner_pay / partner_return on A''s partner debt refused');
select test.chk(test.rpc(:'ownB', 'select public.bo_bootstrap()::text') not like '%' || :'biza' || '%'
            and test.rpc(:'ownB', 'select public.bo_bootstrap()::text') not like '%Latte A%', '2a. owner B: bo_bootstrap has nothing of shop A');
select test.chk(test.rpc(:'ownB', 'select public.sales_report(now() - interval ''400 days'', now() + interval ''1 day'')::text') not like '%' || :'biza' || '%'
            and test.rpc(:'ownB', 'select public.accounting_report(current_date - 400, current_date + 1)::text') not like '%' || :'biza' || '%'
            and test.rpc(:'ownB', 'select public.senior_report(current_date - 400, current_date + 1)::text') not like '%' || :'biza' || '%'
            and test.rpc(:'ownB', 'select public.search_customers('''')::text') not like '%Alma%',
            '2a. owner B: reports (sales, accounting, Senior/PWD) and customer search show nothing of shop A');
select test.chk(test.rpc(:'ownB', format('select public.fo_customer_detail(%L)::text', :'custa1')) ~ '(ERR:|NOT_FOUND)', '2a. owner B: fo_customer_detail(A''s customer) -> refused / NOT_FOUND');
-- 2b. shop B's COUNTER, with B's manager signed in (strongest counter login of B)
select test.chk(test.rpc(:'devB', format('select public.fo_customer_detail(%L, %L)::text', :'custa1', :'tok_mgrb')) like '%NOT_FOUND%', '2b. counter B + B manager session: fo_customer_detail(A''s customer) -> NOT_FOUND');
select test.chk(test.rpc(:'devB', format('select public.fo_customer_list('''', 50, %L)::text', :'tok_mgrb')) not like '%Alma%', '2b. counter B: customer list has no customer of shop A');
select test.chk(test.rpc(:'devB', format('select public.fo_customer_list('''', 50, %L)->>''money_refused''', :'tok_mgra')) = 'APPROVAL_INVALID', '2b. counter B: shop A''s manager session token gives counter B nothing (APPROVAL_INVALID)');
-- (separate statements: each PIN sign-in is its own request, as from the counter)
select test.rpc(:'devB', 'select public.fo_customer_list('''', 50, public.staff_pin_login(''3333'')->>''token'')->>''money_refused''') as m_cash \gset
select test.rpc(:'devB', format('select public.fo_customer_list('''', 50, %L)->>''money_refused''', :'tok_mgrb')) as m_old \gset
select test.rpc(:'devB', 'select public.staff_pin_login(''444444'')->>''token''') as tok_mgrb \gset
select test.chk(:'m_cash' = 'ROLE_TOO_LOW' and :'m_old' = 'APPROVAL_INVALID'
            and test.rpc(:'devB', format('select public.fo_customer_list('''', 50, %L)->>''show_money''', :'tok_mgrb')) = 'true',
            '2b. counter B: money columns only with B''s manager session (cashier -> ROLE_TOO_LOW; an older session ended by a newer sign-in -> APPROVAL_INVALID)');
select test.chk(test.rpc(:'devB', 'select public.staff_pin_login(''1111'')->>''error''') = 'WRONG_PIN', '2b. counter B: shop A''s cashier PIN signs nobody in at B');
select test.chk(test.rpc(:'devB', format('select public.staff_logout(%L)::text', :'tok_mgra')) is not null
            and (select revoked_at is null from staff_sessions where token_hash = encode(extensions.digest(:'tok_mgra', 'sha256'), 'hex')), '2b. counter B: staff_logout(A''s manager token) does not end A''s session');
select test.chk(test.rpc(:'devB', format('select public.fo_bootstrap(%L)->''device''', :'keyA')) = 'null'
            and test.rpc(:'devB', format('select public.fo_bootstrap(%L)::text', :'keyA')) not like '%' || :'biza' || '%', '2b. counter B: fo_bootstrap with A''s device key -> no device, only B''s own data');
select test.chk(test.rpc(:'devB', format('select public.fo_sync(%L, ''[]''::jsonb)::text', :'keyA')) like 'ERR:%', '2b. counter B: fo_sync with A''s device key refused');
select test.chk(test.rpc(:'devB', format('select public.fo_bootstrap(%L)::text', :'keyB')) not like '%Latte A%'
            and test.rpc(:'devB', format('select public.fo_bootstrap(%L)::text', :'keyB')) not like '%' || :'biza' || '%', '2b. counter B: its own fo_bootstrap has nothing of shop A');
select test.chk(test.op(:'devB', :'keyB', 'refund', jsonb_build_object('refund', jsonb_build_object('id', gen_random_uuid(), 'sale_id', (select id from sales where business_id = :'biza' limit 1),
                  'type', 'VOID', 'amount', 0, 'approved_by', :'mgrB'), 'approval_token', :'tok_mgrb')) like '%SALE_NOT_FOUND%', '2b. counter B: refund of A''s sale -> SALE_NOT_FOUND');
select test.chk(test.op(:'devB', :'keyB', 'shift_close', jsonb_build_object('id', :'shiftA', 'closed_by', :'cashA', 'closed_at', now())) like '%SHIFT_NOT_FOUND%'
            and (select status from shifts where id = :'shiftA') = 'ACTIVE', '2b. counter B: closing A''s shift -> SHIFT_NOT_FOUND; it stays open');
select test.chk(test.op(:'devB', :'keyB', 'cash_movement', jsonb_build_object('id', gen_random_uuid(), 'shift_id', :'shiftA', 'performed_by', :'cashB', 'type', 'PAY_OUT', 'amount', 5)) ~ '(FORBIDDEN_ROW|error)'
            and not exists (select 1 from cash_movements where shift_id = :'shiftA' and business_id = :'bizb'), '2b. counter B: a pay-out on A''s shift refused');
select test.chk(test.op(:'devB', :'keyB', 'sold_out', jsonb_build_object('recipe_id', :'recA', 'sold_out', true)) is not null
            and not (select coalesce(sold_out, false) from recipes where id = :'recA'), '2b. counter B: "sold out" on A''s recipe changes nothing');
select test.chk(test.op(:'devB', :'keyB', 'shift_open', jsonb_build_object('id', :'shiftA', 'cashier_id', :'cashB', 'opened_at', now())) ~ '(FORBIDDEN_ROW|error)'
            and (select business_id from shifts where id = :'shiftA') = :'biza', '2b. counter B: opening a shift with A''s shift id refused');
select test.chk(test.op(:'devB', :'keyB', 'shift_open', jsonb_build_object('id', gen_random_uuid(), 'cashier_id', :'cashA', 'opened_at', now())) ~ '(error)', '2b. counter B: a shift for A''s cashier refused');
select test.chk(test.op(:'devB', :'keyB', 'held_delete', jsonb_build_object('id', (select id from sales where business_id = :'biza' limit 1))) like '%skipped%'
            and exists (select 1 from sales where business_id = :'biza'), '2b. counter B: held_delete of A''s sale -> skipped');
select test.chk(test.op(:'devB', :'keyB', 'sale', jsonb_build_object('sale', jsonb_build_object('id', (select id from sales where business_id = :'biza' limit 1), 'status', 'HELD', 'cashier_id', :'cashB',
                  'shift_id', :'shiftB', 'subtotal', 0, 'grand_total', 0), 'items', '[]'::jsonb)) ~ '(FORBIDDEN_ROW|error)',
            '2b. counter B: a sale op with A''s sale id refused (FORBIDDEN_ROW)');
select test.chk(test.rpc(:'devB', format('select public.qr_update_order(%L, ''ACCEPT'')::text', :'orda1')) like '%NOT_FOUND%', '2b. counter B: qr_update_order(A''s QR order) -> NOT_FOUND');
select test.chk(test.rpc(:'devB', format('select public.fo_count_due(%L)::text', :'shiftA')) not like '%Beans A%', '2b. counter B: fo_count_due(A''s shift) shows nothing of A');
select test.chk(test.rpc(:'devB', 'select public.search_customers(''Alma'')::text') not like '%Alma%' and test.rpc(:'devB', 'select public.search_customers(''0001'')::text') not like '%Alma%',
                '2b. counter B: search_customers finds nothing of shop A');
-- 2c. shop A's own counter: approvals are server-checked and one-time
select test.chk(test.op(:'devB', :'keyB', 'refund', jsonb_build_object('refund', jsonb_build_object('id', gen_random_uuid(), 'sale_id', (select id from sales where business_id = :'bizb' limit 1),
                  'type', 'VOID', 'amount', 0, 'approved_by', :'mgrA'), 'approval_token', :'appr_mgra')) like '%error%', '2c. A''s manager approval token is refused at counter B');
select test.chk(test.rpc(:'devA', format('select public.fo_customer_list('''', 50, %L)->>''money_refused''', :'tok_mgrb')) = 'APPROVAL_INVALID', '2c. counter A: B''s manager session gives A nothing');
-- 2d. QR customers
select test.chk(test.rpc(:'qrA2', 'select public.qr_my_orders(''b8-token-shop-a-1'')::text') not like '%' || :'orda1' || '%'
            and test.rpc(:'qrA1', 'select public.qr_my_orders(''b8-token-shop-a-1'')::text') like '%' || :'orda1' || '%', '2d. QR: another customer of A does not see A1''s order (A1 does)');
select test.chk(test.rpc(:'guestA', 'select public.qr_my_orders(''b8-token-shop-a-1'')::text') not like '%' || :'orda1' || '%', '2d. QR: the guest does not see A1''s order');
select test.chk(test.rpc(:'qrA2', format('select public.qr_cancel_order(''b8-token-shop-a-1'', %L)->>''error''', :'orda1')) = 'CANNOT_CANCEL'
            and test.rpc(:'qrB1', format('select public.qr_cancel_order(''b8-token-shop-b-1'', %L)->>''error''', :'orda1')) = 'CANNOT_CANCEL'
            and (select status from qr_orders where id = :'orda1') = 'PENDING', '2d. QR: another customer / another shop''s customer can''t cancel A1''s order');
select test.chk(test.rpc(:'qrB1', 'select public.qr_session(''b8-token-shop-a-1'')->>''state''') = 'GUEST', '2d. QR: B''s registered customer is a guest in shop A (accounts don''t cross shops)');
select test.chk(test.rpc(:'qrB1', format('select public.qr_place_order(''b8-token-shop-a-1'', ''[{"recipe_id":"%s","quantity":1}]''::jsonb)->>''error''', :'recA')) = 'REGISTER_FIRST', '2d. QR: ... and can''t order there as a registered customer');
select test.chk(test.rpc(:'qrB1', format('select public.qr_place_order(''b8-token-shop-b-1'', ''[{"recipe_id":"%s","quantity":1}]''::jsonb)->>''error''', :'recA')) = 'ITEM_UNAVAILABLE', '2d. QR: shop A''s item can''t be ordered at shop B''s table');
select test.chk(test.rpc(:'qrA2', 'select public.qr_session(''b8-token-shop-a-1'')->''customer''->>''nickname''') = 'Bea'
            and test.rpc(:'qrA2', 'select public.qr_session(''b8-token-shop-a-1'')::text') not like '%0917%111%0002%' , '2d. QR: a customer sees only their own account');
select test.chk(test.rpc(:'qrA2', 'select public.qr_relink(''b8-token-shop-a-1'', ''0917 111 0001'', ''Alma'')->>''error''') = 'SIGN_OUT_FIRST', '2d. QR: a signed-in customer can''t take over another account (SIGN_OUT_FIRST)');
select test.chk(test.rpc(:'stray', 'select public.qr_relink(''b8-token-shop-a-1'', ''0917 111 0001'', ''Wrong'')->>''error''') = 'NO_MATCH', '2d. QR: relink needs number AND nickname (NO_MATCH)');
select test.chk(test.rpc(:'qrA1', 'select public.qr_update_order(''' || :'orda1' || ''', ''READY'')::text') like 'ERR:%', '2d. QR customer can''t use the counter''s qr_update_order');
select test.chk(test.rpc(:'qrA1', 'select public.fo_customer_list('''')::text') like 'ERR:%' and test.rpc(:'qrA1', 'select public.search_customers('''')::text') like 'ERR:%'
            and test.rpc(:'qrA1', 'select public.bo_bootstrap()::text') not like '%Alma%' and test.rpc(:'qrA1', 'select public.apply_changes(''[]'')::text') like 'ERR:%',
            '2d. QR customer: counter / Back Office functions refused or empty');
select test.chk(test.rpc(:'qrA1', 'select public.staff_pin_login(''1111'')->>''error''') = 'NOT_A_MEMBER', '2d. QR customer: staff_pin_login -> NOT_A_MEMBER (can''t try PINs)');
select test.chk(test.rpc(:'qrA1', 'select public.redeem_device_pairing(''XXXXXX'', ''0123456789abcdef'')->>''error''') = 'BAD_CODE', '2d. QR customer: a wrong pairing code -> BAD_CODE');
-- 2e. no login at all (anon role)
select test.chk(test.rpc(null, 'select public.qr_place_order(''b8-token-shop-a-1'', ''[]''::jsonb)->>''error''') = 'NOT_SIGNED_IN'
            and test.rpc(null, 'select public.qr_register(''b8-token-shop-a-1'', ''X'', null, true)->>''error''') = 'NOT_SIGNED_IN'
            and test.rpc(null, 'select public.qr_relink(''b8-token-shop-a-1'', ''0917 111 0001'', ''Alma'')->>''error''') = 'NOT_SIGNED_IN'
            and test.rpc(null, 'select public.qr_set_phone(''b8-token-shop-a-1'', ''0917 111 0001'')->>''error''') = 'NOT_SIGNED_IN'
            and test.rpc(null, 'select public.qr_my_orders(''b8-token-shop-a-1'')->''orders''') = '[]'
            and test.rpc(null, format('select public.qr_cancel_order(''b8-token-shop-a-1'', %L)->>''error''', :'orda1')) = 'CANNOT_CANCEL',
            '2e. no login: QR functions answer NOT_SIGNED_IN / nothing');
select test.chk(count(*) filter (where r not like 'ERR:%permission denied%') = 0, '2e. no login: every function for logged-in users is refused (' || count(*) || ' functions)',
                string_agg(case when r not like 'ERR:%permission denied%' then f || ' ' || left(r, 60) end, ', '))
  from (select p.proname f, test.rpc(null, format('select public.%I(%s)::text', p.proname,
               (select string_agg('null', ',') from generate_series(1, p.pronargs - p.pronargdefaults)))) r
        from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')
          and not has_function_privilege('anon', p.oid, 'execute') and p.prorettype <> 'trigger'::regtype) x;
select test.chk(test.rpc(null, 'select public.get_qr_menu(''b8-token-shop-a-1'')::text') not like '%cost%' and test.rpc(null, 'select public.get_qr_menu(''b8-token-shop-a-1'')::text') like '%Latte A%',
                '2e. no login: the QR menu shows the menu but no cost data');

-- 3. what can a fresh stranger signing up do? (a new email account = a new empty shop)
insert into auth.users (id, email, raw_user_meta_data) values ('c0000000-0000-0000-0000-00000000c0c0', 'b8-stranger@example.com', '{"business_name":"Shop A","admin_name":"Ana"}');
select test.chk((select business_id from profiles where id = 'c0000000-0000-0000-0000-00000000c0c0') not in (:'biza', :'bizb'), '3. a new sign-up with the SAME shop name gets a NEW empty shop, never shop A');
select test.chk(test.probe('c0000000-0000-0000-0000-00000000c0c0', 'authenticated', 'select count(*) from public.sales where business_id = $1', :'biza') = 'ROWS:0', '3. ... and reads nothing of shop A');
insert into auth.users (id, is_anonymous, raw_user_meta_data) values ('c0000000-0000-0000-0000-00000000c0c1', true, '{"business_name":"X"}');
select test.chk(not exists (select 1 from profiles where id = 'c0000000-0000-0000-0000-00000000c0c1'), '3. an anonymous login never gets a shop or a profile');

select line from test.results order by n;
