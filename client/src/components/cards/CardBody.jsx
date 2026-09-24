import { Check, CheckCheck, DoorOpen, Armchair, Pill, TriangleAlert, Repeat, Cake, Star, HandHeart, CalendarX2, MessageSquareText, MessageCircleHeart } from 'lucide-react';
import { eligibilityBadge, money } from '../../format.js';
import { READY_LABEL, READY_SHORT } from '../calendar/flow.js';
import { waitLabel } from '../calendar/late.js';
import OpportunityBadge from '../opportunities/OpportunityBadge.jsx';
import ReadinessBadge from '../readiness/ReadinessBadge.jsx';
import { PaperworkBadgeFor } from '../consents/PaperworkBadge.jsx';
import { strikeLabel, strikeTitle } from './cardData.js';
import './cards.css';

// The face of an appointment card, drawn from a layout (S6): lines of items, in order. The default layout is
// exactly the card as it was before layouts existed (the new PP1/S8/DN1 marks only appear when there's something
// to show). The server keeps the same list in server/src/cards.js (CARD_ITEMS, DEFAULT_LAYOUT).
export const DEFAULT_LAYOUT = {
  version: 1,
  lines: [
    ['medical_alert', 'name', 'urgent_prefs', 'strikes', 'doctor_note', 'confirmation', 'ready', 'asap', 'recurring', 'insurance', 'readiness', 'opportunity', 'wait', 'late'],
    ['time', 'visit_type', 'personal'],
    ['provider', 'production'],
    ['procedures'],
  ],
  compact: { enabled: false, max_minutes: 30, lines: [['medical_alert', 'name', 'urgent_prefs', 'confirmation', 'late']] },
  color_by: null,
  labels: [],
};

// What each item is called in the editor, and what it's about.
export const ITEMS = {
  name: ['Name', 'First and last name'],
  preferred_name: ['Preferred name', '“Mia” when they go by another name'],
  age: ['Age', 'How old they are'],
  birthday: ['Birthday cake', 'A cake on their birthday'],
  new_patient: ['New patient star', 'First visit with us'],
  visit_type: ['Visit type', 'The type (or reason) of the visit'],
  procedures: ['Procedures & teeth', 'Codes and tooth numbers booked'],
  production: ['Production', 'Scheduled production'],
  balance: ['Balance due', 'What the account owes (people who can see billing)'],
  insurance: ['Insurance / eligibility', 'Verified, inactive or not checked'],
  confirmation: ['Confirmation status', 'Confirmed, checked in, in the chair, done'],
  medical_alert: ['Medical alert', 'Medical alerts and premedication'],
  forms: ['Forms & consents', 'Paperwork done or still to do'],
  readiness: ['Readiness', 'Lab case and parts ready'],
  opportunity: ['Opportunities', 'Treatment or recall that could be done today'],
  urgent_prefs: ['Urgent preferences', 'Blanket, no nitrous… — hover to see them'],
  strikes: ['Moved by us', 'How often the office moved them this year'],
  doctor_note: ['Doctor’s notes', 'Notes to the front desk on this visit'],
  personal: ['Personal note', 'The latest personal note, once they’re seated'],
  notes: ['Visit notes', 'The appointment’s own notes'],
  provider: ['Provider / chair', 'Who they’re with (or the chair)'],
  time: ['Time', 'Start and end'],
  labels: ['Office labels', 'Your own labels (VIP, bring x-rays…)'],
  ready: ['Ready for…', 'Ready for the doctor / checkout'],
  asap: ['ASAP', 'Wants an earlier time'],
  recurring: ['Recurring', 'Part of a series'],
  wait: ['Waiting time', 'Minutes since they arrived'],
  late: ['Late', 'Not checked in on time'],
};
export const ITEM_KEYS = Object.keys(ITEMS);

