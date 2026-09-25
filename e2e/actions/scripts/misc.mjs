// The rest: filling an opening from the ASAP list, a provider's day off, ortho adjustments, campaigns, the report
// builder, insurance reconciliation, switching office.
/* global document */
import { newPatient, addDays, MOD } from '../lib/fixtures.mjs';

const localNow = (tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute)];
};
const at = (d, m) => `${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export default {
  A070: { // fill an opening from the ASAP list
    role: 'frontdesk',
    async setup(t) {
      const admin = t.as('admin');
      const before = await admin.get('/practice');
      // The optimizer only offers openings later today: pretend the office is somewhere it's morning (put back after).
      const tz = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Honolulu']
        .find((z) => { const m = localNow(z)[1]; return m >= 420 && m < 780; }) || 'UTC';
      await admin.put('/practice', { timezone: tz, send_from: '00:00', send_until: '00:00', office_hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['06:00', '22:00']]])) });
      t.after(async () => { await admin.put('/practice', { timezone: before.timezone, office_hours: before.office_hours, send_from: before.send_from, send_until: before.send_until }); });
      const [today] = localNow(tz);
      const doc = await admin.post('/providers', { name: `Dr. Fay Filler ${Date.now() % 1000}`, type: 'dentist' });
      await admin.post('/operatories', { name: `Fill chair ${Date.now() % 1000}` });
      const pt = await newPatient(t, 'Asa');
      const later = await admin.post('/appointments', { patient_id: pt.id, provider_id: doc.id, start_time: at(addDays(today, 7), 600), end_time: at(addDays(today, 7), 660), asap: 1, notify: false, add_type_procedures: false, override_blockout: true });
      return { today, later };
    },
    async run(t, { today }) {
      await t.open(`/schedule?date=${today}`, '.cal, .agenda');
      await t.step('Schedule: press L — today’s plan opens on the first opening, with the ASAP patient who fits', async () => {
        await t.key('l');
        await t.see('.opt-panel.opt-only .opt-card.active');
      });
      await t.step('Press B: their visit moves up into the opening (Undo shows)', async () => {
        await t.key('b');
        await t.see('.toast:has-text("Visit moved up")');
      });
    },
  },

  A120: { // provider day off
    role: 'admin',
    async run(t) {
      await t.open('/settings?tab=providers', '.card:has(h2:has-text("Time off & special hours"))');
      const card = t.page.locator('.card:has(h2:has-text("Time off & special hours"))');
      const day = addDays(t.today, 9);
      const typed = `${day.slice(5, 7)}${day.slice(8, 10)}${day.slice(0, 4)}`;
      await t.step('Settings → Providers → Time off: click "From" and type the date (Off all day is the default)', async () => {
        await t.click(card.locator('label:has-text("From") input[type=date]'), { position: { x: 12, y: 12 } });
        await t.type(typed);
      });
      const to = await card.locator('label:has-text("To") input[type=date]').inputValue();
      if (to !== day) {
        t.flag('bug', `Time off: "To" doesn’t follow "From" — after typing ${day} it shows ${to}, so a one-day change becomes a range unless "To" is retyped`);
        await t.step('Retype the same date in "To"', async () => {
          await t.click(card.locator('label:has-text("To") input[type=date]'), { position: { x: 12, y: 12 } });
          await t.type(typed);
        });
      }
      await t.step('Press Enter: saved', async () => {
        await t.key('Enter');
        await card.locator('.badge:has-text("Off")').first().waitFor();
      });
    },
  },

  A101: { // ortho adjustment
    role: 'dentist',
    // A patient in treatment: the last adjustment (six weeks ago) had .014 wires and Class II elastics.
    async setup(t) {
      const p = await newPatient(t, 'Brace');
      const c = await t.as('admin').post(`/patients/${p.id}/ortho`, { total_fee: 540000, months: 18, est_months: 18, appliance: 'brackets' });
      await t.as('admin').post(`/ortho/${c.id}/visits`, { visit_date: t.today, upper_wire: '.014 NiTi', lower_wire: '.014 NiTi', elastics: 'Class II 1/4" 6oz', next_weeks: 6 });
      return { p };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=ortho`, 'button:has-text("Log adjustment")');
      await t.step('Ortho tab: click "+ Log adjustment" — the last visit’s wires and elastics are filled in, the cursor in the upper wire', async () => {
        await t.click('button:has-text("Log adjustment")');
        await t.page.waitForFunction(() => document.activeElement?.closest?.('label')?.textContent?.startsWith('Upper wire'));
      });
      await t.step('Type the new upper wire, Tab, the new lower wire (the elastics stay)', async () => {
        await t.type('.016 NiTi');
        await t.key('Tab'); // Tab selects what's in the next box, so typing replaces it
        await t.type('.016 NiTi');
      });
      await t.step('Press Enter: logged', async () => {
        await t.key('Enter');
        await t.see('.toast:has-text("Adjustment logged")');
      });
    },
  },

  A136: { // campaign
    role: 'admin',
    async run(t) {
      await t.open('/campaigns', 'button:has-text("New campaign")');
      await t.step('Campaigns: click "+ New campaign" (it is already named, e.g. "Reactivation · October 2026")', async () => {
        await t.click('button:has-text("New campaign")');
        await t.see('textarea, .modal');
      });
      const name = t.page.locator('label:has-text("Name") input').first();
      if (await name.count() && !(await name.inputValue())) await t.step('Type a name for it', async () => { await t.click(name); await t.type('Fall cleaning reminder'); });
      await t.step('Pick who gets it ("office news": everyone who accepts messages); the message is already written', async () => {
        const who = t.page.locator('.modal label:has-text("Who") select');
        const opts = await who.locator('option').allTextContents();
        await who.selectOption({ index: Math.max(0, opts.findIndex((o) => /news|everyone|all patients/i.test(o))) });
        await t.wait(600);
      });
      const blank = t.page.locator('.modal .campaign-blanks button').first();
      if (await blank.count()) {
        await t.step('The message still says "[date]": click it under the message (it is selected) and type the date', async () => {
          await t.click(blank);
          await t.type('Monday, November 11');
          await t.see('.modal .campaign-blanks', { state: 'detached' });
        });
      }
      await t.step('Click "Send to N patients now…": it says who gets it (N by text, N by email)', async () => {
        const send = t.page.locator('.modal button:has-text("Send")').last();
        const text = await t.page.inputValue('.modal textarea');
        if (/\[[a-z ]+\]/i.test(text)) t.flag('bug', `The template goes out with an unfilled placeholder ("${text.match(/\[[a-z ]+\]/i)[0]}") — nothing stops a campaign being sent to every patient with it`);
        await t.wait(500); // the audience count follows the message
        if (await send.isDisabled()) { t.note('Nobody in that audience in the demo office: saved as a draft instead.'); await t.click('.modal button:has-text("Save draft")'); return; }
        await t.click(send);
        await t.see('.campaign-confirm');
      });
      if (await t.page.locator('.campaign-confirm').count()) {
        await t.step('Press Enter on "Yes, send N messages": sent (it can\'t be taken back, so this one step confirms it)', async () => {
          await t.key('Enter');
          await t.see('.modal', { state: 'detached' });
        });
      }
    },
  },

  A158: { // report builder
    role: 'admin',
    async run(t) {
      await t.open('/reports?tab=builder', 'h2:has-text("Report builder")');
      await t.step('Report builder: pick what to report on (procedures, completed are the defaults) and click Run', async () => {
        const run = t.page.locator('main button:has-text("Run")').first();
        if (await run.count()) await t.click(run);
        await t.wait(800);
      });
      await t.step('Click Save: a browser box asks for the report’s name', async () => {
        await t.click(t.page.locator('main button:has-text("Save")').first());
        await t.wait(800);
      });
      if (t.dialogs.length) t.flag('layout', 'Saving a report asks for its name in a browser prompt box instead of a box on the page');
    },
  },

  A127: { // insurance reconciliation
    role: 'billing',
    async run(t) {
      await t.open('/schedule', '.sidebar');
      await t.step('Press Ctrl/⌘K, type "insurance reconciliation", Enter', async () => {
        await t.key(`${MOD}+k`);
        await t.cmd('insurance reconciliation');
        await t.see('.palette-item');
        await t.wait(500);
        await t.key('Enter');
        await t.see('main h2');
      });
    },
  },

  A145: { // switch office
    role: 'admin',
    async setup(t) {
      // A second office for the practice (the demo has one); put away again afterwards so other actions see one.
      const list = await t.as('admin').get('/locations');
      const second = (list.rows || list).find((l) => l.name === 'Northside Office') || await t.as('admin').post('/locations', { name: 'Northside Office', city: 'Austin', state: 'TX' });
      if (!second.active) await t.as('admin').put(`/locations/${second.id}`, { active: 1 });
      t.after(() => t.as('admin').put(`/locations/${second.id}`, { active: 0 }));
      return { second };
    },
    async run(t, { second }) {
      await t.open('/schedule', '.sidebar');
      await t.step('Click your name (bottom of the menu): the office is at the top of that menu', async () => {
        await t.click('.rail-foot button.user-button');
        await t.see('select[aria-label="Office"]');
      });
      await t.step('Pick "Northside Office": every screen now works in that office', async () => {
        const sel = t.page.locator('select[aria-label="Office"]');
        await t.click(sel);
        await Promise.all([t.page.waitForLoadState('load'), sel.selectOption(String(second.id))]);
        await t.page.waitForFunction((id) => localStorage.getItem('dm_location') === String(id) || document.querySelector('select[aria-label="Office"]')?.value === String(id), second.id); // eslint-disable-line no-undef
      });
      t.note('Batch 3: measured with a second office added to the demo practice for the action (and put away afterwards).');
    },
  },
};
