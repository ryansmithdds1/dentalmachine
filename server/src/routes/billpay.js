import { Router } from 'express';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { HttpError, rateLimit, requirePermission, signToken, verifyToken } from '../auth.js';
import { hit } from '../cluster.js';
import { setActor } from '../actor.js';
import { idempotency } from '../idempotency.js';
import { loggedFetch, raiseIssue } from '../issues.js';
import { audit, insert, findOr404, publicPractice } from '../util.js';
import { sendMessage } from '../messaging.js';
import { messageText, patientLang, subjectFor } from '../templates.js';
import { portalKey } from './portal.js';
import {
  accountByCode, accountSummary, householdIds, takePayment, settleReturn, achEnabled, guarantorIdOf, payCodeFor, rotatePayCode, formatCode,
} from '../billpay.js';

// "Pay my bill" from the practice's website (PT3). Three routers:
//   billpayPublicRoutes — under /api/public: find the bill without an account (the statement code, or last name +
//     date of birth + ZIP or phone), pay it, and optionally prove it's you (a one-time code) to open the portal.
//   billpayEmbedRoutes — /billpay.js, the one-line button for the website (a link to /billpay/:slug; payment pages
//     aren't framed: Stripe's page and Apple Pay need the top window).
//   billpayStaffRoutes — the office: the website snippet, and an account's code (to read out over the phone, or replace).
//
// Nothing about the account beyond the amount due is shown before the one-time code; lookups are rate-limited per
// address and per identity, carry a honeypot and an optional bot check (Cloudflare Turnstile, off unless both keys are
// set), and every step is audited as the patient.

const LOOKUP_TTL = 30 * 60; // a found bill stays open for 30 minutes
const CODE_TTL_MINUTES = 10;
const digits = (s) => String(s || '').replace(/\D/g, '');
const hashCode = (code) => createHash('sha256').update(String(code)).digest();

