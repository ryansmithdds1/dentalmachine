import { useState } from 'react';
import { Download } from 'lucide-react';
import { useApi } from '../../hooks.js';
import { download } from '../../api.js';
import { ErrorBox } from '../ui.jsx';
import { toast } from '../../toast.js';
import './predict.css';

// Reports → Prediction accuracy: can the office trust the percentages? Two ways to check, for the last few months:
//   What staff saw — the percentages people were actually shown (the schedule, Ready to approve, the claim screen…),
//                    saved when shown (server predict/log.js), against what happened. The default once there are enough.
//   Backtest       — what the model would have said then, learning only from what came before each visit or claim.
const KINDS = [['no_show', 'No-shows & late cancellations', 'visits'], ['denial', 'Claim denials', 'claim lines']];
const SOURCES = [['logged', 'What staff saw'], ['backtest', 'Backtest']];

export default function PredictionAccuracy() {
  const [kind, setKind] = useState('no_show');
  const [months, setMonths] = useState(6);
  const [picked, setPicked] = useState(null); // null: the server's choice (what staff saw when there are enough)
  const { data, error, loading } = useApi(`/predict/accuracy?kind=${kind}&months=${months}${picked ? `&source=${picked}` : ''}`, [kind, months, picked]);
  const { data: status } = useApi('/predict/status');
  const what = KINDS.find((k) => k[0] === kind)[2];
  const source = data?.source || picked || 'logged';
  const bins = (data?.bins || []).filter((b) => b.n > 0);
  const logged = data?.available?.logged;
  return (
    <div className="card prediction-accuracy">
      <div className="inline" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div className="tabs" style={{ margin: 0 }}>
          {KINDS.map(([k, l]) => <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{l}</button>)}
        </div>
        <div className="accuracy-source" role="group" aria-labelledby="accuracy-source-label">
          <span id="accuracy-source-label" className="muted">Compare:</span>
          {SOURCES.map(([k, l]) => <button key={k} type="button" className={`small${source === k ? ' primary' : ''}`} aria-pressed={source === k} onClick={() => setPicked(k)} data-accuracy-source={k}>{l}</button>)}
        </div>
        <label className="inline" style={{ gap: 6 }}>Last
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ width: 'auto' }}>
            {[3, 6, 12].map((m) => <option key={m} value={m}>{m} months</option>)}
          </select>
        </label>
        <button type="button" className="small" onClick={() => download(`/predict/log.csv?kind=${kind}&months=${months}`, `predictions-${kind}.csv`).catch((err) => toast(err.message, { tone: 'error' }))} title="Every prediction staff were shown in this period, with what happened (a spreadsheet)">
          <Download size={14} aria-hidden="true" /> What staff saw (CSV)
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {source === 'logged' ? (
          <>For each {what === 'visits' ? 'visit' : 'claim line'} whose outcome is known, the last percentage the team was shown for it — on the schedule, the visit, Ready to approve or the claim — next to what actually happened.</>
        ) : (
          <>For each {what === 'visits' ? 'visit' : 'claim line'} in this period, what the prediction would have said at the time — learning only from what came
          before it — next to what actually happened.{kind === 'denial' && ' Denials here use history only; on the claim screen the rule checks (frequencies, filing limits, missing narratives) are added too.'}</>
        )}
        {' '}If the percentages are right, the two columns match.
        {status && <> Predictions come from: {status.name}.</>}
      </p>
      {data && !picked && source === 'backtest' && logged != null && (
        <p className="muted" style={{ fontSize: 12, marginTop: -4 }} data-accuracy-note="few-logged">
          Showing the backtest: {logged ? `only ${logged}` : 'no'} {what} shown to staff have an outcome yet in this period ({data.available.min_logged} needed for “What staff saw”).
        </p>
      )}
      <ErrorBox error={error} />
      {loading && !data && <div className="muted">Working it out…</div>}
      {data && (data.n === 0 ? <div className="muted">{source === 'logged' ? `No ${what} shown to staff in this period have an outcome yet.` : 'Not enough history in this period to check yet.'}</div> : (
        <>
          <p style={{ margin: '4px 0 10px' }}>
            <strong>{data.n.toLocaleString()}</strong> {what}: predicted <strong>{data.predicted_rate}%</strong> on average, actually <strong>{data.actual_rate}%</strong>.
            {source === 'backtest' && data.trained_on < 100 && <span className="muted"> Not much history before this period ({data.trained_on} {what}), so these were mostly the usual rates for a dental office.</span>}
            {source === 'logged' && data.claims?.n > 0 && <span className="muted"> Whole claims: said {data.claims.predicted_rate}% on average that something would be denied; it was, for {data.claims.actual_rate}% of {data.claims.n.toLocaleString()}.</span>}
          </p>
          <div className="table-wrap">
            <table className="accuracy-table">
              <thead><tr><th>We said</th><th className="num">{what === 'visits' ? 'Visits' : 'Lines'}</th><th className="num">Predicted (avg)</th><th className="num">Actually happened</th><th>Match</th></tr></thead>
              <tbody>
                {bins.map((b) => (
                  <tr key={b.from} data-bin={b.from}>
                    <td>{b.from}–{b.to}%</td>
                    <td className="num">{b.n.toLocaleString()}</td>
                    <td className="num">{b.predicted}%</td>
                    <td className="num">{b.actual}%</td>
                    <td><div className="accuracy-bar" title={`Predicted ${b.predicted}%, happened ${b.actual}%`}><i style={{ width: `${Math.min(100, b.actual)}%` }} /><b style={{ left: `${Math.min(99, b.predicted)}%` }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>The line marks what was predicted; the shaded bar is what happened. Predictions inform the team — nothing is cancelled, moved or held because of them.</p>
        </>
      ))}
    </div>
  );
}
