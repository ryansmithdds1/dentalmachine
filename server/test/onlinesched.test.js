// Online scheduling (OS1–OS5, docs/workflows/specs/OS-online-scheduling.md): open times that are really free
// (visits, blockouts, perfect-day blocks, held emergency time), the race at submit, emergency triage, matching
// new vs existing patients (duplicates flagged, never merged), requested vs instant, the front desk's alerts,
// family back-to-back, idempotent submit, bot protection and rate limits, analytics without personal details,
// and practice isolation.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { authenticate } from '../src/auth.js';
import onlineSchedPublicRoutes, { onlineSchedRoutes, onlineSchedEmbedRoutes } from '../src/routes/onlinesched.js';
import { searchContext, openOn, visitTypes, pickForDay, evalAnswers, TRIAGE, cleanSource } from '../src/onlinesched.js';

const h = harness({ config: { payments: 'sandbox', onlineBookPerHour: 60 } });

// Until app.js mounts the online scheduling routes (see the spec), put them where app.js will: before the API's 404.
before(async () => {
  for (let i = 0; i < 2400 && !h.origin; i++) await new Promise((r) => setTimeout(r, 50)); // the harness starts the app first
  const probe = await h.client().get('/public/os/no-such-practice');
  if (probe.status === 404 && /Online booking is not available/.test(probe.data?.error || '')) return;
  const stack = h.app.router.stack;
  const at = stack.findIndex((l) => /new HttpError\(404, 'Not found'\)/.test(String(l.handle)));
  assert.ok(at > 0, 'found the API 404 handler');
  // Public routes go before the signed-in API (which would ask for a sign-in), staff routes just after it.
  let n = stack.length;
  h.app.use('/api', authenticate(h.db, 'test-secret'), onlineSchedRoutes({ db: h.db, config: h.config }));
  h.app.use(onlineSchedEmbedRoutes({ db: h.db }));
  stack.splice(at, 0, ...stack.splice(n));
  n = stack.length;
  h.app.use('/api/public', onlineSchedPublicRoutes({ db: h.db, messenger: h.messenger, payments: { enabled: true, mode: 'sandbox' }, storage: await storageFor(), config: h.config }));
  stack.splice(at - 1, 0, ...stack.splice(n));
});
async function storageFor() {
  const { createStorage } = await import('../src/storage.js');
  return createStorage({ dir: h.config.uploadDir });
}

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const weekdayAhead = (plus) => {
  let d = addDays(new Date().toISOString().slice(0, 10), plus);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDays(d, 1);
  return d;
};
const overlaps = (s, minutes, from, to) => s < to && addMin(s, minutes) > from;
function addMin(dt, m) { return new Date(Date.parse(`${dt.replace(' ', 'T')}:00Z`) + m * 60_000).toISOString().slice(0, 16).replace('T', ' '); }
let seq = 0;
const key = () => `k${Date.now().toString(36)}${(++seq).toString(36)}xxxxxxxx`;

