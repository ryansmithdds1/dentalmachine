import { createHash } from 'node:crypto';
import { HttpError } from './auth.js';
import { insert, change, recorded, audit, localNow } from './util.js';
import { cleanFields, fillFields, seedTemplates, DEFAULT_TEMPLATES } from './formtemplates.js';
import { PdfDoc, dataUrlImage } from './pdf.js';
import { CONSENT_LIBRARY, LEGAL_NOTE, libraryItem } from './consentlib.js';
import { publish } from './events.js';

// Consents, start to finish (C1–C4; docs/workflows/specs/C-consents.md).
//
// A consent is a practice form (form_templates, kind 'consent') that one patient needs for some treatment. It is
// attached automatically from the procedures on a visit or a plan (the codes and categories set on the form),
// sent or handed over like any other form, and once signed (or declined) it is a fixed record:
//   - the exact wording the patient saw (form_template_versions + the filled-in text, hashed),
//   - who signed (the patient, or a parent/guardian for a minor), when, on what device, from what address,
//   - who witnessed, if the office asks for a witness,
//   - the signed PDF filed in Documents against the visit, and the procedures marked consented.
// Nothing edits it afterwards (a database trigger refuses); a new version needs a new signature (supersede).

export const hashOf = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
export const RELATIONSHIPS = ['self', 'parent', 'guardian', 'representative'];
const CATEGORIES = ['diagnostic', 'preventive', 'restorative', 'endodontics', 'periodontics', 'prosthodontics', 'oral_surgery', 'orthodontics', 'implants', 'adjunctive'];

// The Spanish wording keeps the English fields' keys and types, so answers mean the same in either language.
export function alignSpanish(fields, es) {
  if (es == null || es === '') return null;
  if (!Array.isArray(es) || es.length !== fields.length) throw new HttpError(400, 'The Spanish version needs the same fields, in the same order, as the English one');
  return es.map((f, i) => {
    const en = fields[i];
    if (f?.type !== en.type) throw new HttpError(400, `Spanish field ${i + 1} must be a ${en.type} like the English one`);
    const label = String(f.label || '').trim().slice(0, 300);
    const text = String(f.text || '').trim().slice(0, 8000);
    if (en.type === 'paragraph' && !text) throw new HttpError(400, `Spanish field ${i + 1}: a paragraph needs text`);
    if (en.type !== 'paragraph' && !label) throw new HttpError(400, `Spanish field ${i + 1}: add a label`);
    const out = { ...en, label };
    if (text) out.text = text; else delete out.text;
    if (en.type === 'select') {
      const options = Array.isArray(f.options) ? f.options.map((o) => String(o).trim()).filter(Boolean) : [];
      // The stored answer is the English option; Spanish options are shown in its place (same order).
      if (options.length !== en.options.length) throw new HttpError(400, `Spanish field ${i + 1}: give a translation for each choice`);
      out.options_es = options;
    }
    return out;
  });
}

export const cleanCategories = (v) => {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  for (const c of list) if (!CATEGORIES.includes(c)) throw new HttpError(400, `Unknown procedure category: ${c}`);
  return [...new Set(list)].join(', ') || null;
};

// Does this consent form apply to a procedure? By code prefix ("D71" covers D7140) or by category.
export function consentApplies(template, proc) {
  const codes = String(template.procedure_codes || '').split(/[\s,]+/).filter(Boolean);
  const cats = String(template.procedure_categories || '').split(/[\s,]+/).filter(Boolean);
  return codes.some((p) => String(proc.code).startsWith(p)) || (!!proc.category && cats.includes(proc.category));
}

