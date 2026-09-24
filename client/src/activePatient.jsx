import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// The patient being worked on stays with the user across screens (schedule, billing, messages…) until they
// switch or clear it, so nobody searches for the same person twice. Kept for this browser tab only, along
// with a short list of recent patients for the command bar.
const Ctx = createContext({ patientId: null, recent: [], setActive: () => {}, clear: () => {} });
const read = (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export function ActivePatientProvider({ children }) {
  const [patientId, setId] = useState(() => read('dm_active_patient', null));
  const [recent, setRecent] = useState(() => read('dm_recent_patients', []));
  const setActive = useCallback((p) => {
    if (!p?.id) return;
    setId(p.id);
    write('dm_active_patient', p.id);
    if (p.first_name) {
      setRecent((r) => {
        const next = [{ id: p.id, first_name: p.first_name, last_name: p.last_name, preferred_name: p.preferred_name || null, dob: p.dob || null }, ...r.filter((x) => x.id !== p.id)].slice(0, 8);
        write('dm_recent_patients', next);
        return next;
      });
    }
  }, []);
  const clear = useCallback(() => { setId(null); write('dm_active_patient', null); }, []);
  const value = useMemo(() => ({ patientId, recent, setActive, clear }), [patientId, recent, setActive, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useActivePatient = () => useContext(Ctx);

// Screens that show a patient make them the active one.
export function useMakeActive(patient) {
  const { setActive } = useActivePatient();
  useEffect(() => { if (patient?.id) setActive(patient); }, [patient?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}
export const clearPatientSession = () => { write('dm_active_patient', null); write('dm_recent_patients', []); };
