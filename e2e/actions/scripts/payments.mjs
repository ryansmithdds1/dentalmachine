// Payments and the ledger: checkout, taking payments, balances, estimates, adjustments, deposits, refunds, statements.
/* global document */
import { newPatient, book, activate, refs, cardSel, menu, uniq } from '../lib/fixtures.mjs';

// Demo patients with history (so recalls are due) and no visit today; each script takes a different one.
let used = 0;
async function demoPatient(t) {
  const admin = t.as('admin');
  const today = (await admin.get('/appointments')).map((a) => a.patient_id);
  const list = await admin.get('/patients?limit=80');
  const rows = (list.rows || list).filter((p) => !today.includes(p.id) && !p.guarantor_id);
  return rows[(used++ * 3) % rows.length];
}
let early = 0;
// A visit early today (before the demo day) with its work done by the clinical team.
async function doneVisit(t, p, codes = ['D0120', 'D1110'], status = 'completed') {
  const { dentist } = await refs(t);
  const a = await book(t, p, t.today, 5 * 60 + 5 + 30 * (early++ % 6), 25, { reason: 'Exam and cleaning', provider_id: dentist.id });
  if (!a.id) throw new Error(JSON.stringify(a));
  for (const code of codes) await t.as('admin').post(`/patients/${p.id}/procedures`, { code, appointment_id: a.id, provider_id: dentist.id, complete: true });
  if (status) await t.as('admin').patch(`/appointments/${a.id}/status`, { status });
  return a;
}
async function withCharge(t, first, code = 'D2392', extra = {}) {
  const { dentist } = await refs(t);
  const p = await newPatient(t, first);
  await t.as('admin').post(`/patients/${p.id}/procedures`, { code, tooth: '30', surfaces: 'MO', complete: true, provider_id: dentist.id, ...extra });
  return p;
}

