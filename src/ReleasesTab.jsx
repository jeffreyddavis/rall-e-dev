import React, { useEffect, useState } from 'react';
import { RefreshCw, Check } from 'lucide-react';

// Release notes (both keys): the "what's new" texts members get when a feature or fix goes live, newest first, with how
// many members each reached. The operator key also sees notes waiting for approval; approving one sends it to members
// at their next good time (daytime, not mid-conversation, combined with others).
export default function ReleasesTab({ call, ago }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const run = async (what, fn) => { setBusy(what); setError(''); try { setData(await fn()); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  useEffect(() => { run('load', () => call('releases')); }, []);
  return <section className="ops-usage ops-sources">
    <div className="ops-usage-head"><h2>Release notes</h2><span>What members are texted when something new goes live{data ? ` (${data.members} members get updates)` : ''}.</span>
      <button className="ops-link" disabled={!!busy} onClick={() => run('load', () => call('releases'))}><RefreshCw size={14} className={busy === 'load' ? 'spin' : ''}/>Refresh</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!data ? <p className="ins-empty">Loading…</p> : <>
      {data.canApprove && <>
        <h3 className="rel-head">Waiting for approval</h3>
        {!data.held.length ? <p className="ins-empty">Nothing waiting. New notes show up here when they’re added with a hold.</p> :
          <ul className="rel-list">{data.held.map(r => <li key={r.id} className="held">
            <p>{r.text}</p><small>{r.date}</small>
            <button className="button primary" disabled={!!busy} onClick={() => confirm(`Text this to every member who gets updates?\n\n“${r.text}”`) && run(r.id, () => call('releases/approve', { id: r.id }))}><Check size={15}/>Approve and send</button>
          </li>)}</ul>}
        <h3 className="rel-head">Sent</h3>
      </>}
      {!data.released.length ? <p className="ins-empty">No release notes yet.</p> :
        <ul className="rel-list">{data.released.map(r => <li key={r.id}><p>{r.text}</p><small>{r.date} · live {ago(r.at)} · texted to {r.sent} {r.sent === 1 ? 'member' : 'members'}</small></li>)}</ul>}
    </>}
  </section>;
}
