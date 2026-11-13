-- Release 1.6.1, database script 014: settings.profit_split (investors / managers / shop). Runs on the data
-- tests/sql/43_release_1_6_tests.sql leaves (fresh database -> 10 -> 11 -> 43 -> conc16 -> 44, see run_all.sh).
-- Adopted by Z 2026-11-13 from the database work's 14 checks (w4/db161-tests.sql) + Z's probes. ok / FAIL lines.
\set QUIET on
\pset tuples_only on
\pset format unaligned
select business_id as biz from profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
select test.chk((select profit_split = '{"investors_pct": 30, "managers_pct": 20, "shop_pct": 50, "managers": []}'::jsonb from settings where business_id = :'biz'), 'P: default split 30 / 20 / 50, no managers yet');
select test.login('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"business_id":"$$ || :'biz' || $$","profit_split":{"investors_pct":30,"managers_pct":20,"shop_pct":50,"managers":[" Ben ","Zed"]}}}]')$$) = 'NO ERROR', 'P: owner saves managers Ben + Zed');
reset role;
select test.chk((select profit_split->'managers' = '["Ben","Zed"]'::jsonb from settings where business_id = :'biz'), 'P: names trimmed');
select test.chk(test.err($$update settings set profit_split = '{"investors_pct":30,"managers_pct":20,"shop_pct":40,"managers":[]}'$$) = 'BAD_PROFIT_SPLIT', 'P: parts adding up to 90 refused');
select test.chk(test.err($$update settings set profit_split = '{"investors_pct":-10,"managers_pct":60,"shop_pct":50,"managers":[]}'$$) = 'BAD_PROFIT_SPLIT', 'P: a negative part refused');
select test.chk(test.err($$update settings set profit_split = '{"investors_pct":30,"managers_pct":20,"shop_pct":50,"managers":["Ben","ben "]}'$$) = 'BAD_PROFIT_SPLIT', 'P: the same manager twice refused');
select test.chk(test.err($$update settings set profit_split = '{"investors_pct":30,"managers_pct":20,"shop_pct":50,"managers":[""]}'$$) = 'BAD_PROFIT_SPLIT', 'P: an empty name refused');
select test.chk(test.err($$update settings set profit_split = '{"investors_pct":"30","managers_pct":20,"shop_pct":50,"managers":[]}'$$) = 'BAD_PROFIT_SPLIT', 'P: a number as text refused');
select test.chk(test.err($$update settings set profit_split = '{"investors_pct":30,"managers_pct":20,"shop_pct":50,"managers":[],"x":1}'$$) = 'BAD_PROFIT_SPLIT', 'P: an unknown key refused');
select test.chk(test.err($$update settings set profit_split = '{"investors_pct":30,"managers_pct":20,"shop_pct":50,"managers":[5]}'$$) = 'BAD_PROFIT_SPLIT', 'P: a name that is not text refused');
select test.chk(test.err($$update settings set profit_split = null$$) <> 'NO ERROR', 'P: null refused');
select test.chk(test.err($$update settings set profit_split = '{"investors_pct":33.33,"managers_pct":33.33,"shop_pct":33.34,"managers":[]}'$$) = 'NO ERROR', 'P: decimals adding to 100 accepted');
select test.login('00000000-0000-0000-0000-0000000000d1'); set role authenticated;
select test.chk(test.err($$select public.apply_changes('[{"op":"update","table":"settings","row":{"business_id":"$$ || :'biz' || $$","profit_split":{"investors_pct":0,"managers_pct":100,"shop_pct":0,"managers":["Hacker"]}}}]')$$) <> 'NO ERROR', 'P: a counter can''t change the split');
reset role;
select test.chk((select count(*) = 0 from information_schema.routine_privileges where routine_schema = 'public' and grantee in ('anon','authenticated','PUBLIC') and routine_name in ('_valid_profit_split','_settings_profit_split_check')), 'P: helpers not callable through the API');
-- ---- Z (2026-11-13)
select test.chk((select count(*) = 1 from pg_trigger where tgname = 'settings_profit_split_check' and tgrelid = 'public.settings'::regclass), 'ZP: one profit-split trigger on settings (014 ran twice)');
select test.chk(test.err($$update settings set profit_split = '{"investors_pct":30,"managers_pct":20,"shop_pct":50,"managers":["A\u0007B"]}'$$) = 'BAD_PROFIT_SPLIT'
  and test.err(format($$update settings set profit_split = '{"investors_pct":30,"managers_pct":20,"shop_pct":50,"managers":["%s"]}'$$, repeat('n', 81))) = 'BAD_PROFIT_SPLIT'
  and test.err(format($$update settings set profit_split = '{"investors_pct":30,"managers_pct":20,"shop_pct":50,"managers":[%s]}'$$, (select string_agg('"m' || g || '"', ',') from generate_series(1, 11) g))) = 'BAD_PROFIT_SPLIT'
  and test.err($$update settings set profit_split = '{"investors_pct":130,"managers_pct":-30,"shop_pct":0,"managers":[]}'$$) = 'BAD_PROFIT_SPLIT'
  and test.err($$update settings set profit_split = '[30,20,50]'$$) = 'BAD_PROFIT_SPLIT',
  'ZP: a control character, an 81-character name, 11 managers, a part above 100 and a list instead of an object are refused');
-- another shop's owner can't change THIS shop's split; anon can't read or write settings
select profit_split::text as before from settings where business_id = :'biz' \gset
select test.login('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select test.err(format($$select public.apply_changes('[{"op":"update","table":"settings","row":{"business_id":"%s","profit_split":{"investors_pct":0,"managers_pct":100,"shop_pct":0,"managers":["Other"]}}}]')$$, :'biz')) as other \gset
with u as (update public.settings set profit_split = '{"investors_pct":0,"managers_pct":100,"shop_pct":0,"managers":["Other"]}' where business_id = :'biz' returning 1) select count(*) as n_direct from u \gset
reset role;
select test.chk((select profit_split::text from settings where business_id = :'biz') = :'before', 'ZP: another shop''s owner can''t change this shop''s split (apply_changes or directly)', :'other');
select test.login(null); set role anon;
select test.chk(test.err($$update public.settings set profit_split = '{"investors_pct":0,"managers_pct":100,"shop_pct":0,"managers":[]}'$$) like '%permission denied%', 'ZP: nobody signed in can change it (permission denied)');
reset role;
select test.chk((select profit_split::text from settings where business_id = :'biz') = :'before', 'ZP: still the owner''s split after all the tries');
