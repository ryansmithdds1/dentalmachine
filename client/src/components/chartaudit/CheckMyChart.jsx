import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Check, Wand2, ArrowRight, Sparkles } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useShortcuts } from '../../shortcuts.js';
import { toast } from '../../toast.js';
import { fmtDateTime } from '../../format.js';
import { ErrorBox } from '../ui.jsx';
import './checkmychart.css';

// "Check my chart" (CA4): the assistant's pass over a visit before the doctor sees it. Runs every chart-audit
// check on the visit plus spelling, template questions and the note's link; each problem has a one-click fix
// (through the normal note update — only an unsigned note, and only the author's) or a jump to where it's fixed.
// When nothing is left (or each remaining item has a reason), "Ready for doctor" records who prepared it.
// Alt+K runs the check (on the one instance given `shortcut`).
const TAB_FOR = { write_note: 'notes', sign: 'notes', jump: 'notes', addendum: 'notes', consent: 'comms', medical: 'overview', vitals: 'chart', perio: 'perio', chart: 'chart' };

export default function CheckMyChart({ patientId, visitKey, autoOpen = false, onChanged, compact = false, shortcut = true }) {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reasons, setReasons] = useState({});
  const [open, setOpen] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    setOpen(true);
    try {
      setResult(await api.post(`/chart-audit/visits/${visitKey}/check`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (autoOpen) run(); }, [autoOpen, visitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useShortcuts([{ combo: 'alt+k', label: 'Check my chart', handler: run, enabled: shortcut && can('clinical:write') }]);
  if (!can('clinical:write')) return null;

  const note = result?.note;
  const canEdit = note && !note.signed && (note.author_id === user.id || user.role === 'admin');
  const keyOf = (i) => `${i.check}|${i.subject}`;

  // A fix changes the note through the normal update (audited as this person's edit), then checks again.
  const saveBody = async (body) => {
    await api.put(`/notes/${note.id}`, { body });
    onChanged?.();
  };
  const apply = async (item, choice) => {
    const f = item.fix;
    setBusy(true);
    setError(null);
    try {
      if (f.type === 'replace_text') await saveBody(note.body.split(f.find).join(f.replace));
      else if (f.type === 'choose') await saveBody(note.body.replace(f.find, choice));
      else if (f.type === 'append_text') await saveBody(`${note.body.trimEnd()}\n${f.text}`);
      else if (f.type === 'link_note') { await api.put(`/notes/${f.note_id}`, { appointment_id: f.appointment_id }); onChanged?.(); }
      toast('Fixed');
      setResult(await api.post(`/chart-audit/visits/${visitKey}/check`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const jump = (item) => navigate(`/patients/${patientId}?tab=${TAB_FOR[item.fix?.type] || 'notes'}${visitKey.startsWith('a') ? `&visit=${visitKey.slice(1)}` : ''}`);

  const ready = async () => {
    setBusy(true);
    setError(null);
    try {
      const acknowledged = result.items.map((i) => ({ check: i.check, subject: i.subject, reason: reasons[keyOf(i)] || '' }));
      await api.post(`/chart-audit/visits/${visitKey}/ready`, { acknowledged });
      toast('Marked ready for the doctor');
      setResult(await api.post(`/chart-audit/visits/${visitKey}/check`));
      onChanged?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const fixable = (i) => canEdit && ['replace_text', 'append_text', 'choose', 'link_note'].includes(i.fix?.type);
  const allExplained = result && result.items.every((i) => (reasons[keyOf(i)] || '').trim().length >= 3);

  return (
    <div className={`cmc ${compact ? 'cmc-compact' : ''}`}>
      <div className="cmc-bar">
        <button className="small" onClick={run} disabled={busy} title="Check this visit’s chart before the doctor reviews it (Alt+K)">
          <ShieldCheck size={14} /> {busy && !result ? 'Checking…' : result ? 'Check again' : 'Check my chart'}
        </button>
        {result?.ready && <span className="cmc-ready"><Check size={13} /> Ready for doctor · {result.ready.prepared_by_name} · {fmtDateTime(result.ready.ready_at?.replace('T', ' ').slice(0, 16))}</span>}
        {result && open && <button className="link small" onClick={() => setOpen(false)}>Hide</button>}
      </div>
      <ErrorBox error={error} />
      {open && result && (
        <div className="cmc-panel">
          {result.items.length === 0 ? (
            <p className="cmc-clean"><Check size={16} /> Nothing to fix. {result.first_pass ? 'Clean on the first pass.' : ''}</p>
          ) : (
            <p className="muted cmc-lead">{result.items.length} thing{result.items.length === 1 ? '' : 's'} to look at before the doctor reviews this visit. Fix each one, or say why it’s fine.</p>
          )}
          <ul className="cmc-list">
            {result.items.map((i) => (
              <li key={keyOf(i)} className={`cmc-item sev-${i.severity}`}>
                <div className="cmc-title">
                  <strong>{i.title}</strong>
                  {i.source === 'ai' && <span className="cmc-ai" title="Found by the AI reading the note — check it"><Sparkles size={11} /> AI</span>}
                </div>
                {i.detail && <div className="cmc-detail">{i.detail}</div>}
                {i.evidence && <blockquote className="cmc-quote">{i.evidence}</blockquote>}
                {i.why && <div className="cmc-why">{i.why}</div>}
                <div className="cmc-actions">
                  {fixable(i) && i.fix.type === 'choose' && i.fix.options.map((o) => <button key={o} className="small" disabled={busy} onClick={() => apply(i, o)}>{o}</button>)}
                  {fixable(i) && i.fix.type !== 'choose' && (
                    <button className="small primary" disabled={busy} onClick={() => apply(i)}>
                      <Wand2 size={13} /> {i.fix.type === 'replace_text' ? `Change to “${i.fix.replace}”` : i.fix.type === 'link_note' ? 'Link the note' : 'Add to the note'}
                    </button>
                  )}
                  {!fixable(i) && <button className="small" onClick={() => jump(i)}>Go there <ArrowRight size={13} /></button>}
                  <input className="cmc-reason" aria-label="Why it’s fine" placeholder="Or: why it’s fine…" value={reasons[keyOf(i)] || ''} onChange={(e) => setReasons({ ...reasons, [keyOf(i)]: e.target.value })} />
                </div>
              </li>
            ))}
          </ul>
          <div className="cmc-foot">
            <button className="primary small" disabled={busy || (result.items.length > 0 && !allExplained)} onClick={ready} title={result.items.length && !allExplained ? 'Fix each item or say why it’s fine' : ''}>
              <Check size={14} /> Ready for doctor
            </button>
            {!canEdit && note && <span className="muted cmc-note">{note.signed ? 'The note is signed — corrections go in an addendum.' : 'Only the note’s author can apply fixes to it.'}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
