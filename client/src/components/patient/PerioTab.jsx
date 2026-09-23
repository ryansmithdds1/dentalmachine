import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import { parseSpeech, speechSupported } from './voicePerio.js';

const UPPER = Array.from({ length: 16 }, (_, i) => String(i + 1));
const LOWER = Array.from({ length: 16 }, (_, i) => String(32 - i));
const SITES = ['DB', 'B', 'MB', 'DL', 'L', 'ML'];
const MOLARS = new Set(['1', '2', '3', '14', '15', '16', '17', '18', '19', '30', '31', '32']);
// Readings are stored distal→mesial ([DB, B, MB, DL, L, ML]). On screen, mesial always faces the midline,
// so on the patient's left (teeth 9-24) each tooth's sites display the other way round.
const siteOrder = (tooth, from) => (Number(tooth) >= 9 && Number(tooth) <= 24 ? [from + 2, from + 1, from] : [from, from + 1, from + 2]);
const depthColor = (d) => (d == null || d === '' ? undefined : d >= 5 ? 'var(--danger)' : d === 4 ? 'var(--warn)' : undefined);
const num = (v) => (v === '' || v == null ? null : Number(v));
const blank = () => ({ pd: Array(6).fill(''), gm: Array(6).fill(''), bop: Array(6).fill(false), sup: Array(6).fill(false), plaque: Array(6).fill(false), furc: Array(6).fill(''), mob: '' });
const fromSaved = (v = {}) => ({
  ...blank(), missing: !!v.missing,
  ...Object.fromEntries(['pd', 'gm', 'furc'].filter((k) => v[k]).map((k) => [k, v[k].map((d) => (d == null ? '' : String(d)))])),
  ...Object.fromEntries(['bop', 'sup', 'plaque'].filter((k) => v[k]).map((k) => [k, v[k].map(Boolean)])),
  mob: v.mob == null ? '' : String(v.mob),
});
// Clinical attachment level: probing depth plus recession (gingival margin below the CEJ).
export const cal = (pd, gm) => (pd === '' || pd == null ? null : Number(pd) + (gm === '' || gm == null ? 0 : Number(gm)));

// The probing path: upper facial 1→16, upper lingual 16→1, lower lingual 17→32, lower facial 32→17,
// each tooth's sites in the order they sit on screen.
function probingPath(missing) {
  const path = [];
  const add = (teeth, from, reverse) => {
    for (const t of teeth) {
      if (missing.has(t)) continue;
      const order = siteOrder(t, from);
      path.push(...(reverse ? [...order].reverse() : order).map((i) => `${t}:${i}`));
    }
  };
  add(UPPER, 0, false);
  add([...UPPER].reverse(), 3, true);
  add([...LOWER].reverse(), 3, true);
  add(LOWER, 0, false);
  return path;
}

const MARKERS = [['bop', 'Bleeding', 'var(--danger)'], ['sup', 'Suppuration', '#ca8a04'], ['plaque', 'Plaque', '#2563eb']];