// ---- Versions (C1) ----
// The version row for a template's current wording, written the first time it's needed. If the wording changed
// without the version moving on (renamed, Spanish added), it becomes a new version: a signed form always points
// at wording that never changes.
export async function currentVersion(db, templateOrId, userId = null) {
  let t = typeof templateOrId === 'object' ? templateOrId : await db.get('SELECT * FROM form_templates WHERE id = ?', templateOrId);
  if (!t) throw new HttpError(404, 'Form not found');
  const content = { name: t.name, fields: JSON.parse(t.fields), fields_es: t.fields_es ? JSON.parse(t.fields_es) : null };
  const hash = hashOf(content);
  const have = await db.get('SELECT * FROM form_template_versions WHERE template_id = ? AND version = ?', t.id, t.version);
  if (have && have.content_hash === hash) return have;
  if (have) {
    const next = Number((await db.get('SELECT MAX(version) AS v FROM form_template_versions WHERE template_id = ?', t.id)).v) + 1;
    await recorded(db, 'form_templates', t.id, () => db.run("UPDATE form_templates SET version = ?, updated_at = datetime('now') WHERE id = ? AND version = ?", next, t.id, t.version));
    t = await db.get('SELECT * FROM form_templates WHERE id = ?', t.id);
    if (t.version !== next) return currentVersion(db, t, userId);
  }
  await db.run(
    'INSERT INTO form_template_versions (practice_id, template_id, version, name, fields, fields_es, content_hash, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    t.practice_id, t.id, t.version, t.name, t.fields, t.fields_es || null, hash, userId,
  );
  return await db.get('SELECT * FROM form_template_versions WHERE template_id = ? AND version = ?', t.id, t.version);
}

// ---- The library (C1) ----
export async function libraryState(db, practiceId) {
  await seedTemplates(db, practiceId); // the starter forms first, so the library adopts them instead of doubling them
  const have = await db.all('SELECT id, name, library_key, version, active, legal_review FROM form_templates WHERE practice_id = ?', practiceId);
  return CONSENT_LIBRARY.map((x) => {
    const t = have.find((h) => h.library_key === x.key) || have.find((h) => !h.library_key && h.name === x.name);
    return {
      key: x.key, name: x.name, kind: x.kind, procedure_codes: x.procedure_codes || null, procedure_categories: x.procedure_categories || null,
      witness: !!x.witness, spanish: true, installed: !!t, template_id: t?.id ?? null, version: t?.version ?? null, legal_review: t ? !!t.legal_review : true, note: LEGAL_NOTE,
    };
  });
}

// Adds library consents to the practice's forms (once: a second install finds the same form). A form the office
// already has under the same name is adopted — its own wording kept — and gains the Spanish version if it has none.
export async function installLibrary(db, req, keys) {
  const pid = req.user.practice_id;
  await seedTemplates(db, pid);
  const out = [];
  for (const key of keys) {
    const item = libraryItem(key);
    if (!item) throw new HttpError(400, `Unknown consent: ${key}`);
    const fields = cleanFields(item.fields);
    const es = alignSpanish(fields, item.fields_es);
    const id = await db.tx(async () => {
      const byKey = await db.get('SELECT * FROM form_templates WHERE practice_id = ? AND library_key = ?', pid, key);
      if (byKey) return byKey.id;
      const byName = await db.get('SELECT * FROM form_templates WHERE practice_id = ? AND library_key IS NULL AND name = ?', pid, item.name);
      if (byName) {
        // The app's starter form nobody has edited takes the library's wording (with Spanish); a form the office
        // wrote or changed keeps its own words and gets Spanish only if the library's lines up with it.
        const starter = DEFAULT_TEMPLATES.find((d) => d.name === item.name);
        const untouched = starter && byName.fields === JSON.stringify(cleanFields(starter.fields)) && !byName.fields_es;
        let fieldsEs = byName.fields_es;
        if (!untouched && !fieldsEs) { try { fieldsEs = JSON.stringify(alignSpanish(JSON.parse(byName.fields), item.fields_es)); } catch { fieldsEs = null; } }
        const wording = untouched ? { fields: JSON.stringify(fields), fields_es: JSON.stringify(es), description: LEGAL_NOTE, legal_review: 1 } : { fields_es: fieldsEs };
        const changed = untouched || fieldsEs !== byName.fields_es;
        await change(db, 'form_templates', byName.id, {
          library_key: key, ...wording, procedure_categories: byName.procedure_categories || item.procedure_categories || null,
          witness: byName.witness || item.witness || 0, education_slugs: byName.education_slugs || (item.education ? JSON.stringify(item.education) : null),
          ...(changed ? { version: byName.version + 1 } : {}), updated_at: new Date().toISOString(),
        });
        return byName.id;
      }
      return await insert(db, 'form_templates', {
        practice_id: pid, name: item.name, kind: item.kind, description: LEGAL_NOTE, fields: JSON.stringify(fields), fields_es: JSON.stringify(es),
        procedure_codes: item.procedure_codes || null, procedure_categories: item.procedure_categories || null, auto_send: item.auto_send ?? 1, renew_months: item.renew_months ?? 0,
        due_rule: item.due_rule || null, witness: item.witness || 0, legal_review: 1, library_key: key, education_slugs: item.education ? JSON.stringify(item.education) : null,
      });
    });
    await currentVersion(db, id, req.user.id);
    await audit(db, req, 'consent_library.install', 'form_templates', id, { key });
    out.push(id);
  }
  return out;
}