async function setup() {
  const slug = `os-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ctx = await h.practice({ timezone: 'UTC', slug, online_booking: true });
  const hyg = (await ctx.api.post('/providers', { name: 'Hana Hygienist', type: 'hygienist' })).data;
  const types = {
    np: (await ctx.api.post('/appointment-types', { name: 'New patient exam', duration: 60, provider_type: 'dentist' })).data,
    em: (await ctx.api.post('/appointment-types', { name: 'Emergency exam', duration: 30, provider_type: 'dentist' })).data,
    crown: (await ctx.api.post('/appointment-types', { name: 'Crown prep', duration: 90, provider_type: 'dentist' })).data,
    prophy: (await ctx.api.post('/appointment-types', { name: 'Adult prophy', duration: 60, provider_type: 'hygienist' })).data,
  };
  const pub = h.client();
  const seeded = (await pub.get(`/public/os/${slug}`)).data;
  assert.ok(seeded.visit_types?.length >= 4, JSON.stringify(seeded));
  // Known lengths and providers for the tests: new patients and emergencies with the dentist, cleanings with the hygienist.
  const byKind = Object.fromEntries(seeded.visit_types.map((t) => [t.kind, t]));
  for (const [kind, type, duration] of [['new_patient', types.np, 60], ['emergency', types.em, 30], ['hygiene', types.prophy, 60]]) {
    const put = await ctx.api.put(`/online-scheduling/visit-types/${byKind[kind].id}`, { appointment_type_id: type.id, duration });
    assert.equal(put.status, 200, JSON.stringify(put.data));
  }
  const info = (await pub.get(`/public/os/${slug}`)).data;
  const vt = Object.fromEntries(info.visit_types.map((t) => [t.kind, t]));
  const book = (body) => pub.post(`/public/os/${slug}/book`, { key: key(), session: `s${key()}`, phone: '(512) 555-0199', ...body });
  return { ...ctx, slug, hyg, types, pub, info, vt, book };
}
const person = (first, last, dob = '1990-02-03') => ({ first_name: first, last_name: last, dob });

test('seeded visit types link to the practice’s appointment types; the emergency type asks triage questions', async () => {
  const { vt, types } = await setup();
  assert.deepEqual(Object.keys(vt).sort(), ['consult', 'emergency', 'hygiene', 'new_patient']);
  assert.equal(vt.emergency.questions.map((q) => q.key).join(), 'pain,swelling,trauma,fever');
  assert.equal(vt.consult.mode, 'request');
  assert.equal(vt.hygiene.who, 'existing');
  const { api } = await setup();
  const s = (await api.get('/online-scheduling/settings')).data;
  assert.equal(s.visit_types.find((t) => t.kind === 'new_patient').appointment_type_id != null, true);
  assert.ok(types.np.id);
});

test('availability never offers a taken, blocked or perfect-day-blocked time', async () => {
  const { api, provider, patient, slug, vt, types, practiceId } = await setup();
  const day = weekdayAhead(4);
  const a = await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day} 09:00`, end_time: `${day} 10:00`, notify: false });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal((await api.post('/blockouts', { provider_id: provider.id, start_time: `${day} 13:00`, end_time: `${day} 14:00`, reason: 'Lunch & learn' })).status, 201);
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  const tpl = await api.post('/day-templates', { provider_id: provider.id, name: 'Perfect day', weekdays: [wd], release_hours: 24, blocks: [{ label: 'Crowns', start_time: '10:00', end_time: '12:00', appointment_type_ids: [types.crown.id], goal: 200000 }] });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.data));

  // Every open start the search knows about (not just the ones shown) stays clear of all three.
  const practice = await h.db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const type = (await visitTypes(h.db, practice.id)).find((t) => t.kind === 'new_patient');
  const ctx = await searchContext(h.db, practice, type, {});
  const open = await openOn(h.db, ctx, day);
  const starts = [...(open.get(provider.id)?.values() || [])].map((x) => x.start);
  assert.ok(starts.length > 3, 'some times are open');
  for (const s of starts) {
    assert.ok(!overlaps(s, 60, `${day} 09:00`, `${day} 10:00`), `${s} overlaps the booked visit`);
    assert.ok(!overlaps(s, 60, `${day} 10:00`, `${day} 12:00`), `${s} overlaps the crown block`);
    assert.ok(!overlaps(s, 60, `${day} 13:00`, `${day} 14:00`), `${s} overlaps the blockout`);
  }
  // And through the public page.
  const res = await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.new_patient.id}&from=${day}&days=1`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const shown = res.data.days.find((d) => d.date === day)?.options || [];
  assert.ok(shown.length > 0 && shown.length <= 6);
  for (const o of shown) assert.ok(!overlaps(o.start, 60, `${day} 09:00`, `${day} 10:00`) && !overlaps(o.start, 60, `${day} 10:00`, `${day} 12:00`) && !overlaps(o.start, 60, `${day} 13:00`, `${day} 14:00`), o.start);
  // Crown prep itself may use its own block.
  const crownType = { ...type, appointment_type_id: types.crown.id, duration: 90 };
  const crownCtx = await searchContext(h.db, practice, crownType, {});
  const crownStarts = [...((await openOn(h.db, crownCtx, day)).get(provider.id)?.values() || [])].map((x) => x.start);
  assert.ok(crownStarts.includes(`${day} 10:00`));
});

test('smart ordering: times that fill a gap come first; slivers are dropped; production blocks are protected', () => {
  const opt = (start, score, prot = false) => ({ start, score, protected: prot, items: [{ start, provider_id: 1, provider_name: 'A' }] });
  const picked = pickForDay([opt('2030-01-07 08:00', 7), opt('2030-01-07 08:10', -5), opt('2030-01-07 10:00', 7), opt('2030-01-07 12:00', 1, true), opt('2030-01-07 14:00', 1), opt('2030-01-07 15:00', 4)], { kind: 'new_patient' });
  assert.deepEqual(picked.map((o) => o.start.slice(11)), ['08:00', '10:00', '14:00', '15:00']);
  assert.equal(picked.find((o) => o.best).start.slice(11), '08:00');
  // Emergencies simply see the earliest times.
  assert.equal(pickForDay([opt('2030-01-07 08:10', -5), opt('2030-01-07 09:00', 7)], { kind: 'emergency' })[0].start.slice(11), '08:10');
});

test('race at submit: two people, one time — the second hears it was just taken, with the nearest open times', async () => {
  const { slug, vt, book } = await setup();
  const day = weekdayAhead(5);
  const slots = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.new_patient.id}&from=${day}&days=1`)).data;
  const start = slots.days[0].options[0].start;
  const [a, b] = await Promise.all([
    book({ visit_type_id: vt.new_patient.id, start, people: [person('Ann', 'Racer')], email: 'ann@example.com' }),
    book({ visit_type_id: vt.new_patient.id, start, people: [person('Bob', 'Racer')], email: 'bob@example.com' }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409], JSON.stringify([a.data, b.data]));
  const lost = a.status === 409 ? a : b;
  assert.match(lost.data.error, /just taken/);
  assert.ok(lost.data.details.nearest.length > 0);
  assert.ok(lost.data.details.nearest.every((o) => o.start !== start));
  const n = await h.db.get("SELECT COUNT(*) AS n FROM appointments WHERE start_time = ? AND status = 'scheduled' AND practice_id = (SELECT id FROM practices WHERE slug = ?)", start, slug);
  assert.equal(n.n, 1);
});

