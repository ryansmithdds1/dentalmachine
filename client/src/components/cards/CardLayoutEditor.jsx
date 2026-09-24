import { useEffect, useMemo, useState } from 'react';
import { X, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Plus } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { toast } from '../../toast.js';
import CardLines, { DEFAULT_LAYOUT, ITEMS, ITEM_KEYS } from './CardBody.jsx';
import { refreshCards } from './cardData.js';
import './cards.css';

// "Customize cards" (S6): pick and order what each appointment card shows, with a live preview. Separate lines for
// short visits (when space is tight), colour by type / provider / status, the office's own labels. Saved for the
// whole office (administrators) or just for me. Opened from the schedule (the cards button in its corner) and from
// Settings → Schedule → Appointment cards. Keyboard: Tab to an item, ← → to move it along its line, ↑ ↓ between
// lines, Delete to take it off.
const ICONISH = new Set(['medical_alert', 'name', 'preferred_name', 'age', 'birthday', 'new_patient', 'confirmation', 'no_show_risk', 'ready', 'asap', 'recurring', 'insurance', 'readiness', 'opportunity', 'wait', 'late', 'urgent_prefs', 'strikes', 'doctor_note', 'forms', 'labels']);
const clone = (l) => JSON.parse(JSON.stringify(l));
const COLORS = ['#dc2626', '#d97706', '#16a34a', '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#64748b'];

const SAMPLE = (minutes) => ({
  id: -1, first_name: 'Maria', last_name: 'Lopez', preferred_name: 'Mia', dob: '1987-06-14', status: 'confirmed', start_time: '2030-06-14 09:00',
  end_time: `2030-06-14 ${String(9 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`, type_name: minutes > 30 ? 'Crown prep' : 'Recheck',
  provider_name: 'Dr. Ann Lee', operatory_name: 'Op 2', production: minutes > 30 ? 135000 : 0, procedure_summary: minutes > 30 ? 'D2740 #30, D0220' : '', medical_alerts: 'Latex allergy',
  eligibility: { status: 'active', checked_at: new Date().toISOString() }, notes: 'Prefers the window chair', asap: 0, type_color: '#2563eb', provider_color: '#0d9488',
  no_show_risk: { percent: 34, level: 'some', reasons: ['2 missed visits in the past year'] },
});
const SAMPLE_X = (layout) => ({
  prefs: [{ label: 'Blanket', urgent: true }, { label: 'Headphones / music', urgent: false }], strikes: { count: 1, list: [{ happened_on: '2030-05-02', kind: 'move', reason_label: 'Provider sick' }] },
  notes: [{ id: 1, by: 'Dr. Lee', body: 'Book the crown seat next', status: 'open' }], new_patient: true, balance: 4500, personal: null, labels: (layout.labels || []).slice(0, 1).map((l) => l.key),
});

function Preview({ layout, minutes }) {
  const a = SAMPLE(minutes);
  const pxPerMin = 1.5;
  const h = minutes * pxPerMin;
  const s = 540;
  return (
    <div className="cle-preview-col">
      <div className="muted">{minutes}-minute visit</div>
      <div className={`cal-appt status-${a.status} cle-sample`} style={{ height: Math.max(h - 2, 14), '--c': a.type_color, '--p': a.provider_color }} aria-hidden="true">
        <CardLines layout={layout} a={a} col={{ date: '2030-06-14', isToday: false, showProvider: false }} s={s} e={s + minutes} h={h} nowMin={null} now={null} lt={null} x={SAMPLE_X(layout)} />
      </div>
    </div>
  );
}

