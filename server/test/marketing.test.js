// Marketing ROI (MK1–MK2, docs/workflows/specs/MK-marketing.md): capture of where leads and patients came from
// (online booking tags, call-tracking lines, promo codes, referral links, the front desk's picker, doctor referrals),
// first- and last-touch rules, corrections with history, the ROI math from the ledger (voided entries left out),
// cost allocation per month, drill-down scoping, permissions and practice isolation.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import marketingRoutes from '../src/routes/marketing.js';
import {
  allocateCost, pickTouches, paybackMonths, matchText, resolveBooking, resolveAnswer, campaignLink, syncPractice, backfillPractice, runMarketingJobs, DEFAULT_SOURCES, MARKETING_LIBRARY_REPORT,
} from '../src/marketing.js';
import { cleanSource } from '../src/onlinesched.js';

const h = harness({ config: { payments: 'sandbox' } });
const hasPath = (stack, path) => stack.some((l) => l.route?.path === path || (l.handle?.stack && hasPath(l.handle.stack, path)));

// Until app.js mounts the marketing routes (see the spec for the line), add them to the signed-in API router.
before(async () => {
  for (let i = 0; i < 2400 && !h.origin; i++) await new Promise((r) => setTimeout(r, 50));
  if (hasPath(h.app.router.stack, '/marketing/report')) return;
  const api = h.app.router.stack.filter((l) => l.name === 'router' && l.handle?.stack).sort((a, b) => b.handle.stack.length - a.handle.stack.length)[0];
  api.handle.use(marketingRoutes({ db: h.db, config: h.config }));
});

const tokenFor = async (email) => (await h.client().post('/auth/login', { email, password: 'correct-horse-battery' })).data.token;
const login = async (email) => h.client(await tokenFor(email));
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const stamp = (d, t = '10:00:00') => `${d} ${t}`;
let seq = 0;

