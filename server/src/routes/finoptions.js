import { Router } from 'express';
import { requirePermission, HttpError, can } from '../auth.js';
import { requireHuman } from '../aiguard.js';
import { insert, change, findOr404, audit, practiceNow, isRealDate, recorded, mapSeq } from '../util.js';
import { estimateCoverage, primaryPolicy, benefitYear, withPlan, checkPostingDate, reverseEntry } from '../services.js';
import { memberSavings, membershipOn } from '../memberships.js';
import { LENDERS, applicationLink } from '../lenders.js';
import { PdfDoc, dataUrlImage } from '../pdf.js';
import { buildOptions, cleanSettings, readSettings, fingerprint, inOffice, monthlyDates, ppoSavings, DEFAULT_SETTINGS } from '../finoptions.js';

// Treatment plans with financial options (backlog F1–F5; spec docs/workflows/specs/F-financial-options.md).
// - Phases: names, plain-words why, visits, month, picture; reorder whole phases. Moving work between phases is
//   PUT /treatment-plans/:tid/order (clinical.js).
// - The quote: the estimate per phase and per benefit year (insurance, write-off, patient share, what's left of
//   the annual maximum) and every financial option side by side, with a fingerprint of exactly those numbers.
// - Accepting an option (patient on the plan link, or staff at the desk): checks the fingerprint so the patient
//   gets what they saw, stores an immutable snapshot, and creates what the option needs — a payment plan, a
//   financing application, a pending prepay discount (posted to the ledger only with the prepayment itself).
// All the arithmetic is in finoptions.js; this file only gathers the inputs and records the outcome.

const PAYMENT_METHODS = ['cash', 'check', 'credit_card', 'debit_card', 'ach', 'care_credit', 'financing', 'other'];

// Plain words for the patient: what a procedure is and why it's done, by category.
const WHY = {
  diagnostic: 'So we can see exactly what’s going on.',
  preventive: 'Keeps your teeth and gums healthy.',
  restorative: 'Repairs decay or damage so the tooth stays strong.',
  endodontics: 'Treats the infected nerve so you can keep the tooth and stop the pain.',
  periodontics: 'Treats gum disease to protect the bone that holds your teeth.',
  prosthodontics: 'Protects or replaces teeth so you can chew comfortably.',
  implants: 'Replaces a missing tooth with a strong, natural-feeling one.',
  oral_surgery: 'Removes a tooth that can’t be saved, to stop pain and infection.',
  orthodontics: 'Straightens your teeth and improves your bite.',
  adjunctive: 'Keeps you comfortable during treatment.',
};
export function plainName(p) {
  const c = String(p.code || '');
  if (/^D295/.test(c)) return 'Buildup';
  if (/^D79[5-6]/.test(c)) return 'Bone graft';
  if (/^D27|^D29[3-4]/.test(c)) return 'Crown';
  if (/^D2[1-3]/.test(c)) return 'Filling';
  if (/^D25|^D26/.test(c)) return 'Inlay / onlay';
  if (/^D3/.test(c)) return 'Root canal';
  if (/^D43[4-5]/.test(c)) return 'Deep cleaning';
  if (/^D4/.test(c)) return 'Gum treatment';
  if (/^D5[1-2]/.test(c)) return 'Denture';
  if (/^D5/.test(c)) return 'Partial denture';
  if (/^D60|^D61/.test(c)) return 'Implant';
  if (/^D6/.test(c)) return 'Bridge';
  if (/^D71|^D72/.test(c)) return 'Tooth removal';
  if (/^D7/.test(c)) return 'Oral surgery';
  if (/^D8/.test(c)) return 'Orthodontics';
  if (/^D0/.test(c)) return 'Exam & x-rays';
  if (/^D1/.test(c)) return 'Cleaning & prevention';
  return p.description;
}

export const phaseList = (v) => {
  if (v == null || v === '') return null;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map(Number);
  if (list.some((n) => !Number.isInteger(n) || n < 1 || n > 9)) throw new HttpError(400, 'phases must be phase numbers 1-9');
  return [...new Set(list)].sort((a, b) => a - b);
};

export async function settingsFor(db, practiceId) {
  return readSettings((await db.get('SELECT fin_options FROM practices WHERE id = ?', practiceId))?.fin_options);
}

// The estimate for a list of planned procedures, phase by phase and benefit year by benefit year: each year's
// work is estimated on its own (as of the first day it's planned in that year), so the annual maximum renews
// when a phase falls after the benefit year does.
async function estimateByYear(db, policy, procs, phaseDate, today) {
  const withP = policy ? await withPlan(db, policy) : null;
  const yearOf = (p) => (withP ? benefitYear(withP, phaseDate(p.phase || 1)).start : 'all');
  const groups = new Map();
  for (const p of procs) {
    const y = yearOf(p);
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(p);
  }
  const items = new Map();
  const years = [];
  for (const [start, list] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = list.map((p) => phaseDate(p.phase || 1)).sort()[0];
    const est = await estimateCoverage(db, policy, list, { asOf: first > today ? first : null });
    for (const it of est.items) items.set(it.procedure_id, { ...it, year: start });
    years.push({
      start: start === 'all' ? null : start, end: withP && start !== 'all' ? benefitYear(withP, start).end : null,
      fee: est.total_fee, insurance: est.total_insurance, patient: est.total_patient,
      annual_max: est.policy?.annual_max ?? null, max_left_after: est.remaining?.annual_max ?? null,
      max_left_before: est.remaining?.annual_max != null ? est.remaining.annual_max + est.total_insurance : null,
      limited: est.items.some((i) => i.notes.some((n) => /annual maximum/.test(n))),
    });
  }
  return { items, years, policy: withP };
}

