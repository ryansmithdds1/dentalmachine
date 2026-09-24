import { useState } from 'react';
import { api, getToken } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, fmtDateTime } from '../../format.js';
import { ErrorBox, Modal } from '../ui.jsx';
import { useShortcut, useCommands } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import '../insurance-intake.css';

const hasOon = (s) => !!s.out_of_network && (s.out_of_network.annual_max != null || s.out_of_network.deductible != null || Object.keys(s.out_of_network.coinsurance || {}).length > 0);
const lastDone = (history = [], codes) => history.filter((h) => h.codes.some((c) => codes.includes(c))).map((h) => h.date).sort().at(-1) || null;
const addMonths = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const today = new Date().toISOString().slice(0, 10);

// What happened to a response: applied on its own, waiting for a person, or looked at already.
export function outcomeOf(s) {
  if (!s) return null;
  if (s.review && !s.review.resolved_at) return { tone: 'look', text: 'Needs a look', reasons: s.review.reasons };
  if (s.review?.outcome === 'kept') return { tone: 'done', text: `Kept what's on file (${s.review.resolved_by})` };
  if (s.applied) return { tone: 'done', text: s.applied.auto ? 'Applied to the policy automatically' : `Applied to the policy${s.applied.by ? ` by ${s.applied.by}` : ''}` };
  return null;
}

