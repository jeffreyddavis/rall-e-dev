import React, { useState } from 'react';
import { MessageCircle, LoaderCircle, Check } from 'lucide-react';

// Opt in to Rall-e from a shared page: name + number + consent box, then the code Rall-e texts (double opt-in).
// On success Rall-e texts a welcome and its contact card, and they can start planning by text right away.
const CONSENT = 'I agree to get texts from Rall-e about plans I make or join. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.';
const post = async (url, data) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }), d = await r.json(); if (!r.ok) throw new Error(d.error); return d; };

export default function JoinCard({ source, textNumbers, night = null, heading = 'Plan your own outing with Rall-e' }) {
  // On a shared night, joining it is the likely reason they're signing up, so it's on by default (and easy to untick).
  const [joinNight, setJoinNight] = useState(Boolean(night)), [joined, setJoined] = useState(null);
  const [step, setStep] = useState('form'), [name, setName] = useState(''), [phone, setPhone] = useState(''), [consent, setConsent] = useState(false);
  const [code, setCode] = useState(''), [demo, setDemo] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent), to = (apple ? textNumbers?.imessage : textNumbers?.sms) || textNumbers?.sms || '';
  const hello = to ? `sms:${to}${apple ? '&' : '?'}body=${encodeURIComponent('Hi Rall-e! Find us something fun to do this weekend')}` : '';
  const run = async fn => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  if (step === 'done' && joined) return <div className="evening-cta join-card"><strong><Check size={16}/>{joined.already === 'host' ? 'This is your own plan' : `You’re in for ${night.host}’s plan!`}</strong>
    <span>{joined.already === 'host' ? 'You’re already hosting it.' : `Rall-e just texted you the details${joined.already ? '' : ' and its contact card'}. Text it anytime with questions or ideas.`}</span>
    {joined.link && <a className="button primary share-button" href={joined.link}>See your plan page</a>}</div>;
  if (step === 'done') return <div className="evening-cta join-card"><strong><Check size={16}/>You’re in, {name}!</strong><span>Rall-e just texted you. Save its contact card, then text it what you’re in the mood for.</span>
    {hello && <a className="button primary share-button" href={hello}><MessageCircle size={17}/>Text Rall-e</a>}</div>;
  if (step === 'member') return <div className="evening-cta join-card"><strong><Check size={16}/>You’re already on Rall-e</strong><span>Just text it what you’re in the mood for.</span>
    {hello && <a className="button primary share-button" href={hello}><MessageCircle size={17}/>Text Rall-e</a>}</div>;
  return <form className="evening-cta join-card" onSubmit={e => { e.preventDefault(); run(async () => {
    if (step === 'form') { const r = await post('/api/signup/code', { phone, join: source, consent }); setDemo(r.demoCode || ''); setStep('code'); return; }
    const v = await post('/api/signup/verify', { phone, code });
    if (!v.existing) await post('/api/session', { name, verification: v.verification });
    if (joinNight) { setJoined(await post(`/api/share/${source}/join`, {})); setStep('done'); return; }
    setStep(v.existing ? 'member' : 'done');
  }); }}>
    <strong>{joinNight ? `Join ${night.host}’s plan` : heading}</strong>
    <span>{joinNight ? 'Sign up with your number and you’re on the plan. Rall-e texts you the details and any changes.' : 'Text Rall-e what you’re in the mood for. It finds the spots and rallies your friends.'}</span>
    {step === 'form' ? <>
      <input aria-label="First name" placeholder="First name" autoComplete="given-name" value={name} onChange={e => setName(e.target.value)} required maxLength={40}/>
      <input aria-label="Mobile number" placeholder="Mobile number" type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} required/>
      {night && <label className="join-night"><input type="checkbox" checked={joinNight} onChange={e => setJoinNight(e.target.checked)}/><span><strong>Add me to {night.title}</strong><small>{night.host} and the group will see you’re in.</small></span></label>}
      <label className="join-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required/><span>{CONSENT}</span></label>
      <button className="button primary share-button" disabled={busy || !consent}>{busy ? <LoaderCircle className="spin" size={17}/> : null}Text me a code</button>
    </> : <>
      <span>We texted a 6-digit code to {phone}.{demo ? ` (Preview mode: ${demo})` : ''}</span>
      <input aria-label="Code" placeholder="6-digit code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required/>
      <button className="button primary share-button" disabled={busy || code.length !== 6}>{busy ? <LoaderCircle className="spin" size={17}/> : null}{joinNight ? 'Join the plan' : 'Join Rall-e'}</button>
      <button type="button" className="text-link" onClick={() => { setStep('form'); setCode(''); }}>Use a different number</button>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}
