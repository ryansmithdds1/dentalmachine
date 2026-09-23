import { localNow } from './util.js';
import { raiseIssue } from './issues.js';
import { agingReport } from './aging.js';

// Reports that can be saved and emailed: each turns its saved filters into a plain-text summary.
const $ = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const pad = (label, value) => `${label.padEnd(28, ' ')}${String(value).padStart(14, ' ')}`;

// The dates a saved report covers, relative to today.
export function rangeFor(period, today) {
  switch (period) {
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last_7': return { from: addDays(today, -7), to: addDays(today, -1) };
    case 'last_month': {
      const first = `${today.slice(0, 7)}-01`;
      const end = addDays(first, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    case 'ytd': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default: return { from: `${today.slice(0, 7)}-01`, to: today }; // mtd
  }
}
export const PERIODS = { mtd: 'Month to date', last_month: 'Last month', last_7: 'Last 7 days', yesterday: 'Yesterday', ytd: 'Year to date' };

export const REPORTS = {
  production: {
    label: 'Production & collections',
    async render(db, pid, params, today) {
      const { from, to } = rangeFor(params.period, today);
      const where = [];
      const args = [];
      for (const k of ['location_id', 'provider_id']) if (params[k]) { where.push(` AND l.${k} = ?`); args.push(Number(params[k])); }
      const sum = async (types) => (await db.get(`SELECT COALESCE(SUM(l.amount), 0) AS n FROM ledger_entries l WHERE l.practice_id = ? AND l.entry_date BETWEEN ? AND ? AND l.type IN (${types.map(() => '?').join(',')})${where.join('')}`, pid, from, to, ...types, ...args)).n;
      const production = await sum(['charge']);
      const collections = -(await sum(['payment', 'insurance_payment']));
      const adjustments = await sum(['adjustment']);
      const byProvider = await db.all(
        `SELECT pv.name, SUM(l.amount) AS n FROM ledger_entries l JOIN providers pv ON pv.id = l.provider_id WHERE l.practice_id = ? AND l.type = 'charge' AND l.entry_date BETWEEN ? AND ?${where.join('')}
         GROUP BY pv.name ORDER BY SUM(l.amount) DESC`, pid, from, to, ...args,
      );
      return [
        `${from} to ${to}`, '',
        pad('Production', $(production)), pad('Collections', $(collections)), pad('Adjustments', $(adjustments)),
        pad('Collection rate', production ? `${Math.round((collections / production) * 100)}%` : '—'), '',
        'By provider', ...byProvider.map((p) => pad(`  ${p.name}`, $(p.n))),
      ];
    },
  },
  daysheet: {
    label: 'Day sheet (yesterday)',
    async render(db, pid, params, today) {
      const day = addDays(today, -1);
      const rows = await db.all("SELECT type, method, SUM(amount) AS n FROM ledger_entries WHERE practice_id = ? AND entry_date = ?" + (params.location_id ? ' AND location_id = ?' : '') + ' GROUP BY type, method', pid, day, ...(params.location_id ? [Number(params.location_id)] : []));
      const t = (type) => rows.filter((r) => r.type === type).reduce((s, r) => s + r.n, 0);
      const visits = await db.all('SELECT status, COUNT(*) AS n FROM appointments WHERE practice_id = ? AND start_time >= ? AND start_time < ? GROUP BY status', pid, `${day} 00:00`, `${day} 24:00`);
      return [
        day, '', pad('Production', $(t('charge'))), pad('Patient payments', $(-t('payment'))), pad('Insurance payments', $(-t('insurance_payment'))),
        pad('Adjustments', $(t('adjustment'))), pad('Refunds', $(t('refund'))), '',
        'Deposit by method', ...rows.filter((r) => ['payment', 'insurance_payment'].includes(r.type)).map((r) => pad(`  ${r.type === 'insurance_payment' ? 'insurance ' : ''}${r.method || 'other'}`, $(-r.n))), '',
        `Visits: ${visits.map((v) => `${v.n} ${v.status.replace('_', ' ')}`).join(', ') || 'none'}`,
      ];
    },
  },
  aging: {
    label: 'Accounts receivable (aging)',
    async render(db, pid, params, today) {
      const { totals } = await agingReport(db, pid, today, { family: true });
      return [
        `As of ${today}`, '', pad('Current', $(totals.current)), pad('31–60 days', $(totals.d31_60)), pad('61–90 days', $(totals.d61_90)), pad('Over 90 days', $(totals.d90_plus)),
        pad('Total owed', $(totals.total)), pad('  expected from insurance', $(totals.insurance_pending)), pad('  owed by patients', $(totals.patient_portion)), pad('Credits', $(totals.credits)),
      ];
    },
  },
};

export async function renderSaved(db, report, today) {
  const def = REPORTS[report.report];
  const params = report.params ? JSON.parse(report.params) : {};
  const practice = await db.get('SELECT name FROM practices WHERE id = ?', report.practice_id);
  const lines = await def.render(db, report.practice_id, params, today);
  return { subject: `${report.name} — ${practice.name}`, body: [`${def.label}${params.period ? ` · ${PERIODS[params.period] || ''}` : ''}`, ...lines].join('\n') };
}

// Whether a schedule is due today (after 7am practice time) and hasn't gone out for today yet.
export function isDue(report, local) {
  if (!report.schedule || Number(local.slice(11, 13)) < 7) return false;
  const today = local.slice(0, 10);
  if (report.last_sent_for === today) return false;
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  return report.schedule === 'daily' || (report.schedule === 'weekly' && weekday === 1) || (report.schedule === 'monthly' && today.endsWith('-01'));
}

export async function sendSaved(db, messenger, report, today) {
  const { subject, body } = await renderSaved(db, report, today);
  let sent = 0;
  for (const to of JSON.parse(report.recipients || '[]')) {
    try {
      await messenger.send({ channel: 'email', to, subject, body });
      sent++;
    } catch (err) {
      // One bad address doesn't stop the rest, but someone should know it didn't go.
      await raiseIssue(db, { practiceId: report.practice_id, kind: 'message', key: `saved-report:${report.id}:${to}`, role: 'admin', title: `Scheduled report "${report.name}" couldn't be emailed to ${to}`, detail: err.message });
    }
  }
  await db.run("UPDATE saved_reports SET last_sent_at = datetime('now'), last_sent_for = ? WHERE id = ?", today, report.id);
  return sent;
}

export async function runScheduledReports(db, messenger, now = new Date()) {
  let sent = 0;
  for (const r of await db.all('SELECT s.*, p.timezone FROM saved_reports s JOIN practices p ON p.id = s.practice_id WHERE s.schedule IS NOT NULL')) {
    const local = localNow(r.timezone, now);
    if (isDue(r, local)) sent += await sendSaved(db, messenger, r, local.slice(0, 10));
  }
  return sent;
}
