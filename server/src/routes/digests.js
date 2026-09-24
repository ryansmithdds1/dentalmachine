import { Router } from 'express';
import { can, HttpError } from '../auth.js';
import { audit, findOr404, practiceNow, change } from '../util.js';
import { setActor } from '../actor.js';
import { esc } from '../email/layout.js';
import {
  DIGESTS, AUDIENCES, CONTENT, HHMM, defaultAudience, digestSettings, buildDigest, sendDigest, subscriptionWithUser,
  verifyUnsubscribeToken, aiMode, unsubscribeUrl,
} from '../digests.js';
import { isDate, METRICS } from '../metrics.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Administrator access required')));

// Settings → Metric emails: who gets which digest, when, for which office; the practice's AI-summary switch;
// previews, test sends and the log of what went (with SendGrid's delivery status). Administrators manage
// everyone's; anyone can see and pause their own.
export default function digestRoutes({ db, messenger, config = {}, secret }) {
  const r = Router();

  const subRows = (pid, where = '', ...args) => db.all(
    `SELECT s.*, u.name AS user_name, u.email, u.role AS user_role, u.active AS user_active, l.name AS location_name, pv.name AS provider_name,
       (SELECT ds.status FROM digest_sends ds WHERE ds.subscription_id = s.id AND ds.period_key NOT LIKE 'test:%' ORDER BY ds.id DESC LIMIT 1) AS last_status,
       (SELECT ds.created_at FROM digest_sends ds WHERE ds.subscription_id = s.id AND ds.period_key NOT LIKE 'test:%' ORDER BY ds.id DESC LIMIT 1) AS last_sent_at
     FROM digest_subscriptions s JOIN users u ON u.id = s.user_id LEFT JOIN locations l ON l.id = s.location_id LEFT JOIN providers pv ON pv.id = s.provider_id
     WHERE s.practice_id = ?${where} ORDER BY u.name, s.digest`, pid, ...args,
  );
  const meta = () => ({
    digests: DIGESTS, audiences: AUDIENCES,
    content: CONTENT, metric_labels: Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, m.label])),
    ai_available: !!aiMode(config),
  });

  // Cleans the fields of a subscription (all checked against the practice).
  async function clean(req, b, existing = null) {
    const pid = req.user.practice_id;
    const row = {};
    if (b.audience !== undefined) {
      if (!AUDIENCES[b.audience]) throw new HttpError(400, `audience must be one of ${Object.keys(AUDIENCES).join(', ')}`);
      row.audience = b.audience;
    }
    if (b.send_time !== undefined) {
      if (!HHMM.test(String(b.send_time))) throw new HttpError(400, 'send_time must be a time like 07:00');
      row.send_time = String(b.send_time);
    }
    if (b.location_id !== undefined) row.location_id = b.location_id ? (await findOr404(db, 'locations', b.location_id, pid, 'Office')).id : null;
    if (b.provider_id !== undefined) row.provider_id = b.provider_id ? (await findOr404(db, 'providers', b.provider_id, pid, 'Provider')).id : null;
    if (b.status !== undefined) {
      if (!['active', 'paused'].includes(b.status)) throw new HttpError(400, 'status must be active or paused');
      // Someone who unsubscribed with the link decides for themselves whether to start again.
      if (b.status === 'active' && existing?.status === 'unsubscribed' && existing.user_id !== req.user.id) {
        throw new HttpError(409, `${existing.user_name || 'They'} unsubscribed from this email — only they can turn it back on (Settings → Metric emails, signed in as themselves)`);
      }
      row.status = b.status;
      if (b.status === 'active') row.unsubscribed_at = null;
    }
    return row;
  }

  r.get('/digests', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const practice = await db.get('SELECT digest_settings, timezone FROM practices WHERE id = ?', pid);
    res.json({
      ...meta(), settings: digestSettings(practice), timezone: practice.timezone,
      subscriptions: await subRows(pid),
      people: (await db.all('SELECT id, name, email, role FROM users WHERE practice_id = ? AND active = 1 ORDER BY name', pid)).map((u) => ({ ...u, default_audience: defaultAudience(u.role) })),
      locations: await db.all('SELECT id, name FROM locations WHERE practice_id = ? AND active = 1 ORDER BY sort, name', pid),
      providers: await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY name', pid),
      log: await db.all(
        `SELECT ds.id, ds.subscription_id, ds.period_key, ds.status, ds.attempts, ds.error, ds.ai_summary, ds.created_at, ds.sent_at,
           s.digest, u.name AS user_name, m.to_address, m.delivery, m.status AS message_status
         FROM digest_sends ds JOIN digest_subscriptions s ON s.id = ds.subscription_id JOIN users u ON u.id = s.user_id LEFT JOIN messages m ON m.id = ds.message_id
         WHERE ds.practice_id = ? ORDER BY ds.id DESC LIMIT 60`, pid,
      ),
    });
  });

  r.put('/digests/settings', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const practice = await db.get('SELECT digest_settings FROM practices WHERE id = ?', pid);
    const before = digestSettings(practice);
    const after = { ...before };
    if (req.body?.ai_summary !== undefined) after.ai_summary = !!req.body.ai_summary;
    if (req.body?.names !== undefined) after.names = !!req.body.names;
    await db.run('UPDATE practices SET digest_settings = ? WHERE id = ?', JSON.stringify(after), pid);
    const flags = (x) => ({ ai_summary: x.ai_summary ? 1 : 0, names: x.names ? 1 : 0 });
    await audit(db, req, 'digest.settings', 'practices', pid, null, { before: flags(before), after: flags(after) });
    res.json(after);
  });

  // Adds a digest for a member of staff, or changes the one they have (one per person and digest).
  r.post('/digests/subscriptions', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    if (!DIGESTS[b.digest]) throw new HttpError(400, `digest must be one of ${Object.keys(DIGESTS).join(', ')}`);
    const user = await db.get('SELECT id, name, role, active FROM users WHERE id = ? AND practice_id = ?', Number(b.user_id), pid);
    if (!user) throw new HttpError(404, 'Staff member not found');
    if (!user.active) throw new HttpError(400, `${user.name}'s login is turned off`);
    const existing = await db.get('SELECT s.*, u.name AS user_name FROM digest_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.practice_id = ? AND s.user_id = ? AND s.digest = ?', pid, user.id, b.digest);
    const row = await clean(req, { audience: defaultAudience(user.role), send_time: DIGESTS[b.digest].time, ...b, status: 'active' }, existing);
    let id;
    if (existing) {
      id = existing.id;
      await change(db, 'digest_subscriptions', id, { ...row, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    } else {
      id = (await db.run(
        'INSERT INTO digest_subscriptions (practice_id, user_id, digest, audience, send_time, location_id, provider_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        pid, user.id, b.digest, row.audience, row.send_time, row.location_id ?? null, row.provider_id ?? null, 'active', req.user.id,
      )).id;
    }
    await audit(db, req, existing ? 'digest.subscription_change' : 'digest.subscribe', 'digest_subscriptions', id, { user_id: user.id, digest: b.digest }, { after: row });
    res.status(existing ? 200 : 201).json((await subRows(pid, ' AND s.id = ?', id))[0]);
  });

  r.put('/digests/subscriptions/:sid', async (req, res) => {
    const pid = req.user.practice_id;
    const existing = await db.get('SELECT s.*, u.name AS user_name FROM digest_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.practice_id = ?', Number(req.params.sid), pid);
    if (!existing) throw new HttpError(404, 'Subscription not found');
    const own = existing.user_id === req.user.id;
    if (req.user.role !== 'admin' && !own) throw new HttpError(403, 'Administrator access required');
    // People change only whether their own digest is on; everything else is an administrator's setting.
    const body = req.user.role === 'admin' ? req.body || {} : { status: req.body?.status };
    const row = await clean(req, body, existing);
    if (Object.keys(row).length) await change(db, 'digest_subscriptions', existing.id, { ...row, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    await audit(db, req, 'digest.subscription_change', 'digest_subscriptions', existing.id, { user_id: existing.user_id, digest: existing.digest });
    res.json((await subRows(pid, ' AND s.id = ?', existing.id))[0]);
  });

  // The signed-in person's own digests.
  r.get('/digests/mine', async (req, res) => {
    res.json({ ...meta(), subscriptions: await subRows(req.user.practice_id, ' AND s.user_id = ?', req.user.id) });
  });

  // What a digest looks like right now (HTML for the preview frame, and the plain-text version).
  const preview = async (req, o) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const date = req.query.date ? String(req.query.date) : today;
    if (!isDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
    const built = await buildDigest(db, { practiceId: pid, date, today, appUrl: config.appUrl, config, withAi: req.query.ai === '1', ...o });
    return { subject: built.subject, html: built.html, text: built.text, areas: built.areas, from: built.range.from, to: built.range.to, ai: built.ai, ai_error: built.aiError || null };
  };
  r.get('/digests/preview', async (req, res) => {
    if (!can(req.user, 'reports:read')) throw new HttpError(403, 'Missing permission: reports:read');
    const digest = String(req.query.digest || 'weekly');
    const audience = String(req.query.audience || 'owner');
    if (!DIGESTS[digest]) throw new HttpError(400, 'Unknown digest');
    if (!AUDIENCES[audience]) throw new HttpError(400, 'Unknown audience');
    const pid = req.user.practice_id;
    const locationId = req.query.location_id ? (await findOr404(db, 'locations', req.query.location_id, pid, 'Office')).id : null;
    const providerId = req.query.provider_id ? (await findOr404(db, 'providers', req.query.provider_id, pid, 'Provider')).id : null;
    res.json(await preview(req, { digest, audience, locationId, providerId }));
  });
  r.get('/digests/subscriptions/:sid/preview', async (req, res) => {
    const sub = await findOr404(db, 'digest_subscriptions', req.params.sid, req.user.practice_id, 'Subscription');
    if (req.user.role !== 'admin' && sub.user_id !== req.user.id) throw new HttpError(403, 'Administrator access required');
    const providerId = sub.provider_id || (sub.audience === 'hygienist' ? (await db.get('SELECT id FROM providers WHERE practice_id = ? AND user_id = ? AND active = 1', sub.practice_id, sub.user_id))?.id : null) || null;
    res.json(await preview(req, { digest: sub.digest, audience: sub.audience, locationId: sub.location_id, providerId, unsubscribeUrl: unsubscribeUrl(config.appUrl, secret, sub.id) }));
  });

  // Sends the digest now to its person, marked [Test]. It goes in the log like any other; a failure shows here.
  r.post('/digests/subscriptions/:sid/test', requireAdmin, async (req, res) => {
    await findOr404(db, 'digest_subscriptions', req.params.sid, req.user.practice_id, 'Subscription');
    const sub = await subscriptionWithUser(db, Number(req.params.sid));
    if (sub.status === 'unsubscribed') throw new HttpError(409, `${sub.user_name} unsubscribed from this email`);
    const today = (await practiceNow(db, sub.practice_id)).slice(0, 10);
    const out = await sendDigest(db, messenger, sub, { date: today, today, config, secret, test: true, userId: req.user.id });
    await audit(db, req, 'digest.test_send', 'digest_subscriptions', sub.id, { status: out.status, message_id: out.message_id });
    res.status(out.status === 'sent' ? 200 : 502).json(out.status === 'sent' ? out : { ...out, error: `The test email didn't go: ${out.error}` });
  });

  return r;
}

// The link at the bottom of every digest (no sign-in: the signed link is the proof). GET shows a one-button page
// so a mail scanner opening links can't unsubscribe anyone; POST (the button, or a mail program's one-click
// List-Unsubscribe-Post) does it.
export function digestPublicRoutes({ db, secret }) {
  const r = Router();
  const find = async (token) => {
    const id = verifyUnsubscribeToken(secret, token);
    const sub = id ? await db.get('SELECT s.*, u.name AS user_name, p.name AS practice_name FROM digest_subscriptions s JOIN users u ON u.id = s.user_id JOIN practices p ON p.id = s.practice_id WHERE s.id = ?', id) : null;
    if (!sub) throw new HttpError(404, 'This unsubscribe link isn’t valid');
    return sub;
  };
  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#121a2a">
<div style="max-width:440px;margin:48px auto;padding:24px;background:#fff;border:1px solid #e4e8ee;border-radius:12px">${body}</div></body></html>`;
  r.get('/digests/unsubscribe/:token', async (req, res) => {
    const sub = await find(req.params.token);
    const label = DIGESTS[sub.digest].label;
    res.type('html').send(page('Unsubscribe', sub.status === 'unsubscribed'
      ? `<h2 style="margin:0 0 8px">You're unsubscribed</h2><p>You won't get the ${esc(label.toLowerCase())} email from ${esc(sub.practice_name)} any more.</p>`
      : `<h2 style="margin:0 0 8px">Stop the ${esc(label.toLowerCase())} email?</h2><p>${esc(sub.user_name)}, you'll stop getting this email from ${esc(sub.practice_name)}. An administrator can't turn it back on for you; you can, in Settings → Metric emails.</p>
<form method="post"><button type="submit" style="padding:10px 16px;border:0;border-radius:8px;background:#0d9488;color:#fff;font-size:15px;font-weight:600;cursor:pointer">Unsubscribe</button></form>`));
  });
  r.post('/digests/unsubscribe/:token', async (req, res) => {
    const sub = await find(req.params.token);
    if (sub.status !== 'unsubscribed') {
      // It's the member of staff acting (through their own link), not a patient.
      setActor({ source: 'human', actor: `${sub.user_name} (unsubscribe link)`, practiceId: sub.practice_id, userId: sub.user_id });
      await change(db, 'digest_subscriptions', sub.id, { status: 'unsubscribed', unsubscribed_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
      await audit(db, null, 'digest.unsubscribe', 'digest_subscriptions', sub.id, { digest: sub.digest, user_id: sub.user_id });
    }
    if (req.is('application/x-www-form-urlencoded') && String(req.get('accept') || '').includes('text/html')) {
      return res.type('html').send(page('Unsubscribed', `<h2 style="margin:0 0 8px">You're unsubscribed</h2><p>You won't get the ${esc(DIGESTS[sub.digest].label.toLowerCase())} email from ${esc(sub.practice_name)} any more.</p>`));
    }
    res.json({ ok: true, status: 'unsubscribed' });
  });
  return r;
}