test('emergency: held time is kept for emergencies, triage answers set the urgent flag, and the front desk is told', async () => {
  const { api, slug, vt, types, provider, book, practiceId } = await setup();
  await api.put(`/online-scheduling/visit-types/${vt.emergency.id}`, { appointment_type_id: types.em.id, max_days: 10, lead_minutes: 0 });
  const day = weekdayAhead(3);
  const held = await api.post('/blockouts', { provider_id: provider.id, start_time: `${day} 15:00`, end_time: `${day} 16:00`, reason: 'Emergency time', kind: 'reserved', appointment_type_ids: [types.em.id] });
  assert.equal(held.status, 201, JSON.stringify(held.data));
  const practice = await h.db.get('SELECT * FROM practices WHERE id = ?', practiceId);
  const all = await visitTypes(h.db, practice.id);
  const np = [...((await openOn(h.db, await searchContext(h.db, practice, all.find((t) => t.kind === 'new_patient'), {}), day)).get(provider.id)?.values() || [])].map((x) => x.start);
  assert.ok(np.every((s) => !overlaps(s, 60, `${day} 15:00`, `${day} 16:00`)), 'held time is not offered for other visits');
  const em = [...((await openOn(h.db, await searchContext(h.db, practice, all.find((t) => t.kind === 'emergency'), {}), day)).get(provider.id)?.values() || [])].map((x) => x.start);
  assert.ok(em.includes(`${day} 15:00`), 'held time is offered for emergencies');

  // Triage: required answers, checked on the server.
  const missing = await book({ visit_type_id: vt.emergency.id, start: `${day} 15:00`, people: [person('Eve', 'Ouch')], answers: { pain: 9 } });
  assert.equal(missing.status, 400);
  assert.throws(() => evalAnswers(TRIAGE, { pain: 11, swelling: false, trauma: false }), /0 to 10/);
  assert.equal(evalAnswers(TRIAGE, { pain: 3, swelling: false, trauma: false }).urgent, false);

  const res = await book({ visit_type_id: vt.emergency.id, start: `${day} 15:00`, people: [person('Eve', 'Ouch')], answers: { pain: 9, swelling: true, trauma: false }, source: { src: 'google' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.status, 'booked');
  assert.equal(res.data.urgent, true);
  assert.match(res.data.manage_url, /\/c\//);
  const ob = await h.db.get('SELECT * FROM online_bookings WHERE id = ?', res.data.id);
  assert.ok(JSON.parse(ob.flags).includes('urgent'));
  assert.equal(ob.source, 'google');
  const task = await h.db.get("SELECT * FROM tasks WHERE practice_id = ? AND title LIKE 'Urgent emergency booked online%'", practiceId);
  assert.ok(task && task.priority === 'high');
  const chat = await h.db.get("SELECT m.* FROM chat_messages m JOIN chat_channels c ON c.id = m.channel_id WHERE c.slug = 'front-desk' AND m.practice_id = ? ORDER BY m.id DESC", practiceId);
  assert.equal(chat.urgent, 1);
  assert.match(chat.body, /Eve Ouch.*Tooth pain/);
  assert.match(chat.body, /pain: 9/);
  const appt = await h.db.get('SELECT * FROM appointments WHERE online_booking_id = ?', res.data.id);
  assert.equal(appt.appointment_type_id, types.em.id);
  assert.equal(appt.start_time, `${day} 15:00`);
  // The booking is the patient's doing, in the audit trail.
  const log = await h.db.get("SELECT * FROM audit_log WHERE action = 'online_booking.booked' AND entity_id = ?", res.data.id);
  assert.equal(log.source, 'patient');
});

test('matching: an existing patient books on their chart; a near miss gets a new chart flagged as a possible duplicate, never merged', async () => {
  const { api, slug, vt, patient, hyg, book, practiceId } = await setup();
  await api.put(`/patients/${patient.id}`, { primary_hygienist_id: hyg.id });
  const day = weekdayAhead(6);
  const slots = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.hygiene.id}&from=${day}&days=1`)).data;
  assert.ok(slots.days[0].options[0].items[0].provider_name === 'Hana Hygienist', 'hygiene is with the hygienist');
  const mine = await book({ visit_type_id: vt.hygiene.id, start: slots.days[0].options[0].start, people: [person('Jane', 'Doe', '1985-04-12')], phone: '(512) 555-0100' });
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  assert.equal(mine.data.status, 'booked');
  const appt = await h.db.get('SELECT * FROM appointments WHERE online_booking_id = ?', mine.data.id);
  assert.equal(appt.patient_id, patient.id);
  assert.equal(appt.provider_id, hyg.id);

  // Same name, different birthday: a new chart and a flag — Jane's chart is untouched.
  const near = await book({ visit_type_id: vt.new_patient.id, start: (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.new_patient.id}&from=${day}&days=1`)).data.days[0].options[0].start, people: [person('Jane', 'Doe', '1991-01-01')], phone: '(512) 555-0100' });
  assert.equal(near.status, 201, JSON.stringify(near.data));
  const ob = await h.db.get('SELECT * FROM online_bookings WHERE id = ?', near.data.id);
  assert.ok(JSON.parse(ob.flags).includes('possible_duplicate'));
  const does = await h.db.all("SELECT id, dob, status FROM patients WHERE practice_id = ? AND last_name = 'Doe' ORDER BY id", practiceId);
  assert.equal(does.length, 2);
  assert.equal(does[0].dob, '1985-04-12');
  assert.equal(does[0].status, 'active');
  const br = await h.db.get('SELECT * FROM booking_requests WHERE online_booking_id = ?', near.data.id);
  assert.equal(br.possible_duplicate_id, patient.id);

  // Hygiene is for existing patients: someone who doesn't match waits as a request instead of being booked.
  const stranger = await book({ visit_type_id: vt.hygiene.id, start: slots.days[0].options.at(-1).start, people: [person('Zed', 'Nobody')] });
  assert.equal(stranger.status, 201, JSON.stringify(stranger.data));
  assert.equal(stranger.data.status, 'requested');
  assert.ok(JSON.parse((await h.db.get('SELECT flags FROM online_bookings WHERE id = ?', stranger.data.id)).flags).includes('not_matched'));
  assert.equal(await h.db.get('SELECT id FROM appointments WHERE online_booking_id = ?', stranger.data.id), undefined);
});

