import { useState } from 'react';
import { api } from '../api.js';
import { ErrorBox } from './ui.jsx';
import { createDumpReader } from '../conversion/sqldump.js';

// Only these columns leave the office's computer (no Social Security numbers, passwords or anything else).
const KEEP = {
  definition: ['defnum', 'category', 'itemname'],
  provider: ['provnum', 'abbr', 'lname', 'fname', 'suffix', 'issecondary', 'ishidden', 'nationalprovid'],
  operatory: ['operatorynum', 'opname', 'abbrev', 'ishidden'],
  patient: ['patnum', 'lname', 'fname', 'preferred', 'patstatus', 'gender', 'birthdate', 'address', 'address2', 'city', 'state', 'zip', 'hmphone', 'wkphone', 'wirelessphone', 'guarantor', 'email', 'priprov', 'secprov', 'medurgnote', 'baltotal'],
  carrier: ['carriernum', 'carriername', 'electid'],
  insplan: ['plannum', 'groupname', 'groupnum', 'carriernum'],
  inssub: ['inssubnum', 'plannum', 'subscriber', 'subscriberid'],
  patplan: ['patplannum', 'patnum', 'ordinal', 'relationship', 'inssubnum'],
  procedurecode: ['codenum', 'proccode', 'descript'],
  appointment: ['aptnum', 'patnum', 'aptstatus', 'pattern', 'op', 'note', 'provnum', 'provhyg', 'aptdatetime', 'procdescript', 'ishygiene'],
  procedurelog: ['procnum', 'patnum', 'aptnum', 'procdate', 'procfee', 'surf', 'toothnum', 'procstatus', 'provnum', 'codenum', 'unitqty'],
  recalltype: ['recalltypenum', 'description'],
  recall: ['recallnum', 'patnum', 'datedue', 'recallinterval', 'recalltypenum', 'isdisabled'],
  payment: ['paynum', 'paytype', 'paydate', 'payamt', 'checknum', 'patnum'],
  paysplit: ['splitnum', 'splitamt', 'patnum', 'paynum', 'provnum', 'datepay'],
  adjustment: ['adjnum', 'adjdate', 'adjamt', 'patnum', 'adjtype', 'provnum', 'adjnote'],
  claimproc: ['claimprocnum', 'patnum', 'provnum', 'inspayamt', 'writeoff', 'status', 'datecp'],
  procnote: ['procnotenum', 'patnum', 'procnum', 'entrydatetime', 'note'],
  commlog: ['commlognum', 'patnum', 'commdatetime', 'note'],
  perioexam: ['perioexamnum', 'patnum', 'examdate', 'provnum'],
  periomeasure: ['periomeasurenum', 'perioexamnum', 'sequencetype', 'inttooth', 'toothvalue', 'mbvalue', 'bvalue', 'dbvalue', 'mlvalue', 'lvalue', 'dlvalue'],
};
const TABLES = Object.keys(KEEP);

// One-step conversion from an Open Dental backup: everything, including the ledger history.
export default function FullConversion({ onDone }) {
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState(null); // { what, pct, counts }
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const start = async () => {
    setError(null);
    setResult(null);
    try {
      const batch = await api.post('/imports/opendental', { filename: file.name });
      const pending = new Map(TABLES.map((t) => [t, []]));
      const found = {};
      const flush = async (all) => {
        for (const [table, rows] of pending) {
          while (rows.length >= 1000 || (all && rows.length)) {
            await api.post(`/imports/opendental/${batch.id}/rows`, { table, rows: rows.splice(0, 1000) });
          }
        }
      };
      const reader = createDumpReader(TABLES, (t, rows) => {
        const keep = KEEP[t];
        pending.get(t).push(...rows.map((r) => Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]]))));
        found[t] = (found[t] || 0) + rows.length;
      });
      // Read the backup a piece at a time (backups run to gigabytes) and send the rows as they're found.
      const stream = file.stream().pipeThrough(new TextDecoderStream()).getReader();
      let read = 0;
      for (;;) {
        const { value, done } = await stream.read();
        if (done) break;
        reader.push(value);
        read += value.length;
        setPhase({ what: 'Reading the backup', pct: Math.min(99, Math.round((read / file.size) * 100)), counts: { ...found } });
        await flush(false);
      }
      reader.end();
      await flush(true);
      if (!found.patient) throw new Error('No patients found — is this an Open Dental backup (.sql)?');
      // The server converts it a slice at a time.
      for (;;) {
        const out = await api.post(`/imports/opendental/${batch.id}/run`, {});
        setPhase({ what: out.label, pct: out.progress, counts: found });
        if (out.done) {
          setResult(out);
          break;
        }
      }
      setPhase(null);
      onDone?.();
    } catch (e) {
      setError(e);
      setPhase(null);
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Full conversion from Open Dental</h2>
      <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
        Everything in one go from an Open Dental backup (<code>.sql</code> — Open Dental’s <em>Tools → Backup</em>, or <code>mysqldump opendental</code>):
        providers and chairs, patients and families, insurance, appointments, completed and planned work, the full ledger (charges, payments, adjustments, insurance
        payments), recalls, clinical notes, call history and perio charts. Each family’s balance ends up exactly as Open Dental showed it. The file is read here in
        your browser; only the columns needed are sent (never Social Security numbers). It can be undone from the history below.
      </div>
      <ErrorBox error={error} />
      <div className="inline" style={{ alignItems: 'center' }}>
        <input type="file" accept=".sql,.txt" disabled={!!phase} onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); }} />
        <button className="primary" disabled={!file || !!phase} onClick={start}>{phase ? 'Converting…' : 'Convert'}</button>
      </div>
      {phase && (
        <>
          <div className="muted" style={{ marginTop: 10 }}>{phase.what}… {phase.pct}%</div>
          <div className="progress"><div style={{ width: `${phase.pct}%` }} /></div>
          <div className="muted" style={{ fontSize: 12 }}>{Object.entries(phase.counts || {}).map(([t, n]) => `${t} ${n.toLocaleString()}`).join(' · ')}</div>
        </>
      )}
      {result && (
        <table className="compact-table" style={{ marginTop: 12 }}>
          <thead><tr><th>Converted</th><th className="num">New</th><th className="num">Updated</th><th className="num">Left out</th><th className="num">Problems</th></tr></thead>
          <tbody>
            {Object.entries(result.counts).map(([step, c]) => (
              <tr key={step}><td>{step.replace(/_/g, ' ')}</td><td className="num">{c.created || 0}</td><td className="num">{c.updated || 0}</td><td className="num">{c.skipped || 0}</td><td className="num">{c.errors || 0}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {result?.errors?.length > 0 && <div className="muted" style={{ fontSize: 12 }}>Last problems: {result.errors.map((e) => `${e.step}: ${e.error}`).join('; ')}</div>}
    </div>
  );
}
