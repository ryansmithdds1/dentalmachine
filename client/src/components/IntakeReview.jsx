import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate } from '../format.js';
import { ErrorBox } from './ui.jsx';
import { useShortcuts } from '../shortcuts.js';
import { toast } from '../toast.js';
import { openPaperwork } from './consents/ConsentPanel.jsx';
import './insurance-intake.css';

const KIND = { history: 'Health history', insurance_update: 'New insurance', card: 'Card photo', consent_declined: 'Consent declined', paperwork_unreachable: 'Forms not sent', paperwork_overdue: 'Forms not done' };
const PAPERWORK = new Set(['consent_declined', 'paperwork_unreachable', 'paperwork_overdue']);
const FIELD = { medical_alerts: 'Conditions', allergies: 'Allergies', medications: 'Medications' };

// Intake worklist: what patients sent in online that still needs a person — health histories to review,
// insurance sent from the portal, and card photos from forms nobody has entered yet — across every patient,
// oldest first. J/K move, Enter opens the chart, A accepts (history merged into the chart, insurance
// entered, a card photo read into the policy form), X sets a card photo aside (nothing to enter).
export default function IntakeReview({ compact = false }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, error, reload } = useApi('/intake/pending');
  const items = data?.items || [];
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [replace, setReplace] = useState({});
  const rows = useRef([]);
  const cur = items[Math.min(at, items.length - 1)];
  useEffect(() => { rows.current[at]?.scrollIntoView?.({ block: 'nearest' }); }, [at]);

  const open = (it = cur) => it && navigate(`/patients/${it.patient_id}${it.kind === 'history' || PAPERWORK.has(it.kind) ? '' : '?tab=insurance'}`);
  const act = async (fn, message) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      if (message) toast(message);
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const canAccept = (it) => it && (it.kind === 'history' ? can('clinical:write') : it.kind === 'card' || PAPERWORK.has(it.kind) ? can('patients:write') : can('billing:write'));
  const accept = (it = cur) => {
    if (!it || busy || !canAccept(it)) return;
    // Paperwork: the patient's forms & consents panel (hand the iPad over, text the link, talk the consent through).
    if (PAPERWORK.has(it.kind)) return openPaperwork(it.patient_id, { appointmentId: it.appointment_id || null });
    const name = `${it.first_name} ${it.last_name}`;
    if (it.kind === 'history') {
      // The suggested merge keeps everything already on the chart and adds what's new.
      const values = Object.fromEntries(Object.entries(it.changes || {}).map(([k, v]) => [k, v.proposed ?? '']));
      return act(() => api.post(`/patient-forms/${it.id}/review`, values), `Health history reviewed for ${name}`);
    }
    if (it.kind === 'insurance_update') {
      if (!it.ready) return navigate(`/patients/${it.patient_id}?tab=insurance${it.document_ids.length ? `&card=${it.document_ids.join(',')}` : ''}`);
      return act(async () => {
        try {
          await api.post(`/insurance-updates/${it.id}/apply`, replace[it.id] || it.current_primary ? { replace: true } : {});
        } catch (e) {
          if (e.status === 409 && e.details?.replaces) setReplace((x) => ({ ...x, [it.id]: true }));
          throw e;
        }
      }, `Insurance entered for ${name}`);
    }
    // Card photos: read into the policy form on the patient's Insurance tab.
    return navigate(`/patients/${it.patient_id}?tab=insurance&card=${it.document_ids.join(',')}`);
  };
  const setAside = (it = cur) => {
    if (!it || busy) return;
    if (PAPERWORK.has(it.kind) && can('patients:write')) return act(() => api.post('/intake/paperwork/done', { entity: it.entity, id: it.id }), 'Handled — off the list (kept on the record)');
    if (it.kind !== 'card' || !can('billing:write')) return;
    act(() => api.post('/intake/cards/done', { document_ids: it.document_ids }), 'Set aside — nothing to enter');
  };
  const move = (d) => setAt((i) => Math.max(0, Math.min(items.length - 1, i + d)));
  useShortcuts([
    { combo: 'j', handler: () => move(1), label: 'Next intake item', section: 'Intake', enabled: !compact },
    { combo: 'k', handler: () => move(-1), label: 'Previous intake item', section: 'Intake', enabled: !compact },
    { combo: 'enter', handler: () => open(), label: 'Open the patient', section: 'Intake', enabled: !compact && !!cur },
    { combo: 'a', handler: () => accept(), label: 'Accept (review history / enter insurance / read card)', section: 'Intake', enabled: !compact && !!cur },
    { combo: 'x', handler: () => setAside(), label: 'Set aside (card photo, or paperwork handled)', section: 'Intake', enabled: !compact && (cur?.kind === 'card' || PAPERWORK.has(cur?.kind)) },
  ]);

  // On other pages (the To-do list), just a link when something is waiting: the list and its keys live on /intake.
  if (compact) {
    return items.length ? (
      <Link to="/intake" className="card intake-link" style={{ display: 'block', marginBottom: 12 }}>
        <strong>{items.length} sent in online</strong> <span className="muted">— health histories, insurance and card photos to review →</span>
      </Link>
    ) : null;
  }
  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>Sent in online{items.length ? ` (${items.length})` : ''}</h2>
      </div>
      {!compact && items.length > 0 && <div className="intake-keys"><span><kbd>J</kbd>/<kbd>K</kbd> move</span><span><kbd>A</kbd> accept</span><span><kbd>Enter</kbd> open chart</span><span><kbd>X</kbd> set aside</span></div>}
      <ErrorBox error={error || err} />
      {data && items.length === 0 && <div className="muted">Nothing waiting. Health histories, portal insurance, card photos and paperwork that needs a person show up here.</div>}
      <div className="intake-list" role="listbox" aria-label="Sent in online">
        {items.map((it, i) => (
          <div key={it.key} ref={(el) => { rows.current[i] = el; }} role="option" aria-selected={i === at} className={`intake-item${i === at ? ' current' : ''}`} onClick={() => setAt(i)} onDoubleClick={() => open(it)}>
            <div>
              <div className="intake-kind">{KIND[it.kind]}</div>
              <div className="muted" style={{ fontSize: 12 }}>{fmtDate(String(it.at).slice(0, 10))}</div>
            </div>
            <div>
              <strong>{it.first_name} {it.last_name}</strong>{it.dob && <span className="muted"> · {fmtDate(it.dob)}</span>}
              <Detail it={it} replacing={replace[it.id]} />
            </div>
            <div className="inline" style={{ gap: 6 }}>
              {canAccept(it) && <button className="small primary" disabled={busy} onClick={(e) => { e.stopPropagation(); setAt(i); accept(it); }}>{acceptLabel(it)}</button>}
              {it.kind === 'card' && can('billing:write') && <button className="small" disabled={busy} onClick={(e) => { e.stopPropagation(); setAside(it); }}>Nothing to enter</button>}
              {PAPERWORK.has(it.kind) && can('patients:write') && <button className="small" disabled={busy} onClick={(e) => { e.stopPropagation(); setAside(it); }}>Handled</button>}
              <button className="small" onClick={(e) => { e.stopPropagation(); open(it); }}>Open</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const acceptLabel = (it) => (PAPERWORK.has(it.kind) ? 'Forms & consents' : it.kind === 'history' ? 'Accept changes' : it.kind === 'card' ? 'Read card' : !it.ready ? 'Read card' : it.current_primary ? `Replace ${it.current_primary}` : 'Enter insurance');

function Detail({ it, replacing }) {
  if (it.kind === 'consent_declined') return <div className="intake-detail">Declined <b>{it.form_name}</b>{it.reason ? ` — “${it.reason}”` : ''}. Talk it through, or record informed refusal.</div>;
  if (it.kind === 'paperwork_unreachable') return <div className="intake-detail">Forms for the visit {fmtDate(String(it.start_time).slice(0, 10))} couldn’t be sent ({it.reason || 'no phone or email'}). Hand the iPad over at check-in.</div>;
  if (it.kind === 'paperwork_overdue') return <div className="intake-detail">Visit {fmtDate(String(it.start_time).slice(0, 10))}: still not done after reminders — {(it.forms_left || []).join(', ')}.</div>;
  if (it.kind === 'history') {
    const changes = Object.entries(it.changes || {});
    if (!it.changes) return <div className="intake-detail">Open the chart to review it.</div>;
    if (!changes.length) return <div className="intake-detail">No changes from what’s on the chart.</div>;
    return (
      <div className="intake-detail">
        {changes.map(([k, v]) => <span key={k} className="intake-change">{FIELD[k]}: <b>{v.proposed || 'none'}</b>{v.current ? <> (was {v.current})</> : null}</span>)}
      </div>
    );
  }
  if (it.kind === 'insurance_update') {
    return (
      <div className="intake-detail">
        <b>{it.carrier_name || 'Carrier not typed'}</b>{it.member_id ? ` · ID ${it.member_id}` : ''}{it.group_number ? ` · group ${it.group_number}` : ''}
        {it.subscriber_name ? ` · subscriber ${it.subscriber_name}` : ''}{it.document_ids.length ? ` · ${it.document_ids.length} photo${it.document_ids.length === 1 ? '' : 's'}` : ''}
        {(it.current_primary || replacing) && <div>Replaces {it.current_primary || 'their current insurance'} as primary (kept as inactive).</div>}
        {it.note && <div>“{it.note}”</div>}
      </div>
    );
  }
  return <div className="intake-detail">{it.document_ids.length === 2 ? 'Front and back' : 'One photo'} from a form — no policy entered since.</div>;
}
