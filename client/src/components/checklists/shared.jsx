import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Camera, Paperclip, AlertTriangle, CheckCircle2, Clock, Undo2, Flag, FileText } from 'lucide-react';
import { api, getToken, getLocationId, postAudio } from '../../api.js';
import { fmtDate, fmtTime } from '../../format.js';
import { toast } from '../../toast.js';
import './checklists.css';

// Shared pieces of the checklist screens: how a result reads, state chips, photos (taken on the phone or tablet
// camera, made smaller before they go up) and the side panel with one occurrence's history.
export const STATE_LABEL = { done: 'Done', late: 'Done late', missed: 'Missed', overdue: 'Overdue', open: 'To do', cancelled: 'Cancelled' };
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const time12 = (hm) => (hm ? fmtTime(`2000-01-01 ${hm}`) : '');

export function resultText(o) {
  if (o.result_type === 'pass_fail') return o.result_pass == null ? '' : o.result_pass ? 'Pass' : 'Fail';
  if (o.result_type === 'number') return o.result_number == null ? '' : `${o.result_number}${o.unit ? ` ${o.unit}` : ''}`;
  if (o.result_type === 'text') return o.result_text || '';
  return '';
}
export const rangeText = (o) => (o.min_value != null || o.max_value != null
  ? `${o.min_value != null && o.max_value != null ? `${o.min_value}–${o.max_value}` : o.min_value != null ? `at least ${o.min_value}` : `at most ${o.max_value}`}${o.unit ? ` ${o.unit}` : ''}`
  : '');
export const outOfRange = (o, v) => {
  if (v === '' || v == null || !Number.isFinite(Number(v))) return false;
  const n = Number(v);
  return (o.min_value != null && n < Number(o.min_value)) || (o.max_value != null && n > Number(o.max_value));
};
export function cadenceText(i) {
  const at = time12(i.due_time);
  if (i.cadence === 'daily') {
    const days = i.weekdays ? i.weekdays.split(',').map(Number) : null;
    return `${!days ? 'Every open day' : days.length === 7 ? 'Every day' : days.map((d) => WEEKDAYS[d]).join(', ')} by ${at}`;
  }
  if (i.cadence === 'weekly') return `Every ${WEEKDAYS[i.weekday ?? 1]} by ${at}`;
  const day = i.month_day === -1 ? 'last business day' : `day ${i.month_day ?? 1}`;
  if (i.cadence === 'monthly') return `Monthly, ${day}, by ${at}`;
  if (i.cadence === 'quarterly') return `Quarterly (${[0, 3, 6, 9].map((k) => MONTHS[((i.month || 1) - 1 + k) % 12]).join('/')}), ${day}`;
  return `Every year, ${MONTHS[(i.month || 1) - 1]} ${i.month_day === -1 ? '(last business day)' : i.month_day ?? 1}`;
}

export const StateChip = ({ state }) => (
  <span className={`cl-state ${state}`}>
    {state === 'done' ? <CheckCircle2 size={12} aria-hidden /> : state === 'open' ? <Clock size={12} aria-hidden /> : <AlertTriangle size={12} aria-hidden />}
    {STATE_LABEL[state] || state}
  </span>
);
export const CriticalChip = () => <span className="cl-critical"><Flag size={11} aria-hidden /> Critical</span>;

