import { Router } from 'express';
import { can, HttpError } from '../auth.js';
import { audit, findOr404, practiceNow } from '../util.js';
import {
  createBenchmarkClient, settingsOf, providerIdentities, practiceProfile, buildSubmission, sendNow, joinBenchmarks, leaveBenchmarks,
  benchmarkResults, sharedList, publicName, anonLabel, TERMS_VERSION, MIN_SAMPLE,
} from '../benchmarks.js';
import { PRACTICE_TYPES, DIMENSIONS, MONTH } from '../benchmarkservice/catalog.js';
import { DEFAULT_MIN_PEERS } from '../benchmarkservice/service.js';

const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only the practice owner (an administrator) can change benchmark sharing')));

// What the owner agrees to on joining. DRAFT: the terms and BAA language need legal review before launch.
export const TERMS = [
  'Once a night, Dental Machine sends your practice’s monthly numbers per provider (rates, dollars per exam or per hour, counts) to the benchmark service.',
  'No patient information is ever sent: no names, dates of birth, contact details, visit dates, procedures or notes — only totals and sample sizes.',
  'Your practice is identified only by a random id with its type, region, size, payer mix and years open. Providers appear as “Dr. #4821” unless they choose to show their name.',
  'A comparison is only shown when at least 10 practices are in the group, so no one can be singled out.',
  'You can see every payload that was sent, and leave at any time: your rows are deleted from the service and left out of every later benchmark.',
];

