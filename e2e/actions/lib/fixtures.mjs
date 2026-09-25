/* global document, sessionStorage */
// Set-up helpers the action scripts share: fresh patients and visits made through the API (never counted), dates
// that don't collide with the demo schedule, and the "active patient" a person would already have open.
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
let seq = 0;
// Letters only: names with digits in them aren't realistic (and the one-line new-patient box rejects them).
export const uniq = () => { let n = Date.now() % 1e7 * 10 + (++seq % 10); let s = ''; while (n) { s += String.fromCharCode(97 + (n % 26)); n = Math.floor(n / 26); } return s; };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export async function refs(t) {
  if (t._refs) return t._refs;
  const admin = t.as('admin');
  const providers = await admin.get('/providers?active=true');
  const chairs = await admin.get('/operatories?active=true');
  const practice = await admin.get('/practice');
  t._refs = { providers, chairs, practice, dentist: providers.find((p) => p.type === 'dentist') || providers[0], hygienist: providers.find((p) => p.type === 'hygienist') || providers[0] };
  return t._refs;
}

// A new patient with a realistic profile. Last names are unique so searches find exactly them.
export async function newPatient(t, first = 'Robin', extra = {}) {
  const last = extra.last_name || `Robot${uniq()}`;
  const p = await t.as('admin').post('/patients', { first_name: first, last_name: last, dob: '1984-03-04', phone: `(512) 555-${String(1000 + (seq % 8999)).slice(-4)}`, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, sms_opt_in: 1, ...extra });
  return p;
}

// A visit on `date` at `minute` (minutes after midnight), in the first chair with the first dentist unless told
// otherwise. If that time is taken (a re-run against the same server), the next free slot after it.
export async function book(t, patient, date, minute, length = 30, extra = {}) {
  const { dentist, chairs } = await refs(t);
  for (let m = minute, i = 0; i < 12; i++, m += length + 5) {
    try {
      return await t.as('admin').post('/appointments', {
        patient_id: patient.id, provider_id: dentist.id, operatory_id: chairs[0].id, start_time: `${date} ${hhmm(m)}`, end_time: `${date} ${hhmm(m + length)}`,
        override_blockout: true, notify: false, reason: 'Robot visit', ...extra,
      });
    } catch (e) {
      if (e.status !== 409 || m + 2 * length + 5 >= 24 * 60) throw e;
    }
  }
  throw new Error(`no free time on ${date}`);
}

// A quiet Tuesday months ahead (the demo schedule sits around today).
export function quietDay(today, weeks = 20) {
  let d = addDays(today, weeks * 7);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 2) d = addDays(d, 1);
  return d;
}

// Makes `patientId` the active patient the way a person would have: by having opened their chart earlier
// (set-up, before the measured steps).
export async function activate(t, patientId) {
  await t.page.goto(`${t.base}/patients/${patientId}`);
  await t.page.waitForSelector('h1');
  await t.page.waitForFunction((id) => sessionStorage.getItem('dm_active_patient') === String(id), patientId);
}

// Opens a page from the menu (kept open, as most people have it): the module's ▾, then the page.
export async function menu(t, module, href, readySel, caption) {
  await t.step(caption, async () => {
    const link = t.page.locator(`.sidebar a[href="${href}"]`).first();
    if (!(await link.isVisible())) await t.click(`.rail-mod[data-module="${module}"] .rail-mod-chev`);
    await t.click(link);
    await t.see(readySel, { timeout: 20_000 });
  });
}

// A patient with a primary policy and finished, unbilled work (for claims, EOBs, estimates).
export async function insuredWithWork(t, first = 'Ivy', codes = ['D1110', 'D0120'], carrierName = 'Robot Dental PPO') {
  const admin = t.as('admin');
  const { dentist } = await refs(t);
  let carrier = (await admin.get('/carriers')).find((c) => c.name === carrierName);
  if (!carrier) carrier = await admin.post('/carriers', { name: carrierName, payer_id: '99999' });
  const p = await newPatient(t, first);
  const policy = await admin.post(`/patients/${p.id}/insurance`, { carrier_id: carrier.id, subscriber_name: `${p.first_name} ${p.last_name}`, subscriber_id: `RB${p.id}`, group_number: 'G1', annual_max: 150000, deductible: 5000 });
  const procs = [];
  for (const code of codes) procs.push(await admin.post(`/patients/${p.id}/procedures`, { code, provider_id: dentist.id, complete: true }));
  return { p, policy, procs, carrier };
}

// Waits until `check()` is truthy (server state after an action), up to ~5 s.
export async function until(t, check, what) {
  for (let i = 0; i < 50; i++) {
    const v = await check().catch(() => null);
    if (v) return v;
    await t.page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const focused = (t) => t.page.evaluate(() => {
  const el = document.activeElement;
  return el ? `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 40)}` : '';
});
export const cardSel = (id) => `.cal [data-appt-id="${id}"]`;

// In the open command bar: waits for the results to settle, then moves to the first row that says `label` with
// ↓/↑ (counted, as a person would) and flags it when that row wasn't already the highlighted first choice.
export async function pick(t, label) {
  const want = label.toLowerCase();
  await t.see('.palette-item');
  await t.page.waitForTimeout(500); // results from the server arrive in more than one batch
  // Row text without its leading icon (📅 ➕ ⚡ …).
  const rows = (await t.page.locator('.palette-item').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim().toLowerCase().replace(/^[^\p{L}\p{N}#]+/u, ''));
  // The row that *is* it (starts with it) beats one that merely mentions it ("Search all documents for …").
  let target = rows.findIndex((x) => x.startsWith(want));
  if (target < 0) target = rows.findIndex((x) => x.includes(want));
  if (target < 0) throw new Error(`the command bar has no "${label}" (it shows: ${rows.slice(0, 4).join(' | ')})`);
  const active = Math.max(0, await t.page.locator('.palette-item').evaluateAll((els) => els.findIndex((e) => e.classList.contains('active'))));
  // Already on a row that is what was asked for ("Office intranet (…)" for "intranet"): nothing to move.
  const ok = (x) => x.includes(want) && !x.startsWith('search all documents');
  const moves = ok(rows[active]) ? 0 : target - active;
  for (let i = 0; i < Math.abs(moves); i++) await t.key(moves > 0 ? 'ArrowDown' : 'ArrowUp');
  if (moves) t.flag('bug', `Command bar: typing "${label}" doesn’t put "${label}" first — Enter would open "${rows[active].slice(0, 60)}"; the person has to arrow down ${Math.abs(moves)}×`);
}

// Opens a page from the command bar the way a person who doesn't know where it lives would (Ctrl/⌘K, its name, Enter).
export async function viaCommandBar(t, words, readySel, caption, label = words) {
  await t.step(caption || `Press Ctrl/⌘K, type "${words}", Enter`, async () => {
    await t.key(`${MOD}+k`);
    await t.cmd(words);
    await pick(t, label);
    await t.key('Enter');
    await t.see(readySel, { timeout: 20_000 });
  });
}
