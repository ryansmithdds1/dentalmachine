import { useState } from 'react';
import { api } from '../../api.js';
import { useLookup } from '../../hooks.js';
import { ErrorBox, useSubmit } from '../ui.jsx';

const PRESETS = ['Lunch', 'Staff meeting', 'Holiday', 'Continuing education', 'Emergencies only', 'Crown seats only'];
const plus = (hhmm, mins) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export default function BlockoutForm({ blockout, defaults = {}, onDone }) {
  const providers = useLookup('/providers?active=true');
  const operatories = useLookup('/operatories?active=true');
  const start = defaults.time || '12:00';
  const [form, setForm] = useState(() => (blockout ? {
    reason: blockout.reason, date: blockout.start_time.slice(0, 10), start: blockout.start_time.slice(11, 16), end: blockout.end_time.slice(11, 16),
    provider_id: blockout.provider_id || '', operatory_id: blockout.operatory_id || '', repeat_weeks: 1,
  } : {
    reason: 'Lunch', date: defaults.date, start, end: defaults.end || plus(start, 60),
    provider_id: defaults.provider_id || '', operatory_id: defaults.operatory_id || '', repeat_weeks: 1, through: '',
  }));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const body = () => ({
    reason: form.reason, start_time: `${form.date} ${form.start}`, end_time: `${form.date} ${form.end}`,
    provider_id: form.provider_id ? Number(form.provider_id) : null, operatory_id: form.operatory_id ? Number(form.operatory_id) : null,
  });
  const save = useSubmit(async () => {
    if (blockout) await api.put(`/blockouts/${blockout.id}`, body());
    else await api.post('/blockouts', { ...body(), ...(form.repeat_weeks === 'range' ? { through_date: form.through } : { repeat_weeks: Number(form.repeat_weeks) }) });
    onDone();
  });
  const remove = useSubmit(async (scope) => {
    await api.del(`/blockouts/${blockout.id}${scope === 'series' ? '?scope=series' : ''}`);
    onDone();
  });
  const saveSeries = useSubmit(async () => {
    await api.put(`/blockouts/${blockout.id}`, { ...body(), scope: 'series' });
    onDone();
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); save.submit(); }}>
      <ErrorBox error={save.error || remove.error || saveSeries.error} />
      <div className="inline" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {PRESETS.map((p) => <button type="button" key={p} className={`small${form.reason === p ? ' primary' : ''}`} onClick={() => setForm({ ...form, reason: p })}>{p}</button>)}
      </div>
      <div className="form-grid">
        <label className="full">Reason<input required value={form.reason} onChange={set('reason')} /></label>
        <label>Date<input type="date" required value={form.date} onChange={set('date')} /></label>
        <label>From<input type="time" step={600} required value={form.start} onChange={set('start')} /></label>
        <label>To<input type="time" step={600} required value={form.end} onChange={set('end')} /></label>
        <label>
          Applies to provider
          <select value={form.provider_id} onChange={set('provider_id')}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          Applies to chair
          <select value={form.operatory_id} onChange={set('operatory_id')}>
            <option value="">—</option>
            {operatories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        {!blockout && (
          <label>
            Repeat
            <select value={form.repeat_weeks} onChange={set('repeat_weeks')}>
              <option value={1}>Just this day</option>
              <option value="range">Every day through…</option>
              {[4, 8, 12, 26, 52].map((n) => <option key={n} value={n}>Weekly for {n} weeks</option>)}
            </select>
          </label>
        )}
        {!blockout && form.repeat_weeks === 'range' && (
          <label>Through<input type="date" required min={form.date} value={form.through} onChange={set('through')} /></label>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Leave provider and chair empty to block the whole office. Booking into blocked time asks for confirmation.</p>
      <div className="form-actions">
        {blockout && <button type="button" className="danger" disabled={remove.busy} onClick={() => confirm('Remove this blocked time?') && remove.submit()}>Remove</button>}
        {blockout?.series_key && <button type="button" className="danger" disabled={remove.busy} onClick={() => confirm('Remove every day in this series?') && remove.submit('series')}>Remove whole series</button>}
        {blockout?.series_key && <button type="button" disabled={saveSeries.busy} onClick={() => saveSeries.submit()} title="Apply the reason, provider and chair to every day in the series">Save for whole series</button>}
        <button className="primary" disabled={save.busy}>{blockout ? 'Save' : 'Block time'}</button>
      </div>
    </form>
  );
}