export default function billpayPublicRoutes({ db, secret, payments = { enabled: false, mode: 'none' }, messenger = null, config = {}, fetchImpl = globalThis.fetch }) {
  const r = Router();
  const lookupLimit = rateLimit({ windowMs: 15 * 60_000, max: config.billpayLookupsPer15Min || 10, name: 'billpay-lookup' });
  const verifyLimit = rateLimit({ windowMs: 15 * 60_000, max: 20, name: 'billpay-verify' });
  const payLimit = rateLimit({ windowMs: 15 * 60_000, max: 20, name: 'billpay-pay' });
  const readLimit = rateLimit({ windowMs: 60_000, max: 60, name: 'billpay-read' });
  const outside = loggedFetch(db, fetchImpl);
  const asPatient = () => setActor({ source: 'patient', actor: 'Patient (Pay my bill)' });

  const practiceFor = async (slug) => {
    const p = await db.get('SELECT * FROM practices WHERE slug = ? AND portal_enabled = 1', String(slug));
    if (!p) throw new HttpError(404, 'This bill-pay page isn’t available. Please call your dental office.');
    return publicPractice(p);
  };
  // The bill found by /lookup (a signed, short-lived token in the Authorization header).
  const found = async (req, _res, next) => {
    try {
      asPatient();
      const practice = await practiceFor(req.params.slug);
      const payload = verifyToken(String(req.headers.authorization || '').replace(/^Bearer /, ''), secret);
      if (!payload || payload.aud !== 'billpay' || payload.pid !== practice.id) throw new HttpError(401, 'Please look up your bill again');
      const account = await db.get("SELECT * FROM patients WHERE id = ? AND practice_id = ? AND status != 'archived' AND guarantor_id IS NULL", payload.sub, practice.id);
      if (!account) throw new HttpError(401, 'Please look up your bill again');
      req.billpay = { practice, account, via: payload.via };
      next();
    } catch (err) {
      next(err);
    }
  };
  const once = idempotency(db, secret, { scopeOf: (req) => `billpay${req.billpay.account.id}` });
  const bAudit = (req, action, entity, id, details) => audit(db, { ip: req.ip, user: { practice_id: req.billpay?.practice.id ?? details?.practice_id, id: null } }, action, entity, id, details, { actor: 'Patient (Pay my bill)' });
  const botCheck = async (req, token) => {
    if (!config.turnstileSecret) return true;
    const check = await outside('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: config.turnstileSecret, response: String(token || ''), remoteip: req.ip || '' }),
    }).then((x) => x.json()).catch(() => ({ success: false }));
    return !!check.success;
  };

  r.get('/billpay/:slug', readLimit, async (req, res) => {
    const p = await practiceFor(req.params.slug);
    res.json({
      name: p.name, phone: p.phone, city: p.city, state: p.state, portal_key: portalKey(p),
      payments_enabled: !!payments.enabled, mode: payments.mode, ach: achEnabled(payments), wallets: payments.mode === 'stripe',
      captcha_site_key: config.turnstileSecret ? config.turnstileSiteKey || null : null,
    });
  });

  // Find the bill. Answers with the amount due only (never a name, address or visit) until the one-time code.
  r.post('/billpay/:slug/lookup', lookupLimit, async (req, res) => {
    asPatient();
    const practice = await practiceFor(req.params.slug);
    const b = req.body || {};
    const notFound = () => new HttpError(404, `We couldn’t find a bill with those details. Check the code on your statement, or call ${practice.phone || 'the office'}.`);
    // Honeypot: a field people never see. Bots that fill it get the ordinary "not found".
    if (b.website) throw notFound();
    if (!(await botCheck(req, b.captcha))) throw new HttpError(400, 'Please complete the “I’m not a robot” check');
    let account = null;
    let via;
    if (b.code) {
      via = 'code';
      account = await accountByCode(db, practice.id, b.code);
    } else {
      via = 'identity';
      const last = String(b.last_name || '').trim().toLowerCase();
      const dob = String(b.dob || '').trim();
      const zip = digits(b.zip).slice(0, 5);
      const phone = digits(b.phone).slice(-10);
      if (!last || !/^\d{4}-\d{2}-\d{2}$/.test(dob) || (zip.length !== 5 && phone.length !== 10)) {
        throw new HttpError(400, 'Enter the code on your statement — or your last name, date of birth and ZIP code or phone number');
      }
      // Per person looked up, whatever device it comes from: guessing birth dates for a name stops quickly.
      if ((await hit(`billpay-identity:${practice.id}:${last}`, 60 * 60_000)) > 8) throw new HttpError(429, 'Too many tries — wait an hour, or call the office');
      const people = (await db.all("SELECT * FROM patients WHERE practice_id = ? AND dob = ? AND status != 'archived'", practice.id, dob))
        .filter((p) => String(p.last_name || '').trim().toLowerCase() === last && ((zip.length === 5 && String(p.zip || '').slice(0, 5) === zip) || (phone.length === 10 && digits(p.phone).slice(-10) === phone)));
      const accounts = [...new Set(people.map(guarantorIdOf))];
      if (accounts.length > 1) throw new HttpError(409, `We found more than one account. Please use the code on your statement, or call ${practice.phone || 'the office'}.`);
      if (accounts.length) account = await db.get("SELECT * FROM patients WHERE id = ? AND practice_id = ? AND status != 'archived'", accounts[0], practice.id);
    }
    if (!account) {
      await bAudit(req, 'billpay.lookup_miss', 'practices', practice.id, { via, practice_id: practice.id });
      throw notFound();
    }
    const summary = await accountSummary(db, practice.id, await householdIds(db, practice.id, account.id));
    await bAudit(req, 'billpay.lookup', 'patients', account.id, { via }, {});
    res.json({
      token: signToken({ sub: account.id, pid: practice.id, aud: 'billpay', via }, secret, LOOKUP_TTL),
      amount_due: summary.your_portion,
      // Which ways a one-time code can reach them (no addresses or numbers shown).
      verify: { sms: !!account.phone, email: !!account.email },
      language: patientLang(account),
    });
  });

  // Pay: the amount due or less (up to the amount due: this page doesn't show more of the account than that).
  r.post('/billpay/:slug/pay', payLimit, found, once, async (req, res) => {
    const { practice, account } = req.billpay;
    const b = req.body || {};
    const amount = Math.round(Number(b.amount));
    const summary = await accountSummary(db, practice.id, await householdIds(db, practice.id, account.id));
    if (summary.your_portion <= 0) throw new HttpError(400, 'There’s nothing to pay right now — thank you!');
    if (Number.isFinite(amount) && amount > summary.your_portion) throw new HttpError(400, 'That’s more than the amount due');
    const base = `${config.appUrl}/billpay/${encodeURIComponent(practice.slug)}`;
    const out = await takePayment(db, payments, messenger, {
      practice, payer: account, amount, how: 'new', method: b.method === 'ach' ? 'ach' : 'card', saveCard: false, receipt: b.receipt !== false,
      source: 'billpay', lang: b.lang === 'es' ? 'es' : patientLang(account), sandbox: { card_number: b.card_number, account_number: b.account_number },
      requestKey: req.get('Idempotency-Key') ? `b${account.id}-${req.get('Idempotency-Key')}` : null,
      successUrl: `${base}?paid=1&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${base}?pay=cancelled`,
    });
    await bAudit(req, out.paid ? 'billpay.payment' : 'billpay.payment_start', 'payment_requests', out.payment_request_id, { amount, method: b.method || 'card', patient_id: account.id });
    const after = out.paid ? (await accountSummary(db, practice.id, await householdIds(db, practice.id, account.id))).your_portion : null;
    res.status(201).json({ ...(out.url ? { url: out.url } : { paid: true, amount: out.amount, confirmation: out.entry_id, amount_due: after, receipt_emailed: b.receipt !== false && !!account.email }) });
  });

  r.get('/billpay/:slug/return', readLimit, found, async (req, res) => {
    const { practice, account } = req.billpay;
    const out = await settleReturn(db, payments, messenger, { practiceId: practice.id, payerIds: [account.id], sessionId: req.query.session_id });
    res.json({ status: out.status, amount: out.amount, confirmation: out.entry_id ?? null });
  });

  // A one-time code to the phone or email on file, to open the full account in the portal.
  r.post('/billpay/:slug/verify/send', verifyLimit, found, async (req, res) => {
    const { practice, account } = req.billpay;
    const channel = req.body?.channel === 'email' ? 'email' : 'sms';
    const to = channel === 'email' ? account.email : account.phone;
    if (!to) throw new HttpError(400, channel === 'email' ? 'We don’t have an email address on file — try a text' : 'We don’t have a mobile number on file — try email');
    if ((await hit(`billpay-otp:${practice.id}:${account.id}`, 60 * 60_000)) > 5) throw new HttpError(429, 'Too many codes requested — wait a little, or call the office');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await insert(db, 'portal_codes', {
      practice_id: practice.id, patient_id: account.id, contact: `billpay:${account.id}`, code_hash: hashCode(code).toString('hex'),
      expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString().slice(0, 19).replace('T', ' '),
    });
    try {
      await sendMessage(db, messenger, {
        practiceId: practice.id, patientId: account.id, kind: 'portal_code', channel, to,
        subject: subjectFor(patientLang(account), 'portal_code', `Your ${practice.name} sign-in code`, practice.name),
        body: await messageText(db, practice.id, 'portal_code', { code, minutes: String(CODE_TTL_MINUTES) }, patientLang(account)),
      });
    } catch (err) {
      await raiseIssue(db, { practiceId: practice.id, kind: 'message', key: `billpay-code:${account.id}`, role: 'front_desk', patientId: account.id, title: 'A patient’s bill-pay sign-in code couldn’t be sent', detail: err.message });
      throw new HttpError(502, `We couldn’t send the code just now. You can still pay above, or call ${practice.phone || 'the office'}.`);
    }
    await bAudit(req, 'billpay.code_sent', 'patients', account.id, { channel });
    res.json({ sent: true, channel });
  });

  r.post('/billpay/:slug/verify', verifyLimit, found, async (req, res) => {
    const { practice, account } = req.billpay;
    const key = `billpay:${account.id}`;
    const guessKey = `billpay-verify:${practice.id}:${account.id}`;
    if ((await hit(guessKey, 60 * 60_000, 0)) >= 10) throw new HttpError(429, 'Too many tries — wait an hour, or call the office');
    const given = hashCode(digits(req.body?.code));
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const live = await db.all('SELECT * FROM portal_codes WHERE practice_id = ? AND contact = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 3', practice.id, key, now);
    let row = null;
    for (const c of live) {
      if (!(await db.run('UPDATE portal_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < 5', c.id)).changes) continue;
      if (timingSafeEqual(Buffer.from(c.code_hash, 'hex'), given)) row = c;
    }
    if (!row || !(await db.run("UPDATE portal_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL", row.id)).changes) {
      await hit(guessKey, 60 * 60_000);
      throw new HttpError(403, live.length ? 'That code isn’t right — check it and try again' : 'That code has expired — send a new one');
    }
    await bAudit(req, 'portal.login', 'patients', account.id, { via: 'billpay' });
    res.json({ portal_token: signToken({ sub: account.id, pid: practice.id, aud: 'portal' }, secret, 2 * 3600), portal_key: portalKey(practice), first_name: account.first_name });
  });

  return r;
}

