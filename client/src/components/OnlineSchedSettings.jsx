import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money } from '../format.js';
import { toast } from '../toast.js';
import { ErrorBox } from './ui.jsx';

// Settings → Online booking (OS1–OS5): the website button and links, what patients can book (visit types with
// their rules and questions), how the page looks, who hears about bookings, and how the page converts.
// Administrators change it; everyone on the schedule can see it.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STEP_LABELS = { view: 'Opened the page', office: 'Chose an office', reason: 'Chose a visit', time: 'Chose a time', details: 'Filled in details', booked: 'Booked', requested: 'Requested', taken: 'Time was just taken' };
const RULES = [['never', 'Never'], ['new_patients', 'New patients'], ['risky_slots', 'No-show-prone times'], ['always', 'Always']];
const copy = async (text) => {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select the text and copy it', { tone: 'error' }); }
};

function Snippet({ label, value }) {
  return (
    <label className="full" style={{ display: 'block', marginTop: 10 }}>{label}
      <div className="inline" style={{ gap: 6, alignItems: 'flex-start' }}>
        <textarea readOnly rows={value.length > 90 ? 3 : 1} value={value} onFocus={(e) => e.target.select()} style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }} />
        <button type="button" className="small" onClick={() => copy(value)}>Copy</button>
      </div>
    </label>
  );
}

