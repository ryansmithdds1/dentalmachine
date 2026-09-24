import { useState } from 'react';
import { useAuth } from '../../auth.jsx';
import ReferralForm from './ReferralForm.jsx';
import './referrals.css';

// "Refer" for the chart and the treatment plan: opens the referral form in a side panel with the chosen planned
// procedures (codes and teeth) already filled in. patient { id, first_name, last_name }, procedureIds: planned ids.
export default function ReferButton({ patient, procedureIds = [], className = 'small', label = 'Refer…', onDone }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can('patients:write')) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Refer to a specialist">{label}</button>
      {open && (
        <aside className="drawer rt-drawer" role="dialog" aria-label="Refer to a specialist">
          <div className="drawer-head"><strong>Refer to a specialist</strong><button className="small" onClick={() => setOpen(false)} aria-label="Close">✕</button></div>
          <div className="drawer-body">
            <ReferralForm patient={patient} procedureIds={procedureIds} onDone={(r) => { setOpen(false); onDone?.(r); }} onCancel={() => setOpen(false)} />
          </div>
        </aside>
      )}
    </>
  );
}
