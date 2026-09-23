import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';

const AuthContext = createContext(null);

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

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
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
