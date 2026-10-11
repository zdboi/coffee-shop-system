#!/bin/bash
# restart the fake server without matching this script's own command line
for pid in $(pgrep -f "fake-supabase/server.js|^node server.js"); do kill $pid 2>/dev/null; done
sleep 0.5
cd /home/claude/tests/fake-supabase && nohup node /home/claude/tests/fake-supabase/server.js > /home/claude/tests/fake.log 2>&1 &
sleep 1
