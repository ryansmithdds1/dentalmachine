import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLookup } from '../hooks.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox, useSubmit } from './ui.jsx';

// [[Label: a|b|c]] markers left in a note, each answered with a picker.
const PROMPT = /\[\[([^:\]]+):\s*([^\]]*)\]\]/g;
export const notePrompts = (body) => [...body.matchAll(PROMPT)].map((m) => ({ token: m[0], label: m[1].trim(), options: m[2].split('|').map((o) => o.trim()) }));

// Writes a clinical note, optionally from the practice's templates for the given procedures.
export default function NoteComposer({ patient, procedureIds = [], providerId: initialProvider, onSaved, autoDraft = false }) {
  const { can } = useAuth();
  const templates = useLookup('/note-templates');
  const providers = useLookup('/providers?active=true');
  const [body, setBody] = useState('');
  const [providerId, setProviderId] = useState(initialProvider ? String(initialProvider) : '');
  const [signNow, setSignNow] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const ids = procedureIds.join(',');

  const draft = async (templateId) => {
    setLoadErr(null);
    try {
      const q = new URLSearchParams({ ...(ids ? { procedure_ids: ids } : {}), ...(templateId ? { template_id: templateId } : {}) });
      const d = await api.get(`/patients/${patient.id}/note-draft?${q}`);
      if (!d.body) return;
      setBody((cur) => (cur.trim() ? `${cur.trim()}\n\n${d.body}` : d.body));
      if (d.provider_id && !providerId) setProviderId(String(d.provider_id));
    } catch (e) {
      setLoadErr(e);
    }
  };
  // Completing procedures opens the composer already drafted from the matching templates.
  useEffect(() => {
    if (autoDraft && ids) draft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDraft, ids]);

  const prompts = notePrompts(body);
  const answer = (token, value) => setBody(body.replace(token, value));

  const { submit, busy, error } = useSubmit(async () => {
    if (prompts.length && !window.confirm(`${prompts.length} template question${prompts.length > 1 ? 's are' : ' is'} still unanswered. Save anyway?`)) return;
    const note = await api.post(`/patients/${patient.id}/notes`, { body, provider_id: providerId ? Number(providerId) : null });
    // The note is saved even if signing is refused (e.g. it's another provider's): clear the draft first
    // so a retry can't save it twice.
    setBody('');
    if (signNow) {
      await api.post(`/notes/${note.id}/sign`).catch((e) => {
        onSaved?.(note);
        throw new Error(`Note saved but not signed: ${e.message}`);
      });
    }
    onSaved?.(note);
  });

  return (
    <div>
      <ErrorBox error={error || loadErr} />
      <div className="inline" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
        <select value="" onChange={(e) => e.target.value && draft(e.target.value)} style={{ maxWidth: 240 }} aria-label="Insert a template">
          <option value="">Insert template…</option>
          {templates.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {ids && <button type="button" className="small" onClick={() => draft()}>Draft from procedures</button>}
      </div>
      {prompts.length > 0 && (
        <div className="public-notice" style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>Answer the template questions:</div>
          {prompts.map((p, i) => (
            <label key={`${p.token}-${i}`} className="note-prompt">
              {p.label}
              <select value="" onChange={(e) => e.target.value && answer(p.token, e.target.value)}>
                <option value="">Choose…</option>
                {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Clinical note…" />
      <div className="form-grid" style={{ marginTop: 10 }}>
        <label>
          Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">—</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {can('clinical:sign') && <label className="checkbox" style={{ alignSelf: 'end' }}><input type="checkbox" checked={signNow} onChange={(e) => setSignNow(e.target.checked)} /> Sign now</label>}
      </div>
      <div className="form-actions">
        <button className="primary" disabled={busy || !body.trim()} onClick={submit}>Save note</button>
      </div>
    </div>
  );
}
