// The prescription monitoring program (PDMP) check before a controlled substance (README.md, “PDMP”).
import { newPatient, activate } from '../lib/fixtures.mjs';

export default {
  A178: {
    role: 'dentist',
    async setup(t) {
      const p = await newPatient(t, 'Opal');
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=rx`, 'h2:has-text("New prescription")');
      await t.step('Chart → Rx: press 7 (hydrocodone) — a controlled substance, so "Check the PDMP" comes first and has the focus', async () => {
        await t.key('7');
        await t.focusIs('Check the PDMP');
      });
      await t.step('Press Enter: the state program answers (in the demo, the sandbox) and the result is shown', async () => {
        await t.key('Enter');
        await t.see('.pdmp-box:has-text("PDMP checked")');
      });
      await t.step('Press Enter: saved with the check on it, and opened to print', async () => {
        const popup = t.page.waitForEvent('popup');
        await t.key('Enter');
        await (await popup).close().catch(() => {});
        await t.see('.rx-row:has-text("PDMP:")');
      });
    },
  },
};
