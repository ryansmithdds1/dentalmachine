import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.js';
import { runCampaigns } from '../src/campaigns.js';

const h = harness();

async function setup() {
  const ctx = await h.practice({ timezone: 'UTC' });
  const { api, patient } = ctx;
  const kid = (await api.post('/patients', { first_name: 'Tim', last_name: 'Doe', phone: '(512) 555-0100', guarantor_id: patient.id })).data; // same phone as Jane
  const emailOnly = (await api.post('/patients', { first_name: 'Eve', last_name: 'Mail', email: 'eve@example.com' })).data;
  const optedOut = (await api.post('/patients', { first_name: 'Olly', last_name: 'Out', phone: '5125550199', sms_opt_in: false })).data;
  const nobody = (await api.post('/patients', { first_name: 'No', last_name: 'Contact' })).data;
  return { ...ctx, kid, emailOnly, optedOut, nobody };
}

test('preview: segment, one message per phone, opted-out and unreachable skipped', async () => {
  const { api } = await setup();
  const segs = (await api.get('/campaigns/segments')).data;
  assert.ok(segs.segments.reactivation.params.length);
  const p = (await api.post('/campaigns/preview', { segment: 'all_active', channel: 'auto', body: 'Hi {first_name}! {practice} is closed Monday.' })).data;
  assert.equal(p.patients, 5);
  assert.equal(p.recipients, 2); // Jane's family by text, Eve by email
  assert.equal(p.duplicates, 1);
  assert.equal(p.unreachable, 2);
  assert.deepEqual([p.sms, p.email], [1, 1]);
  assert.match(p.sample, /^Hi Jane! Practice \d+ is closed Monday\. Reply STOP to opt out\.$/);
  assert.equal((await api.post('/campaigns/preview', { segment: 'all_active', body: 'Hi {last_name}' })).status, 400);
  assert.equal((await api.post('/campaigns/preview', { segment: 'nope' })).status, 400);
  const bday = (await api.post('/campaigns/preview', { segment: 'birthdays', params: { month: 4 } })).data;
  assert.equal(bday.patients, 1); // Jane, born in April
});

