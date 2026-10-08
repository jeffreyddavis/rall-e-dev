import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { helperAllowed } from '../server/handoffs.mjs';

const HOST = '+13105550101', ANA = '+13105550109', BEN = '+13105550108';
const KEY = 'a-test-presenter-password-over-24';
let n = 0;
const tool = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `ho_${n++}`, name, input }] });
const say = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const sys = b => Array.isArray(b.system) ? b.system.map(x => x.text).join('\n\n') : b.system;

function setup(script = []) {
  const store = new Store(':memory:');
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body), next = script.shift();
    if (!next) throw new Error('script exhausted');
    return { ok: true, status: 200, headers: new Map(), json: async () => typeof next === 'function' ? next(body) : next };
  };
  const env = { SMS_MODE: 'preview', ANTHROPIC_API_KEY: 'test-key', SMS_OPERATOR_KEY: KEY, PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', SMS_ALLOWED_RECIPIENTS: HOST };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  return { store, sms, text: (p, b) => sms.simulate(p, b) };
}

test('helpers: each has their own key that opens only the handoff queue; switching one off locks them out and frees their work', () => {
  const { store, sms } = setup(), h = sms.handoffs;
  assert.equal(h.available(), false);
  const ana = h.addHelper({ name: 'Ana', phone: '(310) 555-0109' });
  assert.ok(ana.key.length >= 24); assert.equal(h.available(), true);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM helpers WHERE key_hash=?').get(ana.key).n, 0); // only a hash is stored
  assert.deepEqual(sms.opsWho(ana.key, 'a'), { role: 'helper', helper: { id: ana.id, name: 'Ana' } });
  assert.equal(sms.opsWho(KEY, 'a').role, 'operator');
  assert.throws(() => sms.opsWho('x'.repeat(30), 'b'), /That key didn’t work/);
  for (const path of ['/api/ops/handoffs', '/api/ops/me']) assert.equal(helperAllowed(path), true);
  for (const path of ['/api/ops/people', '/api/ops/thread', '/api/ops/say', '/api/ops/wipe', '/api/ops/helpers', '/api/ops/usage', '/api/ops/ideas', '/api/ops/nudge']) assert.equal(helperAllowed(path), false, path);
  assert.throws(() => h.addHelper({ name: ' ' }), /name/);

  const job = h.add(HOST, { name: 'Jeff', kind: 'reservation', goal: 'Table for 4 at Funke, Sat 7:30', tried: 'Booking link showed nothing' });
  // New handoffs text every active helper with a phone (through deliver, which applies opt-in: Ana isn't opted in here).
  assert.match(store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND kind='helper'").get(ANA).body, /New Rall-e handoff \(reservation\): Table for 4 at Funke/);
  h.claim(job.id, { id: ana.id, name: 'Ana' });
  h.setHelper(ana.id, { active: false });
  assert.equal(h.get(job.id).status, 'open'); assert.equal(h.get(job.id).helper, null);
  assert.throws(() => sms.opsWho(ana.key, 'c'), /That key didn’t work/);
  assert.equal(h.available(), false);
  store.close();
});

test('Rall-e hands off only while a helper is active, knows what is waiting, and texts the helper’s result in its own voice', async () => {
  const t = setup([
    tool('start_account', { first_name: 'Jeff' }), say('Nice to meet you, Jeff!'),
    body => { assert.equal(body.tools.some(x => x.name === 'hand_off'), false); return say('Here’s the booking link.'); },
    body => { assert.ok(body.tools.some(x => x.name === 'hand_off')); return tool('hand_off', { kind: 'reservation', goal: 'Table for 4 at Funke, Sat Oct 10, 7:30 PM', details: 'Under Jeff; 7–8:30 is fine', tried: 'Booking link had no times; the call went to voicemail' }); },
    body => { assert.match(JSON.stringify(body.messages.at(-1)), /a person on the Rall-e team will take it from here/); return say('Got it, someone on my team will handle it and text you back.'); },
    body => { assert.match(sys(body), /Handed to the Rall-e team, waiting on a person.*Table for 4 at Funke.*not picked up yet/); return say('Someone is on it!'); }
  ]);
  const h = t.sms.handoffs;
  await t.text(HOST, "Hi! I'm Jeff");
  await t.text(HOST, 'can you get us into Funke saturday?');
  const ana = h.addHelper({ name: 'Ana' }), ben = h.addHelper({ name: 'Ben', phone: BEN });
  await t.text(HOST, 'the link didn’t work, can someone call them?');
  await t.text(HOST, 'any news?');

  const [job] = h.list();
  assert.equal(job.status, 'open'); assert.equal(job.name, 'Jeff'); assert.equal(job.phone, '••• 0101'); assert.match(job.tried, /voicemail/);
  assert.ok(job.convo.some(m => m.from === 'them' && /someone call them/.test(m.text)));
  assert.equal(job.convo.some(m => /New Rall-e handoff/.test(m.text)), false); // helper alerts never show as their chat

  const A = { id: ana.id, name: 'Ana' }, B = { id: ben.id, name: 'Ben' };
  h.claim(job.id, A);
  assert.throws(() => h.claim(job.id, B), /already took/);
  assert.throws(() => h.resolve(job.id, B, { outcome: 'done', result: 'x booked' }), /Someone else/);
  assert.throws(() => h.release(job.id, B), /Only the person/);
  assert.equal(h.reveal(job.id, A).phone, HOST);
  assert.match(JSON.stringify(h.list()[0].log), /Ana","what":"Looked at their phone number/);
  assert.throws(() => h.resolve(job.id, A, { outcome: 'done', result: '' }), /Write what Rall-e should tell them/);

  const nudges = []; t.sms.flow.operatorNudge = (phone, what) => nudges.push({ phone, what });
  const done = h.resolve(job.id, A, { outcome: 'done', result: 'Booked at Funke, Sat 7:30 PM, party of 4, under Jeff. Confirmation A12.', note: 'They only take 6+ online' });
  assert.equal(done.status, 'done'); assert.equal(done.told, 'Rall-e is texting them the result.');
  assert.equal(nudges[0].phone, HOST); assert.match(nudges[0].what, /Confirmation A12.*someone on the team took care of it/s);
  assert.match(h.openFor(HOST), /^$/); // nothing waiting anymore
  assert.throws(() => h.claim(job.id, B), /finished/);

  // At most 3 waiting at once per person.
  for (let i = 0; i < 3; i++) h.add(HOST, { kind: 'call', goal: `Ask venue ${i}`, tried: 'no answer' });
  assert.throws(() => h.add(HOST, { kind: 'call', goal: 'one more', tried: '-' }), /already have 3/);
  t.store.close();
});

test('a member who opted out is never texted a result', () => {
  const { store, sms } = setup(), h = sms.handoffs, ana = h.addHelper({ name: 'Ana' });
  const job = h.add(HOST, { kind: 'info', goal: 'Is the patio dog friendly?', tried: 'Website says nothing' });
  sms.isStopped = phone => phone === HOST;
  const r = h.resolve(job.id, { id: ana.id, name: 'Ana' }, { outcome: 'done', result: 'Yes, dogs welcome on the patio.' });
  assert.equal(r.status, 'done'); assert.match(r.told, /opted out/);
  store.close();
});
