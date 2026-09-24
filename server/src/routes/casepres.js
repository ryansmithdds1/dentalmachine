import { Router } from 'express';
import { messageText, patientLang, subjectFor } from '../templates.js';
import { requirePermission, HttpError, rateLimit, signToken, verifyToken } from '../auth.js';
import { pick, requireFields, insert, findOr404, audit, newToken, hashToken, recorded } from '../util.js';
import { estimateCoverage, primaryPolicy, benefitYear, withPlan } from '../services.js';
import { practiceNow } from '../util.js';
import { financingOptions } from '../financing.js';
import { sendMessage, preferredChannel } from '../messaging.js';
import { checkEpcs } from '../erx.js';
import { allergyWarning, controlledSchedule, stricterSchedule } from '../drugs.js';
import { PdfDoc, dataUrlImage } from '../pdf.js';

// Common dental prescriptions for one-click entry.
export const RX_FAVORITES = [
  { drug: 'Amoxicillin', strength: '500 mg capsule', sig: 'Take 1 capsule by mouth three times daily until gone', quantity: '21 (twenty-one)' },
  { drug: 'Amoxicillin (premedication)', strength: '500 mg capsule', sig: 'Take 4 capsules (2 g) by mouth 30-60 minutes before dental appointment', quantity: '4 (four)' },
  { drug: 'Clindamycin', strength: '300 mg capsule', sig: 'Take 1 capsule by mouth three times daily until gone', quantity: '21 (twenty-one)' },
  { drug: 'Ibuprofen', strength: '600 mg tablet', sig: 'Take 1 tablet by mouth every 6 hours as needed for pain, with food', quantity: '20 (twenty)' },
  { drug: 'Acetaminophen', strength: '500 mg tablet', sig: 'Take 1-2 tablets by mouth every 6 hours as needed for pain (max 3,000 mg/day)', quantity: '20 (twenty)' },
  { drug: 'Chlorhexidine gluconate 0.12% oral rinse', strength: '473 mL', sig: 'Rinse with 15 mL for 30 seconds twice daily after brushing; do not swallow', quantity: '1 bottle' },
  { drug: 'Hydrocodone/acetaminophen', strength: '5 mg/325 mg tablet', sig: 'Take 1 tablet by mouth every 6 hours as needed for severe pain', quantity: '12 (twelve)', refills: 0, schedule: 'II' },
  { drug: 'Tramadol', strength: '50 mg tablet', sig: 'Take 1 tablet by mouth every 6 hours as needed for pain', quantity: '12 (twelve)', refills: 0, schedule: 'IV' },
  { drug: 'Sodium fluoride 1.1% (PreviDent 5000)', strength: '1.1% paste', sig: 'Brush with a thin ribbon once daily at bedtime; spit, do not rinse', quantity: '1 tube' },
];

// What the patient saw and signed: frozen at signing, so later edits to the plan can't change it.
export const snapshotOf = (view) => ({
  procedures: view.procedures.filter((p) => p.status === 'planned').map((p) => ({ id: p.id, code: p.code, description: p.description, tooth: p.tooth, surfaces: p.surfaces, fee: p.fee, status: p.status })),
  estimate: view.estimate,
});
export const signedVersion = (plan, current) => {
  if (!plan.signed_snapshot) return null;
  const signed = JSON.parse(plan.signed_snapshot);
  // Changed since signing: a signed line was edited or removed, or new work was added to the plan.
  const now = new Map(current.map((p) => [p.id, p]));
  const same = (s, c) => c && c.code === s.code && (c.tooth || '') === (s.tooth || '') && (c.surfaces || '') === (s.surfaces || '') && c.fee === s.fee;
  const changed = signed.procedures.some((s) => !same(s, now.get(s.id))) || current.some((p) => p.status === 'planned' && !signed.procedures.some((s) => s.id === p.id));
  return { ...signed, changed };
};

const planView = async (db, plan) => {
  const procedures = await db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND status != 'cancelled' ORDER BY priority, id", plan.id);
  return {
    ...plan, sign_token_hash: undefined, signed_snapshot: undefined, procedures,
    estimate: await estimateCoverage(db, await primaryPolicy(db, plan.practice_id, plan.patient_id), procedures.filter((p) => p.status === 'planned')),
    signed_version: signedVersion(plan, procedures),
  };
};
const SIGN_LINK_DAYS = 14;
// Wrong birth dates before a plan link stops working.
const MAX_DOB_TRIES = 5;

