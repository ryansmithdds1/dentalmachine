import { HttpError } from './auth.js';
import { insert, audit, practiceNow, recorded } from './util.js';
import { withActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { postClaimPayment, reverseEntry, withPlan } from './services.js';
import { requireHuman } from './aiguard.js';
import { claimEvent, claimForControl } from './era.js';
import { publish } from './events.js';

// ---- Insurance payments on autopilot (backlog A1–A3, docs/eob-autopilot.md) ----
// Every remittance — an electronic ERA (835) or a paper EOB read by AI — is broken into one row per claim
// (remit_lines) and each row is judged by the same rule: it posts on its own only when it reconciles exactly
// (paid + contractual write-off + patient responsibility = billed, for our claim and its procedures, no
// denial, reversal or overpayment, and the payer allowed what the PPO fee schedule says). Everything else is
// an exception for a person, with the reason in plain words and the next step.
//   - ERAs: a clean row posts at once when the practice turned auto-posting on (as the automation actor), or
//     when a person imported the file (as that person); otherwise it waits as 'ready' for one click.
//   - Paper EOBs: never post on their own (AI read them: rule 10); a person's "Looks right — post" posts the
//     clean rows.
// Money moves only through postClaimPayment (ledger entries, never edits) and each posting is idempotent: the
// row flips from ready/exception to posted in the same transaction, so a second attempt posts nothing.

export const DEFAULT_SETTINGS = { autopost: false, autopost_since: null, billing: false, billing_since: null, min_balance: 500, wait_days: 3, paper_days: 21 };
export function settingsOf(practice) {
  let s = {};
  try {
    s = JSON.parse(practice?.eob_autopilot || '{}') || {};
  } catch {
    s = {};
  }
  return { ...DEFAULT_SETTINGS, ...s };
}
export const getSettings = async (db, practiceId) => settingsOf(await db.get('SELECT eob_autopilot FROM practices WHERE id = ?', practiceId));

const intIn = (v, lo, hi, msg) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, msg);
  return n;
};
// Only an administrator changes these (the route checks); every change is audited with before and after.
export async function saveSettings(db, req, body = {}) {
  const pid = req.user.practice_id;
  const before = await getSettings(db, pid);
  const next = { ...before };
  const today = (await practiceNow(db, pid)).slice(0, 10);
  for (const k of ['autopost', 'billing']) {
    if (body[k] == null) continue;
    if (typeof body[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
    // Turning it on counts from today: claims that closed before aren't billed after the fact.
    if (body[k] && !before[k]) next[`${k}_since`] = today;
    next[k] = body[k];
  }
  if (body.min_balance != null) next.min_balance = intIn(body.min_balance, 0, 100_000, 'The minimum balance is in cents, from $0 to $1,000');
  if (body.wait_days != null) next.wait_days = intIn(body.wait_days, 0, 60, 'Wait 0 to 60 days after the claim closes');
  if (body.paper_days != null) next.paper_days = intIn(body.paper_days, 3, 90, 'Mail paper 3 to 90 days after the first text or email');
  if (JSON.stringify(next) === JSON.stringify(before)) return before;
  await db.run('UPDATE practices SET eob_autopilot = ? WHERE id = ?', JSON.stringify(next), pid);
  await audit(db, req, 'eob_autopilot.settings', 'practices', pid, { autopost: next.autopost, billing: next.billing }, {
    before: flat(before), after: flat(next), reason: body.reason ? String(body.reason).slice(0, 300) : null,
  });
  publish(pid, { type: 'eob' });
  return next;
}
const flat = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [`eob_${k}`, v]));

// ---- Reason codes in plain words, with the usual next step ----
const CARC_HELP = {
  1: ['Deductible — the patient pays this part', 'bill_patient'], 2: ['Coinsurance — the patient’s share', 'bill_patient'], 3: ['Copay', 'bill_patient'],
  4: ['The code doesn’t fit the tooth, surface or modifier', 'resend'], 5: ['The code doesn’t fit the place of service', 'resend'],
  16: ['Information is missing from the claim', 'resend'], 18: ['The payer says it’s a duplicate — the original may still pay', 'dismiss'],
  22: ['Another insurance should pay first', 'resend'], 23: ['Reduced by what the other insurance paid', 'post'],
  26: ['Done before the coverage started', 'bill_patient'], 27: ['Done after the coverage ended', 'bill_patient'],
  29: ['The filing deadline passed', 'appeal'], 31: ['The payer can’t find the patient as a member', 'resend'],
  42: ['More than the maximum allowed (written off)', 'post'], 45: ['PPO fee-schedule reduction (written off)', 'post'],
  49: ['Routine service not covered', 'bill_patient'], 50: ['The payer doesn’t consider it necessary', 'appeal'],
  96: ['Not covered', 'bill_patient'], 97: ['Included in another procedure (bundled)', 'appeal'], 107: ['A related service wasn’t paid', 'appeal'],
  109: ['Not covered by this payer — send it to the right one', 'resend'], 119: ['The yearly maximum has been reached', 'bill_patient'],
  131: ['Negotiated discount (written off)', 'post'], 151: ['Frequency limit — done too often', 'appeal'], 167: ['Diagnosis not covered', 'appeal'],
  181: ['The code wasn’t valid on the date of service', 'resend'], 197: ['Pre-authorization was needed', 'appeal'],
  204: ['Not covered under the patient’s plan', 'bill_patient'], 226: ['Information the payer asked for wasn’t sent', 'resend'],
  252: ['An attachment (x-ray, narrative) is needed', 'resend'], 253: ['Sequestration reduction (written off)', 'post'],
};
// Contractual write-offs: what the practice agreed not to charge (CO group, fee-schedule reasons only).
const CONTRACTUAL = new Set(['45', '42', '131', '253']);
const PATIENT_SHARE = new Set(['1', '2', '3']);
const isContractual = (a) => a.group === 'CO' && CONTRACTUAL.has(String(a.reason));
export function reasonWords(codes) {
  return [...new Set(codes)].map((code) => {
    const reason = code.split('-')[1];
    const [text, step] = CARC_HELP[reason] || [null, null];
    return { code, text, step };
  });
}
export const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const KINDS = {
  ready: 'Ready to post', denied: 'Denied', underpaid: 'Underpaid', overpaid: 'Overpaid', unmatched: 'No matching claim', partial: 'Partial payment',
  reversal: 'Payer took money back', review: 'Needs a look', secondary: 'Secondary claim to send',
};
export const ACTIONS = {
  post: { label: 'Post as the payer says', key: 'p' }, bill_patient: { label: 'Bill the patient', key: 'b' }, resend: { label: 'Correct & resend', key: 'r' },
  appeal: { label: 'Appeal', key: 'a' }, refund: { label: 'Refund task', key: 'f' }, match: { label: 'Match to a claim', key: 'm' },
  reverse: { label: 'Reverse the payment', key: 'v' }, dismiss: { label: 'Nothing to do', key: 'd' }, send_secondary: { label: 'Send secondary', key: 's' },
};
export function actionsFor(line) {
  const codes = JSON.parse(line.reason_codes || '[]');
  switch (line.kind) {
    case 'denied': {
      // Billing the patient is offered unless every reason is the practice's own liability (CO group).
      const patientCan = !codes.length || codes.some((c) => c.startsWith('PR-')) || codes.every((c) => !c.startsWith('CO-'));
      const first = reasonWords(codes).map((w) => w.step).find((s) => ['resend', 'appeal', 'bill_patient'].includes(s));
      const list = ['bill_patient', 'resend', 'appeal', 'dismiss'].filter((a) => a !== 'bill_patient' || patientCan);
      return first && list.includes(first) ? [first, ...list.filter((a) => a !== first)] : list;
    }
    case 'underpaid': return ['post', 'appeal', 'dismiss'];
    case 'overpaid': return ['refund', 'post', 'dismiss'];
    case 'unmatched': return ['match', 'dismiss'];
    case 'partial': return ['post', 'dismiss'];
    case 'reversal': return ['reverse', 'dismiss'];
    case 'ready': return ['post'];
    default: return ['post', 'appeal', 'dismiss'];
  }
}