test('segments: reactivation and unscheduled treatment leave out anyone already booked', async () => {
  const { api, patient, emailOnly, provider } = await setup();
  await h.db.run("UPDATE patients SET created_at = '2019-01-01 00:00:00' WHERE id IN (?, ?)", patient.id, emailOnly.id);
  let r = (await api.post('/campaigns/preview', { segment: 'reactivation', params: { months: 18 } })).data;
  assert.equal(r.patients, 2);
  const d = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  await api.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${d} 10:00`, end_time: `${d} 11:00`, override_blockout: true });
  r = (await api.post('/campaigns/preview', { segment: 'reactivation', params: { months: 18 } })).data;
  assert.equal(r.patients, 1);
  await api.post(`/patients/${emailOnly.id}/procedures`, { code: 'D2391', tooth: '30', surfaces: 'O', provider_id: provider.id });
  r = (await api.post('/campaigns/preview', { segment: 'unscheduled_treatment' })).data;
  assert.deepEqual(r.list.map((x) => x.first_name), ['Eve']);
});

test('sending: waits for daytime, sends once, emails carry an unsubscribe link that works', async () => {
  const { api, patient, emailOnly } = await setup();
  const c = (await api.post('/campaigns', { name: 'Closed Monday', segment: 'all_active', channel: 'auto', subject: 'Office closed', body: 'Hi {first_name}, {practice} is closed Monday. Book online: {booking_link}' })).data;
  assert.equal(c.status, 'draft');
  // Scheduled a minute ahead, so it waits for the runs below (tomorrow night, then tomorrow at noon) whatever the time now.
  await api.post(`/campaigns/${c.id}/send`, { send_at: new Date(Date.now() + 60_000).toISOString() });
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const [lateNight, midday] = [new Date(`${tomorrow}T02:30:00Z`), new Date(`${tomorrow}T15:00:00Z`)];
  const before = h.sent.length;
  assert.equal(await runCampaigns(h.db, h.messenger, { appUrl: 'https://app.example.com', campaignId: c.id, now: lateNight }), 0); // quiet hours
  assert.equal(await runCampaigns(h.db, h.messenger, { appUrl: 'https://app.example.com', campaignId: c.id, now: midday }), 2);
  assert.equal(await runCampaigns(h.db, h.messenger, { appUrl: 'https://app.example.com', campaignId: c.id, now: midday }), 0);
  const out = h.sent.slice(before);
  assert.equal(out.length, 2);
  const text = out.find((m) => m.channel === 'sms');
  assert.match(text.body, /^Hi Jane, Practice \d+ is closed Monday\. .* Reply STOP to opt out\.$/);
  const email = out.find((m) => m.channel === 'email');
  assert.equal(email.subject, 'Office closed');
  const token = /\/u\/([\w-]+)/.exec(email.body)[1];
  const detail = (await api.get(`/campaigns/${c.id}`)).data;
  assert.equal(detail.status, 'sent');
  assert.equal(detail.sent_count, 2);
  assert.equal((await api.post(`/campaigns/${c.id}/send`)).status, 409);

  const pub = h.client();
  assert.equal((await pub.get(`/public/unsubscribe/${token}`)).data.done, false);
  assert.equal((await pub.post(`/public/unsubscribe/${token}`)).data.done, true);
  assert.equal((await api.get(`/patients/${emailOnly.id}`)).data.email_opt_in, 0);
  assert.equal((await api.get(`/patients/${patient.id}`)).data.sms_opt_in, 1);
  assert.equal((await api.get(`/campaigns/${c.id}`)).data.unsubscribed, 1);
});

test('cancelling a scheduled campaign stops it', async () => {
  const { api } = await setup();
  const c = (await api.post('/campaigns', { name: 'Later', segment: 'all_active', body: 'Hi {first_name}' })).data;
  await api.post(`/campaigns/${c.id}/send`, { send_at: '2099-01-01T15:00:00Z' });
  assert.equal((await api.post(`/campaigns/${c.id}/cancel`)).data.status, 'cancelled');
  assert.equal(await runCampaigns(h.db, h.messenger, { appUrl: 'x', campaignId: c.id, now: new Date('2099-01-01T16:00:00Z') }), 0);
});

test('a campaign with a blank left in it ("[date]") cannot be sent or scheduled, and one already scheduled goes back to a draft', async () => {
  const { api } = await setup();
  const body = 'Hi {first_name}, {practice} will be closed on [date]. Call {phone}.';
  const p = (await api.post('/campaigns/preview', { segment: 'all_active', channel: 'auto', body })).data;
  assert.deepEqual(p.placeholders, ['[date]']);
  assert.match(p.sample, /\[date\]/, 'the preview shows the real message, blank included');
  // A draft can keep the blank while the office works on it…
  const c = (await api.post('/campaigns', { name: 'Closed', segment: 'all_active', channel: 'auto', body })).data;
  assert.equal(c.status, 'draft');
  const before = h.sent.length;
  // …but it can't be sent, now or later, and nothing goes out.
  const now = await api.post(`/campaigns/${c.id}/send`, {});
  assert.equal(now.status, 400);
  assert.match(now.data.error, /still says “\[date\]” — replace it with the real details/);
  assert.deepEqual(now.data.details.placeholders, ['[date]']);
  assert.equal((await api.post(`/campaigns/${c.id}/send`, { send_at: new Date(Date.now() + 3600_000).toISOString() })).status, 400);
  assert.equal((await api.get(`/campaigns/${c.id}`)).data.status, 'draft');
  assert.equal(h.sent.length, before);
  // Blank underscores too, and in an email subject.
  assert.deepEqual((await api.post('/campaigns/preview', { segment: 'all_active', channel: 'email', subject: 'Closed on ____', body: 'Hi {first_name}' })).data.placeholders, ['____']);
  // Filled in: it goes.
  assert.equal((await api.put(`/campaigns/${c.id}`, { body: body.replace('[date]', 'Monday, Nov 11') })).status, 200);
  const later = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await api.post(`/campaigns/${c.id}/send`, { send_at: later })).status, 200);
  // A scheduled campaign can't be edited back to having a blank in it.
  assert.equal((await api.put(`/campaigns/${c.id}`, { body })).status, 400);
  // One scheduled with a blank some other way (from before this check) is caught when it starts: back to a
  // draft, and a Needs attention item says why — nothing sent.
  await h.db.run('UPDATE campaigns SET body = ? WHERE id = ?', body, c.id);
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  assert.equal(await runCampaigns(h.db, h.messenger, { appUrl: 'https://app.example.com', campaignId: c.id, now: new Date(`${tomorrow}T15:00:00Z`) }), 0);
  assert.equal((await api.get(`/campaigns/${c.id}`)).data.status, 'draft');
  assert.equal(h.sent.length, before);
  const issue = await h.db.get("SELECT * FROM issues WHERE dedupe_key = ?", `campaign-blanks:${c.id}`);
  assert.ok(issue, 'a work item in Needs attention');
  assert.match(issue.title, /wasn’t sent: fill in \[date\]/);
});
