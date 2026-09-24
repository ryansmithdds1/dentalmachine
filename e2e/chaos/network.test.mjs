// Chaos: the network at its worst during the saves that matter.
//  - The connection drops mid-save after the server already saved (the answer is lost): the app keeps the
//    change and, back online, sends it again — and the server's idempotency keeps it to ONE note / payment.
//  - Card payments can't wait offline: a clear message, and the amount is still there.
//  - A slow server: the save button can't be pressed into a second payment or note.
//  - Double-clicks on money and claim buttons: one payment, one claim.
//  - The session expires mid-work: back to sign-in (no crash, no blank page), and signing in again works.
/* global document, sessionStorage */
import { test, before, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { quiet, tokenFor } from '../lib/watch.mjs';

let app; let browser; let s; let provider; let carrier; let token;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  token = await tokenFor(app.base, 'admin@demo.dentalmachine.app'); // checks from outside the browser, whatever its network
  [provider] = await s.get('/providers?active=true');
  carrier = await s.post('/carriers', { name: 'Chaos Dental', payer_id: '99997' });
});
after(async () => { await browser?.close(); await app?.stop(); });
afterEach(async () => { await s.ctx.setOffline(false); await s.page.unrouteAll({ behavior: 'ignoreErrors' }); });
const server = (path) => fetch(`${app.base}/api${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());

let n = 0;
async function patientOwing() {
  const p = await s.post('/patients', { first_name: `Chaos${++n}`, last_name: 'Netwell', dob: '1980-01-02' });
  await s.post(`/patients/${p.id}/procedures`, { code: 'D0120', provider_id: provider.id, complete: true });
  return p;
}
const payments = async (pid) => (await server(`/patients/${pid}/ledger`)).entries.filter((e) => e.type === 'payment' && !e.voided_at);
const notes = async (pid, text) => (await server(`/patients/${pid}/notes`)).filter((x) => x.body.includes(text));
async function openPayment(pid, method) {
  await s.api('PUT', '/me/prefs/payment.method', { value: method });
  await s.page.goto(`${app.base}/patients/${pid}?tab=ledger&pay=1`);
  await s.page.waitForSelector('.inline-panel[aria-label="Take payment"] button.primary');
  await quiet(s.page);
}
const payButton = () => s.page.locator('.inline-panel[aria-label="Take payment"] button.primary');
const noteBox = '[aria-label="Type what to add"]';
async function openNotes(pid) {
  await s.page.goto(`${app.base}/patients/${pid}?tab=notes`);
  await s.page.waitForSelector(noteBox);
  await quiet(s.page);
}
// The server answers, but the answer never arrives: the connection drops as it comes back.
async function loseTheAnswer(pattern) {
  let hit = false;
  await s.page.route(pattern, async (route) => {
    if (hit || route.request().method() !== 'POST') return route.continue();
    hit = true;
    await route.fetch(); // the server does the work…
    await s.ctx.setOffline(true); // …and the connection is gone before the answer gets back
    await route.abort('internetdisconnected');
  });
  return () => s.page.unroute(pattern);
}

describe('offline mid-save', () => {
  test('a note saved as the connection drops is kept, sent when back online, and saved once', async () => {
    const p = await patientOwing();
    await openNotes(p.id);
    const text = `offline mid save ${Date.now()}`;
    const unroute = await loseTheAnswer(`**/api/patients/${p.id}/notes`);
    await s.page.fill(noteBox, text);
    await s.page.keyboard.press('Control+Enter');
    await s.page.waitForSelector('.offline-banner', { timeout: 8000 });
    assert.equal((await notes(p.id, 'Offline mid save')).length + (await notes(p.id, text)).length, 1, 'the server has it once so far');
    await s.ctx.setOffline(false);
    await s.page.waitForSelector('.offline-banner', { state: 'detached', timeout: 30_000 });
    await unroute();
    const saved = [...await notes(p.id, 'Offline mid save'), ...await notes(p.id, text)];
    assert.equal(saved.length, 1, `one note, not two: ${JSON.stringify(saved.map((x) => x.id))}`);
  });

  test('a cash payment taken as the connection drops is posted once', async () => {
    const p = await patientOwing();
    await openPayment(p.id, 'cash');
    const before = (await payments(p.id)).length;
    const unroute = await loseTheAnswer(`**/api/patients/${p.id}/payments`);
    await payButton().click();
    await s.page.waitForSelector('.offline-banner', { timeout: 8000 });
    await s.ctx.setOffline(false);
    await s.page.waitForSelector('.offline-banner', { state: 'detached', timeout: 30_000 });
    await unroute();
    assert.equal((await payments(p.id)).length, before + 1, 'posted once');
  });

  test('a card payment offline says it needs the internet and keeps the amount', async () => {
    const p = await patientOwing();
    await openPayment(p.id, 'card');
    const amount = await s.page.inputValue('[aria-label="Payment amount"]');
    await s.ctx.setOffline(true);
    await payButton().click();
    await s.page.waitForSelector('.inline-panel[aria-label="Take payment"] .error', { timeout: 8000 });
    assert.match(await s.page.textContent('.inline-panel[aria-label="Take payment"] .error'), /internet/i);
    assert.equal(await s.page.inputValue('[aria-label="Payment amount"]'), amount, 'the amount is still there');
    await s.ctx.setOffline(false);
    await s.page.waitForTimeout(500);
    await payButton().click();
    await s.page.waitForSelector('.inline-panel[aria-label="Take payment"]', { state: 'detached', timeout: 10_000 });
    assert.equal((await payments(p.id)).length, 1);
  });
});

describe('a slow server', () => {
  test('pressing Post payment again while it saves does not post twice', async () => {
    const p = await patientOwing();
    await openPayment(p.id, 'cash');
    await s.page.route(`**/api/patients/${p.id}/payments`, async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
    await payButton().click();
    await payButton().click({ force: true, timeout: 1000 }).catch(() => {});
    await s.page.keyboard.press('Enter');
    assert.ok(await payButton().isDisabled(), 'the button says it is busy');
    await s.page.waitForSelector('.inline-panel[aria-label="Take payment"]', { state: 'detached', timeout: 15_000 });
    await s.page.unroute(`**/api/patients/${p.id}/payments`);
    assert.equal((await payments(p.id)).length, 1);
  });

  test('saving a note twice while the server is slow saves it once', async () => {
    const p = await patientOwing();
    await openNotes(p.id);
    const text = `slow save ${Date.now()}`;
    await s.page.route(`**/api/patients/${p.id}/notes`, async (route) => { if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
    await s.page.fill(noteBox, text);
    await s.page.keyboard.press('Control+Enter');
    await s.page.keyboard.press('Control+Enter');
    await s.page.waitForFunction(() => !document.querySelector('[aria-label="Type what to add"]')?.value, null, { timeout: 15_000 });
    await s.page.waitForTimeout(500);
    await s.page.unroute(`**/api/patients/${p.id}/notes`);
    assert.equal([...await notes(p.id, 'Slow save'), ...await notes(p.id, text)].length, 1);
  });
});

describe('double-clicks on money and claim buttons', () => {
  test('double-clicking Post payment posts one payment', async () => {
    const p = await patientOwing();
    await openPayment(p.id, 'cash');
    await payButton().dblclick();
    await s.page.waitForSelector('.inline-panel[aria-label="Take payment"]', { state: 'detached', timeout: 10_000 });
    await s.page.waitForTimeout(500);
    assert.equal((await payments(p.id)).length, 1);
  });

  test('double-clicking Approve on a prepared claim makes one claim', async () => {
    const p = await s.post('/patients', { first_name: 'Dbl', last_name: 'Clickwell', dob: '1981-02-03' });
    await s.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, subscriber_name: 'Dbl Clickwell', subscriber_id: `DC${p.id}`, group_number: 'G1' });
    for (const code of ['D1110', 'D0120']) await s.post(`/patients/${p.id}/procedures`, { code, provider_id: provider.id, complete: true });
    await s.page.goto(`${app.base}/claims?tab=approve`);
    const row = s.page.locator('tr.wl-row', { hasText: 'Dbl Clickwell' });
    await row.locator('button:has-text("Approve")').waitFor();
    await quiet(s.page);
    await row.locator('button:has-text("Approve")').dblclick();
    await s.page.waitForSelector('.toast:has-text("Dbl Clickwell")');
    await s.page.waitForTimeout(800);
    const claims = await server(`/claims?patient_id=${p.id}&limit=50`);
    assert.equal(claims.length, 1, `one claim, got ${claims.length}`);
  });
});

describe('the session expires mid-work', () => {
  const typed = `expired session note ${Date.now()}`;
  let p;
  test('saving goes back to sign-in (no crash, no blank page) and signing in again works', async () => {
    p = await patientOwing();
    await openNotes(p.id);
    await s.page.fill(noteBox, typed);
    // The session ends on the server (timed out, or signed out elsewhere) while the person is typing.
    await s.page.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}`, 'Content-Type': 'application/json' }, body: '{}' }); });
    await s.page.keyboard.press('Control+Enter');
    await s.page.waitForSelector('input[autocomplete=username]', { timeout: 10_000 });
    assert.equal(await s.page.locator('text=Something went wrong').count(), 0);
    await s.page.fill('input[autocomplete=username]', 'admin@demo.dentalmachine.app');
    await s.page.fill('input[type=password]', 'demo-password-123');
    await s.page.click('button.primary');
    await s.page.waitForSelector('main');
    assert.equal((await notes(p.id, typed)).length, 0, 'nothing was saved with the expired session');
  });

  test('the typed note is still there after signing back in', { todo: 'Unsaved note text is not kept across an expired session: keeping it means storing clinical text in the browser after sign-out (owner decision; see docs/testing.md)' }, async () => {
    await openNotes(p.id);
    assert.match(await s.page.inputValue(noteBox), /expired session note/);
  });
});