// ---- The rule ----
const OPEN = ['submitted', 'partially_paid', 'denied'];
const sumOf = (list, f) => list.reduce((s, x) => s + (Number(f(x)) || 0), 0);

// Pairs the payer's service lines with our claim's procedures: same code and fee first, then same code.
function mapServices(services, items) {
  const unused = [...items];
  return services.map((s) => {
    let i = s.claim_item_id ? unused.findIndex((x) => x.id === s.claim_item_id) : -1;
    if (i < 0) i = unused.findIndex((x) => x.code === s.code && x.fee === s.billed);
    if (i < 0) i = unused.findIndex((x) => x.code === s.code);
    const item = i >= 0 ? unused.splice(i, 1)[0] : null;
    return { ...s, claim_item_id: item?.id ?? null };
  });
}

// Judges one claim's lines from one remittance. Pure: the caller supplies the claim, its procedures and the
// PPO-expected allowed amount. Returns the amounts and { kind: null } when it reconciles exactly, or the kind
// of exception and why, in words for the office.
export function classify({ claim, items = [], lines, expected = null }) {
  const adj = lines.flatMap((l) => [...(l.adjustments || []), ...(l.services || []).flatMap((s) => s.adjustments || [])]);
  const billed = sumOf(lines, (l) => l.billed);
  const paid = sumOf(lines, (l) => l.paid);
  const pr = sumOf(lines, (l) => l.patient_resp);
  const contractual = sumOf(adj.filter(isContractual), (a) => a.amount);
  const prAdj = adj.filter((a) => a.group === 'PR');
  const otherAdj = adj.filter((a) => a.group !== 'PR' && !isContractual(a));
  const other = sumOf(otherAdj, (a) => a.amount);
  const deductible = sumOf(prAdj.filter((a) => String(a.reason) === '1'), (a) => a.amount);
  const codes = [...new Set(adj.filter((a) => a.amount !== 0 || !isContractual(a)).map((a) => `${a.group}-${a.reason}`))];
  const services = mapServices(lines.flatMap((l) => l.services || []), items);
  const out = { billed, paid, patient_resp: pr, contractual, other, deductible, codes, services, expected_allowed: expected };
  const v = (kind, reason) => ({ ...out, kind, reason });
  const words = (list) => reasonWords(list).map((w) => `${w.code}${w.text ? ` ${w.text}` : ''}`).join('; ');

  if (!claim) return v('unmatched', 'No claim of ours matches this line — match it to a claim or mark it as not ours');
  if (lines.some((l) => l.status === 'not_our_claim')) return v('unmatched', 'The payer says this isn’t our claim');
  if (lines.some((l) => l.status === 'reversal') || paid < 0) return v('reversal', `The payer took back ${money(Math.abs(paid))} — reverse the earlier posting (the claim reopens)`);
  if (!OPEN.includes(claim.status)) {
    return claim.status === 'paid' ? v('overpaid', `Claim #${claim.id} was already paid — this looks like a second payment of ${money(paid)}`) : v('review', `Claim #${claim.id} is ${claim.status}`);
  }
  const denied = lines.every((l) => l.status === 'denied' || (l.paid === 0 && String(l.status_code) === '4'));
  if (denied) {
    if (codes.some((c) => c.endsWith('-18'))) return v('review', 'The payer says this is a duplicate claim — the original may still pay; check before resending');
    return v('denied', `Denied: ${words(codes) || 'no reason given'}`);
  }
  if (claim.status === 'partially_paid') return v('partial', 'Part of this claim was paid before — check what’s left before posting');
  if (billed !== claim.total_fee) {
    return billed < claim.total_fee ? v('partial', `The payer answered for ${money(billed)} of the ${money(claim.total_fee)} billed; the rest may come separately`)
      : v('review', `The payer shows ${money(billed)} billed, but the claim is ${money(claim.total_fee)}`);
  }
  if (paid > billed) return v('overpaid', `Paid ${money(paid)} on a ${money(billed)} claim`);
  if (sumOf(prAdj, (a) => a.amount) !== pr) return v('review', `Patient responsibility is ${money(pr)} on the claim but ${money(sumOf(prAdj, (a) => a.amount))} in the reasons`);
  if (paid + contractual + other + pr !== billed) {
    return v('review', `The amounts don’t add up: paid ${money(paid)} + written off ${money(contractual + other)} + patient ${money(pr)} ≠ billed ${money(billed)}`);
  }
  const notCovered = prAdj.filter((a) => !PATIENT_SHARE.has(String(a.reason)) && a.amount);
  const lineDenials = otherAdj.filter((a) => a.group === 'CO' && a.amount);
  if (lineDenials.length || notCovered.length) return v('denied', `Part denied: ${words([...lineDenials, ...notCovered].map((a) => `${a.group}-${a.reason}`))}`);
  if (other) return v('review', `Adjustments that aren’t a fee-schedule write-off: ${words(otherAdj.map((a) => `${a.group}-${a.reason}`))}`);
  if (services.length) {
    const stray = services.filter((s) => !s.claim_item_id);
    if (stray.length) return v('review', `Line ${stray.map((s) => s.code).join(', ')} isn’t on our claim`);
    if (services.length < items.length) return v('partial', `The payer answered ${services.length} of the ${items.length} procedures`);
    const claimLevel = lines.some((l) => (l.adjustments || []).length);
    const off = services.find((s) => s.billed !== sumOf([s], (x) => x.paid) + sumOf(s.adjustments || [], (a) => a.amount) && !claimLevel);
    if (off) return v('review', `Line ${off.code} doesn’t add up`);
    if (sumOf(services, (s) => s.paid) !== paid) return v('review', 'The procedure lines don’t add up to the claim payment');
  }
  if (expected != null) {
    const allowed = billed - contractual;
    const slack = Math.max(1, items.length);
    if (allowed < expected - slack) return v('underpaid', `The payer allowed ${money(allowed)}; your PPO fee schedule says ${money(expected)} (${money(expected - allowed)} short)`);
    if (allowed > expected + slack) return v('overpaid', `The payer allowed ${money(allowed)}, ${money(allowed - expected)} more than your PPO fee schedule — they may ask for it back`);
  }
  return v(null, 'Reconciles exactly');
}

