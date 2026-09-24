import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { fmtUtcDate } from '../../format.js';
import { ErrorBox, Modal, useSubmit } from '../ui.jsx';
import { useShortcuts } from '../../shortcuts.js';

const EMPTY = { provider_id: '', drug: '', strength: '', sig: '', quantity: '', refills: 0, dispense_as_written: false, notes: '', schedule: '' };
const RX_STATUS = { printed: ['Printed', ''], signed: ['Signed', 'info'], transmitted: ['Sent to pharmacy', 'ok'], error: ['Not sent', 'danger'] };

// Prescriptions: favorites, allergy check, pharmacy, e-prescribing (with EPCS signing) or printed Rx.
export default function RxTab({ patient, onChange }) {
  const { can, practice, user } = useAuth();
  const { data: list, reload } = useApi(`/patients/${patient.id}/prescriptions`);
  const { data: erx } = useApi('/erx');
  const favorites = useLookup('/rx/favorites');
  const providers = useLookup('/providers?active=true').filter((p) => p.type !== 'hygienist');
  const [form, setForm] = useState(EMPTY);
  // Workflow 34 (docs/workflows/specs/34-prescriptions.md): the prescriber is the dentist signed in, else the
  // patient's own dentist, else the first one — never just "the first provider".
  const mine = providers.find((p) => p.user_id === user?.id) || providers.find((p) => p.id === patient.primary_provider_id) || providers[0];
  const prescriber = form.provider_id || mine?.id || '';
  const sendRef = useRef(null);
  const printRef = useRef(null);
  const [picked, setPicked] = useState(0);
  // A favorite picked (click or its number key) puts the focus on sending it, so Enter finishes.
  useEffect(() => {
    if (!picked) return;
    (sendRef.current && !sendRef.current.disabled ? sendRef.current : printRef.current)?.focus();
  }, [picked]);
  const pickFavorite = (f) => { setForm({ ...form, ...f, refills: f.refills ?? 0, schedule: f.schedule || '' }); setPicked((n) => n + 1); };
  useShortcuts(can('clinical:sign') ? favorites.slice(0, 9).map((f, i) => ({ combo: String(i + 1), handler: () => pickFavorite(f), label: `Prescribe ${f.drug}`, section: 'Rx' })) : []);
  const [warning, setWarning] = useState(null);
  const [otp, setOtp] = useState(null); // null = not asked; '' = asking
  const [choosePharmacy, setChoosePharmacy] = useState(false);
  const [notice, setNotice] = useState(null);
  const pharmacy = patient.preferred_pharmacy ? JSON.parse(patient.preferred_pharmacy) : null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const { submit, busy, error } = useSubmit(async ({ send = false, override = false } = {}) => {
    setWarning(null);
    setNotice(null);
    try {
      const rx = await api.post(`/patients/${patient.id}/prescriptions`, {
        ...form, schedule: form.schedule || null, provider_id: Number(prescriber), override_allergy: override, send, ...(otp ? { otp } : {}),
      });
      setForm({ ...EMPTY, provider_id: form.provider_id });
      setPicked(0);
      setOtp(null);
      reload();
      if (send) setNotice(rx.status === 'transmitted' ? `${rx.drug} sent to ${rx.pharmacy?.name}.` : `Not sent: ${rx.erx_error}`);
      else window.open(`/prescriptions/${rx.id}/print`, '_blank');
    } catch (e) {
      if (e.details?.allergy_warning) setWarning(e.message);
      else if (e.details?.otp_required) {
        setOtp('');
        if (otp) throw e;
      } else throw e;
    }
  });
  const launch = useSubmit(async () => {
    const { url } = await api.get(`/erx/launch?patient_id=${patient.id}`);
    window.open(url, '_blank', 'noopener');
  });
  const controlled = !!form.schedule;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
      <div>
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Pharmacy</h2>
            {can('patients:write') && <button className="small" onClick={() => setChoosePharmacy(true)}>{pharmacy ? 'Change' : 'Choose pharmacy'}</button>}
          </div>
          {pharmacy ? (
            <div className="pharmacy-card">
              <strong>{pharmacy.name}</strong>
              <div className="muted">{[pharmacy.address, pharmacy.city, pharmacy.state, pharmacy.zip].filter(Boolean).join(', ')}</div>
              <div className="muted">{pharmacy.phone}{pharmacy.fax ? ` · fax ${pharmacy.fax}` : ''}{pharmacy.ncpdp ? ` · NCPDP ${pharmacy.ncpdp}` : ''}</div>
            </div>
          ) : <p className="muted">No preferred pharmacy on file.</p>}
        </div>

        {can('clinical:sign') && (
          <div className="card">
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>New prescription</h2>
              {erx && <span className="muted" style={{ fontSize: 12 }}>{erx.name}</span>}
            </div>
            {erx?.mode === 'dosespot' && (
              <div className="erx-launch">
                <div>Write and send e-prescriptions — including controlled substances — in DoseSpot. {patient.first_name}&apos;s details go across automatically.</div>
                <button className="primary" disabled={launch.busy} onClick={() => launch.submit()}>Open e-prescribing</button>
                <ErrorBox error={launch.error} />
              </div>
            )}
            {patient.allergies && <div className="alert-chip" style={{ margin: '10px 0' }}>Allergies: {patient.allergies}</div>}
            <div className="chips" style={{ margin: '10px 0 12px' }}>
              {favorites.map((f, i) => (
                <button key={f.drug} type="button" className="chip" onClick={() => pickFavorite(f)} title={i < 9 ? `Press ${i + 1}` : undefined}>
                  {i < 9 && <kbd style={{ marginRight: 4 }}>{i + 1}</kbd>}{f.drug}{f.schedule ? <span className="csched">C-{f.schedule}</span> : null}
                </button>
              ))}
            </div>
            <ErrorBox error={error} />
            {warning && (
              <div className="error">
                ⚠ {warning}
                <div style={{ marginTop: 6 }}><button className="small danger" onClick={() => submit({ override: true })}>Prescribe anyway (documented override)</button></div>
              </div>
            )}
            {notice && <div className="public-notice ok" style={{ marginBottom: 10 }}>{notice}</div>}
            <form onSubmit={(e) => { e.preventDefault(); submit({ send: false }); }} className="form-grid">
              <label>Prescriber<select value={prescriber} onChange={set('provider_id')}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label>Drug<input required value={form.drug} onChange={set('drug')} /></label>
              <label>Strength / form<input value={form.strength} onChange={set('strength')} /></label>
              <label>Quantity<input required value={form.quantity} onChange={set('quantity')} placeholder="write it out, e.g. 12 (twelve)" /></label>
              <label className="full">Sig (directions)<input required value={form.sig} onChange={set('sig')} /></label>
              <label>Refills<input type="number" min="0" max={form.schedule === 'II' ? 0 : 11} value={form.refills} onChange={set('refills')} /></label>
              <label>
                Controlled substance
                <select value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value, ...(e.target.value === 'II' ? { refills: 0 } : {}) })}>
                  <option value="">No</option>
                  {['II', 'III', 'IV', 'V'].map((s) => <option key={s} value={s}>Schedule {s}</option>)}
                </select>
              </label>
              <label className="checkbox"><input type="checkbox" checked={form.dispense_as_written} onChange={set('dispense_as_written')} /> Dispense as written</label>
              <label className="full">Notes to pharmacist<input value={form.notes} onChange={set('notes')} /></label>
              {otp !== null && (
                <div className="full epcs-sign">
                  <strong>Two-factor signature required</strong>
                  <span className="muted">DEA rules require your authenticator code to sign a controlled-substance prescription.</span>
                  <input autoFocus inputMode="numeric" maxLength={6} placeholder="6-digit code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
                </div>
              )}
              <div className="form-actions full">
                <button ref={printRef} type="submit" disabled={busy}>Save & print</button>
                {erx?.in_app && (
                  <button ref={sendRef} type="button" className="primary" disabled={busy || !pharmacy || (otp !== null && otp.length !== 6)} title={pharmacy ? '' : 'Choose a pharmacy first'}
                    onClick={() => submit({ send: true })}>
                    {otp !== null ? 'Sign & send' : `Send to ${pharmacy ? pharmacy.name : 'pharmacy'}`}
                  </button>
                )}
              </div>
            </form>
            <p className="muted" style={{ fontSize: 12 }}>
              {erx?.in_app ? 'Controlled substances are signed with your own login and a fresh two-factor code, as DEA rules require.'
                : erx?.mode === 'dosespot' ? 'Printed prescriptions can still be made here.'
                  : 'Printed prescriptions only. Connect an e-prescribing service (see the README) to send prescriptions electronically, including controlled substances.'}
              {controlled && !erx?.in_app ? ' Many states require controlled substances to be e-prescribed.' : ''}
            </p>
          </div>
        )}
      </div>
      <div className="card">
        <h2>History</h2>
        {list?.length === 0 && <div className="muted">No prescriptions.</div>}
        {list?.map((rx) => {
          const [text, tone] = RX_STATUS[rx.status] || [rx.status, ''];
          return (
            <div key={rx.id} className="rx-row">
              <div>
                <strong>{rx.drug}</strong> {rx.strength} {rx.schedule && <span className="csched">C-{rx.schedule}</span>}
                <div className="muted" style={{ fontSize: 12 }}>{rx.sig} · #{rx.quantity} · {rx.refills} refills</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {fmtUtcDate(rx.created_at, practice?.timezone)} · {rx.provider_name}
                  {rx.pharmacy ? ` · ${rx.pharmacy.name}` : ''}{rx.signed_two_factor ? ' · signed with 2FA' : ''}
                </div>
                {rx.erx_error && <div className="text-danger" style={{ fontSize: 12 }}>{rx.erx_error}</div>}
              </div>
              <div className="rx-actions">
                <span className={`badge nocap ${tone}`}>{text}</span>
                <button className="small" onClick={() => window.open(`/prescriptions/${rx.id}/print`, '_blank')}>{rx.status === 'printed' ? 'Reprint' : 'Print copy'}</button>
              </div>
            </div>
          );
        })}
      </div>
      {choosePharmacy && <PharmacyPicker patient={patient} erx={erx} current={pharmacy} onClose={() => setChoosePharmacy(false)} onSaved={() => { setChoosePharmacy(false); onChange?.(); }} />}
    </div>
  );
}

