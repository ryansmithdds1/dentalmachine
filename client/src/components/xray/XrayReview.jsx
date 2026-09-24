import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScanSearch, Check, X, Monitor, RefreshCw } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { undoable, toast } from '../../toast.js';
import { fmtDate } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import XrayImage from './XrayImage.jsx';
import XrayChairScreen from './XrayChairScreen.jsx';
import { AI_COLOR, DISCLAIMER, pct } from './kinds.js';
import './xray.css';

const FILTERS = [['not_charted', 'Not charted'], ['charted', 'Already on the chart'], ['no_tooth', 'No tooth number'], ['all', 'All']];

// XR2: what the AI saw on the x-rays compared with the chart — "AI saw possible caries on #19 D; not charted" — for
// the dentist to accept (charted, with the finding as the reason) or dismiss, one key each, with Undo. Per patient
// (in the chart, `patient`) or per day (today's schedule, `date`). J/K move, A accept, D dismiss, V the image,
// P shows the patient their confirmed findings. In the chart the keys work once the list has focus (click it or
// press R), so a stray key on the chart never decides a finding.
export default function XrayReview({ patient = null, date = null, onChange, page = false }) {
  const { can } = useAuth();
  const canDecide = can('clinical:sign');
  const path = patient ? `/patients/${patient.id}/xray-review` : `/xray-review${date ? `?date=${date}` : ''}`;
  const { data, error, reload } = useApi(path);
  const [filter, setFilter] = useState('not_charted');
  const [sel, setSel] = useState(0);
  const [gone, setGone] = useState(() => new Set());
  const [showImage, setShowImage] = useState(true);
  const [showConfidence, setShowConfidence] = useState(true);
  const [chairFor, setChairFor] = useState(null);
  const [active, setActive] = useState(page);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const listRef = useRef(null);

  // One flat list (patients in schedule order for the day view), without what was just decided.
  const all = useMemo(() => {
    if (!data) return [];
    const groups = patient ? [{ patient_id: patient.id, name: null, items: data.items }] : data.patients;
    return groups.flatMap((g) => g.items.map((it) => ({ ...it, patient_name: g.name, start_time: g.start_time })));
  }, [data, patient]);
  const items = all.filter((i) => !gone.has(i.id) && (filter === 'all' || i.chart.status === filter));
  const current = items[Math.min(sel, items.length - 1)] || null;
  useEffect(() => { if (sel >= items.length && items.length) setSel(items.length - 1); }, [items.length, sel]);
  useEffect(() => { listRef.current?.querySelector('.xr-row.on')?.scrollIntoView({ block: 'nearest' }); }, [sel, filter]);

  const decide = async (item, status) => {
    if (!item || !canDecide) return;
    setErr(null);
    setGone((g) => new Set(g).add(item.id));
    const what = `${item.label}${item.tooth ? ` on #${item.tooth}${item.surfaces ? ` ${item.surfaces}` : ''}` : ''}`;
    try {
      await undoable(
        status === 'accepted' ? (item.tooth ? `Charted: ${what}` : `Agreed: ${what}`) : `Dismissed: ${what}`,
        () => api.patch(`/ai-findings/${item.id}`, { status }),
        async () => {
          await api.patch(`/ai-findings/${item.id}`, { status: 'suggested' });
          setGone((g) => { const n = new Set(g); n.delete(item.id); return n; });
          reload();
          onChange?.();
        },
      );
      onChange?.();
    } catch (e) {
      setGone((g) => { const n = new Set(g); n.delete(item.id); return n; });
      setErr(e);
    }
  };
  const secondLook = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post('/xray-review/second-look');
      toast(r.read ? `Read ${r.read} x-ray${r.read === 1 ? '' : 's'}${r.failed ? ` · ${r.failed} didn’t go — see Needs attention` : ''}` : r.failed ? 'The x-ray AI didn’t answer — see Needs attention' : 'Nothing new to read');
      reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const move = (d) => setSel((s) => Math.max(0, Math.min(items.length - 1, s + d)));
  const keys = active && !chairFor && items.length > 0;
  useShortcuts([
    { combo: 'j', handler: () => move(1), label: 'Next AI finding', section: 'X-ray AI review', enabled: keys },
    { combo: 'k', handler: () => move(-1), label: 'Previous AI finding', section: 'X-ray AI review', enabled: keys },
    { combo: 'a', handler: () => decide(current, 'accepted'), label: 'Accept: chart it, with the finding as the reason', section: 'X-ray AI review', enabled: keys && canDecide },
    { combo: 'd', handler: () => decide(current, 'rejected'), label: 'Dismiss the finding', section: 'X-ray AI review', enabled: keys && canDecide },
    { combo: 'v', handler: () => setShowImage((v) => !v), label: 'Show or hide the x-ray', section: 'X-ray AI review', enabled: keys },
    { combo: 'c', handler: () => setShowConfidence((v) => !v), label: 'Show or hide the AI’s confidence', section: 'X-ray AI review', enabled: keys },
    { combo: 'p', handler: () => current && setChairFor(current.patient_id), label: 'Show the patient what you confirmed (chair screen)', section: 'X-ray AI review', enabled: active && !chairFor },
    { combo: 'r', handler: () => { setActive(true); listRef.current?.focus(); }, label: 'Review AI x-ray findings', section: 'Chart', enabled: !page && !active && all.length > 0 },
  ]);

  if (!data && !error) return page ? <div className="card"><p className="muted">Loading…</p></div> : null;
  // In the chart, a list this person can't open (no clinical:read) simply isn't there.
  if (!page && error) return null;
  const engine = data?.engine;
  // In the chart, only when there's something to look at.
  if (!page && data && !all.length && !data.unread) return null;
  const counts = { not_charted: 0, charted: 0, no_tooth: 0, all: 0 };
  for (const i of all) if (!gone.has(i.id)) { counts[i.chart.status]++; counts.all++; }
  const unread = patient ? data?.unread : data?.patients?.reduce((n, p) => n + p.unread, 0);
  let lastPatient = null;

  return (
    <div
      className="card xr-review" style={page ? undefined : { gridColumn: '1 / -1' }}
      onFocus={() => setActive(true)} onBlur={(e) => { if (!page && !e.currentTarget.contains(e.relatedTarget)) setActive(false); }}
    >
      <div className="xr-head">
        <ScanSearch size={18} aria-hidden />
        <h2>{patient ? 'AI second look on x-rays' : `X-ray AI review · ${fmtDate(data?.date)}`}</h2>
        <span className="xr-label" title={engine?.cleared ? `${engine.label} (FDA-cleared)` : engine?.label || ''}>{DISCLAIMER}</span>
        <span className="xr-spacer" />
        {engine?.enabled && can('clinical:write') && (!patient || unread > 0) && (
          <button type="button" className="small" disabled={busy} onClick={secondLook} title="Read today’s patients’ x-rays the AI hasn’t seen yet">
            <RefreshCw size={14} aria-hidden /> {busy ? 'Reading…' : 'Second look now'}
          </button>
        )}
        {patient && <button type="button" className="small" onClick={() => setChairFor(patient.id)} title="Show the patient the findings you confirmed (P)"><Monitor size={14} aria-hidden /> Show the patient</button>}
      </div>
      <ErrorBox error={error || err} />
      {engine && !engine.enabled && <p className="muted" style={{ fontSize: 13 }}>{engine.reason}</p>}
      {unread > 0 && <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>{unread} x-ray{unread === 1 ? '' : 's'} not read by the AI yet{engine?.enabled ? ' — the second look reads today’s patients’ x-rays before their visit.' : '.'}</p>}
      <div className="xr-tabs" role="group" aria-label="Which findings">
        {FILTERS.map(([k, t]) => (
          <button key={k} type="button" className="small" aria-pressed={filter === k} onClick={() => { setFilter(k); setSel(0); }}>{t} ({counts[k]})</button>
        ))}
      </div>
      <div className={`xr-body${showImage && current ? '' : ' solo'}`} style={{ marginTop: 10 }}>
        <ul ref={listRef} className="xr-list" tabIndex={0} aria-label="AI findings to review" aria-activedescendant={current ? `xr-${current.id}` : undefined}>
          {!items.length && <li className="xr-empty">{filter === 'not_charted' ? 'Nothing waiting — everything the AI saw is on the chart or decided.' : 'None.'}</li>}
          {items.map((it, i) => {
            const head = !patient && it.patient_id !== lastPatient;
            lastPatient = it.patient_id;
            return [
              head && (
                <li key={`p${it.patient_id}`} className="xr-group">
                  <Link to={`/patients/${it.patient_id}?tab=chart`}>{it.patient_name}</Link>
                  {it.start_time && <span>{String(it.start_time).slice(11, 16)}</span>}
                </li>
              ),
              <li
                key={it.id} id={`xr-${it.id}`} className={`xr-row ${it.chart.status}${current?.id === it.id ? ' on' : ''}`} aria-selected={current?.id === it.id}
                onClick={() => { setSel(i); setActive(true); }}
              >
                <i style={{ background: AI_COLOR[it.kind] }} />
                <div>
                  <div className="xr-sentence">{it.sentence}</div>
                  <div className="xr-meta">
                    {showConfidence && <>{pct(it.confidence)} · </>}
                    {it.note || it.label}
                    {it.chart.matched && <> · on the chart as {it.chart.matched.text}</>}
                    {' · '}x-ray {fmtDate(it.image_date)}
                  </div>
                </div>
                {canDecide && (
                  <div className="xr-actions">
                    <button type="button" className="small primary" onClick={(e) => { e.stopPropagation(); decide(it, 'accepted'); }} title={it.tooth ? 'Accept and chart it (A)' : 'Accept (A)'}><Check size={14} aria-hidden /> {it.chart.status === 'charted' ? 'Confirm' : it.tooth ? 'Chart it' : 'Accept'}</button>
                    <button type="button" className="small" onClick={(e) => { e.stopPropagation(); decide(it, 'rejected'); }} title="Dismiss (D)"><X size={14} aria-hidden /> Dismiss</button>
                  </div>
                )}
              </li>,
            ];
          })}
        </ul>
        {showImage && current && (
          <div>
            <XrayImage documentId={current.document_id} findings={[current]} highlight={current.id} showConfidence={showConfidence} label={(f) => `AI: ${f.label}${f.tooth ? ` #${f.tooth}` : ''}${f.surfaces ? ` ${f.surfaces}` : ''}`} />
            <div className="xr-image-bar">
              <label className="checkbox"><input type="checkbox" checked={showConfidence} onChange={(e) => setShowConfidence(e.target.checked)} /> Confidence</label>
              <span>{engine?.label}{engine?.cleared ? ' · FDA-cleared' : ''}</span>
            </div>
          </div>
        )}
      </div>
      <div className="xr-keys" aria-hidden>
        <span><kbd>J</kbd>/<kbd>K</kbd> move</span>{canDecide && <><span><kbd>A</kbd> accept</span><span><kbd>D</kbd> dismiss</span></>}<span><kbd>V</kbd> image</span><span><kbd>C</kbd> confidence</span><span><kbd>P</kbd> show the patient</span>
        {!page && !active && <span>— click the list or press <kbd>R</kbd> first</span>}
      </div>
      {chairFor && <XrayChairScreen patientId={chairFor} onClose={() => setChairFor(null)} />}
    </div>
  );
}
