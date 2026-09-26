// Today's schedule optimizer (OPT1–OPT4, docs/workflows/specs/OPT-optimizer.md): "what has to happen today for each
// provider to reach their goal?" A deterministic engine finds and prices every opportunity on the day; AI (optional,
// labelled, ai/optimizerExplain.js) only explains and ranks what the engine found. Nothing is booked, moved or texted
// here: each opportunity carries the action a person can take with one click (routes/optimizer.js runs it through the
// existing endpoints — the same validation, permissions, audit and live updates as doing it by hand).
//
//   OPT1  goalGaps       per provider: scheduled vs goal (the numbers production.js gives the schedule), open time,
//                        perfect-day blocks still open.
//   OPT2  generators     each returns opportunities { key, kind, patient, provider, slot/visit, fee (office fee),
//                        collectible (fee less the PPO write-off), minutes, fits / why_not, action }:
//                        treatment   planned treatment of a patient on today's schedule: in their visit (if the visit has
//                                    the time), by stretching the visit into the gap after it, or as a visit of its own
//                                    right before/after with the right kind of provider;
//                        finder      opportunity-finder items (sealants, fluoride, x-rays…) for today's visits;
//                        family      household members due for recall or with open treatment, back to back with (or
//                                    beside) the family member already coming;
//                        fill        ASAP-list, waitlist and recall-due patients who fit an open gap (length, provider,
//                                    visit type, their day/time preferences);
//                        shorten     visits booked longer than their type's usual time with nothing attached that needs
//                                    the time — and what fits in the time it frees;
//                        confirm     visits at risk of a no-show that aren't confirmed yet (protects what's booked).
//   OPT3  solve          a non-conflicting combination that reaches each provider's goal with the fewest moves (exact for
//                        a small list, greedy by value with conflict checks otherwise): "3 moves get Dr. Chen to 104%".
//   OPT4  rules          every placement is checked like a booking (hours, visits, blocks, perfect-day blocks, chair,
//                        the patient's own visits) — here on the day's rows, then again by validateAppt in the database —
//                        and never double-books; insurance frequency limits keep items out; people click to act.
//
// The engine is pure (generate/solve take a plain `day` object) so it can be tested without a database; loadDay
// gathers the rows. Times are practice-local wall-clock strings ('YYYY-MM-DD HH:MM'); inside, minutes of the day.
import { scheduleProduction, loadTemplates, planDays, blocksOn, kindOf, addDays } from './production.js';
import { noShowRisks } from './predict/noshow.js';
import { forScreen } from './predict/index.js';
import { providerHoursOn } from './hours.js';
import { typeDuration } from './patterns.js';
import { practiceNow, isRealDate, friendlyDateTime } from './util.js';
import { can, HttpError } from './auth.js';
import { appointmentScope, patientScope } from './officeaccess.js';
import { practiceContext, evaluate } from './opportunities.js';
import { primaryPolicy, estimateCoverage } from './services.js';
import { officeFee } from './fees.js';
import { recallTypes } from './recalls.js';
import { validateAppt } from './routes/schedule.js';

export const SLOT = 10;
export const TOLERANCE = 5; // minutes a visit may run over its planned work before an add "doesn't fit"
export const MIN_GAP = 20; // open time worth filling with a visit of its own
export const MAX_LIST = 80; // opportunities shown (the plan picks from all of them)
export const EXACT_LIMIT = 14; // up to this many candidates the plan is searched exactly
const INACTIVE = ['cancelled', 'no_show'];
const pad = (n) => String(n).padStart(2, '0');
export const toMin = (dt) => Number(String(dt).slice(11, 13)) * 60 + Number(String(dt).slice(14, 16));
const hm = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const at = (date, m) => `${date} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const up10 = (m) => Math.ceil(m / SLOT) * SLOT;
const down10 = (m) => Math.floor(m / SLOT) * SLOT;
const overlaps = (s1, e1, s2, e2) => s1 < e2 && s2 < e1;
const clock = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${pad(m % 60)} ${m < 720 ? 'AM' : 'PM'}`;
export const shortName = (p) => (p ? `${p.preferred_name || p.first_name} ${String(p.last_name || '').slice(0, 1)}${p.last_name ? '.' : ''}`.trim() : '');
export const dollars = (c) => `$${Math.round(Number(c || 0) / 100).toLocaleString('en-US')}`;

// ---- How long work takes ----
// A code's own time units win (10-minute units on procedure_codes); else a typical chair time for the code; else a
// typical time for its category. Small add-ons are small: fluoride isn't a 40-minute hygiene visit.
export const CODE_MINUTES = {
  D0120: 10, D0140: 15, D0150: 20, D0180: 20, D0210: 15, D0220: 5, D0230: 5, D0272: 5, D0274: 5, D0330: 10, D0431: 5,
  D1110: 40, D1120: 30, D1206: 5, D1208: 5, D1351: 10, D1352: 10, D1354: 5,
  D4341: 60, D4342: 30, D4346: 45, D4355: 45, D4381: 5, D4910: 50, D9944: 15, D9910: 5,
};
export const CATEGORY_MINUTES = {
  diagnostic: 10, preventive: 30, restorative: 45, endodontics: 90, periodontics: 45, prosthodontics: 90,
  oral_surgery: 45, orthodontics: 30, implants: 90, adjunctive: 15,
};
export function procMinutes({ code, category, time_units: units } = {}) {
  if (Number(units) > 0) return Number(units) * SLOT;
  return CODE_MINUTES[code] ?? CATEGORY_MINUTES[category] ?? 30;
}
// Which kind of provider does the work: its provider's kind when set, else hygiene for cleanings and perio.
const HYGIENE_CODES = /^D(1\d{3}|4341|4342|4346|4355|4381|4910|0272|0274|0210|0330|0220|0230)$/;
export const workKind = (proc, providerType = null) => (providerType ? kindOf(providerType) : HYGIENE_CODES.test(String(proc.code || '')) ? 'hygiene' : 'doctor');

// ---- The day, as plain rows (see loadDay for where each comes from) ----
// day = {
//   date, nowMin (nothing is placed before it; 0 for a future day, 1440 for a past one),
//   providers: [{ id, name, type, kind, color, hours: [[s, e]], goal, scheduled }],
//   chairs: [{ id, name, default_provider_id, is_hygiene }],
//   visits: [{ id, patient: { id, first_name, last_name, guarantor_id }, provider_id, operatory_id, s, e, status,
//             type_id, usual (the type's length for this provider, or null), procedures: [{ id, code, fee, minutes }],
//             fee, confirmed, here (in the office shown) }],
//   busy: [{ provider_id, operatory_id, patient_id, s, e }]   other live visits that day (other offices), optional
//   blockouts: [{ provider_id, operatory_id, s, e, reason }],
//   kept: [{ provider_id, s, e, type_ids, label, until }]     perfect-day blocks not released yet,
//   types: { [id]: { id, name, duration, provider_type } },
//   planned: [{ id, patient_id, code, description, tooth, fee, collectible, minutes, kind, provider_id }],
//   finder: [{ appointment_id, patient_id, rule_id, name, codes, fee, collectible, minutes, reason, coverage }],
//   family: [{ patient, head_id, recall: { id, type, name, due_date, type_id, minutes, fee, collectible, kind, blocked } | null,
//              planned: [{ id, code, fee, collectible, minutes, kind }] }],
//   asap: [{ appointment_id, patient, provider_id, kind, minutes, fee, collectible, from_time, type_id }],
//   waitlist: [{ waitlist_id, patient, provider_id, days, times, minutes, fee, collectible, reason }],
//   recallDue: [{ recall_id, patient, kind, minutes, fee, collectible, type_id, name, due_date, blocked }],
//   noShow: { [appointment_id]: { probability, percent, level: 'high'|'some'|'low', reasons, confidence } } (predict/noshow.js),
// }

const live = (v) => !INACTIVE.includes(v.status);
const upcoming = (day, v) => live(v) && v.status !== 'completed' && v.e > day.nowMin;
const providerOf = (day, id) => day.providers.find((p) => p.id === id);
const nameOf = (day, id) => providerOf(day, id)?.name || '';

// Provider, chair and patient time taken on the day (live visits here and at other offices, blocks).
function busyFor(day, { providerId = null, chairId = null, patientId = null, ignore = null }) {
  const out = [];
  for (const v of [...day.visits.filter(live), ...(day.busy || [])]) {
    if (ignore && v.id === ignore) continue;
    if ((providerId && v.provider_id === providerId) || (chairId && v.operatory_id === chairId) || (patientId && (v.patient?.id ?? v.patient_id) === patientId)) out.push([v.s, v.e]);
  }
  for (const b of day.blockouts || []) {
    const office = !b.provider_id && !b.operatory_id;
    if (office || (providerId && b.provider_id === providerId) || (chairId && b.operatory_id === chairId)) out.push([b.s, b.e]);
  }
  return out;
}