// The claim's procedures and what the PPO fee schedule says the payer should allow (null when the policy
// has no fee schedule, or a procedure isn't on it).
export async function claimContext(db, claim) {
  const items = await db.all('SELECT ci.id, ci.fee, ci.procedure_id, pr.code, pr.tooth FROM claim_items ci JOIN procedures pr ON pr.id = ci.procedure_id WHERE ci.claim_id = ? ORDER BY ci.id', claim.id);
  const raw = await db.get('SELECT * FROM patient_insurance WHERE id = ?', claim.patient_insurance_id);
  let expected = null;
  if (raw) {
    const policy = await withPlan(db, raw);
    const scheduleId = policy.fee_schedule_id ?? (await db.get('SELECT fee_schedule_id FROM insurance_carriers WHERE id = ?', policy.carrier_id))?.fee_schedule_id;
    if (scheduleId && items.length) {
      let total = 0;
      for (const it of items) {
        const fee = (await db.get('SELECT fee FROM fee_schedule_items WHERE fee_schedule_id = ? AND code = ?', scheduleId, it.code))?.fee;
        if (fee == null) { total = null; break; }
        total += Math.min(fee, it.fee);
      }
      expected = total;
    }
  }
  return { items, expected, priority: raw?.priority || null };
}

// ---- One ERA claim (CLP) and one paper EOB claim, in the same shape ----
export const eraLine = (c) => ({
  control_number: c.control_number, status: c.status, status_code: c.status_code, billed: c.billed, paid: c.paid, patient_resp: c.patient_responsibility,
  payer_claim_number: c.payer_claim_number || null, adjustments: c.adjustments || [],
  services: (c.services || []).map((s) => ({ code: s.code, billed: s.billed, paid: s.paid, patient_resp: s.patient_resp, write_off: s.write_off, adjustments: s.adjustments || [] })),
});
// A paper EOB claim as read by AI (cents): the write-off is the contractual (CO-45) amount, the deductible
// PR-1 and the rest of the patient's share PR-2. Anything unexplained stays unexplained, so a misread
// number shows up as "doesn't add up" instead of posting.
export function paperLine(c, items = []) {
  const lines = c.lines || [];
  const services = lines.map((l) => {
    const item = items.find((x) => x.id === l.claim_item_id);
    const billed = l.billed ?? item?.fee ?? 0;
    const pr = l.patient_resp ?? 0;
    const ded = Math.min(pr, l.deductible ?? 0);
    const adjustments = [
      ...(l.write_off ? [{ group: 'CO', reason: '45', amount: l.write_off }] : []),
      ...(ded ? [{ group: 'PR', reason: '1', amount: ded }] : []),
      ...(pr - ded ? [{ group: 'PR', reason: '2', amount: pr - ded }] : []),
    ];
    return { code: String(l.code || '').toUpperCase(), claim_item_id: l.claim_item_id ?? null, billed, paid: l.paid || 0, patient_resp: pr, write_off: l.write_off || 0, adjustments };
  });
  const billed = sumOf(services, (s) => s.billed);
  return {
    control_number: null, status: c.denied ? 'denied' : 'processed_primary', status_code: c.denied ? '4' : '1', billed, paid: c.paid || 0,
    patient_resp: c.patient_responsibility ?? sumOf(services, (s) => s.patient_resp), payer_claim_number: c.payer_claim_number || null,
    adjustments: [], services, remarks: c.remarks || null,
  };
}

// ---- Staging and posting ----
const jobReq = (practiceId) => ({ user: { practice_id: practiceId, id: null } });
const AUTOPILOT = { source: 'automation', actor: 'Insurance autopilot (ERA auto-post)', userId: null };

