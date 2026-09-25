// Compliance logs (README.md, “Compliance log”): a complaint or incident, a staff exposure (OSHA), a HIPAA disclosure.
import { newPatient, activate } from '../lib/fixtures.mjs';

export default {
  A168: { // record a patient complaint or incident
    role: 'admin',
    async setup(t) {
      const p = await newPatient(t, 'Carla');
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/compliance', 'h1:has-text("Compliance log")');
      await t.step('Manage → Compliance log: press N — the form opens about the active patient, follow-up to the manager in a week', async () => {
        await t.key('n');
        await t.focusIs('What happened');
        await t.see(`.cmp-chip:has-text("${p.last_name}")`);
      });
      await t.step('Type what happened', async () => {
        await t.type('Upset about waiting 40 minutes past her appointment time');
      });
      await t.step('Press Enter: recorded, and the follow-up is on the owner’s to-do list', async () => {
        await t.key('Enter');
        await t.see('td:has-text("Upset about waiting 40 minutes")');
      });
    },
  },

  A169: { // log an exposure or sharps injury
    role: 'admin',
    async run(t) {
      await t.open('/compliance?tab=exposures', 'button:has-text("Log an exposure")');
      await t.step('Compliance log → Exposure log: press N', async () => {
        await t.key('n');
        await t.focusIs('Who was exposed');
      });
      await t.step('Type who was exposed, Tab, how it happened', async () => {
        await t.type('Sam Okafor');
        await t.key('Tab');
        await t.type('Needlestick recapping the syringe after an inferior alveolar block');
      });
      await t.step('Press Enter: logged with the post-exposure checklist (reported today is already ticked)', async () => {
        await t.key('Enter');
        await t.see('.cmp-exposure:has-text("Needlestick recapping")');
      });
    },
  },

  A175: { // record a HIPAA disclosure
    role: 'admin',
    async setup(t) {
      const p = await newPatient(t, 'Dora');
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/compliance?tab=disclosures', `.cmp-chip:has-text("${p.last_name}")`);
      await t.step('Compliance log → Disclosures (the active patient is chosen): press N', async () => {
        await t.key('n');
        await t.focusIs('Given to');
      });
      await t.step('Type who it went to, Tab, what was given (the reason defaults to the last one used)', async () => {
        await t.type('Travis County District Court');
        await t.key('Tab');
        await t.type('X-rays and treatment notes 2024-2026 (subpoena)');
      });
      await t.step('Press Enter: recorded for the patient’s accounting of disclosures', async () => {
        await t.key('Enter');
        await t.see('td:has-text("Travis County District Court")');
      });
    },
  },
};
