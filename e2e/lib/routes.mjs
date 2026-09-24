// Every screen the staff app has, read from the source so a new page (or a redesigned menu) is swept without
// anyone updating a list: the <Route path="…"> elements in client/src (the router), plus the pages the
// menu links to (App.jsx's nav array and client/src/nav/*.js `to: '/…'` entries, whichever exist).
// Routes with an :id are filled in with real ids from the demo practice; ones the sweep can't fill (public
// links that need a token) are reported as skipped rather than silently ignored.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './server.mjs';

const SRC = join(root, 'client/src');

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(jsx?|mjs)$/.test(f) ? [p] : [];
  });
}

// Public (patient-facing) pages live in App() before the staff app; they need tokens from texts and emails.
const PUBLIC = /^\/(book|c|lab|learn|checkin|f|r|s|welcome|unsubscribe-news|u|pay|billpay|tp|scan|portal|rb|billing-link|p|e)\//;

export function sourceRoutes() {
  const found = new Set();
  const all = files(SRC);
  // Nested routers (Intranet, Checklists…) use relative paths; their prefix is the "/x/*" route that renders
  // the page component defined in that file.
  const app = readFileSync(join(SRC, 'App.jsx'), 'utf8');
  const fileOf = Object.fromEntries([...app.matchAll(/const (\w+) = lazy\(\(\) => import\('\.\/([\w/]+)\.jsx'\)/g)].map((m) => [m[1], m[2]]));
  const prefixFor = {};
  for (const m of app.matchAll(/<Route\s+path="(\/[^"*]+)\/\*"\s+element=\{<(\w+)/g)) if (fileOf[m[2]]) prefixFor[fileOf[m[2]]] = m[1];
  for (const f of all) {
    const text = readFileSync(f, 'utf8');
    const rel = f.slice(SRC.length + 1).replace(/\.jsx?$/, '');
    for (const m of text.matchAll(/<Route\s+path="([^"]+)"/g)) {
      if (m[1].startsWith('/')) found.add(m[1]);
      else if (m[1] !== '*' && prefixFor[rel]) found.add(`${prefixFor[rel]}/${m[1]}`);
    }
    // Menu entries: ['/path', Icon, 'Label', …] (App.jsx) or { to: '/path', … } (nav config).
    if (/nav/i.test(rel) || rel === 'App') {
      for (const m of text.matchAll(/\[\s*'(\/[a-z0-9\-/]*)'\s*,\s*[A-Z]\w*\s*,/g)) found.add(m[1]);
      for (const m of text.matchAll(/\bto:\s*'(\/[a-z0-9\-/]*)'/g)) found.add(m[1]);
    }
  }
  return [...found].map((p) => p.replace(/\/\*$/, '')).filter((p) => p && p !== '*' && !PUBLIC.test(p));
}

// Ids from the demo practice for routes like /patients/:id (read through the API as the admin).
export async function idsFor(base, token) {
  const get = (p) => fetch(`${base}/api${p}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const today = new Date().toLocaleDateString('en-CA');
  const pts = await get('/patients?limit=5');
  const patient = pts?.rows?.[0]?.id;
  const claims = await get('/claims');
  const claim = (Array.isArray(claims) ? claims : claims?.rows || claims?.claims || [])[0]?.id;
  const appts = await get(`/appointments?from=${today}&to=${today}`);
  const appt = (Array.isArray(appts) ? appts : appts?.rows || [])[0]?.id;
  const plans = patient ? await get(`/patients/${patient}/treatment-plans`) : null;
  const plan = (Array.isArray(plans) ? plans : plans?.rows || [])[0]?.id;
  return { patients: patient, claims: claim, appointments: appt, checkout: appt, 'treatment-plans': plan };
}

// Concrete paths to visit, and the ones skipped (with why).
export function expand(routes, ids) {
  const visit = [];
  const skipped = [];
  for (const r of routes) {
    if (!r.includes(':')) { visit.push(r); continue; }
    const seg = r.split('/')[1];
    const id = ids[seg];
    if (id && (r.match(/:/g) || []).length === 1) visit.push(r.replace(/:[a-z]+/i, id));
    else skipped.push(`${r} (no demo id for :${seg})`);
  }
  return { visit: [...new Set(visit)].sort(), skipped };
}

export const hasNavConfig = () => existsSync(join(SRC, 'nav'));