// Real-time (sandbox) or clearinghouse-file (manual) insurance eligibility checks. A clean answer is applied
// to the policy by the server as soon as it comes back; only problems ask for a person.
export default function Eligibility({ patient, policies, onApplied }) {
  const { can } = useAuth();
  const { data: checks, reload } = useApi(can('billing:read') ? `/patients/${patient.id}/eligibility` : null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(null);
  const [text, setText] = useState('');
  const active = (policies || []).filter((p) => p.active);
  const primary = active.find((p) => p.priority === 'primary') || active[0];

  const run = async (policyId) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post(`/insurance/${policyId}/eligibility`);
      if (r.mode === 'manual') setImporting(r.id);
      else if (r.applied) toast(`${r.status === 'active' ? 'Coverage active' : 'Checked'} — applied to the policy`);
      else if (r.reasons?.length) toast(`Insurance needs a look: ${r.reasons[0]}`, { tone: 'error' });
      reload();
      if (r.applied) onApplied?.();
    } catch (e) {
      setErr(e);
      toast(`Couldn’t check insurance: ${e.message}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const ok = can('billing:read') && !!primary;
  useShortcut('e', () => !busy && run(primary.id), { label: 'Check eligibility (primary insurance)', section: 'Insurance', enabled: ok });
  useCommands(ok ? [{ id: 'check-eligibility', label: `Check eligibility: ${primary.carrier_name}`, hint: 'E', run: () => run(primary.id) }] : []);
  if (!ok) return null;
  const download270 = async (id) => {
    const res = await fetch(`/api/eligibility/${id}/270`, { headers: { Authorization: `Bearer ${getToken()}` } });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: `eligibility-${id}.270` });
    a.click();
  };
  const importResponse = async () => {
    setErr(null);
    try {
      const res = await fetch(`/api/eligibility/${importing}/response`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'text/plain' }, body: text });
      if (!res.ok) throw new Error((await res.json()).error);
      setImporting(null);
      setText('');
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const apply = async (id) => {
    setErr(null);
    try {
      await api.post(`/eligibility/${id}/apply`);
      toast('Applied to the policy');
      reload();
      onApplied?.();
    } catch (e) {
      setErr(e);
    }
  };
  const keep = async (id) => {
    setErr(null);
    try {
      await api.post(`/eligibility/${id}/keep`);
      toast('Kept what’s on file');
      reload();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Eligibility & benefits</h2>
        <div className="actions">
          {active.map((p) => <button key={p.id} className={p.id === primary.id ? 'primary' : ''} disabled={busy} onClick={() => run(p.id)} title={p.id === primary.id ? 'Shortcut: E' : undefined}>{busy ? 'Checking…' : `Check ${p.carrier_name}`}{p.id === primary.id && <kbd className="elig-kbd">E</kbd>}</button>)}
        </div>
      </div>
      <ErrorBox error={err} />
      {checks?.length === 0 && <div className="muted">Not verified yet. Verify before each visit to catch terminated coverage and remaining maximums.</div>}
      {checks?.map((c, i) => {
        const s = c.summary;
        const outcome = outcomeOf(s);
        // The newest check per policy is the one that counts; older ones are history.
        const latest = checks.findIndex((x) => x.patient_insurance_id === c.patient_insurance_id) === i;
        return (
          <div key={c.id} className="elig">
            <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span>
                <span className={`badge ${c.status === 'active' ? 'ok' : c.status === 'pending' ? 'info' : 'danger'}`}>{c.status === 'active' ? 'Coverage active' : c.status}</span>{' '}
                <strong>{c.carrier_name}</strong> <span className="muted">· {fmtDateTime(c.created_at)} · {c.created_by_name}</span>
                {s?.sandbox && <span className="badge warn" style={{ marginLeft: 6 }}>Sandbox</span>}
              </span>
              <span className="inline">
                {c.status === 'pending' && <><button className="small" onClick={() => download270(c.id)}>Download 270</button><button className="small" onClick={() => setImporting(c.id)}>Import 271</button></>}
                {s && can('billing:write') && outcome?.tone === 'look' && latest && <button className="small" onClick={() => keep(c.id)}>Keep what’s on file</button>}
                {s && can('billing:write') && (!outcome || outcome.tone === 'look') && <button className="small" onClick={() => apply(c.id)}>{outcome?.tone === 'look' ? 'Apply anyway' : 'Apply to policy'}</button>}
              </span>
            </div>
            {outcome && (
              <div className={`elig-outcome ${outcome.tone}`}>
                <strong>{outcome.text}</strong>{outcome.reasons?.length > 0 && <>: {outcome.reasons.join('; ')}</>}
              </div>
            )}
            {s && (
              <div className="elig-grid">
                {s.plan_name && <div><span className="muted">Plan</span>{s.plan_name}</div>}
                {s.annual_max != null && <div><span className="muted">Annual max</span>{money(s.annual_max)}{s.max_remaining != null ? ` · ${money(s.max_remaining)} left` : ''}</div>}
                {s.deductible != null && <div><span className="muted">Deductible</span>{money(s.deductible)}{s.deductible_remaining != null ? ` · ${money(s.deductible_remaining)} left` : ''}</div>}
                {Object.keys(s.coinsurance || {}).length > 0 && <div><span className="muted">Coverage</span>{Object.entries(s.coinsurance).map(([k, v]) => `${k} ${v}%`).join(' · ')}</div>}
                {s.family_deductible != null && <div><span className="muted">Family deductible</span>{money(s.family_deductible)}{s.family_deductible_remaining != null ? ` · ${money(s.family_deductible_remaining)} left` : ''}</div>}
                {s.ortho_max != null && <div><span className="muted">Ortho lifetime max</span>{money(s.ortho_max)}{s.ortho_remaining != null ? ` · ${money(s.ortho_remaining)} left` : ''}</div>}
                {hasOon(s) && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <span className="muted">Out of network</span>
                    {[s.out_of_network.annual_max != null && `max ${money(s.out_of_network.annual_max)}${s.out_of_network.max_remaining != null ? ` (${money(s.out_of_network.max_remaining)} left)` : ''}`,
                      s.out_of_network.deductible != null && `deductible ${money(s.out_of_network.deductible)}${s.out_of_network.deductible_remaining != null ? ` (${money(s.out_of_network.deductible_remaining)} left)` : ''}`,
                      ...Object.entries(s.out_of_network.coinsurance || {}).map(([k, v]) => `${k} ${v}%`)].filter(Boolean).join(' · ')}
                  </div>
                )}
                {s.frequencies?.length > 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <span className="muted">Frequency limits and history (from the payer)</span>
                    <table className="elig-freq">
                      <thead><tr><th>Codes</th><th>Limit</th><th>Last done</th><th>Next eligible</th></tr></thead>
                      <tbody>
                        {s.frequencies.map((f, i) => {
                          const last = lastDone(s.history, f.codes);
                          const next = f.months && last ? addMonths(last, f.months) : null;
                          return (
                            <tr key={i}>
                              <td>{f.codes.join(', ')}</td>
                              <td>{f.months ? `${f.count} per ${f.months % 12 === 0 ? `${f.months / 12 === 1 ? '' : `${f.months / 12} `}year${f.months / 12 === 1 ? '' : 's'}` : `${f.months} months`}` : `${f.count} per benefit year`}</td>
                              <td>{last ? fmtDate(last) : <span className="muted">—</span>}</td>
                              <td>{next ? <span className={next > today ? 'text-danger' : ''}>{next > today ? fmtDate(next) : 'Now'}</span> : f.months ? 'Now' : <span className="muted">{last ? 'Check the count this year' : 'Now'}</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {s.messages?.length > 0 && <div style={{ gridColumn: '1 / -1' }}><span className="muted">Payer notes</span>{s.messages.join(' ')}</div>}
                {s.errors?.length > 0 && <div style={{ gridColumn: '1 / -1', color: 'var(--danger)' }}>Payer rejected the request (AAA {s.errors.map((e) => e.code).join(', ')})</div>}
              </div>
            )}
          </div>
        );
      })}
      {importing && (
        <Modal title="Import 271 response" onClose={() => setImporting(null)}>
          <p className="muted">Download the 270 request, submit it through your clearinghouse portal, then paste or upload the 271 response here.</p>
          <input type="file" accept=".271,.txt,.x12,.edi" onChange={async (e) => setText(await e.target.files[0].text())} />
          <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="ISA*00*..." style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 12 }} />
          <ErrorBox error={err} />
          <div className="form-actions"><button className="primary" disabled={!text.trim()} onClick={importResponse}>Import</button></div>
        </Modal>
      )}
    </div>
  );
}
