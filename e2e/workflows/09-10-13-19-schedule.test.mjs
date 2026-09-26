// Workflows 9, 10, 13 and 19 (docs/workflows/specs/09-book.md, 10-reschedule.md, 13-confirm.md,
// 19-cancel-no-show.md): booking with smart defaults and the next open time, moving a visit with the keyboard,
// confirming from the unconfirmed list, and cancel / no-show with a reason and a one-step rebook.
/* global document, sessionStorage, KeyboardEvent */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launch, signIn } from '../lib/server.mjs';
import { trackActions, measure, withinBudget, MOD } from '../lib/budget.mjs';

let app; let browser; let s; let today; let chairs; let providers; let DAY; let NEXT;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
before(async () => {
  app = await startApp();
  browser = await launch();
  s = await signIn(browser, app.base);
  await trackActions(s.page);
  const tz = (await s.get('/practice')).timezone || 'America/New_York';
  today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  chairs = await s.get('/operatories?active=true');
  providers = await s.get('/providers?active=true');
  // A quiet Tuesday months ahead (the demo schedule sits around today), and the Wednesday after it.
  DAY = addDays(today, 150);
  while (new Date(`${DAY}T12:00:00Z`).getUTCDay() !== 2) DAY = addDays(DAY, 1);
  NEXT = addDays(DAY, 1);
  const hours = (await s.get(`/schedule?from=${DAY}&to=${NEXT}`)).hours;
  assert.ok(hours[DAY]?.length && hours[NEXT]?.length, `the office is open on ${DAY} and ${NEXT}`);
});
after(async () => { await browser?.close(); await app?.stop(); });