// Everything the plan screen, the patient page and an acceptance need: phases with their estimate, the
// benefit years, the totals and each financial option, with a fingerprint of the numbers.
export async function planQuote(db, plan, { phases = null, downPayment = null } = {}) {
  const today = (await practiceNow(db, plan.practice_id)).slice(0, 10);
  const procs = await db.all("SELECT pr.*, pc.time_units FROM procedures pr LEFT JOIN procedure_codes pc ON pc.id = pr.code_id WHERE pr.treatment_plan_id = ? AND pr.status = 'planned' ORDER BY pr.phase, pr.priority, pr.id", plan.id);
  const rows = await db.all('SELECT * FROM treatment_plan_phases WHERE treatment_plan_id = ? ORDER BY phase', plan.id);
  const rowOf = new Map(rows.map((r) => [r.phase, r]));
  const phaseDate = (n) => {
    const d = rowOf.get(n)?.when_date;
    return d && d > today ? d : today;
  };
  const numbers = [...new Set([...procs.map((p) => p.phase || 1), ...rows.map((r) => r.phase)])].sort((a, b) => a - b);
  const withWork = [...new Set(procs.map((p) => p.phase || 1))];
  const chosen = phases ? phases.filter((n) => withWork.includes(n)) : withWork;
  if (phases && !chosen.length) throw new HttpError(400, 'Choose at least one phase with work in it');
  const policy = await primaryPolicy(db, plan.practice_id, plan.patient_id);

  // Discounts already on the plan: membership benefits, else the plan discount (as planWithDetails shows them).
  const discountsFor = async (items) => {
    const member = await memberSavings(db, plan.patient_id, items.map((i) => ({ ...i, code: procs.find((p) => p.id === i.procedure_id)?.code })), today);
    return new Map(items.map((i) => [i.procedure_id, member?.items.find((x) => x.procedure_id === i.procedure_id)?.off || (plan.discount_pct ? Math.round((i.patient * plan.discount_pct) / 100) : 0)]));
  };
  const summarize = async (list) => {
    const { items, years, policy: p } = await estimateByYear(db, policy, list, phaseDate, today);
    const discounts = await discountsFor([...items.values()]);
    const line = (pr) => {
      const it = items.get(pr.id);
      const discount = discounts.get(pr.id) || 0;
      return {
        id: pr.id, code: pr.code, description: pr.description, plain: plainName(pr), category: pr.category, tooth: pr.tooth, surfaces: pr.surfaces, area: pr.area,
        fee: pr.fee, allowed: it.allowed, write_off: it.write_off, insurance: it.insurance, patient: it.patient, discount, you_pay: it.patient - discount, notes: it.notes, year: it.year,
      };
    };
    return { lines: list.map(line), years, policy: p };
  };
  const all = await summarize(procs);
  const picked = phases && chosen.length !== withWork.length ? await summarize(procs.filter((p) => chosen.includes(p.phase || 1))) : all;
  const sum = (list, k) => list.reduce((s, x) => s + (x[k] || 0), 0);
  const phaseView = (n, lines) => {
    const row = rowOf.get(n) || {};
    const list = lines.filter((l) => (procs.find((p) => p.id === l.id)?.phase || 1) === n);
    const minutes = procs.filter((p) => (p.phase || 1) === n).reduce((s, p) => s + (p.time_units ? p.time_units * 10 : 30), 0);
    const cats = [...new Set(list.map((l) => l.category))];
    return {
      phase: n, name: row.name || `Phase ${n}`, why: row.why || cats.map((c) => WHY[c]).filter(Boolean)[0] || '', visits: row.visits || Math.max(1, Math.ceil(minutes / 90)),
      when_date: row.when_date || null, document_id: row.document_id || null, count: list.length, lines: list,
      fee: sum(list, 'fee'), write_off: sum(list, 'write_off'), insurance: sum(list, 'insurance'), patient: sum(list, 'patient'), discount: sum(list, 'discount'), you_pay: sum(list, 'you_pay'),
      years: [...new Set(list.map((l) => l.year))].filter((y) => y !== 'all'), selected: chosen.includes(n),
    };
  };
  const lines = picked.lines;
  const amount = sum(lines, 'you_pay');
  const settings = await settingsFor(db, plan.practice_id);
  const practice = await db.get('SELECT financing FROM practices WHERE id = ?', plan.practice_id);
  const lenderLinks = Object.fromEntries(Object.keys(LENDERS).map((k) => [k, applicationLink(practice?.financing, k, amount)]).filter(([, v]) => v));
  const isMember = !!(await membershipOn(db, plan.patient_id, today));
  const patient = await db.get('SELECT dob FROM patients WHERE id = ?', plan.patient_id);
  const age = patient?.dob ? Math.floor((Date.parse(today) - Date.parse(patient.dob)) / (365.25 * 86400_000)) : null;
  const membershipPlans = (await db.all('SELECT * FROM membership_plans WHERE practice_id = ? AND active = 1 ORDER BY price', plan.practice_id))
    .filter((m) => age == null || ((m.min_age == null || age >= m.min_age) && (m.max_age == null || age <= m.max_age)));
  let options = buildOptions({
    amount, items: lines.map((l) => ({ code: l.code, patient: l.you_pay })), settings, insured: !!policy, otherDiscountPct: plan.discount_pct || 0, lenderLinks, membershipPlans, isMember,
  });
  // Staff can ask for a bigger down payment on the office plan (never below the minimum).
  if (downPayment != null) options = options.map((o) => (o.kind === 'in_office' ? inOffice(amount, settings, o.months, { downPayment }) : o));
  const totals = { fee: sum(lines, 'fee'), write_off: sum(lines, 'write_off'), insurance: sum(lines, 'insurance'), patient: sum(lines, 'patient'), discount: sum(lines, 'discount'), you_pay: amount };
  const ppo = settings.show.ppo_savings ? ppoSavings({ policy, total_write_off: totals.write_off }) : 0;
  const numbersShown = {
    plan_id: plan.id, phases: chosen, amount, totals, ppo_savings: ppo, options,
    lines: lines.map((l) => [l.id, l.code, l.tooth || '', l.fee, l.allowed, l.insurance, l.patient, l.discount, l.year]),
  };
  return {
    plan_id: plan.id, today, phases: numbers.map((n) => phaseView(n, chosen.includes(n) ? picked.lines : all.lines)), chosen, years: picked.years, all_years: all.years,
    policy: policy ? { id: policy.id, carrier_name: policy.carrier_name, annual_max: all.policy?.annual_max ?? policy.annual_max, fee_schedule_id: all.policy?.fee_schedule_id ?? null, renews: all.policy ? benefitYear(all.policy, today).end : null } : null,
    totals, all_totals: { fee: sum(all.lines, 'fee'), insurance: sum(all.lines, 'insurance'), write_off: sum(all.lines, 'write_off'), you_pay: sum(all.lines, 'you_pay') },
    ppo_savings: ppo, amount, options, teeth: [...new Set(procs.filter((p) => chosen.includes(p.phase || 1)).map((p) => p.tooth).filter(Boolean))],
    all_teeth: [...new Set(procs.map((p) => p.tooth).filter(Boolean))],
    settings_hash: fingerprint(settings), quote_hash: fingerprint({ ...numbersShown, settings }), settings,
  };
}

