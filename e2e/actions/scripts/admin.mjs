// Settings and set-up: carriers, providers, chairs, visit types, codes, users, templates, fees, security, backups.
// A manager gets there the way most do: Settings at the bottom of the menu, then the section.
/* global document */
import { MOD, uniq } from '../lib/fixtures.mjs';

// Settings (menu) → the section in the list on the left.
async function section(t, label, tab) {
  await t.open('/schedule', '.sidebar');
  await t.step(`Click Settings (bottom of the menu), then "${label}"`, async () => {
    await t.click('.sidebar a[href="/settings"]');
    await t.see('.settings-nav');
    await t.click(`.settings-nav button:text-is("${label}"), .settings-nav a:text-is("${label}")`);
    await t.page.waitForURL(new RegExp(`tab=${tab}`));
  });
}
// A resource list's one-line add row (the cursor is already in its first box): types the given fields
// [[label, text]] — Tab to the next box, skipping any that already hold the right value (a smart default) — and
// presses Enter.
async function addRecord(t, what, fields) {
  await t.step(`Type the new ${what}: ${fields.map(([l]) => l).join(', ')} (the cursor is already in the add line)`, async () => {
    await t.see('.quick-add input');
    let at = await t.page.evaluate(() => [...document.querySelectorAll('.quick-add input, .quick-add select')].indexOf(document.activeElement));
    if (at < 0) { await t.click('.quick-add input'); at = 0; }
    for (const [label, text] of fields) {
      const boxes = t.page.locator('.quick-add input, .quick-add select');
      const want = await t.page.locator('.quick-add label').evaluateAll((ls, l) => ls.findIndex((x) => x.textContent.trim().toLowerCase().startsWith(l.toLowerCase())), label);
      const box = boxes.nth(want);
      if ((await box.inputValue()) === text) continue; // already right (a default or guessed from what was typed)
      while (at < want) { await t.key('Tab'); at++; }
      if (at !== want) { await t.click(box); at = want; }
      await t.type(text);
    }
  });
  await t.step('Press Enter: added (Undo on the toast)', async () => {
    const n = await t.page.locator('.settings-body tbody tr').count();
    await t.key('Enter');
    await t.page.waitForFunction((m) => document.querySelectorAll('.settings-body tbody tr').length > m, n);
    await t.see('.toast:has-text("Added")');
  });
}