const put = (p, b) => s.api('PUT', p, b);
const newPatient = (first, extra = {}) => s.post('/patients', { first_name: first, last_name: 'Booktest', dob: '1988-03-04', phone: '(512) 555-0142', ...extra });
async function bookAt(patient, date, time, minutes, extra = {}) {
  const [h, m] = time.split(':').map(Number);
  const end = h * 60 + m + minutes;
  const a = await s.post('/appointments', {
    patient_id: patient.id, provider_id: providers[0].id, operatory_id: chairs[0].id, start_time: `${date} ${time}`,
    end_time: `${date} ${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`, override_blockout: true, notify: false, ...extra,
  });
  assert.ok(a.id, JSON.stringify(a));
  return a;
}
const card = (id) => `.cal [data-appt-id="${id}"]`;
const upcoming = async (patientId) => (await s.get(`/appointments?patient_id=${patientId}&from=${today}&to=${addDays(today, 400)}`));
async function until(check, what) {
  for (let i = 0; i < 50; i++) {
    const v = await check();
    if (v) return v;
    await s.page.waitForTimeout(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function openDay(date) {
  await s.page.goto(`${app.base}/schedule?date=${date}&view=day`);
  await s.page.waitForSelector('.cal-col-head');
}
// Where a time of day is on screen, from the hour labels in the grid's gutter.
const yOf = (minute) => s.page.evaluate((m) => {
  const labels = [...document.querySelectorAll('.cal-hour-label')].map((l) => ({ t: l.textContent, top: parseFloat(l.style.top) }));
  const toMin = (t) => { const [n, ap] = t.split(' '); return ((Number(n) % 12) + (ap === 'PM' ? 12 : 0)) * 60; };
  const [a, b] = labels;
  const ppm = (b.top - a.top) / (toMin(b.t) - toMin(a.t));
  return document.querySelector('.cal-body').getBoundingClientRect().top + a.top + (m - toMin(a.t)) * ppm;
}, minute);
const colX = (i) => s.page.evaluate((n) => { const r = document.querySelectorAll('.cal-col')[n].getBoundingClientRect(); return r.left + r.width / 2; }, i);

test('#9 book for the active patient from anywhere: Alt+B, then Enter books their next open time with their own provider and chair', async () => {
  const { page } = s;
  const own = providers.find((p) => p.type === 'dentist' && p.id !== providers[0].id) || providers.at(-1);
  const chair = chairs.at(-1);
  await put(`/operatories/${chair.id}`, { default_provider_id: own.id });
  const p = await newPatient('Alta', { primary_provider_id: own.id });
  const want = await s.get(`/appointments/suggest?patient_id=${p.id}&pick_type=1`);
  assert.ok(want.start_time, 'there is an opening to book');
  // Opening the chart makes them the active patient (setup).
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForFunction((id) => sessionStorage.getItem('dm_active_patient') === String(id), p.id);
  const r = await measure(page, async () => {
    await page.keyboard.press('Alt+b');
    await page.waitForSelector('.book-panel .book-suggest strong');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Book appointment');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.book-panel', { state: 'detached' });
  });
  console.log(withinBudget('book the active patient (Alt+B, Enter)', r, { actions: 3, ms: 6000 }));
  const [a] = await until(async () => { const l = await upcoming(p.id); return l.length ? l : null; }, 'the booking');
  assert.equal(a.provider_id, own.id, 'the patient’s own dentist, not the first provider');
  assert.equal(a.operatory_id, chair.id, 'the dentist’s usual chair');
  assert.equal(a.start_time, want.start_time, 'the next open time');
  assert.equal(a.status, 'scheduled');
  assert.deepEqual(s.errors, []);
});

test('#9 N and a patient search: the form fills in the rest and Book has the focus (4 actions, 2 of them finding the patient)', async () => {
  const { page } = s;
  const hyg = providers.find((p) => p.type === 'hygienist') || providers[0];
  const p = await newPatient('Nadia', { primary_provider_id: providers[0].id, primary_hygienist_id: hyg.id });
  await openDay(DAY);
  const r = await measure(page, async () => {
    await page.keyboard.press('n');
    await page.waitForSelector('.book-panel input[aria-label="Find a patient"]');
    await page.keyboard.type('Nadia Booktest');
    await page.waitForSelector('.book-panel .picker-row.hl:has-text("Nadia")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.book-panel .book-suggest strong');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Book appointment');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.book-panel', { state: 'detached' });
  });
  console.log(withinBudget('book from N with a patient search', r, { actions: 4, ms: 8000 }));
  const [a] = await until(async () => { const l = await upcoming(p.id); return l.length ? l : null; }, 'the booking');
  const want = await s.get(`/appointments/suggest?patient_id=${p.id}&after=${DAY}&provider_id=${a.provider_id}&duration=60`);
  assert.equal(a.provider_id, providers[0].id, 'their own dentist');
  assert.equal(a.start_time.slice(0, 10), DAY, 'the first opening on the day on screen');
  assert.ok(a.start_time <= want.start_time || want.start_time === null, 'nothing earlier was open');
  // The new booking has no Status field (it's always "scheduled").
  await page.keyboard.press('Escape');
  await page.keyboard.press('n');
  await page.waitForSelector('.book-panel');
  assert.equal(await page.locator('.book-panel select option[value="no_show"]').count(), 0, 'no Status picker on a new booking');
  await page.keyboard.press('Escape');
  assert.deepEqual(s.errors, []);
});

test('#9 drag a time, one click for the active patient, Book: 3 actions; the dragged time and length stay', async () => {
  const { page } = s;
  const own = providers.at(-1);
  const p = await newPatient('Dora', { primary_provider_id: own.id });
  await page.goto(`${app.base}/patients/${p.id}`);
  await page.waitForFunction((id) => sessionStorage.getItem('dm_active_patient') === String(id), p.id);
  await openDay(DAY);
  const colName = (await page.textContent('.cal-col-head .cal-col-title')).trim();
  const chair = chairs.find((c) => c.name === colName);
  const x = await colX(0);
  const y1 = await yOf(10 * 60 + 2);
  const y2 = await yOf(10 * 60 + 40);
  const r = await measure(page, async () => {
    await page.mouse.move(x, y1);
    await page.mouse.down();
    await page.mouse.move(x, y2, { steps: 6 });
    await page.mouse.up();
    await page.click('.book-panel .book-active');
    await page.waitForSelector('.book-panel .book-suggest strong');
    await page.click('.book-panel button.primary:has-text("Book appointment")');
    await page.waitForSelector('.book-panel', { state: 'detached' });
  });
  console.log(withinBudget('book from a drag', r, { actions: 3, ms: 6000 }));
  const [a] = await until(async () => { const l = await upcoming(p.id); return l.length ? l : null; }, 'the booking');
  assert.equal(a.start_time, `${DAY} 10:00`);
  assert.equal(a.end_time, `${DAY} 10:40`, 'the dragged length is kept');
  assert.equal(a.provider_id, own.id, 'the patient’s own provider, not the chair’s or the first');
  if (chair) assert.equal(a.operatory_id, chair.id, 'the chair it was dragged in');
  assert.deepEqual(s.errors, []);
});

test('#10 move with the keyboard: M, ↓, Enter (3 keys); another day with Shift+→; Undo puts it back', async () => {
  const { page } = s;
  const p = await newPatient('Moe');
  const a = await bookAt(p, DAY, '14:00', 50);
  await openDay(DAY);
  await page.waitForSelector(card(a.id));
  await page.focus(card(a.id));
  const same = await measure(page, async () => {
    await page.keyboard.press('m');
    await page.waitForSelector('.cal-ghost.carry');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast-undo');
  });
  console.log(withinBudget('move 1 slot later (M ↓ Enter)', same, { actions: 3, ms: 4000 }));
  await until(async () => (await s.get(`/appointments/${a.id}`)).start_time === `${DAY} 14:10`, 'the move to 14:10');
  assert.equal((await s.get(`/appointments/${a.id}`)).end_time, `${DAY} 15:00`, 'the length is kept');

  // Ctrl/⌘+Z while the notice shows puts it back.
  await page.keyboard.press(`${MOD}+z`);
  await until(async () => (await s.get(`/appointments/${a.id}`)).start_time === `${DAY} 14:00`, 'the undo');

  // To the next day at the same time.
  await page.waitForSelector(`${card(a.id)}:not(.pending)`);
  await page.focus(card(a.id));
  const other = await measure(page, async () => {
    await page.keyboard.press('m');
    await page.waitForSelector('.cal-ghost.carry');
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForSelector(`.carry-banner:has-text("${new Date(`${NEXT}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })}")`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast-undo');
  });
  console.log(withinBudget('move to the next day (M Shift+→ Enter)', other, { actions: 3, ms: 5000 }));
  await until(async () => (await s.get(`/appointments/${a.id}`)).start_time === `${NEXT} 14:00`, 'the move to the next day');

  // Esc leaves it where it was; nothing is saved.
  await page.waitForSelector(card(a.id));
  await page.focus(card(a.id));
  await page.keyboard.press('m');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.cal-ghost.carry', { state: 'detached' });
  assert.equal((await s.get(`/appointments/${a.id}`)).start_time, `${NEXT} 14:00`);
  assert.deepEqual(s.errors, []);
});

