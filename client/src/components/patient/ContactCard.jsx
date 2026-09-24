import { useEffect, useRef, useState } from 'react';
import { useShortcuts } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import { saveContact, addressLine, CONTACT_FIELDS } from './contactUpdate.js';

// The chart's contact details, each one changed where it's shown (workflow 27): click it (or press E for the
// mobile number, Shift+A for the address), type, Enter saves — at once, with Undo on the note. Esc leaves it as it was;
// Tab saves and goes on to the next one. No window to open, nothing else to fill in.
// The address is one line ("12 Oak St, Round Rock, TX 78664") and moves the household that lived at the old one.
const ROWS = [
  ['phone', 'Mobile'], ['phone_home', 'Home'], ['phone_work', 'Work'], ['email', 'Email'], ['address', 'Address'], ['emergency_contact', 'Emergency contact'],
];
const shown = (p, field) => (field === 'address' ? addressLine(p) : p[field] || '');

export default function ContactCard({ p, canEdit, extra = null }) {
  const [editing, setEditing] = useState(null);
  const [pending, setPending] = useState({}); // field → the value being saved (shown straight away)
  const rows = ROWS.filter(([f]) => canEdit || p[f] || ['phone', 'email', 'address'].includes(f));
  useEffect(() => setPending({}), [p]);
  useShortcuts([
    { combo: 'e', handler: () => setEditing('phone'), label: 'Change the mobile number (then Tab to the next detail)', section: 'Contact', enabled: canEdit && !editing },
    { combo: 'shift+a', handler: () => setEditing('address'), label: 'Change the address (moves the household too)', section: 'Contact', enabled: canEdit && !editing },
  ]);
  const save = async (field, value, then = null) => {
    setEditing(then);
    if (value.trim() === shown(p, field).trim()) return;
    setPending((x) => ({ ...x, [field]: value }));
    try {
      await saveContact(p, field, value);
    } catch (e) {
      toast(`Not saved: ${e.message}`, { tone: 'error' });
      setPending((x) => { const n = { ...x }; delete n[field]; return n; });
      setEditing(field);
    }
  };
  return (
    <dl className="kv contact-card">
      {rows.map(([field, text], i) => (
        <Row key={field} field={field} text={text} value={pending[field] ?? shown(p, field)} editing={editing === field} canEdit={canEdit}
          onEdit={() => setEditing(field)} onCancel={() => setEditing(null)}
          onSave={(v, next) => save(field, v, next ? rows[i + 1]?.[0] ?? null : null)}
          badge={field === 'phone' && p.sms_bad_at ? <span className="badge warn" style={{ marginLeft: 6 }} title="Reminders go by email until the number is changed">{p.sms_bad_reason || 'Can’t get texts'}</span>
            : field === 'email' && p.email_bad_at ? <span className="badge warn" style={{ marginLeft: 6 }} title="Reminders go by text until the address is changed">Bounced</span> : null} />
      ))}
      {extra}
    </dl>
  );
}

function Row({ field, text, value, editing, canEdit, onEdit, onCancel, onSave, badge }) {
  const input = useRef(null);
  const settled = useRef(false); // Enter, Tab or Esc already decided: the blur that follows does nothing
  const [draft, setDraft] = useState(value);
  const finish = (fn) => { if (settled.current) return; settled.current = true; fn(); };
  useEffect(() => {
    if (!editing) return;
    settled.current = false;
    setDraft(value);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const hint = field === 'address' ? '12 Oak St, Round Rock, TX 78664' : field.startsWith('phone') ? '(512) 555-0142' : '';
  return (
    <>
      <dt>{text}</dt>
      <dd>
        {editing ? (
          <input ref={input} aria-label={`${text} (${CONTACT_FIELDS[field]})`} value={draft} placeholder={hint}
            type={field === 'email' ? 'email' : field.startsWith('phone') ? 'tel' : 'text'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); finish(() => onSave(draft, false)); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(onCancel); }
              else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); finish(() => onSave(draft, true)); }
            }}
            // Clicking elsewhere keeps what was typed (saved, with Undo) rather than losing it.
            onBlur={() => finish(() => onSave(draft, false))} />
        ) : canEdit ? (
          <button type="button" className="med-value" aria-label={`Change ${CONTACT_FIELDS[field]}${value ? ` (${value})` : ''}`} title="Click to change" onClick={onEdit}>{value || '—'}</button>
        ) : (value || '—')}
        {!editing && badge}
      </dd>
    </>
  );
}