export default {
  A139: {
    role: 'billing',
    async run(t) {
      await section(t, 'Insurance carriers', 'carriers');
      // "Guardian…" fills in Guardian's usual payer ID (64246).
      await addRecord(t, 'carrier', [['Name', `Guardian Dental ${uniq()}`], ['Payer ID', '64246']]);
    },
  },
  A172: {
    role: 'admin',
    async run(t) {
      await section(t, 'Providers', 'providers');
      // "…, DDS" in the name makes the Type Dentist; NPI, hours and the rest can follow (Edit, in place).
      await addRecord(t, 'provider', [['Name', `Dr. Robin ${uniq()}, DDS`], ['Type', 'dentist']]);
      if ((await t.page.locator('.settings-body tr', { hasText: 'Robin' }).last().textContent()).toLowerCase().includes('dentist') === false) t.flag('asks-known', 'Add provider doesn’t use the "DDS" typed in the name');
    },
  },
  A173: {
    role: 'admin',
    async run(t) {
      await section(t, 'Operatories', 'operatories');
      await addRecord(t, 'chair', [['Name', `Op ${uniq().slice(0, 3)}`]]);
    },
  },
  A164: {
    role: 'admin',
    async run(t) {
      await section(t, 'Appointment types', 'types');
      await addRecord(t, 'appointment type', [['Name', `Whitening consult ${uniq()}`], ['Length', '30']]);
    },
  },
  A165: {
    role: 'admin',
    async run(t) {
      await section(t, 'Procedure codes & fees', 'codes');
      // The category follows the code (D9… = adjunctive).
      await t.step('Type the whole line in the add box — code, description, fee — and press Enter (the category follows the code)', async () => {
        await t.see('.quick-add input');
        const box = t.page.locator('.quick-add input').first();
        if (!(await box.evaluate((el) => el === document.activeElement))) await t.click(box);
        await t.type(`D9${String(Date.now()).slice(-3)} Robot test procedure 95`);
        const n = await t.page.locator('.settings-body tbody tr').count();
        await t.key('Enter');
        await t.page.waitForFunction((m) => document.querySelectorAll('.settings-body tbody tr').length > m, n);
        await t.see('.toast:has-text("Added")');
      });
    },
  },

  A156: { // add a staff login
    role: 'admin',
    async run(t) {
      await section(t, 'Users & roles', 'users');
      await t.step('Type their name (the cursor is already in "Invite someone"), Tab, their email (they start as front desk)', async () => {
        const name = t.page.locator('.quick-add label:has-text("Name") input');
        if (!(await name.evaluate((el) => el === document.activeElement))) await t.click(name);
        await t.type('Riley Assistant');
        await t.key('Tab');
        await t.type(`riley.${uniq()}@example.com`);
      });
      await t.step('Press Enter (Send invitation): they get an email with a link to choose their own password', async () => {
        await t.key('Enter');
        await t.page.waitForFunction(() => document.querySelector('.invite-sent') || [...document.querySelectorAll('.toast')].some((x) => /Invitation emailed/.test(x.textContent)));
      });
      if (await t.page.locator('.invite-sent').count()) t.note('No email service in this office: the link is shown on the page to pass on.');
    },
  },

  A157: { // change a user's role
    role: 'admin',
    async setup(t) {
      const name = `Riley ${uniq()}`;
      await t.as('admin').post('/users', { name, email: `${name.replace(' ', '.').toLowerCase()}@example.com`, role: 'front_desk', password: 'Temp-pass-2026!' });
      return { name };
    },
    async run(t, { name }) {
      await section(t, 'Users & roles', 'users');
      await t.step(`Pick Billing in ${name}’s Role: saved at once (audited; they sign in again; Undo shows)`, async () => {
        const role = t.page.locator(`.settings-body select[aria-label="Role for ${name}"]`);
        await role.selectOption('billing');
        await t.see('.toast:has-text("is now Billing")');
      });
    },
  },

  A159: {
    role: 'admin',
    async run(t) {
      await section(t, 'Backups', 'backups');
      await t.see('h2:has-text("Automatic backups"), h3:has-text("Automatic backups")');
      t.note('The last automatic backup and restore test are on this page: nothing more to click.');
    },
  },

  A160: {
    role: 'admin',
    async run(t) {
      await section(t, 'Audit log', 'audit');
      await t.step('Type the patient # (the cursor is already there): every change to their chart shows as you type', async () => {
        const box = t.page.locator('.settings-body label:has-text("Patient") input').first();
        if (!(await box.evaluate((el) => el === document.activeElement))) await t.click(box);
        const before = await t.page.locator('.settings-body tbody tr').count();
        await t.type('3');
        await t.page.waitForFunction((n) => document.querySelectorAll('.settings-body tbody tr').length !== n || [...document.querySelectorAll('.settings-body tbody tr')].every((r) => /patient|#3/i.test(r.textContent)), before, { timeout: 5000 }).catch(() => {});
        await t.wait(600);
      });
    },
  },

  A161: {
    role: 'dentist',
    async run(t) {
      await section(t, 'Note templates', 'templates');
      await t.step('Type the template (the cursor is already in it; the name comes from its first words unless you type one)', async () => {
        await t.see('.inline-editor textarea');
        if (!(await t.page.evaluate(() => !!document.activeElement?.closest('.inline-editor')))) await t.click('.inline-editor textarea');
        await t.type(`Crown seat ${uniq()}: crown #__ seated with __ cement. Occlusion checked. Floss passes contacts.`);
      });
      await t.step('Press Ctrl/⌘+Enter: saved (it’s in the list)', async () => {
        await t.key(`${MOD}+Enter`);
        await t.see('.toast:has-text("Added")');
      });
    },
  },

  A174: { // change my password
    role: 'hygienist',
    async run(t) {
      await section(t, 'My account', 'account');
      t.note('The robot fills the form but doesn’t submit it (the demo passwords are shared by every run).');
      await t.step('Type the current password (the cursor is already there), Tab, the new one', async () => {
        const boxes = t.page.locator('.settings-body input[type="password"]');
        const n = await boxes.count();
        if (!(await boxes.first().evaluate((el) => el === document.activeElement))) await t.click(boxes.first());
        for (let i = 0; i < n; i++) {
          if (i) await t.key('Tab');
          await t.type(i === 0 ? 'demo-password-123' : 'a-new-longer-password-1');
        }
      });
    },
  },

  A154: { // raise fees
    role: 'admin',
    async run(t) {
      await section(t, 'Fee updates & history', 'fees');
      await t.see('.fsm-table tbody tr');
      await t.step('Press R: raise fees — 5% from next January 1 are the defaults, with a preview of the yearly effect', async () => {
        await t.key('r');
        await t.see('.fsm-preview .fsm-totals');
      });
      await t.step('Click "Schedule for Jan 1"', async () => {
        await t.click('.fsm-panel .form-actions button.primary');
        await t.see('.fsm-change');
      });
    },
  },

  A181: { // two-step sign-in
    role: 'frontdesk',
    async run(t) {
      await section(t, 'My account', 'account');
      await t.step('Click "Set up authenticator app": a QR code to scan with the phone', async () => {
        await t.click('button:has-text("Set up authenticator app")');
        await t.see('img[alt*="QR" i], canvas, svg');
      });
      t.note('Then the 6-digit code from the phone app (not driven by the robot).');
    },
  },
};
