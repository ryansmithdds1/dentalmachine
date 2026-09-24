import { withActor } from './actor.js';
import { raiseIssue, resolveIssue } from './issues.js';
import { settingsOf, autopostPass } from './eobauto.js';
import { runAutoBilling } from './autobill.js';
import { reconciliationPass } from './eobrecon.js';

// The insurance autopilot's background pass (every 15 minutes, one server at a time): clean ERA rows post for
// practices that turned auto-posting on, balances left after insurance start (and stop) being billed, paper
// statements go out, and the reconciliation raises or resolves its gaps. The texts and emails themselves are
// sent by the cadence job (type 'patient_balance'). Everything runs as the automation actor; a failure is a
// Needs attention item, cleared by the next pass that works.
export async function runEobAutopilot(db, deps = {}) {
  const out = { posted: 0, billing: [], gaps: 0 };
  for (const practice of await db.all('SELECT * FROM practices ORDER BY id')) {
    if (deps.practiceIds && !deps.practiceIds.includes(practice.id)) continue;
    const s = settingsOf(practice);
    await withActor({ source: 'automation', actor: 'Insurance autopilot', practiceId: practice.id, userId: null, locationId: null, reason: null }, async () => {
      const key = 'eob-autopilot-job';
      try {
        if (s.autopost) out.posted += (await autopostPass(db, practice)).posted;
        if (s.billing) out.billing.push({ practice_id: practice.id, ...(await runAutoBilling(db, practice, deps)) });
        // Reconciliation for anyone using the autopilot's rows (ERAs or paper EOBs have come in).
        if (await db.get('SELECT id FROM remit_lines WHERE practice_id = ? LIMIT 1', practice.id)) out.gaps += (await reconciliationPass(db, practice, deps)).gaps;
        await resolveIssue(db, practice.id, key);
      } catch (err) {
        await raiseIssue(db, { practiceId: practice.id, kind: 'era', key, role: 'billing', severity: 'high', title: 'The insurance autopilot stopped part-way — it will try again in 15 minutes', detail: err.message });
      }
    });
  }
  return out;
}
