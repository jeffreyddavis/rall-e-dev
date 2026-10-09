import React, { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, ExternalLink, Wand2 } from 'lucide-react';
import { SOURCE_NOTES } from './sourceNotes.js';

// Both dashboard keys: curated event sources per city (calendar feeds and event pages). See docs/DATA_SOURCES.md.
// A source showing 0 or 1 events gets a debugging run (server/sourcedebug.mjs) that saves a rule for reading it.
const NEXT = 'Next: ask the venue for a calendar feed or events page, or add its events by hand below.';
// The problem in plain words: what the last check found, not just "no events".
function explain(s) {
  const detail = s.debug_note || '';
  const ours = /^(Rall-e had a problem reading this|AI reader:|Page browser:)/.exec(s.error || '');
  if (ours) return { tone: 'warn', ours: true, headline: 'Rall-e had a problem reading this, on our side (not the site\x27s). It retries within the hour.', tech: s.error.replace(/^Rall-e had a problem reading this[^.]*. It retries within the hour. Details: /, '') };
  if (s.debug_cause === 'fixed' && s.found > 1) return { tone: 'ok', headline: `Fixed: now reading ${s.found} events (${s.rule || 'saved rule'}).`, detail };
  if (s.debug_cause === 'forbidden_site' || /forbids automated access/.test(s.error || '')) return { tone: 'bad', headline: 'Can\'t read: its events come from a site that forbids bots (Bookeo, DICE or Resident Advisor).', detail, next: NEXT };
  if (s.debug_cause === 'robots' || /robots\.txt/.test(s.error || '')) return { tone: 'bad', headline: 'Can\'t read: the site asks bots not to read it.', detail, next: NEXT };
  if (s.debug_cause === 'login') return { tone: 'bad', headline: 'Can\'t read: its events are behind a login.', detail, next: NEXT };
  if (s.debug_cause === 'no_upcoming') return { tone: 'warn', headline: 'Nothing upcoming: the page lists no future events right now.', detail };
  if (s.debug_cause) return { tone: 'bad', headline: 'Couldn\'t find a way to read its events.', detail, next: NEXT };
  if (s.found <= 1 && detail) return { tone: 'warn', headline: 'Checked earlier:', detail }; // from before causes were recorded
  return null;
}
export default function SourcesTab({ call, ago }) {
  const [manual, setManual] = useState([]), [ev, setEv] = useState({ title: '', date: '', time: '', venue: '', city: '', price: '', url: '' }),
    [sources, setSources] = useState(null), [url, setUrl] = useState(''), [city, setCity] = useState(''), [name, setName] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const run = async (what, fn) => { setBusy(what); setError(''); try { const d = await fn(); setSources(d.sources); setManual(d.manual || []); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  useEffect(() => { run('load', () => call('sources')); }, []);
  // Try to fix: the row says "Trying…" at once, the list refreshes every few seconds while checks run, then the row
  // shows what happened. fixing[id] = { since, message, report }.
  const [fixing, setFixing] = useState({});
  const tryFix = async s => {
    setFixing(f => ({ ...f, [s.id]: { since: Date.now(), message: 'Starting…' } }));
    try { const d = await call('sources/debug', { id: s.id }); setSources(d.sources); setFixing(f => ({ ...f, [s.id]: { ...f[s.id], message: d.result.message, report: d.result.queued ? null : d.result.message } })); }
    catch (e) { setFixing(f => ({ ...f, [s.id]: { ...f[s.id], report: e.message } })); }
  };
  const waiting = (sources || []).some(s => s.debugging) || Object.values(fixing).some(f => !f.report);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => call('sources').then(d => {
      setSources(d.sources);
      setFixing(f => Object.fromEntries(Object.entries(f).map(([id, x]) => { const s = d.sources.find(y => y.id === id);
        return [id, !x.report && s && !s.debugging && s.debug_done >= x.since - 5000 ? { ...x, report: explain(s)?.headline || `Done: ${s.found} events.` } : x]; })));
    }).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [waiting]);
  return <section className="ops-usage ops-sources">
    <div className="ops-usage-head"><h2>Event sources</h2><span>Calendar feeds and event pages Rall-e checks every 12 hours</span></div>
    <form className="src-add" onSubmit={e => { e.preventDefault(); run('add', () => call('sources', { url, city, name })).then(() => { setUrl(''); setName(''); }); }}>
      <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Link to a calendar feed (.ics) or an events page" aria-label="Source link" required/>
      <input value={city} onChange={e => setCity(e.target.value)} placeholder="City, e.g. Los Angeles, CA" aria-label="City" required/>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name"/>
      <button className="button primary" disabled={!!busy}><Plus size={15}/>{busy === 'add' ? 'Reading it…' : 'Add source'}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <PipelineTrial call={call} ago={ago}/>
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
        <td><strong>{s.name}</strong><a href={s.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={12}/>{s.kind || 'link'}</a>
          {(() => {
            const x = explain(s), f = fixing[s.id], trying = s.debugging || (f && !f.report);
            return <>
              {trying ? <small className="src-why trying"><RefreshCw size={12} className="spin"/>Trying to fix… {f?.message && f.message !== 'Starting…' ? f.message : 'It takes about a minute.'}</small>
                : x ? <div className={`src-why ${x.tone}`}><strong>{x.headline}</strong>{x.detail && <span>{x.detail}</span>}{x.tech && <small className="src-tech">Technical detail: {x.tech}</small>}{x.next && <em>{x.next}</em>}</div>
                : s.error && <small className="src-error">{s.error}</small>}
              {f?.report && !trying && <small className="src-report">Just now: {f.report}</small>}
              {!trying && x?.ours && <button className="ops-link src-fix" disabled={!!busy} onClick={() => run(s.id, () => call('sources/refresh', { id: s.id }))}><RefreshCw size={13}/>Retry now</button>}
              {!trying && !x?.ours && s.found <= 1 && <button className="ops-link src-fix" onClick={() => tryFix(s)}><Wand2 size={13}/>{s.debug_cause ? 'Try again' : 'Try to fix'}</button>}
            </>;
          })()}</td>
        <td>{s.city}</td><td>{s.found}</td><td>{s.fetched ? ago(s.fetched) : '—'}</td>
        <td className="src-actions"><button className="ops-link" disabled={!!busy} onClick={() => run(s.id, () => call('sources/refresh', { id: s.id }))} aria-label={`Check ${s.name} now`}><RefreshCw size={14} className={busy === s.id ? 'spin' : ''}/></button>
          <button className="ops-link" disabled={!!busy} onClick={() => run(s.id, () => call('sources/remove', { id: s.id }))} aria-label={`Remove ${s.name}`}><Trash2 size={14}/></button></td>
      </tr>)}</tbody></table>}
  </section>;
}

