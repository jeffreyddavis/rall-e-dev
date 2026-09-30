import React, { useEffect, useState } from 'react';
import { Camera, Check, Copy, Gift, LoaderCircle, Share2, Plus, Trash2 } from 'lucide-react';
import { Wordmark } from './Design.jsx';
import './me.css';

// A member's private page (/me/<token>, texted by Rall-e): invites now, profile photo next.
// Idea from Instinct's "Invite a friend" screen, in Rall-e's frosted style (Donovan's designs will replace it).
async function call(token, path = '', data) {
  const r = await fetch(`/api/me/${token}${path}`, data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {});
  const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
}
// Square-crop and shrink in the browser (this also turns iPhone HEIC photos into JPEG) so uploads stay tiny.
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('That file doesn’t look like a photo.')); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight), c = document.createElement('canvas'); c.width = c.height = 320;
    c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 320, 320);
    let blob; for (const q of [0.86, 0.76, 0.66, 0.56, 0.46]) { blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); if (blob.size < 30000) break; }
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
function PhotoCard({ me, token, onChange, setError }) {
  const [busy, setBusy] = useState(false), input = React.useRef(null);
  async function send(method, body) {
    setBusy(true); setError('');
    try { const r = await fetch(`/api/me/${token}/photo`, { method, headers: body ? { 'content-type': 'image/jpeg' } : {}, body }), d = await r.json(); if (!r.ok) throw new Error(d.error); onChange(d); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="me-card me-profile">
    <div className="me-photo">{me.photo ? <img src={me.photo} alt="Your profile photo"/> : <span aria-hidden="true">{(me.name || '?').slice(0, 1)}</span>}</div>
    <div className="me-profile-text"><h1>{me.name || 'Your profile'}</h1><p className="me-muted">{me.photo ? 'Friends see this on plan pages.' : 'Add a photo so friends know it’s you. You can also just text one to Rall-e.'}</p>
      <div className="me-photo-actions">
        <input ref={input} type="file" accept="image/*" hidden onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { await send('POST', await shrink(f)); } catch (err) { setError(err.message); } }}/>
        <button className="button primary" disabled={busy} onClick={() => input.current?.click()}><Camera size={16}/>{busy ? 'Saving…' : me.photo ? 'Change photo' : 'Add a photo'}</button>
        {me.photo && <button className="button secondary" disabled={busy} onClick={() => send('DELETE')} aria-label="Remove photo"><Trash2 size={16}/></button>}
      </div></div>
  </section>;
}
export default function MePage({ token }) {
  const [me, setMe] = useState(null), [error, setError] = useState(''), [name, setName] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState('');
  useEffect(() => { call(token).then(setMe).catch(e => setError(e.message)); }, [token]);
  async function create(e) {
    e.preventDefault(); setBusy(true); setError('');
    try { setMe({ ...me, ...(await call(token, '/links', { name: name.trim() })) }); setName(''); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function share(link) {
    const text = `${me.name ? `${me.name} invited you to` : 'Join me on'} Rall-e. It plans your social life so you can focus on the fun stuff.`;
    if (navigator.share) { try { await navigator.share({ title: 'Join me on Rall-e', text, url: link.url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(link.url); setCopied(link.code); setTimeout(() => setCopied(''), 2500); } catch { setError('Copy the link from the box.'); }
  }
  const left = me ? Math.max(0, me.quota - me.used) : 0;
  return <main className="event-page me-page">
    <header><a href="/" aria-label="Rall-e home"><Wordmark/></a><span className="source">Only you can see this page</span></header>
    {!me ? (error ? <p className="error" role="alert">{error}</p> : <LoaderCircle className="spin"/>) : <div className="me">
      <PhotoCard me={me} token={token} onChange={d => setMe({ ...me, ...d })} setError={setError}/>
      <section className="me-card">
        <p className="me-eyebrow"><Gift size={16}/>Rall-e is invite-only</p>
        <h2 className="me-title">Invite a friend</h2>
        <p>Share a link to invite someone to Rall-e. You can use the same link for more than one friend.</p>
        <div className="me-meter" role="img" aria-label={`${me.used} of ${me.quota} invites used`}><i style={{ width: `${Math.min(100, me.used / Math.max(1, me.quota) * 100)}%` }}/></div>
        <p className="me-muted">{me.used} of {me.quota} invites used{left ? '' : ' (all used)'}. Invites count when someone joins.</p>
      </section>
      <section className="me-card">
        <h2>Your links</h2>
        <ul className="me-links">{me.links.map(l => <li key={l.code}>
          <div><strong>{l.label || 'Your invite link'}</strong><input readOnly value={l.url} aria-label="Invite link" onFocus={e => e.target.select()}/><small>{l.joins ? `${l.joins} joined` : 'No one yet'}</small></div>
          <button className="button primary" disabled={!left} onClick={() => share(l)} aria-label={`Share ${l.label || 'your invite link'}`}>{copied === l.code ? <><Check size={16}/>Copied</> : navigator.share ? <><Share2 size={16}/>Share</> : <><Copy size={16}/>Copy</>}</button>
        </li>)}</ul>
        <form className="me-new" onSubmit={create}>
          <label htmlFor="link-name">New link name (optional)</label>
          <input id="link-name" value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="friends-of-rall-e" maxLength={64} autoCapitalize="none" autoCorrect="off"/>
          <small className="me-muted">8–64 lowercase letters, numbers, or hyphens. Handy for knowing where people came from.</small>
          <button className="button secondary full" disabled={busy || (name && name.length < 8)}><Plus size={16}/>{busy ? 'Creating…' : 'Create invite link'}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <MemoryCard me={me} token={token} onChange={d => setMe({ ...me, ...d })} setError={setError}/>
      {me.joined.length > 0 && <section className="me-card"><h2>Joined with your invite</h2><ul className="me-joined">{me.joined.map((j, i) => <li key={i}><span className="avatar">{j.name.slice(0, 1)}</span><span>{j.name}</span><small>{new Date(j.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small></li>)}</ul></section>}
    </div>}
  </main>;
}

// What Rall-e remembers about them (their own facts only), each deletable. Texting "forget …" works too.
function MemoryCard({ me, token, onChange, setError }) {
  const [busy, setBusy] = useState('');
  const items = me.memory || [];
  async function remove(id) {
    setBusy(id); setError('');
    try { const r = await fetch(`/api/me/${token}/memory/${id}`, { method: 'DELETE' }), d = await r.json(); if (!r.ok) throw new Error(d.error); onChange(d); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  return <section className="me-card">
    <h2>What Rall-e knows</h2>
    <p className="me-muted">{items.length ? 'Rall-e uses these to plan better for you, and only with you. Remove anything you like, or text “forget …”.' : 'Nothing yet. Tell Rall-e things like “I don’t eat meat” or “Sunday afternoons work best” and it’ll remember.'}</p>
    {items.length > 0 && <ul className="me-memory">{items.map(f => <li key={f.id}>
      <span><small>{f.label}{f.about ? ` · ${f.about}` : ''}{f.source !== 'said' ? ' · guess' : ''}</small><strong>{f.value}</strong></span>
      <button className="icon-button" disabled={busy === f.id} onClick={() => remove(f.id)} aria-label={`Forget: ${f.value}`}><Trash2 size={16}/></button>
    </li>)}</ul>}
  </section>;
}