test('requested vs instant: a consult waits for the office and holds its time', async () => {
  const { api, slug, vt, book } = await setup();
  const day = weekdayAhead(7);
  const first = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.consult.id}&from=${day}&days=1`)).data.days[0].options[0];
  const res = await book({ visit_type_id: vt.consult.id, start: first.start, people: [person('Cal', 'Consult')], answers: { topic: 'Implants' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.status, 'requested');
  assert.equal(res.data.manage_url, undefined);
  const pending = (await api.get('/booking-requests')).data;
  assert.ok(pending.some((b) => b.first_name === 'Cal' && b.status === 'pending'));
  const again = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.consult.id}&from=${day}&days=1`)).data.days[0].options;
  assert.ok(!again.some((o) => o.start === first.start && o.items[0].provider_id === first.items[0].provider_id), 'the requested time is held');
  // The office accepts it from the usual queue.
  const b = pending.find((x) => x.first_name === 'Cal');
  const acc = await api.post(`/booking-requests/${b.id}/accept`, {});
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal((await h.db.get('SELECT online_booking_id FROM appointments WHERE id = ?', acc.data.appointment_id)).online_booking_id, res.data.id);
});

test('never blindsided: chat post, alert text, office text without names, Online bookings list with source', async () => {
  const { api, slug, vt, book } = await setup();
  const set = await api.put('/online-scheduling/settings', { notify_sms_to: '(512) 555-0777', brand_color: '#1d4ed8' });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  const day = weekdayAhead(8);
  const start = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.new_patient.id}&from=${day}&days=1`)).data.days[0].options[0].start;
  const before = h.sent.length;
  const res = await book({
    visit_type_id: vt.new_patient.id, start, people: [person('Nina', 'Newby')], email: 'nina@example.com',
    insurance: { carrier: 'Delta Dental', member_id: 'DD 123 456' }, source: { src: 'website', utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'spring', ref: 'https://www.smiles.example/contact' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const sent = h.sent.slice(before);
  const office = sent.find((m) => String(m.to).replace(/\D/g, '').endsWith('5125550777'));
  assert.ok(office, 'the office got a text');
  assert.doesNotMatch(office.body, /Nina|Newby/);
  assert.ok(sent.some((m) => m.to === 'nina@example.com' || String(m.to).replace(/\D/g, '').endsWith('5125550199')), 'the patient got a confirmation');
  const list = (await api.get('/online-scheduling/bookings?range=today')).data;
  const row = list.bookings.find((b) => b.id === res.data.id);
  assert.ok(row);
  assert.equal(row.source, 'website');
  assert.equal(row.utm_source, 'facebook');
  assert.equal(row.referrer_host, 'www.smiles.example');
  assert.equal(row.insurance_status, 'to_verify');
  assert.equal(row.people[0].new_patient, true);
  const one = (await api.get(`/online-scheduling/bookings/${res.data.id}`)).data;
  assert.match(one.alert, /Nina Newby booked New patient exam/);
  assert.match(one.alert, /New patient, insurance typed in/);
  assert.equal((await api.post(`/online-scheduling/bookings/${res.data.id}/seen`)).data.seen_at != null, true);
  // New patients get their health history and forms straight away.
  const forms = await h.db.get("SELECT COUNT(*) AS n FROM form_requests fr JOIN appointments a ON a.id = fr.appointment_id WHERE a.online_booking_id = ?", res.data.id);
  assert.ok(forms.n >= 1);
});

test('family back-to-back in one go', async () => {
  const { slug, vt, book, practiceId } = await setup();
  const day = weekdayAhead(9);
  const slots = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.new_patient.id}&from=${day}&days=1&people=2`)).data;
  const o = slots.days[0].options[0];
  assert.equal(o.items.length, 2);
  assert.equal(o.items[1].start, addMin(o.items[0].start, 60));
  const res = await book({ visit_type_id: vt.new_patient.id, start: o.start, people: [person('Pat', 'Family', '1980-01-01'), person('Kid', 'Family', '2015-06-06')], email: 'fam@example.com' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.visits.length, 2);
  const appts = await h.db.all('SELECT start_time, end_time FROM appointments WHERE online_booking_id = ? ORDER BY start_time', res.data.id);
  assert.equal(appts.length, 2);
  assert.equal(appts[0].end_time, appts[1].start_time);
  assert.ok(JSON.parse((await h.db.get('SELECT flags FROM online_bookings WHERE id = ?', res.data.id)).flags).includes('family'));
  // A type that isn't for families takes one person.
  const one = await book({ visit_type_id: vt.emergency.id, start: o.start, people: [person('A', 'B'), person('C', 'B')], answers: { pain: 1, swelling: false, trauma: false } });
  assert.equal(one.status, 400);
  assert.ok(practiceId);
});

