#!/bin/bash
# Full regression for the cccc/ build (QA). Uses database cccc + the stand-in on :8787 (both QA's).
#   tests/run_all.sh                 everything; browser suites run twice (to catch flaky checks)
#   tests/run_all.sh --runs 1        browser suites once
#   tests/run_all.sh --no-browser    database + unit checks only
# Screenshots + one log per suite: $QA_SHOTS (default ${TMPDIR:-/tmp}/cccc-qa-shots, logs in .../logs).
# Ends with a pass/fail table; exit code 0 only when every check passed.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"; REPO="$(dirname "$DIR")"
PORT=8787; DB=cccc; RUNS=2; BROWSER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --no-browser) BROWSER=0; shift ;;
    *) echo "unknown option $1 (use --runs N or --no-browser)" >&2; exit 2 ;;
  esac
done
export QA_SHOTS="${QA_SHOTS:-${TMPDIR:-/tmp}/cccc-qa-shots}"
LOGS="$QA_SHOTS/logs"; mkdir -p "$LOGS"; : > "$LOGS/review_flags.log"
export FAKE_PORT=$PORT FAKE_DB=$DB
export PGOPTIONS="-c client_min_messages=warning"
PSQL="psql -h /tmp -p 54329 -U postgres -d $DB"
ROWS=()          # name|PASS/FAIL|checks|failed|seconds|log
TOTAL_FAIL=0

record(){ # name status checks failed seconds log
  ROWS+=("$1|$2|$3|$4|$5|$6"); [ "$2" = PASS ] || TOTAL_FAIL=$((TOTAL_FAIL+1))
  printf '  %-34s %-4s %5s checks %4s failed  %4ss\n' "$1" "$2" "$3" "$4" "$5"
}
# SQL suite that stops at the first ASSERT (10, 11, 30): passes = "ok" lines, fails = exit code
logname(){ echo "$LOGS/$(tr '/#@' '__-' <<<"$1").log"; }
run_sql_assert(){ # name file
  local t0=$SECONDS log; log=$(logname "$1")
  $PSQL -v ON_ERROR_STOP=1 -f "$2" > "$log" 2>&1; local rc=$?
  local n; n=$(grep -c '^ok ' "$log")
  if [ $rc -eq 0 ]; then record "$1" PASS "$n" 0 $((SECONDS-t0)) "$log"
  else record "$1" FAIL "$((n+1))" 1 $((SECONDS-t0)) "$log"; grep -m1 -E "ASSERT FAILED|ERROR" "$log" | sed 's/^/      /'; fi
}
# SQL suite that prints ok / FAIL lines and keeps going (31)
run_sql_lines(){ # name file
  local t0=$SECONDS log; log=$(logname "$1")
  $PSQL -v ON_ERROR_STOP=1 -f "$2" > "$log" 2>&1; local rc=$?
  local n f; n=$(grep -cE '^(ok |FAIL )' "$log"); f=$(grep -c '^FAIL ' "$log")
  [ $rc -ne 0 ] && f=$((f+1)) && n=$((n+1))
  if [ "$f" -eq 0 ]; then record "$1" PASS "$n" 0 $((SECONDS-t0)) "$log"
  else record "$1" FAIL "$n" "$f" $((SECONDS-t0)) "$log"; grep -E '^FAIL|ERROR' "$log" | head -5 | sed 's/^/      /'; fi
}
# node script (or shell script with run_cmd) that ends with "SUMMARY <name>: <n> checks, <f> failed"
run_node(){ # name script [args...]   (env passed through)
  local name="$1"; shift
  run_cmd "$name" node "$@"
}
run_cmd(){ # name command [args...]
  local name="$1"; shift
  local t0=$SECONDS log; log=$(logname "$name")
  timeout 1500 "$@" > "$log" 2>&1; local rc=$?
  local line n f; line=$(grep -E '^SUMMARY ' "$log" | tail -1)
  n=$(sed -E 's/.*: ([0-9]+) checks.*/\1/' <<<"$line"); f=$(sed -E 's/.*checks, ([0-9]+) failed.*/\1/' <<<"$line")
  [ -z "$line" ] && n=0 && f=1
  if [ $rc -eq 0 ] && [ "$f" = 0 ]; then record "$name" PASS "$n" 0 $((SECONDS-t0)) "$log"
  else record "$name" FAIL "$n" "${f:-1}" $((SECONDS-t0)) "$log"; grep -E '^FAIL|Error|TIMEOUT' "$log" | head -6 | cut -c1-300 | sed 's/^/      /'; fi
}