// The plan as a PDF: once signed, exactly the version the patient signed (with their signature);
// before that, the current plan marked as an estimate awaiting signature.
export async function planPdf(db, plan) {
  const live = await planView(db, plan);
  const v = plan.signed_snapshot ? { ...live, ...JSON.parse(plan.signed_snapshot) } : { ...live, procedures: live.procedures.filter((p) => p.status === 'planned') };
  const patient = await db.get('SELECT first_name, last_name, dob FROM patients WHERE id = ?', plan.patient_id);
  const practice = await db.get('SELECT name, address, city, state, zip, phone FROM practices WHERE id = ?', plan.practice_id);
  const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const doc = new PdfDoc({ footer: `${practice.name} · treatment plan for ${patient.first_name} ${patient.last_name}` });
  doc.text(practice.name, { size: 15, bold: true, gap: 1 });
  doc.text([practice.address, practice.city, practice.state, practice.zip].filter(Boolean).join(', '), { size: 9.5, gap: 1 });
  if (practice.phone) doc.text(practice.phone, { size: 9.5 });
  doc.space(8);
  doc.text(`Treatment plan: ${plan.name}`, { size: 13, bold: true });
  doc.text(`${patient.first_name} ${patient.last_name}${patient.dob ? ` · born ${patient.dob}` : ''}`, { size: 10.5 });
  doc.space(6);
  const byId = new Map((v.estimate?.items || []).map((i) => [i.procedure_id, i]));
  const at = [0, 0.1, 0.2, 0.62, 0.76, 0.88];
  doc.row(['Code', 'Tooth', 'Procedure', 'Fee', 'Insurance', 'You pay'], { at, right: [3, 4, 5], bold: true, size: 9.5 });
  doc.rule();
  for (const p of v.procedures) {
    const e = byId.get(p.id) || {};
    doc.row([p.code, [p.tooth, p.surfaces].filter(Boolean).join(' '), p.description, money(p.fee), money(e.insurance ?? 0), money(e.patient ?? p.fee)], { at, right: [3, 4, 5], size: 9.5 });
  }
  doc.rule();
  const est = v.estimate || {};
  doc.row(['', '', 'Total', money(est.total_fee ?? 0), money(est.total_insurance ?? 0), money(est.total_patient ?? 0)], { at, right: [3, 4, 5], bold: true, size: 9.5 });
  if (est.total_write_off) doc.row(['', '', 'In-network adjustment (included above)', money(-est.total_write_off), '', ''], { at, right: [3], size: 9 });
  doc.space(6);
  doc.text(est.policy ? `Insurance estimate based on ${est.policy.carrier_name}. Estimates are not a guarantee of payment; you are responsible for any amount your insurance doesn't pay.` : 'No insurance on file: amounts shown are the full fees.', { size: 8.5, color: [0.35, 0.38, 0.45] });
  if (v.notes) { doc.space(4); doc.text(v.notes, { size: 9.5 }); }
  doc.space(14);
  if (plan.signed_at) {
    doc.text('I have reviewed this treatment plan, had the chance to ask questions, and accept it.', { size: 9.5 });
    doc.space(4);
    const img = plan.signature_image ? dataUrlImage(plan.signature_image) : null;
    if (img) doc.image(img, { maxW: 200, maxH: 60, border: true });
    doc.text(`Signed electronically by ${plan.signature_name} on ${plan.signed_at} UTC`, { size: 9.5, bold: true });
    if (live.signed_version?.changed) doc.text('Note: the plan in the chart has changed since it was signed; this is the signed version.', { size: 8.5, color: [0.6, 0.2, 0.1] });
  } else {
    doc.text('Not yet signed — estimate for discussion.', { size: 9.5, bold: true });
    doc.space(24);
    doc.text('Patient signature ______________________________     Date ______________', { size: 9.5 });
  }
  return doc.toBuffer();
}
const pdfFilename = (plan) => `Treatment plan ${plan.name} ${(plan.signed_at || '').slice(0, 10)}`.trim().replace(/[^\w.\- ()]/g, '_');

