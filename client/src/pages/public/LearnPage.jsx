import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PublicLayout from './PublicLayout.jsx';

// A patient education page from the office.
export default function LearnPage() {
  const { practice, slug } = useParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get(`/public/learn/${practice}/${slug}`).then(setD).catch(setError); }, [practice, slug]);
  if (error) return <PublicLayout><ErrorBox error={error} /></PublicLayout>;
  if (!d) return <div className="empty">Loading…</div>;
  const blocks = d.body.split(/\n{2,}/);
  return (
    <PublicLayout practice={d.practice} title={d.title}>
      <div className="card" style={{ lineHeight: 1.6 }}>
        {blocks.map((b, i) => {
          const lines = b.split('\n');
          const bullets = lines.filter((l) => l.startsWith('- '));
          if (bullets.length) {
            const lead = lines.filter((l) => !l.startsWith('- '));
            return <div key={i}>{lead.length > 0 && <p style={{ marginBottom: 4 }}>{lead.join(' ')}</p>}<ul>{bullets.map((l) => <li key={l}>{l.slice(2)}</li>)}</ul></div>;
          }
          return <p key={i}>{b}</p>;
        })}
        {d.practice.phone && <p className="muted">Questions? Call us at <a href={`tel:${d.practice.phone}`}>{d.practice.phone}</a>.</p>}
      </div>
    </PublicLayout>
  );
}
