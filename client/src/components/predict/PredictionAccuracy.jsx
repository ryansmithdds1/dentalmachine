import { useState } from 'react';
import { useApi } from '../../hooks.js';
import { ErrorBox } from '../ui.jsx';
import './predict.css';

// Reports → Prediction accuracy: can the office trust the percentages? For the last few months, what the model would
// have said then (learning only from what came before each visit or claim) next to what actually happened.
const KINDS = [['no_show', 'No-shows & late cancellations', 'visits'], ['denial', 'Claim denials', 'claim lines']];

export default function PredictionAccuracy() {
  const [kind, setKind] = useState('no_show');
  const [months, setMonths] = useState(6);
  const { data, error, loading } = useApi(`/predict/accuracy?kind=${kind}&months=${months}`, [kind, months]);
  const { data: status } = useApi('/predict/status');
  const what = KINDS.find((k) => k[0] === kind)[2];
  const bins = (data?.bins || []).filter((b) => b.n > 0);
  return (
    <div className="card prediction-accuracy">
      <div className="inline" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div className="tabs" style={{ margin: 0 }}>
          {KINDS.map(([k, l]) => <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{l}</button>)}
        </div>
        <label className="inline" style={{ gap: 6 }}>Last
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ width: 'auto' }}>
            {[3, 6, 12].map((m) => <option key={m} value={m}>{m} months</option>)}
          </select>
        </label>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        For each {what === 'visits' ? 'visit' : 'claim line'} in this period, what the prediction would have said at the time — learning only from what came
        before it — next to what actually happened. If the percentages are right, the two columns match.
        {kind === 'denial' && ' Denials here use history only; on the claim screen the rule checks (frequencies, filing limits, missing narratives) are added too.'}
        {status && <> Predictions come from: {status.name}.</>}
      </p>
      <ErrorBox error={error} />
      {loading && !data && <div className="muted">Working it out…</div>}
      {data && (data.n === 0 ? <div className="muted">Not enough history in this period to check yet.</div> : (
        <>
          <p style={{ margin: '4px 0 10px' }}>
            <strong>{data.n.toLocaleString()}</strong> {what}: predicted <strong>{data.predicted_rate}%</strong> on average, actually <strong>{data.actual_rate}%</strong>.
            {data.trained_on < 100 && <span className="muted"> Not much history before this period ({data.trained_on} {what}), so these were mostly the usual rates for a dental office.</span>}
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
