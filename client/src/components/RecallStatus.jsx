import { useState } from 'react';
import { MessageSquare, Mail, Bot, PhoneCall, FileText, Mailbox, CalendarClock } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { toast } from '../toast.js';
import { fmtDate } from '../format.js';
import '../pages/recall.css';

export const CHANNEL_ICONS = { text: MessageSquare, email: Mail, ai_call: Bot, task_call: PhoneCall, letter: FileText, postcard: Mailbox };
export const CHANNEL_NAMES = { text: 'Text', email: 'Email', ai_call: 'AI call', task_call: 'Team call', letter: 'Letter', postcard: 'Postcard' };
const STATE = { sent: 'sent', done: 'done', failed: 'failed', skipped: 'skipped', task: 'call to make', claimed: 'sending', due: 'due now', planned: 'planned' };
const HOLDS = [['deceased', 'Deceased'], ['moved', 'Moved away'], ['no_contact', 'Asked not to be contacted']];

// A patient's recall autopilot at a glance, for the patient page: where they are in the sequence (what went,
// what's next), why it stopped, and a way to stop recall for someone who moved, died or asked not to be
// contacted (and to lift that again). <RecallStatus patientId={id} />
export default function RecallStatus({ patientId }) {
  const { can } = useAuth();
  const { data, error, reload } = useApi(patientId ? `/cadence/patients/${patientId}` : null);
  const [stopping, setStopping] = useState(null);
  const [why, setWhy] = useState('');
  if (error || !data) return null;
  const active = data.enrollments.find((e) => e.status === 'active');
  const last = !active ? data.enrollments[0] : null;
  const holds = data.holds.filter((x) => !x.released_at);

  const hold = async (reason) => {
    if (!reason) return;
    try {
      await api.post(`/cadence/patients/${patientId}/holds`, { reason });
      toast(`Recall stopped: ${HOLDS.find(([k]) => k === reason)?.[1]}.`);
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  const release = async (h) => {
    try {
      await api.post(`/cadence/holds/${h.id}/release`, {});
      toast('Recall reminders can go to them again.');
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };
  const stop = async () => {
    try {
      await api.post(`/cadence/enrollments/${stopping}/stop`, { reason: why.trim() });
      setStopping(null);
      setWhy('');
      toast('Recall reminders stopped for this due date.');
      reload();
    } catch (e) {
      toast(e.message, { tone: 'error' });
    }
  };

  return (
    <div className="rcs">
      <div className="rcs-head">
        <span className="rcs-title"><CalendarClock size={16} /> Recall autopilot</span>
        {active && <span className="rcs-sub">{active.sequence_name} · due {fmtDate(active.anchor_date)}</span>}
      </div>
      {holds.map((h) => (
        <div className="rcs-hold" key={h.id}>
          Not recalled: {HOLDS.find(([k]) => k === h.reason)?.[1] || h.note || h.reason}{h.note && h.reason !== 'other' ? ` — ${h.note}` : ''}
          {can('patients:write') && <button type="button" onClick={() => release(h)}>Undo</button>}
        </div>
      ))}
      {!holds.length && data.skip_label && !active && <div className="rcs-sub">Not on the autopilot: {data.skip_label.toLowerCase()}.</div>}
      {active && (
        <div className="rcs-steps" aria-label="Recall steps">
          {active.timeline.map((t, i) => {
            const Icon = CHANNEL_ICONS[t.channel || t.step?.channel] || MessageSquare;
            return (
              <span key={i} className={`rc-chip ${t.state}`} title={`${CHANNEL_NAMES[t.channel || t.step?.channel] || ''} · ${STATE[t.state] || t.state}${t.fallback_from ? ` (instead of ${CHANNEL_NAMES[t.fallback_from]})` : ''}${t.outcome ? ` · ${t.outcome.replace(/_/g, ' ')}` : ''}${t.result ? ` · ${t.result}` : ''}`}>
                <Icon size={12} /> {fmtDate(t.due_date)}
              </span>
            );
          })}
        </div>
      )}
      {!active && last && <div className="rcs-sub">Last recall ({fmtDate(last.anchor_date)}): {last.stop_label || (last.status === 'completed' ? 'finished all steps' : last.status)}.</div>}
      {!active && !last && !holds.length && !data.skip_label && <div className="rcs-sub">Nothing due yet — they’ll be reminded automatically when their recall comes near.</div>}
      <div className="rcs-actions">
        {active && can('schedule:write') && stopping !== active.id && <button type="button" className="small" onClick={() => setStopping(active.id)}>Stop reminders</button>}
        {stopping && (
          <span className="inline">
            <input autoFocus value={why} placeholder="Why? (e.g. booking elsewhere)" onChange={(e) => setWhy(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && why.trim()) stop(); if (e.key === 'Escape') setStopping(null); }} />
            <button type="button" className="small" disabled={!why.trim()} onClick={stop}>Stop</button>
          </span>
        )}
        {can('patients:write') && !holds.length && (
          <select value="" onChange={(e) => hold(e.target.value)} aria-label="Don’t recall this patient">
            <option value="">Don’t recall…</option>
            {HOLDS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}