export default {
  A019: {
    role: 'frontdesk',
    async setup(t) {
      const p = await withCharge(t, 'Payton');
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/schedule', `.patient-bar:has-text("${p.last_name}")`);
      await t.step('Press Alt+P: the ledger opens with the payment panel; the amount is filled in with what they owe', async () => {
        await t.key('Alt+p');
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Payment amount');
      });
      await t.step('Press Enter: posted with the method this person used last', async () => {
        await t.key('Enter');
        await t.see('.inline-panel[aria-label="Take payment"]', { state: 'detached' });
      });
    },
  },

  A024: {
    role: 'frontdesk',
    async setup(t) {
      const p = await withCharge(t, 'Owen');
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/schedule', `.patient-bar:has-text("${p.last_name}")`);
      await t.step('Press Alt+L: the ledger opens with "Why this balance", visit by visit', async () => {
        await t.key('Alt+l');
        await t.see('.why-balance .why-visit');
      });
    },
  },

  A025: {
    role: 'dentist', // the front desk's chart is view-only, so typing an estimate there does nothing (see the scorecard)
    setup: async (t) => ({ p: await newPatient(t, 'Esti') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=chart`, '.odontogram2');
      await t.step('Type 1 on the chart: the entry box opens', async () => {
        await t.key('1');
        await t.see('.chart-entry input');
      });
      await t.step('Type "4 D2740": the patient’s estimate shows before anything is charted', async () => {
        await t.type('4 D2740');
        await t.see('.chart-entry .est:has-text("Est. patient $")');
      });
      await t.key('Escape');
      t.note('Esc closes the preview without charting anything.');
    },
  },

  A027: {
    role: 'frontdesk',
    async setup(t) {
      const p = await demoPatient(t);
      const a = await doneVisit(t, p);
      return { p, a };
    },
    async run(t, { a }) {
      await t.open(`/checkout/${a.id}`, 'h1');
      const book = t.page.locator('button:has-text("recall")').first();
      await book.waitFor();
      await t.step('Click "Book … recall": the next open times with their hygienist are offered, the first one focused', async () => {
        await t.click(book);
        await t.page.waitForFunction(() => document.activeElement?.closest('.slot-picks'));
      });
      await t.step('Press Enter: booked', async () => {
        await t.key('Enter');
        await t.see('.public-notice:has-text("Booked")');
      });
    },
  },

  A017: {
    role: 'frontdesk',
    async setup(t) {
      const p = await demoPatient(t);
      const a = await doneVisit(t, p);
      return { p, a };
    },
    async run(t, { a }) {
      await t.open(`/schedule?date=${t.today}&view=day`, cardSel(a.id));
      await t.step('Click the finished visit on the schedule: its panel opens', async () => {
        await t.click(cardSel(a.id));
        await t.see('.drawer');
      });
      await t.step('Click "Check out…": the checkout page opens with the payment amount focused', async () => {
        await t.click('.drawer button:has-text("Check out")');
        await t.page.waitForURL(/\/checkout\//);
        await t.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Payment amount');
      });
      const amount = await t.page.inputValue('input[aria-label="Payment amount"]');
      if (!amount || Number(amount) === 0) {
        t.flag('asks-known', 'Checkout: "Suggested now $0.00" and an empty amount although the account has a balance — the person works out what to collect and types it');
        await t.step('Type the amount', async () => { await t.type('25'); });
      }
      await t.step('Press Enter: payment posted', async () => {
        await t.key('Enter');
        await t.see('text=/Payment of \\$[\\d.,]+ posted/');
      });
      const book = t.page.locator('button:has-text("recall")').first();
      if (await book.count()) {
        await t.step('Click "Book … recall", Enter on the first suggestion: next visit booked', async () => {
          await t.click(book);
          await t.page.waitForFunction(() => document.activeElement?.closest('.slot-picks'));
          await t.key('Enter');
          await t.see('.public-notice:has-text("Booked")');
        });
      }
      await t.step('Click "Mark checked out"', async () => {
        await t.click('button:has-text("Mark checked out")');
        await t.page.waitForFunction(() => !/Mark checked out/.test(document.querySelector('main')?.textContent || '') || document.querySelector('.toast'));
      });
    },
  },

  A064: {
    role: 'billing',
    setup: async (t) => ({ p: await withCharge(t, 'Ada', 'D1110', { tooth: undefined, surfaces: undefined }) }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=ledger`, 'button:has-text("Adjustment")');
      await t.step('Press A: the adjustment line opens with the cursor on the amount (last type remembered)', async () => {
        await t.key('a');
        await t.focusIs('Adjustment amount');
      });
      await t.step('Type the amount and press Enter: posted with its reason (Undo reverses it)', async () => {
        await t.type('25');
        await t.key('Enter');
        await t.see('.toast:has-text("of $25.00 posted")');
      });
    },
  },

  A084: {
    role: 'billing',
    async setup(t) {
      const admin = t.as('admin');
      // Earlier payments go to the bank first (counted exactly), so today's deposit is just this check.
      const seeded = await admin.get('/daily-deposits/build');
      if (seeded.entries.length) {
        let left = seeded.entries.filter((e) => e.kind !== 'check').reduce((s, e) => s + e.amount, 0);
        const cashCount = {};
        for (const d of [...seeded.denominations].sort((x, y) => y.cents - x.cents)) {
          const n = Math.floor(Math.max(0, left) / d.cents);
          if (n) { cashCount[d.key] = n; left -= n * d.cents; }
        }
        await admin.post('/daily-deposits', { submit_key: `robot-${Date.now()}`, business_date: seeded.date, entry_ids: seeded.entries.map((e) => e.id), bag_number: 'SEED-1', cash_count: cashCount, difference_reason: left ? 'demo data' : undefined });
      }
      const p = await newPatient(t, 'Dee');
      await admin.post(`/patients/${p.id}/payments`, { amount: 12000, method: 'check', reference: '4411' });
    },
    async run(t) {
      await t.open('/schedule', '.rail-mod[data-module="account"]');
      await menu(t, 'account', '/deposits', 'main h1', 'In the menu open Account ▾ and click "Deposits & cash": today’s deposit is ready');
      await t.focusIs('Bag or deposit slip number');
      await t.step('Type the bag number and press Enter: deposit made', async () => {
        await t.type('BAG-0042');
        await t.key('Enter');
        await t.see('text=Bag BAG-0042');
      });
    },
  },

  A088: {
    role: 'frontdesk',
    async setup(t) {
      const { dentist } = await refs(t);
      await t.as('admin').put('/practice', { financing: { links: [{ name: 'CareCredit', url: 'https://www.carecredit.com/go/DEMO123/' }] } });
      const p = await newPatient(t, 'Fina');
      await t.as('admin').post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth: '30', provider_id: dentist.id });
      await t.as('admin').post(`/patients/${p.id}/treatment-plans`, { all_unplanned: true });
      return { p };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=ledger`, 'button:has-text("Send an application")');
      await t.step('Click "Send an application": the lender and the plan’s patient share are filled in, Send focused', async () => {
        await t.click('button:has-text("Send an application")');
        await t.page.waitForFunction(() => document.activeElement?.textContent === 'Send' && !document.activeElement.disabled);
      });
      await t.step('Press Enter: the application link is texted', async () => {
        await t.key('Enter');
        await t.see('.toast:has-text("application sent to")');
      });
    },
  },

  A110: {
    role: 'admin', // refunds need a manager (deposits:manage); the billing role sees the R hint but R does nothing
    async setup(t) {
      const p = await newPatient(t, 'Rhea', { last_name: `Refundwell${uniq()}` });
      await t.as('admin').post(`/patients/${p.id}/payments`, { amount: 900000, method: 'check', reference: 'ROBOT-1' });
      return { p };
    },
    async run(t, { p }) {
      await t.open('/claims?tab=refunds', 'tr.wl-row');
      const rows = t.page.locator('tr.wl-row');
      const idx = await rows.evaluateAll((els, n) => els.findIndex((e) => e.textContent.includes(n)), p.last_name);
      for (let i = 0; i < idx; i++) await t.key('j'); // set-up: the robot's patient is first in a real office's queue
      await t.see(`tr.wl-row.current:has-text("${p.last_name}")`);
      await t.step('Billing → Credits & refunds: the credit is highlighted. Press R: the refund is ready, amount and card filled in', async () => {
        await t.key('r');
        await t.page.waitForFunction(() => /^Refund \$/.test(document.activeElement?.textContent || ''));
      });
      await t.step('Press Enter: refunded (audited; money out has no Undo)', async () => {
        await t.key('Enter');
        await t.see('.toast:has-text("Refunded $")');
      });
    },
  },

  A119: {
    role: 'billing',
    async setup(t) {
      const p = await newPatient(t, 'Paige', { email: null, phone: null });
      await t.as('admin').post(`/patients/${p.id}/adjustments`, { amount: 8800, description: 'Balance brought over', adjustment_type: 'Other' });
    },
    async run(t) {
      await t.open('/claims?tab=statements');
      await t.page.waitForFunction(() => document.activeElement?.textContent === 'Send statements');
      await t.step('Billing → Statements: "Send statements" has focus. Press Enter: sent (email/text/mail service)', async () => {
        await t.key('Enter');
        await t.page.waitForFunction(() => /^Print (it|all \d+) \(one PDF\)$/.test(document.activeElement?.textContent || ''));
      });
      await t.step('Press Enter: every statement that has to be printed comes out as one PDF', async () => {
        const pdf = t.page.waitForResponse((res) => /\/api\/statements\/runs\/\d+\/print$/.test(res.url()));
        await t.key('Enter');
        await pdf;
      });
      for (const pg of t.ctx.pages()) if (pg !== t.page) await pg.close();
    },
  },
};
