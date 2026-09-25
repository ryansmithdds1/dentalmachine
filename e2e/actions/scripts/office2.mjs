// Office and HR: time clock corrections, time off, staff schedules, announcements, office documents, lab check-in,
// scanning paper, recall intervals, the cash drawer, online reviews.
import { newPatient, refs, addDays, MOD } from '../lib/fixtures.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

export default {
  A107: { // fix a missed punch (yesterday's)
    role: 'admin',
    async run(t) {
      await t.open('/timeclock?tab=fix', 'button:has-text("Add missed time")');
      await t.step('Time clock → Corrections: click "Add missed time" (a row for today 8:00–5:00, 60 min break)', async () => {
        await t.click('button:has-text("Add missed time")');
        await t.see('input[type="datetime-local"]');
      });
      await t.step('Pick the person who forgot', async () => {
        const sel = t.page.locator('select:near(input[type="datetime-local"])').first();
        const opts = await sel.locator('option').allTextContents();
        await sel.selectOption({ index: Math.max(0, opts.findIndex((o) => /Jordan/.test(o))) });
      });
      const y = addDays(t.today, -1);
      const typed = `${y.slice(5, 7)}${y.slice(8, 10)}${y.slice(0, 4)}`;
      await t.step('It was yesterday: change the date in "In" and in "Out"', async () => {
        for (const i of [0, 1]) {
          await t.click(t.page.locator('input[type="datetime-local"]').nth(i), { position: { x: 12, y: 12 } });
          await t.type(typed);
        }
      });
      t.flag('asks-known', 'Add missed time starts on today 8:00–5:00; today’s times are refused until 5 PM ("Clock-out can’t be in the future") and most missed punches are from an earlier day, so both dates are retyped');
      await t.step('Type why and click Save: saved beside the original, both kept on record', async () => {
        await t.click('input[placeholder="e.g. forgot to clock out"]');
        await t.type('Forgot to clock in');
        await t.click('button.small:has-text("Save")');
        await t.see('input[type="datetime-local"]', { state: 'detached' });
      });
    },
  },

  A133: { // request time off
    role: 'hygienist',
    async run(t) {
      await t.open('/timeclock?tab=pto', 'h2:has-text("Ask for time off"), h3:has-text("Ask for time off")');
      const day = addDays(t.today, 30);
      await t.step('Time clock → Time off: set the first day (today is filled in)', async () => {
        await t.click('label:has-text("First day") input');
        await t.type(`${day.slice(5, 7)}${day.slice(8, 10)}${day.slice(0, 4)}`);
      });
      const last = await t.page.inputValue('label:has-text("Last day") input');
      if (last !== day) {
        t.flag('asks-known', `Time off: "Last day" stays ${last} after typing the first day — a one-day request needs both dates typed`);
        await t.step('Set the last day too', async () => {
          await t.click('label:has-text("Last day") input');
          await t.type(`${day.slice(5, 7)}${day.slice(8, 10)}${day.slice(0, 4)}`);
        });
      }
      await t.step('Click "Send request": the manager is told', async () => {
        await t.click('button:has-text("Send request")');
        await t.wait(800);
      });
    },
  },

  A134: { // approve time off
    role: 'admin',
    async setup(t) {
      const day = addDays(t.today, 40);
      await t.as('hygienist').post('/timeclock/pto', { start_date: day, end_date: day, hours_per_day: 8, kind: 'pto', note: 'Wedding' });
    },
    async run(t) {
      await t.open('/timeclock?tab=pto', 'main');
      const approve = t.page.locator('main button:has-text("Approve")').first();
      await approve.waitFor({ timeout: 8000 });
      await t.step('Time clock → Time off → Requests: click "Approve" on Sam’s request', async () => {
        await t.click(approve);
        await t.wait(800);
      });
    },
  },

  A123: { // staff schedules
    role: 'admin',
    async run(t) {
      await t.open('/timeclock?tab=schedule', '.tc-cell-btn');
      await t.step('Time clock → Schedules: click Jordan’s Monday', async () => {
        await t.click(t.page.locator('.tc-cell-btn[aria-label*="Jordan"][aria-label*="Mon"], .tc-cell-btn:has-text("Mon")').first());
        await t.see('input[type="time"], select');
      });
      await t.step('The usual hours are filled in; click Save', async () => {
        await t.click(t.page.locator('button:has-text("Save")').first());
        await t.wait(600);
      });
      t.note('“Copy last week” and “Make this the usual week” fill a whole week in one click each.');
    },
  },

  A135: { // announcement
    role: 'admin',
    async run(t) {
      await t.open('/intranet', 'main h1');
      await t.step('Intranet: press A (new announcement)', async () => {
        await t.key('a');
        await t.see('input:focus, textarea:focus');
      });
      await t.step('Type the title, Tab, the text', async () => {
        await t.type('Office closed Monday for the holiday');
        await t.key('Tab');
        await t.type('Enjoy the long weekend!');
      });
      await t.step('Press Ctrl/⌘+Enter (or click Post)', async () => {
        await t.key(`${MOD}+Enter`);
        await t.wait(800);
        const post = t.page.locator('main button.primary:has-text("Post"), main button.primary:has-text("Publish"), main button.primary:has-text("Save")').first();
        if (await post.isVisible().catch(() => false)) await t.click(post);
        await t.see('text=Office closed Monday for the holiday');
      });
    },
  },

  A153: { // office document
    role: 'admin',
    async run(t) {
      await t.open('/documents', 'main h1');
      await t.step('Office documents: press U and choose the file (its type is worked out from the name)', async () => {
        await t.pickFile(() => t.key('u'), { name: 'OSHA exposure control plan 2026.pdf', mimeType: 'application/pdf', buffer: PDF });
        await t.see('text=OSHA exposure control plan');
      });
    },
  },

  A116: { // reply to an online review
    role: 'admin',
    async run(t) {
      await t.open('/reputation', 'main h1');
      if (await t.page.locator('h2:has-text("Connect your Google Business Profile")').count()) t.blocked('Reviews: Google Business Profile isn’t connected in the demo office');
    },
  },

  A069: { // scan a paper document
    role: 'admin', // the front desk can't add documents at all (upload needs clinical:write): see the scorecard
    setup: async (t) => ({ p: await newPatient(t, 'Scanny') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=documents`, '[data-testid=documents-drop]');
      await t.step('Documents & x-rays: press S — scanner, phone or a file from this computer', async () => {
        await t.key('s');
        await t.see('.scanmenu');
      });
      await t.step('Press 3 (a file from this computer) and choose the scan: filed on the chart', async () => {
        await t.wait(300);
        await t.pickFile(() => t.key('3'), { name: 'Referral Dr Smith.pdf', mimeType: 'application/pdf', buffer: PDF });
        await t.see('.doc-tile:has-text("Referral Dr Smith.pdf")');
      });
    },
  },

  A074: { // lab check-in
    role: 'dentist',
    async setup(t) {
      const { dentist } = await refs(t);
      const p = await newPatient(t, 'Maria');
      await t.as('admin').post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth: '30', provider_id: dentist.id });
      const c = await t.as('admin').post('/lab-cases', { patient_id: p.id, provider_id: dentist.id, lab_name: 'Smile Lab', description: 'Zirconia crown', tooth: '30', shade: 'A2', due_date: addDays(t.today, 1) });
      return { p, c };
    },
    async run(t, { c }) {
      await t.open('/lab-checkin', 'h1:has-text("Check in lab work")');
      const item = t.page.locator(`[data-testid="lbc-lab_case-${c.id}"]`);
      await item.waitFor();
      await t.step('Lab check-in: click the case that came back', async () => {
        await t.click(item);
      });
      await t.step('Click the camera and take a photo of the case', async () => {
        await t.pickFile(() => t.page.locator('.lbc-camera').click(), { name: 'crown.png', mimeType: 'image/png', buffer: PNG });
        await t.page.locator('.lbc-photos img').first().waitFor();
      });
      await t.step('Click "Looks good": checked in, the visit’s card turns green', async () => {
        await t.click('button.good');
        await t.see('.lbc-done');
      });
    },
  },

  A097: { // recall interval
    role: 'hygienist',
    async setup(t) {
      const admin = t.as('admin');
      const list = await admin.get('/patients?limit=40');
      for (const p of (list.rows || list).slice(10)) {
        const st = await admin.get(`/patients/${p.id}/recall-status`).catch(() => null);
        if ((st?.items || st || []).length) return { p };
      }
      throw new Error('no demo patient with recalls');
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}`, '[aria-label="Recall status"]');
      await t.step('Chart overview → Recall: click the ✎ next to the cleaning’s interval', async () => {
        await t.click(t.page.locator('button[aria-label^="Change"][aria-label$="interval"]').first());
        await t.see('.rf-inline-head');
      });
      await t.step('Type the new interval (months) and a reason; click Save', async () => {
        await t.key(`${MOD}+a`);
        await t.type('4');
        await t.click('input[placeholder^="Why"]');
        await t.type('Perio history');
        await t.click(t.page.locator('button.primary:has-text("Save")').first());
        await t.see('.rf-inline-head', { state: 'detached' });
      });
    },
  },

  A086: { // count the cash drawer at the end of the day
    role: 'frontdesk',
    async setup(t) {
      const admin = t.as('admin');
      let d = (await admin.get('/cash/drawers')).find?.((x) => x.name === 'Front desk');
      if (!d) d = await admin.post('/cash/drawers', { name: 'Front desk', default_float: 200 });
      await t.api.post(`/cash/drawers/${d.id}/open`, {}).catch(() => {});
    },
    async run(t) {
      await t.open('/deposits?tab=drawers', 'button:has-text("Close and count")');
      await t.step('Deposits & cash → Cash drawers: click "Close and count" (a blind count: the expected total is hidden)', async () => {
        await t.click('button:has-text("Close and count")');
        await t.see('button:has-text("Submit count")');
      });
      await t.step('Type how many of each note and coin (the cursor starts on the first one)', async () => {
        await t.type('10');
      });
      await t.step('Click "Submit count": compared with the ledger', async () => {
        await t.click('button:has-text("Submit count")');
        await t.see('button:has-text("Submit count")', { state: 'detached' });
      });
    },
  },
};
