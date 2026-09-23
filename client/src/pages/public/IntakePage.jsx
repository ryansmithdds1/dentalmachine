import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import SignaturePad from '../../components/SignaturePad.jsx';
import FormFields, { formComplete } from '../../components/FormFields.jsx';
import PublicLayout from './PublicLayout.jsx';
import { suggestLang, useT } from './i18n.js';

export default function IntakePage() {
  const t = useT();
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [finished, setFinished] = useState([]);

  useEffect(() => {
    api.get(`/public/forms/${token}`).then((i) => { suggestLang(i.language); setInfo(i); }).catch(setLoadError);
  }, [token]);

  if (loadError) return <PublicLayout title={t('Patient forms')}><ErrorBox error={loadError} /></PublicLayout>;
  if (!info) return <PublicLayout title={t('Patient forms')}><p>{t('Loading…')}</p></PublicLayout>;
  const practice = { name: info.practice_name };
  const forms = info.forms || [{ id: 0, kind: 'medical_history', name: 'Health history', status: 'pending' }];
  const todo = forms.filter((f) => f.status === 'pending' && !finished.includes(f.id));
  const current = todo[0];
  const done = (id) => { setFinished((x) => [...x, id]); window.scrollTo(0, 0); };
  if (!current) {
    return (
      <PublicLayout title={t('All done!')} practice={practice}>
        <div className="public-notice ok">{t(forms.length > 1 ? 'Thank you, {name}. Your forms have been securely sent to {practice}.' : forms[0].kind === 'medical_history' ? 'Thank you, {name}. Your health history has been securely sent to {practice}.' : 'Thank you, {name}. Your form has been securely sent to {practice}.', { name: info.first_name, practice: info.practice_name })}</div>
      </PublicLayout>
    );
  }
  const step = forms.length > 1 ? <div className="muted" style={{ marginBottom: 8 }}>{t('Form {n} of {total}', { n: forms.indexOf(current) + 1, total: forms.length })}{forms.length > 1 ? ` · ${forms.map((f) => (f.kind === 'medical_history' ? t('Health history') : f.name)).join(' · ')}` : ''}</div> : null;
  return current.kind === 'medical_history'
    ? <HistoryForm key={current.id} info={info} token={token} practice={practice} step={step} onDone={() => done(current.id)} />
    : <PracticeForm key={current.id} form={current} info={info} token={token} practice={practice} step={step} onDone={() => done(current.id)} />;
}