function PharmacyPicker({ patient, erx, current, onClose, onSaved }) {
  const [q, setQ] = useState('');
  const { data: results } = useApi(erx?.pharmacy_search ? `/pharmacies?q=${encodeURIComponent(q)}` : null, [q]);
  const [manual, setManual] = useState(current && !erx?.pharmacy_search ? current : { name: '', address: '', city: '', state: '', zip: '', phone: '', fax: '', ncpdp: '' });
  const save = useSubmit(async (pharmacy) => {
    await api.put(`/patients/${patient.id}/pharmacy`, { pharmacy });
    onSaved();
  });
  const f = (k, label, cls) => <label className={cls}>{label}<input value={manual[k] || ''} onChange={(e) => setManual({ ...manual, [k]: e.target.value })} /></label>;
  return (
    <Modal title="Preferred pharmacy" onClose={onClose}>
      <ErrorBox error={save.error} />
      {erx?.pharmacy_search && (
        <>
          <input autoFocus placeholder="Search by name, city or ZIP" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="pharmacy-results">
            {results?.map((p) => (
              <button key={p.ncpdp} className="list-item" onClick={() => save.submit(p)}>
                <strong>{p.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>{p.address}, {p.city}, {p.state} {p.zip} · {p.phone}</div>
              </button>
            ))}
            {results?.length === 0 && <div className="muted">No pharmacies match.</div>}
          </div>
          <div className="muted" style={{ margin: '14px 0 6px', fontSize: 12 }}>Or enter it by hand:</div>
        </>
      )}
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save.submit(manual); }}>
        {f('name', 'Pharmacy name', 'full')}{f('address', 'Address', 'full')}{f('city', 'City')}{f('state', 'State')}{f('zip', 'ZIP')}{f('phone', 'Phone')}{f('fax', 'Fax')}{f('ncpdp', 'NCPDP ID (for e-prescribing)')}
        <div className="form-actions full">
          {current && <button type="button" className="link" style={{ marginRight: 'auto' }} onClick={() => save.submit(null)}>Remove</button>}
          <button className="primary" disabled={!manual.name || save.busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
