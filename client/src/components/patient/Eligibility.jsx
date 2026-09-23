import { useState } from 'react';
import { api, getToken } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDateTime } from '../../format.js';
import { ErrorBox, Modal } from '../ui.jsx';

// Real-time (sandbox) or clearinghouse-file (manual) insurance eligibility checks.
export default function Eligibility({ patient, policies, onApplied }) {
  const { can } = useAuth();
  const { data: checks, reload } = useApi(can('billing:read') ? `/patients/${patient.id}/eligibility` : null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(null);
  const [text, setText] = useState('');
  const active = (policies || []).filter((p) => p.active);
  if (!can('billing:read') || !active.length) return null;

  const run = async (policyId) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post(`/insurance/${policyId}/eligibility`);
      if (r.mode === 'manual') setImporting(r.id);
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
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
    await api.post(`/eligibility/${id}/apply`);
    onApplied?.();
  };

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Eligibility & benefits</h2>
        <div className="actions">
          {active.map((p) => <button key={p.id} className="primary" disabled={busy} onClick={() => run(p.id)}>{busy ? 'Checking…' : `Verify ${p.carrier_name}`}</button>)}
        </div>
      </div>
      <ErrorBox error={err} />
      {checks?.length === 0 && <div className="muted">Not verified yet. Verify before each visit to catch terminated coverage and remaining maximums.</div>}
      {checks?.map((c) => {
        const s = c.summary;
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
                {s && can('billing:write') && <button className="small" onClick={() => apply(c.id)}>Apply to policy</button>}
              </span>
            </div>
            {s && (
              <div className="elig-grid">
                {s.plan_name && <div><span className="muted">Plan</span>{s.plan_name}</div>}
                {s.annual_max != null && <div><span className="muted">Annual max</span>{money(s.annual_max)}{s.max_remaining != null ? ` · ${money(s.max_remaining)} left` : ''}</div>}
                {s.deductible != null && <div><span className="muted">Deductible</span>{money(s.deductible)}{s.deductible_remaining != null ? ` · ${money(s.deductible_remaining)} left` : ''}</div>}
                {Object.keys(s.coinsurance || {}).length > 0 && <div><span className="muted">Coverage</span>{Object.entries(s.coinsurance).map(([k, v]) => `${k} ${v}%`).join(' · ')}</div>}
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
