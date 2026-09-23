import { createPublicKey, createHash, verify as verifySig } from 'node:crypto';
import { HttpError } from '../auth.js';

// Bank data through Plaid: the office links its business accounts once (Plaid Link, in the browser), then
// transactions sync in on their own. PLAID_CLIENT_ID + PLAID_SECRET (+ PLAID_ENV: sandbox | production)
// turn it on; PLAID=sandbox simulates a bank for demos, with deposits that mirror the practice's own.
// Plaid only ever sees the practice's bank login — no patient information goes to it.
export function createPlaid({ config, fetchImpl = globalThis.fetch }) {
  if (config.plaidClientId && config.plaidSecret) {
    const base = `https://${config.plaidEnv === 'production' ? 'production' : 'sandbox'}.plaid.com`;
    const call = async (path, body) => {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: config.plaidClientId, secret: config.plaidSecret, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new HttpError(502, `Plaid: ${data.error_message || data.error_code || res.status}`), { code: data.error_code });
      return data;
    };
    const keys = new Map();
    return {
      mode: config.plaidEnv === 'production' ? 'plaid' : 'plaid-sandbox',
      enabled: true,
      async linkToken({ practiceId, practiceName, webhook, accessToken }) {
        const out = await call('/link/token/create', {
          client_name: String(practiceName || 'Dental Machine').slice(0, 30), language: 'en', country_codes: ['US'],
          user: { client_user_id: `practice-${practiceId}` },
          // With an access token Link fixes an existing connection (a changed bank password) instead of adding one.
          ...(accessToken ? { access_token: accessToken } : { products: ['transactions'], transactions: { days_requested: 730 } }),
          ...(webhook ? { webhook } : {}),
        });
        return out.link_token;
      },
      async exchange(publicToken) {
        const out = await call('/item/public_token/exchange', { public_token: publicToken });
        return { accessToken: out.access_token, itemId: out.item_id };
      },
      async accounts(accessToken) {
        const out = await call('/accounts/get', { access_token: accessToken });
        return out.accounts.map((a) => ({
          external_id: a.account_id, name: a.name, official_name: a.official_name, mask: a.mask, type: a.type, subtype: a.subtype,
          current_balance: a.balances?.current == null ? null : Math.round(a.balances.current * 100),
          available_balance: a.balances?.available == null ? null : Math.round(a.balances.available * 100),
        }));
      },
      // New, changed and removed transactions since the cursor. Plaid's amounts are positive for money out;
      // ours are positive for money in.
      async sync(accessToken, cursor) {
        const added = [];
        const modified = [];
        const removed = [];
        let next = cursor || undefined;
        for (let page = 0; page < 50; page++) {
          const out = await call('/transactions/sync', { access_token: accessToken, cursor: next, count: 500 });
          added.push(...out.added.map(toTx));
          modified.push(...out.modified.map(toTx));
          removed.push(...out.removed.map((t) => t.transaction_id));
          next = out.next_cursor;
          if (!out.has_more) break;
        }
        return { added, modified, removed, cursor: next };
      },
      async remove(accessToken) {
        await call('/item/remove', { access_token: accessToken }).catch(() => {});
      },
      // Plaid signs its webhooks with a short-lived ES256 key; the body's hash is in the token.
      async verifyWebhook(jwt, rawBody) {
        const [h, p, s] = String(jwt || '').split('.');
        if (!h || !p || !s) return false;
        const header = JSON.parse(Buffer.from(h, 'base64url').toString());
        if (header.alg !== 'ES256') return false;
        if (!keys.has(header.kid)) keys.set(header.kid, (await call('/webhook_verification_key/get', { key_id: header.kid })).key);
        const key = createPublicKey({ key: keys.get(header.kid), format: 'jwk' });
        if (!verifySig('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) return false;
        const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
        if (Math.abs(Date.now() / 1000 - claims.iat) > 300) return false;
        return claims.request_body_sha256 === createHash('sha256').update(rawBody).digest('hex');
      },
    };
  }
  if (config.plaid === 'sandbox') return sandboxPlaid();
  return { mode: 'off', enabled: false };
}

const toTx = (t) => ({
  external_id: t.transaction_id, account_external_id: t.account_id, date: t.date, amount: -Math.round(Number(t.amount) * 100),
  description: t.original_description || t.name, merchant: t.merchant_name || null, provider_category: t.personal_finance_category?.detailed || t.personal_finance_category?.primary || null,
  pending: t.pending ? 1 : 0,
});

// A pretend bank for demos: an operating account and a business card. The deposits line up with the
// practice's deposit slips, insurance payments and card days (card payouts net of fees), and the spending is
// what a typical practice's looks like, so matching and the numbers can be tried without a real bank.
function sandboxPlaid() {
  const day = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return {
    mode: 'sandbox',
    enabled: true,
    async linkToken() { return 'link-sandbox'; },
    async exchange(publicToken) {
      if (!String(publicToken).startsWith('public-sandbox')) throw new HttpError(400, 'Not a sandbox link');
      return { accessToken: `access-sandbox-${Date.now()}`, itemId: `item-sandbox-${Date.now()}` };
    },
    async accounts() {
      return [
        { external_id: 'sbx-checking', name: 'Business Checking', official_name: 'Practice Operating Account', mask: '4410', type: 'depository', subtype: 'checking', current_balance: 8_412_300, available_balance: 8_390_000 },
        { external_id: 'sbx-card', name: 'Business Card', official_name: 'Business Platinum Card', mask: '1007', type: 'credit', subtype: 'credit card', current_balance: 1_284_577, available_balance: null },
      ];
    },
    // `ctx` gives the sandbox the practice's own records to mirror.
    async sync(_token, cursor, ctx) {
      const { db, practiceId, today } = ctx;
      const since = cursor ? cursor.replace('sandbox-', '') : day(today, -120);
      const added = [];
      let scale = 1;
      const add = (account, date, amount, description, merchant, pc) => {
        if (date <= since || date > today) return;
        if (amount < 0) amount = Math.round(amount * scale);
        added.push({ external_id: `sbx-${hash(`${account}|${date}|${description}|${amount}`)}-${added.length}`, account_external_id: account, date, amount, description, merchant, provider_category: pc, pending: 0 });
      };
      // Money in: deposit slips a day later, insurance EFTs the payment date, card days two days later less ~2.9%.
      for (const d of await db.all('SELECT id, deposit_date, total FROM deposits WHERE practice_id = ?', practiceId)) {
        add('sbx-checking', day(d.deposit_date, 1), d.total, `DEPOSIT ID NUMBER ${400000 + d.id}`, null, 'TRANSFER_IN_DEPOSIT');
      }
      for (const e of await db.all('SELECT id, payer_name, check_number, payment_date, total_paid FROM era_imports WHERE practice_id = ? AND total_paid > 0', practiceId)) {
        add('sbx-checking', e.payment_date, e.total_paid, `${String(e.payer_name || 'INSURANCE').toUpperCase().slice(0, 20)} HCCLAIMPMT TRN*1*${e.check_number || e.id}`, null, 'INCOME_OTHER_INCOME');
      }
      const cards = await db.all(
        `SELECT entry_date AS d, -SUM(amount) AS gross FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment','refund') AND method IN ('credit_card','debit_card')
         AND voided_at IS NULL GROUP BY entry_date`, practiceId,
      );
      for (const c of cards) if (c.gross > 0) add('sbx-checking', day(c.d, 2), Math.round(c.gross * 0.971) - 30, `STRIPE TRANSFER ST-${hash(c.d).toString(36).toUpperCase().slice(0, 8)}`, 'Stripe', 'TRANSFER_IN_ACCOUNT_TRANSFER');
      // Money out: a typical practice's bills every month, sized to this practice (the amounts below are for one
      // collecting about $100,000 a month).
      const collected = (await db.get(
        "SELECT -COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE practice_id = ? AND type IN ('payment','insurance_payment','refund') AND voided_at IS NULL AND entry_date > ?", practiceId, day(today, -90),
      )).n / 3;
      scale = Math.min(5, Math.max(0.02, Number(collected) / 10_000_000));
      // Bills start when the practice's own records do.
      const first = (await db.get('SELECT MIN(entry_date) AS d FROM ledger_entries WHERE practice_id = ?', practiceId)).d || today;
      for (let d = day(since > first ? since : first, 1); d <= today; d = day(d, 1)) {
        const dom = Number(d.slice(8));
        const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
        const wiggle = (n) => Math.round(n * (0.9 + (hash(d + n) % 200) / 1000));
        if (dom === 1) add('sbx-checking', d, -1_450_000, 'MAIN STREET PROPERTIES RENT', 'Main Street Properties', 'RENT_AND_UTILITIES_RENT');
        if (dom === 3) add('sbx-checking', d, -wiggle(68_000), 'AUSTIN ENERGY UTILITY PMT', 'Austin Energy', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY');
        if (dom === 5) add('sbx-checking', d, -389_900, 'PRACTICE LOAN PMT BANK OF AMERICA PRACTICE SOLUTIONS', null, 'LOAN_PAYMENTS_OTHER_PAYMENT');
        if (dom === 8) add('sbx-card', d, -wiggle(120_000), 'GOOGLE *ADS', 'Google Ads', 'GENERAL_SERVICES_ADVERTISING');
        if (dom === 10) add('sbx-card', d, -64_900, 'WEAVE COMMUNICATIONS', 'Weave', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES');
        if (dom === 12) add('sbx-checking', d, -wiggle(310_000), 'GLIDEWELL LABORATORIES', 'Glidewell', 'MEDICAL_OTHER_MEDICAL');
        if (dom === 15) add('sbx-checking', d, -118_000, 'MEDPRO MALPRACTICE INSURANCE', 'MedPro', 'GENERAL_SERVICES_INSURANCE');
        if (dom === 18) add('sbx-checking', d, -wiggle(96_000), 'NATIONAL DENTEX LAB', null, 'MEDICAL_OTHER_MEDICAL');
        if (dom === 20) add('sbx-checking', d, -1_000_000, 'ONLINE TRANSFER TO OWNER DRAW', null, 'TRANSFER_OUT_ACCOUNT_TRANSFER');
        if (dom === 22) add('sbx-checking', d, -wiggle(42_000), 'SPECTRUM BUSINESS INTERNET', 'Spectrum', 'RENT_AND_UTILITIES_INTERNET_AND_CABLE');
        if (dom === 25) add('sbx-checking', d, -1_284_577, 'BUSINESS CARD PAYMENT - THANK YOU', null, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT');
        if (dom === 27) add('sbx-checking', d, -wiggle(55_000), 'CLEAN TEAM JANITORIAL', null, 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES');
        if (dow === 2) add('sbx-card', d, -wiggle(98_000), 'HENRY SCHEIN INC', 'Henry Schein', 'MEDICAL_OTHER_MEDICAL');
        if (dow === 4 && dom % 2) add('sbx-card', d, -wiggle(41_000), 'PATTERSON DENTAL SUPPLY', 'Patterson Dental', 'MEDICAL_OTHER_MEDICAL');
        // Payroll every other Friday, with the tax deposit.
        if (dow === 5 && Math.floor(Date.parse(`${d}T12:00:00Z`) / (7 * 86400_000)) % 2 === 0) {
          add('sbx-checking', d, -wiggle(1_840_000), 'GUSTO PAYROLL NET PAY', 'Gusto', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES');
          add('sbx-checking', d, -wiggle(410_000), 'GUSTO TAX IMPOUND', 'Gusto', 'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT');
          add('sbx-checking', d, -620_000, 'GUSTO ASSOCIATE DENTIST PAY', 'Gusto', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES');
        }
      }
      return { added, modified: [], removed: [], cursor: `sandbox-${today}` };
    },
    async remove() {},
    async verifyWebhook() { return false; },
  };
}
