import {
  Sun, AlertTriangle, CalendarDays, Inbox as InboxIcon, CalendarRange, PackageCheck, Users, PhoneCall, Repeat, Send, ShieldCheck,
  MessageSquare, Phone, Headset, Megaphone, Star, Receipt, Banknote, ChartColumn, Gauge, CircleDollarSign, Landmark, Sparkles,
  Building2, Briefcase, ListChecks, ClipboardCheck, Clock, FolderOpen, BookOpen, LayoutDashboard, TrendingUp,
} from 'lucide-react';

// The sidebar: seven groups of pages. Each page keeps its own permission check; a group
// with no page this person can use is hidden. `badge` names a count from navCounts.js.
export const GROUPS = [
  {
    key: 'today', label: 'Today', icon: Sun, pages: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, can: () => true },
      { to: '/attention', label: 'Needs attention', icon: AlertTriangle, can: ({ can }) => can('patients:read'), badge: 'attention' },
    ],
  },
  {
    key: 'schedule', label: 'Schedule', icon: CalendarDays, pages: [
      { to: '/schedule', label: 'Schedule', icon: CalendarDays, can: ({ can }) => can('schedule:read') },
      { to: '/requests', label: 'Online requests', icon: InboxIcon, can: ({ can }) => can('schedule:read') },
      { to: '/capacity', label: 'Capacity', icon: CalendarRange, can: ({ can }) => can('schedule:read') },
      { to: '/lab-checkin', label: 'Lab check-in', icon: PackageCheck, can: ({ can }) => can('clinical:write') },
    ],
  },
  {
    key: 'patients', label: 'Patients', icon: Users, pages: [
      { to: '/patients', label: 'Patients', icon: Users, can: ({ can }) => can('patients:read') },
      { to: '/followups', label: 'Follow-up lists', icon: PhoneCall, can: ({ can }) => can('schedule:read') },
      { to: '/recall', label: 'Recall autopilot', icon: Repeat, can: ({ can }) => can('schedule:read') },
      { to: '/referrals', label: 'Referrals', icon: Send, can: ({ can }) => can('patients:read') },
      { to: '/chart-audit', label: 'Chart audit', icon: ShieldCheck, can: ({ can }) => can('clinical:read') },
    ],
  },
  {
    key: 'messages', label: 'Messages', icon: MessageSquare, pages: [
      { to: '/messages', label: 'Messages', icon: MessageSquare, can: ({ can }) => can('patients:read'), badge: 'unread' },
      { to: '/calls', label: 'Calls', icon: Phone, can: ({ can }) => can('patients:read') },
      { to: '/phones', label: 'Phones', icon: Headset, can: ({ can }) => can('patients:read') },
      { to: '/campaigns', label: 'Campaigns', icon: Megaphone, can: ({ can }) => can('patients:write') },
      { to: '/reputation', label: 'Reviews', icon: Star, can: ({ can }) => can('patients:read') },
    ],
  },
  {
    // Insurance verification and the insurance autopilot are tabs of Billing & claims.
    key: 'billing', label: 'Billing', icon: Receipt, pages: [
      { to: '/claims', label: 'Billing & claims', icon: Receipt, can: ({ can }) => can('billing:read'), badge: 'claims' },
      { to: '/deposits', label: 'Deposits & cash', icon: Banknote, can: ({ can }) => can('billing:read') },
    ],
  },
  {
    key: 'numbers', label: 'Numbers', icon: ChartColumn, pages: [
      { to: '/metrics', label: 'Metrics', icon: Gauge, can: ({ can }) => can('reports:read') || can('reports:own') },
      { to: '/reports', label: 'Reports', icon: ChartColumn, can: ({ can }) => can('reports:read') },
      { to: '/business', label: 'Business', icon: CircleDollarSign, can: ({ can }) => can('business:view') || can('timeclock:manage') },
      { to: '/marketing', label: 'Marketing results', icon: TrendingUp, can: ({ can }) => can('reports:read') },
      { to: '/finance', label: 'Finance', icon: Landmark, can: ({ can }) => can('finance:read') },
      { to: '/ask', label: 'Ask your data', icon: Sparkles, can: ({ can }) => can('reports:read') },
      { to: '/group', label: 'Group', icon: Building2, can: ({ user, practice }) => user.role === 'admin' || !!practice?.org_role },
    ],
  },
  {
    key: 'office', label: 'Office', icon: Briefcase, pages: [
      { to: '/office', label: 'To-do & labs', icon: ListChecks, can: () => true, badge: 'tasks' },
      { to: '/checklists', label: 'Checklists', icon: ClipboardCheck, can: () => true, badge: 'checklists' },
      { to: '/timeclock', label: 'Time clock', icon: Clock, can: () => true },
      { to: '/documents', label: 'Documents', icon: FolderOpen, can: ({ can }) => can('clinical:read') || can('officedocs:read') },
      { to: '/intranet', label: 'Intranet', icon: BookOpen, can: () => true },
    ],
  },
];

// Who sees which group first. Admins and owners (and any other role) get the standard order.
const ORDER = {
  front_desk: ['schedule', 'patients', 'messages', 'today', 'billing', 'office', 'numbers'],
  dentist: ['schedule', 'patients', 'today', 'messages', 'office', 'billing', 'numbers'],
  billing: ['billing', 'numbers', 'today', 'patients', 'schedule', 'messages', 'office'],
};
ORDER.hygienist = ORDER.dentist;
ORDER.assistant = ORDER.dentist;
const STANDARD = GROUPS.map((g) => g.key);
const CLINICAL = new Set(['dentist', 'hygienist', 'assistant']);
// Clinical people audit charts more than they work the follow-up lists: Chart audit comes right after Patients.
const PAGE_ORDER = { patients: ['/patients', '/chart-audit'] };

// The groups this person sees, in their order, each with only the pages they can use.
export function navFor({ can, user, practice }) {
  const ctx = { can, user, practice };
  const order = ORDER[user.role] || STANDARD;
  return order.map((key) => GROUPS.find((g) => g.key === key)).map((g) => {
    let pages = g.pages.filter((p) => p.can(ctx));
    if (CLINICAL.has(user.role) && PAGE_ORDER[g.key]) {
      const first = PAGE_ORDER[g.key];
      pages = [...first.map((to) => pages.find((p) => p.to === to)).filter(Boolean), ...pages.filter((p) => !first.includes(p.to))];
    }
    return { ...g, pages };
  }).filter((g) => g.pages.length);
}

// Which sidebar page a screen belongs to (a patient's chart is under Patients, a claim under Billing).
export function pageFor(groups, pathname) {
  for (const g of groups) {
    for (const p of g.pages) {
      if (p.to === '/' ? pathname === '/' : pathname === p.to || pathname.startsWith(`${p.to}/`)) return { group: g, page: p };
    }
  }
  return null;
}

export const allPages = (groups) => groups.flatMap((g) => g.pages);
export const MAX_PINS = 3;