// Can a visit go here? Checked the way booking checks it: the provider's hours, their other visits and blocks, a
// perfect-day block kept for other visit types, a free chair, and the patient not being somewhere else.
// Returns { fits, why, operatory_id }. place: { providerId, patientId, s, e, typeId, chairs (preferred order), ignore }.
export function canPlace(day, { providerId, patientId, s, e, typeId = null, chairs = [], ignore = null, extending = false }) {
  const pv = providerOf(day, providerId);
  if (!pv) return { fits: false, why: 'That provider isn’t working today' };
  if (!pv.hours.some(([o, c]) => s >= o && e <= c)) return { fits: false, why: `Outside ${pv.name}’s hours` };
  if (s < day.nowMin) return { fits: false, why: 'That time has passed' };
  if (busyFor(day, { providerId, ignore }).some(([a, b]) => overlaps(s, e, a, b))) return { fits: false, why: `${pv.name} is booked then` };
  for (const k of day.kept || []) {
    if (k.provider_id !== providerId || !overlaps(s, e, k.s, k.e)) continue;
    if (typeId != null && k.type_ids.includes(Number(typeId))) continue;
    return { fits: false, why: `${clock(k.s)}–${clock(k.e)} is kept for ${k.label}${k.until ? ` until ${k.until}` : ''}` };
  }
  if (patientId && busyFor(day, { patientId, ignore }).some(([a, b]) => overlaps(s, e, a, b))) return { fits: false, why: 'The patient is booked then' };
  // A chair: the one asked for first, then the provider's own, the ones they use today, then any.
  const order = [...new Set([
    ...chairs.filter(Boolean),
    ...day.chairs.filter((c) => c.default_provider_id === providerId).map((c) => c.id),
    ...day.visits.filter((v) => live(v) && v.provider_id === providerId && v.operatory_id).map((v) => v.operatory_id),
    ...day.chairs.filter((c) => !!c.is_hygiene === (pv.kind === 'hygiene')).map((c) => c.id),
    ...day.chairs.map((c) => c.id),
  ])];
  if (!day.chairs.length) return { fits: true, operatory_id: null };
  const free = order.find((id) => !busyFor(day, { chairId: id, ignore }).some(([a, b]) => overlaps(s, e, a, b)));
  if (!free) return { fits: false, why: 'No chair is free then' };
  if (extending && chairs[0] && free !== chairs[0]) return { fits: false, why: 'The chair is needed after this visit' };
  return { fits: true, operatory_id: free };
}

// Open time per provider: their hours less visits (here and elsewhere) and blocks, from now on.
export function openGaps(day, providerId) {
  const pv = providerOf(day, providerId);
  if (!pv) return [];
  const busy = busyFor(day, { providerId }).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [o, c] of pv.hours) {
    let cursor = Math.max(o, up10(day.nowMin));
    for (const [a, b] of busy) {
      if (b <= cursor || a >= c) continue;
      if (a > cursor) out.push([cursor, Math.min(a, c)]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < c) out.push([cursor, c]);
  }
  return out.filter(([a, b]) => b - a >= SLOT).map(([s, e]) => ({ provider_id: providerId, s, e, minutes: e - s }));
}

// OPT1: each provider's day against their goal.
export function goalGaps(day) {
  return day.providers.map((p) => {
    const gaps = openGaps(day, p.id);
    const open = gaps.reduce((n, g) => n + g.minutes, 0);
    const blocks = (day.kept || []).filter((k) => k.provider_id === p.id).map((k) => ({
      label: k.label, start: k.s, end: k.e, open: gaps.filter((g) => overlaps(g.s, g.e, k.s, k.e)).reduce((n, g) => n + Math.min(g.e, k.e) - Math.max(g.s, k.s), 0),
    })).filter((b) => b.open > 0);
    return {
      provider_id: p.id, name: p.name, kind: p.kind, color: p.color ?? null, goal: p.goal || 0, scheduled: p.scheduled || 0,
      gap: Math.max(0, (p.goal || 0) - (p.scheduled || 0)), pct: p.goal ? Math.round(((p.scheduled || 0) / p.goal) * 100) : null,
      open_minutes: open, gaps: gaps.map((g) => ({ start: g.s, end: g.e, minutes: g.minutes })), blocks,
    };
  });
}

// ---- OPT2: the generators ----
const base = (day, o) => ({
  fits: true, why_not: null, alt_actions: [], ...o,
  provider_name: nameOf(day, o.provider_id), per_minute: Math.round((o.collectible ?? o.fee ?? 0) / Math.max(o.minutes || SLOT, SLOT)),
});
const slack = (v) => v.e - v.s - v.procedures.reduce((n, p) => n + p.minutes, 0);
// Where the kind of provider a piece of work needs can see this patient around their visit: in the visit, stretching
// it, or a visit of its own just after or just before (same chair when it's free).
function placeAround(day, v, { kind, minutes, providerId = null, typeId = null }) {
  const vp = providerOf(day, v.provider_id);
  const tries = [];
  if (vp && vp.kind === kind && (!providerId || providerId === vp.id || kind === 'hygiene')) {
    if (slack(v) + TOLERANCE >= minutes) return { how: 'in_visit' };
    const extra = up10(minutes - Math.max(0, slack(v)));
    const ok = canPlace(day, { providerId: v.provider_id, patientId: v.patient.id, s: v.e, e: v.e + extra, typeId: v.type_id, chairs: [v.operatory_id], ignore: v.id, extending: true });
    if (ok.fits && v.e > day.nowMin) return { how: 'extend', end: v.e + extra, extra };
    tries.push(ok.why);
  }
  const len = up10(minutes);
  const who = day.providers.filter((p) => p.kind === kind).sort((a, b) => (b.id === providerId) - (a.id === providerId) || (b.id === v.provider_id) - (a.id === v.provider_id));
  for (const p of who) {
    for (const [s, e] of [[v.e, v.e + len], [v.s - len, v.s]]) {
      const ok = canPlace(day, { providerId: p.id, patientId: v.patient.id, s, e, typeId, chairs: [v.operatory_id] });
      if (ok.fits) return { how: 'adjacent', provider_id: p.id, s, e, operatory_id: ok.operatory_id };
      tries.push(ok.why);
    }
  }
  return { how: null, why: tries.find(Boolean) || `No ${kind === 'hygiene' ? 'hygienist' : 'doctor'} time next to this visit` };
}

// (a) Planned treatment for patients already on today's schedule.
export function treatmentOpportunities(day) {
  const out = [];
  const seen = new Set();
  for (const v of day.visits.filter((x) => upcoming(day, x) && x.here !== false).sort((a, b) => a.s - b.s)) {
    for (const t of day.planned.filter((x) => x.patient_id === v.patient.id)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const spot = placeAround(day, v, { kind: t.kind, minutes: t.minutes, providerId: t.provider_id });
      const what = `${t.code}${t.tooth ? ` #${t.tooth}` : ''} ${t.description || ''}`.trim();
      const o = {
        key: `tx:${t.id}`, kind: 'treatment', patient: { id: v.patient.id, name: shortName(v.patient) }, appointment_id: v.id,
        visit: { id: v.id, start: v.s, end: v.e }, fee: t.fee, collectible: t.collectible ?? t.fee, minutes: t.minutes, provider_id: v.provider_id,
      };
      if (spot.how === 'in_visit') {
        out.push(base(day, { ...o, title: `Add ${what} to ${shortName(v.patient)}’s ${clock(v.s)} visit`, detail: `Planned and not booked · fits in the visit (${t.minutes} min)`, action: { type: 'attach', procedure_id: t.id, appointment_id: v.id } }));
      } else if (spot.how === 'extend') {
        out.push(base(day, {
          ...o, title: `Add ${what} to ${shortName(v.patient)}’s ${clock(v.s)} visit`, detail: `Planned and not booked · stretch the visit to ${clock(spot.end)} (+${spot.extra} min, the time after it is open)`,
          slot: { start: v.e, end: spot.end, operatory_id: v.operatory_id }, action: { type: 'attach', procedure_id: t.id, appointment_id: v.id, end: spot.end },
        }));
      } else if (spot.how === 'adjacent') {
        out.push(base(day, {
          ...o, provider_id: spot.provider_id, appointment_id: null, title: `${what} for ${shortName(v.patient)} ${spot.s >= v.e ? 'after' : 'before'} their ${clock(v.s)} visit`,
          detail: `Planned and not booked · ${nameOf(day, spot.provider_id)} is free ${clock(spot.s)}–${clock(spot.e)}`,
          slot: { start: spot.s, end: spot.e, operatory_id: spot.operatory_id },
          action: { type: 'book', patient_id: v.patient.id, provider_id: spot.provider_id, operatory_id: spot.operatory_id, start: spot.s, end: spot.e, procedure_ids: [t.id], reason: what },
        }));
      } else {
        out.push(base(day, { ...o, title: `${what} for ${shortName(v.patient)}`, detail: 'Planned and not booked', fits: false, why_not: spot.why, action: null }));
      }
    }
  }
  return out;
}

