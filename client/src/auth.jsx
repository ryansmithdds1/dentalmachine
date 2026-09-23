import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';

const AuthContext = createContext(null);

// Returning from single sign-on: the server redirects to /#sso=<token> (or #sso_error=…).
let ssoError = null;
if (typeof window !== 'undefined' && /^#(sso|sso_error)=/.test(window.location.hash)) {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.get('sso')) setToken(params.get('sso'));
  ssoError = params.get('sso_error');
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
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
    } catch {
      setToken(null);
      setState({ loading: false, user: null, practice: null });
    }
  }, []);

  useEffect(() => {
    refresh();
    const onLogout = () => setState({ loading: false, user: null, practice: null });
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
  const logout = () => {
    setToken(null);
    setState({ loading: false, user: null, practice: null });
  };
  const can = (perm) => !!state.user && (state.user.role === 'admin' || state.user.permissions.includes(perm));

  return <AuthContext.Provider value={{ ...state, login, register, logout, can, refresh }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
