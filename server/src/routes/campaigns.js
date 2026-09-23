import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, hashToken } from '../util.js';
import { SEGMENTS, CAMPAIGN_VARS, segmentPatients, pickRecipients, campaignVars, finalBody, normalize, createCampaign, runCampaigns, cleanParams, validateBody } from '../campaigns.js';
import { recordOptOut } from '../messaging.js';

// Campaigns: build a segment, preview who gets it, then send now or schedule it.
export default function campaignRoutes({ db, messenger, config }) {
  const r = Router();
  const view = (c) => ({ ...c, send_lock: undefined, params: JSON.parse(c.params || '{}') });

  r.get('/campaigns/segments', requirePermission('patients:read'), (_req, res) => res.json({ segments: SEGMENTS, vars: CAMPAIGN_VARS }));

  // Who a campaign would reach right now, and what the message looks like.
  r.post('/campaigns/preview', requirePermission('patients:read'), async (req, res) => {
    const b = req.body || {};
    const params = cleanParams(b.segment, b.params || {});
    const channel = ['sms', 'email'].includes(b.channel) ? b.channel : 'auto';
    const patients = await segmentPatients(db, req.user.practice_id, b.segment, params);
    const { recipients, unreachable, duplicates } = pickRecipients(patients, channel);
    const vars = await campaignVars(db, req.user.practice_id, config.appUrl);
    let sample = null;
    if (b.body) {
      const body = validateBody(b.body, channel === 'email' ? 'email' : 'sms');
      const first = recipients[0];
      sample = finalBody(body, { ...vars, first_name: first?.patient.first_name || 'Maria' }, first?.channel === 'email' || channel === 'email' ? 'email' : 'sms', `${config.appUrl}/u/…`);
    }
    res.json({
      patients: patients.length, recipients: recipients.length, unreachable, duplicates,
      sms: recipients.filter((x) => x.channel === 'sms').length, email: recipients.filter((x) => x.channel === 'email').length,
      list: recipients.slice(0, 50).map((x) => ({ id: x.patient.id, first_name: x.patient.first_name, last_name: x.patient.last_name, channel: x.channel, to: x.to })),
      sample,
    });
  });

  r.get('/campaigns', requirePermission('patients:read'), async (req, res) => {
    res.json((await db.all('SELECT c.*, u.name AS created_by_name FROM campaigns c LEFT JOIN users u ON u.id = c.created_by WHERE c.practice_id = ? ORDER BY c.id DESC LIMIT 200', req.user.practice_id)).map(view));
  });

  r.get('/campaigns/:cid', requirePermission('patients:read'), async (req, res) => {
    const c = await findOr404(db, 'campaigns', req.params.cid, req.user.practice_id, 'Campaign');
    const recipients = await db.all(
      `SELECT cr.id, cr.patient_id, cr.channel, cr.to_address, cr.status, cr.unsubscribed_at, p.first_name, p.last_name, m.error,
         (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = cr.patient_id AND a.created_at >= COALESCE(?, '9999') AND a.status != 'cancelled') AS booked
       FROM campaign_recipients cr JOIN patients p ON p.id = cr.patient_id LEFT JOIN messages m ON m.id = cr.message_id WHERE cr.campaign_id = ? ORDER BY cr.id LIMIT 2000`,
      c.started_at, c.id,
    );
    res.json({ ...view(c), recipient_list: recipients, booked: recipients.filter((x) => x.booked > 0).length, unsubscribed: recipients.filter((x) => x.unsubscribed_at).length });
  });

  r.post('/campaigns', requirePermission('patients:write'), async (req, res) => {
    const id = await createCampaign(db, req.user.practice_id, req.user.id, req.body);
    await audit(db, req, 'campaign.create', 'campaigns', id);
    res.status(201).json(view(await db.get('SELECT * FROM campaigns WHERE id = ?', id)));
  });

  const draft = async (req) => {
    const c = await findOr404(db, 'campaigns', req.params.cid, req.user.practice_id, 'Campaign');
    if (!['draft', 'scheduled'].includes(c.status)) throw new HttpError(409, `This campaign is already ${c.status}`);
    return c;
  };

  r.put('/campaigns/:cid', requirePermission('patients:write'), async (req, res) => {
    const c = await draft(req);
    const row = normalize({ ...view(c), ...req.body });
    await db.run(`UPDATE campaigns SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), c.id);
    await audit(db, req, 'campaign.update', 'campaigns', c.id);
    res.json(view(await db.get('SELECT * FROM campaigns WHERE id = ?', c.id)));
  });

  // Send now, or at a set time. Outside 9am–8pm it waits for the morning.
  r.post('/campaigns/:cid/send', requirePermission('patients:write'), async (req, res) => {
    const c = await draft(req);
    const at = req.body?.send_at ? new Date(req.body.send_at) : new Date();
    if (Number.isNaN(at.getTime())) throw new HttpError(400, 'send_at must be a date and time');
    await db.run("UPDATE campaigns SET status = 'scheduled', send_at = ? WHERE id = ?", at.toISOString(), c.id);
    await audit(db, req, 'campaign.send', 'campaigns', c.id, { send_at: at.toISOString() });
    if (at <= new Date()) await runCampaigns(db, messenger, { appUrl: config.appUrl, campaignId: c.id });
    res.json(view(await db.get('SELECT * FROM campaigns WHERE id = ?', c.id)));
  });

  r.post('/campaigns/:cid/cancel', requirePermission('patients:write'), async (req, res) => {
    const c = await findOr404(db, 'campaigns', req.params.cid, req.user.practice_id, 'Campaign');
    if (!['draft', 'scheduled', 'sending'].includes(c.status)) throw new HttpError(409, `This campaign is already ${c.status}`);
    await db.run("UPDATE campaigns SET status = 'cancelled' WHERE id = ?", c.id);
    await db.run("UPDATE campaign_recipients SET status = 'skipped' WHERE campaign_id = ? AND status = 'pending'", c.id);
    await audit(db, req, 'campaign.cancel', 'campaigns', c.id);
    res.json(view(await db.get('SELECT * FROM campaigns WHERE id = ?', c.id)));
  });

  return r;
}

// One-click unsubscribe from campaign emails (and texts, for the channel it came on).
export function campaignPublicRoutes({ db }) {
  const r = Router();
  const find = async (token) => {
    const x = await db.get(
      `SELECT cr.*, c.practice_id, pr.name AS practice_name FROM campaign_recipients cr JOIN campaigns c ON c.id = cr.campaign_id JOIN practices pr ON pr.id = c.practice_id
       WHERE cr.unsubscribe_hash = ?`, hashToken(token),
    );
    if (!x) throw new HttpError(404, 'This link is not valid');
    return x;
  };
  r.get('/unsubscribe/:token', async (req, res) => {
    const x = await find(req.params.token);
    res.json({ practice_name: x.practice_name, channel: x.channel, done: !!x.unsubscribed_at });
  });
  r.post('/unsubscribe/:token', async (req, res) => {
    const x = await find(req.params.token);
    await db.tx(async () => {
      await db.run(`UPDATE patients SET ${x.channel === 'sms' ? 'sms_opt_in' : 'email_opt_in'} = 0 WHERE id = ?`, x.patient_id);
      if (x.channel === 'email') await recordOptOut(db, x.practice_id, 'email', x.to_address, 'unsubscribe');
      await db.run("UPDATE campaign_recipients SET unsubscribed_at = COALESCE(unsubscribed_at, datetime('now')) WHERE id = ?", x.id);
    });
    res.json({ practice_name: x.practice_name, channel: x.channel, done: true });
  });
  return r;
}
