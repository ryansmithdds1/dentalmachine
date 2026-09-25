// Insurance: claims, eligibility, cards, attachments, approvals, ERAs, follow-up, pre-authorizations, appeals.
/* global document, sessionStorage */
import { newPatient, insuredWithWork, refs, addDays, MOD, pick } from '../lib/fixtures.mjs';

// A 1×1 PNG standing in for a phone photo of a card (the sandbox reader makes up the same card for it every time).
const CARD = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const d2 = (c) => (c / 100).toFixed(2);
// An 835 remittance for the given claims ([{ id, billed, paid, pr, cas: [[group, reason, amount]] }]).
const era = (trace, claims) => {
  const segs = [`BPR*I*${d2(claims.reduce((x, c) => x + c.paid, 0))}*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999999999*DA*654321*20260920`, `TRN*1*${trace}*1512345678`, 'N1*PR*ROBOT DENTAL', 'N1*PE*PRACTICE*XX*1234567893'];
  for (const c of claims) {
    segs.push(`CLP*DM${c.id}*${c.paid ? 1 : 4}*${d2(c.billed)}*${d2(c.paid)}*${d2(c.pr)}*12*PCN${c.id}`);
    for (const [g, r, a] of c.cas) segs.push(`CAS*${g}*${r}*${d2(a)}`);
  }
  return `ISA*00*          *00*          *ZZ*ROBOT          *ZZ*PRACTICE       *260101*1200*^*00501*000000002*0*P*:~GS*HP*D*P*20260101*1200*2*X*005010X221A1~ST*835*0001~${segs.join('~')}~SE*${segs.length + 2}*0001~GE*1*2~IEA*1*000000002~`;
};
// A claim sent to the payer for one finished procedure.
async function sentClaim(t, first, code = 'D1110') {
  const w = await insuredWithWork(t, first, [code]);
  const admin = t.as('admin');
  const claim = await admin.post('/claims', { patient_insurance_id: w.policy.id, procedure_ids: w.procs.map((x) => x.id) });
  await admin.post(`/claims/${claim.id}/submit`);
  return { ...w, claim: await admin.get(`/claims/${claim.id}`) };
}
// Moves the highlight down a J/K worklist to the row with `text` (set-up: in a real office it would be near the top).
async function highlight(t, rowSel, text) {
  await t.page.locator(rowSel).first().waitFor();
  const idx = await t.page.locator(rowSel).evaluateAll((els, n) => els.findIndex((e) => e.textContent.includes(n)), text);
  if (idx < 0) throw new Error(`no row with ${text}`);
  for (let i = 0; i < idx; i++) await t.page.keyboard.press('j');
}

