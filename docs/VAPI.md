# Restaurant calling with Vapi

Reviewed against Vapi's documentation and public OpenAPI schema on 2026-10-01.

## Phone number setup

Vapi's current [phone calling guide](https://docs.vapi.ai/phone-calling) and [free-number guide](https://docs.vapi.ai/free-telephony) say free Vapi-managed numbers are inbound only. Adding account credits pays for usage; it does not change the number's provider. The configured Vapi-managed number ending 4060 returned HTTP 400 with Vapi's outbound daily-limit message on two controlled attempts, with no earlier calls visible on that number in the prior 14 days. That response does not prove that a successful-call quota was exhausted.

The documented outbound setup is an imported carrier number. Jeff explicitly authorized importing the separate Twilio number ending 6699. It is now active in Vapi with SMS disabled. The live Twilio texting line's routing was verified unchanged. See [Import number from Twilio](https://docs.vapi.ai/phone-numbers/import-twilio).

`VAPI_PHONE_NUMBER_ID` is the imported resource's ID, not its telephone number. The API key and phone number must belong to the same Vapi organization. Secrets and resource IDs stay in `.env`, which the deploy script copies through its whitelist.

## Assistant and callback setup

Rall-e sends a transient assistant in each `POST /call`, containing the specific reservation and callback configuration. No saved dashboard assistant is required. The blank phone-number Server URL in the screenshot is therefore not the blocker: the assistant's URL has higher priority. See [Server URL priority](https://docs.vapi.ai/server-url/setting-server-urls).

Each assistant supplies `/api/vapi/webhook?id=<call-record>` with a random `x-rally-voice-secret` header. Keep that header: since September 23, 2026, Vapi does not automatically attach organization credentials to server URLs supplied in transient configurations. See [Server authentication](https://docs.vapi.ai/server-url/server-authentication).

The voice remains `Elliot`, an active Vapi voice. The assistant has an explicit `endCall` tool so saying goodbye ends the connection. Audio recordings, pipeline logs, and SIP packet captures are disabled. Transcript artifacts are enabled at Vapi because extraction needs the conversation messages; Rall-e stores only the limited reservation result locally. In controlled tests, the same full automated conversation produced a result with transcripts enabled, while disabling them left only the system message and skipped extraction under Vapi's two-message minimum. Vapi retains its transcript according to the account's retention policy. See [Call artifacts](https://docs.vapi.ai/assistants/call-recording), [Built-in tools](https://docs.vapi.ai/tools/default-tools), and [Vapi Voices](https://docs.vapi.ai/providers/voice/vapi-voices).

## Reservation results

Vapi recommends structured outputs for new integrations; the older `analysisPlan.structuredDataPlan` still works. Rall-e now sends one inline structured output in `artifactPlan.structuredOutputs`, supported by the [public API schema](https://api.vapi.ai/api-json), and reads the named result from `artifact.structuredOutputs`. Existing legacy call results remain readable. See [Call analysis](https://docs.vapi.ai/assistants/call-analysis) and [Structured outputs](https://docs.vapi.ai/assistants/structured-outputs).

Extraction runs after the call ends. The authenticated end report and API reconciliation wait for it before reporting an uncertain outcome. A confirmation must match the requested date, time, and party size. Vapi's `customer-did-not-answer` and `customer-busy` reasons report no answer; call-start and never-connected errors report that the connection failed, without claiming a restaurant was reached. See [Call end reasons](https://docs.vapi.ai/calls/call-ended-reason).

## Activation

Completed on 2026-10-01: controlled calls verified the imported number's connection and production callback. A full conversation between our owned lines verified extraction and result recording with zero tester texts. The temporary inbound responder was restored and synthetic records were removed after database backups. All 103 tests and the production build passed; deployment and runtime verification confirmed calling is enabled.

Before setting `VAPI_CALLS_ENABLED=live`, make a controlled call from the imported number to Rall-e's own automated voice line. Verify connection, the authenticated production callback, and structured extraction. Use a synthetic test owner so `sms.deliver()` cannot text a tester. Back up the database before inserting any controlled-test records, then remove those records after verification.

Deploy through `scripts/deploy.sh live` and verify the live switch. Calls remain limited to explicit member requests and Google-verified restaurant destinations. Jeff approved sending the release announcement on 2026-10-01; it is released through the normal member update queue.
