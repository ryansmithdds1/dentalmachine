import { useState } from 'react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, practiceToday, toCents, fromCents } from '../../format.js';
import { Badge, ErrorBox, Modal, useSubmit } from '../ui.jsx';
import AppointmentForm from '../AppointmentForm.jsx';
import { CodePicker } from './ChartTab.jsx';
import SendForms from '../FormsSend.jsx';
import { codeArea, QUADRANT_LABELS } from '../Odontogram.jsx';

export default function TreatmentTab({ patient, onChange }) {
  const { can, practice } = useAuth();
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

  return (
    <>
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Treatment plans</h2>
        {can('clinical:write') && <button className="primary" onClick={() => setCreating(true)}>+ New treatment plan</button>}
      </div>
      <ErrorBox error={err} />
      {note && <div className="public-notice ok" style={{ marginBottom: 12 }}>{note}</div>}
      {presenting && <PresentModal plan={presenting} patient={patient} onClose={() => { setPresenting(null); refresh(); }} />}
      {consent && (
        <SendForms patient={patient} title={`Consent for “${consent.name}”`} procedureIds={consent.procedures.filter((p) => p.status === 'planned').map((p) => p.id)} onClose={() => setConsent(null)} />
      )}
      {plans?.length === 0 && unplanned.length === 0 && <div className="card empty">No treatment planned.</div>}

      {plans?.map((plan) => (
        <div className="card" key={plan.id}>
          <div className="page-header" style={{ marginBottom: 10 }}>
            <div>
              <h3 style={{ margin: 0 }}>{plan.name}{plan.option_label ? <span className="badge info" style={{ marginLeft: 6 }}>{plan.option_label}</span> : null} <Badge value={plan.status} />{plan.discount_pct > 0 && <span className="badge ok" style={{ marginLeft: 6 }}>{plan.discount_pct}% discount</span>}</h3>
              <div className="muted">
                Created {fmtDate(plan.created_at)}{plan.accepted_at ? ` · Accepted ${fmtDate(plan.accepted_at)}` : ''}
                {plan.signed_at && <> · <span className="badge ok">✍ Signed by {plan.signature_name}</span> <a href={`/treatment-plans/${plan.id}/print?signed=1`} target="_blank" rel="noreferrer">signed copy</a></>}
                {plan.signed_version?.changed && <> · <span className="badge warn" title="The plan was edited after the patient signed it. The signed copy is kept as it was; put new work in a new plan to get it signed.">Changed since signed</span></>}
                {!plan.signed_at && plan.presented_at && ` · Sent to patient ${fmtDate(plan.presented_at)}`}
              </div>
            </div>
            {can('clinical:write') && plan.status !== 'completed' && (
              <div className="actions">
                {!plan.signed_at && <button className="small primary" onClick={() => setPresenting(plan)}>Present & e-sign…</button>}
                {plan.estimate?.policy && can('billing:write') && plan.procedures.some((p) => p.status === 'planned') && (
                  <button className="small" onClick={() => act(async () => { await api.post('/preauths', { patient_insurance_id: plan.estimate.policy.id, treatment_plan_id: plan.id }); setNote('Pre-authorization created — send it from Billing → Pre-authorizations.'); })}>Pre-authorize</button>
                )}
                <button className="small" onClick={() => window.open(`/treatment-plans/${plan.id}/print`, '_blank')}>Print</button>
                {plan.procedures.some((p) => p.status === 'planned') && <button className="small" title="Informed consent for this plan's procedures" onClick={() => setConsent(plan)}>Consent…</button>}
                {plan.status !== 'rejected' && <button className="small" onClick={() => setAdding(plan)}>+ Add work</button>}
                {plan.status === 'proposed' && <button className="small" title="A copy of this plan's unstarted work to change into another option (e.g. implant vs bridge). Accepting one option declines the others." onClick={() => act(() => api.post(`/treatment-plans/${plan.id}/duplicate`, {}))}>+ Alternative</button>}
                {plan.status !== 'rejected' && (
                  <button className="small" onClick={() => {
                    const v = window.prompt("Discount on the patient's share of this plan (%) — posted as an adjustment as each procedure is done:", String(plan.discount_pct || 0));
                    if (v != null && v.trim() !== '') act(() => api.put(`/treatment-plans/${plan.id}`, { discount_pct: Number(v) }));
                  }}>Discount…</button>
                )}
                {plan.status === 'proposed' && <button className="small" onClick={() => act(() => api.put(`/treatment-plans/${plan.id}`, { status: 'accepted' }))}>Accepted verbally</button>}
                {plan.status === 'proposed' && <button className="small danger" onClick={() => act(() => api.put(`/treatment-plans/${plan.id}`, { status: 'rejected' }))}>Declined</button>}
              </div>
            )}
          </div>
          <PlanTable plan={plan} codes={codes} canEdit={can('clinical:write') && !['completed', 'rejected'].includes(plan.status)} act={act}
            onBook={(procs) => setBooking({ plan, procs })} canBook={can('schedule:write')} />
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
          <ProcTable procs={unplanned} canEdit={can('clinical:write')} act={act} />
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

// Appointment length from the codes' time units (10 minutes each), at least 30 minutes.
const bookingMinutes = (procs, codes) => {
  const units = procs.reduce((s, p) => s + (codes.find((c) => c.id === p.code_id)?.time_units || 0), 0);
  return Math.max(30, Math.ceil((units * 10) / 10) * 10 || 60);
};

// A plan's work by phase, in order: move rows, change phases, override fees, take work off the plan.
function PlanTable({ plan, codes, canEdit, act, onBook, canBook }) {
  const est = Object.fromEntries((plan.estimate?.items || []).map((i) => [i.procedure_id, i]));
  const procs = plan.procedures;
  const phases = [...new Set(procs.map((p) => p.phase || 1))].sort((a, b) => a - b);
  const reorder = (list) => act(() => api.put(`/treatment-plans/${plan.id}/order`, { items: list.map((p) => ({ id: p.id, phase: p.phase || 1 })) }));
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
  const showEst = !!plan.estimate;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Code</th><th>Description</th><th>Tooth / area</th><th>Status</th><th className="num">Fee</th>{showEst && <>{plan.estimate.total_write_off > 0 && <th className="num">PPO write-off</th>}<th className="num">Est. insurance</th><th className="num">Est. patient</th></>}<th /></tr>
        </thead>
        <tbody>
          {phases.map((phase) => {
            const rows = procs.filter((p) => (p.phase || 1) === phase);
            const sum = plan.phases?.find((x) => x.phase === phase);
            const open = rows.filter((p) => p.status === 'planned' && !p.appointment_id);
            return [
              phases.length > 1 || canEdit ? (
                <tr key={`ph-${phase}`} className="phase-row">
                  <td colSpan={showEst ? (plan.estimate.total_write_off > 0 ? 10 : 9) : 7}>
                    <strong>Phase {phase}</strong>
                    {sum && <span className="muted"> · {sum.planned} planned · {money(sum.fee)}{showEst ? ` · est. insurance ${money(sum.insurance)}` : ''}</span>}
                    {canBook && open.length > 0 && <button className="small" style={{ marginLeft: 10 }} onClick={() => onBook(open)}>Schedule phase {phase}</button>}
                  </td>
                </tr>
              ) : null,
              ...rows.map((p) => (
                <tr key={p.id}>
                  <td>{p.priority}</td>
                  <td>{p.code}</td>
                  <td>{p.description}</td>
                  <td>{p.tooth ? `#${p.tooth}` : ''} {p.surfaces || ''}{p.area ? QUADRANT_LABELS[p.area] : ''}</td>
                  <td><Badge value={p.status} />{p.appointment_id && p.status === 'planned' ? <div className="muted" style={{ fontSize: 11 }}>scheduled</div> : null}</td>
                  <td className="num">
                    {canEdit && p.status === 'planned' ? (
                      <button className="link-button" title="Change the fee for this patient" onClick={() => {
                        const v = window.prompt(`Fee for ${p.code}${p.tooth ? ` #${p.tooth}` : ''} ($):`, fromCents(p.fee));
                        if (v != null && v.trim() !== '' && Number.isFinite(Number(v))) act(() => api.put(`/procedures/${p.id}`, { fee: toCents(v) }));
                      }}>{money(p.fee)}</button>
                    ) : money(p.fee)}
                  </td>
                  {showEst && <>{plan.estimate.total_write_off > 0 && <td className="num muted">{est[p.id]?.write_off ? `−${money(est[p.id].write_off)}` : '—'}</td>}<td className="num">{est[p.id] ? money(est[p.id].insurance) : '—'}{est[p.id]?.notes?.length ? <div className="est-note" title={est[p.id].notes.join('\n')}>{est[p.id].notes.join(' · ')}</div> : null}</td><td className="num">{est[p.id] ? money(est[p.id].patient) : '—'}</td></>}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && p.status === 'planned' && (
                      <div className="row-actions">
                        <button className="small" title="Earlier" onClick={() => move(p, -1)}>↑</button>
                        <button className="small" title="Later" onClick={() => move(p, 1)}>↓</button>
                        <select className="small" value={p.phase || 1} onChange={(e) => setPhase(p, Number(e.target.value))} aria-label="Phase" style={{ width: 'auto' }}>
                          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>Phase {n}</option>)}
                        </select>
                        <button className="small" onClick={() => act(() => api.post(`/procedures/${p.id}/complete`))}>Complete</button>
                        <button className="small" title="Take it off this plan (stays on the chart)" onClick={() => act(() => api.del(`/treatment-plans/${plan.id}/procedures/${p.id}`))}>Remove</button>
                        <button className="small danger" title="Delete from the chart" onClick={() => confirm('Delete this procedure from the chart?') && act(() => api.post(`/procedures/${p.id}/cancel`))}>✕</button>
                      </div>
                    )}
                  </td>
                </tr>
              )),
            ];
          })}
          {showEst && (
            <tr className="totals-row">
              <td colSpan={5}>Remaining planned {plan.estimate.policy ? `· ${plan.estimate.policy.carrier_name}` : '· self-pay'}</td>
              <td className="num">{money(plan.estimate.total_fee)}</td>
              {plan.estimate.total_write_off > 0 && <td className="num">−{money(plan.estimate.total_write_off)}</td>}
              <td className="num">{money(plan.estimate.total_insurance)}</td>
              <td className="num">
                {money(plan.estimate.total_patient)}
                {plan.estimate.discount > 0 && <div className="est-note">−{money(plan.estimate.discount)} discount → {money(plan.estimate.patient_after_discount)}</div>}
              </td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
      {!procs.length && <div className="muted">Nothing on this plan yet.</div>}
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

function ProcTable({ procs, estimate, canEdit, act }) {
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
                    <button className="small danger" onClick={() => confirm('Remove this procedure from the plan?') && act(() => api.post(`/procedures/${p.id}/cancel`))}>✕</button>
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

function PlanBuilder({ patient, unplanned = [], onDone, onCancel }) {
  const codes = useLookup('/procedure-codes?active=true');
  const providers = useLookup('/providers?active=true');
  const [name, setName] = useState('Treatment plan');
  const [providerId, setProviderId] = useState(patient.primary_provider_id || '');
  const [items, setItems] = useState([{ code_id: '', tooth: '', surfaces: '' }]);
  // Work already charted on the odontogram starts ticked.
  const [attach, setAttach] = useState(() => unplanned.map((p) => p.id));
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${patient.id}/treatment-plans`, {
      name,
      procedure_ids: attach,
      procedures: items.filter((i) => i.code_id).map((i) => ({
        code_id: Number(i.code_id), tooth: i.tooth || null, surfaces: i.surfaces || null, provider_id: providerId ? Number(providerId) : null,
      })),
    });
    onDone();
  });
  const setItem = (idx, k, v) => setItems(items.map((it, i) => (i === idx ? { ...it, [k]: v } : it)));
  const total = items.reduce((s, i) => s + (codes.find((c) => String(c.id) === String(i.code_id))?.fee || 0), 0);

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>Plan name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>
          Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <table style={{ marginTop: 14 }}>
        <thead><tr><th>Procedure</th><th style={{ width: 90 }}>Tooth</th><th style={{ width: 110 }}>Surfaces</th><th className="num">Fee</th><th /></tr></thead>
        <tbody>
          {items.map((it, idx) => {
            const code = codes.find((c) => String(c.id) === String(it.code_id));
            return (
              <tr key={idx}>
                <td>
                  <select value={it.code_id} onChange={(e) => setItem(idx, 'code_id', e.target.value)}>
                    <option value="">Select…</option>
                    {codes.map((c) => <option key={c.id} value={c.id}>{c.code} – {c.description}</option>)}
                  </select>
                </td>
                <td><input value={it.tooth} onChange={(e) => setItem(idx, 'tooth', e.target.value)} placeholder={code?.requires_tooth ? 'req.' : ''} /></td>
                <td><input value={it.surfaces} onChange={(e) => setItem(idx, 'surfaces', e.target.value.toUpperCase())} placeholder={code?.requires_surface ? 'e.g. MOD' : ''} /></td>
                <td className="num">{code ? money(code.fee) : ''}</td>
                <td><button type="button" className="small" onClick={() => setItems(items.filter((_, i) => i !== idx))}>✕</button></td>
              </tr>
            );
          })}
          <tr className="totals-row"><td colSpan={3}>Total</td><td className="num">{money(total)}</td><td /></tr>
        </tbody>
      </table>
      <button type="button" className="small" style={{ marginTop: 8 }} onClick={() => setItems([...items, { code_id: '', tooth: '', surfaces: '' }])}>+ Add procedure</button>
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
      <div className="form-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy}>Create plan</button>
      </div>
    </form>
  );
}

function PresentModal({ plan, patient, onClose }) {
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const go = async (send) => {
    setErr(null);
    try {
      const r = await api.post(`/treatment-plans/${plan.id}/present`, send ? { send } : {});
      setResult(r);
      if (!send) window.open(r.url, '_blank');
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal title={`Present “${plan.name}”`} onClose={onClose}>
      <ErrorBox error={err} />
      <p>The patient sees each procedure in plain language with their estimated insurance and out-of-pocket cost, then signs to accept.</p>
      {!result ? (
        <div className="inline" style={{ flexWrap: 'wrap' }}>
          <button className="primary" onClick={() => go(null)}>Open on this screen / tablet</button>
          <button onClick={() => go('auto')} disabled={!patient.phone && !patient.email}>Text or email to {patient.first_name}</button>
        </div>
      ) : (
        <div className="public-notice ok">
          {result.message ? `Sent by ${result.message.channel === 'sms' ? 'text' : 'email'}. ` : 'Opened in a new tab. '}
          Link: <a href={result.url} target="_blank" rel="noreferrer">{result.url}</a>
        </div>
      )}
    </Modal>
  );
}
