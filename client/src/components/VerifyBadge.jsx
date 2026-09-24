import { BadgeCheck, FileCheck2, FileClock, FileQuestion } from 'lucide-react';
import { useApi } from '../hooks.js';
import { eligibilityBadge, fmtUtcDate } from '../format.js';
import './verifybadge.css';

// The two insurance statuses, the same everywhere (the verification center, the chart, the patient bar):
//   eligibility — the schedule's badge ($✓ verified recently, $? getting old or never, $✗ inactive, $! failed);
//   breakdown   — the full benefit breakdown verified recently for their plan, out of date, or never.
// <VerifyBadge patientId={id} /> loads the patient's status itself; <VerifyPills eligibility breakdown /> draws
// statuses already loaded (rows of the verification center).

// The verification center's eligibility state in the schedule badge's words.
export const asScheduleStatus = (e) => ({
  status: { verified: 'active', stale: 'active', inactive: 'inactive', error: 'error', pending: 'pending' }[e?.state] || 'unverified',
  checked_at: e?.at || null,
});

const BREAKDOWN = {
  verified: { tone: 'ok', Icon: FileCheck2, short: 'Breakdown ✓' },
  stale: { tone: 'warn', Icon: FileClock, short: 'Breakdown old' },
  review: { tone: 'warn', Icon: FileClock, short: 'Breakdown to review' },
  never: { tone: 'warn', Icon: FileQuestion, short: 'No breakdown' },
};

const describe = (x) => [x.label, x.how && `${x.how}${x.at ? ` · ${fmtUtcDate(x.at)}` : ''}`, x.by && `by ${x.by}`, x.via_group && 'verified for another patient on the same plan'].filter(Boolean).join(' — ');

export function VerifyPills({ eligibility, breakdown, compact = false }) {
  if (!eligibility || eligibility.state === 'self_pay') return <span className="vf-pill none">Self-pay</span>;
  const e = eligibilityBadge(asScheduleStatus(eligibility));
  const b = BREAKDOWN[breakdown?.state] || BREAKDOWN.never;
  const eShort = { verified: 'Eligible', stale: 'Eligible (old)', inactive: 'Inactive', error: 'Check failed', pending: 'Waiting', never: 'Not checked' }[eligibility.state] || 'Not checked';
  return (
    <span className="vf-pills">
      <span className={`vf-pill ${e.tone}`} title={describe(eligibility)} aria-label={`Eligibility: ${eligibility.label}`}>
        <b className="vf-pill-icon">{e.icon}</b>{!compact && <span>{eShort}</span>}
      </span>
      <span className={`vf-pill ${b.tone}`} title={describe(breakdown || { label: 'Full breakdown never verified' })} aria-label={`Benefit breakdown: ${breakdown?.label || 'never verified'}`}>
        <b.Icon size={12} aria-hidden />{!compact && <span>{b.short}</span>}
      </span>
    </span>
  );
}

// For the chart header and the patient bar.
export default function VerifyBadge({ patientId, compact = false }) {
  const { data } = useApi(patientId ? `/patients/${patientId}/verification` : null);
  if (!data) return null;
  return (
    <span className="vf-badge" title={data.exceptions?.length ? data.exceptions.map((x) => x.label).join(' · ') : undefined}>
      {!compact && data.carrier_name && <span className="vf-badge-carrier"><BadgeCheck size={13} aria-hidden /> {data.carrier_name}</span>}
      <VerifyPills eligibility={data.policy_id ? data.eligibility : { state: 'self_pay' }} breakdown={data.breakdown} compact={compact} />
    </span>
  );
}
