// Metric emails (docs/metrics.md, "Emails"): the morning huddle, end of day, weekly and monthly digests. Each is
// built from the one set of KPI definitions (metrics.js), compared with the period before, the same dates last
// year and the goal, and ends with the two or three areas that most need work, each with the list behind it
// (first name and last initial only) and a link into the app. An optional AI summary, clearly labelled, is
// written from the aggregate numbers alone (never a patient's details), off unless the practice turns it on.
//
// runDigests (every few minutes) sends what's due in each practice's own time zone. Each send claims its
// (subscription, period) row first — a restart or a second server can't send the same digest twice — and a
// failure becomes a Needs attention item that the next successful send resolves.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { localNow, audit } from './util.js';
import { withActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { log } from './monitoring.js';
import { hoursFor, weekday } from './hours.js';
import { aiClient, structured } from './ai.js';
import { METRICS, compareMetrics, computeMetrics, metricRows, recordSnapshots, addDays, diagnosisRunning } from './metrics.js';
import { diagnosisFunnel } from './diagnosis.js';
import { renderEmail } from './email/layout.js';
import { sendStaffEmail } from './email/send.js';
import { shortName } from './email/templates.js';
import { benchmarkDigestBlocks } from './benchmarkdigest.js';

export const DIGESTS = {
  huddle: { label: 'Morning huddle', time: '07:00', when: 'Each morning the office is open' },
  end_of_day: { label: 'End of day', time: '18:00', when: 'Each evening the office was open' },
  weekly: { label: 'Weekly summary', time: '07:00', when: 'Monday morning, for the week before' },
  monthly: { label: 'Monthly summary', time: '07:00', when: 'The 1st of the month, for the month before' },
};
export const AUDIENCES = { owner: 'Owner', office_manager: 'Office manager', hygienist: 'Hygienist', billing: 'Billing' };
export const defaultAudience = (role) => ({ admin: 'owner', dentist: 'owner', hygienist: 'hygienist', billing: 'billing' })[role] || 'office_manager';
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// What each digest shows, per audience.
const PERIOD_ALL = ['production_gross', 'production_net', 'collections', 'collection_rate', 'new_patients', 'case_acceptance', 'diagnosed', 'hygiene_reappointment', 'broken_rate', 'unscheduled_treatment', 'recall_overdue', 'ar_over_90', 'claims_over_30'];
export const CONTENT = {
  huddle: {
    owner: ['scheduled_production', 'visits', 'open_gaps', 'unconfirmed', 'insurance_to_verify', 'balances_due'],
    office_manager: ['scheduled_production', 'visits', 'open_gaps', 'unconfirmed', 'insurance_to_verify', 'balances_due'],
    hygienist: ['scheduled_production', 'visits', 'open_gaps', 'unconfirmed', 'recall_overdue'],
    billing: ['visits', 'insurance_to_verify', 'balances_due', 'claims_over_30', 'scheduled_production'],
  },
  end_of_day: {
    owner: ['production_gross', 'collections', 'new_patients', 'case_acceptance', 'diagnosed', 'broken_appointments'],
    office_manager: ['production_gross', 'collections', 'new_patients', 'case_acceptance', 'diagnosed', 'broken_appointments'],
    hygienist: ['production_gross', 'hygiene_reappointment', 'broken_appointments', 'recall_overdue'],
    billing: ['production_gross', 'collections', 'collection_rate', 'claims_over_30', 'ar_over_90'],
  },
  weekly: {
    owner: PERIOD_ALL, office_manager: PERIOD_ALL,
    hygienist: ['production_gross', 'hygiene_reappointment', 'broken_rate', 'recall_overdue', 'recall_current_rate', 'unscheduled_treatment', 'diagnosed'],
    billing: ['production_net', 'collections', 'collection_rate', 'adjustments', 'ar_total', 'ar_over_90', 'claims_over_30'],
  },
};
CONTENT.monthly = CONTENT.weekly;

// ---- Dates ----
const monthName = (d) => new Date(`${d.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekdayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

// The dates a digest sent on `date` covers, and the period it's compared with.
export function digestRange(digest, date) {
  if (digest === 'weekly') {
    const monday = addDays(date, -((weekday(date) + 6) % 7));
    const from = addDays(monday, -7);
    return { from, to: addDays(monday, -1), previous: { from: addDays(from, -7), to: addDays(from, -1) }, vs: 'the week before', name: `Week of ${shortDay(from)}` };
  }
  if (digest === 'monthly') {
    const to = addDays(`${date.slice(0, 7)}-01`, -1);
    const from = `${to.slice(0, 7)}-01`;
    const pEnd = addDays(from, -1);
    return { from, to, previous: { from: `${pEnd.slice(0, 7)}-01`, to: pEnd }, vs: monthName(pEnd).split(' ')[0], name: monthName(from) };
  }
  // A day: compared with the same weekday a week earlier (yesterday may have been a Sunday).
  return { from: date, to: date, previous: { from: addDays(date, -7), to: addDays(date, -7) }, vs: `last ${weekdayName(date)}`, name: dayName(date) };
}

// Whether a subscription is due now (practice-local 'YYYY-MM-DD HH:MM'), and which period it's for. Only on the
// day itself: a server that was down all day doesn't send yesterday's huddle this evening.
export function dueFor(sub, office, local) {
  const today = local.slice(0, 10);
  if (local.slice(11, 16) < (sub.send_time || DIGESTS[sub.digest]?.time || '07:00')) return null;
  switch (sub.digest) {
    case 'huddle':
    case 'end_of_day':
      return hoursFor(office, today).length ? { periodKey: `${sub.digest}:${today}`, date: today } : null;
    case 'weekly':
      return weekday(today) === 1 ? { periodKey: `weekly:${addDays(today, -7)}`, date: today } : null;
    case 'monthly':
      return today.endsWith('-01') ? { periodKey: `monthly:${addDays(today, -1).slice(0, 7)}`, date: today } : null;
    default:
      return null;
  }
}

// ---- One-click unsubscribe links (signed, so the link itself is the proof) ----
const sig = (secret, id) => createHmac('sha256', `${secret}:digest-unsubscribe`).update(String(id)).digest('base64url').slice(0, 32);
export const unsubscribeToken = (secret, id) => `${id}.${sig(secret, id)}`;
export function verifyUnsubscribeToken(secret, token) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const want = Buffer.from(sig(secret, m[1]));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? Number(m[1]) : null;
}
export const unsubscribeUrl = (appUrl, secret, id) => `${String(appUrl || '').replace(/\/$/, '')}/api/public/digests/unsubscribe/${unsubscribeToken(secret, id)}`;

// ---- Formatting ----
const dollars = (c) => `${c < 0 ? '-' : ''}$${Math.round(Math.abs(c) / 100).toLocaleString('en-US')}`;
export function fmt(key, v) {
  if (v == null) return '—';
  const unit = METRICS[key].unit;
  if (unit === 'money') return dollars(v);
  if (unit === 'percent') return `${Math.round(v * 10) / 10}%`;
  return Number(v).toLocaleString('en-US');
}
// "▲ 12% vs last week" (percent metrics move in points).
function changeText(m, before, vs) {
  if (m.value == null || before == null) return null;
  if (METRICS[m.key].unit === 'percent') {
    const d = Math.round((m.value - before) * 10) / 10;
    return d === 0 ? `No change vs ${vs}` : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} pts vs ${vs}`;
  }
  if (before === 0) return m.value === 0 ? `No change vs ${vs}` : `${m.value > 0 ? '▲' : '▼'} from ${fmt(m.key, before)} ${vs}`;
  const p = Math.round(((m.value - before) / Math.abs(before)) * 100);
  return p === 0 ? `No change vs ${vs}` : `${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% vs ${vs}`;
}
const direction = (m, before) => {
  if (m.value == null || before == null || m.value === before || m.better === 'neutral') return null;
  return (m.value > before) === (m.better === 'higher');
};
function goalText(m) {
  if (m.goal == null) return null;
  const label = m.goal_source === 'benchmark' ? 'benchmark' : 'goal';
  if (METRICS[m.key].unit === 'money' && m.goal > 0 && m.value != null) return `${Math.round((m.value / m.goal) * 100)}% of ${dollars(m.goal)} ${label}`;
  return `${label} ${m.better === 'lower' ? '≤' : '≥'} ${fmt(m.key, m.goal)}`;
}

