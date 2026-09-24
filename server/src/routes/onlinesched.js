import { Router } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, rateLimit, requirePermission } from '../auth.js';
import { audit, practiceNow, publicPractice, findOr404, insert, update } from '../util.js';
import { setActor } from '../actor.js';
import { loggedFetch } from '../issues.js';
import { officeHours } from '../hours.js';
import { restricted } from '../officeaccess.js';
import { CSP } from '../app.js';
import {
  visitTypes, publicType, settingsFor, cleanSettings, cleanVisitType, searchContext, searchDays, bookOnline, recordStep, bookingSummary, alertText,
  funnel, parseList, addDays, KINDS, KIND_LABELS, FLAG_LABELS, TRIAGE,
} from '../onlinesched.js';

// Online scheduling (OS1–OS5). Three routers:
//   onlineSchedPublicRoutes — the patient's booking page and website widget (mounted under /api/public, so every
//     change is recorded as the patient; all rate limited);
//   onlineSchedRoutes — the office: settings, visit types, the Online bookings list, alerts, analytics;
//   onlineSchedEmbedRoutes — /embed.js (the website loader) and a framable /book/:slug?embed=1.
// See onlinesched.js for the rules and docs/workflows/specs/OS-online-scheduling.md for the workflow.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function onlineSchedPublicRoutes({ db, messenger, payments = { enabled: false, mode: 'none' }, storage, config = {}, fetchImpl = globalThis.fetch }) {
  const r = Router();
  const reader = rateLimit({ windowMs: 60_000, max: 120, name: 'os-read' });
  const slotReader = rateLimit({ windowMs: 60_000, max: 40, name: 'os-slots' });
  // 20 bookings an hour from one address is plenty for a family or a front desk helping someone (tests raise it).
  const booker = rateLimit({ windowMs: 60 * 60_000, max: config.onlineBookPerHour || 20, name: 'os-book' });
  const eventer = rateLimit({ windowMs: 60 * 60_000, max: 400, name: 'os-events' });
  const outside = loggedFetch(db, fetchImpl);
  const asPatient = () => setActor({ source: 'patient', actor: 'Patient (online booking)' });

  const bookable = async (slug) => {
    const p = publicPractice(await db.get('SELECT * FROM practices WHERE slug = ? AND online_booking = 1', String(slug)));
    if (!p) throw new HttpError(404, 'Online booking is not available for this practice');
    return p;
  };
  const offices = async (p) => (await db.all('SELECT id, name, address, city, state, zip, phone, office_hours FROM locations WHERE practice_id = ? AND active = 1 ORDER BY sort, id', p.id))
    .map(({ office_hours: hours, ...l }) => ({ ...l, open_days: Object.entries(officeHours(hours ? { office_hours: hours } : p)).filter(([, x]) => x.length).map(([d]) => Number(d)) }));
  const typeFor = async (p, id) => {
    const vt = (await visitTypes(db, p.id)).find((t) => t.id === Number(id));
    if (!vt) throw new HttpError(400, 'Choose what the visit is for');
    return vt;
  };
  const officeFor = async (p, id, vt) => {
    const list = await offices(p);
    if (!list.length) return null;
    const found = list.find((l) => l.id === Number(id)) || (list.length === 1 ? list[0] : null);
    if (!found) throw new HttpError(400, 'Choose an office');
    if (vt.location_ids.length && !vt.location_ids.includes(found.id)) throw new HttpError(400, 'That visit isn’t booked online at this office');
    return found;
  };

  // Everything the booking page needs to draw itself: the practice's brand, offices and visit types.
  r.get('/os/:slug', reader, async (req, res) => {
    const p = await bookable(req.params.slug);
    const settings = await settingsFor(db, p.id);
    const types = await visitTypes(db, p.id);
    const providers = await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY type, name', p.id);
    res.set('Cache-Control', 'no-store').json({
      practice: { name: p.name, phone: p.phone, address: p.address, city: p.city, state: p.state, zip: p.zip, slug: p.slug, today: (await practiceNow(db, p.id)).slice(0, 10) },
      brand: { color: settings.brand_color || null, logo_url: settings.logo ? `/api/public/os/${encodeURIComponent(p.slug)}/logo?v=${encodeURIComponent(settings.updated_at || '')}` : null, headline: settings.headline, headline_es: settings.headline_es },
      locations: await offices(p),
      providers: providers.map((x) => ({ id: x.id, name: x.name, type: x.type })),
      visit_types: types.map((t) => publicType(t, { settings, payments })),
      family_max: settings.family_max,
      captcha_site_key: config.turnstileSecret ? config.turnstileSiteKey || null : null,
      payments: payments?.enabled ? payments.mode : null,
    });
  });

  r.get('/os/:slug/logo', reader, async (req, res) => {
    const p = await bookable(req.params.slug);
    const s = await settingsFor(db, p.id);
    if (!s.logo) throw new HttpError(404, 'No logo');
    res.set({ 'Content-Type': s.logo_mime, 'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin' }).send(Buffer.from(s.logo, 'base64'));
  });

  // ?visit_type_id=&location_id=&from=YYYY-MM-DD&people=1&provider_id=: the next few days with open times.
  r.get('/os/:slug/slots', reader, slotReader, async (req, res) => {
    const p = await bookable(req.params.slug);
    const vt = await typeFor(p, req.query.visit_type_id);
    const office = await officeFor(p, req.query.location_id, vt);
    const settings = await settingsFor(db, p.id);
    const people = Math.max(1, Math.min(Number(req.query.people) || 1, vt.family ? settings.family_max || 4 : 1));
    if (req.query.from && !DATE.test(String(req.query.from))) throw new HttpError(400, 'from must be YYYY-MM-DD');
    const providerId = req.query.provider_id ? Number(req.query.provider_id) : null;
    const ctx = await searchContext(db, p, vt, { locationId: office?.id ?? null, providerId });
    if (providerId && !ctx.providers.length) throw new HttpError(400, 'That provider isn’t booked online for this visit');
    const out = await searchDays(db, ctx, { from: req.query.from ? String(req.query.from) : null, people, days: Math.min(Number(req.query.days) || 4, 7) });
    res.json({ ...out, people, duration: vt.duration });
  });

  // A bot check when the office has one (Cloudflare Turnstile). Off unless both keys are set.
  const humanCheck = async (req, token) => {
    if (!config.turnstileSecret) return true;
    const check = await outside('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: config.turnstileSecret, response: String(token || ''), remoteip: req.ip || '' }),
    }).then((x) => x.json()).catch(() => ({ success: false }));
    return !!check.success;
  };

  r.post('/os/:slug/book', booker, async (req, res) => {
    asPatient();
    const p = await bookable(req.params.slug);
    const b = req.body || {};
    const today = (await practiceNow(db, p.id)).slice(0, 10);
    // Honeypot: a field people never see. Bots that fill it get a normal-looking answer and nothing is booked.
    if (b.website) {
      await recordStep(db, p.id, { session: b.session, step: 'bot', day: today });
      return res.status(201).json({ ok: true, status: 'requested', visits: [] });
    }
    if (!(await humanCheck(req, b.captcha))) throw new HttpError(400, 'Please complete the check that you’re not a robot');
    // Floods: a practice takes at most 60 online bookings an hour, and one phone or email at most 6 in a day.
    const hourAgo = new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    if (Number((await db.get('SELECT COUNT(*) AS n FROM online_bookings WHERE practice_id = ? AND created_at >= ?', p.id, hourAgo)).n) >= 60) {
      throw new HttpError(429, 'Online booking is busy right now — please call the office.');
    }
    const dayAgo = new Date(Date.now() - 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
    if (phone.length === 10 || b.email) {
      const n = await db.get(
        `SELECT COUNT(*) AS n FROM booking_requests WHERE practice_id = ? AND online_booking_id IS NOT NULL AND created_at >= ? AND (${phone.length === 10 ? "replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '+1', '') LIKE ?" : '1 = 0'} OR lower(email) = ?)`,
        p.id, dayAgo, ...(phone.length === 10 ? [`%${phone}`] : []), String(b.email || '').trim().toLowerCase(),
      );
      if (Number(n.n) >= 6) throw new HttpError(429, 'You’ve booked several visits today — please call us to book more.');
    }
    try {
      const out = await bookOnline({ db, messenger, payments, storage, config }, p, b, { ip: req.ip });
      res.status(out.repeat ? 200 : 201).json(out);
    } catch (err) {
      if (err.details?.taken) await recordStep(db, p.id, { session: b.session, step: 'taken', day: today });
      throw err;
    }
  });

  // Funnel steps from the page: { session, step, kind, source, variant }. No personal details are accepted.
  r.post('/os/:slug/events', eventer, async (req, res) => {
    const p = await bookable(req.params.slug);
    const b = req.body || {};
    if (!['view', 'office', 'reason', 'time', 'details'].includes(b.step)) throw new HttpError(400, 'Unknown step');
    await recordStep(db, p.id, { session: b.session, step: b.step, kind: b.kind, source: b.source, variant: b.variant, day: (await practiceNow(db, p.id)).slice(0, 10) });
    res.status(204).end();
  });

  return r;
}

