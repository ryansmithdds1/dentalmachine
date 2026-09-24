// Consents and paperwork (C3, P3): a consent sent to the office iPad at the chair and signed there in ≤ 3 staff
// actions, and the kiosk flow (no birth date, Spanish, live "form 1 of 2" for staff, clears itself when done).
// Spec: docs/workflows/specs/C-consents.md. Needs routes/consents.js, routes/paperwork.js and
// routes/paperworkpublic.js mounted and the /kiosk route in App.jsx; until then the tests skip with a note.
/* global window */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let patient; let appt; let kioskPage; let ready = false;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// What the patient does on their own phone, done here through the API: sign the given forms from a QR link.
async function signByLink(url, dob, fill) {
  const token = url.split('/p/')[1];
  return s.page.evaluate(async ([t, birth, fillSrc]) => {
    const fillFn = new Function(`return (${fillSrc})`)(); // eslint-disable-line no-new-func
    const j = async (m, p, b, h = {}) => (await fetch(`/api/public${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined })).json();
    const { pass } = await j('POST', `/papers/${t}/verify`, { dob: birth });
    const h = { 'X-Form-Pass': pass };
    const view = await j('GET', `/papers/${t}`, null, h);
    for (const f of view.forms) {
      if (f.kind === 'medical_history') await j('POST', `/papers/${t}/history`, { answers: { consent_hipaa: true, consent_treatment: true }, signature_name: 'Pat Chairside' }, h);
      else await j('POST', `/papers/${t}/forms/${f.id}`, { answers: fillFn(f.fields.en), signature_name: 'Pat Chairside', version_id: f.version_id }, h);
    }
    return view.forms.length;
  }, [token, dob, fill.toString()]);
}
const fillAll = (fields) => {
  const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const a = {};
  for (const f of fields) if (f.key && f.required) a[f.key] = f.type === 'checkbox' ? true : f.type === 'yesno' ? 'no' : f.type === 'signature' ? sig : f.type === 'select' ? f.options[0] : f.type === 'initials' ? 'PC' : 'x';
  return a;
};

async function sign(page) {
  const pad = page.locator('canvas.signature-pad').last();
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + 20 + i * 25, box.y + 40 + (i % 2 ? 20 : -10));
  await page.mouse.up();
}

before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  ready = (await s.get('/consents/library'))?.length === 10;
  if (!ready) return;
  await s.post('/consents/library/install', { all: true });
  patient = await s.post('/patients', { first_name: 'Pat', last_name: 'Chairside', dob: '1979-05-06', phone: '(512) 555-0142', email: 'pat.chairside@example.com' });
  const proc = await s.post(`/patients/${patient.id}/procedures`, { code: 'D7140', tooth: '3' });
  const provider = (await s.get('/providers'))[0];
  appt = await s.post('/appointments', { patient_id: patient.id, provider_id: provider.id, start_time: `${day(1)} 06:00`, end_time: `${day(1)} 06:30`, procedure_ids: [proc.id], override_blockout: true });
  assert.ok(appt.id, JSON.stringify(appt));
  // An established patient: their health history and policies are already on file, so only the consent is due.
  const due = await s.get(`/appointments/${appt.id}/paperwork`);
  const other = due.items.filter((i) => i.kind !== 'consent' && i.status !== 'done');
  const qr = await s.post(`/patients/${patient.id}/paperwork/send`, { history: other.some((i) => i.kind === 'medical_history'), template_ids: other.filter((i) => i.template_id).map((i) => i.template_id), channel: 'qr' });
  await signByLink(qr.url, '1979-05-06', fillAll);
  // The office iPad, set up once as a kiosk.
  const k = await s.post('/forms-kiosks', { name: 'Op 1 iPad' });
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 1300 }, hasTouch: false });
  await ctx.addInitScript((t) => { try { window.localStorage.setItem('dm_forms_kiosk', t); } catch { /* ignore */ } }, k.token);
  kioskPage = await ctx.newPage();
  kioskPage.setDefaultTimeout(15_000);
  await kioskPage.goto(`${app.base}/kiosk`);
  await kioskPage.waitForSelector('[data-kiosk-ready]');
});
after(async () => { await browser?.close(); await app?.stop(); });

test('C3 consent at the chair: sent to the iPad in ≤ 3 staff actions, signed there, chart updated', async (t) => {
  if (!ready) { t.skip('consent routes not mounted yet (see docs/workflows/specs/C-consents.md)'); return; }
  const { page } = s;
  await page.goto(`${app.base}/patients/${patient.id}`);
  await page.waitForSelector('text=Chairside');
  await page.waitForTimeout(300);
  const r = await measure(page, async () => {
    await page.keyboard.press(`${MOD}+k`);
    await page.waitForSelector('.palette input');
    await page.keyboard.type('ipad');
    await page.waitForSelector('.palette >> text=Hand iPad to Pat Chairside');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast:has-text("on Op 1 iPad for Pat")');
  });
  console.log(withinBudget('C3 consent to the iPad at the chair', r, { actions: 3, ms: 6000 }));

  // The patient, on the iPad: no birth date, the consent filled in with their treatment.
  const k = kioskPage;
  await k.waitForSelector('text=Hi Pat!');
  await k.click('button:has-text("Start")');
  await k.waitForSelector('h1:has-text("Consent for tooth extraction")');
  assert.ok(await k.isVisible('text=D7140'), 'the procedure is filled in');
  await k.click('.pw-seg button:has-text("No")');
  for (const box of await k.locator('.pw-check input[type=checkbox]').all()) await box.check();
  await k.fill('.pw-field input[autocomplete=name]', 'Pat Chairside');
  await sign(k);
  await k.click('button:has-text("Sign and continue")');
  await k.waitForSelector('text=All done — thank you!');
  const check = await s.get(`/appointments/${appt.id}/consent-check`);
  assert.equal(check.ready, true, JSON.stringify(check));
  const consents = await s.get(`/patients/${patient.id}/consents`);
  const signed = consents.find((c) => c.status === 'signed');
  assert.equal(signed.signed_via, 'kiosk');
  assert.ok(signed.document_id, 'signed PDF filed on the chart');
  // The iPad clears itself.
  await k.waitForSelector('[data-kiosk-ready]', { timeout: 15_000 });
  assert.deepEqual(s.errors, []);
});

test('P3 kiosk: forms loaded for the patient, Spanish, live progress for staff, clears when done', async (t) => {
  if (!ready) { t.skip('consent routes not mounted yet'); return; }
  const { page } = s;
  const fin = (await s.get('/form-templates')).find((x) => x.name === 'Financial policy');
  await page.goto(`${app.base}/patients/${patient.id}`);
  await page.waitForSelector('text=Chairside');
  // Forms & consents panel (Alt+F): hand over the history update and the financial policy.
  await s.post(`/patients/${patient.id}/paperwork/send`, { history: true, template_ids: [fin.id], channel: 'kiosk' });
  await page.waitForTimeout(300);
  await page.keyboard.press('Alt+f');
  await page.waitForSelector('.cp-panel');
  await page.waitForSelector('.cp-live:has-text("Waiting for Pat")');
  const k = kioskPage;
  await k.waitForSelector('text=Hi Pat!');
  await k.click('.pw-lang button:has-text("Español")');
  await k.waitForSelector('text=¡Hola, Pat!');
  await k.click('button:has-text("Empezar")');
  await page.waitForSelector('.cp-live:has-text("form 1 of 2")');
  // Health history (Spanish): the two acknowledgements, name, signature.
  await k.waitForSelector('h1:has-text("Historial de salud")');
  const checks = k.locator('.pw-check input[type=checkbox]');
  const n = await checks.count();
  await checks.nth(n - 2).check();
  await checks.nth(n - 1).check();
  await k.fill('.pw-field input[autocomplete=name]', 'Pat Chairside');
  await sign(k);
  await k.click('button:has-text("Firmar y continuar")');
  await page.waitForSelector('.cp-live:has-text("form 2 of 2")');
  await k.waitForSelector('h1:has-text("Financial policy")');
  for (const input of await k.locator('.pw-initials input').all()) await input.fill('PC');
  await k.fill('.pw-field input[autocomplete=name]', 'Pat Chairside');
  await sign(k);
  await k.click('button:has-text("Firmar y continuar")');
  await k.waitForSelector('text=¡Listo, gracias!');
  await page.waitForSelector('.cp-live:has-text("finished on the iPad")');
  await k.waitForSelector('[data-kiosk-ready]', { timeout: 15_000 });
  assert.ok(await k.isVisible('text=Welcome'), 'back to the home screen, in English, nothing left on screen');
  const forms = await s.get(`/appointments/${appt.id}/paperwork`);
  assert.equal(forms.summary.state, 'done', JSON.stringify(forms.items));
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});