export default function casePresentationRoutes({ db, messenger, config, erx, secret }) {
  const r = Router();

  // Staff: send the plan to the patient to review and sign remotely, or get a link for a chairside tablet.
  r.post('/treatment-plans/:tid/present', requirePermission('clinical:write'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    if (plan.signed_at) throw new HttpError(409, 'This plan is already signed');
    const { token, hash } = newToken();
    const expires = new Date(Date.now() + SIGN_LINK_DAYS * 86400_000).toISOString();
    await db.run("UPDATE treatment_plans SET sign_token_hash = ?, sign_token_expires_at = ?, sign_token_failures = 0, presented_at = datetime('now') WHERE id = ?", hash, expires, plan.id);
    const url = `${config.appUrl}/tp/${token}`;
    let message = null;
    if (req.body?.send) {
      const patient = await db.get('SELECT * FROM patients WHERE id = ?', plan.patient_id);
      const target = preferredChannel(patient, req.body.send === 'auto' ? undefined : req.body.send);
      if (!target) throw new HttpError(400, 'Patient has no reachable phone or email (or has opted out)');
      const practice = await db.get('SELECT name FROM practices WHERE id = ?', req.user.practice_id);
      message = await sendMessage(db, messenger, {
        practiceId: req.user.practice_id, patientId: patient.id, userId: req.user.id, kind: 'treatment_plan', channel: target.channel, to: target.to,
        subject: subjectFor(patientLang(patient), 'treatment_plan', `Your treatment plan from ${practice.name}`, practice.name),
        body: await messageText(db, req.user.practice_id, 'treatment_plan', { first_name: patient.first_name, link: url }, patientLang(patient)),
      });
    }
    await audit(db, req, 'treatment_plan.present', 'treatment_plans', plan.id);
    res.json({ url, message });
  });

  // This benefit year vs next: what insurance has left, and whether doing part of the plan after the
  // year renews would get more of it paid (work in the plan's order until this year's maximum runs out).
  r.get('/treatment-plans/:tid/benefit-years', requirePermission('clinical:read'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    const policy = await primaryPolicy(db, plan.practice_id, plan.patient_id);
    if (!policy) return res.json({ policy: null });
    const procs = await db.all("SELECT * FROM procedures WHERE treatment_plan_id = ? AND status = 'planned' ORDER BY priority, id", plan.id);
    const today = (await practiceNow(db, plan.practice_id)).slice(0, 10);
    const { end: renews } = benefitYear(await withPlan(db, policy), today);
    const all = await estimateCoverage(db, policy, procs);
    const limited = all.items.some((i) => i.notes.some((n) => /annual maximum/.test(n)));
    const out = {
      policy: { carrier_name: policy.carrier_name, annual_max: all.policy?.annual_max },
      remaining_now: all.remaining?.annual_max != null ? all.remaining.annual_max + all.total_insurance : null,
      renews, all_now: { insurance: all.total_insurance, patient: all.total_patient }, split: null,
    };
    if (limited && procs.length > 1) {
      // The longest start of the plan that this year's maximum still covers in full; the rest waits.
      // The procedure that reaches the maximum either waits for next year or goes first, part-covered:
      // whichever gets more paid.
      let hit = procs.length;
      for (let i = 1; i <= procs.length; i++) {
        const e = await estimateCoverage(db, policy, procs.slice(0, i));
        if (e.items.some((x) => x.notes.some((n) => /annual maximum/.test(n)))) { hit = i; break; }
      }
      let best = null;
      for (const cut of [hit - 1, hit].filter((c) => c > 0 && c < procs.length)) {
        const now = await estimateCoverage(db, policy, procs.slice(0, cut));
        const later = await estimateCoverage(db, policy, procs.slice(cut), { asOf: renews });
        if (!best || now.total_insurance + later.total_insurance > best.now.total_insurance + best.later.total_insurance) best = { cut, now, later };
      }
      if (best) {
        const { cut, now, later } = best;
        const insurance = now.total_insurance + later.total_insurance;
        if (insurance > all.total_insurance) {
          const line = (p) => ({ id: p.id, code: p.code, description: p.description, tooth: p.tooth, fee: p.fee });
          out.split = {
            this_year: { procedures: procs.slice(0, cut).map(line), insurance: now.total_insurance, patient: now.total_patient },
            next_year: { from: renews, procedures: procs.slice(cut).map(line), insurance: later.total_insurance, patient: later.total_patient },
            insurance, patient: now.total_patient + later.total_patient, saves: insurance - all.total_insurance,
          };
        }
      }
    }
    res.json(out);
  });

  r.get('/treatment-plans/:tid/pdf', requirePermission('clinical:read'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${pdfFilename(plan)}.pdf"` }).send(await planPdf(db, plan));
  });

  r.get('/treatment-plans/:tid', requirePermission('clinical:read'), async (req, res) => {
    const plan = await findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
    const view = await planView(db, plan);
    res.json({
      ...view,
      financing: financingOptions(await db.get('SELECT financing FROM practices WHERE id = ?', req.user.practice_id), view.estimate.total_patient),
      patient: await db.get('SELECT id, first_name, last_name, dob, address, city, state, zip, phone FROM patients WHERE id = ?', plan.patient_id),
      practice: await db.get('SELECT name, address, city, state, zip, phone FROM practices WHERE id = ?', req.user.practice_id),
    });
  });

  // ---- Prescriptions ----
  r.get('/rx/favorites', (_req, res) => res.json(RX_FAVORITES));

  r.get('/patients/:id/prescriptions', requirePermission('clinical:read'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json((await db.all(
      `${RX_SELECT} WHERE rx.practice_id = ? AND rx.patient_id = ? ORDER BY rx.id DESC`, req.user.practice_id, patient.id,
    )).map(rxView));
  });

  // ---- E-prescribing ----
  const RX_SELECT = 'SELECT rx.*, pv.name AS provider_name, pv.npi AS provider_npi, pv.license_number, pv.dea_number FROM prescriptions rx JOIN providers pv ON pv.id = rx.provider_id';
  const rxView = (rx) => rx && { ...rx, pharmacy: rx.pharmacy ? JSON.parse(rx.pharmacy) : null };
  r.get('/erx', (_req, res) => res.json({ mode: erx.mode, name: erx.name, electronic: erx.electronic, in_app: erx.inApp, epcs: erx.epcs, pharmacy_search: !!erx.searchPharmacies }));
  r.get('/pharmacies', requirePermission('clinical:read'), (req, res) => {
    if (!erx.searchPharmacies) throw new HttpError(409, `Pharmacy search happens in ${erx.name}`);
    res.json(erx.searchPharmacies(String(req.query.q || '')));
  });
  r.put('/patients/:id/pharmacy', requirePermission('patients:write'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const p = req.body?.pharmacy ? pick(req.body.pharmacy, ['ncpdp', 'name', 'address', 'city', 'state', 'zip', 'phone', 'fax']) : null;
    if (p) requireFields(p, ['name']);
    await db.run('UPDATE patients SET preferred_pharmacy = ? WHERE id = ?', p ? JSON.stringify(p) : null, patient.id);
    await audit(db, req, 'patient.pharmacy', 'patients', patient.id);
    res.json({ preferred_pharmacy: p });
  });
  // DoseSpot: open the patient's chart in the certified e-prescribing screens (single sign-on).
  r.get('/erx/launch', requirePermission('clinical:sign'), async (req, res) => {
    if (!erx.ssoUrl) throw new HttpError(409, 'Single sign-on e-prescribing is not configured');
    const patient = await findOr404(db, 'patients', req.query.patient_id, req.user.practice_id, 'Patient');
    const provider = await db.get('SELECT * FROM providers WHERE practice_id = ? AND user_id = ? AND erx_user_id IS NOT NULL', req.user.practice_id, req.user.id);
    if (!provider) throw new HttpError(403, `Your login isn't linked to a ${erx.name} prescriber (Settings → Providers → e-Rx user ID)`);
    await audit(db, req, 'erx.launch', 'patients', patient.id);
    res.json({ url: erx.ssoUrl({ userId: provider.erx_user_id, patient }) });
  });

  r.post('/patients/:id/prescriptions', requirePermission('clinical:sign'), async (req, res) => {
    const patient = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const row = pick(req.body, ['provider_id', 'drug', 'strength', 'sig', 'quantity', 'refills', 'dispense_as_written', 'notes', 'schedule']);
    requireFields(row, ['provider_id', 'drug', 'sig', 'quantity']);
    const provider = await findOr404(db, 'providers', row.provider_id, req.user.practice_id, 'Provider');
    if (provider.type === 'hygienist') throw new HttpError(400, 'Prescriptions must be written by a dentist or specialist');
    // A real, countable quantity (a prescription is dispensed from it, controlled ones especially), whole refills.
    if (!/[1-9]/.test(String(row.quantity)) || /^\s*-/.test(String(row.quantity)) || String(row.quantity).length > 40) throw new HttpError(400, 'quantity must be a positive amount, e.g. 20 or "20 tablets"');
    if (row.refills != null && row.refills !== '' && !(Number.isInteger(Number(row.refills)) && Number(row.refills) >= 0 && Number(row.refills) <= 11)) throw new HttpError(400, 'refills must be a whole number, 0-11');
    row.refills = Number(row.refills) || 0;
    for (const [k, n] of [['drug', 200], ['strength', 100], ['sig', 500], ['notes', 1000]]) if (row[k] != null) row[k] = String(row[k]).slice(0, n);
    // Surface allergies at the moment of prescribing.
    const allergy = allergyWarning(patient.allergies, `${row.drug} ${row.strength || ''}`);
    if (allergy && !req.body.override_allergy) throw new HttpError(409, allergy, { allergy_warning: true });
    if (row.schedule && !['II', 'III', 'IV', 'V'].includes(row.schedule)) throw new HttpError(400, 'schedule must be II, III, IV or V');
    // A known controlled substance is always treated as one, whatever the form said.
    row.schedule = stricterSchedule(row.schedule || null, controlledSchedule(`${row.drug} ${row.strength || ''}`));
    if (row.schedule) {
      if (!provider.dea_number) throw new HttpError(400, `${provider.name} needs a DEA number (Settings → Providers) to prescribe controlled substances`);
      if (row.schedule === 'II' && row.refills > 0) throw new HttpError(400, 'Schedule II prescriptions cannot have refills');
    }
    const send = !!req.body.send;
    let signature = null;
    let pharmacy = null;
    if (send) {
      if (!erx.inApp) throw new HttpError(409, erx.ssoUrl ? `Write electronic prescriptions in ${erx.name}` : 'Electronic prescribing is not set up — print instead');
      pharmacy = patient.preferred_pharmacy ? JSON.parse(patient.preferred_pharmacy) : null;
      if (!pharmacy?.ncpdp) throw new HttpError(400, "Choose the patient's pharmacy first");
      // Electronic prescriptions carry the prescriber's signature, so only they can send one.
      if (provider.user_id !== req.user.id) throw new HttpError(403, `Only ${provider.name} can sign and send this prescription — save it for them to send, or print it for a wet signature`);
      signature = await checkEpcs(db, { user: req.user, provider, schedule: row.schedule, refills: row.refills, otp: req.body.otp, secret });
    }
    const id = await insert(db, 'prescriptions', {
      ...row, practice_id: req.user.practice_id, patient_id: patient.id, created_by: req.user.id,
      status: send ? 'signed' : 'printed', pharmacy: pharmacy ? JSON.stringify(pharmacy) : null,
      signed_by: signature?.signed_by ?? (send ? req.user.id : null), signed_two_factor: signature?.two_factor ? 1 : 0,
    });
    await audit(db, req, send ? 'prescription.sign' : 'prescription.create', 'prescriptions', id, { drug: row.drug, schedule: row.schedule || null, electronic: send, two_factor: !!signature, ...(allergy ? { allergy_override: allergy } : {}) });
    if (send) {
      try {
        const out = await erx.transmit({ ...row, id, pharmacy_ncpdp: pharmacy.ncpdp, patient, provider });
        await recorded(db, 'prescriptions', id, () => db.run("UPDATE prescriptions SET status = ?, erx_reference = ?, transmitted_at = datetime('now') WHERE id = ?", out.status, out.reference, id));
        await audit(db, req, 'prescription.transmit', 'prescriptions', id, { reference: out.reference, pharmacy: pharmacy.ncpdp });
      } catch (err) {
        await recorded(db, 'prescriptions', id, () => db.run("UPDATE prescriptions SET status = 'error', erx_error = ? WHERE id = ?", String(err.message).slice(0, 300), id));
      }
    }
    res.status(201).json(rxView(await db.get(`${RX_SELECT} WHERE rx.id = ?`, id)));
  });

  r.get('/prescriptions/:rid', requirePermission('clinical:read'), async (req, res) => {
    const rx = await findOr404(db, 'prescriptions', req.params.rid, req.user.practice_id, 'Prescription');
    await audit(db, req, 'prescription.print', 'prescriptions', rx.id);
    res.json({
      ...rxView(await db.get(`${RX_SELECT} WHERE rx.id = ?`, rx.id)),
      patient: await db.get('SELECT first_name, last_name, dob, address, city, state, zip, allergies FROM patients WHERE id = ?', rx.patient_id),
      practice: await db.get('SELECT name, address, city, state, zip, phone FROM practices WHERE id = ?', req.user.practice_id),
    });
  });

  return r;
}

