import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';

const HOST = '+13105550101', MIKE = '+13105550102', DAVE = '+13105550103';
let n = 0;
const tool = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: '' }, { type: 'tool_use', id: `tu_${n++}`, name, input }] });
const say = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

// A scripted stand-in for the Claude Messages API. Each entry answers one API call.
function setup(script, overrides = {}) {
  const store = new Store(':memory:'), calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, headers: init.headers, body });
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return { ok: true, status: 200, json: async () => typeof next === 'function' ? next(body) : next };
  };
  const env = { SMS_MODE: 'preview', ANTHROPIC_API_KEY: 'test-key', SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', ...overrides };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  const out = (phone, kind) => store.db.prepare(`SELECT body, kind, media FROM sms_log WHERE phone=? AND direction='out' ${kind ? 'AND kind=?' : "AND kind != 'card'"} ORDER BY rowid`).all(...(kind ? [phone, kind] : [phone]));
  const last = phone => out(phone).at(-1)?.body || '';
  return { store, sms, calls, out, last, text: (p, b) => sms.simulate(p, b) };
}

test('the agent plans by text through tools, sends a contact card, and only invites numbers the host typed', async () => {
  const t = setup([
    tool('start_account', { first_name: 'Jeff' }), say('Nice to meet you, Jeff! Hollywood work for you?'),
    tool('recommend', { category: 'comedy' }), say('How about Small-room stand-up at The Foundry, Sat 8 PM ($25 sample)?'),
    tool('make_plan', { event_id: 'comedy' }), say('Locked in the idea! Who should I invite?'),
    tool('invite', { people: [{ name: 'Mike', phone: '310-555-0102' }, { name: 'Sarah', phone: '310-555-0177' }] }), body => {
      const result = body.messages.at(-1).content[0].content;
      assert.match(result, /Invited Mike by text/); assert.match(result, /Sarah: https:\/\/rall-e\.ai\/p\//);
      return say('Invited Mike! Here is Sarah\'s link to forward.');
    }
  ]);
  await t.text(HOST, "Hi! I'm Jeff");
  assert.equal(t.last(HOST), 'Nice to meet you, Jeff! Hollywood work for you?');
  const card = t.out(HOST, 'card'); assert.equal(card.length, 1); assert.equal(card[0].media, 'https://rall-e.ai/rall-e.vcf');
  await t.text(HOST, 'yes! something funny');
  await t.text(HOST, 'love it');
  await t.text(HOST, 'invite Mike 310-555-0102 and Sarah');
  assert.match(t.last(MIKE), /Jeff invited you to Small-room stand-up/);
  assert.equal(t.out(MIKE, 'card').length, 1);
  assert.equal(t.out('+13105550177').length, 0); // a number the host never typed is never texted
  assert.equal(t.out(HOST, 'card').length, 1); // the card goes out once per phone

  const first = t.calls[0];
  assert.equal(first.url, 'https://api.anthropic.com/v1/messages'); assert.equal(first.headers['x-api-key'], 'test-key');
  assert.equal(first.body.model, 'claude-sonnet-5-5'); assert.deepEqual(first.body.output_config, { effort: 'low' });
  assert.deepEqual(first.body.tools.map(x => x.name).filter(n => n !== 'react'), ['start_account']);
  assert.match(first.body.system, /Catalogue/); assert.equal(first.body.messages[0].role, 'user');
  assert.ok(t.calls[2].body.tools.some(x => x.name === 'recommend')); // after the account exists, host tools appear
  t.store.close();
});

test('guests talk to the agent; group notifications stay deterministic; failures fall back to keywords', async () => {
  const t = setup([
    tool('start_account', { first_name: 'Alex' }), say('Hi Alex!'),
    tool('make_plan', { event_id: 'dinner' }), say('Dinner at Casa Vera it is. Who is coming?'),
    tool('invite', { people: [{ name: 'Mike', phone: '3105550102' }, { name: 'Dave', phone: '3105550103' }] }), say('Both invited!'),
    body => { assert.deepEqual(body.tools.map(x => x.name).filter(n => !['react', 'mention_feature', 'queue_feature'].includes(n)), ['rsvp', 'suggest', 'vote', 'get_my_link', 'message_group']); assert.match(body.system, /INVITED FRIEND \(their name: Mike; host: Alex\)/); return tool('rsvp', { response: 'yes' }); },
    say('You’re in! See you Saturday.'),
    tool('message_group', { text: 'I can drive if anyone needs a ride' }), say('Passed that along to the group.'),
    new Error('network down')
  ]);
  await t.text(HOST, 'hey this is Alex'); await t.text(HOST, 'dinner please'); await t.text(HOST, 'Mike 3105550102, Dave 3105550103');
  await t.text(MIKE, 'count me in!!');
  assert.equal(t.last(MIKE), 'You’re in! See you Saturday.');
  assert.match(t.last(HOST), /Mike is in for Dinner at Casa Vera/); assert.match(t.last(DAVE), /Mike is in/);
  await t.text(MIKE, 'I can drive if anyone needs a ride');
  assert.equal(t.last(DAVE).split('\n')[1], 'Mike: I can drive if anyone needs a ride'); assert.equal(t.last(HOST).split('\n')[1], 'Mike: I can drive if anyone needs a ride');
  await t.text(DAVE, 'what time?'); // API error -> keyword engine answers
  assert.match(t.last(DAVE), /6:00 PM/);
  t.store.close();
});

test('texts from one phone are handled in order and STOP never reaches the model', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const t = setup([async () => { await gate; return (tool('start_account', { first_name: 'Jeff' })); }, say('Hi Jeff!'), say('Second reply')]);
  // Wrap the async script entry: the fetch mock awaits the promise returned from json().
  const a = t.text(HOST, 'Jeff here'), b = t.text(HOST, 'hello again');
  release(); await Promise.all([a, b]);
  assert.deepEqual(t.out(HOST).map(x => x.body), ['Hi Jeff!', 'Second reply']);
  const before = t.calls.length; await t.text(HOST, 'STOP');
  assert.equal(t.calls.length, before); assert.equal(t.sms.isStopped(HOST), true);
  t.store.close();
});

