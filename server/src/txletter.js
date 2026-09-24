import { HttpError, can } from './auth.js';
import { insert, audit, recorded, newToken, hashToken, localNow } from './util.js';
import { currentActor, withActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { publish } from './events.js';
import { sendMessage, recipientFor } from './messaging.js';
import { mailable } from './mail.js';
import { PdfDoc, dataUrlImage } from './pdf.js';
import { imageSize } from './thumbnails.js';
import { dicomToImage } from './dicomimage.js';
import { localDate } from './diagnosis.js';
import { dueOccurrences, stepsFor, STOP_REASONS, activeHold } from './cadence.js';
import { planFacts, letterWording, planStopReason, money } from './txwords.js';

// The doctor's letter (TF3, docs/workflows/specs/TF-treatment-followup.md). When a patient's treatment still isn't
// scheduled, the doctor writes to them: letterhead, what was found in plain words, why it matters and what can
// happen if it waits, their x-ray or photo with the area marked, the treatment and its estimated cost, how to
// schedule, and the doctor's signature. The cadence's letter step (or the doctor's own click) makes a DRAFT; the
// doctor edits and approves it (one click, or a batch). Only then is it emailed (with the PDF) and/or printed and
// mailed, filed on the chart as a document and recorded as the informed notice. AI may draft the wording, labelled,
// and never sends (rule 10). Every step is audited; a failure becomes a Needs attention item.

const LINK_DAYS = 90;
const WAIT_DAYS = 7; // drafts older than this raise "letters waiting for the doctor"
const MARKUP_POINTS = { circle: 2, arrow: 2, line: 2, text: 1, polyline: 40 };
const DEFAULT_COLOR = '#0f766e';
const MARK = '#dc2626';
const IMAGE_MIME = /^image\/(png|jpeg)$|^application\/dicom$/;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const todayOf = (practice, now = new Date()) => localNow(practice.timezone || 'America/New_York', now).slice(0, 10);
const longDate = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.toLowerCase() : null);

export const LETTER_STATUS = { draft: 'Waiting for the doctor', sending: 'Sending', sent: 'Sent', failed: 'Didn’t go', cancelled: 'Not needed' };

// ---- Markup: circles and arrows on the image (image pixels, like the imaging viewer's annotations) ----
export function cleanMarkup(list) {
  if (list == null) return null;
  if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'Mark the image with up to 20 circles, arrows or notes');
  return list.map((a) => {
    const n = MARKUP_POINTS[a?.type];
    if (!n) throw new HttpError(400, 'Marks are circles, arrows, lines, notes or freehand lines');
    const points = (Array.isArray(a.points) ? a.points : []).slice(0, n).map((p) => [Number(p?.[0]), Number(p?.[1])]);
    if (!points.length || points.some((p) => !p.every((v) => Number.isFinite(v) && Math.abs(v) < 100_000))) throw new HttpError(400, 'Mark points must be numbers');
    if (a.type !== 'text' && a.type !== 'polyline' && points.length !== 2) throw new HttpError(400, 'A circle, arrow or line needs two points');
    return { type: a.type, points, ...(a.text ? { text: String(a.text).slice(0, 80) } : {}), color: hex(a.color) || MARK };
  });
}
// The imaging viewer's own saved annotations that make sense on a letter (not measurements or angles).
const fromViewer = (json) => {
  try {
    return cleanMarkup((JSON.parse(json || '[]') || []).filter((a) => MARKUP_POINTS[a?.type]).slice(0, 20).map((a) => ({ ...a, color: MARK })));
  } catch {
    return null;
  }
};

// ---- Drafting ----
// The best picture of the problem: the one the office chose for the plan's presentation, else an x-ray or photo
// of a tooth on the plan (marked-up ones first), else the patient's latest x-ray.
async function pickImage(db, plan, facts) {
  const phase = await db.get(
    `SELECT d.id FROM treatment_plan_phases ph JOIN documents d ON d.id = ph.document_id
     WHERE ph.treatment_plan_id = ? AND d.patient_id = ? AND d.practice_id = ? AND d.deleted_at IS NULL ORDER BY ph.phase LIMIT 1`, plan.id, plan.patient_id, plan.practice_id,
  );
  if (phase) return phase.id;
  const docs = await db.all(
    "SELECT id, tooth, mime, annotations, category FROM documents WHERE patient_id = ? AND practice_id = ? AND deleted_at IS NULL AND category IN ('xray','photo') ORDER BY id DESC LIMIT 200",
    plan.patient_id, plan.practice_id,
  );
  const usable = docs.filter((d) => IMAGE_MIME.test(d.mime || ''));
  const marked = (d) => (d.annotations && d.annotations !== '[]' ? 0 : 1);
  const onTooth = usable.filter((d) => d.tooth && facts.teeth.map(String).includes(String(d.tooth))).sort((a, b) => marked(a) - marked(b));
  return (onTooth[0] || usable.find((d) => d.category === 'xray') || usable[0])?.id ?? null;
}

// Who signs: the dentist on the plan's work, else the patient's own dentist, else the practice's first dentist.
async function signerFor(db, plan, facts) {
  const counts = new Map();
  for (const p of facts.procedures) if (p.provider_id) counts.set(p.provider_id, (counts.get(p.provider_id) || 0) + 1);
  const ids = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const patient = await db.get('SELECT primary_provider_id FROM patients WHERE id = ?', plan.patient_id);
  for (const id of [...ids, patient?.primary_provider_id].filter(Boolean)) {
    const pv = await db.get("SELECT id FROM providers WHERE id = ? AND practice_id = ? AND active = 1 AND type IN ('dentist','specialist')", id, plan.practice_id);
    if (pv) return pv.id;
  }
  return (await db.get("SELECT id FROM providers WHERE practice_id = ? AND active = 1 AND type = 'dentist' ORDER BY id LIMIT 1", plan.practice_id))?.id ?? null;
}