// ---- Attaching consents to treatment (C2) ----
const PROC_COLS = 'id, patient_id, code, description, tooth, surfaces, fee, category, provider_id, treatment_plan_id, appointment_id, status, consent_id, consented_at';
export async function proceduresFor(db, practiceId, { patientId, appointmentId, planId, procedureIds }) {
  if (appointmentId) return db.all(`SELECT ${PROC_COLS} FROM procedures WHERE practice_id = ? AND appointment_id = ? AND status = 'planned' ORDER BY id`, practiceId, appointmentId);
  if (planId) return db.all(`SELECT ${PROC_COLS} FROM procedures WHERE practice_id = ? AND treatment_plan_id = ? AND status = 'planned' ORDER BY id`, practiceId, planId);
  const ids = [...new Set((procedureIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const rows = await db.all(`SELECT ${PROC_COLS} FROM procedures WHERE practice_id = ? AND patient_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, practiceId, patientId, ...ids);
  if (rows.length !== ids.length) throw new HttpError(404, 'Procedure not found');
  return rows;
}

const consentTemplates = (db, practiceId) => db.all(
  "SELECT * FROM form_templates WHERE practice_id = ? AND active = 1 AND kind = 'consent' AND (COALESCE(procedure_codes, '') <> '' OR COALESCE(procedure_categories, '') <> '')", practiceId,
);

// Which consents this treatment needs, and what's already there. With attach, the missing ones are created (safe to
// repeat: one live consent per form and context). A form already signed for the same procedures elsewhere (the plan
// was signed, now the visit is booked) counts; one the patient declined doesn't — they're asked again.
export async function consentsForTreatment(db, { practiceId, patientId, appointmentId = null, planId = null, procedureIds = null, attach = false, userId = null, source = null }) {
  const procs = await proceduresFor(db, practiceId, { patientId, appointmentId, planId, procedureIds });
  const contextKey = appointmentId ? `appt:${appointmentId}` : planId ? `plan:${planId}` : `procs:${procs.map((p) => p.id).join(',')}`;
  if (!procs.length) return { contextKey, procedures: [], consents: [] };
  const templates = await consentTemplates(db, practiceId);
  const signed = await db.all("SELECT * FROM consents WHERE practice_id = ? AND patient_id = ? AND status = 'signed'", practiceId, patientId);
  const out = [];
  for (const t of templates) {
    const group = procs.filter((p) => consentApplies(t, p)).map((p) => p.id);
    if (!group.length) continue;
    const live = await db.get("SELECT * FROM consents WHERE practice_id = ? AND context_key = ? AND template_id = ? AND status <> 'superseded'", practiceId, contextKey, t.id);
    if (live) {
      // Work added to the visit before it was signed is added to the consent.
      if (['needed', 'sent'].includes(live.status) && JSON.stringify(group) !== live.procedure_ids && attach) {
        await change(db, 'consents', live.id, { procedure_ids: JSON.stringify(group), updated_at: new Date().toISOString() });
        live.procedure_ids = JSON.stringify(group);
      }
      out.push({ ...live, template_name: t.name });
      continue;
    }
    const cover = signed.find((c) => c.template_id === t.id && group.every((id) => JSON.parse(c.procedure_ids).includes(id)));
    if (cover) { out.push({ ...cover, template_name: t.name, covers: true }); continue; }
    if (!attach) { out.push({ id: null, template_id: t.id, template_name: t.name, status: 'needed', procedure_ids: JSON.stringify(group), context_key: contextKey }); continue; }
    const appt = appointmentId ? await db.get('SELECT location_id FROM appointments WHERE id = ?', appointmentId) : null;
    await db.run(
      `INSERT INTO consents (practice_id, location_id, patient_id, template_id, context_key, appointment_id, treatment_plan_id, procedure_ids, status, created_by, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'needed', ?, ?) ON CONFLICT DO NOTHING`,
      practiceId, appt?.location_id ?? null, patientId, t.id, contextKey, appointmentId, planId ?? (procs.every((p) => p.treatment_plan_id && p.treatment_plan_id === procs[0].treatment_plan_id) ? procs[0].treatment_plan_id : null),
      JSON.stringify(group), userId, source,
    );
    const row = await db.get("SELECT * FROM consents WHERE practice_id = ? AND context_key = ? AND template_id = ? AND status <> 'superseded'", practiceId, contextKey, t.id);
    await audit(db, { user: { practice_id: practiceId, id: userId } }, 'consent.attach', 'consents', row.id, { patient_id: patientId, template: t.name, procedures: group, context: contextKey }, { patientId, source: source || undefined });
    out.push({ ...row, template_name: t.name });
  }
  return { contextKey, procedures: procs, consents: out };
}

// ---- Filling in (C2) ----
const money = (cents) => `$${((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export async function consentContext(db, { practiceId, patientId, procedureIds = [], appointmentId = null }) {
  const patient = await db.get('SELECT first_name, last_name, dob FROM patients WHERE id = ? AND practice_id = ?', patientId, practiceId);
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', practiceId);
  const ids = procedureIds.map(Number).filter(Number.isInteger);
  const procs = ids.length ? await db.all(`SELECT code, description, tooth, surfaces, fee, provider_id FROM procedures WHERE practice_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, practiceId, ...ids) : [];
  const appt = appointmentId ? await db.get('SELECT provider_id FROM appointments WHERE id = ?', appointmentId) : null;
  const providerId = appt?.provider_id || procs.find((p) => p.provider_id)?.provider_id;
  const provider = providerId ? (await db.get('SELECT name FROM providers WHERE id = ?', providerId))?.name : '';
  return {
    patient: patient ? `${patient.first_name} ${patient.last_name}` : '', first_name: patient?.first_name || '', practice: practice?.name || '',
    procedures: [...new Set(procs.map((p) => p.description || p.code))].join(', '),
    procedure_list: procs.map((p) => `${p.code} ${p.description}${p.tooth ? ` #${p.tooth}${p.surfaces ? ` ${p.surfaces}` : ''}` : ''} (${money(p.fee)})`).join('; ') || '—',
    teeth: [...new Set(procs.map((p) => p.tooth).filter(Boolean))].map((t) => `#${t}`).join(', ') || '—',
    provider: provider || '', fees: procs.length ? money(procs.reduce((s, p) => s + (p.fee || 0), 0)) : '—',
    date: new Date().toISOString().slice(0, 10),
  };
}

// The wording shown in a language: Spanish when the form has it, otherwise English.
export function wordingFor(version, lang) {
  const en = JSON.parse(version.fields);
  const es = version.fields_es ? JSON.parse(version.fields_es) : null;
  const useEs = lang === 'es' && !!es;
  return { lang: useEs ? 'es' : 'en', fields: useEs ? es.map((f) => (f.options_es ? { ...f, shown_options: f.options_es } : f)) : en };
}

// ---- Minors ----
export function ageOn(dob, day) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(dob || '')) return null;
  const [y, m, d] = dob.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = day.slice(0, 10).split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}
// A minor's consent is signed by a parent or guardian, who is named.
export function checkSigner(patient, body, today) {
  const age = ageOn(patient.dob, today);
  const minor = age != null && age < 18;
  const relationship = RELATIONSHIPS.includes(body?.signer_relationship) ? body.signer_relationship : minor ? null : 'self';
  if (!relationship) throw new HttpError(400, 'A parent or guardian must sign for a patient under 18');
  if (minor && relationship === 'self') throw new HttpError(400, 'A parent or guardian must sign for a patient under 18');
  return { minor, relationship };
}

// ---- The signed record (C4) ----
const fmtDate = (d) => (/^\d{4}-\d{2}-\d{2}/.test(d || '') ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : d || '');
const REL = { self: 'the patient', parent: 'parent', guardian: 'legal guardian', representative: 'legal representative' };
export function recordPdf({ practice, patient, title, version, lang, fields, answers = {}, photos = [], signature, signerName, relationship, signedAt, ip, device, via, witness, education = [], declined = null, localTime }) {
  const doc = new PdfDoc({ footer: `${practice.name} · ${patient.first_name} ${patient.last_name} · ${title}` });
  doc.text(practice.name, { size: 9, color: [0.4, 0.43, 0.5] });
  doc.text(declined ? `${title} — DECLINED` : title, { size: 17, bold: true, gap: 2 });
  doc.text(`Patient: ${patient.first_name} ${patient.last_name}${patient.dob ? ` · Date of birth: ${fmtDate(patient.dob)}` : ''}`, { size: 10 });
  doc.rule();
  for (const f of fields) {
    const v = f.key ? answers[f.key] : undefined;
    if (f.type === 'heading') { doc.space(4); doc.text(f.label, { size: 12.5, bold: true }); continue; }
    if (f.type === 'paragraph') { doc.text(f.text); continue; }
    if (f.text) doc.text(f.text);
    if (f.type === 'signature') continue;
    if (f.type === 'photo') {
      doc.text(f.label, { bold: true, gap: 2 });
      const p = photos.find((x) => x.key === f.key);
      if (p) doc.image(dataUrlImage(p.dataUrl), { maxW: 300, maxH: 190, border: true });
      else doc.text('Not provided', { color: [0.45, 0.48, 0.55] });
      continue;
    }
    if (declined) continue;
    if (f.type === 'checkbox') doc.text(`${v ? '[x]' : '[ ]'} ${f.label}`);
    else if (f.type === 'initials') doc.text(`${f.label}   Initials: ${v || '____'}`);
    else {
      doc.text(f.label, { bold: true, gap: 1 });
      doc.text(String(f.type === 'yesno' ? (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '—') : f.type === 'date' ? fmtDate(v) || '—' : v || '—'), { indent: 10 });
    }
  }
  if (declined) {
    doc.space(6);
    doc.text('The patient declined this consent.', { bold: true });
    if (declined.reason) doc.text(`Reason given: ${declined.reason}`);
    if (declined.recordedBy) doc.text(`Recorded by ${declined.recordedBy}.`);
  }
  if (signature || signerName) {
    doc.space(6);
    doc.text(declined ? 'Signature (declining)' : 'Signature', { bold: true, gap: 2 });
    if (signature) doc.image(dataUrlImage(signature), { maxW: 240, maxH: 80, border: true });
    if (signerName) doc.text(`Signed by ${signerName}${relationship && relationship !== 'self' ? ` (${REL[relationship]} of the patient)` : ''}`, { size: 9.5 });
  }
  if (witness) {
    doc.space(4);
    doc.text('Witness', { bold: true, gap: 2 });
    if (witness.signature) doc.image(dataUrlImage(witness.signature), { maxW: 200, maxH: 60, border: true });
    doc.text(`Witnessed by ${witness.name}`, { size: 9.5 });
  }
  if (education.length) {
    doc.space(4);
    doc.text('Education given', { bold: true, gap: 2 });
    for (const line of education) doc.text(`• ${line}`, { size: 9.5 });
  }
  doc.rule();
  doc.text(
    `${declined ? 'Declined' : 'Signed electronically'} ${signedAt} UTC${localTime ? ` (${localTime} office time)` : ''}${via ? ` · ${via}` : ''}${ip ? ` · from ${ip}` : ''}${device ? ` · device: ${device}` : ''}. `
      + `Form "${title}" version ${version}${lang === 'es' ? ' (Spanish)' : ''}.`,
    { size: 8.5, color: [0.4, 0.43, 0.5] },
  );
  return doc.toBuffer();
}

export const VIA = { link: 'link sent to the patient', kiosk: 'office iPad (kiosk)', handoff: 'office device handed to the patient', chair: 'recorded at the chair' };

// Marks a consent signed with its fixed record, and the procedures it covers as consented. Inside the caller's
// transaction (the form submission).
export async function finalizeConsent(db, consent, { formId, documentId, versionId, version, lang, content, signerName, relationship, signedAt, ip, device, via, witness }) {
  const claimed = await db.run("UPDATE consents SET status = 'signed', updated_at = datetime('now') WHERE id = ? AND status IN ('needed','sent')", consent.id);
  if (!claimed.changes) throw new HttpError(409, 'This consent was already signed or declined');
  await change(db, 'consents', consent.id, {
    version_id: versionId, template_version: version, lang, content, content_hash: hashOf(content), patient_form_id: formId, document_id: documentId,
    signer_name: signerName, signer_relationship: relationship, signed_at: signedAt, signed_via: via, ip: ip || null, device: device || null,
    witness_user_id: witness?.userId ?? null, witness_name: witness?.name ?? null, witness_signature: witness?.signature ?? null,
  });
  for (const pid of JSON.parse(consent.procedure_ids || '[]')) {
    await recorded(db, 'procedures', pid, () => db.run('UPDATE procedures SET consent_id = ?, consented_at = ? WHERE id = ? AND practice_id = ?', consent.id, signedAt, pid, consent.practice_id));
  }
}

export async function localTimeOf(db, practiceId, utc) {
  const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', practiceId))?.timezone || 'America/New_York';
  return localNow(tz, new Date(`${String(utc).replace(' ', 'T')}Z`));
}

// "Patient declined" — as traceable as a signature: who recorded it (or the patient on the iPad), when, why, the
// wording they were offered, and a PDF on the chart.
export async function declineConsent(db, storage, { consent, reason, userId = null, recordedBy = null, signatureName = null, signature = null, relationship = null, ip = null, device = null, via = 'chair', lang = 'en' }) {
  if (!['needed', 'sent'].includes(consent.status)) throw new HttpError(409, consent.status === 'declined' ? 'Already recorded as declined' : 'This consent was already signed');
  const t = await db.get('SELECT * FROM form_templates WHERE id = ?', consent.template_id);
  const v = await currentVersion(db, t);
  const ctx = await consentContext(db, { practiceId: consent.practice_id, patientId: consent.patient_id, procedureIds: JSON.parse(consent.procedure_ids), appointmentId: consent.appointment_id });
  const w = wordingFor(v, lang);
  const fields = fillFields(w.fields, ctx);
  const patient = await db.get('SELECT first_name, last_name, dob FROM patients WHERE id = ?', consent.patient_id);
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', consent.practice_id);
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const pdf = recordPdf({
    practice, patient, title: t.name, version: v.version, lang: w.lang, fields, signature, signerName: signatureName, relationship, signedAt: at, ip, device, via: VIA[via],
    declined: { reason, recordedBy }, localTime: await localTimeOf(db, consent.practice_id, at),
  });
  const saved = await storage.save(consent.practice_id, pdf);
  return await db.tx(async () => {
    const claimed = await db.run("UPDATE consents SET status = 'declined', updated_at = datetime('now') WHERE id = ? AND status IN ('needed','sent')", consent.id);
    if (!claimed.changes) throw new HttpError(409, 'This consent was already signed or declined');
    // Filed as a document, not under "consent": a declined consent must never count as a signed one (the chart
    // audit looks for consent documents).
    const docId = await insert(db, 'documents', {
      practice_id: consent.practice_id, patient_id: consent.patient_id, category: 'document', appointment_id: consent.appointment_id, treatment_plan_id: consent.treatment_plan_id,
      filename: `Declined — ${t.name} ${at.slice(0, 10)}.pdf`.replace(/[^\w.\- ()—]/g, '_'), mime: 'application/pdf', size: pdf.length,
      storage_key: saved.storageKey, encrypted: saved.encrypted ? 1 : 0, notes: `Declined${reason ? `: ${String(reason).slice(0, 200)}` : ''}`, uploaded_by: userId,
    });
    const content = JSON.stringify(fields);
    await change(db, 'consents', consent.id, {
      version_id: v.id, template_version: v.version, lang: w.lang, content, content_hash: hashOf(content), document_id: docId,
      declined_at: at, declined_reason: reason ? String(reason).slice(0, 500) : null, declined_by: userId, signer_name: signatureName, signer_relationship: relationship,
      signed_via: via, ip, device, witness_signature: null,
    });
    // Nothing left to fill in for it.
    if (consent.form_request_id) await db.run("UPDATE form_requests SET status = 'expired' WHERE id = ? AND status = 'pending'", consent.form_request_id);
    publish(consent.practice_id, { type: 'paperwork', patient_id: consent.patient_id, appointment_id: consent.appointment_id, consent_id: consent.id, status: 'declined' });
    return docId;
  });
}

// A new version must be signed instead (the wording changed, the treatment changed): the old record stays as it
// was, marked superseded, and a new consent for the same treatment is needed.
export async function supersedeConsent(db, req, consent, reason) {
  if (consent.status === 'superseded') throw new HttpError(409, 'Already replaced');
  if (!reason) throw new HttpError(400, 'Say why a new signature is needed');
  return await db.tx(async () => {
    await change(db, 'consents', consent.id, { status: 'superseded', superseded_at: new Date().toISOString().replace('T', ' ').slice(0, 19), superseded_by: req.user.id, superseded_reason: String(reason).slice(0, 500) });
    const id = await insert(db, 'consents', {
      practice_id: consent.practice_id, location_id: consent.location_id, patient_id: consent.patient_id, template_id: consent.template_id, context_key: consent.context_key,
      appointment_id: consent.appointment_id, treatment_plan_id: consent.treatment_plan_id, procedure_ids: consent.procedure_ids, status: 'needed', created_by: req.user.id, source: 'human',
    });
    await change(db, 'consents', consent.id, { replaced_by_id: id });
    if (consent.status === 'sent' && consent.form_request_id) await db.run("UPDATE form_requests SET status = 'expired' WHERE id = ? AND status = 'pending'", consent.form_request_id);
    await audit(db, req, 'consent.supersede', 'consents', consent.id, { patient_id: consent.patient_id, replaced_by: id }, { reason: String(reason).slice(0, 500) });
    return id;
  });
}

// The chart's view of one consent.
export async function consentView(db, c) {
  const t = await db.get('SELECT name, kind, witness, legal_review, version FROM form_templates WHERE id = ?', c.template_id);
  const names = await db.all(`SELECT id, name FROM users WHERE id IN (${[c.created_by, c.declined_by, c.superseded_by, c.witness_user_id].filter(Boolean).map(Number).join(',') || '0'})`);
  const nameOf = (id) => names.find((u) => u.id === id)?.name || null;
  const procIds = JSON.parse(c.procedure_ids || '[]');
  const procs = procIds.length ? await db.all(`SELECT id, code, description, tooth, surfaces, fee, status FROM procedures WHERE id IN (${procIds.map(() => '?').join(',')})`, ...procIds) : [];
  const { witness_signature: _ws, content: _c, ...rest } = c;
  return {
    ...rest, template_name: t?.name, template_kind: t?.kind, witness_required: !!t?.witness, legal_review: !!t?.legal_review, current_version: t?.version,
    outdated: c.status === 'signed' && t && c.template_version !== t.version, has_witness_signature: !!c.witness_signature,
    procedures: procs, created_by_name: nameOf(c.created_by), declined_by_name: nameOf(c.declined_by), superseded_by_name: nameOf(c.superseded_by), witness_user_name: nameOf(c.witness_user_id),
  };
}