// (b) The opportunity finder's items for today's visits (not unscheduled treatment: that's (a), priced per item).
export function finderOpportunities(day) {
  const out = [];
  for (const f of day.finder) {
    const v = day.visits.find((x) => x.id === f.appointment_id);
    if (!v || !upcoming(day, v) || v.here === false) continue;
    const o = {
      key: `of:${v.id}:${f.rule_id}`, kind: 'finder', patient: { id: v.patient.id, name: shortName(v.patient) }, appointment_id: v.id, provider_id: v.provider_id,
      visit: { id: v.id, start: v.s, end: v.e }, fee: f.fee, collectible: f.collectible ?? f.fee, minutes: f.minutes,
      title: `${f.name} for ${shortName(v.patient)} (${clock(v.s)})`, detail: [f.reason, f.coverage?.label].filter(Boolean).join(' · '),
    };
    if (f.coverage?.status === 'not_yet') {
      out.push(base(day, { ...o, fits: false, why_not: f.coverage.label, action: null }));
      continue;
    }
    // Finder items are done by the visit's own provider (the hygienist's fluoride, the doctor's night guard).
    const spot = slack(v) + TOLERANCE >= f.minutes ? { how: 'in_visit' } : (() => {
      const extra = up10(f.minutes - Math.max(0, slack(v)));
      const ok = canPlace(day, { providerId: v.provider_id, patientId: v.patient.id, s: v.e, e: v.e + extra, typeId: v.type_id, chairs: [v.operatory_id], ignore: v.id, extending: true });
      return ok.fits ? { how: 'extend', end: v.e + extra, extra } : { how: null, why: `Needs ${f.minutes} min; ${ok.why.toLowerCase()}` };
    })();
    if (spot.how === 'in_visit') out.push(base(day, { ...o, action: { type: 'finder_add', appointment_id: v.id, rule_id: f.rule_id } }));
    else if (spot.how === 'extend') {
      out.push(base(day, {
        ...o, detail: `${o.detail} · stretch the visit to ${clock(spot.end)} (+${spot.extra} min)`, slot: { start: v.e, end: spot.end, operatory_id: v.operatory_id },
        action: { type: 'finder_add', appointment_id: v.id, rule_id: f.rule_id, end: spot.end },
      }));
    } else out.push(base(day, { ...o, fits: false, why_not: spot.why, action: null }));
  }
  return out;
}

// (c) Family members who could come with the patient already booked: back to back (same chair when free), or at the
// same time with another provider.
export function familyOpportunities(day) {
  const out = [];
  const onToday = new Set(day.visits.filter(live).map((v) => v.patient.id));
  for (const m of day.family) {
    if (onToday.has(m.patient.id)) continue;
    const kin = day.visits.filter((v) => upcoming(day, v) && v.here !== false && (v.patient.guarantor_id || v.patient.id) === m.head_id).sort((a, b) => a.s - b.s);
    if (!kin.length) continue;
    const work = [];
    if (m.recall && !m.recall.blocked) work.push({ kind: m.recall.kind, minutes: m.recall.minutes, fee: m.recall.fee, collectible: m.recall.collectible, type_id: m.recall.type_id, what: `${m.recall.name} (due ${m.recall.due_date})`, procedure_ids: [] });
    for (const kind of ['doctor', 'hygiene']) {
      const tx = m.planned.filter((t) => t.kind === kind);
      if (tx.length) work.push({ kind, minutes: tx.reduce((n, t) => n + t.minutes, 0), fee: tx.reduce((n, t) => n + t.fee, 0), collectible: tx.reduce((n, t) => n + (t.collectible ?? t.fee), 0), type_id: null, what: `planned treatment (${tx.map((t) => t.code).join(', ')})`, procedure_ids: tx.map((t) => t.id), tag: `tx-${kind}` });
    }
    for (const w of work) {
      const len = up10(w.minutes);
      let found = null;
      let why = null;
      for (const v of kin) {
        const who = day.providers.filter((p) => p.kind === w.kind).sort((a, b) => (b.id === v.provider_id) - (a.id === v.provider_id));
        for (const p of who) {
          for (const [s, e, how] of [[v.e, v.e + len, 'after'], [v.s - len, v.s, 'before'], [v.s, v.s + len, 'alongside']]) {
            if (how === 'alongside' && p.id === v.provider_id) continue;
            const ok = canPlace(day, { providerId: p.id, patientId: m.patient.id, s, e, typeId: w.type_id, chairs: how === 'alongside' ? [] : [v.operatory_id] });
            if (ok.fits) { found = { v, p, s, e, how, operatory_id: ok.operatory_id }; break; }
            why ||= ok.why;
          }
          if (found) break;
        }
        if (found) break;
      }
      const key = `fam:${m.patient.id}:${w.tag || 'recall'}`;
      const o = { key, kind: 'family', patient: { id: m.patient.id, name: shortName(m.patient) }, fee: w.fee, collectible: w.collectible, minutes: len };
      if (!found) {
        out.push(base(day, { ...o, provider_id: kin[0].provider_id, title: `${shortName(m.patient)} (${shortName(kin[0].patient)}’s family): ${w.what}`, detail: 'Could come with their family member today', fits: false, why_not: why || 'No time next to their family member’s visit', action: null }));
        continue;
      }
      const { v, p, s, e, how } = found;
      out.push(base(day, {
        ...o, provider_id: p.id, appointment_id: null, slot: { start: s, end: e, operatory_id: found.operatory_id },
        title: `${shortName(m.patient)} could come ${how === 'alongside' ? 'at the same time as' : how} ${shortName(v.patient)} (${clock(v.s)})`,
        detail: `${w.what} · ${p.name} ${clock(s)}–${clock(e)}`,
        action: { type: 'book', patient_id: m.patient.id, provider_id: p.id, operatory_id: found.operatory_id, start: s, end: e, appointment_type_id: w.type_id, procedure_ids: w.procedure_ids, reason: w.what },
        alt_actions: [{ type: 'text', patient_id: m.patient.id, provider_id: p.id, start: s, end: e, reason: w.what }],
      }));
    }
  }
  return out;
}

