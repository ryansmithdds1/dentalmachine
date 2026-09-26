import { HttpError } from './auth.js';
import { insert, newToken, practiceNow, localNow } from './util.js';
import { preferredChannel, sendMessage } from './messaging.js';
import { renderTemplate } from './templates.js';
import { raiseIssue } from './issues.js';

// Marketing campaigns: one message to a segment of patients (reactivation, unscheduled treatment,
// birthdays, holiday closures…). Recipients are fixed when sending starts, families sharing a phone or
// email get one message, opted-out patients are skipped, and nothing goes out outside 9am–8pm.

export const SEGMENTS = {
  all_active: { label: 'All active patients', help: 'Everyone active — office news, holiday closures.', params: [] },
  reactivation: { label: 'Haven’t visited in a while', help: 'No completed visit in the chosen number of months, and nothing booked.', params: [{ key: 'months', label: 'Months since last visit', default: 18 }] },
  unscheduled_treatment: { label: 'Unscheduled treatment', help: 'Treatment planned (not declined) with no appointment booked.', params: [] },
  recall_due: { label: 'Overdue for recall', help: 'Recall due date has passed, and nothing booked.', params: [] },
  birthdays: { label: 'Birthdays this month', help: 'Patients with a birthday in the chosen month.', params: [{ key: 'month', label: 'Month (1-12)', default: null }] },
  no_insurance: { label: 'No insurance', help: 'Active patients without insurance or a membership — the audience for a membership plan.', params: [] },
};
export const CHANNELS = ['auto', 'sms', 'email'];
export const CAMPAIGN_VARS = ['first_name', 'practice', 'phone', 'booking_link'];
const QUIET = { from: '09:00', to: '20:00' };
const BATCH = 300;

export function cleanParams(segment, params = {}) {
  const def = SEGMENTS[segment];
  if (!def) throw new HttpError(400, `segment must be one of: ${Object.keys(SEGMENTS).join(', ')}`);
  const out = {};
  for (const p of def.params) {
    const v = params[p.key] ?? p.default;
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > (p.key === 'month' ? 12 : 120)) throw new HttpError(400, `${p.label} is out of range`);
    out[p.key] = n;
  }
  for (const k of ['min_age', 'max_age']) {
    if (params[k] == null || params[k] === '') continue;
    const n = Number(params[k]);
    if (!Number.isInteger(n) || n < 0 || n > 120) throw new HttpError(400, `${k} must be 0-120`);
    out[k] = n;
  }
  return out;
}

const NO_FUTURE = "NOT EXISTS (SELECT 1 FROM real_appointments f WHERE f.patient_id = p.id AND f.status IN ('scheduled','confirmed') AND f.start_time >= ?)";

// The patients in a segment (before channel and opt-out filtering).
export async function segmentPatients(db, practiceId, segment, params = {}) {
  const now = await practiceNow(db, practiceId);
  const today = now.slice(0, 10);
  const where = ["p.practice_id = ?", "p.status = 'active'"];
  const args = [practiceId];
  if (segment === 'reactivation') {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - (params.months || 18));
    const cutoff = d.toISOString().slice(0, 10);
    where.push(`NOT EXISTS (SELECT 1 FROM real_appointments a WHERE a.patient_id = p.id AND a.status = 'completed' AND a.start_time >= ?)`, NO_FUTURE, 'substr(p.created_at, 1, 10) < ?');
    args.push(cutoff, now, cutoff);
  } else if (segment === 'unscheduled_treatment') {
    where.push(`EXISTS (SELECT 1 FROM real_procedures x LEFT JOIN real_treatment_plans t ON t.id = x.treatment_plan_id
      WHERE x.patient_id = p.id AND x.status = 'planned' AND (t.id IS NULL OR t.status IN ('proposed','accepted')))`, NO_FUTURE);
    args.push(now);
  } else if (segment === 'recall_due') {
    where.push("EXISTS (SELECT 1 FROM real_recalls r WHERE r.patient_id = p.id AND r.status IN ('due','contacted') AND r.due_date < ?)", NO_FUTURE);
    args.push(today, now);
  } else if (segment === 'birthdays') {
    where.push("p.dob IS NOT NULL AND substr(p.dob, 6, 2) = ?");
    args.push(String(params.month || Number(today.slice(5, 7))).padStart(2, '0'));
  } else if (segment === 'no_insurance') {
    where.push("NOT EXISTS (SELECT 1 FROM real_patient_insurance i WHERE i.patient_id = p.id AND i.active = 1)",
      "NOT EXISTS (SELECT 1 FROM memberships m WHERE m.patient_id = p.id AND m.status IN ('active','past_due'))");
  } else if (segment !== 'all_active') throw new HttpError(400, 'Unknown segment');
  const rows = await db.all(
    `SELECT p.id, p.first_name, p.last_name, p.dob, p.phone, p.email, p.sms_opt_in, p.email_opt_in, p.guarantor_id
     FROM real_patients p WHERE ${where.join(' AND ')} ORDER BY p.last_name, p.first_name, p.id`, ...args,
  );
  const age = (dob) => (dob ? Math.floor((new Date(`${today}T00:00:00Z`) - new Date(`${dob}T00:00:00Z`)) / (365.25 * 86400_000)) : null);
  return rows.filter((r) => (params.min_age == null || (age(r.dob) ?? -1) >= params.min_age) && (params.max_age == null || (age(r.dob) ?? 999) <= params.max_age));
}

