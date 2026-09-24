import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, download } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, practiceToday, toCents, fromCents } from '../../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../ui.jsx';
import AppointmentForm from '../AppointmentForm.jsx';
import { CodePicker } from './ChartTab.jsx';
import SendForms from '../FormsSend.jsx';
import { codeArea, QUADRANT_LABELS } from '../Odontogram.jsx';
import { parseEntry } from './chartShorthand.js';
import { useShortcuts } from '../../shortcuts.js';
import { toast, undoable } from '../../toast.js';
import { Settings2, GripVertical, ChevronUp, ChevronDown, Plus } from 'lucide-react';
import FinDesk from './FinDesk.jsx';
import { sendPreauth } from '../preauthSend.js';
import StaffCompare from './StaffCompare.jsx';
import FinOptionsSettings from '../FinOptionsSettings.jsx';
import './treatment.css';
import './finoptions.css';

export default function TreatmentTab({ patient, onChange }) {
  const { can, practice, user } = useAuth();
  const codes = useLookup('/procedure-codes?active=true');
  const [adding, setAdding] = useState(null);
  const [booking, setBooking] = useState(null);
  const { data: plans, reload } = useApi(`/patients/${patient.id}/treatment-plans`);
  const { data: loose, reload: reloadLoose } = useApi(`/patients/${patient.id}/procedures?status=planned`);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState(null);
  const [presenting, setPresenting] = useState(null);
  const [consent, setConsent] = useState(null);
  const [note, setNote] = useState(null);
  const [finSettings, setFinSettings] = useState(false);
  // The live estimate per phase and the financial options for each open plan (F1/F3), fetched again whenever the
  // plans change. phasesFor: the phases the patient is choosing from, per plan.
  const [quotes, setQuotes] = useState({});
  const [phasesFor, setPhasesFor] = useState({});
  const quoteable = (p) => ['proposed', 'accepted'].includes(p.status) && p.procedures?.some((x) => x.status === 'planned');
  const loadQuote = async (planId, phases = phasesFor[planId]) => {
    try {
      const q = await api.get(`/treatment-plans/${planId}/quote${phases?.length ? `?phases=${phases.join(',')}` : ''}`);
      setQuotes((all) => ({ ...all, [planId]: q }));
    } catch { setQuotes((all) => ({ ...all, [planId]: null })); }
  };
  useEffect(() => {
    for (const p of plans || []) if (quoteable(p)) loadQuote(p.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans]);
  const refresh = () => { reload(); reloadLoose(); onChange?.(); };

  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setErr(e);
    }
  };

  const unplanned = loose?.filter((p) => !p.treatment_plan_id) || [];
  const canWrite = can('clinical:write');
  // Changes happen at once with an Undo toast (Ctrl/⌘Z); undo goes through the normal routes, so both are on record.
  // A failure already shows as a red toast from undoable(), so there's nothing more to do with it here.
  const withUndo = (message, doIt, undoIt) => undoable(message, async () => { const r = await doIt(); refresh(); return r; }, async () => { await undoIt(); refresh(); })
    .catch(() => { /* shown as a toast by undoable() */ });
  const planAll = async () => {
    setErr(null);
    try {
      const plan = await api.post(`/patients/${patient.id}/treatment-plans`, { all_unplanned: true });
      toast(`“${plan.name}” made with ${plan.procedures.length} procedure${plan.procedures.length === 1 ? '' : 's'}`);
      refresh();
    } catch (e) { setErr(e); }
  };
  const quiet = !creating && !adding && !booking && !presenting && !consent && !finSettings;
  useShortcuts([
    { combo: 'f', handler: () => document.querySelector('.fin-card-main:not([disabled])')?.focus(), label: 'Ways to pay (financial options)', section: 'Treatment', enabled: quiet },
    { combo: 'n', handler: () => setCreating(true), label: 'New treatment plan (type “14 D2740”, Enter for each)', section: 'Treatment', enabled: canWrite && quiet },
    { combo: 'a', handler: planAll, label: 'Put all unplanned work on a new plan', section: 'Treatment', enabled: canWrite && quiet && unplanned.length > 0 },
  ]);

  return (
    <>
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Treatment plans</h2>
        {canWrite && (
          <div className="actions">
            {unplanned.length > 0 && <button onClick={planAll} title="Shortcut: A">Plan all unplanned work ({unplanned.length})</button>}
            <button className="primary" onClick={() => setCreating(true)} title="Shortcut: N">+ New treatment plan</button>
            {user?.role === 'admin' && <button className="icon-button" title="Financial options: discounts, payment plans, lenders" aria-label="Financial options settings" onClick={() => setFinSettings(true)}><Settings2 size={16} /></button>}
          </div>
        )}
      </div>
      <ErrorBox error={err} />
      {note && <div className="public-notice ok" style={{ marginBottom: 12 }}>{note}</div>}
      {finSettings && (
        <Modal title="Financial options" wide onClose={() => setFinSettings(false)}>
          <FinOptionsSettings onSaved={() => { setFinSettings(false); refresh(); }} />
        </Modal>
      )}
      {presenting && <PresentModal plan={presenting} patient={patient} onClose={() => { setPresenting(null); refresh(); }} />}
      {consent && (
        <SendForms patient={patient} title={`Consent for “${consent.name}”`} procedureIds={consent.procedures.filter((p) => p.status === 'planned').map((p) => p.id)} onClose={() => setConsent(null)} />
      )}
      {plans?.length === 0 && unplanned.length === 0 && <div className="card empty">No treatment planned.</div>}

      {plans?.map((plan) => (
        <div className="card" key={plan.id} data-plan={plan.id}>
          <div className="page-header" style={{ marginBottom: 10 }}>
            <div>
              <h3 style={{ margin: 0 }}>{plan.name}{plan.option_label ? <span className="badge info" style={{ marginLeft: 6 }}>{plan.option_label}</span> : null} <Badge value={plan.status} />{plan.discount_pct > 0 && <span className="badge ok" style={{ marginLeft: 6 }}>{plan.discount_pct}% discount</span>}</h3>
              <div className="muted">
                Created {fmtDate(plan.created_at)}{plan.accepted_at ? ` · Accepted ${fmtDate(plan.accepted_at)}` : ''}
                {plan.signed_at && <> · <span className="badge ok">✍ Signed by {plan.signature_name}</span> <a href={`/treatment-plans/${plan.id}/print?signed=1`} target="_blank" rel="noreferrer">signed copy</a> · <a href="#" onClick={(e) => { e.preventDefault(); download(`/treatment-plans/${plan.id}/pdf`, 'treatment-plan.pdf'); }}>PDF</a></>}
                {plan.signed_version?.changed && <> · <span className="badge warn" title="The plan was edited after the patient signed it. The signed copy is kept as it was; put new work in a new plan to get it signed.">Changed since signed</span></>}
                {!plan.signed_at && plan.presented_at && ` · Sent to patient ${fmtDate(plan.presented_at)}`}
              </div>
            </div>
            {can('clinical:write') && plan.status !== 'completed' && (
              <div className="actions">
                {!plan.signed_at && <button className="small primary" onClick={() => setPresenting(plan)}>Present & e-sign…</button>}
                {plan.estimate?.policy && can('billing:write') && plan.procedures.some((p) => p.status === 'planned') && (
                  <button className="small" title="Makes the pre-authorization and sends it to the payer" onClick={() => act(async () => {
                    // Workflow 38: made and sent in one step (the 837 file only when no clearinghouse is connected).
                    const pa = await api.post('/preauths', { patient_insurance_id: plan.estimate.policy.id, treatment_plan_id: plan.id });
                    const out = await sendPreauth(pa);
                    setNote(out.sent ? `Pre-authorization #${pa.id} sent to ${plan.estimate.policy.carrier_name || 'the payer'} — the answer is recorded in Billing → Pre-authorizations.` : `Pre-authorization #${pa.id} saved as an 837 file to upload.`);
                  })}>Pre-authorize</button>
                )}
                <button className="small" onClick={() => window.open(`/treatment-plans/${plan.id}/print`, '_blank')}>Print</button>
                <button className="small" onClick={() => download(`/treatment-plans/${plan.id}/pdf`, 'treatment-plan.pdf')}>PDF</button>
                {plan.procedures.some((p) => p.status === 'planned') && <button className="small" title="Informed consent for this plan's procedures" onClick={() => setConsent(plan)}>Consent…</button>}
                {plan.status !== 'rejected' && <button className="small" onClick={() => setAdding(plan)}>+ Add work</button>}
                {plan.status === 'proposed' && <button className="small" title="A copy of this plan's unstarted work to change into another option (e.g. implant vs bridge). Accepting one option declines the others." onClick={() => act(() => api.post(`/treatment-plans/${plan.id}/duplicate`, {}))}>+ Alternative</button>}
                {plan.status !== 'rejected' && (
                  <InlineEdit
                    label="Discount on the patient's share (%) — posted as an adjustment as each procedure is done" suffix="%" width={64}
                    value={String(plan.discount_pct || 0)} display={<span className="small-button">Discount{plan.discount_pct ? ` ${plan.discount_pct}%` : '…'}</span>}
                    valid={(v) => /^\d{1,3}$/.test(v) && Number(v) <= 100}
                    onSave={(v) => withUndo(`Discount set to ${Number(v)}%`, () => api.put(`/treatment-plans/${plan.id}`, { discount_pct: Number(v) }), () => api.put(`/treatment-plans/${plan.id}`, { discount_pct: plan.discount_pct || 0 }))}
                  />
                )}
                {plan.status === 'proposed' && <button className="small" onClick={() => act(() => api.put(`/treatment-plans/${plan.id}`, { status: 'accepted' }))}>Accepted verbally</button>}
                {plan.status === 'proposed' && <button className="small danger" onClick={() => act(() => api.put(`/treatment-plans/${plan.id}`, { status: 'rejected' }))}>Declined</button>}
              </div>
            )}
          </div>
          {plan.option_group && plans.find((x) => x.option_group === plan.option_group) === plan && quotes[plan.id]?.alternatives?.length > 1 && <StaffCompare plan={plan} onChange={refresh} />}
          <PlanTable plan={plan} quote={quotes[plan.id]} codes={codes} canEdit={canWrite && !['completed', 'rejected'].includes(plan.status)} act={act} withUndo={withUndo}
            onBook={(procs) => setBooking({ plan, procs })} canBook={can('schedule:write')} onQuote={(q) => setQuotes((all) => ({ ...all, [plan.id]: q }))} />
          {quoteable(plan) && <PlanMoney plan={plan} />}
          {quoteable(plan) && (
            <FinDesk plan={plan} patient={patient} quote={quotes[plan.id]} onChange={refresh}
              onQuote={(phases) => { setPhasesFor((all) => ({ ...all, [plan.id]: phases })); loadQuote(plan.id, phases); }}
              onBook={(procs) => setBooking({ plan, procs })} onConsent={(p) => setConsent(p)} />
          )}
        </div>
      ))}
      {adding && (
        <Modal title={`Add to “${adding.name}”`} wide onClose={() => setAdding(null)}>
          <AddWork plan={adding} patient={patient} unplanned={unplanned} onDone={() => { setAdding(null); refresh(); }} />
        </Modal>
      )}
      {booking && (
        <Modal title={`Schedule — ${booking.plan.name}`} wide onClose={() => setBooking(null)}>
          <AppointmentForm
            patient={patient}
            defaults={{
              date: practiceToday(practice?.timezone), procedure_ids: booking.procs.map((p) => p.id),
              duration: bookingMinutes(booking.procs, codes), reason: booking.procs.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}`).join(', '),
            }}
            onCancel={() => setBooking(null)} onSaved={() => { setBooking(null); refresh(); }}
          />
        </Modal>
      )}

      {unplanned.length > 0 && (
        <div className="card">
          <h3>Other planned procedures</h3>
          <ProcTable procs={unplanned} canEdit={canWrite} act={act} withUndo={withUndo} />
        </div>
      )}

      {creating && (
        <Modal title="New treatment plan" wide onClose={() => setCreating(false)}>
          <PlanBuilder patient={patient} unplanned={unplanned} onDone={() => { setCreating(false); refresh(); }} onCancel={() => setCreating(false)} />
        </Modal>
      )}
    </>
  );
}

// Insurance this benefit year vs next, with a suggested split when the annual maximum runs out. (The ways to
// pay are in FinDesk.)
function PlanMoney({ plan }) {
  const { data: years } = useApi(`/treatment-plans/${plan.id}/benefit-years?v=${plan.estimate?.total_insurance}`);
  if (!years?.policy) return null;
  return (
    <div className="plan-money">
      <div>
        <strong>Insurance</strong> ({years.policy.carrier_name}): {years.remaining_now != null ? <>{money(years.remaining_now)} left this benefit year, renews {fmtDate(years.renews)}.</> : null} This plan: insurance {money(years.all_now.insurance)}, patient {money(years.all_now.patient)}.
        {years.split && (
          <div className="plan-split">
            💡 Split across benefit years to get <strong>{money(years.split.saves)} more</strong> from insurance:
            {' '}now — {years.split.this_year.procedures.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}`).join(', ')} (insurance {money(years.split.this_year.insurance)});
            {' '}from {fmtDate(years.split.next_year.from)} — {years.split.next_year.procedures.map((p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}`).join(', ')} (insurance {money(years.split.next_year.insurance)}).
            {' '}Patient pays {money(years.split.patient)} instead of {money(years.all_now.patient)}. Give the later work its own phase with a date after the renewal to plan it that way.
          </div>
        )}
      </div>
    </div>
  );
}

// Appointment length from the codes' time units (10 minutes each), at least 30 minutes.
const bookingMinutes = (procs, codes) => {
  const units = procs.reduce((s, p) => s + (codes.find((c) => c.id === p.code_id)?.time_units || 0), 0);
  return Math.max(30, Math.ceil((units * 10) / 10) * 10 || 60);
};

// A plan's work by phase, in order (F1): drag work between phases (or ↑/↓ and the phase menu from the keyboard),
// name phases in place, move whole phases earlier or later, and see each phase's estimate — insurance,
// in-network write-off, the patient's share and which benefit year it falls in — update as you go.
function PlanTable({ plan, quote, codes, canEdit, act, withUndo, onBook, canBook }) {
  const est = Object.fromEntries((plan.estimate?.items || []).map((i) => [i.procedure_id, i]));
  const procs = plan.procedures;
  const qp = new Map((quote?.phases || []).map((p) => [p.phase, p]));
  const phases = [...new Set([...procs.map((p) => p.phase || 1), ...qp.keys()])].sort((a, b) => a - b);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const nameOf = (n) => qp.get(n)?.name || `Phase ${n}`;
  const order = (list) => api.put(`/treatment-plans/${plan.id}/order`, { items: list.map((p) => ({ id: p.id, phase: p.phase || 1 })) });
  const reorder = (list) => act(() => order(list));
  const move = (p, dir) => {
    const list = [...procs];
    const i = list.findIndex((x) => x.id === p.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    // Moving past a phase boundary joins that phase.
    list[j] = { ...list[j], phase: list[i].phase || 1 };
    reorder(list);
  };
  const setPhase = (p, phase) => reorder(procs.map((x) => (x.id === p.id ? { ...x, phase } : x)).sort((a, b) => (a.phase || 1) - (b.phase || 1)));
  // Dropped on a row: goes just before it, in its phase. Dropped on a phase heading: the end of that phase.
  const dropOn = (phase, beforeId) => {
    const p = procs.find((x) => x.id === drag);
    setDrag(null);
    setOver(null);
    if (!p || beforeId === p.id) return;
    const rest = procs.filter((x) => x.id !== p.id);
    let at = beforeId != null ? rest.findIndex((x) => x.id === beforeId) : -1;
    if (at < 0) at = rest.map((x) => (x.phase || 1) <= phase).lastIndexOf(true) + 1;
    rest.splice(at, 0, { ...p, phase });
    const list = rest.sort((a, b) => (a.phase || 1) - (b.phase || 1));
    withUndo(`${label(p)} moved to ${nameOf(phase)}`, () => order(list), () => order(procs));
  };
  const savePhase = (n, body) => act(() => api.put(`/treatment-plans/${plan.id}/phases/${n}`, body));
  const movePhase = (n, dir) => {
    const list = [...phases];
    const i = list.indexOf(n);
    [list[i], list[i + dir]] = [list[i + dir], list[i]];
    act(() => api.put(`/treatment-plans/${plan.id}/phase-order`, { order: list }));
  };
  const showEst = !!plan.estimate;
  const cols = showEst ? (plan.estimate.total_write_off > 0 ? 10 : 9) : 7;
  const multiYear = (quote?.years?.length || 0) > 1;
  const dragProps = (p) => (canEdit && p.status === 'planned' ? {
    draggable: true,
    onDragStart: (e) => { setDrag(p.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(p.id)); },
    onDragEnd: () => { setDrag(null); setOver(null); },
  } : {});
  const dropProps = (phase, beforeId) => ({
    onDragOver: (e) => { if (drag != null) { e.preventDefault(); setOver(phase); } },
    onDrop: (e) => { if (drag != null) { e.preventDefault(); dropOn(phase, beforeId); } },
  });
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Code</th><th>Description</th><th>Tooth / area</th><th>Status</th><th className="num">Fee</th>{showEst && <>{plan.estimate.total_write_off > 0 && <th className="num">PPO write-off</th>}<th className="num">Est. insurance</th><th className="num">Est. patient</th></>}<th /></tr>
        </thead>
        <tbody>
          {phases.map((phase, idx) => {
            const rows = procs.filter((p) => (p.phase || 1) === phase);
            const q = qp.get(phase);
            const sum = plan.phases?.find((x) => x.phase === phase);
            const open = rows.filter((p) => p.status === 'planned' && !p.appointment_id);
            return [
              phases.length > 1 || canEdit ? (
                <tr key={`ph-${phase}`} className={`phase-row${over === phase ? ' drop' : ''}`} {...dropProps(phase, null)}>
                  <td colSpan={cols}>
                    <div className="phase-head">
                      {canEdit ? (
                        <InlineEdit label={`Name of phase ${phase}`} value={nameOf(phase)} display={<strong>{nameOf(phase)}</strong>} width={200} text
                          valid={(v) => v.trim().length > 0 && v.trim().length <= 60} onSave={(v) => savePhase(phase, { name: v })} />
                      ) : <strong>{nameOf(phase)}</strong>}
                      {multiYear && q?.years?.length > 0 && <span className="phase-year" title="Estimated with this benefit year's maximum">{q.years.map((y) => `${y.slice(0, 4)} benefits`).join(', ')}</span>}
                      <span className="muted">{rows.length ? `${sum?.planned ?? rows.length} planned${q ? ` · ${q.visits} visit${q.visits === 1 ? '' : 's'}` : ''}` : 'Drag work here'}</span>
                      {canEdit && phases.length > 1 && (
                        <span className="inline" style={{ gap: 2 }}>
                          <button type="button" className="small" aria-label={`Move ${nameOf(phase)} earlier`} disabled={idx === 0} onClick={() => movePhase(phase, -1)}><ChevronUp size={14} /></button>
                          <button type="button" className="small" aria-label={`Move ${nameOf(phase)} later`} disabled={idx === phases.length - 1} onClick={() => movePhase(phase, 1)}><ChevronDown size={14} /></button>
                        </span>
                      )}
                      {canBook && open.length > 0 && <button className="small" onClick={() => onBook(open)}>Schedule {nameOf(phase).toLowerCase().startsWith('phase') ? `phase ${phase}` : nameOf(phase)}</button>}
                      {q && q.count > 0 && (
                        <span className="phase-money">
                          <span>fee {money(q.fee)}</span>
                          {q.write_off > 0 && <span>in-network −{money(q.write_off)}</span>}
                          {q.insurance > 0 && <span>insurance {money(q.insurance)}</span>}
                          <span>patient <strong>{money(q.you_pay)}</strong></span>
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ) : null,
              ...rows.map((p) => (
                <tr key={p.id} className={drag === p.id ? 'dragging' : ''} {...dragProps(p)} {...dropProps(p.phase || 1, p.id)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{canEdit && p.status === 'planned' && <GripVertical size={12} className="drag-dot" aria-hidden="true" />}{p.priority}</td>
                  <td>{p.code}</td>
                  <td>{p.description}</td>
                  <td>{p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''}{p.area ? QUADRANT_LABELS[p.area] : ''}</td>
                  <td><Badge value={p.status} />{p.appointment_id && p.status === 'planned' ? <div className="muted" style={{ fontSize: 11 }}>scheduled</div> : null}</td>
                  <td className="num">
                    {canEdit && p.status === 'planned' ? (
                      <InlineEdit
                        label={`Fee for ${p.code}${p.tooth ? ` #${p.tooth}` : ''} ($)`} value={fromCents(p.fee)} width={90} display={money(p.fee)}
                        valid={(v) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0}
                        onSave={(v) => toCents(v) !== p.fee && withUndo(`Fee for ${p.code}${p.tooth ? ` #${p.tooth}` : ''} is now ${money(toCents(v))}`,
                          () => api.put(`/procedures/${p.id}`, { fee: toCents(v) }), () => api.put(`/procedures/${p.id}`, { fee: p.fee }))}
                      />
                    ) : money(p.fee)}
                  </td>
                  {showEst && <>{plan.estimate.total_write_off > 0 && <td className="num muted">{est[p.id]?.write_off ? `−${money(est[p.id].write_off)}` : '—'}</td>}<td className="num">{est[p.id] ? money(est[p.id].insurance) : '—'}{est[p.id]?.notes?.length ? <div className="est-note" title={est[p.id].notes.join('\n')}>{est[p.id].notes.join(' · ')}</div> : null}</td><td className="num">{est[p.id] ? money(est[p.id].patient) : '—'}</td></>}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && p.status === 'planned' && (
                      <div className="row-actions">
                        <button className="small" title="Earlier" onClick={() => move(p, -1)}>↑</button>
                        <button className="small" title="Later" onClick={() => move(p, 1)}>↓</button>
                        <select className="small" value={p.phase || 1} onChange={(e) => setPhase(p, Number(e.target.value))} aria-label="Phase" style={{ width: 'auto' }}>
                          {[...new Set([...phases, 1, 2, 3, 4, 5])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{nameOf(n)}</option>)}
                        </select>
                        <button className="small" onClick={() => act(() => api.post(`/procedures/${p.id}/complete`))}>Complete</button>
                        <button className="small" title="Take it off this plan (stays on the chart)" onClick={() => withUndo(`${label(p)} taken off the plan`,
                          () => api.del(`/treatment-plans/${plan.id}/procedures/${p.id}`), () => api.post(`/treatment-plans/${plan.id}/procedures`, { procedure_ids: [p.id], keep_order: true }))}>Remove</button>
                        <button className="small danger" title="Remove from the chart (Undo puts it back)" aria-label={`Remove ${label(p)} from the chart`} onClick={() => withUndo(`${label(p)} removed from the chart`,
                          () => api.post(`/procedures/${p.id}/cancel`), () => api.post(`/procedures/${p.id}/restore`))}>✕</button>
                      </div>
                    )}
                  </td>
                </tr>
              )),
            ];
          })}
          {showEst && (
            <tr className="totals-row">
              <td colSpan={5}>
                Remaining planned {plan.estimate.policy ? `· ${plan.estimate.policy.carrier_name}` : '· self-pay'}
                {canEdit && phases.length < 9 && <button type="button" className="small" style={{ marginLeft: 10 }} onClick={() => savePhase(Math.max(0, ...phases) + 1, { name: `Phase ${Math.max(0, ...phases) + 1}` })}><Plus size={13} /> Phase</button>}
              </td>
              <td className="num">{money(plan.estimate.total_fee)}</td>
              {plan.estimate.total_write_off > 0 && <td className="num">−{money(plan.estimate.total_write_off)}</td>}
              <td className="num">{money(plan.estimate.total_insurance)}</td>
              <td className="num">
                {money(plan.estimate.total_patient)}
                {plan.estimate.discount > 0 && <div className="est-note">−{money(plan.estimate.discount)} {plan.estimate.membership?.total ? `${plan.estimate.membership.plan_name} member savings` : 'discount'} → {money(plan.estimate.patient_after_discount)}</div>}
              </td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
      {!procs.length && <div className="muted">Nothing on this plan yet.</div>}
      {quote?.policy && quote.all_years?.length > 0 && (
        <div className="fin-years">
          {quote.all_years.map((y) => (
            <span key={y.start || 'all'} className={y.limited ? 'warn' : ''}>
              {y.start ? `Benefit year from ${fmtDate(y.start)}` : 'Benefits'}: insurance {money(y.insurance)}{y.max_left_after != null ? ` · ${money(y.max_left_after)} of the maximum left after` : ''}{y.limited ? ' · maximum reached' : ''}
            </span>
          ))}
          {quote.ppo_savings > 0 && <span>In-network savings {money(quote.ppo_savings)}</span>}
        </div>
      )}
    </div>
  );
}

function AddWork({ plan, patient, unplanned, onDone }) {
  const codes = useLookup('/procedure-codes?active=true');
  const [code, setCode] = useState(null);
  const [tooth, setTooth] = useState('');
  const [surfaces, setSurfaces] = useState('');
  const [area, setArea] = useState('');
  const [phase, setPhase] = useState(1);
  const [attach, setAttach] = useState([]);
  const kind = codeArea(code);
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/treatment-plans/${plan.id}/procedures`, {
      procedure_ids: attach,
      procedures: code ? [{
        code_id: code.id, tooth: kind === 'tooth' ? tooth || null : null, surfaces: kind === 'tooth' ? surfaces || null : null,
        area: ['quadrant', 'arch'].includes(kind) ? area : null, provider_id: patient.primary_provider_id || null, phase: Number(phase),
      }] : [],
    });
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <CodePicker value={code} onChange={setCode} codes={codes} />
      {code && (
        <div className="form-grid" style={{ marginTop: 10 }}>
          {kind === 'tooth' && <label>Tooth<input value={tooth} onChange={(e) => setTooth(e.target.value.toUpperCase())} placeholder={code.requires_tooth ? 'required' : ''} /></label>}
          {kind === 'tooth' && <label>Surfaces<input value={surfaces} onChange={(e) => setSurfaces(e.target.value.toUpperCase())} placeholder={code.requires_surface ? 'e.g. MOD' : ''} /></label>}
          {['quadrant', 'arch'].includes(kind) && (
            <label>
              {kind === 'quadrant' ? 'Quadrant' : 'Arch'}
              <select value={area} onChange={(e) => setArea(e.target.value)} required>
                <option value="">Choose…</option>
                {(kind === 'quadrant' ? ['UR', 'UL', 'LL', 'LR'] : ['U', 'L']).map((a) => <option key={a} value={a}>{QUADRANT_LABELS[a]}</option>)}
              </select>
            </label>
          )}
          <label>Phase<select value={phase} onChange={(e) => setPhase(e.target.value)}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>Phase {n}</option>)}</select></label>
        </div>
      )}
      {unplanned.length > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>Or add work already charted</h3>
          {unplanned.map((p) => (
            <label key={p.id} className="checkbox">
              <input type="checkbox" checked={attach.includes(p.id)} onChange={(e) => setAttach(e.target.checked ? [...attach, p.id] : attach.filter((x) => x !== p.id))} />
              {p.code} {p.description} {p.tooth ? `#${p.tooth}` : ''}{p.area ? ` ${p.area}` : ''} · {money(p.fee)}
            </label>
          ))}
        </>
      )}
      <div className="form-actions"><button className="primary" disabled={busy || (!code && !attach.length)}>Add to plan</button></div>
    </form>
  );
}

