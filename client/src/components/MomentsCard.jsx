import { useNavigate } from 'react-router-dom';
import { Cake, Sparkles, Award, HeartHandshake, StickyNote, Mail } from 'lucide-react';
import { api, openFile } from '../api.js';
import { useApi } from '../hooks.js';
import { toast } from '../toast.js';

// The huddle's "moments" card (PX7): today's birthdays, first visits ("greet by name"), milestones with their
// certificate, patients who had a hard last visit, and personal notes worth mentioning — so the team can make it
// personal in person. Nothing here messages a patient; a life event becomes a card task only if someone chooses.
export default function MomentsCard({ date }) {
  const nav = useNavigate();
  const { data, reload } = useApi(`/journeys/moments?date=${date}`, [date]);
  if (!data) return null;
  const empty = !data.total && !data.notes.length && !data.other_birthdays.length && !data.cards_to_write;
  if (empty) return null;
  const open = (id) => nav(`/patients/${id}`);
  const who = (p) => <button type="button" className="link" onClick={() => open(p.patient_id)}>{p.preferred_name ? `${p.preferred_name} (${p.name})` : p.name}</button>;
  const at = (p) => (p.time ? <span className="muted"> · {fmtTime(p.time)}</span> : null);
  const act = async (m, what) => {
    if (what === 'card') {
      await api.post(`/journeys/moments/${m.moment_id}/card`).then(() => toast('Card task added')).catch((e) => toast(e.message, { tone: 'error' }));
    } else {
      await api.post(`/journeys/moments/${m.moment_id}/${what}`).then(() => toast(what === 'done' ? 'Marked done' : 'Dismissed')).catch((e) => toast(e.message, { tone: 'error' }));
    }
    reload();
  };
  const certificate = (m) => openFile(`/journeys/moments/${m.moment_id}/certificate`).catch((e) => toast(e.message, { tone: 'error' }));

  return (
    <div className="card moments-card">
      <h2 style={{ marginTop: 0 }}><Sparkles size={18} aria-hidden="true" /> Moments today</h2>
      <div className="moments-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {(data.birthdays.length > 0 || data.other_birthdays.length > 0) && (
          <section>
            <h3><Cake size={16} aria-hidden="true" /> Birthdays</h3>
            <ul>
              {data.birthdays.map((p) => <li key={p.patient_id}>{who(p)}{at(p)} — coming in today{p.age < 18 ? ` (turning ${p.age})` : ''}</li>)}
              {data.other_birthdays.slice(0, 8).map((p) => <li key={p.patient_id}>{who(p)}</li>)}
              {data.other_birthdays.length > 8 && <li className="muted">+{data.other_birthdays.length - 8} more</li>}
            </ul>
          </section>
        )}
        {data.first_visits.length > 0 && (
          <section>
            <h3><HeartHandshake size={16} aria-hidden="true" /> First visits — greet by name</h3>
            <ul>{data.first_visits.map((p) => <li key={p.appointment_id}>{who(p)}{at(p)}</li>)}</ul>
          </section>
        )}
        {data.milestones.length > 0 && (
          <section>
            <h3><Award size={16} aria-hidden="true" /> Milestones</h3>
            <ul>
              {data.milestones.map((m) => (
                <li key={m.moment_id}>
                  {who(m)}{at(m)} — {m.kind === 'braces_off' ? 'braces off!' : 'first cavity-free checkup!'}
                  <div className="inline" style={{ gap: 8 }}>
                    <button type="button" className="link" onClick={() => certificate(m)}>Print certificate</button>
                    <button type="button" className="link" onClick={() => act(m, 'done')}>Done</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {data.hard_visits.length > 0 && (
          <section>
            <h3>Had a hard last visit — be extra kind</h3>
            <ul>{data.hard_visits.map((p) => <li key={p.patient_id}>{who(p)}{at(p)}<div className="muted" style={{ fontSize: 12 }}>{p.reasons.join(' · ')}</div></li>)}</ul>
          </section>
        )}
        {(data.notes.length > 0 || data.life_events.length > 0) && (
          <section>
            <h3><StickyNote size={16} aria-hidden="true" /> Worth mentioning</h3>
            <ul>
              {data.notes.map((p) => <li key={`n${p.patient_id}`}>{who(p)}{at(p)}<div className="muted" style={{ fontSize: 12 }}>{p.notes.join(' · ')}</div></li>)}
              {data.life_events.map((m) => (
                <li key={`l${m.moment_id}`}>
                  {who(m)} — {m.detail}
                  <div className="inline" style={{ gap: 8 }}>
                    <button type="button" className="link" onClick={() => act(m, 'card')}>Send a card</button>
                    <button type="button" className="link" onClick={() => act(m, 'dismiss')}>Not now</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {data.cards_to_write > 0 && (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          <Mail size={14} aria-hidden="true" /> {data.cards_to_write} handwritten card{data.cards_to_write === 1 ? '' : 's'} to write — on the task list.
        </div>
      )}
    </div>
  );
}

const fmtTime = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