async function stageRow(db, row) {
  const { changes, id } = await db.run(
    `INSERT INTO remit_lines (practice_id, source, era_import_id, paper_eob_id, insurance_check_id, dedupe_key, trace, payer_name, line_no, lines_count, control_number, claim_id, patient_id,
       location_id, status_code, billed, paid, contractual, patient_resp, other_adjustments, deductible, expected_allowed, payer_claim_number, reason_codes, services, state, kind, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, dedupe_key) DO NOTHING`,
    row.practice_id, row.source, row.era_import_id ?? null, row.paper_eob_id ?? null, row.insurance_check_id ?? null, row.dedupe_key, row.trace ?? null, row.payer_name ?? null,
    row.line_no, row.lines_count ?? 1, row.control_number ?? null, row.claim_id ?? null, row.patient_id ?? null, row.location_id ?? null, row.status_code ?? null,
    row.billed || 0, row.paid || 0, row.contractual || 0, row.patient_resp || 0, row.other_adjustments || 0, row.deductible || 0, row.expected_allowed ?? null,
    row.payer_claim_number ?? null, JSON.stringify(row.reason_codes || []), JSON.stringify(row.services || []), row.state, row.kind ?? null, row.reason ? String(row.reason).slice(0, 500) : null,
  );
  if (!changes) return null;
  return id ?? (await db.get('SELECT id FROM remit_lines WHERE practice_id = ? AND dedupe_key = ?', row.practice_id, row.dedupe_key)).id;
}

const keyPart = (s) => String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40) || '-';

// Groups a remittance's claim lines by our claim (a payer can split one claim into several lines), judges
// each group, stores it, and — for ERAs — posts the clean ones when allowed. Returns one detail per group
// (and per line that matched nothing) for the import's summary. Runs inside the import's transaction.
export async function stageRemittance(db, practiceId, { source, lines, trace, payerName, eraImportId = null, paperEobId = null, checkId = null, date, userId = null, claimFor, method = 'eft' }) {
  const settings = await getSettings(db, practiceId);
  const groups = new Map();
  const details = [];
  for (const [order, l] of lines.entries()) {
    const claim = await claimFor(l, order);
    const k = claim ? `c${claim.id}` : `u${order}`;
    if (!groups.has(k)) groups.set(k, { claim, lines: [], order });
    groups.get(k).lines.push(l);
  }
  for (const g of groups.values()) {
    const ctx = g.claim ? await claimContext(db, g.claim) : { items: [], expected: null };
    const verdict = classify({ claim: g.claim, items: ctx.items, lines: g.lines, expected: ctx.expected });
    const autopost = !verdict.kind && source === 'era' && (userId || settings.autopost);
    const row = {
      practice_id: practiceId, source, era_import_id: eraImportId, paper_eob_id: paperEobId, insurance_check_id: checkId, trace, payer_name: payerName,
      dedupe_key: `${source}:${keyPart(payerName)}:${keyPart(trace)}:${g.claim ? `C${g.claim.id}` : keyPart(g.lines[0].control_number)}:${g.order}`,
      line_no: g.order, lines_count: g.lines.length, control_number: g.lines[0].control_number, claim_id: g.claim?.id ?? null, patient_id: g.claim?.patient_id ?? null,
      location_id: g.claim?.location_id ?? null, status_code: [...new Set(g.lines.map((l) => l.status_code))].join(','),
      billed: verdict.billed, paid: verdict.paid, contractual: verdict.contractual, patient_resp: verdict.patient_resp, other_adjustments: verdict.other, deductible: verdict.deductible,
      expected_allowed: verdict.expected_allowed, payer_claim_number: g.lines.find((l) => l.payer_claim_number)?.payer_claim_number ?? null,
      reason_codes: verdict.codes, services: verdict.services, state: verdict.kind ? 'exception' : 'ready', kind: verdict.kind, reason: verdict.kind ? verdict.reason : null,
    };
    const base = {
      order: g.order, control_number: row.control_number, claim_id: row.claim_id, billed: row.billed, paid: row.paid, patient_responsibility: row.patient_resp,
      write_off: row.contractual, reasons: reasonWords(verdict.codes).map(({ code, text }) => ({ code, text })),
    };
    const lineId = await stageRow(db, row);
    if (!lineId) {
      details.push({ ...base, result: 'skipped (already received)' });
      continue;
    }
    base.line_id = lineId;
    // An ERA is the payer's own file, so its denial moves the claim on arrival. A paper EOB is only an AI
    // read of a page: its denial stays a 'denied' row on the worklist and is applied (as that person's) when
    // someone approves it — "Looks right — post" or their decision on the line (see applyPaperDenial).
    if (source === 'era' && verdict.kind === 'denied' && g.claim && ['submitted', 'partially_paid'].includes(g.claim.status) && row.paid === 0) {
      const reason = denialReason(verdict.codes);
      await recorded(db, 'claims', g.claim.id, () => db.run("UPDATE claims SET status = 'denied', denial_reason = ?, payer_claim_number = COALESCE(?, payer_claim_number) WHERE id = ? AND status IN ('submitted','partially_paid')", reason.slice(0, 300), row.payer_claim_number, g.claim.id));
      await claimEvent(db, g.claim, '835', 'denied', `Denied: ${reason}`);
    } else if (verdict.kind === 'review' && verdict.codes.some((c) => c.endsWith('-18')) && g.claim) {
      await claimEvent(db, g.claim, source === 'era' ? '835' : 'eob', 'request', `Payer says duplicate claim — check before resending`);
    }
    if (autopost) {
      // A failure posting one claim (the books are closed for that date, the claim changed) leaves it as an
      // exception instead of stopping the rest of the remittance.
      try {
        await db.savepoint(() => (userId ? postGroup(db, [lineId], { userId, method, date }) : withActor(AUTOPILOT, () => postGroup(db, [lineId], { userId: null, method, date, automatic: true }))));
        details.push({ ...base, result: 'posted' });
      } catch (err) {
        await db.run("UPDATE remit_lines SET state = 'exception', kind = 'review', reason = ? WHERE id = ? AND state = 'ready'", `Couldn’t post automatically: ${err.message}`.slice(0, 500), lineId);
        details.push({ ...base, result: 'needs_review', exception: 'review', note: err.message });
      }
    } else if (!verdict.kind) details.push({ ...base, result: 'ready' });
    else if (verdict.kind === 'unmatched') details.push({ ...base, result: 'unmatched', exception: 'unmatched', note: verdict.reason });
    else if (verdict.kind === 'denied' && row.paid === 0) details.push({ ...base, result: 'denied', exception: 'denied', note: verdict.reason });
    else details.push({ ...base, result: 'needs_review', exception: verdict.kind, note: verdict.reason });
  }
  details.sort((a, b) => a.order - b.order);
  for (const d of details) delete d.order;
  return details;
}

