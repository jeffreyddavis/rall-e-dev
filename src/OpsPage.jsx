import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Send, Sparkles, Check, ArrowLeft, MessageSquareText, RefreshCw, Gauge, Users, ExternalLink, Trash2, BarChart3 } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import './ops.css';
import Insights from './Insights.jsx';

// Dashboard (/ops): live conversations and service usage. The operator key also gets controls to have Rall-e show off
// a feature, send a text or wipe a conversation; other keys see only the plain dashboard, with no sign that more exists.
const last4 = p => `••• ${p.slice(-4)}`;
const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const getKey = () => { try { return sessionStorage.getItem('rall-e-ops') || ''; } catch { return ''; } };

export default function OpsPage() {
  const [key, setKey] = useState(getKey), [draftKey, setDraftKey] = useState(''), [error, setError] = useState('');
  const [data, setData] = useState(null), [phone, setPhone] = useState(''), [thread, setThread] = useState(null);
  const [feature, setFeature] = useState(''), [note, setNote] = useState(''), [say, setSay] = useState(''), [showSay, setShowSay] = useState(false);
  const [busy, setBusy] = useState(false), [toast, setToast] = useState(''), end = useRef(null);
  const [wipe, setWipe] = useState(null), [wipeConfirm, setWipeConfirm] = useState('');
  const [insights, setInsights] = useState(null), [loadingInsights, setLoadingInsights] = useState(false);
  const [tab, setTab] = useState('people'), [usage, setUsage] = useState(null), [loadingUsage, setLoadingUsage] = useState(false);
  async function call(path, input) {
    const r = await fetch(`/api/ops/${path}`, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const d = await r.json(); if (r.status === 401 || r.status === 403 && /key|operator|password/i.test(d.error || '')) { setKey(''); try { sessionStorage.removeItem('rall-e-ops'); } catch {} }
    if (!r.ok) throw new Error(d.error); return d;
  }
  useEffect(() => { if (!key) return; let on = true; const tick = () => call('people').then(d => on && setData(d)).catch(e => on && setError(e.message)); tick(); const t = setInterval(tick, 5000); return () => { on = false; clearInterval(t); }; }, [key]);
  useEffect(() => { if (!key || !phone) return; let on = true; const tick = () => call(`thread?phone=${encodeURIComponent(phone)}`).then(d => on && setThread(d)).catch(e => on && setError(e.message)); tick(); const t = setInterval(tick, 2500); return () => { on = false; clearInterval(t); }; }, [key, phone]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [thread?.messages?.length]);
  const loadInsights = () => { setLoadingInsights(true); return call('insights').then(setInsights).catch(e => setError(e.message)).finally(() => setLoadingInsights(false)); };
  useEffect(() => { if (key && tab === 'insights') loadInsights(); }, [key, tab]);
  const loadUsage = () => { setLoadingUsage(true); return call('usage').then(setUsage).catch(e => setError(e.message)).finally(() => setLoadingUsage(false)); };
  // Usage: on open, then every 2 minutes (it calls provider APIs, so not too often). Also feeds the header alert.
  useEffect(() => { if (!key) return; loadUsage(); const t = setInterval(loadUsage, 120000); return () => clearInterval(t); }, [key]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [toast]);

  if (!key) return <main className="ops"><header className="ops-top"><Wordmark/><span>Dashboard</span></header>
    <form className="ops-card ops-login" onSubmit={e => { e.preventDefault(); try { sessionStorage.setItem('rall-e-ops', draftKey); } catch {} setKey(draftKey); setError(''); }}>
      <h1>Access key</h1><p>Enter the key you were given.</p>
      <input type="password" value={draftKey} onChange={e => setDraftKey(e.target.value)} autoFocus placeholder="Access key"/>
      <button className="button primary" disabled={draftKey.length < 24}>Open dashboard</button>{error && <p className="error">{error}</p>}
    </form></main>;

  const people = data?.people || [], person = people.find(p => p.phone === phone), seen = new Set((thread?.features || []).map(f => f.feature));
  const who = person?.name || (person ? last4(person.phone) : '');
  async function run(fn, done) { setBusy(true); setError(''); try { await fn(); setToast(done); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const nudge = () => run(async () => { await call('nudge', { phone, feature, note }); setFeature(''); setNote(''); }, `Rall-e is writing to ${who}…`);
  const sendExact = () => run(async () => { await call('say', { phone, text: say }); setSay(''); setShowSay(false); }, `Sent to ${who}.`);
  const chosen = data?.features?.find(f => f.id === feature);
  const viewer = data?.role !== 'operator'; // anything but the operator key sees the plain dashboard
  const alerts = (usage?.cards || []).filter(c => ['critical', 'warn'].includes(c.status));

  return <main className={`ops ${phone ? 'has-person' : ''}`}>
    <header className="ops-top"><Wordmark/><span>Dashboard</span>{data && !viewer && <b className={data.live ? 'live' : ''}>{data.live ? 'LIVE: texts really send' : 'Preview'}</b>}</header>
    <nav className="ops-tabs">
      <button className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}><Users size={15}/>Conversations</button>
      <button className={tab === 'insights' ? 'on' : ''} onClick={() => setTab('insights')}><BarChart3 size={15}/>Insights</button>
      <button className={tab === 'usage' ? 'on' : ''} onClick={() => setTab('usage')}><Gauge size={15}/>Usage{alerts.length ? <i className={alerts.some(c => c.status === 'critical') ? 'critical' : 'warn'}>{alerts.length}</i> : null}</button>
    </nav>
    {tab === 'people' && alerts.length > 0 && <button className={`ops-alert ${alerts.some(c => c.status === 'critical') ? 'critical' : 'warn'}`} onClick={() => setTab('usage')}>⚠ {alerts.map(c => c.name.split(' (')[0]).join(', ')} {alerts.length === 1 ? 'needs' : 'need'} attention before a demo</button>}
    {error && <p className="error ops-error" role="alert">{error}</p>}
    {tab === 'insights' && <Insights data={insights} loading={loadingInsights} onRefresh={loadInsights} ago={ago} onSaveGap={async (category, d) => { await call('gap', { category, ...d }); await loadInsights(); }}/>}
    {tab === 'usage' && <section className="ops-usage">
      <div className="ops-usage-head"><h2>Service usage</h2><span>{usage ? `Checked ${ago(usage.at)}` : ''}</span><button className="ops-link" disabled={loadingUsage} onClick={loadUsage}><RefreshCw size={14} className={loadingUsage ? 'spin' : ''}/>Refresh</button></div>
      {!usage && <LoaderCircle className="spin"/>}
      <div className="ops-usage-grid">{(usage?.cards || []).map(c => <article key={c.id} className={`ops-usage-card ${c.status}`}>
        <header><strong>{c.name}</strong><em>{({ ok: 'OK', warn: 'Getting close', critical: 'Upgrade now', unknown: 'Can’t check', off: 'Not connected' })[c.status]}</em></header>
        {c.meter && <div className="ops-meter"><div style={{ width: `${Math.min(100, c.meter.limit ? c.meter.used / c.meter.limit * 100 : 0)}%` }}/></div>}
        {c.meter && <p className="ops-meter-text">{c.meter.used.toLocaleString()} of {c.meter.limit.toLocaleString()} {c.meter.unit}</p>}
        <ul>{c.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
        {c.link && <a href={c.link} target="_blank" rel="noreferrer"><ExternalLink size={13}/>Manage / upgrade</a>}
      </article>)}</div>
    </section>}
    {tab === 'people' && <div className="ops-grid">
      <section className="ops-people">
        <h2>People <small>{people.length}</small></h2>
        {!data && <LoaderCircle className="spin"/>}
        {people.map(p => <button key={p.phone} className={`ops-person ${p.phone === phone ? 'on' : ''}`} onClick={() => { setPhone(p.phone); setThread(null); setFeature(''); }}>
          <span className="ops-avatar">{(p.name || '?').slice(0, 1)}</span>
          <span className="ops-person-text">
            <strong>{p.name || 'No name yet'} <small>{last4(p.phone)}</small>{p.channel && <i className={p.channel === 'iMessage' ? 'blue' : ''}>{p.channel === 'iMessage' ? 'iMessage' : 'SMS'}</i>}{!p.tester && <i>joined</i>}{p.stopped && <i className="stop">STOP</i>}</strong>
            <span>{p.plans[0] ? `${p.plans[0].role === 'host' ? 'Hosting' : `In ${p.plans[0].host}’s`} ${p.plans[0].title}` : 'No plan yet'}{p.location ? ` · ${p.location}` : ''}</span>
            {p.busy ? <em>Rall-e is typing…</em> : p.last && <em>{p.last.from === 'them' ? '' : 'Rall-e: '}{p.last.text} · {ago(p.last.at)}</em>}
          </span></button>)}
      </section>
      {phone && <section className="ops-chat">
        <header><button className="ops-back" onClick={() => setPhone('')} aria-label="Back to people"><ArrowLeft size={18}/></button><strong>{who}</strong><small>{last4(phone)}{person?.channel ? ` · ${person.channel}` : ''}</small>{thread?.busy && <em><RefreshCw size={13} className="spin"/> typing…</em>}{!viewer && <button className="ops-wipe-btn" onClick={() => { setWipe(wipe ? null : 'texts'); setWipeConfirm(''); }}><Trash2 size={15}/>Wipe…</button>}</header>
        {wipe && !viewer && <div className="ops-wipe">
          <label><input type="radio" checked={wipe === 'texts'} onChange={() => setWipe('texts')}/><span><strong>Wipe their texts</strong><small>Deletes their conversation with Rall-e and their group messages. They stay on their plans and can keep texting.</small></span></label>
          <label><input type="radio" checked={wipe === 'person'} onChange={() => setWipe('person')}/><span><strong>Remove {who} completely</strong><small>Also takes them off every plan, deletes plans they host, their vault, location and sign-up.{person?.tester ? ' They’re a core tester, so Rall-e can still text them.' : ' Rall-e won’t text them again unless they sign up again.'}</small></span></label>
          <p>This is permanent. Type the last 4 digits of their number ({phone.slice(-4)}) to confirm.</p>
          <div className="ops-say"><input value={wipeConfirm} onChange={e => setWipeConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" placeholder="Last 4 digits"/><button className="button danger" disabled={busy || wipeConfirm !== phone.slice(-4)} onClick={() => run(async () => { await call('wipe', { phone, mode: wipe, confirm: wipeConfirm }); setWipe(null); setWipeConfirm(''); if (wipe === 'person' && !person?.tester) setPhone(''); }, wipe === 'person' ? `Removed ${who}.` : `Wiped ${who}’s texts.`)}><Trash2 size={15}/>{wipe === 'person' ? 'Remove' : 'Wipe texts'}</button></div>
        </div>}
        <div className="ops-messages">
          {(thread?.messages || []).map((m, i) => <div key={i} className={`ops-msg ${m.direction === 'in' ? 'in' : 'out'} ${m.kind}`}>
            <div className="bubble">{m.body}</div>
            <small>{m.direction === 'out' && m.kind !== 'reply' ? `${m.kind} · ` : ''}{ago(m.created)}{m.status === 'blocked' || m.status === 'failed' ? ` · ${m.status}${m.error ? ` (${m.error})` : ''}` : ''}</small>
          </div>)}
          <div ref={end}/>
        </div>
        {viewer ? null : <div className="ops-controls">
          <h3><Sparkles size={15}/>Have Rall-e show {who} a feature</h3>
          <div className="ops-features">{(data?.features || []).map(f => <button key={f.id} className={`${feature === f.id ? 'on' : ''} ${seen.has(f.id) ? 'seen' : ''}`} onClick={() => setFeature(feature === f.id ? '' : f.id)} title={f.pitch}>
            {seen.has(f.id) && <Check size={13}/>}{f.label}</button>)}</div>
          {chosen && <p className="ops-pitch">Rall-e will naturally show {who} {chosen.pitch}.{seen.has(chosen.id) ? ' They’ve seen this one already.' : ''}</p>}
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={600} placeholder={feature ? 'Optional context, e.g. “they mentioned date night Friday”' : 'Or tell Rall-e what to do, e.g. “ask if they want to add dessert after dinner”'}/>
          <button className="button primary ops-go" disabled={busy || thread?.busy || (!feature && !note.trim())} onClick={nudge}>{busy ? <LoaderCircle size={16} className="spin"/> : <Sparkles size={16}/>}Have Rall-e text {who}</button>
          <button className="ops-link" onClick={() => setShowSay(!showSay)}><MessageSquareText size={14}/>{showSay ? 'Hide' : 'Send an exact text as Rall-e'}</button>
          {showSay && <div className="ops-say"><textarea value={say} onChange={e => setSay(e.target.value)} rows={2} maxLength={1000} placeholder="Exactly what Rall-e should send"/><button className="button secondary" disabled={busy || !say.trim()} onClick={sendExact}><Send size={15}/>Send</button></div>}
        </div>}
      </section>}
    </div>}
    {toast && <div className="ops-toast" role="status">{toast}</div>}
  </main>;
}
