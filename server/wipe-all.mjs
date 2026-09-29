// Command line: wipe every conversation (for the switch from testing to a public phase).
//   node server/wipe-all.mjs --confirm-wipe-all-conversations
import { Store } from './store.mjs';
import { Sms } from './sms.mjs';
import { wipeAllConversations } from './wipe.mjs';
if (!process.argv.includes('--confirm-wipe-all-conversations')) { console.log('Refusing: pass --confirm-wipe-all-conversations. This permanently deletes every text and group message.'); process.exit(1); }
const store = new Store(process.env.DB_PATH || '/var/lib/rally-demo/rally.sqlite'), sms = new Sms(store);
console.log('Wiped:', JSON.stringify(wipeAllConversations(sms)));
store.close();