test('#10 fast typing: M, Shift+→, Enter with no pause still moves it to the next day (never "left where it was")', async () => {
  const { page } = s;
  const p = await newPatient('Speedy');
  const a = await bookAt(p, DAY, '13:00', 30);
  await openDay(DAY);
  await page.waitForSelector(card(a.id));
  await page.focus(card(a.id));
  // Real key presses back to back: no waiting for the banner, the ghost or the next day's columns.
  await page.keyboard.press('m');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast-undo');
  await until(async () => (await s.get(`/appointments/${a.id}`)).start_time === `${NEXT} 13:00`, 'the move to the next day');
  const moved = await s.get(`/appointments/${a.id}`);
  assert.equal(moved.end_time, `${NEXT} 13:30`, 'the length is kept');
  assert.equal(moved.operatory_id, a.operatory_id, 'the same chair');

  // Faster than any render: the whole burst in one go (M, then Shift+→ ×2, Shift+←, ↓, Enter) — each key acts on
  // the target the one before left, so it lands a day on and one step later.
  await put(`/appointments/${a.id}`, { start_time: `${DAY} 13:00`, end_time: `${DAY} 13:30` });
  await openDay(DAY);
  await page.waitForSelector(`${card(a.id)}:not(.pending)`);
  await page.focus(card(a.id));
  await page.keyboard.press('m');
  await page.waitForSelector('.cal-ghost.carry');
  await page.evaluate(() => {
    const send = (key, shiftKey = false) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    send('ArrowRight', true);
    send('ArrowRight', true);
    send('ArrowLeft', true);
    send('ArrowDown');
    send('Enter');
  });
  await until(async () => (await s.get(`/appointments/${a.id}`)).start_time === `${NEXT} 13:10`, 'the burst move');
  assert.equal((await s.get(`/appointments/${a.id}`)).operatory_id, a.operatory_id, 'still the same chair');
  assert.deepEqual(s.errors, []);
});

