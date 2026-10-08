import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, UserCheck, Phone, Undo2, KeyRound, Copy, Plus } from 'lucide-react';

// Handoffs (/ops): things Rall-e couldn't finish that a person can (a table the link and the call couldn't get, a
// question only a phone call answers). Helpers take one, do it, and write what happened; Rall-e texts the member the
// result in its own voice. Helpers log in with their own key and see only this tab. The operator also manages helper
// accounts here; the viewer key can look but not act.
const KIND = { reservation: 'Reservation', call: 'Phone call', info: 'Find out', other: 'Other' };
const FILTERS = [['open', 'To do'], ['mine', 'Mine'], ['done', 'Finished'], ['all', 'All']];
const OPEN = ['open', 'claimed'];

export default function HandoffsTab({ call, ago, onOpenCount }) {
  const [data, setData] = useState(null), [filter, setFilter] = useState('open'), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [forms, setForms] = useState({}), [phones, setPhones] = useState({}), [helper, setHelper] = useState({ name: '', phone: '' }), [made, setMade] = useState(null), [copied, setCopied] = useState(false);
  const live = useRef(true);
  const load = () => call('handoffs').then(d => live.current && setData(d)).catch(e => live.current && setError(e.message));
  useEffect(() => { live.current = true; load(); const t = setInterval(load, 15000); return () => { live.current = false; clearInterval(t); }; }, []);
  const list = data?.handoffs || [], me = data?.me, operator = Boolean(data?.helpers);
  const openCount = list.filter(h => h.status === 'open').length;
  useEffect(() => { onOpenCount?.(openCount); }, [openCount]);
  const act = async (what, input) => { setBusy(what); setError(''); try { const d = await call('handoffs', input); setData(d); return d; } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const helperCall = async input => { setBusy('helpers'); setError(''); try { const d = await call('helpers', input); setData(x => ({ ...x, helpers: d.helpers })); if (d.made) { setMade(d.made); setCopied(false); } } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const form = id => forms[id] || { outcome: 'done', result: '', note: '' };
  const setForm = (id, patch) => setForms(f => ({ ...f, [id]: { ...form(id), ...patch } }));
  const mine = h => me && h.helper?.id === me.id;
  const shown = list.filter(h => filter === 'all' || (filter === 'open' ? OPEN.includes(h.status) : filter === 'mine' ? mine(h) : !OPEN.includes(h.status)));
  const copyKey = async () => { try { await navigator.clipboard.writeText(made.key); setCopied(true); } catch { setCopied(false); } };
  const state = h => h.status === 'open' ? `Waiting · ${ago(h.created)}` : h.status === 'claimed' ? `${mine(h) ? 'You’re' : `${h.helper?.name} is`} on it` : h.status === 'done' ? 'Done' : h.status === 'failed' ? 'Couldn’t do it' : 'Cancelled';

  return <section className="ops-usage ops-sources ho">
    <div className="ops-usage-head"><h2>Handoffs</h2><span>Things Rall-e couldn’t finish on its own. Take one, do it, and write what happened. Rall-e texts them the result.</span>
      <button className="ops-link" disabled={!!busy} onClick={() => { setBusy('load'); load().finally(() => setBusy('')); }}><RefreshCw size={14} className={busy === 'load' ? 'spin' : ''}/>Refresh</button></div>

    {operator && <details className="src-manual ho-helpers" open={!data.helpers.length}>
      <summary>Helpers ({data.helpers.filter(h => h.active).length} switched on)</summary>
      <p className="ho-hint">Rall-e only offers to hand things off while at least one helper is switched on. Each helper gets their own key, which opens only this page.</p>
      {data.helpers.length > 0 && <ul className="ho-helper-list">{data.helpers.map(h => <li key={h.id}>
        <strong>{h.name}</strong><small>{h.phone ? `Texts to ${h.phone}` : 'No phone'} · {h.lastSeen ? `seen ${ago(h.lastSeen)}` : 'hasn’t logged in yet'}{h.working ? ` · working on ${h.working}` : ''}</small>
        <button className={`button ${h.active ? 'secondary' : 'primary'}`} disabled={!!busy} onClick={() => helperCall({ id: h.id, active: !h.active })}>{h.active ? 'Switch off' : 'Switch on'}</button>
      </li>)}</ul>}
      <form className="src-add ho-add" onSubmit={e => { e.preventDefault(); helperCall({ add: helper }).then(() => setHelper({ name: '', phone: '' })); }}>
        <input id="ho-helper-name" value={helper.name} onChange={e => setHelper({ ...helper, name: e.target.value })} placeholder="Helper’s name" aria-label="Helper’s name" required/>
        <input id="ho-helper-phone" value={helper.phone} onChange={e => setHelper({ ...helper, phone: e.target.value })} placeholder="Phone for new-task texts (optional)" aria-label="Phone (optional)"/>
        <button className="button primary" disabled={!!busy}><Plus size={15}/>Add helper</button>
      </form>
      {made && <div className="ho-key" role="status"><KeyRound size={16}/><div><strong>Give {made.name} this key. It’s shown only once.</strong><code>{made.key}</code>
        <small>They open rall-e.ai/ops and paste it. Texts about new tasks only reach a phone that’s opted in to Rall-e.</small></div>
        <button className="button secondary" type="button" onClick={copyKey}><Copy size={14}/>{copied ? 'Copied' : 'Copy'}</button>
        <button className="ops-link" type="button" onClick={() => setMade(null)}>Done</button></div>}
    </details>}

    <div className="ideas-filter">{FILTERS.filter(([k]) => k !== 'mine' || me).map(([k, l]) =>
      <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}{k === 'open' && openCount ? ` (${openCount})` : ''}</button>)}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {!data ? <p className="ins-empty">Loading…</p> : !shown.length ? <p className="ins-empty">{filter === 'open' ? 'Nothing waiting. New handoffs show up here' + (me ? ', and helpers with a phone get a text.' : '.') : 'Nothing here.'}</p> :
      <div className="ho-list">{shown.map(h => <article key={h.id} className={`ho-card ${h.status}`}>
        <header><span className="src-status">{KIND[h.kind] || h.kind}</span><strong>{h.goal}</strong><em className={`ho-state ${h.status}`}>{state(h)}</em></header>
        <p className="ho-who">For {h.name || 'a member'} <small>{phones[h.id] || h.phone}</small> · handed off {ago(h.created)}</p>
        {h.details && <p className="ho-field"><b>Details</b>{h.details}</p>}
        {h.tried && <p className="ho-field"><b>Rall-e tried</b>{h.tried}</p>}
        {h.convo?.length > 0 && <details className="ho-convo"><summary>Their recent texts with Rall-e</summary>
          <div className="ops-messages">{h.convo.map((m, i) => <div key={i} className={`ops-msg ${m.from === 'them' ? 'in' : 'out'}`}><div className="bubble">{m.text}</div><small>{m.from === 'them' ? h.name || 'Them' : 'Rall-e'} · {ago(m.at)}</small></div>)}</div></details>}

        {h.status === 'open' && me && <div className="ho-actions">
          <button className="button primary" disabled={!!busy} onClick={() => act(h.id, { id: h.id, action: 'claim' })}><UserCheck size={15}/>Take it</button>
          {operator && <button className="ops-link" disabled={!!busy} onClick={() => act(h.id, { id: h.id, action: 'cancel' })}>Cancel it</button>}
        </div>}

        {h.status === 'claimed' && me && (mine(h) || operator) && <div className="ho-work">
          <div className="ho-actions">
            {!phones[h.id] && <button className="button secondary" disabled={!!busy} onClick={() => act(h.id, { id: h.id, action: 'reveal' }).then(d => d?.phone && setPhones(p => ({ ...p, [h.id]: d.phone })))}><Phone size={14}/>Show their number</button>}
            <button className="ops-link" disabled={!!busy} onClick={() => act(h.id, { id: h.id, action: 'release' })}><Undo2 size={14}/>Put it back</button>
            {operator && <button className="ops-link" disabled={!!busy} onClick={() => act(h.id, { id: h.id, action: 'cancel' })}>Cancel it</button>}
          </div>
          {phones[h.id] && <p className="ho-hint">Their number is for this booking only. Looking at it is noted on this task.</p>}
          <form className="ho-resolve" onSubmit={e => { e.preventDefault(); act(h.id, { id: h.id, action: 'resolve', ...form(h.id) }).then(d => d && setForms(f => ({ ...f, [h.id]: undefined }))); }}>
            <fieldset><legend>How did it go?</legend>
              <label><input type="radio" name={`outcome-${h.id}`} id={`ho-done-${h.id}`} checked={form(h.id).outcome === 'done'} onChange={() => setForm(h.id, { outcome: 'done' })}/>Done</label>
              <label><input type="radio" name={`outcome-${h.id}`} id={`ho-failed-${h.id}`} checked={form(h.id).outcome === 'failed'} onChange={() => setForm(h.id, { outcome: 'failed' })}/>Couldn’t do it</label>
            </fieldset>
            <label className="ho-label" htmlFor={`ho-result-${h.id}`}>What should Rall-e tell {h.name || 'them'}?</label>
            <textarea id={`ho-result-${h.id}`} rows={3} maxLength={600} required value={form(h.id).result} onChange={e => setForm(h.id, { result: e.target.value })}
              placeholder={form(h.id).outcome === 'done' ? 'e.g. Booked at Funke, Sat 7:30 PM for 4 under Jeff. Confirmation A12.' : 'e.g. Funke is full Saturday. They have 9:15 PM, or Sunday at 7.'}/>
            <label className="ho-label" htmlFor={`ho-note-${h.id}`}>Note for the team <small>(not sent)</small></label>
            <input id={`ho-note-${h.id}`} maxLength={600} value={form(h.id).note} onChange={e => setForm(h.id, { note: e.target.value })} placeholder="e.g. They only take 6+ online; call before 4 PM"/>
            <button className="button primary" disabled={!!busy || form(h.id).result.trim().length < 3}>Send the result to {h.name || 'them'}</button>
          </form>
        </div>}

        {!OPEN.includes(h.status) && <div className="ho-done">
          {h.result && <p className="ho-field"><b>Told them</b>{h.result}</p>}
          {h.told && <p className="ho-hint">{h.told}</p>}
          {h.note && <p className="ho-field"><b>Team note</b>{h.note}</p>}
        </div>}
        {h.log?.length > 1 && <details className="ho-log"><summary>History</summary><ul>{h.log.map((l, i) => <li key={i}>{l.who}: {l.what} · {ago(l.at)}</li>)}</ul></details>}
      </article>)}</div>}
  </section>;
}