export default function CardLayoutEditor({ onClose, inline = false }) {
  const { user } = useAuth();
  const [info, setInfo] = useState(null);
  const [layout, setLayout] = useState(null);
  const [mode, setMode] = useState('regular'); // regular | compact
  const [busy, setBusy] = useState(false);
  const [labelText, setLabelText] = useState('');
  useEffect(() => {
    api.get('/card-layout').then((d) => { setInfo(d); setLayout(clone({ ...DEFAULT_LAYOUT, ...d.effective, compact: { ...DEFAULT_LAYOUT.compact, ...(d.effective.compact || {}) } })); })
      .catch((err) => toast(err.message, { tone: 'error' }));
  }, []);
  useEffect(() => {
    if (inline) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest?.('.cle-item')) { e.stopPropagation(); onClose?.(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, inline]);
  const lines = useMemo(() => (layout ? (mode === 'compact' ? layout.compact.lines : layout.lines) : []), [layout, mode]);
  const setLines = (next) => setLayout((l) => (mode === 'compact' ? { ...l, compact: { ...l.compact, lines: next } } : { ...l, lines: next }));
  const onCard = new Set(lines.flat());
  const toggle = (k) => {
    if (onCard.has(k)) return setLines(lines.map((l) => l.filter((x) => x !== k)).filter((l, i) => l.length || i === 0));
    const target = ICONISH.has(k) ? 0 : Math.max(1, lines.length - 1);
    const next = clone(lines);
    while (next.length <= target) next.push([]);
    next[target].push(k);
    setLines(next);
  };
  const move = (k, dx, dy) => {
    const next = clone(lines);
    const li = next.findIndex((l) => l.includes(k));
    if (li < 0) return;
    const i = next[li].indexOf(k);
    if (dx) {
      const j = i + dx;
      if (j < 0 || j >= next[li].length) return;
      [next[li][i], next[li][j]] = [next[li][j], next[li][i]];
    } else {
      const to = li + dy;
      if (to < 0 || to > 5) return;
      next[li].splice(i, 1);
      while (next.length <= to) next.push([]);
      next[to].push(k);
    }
    setLines(next.filter((l, n) => l.length || n === 0));
    setTimeout(() => document.querySelector(`.cle-item[data-item="${k}"]`)?.focus(), 0);
  };
  const save = async (scope) => {
    setBusy(true);
    const body = { layout: { ...layout, lines: layout.lines.filter((l) => l.length), compact: { ...layout.compact, lines: layout.compact.lines.filter((l) => l.length) } } };
    try {
      const d = await api.put(scope === 'office' ? '/card-layout' : '/me/card-layout', body);
      setInfo((i) => ({ ...i, ...d }));
      refreshCards();
      toast(scope === 'office' ? 'Cards updated for everyone' : 'Cards updated for you');
      if (!inline) onClose?.();
    } catch (err) { toast(err.message, { tone: 'error' }); } finally { setBusy(false); }
  };
  const reset = async (scope) => {
    setBusy(true);
    try {
      const d = await api.put(scope === 'office' ? '/card-layout' : '/me/card-layout', { layout: null });
      setInfo((i) => ({ ...i, ...d }));
      setLayout(clone({ ...DEFAULT_LAYOUT, ...d.effective }));
      refreshCards();
      toast(scope === 'office' ? 'Office cards back to the standard layout' : 'Using the office’s cards again');
    } catch (err) { toast(err.message, { tone: 'error' }); } finally { setBusy(false); }
  };
  const addLabel = () => {
    const text = labelText.trim();
    if (!text) return;
    setLayout((l) => ({ ...l, labels: [...(l.labels || []), { key: text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), text, color: COLORS[(l.labels || []).length % COLORS.length] }] }));
    setLabelText('');
  };
  const admin = user?.role === 'admin';
  const body = !layout ? <div className="muted">Loading…</div> : (
    <div className="cle">
      <div className="cle-top">
        <div className="seg" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'regular'} className={mode === 'regular' ? 'active' : ''} onClick={() => setMode('regular')}>Regular visits</button>
          <button type="button" role="tab" aria-selected={mode === 'compact'} className={mode === 'compact' ? 'active' : ''} onClick={() => setMode('compact')}>Short visits</button>
        </div>
        {mode === 'compact' && (
          <label className="checkbox">
            <input type="checkbox" checked={!!layout.compact.enabled} onChange={(e) => setLayout({ ...layout, compact: { ...layout.compact, enabled: e.target.checked } })} />
            Use these lines for visits up to
            <select value={layout.compact.max_minutes} onChange={(e) => setLayout({ ...layout, compact: { ...layout.compact, max_minutes: Number(e.target.value) } })} aria-label="Short visit length">
              {[15, 20, 30, 40, 45, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="cle-lines" aria-label="Card lines">
        {lines.map((l, i) => (
          <div key={i} className="cle-line">
            <span className="cle-line-no">{i === 0 ? 'Top' : `Line ${i + 1}`}</span>
            {l.map((k) => (
              <span key={k} className="cle-item" data-item={k} tabIndex={0} role="button" aria-label={`${ITEMS[k]?.[0] || k}: arrows move it, Delete removes it`}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') { e.preventDefault(); move(k, -1, 0); } else if (e.key === 'ArrowRight') { e.preventDefault(); move(k, 1, 0); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(k, 0, -1); } else if (e.key === 'ArrowDown') { e.preventDefault(); move(k, 0, 1); } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); toggle(k); }
                }}>
                {ITEMS[k]?.[0] || k}
                <button type="button" tabIndex={-1} onClick={() => move(k, -1, 0)} aria-label="Earlier"><ArrowLeft size={11} /></button>
                <button type="button" tabIndex={-1} onClick={() => move(k, 1, 0)} aria-label="Later"><ArrowRight size={11} /></button>
                <button type="button" tabIndex={-1} onClick={() => move(k, 0, -1)} aria-label="Line up"><ArrowUp size={11} /></button>
                <button type="button" tabIndex={-1} onClick={() => move(k, 0, 1)} aria-label="Line down"><ArrowDown size={11} /></button>
                <button type="button" tabIndex={-1} onClick={() => toggle(k)} aria-label="Take it off"><X size={11} /></button>
              </span>
            ))}
            {!l.length && <span className="muted">(empty)</span>}
          </div>
        ))}
      </div>
      <div className="cle-body">
        <div className="cle-items" aria-label="What cards can show">
          {ITEM_KEYS.map((k) => (
            <label key={k} className="checkbox cle-check" title={ITEMS[k][1]}>
              <input type="checkbox" checked={onCard.has(k)} onChange={() => toggle(k)} /> {ITEMS[k][0]}
            </label>
          ))}
        </div>
        <div className="cle-preview" aria-label="Preview">
          <Preview layout={mode === 'compact' ? { ...layout, compact: { ...layout.compact, enabled: true } } : { ...layout, compact: { ...layout.compact, enabled: false } }} minutes={mode === 'compact' ? Math.min(30, layout.compact.max_minutes) : 60} />
          {mode === 'regular' && layout.compact.enabled && <Preview layout={layout} minutes={Math.min(20, layout.compact.max_minutes)} />}
        </div>
      </div>
      <div className="cle-row">
        <label>Colour cards by
          <select value={layout.color_by || ''} onChange={(e) => setLayout({ ...layout, color_by: e.target.value || null })}>
            <option value="">The schedule’s setting</option><option value="type">Visit type</option><option value="provider">Provider</option><option value="status">Status</option>
          </select>
        </label>
      </div>
      <div className="cle-row cle-labels">
        <span>Office labels</span>
        {(layout.labels || []).map((l, i) => (
          <span key={l.key} className="cc-labels"><i style={{ '--l': l.color }}>{l.text}</i>
            {admin && <button type="button" className="icon-btn tiny" aria-label={`Remove ${l.text}`} onClick={() => setLayout({ ...layout, labels: layout.labels.filter((_, j) => j !== i) })}><X size={11} /></button>}</span>
        ))}
        {admin && (
          <form className="inline" onSubmit={(e) => { e.preventDefault(); addLabel(); }}>
            <input value={labelText} maxLength={24} onChange={(e) => setLabelText(e.target.value)} placeholder="VIP, Bring x-rays…" aria-label="New label" />
            <button type="submit" className="small" disabled={!labelText.trim()}><Plus size={12} /> Add</button>
          </form>
        )}
        {!admin && !(layout.labels || []).length && <span className="muted">An administrator can add the office’s own labels.</span>}
      </div>
      <div className="drawer-actions cle-save">
        {admin && <button type="button" className="primary" disabled={busy} onClick={() => save('office')}>Save for everyone</button>}
        <button type="button" className={admin ? '' : 'primary'} disabled={busy} onClick={() => save('me')}>Save just for me</button>
        {info?.mine && <button type="button" className="link-button" disabled={busy} onClick={() => reset('me')}>Use the office’s cards</button>}
        {admin && info?.practice && <button type="button" className="link-button" disabled={busy} onClick={() => reset('office')}>Back to the standard cards</button>}
      </div>
    </div>
  );
  if (inline) return <div className="card cle-card"><h3>Appointment cards</h3>{body}</div>;
  return (
    <aside className="drawer cle-panel" role="dialog" aria-label="Customize cards">
      <div className="drawer-head"><h2 style={{ margin: 0 }}>Customize cards</h2><button className="small" onClick={onClose} aria-label="Close"><X size={14} /></button></div>
      <div className="drawer-body">{body}</div>
    </aside>
  );
}
