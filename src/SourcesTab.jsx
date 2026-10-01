import React, { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, ExternalLink } from 'lucide-react';

// Both dashboard keys: curated event sources per city (calendar feeds and event pages). See docs/DATA_SOURCES.md.
export default function SourcesTab({ call, ago }) {
  const [sources, setSources] = useState(null), [url, setUrl] = useState(''), [city, setCity] = useState(''), [name, setName] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const run = async (what, fn) => { setBusy(what); setError(''); try { setSources((await fn()).sources); } catch (e) { setError(e.message); } finally { setBusy(''); } };
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
    {!sources ? <p className="ins-empty">Loading…</p> : !sources.length ? <p className="ins-empty">No sources yet. Add a Luma or Meetup calendar feed, a venue’s calendar, or a city events page.</p> :
      <table className="src-table"><thead><tr><th>Source</th><th>City</th><th>Events</th><th>Checked</th><th/></tr></thead><tbody>{sources.map(s => <tr key={s.id}>
        <td><strong>{s.name}</strong><a href={s.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={12}/>{s.kind || 'link'}</a>{s.error && <small className="src-error">{s.error}</small>}</td>
        <td>{s.city}</td><td>{s.found}</td><td>{s.fetched ? ago(s.fetched) : '—'}</td>
        <td className="src-actions"><button className="ops-link" disabled={!!busy} onClick={() => run(s.id, () => call('sources/refresh', { id: s.id }))} aria-label={`Check ${s.name} now`}><RefreshCw size={14} className={busy === s.id ? 'spin' : ''}/></button>
          <button className="ops-link" disabled={!!busy} onClick={() => run(s.id, () => call('sources/remove', { id: s.id }))} aria-label={`Remove ${s.name}`}><Trash2 size={14}/></button></td>
      </tr>)}</tbody></table>}
  </section>;
}
