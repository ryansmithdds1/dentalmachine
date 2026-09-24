import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { requirePermission, HttpError } from '../auth.js';
import { findOr404, audit, insert, practiceNow } from '../util.js';
import {
  getSettings, saveSettings, worklist, resolveLine, postReady, postGroup, preview, stageRemittance, stageCheckLevel, paperLine, claimContext,
  raiseImportIssue, settleImportIssue, ACTIONS, KINDS, reasonWords,
} from '../eobauto.js';
import { billForToken, markOpened, payPage, accountPortion } from '../autobill.js';
import { reconciliation } from '../eobrecon.js';
import { readEob } from './insuranceai.js';
import { restricted } from '../officeaccess.js';
import { portalKey } from './portal.js';
import { publish } from '../events.js';

// Insurance autopilot (backlog A1–A5, docs/eob-autopilot.md): the exceptions worklist, the one-click posts,
// paper EOBs by scan or photo, the owner's switches (auto-posting, billing the patient) with a preview, the
// patient billing list and the daily reconciliation. Money endpoints are high-risk for the assistant (aiguard).
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const requireAdmin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Only an administrator changes the insurance autopilot')));
const MAX_EOB_BYTES = 10_000_000;

// What an uploaded EOB really is, by its first bytes (never by its name): PDFs and photos only.
function sniff(buf) {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const aiBlock = (mime, data) => (mime === 'application/pdf'
  ? { type: 'document', source: { type: 'base64', media_type: mime, data } }
  : { type: 'image', source: { type: 'base64', media_type: mime, data } });

export default function eobAutopilotRoutes({ db, config, storage, mailer, clearinghouse }) {
  const r = Router();
  const locs = (req) => (restricted(req.user) ? req.user.location_ids.map(Number) : null);

  r.get('/eob-autopilot', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const list = await worklist(db, pid, { locationIds: locs(req) });
    res.json({
      settings: await getSettings(db, pid), ...list, kinds: KINDS, actions: ACTIONS,
      mail: { enabled: !!mailer?.enabled, name: mailer?.name || null }, clearinghouse: { batch: !!clearinghouse?.batch, mode: clearinghouse?.mode || 'manual' },
      ai: !!(config.assistant?.enabled ?? process.env.ANTHROPIC_API_KEY),
    });
  });

  r.get('/eob-autopilot/lines/:id', requirePermission('billing:read'), async (req, res) => {
    const line = await findOr404(db, 'remit_lines', req.params.id, req.user.practice_id, 'Remittance line');
    const claim = line.claim_id ? await db.get('SELECT id, status, total_fee, paid_amount, patient_id, primary_claim_id, denial_reason FROM claims WHERE id = ?', line.claim_id) : null;
    // Open claims this line could belong to (for "match"): same billed amount first.
    const candidates = line.claim_id ? [] : await db.all(
      `SELECT c.id, c.total_fee, c.submitted_at, p.first_name, p.last_name FROM claims c JOIN patients p ON p.id = c.patient_id
       WHERE c.practice_id = ? AND c.status IN ('submitted','partially_paid','denied') ORDER BY CASE WHEN c.total_fee = ? THEN 0 ELSE 1 END, c.submitted_at DESC LIMIT 15`,
      req.user.practice_id, line.billed,
    );
    res.json({
      ...line, services: JSON.parse(line.services || '[]'), reasons: reasonWords(JSON.parse(line.reason_codes || '[]')), claim, candidates,
      actions: line.state === 'ready' ? [{ action: 'post', ...ACTIONS.post, label: 'Post' }] : line.state === 'exception' ? (await worklist(db, req.user.practice_id)).items.find((i) => i.key === `line:${line.id}`)?.actions || [] : [],
    });
  });

  // A person's decision on one line: post, bill the patient, resend, appeal, refund, match, reverse, dismiss.
  r.post('/eob-autopilot/lines/:id/:action', requirePermission('billing:write'), async (req, res) => {
    const line = await findOr404(db, 'remit_lines', req.params.id, req.user.practice_id, 'Remittance line');
    if (!ACTIONS[req.params.action] || req.params.action === 'send_secondary') throw new HttpError(404, 'Unknown action');
    const out = await resolveLine(db, req, line, req.params.action, { note: req.body?.note, claimId: req.body?.claim_id });
    res.json({ line: out, ...(await worklist(db, req.user.practice_id, { locationIds: locs(req) })) });
  });

  // "Post all clean ones": every row that reconciles exactly (or the chosen ones), as this person.
  r.post('/eob-autopilot/post-ready', requirePermission('billing:write'), async (req, res) => {
    const ids = Array.isArray(req.body?.line_ids) ? req.body.line_ids.map(Number).filter(Number.isInteger) : null;
    const out = await postReady(db, req.user.practice_id, { lineIds: ids, userId: req.user.id, req });
    await audit(db, req, 'eob.post_ready', 'remit_lines', null, { posted: out.posted, failed: out.failed.length });
    res.json({ ...out, ...(await worklist(db, req.user.practice_id, { locationIds: locs(req) })) });
  });

  // ---- The owner's switches ----
  r.get('/eob-autopilot/settings', requirePermission('billing:read'), async (req, res) => res.json(await getSettings(db, req.user.practice_id)));
  r.put('/eob-autopilot/settings', requirePermission('billing:write'), requireAdmin, async (req, res) => res.json(await saveSettings(db, req, req.body || {})));
  // What auto-posting would have done over the last 30 days, before turning it on.
  r.get('/eob-autopilot/preview', requirePermission('billing:read'), async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    res.json(await preview(db, req.user.practice_id, { days }));
  });

  // ---- Paper EOBs: a scan, a PDF or a phone photo ----
  // The bytes come as the body (image/jpeg, image/png, image/webp or application/pdf). The file is kept
  // (encrypted), read by AI into the same claim-by-claim shape as an ERA and judged by the same rule — but
  // nothing posts until a person says "Looks right — post". The same file twice returns the first read.
  r.post('/eob-autopilot/paper', requirePermission('billing:write'), express.raw({ type: () => true, limit: MAX_EOB_BYTES }), async (req, res) => {
    const pid = req.user.practice_id;
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) throw new HttpError(400, 'Add the EOB: a scan, a PDF or a photo');
    const mime = sniff(buf);
    if (!mime) throw new HttpError(415, 'A PDF or a photo (JPEG or PNG) of the EOB, please');
    const hash = createHash('sha256').update(buf).digest('hex');
    const seen = await db.get('SELECT * FROM paper_eobs WHERE practice_id = ? AND file_hash = ?', pid, hash);
    if (seen) return res.json(await paperView(seen.id, { duplicate: true }));
    const eob = await readEob(db, config, pid, [aiBlock(mime, buf.toString('base64'))]);
    const saved = await storage.save(pid, buf);
    const filename = String(req.query.filename || `EOB ${new Date().toISOString().slice(0, 10)}.${mime.split('/')[1].replace('jpeg', 'jpg')}`).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    const date = (await practiceNow(db, pid)).slice(0, 10);
    const id = await db.tx(async () => {
      const { id: eobId, changes } = await db.run(
        `INSERT INTO paper_eobs (practice_id, filename, mime, size, storage_key, encrypted, file_hash, payer_name, carrier_id, check_number, check_date, total_paid, method, provider_adjustments, totals_match, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, file_hash) DO NOTHING`,
        pid, filename, mime, buf.length, saved.storageKey, saved.encrypted ? 1 : 0, hash, eob.payer_name, eob.carrier_id, eob.check_number,
        eob.check_date && DATE.test(eob.check_date) ? eob.check_date : null, eob.amount || 0, eob.method, eob.provider_adjustments.length ? JSON.stringify(eob.provider_adjustments) : null, eob.totals_match ? 1 : 0, req.user.id,
      );
      if (!changes) return (await db.get('SELECT id FROM paper_eobs WHERE practice_id = ? AND file_hash = ?', pid, hash)).id;
      const newId = eobId ?? (await db.get('SELECT id FROM paper_eobs WHERE practice_id = ? AND file_hash = ?', pid, hash)).id;
      const lines = [];
      const byOrder = new Map();
      for (const [i, c] of eob.claims.entries()) {
        const claim = c.claim_id ? await db.get('SELECT * FROM claims WHERE id = ? AND practice_id = ?', c.claim_id, pid) : null;
        const items = claim ? (await claimContext(db, claim)).items : [];
        lines.push({ ...paperLine(c, items), control_number: claim ? `DM${claim.id}` : `${c.patient_name || 'unknown'}`.slice(0, 40) });
        byOrder.set(i, claim);
      }
      // Paper rows are keyed by the check number when there is one, so a second photo of the same EOB can't
      // stage the same claims twice.
      await stageRemittance(db, pid, {
        source: 'paper', lines, trace: eob.check_number || `EOB${newId}`, payerName: eob.payer_name, paperEobId: newId, date, userId: null,
        claimFor: (_l, order) => byOrder.get(order), method: eob.method,
      });
      await stageCheckLevel(db, pid, {
        source: 'paper', trace: eob.check_number || `EOB${newId}`, payerName: eob.payer_name, total: eob.totals_match ? null : eob.amount,
        paidLines: eob.claims.reduce((s, c) => s + (c.paid || 0), 0), adjustments: eob.provider_adjustments.map((a) => ({ ...a, amount: a.amount || 0 })), paperEobId: newId,
      });
      return newId;
    });
    await audit(db, req, 'eob.paper_read', 'paper_eobs', id, { claims: eob.claims.length, matched: eob.claims.filter((c) => c.claim_id).length, read_by: 'AI', mime, size: buf.length });
    publish(pid, { type: 'eob' });
    res.status(201).json(await paperView(id));
  });

  async function paperView(id, extra = {}) {
    const p = await db.get('SELECT * FROM paper_eobs WHERE id = ?', id);
    const lines = await db.all(
      `SELECT r.*, pt.first_name, pt.last_name FROM remit_lines r LEFT JOIN patients pt ON pt.id = r.patient_id WHERE r.paper_eob_id = ? ORDER BY r.line_no, r.id`, id,
    );
    const { storage_key: _k, encrypted: _e, file_hash: _h, ...rest } = p;
    return {
      ...rest, ...extra, provider_adjustments: p.provider_adjustments ? JSON.parse(p.provider_adjustments) : [],
      lines: lines.map((l) => ({ ...l, services: JSON.parse(l.services || '[]'), reasons: reasonWords(JSON.parse(l.reason_codes || '[]')), patient: l.first_name ? `${l.first_name} ${l.last_name}` : null })),
      clean: lines.filter((l) => l.state === 'ready').length, exceptions: lines.filter((l) => l.state === 'exception').length,
    };
  }
  r.get('/eob-autopilot/paper', requirePermission('billing:read'), async (req, res) => {
    res.json(await db.all(
      `SELECT p.id, p.filename, p.payer_name, p.check_number, p.check_date, p.total_paid, p.status, p.created_at, u.name AS created_by_name, a.name AS approved_by_name,
         (SELECT COUNT(*) FROM remit_lines r WHERE r.paper_eob_id = p.id AND r.state = 'ready') AS ready, (SELECT COUNT(*) FROM remit_lines r WHERE r.paper_eob_id = p.id AND r.state = 'exception') AS exceptions
       FROM paper_eobs p LEFT JOIN users u ON u.id = p.created_by LEFT JOIN users a ON a.id = p.approved_by WHERE p.practice_id = ? ORDER BY p.id DESC LIMIT 50`, req.user.practice_id,
    ));
  });
  r.get('/eob-autopilot/paper/:id', requirePermission('billing:read'), async (req, res) => {
    const p = await findOr404(db, 'paper_eobs', req.params.id, req.user.practice_id, 'EOB');
    res.json(await paperView(p.id));
  });
  // The EOB itself (it can list several patients, so it's for billing staff, and each viewing is recorded).
  r.get('/eob-autopilot/paper/:id/file', requirePermission('billing:read'), async (req, res) => {
    const p = await findOr404(db, 'paper_eobs', req.params.id, req.user.practice_id, 'EOB');
    const data = await storage.read(p.storage_key, !!p.encrypted);
    await audit(db, req, 'eob.file_view', 'paper_eobs', p.id);
    res.set({ 'Content-Type': p.mime, 'Content-Disposition': `inline; filename="${p.filename.replace(/"/g, '')}"`, 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(data));
  });

  // "Looks right — post": a person approves the AI's read; every clean row posts as them, against one check.
  // The rows that aren't clean stay on the worklist. Doing it twice posts nothing more.
  r.post('/eob-autopilot/paper/:id/post', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const p = await findOr404(db, 'paper_eobs', req.params.id, pid, 'EOB');
    if (p.status === 'posted') return res.json(await paperView(p.id, { already: true }));
    if (p.status !== 'read') throw new HttpError(409, `This EOB is ${p.status}`);
    // Posted today (the books' date); the check keeps the date printed on it.
    const date = (await practiceNow(db, pid)).slice(0, 10);
    const ready = await db.all("SELECT * FROM remit_lines WHERE paper_eob_id = ? AND state = 'ready' ORDER BY id", p.id);
    const result = await db.tx(async () => {
      const flipped = await db.run("UPDATE paper_eobs SET status = 'posted', approved_by = ?, approved_at = datetime('now') WHERE id = ? AND status = 'read'", req.user.id, p.id);
      if (!flipped.changes) return null;
      const checkId = await insert(db, 'insurance_checks', {
        practice_id: pid, carrier_id: p.carrier_id, payer_name: p.payer_name, check_number: p.check_number, check_date: p.check_date || date,
        amount: ready.reduce((s, l) => s + l.paid, 0), method: p.method === 'eft' ? 'eft' : 'check', provider_adjustments: p.provider_adjustments, created_by: req.user.id,
      });
      await db.run('UPDATE paper_eobs SET insurance_check_id = ? WHERE id = ?', checkId, p.id);
      await db.run('UPDATE remit_lines SET insurance_check_id = ? WHERE paper_eob_id = ?', checkId, p.id);
      let posted = 0;
      for (const l of ready) {
        await postGroup(db, [l.id], { userId: req.user.id, req, date, method: p.method === 'eft' ? 'eft' : 'check' });
        posted++;
      }
      return { checkId, posted };
    });
    if (!result) return res.json(await paperView(p.id, { already: true }));
    // The approval is the person's: the AI only read the page.
    await audit(db, req, 'eob.paper_post', 'paper_eobs', p.id, { posted: result.posted, insurance_check_id: result.checkId, read_by: 'AI', approved_by: req.user.name });
    const left = Number((await db.get("SELECT COUNT(*) AS n FROM remit_lines WHERE paper_eob_id = ? AND state = 'exception'", p.id)).n);
    await raiseImportIssue(db, pid, { key: `eob:${p.id}`, entity: 'paper_eobs', entityId: p.id, title: `Paper EOB ${p.check_number || `#${p.id}`} from ${p.payer_name || 'the payer'}`, count: left });
    await settleImportIssue(db, { practice_id: pid, paper_eob_id: p.id });
    res.json(await paperView(p.id, { posted: result.posted }));
  });

  // Every remittance on a claim (ERA rows and paper EOBs, with the EOB's file): "the EOB filed on the claim".
  r.get('/claims/:cid/remittances', requirePermission('billing:read'), async (req, res) => {
    const claim = await findOr404(db, 'claims', req.params.cid, req.user.practice_id, 'Claim');
    const rows = await db.all(
      `SELECT r.id, r.source, r.state, r.kind, r.reason, r.trace, r.payer_name, r.billed, r.paid, r.contractual, r.patient_resp, r.created_at, r.posted_at, r.resolution,
         r.era_import_id, r.paper_eob_id, p.filename AS eob_filename, p.mime AS eob_mime FROM remit_lines r LEFT JOIN paper_eobs p ON p.id = r.paper_eob_id
       WHERE r.practice_id = ? AND r.claim_id = ? ORDER BY r.id`, req.user.practice_id, claim.id,
    );
    res.json(rows.map((x) => ({ ...x, eob_url: x.paper_eob_id ? `/api/eob-autopilot/paper/${x.paper_eob_id}/file` : null })));
  });

  // One key: the secondary goes out with what the primary paid. For a paper primary EOB, the EOB is filed on
  // the patient's chart (category EOB) and attached to the secondary claim as "Other payer's EOB"; an
  // electronic primary's payment travels inside the 837 itself. The claim is then sent through the usual
  // path (the screen calls /claims/submit, or /claims/:id/submit without a clearinghouse connection).
  r.post('/eob-autopilot/claims/:cid/send-secondary', requirePermission('billing:write'), async (req, res) => {
    const pid = req.user.practice_id;
    const claim = await findOr404(db, 'claims', req.params.cid, pid, 'Claim');
    if (!claim.primary_claim_id) throw new HttpError(409, 'This isn’t a secondary claim');
    if (!['draft', 'denied'].includes(claim.status)) throw new HttpError(409, `The secondary claim is already ${claim.status}`);
    const primary = await db.get('SELECT * FROM claims WHERE id = ? AND practice_id = ?', claim.primary_claim_id, pid);
    if (!primary || !['paid', 'partially_paid'].includes(primary.status)) throw new HttpError(409, 'The primary claim hasn’t been paid yet');
    const eobLine = await db.get("SELECT paper_eob_id FROM remit_lines WHERE claim_id = ? AND paper_eob_id IS NOT NULL AND state = 'posted' ORDER BY id DESC LIMIT 1", primary.id);
    let attachment = null;
    if (eobLine) {
      const eob = await db.get('SELECT * FROM paper_eobs WHERE id = ?', eobLine.paper_eob_id);
      attachment = await db.get("SELECT id FROM claim_attachments WHERE claim_id = ? AND report_type = 'EB' AND removed_at IS NULL", claim.id);
      if (!attachment) {
        await db.tx(async () => {
          const source = `eob:${eob.id}`;
          let doc = await db.get('SELECT id FROM documents WHERE patient_id = ? AND source = ? AND deleted_at IS NULL', claim.patient_id, source);
          if (!doc) {
            const docId = await insert(db, 'documents', {
              practice_id: pid, patient_id: claim.patient_id, category: 'eob', filename: `Primary EOB ${eob.check_number || eob.id}.${eob.mime === 'application/pdf' ? 'pdf' : eob.mime.split('/')[1].replace('jpeg', 'jpg')}`,
              mime: eob.mime, size: eob.size, storage_key: eob.storage_key, encrypted: eob.encrypted, uploaded_by: req.user.id, source, claim_id: primary.id,
              notes: 'The primary insurance’s EOB, filed for the secondary claim. It may list other patients — don’t hand it to the patient.',
            });
            doc = { id: docId };
          }
          const id = await insert(db, 'claim_attachments', { practice_id: pid, claim_id: claim.id, document_id: doc.id, report_type: 'EB', transmission: 'EL', created_by: req.user.id });
          attachment = { id };
        });
      }
    }
    await audit(db, req, 'claim.secondary_prepare', 'claims', claim.id, { primary_claim_id: primary.id, eob_attachment_id: attachment?.id ?? null });
    res.json({ claim_id: claim.id, attachment_id: attachment?.id ?? null, send_via: clearinghouse?.batch ? 'clearinghouse' : 'manual' });
  });

  // ---- Patient billing (A4) ----
  r.get('/eob-autopilot/billing', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const bills = await db.all(
      `SELECT b.*, p.first_name, p.last_name FROM balance_bills b JOIN patients p ON p.id = b.patient_id
       WHERE b.practice_id = ? AND (b.status = 'active' OR b.created_at >= ?) ORDER BY CASE b.status WHEN 'active' THEN 0 ELSE 1 END, b.id DESC LIMIT 200`,
      pid, new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 19).replace('T', ' '),
    );
    for (const b of bills) {
      if (b.status !== 'active') continue;
      b.owes_now = Math.max(0, await accountPortion(db, pid, b.patient_id));
      b.sends = await db.all(
        `SELECT r.due_date, r.status, r.channel, r.result, r.finished_at FROM cadence_runs r JOIN cadence_enrollments e ON e.id = r.enrollment_id
         WHERE e.source_type = 'balance_bill' AND e.source_id = ? ORDER BY r.due_date, r.id`, b.id,
      );
    }
    const holds = await db.all(
      `SELECT h.id, h.patient_id, h.note, h.created_at, p.first_name, p.last_name, u.name AS created_by_name FROM cadence_holds h JOIN patients p ON p.id = h.patient_id
       LEFT JOIN users u ON u.id = h.created_by WHERE h.practice_id = ? AND h.type = 'patient_balance' AND h.released_at IS NULL ORDER BY h.id DESC`, pid,
    );
    res.json({ settings: await getSettings(db, pid), bills, holds });
  });

  // ---- Reconciliation (A5) ----
  r.get('/eob-autopilot/reconciliation', requirePermission('billing:read'), async (req, res) => {
    const pid = req.user.practice_id;
    const today = (await practiceNow(db, pid)).slice(0, 10);
    const to = String(req.query.to || today);
    const from = String(req.query.from || new Date(Date.parse(`${to}T12:00:00Z`) - 13 * 86400_000).toISOString().slice(0, 10));
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw new HttpError(400, 'Give from and to as dates, from first');
    res.json(await reconciliation(db, pid, { from, to, today }));
  });

  return r;
}

