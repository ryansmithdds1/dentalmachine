import { AsyncLocalStorage } from 'node:async_hooks';

// Who (or what) is acting right now, for the audit log: a person, the AI (the assistant acting for a person,
// the AI receptionist), an automation (a scheduled job), the public API, an import, an outside integration
// (a webhook), or a patient (portal, confirm links, texts, check-in). Set once per request or job, and read
// by the data helpers so every change is attributed without each route having to pass it along.
export const SOURCES = ['human', 'ai', 'automation', 'api', 'import', 'integration', 'patient'];
const store = new AsyncLocalStorage();

export const currentActor = () => store.getStore() || null;

// Runs fn as the given actor (a job, a webhook's work after the response, the AI receptionist's tools…).
// Changes made inside are written to the audit log straight away (there's no response to wait for).
export function withActor(actor, fn) {
  const parent = currentActor();
  return store.run({ ...(parent || {}), ...actor, pending: null }, fn);
}

// Adjusts the current actor in place (e.g. once an API key or a user is known).
export function setActor(patch) {
  const ctx = currentActor();
  if (ctx) Object.assign(ctx, patch);
}

const sourceForPath = (path) => {
  if (path.startsWith('/api/webhooks/')) return 'integration';
  if (path.startsWith('/api/public/') || path.startsWith('/api/portal')) return 'patient';
  if (path.startsWith('/api/v1') || path.startsWith('/api/mcp')) return 'api';
  return 'human';
};

// For each request: an actor, and changes held until the route writes its own audit entry (which takes them
// in) — whatever is left is written just before the response goes out, and dropped if the request failed.
export function actorMiddleware(db, flush) {
  return (req, res, next) => {
    const ctx = { source: sourceForPath(req.path), actor: null, userId: null, practiceId: null, ip: req.ip ?? null, pending: new Map() };
    let done = false;
    const hold = (name) => {
      const orig = res[name].bind(res);
      res[name] = (...args) => {
        if (done) return orig(...args);
        done = true;
        // From here on (work that carries on after the response) changes are written as they happen.
        const left = ctx.pending;
        ctx.pending = null;
        if (res.statusCode >= 400 || !left.size) return orig(...args);
        flush(db, left).catch((err) => console.error('Audit flush failed:', err.message)).finally(() => orig(...args));
        return res;
      };
    };
    hold('json');
    hold('send');
    hold('end');
    store.run(ctx, next);
  };
}
