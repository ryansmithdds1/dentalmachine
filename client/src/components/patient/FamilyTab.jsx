import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, fmtDateTime, age, label } from '../../format.js';
import { ErrorBox, Modal, PatientPicker, useSubmit } from '../ui.jsx';
import { toast } from '../../toast.js';

// Household view: everyone the guarantor is responsible for, with balances, visits and recall.
export default function FamilyTab({ patient, onChange }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const { data, reload } = useApi(`/patients/${patient.id}/family`);
  const [modal, setModal] = useState(null);
  const [err, setErr] = useState(null);
  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      reload();
      onChange?.();
    } catch (e) {
      setErr(e);
    }
  };
  if (!data) return <div className="empty">Loading…</div>;
  const g = data.guarantor;

  return (
    <>
      <ErrorBox error={err} />
      <div className="card">
        <div className="page-header" style={{ marginBottom: 10 }}>
          <div>
            <h2 style={{ margin: 0 }}>{g.last_name} family</h2>
            <div className="muted">Guarantor: <Link to={`/patients/${g.id}`}>{g.first_name} {g.last_name}</Link> · {[g.address, g.city, g.state].filter(Boolean).join(', ') || 'no address'}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              Also responsible: {data.second_responsible ? <Link to={`/patients/${data.second_responsible.id}`}>{data.second_responsible.first_name} {data.second_responsible.last_name}</Link> : 'nobody'}
              {can('patients:write') && <> · <button className="link" onClick={() => setModal('second')}>{data.second_responsible ? 'change' : 'add'}</button></>}
              {data.second_responsible && can('patients:write') && <> · <button className="link" onClick={() => act(() => api.put(`/patients/${g.id}/family-responsible`, { patient_id: null }))}>remove</button></>}
            </div>
          </div>
          <div className="actions">
            <div style={{ textAlign: 'right' }}>
              <div className="muted" style={{ fontSize: 12 }}>Family balance</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: data.family_balance > 0 ? 'var(--danger)' : undefined }}>{money(data.family_balance)}</div>
            </div>
            <Link to={`/patients/${g.id}/statement?family=1`}><button>Family statement</button></Link>
            {can('schedule:write') && data.members.length > 1 && <button onClick={() => setModal('book')}>Book family visit</button>}
            {can('patients:write') && <button onClick={() => setModal('link')}>Link existing patient</button>}
            {can('patients:write') && <button className="primary" onClick={() => { setModal(null); setTimeout(() => document.querySelector('.family-add input')?.focus(), 0); }} title="Type the name and birth date on the add line">+ Add family member</button>}
          </div>
        </div>
        {can('patients:write') && (modal === 'new'
          ? <div className="inline-editor"><h3>Add family member</h3><NewMember guarantor={g} onDone={() => { setModal(null); reload(); onChange?.(); }} onCancel={() => setModal(null)} /></div>
          : <FamilyAddLine guarantor={g} onDone={() => { reload(); onChange?.(); }} onMore={() => setModal('new')} />)}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Relationship</th><th>Age</th><th>Next visit</th><th>Recall due</th><th className="num">Balance</th><th /></tr></thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.id} className="clickable" onClick={() => nav(`/patients/${m.id}`)} style={m.id === patient.id ? { background: 'var(--primary-soft)' } : undefined}>
                  <td>
                    <strong>{m.first_name} {m.last_name}</strong>
                    {m.id === g.id && <span className="badge ok" style={{ marginLeft: 6 }}>Guarantor</span>}
                    {m.medical_alerts && <span className="alert-chip" style={{ marginLeft: 6 }} title={m.medical_alerts}>⚠</span>}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {m.id === g.id ? <span className="muted">Head of household</span> : can('patients:write') ? (
                      <select aria-label={`${m.first_name}'s relationship`} value={m.family_relationship || ''} style={{ width: 'auto' }}
                        onChange={(e) => act(() => api.put(`/patients/${g.id}/family/${m.id}`, { relationship: e.target.value || null }))}>
                        <option value="">—</option>
                        {data.relationships.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                      </select>
                    ) : label(m.family_relationship || '') || '—'}
                  </td>
                  <td>{m.dob ? age(m.dob) : '—'}</td>
                  <td>{m.next_appointment ? fmtDateTime(m.next_appointment) : <span className="muted">None</span>}</td>
                  <td>{m.recall_due ? fmtDate(m.recall_due) : '—'}</td>
                  <td className="num">{money(m.balance)}</td>
                  <td style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    {can('patients:write') && m.id !== g.id && (
                      <>
                        <button className="small" onClick={() => act(() => api.post(`/patients/${m.id}/family/guarantor`))}>Make guarantor</button>{' '}
                        <button className="small danger" onClick={() => setModal({ unlink: m })}>Remove</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal === 'book' && (
        <Modal title={`Book the ${g.last_name} family`} wide onClose={() => setModal(null)}>
          <FamilyBooking members={data.members} onDone={(appts) => { setModal(null); reload(); onChange?.(); if (appts?.length) nav(`/schedule?date=${appts[0].start_time.slice(0, 10)}`); }} />
        </Modal>
      )}
      {modal === 'second' && (
        <Modal title="Second responsible party" onClose={() => setModal(null)}>
          <SecondResponsible guarantor={g} onDone={() => { setModal(null); reload(); }} />
        </Modal>
      )}
      {modal?.unlink && (
        <Modal title={`Remove ${modal.unlink.first_name} from the family`} onClose={() => setModal(null)}>
          <Unlink guarantor={g} member={modal.unlink} onDone={() => { setModal(null); reload(); onChange?.(); }} />
        </Modal>
      )}
      {modal === 'link' && (
        <Modal title="Link an existing patient" onClose={() => setModal(null)}>
          <LinkMember guarantor={g} onDone={() => { setModal(null); reload(); }} />
        </Modal>
      )}
    </>
  );
}

