import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { ErrorBox, useSubmit } from '../components/ui.jsx';

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', practice_name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { submit, busy, error } = useSubmit(() => (mode === 'login' ? login(form.email, form.password) : register(form)));

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1>🦷 Dental Machine</h1>
        <div className="muted">{mode === 'login' ? 'Sign in to your practice' : 'Create your practice account'}</div>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <ErrorBox error={error} />
          {mode === 'register' && (
            <>
              <label>Practice name<input required value={form.practice_name} onChange={set('practice_name')} /></label>
              <label>Your name<input required value={form.name} onChange={set('name')} /></label>
            </>
          )}
          <label>Email<input type="email" required autoComplete="username" value={form.email} onChange={set('email')} /></label>
          <label>
            Password
            <input type="password" required minLength={mode === 'register' ? 10 : undefined} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} />
          </label>
          <button className="primary" disabled={busy} style={{ justifyContent: 'center' }}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create practice'}
          </button>
        </form>
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          {mode === 'login' ? (
            <button className="link" onClick={() => setMode('register')}>New practice? Create an account</button>
          ) : (
            <button className="link" onClick={() => setMode('login')}>Already have an account? Sign in</button>
          )}
        </div>
      </div>
    </div>
  );
}
