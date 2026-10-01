import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

// Reservations and purchases made through Rall-e: volume in dollars and counts (we take no cut yet). Both keys.
const money = c => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const KIND = { reservation: 'Reservations', tickets: 'Tickets', purchase: 'Other purchases' };
const STATUS = { link_sent: 'Link sent', requested: 'Requested', confirmed: 'Booked', purchased: 'Bought', cancelled: 'Cancelled', failed: 'Didn’t work' };

export default function TransactionsTab({ call, ago }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = () => { setBusy(true); setError(''); call('transactions').then(setData).catch(e => setError(e.message)).finally(() => setBusy(false)); };
  useEffect(load, []);
  const card = (label, w) => <article className="ops-usage-card ok tx-card"><header><strong>{label}</strong></header>
    <p className="tx-big">{money(w.cents)}</p>
    <ul><li>{w.count} completed ({w.started} started)</li><li>{w.people} {w.people === 1 ? 'person' : 'people'}</li>
      {Object.entries(w.byKind).filter(([, v]) => v.started).map(([k, v]) => <li key={k}>{KIND[k]}: {v.count}{v.cents ? ` · ${money(v.cents)}` : ''}</li>)}</ul></article>;
  return <section className="ops-usage">
    <div className="ops-usage-head"><h2>Transactions</h2><span>Reservations and purchases through Rall-e{data ? ` · checked ${ago(data.at)}` : ''}</span><button className="ops-link" disabled={busy} onClick={load}><RefreshCw size={14} className={busy ? 'spin' : ''}/>Refresh</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!data ? <p className="ins-empty">Loading…</p> : <>
      <div className="ops-usage-grid">{card('Last 7 days', data.week)}{card('Last 30 days', data.month)}{card('All time', data.all)}</div>
      {!data.recent.length ? <p className="ins-empty">No reservations or purchases yet. They show up here when someone books a table or buys tickets through Rall-e.</p> :
        <table className="src-table"><thead><tr><th>What</th><th>Where</th><th>Party</th><th>Status</th><th>Amount</th><th>When</th></tr></thead><tbody>
          {data.recent.map((r, i) => <tr key={i}><td>{KIND[r.kind]}</td><td>{r.merchant}</td><td>{r.party || '—'}</td><td>{STATUS[r.status] || r.status}</td><td>{r.cents != null ? money(r.cents) : '—'}</td><td>{ago(r.at)}</td></tr>)}
        </tbody></table>}
    </>}
  </section>;
}