// Removing someone from the household: shows what that does to billing before it happens.
function Unlink({ guarantor, member, onDone }) {
  const { data: impact } = useApi(`/patients/${guarantor.id}/family/${member.id}/unlink`);
  const { submit, busy, error } = useSubmit(async () => {
    await api.del(`/patients/${guarantor.id}/family/${member.id}?confirm=1`);
    onDone();
  });
  if (!impact) return <div className="empty">Checking…</div>;
  return (
    <div>
      <ErrorBox error={error} />
      <p>{member.first_name} will be their own account: new charges bill to them, not {guarantor.first_name}.</p>
      <ul>
        <li>{impact.balance > 0 ? <>Their balance of <strong>{money(impact.balance)}</strong> stays on their own ledger and leaves the family balance.</> : 'They have no balance.'}</li>
        {impact.plans.length > 0 && impact.balance > 0 && <li>{guarantor.first_name}&apos;s payment plan{impact.plans.length > 1 ? 's' : ''} ({impact.plans.map((p) => money(p.remaining)).join(', ')} left) {impact.plans.length > 1 ? 'stay' : 'stays'} with {guarantor.first_name}. Adjust or transfer the balance first if the plan was meant to cover {member.first_name}&apos;s treatment.</li>}
        {impact.card_charges.map((c) => <li key={`${c.kind}${c.id}`}>{c.name}: stops charging {guarantor.first_name}&apos;s card and bills {member.first_name}&apos;s account instead (add their own card to keep autopay).</li>)}
      </ul>
      <div className="form-actions"><button className="danger" disabled={busy} onClick={submit}>Remove from family</button></div>
    </div>
  );
}

function SecondResponsible({ guarantor, onDone }) {
  const [p, setP] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    await api.put(`/patients/${guarantor.id}/family-responsible`, { patient_id: p.id });
    onDone();
  });
  return (
    <div>
      <ErrorBox error={error} />
      <p className="muted">Someone else who shares responsibility for this household's bills (e.g. the other parent). They're shown on the family file and on statements.</p>
      <PatientPicker value={p} onChange={setP} />
      <div className="form-actions"><button className="primary" disabled={!p || busy} onClick={submit}>Save</button></div>
    </div>
  );
}

