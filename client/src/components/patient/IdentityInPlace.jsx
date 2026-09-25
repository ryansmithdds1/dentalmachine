import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { toast } from '../../toast.js';

// The name and birth date on the chart header are corrected where they're shown (batch 2A, A143): click, fix the
// spelling, Enter — saved at once with Undo (the chart's history keeps the before and after). Esc leaves it.
const refresh = () => window.dispatchEvent(new Event('dm:refresh'));

async function saveWithUndo(p, changes, what) {
  const before = Object.fromEntries(Object.keys(changes).map((k) => [k, p[k] ?? null]));
  await api.put(`/patients/${p.id}`, changes);
  refresh();
  toast(what, {
    undo: async () => {
      try { await api.put(`/patients/${p.id}`, before); toast('Undone'); } catch (e) { toast(`Couldn’t undo: ${e.message}`, { tone: 'error' }); }
      refresh();
    },
  });
}

export function NameInPlace({ p, canEdit, children, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ first_name: p.first_name, last_name: p.last_name });
  const [err, setErr] = useState(null);
  const first = useRef(null);
  useEffect(() => { if (editing) { setF({ first_name: p.first_name, last_name: p.last_name }); requestAnimationFrame(() => { first.current?.focus(); first.current?.select(); }); } }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!canEdit) return children;
  if (!editing) return <button type="button" className="name-in-place" title="Click to correct the name" aria-label={`Correct the name (${p.first_name} ${p.last_name})`} onClick={() => setEditing(true)}>{children}</button>;
  const save = async (e) => {
    e.preventDefault();
    const next = { first_name: f.first_name.trim(), last_name: f.last_name.trim() };
    if (!next.first_name || !next.last_name) { setErr('Type a first and last name'); return; }
    setEditing(false);
    if (next.first_name === p.first_name && next.last_name === p.last_name) return;
    try { await saveWithUndo(p, next, `Name corrected to ${next.first_name} ${next.last_name}`); onSaved?.(); } catch (x) { toast(`Not saved: ${x.message}`, { tone: 'error' }); setEditing(true); }
  };
  return (
    <form className="identity-edit" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); } }}>
      <input ref={first} aria-label="First name" value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} />
      <input aria-label="Last name" value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} />
      <button className="small primary">Save</button>
      <button type="button" className="small" onClick={() => setEditing(false)}>Cancel</button>
      {err && <span className="error" style={{ margin: 0 }}>{err}</span>}
    </form>
  );
}

export function DobInPlace({ p, canEdit, children, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(p.dob || '');
  const box = useRef(null);
  useEffect(() => { if (editing) { setV(p.dob || ''); requestAnimationFrame(() => box.current?.focus()); } }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!canEdit) return children;
  if (!editing) return <button type="button" className="link name-in-place-dob" title="Click to correct the birth date" onClick={() => setEditing(true)}>{children}</button>;
  const save = async (e) => {
    e.preventDefault();
    setEditing(false);
    if ((v || null) === (p.dob || null)) return;
    try { await saveWithUndo(p, { dob: v || null }, `Birth date corrected to ${v}`); onSaved?.(); } catch (x) { toast(`Not saved: ${x.message}`, { tone: 'error' }); setEditing(true); }
  };
  return (
    <form className="identity-edit inline-form" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); } }}>
      <input ref={box} type="date" aria-label="Birth date" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="small primary">Save</button>
      <button type="button" className="small" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
}