// Exa vs Parallel trial (server/pipelines.mjs): both watch the same sources daily; their extra events supplement ours.
const COLS = [['runs', 'Checks', 'Daily checks that have finished'], ['events', 'Events', 'Upcoming events it returned (cleaned, no repeats)'],
  ['alsoScraper', 'Also ours', 'Events our scraper also has: a sign the data is right'], ['extra', 'Extra', 'Events our scraper doesn\'t have (added to Rall-e)'],
  ['caught', 'Caught', 'Of the events our scraper found new since the trial started, how many it also found'], ['first', 'First', 'Of those, how many it had before our scraper'],
  ['cost', 'Cost', 'Estimated spend so far (list prices)']];
function PipelineTrial({ call, ago }) {
  const [d, setD] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { call('pipelines').then(setD).catch(() => {}); }, []);
  if (!d || !d.sources.length) return null;
  const poll = async () => { setBusy(true); setError(''); try { setD(await call('pipelines/poll', {})); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const cell = (v, k) => v == null ? '–' : k === 'cost' ? `$${v.toFixed(2)}` : v;
  return <details className="src-manual src-trial" open>
    <summary>Pipeline trial: Exa vs Parallel ({d.sources.length} sources, {d.scraperNew} new events from our scraper so far)</summary>
    <p className="me-muted">Each service checks these sources once a day. Their events that we don't already have are added to Rall-e (marked "via Exa" / "via Parallel"); nothing of ours is replaced.</p>
    <table className="src-table"><thead><tr><th>Source</th><th>Service</th>{COLS.map(([k, label, tip]) => <th key={k} title={tip}>{label}</th>)}</tr></thead><tbody>
      {d.sources.flatMap(s => Object.entries(s.providers).map(([p, x], i) => <tr key={s.id + p}>
        {i === 0 && <td rowSpan={Object.keys(s.providers).length}><strong>{s.name}</strong><span className="idea-note">{s.city} · {s.scraperNew} new from our scraper</span></td>}
        <td>{p === 'exa' ? 'Exa' : 'Parallel'}{x.error && <span className="idea-note" title={x.error}>Problem: {x.error.slice(0, 60)}</span>}{!x.error && x.polled && <span className="idea-note">checked {ago(x.polled)}</span>}</td>
        {COLS.map(([k]) => <td key={k}>{cell(x[k], k)}</td>)}
      </tr>))}
      {['exa', 'parallel'].filter(p => d.totals[p]?.runs || d.sources.some(s => s.providers[p])).map(p => <tr key={p} className="src-trial-total"><td><strong>Total</strong></td><td><strong>{p === 'exa' ? 'Exa' : 'Parallel'}</strong></td>{COLS.map(([k]) => <td key={k}><strong>{cell(d.totals[p][k], k)}</strong></td>)}</tr>)}
    </tbody></table>
    {d.canEdit && <button className="button secondary" disabled={busy} onClick={poll}><RefreshCw size={15}/>{busy ? 'Checking…' : 'Check for new results now'}</button>}
    {error && <p className="error" role="alert">{error}</p>}
  </details>;
}
