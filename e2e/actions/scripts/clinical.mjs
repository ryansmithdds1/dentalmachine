// Clinical: charting, notes, medical history, completing work, treatment plans, consents, perio, prescriptions.
/* global document */
import { newPatient, book, activate, refs, MOD, uniq } from '../lib/fixtures.mjs';

// A patient on today's schedule (early, before the demo day starts) with planned work on the visit.
let early = 0;
export async function visitToday(t, first, codes = []) {
  const { dentist } = await refs(t);
  const p = await newPatient(t, first);
  const a = await book(t, p, t.today, 4 * 60 + 35 * (early++ % 8), 30, { reason: 'Exam' });
  if (!a.id) throw new Error(`could not book: ${JSON.stringify(a)}`);
  const procs = [];
  for (const code of codes) procs.push(await t.as('admin').post(`/patients/${p.id}/procedures`, { code, appointment_id: a.id, provider_id: dentist.id }));
  return { p, a, procs };
}
const openChart = (t, p) => t.open(`/patients/${p.id}?tab=chart`, '.odontogram2');

export default {
  A006: {
    role: 'dentist',
    setup: async (t) => ({ p: await newPatient(t, 'Carrie') }),
    async run(t, { p }) {
      await openChart(t, p);
      await t.step('On the chart, type 3: an entry box opens', async () => {
        await t.key('3');
        await t.see('.chart-entry input');
      });
      await t.step('Type "0 MO caries": the finding is shown as it will be charted', async () => {
        await t.type('0 MO caries');
        await t.see('.chart-entry .chip:has-text("#30 MO caries")');
      });
      await t.step('Press Enter: charted on the drawing (Undo shows)', async () => {
        await t.key('Enter');
        await t.see('.toast:has-text("Charted #30 MO caries")');
      });
    },
  },

  A021: {
    role: 'dentist',
    setup: async (t) => ({ p: await newPatient(t, 'Crowny') }),
    async run(t, { p }) {
      await openChart(t, p);
      await t.step('Type 1 on the chart: the entry box opens', async () => {
        await t.key('1');
        await t.see('.chart-entry input');
      });
      await t.step('Type "4 D2740": the crown, its fee and the patient’s estimate show', async () => {
        await t.type('4 D2740');
        await t.see('.chart-entry .chip:has-text("D2740")');
      });
      await t.step('Press Enter: planned on #14', async () => {
        await t.key('Enter');
        await t.see('.toast:has-text("Charted #14 D2740")');
      });
    },
  },

  A011: {
    role: 'dentist',
    async setup(t) {
      const v = await visitToday(t, 'Noted');
      await activate(t, v.p.id);
      return v;
    },
    async run(t, { p }) {
      await t.open('/schedule', `.patient-bar:has-text("${p.last_name}")`);
      await t.step('Press Alt+N: the note opens drafted from today’s visit, cursor in the box', async () => {
        await t.key('Alt+n');
        await t.page.waitForURL(/tab=notes/);
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Type what to add');
      });
      await t.step('Type what happened', async () => {
        await t.type('patient tolerated well, no complications');
      });
      await t.step('Press Ctrl/⌘+Enter: saved and linked to the visit', async () => {
        await t.key(`${MOD}+Enter`);
        await t.see('.card:has-text("Patient tolerated well")');
      });
    },
  },

  A014: {
    role: 'hygienist',
    setup: async (t) => ({ p: await newPatient(t, 'Medina') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}`, '#medical-history');
      await t.see('.med-status.due');
      await t.step('Press R: "reviewed today, no changes" is recorded', async () => {
        await t.key('r');
        await t.see('.med-status:not(.due)');
      });
    },
  },

  A032: {
    role: 'hygienist',
    setup: async (t) => ({ p: await newPatient(t, 'Allie') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}`, '#medical-history');
      await t.step('Press A: the medical history editor opens on the Allergies line', async () => {
        await t.key('a');
        await t.page.waitForFunction(() => document.activeElement?.name === 'allergies');
      });
      await t.step('Type the allergy and press Ctrl/⌘+Enter: saved (and counted as today’s review)', async () => {
        await t.type('Latex');
        await t.key(`${MOD}+Enter`);
        await t.see('.med-kv .med-value:has-text("Latex")');
      });
      t.note('Shift+M opens it on Medications; M on the alerts; by mouse it is 3 actions (click the line, type, Ctrl/⌘+Enter).');
    },
  },

  A015: {
    role: 'dentist',
    setup: (t) => visitToday(t, 'Complete', ['D0120', 'D0274']),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=chart`, 'button:has-text("Complete today\'s work (2)")');
      await t.step('Press Shift+C: a line asks to complete the 2 procedures and post the charges', async () => {
        await t.key('Shift+C');
        await t.see('.proc-confirm:has-text("post")');
      });
      await t.step('Press Enter: completed, charges posted', async () => {
        await t.key('Enter');
        await t.see('.proc-done:has-text("Completed 2 procedures")');
      });
    },
  },

  A038: {
    role: 'dentist',
    setup: async (t) => ({ p: await newPatient(t, 'Tess') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=treatment`, 'h2:has-text("Treatment plans")');
      await t.step('Press N: the plan builder opens with the cursor in "Add work to the plan"', async () => {
        await t.key('n');
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Add work to the plan');
      });
      await t.step('Type "14 D2740", Enter; "30 MO filling", Enter; "19 rct", Enter', async () => {
        for (const line of ['14 D2740', '30 MO filling', '19 rct']) {
          await t.type(line);
          await t.key('Enter');
        }
        await t.see('.modal td:has-text("D3330")');
      });
      await t.step('Press Ctrl/⌘+Enter: the plan is saved and named for you', async () => {
        await t.key(`${MOD}+Enter`);
        await t.see('.card h3:has-text("Treatment plan —")');
      });
    },
  },

  A039: {
    role: 'dentist',
    async setup(t) {
      const { dentist } = await refs(t);
      const p = await newPatient(t, 'Consenta');
      await t.as('admin').post(`/patients/${p.id}/procedures`, { code: 'D7140', tooth: '17', provider_id: dentist.id });
      const plan = await t.as('admin').post(`/patients/${p.id}/treatment-plans`, { all_unplanned: true });
      return { p, plan };
    },
    async run(t, { p, plan }) {
      await t.open(`/patients/${p.id}?tab=treatment`, `.card[data-plan="${plan.id}"]`);
      await t.step('Click "Consent" on the plan: the right consent is chosen, "Sign here on this device" has focus', async () => {
        await t.click(t.page.locator(`.card[data-plan="${plan.id}"]`).locator('button:text-is("Consent…")'));
        await t.page.waitForFunction(() => document.activeElement?.textContent === 'Sign here on this device');
      });
      await t.step('Press Enter: the consent opens for the patient to sign (no birth-date check)', async () => {
        await t.key('Enter');
        await t.page.waitForURL(/\/f\//);
        await t.see('h1:has-text("Consent for tooth extraction")');
      });
    },
  },

  A042: {
    role: 'dentist',
    async setup(t) {
      const { dentist } = await refs(t);
      const p = await newPatient(t, 'Tessa', { last_name: `Presentwright${uniq()}` });
      await t.as('admin').post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth: '14', provider_id: dentist.id });
      const plan = await t.as('admin').post(`/patients/${p.id}/treatment-plans`, { all_unplanned: true });
      return { p, plan };
    },
    async run(t, { p, plan }) {
      await t.open(`/patients/${p.id}?tab=treatment`, `.card[data-plan="${plan.id}"]`);
      await t.step(`Click "Present here for ${p.first_name} to sign" on the plan: it opens on this screen for the patient (same tab, no birth date)`, async () => {
        await t.click(t.page.locator(`.card[data-plan="${plan.id}"]`).locator(`button:has-text("Present here for ${p.first_name} to sign")`));
        await t.page.waitForURL(/\/tp\//);
        await t.see(`h1:has-text("Your treatment plan, ${p.first_name}")`);
      });
      await t.page.waitForFunction(() => document.activeElement?.getAttribute('autocomplete') === 'name');
      const prefilled = await t.page.inputValue('input[autocomplete=name]');
      if (!prefilled) {
        t.flag('asks-known', 'The patient in the chair types their own name although the office opened the plan for them');
        await t.step('Patient: types their name', async () => { await t.type(`${p.first_name} ${p.last_name}`); });
      }
      await t.step(`Patient: their name is on the signing line ("${prefilled || '…'}"); they tick "I agree" and tap Accept & sign`, async () => {
        await t.click('label.checkbox input[type=checkbox]');
        await t.click('button:has-text("Accept & sign")');
        await t.see('h1:has-text("Thank you")');
      });
      t.note(`1 staff action + ${prefilled ? 2 : 3} patient actions.`);
    },
  },

  A045: {
    role: 'hygienist',
    setup: async (t) => ({ p: await newPatient(t, 'Perry') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=perio`, '.perio-table');
      await t.step('Click "Depths": the first site (#1 DB) is ready', async () => {
        await t.click('.chart-toolbar button:has-text("Depths")');
      });
      await t.step('Type 3 2 4, then B (bleeding on the last site)', async () => {
        for (const d of '324') await t.page.keyboard.type(d);
        await t.page.keyboard.type('b');
      });
      await t.step('Type 5 3 5, then Shift+B (bleeding on that whole side)', async () => {
        for (const d of '535') await t.page.keyboard.type(d);
        await t.page.keyboard.type('B');
      });
      await t.step('Click "Save exam"', async () => {
        await t.click('.page-header button.primary:has-text("Save exam")');
        await t.see('.page-header :text("Perio exam")');
      });
      t.note('A two-tooth sample: a full mouth is about 170 more single-key readings.');
    },
  },

  A062: {
    role: 'dentist',
    setup: async (t) => ({ p: await newPatient(t, 'Rhea') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=rx`, '.chip kbd:has-text("1")');
      await t.step('Press 1: the first favorite prescription fills in, the Save button has focus', async () => {
        await t.key('1');
        await t.page.waitForFunction(() => /Save & print|Send to/.test(document.activeElement?.textContent || ''));
      });
      await t.step('Press Enter: saved (and printed or sent)', async () => {
        await t.key('Enter');
        await t.page.waitForFunction(async (pid) => {
          const r = await fetch(`/api/patients/${pid}/prescriptions`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('dm_token')}` } }); // eslint-disable-line no-undef
          return (await r.json()).length === 1;
        }, p.id);
      });
      for (const pg of t.ctx.pages()) if (pg !== t.page) await pg.close();
    },
  },

  A096: { // print a treatment plan
    role: 'dentist', // the Print button sits with the plan's clinical actions
    async setup(t) {
      const { dentist } = await refs(t);
      const p = await newPatient(t, 'Printa');
      await t.as('admin').post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth: '14', provider_id: dentist.id });
      const plan = await t.as('admin').post(`/patients/${p.id}/treatment-plans`, { all_unplanned: true });
      return { p, plan };
    },
    async run(t, { p, plan }) {
      await t.open(`/patients/${p.id}?tab=treatment`, `.card[data-plan="${plan.id}"]`);
      await t.step('Click "Print" on the plan: the printable plan opens in a new tab', async () => {
        const tab = t.ctx.waitForEvent('page');
        await t.click(t.page.locator(`.card[data-plan="${plan.id}"]`).locator('button:text-is("Print")'));
        const pg = await tab;
        await pg.waitForLoadState();
        await pg.close();
      });
    },
  },
};
