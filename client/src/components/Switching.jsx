import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useLookup, invalidateLookup } from '../hooks.js';
import { fmtDate, fullName, money } from '../format.js';
import { useShortcuts } from '../shortcuts.js';
import { toast } from '../toast.js';
import '../pages/monthly.css';
import { ErrorBox, Modal, PatientPicker, useSubmit } from './ui.jsx';

const TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['checkbox', 'Yes / no'], ['select', 'Pick list']];

export const parseCustom = (v) => {
  try {
    return typeof v === 'string' ? JSON.parse(v || '{}') : v || {};
  } catch {
    return {};
  }
};

// Inputs for the practice's custom patient fields, inside the patient form.
export function CustomFieldInputs({ value, onChange }) {
  const defs = useLookup('/custom-fields');
  if (!defs.length) return null;
  const set = (k, v) => onChange({ ...value, [k]: v });
  return defs.map((d) => (
    <label key={d.key} className={d.type === 'checkbox' ? 'checkbox' : ''}>
      {d.type === 'checkbox' ? (
        <><input type="checkbox" checked={!!value[d.key]} onChange={(e) => set(d.key, e.target.checked)} /> {d.label}</>
      ) : (
        <>
          {d.label}
          {d.type === 'select' ? (
            <select value={value[d.key] ?? ''} onChange={(e) => set(d.key, e.target.value)}>
              <option value="">—</option>
              {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input type={d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : 'text'} value={value[d.key] ?? ''} onChange={(e) => set(d.key, e.target.value)} />
          )}
        </>
      )}
    </label>
  ));
}

// Read-only list of the patient's custom field values, for the overview.
export function CustomFieldValues({ patient }) {
  const defs = useLookup('/custom-fields');
  const values = parseCustom(patient.custom);
  const shown = defs.filter((d) => values[d.key] != null && values[d.key] !== '');
  if (!shown.length) return null;
  return shown.map((d) => (
    <div key={d.key} style={{ display: 'contents' }}>
      <dt>{d.label}</dt>
      <dd>{d.type === 'checkbox' ? (values[d.key] ? 'Yes' : 'No') : d.type === 'date' ? fmtDate(values[d.key]) : String(values[d.key])}</dd>
    </div>
  ));
}

// Shown before a new chart is created when it looks like one that already exists.
export function DuplicateWarning({ matches, onUseExisting, onCreateAnyway, busy }) {
  return (
    <div className="public-notice" style={{ marginBottom: 12 }}>
      <strong>This may already be a patient.</strong>
      <div className="muted" style={{ fontSize: 13, margin: '4px 0 8px' }}>These charts have the same name and birthday, or the same phone or email.</div>
      {matches.map((m) => (
        <div key={m.id} className="inline" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
          <span><strong>{fullName(m)}</strong> <span className="muted">#{m.id}{m.dob ? ` · ${fmtDate(m.dob)}` : ''}{m.phone ? ` · ${m.phone}` : ''}{m.email ? ` · ${m.email}` : ''}{m.status !== 'active' ? ` · ${m.status}` : ''}</span></span>
          <button type="button" className="small" onClick={() => onUseExisting(m)}>Open this chart</button>
        </div>
      ))}
      <div className="form-actions" style={{ marginTop: 8 }}>
        <button type="button" disabled={busy} onClick={onCreateAnyway}>It's a different person — create the chart</button>
      </div>
    </div>
  );
}

// Merge another chart into this one (admins only).
export function MergeDialog({ patient, initial, onClose, onDone }) {
  const [from, setFrom] = useState(initial || null);
  const [confirm, setConfirm] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    const r = await api.post(`/patients/${patient.id}/merge`, { from_id: from.id });
    onDone(r);
  });
  return (
    <Modal title={`Merge a duplicate into ${fullName(patient)}`} onClose={onClose}>
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>
        Everything on the duplicate chart — appointments, charting, notes, ledger, claims, insurance, documents and messages — moves to
        <strong> {fullName(patient)} (#{patient.id})</strong>. Details missing here are copied over. The duplicate chart is then removed. This can't be undone.
      </p>
      <label>
        Duplicate chart
        <PatientPicker value={from} onChange={setFrom} />
      </label>
      {from && from.id === patient.id && <div className="error">That's this chart — pick the duplicate.</div>}
      {from && from.id !== patient.id && (
        <label style={{ marginTop: 12 }}>
          Type <strong>MERGE</strong> to confirm
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
        </label>
      )}
      <div className="form-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="danger" disabled={busy || !from || from.id === patient.id || confirm.trim().toUpperCase() !== 'MERGE'} onClick={submit}>
          {busy ? 'Merging…' : `Merge #${from?.id ?? '…'} into #${patient.id}`}
        </button>
      </div>
    </Modal>
  );
}

// Settings: define the practice's custom patient fields.
export function CustomFieldsSettings() {
  const { data } = useApi('/custom-fields');
  const [rows, setRows] = useState(null);
  const [saved, setSaved] = useState(false);
  const list = rows ?? (data || []).map((d) => ({ ...d, options: (d.options || []).join(', ') }));
  const edit = (i, patch) => { setSaved(false); setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r))); };
  const { submit, busy, error } = useSubmit(async () => {
    const out = await api.put('/custom-fields', { fields: list });
    setRows(out.map((d) => ({ ...d, options: (d.options || []).join(', ') })));
    invalidateLookup('/custom-fields');
    setSaved(true);
  });
  if (!data) return <div className="card">Loading…</div>;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Custom patient fields</h2>
      <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>Extra details you track on every patient — e.g. an old chart number, shade, school, or employer. They appear on the patient form and overview.</div>
      <ErrorBox error={error} />
      {list.length === 0 && <div className="muted">No custom fields yet.</div>}
      {list.map((r, i) => (
        <div key={r.key || `new${i}`} className="inline" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <input style={{ flex: '2 1 160px' }} placeholder="Label" value={r.label} onChange={(e) => edit(i, { label: e.target.value })} />
          <select style={{ flex: '1 1 110px' }} value={r.type} onChange={(e) => edit(i, { type: e.target.value })}>
            {TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
          {r.type === 'select' && <input style={{ flex: '2 1 180px' }} placeholder="Choices, separated by commas" value={r.options || ''} onChange={(e) => edit(i, { options: e.target.value })} />}
          <button type="button" className="small" disabled={i === 0} onClick={() => { const l = [...list]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; setRows(l); }} title="Move up">↑</button>
          <button type="button" className="small" onClick={() => { setSaved(false); setRows(list.filter((_, j) => j !== i)); }} title="Remove (values already saved on patients are kept)">✕</button>
        </div>
      ))}
      <div className="form-actions">
        <button type="button" onClick={() => setRows([...list, { label: '', type: 'text', options: '' }])}>+ Field</button>
        <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save fields'}</button>
        {saved && <span className="muted">Saved</span>}
      </div>
    </div>
  );
}