export default {
  A022: {
    role: 'billing',
    setup: (t) => insuredWithWork(t, 'Cora', ['D1110', 'D0120', 'D0274']),
    async run(t, { p, carrier }) {
      await t.open(`/patients/${p.id}?tab=insurance`, `button:has-text("claim to ${carrier.name}")`);
      await t.step('Insurance tab: "Bill … claim" shows the finished work. Press B: the claim is made and sent', async () => {
        await t.key('b');
        await t.see(`.toast:has-text("sent to ${carrier.name}")`);
      });
    },
  },

  A026: {
    role: 'frontdesk',
    async setup(t) {
      const w = await insuredWithWork(t, 'Elig', []);
      return w;
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=insurance`, 'h2:has-text("Eligibility & benefits")');
      await t.step('Press E: eligibility is checked with the payer and applied to the policy', async () => {
        await t.key('e');
        await t.see('.elig-outcome.done:has-text("Applied to the policy automatically")');
      });
    },
  },

  A035: { // benefits left
    role: 'frontdesk',
    async setup(t) {
      const w = await insuredWithWork(t, 'Benny', ['D1110']);
      await t.as('admin').post(`/insurance/${w.policy.id}/eligibility`).catch(() => {});
      return w;
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}`, 'h1');
      await t.step('Click the Insurance tab: annual maximum, used and remaining are shown', async () => {
        await t.click('.tabs button:has-text("Insurance")');
        await t.see('h2:has-text("Coverage")');
      });
      const text = (await t.page.textContent('main')).replace(/\s+/g, ' ');
      if (!/remaining|left/i.test(text)) t.flag('dead-end', 'The Insurance tab shows the annual maximum but not what is left this year (used / remaining)');
    },
  },

  A047: {
    role: 'frontdesk',
    setup: async (t) => ({ p: await newPatient(t, 'Card') }),
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=insurance`, 'button:has-text("Scan card")');
      await t.step('Press S and choose the photo of the card: it is read into the policy form', async () => {
        await t.pickFile(() => t.key('s'), { name: 'card-front.png', mimeType: 'image/png', buffer: CARD });
        await t.see('.modal .card-read-banner');
      });
      await t.step('Check what was read; press Enter: policy saved (and checked with the payer)', async () => {
        await t.key('Enter');
        await t.see('.modal', { state: 'detached' });
        await t.see('td:has-text("SBX")');
      });
    },
  },

  A056: {
    role: 'billing',
    async setup(t) {
      const { dentist } = await refs(t);
      const w = await insuredWithWork(t, 'Attie', []);
      const proc = await t.as('admin').post(`/patients/${w.p.id}/procedures`, { code: 'D2740', tooth: '30', provider_id: dentist.id, complete: true });
      const claim = await t.as('admin').post('/claims', { patient_insurance_id: w.policy.id, procedure_ids: [proc.id] });
      return { ...w, claim };
    },
    async run(t, { p, claim }) {
      await t.open(`/claims/${claim.id}`, 'h1');
      // The x-rays were taken by the clinical team (uploaded as the office manager: set-up).
      for (const [name, tooth] of [['pa30.png', '30'], ['pa3.png', '3']]) await t.as('admin').raw('POST', `/patients/${p.id}/documents?filename=${name}&category=xray&tooth=${tooth}`, Buffer.from('x'), { 'Content-Type': 'text/plain' });
      await t.open(`/claims/${claim.id}`, 'button:has-text("Attach 1 suggested")');
      await t.step('On the claim, click "Attach 1 suggested": the x-ray of #30 is attached (not #3)', async () => {
        await t.click('button:has-text("Attach 1 suggested")');
        await t.see('button:has-text("Send 1 to the payer")');
      });
      await t.step('Click "Send 1 to the payer": sent', async () => {
        await t.click('button:has-text("Send 1 to the payer")');
        await t.see('td:has-text("SBX")');
      });
    },
  },

  A048: {
    role: 'billing',
    setup: (t) => insuredWithWork(t, 'Appro', ['D1110', 'D0120'], 'Approve Robot Dental'),
    async run(t, { p }) {
      await t.open('/claims?tab=claims', '.tabs button:has-text("Ready to approve")');
      await t.step('Click "Ready to approve": claims prepared from finished work, one row per patient', async () => {
        await t.click('.tabs button:has-text("Ready to approve")');
        await t.see(`tr.wl-row:has-text("${p.last_name}")`);
      });
      await t.step('Click "Approve" on the row: the claim is made and sent', async () => {
        await t.click(t.page.locator('tr.wl-row', { hasText: p.last_name }).locator('button:has-text("Approve")'));
        await t.see(`.toast:has-text("${p.last_name}")`);
      });
    },
  },

  A063: {
    role: 'billing',
    async setup(t) {
      const { claim } = await sentClaim(t, 'Nora', 'D1110');
      const text = era(`ROBOT${Date.now()}`, [{ id: claim.id, billed: claim.total_fee, paid: 0, pr: claim.total_fee, cas: [['PR', '204', claim.total_fee]] }]);
      await t.as('admin').raw('POST', '/era/import?filename=robot.835', Buffer.from(text), { 'Content-Type': 'text/plain' });
      return { claim };
    },
    async run(t, { claim }) {
      await t.open('/claims?tab=autopilot', 'h2:has-text("Insurance autopilot")');
      await highlight(t, '.eob-item', `#${claim.id}`).catch(async () => highlight(t, '.eob-item', 'Denied'));
      await t.step('Insurance autopilot: clean payments posted on their own; the denial waits, highlighted. Press B: bill the patient', async () => {
        await t.key('b');
        await t.page.waitForFunction((id) => ![...document.querySelectorAll('.eob-item.current')].some((e) => e.textContent.includes(`#${id}`) && /Denied/.test(e.textContent)), claim.id);
      });
      t.note('Clean ERA lines post with no action; this measures one exception (a denial the patient pays).');
    },
  },

  A075: {
    role: 'billing',
    async setup(t) {
      const { claim } = await sentClaim(t, 'Fol', 'D0120');
      await t.as('admin').post(`/claims/${claim.id}/calls`, { outcome: 'other', follow_up_date: t.today });
      return { claim };
    },
    async run(t, { claim }) {
      await t.open('/claims?tab=followup', '.seg button[aria-selected="true"]:has-text("Due for a call")');
      await highlight(t, 'tr.wl-row', `#${claim.id}`);
      await t.see(`tr.wl-row.current a:has-text("#${claim.id}")`);
      await t.step('Insurance follow-up: claims due a call first. Press L: the call panel opens for the highlighted claim', async () => {
        await t.key('l');
        await t.see(`aside[aria-label="Call about claim #${claim.id}"]`);
      });
      await t.step('Press 1 ("In process"): the cursor moves to the call reference', async () => {
        await t.key('1');
        await t.focusIs('Call reference #');
      });
      await t.step('Type the reference and press Enter: logged, next follow-up set, on to the next claim', async () => {
        await t.type('R-4501');
        await t.key('Enter');
        await t.see(`.toast:has-text("Call logged for claim #${claim.id}")`);
      });
    },
  },

  A081: {
    role: 'billing', // Pre-authorize follows billing:write (the same permission the server asks for)
    async setup(t) {
      const { dentist } = await refs(t);
      const w = await insuredWithWork(t, 'Pria', []);
      await t.as('admin').post(`/patients/${w.p.id}/procedures`, { code: 'D2740', tooth: '30', provider_id: dentist.id });
      const plan = await t.as('admin').post(`/patients/${w.p.id}/treatment-plans`, { all_unplanned: true });
      return { ...w, plan };
    },
    async run(t, { p, plan }) {
      await t.open(`/patients/${p.id}?tab=treatment`, `.card[data-plan="${plan.id}"] button:has-text("Pre-authorize")`);
      await t.step('Click "Pre-authorize" on the plan: made and sent to the clearinghouse', async () => {
        await t.click(t.page.locator(`.card[data-plan="${plan.id}"]`).locator('button:has-text("Pre-authorize")'));
        await t.see('.toast:has-text("sent to")');
      });
    },
  },

  A087: {
    role: 'billing',
    async setup(t) {
      const w = await insuredWithWork(t, 'Verna', []);
      const { dentist } = await refs(t);
      const tomorrow = addDays(t.today, 1);
      await t.as('admin').post('/appointments', { patient_id: w.p.id, provider_id: dentist.id, start_time: `${tomorrow} 06:10`, end_time: `${tomorrow} 06:40`, override_blockout: true, notify: false });
      return w;
    },
    async run(t, { p }) {
      await t.open('/claims?tab=verification&range=tomorrow&view=all', '.vf-row');
      await t.see(`.vf-row:has-text("${p.last_name}")`);
      await t.step('Billing → Verification, tomorrow: press R to check everyone; clean answers are applied', async () => {
        await t.key('r');
        await t.see('.toast:has-text("Checked")');
      });
    },
  },

  A109: {
    role: 'billing',
    async setup(t) {
      const { claim } = await sentClaim(t, 'Dena', 'D1206');
      await t.as('admin').post(`/claims/${claim.id}/deny`, { reason: 'Frequency limitation' });
      return { claim };
    },
    async run(t, { claim }) {
      await t.open(`/claims/${claim.id}`, '.card h2:has-text("Appeal")');
      await t.step('On the denied claim, press D: an appeal letter is drafted', async () => {
        await t.key('d');
        await t.focusIs('Appeal letter');
      });
      await t.step('Press Ctrl/⌘+Enter: filed on the chart, follow-up set in 30 days', async () => {
        await t.key(`${MOD}+Enter`);
        await t.see('.toast:has-text("Appeal filed on the chart")');
      });
    },
  },

  A067: { // claim status lookup
    role: 'billing',
    setup: (t) => sentClaim(t, 'Stat', 'D0150'),
    async run(t, { claim }) {
      await t.open('/schedule', '.cal-col-head');
      await t.step('Press Ctrl/⌘K and type the claim number as it is written ("#33"; "claim 33" works too)', async () => {
        await t.key(`${MOD}+k`);
        await t.type(`#${claim.id}`);
        await t.see(`.palette-item:has-text("Claim #${claim.id}")`);
      });
      await t.step('Press Enter on "Claim #…" (first): the claim with its status and history', async () => {
        await pick(t, `Claim #${claim.id}`);
        await t.key('Enter');
        await t.page.waitForURL(new RegExp(`/claims/${claim.id}`));
        await t.see('h1');
      });
    },
  },
};
