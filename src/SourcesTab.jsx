import React, { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, ExternalLink, Wand2 } from 'lucide-react';
import { SOURCE_NOTES } from './sourceNotes.js';

// Both dashboard keys: curated event sources per city (calendar feeds and event pages). See docs/DATA_SOURCES.md.
// A source showing 0 or 1 events gets a debugging run (server/sourcedebug.mjs) that saves a rule for reading it.
export default function SourcesTab({ call, ago }) {
  const [manual, setManual] = useState([]), [ev, setEv] = useState({ title: '', date: '', time: '', venue: '', city: '', price: '', url: '' }),
    [sources, setSources] = useState(null), [url, setUrl] = useState(''), [city, setCity] = useState(''), [name, setName] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const run = async (what, fn) => { setBusy(what); setError(''); try { const d = await fn(); setSources(d.sources); setManual(d.manual || []); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  useEffect(() => { run('load', () => call('sources')); }, []);
  return <section className="ops-usage ops-sources">
    <div className="ops-usage-head"><h2>Event sources</h2><span>Calendar feeds and event pages Rall-e checks every 12 hours</span></div>
    <form className="src-add" onSubmit={e => { e.preventDefault(); run('add', () => call('sources', { url, city, name })).then(() => { setUrl(''); setName(''); }); }}>
      <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Link to a calendar feed (.ics) or an events page" aria-label="Source link" required/>
      <input value={city} onChange={e => setCity(e.target.value)} placeholder="City, e.g. Los Angeles, CA" aria-label="City" required/>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name"/>
      <button className="button primary" disabled={!!busy}><Plus size={15}/>{busy === 'add' ? 'Reading it…' : 'Add source'}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <details className="src-manual src-notes"><summary>How we pick sources ({SOURCE_NOTES.decisions.length} decisions, updated {SOURCE_NOTES.updated})</summary>
      <dl>{SOURCE_NOTES.how.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}</dl>
      <table className="src-table"><thead><tr><th>Status</th><th>Source or idea</th><th>Why / next step</th><th>From</th></tr></thead><tbody>
        {SOURCE_NOTES.decisions.map(([status, what, why, from]) => <tr key={what}><td><span className={`src-status ${status.split(' ')[0].toLowerCase()}`}>{status}</span></td><td><strong>{what}</strong></td><td>{why}</td><td>{from}</td></tr>)}
      </tbody></table>
    </details>
    <details className="src-manual"><summary>Add a one-off event by hand ({manual.length} upcoming)</summary>
      <p className="ins-empty">For things with no feed: supper clubs, pop-ups, night markets, a friend’s gallery opening. They show up in searches near that city.</p>
      <form className="src-add" onSubmit={e => { e.preventDefault(); run('event', () => call('sources/event', ev)).then(() => setEv({ ...ev, title: '', time: '', venue: '', price: '', url: '' })); }}>
        <input value={ev.title} onChange={e => setEv({ ...ev, title: e.target.value })} placeholder="Event name" aria-label="Event name" required/>
        <input type="date" value={ev.date} onChange={e => setEv({ ...ev, date: e.target.value })} aria-label="Date" required/>
        <input type="time" value={ev.time} onChange={e => setEv({ ...ev, time: e.target.value })} aria-label="Start time"/>
        <input value={ev.venue} onChange={e => setEv({ ...ev, venue: e.target.value })} placeholder="Place (name or address)" aria-label="Place"/>
        <input value={ev.city} onChange={e => setEv({ ...ev, city: e.target.value })} placeholder="City, e.g. Providence, RI" aria-label="City" required/>
        <input value={ev.price} onChange={e => setEv({ ...ev, price: e.target.value })} placeholder="Price (optional)" aria-label="Price"/>
        <input value={ev.url} onChange={e => setEv({ ...ev, url: e.target.value })} placeholder="Link (optional)" aria-label="Link"/>
        <button className="button primary" disabled={!!busy}><Plus size={15}/>{busy === 'event' ? 'Adding…' : 'Add event'}</button>
      </form>
      {manual.length > 0 && <table className="src-table"><tbody>{manual.map(m => <tr key={m.id}><td><strong>{m.title}</strong>{m.url && <a href={m.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={12}/>link</a>}</td><td>{m.time}</td><td>{m.venue}</td><td>{m.area}</td>
        <td className="src-actions"><button className="ops-link" disabled={!!busy} onClick={() => run(m.id, () => call('sources/event/remove', { id: m.id }))} aria-label={`Remove ${m.title}`}><Trash2 size={14}/></button></td></tr>)}</tbody></table>}
    </details>
    {!sources ? <p className="ins-empty">Loading…</p> : !sources.length ? <p className="ins-empty">No sources yet. Add a Luma or Meetup calendar feed, a venue’s calendar, or a city events page.</p> :
      <table className="src-table"><thead><tr><th>Source</th><th>City</th><th>Events</th><th>Checked</th><th/></tr></thead><tbody>{sources.map(s => <tr key={s.id}>
        <td><strong>{s.name}</strong><a href={s.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={12}/>{s.kind || 'link'}</a>{s.error && <small className="src-error">{s.error}</small>}
          {s.debugging ? <small className="src-debug">Working out how to read this page…</small>
            : s.debug_note && <small className="src-debug">{s.rule ? 'Fixed: ' : 'Checked: '}{s.debug_note}</small>}
          {!s.debugging && s.found <= 1 && <button className="ops-link src-fix" disabled={!!busy} onClick={() => run(`fix${s.id}`, () => call('sources/debug', { id: s.id }))}><Wand2 size={13}/>Try to fix</button>}</td>
        <td>{s.city}</td><td>{s.found}</td><td>{s.fetched ? ago(s.fetched) : '—'}</td>
        <td className="src-actions"><button className="ops-link" disabled={!!busy} onClick={() => run(s.id, () => call('sources/refresh', { id: s.id }))} aria-label={`Check ${s.name} now`}><RefreshCw size={14} className={busy === s.id ? 'spin' : ''}/></button>
          <button className="ops-link" disabled={!!busy} onClick={() => run(s.id, () => call('sources/remove', { id: s.id }))} aria-label={`Remove ${s.name}`}><Trash2 size={14}/></button></td>
      </tr>)}</tbody></table>}
  </section>;
}
