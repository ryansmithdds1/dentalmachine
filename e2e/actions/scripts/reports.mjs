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
  // Report tabs, by name from the command bar (they used to be Reports → the tab → a button).
  ['A124', 'billing', 'a/r aging', '.seg button.active:has-text("A/R aging")', 'Press Ctrl/⌘K, type "A/R aging", Enter: who owes what, by age'],
  ['A150', 'admin', 'hygiene report', 'main .tabs button.active:has-text("Hygiene")', 'Press Ctrl/⌘K, type "hygiene report", Enter'],
  ['A151', 'admin', 'treatment plan acceptance', 'main .tabs button.active:has-text("Treatment plans")', 'Press Ctrl/⌘K, type "treatment plan acceptance", Enter'],
  ['A152', 'admin', 'referrals report', 'main .tabs button.active:has-text("Referrals")', 'Press Ctrl/⌘K, type "referrals report", Enter: where new patients come from'],
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
