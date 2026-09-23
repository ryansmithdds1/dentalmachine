import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { fmtDate, fmtUtcDate } from '../format.js';
import { useAuth } from '../auth.jsx';
import { Badge } from './ui.jsx';

// Reports → Reviews: how patients rated their visits, who went on to post a review, and what unhappy
// patients told the office.
export default function ReviewReport() {
  const { practice } = useAuth();
  const today = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const { data } = useApi(`/reports/reviews?from=${range.from}&to=${range.to}`);
  const stat = (label, value, sub) => <div className="card stat" style={{ margin: 0 }}><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
  return (
    <>
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Patient reviews</h2>
          <div className="inline" style={{ gap: 6 }}>
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
          </div>
        </div>
        {!data ? <div className="muted">Loading…</div> : (
          <div className="grid grid-4" style={{ gap: 12, marginTop: 12 }}>
            {stat('Asked', data.sent)}
            {stat('Answered', data.responded, data.sent ? `${Math.round((data.responded / data.sent) * 100)}%` : null)}
            {stat('Average', data.average != null ? `${data.average} ★` : '—')}
            {stat('Went on to review', data.went_to_review, data.happy ? `of ${data.happy} happy patients` : null)}
            {stat('Unhappy', data.unhappy, `below ${data.threshold} stars — sent to the office`)}
          </div>
        )}
      </div>
      {data && (
        <div className="grid grid-2">
          <div className="card">
            <h2>Ratings</h2>
            {data.by_stars.map((b) => (
              <div key={b.stars} className="inline" style={{ gap: 8, margin: '4px 0' }}>
                <span style={{ width: 46 }}>{b.stars} ★</span>
                <div style={{ flex: 1, background: 'var(--border)', borderRadius: 4, height: 10 }}>
                  <div style={{ width: `${data.responded ? (b.count / data.responded) * 100 : 0}%`, background: b.stars >= data.threshold ? 'var(--ok)' : 'var(--warn)', height: 10, borderRadius: 4 }} />
                </div>
                <span style={{ width: 30, textAlign: 'right' }}>{b.count}</span>
              </div>
            ))}
          </div>
          <div className="card">
            <h2>What patients told you</h2>
            {data.feedback.length === 0 ? <div className="muted">No private feedback in this period.</div> : data.feedback.map((f) => (
              <div key={f.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div className="inline" style={{ justifyContent: 'space-between' }}>
                  <span><Link to={`/patients/${f.patient_id}`}>{f.first_name} {f.last_name}</Link> · {'★'.repeat(f.rating)}{f.provider_name ? <span className="muted"> · {f.provider_name}</span> : null}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{fmtUtcDate(f.responded_at, practice?.timezone) || fmtDate(f.sent_at)} {f.task_id && <Badge value={f.task_status === 'done' ? 'done' : 'open'} />}</span>
                </div>
                {f.comment && <div style={{ marginTop: 4 }}>“{f.comment}”</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
