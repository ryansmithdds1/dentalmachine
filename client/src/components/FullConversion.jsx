import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleCheck, CircleCheckBig, Cloud, Database, FileArchive, HardDrive, LoaderCircle, RotateCcw, Server, TriangleAlert, UploadCloud } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox } from './ui.jsx';
import { createDumpReader } from '../conversion/sqldump.js';
import { readExport, chunkRows } from '../conversion/exportzip.js';
import './conversion.css';

// Open Dental: only these columns leave the office's computer (no Social Security numbers, passwords or anything else).
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
const OD_TABLES = Object.keys(KEEP);
const OD_LABEL = {
  definition: 'Lists and types', provider: 'Providers', operatory: 'Chairs', patient: 'Patients', carrier: 'Insurance carriers', insplan: 'Insurance plans', inssub: 'Subscribers',
  patplan: 'Insurance policies', procedurecode: 'Procedure codes', appointment: 'Appointments', procedurelog: 'Procedures', recalltype: 'Recall types', recall: 'Recall',
  payment: 'Payments', paysplit: 'Payment splits', adjustment: 'Adjustments', claimproc: 'Insurance payments', procnote: 'Clinical notes', commlog: 'Communication history',
  perioexam: 'Perio exams', periomeasure: 'Perio readings',
};

const SOURCES = [
  { id: 'opendental', name: 'Open Dental', icon: Database, blurb: 'From a database backup (.sql). Brings the full ledger history.' },
  { id: 'dentrix', name: 'Dentrix', icon: HardDrive, blurb: 'From the Office Manager / Data Extract lists, zipped.' },
  { id: 'eaglesoft', name: 'Eaglesoft', icon: Server, blurb: 'From Patterson’s data export (CSV files), zipped.' },
  { id: 'curve', name: 'Curve', icon: Cloud, blurb: 'From Curve Hero’s data export (.zip of JSON or CSV).' },
];
const OD_HOWTO = [
  'In Open Dental, go to Tools → Backup (or ask your IT person to run mysqldump opendental > backup.sql).',
  'Copy the .sql backup file to this computer.',
  'Drop it here. It’s read here in your browser — only the columns we need are sent, never Social Security numbers.',
];
const STEP_NAMES = ['Choose your old system', 'Upload the export', 'Check (dry run)', 'Import', 'Done'];
const RUN_STEPS = ['providers', 'operatories', 'patients', 'guarantors', 'insurance', 'appointments', 'procedures', 'recalls', 'notes', 'perio', 'balances'];

