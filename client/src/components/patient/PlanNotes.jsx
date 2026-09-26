import { useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { money, fmtDate, fmtDateTime, practiceToday } from '../../format.js';
import { ErrorBox, useSubmit } from '../ui.jsx';
import { toast } from '../../toast.js';
import { MessageSquareText, CalendarClock, Lock } from 'lucide-react';
import './treatment.css';

// Where a plan stands, for everyone at a glance (planprogress.js on the server works it out: accepted = signed,
// scheduled = its work is on a visit, in progress, completed, paid = the ledger says so), with the office's own
// notes on it — "going home to discuss" — and a follow-up date that becomes a task. Staff-only: the patient's page,
// the portal, the printout and the PDF never show these notes. Notes are never edited; a correction is a new note.
export const STAGE_TONE = {
  proposed: 'muted', presented: 'info', thinking: 'warn', accepted: 'ok', scheduled: 'ok', in_progress: 'info', completed: 'warn', paid: 'ok', declined: 'danger', expired: 'muted',
};
export const TAGS = [
  ['discuss', 'Going home to discuss'], ['insurance', 'Waiting on insurance / pre-auth'], ['financing', 'Wants financing options'],
  ['call_back', 'Will call back'], ['price', 'Price concern'], ['second_opinion', 'Second opinion'],
];

const THINKING_TAGS = ['discuss', 'price', 'second_opinion', 'financing'];
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

export function StageBadge({ progress, className = '' }) {
  if (!progress) return null;
  return (
    <span className={`plan-stage tone-${STAGE_TONE[progress.stage] || 'muted'} ${className}`} data-stage={progress.stage} title="Where this plan stands">
      <i aria-hidden="true" />{progress.label}{progress.detail ? <small> · {progress.detail}</small> : null}
    </span>
  );
}

// Paid in full / Balance $X, once some of the plan's work is done (from the ledger).
export function PlanMoneyChip({ progress }) {
  if (progress?.balance == null) return null;
  return progress.balance > 0
    ? <span className="plan-balance owed" title="What the patient still owes on this plan's finished work (from the ledger)">Balance {money(progress.balance)}</span>
    : <span className="plan-balance paid" title="Everything done on this plan is paid (from the ledger)">Paid in full</span>;
}

export default function PlanNotes({ plan, onChange }) {
  const { can, practice } = useAuth();
  const canWrite = can('patients:write');
  const notes = plan.staff_notes || [];
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState(null);
  const [text, setText] = useState('');
  const [date, setDate] = useState('');
  const [thinking, setThinking] = useState(false);
  const [fixing, setFixing] = useState(null);
  const stage = plan.progress?.stage;
  const reset = () => { setTag(null); setText(''); setDate(''); setThinking(false); setFixing(null); };
  const { submit, busy, error } = useSubmit(async (extra = {}) => {
    const out = await api.post(`/treatment-plans/${plan.id}/notes`, {
      tag: tag || undefined, text: text.trim() || undefined, follow_up_date: date || undefined, corrects_id: fixing?.id, stage: thinking ? 'thinking' : undefined, ...extra,
    });
    toast(`Note saved${out.follow_up ? ` · follow up ${fmtDate(out.follow_up.date)}` : ''} · ${out.progress.label}`);
    reset();
    onChange?.();
  });
  // Smart defaults: a patient going away to think (discuss, price, second opinion, financing) is "thinking it over",
  // and gets a follow-up a week out — both shown, and easy to change before saving.
  const pickTag = (k) => {
    setTag(k);
    if (!THINKING_TAGS.includes(k)) return;
    if (['proposed', 'presented', 'expired'].includes(stage)) setThinking(true);
    if (!date && !plan.follow_up) setDate(addDays(practiceToday(practice?.timezone), 7));
  };
  const latest = notes.find((n) => !n.corrected_by);
  const ready = !!(tag || text.trim() || date || thinking);
  const keys = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready && !busy) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); reset(); }
  };
  return (
    <div className="plan-notes" data-plan-notes={plan.id}>
      <div className="plan-notes-bar">
        <button type="button" className="plan-notes-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title="The office's own notes on this plan — never shown to the patient or printed">
          <MessageSquareText size={15} aria-hidden="true" /> {notes.length ? `Notes (${notes.length})` : 'Add a note'}
        </button>
        {latest && <span className="plan-notes-latest" title={`${latest.created_by_name || 'Someone'}, ${fmtDateTime(latest.created_at)}`}>“{latest.note}” <span className="muted">— {latest.created_by_name?.split(' ')[0] || 'staff'}, {fmtDate(latest.created_at.slice(0, 10))}</span></span>}
        {plan.follow_up && <span className="plan-followup" title="The follow-up task for this plan"><CalendarClock size={14} aria-hidden="true" /> Follow up {fmtDate(plan.follow_up.date)}</span>}
      </div>
      {open && (
        <div className="plan-notes-panel" onKeyDown={keys}>
          <div className="muted plan-notes-private"><Lock size={12} aria-hidden="true" /> Staff only — never on the patient’s screen, printout or PDF.</div>
          {canWrite && (
            <div className="plan-notes-form">
              <ErrorBox error={error} />
              {fixing && <div className="plan-notes-fixing">Correcting: “{fixing.note}” <button type="button" className="link" onClick={() => setFixing(null)}>Cancel</button></div>}
              <div className="chips" role="group" aria-label="Quick notes">
                {TAGS.map(([k, l]) => <button key={k} type="button" className={`chip${tag === k ? ' active' : ''}`} aria-pressed={tag === k} onClick={() => pickTag(tag === k ? null : k)}>{l}</button>)}
              </div>
              <div className="plan-notes-row">
                <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={tag ? 'Anything to add (optional)' : 'Note — e.g. “Going home to talk it over with her husband”'} aria-label="Note" autoFocus={!fixing} />
                <label className="plan-notes-date">Follow up<input type="date" value={date} min={practiceToday(practice?.timezone)} onChange={(e) => setDate(e.target.value)} aria-label="Follow-up date (makes a task)" /></label>
              </div>
              <div className="plan-notes-actions">
                {['proposed', 'presented', 'expired'].includes(stage) && (
                  <label className="checkbox"><input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} /> Mark “Thinking it over”</label>
                )}
                <button type="button" className="primary small" disabled={!ready || busy} onClick={() => submit()}>Save note <kbd>⌘↵</kbd></button>
                {stage === 'thinking' && <button type="button" className="small" disabled={busy} onClick={() => submit({ stage: 'reopen', text: text.trim() || 'No longer thinking it over' })}>Not thinking it over</button>}
                {can('clinical:write') && !['declined', 'paid', 'completed', 'in_progress'].includes(stage) && (
                  <button type="button" className="small danger" disabled={busy || !(tag || text.trim())} title="Declined, with the note as the reason" onClick={() => submit({ stage: 'declined' })}>Declined</button>
                )}
                {can('clinical:write') && stage === 'declined' && <button type="button" className="small" disabled={busy} onClick={() => submit({ stage: 'reopen', text: text.trim() || 'Reopened' })}>Reopen</button>}
              </div>
            </div>
          )}
          {notes.length > 0 && (
            <ol className="plan-notes-list">
              {notes.map((n) => (
                <li key={n.id} className={n.corrected_by ? 'corrected' : ''}>
                  <div>{n.tag_label && n.tag_label !== n.note && <span className="badge info">{n.tag_label}</span>} {n.note}</div>
                  <div className="muted plan-notes-meta">
                    {n.created_by_name || 'Someone'} · {fmtDateTime(n.created_at)}{n.plan_stage ? ` · plan: ${n.plan_stage.replace('_', ' ')}` : ''}{n.follow_up_date ? ` · follow up ${fmtDate(n.follow_up_date)}` : ''}
                    {n.corrected_by ? ' · corrected below' : n.corrects_id ? ' · correction' : ''}
                    {canWrite && !n.corrected_by && <> · <button type="button" className="link" onClick={() => { setFixing(n); setText(n.note); }}>Correct</button></>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
