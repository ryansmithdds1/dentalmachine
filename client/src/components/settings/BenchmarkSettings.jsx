import { useState } from 'react';
import { BarChart3, ShieldCheck, Send, Eye, LogOut, UserRound, FileText } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { fmtDateTime } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import '../metrics/benchmarks.css';

// Settings → Benchmarks (BM1, BM5), for the owner: join or leave (off by default), the practice type and year it
// opened (region, size and payer mix are worked out), exactly what's shared, how each doctor appears (only a doctor
// can choose to show their own name; the owner can turn it off), what tonight's send would contain, and every
// payload that was ever sent, exactly as it went.
const KIND = { join: 'Joined', submit: 'Monthly numbers', leave: 'Left (rows removed)' };
const CAUSE = { nightly: 'nightly', manual: 'sent by hand', join: 'on joining', leave: 'on leaving' };

function Payload({ id }) {
  const { data, error } = useApi(`/benchmarks/sends/${id}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="bm-payload">
      <p className="muted" style={{ fontSize: 12 }}>Exactly as sent{data.receipt ? ` · receipt ${data.receipt}` : ''} · fingerprint {data.payload_sha256.slice(0, 16)}…</p>
      <pre tabIndex={0} aria-label="Payload as sent">{JSON.stringify(data.payload, null, 2)}</pre>
    </div>
  );
}

export default function BenchmarkSettings() {
  const { data, error, reload } = useApi('/benchmarks/settings');
  const sends = useApi('/benchmarks/sends');
  const [form, setForm] = useState(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [preview, setPreview] = useState(null);
  const [open, setOpen] = useState(null);
  const [leaving, setLeaving] = useState(false);

  if (error) return <div className="card"><ErrorBox error={error} /></div>;
  if (!data) return <div className="card">Loading…</div>;
  const f = form || { practice_type: data.practice_type, founded_year: data.founded_year ?? '', share_labor: data.share_labor };
  const joined = data.status === 'joined';
  const run = async (key, fn) => {
    setErr(null);
    setBusy(key);
    try { await fn(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const body = () => ({ practice_type: f.practice_type, founded_year: f.founded_year === '' ? null : Number(f.founded_year), share_labor: !!f.share_labor });
  const saveProfile = () => run('save', async () => { await api.put('/benchmarks/settings', body()); setForm(null); reload(); toast('Saved'); });
  const join = () => run('join', async () => {
    const r = await api.post('/benchmarks/join', { agree: true, ...body() });
    setForm(null); reload(); sends.reload();
    toast(r.first_send?.error ? 'Joined — the first send didn’t go through yet; it’s in Needs attention' : 'Joined. Your first numbers were sent.');
  });
  const leave = () => run('leave', async () => {
    const r = await api.post('/benchmarks/leave');
    setLeaving(false); reload(); sends.reload();
    toast(r.left ? `You’ve left. ${r.removed_rows ?? 0} rows were removed from the benchmark service.` : 'Nothing more will be sent. Removing your rows is still being confirmed (see Needs attention).');
  });
  const sendNow = () => run('send', async () => { const r = await api.post('/benchmarks/send-now'); sends.reload(); reload(); toast(`Sent ${r.accepted_rows} numbers`); });
  const showPreview = () => run('preview', async () => setPreview(await api.get('/benchmarks/preview')));
  const hideName = (p) => run(`n${p.provider_id}`, async () => { await api.put(`/benchmarks/providers/${p.provider_id}/name`, { show_name: false }); reload(); toast(`${p.name} is anonymous again`); });

  return (
    <div className="card bm-settings">
      <h2 style={{ margin: 0 }}><BarChart3 size={18} aria-hidden="true" /> Benchmarks</h2>
      <p className="muted" style={{ margin: '4px 0 12px', fontSize: 13 }}>
        Compare your doctors and hygienists with practices like yours, anonymously. Off until you turn it on; leave at any time.
      </p>
      <ErrorBox error={err} />
      <p>
        <span className={`badge ${joined ? 'ok' : data.status === 'leaving' ? 'warn' : ''}`}>{joined ? 'Sharing' : data.status === 'leaving' ? 'Leaving' : data.status === 'left' ? 'Left' : 'Off'}</span>{' '}
        <span className="muted" style={{ fontSize: 13 }}>
          {joined ? `Joined ${fmtDateTime(data.joined_at)} · last sent ${data.last_sent_at ? fmtDateTime(data.last_sent_at) : 'not yet'} · you appear as ${data.anonymous_as}` : data.left_at ? `Left ${fmtDateTime(data.left_at)}` : ''}
          {' · '}{data.mode_label}
        </span>
      </p>
      {!data.available && <p className="error">{data.why_unavailable}</p>}

      <h3>Your peer group</h3>
      <div className="bm-form">
        <label>Practice type
          <select value={f.practice_type} onChange={(e) => setForm({ ...f, practice_type: e.target.value })}>
            {Object.entries(data.practice_types).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>Year the practice opened
          <input type="number" inputMode="numeric" min="1900" max={new Date().getFullYear()} placeholder="e.g. 2012" value={f.founded_year} onChange={(e) => setForm({ ...f, founded_year: e.target.value })} />
        </label>
        <label className="bm-check">
          <input type="checkbox" checked={!!f.share_labor} onChange={(e) => setForm({ ...f, share_labor: e.target.checked })} />
          <span>Also share team wages as a share of production (labor %) — optional</span>
        </label>
        {joined && form && <button type="button" className="primary" disabled={busy === 'save'} onClick={saveProfile}>Save</button>}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Worked out for you: {data.profile_labels.region} · {data.profile_labels.size_band} · {data.profile_labels.payer_mix} · {data.profile_labels.years_band}.
        {' '}You’re compared with the closest group that has at least {data.min_peers} practices.
      </p>

      <h3><ShieldCheck size={15} aria-hidden="true" /> What’s shared</h3>
      <ul className="bm-terms">{data.terms.map((t) => <li key={t}>{t}</li>)}</ul>
      <details className="bm-details">
        <summary>The numbers, and where each comes from</summary>
        <table className="compact-table">
          <thead><tr><th>Number</th><th>For</th><th>Same definition as</th></tr></thead>
          <tbody>
            {data.shared.map((x) => <tr key={x.key}><td>{x.label}{x.optional ? ' (optional)' : ''}</td><td>{x.roles.join(', ')}</td><td className="muted">{x.source}</td></tr>)}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12 }}>A number is left out when it rests on too few visits or exams (fewer than {data.min_sample.exams} exams, {data.min_sample.visits} visits or {data.min_sample.hours} hours).</p>
      </details>
      <div className="bm-actions">
        <button type="button" disabled={busy === 'preview'} onClick={showPreview}><Eye size={14} aria-hidden="true" /> {joined ? 'See what tonight’s send will contain' : 'See what would be sent'}</button>
        {joined && <button type="button" disabled={busy === 'send'} onClick={sendNow}><Send size={14} aria-hidden="true" /> Send now</button>}
      </div>
      {preview && (
        <div className="bm-payload">
          <p className="muted" style={{ fontSize: 12 }}>{preview.rows} numbers · nothing has been sent. <button type="button" className="small" onClick={() => setPreview(null)}>Hide</button></p>
          <pre tabIndex={0} aria-label="Preview of the payload">{JSON.stringify(preview.payload, null, 2)}</pre>
        </div>
      )}

      {!joined && data.status !== 'leaving' && (
        <div className="bm-join">
          <label className="bm-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I’m the owner and I agree to share these numbers on the terms above (draft {data.current_terms}).</span>
          </label>
          <button type="button" className="primary" disabled={!agree || !data.available || busy === 'join'} onClick={join}>Join benchmarks</button>
        </div>
      )}
      {(joined || data.status === 'leaving') && (
        <div className="bm-leave">
          {!leaving ? (
            <button type="button" className="danger" onClick={() => setLeaving(true)}><LogOut size={14} aria-hidden="true" /> Leave benchmarks…</button>
          ) : (
            <div role="group" aria-label="Confirm leaving">
              <p>Leaving stops all sending and deletes every number you’ve shared from the benchmark service. This can’t be undone (you can join again as a new, unlinked practice).</p>
              <button type="button" className="danger" autoFocus disabled={busy === 'leave'} onClick={leave}>Leave and remove our numbers</button>{' '}
              <button type="button" onClick={() => setLeaving(false)}>Stay</button>
            </div>
          )}
        </div>
      )}

      <h3><UserRound size={15} aria-hidden="true" /> How each provider appears</h3>
      <p className="muted" style={{ fontSize: 13 }}>Everyone is anonymous unless they turn on “Show my name” themselves (Reports → Metrics → Benchmarks). You can turn a name off.</p>
      <table className="compact-table">
        <thead><tr><th>Provider</th><th>Shown as</th><th /></tr></thead>
        <tbody>
          {data.providers.map((p) => (
            <tr key={p.provider_id}>
              <td>{p.name}{!p.linked && <span className="muted"> · no login linked, stays anonymous</span>}</td>
              <td>{p.show_name ? p.public_name : p.anonymous_as}</td>
              <td>{p.show_name && <button type="button" className="small" disabled={busy === `n${p.provider_id}`} onClick={() => hideName(p)}>Make anonymous</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3><FileText size={15} aria-hidden="true" /> Everything that was sent</h3>
      {sends.error && <ErrorBox error={sends.error} />}
      {!sends.data?.length ? <p className="muted">Nothing has been sent.</p> : (
        <table className="compact-table bm-sends">
          <thead><tr><th>When</th><th>What</th><th className="num">Numbers</th><th>Result</th><th /></tr></thead>
          <tbody>
            {sends.data.map((x) => (
              <tr key={x.id}>
                <td>{fmtDateTime(x.created_at)}</td>
                <td>{KIND[x.kind]}{x.months ? ` · ${x.months}` : ''} <span className="muted">({CAUSE[x.cause]}{x.created_by_name ? `, ${x.created_by_name}` : ''})</span></td>
                <td className="num">{x.kind === 'submit' ? `${x.accepted_rows ?? '—'} / ${x.rows}` : ''}</td>
                <td>{x.status === 'sent' ? <span className="badge ok">Received</span> : x.status === 'failed' ? <span className="badge danger" title={x.error || ''}>Failed</span> : <span className="badge warn">Sending</span>}{x.error ? <span className="muted" style={{ fontSize: 12 }}> {x.error}</span> : null}</td>
                <td><button type="button" className="small" aria-expanded={open === x.id} onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? 'Hide' : 'View payload'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <Payload id={open} />}
    </div>
  );
}
