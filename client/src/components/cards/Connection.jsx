import { useEffect, useRef, useState } from 'react';
import { HandHeart, MessageCircleHeart, CalendarX2, AlertCircle, Plus, X, History } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { toast } from '../../toast.js';
import { fmtUtcDateTime } from '../../format.js';
import { useConnection, refreshCards, strikeLabel, strikeTitle } from './cardData.js';
import './cards.css';

// Preferences (PP1), personal connection notes (PP2) and "moved by us" strikes (S8) for one patient: in the
// patient bar (compact), the chart header and the visit panel. Adding a preference is two clicks: open the list,
// press "Urgent" (or "Add") beside one.
const CATEGORY = { comfort: 'Comfort', care: 'Care', scheduling: 'Scheduling', other: 'Other' };
const newKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function useOutside(open, close) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) close(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, [open, close]);
  return ref;
}

let optionsCache = null;
export function PrefsPicker({ patientId, prefs, onClose }) {
  const { can, user } = useAuth();
  const [options, setOptions] = useState(optionsCache);
  const [busy, setBusy] = useState(null);
  const [own, setOwn] = useState('');
  useEffect(() => { api.get('/preference-options').then((o) => { optionsCache = o; setOptions(o); }).catch(() => setOptions([])); }, []);
  const w = can('patients:write');
  const mine = Object.fromEntries((prefs || []).map((p) => [p.option_id, p]));
  const run = async (id, fn) => {
    setBusy(id);
    try { await fn(); refreshCards(); } catch (err) { toast(err.message, { tone: 'error' }); } finally { setBusy(null); }
  };
  const add = (o, urgent) => run(o.id, async () => {
    await api.post(`/patients/${patientId}/preferences`, { option_id: o.id, urgent });
    toast(`${o.label}${urgent ? ' (urgent)' : ''} added`);
  });
  const flip = (p) => run(p.option_id, () => api.put(`/patient-preferences/${p.id}`, { urgent: !p.urgent }));
  const remove = (p) => run(p.option_id, async () => {
    await api.post(`/patient-preferences/${p.id}/remove`, {});
    toast(`${p.label} removed`, { undo: () => api.post(`/patients/${patientId}/preferences`, { option_id: p.option_id, urgent: p.urgent }).then(refreshCards) });
  });
  // Administrators add the office's own preference to the list (and to this patient) right here.
  const addOwn = () => run('own', async () => {
    const o = await api.post('/preference-options', { label: own.trim(), category: 'other' });
    optionsCache = null;
    setOptions((list) => (list || []).some((x) => x.id === o.id) ? list : [...(list || []), o]);
    await api.post(`/patients/${patientId}/preferences`, { option_id: o.id });
    setOwn('');
  });
  const groups = Object.keys(CATEGORY).map((c) => [c, (options || []).filter((o) => o.category === c)]).filter(([, l]) => l.length);
  return (
    <div className="pp-picker" role="dialog" aria-label="Preferences">
      <div className="pp-head"><strong>Preferences</strong><button type="button" className="icon-btn tiny" onClick={onClose} aria-label="Close"><X size={14} /></button></div>
      {!options && <div className="muted">Loading…</div>}
      {groups.map(([c, list]) => (
        <div key={c} className="pp-group">
          <div className="pp-cat">{CATEGORY[c]}</div>
          {list.map((o) => {
            const p = mine[o.id];
            return (
              <div key={o.id} className={`pp-row${p ? ' on' : ''}${p?.urgent ? ' urgent' : ''}`} data-option={o.label}>
                <span className="pp-label">{o.label}</span>
                {w && !p && (
                  <>
                    <button type="button" className="small" disabled={busy === o.id} onClick={() => add(o, false)} aria-label={`Add ${o.label}`}><Plus size={13} /> Add</button>
                    <button type="button" className="small pp-urgent-btn" disabled={busy === o.id} onClick={() => add(o, true)} aria-label={`Add ${o.label} as urgent`}><AlertCircle size={13} /> Urgent</button>
                  </>
                )}
                {w && p && (
                  <>
                    <button type="button" className={`small pp-urgent-btn${p.urgent ? ' active' : ''}`} aria-pressed={!!p.urgent} disabled={busy === o.id} onClick={() => flip(p)}>{p.urgent ? 'Urgent ✓' : 'Mark urgent'}</button>
                    <button type="button" className="icon-btn tiny" disabled={busy === o.id} onClick={() => remove(p)} aria-label={`Remove ${o.label}`}><X size={13} /></button>
                  </>
                )}
                {!w && p && <span className="muted">{p.urgent ? 'urgent' : 'yes'}</span>}
              </div>
            );
          })}
        </div>
      ))}
      {user?.role === 'admin' && w ? (
        <form className="pn-add" onSubmit={(e) => { e.preventDefault(); if (own.trim()) addOwn(); }}>
          <input value={own} maxLength={60} onChange={(e) => setOwn(e.target.value)} placeholder="Add the office’s own…" aria-label="New preference for the office’s list" />
          <button className="small" disabled={!own.trim() || busy === 'own'}><Plus size={13} /> Add</button>
        </form>
      ) : <div className="muted pp-foot">The office’s list — an administrator can add to it.</div>}
    </div>
  );
}

