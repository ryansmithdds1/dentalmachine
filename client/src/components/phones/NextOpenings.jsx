import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarPlus, Ear } from 'lucide-react';
import { api } from '../../api.js';
import { useLiveEvents } from '../../live.js';
import { useShortcuts, comboLabel } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import { WEEKDAYS, filterSlots, describe, emptyRequest, slotLabel } from './slots.js';
import './phones.css';

const keyOf = (s) => `${s.start}|${s.provider_id}`;
const merge = (a, b) => [...new Map([...a, ...b].map((s) => [keyOf(s), s])).values()].sort((x, y) => x.start.localeCompare(y.start) || x.provider_id - y.provider_id);
const paramsOf = (r) => {
  const q = new URLSearchParams();
  if (r?.weekdays?.length) q.set('weekdays', r.weekdays.join(','));
  if (r?.part) q.set('part', r.part);
  if (r?.provider_ids?.length) q.set('provider_ids', r.provider_ids.join(','));
  if (r?.asap) q.set('asap', '1');
  return q;
};

// "Next openings" on the call screen (PH6): the next open times for what the caller likely needs (recall due,
// planned treatment, an emergency, a new patient exam). As the caller talks, live transcription picks up what they
// ask for ("Thursday afternoon", "with Dr Chen") and the list narrows at once; without it, the chips do the same
// with a tap. One click books (the schedule's own checks), with Undo.
export default function NextOpenings({ callId, patient, primary = false, onBooked }) {
  const [data, setData] = useState(null);
  const [pool, setPool] = useState([]);
  const [req, setReq] = useState(null);
  const [heard, setHeard] = useState(null);
  const [live, setLive] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const patientId = patient?.id || null;

  const fetchOpenings = useCallback(async (r) => {
    const q = paramsOf(r);
    if (patientId) q.set('patient_id', patientId);
    try {
      const d = await api.get(`/phones/calls/${callId}/openings?${q}`);
      setData((prev) => ({ ...d, slots: undefined, providers: prev?.providers?.length > d.providers.length ? prev.providers : d.providers }));
      setPool((p) => merge(p, d.slots));
      setError(null);
      return d;
    } catch (e) {
      setError(e);
      return null;
    }
  }, [callId, patientId]);

  useEffect(() => {
    setPool([]);
    fetchOpenings(null).then((d) => d && !emptyRequest(d.request) && setReq(d.request));
    api.get('/phones/live').then(setLive).catch(() => setLive(null));
  }, [fetchOpenings]);

  // Each change to the request narrows the list at once, then a fetch widens the search to match.
  const apply = (next, how) => {
    setReq(next);
    if (how === 'heard') setHeard(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fetchOpenings(next), 250);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLiveEvents((e) => {
    if (e.type === 'call' && e.call_id === callId && e.event === 'request' && e.request) apply({ ...e.request }, 'heard');
  });

  const providers = data?.all_providers || data?.providers || [];
  const shown = useMemo(() => filterSlots(pool, req).slice(0, 6), [pool, req]);
  const toggleDay = (d) => { const w = new Set(req?.weekdays || []); if (w.has(d)) w.delete(d); else w.add(d); apply({ ...(req || {}), weekdays: [...w].sort() }, 'tap'); };
  const setPart = (p) => apply({ ...(req || {}), part: req?.part === p ? null : p }, 'tap');
  const toggleProvider = (id) => { const s = new Set(req?.provider_ids || []); if (s.has(id)) s.delete(id); else s.add(id); apply({ ...(req || {}), provider_ids: [...s] }, 'tap'); };
  const toggleAsap = () => apply({ ...(req || {}), asap: !req?.asap }, 'tap');
  const clear = () => { setHeard(null); apply(null, 'tap'); };

  const book = async (s) => {
    if (!patientId || busy) return;
    setBusy(keyOf(s));
    try {
      const out = await api.post(`/phones/calls/${callId}/book`, {
        patient_id: patientId, provider_id: s.provider_id, start_time: s.start, duration: data?.need?.duration || 60, reason: data?.need?.label || null,
        appointment_type_id: data?.need?.appointment_type_id || null,
      });
      setPool((p) => p.filter((x) => keyOf(x) !== keyOf(s)));
      const appt = out.appointment;
      toast(`Booked ${slotLabel(s)} with ${s.provider}`, {
        undo: async () => {
          try {
            await api.patch(`/appointments/${appt.id}/status`, { status: 'cancelled', broken_reason: 'office', broken_note: 'Booked by mistake on the call' });
            toast('Booking undone');
            fetchOpenings(req);
          } catch (e) { toast(`Couldn’t undo: ${e.message}`, { tone: 'error' }); }
        },
      });
      onBooked?.(appt);
    } catch (e) {
      toast(e.message || 'That time couldn’t be booked', { tone: 'error' });
      fetchOpenings(req);
    } finally {
      setBusy(null);
    }
  };

  useShortcuts([
    { combo: 'alt+b', handler: () => shown[0] && book(shown[0]), label: 'Book the first opening for the caller', section: 'Incoming call', enabled: primary && !!patientId && !!shown.length },
  ]);

  if (!data && !error) return <div className="next-openings muted">Finding open times…</div>;
  const heardText = describe(heard, providers);
  const days = [1, 2, 3, 4, 5, 6];
  return (
    <div className="next-openings" data-call={callId}>
      <div className="next-openings-head">
        <strong><CalendarPlus size={14} /> Next openings</strong>
        {data?.need && <span className="muted" title="What they likely need">{data.need.label}</span>}
      </div>
      {live?.realtime && (
        <div className={`next-openings-heard${heardText ? ' is-heard' : ''}`} aria-live="polite">
          <Ear size={12} /> {heardText ? <>Heard: <strong>{heardText}</strong></> : 'Listening for a day or time…'}
        </div>
      )}
      <div className="next-openings-chips" role="group" aria-label="Filter open times">
        {days.map((d) => <button key={d} type="button" className={`chip${req?.weekdays?.includes(d) ? ' on' : ''}`} aria-pressed={!!req?.weekdays?.includes(d)} onClick={() => toggleDay(d)}>{WEEKDAYS[d]}</button>)}
        <button type="button" className={`chip${req?.part === 'am' ? ' on' : ''}`} aria-pressed={req?.part === 'am'} onClick={() => setPart('am')}>AM</button>
        <button type="button" className={`chip${req?.part === 'pm' ? ' on' : ''}`} aria-pressed={req?.part === 'pm'} onClick={() => setPart('pm')}>PM</button>
        <button type="button" className={`chip${req?.asap ? ' on' : ''}`} aria-pressed={!!req?.asap} onClick={toggleAsap}>Soonest</button>
        {providers.length > 1 && providers.slice(0, 6).map((p) => (
          <button key={p.id} type="button" className={`chip${req?.provider_ids?.includes(p.id) ? ' on' : ''}`} aria-pressed={!!req?.provider_ids?.includes(p.id)} onClick={() => toggleProvider(p.id)}>{p.name.replace(/,.*$/, '')}</button>
        ))}
        {!emptyRequest(req) && <button type="button" className="link small" onClick={clear}>Clear</button>}
      </div>
      {error && <div className="error">{error.message}</div>}
      <div className="next-openings-list">
        {shown.map((s, i) => (
          <button key={keyOf(s)} type="button" className={`slot${i === 0 ? ' first' : ''}`} disabled={!patientId || !!busy} onClick={() => book(s)} data-start={s.start} data-provider={s.provider_id}
            title={patientId ? `Book ${slotLabel(s)} with ${s.provider}` : 'Add the caller as a patient first'}>
            <span>{slotLabel(s)}</span><span className="muted">{s.provider.replace(/,.*$/, '')}</span>
            {i === 0 && primary && patientId && <kbd className="call-pop-kbd">{comboLabel('alt+b').join(' ')}</kbd>}
          </button>
        ))}
        {!shown.length && <div className="muted small-note">No open times match{emptyRequest(req) ? ' in the next few weeks' : ' — clear a filter'}.</div>}
      </div>
      {!patientId && <div className="small-note muted">New caller: <Link to="/patients?new=1">add them as a patient</Link> (or attach the call) to book.</div>}
    </div>
  );
}