// ---- The office ----
export function onlineSchedRoutes({ db, config = {} }) {
  const r = Router();
  const admin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only an administrator can change online booking')));
  const inOffice = (req, row) => !restricted(req.user) || row.location_id == null || req.user.location_ids.includes(row.location_id);

  r.get('/online-scheduling/settings', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const practice = await db.get('SELECT slug, online_booking FROM practices WHERE id = ?', pid);
    const { logo, ...settings } = await settingsFor(db, pid);
    const origin = config.appUrl || '';
    const page = practice.slug ? `${origin}/book/${practice.slug}` : null;
    res.json({
      settings: { ...settings, has_logo: !!logo, embed_origins: parseList(settings.embed_origins), risky_weekdays: parseList(settings.risky_weekdays) },
      visit_types: await visitTypes(db, pid, { all: true }),
      kinds: KINDS.map((k) => ({ key: k, label: KIND_LABELS[k] })), triage_template: TRIAGE, flag_labels: FLAG_LABELS,
      appointment_types: await db.all('SELECT id, name, duration, provider_type FROM appointment_types WHERE practice_id = ? AND active = 1 ORDER BY sort, name', pid),
      providers: await db.all('SELECT id, name, type FROM providers WHERE practice_id = ? AND active = 1 ORDER BY type, name', pid),
      locations: await db.all('SELECT id, name FROM locations WHERE practice_id = ? AND active = 1 ORDER BY sort, id', pid),
      online_booking: !!practice.online_booking,
      links: page ? {
        page, google: `${page}?src=google`, facebook: `${page}?src=facebook`, instagram: `${page}?src=instagram`, qr: `${page}?src=qr`,
        script: `<script src="${origin}/embed.js" data-practice="${practice.slug}" data-label="Book online"${settings.brand_color ? ` data-color="${settings.brand_color}"` : ''} async></script>`,
        iframe: `<iframe src="${page}?embed=1&src=website" title="Book an appointment" style="width:100%;min-height:760px;border:0" loading="lazy"></iframe>`,
      } : null,
    });
  });

  r.put('/online-scheduling/settings', admin, async (req, res) => {
    const pid = req.user.practice_id;
    const row = cleanSettings(req.body);
    const before = await settingsFor(db, pid);
    if (Object.keys(row).length) {
      const keys = Object.keys(row);
      await db.run(`UPDATE online_sched_settings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE practice_id = ?`, ...keys.map((k) => row[k]), req.user.id, pid);
      const shown = (o) => Object.fromEntries(keys.map((k) => [k, k === 'logo' ? (o[k] ? `[picture ${Math.round((o[k].length * 0.75) / 1024)} KB]` : null) : o[k]]));
      await audit(db, req, 'online_scheduling.settings', 'online_sched_settings', pid, null, { before: shown(before), after: shown(row) });
    }
    const { logo, ...out } = await settingsFor(db, pid);
    res.json({ ...out, has_logo: !!logo });
  });

  r.post('/online-scheduling/visit-types', admin, async (req, res) => {
    const pid = req.user.practice_id;
    const row = await cleanVisitType(db, pid, req.body);
    if (await db.get('SELECT id FROM online_visit_types WHERE practice_id = ? AND label = ?', pid, row.label)) throw new HttpError(409, 'There is already a visit type with that name');
    const id = await insert(db, 'online_visit_types', { practice_id: pid, ...row, created_by: req.user.id });
    await audit(db, req, 'online_scheduling.visit_type_create', 'online_visit_types', id, { label: row.label, kind: row.kind });
    res.status(201).json((await visitTypes(db, pid, { all: true })).find((t) => t.id === id));
  });

  r.put('/online-scheduling/visit-types/:id', admin, async (req, res) => {
    const pid = req.user.practice_id;
    const existing = await findOr404(db, 'online_visit_types', req.params.id, pid, 'Visit type');
    const row = await cleanVisitType(db, pid, req.body, existing);
    if (row.label && row.label !== existing.label && await db.get('SELECT id FROM online_visit_types WHERE practice_id = ? AND label = ? AND id <> ?', pid, row.label, existing.id)) throw new HttpError(409, 'There is already a visit type with that name');
    await update(db, 'online_visit_types', existing.id, pid, { ...row, updated_at: new Date().toISOString() });
    const after = await db.get('SELECT * FROM online_visit_types WHERE id = ?', existing.id);
    await audit(db, req, 'online_scheduling.visit_type_change', 'online_visit_types', existing.id, { label: after.label }, {
      before: Object.fromEntries(Object.keys(row).map((k) => [k, existing[k]])), after: Object.fromEntries(Object.keys(row).map((k) => [k, after[k]])),
    });
    res.json((await visitTypes(db, pid, { all: true })).find((t) => t.id === existing.id));
  });

  // The Online bookings list: made today / this week / the last 30 days, newest first, with where they came from.
  r.get('/online-scheduling/bookings', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const range = ['today', 'week', 'month'].includes(req.query.range) ? req.query.range : 'today';
    const from = range === 'today' ? today : addDays(today, range === 'week' ? -6 : -29);
    // created_at is UTC; a day's margin either side, then the practice's own date decides.
    const rows = await db.all('SELECT id FROM online_bookings WHERE practice_id = ? AND created_at >= ? AND status <> \'processing\' ORDER BY id DESC LIMIT 300', pid, `${addDays(from, -1)} 00:00`);
    const out = [];
    for (const { id } of rows) {
      const s = await bookingSummary(db, id);
      if (!inOffice(req, s)) continue;
      const tz = (await db.get('SELECT timezone FROM practices WHERE id = ?', pid))?.timezone || 'America/New_York';
      const local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(`${s.created_at.replace(' ', 'T')}Z`));
      if (local < from) continue;
      out.push(s);
    }
    res.json({ range, from, to: today, bookings: out, unseen: out.filter((s) => !s.seen_at).length, needs_person: out.filter((s) => s.needs_person && !s.seen_at).length });
  });

  r.get('/online-scheduling/bookings/:id', requirePermission('schedule:read'), async (req, res) => {
    const ob = await findOr404(db, 'online_bookings', req.params.id, req.user.practice_id, 'Online booking');
    if (!inOffice(req, ob)) throw new HttpError(404, 'Online booking not found');
    const s = await bookingSummary(db, ob.id);
    res.json({ ...s, alert: alertText(s) });
  });

  // "Seen": the front desk has looked at it (the alert and the list stop calling for attention).
  r.post('/online-scheduling/bookings/:id/seen', requirePermission('schedule:read'), async (req, res) => {
    const ob = await findOr404(db, 'online_bookings', req.params.id, req.user.practice_id, 'Online booking');
    if (!inOffice(req, ob)) throw new HttpError(404, 'Online booking not found');
    if (!ob.seen_at) {
      await db.run("UPDATE online_bookings SET seen_by = ?, seen_at = datetime('now') WHERE id = ? AND seen_at IS NULL", req.user.id, ob.id);
      await audit(db, req, 'online_booking.seen', 'online_bookings', ob.id, null, { after: { seen_by: req.user.id } });
    }
    res.json(await bookingSummary(db, ob.id));
  });

  // Conversion: page visits → each step → bookings → $ scheduled. Counts only; nothing about any person.
  r.get('/online-scheduling/analytics', requirePermission('schedule:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const to = DATE.test(String(req.query.to || '')) ? String(req.query.to) : today;
    const from = DATE.test(String(req.query.from || '')) ? String(req.query.from) : addDays(to, -29);
    if (from > to) throw new HttpError(400, 'from must be before to');
    res.json(await funnel(db, pid, { from, to, locationIds: restricted(req.user) ? req.user.location_ids : null }));
  });

  return r;
}

