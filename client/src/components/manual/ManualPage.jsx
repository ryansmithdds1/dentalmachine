import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Printer, Keyboard, ExternalLink } from 'lucide-react';
import { roleLabel } from './manualData.js';

// One "How do I…?" page: who, where, what it's for, the numbered steps with their keys and screenshots, the mouse
// way, tips, what to do when it goes wrong, and related pages. "(A086)" in the text links to that page.
function Text({ children }) {
  const parts = String(children || '').split(/\b(A\d{3})\b/);
  return parts.map((t, i) => (i % 2 ? <Link key={i} to={`/help?how=${t}`}>{t}</Link> : <Fragment key={i}>{t}</Fragment>));
}

const Keys = ({ keys }) => (
  <span className="manual-keys">
    {keys.map((k, i) => (k.t
      ? <span key={i}>type “{k.t}”</span>
      : <span key={i}>{k.k.split(' ').map((x, j) => <kbd key={j}>{x}</kbd>)}{k.n ? ` ×${k.n}` : ''}</span>))}
  </span>
);

const Shot = ({ img, alt, eager }) => (
  <a href={`/manual/${img}`} target="_blank" rel="noreferrer" className="manual-shot" title="Open the full-size picture">
    <img src={`/manual/${img}`} alt={alt} loading={eager ? 'eager' : 'lazy'} width="1000" height="643" />
  </a>
);

// `inBook`: one page of the whole printed manual (no buttons or related links; pictures load at once for print).
export default function ManualPage({ page: p, onBack, inBook }) {
  const titleId = inBook ? `manual-title-${p.id}` : 'manual-title';
  return (
    <article className={`manual-page${inBook ? ' manual-book-page' : ''}`} aria-labelledby={titleId} id={inBook ? p.id : undefined}>
      {!inBook && <div className="manual-page-bar no-print">
        <button type="button" className="small" onClick={onBack}><ArrowLeft size={14} aria-hidden /> All how-tos</button>
        <span style={{ flex: 1 }} />
        {p.to && <Link to={p.to}><button type="button" className="small">Go there <ExternalLink size={13} aria-hidden /></button></Link>}
        <button type="button" className="small" onClick={() => window.print()}><Printer size={14} aria-hidden /> Print this page</button>
      </div>}
      <h1 id={titleId}>{p.q}</h1>
      <div className="manual-meta">
        <span><strong>Who:</strong> {p.roles.map(roleLabel).join(', ')}</span>
        <span><strong>Where:</strong> {p.where}</span>
        <span><strong>How often:</strong> {p.often}</span>
        {p.keyboard && <span className="manual-kbd-only"><Keyboard size={14} aria-hidden /> Keyboard only</span>}
      </div>
      {p.what && <p className="manual-what"><Text>{p.what}</Text></p>}
      {p.robot?.status === 'partial' && <p className="muted manual-note">The screenshot robot stopped part-way through this one, so the last steps may be missing.</p>}
      {p.robot?.status === 'notes' && <p className="muted manual-note">These steps are written by hand{p.robot.why ? ` — the screenshot robot can’t do this one (${p.robot.why.replace(/[.:]$/, '')})` : ''}.</p>}
      {p.start?.img && (
        <figure className="manual-start">
          <figcaption>Where to start{p.start.text ? <>: <Text>{p.start.text}</Text></> : ''}</figcaption>
          <Shot img={p.start.img} alt="Where to start" eager={inBook} />
        </figure>
      )}
      <h2>Steps</h2>
      <ol className="manual-steps">
        {p.steps.map((s, i) => (
          <li key={i}>
            <p><Text>{s.text}</Text></p>
            {s.keys?.length > 0 && <p className="manual-step-keys">Keys: <Keys keys={s.keys} /></p>}
            {s.img && <Shot img={s.img} alt={`Step ${i + 1}: ${s.text}`} eager={inBook} />}
          </li>
        ))}
      </ol>
      {p.mouse && <><h2>With the mouse</h2><p><Text>{p.mouse}</Text></p></>}
      {p.tips?.length > 0 && <><h2>Tips</h2><ul>{p.tips.map((t, i) => <li key={i}><Text>{t}</Text></li>)}</ul></>}
      {p.problems?.length > 0 && (
        <>
          <h2>If something goes wrong</h2>
          <dl className="manual-problems">
            {p.problems.map((x, i) => <div key={i}><dt>{x.p}</dt><dd><Text>{x.fix}</Text></dd></div>)}
          </dl>
        </>
      )}
      {!inBook && p.related?.length > 0 && (
        <div className="no-print">
          <h2>Related</h2>
          <ul>{p.related.map((r) => <li key={r.id}><Link to={`/help?how=${r.id}`}>{r.q}</Link></li>)}</ul>
        </div>
      )}
      <p className="muted manual-foot">Action {p.id}{p.robot?.at ? ` · screenshots from the robot run of ${p.robot.at.slice(0, 10)}` : ''}</p>
    </article>
  );
}
