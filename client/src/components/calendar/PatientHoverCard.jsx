import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TriangleAlert, Pill, Pin, Phone, ShieldCheck, ShieldAlert, ShieldQuestion, CalendarClock, History, ClipboardList, CircleSlash } from 'lucide-react';
import { api } from '../../api.js';
import { money, age, fmtDate, fmtDateTime } from '../../format.js';

// Cards are kept for a minute, so moving between visits is instant but a balance paid at checkout shows.
const cache = new Map();
export const loadCard = (id) => {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = api.get(`/patients/${id}/card`).catch((e) => { cache.delete(id); throw e; });
  cache.set(id, { p, at: Date.now() });
  return p;
};
export const forgetCards = () => cache.clear();

const ELIG = {
  active: [ShieldCheck, 'ok', 'Eligible'],
  inactive: [ShieldAlert, 'bad', 'Not eligible'],
  error: [ShieldQuestion, 'warn', 'Check failed'],
};

// Floating card beside a hovered appointment: who they are and what to know before they sit down.
export default function PatientHoverCard({ appt, anchor }) {
  const [card, setCard] = useState(null);
  const [pos, setPos] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    let live = true;
    setCard(null);
    loadCard(appt.patient_id).then((c) => live && setCard(c)).catch(() => {});
    return () => { live = false; };
  }, [appt.patient_id]);
  // Beside the appointment, on whichever side has room, kept on screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const right = anchor.right + 10 + w < window.innerWidth;
    const left = right ? anchor.right + 10 : Math.max(8, anchor.left - 10 - w);
    const top = Math.min(Math.max(8, anchor.top), window.innerHeight - h - 8);
    setPos({ left, top });
  }, [anchor, card]);
  const name = `${appt.first_name} ${appt.last_name}`;
  const elig = card?.insurance ? ELIG[card.insurance.eligibility] || [ShieldQuestion, 'warn', 'Not verified'] : null;
  return (
    <div ref={box} className="hover-card" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }} role="tooltip">
      <div className="hc-head">
        {card?.photo ? <img src={card.photo} alt="" className="hc-photo" /> : <span className="hc-photo">{appt.first_name?.[0]}{appt.last_name?.[0]}</span>}
        <div className="hc-name">
          <strong>{name}{card?.preferred_name ? <span className="muted"> “{card.preferred_name}”</span> : null}</strong>
          <span className="muted">{card?.dob ? `${age(card.dob)} y · ${fmtDate(card.dob)}` : appt.dob ? `${age(appt.dob)} y` : ''}{card?.language && !/^english$/i.test(card.language) ? ` · ${card.language}` : ''}</span>
        </div>
        {card?.balance != null && (
          <div className={`hc-balance${card.balance > 0 ? ' owed' : ''}`}><span>Balance</span><strong>{money(card.balance)}</strong></div>
        )}
      </div>
      {!card ? <div className="hc-loading"><i /><i /><i /></div> : (
        <>
          {(card.office_alert || card.medical_alerts || card.allergies || card.premed_required) && (
            <div className="hc-alerts">
              {card.premed_required && <span className="alert-chip strong"><Pill size={12} /> Premed</span>}
              {card.medical_alerts && <span className="alert-chip"><TriangleAlert size={12} /> {card.medical_alerts}</span>}
              {card.allergies && <span className="alert-chip">Allergy: {card.allergies}</span>}
              {card.office_alert && <span className="office-chip"><Pin size={12} /> {card.office_alert}</span>}
            </div>
          )}
          <dl className="hc-rows">
            {card.phone && <div><dt><Phone size={13} /></dt><dd>{card.phone}</dd></div>}
            {elig && (() => { const [Icon, tone, text] = elig; return <div><dt><Icon size={13} className={`hc-${tone}`} /></dt><dd>{card.insurance.carrier} · <span className={`hc-${tone}`}>{text}</span>{card.insurance.checked_at ? <span className="muted"> {fmtDate(card.insurance.checked_at)}</span> : null}</dd></div>; })()}
            {card.last_visit && <div><dt><History size={13} /></dt><dd>Last seen {fmtDate(card.last_visit.start_time)} <span className="muted">· {card.last_visit.reason || 'visit'}</span></dd></div>}
            {card.next_visit && <div><dt><CalendarClock size={13} /></dt><dd>Next {fmtDateTime(card.next_visit.start_time)} <span className="muted">· {card.next_visit.reason || 'visit'}</span></dd></div>}
            {card.unscheduled?.count > 0 && <div><dt><ClipboardList size={13} /></dt><dd>{card.unscheduled.count} planned, not scheduled <span className="muted">· {money(card.unscheduled.amount)}</span></dd></div>}
            {card.missed_2y > 0 && <div><dt><CircleSlash size={13} className="hc-bad" /></dt><dd>{card.missed_2y} missed visit{card.missed_2y === 1 ? '' : 's'} in 2 years</dd></div>}
          </dl>
        </>
      )}
    </div>
  );
}
