#!/usr/bin/env bash
# Activates the two-way texting release. Usage: deploy-sms.sh [preview|live]. Rolls back automatically on a failed health check.
set -euo pipefail
mode=${1:-preview}
case "$mode" in preview|live) ;; *) echo 'Mode must be preview or live'; exit 1 ;; esac
stamp=$(date +%Y%m%d-%H%M%S)
base=/opt/rally-demo
release=$base/releases/$(date +%Y%m%d-%H%M%S)
previous=$(readlink -f "$base/current")
test -d "$previous"
test ! -e "$release"
sudo install -d -o ubuntu -g ubuntu -m 755 "$release"
tar -xzf /home/ubuntu/rally-sms-release.tar.gz -C "$release"
cd "$release"
export PATH="$base/runtime/bin:$PATH"
"$base/runtime/bin/node" "$base/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts
sudo chown -R root:root "$release"

# Server configuration for the chosen mode.
had_env=0
if sudo test -e /etc/rally-demo.env; then had_env=1; sudo cp -p /etc/rally-demo.env /etc/rally-demo.env.bak-$stamp; fi
grep -qx "SMS_MODE=$mode" /home/ubuntu/rally-demo.env
sudo install -m 600 -o root -g root /home/ubuntu/rally-demo.env /etc/rally-demo.env
shred -u /home/ubuntu/rally-demo.env

sudo ln -sfn "$release" "$base/current"
sudo systemctl restart rally-demo
# The page renderer (headless Chromium, scripts/setup-renderer.sh) runs from the same release when it's installed.
if systemctl is-enabled --quiet rally-render 2>/dev/null; then sudo systemctl restart rally-render || true; fi
healthy=0
for i in $(seq 1 15); do
  if curl --fail --silent http://127.0.0.1:3107/health >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [ "$healthy" != 1 ]; then
  sudo ln -sfn "$previous" "$base/current"
  if [ "$had_env" = 1 ]; then sudo cp -p /etc/rally-demo.env.bak-$stamp /etc/rally-demo.env; else sudo rm -f /etc/rally-demo.env; fi
  sudo systemctl restart rally-demo
  echo "New release failed health check; restored $previous."
  exit 1
fi
curl --fail --silent --show-error --resolve rall-e.ai:443:127.0.0.1 https://rall-e.ai/health; echo
test "$(curl --silent -o /dev/null -w '%{http_code}' --resolve rall-e.ai:443:127.0.0.1 https://rall-e.ai/lab)" = 200
test "$(curl --silent -o /dev/null -w '%{http_code}' --resolve rall-e.ai:443:127.0.0.1 -H 'Content-Type: application/json' -H 'Authorization: Bearer wrong' -d '{}' https://rall-e.ai/api/sms-lab/text)" = 403
test "$(curl --silent -o /dev/null -w '%{content_type}' --resolve rall-e.ai:443:127.0.0.1 https://rall-e.ai/rall-e.vcf)" = text/vcard
sudo systemctl is-active rally-demo
if [ "$mode" = live ] && [ "${2:-}" = announce ]; then
  # One-time "ready" text to approved testers (no-op if already sent or the agent is off).
  sudo systemd-run --quiet --wait --pipe --uid=rally-demo --gid=rally-demo -p EnvironmentFile=/etc/rally-demo.env \
    -p WorkingDirectory=/opt/rally-demo/current --setenv=NODE_ENV=production --setenv=DB_PATH=/var/lib/rally-demo/rally.sqlite \
    /opt/rally-demo/runtime/bin/node --no-warnings server/announce.mjs ${ANNOUNCE_KEY:-agent-v1} || echo 'Announcement step failed (the release itself is fine).'
fi
readlink -f "$base/current"
echo "Two-way texting release deployed in ${mode^^} mode (previous: $previous)."
