import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

// Loads a GET endpoint; returns { data, error, loading, reload }.
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path });
  const load = useCallback(async () => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api.get(path);
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState({ data: null, error, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  // Something changed the data behind the screen's back (the assistant): show the new state.
  useEffect(() => {
    window.addEventListener('dm:refresh', load);
    return () => window.removeEventListener('dm:refresh', load);
  }, [load]);
  return { ...state, reload: load };
}

// Shared lookup lists (providers, operatories, codes, carriers) cached per session.
const cache = new Map();
export function useLookup(path) {
  const [data, setData] = useState(cache.get(path) || []);
  useEffect(() => {
    if (!path) return undefined;
    let alive = true;
    api.get(path).then((d) => {
      cache.set(path, d);
      if (alive) setData(d);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  return data;
}
export const invalidateLookup = (path) => cache.delete(path);
