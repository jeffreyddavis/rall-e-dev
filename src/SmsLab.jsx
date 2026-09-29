import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Plus, RotateCcw, LoaderCircle, MessageCircle, X } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import './lab.css';

// Presenter-only text simulator. Every phone here is a fictional 555 number; replies are real app
// behaviour. In preview mode nothing is sent. In live mode, texts to approved testers really go out.
const DEFAULT_PHONES = [
  { phone: '+13105550101', label: 'You (host)' },
  { phone: '+13105550102', label: 'Mike' },
  { phone: '+13105550103', label: 'Dave' },
  { phone: '+13105550104', label: 'Sarah' }
];
const HOST_CHIPS = ['Hi', 'YES', '4', 'Mike 310-555-0102, Dave 310-555-0103, Sarah 310-555-0104', 'STATUS', 'PICK 1', 'CONFIRM'];
const GUEST_CHIPS = ['YES', 'MAYBE', 'NO', 'How about dinner instead?', 'VOTE 1', 'What time?', 'STATUS'];
const pretty = phone => phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
const load = () => { try { return JSON.parse(localStorage.getItem('rally-lab-phones')) || DEFAULT_PHONES; } catch { return DEFAULT_PHONES; } };

export default function SmsLab() {
  const [password, setPassword] = useState(''), [open, setOpen] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [phones, setPhones] = useState(load), [data, setData] = useState({ messages: [], threads: {}, mode: 'preview' });
  const [adding, setAdding] = useState(false), [newPhone, setNewPhone] = useState(''), [newLabel, setNewLabel] = useState('');
  async function call(path, input) {
    const response = await fetch(`/api/sms-lab/${path}`, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  const refresh = () => call(`transcript?phones=${encodeURIComponent(phones.map(p => p.phone).join(','))}`).then(setData);
  useEffect(() => { try { localStorage.setItem('rally-lab-phones', JSON.stringify(phones)); } catch {} }, [phones]);
  useEffect(() => {
    if (!open) return; let active = true;
    const tick = () => refresh().catch(e => active && setError(e.message));
    tick(); const timer = setInterval(tick, 2000); return () => { active = false; clearInterval(timer); };
  }, [open, phones.map(p => p.phone).join()]);
  async function unlock(e) { e.preventDefault(); setBusy('unlock'); setError(''); try { await refresh(); setOpen(true); } catch (err) { setError(err.message); } finally { setBusy(''); } }
  async function text(phone, body) { setBusy(phone); setError(''); try { await call('text', { from: phone, body }); await refresh(); } catch (err) { setError(err.message); } finally { setBusy(''); } }
  async function clear() { setBusy('clear'); setError(''); try { await call('clear', { phones: phones.map(p => p.phone) }); await refresh(); } catch (err) { setError(err.message); } finally { setBusy(''); } }
  function add(e) {
    e.preventDefault(); const digits = newPhone.replace(/\D/g, ''), phone = digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : '';
    if (!/^\+1\d{3}555\d{4}$/.test(phone)) return setError('Lab phones must be fictional 555 numbers, such as 310-555-0105.');
    if (phones.some(p => p.phone === phone)) return setError('That phone is already in the lab.');
    setPhones([...phones, { phone, label: newLabel.trim() || pretty(phone) }].slice(0, 8)); setNewPhone(''); setNewLabel(''); setAdding(false); setError('');
  }

  if (!open) return <main className="lab lab-gate"><Wordmark/><span className="eyebrow">PRESENTER TEXT LAB</span><h1>Make a plan entirely by text.</h1>
    <p>Play the host and each friend from one screen. Replies come from the real Rall-e texting engine, and every plan change reaches the whole group.</p>
    <form onSubmit={unlock}><label htmlFor="lab-password">SMS presenter password</label><input id="lab-password" type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} required/>
      <button className="button primary full" disabled={busy === 'unlock'}>{busy === 'unlock' ? <LoaderCircle className="spin" size={16}/> : null}Open the text lab</button></form>
    {error && <p className="error" role="alert">{error}</p>}</main>;

  return <main className="lab">
    <header className="lab-header">
      <div><Wordmark/><span className="eyebrow">TEXT LAB</span></div>
      <span className={`lab-mode ${data.mode}`}>{data.mode === 'live' ? 'LIVE · texts to approved testers are sent' : 'PREVIEW · nothing is sent'}</span>
      <div className="lab-actions">
        <button className="button secondary" onClick={() => setAdding(!adding)}><Plus size={15}/>Add a phone</button>
        <button className="button secondary" disabled={busy === 'clear'} onClick={clear}><RotateCcw size={15}/>Clear these phones</button>
      </div>
    </header>
    {adding && <form className="lab-add" onSubmit={add}><label>Name<input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Priya" maxLength={20}/></label><label>555 number<input value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="310-555-0105" required/></label><button className="button primary">Add</button></form>}
    {error && <p className="error lab-error" role="alert">{error}</p>}
    <p className="lab-hint">Start with the host: text <b>Hi</b>, then follow the prompts. Invite the other lab phones by number (e.g. “Mike 310-555-0102”). Friends can reply YES/MAYBE/NO, suggest (“how about dinner instead?”), VOTE 1, ask “what time?”, or just chat — Rall-e passes it to the group.</p>
    <section className="lab-phones">
      {phones.map(p => <Phone key={p.phone} {...p} busy={busy === p.phone} messages={data.messages.filter(m => m.phone === p.phone)} threads={data.threads[p.phone] || []}
        onSend={body => text(p.phone, body)} onRemove={phones.length > 1 ? () => setPhones(phones.filter(x => x.phone !== p.phone)) : null}/>)}
    </section>
  </main>;
}

function Phone({ phone, label, messages, threads, busy, onSend, onRemove }) {
  const [value, setValue] = useState(''), end = useRef(null);
  const current = threads[0], chips = current?.role === 'guest' ? GUEST_CHIPS : HOST_CHIPS;
  useEffect(() => { end.current?.parentElement?.scrollTo({ top: 1e6 }); }, [messages.length]);
  function submit(e) { e.preventDefault(); if (!value.trim() || busy) return; onSend(value.trim()); setValue(''); }
  return <article className="lab-phone" aria-label={`${label}'s phone`}>
    <header><div><strong>{label}</strong><span>{pretty(phone)}</span></div>{onRemove && <button className="icon-button" aria-label={`Remove ${label}`} onClick={onRemove}><X size={15}/></button>}</header>
    <div className="lab-thread-chip">{current ? <>{current.role === 'host' ? 'Hosting' : `Invited by ${current.host}`} · {current.title}{threads.length > 1 ? ` · +${threads.length - 1} more` : ''}</> : 'Not on a plan yet'}</div>
    <div className="lab-messages" aria-live="polite">
      {!messages.length && <p className="lab-empty"><MessageCircle size={18}/>No texts yet.</p>}
      {messages.map(m => <div key={m.id} className={`lab-bubble ${m.direction}`}><p>{m.body}</p>{m.direction === 'out' && m.status !== 'preview' && <small className={`lab-status ${m.status}`}>{m.status}{m.error ? ` · ${m.error}` : ''}</small>}</div>)}
      <span ref={end}/>
    </div>
    <div className="lab-chips">{chips.map(c => <button key={c} type="button" disabled={busy} onClick={() => onSend(c)}>{c.length > 22 ? `${c.slice(0, 20)}…` : c}</button>)}</div>
    <form onSubmit={submit}><input aria-label={`Text as ${label}`} placeholder="Text message" value={value} onChange={e => setValue(e.target.value)} maxLength={640}/><button className="send" aria-label="Send" disabled={busy || !value.trim()}>{busy ? <LoaderCircle className="spin" size={16}/> : <ArrowUp size={16}/>}</button></form>
  </article>;
}