// Makes the draft for a plan (once: a plan has at most one open letter). source: automation (the cadence step),
// human (the doctor clicked "Write a letter"). Returns { letter, created }.
export async function createLetterDraft(db, { practice, plan, enrollmentId = null, runId = null, source = 'automation', userId = null }) {
  const live = await db.get("SELECT * FROM txf_letters WHERE live_key = ?", `plan:${plan.id}`);
  if (live) {
    if (runId && !live.run_id) await db.run('UPDATE txf_letters SET run_id = ?, enrollment_id = COALESCE(enrollment_id, ?) WHERE id = ? AND run_id IS NULL', runId, enrollmentId, live.id);
    return { letter: await db.get('SELECT * FROM txf_letters WHERE id = ?', live.id), created: false };
  }
  const facts = await planFacts(db, plan);
  const words = letterWording(facts);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', plan.patient_id);
  const recipient = await recipientFor(db, patient);
  // Email when it can go; otherwise a paper copy (mailed by the mail service, or printed at the office).
  const canEmail = !!(recipient.email && recipient.email_opt_in && !recipient.email_bad_at);
  const row = {
    practice_id: practice.id, patient_id: plan.patient_id, treatment_plan_id: plan.id, enrollment_id: enrollmentId, run_id: runId,
    provider_id: await signerFor(db, plan, facts), location_id: patient.location_id ?? null, live_key: `plan:${plan.id}`, status: 'draft',
    ...words, cost: facts.cost, total_fee: facts.total, insurance: facts.insurance, document_id: await pickImage(db, plan, facts),
    send_email: canEmail ? 1 : 0, send_mail: canEmail ? 0 : 1, source, created_by: userId,
  };
  let id;
  try {
    id = await insert(db, 'txf_letters', row);
  } catch (err) {
    // Two passes (or two clicks) at once: the other one made it.
    const again = await db.get('SELECT * FROM txf_letters WHERE live_key = ?', `plan:${plan.id}`);
    if (again) return { letter: again, created: false };
    throw err;
  }
  await audit(db, { user: { practice_id: practice.id, id: userId } }, 'txf_letter.draft', 'txf_letters', id, {
    treatment_plan_id: plan.id, enrollment_id: enrollmentId, provider_id: row.provider_id, document_id: row.document_id, cost: row.cost,
  }, { patientId: plan.patient_id });
  publish(practice.id, { type: 'txfollow', patient_id: plan.patient_id });
  return { letter: await db.get('SELECT * FROM txf_letters WHERE id = ?', id), created: true };
}

// ---- The cadence's letter step ----
// Runs at the start of every treatment pass (from the type's candidates(), before the engine looks for due steps):
// a due letter step is claimed here as a 'task' run with a draft for the doctor, so the engine never mails a
// generic letter for it; steps it passed on a late start are marked skipped. Also: drafts that aren't needed any
// more are cancelled, a send cut off by a crash becomes a failure to look at, and old drafts raise a reminder.
export async function tidyLetters(db, practice, { today, now = new Date() }) {
  const pid = practice.id;
  const active = await db.all(
    "SELECT e.* FROM cadence_enrollments e JOIN cadence_sequences s ON s.id = e.sequence_id WHERE e.practice_id = ? AND s.type = 'treatment' AND e.status = 'active'", pid,
  );
  for (const e of active) {
    const steps = await stepsFor(db, e.sequence_id);
    if (!steps.some((s) => s.channel === 'letter')) continue;
    const had = new Set((await db.all('SELECT step_id, occurrence FROM cadence_runs WHERE enrollment_id = ?', e.id)).map((r) => `${r.step_id}:${r.occurrence}`));
    const due = dueOccurrences(steps, e.anchor_date, today).filter((o) => !had.has(`${o.step.id}:${o.occurrence}`));
    const letterAt = due.map((o, i) => (o.step.channel === 'letter' ? i : -1)).filter((i) => i >= 0).at(-1);
    if (letterAt == null) continue;
    const plan = await db.get('SELECT * FROM treatment_plans WHERE id = ? AND practice_id = ?', e.source_id, pid);
    if (await planStopReason(db, plan, { today, anchor: e.anchor_date })) continue; // the engine stops it on this pass
    const o = due[letterAt];
    const { changes } = await db.run(
      `INSERT INTO cadence_runs (practice_id, enrollment_id, step_id, occurrence, patient_id, due_date, status, channel, source, result)
       VALUES (?, ?, ?, ?, ?, ?, 'task', 'letter', 'automation', 'Doctor’s letter drafted — waiting for the doctor to approve') ON CONFLICT (enrollment_id, step_id, occurrence) DO NOTHING`,
      pid, e.id, o.step.id, o.occurrence, e.patient_id, o.due_date,
    );
    if (!changes) continue;
    const run = await db.get('SELECT id FROM cadence_runs WHERE enrollment_id = ? AND step_id = ? AND occurrence = ?', e.id, o.step.id, o.occurrence);
    // Earlier steps not yet run (a late start) are passed over: the letter is the step that counts now.
    for (const x of due.slice(0, letterAt)) {
      await db.run(
        `INSERT INTO cadence_runs (practice_id, enrollment_id, step_id, occurrence, patient_id, due_date, status, result, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'The doctor’s letter was already due', datetime('now')) ON CONFLICT (enrollment_id, step_id, occurrence) DO NOTHING`,
        pid, e.id, x.step.id, x.occurrence, e.patient_id, x.due_date,
      );
    }
    await db.run("UPDATE cadence_enrollments SET current_step = ?, last_run_at = datetime('now') WHERE id = ?", o.step.position, e.id);
    const { letter } = await createLetterDraft(db, { practice, plan, enrollmentId: e.id, runId: run.id, source: 'automation' });
    await audit(db, { user: { practice_id: pid, id: null } }, 'cadence.step.task', 'cadence_runs', run.id, { enrollment_id: e.id, step: `+${o.step.offset_days}d letter`, letter_id: letter.id }, { patientId: e.patient_id });
  }

  // Open letters no longer needed: the cadence stopped (booked, declined, opted out…) or the work was done.
  for (const l of await db.all("SELECT * FROM txf_letters WHERE practice_id = ? AND status IN ('draft','failed')", pid)) {
    const e = l.enrollment_id ? await db.get('SELECT status, stop_reason FROM cadence_enrollments WHERE id = ?', l.enrollment_id) : null;
    let why = e?.status === 'stopped' ? STOP_REASONS[e.stop_reason] || e.stop_reason : null;
    if (!why) {
      const stop = await planStopReason(db, await db.get('SELECT * FROM treatment_plans WHERE id = ?', l.treatment_plan_id), { today });
      if (stop) why = STOP_REASONS[stop.reason] || stop.reason;
    }
    if (why) await cancelLetter(db, null, l, `Not needed any more: ${why}`);
  }

  // A send cut off part-way (a crash) is never retried on its own: it may have gone. A person looks.
  for (const l of await db.all("SELECT * FROM txf_letters WHERE practice_id = ? AND status = 'sending' AND updated_at < ?", pid, utc(new Date(now.getTime() - 30 * 60_000)))) {
    await db.run("UPDATE txf_letters SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'sending'", 'Interrupted while sending — check the patient’s messages before sending again', l.id);
    await raiseIssue(db, { practiceId: pid, kind: 'message', key: `txf-letter:${l.id}`, role: 'clinical', entity: 'txf_letters', entityId: l.id, patientId: l.patient_id, title: 'A doctor’s letter may not have gone (interrupted) — check before sending again' });
  }

  // Drafts waiting more than a week: one reminder for the doctors, resolved when the list is clear.
  const waiting = await db.get("SELECT COUNT(*) AS n FROM txf_letters WHERE practice_id = ? AND status = 'draft' AND created_at < ?", pid, utc(new Date(now.getTime() - WAIT_DAYS * 86400_000)));
  if (Number(waiting.n)) {
    await raiseIssue(db, { practiceId: pid, kind: 'message', key: 'txf-letters-waiting', role: 'clinical', title: `${waiting.n} doctor’s letter${Number(waiting.n) === 1 ? ' is' : 's are'} waiting more than a week for approval (Treatment follow-up → Letters)` });
  } else await resolveIssue(db, pid, 'txf-letters-waiting', 'Resolved: no letters waiting');
}

