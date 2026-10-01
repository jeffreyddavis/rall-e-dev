import React, { useEffect, useState } from 'react';
import { LoaderCircle, MapPin, Share2, Check } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import './me.css';

// A member's public "top 5" list (/f/<token>): first name, category, city and places only. Made by texting Rall-e
// "my top 5 restaurants in Boston". Sharing it is the point.
export default function FavPage({ token }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  useEffect(() => { fetch(`/api/fav/${token}`).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); }).catch(e => setError(e.message)); }, [token]);
  async function share() {
    const title = `${data.who}'s top ${data.items.length} ${data.category} in ${data.city.split(',')[0]}`;
    if (navigator.share) { try { await navigator.share({ title, url: location.href }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch {}
  }
  return <main className="event-page me-page">
    <header><a href="/" aria-label="Rall-e home"><Wordmark/></a><span className="source">Favorites</span></header>
    {!data ? (error ? <p className="error" role="alert">{error}</p> : <LoaderCircle className="spin"/>) : <div className="me">
      <section className="me-card fav-card">
        <p className="me-eyebrow"><MapPin size={16}/>{data.city}</p>
        <h1 className="me-title fav-title">{data.who}’s top {data.items.length} {data.category}</h1>
        <ol className="fav-list">{data.items.map(i => <li key={i.rank}>
          <span className="fav-rank">{i.rank}</span>
          <div><strong>{i.url ? <a href={i.url} target="_blank" rel="noopener noreferrer">{i.name}</a> : i.name}</strong>
            {i.note && <p>“{i.note}”</p>}{(i.area || i.address) && <small>{i.area || i.address}</small>}</div>
        </li>)}</ol>
        <button className="button primary full" onClick={share}>{copied ? <><Check size={16}/>Link copied</> : <><Share2 size={16}/>Share this list</>}</button>
      </section>
      <section className="me-card"><h2>Make your own</h2><p>Text Rall-e “my top 5 coffee spots in your city” and it makes a page like this. Friends on Rall-e see your favorites when they look for places near you.</p>
        <p className="me-muted">Rall-e is invite-only for now. Ask {data.who} for an invite.</p></section>
    </div>}
  </main>;
}