// The same, for the patient's screen: nothing internal (fee schedule ids, settings), plain words first.
export function publicQuote(q) {
  const strip = (l) => ({ plain: l.plain, description: l.description, code: l.code, tooth: l.tooth, surfaces: l.surfaces, area: l.area, fee: l.fee, insurance: l.insurance, write_off: l.write_off, you_pay: l.you_pay });
  return {
    phases: q.phases.filter((p) => p.count).map((p) => ({ ...p, lines: p.lines.map(strip), has_image: !!p.document_id, document_id: undefined })),
    chosen: q.chosen, totals: q.totals, all_totals: q.all_totals, ppo_savings: q.ppo_savings, amount: q.amount, teeth: q.teeth, all_teeth: q.all_teeth,
    years: q.years.map((y) => ({ start: y.start, insurance: y.insurance, patient: y.patient, limited: y.limited })),
    policy: q.policy ? { carrier_name: q.policy.carrier_name } : null,
    options: q.options.map(({ payments: _p, ...o }) => o), quote_hash: q.quote_hash,
  };
}

// Other options for the same work (Option A / B): what each would cost, side by side.
export async function alternativesOf(db, plan) {
  if (!plan.option_group) return [];
  const sibs = await db.all("SELECT * FROM treatment_plans WHERE practice_id = ? AND patient_id = ? AND option_group = ? AND status IN ('proposed','accepted') ORDER BY option_label, id", plan.practice_id, plan.patient_id, plan.option_group);
  return mapSeq(sibs, async (s) => {
    const q = await planQuote(db, s);
    return {
      id: s.id, label: s.option_label || s.name, name: s.name, current: s.id === plan.id, signed: !!s.signed_at,
      procedures: q.phases.flatMap((p) => p.lines.map((l) => ({ plain: l.plain, description: l.description, tooth: l.tooth }))),
      fee: q.all_totals.fee, insurance: q.all_totals.insurance, you_pay: q.all_totals.you_pay, visits: q.phases.reduce((n, p) => n + (p.count ? p.visits : 0), 0),
      from_monthly: Math.min(...q.options.filter((o) => o.monthly).map((o) => o.monthly), Infinity),
    };
  }).then((list) => list.map((a) => ({ ...a, from_monthly: Number.isFinite(a.from_monthly) ? a.from_monthly : null })));
}

