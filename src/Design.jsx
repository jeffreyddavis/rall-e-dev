import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Gift, MessageCircle, ShieldCheck, X } from 'lucide-react';

export function Wordmark() { return <span className="rally-wordmark" aria-label="Rall-e">Rall<span className="wordmark-dot">·</span><span className="wordmark-e">e</span></span>; }
export function RallyIcon() { return <span className="rally-icon" aria-hidden="true">R</span>; }
// The archive contains flattened frames. SVG viewBoxes show only their supplied photo regions.
// These are reference assets, not a screenshot used in place of interactive UI.
export function DesignPhoto({ kind = 'rooftop', className = '' }) {
  const image = kind === 'comedy' ? '/design/invite-reference.png' : '/design/options-reference.png';
  const box = kind === 'comedy' ? '32 276 722 334' : kind === 'dinner' ? '32 276 722 320' : '32 2080 722 280';
  if (!['comedy','dinner','rooftop'].includes(kind)) return null;
  return <div className={`design-photo ${className}`} aria-hidden="true"><svg viewBox={box} preserveAspectRatio="xMidYMid slice"><image href={image} width="786" height={kind === 'comedy' ? '1704' : '2998'}/></svg></div>;
}
// Rall-e is invite-only. The website is the front door: accept an invite (/i/<code>) or join the waitlist.
// There is no web chat anymore: once you're in, Rall-e lives in your texts.
const CONSENT = 'I agree to get texts from Rall-e about plans I make or join. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.';
const smsLink = numbers => { const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent), to = (apple ? numbers?.imessage : numbers?.sms) || numbers?.sms; return to ? `sms:${to}${apple ? '&' : '?'}body=${encodeURIComponent('Hi Rall-e!')}` : null; };
export function Onboarding({ invite = '', api }) {
  const [step, setStep] = useState('landing'), [first, setFirst] = useState(''), [phone, setPhone] = useState(''), [code, setCode] = useState(''), [consent, setConsent] = useState(false);
  const [error, setError] = useState(''), [sending, setSending] = useState(false), [demoCode, setDemoCode] = useState(''), [info, setInfo] = useState(null), [done, setDone] = useState(null);
  React.useEffect(() => { if (invite) api(`/api/invite/${invite}`).then(setInfo).catch(e => setInfo({ error: e.message })); }, [invite]);
  const go = next => { setError(''); setStep(next); };
  async function request(fn) { setSending(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setSending(false); } }
  const usable = invite && info && !info.error && info.open;
  const sendCode = () => request(async () => { const r = await api(`/api/invite/${invite}/code`, { phone, consent }); setDemoCode(r.demoCode || ''); setCode(''); go('code'); });
  const back = { details: 'landing', code: 'details', waitlist: 'landing' }[step];
  const cta = invite ? <button className="button primary landing-cta" disabled={!info} onClick={() => go(usable ? 'details' : 'waitlist')}>{!info ? 'Checking your invite…' : usable ? <>Accept {info.inviter}’s invite <ArrowRight size={18}/></> : <>Join the waitlist <ArrowRight size={18}/></>}</button>
    : <button className="button primary landing-cta" onClick={() => go('waitlist')}>Join the waitlist <ArrowRight size={18}/></button>;
  const name = <input aria-label="First name" placeholder="First name" autoComplete="given-name" maxLength={40} value={first} onChange={e => setFirst(e.target.value)}/>;
  const phoneField = <div className="phone-field"><span>🇺🇸 <small>+1</small></span><input aria-label="Mobile number" type="tel" autoComplete="tel-national" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 123-4567"/></div>;
  const tenDigits = () => phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').length === 10;
  return <main className={`onboarding onboarding-${step === 'landing' ? 'landing' : 'phone'}`}>
    <header className="onboarding-header"><a href="/" aria-label="Rall-e home"><Wordmark/></a><span className="prototype-label">INVITE ONLY</span></header>
    {back && !done && <button className="onboarding-back icon-button" aria-label="Back" onClick={() => go(back)}><ArrowLeft size={20}/></button>}
    {done ? <section className="onboarding-content onboarding-form invite-done"><div className="success-check"><Check strokeWidth={2}/></div>
        <h1>{done.waitlist ? 'You’re on the waitlist' : done.existing ? `Welcome back, ${done.name}` : `You’re in, ${done.name}!`}</h1>
        <p>{done.waitlist ? (done.member ? 'Good news: you’re already on Rall-e. Text Rall-e anytime.' : `You’re #${done.position} in line. We’ll save you a spot. Know someone on Rall-e? Ask them for an invite link to skip the line.`)
          : done.existing ? 'You’re already on Rall-e. Just text Rall-e to make a plan.' : 'Check your texts: Rall-e just said hi. Everything happens right there, no app needed.'}</p>
        {!done.waitlist && smsLink(done.textNumbers) && <a className="button primary full" href={smsLink(done.textNumbers)}>Text Rall-e <ChevronRight size={17}/></a>}</section>
    : step === 'landing' ? <div className="landing-content">
        {invite && info && !info.error ? <p className="invite-eyebrow"><Gift size={16}/>{info.inviter} invited you</p> : null}
        <h1>Get off the apps and<br/>into the <em>real world</em></h1><p>Rall-e plans your social life so you can<br className="desktop-break"/> focus on the fun stuff.</p><span className="blue-rule"/>
        <p className="landing-note">{invite && info?.error ? info.error : invite && info && !info.open ? `${info.inviter}’s invites are all used up, but you can still get in line.` : 'Rall-e is invite-only for now.'}<br/>{invite ? 'All it takes is a text.' : 'Got an invite? Open the link your friend sent you.'}</p>
        {cta}<div className="landing-collage" aria-hidden="true"><svg viewBox="0 1018 786 385"><image href="/design/welcome-reference.png" width="786" height="1704"/></svg></div><span className="fine">Invite-only · Rall-e lives in your texts</span></div>
    : step === 'waitlist' ? <section className="onboarding-content onboarding-form"><h1>Join the waitlist</h1><p>Rall-e is invite-only while we grow. Save your spot and we’ll let you in as soon as we can.</p>
        <form onSubmit={e => { e.preventDefault(); if (!first.trim()) return setError('Please enter your first name.'); if (!tenDigits()) return setError('Enter your 10-digit mobile number.'); request(async () => { const r = await api('/api/waitlist', { name: first, phone }); setDone({ waitlist: true, ...r }); }); }}>
          {name}{phoneField}<p className="fine">We won’t text you until you’re in. Your number is only used for your spot on the list.</p>
          <button className="button primary full" disabled={sending}>{sending ? 'Saving…' : 'Save my spot'}</button></form></section>
    : step === 'details' ? <section className="onboarding-content onboarding-form"><h1>Nice to meet you</h1><p>{info?.inviter} saved you a spot. Rall-e lives in your texts, so we’ll send a code to get you in.</p>
        <form onSubmit={e => { e.preventDefault(); if (!first.trim()) return setError('Please enter your first name.'); if (!tenDigits()) return setError('Enter your 10-digit mobile number.'); if (!consent) return setError('Tick the box to agree to texts from Rall-e.'); sendCode(); }}>
          {name}{phoneField}<label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/><span>{CONSENT}</span></label>
          <button className="button primary full" disabled={sending || !consent}>{sending ? 'Sending…' : 'Text me a code'}</button></form></section>
    : <section className="onboarding-content onboarding-form"><h1>Enter your code</h1><p>{demoCode ? <>Preview mode sends no texts.<br/>Your code is <strong>{demoCode}</strong>.</> : <>We texted a code to {phone}.</>}</p>
        <form onSubmit={e => { e.preventDefault(); request(async () => { const r = await api(`/api/invite/${invite}/verify`, { phone, code, name: first }); setDone(r); }); }}>
          <label className="code-entry"><span className="sr-only">Verification code</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000"/></label>
          <button className="button primary full" disabled={code.length !== 6 || sending}>{sending ? 'Checking…' : 'Join Rall-e'}</button></form>
        <button className="text-link onboarding-skip" disabled={sending} onClick={sendCode}>Text me a new code</button> <button className="text-link onboarding-skip" onClick={() => go('details')}>Change number</button></section>}
    {error && <p className="onboarding-error error" role="alert">{error}</p>}
    <footer className="onboarding-footer">Less planning. More showing up.<span>Rall-e</span></footer>
  </main>;
}
