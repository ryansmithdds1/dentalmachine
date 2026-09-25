import { useEffect, useState } from 'react';
import { api, download, getLocationId } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useCommands } from '../shortcuts.js';
import { practiceToday } from '../format.js';
import { toast } from '../toast.js';

// "export <report>" in the command bar (Ctrl/⌘K) downloads a report as a spreadsheet straight away, without opening
// it first: "export day sheet" is today's day sheet, "export aging by family" a report-library report on its usual
// dates. The file is made by the server, which records the export (who, what, when) like every report download.
// The rows only show once the words start with "export" (or "download"), at the bottom of the list, so they never
// push down the screen a person is looking for by name.
const EXPORTING = /^\s*(export|download)\b/i;
const paletteText = () => document.querySelector('.palette input')?.value || '';
const NEVER = '\u0000'; // a label no typed words match: the row stays hidden
const PAYROLL = [['gusto', 'Gusto'], ['adp', 'ADP Workforce Now'], ['paychex', 'Paychex Flex'], ['quickbooks', 'QuickBooks Payroll'], ['csv', 'a plain CSV']];

export default function ExportCommands() {
  const { can, practice } = useAuth();
  const allowed = can('reports:read');
  const [catalog, setCatalog] = useState(null);
  // The report library's names are fetched the first time someone starts typing "export" (not on every page load).
  useEffect(() => {
    if (!allowed || catalog) return undefined;
    const onInput = (e) => {
      if (!e.target.closest?.('.palette') || !/^\s*(exp|down)/i.test(e.target.value || '')) return;
      document.removeEventListener('input', onInput, true);
      api.get('/report-library').then(setCatalog).catch(() => { /* the day sheet export still works; the library ones just don't show */ });
    };
    document.addEventListener('input', onInput, true);
    return () => document.removeEventListener('input', onInput, true);
  }, [allowed, catalog]);

  const run = async (path, fallback) => {
    try {
      const name = await download(path, fallback);
      toast(`Downloaded ${name} — open it in Excel, Numbers or Google Sheets`);
    } catch (e) {
      toast(`Couldn’t export: ${e.message}`, { tone: 'error' });
    }
  };
  const office = () => (getLocationId() ? `&location_id=${getLocationId()}` : '');
  const row = (id, label, hint, go) => ({ id, get label() { return EXPORTING.test(paletteText()) ? label : NEVER; }, hint, icon: '⬇', last: true, run: go });
  // Payroll: the pay period that just ended, in the format this office exported last (or any format by name). The
  // server refuses until everyone's hours are approved, and records every file (who, when, hash).
  const payroll = async (format) => {
    let fmt = format;
    if (!fmt) {
      try { fmt = (await api.get('/timeclock/exports'))[0]?.format || 'csv'; } catch { fmt = 'csv'; }
    }
    return run(`/timeclock/period/export.csv?format=${fmt}`, `payroll-${fmt}.csv`);
  };
  const payrollRows = !can('timeclock:manage') ? [] : [
    row('export-payroll', 'Export payroll (the pay period that just ended)', 'Time clock · in the format you used last · approved hours only', () => payroll(null)),
    ...PAYROLL.map(([k, l]) => row(`export-payroll-${k}`, `Export payroll for ${l}`, 'Time clock · the pay period that just ended', () => payroll(k))),
  ];
  useCommands(!allowed ? payrollRows : [
    ...payrollRows,
    row('export-day-sheet', 'Export day sheet (today, spreadsheet)', 'Downloads today’s day sheet as a CSV', () => {
      const today = practiceToday(practice?.timezone);
      return run(`/reports/daysheet?date=${today}&format=csv${office()}`, `day-sheet-${today}.csv`);
    }),
    ...(catalog?.reports || []).map((r) => row(`export-${r.id}`, `Export ${r.name} (spreadsheet)`, `Report library · ${r.category} · usual dates`, () => run(`/report-library/${r.id}?format=csv${office()}`, `${r.id}.csv`))),
  ]);
  return null;
}
