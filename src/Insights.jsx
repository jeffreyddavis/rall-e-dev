import React from 'react';

// Insights tab of the dashboard: anonymous, long-term product numbers (they survive conversation wipes) and, for the
// operator only, "gaps": what people asked for that Rall-e couldn't do, with one anonymized example each.
const GROUPS = [
  ['Growth & sharing', [['signups_by_text', 'Signed up by texting'], ['signups_web', 'Signed up on the web'], ['signups_from_share', 'Signed up from a shared link'], ['joined_from_share', 'Joined a night from a shared link'],
    ['invites_sent', 'Friends invited'], ['shared_night_views', 'Shared nights viewed'], ['shared_list_views', 'Shared idea lists viewed'], ['share_taps_night', 'Share taps: nights'], ['share_taps_ideas', 'Share taps: idea lists'], ['share_taps_spot', 'Share taps: single spots']]],
  ['Plans & engagement', [['plans_created', 'Plans created'], ['plans_confirmed', 'Plans confirmed'], ['stops_added', 'Stops added'], ['option_sets_sent', 'Sets of ideas sent'], ['options_shown', 'Ideas shown'], ['my_picks', 'My pick taps'],
    ['rsvp_yes', 'RSVPs: yes'], ['rsvp_maybe', 'RSVPs: maybe'], ['rsvp_no', 'RSVPs: no'], ['ideas_suggested', 'Ideas suggested by friends'], ['votes', 'Votes'], ['group_messages', 'Group messages']]],
  ['Trust', [['vault_saves_web', 'Vault saves (secure page)'], ['vault_saves_text', 'Details saved by text'], ['locations_shared', 'Locations shared']]],
  ['What people search for', null]
];
const nice = s => s.replace(/^searches_/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

function Bars({ title, data, field, unit }) {
  const max = Math.max(1, ...data.map(d => d[field]));
  return <figure className="ins-chart"><figcaption>{title} <small>last 14 days</small></figcaption>
    <div className="ins-bars" role="img" aria-label={`${title}: ${data.map(d => `${d.day} ${d[field]}`).join(', ')}`}>
      {data.map(d => <div key={d.day} className="ins-bar" title={`${new Date(`${d.day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}: ${d[field]} ${unit}`}>
        <i style={{ height: `${d[field] ? Math.max(3, d[field] / max * 100) : 0}%` }}/><span>{Number(d.day.slice(8))}</span></div>)}
    </div></figure>;
}

export default function Insights({ data, onRefresh, loading, ago }) {
  if (!data) return <p className="ins-empty">Loading…</p>;
  const t = data.totals, w = data.week, n = k => t[k] || 0, wk = k => w[k] || 0;
  const tiles = [['People reached', data.people.all, `${data.people.active7} active this week`], ['Coming back', data.people.returning, 'texted on 2+ days'],
    ['Texts exchanged', n('texts_in') + n('texts_out'), `+${wk('texts_in') + wk('texts_out')} this week`], ['Plans created', n('plans_created'), `+${wk('plans_created')} this week`]];
  const searches = Object.keys(t).filter(k => k.startsWith('searches_') && k !== 'searches_empty').sort((a, b) => t[b] - t[a]);
  const row = ([k, label]) => <tr key={k}><td>{label}</td><td>{n(k).toLocaleString()}</td><td>{wk(k) ? `+${wk(k)}` : ''}</td></tr>;
  return <section className="ins">
    <div className="ops-usage-head"><h2>Insights</h2><span>Anonymous · counting since {data.since || 'today'}</span><button className="ops-link" disabled={loading} onClick={onRefresh}>Refresh</button></div>
    <div className="ins-tiles">{tiles.map(([label, value, sub]) => <div key={label} className="ins-tile"><span>{label}</span><strong>{value.toLocaleString()}</strong><small>{sub}</small></div>)}</div>
    <div className="ins-charts"><Bars title="Texts per day" data={data.series.map(d => ({ ...d, total: d.texts_in + d.texts_out }))} field="total" unit="texts"/><Bars title="People active per day" data={data.series} field="active" unit="people"/></div>
    <div className="ins-groups">{GROUPS.map(([title, items]) => <article key={title} className="ins-group"><h3>{title}</h3>
      <table><thead><tr><th/><th>All time</th><th>This week</th></tr></thead><tbody>
        {items ? items.map(row) : searches.length ? [...searches.map(k => row([k, nice(k)])), row(['searches_empty', 'Searches that found nothing'])] : <tr><td colSpan={3} className="ins-muted">No searches yet</td></tr>}
      </tbody></table></article>)}</div>
    {data.gaps && <article className="ins-group ins-gaps"><h3>Couldn’t do / failed <small>one anonymized example per type · only you see this</small></h3>
      {data.gaps.length ? <table><thead><tr><th>Type</th><th>Times</th><th>Example ask</th><th>Last</th></tr></thead><tbody>
        {data.gaps.map(g => <tr key={g.category}><td><b>{g.category.replace(/_/g, ' ')}</b>{g.source === 'auto' && <i>auto</i>}</td><td>{g.n}</td><td>{g.example}</td><td className="ins-muted">{ago(g.last_at)}</td></tr>)}
      </tbody></table> : <p className="ins-muted">Nothing yet. Every time Rall-e says it can’t do something, or something fails, it shows up here.</p>}
    </article>}
  </section>;
}