// Patient-facing treatment plan review & e-signature.
// Holding the link isn't enough to see the plan: the patient confirms their date of birth first and gets
// a short-lived pass for this plan (sent back as X-Plan-Pass, or ?pass= for the PDF download).
export const planPass = (plan, secret) => signToken({ sub: plan.id, aud: 'tp-view' }, secret, 2 * 3600);
export function publicCasePresentation({ db, storage, secret }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });
  const dobLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
  const byToken = async (token, req) => {
    const plan = await db.get('SELECT * FROM treatment_plans WHERE sign_token_hash = ?', hashToken(token));
    if (!plan) throw new HttpError(404, 'This link is no longer valid');
    // Links expire; once signed, the patient can look at what they signed for a week.
    const signedLongAgo = plan.signed_at && Date.parse(`${plan.signed_at.replace(' ', 'T')}Z`) < Date.now() - 7 * 86400_000;
    if (signedLongAgo || (plan.sign_token_expires_at && plan.sign_token_expires_at < new Date().toISOString())) throw new HttpError(410, 'This link has expired — please ask the office for a new one');
    if (req && !(await passOk(req, plan))) {
      const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', plan.practice_id);
      throw new HttpError(403, 'Enter your date of birth to see your plan', { dob_required: true, practice });
    }
    return plan;
  };
  const passOk = async (req, plan) => {
    const patient = await db.get('SELECT dob FROM patients WHERE id = ?', plan.patient_id);
    if (!patient?.dob) return true; // nothing on file to check against
    const pass = verifyToken(req.get('X-Plan-Pass') || req.query.pass || '', secret);
    return !!pass && pass.aud === 'tp-view' && pass.sub === plan.id;
  };

  r.post('/tp/:token/verify', dobLimiter, async (req, res) => {
    const plan = await byToken(req.params.token);
    const patient = await db.get('SELECT dob FROM patients WHERE id = ?', plan.patient_id);
    const dob = String(req.body?.dob || '').trim();
    if (patient?.dob && dob !== patient.dob) {
      await db.run('UPDATE treatment_plans SET sign_token_failures = sign_token_failures + 1 WHERE id = ?', plan.id);
      const tries = Number((await db.get('SELECT sign_token_failures AS n FROM treatment_plans WHERE id = ?', plan.id)).n);
      await audit(db, { ip: req.ip, user: { practice_id: plan.practice_id, id: null } }, 'treatment_plan.link_dob_failed', 'treatment_plans', plan.id, { patient_id: plan.patient_id, tries });
      if (tries >= MAX_DOB_TRIES) {
        await db.run('UPDATE treatment_plans SET sign_token_hash = NULL WHERE id = ?', plan.id);
        throw new HttpError(410, 'This link has been turned off after too many tries — please ask the office for a new one');
      }
      throw new HttpError(403, "That date of birth doesn't match our records", { dob_required: true });
    }
    await db.run('UPDATE treatment_plans SET sign_token_failures = 0 WHERE id = ?', plan.id);
    res.json({ pass: planPass(plan, secret) });
  });
  const publicView = async (plan) => {
    const live = await planView(db, plan);
    // After signing, the patient sees exactly the version they signed.
    const v = plan.signed_snapshot ? { ...live, ...JSON.parse(plan.signed_snapshot) } : live;
    const patient = await db.get('SELECT first_name, language FROM patients WHERE id = ?', plan.patient_id);
    const practice = await db.get('SELECT name, phone, address, city, state, zip, financing FROM practices WHERE id = ?', plan.practice_id);
    const financing = financingOptions(practice, v.estimate.total_patient);
    delete practice.financing;
    return {
      financing,
      name: v.name, status: v.status, notes: v.notes, signed_at: v.signed_at, signature_name: v.signature_name, first_name: patient.first_name, language: patientLang(patient), practice,
      procedures: v.procedures.map((p) => ({ code: p.code, description: p.description, tooth: p.tooth, surfaces: p.surfaces, fee: p.fee, status: p.status })),
      estimate: { ...v.estimate, items: v.estimate.items.map(({ procedure_id: _, ...rest }) => rest) },
    };
  };

  // Anyone holding the link can read the plan, so each look is on the record.
  const linkAudit = (req, plan, action) => audit(db, { ip: req.ip, user: { practice_id: plan.practice_id, id: null } }, action, 'treatment_plans', plan.id, { patient_id: plan.patient_id });
  r.get('/tp/:token', async (req, res) => {
    const plan = await byToken(req.params.token, req);
    await linkAudit(req, plan, 'treatment_plan.link_view');
    res.json(await publicView(plan));
  });
  r.get('/tp/:token/pdf', async (req, res) => {
    const plan = await byToken(req.params.token, req);
    await linkAudit(req, plan, 'treatment_plan.link_pdf');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${pdfFilename(plan)}.pdf"` }).send(await planPdf(db, plan));
  });

  r.post('/tp/:token', limiter, async (req, res) => {
    const plan = await byToken(req.params.token, req);
    if (plan.signed_at) throw new HttpError(409, 'This plan has already been signed');
    const name = String(req.body?.signature_name || '').trim();
    if (name.length < 2) throw new HttpError(400, 'Type your full name to sign');
    const image = req.body?.signature_image;
    if (image != null && (typeof image !== 'string' || !image.startsWith('data:image/png;base64,') || image.length > 300_000)) throw new HttpError(400, 'Invalid signature image');
    if (!req.body?.consent) throw new HttpError(400, 'Please confirm you have read and understand the plan');
    const snapshot = JSON.stringify(snapshotOf(await planView(db, plan)));
    const signed = await recorded(db, 'treatment_plans', plan.id, () => db.run(
      "UPDATE treatment_plans SET status = 'accepted', accepted_at = COALESCE(accepted_at, datetime('now')), signed_at = datetime('now'), signature_name = ?, signature_image = ?, signed_snapshot = ? WHERE id = ? AND signed_at IS NULL",
      name, image || null, snapshot, plan.id,
    ));
    if (!signed.changes) throw new HttpError(409, 'This plan has already been signed');
    await audit(db, { ip: req.ip, user: { practice_id: plan.practice_id, id: null } }, 'treatment_plan.patient_signed', 'treatment_plans', plan.id);
    // The signed copy is filed in the chart, so it's there even if the plan is edited later.
    if (storage) {
      const fresh = await db.get('SELECT * FROM treatment_plans WHERE id = ?', plan.id);
      const pdf = await planPdf(db, fresh);
      const saved = await storage.save(plan.practice_id, pdf);
      await insert(db, 'documents', {
        practice_id: plan.practice_id, patient_id: plan.patient_id, category: 'consent', filename: `${pdfFilename(fresh)}.pdf`, mime: 'application/pdf', size: pdf.length,
        storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, notes: `Signed by ${name}`,
      });
    }
    res.json(await publicView(await db.get('SELECT * FROM treatment_plans WHERE id = ?', plan.id)));
  });
  return r;
}