echo "== test database (PostgreSQL 16 on :54329)"
"$DIR/start_pg.sh" >/dev/null || { echo "test postgres did not start"; exit 1; }

echo "== database: live order 004 -> 005 -> 006 -> 007 -> 008 -> 009 -> 010 -> 011 -> 012 -> 013 on the live-schema copy (with live CHECK rules), installed twice"
t0=$SECONDS
if "$DIR/reset_db.sh" "" "$DB" > "$LOGS/install-1.log" 2>&1; then
  ok2=1; : > "$LOGS/install-2.log"
  for m in 004_cccc_online_qr.sql 005_live_fixes.sql 006_live_fix_sync_operations.sql 007_batch1.sql 008_release_1_2.sql 009_release_1_3.sql 010_release_1_4.sql 011_release_1_4_1.sql 012_release_1_5.sql 013_release_1_6.sql; do
    $PSQL -v ON_ERROR_STOP=1 -q -f "$REPO/cccc/supabase/$m" >> "$LOGS/install-2.log" 2>&1 || { ok2=0; echo "second run of $m failed" >> "$LOGS/install-2.log"; break; }
  done
  if [ $ok2 = 1 ]; then record "004..013 install (x2)" PASS 2 0 $((SECONDS-t0)) "$LOGS/install-2.log"
  else record "004..013 install (x2)" FAIL 2 1 $((SECONDS-t0)) "$LOGS/install-2.log"; tail -3 "$LOGS/install-2.log"; fi
else record "004..013 install (x2)" FAIL 1 1 $((SECONDS-t0)) "$LOGS/install-1.log"; tail -3 "$LOGS/install-1.log"; fi
run_sql_lines  sql/36_live_rules_tests "$DIR/sql/36_live_rules_tests.sql"   # CHECK rules now match live

echo "== database behaviour suites (on the twice-installed database)"
run_sql_assert sql/10_behaviour_tests "$DIR/sql/10_behaviour_tests.sql"
run_sql_assert sql/11_qr_tests "$DIR/sql/11_qr_tests.sql"
run_sql_lines  sql/31_qa_extra_tests "$DIR/sql/31_qa_extra_tests.sql"
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
run_sql_assert sql/30_security_tests "$DIR/sql/30_security_tests.sql"
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
run_sql_assert sql/32_fix_round_tests "$DIR/sql/32_fix_round_tests.sql"
run_cmd conc_checks "$DIR/conc_checks.sh" "$DB"       # two sessions at once, on the data 32 left
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
run_sql_lines  sql/33_security_round3_tests "$DIR/sql/33_security_round3_tests.sql"   # needs a fresh database
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
run_sql_lines  sql/34_live_fixes_tests "$DIR/sql/34_live_fixes_tests.sql"              # 005: re-creates the live device_type rule, then fixes it
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
run_sql_lines  sql/35_live_fix_sync_ops_tests "$DIR/sql/35_live_fix_sync_ops_tests.sql"  # 006: needs a fresh database
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
run_sql_lines  sql/37_batch1_tests "$DIR/sql/37_batch1_tests.sql"                      # 007 + batch 1 Back Office writes: needs a fresh database
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
# 008 (release 1.2): runs on the data 10 + 11 leave behind (their shop, counter, staff, customers)
if $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/10_behaviour_tests.sql" > /dev/null 2>&1 && $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/11_qr_tests.sql" > /dev/null 2>&1; then
  run_sql_lines sql/38_release_1_2_tests "$DIR/sql/38_release_1_2_tests.sql"
