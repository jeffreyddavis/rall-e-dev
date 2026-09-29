# Deployment handoff

**Current status: LIVE at https://rall-e.joinfitapp.com.** Deployment was explicitly approved after the diagnostic SSH change. Public HTTPS health, HTTP redirect, and all three host/guest browser tests passed. The user's GoDaddy DNS record points directly to the existing EC2 IP. No live AI or SMS has been enabled.

Requested target: `rall-e.joinfitapp.com` on existing EC2 instance `13.57.102.105` (`ec2-13-57-102-105.us-west-1.compute.amazonaws.com`), SSH user `ubuntu`. User supplied local key path `C:\keys\jeffdavis.pem` and offered to enter its passphrase interactively; do not request or save the passphrase in chat.

September 27, 2026 checks:

- Backend's `.env` AWS values were read in memory only. EC2 inventory returned `UnauthorizedOperation`, SSM inventory was denied/unavailable, and Route 53 returned `AccessDenied`. No credentials were copied.
- Ports 80 and 443 respond. Port 22 timed out before authentication using both IP and hostname. The hostname correctly resolves to the supplied IP.
- Current development-machine outbound IP was `24.236.208.253`. User reports port 22 allowed from anywhere, so security-group association, host firewall/SSH service, or network path still needs verification. No cause has been established.
- `rall-e.joinfitapp.com` did not resolve.
- Asked user whether AWS browser-based EC2 Instance Connect or their usual SSH client works; answer pending.
- No remote application files, DNS records, AWS settings, or existing sites have been modified.

## Console diagnosis

The user signed in to a dedicated Chrome AWS console session. Read-only inspection identified instance `i-018072759f9b4430b` (`macrofit-consolidated-canary`), running with 3/3 checks passed in `us-west-1a`. Its actual attached security group is `sg-02f539bb8ff7b9a0a` (`macrofit-consolidated-canary`).

Port 22 has only these two inbound sources:

- `sg-04d64597b365ce9ee`: SSH from existing newbackend jump host.
- `sg-03ad13b0ce9cff4f5`: SSH from authorized Test host jump path.

There is no public CIDR or current-client-IP SSH rule. Public 80/443 rules exist, explaining the different connection results. This is a confirmed blocker; key authentication and host SSH configuration have not yet been exercised. The launch key-pair name is `newlaunch`, which may differ from keys later added to the host.

User explicitly approved one TCP/22 inbound rule from current client IP `24.236.208.253/32`. AWS preview verified exactly one new rule with no changes to the original six. Saved successfully as `sgr-0154573269673cc28`, description `SSH from Jeff current IP for Rall-e setup`. SSH now connects immediately and reaches key authentication; the timeout is resolved. Batch-mode authentication with the supplied key returns `Permission denied (publickey)`; passphrase/key diagnosis is next. The rule should be revisited if the user's public IP changes or direct setup access is no longer needed.

User then specified `C:\keys\newlaunch.pem`. Authentication with that key succeeded as `ubuntu` on `ip-172-31-13-106` without a passphrase prompt. `jeffdavis.pem` was rejected at public-key offer, so its passphrase was not the issue. SSH connectivity and login are now verified.

Deployment used the host's Apache conventions and kept Rall-e in a separate directory/service/virtual host. No global Node runtime was installed or replaced.

## Completed deployment

- Existing host uses Ubuntu 20.04 / Apache. No Node or Docker was installed globally.
- Uploaded source/build archive SHA-256: `bebe2a056903bc1309613ee43dceda04113fbca6e820d606f03a289d6ff94e1f`.
- Official Node 24.21.0 Linux x64 archive verified against SHA-256 `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` and installed only under `/opt/rally-demo/runtime`.
- Release `/opt/rally-demo/releases/20260927-001`; `/opt/rally-demo/current` points to it. Application/runtime files owned by root; dedicated `rally-demo` user writes only to its own persistent data directory.
- `rally-demo.service` runs on 127.0.0.1:3107, restarts on failure, starts at boot, and uses `/var/lib/rally-demo/rally.sqlite`.
- Added only the new Apache virtual-host file. Enabled available `proxy`/`proxy_http` modules, config-tested successfully, then gracefully reloaded Apache.
- Issued dedicated Let's Encrypt certificate for `rall-e.joinfitapp.com`, valid through December 26, 2026. Existing Certbot timer is active; installed certificate-scoped reload hook.
- Public tests passed: 3/3, including no-account guest response, suggestion, host confirmation, refresh, mobile layout, and authorization checks. Existing local state tests had passed 7/7.
- Existing-site public root checks returned: account 200; assets 403; live/staging 404; handstand/chelsey 504. The latter two resolve through the existing `fit-backend-live` ALB, not directly to the new demo endpoint. Direct Apache root checks returned 403 for handstand/chelsey. No existing site roots, configuration files, ALB settings, or databases were changed. Do not interpret these root-path checks as a complete health assessment; report them separately if investigating the existing stack.

