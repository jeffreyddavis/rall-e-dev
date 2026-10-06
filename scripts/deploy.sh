#!/usr/bin/env bash
# Rall-e deploy (Linux/WSL/Cowork shell). Needs: ssh alias "rally" (see scripts/ssh-config.example) and the repo .env.
# Usage: bash scripts/deploy.sh [preview|live]
# Builds in a clean Linux copy, runs all tests, uploads, and activates with automatic rollback (deploy-sms.sh).
set -euo pipefail
mode=${1:-live}
repo=$(cd "$(dirname "$0")/.." && pwd); work=$HOME/rally-build
[ -f ~/.ssh/rally.pem ] || install -m 600 "$HOME/mnt/keys/newlaunch.pem" ~/.ssh/rally.pem
echo "== Sync source =="
mkdir -p "$work"
rsync -a --delete --exclude node_modules --exclude .git --exclude .local --exclude .git --exclude data --exclude dist --exclude .env --exclude test-results --exclude screenshots --exclude design-reference "$repo/" "$work/"
cd "$work"
if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.lock-copy; then npm ci --no-audit --no-fund --ignore-scripts >/dev/null && cp package-lock.json node_modules/.lock-copy; fi
echo "== Tests =="
node --test --test-reporter=tap test/*.test.mjs > "$work/test.log" 2>&1 || { tail -n 80 "$work/test.log"; echo 'Tests failed; nothing deployed.'; exit 1; }
grep -E '^# (pass|fail)' "$work/test.log"
echo "== Build =="; npx vite build >/dev/null && ls dist/index.html >/dev/null
chmod -R u=rwX,go=rX package.json package-lock.json server dist
tar -czf "${TMPDIR:-/tmp}/rally-sms-release.tar.gz" --owner=0 --group=0 package.json package-lock.json server dist
echo "== Server config ($mode) =="
envfile=$(mktemp); trap 'shred -u "$envfile" 2>/dev/null || rm -f "$envfile"' EXIT
get() { grep -E "^$1=" "$repo/.env" | tail -1 | cut -d= -f2- | tr -d '\r'; }
op=$(get SMS_OPERATOR_KEY); [ ${#op} -ge 24 ] || { echo 'SMS_OPERATOR_KEY missing in .env'; exit 1; }
{ echo "SMS_MODE=$mode"; echo 'PUBLIC_BASE_URL=https://rall-e.ai'; echo "SMS_OPERATOR_KEY=$op"
  if [ "$mode" = live ]; then
    for k in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM_NUMBER TWILIO_MESSAGING_SERVICE_SID SMS_ALLOWED_RECIPIENTS; do [ -n "$(get $k)" ] || { echo "Set $k in .env" >&2; exit 1; }; done
    grep -E '^(TWILIO_[A-Z_]+|ANTHROPIC_API_KEY|ANTHROPIC_WORKSPACE_ID|INBOUND_EMAIL_SECRET|INBOUND_EMAIL_TO|VAULT_KEY|TICKETMASTER_API_KEY|SEATGEEK_CLIENT_ID|GOOGLE_MAPS_API_KEY|GRACENOTE_API_KEY|SERP_API_KEY|SENDBLUE_[A-Z_]+|MESSAGING_PROVIDER|STRIPE_SECRET_KEY|STRIPE_PUBLISHABLE_KEY|ANTHROPIC_MODEL|ANTHROPIC_ADMIN_KEY|OPENAI_API_KEY|OPENAI_MODEL|OPENAI_REASONING_EFFORT|OPS_VIEWER_KEY|IPINFO_TOKEN|JAMBASE_KEY|USDA_LOCALFOOD_KEY|VAPI_API_KEY|VAPI_PHONE_NUMBER_ID|VAPI_CALLS_ENABLED|VAPI_DAILY_LIMIT|ANTHROPIC_MONTHLY_BUDGET_USD|GOOGLE_FREE_[A-Z_]+|ANTHROPIC_EFFORT|SMS_AGENT|SMS_ALLOWED_RECIPIENTS|SMS_DAILY_LIMIT|SMS_CONVERSATION_DAILY_LIMIT|SMS_PER_RECIPIENT_DAILY_LIMIT)=.' "$repo/.env" | tr -d '\r'
  fi; } > "$envfile"
[ "$mode" = live ] && { grep -q '^ANTHROPIC_API_KEY=.' "$envfile" && echo 'AI texting agent: ON' || echo 'AI texting agent: OFF (no ANTHROPIC_API_KEY)'; grep -q '^VAULT_KEY=.' "$envfile" && echo 'Vault: ON' || echo 'Vault: OFF (no VAULT_KEY)'; grep -q '^STRIPE_SECRET_KEY=sk_' "$envfile" && echo 'Card storage: ON (Stripe)' || echo 'Card storage: OFF (no Stripe keys)'; echo "Discovery sources: $(grep -oE '^(TICKETMASTER_API_KEY|SEATGEEK_CLIENT_ID|GOOGLE_MAPS_API_KEY|GRACENOTE_API_KEY|SERP_API_KEY|JAMBASE_KEY|USDA_LOCALFOOD_KEY)=.' "$envfile" | cut -d_ -f1 | tr '\n' ' ')"; }
echo "== Upload + activate =="
scp -q "${TMPDIR:-/tmp}/rally-sms-release.tar.gz" "$repo/scripts/deploy-sms.sh" rally:/home/ubuntu/
scp -q "$envfile" rally:/home/ubuntu/rally-demo.env
ssh rally "ANNOUNCE_KEY=${ANNOUNCE_KEY:-agent-v1} bash /home/ubuntu/deploy-sms.sh $mode $([ "$mode" = live ] && echo announce) 2>&1" | grep -vE 'npm (WARN|notice)|^added|^$'