test('idempotent submit: the same key twice books once', async () => {
  const { slug, vt, pub } = await setup();
  const day = weekdayAhead(10);
  const start = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.new_patient.id}&from=${day}&days=1`)).data.days[0].options[0].start;
  const body = { key: key(), visit_type_id: vt.new_patient.id, start, people: [person('Ida', 'Twice')], email: 'ida@example.com' };
  const [a, b] = await Promise.all([pub.post(`/public/os/${slug}/book`, body), pub.post(`/public/os/${slug}/book`, body)]);
  const c = await pub.post(`/public/os/${slug}/book`, body);
  assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.data, b.data]));
  assert.equal(c.status, 200);
  assert.equal(c.data.repeat, true);
  assert.equal(a.data.id, c.data.id);
  assert.equal(b.data.id, c.data.id);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM appointments WHERE online_booking_id = ?', c.data.id)).n, 1);
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM patients WHERE last_name = 'Twice'")).n, 1);
});

test('deposit and card on file for new patients (payments sandbox)', async () => {
  const { api, slug, vt, book } = await setup();
  const up = await api.put(`/online-scheduling/visit-types/${vt.new_patient.id}`, { deposit: 2500, deposit_rule: 'new_patients', card_rule: 'new_patients' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const day = weekdayAhead(11);
  const start = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.new_patient.id}&from=${day}&days=1`)).data.days[0].options[0].start;
  const res = await book({ visit_type_id: vt.new_patient.id, start, people: [person('Dee', 'Posit')], email: 'dee@example.com' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const appt = await h.db.get('SELECT * FROM appointments WHERE online_booking_id = ?', res.data.id);
  const pay = await h.db.get("SELECT * FROM ledger_entries WHERE patient_id = ? AND type = 'payment'", appt.patient_id);
  assert.equal(pay.amount, -2500);
  assert.ok(await h.db.get('SELECT id FROM payment_methods WHERE patient_id = ? AND provider = ?', appt.patient_id, 'sandbox'));
  const flags = JSON.parse((await h.db.get('SELECT flags FROM online_bookings WHERE id = ?', res.data.id)).flags);
  assert.ok(flags.includes('deposit_paid') && flags.includes('card_on_file'));
});

