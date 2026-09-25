import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { api, download } from '../api.js';
import { useApi, useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useShortcuts, useCommands } from '../shortcuts.js';
import { toast, undoable } from '../toast.js';
import { fmtDate, fmtDateTime } from '../format.js';
import { MoreRows, SidePanel } from './ui.jsx';
import AppointmentForm from './AppointmentForm.jsx';
import './recallfreq.css';

// The office-wide recall board (RF4, docs/workflows/specs/RF-recall-frequencies.md): every recall by type, status,
// provider and office, with % current per type, overdue counts and the reappointment rate; one key per action on
// the highlighted row (B book · T text · C mark contacted), J/K to move, and the list as a spreadsheet.
const STATUS = [['', 'Any status'], ['overdue', 'Overdue'], ['due', 'Due'], ['due_soon', 'Due soon'], ['scheduled', 'Scheduled'], ['current', 'Current']];
const TONE = { current: 'ok', due_soon: 'warn', due: 'info', overdue: 'danger', scheduled: 'ok' };
const pct = (n) => (n == null ? '—' : `${n}%`);

export default function RecallBoard() {
  const { can } = useAuth();
  const [f, setF] = useState({ type: '', status: '', provider_id: '', location_id: '', q: '' });
  const [limit, setLimit] = useState(300);
  const query = new URLSearchParams(Object.entries({ ...f, limit }).filter(([, v]) => v !== '' && v != null)).toString();
  const { data, error, reload } = useApi(`/recall-board?${query}`);
  const providers = useLookup('/providers');
  const offices = useLookup('/locations');
  const [cur, setCur] = useState(0);
  const [bookFor, setBookFor] = useState(null);
  const [busy, setBusy] = useState(null);
  const rows = data?.rows || [];
  const row = rows[cur];
  const w = can('schedule:write');
  useEffect(() => { if (cur >= rows.length && cur > 0) setCur(Math.max(0, rows.length - 1)); }, [rows.length, cur]);
  useEffect(() => { document.querySelector('tr.rf-cur')?.scrollIntoView?.({ block: 'nearest' }); }, [cur]);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setCur(0); };

  const book = (r) => r && w && setBookFor(r);
  const text = async (r) => {
    if (!r || !w) return;
    setBusy(`t${r.id}`);
    try {
      const out = await api.post('/recalls/campaign', { recall_ids: [r.id] });
      toast(out.sent ? `Recall text sent to ${r.name}` : `${r.name} can't be texted or emailed (no number, or opted out)`, { tone: out.sent ? 'ok' : 'error' });
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const contacted = async (r) => {
    if (!r || !w || !['due', 'overdue', 'due_soon'].includes(r.status) || r.recall_status === 'contacted') return;
    try {
      await undoable(`${r.name} marked contacted`, () => api.post(`/recalls/${r.id}/contacted`, {}),
        async (res) => { await api.put(`/recalls/${r.id}`, { status: res.previous_status }); reload(); });
      reload();
    } catch { /* the toast showed it */ }
  };
  const exportCsv = () => download(`/recall-board/export.csv?${query}`, 'recall-list.csv').catch((e) => toast(e.message, { tone: 'error' }));

  useShortcuts([
    { combo: 'j', handler: () => setCur((i) => Math.min(i + 1, rows.length - 1)), label: 'Next patient', section: 'Recall board' },
    { combo: 'k', handler: () => setCur((i) => Math.max(i - 1, 0)), label: 'Previous patient', section: 'Recall board' },
    { combo: 'b', handler: () => book(row), label: 'Book the patient', section: 'Recall board', enabled: w },
    { combo: 't', handler: () => text(row), label: 'Text a recall reminder', section: 'Recall board', enabled: w },
    { combo: 'c', handler: () => contacted(row), label: 'Mark contacted', section: 'Recall board', enabled: w },
  ]);
  useCommands([{ id: 'recall-board-export', label: 'Recall board: export the list', run: exportCsv }]);

  const s = data?.summary;
  return (
    <div className="rf-board">
      {s && (
        <div className="stat-strip">
          <div><strong>{pct(s.pct_current)}</strong><span>current (not due, due soon or booked)</span></div>
          <div><strong className={s.overdue ? 'text-danger' : ''}>{s.overdue}</strong><span>overdue · {s.due} due now</span></div>
          <div><strong>{s.scheduled}</strong><span>booked</span></div>
          <div><strong>{pct(data.reappointment.pct)}</strong><span>reappointed ({data.reappointment.reappointed} of {data.reappointment.seen} cleanings, {data.reappointment.days} days)</span></div>
        </div>
      )}
      {s?.types?.length > 0 && (
        <div className="rf-types" aria-label="Current by recall type">
          {s.types.map((t) => (
            <button type="button" key={t.type} className={`rf-type${f.type === t.type ? ' active' : ''}`} onClick={() => setF({ ...f, type: f.type === t.type ? '' : t.type })} title={`${t.name}: ${t.total} patients`}>
              <strong>{t.short}</strong> {pct(t.pct_current)} current{t.overdue ? <span className="text-danger"> · {t.overdue} overdue</span> : null}
            </button>
          ))}
        </div>
      )}
      <div className="card inline rf-filters">
        <select value={f.status} onChange={set('status')} aria-label="Status">{STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select value={f.type} onChange={set('type')} aria-label="Recall type"><option value="">Every type</option>{(s?.types || []).map((t) => <option key={t.type} value={t.type}>{t.name}</option>)}</select>
        <select value={f.provider_id} onChange={set('provider_id')} aria-label="Provider"><option value="">Every provider</option>{providers.filter((p) => p.active !== 0).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        {offices.length > 1 && <select value={f.location_id} onChange={set('location_id')} aria-label="Office"><option value="">Every office</option>{offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        <input value={f.q} onChange={set('q')} placeholder="Find a patient" aria-label="Find a patient on the board" style={{ maxWidth: 200 }} />
        {(can('reports:read')) && <button type="button" className="small" onClick={exportCsv}><Download size={13} /> Export</button>}
      </div>
      {error && <div className="error">{error.message}</div>}
      {w && rows.length > 0 && <div className="muted kb-hint"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>B</kbd> book · <kbd>T</kbd> text · <kbd>C</kbd> contacted</div>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="rf-table">
            <thead><tr><th>Patient</th><th>Recall</th><th>Due</th><th>Status</th><th>Last done</th><th>Provider · office</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={i === cur ? 'rf-cur' : ''} aria-selected={i === cur} onClick={() => setCur(i)} data-recall-id={r.id}>
                  <td><Link to={`/patients/${r.patient_id}`}><strong>{r.name}</strong></Link><div className="muted">{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : 'no phone'}</div></td>
                  <td>{r.type_name}{r.interval_overridden && <span className="muted"> · every {r.interval_months} mo</span>}{r.also_due.length > 0 && <div className="muted" title="Due by the same visit">+ {r.also_due.map((x) => x.short).join(', ')}</div>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.due_date)}{r.days_overdue > 0 && <div className="muted">{r.days_overdue} days ago</div>}</td>
                  <td><span className={`badge ${TONE[r.status] || ''}`}>{r.status === 'scheduled' && r.scheduled_for ? `Booked ${fmtDate(r.scheduled_for)}` : r.status_label}</span>{r.contacted_at && <div className="muted" style={{ fontSize: 11 }}>contacted {fmtDateTime(r.contacted_at).slice(0, 12)}</div>}</td>
                  <td>{r.last_done_date ? <>{fmtDate(r.last_done_date)} <span className="muted">{r.last_done_code}{r.last_done_source === 'outside' ? ' · outside' : ''}</span></> : <span className="muted">—</span>}</td>
                  <td>{r.provider_name || <span className="muted">—</span>}{r.location_name && <div className="muted">{r.location_name}</div>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {w && r.status !== 'scheduled' && (
                      <>
                        <button className="small primary" onClick={() => book(r)} title="B">Book</button>{' '}
                        <button className="small" disabled={busy === `t${r.id}` || !r.phone && !r.email} onClick={() => text(r)} title="T">Text</button>{' '}
                        {r.recall_status !== 'contacted' && r.status !== 'current' && <button className="small" onClick={() => contacted(r)} title="C">Contacted</button>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && rows.length === 0 && <div className="empty">Nobody here. 🎉</div>}
          {data && <MoreRows shown={rows.length} total={data.total} onMore={(n) => setLimit(limit + n)} step={300} />}
        </div>
      </div>
      {bookFor && (
        <SidePanel className="book-panel" title={`Book ${bookFor.name}`} onClose={() => setBookFor(null)}>
          <AppointmentForm
            patient={{ id: bookFor.patient_id, first_name: bookFor.first_name, last_name: bookFor.last_name }}
            defaults={{ date: bookFor.due_date && bookFor.due_date > (data?.today || '') ? bookFor.due_date : data?.today }}
            onCancel={() => setBookFor(null)} onSaved={() => { setBookFor(null); reload(); }}
          />
        </SidePanel>
      )}
    </div>
  );
}
