// Reports and management screens: mostly "open it and read it", measured from the schedule the way a manager
// would get there (the command bar), plus the month-end close.
import { viaCommandBar, menu, pick, MOD } from '../lib/fixtures.mjs';

// Each: [id, role, words typed in the command bar, what shows when it's ready, caption].
const VIEWS = [
  ['A104', 'admin', 'production & income', '.pi-tiles', 'Press Ctrl/⌘K, type "production & income", Enter: production and collections by provider'],
  ['A105', 'admin', 'metrics', 'main h1, main h2', 'Press Ctrl/⌘K, type "metrics", Enter: the practice KPIs'],
  ['A085', 'billing', 'day sheet', 'main table, main h2', 'Press Ctrl/⌘K, type "day sheet", Enter: today’s day sheet'],
  ['A128', 'admin', 'phones', 'main h1, main h2', 'Press Ctrl/⌘K, type "phones", Enter: calls, missed calls and why callers didn’t book'],
  ['A140', 'admin', 'ask your data', 'main h1, main h2, main textarea, main input', 'Press Ctrl/⌘K, type "ask your data", Enter'],
  ['A148', 'admin', 'finance', 'main h1, main h2', 'Press Ctrl/⌘K, type "finance", Enter: bank and books'],
  ['A078', 'dentist', 'x-ray ai review', 'main h1, main h2', 'Press Ctrl/⌘K, type "x-ray AI review", Enter'],
  ['A095', 'dentist', 'chart audit', 'main h1, main h2', 'Press Ctrl/⌘K, type "chart audit", Enter: notes to sign and charts to fix'],
  // Report tabs, by name from the command bar (they used to be Reports → the tab → a button).
  ['A124', 'billing', 'a/r aging', '.seg button.active:has-text("A/R aging")', 'Press Ctrl/⌘K, type "A/R aging", Enter: who owes what, by age'],
  ['A150', 'admin', 'hygiene report', 'main .tabs button.active:has-text("Hygiene")', 'Press Ctrl/⌘K, type "hygiene report", Enter'],
  ['A151', 'admin', 'treatment plan acceptance', 'main .tabs button.active:has-text("Treatment plans")', 'Press Ctrl/⌘K, type "treatment plan acceptance", Enter'],
  ['A152', 'admin', 'referrals report', 'main .tabs button.active:has-text("Referrals")', 'Press Ctrl/⌘K, type "referrals report", Enter: where new patients come from'],
];

// Weekly and monthly checks a manager opens from the menu: the module's ▾, then the page — 2 clicks, no typing
// (batch 3: they used to be measured through the command bar, 3 actions; My bonus and Patient feedback weren't in
// the menu at all). [id, role, module, address, what shows when it's ready, caption].
const MENU = [
  ['A125', 'frontdesk', 'family', '/recall', 'main h1, main h2', 'In the menu open Family ▾ and click "Recall autopilot": what it sent and booked this week'],
  ['A126', 'admin', 'treatment', '/recall?type=treatment', 'main h1, main h2', 'In the menu open Treatment Plan ▾ and click "Treatment follow-up": who was reminded and who booked'],
  ['A129', 'admin', 'schedule', '/capacity', 'main h1, main h2', 'In the menu open Schedule ▾ and click "Capacity"'],
  ['A130', 'admin', 'manage', '/reviews', 'main h1, main h2', 'In the menu open Manage ▾ and click "Patient feedback"'],
  ['A131', 'frontdesk', 'manage', '/bonus', 'main h1, main h2', 'In the menu open Manage ▾ and click "My bonus"'],
  ['A137', 'admin', 'manage', '/business', 'main h1, main h2', 'In the menu open Manage ▾ and click "Business": what pays'],
  ['A144', 'admin', 'manage', '/group', 'main h1, main h2', 'In the menu open Manage ▾ and click "Group": every office side by side'],
  ['A149', 'admin', 'manage', '/marketing', 'main h1, main h2', 'In the menu open Manage ▾ and click "Marketing results"'],
];

const scripts = {};
for (const [id, role, module, href, ready, caption] of MENU) {
  scripts[id] = {
    role,
    async run(t) {
      await t.open('/schedule', '.sidebar');
      await menu(t, module, href, ready, caption);
    },
  };
}
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
    // Batch 3: "export <report>" in the command bar downloads it straight away (today's day sheet), without
    // opening the report first (it was: open the day sheet, 3 actions, then CSV).
    await t.step('Press Ctrl/⌘K, type "export day sheet", Enter: today’s day sheet downloads as a spreadsheet', async () => {
      const dl = t.page.waitForEvent('download', { timeout: 8000 });
      await t.key(`${MOD}+k`);
      await t.cmd('export day sheet');
      await pick(t, 'export day sheet');
      await t.key('Enter');
      const file = await dl;
      if (!/day-sheet-.*\.csv$/.test(file.suggestedFilename())) throw new Error(`downloaded ${file.suggestedFilename()}`);
      await t.see('.toast:has-text("Downloaded")');
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