// One tooth's side as a picture: crown toward the tooth numbers, the gum line (blue) and the bottom of each
// pocket (red) drawn from the CEJ at 3 units per mm, with the pocket shaded. Deep pockets show at a glance.
const MM = 3;
function PerioTooth({ tooth, sites, v, rootsUp }) {
  const molar = MOLARS.has(tooth);
  const xs = [14, 30, 46];
  const val = (list, i) => (list[i] === '' || list[i] == null || list[i] === '-' ? null : Number(list[i]));
  const gm = sites.map((i) => val(v.gm, i) ?? 0);
  const pd = sites.map((i) => val(v.pd, i));
  const has = pd.some((d) => d != null);
  const gy = gm.map((g) => 20 + g * MM);
  const py = pd.map((d, k) => gy[k] + (d ?? 0) * MM);
  const deep = pd.some((d) => d >= 5) ? 'deep' : pd.some((d) => d === 4) ? 'watch' : '';
  const roots = molar ? 'M12 20 C12 44 16 66 21 69 C25 66 27 46 28 28 L32 28 C33 46 35 66 39 69 C44 66 48 44 48 20' : 'M17 20 C17 44 24 68 30 70 C36 68 43 44 43 20';
  return (
    <svg className="perio-tooth" viewBox="0 0 60 72" preserveAspectRatio="none" aria-hidden="true">
      <g transform={rootsUp ? 'translate(0 72) scale(1 -1)' : undefined}>
        <path d={roots} className="pt-root" />
        <path d="M9 20 C8 12 9 4 16 2 L44 2 C51 4 52 12 51 20 Z" className="pt-crown" />
        <line x1="6" x2="54" y1="20" y2="20" className="pt-cej" />
        {has && <polygon className={`pt-pocket ${deep}`} points={[...xs.map((x, k) => `${x},${gy[k]}`), ...[...xs].reverse().map((x, k) => `${x},${py[2 - k]}`)].join(' ')} />}
        {has && <polyline className="pt-gm" points={xs.map((x, k) => `${x},${gy[k]}`).join(' ')} />}
        {has && <polyline className="pt-pd" points={xs.map((x, k) => `${x},${py[k]}`).join(' ')} />}
        {sites.map((i, k) => v.bop[i] && <circle key={i} cx={xs[k]} cy={py[k]} r="2.6" className="pt-bleed" />)}
      </g>
    </svg>
  );
}

