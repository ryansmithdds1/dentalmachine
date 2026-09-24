import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, insert, audit, practiceNow } from '../util.js';
import { CARIES_QUESTIONS, PERIO_QUESTIONS, cariesRisk, perioRisk, chartAnswers } from '../risk.js';
import { libraryFor, articlesForCodes } from '../education.js';
import { sendMessage, recipientFor } from '../messaging.js';

// Caries and periodontal risk assessments, and the patient education library.
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;
const practiceKey = (p) => p.slug || `p${p.id}`;

export default function patientCareRoutes({ db, messenger, config }) {
  const r = Router();

  // ---- Risk ----
  r.get('/patients/:id/risk', requirePermission('clinical:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const today = (await practiceNow(db, req.user.practice_id)).slice(0, 10);
    const latest = async (kind) => {
      const row = await db.get('SELECT a.*, u.name AS by_name FROM risk_assessments a LEFT JOIN users u ON u.id = a.created_by WHERE a.patient_id = ? AND a.kind = ? ORDER BY a.id DESC LIMIT 1', p.id, kind);
      return row ? { ...row, answers: JSON.parse(row.answers), result: JSON.parse(row.result) } : null;
    };
    const history = await db.all('SELECT id, kind, level, substr(created_at, 1, 10) AS date FROM risk_assessments WHERE patient_id = ? ORDER BY id DESC LIMIT 20', p.id);
    res.json({ questions: { caries: CARIES_QUESTIONS, perio: PERIO_QUESTIONS }, from_chart: await chartAnswers(db, p.id, today), caries: await latest('caries'), perio: await latest('perio'), history });
  });

  r.post('/patients/:id/risk', requirePermission('clinical:write'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const kind = req.body?.kind;
    if (!['caries', 'perio'].includes(kind)) throw new HttpError(400, 'kind must be caries or perio');
    const allowed = kind === 'caries' ? Object.values(CARIES_QUESTIONS).flatMap((g) => Object.keys(g)) : [...Object.keys(PERIO_QUESTIONS)];
    const answers = Object.fromEntries(allowed.filter((k) => req.body.answers?.[k] != null).map((k) => [k, typeof req.body.answers[k] === 'boolean' ? req.body.answers[k] : Number(req.body.answers[k]) || 0]));
    const result = kind === 'caries' ? cariesRisk(answers) : perioRisk(answers);
    const id = await insert(db, 'risk_assessments', { practice_id: req.user.practice_id, patient_id: p.id, kind, answers: JSON.stringify(answers), level: result.level, result: JSON.stringify(result), created_by: req.user.id });
    // Optionally set the patient's recall to match.
    if (req.body.apply_recall && result.recall_months) {
      const type = kind === 'perio' && result.level !== 'low' ? 'perio' : 'prophy';
      await db.run("UPDATE recalls SET interval_months = ? WHERE patient_id = ? AND type = ? AND status NOT IN ('completed','inactive')", result.recall_months, p.id, type);
    }
    await audit(db, req, 'risk.assess', 'patients', p.id, { kind, level: result.level });
    res.status(201).json({ id, kind, level: result.level, result });
  });

  // ---- Education ----
  r.get('/education', requirePermission('patients:read'), async (req, res) => {
    const practice = await db.get('SELECT id, slug FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ articles: await libraryFor(db, req.user.practice_id), base: `${config.appUrl}/learn/${practiceKey(practice)}` });
  });
  r.put('/education/:slug', requirePermission('patients:write'), async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug)) throw new HttpError(400, 'Use lowercase letters, numbers and dashes for the address');
    const title = String(req.body?.title || '').trim().slice(0, 120);
    const body = String(req.body?.body || '').trim().slice(0, 20_000);
    if (!title || !body) throw new HttpError(400, 'A title and the text are required');
    const codes = (Array.isArray(req.body.codes) ? req.body.codes : String(req.body.codes || '').split(/[\s,]+/)).map((c) => String(c).trim().toUpperCase()).filter((c) => /^D\d{1,4}$/.test(c));
    const active = req.body.active === false ? 0 : 1;
    const have = await db.get('SELECT id FROM education_articles WHERE practice_id = ? AND slug = ?', req.user.practice_id, slug);
    if (have) await db.run('UPDATE education_articles SET title = ?, body = ?, codes = ?, active = ? WHERE id = ?', title, body, JSON.stringify(codes), active, have.id);
    else await insert(db, 'education_articles', { practice_id: req.user.practice_id, slug, title, body, codes: JSON.stringify(codes), active });
    res.json({ ok: true });
  });
  r.delete('/education/:slug', requirePermission('patients:write'), async (req, res) => {
    const gone = await db.run('DELETE FROM education_articles WHERE practice_id = ? AND slug = ?', req.user.practice_id, String(req.params.slug));
    if (gone.changes) await audit(db, req, 'education.delete', 'education_articles', null, { slug: String(req.params.slug) });
    res.json({ ok: true });
  });
  // Pages that match this patient's planned treatment.
  r.get('/patients/:id/education', requirePermission('patients:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const codes = (await db.all("SELECT DISTINCT code FROM procedures WHERE patient_id = ? AND (status = 'planned' OR (status = 'completed' AND completed_at >= ?))", p.id, new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10))).map((x) => x.code);
    const library = await libraryFor(db, req.user.practice_id);
    const sent = await db.all("SELECT body, created_at FROM messages WHERE patient_id = ? AND kind = 'education' ORDER BY id DESC LIMIT 20", p.id);
    res.json({ suggested: articlesForCodes(library, codes).map((a) => a.slug), articles: library.filter((a) => a.active).map(({ body: _b, ...a }) => a), sent });
  });
  r.post('/patients/:id/education', requirePermission('patients:write'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const library = await libraryFor(db, req.user.practice_id);
    const picked = library.filter((a) => a.active && (req.body?.slugs || []).includes(a.slug));
    if (!picked.length) throw new HttpError(400, 'Choose what to send');
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    const to = await recipientFor(db, p);
    const channel = req.body.channel === 'email' ? 'email' : 'sms';
    const address = channel === 'email' ? to.email : to.phone;
    if (!address) throw new HttpError(400, channel === 'email' ? 'No email on file' : 'No mobile number on file');
    const links = picked.map((a) => `${a.title}: ${config.appUrl}/learn/${practiceKey(practice)}/${a.slug}`).join('\n');
    const msg = await sendMessage(db, messenger, {
      practiceId: practice.id, patientId: p.id, channel, to: address, kind: 'education', userId: req.user.id, subject: `About your treatment — ${practice.name}`,
      body: `Hi ${p.preferred_name || p.first_name}, here ${picked.length === 1 ? 'is some information' : 'is information'} from ${practice.name} about your treatment:\n${links}${channel === 'sms' ? '\nReply STOP to opt out.' : ''}`,
    });
    res.json({ status: msg.status, error: msg.error || null });
  });
  return r;
}

// The public pages (general information — no patient data).
export function learnPublicRoutes({ db }) {
  const r = Router();
  r.get('/learn/:practice/:slug', async (req, res) => {
    const key = String(req.params.practice);
    const practice = /^p\d+$/.test(key) ? await db.get('SELECT id, name, phone, slug FROM practices WHERE id = ?', Number(key.slice(1))) : await db.get('SELECT id, name, phone, slug FROM practices WHERE slug = ?', key);
    if (!practice) throw new HttpError(404, 'Not found');
    const article = (await libraryFor(db, practice.id)).find((a) => a.slug === req.params.slug && a.active);
    if (!article) throw new HttpError(404, 'Not found');
    res.json({ practice: { name: practice.name, phone: practice.phone }, title: article.title, body: article.body });
  });
  return r;
}
