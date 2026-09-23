import { useLookup } from '../hooks.js';
import { downloadCsv } from '../api.js';

// Shared report controls: a provider picker (optionally one type, e.g. hygienists) and a CSV download.
export function ProviderSelect({ value, onChange, type, label = 'All providers' }) {
  const providers = useLookup('/providers').filter((p) => !type || p.type === type);
  return (
    <select aria-label="Provider" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto' }}>
      <option value="">{label}</option>
      {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

export function CsvButton({ name, rows, columns }) {
  return <button className="small no-print" disabled={!rows?.length} onClick={() => downloadCsv(name, rows, columns)} title="Download as a spreadsheet (CSV)">⬇ CSV</button>;
}

export function PrintButton() {
  return <button className="small no-print" onClick={() => window.print()} title="Print, or choose “Save as PDF” in the print dialog">Print / PDF</button>;
}