// ---- Areas for improvement ----
// How far a metric is from its goal (as a share of the goal) or how much it moved the wrong way since the
// period before; the worst two or three become the areas to work on.
export function scoreMetric(m, ctx = {}) {
  if (m.value == null || m.better === 'neutral') return null;
  // Today's schedule: visits still to confirm or insurance still to check, as a share of the day's visits.
  if (['unconfirmed', 'insurance_to_verify'].includes(m.key)) {
    const score = m.value / Math.max(1, ctx.visits || 0);
    return m.value > 0 && score > 0.05 ? { score: Math.min(1, score), why: 'today' } : null;
  }
  if (m.key === 'open_gaps') return m.value > 0 ? { score: Math.min(1, 0.1 * m.value), why: 'today' } : null;
  let gap = 0;
  if (m.goal != null && m.goal > 0) gap = m.better === 'higher' ? (m.goal - m.value) / m.goal : (m.value - m.goal) / m.goal;
  let trend = 0;
  // Small counts swing by chance (one new patient instead of two is "down 50%"): a trend needs five or more.
  const bigEnough = METRICS[m.key].unit !== 'count' || Math.max(m.value, m.previous ?? 0) >= 5;
  if (m.previous != null && m.previous !== 0 && bigEnough) {
    const moved = METRICS[m.key].unit === 'percent' ? (m.value - m.previous) / 100 : (m.value - m.previous) / Math.abs(m.previous);
    trend = m.better === 'higher' ? -moved : moved;
  }
  const score = Math.max(gap, trend * 0.8);
  if (score <= 0.05) return null;
  return { score, why: gap >= trend * 0.8 ? 'goal' : 'trend' };
}

