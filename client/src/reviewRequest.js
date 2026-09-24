import { api } from './api.js';
import { toast } from './toast.js';

// "Ask for a review" from anywhere (patient bar Alt+R, chart, checkout, command bar "review jane"): one action,
// no dialog. The server picks text or email, respects opt-outs and quiet hours, and won't ask the same patient
// more than once per N months (a second click just returns the first request). See docs/reviews.md.
export async function requestReview(patientId, { source = 'chart', appointmentId = null, name = '' } = {}) {
  const who = name || 'the patient';
  try {
    const r = await api.post(`/patients/${patientId}/review-request`, { source, ...(appointmentId ? { appointment_id: appointmentId } : {}) });
    const how = r.channel === 'email' ? 'emailed' : 'texted';
    if (r.already) toast(`Review request already ${how} to ${who} a moment ago`);
    else if (r.status === 'queued') toast(`Review request for ${who} will go out when sending hours start`);
    else toast(`Review request ${how} to ${who}`);
    return r;
  } catch (e) {
    toast(e.message || 'Couldn’t ask for a review', { tone: 'error', ms: 7000 });
    return null;
  }
}
