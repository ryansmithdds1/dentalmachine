import { api } from '../api.js';
import { money } from '../format.js';
import { toast } from '../toast.js';
import { sendClaims, describeResponses } from './ClaimEdi.jsx';

// Workflow 24 (docs/workflows/specs/24-claims.md): one action bills insurance. The claim for the finished work is
// created and, when it passes the checks, sent at once (to the clearinghouse, or as an 837 file without one).
// A claim that fails the checks stays a draft — nothing is lost, it's listed under Billing → Ready to send, and
// the message says what to fix. Pressing it again sends that draft instead of making a second claim.
//
// { policy: { id, carrier_name, priority }, procedureIds, draft: { id } | null, connection } →
//   { claim, sent, response, error }
export async function fileClaim({ policy, procedureIds = [], draft = null, connection }) {
  let claim = null;
  if (procedureIds.length) claim = await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: procedureIds });
  else if (draft) claim = draft;
  else throw new Error('Nothing to bill: every finished procedure is already on a claim');
  try {
    const response = await sendClaims([claim.id], connection);
    return { claim, sent: true, response };
  } catch (error) {
    return { claim, sent: false, error };
  }
}

// What happened, in one toast.
export function toastFiled({ claim, sent, response, error }, { policy, connection, name = '' }) {
  const what = `Claim #${claim.id}${claim.total_fee ? ` (${money(claim.total_fee)})` : ''}${name ? ` for ${name}` : ''}`;
  if (sent) {
    const how = connection?.batch ? `sent to ${policy.carrier_name} through ${connection.name}` : 'saved as an 837 file to upload in your clearinghouse portal';
    toast(`${what} ${how}.${connection?.batch ? describeResponses(response) : ''}`, { ms: 7000 });
  } else {
    toast(`${what} was made but not sent: ${error?.message || 'it needs a look'}. It’s waiting under Billing → Ready to send.`, { tone: 'error', ms: 12000 });
  }
}

// Everything needed to bill one patient's insurance, from any screen (the command bar): the primary policy (the
// secondary claim is drafted by itself once the primary pays — services.js createSecondaryClaim), what's finished
// and unbilled for it, and a draft claim to it that hasn't gone out yet.
export async function billPatient(patientId, name = '') {
  const [policies, connection] = await Promise.all([api.get(`/patients/${patientId}/insurance`), api.get('/clearinghouse').catch(() => null)]);
  const policy = (policies || []).find((p) => p.active);
  if (!policy) {
    toast(`${name || 'This patient'} has no insurance on file — nothing to bill.`, { tone: 'error' });
    return null;
  }
  const [unbilled, drafts] = await Promise.all([
    api.get(`/patients/${patientId}/unclaimed-procedures?patient_insurance_id=${policy.id}`),
    api.get(`/claims?patient_id=${patientId}&status=draft&limit=50`),
  ]);
  const billable = unbilled.filter((p) => p.fee > 0);
  const draft = (drafts || []).find((c) => c.patient_insurance_id === policy.id && c.status === 'draft') || null;
  if (!billable.length && !draft) {
    toast(`Nothing to bill for ${name || 'this patient'}: every finished procedure is already on a claim.`);
    return null;
  }
  const out = await fileClaim({ policy, procedureIds: billable.map((p) => p.id), draft: billable.length ? null : draft, connection });
  toastFiled(out, { policy, connection, name });
  return out;
}