function headline(m, why, vs) {
  const unit = METRICS[m.key].unit;
  if (why === 'today') {
    if (m.key === 'open_gaps') return `${m.value} open gap${m.value === 1 ? '' : 's'} of 30 minutes or more on the schedule (${m.parts?.minutes ?? 0} minutes in all).`;
    return `${m.value} ${m.key === 'unconfirmed' ? `visit${m.value === 1 ? '' : 's'} still to confirm` : `patient${m.value === 1 ? '' : 's'} whose insurance hasn’t been checked in 30 days`}.`;
  }
  if (why === 'goal') {
    if (unit === 'percent') {
      const pts = Math.round(Math.abs(m.goal - m.value) * 10) / 10;
      return `${m.label} is ${fmt(m.key, m.value)} — ${pts} points ${m.better === 'higher' ? 'under' : 'over'} the ${m.goal_source === 'benchmark' ? 'usual benchmark' : 'goal'} of ${fmt(m.key, m.goal)}.`;
    }
    return `${m.label} is ${fmt(m.key, m.value)} against a ${m.goal_source === 'benchmark' ? 'benchmark' : 'goal'} of ${fmt(m.key, m.goal)}.`;
  }
  if (unit === 'percent') return `${m.label} is ${fmt(m.key, m.value)}, ${m.value > m.previous ? 'up' : 'down'} ${Math.round(Math.abs(m.value - m.previous) * 10) / 10} points vs ${vs} (was ${fmt(m.key, m.previous)}).`;
  const p = Math.round(Math.abs((m.value - m.previous) / m.previous) * 100);
  return `${m.label} is ${m.value > m.previous ? 'up' : 'down'} ${p}% vs ${vs} (${fmt(m.key, m.value)}, was ${fmt(m.key, m.previous)}).`;
}

const gapText = (r, days) => `${days > 1 ? `${shortDay(r.date)} · ` : ''}${r.provider_name} · ${r.start}–${r.end} (${r.minutes} min)`;

// The list behind each area: who to call, which claims to chase. `names`: 'short' (emails: "Jane D.") or 'full'.
const ACTIONS = {
  hygiene_reappointment: { rows: 'hygiene_reappointment', title: 'Hygiene patients who left without their next visit — call to book', filter: (r) => !r.reappointed, tip: 'Book the next cleaning before the patient leaves the chair.' },
  broken_rate: { rows: 'broken_appointments', title: 'Missed visits not rebooked yet', filter: (r) => !r.rebooked_for, tip: 'Call the same day a visit is missed, while it’s easy to rebook.' },
  broken_appointments: { rows: 'broken_appointments', title: 'Missed visits not rebooked yet', filter: (r) => !r.rebooked_for, tip: 'Confirm visits two days ahead and keep an ASAP list to fill gaps.' },
  unscheduled_treatment: { rows: 'unscheduled_treatment', title: 'Patients with treatment to schedule', item: (r, n) => `${n(r)} · ${r.procedures} procedure${Number(r.procedures) === 1 ? '' : 's'}`, tip: 'Schedule treatment at checkout, while the patient is still here.' },
  case_acceptance: { rows: 'case_acceptance', title: 'Treatment plans still waiting for a yes', filter: (r) => r.status === 'proposed', tip: 'Follow up on presented plans within a few days, with the financing options.' },
  production_gross: { rows: 'unscheduled_treatment', title: 'Patients with treatment to schedule', item: (r, n) => `${n(r)} · ${r.procedures} procedure${Number(r.procedures) === 1 ? '' : 's'}`, tip: 'Unscheduled treatment and open gaps are the quickest production to recover.' },
  production_net: { rows: 'unscheduled_treatment', title: 'Patients with treatment to schedule', item: (r, n) => `${n(r)} · ${r.procedures} procedure${Number(r.procedures) === 1 ? '' : 's'}` },
  collections: { rows: 'claims_over_30', title: 'Claims to chase (waiting over 30 days)', item: (r, n) => `Claim #${r.claim_id} · ${n(r)} · waiting ${r.days} days`, tip: 'Collect the patient’s portion at checkout and chase claims past 30 days.' },
  collection_rate: { rows: 'claims_over_30', title: 'Claims to chase (waiting over 30 days)', item: (r, n) => `Claim #${r.claim_id} · ${n(r)} · waiting ${r.days} days`, tip: 'Collections are lagging production: chase open claims and collect at checkout.' },
  claims_over_30: { rows: 'claims_over_30', title: 'Claims to chase', item: (r, n) => `Claim #${r.claim_id} · ${n(r)} · waiting ${r.days} days` },
  ar_over_90: { rows: 'ar_over_90', title: 'Accounts over 90 days', tip: 'Call before sending to collections; offer a payment plan.' },
  ar_total: { rows: 'ar_over_90', title: 'Accounts over 90 days' },
  recall_overdue: { rows: 'recall_overdue', title: 'Patients overdue for their checkup', tip: 'A recall text campaign brings back most overdue patients.' },
  recall_current_rate: { rows: 'recall_overdue', title: 'Patients overdue for their checkup' },
  unconfirmed: { rows: 'unconfirmed', title: 'Visits still to confirm' },
  insurance_to_verify: { rows: 'insurance_to_verify', title: 'Insurance to check before the visit' },
  open_gaps: { rows: 'open_gaps', title: 'Open time on the schedule', item: (r, n, days) => gapText(r, days), tip: 'Offer open times to the ASAP list.' },
  scheduled_production: { rows: 'open_gaps', title: 'Open time on the schedule', item: (r, n, days) => gapText(r, days), tip: 'Fill gaps from the ASAP list and unscheduled treatment.' },
  new_patients: { tip: 'Ask happy patients for reviews and referrals; check where new patients came from.' },
  diagnosed: { rows: 'unscheduled_treatment', title: 'Patients with treatment to schedule', item: (r, n) => `${n(r)} · ${r.procedures} procedure${Number(r.procedures) === 1 ? '' : 's'}`, tip: 'Chart what you find during each exam the same day, so it counts and can be presented before the patient leaves.' },
};