// Who actually gets it, and how: one message per phone number or email address.
export function pickRecipients(patients, channel) {
  const seen = new Set();
  const out = [];
  let unreachable = 0;
  for (const p of patients) {
    const target = preferredChannel(p, channel === 'auto' ? undefined : channel);
    if (!target) { unreachable++; continue; }
    const key = `${target.channel}:${target.channel === 'sms' ? String(target.to).replace(/\D/g, '').slice(-10) : String(target.to).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ patient: p, ...target });
  }
  return { recipients: out, unreachable, duplicates: patients.length - unreachable - out.length };
}

export async function campaignVars(db, practiceId, appUrl) {
  const pr = await db.get('SELECT name, phone, slug, online_booking FROM practices WHERE id = ?', practiceId);
  return { practice: pr.name, phone: pr.phone || 'the office', booking_link: pr.slug && pr.online_booking ? `${appUrl}/book/${pr.slug}` : `${appUrl}` };
}

export function validateBody(body, channel) {
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, 'Write the message');
  if (text.length > (channel === 'sms' ? 480 : 5000)) throw new HttpError(400, channel === 'sms' ? 'Texts can be up to 480 characters' : 'Message is too long');
  const unknown = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x) => !CAMPAIGN_VARS.includes(x));
  if (unknown.length) throw new HttpError(400, `Unknown merge field {${unknown[0]}} — use ${CAMPAIGN_VARS.map((v) => `{${v}}`).join(' ')}`);
  return text;
}

// Blanks left in a starter message for the office to fill in: "[date]", "[time]", "[your offer]". A campaign
// can't be sent (or scheduled) while any are left — one went out to every patient with "[date]" in it.
export const placeholdersIn = (...texts) => [...new Set(texts.flatMap((t) => [...String(t || '').matchAll(/\[[^\]\n]{1,40}\]|_{3,}/g)].map((m) => m[0])))];
export function assertReadyToSend(c) {
  const left = placeholdersIn(c.body, c.subject);
  if (left.length) {
    throw new HttpError(400, `The message still says ${left.map((x) => `“${x}”`).join(', ')} — replace ${left.length === 1 ? 'it' : 'them'} with the real details before sending`, { placeholders: left });
  }
}

// Texts carry the opt-out words; emails a one-click unsubscribe link.
export function finalBody(template, vars, channel, unsubscribeUrl) {
  const text = renderTemplate(template, vars);
  if (channel === 'sms') return /\bSTOP\b/i.test(text) ? text : `${text} Reply STOP to opt out.`;
  return `${text}\n\nTo stop receiving these emails: ${unsubscribeUrl}`;
}

const inQuietHours = (local) => local.slice(11, 16) < QUIET.from || local.slice(11, 16) >= QUIET.to;

// Starts campaigns that are due and sends the next batch of each one that's going out.
export async function runCampaigns(db, messenger, { appUrl, campaignId = null, now = new Date() }) {
  let sent = 0;
  const due = await db.all(
    `SELECT * FROM campaigns WHERE status IN ('scheduled','sending') AND send_at <= ?${campaignId ? ' AND id = ?' : ''} ORDER BY id`,
    now.toISOString(), ...(campaignId ? [campaignId] : []),
  );
  for (const c of due) {
    const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', c.practice_id))?.timezone;
    if (inQuietHours(localNow(tz || 'America/New_York', now))) continue;
    // Take the campaign for this run so two servers don't send the same batch.
    const lock = new Date(now.getTime() + 10 * 60_000).toISOString();
    const took = await db.run('UPDATE campaigns SET send_lock = ? WHERE id = ? AND (send_lock IS NULL OR send_lock < ?)', lock, c.id, now.toISOString());
    if (!took.changes) continue;
    try {
      // Belt and braces (the send route checks too): a scheduled campaign with blanks left goes back to a
      // draft and becomes a work item, instead of going out to everyone with "[date]" in it.
      if (c.status === 'scheduled' && placeholdersIn(c.body, c.subject).length) {
        await db.run("UPDATE campaigns SET status = 'draft' WHERE id = ?", c.id);
        await raiseIssue(db, {
          practiceId: c.practice_id, kind: 'message', key: `campaign-blanks:${c.id}`, title: `Campaign “${c.name}” wasn’t sent: fill in ${placeholdersIn(c.body, c.subject).join(', ')}`,
          detail: 'It was put back to a draft. Open Campaigns, replace the blanks with the real details and send it again.', entity: 'campaigns', entityId: c.id,
        });
        continue;
      }
      if (c.status === 'scheduled') {
        const { recipients } = pickRecipients(await segmentPatients(db, c.practice_id, c.segment, JSON.parse(c.params || '{}')), c.channel);
        await db.tx(async () => {
          for (const r of recipients) {
            await db.run(
              'INSERT INTO campaign_recipients (campaign_id, patient_id, channel, to_address) VALUES (?, ?, ?, ?) ON CONFLICT (campaign_id, channel, to_address) DO NOTHING',
              c.id, r.patient.id, r.channel, r.to,
            );
          }
          await db.run("UPDATE campaigns SET status = 'sending', started_at = datetime('now'), recipients = ? WHERE id = ?", recipients.length, c.id);
        });
      }
      const vars = await campaignVars(db, c.practice_id, appUrl);
      const batch = await db.all(
        `SELECT cr.*, p.first_name, p.sms_opt_in, p.email_opt_in FROM campaign_recipients cr JOIN patients p ON p.id = cr.patient_id
         WHERE cr.campaign_id = ? AND cr.status = 'pending' ORDER BY cr.id LIMIT ${BATCH}`, c.id,
      );
      for (const r of batch) {
        // Someone who opted out after the campaign started is still skipped.
        if ((r.channel === 'sms' && !r.sms_opt_in) || (r.channel === 'email' && !r.email_opt_in)) {
          await db.run("UPDATE campaign_recipients SET status = 'skipped' WHERE id = ?", r.id);
          continue;
        }
        const { token, hash } = newToken();
        await db.run('UPDATE campaign_recipients SET unsubscribe_hash = ? WHERE id = ?', hash, r.id);
        const msg = await sendMessage(db, messenger, {
          practiceId: c.practice_id, patientId: r.patient_id, kind: 'campaign', channel: r.channel, to: r.to_address,
          subject: c.subject || vars.practice,
          body: finalBody(c.body, { ...vars, first_name: r.first_name }, r.channel, `${appUrl}/u/${token}`),
        });
        await db.run('UPDATE campaign_recipients SET status = ?, message_id = ? WHERE id = ?', msg.status === 'sent' ? 'sent' : 'failed', msg.id, r.id);
        if (msg.status === 'sent') sent++;
      }
      const left = (await db.get("SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending'", c.id)).n;
      await db.run(
        `UPDATE campaigns SET sent_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'sent'),
           failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed')${left ? '' : ", status = 'sent', finished_at = datetime('now')"} WHERE id = ?`,
        c.id, c.id, c.id,
      );
    } finally {
      await db.run('UPDATE campaigns SET send_lock = NULL WHERE id = ?', c.id);
    }
  }
  return sent;
}

export async function createCampaign(db, practiceId, userId, b) {
  const row = normalize(b);
  const id = await insert(db, 'campaigns', { ...row, practice_id: practiceId, created_by: userId });
  return id;
}

export function normalize(b) {
  const name = String(b?.name || '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'Name the campaign');
  if (!CHANNELS.includes(b.channel || 'auto')) throw new HttpError(400, 'channel must be auto, sms or email');
  const channel = b.channel || 'auto';
  return {
    name, segment: b.segment, params: JSON.stringify(cleanParams(b.segment, b.params || {})), channel,
    subject: String(b.subject || '').slice(0, 150) || null, body: validateBody(b.body, channel === 'email' ? 'email' : 'sms'),
  };
}
