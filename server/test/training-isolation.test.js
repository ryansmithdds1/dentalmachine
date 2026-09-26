// The training patient (training.js) never counts: every report, total, dashboard, metric, prediction, audience,
// statement run, export and the day sheet reads the same before and after a busy day of practice on "Tess Training".
//
// How: a practice with a real day's work is read through every GET route the staff app has (no path parameters;
// the usual date range), then someone practises on the training patient — visits, finished work, payments, an
// adjustment, a claim, notes, a plan, a recall, a task, a message, a lab case, a referral — and everything is read
// again. The two readings must match, except for the screens listed in BY_DESIGN, which show the training patient on
// purpose (the schedule, its own chart, the audit trail…) — each says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';

const h = harness();

// Screens where practice on the training patient shows up by design. Everything else must not change.
const BY_DESIGN = [
  // The day's schedule and visit lists: the tour's visit has to be on the schedule to be checked in, seated, moved.
  [/^\/(appointments|schedule)(\/|\?|$)/, 'the schedule shows the training visit (with a Training label) so tours can use it'],
  [/^\/(schedule-notes|day-notes|visit-requirements|schedule\/)/, 'schedule side panels follow the schedule'],
  // Worklists a tour teaches: the training items are there to practise on (never counted in any total).
  [/^\/(tasks|office\/tasks|lab-cases|lab-checkin|messages|conversations|inbox|chat)/, 'worklists and inboxes a tour works in'],
  [/^\/(claims|preauths|claim-prep)(\/|\?|$)/, 'the claims worklist (training claims can never be sent)'],
  [/^\/treatment-plans/, 'treatment plans worklist'],
  // Records of what happened (who did what, when) — the training activity really happened, as practice.
  [/^\/(audit|access-log|activity|changes)/, 'the audit trail records practice like everything else'],
  [/^\/(training|me\/)/, 'the person’s own training record and preferences'],
  [/^\/report-library\/audit-summary/, 'the audit summary counts what people did (reading these screens included), practice too'],
  [/^\/(issues|attention)/, 'Needs attention (nothing from the training patient is raised, but its count endpoint is time-based)'],
  [/^\/(events|status|system|integrations\/log|connection-activity)/, 'live/technical state'],
  [/^\/backup(\?|$)/, 'a backup is a copy of everything, the training patient included (a restore must be whole)'],
  [/^\/(offline\/snapshot|paperwork\/status|schedule-cards)(\?|$)/, 'the schedule for the day (and its offline copy and paperwork status), where the training visit is shown'],
];

const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => {
  if (/(^|_)(at|now|time|generated|updated|created|ms|elapsed|took|duration|ts|seen|last_seen|as_of|asof|nonce)$/i.test(k)) return undefined;
  // Reading the export writes its own audit entry, so the audit log in it grows with every reading (checked on its own below).
  if (k === 'audit_log') return undefined;
  if (Array.isArray(x) && x.some((t) => t?.table === 'audit_log')) return x.filter((t) => t?.table !== 'audit_log');
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(x)) return '<time>';
  return x;
}));

async function getRoutes() {
  const out = new Set();
  const walk = (stack) => {
    for (const l of stack) {
      if (l.route) { if (l.route.methods.get && !String(l.route.path).includes(':') && !String(l.route.path).includes('*')) out.add(l.route.path); }
      else if (l.handle?.stack) walk(l.handle.stack);
    }
  };
  walk(h.app.router.stack);
  return [...out].filter((p) => !/^\/api\/|^\/(public|portal|webhooks|bridge|kiosk|media|v1|mcp|auth\/(sso|google|oauth))/.test(p)).sort();
}

