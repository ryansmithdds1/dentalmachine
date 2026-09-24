import { useState } from 'react';
import { Copy, Megaphone, RotateCcw } from 'lucide-react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { toast } from '../../toast.js';
import { fmtDate } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import '../../pages/marketing.css';

// A chart's "where they came from" (MK1): first and last touch with how we know, every piece of evidence, the
// office's correction (with a reason, kept in the history) and the patient's own refer-a-friend link.
// Goes on the patient's overview: <AttributionCard patientId={patient.id} />.
export default function AttributionCard({ patientId }) {
  const { can } = useAuth();
  const { data, error, reload } = useApi(patientId ? `/marketing/patients/${patientId}/attribution` : null);
  const picker = useLookup('/marketing/picker');
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);
  if (!patientId) return null;
  const write = can('patients:write');
  const line = (label, t) => (
    <div className="mk-attr-touch">
      <b>{label}</b>
      {t ? <span>{t.source_name}{t.campaign_name ? ` · ${t.campaign_name}` : ''} <span className="muted small">({t.method_label}{t.occurred_at ? `, ${fmtDate(t.occurred_at.slice(0, 10))}` : ''})</span></span> : <span className="muted">Not recorded</span>}
    </div>
  );
  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    const pickOf = (x) => (x.source_id ? { source_id: Number(x.source_id), campaign_id: x.campaign_id ? Number(x.campaign_id) : null } : undefined);
    try {
      await api.put(`/marketing/patients/${patientId}/attribution`, { first: pickOf(edit.first), last: pickOf(edit.last), reason: edit.reason });
      toast('Where they came from is updated');
      setEdit(null);
      reload();
    } catch (e2) { setErr(e2); }
  };
  const reset = async () => {
    try { await api.post(`/marketing/patients/${patientId}/attribution/reset`); toast('Back to what the system found'); reload(); } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const referral = async () => {
    try {
      const r = await api.get(`/marketing/patients/${patientId}/referral-link`);
      await navigator.clipboard.writeText(r.url).then(() => toast('Refer-a-friend link copied'), () => toast(r.url, { ms: 12000 }));
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  const sourcePick = (which) => {
    const v = edit[which];
    const camps = (picker.campaigns || []).filter((c) => String(c.source_id) === String(v.source_id));
    return (
      <span className="mk-inline">
        <select aria-label={`${which} touch source`} value={v.source_id} onChange={(e) => setEdit({ ...edit, [which]: { source_id: e.target.value, campaign_id: '' } })}>
          <option value="">{which === 'first' ? 'Keep' : 'Same as first'}</option>
          {(picker.sources || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {camps.length > 0 && (
          <select aria-label={`${which} touch campaign`} value={v.campaign_id} onChange={(e) => setEdit({ ...edit, [which]: { ...v, campaign_id: e.target.value } })}>
            <option value="">No campaign</option>
            {camps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </span>
    );
  };
  return (
    <div className="card mk-attr">
      <div className="mk-drill-head">
        <strong><Megaphone size={15} aria-hidden /> Where they came from</strong>
        <span>
          <button className="small" onClick={referral} title="A booking link that credits this patient"><Copy size={13} aria-hidden /> Refer-a-friend link</button>
          {write && !edit && <button className="small" onClick={() => setEdit({ first: { source_id: '', campaign_id: '' }, last: { source_id: '', campaign_id: '' }, reason: '' })}>Change</button>}
          {write && data?.pinned && !edit && <button className="small" onClick={reset} title="Use what the system found again"><RotateCcw size={13} aria-hidden /></button>}
        </span>
      </div>
      <ErrorBox error={error || err} />
      {data && !edit && (
        <>
          {line('First', data.first)}
          {line('Last', data.last)}
          {data.pinned && <p className="muted small">Set by the office.</p>}
          {data.touches.length > 0 && <button className="link small" onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide' : 'Show'} everything we know ({data.touches.length})</button>}
          {showAll && (
            <ol>
              {data.touches.map((t) => <li key={t.id}>{fmtDate(t.occurred_at.slice(0, 10))}: {t.source_name || 'Unknown source'}{t.campaign_name ? ` · ${t.campaign_name}` : ''} — {t.method_label}{t.detail ? ` (${t.detail})` : ''}</li>)}
              {data.history.map((h) => <li key={`h${h.id}`} className="muted">{fmtDate(h.created_at.slice(0, 10))}: {h.action === 'marketing.attribution_reset' ? 'Put back to automatic' : 'Changed'} by {h.user_name || h.actor || 'the system'}{h.reason ? ` — “${h.reason}”` : ''}</li>)}
            </ol>
          )}
        </>
      )}
      {edit && (
        <form onSubmit={save} className="mk-form" style={{ padding: 0 }}>
          <label>First touch {sourcePick('first')}</label>
          <label>Last touch {sourcePick('last')}</label>
          <label className="mk-grow">Why?<input value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} placeholder="Patient says a friend sent them" /></label>
          <button className="primary" type="submit" disabled={!edit.first.source_id && !edit.last.source_id}>Save</button>
          <button type="button" onClick={() => setEdit(null)}>Cancel</button>
        </form>
      )}
    </div>
  );
}
