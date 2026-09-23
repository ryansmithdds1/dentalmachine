import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { fmtUtcDateTime } from '../format.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox, Badge, useSubmit } from './ui.jsx';

const KIND_INFO = {
  patients: ['Patients', 'Names, birthdays, contact details, family (guarantor), provider, alerts, and optionally each account balance.'],
  insurance: ['Insurance', 'One row per policy: patient ID, carrier, subscriber ID, group, relationship, primary/secondary, maximums.'],
  balances: ['Account balances', 'Patient ID and balance. Brought over as a “balance forward” adjustment on the date of the import.'],
  appointments: ['Appointments', 'Patient ID, date and time, length, provider, chair, status. Past visits come in as completed.'],
  recalls: ['Recalls', 'Patient ID, recall type, interval, and due date.'],
  treatment: ['Treatment & history', 'Procedure code, tooth, surfaces, fee, status (planned or completed) and date. No charges are posted.'],
};

const FIELD_LABELS = {
  external_id: 'ID in old system', patient: 'Patient ID', first_name: 'First name', last_name: 'Last name', preferred_name: 'Preferred name', dob: 'Birthday',
  gender: 'Gender', phone: 'Mobile phone', phone_home: 'Home phone', phone_work: 'Work phone', email: 'Email', address: 'Address', address2: 'Address line 2',
  city: 'City', state: 'State', zip: 'ZIP', status: 'Status', guarantor: 'Guarantor ID', provider: 'Provider', hygienist: 'Hygienist', referral_source: 'Referral source',
  medical_alerts: 'Medical alert', allergies: 'Allergies', medications: 'Medications', notes: 'Notes', balance: 'Balance', carrier: 'Carrier', payer_id: 'Payer ID',
  group_number: 'Group number', plan_name: 'Group / employer', subscriber_id: 'Subscriber ID', subscriber_name: 'Subscriber name', subscriber_dob: 'Subscriber birthday',
  relationship: 'Relationship', priority: 'Primary / secondary', annual_max: 'Annual max', deductible: 'Deductible', pct_preventive: 'Preventive %', pct_basic: 'Basic %',
  pct_major: 'Major %', datetime: 'Date & time', date: 'Date', time: 'Time', duration: 'Length', operatory: 'Chair', reason: 'Reason / procedures', type: 'Type',
  interval: 'Interval', due_date: 'Due date', code: 'Procedure code', description: 'Description', tooth: 'Tooth', surfaces: 'Surfaces', fee: 'Fee',
};
const REQUIRED = { patients: ['first_name', 'last_name'], insurance: ['patient', 'carrier', 'subscriber_id'], appointments: ['patient'], recalls: ['patient', 'due_date'], treatment: ['patient', 'code'], balances: ['patient', 'balance'] };

// CSV or tab-separated text → rows of cells. Handles quotes, doubled quotes, and newlines inside quotes.
export function parseDelimited(text) {
  const firstLine = text.slice(0, text.search(/\r?\n/) >>> 0);
  const sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== '')).map((r) => r.map((c) => c.replace(/^﻿/, '')));
}

