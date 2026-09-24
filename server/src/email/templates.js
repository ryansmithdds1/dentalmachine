import { renderEmail } from './layout.js';

// Staff-facing emails in the shared layout. Each returns { subject, html, text }. They carry the least patient
// detail that lets someone act (first name and last initial, never dates of birth, phone numbers or clinical
// detail) and a link into the app, where the rest is behind sign-in. Hook one up with sendStaffEmail().
export const shortName = (p) => (p ? `${String(p.first_name || '').trim()} ${String(p.last_name || '').trim().slice(0, 1)}${p.last_name ? '.' : ''}`.trim() : 'A patient');
const link = (appUrl, path) => `${String(appUrl || '').replace(/\/$/, '')}${path}`;
const footer = (practice) => [`Sent by Dental Machine for ${practice?.name || 'your practice'}.`, 'Patient details are kept inside the app — sign in to see more.'];

export function taskAssignedEmail({ practice, appUrl, task, assignedBy, patient = null }) {
  const subject = `New task for you: ${String(task.title || 'Task').slice(0, 80)}`;
  const { html, text } = renderEmail({
    brand: practice?.name, title: 'A task was assigned to you', preheader: task.title,
    blocks: [
      { type: 'text', text: `${assignedBy || 'Someone on the team'} asked you to: ${task.title}` },
      ...(patient ? [{ type: 'text', text: `About: ${shortName(patient)}`, muted: true }] : []),
      ...(task.due_date ? [{ type: 'text', text: `Due ${task.due_date}`, muted: true }] : []),
      { type: 'button', text: 'Open the task', url: link(appUrl, '/followups') },
    ],
    footer: footer(practice),
  });
  return { subject, html, text };
}

export function labCaseOverdueEmail({ practice, appUrl, labCase, patient, daysLate }) {
  const subject = `Lab case overdue: ${shortName(patient)} (${daysLate} day${daysLate === 1 ? '' : 's'})`;
  const { html, text } = renderEmail({
    brand: practice?.name, title: 'A lab case hasn’t come back', preheader: subject,
    blocks: [
      { type: 'text', text: `${labCase.lab_name || 'The lab'} was due back ${daysLate} day${daysLate === 1 ? '' : 's'} ago for ${shortName(patient)}.` },
      { type: 'text', text: 'Check with the lab before the patient’s next visit, or move the visit.', muted: true },
      { type: 'button', text: 'Open lab cases', url: link(appUrl, '/office') },
    ],
    footer: footer(practice),
  });
  return { subject, html, text };
}

export function claimDeniedEmail({ practice, appUrl, claim, patient, reason = null }) {
  const subject = `Claim #${claim.id} was denied`;
  const { html, text } = renderEmail({
    brand: practice?.name, title: 'An insurance claim was denied', preheader: subject,
    blocks: [
      { type: 'text', text: `Claim #${claim.id} for ${shortName(patient)} came back denied.` },
      ...(reason ? [{ type: 'callout', tone: 'warn', title: 'What the payer said', text: String(reason).slice(0, 300) }] : []),
      { type: 'button', text: 'Open the claim', url: link(appUrl, `/claims/${claim.id}`) },
    ],
    footer: footer(practice),
  });
  return { subject, html, text };
}