const label = (p) => `${p.code}${p.tooth ? ` #${p.tooth}` : ''}`;

function ProcTable({ procs, estimate, canEdit, act, withUndo }) {
  const est = Object.fromEntries((estimate?.items || []).map((i) => [i.procedure_id, i]));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Code</th><th>Description</th><th>Tooth</th><th>Status</th><th className="num">Fee</th>{estimate && <>{estimate.total_write_off > 0 && <th className="num">PPO write-off</th>}<th className="num">Est. insurance</th><th className="num">Est. patient</th></>}<th /></tr>
        </thead>
        <tbody>
          {procs.map((p) => (
            <tr key={p.id}>
              <td>{p.priority}</td>
              <td>{p.code}</td>
              <td>{p.description}</td>
              <td>{p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''}</td>
              <td><Badge value={p.status} />{p.appointment_id && p.status === 'planned' ? <div className="muted" style={{ fontSize: 11 }}>scheduled</div> : null}</td>
              <td className="num">{money(p.fee)}</td>
              {estimate && <>{estimate.total_write_off > 0 && <td className="num muted">{est[p.id]?.write_off ? `−${money(est[p.id].write_off)}` : '—'}</td>}<td className="num">{est[p.id] ? money(est[p.id].insurance) : '—'}{est[p.id]?.notes?.length ? <div className="est-note" title={est[p.id].notes.join('\n')}>{est[p.id].notes.join(' · ')}</div> : null}</td><td className="num">{est[p.id] ? money(est[p.id].patient) : '—'}</td></>}
              <td style={{ whiteSpace: 'nowrap' }}>
                {canEdit && p.status === 'planned' && (
                  <>
                    <button className="small" onClick={() => act(() => api.post(`/procedures/${p.id}/complete`))}>Complete</button>{' '}
                    <button className="small danger" title="Remove from the chart (Undo puts it back)" aria-label={`Remove ${label(p)} from the chart`} onClick={() => withUndo(`${label(p)} removed from the chart`,
                      () => api.post(`/procedures/${p.id}/cancel`), () => api.post(`/procedures/${p.id}/restore`))}>✕</button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {estimate && (
            <tr className="totals-row">
              <td colSpan={5}>Remaining planned {estimate.policy ? `· ${estimate.policy.carrier_name}` : '· self-pay'}</td>
              <td className="num">{money(estimate.total_fee)}</td>
              {estimate.total_write_off > 0 && <td className="num">−{money(estimate.total_write_off)}</td>}
              <td className="num">{money(estimate.total_insurance)}</td>
              <td className="num">{money(estimate.total_patient)}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Click (or Enter) to edit in place; Enter saves, Esc puts it back. No prompt boxes.
function InlineEdit({ value, display, label, valid = () => true, onSave, width = 80, suffix = '', text = false }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const done = useRef(false);
  if (!editing) {
    return <button type="button" className="link-button" title={label} aria-label={label} onClick={() => { setV(value); done.current = false; setEditing(true); }}>{display}</button>;
  }
  const finish = (save) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    if (save && v !== value && valid(v)) onSave(v.trim());
  };
  return (
    <span className="inline-edit">
      <input
        autoFocus aria-label={label} value={v} inputMode={text ? 'text' : 'decimal'} style={{ width, ...(text ? { textAlign: 'left' } : {}) }} className={valid(v) ? '' : 'invalid'}
        onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()} onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        }}
      />{suffix}
    </span>
  );
}

// "UR", "UL", "LL", "LR" in a typed line are the quadrant for scaling and root planing and the like.
const pullArea = (text) => {
  let area = '';
  const rest = text.replace(/\b(UR|UL|LL|LR)\b/gi, (m) => { area = m.toUpperCase(); return ' '; });
  return { area, rest: rest.trim() };
};
let rowSeq = 0;

// Building a plan by typing it the way it's called out: "14 D2740", "30 MO filling", "2-4 sealant", "D4341 UR"
// and Enter for each; or search for a code by name. Ctrl/⌘+Enter makes the plan. Charted work that isn't on a
// plan yet starts ticked.
function PlanBuilder({ patient, unplanned = [], onDone, onCancel }) {
  const { practice } = useAuth();
  const codes = useLookup('/procedure-codes?active=true');
  const providers = useLookup('/providers?active=true');
  const [name, setName] = useState(() => `Treatment plan — ${practiceToday(practice?.timezone)}`);
  const [providerId, setProviderId] = useState(patient.primary_provider_id || '');
  const [items, setItems] = useState([]);
  const [line, setLine] = useState('');
  const [lineErr, setLineErr] = useState(null);
  const [focusRow, setFocusRow] = useState(null);
  const rowInputs = useRef({});
  const byCode = useMemo(() => new Map(codes.map((c) => [c.code, c])), [codes]);
  const byId = useMemo(() => new Map(codes.map((c) => [String(c.id), c])), [codes]);
  // Work already charted on the odontogram starts ticked.
  const [attach, setAttach] = useState(() => unplanned.map((p) => p.id));
  useEffect(() => {
    if (focusRow != null) rowInputs.current[focusRow]?.focus();
  }, [focusRow]);

  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/treatment-plans`, {
      name,
      procedure_ids: attach,
      procedures: items.map((i) => ({
        code_id: i.code_id, tooth: i.tooth || null, surfaces: i.surfaces || null, area: i.area || null, provider_id: providerId ? Number(providerId) : null,
      })),
    });
    onDone();
  });
  useShortcuts([{ combo: 'mod+enter', handler: () => !busy && submit(), label: 'Make the plan', section: 'Treatment', inInputs: true }]);

  const addLine = () => {
    const text = line.trim();
    if (!text) return;
    try {
      const { area, rest } = pullArea(text);
      // Everything in a plan is work to do, so "14 crown" means a planned crown here.
      const said = /\b(plan|planned|tx|done|existing|ex)\b/i.test(rest) ? rest : `${rest} plan`;
      const add = parseEntry(said).map((p) => {
        if (p.type !== 'procedure') throw new Error(`That's a finding, not work — chart it on the Chart tab (“${text}”)`);
        const code = byCode.get(p.code);
        if (!code) throw new Error(`${p.code} isn't in your procedure codes`);
        return { key: ++rowSeq, code_id: code.id, tooth: p.tooth || '', surfaces: p.surfaces || '', area };
      });
      setItems((list) => [...list, ...add]);
      setLine('');
      setLineErr(null);
    } catch (e) {
      setLineErr(e.message);
    }
  };
  const pick = (c) => {
    if (!c) return;
    const key = ++rowSeq;
    setItems((list) => [...list, { key, code_id: c.id, tooth: '', surfaces: '', area: '' }]);
    // Straight to the tooth (or quadrant) for codes that need one.
    if (codeArea(c) !== 'mouth') setFocusRow(key);
  };
  const setItem = (key, k, v) => setItems(items.map((it) => (it.key === key ? { ...it, [k]: v } : it)));
  const chosen = unplanned.filter((p) => attach.includes(p.id));
  const total = items.reduce((sum, i) => sum + (byId.get(String(i.code_id))?.fee || 0), 0) + chosen.reduce((sum, p) => sum + (p.fee || 0), 0);

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <label className="plan-quick">
        Add work — tooth and code or what it is, Enter for each
        <input
          value={line} onChange={(e) => { setLine(e.target.value); setLineErr(null); }} aria-label="Add work to the plan"
          placeholder="14 D2740 · 30 MO filling · 2-4 sealant · 19 rct · D4341 UR"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); addLine(); }
          }}
        />
      </label>
      {lineErr && <div className="text-danger" style={{ fontSize: 13, marginTop: 4 }}>{lineErr}</div>}
      <div className="plan-search">
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Or find a code by name</div>
        <CodePicker value={null} onChange={pick} codes={codes} />
      </div>

      {items.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Procedure</th><th style={{ width: 90 }}>Tooth / area</th><th style={{ width: 110 }}>Surfaces</th><th className="num">Fee</th><th /></tr></thead>
          <tbody>
            {items.map((it) => {
              const code = byId.get(String(it.code_id));
              const kind = codeArea(code);
              return (
                <tr key={it.key}>
                  <td><strong>{code?.code}</strong> {code?.description}</td>
                  <td>
                    {kind === 'tooth' && <input ref={(el) => { rowInputs.current[it.key] = el; }} aria-label={`Tooth for ${code?.code}`} value={it.tooth} onChange={(e) => setItem(it.key, 'tooth', e.target.value.toUpperCase())} placeholder={code?.requires_tooth ? 'req.' : ''} />}
                    {['quadrant', 'arch'].includes(kind) && (
                      <select ref={(el) => { rowInputs.current[it.key] = el; }} aria-label={kind === 'quadrant' ? 'Quadrant' : 'Arch'} value={it.area} onChange={(e) => setItem(it.key, 'area', e.target.value)}>
                        <option value="">Choose…</option>
                        {(kind === 'quadrant' ? ['UR', 'UL', 'LL', 'LR'] : ['U', 'L']).map((a) => <option key={a} value={a}>{QUADRANT_LABELS[a]}</option>)}
                      </select>
                    )}
                  </td>
                  <td>{kind === 'tooth' && <input aria-label={`Surfaces for ${code?.code}`} value={it.surfaces} onChange={(e) => setItem(it.key, 'surfaces', e.target.value.toUpperCase())} placeholder={code?.requires_surface ? 'e.g. MOD' : ''} />}</td>
                  <td className="num">{code ? money(code.fee) : ''}</td>
                  <td><button type="button" className="small" aria-label={`Take ${code?.code} off`} onClick={() => setItems(items.filter((x) => x.key !== it.key))}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {unplanned.length > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>Charted work to include</h3>
          {unplanned.map((p) => (
            <label key={p.id} className="checkbox">
              <input type="checkbox" checked={attach.includes(p.id)} onChange={(e) => setAttach(e.target.checked ? [...attach, p.id] : attach.filter((x) => x !== p.id))} />
              {p.code} {p.description} {p.tooth ? `#${p.tooth}` : ''}{p.area ? ` ${p.area}` : ''} · {money(p.fee)}
            </label>
          ))}
        </>
      )}
      <div className="form-grid" style={{ marginTop: 14 }}>
        <label>Plan name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>
          Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <div className="form-actions">
        <span className="muted" style={{ marginRight: 'auto' }}>{items.length + chosen.length} procedure{items.length + chosen.length === 1 ? '' : 's'} · {money(total)}</span>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy || (!items.length && !chosen.length)} title="Ctrl/⌘+Enter">Create plan</button>
      </div>
    </form>
  );
}

// Present: open it right here for the patient in the chair (no birth date on this signed-in device, and a way back
// to the chart when they're done), or text/email it to review at home (the birth date is asked there).
function PresentModal({ plan, patient, onClose }) {
  const navigate = useNavigate();
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async (send) => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post(`/treatment-plans/${plan.id}/present`, send ? { send } : { here: true });
      if (!send) {
        navigate(`${new URL(r.url, window.location.origin).pathname}#here=${encodeURIComponent(r.handoff)}`);
        return;
      }
      setResult(r);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Present “${plan.name}”`} onClose={onClose}>
      <ErrorBox error={err} />
      {!result ? (
        <>
          <div className="inline" style={{ flexWrap: 'wrap' }}>
            <button className="primary" disabled={busy} onClick={() => go(null)}>Open here for {patient.first_name} to sign</button>
            <button disabled={busy || (!patient.phone && !patient.email)} onClick={() => go('auto')}>Text or email to {patient.first_name}</button>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>They see each procedure in plain language with their estimated insurance and cost, then sign. On this device they won't be asked for their birth date; “Back to the chart” at the bottom brings you back.</p>
        </>
      ) : (
        <div className="public-notice ok">
          Sent by {result.message?.channel === 'sms' ? 'text' : 'email'}. Link: <a href={result.url} target="_blank" rel="noreferrer">{result.url}</a>
        </div>
      )}
    </Modal>
  );
}
