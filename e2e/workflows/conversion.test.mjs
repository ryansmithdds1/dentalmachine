// Settings → Import from another system: a Dentrix export (zipped) through the whole wizard —
// choose the system, drop the zip, dry run, map an unknown code, import, and the reconciliation.
/* global document */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { zip } from '../../server/src/recordexport.js';

const EXPORT = zip([
  { name: 'DentrixExport/Providers.csv', data: 'Provider ID,Last Name,First Name,Title,NPI\nZDDS,Quill,Morgan,DDS,\n' },
  { name: 'DentrixExport/Patients.csv', data: 'Chart #,Last Name,First Name,Birthdate,Gender,Status,Guarantor,Prim Prov,Cell Phone,SSN\nE2E001,Vantwest,Harriet,02/03/1971,F,Patient,E2E001,ZDDS,512-555-0101,111-22-3333\nE2E002,Vantwest,Otto,05/06/2010,M,Patient,E2E001,ZDDS,,\n' },
  { name: 'DentrixExport/Appointments.csv', data: 'Appt ID,Chart #,Appt Date,Appt Time,Appt Length,Provider,Status\nZ1,E2E001,07/01/2031,9:00 AM,60,ZDDS,Confirmed\n' },
  { name: 'DentrixExport/Procedures.csv', data: 'Proc ID,Chart #,Proc Date,ADA Code,Tooth,Surface,Amount,Status,Provider\nZP1,E2E001,03/01/2025,D0120,,,60.00,C,ZDDS\nZP2,E2E002,03/01/2025,PMAINT,,,95.00,C,ZDDS\n' },
  { name: 'DentrixExport/Aging.csv', data: 'Guarantor Chart #,Total Balance\nE2E001,145.50\n' },
]);

let app; let browser; let s;
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
});
after(async () => { await browser?.close(); await app?.stop(); });

test('Dentrix conversion through the screen: dry run → map a code → import → reconciliation', async () => {
  const { page } = s;
  await page.goto(`${app.base}/settings?tab=import`);
  await page.waitForSelector('[data-testid=full-conversion]');
  await page.click('.conv-source:has-text("Dentrix")');
  await page.waitForSelector('.conv-howto:has-text("Office Manager")');
  await page.setInputFiles('[data-testid=conversion-file]', { name: 'dentrix-export.zip', mimeType: 'application/zip', buffer: EXPORT });

  // The dry run: counts, the A/R and the unknown code — nothing saved yet.
  await page.waitForSelector('text=What would be brought over');
  const review = await page.textContent('[data-testid=full-conversion]');
  assert.match(review, /Accounts receivable in Dentrix\$145\.50/);
  assert.match(review, /PMAINT/);
  assert.match(review, /Patients\.csv/);
  await page.screenshot({ path: '/tmp/claude-0/conv-review.png', fullPage: true });

  await page.fill('input[aria-label="Procedure code PMAINT"]', 'D4910');
  assert.equal(await page.isDisabled('button:has-text("Import from Dentrix")'), true, 'changed choices must be checked first');
  await page.click('button:has-text("Check again")');
  await page.waitForFunction(() => !document.querySelector('.conv-actions button.primary')?.disabled);
  await page.click('button:has-text("Import from Dentrix")');

  // Done: the reconciliation adds up and the balance matches.
  await page.waitForSelector('text=Reconciliation', { timeout: 60_000 });
  const done = await page.textContent('[data-testid=full-conversion]');
  assert.match(done, /Everything from Dentrix is here/);
  assert.match(done, /Matches/);
  assert.equal(await page.locator('.conv-chip.bad').count(), 0, 'every row adds up');
  await page.screenshot({ path: '/tmp/claude-0/conv-done.png', fullPage: true });

  // And it's really there: the family, the code as mapped, one balance forward.
  const found = await s.get('/patients?q=Vantwest');
  const list = Array.isArray(found) ? found : found.patients || found.rows;
  assert.equal(list.length, 2);
  const otto = await s.get(`/patients/${list.find((p) => p.first_name === 'Otto').id}`);
  assert.equal(otto.guarantor_id, list.find((p) => p.first_name === 'Harriet').id);
  assert.deepEqual(s.errors, []);
});
