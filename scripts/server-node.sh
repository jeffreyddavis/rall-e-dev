#!/usr/bin/env bash
# Run a one-off Node script against the LIVE server's database and settings, as the app's own user.
# Usage: bash scripts/server-node.sh path/to/script.mjs [--stop]
#   --stop  stops the app while the script runs (use for anything that rewrites sessions/threads).
# The script can import from ./server/... (it runs in /opt/rally-demo/current) and read process.env (/etc/rally-demo.env).
# DB: /var/lib/rally-demo/rally.sqlite. The app is on 127.0.0.1:3107. Back up the DB first for any write.
set -euo pipefail
file=${1:?script path}; name=/tmp/rall-e-oneoff-$$.mjs
scp -q "$file" rally:$name
stop=0; [ "${2:-}" = --stop ] && stop=1
ssh rally "sudo chmod 644 $name; [ $stop = 1 ] && sudo systemctl stop rally-demo; sudo systemd-run --wait --pipe -q --uid=rally-demo -p EnvironmentFile=/etc/rally-demo.env -p Environment=PORT=3107 -p WorkingDirectory=/opt/rally-demo/current /opt/rally-demo/runtime/bin/node $name; rc=\$?; [ $stop = 1 ] && sudo systemctl start rally-demo; rm -f $name; exit \$rc"
