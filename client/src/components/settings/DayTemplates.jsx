import { useMemo, useState } from 'react';
import { CalendarRange, Plus, Trash2, Pencil, Archive, RotateCcw, Lock, Target, CalendarCog, AlarmClock } from 'lucide-react';
import { api } from '../../api.js';
import { useApi, useLookup } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { useRemembered } from '../../prefs.js';
import { money, toCents, fromCents, practiceToday, shiftDate } from '../../format.js';
import { toast } from '../../toast.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import './daytemplates.css';

// Settings → Schedule setup. Perfect day (S2): each provider's ideal day as blocks kept for certain visit types, with production
// goals for each block and the day. A template plans its weekdays by itself; one date can be planned
// differently below. Blocks take only their visit types until the release time, then anything books there.
// Administrators edit templates; anyone who can book can change a single day. Below them, the late-patient
// times (S7).

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SWATCHES = ['#8b5cf6', '#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899'];
const dollars = (c) => money(c).replace(/\.00$/, '');
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const clock = (t) => { const m = toMin(t); return `${((Math.floor(m / 60) + 11) % 12) + 1}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${m < 720 ? 'a' : 'p'}`; };
const firstName = (name = '') => name.replace(/,.*$/, '').trim();

const emptyBlock = (after = '08:00', i = 0) => ({ key: `n${Date.now()}${i}`, label: '', start_time: after, end_time: hhmm(Math.min(toMin(after) + 120, 22 * 60)), appointment_type_ids: [], goal: '', release_hours: '', color: SWATCHES[i % SWATCHES.length] });
const fromTemplate = (t) => ({
  id: t.id, provider_id: t.provider_id, location_id: t.location_id ?? '', name: t.name, weekdays: t.weekdays, release_hours: t.release_hours,
  day_goal: t.day_goal == null ? '' : fromCents(t.day_goal),
  blocks: t.blocks.map((b) => ({ key: `b${b.id}`, label: b.label, start_time: b.start_time, end_time: b.end_time, appointment_type_ids: b.appointment_type_ids, goal: b.goal ? fromCents(b.goal) : '', release_hours: b.release_hours ?? '', color: b.color || '' })),
});

// The day at a glance: blocks on a 7am–7pm line.
function DayStrip({ blocks, types }) {
  const start = Math.min(7 * 60, ...blocks.map((b) => toMin(b.start_time)));
  const end = Math.max(19 * 60, ...blocks.map((b) => toMin(b.end_time)));
  const span = end - start;
  return (
    <div className="dt-strip" aria-hidden="true">
      {blocks.map((b) => (
        <span key={b.key || b.id} className="dt-strip-block" style={{ left: `${((toMin(b.start_time) - start) / span) * 100}%`, width: `${((toMin(b.end_time) - toMin(b.start_time)) / span) * 100}%`, '--c': b.color || 'var(--primary)' }}
          title={`${b.label} ${clock(b.start_time)}–${clock(b.end_time)}${b.appointment_type_ids?.length ? ` · ${b.appointment_type_ids.map((id) => types.find((t) => t.id === id)?.name).filter(Boolean).join(', ')}` : ''}`}>
          <em>{b.label}</em>
        </span>
      ))}
      {[9, 12, 15, 18].map((h) => h * 60 > start && h * 60 < end && <i key={h} className="dt-strip-tick" style={{ left: `${((h * 60 - start) / span) * 100}%` }}>{h > 12 ? h - 12 : h}{h >= 12 ? 'p' : 'a'}</i>)}
    </div>
  );
}

