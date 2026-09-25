// Office: tasks, the huddle, lab cases, supplies, the time clock, checklists, Needs attention, the intranet.
/* global document */
import { newPatient, activate, refs, MOD, viaCommandBar, menu } from '../lib/fixtures.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d1a1a40000000049454e44ae426082', 'hex');
let made = null;
// A daily checklist for the office manager's position, with a plain item and a spore test (once per run).
function checklist(t) {
  made ??= (async () => {
    const admin = t.as('admin');
    const setup = await admin.get('/checklists/setup');
    const pos = setup.positions.find((p) => p.name === 'Office manager') || setup.positions[0];
    const tag = Math.random().toString(36).slice(2, 6);
    const plain = `Lights on ${tag}`;
    const spore = `Spore test ${tag}`;
    const every = '0,1,2,3,4,5,6';
    await admin.post('/checklists/templates', { name: `Robot ${tag}`, position_id: pos.id, items: [
      { title: plain, cadence: 'daily', weekdays: every, due_time: '23:59' },
      { title: spore, cadence: 'daily', weekdays: every, due_time: '23:59', result_type: 'pass_fail', require_photo: true, critical: true },
    ] });
    return { plain, spore };
  })();
  return made;
}

export default {
  A028: {
    role: 'admin',
    async setup(t) {
      const p = await newPatient(t, 'Tasky');
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/schedule', `.patient-bar:has-text("${p.last_name}")`);
      await t.step('Press Ctrl/⌘K: the command bar opens', async () => {
        await t.key(`${MOD}+k`);
        await t.see('.palette input');
      });
      await t.step('Type "task call the lab about the crown @jordan" and press Enter: assigned to Jordan, about the active patient, due today', async () => {
        await t.type('task call the lab about the crown @jordan');
        await t.key('Enter');
        await t.see('.toast:has-text("Task for Jordan Lee")');
      });
    },
  },

  A034: {
    role: 'frontdesk',
    async setup(t) {
      const users = await t.as('admin').get('/users').catch(() => []);
      const jordan = (users.rows || users).find?.((u) => /Jordan/.test(u.name));
      const task = await t.as('admin').post('/tasks', { title: `Robot task ${Date.now() % 10000}`, assigned_to: jordan?.id, due_date: t.today, priority: 'high' });
      return { task };
    },
    async run(t, { task }) {
      await t.open('/office', '.task-row');
      const rows = await t.page.locator('.task-row').allTextContents();
      const idx = rows.findIndex((x) => x.includes(task.title));
      if (idx < 0) throw new Error('the task is not on the list');
      await t.step(idx ? `To-do & labs: press J to move down to the task (${idx}×)` : 'To-do & labs: the task is highlighted at the top', async () => {
        for (let i = 0; i < idx; i++) await t.key('j');
        await t.see(`.task-row.task-sel:has-text("${task.title}")`);
      });
      await t.step('Press X: done (Undo shows)', async () => {
        await t.key('x');
        await t.see(`.toast:has-text("Done: ${task.title}")`);
      });
      t.note('The J presses depend on where the task sits in the list; a person could also tick its box with one click.');
    },
  },

  A083: {
    role: 'frontdesk',
    async setup(t) {
      const admin = t.as('admin');
      let huddle = await admin.get('/huddle');
      if (!huddle.rows.some((x) => x.flags.includes('unconfirmed'))) {
        const p = await newPatient(t, 'Hugo');
        const slot = await admin.get(`/appointments/suggest?patient_id=${p.id}&from=${huddle.date}`);
        await admin.post('/appointments', { patient_id: p.id, provider_id: slot.provider_id, operatory_id: slot.operatory_id, start_time: slot.start_time, end_time: slot.end_time, appointment_type_id: slot.appointment_type_id });
        huddle = await admin.get(`/huddle?date=${huddle.date}`);
      }
      return { row: huddle.rows.find((x) => x.flags.includes('unconfirmed')) };
    },
    async run(t, { row }) {
      await t.open('/', `.huddle-row[data-appt="${row.id}"]`);
      await t.step('Today’s dashboard: the huddle flags each visit. Click the visit flagged "unconfirmed"', async () => {
        await t.click(`.huddle-row[data-appt="${row.id}"] .huddle-time`);
        await t.see(`.huddle-row.kb-row[data-appt="${row.id}"]`);
      });
      await t.step('Press C: confirmed on the row (Undo shows)', async () => {
        await t.key('c');
        await t.see(`.toast:has-text("Confirmed ${row.first_name} ${row.last_name}")`);
      });
    },
  },

  A073: {
    role: 'dentist',
    async setup(t) {
      const { dentist } = await refs(t);
      const p = await newPatient(t, 'Lara');
      await t.as('admin').post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth: '14', provider_id: dentist.id });
      const labs = (await t.as('admin').get('/labs')).filter((l) => l.active);
      const lab = labs[0] || await t.as('admin').post('/labs', { name: 'Robot Dental Lab', turnaround_days: 10 });
      await t.api.put('/me/prefs/lab.last', { value: { lab_id: lab.id, lab_name: lab.name } });
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/office', 'h2:has-text("Lab cases")');
      await t.step('To-do & labs: press L — a lab case for the active patient with the lab, the crown, the tooth and the dentist filled in; cursor on Shade', async () => {
        await t.key('l');
        await t.see('.modal');
        await t.page.waitForFunction(() => document.activeElement?.closest('label')?.textContent?.startsWith('Shade'));
      });
      await t.step('Type the shade and press Enter: case logged (Undo cancels it)', async () => {
        await t.type('A2');
        await t.key('Enter');
        await t.see(`.toast:has-text("Lab case logged for ${p.first_name}")`);
      });
    },
  },

  A059: {
    role: 'hygienist',
    async run(t) {
      await t.open('/timeclock', '.tc-big');
      await t.step('Time clock: press I — clocked in', async () => {
        await t.key('i');
        await t.see('.tc-hero-status:has-text("Clocked in since")');
      });
    },
  },

  A060: {
    role: 'dentist',
    async setup(t) { await t.api.post('/timeclock/in', {}).catch(() => {}); },
    async run(t) {
      await t.open('/timeclock', '.tc-hero-status:has-text("Clocked in")');
      await t.step('Time clock: press I again — clocked out', async () => {
        await t.key('i');
        await t.see('.tc-hero-status:has-text("clocked out")');
      });
    },
  },

  A061: {
    role: 'frontdesk',
    async setup(t) { await t.api.post('/timeclock/in', {}).catch(() => {}); },
    async run(t) {
      await t.open('/timeclock', '.tc-hero-status:has-text("Clocked in")');
      await t.step('Press L: on lunch (the time is kept; L again when you’re back)', async () => {
        await t.key('l');
        await t.see('button:has-text("I’m back")');
      });
      t.note('Ending lunch is the same one key (L) or one click on "I’m back"; starting and ending are measured as separate jobs of one action each.');
      t.afters.push(() => t.api.post('/timeclock/break/end', {}));
    },
  },

  A111: {
    role: 'admin',
    async setup(t) {
      const n = Date.now() % 10000;
      await t.as('admin').post('/inventory', { name: `Gloves robot ${n}`, unit: 'box', on_hand: 1, reorder_at: 3, reorder_qty: 10, supplier: 'Henry Schein', cost: 900 });
    },
    async run(t) {
      await t.open('/office?tab=supplies', 'h2:has-text("Supplies")');
      await t.step('Supplies: press O — the reorder list with what’s low, "Mark … ordered" focused', async () => {
        await t.key('o');
        await t.page.waitForFunction(() => /^Mark \d+ ordered$/.test(document.activeElement?.textContent || ''));
      });
      await t.step('Press Enter: marked ordered (Undo shows)', async () => {
        await t.key('Enter');
        await t.see('.toast:has-text("ordered")');
      });
      t.note('Placing the order with the supplier still happens outside the app (no purchase order is sent).');
    },
  },

  A112: {
    role: 'hygienist',
    async setup(t) {
      const name = `Bibs robot ${Date.now() % 10000}`;
      const item = await t.as('admin').post('/inventory', { name, unit: 'case', on_hand: 0, reorder_at: 1, reorder_qty: 2 });
      await t.as('admin').post('/inventory/reorder/order', { item_ids: [item.id] }).catch(() => {});
      return { name };
    },
    async run(t, { name }) {
      await t.open('/office?tab=supplies', 'h2:has-text("Supplies")');
      const btn = t.page.locator(`button[aria-label="Receive ${name}"]`);
      if (!(await btn.count())) {
        await t.step('Press O and Enter to mark it ordered first', async () => {
          await t.key('o');
          await t.page.waitForFunction(() => /^Mark \d+ ordered$/.test(document.activeElement?.textContent || ''));
          await t.key('Enter');
          await t.key('Escape');
          await t.see(`button[aria-label="Receive ${name}"]`);
        });
      }
      await t.step('Click "Received" on the item: stock updated (Undo shows)', async () => {
        await t.click(`button[aria-label="Receive ${name}"]`);
        await t.see('.toast:has-text("Received")');
      });
    },
  },

  A079: {
    role: 'admin',
    setup: (t) => checklist(t),
    async run(t, { plain }) {
      await t.open('/checklists', '.cl-mine');
      const row = t.page.locator('.cl-row', { has: t.page.locator('.cl-title', { hasText: plain }) });
      await row.waitFor();
      await t.step('Checklists: today’s items for my position. Click the box of the first item: ticked (Undo shows)', async () => {
        await t.click(row.locator('.cl-check'));
        await row.locator('.cl-check.on').waitFor();
      });
    },
  },

  A132: { // spore test with a photo
    role: 'admin',
    setup: (t) => checklist(t),
    async run(t, { spore }) {
      await t.open('/checklists', '.cl-mine');
      const row = t.page.locator('.cl-row', { has: t.page.locator('.cl-title', { hasText: spore }) });
      await row.waitFor();
      await t.step('On the spore-test item click "photo" and take/choose the picture of the test strip', async () => {
        await t.pickFile(() => row.locator('button', { hasText: /photo/i }).click(), { name: 'spore.png', mimeType: 'image/png', buffer: PNG });
        await row.locator('.req.ok').waitFor();
      });
      await t.step('Click "Pass": recorded with its photo and ticked', async () => {
        await t.click(row.locator('button.pass'));
        await row.locator('.cl-check.on').waitFor();
      });
    },
  },

  A049: {
    role: 'admin',
    async run(t) {
      await t.open('/', '.sidebar');
      await menu(t, 'manage', '/attention', 'h1:has-text("Needs attention")', 'In the menu open Manage ▾ and click "Needs attention"');
      const first = t.page.locator('main .attn-item, main tr.wl-row, main li.issue, main .card li').first();
      if (!(await first.count())) { t.note('Nothing needed attention in the demo office.'); return; }
      await t.step('The first item says what went wrong and what to do; open its fix', async () => {
        await t.click(t.page.locator('main button:has-text("Fix"), main a:has-text("Open"), main button:has-text("Resolve"), main a:has-text("Fix")').first());
        await t.wait(600);
      });
    },
  },

  A103: {
    role: 'dentist',
    async run(t) {
      await t.open('/', '.sidebar');
      await menu(t, 'manage', '/office', 'h2:has-text("Lab cases")', 'In the menu open Manage ▾ and click "To-do & labs": open lab cases with due dates and "at risk" flags');
    },
  },

  A108: {
    role: 'hygienist',
    async run(t) {
      await t.open('/', '.sidebar');
      await viaCommandBar(t, 'intranet', 'main h1, main h2', 'Press Ctrl/⌘K, type "intranet", Enter: the office manual opens');
    },
  },

  A100: {
    role: 'admin',
    async run(t) {
      await t.open('/', '.sidebar');
      await viaCommandBar(t, 'who’s in today', 'main h2, main table, .tabs button.active:has-text("Today")', 'Press Ctrl/⌘K, type "who’s in today", Enter: everyone’s status today');
    },
  },

  A122: {
    role: 'admin',
    async run(t) {
      await t.open('/', '.sidebar');
      await viaCommandBar(t, 'approve payroll hours', 'main h2, main table', 'Press Ctrl/⌘K, type "approve payroll hours", Enter: the pay period');
      const approve = t.page.locator('main button:has-text("Approve")').first();
      if (await approve.count()) {
        await t.step('Click "Approve"', async () => {
          await t.click(approve);
          await t.wait(600);
        });
      } else t.note('No hours waiting for approval in the demo office.');
    },
  },

  A138: {
    role: 'admin',
    async run(t) {
      await t.open('/', '.sidebar');
      await viaCommandBar(t, 'payroll export', 'main h2, main button', 'Press Ctrl/⌘K, type "payroll export", Enter');
      const dl = t.page.locator('main button:has-text("Download"), main button:has-text("Export"), main a:has-text("Download")').first();
      if (await dl.count()) {
        await t.step('Click the export/download button', async () => {
          await t.click(dl);
          await t.wait(800);
        });
      }
      for (const pg of t.ctx.pages()) if (pg !== t.page) await pg.close();
    },
  },

  A131: {
    role: 'frontdesk',
    async run(t) {
      await t.open('/', '.sidebar');
      await viaCommandBar(t, 'my bonus', 'main h1, main h2', 'Press Ctrl/⌘K, type "my bonus", Enter');
    },
  },

  A036: { // staff chat
    role: 'frontdesk',
    async run(t) {
      await t.open('/schedule', '.cal-col-head');
      await t.step('Press Ctrl/⌘J: Team chat opens on #Everyone with the cursor in the message box', async () => {
        await t.key(`${MOD}+j`);
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message' || document.activeElement?.tagName === 'TEXTAREA');
      });
      await t.step('Type the message and press Enter: sent', async () => {
        await t.type('Room 2 needs a turnover please');
        await t.key('Enter');
        await t.see('text=Room 2 needs a turnover please');
      });
    },
  },
};