export default function PerioTab({ patient }) {
  const { can } = useAuth();
  const { data: exams, reload } = useApi(`/patients/${patient.id}/perio`);
  const { data: chart } = useApi(`/patients/${patient.id}/chart`);
  const [readings, setReadings] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [compareId, setCompareId] = useState('');
  const [row, setRow] = useState('pd');
  const [marker, setMarker] = useState('');
  const [auto, setAuto] = useState(true);
  const [notes, setNotes] = useState('');
  const refs = useRef({});
  const pending = useRef(null);

  // Missing teeth are greyed out and skipped.
  const chartMissing = useMemo(() => new Set((chart?.conditions || []).filter((c) => c.condition === 'missing' && !c.resolved).map((c) => c.tooth)), [chart]);
  const shown = viewing ? Object.fromEntries(Object.entries(viewing.readings).map(([t, v]) => [t, fromSaved(v)])) : readings;
  const isMissing = (t) => (viewing ? !!shown[t]?.missing : chartMissing.has(t) || !!readings[t]?.missing);
  const missingSet = useMemo(() => new Set([...UPPER, ...LOWER].filter(isMissing)), [viewing, readings, chartMissing]); // eslint-disable-line react-hooks/exhaustive-deps
  const path = useMemo(() => probingPath(missingSet), [missingSet]);
  const editable = !viewing && can('clinical:write');
  const compare = exams?.find((x) => String(x.id) === String(compareId)) || null;
  const get = (t) => shown[t] || blank();

  const put = (t, patch) => setReadings((r) => ({ ...r, [t]: { ...(r[t] || blank()), ...patch } }));
  const setSite = (t, key, i, value) => {
    const list = [...get(t)[key]];
    list[i] = value;
    put(t, { [key]: list });
  };
  const focus = (key) => refs.current[`${row}:${key}`]?.focus();
  const advance = (t, i) => {
    const at = path.indexOf(`${t}:${i}`);
    if (at >= 0 && at < path.length - 1) focus(path[at + 1]);
  };
  // Digits advance to the next site. A 1 waits a moment for a second digit (10-15mm).
  const onKey = (t, i, key) => (e) => {
    if (!/^\d$/.test(e.key)) {
      if ((e.key === ' ' || e.key === 'Enter') && auto) { e.preventDefault(); advance(t, i); }
      return;
    }
    e.preventDefault();
    const k = `${t}:${i}`;
    const cur = String(get(t)[key][i] ?? '');
    // Overgrowth: a gingival margin above the CEJ is typed with a leading minus.
    if (cur === '-') {
      setSite(t, key, i, `-${e.key}`);
      if (auto) advance(t, i);
      return;
    }
    if (pending.current?.k === k && cur === '1' && Number(`1${e.key}`) <= 15) {
      clearTimeout(pending.current.timer);
      pending.current = null;
      setSite(t, key, i, `1${e.key}`);
      if (auto) advance(t, i);
      return;
    }
    setSite(t, key, i, e.key);
    if (!auto) return;
    if (e.key === '1') {
      pending.current = { k, timer: setTimeout(() => { pending.current = null; advance(t, i); }, 700) };
    } else advance(t, i);
  };
  const toggleMarker = (t, i) => marker && setSite(t, marker, i, !get(t)[marker][i]);

  // Voice charting: the browser's speech recognition hears numbers and a few commands and walks the probing path.
  const [voice, setVoice] = useState(null); // { cursor, heard }
  const recog = useRef(null);
  const cursor = useRef(0);
  const lastSite = useRef(null);
  const applyVoice = useRef(null);
  applyVoice.current = (text) => {
    const siteAt = (n) => path[n]?.split(':');
    for (const tok of parseSpeech(text)) {
      const [t, i] = siteAt(cursor.current) || [];
      if (tok.n != null) {
        if (!t) break;
        const v = String(Math.min(tok.n, 15));
        setReadings((r) => { const cur = r[t] || blank(); const list = [...cur[row]]; list[Number(i)] = v; return { ...r, [t]: { ...cur, [row]: list } }; });
        lastSite.current = [t, Number(i)];
        cursor.current++;
      } else if (['bop', 'sup', 'plaque'].includes(tok.cmd) && lastSite.current) {
        const [lt, li] = lastSite.current;
        setReadings((r) => { const cur = r[lt] || blank(); const list = [...cur[tok.cmd]]; list[li] = true; return { ...r, [lt]: { ...cur, [tok.cmd]: list } }; });
      } else if (tok.cmd === 'skip') cursor.current = Math.min(path.length - 1, cursor.current + 1);
      else if (tok.cmd === 'back') cursor.current = Math.max(0, cursor.current - 1);
      else if (tok.cmd === 'next_tooth' && t) {
        let n = cursor.current;
        while (n < path.length && path[n].split(':')[0] === t) n++;
        cursor.current = n;
      } else if (tok.cmd === 'missing' && t) put(t, { missing: true });
      else if (tok.cmd === 'stop') { recog.current?.stop(); break; }
    }
    setVoice((v) => v && { cursor: cursor.current, heard: text });
  };
  const startVoice = () => {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Rec();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => { for (let k = e.resultIndex; k < e.results.length; k++) if (e.results[k].isFinal) applyVoice.current(e.results[k][0].transcript); };
    rec.onend = () => { recog.current = null; setVoice(null); };
    rec.onerror = (e) => { if (e.error === 'not-allowed') window.alert('Allow the microphone for this site to chart by voice.'); };
    // Start at the first site without a reading in the row being charted.
    const first = path.findIndex((k) => { const [t, i] = k.split(':'); return (get(t)[row][i] ?? '') === ''; });
    cursor.current = first < 0 ? 0 : first;
    lastSite.current = null;
    recog.current = rec;
    rec.start();
    setVoice({ cursor: cursor.current, heard: '' });
  };
  useEffect(() => () => recog.current?.stop(), []);
  // "Start perio" said to the assistant: begin voice charting as soon as the exam is on screen.
  const startVoiceRef = useRef(startVoice);
  startVoiceRef.current = startVoice;
  useEffect(() => {
    const begin = () => {
      try { sessionStorage.removeItem('dm_perio_voice'); } catch { /* same tab only */ }
      if (recog.current || !speechSupported() || !can('clinical:write')) return;
      setViewing(null);
      setTimeout(() => startVoiceRef.current(), 250);
    };
    let asked = false;
    try { asked = sessionStorage.getItem('dm_perio_voice') === '1'; } catch { /* storage unavailable */ }
    if (asked && exams) begin();
    window.addEventListener('dm:perio-voice', begin);
    return () => window.removeEventListener('dm:perio-voice', begin);
  }, [exams]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (voice) focus(path[voice.cursor]); }, [voice]); // eslint-disable-line react-hooks/exhaustive-deps

  const { submit, busy, error } = useSubmit(async () => {
    const clean = {};
    for (const t of [...UPPER, ...LOWER]) {
      const v = readings[t];
      if (chartMissing.has(t) || v?.missing) { clean[t] = { missing: true }; continue; }
      if (!v) continue;
      const out = {};
      for (const k of ['pd', 'gm', 'furc']) if (v[k].some((d) => d !== '' && d !== '-')) out[k] = v[k].map((d) => (d === '-' ? null : num(d)));
      for (const k of ['bop', 'sup', 'plaque']) if (v[k].some(Boolean)) out[k] = v[k];
      if (v.mob !== '') out.mob = Number(v.mob);
      if (Object.keys(out).length) clean[t] = out;
    }
    if (editingId) await api.put(`/perio/${editingId}`, { readings: clean, notes });
    else await api.post(`/patients/${patient.id}/perio`, { readings: clean, notes });
    setReadings({});
    setEditingId(null);
    setNotes('');
    reload();
  });

  const startEdit = (exam) => {
    setReadings(Object.fromEntries(Object.entries(exam.readings).map(([t, v]) => [t, fromSaved(v)])));
    setNotes(exam.notes || '');
    setEditingId(exam.id);
    setViewing(null);
  };

  // An exam already started today (by someone else, or by voice through the assistant) opens ready to
  // carry on, rather than a blank new exam beside it.
  useEffect(() => {
    if (!exams?.length || viewing || editingId || Object.keys(readings).length) return;
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const started = exams.find((x) => x.exam_date === today);
    if (!started) return;
    if (can('clinical:write')) startEdit(started);
    else setViewing(started);
  }, [exams]); // eslint-disable-line react-hooks/exhaustive-deps

  const siteInput = (t, key, i, color) => {
    const v = get(t);
    const d = v[key][i];
    const prev = compare && key === 'pd' ? compare.readings[t]?.pd?.[i] : null;
    const change = prev != null && d !== '' ? Number(d) - prev : 0;
    const style = {
      color, background: key === 'pd' && v.bop[i] ? 'var(--danger-soft)' : undefined,
      boxShadow: change >= 2 ? 'inset 0 -2px 0 var(--danger)' : change <= -2 ? 'inset 0 -2px 0 var(--ok)' : undefined,
    };
    const title = `#${t} ${SITES[i]}${prev != null ? ` · was ${prev}mm on ${fmtDate(compare.exam_date)}` : ''}`;
    if (!editable) return <span key={i} className="perio-site" style={style} title={title}>{d === '' ? '·' : d}</span>;
    return (
      <input
        key={i} ref={(el) => { refs.current[`${key}:${t}:${i}`] = el; }} className="perio-site" value={d} readOnly={!!marker} inputMode="numeric" title={title}
        onKeyDown={onKey(t, i, key)}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const v = key === 'gm' && raw.startsWith('-') ? `-${raw.replace(/\D/g, '').slice(-2)}` : raw.replace(/\D/g, '').slice(-2);
          if (v === '' || v === '-' || (Number(v) <= 15 && Number(v) >= -10)) setSite(t, key, i, v);
        }}
        onClick={() => toggleMarker(t, i)} onFocus={() => setRow(key)} style={style}
      />
    );
  };

  const markerDots = (t, i) => {
    const v = get(t);
    const on = MARKERS.filter(([k]) => v[k][i]);
    return <span key={i} className="perio-dots">{on.map(([k, , c]) => <i key={k} style={{ background: c }} />)}</span>;
  };

  const renderArch = (teeth, upper) => {
    const side = (from, facial) => [
      facial && upper && ['Mobility', (t) => editable
        ? <input className="perio-site wide" value={get(t).mob} inputMode="numeric" onChange={(e) => /^[0-3]?$/.test(e.target.value) && put(t, { mob: e.target.value })} title={`#${t} mobility (0-3)`} />
        : <span className="perio-site wide">{get(t).mob || '·'}</span>],
      ['Furcation', (t) => (MOLARS.has(t) ? [from + 1].map((i) => (editable
        ? <input key={i} className="perio-site wide" value={get(t).furc[i]} onChange={(e) => /^[0-3]?$/.test(e.target.value) && setSite(t, 'furc', i, e.target.value)} title={`#${t} ${SITES[i]} furcation grade (0-3)`} />
        : <span key={i} className="perio-site wide">{get(t).furc[i] || '·'}</span>)) : null)],
      ['Margin', (t) => siteOrder(t, from).map((i) => siteInput(t, 'gm', i))],
      ['Depth', (t) => siteOrder(t, from).map((i) => siteInput(t, 'pd', i, depthColor(Number(get(t).pd[i]))))],
      ['Markers', (t) => siteOrder(t, from).map((i) => markerDots(t, i))],
      ['CAL', (t) => siteOrder(t, from).map((i) => {
        const c = cal(get(t).pd[i], get(t).gm[i]);
        return <span key={i} className="perio-site calc" style={{ color: c >= 5 ? 'var(--danger)' : undefined }}>{c ?? '·'}</span>;
      })],
      ['Chart', (t) => <PerioTooth tooth={t} sites={siteOrder(t, from)} v={get(t)} rootsUp={upper ? from === 0 : from === 3} />],
    ].filter(Boolean);
    // Rows run outer→inner above the tooth numbers and inner→outer below; the upper arch has facial on top,
    // the lower arch lingual on top.
    const [above, below] = upper ? [side(0, true), side(3, false)] : [side(3, false), side(0, true)];
    const rows = [...above, 'numbers', ...[...below].reverse()];
    const sideLabel = (i) => (i < rows.indexOf('numbers') ? (upper ? 'Facial' : 'Lingual') : (upper ? 'Lingual' : 'Facial'));
    return (
      <table className="perio-table">
        <tbody>
          {rows.map((r, idx) => (r === 'numbers' ? (
            <tr key="n" className="perio-numbers"><td />{teeth.map((t) => <th key={t} className={isMissing(t) ? 'missing' : ''}>{t}</th>)}</tr>
          ) : (
            <tr key={`${r[0]}-${idx}`} className={r[0] === 'Chart' ? 'perio-chart-row' : undefined}>
              <td className="muted perio-label">{r[0] === 'Chart' ? '' : <>{r[0]} <span>{sideLabel(idx)}</span></>}</td>
              {teeth.map((t) => <td key={t} className={isMissing(t) ? 'missing' : ''}>{isMissing(t) ? null : <div className="perio-cell">{r[1](t)}</div>}</td>)}
            </tr>
          )))}
        </tbody>
      </table>
    );
  };

  const selectExam = (id) => {
    const e = exams.find((x) => String(x.id) === id) || null;
    setViewing(e);
    if (e) {
      const older = exams[exams.findIndex((x) => x.id === e.id) + 1];
      setCompareId(older ? String(older.id) : '');
    }
  };

  return (
    <div className="card perio-card">
      <div className="page-header" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{viewing ? `Perio exam ${fmtDate(viewing.exam_date)}` : editingId ? 'Editing perio exam' : 'New periodontal exam'}</h2>
        <div className="actions no-print">
          <select value={viewing?.id || ''} onChange={(e) => selectExam(e.target.value)} style={{ width: 170 }} aria-label="Exam">
            <option value="">{can('clinical:write') ? (editingId ? 'Editing…' : 'New exam') : 'Select an exam'}</option>
            {exams?.map((x) => <option key={x.id} value={x.id}>{fmtDate(x.exam_date)}</option>)}
          </select>
          <select value={compareId} onChange={(e) => setCompareId(e.target.value)} style={{ width: 170 }} aria-label="Compare with">
            <option value="">No comparison</option>
            {exams?.filter((x) => x.id !== viewing?.id).map((x) => <option key={x.id} value={x.id}>Compare {fmtDate(x.exam_date)}</option>)}
          </select>
          {viewing && can('clinical:write') && <button onClick={() => startEdit(viewing)}>Edit exam</button>}
          <button onClick={() => window.print()}>Print</button>
          {editable && <button className="primary" disabled={busy || !Object.keys(readings).length} onClick={submit}>{editingId ? 'Save changes' : 'Save exam'}</button>}
          {editingId && <button onClick={() => { setEditingId(null); setReadings({}); }}>Cancel</button>}
        </div>
      </div>
      <ErrorBox error={error} />
      <PerioSummary current={shown} previous={compare || (viewing ? null : exams?.[0])} />
      {editable && (
        <div className="chart-toolbar no-print">
          <span className="muted" style={{ fontSize: 12 }}>Entering:</span>
          <div className="tabs">
            <button className={row === 'pd' && !marker ? 'active' : ''} onClick={() => { setMarker(''); setRow('pd'); refs.current[`pd:${path[0]}`]?.focus(); }}>Depths</button>
            <button className={row === 'gm' && !marker ? 'active' : ''} onClick={() => { setMarker(''); setRow('gm'); setTimeout(() => refs.current[`gm:${path[0]}`]?.focus()); }}>Gingival margin</button>
            {MARKERS.map(([k, name]) => <button key={k} className={marker === k ? 'active' : ''} onClick={() => setMarker(marker === k ? '' : k)} title={`Tap sites to mark ${name.toLowerCase()}`}>{name}</button>)}
          </div>
          <label className="checkbox"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-advance</label>
          {speechSupported() && (voice
            ? <button className="danger small" onClick={() => recog.current?.stop()}>■ Stop voice</button>
            : <button className="small" onClick={startVoice} title="Say the readings; also “bleeding”, “pus”, “plaque”, “skip”, “back”, “next tooth”, “missing”, “stop”">🎤 Voice</button>)}
        </div>
      )}
      {voice && (
        <div className="public-notice ok no-print" style={{ marginBottom: 8 }} aria-live="polite">
          🎤 Listening — next: tooth {path[voice.cursor]?.split(':')[0] ?? '—'} {SITES[Number(path[voice.cursor]?.split(':')[1])] ?? ''} ({row === 'pd' ? 'depth' : 'gingival margin'}).
          Say the numbers; “bleeding”, “pus” or “plaque” mark the last site; “skip”, “back”, “next tooth”, “missing”, “stop”.
          {voice.heard && <div className="muted" style={{ fontSize: 12 }}>Heard: “{voice.heard}”</div>}
        </div>
      )}
      <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
        mm. <span style={{ color: 'var(--warn)' }}>4</span> · <span style={{ color: 'var(--danger)' }}>5+</span> · shaded = bleeding. The tooth pictures show the gum line (blue) and pocket depth (red).
        Gingival margin: + recession, − overgrowth; CAL = depth + margin.{compare ? ` Underlined red/green: 2mm+ worse/better than ${fmtDate(compare.exam_date)}.` : ''}
        {editable ? ' Type a digit per site (it moves on); pick a marker and tap sites to toggle it.' : ''}
      </div>
      <div className="table-wrap">
        {renderArch(UPPER, true)}
        <div style={{ height: 14 }} />
        {renderArch(LOWER, false)}
      </div>
      {editable && <label style={{ marginTop: 10 }}>Exam notes<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>}
      {viewing?.notes && <p><strong>Notes:</strong> {viewing.notes}</p>}
      {exams?.length > 1 && <PerioTrend exams={exams} />}
    </div>
  );
}

