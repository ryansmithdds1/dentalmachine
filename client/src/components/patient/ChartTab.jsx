import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, label, age, toCents, fromCents, practiceToday } from '../../format.js';
import { Mic, Settings2 } from 'lucide-react';
import { buildLookups, shortcutText } from './chartShorthand.js';
import { useShortcuts, useHelpRows, isMac } from '../../shortcuts.js';
import ShortcutIcon from './ShortcutIcon.jsx';
import ChartEntry from './ChartEntry.jsx';
import CompleteWork, { UncompleteForm, useTodaysWork } from './CompleteWork.jsx';
import { undoable } from '../../toast.js';
import Odontogram, { STATUS_COLORS, CONDITION_COLORS, codeArea, surfacesFor, QUADRANT_LABELS, baseTooth } from '../Odontogram.jsx';
import NoteComposer from '../NoteComposer.jsx';
import { Badge, ErrorBox, Modal, useSubmit } from '../ui.jsx';

const QUADS = ['UR', 'UL', 'LL', 'LR'];
const ARCHES = ['U', 'L'];

// Primary teeth for young children, both sets while they're mixed.
const defaultDentition = (dob) => {
  const a = age(dob);
  if (a === '' || a == null || a >= 13) return 'permanent';
  return a < 6 ? 'primary' : 'mixed';
};

