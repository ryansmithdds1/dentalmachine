import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ManualBrowser from '../components/manual/ManualBrowser.jsx';

// How-tos for the office, searchable. Each links to where the thing is done.
const A = (title, where, body, words = '') => ({ title, where, body, words });
const ARTICLES = [
  A('Switching from Open Dental, Dentrix or Eaglesoft', '/settings?tab=import', 'Settings → Import from another system. Upload the database backup (Open Dental) or the exports, check the counts, and run it: patients, families, insurance, appointments, treatment, balances, notes and perio come across. Nothing is final until you say so, and an import can be undone.', 'conversion migrate data'),
  A('Confirmations and reminders', '/settings?tab=messaging', 'Settings → Messages & reviews sets the schedule (for example a text a week ahead, then 2 days, then a call if still unconfirmed). Patients reply C to confirm, R to reschedule; families get one message for everyone. Follow-up lists → Unconfirmed shows who still needs a call.', 'confirm text reminder call'),
  A('Filling cancellations automatically', '/settings?tab=messaging', 'Turn on “Fill cancellations automatically”. When a visit is cancelled, the opening is texted to ASAP patients, then the waitlist; the first to reply YES is booked and the rest are told it’s taken.', 'waitlist asap'),
  A('Mobile check-in', '/settings?tab=checkin', 'Patients text HERE to your texting number, or scan the QR poster at the door. The schedule updates live; open the visit and tap “Text we’re ready” to bring them in from the car.', 'arrive qr'),
  A('The office phone line and AI receptionist', '/settings?tab=phone', 'Calls ring your desk phone and the caller’s chart pops up on every screen. Missed callers get a text back. The AI receptionist can answer after hours or when nobody picks up: it books existing patients, takes new-patient requests, moves visits and takes messages. Calls shows everything, with summaries.', 'calls voicemail screen pop'),
  A('Call tracking', '/calls', 'Add a tracking number for each ad or mailer (Settings → Phone line). Calls → Sources shows calls, new patients and their production per source, and cost per new patient.', 'marketing roi'),
  A('Online booking on your website and Google', '/settings?tab=booking', 'Settings → Online booking links has your booking page, a button to paste into your website, a QR code, and “Add the Book button” for your Google listing. Online requests shows where each booking came from.', 'widget google book'),
  A('Reviews', '/reputation', 'Connect your Google Business Profile, and every review shows up here; low ratings become a task. “Draft with AI” writes a reply that never confirms the reviewer is a patient — the HIPAA mistake offices get fined for.', 'google reputation'),
  A('Insurance benefits from a breakdown', '/claims?tab=insplans', 'Open the employer plan and choose “Read a benefit summary”: upload the payer portal page or fax and the maximums, percentages, frequencies, waiting periods, age limits and missing tooth clause fill in for you to check and save.', 'eligibility breakdown ai'),
  A('Posting a paper EOB', '/claims?tab=checks', 'Billing → Insurance checks → Post an insurance check → “Read a paper EOB”. Upload the scan; each claim is matched to yours with paid and write-off by procedure, ready to post.', 'eob check payment'),
  A('Denial risks, narratives and appeals', '/claims', 'Before sending, a claim lists what’s likely to be denied (frequencies, filing limits, duplicates, missing narratives, what this payer denied before). “Draft the narrative with AI” writes one from the chart; a denied claim has “Draft an appeal letter”.', 'claim scrubber appeal'),
  A('No-show and denial predictions', '/reports?tab=predictions', 'Each upcoming visit shows its no-show risk (a percentage and why) on the hover card and visit panel, and on the card when it’s higher than usual; claims show the chance something on them is denied (and the riskiest line), from this office’s own history. A cancellation less than 24 hours before the visit counts as a late cancel — change the window in Settings → Messages. They only inform — nothing is cancelled or held. Reports → Prediction accuracy compares what staff were shown (or a backtest) with what happened, and downloads as a spreadsheet.', 'no-show risk prediction denial likelihood accuracy late cancel'),
  A('Which insurance plans pay for themselves', '/finance?tab=ppo', 'Finance → Insurance plans shows what each carrier leaves you per chair hour against what an hour costs, fees by code, and what leaving a plan would likely do.', 'ppo profitability drop'),
  A('Your true costs and profit', '/finance', 'Connect your business bank (and QuickBooks). Finance shows overhead by category against typical ranges, profit per chair hour and per visit, and matches every deposit to what you collected.', 'plaid quickbooks overhead'),
  A('Patient financing', '/settings?tab=practice', 'Add your CareCredit, Sunbit or Cherry application links in Settings → Practice → Financing. From a patient’s ledger, send an application by text; approvals and funding come back and post to the ledger.', 'carecredit sunbit cherry'),
  A('Dictating a note', null, 'On the chart, press “Dictate today’s note” (or Dictate on any note, or Alt+M) and talk: “two carpules articaine, IANB, rubber dam, shade A2, small distal caries into dentin.” The template fills itself — answered questions are filled in, what else you said is written where it belongs, and anything that contradicts the template’s wording is changed and flagged. Unanswered questions stay as one-tap buttons. Say “undo that” to take the last change back, or “stop dictating”. Read it over, then save and sign.', 'dictation dictate voice template chart notes'),
  A('AI scribe', null, 'In Clinical notes, start the scribe and talk as you work. It drafts the note in your template, the procedures (checked against your codes) and chart findings for you to review before saving. The conversation itself isn’t kept.', 'dictation notes voice'),
  A('AI x-ray reading', '/settings?tab=integrations', 'Open an x-ray and turn on the AI overlay: suspected caries, bone loss and other findings are outlined for the dentist to agree with (and chart) or dismiss. Settings → Integrations can read new x-rays automatically.', 'radiograph ai findings'),
  A('Risk assessments and patient education', null, 'A patient’s Risk & education tab has the caries (CAMBRA) and perio risk assessments — started from the chart — with recall and home-care recommendations, and pages about their treatment to send by text.', 'cambra perio risk education'),
  A('Digital lab prescriptions', '/office', 'Open a lab case and “Write and send to the lab”: the Rx, with scans and x-rays from the chart, goes to the lab as a private link. The lab updates status and tracking; you get a task when it ships.', 'lab rx case'),
  A('Asking questions about your numbers', '/ask', 'Ask your data answers questions like “how did production compare with last month?” or “who owes us the most?” from your own records.', 'reports ai question'),
  A('Connecting Claude or another AI app (MCP)', '/settings?tab=developer', 'Settings → API & webhooks: make a key with the access it should have, then add the MCP address shown there to Claude Desktop or Claude Code. It can look things up, read-only.', 'mcp api claude'),
  A('Several offices', '/group', 'Group lets an owner see every office side by side and copy templates, appointment types, message wording and fees across. Other offices join with a one-time code.', 'dso multi location organization'),
  A('Voice assistant', null, 'The assistant button (or the hold-to-talk key) takes spoken commands: “book Jane for a cleaning next Tuesday”, “chart MOD composite on 30”, “what’s her balance?”.', 'voice commands'),
  A('Is everything working?', '/status', 'The status page shows whether the service, database, storage, texting and email are working, and when background jobs last ran.', 'status uptime outage'),
];

