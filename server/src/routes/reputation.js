import { Router } from 'express';
import { startConnect, finishConnect } from '../oauthstate.js';
import { raiseIssue, resolveIssue, failed } from '../issues.js';
import { requirePermission, HttpError, signToken, verifyToken } from '../auth.js';
import { findOr404, audit, insert, practiceNow } from '../util.js';
import { structured } from '../ai.js';
import { syncReviews, postReply, sealGbp, setBookingLink } from '../reviews.js';
import { publish } from '../events.js';
import { scanReviews } from '../shoutouts.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only administrators can do this')));

// A reply must never confirm that the reviewer is a patient (that alone is protected health information),
// mention treatment, or argue: offices have been fined for exactly that.
const REPLY_TOOL = {
  name: 'review_reply',
  description: 'A public reply to an online review of a dental office.',
  input_schema: { type: 'object', properties: { reply: { type: 'string', description: 'The reply, 1-3 short sentences.' }, caution: { type: 'string', description: 'Anything the office should handle privately instead (e.g. a billing complaint to call about)' } }, required: ['reply'] },
};
const REPLY_SYSTEM = `You write public replies to online reviews for a US dental office. HIPAA rules for every reply:
- Never confirm or imply the reviewer is or was a patient ("thank you for visiting", "your treatment", "your appointment" are NOT allowed), and never mention any procedure, visit, date, bill or detail from the review about their care.
- Speak generally about the office ("we strive to…", "our team…"). For a complaint, apologize that they had a bad experience in general terms and invite them to call the office (use the phone number given) — never discuss specifics publicly.
- Warm, short, sincere, no marketing, no emojis, no names of staff. Sign off with the office name.`;

async function newReviewTasks(db, pid, since) {
  const bad = await db.all("SELECT id, author, rating FROM reviews WHERE practice_id = ? AND rating <= 3 AND created_at >= ? AND reply_status = 'none'", pid, since);
  if (!bad.length) return;
  const today = (await practiceNow(db, pid)).slice(0, 10);
  for (const r of bad) await insert(db, 'tasks', { practice_id: pid, priority: 'high', due_date: today, title: `${r.rating}-star Google review from ${r.author} — reply today (Reputation)` });
  publish(pid, { type: 'tasks' });
}

export async function runReviewSync(db, { gbp, secret }) {
  if (!gbp) return 0;
  let n = 0;
  for (const c of await db.all('SELECT practice_id FROM review_connections')) {
    const since = new Date().toISOString().slice(0, 19).replace('T', ' ');
    try {
      n += (await syncReviews(db, gbp, secret, c.practice_id)).synced;
      await newReviewTasks(db, c.practice_id, since);
      await scanReviews(db, c.practice_id); // team shout-outs named in new reviews (RV3)
      await resolveIssue(db, c.practice_id, 'reviews-sync');
    } catch (err) {
      await raiseIssue(db, { practiceId: c.practice_id, kind: 'sync', key: 'reviews-sync', role: 'admin', title: 'Google reviews couldn’t be checked', detail: err.message });
    }
  }
  return n;
}

