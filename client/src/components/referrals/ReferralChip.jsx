import { useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks.js';
import { useLiveEvents } from '../../live.js';
import './referrals.css';

// The patient bar's referral chip: red when a critical referral hasn't been seen yet, amber when one is overdue
// or a report is waiting, plain when referrals are simply open. Nothing when there are none. Opens the board
// filtered to the patient.
export default function ReferralChip({ patientId }) {
  const nav = useNavigate();
  const { data: f, reload } = useApi(patientId ? `/referral-tracker/patients/${patientId}/flags` : null);
  useLiveEvents((e) => ['referrals', 'referral_alert', 'referral_report'].includes(e.type) && (!e.patient_id || e.patient_id === patientId) && reload());
  if (!f || !f.open) return null;
  const tone = f.alerting ? 'critical' : f.overdue || f.reports ? 'warn' : '';
  const first = f.referrals.find((r) => r.critical) || f.referrals[0];
  const label = f.alerting ? `Critical referral${f.alerting > 1 ? `s (${f.alerting})` : ''}` : f.reports ? 'Referral report in' : f.overdue ? 'Referral overdue' : `Referred${f.open > 1 ? ` (${f.open})` : ''}`;
  const title = f.referrals.map((r) => `${r.direction === 'in' ? 'From' : 'To'} ${r.contact_name}: ${r.status_label}${r.days_open != null ? ` · ${r.days_open} days` : ''}`).join('\n');
  return (
    <button type="button" className={`pb-chip rt-chip ${tone}`} title={title} onClick={() => nav(`/referrals?patient=${patientId}&view=${first?.direction === 'in' ? 'inbound' : 'open'}`)}>
      {label}{first && !f.alerting ? <span className="muted"> · {first.contact_name}</span> : null}
    </button>
  );
}
