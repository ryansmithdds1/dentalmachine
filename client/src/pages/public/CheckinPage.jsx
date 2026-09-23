import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { useT } from './i18n.js';

// Scanned from the poster at the door: mobile number and date of birth, and you're checked in.
export default function CheckinPage() {
  const t = useT();
  const { practice } = useParams();
  const [p, setP] = useState(null);
  const [form, setForm] = useState({ phone: '', dob: '' });
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/public/checkin/${practice}`).then(setP).catch(setError); }, [practice]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { setDone((await api.post(`/public/checkin/${practice}`, form)).checked_in); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <PublicLayout practice={p} title={t('Check in')}>
      {done ? (
        <div className="card">
          <h2>{t('You’re checked in')} ✓</h2>
          <p>{done.map((d) => `${d.name} (${d.time})`).join(', ')}</p>
          <p className="muted">{t('Have a seat — or wait in your car, and we’ll text you when we’re ready.')}</p>
        </div>
      ) : (
        <form className="card" onSubmit={submit}>
          <ErrorBox error={error} />
          <label>{t('Mobile number')}<input type="tel" inputMode="tel" autoComplete="tel" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          <label>{t('Patient’s date of birth')}<input type="date" required value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} /></label>
          <p className="muted" style={{ fontSize: 13 }}>{t('Checking in a child? Use your number and their date of birth.')}</p>
          <button className="primary" style={{ width: '100%' }} disabled={busy}>{t('Check in')}</button>
        </form>
      )}
    </PublicLayout>
  );
}
