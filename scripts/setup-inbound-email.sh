#!/usr/bin/env bash
# One-time: let inbound newsletters from the Cloudflare Email Worker (often well over Apache's 32 KB request limit) reach
# /api/inbound/email. Raises the limit to 15 MB for that one path only, in Rall-e's own vhost (not MacroFit's).
# Run from WSL:  bash scripts/setup-inbound-email.sh
# It backs up the vhost file, runs apache2ctl configtest, and reloads gracefully only if the test passes (else restores).
set -euo pipefail
ssh rally 'set -euo pipefail
f=$(grep -lE "ServerName (www\.)?rall-e\.ai" /etc/apache2/sites-enabled/* 2>/dev/null | xargs grep -l "127.0.0.1:3107" | head -1 || true)
[ -n "$f" ] || { echo "Could not find the rall-e.ai vhost (ServerName rall-e.ai, proxying to :3107). Nothing changed."; exit 1; }
f=$(readlink -f "$f"); echo "Rall-e vhost: $f"
grep -n "LimitRequestBody" "$f" || echo "(no LimitRequestBody set)"
if grep -q "/api/inbound/email" "$f"; then echo "Already set up. Nothing changed."; exit 0; fi'
read -r -p "Allow up to 15 MB on /api/inbound/email only, then reload Apache gracefully? [y/N] " ok
[ "$ok" = y ] || { echo 'Nothing changed.'; exit 1; }
ssh rally 'set -euo pipefail
f=$(readlink -f "$(grep -lE "ServerName (www\.)?rall-e\.ai" /etc/apache2/sites-enabled/* | xargs grep -l "127.0.0.1:3107" | head -1)")
b="$f.bak-$(date +%Y%m%d-%H%M%S)"; sudo cp -p "$f" "$b"; echo "Backup: $b"
# Insert before the closing tag of the HTTPS (443) virtual host.
sudo awk '"'"'/<VirtualHost[^>]*:443>/{in443=1} in443 && /<\/VirtualHost>/ && !done {print "    # Inbound newsletters (events@rall-e.ai, Cloudflare Email Worker) are bigger than the 32 KB limit above."; print "    <Location \"/api/inbound/email\">"; print "        LimitRequestBody 15728640"; print "    </Location>"; done=1; in443=0} {print}'"'"' "$b" | sudo tee "$f" >/dev/null
if sudo apache2ctl configtest 2>&1 | grep -q "Syntax OK"; then sudo systemctl reload apache2; echo "Apache reloaded."; grep -n -A2 "api/inbound/email" "$f";
else echo "Config test failed; restoring the backup."; sudo cp -p "$b" "$f"; sudo apache2ctl configtest; exit 1; fi
curl -s -o /dev/null -w "Test POST without a secret: %{http_code} (401 expected)\n" -X POST -H "content-type: application/json" -d "{}" https://rall-e.ai/api/inbound/email'