// ---- Accepting an option ----
const samePhases = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Records the patient's choice. Caller runs it inside the transaction that signs the plan (patient) or on its
// own (desk). Idempotent: the same choice again returns the same agreement; a different one is refused while
// one is live. `quote` must be the fresh planQuote; `hash` what the person was shown.
export async function acceptChoice(db, { plan, quote, optionKey, hash, source, userId = null, signature = null, autopayMethodId = null, today }) {
  requireHuman('accepting a financial option (payment plans, discounts, financing)');
  if (!hash || hash !== quote.quote_hash) throw new HttpError(409, 'The numbers have changed since this was shown — please look them over again', { changed: true });
  const option = quote.options.find((o) => o.key === optionKey);
  if (!option) throw new HttpError(400, 'Choose one of the options shown');
  const phases = quote.chosen;
  const live = `tp:${plan.id}`;
  const existing = await db.get('SELECT * FROM fin_agreements WHERE live_key = ?', live);
  if (existing) {
    if (existing.option_key === optionKey && samePhases(JSON.parse(existing.phases), phases)) return { agreement: existing, replay: true };
    throw new HttpError(409, 'An option is already accepted for this plan — cancel it first to choose another');
  }
  const patient = await db.get('SELECT * FROM patients WHERE id = ?', plan.patient_id);
  const planRow = await db.get('SELECT id, name, option_label, status FROM treatment_plans WHERE id = ?', plan.id);
  const snapshot = {
    version: 1, taken_at: new Date().toISOString(), today, source,
    plan: { id: planRow.id, name: planRow.name, option_label: planRow.option_label },
    patient: { id: patient.id, name: `${patient.first_name} ${patient.last_name}` },
    phases: quote.phases.filter((p) => phases.includes(p.phase)).map((p) => ({ phase: p.phase, name: p.name, why: p.why, visits: p.visits, when_date: p.when_date, lines: p.lines, fee: p.fee, insurance: p.insurance, write_off: p.write_off, you_pay: p.you_pay })),
    estimate: { policy: quote.policy, years: quote.years, totals: quote.totals, estimate_version: fingerprint(quote.phases.flatMap((p) => p.lines.map((l) => [l.id, l.fee, l.allowed, l.insurance, l.patient]))) },
    amount: quote.amount, ppo_savings: quote.ppo_savings, options: quote.options, chosen: option,
    settings: quote.settings, settings_hash: quote.settings_hash, quote_hash: quote.quote_hash,
  };
  const snapshotText = JSON.stringify(snapshot);
  return db.tx(async () => {
    let id;
    try {
      id = await db.savepoint(() => insert(db, 'fin_agreements', {
        practice_id: plan.practice_id, patient_id: plan.patient_id, treatment_plan_id: plan.id, phases: JSON.stringify(phases), option_key: option.key, kind: option.kind,
        total: option.total, due_today: option.due_today, monthly: option.monthly ?? null, months: option.months ?? null,
        discount_amount: option.discount || 0, discount_status: option.discount ? 'pending' : 'none',
        snapshot: snapshotText, snapshot_hash: fingerprint(snapshot), quote_hash: quote.quote_hash, live_key: live,
        signature_name: signature?.name || null, signature_image: signature?.image || null, source, accepted_by: userId,
      }));
    } catch (err) {
      if (!/unique|duplicate/i.test(String(err.message)) && err.code !== '23505') throw err;
      const other = await db.get('SELECT * FROM fin_agreements WHERE live_key = ?', live);
      if (other && other.option_key === optionKey && samePhases(JSON.parse(other.phases), phases)) return { agreement: other, replay: true };
      throw new HttpError(409, 'An option is already accepted for this plan — cancel it first to choose another');
    }
    const links = {};
    const guarantor = patient.guarantor_id || patient.id;
    const label = `${planRow.name}${planRow.option_label ? ` (${planRow.option_label})` : ''}`;
    if (option.kind === 'in_office') {
      const first = new Date(Date.parse(`${today}T12:00:00Z`) + quote.settings.in_office.first_payment_days * 86400_000).toISOString().slice(0, 10);
      const dates = monthlyDates(first, option.months);
      const card = autopayMethodId ? await db.get('SELECT id FROM payment_methods WHERE id = ? AND practice_id = ? AND patient_id = ? AND removed_at IS NULL', Number(autopayMethodId), plan.practice_id, guarantor) : null;
      if (autopayMethodId && !card) throw new HttpError(400, "That card isn't on file for this account");
      links.payment_plan_id = await insert(db, 'payment_plans', {
        practice_id: plan.practice_id, patient_id: guarantor, total: option.total, down_payment: option.down_payment, installment_amount: option.monthly, installments: option.months,
        frequency: 'monthly', start_date: dates[0], schedule: JSON.stringify(option.payments.map((amount, i) => ({ due_date: dates[i], amount }))),
        notes: `${label} — treatment agreement #${id}`, created_by: userId, autopay_method_id: card?.id ?? null,
      });
      // Interest or a set-up fee is part of what the patient agreed to owe: on the ledger now, reversed if cancelled.
      if (option.finance_charge > 0) {
        links.finance_charge_entry_id = await insert(db, 'ledger_entries', {
          practice_id: plan.practice_id, patient_id: guarantor, type: 'adjustment', adjustment_type: 'Payment plan finance charge', amount: option.finance_charge,
          description: `Payment plan finance charge — ${label} (${option.apr}% APR${option.setup_fee ? `, $${(option.setup_fee / 100).toFixed(2)} set-up` : ''})`,
          payment_plan_id: links.payment_plan_id, reference: `FA-${id}`, entry_date: today, created_by: userId,
        });
      }
    } else if (option.kind === 'lender') {
      links.financing_application_id = await insert(db, 'financing_applications', {
        practice_id: plan.practice_id, patient_id: plan.patient_id, lender: option.lender, amount: option.amount, status: 'sent', link: option.apply_url,
        plan: option.title, treatment_plan_id: plan.id, created_by: userId,
      });
    }
    // The next steps a person does: the first visit and the consent (booked and sent from the plan in one key each).
    const first = quote.phases.find((p) => phases.includes(p.phase));
    links.task_id = await insert(db, 'tasks', {
      practice_id: plan.practice_id, patient_id: plan.patient_id, priority: 'high', due_date: today, created_by: userId,
      title: `${patient.first_name} ${patient.last_name} accepted ${label}: book ${first?.name || 'the first visit'} and send the consent`,
      notes: `${option.title}${option.kind === 'membership' ? ' — enroll them in the membership (card on file)' : ''}${option.kind === 'lender' ? ` — financing application sent (${LENDERS[option.lender]?.name || option.lender})` : ''}`,
    });
    await db.run(
      'UPDATE fin_agreements SET payment_plan_id = ?, financing_application_id = ?, finance_charge_entry_id = ?, task_id = ? WHERE id = ?',
      links.payment_plan_id ?? null, links.financing_application_id ?? null, links.finance_charge_entry_id ?? null, links.task_id, id,
    );
    if (planRow.status === 'proposed') await recorded(db, 'treatment_plans', plan.id, () => db.run("UPDATE treatment_plans SET status = 'accepted', accepted_at = COALESCE(accepted_at, datetime('now')) WHERE id = ? AND status = 'proposed'", plan.id));
    return { agreement: await db.get('SELECT * FROM fin_agreements WHERE id = ?', id), replay: false };
  });
}

