import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { money } from '../format.js';
import { ErrorBox } from '../components/ui.jsx';

// First-run setup for a new office, one step at a time. Everything here can be changed later in Settings.
const STEPS = [
  ['practice', 'Practice details'], ['providers', 'Providers'], ['chairs', 'Chairs'], ['fees', 'Fees'],
  ['insurance', 'Insurance'], ['messaging', 'Reminders & booking'], ['live', 'Go live'],
];
const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];

export default function Setup() {
  const { data: s, error: loadError, reload } = useApi('/setup');
  const { data: practice, error: practiceError, reload: reloadPractice } = useApi('/practice');
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Setup is for administrators; anyone else who lands here (a bookmark, a typed address) is told why, not left on "Loading…".
  if (loadError || practiceError) return <ErrorBox error={loadError || practiceError} />;
  if (!s || !practice) return <div className="empty">Loading…</div>;
  const key = STEPS[step][0];
  const run = async (fn, next = true) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await Promise.all([reload(), reloadPractice()]);
      if (next) setStep((n) => Math.min(STEPS.length - 1, n + 1));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const done = (k) => (k === 'live' ? s.status === 'done' : s.steps[k]?.done);
  const props = { s, practice, run, busy };
  return (
    <div className="setup">
      <div className="page-header"><div><h1>Set up {practice.name}</h1><div className="muted">About ten minutes. You can come back to any step, and change everything later in Settings.</div></div></div>
      <div className="setup-layout">
        <ol className="setup-steps">
          {STEPS.map(([k, l], i) => (
            <li key={k}><button className={`${i === step ? 'active' : ''}${done(k) ? ' done' : ''}`} onClick={() => setStep(i)}><span className="setup-dot">{done(k) ? '✓' : i + 1}</span>{l}</button></li>
          ))}
        </ol>
        <div className="card setup-body">
          <h2>{STEPS[step][1]}</h2>
          <ErrorBox error={error} />
          {key === 'practice' && <PracticeStep {...props} />}
          {key === 'providers' && <ProvidersStep {...props} />}
          {key === 'chairs' && <ChairsStep {...props} />}
          {key === 'fees' && <FeesStep {...props} />}
          {key === 'insurance' && <InsuranceStep {...props} />}
          {key === 'messaging' && <MessagingStep {...props} />}
          {key === 'live' && (
            <>
              <ul className="setup-checklist">
                {STEPS.slice(0, -1).map(([k, l], i) => <li key={k} className={done(k) ? 'ok' : 'todo'}>{done(k) ? '✓' : '○'} {l}{!done(k) && <> — <button className="link" onClick={() => setStep(i)}>finish this</button></>}</li>)}
              </ul>
              <p className="muted" style={{ fontSize: 13 }}>
                Connections (texting, email, card payments, clearinghouse, e-prescribing) are listed in <Link to="/settings?tab=integrations">Settings → Integrations</Link>{s.sandbox ? ' — they run in sandbox mode until the server is given real accounts' : ''}.
                Moving from another system? <Link to="/settings?tab=import">Import your patients and history</Link>.
              </p>
              <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
                <button className="primary" disabled={busy} onClick={() => run(async () => { await api.post('/setup/complete'); await refresh(); navigate('/'); }, false)}>{s.status === 'done' ? 'Back to the dashboard' : 'Finish setup'}</button>
              </div>
            </>
          )}
          {key !== 'live' && (
            <div className="setup-nav">
              {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
              <button className="link" onClick={() => setStep(step + 1)}>Skip for now</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PracticeStep({ s, practice, run, busy }) {
  const [f, setF] = useState(() => Object.fromEntries(['name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'npi', 'tax_id', 'timezone'].map((k) => [k, practice[k] || ''])));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="form-grid" onSubmit={(e) => { e.preventDefault(); run(() => api.put('/practice', f)); }}>
      <label className="full">Practice name<input required value={f.name} onChange={set('name')} /></label>
      <label className="full">Street address<input value={f.address} onChange={set('address')} /></label>
      <label>City<input value={f.city} onChange={set('city')} /></label>
      <label>State<input value={f.state} maxLength={2} onChange={set('state')} /></label>
      <label>ZIP<input value={f.zip} onChange={set('zip')} /></label>
      <label>Phone<input value={f.phone} onChange={set('phone')} /></label>
      <label>Email<input type="email" value={f.email} onChange={set('email')} /></label>
      <label>Group NPI (type 2)<input value={f.npi} inputMode="numeric" onChange={set('npi')} /></label>
      <label>Tax ID (EIN)<input value={f.tax_id} onChange={set('tax_id')} placeholder="74-1234567" /></label>
      <label>Time zone<select value={f.timezone} onChange={set('timezone')}>{[...new Set([f.timezone, ...TIMEZONES])].filter(Boolean).map((t) => <option key={t} value={t}>{t.replace('America/', '').replace('Pacific/', '').replace('_', ' ')}</option>)}</select></label>
      {s.steps.practice.missing.length > 0 && <p className="muted full" style={{ fontSize: 13 }}>Claims need the address, NPI and tax ID; patients see the phone number on reminders.</p>}
      <div className="form-actions full"><button className="primary" disabled={busy}>Save and continue</button></div>
    </form>
  );
}

function ProvidersStep({ s, run, busy }) {
  const { data: providers, reload } = useApi('/providers');
  const [f, setF] = useState({ name: '', type: 'dentist', npi: '', license_number: '' });
  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>Everyone who sees patients: dentists and hygienists, each with their own NPI (it goes on claims).</p>
      <table className="compact-table" style={{ marginBottom: 10 }}>
        <tbody>{(providers || []).filter((p) => p.active).map((p) => <tr key={p.id}><td>{p.name}</td><td className="muted">{p.type}</td><td>{p.npi || <span className="text-danger">NPI missing</span>}</td></tr>)}</tbody>
      </table>
      <form className="inline" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/providers', f); setF({ name: '', type: 'dentist', npi: '', license_number: '' }); reload(); }, false); }}>
        <label>Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Dr. Ann Lee, DDS" /></label>
        <label>Role<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="dentist">Dentist</option><option value="hygienist">Hygienist</option></select></label>
        <label>NPI<input value={f.npi} inputMode="numeric" onChange={(e) => setF({ ...f, npi: e.target.value })} /></label>
        <label>License #<input value={f.license_number} onChange={(e) => setF({ ...f, license_number: e.target.value })} /></label>
        <button className="small" disabled={busy}>Add provider</button>
      </form>
      {s.steps.providers.without_npi.length > 0 && <p className="muted" style={{ fontSize: 13 }}>Add the NPI for {s.steps.providers.without_npi.join(', ')} in <Link to="/settings?tab=providers">Settings → Providers</Link>.</p>}
      <div className="form-actions"><button className="primary" disabled={busy || !s.steps.providers.count} onClick={() => run(async () => {})}>Continue</button></div>
    </>
  );
}

function ChairsStep({ run, busy }) {
  const { data: ops, reload } = useApi('/operatories');
  const [name, setName] = useState('');
  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>Each chair is a column on the schedule. New offices start with two operatories and a hygiene room.</p>
      <div className="inline" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {(ops || []).filter((o) => o.active).map((o) => <span key={o.id} className="badge info nocap">{o.name}</span>)}
      </div>
      <form className="inline" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/operatories', { name }); setName(''); reload(); }, false); }}>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Op 3" aria-label="New chair" style={{ width: 180 }} />
        <button className="small" disabled={busy}>Add chair</button>
      </form>
      <p className="muted" style={{ fontSize: 13 }}>Rename or remove chairs in <Link to="/settings?tab=operatories">Settings → Operatories</Link>.</p>
      <div className="form-actions"><button className="primary" disabled={busy} onClick={() => run(async () => {})}>Continue</button></div>
    </>
  );
}

const SAMPLE_CODES = ['D0150', 'D0120', 'D1110', 'D0274', 'D2392', 'D2740', 'D3330', 'D7140'];
function FeesStep({ s, run, busy }) {
  const { data: codes } = useApi('/procedure-codes');
  const [pct, setPct] = useState(0);
  const sample = (codes || []).filter((c) => SAMPLE_CODES.includes(c.code));
  const adj = (fee) => Math.round((fee * (100 + Number(pct || 0))) / 100 / 100) * 100;
  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>You start with {s.steps.fees.codes} common procedure codes and typical fees. Keep them, move them all up or down, or set each fee in <Link to="/settings?tab=codes">Settings → Procedure codes &amp; fees</Link> (or import yours).</p>
      <div className="inline" style={{ gap: 8, alignItems: 'center' }}><span>Change every fee by</span><input type="number" value={pct} min="-50" max="200" onChange={(e) => setPct(e.target.value)} style={{ width: 80 }} aria-label="Percent change" /><span>%</span></div>
      <table className="compact-table" style={{ margin: '10px 0' }}>
        <thead><tr><th>Code</th><th>Procedure</th><th className="num">Now</th>{Number(pct) !== 0 && <th className="num">New</th>}</tr></thead>
        <tbody>{sample.map((c) => <tr key={c.code}><td>{c.code}</td><td>{c.description}</td><td className="num">{money(c.fee)}</td>{Number(pct) !== 0 && <td className="num"><strong>{money(adj(c.fee))}</strong></td>}</tr>)}</tbody>
      </table>
      <div className="form-actions"><button className="primary" disabled={busy} onClick={() => run(() => api.post('/setup/fees', { percent: Number(pct) || 0 }))}>{Number(pct) ? `Change all fees by ${pct}% and continue` : 'Keep these fees and continue'}</button></div>
    </>
  );
}

function InsuranceStep({ s, run, busy }) {
  const { data: carriers } = useApi('/carriers');
  const have = new Set((carriers || []).map((c) => c.name.toLowerCase()));
  const [picked, setPicked] = useState(new Set(['Delta Dental', 'MetLife', 'Cigna Dental', 'Aetna Dental', 'Guardian']));
  const toggle = (n) => { const x = new Set(picked); if (x.has(n)) x.delete(n); else x.add(n); setPicked(x); };
  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>Pick the insurance companies your patients have most. Their electronic payer IDs are filled in; check them against your clearinghouse's list. Add others any time.</p>
      <div className="setup-carriers">
        {s.common_carriers.map((c) => {
          const on = have.has(c.name.toLowerCase());
          return <label key={c.name} className="checkbox"><input type="checkbox" disabled={on} checked={on || picked.has(c.name)} onChange={() => toggle(c.name)} /> {c.name}{c.payer_id ? <span className="muted"> · {c.payer_id}</span> : ''}{on ? <span className="muted"> (added)</span> : ''}</label>;
        })}
      </div>
      <div className="form-actions"><button className="primary" disabled={busy} onClick={() => run(() => api.post('/setup/carriers', { names: [...picked] }))}>Add these and continue</button></div>
    </>
  );
}

function MessagingStep({ practice, run, busy }) {
  const [f, setF] = useState({ reminder_hours: practice.reminder_steps ? 'custom' : String(practice.reminder_hours ?? 24), sms_number: practice.sms_number || '', online_booking: !!practice.online_booking, slug: practice.slug || practice.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) });
  return (
    <form className="form-grid" onSubmit={(e) => {
      e.preventDefault();
      run(() => api.put('/practice', { ...(f.reminder_hours === 'custom' ? {} : { reminder_hours: Number(f.reminder_hours) }), sms_number: f.sms_number || null, online_booking: f.online_booking, ...(f.online_booking ? { slug: f.slug } : {}) }));
    }}>
      <label>
        Appointment reminders
        <select value={f.reminder_hours} onChange={(e) => setF({ ...f, reminder_hours: e.target.value })}>
          {f.reminder_hours === 'custom' && <option value="custom">Custom steps (Settings → Messages)</option>}
          <option value="0">Off</option><option value="24">1 day before</option><option value="48">2 days before</option><option value="72">3 days before</option>
        </select>
      </label>
      <label>Practice texting number (optional)<input value={f.sms_number} placeholder="+15125550142" onChange={(e) => setF({ ...f, sms_number: e.target.value })} /></label>
      <label className="checkbox full"><input type="checkbox" checked={f.online_booking} onChange={(e) => setF({ ...f, online_booking: e.target.checked })} /> Let patients request appointments online</label>
      {f.online_booking && <label className="full">Booking page address<span className="inline" style={{ gap: 4 }}><span className="muted">{window.location.origin}/book/</span><input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} style={{ maxWidth: 240 }} /></span></label>}
      <p className="muted full" style={{ fontSize: 13 }}>Wording for every message, recall reminders and review requests are in <Link to="/settings?tab=messaging">Settings → Messages & reviews</Link>.</p>
      <div className="form-actions full"><button className="primary" disabled={busy}>Save and continue</button></div>
    </form>
  );
}
