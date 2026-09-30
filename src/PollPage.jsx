import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CalendarDays, MapPin, DollarSign, GripVertical, LoaderCircle, ChevronRight } from 'lucide-react';
import { Wordmark, RallyIcon, DesignPhoto } from './Design.jsx';
import './poll.css';

// Group poll (/q/<token>), from Donovan's design: Pick one (radio), Rank these (drag), or Your call (leave it to the host).
// Collapsed cards keep it quick; expanding one shows the details and where each friend stands.
async function api(token, data) {
  const r = await fetch(`/api/poll/${token}`, data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {});
  const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
}
export default function PollPage({ token, renderArt }) {
  const [v, setV] = useState(null), [error, setError] = useState(''), [mode, setMode] = useState('pick'), [pick, setPick] = useState(''), [order, setOrder] = useState([]);
  const [open, setOpen] = useState(() => new Set()), [busy, setBusy] = useState(false), [done, setDone] = useState('');
  useEffect(() => { api(token).then(d => { setV(d); setOrder(d.mine?.ranking || d.options.map(o => o.id)); if (d.mine && d.mine.mode !== 'defer') { setMode(d.mine.mode); setPick(d.mine.pick || ''); } }).catch(e => setError(e.message)); }, [token]);
  if (!v) return <main className="poll-page"><header className="poll-head"><Wordmark/></header>{error ? <p className="error" role="alert">{error}</p> : <LoaderCircle className="spin"/>}</main>;
  if (done) return <main className="poll-done"><div className="poll-done-check"><Check size={72} strokeWidth={2.4}/></div><h1>{done}</h1>{v.mine?.mode === 'defer' && <p className="poll-done-quote">“Your call”</p>}
    <button className="text-link poll-again" onClick={() => setDone('')}>Change my answer</button>
    {!v.isHost && <a className="poll-signup" href="/"><span className="poll-signup-icon"><RallyIcon/></span><span><strong>Want Rall-e for your own plans?</strong><small>It’s invite-only for now. Ask {v.asker} for an invite, or join the waitlist.</small></span><ChevronRight size={22}/></a>}</main>;
  const byId = Object.fromEntries(v.options.map(o => [o.id, o])), list = mode === 'rank' ? order.map(id => byId[id]).filter(Boolean) : v.options;
  const toggle = id => setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const leader = v.tally?.order?.[0], hostCall = v.isHost ? 'Your call' : `${v.asker}’s call`;
  const status = (p, id) => !p.answer ? 'Waiting' : p.answer.mode === 'defer' ? hostCall : p.answer.mode === 'rank' ? `Ranked #${(p.answer.rank || []).indexOf(id) + 1}` : p.answer.pick === id ? 'Yes' : 'No';
  async function submit(as = mode) {
    setBusy(true); setError('');
    try { const d = await api(token, { mode: as, pick, ranking: order }); setV(d); setDone(as === 'rank' ? 'Your rankings have been saved!' : 'Your vote has been cast!'); window.scrollTo(0, 0); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  // "Your call" is an answer in itself (Donovan): tapping it casts the vote right away. Pick one stays the default.
  const choose = m => { if (m === 'defer') { if (!v.closed && !busy) submit('defer'); return; } setMode(m); };
  const move = (id, by) => setOrder(o => { const i = o.indexOf(id), j = Math.max(0, Math.min(o.length - 1, i + by)); if (i === j) return o; const n = o.slice(); n.splice(i, 1); n.splice(j, 0, id); return n; });
  const modes = [['pick', 'Pick one'], ['rank', 'Rank these'], ...(v.isHost ? [] : [['defer', 'Your call']])];
  return <main className="poll-page">
    <header className="poll-head"><a href="/" aria-label="Rall-e home"><Wordmark/></a><span className="poll-count">{v.answered} of {v.total} answered</span></header>
    <h1>{v.title}</h1>
    <p className="poll-lede">{v.isHost ? 'You asked Rall-e for options. Vote too, and see where everyone stands.' : `${v.asker} asked Rall-e for options. Pick your favorites.`}</p>
    {v.closed && <p className="poll-closed">This plan has been decided. You can still look around.</p>}
    <div className="poll-modes" role="tablist" aria-label="How you want to answer">{modes.map(([m, label]) => <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => choose(m)}>{label}</button>)}</div>
    {mode === 'rank' && <p className="poll-hint"><span>Drag to rank</span></p>}
    <ol className={`poll-list mode-${mode}`}>{list.map((o, i) => <PollCard key={o.id} o={o} i={i} mode={mode} picked={pick === o.id} open={open.has(o.id)} onToggle={() => toggle(o.id)} onPick={() => setPick(o.id)}
      onMove={by => move(o.id, by)} people={v.people} status={status} renderArt={renderArt} lead={v.isHost && leader === o.id && v.answered > 0} picks={v.tally?.picks?.[o.id]}/>)}</ol>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="poll-submit"><button className="button primary" disabled={busy || v.closed || (mode === 'pick' && !pick)} onClick={() => submit()}>{busy ? 'Saving…' : 'Submit'}</button></div>
  </main>;
}
function PollCard({ o, i, mode, picked, open, onToggle, onPick, onMove, people, status, renderArt, lead, picks }) {
  const drag = useRef(null), card = useRef(null), [lift, setLift] = useState(null);
  // Drag to rank: the card lifts and follows your finger; it swaps places each time it passes a neighbor, and the
  // numbers update as you go.
  const down = e => { e.preventDefault(); drag.current = { y: e.clientY, step: (card.current?.offsetHeight || 74) + 12 }; setLift(0); e.currentTarget.setPointerCapture(e.pointerId); };
  const moveDrag = e => {
    if (!drag.current) return; let dy = e.clientY - drag.current.y; const step = drag.current.step;
    if (Math.abs(dy) > step * 0.55) { onMove(dy > 0 ? 1 : -1); drag.current.y += dy > 0 ? step : -step; dy = e.clientY - drag.current.y; }
    setLift(dy);
  };
  const up = () => { drag.current = null; setLift(null); };
  const [day, time] = (o.time || '').split('·').map(x => x.trim());
  const art = o.image ? <img src={o.image} alt="" loading="lazy"/> : ['comedy', 'dinner', 'rooftop'].includes(o.color) ? <DesignPhoto kind={o.color}/> : renderArt?.(o.color);
  const [more, setMore] = useState(false);
  return <li ref={card} className={`poll-card ${open ? 'open' : ''} ${picked && mode === 'pick' ? 'picked' : ''} ${lift != null ? 'dragging' : ''}`} style={lift != null ? { transform: `translateY(${lift}px) scale(1.03)` } : undefined}>
    <div className="poll-row">
      {mode === 'pick' ? <button className="poll-radio" role="radio" aria-checked={picked} aria-label={`Pick ${o.short}`} onClick={onPick}>{picked && <Check size={15} strokeWidth={3.2}/>}</button>
        : mode === 'rank' ? <span className="poll-rank" aria-hidden="true">{i + 1}</span> : null}
      <button className="poll-name" onClick={mode === 'pick' ? onPick : onToggle}><strong>{o.short}</strong><span>{[o.kind, o.priceText && o.priceText !== 'See listing' ? o.priceText : null, o.miles != null ? `${o.miles}mi` : null].filter(Boolean).join(' • ')}{lead ? ' • Leading' : ''}{picks ? ` • ${picks} pick${picks > 1 ? 's' : ''}` : ''}</span></button>
      {mode === 'rank' && <button className="poll-grip" aria-label={`Move ${o.short} (use arrow keys)`} onPointerDown={down} onPointerMove={moveDrag} onPointerUp={up} onPointerCancel={up}
        onKeyDown={e => { if (e.key === 'ArrowUp') { e.preventDefault(); onMove(-1); } if (e.key === 'ArrowDown') { e.preventDefault(); onMove(1); } }}><GripVertical size={20}/></button>}
      <button className="poll-chevron" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} details for ${o.short}`} onClick={onToggle}><ChevronDown size={22}/></button>
    </div>
    {open && <div className="poll-detail">
      {art && <div className="poll-art">{art}</div>}
      <div className="poll-body">
        <h2><strong>{o.short}{o.description ? ':' : ''}</strong>{o.description ? ` ${o.description.split(/(?<=[.!?])\s/)[0].replace(/[.!]$/, '')}` : ''}</h2>
        {day && <div className="poll-fact"><CalendarDays size={20}/><div><strong>{day}</strong>{time && <span>{time}</span>}</div></div>}
        <div className="poll-fact"><MapPin size={20}/><div><strong>{o.venue}</strong>{(o.address || o.area) && <span>{o.address || o.area}</span>}</div></div>
        {o.priceText && o.priceText !== 'See listing' && <div className="poll-fact"><DollarSign size={20}/><div><strong>{o.priceText}</strong></div></div>}
        <h3>Invited</h3>
        <ul className="poll-people">{people.map(p => <li key={p.id}><span className={`avatar ${p.photo ? 'has-photo' : ''}`}>{p.photo ? <img src={p.photo} alt=""/> : p.name.slice(0, 1)}</span><small>{p.you ? 'You' : p.name}</small><em>{status(p, o.id)}</em></li>)}</ul>
        {o.description && <><h3>Overview</h3><p className={`poll-overview ${more ? 'more' : ''}`}>{o.description}</p>{o.description.length > 110 && !more && <button className="text-link" onClick={() => setMore(true)}>more</button>}</>}
        {o.url && <a className="poll-link" href={o.url} target="_blank" rel="noopener noreferrer">See the listing</a>}
      </div></div>}
  </li>;
}
