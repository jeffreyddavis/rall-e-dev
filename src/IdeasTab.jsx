import React, { useEffect, useState } from 'react';
import { RefreshCw, ExternalLink, Plus } from 'lucide-react';

// Ideas inbox (both keys): tips members text Rall-e (hidden gems, event websites, feedback, feature ideas) plus the
// team's own. This is the team's task list. Approving a gem puts it on the map for the agent; approving a site adds it
// as a source. Nothing members send changes Rall-e until it's approved here.
const KIND = { gem: 'Hidden gem', source: 'Event website', feedback: 'Feedback', feature: 'Feature idea' };
const STATUS = { new: 'New', approved: 'Approved', doing: 'In progress', done: 'Done', declined: 'Declined' };

export default function IdeasTab({ call, ago }) {
  const [ideas, setIdeas] = useState(null), [filter, setFilter] = useState('open'), [busy, setBusy] = useState(''), [error, setError] = useState(''), [msg, setMsg] = useState('');
  const [add, setAdd] = useState({ kind: 'feature', title: '', note: '', city: '', url: '' });
  const run = async (what, fn) => { setBusy(what); setError(''); setMsg(''); try { const d = await fn(); setIdeas(d.ideas); if (d.result) setMsg(d.result); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  useEffect(() => { run('load', () => call('ideas')); }, []);
  const shown = (ideas || []).filter(i => filter === 'all' || (filter === 'open' ? ['new', 'approved', 'doing'].includes(i.status) : i.kind === filter));
  return <section className="ops-usage ops-sources">
    <div className="ops-usage-head"><h2>Ideas</h2><span>Tips and feedback members text Rall-e, plus the team’s ideas. Nothing changes Rall-e until it’s approved here.</span>
      <button className="ops-link" disabled={!!busy} onClick={() => run('load', () => call('ideas'))}><RefreshCw size={14} className={busy === 'load' ? 'spin' : ''}/>Refresh</button></div>
    <div className="ideas-filter">{[['open', 'Open'], ['gem', 'Gems'], ['source', 'Websites'], ['feedback', 'Feedback'], ['feature', 'Features'], ['all', 'All']].map(([k, l]) =>
      <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div>
    {error && <p className="error" role="alert">{error}</p>}{msg && <p className="ins-empty">{msg}</p>}
    <details className="src-manual"><summary>Add an idea for the team</summary>
      <form className="src-add" onSubmit={e => { e.preventDefault(); run('add', () => call('ideas', { add })).then(() => setAdd({ ...add, title: '', note: '', url: '' })); }}>
        <select value={add.kind} onChange={e => setAdd({ ...add, kind: e.target.value })} aria-label="Kind">{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input value={add.title} onChange={e => setAdd({ ...add, title: e.target.value })} placeholder="One-line summary" aria-label="Summary" required/>
        <input value={add.city} onChange={e => setAdd({ ...add, city: e.target.value })} placeholder="City (gems and websites)" aria-label="City"/>
        <input value={add.url} onChange={e => setAdd({ ...add, url: e.target.value })} placeholder="Link (optional)" aria-label="Link"/>
        <input value={add.note} onChange={e => setAdd({ ...add, note: e.target.value })} placeholder="Details (optional)" aria-label="Details"/>
        <button className="button primary" disabled={!!busy}><Plus size={15}/>Add</button>
      </form></details>
    {!ideas ? <p className="ins-empty">Loading…</p> : !shown.length ? <p className="ins-empty">Nothing here yet. Members can text Rall-e things like “a hidden gem in Austin: …” or “feedback: …”.</p> :
      <table className="src-table"><thead><tr><th>What</th><th>Idea</th><th>From</th><th>Status</th><th>Team note</th></tr></thead><tbody>{shown.map(i => <tr key={i.id}>
        <td><span className="src-status">{KIND[i.kind]}</span></td>
        <td><strong>{i.title}</strong>{i.city && <small> · {i.city}</small>}{i.url && <a href={i.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={12}/>link</a>}{i.note && <small className="idea-note">{i.note}</small>}</td>
        <td>{i.from}<small className="idea-note">{ago(i.created)}</small></td>
        <td><select value={i.status} disabled={!!busy} onChange={e => run(i.id, () => call('ideas', { id: i.id, status: e.target.value }))} aria-label="Status">{Object.entries(STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
        <td><input defaultValue={i.teamNote || ''} placeholder="Add a note" aria-label="Team note" onBlur={e => e.target.value !== (i.teamNote || '') && run(i.id, () => call('ideas', { id: i.id, teamNote: e.target.value }))}/></td>
      </tr>)}</tbody></table>}
  </section>;
}
