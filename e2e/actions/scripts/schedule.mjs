// Schedule actions: viewing the day, status changes, booking, moving, confirming, cancelling.
/* global document */
import { newPatient, book, quietDay, activate, refs, until, cardSel, addDays, MOD } from '../lib/fixtures.mjs';

// A visit for today late in the evening (never collides with the demo day), focused on the schedule.
let slot = 0;
async function todaysVisit(t, first, _minute, status) {
  const p = await newPatient(t, first);
  // Evening slots 45 minutes apart after the demo day ends, so the robot's visits never overlap each other.
  const a = await book(t, p, t.today, 18 * 60 + 45 * (slot++ % 12), 40);
  if (status) await t.as('admin').patch(`/appointments/${a.id}/status`, { status });
  return { p, a };
}
async function focusVisit(t, a) {
  await t.open(`/schedule?date=${t.today}&view=day`, cardSel(a.id));
  await t.page.focus(cardSel(a.id));
}

export default {
  A001: {
    role: 'frontdesk',
    async run(t) {
      await t.open('/', '.sidebar');
      await t.step('Press G then S: today’s schedule opens', async () => {
        await t.key('g');
        await t.key('s');
        await t.see('.cal-col-head');
      });
    },
  },

  A009: {
    role: 'frontdesk',
    async run(t) {
      await t.open('/schedule', '.cal-col-head');
      await t.step('Press P: one column per provider', async () => {
        await t.key('p');
        await t.see('.cal-col-head .cal-col-avatar');
      });
      await t.step('Press V: just one provider', async () => {
        await t.key('v');
        await t.page.waitForFunction(() => document.querySelectorAll('.cal-col-head').length === 1);
      });
      await t.step('Press C: back to one column per chair', async () => {
        await t.key('c');
        await t.page.waitForFunction(() => !document.querySelector('.cal-col-head .cal-col-avatar'));
      });
      t.note('Three separate view switches measured together; each is one key.');
    },
  },

  A010: {
    role: 'frontdesk',
    setup: (t) => todaysVisit(t, 'Checkin', 21 * 60),
    async run(t, { a }) {
      await focusVisit(t, a);
      await t.step('With the visit focused, press I: the patient is checked in', async () => {
        await t.key('i');
        await t.see(`${cardSel(a.id)}.status-checked_in:not(.pending)`);
      });
      await until(t, async () => (await t.api.get(`/appointments/${a.id}`)).status === 'checked_in', 'the check-in to save');
    },
  },

  A012: {
    role: 'hygienist',
    setup: (t) => todaysVisit(t, 'Seated', 21 * 60 + 10, 'checked_in'),
    async run(t, { a }) {
      await focusVisit(t, a);
      await t.step('Press S: the patient is seated', async () => {
        await t.key('s');
        await t.see(`${cardSel(a.id)}.status-in_chair:not(.pending)`);
      });
    },
  },

  A018: {
    role: 'hygienist',
    setup: (t) => todaysVisit(t, 'Ready', 21 * 60 + 20, 'in_chair'),
    async run(t, { a }) {
      await focusVisit(t, a);
      await t.step('Press R: the card shows "ready for the doctor"', async () => {
        await t.key('r');
        await t.see(`${cardSel(a.id)} .cal-ready`);
      });
    },
  },

  A013: {
    role: 'frontdesk',
    setup: (t) => todaysVisit(t, 'Outgoing', 21 * 60 + 30, 'in_chair'),
    async run(t, { a }) {
      await focusVisit(t, a);
      await t.step('Press O (the "Out" key in the ? list)', async () => {
        await t.key('o');
        await t.page.waitForSelector(`${cardSel(a.id)}.status-completed:not(.pending), .drawer, .opt-panel`);
      });
      if (await t.page.locator('.opt-panel').count()) {
        t.flag('bug', 'O opens "Today’s plan" (the schedule optimizer also uses O) instead of marking the visit out — the visit stays in the chair');
        await t.step('Wrong panel: press Esc, then click the visit to open its panel', async () => {
          await t.key('Escape');
          await t.click(cardSel(a.id));
          await t.see('.drawer');
        });
        await t.step('Click the step button in the panel header until "Out" / "Complete visit"', async () => {
          for (let i = 0; i < 3 && (await t.api.get(`/appointments/${a.id}`)).status !== 'completed'; i++) {
            const b = t.page.locator('.drawer .drawer-next button, .drawer button:has-text("Complete visit")').first();
            await t.click(b);
            await t.wait(500);
          }
        });
      } else if (await t.page.locator('.drawer').count()) {
        await t.step('The panel opens with "Complete visit" focused: press Enter', async () => {
          await t.key('Enter');
        });
      }
      await until(t, async () => (await t.api.get(`/appointments/${a.id}`)).status === 'completed', 'the visit to be completed');
    },
  },

  A016: {
    role: 'frontdesk',
    async setup(t) {
      const day = addDays(quietDay(t.today), 7);
      const made = [];
      for (const [i, first] of ['Una', 'Cora'].entries()) made.push(await book(t, await newPatient(t, first), day, (13 + i) * 60, 30));
      return { day, made };
    },
    async run(t, { day, made }) {
      const [a] = made;
      // The person has the visit in front of them on the schedule (the call about it), as with the other flow keys.
      await t.open(`/schedule?date=${day}&view=day`, cardSel(a.id));
      await t.page.focus(cardSel(a.id));
      await t.step('With the visit selected, press C: confirmed by phone (Undo shows)', async () => {
        await t.key('c');
        await t.see(`${cardSel(a.id)}.status-confirmed:not(.pending)`);
      });
      await until(t, async () => (await t.api.get(`/appointments/${a.id}`)).status === 'confirmed', 'the confirmation');
      t.note('The day’s whole unconfirmed list is U (or the "N unconfirmed" pill), then C per row.');
    },
  },

  A094: { // Text a reminder to everyone unconfirmed
    role: 'frontdesk',
    async setup(t) {
      const day = addDays(quietDay(t.today), 8);
      for (const [i, first] of ['Rhea', 'Lou'].entries()) await book(t, await newPatient(t, first), day, (13 + i) * 60, 30);
      return { day };
    },
    async run(t, { day }) {
      await t.open(`/schedule?date=${day}&view=day`, '.cal-col-head');
      await t.step('Click "N unconfirmed": the list opens', async () => {
        await t.click('.unconfirmed-link');
        await t.see('tr.kb-row');
      });
      await t.step('Click "Text a reminder to all": texts go out, a count shows', async () => {
        await t.click('button:has-text("Text a reminder to all")');
        await t.see('.remind-result');
      });
    },
  },

  A020: {
    role: 'frontdesk',
    async setup(t) {
      const { providers } = await refs(t);
      const own = providers.find((p) => p.type === 'dentist') || providers[0];
      const p = await newPatient(t, 'Alta', { primary_provider_id: own.id });
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/schedule', '.cal-col-head');
      await t.step('Press Alt+B: the booking form opens on the patient’s next open time with their dentist', async () => {
        await t.key('Alt+b');
        await t.see('.modal .book-suggest strong');
        await t.page.waitForFunction(() => document.activeElement?.textContent === 'Book appointment');
      });
      await t.step('Press Enter: booked', async () => {
        await t.key('Enter');
        await t.see('.modal', { state: 'detached' });
      });
      await until(t, async () => (await t.api.get(`/appointments?patient_id=${p.id}&from=${t.today}&to=${addDays(t.today, 400)}`)).length, 'the booking');
    },
  },

  A082: { // same-day emergency, found by name
    role: 'frontdesk',
    async setup(t) {
      return { p: await newPatient(t, 'Emmett') };
    },
    async run(t, { p }) {
      await t.open(`/schedule?date=${t.today}&view=day`, '.cal-col-head');
      await t.step('Press N: the booking form asks who', async () => {
        await t.key('n');
        await t.see('.modal input[aria-label="Find a patient"]');
      });
      await t.step('Type the patient’s name and press Enter: the first open time today is suggested', async () => {
        await t.type(`${p.first_name} ${p.last_name}`);
        await t.see(`.modal .picker-row.hl:has-text("${p.first_name}")`);
        await t.key('Enter');
        await t.see('.modal .book-suggest strong');
      });
      const suggested = (await t.page.textContent('.modal .book-suggest')).replace(/\s+/g, ' ').trim();
      t.note(`Suggested: ${suggested}`);
      await t.step('Press Enter: booked', async () => {
        await t.page.waitForFunction(() => document.activeElement?.textContent === 'Book appointment');
        await t.key('Enter');
        await t.see('.modal', { state: 'detached' });
      });
      const [a] = await until(t, async () => { const l = await t.api.get(`/appointments?patient_id=${p.id}&from=${t.today}&to=${addDays(t.today, 400)}`); return l.length ? l : null; }, 'the booking');
      if (!a.start_time.startsWith(t.today)) t.flag('asks-known', `Booked from today’s schedule for an emergency, but the suggested time was ${a.start_time} — not today; the person has to pick a time by hand`);
    },
  },

  A029: {
    role: 'frontdesk',
    async setup(t) {
      const day = quietDay(t.today);
      const a = await book(t, await newPatient(t, 'Moe'), day, 14 * 60, 50);
      return { day, a };
    },
    async run(t, { day, a }) {
      await t.open(`/schedule?date=${day}&view=day`, cardSel(a.id));
      await t.page.focus(cardSel(a.id));
      await t.step('Press M: the visit lifts off the schedule', async () => {
        await t.key('m');
        await t.see('.cal-ghost.carry');
      });
      await t.step('Press Shift+→: same time the next day', async () => {
        await t.key('Shift+ArrowRight');
        await t.wait(200);
      });
      await t.step('Press Enter: moved (Undo shows)', async () => {
        await t.key('Enter');
        await t.see('.toast-undo');
      });
      await until(t, async () => (await t.api.get(`/appointments/${a.id}`)).start_time.startsWith(addDays(day, 1)), 'the move');
    },
  },

  A054: { // cancel with reason and rebook
    role: 'frontdesk',
    async setup(t) {
      const day = quietDay(t.today, 22);
      const a = await book(t, await newPatient(t, 'Cass'), day, 9 * 60, 60);
      return { day, a };
    },
    async run(t, { day, a }) {
      await t.open(`/schedule?date=${day}&view=day`, cardSel(a.id));
      await t.page.focus(cardSel(a.id));
      await t.step('Press X: the reasons list opens', async () => {
        await t.key('x');
        await t.see('.broken-picker');
      });
      await t.step('Press 2 ("schedule conflict"): cancelled, and a rebook form opens on the next opening', async () => {
        await t.key('2');
        await t.see('.modal .book-suggest strong');
      });
      await t.step('Press Enter: rebooked', async () => {
        await t.page.waitForFunction(() => document.activeElement?.textContent === 'Book appointment');
        await t.key('Enter');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A071: { // no-show
    role: 'frontdesk',
    async setup(t) {
      const day = quietDay(t.today, 23);
      const a = await book(t, await newPatient(t, 'Nova'), day, 13 * 60, 30);
      return { day, a };
    },
    async run(t, { day, a }) {
      await t.open(`/schedule?date=${day}&view=day`, cardSel(a.id));
      await t.page.focus(cardSel(a.id));
      await t.step('Press Shift+X: the reasons list opens', async () => {
        await t.key('Shift+X');
        await t.see('.broken-picker');
      });
      await t.step('Press 6 ("couldn’t reach them"): marked no-show; a rebook form opens', async () => {
        await t.key('6');
        await t.see('.modal');
      });
      await t.step('Press Esc: not rebooking now', async () => {
        await t.key('Escape');
        await t.see('.modal', { state: 'detached' });
      });
      await until(t, async () => (await t.api.get(`/appointments/${a.id}`)).status === 'no_show', 'the no-show');
    },
  },

  A041: { // change type / length / note
    role: 'frontdesk',
    async setup(t) {
      const day = quietDay(t.today, 24);
      const a = await book(t, await newPatient(t, 'Edith'), day, 10 * 60, 30);
      return { day, a };
    },
    async run(t, { day, a }) {
      await t.open(`/schedule?date=${day}&view=day`, cardSel(a.id));
      await t.step('Click the visit: its panel opens beside the schedule', async () => {
        await t.click(cardSel(a.id));
        await t.see('.drawer');
      });
      await t.step('Click Edit: the full appointment form opens (12 fields)', async () => {
        await t.click('.drawer button:has-text("Edit")');
        await t.see('.modal');
      });
      await t.step('Pick the new visit type (its usual length follows) and click Save', async () => {
        const type = t.page.locator('.modal select[aria-label="Appointment type"], .modal label:has-text("Appointment type") select').first();
        const opts = await type.locator('option').allTextContents();
        await type.selectOption({ index: Math.max(1, opts.findIndex((o) => /crown/i.test(o))) });
        await t.click('.modal button.primary');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A044: { // route slip
    role: 'frontdesk',
    async setup(t) {
      const { a } = await todaysVisit(t, 'Slippy', 0);
      return { a };
    },
    async run(t, { a }) {
      await focusVisit(t, a);
      await t.step('Press Enter on the visit: its panel opens', async () => {
        await t.key('Enter');
        await t.see('.drawer');
      });
      const link = t.page.locator('.drawer a:has-text("Route slip"), .drawer button:has-text("Route slip"), .drawer a:has-text("slip"), .drawer button:has-text("Print")').first();
      if (!(await link.count())) {
        t.flag('dead-end', 'The visit panel has no route slip / walkout button: the address /appointments/:id/route-slip has to be known');
        await t.step('Open the route slip by its address', async () => {
          await t.page.goto(`${t.base}/appointments/${a.id}/route-slip`);
          await t.see('main, .route-slip, h1');
        });
        return;
      }
      await t.step('Click "Route slip": the slip opens ready to print', async () => {
        await t.click(link);
        await t.wait(800);
      });
      for (const pg of t.ctx.pages()) if (pg !== t.page) await pg.close();
    },
  },

  A076: { // add to ASAP list
    role: 'frontdesk',
    async setup(t) {
      const day = quietDay(t.today, 25);
      const a = await book(t, await newPatient(t, 'Asap'), day, 11 * 60, 30);
      return { day, a };
    },
    async run(t, { day, a }) {
      await t.open(`/schedule?date=${day}&view=day`, cardSel(a.id));
      await t.step('Click the visit: its panel opens', async () => {
        await t.click(cardSel(a.id));
        await t.see('.drawer');
      });
      await t.step('Click "Add to ASAP list": they’ll be offered any earlier opening', async () => {
        await t.click('.drawer button:has-text("Add to ASAP")');
        await t.see('.drawer button:has-text("Remove from ASAP")');
      });
      await until(t, async () => (await t.api.get(`/appointments/${a.id}`)).asap, 'the ASAP flag');
    },
  },

  A115: { // block time
    role: 'frontdesk',
    async run(t) {
      const day = quietDay(t.today, 26);
      await t.open(`/schedule?date=${day}&view=day`, '.cal-col-head');
      await t.step('Click the "Block time" button (the ⊘ icon above the schedule)', async () => {
        await t.click('button[title*="Block"], button[aria-label*="Block"]');
        await t.see('.modal');
      });
      await t.step('Click the "Staff meeting" chip (reason filled in; 12:00–1:00, whole office by default)', async () => {
        await t.click('.modal button:has-text("Staff meeting")');
      });
      await t.step('Click "Block time"', async () => {
        await t.click('.modal button:has-text("Block time")');
        await t.see('.modal', { state: 'detached' });
      });
      t.note('Defaults: today’s date on screen, 12:00–1:00, every chair; changing the times is two more fields.');
    },
  },

  A058: { // online booking: the front desk sees it and marks it seen
    role: 'frontdesk',
    async setup(t) {
      const practice = await t.as('admin').get('/practice');
      const slug = practice.slug || 'bright-smiles';
      if (!practice.online_booking || !practice.slug) await t.as('admin').put('/practice', { online_booking: true, slug });
      const os = await (await fetch(`${t.base}/api/public/os/${slug}`)).json();
      const type = (os.visit_types || os.types || []).find((x) => x.kind === 'new_patient') || (os.visit_types || os.types || [])[0];
      const slots = await (await fetch(`${t.base}/api/public/os/${slug}/slots?visit_type_id=${type.id}&people=1`)).json();
      const start = slots.days?.find((d) => d.options?.length)?.options[0];
      const last = `Webby${Math.random().toString(36).slice(2, 7).replace(/\d/g, 'x')}`;
      const r = await fetch(`${t.base}/api/public/os/${slug}/book`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: `robot-${Date.now()}`, visit_type_id: type.id, start: start.start, people: [{ first_name: 'Nora', last_name: last, dob: '1990-04-12' }], phone: '(512) 555-0188', email: 'nora.web@example.com', source: { src: 'google' }, insurance: {} }) });
      if (!r.ok) throw new Error(`online booking set-up: ${r.status} ${await r.text()}`);
      return { last };
    },
    async run(t, { last }) {
      await t.open('/schedule', '.cal-col-head');
      await t.step('Schedule ▾ → Online requests: today’s online bookings, already on the schedule', async () => {
        const link = t.page.locator('.sidebar a[href="/requests"]').first();
        if (!(await link.isVisible())) await t.click('.rail-mod[data-module="schedule"] .rail-mod-chev');
        await t.click(link);
        await t.see(`table.online-bookings tr:has-text("${last}")`);
      });
      await t.step('Click "Seen" on the booking', async () => {
        await t.click(t.page.locator('table.online-bookings tr', { hasText: last }).getByRole('button', { name: 'Seen' }));
        await t.see(`table.online-bookings tr:has-text("${last}") >> text=Seen`);
      });
    },
  },
};
