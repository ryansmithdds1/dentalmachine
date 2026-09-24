import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarPlus, CreditCard, FileText, MessageSquare, Stethoscope, X, Wallet } from 'lucide-react';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { useShortcuts, comboLabel } from '../shortcuts.js';
import { money, age, fmtDate } from '../format.js';

// Where each patient action goes. Alt+letter works from any screen while a patient is active.
export const PATIENT_ACTIONS = [
  { key: 'c', label: 'Chart', icon: Stethoscope, to: (id) => `/patients/${id}?tab=chart`, perm: 'clinical:read' },
  { key: 'n', label: 'Note', icon: FileText, to: (id) => `/patients/${id}?tab=notes`, perm: 'clinical:write' },
  { key: 'b', label: 'Book', icon: CalendarPlus, to: (id) => `/schedule?book=${id}`, perm: 'schedule:write' },
  { key: 't', label: 'Text', icon: MessageSquare, to: (id) => `/messages?patient=${id}`, perm: 'patients:read' },
  { key: 'l', label: 'Ledger', icon: Wallet, to: (id) => `/patients/${id}?tab=ledger`, perm: 'billing:read' },
  { key: 'p', label: 'Pay', icon: CreditCard, to: (id) => `/patients/${id}?tab=ledger&pay=1`, perm: 'billing:write' },
];

const when = (dt) => (dt ? `${fmtDate(dt.slice(0, 10))} ${dt.slice(11, 16)}` : '');

// A slim bar with the active patient on every screen: alerts, balance, insurance, next visit, and actions.
export default function PatientBar() {
  const { patientId, clear } = useActivePatient();
  const { can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const { data: p, error } = useApi(patientId ? `/patients/${patientId}/card` : null);
  const actions = PATIENT_ACTIONS.filter((a) => can(a.perm));
  useShortcuts([
    ...actions.map((a) => ({ combo: `alt+${a.key}`, handler: () => nav(a.to(patientId)), label: `${a.label} for the active patient`, section: 'Active patient', enabled: !!patientId })),
    { combo: 'alt+x', handler: clear, label: 'Clear the active patient', section: 'Active patient', enabled: !!patientId },
  ]);
  if (!patientId || error) return null;
  // The chart already shows all this at the top.
  if (loc.pathname === `/patients/${patientId}`) return null;
  if (!p) return <div className="patient-bar loading" aria-hidden />;
  const alerts = [p.office_alert, p.medical_alerts, p.allergies && `Allergies: ${p.allergies}`, p.premed_required && 'Premed'].filter(Boolean);
  return (
    <div className="patient-bar no-print" role="region" aria-label="Active patient">
      <button type="button" className="pb-name" onClick={() => nav(`/patients/${p.id}`)} title="Open the chart">
        <strong>{p.preferred_name || p.first_name} {p.last_name}</strong>
        <span className="muted">{p.dob ? `${age(p.dob)}y` : ''} · #{p.id}</span>
      </button>
      {alerts.length > 0 && <span className="pb-alert" title={alerts.join(' · ')}><AlertTriangle size={14} aria-hidden /> {alerts[0].length > 40 ? `${alerts[0].slice(0, 40)}…` : alerts[0]}{alerts.length > 1 ? ` +${alerts.length - 1}` : ''}</span>}
      {p.balance != null && <span className={`pb-chip${p.balance > 0 ? ' owed' : ''}`}>Balance <b>{money(p.balance)}</b></span>}
      {p.insurance !== undefined && (
        <span className="pb-chip" title={p.insurance?.checked_at ? `Checked ${fmtDate(p.insurance.checked_at.slice(0, 10))}` : 'Not checked yet'}>
          {p.insurance ? <>{p.insurance.carrier} <i className={`pb-dot ${p.insurance.eligibility === 'active' ? 'ok' : p.insurance.eligibility ? 'bad' : ''}`} /></> : 'Self-pay'}
        </span>
      )}
      <span className="pb-chip">{p.next_visit ? <>Next <b>{when(p.next_visit.start_time)}</b></> : <span className="muted">No visit booked</span>}</span>
      <span className="pb-actions">
        {actions.map((a) => (
          <button key={a.key} type="button" className="pb-act" onClick={() => nav(a.to(p.id))} title={`${a.label} (${comboLabel(`alt+${a.key}`).join(' ')})`}>
            <a.icon size={15} aria-hidden /><span>{a.label}</span>
          </button>
        ))}
        <button type="button" className="pb-act pb-clear" onClick={clear} title={`Clear (${comboLabel('alt+x').join(' ')})`} aria-label="Clear the active patient"><X size={15} /></button>
      </span>
    </div>
  );
}
