# Working through an internet outage

When the office's internet drops, staff keep seeing today and keep working; nothing they do is lost or
recorded twice. Code: `client/src/offline/*`, `server/src/routes/offline.js`, `client/public/sw.js`.

## What works offline

| | Offline |
|---|---|
| Today's and tomorrow's schedule (this office) | Read-only copy, marked "as of 9:42" |
| Today's patients: header, patient bar card (alerts, allergies, medications, insurance, balance), recent notes (20), tooth chart, last perio exam, day sheet | Read-only copy |
| New clinical note (unsigned draft) | Queued |
| Check in / seat / ready / out (and stepping back) | Queued |
| Cash or check payment | Queued, posted with the date it was taken |
| New task | Queued |
| Card payments, claims, eligibility, texts/email, signing notes, charging procedures, cancelling | "Needs the internet" |
| Anything else not in the copy (other days, other patients, reports) | "Needs the internet" |

## How it works

1. **The copy.** At sign-in and every 5 minutes, `GET /api/offline/snapshot` returns one bundle: the schedule
   (fetched through the app's own `/schedule` route, so office limits and shape are identical), provider and
   chair lists, and for each of today's patients the same shapes as `/patients/:id`, `/card`, `/notes`,
   `/chart`, `/perio`. Scoped to `req.user.practice_id`, the office being worked in, the person's office
   limits, and their permissions (no `clinical:read` → no notes/chart/perio/health details). Audited as one
   `offline.snapshot` row per fetch (patient ids listed) plus one `offline.snapshot_patient` row per patient per
   person per 12 hours, so the 5-minute refresh doesn't flood the log.
2. **Reading offline.** `api.js` calls `offlineFallback()` when `fetch` fails (or the proxy answers 502/503/504).
   GETs are answered by `offlineRead()` from the copy (with queued changes laid over it), so the existing
   Schedule, patient bar and chart/notes/perio screens render unchanged. The banner says
   "Offline — showing today's schedule as of 9:42. Changes will be sent when the connection is back."
3. **Queueing.** A safe change is stored with the **Idempotency-Key `api.js` already gave it**, the office
   header, and the time it was made. A double click (same key) is stored once.
4. **Sending.** Every 10 s the app checks `/api/health`; when it answers, the queue is sent oldest first with
   the original key (plus `X-Offline-Queued-At`). Before sending, `GET /api/offline/sent?keys=…` asks
   whether a key already reached the server under any of the person's sign-ins in the last 36 h (a change
   whose answer was lost, or one sent before an idle sign-out) — those are not sent again. Rules: 2xx → done;
   network error, 5xx, 429 or "already being processed" → stop and retry later in the same order; 401 → "sign
   in again"; other 4xx → kept as **failed** with the server's message; later steps for the same visit wait
   behind a failed one. Items that may already have gone through, or are older than 20 h, wait for a person
   ("I checked — send it"). One sender at a time across tabs (Web Locks).
5. **Visible results.** "Offline changes" lists every waiting/failed item (retry, discard). Each sync is
   reported to `POST /api/offline/sync-report` → `offline.sync` audit row (kinds, keys, answers — no patient
   details) and a Needs attention item (`offline-sync:u<id>`) while anything failed, resolved by a clean sync.
   Discards are reported too.

## Security trade-offs

- **Encryption at rest.** Everything in IndexedDB is AES-GCM (256-bit, random IV, record id bound as
  additional data). Keys come from `GET /api/offline/key`, derived on the server from its secret — never
  stored with the data.
- **Snapshot key = this sign-in.** Kept in memory and in this tab's `sessionStorage` (the same place and
  lifetime as the session token already), so **a reload during an outage still opens the copy**. Closing the
  tab loses the key; a new tab opened during an outage has no copy. Keeping it in memory only would lose the
  copy on reload for almost no gain, since the token beside it already grants the same access.
- **Wiped at sign-out and idle logout** (`wipeOffline`): the copy and the keys. Automatic logoff still
  applies offline — and signing in needs the internet, so after an idle logout during an outage the copy is
  gone until the connection returns. HIPAA automatic logoff wins over convenience.
