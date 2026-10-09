// Google Apps Script: hands newsletters sent to events@rall-e.ai to Rall-e. It replaces the Cloudflare Email Worker
// (ops/cloudflare-email-worker.js) since rall-e.ai mail moved to Google Workspace (10-09): Cloudflare Email Routing and
// Google can't both receive mail for the domain.
//
// events@rall-e.ai is an alias on the admin's Workspace account. Setup (once, in that account):
//   1. Gmail > Settings > Filters > Create filter. "To": events@rall-e.ai (not deliveredto:, which shows jeff@ for an alias)
//      Then: Skip the Inbox, Apply the label "Rall-e events", Never send it to Spam.
//   2. script.google.com > New project > paste this file. Project Settings > Script properties:
//        RALLE_URL       https://rall-e.ai/api/inbound/email
//        INBOUND_SECRET  the INBOUND_EMAIL_SECRET value from the repo .env (never paste it anywhere else)
//   3. Run forwardEvents once and approve the access it asks for (read Gmail, connect to rall-e.ai).
//   4. Triggers (clock icon) > Add trigger: forwardEvents, Time-driven, Minutes timer, Every 5 minutes.
//
// Each message is sent once (remembered by id); Rall-e also skips duplicates by Message-ID. Messages Rall-e refuses
// (bad secret, server down) are retried on the next run, and get the label "Rall-e events/failed" after 12 tries.
const LABEL = 'Rall-e events', FAILED = 'Rall-e events/failed', MAX_TRIES = 12, MAX_BYTES = 10 * 1024 * 1024;

function forwardEvents() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('RALLE_URL'), secret = props.getProperty('INBOUND_SECRET');
  if (!url || !secret) throw new Error('Set RALLE_URL and INBOUND_SECRET under Project Settings > Script properties.');
  const sent = JSON.parse(props.getProperty('sent') || '[]'), tries = JSON.parse(props.getProperty('tries') || '{}');
  const failedLabel = GmailApp.getUserLabelByName(FAILED) || GmailApp.createLabel(FAILED);
  // Newsletters with the same subject thread together in Gmail, so look at every message, not just new threads.
  for (const thread of GmailApp.search(`label:"${LABEL}" newer_than:3d`, 0, 50)) {
    for (const msg of thread.getMessages()) {
      const id = msg.getId();
      if (sent.includes(id) || (tries[id] || 0) >= MAX_TRIES) continue;
      const raw = msg.getRawContent();
      if (raw.length > MAX_BYTES) { sent.push(id); continue; } // too big for Rall-e; skip it
      const r = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Basic ' + Utilities.base64Encode('inbound:' + secret) },
        payload: JSON.stringify({ raw: Utilities.base64Encode(Utilities.newBlob(raw).getBytes()), from: msg.getFrom(), to: 'events@rall-e.ai' })
      });
      if (r.getResponseCode() < 300) { sent.push(id); delete tries[id]; continue; }
      tries[id] = (tries[id] || 0) + 1;
      console.error('Rall-e answered ' + r.getResponseCode() + ' for "' + msg.getSubject() + '": ' + r.getContentText().slice(0, 200));
      if (tries[id] >= MAX_TRIES) thread.addLabel(failedLabel);
    }
  }
  props.setProperty('sent', JSON.stringify(sent.slice(-300)));
  props.setProperty('tries', JSON.stringify(tries));
}
