// The patient's chart outside the tooth chart: note signing, vitals, risk and education, family, alerts, providers,
// forms, referrals, status changes and the record export.
/* global document */
import { newPatient, refs, MOD } from '../lib/fixtures.mjs';

// The overview's contact card: a line is clicked (or E) and edited in place.
const overview = (t, p) => t.open(`/patients/${p.id}`, '#medical-history');
// The chart header's "More" menu (the ⋯ button next to Book appointment).
async function more(t, label) {
  await t.click('main button[aria-label="More"], main .page-header button:has-text("⋯"), main button:has(svg.lucide-ellipsis)');
  await t.click(`text=${label}`);
}

export default {
  A023: {
    role: 'dentist',
    async setup(t) {
      const { dentist } = await refs(t);
      const p = await newPatient(t, 'Signy');
      // The assistant wrote it for the dentist (the office manager's login stands in for an assistant); the dentist signs it.
      await t.as('admin').post(`/patients/${p.id}/notes`, { body: 'Crown prep #30. 2 carpules articaine. Retraction cord, final impression. Temp placed.', provider_id: dentist.id });
      return { p };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=notes`, 'h2:has-text("New note")');
      await t.step('Clinical notes: the unsigned note shows "Sign". Click it: signed with the dentist’s name and NPI', async () => {
        await t.click('main .card button.small.primary:text-is("Sign")');
        await t.see('.badge:has-text("Signed")');
      });
    },
  },

  A033: {
    role: 'hygienist',
    setup: async (t) => ({ p: await newPatient(t, 'Vito') }),
    async run(t, { p }) {
      await overview(t, p);
      await t.step('Press V: one box opens under the medical history with the cursor in it', async () => {
        await t.key('v');
        await t.see('input[aria-label="Blood pressure and pulse"]');
      });
      const focus = await t.page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      if (focus !== 'Blood pressure and pulse') t.flag('asks-known', 'Record vitals doesn’t put the cursor in the box: one more click before typing');
      await t.step('Type the reading as it’s said, "122/78 68" (it reads back BP 122/78 mmHg · pulse 68 bpm), and press Enter', async () => {
        if (focus !== 'Blood pressure and pulse') await t.click('input[aria-label="Blood pressure and pulse"]');
        await t.type('122/78 68');
        await t.see('text=BP 122/78 mmHg · pulse 68 bpm');
        await t.key('Enter');
        await t.see('input[aria-label="Blood pressure and pulse"]', { state: 'detached' });
      });
    },
  },

  A068: {
    role: 'hygienist',
    setup: async (t) => ({ p: await newPatient(t, 'Riska') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=risk`, 'h2:has-text("Caries risk")');
      const card = t.page.locator('.card', { has: t.page.locator('h2:has-text("Caries risk")') });
      await t.step('Risk & education: click "Assess" under Caries risk (CAMBRA): the checklist of risk and protective factors', async () => {
        await t.click(card.locator('button:has-text("Assess")'));
        await t.see('label:has-text("Visible heavy plaque")');
      });
      await t.step('Tick the factors that apply (two here)', async () => {
        await t.click('label:has-text("Visible heavy plaque") input');
        await t.click('label:has-text("Frequent snacks") input');
      });
      await t.step('Click Save: the risk level is worked out and recorded', async () => {
        await t.click(card.locator('button:has-text("Save")'));
        await t.see('label:has-text("Visible heavy plaque")', { state: 'detached' });
      });
    },
  },

  A080: {
    role: 'hygienist',
    setup: async (t) => ({ p: await newPatient(t, 'Eddie') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=risk`, 'h2:has-text("Patient education")');
      const card = t.page.locator('.card', { has: t.page.locator('h2:has-text("Patient education")') });
      await t.step('Patient education: tick "After your filling"', async () => {
        await t.click(card.locator('label:has-text("After your filling") input'));
      });
      await t.step('Click Send: texted to the patient', async () => {
        await t.click(card.locator('button:has-text("Send")').first());
        await t.see('text=Sent.');
      });
    },
  },

  A040: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Formy') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=comms`, 'button:has-text("Send forms")');
      await t.step('Messages & forms: click "Send forms…": the forms they still need are ticked', async () => {
        await t.click('button:has-text("Send forms")');
        await t.see('.modal');
      });
      await t.step('Click "Text/email to patient": sent', async () => {
        await t.click('.modal button.primary');
        await t.see('.modal button:has-text("Done"), .toast');
      });
    },
  },

  A090: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Parent') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=family`, '.family-add input');
      await t.step('Family tab: click the "Add to the family" line (address, phone and guarantor come from this patient)', async () => {
        await t.click('.family-add input');
      });
      await t.step('Type "Kit 6/6/2016" — first name and birth date in one box (a child, with this family’s last name) — and press Enter', async () => {
        await t.type('Kit 6/6/2016');
        await t.key('Enter');
        await t.see('.toast:has-text("added to the family")');
      });
    },
  },

  A099: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Olive') }),
    async run(t, { p }) {
      await overview(t, p);
      await t.step('Contact card: click "Office alert" — it opens for typing in place', async () => {
        await t.click('.contact-card button[aria-label^="Change office alert"]');
        await t.see('.contact-card input[aria-label^="Office alert"]');
      });
      await t.step('Type the alert and press Enter: saved (Undo shows); it pops up for the next person who opens the chart', async () => {
        await t.type('Anxious — offer nitrous');
        await t.key('Enter');
        await t.see('.toast:has-text("office alert is now")');
      });
    },
  },

  A098: {
    role: 'frontdesk',
    async setup(t) {
      const { hygienist } = await refs(t);
      return { p: await newPatient(t, 'Provy'), hygienist };
    },
    async run(t, { p, hygienist }) {
      await overview(t, p);
      await t.step('Contact card: click "Usual hygienist" — the list of hygienists opens in place', async () => {
        await t.click('.contact-card button[aria-label^="Change usual hygienist"]');
        await t.see('.contact-card select[aria-label^="Usual hygienist"]');
      });
      await t.step(`Pick ${hygienist.name}: saved at once (Undo shows)`, async () => {
        const sel = t.page.locator('.contact-card select[aria-label^="Usual hygienist"]');
        await sel.selectOption(String(hygienist.id));
        await t.see('.toast:has-text("usual hygienist is now")');
      });
    },
  },

  A117: { // make inactive
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Inez') }),
    async run(t, { p }) {
      await overview(t, p);
      await t.step('Click Edit: the full patient form opens', async () => {
        await t.click('main button:has-text("Edit")');
        await t.see('.modal');
      });
      const status = t.page.locator('.modal select:has(option[value="inactive"])').first();
      if (!(await status.isVisible().catch(() => false))) {
        await t.step('Click "All fields" to find Status', async () => {
          await t.click('.modal :text("All fields")');
          await status.waitFor();
        });
      }
      await t.step('Set Status to Inactive and click Save', async () => {
        await status.selectOption('inactive');
        await t.click('.modal button.primary');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A143: { // correct name / DOB
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Jon') }),
    async run(t, { p }) {
      await overview(t, p);
      await t.step('Click the name on the chart header: first and last name open for correcting (the first name is selected)', async () => {
        await t.click('h1 .name-in-place');
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'First name');
      });
      await t.step('Type the correct spelling and press Enter: saved (Undo shows; the chart history keeps the old name)', async () => {
        await t.type('John');
        await t.key('Enter');
        await t.see('.toast:has-text("Name corrected to John")');
      });
    },
  },

  A141: { // record export
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Rex') }),
    async run(t, { p }) {
      await overview(t, p);
      await t.step('Click ⋯ (More) in the chart header', async () => {
        await t.click('main button[title="More"]');
        await t.see('text=Export record');
      });
      await t.step('Click "Export record": the summary PDF, data, images and documents download as one ZIP', async () => {
        const dl = t.page.waitForEvent('download', { timeout: 20_000 });
        await t.click('text=Export record');
        await dl;
      });
    },
  },

  A089: {
    role: 'dentist',
    async setup(t) {
      await t.as('admin').post('/referral-contacts', { name: 'Dr. Grace Kim', practice_name: 'Riverside Endodontics', specialty: 'Endodontics', phone: '512-555-0199', email: 'kim@riverside.example.com' }).catch(() => {});
      return { p: await newPatient(t, 'Referra') };
    },
    async run(t, { p }) {
      await overview(t, p);
      await t.step('Click "Refer out…" on the chart: the referral panel opens beside it with the usual specialist chosen', async () => {
        await t.click('button:has-text("Refer out")');
        await t.see('.side-panel .rt-form select option:nth-child(2)', { state: 'attached' });
        await t.wait(400); // the suggestion (the specialist used last for this kind of work) arrives
      });
      const to = t.page.locator('.side-panel .rt-form select').first();
      if (!(await to.inputValue())) {
        t.note('No referral out yet in this office, so no specialist is suggested: picked from the list.');
        await t.step('Pick the specialist', async () => { await to.selectOption({ index: 1 }); });
      }
      await t.step('Type the reason (the cursor is already there)', async () => {
        const reason = t.page.locator('.side-panel label:has-text("Reason") input');
        if (!(await reason.evaluate((el) => el === document.activeElement))) await t.click(reason);
        await t.type('RCT #19, symptomatic irreversible pulpitis');
      });
      await t.step('Press Ctrl/⌘+Enter: sent (the letter prints or emails; the patient gets the specialist’s number)', async () => {
        await t.key(`${MOD}+Enter`);
        await t.see('.toast:has-text("Referred to")');
      });
      for (const pg of t.ctx.pages()) if (pg !== t.page) await pg.close();
    },
  },

  A092: { // referred by
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Newbie') }),
    async run(t, { p }) {
      await overview(t, p);
      await t.step('Click "Referred by…" on the chart: "Who referred this patient?" opens beside it', async () => {
        await t.click('button:has-text("Referred by")');
        await t.see('.side-panel .rt-form select');
      });
      await t.step('Pick the referring doctor from the list and click Save', async () => {
        const sel = t.page.locator('.side-panel .rt-form select').first();
        await sel.selectOption({ index: 1 });
        await t.click('.side-panel button.primary:has-text("Save")');
        await t.see('.side-panel', { state: 'detached' });
      });
    },
  },
};