export const agreementView = (a) => {
  if (!a) return null;
  const snap = JSON.parse(a.snapshot);
  return {
    ...a, snapshot: undefined, signature_image: undefined, live_key: undefined, phases: JSON.parse(a.phases), chosen: snap.chosen, plan: snap.plan,
    intact: fingerprint(snap) === a.snapshot_hash, ppo_savings: snap.ppo_savings,
  };
};

// The agreement as printed: only from the stored snapshot, never from today's numbers.
export function agreementPdf(a, practice) {
  const s = JSON.parse(a.snapshot);
  const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const doc = new PdfDoc({ footer: `${practice.name} · treatment and payment agreement #${a.id} · ${a.snapshot_hash.slice(0, 16)}` });
  doc.text(practice.name, { size: 15, bold: true, gap: 1 });
  doc.text([practice.address, practice.city, practice.state, practice.zip].filter(Boolean).join(', '), { size: 9.5 });
  doc.space(8);
  doc.text(`Treatment and payment agreement — ${s.plan.name}${s.plan.option_label ? ` (${s.plan.option_label})` : ''}`, { size: 13, bold: true });
  doc.text(`${s.patient.name} · accepted ${a.created_at} UTC${a.status === 'cancelled' ? ` · CANCELLED ${a.cancelled_at}: ${a.cancel_reason}` : ''}`, { size: 10 });
  doc.space(6);
  const at = [0, 0.1, 0.52, 0.66, 0.8, 0.9];
  for (const ph of s.phases) {
    doc.text(`${ph.name} — ${ph.visits} visit${ph.visits === 1 ? '' : 's'}`, { size: 11, bold: true });
    doc.row(['Code', 'Treatment', 'Fee', 'Insurance', 'You pay'], { at: [0, 0.1, 0.62, 0.76, 0.88], right: [2, 3, 4], bold: true, size: 9 });
    for (const l of ph.lines) doc.row([l.code, `${l.plain}${l.tooth ? ` #${l.tooth}` : ''} — ${l.description}`.slice(0, 70), money(l.fee), money(l.insurance), money(l.you_pay)], { at: [0, 0.1, 0.62, 0.76, 0.88], right: [2, 3, 4], size: 9 });
    doc.space(4);
  }
  doc.rule();
  const t = s.estimate.totals;
  doc.row(['', 'Total', money(t.fee), '', '', ''], { at, right: [2], bold: true, size: 10 });
  if (t.write_off) doc.row(['', 'In-network savings', money(-t.write_off), '', '', ''], { at, right: [2], size: 10 });
  if (t.insurance) doc.row(['', `Estimated insurance${s.estimate.policy ? ` (${s.estimate.policy.carrier_name})` : ''}`, money(-t.insurance), '', '', ''], { at, right: [2], size: 10 });
  if (t.discount) doc.row(['', 'Plan discount', money(-t.discount), '', '', ''], { at, right: [2], size: 10 });
  doc.row(['', 'Your estimated share', money(s.amount), '', '', ''], { at, right: [2], bold: true, size: 10 });
  doc.space(8);
  const c = s.chosen;
  doc.text(`Chosen: ${c.title}`, { size: 12, bold: true });
  doc.text(`Total ${money(c.total)} · due today ${money(c.due_today)}${c.monthly ? ` · ${c.months} monthly payments of ${money(c.monthly)}${c.last_payment && c.last_payment !== c.monthly ? ` (last ${money(c.last_payment)})` : ''}` : ''}`, { size: 10.5 });
  if (c.discount) doc.text(`Includes a ${c.discount_pct}% prepay discount of ${money(c.discount)}, applied when the prepayment is received.`, { size: 9.5 });
  if (c.kind === 'in_office') doc.text(`Down payment ${money(c.down_payment)}; ${c.apr}% APR${c.finance_charge ? `; finance charge ${money(c.finance_charge)}` : ' — no interest'}.`, { size: 9.5 });
  for (const n of c.notes || []) doc.text(n, { size: 9.5 });
  if (s.ppo_savings) doc.text(`Your in-network savings: ${money(s.ppo_savings)}`, { size: 9.5 });
  doc.space(6);
  doc.text('Insurance amounts are estimates, not a guarantee of payment; you are responsible for any amount your insurance does not pay. Financing is subject to the lender’s approval and terms.', { size: 8.5, color: [0.35, 0.38, 0.45] });
  doc.space(10);
  const img = a.signature_image ? dataUrlImage(a.signature_image) : null;
  if (img) doc.image(img, { maxW: 200, maxH: 60, border: true });
  doc.text(a.signature_name ? `Signed electronically by ${a.signature_name}` : `Accepted at the office (${a.source === 'human' ? 'recorded by staff' : a.source})`, { size: 9.5, bold: true });
  doc.text(`Numbers fingerprint ${s.quote_hash.slice(0, 24)} · snapshot ${a.snapshot_hash.slice(0, 24)}`, { size: 7.5, color: [0.5, 0.5, 0.5] });
  return doc.toBuffer();
}

const cleanPhase = async (db, req, plan, body) => {
  const row = {};
  if (body.name !== undefined) row.name = String(body.name || '').trim().slice(0, 60) || null;
  if (body.why !== undefined) row.why = String(body.why || '').trim().slice(0, 300) || null;
  if (body.visits !== undefined) {
    const n = body.visits === null || body.visits === '' ? null : Number(body.visits);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 20)) throw new HttpError(400, 'visits must be 1-20');
    row.visits = n;
  }
  if (body.when_date !== undefined) {
    if (body.when_date && !isRealDate(body.when_date)) throw new HttpError(400, 'when_date must be a real date (YYYY-MM-DD)');
    row.when_date = body.when_date || null;
  }
  if (body.document_id !== undefined) {
    if (body.document_id) {
      const d = await findOr404(db, 'documents', body.document_id, req.user.practice_id, 'Picture');
      if (d.patient_id !== plan.patient_id || d.deleted_at || !['xray', 'photo'].includes(d.category)) throw new HttpError(400, 'Choose an x-ray or photo from this patient’s chart');
      row.document_id = d.id;
    } else row.document_id = null;
  }
  return row;
};