// A camera photo is often 4–12 MB: it goes up as a JPEG no larger than 2000 px (plenty to read a spore strip).
// Anything the browser can't draw (HEIC on some browsers, PDFs) goes up as it is.
export async function shrink(file) {
  if (!file.type.startsWith('image/') || file.size < 600_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}
export async function uploadEvidence(occId, file, kind = 'photo') {
  const blob = await shrink(file);
  const name = (file.name || `${kind}.jpg`).replace(/\.[^.]*$/, '');
  return postAudio(`/checklists/occurrences/${occId}/evidence?kind=${kind}&filename=${encodeURIComponent(name)}`, blob.type ? blob : new Blob([blob], { type: 'application/octet-stream' }));
}

// A stored photo or file, fetched with the session (the link alone opens nothing).
export function Evidence({ e, big = false }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const isImage = /^image\/(jpeg|png|gif|webp)$/.test(e.mime);
  useEffect(() => {
    if (!isImage) return undefined;
    let alive = true;
    let made = null;
    fetch(`/api/checklists/evidence/${e.id}`, { headers: { Authorization: `Bearer ${getToken()}`, ...(getLocationId() ? { 'X-Location-Id': getLocationId() } : {}) } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => { made = URL.createObjectURL(b); if (alive) setUrl(made); })
      .catch(() => alive && setFailed(true));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [e.id, isImage]);
  const open = async () => {
    const w = window.open('', '_blank');
    try {
      const r = await fetch(`/api/checklists/evidence/${e.id}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) throw new Error('Couldn’t open the file');
      w.location.href = URL.createObjectURL(await r.blob());
    } catch (err) { w?.close(); toast(err.message, { tone: 'error' }); }
  };
  return (
    <button type="button" className={`cl-thumb${big ? ' big' : ''}`} onClick={open} title={`${e.filename}${e.uploaded_by_name ? ` · ${e.uploaded_by_name}` : ''}`} style={{ padding: 0 }}>
      {isImage && url ? <img src={url} alt={e.filename} /> : failed ? 'Unavailable' : isImage ? '…' : <span><FileText size={18} aria-hidden /><br />{e.mime === 'application/pdf' ? 'PDF' : 'Photo'}</span>}
    </button>
  );
}

const EVENT_WORDS = {
  done: 'Ticked off', undone: 'Tick undone', corrected: 'Corrected', missed: 'Missed (window closed)', flagged: 'Flag raised', flag_resolved: 'Flag resolved',
  evidence_added: 'Evidence added', evidence_removed: 'Evidence taken off',
};

// One occurrence: what it asks for, the result, the evidence, flags (a manager resolves them here) and every
// step of its history.
export function OccurrenceDrawer({ id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [action, setAction] = useState('');
  const load = () => api.get(`/checklists/occurrences/${id}`).then(setD).catch((e) => toast(e.message, { tone: 'error' }));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const resolve = async (flag) => {
    try {
      await api.post(`/checklists/flags/${flag.id}/resolve`, { action });
      setAction('');
      toast('Flag resolved — corrective action recorded');
      load();
      onChanged?.();
    } catch (e) { toast(e.message, { tone: 'error' }); }
  };
  return (
    <aside className="drawer cl-drawer" role="dialog" aria-label="Checklist item">
      <div className="drawer-head">
        <div>
          <strong>{d?.title || 'Checklist item'}</strong>
          {d && <div className="muted" style={{ fontSize: 12.5 }}>{d.position_name}{d.location_name ? ` · ${d.location_name}` : ''} · due {fmtDate(d.due_date)} {time12(d.due_at.slice(11))}</div>}
        </div>
        <button className="small" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </div>
      <div className="drawer-body">
        {!d ? <p className="muted">Loading…</p> : (
          <>
            <div className="chips" style={{ marginBottom: 10 }}>
              <StateChip state={d.state} />
              {d.critical ? <CriticalChip /> : null}
              {d.outcome && d.outcome !== 'ok' && <span className="cl-state missed">{d.outcome === 'fail' ? 'FAILED' : 'Out of range'}</span>}
            </div>
            {d.instructions && <p style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{d.instructions}</p>}
            {d.sop_page_id && <p><Link to={`/intranet/pages/${d.sop_page_id}`}>Office manual: {d.sop_title}</Link></p>}
            {d.status === 'done' && (
              <p style={{ fontSize: 13.5 }}>
                {resultText(d) && <><strong>{resultText(d)}</strong>{rangeText(d) ? <span className="muted"> (allowed {rangeText(d)})</span> : null} · </>}
                {d.completed_by_name} at {fmtTime(d.completed_local)} on {fmtDate(d.completed_local.slice(0, 10))}
                {d.completed_late ? ' (late)' : ''}
              </p>
            )}
            {d.note && <p style={{ fontSize: 13.5 }}><span className="muted">Note:</span> {d.note}</p>}
            {d.late_reason && <p style={{ fontSize: 13.5 }}><span className="muted">Recorded late because:</span> {d.late_reason}</p>}
            {d.evidence.some((e) => !e.removed_at) && (
              <>
                <div className="cl-section">Evidence</div>
                <div className="cl-thumbs">{d.evidence.filter((e) => !e.removed_at).map((e) => <Evidence key={e.id} e={e} />)}</div>
              </>
            )}
            {d.flags.length > 0 && <div className="cl-section">Flags</div>}
            {d.flags.map((f) => (
              <div key={f.id} className={`cl-flag${f.critical ? ' critical' : ''}`}>
                <h4><Flag size={14} aria-hidden /> {f.title}</h4>
                {f.status === 'resolved' ? (
                  <div style={{ fontSize: 13 }}><strong>Corrective action:</strong> {f.corrective_action}<div className="muted">{f.resolved_by_name} · {f.resolved_at}</div></div>
                ) : d.can_manage ? (
                  <>
                    <textarea placeholder="What was done about it (e.g. sterilizer out of service, retested, loads reprocessed)" value={action} onChange={(e) => setAction(e.target.value)} />
                    <button className="primary small" style={{ marginTop: 6 }} disabled={action.trim().length < 5} onClick={() => resolve(f)}>Resolve with this action</button>
                  </>
                ) : <div className="muted" style={{ fontSize: 13 }}>Open — the office manager has been told.</div>}
              </div>
            ))}
            <div className="cl-section">History</div>
            <ul className="cl-events">
              {d.events.length === 0 && <li className="muted">Nothing yet.</li>}
              {d.events.map((e) => (
                <li key={e.id}>
                  <div><strong>{EVENT_WORDS[e.kind] || e.kind}</strong>{e.user_name ? ` · ${e.user_name}` : e.source === 'automation' ? ' · automatically' : ''}</div>
                  {e.kind === 'corrected' && e.details && <div className="muted">{resultText({ ...d, ...e.details.before }) || e.details.before.note || '—'} → {resultText({ ...d, ...e.details.after }) || e.details.after.note || '—'}</div>}
                  {e.reason && <div>{e.reason}</div>}
                  <div className="when">{e.created_at} UTC</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

export const reqIcons = (o) => (
  <>
    {o.require_photo ? <span className={`req${o.photos ? ' ok' : ''}`} title="Photo required"><Camera size={13} aria-hidden /> {o.photos ? `${o.photos} photo${o.photos > 1 ? 's' : ''}` : 'Photo'}</span> : null}
    {o.require_file ? <span className={`req${o.files || o.photos ? ' ok' : ''}`} title="File required"><Paperclip size={13} aria-hidden /> {o.files ? `${o.files} file${o.files > 1 ? 's' : ''}` : 'File'}</span> : null}
  </>
);
export { Undo2 };