// ---- Diagnosis & conversion (DX1–DX2) in the emails: totals only, never a patient ----
// End of day: diagnosed today / this week / this month per provider against their goal. Weekly and monthly: the
// funnel for the exams in the period, by exam type and by provider.
const pctText = (v) => (v == null ? '—' : `${Math.round(v)}%`);
export async function diagnosisBlocks(db, o) {
  const blocks = [];
  const scope = { providerId: o.providerId || null, locationId: o.locationId || null };
  const link = `${String(o.appUrl || '').replace(/\/$/, '')}/metrics?tab=diagnosis`;
  if (o.digest === 'end_of_day') {
    const run = await diagnosisRunning(db, o.practiceId, { today: o.date, ...scope, perProvider: !scope.providerId });
    const [day, week, month] = run.periods;
    blocks.push({ type: 'heading', text: 'Treatment diagnosed at exams' });
    const goal = month.goal ? ` — ${Math.round((month.diagnosed / month.goal) * 100)}% of the ${dollars(month.goal)} goal so far` : '';
    blocks.push({ type: 'text', text: `Today ${dollars(day.diagnosed)} from ${day.exams} exam${day.exams === 1 ? '' : 's'} · this week ${dollars(week.diagnosed)} · this month ${dollars(month.diagnosed)}${goal}.` });
    const items = (run.providers || []).filter((p) => p.month.exams).map((p) => `${p.name}: today ${dollars(p.today.diagnosed)} · week ${dollars(p.week.diagnosed)} · month ${dollars(p.month.diagnosed)}${p.month_goal ? ` of ${dollars(p.month_goal)}` : ''}`);
    if (items.length) blocks.push({ type: 'list', title: 'By provider', items: items.slice(0, 12), more: items.length > 12 ? `…and ${items.length - 12} more in Dental Machine.` : null });
    return blocks;
  }
  if (o.digest !== 'weekly' && o.digest !== 'monthly') return blocks;
  const f = await diagnosisFunnel(db, o.practiceId, { from: o.from, to: o.to, ...scope });
  if (!f.totals.exams) return blocks;
  const t = f.totals;
  blocks.push({ type: 'heading', text: 'Diagnosis & conversion' });
  blocks.push({ type: 'text', text: `${t.exams} exam${t.exams === 1 ? '' : 's'}, ${dollars(t.diagnosed)} of treatment diagnosed (${dollars(t.per_exam || 0)} per exam). So far ${pctText(t.of_diagnosed_pct.accepted)} accepted, ${pctText(t.of_diagnosed_pct.scheduled)} scheduled and ${pctText(t.of_diagnosed_pct.completed)} completed; ${dollars(t.still_open)} still to do.` });
  const types = f.by_exam_type.filter((x) => x.exams).map((x) => `${x.label}: ${x.exams} · ${dollars(x.diagnosed)} diagnosed · ${pctText(x.of_diagnosed_pct.scheduled)} scheduled · ${pctText(x.of_diagnosed_pct.completed)} completed${x.median_days_to_schedule != null ? ` · booked in ${x.median_days_to_schedule} days (median)` : ''}`);
  if (types.length) blocks.push({ type: 'list', title: 'By exam type', items: types });
  if (!scope.providerId) {
    const provs = f.providers.filter((p) => p.total.exams).map((p) => `${p.name}: ${p.total.exams} exam${p.total.exams === 1 ? '' : 's'} · ${dollars(p.total.diagnosed)} diagnosed (${dollars(p.total.per_exam || 0)} per exam) · ${pctText(p.total.of_diagnosed_pct.scheduled)} scheduled`);
    if (provs.length) blocks.push({ type: 'list', title: 'By provider', items: provs.slice(0, 12), more: provs.length > 12 ? `…and ${provs.length - 12} more in Dental Machine.` : null });
  }
  blocks.push({ type: 'text', text: 'Work finished later still counts for the exam where it was found, so these numbers keep growing after the period ends.', muted: true });
  blocks.push({ type: 'button', text: 'See diagnosis & conversion', url: link });
  return blocks;
}

