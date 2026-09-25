import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import ManualPage from './ManualPage.jsx';

// The whole manual on one screen, to print or to save as a PDF from the browser's print box
// (/help?how=all; &print=1 opens the print box by itself once every picture has loaded). Grouped by area,
// most frequent first, each how-to on its own page. The PDF isn't kept in the repo: this makes it on demand.
export default function ManualBook({ pages, autoPrint, onBack }) {
  const root = useRef(null);
  const [ready, setReady] = useState(false);
  const areas = [...new Set(pages.map((p) => p.area))];
  // Every picture has to be loaded before printing (the printed copy would have holes otherwise).
  useEffect(() => {
    let live = true;
    const imgs = [...(root.current?.querySelectorAll('img') || [])];
    Promise.all(imgs.map((i) => (i.complete ? null : new Promise((ok) => { i.addEventListener('load', ok, { once: true }); i.addEventListener('error', ok, { once: true }); }))))
      .then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [pages]);
  // Automated browsers (the tests) have no one to close the print box.
  useEffect(() => { if (ready && autoPrint && !navigator.webdriver) window.print(); }, [ready, autoPrint]);
  return (
    <div className="manual-book" ref={root} data-ready={ready ? '1' : '0'}>
      <div className="manual-page-bar no-print">
        <button type="button" className="small" onClick={onBack}><ArrowLeft size={14} aria-hidden /> All how-tos</button>
        <span style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 13 }}>{ready ? `${pages.length} how-tos, ready to print` : 'Loading the pictures…'}</span>
        <button type="button" className="small primary" disabled={!ready} onClick={() => window.print()}><Printer size={14} aria-hidden /> Print or save as PDF</button>
      </div>
      <section className="manual-book-cover">
        <h1>Dental Machine — How do I…?</h1>
        <p>The office user manual: {pages.length} tasks with the keys and a picture of each step, grouped by area, most frequent first.</p>
        <ol className="manual-book-toc">
          {areas.map((a) => (
            <li key={a}>
              <strong>{pages.find((p) => p.area === a).areaLabel}</strong>
              <ul>{pages.filter((p) => p.area === a).map((p) => <li key={p.id}><a href={`#${p.id}`}>{p.q}</a></li>)}</ul>
            </li>
          ))}
        </ol>
      </section>
      {areas.map((a) => (
        <section key={a} className="manual-book-area">
          <h2 className="manual-book-area-title">{pages.find((p) => p.area === a).areaLabel}</h2>
          {pages.filter((p) => p.area === a).map((p) => <ManualPage key={p.id} page={p} inBook />)}
        </section>
      ))}
    </div>
  );
}
