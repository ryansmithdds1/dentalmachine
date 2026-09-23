import { useEffect, useState } from 'react';
import { useAuth, takeSsoError, takeSsoTicket, takeResetToken } from '../auth.jsx';
import { api } from '../api.js';
import { ErrorBox, useSubmit } from '../components/ui.jsx';

export default function Login() {
  const { login, register, adoptSession } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', practice_name: '', mfa_code: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [needsCode, setNeedsCode] = useState(false);
  const [sso, setSso] = useState(null);
  const [ssoError] = useState(takeSsoError);
  const [resetToken] = useState(takeResetToken);
  const [ssoTicket] = useState(takeSsoTicket);
  const [notice, setNotice] = useState(null);
  useEffect(() => { if (resetToken) setMode('reset'); else if (ssoTicket) setMode('sso_mfa'); }, [resetToken, ssoTicket]);
  // Offer single sign-on as soon as we know the email belongs to a practice that uses it.
  useEffect(() => {
    if (mode !== 'login' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) return setSso(null);
    const t = setTimeout(() => api.get(`/auth/sso/lookup?email=${encodeURIComponent(form.email)}`).then((r) => setSso(r.sso ? r : null)).catch(() => setSso(null)), 350);
    return () => clearTimeout(t);
  }, [form.email, mode]);
  const startSso = () => { window.location.href = `/api/auth/sso/start?email=${encodeURIComponent(form.email)}`; };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(async () => {
    if (mode === 'sso_mfa') return adoptSession((await api.post('/auth/sso/mfa', { ticket: ssoTicket, code: form.mfa_code })).token);
    if (mode === 'forgot') {
      await api.post('/auth/forgot-password', { email: form.email });
      setNotice("If that email has an account, we've sent a link to reset the password. It works for an hour.");
      return setMode('login');
    }
    if (mode === 'reset') {
      const res = await api.post('/auth/reset-password', { token: resetToken, password: form.password });
      setNotice(`Password changed — sign in with your new password${res.mfa_enabled ? ' and your authenticator code' : ''}.`);
      setForm({ ...form, password: '' });
      return setMode('login');
    }
    if (mode !== 'login') return register(form);
    try {
      await login(form.email, form.password, form.mfa_code);
    } catch (e) {
      if (e.details?.mfa_required) {
        // First prompt for the code is expected, not an error.
        if (!needsCode) return setNeedsCode(true);
      }
      throw e;
    }
  });

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1>🦷 Dental Machine</h1>
        <div className="muted">{{ login: 'Sign in to your practice', register: 'Create your practice account', forgot: 'Reset your password', reset: 'Choose a new password', sso_mfa: 'Enter the code from your authenticator app' }[mode]}</div>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <ErrorBox error={error || (ssoError ? new Error(ssoError) : null)} />
          {notice && <div className="public-notice ok">{notice}</div>}
          {mode === 'register' && (
            <>
              <label>Practice name<input required value={form.practice_name} onChange={set('practice_name')} /></label>
              <label>Your name<input required value={form.name} onChange={set('name')} /></label>
            </>
          )}
          {mode === 'sso_mfa' ? (
            <label>
              Authentication code
              <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" placeholder="123 456" required value={form.mfa_code} onChange={set('mfa_code')} />
            </label>
          ) : mode === 'reset' ? (
            <label>New password (min 10 characters)<input type="password" required minLength={10} autoComplete="new-password" autoFocus value={form.password} onChange={set('password')} /></label>
          ) : <label>Email or username<input type="text" required autoComplete="username" autoCapitalize="none" value={form.email} onChange={set('email')} /></label>}
          {sso && (
            <button type="button" className="primary sso-button" onClick={startSso}>
              {{ google: 'G', microsoft: '⊞' }[sso.provider] || '🔑'} Sign in with {sso.name}
            </button>
          )}
          {['forgot', 'reset', 'sso_mfa'].includes(mode) ? null : sso?.required ? <p className="muted" style={{ fontSize: 13, margin: 0 }}>Your practice signs in with {sso.name}.</p> : (
            <label>
              Password
              <input type="password" required minLength={mode === 'register' ? 10 : undefined} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} />
            </label>
          )}
          {needsCode && mode === 'login' && (
            <label>
              Authentication code
              <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" placeholder="123 456" required value={form.mfa_code} onChange={set('mfa_code')} />
            </label>
          )}
          {(!sso?.required || mode !== 'login') && (
            <button className={sso && mode === 'login' ? '' : 'primary'} disabled={busy} style={{ justifyContent: 'center' }}>
              {busy ? 'Please wait…' : { login: sso ? 'Sign in with password' : 'Sign in', register: 'Create practice', forgot: 'Email me a reset link', reset: 'Set new password', sso_mfa: 'Sign in' }[mode]}
            </button>
          )}
        </form>
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          {mode === 'login' ? (
            <>
              <button className="link" onClick={() => { setNotice(null); setMode('forgot'); }}>Forgot password?</button>
              <span className="muted"> · </span>
              <button className="link" onClick={() => setMode('register')}>New practice? Create an account</button>
            </>
          ) : (
            <button className="link" onClick={() => setMode('login')}>Already have an account? Sign in</button>
          )}
        </div>
      </div>
    </div>
  );
}