// ---- The website button ----
const LOADER = `/* Dental Machine "Pay my bill". On your website, before </body>:
   <script src="ORIGIN/billpay.js" data-practice="your-slug" async></script>
   Options: data-label="Pay my bill", data-color="#0d9488", data-inline="true" (a button where the tag is),
   data-button="none" (no button: any element with data-dm-pay opens it), data-lang="es".
   The bill-pay page opens in a new tab (on phones, in the same tab): payment pages aren't shown inside other sites. */
(function () {
  if (window.DentalMachinePay) return;
  var s = document.currentScript || document.querySelector('script[src*="/billpay.js"][data-practice]');
  if (!s) return;
  var origin = new URL(s.src).origin;
  var slug = s.getAttribute('data-practice');
  if (!slug) return;
  var color = /^#[0-9a-fA-F]{6}$/.test(s.getAttribute('data-color') || '') ? s.getAttribute('data-color') : '#0d9488';
  var label = s.getAttribute('data-label') || 'Pay my bill';
  function url() {
    var q = new URLSearchParams({ src: 'website' });
    if (s.getAttribute('data-lang')) q.set('lang', s.getAttribute('data-lang'));
    return origin + '/billpay/' + encodeURIComponent(slug) + '?' + q.toString();
  }
  function open() {
    if (window.innerWidth < 700) { window.location.href = url(); return; }
    var w = window.open(url(), '_blank', 'noopener');
    if (!w) window.location.href = url();
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-dm-pay]') : null;
    if (!t) return;
    e.preventDefault();
    open();
  });
  var a = document.createElement('a');
  a.href = url();
  a.textContent = label;
  a.setAttribute('role', 'button');
  a.setAttribute('data-dm-pay', '');
  var inline = s.getAttribute('data-inline') === 'true';
  a.style.cssText = (inline ? 'display:inline-block;' : 'position:fixed;left:20px;bottom:20px;z-index:2147483000;box-shadow:0 6px 20px rgba(0,0,0,.25);')
    + 'background:' + color + ';color:#fff;text-decoration:none;border:0;border-radius:999px;padding:14px 22px;font:600 16px/1 system-ui,sans-serif;cursor:pointer;';
  if (s.getAttribute('data-button') !== 'none') { if (inline) s.parentNode.insertBefore(a, s); else (document.body || document.documentElement).appendChild(a); }
  window.DentalMachinePay = { open: open, url: url };
})();
`;

