import { useEffect, useRef, useState } from 'react';
import { MonitorUp, Pointer } from 'lucide-react';
import { api } from '../../api.js';
import { ErrorBox } from '../ui.jsx';
import { toast } from '../../toast.js';
import CompareBoard from './CompareBoard.jsx';

// Options for one problem side by side (F6), on the staff screen. "Show patient" opens the patient's own window —
// meant for the second monitor of this same computer (operatory or desk): placed there automatically where the
// browser offers the Window Management API (getScreenDetails), otherwise drag it across and press F11. The
// staff screen stays in control: "Point to this" highlights an option on the patient's window, and what the
// patient taps or signs comes back here — all through a BroadcastChannel between the two windows (same machine,
// nothing leaves the computer). The patient's choice then goes through the usual accept and sign (F4).
async function secondScreen() {
  try {
    if (!('getScreenDetails' in window)) return null;
    const details = await window.getScreenDetails();
    return details.screens.find((sc) => sc !== details.currentScreen) || null;
  } catch { return null; } // permission refused or not supported: the manual way
}

export default function StaffCompare({ plan, onChange }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [pointed, setPointed] = useState(null);
  const [patientSays, setPatientSays] = useState(null);
  const [open, setOpen] = useState(false);
  const channel = useRef(null);
  const refresh = useRef(onChange);
  refresh.current = onChange;
  useEffect(() => {
    api.get(`/treatment-plans/${plan.id}/compare`).then(setData).catch(setErr);
  }, [plan.id, plan.status, plan.signed_at]);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const ch = new BroadcastChannel(`dm-compare-${plan.id}`);
    channel.current = ch;
    ch.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'opened') setOpen(true);
      if (m.type === 'picked') setPatientSays({ picked: m.plan_id });
      if (m.type === 'signed') { setPatientSays((was) => ({ ...was, signed: true })); toast('The patient signed their choice'); refresh.current?.(); }
    };
    return () => ch.close();
  }, [plan.id]);
  if (err) return <ErrorBox error={err} />;
  if (!data || data.options.length < 2) return null;
  const label = (id) => data.options.find((o) => o.plan_id === id)?.label;

  const show = async () => {
    setErr(null);
    // Open the window now, while the click still counts (browsers block pop-ups opened later), then fill it.
    const w = window.open('about:blank', `dm-patient-${plan.id}`, 'popup,width=1280,height=860');
    try {
      const r = await api.post(`/treatment-plans/${plan.id}/present`, { here: true });
      const path = `${new URL(r.url, window.location.origin).pathname}?compare=${plan.id}#here=${encodeURIComponent(r.handoff)}`;
      if (!w) { toast('Allow pop-ups for this site to show the patient screen', { tone: 'error' }); return; }
      const sc = await secondScreen();
      if (sc) {
        try { w.moveTo(sc.availLeft, sc.availTop); w.resizeTo(sc.availWidth, sc.availHeight); } catch { /* the browser keeps it where it is */ }
      } else toast('Drag the patient window to the second screen, then press F11 (or tap “Full screen”)');
      w.location.href = path;
    } catch (e) { w?.close(); setErr(e); }
  };
  const point = (id) => {
    setPointed(id);
    channel.current?.postMessage({ type: 'highlight', plan_id: id });
  };

  return (
    <div className="cmp-staff">
      <div className="cmp-staff-head">
        <h4>Compare options</h4>
        <button type="button" className="small primary" onClick={show}><MonitorUp size={14} aria-hidden="true" /> Show patient</button>
        {open && <span className="muted" style={{ fontSize: 12.5 }}>Patient screen open — point to an option to highlight it there.</span>}
        {patientSays?.picked && <span className="badge ok">Patient chose {label(patientSays.picked)}</span>}
        {patientSays?.signed && <span className="badge ok">Signed</span>}
      </div>
      <CompareBoard options={data.options} staff highlight={pointed} onChoose={point}
        chooseLabel={(o) => <><Pointer size={14} aria-hidden="true" /> Point to {o.label}</>} />
    </div>
  );
}