// Reports → Metrics → Benchmarks and Settings → Benchmarks (BM1–BM5; docs/workflows/specs/BM-benchmarks.md).
export default function benchmarkRoutes({ db, secret, client = null, fetchImpl }) {
  const r = Router();
  client ??= createBenchmarkClient({ db, ...(fetchImpl ? { fetchImpl } : {}) });
  const today = async (req) => (await practiceNow(db, req.user.practice_id)).slice(0, 10);
  const myProvider = (req) => db.get('SELECT id, name, type FROM providers WHERE practice_id = ? AND user_id = ? AND active = 1', req.user.practice_id, req.user.id);

  // Anyone signed in: whether the practice takes part, and the person's own name setting.
  r.get('/benchmarks/status', async (req, res) => {
    const s = await settingsOf(db, req.user.practice_id);
    const mine = await myProvider(req);
    let me = null;
    if (mine) {
      const id = (await providerIdentities(db, req.user.practice_id)).find((p) => p.id === mine.id);
      me = { provider_id: mine.id, name: mine.name, public_name: publicName(mine.name), anonymous_as: anonLabel(id.role, id.anon_code), show_name: id.show_name };
    }
    res.json({
      status: s.status, joined: s.status === 'joined', mode: client.mode, mode_label: client.label, available: client.mode !== 'off', why_unavailable: client.why || null,
      can_manage: req.user.role === 'admin', can_view: can(req.user, 'reports:read') || (can(req.user, 'reports:own') && !!mine), me,
    });
  });

  // How the practice compares for a month (default: last month, the latest complete one).
  r.get('/benchmarks/results', async (req, res) => {
    const pid = req.user.practice_id;
    const all = can(req.user, 'reports:read');
    const mine = all ? null : await myProvider(req);
    if (!all && !(can(req.user, 'reports:own') && mine)) throw new HttpError(403, 'Missing permission: reports:read');
    const day = await today(req);
    const month = String(req.query.month || '') || (() => { const d = new Date(`${day.slice(0, 7)}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
    if (!MONTH.test(month) || month > day.slice(0, 7) || month < `${Number(day.slice(0, 4)) - 2}${day.slice(4, 7)}`) throw new HttpError(400, 'month must be YYYY-MM, within the last two years');
    const out = await benchmarkResults(db, pid, { client, secret, month, today: day });
    if (!out.joined) return res.json(out);
    if (!all) {
      // Their own numbers only (as on Reports → Metrics with reports:own).
      const key = (await providerIdentities(db, pid)).find((p) => p.id === mine.id)?.provider_key;
      for (const m of out.metrics) m.mine = m.mine.filter((x) => x.provider_key === key);
      out.metrics = out.metrics.filter((m) => m.role !== 'practice');
      out.cards = out.cards.filter((c) => c.provider_id === mine.id);
      for (const b of out.leaderboards) for (const e of b.entries) if (e.mine && e.provider_key !== key) { delete e.you; e.mine = false; }
      out.leaderboards = out.leaderboards.filter((b) => b.role !== 'practice');
    }
    res.json(out);
  });

  // ---- The owner's settings ----
  r.get('/benchmarks/settings', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const s = await settingsOf(db, pid);
    const day = await today(req);
    const profile = await practiceProfile(db, pid, s, day);
    const people = (await providerIdentities(db, pid)).filter((p) => p.active);
    const sends = await db.get("SELECT COUNT(*) AS n, MAX(CASE WHEN status = 'sent' THEN finished_at END) AS last_ok FROM bm_sends WHERE practice_id = ?", pid);
    res.json({
      status: s.status, mode: client.mode, mode_label: client.label, available: client.mode !== 'off', why_unavailable: client.why || null,
      practice_type: s.practice_type, founded_year: s.founded_year ?? null, share_labor: !!Number(s.share_labor), terms_version: s.terms_version || null, current_terms: TERMS_VERSION,
      joined_at: s.joined_at || null, left_at: s.left_at || null, last_sent_at: sends.last_ok || s.last_sent_at || null, sends: Number(sends.n),
      profile, profile_labels: Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, DIMENSIONS[k][v]])), practice_types: PRACTICE_TYPES,
      anonymous_as: s.practice_code ? anonLabel('practice', s.practice_code) : null, min_peers: DEFAULT_MIN_PEERS, min_sample: MIN_SAMPLE,
      shared: sharedList(), terms: TERMS,
      providers: people.map((p) => ({ provider_id: p.id, name: p.name, role: p.role, anonymous_as: anonLabel(p.role, p.anon_code), show_name: p.show_name, public_name: publicName(p.name), linked: !!p.user_id })),
    });
  });

  const cleanSettings = (body) => {
    const out = {};
    if (body.practice_type !== undefined) {
      if (!Object.hasOwn(PRACTICE_TYPES, String(body.practice_type))) throw new HttpError(400, `practice_type must be one of ${Object.keys(PRACTICE_TYPES).join(', ')}`);
      out.practice_type = body.practice_type;
    }
    if (body.founded_year !== undefined) {
      const y = body.founded_year === null || body.founded_year === '' ? null : Number(body.founded_year);
      if (y !== null && (!Number.isInteger(y) || y < 1900 || y > new Date().getUTCFullYear())) throw new HttpError(400, 'founded_year must be a year between 1900 and this year');
      out.founded_year = y;
    }
    if (body.share_labor !== undefined) {
      if (typeof body.share_labor !== 'boolean') throw new HttpError(400, 'share_labor must be true or false');
      out.share_labor = body.share_labor ? 1 : 0;
    }
    return out;
  };

  r.put('/benchmarks/settings', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const s = await settingsOf(db, pid);
    const patch = cleanSettings(req.body || {});
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change');
    if (!(await db.get('SELECT practice_id FROM bm_settings WHERE practice_id = ?', pid))) await db.run('INSERT INTO bm_settings (practice_id) VALUES (?)', pid);
    const keys = Object.keys(patch);
    await db.run(`UPDATE bm_settings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE practice_id = ?`, ...keys.map((k) => patch[k]), req.user.id, pid);
    await audit(db, req, 'benchmark.settings', 'bm_settings', pid, null, { before: Object.fromEntries(keys.map((k) => [k, s[k] ?? null])), after: patch });
    res.json({ ok: true });
  });

  r.post('/benchmarks/join', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    if (req.body?.agree !== true) throw new HttpError(400, 'Read what is shared and tick “I agree” to join');
    const s = await settingsOf(db, pid);
    const patch = cleanSettings(req.body || {});
    const out = await joinBenchmarks(db, pid, { client, secret, userId: req.user.id, practiceType: patch.practice_type, foundedYear: patch.founded_year, shareLabor: patch.share_labor === undefined ? undefined : !!patch.share_labor });
    if (!out.already) {
      await audit(db, req, 'benchmark.join', 'bm_settings', pid, { terms_version: TERMS_VERSION, mode: client.mode, first_send: out.first_send?.error ? 'failed' : 'sent' }, { before: { status: s.status }, after: { status: 'joined' } });
    }
    res.status(out.already ? 200 : 201).json(out);
  });

  r.post('/benchmarks/leave', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const s = await settingsOf(db, pid);
    const out = await leaveBenchmarks(db, pid, { client, secret, userId: req.user.id });
    if (!out.already) await audit(db, req, 'benchmark.leave', 'bm_settings', pid, { removed_rows: out.removed_rows ?? null, confirmed: !!out.left }, { before: { status: s.status }, after: { status: out.left ? 'left' : 'leaving' } });
    res.json(out);
  });

  r.post('/benchmarks/send-now', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const s = await settingsOf(db, pid);
    if (s.status !== 'joined') throw new HttpError(409, 'Join benchmarks first');
    try {
      const out = await sendNow(db, pid, { client, secret, cause: 'manual', userId: req.user.id, source: 'human' });
      await audit(db, req, 'benchmark.send', 'bm_sends', out.send_id ?? null, { rows: out.accepted_rows ?? null, receipt: out.receipt ?? null });
      res.json(out);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `The numbers couldn’t be sent: ${err.message}. It’s in Needs attention; the nightly send will try again.`);
    }
  });

  // Exactly what would be sent tonight (nothing is sent).
  r.get('/benchmarks/preview', requireAdmin, async (req, res) => {
    const pid = req.user.practice_id;
    const s = await settingsOf(db, pid);
    const payload = await buildSubmission(db, pid, { today: await today(req), settings: { ...s, participant_id: s.participant_id || '(given when you join)', practice_key: s.practice_key || 'k_preview00000000', practice_code: s.practice_code || '0000' } });
    res.json({ payload, rows: payload.months.reduce((n, m) => n + m.rows.length, 0) });
  });

  // Everything that was sent, and each payload exactly as it went.
  r.get('/benchmarks/sends', requireAdmin, async (req, res) => {
    const rows = await db.all(
      `SELECT s.id, s.kind, s.cause, s.send_date, s.months, s.rows, s.accepted_rows, s.status, s.http_status, s.receipt, s.error, s.destination, s.source, s.created_at, s.finished_at, u.name AS created_by_name
       FROM bm_sends s LEFT JOIN users u ON u.id = s.created_by WHERE s.practice_id = ? ORDER BY s.id DESC LIMIT 200`, req.user.practice_id,
    );
    res.json(rows);
  });
  r.get('/benchmarks/sends/:id', requireAdmin, async (req, res) => {
    const row = await findOr404(db, 'bm_sends', req.params.id, req.user.practice_id, 'Sent payload');
    let payload = null;
    try { payload = JSON.parse(row.payload); } catch { payload = null; }
    res.json({ ...row, payload, payload_text: row.payload });
  });

  // A doctor's own choice to be named on leaderboards. Only the doctor can turn it on; they or the owner can turn it off.
  r.put('/benchmarks/providers/:id/name', async (req, res) => {
    const pid = req.user.practice_id;
    const p = await findOr404(db, 'providers', req.params.id, pid, 'Provider');
    if (typeof req.body?.show_name !== 'boolean') throw new HttpError(400, 'show_name must be true or false');
    const self = p.user_id && p.user_id === req.user.id;
    if (req.body.show_name && !self) throw new HttpError(403, 'Only the doctor can choose to show their own name');
    if (!req.body.show_name && !self && req.user.role !== 'admin') throw new HttpError(403, 'Only the doctor or the owner can change this');
    if (req.body.show_name && !publicName(p.name)) throw new HttpError(400, 'This provider name can’t be shown as is (it has numbers or an email in it); fix the name in Settings → Providers first');
    const id = (await providerIdentities(db, pid)).find((x) => x.id === p.id);
    if (id.show_name !== req.body.show_name) {
      await db.run("UPDATE bm_providers SET show_name = ?, display_name = ?, name_set_by = ?, name_set_at = datetime('now') WHERE provider_id = ? AND practice_id = ?",
        req.body.show_name ? 1 : 0, req.body.show_name ? publicName(p.name) : null, req.user.id, p.id, pid);
      await audit(db, req, 'benchmark.name_display', 'providers', p.id, { shown_as: req.body.show_name ? publicName(p.name) : anonLabel(id.role, id.anon_code) }, { before: { show_name: id.show_name ? 1 : 0 }, after: { show_name: req.body.show_name ? 1 : 0 } });
    }
    res.json({ ok: true, show_name: req.body.show_name, shown_as: req.body.show_name ? publicName(p.name) : anonLabel(id.role, id.anon_code) });
  });

  return r;
}