## Figma design update — September 27, 2026

- Active release: `/opt/rally-demo/releases/20260927-002`; previous release `20260927-001` retained for rollback.
- Source: user-supplied `Rally.zip`; mobile signup, invitation, photo choices and reply/vote confirmation implemented with blue/white branding. See `design-reference/REVIEW.md`.
- Primary experience remains SMS. The web chat is explicitly a presenter preview.
- No server credentials were uploaded. `/etc/rally-demo.env` remains absent. Twilio live sends are disabled; new Twilio routes are presenter-gated and incoming callbacks require signatures.
- Phone/code and Google screens are demo-only. Only the entered first name is saved.
- Existing SQLite data retained. Only `rally-demo` was restarted; Apache configuration and other sites were not changed.
- Validation: Vite build passed; 13/13 local state/SMS tests passed; 4/4 core browser checks and 1/1 SMS preview check passed locally; 4/4 public HTTPS browser checks passed (40.7 seconds).
- Rollback: repoint `/opt/rally-demo/current` to `20260927-001` and restart only `rally-demo`. SMS tables are additive and do not prevent the prior app reading existing plan state.

## Two-way texting release — September 28, 2026

- Active release: `/opt/rally-demo/releases/20260928-001` (deployed with `.local/deploy-sms.cmd`). Previous release retained for rollback.
- New `/etc/rally-demo.env` (root, 600): `SMS_MODE=preview`, `PUBLIC_BASE_URL`, `SMS_OPERATOR_KEY` only. No Twilio credentials on the server, so nothing can be sent.
- The remote script checked health, HTTPS health, `/lab` 200, and a rejected wrong-password lab call (403). 19/19 unit tests passed before the build. `/lab` was confirmed loading publicly afterward.
- SQLite changes are additive (`sms_log`, `sms_threads`, `sms_pending`). To roll back, repoint `current` to the prior release, then restart `rally-demo`.

## rall-e.ai domain — September 28, 2026

- Mike registered `rall-e.ai` at Cloudflare (free plan). DNS has `@` and `www` A records → `13.57.102.105`, set to **DNS only** (grey cloud). Turning on the orange-cloud proxy later requires SSL mode Full (strict).
- `.local/setup-domain.cmd` does the server setup. It:
  - issues a Let's Encrypt certificate for `rall-e.ai` and `www.rall-e.ai` through the existing webroot (expires December 27, 2026; the certbot timer renews it, and the deploy hook now reloads Apache for either lineage);
  - adds `/etc/apache2/sites-available/rall-e.ai.conf`, where `rall-e.ai` is canonical and `www` redirects 301;
  - redirects `rall-e.joinfitapp.com` 301 to `rall-e.ai` with the path preserved, so old invite links still work. Its own certificate still renews.
- `/etc/rally-demo.env` `PUBLIC_BASE_URL=https://rall-e.ai`. The Twilio webhook should be `https://rall-e.ai/api/twilio/inbound`.
- Apache backup is at `/home/ubuntu/apache-backup-20260928204124`. Checks passed on the server (health, `/lab`, redirects) and from a browser.

## Deploys run by Claude — September 28, 2026 (evening)

- Jeff turned on "All domains" network access. Claude's Cowork Linux shell on Jeff's PC can now reach the server over SSH. Its traffic leaves from Jeff's home IP (24.236.208.253), which the security group already allows. It can also reach Twilio and the Claude API.
- Deploy command, run by Claude: `bash .local/deploy.sh live` (or `preview`). It:
  - builds in a clean Linux copy (`~/rally-build`);
  - runs all 25 tests and the Vite build;
  - fixes file permissions;
  - uploads the release and a config generated from `.env`;
  - activates with `deploy-sms.sh`, which rolls back automatically on a failed health check.
- The Windows `.cmd` scripts still work, but are no longer needed.
- Release `20260929-005806` is live: phone-first signup, the contact card (`/rall-e.vcf`), and the texting agent code, with the agent OFF until `ANTHROPIC_API_KEY` is set.
- The first attempt (`20260929-005620`) failed its health check because the files were owner-only and the service couldn't read them. It was rolled back automatically, and `deploy.sh` now fixes permissions.
