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
      await t.step('Click "Record vitals" under the medical history', async () => {
        await t.click('button:has-text("Record vitals")');
        await t.see('input[aria-label="Systolic"]');
      });
      await t.step('Click Systolic and type it, Tab, diastolic, Tab, pulse; press Enter', async () => {
        await t.click('input[aria-label="Systolic"]');
        await t.type('122');
        await t.key('Tab');
        await t.type('78');
        await t.key('Tab');
        await t.type('68');
        await t.key('Enter');
        await t.see('input[aria-label="Systolic"]', { state: 'detached' });
      });
      const focus = await t.page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      if (focus !== 'Systolic') t.flag('asks-known', 'Record vitals doesn’t put the cursor in the first box: one more click before typing');
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
      await t.open(`/patients/${p.id}?tab=family`, 'button:has-text("Add family member")');
      await t.step('Family tab: click "+ Add family member" (address, phone and guarantor come from this patient)', async () => {
        await t.click('button:has-text("Add family member")');
        await t.see('.modal');
      });
      await t.step('Type the first name, Tab, the birth date', async () => {
        const first = t.page.locator('.modal input').first();
        if (!(await first.evaluate((el) => el === document.activeElement))) await t.click(first);
        await t.type('Kit');
        await t.key('Tab');
        const focusType = await t.page.evaluate(() => document.activeElement?.type);
        if (focusType !== 'date') await t.key('Tab');
        await t.type('06062016');
      });
      await t.step('Click Save / Add: the child is on the family', async () => {
        await t.click('.modal button.primary');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A099: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Olive') }),
    async run(t, { p }) {
      await overview(t, p);
      await t.step('No office-alert line on the chart: click Edit (the full patient form)', async () => {
        await t.click('main button:has-text("Edit")');
        await t.see('.modal');
      });
      await t.step('Scroll to "Pop-up office alert", click it and type the alert', async () => {
        await t.click('.modal label:has-text("Pop-up office alert") input');
        await t.type('Anxious — offer nitrous');
      });
      await t.step('Click Save', async () => {
        await t.click('.modal button.primary');
        await t.see('.modal', { state: 'detached' });
      });
      t.flag('layout', 'The office alert is only in the full Edit form (a dialog), not editable in place on the chart like phone and address');
    },
  },

  A098: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Provy') }),
    async run(t, { p }) {
      await overview(t, p);
      const line = t.page.locator('button[aria-label*="hygienist" i], button[aria-label*="provider" i], button[aria-label*="dentist" i]').first();
      if (await line.count()) {
        await t.step('Click the usual hygienist line on the chart', async () => { await t.click(line); });
        await t.step('Pick the hygienist: saved', async () => {
          const sel = t.page.locator('select:focus, main select').first();
          await sel.selectOption({ index: 1 });
          await t.wait(500);
        });
        t.note('Picked with the mouse from a list.');
      } else {
        t.flag('dead-end', 'The patient’s usual dentist/hygienist isn’t on the chart overview: Edit patient → All fields');
        await t.step('Click Edit: the full patient form opens', async () => {
          await t.click('main button:has-text("Edit")');
          await t.see('.modal');
        });
        await t.step('Pick the usual hygienist in the form and Save', async () => {
          const sel = t.page.locator('.modal label:has-text("hygienist") select').first();
          if (!(await sel.count())) throw new Error('no hygienist field in Edit patient');
          const opts = await sel.locator('option').allTextContents();
          await sel.selectOption({ index: Math.max(1, opts.findIndex((o) => /RDH|hygien/i.test(o))) });
          await t.click('.modal button.primary');
          await t.see('.modal', { state: 'detached' });
        });
      }
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
      await t.step('Click Edit: the full patient form opens', async () => {
        await t.click('main button:has-text("Edit")');
        await t.see('.modal');
      });
      await t.step('Click the first name, select it and type the correct spelling', async () => {
        await t.click('.modal input[name="first_name"], .modal label:has-text("First name") input');
        await t.key(`${MOD}+a`);
        await t.type('John');
      });
      await t.step('Click Save', async () => {
        await t.click('.modal button.primary');
        await t.see('.modal', { state: 'detached' });
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
      await t.step('Click "Refer out…" on the chart: "Refer to a specialist"', async () => {
        await t.click('button:has-text("Refer out")');
        await t.see('.modal');
      });
      const to = t.page.locator('.modal label:has-text("Refer to") select');
      const referring = t.page.locator('.modal label:has-text("Referring provider") select');
      if (!(await to.inputValue())) t.flag('asks-known', 'Refer out (chart): the specialist starts on "Choose…" and the referring provider on "—" although the signed-in dentist and the office’s usual endodontist are known (the Referrals page fills them)');
      await t.step('Pick the specialist and type the reason', async () => {
        if (!(await to.inputValue())) await to.selectOption({ index: 1 });
        await t.click('.modal label:has-text("Reason") input');
        await t.type('RCT #19, symptomatic irreversible pulpitis');
      });
      if (!(await referring.inputValue())) {
        await t.step('Pick yourself as the referring provider', async () => { await referring.selectOption({ index: 1 }); });
      }
      await t.step('Click "Save & print letter"', async () => {
        await t.click('.modal button:has-text("Save & print letter")');
        await t.see('.modal', { state: 'detached' });
      });
      for (const pg of t.ctx.pages()) if (pg !== t.page) await pg.close();
    },
  },

  A092: { // referred by
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Newbie') }),
    async run(t, { p }) {
      await overview(t, p);
      await t.step('Click "Referred by…" on the chart: "Who referred this patient?"', async () => {
        await t.click('button:has-text("Referred by")');
        await t.see('.modal');
      });
      await t.step('Pick the source from the list and click Save', async () => {
        const sel = t.page.locator('.modal select').first();
        const opts = await sel.locator('option').allTextContents();
        await sel.selectOption({ index: Math.max(1, opts.findIndex((o) => /google/i.test(o))) });
        await t.click('.modal button.primary:has-text("Save")');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },
};
