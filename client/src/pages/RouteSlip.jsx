import { Link, useParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { money, fmtDate, fmtTime, age, label } from '../format.js';

// Printable route slip that travels with the patient through the visit.
export default function RouteSlip() {
  const { id } = useParams();
  const { data: s } = useApi(`/appointments/${id}/route-slip`);
  if (!s) return <div className="empty">Loading…</div>;
  const { appointment: a, patient: p, policy } = s;
  return (
    <div className="print-doc">
      <div className="page-header no-print">
        <Link to={`/patients/${p.id}`}>← Back to patient</Link>
        <button className="primary" onClick={() => window.print()}>Print route slip</button>
      </div>
      <div className="card slip">
        <div className="inline" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ marginBottom: 2 }}>{p.first_name} {p.preferred_name ? `"${p.preferred_name}" ` : ''}{p.last_name}</h1>
            <div className="muted">#{p.id} · {p.dob ? `${fmtDate(p.dob)} (${age(p.dob)})` : 'DOB —'} · {p.phone || 'no phone'}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <strong>{s.practice.name}</strong>
            <div>{fmtDate(a.start_time)} · {fmtTime(a.start_time)}–{fmtTime(a.end_time)}</div>
            <div className="muted">{a.provider_name}{a.operatory_name ? ` · ${a.operatory_name}` : ''}</div>
          </div>
        </div>

        {(p.medical_alerts || p.allergies || p.office_alert) && (
          <div className="slip-alerts">
            {p.medical_alerts && <div><strong>MEDICAL:</strong> {p.medical_alerts}</div>}
            {p.allergies && <div><strong>ALLERGIES:</strong> {p.allergies}</div>}
            {p.medications && <div><strong>Medications:</strong> {p.medications}</div>}
            {p.office_alert && <div><strong>Office note:</strong> {p.office_alert}</div>}
          </div>
        )}

        <div className="slip-grid">
          <section>
            <h3>Today · {a.type_name || a.reason || 'Visit'}</h3>
            {s.todays_procedures.length === 0 ? <div className="muted">No procedures attached.</div> : (
              <table><tbody>{s.todays_procedures.map((x, i) => <tr key={i}><td>{x.code}</td><td>{x.description}{x.tooth ? ` #${x.tooth}` : ''} {x.surfaces || ''}</td><td className="num">{money(x.fee)}</td></tr>)}</tbody></table>
            )}
            <h3 style={{ marginTop: 14 }}>Still to schedule</h3>
            {s.unscheduled.length === 0 ? <div className="muted">Nothing outstanding.</div> : (
              <table><tbody>{s.unscheduled.map((x, i) => <tr key={i}><td>{x.code}</td><td>{x.description}{x.tooth ? ` #${x.tooth}` : ''} {x.surfaces || ''}</td><td className="num">{money(x.fee)}</td></tr>)}</tbody></table>
            )}
          </section>
          <section>
            <h3>Account</h3>
            <dl className="kv">
              <dt>Balance</dt><dd><strong>{money(s.balance)}</strong></dd>
              {s.guarantor && (<><dt>Guarantor</dt><dd>{s.guarantor.first_name} {s.guarantor.last_name}</dd></>)}
              <dt>Insurance</dt><dd>{policy ? `${policy.carrier_name} · ${policy.subscriber_id}` : 'Self-pay'}</dd>
              <dt>Last visit</dt><dd>{s.last_visit ? fmtDate(s.last_visit) : 'New patient'}</dd>
              <dt>Recall</dt><dd>{s.recall.map((r) => `${label(r.type)} due ${fmtDate(r.due_date)}`).join(', ') || '—'}</dd>
            </dl>
            {s.last_note && (
              <>
                <h3 style={{ marginTop: 14 }}>Last clinical note · {fmtDate(s.last_note.created_at)}</h3>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 13 }}>{s.last_note.body}</p>
              </>
            )}
          </section>
        </div>
        <div className="slip-foot">
          <span>☐ Medical history reviewed</span><span>☐ Next visit scheduled</span><span>☐ Payment collected</span><span>☐ Recall set</span>
        </div>
      </div>
    </div>
  );
}
