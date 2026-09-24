// Phones PH6: the call screen that books while you talk (docs/workflows/specs/PH-phones.md). A call comes in the way
// Twilio sends it (a signed webhook); the pop opens the patient with "Next openings"; the caller's words arrive
// through the sandbox live transcription and the list filters; one click books. Budget: ≤ 3 actions from the ring
// to a booked visit (with live transcription it's 1), and the same with the quick filter chips instead.
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget } from '../lib/budget.mjs';

const TOKEN = 'e2e-twilio-token';
process.env.TWILIO_AUTH_TOKEN = TOKEN;
process.env.LIVE_TRANSCRIPTION = 'sandbox';
const VOICE = '+15125559470';
const ALWAYS_OPEN = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '23:59']]]));
const sign = (url, params) => createHmac('sha1', TOKEN).update(Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url)).digest('base64');
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);

let app; let browser; let s; let callers; let dentist;
let seq = 0;
const ring = async (from) => {
  const url = `${app.base}/api/webhooks/twilio/voice/inbound`;
  const params = { CallSid: `CAph${Date.now()}${++seq}`, From: from, To: VOICE };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(url, params) }, body: new URLSearchParams(params) });
  assert.equal(r.status, 200);
};
const surname = (name) => name.replace(/,.*$/, '').replace(/^(dr|doctor)\.?\s+/i, '').trim().split(/\s+/).pop();

before(async () => {
  app = await startApp({ entry: 'e2e/lib/phones-app.mjs' });
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  await s.api('PUT', '/practice', { voice_number: VOICE, forward_to: '+15125551111', office_hours: ALWAYS_OPEN });
  const providers = await s.get('/providers');
  dentist = (providers.rows || providers).find((p) => p.type === 'dentist' && p.active !== 0);
  await s.api('PUT', `/providers/${dentist.id}`, { working_hours: null });
  const list = await s.get('/patients?limit=200');
  const rows = list.rows || list;
  const count = new Map();
  for (const p of rows) if (p.phone) count.set(digits(p.phone), (count.get(digits(p.phone)) || 0) + 1);
  callers = rows.filter((p) => p.phone && digits(p.phone).length === 10 && count.get(digits(p.phone)) === 1).slice(0, 2);
  assert.equal(callers.length, 2, 'demo data has patients with their own numbers');
});
after(async () => { await browser?.close(); await app?.stop(); });

const popFor = async (page, patient) => {
  const pop = page.locator(`.call-pop:has-text("${patient.last_name}")`);
  await pop.waitFor();
  await pop.locator('.next-openings .slot').first().waitFor();
  return { pop, callId: Number(await pop.getAttribute('data-call')) };
};

test('PH6 with live transcription: ring → the pop filters to "Thursday afternoon with Dr …" as the caller says it → one click books (≤ 3 actions)', async () => {
  const { page } = s;
  const who = callers[0];
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(600); // the live stream connects
  await ring(who.phone);
  const { pop, callId } = await popFor(page, who);
  // The caller talks (the provider's live transcription, here the sandbox): the list narrows by itself.
  const said = `Hi, do you have anything Thursday afternoon with Dr ${surname(dentist.name)}?`;
  await s.post(`/phones/calls/${callId}/sandbox-speech`, { script: [{ track: 'caller', text: said }] });
  await pop.locator('.next-openings-heard.is-heard').waitFor();
  await page.waitForFunction((id) => {
    const slots = [...document.querySelectorAll(`.call-pop[data-call="${id}"] .next-openings .slot`)];
    return slots.length > 0 && slots.every((b) => new Date(`${b.dataset.start.slice(0, 10)}T12:00:00Z`).getUTCDay() === 4 && b.dataset.start.slice(11) >= '12:00');
  }, callId);
  const first = pop.locator('.next-openings .slot').first();
  const start = await first.getAttribute('data-start');
  assert.equal(Number(await first.getAttribute('data-provider')), dentist.id);
  const r = await measure(page, async () => {
    await first.click();
    await page.waitForSelector('.call-pop-note:has-text("Booked on this call")');
  });
  console.log(withinBudget('PH6 ring → booked (live)', r, { actions: 3, ms: 5000 }));
  const call = await s.get(`/calls/${callId}`);
  assert.ok(call.appointment_id, 'the call carries its booking');
  const visit = await s.get(`/appointments/${call.appointment_id}`);
  assert.deepEqual([visit.patient_id, visit.start_time, visit.provider_id], [who.id, start, dentist.id]);
});

test('PH6 without live transcription: the quick filter row — Fri, AM — then one click (≤ 3 actions)', async () => {
  const { page } = s;
  const who = callers[1];
  await page.goto(`${app.base}/schedule`);
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(600);
  await ring(who.phone);
  const { pop, callId } = await popFor(page, who);
  const r = await measure(page, async () => {
    await pop.locator('.next-openings-chips .chip', { hasText: /^Fri$/ }).click();
    await pop.locator('.next-openings-chips .chip', { hasText: /^AM$/ }).click();
    await page.waitForFunction((id) => {
      const slots = [...document.querySelectorAll(`.call-pop[data-call="${id}"] .next-openings .slot`)];
      return slots.length > 0 && slots.every((b) => new Date(`${b.dataset.start.slice(0, 10)}T12:00:00Z`).getUTCDay() === 5 && b.dataset.start.slice(11) < '12:00');
    }, callId);
    await pop.locator('.next-openings .slot').first().click();
    await page.waitForSelector(`.call-pop[data-call="${callId}"] .call-pop-note:has-text("Booked on this call")`);
  });
  console.log(withinBudget('PH6 ring → booked (chips)', r, { actions: 3, ms: 6000 }));
  const call = await s.get(`/calls/${callId}`);
  assert.ok(call.appointment_id, 'booked on the call');
  assert.deepEqual(s.errors, [], 'no page errors or dialogs');
});