// ---- Website embed ----
const LOADER = `/* Dental Machine online booking. On your website, before </body>:
   <script src="ORIGIN/embed.js" data-practice="your-slug" async></script>
   Options: data-label="Book online", data-color="#0d9488", data-inline="true" (a button where the tag is),
   data-source="website", data-lang="es". Any element with data-dm-book opens it too (data-dm-book="emergency"
   starts on that kind of visit). Fires a "dentalmachine:booked" event on window when someone books. */
(function () {
  if (window.DentalMachineBooking) return;
  var s = document.currentScript || document.querySelector('script[src*="/embed.js"][data-practice]');
  if (!s) return;
  var origin = new URL(s.src).origin;
  var slug = s.getAttribute('data-practice');
  if (!slug) return;
  var color = /^#[0-9a-fA-F]{6}$/.test(s.getAttribute('data-color') || '') ? s.getAttribute('data-color') : '#0d9488';
  var label = s.getAttribute('data-label') || 'Book online';
  function url(kind) {
    var here = new URLSearchParams(window.location.search);
    var q = new URLSearchParams({ embed: '1', src: s.getAttribute('data-source') || 'website' });
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (here.get(k)) q.set(k, here.get(k).slice(0, 40)); });
    try { q.set('ref', window.location.hostname); } catch (e) { /* no host */ }
    if (s.getAttribute('data-lang')) q.set('lang', s.getAttribute('data-lang'));
    if (kind) q.set('kind', kind);
    return origin + '/book/' + encodeURIComponent(slug) + '?' + q.toString();
  }
  var overlay, frame, closeBtn, lastFocus;
  function build() {
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', label);
    var small = window.innerWidth < 640;
    box.style.cssText = 'position:relative;background:#fff;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);' + (small ? 'width:100%;height:100%;' : 'width:min(560px,96vw);height:min(860px,94vh);border-radius:14px;');
    closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\\u00d7';
    closeBtn.style.cssText = 'position:absolute;top:6px;right:8px;z-index:2;width:40px;height:40px;border:0;border-radius:20px;background:rgba(255,255,255,.9);font:400 28px/1 system-ui,sans-serif;cursor:pointer;color:#111;';
    closeBtn.onclick = close;
    frame = document.createElement('iframe');
    frame.title = label;
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    box.appendChild(closeBtn);
    box.appendChild(frame);
    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.style.display !== 'none') close(); });
    (document.body || document.documentElement).appendChild(overlay);
  }
  function open(kind) {
    if (!overlay) build();
    var want = url(typeof kind === 'string' ? kind : null);
    if (frame.getAttribute('data-src') !== want) { frame.src = want; frame.setAttribute('data-src', want); }
    lastFocus = document.activeElement;
    overlay.style.display = 'flex';
    document.documentElement.style.overflow = 'hidden';
    closeBtn.focus();
  }
  function close() {
    if (!overlay) return;
    overlay.style.display = 'none';
    document.documentElement.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !e.data || e.data.type !== 'dm-booking') return;
    if (e.data.action === 'close') close();
    if (e.data.action === 'booked') window.dispatchEvent(new CustomEvent('dentalmachine:booked', { detail: { status: e.data.status } }));
  });
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-dm-book]') : null;
    if (!t) return;
    e.preventDefault();
    open(t.getAttribute('data-dm-book') || null);
  });
  var b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.setAttribute('aria-haspopup', 'dialog');
  var inline = s.getAttribute('data-inline') === 'true';
  b.style.cssText = (inline ? '' : 'position:fixed;right:20px;bottom:20px;z-index:2147483000;box-shadow:0 6px 20px rgba(0,0,0,.25);')
    + 'background:' + color + ';color:#fff;border:0;border-radius:999px;padding:14px 22px;font:600 16px/1 system-ui,sans-serif;cursor:pointer;';
  b.onclick = function () { open(null); };
  if (s.getAttribute('data-button') !== 'none') { if (inline) s.parentNode.insertBefore(b, s); else (document.body || document.documentElement).appendChild(b); }
  window.DentalMachineBooking = { open: open, close: close };
})();
`;

