# Rall-e vault (live September 28, 2026)

The vault is private storage for booking details, similar to Instinct's vault. It is keyed by the person's phone number.

| What | How it's protected |
| --- | --- |
| Name, email, address, dietary needs, allergies, reservation accounts | Encrypted in SQLite with AES-256-GCM (`VAULT_KEY`, which exists only in `.env` and `/etc/rally-demo.env`). Each save uses a fresh IV, and the auth tag detects tampering. |
| Card | Entered only in Stripe's Payment Element, loaded from js.stripe.com, so card numbers never reach Rall-e. Rall-e keeps only Stripe's customer and payment-method IDs, plus the brand, last 4 digits and expiry, all encrypted. Cards are saved for future off-session use. **Nothing is charged**: there is no charge code. |
| Access | Only through a one-time link texted to the owner's phone. The link is a 24-byte random token, stored as a hash, and expires after 15 minutes, with at most 5 links per hour per phone. |
| The page | `/v/<token>`. Strict CSP (only our scripts plus Stripe), `no-store` caching, `no-referrer`, can't be framed, and Apache doesn't log URLs. |
| The AI | Sees only a masked summary (for example "email j***@example.com; address on file (Los Angeles); card Visa ending 4242"). It can text the secure link (`send_secure_link`) and save email, dietary needs or allergies from a text (`save_details`). Everything else goes through the link. |
| Card numbers texted in | Detected with a Luhn check and scrubbed before anything is stored or sent to the AI. The person is told, and texted a secure card link. (Twilio's own message log may still hold the original text.) |
| Audit | `vault_audit` records who did what and which field names changed, never the values. |
| Delete | "Delete my vault" wipes the record and deletes the Stripe customer. |

## Turning on cards

Add test keys from https://dashboard.stripe.com/test/apikeys to `.env` as `STRIPE_SECRET_KEY=sk_test_…` and `STRIPE_PUBLISHABLE_KEY=pk_test_…`, then redeploy. Test with card 4242 4242 4242 4242, any future date, any CVC. Switching to live keys is a business decision; keep test keys until booking exists.

## Operations

- **Back up `VAULT_KEY`.** If it's lost, stored details become unreadable, and if it leaks, rotate it. Rotation isn't automated yet: decrypt with the old key, then re-encrypt with the new one.
- Vault data lives in the same SQLite file as plans (`/var/lib/rally-demo/rally.sqlite`). It is encrypted, but the database backups should still be protected.
- This is a prototype, not a PCI or SOC 2 review. Stripe keeps Rall-e at the lightest PCI scope (SAQ A) as long as card numbers are only ever entered in Stripe's form.
