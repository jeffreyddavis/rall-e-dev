import React, { useEffect, useState } from 'react';
import { LoaderCircle, MapPin, Share2, Check, Users } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import './me.css';

// "Where my friends go" (/fp/<token>, Marc #25): places from friends' top-5 lists near a city, grouped by category,
// with whose pick each one is. First names and places only. Made by texting Rall-e "where do my friends go in Austin?".
export default function FriendsPlacesPage({ token }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  useEffect(() => { fetch(`/api/friends-places/${token}`).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); }).catch(e => setError(e.message)); }, [token]);
  const city = data?.city?.split(',')[0] || '';
  async function share() {
    const title = `Where friends go in ${city}`;
    if (navigator.share) { try { await navigator.share({ title, url: location.href }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch {}
  }
  const maps = i => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${i.name} ${i.area || data.city}`)}`;
  return <main className="event-page me-page">
    <header><a href="/" aria-label="Rall-e home"><Wordmark/></a><span className="source">Friends’ places</span></header>
    {!data ? (error ? <p className="error" role="alert">{error}</p> : <LoaderCircle className="spin"/>) : <div className="me">
      <section className="me-card fav-card">
        <p className="me-eyebrow"><MapPin size={16}/>{data.city}</p>
        <h1 className="me-title fav-title">Where {data.for ? `${data.for}’s` : 'your'} friends go in {city}</h1>
        {data.friends.length > 0 && <p className="me-muted"><Users size={14}/> Picks from {data.friends.join(', ')}</p>}
        {!data.groups.length && <p>No friends’ favorites here yet.</p>}
        {data.groups.map(g => <div key={g.category} className="fp-group">
          <h2>{g.category}</h2>
          <ol className="fav-list">{g.items.map((i, n) => <li key={n}>
            <span className="fav-rank">{i.rank}</span>
            <div><strong><a href={i.url || maps(i)} target="_blank" rel="noopener noreferrer">{i.name}</a></strong>
              <small className="fp-who">{i.who}’s #{i.rank}</small>
              {i.note && <p>“{i.note}”</p>}{i.area && <small>{i.area}</small>}</div>
          </li>)}</ol>
        </div>)}
        <button className="button primary full" onClick={share}>{copied ? <><Check size={16}/>Link copied</> : <><Share2 size={16}/>Share this page</>}</button>
      </section>
      <section className="me-card"><h2>Add yours</h2><p>Text Rall-e “my top 5 coffee spots in your city”. Friends on Rall-e see your picks when they look nearby or travel there.</p></section>
    </div>}
  </main>;
}