export default function ChartTab({ patient, onChange }) {
  const { can, practice } = useAuth();
  const panelRef = useRef(null);
  const [asOf, setAsOf] = useState('');
  const { data, reload } = useApi(`/patients/${patient.id}/chart${asOf ? `?as_of=${asOf}` : ''}`);
  const { data: plans, reload: reloadPlans } = useApi(`/patients/${patient.id}/treatment-plans`);
  const [dentition, setDentition] = useState(() => defaultDentition(patient.dob));
  const [tooth, setTooth] = useState(null);
  const [modal, setModal] = useState(null);
  const [noteFor, setNoteFor] = useState(null);
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [undoFor, setUndoFor] = useState(null);
  const write = can('clinical:write') && !asOf;
  const todays = useTodaysWork(patient, data?.procedures, practice?.timezone);
  // The office's and this person's bundles, quick buttons and aliases (Settings → Clinical → Chart shortcuts & bundles).
  const { data: setup } = useApi(can('clinical:read') ? '/chart-shortcuts' : null);
  const lookups = useMemo(() => (setup ? buildLookups(setup) : null), [setup]);
  const [entryRequest, setEntryRequest] = useState(null);
  const buttons = useMemo(() => (setup?.shortcuts || []).filter((s) => s.button).map((s) => ({ ...s, text: shortcutText(s, setup.bundles) })), [setup]);
  const press = (s) => s.text && setEntryRequest((r) => ({ text: s.text, auto: true, n: (r?.n || 0) + 1 }));
  useShortcuts(buttons.slice(0, 9).map((s, i) => ({ combo: `alt+${i + 1}`, handler: () => press(s), label: `${s.label}${s.text ? ` (${s.text})` : ''}`, section: 'Chart buttons', enabled: write && !!s.text })));
  useHelpRows('Chart aliases (type them, or say them to the assistant)', [
    ...(setup?.bundles || []).filter((b) => b.alias).map((b) => [[b.alias], `${b.name}: ${b.items.map((it) => `${it.optional ? '(' : ''}${it.label || it.code || (it.work || it.finding || '').replace(/_/g, ' ')}${it.optional ? ')' : ''}`).join(' + ')}`]),
    ...(setup?.shortcuts || []).filter((s) => s.alias).map((s) => [[s.alias], `${s.label} (${s.kind} ${s.kind === 'bundle' ? '' : s.target} ${s.mode})`.replace(/\s+/g, ' ')]),
  ]);

  const refresh = () => { reload(); reloadPlans(); onChange?.(); };
  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setErr(e);
    }
  };

  if (!data) return <div className="empty">Loading chart…</div>;
  // On a tablet or phone the entry panel sits under the teeth: bring it up after a tap.
  const pickTooth = (t) => {
    setTooth(t);
    if (t && window.matchMedia?.('(max-width: 1100px)').matches) setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  const openPlans = (plans || []).filter((p) => ['proposed', 'accepted'].includes(p.status));
  const conditions = data.conditions.filter((c) => !tooth || c.tooth === tooth);
  const procs = data.procedures.filter((p) => !tooth || p.tooth === tooth);

  const complete = (p) => act(async () => {
    await api.post(`/procedures/${p.id}/complete`, {});
    setModal({ kind: 'note', ids: [p.id], provider: p.provider_id });
  });

  return (
    <div className="chart-layout">
      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="chart-toolbar no-print">
          <div className="tabs">
            {['permanent', 'mixed', 'primary'].map((d) => <button key={d} className={dentition === d ? 'active' : ''} onClick={() => setDentition(d)}>{label(d)}</button>)}
          </div>
          <label className="inline" style={{ fontSize: 13 }}>
            Chart as of
            <input type="date" value={asOf} max={new Date().toISOString().slice(0, 10)} onChange={(e) => { setAsOf(e.target.value); setTooth(null); }} style={{ width: 150 }} />
          </label>
          {asOf && <button className="small" onClick={() => setAsOf('')}>Back to today</button>}
          <SupernumeraryPicker onPick={setTooth} />
          {write && (
            <button className="small primary" style={{ marginLeft: 'auto' }} title="Drafts from today's completed work and starts listening (Alt+M)" onClick={() => {
              const today = practiceToday(practice?.timezone);
              const done = data.procedures.filter((p) => p.status === 'completed' && String(p.completed_at || '').slice(0, 10) === today);
              setModal({ kind: 'note', ids: done.map((p) => p.id), provider: done[0]?.provider_id ?? patient.primary_provider_id, listen: true });
            }}><Mic size={14} aria-hidden /> Dictate today’s note</button>
          )}
          <button className="small" onClick={() => window.print()} style={write ? undefined : { marginLeft: 'auto' }}>Print</button>
        </div>
        {asOf && <div className="public-notice" style={{ marginBottom: 8 }}>Showing the chart as it was on {fmtDate(asOf)}: conditions recorded and work completed by then. Planned treatment isn’t shown.</div>}
        {write && !asOf && buttons.length > 0 && (
          <div className="te-buttons no-print" aria-label="Quick buttons">
            {buttons.map((s, i) => (
              <button
                key={s.id} type="button" className="small te-btn" style={s.color ? { '--te-color': s.color } : undefined} disabled={!s.text}
                title={s.text ? `${s.text}${i < 9 ? ` · ${isMac ? '⌥' : 'Alt+'}${i + 1}` : ''}${tooth ? ` on #${tooth}` : ''}` : 'Its bundle was retired'}
                onClick={() => press(s)}
              >
                <ShortcutIcon name={s.icon} size={14} />{s.label}{i < 9 && <kbd>{i + 1}</kbd>}
              </button>
            ))}
            <Link className="te-edit muted" to="/settings?tab=chartshortcuts" title="Change the buttons, bundles and aliases"><Settings2 size={13} aria-hidden /> Customize</Link>
          </div>
        )}
        {write && !asOf && <ChartEntry patient={patient} tooth={tooth} onDone={refresh} setup={setup} lookups={lookups} chart={data} request={entryRequest} />}
        <ChartStats conditions={data.conditions} procedures={data.procedures} />
        <Odontogram conditions={data.conditions} procedures={data.procedures} selected={tooth} onSelect={pickTooth} dentition={dentition} />
      </div>

      <div ref={panelRef} style={{ minWidth: 0 }}>
      {write ? (
        <EntryPanel patient={patient} tooth={tooth} plans={openPlans} onDone={(res) => {
          refresh();
          if (res?.completed) setModal({ kind: 'note', ids: [res.completed.id], provider: res.completed.provider_id });
        }} />
      ) : (
        <div className="card"><h2>{tooth ? `Tooth #${tooth}` : 'Chart'}</h2><p className="muted">{asOf ? 'Past charts are read-only.' : 'View only.'}</p></div>
      )}
      </div>

      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h2>{tooth ? `History for #${tooth}` : 'Charted findings & procedures'}</h2>
          {tooth && <button className="small" onClick={() => setTooth(null)}>Show all teeth</button>}
        </div>
        <ErrorBox error={err} />
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))' }}>
          <div>
            <h3>Conditions</h3>
            <table>
              <tbody>
                {conditions.map((c) => (
                  <tr key={c.id} style={{ opacity: c.resolved ? 0.5 : 1 }}>
                    <td>#{c.tooth} {c.surfaces}</td>
                    <td>
                      <span className="badge" style={{ background: `${CONDITION_COLORS[c.condition]}22`, color: CONDITION_COLORS[c.condition] }}>{label(c.condition)}</span>
                      {noteFor === c.id
                        ? (
                          <form className="inline" style={{ gap: 4, marginTop: 4 }} onSubmit={(e) => { e.preventDefault(); const notes = e.currentTarget.notes.value; setNoteFor(null); act(() => api.put(`/conditions/${c.id}`, { notes })); }}>
                            <input name="notes" defaultValue={c.notes || ''} autoFocus aria-label={`Note for ${label(c.condition)} on #${c.tooth}`} onKeyDown={(e) => e.key === 'Escape' && setNoteFor(null)} style={{ fontSize: 12, padding: '3px 6px' }} />
                            <button className="small">Save</button>
                          </form>
                        )
                        : c.notes && <div className="muted" style={{ fontSize: 12 }}>{c.notes}</div>}
                    </td>
                    <td className="muted">{fmtDate(c.recorded_at)}{c.resolved ? ` · resolved ${fmtDate(c.resolved_at)}` : ''}</td>
                    <td>
                      {write && (
                        <div className="row-actions">
                          <button className="small" onClick={() => setNoteFor(c.id)}>Note</button>
                          {c.resolved
                            ? <button className="small" onClick={() => act(() => api.put(`/conditions/${c.id}`, { resolved: false }))}>Reopen</button>
                            : <button className="small" onClick={() => act(() => api.put(`/conditions/${c.id}`, { resolved: true }))}>Resolve</button>}
                          <button className="small" title="Charted in error: take it off the chart (kept on record)" onClick={() => undoable(
                            `Removed ${label(c.condition)} on #${c.tooth}`,
                            async () => { await api.post(`/conditions/${c.id}/void`, { reason: 'Charted in error' }); refresh(); },
                            async () => { await api.post(`/patients/${patient.id}/conditions`, { tooth: c.tooth, surfaces: c.surfaces, condition: c.condition, notes: c.notes }); refresh(); },
                          ).catch(() => { /* shown as a toast */ })}>Remove</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!conditions.length && <div className="muted">None recorded.</div>}
          </div>
          <div>
            <h3>Procedures</h3>
            {write && (
              <CompleteWork
                patient={patient} procedures={data.procedures} todays={todays} picked={picked}
                onDone={(ids, provider) => { setPicked(new Set()); refresh(); if (ids.length) setModal({ kind: 'offer-note', ids, provider }); }}
              />
            )}
            {modal?.kind === 'offer-note' && (
              <div className="proc-done" role="status">
                Completed {modal.ids.length} procedure{modal.ids.length > 1 ? 's' : ''}; charges posted.
                <button className="small" onClick={() => setModal({ kind: 'note', ids: modal.ids, provider: modal.provider })}>Write the note</button>
                <button className="small" onClick={() => setModal(null)}>Dismiss</button>
              </div>
            )}
            <table>
              <tbody>
                {procs.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {write && p.status === 'planned' && (
                        <input
                          type="checkbox" className="proc-check" aria-label={`Select ${p.code}${p.tooth ? ` #${p.tooth}` : ''} to complete`} checked={picked.has(p.id)}
                          onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}
                        />
                      )}
                    </td>
                    <td>{p.code}{todays.visit && p.status === 'planned' && p.appointment_id === todays.visit.id ? <div className="muted" style={{ fontSize: 11 }}>today</div> : null}</td>
                    <td>
                      {p.description}
                      <div className="muted">
                        {p.tooth ? `#${p.tooth} ` : ''}{p.surfaces || ''}{p.area ? QUADRANT_LABELS[p.area] : ''} {p.provider_name ? `· ${p.provider_name.replace(/,.*$/, '')}` : ''}
                        {p.plan_name ? ` · ${p.plan_name}${p.plan_option ? ` (${p.plan_option})` : ''}` : ''}
                      </div>
                    </td>
                    <td><Badge value={p.status} /></td>
                    <td className="num">{money(p.fee)}<div className="muted" style={{ fontSize: 11 }}>{fmtDate(p.completed_at || p.created_at)}</div></td>
                    <td>
                      {write && (
                        <div className="row-actions">
                          {p.status === 'planned' && (
                            <>
                              <button className="small primary" onClick={() => complete(p)}>Complete</button>
                              <button className="small" onClick={() => setModal({ kind: 'edit', proc: p })}>Edit</button>
                              {!p.treatment_plan_id && openPlans.length > 0 && (
                                <select className="small" value="" aria-label="Add to plan" style={{ width: 'auto' }} onChange={(e) => e.target.value && act(() => api.post(`/treatment-plans/${e.target.value}/procedures`, { procedure_ids: [p.id] }))}>
                                  <option value="">Add to plan…</option>
                                  {openPlans.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}{tp.option_label ? ` (${tp.option_label})` : ''}</option>)}
                                </select>
                              )}
                              <button className="small danger" onClick={() => undoable(
                                `Removed ${p.code}${p.tooth ? ` #${p.tooth}` : ''} from the chart`,
                                async () => { await api.post(`/procedures/${p.id}/cancel`); refresh(); },
                                async () => { await api.post(`/procedures/${p.id}/restore`); refresh(); },
                              ).catch(() => { /* shown as a toast */ })}>Remove</button>
                            </>
                          )}
                          {p.status === 'completed' && (
                            <>
                              <button className="small" onClick={() => setModal({ kind: 'note', ids: [p.id], provider: p.provider_id })}>Note</button>
                              {can('billing:write') && undoFor !== p.id && (
                                <button className="small" title="Charted in error? Reverses the charge and puts it back to planned" onClick={() => setUndoFor(p.id)}>Undo</button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {write && undoFor === p.id && (
                        <UncompleteForm proc={p} onCancel={() => setUndoFor(null)} onDone={() => { setUndoFor(null); refresh(); }} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!procs.length && <div className="muted">None recorded.</div>}
          </div>
        </div>
      </div>

      {modal?.kind === 'note' && (
        <Modal title="Clinical note" wide onClose={() => setModal(null)}>
          <NoteComposer patient={patient} procedureIds={modal.ids} providerId={modal.provider} autoDraft autoListen={!!modal.listen} onSaved={() => setModal(null)} />
        </Modal>
      )}
      {modal?.kind === 'edit' && (
        <Modal title={`Edit ${modal.proc.code}`} onClose={() => setModal(null)}>
          <EditProcedure proc={modal.proc} onDone={() => { setModal(null); refresh(); }} />
        </Modal>
      )}
    </div>
  );
}

// The chart at a glance: what's planned, what's wrong, what's missing.
function ChartStats({ conditions, procedures }) {
  const open = conditions.filter((c) => !c.resolved);
  const planned = procedures.filter((p) => p.status === 'planned');
  const stats = [
    [STATUS_COLORS.planned, 'planned', planned.length, planned.reduce((s, p) => s + (p.fee || 0), 0)],
    [STATUS_COLORS.problem, 'to treat', open.filter((c) => ['caries', 'fracture', 'abscess'].includes(c.condition)).length],
    [STATUS_COLORS.watch, 'watching', open.filter((c) => c.condition === 'watch').length],
    ['#94a3b8', 'missing', new Set(open.filter((c) => c.condition === 'missing').map((c) => c.tooth)).size],
    [STATUS_COLORS.completed, 'done', procedures.filter((p) => p.status === 'completed').length],
  ].filter(([, , n]) => n);
  if (!stats.length) return null;
  return (
    <div className="chart-stats">
      {stats.map(([color, what, n, fee]) => <span key={what} className="chart-stat"><i style={{ background: color }} /><b>{n}</b> {what}{fee ? ` · ${money(fee)}` : ''}</span>)}
    </div>
  );
}

function SupernumeraryPicker({ onPick }) {
  const [v, setV] = useState('');
  const ok = /^(5[1-9]|[67]\d|8[0-2]|[A-T]S)$/i.test(v.trim());
  return (
    <form className="inline" onSubmit={(e) => { e.preventDefault(); if (ok) { onPick(v.trim().toUpperCase()); setV(''); } }} style={{ gap: 4 }}>
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Supernumerary #" title="51-82 beside a permanent tooth (51 = beside #1), AS-TS beside a primary tooth" style={{ width: 130 }} />
      <button className="small" disabled={!ok}>Select</button>
    </form>
  );
}

// Search codes by number or words; favourites (the practice's most used) one tap away.
export function CodePicker({ value, onChange, codes }) {
  const favorites = useLookup('/procedure-codes/favorites');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return codes.filter((c) => terms.every((t) => c.code.toLowerCase().includes(t) || c.description.toLowerCase().includes(t))).slice(0, 30);
  }, [q, codes]);
  const pick = (c) => { onChange(c); setQ(''); setOpen(false); };
  return (
    <div>
      {favorites.length > 0 && (
        <div className="fav-codes">
          {favorites.map((c) => (
            <button type="button" key={c.id} className={`small${value?.id === c.id ? ' primary' : ''}`} title={c.description} onClick={() => pick(c)}>{c.code}</button>
          ))}
        </div>
      )}
      <div className="code-picker">
        <input
          value={q} placeholder={value ? `${value.code} – ${value.description}` : 'Search code or description (e.g. "crown", D2740)'}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHl(0); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHl(Math.min(hl + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setHl(Math.max(hl - 1, 0)); }
            if (e.key === 'Enter' && results[hl]) { e.preventDefault(); pick(results[hl]); }
          }}
          aria-label="Procedure code"
        />
        {open && results.length > 0 && (
          <div className="results">
            {results.map((c, i) => (
              <button type="button" key={c.id} className={i === hl ? 'hl' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
                <strong>{c.code}</strong> {c.description} <span className="muted">{money(c.fee)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {value && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{value.code} – {value.description} · {money(value.fee)}</div>}
    </div>
  );
}

function EntryPanel({ patient, tooth, plans, onDone }) {
  const codes = useLookup('/procedure-codes?active=true');
  const providers = useLookup('/providers?active=true');
  const [mode, setMode] = useState('procedure');
  const [surfaces, setSurfaces] = useState('');
  const [code, setCode] = useState(null);
  const [area, setArea] = useState('');
  const [cond, setCond] = useState('caries');
  const [condNotes, setCondNotes] = useState('');
  const [providerId, setProviderId] = useState('');
  const [status, setStatus] = useState('planned');
  const [planId, setPlanId] = useState('');
  const kind = codeArea(code);
  const toggle = (s) => setSurfaces(surfaces.includes(s) ? surfaces.replace(s, '') : surfaces + s);
  const surfaceList = surfacesFor(tooth);

  const { submit, busy, error } = useSubmit(async () => {
    if (mode === 'condition') {
      await api.post(`/patients/${patient.id}/conditions`, { tooth, surfaces, condition: cond, notes: condNotes || null });
      setCondNotes('');
      setSurfaces('');
      onDone();
      return;
    }
    const p = await api.post(`/patients/${patient.id}/procedures`, {
      code_id: code.id, tooth: kind === 'tooth' ? tooth : null, surfaces: kind === 'tooth' ? surfaces || null : null,
      area: ['quadrant', 'arch'].includes(kind) ? area : null,
      provider_id: providerId ? Number(providerId) : patient.primary_provider_id, complete: status === 'completed',
      treatment_plan_id: status === 'planned' && planId ? Number(planId) : null,
    });
    setSurfaces('');
    onDone(status === 'completed' ? { completed: p } : null);
  });

  const needsTooth = mode === 'procedure' && kind === 'tooth' && code?.requires_tooth && !tooth;
  const needsArea = mode === 'procedure' && ['quadrant', 'arch'].includes(kind) && !area;
  return (
    <div className="card">
      <h2>{tooth ? `Tooth #${tooth}${baseTooth(tooth) !== tooth ? ' (supernumerary)' : ''}` : 'No tooth selected'}</h2>
      <ErrorBox error={error} />
      <div className="tabs" style={{ marginBottom: 12 }}>
        <button className={mode === 'procedure' ? 'active' : ''} onClick={() => setMode('procedure')}>Procedure</button>
        <button className={mode === 'condition' ? 'active' : ''} onClick={() => setMode('condition')} disabled={!tooth}>Condition</button>
      </div>
      {mode === 'procedure' && <CodePicker value={code} onChange={(c) => { setCode(c); setArea(''); }} codes={codes} />}
      {(mode === 'condition' || kind === 'tooth') && (
        <>
          <label style={{ marginTop: 10 }}>Surfaces</label>
          <div className="inline" style={{ margin: '4px 0 12px' }}>
            {surfaceList.map((s) => (
              <button key={s} type="button" className={`${surfaces.includes(s) ? 'primary' : ''}`} style={{ minWidth: 40 }} onClick={() => toggle(s)} disabled={!tooth}>{s}</button>
            ))}
          </div>
        </>
      )}
      {mode === 'procedure' && ['quadrant', 'arch'].includes(kind) && (
        <>
          <label style={{ marginTop: 10 }}>{kind === 'quadrant' ? 'Quadrant' : 'Arch'}</label>
          <div className="inline" style={{ margin: '4px 0 12px', flexWrap: 'wrap' }}>
            {(kind === 'quadrant' ? QUADS : ARCHES).map((a) => (
              <button key={a} type="button" className={area === a ? 'primary' : ''} onClick={() => setArea(a)} title={QUADRANT_LABELS[a]}>{a}</button>
            ))}
          </div>
        </>
      )}
      {mode === 'condition' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label>
            Condition
            <select value={cond} onChange={(e) => setCond(e.target.value)}>
              {Object.keys(CONDITION_COLORS).map((c) => <option key={c} value={c}>{label(c)}</option>)}
            </select>
          </label>
          <label>Notes<input value={condNotes} onChange={(e) => setCondNotes(e.target.value)} placeholder="e.g. existing PFM, margin open distal" /></label>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          <label>
            Provider
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">Patient&apos;s primary provider</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <div className="tabs">
            <button type="button" className={status === 'planned' ? 'active' : ''} onClick={() => setStatus('planned')}>Treatment plan</button>
            <button type="button" className={status === 'completed' ? 'active' : ''} onClick={() => setStatus('completed')}>Completed today</button>
          </div>
          {status === 'planned' && plans.length > 0 && (
            <label>
              Add to plan
              <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
                <option value="">Not on a plan yet</option>
                {plans.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}{tp.option_label ? ` (${tp.option_label})` : ''}</option>)}
              </select>
            </label>
          )}
          {status === 'completed' && <div className="muted" style={{ fontSize: 12 }}>Posts the charge now and offers a note from your templates.</div>}
          {needsTooth && <div className="muted">Select a tooth on the chart.</div>}
          {needsArea && <div className="muted">Choose the {kind === 'quadrant' ? 'quadrant' : 'arch'}.</div>}
        </div>
      )}
      <div className="form-actions">
        <button className="primary" disabled={busy || (mode === 'procedure' && (!code || needsTooth || needsArea)) || (mode === 'condition' && !tooth)} onClick={submit}>
          {mode === 'condition' ? 'Add condition' : status === 'completed' ? 'Chart as completed' : 'Add to treatment plan'}
        </button>
      </div>
    </div>
  );
}

function EditProcedure({ proc, onDone }) {
  const providers = useLookup('/providers?active=true');
  const [form, setForm] = useState({ tooth: proc.tooth || '', surfaces: proc.surfaces || '', area: proc.area || '', fee: fromCents(proc.fee), provider_id: proc.provider_id || '' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    await api.put(`/procedures/${proc.id}`, {
      ...(proc.area ? { area: form.area } : { tooth: form.tooth || null, surfaces: form.surfaces || null }),
      fee: toCents(form.fee), provider_id: form.provider_id ? Number(form.provider_id) : null,
    });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        {proc.area ? (
          <label>Area<select value={form.area} onChange={set('area')}>{(proc.area.length === 2 ? QUADS : ARCHES).map((a) => <option key={a} value={a}>{QUADRANT_LABELS[a]}</option>)}</select></label>
        ) : (
          <>
            <label>Tooth<input value={form.tooth} onChange={set('tooth')} /></label>
            <label>Surfaces<input value={form.surfaces} onChange={set('surfaces')} /></label>
          </>
        )}
        <label>Fee ($)<input type="number" step="0.01" min="0" value={form.fee} onChange={set('fee')} /></label>
        <label>
          Provider
          <select value={form.provider_id} onChange={set('provider_id')}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <div className="form-actions"><button className="primary" disabled={busy}>Save</button></div>
    </form>
  );
}
