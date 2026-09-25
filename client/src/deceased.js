import { api } from './api.js';
import { toast } from './toast.js';
import { fmtDateTime } from './format.js';

// "Mark deceased" (chart ⋯ menu, or Deceased under "Don't recall…"): one step on the server (routes/deceased.js)
// makes the chart inactive, stops recall, statements and every message, and cancels future visits. The toast says
// what it did and what is left for a person (a balance, a membership still billing); Undo puts it back.
export function whatItDid(s) {
  const parts = ['chart inactive', 'recall, statements and messages stopped'];
  const n = s.cancelled_visits.length;
  if (n) parts.push(`${n} future visit${n === 1 ? '' : 's'} cancelled (${s.cancelled_visits.map((v) => fmtDateTime(v.start_time)).join(', ')})`);
  const left = s.left_for_you.map((x) => x.text).join('. ');
  return `${s.name} marked deceased: ${parts.join('; ')}.${left ? ` Still for you: ${left}.` : ''}`;
}

export async function undoDeceased(patientId, onChange) {
  try {
    const u = await api.post(`/patients/${patientId}/deceased/undo`, {});
    const back = u.restored_visits.length ? ` ${u.restored_visits.length} visit${u.restored_visits.length === 1 ? '' : 's'} put back.` : '';
    const lost = u.not_restored.length ? ` Rebook: ${u.not_restored.map((v) => `${fmtDateTime(v.start_time)} (${v.why})`).join(', ')}.` : '';
    toast(`No longer marked deceased: the chart is active again.${back}${lost}`, { tone: lost ? 'error' : 'ok', ms: lost ? 12000 : 5000 });
  } catch (e) {
    toast(`Couldn’t undo: ${e.message}`, { tone: 'error' });
  }
  onChange?.();
}

export async function markDeceased(patientId, onChange) {
  try {
    const s = await api.post(`/patients/${patientId}/deceased`, {});
    toast(whatItDid(s), { undo: () => undoDeceased(patientId, onChange), ms: 15000 });
  } catch (e) {
    toast(`Couldn’t mark them deceased: ${e.message}`, { tone: 'error' });
  }
  onChange?.();
}