function Editor({ initial, providers, types, locations, onSaved, onCancel }) {
  const [t, setT] = useState(initial);
  const set = (patch) => setT((x) => ({ ...x, ...patch }));
  const setBlock = (i, patch) => setT((x) => ({ ...x, blocks: x.blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)) }));
  const provider = providers.find((p) => p.id === Number(t.provider_id));
  // Types that suit the provider (a hygienist's visits for a hygienist), others after them.
  const shownTypes = useMemo(() => {
    const fits = (ty) => !ty.provider_type || !provider || ty.provider_type === (provider.type === 'hygienist' ? 'hygienist' : 'dentist');
    return [...types.filter(fits), ...types.filter((ty) => !fits(ty))].filter((ty) => ty.active !== 0);
  }, [types, provider]);
  const blockSum = t.blocks.reduce((s, b) => s + (toCents(b.goal) || 0), 0);
  const blockName = (b) => b.appointment_type_ids.map((id) => types.find((ty) => ty.id === id)?.name).filter(Boolean).slice(0, 2).join(' & ') || 'Open time';
  const { submit, busy, error } = useSubmit(async () => {
    const body = {
      provider_id: Number(t.provider_id), location_id: t.location_id ? Number(t.location_id) : null, name: t.name.trim() || `${firstName(provider?.name)} ${t.weekdays.map((d) => LONG_DAYS[d]).join(' & ') || 'day'}`,
      weekdays: t.weekdays, release_hours: Number(t.release_hours) || 0, day_goal: t.day_goal === '' ? null : toCents(t.day_goal),
      blocks: t.blocks.map((b) => ({
        // A block without a name is named for what it's kept for ("Crown prep"), or "Open time" for a goal only.
        label: b.label.trim() || blockName(b), start_time: b.start_time, end_time: b.end_time, appointment_type_ids: b.appointment_type_ids,
        goal: b.goal === '' ? 0 : toCents(b.goal), release_hours: b.release_hours === '' ? null : Number(b.release_hours), color: b.color || null,
      })),
    };
    const saved = t.id ? await api.put(`/day-templates/${t.id}`, body) : await api.post('/day-templates', body);
    onSaved(saved, !t.id);
  });
  return (
    <form className="dt-editor" onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
      <div className="form-grid">
        <label>Provider
          <select value={t.provider_id} onChange={(e) => set({ provider_id: e.target.value })} required autoFocus={!t.id}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Name<input value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder={`${firstName(provider?.name)} ${t.weekdays.map((d) => LONG_DAYS[d]).join(' & ') || 'Tuesday'}`} maxLength={80} /></label>
        <label>Day goal
          <span className="dt-money"><span>$</span><input type="number" min="0" step="50" inputMode="decimal" value={t.day_goal} onChange={(e) => set({ day_goal: e.target.value })} placeholder={blockSum ? `${fromCents(blockSum)} (the blocks)` : 'e.g. 6000'} /></span>
        </label>
        <label title="Until this long before a block starts, only its visit types can book there. After that it's open to anything.">Keep blocks until
          <select value={t.release_hours} onChange={(e) => set({ release_hours: Number(e.target.value) })}>
            {[0, 2, 4, 12, 24, 48, 72, 168].map((h) => <option key={h} value={h}>{h === 0 ? 'the block starts' : h < 48 ? `${h} hours before` : `${h / 24} days before`}</option>)}
          </select>
        </label>
        {locations.length > 1 && (
          <label>Office
            <select value={t.location_id} onChange={(e) => set({ location_id: e.target.value })}>
              <option value="">Any office</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <fieldset className="dt-days">
        <legend>Use it every</legend>
        <div className="chips">
          {DAYS.map((d, i) => (
            <button key={d} type="button" className={`chip${t.weekdays.includes(i) ? ' active' : ''}`} aria-pressed={t.weekdays.includes(i)}
              onClick={() => set({ weekdays: t.weekdays.includes(i) ? t.weekdays.filter((x) => x !== i) : [...t.weekdays, i].sort() })}>{d}</button>
          ))}
        </div>
        {!t.weekdays.length && <span className="muted">No weekday: it's only used on the days you pick below.</span>}
      </fieldset>

      <div className="dt-blocks">
        <div className="dt-blocks-head"><h3>Blocks</h3><span className="muted">{t.blocks.length ? `${dollars(blockSum)} in block goals` : 'Add the times you want kept for certain visits.'}</span></div>
        {t.blocks.map((b, i) => (
          <div key={b.key} className="dt-block" style={{ '--c': b.color || 'var(--primary)' }}>
            <div className="dt-block-row">
              <input className="dt-label" aria-label="Block name" placeholder={b.appointment_type_ids.length ? blockName(b) : 'e.g. Crowns (or pick what it’s kept for)'} value={b.label} onChange={(e) => setBlock(i, { label: e.target.value })} maxLength={60} autoFocus={!b.label && i === t.blocks.length - 1 && i > 0} />
              <input type="time" aria-label="Starts" step={600} value={b.start_time} onChange={(e) => setBlock(i, { start_time: e.target.value })} required />
              <span className="muted">to</span>
              <input type="time" aria-label="Ends" step={600} value={b.end_time} onChange={(e) => setBlock(i, { end_time: e.target.value })} required />
              <span className="dt-money" title="Production goal for this block"><Target size={13} /><span>$</span><input type="number" min="0" step="50" inputMode="decimal" aria-label="Block goal" placeholder="Goal" value={b.goal} onChange={(e) => setBlock(i, { goal: e.target.value })} /></span>
              <span className="dt-swatches" role="radiogroup" aria-label="Color">
                {SWATCHES.map((c) => <button key={c} type="button" role="radio" aria-checked={b.color === c} aria-label={c} className={b.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setBlock(i, { color: c })} />)}
              </span>
              <button type="button" className="icon-btn small" aria-label={`Remove ${b.label || 'block'}`} title="Remove this block" onClick={() => setT((x) => ({ ...x, blocks: x.blocks.filter((_, j) => j !== i) }))}><Trash2 size={15} /></button>
            </div>
            <div className="dt-types" aria-label="Visit types kept for this block">
              <span className="muted"><Lock size={12} /> Kept for</span>
              {shownTypes.map((ty) => {
                const on = b.appointment_type_ids.includes(ty.id);
                return <button key={ty.id} type="button" className={`chip small${on ? ' active' : ''}`} aria-pressed={on} style={on ? { background: ty.color, borderColor: ty.color } : undefined}
                  onClick={() => setBlock(i, { appointment_type_ids: on ? b.appointment_type_ids.filter((x) => x !== ty.id) : [...b.appointment_type_ids, ty.id] })}>{ty.name}</button>;
              })}
              {!b.appointment_type_ids.length && <span className="muted">anything (a goal only)</span>}
            </div>
          </div>
        ))}
        <button type="button" className="small" onClick={() => setT((x) => ({ ...x, blocks: [...x.blocks, emptyBlock(x.blocks.at(-1)?.end_time || '08:00', x.blocks.length)] }))}><Plus size={14} /> Add a block</button>
        {t.blocks.length > 0 && <DayStrip blocks={t.blocks.filter((b) => b.start_time && b.end_time && b.end_time > b.start_time)} types={types} />}
      </div>
      <ErrorBox error={error} />
      <div className="inline dt-actions">
        <button className="primary" disabled={busy}>{t.id ? 'Save changes' : 'Create template'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// One date planned differently: another template, none, or back to the usual.
function OneDay({ providers, templates }) {
  const { practice } = useAuth();
  const [providerId, setProviderId] = useState('');
  const pid = Number(providerId || providers[0]?.id);
  const today = practiceToday(practice?.timezone);
  const [date, setDate] = useState(shiftDate(today, 1));
  const [choice, setChoice] = useState('none');
  const [reason, setReason] = useState('');
  const mine = templates.filter((t) => t.provider_id === pid && t.active);
  const { data: overrides, reload } = useApi(`/day-template-dates?from=${today}&to=${shiftDate(today, 120)}`);
  const { submit, busy, error } = useSubmit(async () => {
    const mode = choice === 'none' || choice === 'auto' ? choice : 'template';
    await api.put(`/providers/${pid}/day-plan/${date}`, { mode, template_id: mode === 'template' ? Number(choice) : null, reason: reason || null });
    toast(mode === 'auto' ? 'Back to the usual plan for that day' : 'Saved — the schedule shows it now');
    setReason('');
    reload();
  });
  const nameOf = (id) => providers.find((p) => p.id === id)?.name || 'Provider';
  const tplName = (id) => templates.find((t) => t.id === id)?.name || 'a template';
  return (
    <div className="card">
      <h2 className="dt-h2"><CalendarCog size={18} /> Change one day</h2>
      <p className="muted dt-help">A training morning, a double hygiene day: use another template (or none) for a single date.</p>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label>Provider<select value={pid || ''} onChange={(e) => { setProviderId(e.target.value); setChoice('none'); }}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Date<input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} required /></label>
        <label>That day
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="none">No template (open schedule)</option>
            {mine.map((t) => <option key={t.id} value={t.id}>Use “{t.name}”</option>)}
            <option value="auto">The usual for that weekday</option>
          </select>
        </label>
        <label>Why (optional)<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Staff training" maxLength={300} /></label>
        <div className="full inline"><button className="primary small" disabled={busy || !pid}>Save that day</button><ErrorBox error={error} /></div>
      </form>
      {overrides?.length > 0 && (
        <ul className="dt-overrides">
          {overrides.map((o) => (
            <li key={o.id}>
              <strong>{new Date(`${o.date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })}</strong>
              <span>{nameOf(o.provider_id)}: {o.mode === 'none' ? 'no template' : `“${tplName(o.template_id)}”`}{o.reason ? <span className="muted"> — {o.reason}</span> : null}</span>
              <button className="link" onClick={async () => { await api.put(`/providers/${o.provider_id}/day-plan/${o.date}`, { mode: 'auto' }); reload(); }}>Back to usual</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Late patients (S7): when the schedule calls a visit late and very late; the soft sound is each person's choice.
function LateSettings({ admin }) {
  const { data, reload } = useApi('/schedule/late-settings');
  const [form, setForm] = useState(null);
  const [sound, rememberSound] = useRemembered('schedule.late_sound', false);
  const f = form || (data ? { late_minutes: data.late_minutes, very_late_minutes: data.very_late_minutes } : null);
  const { submit, busy, error } = useSubmit(async () => {
    await api.put('/schedule/late-settings', { late_minutes: Number(f.late_minutes), very_late_minutes: Number(f.very_late_minutes) });
    setForm(null);
    reload();
    toast('Saved — the schedule uses the new times now');
  });
  if (!f) return null;
  const changed = form && (Number(form.late_minutes) !== data.late_minutes || Number(form.very_late_minutes) !== data.very_late_minutes);
  return (
    <div className="card">
      <h2 className="dt-h2"><AlarmClock size={18} /> Late patients</h2>
      <p className="muted dt-help">A visit that isn’t checked in this long after its time gets a red outline and a “Late” chip, and shows in the list at the top of the schedule. Very late visits pulse.</p>
      <form className="form-grid dt-late" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label>Late after
          <span className="dt-money"><input type="number" min="1" max="60" step="1" value={f.late_minutes} disabled={!admin} onChange={(e) => setForm({ ...f, late_minutes: e.target.value })} required /><span>minutes</span></span>
        </label>
        <label>Very late after
          <span className="dt-money"><input type="number" min={Number(f.late_minutes) || 1} max="60" step="1" value={f.very_late_minutes} disabled={!admin} onChange={(e) => setForm({ ...f, very_late_minutes: e.target.value })} required /><span>minutes</span></span>
        </label>
        <label className="checkbox dt-sound"><input type="checkbox" checked={!!sound} onChange={(e) => rememberSound(e.target.checked)} /> Play a soft sound for me when someone becomes late</label>
        {admin && <div className="full inline"><button className="primary small" disabled={busy || !changed}>Save</button><ErrorBox error={error} /></div>}
      </form>
    </div>
  );
}

export default function DayTemplates() {
  const { user, can } = useAuth();
  const admin = user.role === 'admin';
  const providers = useLookup('/providers?active=true');
  const types = useLookup('/appointment-types');
  const locations = useLookup('/locations');
  const { data: templates, error, reload } = useApi('/day-templates?include_retired=true');
  const [editing, setEditing] = useState(null);
  const [showRetired, setShowRetired] = useState(false);
  const [lastProvider, rememberProvider] = useRemembered('settings.day_template.provider', '');
  const list = templates || [];
  const active = list.filter((t) => t.active);
  const retired = list.filter((t) => !t.active);

  const startNew = () => {
    const pid = providers.some((p) => p.id === Number(lastProvider)) ? Number(lastProvider) : providers[0]?.id;
    // The first weekday this provider has no template for.
    const taken = new Set(active.filter((t) => t.provider_id === pid).flatMap((t) => t.weekdays));
    const day = [1, 2, 3, 4, 5, 6, 0].find((d) => !taken.has(d));
    setEditing({ provider_id: pid ?? '', location_id: '', name: '', weekdays: day == null ? [] : [day], release_hours: 24, day_goal: '', blocks: [emptyBlock('08:00', 0)] });
  };
  const setActive = async (t, on) => {
    const saved = on ? await api.put(`/day-templates/${t.id}`, { active: 1 }) : await api.post(`/day-templates/${t.id}/retire`, {});
    reload();
    if (!on) toast(`“${saved.name}” retired — it no longer plans the schedule`, { undo: async () => { await api.put(`/day-templates/${t.id}`, { active: 1 }); reload(); } });
  };
  const byProvider = providers.map((p) => [p, active.filter((t) => t.provider_id === p.id)]).filter(([, ts]) => ts.length);
  const typeName = (id) => types.find((ty) => ty.id === id)?.name;

  return (
    <div className="day-templates">
      <div className="card">
        <div className="dt-top">
          <div>
            <h2 className="dt-h2"><CalendarRange size={18} /> Perfect day templates</h2>
            <p className="muted dt-help">Plan each provider’s ideal day: time kept for crowns, fillings, new patients or an emergency slot, each with a production goal. The schedule shows the blocks as tinted lanes and the day’s goal at the top. Other visit types can only go there with “Book it anyway” until the release time.</p>
          </div>
          {admin && !editing && <button className="primary" onClick={startNew} disabled={!providers.length}><Plus size={16} /> New template</button>}
        </div>
        <ErrorBox error={error} />
        {editing && (
          <Editor initial={editing} providers={providers} types={types} locations={locations}
            onCancel={() => setEditing(null)}
            onSaved={(saved, created) => { rememberProvider(String(saved.provider_id)); setEditing(null); reload(); toast(created ? `“${saved.name}” created — it plans ${saved.weekdays.map((d) => LONG_DAYS[d]).join(', ') || 'the days you choose'}` : `“${saved.name}” saved`); }} />
        )}
        {!editing && !active.length && templates && <div className="empty">No templates yet.{admin ? ' Start with your busiest provider’s best day.' : ' An administrator can set them up.'}</div>}
        {!editing && byProvider.map(([p, ts]) => (
          <section key={p.id} className="dt-provider">
            <h3><i style={{ background: p.color }} />{p.name}</h3>
            {ts.map((t) => {
              const goal = t.day_goal ?? t.blocks.reduce((s, b) => s + b.goal, 0);
              return (
                <article key={t.id} className="dt-card">
                  <div className="dt-card-head">
                    <strong>{t.name}</strong>
                    <span className="dt-weekdays">{DAYS.map((d, i) => <i key={d} className={t.weekdays.includes(i) ? 'on' : ''}>{d[0]}</i>)}</span>
                    {goal > 0 && <span className="dt-goal"><Target size={13} /> {dollars(goal)} goal</span>}
                    <span className="muted dt-release"><Lock size={12} /> kept until {t.release_hours ? `${t.release_hours < 48 ? `${t.release_hours} h` : `${t.release_hours / 24} days`} before` : 'it starts'}</span>
                    {admin && (
                      <span className="dt-card-actions">
                        <button className="small" onClick={() => setEditing(fromTemplate(t))}><Pencil size={14} /> Edit</button>
                        <button className="small" onClick={() => setActive(t, false)} title="Stop using it (kept on file)"><Archive size={14} /> Retire</button>
                      </span>
                    )}
                  </div>
                  <DayStrip blocks={t.blocks} types={types} />
                  <ul className="dt-block-list">
                    {t.blocks.map((b) => (
                      <li key={b.id} style={{ '--c': b.color || 'var(--primary)' }}>
                        <span className="dt-time">{clock(b.start_time)}–{clock(b.end_time)}</span>
                        <strong>{b.label}</strong>
                        <span className="muted">{b.appointment_type_ids.length ? b.appointment_type_ids.map(typeName).filter(Boolean).join(', ') : 'any visit'}</span>
                        {b.goal > 0 && <span className="dt-goal small">{dollars(b.goal)}</span>}
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </section>
        ))}
        {!editing && retired.length > 0 && (
          <div className="dt-retired">
            <button className="link" onClick={() => setShowRetired(!showRetired)}>{showRetired ? 'Hide' : 'Show'} retired templates ({retired.length})</button>
            {showRetired && (
              <ul>
                {retired.map((t) => (
                  <li key={t.id}>
                    <span>{t.name} <span className="muted">· {t.provider_name}</span></span>
                    {admin && <button className="small" onClick={() => setActive(t, true).catch((e) => toast(e.message, { tone: 'error' }))}><RotateCcw size={14} /> Use again</button>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {can('schedule:write') && providers.length > 0 && active.length > 0 && <OneDay providers={providers} templates={list} />}
      <LateSettings admin={admin} />
    </div>
  );
}