// Staff routes (mounted by casepres.js inside the signed-in API).
export default function finOptionRoutes({ db }) {
  const r = Router();
  const planOr404 = (req) => findOr404(db, 'treatment_plans', req.params.tid, req.user.practice_id, 'Treatment plan');
  const editable = async (req) => {
    const plan = await planOr404(req);
    if (['completed', 'rejected'].includes(plan.status)) throw new HttpError(409, `This plan is ${plan.status}`);
    return plan;
  };
  const requireAdmin = (req) => { if (req.user.role !== 'admin') throw new HttpError(403, 'Only an administrator can change financial option settings'); };

  r.get('/fin-options/settings', requirePermission('billing:read'), async (req, res) => {
    res.json({ settings: await settingsFor(db, req.user.practice_id), defaults: DEFAULT_SETTINGS, lenders: Object.fromEntries(Object.entries(LENDERS).map(([k, l]) => [k, l.name])) });
  });
  r.put('/fin-options/settings', async (req, res) => {
    requireAdmin(req);
    requireHuman('changing discount and financing rules');
    const before = await settingsFor(db, req.user.practice_id);
    const settings = cleanSettings(req.body?.settings ?? req.body);
    await recorded(db, 'practices', req.user.practice_id, () => db.run('UPDATE practices SET fin_options = ? WHERE id = ?', JSON.stringify(settings), req.user.practice_id));
    await audit(db, req, 'fin_options.settings', 'practices', req.user.practice_id, { reason: req.body?.reason || null }, { before: { settings: JSON.stringify(before) }, after: { settings: JSON.stringify(settings) } });
    res.json({ settings });
  });

  // Name, why, visits, month and picture of one phase.
  r.put('/treatment-plans/:tid/phases/:phase', requirePermission('clinical:write'), async (req, res) => {
    const plan = await editable(req);
    const phase = Number(req.params.phase);
    if (!Number.isInteger(phase) || phase < 1 || phase > 9) throw new HttpError(400, 'phase must be 1-9');
    const row = await cleanPhase(db, req, plan, req.body || {});
    const had = await db.get('SELECT * FROM treatment_plan_phases WHERE treatment_plan_id = ? AND phase = ?', plan.id, phase);
    if (had) await change(db, 'treatment_plan_phases', had.id, { ...row, updated_by: req.user.id, updated_at: new Date().toISOString() });
    else await insert(db, 'treatment_plan_phases', { practice_id: plan.practice_id, treatment_plan_id: plan.id, phase, ...row, updated_by: req.user.id });
    await audit(db, req, 'treatment_plan.phase', 'treatment_plans', plan.id, { phase, ...row, patient_id: plan.patient_id }, had ? { before: Object.fromEntries(Object.keys(row).map((k) => [k, had[k]])), after: row } : {});
    res.json(await planQuote(db, plan));
  });

  // Put whole phases in a new order: order = the current phase numbers in their new order (they become 1, 2, 3…).
  r.put('/treatment-plans/:tid/phase-order', requirePermission('clinical:write'), async (req, res) => {
    const plan = await editable(req);
    const order = phaseList(req.body?.order);
    const inUse = [...new Set([...(await db.all("SELECT DISTINCT phase FROM procedures WHERE treatment_plan_id = ? AND status != 'cancelled'", plan.id)).map((p) => p.phase || 1),
      ...(await db.all('SELECT phase FROM treatment_plan_phases WHERE treatment_plan_id = ?', plan.id)).map((p) => p.phase)])].sort((a, b) => a - b);
    const given = Array.isArray(req.body?.order) ? req.body.order.map(Number) : [];
    if (!order || given.length !== inUse.length || !samePhases([...order], inUse)) throw new HttpError(400, `order must list each phase once: ${inUse.join(', ')}`);
    const to = new Map(given.map((from, i) => [from, i + 1]));
    await db.tx(async () => {
      // Through negative numbers first, so no two phases share a number mid-way.
      await db.run('UPDATE treatment_plan_phases SET phase = -phase WHERE treatment_plan_id = ?', plan.id);
      for (const [from, n] of to) {
        await db.run('UPDATE treatment_plan_phases SET phase = ? WHERE treatment_plan_id = ? AND phase = ?', n, plan.id, -from);
        for (const p of await db.all("SELECT id FROM procedures WHERE treatment_plan_id = ? AND COALESCE(phase, 1) = ? AND status != 'cancelled'", plan.id, from)) {
          await recorded(db, 'procedures', p.id, () => db.run('UPDATE procedures SET phase = ? WHERE id = ?', -n, p.id));
        }
      }
      await db.run('UPDATE procedures SET phase = -phase WHERE treatment_plan_id = ? AND phase < 0', plan.id);
    });
    await audit(db, req, 'treatment_plan.phase_order', 'treatment_plans', plan.id, { order: given, patient_id: plan.patient_id });
    res.json(await planQuote(db, plan));
  });

  // The live estimate per phase and year, and the financial options (for all phases, or ?phases=1,2).
  r.get('/treatment-plans/:tid/quote', requirePermission('clinical:read'), async (req, res) => {
    const plan = await planOr404(req);
    const down = req.query.down_payment ? Number(req.query.down_payment) : null;
    const q = await planQuote(db, plan, { phases: phaseList(req.query.phases), downPayment: down });
    const live = await db.get('SELECT * FROM fin_agreements WHERE live_key = ?', `tp:${plan.id}`);
    res.json({ ...q, settings: undefined, agreement: agreementView(live), alternatives: await alternativesOf(db, plan) });
  });

  // Desk: record the patient's choice (they agreed in person or on the phone). Same checks as the patient's page.
  r.post('/treatment-plans/:tid/fin-accept', requirePermission('billing:write'), async (req, res) => {
    const plan = await editable(req);
    const b = req.body || {};
    const quote = await planQuote(db, plan, { phases: phaseList(b.phases), downPayment: b.down_payment != null ? Number(b.down_payment) : null });
    const today = (await practiceNow(db, plan.practice_id)).slice(0, 10);
    const name = b.signature_name ? String(b.signature_name).trim().slice(0, 120) : null;
    const { agreement, replay } = await acceptChoice(db, {
      plan, quote, optionKey: String(b.option_key || ''), hash: b.quote_hash, source: 'human', userId: req.user.id, signature: name ? { name } : null, autopayMethodId: b.autopay_method_id || null, today,
    });
    if (!replay) await audit(db, req, 'fin_agreement.accept', 'fin_agreements', agreement.id, { patient_id: plan.patient_id, treatment_plan_id: plan.id, option: agreement.option_key, total: agreement.total, due_today: agreement.due_today, monthly: agreement.monthly, phases: JSON.parse(agreement.phases) });
    res.status(replay ? 200 : 201).json(agreementView(agreement));
  });

  r.get('/patients/:id/fin-agreements', requirePermission('billing:read'), async (req, res) => {
    const p = await findOr404(db, 'patients', req.params.id, req.user.practice_id, 'Patient');
    res.json((await db.all('SELECT * FROM fin_agreements WHERE practice_id = ? AND patient_id = ? ORDER BY id DESC', req.user.practice_id, p.id)).map(agreementView));
  });
  r.get('/fin-agreements/:id', requirePermission('billing:read'), async (req, res) => {
    const a = await findOr404(db, 'fin_agreements', req.params.id, req.user.practice_id, 'Agreement');
    res.json({ ...agreementView(a), snapshot: JSON.parse(a.snapshot) });
  });
  r.get('/fin-agreements/:id/pdf', requirePermission('billing:read'), async (req, res) => {
    const a = await findOr404(db, 'fin_agreements', req.params.id, req.user.practice_id, 'Agreement');
    const practice = await db.get('SELECT name, address, city, state, zip FROM practices WHERE id = ?', req.user.practice_id);
    await audit(db, req, 'fin_agreement.print', 'fin_agreements', a.id, { patient_id: a.patient_id });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Agreement ${a.id}.pdf"` }).send(agreementPdf(a, practice));
  });

  // The prepayment is in: post it and, with it, the prepay discount (never before the money arrives).
  r.post('/fin-agreements/:id/prepay', requirePermission('billing:write'), async (req, res) => {
    requireHuman('posting a prepayment and its discount');
    const a = await findOr404(db, 'fin_agreements', req.params.id, req.user.practice_id, 'Agreement');
    const method = String(req.body?.method || '');
    if (!PAYMENT_METHODS.includes(method)) throw new HttpError(400, `method must be one of: ${PAYMENT_METHODS.join(', ')}`);
    if (a.status !== 'accepted') throw new HttpError(409, `This agreement is ${a.status}`);
    if (a.discount_status === 'posted') return res.json(agreementView(a)); // already posted (a repeat)
    if (a.discount_status !== 'pending') throw new HttpError(409, 'There is no prepay discount waiting on this agreement');
    const date = await checkPostingDate(db, req.user.practice_id, req.body?.entry_date);
    const pct = JSON.parse(a.snapshot).chosen.discount_pct;
    const plan = await db.get('SELECT name FROM treatment_plans WHERE id = ?', a.treatment_plan_id);
    const done = await db.tx(async () => {
      const took = await db.run("UPDATE fin_agreements SET discount_status = 'posting' WHERE id = ? AND discount_status = 'pending'", a.id);
      if (!took.changes) return false;
      const payment = await insert(db, 'ledger_entries', {
        practice_id: a.practice_id, location_id: req.location_id ?? null, patient_id: a.patient_id, type: 'payment', amount: -a.due_today, method,
        reference: req.body?.reference ? String(req.body.reference).slice(0, 50) : `FA-${a.id}`, description: `Prepayment in full — ${plan.name} (agreement #${a.id})`, entry_date: date, created_by: req.user.id,
      });
      const discount = await insert(db, 'ledger_entries', {
        practice_id: a.practice_id, location_id: req.location_id ?? null, patient_id: a.patient_id, type: 'adjustment', adjustment_type: 'Prepayment discount', amount: -a.discount_amount,
        reference: `FA-${a.id}`, description: `${pct}% prepay discount — ${plan.name} (agreement #${a.id})`, entry_date: date, created_by: req.user.id,
      });
      await recorded(db, 'fin_agreements', a.id, () => db.run("UPDATE fin_agreements SET discount_status = 'posted', prepay_entry_id = ?, discount_entry_id = ? WHERE id = ?", payment, discount, a.id));
      return true;
    });
    const fresh = await db.get('SELECT * FROM fin_agreements WHERE id = ?', a.id);
    if (done) await audit(db, req, 'fin_agreement.prepay', 'fin_agreements', a.id, { patient_id: a.patient_id, paid: a.due_today, discount: a.discount_amount, payment_id: fresh.prepay_entry_id, discount_id: fresh.discount_entry_id });
    res.status(done ? 201 : 200).json(agreementView(fresh));
  });

  // Take the prepay discount back (the work wasn't done, or the prepayment was refunded): a reversing entry.
  r.post('/fin-agreements/:id/reverse-discount', async (req, res) => {
    if (!can(req.user, 'deposits:manage')) throw new HttpError(403, 'Reversing a discount needs a manager (deposits:manage) or an administrator');
    const a = await findOr404(db, 'fin_agreements', req.params.id, req.user.practice_id, 'Agreement');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new HttpError(400, 'Give a reason');
    if (a.discount_status !== 'posted' || !a.discount_entry_id) throw new HttpError(409, 'There is no posted prepay discount to reverse');
    const entry = await db.get('SELECT * FROM ledger_entries WHERE id = ?', a.discount_entry_id);
    const date = (await practiceNow(db, a.practice_id)).slice(0, 10);
    const reversal = await db.tx(async () => {
      const out = await reverseEntry(db, entry, { userId: req.user.id, reason: reason.slice(0, 300), date });
      await recorded(db, 'fin_agreements', a.id, () => db.run("UPDATE fin_agreements SET discount_status = 'reversed' WHERE id = ?", a.id));
      return out;
    });
    await audit(db, req, 'fin_agreement.reverse_discount', 'fin_agreements', a.id, { patient_id: a.patient_id, reversal_id: reversal, amount: a.discount_amount }, { reason });
    res.json(agreementView(await db.get('SELECT * FROM fin_agreements WHERE id = ?', a.id)));
  });

  // Cancel an agreement (the patient changed their mind): the plan's option can be chosen again. A posted
  // prepay discount must be reversed first; a finance charge is reversed; an unused payment plan and an
  // unanswered financing application are closed. Money already paid stays paid (refund it if asked).
  r.post('/fin-agreements/:id/cancel', requirePermission('billing:write'), async (req, res) => {
    requireHuman('cancelling a payment agreement');
    const a = await findOr404(db, 'fin_agreements', req.params.id, req.user.practice_id, 'Agreement');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new HttpError(400, 'Give a reason');
    if (a.status !== 'accepted') throw new HttpError(409, `This agreement is ${a.status}`);
    if (a.discount_status === 'posted') throw new HttpError(409, 'Reverse the prepay discount first (it was posted with the prepayment)');
    const date = (await practiceNow(db, a.practice_id)).slice(0, 10);
    const left = [];
    await db.tx(async () => {
      await recorded(db, 'fin_agreements', a.id, () => db.run(
        "UPDATE fin_agreements SET status = 'cancelled', live_key = NULL, cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ?, discount_status = CASE WHEN discount_status = 'pending' THEN 'void' ELSE discount_status END WHERE id = ?",
        req.user.id, reason.slice(0, 300), a.id,
      ));
      if (a.finance_charge_entry_id) {
        const e = await db.get('SELECT * FROM ledger_entries WHERE id = ? AND voided_at IS NULL', a.finance_charge_entry_id);
        if (e) await reverseEntry(db, e, { userId: req.user.id, reason: `Agreement cancelled: ${reason}`.slice(0, 300), date });
      }
      if (a.payment_plan_id) {
        const paid = await db.get('SELECT COUNT(*) AS n FROM ledger_entries WHERE payment_plan_id = ? AND type = ? AND voided_at IS NULL', a.payment_plan_id, 'payment');
        if (!Number(paid.n)) await recorded(db, 'payment_plans', a.payment_plan_id, () => db.run("UPDATE payment_plans SET status = 'cancelled' WHERE id = ? AND status = 'active'", a.payment_plan_id));
        else left.push('The payment plan already has payments, so it stays open — close it from the Ledger when settled.');
      }
      if (a.financing_application_id) {
        const f = await db.get('SELECT status FROM financing_applications WHERE id = ?', a.financing_application_id);
        if (['sent', 'started'].includes(f?.status)) await recorded(db, 'financing_applications', a.financing_application_id, () => db.run("UPDATE financing_applications SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", a.financing_application_id));
        else if (f) left.push(`The financing application is ${f.status} with the lender — tell them too.`);
      }
    });
    await audit(db, req, 'fin_agreement.cancel', 'fin_agreements', a.id, { patient_id: a.patient_id }, { reason });
    res.json({ ...agreementView(await db.get('SELECT * FROM fin_agreements WHERE id = ?', a.id)), left });
  });

  return r;
}
