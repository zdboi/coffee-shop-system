#!/bin/bash
./reset_db.sh >/dev/null 2>&1 && psql -h /tmp -p 54329 -U postgres -d cccc -v ON_ERROR_STOP=1 -q -f sql/20_seed_e2e.sql
