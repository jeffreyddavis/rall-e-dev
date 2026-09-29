import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { scrubCards } from '../server/vault.mjs';

const ME = '+13105550101', KEY = randomBytes(32).toString('base64');
function setup(overrides = {}, stripeReplies = {}) {
  const store = new Store(':memory:'), stripeCalls = [];
  const fetchImpl = async (url, init) => {
    stripeCalls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization });
    const path = url.replace('https://api.stripe.com/v1/', '');
    const reply = Object.entries(stripeReplies).find(([p]) => path.startsWith(p))?.[1];
    return { ok: true, status: 200, json: async () => typeof reply === 'function' ? reply(path) : reply || {} };
  };
  const env = { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', VAULT_KEY: KEY, ...overrides };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  const texts = phone => store.db.prepare("SELECT body, kind, direction FROM sms_log WHERE phone=? ORDER BY rowid").all(phone);
  const linkToken = () => /\/v\/([\w-]+)/.exec(texts(ME).filter(x => x.kind === 'vault').at(-1).body)[1];
  return { store, sms, vault: sms.vault, texts, linkToken, stripeCalls };
}

test('card numbers in texts are detected with a Luhn check and scrubbed', () => {
  assert.deepEqual(scrubCards('my card is 4242 4242 4242 4242 exp 12/28'), { clean: 'my card is [card number removed] exp 12/28', found: true });
  assert.equal(scrubCards('call me at 310-555-0101 or 4242424242424241').found, false); // phone and a non-Luhn number are left alone
});

test('details are encrypted at rest, reachable only by a fresh texted link, and the AI sees a masked summary', () => {
  const t = setup();
  t.sms.flow.receive(ME, 'hi'); t.sms.flow.receive(ME, 'Jeff');
  t.vault.sendLink(ME, 'details');
  const token = t.linkToken();
  assert.match(t.texts(ME).at(-1).body, /^Rall-e: here's your private link .* https:\/\/rall-e\.ai\/v\/[\w-]{32}\nIt works for 15 minutes/s);
  const view = t.vault.save(token, { firstName: 'Jeff', lastName: 'Davis', email: 'jeff@example.com', addressLine1: '1 Main St', city: 'Los Angeles', dietary: 'vegetarian', openTable: 'jeff@example.com' });
  assert.equal(view.fields.email, 'jeff@example.com'); assert.equal(view.phone, '••• ••• 0101');
  const raw = t.store.db.prepare('SELECT data FROM vault_profiles WHERE phone=?').get(ME).data;
  assert.match(raw, /^v1\./); for (const secret of ['Davis', 'jeff@example.com', 'Main St', 'vegetarian']) assert.ok(!raw.includes(secret));
  const summary = t.vault.summary(ME);
  assert.match(summary, /name: Jeff D\./); assert.match(summary, /email: j\*\*\*@example\.com/); assert.match(summary, /address: on file \(Los Angeles\)/); assert.match(summary, /dietary: vegetarian/);
  for (const secret of ['Davis', 'jeff@example.com', 'Main St']) assert.ok(!summary.includes(secret));
  assert.throws(() => t.vault.save(token, { otherLoyalty: 'card 4242 4242 4242 4242' }), /card numbers/);
  assert.throws(() => t.vault.view('x'.repeat(32)), /expired/);
  t.store.db.prepare('UPDATE vault_links SET expires=?').run(Date.now() - 1);
  assert.throws(() => t.vault.view(token), /expired/);
  const audit = t.store.db.prepare('SELECT action, fields FROM vault_audit').all();
  assert.ok(audit.some(a => a.action === 'save' && a.fields.includes('email'))); assert.ok(audit.every(a => !String(a.fields).includes('jeff@')));
  t.store.close();
});

test('a texted card number is never stored or shown to anyone; the sender gets a secure card link instead', () => {
  const t = setup();
  t.sms.flow.receive(ME, 'hi'); t.sms.flow.receive(ME, 'Jeff');
  t.sms.flow.receive(ME, 'use my visa 4242-4242-4242-4242 please');
  const rows = t.texts(ME);
  assert.ok(rows.every(r => !r.body.includes('4242-4242')));
  assert.ok(rows.some(r => r.direction === 'in' && r.body === 'use my visa [card number removed] please'));
  assert.match(rows.at(-2).body, /deleted that card number/); assert.match(rows.at(-1).body, /private link to add a card/);
  t.store.close();
});

test('low-risk details can be saved by text; others cannot', () => {
  const t = setup();
  assert.deepEqual(t.vault.saveFromText(ME, { email: 'a@b.co', dietary: 'vegan', addressLine1: '1 Main' }), ['email', 'dietary']);
  assert.throws(() => t.vault.saveFromText(ME, { addressLine1: '1 Main' }), /secure link/);
  assert.ok(!('addressLine1' in t.vault.load(ME)));
  t.store.close();
});

test('cards go through Stripe: only brand/last4/expiry and Stripe ids are kept; delete removes everything', async () => {
  const t = setup({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' }, {
    'customers': { id: 'cus_123' }, 'setup_intents/seti_1': { id: 'seti_1', customer: 'cus_123', status: 'succeeded', payment_method: 'pm_1' },
    'setup_intents': { id: 'seti_1', client_secret: 'seti_1_secret_x' }, 'payment_methods/pm_1': { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 } }
  });
  t.vault.sendLink(ME, 'card'); const token = t.linkToken();
  assert.deepEqual(await t.vault.startCard(token), { clientSecret: 'seti_1_secret_x' });
  assert.ok(t.stripeCalls.every(c => c.auth === 'Bearer sk_test_abc'));
  assert.match(t.stripeCalls[1].body, /usage=off_session/);
  const view = await t.vault.finishCard(token, 'seti_1');
  assert.deepEqual(view.card, { brand: 'Visa', last4: '4242', expMonth: 12, expYear: 2028 });
  assert.match(t.vault.summary(ME), /card: Visa ending 4242 \(exp 12\/28\)/);
  await t.vault.wipe(token);
  assert.ok(t.stripeCalls.some(c => c.method === 'DELETE' && c.url.endsWith('customers/cus_123')));
  assert.equal(t.store.db.prepare('SELECT COUNT(*) n FROM vault_profiles').get().n, 0);
  assert.throws(() => t.vault.view(token), /expired/);
  t.store.close();
});

test('without VAULT_KEY the vault is off and the agent gets no vault tools', () => {
  const t = setup({ VAULT_KEY: '' });
  assert.equal(t.vault.enabled, false); assert.throws(() => t.vault.sendLink(ME), /not set up/);
  t.store.close();
});
