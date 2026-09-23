import { useRef, useState } from 'react';
import { Sparkles, Send } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox } from '../components/ui.jsx';
import Markdown from '../components/Markdown.jsx';

// Questions about the practice in plain words, answered from its own numbers.
const EXAMPLES = [
  'How did production and collections this month compare with last month?',
  'Which providers produced the most in the last 90 days?',
  'Who owes us the most, and how much is over 90 days?',
  'How many new patients did we see this quarter, and where did they come from?',
  'Which insurance plans pay us the least per chair hour?',
  'What does tomorrow’s schedule look like, and where are the open times?',
];

export default function Ask() {
  const { data: meta } = useApi('/ask');
  const [thread, setThread] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const end = useRef(null);
  const ask = async (question) => {
    if (!question.trim() || busy) return;
    setError(null);
    setBusy(true);
    const next = [...thread, { role: 'user', content: question }];
    setThread(next);
    setQ('');
    try {
      const r = await api.post('/ask', { question, history: thread.map(({ role, content }) => ({ role, content })) });
      setThread([...next, { role: 'assistant', content: r.answer, tools: r.tools }]);
    } catch (e) {
      setError(e);
      setThread(thread);
      setQ(question);
    } finally {
      setBusy(false);
      setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  };
  if (meta && !meta.enabled) return <div className="card empty">Ask your data needs the AI turned on for this server (ANTHROPIC_API_KEY).</div>;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Ask your data</h1>
          <div className="muted">Ask about production, patients, the schedule, balances, insurance or costs. Answers come from your own records, only what you’re allowed to see.</div>
        </div>
      </div>
      {!thread.length && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>Try:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {EXAMPLES.map((e) => <button key={e} type="button" className="small" onClick={() => ask(e)}>{e}</button>)}
          </div>
        </div>
      )}
      {thread.map((m, i) => (
        <div key={i} className="card" style={m.role === 'user' ? { background: 'var(--surface-2, transparent)' } : {}}>
          {m.role === 'user' ? <strong>{m.content}</strong> : (
            <>
              <Markdown text={m.content} />
              {m.tools?.length > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Looked up: {[...new Set(m.tools.map((t) => t.name.replace(/_/g, ' ')))].join(', ')}</div>}
            </>
          )}
        </div>
      ))}
      {busy && <div className="card muted"><Sparkles size={14} /> Looking it up…</div>}
      <ErrorBox error={error} />
      <form className="card inline" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={thread.length ? 'Ask a follow-up…' : 'Ask a question about your practice…'} aria-label="Question" />
        <button className="primary" disabled={busy || !q.trim()}><Send size={14} /> Ask</button>
        {thread.length > 0 && <button type="button" onClick={() => setThread([])}>New question</button>}
      </form>
      <div ref={end} />
    </>
  );
}
