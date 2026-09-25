import { useMemo, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { fmtDate } from '../format.js';
import { toast } from '../toast.js';
import { ErrorBox, AskButton } from './ui.jsx';

// Documents → Staff licences: everyone's licence, CPR card, DEA, radiology permit and CE deadline, with how long is
// left, on one screen (routes/credentials.js). One line adds or renews: "maria cpr 10/30/2027" (a first name, what
// it is, the expiry date; "#12345" for a number) → Enter, with Undo. A to-do goes to the person 60 days before
// (90 for CE), and "due" / "expired" show here first.
const KIND_WORDS = [
  [/^(cpr|bls|acls|pals)$/i, 'cpr'], [/^(licen[cs]e|lic|rdh|dds|dmd|rda|efda)$/i, 'license'], [/^dea$/i, 'dea'],
  [/^(radiology|x-?ray|xray|radiography)$/i, 'radiology'], [/^(ce|ceu|ceus|credits?)$/i, 'ce'],
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
const realDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const fullYear = (y) => (y < 100 ? 2000 + y : y);

// "maria cpr 10/30/2027 #A123" → { user, kind, label, expires_on, number } and what's still missing.
export function parseCredential(text, people) {
  let rest = ` ${String(text || '').trim()} `;
  let expires = null;
  let m = rest.match(/\s(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\s/);
  if (m) { expires = realDate(fullYear(Number(m[3])), Number(m[1]), Number(m[2])); rest = rest.replace(m[0], ' '); }
  if (!m && (m = rest.match(/\s(\d{4})-(\d{2})-(\d{2})\s/))) { expires = realDate(Number(m[1]), Number(m[2]), Number(m[3])); rest = rest.replace(m[0], ' '); }
  if (!m && (m = rest.match(/\s([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\s/i)) && MONTHS.includes(m[1].toLowerCase())) {
    expires = realDate(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2])); rest = rest.replace(m[0], ' ');
  }
  rest = rest.replace(/\s(exp(ires?)?|until|by)\s/gi, ' ');
  let number = null;
  if ((m = rest.match(/\s#\s?([\w-]+)\s/))) { number = m[1]; rest = rest.replace(m[0], ' '); }
  const words = rest.trim().split(/\s+/).filter(Boolean);
  // The person: a full name, or a first name only one person has.
  let user = null;
  const low = words.map((w) => w.toLowerCase());
  for (const p of people) {
    const parts = p.name.toLowerCase().replace(/^(dr\.?)\s+/, '').split(/\s+/);
    if (low.length >= 2 && low[0] === parts[0] && low[1] === parts[parts.length - 1]) { user = p; words.splice(0, 2); break; }
  }
  if (!user && words.length) {
    const first = low[0];
    const hits = people.filter((p) => p.name.toLowerCase().replace(/^(dr\.?)\s+/, '').split(/\s+/)[0] === first);
    if (hits.length === 1) { user = hits[0]; words.splice(0, 1); } else if (hits.length > 1) return { ambiguous: hits.map((p) => p.name) };
  }
  let kind = null;
  const i = words.findIndex((w) => KIND_WORDS.some(([re]) => re.test(w)));
  if (i >= 0) { kind = KIND_WORDS.find(([re]) => re.test(words[i]))[1]; words.splice(i, 1); }
  const label = words.join(' ').trim() || null;
  if (!kind && label) kind = 'other';
  return { user, kind, label: kind === 'other' || label ? label : null, expires_on: expires, number };
}

export default function StaffCredentials() {
  const { can } = useAuth();
  const { data, error, reload } = useApi('/staff-credentials');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const people = useMemo(() => (data?.people || []).map((p) => ({ id: p.user_id, name: p.name })), [data]);
  const parsed = useMemo(() => parseCredential(text, people), [text, people]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="card muted">Loading…</div>;
  const kinds = data.kinds;
  const missing = parsed.ambiguous ? `Which one? ${parsed.ambiguous.join(' or ')} — type the last name too` : !parsed.user ? 'Who? Start with their first name' : !parsed.kind ? 'What is it? cpr, licence, dea, radiology, ce — or its name' : !parsed.expires_on ? 'When does it expire? e.g. 10/30/2027' : null;

  const add = async () => {
    if (missing || busy) return;
    setBusy(true);
    try {
      const out = await api.post('/staff-credentials', { user_id: parsed.user.id, kind: parsed.kind, label: parsed.kind === 'other' ? parsed.label : parsed.label || null, number: parsed.number, expires_on: parsed.expires_on, client_key: `cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
      setText('');
      reload();
      const c = out.credential;
      toast(`${out.replaced ? 'Renewed' : 'Added'}: ${out.person}’s ${c.name}, expires ${fmtDate(c.expires_on)}${c.reminder_task_id ? ' — a to-do went to them now (it’s due soon)' : ` — a to-do goes to them ${c.remind_days} days before`}`, {
        undo: async () => { try { await api.post(`/staff-credentials/${c.id}/undo`, {}); toast('Undone'); } catch (e) { toast(`Couldn’t undo: ${e.message}`, { tone: 'error' }); } reload(); },
      });
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card staff-creds">
      <h2 style={{ marginTop: 0 }}><BadgeCheck size={18} aria-hidden /> Staff licences, CPR and CE</h2>
      {can('officedocs:write') && (
        <div className="cred-add">
          <input
            autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="Add or renew a licence"
            placeholder="Name, what it is, expiry — e.g. maria cpr 10/30/2027" disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') setText(''); }}
          />
          <div className={`cred-preview muted${missing && text ? ' warn' : ''}`} aria-live="polite">
            {!text ? 'Type a first name, what it is and when it expires, then Enter. The same thing again for the same person is a renewal.'
              : missing || `${parsed.user.name} · ${parsed.kind === 'other' ? parsed.label : kinds[parsed.kind]}${parsed.number ? ` #${parsed.number}` : ''} · expires ${fmtDate(parsed.expires_on)} — Enter adds it`}
          </div>
        </div>
      )}
      <table className="compact-table cred-table">
        <thead><tr><th>Person</th><th>On file</th></tr></thead>
        <tbody>
          {data.people.map((p) => (
            <tr key={p.user_id}>
              <td>{p.name}<div className="muted" style={{ fontSize: 12 }}>{p.role.replace(/_/g, ' ')}</div></td>
              <td>
                {!p.credentials.length && <span className="muted">Nothing on file</span>}
                <div className="cred-chips">
                  {p.credentials.map((c) => (
                    <span key={c.id} className={`cred-chip ${c.state}`} title={`${c.kind_label}${c.number ? ` #${c.number}` : ''} · reminder ${c.remind_days} days before`}>
                      <strong>{c.name}</strong> {c.state === 'expired' ? `expired ${fmtDate(c.expires_on)}` : `${fmtDate(c.expires_on)}${c.state === 'due' ? ` · ${c.days_left} days left` : ''}`}
                      {can('officedocs:write') && <AskButton className="link small" label="Why is it no longer needed?" placeholder="e.g. no longer takes x-rays" required submit="Archive" title={`Archive ${p.name}’s ${c.name} (kept in the history)`} onSubmit={async (why) => { await api.post(`/staff-credentials/${c.id}/archive`, { reason: why }); toast(`Archived ${p.name}’s ${c.name}`); reload(); }}>Archive</AskButton>}
                    </span>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
