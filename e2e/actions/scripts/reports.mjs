// Reports and management screens: mostly "open it and read it", measured from the schedule the way a manager
// would get there (the command bar), plus the month-end close.
import { viaCommandBar, MOD } from '../lib/fixtures.mjs';

// Each: [id, role, words typed in the command bar, what shows when it's ready, caption].
const VIEWS = [
  ['A104', 'admin', 'production & income', '.pi-tiles', 'Press Ctrl/⌘K, type "production & income", Enter: production and collections by provider'],
  ['A105', 'admin', 'metrics', 'main h1, main h2', 'Press Ctrl/⌘K, type "metrics", Enter: the practice KPIs'],
  ['A085', 'billing', 'day sheet', 'main table, main h2', 'Press Ctrl/⌘K, type "day sheet", Enter: today’s day sheet'],
  ['A125', 'frontdesk', 'recall autopilot', 'main h1, main h2', 'Press Ctrl/⌘K, type "recall autopilot", Enter'],
  ['A126', 'admin', 'treatment follow-up', 'main h1, main h2', 'Press Ctrl/⌘K, type "treatment follow-up", Enter'],
  ['A128', 'admin', 'phones', 'main h1, main h2', 'Press Ctrl/⌘K, type "phones", Enter: calls, missed calls and why callers didn’t book'],
  ['A129', 'admin', 'capacity', 'main h1, main h2', 'Press Ctrl/⌘K, type "capacity", Enter'],
  ['A130', 'admin', 'reviews & patient feedback', 'main h1, main h2', 'Press Ctrl/⌘K, type "reviews & patient feedback", Enter'],
  ['A137', 'admin', 'business', 'main h1, main h2', 'Press Ctrl/⌘K, type "business", Enter: what pays'],
  ['A140', 'admin', 'ask your data', 'main h1, main h2, main textarea, main input', 'Press Ctrl/⌘K, type "ask your data", Enter'],
  ['A144', 'admin', 'group', 'main h1, main h2', 'Press Ctrl/⌘K, type "group", Enter: every office side by side'],
  ['A148', 'admin', 'finance', 'main h1, main h2', 'Press Ctrl/⌘K, type "finance", Enter: bank and books'],
  ['A149', 'admin', 'marketing results', 'main h1, main h2', 'Press Ctrl/⌘K, type "marketing results", Enter'],
  ['A078', 'dentist', 'x-ray ai review', 'main h1, main h2', 'Press Ctrl/⌘K, type "x-ray AI review", Enter'],
  ['A095', 'dentist', 'chart audit', 'main h1, main h2', 'Press Ctrl/⌘K, type "chart audit", Enter: notes to sign and charts to fix'],
];

const scripts = {};
for (const [id, role, words, ready, caption] of VIEWS) {
  scripts[id] = {
    role,
    async run(t) {
      await t.open('/schedule', '.sidebar');
      await viaCommandBar(t, words, ready, caption);
    },
  };
}

// Report tabs with no command-bar entry: Reports, then the tab.
const TABS = [
  ['A124', 'billing', 'Day sheet, production & A/R', 'A/R aging'],
  ['A150', 'admin', 'Hygiene', null],
  ['A151', 'admin', 'Treatment plans', null],
  ['A152', 'admin', 'Referrals', null],
];
for (const [id, role, tab, sub] of TABS) {
  scripts[id] = {
    role,
    async run(t) {
      await t.open('/schedule', '.sidebar');
      await viaCommandBar(t, 'practice kpis', 'main .tabs', 'Press Ctrl/⌘K, type "practice KPIs", Enter: Reports opens');
      await t.step(`Click the "${tab}" tab`, async () => {
        await t.click(`main .tabs button:has-text("${tab}")`);
        await t.wait(800);
      });
      if (sub) {
        const b = t.page.locator(`main button:has-text("${sub}")`).first();
        if (await b.count()) await t.step(`Click "${sub}"`, async () => { await t.click(b); await t.wait(600); });
      }
    },
  };
}

scripts.A142 = { // export a report to a spreadsheet
  role: 'billing',
  async run(t) {
    await t.open('/schedule', '.sidebar');
    await viaCommandBar(t, 'day sheet', 'main table', 'Press Ctrl/⌘K, type "day sheet", Enter');
    const csv = t.page.locator('main button:has-text("CSV"), main a:has-text("CSV"), main button:has-text("Export")').first();
    if (!(await csv.count())) { t.flag('dead-end', 'No CSV/export button on the day sheet'); return; }
    await t.step('Click "CSV": the table downloads as a spreadsheet', async () => {
      const dl = t.page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
      await t.click(csv);
      await dl;
    });
  },
};

scripts.A146 = { // close the month
  role: 'admin',
  async run(t) {
    await t.open('/schedule', '.sidebar');
    await viaCommandBar(t, 'month-end close', 'h2:has-text("Close the books")', 'Press Ctrl/⌘K, type "month-end close", Enter: Close the books');
    if (!(await t.page.locator('.packet').count())) {
      await t.step('Press M: the month-end packet (production, aging, reconciliation…) on one screen', async () => {
        await t.key('m');
        await t.see('.packet .packet-section');
      });
    }
    await t.step('Press C: the month is closed (Undo shows)', async () => {
      await t.key('c');
      await t.see('.toast:has-text("Books closed through")');
    });
    t.after(async () => { await t.key(`${MOD}+z`); }); // leave the demo books open for the other actions
  },
};

export default scripts;
