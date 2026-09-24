import { Router } from 'express';
import { requirePermission } from '../auth.js';
import { audit } from '../util.js';
import { listReports, runReport, reportCsv } from '../reportlibrary.js';

// Reports → Report library: the ready-made reports (see reportlibrary.js). Needs reports:read; admin-only
// reports and office limits are checked per report. ?format=csv downloads the report, and the export is audited.
export default function reportLibraryRoutes({ db }) {
  const r = Router();

  r.get('/report-library', requirePermission('reports:read'), async (req, res) => {
    res.json(await listReports(db, req.user));
  });

  r.get('/report-library/:id', requirePermission('reports:read'), async (req, res) => {
    const result = await runReport(db, req.user, req.params.id, req.query);
    if (req.query.format === 'csv') {
      const p = result.params;
      const span = p.from ? `${p.from}-to-${p.to}` : p.date || p.month || p.as_of || p.generated_at || '';
      await audit(db, req, 'report.export', 'report_library', null, { report: result.report.id, rows: result.row_count, params: p });
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${result.report.id}${span ? `-${span}` : ''}.csv"`);
      return res.send(reportCsv(result));
    }
    res.json(result);
  });

  return r;
}
