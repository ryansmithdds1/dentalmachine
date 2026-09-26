import {
  AlertTriangle, CalendarDays, Inbox as InboxIcon, CalendarRange, PackageCheck, Users, PhoneCall, Repeat, Send, ShieldCheck,
  MessageSquare, Phone, Headset, Megaphone, Star, Receipt, Banknote, ChartColumn, Gauge, CircleDollarSign, Landmark, Sparkles,
  Building2, ListChecks, ClipboardCheck, Clock, FolderOpen, BookOpen, LayoutDashboard, TrendingUp, Wallet, ClipboardList,
  Stethoscope, Images, CheckCheck, Ruler, ScanSearch, Contact, Gift, Mail, ShieldAlert, MessageCircleHeart, Award, GraduationCap,
} from 'lucide-react';

// The module bar, like Open Dental's: one click on a module goes straight to it, and the less used screens
// live in a small dropdown under each one. Five modules work on the active patient (activePatient.jsx) and open
// a tab of their chart (`patient.tab`); the patient page's tabs belong to those modules (`patient.tabs`).
// Every page keeps its own permission check; a module with nothing this person can use is hidden.
// `badge` names a count from navCounts.jsx; a module shows the sum of its pages' counts.
// Pages with a plain address (`to`) can be pinned; a patient tab (`tab`) is opened for the active patient.
const read = (perm) => ({ can }) => can(perm);
const clinical = read('clinical:read');

export const MODULES = [
  {
    key: 'schedule', label: 'Schedule', icon: CalendarDays, go: 's',
    home: { to: '/schedule', label: 'Schedule', icon: CalendarDays, can: read('schedule:read') },
    pages: [
      { to: '/requests', label: 'Online requests', icon: InboxIcon, can: read('schedule:read') },
      { to: '/capacity', label: 'Capacity', icon: CalendarRange, can: read('schedule:read') },
      { to: '/lab-checkin', label: 'Lab check-in', icon: PackageCheck, can: read('clinical:write') },
    ],
  },
  {
    // Overview is the patient's profile (contact, medical history, recall, notes) — what Open Dental's Family
    // module shows first; the household, insurance and their messages sit beside it.
    key: 'family', label: 'Family', icon: Contact,
    patient: { tab: 'overview', tabs: ['overview', 'family', 'insurance', 'comms'], can: read('patients:read') },
    pages: [
      { to: '/patients', label: 'Patients list', icon: Users, can: read('patients:read') },
      { to: '/followups', label: 'Follow-up lists', icon: PhoneCall, can: read('schedule:read') },
      { to: '/recall', label: 'Recall autopilot', icon: Repeat, can: read('schedule:read') },
      { to: '/referrals', label: 'Referrals', icon: Send, can: read('patients:read') },
      { to: '/letters', label: 'Letters', icon: Mail, can: read('patients:read') },
    ],
  },
  {
    key: 'account', label: 'Account', icon: Wallet, go: 'a', also: ['/checkout'],
    patient: { tab: 'ledger', tabs: ['ledger'], can: read('billing:read') },
    pages: [
      { to: '/claims', label: 'Billing & claims', icon: Receipt, can: read('billing:read') },
      { to: '/claims?tab=approve', label: 'Ready to approve', icon: CheckCheck, can: read('billing:read'), badge: 'claims' },
      { to: '/deposits', label: 'Deposits & cash', icon: Banknote, can: read('billing:read') },
      { to: '/gift-certificates', label: 'Gift certificates', icon: Gift, can: read('billing:read') },
    ],
  },
  {
    key: 'treatment', label: 'Treatment Plan', short: 'Tx Plan', icon: ClipboardList,
    patient: { tab: 'treatment', tabs: ['treatment'], can: clinical },
    pages: [
      { to: '/recall?type=treatment', label: 'Treatment follow-up', icon: PhoneCall, can: clinical },
    ],
  },
  {
    key: 'chart', label: 'Chart', icon: Stethoscope, go: 'c', also: ['/xray-review', '/chart-audit'],
    patient: { tab: 'chart', tabs: ['chart', 'perio', 'notes', 'rx', 'ortho', 'risk'], can: clinical },
    pages: [
      { tab: 'perio', label: 'Perio', icon: Ruler, can: clinical },
      { to: '/chart-audit', label: 'Chart audit', icon: ShieldCheck, can: clinical },
      { to: '/xray-review', label: 'X-ray AI review', icon: ScanSearch, can: clinical },
    ],
  },
  {
    key: 'images', label: 'Images', icon: Images, go: 'i',
    patient: { tab: 'documents', tabs: ['documents'], can: clinical },
    pages: [
      { to: '/documents', label: 'Office documents', icon: FolderOpen, can: ({ can }) => can('clinical:read') || can('officedocs:read') },
    ],
  },
  {
    key: 'manage', label: 'Manage', icon: LayoutDashboard,
    home: { to: '/', label: 'Today’s dashboard', icon: LayoutDashboard, can: () => true },
    sections: [
      { key: 'today', label: 'Today', pages: [
        { to: '/attention', label: 'Needs attention', icon: AlertTriangle, can: read('patients:read'), badge: 'attention' },
      ] },
      { key: 'messages', label: 'Messages & calls', pages: [
        { to: '/messages', label: 'Messages', icon: MessageSquare, can: read('patients:read'), badge: 'unread' },
        { to: '/calls', label: 'Calls', icon: Phone, can: read('patients:read') },
        { to: '/phones', label: 'Phones', icon: Headset, can: read('patients:read') },
        { to: '/campaigns', label: 'Campaigns', icon: Megaphone, can: read('patients:write') },
        { to: '/reputation', label: 'Reviews', icon: Star, can: read('patients:read') },
        // What patients said after their visit (the "how did we do?" funnel) and the team's shout-outs.
        { to: '/reviews', label: 'Patient feedback', icon: MessageCircleHeart, can: read('patients:read') },
      ] },
      { key: 'numbers', label: 'Numbers', pages: [
        { to: '/reports', label: 'Reports', icon: ChartColumn, can: read('reports:read') },
        { to: '/metrics', label: 'Metrics', icon: Gauge, can: ({ can }) => can('reports:read') || can('reports:own') },
        { to: '/business', label: 'Business', icon: CircleDollarSign, can: ({ can }) => can('business:view') || can('timeclock:manage') },
        { to: '/marketing', label: 'Marketing results', icon: TrendingUp, can: read('reports:read') },
        { to: '/finance', label: 'Finance', icon: Landmark, can: read('finance:read') },
        { to: '/ask', label: 'Ask your data', icon: Sparkles, can: read('reports:read') },
        { to: '/group', label: 'Group', icon: Building2, can: ({ user, practice }) => user.role === 'admin' || !!practice?.org_role },
      ] },
      { key: 'office', label: 'Office', pages: [
        { to: '/office', label: 'To-do & labs', icon: ListChecks, can: () => true, badge: 'tasks' },
        { to: '/checklists', label: 'Checklists', icon: ClipboardCheck, can: () => true, badge: 'checklists' },
        { to: '/timeclock', label: 'Time clock', icon: Clock, can: () => true },
        { to: '/bonus', label: 'My bonus', icon: Award, can: () => true },
        { to: '/intranet', label: 'Intranet', icon: BookOpen, can: () => true },
        // Guided walkthroughs: my to-do list of assigned tours, and (managers) the team's progress.
        { to: '/training', label: 'Training', icon: GraduationCap, can: () => true },
        { to: '/compliance', label: 'Compliance log', icon: ShieldAlert, can: read('patients:read') },
      ] },
    ],
  },
];