// ---- Rendering ----
async function readImage(storage, doc) {
  if (!storage || !doc) return null;
  let data = await storage.read(doc.storage_key, !!doc.encrypted).catch(() => null);
  if (!data) return null;
  let mime = doc.mime;
  if (mime === 'application/dicom') {
    const img = dicomToImage(data);
    if (!img) return null;
    ({ mime, data } = img);
  }
  const size = imageSize(data);
  if (!size || !/^image\/(png|jpeg)$/.test(mime)) return null;
  return { mime, data, width: size.width, height: size.height };
}

// Everything a letter shows, gathered once for the HTML and the PDF.
export async function letterModel(db, letter, { storage = null, link = null, now = new Date() } = {}) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', letter.practice_id);
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', letter.patient_id);
  const recipient = await recipientFor(db, patient);
  const plan = await db.get('SELECT * FROM treatment_plans WHERE id = ?', letter.treatment_plan_id);
  const provider = letter.provider_id ? await db.get('SELECT * FROM providers WHERE id = ? AND practice_id = ?', letter.provider_id, letter.practice_id) : null;
  const doctor = provider ? await db.get('SELECT * FROM txf_doctors WHERE provider_id = ? AND practice_id = ?', provider.id, letter.practice_id) : null;
  const settings = await db.get('SELECT * FROM txf_settings WHERE practice_id = ?', letter.practice_id);
  const os = await db.get('SELECT brand_color, logo, logo_mime FROM online_sched_settings WHERE practice_id = ?', letter.practice_id).catch(() => null);
  let logo = null;
  if (settings?.logo_key && storage) {
    const data = await storage.read(settings.logo_key, !!settings.logo_encrypted).catch(() => null);
    if (data) logo = { mime: settings.logo_mime, data };
  } else if (os?.logo && /^image\/(png|jpeg)$/.test(os.logo_mime || '')) logo = { mime: os.logo_mime, data: Buffer.from(os.logo, 'base64') };
  let signature = null;
  if (doctor?.signature_key && storage) {
    const data = await storage.read(doctor.signature_key, !!doctor.signature_encrypted).catch(() => null);
    if (data) signature = { mime: doctor.signature_mime, data };
  }
  const doc = letter.document_id ? await db.get('SELECT * FROM documents WHERE id = ? AND patient_id = ? AND practice_id = ? AND deleted_at IS NULL', letter.document_id, letter.patient_id, letter.practice_id) : null;
  const image = await readImage(storage, doc);
  const markup = letter.markup ? JSON.parse(letter.markup) : fromViewer(doc?.annotations) || [];
  const tz = practice.timezone || 'America/New_York';
  const name = provider ? provider.name.replace(/,\s*(DDS|DMD|MS|PhD|MD)\b.*$/i, '') : practice.name;
  const credentials = doctor?.credentials || (provider && /,\s*(.+)$/.exec(provider.name)?.[1]) || '';
  return {
    practice, patient, recipient, plan, letter, logo, signature, image, markup,
    color: hex(settings?.brand_color) || hex(os?.brand_color) || DEFAULT_COLOR,
    doctor: { name, credentials, title: doctor?.title || '', closing: doctor?.closing || letter.closing || 'Warm regards,' },
    date: longDate(letter.sent_at ? localDate(tz, letter.sent_at) : todayOf(practice, now)),
    seen: plan ? longDate(localDate(tz, plan.created_at)) : null,
    imageDate: doc ? longDate(doc.taken_at || localDate(tz, doc.created_at)) : null, imageKind: doc?.category === 'photo' ? 'photo' : 'x-ray',
    link, parentNote: recipient.id !== patient.id ? `I’m writing to you about ${patient.preferred_name || patient.first_name}’s care.` : null,
  };
}

// The letter's words, shared by the HTML, the PDF and the plain-text email.
function paragraphs(m) {
  const l = m.letter;
  const cost = Number(l.cost || 0);
  const costLine = Number(l.total_fee || 0) > 0 ? (cost > 0 ? `Your estimated cost is ${money(cost)}${Number(l.insurance || 0) > 0 ? ` after an estimated ${money(l.insurance)} from your insurance` : ''}.` : 'Your insurance estimate covers the full cost.') : '';
  return {
    greeting: `Dear ${m.recipient.preferred_name || m.recipient.first_name},`,
    opening: `${m.parentNote ? `${m.parentNote} ` : ''}${m.seen ? `When I examined you on ${m.seen}, ` : 'At your last visit '}I found ${l.diagnosis || 'something that needs treatment'}. I recommended ${l.treatment || 'treatment'}, and I noticed it hasn’t been scheduled yet — so I wanted to write to you myself.`,
    why: l.why || '',
    risk: l.risk || '',
    recommend: `I recommend ${l.treatment || 'the treatment we discussed'}.`,
    costLine,
    fine: 'Estimates are based on your insurance as we have it on file and are not a guarantee of payment. Ask us about payment options — we’re happy to help.',
    schedule: `${m.link ? 'You can see your treatment plan, your cost and choose a time here:' : 'To schedule,'} ${m.link ? '' : `call us at ${m.practice.phone || 'the office'}.`}`.trim(),
    call: m.practice.phone ? `Or call us at ${m.practice.phone} — we’ll find a time that works for you.` : '',
    closingLine: 'If you have any questions, or if something is holding you back, please call — I’d be glad to talk it through.',
  };
}