- **Queued changes survive sign-out**, sealed with a per-person key (changes on password change / "sign out
  everywhere", which makes them unreadable on a lost computer). Otherwise an idle logout would silently
  destroy clinical notes and payments. Another person on the same computer can't read or send them; they're
  sent when their owner signs in (the "already sent?" check makes that safe). Sign-out warns when any wait.
- The copy is refused after 14 h. Photos aren't kept. The service worker caches only the app's own files;
  `/api` is never cached.
- The assistant never queues (its changes need the internet, and a queued change must not later look like
  the person made it).

## Integration (to apply)

Mount the route in `server/src/app.js` and wire the client as below (tested end to end with
`e2e/workflows/offline.test.mjs`, which skips itself until this is applied). Optional follow-ups:
`Schedule.jsx` can drop `saveOfflineDay` (the plain-text day list is superseded by the encrypted copy), and
card/claim/eligibility/text buttons can be wrapped in `<NeedsInternet>` (`client/src/offline/NeedsInternet.jsx`)
so they're disabled offline rather than refusing when clicked.

```diff
--- client/src/api.js
+++ client/src/api.js
@@ -1,3 +1,5 @@
+import { offlineFallback, markOnline } from './offline/index.js';
+
 const TOKEN_KEY = 'dm_token';
 
 export const getToken = () => {
@@ -63,11 +65,25 @@
   const token = getToken();
   const key = idempotencyKey(method, path, body);
   if (key) extraHeaders = { 'Idempotency-Key': key, ...extraHeaders };
-  const res = await fetch(`/api${path}`, {
-    method,
-    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...locationHeader(), ...extraHeaders },
-    body: body !== undefined ? JSON.stringify(body) : undefined,
-  });
+  // No connection (or the server can't be reached): today's offline copy answers reads, and the few safe
+  // changes wait on this computer with this same key (see offline/). Anything else says it needs the internet.
+  const offline = async () => {
+    const r = await offlineFallback({ method, path, body, key, assistant: !!extraHeaders['X-Acting-For'] });
+    if (r.error) throw new ApiError(0, r.error);
+    return r.data;
+  };
+  let res;
+  try {
+    res = await fetch(`/api${path}`, {
+      method,
+      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...locationHeader(), ...extraHeaders },
+      body: body !== undefined ? JSON.stringify(body) : undefined,
+    });
+  } catch {
+    return offline();
+  }
+  if ([502, 503, 504].includes(res.status)) return offline();
+  markOnline();
   const data = await res.json().catch(() => ({}));
   if (res.status === 401 && token) {
     setToken(null);
--- client/src/auth.jsx
+++ client/src/auth.jsx
@@ -3,6 +3,7 @@
 import { createContext, useCallback, useContext, useEffect, useState } from 'react';
 import { api, getToken, setToken } from './api.js';
 import { clearOfflineDay } from './offline.js';
+import { startOffline, offlineSession, wipeOffline } from './offline/index.js';
 
 const AuthContext = createContext(null);
 
@@ -58,9 +59,15 @@
     try {
       const me = await api.get('/auth/me');
       setState({ loading: false, user: me.user, practice: me.practice });
+      startOffline(me);
     } catch (err) {
       // No connection (not a rejected session): keep the session and show the offline schedule.
-      if (!err.status || [502, 503, 504].includes(err.status)) return setState({ loading: false, user: null, practice: null, offline: true });
+      if (!err.status || [502, 503, 504].includes(err.status)) {
+        // A reload during an outage: the person kept (encrypted) with today's copy in this tab, if there is one.
+        const kept = await offlineSession();
+        if (kept) startOffline(kept);
+        return setState({ loading: false, user: kept?.user ?? null, practice: kept?.practice ?? null, offline: true });
+      }
       setToken(null);
       setState({ loading: false, user: null, practice: null });
     }
@@ -68,9 +75,12 @@
 
   useEffect(() => {
     refresh();
-    const onLogout = () => { clearOfflineDay(); setState({ loading: false, user: null, practice: null }); };
+    const onLogout = () => { clearOfflineDay(); wipeOffline(); setState({ loading: false, user: null, practice: null }); };
+    // Back online after starting offline: check the session for real.
+    const onOnline = () => refresh();
     window.addEventListener('dm:logout', onLogout);
-    return () => window.removeEventListener('dm:logout', onLogout);
+    window.addEventListener('dm:online', onOnline);
+    return () => { window.removeEventListener('dm:logout', onLogout); window.removeEventListener('dm:online', onOnline); };
   }, [refresh]);
 
   const login = async (email, password, mfa_code) => {
@@ -88,6 +98,7 @@
     if (getToken()) api.post('/auth/logout', reason === 'idle' ? { reason } : {}).catch(() => {});
     setToken(null);
     clearOfflineDay();
+    wipeOffline();
     resetPrefs();
     clearPatientSession();
     setState({ loading: false, user: null, practice: null });
--- client/src/App.jsx
+++ client/src/App.jsx
@@ -15,6 +15,8 @@
 import { Suspense, lazy, useEffect, useState } from 'react';
 import { api, getLocationId, setLocationId } from './api.js';
 import { readOfflineDay } from './offline.js';
+import OfflineBanner from './offline/OfflineBanner.jsx';
+import { pendingCount } from './offline/index.js';
 import { ClockButton } from './components/TimeClock.jsx';
 import { useLiveEvents } from './live.js';
 import MfaSetup from './components/MfaSetup.jsx';
@@ -177,7 +179,7 @@
 function StaffApp() {
   const { user, practice, loading, offline, logout, can, refresh } = useAuth();
   if (loading) return <div className="empty">Loading…</div>;
-  if (offline) return <OfflineSchedule onRetry={refresh} />;
+  if (offline && !user) return <OfflineSchedule onRetry={refresh} />;
   if (!user) {
     return (
       <Routes>
@@ -321,7 +323,7 @@
           <LocationPicker user={user} />
           <ClockButton />
           <button className="menu-item" onClick={() => { setOpen(false); window.dispatchEvent(new Event('dm:shortcuts')); }}><Keyboard size={16} /> Keyboard shortcuts <kbd>?</kbd></button>
-          <button className="menu-item" onClick={logout}><LogOut size={16} /> Sign out</button>
+          <button className="menu-item" onClick={() => (!pendingCount() || window.confirm(`${pendingCount()} change(s) made offline haven’t been sent yet. They stay locked on this computer and are sent the next time you sign in here. Sign out?`)) && logout()}><LogOut size={16} /> Sign out</button>
         </div>
       )}
     </div>
@@ -377,6 +379,7 @@
       </aside>
       <main className={`main${fullBleed ? ' full-bleed' : ''}`} id="main" tabIndex={-1}>
         <EnvironmentBanner />
+        <OfflineBanner />
         {user.role === 'admin' && practice?.setup_status === 'pending' && location.pathname !== '/setup' && (
           <div className="setup-banner no-print">Finish setting up {practice.name} — providers, fees, insurance and reminders. <NavLink to="/setup">Continue setup →</NavLink></div>
         )}
--- server/src/app.js
+++ server/src/app.js
@@ -71,6 +71,7 @@
 import bridgePackageRoutes from './routes/bridgepackage.js';
 import { portalPublicRoutes, portalRoutes } from './routes/portal.js';
 import systemRoutes from './routes/system.js';
+import offlineRoutes from './routes/offline.js';
 import chartingRoutes from './routes/charting.js';
 import referralRoutes from './routes/referrals.js';
 import importRoutes from './routes/imports.js';
@@ -273,6 +274,7 @@
     next();
   });
   api.use(prefsRoutes({ db }));
+  api.use(offlineRoutes({ db, secret, app: () => app }));
   api.use(patientRoutes({ db }));
   api.use(scheduleRoutes({ db }));
   api.use(clinicalRoutes({ db }));
```

## Known gaps

- Flow times (`arrived_at`, `seated_at`, `dismissed_at`) are set when the change reaches the server, not when
  it happened. `PATCH /appointments/:id/status` could use `X-Offline-Queued-At` (bounded to today, not in the
  future) for these; until then an offline check-in records the sync time.
- The note composer's draft (`/patients/:id/note-draft`) and pages outside the copy show "Needs the
  internet"; some pages (e.g. Claims) swallow errors and show an empty list instead.