// The modules are the same for everyone (muscle memory, like Open Dental); only Manage's dropdown puts what a
// role uses most first.
const MANAGE_ORDER = {
  billing: ['numbers', 'today', 'messages', 'office'],
  front_desk: ['messages', 'today', 'office', 'numbers'],
  dentist: ['today', 'office', 'messages', 'numbers'],
};
MANAGE_ORDER.hygienist = MANAGE_ORDER.dentist;
MANAGE_ORDER.assistant = MANAGE_ORDER.dentist;

// The modules this person sees. Each has `items` (its dropdown, in sections), `pages` (every fixed address it
// offers, home included — e2e/sweep reads this) and `target` info for the one click.
export function navFor({ can, user, practice }) {
  const ctx = { can, user, practice };
  const ok = (p) => p.can(ctx);
  const order = MANAGE_ORDER[user?.role];
  return MODULES.map((m) => {
    let sections = m.sections || [{ key: m.key, label: null, pages: m.pages }];
    if (order) sections = [...sections].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    sections = sections.map((s) => ({ ...s, pages: s.pages.filter(ok) })).filter((s) => s.pages.length);
    const items = sections.flatMap((s) => s.pages);
    const home = m.home && ok(m.home) ? m.home : null;
    const patient = m.patient && ok(m.patient) ? m.patient : null;
    const pages = [...(home ? [{ ...home, home: true }] : []), ...items.filter((p) => p.to)];
    return { ...m, home, patient, sections, items, pages };
  }).filter((m) => m.home || m.patient || m.pages.length);
}

// Is this address the page `to` (path and, when it has one, its query)? Returns how specific the match is.
function score(to, pathname, search) {
  const [path, query] = to.split('?');
  const hit = path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
  if (!hit) return 0;
  if (!query) return 1;
  const want = new URLSearchParams(query);
  const have = new URLSearchParams(search);
  for (const [k, v] of want) if (have.get(k) !== v) return 0;
  return 1 + [...want].length;
}

// Where the person is: the module (and dropdown page, if any) this screen belongs to. On a patient page the
// tab decides the module (Chart for ?tab=perio, Account for ?tab=ledger…).
export function whereAmI(modules, { pathname, search = '' }) {
  const pt = pathname.match(/^\/patients\/(\d+)(\/|$)/);
  if (pt) {
    const tab = new URLSearchParams(search).get('tab') || 'overview';
    const module = modules.find((m) => m.patient?.tabs.includes(tab)) || modules.find((m) => m.key === 'family');
    const page = module?.items.find((p) => p.tab === tab) || null;
    return module ? { module, page, patientId: Number(pt[1]), tab } : null;
  }
  let best = null;
  for (const m of modules) {
    for (const p of [...(m.home ? [m.home] : []), ...m.items.filter((x) => x.to)]) {
      const s = score(p.to, pathname, search);
      if (s && (!best || s > best.s)) best = { s, module: m, page: p.home || p === m.home ? null : p };
    }
    for (const prefix of m.also || []) if (!best && score(prefix, pathname, search)) best = { s: 0.5, module: m, page: null };
  }
  return best && { module: best.module, page: best.page };
}

export const allPages = (modules) => modules.flatMap((m) => m.pages);
export const patientTabModule = (modules, tab) => modules.find((m) => m.patient?.tabs.includes(tab)) || null;
// The patient modules in order (PatientDetail groups its tabs under them).
export const PATIENT_MODULES = MODULES.filter((m) => m.patient).map((m) => ({ key: m.key, label: m.label, icon: m.icon, tabs: m.patient.tabs }));
// Only plain addresses can be pinned (the server keeps pins as page paths).
export const pinnable = (p) => !!p.to && !p.to.includes('?');
export const MAX_PINS = 3;