export function PersonalBox({ patientId, latest, onClose }) {
  const { can, practice } = useAuth();
  const [text, setText] = useState('');
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const load = () => api.get(`/patients/${patientId}/personal-notes?all=1`).then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, [patientId]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await api.post(`/patients/${patientId}/personal-notes`, { body: text.trim(), client_key: key.current });
      key.current = newKey();
      setText('');
      refreshCards();
      load();
      toast('Personal note saved');
    } catch (err) { toast(err.message, { tone: 'error' }); } finally { setBusy(false); }
  };
  const remove = async (n) => {
    try {
      await api.post(`/personal-notes/${n.id}/remove`, {});
      refreshCards();
      load();
    } catch (err) { toast(err.message, { tone: 'error' }); }
  };
  return (
    <div className="pp-picker personal" role="dialog" aria-label="Personal notes">
      <div className="pp-head"><strong>Personal notes</strong><button type="button" className="icon-btn tiny" onClick={onClose} aria-label="Close"><X size={14} /></button></div>
      {can('patients:write') && (
        <form className="pn-add" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input autoFocus value={text} maxLength={280} onChange={(e) => setText(e.target.value)} placeholder={latest ? 'Something new? (new dog, a trip, a wedding…)' : 'New dog, went to Disneyland…'} aria-label="Personal note" />
          <button className="primary small" disabled={!text.trim() || busy}>Save</button>
        </form>
      )}
      <ul className="pn-timeline">
        {list?.map((n) => (
          <li key={n.id} className={n.removed_at ? 'removed' : ''}>
            <span className="pn-body">{n.body}</span>
            <span className="muted"> — {n.by_name || 'someone'}, {fmtUtcDateTime(n.created_at, practice?.timezone)}{n.removed_at ? ` · removed by ${n.removed_by_name || 'someone'}` : ''}</span>
            {!n.removed_at && can('patients:write') && <button type="button" className="icon-btn tiny" onClick={() => remove(n)} aria-label="Remove this note" title="Remove (kept in the history)"><X size={12} /></button>}
          </li>
        ))}
        {list && !list.length && <li className="muted">No personal notes yet.</li>}
      </ul>
    </div>
  );
}

export function StrikeBadge({ strikes, warning }) {
  if (!strikes?.count) return null;
  return (
    <span className="cc-strike-badge" title={`${warning ? `${warning}\n` : ''}${strikeTitle(strikes)}`} data-strikes={strikes.count}>
      <CalendarX2 size={13} aria-hidden /> {strikeLabel(strikes)}
    </span>
  );
}

// Standalone badge for booking / move dialogs: <MovedByUsBadge patientId={id} />.
export function MovedByUsBadge({ patientId }) {
  const c = useConnection(patientId);
  return c ? <StrikeBadge strikes={c.strikes} warning={c.strike_warning} /> : null;
}

// The row of chips: urgent preferences (or a quiet "Preferences"), strikes, and the latest personal note.
// compact: the patient bar. full: the chart header (personal note always shown).
export default function ConnectionChips({ patientId, compact = false }) {
  const c = useConnection(patientId);
  const [open, setOpen] = useState(null);
  const close = () => setOpen(null);
  const ref = useOutside(!!open, close);
  if (!patientId) return null;
  const prefs = c?.prefs || [];
  const urgent = prefs.filter((p) => p.urgent);
  const allTitle = prefs.length ? prefs.map((p) => `${p.label}${p.urgent ? ' (urgent)' : ''}${p.note ? ` — ${p.note}` : ''}`).join('\n') : 'No preferences yet';
  return (
    <span className={`cc-row${compact ? ' compact' : ''}`} ref={ref}>
      <span className="cc-anchor">
        <button type="button" className={`cc-prefs${urgent.length ? ' urgent' : ''}`} title={allTitle} aria-label={urgent.length ? `Urgent preferences: ${urgent.map((p) => p.label).join(', ')}` : 'Preferences'} aria-expanded={open === 'prefs'}
          onClick={() => setOpen(open === 'prefs' ? null : 'prefs')} data-urgent-prefs={urgent.length}>
          <HandHeart size={14} aria-hidden />
          {urgent.length ? <b>{urgent.map((p) => p.label).join(', ')}</b> : <span>{prefs.length ? `${prefs.length} preference${prefs.length === 1 ? '' : 's'}` : 'Preferences'}</span>}
        </button>
        {open === 'prefs' && <PrefsPicker patientId={patientId} prefs={prefs} onClose={close} />}
      </span>
      {c?.strikes?.count ? <StrikeBadge strikes={c.strikes} warning={c.strike_warning} /> : null}
      <span className="cc-anchor">
        <button type="button" className="cc-personal-chip" title={c?.personal ? `${c.personal.body} — ${c.personal.by || ''}` : 'Add a personal note (new dog, a trip…)'} aria-expanded={open === 'personal'}
          onClick={() => setOpen(open === 'personal' ? null : 'personal')}>
          <MessageCircleHeart size={14} aria-hidden />
          {c?.personal ? <span className="cc-personal-text">{compact && c.personal.body.length > 32 ? `${c.personal.body.slice(0, 32)}…` : c.personal.body}</span> : <span>Personal</span>}
          {!compact && c?.personal && <History size={12} aria-hidden className="muted" />}
        </button>
        {open === 'personal' && <PersonalBox patientId={patientId} latest={c?.personal} onClose={close} />}
      </span>
    </span>
  );
}