const denialReason = (codes) => codes.map((c) => { const w = reasonWords([c])[0]; return `${c}${w.text ? ` ${w.text}` : ''}`; }).join(', ') || 'Denied by payer';

// A paper EOB's denial, applied when a person approves the AI's read: the claim moves to denied as that
// person's change (recorded before/after, audited with the AI read as the source of the reason). Does
// nothing for other rows, or when the claim has already moved on (a second approval is a no-op).
export async function applyPaperDenial(db, req, line) {
  if (line.source !== 'paper' || line.kind !== 'denied' || line.paid !== 0 || !line.claim_id) return false;
  const claim = await db.get('SELECT * FROM claims WHERE id = ? AND practice_id = ?', line.claim_id, line.practice_id);
  if (!claim || !['submitted', 'partially_paid'].includes(claim.status)) return false;
  requireHuman('denying a claim from a paper EOB');
  const reason = denialReason(JSON.parse(line.reason_codes || '[]'));
  const moved = await recorded(db, 'claims', claim.id, () => db.run(
    "UPDATE claims SET status = 'denied', denial_reason = ?, payer_claim_number = COALESCE(?, payer_claim_number) WHERE id = ? AND status IN ('submitted','partially_paid')",
    reason.slice(0, 300), line.payer_claim_number, claim.id,
  ));
  if (!moved.changes) return false;
  const after = await db.get('SELECT status, denial_reason FROM claims WHERE id = ?', claim.id);
  await claimEvent(db, claim, 'eob', 'denied', `Denied: ${reason} (paper EOB read by AI, approved by ${req.user.name || 'staff'})`);
  await audit(db, req, 'eob.paper_denial', 'claims', claim.id, { remit_line: line.id, paper_eob_id: line.paper_eob_id, read_by: 'AI', approved_by: req.user.name || null }, {
    before: { status: claim.status, denial_reason: claim.denial_reason }, after, patientId: claim.patient_id, reason: `Paper EOB read by AI: ${reason}`.slice(0, 500),
  });
  return true;
}

// A problem with the check itself (not one claim): provider-level adjustments (interest, recoupments) or a
// total that doesn't match its claims. The claims still post; this one row asks a person to look.
export async function stageCheckLevel(db, practiceId, { source, trace, payerName, total, paidLines, adjustments = [], eraImportId = null, paperEobId = null, checkId = null }) {
  const plb = sumOf(adjustments, (a) => a.amount);
  const mismatch = total != null && paidLines - plb !== total;
  if (!adjustments.length && !mismatch) return null;
  const parts = [
    ...adjustments.map((a) => `${a.reason || 'Other'}${a.reference ? ` (${a.reference})` : ''} ${money(-a.amount)}`),
    ...(mismatch ? [`the check is ${money(total)} but its claims come to ${money(paidLines - plb)}`] : []),
  ];
  return stageRow(db, {
    practice_id: practiceId, source, era_import_id: eraImportId, paper_eob_id: paperEobId, insurance_check_id: checkId, trace, payer_name: payerName,
    dedupe_key: `${source}:${keyPart(payerName)}:${keyPart(trace)}:CHECK`, line_no: -1, billed: 0, paid: 0, other_adjustments: plb,
    reason_codes: adjustments.map((a) => `PLB-${a.reason}`), state: 'exception', kind: 'review',
    reason: `Check-level: ${parts.join('; ')}. Record it (interest is income; a recoupment is money the payer kept from an earlier claim).`,
  });
}

// Posts one claim's remittance row(s) to the ledger through postClaimPayment. `asPayerSays` (a person's
// decision on an exception) writes off what the payer didn't pay and the patient doesn't owe; the automatic
// path writes off only the contractual amount, which is all there is on a clean row. `final: false` keeps
// the claim open (partial payment).
export async function postGroup(db, lineIds, { userId = null, req = null, method = null, date = null, asPayerSays = false, final = true, automatic = false, claimId = null }) {
  requireHuman('posting insurance payments');
  const lines = [];
  for (const id of lineIds) lines.push(await db.get('SELECT * FROM remit_lines WHERE id = ?', id));
  if (!lines.length || lines.some((l) => !l)) throw new HttpError(404, 'Remittance line not found');
  const pid = lines[0].practice_id;
  const cid = claimId ?? lines[0].claim_id;
  if (!cid) throw new HttpError(409, 'Match this line to a claim first');
  const claim = await db.get('SELECT * FROM claims WHERE id = ? AND practice_id = ?', cid, pid);
  if (!claim) throw new HttpError(404, 'Claim not found');
  if (!['submitted', 'partially_paid', 'denied'].includes(claim.status)) throw new HttpError(409, `Claim #${claim.id} is ${claim.status} — nothing to post it to`);
  const paid = sumOf(lines, (l) => l.paid);
  const pr = sumOf(lines, (l) => l.patient_resp);
  const billed = sumOf(lines, (l) => l.billed);
  if (paid < 0) throw new HttpError(409, 'A negative payment is a reversal — reverse the earlier posting instead');
  const writeOff = asPayerSays ? Math.max(0, billed - paid - pr) : sumOf(lines, (l) => l.contractual);
  const earlierWo = -(await db.get("SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE claim_id = ? AND type = 'adjustment'", claim.id)).n;
  if (claim.paid_amount + earlierWo + paid + writeOff > claim.total_fee) {
    throw new HttpError(409, `Payment plus write-off would be more than the ${money(claim.total_fee)} billed — record a refund to the payer instead`);
  }
  const day = date || (await practiceNow(db, pid)).slice(0, 10);
  const services = lines.flatMap((l) => JSON.parse(l.services || '[]'));
  const check = lines[0].insurance_check_id;
  const payMethod = method || (lines[0].source === 'era' ? 'eft' : (await db.get('SELECT method FROM paper_eobs WHERE id = ?', lines[0].paper_eob_id))?.method || 'check');
  const who = automatic ? 'automation' : 'human';
  const before = { status: claim.status, paid_amount: claim.paid_amount };
  await db.tx(async () => {
    const ids = lines.map((l) => l.id);
    const flipped = await db.run(
      `UPDATE remit_lines SET state = 'posted', posted_at = datetime('now'), posted_by = ?, posted_source = ?, claim_id = ?, patient_id = ?, location_id = COALESCE(location_id, ?)
       WHERE id IN (${ids.map(() => '?').join(',')}) AND state IN ('ready','exception')`, userId, who, claim.id, claim.patient_id, claim.location_id ?? null, ...ids,
    );
    if (flipped.changes !== ids.length) throw new HttpError(409, 'This payment was already posted');
    // (A denied claim the payer now pays is posted like a first payment: its deductible counts.)
    await postClaimPayment(db, { ...claim, status: claim.status === 'denied' ? 'submitted' : claim.status }, {
      amount: paid, writeOff, final, method: payMethod, reference: lines[0].trace || null, userId, date: day, checkId: check,
      payerClaimNumber: lines.find((l) => l.payer_claim_number)?.payer_claim_number ?? null, deductible: sumOf(lines, (l) => l.deductible),
      lines: services.length && !asPayerSays ? services.map((s) => ({ claim_item_id: s.claim_item_id, code: s.code, billed: s.billed, paid: s.paid, patient_resp: s.patient_resp, write_off: s.write_off, adjustments: s.adjustments })) : null,
    });
    await claimEvent(db, claim, lines[0].source === 'era' ? '835' : 'eob', 'paid',
      `Paid ${money(paid)}${writeOff ? `, ${money(writeOff)} written off` : ''}${pr ? `, patient ${money(pr)}` : ''} (${lines[0].source === 'era' ? 'EFT' : 'check'} ${lines[0].trace || '—'})${automatic ? ' — posted by the autopilot' : ''}`);
  });
  const after = await db.get('SELECT status, paid_amount FROM claims WHERE id = ?', claim.id);
  await audit(db, req || jobReq(pid), automatic ? 'eob.autopost' : 'eob.post', 'claims', claim.id, {
    remit_lines: lineIds, paid, write_off: writeOff, patient_resp: pr, trace: lines[0].trace, as_payer_says: asPayerSays || undefined, final,
  }, { before, after, patientId: claim.patient_id, ...(automatic ? { source: 'automation', actor: AUTOPILOT.actor } : {}) });
  publish(pid, { type: 'eob' });
  return after;
}

