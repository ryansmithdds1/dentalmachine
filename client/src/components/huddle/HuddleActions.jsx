import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useActivePatient } from '../../activePatient.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { toast, undoable } from '../../toast.js';
import './huddle.css';

// Morning huddle (workflow 36, docs/workflows/specs/36-morning-huddle.md): each flag on a patient's row is a
// one-key fix right there instead of a trip to another screen. J / K pick the row; the keys act on it.
//   C confirm the visit (Undo) · V check their insurance now · B book the unscheduled treatment or recall
//   P take a payment · M go over the medical history · L check the lab case in.
// Confirming is a status change with Undo; everything else opens the screen that does it with the patient chosen.
export const HUDDLE_FIXES = [
  { key: 'c', flag: 'unconfirmed', label: 'Confirm', perm: 'schedule:write' },
  { key: 'v', flag: 'verify_insurance', label: 'Check insurance', perm: 'billing:read' },
  { key: 'b', flag: ['unscheduled_treatment', 'recall_due'], label: 'Book', perm: 'schedule:write' },
  { key: 'p', flag: 'balance_due', label: 'Take payment', perm: 'billing:write' },
  { key: 'm', flag: 'update_medical_history', label: 'Medical history', perm: 'clinical:read' },
  { key: 'l', flag: 'lab_not_back', label: 'Check in lab case', perm: 'clinical:write' },
];
const has = (row, fix) => [].concat(fix.flag).some((f) => row.flags.includes(f));

export function useHuddleFixes(rows, { onChanged }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const { setActive } = useActivePatient();
  const [cur, setCur] = useState(0);
  const [done, setDone] = useState({}); // row id → flags fixed here (hidden at once; Undo brings them back)
  const at = Math.min(cur, Math.max(0, rows.length - 1));
  useEffect(() => { document.querySelector('.huddle-row.kb-row')?.scrollIntoView?.({ block: 'nearest' }); }, [at]);
  const hide = (r, flag, on = true) => setDone((d) => ({ ...d, [r.id]: on ? [...(d[r.id] || []), flag] : (d[r.id] || []).filter((f) => f !== flag) }));
  const fixes = (r) => HUDDLE_FIXES.filter((f) => can(f.perm) && has(r, f) && !(done[r.id] || []).includes([].concat(f.flag)[0]));

  const run = async (r, fix) => {
    setActive({ id: r.patient_id, first_name: r.first_name, last_name: r.last_name });
    if (fix.key === 'c') {
      hide(r, 'unconfirmed');
      await undoable(`Confirmed ${r.first_name} ${r.last_name}`,
        () => api.patch(`/appointments/${r.id}/status`, { status: 'confirmed', confirmed_via: 'phone' }),
        async () => { await api.patch(`/appointments/${r.id}/status`, { status: 'scheduled', undo: true }); hide(r, 'unconfirmed', false); onChanged?.(); })
        .then(() => onChanged?.(), () => hide(r, 'unconfirmed', false));
    } else if (fix.key === 'v') {
      const policies = await api.get(`/patients/${r.patient_id}/insurance`).catch(() => []);
      const policy = policies.find((p) => p.active && p.priority === 'primary') || policies.find((p) => p.active);
      if (!policy) return toast(`${r.first_name} has no active insurance on file`, { tone: 'error' });
      hide(r, 'verify_insurance');
      try {
        const e = await api.post(`/insurance/${policy.id}/eligibility`);
        toast(`${r.first_name} ${r.last_name}: ${policy.carrier_name} ${e.status === 'active' ? 'is active' : `came back “${e.status}”`}${e.applied ? ' — benefits updated' : ''}`, { tone: e.status === 'active' ? 'ok' : 'error', ms: 6000 });
        onChanged?.();
      } catch (err) {
        hide(r, 'verify_insurance', false);
        toast(`Couldn’t check ${r.first_name}’s insurance: ${err.message}`, { tone: 'error' });
      }
    } else if (fix.key === 'b') nav(`/schedule?book=${r.patient_id}`);
    else if (fix.key === 'p') nav(`/patients/${r.patient_id}?tab=ledger&pay=1`);
    else if (fix.key === 'm') nav(`/patients/${r.patient_id}?tab=overview`);
    else if (fix.key === 'l') nav('/lab-checkin');
  };
  const row = rows[at];
  useShortcuts([
    { combo: 'j', handler: () => setCur(Math.min(at + 1, rows.length - 1)), label: 'Next patient', section: 'Huddle', enabled: rows.length > 1 },
    { combo: 'k', handler: () => setCur(Math.max(at - 1, 0)), label: 'Previous patient', section: 'Huddle', enabled: rows.length > 1 },
    ...HUDDLE_FIXES.map((f) => ({
      combo: f.key, label: `${f.label} (the highlighted patient)`, section: 'Huddle',
      handler: () => { const fix = row && fixes(row).find((x) => x.key === f.key); if (fix) run(row, fix); },
      enabled: !!row && can(f.perm),
    })),
  ]);
  return { at, setCur, fixes, run, done };
}

export function HuddleFixButtons({ row, fixes, run }) {
  const list = fixes(row);
  if (!list.length) return null;
  return list.map((f) => (
    <button key={f.key} type="button" className="small" onClick={() => run(row, f)} title={`${f.label} (${f.key.toUpperCase()} on the highlighted row)`}>
      {f.label} <kbd>{f.key.toUpperCase()}</kbd>
    </button>
  ));
}
