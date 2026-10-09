# rall-e.ai email: Google Workspace (from 10-09)

Team mailboxes on rall-e.ai (Mike, Marc, Jeff) are Google Workspace **Business Starter, Flexible plan** (month to month,
$8.40 per user per month, US list price). Mike asked for it on 10-09 for investor email; Jeff and Mike are super admins.

Google and Cloudflare Email Routing can't both receive mail for the domain, so Cloudflare Email Routing is off and the
Cloudflare Email Worker (`cloudflare-email-worker.js`) is retired. Newsletters to **events@rall-e.ai** (an alias on Jeff's
account) reach Rall-e through the Apps Script `google-events-forwarder.gs` instead; setup steps are at its top.

## DNS records (Cloudflare → rall-e.ai → DNS, all "DNS only")
| Type | Name | Value | Notes |
| --- | --- | --- | --- |
| TXT | `rall-e.ai` | `google-site-verification=…` | From the Workspace sign-up (domain verification). |
| MX | `rall-e.ai` | `smtp.google.com`, priority 1 | Google's current single MX record. Remove Cloudflare's `route1/2/3.mx.cloudflare.net` (turning Email Routing off does this). |
| TXT | `rall-e.ai` | `v=spf1 include:_spf.google.com ~all` | Replaces Cloudflare's SPF (`include:_spf.mx.cloudflare.net`). Only one SPF record may exist. |
| TXT | `google._domainkey` | `v=DKIM1; k=rsa; p=…` | Admin console → Apps → Google Workspace → Gmail → Authenticate email → Generate (2048-bit), add, then **Start authentication**. |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:jeff@rall-e.ai` | Start at `p=none`; move to `quarantine` after a few weeks of clean reports. |

## Order (keeps mail loss to a few minutes)
1. Sign up at workspace.google.com (Business Starter), domain rall-e.ai, first admin jeff@rall-e.ai. Choose the
   **Flexible** plan at checkout (not Annual).
2. Verify the domain with the TXT record. Nothing about mail changes yet.
3. Admin console: add users mike@ and marc@; make Mike a **Super Admin** (Account → Admin roles). Add the alias
   events@rall-e.ai to Jeff's user (Users → Jeff → User information → Alternate email addresses).
4. In Jeff's Gmail: the "Rall-e events" filter (match **To:** events@rall-e.ai; `deliveredto:` sees jeff@ for an alias) and the Apps Script (steps in `google-events-forwarder.gs`).
5. Cloudflare: Email → Email Routing → turn it off (removes its MX and SPF), then add Google's MX and SPF.
6. Admin console: activate Gmail if it asks, then DKIM (it can take up to 48 hours before the key can be generated), then DMARC.
7. Test: mail mike@ and marc@ from outside; send a sample newsletter to events@ and check /ops → Ideas.
