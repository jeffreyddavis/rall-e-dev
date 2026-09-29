// One-time "it's ready" text to the approved testers, run by the go-live script on the server.
// Sends at most once per announcement key, only in live mode, only to allowlisted, non-opted-out numbers.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Sms } from './sms.mjs';

const key = process.argv[2] || 'agent-v1', only = (process.argv[3] || '').split(',').filter(Boolean);
const root = fileURLToPath(new URL('../', import.meta.url));
const store = new Store(process.env.DB_PATH || resolve(root, 'data/rally.sqlite'));
const sms = new Sms(store);
store.db.exec('CREATE TABLE IF NOT EXISTS announcements (key TEXT PRIMARY KEY, at INTEGER NOT NULL)');
if (!sms.live) console.log('Not announced: server is not in live mode.');
else if (!sms.flow.agent.enabled) console.log('Not announced: the texting agent is off (set ANTHROPIC_API_KEY).');
else if (store.db.prepare('SELECT 1 FROM announcements WHERE key=?').get(key)) console.log(`Already announced (${key}).`);
else {
  const base = sms.base || 'https://rall-e.ai';
  for (const phone of sms.testers) {
    if (sms.isStopped(phone) || (only.length && !only.includes(phone))) continue;
    const known = sms.flow.threadsFor(phone).length > 0;
    if (key.startsWith('imessage-pause')) { sms.deliver(phone, `Rall-e: sorry for the mix-up! iMessage isn't ready yet, so please ignore the (917) number and keep texting me here. Nothing you sent there was lost on our side, it just never reached me.`, { kind: 'announce' }); console.log(`Paused iMessage: ••• ${phone.slice(-4)}`); continue; }
    if (key.startsWith('imessage-invite')) { await sms.nudgeImessage(phone); console.log(`Invited to iMessage: ••• ${phone.slice(-4)}`); continue; }
    const text = key.startsWith('imessage-invite')
      ? `Rall-e is moving to iMessage 💙 Text "hi" to (917) 625-7748 to switch over. Your plans come with you. Until then, I'll keep texting you from this number.`
      : key.startsWith('imessage')
      ? `Rall-e is on iMessage now 💙 This is my new number, so save the contact card below. Everything carries over: your plans, your vault, where you are. Just keep texting me here.`
      : `Rall-e is ready to test: I'm now an AI you can text like a friend. Try "find us something fun Saturday night" or "plan dinner with Mike and Marc".${known ? ' Our earlier plan is still here — say "start over" for a fresh one.' : ''} You can also sign up with your number at ${base}.`;
    sms.deliver(phone, text, { kind: 'announce' });
    sms.flow.sendCard(phone, key.startsWith('imessage'));
    console.log(`Announced to ••• ${phone.slice(-4)}`);
  }
  store.db.prepare('INSERT INTO announcements VALUES (?, ?)').run(key, Date.now());
  await sms.idle();
  const rows = store.db.prepare("SELECT status, COUNT(*) AS n FROM sms_log WHERE kind IN ('announce','card') AND created > ? GROUP BY status").all(Date.now() - 120000);
  console.log('Send results:', rows.map(r => `${r.status}=${r.n}`).join(', '));
}
store.close();
