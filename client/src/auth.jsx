import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import { clearOfflineDay } from './offline.js';

const AuthContext = createContext(null);

// Returning from single sign-on: the server redirects to /#sso=<token> (or #sso_error=…, or
// #sso_mfa=<ticket> when the authenticator code is still needed).
let ssoError = null;
let ssoTicket = null;
if (typeof window !== 'undefined' && /^#(sso|sso_error|sso_mfa)=/.test(window.location.hash)) {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.get('sso')) setToken(params.get('sso'));
  ssoError = params.get('sso_error');
  ssoTicket = params.get('sso_mfa');
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
// Invitations to create a practice arrive as /#invite=<token>.
let inviteToken = null;
if (typeof window !== 'undefined' && /^#invite=/.test(window.location.hash)) {
  inviteToken = new URLSearchParams(window.location.hash.slice(1)).get('invite');
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
export const takeInviteToken = () => {
  const t = inviteToken;
  inviteToken = null;
  return t;
};
// Password reset links arrive as /#reset=<token>.
let resetToken = null;
if (typeof window !== 'undefined' && /^#reset=/.test(window.location.hash)) {
  resetToken = new URLSearchParams(window.location.hash.slice(1)).get('reset');
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
export const takeResetToken = () => {
  const t = resetToken;
  resetToken = null;
  return t;
};
export const takeSsoTicket = () => {
  const t = ssoTicket;
  ssoTicket = null;
  return t;
};
export const takeSsoError = () => {
  const e = ssoError;
  ssoError = null;
  return e;
};

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: !!getToken(), user: null, practice: null });

  const refresh = useCallback(async () => {
    if (!getToken()) return setState({ loading: false, user: null, practice: null });
    try {
      const me = await api.get('/auth/me');
      setState({ loading: false, user: me.user, practice: me.practice });
    } catch (err) {
      // No connection (not a rejected session): keep the session and show the offline schedule.
      if (!err.status || [502, 503, 504].includes(err.status)) return setState({ loading: false, user: null, practice: null, offline: true });
      setToken(null);
      setState({ loading: false, user: null, practice: null });
    }
  }, []);

  useEffect(() => {
    refresh();
    const onLogout = () => { clearOfflineDay(); setState({ loading: false, user: null, practice: null }); };
    window.addEventListener('dm:logout', onLogout);
    return () => window.removeEventListener('dm:logout', onLogout);
  }, [refresh]);

  const login = async (email, password, mfa_code) => {
    const res = await api.post('/auth/login', { email, password, ...(mfa_code ? { mfa_code } : {}) });
    setToken(res.token);
    await refresh();
  };
  const register = async (body) => {
    const res = await api.post('/auth/register', body);
    setToken(res.token);
    await refresh();
  };
  // Ends the session on the server too, so the token is useless even if it was copied.
  const logout = (reason) => {
    if (getToken()) api.post('/auth/logout', reason === 'idle' ? { reason } : {}).catch(() => {});
    setToken(null);
    clearOfflineDay();
    setState({ loading: false, user: null, practice: null });
  };
  // After a password change or "sign out everywhere", the server hands this device a fresh session.
  const adoptSession = async (token) => {
    if (token) setToken(token);
    await refresh();
  };
  const can = (perm) => !!state.user && (state.user.role === 'admin' || state.user.permissions.includes(perm));

  return <AuthContext.Provider value={{ ...state, login, register, logout, can, refresh, adoptSession }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