// Splits rows into requests that stay well under the server's 1 MB body limit.
function chunks(rows) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length;
    if (cur.length && (cur.length >= 500 || size + n > 600000)) { out.push(cur); cur = []; size = 0; }
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export default function ImportData() {
  const { practice } = useAuth();
  const { data: meta } = useApi('/imports/fields');
  const { data: history, reload } = useApi('/imports');
  const [source, setSource] = useState('opendental');
  const [kind, setKind] = useState('patients');
  const [file, setFile] = useState(null); // { name, headers, rows }
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const runPreview = useSubmit(async (f = file, m = mapping, k = kind, s = source) => {
    const p = await api.post('/imports/preview', { source: s, kind: k, headers: f.headers, rows: f.rows.slice(0, 25), mapping: m || undefined });
    setPreview(p);
    setMapping(p.mapping);
  });

  const choose = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setResult(null);
    const [headers, ...rows] = parseDelimited(await f.text());
    const next = { name: f.name, headers: headers || [], rows };
    setFile(next);
    setMapping(null);
    setPreview(null);
    if (headers?.length) runPreview.submit(next, null);
  };

  const run = useSubmit(async () => {
    setResult(null);
    const batch = await api.post('/imports', { source, kind, headers: file.headers, mapping, filename: file.name, total: file.rows.length });
    const parts = chunks(file.rows);
    let done = 0;
    setProgress({ done: 0, total: file.rows.length });
    for (const part of parts) {
      await api.post(`/imports/${batch.id}/rows`, { rows: part, offset: done });
      done += part.length;
      setProgress({ done, total: file.rows.length });
    }
    const final = await api.post(`/imports/${batch.id}/finish`);
    setResult(final);
    setProgress(null);
    setFile(null);
    setPreview(null);
    reload();
  });

  const undo = useSubmit(async (b) => {
    if (!window.confirm(`Remove the ${b.created_count} records this import created? Records it updated stay as they are.`)) return;
    await api.post(`/imports/${b.id}/undo`);
    reload();
  });

  if (!meta) return <div className="card">Loading…</div>;
  const fields = meta.fields[kind];
  const missing = REQUIRED[kind].filter((f) => mapping?.[f] == null)
    .concat(kind === 'appointments' && mapping?.datetime == null && mapping?.date == null ? ['date'] : []);
  const errorsInPreview = preview?.results?.filter((r) => r.status === 'error') || [];

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Import from another system</h2>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Export each list from your old software as a CSV file, then bring them in here in this order: <strong>patients</strong> first, then insurance, balances,
          appointments, recalls and treatment (they find patients by the ID in the old system). Columns are matched by name; check the matches before importing.
          Importing the same file again updates what's already here instead of making duplicates.
        </div>
        <ErrorBox error={runPreview.error || run.error} />
        <div className="form-grid">
          <label>
            Coming from
            <select value={source} onChange={(e) => { setSource(e.target.value); if (file) runPreview.submit(file, mapping, kind, e.target.value); }}>
              {meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name === 'previous system' ? 'Other / spreadsheet' : s.name}</option>)}
            </select>
          </label>
          <label>
            What's in the file
            <select value={kind} onChange={(e) => { setKind(e.target.value); setMapping(null); setPreview(null); if (file) runPreview.submit(file, null, e.target.value); }}>
              {meta.kinds.map((k) => <option key={k} value={k}>{KIND_INFO[k][0]}</option>)}
            </select>
          </label>
          <label className="full">
            CSV file
            <input type="file" accept=".csv,.txt,.tsv,text/csv" onChange={choose} key={result?.id || 'file'} />
          </label>
        </div>
        <div className="muted" style={{ fontSize: 13 }}>{KIND_INFO[kind][1]}</div>
        {source === 'opendental' && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Open Dental: run a User Query (e.g. <code>SELECT * FROM patient</code>) and use “Export”, or export the table from MySQL as CSV. Status codes, time patterns and recall intervals are understood as-is.</div>}
        {source === 'dentrix' && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Dentrix: use Office Manager → Letters & Custom Lists, or a report exported to Excel and saved as CSV. Chart # is used as the patient ID.</div>}
        {source === 'eaglesoft' && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Eaglesoft: use Reports → Patient/Account lists exported to CSV, or a Data Export from the Eaglesoft database.</div>}
        {source === 'curve' && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Curve: ask Curve support for your data export; their CSV columns are matched automatically.</div>}
      </div>

      {file && (
        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{file.name}</h2>
            <span className="muted">{file.rows.length.toLocaleString()} rows · {file.headers.length} columns</span>
          </div>
          {!file.headers.length ? <div className="error">That file looks empty.</div> : mapping && (
            <>
              <h3>Match the columns</h3>
              <div className="form-grid">
                {fields.map((f) => (
                  <label key={f}>
                    {FIELD_LABELS[f] || f}{REQUIRED[kind].includes(f) ? ' *' : ''}
                    <select value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? null : Number(e.target.value) })}>
                      <option value="">— not imported —</option>
                      {file.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
                <button type="button" disabled={runPreview.busy} onClick={() => runPreview.submit(file, mapping)}>{runPreview.busy ? 'Checking…' : 'Check again with these matches'}</button>
              </div>
              {preview && (
                <>
                  <h3>First {Math.min(25, file.rows.length)} rows — a dry run, nothing saved yet</h3>
                  {preview.missing.length > 0 ? <div className="error">Choose a column for: {preview.missing.map((f) => FIELD_LABELS[f] || f).join(', ')}</div> : (
                    <div className="muted" style={{ marginBottom: 8 }}>
                      {['created', 'updated', 'skipped'].map((s) => `${preview.results.filter((r) => r.status === s).length} ${s === 'created' ? 'new' : s === 'updated' ? 'already here (will update)' : 'skipped'}`).join(' · ')}
                      {errorsInPreview.length > 0 && <span style={{ color: 'var(--danger)' }}> · {errorsInPreview.length} with problems</span>}
                    </div>
                  )}
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                      <thead><tr><th>Line</th><th>Result</th>{fields.filter((f) => mapping[f] != null).slice(0, 7).map((f) => <th key={f}>{FIELD_LABELS[f] || f}</th>)}</tr></thead>
                      <tbody>
                        {preview.sample.map((row, i) => {
                          const r = preview.results[i];
                          return (
                            <tr key={i}>
                              <td>{i + 2}</td>
                              <td>{r ? (r.status === 'error' ? <span style={{ color: 'var(--danger)' }}>{r.error}</span> : <Badge value={r.status === 'created' ? 'new' : r.status} />) : '—'}</td>
                              {fields.filter((f) => mapping[f] != null).slice(0, 7).map((f) => <td key={f}>{row[f]}</td>)}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <div className="form-actions">
                {progress && <span className="muted">Importing… {progress.done.toLocaleString()} of {progress.total.toLocaleString()}</span>}
                <button className="primary" disabled={run.busy || missing.length > 0 || !file.rows.length} onClick={run.submit}>
                  {run.busy ? 'Importing…' : `Import ${file.rows.length.toLocaleString()} ${KIND_INFO[kind][0].toLowerCase()} rows`}
                </button>
              </div>
              {progress && <div className="progress"><div style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>}
            </>
          )}
        </div>
      )}

      {result && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Import finished</h2>
          <div>{result.created_count} new · {result.updated_count} updated · {result.skipped_count} skipped · <span style={{ color: result.error_count ? 'var(--danger)' : undefined }}>{result.error_count} not imported</span></div>
          {result.errors.length > 0 && (
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>Line</th><th>Problem</th></tr></thead>
              <tbody>{result.errors.slice(0, 100).map((e) => <tr key={e.line}><td>{e.line}</td><td>{e.error}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ padding: '14px 16px', margin: 0 }}>Import history</h2>
        <ErrorBox error={undo.error} />
        {!history ? <div className="empty">Loading…</div> : history.length === 0 ? <div className="empty">Nothing imported yet.</div> : (
          <table>
            <thead><tr><th>When</th><th>From</th><th>File</th><th>New</th><th>Updated</th><th>Problems</th><th>Status</th><th /></tr></thead>
            <tbody>
              {history.map((b) => (
                <tr key={b.id}>
                  <td>{fmtUtcDateTime(b.created_at, practice?.timezone)}<div className="muted">{b.created_by_name}</div></td>
                  <td>{meta.sources.find((s) => s.id === b.source)?.name}<div className="muted">{KIND_INFO[b.kind]?.[0]}</div></td>
                  <td>{b.filename}</td>
                  <td>{b.created_count}</td>
                  <td>{b.updated_count}</td>
                  <td>{b.error_count}</td>
                  <td><Badge value={b.status} /></td>
                  <td>{b.status !== 'undone' && b.created_count > 0 && <button className="small danger" disabled={undo.busy} onClick={() => undo.submit(b)}>Undo</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