function PracticeForm({ form, info, token, practice, step, onDone }) {
  const t = useT();
  const [answers, setAnswers] = useState({});
  const [signatureName, setSignatureName] = useState('');
  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/public/forms/${token}/${form.id}`, { answers, signature_name: signatureName });
    onDone();
  });
  return (
    <PublicLayout title={form.name} practice={practice}>
      {step}
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="card">
          <FormFields fields={form.fields} answers={answers} onChange={setAnswers} signatureName={signatureName} onSignatureName={setSignatureName} />
        </div>
        <ErrorBox error={error} />
        <button className="primary big" disabled={busy || !formComplete(form.fields, answers, signatureName)}>{busy ? t('Sending…') : t('Sign and submit')}</button>
      </form>
    </PublicLayout>
  );
}

function HistoryForm({ info, token, practice, step, onDone }) {
  const t = useT();
  const [a, setA] = useState(() => ({ conditions: [], consent_hipaa: false, consent_treatment: false, ...Object.fromEntries(Object.entries(info.prefill).map(([k, v]) => [k, v || ''])) }));
  const [signatureName, setSignatureName] = useState('');
  const [signatureImage, setSignatureImage] = useState(null);

  const { submit, busy, error } = useSubmit(async () => {
    await api.post(`/public/forms/${token}`, { answers: a, signature_name: signatureName, signature_image: signatureImage });
    onDone();
  });

  const text = (k, label, props = {}) => (
    <label className={props.full ? 'full' : ''}>
      {t(label)}
      <input value={a[k] || ''} onChange={(e) => setA({ ...a, [k]: e.target.value })} type={props.type || 'text'} />
    </label>
  );
  const area = (k, label, placeholder) => (
    <label className="full">
      {t(label)}
      <textarea rows={2} placeholder={placeholder && t(placeholder)} value={a[k] || ''} onChange={(e) => setA({ ...a, [k]: e.target.value })} />
    </label>
  );
  const check = (k, label) => (
    <label className="checkbox" style={{ color: 'var(--text)', fontSize: 14 }}>
      <input type="checkbox" checked={!!a[k]} onChange={(e) => setA({ ...a, [k]: e.target.checked })} /> {t(label)}
    </label>
  );
  const toggleCondition = (c) => setA({ ...a, conditions: a.conditions.includes(c) ? a.conditions.filter((x) => x !== c) : [...a.conditions, c] });

  return (
    <PublicLayout title={t('Health history')} practice={practice}>
      {step}
      <p>{t('Hi {name}, please complete this before your visit. It takes about 5 minutes. Your answers go directly into your secure dental record.', { name: info.first_name })}</p>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="card">
          <h2>{t('Contact details')}</h2>
          <div className="form-grid">
            {text('phone', 'Mobile phone', { type: 'tel' })}
            {text('email', 'Email', { type: 'email' })}
            {text('address', 'Street address', { full: true })}
            {text('city', 'City')}
            {text('state', 'State')}
            {text('zip', 'ZIP')}
            {text('emergency_contact', 'Emergency contact (name & phone)', { full: true })}
          </div>
        </div>

        <div className="card">
          <h2>{t('Medical history')}</h2>
          <p className="muted">{t('Do you have, or have you ever had, any of the following?')}</p>
          <div className="condition-grid">
            {info.conditions.map((c) => (
              <label key={c} className="checkbox" style={{ color: 'var(--text)', fontSize: 14 }}>
                <input type="checkbox" checked={a.conditions.includes(c)} onChange={() => toggleCondition(c)} /> {t(c)}
              </label>
            ))}
          </div>
          <div className="form-grid" style={{ marginTop: 14 }}>
            {area('other_conditions', 'Other conditions or surgeries', 'e.g. hip replacement 2021')}
            {area('allergies', 'Allergies (medications, latex, foods)', 'None')}
            {area('medications', 'Current medications & supplements', 'Name and dose')}
            {text('physician_name', 'Physician name')}
            {text('physician_phone', 'Physician phone', { type: 'tel' })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {check('premedication', 'I have been told to take antibiotics before dental visits')}
            {check('pregnant', 'I am pregnant or may be pregnant')}
            {check('tobacco', 'I use tobacco or vape')}
          </div>
        </div>

        <div className="card">
          <h2>{t('Dental history')}</h2>
          <div className="form-grid">
            {text('last_dental_visit', 'When was your last dental visit?')}
            {area('chief_concern', 'What would you like us to look at?', 'e.g. sensitivity on the lower left')}
          </div>
        </div>

        <div className="card">
          <h2>{t('Consent & signature')}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {check('consent_hipaa', t('I acknowledge I have been offered {practice}’s Notice of Privacy Practices.', { practice: info.practice_name }))}
            {check('consent_treatment', 'The information above is accurate to the best of my knowledge, and I consent to examination and necessary diagnostic x-rays.')}
          </div>
          <label style={{ marginTop: 14 }}>{t('Type your full legal name')}<input required value={signatureName} onChange={(e) => setSignatureName(e.target.value)} autoComplete="name" /></label>
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{t('Sign below')}</div>
            <SignaturePad onChange={setSignatureImage} />
          </div>
        </div>

        <ErrorBox error={error} />
        <button className="primary big" disabled={busy || !a.consent_hipaa || !a.consent_treatment || !signatureName.trim()}>{t('Submit securely')}</button>
      </form>
    </PublicLayout>
  );
}