// Waitlist day and time preferences (as fill.js reads them).
function prefsFit(w, date, s) {
  const days = Array.isArray(w.days) ? w.days : w.days ? JSON.parse(w.days) : null;
  if (days?.length && !days.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return 'Their days don’t include today';
  if (w.times === 'morning' && s >= 720) return 'They asked for mornings';
  if (w.times === 'afternoon' && s < 720) return 'They asked for afternoons';
  return null;
}

// (d) ASAP-list, waitlist and recall-due patients who fit an open gap. Each patient is offered their best gap.
export function fillOpportunities(day, gaps = null) {
  gaps ||= day.providers.flatMap((p) => openGaps(day, p.id)).filter((g) => g.minutes >= MIN_GAP);
  const onToday = new Set(day.visits.filter(live).map((v) => v.patient.id));
  const pool = [
    ...day.asap.map((a) => ({ ...a, source: 'asap', ref_id: a.appointment_id, what: `wants an earlier visit (booked ${a.from_time})` })),
    ...day.waitlist.map((w) => ({ ...w, source: 'waitlist', ref_id: w.waitlist_id, what: `on the waitlist${w.reason ? ` (${w.reason})` : ''}` })),
    ...day.recallDue.filter((r) => !r.blocked).map((r) => ({ ...r, source: 'recall', ref_id: r.recall_id, what: `${r.name} due ${r.due_date}` })),
  ];
  const best = new Map();
  for (const c of pool) {
    if (onToday.has(c.patient.id) && c.source !== 'asap') continue;
    const len = up10(c.minutes || 60);
    let pick = null;
    let why = null;
    for (const g of gaps) {
      const pv = providerOf(day, g.provider_id);
      if (!pv || g.minutes < len) { why ||= 'No open time long enough'; continue; }
      if (c.provider_id && c.provider_id !== pv.id && c.source !== 'recall') { why ||= `They want ${nameOf(day, c.provider_id)}`; continue; }
      if (c.kind && c.kind !== pv.kind) continue;
      // The earliest start in the gap that suits them and the rules.
      for (let s = g.s; s + len <= g.e; s += SLOT) {
        const pref = c.source === 'waitlist' ? prefsFit(c, day.date, s) : null;
        if (pref) { why ||= pref; continue; }
        const ok = canPlace(day, { providerId: pv.id, patientId: c.patient.id, s, e: s + len, typeId: c.type_id ?? null });
        if (!ok.fits) { why ||= ok.why; continue; }
        pick = { g, pv, s, e: s + len, operatory_id: ok.operatory_id };
        break;
      }
      if (pick) break;
    }
    const key = `fill:${c.patient.id}`;
    const prior = best.get(key);
    const o = {
      key, kind: 'fill', source: c.source, ref_id: c.ref_id, patient: { id: c.patient.id, name: shortName(c.patient) }, fee: c.fee || 0, collectible: c.collectible ?? c.fee ?? 0, minutes: len,
      provider_id: pick?.pv.id ?? c.provider_id ?? null,
    };
    let opp;
    if (!pick) opp = base(day, { ...o, title: `${shortName(c.patient)} — ${c.what}`, detail: 'Could fill an open time today', fits: false, why_not: why || 'No open time that suits', action: null });
    else {
      const text = { type: 'text_offer', source: c.source, ref_id: c.ref_id, patient_id: c.patient.id, provider_id: pick.pv.id, operatory_id: pick.operatory_id, start: pick.s, end: pick.e };
      const book = c.source === 'asap'
        ? { type: 'move_up', appointment_id: c.appointment_id, patient_id: c.patient.id, provider_id: pick.pv.id, operatory_id: pick.operatory_id, start: pick.s, end: pick.e }
        : { type: 'book', patient_id: c.patient.id, provider_id: pick.pv.id, operatory_id: pick.operatory_id, start: pick.s, end: pick.e, appointment_type_id: c.type_id ?? null, procedure_ids: c.procedure_ids || [], reason: c.what, waitlist_id: c.source === 'waitlist' ? c.ref_id : null };
      opp = base(day, {
        ...o, slot: { start: pick.s, end: pick.e, operatory_id: pick.operatory_id }, appointment_id: c.source === 'asap' ? c.appointment_id : null,
        title: `Offer ${clock(pick.s)} with ${pick.pv.name} to ${shortName(c.patient)}`, detail: `${cap(c.what)} · ${len} min${c.fee ? '' : ' · no treatment attached yet'}`,
        action: text, alt_actions: [book], needs_reply: true,
      });
    }
    // One per patient: the one that fits, then the most valuable.
    if (!prior || (opp.fits && !prior.fits) || (opp.fits === prior.fits && opp.collectible > prior.collectible)) best.set(key, opp);
  }
  return [...best.values()];
}

// (e) Visits booked longer than their type's usual time, when what's attached doesn't need the extra time — and
// what could go in the time it frees (the best fill that fits there).
export function shortenOpportunities(day) {
  const out = [];
  for (const v of day.visits) {
    if (!['scheduled', 'confirmed'].includes(v.status) || v.here === false || v.s < day.nowMin || !v.usual) continue;
    const length = v.e - v.s;
    const work = v.procedures.reduce((n, p) => n + p.minutes, 0);
    const needed = Math.max(v.usual, work);
    const freed = down10(length - needed);
    if (freed < SLOT) continue;
    const end = v.e - freed;
    // The freed time joins any open time right after the visit.
    const after = openGaps(day, v.provider_id).find((g) => g.s === v.e);
    const gap = { provider_id: v.provider_id, s: end, e: after ? after.e : v.e, minutes: (after ? after.e : v.e) - end };
    const fill = fillOpportunities({ ...day, visits: day.visits.map((x) => (x.id === v.id ? { ...x, e: end } : x)) }, [gap]).filter((f) => f.fits).sort((a, b) => b.collectible - a.collectible)[0] || null;
    out.push(base(day, {
      key: `short:${v.id}`, kind: 'shorten', patient: { id: v.patient.id, name: shortName(v.patient) }, appointment_id: v.id, provider_id: v.provider_id,
      visit: { id: v.id, start: v.s, end: v.e }, slot: { start: end, end: v.e, operatory_id: v.operatory_id },
      fee: fill?.fee || 0, collectible: fill?.collectible || 0, minutes: freed,
      title: `Shorten ${shortName(v.patient)}’s ${clock(v.s)} visit by ${freed} min`,
      detail: `Booked ${length} min; ${day.types[v.type_id]?.name || 'this visit'} usually takes ${v.usual}${work > v.usual ? ` and its work ${work}` : ''}${fill ? ` · then ${fill.title.replace(/^Offer/, 'offer')}` : ' · frees the time for someone else'}`,
      then: fill ? { key: fill.key, patient_id: fill.patient.id, title: fill.title, fee: fill.fee, collectible: fill.collectible } : null,
      action: { type: 'shorten', appointment_id: v.id, end },
    }));
  }
  return out;
}

// (f) No-show risk: the predicted chance each unconfirmed visit is missed or cancelled late (predict/noshow.js — the
// patient's own record, how far ahead it was booked, the day and time, the visit type, a balance owed, against the
// office's usual rate). 'high' and 'some' are set from the probability there; 'low' isn't suggested.
export function confirmOpportunities(day) {
  const out = [];
  for (const v of day.visits) {
    if (!['scheduled'].includes(v.status) || v.confirmed || v.s < day.nowMin || v.here === false) continue;
    const r = day.noShow?.[v.id];
    if (!r || r.level === 'low' || !r.level) continue;
    out.push(base(day, {
      key: `conf:${v.id}`, kind: 'confirm', patient: { id: v.patient.id, name: shortName(v.patient) }, appointment_id: v.id, provider_id: v.provider_id,
      visit: { id: v.id, start: v.s, end: v.e }, fee: 0, collectible: 0, at_risk: v.fee, minutes: 0, risk: r.level, probability: r.probability,
      title: `Double-confirm ${shortName(v.patient)} (${clock(v.s)})`,
      detail: `No-show risk ${r.percent}%${r.reasons?.length ? ` — ${r.reasons.join(', ')}` : ''}${v.fee ? ` · ${dollars(v.fee)} booked` : ''}`,
      action: { type: 'confirm', appointment_id: v.id },
    }));
  }
  return out;
}

// Everything, priced; the ones that fit first, then by $ per minute.
export function generate(day) {
  const all = [
    ...treatmentOpportunities(day), ...finderOpportunities(day), ...familyOpportunities(day),
    ...fillOpportunities(day), ...shortenOpportunities(day), ...confirmOpportunities(day),
  ];
  return all.sort((a, b) => b.fits - a.fits || (b.collectible || 0) - (a.collectible || 0) || a.key.localeCompare(b.key));
}

// ---- OPT3: the plan ----
// What each opportunity takes: provider/chair/patient time, a visit's spare minutes, and things only one move can
// take (a planned procedure, a patient's one booking, a visit's end).
export function uses(day, o) {
  const iv = [];
  const only = [o.key, `pt:${o.patient?.id}:${o.kind === 'fill' || o.kind === 'family' ? 'book' : o.key}`];
  let spare = null;
  const a = o.action || {};
  if (a.type === 'attach' || a.type === 'finder_add') {
    const v = day.visits.find((x) => x.id === a.appointment_id);
    if (a.end && v) {
      iv.push([`prov:${v.provider_id}`, v.e, a.end], [`pt:${v.patient.id}`, v.e, a.end]);
      if (v.operatory_id) iv.push([`chair:${v.operatory_id}`, v.e, a.end]);
      only.push(`end:${v.id}`);
    } else if (v) spare = { visit: v.id, minutes: o.minutes, room: Math.max(0, slack(v)) + TOLERANCE };
    if (a.procedure_id) only.push(`proc:${a.procedure_id}`);
  } else if (['book', 'text_offer', 'move_up'].includes(a.type)) {
    iv.push([`prov:${a.provider_id}`, a.start, a.end], [`pt:${a.patient_id}`, a.start, a.end]);
    if (a.operatory_id) iv.push([`chair:${a.operatory_id}`, a.start, a.end]);
    for (const id of a.procedure_ids || []) only.push(`proc:${id}`);
  } else if (a.type === 'shorten') {
    only.push(`end:${a.appointment_id}`);
    // The follow-on fill takes the freed time, so nothing else may.
    const v = day.visits.find((x) => x.id === a.appointment_id);
    if (v && o.then) {
      iv.push([`prov:${v.provider_id}`, a.end, v.e]);
      only.push(o.then.key, `pt:${o.then.patient_id}:book`);
    }
  }
  return { iv, only, spare };
}
const clash = (x, y) => x.only.some((k) => y.only.includes(k)) || x.iv.some(([r, s, e]) => y.iv.some(([r2, s2, e2]) => r === r2 && overlaps(s, e, s2, e2)));
function spareOk(chosen, u) {
  if (!u.spare) return true;
  const used = chosen.filter((c) => c.u.spare?.visit === u.spare.visit).reduce((n, c) => n + c.u.spare.minutes, 0);
  return used + u.spare.minutes <= u.spare.room;
}

// Picks moves per provider until their goal is met: exactly (fewest moves, then most collected) when the list is
// small, else greedily by value with conflict checks. Confirmations protect what's booked and aren't in the plan.
export function solve(day, opps) {
  const cands = opps.filter((o) => o.fits && o.action && o.kind !== 'confirm' && (o.fee || 0) > 0).map((o) => ({ o, u: uses(day, o) }));
  const need = new Map(day.providers.map((p) => [p.id, Math.max(0, (p.goal || 0) - (p.scheduled || 0))]));
  const useful = cands.filter((c) => need.get(c.o.provider_id) > 0);
  let chosen;
  if (useful.length <= EXACT_LIMIT) chosen = exact(useful, need);
  else chosen = greedy(useful, need);
  return summarize(day, chosen.map((c) => c.o));
}
function greedy(cands, need) {
  const left = new Map(need);
  const out = [];
  const order = [...cands].sort((a, b) => b.o.fee - a.o.fee || b.o.per_minute - a.o.per_minute || a.o.key.localeCompare(b.o.key));
  for (const c of order) {
    if (left.get(c.o.provider_id) <= 0) continue;
    if (out.some((x) => clash(x.u, c.u)) || !spareOk(out, c.u)) continue;
    out.push(c);
    left.set(c.o.provider_id, left.get(c.o.provider_id) - c.o.fee);
  }
  // Nothing wasted: drop a move whose provider reaches goal without it (smallest first).
  for (const c of [...out].sort((a, b) => a.o.fee - b.o.fee)) {
    const rest = out.filter((x) => x !== c && x.o.provider_id === c.o.provider_id).reduce((n, x) => n + x.o.fee, 0);
    if (rest >= need.get(c.o.provider_id)) out.splice(out.indexOf(c), 1);
  }
  return out;
}
// Branch and bound over the small list: most providers at goal, then fewest moves, then most collected.
function exact(cands, need) {
  const order = [...cands].sort((a, b) => b.o.fee - a.o.fee);
  let best = { score: [-1, 0, 0], set: [] };
  const score = (set) => {
    const got = new Map();
    for (const c of set) got.set(c.o.provider_id, (got.get(c.o.provider_id) || 0) + c.o.fee);
    let reached = 0;
    let short = 0;
    for (const [pid, n] of need) {
      if (n <= 0) continue;
      const g = got.get(pid) || 0;
      if (g >= n) reached++;
      else short += n - g;
    }
    return [reached, -short, -set.length, set.reduce((n, c) => n + (c.o.collectible || 0), 0)];
  };
  const better = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
  const walk = (i, set) => {
    const s = score(set);
    if (better(s, best.score)) best = { score: s, set: [...set] };
    if (i >= order.length) return;
    const c = order[i];
    if (!set.some((x) => clash(x.u, c.u)) && spareOk(set, c.u)) {
      const got = set.filter((x) => x.o.provider_id === c.o.provider_id).reduce((n, x) => n + x.o.fee, 0);
      if (got < need.get(c.o.provider_id)) walk(i + 1, [...set, c]);
    }
    walk(i + 1, set);
  };
  walk(0, []);
  return best.set;
}

export function summarize(day, picks) {
  const providers = day.providers.map((p) => {
    const moves = picks.filter((o) => o.provider_id === p.id).sort((a, b) => (a.slot?.start ?? a.visit?.start ?? 0) - (b.slot?.start ?? b.visit?.start ?? 0));
    const added = moves.reduce((n, o) => n + o.fee, 0);
    const projected = (p.scheduled || 0) + added;
    const pct = p.goal ? Math.round((projected / p.goal) * 100) : null;
    const now = p.goal ? Math.round(((p.scheduled || 0) / p.goal) * 100) : null;
    let headline;
    if (!p.goal) headline = `No goal set for ${p.name} today`;
    else if ((p.scheduled || 0) >= p.goal) headline = `${p.name} is at ${now}% of goal — nothing needed`;
    else if (!moves.length) headline = `${p.name} is at ${now}% of goal; nothing found today that closes the ${dollars(p.goal - (p.scheduled || 0))} gap`;
    else headline = `${moves.length} ${moves.length === 1 ? 'move gets' : 'moves get'} ${p.name} to ${pct}% of goal`;
    return { provider_id: p.id, name: p.name, goal: p.goal || 0, scheduled: p.scheduled || 0, added, projected, pct_now: now, pct, reached: !!p.goal && projected >= p.goal, moves: moves.map((o) => o.key), headline };
  });
  const moves = picks.length;
  const total = picks.reduce((n, o) => n + o.fee, 0);
  return {
    providers, keys: picks.map((o) => o.key), moves, added: total, collectible: picks.reduce((n, o) => n + (o.collectible || 0), 0),
    headline: !day.providers.some((p) => p.goal) ? 'No goals are set for today' : moves ? `${moves} ${moves === 1 ? 'move adds' : 'moves add'} ${dollars(total)} today` : day.providers.every((p) => !p.goal || (p.scheduled || 0) >= p.goal) ? 'Everyone is at goal today' : 'Nothing found today that closes the gap',
  };
}

// The whole answer for a day (pure): goal gaps, opportunities (tracked ones marked), and the plan.
export function optimizeDay(day) {
  const opps = generate(day);
  const plan = solve(day, opps);
  const inPlan = new Set(plan.keys);
  for (const o of opps) o.in_plan = inPlan.has(o.key);
  return { providers: goalGaps(day), opportunities: opps, plan };
}

// ---- Loading the day from the database ----
const ids = (rows, key = 'id') => [...new Set(rows.map((r) => r[key]).filter((x) => x != null))];
const IN = (list) => (list.length ? list.map(() => '?').join(',') : 'NULL');
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

// Estimated collectible (fee less the plan's write-off) for a patient's procedures, by the same estimate as
// everywhere else. Frequency or waiting-period limits come back as `blocked`.
async function collectibleFor(db, pid, patientId, procs, date, cache) {
  if (!procs.length) return [];
  let policy = cache.get(patientId);
  if (policy === undefined) { policy = (await primaryPolicy(db, pid, patientId)) || null; cache.set(patientId, policy); }
  try {
    const est = await estimateCoverage(db, policy, procs.map((p, i) => ({ id: p.id ?? null, preview: i, practice_id: pid, patient_id: patientId, code: p.code, category: p.category, tooth: p.tooth ?? null, area: p.area ?? null, fee: p.fee, status: 'planned' })), { asOf: date });
    return est.items.map((it, i) => ({
      collectible: Math.max(0, (procs[i].fee || 0) - (it.write_off || 0)),
      blocked: policy && !it.covered && (it.notes || []).some((n) => /^Frequency|covered from/.test(n)) ? (it.notes || []).find((n) => /^Frequency|covered from/.test(n)) : null,
    }));
  } catch {
    return procs.map((p) => ({ collectible: p.fee, blocked: null }));
  }
}

// The day's rows for the engine. `user` limits it to their offices; money is always worked out here (the route
// hides it from people without billing access).
export async function loadDay(db, user, { date, locationId = null, withFinder = true } = {}) {
  const pid = user.practice_id;
  if (!isRealDate(date)) throw new HttpError(400, 'date must be a real date (YYYY-MM-DD)');
  const now = await practiceNow(db, pid);
  const today = now.slice(0, 10);
  const nowMin = date < today ? 24 * 60 : date > today ? 0 : toMin(now);
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', pid);
  const location = locationId ? await db.get('SELECT * FROM locations WHERE id = ? AND practice_id = ?', locationId, pid) : null;
  if (locationId && !location) throw new HttpError(404, 'Office not found');
  const hoursSource = location?.office_hours ? location : practice;

  // OPT1 uses the schedule's own production numbers.
  const prod = await scheduleProduction(db, { ...user, role: 'admin' }, { from: date, locationId });
  const pday = prod.days[0];
  const provRows = await db.all('SELECT * FROM providers WHERE practice_id = ? AND active = 1 ORDER BY id', pid);
  const scope = appointmentScope(user, 'a');
  const apptRows = await db.all(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name, p.guarantor_id, p.dob FROM real_appointments a JOIN real_patients p ON p.id = a.patient_id
     WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ?${scope.sql} ORDER BY a.start_time, a.id`, pid, `${date} 00:00`, `${date} 24:00`, ...scope.args,
  );
  const here = (a) => !locationId || a.location_id === locationId || (a.location_id == null);
  const types = Object.fromEntries((await db.all('SELECT * FROM appointment_types WHERE practice_id = ?', pid)).map((t) => [t.id, t]));
  const codes = new Map((await db.all('SELECT * FROM procedure_codes WHERE practice_id = ?', pid)).map((c) => [c.code, c]));
  const minutesOf = (p) => procMinutes({ code: p.code, category: p.category ?? codes.get(p.code)?.category, time_units: codes.get(p.code)?.time_units });
  const visitIds = ids(apptRows);
  const procRows = visitIds.length ? await db.all(`SELECT id, appointment_id, code, fee, category, tooth FROM real_procedures procedures WHERE appointment_id IN (${IN(visitIds)}) AND status != 'cancelled'`, ...visitIds) : [];

  // Providers working today (here): hours, today's goal and what's booked.
  const providers = [];
  for (const pv of provRows) {
    const hours = await providerHoursOn(db, hoursSource, pv, date);
    const b = pday.providers[pv.id];
    const seesHere = apptRows.some((a) => a.provider_id === pv.id && here(a) && !INACTIVE.includes(a.status));
    if (!hours.length && !seesHere) continue;
    if (locationId && !seesHere && !(b?.goal > 0)) continue;
    providers.push({
      id: pv.id, name: pv.name, type: pv.type, kind: kindOf(pv.type), color: pv.color, hours: hours.map(([o, c]) => [hm(o), hm(c)]),
      goal: b?.goal || 0, scheduled: b?.scheduled || 0,
    });
  }
  // Kinds with no provider goal use the practice's (as the schedule's numbers do: daily_goal, of which hygiene_goal is
  // hygiene's part), shared among that kind's providers working today by their hours.
  for (const k of ['doctor', 'hygiene']) {
    const mine = providers.filter((p) => p.kind === k);
    if (!mine.length || provRows.some((pv) => kindOf(pv.type) === k && pv.daily_goal > 0) || mine.some((p) => p.goal > 0)) continue;
    const daily = practice.daily_goal || 0;
    const hyg = Math.min(practice.hygiene_goal || 0, daily || Infinity);
    const goal = k === 'hygiene' ? hyg : Math.max(0, daily - hyg);
    const minutes = mine.map((p) => p.hours.reduce((n, [o, c]) => n + c - o, 0));
    const all = minutes.reduce((n, m) => n + m, 0);
    if (!goal || !all) continue;
    mine.forEach((p, i) => { p.goal = Math.round((goal * minutes[i]) / all); p.goal_source = 'practice'; });
  }
  const chairs = await db.all(`SELECT id, name, location_id, default_provider_id, is_hygiene FROM operatories WHERE practice_id = ? AND active = 1${locationId ? ' AND (location_id = ? OR location_id IS NULL)' : ''} ORDER BY sort, id`, pid, ...(locationId ? [locationId] : []));
  // Other offices' visits still hold the provider and the patient.
  const visits = apptRows.map((a) => {
    const procedures = procRows.filter((x) => x.appointment_id === a.id).map((x) => ({ ...x, minutes: minutesOf(x) }));
    const type = types[a.appointment_type_id];
    return {
      id: a.id, patient: { id: a.patient_id, first_name: a.first_name, last_name: a.last_name, preferred_name: a.preferred_name, guarantor_id: a.guarantor_id },
      provider_id: a.provider_id, operatory_id: a.operatory_id, location_id: a.location_id, s: toMin(a.start_time), e: a.end_time.slice(0, 10) > date ? 24 * 60 : toMin(a.end_time),
      start_time: a.start_time, end_time: a.end_time, status: a.status, type_id: a.appointment_type_id, usual: type ? typeDuration(type, a.provider_id) : null,
      procedures, fee: procedures.reduce((n, x) => n + x.fee, 0), confirmed: a.status !== 'scheduled' || !!a.confirmed_at, here: here(a),
    };
  });
  // Visits this person can't see (another office) still take the provider's time.
  const hidden = scope.sql ? await db.all(
    `SELECT a.id, a.provider_id, a.operatory_id, a.patient_id, a.start_time, a.end_time FROM real_appointments a WHERE a.practice_id = ? AND a.start_time >= ? AND a.start_time < ? AND a.status NOT IN ('cancelled','no_show')${visitIds.length ? ` AND a.id NOT IN (${IN(visitIds)})` : ''}`,
    pid, `${date} 00:00`, `${date} 24:00`, ...visitIds,
  ) : [];
  const busy = hidden.map((a) => ({ id: a.id, provider_id: a.provider_id, operatory_id: a.operatory_id, patient_id: a.patient_id, s: toMin(a.start_time), e: toMin(a.end_time), status: 'scheduled' }));
  const blockouts = (await db.all('SELECT * FROM blockouts WHERE practice_id = ? AND start_time < ? AND end_time > ?', pid, `${date} 24:00`, `${date} 00:00`))
    .filter((b) => !(b.kind === 'reserved')) // reserved blocks take their own visit types: validateAppt decides those
    .map((b) => ({ provider_id: b.provider_id, operatory_id: b.operatory_id, s: b.start_time.slice(0, 10) < date ? 0 : toMin(b.start_time), e: b.end_time.slice(0, 10) > date ? 24 * 60 : toMin(b.end_time), reason: b.reason }));
  const reserved = (await db.all("SELECT * FROM blockouts WHERE practice_id = ? AND kind = 'reserved' AND start_time < ? AND end_time > ?", pid, `${date} 24:00`, `${date} 00:00`));
  // Perfect-day blocks kept for their visit types until released (and reserved blocks, the same way).
  const plans = await planDays(db, pid, date, date, await loadTemplates(db, pid));
  const kept = [];
  for (const p of providers) {
    const plan = plans.get(`${p.id}|${date}`);
    if (!plan) continue;
    for (const b of blocksOn(plan, date)) {
      if (!b.appointment_type_ids.length || now >= b.release_at) continue;
      kept.push({ provider_id: p.id, s: toMin(b.start_time), e: toMin(b.end_time), type_ids: b.appointment_type_ids, label: b.type_names.join(', ') || b.label, until: b.release_at.slice(0, 10) === date ? clock(toMin(b.release_at)) : b.release_at.slice(5, 10) });
    }
  }
  for (const b of reserved) {
    for (const p of providers.filter((x) => !b.provider_id || x.id === b.provider_id)) {
      kept.push({ provider_id: p.id, s: toMin(b.start_time), e: toMin(b.end_time), type_ids: parse(b.appointment_type_ids, []).map(Number), label: b.reason || 'reserved visits' });
    }
  }

  // Today's patients: their open treatment, priced.
  const liveVisits = visits.filter((v) => !INACTIVE.includes(v.status));
  const todayPts = ids(liveVisits.map((v) => ({ id: v.patient.id })));
  const provType = new Map(provRows.map((p) => [p.id, p.type]));
  const policyCache = new Map();
  const openTx = async (patientIds) => (patientIds.length ? db.all(
    `SELECT x.id, x.patient_id, x.code, x.description, x.tooth, x.area, x.fee, x.category, x.provider_id FROM real_procedures x
     LEFT JOIN real_appointments a ON a.id = x.appointment_id LEFT JOIN real_treatment_plans tp ON tp.id = x.treatment_plan_id
     WHERE x.practice_id = ? AND x.patient_id IN (${IN(patientIds)}) AND x.status = 'planned'
       AND (x.appointment_id IS NULL OR a.status IN ('cancelled','no_show')) AND (tp.id IS NULL OR tp.status != 'rejected') ORDER BY x.patient_id, x.id`, pid, ...patientIds,
  ) : []);
  const priced = async (rows) => {
    const out = [];
    for (const patientId of ids(rows, 'patient_id')) {
      const mine = rows.filter((r) => r.patient_id === patientId);
      const est = await collectibleFor(db, pid, patientId, mine, date, policyCache);
      mine.forEach((r, i) => out.push({ ...r, minutes: minutesOf(r), kind: workKind(r, provType.get(r.provider_id)), collectible: est[i]?.collectible ?? r.fee }));
    }
    return out;
  };
  const planned = await priced(await openTx(todayPts));

  // Opportunity-finder items (each visit's list, as the drawer shows it), less what was declined or added.
  const finder = [];
  if (withFinder && liveVisits.length) {
    const pc = await practiceContext(db, pid);
    const rules = pc.rules.filter((r) => !r.conditions.includes('unscheduled_treatment'));
    const events = visitIds.length ? await db.all(`SELECT appointment_id, rule_id, status FROM opportunity_events WHERE appointment_id IN (${IN(visitIds)})`, ...visitIds) : [];
    for (const v of liveVisits.filter((x) => x.status !== 'completed' && x.e > nowMin && x.here)) {
      const r = await evaluate(db, pc, { patientId: v.patient.id, appointment: { id: v.id, provider_id: v.provider_id, location_id: v.location_id }, date, estimate: true, rules });
      for (const o of r.opportunities) {
        if (events.some((e) => e.appointment_id === v.id && e.rule_id === o.rule_id && e.status !== 'offered')) continue;
        const minutes = o.targets.reduce((n, t) => n + minutesOf(t), 0);
        const collectible = o.coverage ? Math.max(0, (o.coverage.insurance || 0) + (o.coverage.patient || 0) - o.replaces.reduce((n, p) => n + p.fee, 0)) : o.added_fee;
        finder.push({ appointment_id: v.id, patient_id: v.patient.id, rule_id: o.rule_id, name: o.name, codes: o.codes, fee: o.added_fee, collectible: Math.min(collectible, o.added_fee), minutes, reason: o.reason, coverage: o.coverage });
      }
    }
  }

  // Recall visits: the recall type's visit type (length, provider, fee), else an hour with a hygienist.
  const rtypes = await recallTypes(db, pid);
  // Only recalls that are a visit of their own (not ones that ride along with a cleaning, like bitewings or fluoride).
  const visitRecall = (r) => { const rt = rtypes.find((t) => t.key === r.type); return !rt || (rt.active && !rt.bundle); };
  const recallVisit = async (r, patient) => {
    const rt = rtypes.find((t) => t.key === r.type) || { name: r.type, codes: [] };
    const t = rt.appointment_type_id ? types[rt.appointment_type_id] : null;
    const list = t?.procedure_codes ? parse(t.procedure_codes, []) : rt.codes.slice(0, 1);
    const procs = [];
    for (const c of list) {
      const pc = codes.get(c);
      if (pc && !pc.requires_tooth) procs.push({ code: pc.code, category: pc.category, fee: await officeFee(db, pid, pc, { patientId: patient.id }) });
    }
    const est = await collectibleFor(db, pid, patient.id, procs, date, policyCache);
    return {
      id: r.id, type: r.type, name: rt.name, due_date: r.due_date, type_id: t?.id ?? null, minutes: t ? t.duration : Math.max(60, procs.reduce((n, p) => n + minutesOf(p), 0)),
      kind: t?.provider_type ? kindOf(t.provider_type) : 'hygiene', fee: procs.reduce((n, p) => n + p.fee, 0), collectible: est.reduce((n, x) => n + x.collectible, 0),
      blocked: est.find((x) => x.blocked)?.blocked || null,
    };
  };
  const hasFuture = async (patientIds) => new Set(patientIds.length ? (await db.all(
    `SELECT DISTINCT patient_id FROM real_appointments appointments WHERE practice_id = ? AND patient_id IN (${IN(patientIds)}) AND start_time >= ? AND status NOT IN ('cancelled','no_show','completed')`, pid, ...patientIds, `${addDays(date, 1)} 00:00`,
  )).map((r) => r.patient_id) : []);

  // Households of today's patients.
  const heads = ids(liveVisits.map((v) => ({ id: v.patient.guarantor_id || v.patient.id })));
  const ps = patientScope(user, 'p');
  const members = heads.length ? (await db.all(
    `SELECT p.* FROM real_patients p WHERE p.practice_id = ? AND p.status = 'active' AND (p.guarantor_id IN (${IN(heads)}) OR p.id IN (${IN(heads)}))${ps.sql}`, pid, ...heads, ...heads, ...ps.args,
  )).filter((m) => !todayPts.includes(m.id)) : [];
  const family = [];
  if (members.length) {
    const mids = ids(members);
    const future = await hasFuture(mids);
    const recalls = await db.all(`SELECT * FROM real_recalls recalls WHERE practice_id = ? AND patient_id IN (${IN(mids)}) AND status IN ('due','contacted') AND due_date <= ? ORDER BY due_date`, pid, ...mids, date);
    const tx = await priced(await openTx(mids));
    for (const m of members) {
      const r = future.has(m.id) ? null : recalls.find((x) => x.patient_id === m.id && visitRecall(x));
      const mtx = tx.filter((t) => t.patient_id === m.id);
      if (!r && !mtx.length) continue;
      family.push({ patient: m, head_id: m.guarantor_id || m.id, recall: r ? await recallVisit(r, m) : null, planned: mtx });
    }
  }

  // The ASAP list (booked later, want sooner), the waitlist and recall-due patients.
  const loc = locationId ? ' AND (a.location_id = ? OR a.location_id IS NULL)' : '';
  const asapRows = await db.all(
    `SELECT a.*, p.first_name, p.last_name, p.preferred_name, pv.type AS provider_type FROM real_appointments a JOIN real_patients p ON p.id = a.patient_id JOIN providers pv ON pv.id = a.provider_id
     WHERE a.practice_id = ? AND a.asap = 1 AND a.status IN ('scheduled','confirmed') AND a.start_time >= ?${loc}${scope.sql} ORDER BY a.created_at, a.id LIMIT 50`,
    pid, `${addDays(date, 1)} 00:00`, ...(locationId ? [locationId] : []), ...scope.args,
  );
  const asapProcs = asapRows.length ? await db.all(`SELECT id, appointment_id, patient_id, code, fee, category, tooth FROM real_procedures procedures WHERE appointment_id IN (${IN(ids(asapRows))}) AND status != 'cancelled'`, ...ids(asapRows)) : [];
  const asap = [];
  for (const a of asapRows) {
    const mine = asapProcs.filter((x) => x.appointment_id === a.id);
    const est = await collectibleFor(db, pid, a.patient_id, mine, date, policyCache);
    asap.push({
      appointment_id: a.id, patient: { id: a.patient_id, first_name: a.first_name, last_name: a.last_name, preferred_name: a.preferred_name }, provider_id: a.provider_id, kind: kindOf(a.provider_type),
      minutes: toMin(a.end_time) - toMin(a.start_time), fee: mine.reduce((n, x) => n + x.fee, 0), collectible: est.reduce((n, x) => n + x.collectible, 0), from_time: friendlyDateTime(a.start_time), type_id: a.appointment_type_id,
    });
  }
  const wl = await db.all(
    `SELECT w.*, p.first_name, p.last_name, p.preferred_name FROM real_waitlist w JOIN real_patients p ON p.id = w.patient_id WHERE w.practice_id = ? AND w.status = 'waiting' AND p.status = 'active'${ps.sql} ORDER BY w.created_at, w.id LIMIT 50`,
    pid, ...ps.args,
  );
  const wlTx = await priced(await openTx(ids(wl, 'patient_id')));
  const waitlist = wl.map((w) => {
    // What they'd have done: their planned treatment that fits the time they asked for, else nothing priced yet.
    const fits = [];
    let used = 0;
    for (const t of wlTx.filter((x) => x.patient_id === w.patient_id)) if (used + t.minutes <= (w.duration || 60)) { fits.push(t); used += t.minutes; }
    const pv = provRows.find((p) => p.id === w.provider_id);
    return {
      waitlist_id: w.id, patient: { id: w.patient_id, first_name: w.first_name, last_name: w.last_name, preferred_name: w.preferred_name }, provider_id: w.provider_id, kind: pv ? kindOf(pv.type) : (fits[0]?.kind || null),
      days: parse(w.days, null), times: w.times, minutes: w.duration || 60, reason: w.reason, fee: fits.reduce((n, t) => n + t.fee, 0), collectible: fits.reduce((n, t) => n + t.collectible, 0), procedure_ids: fits.map((t) => t.id),
    };
  });
  const recallDue = [];
  const hygieneOpen = providers.some((p) => p.kind === 'hygiene');
  if (hygieneOpen) {
    const rows = await db.all(
      `SELECT r.*, p.first_name, p.last_name, p.preferred_name, p.dob, p.practice_id AS ppid FROM real_recalls r JOIN real_patients p ON p.id = r.patient_id
       WHERE r.practice_id = ? AND r.status IN ('due','contacted') AND r.due_date <= ? AND p.status = 'active'${locationId ? ' AND (p.location_id = ? OR p.location_id IS NULL)' : ''}${ps.sql}
       ORDER BY r.due_date DESC, r.id LIMIT 60`, pid, date, ...(locationId ? [locationId] : []), ...ps.args,
    );
    const future = await hasFuture(ids(rows, 'patient_id'));
    const seen = new Set([...todayPts, ...waitlist.map((w) => w.patient.id), ...asap.map((a) => a.patient.id), ...family.map((f) => f.patient.id)]);
    for (const r of rows) {
      if (future.has(r.patient_id) || seen.has(r.patient_id) || !visitRecall(r)) continue;
      seen.add(r.patient_id);
      const v = await recallVisit(r, { id: r.patient_id });
      recallDue.push({ recall_id: r.id, patient: { id: r.patient_id, first_name: r.first_name, last_name: r.last_name, preferred_name: r.preferred_name }, ...v, id: undefined });
      if (recallDue.length >= 30) break;
    }
  }

  // The predicted no-show risk of today's visits (one batch for the day).
  const noShow = Object.fromEntries([...(await noShowRisks(db, pid, apptRows, { now }))].map(([id, r]) => [id, forScreen(r)]));

  return {
    date, now, nowMin, practice: { id: pid, name: practice.name, timezone: practice.timezone, optimizer_ai: !!practice.optimizer_ai },
    providers, chairs, visits, busy, blockouts, kept, types, planned, finder, family, asap, waitlist, recallDue, noShow,
  };
}

// Checks each placement the engine proposes with the same function booking uses (validateAppt), so the database
// has the last word: a placement it refuses is shown as not fitting, with its reason.
export async function verifyPlacements(db, pid, day, opps) {
  for (const o of opps) {
    const a = o.action;
    if (!o.fits || !a) continue;
    let row = null;
    if (a.type === 'book' || a.type === 'text_offer') {
      row = { patient_id: a.patient_id, provider_id: a.provider_id, operatory_id: a.operatory_id, start_time: at(day.date, a.start), end_time: at(day.date, a.end), status: 'scheduled', appointment_type_id: a.appointment_type_id ?? null };
    } else if (a.type === 'move_up') {
      const cur = await db.get('SELECT * FROM appointments WHERE id = ? AND practice_id = ?', a.appointment_id, pid);
      if (cur) row = { ...cur, provider_id: a.provider_id, operatory_id: a.operatory_id, start_time: at(day.date, a.start), end_time: at(day.date, a.end) };
    } else if ((a.type === 'attach' || a.type === 'finder_add') && a.end) {
      const cur = await db.get('SELECT * FROM appointments WHERE id = ? AND practice_id = ?', a.appointment_id, pid);
      if (cur) row = { ...cur, end_time: at(day.date, a.end) };
    }
    if (!row) continue;
    try {
      await validateAppt(db, pid, { ...row });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      o.fits = false;
      o.why_not = err.message.replace(/^Scheduling conflict: /, 'Would clash: ');
    }
  }
  return opps;
}

// ---- Tracking: shown / accepted / declined / done, with $ captured ----
// The table and column this module needs (the lines to add to db.js: the table in SCHEMA, the column in COLUMNS).
export const OPTIMIZER_SCHEMA = `CREATE TABLE IF NOT EXISTS optimizer_suggestions (
  id INTEGER PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id),
  location_id INTEGER REFERENCES locations(id),
  date TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT,
  patient_id INTEGER REFERENCES patients(id),
  provider_id INTEGER REFERENCES providers(id),
  appointment_id INTEGER REFERENCES appointments(id),
  title TEXT,
  fee INTEGER NOT NULL DEFAULT 0,
  collectible INTEGER NOT NULL DEFAULT 0,
  minutes INTEGER NOT NULL DEFAULT 0,
  in_plan INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown','accepted','done','declined','failed','undone')),
  times_shown INTEGER NOT NULL DEFAULT 1,
  result TEXT,
  reason TEXT,
  source TEXT,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (practice_id, date, key)
);`;
export const OPTIMIZER_COLUMNS = [['practices', 'optimizer_ai', 'INTEGER NOT NULL DEFAULT 0']];

// Records what was shown (one row per practice, day and opportunity; a tracking row, not audited) and returns the
// rows by key so the answer can say what was already accepted, declined or done.
export async function track(db, user, { date, locationId, opps }) {
  const pid = user.practice_id;
  const existing = new Map((await db.all('SELECT * FROM optimizer_suggestions WHERE practice_id = ? AND date = ?', pid, date)).map((r) => [r.key, r]));
  for (const o of opps) {
    if (!o.fits && !existing.has(o.key)) continue; // only what could be acted on is tracked
    const row = existing.get(o.key);
    if (!row) {
      await db.run(
        `INSERT INTO optimizer_suggestions (practice_id, location_id, date, key, kind, action, patient_id, provider_id, appointment_id, title, fee, collectible, minutes, in_plan, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (practice_id, date, key) DO NOTHING`,
        pid, locationId ?? null, date, o.key, o.kind, o.action?.type ?? null, o.patient?.id ?? null, o.provider_id ?? null, o.appointment_id ?? null, String(o.title).slice(0, 300),
        o.fee || 0, o.collectible || 0, o.minutes || 0, o.in_plan ? 1 : 0, user.id,
      );
    } else if (row.status === 'shown' && (row.fee !== (o.fee || 0) || row.in_plan !== (o.in_plan ? 1 : 0))) {
      await db.run("UPDATE optimizer_suggestions SET fee = ?, collectible = ?, minutes = ?, in_plan = ?, title = ?, times_shown = times_shown + 1, updated_at = datetime('now') WHERE id = ?",
        o.fee || 0, o.collectible || 0, o.minutes || 0, o.in_plan ? 1 : 0, String(o.title).slice(0, 300), row.id);
    }
  }
  return new Map((await db.all('SELECT * FROM optimizer_suggestions WHERE practice_id = ? AND date = ?', pid, date)).map((r) => [r.key, r]));
}

// Text offers are "done" when the patient took the time (fill.js books it on their YES).
export async function settleOffers(db, pid, date) {
  for (const r of await db.all("SELECT id, result FROM optimizer_suggestions WHERE practice_id = ? AND date = ? AND status = 'accepted' AND action = 'text_offer'", pid, date)) {
    const offer = parse(r.result, {}).fill_offer_id;
    if (!offer) continue;
    const o = await db.get('SELECT status, filled_appointment_id FROM fill_offers WHERE id = ? AND practice_id = ?', offer, pid);
    if (o?.status === 'filled') await db.run("UPDATE optimizer_suggestions SET status = 'done', done_at = datetime('now'), updated_at = datetime('now'), result = ? WHERE id = ? AND status = 'accepted'", JSON.stringify({ ...parse(r.result, {}), appointment_id: o.filled_appointment_id }), r.id);
  }
}

// $ captured: what was accepted and done, per day and per person.
export async function captured(db, pid, { from, to, locationId = null }) {
  const loc = locationId ? ' AND (s.location_id = ? OR s.location_id IS NULL)' : '';
  const args = [pid, from, to, ...(locationId ? [locationId] : [])];
  const byDay = await db.all(
    `SELECT s.date, COUNT(*) AS shown, SUM(CASE WHEN s.status IN ('accepted','done') THEN 1 ELSE 0 END) AS accepted, SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN s.status = 'declined' THEN 1 ELSE 0 END) AS declined, SUM(CASE WHEN s.status = 'done' THEN s.fee ELSE 0 END) AS fee, SUM(CASE WHEN s.status = 'done' THEN s.collectible ELSE 0 END) AS collectible
     FROM optimizer_suggestions s WHERE s.practice_id = ? AND s.date >= ? AND s.date <= ?${loc} GROUP BY s.date ORDER BY s.date`, ...args,
  );
  const byPerson = await db.all(
    `SELECT s.updated_by AS user_id, u.name, SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN s.status = 'done' THEN s.fee ELSE 0 END) AS fee, SUM(CASE WHEN s.status = 'declined' THEN 1 ELSE 0 END) AS declined
     FROM optimizer_suggestions s LEFT JOIN users u ON u.id = s.updated_by WHERE s.practice_id = ? AND s.date >= ? AND s.date <= ?${loc} AND s.updated_by IS NOT NULL GROUP BY s.updated_by, u.name ORDER BY fee DESC`, ...args,
  );
  const n = (v) => Number(v) || 0;
  return {
    by_day: byDay.map((r) => ({ date: r.date, shown: n(r.shown), accepted: n(r.accepted), done: n(r.done), declined: n(r.declined), fee: n(r.fee), collectible: n(r.collectible) })),
    by_person: byPerson.map((r) => ({ user_id: r.user_id, name: r.name, done: n(r.done), fee: n(r.fee), declined: n(r.declined) })),
  };
}

// For the morning huddle email: the plan in a few lines (first name and last initial only; with names: false, none).
const KIND_WORDS = { treatment: 'Planned treatment for a patient on the schedule', finder: 'Extra care due for a patient on the schedule', family: 'A family member coming along', fill: 'An open time offered', shorten: 'A visit shortened to free time' };
export async function huddlePlan(db, { practiceId, date, locationId = null, providerId = null, names = true }) {
  const user = { id: null, practice_id: practiceId, role: 'admin', location_ids: null };
  const day = await loadDay(db, user, { date, locationId });
  if (providerId) day.providers = day.providers.filter((p) => p.id === providerId);
  const opps = await verifyPlacements(db, practiceId, day, generate(day));
  const plan = solve(day, opps);
  const byKey = new Map(opps.map((o) => [o.key, o]));
  return {
    headline: plan.headline,
    providers: plan.providers.filter((p) => p.goal || p.moves.length).map((p) => ({ ...p, items: p.moves.map((k) => byKey.get(k)).filter(Boolean).map((o) => `${names ? o.title : KIND_WORDS[o.kind] || 'A move'} — ${dollars(o.fee)}`) })),
    confirm: opps.filter((o) => o.kind === 'confirm').length,
  };
}