const STATUS_ICON = { confirmed: [Check, 'Confirmed'], checked_in: [DoorOpen, 'Checked in'], in_chair: [Armchair, 'In the chair'], completed: [CheckCheck, 'Completed'] };
const clock = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`;
const toMin = (t) => Number(t.slice(-5, -3)) * 60 + Number(t.slice(-2));
const years = (dob, on) => {
  if (!dob) return null;
  const [y, m, d] = dob.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = on.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
};
// Min card height (px) for each line: the first always shows, then as before (28, 44, 60…).
const LINE_MIN = [0, 28, 44, 60, 76, 92];

// Each item as it draws. c: { a, col, s, e, h, nowMin, now, lt, x (card data), readiness, onReadiness, opportunities, onOpportunities, onNotes }
const DRAW = {
  medical_alert: ({ a }) => (a.medical_alerts || a.premed_required ? (
    <>
      {a.medical_alerts ? <TriangleAlert className="cal-alert" size={12} strokeWidth={2.5} aria-label="Medical alert" /> : null}
      {a.premed_required ? <Pill className="cal-alert" size={12} strokeWidth={2.5} aria-label="Premedication" /> : null}
    </>
  ) : null),
  name: ({ a }) => <strong>{a.first_name} {a.last_name}</strong>,
  preferred_name: ({ a }) => (a.preferred_name && a.preferred_name !== a.first_name ? <span className="cc-pref-name" title="Goes by">“{a.preferred_name}”</span> : null),
  age: ({ a, col }) => { const y = years(a.dob, col.date); return y == null ? null : <span className="cc-age" title="Age">{y}y</span>; },
  birthday: ({ a, col }) => (a.dob && a.dob.slice(5, 10) === col.date.slice(5, 10) ? <Cake className="cc-cake" size={12} strokeWidth={2.4} aria-label="Birthday today" /> : null),
  new_patient: ({ x }) => (x?.new_patient ? <Star className="cc-star" size={12} strokeWidth={2.4} aria-label="New patient" /> : null),
  confirmation: ({ a }) => { if (!STATUS_ICON[a.status]) return null; const [Icon, text] = STATUS_ICON[a.status]; return <span className={`cal-status s-${a.status}`} title={text}><Icon size={11} strokeWidth={3} /></span>; },
  ready: ({ a }) => (a.status === 'in_chair' && a.ready_for ? <span className={`cal-ready r-${a.ready_for}`} title={READY_LABEL[a.ready_for]}>{READY_SHORT[a.ready_for]}</span> : null),
  asap: ({ a }) => (a.asap ? <span className="cal-asap" title="Wants an earlier time">ASAP</span> : null),
  recurring: ({ a }) => (a.series_id ? <Repeat className="cal-repeat" size={11} strokeWidth={2.5} aria-label="Recurring visit" /> : null),
  insurance: ({ a }) => { const b = eligibilityBadge(a.eligibility); return b ? <span className={`cal-elig ${b.tone}`} title={b.text}>{b.icon}</span> : null; },
  readiness: ({ a, h, readiness, onReadiness }) => (readiness?.[a.id] ? <ReadinessBadge info={readiness[a.id]} compact={h < 28} onClick={onReadiness ? () => onReadiness(a, readiness[a.id]) : undefined} /> : null),
  opportunity: ({ a, h, opportunities, onOpportunities }) => (opportunities?.[a.id]?.count ? <OpportunityBadge count={opportunities[a.id].count} fee={opportunities[a.id].fee} compact={h < 28} onClick={() => onOpportunities?.(a)} /> : null),
  wait: ({ a, col, nowMin }) => (col.isToday && nowMin != null && a.status === 'checked_in' && a.arrived_at ? (
    <span className={`cal-flow${nowMin - toMin(a.arrived_at.slice(11, 16)) >= 15 ? ' long' : ''}`} title="Waiting since arrival">⏱ {Math.max(0, nowMin - toMin(a.arrived_at.slice(11, 16)))}m</span>
  ) : null),
  late: ({ a, col, nowMin, now, lt, s, e }) => (lt ? <span className="cal-late" title={`Not checked in — ${waitLabel(lt.minutes)} after their time`}>Late {waitLabel(lt.minutes)}</span>
    : !now && col.isToday && nowMin != null && ['scheduled', 'confirmed'].includes(a.status) && nowMin > s + 5 && nowMin < e ? <span className="cal-flow long" title="Not checked in yet">late</span> : null),
  urgent_prefs: ({ x }) => {
    const urgent = (x?.prefs || []).filter((p) => p.urgent);
    if (!urgent.length) return null;
    const title = `Preferences — ${[...urgent.map((p) => `${p.label} (urgent)`), ...(x.prefs || []).filter((p) => !p.urgent).map((p) => p.label)].join(', ')}`;
    return <span className="cc-urgent" title={title} aria-label={title} data-urgent-prefs={urgent.length}><HandHeart size={12} strokeWidth={2.4} />{urgent.length > 1 ? urgent.length : ''}</span>;
  },
  strikes: ({ x }) => (x?.strikes?.count ? (
    <span className="cc-strike" title={`${strikeLabel(x.strikes)}\n${strikeTitle(x.strikes)}`} aria-label={strikeLabel(x.strikes)} data-strikes={x.strikes.count}><CalendarX2 size={11} strokeWidth={2.4} />{x.strikes.count}×</span>
  ) : null),
  doctor_note: ({ a, x, onNotes }) => {
    const notes = x?.notes || [];
    if (!notes.length) return null;
    const open = notes.some((n) => n.status === 'open');
    const title = notes.map((n) => `${n.by || 'Note'}: ${n.body}${n.status === 'acknowledged' ? ' (seen)' : ''}`).join('\n');
    return (
      <button type="button" className={`cc-note${open ? ' open' : ''}`} title={title} aria-label={`Doctor’s note: ${title}`} tabIndex={-1}
        onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); onNotes?.(a, ev.currentTarget); }}>
        <MessageSquareText size={11} strokeWidth={2.4} />{notes.length > 1 ? notes.length : ''}
      </button>
    );
  },
  forms: ({ a, col }) => <PaperworkBadgeFor appointmentId={a.id} date={col.date} />,
  labels: ({ x, layout }) => {
    const keys = x?.labels || [];
    const defs = (layout?.labels || []).filter((l) => keys.includes(l.key));
    return defs.length ? <span className="cc-labels">{defs.map((l) => <i key={l.key} style={{ '--l': l.color }}>{l.text}</i>)}</span> : null;
  },
  time: ({ s, e }) => <span className="cal-time">{clock(s)}–{clock(e)}</span>,
  visit_type: ({ a }) => a.type_name || a.reason || null,
  provider: ({ a, col }) => (col.showProvider ? a.provider_name : a.operatory_name || a.provider_name) || null,
  // The leading space is the card's own (no separator is added before it).
  production: ({ a }) => (a.production ? <b className="cal-prod"> ${Math.round(a.production / 100).toLocaleString()}</b> : null),
  balance: ({ x }) => (x?.balance > 0 ? <span className="cc-owed" title="Account balance">Owes {money(x.balance)}</span> : null),
  procedures: ({ a }) => a.procedure_summary || null,
  notes: ({ a }) => (a.notes ? <span className="cc-vnotes" title={a.notes}>{a.notes.length > 60 ? `${a.notes.slice(0, 60)}…` : a.notes}</span> : null),
  personal: ({ a, x }) => (a.status === 'in_chair' && x?.personal ? (
    <span className="cc-personal" title={`Personal — ${x.personal.by || ''} ${x.personal.at ? x.personal.at.slice(0, 10) : ''}`}><MessageCircleHeart size={11} strokeWidth={2.4} /> {x.personal.body}</span>
  ) : null),
};
const NO_SEPARATOR = new Set(['production']);

export function layoutLines(layout, minutes) {
  const l = layout || DEFAULT_LAYOUT;
  if (l.compact?.enabled && minutes <= (l.compact.max_minutes || 30) && l.compact.lines?.length) return l.compact.lines;
  return l.lines?.length ? l.lines : DEFAULT_LAYOUT.lines;
}

// The card's lines. The first is a row of marks (name and icons); the rest are text lines separated by spaces,
// shown only when the card is tall enough, and skipped when they have nothing to show.
export default function CardLines({ layout, ...c }) {
  const lines = layoutLines(layout, c.e - c.s);
  return lines.map((keys, i) => {
    if (c.h < (LINE_MIN[i] ?? LINE_MIN.at(-1) + 16 * (i - LINE_MIN.length + 1))) return null;
    const parts = [];
    for (const k of keys) {
      const node = DRAW[k]?.({ ...c, layout });
      if (node == null || node === false || node === '') continue;
      if (i > 0 && parts.length && !NO_SEPARATOR.has(k)) parts.push(' ');
      parts.push(<CardPart key={k} node={node} />);
    }
    if (!parts.length) return null;
    if (i === 0) return <div key={i} className="cal-appt-line">{parts}</div>;
    return <div key={i} className={`cal-appt-meta${keys.includes('procedures') ? ' cal-codes' : ''}`}>{parts}</div>;
  });
}
const CardPart = ({ node }) => node;