else record sql/38_release_1_2_tests FAIL 1 1 0 "$LOGS/sql_38_release_1_2_tests.log"; echo "      setup (10 + 11) failed"; fi
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
# 009 (release 1.3): same set-up as 38 (fresh database -> 10 -> 11 -> 39)
if $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/10_behaviour_tests.sql" > /dev/null 2>&1 && $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/11_qr_tests.sql" > /dev/null 2>&1; then
  run_sql_lines sql/39_release_1_3_tests "$DIR/sql/39_release_1_3_tests.sql"
else record sql/39_release_1_3_tests FAIL 1 1 0 "$LOGS/sql_39_release_1_3_tests.log"; echo "      setup (10 + 11) failed"; fi
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
# 010 (release 1.4): same set-up (fresh database -> 10 -> 11 -> 40)
if $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/10_behaviour_tests.sql" > /dev/null 2>&1 && $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/11_qr_tests.sql" > /dev/null 2>&1; then
  run_sql_lines sql/40_release_1_4_tests "$DIR/sql/40_release_1_4_tests.sql"
else record sql/40_release_1_4_tests FAIL 1 1 0 "$LOGS/sql_40_release_1_4_tests.log"; echo "      setup (10 + 11) failed"; fi
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
# 011 (release 1.4.1): same set-up (fresh database -> 10 -> 11 -> 41)
if $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/10_behaviour_tests.sql" > /dev/null 2>&1 && $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/11_qr_tests.sql" > /dev/null 2>&1; then
  run_sql_lines sql/41_release_1_4_1_tests "$DIR/sql/41_release_1_4_1_tests.sql"
else record sql/41_release_1_4_1_tests FAIL 1 1 0 "$LOGS/sql_41_release_1_4_1_tests.log"; echo "      setup (10 + 11) failed"; fi
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
# 012 (release 1.5): same set-up (fresh database -> 10 -> 11 -> 42), then the 1.5 two-sessions checks on the data 42 left
if $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/10_behaviour_tests.sql" > /dev/null 2>&1 && $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/11_qr_tests.sql" > /dev/null 2>&1; then
  run_sql_lines sql/42_release_1_5_tests "$DIR/sql/42_release_1_5_tests.sql"
  run_cmd conc15_checks "$DIR/conc15_checks.sh" "$DB"
else record sql/42_release_1_5_tests FAIL 1 1 0 "$LOGS/sql_42_release_1_5_tests.log"; echo "      setup (10 + 11) failed"; fi
"$DIR/reset_db.sh" "" "$DB" > /dev/null 2>&1
# 013 (release 1.6): same set-up (fresh database -> 10 -> 11 -> 43), then the 1.6 two-sessions checks on the data 43 left
if $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/10_behaviour_tests.sql" > /dev/null 2>&1 && $PSQL -v ON_ERROR_STOP=1 -q -f "$DIR/sql/11_qr_tests.sql" > /dev/null 2>&1; then
  run_sql_lines sql/43_release_1_6_tests "$DIR/sql/43_release_1_6_tests.sql"
  run_cmd conc16_checks "$DIR/conc16_checks.sh" "$DB"          # 1.6, two sessions at once, on the data 43 left
else record sql/43_release_1_6_tests FAIL 1 1 0 "$LOGS/sql_43_release_1_6_tests.log"; echo "      setup (10 + 11) failed"; fi