test('#10 onto blocked time: an inline question instead of a dialog (Enter moves it there); pinboard by keyboard', async () => {
  const { page } = s;
  const p = await newPatient('Blythe');
  const a = await bookAt(p, DAY, '15:00', 30);
  await s.post('/blockouts', { operatory_id: chairs[0].id, start_time: `${DAY} 16:00`, end_time: `${DAY} 17:00`, reason: 'Staff meeting' });
  await openDay(DAY);
  await page.waitForSelector(card(a.id));
  await page.focus(card(a.id));
  const r = await measure(page, async () => {
    await page.keyboard.press('m');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.override-banner');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.override-banner', { state: 'detached' });
  });
  console.log(withinBudget('move into blocked time (3 keys + yes)', r, { actions: 4, ms: 5000 }));
  await until(async () => (await s.get(`/appointments/${a.id}`)).start_time === `${DAY} 16:00`, 'the move into the block');

  // Pinboard: M then B parks it; M with nothing focused picks it up again on another day; Enter puts it down.
  await page.waitForSelector(`${card(a.id)}:not(.pending)`);
  await page.focus(card(a.id));
  await page.keyboard.press('m');
  await page.keyboard.press('b');
  await page.waitForSelector('.pinboard .pin-item');
  await openDay(NEXT);
  const pin = await measure(page, async () => {
    await page.keyboard.press('m');
    await page.waitForSelector('.cal-ghost.carry');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.pinboard .pin-item', { state: 'detached' });
  });
  console.log(withinBudget('place a pinned visit on another day (M Enter)', pin, { actions: 2, ms: 4000 }));
  await until(async () => (await s.get(`/appointments/${a.id}`)).start_time.startsWith(NEXT), 'the pinned visit placed');
  assert.deepEqual(s.errors, [], 'no confirm() dialogs');
});

test('#10 drag still moves a visit in one action, with Undo', async () => {
  const { page } = s;
  const p = await newPatient('Drew');
  const a = await bookAt(p, DAY, '11:00', 30);
  await openDay(DAY);
  const box = await page.locator(card(a.id)).boundingBox();
  const shift = (await yOf(12 * 60)) - (await yOf(11 * 60));
  const r = await measure(page, async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 6 + shift, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector('.toast-undo');
  });
  console.log(withinBudget('drag to move', r, { actions: 1, ms: 4000 }));
  await until(async () => (await s.get(`/appointments/${a.id}`)).start_time === `${DAY} 12:00`, 'the drag');
});