// The marks as SVG over the image (the letter's HTML; the PDF draws the same marks as vectors).
function markupSvg(markup, w, h) {
  const sw = Math.max(2, Math.round(Math.max(w, h) / 160));
  return markup.map((a) => {
    const c = esc(a.color || MARK);
    const [p0, p1] = a.points;
    if (a.type === 'circle') return `<circle cx="${p0[0]}" cy="${p0[1]}" r="${Math.hypot(p1[0] - p0[0], p1[1] - p0[1]).toFixed(1)}" fill="none" stroke="${c}" stroke-width="${sw}"/>`;
    if (a.type === 'line' || a.type === 'arrow') {
      let head = '';
      if (a.type === 'arrow') {
        const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const len = sw * 6;
        const pts = [-0.45, 0.45].map((d) => `${(p1[0] - len * Math.cos(ang + d)).toFixed(1)},${(p1[1] - len * Math.sin(ang + d)).toFixed(1)}`);
        head = `<polygon points="${p1[0]},${p1[1]} ${pts.join(' ')}" fill="${c}"/>`;
      }
      return `<line x1="${p0[0]}" y1="${p0[1]}" x2="${p1[0]}" y2="${p1[1]}" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/>${head}`;
    }
    if (a.type === 'polyline') return `<polyline points="${a.points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    return `<text x="${p0[0]}" y="${p0[1]}" fill="${c}" font-size="${sw * 7}" font-family="Helvetica,Arial,sans-serif" font-weight="700">${esc(a.text || '')}</text>`;
  }).join('');
}

// mode: 'preview' (the doctor's screen: everything), 'email' (no picture — it's in the attached PDF),
// 'print' (the mail service: the top of page 1 is left clear for the address window; the picture comes from
// imageUrl, a signed link, because the mail service limits how big the page source can be).
export function letterHtml(m, { mode = 'preview', imageUrl = null } = {}) {
  const t = paragraphs(m);
  const c = m.color;
  const p = m.practice;
  const addr = [p.address, [p.city, p.state].filter(Boolean).join(', '), p.zip].filter(Boolean).join(' · ');
  const logo = m.logo && mode !== 'print' ? `<img src="data:${m.logo.mime};base64,${m.logo.data.toString('base64')}" alt="">` : '';
  const head = `<div class="head">${logo}<div><div class="pn">${esc(p.name)}</div><div class="pa">${esc(addr)}${p.phone ? ` · ${esc(p.phone)}` : ''}</div></div></div>`;
  let figure = '';
  if (m.image && mode !== 'email') {
    const src = mode === 'print' ? imageUrl : `data:${m.image.mime};base64,${m.image.data.toString('base64')}`;
    if (src) {
      figure = `<figure><svg viewBox="0 0 ${m.image.width} ${m.image.height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Your ${m.imageKind} with the area marked"><image href="${esc(src)}" width="${m.image.width}" height="${m.image.height}"/>${markupSvg(m.markup, m.image.width, m.image.height)}</svg>`
        + `<figcaption>Your ${m.imageKind}${m.imageDate ? ` from ${esc(m.imageDate)}` : ''}${m.markup.length ? ' — the marked area is what concerns me' : ''}.</figcaption></figure>`;
    }
  } else if (m.image && mode === 'email') {
    figure = `<p class="note">Your ${m.imageKind}, with the area that concerns me marked, is in the attached letter (PDF).</p>`;
  }
  const rows = [
    Number(m.letter.total_fee || 0) > 0 ? `<tr><td>Treatment fee</td><td class="n">${money(m.letter.total_fee)}</td></tr>` : '',
    Number(m.letter.insurance || 0) > 0 ? `<tr><td>Estimated insurance</td><td class="n">−${money(m.letter.insurance)}</td></tr>` : '',
    Number(m.letter.total_fee || 0) > 0 ? `<tr class="you"><td>Your estimated cost</td><td class="n">${money(m.letter.cost)}</td></tr>` : '',
  ].join('');
  const sig = m.signature ? `<img src="data:${m.signature.mime};base64,${m.signature.data.toString('base64')}" alt="Signature">` : '';
  const css = `body{margin:0;background:${mode === 'preview' ? '#eef2f1' : '#fff'};color:#1f2933;font-family:Georgia,'Times New Roman',serif}
.page{max-width:7in;margin:0 auto;background:#fff;padding:${mode === 'print' ? '0 .7in .5in' : '.55in .7in'}}
.top{height:${mode === 'print' ? '3.1in' : 'auto'};position:relative}.top .head{${mode === 'print' ? 'position:absolute;right:0;top:.45in;text-align:right' : ''}}
.head{display:flex;gap:14px;align-items:center;border-bottom:3px solid ${c};padding-bottom:10px;margin-bottom:18px}.head img{max-height:54px;max-width:150px}
.pn{font:700 19px Helvetica,Arial,sans-serif;color:${c}}.pa{font:12px Helvetica,Arial,sans-serif;color:#52606d;margin-top:2px}
.date{font:13px Helvetica,Arial,sans-serif;color:#52606d;margin:0 0 14px}p{font-size:15px;line-height:1.55;margin:0 0 11px}
h2{font:700 12px Helvetica,Arial,sans-serif;letter-spacing:.07em;text-transform:uppercase;color:${c};margin:18px 0 5px}
figure{margin:12px 0 14px;text-align:center}figure svg{max-width:100%;max-height:3in;height:auto;border-radius:6px;background:#111}
figcaption,.note{font:12px Helvetica,Arial,sans-serif;color:#52606d;margin-top:5px}
.rec{border-left:4px solid ${c};background:#f5f8f7;padding:10px 14px;border-radius:6px;margin:6px 0 12px;font-family:Helvetica,Arial,sans-serif}.rec p{font-size:14px}
.rec table{width:100%;border-collapse:collapse;font-size:14px}.rec td{padding:2px 0}.n{text-align:right}.you td{font-weight:700;border-top:1px solid #cbd2d9;padding-top:4px}
.cta a{display:inline-block;background:${c};color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font:700 14px Helvetica,Arial,sans-serif}
.sig{margin-top:18px}.sig img{max-height:56px;display:block}.dr{font:700 15px Helvetica,Arial,sans-serif}.dt{font:13px Helvetica,Arial,sans-serif;color:#52606d}
.fine{font:11px Helvetica,Arial,sans-serif;color:#7b8794;margin-top:16px}`;
  const body = `<div class="page"><div class="top">${head}</div>
<p class="date">${esc(m.date)}</p><p>${esc(t.greeting)}</p><p>${esc(t.opening)}</p>${figure}
${t.why ? `<h2>Why it matters</h2><p>${esc(t.why)}</p>` : ''}${t.risk ? `<h2>If it waits</h2><p>${esc(t.risk)}</p>` : ''}
<h2>What I recommend</h2><div class="rec"><p>${esc(t.recommend)}</p>${rows ? `<table>${rows}</table>` : ''}</div>
<h2>Scheduling</h2>${m.link ? `<p>${esc(t.schedule)}</p><p class="cta"><a href="${esc(m.link)}">See my plan and choose a time</a></p>` : `<p>${esc(t.schedule)}</p>`}${m.link && t.call ? `<p>${esc(t.call)}</p>` : ''}
<p>${esc(t.closingLine)}</p>
<div class="sig"><p>${esc(m.doctor.closing)}</p>${sig}<div class="dr">${esc(m.doctor.name)}${m.doctor.credentials ? `, ${esc(m.doctor.credentials)}` : ''}</div>${m.doctor.title ? `<div class="dt">${esc(m.doctor.title)}</div>` : ''}</div>
<p class="fine">${esc(t.fine)}</p></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A note from ${esc(m.doctor.name)}</title><style>${css}</style></head><body>${body}</body></html>`;
}

// The same letter as plain text (the email's text part).
export function letterText(m) {
  const t = paragraphs(m);
  return [t.greeting, t.opening, t.why && `Why it matters: ${t.why}`, t.risk && `If it waits: ${t.risk}`, `${t.recommend} ${t.costLine}`.trim(),
    m.link ? `${t.schedule} ${m.link}` : t.schedule, m.link ? t.call : '', t.closingLine, `${m.doctor.closing}\n${m.doctor.name}${m.doctor.credentials ? `, ${m.doctor.credentials}` : ''}`, t.fine]
    .filter(Boolean).join('\n\n');
}

// ---- The PDF: the same letter, drawn with the small PDF writer (vector marks over the picture) ----
const PAGE_W = 612;
const MARGIN = 54;
const INNER = PAGE_W - 2 * MARGIN;
const rgb = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
const dataUrl = (x) => (x ? `data:${x.mime === 'image/jpg' ? 'image/jpeg' : x.mime};base64,${x.data.toString('base64')}` : null);

class LetterPdf extends PdfDoc {
  place(img, x, yBottom, w, h) {
    this.images.push(img);
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${yBottom.toFixed(2)} cm /Im${this.images.length} Do Q`);
  }
  // A circle as four Bézier curves.
  circle(cx, cy, r) {
    const k = 0.5523 * r;
    this.ops.push(`${(cx + r).toFixed(2)} ${cy.toFixed(2)} m ${(cx + r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + k).toFixed(2)} ${(cy + r).toFixed(2)} ${cx.toFixed(2)} ${(cy + r).toFixed(2)} c`
      + ` ${(cx - k).toFixed(2)} ${(cy + r).toFixed(2)} ${(cx - r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - r).toFixed(2)} ${cy.toFixed(2)} c`
      + ` ${(cx - r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy - r).toFixed(2)} ${cx.toFixed(2)} ${(cy - r).toFixed(2)} c`
      + ` ${(cx + k).toFixed(2)} ${(cy - r).toFixed(2)} ${(cx + r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} c S`);
  }
  // The picture, centred, with the marks drawn over it in page coordinates.
  figure(img, size, markup, caption) {
    const scale = Math.min(INNER / size.width, 175 / size.height, 1);
    const w = size.width * scale;
    const h = size.height * scale;
    this.need(h + 30);
    const x0 = MARGIN + (INNER - w) / 2;
    const y0 = this.y - h;
    this.place(img, x0, y0, w, h);
    const X = (px) => x0 + px * scale;
    const Y = (py) => y0 + h - py * scale;
    for (const a of markup) {
      this.ops.push(`q ${rgb(a.color || MARK)} RG ${rgb(a.color || MARK)} rg 2.2 w 1 J 1 j`);
      const [p0, p1] = a.points;
      if (a.type === 'circle') this.circle(X(p0[0]), Y(p0[1]), Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * scale);
      else if (a.type === 'line' || a.type === 'arrow') {
        this.ops.push(`${X(p0[0]).toFixed(2)} ${Y(p0[1]).toFixed(2)} m ${X(p1[0]).toFixed(2)} ${Y(p1[1]).toFixed(2)} l S`);
        if (a.type === 'arrow') {
          const ang = Math.atan2(Y(p1[1]) - Y(p0[1]), X(p1[0]) - X(p0[0]));
          const pts = [-0.45, 0.45].map((d) => [X(p1[0]) - 10 * Math.cos(ang + d), Y(p1[1]) - 10 * Math.sin(ang + d)]);
          this.ops.push(`${X(p1[0]).toFixed(2)} ${Y(p1[1]).toFixed(2)} m ${pts.map((q) => `${q[0].toFixed(2)} ${q[1].toFixed(2)} l`).join(' ')} f`);
        }
      } else if (a.type === 'polyline') this.ops.push(`${a.points.map((q, i) => `${X(q[0]).toFixed(2)} ${Y(q[1]).toFixed(2)} ${i ? 'l' : 'm'}`).join(' ')} S`);
      this.ops.push('Q');
    }
    this.y = y0 - 4;
    if (caption) this.text(caption, { size: 8.5, color: [0.32, 0.38, 0.43], indent: x0 - MARGIN, gap: 4 });
  }
  heading(s, color) {
    this.need(40);
    this.space(3);
    this.text(s.toUpperCase(), { size: 8.5, bold: true, color, gap: 1 });
  }
}

export function letterPdf(m) {
  const t = paragraphs(m);
  const brand = rgb(m.color).split(' ').map(Number);
  const grey = [0.32, 0.38, 0.43];
  const doc = new LetterPdf({ footer: `${m.practice.name} · a letter from ${m.doctor.name}` });
  // Letterhead: a colour band, the logo, the practice's name and where to find it.
  doc.ops.push(`${rgb(m.color)} rg 0 780 612 12 re f`);
  const top = doc.y;
  let indent = 0;
  let logoH = 0;
  const logo = m.logo && dataUrlImage(dataUrl(m.logo));
  if (logo) {
    const s = Math.min(120 / logo.w, 46 / logo.h, 1);
    doc.place(logo, MARGIN, top - logo.h * s, logo.w * s, logo.h * s);
    indent = logo.w * s + 12;
    logoH = logo.h * s;
  }
  doc.text(m.practice.name, { size: 17, bold: true, color: brand, indent, gap: 1 });
  const addr = [m.practice.address, [m.practice.city, m.practice.state].filter(Boolean).join(', '), m.practice.zip, m.practice.phone].filter(Boolean).join('  ·  ');
  if (addr) doc.text(addr, { size: 9, color: grey, indent });
  doc.y = Math.min(doc.y, top - logoH) - 4;
  doc.ops.push(`${rgb(m.color)} RG 1.6 w ${MARGIN} ${doc.y.toFixed(2)} m ${PAGE_W - MARGIN} ${doc.y.toFixed(2)} l S`);
  doc.space(12);
  doc.text(m.date, { size: 10, color: grey, gap: 6 });
  doc.text(t.greeting, { size: 10.5, gap: 5 });
  doc.text(t.opening, { size: 10.5, gap: 6 });
  const img = m.image && dataUrlImage(dataUrl(m.image));
  if (img) doc.figure(img, { width: img.w, height: img.h }, m.markup, `Your ${m.imageKind}${m.imageDate ? ` from ${m.imageDate}` : ''}${m.markup.length ? ' — the marked area is what concerns me.' : '.'}`);
  if (t.why) { doc.heading('Why it matters', brand); doc.text(t.why, { size: 10.5, gap: 4 }); }
  if (t.risk) { doc.heading('If it waits', brand); doc.text(t.risk, { size: 10.5, gap: 4 }); }
  doc.heading('What I recommend', brand);
  // A tinted box behind the recommendation and the cost: drawn after the text is placed, inserted underneath it.
  doc.need(90);
  const at = doc.ops.length;
  const y1 = doc.y;
  doc.space(4);
  doc.text(t.recommend, { size: 10.5, bold: true, indent: 12, gap: 3 });
  const cols = { at: [0.03, 0.7], right: [1], size: 10.5 };
  if (Number(m.letter.total_fee || 0) > 0) {
    doc.row(['Treatment fee', money(m.letter.total_fee)], cols);
    if (Number(m.letter.insurance || 0) > 0) doc.row(['Estimated insurance', `-${money(m.letter.insurance)}`], cols);
    doc.row(['Your estimated cost', money(m.letter.cost)], { ...cols, bold: true });
  }
  doc.space(8);
  if (doc.pages.at(-1) === doc.ops) {
    doc.ops.splice(at, 0, `0.961 0.973 0.969 rg ${MARGIN} ${doc.y.toFixed(2)} ${INNER} ${(y1 - doc.y).toFixed(2)} re f`, `${rgb(m.color)} rg ${MARGIN} ${doc.y.toFixed(2)} 3.5 ${(y1 - doc.y).toFixed(2)} re f`);
  }
  doc.space(4);
  doc.heading('Scheduling', brand);
  doc.text(m.link ? `${t.schedule} ${m.link}` : t.schedule, { size: 10.5, gap: 3 });
  if (m.link && t.call) doc.text(t.call, { size: 10.5, gap: 4 });
  doc.text(t.closingLine, { size: 10.5, gap: 8 });
  const sig = m.signature && dataUrlImage(dataUrl(m.signature));
  doc.need(sig ? 92 : 42); // the closing, signature and name stay together
  doc.text(m.doctor.closing, { size: 10.5, gap: 3 });
  if (sig) doc.image(sig, { maxW: 180, maxH: 52 });
  doc.text(`${m.doctor.name}${m.doctor.credentials ? `, ${m.doctor.credentials}` : ''}`, { size: 11.5, bold: true, gap: 1 });
  if (m.doctor.title) doc.text(m.doctor.title, { size: 9.5, color: grey });
  doc.space(6);
  doc.text(t.fine, { size: 7.5, color: [0.48, 0.53, 0.58] });
  return doc.toBuffer();
}

// ---- The patient's link (to see the plan, the cost and choose a time) ----
export async function letterLink(db, letter, appUrl, now = new Date()) {
  const { token, hash } = newToken();
  await db.run('UPDATE txf_letters SET link_hash = ?, link_expires_at = ? WHERE id = ?', hash, utc(new Date(now.getTime() + LINK_DAYS * 86400_000)), letter.id);
  return `${appUrl || ''}/api/public/txf/l.${token}`;
}
export async function letterForToken(db, token, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(token || ''))) return null;
  const l = await db.get('SELECT * FROM txf_letters WHERE link_hash = ?', hashToken(token));
  if (!l) return null;
  if (l.link_expires_at && l.link_expires_at < utc(now)) throw new HttpError(410, 'This link has expired — please call the office and we’ll help you schedule');
  return l;
}

// ---- Approving and sending ----
// Still worth sending? The plan's work is still waiting, the patient is active and hasn't asked not to be contacted.
export async function stillNeeded(db, letter, today) {
  const patient = await db.get('SELECT status, merged_into_id FROM patients WHERE id = ?', letter.patient_id);
  if (!patient || patient.status !== 'active' || patient.merged_into_id) return STOP_REASONS.inactive;
  const hold = await activeHold(db, letter.patient_id, 'treatment');
  if (hold) return STOP_REASONS[hold.reason] || hold.reason;
  const plan = await db.get('SELECT * FROM treatment_plans WHERE id = ? AND practice_id = ?', letter.treatment_plan_id, letter.practice_id);
  const stop = await planStopReason(db, plan, { today });
  return stop ? STOP_REASONS[stop.reason] || stop.reason : null;
}

export async function cancelLetter(db, req, letter, reason) {
  const { changes } = await recorded(db, 'txf_letters', letter.id, () => db.run(
    "UPDATE txf_letters SET status = 'cancelled', live_key = NULL, cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('draft','failed')",
    req?.user?.id ?? null, String(reason).slice(0, 300), letter.id,
  ));
  if (!changes) return false;
  if (letter.run_id) {
    await db.run("UPDATE cadence_runs SET status = 'skipped', result = ?, finished_at = datetime('now') WHERE id = ? AND status = 'task'", `Doctor’s letter not sent: ${reason}`.slice(0, 300), letter.run_id);
  }
  await audit(db, req || { user: { practice_id: letter.practice_id, id: null } }, 'txf_letter.cancel', 'txf_letters', letter.id, { reason }, { patientId: letter.patient_id, reason: String(reason).slice(0, 300) });
  await resolveIssue(db, letter.practice_id, `txf-letter:${letter.id}`, 'Resolved: the letter was cancelled');
  publish(letter.practice_id, { type: 'txfollow', patient_id: letter.patient_id });
  return true;
}

// AI never sends: only a person may approve (rule 10). The assistant's request needs the on-screen yes.
function requirePersonApproval(req) {
  const ctx = currentActor();
  if (ctx?.source === 'ai' && !ctx.approvedBy && req.get?.('X-Human-Approved') !== '1') {
    throw new HttpError(428, 'The assistant can’t send a doctor’s letter without your OK. Approve it yourself on the Letters list.');
  }
}

// Only the doctor whose name and signature are on the letter approves it (when that doctor has a login).
export async function canApprove(db, user, letter) {
  if (!can(user, 'clinical:sign')) return false;
  const pv = letter.provider_id ? await db.get('SELECT user_id FROM providers WHERE id = ?', letter.provider_id) : null;
  if (pv?.user_id) return pv.user_id === user.id;
  return true;
}

// Approve (the doctor's one click) and send. Twice is harmless: a sent letter answers { already: true }.
export async function approveLetter(db, req, letter, deps) {
  requirePersonApproval(req);
  if (letter.status === 'sent') return { letter, already: true };
  if (letter.status === 'cancelled') throw new HttpError(409, `This letter was cancelled (${letter.cancel_reason || 'not needed'})`);
  if (letter.status === 'sending') throw new HttpError(409, 'This letter is being sent right now');
  if (!(await canApprove(db, req.user, letter))) {
    const pv = await db.get('SELECT name FROM providers WHERE id = ?', letter.provider_id);
    throw new HttpError(403, `Only ${pv?.name || 'the doctor who signs it'} can approve this letter — it goes out with their name and signature`);
  }
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', letter.practice_id);
  const why = await stillNeeded(db, letter, todayOf(practice, deps.now));
  if (why) {
    await cancelLetter(db, req, letter, `Not needed any more: ${why}`);
    return { letter: await db.get('SELECT * FROM txf_letters WHERE id = ?', letter.id), cancelled: true, reason: why };
  }
  const before = { status: letter.status, diagnosis: letter.diagnosis, treatment: letter.treatment, cost: letter.cost };
  const { changes } = await recorded(db, 'txf_letters', letter.id, () => db.run(
    `UPDATE txf_letters SET status = 'sending', approved_by = ?, approved_at = datetime('now'), attempts = attempts + 1, error = NULL, updated_at = datetime('now')
     WHERE id = ? AND status IN ('draft','failed')`, req.user.id, letter.id,
  ));
  if (!changes) {
    const now = await db.get('SELECT * FROM txf_letters WHERE id = ?', letter.id);
    if (now.status === 'sent') return { letter: now, already: true };
    throw new HttpError(409, 'This letter changed while you were looking at it — reload and try again');
  }
  await audit(db, req, 'txf_letter.approve', 'txf_letters', letter.id, {
    treatment_plan_id: letter.treatment_plan_id, provider_id: letter.provider_id, ai_drafted: !!letter.ai_drafted, email: !!letter.send_email, mail: !!letter.send_mail,
  }, { patientId: letter.patient_id, before, after: { status: 'sending', diagnosis: letter.diagnosis, treatment: letter.treatment, cost: letter.cost } });
  return { letter: await deliverLetter(db, req, await db.get('SELECT * FROM txf_letters WHERE id = ?', letter.id), deps) };
}

// Files it on the chart, emails it (with the PDF) and/or mails it; the office prints it when neither can go.
// Each channel is done once: a retry after a failure only redoes what didn't go.
async function deliverLetter(db, req, letter, { messenger, mailer, storage, appUrl, now = new Date() }) {
  const pid = letter.practice_id;
  const link = await letterLink(db, letter, appUrl, now);
  const m = await letterModel(db, letter, { storage, link, now });
  const pdf = letterPdf(m);
  const filename = `Letter from ${m.doctor.name} ${todayOf(m.practice, now)}.pdf`.replace(/[^\w.\- ]/g, '_');
  const set = {};
  const via = [];
  const failures = [];

  // 1. On the chart: the exact letter the patient gets, next to their plan.
  if (!letter.filed_document_id && storage) {
    const saved = await storage.save(pid, pdf);
    set.filed_document_id = await insert(db, 'documents', {
      practice_id: pid, patient_id: letter.patient_id, category: 'document', folder: 'Letters', treatment_plan_id: letter.treatment_plan_id, filename, mime: 'application/pdf', size: pdf.length,
      storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, uploaded_by: letter.approved_by, location_id: letter.location_id ?? null,
      notes: 'Doctor’s letter — informed notice: treatment recommended and not yet scheduled',
    });
  }
  // 2. Email: the letter as the message, the PDF (with the marked picture) attached.
  if (letter.send_email && letter.email_status !== 'sent') {
    const to = m.recipient.email;
    if (!to) set.email_status = 'no_email';
    else {
      const msg = await sendMessage(db, messenger, {
        practiceId: pid, patientId: m.recipient.id, userId: letter.approved_by, kind: 'treatment_letter', channel: 'email', to,
        subject: `A note from ${m.doctor.name} about your care`, body: letterText(m), html: letterHtml(m, { mode: 'email' }),
        attachments: [{ filename, type: 'application/pdf', content: pdf }],
      });
      set.email_message_id = msg.id;
      set.email_status = msg.status === 'sent' ? 'sent' : msg.status === 'blocked' ? 'blocked' : 'failed';
      if (set.email_status === 'failed') failures.push(`email: ${msg.error || 'didn’t go'}`);
    }
  }
  if ((letter.email_status === 'sent' || set.email_status === 'sent')) via.push('email');
  // 3. A paper copy: printed and posted by the mail service, or printed at the office when there isn't one.
  const printTask = async (why) => {
    if (letter.print_task_id || set.print_task_id) return;
    set.print_task_id = await insert(db, 'tasks', {
      practice_id: pid, patient_id: letter.patient_id, priority: 'normal', due_date: todayOf(m.practice, now), created_by: letter.approved_by,
      title: `Print and mail ${m.doctor.name}’s letter to ${m.recipient.first_name} ${m.recipient.last_name}`.slice(0, 200),
      notes: `${why} The approved letter is filed in the patient’s documents (Letters).${mailable(m.recipient) ? '' : ' There is no complete mailing address on file — check it first.'}`,
    });
    publish(pid, { type: 'tasks' });
  };
  if (letter.send_mail && !['sent', 'print'].includes(letter.mail_status)) {
    if (mailer?.enabled && mailable(m.recipient)) {
      try {
        const html = letterHtml(m, { mode: 'print', imageUrl: m.image ? `${link}/image` : null });
        const sent = await mailer.sendLetter({
          to: { name: `${m.recipient.first_name} ${m.recipient.last_name}`, address: m.recipient.address, city: m.recipient.city, state: m.recipient.state, zip: m.recipient.zip },
          from: { name: m.practice.name, address: m.practice.address, city: m.practice.city, state: m.practice.state, zip: m.practice.zip },
          html, pdf, description: `Doctor letter ${letter.id}`, idempotencyKey: `txf-letter-${letter.id}`,
        });
        Object.assign(set, { mail_status: 'sent', mail_reference: sent.reference || null, mail_expected: sent.expected_delivery_date || null });
      } catch (err) {
        set.mail_status = 'failed';
        failures.push(`mail: ${err.message}`);
      }
    } else {
      await printTask(mailer?.enabled ? 'The mail service needs a complete address.' : 'No mail service is set up, so the office mails the paper copy.');
      set.mail_status = 'print';
    }
  }
  const mailed = letter.mail_status === 'sent' || set.mail_status === 'sent';
  if (mailed) via.push('mail');
  if (letter.mail_status === 'print' || set.mail_status === 'print') via.push('print');
  // 4. Nothing could go (no email address, opted out of email) and nothing failed: the office prints it.
  if (!via.length && !failures.length) {
    await printTask('The letter couldn’t be emailed.');
    set.mail_status = 'print';
    via.push('print');
  }
  const ok = via.length > 0;
  const status = ok ? 'sent' : 'failed';
  const error = failures.length ? failures.join('; ').slice(0, 500) : null;
  await recorded(db, 'txf_letters', letter.id, () => db.run(
    `UPDATE txf_letters SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}${Object.keys(set).length ? ', ' : ''}status = ?, error = ?, live_key = ${ok ? 'NULL' : 'live_key'},
       sent_at = ${ok ? "COALESCE(sent_at, datetime('now'))" : 'sent_at'}, updated_at = datetime('now') WHERE id = ?`,
    ...Object.values(set), status, error, letter.id,
  ));
  const after = await db.get('SELECT * FROM txf_letters WHERE id = ?', letter.id);
  const result = ok ? `Doctor’s letter sent (${via.join(' and ')})${error ? ` — ${error}` : ''}` : `Doctor’s letter didn’t go: ${error}`;
  // The cadence's letter step: sent, or still waiting on a person (never 'failed' — the engine would retry a failed
  // step with its own generic letter; this one is re-sent from the Letters list).
  if (letter.run_id) {
    await db.run(
      `UPDATE cadence_runs SET status = ?, channel = 'letter', message_id = COALESCE(?, message_id), external_id = COALESCE(?, external_id), result = ?,
         finished_at = ${ok ? "datetime('now')" : 'NULL'} WHERE id = ? AND status = 'task'`,
      ok ? 'sent' : 'task', after.email_message_id ?? null, after.mail_reference ?? null, result.slice(0, 500), letter.run_id,
    );
  }
  const key = `txf-letter:${letter.id}`;
  if (error) {
    await raiseIssue(db, {
      practiceId: pid, kind: 'message', key, role: 'clinical', entity: 'txf_letters', entityId: letter.id, patientId: letter.patient_id,
      title: `${ok ? 'Part of ' : ''}${m.doctor.name}’s letter to ${m.recipient.first_name} ${m.recipient.last_name} didn’t go — open it on Letters to send again`, detail: error,
    });
  } else await resolveIssue(db, pid, key, 'Resolved: the letter went');
  await audit(db, req, ok ? 'txf_letter.sent' : 'txf_letter.failed', 'txf_letters', letter.id, { via, error, document_id: after.filed_document_id, mail_reference: after.mail_reference }, { patientId: letter.patient_id });
  if (ok) {
    // The informed-notice step: the patient was told in writing what was found, why it matters and the risks of waiting.
    await audit(db, req, 'treatment_plan.informed_notice', 'treatment_plans', letter.treatment_plan_id, {
      letter_id: letter.id, document_id: after.filed_document_id, via, approved_by: letter.approved_by,
    }, { patientId: letter.patient_id, reason: 'Doctor’s letter about recommended treatment not yet scheduled' });
  }
  publish(pid, { type: 'txfollow', patient_id: letter.patient_id });
  return after;
}

// ---- Editing a draft ----
const TEXT_FIELDS = { diagnosis: 400, why: 1200, risk: 1200, treatment: 300, closing: 60 };
export async function updateLetter(db, req, letter, body) {
  if (!['draft', 'failed'].includes(letter.status)) throw new HttpError(409, 'Only a letter that hasn’t gone can be changed');
  const row = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) {
    if (body[k] === undefined) continue;
    const v = String(body[k] ?? '').trim();
    if (!v && k !== 'closing') throw new HttpError(400, `The ${k === 'why' ? '“why it matters”' : k === 'risk' ? '“if it waits”' : k} part can’t be empty`);
    if (v.length > max) throw new HttpError(400, `Keep the ${k} under ${max} characters`);
    row[k] = v || null;
  }
  if (body.document_id !== undefined) {
    if (body.document_id === null) row.document_id = null;
    else {
      const d = await db.get('SELECT id, mime FROM documents WHERE id = ? AND patient_id = ? AND practice_id = ? AND deleted_at IS NULL', Number(body.document_id), letter.patient_id, letter.practice_id);
      if (!d) throw new HttpError(400, 'Choose one of this patient’s x-rays or photos');
      if (!IMAGE_MIME.test(d.mime || '')) throw new HttpError(400, 'That file isn’t a picture the letter can show (PNG, JPEG or DICOM)');
      row.document_id = d.id;
      if (body.markup === undefined) row.markup = null; // a new picture starts with its own saved marks
    }
  }
  if (body.markup !== undefined) row.markup = body.markup === null ? null : JSON.stringify(cleanMarkup(body.markup));
  for (const k of ['send_email', 'send_mail']) if (body[k] !== undefined) row[k] = body[k] ? 1 : 0;
  if (body.provider_id !== undefined) {
    const pv = await db.get("SELECT id FROM providers WHERE id = ? AND practice_id = ? AND active = 1 AND type IN ('dentist','specialist')", Number(body.provider_id), letter.practice_id);
    if (!pv) throw new HttpError(400, 'Choose one of the practice’s dentists to sign');
    row.provider_id = pv.id;
  }
  if (!Object.keys(row).length) return letter;
  const before = Object.fromEntries(Object.keys(row).map((k) => [k, letter[k]]));
  await db.run(`UPDATE txf_letters SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('draft','failed')`, ...Object.values(row), req.user.id, letter.id);
  await audit(db, req, 'txf_letter.edit', 'txf_letters', letter.id, { fields: Object.keys(row) }, { patientId: letter.patient_id, before, after: row });
  return db.get('SELECT * FROM txf_letters WHERE id = ?', letter.id);
}

// ---- AI wording (optional): a draft of the three paragraphs, labelled, never sent on its own ----
const AI_TOOL = {
  name: 'letter_wording',
  description: 'Plain-language wording for a dentist’s letter to a patient whose recommended treatment is not yet scheduled.',
  input_schema: {
    type: 'object',
    properties: {
      diagnosis: { type: 'string', description: 'What the dentist found, in plain words, completing “I found …” (no jargon, no codes).' },
      why: { type: 'string', description: 'Why the treatment matters, 1–3 short sentences, warm and factual.' },
      risk: { type: 'string', description: 'What can realistically happen if it waits, 1–3 sentences, honest but not alarming.' },
      reason: { type: 'string', description: 'One short sentence for the doctor: what the wording is based on.' },
    },
    required: ['diagnosis', 'why', 'risk', 'reason'],
  },
};
const AI_SYSTEM = 'You help a dentist write a short, kind, plain-language letter to a patient about treatment they recommended that has not been scheduled yet. '
  + 'Write at a 6th–8th grade reading level, in the dentist’s voice (“I”), without scaring, blaming or selling. Never invent findings: use only what you are given. No names, no codes.';
export async function aiWording(config, facts, letter, structured) {
  const content = JSON.stringify({ treatment: letter.treatment, found: letter.diagnosis, kinds: facts.kinds.map((k) => k.one), urgency: facts.urgency });
  const out = await structured(config, { system: AI_SYSTEM, tool: AI_TOOL, effort: 'low', maxTokens: 1500, content });
  if (!out?.diagnosis || !out?.why || !out?.risk) throw new HttpError(502, 'The AI didn’t return wording — try again, or write it yourself');
  return { diagnosis: String(out.diagnosis).slice(0, 400), why: String(out.why).slice(0, 1200), risk: String(out.risk).slice(0, 1200), reason: String(out.reason || '').slice(0, 300) };
}
export async function applyAiWording(db, req, letter, words) {
  if (letter.status !== 'draft') throw new HttpError(409, 'Only a draft can be reworded');
  const before = { diagnosis: letter.diagnosis, why: letter.why, risk: letter.risk };
  await withActor({ source: 'ai', actor: `AI letter draft (for ${req.user.name || 'the doctor'})`, userId: req.user.id }, async () => {
    await db.run("UPDATE txf_letters SET diagnosis = ?, why = ?, risk = ?, ai_drafted = 1, ai_reason = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'draft'",
      words.diagnosis, words.why, words.risk, words.reason || null, req.user.id, letter.id);
    await audit(db, req, 'txf_letter.ai_draft', 'txf_letters', letter.id, { reason: words.reason }, { patientId: letter.patient_id, source: 'ai', actor: 'AI letter draft', before, after: { diagnosis: words.diagnosis, why: words.why, risk: words.risk } });
  });
  return db.get('SELECT * FROM txf_letters WHERE id = ?', letter.id);
}

