import { HttpError } from '../auth.js';

// QuickBooks Online: the practice's books. The office connects its company once (Intuit sign-in); after that
// the chart of accounts and the monthly profit and loss come in for the numbers, and — if the office wants —
// matched bank deposits go to QuickBooks as deposits, as totals only (never patient names).
// QBO_CLIENT_ID + QBO_CLIENT_SECRET (+ QBO_ENV: sandbox | production) turn it on; QBO=sandbox simulates a
// company for demos.
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';

export function createQuickBooks({ config, fetchImpl = globalThis.fetch }) {
  if (config.qboClientId && config.qboClientSecret) {
    const env = config.qboEnv === 'production' ? 'production' : 'sandbox';
    const apiBase = env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
    const basic = `Basic ${Buffer.from(`${config.qboClientId}:${config.qboClientSecret}`).toString('base64')}`;
    const tokenCall = async (params) => {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST', headers: { Authorization: basic, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new HttpError(502, `QuickBooks sign-in: ${data.error_description || data.error || res.status}`), { code: data.error });
      return tokens(data);
    };
    return {
      mode: env === 'production' ? 'quickbooks' : 'quickbooks-sandbox',
      enabled: true,
      environment: env,
      authUrl: (state, redirectUri) => `${AUTH_URL}?${new URLSearchParams({ client_id: config.qboClientId, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri, state })}`,
      exchange: (code, redirectUri) => tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      refresh: (refreshToken) => tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      async revoke(refreshToken) {
        await fetchImpl(REVOKE_URL, { method: 'POST', headers: { Authorization: basic, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: refreshToken }) }).catch(() => {});
      },
      // One API call for a connected company. `auth` is { realmId, accessToken }.
      async api(auth, method, path, body) {
        const url = `${apiBase}/v3/company/${auth.realmId}/${path}${path.includes('?') ? '&' : '?'}minorversion=75`;
        const res = await fetchImpl(url, {
          method, headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw Object.assign(new HttpError(502, 'QuickBooks: sign-in expired'), { expired: true });
        if (!res.ok) throw new HttpError(502, `QuickBooks: ${data.Fault?.Error?.[0]?.Detail || data.Fault?.Error?.[0]?.Message || res.status}`);
        return data;
      },
      async company(auth) {
        const out = await this.api(auth, 'GET', `companyinfo/${auth.realmId}`);
        return { name: out.CompanyInfo?.CompanyName || null };
      },
      async accounts(auth) {
        const out = await this.api(auth, 'GET', `query?query=${encodeURIComponent('select * from Account maxresults 1000')}`);
        return (out.QueryResponse?.Account || []).map((a) => ({ qbo_id: String(a.Id), name: a.Name, full_name: a.FullyQualifiedName, type: a.AccountType, subtype: a.AccountSubType, active: a.Active === false ? 0 : 1 }));
      },
      async profitAndLoss(auth, from, to) {
        return parseProfitAndLoss(await this.api(auth, 'GET', `reports/ProfitAndLoss?${new URLSearchParams({ start_date: from, end_date: to, summarize_column_by: 'Month', accounting_method: 'Cash' })}`));
      },
      // A bank deposit: the gross amount to the income account, card fees taken out as "cash back" to the
      // fees account, landing in the bank account.
      async createDeposit(auth, { date, bankAccountId, incomeAccountId, feesAccountId, gross, fee, memo }) {
        const out = await this.api(auth, 'POST', 'deposit', {
          TxnDate: date, DepositToAccountRef: { value: bankAccountId }, PrivateNote: memo,
          Line: [{ Amount: gross / 100, DetailType: 'DepositLineDetail', Description: memo, DepositLineDetail: { AccountRef: { value: incomeAccountId } } }],
          ...(fee > 0 && feesAccountId ? { CashBack: { AccountRef: { value: feesAccountId }, Amount: fee / 100, Memo: 'Card processing fees' } } : {}),
        });
        return String(out.Deposit?.Id);
      },
    };
  }
  if (config.qbo === 'sandbox') return sandboxQuickBooks();
  return { mode: 'off', enabled: false };
}

const tokens = (d) => ({
  accessToken: d.access_token, refreshToken: d.refresh_token,
  expiresAt: new Date(Date.now() + (Number(d.expires_in) || 3600) * 1000 - 60_000).toISOString(),
  refreshExpiresAt: d.x_refresh_token_expires_in ? new Date(Date.now() + Number(d.x_refresh_token_expires_in) * 1000).toISOString() : null,
});

// QuickBooks' report JSON → [{ month, qbo_account_id, account_name, section, amount }]. Sections are Income,
// Cost of Goods Sold, Expenses, Other Income and Other Expenses; only the account rows are kept (not totals).
export function parseProfitAndLoss(report) {
  const cols = (report.Columns?.Column || []).map((c) => (c.MetaData || []).find((m) => m.Name === 'StartDate')?.Value?.slice(0, 7) || null);
  const out = [];
  const walk = (rows, section) => {
    for (const row of rows || []) {
      const sec = SECTION[row.group] || section;
      if (row.Rows?.Row) walk(row.Rows.Row, sec);
      if (row.type === 'Data' || (!row.Rows && row.ColData)) {
        const cells = row.ColData || [];
        cells.slice(1).forEach((c, i) => {
          const month = cols[i + 1];
          const v = Math.round(Number(c.value || 0) * 100);
          if (month && v && sec) out.push({ month, qbo_account_id: cells[0]?.id || null, account_name: cells[0]?.value || 'Account', section: sec, amount: v });
        });
      }
    }
  };
  walk(report.Rows?.Row, null);
  return out;
}
const SECTION = { Income: 'income', COGS: 'cogs', Expenses: 'expense', OtherIncome: 'other_income', OtherExpenses: 'other_expense' };

// A pretend QuickBooks company for demos: a dental chart of accounts, and a profit and loss built from the
// practice's own collections so the numbers hang together.
function sandboxQuickBooks() {
  const CHART = [
    ['1', 'Operating Checking', 'Bank', 'Checking'], ['2', 'Patient Income', 'Income', 'ServiceFeeIncome'], ['3', 'Insurance Income', 'Income', 'ServiceFeeIncome'],
    ['10', 'Dental Supplies', 'Cost of Goods Sold', 'SuppliesMaterialsCogs'], ['11', 'Lab Fees', 'Cost of Goods Sold', 'CostOfLabor'],
    ['20', 'Payroll Expenses:Staff Wages', 'Expense', 'PayrollExpenses'], ['21', 'Payroll Expenses:Payroll Taxes', 'Expense', 'PayrollExpenses'], ['22', 'Payroll Expenses:Employee Benefits', 'Expense', 'PayrollExpenses'],
    ['23', 'Associate Dentist Compensation', 'Expense', 'PayrollExpenses'], ['30', 'Rent', 'Expense', 'RentOrLeaseOfBuildings'], ['31', 'Utilities', 'Expense', 'Utilities'],
    ['32', 'Janitorial & Repairs', 'Expense', 'RepairMaintenance'], ['40', 'Advertising & Marketing', 'Expense', 'AdvertisingPromotional'], ['50', 'Software & Subscriptions', 'Expense', 'OfficeGeneralAdministrativeExpenses'],
    ['51', 'Malpractice Insurance', 'Expense', 'Insurance'], ['52', 'Accounting & Legal', 'Expense', 'LegalProfessionalFees'], ['53', 'Merchant Processing Fees', 'Expense', 'BankCharges'],
    ['60', 'Equipment Repairs & Depreciation', 'Expense', 'EquipmentRental'], ['70', 'Interest Expense', 'Other Expense', 'OtherMiscellaneousExpense'],
  ];
  // Share of collections each account typically takes.
  const SHARE = { 10: 0.058, 11: 0.084, 20: 0.205, 21: 0.024, 22: 0.03, 23: 0.18, 30: 0.058, 31: 0.011, 32: 0.009, 40: 0.034, 50: 0.022, 51: 0.009, 52: 0.008, 53: 0.021, 60: 0.015, 70: 0.012 };
  let deposits = 0;
  return {
    mode: 'sandbox',
    enabled: true,
    environment: 'sandbox',
    authUrl: (state, redirectUri) => `${redirectUri}?${new URLSearchParams({ code: 'sandbox-code', realmId: '9130357992222222', state })}`,
    async exchange(code) {
      if (code !== 'sandbox-code') throw new HttpError(400, 'Not a sandbox sign-in');
      return { accessToken: 'sandbox-access', refreshToken: 'sandbox-refresh', expiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshExpiresAt: new Date(Date.now() + 100 * 86400_000).toISOString() };
    },
    async refresh() { return this.exchange('sandbox-code'); },
    async revoke() {},
    async company() { return { name: 'Bright Smiles Dental PLLC (sandbox)' }; },
    async accounts() { return CHART.map(([qbo_id, full_name, type, subtype]) => ({ qbo_id, name: full_name.split(':').pop(), full_name, type, subtype, active: 1 })); },
    // `ctx.collections` is { 'YYYY-MM': cents } from the practice's own ledger.
    async profitAndLoss(_auth, from, to, ctx = {}) {
      const out = [];
      for (const [month, collected] of Object.entries(ctx.collections || {})) {
        if (`${month}-01` < from.slice(0, 7) + '-01' || `${month}-01` > to) continue;
        out.push({ month, qbo_account_id: '2', account_name: 'Patient Income', section: 'income', amount: Math.round(collected * 0.45) });
        out.push({ month, qbo_account_id: '3', account_name: 'Insurance Income', section: 'income', amount: collected - Math.round(collected * 0.45) });
        for (const [id, share] of Object.entries(SHARE)) {
          const acct = CHART.find((c) => c[0] === id);
          const wobble = 0.92 + ((Number(month.replace('-', '')) * Number(id)) % 17) / 100;
          out.push({ month, qbo_account_id: id, account_name: acct[1].split(':').pop(), section: acct[2] === 'Cost of Goods Sold' ? 'cogs' : acct[2] === 'Other Expense' ? 'other_expense' : 'expense', amount: Math.round(collected * share * wobble) });
        }
      }
      return out;
    },
    async createDeposit() { deposits++; return `sbx-dep-${Date.now()}-${deposits}`; },
  };
}
