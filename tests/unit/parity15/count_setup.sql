-- Set-up for unit/count_parity_check.js (release 1.5): pairs a test counter ('Core counter') in the seeded shop.
\set ON_ERROR_STOP 1
create schema if not exists test;
create or replace function test.login(p_uid uuid, p_token text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, false);
  perform set_config('request.headers', case when p_token is null then '{}' else json_build_object('x-staff-token', p_token)::text end, false);
end $$;
grant usage on schema test to anon, authenticated;
grant execute on all functions in schema test to anon, authenticated;
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select (public.create_device_pairing_code('Core counter'))->>'code' as paircode \gset
reset role;
insert into auth.users(id, is_anonymous) values ('00000000-0000-0000-0000-0000000000c5', true) on conflict do nothing;
select test.login('00000000-0000-0000-0000-0000000000c5'); set role authenticated;
select public.redeem_device_pairing(:'paircode', 'device-key-core-0001-abcdef', 'Core counter')->'device'->>'active';
reset role;