export function billpayEmbedRoutes() {
  const r = Router();
  const loader = LOADER.replace('ORIGIN', '');
  r.get('/billpay.js', (_req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Cross-Origin-Resource-Policy': 'cross-origin' }).send(loader);
  });
  return r;
}

// ---- The office ----
export function billpayStaffRoutes({ db, config = {}, payments = { enabled: false, mode: 'none' } }) {
  const r = Router();
  r.get('/billpay/settings', requirePermission('billing:read'), async (req, res) => {
    const p = await db.get('SELECT slug, portal_enabled FROM practices WHERE id = ?', req.user.practice_id);
    const origin = config.appUrl || '';
    res.json({
      enabled: !!(p.slug && p.portal_enabled && payments.enabled), payments_mode: payments.mode, ach: achEnabled(payments),
      page_url: p.slug ? `${origin}/billpay/${encodeURIComponent(p.slug)}` : null,
      script: p.slug ? `<script src="${origin}/billpay.js" data-practice="${p.slug}" async></script>` : null,
      link: p.slug ? `<a href="${origin}/billpay/${encodeURIComponent(p.slug)}">Pay my bill</a>` : null,
      needs: [!p.slug && 'Set the practice’s web address name (slug) in Settings → Practice', !p.portal_enabled && 'Turn on the patient portal', !payments.enabled && 'Connect card payments'].filter(Boolean),
    });
  });
  const account = async (req) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    return p.guarantor_id ? db.get('SELECT * FROM patients WHERE id = ?', p.guarantor_id) : p;
  };
  r.get('/patients/:id/billpay-code', requirePermission('billing:read'), async (req, res) => {
    const g = await account(req);
    const code = await payCodeFor(db, req.user.practice_id, g.id);
    const slug = (await db.get('SELECT slug FROM practices WHERE id = ?', req.user.practice_id)).slug;
    await audit(db, req, 'billpay_code.view', 'patients', g.id);
    res.json({ account_id: g.id, code: formatCode(code), url: code && slug ? `${config.appUrl}/billpay/${encodeURIComponent(slug)}?code=${code}` : null });
  });
  r.post('/patients/:id/billpay-code/rotate', requirePermission('billing:write'), async (req, res) => {
    const g = await account(req);
    const code = await rotatePayCode(db, req.user.practice_id, g.id);
    await audit(db, req, 'billpay_code.rotate', 'patients', g.id, { reason: req.body?.reason || null });
    res.status(201).json({ account_id: g.id, code: formatCode(code) });
  });
  return r;
}