export async function areasForImprovement(db, pid, cmp, { o, appUrl = '', max = 3, names = 'short', vs = 'the period before', listSize = 8 }) {
  const visits = cmp.metrics.find((m) => m.key === 'visits')?.value || 0;
  const scored = cmp.metrics.map((m) => ({ m, s: scoreMetric(m, { visits }) })).filter((x) => x.s).sort((a, b) => b.s.score - a.s.score);
  const out = [];
  const usedLists = new Set();
  const nameOf = names === 'full' ? (r) => `${r.first_name} ${r.last_name}` : (r) => shortName(r);
  for (const { m, s } of scored) {
    if (out.length >= max) break;
    // A schedule that's already in the past can't be worked on.
    if (METRICS[m.key].kind === 'schedule' && cmp.to < o.today) continue;
    const action = ACTIONS[m.key] || {};
    let items = [];
    let count = 0;
    if (action.rows && !usedLists.has(action.rows)) {
      usedLists.add(action.rows);
      const res = await metricRows(db, pid, action.rows, { ...o, from: cmp.from, to: cmp.to }, { limit: 2000 });
      const rows = (res?.rows || []).filter(action.filter || (() => true));
      count = rows.length;
      const days = Math.round((Date.parse(cmp.to) - Date.parse(cmp.from)) / 86400_000) + 1;
      items = rows.slice(0, listSize).map((r) => (action.item ? action.item(r, nameOf, days) : nameOf(r)));
    }
    const q = new URLSearchParams({ metric: action.rows || m.key, from: cmp.from, to: cmp.to, ...(o.providerId ? { provider_id: String(o.providerId) } : {}), ...(o.locationId ? { location_id: String(o.locationId) } : {}) });
    out.push({
      metric: m.key, label: m.label, score: Math.round(s.score * 1000) / 1000, why: s.why, headline: headline(m, s.why, vs), tip: action.tip || null,
      list_title: items.length ? action.title : null, items, count, more: Math.max(0, count - items.length),
      link: `${String(appUrl || '').replace(/\/$/, '')}/metrics?${q}`,
    });
  }
  return out;
}

// ---- AI summary (optional, labelled, aggregate numbers only) ----
// DIGEST_AI=sandbox (or config.digestAi) gives fixed text for demos and tests; otherwise the practice's AI key.
export function aiMode(config = {}) {
  const want = config.digestAi ?? process.env.DIGEST_AI;
  if (want === 'off') return null;
  if (want === 'sandbox') return 'sandbox';
  return aiClient(config) ? 'live' : null;
}

// Only labels, formatted totals, goals and changes go to the model — no names, no rows.
export function aiInput(digestLabel, period, cmp, areas) {
  return [
    `${digestLabel} for ${period}.`,
    ...cmp.metrics.filter((m) => m.value != null).map((m) => `${m.label}: ${fmt(m.key, m.value)}${m.previous != null ? `; before: ${fmt(m.key, m.previous)}` : ''}${m.goal != null ? `; ${m.goal_source === 'benchmark' ? 'benchmark' : 'goal'}: ${fmt(m.key, m.goal)}` : ''}`),
    ...(areas.length ? ['Areas flagged:', ...areas.map((a) => `- ${a.label}${a.count ? ` (${a.count} on the list)` : ''}`)] : []),
  ].join('\n');
}

export async function aiSummary(config, { digestLabel, period, cmp, areas }) {
  const mode = aiMode(config);
  if (!mode) return null;
  if (mode === 'sandbox') {
    const top = areas[0];
    const prod = cmp.metrics.find((m) => ['production_gross', 'scheduled_production'].includes(m.key));
    return {
      sandbox: true,
      text: `Sample summary (AI sandbox): ${prod ? `${prod.label.toLowerCase()} was ${fmt(prod.key, prod.value)}` : `${cmp.metrics.length} numbers were checked`}.${top ? ` The area most worth attention is ${top.label.toLowerCase()}.` : ' Nothing stands out as off track.'}`,
    };
  }
  const out = await structured(config, {
    system: 'You write two or three short, plain sentences for a dental office team summarising their numbers: what went well, what needs attention, one practical next step. Friendly, specific, no jargon, no invented numbers, no patient names (you are given none). Use only the numbers provided.',
    content: aiInput(digestLabel, period, cmp, areas),
    tool: { name: 'summary', description: 'The summary for the email.', input_schema: { type: 'object', properties: { summary: { type: 'string', description: 'Two or three plain sentences.' } }, required: ['summary'] } },
    effort: 'low', maxTokens: 1500,
  });
  const text = String(out.summary || out.text || '').trim().slice(0, 800);
  return text ? { sandbox: false, text } : null;
}

// ---- Building a digest ----
export const digestSettings = (practice) => {
  // names: whether lists show "Jane D." (true) or only counts (false, for providers without a BAA).
  try { return { ai_summary: false, names: true, ...JSON.parse(practice?.digest_settings || '{}') }; } catch { return { ai_summary: false, names: true }; }
};