export function onlineSchedEmbedRoutes({ db }) {
  const r = Router();
  const dist = process.env.CLIENT_DIST || join(dirname(fileURLToPath(import.meta.url)), '../../../client/dist');
  const loader = LOADER.replace('ORIGIN', '');
  r.get('/embed.js', (_req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Cross-Origin-Resource-Policy': 'cross-origin' }).send(loader);
  });
  // The booking page inside the practice's website: framing is allowed for this page only (everything else in the
  // app refuses to be framed), and only by the practice's own sites when it has listed them.
  const frameable = rateLimit({ windowMs: 60_000, max: 120, name: 'os-frame' });
  r.get('/book/:slug', frameable, async (req, res, next) => {
    if (req.query.embed !== '1' || !existsSync(join(dist, 'index.html'))) return next();
    const p = await db.get('SELECT id FROM practices WHERE slug = ? AND online_booking = 1', String(req.params.slug));
    const origins = p ? parseList((await db.get('SELECT embed_origins FROM online_sched_settings WHERE practice_id = ?', p.id))?.embed_origins) : [];
    res.removeHeader('X-Frame-Options');
    res.set('Content-Security-Policy', CSP.replace("frame-ancestors 'none'", `frame-ancestors ${origins.length ? origins.join(' ') : '*'}`));
    res.type('html').send(readFileSync(join(dist, 'index.html')));
  });
  return r;
}