// Settings → Duplicate charts (workflow 51, docs/workflows/specs/51-merge-duplicates.md): charts that look like the
// same person (same name and birthday), compared side by side with how much history each has. The chart to keep is
// picked for you (the one with the most history); click the other one to keep that instead. A merge moves
// everything and can't be undone (the other chart is archived, not deleted), so it takes one deliberate step:
// type MERGE, Enter. J/K move between people, Enter opens the compare.
export function DuplicateCharts() {
  const { data, reload } = useApi('/patients/duplicate-groups');
  const [at, setAt] = useState(0);
  const [openAt, setOpenAt] = useState(null);
  const groups = data || [];
  const cur = Math.min(at, Math.max(groups.length - 1, 0));
  useShortcuts([
    { combo: 'j', handler: () => { setAt(Math.min(cur + 1, groups.length - 1)); setOpenAt(null); }, label: 'Next person', section: 'Duplicate charts', enabled: groups.length > 1 },
    { combo: 'k', handler: () => { setAt(Math.max(cur - 1, 0)); setOpenAt(null); }, label: 'Previous person', section: 'Duplicate charts', enabled: groups.length > 1 },
    { combo: 'enter', handler: () => setOpenAt(cur), label: 'Compare their charts', section: 'Duplicate charts', enabled: groups.length > 0 && openAt !== cur },
  ]);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 16px' }}>
        <h2 style={{ margin: 0 }}>Possible duplicate charts</h2>
        <div className="muted" style={{ fontSize: 13 }}>Patients with the same name and birthday — common after importing from another system. <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>Enter</kbd> compare. The chart with the most history is kept; the other is archived and points to it.</div>
      </div>
      {!data ? <div className="empty">Loading…</div> : groups.length === 0 ? <div className="empty">No duplicates found.</div> : (
        <table>
          <thead><tr><th>Patient</th><th>Birthday</th><th>Charts</th><th /></tr></thead>
          <tbody>
            {groups.map((g, i) => (
              <Fragment key={g[0].id}>
                <tr aria-selected={i === cur} className={`wl-row${i === cur ? ' current' : ''}`} onClick={() => setAt(i)}>
                  <td><strong>{fullName(g[0])}</strong></td>
                  <td>{fmtDate(g[0].dob)}</td>
                  <td>{g.length} charts: {g.map((p) => `#${p.id}`).join(', ')}</td>
                  <td><button className="small" onClick={(e) => { e.stopPropagation(); setAt(i); setOpenAt(openAt === i ? null : i); }}>{openAt === i ? 'Hide' : 'Compare & merge'}</button></td>
                </tr>
                {openAt === i && <tr><td colSpan={4}><CompareCharts group={g} onDone={() => { setOpenAt(null); reload(); }} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// The charts side by side, the one to keep ticked, and the merge — inline, no dialog.
function CompareCharts({ group, onDone }) {
  const [keepId, setKeepId] = useState((group.find((p) => p.suggested_keep) || group[0]).id);
  const [typed, setTyped] = useState('');
  const keep = group.find((p) => p.id === keepId);
  const others = group.filter((p) => p.id !== keepId);
  const { submit, busy, error } = useSubmit(async () => {
    // One at a time: each merge is its own audited step.
    for (const o of others) await api.post(`/patients/${keep.id}/merge`, { from_id: o.id });
    toast(`Merged ${others.map((o) => `#${o.id}`).join(', ')} into ${fullName(keep)} (#${keep.id}) — the other chart is archived`);
    onDone();
  });
  const ready = typed.trim().toUpperCase() === 'MERGE';
  return (
    <div>
      <ErrorBox error={error} />
      <div className="wl-compare" role="radiogroup" aria-label="Which chart to keep">
        {group.map((p) => (
          <div key={p.id} role="radio" aria-checked={p.id === keepId} tabIndex={-1} className={`chart${p.id === keepId ? ' keep' : ''}`} onClick={() => setKeepId(p.id)}>
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <strong><Link to={`/patients/${p.id}`} onClick={(e) => e.stopPropagation()}>#{p.id}</Link> {fullName(p)}</strong>
              {p.id === keepId ? <span className="badge ok nocap">Keep</span> : <span className="badge nocap">Merge into the kept one</span>}
            </div>
            <dl>
              <dt>Added</dt><dd>{fmtDate(p.created_at?.slice(0, 10))}</dd>
              <dt>Phone</dt><dd>{p.phone || '—'}</dd>
              <dt>Email</dt><dd>{p.email || '—'}</dd>
              <dt>Visits</dt><dd>{p.visits ?? '—'}{p.last_visit ? ` · last ${fmtDate(p.last_visit)}` : ''}</dd>
              <dt>Ledger</dt><dd>{p.ledger_entries ?? '—'} entries{p.balance ? ` · balance ${money(p.balance)}` : ''}</dd>
              <dt>Notes / docs</dt><dd>{p.notes ?? '—'} / {p.documents ?? '—'}</dd>
              <dt>Insurance</dt><dd>{p.insurance ? `${p.insurance} active` : 'none'}</dd>
            </dl>
          </div>
        ))}
      </div>
      <form className="inline" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); if (ready && !busy) submit(); }}>
        <span className="muted" style={{ fontSize: 13 }}>Everything on {others.map((o) => `#${o.id}`).join(', ')} moves to #{keep.id}; missing details are copied over. This can’t be undone.</span>
        <label className="inline" style={{ gap: 6 }}>Type <strong>MERGE</strong><input autoFocus aria-label="Type MERGE to merge" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ width: 110 }} /></label>
        <button className="danger" disabled={busy || !ready}>{busy ? 'Merging…' : `Merge into #${keep.id}`}</button>
      </form>
    </div>
  );
}
