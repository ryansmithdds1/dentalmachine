// More insurance and money actions: secondary policies, paper EOBs, claim corrections and voids, payment links,
// voiding a payment, payment plans, memberships, collections.
/* global document */
import { newPatient, insuredWithWork, refs } from '../lib/fixtures.mjs';

async function sentClaim(t, first, code = 'D1110', carrierName) {
  const w = await insuredWithWork(t, first, [code], carrierName);
  const admin = t.as('admin');
  const claim = await admin.post('/claims', { patient_insurance_id: w.policy.id, procedure_ids: w.procs.map((x) => x.id) });
  await admin.post(`/claims/${claim.id}/submit`);
  return { ...w, claim: await admin.get(`/claims/${claim.id}`) };
}

export default {
  A091: { // secondary insurance
    role: 'frontdesk',
    async setup(t) {
      const w = await insuredWithWork(t, 'Dual', []);
      const admin = t.as('admin');
      const name = 'Second Robot Dental';
      const second = (await admin.get('/carriers')).find((c) => c.name === name) || await admin.post('/carriers', { name, payer_id: '88888' });
      return { ...w, second };
    },
    async run(t, { p, second }) {
      await t.open(`/patients/${p.id}?tab=insurance`, 'button:has-text("Type it in")');
      await t.step('Insurance tab (they already have a primary): click "+ Type it in"', async () => {
        await t.click('button:has-text("Type it in")');
        await t.see('.modal');
      });
      const priority = await t.page.locator('.modal label:has-text("Priority") select').inputValue();
      if (priority !== 'secondary') t.flag('asks-known', `Adding a second policy starts on Priority "${priority}" although the patient already has a primary`);
      await t.step('Pick the carrier; set Priority to Secondary', async () => {
        await t.page.locator('.modal label:has-text("Carrier") select').selectOption({ label: second.name });
        if (priority !== 'secondary') await t.page.locator('.modal label:has-text("Priority") select').selectOption('secondary');
      });
      await t.step('Type the subscriber (the spouse), their member ID and relationship', async () => {
        await t.click('.modal label:has-text("Subscriber name") input');
        await t.key(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
        await t.type('Pat Dual');
        await t.click('.modal label:has-text("Member ID") input');
        await t.type('SEC12345');
        await t.page.locator('.modal label:has-text("Relationship") select').selectOption('spouse');
      });
      await t.step('Click Save', async () => {
        await t.click('.modal button.primary');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A072: { // paper EOB / insurance check
    role: 'billing',
    async setup(t) {
      return sentClaim(t, 'Checky', 'D1110', 'Paper Check Dental');
    },
    async run(t, { carrier, claim }) {
      await t.open('/claims?tab=checks', 'button:has-text("Post an insurance check")');
      await t.step('Billing → Insurance payments: click "Post an insurance check"', async () => {
        await t.click('button:has-text("Post an insurance check")');
        await t.see('.modal, form');
      });
      await t.step('Pick the carrier: their open claims are listed, and the cursor moves to the check number', async () => {
        await t.page.locator('label:has-text("Carrier") select').selectOption({ label: carrier.name });
        await t.page.waitForFunction(() => document.activeElement?.closest('label')?.textContent?.startsWith('Check / EFT #'));
        await t.see(`tr:has-text("#${claim.id}")`);
      });
      const amount = String(((claim.estimated_amount || Math.round(claim.total_fee * 0.8)) / 100).toFixed(2));
      await t.step('Type the check number, Enter; type the check amount: it is matched to the claim it pays (paid as expected)', async () => {
        await t.type('88123');
        await t.key('Enter');
        await t.type(amount);
        await t.page.waitForFunction((id) => [...document.querySelectorAll('tr')].some((tr) => tr.textContent.includes(`#${id}`) && tr.querySelector('input[aria-label="Paid"]')?.value), claim.id);
      });
      if (!(await t.page.locator('.badge.ok:has-text("balanced")').count())) {
        const row = t.page.locator('tr', { hasText: `#${claim.id}` }).first();
        t.flag('asks-known', 'The check amount wasn’t matched to the claim: its paid amount is typed by hand');
        await t.step('On the claim’s line type what the payer paid', async () => {
          await t.click(row.locator('input').first());
          await t.type(amount);
        });
      }
      await t.step('Press Enter: posted to the claim (audited; a check posted twice is caught)', async () => {
        await t.key('Enter');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A114: { // void a claim at the payer
    role: 'billing',
    setup: (t) => sentClaim(t, 'Voida', 'D0120'),
    async run(t, { claim }) {
      await t.open(`/claims/${claim.id}`, 'h1');
      await t.step('On the claim, click "Void at payer…": a box for the payer’s claim number opens right there', async () => {
        await t.click('button:has-text("Void at payer")');
        await t.see('.inline-ask input');
      });
      if (t.dialogs.length) t.flag('asks-known', 'Void at payer asks for the payer’s claim number in a browser prompt box (the ERA/claim status may already have it)');
      await t.step('Type the payer’s claim number from the EOB and press Enter: the void notice is made', async () => {
        await t.type('PAYER-98765');
        await t.key('Enter');
        await t.see('.badge:has-text("Void notice")');
      });
    },
  },

  A106: { // corrected claim
    role: 'billing',
    setup: (t) => sentClaim(t, 'Fixie', 'D0120'),
    async run(t, { claim }) {
      await t.open(`/claims/${claim.id}`, 'h1');
      await t.step('On the claim, click "Corrected claim…": a box for the payer’s claim number opens right there', async () => {
        await t.click('button:has-text("Corrected claim")');
        await t.see('.inline-ask input');
      });
      if (t.dialogs.length) t.flag('asks-known', 'Corrected claim asks for the payer’s original claim number in a browser prompt box');
      await t.step('Type the payer’s claim number and press Enter: the corrected claim opens, ready to send', async () => {
        await t.type('PAYER-12345');
        await t.key('Enter');
        await t.see('.badge:has-text("Corrected claim")');
      });
    },
  },

  A102: { // void a payment
    role: 'admin', // voiding cash needs a manager (cash controls); the front desk sees Void but is refused after typing a reason
    async setup(t) {
      const p = await newPatient(t, 'Oops');
      await t.as('admin').post(`/patients/${p.id}/payments`, { amount: 4500, method: 'cash' });
      return { p };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=ledger`, 'main table');
      await t.step('Ledger: click "Void" on the payment’s line', async () => {
        await t.click(t.page.locator('tr', { hasText: /payment/i }).locator('button:has-text("Void")').first());
        await t.see('input[placeholder*="wrong patient"], .modal');
      });
      await t.step('Type the reason and click "Void entry": reversed (the original stays on the ledger)', async () => {
        await t.type('Posted to the wrong patient');
        await t.click('button:has-text("Void entry")');
        await t.see('button:has-text("Void entry")', { state: 'detached' });
      });
    },
  },

  A077: { // payment link
    role: 'frontdesk',
    async setup(t) {
      const { dentist } = await refs(t);
      const p = await newPatient(t, 'Linky');
      await t.as('admin').post(`/patients/${p.id}/procedures`, { code: 'D2392', tooth: '30', surfaces: 'MO', complete: true, provider_id: dentist.id });
      return { p };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=ledger`, 'button:has-text("Take payment")');
      const btn = t.page.locator('button:has-text("Send card payment link")');
      if (!(await btn.count())) {
        t.blocked('No "Send card payment link" on the ledger: card payments aren’t connected (not even the sandbox)');
      }
      await t.step('Ledger: click "Send card payment link": the amount they owe is filled in', async () => {
        await t.click(btn);
        await t.see('.modal');
      });
      await t.step('Click "Create secure payment link": texted to the patient (the demo office’s card payments are the sandbox: the link opens its Pay my bill page)', async () => {
        await t.click('.modal button:has-text("Create secure payment link")');
        await t.see('.modal :text("Link sent to")');
      });
      t.note('Batch 3: measured on the sandbox card processor (PAYMENTS=sandbox): the text-to-pay link opens the practice’s Pay my bill page, which takes test cards only.');
    },
  },

  A113: { // payment plan
    role: 'billing',
    async setup(t) {
      const { dentist } = await refs(t);
      const p = await newPatient(t, 'Plany');
      await t.as('admin').post(`/patients/${p.id}/procedures`, { code: 'D2740', tooth: '14', complete: true, provider_id: dentist.id });
      return { p };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=ledger`, 'h3:has-text("Payment plans")');
      await t.step('Ledger → Payment plans: click "+ New plan": a dialog with 6 monthly installments', async () => {
        await t.click('button:has-text("New plan")');
        await t.see('.modal label:has-text("Total") input');
      });
      if (!(await t.page.inputValue('.modal label:has-text("Total") input'))) {
        t.flag('asks-known', 'New payment plan: "Total" starts empty although the patient’s balance is known');
        await t.step('Type the total (the balance, read off the screen behind)', async () => {
          await t.type('1350');
        });
      }
      await t.step('Click "Create plan"', async () => {
        await t.click('.modal button:has-text("Create plan")');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A118: { // membership
    role: 'frontdesk',
    async setup(t) {
      const plans = await t.as('admin').get('/membership-plans');
      if (!(plans.rows || plans).length) await t.as('admin').post('/membership-plans', { name: 'Smile Club (adult)', price: 3500, interval: 'month' });
      return { p: await newPatient(t, 'Member') };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}`, '#medical-history');
      await t.step('Chart overview → Membership: click "Enroll…"', async () => {
        await t.click('button:has-text("Enroll")');
        await t.see('.modal');
      });
      const plan = t.page.locator('.modal select').first();
      if (await plan.count()) {
        const opts = await plan.locator('option').allTextContents();
        if (opts.length > 1 && !(await plan.inputValue())) await t.step('Pick the plan', async () => { await plan.selectOption({ index: 1 }); });
      }
      await t.step('Click Enroll', async () => {
        await t.click('.modal button.primary:has-text("Enroll")');
        await t.see('.modal', { state: 'detached' });
      });
    },
  },

  A147: { // collections
    role: 'admin',
    // An office that sends accounts to collections has its agency set once (Collections settings).
    async setup(t) {
      await t.as('admin').put('/practice', { collection_agency: 'Summit Recovery Services' });
      t.after(async () => { await t.as('admin').put('/practice', { collection_agency: '' }); });
    },
    async run(t) {
      await t.open('/claims?tab=collections', 'h2:has-text("Past-due accounts")');
      const open = t.page.locator('main button:has-text("Open")').first();
      if (!(await open.count())) throw new Error('no past-due accounts in the demo office');
      await t.step('Billing → Collections: click "Open" on the oldest past-due account (it opens beside the list)', async () => {
        await t.click(open);
        await t.see('.side-panel h3:has-text("Agency")');
      });
      const send = t.page.locator('button:has-text("Send"):has-text("agency"), button:has-text("to collections"), button:has-text("Send to")').first();
      if (await send.count()) {
        await t.step('Click "Send to agency": sent at once (Undo on the toast takes it back out)', async () => {
          await t.click(send);
          await t.see('.toast:has-text("sent to")');
        });
      } else t.note('No agency set up: the account can only be worked (letters, calls) here.');
    },
  },
};
