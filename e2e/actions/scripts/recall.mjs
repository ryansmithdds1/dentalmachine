// Recall and follow-up lists: calling patients who are due, unscheduled treatment, broken appointments.
import { newPatient, uniq } from '../lib/fixtures.mjs';

const monthsAgo = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - n); return x.toISOString().slice(0, 10); };
// A patient whose cleaning and exam are overdue (history from their last dentist), so they're on the recall list.
async function overdue(t, first) {
  const { hygienist } = t._refs || {};
  const p = await newPatient(t, first, { last_name: `Aaron${uniq()}`, ...(hygienist ? { primary_hygienist_id: hygienist.id } : {}) });
  for (const [code, date] of [['D1110', monthsAgo(t.today, 7)], ['D0120', monthsAgo(t.today, 7)]]) {
    await t.as('admin').post(`/patients/${p.id}/outside-procedures`, { code, date, office_name: 'Previous dentist' });
  }
  return p;
}
// The list row for the patient (sorted by due date: the robot's patient may not be first).
const rowOf = (t, p) => t.page.locator('main tr', { hasText: `${p.first_name} ${p.last_name}` }).first();

export default {
  A037: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await overdue(t, 'Rena') }),
    async run(t, { p }) {
      await t.open('/followups?tab=recall', 'main table');
      const row = rowOf(t, p);
      if (!(await row.count())) throw new Error('the overdue patient is not on the recall list');
      await t.step('Follow-up → Recall: overdue patients with their phone number. Call them; they want to book. Click "Book" on their row', async () => {
        await t.click(row.locator('button:has-text("Book")'));
        await t.see('.modal');
      });
      await t.step('The booking form opens; press Enter / click Book appointment on the suggested time', async () => {
        await t.page.waitForTimeout(400);
        const focused = await t.page.evaluate(() => document.activeElement?.textContent || ''); // eslint-disable-line no-undef
        if (/Book appointment/.test(focused)) await t.key('Enter');
        else await t.click('.modal button.primary:has-text("Book")');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A051: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await overdue(t, 'Vera') }),
    async run(t, { p }) {
      await t.open('/followups?tab=recall', 'main table');
      const row = rowOf(t, p);
      await t.step('Click "Log call" on their row: a dialog with the outcomes, "Left voicemail" already picked', async () => {
        await t.click(row.locator('button:has-text("Log call")'));
        await t.see('.modal');
      });
      await t.step('Click Save: logged for the whole team to see', async () => {
        await t.click('.modal button:has-text("Save")');
        await t.see('.modal', { state: 'detached' });
      });
      const same = await t.page.locator('main tr', { hasText: `${p.first_name} ${p.last_name}` }).count();
      if (same > 1) t.flag('layout', `The recall list shows the same patient on ${same} rows (one per recall type: exam, cleaning, x-rays); a call has to be logged per row`);
    },
  },

  A057: {
    role: 'frontdesk',
    async setup(t) {
      const p = await newPatient(t, 'Una', { last_name: `Aunsched${uniq()}` });
      await t.as('admin').post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth: '3' });
      await t.as('admin').post(`/patients/${p.id}/treatment-plans`, { all_unplanned: true });
      return { p };
    },
    async run(t, { p }) {
      await t.open('/followups?tab=unscheduled', 'main table');
      const row = rowOf(t, p);
      if (!(await row.count())) throw new Error('the patient is not on the unscheduled list');
      await t.step('Follow-up → Unscheduled treatment: click "Log call" on their row', async () => {
        await t.click(row.locator('button:has-text("Log call")'));
        await t.see('.modal');
      });
      await t.step('Pick "Spoke — will call back" and click Save', async () => {
        await t.click('.modal button:has-text("will call back")');
        await t.click('.modal button:has-text("Save")');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A093: {
    role: 'frontdesk',
    async setup(t) {
      // A visit last week that the patient missed.
      const p = await newPatient(t, 'Brooke', { last_name: `Abroken${uniq()}` });
      const d = new Date(Date.parse(`${t.today}T12:00:00Z`) - 6 * 86400_000).toISOString().slice(0, 10);
      const { dentist } = t._refs || {};
      const prov = dentist || (await t.as('admin').get('/providers?active=true'))[0];
      const a = await t.as('admin').post('/appointments', { patient_id: p.id, provider_id: prov.id, start_time: `${d} 06:00`, end_time: `${d} 06:30`, override_blockout: true, notify: false });
      await t.as('admin').patch(`/appointments/${a.id}/status`, { status: 'no_show' });
      return { p };
    },
    async run(t) {
      await t.open('/followups?tab=broken', 'main table tbody tr');
      const row = t.page.locator('main tbody tr').first();
      if (!(await row.count())) throw new Error('no broken appointments to work');
      await t.step('Follow-up → Broken appointments: click "Rebook" on the first row', async () => {
        await t.click(row.locator('button:has-text("Book")'));
        await t.see('.modal');
      });
      await t.step('Book the suggested time', async () => {
        await t.page.waitForTimeout(400);
        const focused = await t.page.evaluate(() => document.activeElement?.textContent || ''); // eslint-disable-line no-undef
        if (/Book appointment/.test(focused)) await t.key('Enter');
        else await t.click('.modal button.primary:has-text("Book")');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },
};
