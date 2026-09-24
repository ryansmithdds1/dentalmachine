import { Router } from 'express';
import { requirePermission, HttpError } from '../auth.js';
import { audit, toCsv } from '../util.js';
import { buildContext, getReport, productionIncome, productionIncomeEntries } from '../reportlibrary.js';

// Reports → Production & income (PR1): the one-screen report (numbers from reportlibrary.js, the same queries as
// the report library, where it is also listed as 'production-income'). Needs reports:read and is held to the
// person's offices like every library report. Paths sit outside /reports so someone limited to some offices gets
// their offices' numbers rather than a refusal.
//   GET /production-income?from&to&location_id             tiles, providers, daily rows, month projection, goal
//   GET /production-income?…&format=csv                     the provider and daily rows as a spreadsheet (audited)
//   GET /production-income/entries?metric&provider_id&day  the entries behind a number (audited: names patients)
export default function productionReportRoutes({ db }) {
  const r = Router();
  const def = () => getReport('production-income');

  r.get('/production-income', requirePermission('reports:read'), async (req, res) => {
    const ctx = await buildContext(db, req.user, def(), req.query);
    const result = await productionIncome(ctx);
    if (req.query.format !== 'csv') return res.json({ ...result, today: ctx.today, generated_at: ctx.now });
    await audit(db, req, 'report.export', 'report_library', null, { report: 'production-income', params: { from: ctx.from, to: ctx.to, location_id: ctx.locationId } });
    const $ = (c) => (c == null ? '' : (Number(c) / 100).toFixed(2));
    const money = ['gross', 'ppo_writeoffs', 'other_adjustments', 'net', 'patient', 'insurance', 'collections', 'refunds'];
    const heads = { gross: 'Gross production', ppo_writeoffs: 'PPO write-offs', other_adjustments: 'Other adjustments', net: 'Net production', patient: 'Patient payments', insurance: 'Insurance payments', collections: 'Collections', refunds: 'Refunds' };
    const rows = [
      ...result.providers.map((p) => ({ section: 'Provider', name: p.provider, ...p })),
      { section: 'Office total', name: 'Total', ...result.totals },
      ...result.days.map((d) => ({ section: 'Day', name: d.day, ...d })),
    ];
    const csv = toCsv(rows, [
      ['Section', (x) => x.section], ['Provider / date', (x) => x.name],
      ...money.map((k) => [`${heads[k]} ($)`, (x) => $(x[k])]),
      ['Collection % (%)', (x) => x.collection_pct ?? ''],
      ['Running net production ($)', (x) => $(x.running_net)],
      ['Running collections ($)', (x) => $(x.running_collections)],
    ]);
    const p = result.projection;
    const tail = p ? `\r\nMonth ${p.month},Done so far ($),${$(p.month_to_date)},Scheduled rest of month ($),${$(p.scheduled)},Projected ($),${$(p.projected)},Goal ($),${$(p.goal)}\r\n` : '';
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="production-income-${ctx.from}-to-${ctx.to}.csv"`);
    res.send(csv + tail);
  });

  r.get('/production-income/entries', requirePermission('reports:read'), async (req, res) => {
    const ctx = await buildContext(db, req.user, def(), req.query);
    const raw = req.query.provider_id;
    let providerId = null;
    if (raw === 'none') providerId = 'none';
    else if (raw != null && raw !== '') {
      if (!/^\d+$/.test(String(raw))) throw new HttpError(400, 'provider_id must be a number or "none"');
      providerId = Number(raw);
    }
    const day = req.query.day ? String(req.query.day) : null;
    const out = await productionIncomeEntries(ctx, { metric: String(req.query.metric || ''), providerId, day });
    await audit(db, req, 'report.drill', 'report_library', null, { report: 'production-income', metric: out.metric, provider_id: providerId, day, from: ctx.from, to: ctx.to, rows: out.rows.length });
    res.json(out);
  });

  return r;
}
