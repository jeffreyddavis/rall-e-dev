import React from 'react';
import { CalendarDays, MapPin, Ticket, DollarSign, Star, ChevronDown, ExternalLink, MessageCircle, Share } from 'lucide-react';
import { DesignPhoto } from './Design.jsx';
import './frosted.css';

// One outing as a frosted card (Marc's mockup): photo, "Name: what it is", when, where, and a price row that expands
// for details and links. Used by the options list (/e/…?s=…) and the evening view (/p/…, /n/…).
const ticketed = e => ['Ticketmaster', 'SeatGeek'].includes(e.source);

export default function OptionCard({ e, open, onToggle, renderArt, badge, note, footer, planText, cardRef, className = '' }) {
  const [day, time] = e.time.split('·').map(x => x.trim());
  const art = e.image ? <img className="event-photo" src={e.image} alt="" loading="lazy"/> : ['comedy', 'dinner', 'rooftop'].includes(e.color) ? <DesignPhoto kind={e.color}/> : renderArt(e.color);
  // Places "tags" are just price/rating, which the card already shows: use the kind of place instead ("Restaurant").
  const tag = e.tag && !/★|^\$/.test(e.tag) ? e.tag : (e.description || '').split(/[,.]/)[0].trim();
  const subtitle = tag || (e.venue && e.venue !== e.short ? `at ${e.venue}` : '');
  const when = time || (e.doors && e.doors !== day ? e.doors : '');
  const PriceIcon = ticketed(e) ? Ticket : DollarSign;
  return <article className={`invitation-card option-card ${className}`} ref={cardRef}>{art}<div className="invitation-card-body">
    {badge && <span className="option-badge">{badge}</span>}
    <h2><strong>{e.short}{tag ? ':' : ''}</strong>{subtitle ? ` ${subtitle}` : ''}</h2>
    {note && <p className="option-note">“{note}”</p>}
    <div className="invitation-fact"><CalendarDays/><div><strong>{day}</strong>{when && <span>{when}</span>}</div></div>
    <div className="invitation-fact"><MapPin/><div><strong>{e.venue}</strong><span>{e.address || e.area}</span></div></div>
    <button type="button" className="invitation-fact option-toggle" aria-expanded={open} aria-controls={`details-${e.id}`} onClick={onToggle}>
      <PriceIcon/><div><span><strong>{ticketed(e) ? 'Tickets' : 'Price'}</strong> {e.priceText || (e.price ? `$${e.price}/person (sample)` : 'Free')}</span></div><ChevronDown className="chevron" size={18}/>
    </button>
    {open && <div className="option-details" id={`details-${e.id}`}>
      {e.description && <p>{e.description}</p>}
      {e.rating && <p className="option-rating"><Star size={14}/>{e.rating}</p>}
      {(planText || e.url) && <div className="event-actions">
        {planText && <a className="button primary" href={planText}><MessageCircle size={16}/>Plan this with friends</a>}
        {e.url && <a className="button secondary" href={e.url} target="_blank" rel="noreferrer"><ExternalLink size={16}/>{e.source === 'Google Places' ? 'Open in Maps' : 'See tickets'}</a>}
      </div>}
      <p className="source">{e.fictional === false ? `Listing via ${e.source}` : 'Sample outing'}</p>
    </div>}
    {footer && <><hr/>{footer}</>}
  </div></article>;
}

// "Plan this with friends": opens Messages to Rall-e with the outing filled in (the link tells Rall-e which one).
export const planLink = (e, numbers = {}) => {
  const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent), to = (apple ? numbers.imessage : numbers.sms) || numbers.sms || numbers.imessage || '';
  return to ? `sms:${to}${apple ? '&' : '?'}body=${encodeURIComponent(`Let's plan ${e.short} (rall-e.ai/e/${e.id})`)}` : '';
};

// Big share button (Mike: "the web pages make natural viral loops"). Native share sheet, or copy the link.
export function ShareButton({ url, title, label = 'Share' }) {
  const [copied, setCopied] = React.useState(false);
  if (!url) return null;
  async function share() {
    try { fetch('/api/stats/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: /night/i.test(label) ? 'night' : /ideas/i.test(label) ? 'ideas' : 'spot' }), keepalive: true }); } catch {}
    try { if (navigator.share) { await navigator.share({ title, text: title, url }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { prompt('Copy this link', url); }
  }
  return <button type="button" className="button primary share-button" onClick={share}><Share size={17}/>{copied ? 'Link copied' : label}</button>;
}

// A compact timeline row (Marc's layout): thumbnail, "Name · what it is", one status line; tap to expand the details.
export function CompactCard({ e, open, onToggle, renderArt, badge, note, footer, planText, className = '' }) {
  const [day, time] = e.time.split('·').map(x => x.trim());
  const tag = e.tag && !/★|^\$/.test(e.tag) ? e.tag : (e.description || '').split(/[,.]/)[0].trim();
  const thumb = e.thumb || e.image ? <img src={e.thumb || e.image} alt="" loading="lazy"/> : ['comedy', 'dinner', 'rooftop'].includes(e.color) ? <DesignPhoto kind={e.color}/> : renderArt(e.color);
  return <article className={`stop-card ${open ? 'open' : ''} ${className}`}>
    <button type="button" className="stop-row" aria-expanded={open} onClick={onToggle}>
      <span className="stop-thumb">{thumb}</span>
      <span className="stop-text">
        {badge && <span className="option-badge">{badge}</span>}
        <span className="stop-title"><strong>{e.short}</strong>{tag ? <> · {tag}</> : null}</span>
        <span className="stop-sub">{[time || day, e.priceText].filter(Boolean).join(' · ')}</span>
      </span>
      <ChevronDown className="chevron" size={18}/>
    </button>
    {open && <div className="stop-details">
      {note && <p className="option-note">“{note}”</p>}
      <div className="invitation-fact"><CalendarDays/><div><strong>{day}</strong>{time && <span>{time}</span>}</div></div>
      <div className="invitation-fact"><MapPin/><div><strong>{e.venue}</strong><span>{e.address || e.area}</span></div></div>
      {e.description && <p>{e.description}</p>}
      {e.rating && <p className="option-rating"><Star size={14}/>{e.rating}</p>}
      {(planText || e.url) && <div className="event-actions">
        {planText && <a className="button primary" href={planText}><MessageCircle size={16}/>Plan this with friends</a>}
        {e.url && <a className="button secondary" href={e.url} target="_blank" rel="noreferrer"><ExternalLink size={16}/>{e.source === 'Google Places' ? 'Open in Maps' : 'See tickets'}</a>}
      </div>}
      <p className="source">{e.fictional === false ? `Listing via ${e.source}` : 'Sample outing'}</p>
    </div>}
    {footer && <div className="stop-footer">{footer}</div>}
  </article>;
}
