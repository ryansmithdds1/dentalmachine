// Commands handled at once, in the browser, without asking the AI: moving around the app, starting voice
// perio, undo, yes/no. Anything else goes to the assistant. Speech comes in lower-case-ish and
// unpunctuated, so matching is forgiving.

const TABS = [
  [/perio( chart(ing)?)?|pocket depths?/, 'perio'], [/x-?rays?|images?|imaging|radiographs?|documents?|photos?/, 'documents'],
  [/ledger|account|balance|billing/, 'ledger'], [/(clinical )?notes?/, 'notes'], [/treatment( plans?)?|tx plans?/, 'treatment'],
  [/(tooth )?chart(ing)?|odontogram/, 'chart'], [/insurance|benefits/, 'insurance'], [/family/, 'family'], [/rx|prescriptions?|meds|medications/, 'rx'],
  [/overview|summary|info/, 'overview'], [/messages?|texts?|forms?/, 'comms'], [/ortho/, 'ortho'],
];
const PAGES = [
  [/patients( list)?/, '/patients'], [/claims?/, '/claims'], [/reports?/, '/reports'], [/(inbox|messages)/, '/messages'],
  [/settings/, '/settings'], [/(today|dashboard|home|front desk)/, '/'],
];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const normalize = (s) => String(s || '').toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
// A short yes or no, however it's said ("yes", "yeah do it", "okay go ahead", "no cancel that").
const short = (s) => normalize(s).split(' ').length <= 4;
export const isYes = (s) => short(s) && /^(yes|yeah|yep|yup|confirm(ed)?|do it|go ahead|correct|ok(ay)?|sure|sounds good|please do|that's right|approved?|perfect|great)\b/.test(normalize(s));
export const isNo = (s) => short(s) && /^(no|nope|cancel|stop|don't|do not|never ?mind|scratch that|wait)\b/.test(normalize(s));
export const isUndo = (s) => /^(undo|undo that|take that back|reverse that|oops)$/.test(normalize(s));

function scheduleDate(word) {
  const d = new Date();
  if (!word || word === 'today') return ymd(d);
  if (word === 'tomorrow') { d.setDate(d.getDate() + 1); return ymd(d); }
  if (word === 'yesterday') { d.setDate(d.getDate() - 1); return ymd(d); }
  const day = DAYS.indexOf(word.replace(/^(next|this) /, ''));
  if (day < 0) return null;
  let add = (day - d.getDay() + 7) % 7 || 7;
  if (word.startsWith('next ') && add < 7) add += 7;
  d.setDate(d.getDate() + add);
  return ymd(d);
}

// → { go: path, perioVoice?, label } for a navigation command, or null to hand it to the assistant.
export function localCommand(raw, { patientId }) {
  const s = normalize(raw).replace(/^(please |can you |could you |let's |lets )/, '').replace(/ please$/, '');
  if (/^(start|begin|do|chart) (voice )?perio( charting)?$|^voice perio$|^perio by voice$/.test(s)) {
    return patientId ? { go: `/patients/${patientId}?tab=perio`, perioVoice: true, label: 'Voice perio charting' } : null;
  }
  const verb = /^(open( up)?|show( me)?|(go |get )?back to|go to|pull up|bring up|switch to|take me to|jump to|let's see|let me see)( the)? /;
  const rest = s.replace(verb, '');
  const sched = /^schedule( for)?( (today|tomorrow|yesterday|(next |this )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)))?$/.exec(rest);
  if (sched) {
    const date = scheduleDate(sched[3]);
    return date ? { go: `/schedule?date=${date}`, label: `Schedule, ${sched[3] || 'today'}` } : null;
  }
  // With a chart open, a tab's name alone ("x-rays", "her ledger") is enough.
  const bare = !verb.test(s);
  if (bare && !patientId) return null;
  const own = rest.replace(/^(her|his|their|the patient'?s?|this patient'?s?|patient'?s?) /, '');
  if (patientId && own !== rest) {
    const tab = TABS.find(([re]) => new RegExp(`^(${re.source})$`).test(own));
    if (tab) return { go: `/patients/${patientId}?tab=${tab[1]}`, label: `Opened ${tab[1]}` };
  }
  if (patientId) {
    const tab = TABS.find(([re]) => new RegExp(`^(${re.source})$`).test(rest));
    if (tab) return { go: `/patients/${patientId}?tab=${tab[1]}`, label: `Opened ${tab[1]}` };
  }
  if (bare) return null;
  const page = PAGES.find(([re]) => new RegExp(`^(${re.source})$`).test(rest));
  return page ? { go: page[1], label: `Opened ${rest}` } : null;
}
