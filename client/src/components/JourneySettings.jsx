import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { toast, undoable } from '../toast.js';
import { ErrorBox, useSubmit, ConfirmButton } from './ui.jsx';
import { fmtDate } from '../format.js';

// Settings → Patient journeys (PX): the moments that make people feel cared for. Each journey switches on or off
// with one click (undo in the toast), and its wording is edited beside a phone showing exactly what a patient gets.
// Also: what the welcome says about the office, and holiday cards and the newsletter.
const CHANNEL = { text: 'Text', email: 'Email', letter: 'Mailed letter', postcard: 'Mailed postcard' };
const OPTION_LABELS = {
  code_prefixes: 'Procedure codes that get a check-in (start of the code)', evening: 'Send the check-in at', review_after_good: 'Ask for a review when they answer “1” (the review page’s own limits apply)',
  recent_months: 'Only patients seen in the last … months', max_age: 'Kids up to age', vip: 'Also patients marked VIP', years: 'Anniversaries (years)', months: 'Months since the last visit',
  first_visit: 'After a new patient’s first visit', threshold_cents: 'After a treatment day of at least ($)', assign_to: 'Assign the task to', gift: 'The gift', owner_user_id: 'Comments go to',
};

export default function JourneySettings() {
  const { user } = useAuth();
  const admin = user.role === 'admin';
  const { data, error, reload, setData } = useJourneys();
  const [open, setOpen] = useState(null);
  const [tab, setTab] = useState('journeys');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card muted">Loading…</div>;
  const groups = [...new Set(data.journeys.map((j) => j.group))];
  const toggle = async (j) => {
    if (!admin) return;
    const next = !j.enabled;
    const flip = async (v) => {
      const saved = await api.put(`/journeys/${j.key}`, { enabled: v });
      setData((d) => ({ ...d, journeys: d.journeys.map((x) => (x.key === j.key ? { ...x, ...saved } : x)) }));
    };
    await undoable(`${j.name} ${next ? 'is on' : 'is off'}`, () => flip(next), () => flip(!next)).catch(() => {});
  };
  const current = data.journeys.find((j) => j.key === open);

  return (
    <>
      <div className="card">
        <h2>Patient journeys</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Welcomes, thank-yous, birthdays and check-ins that go out on their own — in your words. They respect opt-outs and your sending hours ({data.send_from}–{data.send_until}),
          never say anything clinical, and each goes once. Anything that needs a person (a handwritten card, a call after surgery) becomes a task.
        </p>
        <div className="chips" role="tablist" aria-label="Patient journeys sections">
          {[['journeys', 'Journeys'], ['office', 'About your office'], ['cards', 'Holiday cards & newsletter']].map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`chip${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      </div>
      {tab === 'journeys' && (
        <div className="templates-layout">
          <div>
            {groups.map((g) => (
              <div key={g} className="card">
                <h3 style={{ marginTop: 0 }}>{g}</h3>
                {data.journeys.filter((j) => j.group === g).map((j) => (
                  <div key={j.key} className={`template-row${open === j.key ? ' focused' : ''}`} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 4px', borderTop: '1px solid var(--border, #e5e7eb)' }}>
                    <label className="inline" style={{ gap: 6, minWidth: 64 }}>
                      <input type="checkbox" checked={j.enabled} disabled={!admin} onChange={() => toggle(j)} aria-label={`${j.name}: ${j.enabled ? 'on' : 'off'}`} />
                      <span className={`badge ${j.enabled ? 'active' : 'inactive'}`}>{j.enabled ? 'On' : 'Off'}</span>
                    </label>
                    <div style={{ flex: 1 }}>
                      <button type="button" className="link" style={{ fontWeight: 600 }} onClick={() => setOpen(open === j.key ? null : j.key)} aria-expanded={open === j.key}>{j.name}</button>
                      {j.default_on && <span className="muted" style={{ fontSize: 12 }}> · on by default</span>}
                      <div className="muted" style={{ fontSize: 13 }}>{j.about}</div>
                      {j.engine && <div className="muted" style={{ fontSize: 12 }}>{CHANNEL[j.channel] || j.channel}{j.sent_30d ? ` · ${j.sent_30d} sent in the last 30 days` : ''}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div>
            {current
              ? <JourneyEditor key={current.key} j={current} admin={admin} mail={data.mail} onSaved={(saved) => setData((d) => ({ ...d, journeys: d.journeys.map((x) => (x.key === saved.key ? { ...x, ...saved } : x)) }))} />
              : <div className="card muted" style={{ fontSize: 13 }}>Choose a journey to see what patients get and change the wording.</div>}
          </div>
        </div>
      )}
      {tab === 'office' && <OfficeProfile admin={admin} />}
      {tab === 'cards' && <Broadcasts admin={admin} mail={data.mail} />}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        <button type="button" className="link" onClick={reload}>Refresh</button>
      </div>
    </>
  );
}

function useJourneys() {
  const [state, setState] = useState({ data: null, error: null });
  const load = async () => {
    try {
      setState({ data: await api.get('/journeys'), error: null });
    } catch (error) {
      setState({ data: null, error });
    }
  };
  useEffect(() => { load(); }, []);
  return { ...state, reload: load, setData: (fn) => setState((s) => ({ ...s, data: fn(s.data) })) };
}

function JourneyEditor({ j, admin, mail, onSaved }) {
  const [template, setTemplate] = useState(j.template || '');
  const [subject, setSubject] = useState(j.subject || '');
  const [channel, setChannel] = useState(j.channel);
  const [options, setOptions] = useState(j.options || {});
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState(null);
  const [testTo, setTestTo] = useState('');
  const box = useRef(null);
  const { data: team } = useApi(admin ? '/users' : null);
  const dirty = template !== (j.template || '') || subject !== (j.subject || '') || channel !== j.channel || JSON.stringify(options) !== JSON.stringify(j.options || {});

  // The phone preview follows the wording as it's typed (a pretend patient, nothing saved).
  useEffect(() => {
    if (!j.engine) return undefined;
    const t = setTimeout(() => {
      api.post(`/journeys/${j.key}/preview`, { template, subject, channel }).then((p) => { setPreview(p); setPreviewErr(null); }).catch(setPreviewErr);
    }, 300);
    return () => clearTimeout(t);
  }, [j.key, j.engine, template, subject, channel]);

  const save = useSubmit(async () => {
    const body = { options };
    if (j.engine) Object.assign(body, { template, subject: channel === 'email' ? subject : undefined, channel });
    const saved = await api.put(`/journeys/${j.key}`, body);
    onSaved(saved);
    toast('Saved');
  });
  const sendTest = useSubmit(async () => {
    const r = await api.post(`/journeys/${j.key}/test`, testTo ? { to: testTo } : {});
    toast(`Test sent by ${r.channel === 'sms' ? 'text' : 'email'} to ${r.to}`);
  });
  const insert = (field) => {
    const el = box.current;
    const tag = `{${field}}`;
    if (!el) return setTemplate((t) => `${t}${tag}`);
    const [a, b] = [el.selectionStart ?? template.length, el.selectionEnd ?? template.length];
    setTemplate(`${template.slice(0, a)}${tag}${template.slice(b)}`);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); });
  };
  const optionKeys = Object.keys(j.options || {});

  return (
    <div className="card" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && admin && dirty) { e.preventDefault(); save.submit(); } }}>
      <h3 style={{ marginTop: 0 }}>{j.name}</h3>
      <ErrorBox error={save.error} />
      {j.engine && (
        <>
          {j.channels.length > 1 && (
            <label>Send by
              <select value={channel} disabled={!admin} onChange={(e) => setChannel(e.target.value)}>
                {j.channels.map((c) => <option key={c} value={c} disabled={['letter', 'postcard'].includes(c) && !mail}>{CHANNEL[c]}{['letter', 'postcard'].includes(c) && !mail ? ' (set up mailing first)' : ''}</option>)}
              </select>
            </label>
          )}
          {channel === 'email' && <label>Subject<input value={subject} disabled={!admin} maxLength={200} onChange={(e) => setSubject(e.target.value)} /></label>}
          <label>What it says
            <textarea ref={box} rows={6} value={template} disabled={!admin} maxLength={1500} onChange={(e) => setTemplate(e.target.value)} />
          </label>
          <div className="chips" aria-label="Insert a field">
            {j.fields.map((f) => <button key={f} type="button" className="chip" disabled={!admin} onClick={() => insert(f)}>{`{${f}}`}</button>)}
          </div>
          {j.starter_template && template !== j.starter_template && admin && (
            <button type="button" className="link" style={{ fontSize: 12 }} onClick={() => { setTemplate(j.starter_template); setSubject(j.starter_subject || ''); }}>Back to the starter wording</button>
          )}
        </>
      )}
      {optionKeys.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {optionKeys.map((k) => <OptionField key={k} name={k} value={options[k]} disabled={!admin} team={team} onChange={(v) => setOptions((o) => ({ ...o, [k]: v }))} />)}
        </div>
      )}
      {admin && (
        <div className="inline" style={{ gap: 8, marginTop: 10 }}>
          <button type="button" className="primary" disabled={!dirty || save.busy} onClick={save.submit}>Save</button>
          {dirty && <span className="muted" style={{ fontSize: 12 }}>Not saved yet · {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter</span>}
        </div>
      )}
      {j.engine && (
        <>
          <ErrorBox error={previewErr} />
          {preview && <PhoneMock preview={preview} />}
          {admin && (
            <div style={{ marginTop: 10 }}>
              <ErrorBox error={sendTest.error} />
              <div className="inline" style={{ gap: 6 }}>
                <input placeholder="Your email, or a mobile number for a text" aria-label="Send a test to" value={testTo} onChange={(e) => setTestTo(e.target.value)} style={{ flex: 1 }} />
                <button type="button" disabled={sendTest.busy || dirty} title={dirty ? 'Save first' : ''} onClick={sendTest.submit}>Send test to me</button>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>Blank sends to your own email. Tests use a pretend patient (Alex).</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function OptionField({ name, value, onChange, disabled, team }) {
  const label = OPTION_LABELS[name] || name;
  if (typeof value === 'boolean') return <label className="inline" style={{ gap: 6 }}><input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
  if (name === 'assign_to' || name === 'owner_user_id') {
    return (
      <label>{label}
        <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{name === 'owner_user_id' ? 'The practice owner' : 'Anyone on the team'}</option>
          {(Array.isArray(team) ? team : team?.users || []).filter((u) => u.active !== 0).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>
    );
  }
  if (name === 'threshold_cents') return <label>{label}<input type="number" min={0} step={50} value={Math.round((value || 0) / 100)} disabled={disabled} onChange={(e) => onChange(Math.round(Number(e.target.value || 0) * 100))} /></label>;
  if (Array.isArray(value)) return <label>{label}<input value={value.join(', ')} disabled={disabled} onChange={(e) => onChange(e.target.value.split(/[\s,]+/).filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x)))} /></label>;
  if (name === 'evening') return <label>{label}<input type="time" value={value || '18:00'} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></label>;
  if (typeof value === 'number') return <label>{label}<input type="number" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} /></label>;
  return <label>{label}<input value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></label>;
}

function PhoneMock({ preview }) {
  const links = (text) => text.split(/(https?:\/\/\S+)/).map((part, i) => (/^https?:/.test(part) ? <u key={i}>{part}</u> : part));
  const mailed = ['letter', 'postcard'].includes(preview.channel);
  return (
    <aside className="phone-preview" aria-label="What the patient gets" style={{ marginTop: 12 }}>
      {mailed ? (
        <div className="card" style={{ background: '#fffdf7', fontFamily: 'Georgia, serif', fontSize: 14, lineHeight: 1.5 }}>
          <div className="muted" style={{ fontSize: 11, fontFamily: 'inherit' }}>{preview.channel === 'postcard' ? 'Postcard' : 'Letter'} — printed and mailed</div>
          <p>Dear Alex,</p><p>{preview.text}</p>
        </div>
      ) : (
        <div className="phone-frame">
          <div className="phone-notch" />
          <div className="phone-top"><span className="phone-avatar">✦</span><div><strong>Your office</strong><div className="muted">{preview.channel === 'email' ? 'Email' : 'Text message'}</div></div></div>
          <div className="phone-screen">
            <div className="phone-time">Today 9:41 AM</div>
            {preview.channel === 'email'
              ? <div className="phone-email"><strong>{preview.subject}</strong><p>{links(preview.text)}</p></div>
              : <div className="phone-bubble">{links(preview.text)}</div>}
          </div>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 6 }}>
        {preview.sample} · {preview.text.length} characters{preview.segments > 1 ? ` · sent as ${preview.segments} texts` : ''}
      </div>
    </aside>
  );
}

// What the welcome says about the office: parking, what to bring, what to expect, a note and the doctor's photo.
function OfficeProfile({ admin }) {
  const { data, error, reload } = useApi('/journeys/profile');
  const [form, setForm] = useState(null);
  useEffect(() => { if (data) setForm(data); }, [data]);
  const save = useSubmit(async () => {
    await api.put('/journeys/profile', { parking: form.parking, what_to_bring: form.what_to_bring, what_to_expect: form.what_to_expect, team_note: form.team_note, doctor_photo: form.doctor_photo });
    toast('Saved');
    reload();
  });
  if (error) return <ErrorBox error={error} />;
  if (!form) return null;
  const photo = (file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => setForm((f) => ({ ...f, doctor_photo: r.result }));
    r.readAsDataURL(file);
  };
  const field = (k, label, rows = 2, help = null) => (
    <label>{label}
      <textarea rows={rows} value={form[k] || ''} disabled={!admin} maxLength={600} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
      {help && <span className="muted" style={{ fontSize: 12 }}>{help}</span>}
    </label>
  );
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>About your office</h3>
      <ErrorBox error={save.error} />
      {field('parking', 'Parking ({parking})', 2, 'e.g. “Park free in the lot behind the building — the entrance is on Elm Street.”')}
      {field('what_to_bring', 'What to bring ({what_to_bring})', 2, 'Reads after “Please bring …”')}
      {field('what_to_expect', 'What to expect at the first visit (on the welcome page)', 3)}
      {field('team_note', 'A note from the team (on the welcome page)', 3)}
      <label>The doctor’s photo (on the welcome page)
        <div className="card-photo" style={{ maxWidth: 220 }}>
          {form.doctor_photo ? <img src={form.doctor_photo} alt="The doctor" /> : <span className="muted">Choose a photo (PNG or JPEG, under 300 KB)</span>}
          {admin && <input type="file" accept="image/png,image/jpeg" aria-label="Choose the doctor’s photo" onChange={(e) => photo(e.target.files?.[0])} />}
        </div>
      </label>
      {admin && form.doctor_photo && <button type="button" className="link" onClick={() => setForm({ ...form, doctor_photo: null })}>Remove the photo</button>}
      {admin && <div style={{ marginTop: 10 }}><button type="button" className="primary" disabled={save.busy} onClick={save.submit}>Save</button></div>}
    </div>
  );
}

// Holiday cards and the newsletter: start from a warm starter, edit, see who it reaches, send once.
function Broadcasts({ admin, mail }) {
  const { data, error, reload } = useApi('/journeys/broadcasts');
  const [draft, setDraft] = useState(null);
  const [audience, setAudience] = useState(null);
  const create = useSubmit(async (starter, kind) => {
    const b = await api.post('/journeys/broadcasts', { kind, channel: 'email', title: starter.title, subject: starter.subject, body: starter.body });
    setDraft(b);
    reload();
  });
  const saveDraft = useSubmit(async () => {
    const b = await api.put(`/journeys/broadcasts/${draft.id}`, { title: draft.title, subject: draft.subject, body: draft.body, channel: draft.channel });
    setDraft(b);
    reload();
    toast('Saved');
  });
  const send = useSubmit(async () => {
    // Sending can't be taken back once it's in inboxes or the mail: the button asks once, on the page.
    await api.post(`/journeys/broadcasts/${draft.id}/send`);
    toast('Sending — it goes out over the next few minutes, inside your sending hours');
    setDraft(null);
    reload();
  });
  useEffect(() => {
    if (!draft) return;
    api.get(`/journeys/broadcasts/${draft.id}/audience`).then((a) => setAudience(a.count)).catch(() => setAudience(null));
  }, [draft?.id, draft?.channel]);
  const starters = useMemo(() => (data ? [...data.holiday_starters.map((s) => [s, 'holiday']), [data.newsletter_starter, 'newsletter']] : []), [data]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Holiday cards & newsletter</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Holiday cards go to one person per family you’ve seen in the last two years. The newsletter goes only to the {data.newsletter_subscribers} patient{data.newsletter_subscribers === 1 ? '' : 's'} who asked
        for it (tick “Newsletter” on their chart), with an unsubscribe link in every one.
      </p>
      <ErrorBox error={create.error || send.error || saveDraft.error} />
      {admin && !draft && (
        <div className="chips" aria-label="Start from">
          {starters.map(([s, kind]) => <button key={`${kind}-${s.title}`} type="button" className="chip" onClick={() => create.submit(s, kind)}>+ {s.title}</button>)}
        </div>
      )}
      {draft && (
        <div className="card" style={{ marginTop: 10 }}>
          <label>Name<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
          {draft.kind === 'holiday' && (
            <label>Send by
              <select value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value })}>
                <option value="email">Email</option>
                <option value="postcard" disabled={!mail}>Mailed postcard{mail ? '' : ' (set up mailing first)'}</option>
              </select>
            </label>
          )}
          {draft.channel === 'email' && <label>Subject<input value={draft.subject || ''} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label>}
          <label>What it says<textarea rows={6} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
          <div className="muted" style={{ fontSize: 12 }}>Fields: {'{first_name}'} {'{practice}'} {'{phone}'} {'{address}'}{audience != null ? ` · reaches ${audience} patient${audience === 1 ? '' : 's'} (save to update)` : ''}</div>
          <div className="inline" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" disabled={saveDraft.busy} onClick={saveDraft.submit}>Save draft</button>
            <ConfirmButton className="primary" disabled={send.busy} ask={`Send “${draft.title}” to ${audience ?? 'the'} patient${audience === 1 ? '' : 's'}? It can’t be unsent.`} yes={`Send to ${audience ?? ''} now`.replace('  ', ' ')} onConfirm={send.submit}>Send…</ConfirmButton>
            <button type="button" className="link" onClick={() => setDraft(null)}>Close</button>
          </div>
        </div>
      )}
      <table style={{ marginTop: 12 }}>
        <thead><tr><th>Name</th><th>Kind</th><th>By</th><th>Status</th><th>Sent</th><th /></tr></thead>
        <tbody>
          {data.broadcasts.map((b) => (
            <tr key={b.id}>
              <td>{b.title}</td><td>{b.kind === 'newsletter' ? 'Newsletter' : 'Holiday card'}</td><td>{CHANNEL[b.channel]}</td>
              <td>{b.status}{b.failed ? ` · ${b.failed} didn’t go` : ''}</td><td>{b.status === 'draft' ? '' : `${b.sent}/${b.recipients}${b.finished_at ? ` · ${fmtDate(b.finished_at.slice(0, 10))}` : ''}`}</td>
              <td>{admin && b.status === 'draft' && <button type="button" className="link" onClick={() => setDraft(b)}>Edit</button>}</td>
            </tr>
          ))}
          {!data.broadcasts.length && <tr><td colSpan={6} className="muted">Nothing yet — start from a card above.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
