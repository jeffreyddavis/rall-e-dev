import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';

function ready(store) {
  const { id } = store.create('Alex');
  store.hostAction(id,'location');
  store.hostAction(id,'vibe',{category:'live shows'});
  store.hostAction(id,'accept');
  const s = store.hostAction(id,'invite',{names:['Mike','Dave']});
  return { id, s, invite:s.plan.participants[0].invite };
}
test('shared RSVP, guest suggestions, voting, and host finalization use one state',()=>{
  const store=new Store(':memory:');const {id,s,invite}=ready(store);
  const guest=store.guestAction(invite,'text',{text:'YES'});
  assert.equal(guest.plan.participants[0].response,'yes');
  assert.equal(store.get(id).plan.participants[0].response,'yes');
  assert.equal(guest.plan.participants[0].invite,undefined);
  assert.equal(guest.preferences,undefined);
  assert.equal(guest.messages,undefined);
  store.guestAction(invite,'suggest',{eventId:'trail',reason:'A little fresh air'});
  const idea=store.get(id).plan.suggestions[0];
  store.guestAction(s.plan.participants[1].invite,'vote',{id:idea.id});
  assert.equal(store.get(id).plan.suggestions[0].votes.length,2);
  store.hostAction(id,'selectSuggestion',{id:idea.id});
  assert.deepEqual(store.get(id).plan.stops,['trail']);
  store.hostAction(id,'confirm');
  assert.throws(()=>store.guestAction(invite,'suggest',{eventId:'dinner'}),/closed/);
  assert.throws(()=>store.hostAction(id,'addStop',{eventId:'dinner'}),/closed/);
  store.hostAction(id,'happened');
  assert.equal(store.get(id).preferences.nature,2);
  store.close();
});
test('locked plans forbid suggestions and tokens cannot exercise host authority',()=>{
  const store=new Store(':memory:');const {id,invite}=ready(store);
  store.hostAction(id,'mode',{mode:'locked'});
  assert.throws(()=>store.guestAction(invite,'suggest',{eventId:'trail'}),/closed/);
  assert.throws(()=>store.guestAction(invite,'confirm'),/Unknown guest/);
  assert.throws(()=>store.get(invite),/Start your own/);
  assert.throws(()=>store.guest('invalid'),/expired/);
  store.db.exec('UPDATE invites SET expires=0');
  assert.throws(()=>store.guest(invite),/expired/);
  store.close();
});
test('reset is scoped and invalidates only that demo’s invitations',()=>{
  const store=new Store(':memory:');const a=ready(store),b=ready(store);
  store.reset(a.id);
  assert.throws(()=>store.guest(a.invite),/expired/);
  assert.equal(store.guest(b.invite).person.name,'Mike');
  assert.equal(store.get(a.id).plan.stops.length,0);
  store.close();
});
test('consent is explicit and STOP suppresses previews without blocking web RSVP',()=>{
  const store=new Store(':memory:');const {id,invite}=ready(store);
  assert.equal(store.guest(invite).person.consent,false);
  store.guestAction(invite,'rsvp',{response:'yes'});
  assert.equal(store.guest(invite).person.consent,false);
  store.guestAction(invite,'consent',{enabled:true});
  assert.ok(store.guest(invite).person.consentAt);
  store.guestAction(invite,'text',{text:'STOP'});
  assert.equal(store.guest(invite).person.consent,false);
  assert.throws(()=>store.guestAction(invite,'text',{text:'YES'}),/stopped/);
  store.guestAction(invite,'rsvp',{response:'maybe'});
  store.hostAction(id,'recurring',{enabled:true});store.chat(id,'STOP');
  assert.throws(()=>store.hostAction(id,'nudge',{kind:'weekend'}),/stopped/);
  store.close();
});
test('nudges are opt-in, relevant, and deduplicated',()=>{
  const store=new Store(':memory:');const {id}=ready(store);
  assert.throws(()=>store.hostAction(id,'nudge',{kind:'weekend'}),/Opt in/);
  store.hostAction(id,'recurring',{enabled:true});store.hostAction(id,'nudge',{kind:'weekend'});
  assert.throws(()=>store.hostAction(id,'nudge',{kind:'weekend'}),/already/);
  store.hostAction(id,'nudge',{kind:'followup'});
  assert.throws(()=>store.hostAction(id,'nudge',{kind:'followup'}),/already/);
  store.close();
});
test('state survives close and reopen, including invitations and preferences',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rally-test-')),file=join(dir,'test.sqlite');
  let store=new Store(file);const {id,invite}=ready(store);
  store.chat(id,'not that, something outdoors');
  store.guestAction(invite,'rsvp',{response:'yes'});store.close();
  store=new Store(file);
  assert.equal(store.get(id).recommendation,'trail');
  assert.equal(store.get(id).preferences.nature,1);
  assert.equal(store.guest(invite).person.response,'yes');
  store.close();rmSync(dir,{recursive:true});
});
test('one suggestion per guest, three stops maximum, and input validation',()=>{
  const store=new Store(':memory:');const {id,invite}=ready(store);
  store.guestAction(invite,'suggest',{eventId:'trail'});
  store.guestAction(invite,'suggest',{eventId:'dinner'});
  assert.equal(store.get(id).plan.suggestions.length,1);
  store.hostAction(id,'addStop',{eventId:'dinner'});store.hostAction(id,'addStop',{eventId:'comedy'});
  assert.equal(store.get(id).plan.stops.length,3);
  assert.throws(()=>store.hostAction(id,'addStop',{eventId:'museum'}),/3 stops/);
  assert.throws(()=>store.chat(id,'x'.repeat(1001)),/between/);
  assert.throws(()=>store.guestAction(invite,'rsvp',{response:'invalid'}),/Try YES/);
  store.close();
});

test('the host evening link reads the night without invite tokens and can adopt a friend’s idea', async () => {
  const { Store } = await import('../server/store.mjs'), { EVENTS } = await import('../server/catalog.mjs');
  const store = new Store(':memory:'), { id } = store.create('Jeff');
  store.hostAction(id, 'location'); store.hostAction(id, 'vibe', { category: 'dinner' }); store.hostAction(id, 'accept');
  const s = store.hostAction(id, 'mode', { mode: 'loose' }); const s2 = store.hostAction(id, 'invite', { names: ['Mike'] });
  const mike = s2.plan.participants[0], other = EVENTS.find(e => !s2.plan.stops.includes(e.id));
  store.guestAction(mike.invite, 'suggest', { eventId: other.id });
  const token = store.nightLink(store.digestOf(id)), night = store.night(token);
  const view = store.view(night.s, 'host');
  assert.equal(view.plan.suggestions.length, 1); assert.ok(view.plan.participants.every(p => !p.invite));
  const after = store.hostActionAt(night.digest, 'addStop', { eventId: other.id, suggestion: view.plan.suggestions[0].id });
  assert.ok(after.plan.stops.includes(other.id)); assert.equal(after.plan.suggestions.length, 0);
  assert.equal(after.plan.title, after.plan.stops.map(id => EVENTS.find(e => e.id === id).short).join(' + ')); // renamed after its stops
  const share = store.shareToken(after, night.digest); assert.equal(store.shareToken(after, night.digest), share); // stable
  assert.equal(store.shared(share).plan.title, after.plan.title); assert.throws(() => store.shared('y'.repeat(12)), /isn’t available/);
  assert.throws(() => store.night('x'.repeat(24)), /expired/);
  store.close();
});
