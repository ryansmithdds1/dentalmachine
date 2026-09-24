import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { practiceToday } from '../format.js';
import XrayReview from '../components/xray/XrayReview.jsx';

// XR2 per day: the dentist's short list for the day — what the AI saw on today's patients' x-rays that isn't on
// their charts — reviewed with the keyboard (J/K, A accept, D dismiss) before or between patients.
export default function XrayReviewPage() {
  const { practice } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = practiceToday(practice?.timezone);
  const [date, setDate] = useState(params.get('date') || today);
  const pick = (d) => { setDate(d); setParams(d === today ? {} : { date: d }, { replace: true }); };
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>X-ray AI review</h1>
          <div className="muted">What the AI saw on the day’s patients’ x-rays that isn’t on their charts. You decide each one.</div>
        </div>
        <div className="actions">
          <label className="inline" style={{ gap: 6, fontSize: 13 }}>
            Day <input type="date" value={date} onChange={(e) => e.target.value && pick(e.target.value)} style={{ width: 150 }} />
          </label>
          {date !== today && <button type="button" className="small" onClick={() => pick(today)}>Today</button>}
        </div>
      </div>
      <XrayReview key={date} date={date} page />
    </div>
  );
}
