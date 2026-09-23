import { useState } from 'react';
import { api, download } from '../api.js';
import { useApi } from '../hooks.js';
import { fmtDate } from '../format.js';
import { ErrorBox, useSubmit } from './ui.jsx';

const size = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// Settings → Backups: download a backup, prove one restores, and see the automatic ones.
export default function Backups() {
  const { data: status } = useApi('/backup/status');
  const [test, setTest] = useState(null);
  const dl = useSubmit((docs) => download(`/backup${docs ? '?documents=true' : ''}`, 'dental-machine-backup.json.gz'));
  const check = useSubmit(async () => setTest(await api.post('/backup/test')));
  if (!status) return <div className="card">Loading…</div>;
  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Download a backup</h2>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          One file with everything this practice owns — patients, charts, ledgers, claims, schedules, forms, messages, settings and the audit log.
          It contains patient health information: keep it encrypted and somewhere only you control. A backup restores as a new practice on this server or a new one.
        </div>
        <ErrorBox error={dl.error} />
        <div className="inline" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="primary" disabled={dl.busy} onClick={() => dl.submit(false)}>{dl.busy ? 'Preparing…' : 'Download backup'}</button>
          <button disabled={dl.busy} onClick={() => dl.submit(true)}>Download with documents & x-rays</button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Test a restore</h2>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>Takes a fresh backup and restores it into a throwaway copy that's discarded afterwards, checking every table comes back whole. Nothing changes.</div>
        <ErrorBox error={check.error} />
        <button disabled={check.busy} onClick={check.submit}>{check.busy ? 'Restoring a test copy…' : 'Run a test restore'}</button>
        {test && (
          <div style={{ marginTop: 12 }}>
            <div className={test.ok ? 'public-notice' : 'error'}>
              {test.ok ? `✓ Restored ${test.rows.toLocaleString()} records across ${test.tables.length} tables — all present.` : 'Some records did not come back — see below and contact support.'}
            </div>
            <details style={{ marginTop: 8 }}>
              <summary className="muted">Table by table</summary>
              <table>
                <thead><tr><th>Table</th><th>Backed up</th><th>Restored</th></tr></thead>
                <tbody>{test.tables.map((t) => <tr key={t.table}><td>{t.table.replace(/_/g, ' ')}</td><td>{t.exported}</td><td style={{ color: t.exported === t.restored ? undefined : 'var(--danger)' }}>{t.restored}</td></tr>)}</tbody>
              </table>
            </details>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Automatic backups</h2>
        {status.automatic ? (
          <>
            <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
              Nightly, kept {status.keep_days} days{status.documents === false ? ', without documents' : ''}.
            </div>
            {status.files.length === 0 ? <div className="muted">The first one runs within the hour.</div> : (
              <table>
                <thead><tr><th>Date</th><th>Size</th><th /></tr></thead>
                <tbody>{status.files.map((f) => (
                  <tr key={f.name}><td>{fmtDate(f.date)}</td><td>{size(f.size)}</td><td><button className="small" onClick={() => download(`/backup/files/${f.name}`, f.name)}>Download</button></td></tr>
                ))}</tbody>
              </table>
            )}
          </>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>
            {status.database === 'postgres'
              ? 'Your database is Postgres: turn on your provider’s daily backups and point-in-time recovery (Supabase, Neon, RDS and Render all offer it), and set BACKUP_DIR on the server to also keep nightly practice files.'
              : 'Set BACKUP_DIR on the server (a mounted disk or synced folder) to keep a nightly backup of every practice and the database file.'}
            {' '}Until then, download a backup regularly and store it safely.
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Documents are stored {status.file_storage === 's3' ? 'in object storage' : 'on the server’s disk'}{status.encrypted_files ? ', encrypted' : ''}.
          To restore onto a new server: <code>node src/backupcli.js restore backup.json.gz</code>.
        </div>
      </div>
    </>
  );
}