test('#13 "N unconfirmed" opens the list; C confirms a row (1 key each) with Undo; text a reminder to all in 1 click', async () => {
  const { page } = s;
  const day = addDays(DAY, 7);
  const made = [];
  for (const [i, first] of ['Una', 'Cora', 'Rhea'].entries()) made.push(await bookAt(await newPatient(first), day, `1${3 + i}:00`, 30));
  await openDay(day);
  const open = await measure(page, async () => {
    await page.click('.unconfirmed-link');
    await page.waitForSelector('tr.kb-row');
  });
  console.log(withinBudget('open the unconfirmed list from the schedule', open, { actions: 1, ms: 4000 }));
  assert.match(page.url(), new RegExp(`tab=unconfirmed.*date=${day}`));
  assert.equal(await page.locator('.unconf-table tbody tr').count(), 3, 'just that day’s unconfirmed visits');

  const text = await measure(page, async () => {
    await page.click('button:has-text("Text a reminder to all")');
    await page.waitForSelector('.remind-result');
  });
  console.log(withinBudget('text a reminder to all unconfirmed', text, { actions: 1, ms: 6000 }));
  assert.match(await page.textContent('.remind-result'), /Reminder sent to 3/);
  // Asking again right away doesn't text them twice.
  assert.ok(await page.locator('button:has-text("Text a reminder to all 0")').isDisabled());

  const first = Number(await page.getAttribute('tr.kb-row', 'data-appt-id'));
  const one = await measure(page, async () => {
    await page.keyboard.press('c');
    await page.waitForSelector(`tr[data-appt-id="${first}"]`, { state: 'detached' });
  });
  console.log(withinBudget('confirm one row', one, { actions: 1, ms: 2000 }));
  const second = Number(await page.getAttribute('tr.kb-row', 'data-appt-id'));
  const two = await measure(page, async () => {
    await page.keyboard.press('c');
    await page.waitForSelector(`tr[data-appt-id="${second}"]`, { state: 'detached' });
  });
  console.log(withinBudget('confirm the next row', two, { actions: 1, ms: 2000 }));
  await until(async () => (await s.get(`/appointments/${second}`)).status === 'confirmed', 'the confirmation');
  assert.equal((await s.get(`/appointments/${first}`)).confirmed_via, 'phone');

  // Undo the last one: back on the list and unconfirmed on the server.
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForSelector(`tr[data-appt-id="${second}"]`);
  await until(async () => (await s.get(`/appointments/${second}`)).status === 'scheduled', 'the undo');

  // J / X / Shift+C: select and confirm what's left in one go.
  const left = await page.locator('.unconf-table tbody tr').count();
  const bulk = await measure(page, async () => {
    for (let i = 0; i < left; i++) {
      await page.keyboard.press('x');
      if (i < left - 1) await page.keyboard.press('j');
    }
    await page.keyboard.press('Shift+C');
    await page.waitForSelector('.unconf-table tbody tr', { state: 'detached' });
  });
  console.log(withinBudget(`confirm ${left} selected`, bulk, { actions: left * 2, ms: 4000 }));
  for (const a of made) await until(async () => (await s.get(`/appointments/${a.id}`)).status === 'confirmed', `visit ${a.id} confirmed`);
  const hist = await s.get(`/appointments/${second}/history`);
  assert.ok(hist.some((h) => h.action === 'appointment.status' && JSON.parse(h.details).undo), 'the history shows the undo');
  assert.deepEqual(s.errors, []);
});

