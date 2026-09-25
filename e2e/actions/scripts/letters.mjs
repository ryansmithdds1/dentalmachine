// Letters from templates and mailing labels (docs/documents.md, “Letters and mailing labels”).
import { newPatient, activate } from '../lib/fixtures.mjs';

export default {
  A171: { // write a letter to a patient from a template
    role: 'frontdesk',
    async setup(t) {
      const p = await newPatient(t, 'Letty', { address: '12 Oak Lane', city: 'Austin', state: 'TX', zip: '78704' });
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/letters', '.ltr-list button:has-text("Welcome to the practice")');
      await t.see(`.cmp-chip:has-text("${p.last_name}")`);
      await t.page.evaluate(() => { try { localStorage.removeItem('dm_last_letter_template'); } catch { /* ignore */ } });
      await t.step('Family → Letters (for the active patient): press 1 — the welcome letter, filled in from the chart', async () => {
        await t.key('1');
        await t.see('.ltr-paper:has-text("Dear Letty")');
      });
      await t.step('Press Enter: filed in their documents (Letters) and opened to print', async () => {
        const popup = t.page.waitForEvent('popup');
        await t.key('Enter');
        await (await popup).close().catch(() => {});
        await t.see('td:has-text("Welcome to the practice")');
      });
    },
  },

  A177: { // print mailing labels
    role: 'frontdesk',
    async run(t) {
      await t.open('/followups?tab=recall', 'button:has-text("Mailing labels"):not([disabled])');
      await t.step('Follow-up → Recall: click "Mailing labels" — an Avery 5160 sheet for everyone listed opens to print', async () => {
        const popup = t.page.waitForEvent('popup');
        await t.click('button:has-text("Mailing labels")');
        await (await popup).close().catch(() => {});
        await t.see('.toast:has-text("ready to print")');
      });
      t.note('The same button is on report results (Reports → a report → Labels) and on a campaign’s audience. Anyone who asked not to be contacted, moved, died or has no complete address is left out and listed.');
    },
  },
};