// Perio summary: bleeding %, pocket counts and change vs the prior exam (what insurers and patients care about).
export function perioStats(readings) {
  let sites = 0, bleeding = 0, p4 = 0, p5 = 0, deepest = 0, cal5 = 0, plaque = 0;
  for (const v of Object.values(readings || {})) {
    if (!v.pd) continue;
    v.pd.forEach((d, i) => {
      if (d === '' || d == null) return;
      const n = Number(d);
      sites++;
      if (v.bop?.[i]) bleeding++;
      if (v.plaque?.[i]) plaque++;
      if (n >= 4) p4++;
      if (n >= 5) p5++;
      if (cal(d, v.gm?.[i]) >= 5) cal5++;
      deepest = Math.max(deepest, n);
    });
  }
  return { sites, bop_pct: sites ? Math.round((bleeding / sites) * 100) : 0, plaque_pct: sites ? Math.round((plaque / sites) * 100) : 0, p4, p5, cal5, deepest };
}

function PerioSummary({ current, previous }) {
  const now = perioStats(current);
  if (!now.sites) return null;
  const prev = previous ? perioStats(previous.readings) : null;
  const delta = (k, lowerIsBetter = true) => {
    if (!prev?.sites) return null;
    const d = now[k] - prev[k];
    if (!d) return <span className="muted"> ±0</span>;
    const good = lowerIsBetter ? d < 0 : d > 0;
    return <span style={{ color: good ? 'var(--ok)' : 'var(--danger)' }}> {d > 0 ? '▲' : '▼'}{Math.abs(d)}</span>;
  };
  return (
    <div className="perio-summary">
      <div><strong>{now.sites}</strong><span>sites charted</span></div>
      <div><strong className={now.bop_pct > 30 ? 'text-danger' : ''}>{now.bop_pct}%{delta('bop_pct')}</strong><span>bleeding on probing</span></div>
      <div><strong>{now.plaque_pct}%{delta('plaque_pct')}</strong><span>plaque</span></div>
      <div><strong>{now.p4}{delta('p4')}</strong><span>pockets ≥ 4 mm</span></div>
      <div><strong className={now.p5 ? 'text-danger' : ''}>{now.p5}{delta('p5')}</strong><span>pockets ≥ 5 mm</span></div>
      <div><strong>{now.cal5}{delta('cal5')}</strong><span>CAL ≥ 5 mm</span></div>
      <div><strong>{now.deepest} mm</strong><span>deepest</span></div>
      {prev?.sites ? <div className="muted" style={{ alignSelf: 'center', fontSize: 12 }}>vs {fmtDate(previous.exam_date)}</div> : null}
    </div>
  );
}

