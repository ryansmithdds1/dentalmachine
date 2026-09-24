import { useEffect, useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Plus } from 'lucide-react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { useAuth } from '../../auth.jsx';
import { money, label as nice } from '../../format.js';
import { undoable } from '../../toast.js';
import { ErrorBox } from '../ui.jsx';
import ShortcutIcon, { ICONS } from '../patient/ShortcutIcon.jsx';
import {
  buildLookups, resolveEntry, shortcutText, checkBundle, expandBundle, describe, WORK_KINDS, FINDING_KINDS, TOOTH_RULES, QUADRANTS, ARCHES, areaKind,
} from '../patient/chartShorthand.js';
import { isMac } from '../../shortcuts.js';
import '../patient/treatmententry.css';

// Settings → Clinical → Chart shortcuts & bundles: the chart's quick buttons (Alt+1…9), typed/spoken aliases and
// bundles — the office's (administrators) and your own. Each edit shows, live, exactly what it would chart.
// Nothing is deleted: retiring takes it off the chart and it can be brought back.
const TOOTH_RULE_LABELS = { same: 'the tooth', range: 'each tooth', ends: 'end teeth (retainers)', between: 'teeth between (pontics)', none: 'no tooth', unsealed_molars: 'unsealed molars' };
const MODES = [['plan', 'Plan it'], ['done', 'Done today'], ['existing', 'Already there']];

