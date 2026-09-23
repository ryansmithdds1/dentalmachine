import express, { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, insert, audit, practiceNow } from '../util.js';
import { LENDERS, STATUSES, applicationLink, verifyLenderSignature } from '../lenders.js';
import { sendMessage, recipientFor } from '../messaging.js';
import { publish } from '../events.js';

// Patient financing: send an application, follow it to approval and funding, and post the money.
async function markFunded(db, app, amount, userId) {
  const lender = LENDERS[app.lender];
  const date = (await practiceNow(db, app.practice_id)).slice(0, 10);
  const entry = await insert(db, 'ledger_entries', {
    practice_id: app.practice_id, patient_id: app.patient_id, type: 'payment', amount: -amount, method: lender.method,
    description: `Financing — ${lender.name}${app.external_id ? ` (${app.external_id})` : ''}`, reference: app.external_id || `FIN-${app.id}`, entry_date: date, created_by: userId ?? null,
  });
  await db.run("UPDATE financing_applications SET status = 'funded', funded_amount = ?, funded_at = datetime('now'), ledger_entry_id = ?, updated_at = datetime('now') WHERE id = ?", amount, entry, app.id);
  return entry;
}

export default function lenderRoutes({ db, messenger }) {
  const r = Router();
  r.get('/financing/lenders', requirePermission('billing:read'), async (req, res) => {
    const p = await db.get('SELECT financing FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ lenders: Object.entries(LENDERS).map(([key, l]) => ({ key, ...l, link: applicationLink(p.financing, key, 0) })), sandbox: process.env.LENDERS_SANDBOX === 'on' });
  });
  r.get('/patients/:id/financing', requirePermission('billing:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json(await db.all('SELECT * FROM financing_applications WHERE patient_id = ? ORDER BY id DESC', p.id));
  });
  r.get('/financing/applications', requirePermission('billing:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT f.*, p.first_name, p.last_name FROM financing_applications f JOIN patients p ON p.id = f.patient_id
       WHERE f.practice_id = ? ORDER BY CASE WHEN f.status IN ('sent','started','approved') THEN 0 ELSE 1 END, f.id DESC LIMIT 200`, req.user.practice_id,
    ));
  });

  r.post('/patients/:id/financing', requirePermission('billing:write'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    const lender = String(req.body?.lender || '');
    if (!LENDERS[lender]) throw new HttpError(400, `lender must be one of: ${Object.keys(LENDERS).join(', ')}`);
    const amount = Math.round(Number(req.body.amount) * 100);
    if (!(amount > 0)) throw new HttpError(400, 'Enter the amount to finance');
    const practice = await db.get('SELECT * FROM practices WHERE id = ?', req.user.practice_id);
    const link = applicationLink(practice.financing, lender, amount);
    if (!link) throw new HttpError(400, `Add your ${LENDERS[lender].name} application link in Settings → Practice → Financing first`);
    const id = await insert(db, 'financing_applications', {
      practice_id: practice.id, patient_id: p.id, lender, amount, status: 'sent', link, treatment_plan_id: req.body.treatment_plan_id ? Number(req.body.treatment_plan_id) : null, created_by: req.user.id,
    });
    let message = null;
    if (req.body.channel === 'sms' || req.body.channel === 'email') {
      const to = await recipientFor(db, p);
      const address = req.body.channel === 'email' ? to.email : to.phone;
      if (!address) throw new HttpError(400, req.body.channel === 'email' ? 'No email on file' : 'No mobile number on file');
      message = await sendMessage(db, messenger, {
        practiceId: practice.id, patientId: p.id, channel: req.body.channel, to: address, kind: 'financing', userId: req.user.id, subject: `Financing your treatment at ${practice.name}`,
        body: `Hi ${p.preferred_name || p.first_name}, you can apply for ${LENDERS[lender].name} financing for your treatment ($${(amount / 100).toFixed(2)}) here — it takes a few minutes and won't affect your credit score to check: ${link}${req.body.channel === 'sms' ? '\nReply STOP to opt out.' : ''}`,
      });
    }
    await audit(db, req, 'financing.send', 'financing_applications', id, { lender, amount });
    res.status(201).json({ ...(await db.get('SELECT * FROM financing_applications WHERE id = ?', id)), message_status: message?.status ?? null });
  });

  // Staff record what the lender's portal says (or the sandbox moves it along).
  r.put('/financing/applications/:fid', requirePermission('billing:write'), async (req, res) => {
    const app = await findOr404(db, 'financing_applications', req.params.fid, req.user.practice_id, 'Application');
    const status = String(req.body?.status || app.status);
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of: ${STATUSES.join(', ')}`);
    if (app.status === 'funded') throw new HttpError(409, 'Already funded — reverse the payment on the ledger to undo');
    if (status === 'funded') {
      const amount = Math.round(Number(req.body.funded_amount ?? (app.approved_amount ?? app.amount) / 100) * 100);
      if (!(amount > 0)) throw new HttpError(400, 'Enter the amount funded');
      await markFunded(db, app, amount, req.user.id);
    } else {
      await db.run("UPDATE financing_applications SET status = ?, approved_amount = COALESCE(?, approved_amount), plan = COALESCE(?, plan), external_id = COALESCE(?, external_id), updated_at = datetime('now') WHERE id = ?",
        status, req.body.approved_amount != null ? Math.round(Number(req.body.approved_amount) * 100) : null, req.body.plan ? String(req.body.plan).slice(0, 120) : null, req.body.external_id ? String(req.body.external_id).slice(0, 80) : null, app.id);
    }
    await audit(db, req, 'financing.update', 'financing_applications', app.id, { status });
    res.json(await db.get('SELECT * FROM financing_applications WHERE id = ?', app.id));
  });
  return r;
}

// Lender status callbacks: { application_id | reference, status, approved_amount, funded_amount (dollars), plan, external_id }.
export function lenderWebhooks({ db }) {
  const r = Router();
  r.post('/api/webhooks/financing/:lender', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
    const lender = String(req.params.lender);
    if (!LENDERS[lender]) return res.status(404).end();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyLenderSignature(lender, raw, req.headers['x-signature'] || req.headers['x-webhook-signature'])) return res.status(401).json({ error: 'Bad signature' });
    let b;
    try { b = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'JSON body expected' }); }
    const ref = String(b.reference || b.application_id || '');
    const id = Number(ref.replace(/^FIN-/, ''));
    const app = await db.get('SELECT * FROM financing_applications WHERE lender = ? AND (id = ? OR external_id = ?)', lender, Number.isFinite(id) ? id : -1, String(b.external_id || ref));
    if (!app) return res.status(404).json({ error: 'Unknown application' });
    const status = String(b.status || '').toLowerCase();
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
    if (app.status === 'funded') return res.json({ ok: true, already: true });
    if (status === 'funded') await markFunded(db, { ...app, external_id: app.external_id || b.external_id || null }, Math.round(Number(b.funded_amount ?? b.approved_amount ?? app.amount / 100) * 100), null);
    else await db.run("UPDATE financing_applications SET status = ?, approved_amount = COALESCE(?, approved_amount), plan = COALESCE(?, plan), external_id = COALESCE(?, external_id), updated_at = datetime('now') WHERE id = ?",
      status, b.approved_amount != null ? Math.round(Number(b.approved_amount) * 100) : null, b.plan ? String(b.plan).slice(0, 120) : null, b.external_id ? String(b.external_id).slice(0, 80) : null, app.id);
    const p = await db.get('SELECT first_name, last_name FROM patients WHERE id = ?', app.patient_id);
    if (['approved', 'declined', 'funded'].includes(status)) {
      await insert(db, 'tasks', {
        practice_id: app.practice_id, patient_id: app.patient_id, priority: status === 'approved' ? 'high' : 'normal', due_date: (await practiceNow(db, app.practice_id)).slice(0, 10),
        title: `${LENDERS[lender].name}: ${p.first_name} ${p.last_name} ${status === 'approved' ? `was approved${b.approved_amount ? ` for $${Number(b.approved_amount).toFixed(2)}` : ''} — schedule their treatment` : status === 'declined' ? 'was declined — offer another option' : 'financing funded and posted to the ledger'}`,
      });
      publish(app.practice_id, { type: 'tasks' });
    }
    res.json({ ok: true });
  });
  return r;
}
