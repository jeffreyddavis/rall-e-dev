import React, { useEffect, useState } from 'react';
import { Check, Plus, MessageCircle, Footprints, Car } from 'lucide-react';
import { CompactCard, ShareButton, planLink } from './OptionCard.jsx';

// The whole night in one place (Marc's ask): a timeline of every stop, then friends' ideas with who picked each.
// Friends RSVP and tap "My pick"; the host adds the favorite to the plan; a shared copy (readOnly) is view-only.
const STATUS = { proposed: 'In the making', confirmed: 'Confirmed', happened: 'One for the memories', dropped: 'Called off' };
const clock = e => { const at = e.time.includes('·') && /(\d{1,2}:\d{2})\s*(AM|PM)/i.exec(e.time.split('·')[1]); return at ? [at[1], at[2].toUpperCase()] : null; };
const smsTo = (numbers, body) => { const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent), to = (apple ? numbers?.imessage : numbers?.sms) || numbers?.sms; return to ? `sms:${to}${apple ? '&' : '?'}body=${encodeURIComponent(body)}` : ''; };

export default function EveningView({ state, meId = null, host = false, readOnly = false, cta = null, busy, renderArt, onRsvp, onVote, onAdopt, shareUrl, textNumbers }) {
  const plan = state.plan, events = state.events, byId = id => events.find(e => e.id === id);
  const people = plan.participants || [], me = people.find(p => p.id === meId), closed = ['happened', 'dropped'].includes(plan.status);
  const going = readOnly ? plan.going : 1 + people.filter(p => p.response === 'yes').length, maybe = people.filter(p => p.response === 'maybe').length;
  const [open, setOpen] = useState(() => new Set());
  const toggle = id => setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const canPick = plan.mode === 'loose' && plan.status === 'proposed';
  const nameOf = id => people.find(p => p.id === id)?.name || '';
  const stops = plan.stops.map(byId).filter(Boolean);
  const ideas = (plan.suggestions || []).map(s => ({ ...s, e: byId(s.eventId) })).filter(s => s.e);
  // Walk / drive time between consecutive stops (Marc's ask). Fetched separately so the page never waits on it.
  const stopKey = stops.map(e => e.id).join(',');
  const [legs, setLegs] = useState([]);
  useEffect(() => {
    if (stops.length < 2) { setLegs([]); return; }
    let live = true;
    fetch(`/api/travel?ids=${encodeURIComponent(stopKey)}`).then(r => r.ok ? r.json() : { legs: [] }).then(d => { if (live) setLegs(d.legs || []); }).catch(() => {});
    return () => { live = false; };
  }, [stopKey]);
  const addStop = smsTo(textNumbers, `Can we add another stop to ${plan.title}?`);
  return <section className="evening">
    <div className="evening-summary">
      <h1>{plan.title}</h1>
      <p>{host ? 'Your plan' : `${state.name}’s plan`} · {stops.length} {stops.length === 1 ? 'stop' : 'stops'} · {STATUS[plan.status]}</p>
      <div className="evening-people">
        {!readOnly && <div className="invited-avatars">{[{ name: state.name, response: 'yes', id: 'host' }, ...people].map((p, i) =>
          <span className={`avatar avatar-${i % 4} ${p.response === 'yes' ? '' : 'faded'}`} key={p.id} title={`${p.name}: ${({ yes: 'going', maybe: 'maybe', no: 'can’t make it', pending: 'hasn’t replied' })[p.response]}`}>{p.name.slice(0, 1)}</span>)}</div>}
        <span>{going} going{maybe ? `, ${maybe} maybe` : ''}</span>
      </div>
      {me && !closed && <div className="rsvp-buttons">{[['yes', 'I’m in'], ['maybe', 'Maybe'], ['no', 'Can’t go']].map(([value, label]) =>
        <button key={value} aria-pressed={me.response === value} className={`button ${me.response === value ? 'primary' : 'secondary'}`} disabled={busy} onClick={() => onRsvp(value)}>{label}</button>)}</div>}
      <ShareButton url={shareUrl} title={`${host ? 'My' : `${state.name}’s`} plan: ${plan.title}`} label="Share this plan"/>
    </div>
    {stops.length ? <ol className="timeline">{stops.map((e, i) => { const at = clock(e); return <li key={e.id}>
      <div className="tl-when">{at ? <><strong>{at[0]}</strong><small>{at[1]}</small></> : <span className="tl-num">{i + 1}</span>}</div>
      <CompactCard e={e} open={open.has(e.id)} onToggle={() => toggle(e.id)} renderArt={renderArt} planText={readOnly ? planLink(e, textNumbers) : ''}/>
      {legs[i] && <Leg leg={legs[i]}/>}
    </li>; })}</ol> : <p className="evening-empty">Nothing on the plan yet.</p>}
    {!readOnly && ideas.length > 0 && <>
      <h2 className="evening-heading">Ideas on the table</h2>
      {ideas.map(s => {
        const mine = s.votes.includes(meId), pickers = s.votes.map(nameOf).filter(Boolean);
        return <CompactCard key={s.id} e={s.e} badge={`${s.name}’s idea`} note={s.reason} open={open.has(`idea-${s.id}`)} onToggle={() => toggle(`idea-${s.id}`)} renderArt={renderArt} className={mine ? 'picked' : ''}
          footer={<>
            {host ? <button type="button" className="button secondary adopt" disabled={busy || !canPick} onClick={() => onAdopt(s)}><Plus size={15}/>Add to the plan</button>
              : <button type="button" className="my-pick" aria-pressed={mine} disabled={busy || !canPick} onClick={() => onVote(s.id)}><i>{mine && <Check size={14} strokeWidth={3}/>}</i>My pick</button>}
            <span className="picked-by">{pickers.length ? `Picked by ${pickers.join(', ')}` : 'No picks yet'}</span>
          </>}/>;
      })}
    </>}
    {readOnly ? cta
      : !closed && addStop && <a className="evening-cta" href={addStop}><strong><Plus size={16}/>Add a stop</strong><span>Coffee after? Dessert? Text Rall-e and the group can weigh in.</span></a>}
  </section>;
}

function Leg({ leg }) {
  const Icon = leg.mode === 'drive' ? Car : Footprints;
  const body = <><Icon size={14} aria-hidden="true"/><span>{leg.text}</span></>;
  return leg.maps ? <a className="tl-leg" href={leg.maps} target="_blank" rel="noopener noreferrer" aria-label={`Directions to the next stop: ${leg.text}`}>{body}</a> : <div className="tl-leg">{body}</div>;
}