// ---- The patient's pay link (public) ----
export function eobAutopilotPublicRoutes({ db, config, secret, payments }) {
  const r = Router();
  const portalUrl = (practice) => `${config.appUrl || ''}/portal/${portalKey(practice)}`;
  r.get('/pay-balance/:token', async (req, res) => {
    const found = await billForToken(db, secret, req.params.token);
    if (await markOpened(db, found, req.get('user-agent'))) {
      await audit(db, { user: { practice_id: found.bill.practice_id, id: null } }, 'balance_bill.link_opened', 'balance_bills', found.bill.id, null, { patientId: found.bill.patient_id });
    }
    res.set('Cache-Control', 'no-store').type('html').send(payPage({ ...found, canPay: payments?.mode === 'stripe' && found.amount >= 50, portalUrl: portalUrl(found.practice) }));
  });
  // "Pay now": a card page at the processor for what's owed today (the payment posts from its webhook, as any
  // text-to-pay does). The same bill's unpaid page is reused rather than making a new one each tap.
  r.post('/pay-balance/:token', async (req, res) => {
    const { bill, practice, patient, amount, link } = await billForToken(db, secret, req.params.token);
    await markOpened(db, { bill, link }, req.get('user-agent'));
    if (payments?.mode !== 'stripe' || amount < 50) return res.redirect(303, portalUrl(practice));
    let pr = bill.payment_request_id ? await db.get("SELECT * FROM payment_requests WHERE id = ? AND status = 'pending' AND amount = ?", bill.payment_request_id, amount) : null;
    if (!pr?.url) {
      const id = await insert(db, 'payment_requests', { practice_id: practice.id, patient_id: patient.id, amount, created_by: null });
      const session = await payments.stripe('POST', 'checkout/sessions', {
        mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(amount),
        'line_items[0][price_data][product_data][name]': `${practice.name} - balance after insurance`, client_reference_id: String(id),
        'metadata[payment_request_id]': String(id), 'metadata[practice_id]': String(practice.id), 'payment_intent_data[metadata][practice_id]': String(practice.id),
        success_url: `${config.appUrl}/pay/success`, cancel_url: `${config.appUrl}/pay/cancelled`, ...(patient.email ? { customer_email: patient.email } : {}),
      }, { idempotencyKey: `balance-bill-${bill.id}-${amount}-${id}` });
      await db.run('UPDATE payment_requests SET session_id = ?, url = ? WHERE id = ?', session.id, session.url, id);
      await db.run('UPDATE balance_bills SET payment_request_id = ? WHERE id = ?', id, bill.id);
      pr = { id, url: session.url };
      await audit(db, { user: { practice_id: practice.id, id: null } }, 'payment_request.create', 'payment_requests', id, { amount, balance_bill_id: bill.id }, { patientId: patient.id });
    }
    res.redirect(303, pr.url);
  });
  return r;
}