function Questions({ value, onChange, disabled }) {
  const set = (i, patch) => onChange(value.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  return (
    <div className="os-questions">
      {value.map((q, i) => (
        <div key={i} className="inline" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          <input aria-label="Question" style={{ flex: '2 1 260px' }} value={q.label} disabled={disabled} onChange={(e) => set(i, { label: e.target.value, key: q.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || `q${i + 1}` })} />
          <select aria-label="Answer type" value={q.type} disabled={disabled} onChange={(e) => set(i, { type: e.target.value, urgent_if: undefined })}>
            <option value="yesno">Yes / no</option><option value="scale">0–10</option><option value="choice">Choices</option><option value="text">Short text</option>
          </select>
          {q.type === 'choice' && <input aria-label="Choices, comma separated" placeholder="Choices, comma separated" value={(q.options || []).join(', ')} disabled={disabled} onChange={(e) => set(i, { options: e.target.value.split(',').map((s) => s.trim()) })} />}
          <label className="checkbox"><input type="checkbox" checked={!!q.required} disabled={disabled} onChange={(e) => set(i, { required: e.target.checked })} /> Required</label>
          {q.type === 'yesno' && <label className="checkbox"><input type="checkbox" checked={q.urgent_if?.eq === true} disabled={disabled} onChange={(e) => set(i, { urgent_if: e.target.checked ? { eq: true } : undefined })} /> “Yes” is urgent</label>}
          {q.type === 'scale' && <label className="inline" style={{ gap: 4 }}>Urgent at<input type="number" min="0" max="10" style={{ width: 60 }} value={q.urgent_if?.gte ?? ''} disabled={disabled} onChange={(e) => set(i, { urgent_if: e.target.value === '' ? undefined : { gte: Number(e.target.value) } })} />+</label>}
          {!disabled && <button type="button" className="small" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove question">×</button>}
        </div>
      ))}
      {!disabled && value.length < 8 && <button type="button" className="small" onClick={() => onChange([...value, { key: `q${value.length + 1}`, label: '', type: 'yesno', required: false }])}>+ Question</button>}
    </div>
  );
}

function VisitType({ vt, data, admin, onSaved }) {
  const [row, setRow] = useState(vt);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setRow(vt), [vt]);
  const set = (k) => (e) => setRow({ ...row, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const toggle = (k, id) => setRow({ ...row, [k]: row[k].includes(id) ? row[k].filter((x) => x !== id) : [...row[k], id] });
  const save = async () => {
    setErr(null);
    const body = {
      label: row.label, label_es: row.label_es || null, blurb: row.blurb || null, blurb_es: row.blurb_es || null, kind: row.kind, appointment_type_id: row.appointment_type_id ? Number(row.appointment_type_id) : null,
      duration: Number(row.duration), lead_minutes: Number(row.lead_minutes), max_days: Number(row.max_days), buffer_minutes: Number(row.buffer_minutes || 0),
      booking_mode: row.booking_mode, who: row.who, family: !!row.family, active: !!row.active, provider_ids: row.provider_ids, location_ids: row.location_ids,
      deposit: Math.round(Number(row.deposit_dollars ?? row.deposit / 100) * 100) || 0, deposit_rule: row.deposit_rule, card_rule: row.card_rule,
      questions: row.questions.filter((q) => q.label),
    };
    try {
      if (vt.id) await api.put(`/online-scheduling/visit-types/${vt.id}`, body);
      else await api.post('/online-scheduling/visit-types', body);
      toast(`Saved “${row.label}”`);
      onSaved();
    } catch (e) {
      setErr(e);
    }
  };
  const off = !admin;
  return (
    <div className="os-vt" style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
      <div className="inline" style={{ gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          <strong>{row.label || 'New visit type'}</strong> <span className="muted">· {row.duration} min · {row.booking_mode === 'request' ? 'office approves' : 'books instantly'} · {row.who === 'anyone' ? 'anyone' : `${row.who} patients`}{row.active ? '' : ' · off'}</span>
        </button>
        {!open && <span className="muted" style={{ fontSize: 12 }}>{data.kinds.find((k) => k.key === row.kind)?.label}</span>}
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <ErrorBox error={err} />
          <div className="form-grid">
            <label>Name patients see<input value={row.label} disabled={off} onChange={set('label')} /></label>
            <label>In Spanish<input value={row.label_es || ''} disabled={off} onChange={set('label_es')} /></label>
            <label className="full">One line about it<input value={row.blurb || ''} disabled={off} onChange={set('blurb')} /></label>
            <label>Kind
              <select value={row.kind} disabled={off} onChange={set('kind')}>{data.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select>
            </label>
            <label>Appointment type on the schedule
              <select value={row.appointment_type_id || ''} disabled={off} onChange={set('appointment_type_id')}>
                <option value="">—</option>
                {data.appointment_types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.duration} min)</option>)}
              </select>
            </label>
            <label>Length (minutes)<input type="number" min="10" step="10" value={row.duration} disabled={off} onChange={set('duration')} /></label>
            <label>Buffer after (minutes)<input type="number" min="0" max="60" step="5" value={row.buffer_minutes || 0} disabled={off} onChange={set('buffer_minutes')} /></label>
            <label>Earliest: minutes from now<input type="number" min="0" step="15" value={row.lead_minutes} disabled={off} onChange={set('lead_minutes')} /></label>
            <label>How far ahead (days)<input type="number" min="1" max="365" value={row.max_days} disabled={off} onChange={set('max_days')} /></label>
            <label>When booked
              <select value={row.booking_mode} disabled={off} onChange={set('booking_mode')}><option value="instant">Straight onto the schedule</option><option value="request">Request — the office accepts it</option></select>
            </label>
            <label>Who can book
              <select value={row.who} disabled={off} onChange={set('who')}><option value="anyone">Anyone</option><option value="new">New patients</option><option value="existing">Current patients (others wait as a request)</option></select>
            </label>
            <label>Deposit ($)<input type="number" min="0" step="1" value={row.deposit_dollars ?? (row.deposit || 0) / 100} disabled={off} onChange={(e) => setRow({ ...row, deposit_dollars: e.target.value })} /></label>
            <label>Ask for the deposit
              <select value={row.deposit_rule} disabled={off} onChange={set('deposit_rule')}>{RULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
            <label>Card on file
              <select value={row.card_rule} disabled={off} onChange={set('card_rule')}>{RULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
            <label className="checkbox"><input type="checkbox" checked={!!row.family} disabled={off} onChange={set('family')} /> Families can book together (back-to-back)</label>
            <label className="checkbox"><input type="checkbox" checked={!!row.active} disabled={off} onChange={set('active')} /> Offered online</label>
          </div>
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12 }}>Providers (none ticked: everyone who fits the appointment type)</div>
            <div className="inline" style={{ gap: 6, flexWrap: 'wrap' }}>
              {data.providers.map((p) => <button key={p.id} type="button" disabled={off} className={`chip${row.provider_ids.includes(p.id) ? ' active' : ''}`} aria-pressed={row.provider_ids.includes(p.id)} onClick={() => toggle('provider_ids', p.id)}>{p.name}</button>)}
            </div>
          </div>
          {data.locations.length > 1 && (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 12 }}>Offices (none ticked: all)</div>
              <div className="inline" style={{ gap: 6, flexWrap: 'wrap' }}>
                {data.locations.map((l) => <button key={l.id} type="button" disabled={off} className={`chip${row.location_ids.includes(l.id) ? ' active' : ''}`} aria-pressed={row.location_ids.includes(l.id)} onClick={() => toggle('location_ids', l.id)}>{l.name}</button>)}
              </div>
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12 }}>Questions before the visit{row.kind === 'emergency' ? ' (triage: an answer past its line marks the booking urgent and calls the front desk)' : ''}</div>
            <Questions value={row.questions} disabled={off} onChange={(questions) => setRow({ ...row, questions })} />
            {row.kind === 'emergency' && !off && !row.questions.length && <button type="button" className="small" onClick={() => setRow({ ...row, questions: data.triage_template })}>Use the standard triage questions</button>}
          </div>
          {row.kind === 'emergency' && <p className="muted" style={{ fontSize: 12 }}>Hold same-day emergency time with a perfect-day block (Settings → Perfect day) or a reserved block on the schedule kept for this visit’s appointment type; online, only emergencies can take it until it’s released.</p>}
          {admin && <div className="form-actions"><button type="button" className="primary" onClick={save}>Save</button></div>}
        </div>
      )}
    </div>
  );
}

