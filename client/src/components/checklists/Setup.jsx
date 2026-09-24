import { useCallback, useEffect, useState } from 'react';
import { Plus, Archive, RotateCcw, Pencil, Sparkles, Users, Bell, BookOpen, Check } from 'lucide-react';
import { api } from '../../api.js';
import { toast } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import { cadenceText, CriticalChip, WEEKDAYS, MONTHS, rangeText } from './shared.jsx';
import './checklists.css';

const ROLES = { '': 'No role', front_desk: 'Front desk', hygienist: 'Hygienists', assistant: 'Assistants', dentist: 'Dentists', billing: 'Billing', admin: 'Administrators' };
const BLANK = { title: '', instructions: '', cadence: 'daily', weekdays: null, weekday: 1, month_day: 1, month: 1, due_time: '17:00', assign_rule: 'position', assignee_id: '', result_type: 'none', min_value: '', max_value: '', unit: '', require_photo: 0, require_file: 0, require_note: 0, critical: 0, sop_page_id: '' };

// Setting checklists up (RCL1): starters in one click, checklists per position with their items, positions and
// who's in them, and who hears about flags. For people with checklists:manage.
export default function ChecklistSetup() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { templateId, item } — item null = new
  const [newT, setNewT] = useState(null);
  const load = useCallback(() => api.get('/checklists/setup').then((x) => { setD(x); setError(null); }).catch(setError), []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, ok) => {
    try { await fn(); if (ok) toast(ok); await load(); return true; } catch (e) { toast(e.message, { tone: 'error' }); return false; }
  };
  if (error) return <ErrorBox error={error} />;
  if (!d) return <p className="muted">Loading…</p>;
  const active = d.templates.filter((t) => t.status === 'active');
  const archived = d.templates.filter((t) => t.status !== 'active');

  return (
    <div>
      <section className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0, display: 'flex', gap: 8, alignItems: 'center' }}><Sparkles size={18} aria-hidden /> Starter checklists</h2>
        <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>Add one with a click, then change anything. They follow common US guidance — adapt them to your office, your equipment’s instructions and your state’s rules.</p>
        <div className="cl-starters">
          {d.starters.map((s) => (
            <div key={s.key} className="cl-starter">
              <strong>{s.name}</strong>
              <span className="muted" style={{ fontSize: 13 }}>{s.description}</span>
              <span style={{ fontSize: 12.5 }}>{s.position} · {s.items} item{s.items === 1 ? '' : 's'}{s.critical ? ` · ${s.critical} critical` : ''}</span>
              <span className="adapt">Adapt to your office and state rules</span>
              <button className={s.added ? 'small' : 'small primary'} disabled={s.added} onClick={() => run(() => api.post(`/checklists/starters/${s.key}`, {}), `Added: ${s.name}`)}>
                {s.added ? <><Check size={13} aria-hidden /> Added</> : <><Plus size={13} aria-hidden /> Add</>}
              </button>
            </div>
          ))}
        </div>
      </section>

      <div className="page-header" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Checklists</h2>
        <button className="primary" onClick={() => setNewT({ name: '', position_id: d.positions.find((p) => p.status === 'active')?.id || '', location_id: '' })}><Plus size={15} aria-hidden /> New checklist</button>
      </div>
      {newT && (
        <div className="cl-template">
          <div className="cl-form">
            <label>Name<input autoFocus value={newT.name} onChange={(e) => setNewT({ ...newT, name: e.target.value })} placeholder="e.g. Assistant opening" /></label>
            <label>Position<select value={newT.position_id} onChange={(e) => setNewT({ ...newT, position_id: e.target.value })}>{d.positions.filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            {d.locations.length > 1 && <label>Office<select value={newT.location_id} onChange={(e) => setNewT({ ...newT, location_id: e.target.value })}><option value="">Every office (one each)</option>{d.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
            <div className="wide" style={{ display: 'flex', gap: 8 }}>
              <button className="primary" disabled={!newT.name.trim()} onClick={async () => (await run(() => api.post('/checklists/templates', { ...newT, location_id: newT.location_id || null }), 'Checklist made — add its items')) && setNewT(null)}>Create</button>
              <button onClick={() => setNewT(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {!active.length && !newT && <div className="card cl-empty">No checklists yet. Add a starter above, or make your own.</div>}
      {active.map((t) => (
        <div key={t.id} className="cl-template">
          <header>
            <div>
              <h3>{t.name}</h3>
              <div className="muted" style={{ fontSize: 12.5 }}>{t.position_name} · {t.location_name || (d.locations.length > 1 ? 'every office' : 'the office')}{t.starter_key ? ' · starter (adapt to your office and state rules)' : ''}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="small" onClick={() => setEditing({ templateId: t.id, item: null })}><Plus size={13} aria-hidden /> Item</button>
              <button className="small" title="Stop this checklist (history is kept)" onClick={() => run(() => api.put(`/checklists/templates/${t.id}`, { status: 'archived' }), `Archived: ${t.name}`)}><Archive size={13} aria-hidden /> Archive</button>
            </div>
          </header>
          {t.items.filter((i) => i.status === 'active').map((i) => (
            editing?.item?.id === i.id ? <ItemForm key={i.id} d={d} initial={i} onCancel={() => setEditing(null)} onSave={async (row) => (await run(() => api.put(`/checklists/items/${i.id}`, row), 'Saved')) && setEditing(null)} /> : (
              <div key={i.id} className="cl-item-line">
                <div className="t">
                  <strong>{i.title}</strong> {i.critical ? <CriticalChip /> : null}
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {cadenceText(i)}
                    {i.result_type === 'number' && ` · reading${rangeText(i) ? ` (${rangeText(i)})` : ''}`}
                    {i.result_type === 'pass_fail' && ' · pass/fail'}
                    {i.result_type === 'text' && ' · answer'}
                    {i.require_photo ? ' · photo' : ''}{i.require_file ? ' · file' : ''}{i.require_note ? ' · note' : ''}
                    {i.assign_rule === 'person' ? ` · ${i.assignee_name}` : i.assign_rule === 'on_shift' ? ' · whoever is on shift' : ''}
                    {i.sop_title && <> · <BookOpen size={11} aria-hidden /> {i.sop_title}</>}
                  </div>
                </div>
                <button className="small" onClick={() => setEditing({ templateId: t.id, item: i })}><Pencil size={13} aria-hidden /> Edit</button>
                <button className="small" title="Take this item off (history is kept)" onClick={() => run(() => api.put(`/checklists/items/${i.id}`, { status: 'archived' }), `Taken off: ${i.title}`)}><Archive size={13} aria-hidden /></button>
              </div>
            )
          ))}
          {editing?.templateId === t.id && !editing.item && (
            <ItemForm d={d} initial={BLANK} onCancel={() => setEditing(null)} onSave={async (row) => (await run(() => api.post(`/checklists/templates/${t.id}/items`, row), 'Item added')) && setEditing(null)} />
          )}
        </div>
      ))}
      {archived.length > 0 && (
        <details style={{ marginBottom: 16 }}>
          <summary className="muted">Archived checklists ({archived.length})</summary>
          {archived.map((t) => (
            <div key={t.id} className="cl-item-line archived"><span className="t">{t.name} · {t.position_name}</span>
              <button className="small" onClick={() => run(() => api.put(`/checklists/templates/${t.id}`, { status: 'active' }), `Restored: ${t.name}`)}><RotateCcw size={13} aria-hidden /> Restore</button></div>
          ))}
        </details>
      )}

      <div className="cl-grid2" style={{ marginTop: 16 }}>
        <Positions d={d} run={run} />
        <Alerts d={d} run={run} />
      </div>
    </div>
  );
}

function ItemForm({ d, initial, onSave, onCancel }) {
  const [f, setF] = useState(() => ({ ...BLANK, ...initial, assignee_id: initial.assignee_id || '', sop_page_id: initial.sop_page_id || '', min_value: initial.min_value ?? '', max_value: initial.max_value ?? '', unit: initial.unit || '' }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value });
  const days = f.weekdays ? f.weekdays.split(',').map(Number) : null;
  const toggleDay = (n) => {
    const cur = days || [1, 2, 3, 4, 5];
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort();
    setF({ ...f, weekdays: next.join(',') || null });
  };
  const save = () => {
    const row = {
      title: f.title, instructions: f.instructions || null, cadence: f.cadence, due_time: f.due_time, assign_rule: f.assign_rule, assignee_id: f.assign_rule === 'person' ? Number(f.assignee_id) || null : null,
      result_type: f.result_type, unit: f.unit || null, min_value: f.result_type === 'number' ? f.min_value : null, max_value: f.result_type === 'number' ? f.max_value : null,
      require_photo: f.require_photo, require_file: f.require_file, require_note: f.require_note, critical: f.critical, sop_page_id: Number(f.sop_page_id) || null,
    };
    if (f.cadence === 'daily') row.weekdays = f.weekdays;
    if (f.cadence === 'weekly') row.weekday = Number(f.weekday);
    if (['monthly', 'quarterly', 'annually'].includes(f.cadence)) row.month_day = Number(f.month_day);
    if (['quarterly', 'annually'].includes(f.cadence)) row.month = Number(f.month);
    onSave(row);
  };
  return (
    <div className="cl-form" onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }}>
      <label className="wide">What needs doing<input autoFocus value={f.title} onChange={set('title')} placeholder="e.g. Weekly spore test" /></label>
      <label className="wide">How (optional)<textarea rows={2} value={f.instructions || ''} onChange={set('instructions')} /></label>
      <label>How often<select value={f.cadence} onChange={set('cadence')}>
        <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annually">Every year</option>
      </select></label>
      {f.cadence === 'daily' && (
        <label>On<span className="cl-days">{WEEKDAYS.map((w, n) => <button type="button" key={w} className={(days || []).includes(n) ? 'on' : ''} onClick={() => toggleDay(n)}>{w[0]}</button>)}</span>
          <span style={{ fontSize: 11.5 }}>{days ? '' : 'Every day the office is open'}{days && <button type="button" className="link" onClick={() => setF({ ...f, weekdays: null })}>open days</button>}</span></label>
      )}
      {f.cadence === 'weekly' && <label>Day<select value={f.weekday} onChange={set('weekday')}>{WEEKDAYS.map((w, n) => <option key={w} value={n}>{w}</option>)}</select></label>}
      {['quarterly', 'annually'].includes(f.cadence) && <label>{f.cadence === 'annually' ? 'Month' : 'Starting month'}<select value={f.month} onChange={set('month')}>{MONTHS.map((m, n) => <option key={m} value={n + 1}>{m}</option>)}</select></label>}
      {['monthly', 'quarterly', 'annually'].includes(f.cadence) && (
        <label>Day of month<select value={f.month_day} onChange={set('month_day')}>
          {Array.from({ length: 31 }, (_, n) => <option key={n} value={n + 1}>{n + 1}{n + 1 > 28 ? ' (or the last day)' : ''}</option>)}
          <option value={-1}>Last business day</option>
        </select></label>
      )}
      <label>Due by<input type="time" value={f.due_time} onChange={set('due_time')} /></label>
      <label>Who<select value={f.assign_rule} onChange={set('assign_rule')}>
        <option value="position">Anyone in the position</option><option value="on_shift">Whoever is on shift</option><option value="person">A named person</option>
      </select></label>
      {f.assign_rule === 'person' && <label>Person<select value={f.assignee_id} onChange={set('assignee_id')}><option value="">Choose…</option>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
      <label>Result<select value={f.result_type} onChange={set('result_type')}>
        <option value="none">Just tick it</option><option value="pass_fail">Pass / fail</option><option value="number">A number</option><option value="text">A short answer</option>
      </select></label>
      {f.result_type === 'number' && (
        <>
          <label>Lowest allowed<input inputMode="decimal" value={f.min_value} onChange={set('min_value')} /></label>
          <label>Highest allowed<input inputMode="decimal" value={f.max_value} onChange={set('max_value')} /></label>
          <label>Unit<input value={f.unit} onChange={set('unit')} placeholder="°F, psi…" /></label>
        </>
      )}
      <label>Office manual page (SOP)<select value={f.sop_page_id} onChange={set('sop_page_id')}><option value="">None</option>{d.sop_pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
      <div className="wide checks">
        <label><input type="checkbox" checked={!!f.require_photo} onChange={set('require_photo')} /> Photo required</label>
        <label><input type="checkbox" checked={!!f.require_file} onChange={set('require_file')} /> File required (certificate, report)</label>
        <label><input type="checkbox" checked={!!f.require_note} onChange={set('require_note')} /> Note required</label>
        <label><input type="checkbox" checked={!!f.critical} onChange={set('critical')} /> <strong>Critical</strong>&nbsp;— a fail, a number out of range or a missed due time alerts you straight away</label>
      </div>
      <div className="wide" style={{ display: 'flex', gap: 8 }}>
        <button className="primary" disabled={!f.title.trim()} onClick={save}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Positions({ d, run }) {
  const [edit, setEdit] = useState(null);
  const save = async () => {
    const body = { name: edit.name, role: edit.role || null, custom_role_id: edit.custom_role_id || null, member_ids: edit.member_ids };
    const ok = await run(() => (edit.id ? api.put(`/checklists/positions/${edit.id}`, body) : api.post('/checklists/positions', body)), 'Position saved');
    if (ok) setEdit(null);
  };
  return (
    <section className="card">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}><Users size={18} aria-hidden /> Positions</h2>
        <button className="small" onClick={() => setEdit({ name: '', role: '', custom_role_id: '', member_ids: [] })}><Plus size={13} aria-hidden /> Position</button>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Everyone with the position’s role is in it, plus anyone you add by name.</p>
      {d.positions.filter((p) => p.status === 'active').map((p) => (
        edit?.id === p.id ? null : (
          <div key={p.id} className="cl-item-line">
            <div className="t"><strong>{p.name}</strong><div className="muted" style={{ fontSize: 12.5 }}>{p.people.map((u) => u.name).join(', ') || 'Nobody yet'}</div></div>
            <button className="small" onClick={() => setEdit({ id: p.id, name: p.name, role: p.role || '', custom_role_id: p.custom_role_id || '', member_ids: p.member_ids })}><Pencil size={13} aria-hidden /></button>
            <button className="small" title="Archive position" onClick={() => run(() => api.put(`/checklists/positions/${p.id}`, { status: 'archived' }), `Archived: ${p.name}`)}><Archive size={13} aria-hidden /></button>
          </div>
        )
      ))}
      {edit && (
        <div className="cl-form">
          <label>Name<input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label>Everyone with the role<select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {d.custom_roles.length > 0 && <label>…or custom role<select value={edit.custom_role_id} onChange={(e) => setEdit({ ...edit, custom_role_id: e.target.value })}><option value="">None</option>{d.custom_roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
          <div className="wide checks">
            {d.users.map((u) => (
              <label key={u.id}><input type="checkbox" checked={edit.member_ids.includes(u.id)} onChange={(e) => setEdit({ ...edit, member_ids: e.target.checked ? [...edit.member_ids, u.id] : edit.member_ids.filter((x) => x !== u.id) })} /> {u.name}</label>
            ))}
          </div>
          <div className="wide" style={{ display: 'flex', gap: 8 }}><button className="primary" disabled={!edit.name.trim()} onClick={save}>Save</button><button onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
    </section>
  );
}

function Alerts({ d, run }) {
  const s = d.settings;
  const [phones, setPhones] = useState((s.alert_phones || []).join(', '));
  const chosen = s.alert_user_ids || [];
  const put = (body, ok = 'Saved') => run(() => api.put('/checklists/settings', body), ok);
  return (
    <section className="card">
      <h2 style={{ marginTop: 0, display: 'flex', gap: 8, alignItems: 'center' }}><Bell size={18} aria-hidden /> Alerts</h2>
      <p className="muted" style={{ marginTop: -6, fontSize: 13 }}>When a critical item fails, reads out of range or isn’t done by its time, these people get an alert on screen and in team chat, and it goes on Needs attention until someone writes down what was done.</p>
      <div className="checks" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 13.5 }}>
        {d.users.map((u) => (
          <label key={u.id}><input type="checkbox" checked={chosen.includes(u.id)} onChange={(e) => put({ alert_user_ids: e.target.checked ? [...chosen, u.id] : chosen.filter((x) => x !== u.id) })} /> {u.name}</label>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>{chosen.length ? '' : 'Nobody ticked: administrators and everyone who manages checklists.'}</p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}><input type="checkbox" checked={!!s.chat_alerts} onChange={(e) => put({ chat_alerts: e.target.checked })} /> Post alerts in team chat</label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, marginTop: 6 }}><input type="checkbox" checked={!!s.sms_alerts} onChange={(e) => put({ sms_alerts: e.target.checked })} /> Text critical alerts to</label>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <input style={{ flex: 1 }} value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="(512) 555-0100, (512) 555-0101" aria-label="Phone numbers for alert texts" />
        <button className="small" onClick={() => put({ alert_phones: phones.split(',').map((x) => x.trim()).filter(Boolean) }, 'Numbers saved')}>Save</button>
      </div>
      {!d.sms_ready && <p className="muted" style={{ fontSize: 12.5 }}>Texting isn’t set up on this server yet.</p>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, marginTop: 12 }}>
        Ticks can be undone for
        <select value={s.undo_minutes} onChange={(e) => put({ undo_minutes: Number(e.target.value) })}>{[0, 2, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{n} min</option>)}</select>
        then changes need a reason.
      </label>
    </section>
  );
}
