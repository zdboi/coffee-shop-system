-- Set-up helper for suites 39 and 40 since release 1.5 (012), included with \ir.
-- Those suites use phone c1 as the customer Zed. Suite 11 (which runs just before them) re-links Zed on
-- phone c2, and with "one phone per account" (owner-accepted default D3, 2026-11-10) that signs phone c1
-- out, so c1 would be a guest. This puts Zed back on phone c1 (which signs c2 out). No expected value changes.
select qr_token as relink_t5 from dining_tables where label = 'Table 5' \gset
delete from auth_attempts;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', false) as relink_x \gset
set role authenticated;
select coalesce(public.qr_relink(:'relink_t5', '+639171234567', 'Zed')->'customer'->>'nickname', 'RELINK FAILED') as relink_who \gset
reset role;
select case when :'relink_who' = 'Zed' then 'ok  setup (1.5): phone c1 is Zed again' else 'FAIL setup (1.5): phone c1 could not be re-linked to Zed   [got: ' || :'relink_who' || ']' end;
delete from auth_attempts;
