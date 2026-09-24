import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { findOr404, audit, insert, update, isRealDate, toCents, MAX_CENTS } from '../util.js';
import {
  CHANNELS, CHANNEL_LABELS, METHOD_LABELS, WINDOWS, ensureSources, slug, cleanPromo, cleanUtm, campaignLink, utmSourceFor,
  marketingReport, reportPatients, reportCsv, patientsCsv, patientAttribution, setAttribution, resetAttribution, referralCode, syncPractice, backfillPractice,
} from '../marketing.js';

// Marketing ROI (MK1–MK2, docs/workflows/specs/MK-marketing.md). Mounted with the signed-in API.
// Seeing the numbers: reports:read (money columns also need billing:read). Setting up sources, campaigns and costs:
// administrators and people with finance:write (costs are money the practice spent). A chart's attribution: the
// patient permissions, like the rest of the chart.
export default function marketingRoutes({ db, config = {} }) {
  const r = Router();
  const manage = (req, _res, next) => (req.user.role === 'admin' || can(req.user, 'finance:write') ? next() : next(new HttpError(403, 'Only administrators or people who manage finances can change marketing sources, campaigns and costs')));
  const text = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) || null);
  const bool = (v) => (v === true || v === 1 || v === '1' ? 1 : v === false || v === 0 || v === '0' ? 0 : null);
  const idOf = (v, name) => {
    if (v == null || v === '') return null;
    if (!/^\d+$/.test(String(v))) throw new HttpError(400, `${name} must be a number`);
    return Number(v);
  };
  const date = (v, name) => {
    if (v == null || v === '') return null;
    if (!isRealDate(v)) throw new HttpError(400, `${name} must be a real date (YYYY-MM-DD)`);
    return v;
  };

  // ---- What the front desk picks from ("How did you hear about us?") ----
  r.get('/marketing/picker', requirePermission('patients:read'), async (req, res) => {
    await ensureSources(db, req.user.practice_id);
    const sources = await db.all('SELECT id, name, channel FROM marketing_sources WHERE practice_id = ? AND active = 1 ORDER BY name', req.user.practice_id);
    const campaigns = await db.all('SELECT id, name, source_id, promo_code FROM marketing_campaigns WHERE practice_id = ? AND active = 1 ORDER BY name', req.user.practice_id);
    res.json({ sources, campaigns });
  });

  // ---- Setup: sources, campaigns, costs ----
  r.get('/marketing/setup', requirePermission('reports:read'), async (req, res) => {
    const pid = req.user.practice_id;
    await ensureSources(db, pid);
    const practice = await db.get('SELECT slug, online_booking FROM practices WHERE id = ?', pid);
    const sources = await db.all('SELECT * FROM marketing_sources WHERE practice_id = ? ORDER BY active DESC, name', pid);
    const campaigns = await db.all(
      `SELECT c.*, s.name AS source_name, t.number AS tracking_number, t.source AS tracking_line FROM marketing_campaigns c JOIN marketing_sources s ON s.id = c.source_id
       LEFT JOIN tracking_numbers t ON t.id = c.tracking_number_id WHERE c.practice_id = ? ORDER BY c.active DESC, c.starts_on DESC, c.name`, pid,
    );
    const money = can(req.user, 'billing:read');
    const costs = money
      ? await db.all(
        `SELECT m.*, s.name AS source_name, c.name AS campaign_name, u.name AS created_by_name FROM marketing_costs m JOIN marketing_sources s ON s.id = m.source_id
         LEFT JOIN marketing_campaigns c ON c.id = m.campaign_id LEFT JOIN users u ON u.id = m.created_by WHERE m.practice_id = ? ORDER BY m.starts_on DESC, m.id DESC LIMIT 500`, pid,
      ) : null;
    const tracking = await db.all('SELECT id, number, source, active FROM tracking_numbers WHERE practice_id = ? ORDER BY source', pid);
    const messageCampaigns = await db.all("SELECT id, name, status FROM campaigns WHERE practice_id = ? ORDER BY id DESC LIMIT 100", pid);
    res.json({
      channels: CHANNELS.map((c) => ({ key: c, label: CHANNEL_LABELS[c] })), methods: METHOD_LABELS, windows: WINDOWS,
      booking_url: practice?.slug ? `${String(config.appUrl || '').replace(/\/$/, '')}/book/${practice.slug}` : null, online_booking: !!practice?.online_booking,
      sources, campaigns, costs, money, can_manage: req.user.role === 'admin' || can(req.user, 'finance:write'), tracking, message_campaigns: messageCampaigns,
    });
  });

  const sourceBody = (b, partial) => {
    const out = {};
    if (!partial || b.name !== undefined) {
      out.name = text(b.name, 80);
      if (!out.name) throw new HttpError(400, 'Give the source a name');
    }
    if (!partial || b.channel !== undefined) {
      if (!CHANNELS.includes(b.channel)) throw new HttpError(400, `channel must be one of: ${CHANNELS.join(', ')}`);
      out.channel = b.channel;
    }
    if (b.match_keys !== undefined) out.match_keys = String(b.match_keys || '').split(',').map((k) => slug(k)).filter(Boolean).slice(0, 30).join(',') || null;
    if (b.active !== undefined) {
      if (bool(b.active) == null) throw new HttpError(400, 'active must be true or false');
      out.active = bool(b.active);
    }
    return out;
  };
  const dupName = (err, what) => {
    if (/unique|duplicate/i.test(String(err.message))) throw new HttpError(409, `There's already a ${what} with that name`);
    throw err;
  };

  r.post('/marketing/sources', manage, async (req, res) => {
    const pid = req.user.practice_id;
    await ensureSources(db, pid);
    const row = sourceBody(req.body || {}, false);
    const id = await insert(db, 'marketing_sources', { practice_id: pid, ...row, match_keys: row.match_keys ?? slug(row.name), created_by: req.user.id }).catch((e) => dupName(e, 'source'));
    await audit(db, req, 'marketing.source_create', 'marketing_sources', id, { name: row.name, channel: row.channel });
    res.status(201).json(await db.get('SELECT * FROM marketing_sources WHERE id = ?', id));
  });
  r.patch('/marketing/sources/:sid', manage, async (req, res) => {
    const s = await findOr404(db, 'marketing_sources', req.params.sid, req.user.practice_id, 'Source');
    const row = sourceBody(req.body || {}, true);
    await update(db, 'marketing_sources', s.id, req.user.practice_id, row).catch((e) => dupName(e, 'source'));
    await audit(db, req, 'marketing.source_edit', 'marketing_sources', s.id, null, { before: Object.fromEntries(Object.keys(row).map((k) => [k, s[k]])), after: row });
    res.json(await db.get('SELECT * FROM marketing_sources WHERE id = ?', s.id));
  });

  const campaignBody = async (pid, b, partial, current = null) => {
    const out = {};
    if (!partial || b.name !== undefined) {
      out.name = text(b.name, 100);
      if (!out.name) throw new HttpError(400, 'Give the campaign a name');
    }
    if (!partial || b.source_id !== undefined) out.source_id = (await findOr404(db, 'marketing_sources', idOf(b.source_id, 'source_id'), pid, 'Source')).id;
    if (b.utm_campaign !== undefined || !partial) {
      const raw = b.utm_campaign == null || b.utm_campaign === '' ? (partial ? null : slug(out.name).slice(0, 40)) : b.utm_campaign;
      if (raw != null && !cleanUtm(raw)) throw new HttpError(400, 'The campaign tag can only use letters, numbers, - _ and . (up to 40)');
      out.utm_campaign = raw == null ? null : cleanUtm(raw);
    }
    if (b.promo_code !== undefined) {
      if (b.promo_code && !cleanPromo(b.promo_code)) throw new HttpError(400, 'A promo code is 2–20 letters or numbers');
      out.promo_code = b.promo_code ? cleanPromo(b.promo_code) : null;
    }
    if (b.tracking_number_id !== undefined) out.tracking_number_id = b.tracking_number_id ? (await findOr404(db, 'tracking_numbers', idOf(b.tracking_number_id, 'tracking_number_id'), pid, 'Tracking number')).id : null;
    if (b.message_campaign_id !== undefined) out.message_campaign_id = b.message_campaign_id ? (await findOr404(db, 'campaigns', idOf(b.message_campaign_id, 'message_campaign_id'), pid, 'Campaign')).id : null;
    if (b.starts_on !== undefined) out.starts_on = date(b.starts_on, 'starts_on');
    if (b.ends_on !== undefined) out.ends_on = date(b.ends_on, 'ends_on');
    const starts = out.starts_on !== undefined ? out.starts_on : current?.starts_on;
    const ends = out.ends_on !== undefined ? out.ends_on : current?.ends_on;
    if (starts && ends && ends < starts) throw new HttpError(400, 'The campaign ends before it starts');
    if (b.notes !== undefined) out.notes = text(b.notes, 1000);
    if (b.active !== undefined) {
      if (bool(b.active) == null) throw new HttpError(400, 'active must be true or false');
      out.active = bool(b.active);
    }
    return out;
  };
  const campaignConflict = (err) => {
    const m = String(err.message);
    if (/promo/i.test(m)) throw new HttpError(409, 'Another campaign already uses that promo code');
    if (/utm/i.test(m)) throw new HttpError(409, 'Another campaign already uses that campaign tag');
    if (/unique|duplicate/i.test(m)) throw new HttpError(409, "There's already a campaign with that name");
    throw err;
  };
  r.post('/marketing/campaigns', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const row = await campaignBody(pid, req.body || {}, false);
    const id = await insert(db, 'marketing_campaigns', { practice_id: pid, ...row, created_by: req.user.id }).catch(campaignConflict);
    await audit(db, req, 'marketing.campaign_create', 'marketing_campaigns', id, { name: row.name, source_id: row.source_id, utm_campaign: row.utm_campaign, promo_code: row.promo_code ?? null });
    res.status(201).json(await db.get('SELECT * FROM marketing_campaigns WHERE id = ?', id));
  });
  r.patch('/marketing/campaigns/:cid', manage, async (req, res) => {
    const c = await findOr404(db, 'marketing_campaigns', req.params.cid, req.user.practice_id, 'Campaign');
    const row = await campaignBody(req.user.practice_id, req.body || {}, true, c);
    await update(db, 'marketing_campaigns', c.id, req.user.practice_id, row).catch(campaignConflict);
    await audit(db, req, 'marketing.campaign_edit', 'marketing_campaigns', c.id, null, { before: Object.fromEntries(Object.keys(row).map((k) => [k, c[k]])), after: row });
    res.json(await db.get('SELECT * FROM marketing_campaigns WHERE id = ?', c.id));
  });

  // The campaign's tagged link: the booking page (or a page on the practice's own site with the booking button).
  r.get('/marketing/campaigns/:cid/link', requirePermission('reports:read'), async (req, res) => {
    const c = await findOr404(db, 'marketing_campaigns', req.params.cid, req.user.practice_id, 'Campaign');
    const s = await db.get('SELECT * FROM marketing_sources WHERE id = ?', c.source_id);
    const practice = await db.get('SELECT slug FROM practices WHERE id = ?', req.user.practice_id);
    const url = campaignLink({ appUrl: config.appUrl, practiceSlug: practice?.slug, source: s, campaign: c, medium: req.query.medium, target: req.query.target || null });
    res.json({ url, utm_source: utmSourceFor(s), utm_campaign: c.utm_campaign, promo_code: c.promo_code });
  });
  r.get('/marketing/sources/:sid/link', requirePermission('reports:read'), async (req, res) => {
    const s = await findOr404(db, 'marketing_sources', req.params.sid, req.user.practice_id, 'Source');
    const practice = await db.get('SELECT slug FROM practices WHERE id = ?', req.user.practice_id);
    res.json({ url: campaignLink({ appUrl: config.appUrl, practiceSlug: practice?.slug, source: s, campaign: null, medium: req.query.medium, target: req.query.target || null }), utm_source: utmSourceFor(s) });
  });

  // Costs: entered once (client_key), corrected by voiding with a reason, never edited or deleted.
  r.post('/marketing/costs', manage, async (req, res) => {
    const pid = req.user.practice_id;
    const b = req.body || {};
    const key = b.client_key == null ? null : String(b.client_key);
    if (key && !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new HttpError(400, 'client_key must be 8–80 letters, numbers, - or _');
    if (key) {
      const again = await db.get('SELECT * FROM marketing_costs WHERE practice_id = ? AND client_key = ?', pid, key);
      if (again) return res.status(200).json(again);
    }
    const source = await findOr404(db, 'marketing_sources', idOf(b.source_id, 'source_id'), pid, 'Source');
    let campaignId = null;
    if (b.campaign_id) {
      const c = await findOr404(db, 'marketing_campaigns', idOf(b.campaign_id, 'campaign_id'), pid, 'Campaign');
      if (c.source_id !== source.id) throw new HttpError(400, 'That campaign belongs to a different source');
      campaignId = c.id;
    }
    const startsOn = date(b.starts_on, 'starts_on');
    const endsOn = date(b.ends_on, 'ends_on') || startsOn;
    if (!startsOn) throw new HttpError(400, 'starts_on is required');
    if (endsOn < startsOn) throw new HttpError(400, 'The cost ends before it starts');
    if ((Date.parse(endsOn) - Date.parse(startsOn)) / 86400_000 > 3 * 366) throw new HttpError(400, 'Enter costs for three years or less at a time');
    if (!Number.isInteger(Number(b.amount))) throw new HttpError(400, 'amount must be whole cents');
    const amount = toCents(b.amount, 'amount');
    if (amount <= 0 || amount > MAX_CENTS) throw new HttpError(400, 'amount must be more than zero');
    let id;
    try {
      id = await insert(db, 'marketing_costs', { practice_id: pid, source_id: source.id, campaign_id: campaignId, starts_on: startsOn, ends_on: endsOn, amount, notes: text(b.notes, 500), client_key: key, created_by: req.user.id });
    } catch (err) {
      // The same entry sent twice at once: the first one stands.
      const again = key ? await db.get('SELECT * FROM marketing_costs WHERE practice_id = ? AND client_key = ?', pid, key) : null;
      if (again) return res.status(200).json(again);
      throw err;
    }
    await audit(db, req, 'marketing.cost_add', 'marketing_costs', id, null, { after: { source_id: source.id, campaign_id: campaignId, starts_on: startsOn, ends_on: endsOn, amount } });
    res.status(201).json(await db.get('SELECT * FROM marketing_costs WHERE id = ?', id));
  });
  r.post('/marketing/costs/:mid/void', manage, async (req, res) => {
    const c = await findOr404(db, 'marketing_costs', req.params.mid, req.user.practice_id, 'Cost');
    if (c.voided_at) return res.json(c);
    const reason = text(req.body?.reason, 300);
    if (!reason) throw new HttpError(400, 'Say why this cost is being voided');
    await db.run("UPDATE marketing_costs SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL", req.user.id, reason, c.id);
    await audit(db, req, 'marketing.cost_void', 'marketing_costs', c.id, { amount: c.amount }, { reason, before: { voided_at: null }, after: { voided_at: 'now', void_reason: reason } });
    res.json(await db.get('SELECT * FROM marketing_costs WHERE id = ?', c.id));
  });

  // Capture and backfill now (they also run by themselves).
  r.post('/marketing/sync', manage, async (req, res) => {
    const out = await syncPractice(db, req.user.practice_id, { full: true });
    const backfilled = await backfillPractice(db, req.user.practice_id);
    res.json({ ...out, backfilled });
  });

  // ---- MK2: dashboard, drill-down, CSV ----
  r.get('/marketing/report', requirePermission('reports:read'), async (req, res) => res.json(await marketingReport(db, req.user, req.query)));
  r.get('/marketing/report.csv', requirePermission('reports:read'), async (req, res) => {
    const rep = await marketingReport(db, req.user, req.query);
    await audit(db, req, 'marketing.export', 'marketing', null, { what: 'summary', from: rep.from, to: rep.to, by: rep.by, model: rep.model, rows: rep.rows.length, money: rep.money });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="marketing-${rep.by}-${rep.from}-${rep.to}.csv"`, 'Cache-Control': 'no-store' }).send(reportCsv(rep));
  });
  // The patients behind a number: names are patient information, so this needs patients:read too and is audited.
  r.get('/marketing/report/patients', requirePermission('reports:read'), requirePermission('patients:read'), async (req, res) => {
    const rep = await reportPatients(db, req.user, req.query);
    await audit(db, req, 'marketing.drill_down', 'marketing', null, { from: rep.from, to: rep.to, by: rep.by, model: rep.model, key: rep.key, patients: rep.total });
    res.json(rep);
  });
  r.get('/marketing/report/patients.csv', requirePermission('reports:read'), requirePermission('patients:read'), async (req, res) => {
    const rep = await reportPatients(db, req.user, req.query);
    await audit(db, req, 'marketing.export', 'marketing', null, { what: 'patients', from: rep.from, to: rep.to, by: rep.by, model: rep.model, key: rep.key, patients: rep.patients.length, money: rep.money });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="marketing-patients-${rep.from}-${rep.to}.csv"`, 'Cache-Control': 'no-store' }).send(patientsCsv(rep));
  });

  // ---- MK1: one patient's attribution ----
  const patientOf = (req) => findOr404(db, 'patients', req.params.pid, req.user.practice_id, 'Patient');
  r.get('/marketing/patients/:pid/attribution', requirePermission('patients:read'), async (req, res) => {
    const p = await patientOf(req);
    res.json(await patientAttribution(db, req.user.practice_id, p.id));
  });
  r.put('/marketing/patients/:pid/attribution', requirePermission('patients:write'), async (req, res) => {
    const p = await patientOf(req);
    res.json(await setAttribution(db, req, p.id, req.body || {}));
  });
  r.post('/marketing/patients/:pid/attribution/reset', requirePermission('patients:write'), async (req, res) => {
    const p = await patientOf(req);
    res.json(await resetAttribution(db, req, p.id));
  });
  // The patient's own "refer a friend" link to the booking page.
  r.get('/marketing/patients/:pid/referral-link', requirePermission('patients:read'), async (req, res) => {
    const p = await patientOf(req);
    const practice = await db.get('SELECT slug FROM practices WHERE id = ?', req.user.practice_id);
    if (!practice?.slug) throw new HttpError(409, 'Set up online booking first (Settings → Online booking) so there is a booking page to link to');
    const code = await referralCode(db, req.user.practice_id, p.id);
    res.json({ code, url: `${String(config.appUrl || '').replace(/\/$/, '')}/book/${practice.slug}?rp=${code}&utm_source=patient-referral&utm_medium=referral` });
  });

  return r;
}
