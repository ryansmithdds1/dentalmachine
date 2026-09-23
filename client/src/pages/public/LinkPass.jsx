import { useState } from 'react';
import { ErrorBox, useSubmit } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';
import { useT } from './i18n.js';

// Plan and form links don't open on their own: the patient confirms their birth date and gets a short-lived
// pass (a portal link already carries one in its #fragment). The pass is kept for this tab only.
const passKey = (kind, token) => `dm_${kind}_pass_${token.slice(0, 12)}`;
export function readPass(kind, token) {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get('pass');
  try {
    if (fromLink) {
      sessionStorage.setItem(passKey(kind, token), fromLink);
      window.history.replaceState(null, '', window.location.pathname);
    }
    return sessionStorage.getItem(passKey(kind, token)) || '';
  } catch {
    return fromLink || '';
  }
}
export function savePass(kind, token, pass) {
  try {
    sessionStorage.setItem(passKey(kind, token), pass);
  } catch {
    /* storage unavailable */
  }
}

// fetch for /api/public with the pass header (X-Plan-Pass or X-Form-Pass).
export async function publicCall(method, path, body, header, pass) {
  const res = await fetch(`/api/public${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(pass ? { [header]: pass } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, details: data.details });
  return data;
}

// The birth-date step. `verify(dob)` returns the new pass.
export function DobGate({ title, practice, verify, onPass }) {
  const t = useT();
  const [dob, setDob] = useState('');
  const { submit, busy, error } = useSubmit(async () => onPass(await verify(dob)));
  return (
    <PublicLayout title={title} practice={practice}>
      <form className="card" onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
        <p>{t('To keep your information private, please confirm your date of birth.')}</p>
        <label>{t('Date of birth')}<input required type="date" value={dob} onChange={(ev) => setDob(ev.target.value)} /></label>
        <ErrorBox error={error} />
        <button className="primary big" style={{ marginTop: 12 }} disabled={busy || !dob}>{t('Continue')}</button>
      </form>
    </PublicLayout>
  );
}
