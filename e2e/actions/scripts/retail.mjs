// Products and gift certificates on the one ledger (docs/cash-handling.md §10).
import { newPatient, activate, refs } from '../lib/fixtures.mjs';

// The demo office sells a few things (set up once through the API, as an administrator would in Settings).
async function products(t) {
  const admin = t.as('admin');
  const have = await admin.get('/retail/products?all=1');
  for (const [name, price] of [['Sonic toothbrush', 8900], ['Whitening kit', 19900], ['Floss picks', 400]]) {
    if (!have.some((p) => p.name === name)) await admin.post('/retail/products', { name, price });
  }
}

export default {
  A176: { // sell a product
    role: 'frontdesk',
    async setup(t) {
      await products(t);
      const p = await newPatient(t, 'Sonia');
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open(`/patients/${p.id}?tab=ledger`, 'button:has-text("Sell a product")');
      await t.step('Account (ledger): click "Sell a product" — the products, with prices, and the first one chosen', async () => {
        await t.click('button:has-text("Sell a product")');
        await t.see('.retail-item.active');
      });
      await t.step('Press 2 for the sonic toothbrush (quantity 1, tax worked out)', async () => {
        await t.key('2');
        await t.see('.retail-item.active:has-text("Sonic toothbrush")');
      });
      await t.step('Press Enter: on the account as a charge, with Undo', async () => {
        await t.key('Enter');
        await t.see('.inline-panel[aria-label="Sell a product"]', { state: 'detached' });
        await t.see('td:has-text("Sonic toothbrush")');
      });
    },
  },

  A184: { // sell a gift certificate (using one is on the ledger: "Gift certificate", type the code, Enter)
    role: 'frontdesk',
    async setup(t) {
      await refs(t);
      const p = await newPatient(t, 'Gilda');
      await activate(t, p.id);
      return { p };
    },
    async run(t, { p }) {
      await t.open('/gift-certificates', 'h1:has-text("Gift certificates")');
      await t.step('Account → Gift certificates: press N — the buyer is the active patient, paid the way this person usually takes payments', async () => {
        await t.key('n');
        await t.see(`.cmp-chip:has-text("${p.last_name}")`);
        await t.focusIs('Amount ($)');
      });
      await t.step('Type the amount', async () => {
        await t.type('100');
      });
      await t.step('Press Enter: sold — the code is shown with "Print the certificate"', async () => {
        await t.key('Enter');
        await t.see('.public-notice:has-text("Sold GC-")');
      });
      t.note('Using a certificate: on the patient’s ledger click “Gift certificate”, type the 8-character code, Enter (the amount is what it holds or what they owe, whichever is less).');
    },
  },
};
