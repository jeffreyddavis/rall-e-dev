import React, { useState } from 'react';
import './sms.css';

export default function SmsPanel({ plan }) {
  const [password, setPassword] = useState(''), [status, setStatus] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [participant, setParticipant] = useState(plan.participants[0]?.id || ''), [to, setTo] = useState(''), [kind, setKind] = useState('invite');
  const [draft, setDraft] = useState(null), [consent, setConsent] = useState(false);
  async function call(path, input) {
    const response = await fetch(`/api/sms/${path}`, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  async function run(fn) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  function change(fn) { fn(); setDraft(null); setConsent(false); }
  return <div className="sms-panel"><span className="eyebrow">PRESENTER TEXTING</span><h2 id="modal-title">From a plan to a text.</h2>
    {!status ? <><p>Use your private SMS presenter password to preview messages and text approved testers.</p><form onSubmit={e => { e.preventDefault(); run(async () => setStatus(await call('status'))); }}><label htmlFor="sms-password">SMS presenter password</label><input id="sms-password" type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} required/><button className="button primary full" disabled={busy}>Open texting controls</button></form></> : <>
      <span className="pill">{status.mode === 'live' ? 'LIVE TEST TEXTS' : 'PREVIEW ONLY · SENDING OFF'}</span><p>{status.mode === 'live' ? `Sending from ${status.sender} to approved testers only.` : 'You can preview the exact message here. Live sending has not been enabled.'}</p>
      {!plan.participants.length ? <p>Create your friends’ invitation links first.</p> : <form onSubmit={e => { e.preventDefault(); run(async () => { setDraft(await call('preview', { participant, to, kind })); setConsent(false); }); }}>
        <label htmlFor="sms-person">Friend</label><select id="sms-person" value={participant} disabled={busy} onChange={e => change(() => setParticipant(e.target.value))}>{plan.participants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <label htmlFor="sms-number">Their phone number</label><input id="sms-number" type="tel" autoComplete="off" placeholder="+15551234567" value={to} disabled={busy} onChange={e => change(() => setTo(e.target.value))} required/>
        <label htmlFor="sms-kind">Message</label><select id="sms-kind" value={kind} disabled={busy} onChange={e => change(() => setKind(e.target.value))}><option value="invite">Invitation to the plan</option>{plan.status === 'confirmed' && <option value="update">Confirmed plan update</option>}</select>
        <button className="button secondary full" disabled={busy}>Preview this text</button>
      </form>}
      {draft && <div><p className="fine">To {plan.participants.find(p => p.id === participant)?.name} · {draft.recipient}</p><div className="preview-bubble sms-body">{draft.body}</div>
        {draft.status === 'draft' ? <>{!draft.allowed && <p className="fine">This number is not on the approved tester list.</p>}<label className="consent"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)}/><span>This tester agreed to receive this Rall-e text at the number above.</span></label><button className="button primary full" disabled={busy || !consent || !draft.allowed || status.mode !== 'live'} onClick={() => run(async () => { setDraft(await call('send', { id: draft.id, consent })); setStatus(await call('status')); })}>{busy ? 'Submitting…' : 'Send this text'}</button></> : <p role="status">Message status: <strong>{draft.status}</strong>. {draft.status === 'unknown' ? 'Twilio may have accepted it. Check the Twilio message log before any retry.' : draft.status === 'failed' ? `Not sent${draft.error ? ` (Twilio ${draft.error})` : ''}.` : draft.status === 'delivered' ? 'Delivery confirmed by Twilio.' : 'Acceptance does not yet confirm delivery.'}</p>}
      </div>}
      <div className="sms-history"><h3>Delivery status</h3><button className="text-link" disabled={busy} onClick={() => run(async () => setStatus(await call('status')))}>Refresh delivery status</button>{!status.messages.length && <p className="fine">No send attempts for this plan.</p>}{status.messages.map(m => <div key={m.id}><strong>{plan.participants.find(p => p.id === m.participant)?.name} · {m.recipient}</strong><span>{m.kind} · {m.status}{m.error ? ` · Twilio ${m.error}` : ''}</span></div>)}</div>
    </>}{error && <p className="error" role="alert">{error}</p>}
  </div>;
}