export default function ChartShortcuts() {
  const { user, can } = useAuth();
  const admin = user.role === 'admin';
  const { data, reload, error } = useApi('/chart-shortcuts?all=1');
  const [scope, setScope] = useState(admin ? 'office' : 'mine');
  const [editing, setEditing] = useState(null); // { kind: 'button' | 'bundle', row }
  const [err, setErr] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Loading…</div>;
  const canEdit = scope === 'office' ? admin : can('clinical:write');
  const ours = (r) => (scope === 'office' ? r.user_id == null : r.mine);
  const live = { bundles: data.bundles.filter((b) => b.active), shortcuts: data.shortcuts.filter((s) => s.active) };
  const buttons = data.shortcuts.filter(ours);
  const bundles = data.bundles.filter(ours);
  const act = async (fn) => { setErr(null); try { await fn(); reload(); } catch (e) { setErr(e); } };
  const retire = (table, row, name) => undoable(`Retired ${name}`, async () => { await api.post(`/${table}/${row.id}/retire`); reload(); }, async () => { await api.post(`/${table}/${row.id}/restore`); reload(); }).catch(() => { /* shown as a toast */ });
  const move = (row, dir) => act(async () => {
    const ids = buttons.filter((b) => b.active).map((b) => b.id);
    const i = ids.indexOf(row.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.put('/chart-shortcuts/order', { scope, ids });
  });
  const activeButtons = buttons.filter((b) => b.active);

  return (
    <div className="te-editor">
      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Chart shortcuts &amp; bundles</h2>
            <div className="muted" style={{ fontSize: 13 }}>
              Quick buttons sit above the tooth chart; the first nine are {isMac ? '⌥' : 'Alt+'}1…9. Aliases work in chart-by-typing (“14 crb bu”, “np”) and
              by voice (“crown bundle on 14 with buildup, plan it”). Your own sit after the office’s.
            </div>
          </div>
          <div className="tabs">
            <button className={scope === 'office' ? 'active' : ''} onClick={() => { setScope('office'); setEditing(null); }}>Office</button>
            <button className={scope === 'mine' ? 'active' : ''} onClick={() => { setScope('mine'); setEditing(null); }}>Mine</button>
          </div>
        </div>
        {scope === 'office' && !admin && <p className="muted" style={{ fontSize: 13 }}>Only an administrator changes the office’s. Add your own under Mine.</p>}
        <ErrorBox error={err} />
      </div>

      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Quick buttons &amp; aliases</h3>
          {canEdit && <button className="small primary" onClick={() => setEditing({ kind: 'button', row: { label: '', kind: 'bundle', target: '', mode: 'plan', button: 1, color: '#2563eb', icon: 'star' } })}><Plus size={14} aria-hidden /> Button or alias</button>}
        </div>
        <table className="te-list">
          <tbody>
            {buttons.map((s) => {
              const n = activeButtons.filter((b) => b.button).indexOf(s);
              return (
                <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}>
                  <td style={{ width: 70 }}>{canEdit && s.active && <><button className="small" aria-label={`Move ${s.label} up`} onClick={() => move(s, -1)}><ArrowUp size={12} /></button><button className="small" aria-label={`Move ${s.label} down`} onClick={() => move(s, 1)}><ArrowDown size={12} /></button></>}</td>
                  <td><span className="te-swatch" style={{ background: s.color || 'var(--border)' }} /><ShortcutIcon name={s.icon} /> <b>{s.label}</b></td>
                  <td className="muted">{s.button && s.active && n >= 0 && scope === 'office' && n < 9 ? `Alt+${n + 1}` : s.button ? 'button' : 'alias only'}</td>
                  <td>{s.alias ? <code>{s.alias}</code> : <span className="muted">—</span>}</td>
                  <td className="muted">{shortcutText({ ...s, alias: null }, data.bundles) || 'its bundle was retired'}</td>
                  <td className="row-actions">
                    {canEdit && s.active && <button className="small" onClick={() => setEditing({ kind: 'button', row: s })}>Edit</button>}
                    {canEdit && (s.active ? <button className="small" onClick={() => retire('chart-shortcuts', s, s.label)}>Retire</button>
                      : <button className="small" onClick={() => act(() => api.post(`/chart-shortcuts/${s.id}/restore`))}>Bring back</button>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!buttons.length && <div className="muted">None yet.</div>}
        {editing?.kind === 'button' && <ButtonForm key={editing.row.id || 'new'} row={editing.row} scope={scope} setup={live} icons={data.icons} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
      </div>

      <div className="card">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Bundles</h3>
          {canEdit && <button className="small primary" onClick={() => setEditing({ kind: 'bundle', row: { name: '', alias: '', items: [{ work: 'crown', tooth: 'same' }] } })}><Plus size={14} aria-hidden /> Bundle</button>}
        </div>
        <table className="te-list">
          <tbody>
            {bundles.map((b) => (
              <tr key={b.id} style={{ opacity: b.active ? 1 : 0.5 }}>
                <td><b>{b.name}</b></td>
                <td>{b.alias ? <code>{b.alias}</code> : <span className="muted">—</span>}</td>
                <td className="muted" style={{ fontSize: 13 }}>{b.items.map((it) => `${it.optional ? '(' : ''}${it.label || it.code || nice(it.work || it.finding)}${it.area ? ` ${it.area}` : ''}${it.phase ? ` · phase ${it.phase}` : ''}${it.optional ? ')' : ''}`).join(' + ')}</td>
                <td className="row-actions">
                  {canEdit && b.active && <button className="small" onClick={() => setEditing({ kind: 'bundle', row: b })}>Edit</button>}
                  {scope === 'office' && b.active && can('clinical:write') && <button className="small" title="A copy of your own to change" onClick={() => act(() => api.post('/procedure-bundles', { scope: 'mine', name: `${b.name} (mine)`, items: b.items }))}>Copy to mine</button>}
                  {canEdit && (b.active ? <button className="small" onClick={() => retire('procedure-bundles', b, b.name)}>Retire</button>
                    : <button className="small" onClick={() => act(() => api.post(`/procedure-bundles/${b.id}/restore`))}>Bring back</button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!bundles.length && <div className="muted">None yet.</div>}
        {editing?.kind === 'bundle' && <BundleForm key={editing.row.id || 'new'} row={editing.row} scope={scope} setup={live} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
        {canEdit && (
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>Starters — add in one click, then adapt:</div>
            <div className="inline" style={{ flexWrap: 'wrap', gap: 6 }}>
              {data.starters.filter((s) => (scope === 'office' ? !s.office : !bundles.some((b) => b.starter_key === s.key && b.active))).map((s) => (
                <button key={s.key} className="small" onClick={() => act(() => api.post(`/procedure-bundles/starters/${s.key}`, { scope }))}>+ {s.name}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// A preview of words on an example tooth, through the chart's own engine and the server's check (fees).
function LivePreview({ text, setup, extra = {}, example }) {
  const [priced, setPriced] = useState(null);
  const lookups = useMemo(() => buildLookups({ bundles: [...setup.bundles, ...(extra.bundles || [])], shortcuts: [...setup.shortcuts, ...(extra.shortcuts || [])] }), [setup, extra]);
  const out = useMemo(() => {
    if (!text) return { error: 'Nothing to chart yet' };
    const tries = [text, `${example} ${text}`];
    let last;
    for (const t of tries) {
      try { return { words: t, ...resolveEntry(t, { lookups }) }; } catch (e) { last = e; }
    }
    return { error: last.message };
  }, [text, lookups, example]);
  const key = JSON.stringify(out.items || []);
  useEffect(() => {
    setPriced(null);
    if (!out.items?.length) return undefined;
    let alive = true;
    const t = setTimeout(() => api.post('/charting/resolve', { items: out.items }).then((r) => alive && setPriced(r)).catch(() => {}), 250);
    return () => { alive = false; clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="te-preview" role="status">
      {out.error ? <span className="bad">{out.error}</span> : (
        <>
          <span className="muted">“{out.words}” charts: </span>
          {(priced?.items || out.items).map((it, i) => <span key={i} className={`chip${it.error ? ' bad' : ''}`} title={it.error || it.description || ''}>{it.phase ? `P${it.phase} ` : ''}{describe(it)}{it.fee != null ? ` · ${money(it.fee)}` : ''}</span>)}
          {priced && <b> Total {money(priced.total_fee)}</b>}
          {priced?.errors?.length > 0 && <div className="bad" style={{ fontSize: 12 }}>{priced.errors.join('; ')}</div>}
        </>
      )}
    </div>
  );
}

function ButtonForm({ row, scope, setup, icons, onCancel, onDone }) {
  const [f, setF] = useState({ label: row.label || '', kind: row.kind, target: row.kind === 'bundle' ? String(row.bundle_id ?? row.target ?? '') : row.target || '', mode: row.mode || 'plan', surfaces: row.surfaces || '', alias: row.alias || '', color: row.color || '#2563eb', icon: row.icon || '', button: row.button !== 0 });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const draft = { ...f, id: row.id || -1, bundle_id: f.kind === 'bundle' ? Number(f.target) : null, alias: f.alias || null, active: 1 };
  const bundles = setup.bundles.filter((b) => scope === 'mine' || b.user_id == null);
  const example = f.kind === 'bundle' && bundles.find((b) => String(b.id) === f.target)?.items.some((it) => it.tooth === 'ends') ? '3-5' : '14';
  const save = async () => {
    setErr(null);
    try {
      const body = { ...f, scope, alias: f.alias || null, surfaces: f.surfaces || null, icon: f.icon || null, ...(f.kind === 'bundle' ? { bundle_id: Number(f.target) } : {}) };
      if (row.id) await api.put(`/chart-shortcuts/${row.id}`, body);
      else await api.post('/chart-shortcuts', body);
      onDone();
    } catch (e) { setErr(e); }
  };
  return (
    <form className="te-form" onSubmit={(e) => { e.preventDefault(); save(); }} style={{ marginTop: 12 }}>
      <ErrorBox error={err} />
      <div className="form-grid">
        <label>Label<input value={f.label} onChange={set('label')} maxLength={30} autoFocus /></label>
        <label>Charts
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, target: '', mode: e.target.value === 'finding' ? 'existing' : 'plan' })}>
            <option value="bundle">a bundle</option><option value="code">a code</option><option value="work">a kind of work</option><option value="finding">a finding</option>
          </select>
        </label>
        {f.kind === 'bundle' && <label>Bundle<select value={f.target} onChange={set('target')}><option value="">Choose…</option>{bundles.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
        {f.kind === 'code' && <label>Code<input value={f.target} onChange={set('target')} placeholder="D2950" /></label>}
        {f.kind === 'work' && <label>Work<select value={f.target} onChange={set('target')}><option value="">Choose…</option>{WORK_KINDS.map((w) => <option key={w} value={w}>{nice(w)}</option>)}</select></label>}
        {f.kind === 'finding' && <label>Finding<select value={f.target} onChange={set('target')}><option value="">Choose…</option>{FINDING_KINDS.map((w) => <option key={w} value={w}>{nice(w)}</option>)}</select></label>}
        {f.kind !== 'finding' && <label>As<select value={f.mode} onChange={set('mode')}>{MODES.filter(([m]) => m !== 'existing' || f.kind === 'work').map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select></label>}
        {['code', 'work', 'finding'].includes(f.kind) && <label>Surfaces<input value={f.surfaces} onChange={set('surfaces')} placeholder="optional, e.g. MO" maxLength={5} /></label>}
        <label>Alias (typed or said)<input value={f.alias} onChange={set('alias')} placeholder="optional, e.g. bu" maxLength={12} /></label>
        <label>Color<input type="color" value={f.color} onChange={set('color')} /></label>
        <label>Icon<select value={f.icon} onChange={set('icon')}><option value="">None</option>{(icons || Object.keys(ICONS)).map((i) => <option key={i} value={i}>{i}</option>)}</select></label>
        <label className="inline"><input type="checkbox" checked={f.button} onChange={set('button')} /> Show as a button on the chart</label>
      </div>
      <LivePreview text={shortcutText(draft, setup.bundles)} setup={setup} extra={{ shortcuts: [draft] }} example={example} />
      <div className="form-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary">Save</button></div>
    </form>
  );
}

function BundleForm({ row, scope, setup, onCancel, onDone }) {
  const [f, setF] = useState({ name: row.name || '', alias: row.alias || '', items: row.items.map((it) => ({ kind: it.code ? 'code' : it.work ? 'work' : 'finding', value: it.code || it.work || it.finding, ...it })) });
  const [example, setExample] = useState(row.items.some((it) => it.tooth === 'ends') ? '3-5' : '14');
  const [err, setErr] = useState(null);
  const items = f.items.map(({ kind, value, ...it }) => ({ ...it, code: undefined, work: undefined, finding: undefined, [kind]: kind === 'code' ? String(value || '').toUpperCase() : value }));
  let checked = null;
  let problem = null;
  try { checked = checkBundle({ name: f.name || 'Untitled', alias: f.alias, items }); } catch (e) { problem = e.message; }
  let chips = null;
  if (checked) {
    try {
      const teeth = /^\d+-\d+$/.test(example) ? (() => { const [a, b] = example.split('-').map(Number); const s = a <= b ? 1 : -1; const o = []; for (let n = a; n !== b + s; n += s) o.push(String(n)); return o; })() : example.split(/[\s,]+/).filter(Boolean);
      chips = expandBundle({ ...checked, name: checked.name }, { teeth: checked.items.some((it) => (it.tooth || 'same') !== 'none' && !it.area) ? teeth : [] }).map(describe);
    } catch (e) { problem = e.message; }
  }
  const setItem = (i, patch) => setF({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const save = async () => {
    setErr(null);
    try {
      const body = { scope, name: f.name, alias: f.alias || null, items: checked?.items || items };
      if (row.id) await api.put(`/procedure-bundles/${row.id}`, body);
      else await api.post('/procedure-bundles', body);
      onDone();
    } catch (e) { setErr(e); }
  };
  return (
    <form className="te-form" onSubmit={(e) => { e.preventDefault(); save(); }} style={{ marginTop: 12 }}>
      <ErrorBox error={err} />
      <div className="form-grid">
        <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} autoFocus /></label>
        <label>Alias (typed or said)<input value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} placeholder="e.g. crb" maxLength={12} /></label>
      </div>
      <div className="te-items">
        <div className="te-item muted" style={{ fontSize: 12 }}><span>Code / work</span><span>On</span><span>Surfaces</span><span>Phase</span><span>Optional</span><span>On by default</span><span /></div>
        {f.items.map((it, i) => {
          const area = it.kind === 'code' ? areaKind(String(it.value || '').toUpperCase()) : null;
          return (
            <div key={i} className="te-item">
              <span className="inline" style={{ gap: 4 }}>
                <select value={it.kind} aria-label={`Item ${i + 1} kind`} onChange={(e) => setItem(i, { kind: e.target.value, value: '' })} style={{ width: 'auto' }}><option value="code">Code</option><option value="work">Work</option><option value="finding">Finding</option></select>
                {it.kind === 'code' ? <input value={it.value || ''} aria-label={`Item ${i + 1} code`} onChange={(e) => setItem(i, { value: e.target.value })} placeholder="D2950" style={{ width: 80 }} />
                  : <select value={it.value || ''} aria-label={`Item ${i + 1}`} onChange={(e) => setItem(i, { value: e.target.value })}><option value="">Choose…</option>{(it.kind === 'work' ? WORK_KINDS : FINDING_KINDS).map((w) => <option key={w} value={w}>{nice(w)}</option>)}</select>}
              </span>
              {area ? (
                <select value={it.area || ''} aria-label={`Item ${i + 1} ${area}`} onChange={(e) => setItem(i, { area: e.target.value || null, tooth: 'none' })}><option value="">{area}…</option>{(area === 'arch' ? ARCHES : QUADRANTS).map((a) => <option key={a} value={a}>{a}</option>)}</select>
              ) : (
                <select value={it.tooth || 'same'} aria-label={`Item ${i + 1} tooth`} onChange={(e) => setItem(i, { tooth: e.target.value, area: null })}>{TOOTH_RULES.map((t) => <option key={t} value={t}>{TOOTH_RULE_LABELS[t]}</option>)}</select>
              )}
              <input value={it.surfaces || ''} aria-label={`Item ${i + 1} surfaces`} onChange={(e) => setItem(i, { surfaces: e.target.value })} placeholder="none / same / MO" />
              <input type="number" min={1} max={9} value={it.phase || 1} aria-label={`Item ${i + 1} phase`} onChange={(e) => setItem(i, { phase: Number(e.target.value) })} />
              <input type="checkbox" checked={!!it.optional} aria-label={`Item ${i + 1} optional`} onChange={(e) => setItem(i, { optional: e.target.checked })} />
              <input type="checkbox" checked={!!it.default_on} disabled={!it.optional} aria-label={`Item ${i + 1} on by default`} onChange={(e) => setItem(i, { default_on: e.target.checked })} />
              <button type="button" className="small" onClick={() => setF({ ...f, items: f.items.filter((_, j) => j !== i) })} aria-label={`Remove item ${i + 1}`}>×</button>
            </div>
          );
        })}
        <div><button type="button" className="small" onClick={() => setF({ ...f, items: [...f.items, { kind: 'code', value: '', tooth: 'same' }] })}><Plus size={12} aria-hidden /> Item</button></div>
      </div>
      <div className="te-preview" role="status">
        <label className="inline" style={{ fontSize: 13 }}>Try it on <input value={example} onChange={(e) => setExample(e.target.value)} style={{ width: 70 }} aria-label="Example teeth" /></label>{' '}
        {problem ? <span className="bad">{problem}</span> : chips?.map((c, i) => <span key={i} className="chip">{c}</span>)}
        {checked && !problem && <div className="muted" style={{ fontSize: 12 }}>Typed: “{example} {checked.alias || `${checked.name} bundle`}” · optional parts: “with …” / “no …”</div>}
      </div>
      <div className="form-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" disabled={!!problem}>Save</button></div>
    </form>
  );
}
