import React, { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import EveningView from './EveningView.jsx';
import JoinCard from './JoinCard.jsx';

// Public, read-only copy of a night (/s/<token>) for sharing beyond the group: stops and a head count, no names.
export default function SharePage({ token, renderArt }) {
  const [data, setData] = useState(null), [error, setError] = useState('');
  useEffect(() => { fetch(`/api/share/${token}`).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); }).catch(e => setError(e.message)); }, [token]);
  return <main className="event-page night-page">
    <header><a href="/" aria-label="Rall-e home"><Wordmark/></a><span className="source">Planned with Rall-e</span></header>
    {error && <p className="error" role="alert">{error}</p>}
    {data ? <EveningView state={data} readOnly renderArt={renderArt} shareUrl={location.href} textNumbers={data.textNumbers} cta={<JoinCard source={token} textNumbers={data.textNumbers} night={['proposed', 'confirmed'].includes(data.plan.status) ? { host: data.name, title: data.plan.title } : null}/>}/> : !error && <LoaderCircle className="spin"/>}
  </main>;
}
