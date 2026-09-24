import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Star, Trophy, MessageCircleHeart, Settings as SettingsIcon, Inbox } from 'lucide-react';
import { api } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';
import { toast } from '../toast.js';
import './reviews.css';

// Reviews & patient feedback (RV1–RV3, docs/reviews.md): how review requests are doing (sent → opened → rated →
// posted / private feedback), the private feedback inbox (new → contacted → resolved), and the team shout-out
// leaderboard. Settings (how often to ask, where happy patients can post, who hears about feedback, points)
// are here too, for the owner and office manager.
const TABS = [['overview', 'Overview', Star], ['feedback', 'Private feedback', Inbox], ['shoutouts', 'Shout-outs', Trophy], ['settings', 'Settings', SettingsIcon]];
const stars = (n) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '—');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const thisMonth = () => new Date().toISOString().slice(0, 7);
const SOURCES = { chart: 'Chart', patient_bar: 'Patient bar', checkout: 'Checkout', command: 'Command bar', schedule: 'Schedule', reviews: 'This page', auto: 'Automatic' };

export default function ReviewsDashboard() {
  const { can } = useAuth();
  const manage = can('reviews:manage');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overview';
  const setTab = (k) => setParams(k === 'overview' ? {} : { tab: k }, { replace: true });
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Reviews &amp; feedback</h1>
          <div className="muted">Everyone rates first. Happy patients are invited to post a review; anyone less than happy can tell you privately — and everyone can still post publicly. <Link to="/reputation">Google reviews →</Link></div>
        </div>
      </div>
      <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.filter(([k]) => manage || (k !== 'feedback' && k !== 'settings')).map(([k, l, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}><Icon size={15} aria-hidden /> {l}</button>
        ))}
      </div>
      {tab === 'overview' && <Overview onTab={setTab} />}
      {tab === 'feedback' && manage && <FeedbackInbox />}
      {tab === 'shoutouts' && <Shoutouts manage={manage} />}
      {tab === 'settings' && manage && <ReviewSettings />}
    </>
  );
}