// Everything one email needs. o: { practiceId, digest, audience, date (the day it's sent, practice-local), today,
// locationId?, providerId?, appUrl, unsubscribeUrl?, config, withAi? }.
export async function buildDigest(db, o) {
  const practice = await db.get('SELECT * FROM practices WHERE id = ?', o.practiceId);
  const def = DIGESTS[o.digest];
  const range = digestRange(o.digest, o.date);
  const keys = CONTENT[o.digest][o.audience] || CONTENT[o.digest].owner;
  const scope = { providerId: o.providerId || null, locationId: o.locationId || null };
  const today = o.today || o.date;
  const cmp = await compareMetrics(db, o.practiceId, { from: range.from, to: range.to, today, previous: range.previous, keys, ...scope });
  const settings = digestSettings(practice);
  const areas = await areasForImprovement(db, o.practiceId, cmp, { o: { today, ...scope }, appUrl: o.appUrl, vs: range.vs });
  // Names switched off: keep the lists that name no patient (open times), otherwise just the count.
  if (!settings.names) for (const a of areas) if (!['open_gaps', 'scheduled_production'].includes(a.metric)) { a.items = []; a.more = 0; }
  const location = scope.locationId ? await db.get('SELECT name FROM locations WHERE id = ?', scope.locationId) : null;
  const provider = scope.providerId ? await db.get('SELECT name FROM providers WHERE id = ?', scope.providerId) : null;
  const forWho = [location?.name, provider?.name].filter(Boolean).join(' · ');

  let ai = null;
  let aiError = null;
  if (o.withAi && settings.ai_summary) {
    try {
      ai = await aiSummary(o.config || {}, { digestLabel: def.label, period: range.name, cmp, areas });
    } catch (err) {
      aiError = err.message || String(err);
    }
  }

  const tiles = cmp.metrics.map((m) => ({
    label: m.label, value: fmt(m.key, m.value), change: changeText(m, m.previous, range.vs), good: direction(m, m.previous),
    edge: m.standing ? ({ good: true, watch: 'watch', behind: false })[m.standing] : direction(m, m.previous),
    sub: [goalText(m), m.last_year != null && o.digest !== 'huddle' ? `last year ${fmt(m.key, m.last_year)}` : null].filter(Boolean).join(' · ') || null,
  }));
  const blocks = [];
  if (o.digest === 'huddle') blocks.push({ type: 'text', text: `Here’s today at ${practice.name}${forWho ? ` (${forWho})` : ''}.`, muted: true });
  else blocks.push({ type: 'text', text: `${range.name}${forWho ? ` · ${forWho}` : ''} — compared with ${range.vs} and the same dates last year.`, muted: true });
  if (ai) blocks.push({ type: 'callout', tone: 'ai', label: ai.sandbox ? 'Written by AI (sandbox)' : 'Written by AI', text: ai.text });
  blocks.push({ type: 'stats', items: tiles });

  if (o.digest === 'end_of_day') {
    // Tomorrow, so the evening email also sets up the morning.
    const tomorrow = addDays(range.to, 1);
    const { values } = await computeMetrics(db, o.practiceId, { from: tomorrow, to: tomorrow, today, keys: ['visits', 'scheduled_production', 'unconfirmed'], ...scope });
    blocks.push({ type: 'heading', text: `Tomorrow (${dayName(tomorrow)})` });
    blocks.push({ type: 'text', text: `${values.visits} visit${values.visits === 1 ? '' : 's'} booked, ${fmt('scheduled_production', values.scheduled_production)} scheduled, ${values.unconfirmed} still to confirm.` });
  }

  // Diagnosis totals and the conversion funnel for the people who act on them (not the billing team's email).
  if (['owner', 'office_manager', 'hygienist'].includes(o.audience) && o.digest !== 'huddle') {
    blocks.push(...await diagnosisBlocks(db, { practiceId: o.practiceId, digest: o.digest, date: range.to, from: range.from, to: range.to, ...scope, appUrl: o.appUrl }));
  }
  // Benchmarks (BM4): how each provider compares with practices like this one, when the owner has joined.
  if (o.digest === 'monthly' && ['owner', 'hygienist'].includes(o.audience)) {
    blocks.push(...await benchmarkDigestBlocks(db, { practiceId: o.practiceId, providerId: scope.providerId, appUrl: o.appUrl }));
  }

  if (areas.length) {
    blocks.push({ type: 'heading', text: areas.length === 1 ? 'One area to work on' : `${areas.length} areas to work on` });
    for (const a of areas) {
      blocks.push({ type: 'callout', tone: 'warn', title: a.label, text: [a.headline, a.tip].filter(Boolean).join(' ') });
      if (a.items.length) blocks.push({ type: 'list', title: `${a.list_title} (${a.count})`, items: a.items, more: a.more ? `…and ${a.more} more in Dental Machine.` : null });
      else if (a.count) blocks.push({ type: 'text', text: `${a.list_title}: ${a.count}. The list is in Dental Machine.` });
      blocks.push({ type: 'button', text: 'Open the list', url: a.link });
    }
  } else {
    blocks.push({ type: 'callout', tone: 'info', title: 'On track', text: 'Nothing is far from its goal or trending the wrong way. Nice work.' });
  }
  blocks.push({ type: 'button', text: 'See all the numbers', url: `${String(o.appUrl || '').replace(/\/$/, '')}/metrics?from=${range.from}&to=${range.to}` });

  const first = cmp.metrics[0];
  const subject = o.digest === 'huddle'
    ? `Today at ${practice.name}: ${fmt('visits', cmp.metrics.find((m) => m.key === 'visits')?.value ?? 0)} visits, ${fmt('scheduled_production', cmp.metrics.find((m) => m.key === 'scheduled_production')?.value ?? 0)} scheduled`
    : `${def.label} · ${range.name}: ${first ? `${first.label.toLowerCase()} ${fmt(first.key, first.value)}` : practice.name}`;
  const { html, text } = renderEmail({
    brand: practice.name, title: `${def.label} · ${range.name}`, preheader: areas[0]?.headline || 'Your numbers are on track.',
    blocks,
    footer: [
      `You get this ${def.label.toLowerCase()} email as ${(AUDIENCES[o.audience] || 'staff').toLowerCase()} at ${practice.name}.`,
      settings.names ? 'Names are shortened on purpose; open Dental Machine for the details.' : 'Patient names are left out; open Dental Machine for the lists.',
      ...(ai ? ['The summary marked “Written by AI” was written from the totals above only — no patient details were shared.'] : []),
    ],
    unsubscribeUrl: o.unsubscribeUrl || null,
  });
  return { subject: subject.slice(0, 200), html, text, areas, cmp, range, ai, aiError };
}

