import { Router } from 'express';
import { requirePermission, HttpError, rateLimit } from '../auth.js';
import { insert, findOr404, audit, hashToken } from '../util.js';
import { cleanQuestions, cleanAnswers, npsScore, sendSurvey, DEFAULT_QUESTIONS, QUESTION_TYPES } from '../surveys.js';
import { patientLang } from '../templates.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// Staff: build surveys, send them, read the results.
export default function surveyRoutes({ db, messenger, config }) {
  const r = Router();
  const view = (s) => ({ ...s, questions: JSON.parse(s.questions), auto_after_visit: !!s.auto_after_visit, active: !!s.active });

  r.get('/surveys', requirePermission('reports:read'), async (req, res) => {
    const list = await db.all(
      `SELECT s.*, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS sent,
         (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id AND r.answered_at IS NOT NULL) AS answered
       FROM surveys s WHERE s.practice_id = ? ORDER BY s.id DESC`, req.user.practice_id,
    );
    res.json({ surveys: list.map(view), defaults: DEFAULT_QUESTIONS, types: QUESTION_TYPES });
  });
  const clean = async (req, b, existing) => {
    const row = {};
    if (b.name !== undefined || !existing) {
      row.name = String(b.name || '').trim().slice(0, 100);
      if (!row.name) throw new HttpError(400, 'Name the survey');
    }
    if (b.questions !== undefined || !existing) row.questions = JSON.stringify(cleanQuestions(b.questions ?? DEFAULT_QUESTIONS));
    for (const k of ['auto_after_visit', 'active']) if (b[k] !== undefined) row[k] = b[k] ? 1 : 0;
    // One survey goes out after visits at a time.
    if (row.auto_after_visit) await db.run('UPDATE surveys SET auto_after_visit = 0 WHERE practice_id = ? AND id != ?', req.user.practice_id, existing?.id ?? 0);
    return row;
  };
  r.post('/surveys', requireAdmin, async (req, res) => {
    const row = await clean(req, req.body || {}, null);
    const id = await insert(db, 'surveys', { ...row, practice_id: req.user.practice_id, created_by: req.user.id });
    await audit(db, req, 'survey.create', 'surveys', id);
    res.status(201).json(view(await db.get('SELECT * FROM surveys WHERE id = ?', id)));
  });
  r.put('/surveys/:sid', requireAdmin, async (req, res) => {
    const s = await findOr404(db, 'surveys', req.params.sid, req.user.practice_id, 'Survey');
    const row = await clean(req, req.body || {}, s);
    if (Object.keys(row).length) await db.run(`UPDATE surveys SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), s.id);
    res.json(view(await db.get('SELECT * FROM surveys WHERE id = ?', s.id)));
  });

  // Send to chosen patients, or everyone seen in the last N days who hasn't been asked in 90.
  r.post('/surveys/:sid/send', requirePermission('patients:write'), async (req, res) => {
    const s = await findOr404(db, 'surveys', req.params.sid, req.user.practice_id, 'Survey');
    const pid = req.user.practice_id;
    let ids = (req.body?.patient_ids || []).map(Number);
    if (!ids.length && req.body?.seen_within_days) {
      const since = new Date(Date.now() - Math.min(365, Number(req.body.seen_within_days)) * 86400_000).toISOString().slice(0, 10);
      ids = (await db.all(
        `SELECT DISTINCT a.patient_id FROM appointments a WHERE a.practice_id = ? AND a.status = 'completed' AND a.start_time >= ?
           AND NOT EXISTS (SELECT 1 FROM survey_responses r WHERE r.patient_id = a.patient_id AND r.sent_at > ?)`,
        pid, `${since} 00:00`, new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 19).replace('T', ' '),
      )).map((x) => x.patient_id);
    }
    if (!ids.length) throw new HttpError(400, 'Nobody to send to');
    let sent = 0;
    let skipped = 0;
    for (const id of ids.slice(0, 1000)) {
      const patient = await db.get("SELECT * FROM patients WHERE id = ? AND practice_id = ? AND status = 'active'", id, pid);
      const msg = patient ? await sendSurvey(db, messenger, { survey: s, patient, appUrl: config.appUrl, userId: req.user.id }) : null;
      if (msg?.status === 'sent') sent++; else skipped++;
    }
    await audit(db, req, 'survey.send', 'surveys', s.id, { sent, skipped });
    res.json({ sent, skipped });
  });

  r.get('/surveys/:sid/results', requirePermission('reports:read'), async (req, res) => {
    const s = view(await findOr404(db, 'surveys', req.params.sid, req.user.practice_id, 'Survey'));
    const where = ['r.survey_id = ?'];
    const args = [s.id];
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { where.push('r.answered_at >= ?'); args.push(`${req.query.from} 00:00:00`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { where.push('r.answered_at <= ?'); args.push(`${req.query.to} 23:59:59`); }
    const sent = await db.get(`SELECT COUNT(*) AS n FROM survey_responses r WHERE r.survey_id = ?`, s.id);
    const rows = await db.all(
      `SELECT r.id, r.patient_id, r.answers, r.nps, r.answered_at, p.first_name, p.last_name FROM survey_responses r JOIN patients p ON p.id = r.patient_id
       WHERE ${where.join(' AND ')} AND r.answered_at IS NOT NULL ORDER BY r.answered_at DESC`, ...args,
    );
    const answers = rows.map((x) => ({ ...x, answers: JSON.parse(x.answers) }));
    const npsValues = answers.map((a) => a.nps).filter((v) => v != null);
    const questions = s.questions.map((q) => {
      const vals = answers.map((a) => a.answers[q.id]).filter((v) => v != null);
      if (q.type === 'nps') return { ...q, count: vals.length, score: npsScore(vals), promoters: vals.filter((v) => v >= 9).length, passives: vals.filter((v) => v >= 7 && v <= 8).length, detractors: vals.filter((v) => v <= 6).length };
      if (q.type === 'rating') return { ...q, count: vals.length, average: vals.length ? Math.round((vals.reduce((t, v) => t + v, 0) / vals.length) * 10) / 10 : null };
      if (q.type === 'yesno') return { ...q, count: vals.length, yes: vals.filter((v) => v === 'yes').length };
      return { ...q, count: vals.length, comments: answers.filter((a) => a.answers[q.id]).slice(0, 100).map((a) => ({ text: a.answers[q.id], patient_id: a.patient_id, name: `${a.first_name} ${a.last_name}`, at: a.answered_at, nps: a.nps })) };
    });
    res.json({ survey: s, sent: sent.n, answered: rows.length, response_rate: sent.n ? Math.round((rows.length / sent.n) * 100) : null, nps: npsScore(npsValues), questions });
  });
  return r;
}

// Patients answering (the one-time link in the message).
export function surveyPublicRoutes({ db }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 30, name: 'survey' });
  const byToken = async (token) => {
    const x = await db.get(
      `SELECT r.*, s.questions, s.name, p.first_name, p.language, pr.name AS practice_name, pr.phone AS practice_phone FROM survey_responses r
       JOIN surveys s ON s.id = r.survey_id JOIN patients p ON p.id = r.patient_id JOIN practices pr ON pr.id = r.practice_id WHERE r.token_hash = ?`, hashToken(String(token)),
    );
    if (!x) throw new HttpError(404, 'This survey link is not valid');
    if (Date.parse(`${x.sent_at.replace(' ', 'T')}Z`) < Date.now() - 60 * 86400_000) throw new HttpError(410, 'This survey has closed. Thank you anyway!');
    return x;
  };
  r.get('/survey/:token', limiter, async (req, res) => {
    const x = await byToken(req.params.token);
    res.json({ practice_name: x.practice_name, practice_phone: x.practice_phone, first_name: x.first_name, language: patientLang(x), questions: JSON.parse(x.questions), answered: !!x.answered_at });
  });
  r.post('/survey/:token', limiter, async (req, res) => {
    const x = await byToken(req.params.token);
    if (x.answered_at) throw new HttpError(409, 'You already answered — thank you!');
    const { answers, nps } = cleanAnswers(JSON.parse(x.questions), req.body?.answers);
    await db.run("UPDATE survey_responses SET answers = ?, nps = ?, answered_at = datetime('now') WHERE id = ?", JSON.stringify(answers), nps, x.id);
    res.json({ ok: true });
  });
  return r;
}
