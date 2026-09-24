import { useCallback, useEffect, useRef, useState } from 'react';
import { Tablet, Hourglass, PlayCircle, CheckCircle2 } from 'lucide-react';
import { getToken, setToken } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { useLang, setLang, suggestLang } from './i18n.js';
import { usePT } from './paperwork-i18n.js';
import { PaperworkFlow } from './Paperwork.jsx';
import './paperwork.css';

// The office iPad in kiosk mode (/kiosk). Staff set it up once (signed in as an administrator); after that it
// holds only its own kiosk token — no staff session — and waits on a friendly home screen. When someone at the
// desk or chair presses "Hand iPad" for a patient, their forms (or an education page) appear here with no
// searching and no birth-date step. It clears itself when they finish, or after a minute and a half untouched.
// For a locked-down iPad, turn on Guided Access (iPadOS Settings → Accessibility) with this page open.
const KEY = 'dm_forms_kiosk';
const POLL_MS = 3000;
const IDLE_MS = 90_000;
const WARN_S = 20;
const readKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };

async function kioskCall(method, path, body) {
  const res = await fetch(`/api/public${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Kiosk-Token': readKey() }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, details: data.details });
  return data;
}

export default function Kiosk() {
  const [paired, setPaired] = useState(() => !!readKey());
  if (!paired) return <Setup onPaired={() => setPaired(true)} />;
  return <KioskHome onUnpaired={() => setPaired(false)} />;
}

function Setup({ onPaired }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const signedIn = !!getToken();
  const pair = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/forms-kiosks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ name }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      localStorage.setItem(KEY, data.token);
      // The iPad goes to patients: it must not stay signed in as a person.
      setToken(null);
      onPaired();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="kiosk">
      <div className="kiosk-home">
        <Tablet size={56} strokeWidth={1.4} />
        <h1>Set up this iPad for patient forms</h1>
        {signedIn ? (
          <form onSubmit={pair} className="kiosk-setup">
            <label className="pw-field"><span className="pw-qlabel">Name this iPad</span><input autoFocus placeholder="Front desk iPad, Op 2…" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <ErrorBox error={error} />
            <button className="pw-primary" disabled={busy || !name.trim()}>Make this iPad a forms kiosk</button>
            <p className="pw-p">This signs the iPad out of your account. It will only show the forms the team hands to it.</p>
          </form>
        ) : (
          <p className="pw-lead">Sign in on this iPad as an administrator, then open this page again (<code>/kiosk</code>).</p>
        )}
      </div>
    </div>
  );
}

function KioskHome({ onUnpaired }) {
  const pt = usePT();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [finished, setFinished] = useState(false);
  const finishedRef = useRef(false);
  finishedRef.current = finished;
  const [warn, setWarn] = useState(0);
  const sessionId = state?.session?.id ?? null;
  const lastTouch = useRef(Date.now());
  const ended = useRef(new Set());

  const poll = useCallback(async () => {
    try {
      const s = await kioskCall('GET', '/forms-kiosk/current');
      setError(null);
      setState((prev) => {
        // The thank-you stays up until it times out, even though the server has already closed the session.
        if (!s.session && prev?.session && finishedRef.current) return prev;
        // A new patient: start fresh in their language.
        if (s.session && s.session.id !== prev?.session?.id) { lastTouch.current = Date.now(); setFinished(false); suggestLang(s.session.language || s.session.lang); setLang(s.session.language === 'es' ? 'es' : 'en'); }
        return s;
      });
    } catch (e) {
      if (e.status === 401) { try { localStorage.removeItem(KEY); } catch { /* ignore */ } onUnpaired(); return; }
      setError(e);
    }
  }, [onUnpaired]);
  useEffect(() => { poll(); const t = setInterval(poll, POLL_MS); return () => clearInterval(t); }, [poll]);

  const end = useCallback(async (reason) => {
    if (!sessionId || ended.current.has(sessionId)) return;
    ended.current.add(sessionId);
    try { await kioskCall('POST', `/forms-kiosk/sessions/${sessionId}/end`, { reason }); } catch { /* the server ends it on its own when it runs out */ }
    setState((s) => ({ ...s, session: null }));
    setFinished(false);
    setWarn(0);
    setLang('en');
    window.scrollTo(0, 0);
  }, [sessionId]);

  // Idle: after a minute and a half untouched, a 20-second "still there?" and then it clears for privacy.
  useEffect(() => {
    if (!sessionId) return undefined;
    const touch = () => { lastTouch.current = Date.now(); setWarn(0); };
    const events = ['pointerdown', 'keydown', 'input', 'scroll'];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }));
    const t = setInterval(() => {
      const idle = Date.now() - lastTouch.current;
      if (idle > IDLE_MS + WARN_S * 1000) end('idle');
      else if (idle > IDLE_MS) setWarn(Math.ceil((IDLE_MS + WARN_S * 1000 - idle) / 1000));
    }, 1000);
    return () => { clearInterval(t); events.forEach((e) => window.removeEventListener(e, touch, { capture: true })); };
  }, [sessionId, end]);

  // Finished: a thank-you, then back to the home screen by itself.
  useEffect(() => {
    if (!finished) return undefined;
    const t = setTimeout(() => end('completed'), 8000);
    return () => clearTimeout(t);
  }, [finished, end]);

  // Back/forward can't leave the kiosk.
  useEffect(() => {
    const stay = () => window.history.pushState(null, '', '/kiosk');
    window.history.pushState(null, '', '/kiosk');
    window.addEventListener('popstate', stay);
    return () => window.removeEventListener('popstate', stay);
  }, []);

  const s = state?.session;
  return (
    <div className="kiosk">
      {warn > 0 && (
        <div className="kiosk-warn" role="alertdialog" aria-live="assertive">
          <Hourglass size={40} />
          <h2>{pt('Are you still there?')}</h2>
          <p>{pt('This screen will clear for privacy in {n} seconds.', { n: warn })}</p>
          <button type="button" className="pw-primary" onClick={() => { lastTouch.current = Date.now(); setWarn(0); }}>{pt('I’m still here')}</button>
        </div>
      )}
      {!s ? (
        <div className="kiosk-home" data-kiosk-ready="1">
          <div className="kiosk-practice">{state?.practice?.name || ''}</div>
          <h1>{pt('Welcome')}</h1>
          <p className="pw-lead">{pt('The team will hand you this iPad when it’s your turn.')}</p>
          <div className="kiosk-name">{state?.kiosk?.name}</div>
          <ErrorBox error={error} />
        </div>
      ) : s.mode === 'education' ? (
        <EducationView session={s} onDone={() => end('completed')} />
      ) : (
        <div className="kiosk-forms">
          <PaperworkFlow key={s.id} view={s} mode="kiosk" post={(path, body) => kioskCall('POST', `/forms-kiosk/sessions/${s.id}${path}`, body)}
            reload={poll} onFinished={() => setFinished(true)} onActivity={() => { lastTouch.current = Date.now(); }} />
        </div>
      )}
    </div>
  );
}

// An education page on the iPad: big text, the office's pictures, and a video when there is one.
export function EducationView({ session, onDone }) {
  const pt = usePT();
  useLang();
  const a = session.article;
  useEffect(() => { kioskCall('POST', `/forms-kiosk/sessions/${session.id}/education-viewed`).catch(() => { /* recorded again on Done */ }); }, [session.id]);
  return <EducationArticle article={a} footer={<button type="button" className="pw-primary" onClick={onDone}><CheckCircle2 size={22} /> {pt('Done')}</button>} />;
}

// Shared by the iPad, the chair screen and the take-home page.
export function EducationArticle({ article: a, footer = null, big = true }) {
  const pt = usePT();
  const paras = String(a.body || '').split(/\n\s*\n/);
  const embed = a.video_url && /\.(mp4|webm)(\?|$)/i.test(a.video_url);
  return (
    <article className={`pw-card edu${big ? ' big' : ''}`}>
      <h1 className="pw-title">{a.title}</h1>
      {(a.media || []).filter((m) => m.kind === 'image').map((m) => <img key={m.id} className="edu-img" src={m.url} alt="" />)}
      {paras.map((p, i) => {
        const lines = p.split('\n');
        if (lines.every((l) => l.startsWith('- '))) return <ul key={i}>{lines.map((l) => <li key={l}>{l.slice(2)}</li>)}</ul>;
        const head = lines[0].endsWith(':') && lines.slice(1).every((l) => l.startsWith('- '));
        if (head) return <div key={i}><p>{lines[0]}</p><ul>{lines.slice(1).map((l) => <li key={l}>{l.slice(2)}</li>)}</ul></div>;
        return <p key={i}>{p}</p>;
      })}
      {(a.media || []).filter((m) => m.kind === 'video').map((m) => <video key={m.id} className="edu-video" src={m.url} controls playsInline />)}
      {a.video_url && (embed ? <video className="edu-video" src={a.video_url} controls playsInline /> : <a className="pw-secondary" href={a.video_url} target="_blank" rel="noreferrer"><PlayCircle size={20} /> {pt('Watch the video')}</a>)}
      {a.postop && <div className="edu-postop"><h2 className="pw-h">{pt('After your visit')}</h2>{String(a.postop).split('\n').map((l, i) => <p key={i}>{l}</p>)}</div>}
      {footer && <div className="pw-actions">{footer}</div>}
    </article>
  );
}