// ---- A person's decisions on the worklist ----
export async function resolveLine(db, req, line, action, { note = null, claimId = null } = {}) {
  const pid = req.user.practice_id;
  const allowed = [...actionsFor(line), 'dismiss'];
  if (!allowed.includes(action) && !(action === 'post' && line.state === 'ready')) throw new HttpError(400, `“${ACTIONS[action]?.label || action}” isn’t a choice for this line`);
  if (!['exception', 'ready'].includes(line.state)) {
    if (line.resolution === action || (line.state === 'posted' && action === 'post')) return line; // the same key twice
    throw new HttpError(409, `This line was already ${line.state}`);
  }
  const clean = note ? String(note).trim().slice(0, 500) : null;
  const finish = async (resolution, extra = {}) => {
    const { changes } = await recorded(db, 'remit_lines', line.id, () => db.run(
      `UPDATE remit_lines SET state = 'resolved', resolution = ?, resolution_note = ?, resolved_by = ?, resolved_at = datetime('now'), task_id = COALESCE(?, task_id)
       WHERE id = ? AND state IN ('exception','ready')`, resolution, clean, req.user.id, extra.task_id ?? null, line.id,
    ));
    if (!changes) throw new HttpError(409, 'Someone else just dealt with this line');
  };
  const task = (title, notes) => insert(db, 'tasks', {
    practice_id: pid, patient_id: line.patient_id, title: title.slice(0, 200), notes, priority: 'high', due_date: null, created_by: req.user.id,
  });
  // A person acting on a paper EOB's denial (bill the patient, resend, appeal) confirms the AI's read of it:
  // the claim is denied now, as theirs. "Nothing to do" leaves the claim as it was (the read may be wrong).
  if (['bill_patient', 'resend', 'appeal'].includes(action)) await applyPaperDenial(db, req, line);
  const claim = line.claim_id ? await db.get('SELECT * FROM claims WHERE id = ? AND practice_id = ?', line.claim_id, pid) : null;
  switch (action) {
    case 'post': {
      // A part payment keeps the claim open until the payer has answered for everything billed on it.
      let final = true;
      if (line.kind === 'partial' && claim) {
        const answered = Number((await db.get("SELECT COALESCE(SUM(billed), 0) AS n FROM remit_lines WHERE claim_id = ? AND state = 'posted' AND id <> ?", claim.id, line.id)).n);
        final = answered + line.billed >= claim.total_fee;
      }
      await postGroup(db, [line.id], { userId: req.user.id, req, asPayerSays: line.state !== 'ready', final });
      break;
    }
    case 'bill_patient':
      // Money the payer did pay is posted first; what's left is the patient's (the autopilot bills it).
      if (line.paid > 0 || line.contractual > 0) {
        await postGroup(db, [line.id], { userId: req.user.id, req, asPayerSays: true });
        await db.run("UPDATE remit_lines SET resolution = 'bill_patient', resolution_note = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", clean, req.user.id, line.id);
      } else await finish('bill_patient');
      break;
    case 'resend':
    case 'appeal': {
      if (!claim) throw new HttpError(409, 'Match this line to a claim first');
      const t = await task(`${action === 'appeal' ? 'Appeal' : 'Correct and resend'} claim #${claim.id}`, `${line.reason || ''}${clean ? `\n${clean}` : ''}\nOpen the claim: /claims/${claim.id}`);
      await finish(action, { task_id: t });
      break;
    }
    case 'refund': {
      const t = await task(`Refund ${money(line.paid)} to ${line.payer_name || 'the payer'}${claim ? ` (claim #${claim.id})` : ''}`,
        `${line.reason || 'Overpaid'}. Send the refund, or wait for the payer to take it back on a later remittance and reverse it then. Trace ${line.trace || '—'}.`);
      await finish('refund', { task_id: t });
      break;
    }
    case 'match': {
      const target = await db.get('SELECT * FROM claims WHERE id = ? AND practice_id = ?', Number(claimId), pid);
      if (!target) throw new HttpError(404, 'Claim not found');
      const ctx = await claimContext(db, target);
      const verdict = classify({ claim: target, items: ctx.items, lines: [{ status: 'processed_primary', status_code: line.status_code, billed: line.billed, paid: line.paid, patient_resp: line.patient_resp, adjustments: [], services: JSON.parse(line.services || '[]') }], expected: ctx.expected });
      // Re-judged against the claim chosen: clean ones post (a person chose the match), the rest stay for a look.
      await recorded(db, 'remit_lines', line.id, () => db.run(
        'UPDATE remit_lines SET claim_id = ?, patient_id = ?, location_id = ?, kind = ?, reason = ?, state = ? WHERE id = ?',
        target.id, target.patient_id, target.location_id ?? null, verdict.kind, verdict.kind ? verdict.reason : null, verdict.kind ? 'exception' : 'ready', line.id,
      ));
      if (!verdict.kind) await postGroup(db, [line.id], { userId: req.user.id, req });
      break;
    }
    case 'reverse': {
      if (!claim) throw new HttpError(409, 'Match this line to a claim first');
      if (!['paid', 'partially_paid'].includes(claim.status)) throw new HttpError(409, `Claim #${claim.id} is ${claim.status}; there’s no payment to reverse`);
      requireHuman('reversing insurance payments');
      const date = (await practiceNow(db, pid)).slice(0, 10);
      await db.tx(async () => {
        const moved = await recorded(db, 'claims', claim.id, () => db.run("UPDATE claims SET status = 'submitted', paid_amount = 0, paid_at = NULL WHERE id = ? AND status IN ('paid','partially_paid')", claim.id));
        if (!moved.changes) throw new HttpError(409, 'The claim changed — reload and try again');
        const posted = await db.all("SELECT * FROM ledger_entries WHERE claim_id = ? AND type IN ('insurance_payment','adjustment') AND voided_at IS NULL AND reverses_id IS NULL", claim.id);
        for (const e of posted) await reverseEntry(db, e, { userId: req.user.id, reason: `Payer reversal (${line.trace || 'ERA'}): ${line.reason || ''}`.slice(0, 300), date });
        await db.run('UPDATE claim_items SET paid_amount = 0, adjusted_amount = 0 WHERE claim_id = ?', claim.id);
        await finish('reverse');
      });
      await claimEvent(db, claim, '835', 'request', `Payer took back the payment (${line.trace || 'ERA'}) — the claim is open again`);
      break;
    }
    case 'dismiss':
      if (!clean) throw new HttpError(400, 'Say why there’s nothing to do, so the next person knows');
      await finish('dismiss');
      break;
    default:
      throw new HttpError(400, 'Unknown action');
  }
  const after = await db.get('SELECT * FROM remit_lines WHERE id = ?', line.id);
  await audit(db, req, `eob.line.${action}`, 'remit_lines', line.id, { kind: line.kind, claim_id: after.claim_id, note: clean }, { patientId: after.patient_id, reason: clean });
  await settleImportIssue(db, after);
  publish(pid, { type: 'eob' });
  return after;
}

// The Needs attention item for a remittance closes when none of its rows needs a person any more.
export async function settleImportIssue(db, line) {
  const where = line.era_import_id ? ['era_import_id', line.era_import_id, `era:${line.era_import_id}`] : line.paper_eob_id ? ['paper_eob_id', line.paper_eob_id, `eob:${line.paper_eob_id}`] : null;
  if (!where) return;
  const left = await db.get(`SELECT COUNT(*) AS n FROM remit_lines WHERE ${where[0]} = ? AND state = 'exception'`, where[1]);
  if (!Number(left.n)) await resolveIssue(db, line.practice_id, where[2], 'Resolved: every line was posted or decided on the insurance worklist');
}

// Posts every clean row waiting in the practice (or the given ones): the one-click "Post all" while
// auto-posting is off, and the job's pass once it's on. Paper rows are posted only by a person.
// (A paper EOB's clean rows are posted together from the EOB, against its one check: see the paper route.)
export async function postReady(db, practiceId, { lineIds = null, userId = null, req = null, automatic = false } = {}) {
  const rows = await db.all(
    `SELECT id FROM remit_lines WHERE practice_id = ? AND state = 'ready' AND source = 'era'${lineIds ? ` AND id IN (${lineIds.map(() => '?').join(',') || 'NULL'})` : ''} ORDER BY id`,
    practiceId, ...(lineIds || []),
  );
  const out = { posted: 0, failed: [] };
  for (const r of rows) {
    try {
      await (automatic ? withActor(AUTOPILOT, () => postGroup(db, [r.id], { automatic: true })) : postGroup(db, [r.id], { userId, req }));
      out.posted++;
    } catch (err) {
      // Something moved since it was judged clean (someone posted the claim by hand): it becomes an exception.
      await db.run("UPDATE remit_lines SET state = 'exception', kind = 'review', reason = ? WHERE id = ? AND state = 'ready'", `Couldn’t post: ${err.message}`.slice(0, 500), r.id);
      out.failed.push({ id: r.id, error: err.message });
    }
  }
  return out;
}

// ---- The worklist (A3) ----
export async function worklist(db, practiceId, { locationIds = null } = {}) {
  const rows = await db.all(
    `SELECT r.*, p.first_name, p.last_name, c.status AS claim_status, c.total_fee AS claim_fee, c.primary_claim_id
     FROM remit_lines r LEFT JOIN patients p ON p.id = r.patient_id LEFT JOIN claims c ON c.id = r.claim_id
     WHERE r.practice_id = ? AND (r.state = 'exception' OR (r.state = 'ready' AND r.source = 'era')) ORDER BY CASE r.state WHEN 'exception' THEN 0 ELSE 1 END, r.created_at, r.id`, practiceId,
  );
  // Paper EOBs read but not approved yet are posted from the Paper EOB tab.
  const paperWaiting = Number((await db.get("SELECT COUNT(*) AS n FROM paper_eobs WHERE practice_id = ? AND status = 'read'", practiceId)).n);
  const secondaries = await db.all(
    `SELECT c.id, c.patient_id, c.total_fee, c.estimated_amount, c.primary_claim_id, c.location_id, c.created_at, p.first_name, p.last_name, ic.name AS payer_name, pc.paid_date AS primary_paid,
       (SELECT r.paper_eob_id FROM remit_lines r WHERE r.claim_id = c.primary_claim_id AND r.state = 'posted' AND r.paper_eob_id IS NOT NULL ORDER BY r.id DESC LIMIT 1) AS primary_eob_id
     FROM claims c JOIN claims pc ON pc.id = c.primary_claim_id JOIN patients p ON p.id = c.patient_id
     LEFT JOIN patient_insurance pi ON pi.id = c.patient_insurance_id LEFT JOIN insurance_carriers ic ON ic.id = pi.carrier_id
     WHERE c.practice_id = ? AND c.status = 'draft' AND pc.status IN ('paid','partially_paid') ORDER BY pc.paid_date, c.id`, practiceId,
  );
  const visible = (loc) => !locationIds || loc == null || locationIds.includes(loc);
  const items = rows.filter((r) => visible(r.location_id)).map((r) => {
    const kind = r.state === 'ready' ? 'ready' : r.kind || 'review';
    const codes = JSON.parse(r.reason_codes || '[]');
    return {
      key: `line:${r.id}`, id: r.id, kind, kind_label: KINDS[kind], source: r.source, era_import_id: r.era_import_id, paper_eob_id: r.paper_eob_id,
      claim_id: r.claim_id, claim_status: r.claim_status, patient_id: r.patient_id, patient: r.first_name ? `${r.first_name} ${r.last_name}` : null,
      payer: r.payer_name, trace: r.trace, control_number: r.control_number, created_at: r.created_at,
      amounts: { billed: r.billed, paid: r.paid, write_off: r.contractual, other: r.other_adjustments, patient: r.patient_resp, expected_allowed: r.expected_allowed },
      reason: r.state === 'ready' ? 'Reconciles exactly — ready to post' : r.reason, reasons: reasonWords(codes),
      actions: actionsFor({ ...r, kind }).map((a) => ({ action: a, ...ACTIONS[a] })),
    };
  });
  for (const s of secondaries.filter((x) => visible(x.location_id))) {
    items.push({
      key: `secondary:${s.id}`, id: s.id, kind: 'secondary', kind_label: KINDS.secondary, claim_id: s.id, primary_claim_id: s.primary_claim_id, patient_id: s.patient_id,
      patient: `${s.first_name} ${s.last_name}`, payer: s.payer_name, created_at: s.created_at, paper_eob_id: s.primary_eob_id,
      amounts: { billed: s.total_fee, expected: s.estimated_amount },
      reason: `The primary paid${s.primary_paid ? ` on ${s.primary_paid}` : ''}; send the secondary claim${s.primary_eob_id ? ' with the primary’s EOB attached' : ' (the primary’s payment goes with it electronically)'}.`,
      actions: [{ action: 'send_secondary', ...ACTIONS.send_secondary }],
    });
  }
  const counts = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  return { items, counts, paper_waiting: paperWaiting };
}

// ---- The job's ERA pass: clean rows post once auto-posting is on ----
export async function autopostPass(db, practice) {
  if (!settingsOf(practice).autopost) return { posted: 0, failed: [] };
  return postReady(db, practice.id, { automatic: true });
}

// ---- Preview: what auto-posting would have done over the last N days ----
// Each remittance row from the period is judged again as if it had just arrived (the claim as it was before
// it was paid), and compared with what the team actually posted from it. Nothing is changed.
export async function preview(db, practiceId, { days = 30 } = {}) {
  const today = (await practiceNow(db, practiceId)).slice(0, 10);
  const from = new Date(Date.parse(`${today}T12:00:00Z`) - days * 86400_000).toISOString().slice(0, 10);
  const rows = await db.all(
    `SELECT r.*, c.total_fee, c.status AS claim_status FROM remit_lines r LEFT JOIN claims c ON c.id = r.claim_id
     WHERE r.practice_id = ? AND r.source = 'era' AND r.line_no >= 0 AND substr(r.created_at, 1, 10) >= ? ORDER BY r.id`, practiceId, from,
  );
  const out = { days, from, to: today, rows: rows.length, would_post: 0, would_post_amount: 0, exceptions: 0, by_kind: {}, matched_team: 0, differed_from_team: [], examples: [] };
  for (const r of rows) {
    // The row's own verdict was made when it arrived; an exception then is an exception now.
    const clean = r.kind == null || (r.state === 'posted' && r.kind == null);
    if (!clean) {
      out.exceptions++;
      out.by_kind[r.kind] = (out.by_kind[r.kind] || 0) + 1;
      continue;
    }
    out.would_post++;
    out.would_post_amount += r.paid;
    // Where a person posted it, did they post the same money?
    if (r.state === 'posted' && r.posted_source === 'human' && r.claim_id) {
      const posted = await db.get(
        `SELECT COALESCE(-SUM(CASE WHEN type = 'insurance_payment' THEN amount ELSE 0 END), 0) AS paid, COALESCE(-SUM(CASE WHEN type = 'adjustment' THEN amount ELSE 0 END), 0) AS wo
         FROM ledger_entries WHERE claim_id = ? AND voided_at IS NULL AND reverses_id IS NULL`, r.claim_id,
      );
      if (Number(posted.paid) === r.paid && Number(posted.wo) === r.contractual) out.matched_team++;
      else out.differed_from_team.push({ line_id: r.id, claim_id: r.claim_id, autopilot: { paid: r.paid, write_off: r.contractual }, team: { paid: Number(posted.paid), write_off: Number(posted.wo) } });
    }
    if (out.examples.length < 10) out.examples.push({ line_id: r.id, claim_id: r.claim_id, payer: r.payer_name, trace: r.trace, paid: r.paid, write_off: r.contractual, patient: r.patient_resp });
  }
  return out;
}

// Raised once per remittance that has rows for a person, resolved when the last one is dealt with.
export async function raiseImportIssue(db, practiceId, { key, entity, entityId, title, count }) {
  if (!count) return;
  await raiseIssue(db, {
    practiceId, kind: 'era', key, role: 'billing', severity: 'high', entity, entityId,
    title: `${title}: ${count} claim line${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} a person`, detail: 'Open Insurance autopilot (Billing) to post, bill the patient, appeal or match them.',
  });
}