// "Kit 6/6/2016" (or "Kit Parent 2016-06-06"): the first name — and a last name when it isn't the guarantor's —
// and the birth date, in one box. Pure, so it's easy to check.
export function parseFamilyLine(text, lastName) {
  let rest = ` ${String(text || '')} `;
  let dob = '';
  const iso = /\s(\d{4})-(\d{1,2})-(\d{1,2})\s/.exec(rest);
  const us = /\s(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\s/.exec(rest);
  const m = iso ? [iso[0], iso[1], iso[2], iso[3]] : us ? [us[0], us[3].length === 2 ? `20${us[3]}` : us[3], us[1], us[2]] : null;
  if (m) {
    const [, y, mo, d] = m.map(String);
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (dt.getUTCMonth() === Number(mo) - 1 && dt.getUTCDate() === Number(d)) dob = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    rest = rest.replace(m[0], ' ');
  }
  const words = rest.trim().split(/\s+/).filter(Boolean).map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w));
  if (!words.length) return null;
  return { first_name: words[0], last_name: words.slice(1).join(' ') || lastName, dob };
}

function FamilyAddLine({ guarantor, onDone, onMore }) {
  const [text, setText] = useState('');
  const parsed = parseFamilyLine(text, guarantor.last_name);
  const years = parsed?.dob ? age(parsed.dob) : null;
  // Under 26 on the guarantor's family: a child to start with; an adult: their spouse. Changeable before Enter.
  const [rel, setRel] = useState('');
  const relationship = rel || (years != null && years >= 26 ? 'spouse' : 'child');
  const { submit, busy, error } = useSubmit(async () => {
    if (!parsed) throw new Error('Type their first name and birth date, e.g. Kit 6/6/2016');
    const made = await api.post(`/patients/${guarantor.id}/family`, { ...parsed, dob: parsed.dob || null, relationship });
    toast(`${parsed.first_name} ${parsed.last_name} added to the family`);
    setText('');
    setRel('');
    onDone(made);
  });
  return (
    <form className="quick-add family-add" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Add a family member">
      <label className="grow">Add to the family — name and birth date
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Kit 6/6/2016 (last name ${guarantor.last_name} unless you type one)`} />
      </label>
      <label>Relationship<select value={relationship} onChange={(e) => setRel(e.target.value)}>{['spouse', 'child', 'dependent', 'parent', 'other'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></label>
      <button className="primary" disabled={busy || !parsed}>Add</button>
      <button type="button" className="link" onClick={onMore}>More fields…</button>
      {parsed && <span className="muted quick-add-error">{parsed.first_name} {parsed.last_name}{parsed.dob ? ` · born ${fmtDate(parsed.dob)} (${years} y)` : ' · no birth date yet'} · address, phone and email from {guarantor.first_name}</span>}
      {error && <div className="quick-add-error"><ErrorBox error={error} /></div>}
    </form>
  );
}

function NewMember({ guarantor, onDone, onCancel }) {
  const [form, setForm] = useState({ first_name: '', last_name: guarantor.last_name, dob: '', gender: '', relationship: 'child' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${guarantor.id}/family`, form);
    onDone();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <label>First name<input required autoFocus value={form.first_name} onChange={set('first_name')} /></label>
        <label>Last name<input value={form.last_name} onChange={set('last_name')} /></label>
        <label>Date of birth<input type="date" value={form.dob} onChange={set('dob')} /></label>
        <label>Gender<select value={form.gender} onChange={set('gender')}><option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></label>
        <label>Relationship to {guarantor.first_name}<select value={form.relationship} onChange={set('relationship')}>{['spouse', 'child', 'dependent', 'parent', 'other'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Address, phone and email are copied from the guarantor.</p>
      <div className="form-actions">{onCancel && <button type="button" onClick={onCancel}>Cancel</button>}<button className="primary" disabled={busy}>Add to family</button></div>
    </form>
  );
}

function LinkMember({ guarantor, onDone }) {
  const [p, setP] = useState(null);
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/patients/${guarantor.id}/family`, { patient_id: p.id });
    onDone();
  });
  return (
    <div>
      <ErrorBox error={error} />
      <PatientPicker value={p} onChange={setP} />
      <div className="form-actions"><button className="primary" disabled={!p || busy} onClick={submit}>Link to {guarantor.first_name}&apos;s family</button></div>
    </div>
  );
}

// Several family members in one trip: back to back in one chair, or side by side at the same time.
function FamilyBooking({ members, onDone }) {
  const providers = useLookup('/providers?active=true');
  const operatories = useLookup('/operatories?active=true');
  const types = useLookup('/appointment-types?active=true');
  const [form, setForm] = useState({ date: new Date().toLocaleDateString('en-CA'), time: '15:00', mode: 'back_to_back', provider_id: '', operatory_id: '' });
  const [rows, setRows] = useState(() => members.map((m) => ({ patient_id: m.id, name: `${m.first_name} ${m.last_name}`, on: true, appointment_type_id: '', duration: 60, provider_id: '', operatory_id: '' })));
  const [override, setOverride] = useState(false);
  const setRow = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.on);
  const side = form.mode === 'side_by_side';
  const { submit, busy, error } = useSubmit(async () => {
    const appts = await api.post('/appointments/family', {
      mode: form.mode, start_time: `${form.date} ${form.time}`, provider_id: form.provider_id ? Number(form.provider_id) : undefined,
      operatory_id: form.operatory_id ? Number(form.operatory_id) : undefined, override_blockout: override,
      members: chosen.map((r) => ({
        patient_id: r.patient_id, appointment_type_id: r.appointment_type_id ? Number(r.appointment_type_id) : undefined, duration: Number(r.duration),
        ...(side ? { provider_id: r.provider_id ? Number(r.provider_id) : undefined, operatory_id: r.operatory_id ? Number(r.operatory_id) : undefined } : {}),
      })),
    }).catch((e) => {
      if (e.details?.can_override) setOverride(true);
      throw e;
    });
    onDone(appts);
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBox error={error} />
      {override && <div className="public-notice" style={{ marginBottom: 8 }}>Submit again to book anyway.</div>}
      <div className="form-grid">
        <label>Date<input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
        <label>First start time<input type="time" required step={300} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
        <label>
          Arrangement
          <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            <option value="back_to_back">Back to back (one after another)</option>
            <option value="side_by_side">Side by side (same time, different chairs)</option>
          </select>
        </label>
        {!side && (
          <>
            <label>Provider<select required value={form.provider_id} onChange={(e) => setForm({ ...form, provider_id: e.target.value })}><option value="">Select…</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Chair<select value={form.operatory_id} onChange={(e) => setForm({ ...form, operatory_id: e.target.value })}><option value="">—</option>{operatories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          </>
        )}
      </div>
      <table className="compact-table" style={{ marginTop: 12 }}>
        <thead><tr><th /><th>Who</th><th>Visit</th><th>Minutes</th>{side && <><th>Provider</th><th>Chair</th></>}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.patient_id} style={{ opacity: r.on ? 1 : 0.5 }}>
              <td><input type="checkbox" checked={r.on} onChange={(e) => setRow(i, { on: e.target.checked })} /></td>
              <td>{r.name}</td>
              <td>
                <select value={r.appointment_type_id} onChange={(e) => { const t = types.find((x) => String(x.id) === e.target.value); setRow(i, { appointment_type_id: e.target.value, ...(t ? { duration: t.duration } : {}) }); }}>
                  <option value="">—</option>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
              <td><input type="number" min="5" step="5" value={r.duration} onChange={(e) => setRow(i, { duration: e.target.value })} style={{ width: 70 }} /></td>
              {side && (
                <>
                  <td><select required={r.on} value={r.provider_id} onChange={(e) => setRow(i, { provider_id: e.target.value })}><option value="">Select…</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
                  <td><select value={r.operatory_id} onChange={(e) => setRow(i, { operatory_id: e.target.value })}><option value="">—</option>{operatories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-actions"><button className="primary" disabled={busy || chosen.length < 2}>Book {chosen.length} visits</button></div>
    </form>
  );
}