export default function reputationRoutes({ db, config, secret, gbp }) {
  const r = Router();
  const redirectUri = () => `${config.appUrl}/api/reputation/google/callback`;

  r.get('/reputation', requirePermission('patients:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const conn = await db.get('SELECT location_title, synced_at, created_at FROM review_connections WHERE practice_id = ?', pid);
    const reviews = await db.all('SELECT * FROM reviews WHERE practice_id = ? ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 300', pid);
    const rated = reviews.filter((x) => x.rating);
    const since90 = new Date(Date.now() - 90 * 86400_000).toISOString();
    const recent = rated.filter((x) => (x.posted_at || x.created_at) >= since90);
    const avg = (list) => (list.length ? Math.round((list.reduce((s, x) => s + x.rating, 0) / list.length) * 10) / 10 : null);
    const surveys = await db.get("SELECT COUNT(*) AS n, AVG(nps) AS avg FROM survey_responses WHERE practice_id = ? AND answered_at IS NOT NULL AND nps IS NOT NULL AND answered_at >= ?", pid, since90.slice(0, 10));
    const requests = await db.get("SELECT COUNT(*) AS n FROM messages WHERE practice_id = ? AND kind = 'review_request' AND created_at >= ?", pid, since90.slice(0, 19).replace('T', ' '));
    res.json({
      mode: gbp?.mode || null, connected: !!conn, connection: conn,
      summary: {
        rating: avg(rated), count: rated.length, rating_90: avg(recent), count_90: recent.length,
        reply_rate: reviews.length ? Math.round((reviews.filter((x) => x.reply_status === 'posted').length / reviews.length) * 100) : null,
        unanswered_negative: reviews.filter((x) => x.rating && x.rating <= 3 && x.reply_status !== 'posted').length,
        survey_nps_avg: surveys?.n ? Math.round(Number(surveys.avg) * 10) / 10 : null, survey_count: surveys?.n || 0, requests_sent_90: requests?.n || 0,
      },
      reviews,
    });
  });

  r.get('/reputation/google/connect', requireAdmin, async (req, res) => {
    if (!gbp) throw new HttpError(501, 'Google Business Profile isn’t set up on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
    res.json({ url: gbp.authUrl(await startConnect(db, req, res, { purpose: 'gbp-connect', appUrl: config.appUrl }), redirectUri()) });
  });
  r.post('/reputation/sync', requirePermission('patients:read'), async (req, res) => {
    const since = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const out = await syncReviews(db, gbp, secret, req.user.practice_id);
    await newReviewTasks(db, req.user.practice_id, since);
    await scanReviews(db, req.user.practice_id); // team shout-outs named in new reviews (RV3)
    res.json(out);
  });
  // Online booking from the Google listing ("Book" in Search and Maps), tagged so bookings show it came from Google.
  r.post('/reputation/google/booking-link', requireAdmin, async (req, res) => {
    const p = await db.get('SELECT slug, online_booking FROM practices WHERE id = ?', req.user.practice_id);
    if (!p.slug || !p.online_booking) throw new HttpError(400, 'Turn on online booking (Settings → Practice) first');
    const uri = `${config.appUrl}/book/${p.slug}?src=google`;
    await setBookingLink(db, gbp, secret, req.user.practice_id, uri).catch((err) => { throw new HttpError(502, err.message); });
    await audit(db, req, 'reputation.booking_link', 'practices', req.user.practice_id);
    res.json({ ok: true, uri });
  });
  r.delete('/reputation/google', requireAdmin, async (req, res) => {
    await db.run('DELETE FROM review_connections WHERE practice_id = ?', req.user.practice_id);
    await audit(db, req, 'reputation.disconnect', 'practices', req.user.practice_id);
    res.json({ ok: true });
  });

  r.post('/reviews/:rid/draft', requirePermission('patients:write'), async (req, res) => {
    const review = await findOr404(db, 'reviews', req.params.rid, req.user.practice_id, 'Review');
    const practice = await db.get('SELECT name, phone FROM practices WHERE id = ?', req.user.practice_id);
    const out = await structured(config, {
      system: REPLY_SYSTEM, tool: REPLY_TOOL, effort: 'low', maxTokens: 2000,
      content: `Office: ${practice.name}. Phone: ${practice.phone || '(the office)'}.\nReview (${review.rating || '?'} stars) by ${review.author}:\n${review.text || '(no text — just a rating)'}`,
    });
    if (!out.reply) throw new HttpError(502, 'The AI didn’t return a reply — try again');
    await db.run("UPDATE reviews SET reply = ?, reply_status = CASE WHEN reply_status = 'posted' THEN reply_status ELSE 'draft' END WHERE id = ? AND reply_status != 'posted'", out.reply, review.id);
    res.json({ reply: out.reply, caution: out.caution || null });
  });
  r.post('/reviews/:rid/reply', requirePermission('patients:write'), async (req, res) => {
    const review = await findOr404(db, 'reviews', req.params.rid, req.user.practice_id, 'Review');
    const text = String(req.body?.text || '').trim().slice(0, 4000);
    if (!text) throw new HttpError(400, 'Write the reply');
    if (review.source !== 'google') throw new HttpError(400, 'Only Google reviews can be answered from here');
    await postReply(db, gbp, secret, review, text).catch((err) => { throw new HttpError(502, err.message); });
    await audit(db, req, 'review.reply', 'reviews', review.id, req.body.ai_drafted ? { drafted_by: 'AI', approved_by: req.user.name } : null);
    res.json(await db.get('SELECT * FROM reviews WHERE id = ?', review.id));
  });
  return r;
}

// Google sends the office owner back here after they allow access.
export function reputationPublicRoutes({ db, secret, gbp, config }) {
  const r = Router();
  r.get('/api/reputation/google/callback', async (req, res) => {
    const back = (q) => res.redirect(`/reputation?${new URLSearchParams(q)}`);
    try {
      const state = gbp ? await finishConnect(db, req, 'gbp-connect') : null;
      if (!state) return back({ google: 'error', message: 'That sign-in link expired or was started in another browser — try again from here' });
      if (req.query.error) return back({ google: 'error', message: String(req.query.error) });
      const t = await gbp.exchange(String(req.query.code || ''), `${config.appUrl}/api/reputation/google/callback`);
      const locations = await gbp.locations(t.accessToken);
      if (!locations.length) return back({ google: 'error', message: 'No business listing found on that Google account' });
      const row = { location: locations[0].name, location_title: locations[0].title, access_token: sealGbp(t.accessToken, secret), refresh_token: sealGbp(t.refreshToken, secret), expires_at: t.expiresAt };
      const have = await db.get('SELECT id FROM review_connections WHERE practice_id = ?', state.pid);
      if (have) await db.run('UPDATE review_connections SET location = ?, location_title = ?, access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE id = ?', row.location, row.location_title, row.access_token, row.refresh_token, row.expires_at, have.id);
      else await insert(db, 'review_connections', { practice_id: state.pid, ...row, created_by: state.sub });
      await audit(db, { ip: req.ip, user: { practice_id: state.pid, id: state.sub } }, 'reputation.connect', 'practices', state.pid, { location: row.location_title });
      await syncReviews(db, gbp, secret, state.pid).catch(failed(db, { practiceId: state.pid, kind: 'sync', key: 'reviews-sync', role: 'admin', title: 'Google reviews couldn’t be checked' }));
      back({ google: 'connected' });
    } catch (err) {
      back({ google: 'error', message: err.message.slice(0, 200) });
    }
  });
  return r;
}