const money = (c) => `${c < 0 ? '−' : ''}$${(Math.abs(c || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n = (x) => Number(x || 0).toLocaleString();
const count = (rows, step, word) => {
  const k = rows.find((r) => r.step === step)?.brought || 0;
  return `${n(k)} ${word}${k === 1 ? '' : 's'}`;
};

function Steps({ at }) {
  return (
    <ol className="conv-steps" aria-label="Conversion steps">
      {STEP_NAMES.map((s, i) => (
        <li key={s} className={i === at ? 'on' : i < at ? 'done' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="n">{i < at ? '✓' : i + 1}</span>{s}
        </li>
      ))}
    </ol>
  );
}

function DropZone({ accept, onFile, label }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const take = (f) => f && onFile(f);
  return (
    <div
      className={`conv-drop${over ? ' over' : ''}`} role="button" tabIndex={0} aria-label={label}
      onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); }}
    >
      <UploadCloud size={34} className="icon" />
      <strong>{label}</strong>
      <span>or click to choose the file ({accept})</span>
      <input ref={input} type="file" accept={accept} hidden data-testid="conversion-file" onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}

function Reasons({ reasons }) {
  if (!reasons?.length) return null;
  return (
    <details>
      <summary>Why {reasons.reduce((t, r) => t + r.count, 0) === 1 ? 'one was' : 'some were'} left out</summary>
      <ul>
        {reasons.map((r) => (
          <li key={r.reason}>{r.reason} — {n(r.count)}{r.examples?.length ? <span className="ex"> (e.g. {r.examples.slice(0, 3).join('; ')})</span> : null}</li>
        ))}
      </ul>
    </details>
  );
}

// The dry run: what would happen to each kind of record, the A/R, and anything that needs a decision.
function Review({ source, dry, choices, setChoices, dirty }) {
  const files = dry.files || [];
  const read = files.filter((f) => f.table);
  const ignored = files.filter((f) => !f.table);
  const groups = {};
  for (const u of dry.unmapped) (groups[u.label] ||= []).push(u);
  const set = (u, value) => setChoices((c) => ({ ...c, [u.kind]: { ...(c[u.kind] || {}), [u.value.toLowerCase()]: value } }));
  const chosen = (u) => choices[u.kind]?.[u.value.toLowerCase()] ?? u.chosen ?? '';
  const ar = dry.ar;
  const patients = dry.steps.find((s) => s.step === 'patients');
  return (
    <>
      <div className="conv-stats">
        <div className="conv-stat"><div className="k">Patients to bring over</div><div className="v">{n((patients?.created || 0) + (patients?.updated || 0))}</div></div>
        <div className="conv-stat"><div className="k">Accounts receivable in {source}</div><div className="v">{money(ar.source)}</div></div>
        <div className={`conv-stat ${ar.source === ar.placed ? 'ok' : 'warn'}`}><div className="k">Balance forward to post ({n(ar.families)} {ar.families === 1 ? 'family' : 'families'})</div><div className="v">{money(ar.placed)}</div></div>
        <div className={`conv-stat ${dry.unmapped.length ? 'warn' : 'ok'}`}><div className="k">Values to map</div><div className="v">{n(dry.unmapped.length)}</div></div>
      </div>

      <div className="conv-section">
        <h3>What would be brought over <span className="count">nothing has been saved yet</span></h3>
        <div className="conv-wrap">
          <table className="conv-table">
            <thead><tr><th>Records</th><th className="num">In {source}</th><th className="num">New</th><th className="num">Updates</th><th className="num">Left out</th><th className="num">Problems</th></tr></thead>
            <tbody>
              {dry.steps.map((s) => (
                <tr key={s.step} className={s.source ? '' : 'muted-row'}>
                  <td>{s.label}<Reasons reasons={s.reasons} /></td>
                  <td className="num">{n(s.source)}</td><td className="num">{n(s.created)}</td><td className="num">{n(s.updated)}</td>
                  <td className="num">{s.skipped ? <span className="conv-chip warn">{n(s.skipped)}</span> : 0}</td>
                  <td className="num">{s.errors ? <span className="conv-chip bad">{n(s.errors)}</span> : 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Balances: {ar.basis === 'ledger' ? `added up from ${source}’s ledger by transaction type` : ar.basis === 'balances' ? `taken from ${source}’s account balances` : 'none found in the export'}.
          Each family gets one “balance forward” on the guarantor; past charges and payments aren’t posted again. Completed treatment comes over as history, without charges.
          {ar.unplaced?.length > 0 && <> {money(ar.source - ar.placed)} is on accounts that can’t be placed ({ar.unplaced.slice(0, 5).map((u) => `${u.ref || 'blank'} ${money(u.cents)}`).join(', ')}{ar.unplaced.length > 5 ? '…' : ''}).</>}
        </div>
      </div>

      {dry.unmapped.length > 0 && (
        <div className="conv-section">
          <h3><TriangleAlert size={16} color="var(--warn)" /> Values we couldn’t match <span className="count">choose what each means, then check again</span></h3>
          <div className="conv-map">
            <p>These appear in the export but don’t match anything we know. Nothing is dropped silently: until you choose, each uses the fallback shown.</p>
            <table className="conv-table">
              <thead><tr><th>Kind</th><th>In {source}</th><th className="num">Rows</th><th>Bring over as</th></tr></thead>
              <tbody>
                {Object.entries(groups).flatMap(([label, list]) => list.map((u) => (
                  <tr key={`${u.kind}|${u.value}`}>
                    <td>{label}</td>
                    <td><code>{u.value}</code></td>
                    <td className="num">{n(u.count)}</td>
                    <td>
                      {u.choices ? (
                        <select aria-label={`${label} ${u.value}`} value={chosen(u)} onChange={(e) => set(u, e.target.value)}>
                          <option value="">Fallback: {u.fallback}</option>
                          {u.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                      ) : (
                        <input aria-label={`${label} ${u.value}`} placeholder="CDT code, e.g. D4910, or skip" value={chosen(u)} onChange={(e) => set(u, e.target.value.trim())} />
                      )}
                      {!chosen(u) && <div className="fallback">Until you choose: {u.fallback}</div>}
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
            {dirty && <p style={{ margin: '10px 0 0' }}><strong>You changed some choices — check again to see the result before importing.</strong></p>}
          </div>
        </div>
      )}

      <div className="conv-section">
        <h3>Files in the export <span className="count">{read.length} read{ignored.length ? `, ${ignored.length} not used` : ''}</span></h3>
        <div className="conv-files">
          {files.map((f) => (
            <div className="conv-file" key={f.name} title={f.dropped?.length ? `Columns not used: ${f.dropped.join(', ')}` : ''}>
              <FileArchive size={14} color="var(--faint)" />
              <span className="name">{f.name}</span>
              {f.table ? <><span className="rows">{n(f.rows)} row{f.rows === 1 ? '' : 's'}</span><span className="conv-chip">{f.label}</span></> : <span className="conv-chip off">Not a file we read</span>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Reconciliation({ source, result }) {
  const rows = result.reconcile.rows;
  const ar = result.reconcile.ar;
  const left = rows.reduce((t, r) => t + r.left, 0);
  const good = !left && ar.matches && ar.source === ar.placed;
  return (
    <>
      <div className={`conv-success${good ? '' : ' warn'}`} role="status">
        {good ? <CircleCheckBig size={40} className="big" /> : <TriangleAlert size={40} className="big" />}
        <div>
          <h3>{good ? `Everything from ${source} is here` : `Conversion finished — ${n(left)} record${left === 1 ? '' : 's'} need a look`}</h3>
          <p>
            {count(rows, 'patients', 'patient')}, {count(rows, 'appointments', 'appointment')} and {count(rows, 'procedures', 'treatment record')} came over.
            {!good && ' What was left out is listed below and in Needs attention.'} It can be undone from the history below until the records are used.
          </p>
        </div>
      </div>
      <div className="conv-section">
        <h3>Reconciliation <span className="count">{source} against Dental Machine</span></h3>
        <div className="conv-wrap">
          <table className="conv-table">
            <thead><tr><th>Records</th><th className="num">In {source}</th><th className="num">Brought over</th><th className="num">Left out</th><th className="num">From {source} in Dental Machine now</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.step} className={r.source ? '' : 'muted-row'}>
                  <td>{r.label}<Reasons reasons={result.counts[r.step]?.reasons} /></td>
                  <td className="num">{n(r.source)}</td><td className="num">{n(r.brought)}</td>
                  <td className="num">{r.left ? <span className="conv-chip warn">{n(r.left)}</span> : 0}</td>
                  <td className="num">{r.in_system == null ? '—' : n(r.in_system)}</td>
                  <td>{r.balanced ? <span className="conv-chip ok">Adds up</span> : <span className="conv-chip bad">Check</span>}</td>
                </tr>
              ))}
              <tr>
                <td><strong>Accounts receivable</strong><div className="muted" style={{ fontSize: 12 }}>{ar.source !== ar.placed ? `${money(ar.source - ar.placed)} was on accounts that couldn’t be placed` : 'Balance forward per family, on the guarantor'}</div></td>
                <td className="num">{money(ar.source)}</td><td className="num">{money(ar.posted)}</td>
                <td className="num">{ar.source !== ar.placed ? <span className="conv-chip warn">{money(ar.source - ar.placed)}</span> : money(0)}</td>
                <td className="num">{money(ar.posted)}</td>
                <td>{ar.matches ? <span className="conv-chip ok">Matches</span> : <span className="conv-chip bad">Doesn’t match</span>}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// Settings → Import from another system: the whole practice from Open Dental, Dentrix, Eaglesoft or Curve.
export default function FullConversion({ onDone }) {
  // Instructions for each system come from the server (the same text the conversion modules document).
  const { data: meta } = useApi('/imports/convert/sources');
  const [source, setSource] = useState(null);
  const [phase, setPhase] = useState('pick'); // pick · upload · busy · review · importing · done
  const [busy, setBusy] = useState(null); // { what, pct }
  const [batch, setBatch] = useState(null);
  const [dry, setDry] = useState(null);
  const [choices, setChoices] = useState({});
  const [dirty, setDirty] = useState(false);
  const [found, setFound] = useState(null); // Open Dental: rows found per table
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const vendor = meta?.sources?.find((s) => s.id === source);
  const name = SOURCES.find((s) => s.id === source)?.name;

  const reset = async () => {
    if (batch && phase === 'review' && source !== 'opendental') await api.post(`/imports/convert/${batch.id}/cancel`).catch(() => { /* already closed — nothing to clean up */ });
    setSource(null); setPhase('pick'); setBatch(null); setDry(null); setChoices({}); setDirty(false); setFound(null); setProgress(null); setResult(null); setError(null); setBusy(null);
  };
  const fail = (e, back = 'upload') => { setError(e); setBusy(null); setPhase(back); };

  // ---- Dentrix, Eaglesoft, Curve: unzip here, send only the columns we use, then the dry run ----
  const takeZip = async (file) => {
    setError(null);
    setPhase('busy');
    try {
      setBusy({ what: `Opening ${file.name}`, pct: 2 });
      const { files } = await readExport(await file.arrayBuffer());
      if (!files.length) throw new Error('No CSV, text or JSON files were found in this zip.');
      const b = await api.post('/imports/convert', { source, filename: file.name, files: files.map((f) => ({ name: f.name, headers: f.headers })) });
      setBatch(b);
      const plans = b.files.filter((f) => f.table);
      const total = plans.reduce((t, p) => t + (files.find((f) => f.name === p.name)?.rows.length || 0), 0) || 1;
      let sent = 0;
      for (const [i, plan] of plans.entries()) {
        const f = files.find((x) => x.name === plan.name);
        const headers = plan.keep.map((j) => f.headers[j]);
        for (const part of chunkRows(f.rows.map((r) => plan.keep.map((j) => r[j] ?? '')))) {
          await api.post(`/imports/convert/${b.id}/rows`, { file: plan.name, table: plan.table, headers, rows: part });
          sent += part.length;
          setBusy({ what: `Sending ${plan.label.toLowerCase()} (${i + 1} of ${plans.length} files)`, pct: Math.min(90, 5 + Math.round((sent / total) * 85)) });
        }
      }
      setBusy({ what: 'Checking every record (dry run — nothing is saved)', pct: 95 });
      setDry(await api.post(`/imports/convert/${b.id}/check`, {}));
      setBusy(null);
      setPhase('review');
    } catch (e) {
      fail(e);
    }
  };

  const recheck = async () => {
    setError(null);
    try {
      setBusy({ what: 'Checking again with your choices', pct: 50 });
      setDry(await api.post(`/imports/convert/${batch.id}/check`, { mapping: choices }));
      setDirty(false);
    } catch (e) {
      setError(e);
    }
    setBusy(null);
  };

  const runImport = async () => {
    setError(null);
    setPhase('importing');
    try {
      for (let pass = 0; ; pass++) {
        const out = await api.post(`/imports/convert/${batch.id}/run`, { pass });
        setProgress(out);
        if (out.done) {
          setResult(out);
          setPhase('done');
          onDone?.();
          return;
        }
      }
    } catch (e) {
      fail(e, 'review');
    }
  };

  // ---- Open Dental: read the backup here, then convert on the server ----
  const takeDump = async (file) => {
    setError(null);
    setPhase('busy');
    try {
      const b = await api.post('/imports/opendental', { filename: file.name });
      setBatch(b);
      const pending = new Map(OD_TABLES.map((t) => [t, []]));
      const counts = {};
      const flush = async (all) => {
        for (const [table, rows] of pending) {
          while (rows.length >= 1000 || (all && rows.length)) await api.post(`/imports/opendental/${b.id}/rows`, { table, rows: rows.splice(0, 1000) });
        }
      };
      const reader = createDumpReader(OD_TABLES, (t, rows) => {
        const keep = KEEP[t];
        pending.get(t).push(...rows.map((r) => Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]]))));
        counts[t] = (counts[t] || 0) + rows.length;
      });
      // Backups run to gigabytes: read a piece at a time and send rows as they're found.
      const stream = file.stream().pipeThrough(new TextDecoderStream()).getReader();
      let read = 0;
      for (;;) {
        const { value, done } = await stream.read();
        if (done) break;
        reader.push(value);
        read += value.length;
        setBusy({ what: 'Reading the backup', pct: Math.min(99, Math.round((read / file.size) * 100)) });
        await flush(false);
      }
      reader.end();
      await flush(true);
      if (!counts.patient) throw new Error('No patients found — is this an Open Dental backup (.sql)?');
      setFound(counts);
      setBusy(null);
      setPhase('review');
    } catch (e) {
      fail(e);
    }
  };

  const runOpenDental = async () => {
    setError(null);
    setPhase('importing');
    try {
      for (let pass = 0; ; pass++) {
        const out = await api.post(`/imports/opendental/${batch.id}/run`, { pass });
        setProgress({ ...out, label: out.label });
        if (out.done) {
          setResult(out);
          setPhase('done');
          onDone?.();
          return;
        }
      }
    } catch (e) {
      fail(e, 'review');
    }
  };

  const at = phase === 'pick' ? 0 : phase === 'upload' || phase === 'busy' ? 1 : phase === 'review' ? 2 : phase === 'importing' ? 3 : 4;
  const howTo = source === 'opendental' ? OD_HOWTO : vendor?.howTo || [];

  return (
    <div className="card conv" data-testid="full-conversion">
      <div className="conv-head">
        <h2>Bring your practice over from another system</h2>
        <p>Providers, chairs, patients and families, insurance, appointments, completed and planned treatment, recall, clinical notes, perio charts and each family’s balance — checked first, then imported, then reconciled.</p>
        <Steps at={at} />
      </div>
      <div className="conv-body">
        <ErrorBox error={error} />

        {phase === 'pick' && (
          <div className="conv-sources">
            {SOURCES.map((s) => (
              <button key={s.id} type="button" className="conv-source" onClick={() => { setSource(s.id); setPhase('upload'); setError(null); }}>
                <span className="logo"><s.icon size={18} /></span>
                <strong>{s.name}</strong>
                <span>{s.blurb}</span>
              </button>
            ))}
          </div>
        )}

        {(phase === 'upload' || phase === 'busy') && (
          <div className="conv-grid">
            <div className="conv-howto">
              <h3>Export from {name}</h3>
              <ol>{howTo.map((h) => <li key={h}>{h}</li>)}</ol>
              <div className="fine">
                {source === 'opendental'
                  ? 'Ledger history (charges, payments, adjustments, insurance payments) comes over in full, and each family ends at exactly Open Dental’s balance.'
                  : 'The zip is opened here in your browser. Only the columns we use are sent — Social Security numbers and anything else we don’t use never leave this computer.'}
              </div>
            </div>
            <div>
              {phase === 'upload' && (
                <DropZone accept={source === 'opendental' ? '.sql,.txt' : '.zip'} label={source === 'opendental' ? 'Drop the Open Dental backup here' : `Drop the ${name} export (.zip) here`} onFile={source === 'opendental' ? takeDump : takeZip} />
              )}
              {busy && (
                <div aria-live="polite">
                  <div className="conv-busy"><LoaderCircle size={18} className="conv-spin" /> {busy.what}…</div>
                  <div className="conv-bar"><div style={{ width: `${busy.pct}%` }} /></div>
                </div>
              )}
              {phase === 'upload' && (
                <div className="conv-actions"><button type="button" onClick={reset}><ArrowLeft size={15} /> Choose another system</button></div>
              )}
            </div>
          </div>
        )}

        {phase === 'review' && source !== 'opendental' && dry && (
          <>
            <Review source={name} dry={dry} choices={choices} setChoices={(f) => { setChoices(f); setDirty(true); }} dirty={dirty} />
            {busy && <div className="conv-busy"><LoaderCircle size={18} className="conv-spin" /> {busy.what}…</div>}
            <div className="conv-actions">
              <button type="button" onClick={reset}><RotateCcw size={15} /> Start over</button>
              <span className="spacer" />
              {dry.unmapped.length > 0 && <button type="button" disabled={!!busy} onClick={recheck}>Check again</button>}
              <button type="button" className="primary" disabled={dirty || !!busy} onClick={runImport}>Import from {name} <ArrowRight size={15} /></button>
            </div>
          </>
        )}

        {phase === 'review' && source === 'opendental' && found && (
          <>
            <div className="conv-section" style={{ marginTop: 0 }}>
              <h3>Found in the backup <span className="count">read and ready — nothing has been saved yet</span></h3>
              <div className="conv-wrap">
                <table className="conv-table">
                  <thead><tr><th>Records</th><th className="num">Rows</th></tr></thead>
                  <tbody>{OD_TABLES.filter((t) => found[t]).map((t) => <tr key={t}><td>{OD_LABEL[t]}</td><td className="num">{n(found[t])}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
            <div className="conv-actions">
              <button type="button" onClick={reset}><RotateCcw size={15} /> Start over</button>
              <span className="spacer" />
              <button type="button" className="primary" onClick={runOpenDental}>Import from Open Dental <ArrowRight size={15} /></button>
            </div>
          </>
        )}

        {phase === 'importing' && (
          <div aria-live="polite">
            <div className="conv-busy"><LoaderCircle size={18} className="conv-spin" /> Importing: {progress?.label || 'starting'}…</div>
            <div className="conv-bar"><div style={{ width: `${progress?.progress || 2}%` }} /></div>
            {source !== 'opendental' && (
              <ul className="conv-checklist">
                {RUN_STEPS.map((s, i) => {
                  const now = ['cleanup', 'done'].includes(progress?.step) ? RUN_STEPS.length : Math.max(0, RUN_STEPS.indexOf(progress?.step || 'providers'));
                  const state = i < now ? 'done' : i === now ? 'now' : '';
                  const c = progress?.counts?.[s];
                  return (
                    <li key={s} className={state}>
                      {state === 'now' ? <LoaderCircle size={15} className="conv-spin" /> : <CircleCheck size={15} />}
                      {dry?.steps.find((x) => x.step === s)?.label || s}{c ? ` · ${n(c.created + c.updated + c.unchanged)}` : ''}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {phase === 'done' && result && (
          <>
            {result.reconcile ? <Reconciliation source={name} result={result} /> : (
              <>
                <div className="conv-success" role="status">
                  <CircleCheckBig size={40} className="big" />
                  <div><h3>Open Dental conversion finished</h3><p>Each family’s balance now matches Open Dental. It can be undone from the history below until the records are used.</p></div>
                </div>
                <div className="conv-section">
                  <div className="conv-wrap">
                    <table className="conv-table">
                      <thead><tr><th>Converted</th><th className="num">New</th><th className="num">Updated</th><th className="num">Left out</th><th className="num">Problems</th></tr></thead>
                      <tbody>
                        {Object.entries(result.counts).map(([s, c]) => (
                          <tr key={s}><td>{s.replace(/_/g, ' ')}</td><td className="num">{n(c.created)}</td><td className="num">{n(c.updated)}</td><td className="num">{n(c.skipped)}</td><td className="num">{n(c.errors)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {result.errors?.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Last problems: {result.errors.map((e) => `${e.step}: ${e.error}`).join('; ')}</div>}
                </div>
              </>
            )}
            <div className="conv-actions"><span className="spacer" /><button type="button" onClick={reset}>Convert another export</button></div>
          </>
        )}
      </div>
    </div>
  );
}
