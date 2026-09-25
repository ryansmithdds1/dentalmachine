import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Calculator, CalendarPlus, CreditCard, FileText, MessageSquare, PhoneCall, Star, Stethoscope, X, Wallet } from 'lucide-react';
import { openLogCall } from './phones/LogCall.jsx';
import { requestReview } from '../reviewRequest.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { useActivePatient } from '../activePatient.jsx';
import { useShortcuts, useCommands, comboLabel } from '../shortcuts.js';
import { money, age, fmtDate, fmtTime } from '../format.js';
import ReferralChip from './referrals/ReferralChip.jsx';
import ConnectionChips from './cards/Connection.jsx';

// Where each patient action goes (or, with `run`, what it does in place). Alt+letter works from any screen while a patient is active.
export const PATIENT_ACTIONS = [
  { key: 'c', label: 'Chart', icon: Stethoscope, to: (id) => `/patients/${id}?tab=chart`, perm: 'clinical:read' },
  { key: 'n', label: 'Note', icon: FileText, to: (id) => `/patients/${id}?tab=notes`, perm: 'clinical:write' },
  { key: 'b', label: 'Book', icon: CalendarPlus, to: (id) => `/schedule?book=${id}`, perm: 'schedule:write' },
  { key: 't', label: 'Text', icon: MessageSquare, to: (id) => `/messages?patient=${id}`, perm: 'patients:read' },
  { key: 'l', label: 'Ledger', icon: Wallet, to: (id) => `/patients/${id}?tab=ledger`, perm: 'billing:read' },
  { key: 'p', label: 'Pay', icon: CreditCard, to: (id) => `/patients/${id}?tab=ledger&pay=1`, perm: 'billing:write' },
  // "How much will it cost?": the chart's typing box, focused — the fee and what insurance and the patient pay.
  // Everyone who sees ledgers (front desk and billing get it without charting anything).
  { key: 'e', label: 'Estimate', title: 'Estimate a treatment', icon: Calculator, to: (id) => `/patients/${id}?tab=chart&estimate=1`, perm: 'billing:read' },
  // A053: note an ordinary call in a side panel, right where you are (type the note, Enter).
  { key: 'g', label: 'Call', title: 'Log a call', icon: PhoneCall, run: (id) => openLogCall(id), perm: 'patients:write' },
  // Texts (or emails) the "how did we do?" link; throttled and opt-out aware on the server (docs/reviews.md).
  { key: 'r', label: 'Review', title: 'Ask for a review', icon: Star, run: (id) => requestReview(id, { source: 'patient_bar' }), perm: 'patients:write' },
];
// Less frequent jobs for the active patient, found in the command bar (Ctrl/⌘K "rx", "lab", "adjust"…), each
// opening its form with the patient already chosen (daily workflows 34, 35, 39, 40 — docs/workflows/specs/).
export const PATIENT_COMMANDS = [
  { id: 'rx', label: 'Write a prescription (Rx)', to: (id) => `/patients/${id}?tab=rx`, perm: 'clinical:sign' },
  { id: 'lab', label: 'New lab case', to: (id) => `/office?lab=new&patient=${id}`, perm: 'clinical:write' },
  { id: 'adjust', label: 'Adjustment or write-off', to: (id) => `/patients/${id}?tab=ledger&adjust=1`, perm: 'billing:write' },
  { id: 'finance', label: 'Send a financing application', to: (id) => `/patients/${id}?tab=ledger&finance=1`, perm: 'billing:write' },
];
// Runs an action for a patient: goes to its screen, or does it right here.
export const runPatientAction = (a, id, nav) => (a.run ? a.run(id) : nav(a.to(id)));

const when = (dt) => (dt ? `${fmtDate(dt.slice(0, 10))} ${fmtTime(dt)}` : ''); // same 1:00 PM style as the rest of the app

// A slim bar with the active patient on every screen: alerts, balance, insurance, next visit, and actions.
export default function PatientBar() {
  const { patientId, clear } = useActivePatient();
  const { can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const { data: p, error } = useApi(patientId ? `/patients/${patientId}/card` : null);
  const actions = PATIENT_ACTIONS.filter((a) => can(a.perm));
  useShortcuts([
    ...actions.map((a) => ({ combo: `alt+${a.key}`, handler: () => runPatientAction(a, patientId, nav), label: `${a.title || a.label} for the active patient`, section: 'Active patient', enabled: !!patientId })),
    { combo: 'alt+x', handler: clear, label: 'Clear the active patient', section: 'Active patient', enabled: !!patientId },
  ]);
  const name = p ? `${p.preferred_name || p.first_name} ${p.last_name}` : 'the active patient';
  useCommands(patientId ? PATIENT_COMMANDS.filter((c) => can(c.perm)).map((c) => ({ id: `ap-${c.id}`, label: `${c.label} — ${name}`, hint: 'Active patient', run: () => nav(c.to(patientId)) })) : []);
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
      {p.medical_review_due && <span className="pb-chip" title="Health history hasn't been reviewed in a year"><b style={{ color: 'var(--warn)' }}>History review due</b></span>}
      {p.balance != null && <span className={`pb-chip${p.balance > 0 ? ' owed' : ''}`}>Balance <b>{money(p.balance)}</b></span>}
      {p.insurance !== undefined && (
        <span className="pb-chip" title={p.insurance?.checked_at ? `Checked ${fmtDate(p.insurance.checked_at.slice(0, 10))}` : 'Not checked yet'}>
          {p.insurance ? <>{p.insurance.carrier} <i className={`pb-dot ${p.insurance.eligibility === 'active' ? 'ok' : p.insurance.eligibility ? 'bad' : ''}`} /></> : 'Self-pay'}
        </span>
      )}
      <span className="pb-chip">{p.next_visit ? <>Next <b>{when(p.next_visit.start_time)}</b></> : <span className="muted">No visit booked</span>}</span>
      <ReferralChip patientId={p.id} />
      <ConnectionChips patientId={p.id} compact />
      <span className="pb-actions">
        {actions.map((a) => (
          <button key={a.key} type="button" className="pb-act" onClick={() => runPatientAction(a, p.id, nav)} title={`${a.title || a.label} (${comboLabel(`alt+${a.key}`).join(' ')})`}>
            <a.icon size={15} aria-hidden /><span>{a.label}</span>
          </button>
        ))}
        <button type="button" className="pb-act pb-clear" onClick={clear} title={`Clear (${comboLabel('alt+x').join(' ')})`} aria-label="Clear the active patient"><X size={15} /></button>
      </span>
    </div>
  );
}
