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
// A resource list's "+ Add": fills the given fields [[label, text]] (click + type each) and saves.
async function addRecord(t, what, fields) {
  await t.step(`Click "+ Add": the new ${what} form`, async () => {
    await t.click('.settings-body button:has-text("Add")');
    await t.see('.modal, .settings-body form');
  });
  await t.step(`Fill in ${fields.map(([l]) => l).join(', ')}`, async () => {
    for (const [label, text] of fields) {
      const box = t.page.locator(`.modal label:has-text("${label}") input, .settings-body form label:has-text("${label}") input`).first();
      // The first box has the cursor when the form opens: just type.
      if (!(await box.evaluate((el) => el === document.activeElement))) {
        await t.click(box);
        await t.key(`${MOD}+a`);
      }
      await t.type(text);
    }
  });
  await t.step('Press Enter (or click Save)', async () => {
    if (await t.page.evaluate(() => !!document.activeElement?.closest('.modal form, .settings-body form') && document.activeElement.tagName === 'INPUT')) await t.key('Enter');
    else await t.click('.modal button.primary, .settings-body form button.primary');
    await t.see('.modal', { state: 'detached' });
  });
}

export default {
  A139: {
    role: 'billing',
    async run(t) {
      await section(t, 'Insurance carriers', 'carriers');
      await addRecord(t, 'carrier', [['Name', `Guardian Dental ${uniq()}`], ['Payer ID', '64246']]);
    },
  },
  A172: {
    role: 'admin',
    async run(t) {
      await section(t, 'Providers', 'providers');
      await t.step('Click "+ Add": the new provider form (12 fields)', async () => {
        await t.click('.settings-body button:has-text("Add")');
        await t.see('.modal');
      });
      await t.step('Type the name ("…, DDS": the Type follows — Dentist); the cursor is already in Name', async () => {
        if (!(await t.page.locator('.modal label:has-text("Name") input').first().evaluate((el) => el === document.activeElement))) await t.click('.modal label:has-text("Name") input');
        await t.type(`Dr. Robin ${uniq()}, DDS`);
        const type = t.page.locator('.modal label:has-text("Type") select');
        if ((await type.inputValue()) !== 'dentist') {
          t.flag('asks-known', 'Add provider doesn’t use the "DDS" typed in the name: the Type is picked by hand');
          await type.selectOption('dentist');
        }
      });
      await t.step('Press Enter: saved', async () => {
        await t.key('Enter');
        await t.see('.modal', { state: 'detached' });
      });
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
      await section(t, 'Fee schedule', 'codes');
      await t.step('Click "+ Add": the new procedure code form', async () => {
        await t.click('.settings-body button:has-text("Add")');
        await t.see('.modal');
      });
      await t.step('Type the code, Tab, the description, Tab, the fee (the category follows the code: D9… = adjunctive)', async () => {
        const fields = [['Code', `D9${String(Date.now()).slice(-3)}`], ['Description', 'Robot test procedure'], ['Fee', '95']];
        for (const [i, [label, text]] of fields.entries()) {
          const box = t.page.locator(`.modal label:has-text("${label}") input`).first();
          if (!(await box.evaluate((el) => el === document.activeElement))) {
            if (i) await t.key('Tab'); else await t.click(box);
          }
          await t.type(text);
        }
        const cat = t.page.locator('.modal label:has-text("Category") select');
        if (!(await cat.inputValue())) { t.flag('asks-known', 'The category isn’t taken from the code (D9… is adjunctive)'); await cat.selectOption({ index: 1 }); }
      });
      await t.step('Press Enter: saved', async () => {
        await t.key('Enter');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A156: { // add a staff login
    role: 'admin',
    async run(t) {
      await section(t, 'Users & roles', 'users');
      await t.step('Click "+ Invite user"', async () => {
        await t.click('button:has-text("Invite user")');
        await t.see('.modal');
      });
      await t.step('Type their name, Tab, their email; pick the role (front desk to start with)', async () => {
        if (!(await t.page.locator('.modal label:has-text("Name") input').first().evaluate((el) => el === document.activeElement))) await t.click('.modal label:has-text("Name") input');
        await t.type('Riley Assistant');
        await t.key('Tab');
        await t.type(`riley.${uniq()}@example.com`);
        const role = t.page.locator('.modal label:has-text("Role") select').first();
        if (await role.count()) await role.selectOption({ index: 1 });
      });
      if (await t.page.locator('.modal label:has-text("Temporary password") input').count()) {
        t.flag('wording', '"+ Invite user" opens "New user" and asks the manager to make up a temporary password to pass on, instead of emailing an invitation link');
        await t.step('Make up a temporary password and type it', async () => {
          await t.click('.modal label:has-text("Temporary password") input');
          await t.type('Temp-pass-2026!');
        });
      }
      await t.step('Click "Send invitation": they get an email with a link to choose their own password', async () => {
        await t.click('.modal button.primary');
        await t.page.waitForFunction(() => !document.querySelector('.modal') || document.querySelector('.invite-sent'));
      });
      if (await t.page.locator('.invite-sent').count()) {
        t.note('No email service in this office: the link is shown to pass on.');
        await t.step('Press Enter (Done): the link to give them is on screen', async () => {
          await t.key('Enter');
          await t.see('.modal', { state: 'detached' });
        });
      }
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
      const row = t.page.locator('.settings-body tr', { hasText: name }).first();
      await t.step(`Click Edit on ${name}’s row`, async () => {
        await t.click(row.locator('button:has-text("Edit")'));
        await t.see('.modal');
      });
      await t.step('Change the role to Billing and click Save (audited; they are signed out everywhere)', async () => {
        await t.page.locator('.modal select').first().selectOption('billing');
        await t.click('.modal button.primary');
        await t.see('.modal', { state: 'detached' });
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
      await t.step('Type the patient # to see every change to their chart', async () => {
        await t.click('.settings-body label:has-text("Patient") input, .settings-body input[placeholder*="Patient"]');
        await t.type('3');
        await t.key('Enter');
        await t.wait(800);
      });
    },
  },

  A161: {
    role: 'dentist',
    async run(t) {
      await section(t, 'Note templates', 'templates');
      await t.step('Click "+ Template"', async () => {
        await t.click('.settings-body button:has-text("Template")');
        await t.see('.modal, .settings-body form');
      });
      await t.step('Type the name and the template text; Save', async () => {
        await t.click('.modal input, .settings-body form input');
        await t.type(`Crown seat ${uniq()}`);
        await t.click('.modal textarea, .settings-body form textarea');
        await t.type('Crown #__ seated with __ cement. Occlusion checked. Floss passes contacts.');
        await t.click('.modal button.primary, .settings-body form button.primary');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A174: { // change my password
    role: 'hygienist',
    async run(t) {
      await section(t, 'My account', 'account');
      t.note('The robot fills the form but doesn’t submit it (the demo passwords are shared by every run).');
      await t.step('Type the current password and the new one twice', async () => {
        const boxes = t.page.locator('.settings-body input[type="password"]');
        const n = await boxes.count();
        for (let i = 0; i < n; i++) {
          await t.click(boxes.nth(i));
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