test('insurance card photo: filed in the chart for a person to read and confirm; never saved as a policy', async () => {
  const { slug, vt, book } = await setup();
  const day = weekdayAhead(12);
  const start = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.new_patient.id}&from=${day}&days=1`)).data.days[0].options[0].start;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');
  const res = await book({ visit_type_id: vt.new_patient.id, start, people: [person('Cara', 'Card')], email: 'cara@example.com', insurance: { card_front: { mime: 'image/jpeg', file_base64: jpeg } } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const appt = await h.db.get('SELECT * FROM appointments WHERE online_booking_id = ?', res.data.id);
  const doc = await h.db.get("SELECT * FROM documents WHERE patient_id = ? AND category = 'insurance_card'", appt.patient_id);
  assert.ok(doc);
  const upd = await h.db.get('SELECT * FROM insurance_updates WHERE patient_id = ?', appt.patient_id);
  assert.equal(upd.status, 'pending');
  assert.deepEqual(JSON.parse(upd.document_ids), [doc.id]);
  // Read in the background (the sandbox card reader here): filled into the pending update for a person to confirm.
  let read = null;
  for (let i = 0; i < 50 && !read?.member_id; i++) {
    await new Promise((r) => setTimeout(r, 40));
    read = await h.db.get('SELECT * FROM insurance_updates WHERE id = ?', upd.id);
  }
  assert.match(read.member_id, /^SBX/);
  assert.equal(read.status, 'pending');
  assert.match(read.note, /check against the photo/);
  const ai = await h.db.get("SELECT * FROM audit_log WHERE action = 'insurance_card.ai_read' AND entity = 'insurance_updates' AND entity_id = ?", upd.id);
  assert.equal(ai.source, 'ai');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM patient_insurance WHERE patient_id = ?', appt.patient_id)).n, 0);
  const bad = await book({ visit_type_id: vt.new_patient.id, start, people: [person('Bad', 'Card')], insurance: { card_front: { mime: 'image/jpeg', file_base64: Buffer.from('<svg/>').toString('base64') } } });
  assert.equal(bad.status, 400);
});

test('analytics: funnel, sources and $ scheduled — and no personal details anywhere in it', async () => {
  const { api, slug, vt, book, practiceId } = await setup();
  const session = 'sess_abcdef123456';
  for (const step of ['view', 'reason', 'time', 'details']) {
    assert.equal((await h.client().post(`/public/os/${slug}/events`, { session, step, kind: 'new_patient', source: 'google', variant: 'b', name: 'Should Not Store' })).status, 204);
  }
  assert.equal((await h.client().post(`/public/os/${slug}/events`, { session, step: 'booked' })).status, 400); // only the server records bookings
  const day = weekdayAhead(13);
  const start = (await h.client().get(`/public/os/${slug}/slots?visit_type_id=${vt.new_patient.id}&from=${day}&days=1`)).data.days[0].options[0].start;
  const res = await book({ session, visit_type_id: vt.new_patient.id, start, people: [person('Priv', 'Acy', '1970-07-07')], email: 'priv@example.com', source: { src: 'google', variant: 'b' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const a = (await api.get('/online-scheduling/analytics')).data;
  assert.equal(a.steps.find((s) => s.step === 'view').sessions, 1);
  assert.equal(a.steps.find((s) => s.step === 'booked').sessions, 1);
  assert.equal(a.conversion, 100);
  assert.equal(a.by_source.find((s) => s.source === 'google').bookings, 1);
  assert.equal(a.by_variant.find((s) => s.variant === 'b').bookings, 1);
  assert.equal(a.visits_booked, 1);
  const text = JSON.stringify(a);
  for (const pii of ['Priv', 'Acy', 'priv@example.com', '1970-07-07', 'Should Not Store']) assert.ok(!text.includes(pii), `analytics leaked ${pii}`);
  const rows = await h.db.all('SELECT * FROM online_booking_events WHERE practice_id = ?', practiceId);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at', 'day', 'id', 'practice_id', 'session_key', 'source', 'step', 'variant', 'visit_kind']);
  assert.ok(!JSON.stringify(rows).includes('Priv'));
  // Sources are short slugs only.
  assert.deepEqual(cleanSource({ src: 'https://evil.example/?email=a@b.c', utm_source: 'news letter' }).source, 'direct');
});

test('practice isolation: one practice’s bookings, types and settings are invisible to another', async () => {
  const a = await setup();
  const b = await setup();
  const day = weekdayAhead(14);
  const start = (await h.client().get(`/public/os/${a.slug}/slots?visit_type_id=${a.vt.new_patient.id}&from=${day}&days=1`)).data.days[0].options[0].start;
  const res = await a.book({ visit_type_id: a.vt.new_patient.id, start, people: [person('Iso', 'Lated')], email: 'iso@example.com' });
  assert.equal(res.status, 201);
  assert.equal((await b.api.get(`/online-scheduling/bookings/${res.data.id}`)).status, 404);
  assert.ok(!(await b.api.get('/online-scheduling/bookings?range=month')).data.bookings.some((x) => x.id === res.data.id));
  assert.equal((await b.api.put(`/online-scheduling/visit-types/${a.vt.new_patient.id}`, { duration: 30 })).status, 404);
  // Practice A's visit type can't be booked on practice B's page.
  const cross = await b.book({ visit_type_id: a.vt.new_patient.id, start, people: [person('X', 'Y')] });
  assert.equal(cross.status, 400);
  assert.equal((await h.client().get(`/public/os/${b.slug}/slots?visit_type_id=${a.vt.new_patient.id}`)).status, 400);
  // Only administrators change settings.
  const staff = await a.api.post('/users', { name: 'Front Desk', email: `fd${Date.now()}@example.com`, password: 'correct-horse-battery', role: 'front_desk' });
  if (staff.status === 201) {
    const login = await h.client().post('/auth/login', { email: staff.data.email, password: 'correct-horse-battery' });
    if (login.data.token) assert.equal((await h.client(login.data.token).put('/online-scheduling/settings', { brand_color: '#000000' })).status, 403);
  }
});

test('embed: /embed.js loader and a framable booking page', async () => {
  const js = await fetch(`${h.origin}/embed.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const text = await js.text();
  assert.match(text, /DentalMachineBooking/);
  assert.match(text, /aria-modal/);
  assert.doesNotMatch(text, /localStorage|document\.cookie/);
});

test('bot protection: honeypot is dropped quietly; booking is rate limited', async () => {
  const { slug, vt, book } = await setup();
  const res = await book({ website: 'http://spam.example', visit_type_id: vt.new_patient.id, start: `${weekdayAhead(3)} 09:00`, people: [person('Bot', 'Spam')] });
  assert.equal(res.status, 201);
  assert.equal(await h.db.get("SELECT id FROM booking_requests WHERE last_name = 'Spam'"), undefined);
  let limited = false;
  for (let i = 0; i < 70 && !limited; i++) limited = (await h.client().post(`/public/os/${slug}/book`, { key: key() })).status === 429;
  assert.ok(limited, 'booking is rate limited');
});
