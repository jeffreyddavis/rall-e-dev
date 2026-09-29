import React, { useEffect, useRef, useState } from 'react';
import { LockKeyhole, ShieldCheck, CreditCard, Trash2, LoaderCircle, Check } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import './vault.css';

// Private vault page, opened only from a one-time link texted to the owner's phone.
// Card details are entered in Stripe's own secure form (loaded from js.stripe.com) and never touch Rall-e.
async function call(token, path = '', method = 'GET', data) {
  const response = await fetch(`/api/vault/${token}${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
function loadStripe(key) {
  return new Promise((resolve, reject) => {
    if (window.Stripe) return resolve(window.Stripe(key));
    const s = document.createElement('script'); s.src = 'https://js.stripe.com/v3/';
    s.onload = () => resolve(window.Stripe(key)); s.onerror = () => reject(new Error('Could not load the secure card form.'));
    document.head.appendChild(s);
  });
}
const GROUPS = [
  ['About you', [['firstName', 'First name', 'given-name'], ['lastName', 'Last name', 'family-name'], ['email', 'Email', 'email', 'email']]],
  ['Address', [['addressLine1', 'Street address', 'address-line1'], ['addressLine2', 'Apt, suite (optional)', 'address-line2'], ['city', 'City', 'address-level2'], ['state', 'State', 'address-level1'], ['zip', 'ZIP', 'postal-code']]],
  ['Food', [['dietary', 'Dietary preferences (e.g. vegetarian)'], ['allergies', 'Allergies']]],
  ['Reservation accounts', [['openTable', 'OpenTable email'], ['resy', 'Resy email'], ['otherLoyalty', 'Other memberships']]]
];

export default function VaultPage({ token }) {
  const [data, setData] = useState(null), [form, setForm] = useState({}), [error, setError] = useState(''), [busy, setBusy] = useState(''), [saved, setSaved] = useState(false);
  const [cardReady, setCardReady] = useState(false), [cardOpen, setCardOpen] = useState(false), [confirmDelete, setConfirmDelete] = useState(false), [deleted, setDeleted] = useState(false);
  const stripeRef = useRef(null), elementsRef = useRef(null), mountRef = useRef(null);
  useEffect(() => { call(token).then(d => { setData(d); setForm(d.fields); }).catch(e => setError(e.message)); }, [token]);
  async function run(name, fn) { setBusy(name); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); } }
  const save = e => { e.preventDefault(); run('save', async () => { const d = await call(token, '', 'POST', form); setData(d); setForm(d.fields); setSaved(true); setTimeout(() => setSaved(false), 3000); }); };
  const openCard = () => run('card', async () => {
    const { clientSecret } = await call(token, '/card/start', 'POST', {});
    const stripe = await loadStripe(data.stripeKey); stripeRef.current = stripe;
    elementsRef.current = stripe.elements({ clientSecret, appearance: { theme: 'stripe', variables: { colorPrimary: '#238fd6', borderRadius: '12px', fontFamily: 'DM Sans, system-ui, sans-serif' } } });
    setCardReady(false); setCardOpen(true); // the card form mounts once its container is on the page (effect below)
  });
  useEffect(() => {
    if (!cardOpen || !elementsRef.current || !mountRef.current) return;
    const el = elementsRef.current.create('payment', { layout: 'tabs', wallets: { applePay: 'never', googlePay: 'never' } });
    el.on('ready', () => setCardReady(true));
    el.on('loaderror', e => setError(e?.error?.message || 'The secure card form could not load. Please try again.'));
    el.mount(mountRef.current);
    return () => { try { el.destroy(); } catch {} };
  }, [cardOpen]);
  const saveCard = () => run('cardsave', async () => {
    const { error: stripeError, setupIntent } = await stripeRef.current.confirmSetup({ elements: elementsRef.current, redirect: 'if_required' });
    if (stripeError) throw new Error(stripeError.message);
    setData(await call(token, '/card/finish', 'POST', { setupIntent: setupIntent.id })); setCardOpen(false);
  });
  if (deleted) return <main className="vault"><Wordmark/><section className="vault-card vault-center"><ShieldCheck size={28}/><h1>Everything is deleted.</h1><p>Your vault and any saved card were removed. You can add details again anytime by texting Rall-e.</p></section></main>;
  if (!data) return <main className="vault"><Wordmark/><section className="vault-card vault-center">{error ? <><LockKeyhole size={28}/><h1>Link expired</h1><p>{error}</p></> : <LoaderCircle className="spin"/>}</section></main>;
  return <main className="vault">
    <header className="vault-head"><Wordmark/><span className="vault-lock"><LockKeyhole size={14}/>Private</span></header>
    <section className="vault-intro"><h1>Your Rall-e vault</h1><p>Details for booking plans for {data.phone}. Encrypted and only used when you ask Rall-e to book something. Rall-e’s AI only sees a masked summary.</p></section>
    <form className="vault-card" onSubmit={save}>
      {GROUPS.map(([title, fields]) => <fieldset key={title}><legend>{title}</legend><div className="vault-grid">{fields.map(([k, label, auto, type]) =>
        <label key={k} className={['addressLine1', 'addressLine2', 'dietary', 'allergies', 'otherLoyalty'].includes(k) ? 'wide' : ''}><span>{label}</span><input type={type || 'text'} autoComplete={auto || 'off'} value={form[k] || ''} onChange={e => setForm({ ...form, [k]: e.target.value })}/></label>)}</div></fieldset>)}
      <button className="button primary full" disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : saved ? <><Check size={16}/>Saved</> : 'Save details'}</button>
    </form>
    <section className="vault-card">
      <h2><CreditCard size={18}/>Card for bookings</h2>
      {!data.cards ? <p className="fine">Card storage isn’t switched on yet.</p> : data.card && !cardOpen ? <div className="vault-saved-card"><div><strong>{data.card.brand} ending {data.card.last4}</strong><span>Expires {data.card.expMonth}/{String(data.card.expYear).slice(-2)}</span></div><div><button type="button" className="text-link" onClick={openCard} disabled={!!busy}>Replace</button><button type="button" className="text-link danger" onClick={() => run('rm', async () => setData(await call(token, '/card', 'DELETE')))} disabled={!!busy}>Remove</button></div></div>
        : cardOpen ? <><div ref={mountRef} className="vault-stripe"/><button type="button" className="button primary full" onClick={saveCard} disabled={busy === 'cardsave' || !cardReady}>{busy === 'cardsave' ? 'Saving card…' : cardReady ? 'Save card' : 'Loading secure card form…'}</button></>
        : <button type="button" className="button secondary full" onClick={openCard} disabled={busy === 'card'}>{busy === 'card' ? 'Opening secure form…' : 'Add a card'}</button>}
      <p className="fine">Card numbers go straight to Stripe, our payment processor. Rall-e only keeps the brand and last 4 digits. Nothing is charged: bookings aren’t live yet, and you’ll always approve the total first.</p>
    </section>
    {error && <p className="error" role="alert">{error}</p>}
    <footer className="vault-foot">
      {confirmDelete ? <div className="vault-confirm"><span>Delete all your details and card?</span><button className="button secondary" onClick={() => setConfirmDelete(false)}>Keep</button><button className="button danger-button" onClick={() => run('del', async () => { await call(token, '', 'DELETE'); setDeleted(true); })}>Delete everything</button></div>
        : <button className="text-link danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14}/>Delete my vault</button>}
      <span>This link expires about {Math.max(1, Math.round(data.expiresInSec / 60))} minutes after it was sent.</span>
    </footer>
  </main>;
}