test('#13 on the schedule: C on a focused unconfirmed visit confirms it (1 key) with Undo; U opens the day’s list; C elsewhere is the Chairs view', async () => {
  const { page } = s;
  const day = addDays(DAY, 8);
  const a = await bookAt(await newPatient('Conny'), day, '13:00', 30);
  const b = await bookAt(await newPatient('Dora'), day, '14:00', 30);
  await openDay(day);
  await page.focus(card(a.id));
  const one = await measure(page, async () => {
    await page.keyboard.press('c');
    await page.waitForSelector(`${card(a.id)}.status-confirmed:not(.pending)`);
  });
  console.log(withinBudget('confirm the focused visit on the schedule', one, { actions: 1, ms: 2000 }));
  await until(async () => (await s.get(`/appointments/${a.id}`)).status === 'confirmed', 'the confirmation');
  assert.equal((await s.get(`/appointments/${a.id}`)).confirmed_via, 'phone');
  await page.waitForSelector('.toast:has-text("Confirmed Conny")');
  // Pressing C again on the now-confirmed visit doesn't confirm anything twice: it's the Chairs view again.
  await page.keyboard.press('c');
  await page.waitForTimeout(200);
  const hist = (await s.get(`/appointments/${a.id}/history`)).filter((h) => h.action === 'appointment.status');
  assert.equal(hist.length, 1, 'confirmed once');
  // Undo (Ctrl/⌘+Z while the notice shows): unconfirmed again, on screen and on the server.
  await page.keyboard.press(`${MOD}+z`);
  await until(async () => (await s.get(`/appointments/${a.id}`)).status === 'scheduled', 'the undo');
  await page.waitForSelector(`${card(a.id)}.status-scheduled`);
  // U: the day's unconfirmed list, in one key.
  const list = await measure(page, async () => {
    await page.keyboard.press('u');
    await page.waitForSelector('tr.kb-row');
  });
  console.log(withinBudget('open the unconfirmed list by key', list, { actions: 1, ms: 4000 }));
  assert.match(page.url(), new RegExp(`tab=unconfirmed.*date=${day}`));
  assert.equal(await page.locator(`tr[data-appt-id="${b.id}"]`).count(), 1);
  assert.deepEqual(s.errors, []);
});

test('#19 cancel with a reason and rebook: X, a number, Enter (3 keys); no-show with its reason', async () => {
  const { page } = s;
  const types = await s.get('/appointment-types?active=true');
  const type = types.find((t) => t.name === 'Filling') || types[0];
  const p = await newPatient('Cass');
  const a = await bookAt(p, DAY, '09:00', 60, { appointment_type_id: type.id, provider_id: providers.at(-1).id });
  await openDay(DAY);
  await page.waitForSelector(card(a.id));
  await page.focus(card(a.id));
  const r = await measure(page, async () => {
    await page.keyboard.press('x');
    await page.waitForSelector('.broken-picker');
    await page.keyboard.press('2');
    // The next opening shows as a line on the schedule (no form on top of it), with Book it focused.
    await page.waitForFunction(() => document.activeElement?.textContent === 'Book it' && document.activeElement.closest('.rebook-bar'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.rebook-bar', { state: 'detached' });
  });
  console.log(withinBudget('cancel with a reason and rebook', r, { actions: 3, ms: 8000 }));
  const old = await s.get(`/appointments/${a.id}`);
  assert.equal(old.status, 'cancelled');
  assert.equal(old.broken_reason, 'conflict');
  const next = await until(async () => (await upcoming(p.id)).find((x) => x.id !== a.id), 'the rebooked visit');
  assert.equal(next.appointment_type_id, type.id, 'the same kind of visit');
  assert.equal(next.provider_id, a.provider_id, 'with the same provider');
  assert.ok(next.start_time >= a.end_time, 'after the cancelled time');
  const hist = await s.get(`/appointments/${a.id}/history`);
  assert.ok(hist.some((h) => h.action === 'appointment.status' && JSON.parse(h.details).broken_reason === 'conflict'), 'the reason is in the history');

  // No-show: Shift+X and the reason — done; the rebook line waits without blocking anything (Esc puts it away).
  const b = await bookAt(await newPatient('Nova'), DAY, '13:00', 30);
  await openDay(DAY);
  await page.waitForSelector(card(b.id));
  await page.focus(card(b.id));
  const ns = await measure(page, async () => {
    await page.keyboard.press('Shift+X');
    await page.waitForSelector('.broken-picker');
    await page.keyboard.press('6');
    await page.waitForSelector('.rebook-bar');
  });
  console.log(withinBudget('no-show with a reason', ns, { actions: 2, ms: 4000 }));
  assert.equal(await page.locator('.modal, .side-panel').count(), 0, 'no form opens over the schedule');
  await page.waitForFunction(() => document.activeElement?.closest('.rebook-bar'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.rebook-bar', { state: 'detached' });
  const missed = await s.get(`/appointments/${b.id}`);
  assert.equal(missed.status, 'no_show');
  assert.equal(missed.broken_reason, 'no_contact');
  assert.deepEqual(s.errors, []);
});