// Two parts: "How do I…" — the user manual, one page per office task with steps and screenshots
// (components/manual, generated by `npm run manual`) — and the guides below, a paragraph per feature.
export default function Help() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'guides' ? 'guides' : 'how';
  const set = (next, opts) => setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v)), opts);
  return (
    <>
      <div className="page-header no-print"><div><h1>Help</h1><div className="muted">How to do things in Dental Machine.</div></div></div>
      <div className="tabs no-print" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'how'} className={tab === 'how' ? 'active' : ''} onClick={() => set({})}>How do I…</button>
        <button type="button" role="tab" aria-selected={tab === 'guides'} className={tab === 'guides' ? 'active' : ''} onClick={() => set({ tab: 'guides' })}>Guides</button>
      </div>
      {tab === 'how' ? <ManualBrowser how={params.get('how')} q={params.get('q') || ''} print={params.get('print') === '1'} setParams={set} /> : <Guides />}
    </>
  );
}

function Guides() {
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = ARTICLES.filter((a) => words.every((w) => `${a.title} ${a.body} ${a.words}`.toLowerCase().includes(w)));
  return (
    <>
      <input type="search" placeholder="Search the guides…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search help" style={{ width: '100%', marginBottom: 12 }} />
      {shown.map((a) => (
        <div key={a.title} className="card">
          <h2 style={{ marginTop: 0 }}>{a.title}</h2>
          <p style={{ margin: '4px 0' }}>{a.body}</p>
          {a.where && <Link to={a.where}>Go there →</Link>}
        </div>
      ))}
      {!shown.length && <div className="card empty">Nothing matches “{q}”.</div>}
    </>
  );
}
