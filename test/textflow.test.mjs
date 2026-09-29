import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { parseInvitees } from '../server/textflow.mjs';

const account = 'AC' + 'a'.repeat(32), from = '+15005550006';
const HOST = '+13105550101', MIKE = '+13105550102', DAVE = '+13105550103';
let n = 0; const sid = () => 'SM' + (n++).toString(16).padStart(32, '0');
function setup(overrides = {}) {
  const store = new Store(':memory:'), sent = [];
  const env = { SMS_MODE: 'preview', TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: 'test-token-not-a-real-credential', TWILIO_FROM_NUMBER: from,
    TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32), SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', PUBLIC_BASE_URL: 'https://rally.example',
    SMS_SEND_SPACING_MS: '0', ...overrides };
  const sms = new Sms(store, env, { messages: { create: async payload => { sent.push(payload); return { sid: sid(), status: 'queued' }; } } });
  const out = phone => store.db.prepare("SELECT body, status, error FROM sms_log WHERE phone=? AND direction='out' AND kind != 'card' ORDER BY rowid").all(phone);
  const last = phone => out(phone).at(-1)?.body || '';
  // Keyword engine (no API key): handling is synchronous, so tests call it directly.
  const text = (phone, body) => sms.flow.receive(sms.labPhone(phone), body);
  return { store, sms, sent, out, last, text };
}
function planByText(t) {
  t.text(HOST, 'hey'); t.text(HOST, 'Jeff'); t.text(HOST, 'yes'); t.text(HOST, '4'); t.text(HOST, 'yes');
  t.text(HOST, 'Mike 310-555-0102, Dave (310) 555-0103 and Sarah');
}

test('invitee parsing handles names, numbers and connectors', () => {
  assert.deepEqual(parseInvitees('Mike 310-555-0102, Dave (310) 555-0103 and sarah'), [
    { name: 'Mike', phone: '310-555-0102' }, { name: 'Dave', phone: '(310) 555-0103' }, { name: 'Sarah', phone: '' }]);
  assert.deepEqual(parseInvitees('let me think about it'), []);
});

