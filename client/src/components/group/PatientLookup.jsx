import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Search } from 'lucide-react';
import { api } from '../../api.js';
import { money, fmtDate } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

// Find a patient anywhere in the group (a caller seen at "the other office"). A read-only summary; every search
// is recorded, and each patient shown is noted in their own practice's audit log.
export default function PatientLookup() {
  const [form, setForm] = useState({ name: '', dob: '', phone: '' });
  const [rows, setRows] = useState(null);
  const find = useSubmit(async () => {
    const qs = new URLSearchParams(Object.entries(form).filter(([, v]) => v.trim()));
    setRows((await api.get(`/org/billing/lookup?${qs}`)).rows);
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div>
      <form className="card grp-toolbar" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); find.submit(); }}>
        <label style={{ flex: 2, minWidth: 180 }}>Name<input value={form.name} onChange={set('name')} placeholder="First and last name" autoFocus /></label>
        <label style={{ minWidth: 150 }}>Birth date<input type="date" value={form.dob} onChange={set('dob')} /></label>
        <label style={{ minWidth: 150 }}>Phone<input value={form.phone} onChange={set('phone')} placeholder="(512) 555-0100" inputMode="tel" /></label>
        <button className="primary" disabled={find.busy || !Object.values(form).some((v) => v.trim())}><Search size={14} /> Find</button>
      </form>
      <p className="muted" style={{ fontSize: 12, margin: '8px 2px 12px' }}>Enter two of name, birth date and phone (or a full name, or a full phone number). Searches are recorded in each practice’s activity log.</p>
      <ErrorBox error={find.error} />
      {rows && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Practice</th><th>Patient</th><th>Born</th><th>Phone</th><th className="num">Balance</th><th className="num">Open claims</th><th>Last visit</th><th /></tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No one in the group matches.</td></tr>}
                {rows.map((r) => (
                  <tr key={`${r.practice_id}-${r.patient_id}`}>
                    <td>{r.practice}</td>
                    <td><strong>{r.name}</strong>{r.status !== 'active' && <span className="muted"> · {r.status}</span>}</td>
                    <td>{fmtDate(r.dob)}</td>
                    <td>{r.phone || '—'}</td>
                    <td className="num" style={{ color: r.balance < 0 ? 'var(--ok)' : undefined }}>{money(r.balance)}{r.balance < 0 ? ' credit' : ''}</td>
                    <td className="num">{r.open_claims || '—'}</td>
                    <td>{r.last_visit ? fmtDate(r.last_visit) : '—'}</td>
                    <td>{r.link ? <Link className="btn small" to={r.link}>Open chart</Link> : <span className="muted" title={`Read-only: sign in at ${r.practice} to open the chart`}><Lock size={13} /> {r.practice}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