// ---- Sending ----
// Sends a subscription's digest for one period. Returns { status, message_id, error }.
export async function sendDigest(db, messenger, sub, { periodKey, date, today, config = {}, secret, test = false, userId = null }) {
  const pid = sub.practice_id;
  let send;
  if (test) {
    send = { id: (await db.run('INSERT INTO digest_sends (practice_id, subscription_id, period_key, created_by) VALUES (?, ?, ?, ?)', pid, sub.id, `test:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, userId)).id };
  } else {
    // Claim the period first. Already sent (or being sent) → nothing to do. A failed one is retried a few times.
    const ins = await db.run('INSERT INTO digest_sends (practice_id, subscription_id, period_key) VALUES (?, ?, ?) ON CONFLICT (subscription_id, period_key) DO NOTHING', pid, sub.id, periodKey);
    if (ins.changes) send = await db.get('SELECT id FROM digest_sends WHERE subscription_id = ? AND period_key = ?', sub.id, periodKey);
    else {
      const retry = await db.run("UPDATE digest_sends SET status = 'sending', attempts = attempts + 1, error = NULL WHERE subscription_id = ? AND period_key = ? AND status = 'failed' AND attempts < 3", sub.id, periodKey);
      if (!retry.changes) return { status: 'skipped' };
      send = await db.get('SELECT id FROM digest_sends WHERE subscription_id = ? AND period_key = ?', sub.id, periodKey);
    }
  }
  const issueKey = `digest:${sub.id}`;
  const label = DIGESTS[sub.digest].label;
  let result;
  let built = null;
  try {
    let providerId = sub.provider_id || null;
    if (!providerId && sub.audience === 'hygienist') providerId = (await db.get('SELECT id FROM providers WHERE practice_id = ? AND user_id = ? AND active = 1', pid, sub.user_id))?.id ?? null;
    built = await buildDigest(db, {
      practiceId: pid, digest: sub.digest, audience: sub.audience, date, today: today || date, locationId: sub.location_id, providerId,
      appUrl: config.appUrl, unsubscribeUrl: unsubscribeUrl(config.appUrl, secret, sub.id), config, withAi: true,
    });
    const link = unsubscribeUrl(config.appUrl, secret, sub.id);
    result = await sendStaffEmail(db, messenger, {
      practiceId: pid, to: sub.email, subject: test ? `[Test] ${built.subject}` : built.subject, html: built.html, text: built.text,
      kind: test ? 'digest_test' : 'digest', createdBy: userId,
      headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
  } catch (err) {
    result = { ok: false, error: String(err?.message || err).slice(0, 500) };
  }
  if (result.ok) {
    await db.run("UPDATE digest_sends SET status = 'sent', message_id = ?, sent_at = datetime('now'), ai_summary = ? WHERE id = ?", result.message.id, built?.ai ? 1 : 0, send.id);
    if (!test) await resolveIssue(db, pid, issueKey, 'Resolved: the next metric email went through');
  } else {
    await db.run("UPDATE digest_sends SET status = 'failed', message_id = ?, error = ? WHERE id = ?", result.message?.id ?? null, result.error, send.id);
    if (!test) {
      await raiseIssue(db, {
        practiceId: pid, kind: 'message', key: issueKey, role: 'admin', entity: 'digest_subscriptions', entityId: sub.id,
        title: `The ${label.toLowerCase()} email to ${sub.user_name || sub.email} didn't go`, detail: result.error,
      });
    }
  }
  // The AI summary is optional: when it fails the email goes without it, and someone is told.
  if (built?.aiError) await raiseIssue(db, { practiceId: pid, kind: 'ai', key: `digest-ai:${pid}`, role: 'admin', title: 'The AI summary for metric emails couldn’t be written', detail: built.aiError });
  else if (built?.ai && !built.ai.sandbox) await resolveIssue(db, pid, `digest-ai:${pid}`, 'Resolved: the AI summary worked on a later email');
  if (built?.ai) {
    // The AI's part is on record: which email, that it saw only totals.
    await audit(db, null, 'digest.ai_summary', 'digest_sends', send.id, { subscription_id: sub.id, digest: sub.digest, sandbox: built.ai.sandbox, input: 'aggregate numbers only' }, { source: 'ai', actor: built.ai.sandbox ? 'AI summary (sandbox)' : 'AI summary for metric emails', reason: 'Plain-language summary of the numbers in a metric email' });
  }
  return { status: result.ok ? 'sent' : 'failed', message_id: result.message?.id ?? null, error: result.ok ? null : result.error, send_id: send.id };
}