// Bleeding % and deep pockets across exams, oldest to newest.
function PerioTrend({ exams }) {
  const points = [...exams].reverse().map((e) => ({ date: e.exam_date, ...perioStats(e.readings) })).filter((p) => p.sites);
  if (points.length < 2) return null;
  const W = 520;
  const H = 150;
  const pad = 30;
  const x = (i) => pad + (i * (W - pad * 2)) / (points.length - 1);
  const maxPockets = Math.max(4, ...points.map((p) => p.p4));
  const series = [
    ['Bleeding %', 'var(--danger)', (p) => p.bop_pct, 100],
    ['Pockets ≥ 4mm', 'var(--primary)', (p) => p.p4, maxPockets],
  ];
  return (
    <div style={{ marginTop: 16 }}>
      <h3>Trend</h3>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W }} role="img" aria-label="Perio trend">
        <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke="var(--border)" />
        {series.map(([name, color, f, max]) => (
          <g key={name}>
            <polyline fill="none" stroke={color} strokeWidth="2" points={points.map((p, i) => `${x(i)},${H - pad - (f(p) / max) * (H - pad * 2)}`).join(' ')} />
            {points.map((p, i) => <circle key={i} cx={x(i)} cy={H - pad - (f(p) / max) * (H - pad * 2)} r="3" fill={color}><title>{`${name}: ${f(p)} (${fmtDate(p.date)})`}</title></circle>)}
          </g>
        ))}
        {points.map((p, i) => <text key={i} x={x(i)} y={H - 10} fontSize="10" textAnchor="middle" fill="var(--muted)">{fmtDate(p.date)}</text>)}
      </svg>
      <div className="legend" style={{ justifyContent: 'flex-start' }}>
        {series.map(([name, color]) => <span key={name}><i style={{ background: color }} />{name}</span>)}
      </div>
    </div>
  );
}
