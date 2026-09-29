import React, { useState } from 'react';
import { MapPin, LoaderCircle, Check } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import './vault.css';

// Opened from a texted link: shares the phone's approximate location once, so Rall-e can find things nearby.
export default function LocationPage({ token }) {
  const [state, setState] = useState('ready'), [label, setLabel] = useState(''), [error, setError] = useState('');
  function share() {
    if (!navigator.geolocation) { setError('This browser can’t share location. Just text Rall-e your neighborhood or ZIP instead.'); return; }
    setState('asking'); setError('');
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const r = await fetch(`/api/location/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }) });
        const data = await r.json(); if (!r.ok) throw new Error(data.error);
        setLabel(data.label); setState('done');
      } catch (e) { setError(e.message); setState('ready'); }
    }, () => { setError('Location wasn’t shared. You can also just text Rall-e your neighborhood or ZIP.'); setState('ready'); }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  }
  return <main className="vault">
    <header className="vault-head"><Wordmark/></header>
    <section className="vault-card vault-center">
      {state === 'done' ? <><Check size={30}/><h1>Got it: {label}</h1><p>Head back to your texts. Rall-e is finding things nearby.</p></>
        : <><MapPin size={30}/><h1>Find things near you</h1><p>Share your approximate location once so Rall-e can suggest nearby plans. It’s rounded to your neighborhood and only saved to your Rall-e profile.</p>
          <button className="button primary full" onClick={share} disabled={state === 'asking'}>{state === 'asking' ? <><LoaderCircle className="spin" size={16}/>Waiting for your phone…</> : 'Share my location'}</button></>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  </main>;
}