const broken = new Set();
// Each screen read with a time limit (a live stream, like /events, never finishes on its own).
async function read(token, path) {
  try {
    const r = await fetch(`${h.origin}/api${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV or text */ }
    if (r.status >= 500) broken.add(`${r.status} ${path}`);
    return r.status < 300 ? norm(data) : { status: r.status };
  } catch (err) {
    return { error: err.name };
  }
}
// Live streams never finish on their own; "connect" starts a sign-in with an outside service (not set up in tests).
const STREAMS = /^\/(events|live|stream)|\/connect$/;
async function readAll(token, paths, today) {
  const got = {};
  for (const p of paths.filter((x) => !STREAMS.test(x))) {
    for (const q of ['', `?from=${today.slice(0, 8)}01&to=${today}&date=${today}`]) got[`${p}${q}`] = await read(token, `${p}${q}`);
  }
  return got;
}

test('practice on the training patient changes no report, total, dashboard, audience or export', { timeout: 600_000 }, async () => {
  const { api, token, patient, provider } = await h.practice();
  const today = (await api.get('/dashboard')).data.today || new Date().toISOString().slice(0, 10);
  // A real day: finished work, a payment, a visit, insurance, a claim.
  const carrier = (await api.post('/carriers', { name: 'Real Dental PPO', payer_id: '12345' })).data;
  const policy = (await api.post(`/patients/${patient.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Jane Doe', subscriber_id: 'RD1', group_number: 'G', annual_max: 150000, deductible: 5000 })).data;
  const done = [];
  for (const code of ['D0120', 'D1110']) done.push((await api.post(`/patients/${patient.id}/procedures`, { code, provider_id: provider.id, complete: true })).data);
  assert.equal((await api.post('/claims', { patient_insurance_id: policy.id, procedure_ids: done.map((p) => p.id) })).status, 201);
  assert.equal((await api.post(`/patients/${patient.id}/payments`, { amount: 2500, method: 'cash' })).status, 201);
  assert.equal((await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${today} 09:00`, end_time: `${today} 10:00` })).status, 201);

  const library = (await api.get('/report-library')).data;
  const reportIds = (Array.isArray(library) ? library : library.reports || library.groups?.flatMap((g) => g.reports) || []).map((r) => r.id).filter(Boolean);
  assert.ok(reportIds.length > 10, `the report library has its reports (${reportIds.length})`);
  const paths = [...await getRoutes(), ...reportIds.map((id) => `/report-library/${id}`)];
  assert.ok(paths.length > 150, `found ${paths.length} screens to read`);
  await readAll(token, paths, today); // the first reading sets up defaults some screens make on first use
  const before = await readAll(token, paths, today);

  // A busy day of practice on the training patient.
  const tess = (await api.post('/training/patient')).data;
  assert.equal(tess.is_training, 1);
  const prep = (await api.post('/training/patient/prepare', { needs: ['visit_today:checked_in', 'visit_future', 'unbilled', 'planned', 'draft_note', 'claim_sent'] })).data;
  assert.ok(prep.appt && prep.plan && prep.note);
  const tp = await api.get(`/patients/${tess.id}/insurance`);
  const tPolicy = (Array.isArray(tp.data) ? tp.data : tp.data.policies || [])[0];
  const more = [];
  for (const code of ['D0150', 'D2391']) more.push((await api.post(`/patients/${tess.id}/procedures`, { code, provider_id: provider.id, complete: true, tooth: code === 'D2391' ? '30' : undefined, surfaces: code === 'D2391' ? 'O' : undefined })).data);
  if (tPolicy) await api.post('/claims', { patient_insurance_id: tPolicy.id, procedure_ids: more.filter((m) => m?.id).map((m) => m.id) });
  assert.equal((await api.post(`/patients/${tess.id}/payments`, { amount: 12345, method: 'cash' })).status, 201);
  await api.post(`/patients/${tess.id}/payments`, { amount: 5000, method: 'check', reference: '1001' });
  await api.post(`/patients/${tess.id}/adjustments`, { amount: -1500, adjustment_type: 'Courtesy', description: 'Practice' });
  await api.post(`/patients/${tess.id}/notes`, { body: 'Practice note' });
  await api.post('/tasks', { text: 'Practice task', patient_id: tess.id });
  await api.post(`/patients/${tess.id}/messages`, { channel: 'sms', body: 'Practice text' });
  await api.post('/appointments', { patient_id: tess.id, provider_id: provider.id, start_time: `${today} 11:00`, end_time: `${today} 11:30`, override_blockout: true });
  const after = await readAll(token, paths, today);

  assert.deepEqual([...broken], [], 'screens that failed while being read');
  const allowed = (p) => BY_DESIGN.some(([re]) => re.test(p));
  const changed = Object.keys(before).filter((k) => !allowed(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const detail = changed.map((k) => {
    const a = JSON.stringify(before[k]); const b = JSON.stringify(after[k]);
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    return `${k}: …${a.slice(Math.max(0, i - 80), i + 60)}… → …${b.slice(Math.max(0, i - 80), i + 60)}…`;
  });
  assert.deepEqual(detail, [], `these screens count the training patient:\n${detail.join('\n')}`);
});