echo "== unit checks (shared core)"
run_node unit/core_check "$DIR/unit/core_check.js" "$REPO"
run_node unit/error_codes_check "$DIR/unit/error_codes_check.js" "$REPO"
run_node unit/core_browser "$DIR/unit/core_browser.js" "$REPO"
run_node unit/logic_refund_check "$DIR/unit/logic_refund_check.js" "$REPO"
run_node unit/email_link_check "$DIR/unit/email_link_check.js" "$REPO"
run_node unit/captcha_check "$DIR/unit/captcha_check.js" "$REPO"
run_node unit/units_check "$DIR/unit/units_check.js" "$REPO"
run_node unit/shift_reward_check "$DIR/unit/shift_reward_check.js" "$REPO"        # 1.2: shift summary with stamp rewards
REPO="$REPO" run_node unit/printer_check "$DIR/unit/printer_check.js"             # 1.3: receipt printer (ESC/POS, Bluetooth / Serial fakes)
REPO="$REPO" run_node unit/printer_usb_check "$DIR/unit/printer_usb_check.js"     # 1.4: USB printer, barista ticket + X / Z goldens, print queue, no print screen by itself
REPO="$REPO" run_node unit/menu_stock_check "$DIR/unit/menu_stock_check.js"       # 1.3: sub-category order + cart stock check
run_node unit/storage_check "$DIR/unit/storage_check.js" "$REPO"                  # 1.4: cloud.download / remove / upload path check (fake fetch)
run_node unit/core14_check "$DIR/unit/core14_check.js" "$REPO"                    # 1.4: units, options (extras / swaps / library groups), merged items, waste
run_node unit/core15_check "$DIR/unit/core15_check.js" "$REPO"                    # 1.5: shop day (Manila), stock_count op, blind-count differences, production scale / max / partner debt maths
TZ=America/Los_Angeles run_node "unit/core15_check@LA" "$DIR/unit/core15_check.js" "$REPO"          # ... the same on a device far behind Manila
TZ=Pacific/Kiritimati run_node "unit/core15_check@Kiritimati" "$DIR/unit/core15_check.js" "$REPO"   # ... and far ahead
run_node unit/core16_check "$DIR/unit/core16_check.js" "$REPO"                    # 1.6: totals with the payment charge + Senior / PWD, refund share, payment methods, ID mask, CSV cells
"$DIR/e2e_reset.sh" "$DB" > /dev/null 2>&1          # parity check needs a shop (runs inside a rolled-back transaction)
run_node unit/refund_parity_check "$DIR/unit/refund_parity_check.js" "$REPO" "$DB" 500
run_node unit/loyalty_totals_check "$DIR/unit/loyalty_totals_check.js" "$REPO" "$DB" 1500   # 1.2: reward totals vs the 008 server (rolled back)
run_node unit/stock_parity_check "$DIR/unit/stock_parity_check.js" "$REPO" "$DB"         # 1.4: stock lines + unit conversion vs the 010 server (rolled back)
run_node unit/partner_parity_check "$DIR/unit/partner_parity_check.js" "$REPO" "$DB"     # 1.5: production scaling + partner debt plan vs the 012 server (loads its fixture; the browser suites re-seed)
run_node unit/count_parity_check "$DIR/unit/count_parity_check.js" "$REPO" "$DB"         # 1.5: blind count data + differences vs the 012 server; count before shift close; duplicate / skipped

