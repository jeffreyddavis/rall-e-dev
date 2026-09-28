# Twilio demo connection

Implementation added locally September 27, 2026. **Deployed in release 20260927-002 with live SMS disabled. No SMS sent.** The public site still uses simulated messaging; live Twilio has not been verified.

## Credentials and configuration

The project's ignored `.env` is the source for local setup. Do not copy the Backend environment. Names supplied by the business map as follows:

| Supplied term | Configuration |
| --- | --- |
| Account SID | `TWILIO_ACCOUNT_SID` |
| Standard API Key SID | `TWILIO_API_KEY_SID` |
| Client Secret (for that API key) | `TWILIO_API_KEY_SECRET` |
| Live account Auth Token | `TWILIO_AUTH_TOKEN` — still needed |
| Twilio phone number | `TWILIO_FROM_NUMBER` in international format |

The API key and its secret authenticate outbound requests. The account Auth Token verifies signed inbound messages and status callbacks using Twilio's official SDK. These are different secrets. The supplied reference notes in `.env` are retained as comments. The sender's ten digits were formatted as a US +1 number for the Hollywood demo; verify ownership and SMS capability before enabling.

`SMS_MODE=preview` disables sends. `SMS_ALLOWED_RECIPIENTS` must list consenting testers in international format. `SMS_OPERATOR_KEY` is a separate generated presenter password; it is not a Twilio credential. `PUBLIC_BASE_URL` is the exact public HTTPS origin used for links and webhook signatures.

## Presenter flow

Create a plan and its guest invitations. From Invite links or Presenter controls, choose **Text approved testers**, then enter the private presenter password. Choose one guest, enter the consenting tester's number, and preview the exact invitation. In live mode only, check the consent confirmation and press **Send this text**. Confirmed plans can also send one confirmation per guest. Changing plans never sends automatically.

The password stays in React component memory while the panel is open; it is never bundled or saved to browser storage. Server routes require both the host session and presenter password. The default rolling daily cap is 20 explicit send attempts. Incoming TwiML acknowledgements are separate from that cap.

## Remaining connection steps

1. Obtain the live account Auth Token; add consenting test recipient numbers. Keep preview mode enabled.
2. Check API authentication, ownership and SMS capability of the sender, and any account-specific trial or sender registration restrictions. No live API verification has run yet.
3. The protected controls passed local HTTP/browser verification and the disabled adapter is deployed. When credentials are ready, transfer only Rall-e's selected configuration to root-owned `/etc/rally-demo.env`; never upload `.env` in the release archive. Preserve the SQLite directory.
4. Configure the dedicated Twilio number's incoming message webhook to **POST** `https://rall-e.joinfitapp.com/api/twilio/inbound`. Inspect existing number configuration first; if it serves another app, obtain a separate number or resolve routing before changing it. Each outbound request supplies its own status callback.
5. Enable live mode only for an approved tester demonstration. Send an explicitly approved message and verify phone receipt, YES/MAYBE/NO, web RSVP synchronization, delivery status and STOP.

## Behavior and prototype limits

- A preview expires after ten minutes and becomes invalid if the plan changes.
- A persistent send attempt is claimed before Twilio I/O. Duplicate clicks do not send again. A timeout is marked unknown and is never automatically retried; inspect Twilio's log before resolving it.
- Delivery callbacks validate the exact public URL and all form parameters. Accepted/queued/sent do not mean delivered. Late callbacks do not regress delivered status.
- Incoming replies are deduplicated by Twilio Message SID. A number associated with multiple active invitations is directed to its personal links rather than guessing a plan.
- STOP suppresses that phone number globally, including after resetting a demo. Re-enrollment is not implemented. Twilio handles its own STOP acknowledgement.
- Phone numbers are stored only in the server's SMS ledger. Guest views do not expose them. Presenter history shows masked numbers. No provider error payloads or secrets are returned to the browser.
- SMS invitations, confirmations and RSVP replies are the live integration scope. The existing Texts UI, MMS example and scheduled nudges remain simulations. No background scheduler or unrestricted messaging is added.

Local validation so far: **13/13 Node tests passed** (7 existing state tests, 6 SMS tests with fake provider calls) and Vite production build passed. The gated HTTP/browser preview check also passed. Real provider delivery remains unverified. Full conversational SMS discovery/planning is still pending beyond the invitation/RSVP adapter.

References: [Twilio API authentication](https://www.twilio.com/docs/usage/requests-to-twilio), [signed webhook validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security).
