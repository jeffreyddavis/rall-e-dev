import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Check } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import OptionCard, { ShareButton, planLink } from './OptionCard.jsx';
import JoinCard from './JoinCard.jsx';

// Public page behind the picture cards Rall-e texts.
//  /e/<id>?s=<set>  the recipient's list of every option from that text, each with "My pick" (tells Rall-e in their thread)
//  /e/<id>?o=<share> a shared, view-only copy of that list; /e/<id> a single outing.
export default function EventPage({ id, renderArt }) {
  const q = new URLSearchParams(location.search), set = q.get('s') || '', shared = q.get('o') || '';
  const [data, setData] = useState(null), [error, setError] = useState(''), [open, setOpen] = useState(() => new Set([id]));
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), refs = useRef({});
  useEffect(() => {
    const load = async url => { const r = await fetch(url), d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d; };
    const single = () => load(`/api/event/${id}`).then(d => ({ events: [d.event], textNumbers: d.textNumbers, single: true, shareUrl: `${location.origin}/e/${id}` }));
    (set ? load(`/api/options/${set}`) : shared ? load(`/api/options/public/${shared}`).then(d => ({ ...d, shareUrl: location.href })) : single())
      .catch(e => e.status === 410 ? single() : Promise.reject(e)).then(setData).catch(e => setError(e.message));
  }, [id, set, shared]);
  useEffect(() => { if (data && !data.single && data.events.length > 1) refs.current[id]?.scrollIntoView({ block: 'start' }); }, [data, id]);
  async function pick(eventId) {
    setBusy(true); setNotice('');
    try {
      const r = await fetch(`/api/options/${set}/pick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventId }) }), d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setData(x => ({ ...x, pick: d.pick })); setNotice(`Got it! I’ll text you about ${data.events.find(e => e.id === eventId).short}.`);
    } catch (e) { setNotice(e.message); } finally { setBusy(false); }
  }
  if (!data) return <main className="event-page"><header><a href="/"><Wordmark/></a></header>{error ? <p className="error">{error}</p> : <LoaderCircle className="spin"/>}</main>;
  const toggle = eid => setOpen(s => { const n = new Set(s); n.has(eid) ? n.delete(eid) : n.add(eid); return n; });
  const owner = Boolean(set) && !data.single && !data.shared;
  const title = data.single ? data.events[0].short : `${data.events.length} ideas from Rall-e: ${data.events.map(e => e.short).join(', ')}`;
  return <main className="event-page">
    <header><a href="/" aria-label="Rall-e home"><Wordmark/></a>{!data.single && <span className="source">{data.events.length} options</span>}</header>
    {data.events.map(e => <OptionCard key={e.id} e={e} open={open.has(e.id)} onToggle={() => toggle(e.id)} renderArt={renderArt} className={data.pick === e.id ? 'picked' : ''}
      planText={owner ? '' : planLink(e, data.textNumbers)} cardRef={el => { refs.current[e.id] = el; }}
      footer={owner && <button type="button" className="my-pick" aria-pressed={data.pick === e.id} disabled={busy} onClick={() => pick(e.id)}><i>{data.pick === e.id && <Check size={14} strokeWidth={3}/>}</i>My pick</button>}/>)}
    <div className="event-share"><ShareButton url={data.shareUrl} title={title} label={data.single ? 'Share this spot' : 'Share these ideas'}/></div>
    {data.shared && <div className="event-share"><JoinCard source={shared} textNumbers={data.textNumbers} heading="Plan something with Rall-e"/></div>}
    {notice && <p className="pick-notice" role="status">{notice}</p>}
  </main>;
}
