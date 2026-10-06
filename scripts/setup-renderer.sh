#!/usr/bin/env bash
# One-time setup of the page renderer on the live server: headless Chromium (Playwright's light "headless shell")
# plus the rally-render service (ops/rally-render.service, localhost:3108, its own 700 MB memory cap).
# Run from WSL after a deploy that includes playwright-core:  bash scripts/setup-renderer.sh
# It checks free memory first and stops if the shared host looks too tight. Undo:
#   ssh rally 'sudo systemctl disable --now rally-render; sudo rm /etc/systemd/system/rally-render.service; sudo rm -rf /opt/rally-demo/browsers'
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== Server check =="
ssh rally '. /etc/os-release; echo "$PRETTY_NAME, $(nproc) CPUs"; free -m | sed -n 1,2p; df -h /opt | tail -1; echo "rally-demo: $(systemctl is-active rally-demo)"'
avail=$(ssh rally "awk '/MemAvailable/ {print int(\$2/1024)}' /proc/meminfo")
echo "Memory available now: ${avail} MB"
if [ "$avail" -lt 900 ] && [ "${1:-}" != --anyway ]; then
  echo "Less than 900 MB available: not installing, to protect Rall-e and MacroFit. Re-run with --anyway to install regardless."; exit 1
fi
read -r -p "Install headless Chromium (about 250 MB of disk, apt system libraries) and start rally-render? [y/N] " ok
[ "$ok" = y ] || { echo 'Nothing changed.'; exit 1; }
scp -q ops/rally-render.service rally:/home/ubuntu/rally-render.service
ssh rally 'set -euo pipefail
cd /opt/rally-demo/current
test -f node_modules/playwright-core/cli.js || { echo "This release has no playwright-core: deploy first."; exit 1; }
pw() { sudo env PLAYWRIGHT_BROWSERS_PATH=/opt/rally-demo/browsers /opt/rally-demo/runtime/bin/node node_modules/playwright-core/cli.js "$@"; }
sudo install -d -o root -g root -m 755 /opt/rally-demo/browsers
echo "== System libraries for Chromium (apt) =="; pw install-deps chromium
echo "== Headless Chromium =="; pw install --only-shell chromium
sudo chmod -R a+rX /opt/rally-demo/browsers
sudo install -m 644 /home/ubuntu/rally-render.service /etc/systemd/system/rally-render.service; rm -f /home/ubuntu/rally-render.service
sudo systemctl daemon-reload
sudo systemctl enable --now rally-render
for i in $(seq 1 15); do curl -fsS http://127.0.0.1:3108/health >/dev/null 2>&1 && break; sleep 1; done
echo "== Health =="; curl -fsS http://127.0.0.1:3108/health; echo
echo "== Test render (example.com) =="; curl -fsS -X POST -H "content-type: application/json" -d "{\"url\":\"https://example.com/\"}" http://127.0.0.1:3108/render | head -c 160; echo
echo "== Memory after =="; free -m | sed -n 1,2p; systemctl status rally-render --no-pager | sed -n 1,12p'
echo 'Done. Sources that need a browser will now get one on their next debugging run (/ops → Sources → Try to fix).'