function Analytics() {
  const { data, error } = useApi('/online-scheduling/analytics');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const max = Math.max(1, ...data.steps.map((s) => s.sessions));
  return (
    <div>
      <p className="muted" style={{ fontSize: 12 }}>Last 30 days. Counts of page visits only — no names or contact details are kept for this.</p>
      <div className="inline" style={{ gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
        <div><div className="muted" style={{ fontSize: 12 }}>Conversion</div><strong style={{ fontSize: 20 }}>{data.conversion == null ? '—' : `${data.conversion}%`}</strong></div>
        <div><div className="muted" style={{ fontSize: 12 }}>Visits booked</div><strong style={{ fontSize: 20 }}>{data.visits_booked}</strong></div>
        <div><div className="muted" style={{ fontSize: 12 }}>$ scheduled</div><strong style={{ fontSize: 20 }}>{money(data.scheduled_cents)}</strong></div>
        <div><div className="muted" style={{ fontSize: 12 }}>Bots stopped</div><strong style={{ fontSize: 20 }}>{data.bots_blocked}</strong></div>
      </div>
      <table className="compact">
        <tbody>
          {data.steps.filter((s) => s.step !== 'office' || s.sessions).map((s) => (
            <tr key={s.step}>
              <td style={{ width: 170 }}>{STEP_LABELS[s.step] || s.step}</td>
              <td><div style={{ background: 'var(--primary)', height: 10, borderRadius: 4, width: `${Math.round((s.sessions / max) * 100)}%`, minWidth: s.sessions ? 4 : 0 }} /></td>
              <td style={{ width: 50, textAlign: 'right' }}>{s.sessions}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.by_source.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, margin: '12px 0 4px' }}>By source</h3>
          <table className="compact">
            <thead><tr><th>Source</th><th>Visits</th><th>Bookings</th><th>Conversion</th></tr></thead>
            <tbody>{data.by_source.map((s) => <tr key={s.source}><td>{s.source}</td><td>{s.views}</td><td>{s.bookings}</td><td>{s.conversion == null ? '—' : `${s.conversion}%`}</td></tr>)}</tbody>
          </table>
        </>
      )}
      {data.by_variant.length > 1 && (
        <p className="muted" style={{ fontSize: 12 }}>Headline test: {data.by_variant.map((v) => `${v.variant.toUpperCase()} ${v.conversion ?? 0}% (${v.bookings}/${v.views})`).join(' · ')} — only the headline changes; times, prices and questions are the same for everyone.</p>
      )}
    </div>
  );
}

export default function OnlineSchedSettings() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const { data, error, reload } = useApi('/online-scheduling/settings');
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (data) setS({ ...data.settings, embed_origins: data.settings.embed_origins.join(', ') }); }, [data]);
  if (error) return <div className="card"><ErrorBox error={error} /></div>;
  if (!data || !s) return <div className="card"><p className="muted">Loading…</p></div>;
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const saveSettings = async (patch = null) => {
    setErr(null);
    try {
      await api.put('/online-scheduling/settings', patch || {
        brand_color: s.brand_color || null, headline: s.headline || null, headline_es: s.headline_es || null, notify_chat: !!s.notify_chat, notify_sms_to: s.notify_sms_to || null,
        family_max: Number(s.family_max), embed_origins: s.embed_origins, risky_weekdays: s.risky_weekdays, risky_before: s.risky_before || null, risky_after: s.risky_after || null,
      });
      toast('Online booking settings saved');
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const logo = async (file) => {
    if (!file) return;
    if (file.size > 200_000) { setErr(new Error('The logo is too large (200 KB at most) — use a smaller picture')); return; }
    const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
    await saveSettings({ logo: url });
  };
  const links = data.links;
  const blank = { id: null, label: '', kind: 'other', duration: 60, lead_minutes: 120, max_days: 60, buffer_minutes: 0, booking_mode: 'instant', who: 'anyone', family: 0, active: 1, provider_ids: [], location_ids: [], questions: [], deposit: 0, deposit_rule: 'never', card_rule: 'never' };

  return (
    <>
      {!data.online_booking && <div className="card"><p className="muted">Online booking is off. Turn it on and choose your booking address in Settings → Practice & security.</p></div>}
      {links && (
        <div className="card">
          <h2>On your website</h2>
          <p className="muted" style={{ fontSize: 13 }}>Paste one line before &lt;/body&gt; on your site: a “Book online” button opens booking in a window over your page. Any link or button with <code>data-dm-book</code> opens it too (<code>data-dm-book="emergency"</code> starts on emergencies). Every booking records where it came from, including UTM tags on your ads.</p>
          <Snippet label="Button (recommended)" value={links.script} />
          <Snippet label="Or put the booking page inside a page (iframe)" value={links.iframe} />
          <Snippet label="Google Business Profile → Bookings / appointment link" value={links.google} />
          <p className="muted" style={{ fontSize: 12 }}>Google shows a “Book” button with this link. (“Reserve with Google” booking inside Google itself is only available through Google-approved scheduling partners.)</p>
          <div className="form-grid">
            <Snippet label="Facebook" value={links.facebook} />
            <Snippet label="Instagram" value={links.instagram} />
          </div>
          <label style={{ display: 'block', marginTop: 10 }}>Websites allowed to show the booking page inside them (optional; empty = any)
            <input value={s.embed_origins} disabled={!admin} onChange={set('embed_origins')} placeholder="https://www.yourpractice.com" />
          </label>
        </div>
      )}

      <div className="card">
        <h2>What patients can book</h2>
        <p className="muted" style={{ fontSize: 13 }}>Open times always come from the schedule: provider hours, visits, blockouts, reserved and perfect-day blocks, a free chair. Existing patients are matched by name, birth date and phone or email — near misses are flagged, never merged.</p>
        {data.visit_types.map((vt) => <VisitType key={vt.id} vt={vt} data={data} admin={admin} onSaved={reload} />)}
        {admin && (adding
          ? <VisitType vt={blank} data={data} admin={admin} onSaved={() => { setAdding(false); reload(); }} />
          : <button type="button" className="small" onClick={() => setAdding(true)}>+ Visit type</button>)}
      </div>

      <div className="card">
        <h2>Look, alerts and no-show-prone times</h2>
        <ErrorBox error={err} />
        <div className="form-grid">
          <label>Brand color<input type="color" value={s.brand_color || '#0d9488'} disabled={!admin} onChange={set('brand_color')} /></label>
          <label>Logo (PNG or JPEG, up to 200 KB){s.has_logo && ' — set'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!admin} onChange={(e) => logo(e.target.files?.[0])} /></label>
          <label>Headline (optional)<input value={s.headline || ''} disabled={!admin} onChange={set('headline')} placeholder="Book your visit online" /></label>
          <label>Headline in Spanish<input value={s.headline_es || ''} disabled={!admin} onChange={set('headline_es')} /></label>
          <label className="checkbox"><input type="checkbox" checked={!!s.notify_chat} disabled={!admin} onChange={set('notify_chat')} /> Post each booking in the Front desk chat channel</label>
          <label>Also text the office at (no names in the text)<input type="tel" value={s.notify_sms_to || ''} disabled={!admin} onChange={set('notify_sms_to')} placeholder="(512) 555-0100" /></label>
          <label>Family bookings: up to<input type="number" min="1" max="6" value={s.family_max} disabled={!admin} onChange={set('family_max')} /></label>
          <div className="full">
            <div className="muted" style={{ fontSize: 12 }}>No-show-prone times (for deposits / card on file set to “No-show-prone times”)</div>
            <div className="inline" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {DAYS.map((d, i) => <button key={d} type="button" disabled={!admin} className={`chip${s.risky_weekdays.includes(i) ? ' active' : ''}`} aria-pressed={s.risky_weekdays.includes(i)} onClick={() => setS({ ...s, risky_weekdays: s.risky_weekdays.includes(i) ? s.risky_weekdays.filter((x) => x !== i) : [...s.risky_weekdays, i] })}>{d}</button>)}
              <label className="inline" style={{ gap: 4 }}>before<input type="time" value={s.risky_before || ''} disabled={!admin} onChange={set('risky_before')} /></label>
              <label className="inline" style={{ gap: 4 }}>from<input type="time" value={s.risky_after || ''} disabled={!admin} onChange={set('risky_after')} /></label>
            </div>
          </div>
        </div>
        {admin && <div className="form-actions"><button type="button" className="primary" onClick={() => saveSettings()}>Save</button></div>}
        <p className="muted" style={{ fontSize: 12 }}>Everyone on the schedule gets an alert (and a soft sound — each person can turn it off in Online requests → Online bookings).</p>
      </div>

      <div className="card">
        <h2>How the booking page is doing</h2>
        <Analytics />
      </div>
    </>
  );
}
