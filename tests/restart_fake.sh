#!/bin/bash
# (Re)start the local Supabase stand-in on port 8787. It serves the repo's files and
# talks to the test database 'cccc' — never to the real Supabase.
DIR="$(cd "$(dirname "$0")" && pwd)"
for pid in $(pgrep -f "fake-supabase/server.js"); do kill "$pid" 2>/dev/null; done
sleep 0.5
nohup node "$DIR/fake-supabase/server.js" > "$DIR/fake.log" 2>&1 &
sleep 1
curl -s -o /dev/null -w "fake supabase: HTTP %{http_code}\n" http://localhost:8787/cccc/front/
