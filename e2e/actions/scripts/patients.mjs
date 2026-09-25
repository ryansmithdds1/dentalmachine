// Patient records outside the chart's contact card (phase 2, batch 2A): a health history sent in online, and a
// patient who has died.
import { newPatient, book, quietDay } from '../lib/fixtures.mjs';

// A patient fills in their health history from the link the office texted: the office sends the forms (API) and
// the patient submits them on the public form (their birth date first), as the phone would.
async function historySentIn(t, p) {
  const packet = await t.as('admin').post(`/patients/${p.id}/form-requests`, { history: true });
  const token = packet.url.split('/f/')[1];
  const post = (path, body, headers = {}) => fetch(`${t.base}/api/public/forms/${token}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, data: await r.json() }));
  const pass = (await post('/verify', { dob: p.dob })).data.pass;
  const sent = await post('', {
    answers: { allergies: 'Penicillin', medications: 'Lisinopril 10 mg', conditions: ['High blood pressure'], consent_hipaa: true, consent_treatment: true },
    signature_name: `${p.first_name} ${p.last_name}`,
  }, pass ? { 'X-Form-Pass': pass } : {});
  if (!sent.ok) throw new Error(`the health history could not be sent in: ${JSON.stringify(sent.data)}`);
}

export default {
  A046: { // review a health history the patient sent in online
    role: 'dentist',
    async setup(t) {
      const p = await newPatient(t, 'Hilda');
      await historySentIn(t, p);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/intake', 'h1:has-text("Sent in online")');
      const rows = t.page.locator('.intake-item');
      await rows.first().waitFor();
      const at = await rows.evaluateAll((els, name) => els.findIndex((e) => e.textContent.includes(name)), p.last_name);
      if (at < 0) throw new Error('the health history is not on the Sent in online list');
      if (at > 0) {
        await t.step(`J to ${p.first_name}’s health history (oldest first; ${at} earlier item${at === 1 ? '' : 's'} on the list)`, async () => {
          for (let i = 0; i < at; i++) await t.key('j');
        });
      }
      await t.step(`Read what’s new (allergy, medication, blood pressure) and press A: merged into ${p.first_name}’s chart (nothing on the chart is erased)`, async () => {
        await t.key('a');
        await t.see(`.toast:has-text("Health history reviewed for ${p.first_name}")`);
      });
    },
  },

  A179: { // mark a patient deceased
    role: 'frontdesk',
    async setup(t) {
      const p = await newPatient(t, 'Walter');
      await book(t, p, quietDay(t.today, 6), 9 * 60); // a visit still on the books
      return { p };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}`, '#medical-history');
      await t.step('Chart overview → Recall: "Don’t recall…" → Deceased: chart inactive, recall, statements and messages stopped, the future visit cancelled — with Undo', async () => {
        const sel = t.page.locator('select[aria-label="Don’t recall this patient"]');
        await t.click(sel);
        await sel.selectOption('deceased');
        await t.see('.toast:has-text("marked deceased")');
        await t.see('h1 .badge.deceased');
      });
      t.note('Batch 3: one step does it all (it was recall only). Also in the chart’s ⋯ menu as "Mark deceased".');
    },
  },
};