const SUBS_SQL = `SELECT s.*, u.email, u.name AS user_name, u.active AS user_active, u.practice_id AS user_practice
  FROM digest_subscriptions s JOIN users u ON u.id = s.user_id`;
export const subscriptionWithUser = (db, id) => db.get(`${SUBS_SQL} WHERE s.id = ?`, id);

// The job: every few minutes, each active subscription whose time has come in its practice's time zone. Also
// stores each practice's end-of-day snapshot (for trends of the "right now" numbers) once it's evening there.
export async function runDigests(db, messenger, { config = {}, secret, now = new Date() } = {}) {
  if (!secret) throw new Error('runDigests needs the app secret (for unsubscribe links)');
  let sent = 0;
  const practices = await db.all('SELECT id, timezone, office_hours FROM practices');
  for (const p of practices) {
    const local = localNow(p.timezone || 'America/New_York', now);
    if (local.slice(11, 13) >= '21') {
      const today = local.slice(0, 10);
      if (!(await db.get("SELECT id FROM metric_snapshots WHERE practice_id = ? AND snapshot_date = ? AND scope_key = 'practice'", p.id, today))) {
        await withActor({ source: 'automation', actor: 'Metric snapshots', practiceId: p.id }, () => recordSnapshots(db, p.id, today))
          .catch((err) => raiseIssue(db, { practiceId: p.id, kind: 'records', key: `metric-snapshot:${p.id}`, title: 'Today’s metric snapshot couldn’t be saved', detail: err.message }));
      }
    }
  }
  const subs = await db.all(`${SUBS_SQL} WHERE s.status = 'active' AND u.active = 1 AND u.practice_id = s.practice_id ORDER BY s.practice_id, s.id`);
  const byId = new Map(practices.map((p) => [p.id, p]));
  const offices = new Map((await db.all('SELECT id, office_hours FROM locations')).map((l) => [l.id, l]));
  for (const sub of subs) {
    const p = byId.get(sub.practice_id);
    if (!p) continue;
    const local = localNow(p.timezone || 'America/New_York', now);
    const loc = sub.location_id ? offices.get(sub.location_id) : null;
    const due = dueFor(sub, loc?.office_hours ? { office_hours: loc.office_hours } : p, local);
    if (!due) continue;
    try {
      const r = await withActor({ source: 'automation', actor: 'Metric emails', practiceId: p.id }, () => sendDigest(db, messenger, sub, { ...due, today: local.slice(0, 10), config, secret }));
      if (r.status === 'sent') sent++;
    } catch (err) {
      // Anything that escaped sendDigest (the claim itself failing): someone should still hear about it.
      log.error('Metric email failed', err, { subscription: sub.id });
      await raiseIssue(db, { practiceId: p.id, kind: 'message', key: `digest:${sub.id}`, role: 'admin', title: `The ${DIGESTS[sub.digest].label.toLowerCase()} email to ${sub.user_name} didn't go`, detail: err.message });
    }
  }
  await checkBounces(db);
  return sent;
}

// A digest that SendGrid reports as bounced: the address isn't working, so it's a Needs attention item until a
// later digest to that person is delivered.
async function checkBounces(db) {
  const since = new Date(Date.now() - 8 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const rows = await db.all(
    `SELECT ds.subscription_id, ds.practice_id, m.delivery, m.id AS message_id, u.name AS user_name, s.digest FROM digest_sends ds
     JOIN messages m ON m.id = ds.message_id JOIN digest_subscriptions s ON s.id = ds.subscription_id JOIN users u ON u.id = s.user_id
     WHERE ds.created_at >= ? AND m.delivery IN ('bounced','delivered') ORDER BY ds.id`, since,
  );
  const latest = new Map();
  for (const r of rows) latest.set(r.subscription_id, r);
  for (const r of latest.values()) {
    const key = `digest-bounce:${r.subscription_id}`;
    if (r.delivery === 'bounced') {
      // Once per bounced email (the job runs every few minutes; the same bounce isn't counted again).
      if (await db.get("SELECT id FROM issues WHERE practice_id = ? AND dedupe_key = ? AND entity = 'messages' AND entity_id = ?", r.practice_id, key, r.message_id)) continue;
      await raiseIssue(db, { practiceId: r.practice_id, kind: 'message', key, role: 'admin', entity: 'messages', entityId: r.message_id, title: `The ${DIGESTS[r.digest].label.toLowerCase()} email to ${r.user_name} bounced — check their email address` });
    } else await resolveIssue(db, r.practice_id, key, 'Resolved: a later metric email was delivered');
  }
}