function Overview({ onTab }) {
  const [month, setMonth] = useState(thisMonth());
  const to = month === thisMonth() ? new Date().toISOString().slice(0, 10) : `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
  const { data: o, error } = useApi(`/reviews/overview?from=${month}-01&to=${to}`);
  const { data: board } = useApi(`/reviews/leaderboard?month=${month}`);
  if (error) return <ErrorBox error={error} />;
  if (!o) return <div className="empty">Loading…</div>;
  const f = o.funnel;
  const steps = [['Sent', f.sent, null], ['Opened', f.opened, f.sent], ['Rated', f.rated, f.sent], ['Went to post a review', f.posted_click, f.rated], ['Private feedback', f.feedback, f.unhappy]];
  return (
    <>
      <div className="inline" style={{ gap: 8, marginBottom: 10 }}>
        <label className="inline" style={{ gap: 6 }}>Month <input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        {!o.review_url && <span className="alert-chip">Add your Google review link in Settings so happy patients have somewhere to post</span>}
      </div>
      <div className="stat-strip">
        <div><strong><Star size={16} aria-hidden /> {o.average ?? '—'}</strong><span>average rating on the review screen ({f.rated})</span></div>
        <div><strong>{o.online.average ?? '—'}</strong><span>Google rating ({o.online.count} reviews)</span></div>
        <div><strong>{f.happy}</strong><span>happy ({o.threshold}★ or more)</span></div>
        <div><strong className={f.unhappy ? 'text-danger' : ''}>{f.unhappy}</strong><span>less than happy</span></div>
        {o.inbox && <div><button className="link" onClick={() => onTab('feedback')}><strong className={o.inbox.new ? 'text-danger' : ''}>{o.inbox.new}</strong></button><span>new private feedback</span></div>}
      </div>
      <section className="card">
        <h2>Requests funnel</h2>
        <div className="rv-funnel" role="list">
          {steps.map(([label, n, of]) => (
            <div key={label} className="rv-step" role="listitem">
              <div className="rv-bar" style={{ width: `${f.sent ? Math.max(4, Math.round((n / f.sent) * 100)) : 4}%` }} />
              <span className="rv-step-label">{label}</span>
              <strong>{n}</strong>{of != null && <span className="muted"> · {pct(n, of)}</span>}
            </div>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          {f.queued > 0 && <>{f.queued} waiting for sending hours · </>}{f.not_sent > 0 && <>{f.not_sent} couldn’t be sent (opted out or failed — see Needs attention) · </>}
          Asked from: {Object.entries(o.by_source).map(([k, n]) => `${SOURCES[k] || k} ${n}`).join(', ') || 'nowhere yet'}
        </div>
      </section>
      <div className="rv-two">
        <section className="card">
          <h2>Ratings</h2>
          {o.by_stars.map((b) => (
            <div key={b.stars} className="rv-starrow"><span className="rv-stars-sm">{stars(b.stars)}</span><div className="rv-bar" style={{ width: `${f.rated ? Math.round((b.count / f.rated) * 100) : 0}%` }} /><span>{b.count}</span></div>
          ))}
        </section>
        <section className="card">
          <h2><Trophy size={16} aria-hidden /> Shout-outs this month</h2>
          {board?.rows?.length ? (
            <ol className="rv-board">{board.rows.slice(0, 5).map((r) => <li key={r.user_id}><strong>{r.name}</strong> <span className="muted">{r.points} pts · {r.mentions} mention{r.mentions === 1 ? '' : 's'}</span></li>)}</ol>
          ) : <p className="muted">No one named yet this month.</p>}
          <button className="link" onClick={() => onTab('shoutouts')}>See all shout-outs →</button>
        </section>
      </div>
    </>
  );
}

function FeedbackInbox() {
  const [status, setStatus] = useState('open');
  const { data, reload, error } = useApi(`/reviews/feedback?status=${status}`);
  const [notes, setNotes] = useState({});
  const move = async (row, to) => {
    try {
      await api.patch(`/reviews/feedback/${row.id}`, { status: to, note: notes[row.id] || undefined });
      toast(to === 'resolved' ? `Marked resolved — the follow-up task is done too` : `Marked ${to}`, { undo: async () => { await api.patch(`/reviews/feedback/${row.id}`, { status: row.feedback_status }); reload(); } });
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  return (
    <>
      <div className="tabs" style={{ marginBottom: 10 }}>
        {[['open', 'Open'], ['new', 'New'], ['contacted', 'Contacted'], ['resolved', 'Resolved'], ['all', 'All']].map(([k, l]) => <button key={k} className={status === k ? 'active' : ''} onClick={() => setStatus(k)}>{l}</button>)}
      </div>
      <ErrorBox error={error} />
      {!data ? <div className="empty">Loading…</div> : !data.length ? <div className="card empty"><MessageCircleHeart size={18} aria-hidden /> Nothing here — no one is waiting on a call back.</div> : data.map((r) => (
        <div key={r.id} className={`card rv-fb rv-fb-${r.feedback_status}`}>
          <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <Link to={`/patients/${r.patient_id}`}><strong>{r.first_name} {r.last_name}</strong></Link> <span className="rv-stars-sm">{stars(r.rating)}</span>
              {r.callback_wanted ? <span className="alert-chip" style={{ marginLeft: 6 }}>Wants a call back{r.callback_note ? `: ${r.callback_note}` : ''}</span> : null}
              <div className="muted" style={{ fontSize: 12 }}>{fmtDate((r.feedback_at || r.rated_at || r.sent_at).slice(0, 10))}{r.phone ? ` · ${r.phone}` : ''}{r.posted_click_at ? ' · also opened the public review link' : ''}</div>
            </div>
            <span className={`badge ${r.feedback_status === 'resolved' ? 'ok' : r.feedback_status === 'new' ? 'danger' : ''}`}>{r.feedback_status}</span>
          </div>
          <p className="rv-quote">{r.comment ? `“${r.comment}”` : <span className="muted">No comment yet — they rated {r.rating}★.</span>}</p>
          {r.resolution_note && <div className="muted" style={{ fontSize: 13 }}>Note: {r.resolution_note}{r.status_by_name ? ` — ${r.status_by_name}` : ''}</div>}
          <div className="inline" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <input placeholder="What happened? (optional note)" value={notes[r.id] || ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} style={{ flex: 1, minWidth: 200 }} aria-label={`Note for ${r.first_name}`} />
            {r.feedback_status === 'new' && <button onClick={() => move(r, 'contacted')}>Contacted</button>}
            {r.feedback_status !== 'resolved' && <button className="primary" onClick={() => move(r, 'resolved')}>Resolved</button>}
            {r.feedback_status === 'resolved' && <button onClick={() => move(r, 'contacted')}>Reopen</button>}
          </div>
        </div>
      ))}
    </>
  );
}

function Shoutouts({ manage }) {
  const [month, setMonth] = useState(thisMonth());
  const { data: board, reload: reloadBoard } = useApi(`/reviews/leaderboard?month=${month}`);
  const { data: list, reload, error } = useApi(`/reviews/shoutouts?month=${month}`);
  const { data: unclear, reload: reloadUnclear } = useApi(manage ? '/reviews/shoutouts?status=needs_match' : null);
  const [reward, setReward] = useState({});
  const refresh = () => { reload(); reloadBoard(); reloadUnclear(); };
  const act = async (fn, msg) => { try { await fn(); toast(msg); refresh(); } catch (e) { toast(e.message, { tone: 'error' }); } };
  // Unlinking asks why, in place (no dialog); the shout-out stays on record with the reason.
  const [why, setWhy] = useState({ id: null, text: '' });
  const unlink = (s) => setWhy({ id: s.id, text: '' });
  const whyBox = (s) => why.id === s.id && (
    <form className="inline" style={{ gap: 6, marginTop: 4 }} onSubmit={(e) => { e.preventDefault(); if (why.text.trim()) act(() => api.post(`/reviews/shoutouts/${s.id}/unlink`, { reason: why.text }), 'Unlinked — the points are off the board').then(() => setWhy({ id: null, text: '' })); }}>
      <input autoFocus value={why.text} placeholder={`Why isn’t this ${s.user_name || s.matched_name}? (kept on record)`} onChange={(e) => setWhy({ id: s.id, text: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && setWhy({ id: null, text: '' })} style={{ flex: 1 }} aria-label="Why unlink" />
      <button className="small" disabled={!why.text.trim()}>Unlink</button>
    </form>
  );
  return (
    <>
      <div className="inline" style={{ gap: 8, marginBottom: 10 }}>
        <label className="inline" style={{ gap: 6 }}>Month <input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        {board && <span className="muted">{board.points_per_mention} points per mention{board.reward_note ? ` · ${board.reward_note}` : ''}</span>}
      </div>
      <ErrorBox error={error} />
      {manage && unclear?.length > 0 && (
        <section className="card rv-unclear">
          <h2>Which one did they mean?</h2>
          {unclear.map((s) => (
            <div key={s.id} className="rv-so">
              <p className="rv-quote">“{s.quote}”</p>
              <div className="inline" style={{ gap: 6, flexWrap: 'wrap' }}>
                <span className="muted">“{s.matched_name}” could be:</span>
                {s.candidates.map((c) => <button key={c.id} onClick={() => act(() => api.post(`/reviews/shoutouts/${s.id}/confirm`, { user_id: c.id }), `Counted for ${c.name}`)}>{c.name}</button>)}
                <button className="link" onClick={() => unlink(s)}>None of them</button>
              </div>
              {whyBox(s)}
            </div>
          ))}
        </section>
      )}
      <section className="card">
        <h2><Trophy size={16} aria-hidden /> Leaderboard</h2>
        {!board ? <div className="empty">Loading…</div> : !board.rows.length ? <p className="muted">No shout-outs yet this month. Names in happy feedback and Google reviews show up here.</p> : (
          <table className="compact-table">
            <thead><tr><th>#</th><th>Team member</th><th className="num">Points</th><th className="num">Mentions</th><th>Reward</th></tr></thead>
            <tbody>
              {board.rows.map((r, i) => (
                <tr key={r.user_id}>
                  <td>{i + 1}</td><td><strong>{r.name}</strong></td><td className="num">{r.points}</td><td className="num">{r.mentions}</td>
                  <td>{manage ? (
                    <form className="inline" style={{ gap: 4 }} onSubmit={(e) => { e.preventDefault(); act(() => api.put('/reviews/rewards', { user_id: r.user_id, month, note: reward[r.user_id] ?? r.reward }), 'Reward noted'); }}>
                      <input value={reward[r.user_id] ?? r.reward ?? ''} placeholder="e.g. $25 coffee card" onChange={(e) => setReward({ ...reward, [r.user_id]: e.target.value })} aria-label={`Reward for ${r.name}`} />
                      <button className="small">Save</button>
                    </form>
                  ) : r.reward || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>What patients said</h2>
        {!list ? <div className="empty">Loading…</div> : !list.length ? <p className="muted">Nothing this month yet.</p> : list.map((s) => (
          <div key={s.id} className={`rv-so${s.status === 'unlinked' ? ' rv-unlinked' : ''}${!s.positive ? ' rv-concern' : ''}`}>
            <div className="inline" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span><strong>{s.user_name || `“${s.matched_name}” (unclear)`}</strong> <span className="muted">· {s.source === 'review' ? 'Google review' : 'Review screen'}{s.rating ? ` · ${stars(s.rating)}` : ''}{s.patient_name ? ` · ${s.patient_name}` : ''}</span></span>
              <span className="muted">{s.status === 'unlinked' ? `Unlinked: ${s.decision_note}` : !s.positive ? 'Named in a low rating — for coaching, no points' : s.status === 'needs_match' ? 'Needs a match' : `+${s.points}`}</span>
            </div>
            <p className="rv-quote">“{s.quote}”</p>
            {manage && s.status === 'counted' && <button className="link small" onClick={() => unlink(s)}>Not them? Unlink</button>}
            {whyBox(s)}
          </div>
        ))}
      </section>
    </>
  );
}

function ReviewSettings() {
  const { data: s, reload, error } = useApi('/reviews/settings');
  const users = useLookup('/users');
  const { data: nicks, reload: reloadNicks } = useApi('/reviews/nicknames');
  const [form, setForm] = useState(null);
  const [nick, setNick] = useState({ user_id: '', nickname: '' });
  if (error) return <ErrorBox error={error} />;
  if (!s) return <div className="empty">Loading…</div>;
  const f = form || { ...s, other_sites: s.other_sites.length ? s.other_sites : [] };
  const set = (patch) => setForm({ ...f, ...patch });
  const team = users.filter((u) => u.active);
  const save = async (e) => {
    e.preventDefault();
    try {
      await api.put('/reviews/settings', {
        throttle_months: Number(f.throttle_months), channel: f.channel, threshold: Number(f.threshold), auto_after_visit: !!f.auto_after_visit, review_url: f.review_url || null,
        other_sites: f.other_sites.filter((x) => x.name || x.url), notify_user_ids: f.notify_user_ids, followup_user_id: f.followup_user_id || null,
        points_per_mention: Number(f.points_per_mention), reward_note: f.reward_note || null,
      });
      setForm(null);
      toast('Review settings saved');
      reload();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  };
  const addNick = async (e) => {
    e.preventDefault();
    try { await api.post('/reviews/nicknames', { user_id: Number(nick.user_id), nickname: nick.nickname }); setNick({ user_id: nick.user_id, nickname: '' }); reloadNicks(); } catch (err) { toast(err.message, { tone: 'error' }); }
  };
  return (
    <>
      <form className="card rv-settings" onSubmit={save}>
        <h2>Asking for reviews</h2>
        <label>Google review link<input value={f.review_url || ''} placeholder="https://g.page/r/…/review" onChange={(e) => set({ review_url: e.target.value })} /></label>
        <label>Ask the same patient at most once every<span className="inline" style={{ gap: 6 }}><input type="number" min={1} max={24} value={f.throttle_months} onChange={(e) => set({ throttle_months: e.target.value })} style={{ width: 80 }} /> months</span></label>
        <label>Send by<select value={f.channel} onChange={(e) => set({ channel: e.target.value })}><option value="auto">Their usual (text, else email)</option><option value="sms">Text</option><option value="email">Email</option></select></label>
        <label>Happy from<select value={f.threshold} onChange={(e) => set({ threshold: Number(e.target.value) })}>{[5, 4, 3].map((n) => <option key={n} value={n}>{n} stars and up</option>)}</select></label>
        <label className="checkbox"><input type="checkbox" checked={!!f.auto_after_visit} onChange={(e) => set({ auto_after_visit: e.target.checked })} /> Ask automatically after each completed visit (within sending hours)</label>
        <div className="rv-note">Everyone sees a small “you can also post a public review” link, whatever they rate. That isn’t a setting: Google doesn’t allow offering reviews only to happy patients, and the FTC doesn’t allow hiding negative ones.</div>
        <h3>Other review sites happy patients can pick</h3>
        {f.other_sites.map((x, i) => (
          <div key={i} className="inline" style={{ gap: 6, marginBottom: 6 }}>
            <input value={x.name} placeholder="Yelp" aria-label="Site name" onChange={(e) => set({ other_sites: f.other_sites.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) })} style={{ width: 140 }} />
            <input value={x.url} placeholder="https://…" aria-label="Site address" onChange={(e) => set({ other_sites: f.other_sites.map((y, j) => (j === i ? { ...y, url: e.target.value } : y)) })} style={{ flex: 1 }} />
            <button type="button" className="small" onClick={() => set({ other_sites: f.other_sites.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        {f.other_sites.length < 5 && <button type="button" className="small" onClick={() => set({ other_sites: [...f.other_sites, { name: '', url: '' }] })}>+ Add a site</button>}

        <h3>Private feedback</h3>
        <div className="muted" style={{ fontSize: 13 }}>Told at once (team chat “Patient feedback” and on screen): {s.recipients.map((u) => u.name).join(', ') || 'nobody yet'}{!s.notify_user_ids.length ? ' (administrators and anyone with “Reviews: manage”)' : ''}.</div>
        <fieldset className="rv-people"><legend>Tell these people (leave all unticked for the default)</legend>
          {team.map((u) => (
            <label key={u.id} className="checkbox"><input type="checkbox" checked={f.notify_user_ids.includes(u.id)} onChange={(e) => set({ notify_user_ids: e.target.checked ? [...f.notify_user_ids, u.id] : f.notify_user_ids.filter((x) => x !== u.id) })} /> {u.name}</label>
          ))}
        </fieldset>
        <label>Follow-up task goes to<select value={f.followup_user_id || ''} onChange={(e) => set({ followup_user_id: e.target.value ? Number(e.target.value) : null })}><option value="">Anyone (the office’s list)</option>{team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>

        <h3>Team shout-outs</h3>
        <label>Points per mention<input type="number" min={0} max={1000} value={f.points_per_mention} onChange={(e) => set({ points_per_mention: e.target.value })} style={{ width: 100 }} /></label>
        <label>Reward (shown on the leaderboard)<input value={f.reward_note || ''} placeholder="Top of the month picks the team lunch" onChange={(e) => set({ reward_note: e.target.value })} /></label>
        <div className="form-actions"><button className="primary" disabled={!form}>Save</button>{form && <button type="button" onClick={() => setForm(null)}>Cancel</button>}</div>
      </form>

      <section className="card">
        <h2>Nicknames</h2>
        <p className="muted" style={{ fontSize: 13 }}>Patients often use a nickname (“Annie”, “Dr. Bob”). Add them so shout-outs find the right person. First names and “Dr. Lastname” are matched already.</p>
        <table className="compact-table"><tbody>
          {(nicks || []).map((n) => (
            <tr key={n.id}><td>{n.nickname}</td><td>{n.name}</td><td><button className="link small" onClick={async () => { try { await api.del(`/reviews/nicknames/${n.id}`); reloadNicks(); } catch (err) { toast(err.message, { tone: 'error' }); } }}>Remove</button></td></tr>
          ))}
        </tbody></table>
        <form className="inline" style={{ gap: 6, marginTop: 8 }} onSubmit={addNick}>
          <select value={nick.user_id} onChange={(e) => setNick({ ...nick, user_id: e.target.value })} required aria-label="Team member"><option value="">Team member…</option>{team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <input value={nick.nickname} placeholder="Nickname" onChange={(e) => setNick({ ...nick, nickname: e.target.value })} required aria-label="Nickname" />
          <button>Add</button>
          <button type="button" className="link" onClick={async () => { try { const r = await api.post('/reviews/shoutouts/rescan'); toast(`Checked again — ${r.found} new shout-out${r.found === 1 ? '' : 's'}`); } catch (err) { toast(err.message, { tone: 'error' }); } }}>Check past feedback again</button>
        </form>
      </section>
    </>
  );
}
