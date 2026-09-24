import { useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { money, practiceToday } from '../../format.js';
import { useShortcut } from '../../shortcuts.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import './moneyflows.css';

const what = (p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}${p.surfaces ? ` ${p.surfaces}` : ''}`;

// Today's visit for this patient and the work planned on it.
export function useTodaysWork(patient, procedures, timezone) {
  return useMemo(() => {
    const today = practiceToday(timezone);
    const visit = (patient.upcoming_appointments || []).find((a) => a.start_time.slice(0, 10) === today && !['cancelled', 'no_show'].includes(a.status)) || null;
    const planned = visit ? (procedures || []).filter((p) => p.status === 'planned' && p.appointment_id === visit.id) : [];
    return { visit, planned };
  }, [patient.upcoming_appointments, procedures, timezone]);
}

// #11: set today's work complete in one go (or the rows ticked in the list). Completing posts charges, so it
// is one clear confirm step inside the chart (not an undo toast): it can be reversed later only from the row,
// with a reason. Who did it is left to the server: the procedure's provider, else the signed-in dentist or
// hygienist, else today's visit's provider, else the patient's dentist.
export default function CompleteWork({ procedures, todays, picked, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const running = useRef(false);
  const chosen = picked.size ? procedures.filter((p) => picked.has(p.id) && p.status === 'planned') : todays.planned;
  const open = () => { if (chosen.length) setConfirming(true); };
  useShortcut('shift+c', open, { label: "Complete today's work (or the ticked procedures)", section: 'Chart', enabled: chosen.length > 0 });

  const { submit, busy, error } = useSubmit(async () => {
    if (running.current) return;
    running.current = true;
    const done = [];
    try {
      for (const p of chosen) {
        const out = await api.post(`/procedures/${p.id}/complete`, todays.visit && p.appointment_id === todays.visit.id ? { appointment_id: todays.visit.id } : {});
        done.push(out);
      }
      setConfirming(false);
      onDone(done.map((d) => d.id), done[0]?.provider_id);
    } catch (e) {
      // Some may have gone through: say which, and show them as done.
      if (done.length) onDone(done.map((d) => d.id), done[0]?.provider_id);
      const left = chosen.slice(done.length).map(what).join(', ');
      throw Object.assign(new Error(`${done.length ? `Completed ${done.length}; ` : ''}${left} not completed: ${e.message}`), { status: e.status });
    } finally {
      running.current = false;
    }
  });

  const total = chosen.reduce((s, p) => s + (p.fee || 0), 0);
  const label = picked.size ? `Complete ${chosen.length} selected` : `Complete today's work${chosen.length ? ` (${chosen.length})` : ''}`;
  return (
    <>
      <div className="proc-bulk no-print">
        <button className="small primary" disabled={!chosen.length || confirming} onClick={open} title={chosen.length ? 'Shift+C' : 'Nothing planned on a visit today — tick procedures to complete them'}>{label}</button>
        {!chosen.length && <span className="muted" style={{ fontSize: 12 }}>{todays.visit ? 'Nothing left planned on today’s visit.' : 'No visit today — tick procedures to complete them.'}</span>}
      </div>
      {confirming && (
        <div className="proc-confirm" role="dialog" aria-label="Confirm completing procedures" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setConfirming(false); } }}>
          <ErrorBox error={error} />
          <strong>Complete {chosen.length} procedure{chosen.length > 1 ? 's' : ''} and post {money(total)} in charges?</strong>
          <ul>{chosen.map((p) => <li key={p.id}>{what(p)} · {p.description} · {money(p.fee)}{p.provider_name ? ` · ${p.provider_name.replace(/,.*$/, '')}` : ''}</li>)}</ul>
          <div className="hint muted" style={{ fontSize: 12 }}>Without a provider on the procedure, it goes to you if you’re a provider, else today’s visit’s provider, else the patient’s dentist.</div>
          <div className="form-actions">
            <button className="primary" autoFocus disabled={busy} onClick={submit}>Complete & post charges</button>
            <button disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

// Un-complete, with the reason typed right in the row (it reverses the charge on the ledger, so it needs
// billing access and a reason; the server enforces both).
export function UncompleteForm({ proc, onDone, onCancel }) {
  const [reason, setReason] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/procedures/${proc.id}/uncomplete`, { reason: reason.trim() });
    onDone();
  });
  return (
    <form className="uncomplete-form" onSubmit={(e) => { e.preventDefault(); if (reason.trim() && !busy) submit(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <ErrorBox error={error} />
      <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} aria-label={`Why undo ${what(proc)}?`} placeholder={`Why? Reverses the ${money(proc.fee)} charge`} />
      <button className="small danger" disabled={busy || !reason.trim()}>Reverse charge</button>
      <button type="button" className="small" onClick={onCancel}>Keep</button>
    </form>
  );
}
