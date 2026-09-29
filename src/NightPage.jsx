import React, { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import EveningView from './EveningView.jsx';

// The host's evening view, opened from a link Rall-e texts them (/n/<token>). Same page the group sees.
export default function NightPage({ token, renderArt }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = () => fetch(`/api/night/${token}`).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setState(d); });
  useEffect(() => { load().catch(e => setError(e.message)); const t = setInterval(() => load().catch(() => {}), 5000); return () => clearInterval(t); }, [token]);
  async function adopt(s) {
    setBusy(true); setError('');
    try { const r = await fetch(`/api/night/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'addStop', eventId: s.eventId, suggestion: s.id }) }), d = await r.json(); if (!r.ok) throw new Error(d.error); setState(d); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <main className="event-page night-page">
    <header><a href="/" aria-label="Rall-e home"><Wordmark/></a><span className="source">Only you can see this link</span></header>
    {error && <p className="error" role="alert">{error}</p>}
    {state ? <EveningView state={state} host busy={busy} renderArt={renderArt} onAdopt={adopt} shareUrl={state.shareUrl} textNumbers={state.textNumbers}/> : !error && <LoaderCircle className="spin"/>}
  </main>;
}