test('a host plans entirely by text and the group collaborates by text (preview mode sends nothing)', () => {
  const t = setup();
  t.text(HOST, 'hey'); assert.match(t.last(HOST), /first name/);
  t.text(HOST, 'Jeff'); assert.match(t.last(HOST), /Nice to meet you, Jeff/);
  t.text(HOST, 'yes'); assert.match(t.last(HOST), /1 Dinner/);
  t.text(HOST, 'something outdoors'); assert.match(t.last(HOST), /Sunset on the trail/);
  t.text(HOST, 'how much is it?'); assert.match(t.last(HOST), /free/);
  t.text(HOST, 'yes'); assert.match(t.last(HOST), /Who should we loop in/);
  t.text(HOST, 'Mike 310-555-0102, Dave (310) 555-0103 and Sarah');
  assert.match(t.last(HOST), /Invited Mike and Dave by text/); assert.match(t.last(HOST), /Sarah: https:\/\/rally\.example\/p\//);
  assert.match(t.last(MIKE), /Jeff invited you to Sunset on the trail/);

  t.text(MIKE, 'yes'); assert.match(t.last(MIKE), /You’re in/); assert.match(t.last(HOST), /Mike is in .*1 going, 2 waiting/);
  assert.match(t.last(DAVE), /Mike is in/);
  t.text(DAVE, 'how about dinner instead?'); assert.match(t.last(DAVE), /Shared your idea: Dinner at Casa Vera/);
  assert.match(t.last(HOST), /Dave suggested Dinner at Casa Vera.*\n1\) .*\nReply PICK 1/s); assert.match(t.last(MIKE), /Reply VOTE 1/);
  t.text(MIKE, 'vote 1'); assert.match(t.last(MIKE), /Vote counted .* \(2 so far\)/); assert.match(t.last(HOST), /Mike voted for Dinner/);
  t.text(HOST, 'PICK 1'); assert.match(t.last(MIKE), /switched the plan to Dinner at Casa Vera/); assert.match(t.last(DAVE), /switched the plan/);
  t.text(MIKE, 'I’ll bring a bottle of wine'); assert.equal(t.last(HOST).split('\n')[1], 'Mike: I’ll bring a bottle of wine'); assert.equal(t.last(DAVE).split('\n')[1], 'Mike: I’ll bring a bottle of wine');
  assert.match(t.last(DAVE), /^👥 Dinner at Casa Vera · Mike, Jeff \+ 1 other\nMike: I’ll bring a bottle of wine\n\(Group message/); // labeled as the group, hint only the first time
  t.text(HOST, 'Can’t wait, everyone!'); assert.equal(t.last(MIKE).split('\n')[1], 'Jeff: Can’t wait, everyone!'); assert.equal(t.last(DAVE).split('\n').length, 2);
  t.text(DAVE, 'what time?'); assert.match(t.last(DAVE), /6:00 PM/);
  t.text(HOST, 'confirm'); assert.match(t.last(HOST), /I let 2 people know/);
  assert.match(t.last(MIKE), /Jeff confirmed Dinner at Casa Vera!.*\nYour plan: https:\/\/rally\.example\/p\//s);
  t.text(DAVE, 'status'); assert.match(t.last(DAVE), /confirmed.*Going: Mike/s);

  const state = t.store.load(t.store.db.prepare("SELECT digest FROM sms_threads WHERE phone=?").get(HOST).digest);
  assert.equal(state.plan.status, 'confirmed'); assert.equal(state.plan.participants.length, 3);
  assert.equal(state.plan.participants.find(p => p.name === 'Mike').response, 'yes');
  assert.ok(state.activity.some(a => a.text === 'Mike: I’ll bring a bottle of wine'));
  assert.equal(t.sent.length, 0);
  assert.ok(t.store.db.prepare("SELECT status FROM sms_log WHERE direction='out'").all().every(r => r.status === 'preview'));
  t.store.close();
});

test('live mode texts only approved testers, queues through the messaging service and tracks status', async () => {
  const t = setup({ SMS_MODE: 'live', SMS_ALLOWED_RECIPIENTS: `${HOST},${MIKE}` });
  t.text('+13105550199', 'hello'); assert.equal(t.out('+13105550199').length, 0); // not a tester: cannot start a plan
  planByText(t);
  assert.match(t.last(HOST), /Invited Mike by text/); assert.match(t.last(HOST), /Dave hasn’t turned on Rall-e texts yet.*\nDave: https/s);
  assert.equal(t.out(DAVE)[0].status, 'blocked'); assert.equal(t.out(DAVE)[0].error, 'not-a-tester');
  await t.sms.idle();
  assert.ok(t.sent.length >= 6); assert.ok(t.sent.every(p => p.messagingServiceSid && !p.from && [HOST, MIKE].includes(p.to)));
  assert.match(t.sent[0].statusCallback, /\/api\/twilio\/status\?log=/);
  const row = t.store.db.prepare("SELECT id, sid FROM sms_log WHERE phone=? AND direction='out' ORDER BY rowid").get(MIKE);
  t.sms.logCallback(row.id, { MessageSid: row.sid, MessageStatus: 'delivered' }); t.sms.logCallback(row.id, { MessageSid: row.sid, MessageStatus: 'sent' });
  assert.equal(t.store.db.prepare('SELECT status FROM sms_log WHERE id=?').get(row.id).status, 'delivered');
  t.store.close();
});

test('web actions notify linked phones; muting on the web and STOP by text stop group updates', async () => {
  const t = setup();
  const { id } = t.store.create('Alex'); t.store.hostAction(id, 'location'); t.store.hostAction(id, 'vibe', { category: 'dinner' }); t.store.hostAction(id, 'accept');
  const s = t.store.hostAction(id, 'invite', { names: ['Mike', 'Dave'] }), [mike, dave] = s.plan.participants;
  assert.match(t.sms.linkHost(id, { phone: HOST }).status, /preview/);
  t.sms.flow.linkGuest(t.store.digestOf(id), s, mike.id, MIKE); t.sms.flow.linkGuest(t.store.digestOf(id), s, dave.id, DAVE);
  t.store.guestAction(dave.invite, 'rsvp', { response: 'maybe' }); assert.match(t.last(HOST), /Dave is a maybe/);
  t.text(HOST, 'Running 10 min late'); assert.equal(t.last(MIKE).split('\n')[1], 'Alex: Running 10 min late');
  t.store.guestAction(mike.invite, 'consent', { enabled: false });
  t.text(HOST, 'Table is booked under Alex'); assert.equal(t.last(MIKE).split('\n')[1], 'Alex: Running 10 min late'); assert.equal(t.last(DAVE).split('\n')[1], 'Alex: Table is booked under Alex');
  t.sms.flow.receive(DAVE, 'STOP'); assert.equal(t.store.get(id).plan.participants[1].stopped, true);
  t.text(HOST, 'anyone else?'); assert.equal(t.last(DAVE).split('\n')[1], 'Alex: Table is booked under Alex');
  t.sms.flow.receive(DAVE, 'START'); assert.equal(t.sms.isStopped(DAVE), false);
  t.store.close();
});

test('the lab only simulates fictional 555 numbers and can be cleared', async () => {
  const t = setup();
  await assert.rejects(t.sms.simulate('+14157921234', 'hi'), /fictional 555/);
  await t.sms.simulate(HOST, 'hi'); assert.equal(t.sms.transcript([HOST]).messages.length, 2);
  t.sms.clearLab([HOST]); assert.equal(t.sms.transcript([HOST]).messages.length, 0);
  t.store.close();
});

test('a confirmed plan can be reopened, and re-invites by name reuse saved numbers after a new plan', () => {
  const t = setup();
  planByText(t); t.text(HOST, 'confirm');
  const digest = t.store.db.prepare('SELECT digest FROM sms_threads WHERE phone=?').get(HOST).digest;
  t.store.hostActionAt(digest, 'reopen', {});
  assert.equal(t.store.load(digest).plan.status, 'proposed'); assert.match(t.last(MIKE), /reopened Sunset on the trail for changes/);
  assert.deepEqual(t.sms.flow.contacts(digest).sort(), ['Dave', 'Mike']);
  t.text(HOST, 'NEW'); t.text(HOST, 'yes'); t.text(HOST, '1'); t.text(HOST, 'yes');
  const before = t.out(MIKE).length;
  t.text(HOST, 'Mike and Dave');
  assert.equal(t.out(MIKE).length, before + 1); assert.match(t.last(MIKE), /Jeff invited you to Dinner at Casa Vera/);
  assert.match(t.last(HOST), /Invited Mike and Dave by text/);
  t.store.close();
});

test('option cards share a set: each link lists every option, and "My pick" is saved (and validated)', async () => {
  const t = setup();
  const set = t.sms.flow.optionSet(HOST, ['e1', 'e2'].map(x => x));
  const known = (await import('../server/catalog.mjs')).EVENTS.slice(0, 2).map(e => e.id);
  const real = t.sms.flow.optionSet(HOST, known);
  assert.deepEqual(t.sms.flow.options(real).ids, known);
  assert.deepEqual(t.sms.flow.options(set).ids, []); // unknown ids are dropped
  assert.equal(t.sms.flow.options('nope'), null);
  assert.deepEqual(t.sms.flow.pick(real, known[1]), { pick: known[1] });
  assert.equal(t.sms.flow.options(real).pick, known[1]);
  assert.throws(() => t.sms.flow.pick(real, 'not-in-set'), /isn’t in this list/);
  t.store.close();
});

test('someone who signs up from a shared night can join it; the host is told and can remove them', () => {
  const t = setup(), TORI = '+13105550104';
  planByText(t);
  const hostThread = t.sms.flow.threadsFor(HOST).find(x => x.role === 'host'), share = t.store.shareToken(hostThread.s, hostThread.digest);
  t.sms.flow.createHost(TORI, 'Mike'); // a new member whose first name clashes with a guest
  const r = t.sms.flow.joinShared(TORI, 'Mike', share);
  assert.match(r.link, /\/p\//); assert.match(t.last(TORI), /You’re in for Jeff’s plan/);
  assert.match(t.last(HOST), /Mike 2 joined .* from the shared link/);
  assert.equal(t.sms.flow.joinShared(TORI, 'Mike', share).already, 'guest'); // no duplicates
  assert.equal(t.sms.flow.joinShared(HOST, 'Jeff', share).already, 'host');
  const s = t.store.hostActionAt(hostThread.digest, 'removeGuest', { name: 'Mike 2' });
  assert.ok(!s.plan.participants.some(p => p.name === 'Mike 2'));
  assert.ok(!t.sms.flow.threadsFor(TORI).some(x => x.digest === hostThread.digest)); // no more updates
  t.store.close();
});

test('a friend invited by link can turn on texts from their invite page (consent + code), then gets plan updates', async () => {
  const { Signup } = await import('../server/signup.mjs');
  const t = setup({ SMS_MODE: 'live', SMS_ALLOWED_RECIPIENTS: HOST }), DEB = '+19062841611';
  t.text(HOST, 'hey'); t.text(HOST, 'Jeff'); t.text(HOST, 'yes'); t.text(HOST, '4'); t.text(HOST, 'yes'); t.text(HOST, 'Deb 906-284-1611');
  const hostThread = t.sms.flow.threadsFor(HOST)[0], deb = hostThread.s.plan.participants.find(p => p.name === 'Deb');
  assert.match(t.last(HOST), /Deb hasn’t turned on Rall-e texts yet/);
  const signup = new Signup(t.store, t.sms);
  assert.throws(() => signup.sendCode({ phone: DEB, join: 'guest-invite' }), /Tick the box/);
  signup.sendCode({ phone: DEB, join: 'guest-invite', consent: true });
  const code = /code is (\d{6})/.exec(t.store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND kind='otp'").get(DEB).body)[1];
  signup.verify({ phone: DEB, code });
  assert.deepEqual(t.sms.flow.guestTexts(deb.invite, DEB), { texting: true });
  assert.ok(t.sms.allowed.has(DEB)); assert.match(t.last(DEB), /you’re in the loop for Jeff’s plan/);
  t.text(HOST, 'Running late, sorry all'); assert.match(t.last(DEB), /Jeff: Running late, sorry all/);
  await t.sms.idle(); t.store.close();
});