if [ "$BROWSER" = 1 ]; then
  "$DIR/e2e_reset.sh" "$DB" > /dev/null 2>&1
  "$DIR/restart_fake.sh" "$PORT" "$DB" > /dev/null || { echo "stand-in did not start (see tests/fake-$PORT.log)"; exit 1; }
  for run in $(seq 1 "$RUNS"); do
    echo "== browser suites, run $run of $RUNS (counter 1280 px, Back Office 1280 + 768 px, QR page 390x844)"
    for t in "fo.e2e:fo.e2e.js:" "fo_security.e2e:fo_security.e2e.js:" "fo_refunds.e2e:fo_refunds.e2e.js:" \
             "fo_offline_manager.e2e:fo_offline_manager.e2e.js:" "fo_offline_pin.e2e:fo_offline_pin.e2e.js:" "fo_qr_paid_once.e2e:fo_qr_paid_once.e2e.js:" \
             "order.e2e:order.e2e.js:" "order_extra.e2e:order_extra.e2e.js:" "order_ticket_states.e2e:order_ticket_states.e2e.js:" \
             "bo.e2e@1280:bo.e2e.js:1280x900" "bo.e2e@768:bo.e2e.js:768x1024" "bo_calendar_tips.e2e:bo_calendar_tips.e2e.js:" "money.e2e:money.e2e.js:" \
             "fo_round3.e2e:fo_round3.e2e.js:" "bo_round3.e2e:bo_round3.e2e.js:" "order_limits.e2e:order_limits.e2e.js:" \
             "captcha.e2e:captcha.e2e.js:" \
             "fo_batch1.e2e:fo_batch1.e2e.js:" "bo_batch1.e2e:bo_batch1.e2e.js:" "bo_excel.e2e:bo_excel.e2e.js:" \
             "fo_release12.e2e:fo_release12.e2e.js:" "bo_release12.e2e:bo_release12.e2e.js:" "order_release12.e2e:order_release12.e2e.js:" \
             "money12.e2e:money12.e2e.js:" \
             "fo_release13.e2e:fo_release13.e2e.js:" "bo_release13.e2e:bo_release13.e2e.js:" "order_release13.e2e:order_release13.e2e.js:" \
             "bo_modal_race.e2e:bo_modal_race.e2e.js:" \
             "fake_standin.e2e:fake_standin.e2e.js:" "fo_release14.e2e:fo_release14.e2e.js:" "bo_release14.e2e:bo_release14.e2e.js:" "order_release14.e2e:order_release14.e2e.js:" \
             "money14.e2e:money14.e2e.js:" "fo_print14.e2e:fo_print14.e2e.js:" "menu_public.e2e:menu_public.e2e.js:" "bo_menulink.e2e:bo_menulink.e2e.js:" "bo_menuqr.e2e:bo_menuqr.e2e.js:" "menu_tabs.e2e:menu_tabs.e2e.js:" \
             "fo_release15.e2e:fo_release15.e2e.js:" "bo_release15.e2e:bo_release15.e2e.js:" "order_release15.e2e:order_release15.e2e.js:" "bo_waste_edit15.e2e:bo_waste_edit15.e2e.js:" \
             "money15.e2e:money15.e2e.js:" \
             "fo16.e2e:fo16.e2e.js:" "bo16.e2e:bo16.e2e.js:1366x900" "money16.e2e:money16.e2e.js:" "bo16_investors.e2e:bo16_investors.e2e.js:"; do
      IFS=: read -r name file vp <<<"$t"
      "$DIR/e2e_reset.sh" "$DB" > /dev/null 2>&1      # every browser suite starts from a fresh seed
      BO_VIEWPORT="${vp:-1280x900}" run_node "e2e/$name#$run" "$DIR/e2e/$file"
      # what the server flagged for review during this suite (read by QA: a normal, correct flow should not be flagged)
      { echo "== e2e/$name#$run"; $PSQL -At -c "select 'sale '||coalesce(transaction_number,'?')||' '||coalesce(cashier_name,'')||' signed_in='||coalesce((select name from staff where id=s.signed_in_staff_id),'-')||' total='||grand_total||' review='||coalesce(review_reason,'') from sales s where review_reason is not null union all select 'refund '||type||' '||amount||' by='||coalesce(performed_by_name,'')||' review='||coalesce(review_reason,'') from refunds where review_reason is not null or needs_review union all select 'payout '||amount||' by='||coalesce(performed_by_name,'') from cash_movements where needs_review" 2>&1; } >> "$LOGS/review_flags.log"
    done
  done
fi

echo
echo "== summary"
printf '%-36s %-6s %8s %8s %8s\n' "suite" "result" "checks" "failed" "seconds"
all=0; bad=0
for r in "${ROWS[@]}"; do
  IFS='|' read -r n s c f sec log <<<"$r"
  printf '%-36s %-6s %8s %8s %8s\n' "$n" "$s" "$c" "$f" "$sec"
  all=$((all + c)); bad=$((bad + f))
done
echo "------------------------------------------------------------------------"
printf '%-36s %-6s %8s %8s\n' "TOTAL (${#ROWS[@]} suites, $TOTAL_FAIL failing)" "$([ $TOTAL_FAIL -eq 0 ] && echo PASS || echo FAIL)" "$all" "$bad"
echo "logs + screenshots: $QA_SHOTS"
[ $TOTAL_FAIL -eq 0 ]
