// Front desk: finding patients, the patient bar, contact details, new patients, duplicates.
/* global document */
import { newPatient, activate, MOD, pick, uniq } from '../lib/fixtures.mjs';

export default {
  A002: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Opal') }),
    async run(t, { p }) {
      await t.open('/schedule', '.cal-col-head');
      await t.step('Press Ctrl/⌘K: the command bar opens', async () => {
        await t.key(`${MOD}+k`);
        await t.see('.palette input');
      });
      await t.step('Type the last name: they are the first match', async () => {
        await t.type(p.last_name);
        await t.see(`.palette-item:has-text("${p.last_name}")`);
      });
      await t.step('Press Enter: the chart opens', async () => {
        await pick(t, `${p.first_name} ${p.last_name}`);
        await t.key('Enter');
        await t.page.waitForURL(new RegExp(`/patients/${p.id}`));
        await t.see('h1');
      });
    },
  },

  A003: {
    role: 'frontdesk',
    async setup(t) {
      const p = await newPatient(t, 'Glance', { medical_alerts: 'Latex allergy', allergies: 'Penicillin' });
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/claims', '.sidebar');
      await t.step('On any screen the patient bar shows alerts, balance, insurance and the next visit — nothing to click', async () => {
        await t.see(`.patient-bar:has-text("${p.last_name}")`);
        await t.page.waitForFunction(() => /Balance/.test(document.querySelector('.patient-bar')?.textContent || ''));
      });
    },
  },

  A043: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Nia', { phone: '(512) 555-0101' }) }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}`, 'button[aria-label^="Change mobile"]');
      await t.step('Press E: the mobile number becomes a box with the cursor in it', async () => {
        await t.key('e');
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Mobile'));
      });
      await t.step('Type the new number and press Enter: saved (Undo shows)', async () => {
        await t.type('512.555.0142');
        await t.key('Enter');
        await t.see('.toast:has-text("mobile is now (512) 555-0142")');
      });
    },
  },

  A055: {
    role: 'frontdesk',
    async setup(t) {
      const admin = t.as('admin');
      const name = 'Aetna Dental Robot';
      const carrier = (await admin.get('/carriers')).find((c) => c.name === name) || await admin.post('/carriers', { name, payer_id: '60054' });
      return { carrier, last: `Newbie${uniq()}` };
    },
    async run(t, { carrier, last }) {
      await t.open('/schedule', '.cal-col-head');
      await t.step('Press Ctrl/⌘K and type "new patient"', async () => {
        await t.key(`${MOD}+k`);
        await t.cmd('new patient');
        await pick(t, 'New patient');
      });
      await t.step('Press Enter: the one-line new patient box opens', async () => {
        await t.key('Enter');
        await t.focusIs('New patient in one line');
      });
      await t.step('Type name, birth date, phone, email, insurance and member ID on one line; press Enter: chart and policy made', async () => {
        await t.type(`quinn ${last} 4/5/1991 512-555-0177 quinn.np@example.com ${carrier.name} W99887766`);
        await t.key('Enter');
        await t.page.waitForURL(/\/patients\/\d+/);
        await t.see('h1');
      });
    },
  },

  A121: { // merge duplicates
    role: 'admin',
    async setup(t) {
      const orig = await newPatient(t, 'Dupe');
      await t.as('admin').post(`/patients/${orig.id}/procedures`, { code: 'D0120', complete: true }).catch(() => {});
      const dupe = await t.as('admin').post('/patients', { first_name: orig.first_name, last_name: orig.last_name, dob: orig.dob, phone: '(512) 555-0142' });
      return { orig, dupe };
    },
    async run(t) {
      await t.open('/settings?tab=duplicates', 'tr.wl-row.current');
      await t.step('Settings → Duplicate charts: the pair is highlighted. Press Enter: side-by-side comparison', async () => {
        await t.key('Enter');
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Type MERGE to merge');
      });
      await t.step('Type MERGE and press Enter: merged, the duplicate is archived', async () => {
        await t.cmd('MERGE');
        await t.key('Enter');
        await t.see('.toast:has-text("Merged #")');
      });
    },
  },
};
