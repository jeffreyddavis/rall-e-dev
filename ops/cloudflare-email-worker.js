// Cloudflare Email Worker for events@rall-e.ai (paste into Cloudflare: Workers & Pages > Create > Worker, then route the
// address to it under Email Routing > Routing rules). It hands each newsletter to Rall-e unchanged; Rall-e reads it.
// Settings on the Worker (Settings > Variables and Secrets):
//   RALLE_URL       https://rall-e.ai/api/inbound/email          (plain text)
//   INBOUND_SECRET  the INBOUND_EMAIL_SECRET value from .env     (Secret)
export default {
  async email(message, env) {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    if (raw.length > 10 * 1024 * 1024) { message.setReject('Message too large for Rall-e (10 MB max).'); return; }
    let bin = ''; for (let i = 0; i < raw.length; i += 0x8000) bin += String.fromCharCode(...raw.subarray(i, i + 0x8000));
    const r = await fetch(env.RALLE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${btoa(`inbound:${env.INBOUND_SECRET}`)}` },
      body: JSON.stringify({ raw: btoa(bin), from: message.from, to: message.to }),
    });
    // A refusal from Rall-e (bad secret, server down) bounces the email so the sender knows it didn't arrive.
    if (!r.ok) message.setReject(`Rall-e could not take this message (${r.status}).`);
  },
};
