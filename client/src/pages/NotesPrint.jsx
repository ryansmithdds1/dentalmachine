import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate, fmtDateTime } from '../format.js';

// Clinical notes for the record (a records request, a referral, an insurance review): each with its visit,
// author and signature — the signer's name, credentials, license and time.
export default function NotesPrint() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { practice } = useAuth();
  const { data: patient } = useApi(`/patients/${id}`);
  const { data: notes } = useApi(`/patients/${id}/notes?${params}`);
  useEffect(() => {
    if (patient && notes) setTimeout(() => window.print(), 300);
  }, [patient, notes]);
  if (!patient || !notes) return <div className="empty">Loading…</div>;
  return (
    <div className="print-doc notes-print">
      <div className="no-print" style={{ marginBottom: 12 }}><button onClick={() => window.print()}>Print</button></div>
      <header style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Clinical notes — {patient.first_name} {patient.last_name}</h2>
        <div className="muted">{practice?.name} · born {patient.dob ? fmtDate(patient.dob) : '—'} · chart #{patient.id} · printed {fmtDate(new Date().toISOString().slice(0, 10))}</div>
      </header>
      {notes.length === 0 && <p>No notes.</p>}
      {notes.map((n) => (
        <section key={n.id} className="note-print">
          <div><strong>{fmtDateTime(n.created_at.replace('T', ' '))}</strong>{n.visit_start ? ` · visit ${fmtDate(n.visit_start.slice(0, 10))} (${n.visit_reason || 'appointment'})` : ''} · written by {n.author_name}{n.provider_name ? ` for ${n.provider_name}` : ''}</div>
          <div style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{n.body}</div>
          <div className="note-signature">{n.signature ? `${n.signature} · ${fmtDateTime(n.signed_at)}` : 'Not signed'}</div>
          {n.addenda.map((a) => (
            <div key={a.id} className="addendum">
              <div className="muted">Addendum · {fmtDateTime(a.created_at.replace('T', ' '))} · {a.author_name}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div>
              <div className="note-signature">{a.signature ? `${a.signature} · ${fmtDateTime(a.signed_at)}` : 'Not signed'}</div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