test('demo operator: Rall-e texts first on a hidden instruction; features are tracked so tips stay rare', async () => {
  const t = setup([
    tool('start_account', { first_name: 'Jeff' }), say('Hi Jeff!'),
    body => {
      const note = body.messages.at(-1).content; assert.match(note, /Behind the scenes.*emoji/s); assert.doesNotMatch(body.system, /Behind the scenes/);
      return tool('react', { reaction: '🎉' });
    },
    body => { assert.match(body.system, /Features: none shown yet/); return tool('mention_feature', { feature: 'group_chat', why: 'tip' }); },
    say('Also, texts to me are private. Start with "tell the group" to reach everyone.'),
    body => { assert.match(body.system, /already seen: .*reactions/); assert.match(body.system, /Unprompted tips: not now/); return say('Sure thing.'); }
  ]);
  await t.text(HOST, 'hi I am Jeff');
  const before = t.store.db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE phone=? AND direction='in'").get(HOST).n;
  await t.sms.flow.operatorNudge(HOST, 'React to their latest message with a fitting emoji (react).');
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE phone=? AND direction='in'").get(HOST).n, before); // nothing logged as if they said it
  assert.match(t.last(HOST), /^🎉 Also, texts to me are private/);
  const seen = t.sms.flow.agent.features.seen(HOST).map(r => `${r.feature}:${r.how}`).sort();
  assert.deepEqual(seen, ['group_chat:operator', 'reactions:operator']);
  await t.text(HOST, 'cool thanks'); // the next normal reply is told not to pitch anything
  assert.equal(t.last(HOST), 'Sure thing.');
  t.store.close();
});

test('a feature that answers a need is queued while they are mid-setup, then offered once that is done', async () => {
  const t = setup([
    tool('start_account', { first_name: 'Dana' }), say('Hi Dana!'),
    tool('queue_feature', { feature: 'vault', reason: 'their sister is vegetarian' }), say('Noted! What’s your sister’s name and number?'),
    body => { assert.match(body.system, /Queued to bring up .*vault \(their sister is vegetarian\)/); return tool('mention_feature', { feature: 'vault', why: 'need' }); },
    body => { assert.match(body.system, /Unprompted tips: allowed/); return say('Done! And since your sister is vegetarian, I can keep that on file.'); }
  ]);
  await t.text(HOST, 'hi I am Dana');
  await t.text(HOST, 'dinner with my sister, she is vegetarian');
  assert.deepEqual(t.sms.flow.agent.features.queued(HOST).map(q => q.feature), ['vault']);
  await t.text(HOST, 'Maya 310-555-0199');
  assert.deepEqual(t.sms.flow.agent.features.queued(HOST), []); // offered, so no longer pending
  assert.deepEqual(t.sms.flow.agent.features.seen(HOST).map(r => `${r.feature}:${r.how}`), ['vault:need']); // a need, not self-promotion
  t.store.close();
});

test('show_options with more than 3 picks: 3 preview cards, and every card opens a list with all of them', async () => {
  const t = setup([
    tool('start_account', { first_name: 'Mike' }), say('Hi Mike!'),
    tool('show_options', { event_ids: ['museum', 'trail', 'dinner', 'comedy', 'rooftop'] }), body => { assert.match(body.messages.at(-1).content[0].content, /3 picture card.*all 5 options/); return say('Here are five ideas for Saturday.'); }
  ]);
  await t.text(HOST, 'hi I am Mike');
  await t.text(HOST, 'give me 5 things to do saturday');
  const links = t.out(HOST, 'option').map(r => r.body);
  assert.equal(links.length, 3);
  const set = /\?s=([\w-]+)/.exec(links[0])[1];
  assert.deepEqual(t.sms.flow.options(set).ids, ['museum', 'trail', 'dinner', 'comedy', 'rooftop']);
  t.store.close();
});
