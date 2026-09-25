// Set-up screens used a few times a year (phase 2, batch 2A): a payer's new fee schedule, the team bonus, a
// perfect-day template, a form's wording, reminder settings, staff licences, the online booking link, and bringing
// the practice over from another system. A manager gets there from Settings at the bottom of the menu.
/* global document */
import { MOD, addDays, uniq } from '../lib/fixtures.mjs';
import { zip } from '../../../server/src/recordexport.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

async function section(t, label, tab) {
  await t.open('/schedule', '.sidebar');
  await t.step(`Click Settings (bottom of the menu), then "${label}"`, async () => {
    await t.click('.sidebar a[href="/settings"]');
    await t.see('.settings-nav');
    await t.click(`.settings-nav button:text-is("${label}")`);
    await t.page.waitForURL(new RegExp(`tab=${tab}`));
  });
}

export default {
  A155: { // a payer's new PPO fee schedule: it came in (the schedule's inbox read the payer's file) — check and approve
    role: 'admin',
    async setup(t) {
      const name = `Robot PPO ${uniq()}`;
      const fs = await t.as('admin').post('/fee-schedules', { name, kind: 'ppo', percent_of_ucr: 80 });
      const file = `robot-ppo-${uniq()}.csv`;
      await t.as('admin').post('/fees/imports', { fee_schedule_id: fs.id, text: 'code,fee\nD0120,41.00\nD1110,77.00\nD2740,905.00\n', file_name: file });
      return { file };
    },
    async run(t, { file }) {
      await section(t, 'Fee updates & history', 'fees');
      await t.step(`Click the new schedule waiting for approval (${file}): every difference side by side`, async () => {
        await t.click(`.fsm-change:has-text("${file}")`);
        await t.see('.fsm-panel .fsm-lines tbody tr');
      });
      await t.step('Press Enter (Approve has the focus): the new fees apply; the old ones are kept as the version before', async () => {
        await t.page.waitForFunction(() => /Approve/.test(document.activeElement?.textContent || ''));
        await t.key('Enter');
        await t.see('.fsm-panel .fsm-lines', { state: 'detached' });
      });
      t.note('A file from the payer can also be brought in by hand: I (Import a payer schedule) → Choose file.');
    },
  },

  A162: { // team bonus: a daily goal bonus from the ready-made plans
    role: 'admin',
    async run(t) {
      await section(t, 'Team bonus', 'bonus');
      await t.step('Click "Set up" on "Daily or weekly goal bonus": the plan opens filled in (name, goal, amount)', async () => {
        await t.click(t.page.getByLabel('Daily or weekly goal bonus').getByRole('button', { name: 'Set up' }));
        await t.see('button:has-text("Save plan")');
      });
      await t.step('Press Ctrl/⌘+Enter: the plan is saved', async () => {
        await t.key(`${MOD}+Enter`);
        await t.see('button:has-text("Save plan")', { state: 'detached' });
      });
      const on = t.page.locator('.settings-body label:has-text("Team bonuses are") input[type=checkbox]');
      if (!(await on.isChecked())) {
        await t.step('Tick "Team bonuses are off" → on: the team sees its progress', async () => {
          await t.click(on);
          await t.see('.settings-body label:has-text("Team bonuses are on")');
        });
      }
    },
  },

  A163: { // perfect-day template: a crown block in the morning
    role: 'admin',
    async run(t) {
      await section(t, 'Perfect day & late patients', 'daytemplates');
      await t.step('Click "New template": the first provider, Monday, and one block 8–10 AM are ready', async () => {
        await t.click('.settings-body button:has-text("New template")');
        await t.see('.dt-editor');
      });
      await t.step('Click "Crown prep" under the block: it’s kept for crowns (and named for them)', async () => {
        await t.click('.dt-editor .dt-types button:has-text("Crown prep")');
      });
      await t.step('Click "Create template": the block shows as a lane on Mondays', async () => {
        await t.click('.dt-editor button.primary:has-text("Create template")');
        await t.see('.dt-editor', { state: 'detached' });
      });
    },
  },

  A166: { // edit a form's wording
    role: 'admin',
    async run(t) {
      await section(t, 'Forms & consents', 'forms');
      const row = t.page.locator('.form-template-list tr', { hasText: 'Financial policy' }).first();
      await t.step('Click Edit on "Financial policy" (Forms & consents list): the wording opens under the list with a live preview, the cursor at the end of the text', async () => {
        await t.click(row.locator('button:has-text("Edit")'));
        await t.page.waitForFunction(() => document.activeElement?.matches?.('.form-template-editor textarea'));
      });
      await t.step('Type the new sentence', async () => {
        await t.type(' Payment plans are available — ask the front desk.');
      });
      await t.step('Press Ctrl/⌘+Enter: saved as a new version (signed copies keep the wording the patient saw)', async () => {
        await t.key(`${MOD}+Enter`);
        await t.see('.form-template-editor', { state: 'detached' });
      });
    },
  },

  A167: { // reminder settings: the 2-day reminder goes 1 day before instead
    role: 'admin',
    async run(t) {
      await section(t, 'Messages & reviews', 'messaging');
      const when = t.page.locator('.settings-body table select').nth(2);
      await t.step('Change the second reminder from "2 days" to "1 day" before the visit (the Save bar comes up)', async () => {
        await t.page.locator('.settings-body table select').first().waitFor();
        const selects = t.page.locator('.settings-body table select');
        const n = await selects.count();
        let target = null;
        for (let i = 0; i < n; i++) if ((await selects.nth(i).inputValue()) === '48') { target = selects.nth(i); break; }
        if (!target) target = when;
        const opts = await target.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
        const day = opts.find(([, l]) => /^1 day/.test(l)) || opts[1];
        await target.selectOption(day[0]);
        await t.see('.sticky-save');
      });
      await t.step('Press Ctrl/⌘+S: saved', async () => {
        await t.key(`${MOD}+s`);
        await t.see('.settings-body .badge:has-text("Saved")');
      });
    },
  },

  A170: { // a staff member's CPR card, with its expiry date, on the per-person tracker
    role: 'admin',
    async setup(t) {
      const users = (await t.as('admin').get('/users')).filter((u) => u.active);
      const first = (u) => u.name.replace(/^dr\.?\s+/i, '').split(/\s+/)[0];
      const who = users.find((u) => users.filter((x) => first(x).toLowerCase() === first(u).toLowerCase()).length === 1 && u.role !== 'admin') || users[0];
      return { first: first(who) };
    },
    async run(t, { first }) {
      await t.open('/documents?tab=staff', 'input[aria-label="Add or renew a licence"]');
      const exp = addDays(t.today, 700);
      await t.step(`Documents → Staff licences: type "${first.toLowerCase()} cpr ${exp.slice(5, 7)}/${exp.slice(8, 10)}/${exp.slice(0, 4)}" and press Enter: on their row, with a to-do for them 60 days before`, async () => {
        await t.type(`${first.toLowerCase()} cpr ${exp.slice(5, 7)}/${exp.slice(8, 10)}/${exp.slice(0, 4)}`);
        await t.see('.cred-preview:has-text("Enter adds it")');
        await t.key('Enter');
        await t.see('.toast:has-text("CPR")');
      });
      t.note('Batch 3: a per-person tracker (Documents → Staff licences & CPR) with reminders; the scan itself still goes in Office documents.');
    },
  },

  A180: { // online booking link
    role: 'admin',
    async run(t) {
      await section(t, 'Online booking links', 'booking');
      await t.step('Click "Copy" beside the website button (one line to paste before </body>); the booking page link and its QR code are above', async () => {
        await t.ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
        await t.click(t.page.locator('.settings-body button:has-text("Copy")').first());
        await t.see('.toast');
      });
    },
  },

  A183: { // import from another system (Dentrix export)
    role: 'admin',
    async run(t) {
      const file = zip([
        { name: 'DentrixExport/Providers.csv', data: 'Provider ID,Last Name,First Name,Title,NPI\nRDDS,Quill,Morgan,DDS,\n' },
        { name: 'DentrixExport/Patients.csv', data: `Chart #,Last Name,First Name,Birthdate,Gender,Status,Guarantor,Prim Prov,Cell Phone\nR${uniq()},Vanrobot,Harriet,02/03/1971,F,Patient,,RDDS,512-555-0101\n` },
        { name: 'DentrixExport/Aging.csv', data: 'Guarantor Chart #,Total Balance\n' },
      ]);
      await section(t, 'Import from another system', 'import');
      await t.step('Click "Dentrix": where to find the export in Dentrix, and a place to drop it', async () => {
        await t.click('.conv-source:has-text("Dentrix")');
        await t.see('.conv-howto');
      });
      await t.step('Click the drop area and choose the export: a dry run shows what would come over (nothing saved yet)', async () => {
        await t.pickFile(() => t.page.locator('.conv-drop').click(), { name: 'dentrix-export.zip', mimeType: 'application/zip', buffer: file });
        await t.see('text=What would be brought over', { timeout: 30_000 });
      });
      await t.step('Click "Import from Dentrix": imported, then reconciled against the export', async () => {
        await t.page.waitForFunction(() => !document.querySelector('.conv-actions button.primary')?.disabled);
        await t.click('.conv-actions button.primary:has-text("Import from")');
        await t.see('text=Reconciliation', { timeout: 60_000 });
      });
    },
  },
};