async function setup() {
  const ctx = await h.practice({ timezone: 'UTC', slug: `mk-${Date.now()}-${++seq}`, online_booking: true });
  const me = (await ctx.api.get('/auth/me')).data;
  ctx.pid = me.user.practice_id;
  ctx.sources = async () => (await ctx.api.get('/marketing/setup')).data.sources;
  ctx.source = async (channel) => (await ctx.sources()).find((s) => s.channel === channel);
  return ctx;
}
async function newPatient(ctx, fields = {}, createdOn = null) {
  const p = (await ctx.api.post('/patients', { first_name: `Pat${++seq}`, last_name: 'Lead', dob: '1990-01-01', phone: `(512) 555-${String(1000 + seq).slice(-4)}`, ...fields })).data;
  if (createdOn) await h.db.run('UPDATE patients SET created_at = ? WHERE id = ?', stamp(createdOn, '08:00:00'), p.id);
  return p;
}
const visit = (ctx, patientId, day, status = 'completed') => h.db.run(
  'INSERT INTO appointments (practice_id, patient_id, provider_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?)', ctx.pid, patientId, ctx.provider.id, `${day} 09:00`, `${day} 10:00`, status,
);
const ledger = async (ctx, patientId, type, amount, day, extra = {}) => (await h.db.run(
  'INSERT INTO ledger_entries (practice_id, patient_id, type, amount, description, entry_date, voided_at, reverses_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ctx.pid, patientId, type, amount, `${type} test`, day, extra.voided_at ?? null, extra.reverses_id ?? null,
)).id;
async function booking(ctx, { patientId = null, created, newPatient: isNew = 1, ...src }) {
  const ob = (await h.db.run(
    `INSERT INTO online_bookings (practice_id, submit_key, status, people, new_patients, source, utm_source, utm_medium, utm_campaign, referrer_host, promo_code, referral_code, created_at)
     VALUES (?, ?, 'booked', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ctx.pid, `key-${++seq}-${Date.now()}`, isNew, src.source ?? 'direct', src.utm_source ?? null, src.utm_medium ?? null, src.utm_campaign ?? null,
    src.referrer_host ?? null, src.promo_code ?? null, src.referral_code ?? null, stamp(created),
  )).id;
  return (await h.db.run(
    `INSERT INTO booking_requests (practice_id, first_name, last_name, requested_start, new_patient, status, patient_id, online_booking_id, source, created_at)
     VALUES (?, 'Web', 'Lead', ?, ?, 'accepted', ?, ?, ?, ?)`, ctx.pid, `${addDays(created, 3)} 09:00`, isNew, patientId, ob, src.source ?? 'direct', stamp(created),
  )).id;
}
const call = async (ctx, { patientId = null, to = '+15125550199', from = '+15125559999', source = null, newCaller = 1, created }) => (await h.db.run(
  "INSERT INTO calls (practice_id, patient_id, direction, purpose, from_number, to_number, status, source, new_caller, created_at) VALUES (?, ?, 'inbound', 'inbound', ?, ?, 'completed', ?, ?, ?)",
  ctx.pid, patientId, from, to, source, newCaller, stamp(created),
)).id;
const attribution = async (ctx, patientId) => (await ctx.api.get(`/marketing/patients/${patientId}/attribution`)).data;

// ---- Rules on their own ----
test('matching text, tags and answers to sources; cost spread by day; first/last touch; payback; links', () => {
  const catalog = { sources: DEFAULT_SOURCES.map((s, i) => ({ id: i + 1, active: 1, channel: s.channel, name: s.name, match_keys: s.keys })), campaigns: [{ id: 50, source_id: 9, name: 'Spring mailer', promo_code: 'SPRING25', utm_campaign: 'spring-2026' }], tracking: [] };
  const ch = (s) => s && catalog.sources.find((x) => x.id === s.id || x.id === s.source_id)?.channel;
  assert.equal(matchText(catalog, 'Facebook / Instagram').channel, 'facebook');
  assert.equal(matchText(catalog, 'Doctor referral').channel, 'referral_doctor');
  assert.equal(matchText(catalog, 'Existing patient referral').channel, 'referral_patient');
  assert.equal(matchText(catalog, 'Online booking'), null);
  assert.equal(ch(resolveBooking(catalog, { utm_source: 'google', utm_medium: 'cpc' })), 'google_ads');
  assert.equal(ch(resolveBooking(catalog, { utm_source: 'google', utm_medium: 'organic' })), 'website_organic');
  assert.deepEqual(resolveBooking(catalog, { utm_campaign: 'spring-2026', utm_source: 'mailer' }).campaign_id, 50);
  assert.equal(resolveBooking(catalog, { promo_code: 'spring25', utm_source: 'facebook' }).method, 'promo_code');
  assert.equal(resolveBooking(catalog, { src: 'direct' }).method, 'online_booking');
  assert.equal(resolveAnswer(catalog, 'SPRING25').campaign_id, 50);
  assert.equal(ch(resolveAnswer(catalog, 'Drove by')), 'walk_in');

  // $31.00 over Jan 15 – Feb 14: 17 days in January, 14 in February; whole cents always add back up.
  assert.deepEqual(allocateCost({ starts_on: '2026-01-15', ends_on: '2026-02-14', amount: 3100 }), { '2026-01': 1700, '2026-02': 1400 });
  const odd = allocateCost({ starts_on: '2026-03-01', ends_on: '2026-03-03', amount: 1000 });
  assert.equal(odd['2026-03'], 1000);
  assert.deepEqual(allocateCost({ starts_on: '2026-03-01', ends_on: '2026-03-03', amount: 1000 }, '2026-03-03', '2026-03-03'), { '2026-03': 334 });

  const t = [{ id: 1, source_id: 3, occurred_at: '2026-01-05 10:00:00' }, { id: 2, source_id: null, occurred_at: '2026-01-01 10:00:00' }, { id: 3, source_id: 4, occurred_at: '2026-01-08 10:00:00' }, { id: 4, source_id: 5, occurred_at: '2026-02-20 10:00:00' }];
  const pick = pickTouches(t, '2026-01-10');
  assert.equal(pick.first.id, 1); // the touch with no source doesn't count
  assert.equal(pick.last.id, 3); // after the first visit doesn't count
  assert.equal(pickTouches([t[3]], '2026-01-10').first.id, 4); // only later evidence: still better than nothing

  assert.equal(paybackMonths([{ monthly: [[0, 3000], [40, 3000], [95, 5000]] }], 6000), 2);
  assert.equal(paybackMonths([{ monthly: [[0, 100]] }], 6000), null);
  const url = new URL(campaignLink({ appUrl: 'https://app.example.com', practiceSlug: 'smile', source: catalog.sources[8], campaign: catalog.campaigns[0] }));
  assert.equal(url.pathname, '/book/smile');
  assert.equal(url.searchParams.get('utm_source'), 'mailer');
  assert.equal(url.searchParams.get('utm_medium'), 'print');
  assert.equal(url.searchParams.get('utm_campaign'), 'spring-2026');
  assert.equal(url.searchParams.get('promo'), 'SPRING25');
  assert.throws(() => campaignLink({ appUrl: 'x', practiceSlug: 's', source: catalog.sources[0], target: 'javascript:alert(1)' }), /https/);

  // The booking page keeps a promo code and a referral link code, nothing else new.
  const s = cleanSource({ src: 'website', promo: ' spring25 ', rp: 'abc123XY' });
  assert.equal(s.promo_code, 'SPRING25');
  assert.equal(s.referral_code, 'ABC123XY');
  assert.equal(cleanSource({ promo: '<script>' }).promo_code, null);
});

// ---- MK1 capture ----
test('captured automatically: online booking tags, tracking-number calls, promo codes, referral links, the front desk picker and doctor referrals', async () => {
  const ctx = await setup();
  const { api } = ctx;
  const google = await ctx.source('google_ads');
  const mailer = await ctx.source('mailer');
  // A mailer campaign with a promo code, and a tracking line used by a Google Ads campaign.
  const line = (await api.post('/tracking-numbers', { number: '(512) 555-0199', source: 'Google Ads line', monthly_cost: 15 })).data;
  assert.ok(line.id, JSON.stringify(line));
  const spring = (await api.post('/marketing/campaigns', { name: 'Spring mailer', source_id: mailer.id, promo_code: 'spring25', starts_on: addDays(today, -300), ends_on: addDays(today, -200) })).data;
  assert.equal(spring.promo_code, 'SPRING25');
  assert.equal(spring.utm_campaign, 'spring-mailer');
  const ads = (await api.post('/marketing/campaigns', { name: 'Implants search', source_id: google.id, utm_campaign: 'implants', tracking_number_id: line.id, starts_on: addDays(today, -400) })).data;
  assert.equal(ads.tracking_number_id, line.id);

  // 1. Online booking with UTM tags for the campaign.
  const p1 = await newPatient(ctx, {}, addDays(today, -100));
  await booking(ctx, { patientId: p1.id, created: addDays(today, -100), utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'implants' });
  // 2. A new caller rings the tracking line; the call is attached to their chart.
  const p2 = await newPatient(ctx, {}, addDays(today, -90));
  await call(ctx, { patientId: p2.id, to: '+15125550199', from: '+15125550001', source: 'Google Ads line', created: addDays(today, -90) });
  // 3. Promo code typed on the booking page.
  const p3 = await newPatient(ctx, {}, addDays(today, -250));
  await booking(ctx, { patientId: p3.id, created: addDays(today, -250), promo_code: 'SPRING25', utm_source: 'facebook' });
  // 4. A patient's referral link.
  const link = (await api.get(`/marketing/patients/${ctx.patient.id}/referral-link`)).data;
  assert.match(link.url, /\/book\/mk-.*\?rp=[A-Z0-9]{6,}/);
  const again = (await api.get(`/marketing/patients/${ctx.patient.id}/referral-link`)).data;
  assert.equal(again.code, link.code, 'one code per patient');
  const p4 = await newPatient(ctx, {}, addDays(today, -60));
  await booking(ctx, { patientId: p4.id, created: addDays(today, -60), referral_code: link.code, utm_source: 'patient-referral' });
  // 5. The front desk's "How did you hear about us?" picker.
  const p5 = await newPatient(ctx, { referral_source: 'Facebook / Instagram' });
  // 6. A promo code said at the desk.
  const p6 = await newPatient(ctx, { referral_source: 'spring25' });
  // 7. A referring doctor.
  const doc = await h.db.run('INSERT INTO referral_contacts (practice_id, name, specialty) VALUES (?, ?, ?)', ctx.pid, 'Dr. Ortho', 'Orthodontics');
  const p7 = await newPatient(ctx, {});
  await h.db.run('UPDATE patients SET referred_by_id = ? WHERE id = ?', doc.id, p7.id);

  const a1 = await attribution(ctx, p1.id);
  assert.equal(a1.first.channel, 'google_ads');
  assert.equal(a1.first.campaign_id, ads.id);
  assert.equal(a1.first.method, 'utm');
  assert.equal(a1.first.lead, true);
  const a2 = await attribution(ctx, p2.id);
  assert.equal(a2.first.method, 'tracking_number');
  assert.equal(a2.first.campaign_id, ads.id, 'the campaign using that tracking line on the day');
  const a3 = await attribution(ctx, p3.id);
  assert.equal(a3.first.method, 'promo_code');
  assert.equal(a3.first.campaign_id, spring.id);
  const a4 = await attribution(ctx, p4.id);
  assert.equal(a4.first.method, 'referral');
  assert.equal(a4.first.channel, 'referral_patient');
  assert.ok(await h.db.get('SELECT id FROM journey_referrals WHERE practice_id = ? AND referrer_patient_id = ? AND referred_patient_id = ?', ctx.pid, ctx.patient.id, p4.id), 'the referral is on the journeys list (thank-you)');
  const a5 = await attribution(ctx, p5.id);
  assert.equal(a5.first.method, 'staff');
  assert.equal(a5.first.channel, 'facebook');
  const a6 = await attribution(ctx, p6.id);
  assert.equal(a6.first.method, 'promo_code');
  assert.equal(a6.first.campaign_id, spring.id);
  const a7 = await attribution(ctx, p7.id);
  assert.equal(a7.first.channel, 'referral_doctor');
  assert.equal(a7.first.detail, 'Referred by Dr. Ortho');

  // Capture is idempotent: running it again adds nothing.
  const before = (await h.db.get('SELECT COUNT(*) AS n FROM marketing_touches WHERE practice_id = ?', ctx.pid)).n;
  await syncPractice(h.db, ctx.pid, { full: true });
  await runMarketingJobs(h.db);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM marketing_touches WHERE practice_id = ?', ctx.pid)).n, before);

  // A tracking line nobody matched becomes its own source, named after the line.
  await call(ctx, { to: '+15125550777', from: '+15125550002', source: 'Billboard I-35', created: addDays(today, -5) });
  await syncPractice(h.db, ctx.pid);
  assert.ok((await ctx.sources()).find((s) => s.name === 'Billboard I-35'));

  // The picker lists the practice's sources.
  const picker = (await api.get('/marketing/picker')).data;
  assert.ok(picker.sources.some((s) => s.name === 'Google Ads') && picker.campaigns.some((c) => c.promo_code === 'SPRING25'));
});

test('first and last touch: earliest and latest before the first visit; corrections are pinned, need a reason and keep history', async () => {
  const ctx = await setup();
  const { api } = ctx;
  const fb = await ctx.source('facebook');
  const gbp = await ctx.source('google_business');
  const p = await newPatient(ctx, {}, addDays(today, -40));
  await call(ctx, { patientId: p.id, from: '+15125550444', source: 'Facebook ad line', created: addDays(today, -40) }); // first
  await booking(ctx, { patientId: p.id, created: addDays(today, -35), utm_source: 'gbp' }); // last before the visit
  await visit(ctx, p.id, addDays(today, -30));
  await booking(ctx, { patientId: p.id, created: addDays(today, -10), newPatient: 0, utm_source: 'instagram' }); // after: not counted
  let a = await attribution(ctx, p.id);
  assert.equal(a.first.channel, 'facebook');
  assert.equal(a.last.channel, 'google_business');
  assert.equal(a.touches.length, 3);
  assert.equal(a.pinned, false);
  // Every change to the pointers is on the patient's history (automation).
  const auto = await h.db.get("SELECT * FROM audit_log WHERE practice_id = ? AND entity = 'patients' AND entity_id = ? AND changes LIKE '%marketing_first_touch_id%'", ctx.pid, p.id);
  assert.equal(auto.source, 'automation');

  // Correcting it: a reason is needed over what the system found.
  assert.equal((await api.put(`/marketing/patients/${p.id}/attribution`, { first: { source_id: gbp.id } })).status, 400);
  assert.equal((await api.put(`/marketing/patients/${p.id}/attribution`, { first: { source_id: 999999 }, reason: 'x' })).status, 400);
  const put = await api.put(`/marketing/patients/${p.id}/attribution`, { first: { source_id: gbp.id }, reason: 'Patient says they found us on Google Maps first' });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.pinned, true);
  assert.equal(put.data.first.channel, 'google_business');
  assert.equal(put.data.first.method, 'staff');
  assert.equal(put.data.history[0].action, 'marketing.attribution_edit');
  assert.equal(put.data.history[0].reason, 'Patient says they found us on Google Maps first');
  const row = await h.db.get("SELECT * FROM audit_log WHERE action = 'marketing.attribution_edit' AND entity_id = ?", p.id);
  assert.equal(row.source, 'human');
  assert.ok(JSON.parse(row.changes).first_touch_id, 'before → after recorded');
  // Pinned: capture leaves it alone.
  await syncPractice(h.db, ctx.pid, { full: true });
  assert.equal((await attribution(ctx, p.id)).first.channel, 'google_business');
  // Back to automatic.
  const reset = (await api.post(`/marketing/patients/${p.id}/attribution/reset`)).data;
  assert.equal(reset.pinned, false);
  assert.equal(reset.first.channel, 'facebook');
  assert.ok(reset.history.some((x) => x.action === 'marketing.attribution_reset'));
  // A source from another practice can't be used.
  const other = await setup();
  const theirs = await other.source('mailer');
  assert.equal((await api.put(`/marketing/patients/${p.id}/attribution`, { first: { source_id: theirs.id }, reason: 'x' })).status, 400);
  void fb;
});

// ---- MK2: the ROI math ----
test('ROI from the ledger: production and collections by window, voided and reversed entries left out, cost per lead / new patient, ROI, payback and lifetime value', async () => {
  const ctx = await setup();
  const { api } = ctx;
  const google = await ctx.source('google_ads');
  const camp = (await api.post('/marketing/campaigns', { name: 'Invisalign search', source_id: google.id, utm_campaign: 'invisalign' })).data;
  const start = addDays(today, -200);
  // Two new patients from the campaign, and one lead who never came.
  const a = await newPatient(ctx, {}, start);
  const b = await newPatient(ctx, {}, addDays(start, 10));
  await booking(ctx, { patientId: a.id, created: start, utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'invisalign' });
  await booking(ctx, { patientId: b.id, created: addDays(start, 10), utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'invisalign' });
  await booking(ctx, { created: addDays(start, 12), utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'invisalign' });
  const fvA = addDays(start, 5);
  const fvB = addDays(start, 15);
  await visit(ctx, a.id, fvA);
  await visit(ctx, b.id, fvB);
  // A: $200 at the first visit, $500 on day 60, $1,000 on day 150 (charges); paid $150 day 0, $500 day 70 (insurance), refund $20 day 71.
  await ledger(ctx, a.id, 'charge', 20000, fvA);
  await ledger(ctx, a.id, 'charge', 50000, addDays(fvA, 60));
  await ledger(ctx, a.id, 'charge', 100000, addDays(fvA, 150));
  await ledger(ctx, a.id, 'payment', -15000, fvA);
  await ledger(ctx, a.id, 'insurance_payment', -50000, addDays(fvA, 70));
  await ledger(ctx, a.id, 'refund', 2000, addDays(fvA, 71));
  // A voided $9,999 charge and its reversal never count; neither does a reversed payment.
  const bad = await ledger(ctx, a.id, 'charge', 999900, addDays(fvA, 1), { voided_at: stamp(addDays(fvA, 1)) });
  await ledger(ctx, a.id, 'charge', -999900, addDays(fvA, 1), { reverses_id: bad });
  const pay = await ledger(ctx, a.id, 'payment', -777700, addDays(fvA, 2), { voided_at: stamp(addDays(fvA, 2)) });
  await ledger(ctx, a.id, 'payment', 777700, addDays(fvA, 2), { reverses_id: pay });
  // B: $300 charge and $300 paid at the first visit.
  await ledger(ctx, b.id, 'charge', 30000, fvB);
  await ledger(ctx, b.id, 'payment', -30000, fvB);
  // Treatment accepted for A: a $1,200 plan accepted.
  const plan = await h.db.run("INSERT INTO treatment_plans (practice_id, patient_id, name, status) VALUES (?, ?, 'Aligners', 'accepted')", ctx.pid, a.id);
  const code = await h.db.get('SELECT id FROM procedure_codes WHERE practice_id = ? LIMIT 1', ctx.pid);
  await h.db.run("INSERT INTO procedures (practice_id, patient_id, code_id, code, fee, status, treatment_plan_id) VALUES (?, ?, ?, 'D8090', 120000, 'planned', ?)".replace('code, fee', "code, description, category, fee").replace("'D8090', 120000", "'D8090', 'Aligners', 'Orthodontics', 120000"), ctx.pid, a.id, code.id, plan.id);
  // The campaign cost $600 over the first month.
  const cost = await api.post('/marketing/costs', { source_id: google.id, campaign_id: camp.id, starts_on: start, ends_on: addDays(start, 29), amount: 60000, client_key: 'cost-key-0001' });
  assert.equal(cost.status, 201, JSON.stringify(cost.data));
  assert.equal((await api.post('/marketing/costs', { source_id: google.id, campaign_id: camp.id, starts_on: start, ends_on: addDays(start, 29), amount: 60000, client_key: 'cost-key-0001' })).status, 200, 'sent twice: one cost');
  // A mistaken cost, voided (with a reason), never counts.
  const wrong = (await api.post('/marketing/costs', { source_id: google.id, starts_on: start, amount: 500000 })).data;
  assert.equal((await api.post(`/marketing/costs/${wrong.id}/void`, {})).status, 400);
  assert.equal((await api.post(`/marketing/costs/${wrong.id}/void`, { reason: 'Typo: was $50' })).status, 200);
  assert.equal((await api.post('/marketing/costs', { source_id: google.id, starts_on: start, amount: 12.5 })).status, 400);

  const q = `from=${addDays(start, -1)}&to=${today}&by=campaign`;
  const rep = (await api.get(`/marketing/report?${q}`)).data;
  const row = rep.rows.find((r) => r.campaign_id === camp.id);
  assert.ok(row, JSON.stringify(rep.rows));
  assert.equal(row.leads, 3);
  assert.equal(row.online_leads, 3);
  assert.equal(row.new_patients, 2);
  assert.equal(row.production_30, 20000 + 30000);
  assert.equal(row.production_90, 20000 + 50000 + 30000);
  assert.equal(row.production_180, 20000 + 50000 + 100000 + 30000);
  assert.equal(row.production_life, 200000);
  assert.equal(row.collections_30, 15000 + 30000);
  assert.equal(row.collections_90, 15000 + 50000 - 2000 + 30000);
  assert.equal(row.collections_life, 93000);
  assert.equal(row.matured_365, 0);
  assert.equal(row.matured_90, 2);
  assert.equal(row.treatment_accepted, 120000);
  assert.equal(row.cost, 60000);
  assert.equal(row.cost_per_lead, 20000);
  assert.equal(row.cost_per_new_patient, 30000);
  // ROI on first-year collections: (93,000 − 60,000) / 60,000.
  assert.equal(row.roi, 55);
  assert.equal(row.return_multiple, 1.55);
  // Collections reach $600 in month 3 (day 70 insurance payment).
  assert.equal(row.payback_months, 3);
  assert.equal(row.ltv_collections, 46500);
  assert.equal(row.ltv_production, 100000);
  assert.equal(row.booked, 2);
  assert.equal(row.showed, 2);
  assert.equal(row.show_rate, 100);
  // A shorter window for ROI.
  const r30 = (await api.get(`/marketing/report?${q}&window=30`)).data.rows.find((r) => r.campaign_id === camp.id);
  assert.equal(r30.roi, -25);
  // Totals add up.
  assert.equal(rep.total.new_patients, rep.rows.reduce((s, r) => s + r.new_patients, 0));
  assert.equal(rep.total.cost, 60000);

  // By month: the cost lands in the months it covers.
  const byMonth = (await api.get(`/marketing/report?from=${addDays(start, -1)}&to=${today}&by=month`)).data;
  const spread = allocateCost({ starts_on: start, ends_on: addDays(start, 29), amount: 60000 });
  for (const [m, cents] of Object.entries(spread)) assert.equal(byMonth.rows.find((r) => r.key === m).cost, cents);
  assert.equal(byMonth.rows.reduce((s, r) => s + (r.cost || 0), 0), 60000);

  // Lifetime value by source.
  const bySource = (await api.get(`/marketing/report?${q.replace('by=campaign', 'by=source')}&model=last`)).data;
  assert.equal(bySource.rows.find((r) => r.source_id === google.id).ltv_collections, 46500);

  // CSV: the summary and the drill-down; names only, no birth dates or phone numbers.
  const csv = await fetch(`${h.origin}/api/marketing/report.csv?${q}`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const csvText = await csv.text();
  assert.match(csvText, /Invisalign search/);
  assert.match(csvText, /Cost per new patient/);
  const pcsv = await (await fetch(`${h.origin}/api/marketing/report/patients.csv?${q}&key=c${camp.id}`, { headers: { Authorization: `Bearer ${ctx.token}` } })).text();
  assert.match(pcsv, new RegExp(a.first_name));
  assert.doesNotMatch(pcsv, /1990-01-01|555-/);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'marketing.export'", ctx.pid));

  // Drill-down: the patients behind the row, audited.
  const dd = (await api.get(`/marketing/report/patients?${q}&key=c${camp.id}`)).data;
  assert.deepEqual(dd.patients.map((x) => x.patient_id).sort(), [a.id, b.id].sort());
  assert.equal(dd.patients.find((x) => x.patient_id === a.id).collections_life, 63000);
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'marketing.drill_down'", ctx.pid));
  // The report library's entry (first touch, first year) gives the same numbers.
  const lib = await MARKETING_LIBRARY_REPORT.run({ db: h.db, user: { practice_id: ctx.pid, role: 'admin', location_ids: [] }, from: addDays(start, -1), to: today, locationId: null, officeIds: null });
  const libRow = lib.rows.find((r) => r.source === 'Google Ads');
  assert.equal(libRow.new_patients, 2);
  assert.equal(libRow.collections_365, 93000);
  assert.equal(libRow.cost, 60000);
  ctx.campaign = camp;
  globalThis.__mk = { ctx, q, a, b };
});

test('permissions: reports:read to see it, billing:read for the money, finance managers for setup, patient permissions for a chart', async () => {
  const { ctx, q } = globalThis.__mk;
  const { api } = ctx;
  const mk = async (role, extra = {}) => {
    const email = `${role}-${Date.now()}-${++seq}@example.com`;
    const u = await api.post('/users', { name: role, email, password: 'correct-horse-battery', role, ...extra });
    assert.equal(u.status, 201, JSON.stringify(u.data));
    const token = await tokenFor(email);
    const c = h.client(token);
    c.token = token;
    return c;
  };
  const desk = await mk('front_desk');
  assert.equal((await desk.get(`/marketing/report?${q}`)).status, 403);
  assert.equal((await desk.get('/marketing/picker')).status, 200);
  assert.equal((await desk.get(`/marketing/patients/${globalThis.__mk.a.id}/attribution`)).status, 200);
  // Reports without billing: counts, no money or cost.
  const viewer = await mk('assistant', { permissions_add: ['reports:read'] });
  const rep = await viewer.get(`/marketing/report?${q}`);
  assert.equal(rep.status, 200);
  const row = rep.data.rows.find((r) => r.campaign_id === ctx.campaign.id);
  assert.equal(row.new_patients, 2);
  assert.equal(row.production_90, undefined);
  assert.equal(row.cost, undefined);
  assert.equal(row.roi, undefined);
  const dd = (await viewer.get(`/marketing/report/patients?${q}&key=c${ctx.campaign.id}`)).data;
  assert.equal(dd.patients[0].collections_life, undefined);
  const csv = await (await fetch(`${h.origin}/api/marketing/report.csv?${q}`, { headers: { Authorization: `Bearer ${viewer.token}` } })).text();
  assert.doesNotMatch(csv, /Collections|Cost/);
  // A dentist (reports + billing) sees money but can't change costs or sources.
  const dentist = await mk('dentist');
  assert.ok((await dentist.get(`/marketing/report?${q}`)).data.rows.find((r) => r.campaign_id === ctx.campaign.id).production_90 > 0);
  assert.equal((await dentist.post('/marketing/sources', { name: 'TV', channel: 'other' })).status, 403);
  assert.equal((await dentist.post('/marketing/costs', { source_id: 1, starts_on: today, amount: 100 })).status, 403);
  assert.equal((await dentist.post(`/marketing/costs/1/void`, { reason: 'x' })).status, 403);
  // Finance managers can.
  const fin = await mk('billing', { permissions_add: ['finance:write'] });
  assert.equal((await fin.post('/marketing/sources', { name: 'Radio', channel: 'other' })).status, 201);
  assert.equal((await fin.post('/marketing/sources', { name: 'Radio', channel: 'other' })).status, 409);
  assert.equal((await fin.post('/marketing/sources', { name: 'Radio 2', channel: 'tv' })).status, 400);
});

test('drill-down and totals are held to the offices a person may see', async () => {
  const ctx = await setup();
  const { api } = ctx;
  const north = (await api.post('/locations', { name: 'North' })).data;
  const south = (await api.post('/locations', { name: 'South' })).data;
  const fb = await ctx.source('facebook');
  const n = await newPatient(ctx, { location_id: north.id }, addDays(today, -20));
  const s = await newPatient(ctx, { location_id: south.id }, addDays(today, -20));
  for (const p of [n, s]) {
    await booking(ctx, { patientId: p.id, created: addDays(today, -20), utm_source: 'facebook' });
    await visit(ctx, p.id, addDays(today, -15));
  }
  const email = `north-${Date.now()}@example.com`;
  await api.post('/users', { name: 'North Mgr', email, password: 'correct-horse-battery', role: 'billing', location_ids: [north.id] });
  const mgr = await login(email);
  const q = `from=${addDays(today, -30)}&to=${today}&by=source`;
  const mine = (await mgr.get(`/marketing/report?${q}`)).data;
  assert.equal(mine.rows.find((r) => r.source_id === fb.id).new_patients, 1);
  assert.equal(mine.show_cost, false, 'practice-wide costs aren’t shown to someone limited to one office');
  const dd = (await mgr.get(`/marketing/report/patients?${q}&key=s${fb.id}`)).data;
  assert.deepEqual(dd.patients.map((x) => x.patient_id), [n.id]);
  assert.equal((await mgr.get(`/marketing/report?${q}&location_id=${south.id}`)).status, 403);
  const all = (await api.get(`/marketing/report?${q}`)).data;
  assert.equal(all.rows.find((r) => r.source_id === fb.id).new_patients, 2);
  assert.equal((await api.get(`/marketing/report?${q}&location_id=${south.id}`)).data.rows.find((r) => r.source_id === fb.id).new_patients, 1);
  assert.equal((await api.get('/marketing/report?by=nope')).status, 400);
  assert.equal((await api.get('/marketing/report?from=2026-02-31')).status, 400);
});

test('nightly backfill: a chart made by hand is matched to the call that brought them in', async () => {
  const ctx = await setup();
  await call(ctx, { from: '+15125558877', to: '+15125550123', source: 'Mailer line', created: addDays(today, -3) });
  await syncPractice(h.db, ctx.pid);
  const p = await newPatient(ctx, { phone: '(512) 555-8877' });
  assert.equal((await attribution(ctx, p.id)).first, null);
  assert.equal(await backfillPractice(h.db, ctx.pid), 1);
  const a = await attribution(ctx, p.id);
  assert.equal(a.first.channel, 'mailer');
  assert.equal(a.first.method, 'tracking_number');
  assert.ok(await h.db.get("SELECT id FROM audit_log WHERE practice_id = ? AND action = 'marketing.backfill' AND source = 'automation'", ctx.pid));
});

test('practice isolation: sources, campaigns, costs, charts and numbers never cross practices', async () => {
  const a = await setup();
  const b = await setup();
  const aSrc = await a.source('google_ads');
  const aCamp = (await a.api.post('/marketing/campaigns', { name: 'A only', source_id: aSrc.id, promo_code: 'AONLY' })).data;
  const aCost = (await a.api.post('/marketing/costs', { source_id: aSrc.id, starts_on: today, amount: 5000 })).data;
  assert.equal((await b.api.patch(`/marketing/sources/${aSrc.id}`, { name: 'Mine now' })).status, 404);
  assert.equal((await b.api.patch(`/marketing/campaigns/${aCamp.id}`, { name: 'Mine now' })).status, 404);
  assert.equal((await b.api.get(`/marketing/campaigns/${aCamp.id}/link`)).status, 404);
  assert.equal((await b.api.post(`/marketing/costs/${aCost.id}/void`, { reason: 'x' })).status, 404);
  assert.equal((await b.api.post('/marketing/costs', { source_id: aSrc.id, starts_on: today, amount: 100 })).status, 404);
  assert.equal((await b.api.post('/marketing/campaigns', { name: 'X', source_id: aSrc.id })).status, 404);
  assert.equal((await b.api.get(`/marketing/patients/${a.patient.id}/attribution`)).status, 404);
  assert.equal((await b.api.put(`/marketing/patients/${a.patient.id}/attribution`, { first: { source_id: aSrc.id } })).status, 404);
  // B's promo code of the same name is its own; A's code means nothing to B.
  const bSrc = await b.source('mailer');
  assert.equal((await b.api.post('/marketing/campaigns', { name: 'B', source_id: bSrc.id, promo_code: 'AONLY' })).status, 201);
  const setupB = (await b.api.get('/marketing/setup')).data;
  assert.ok(!setupB.campaigns.some((c) => c.id === aCamp.id));
  assert.ok(!setupB.costs.some((c) => c.id === aCost.id));
  const repB = (await b.api.get('/marketing/report')).data;
  assert.equal(repB.total.cost, 0);
  // Within one practice, a promo code is unique.
  assert.equal((await a.api.post('/marketing/campaigns', { name: 'A two', source_id: aSrc.id, promo_code: 'aonly' })).status, 409);
});
