// Predictions (no-show / late-cancel risk per visit, denial risk per claim line) behind one adapter:
//
//   predictor.predictMany(kind, features[], { practiceId }) → [{ probability (0..1), percent, confidence
//     ('low'|'medium'|'high'), reasons: [plain words], driver, … }]
//   predictor.predict(kind, features, { practiceId }) → one of the above
//
// Drivers: 'builtin' (predict/builtin.js — the office's own history, no outside calls; the default) and 'jev'
// (predict/jev.js — TypeSafe AI's Jev, off unless PREDICT_DRIVER=jev; live mode also needs a signed BAA). When the
// vendor fails for any reason the built-in answer is used and the failure becomes a "Needs attention" item
// (resolved the next time the vendor answers). The reasons always come from the built-in model: they describe
// the office's own history, which is what staff can check.
//
// Predictions only inform people: nothing here (or anywhere that uses it) cancels, moves, holds or sends anything.
import { builtin, noShowLevel, pct } from './builtin.js';
import { createJev, jevConfig } from './jev.js';
import { raiseIssue, resolveIssue } from '../issues.js';

export const KINDS = ['no_show', 'denial'];
export const ISSUE_KEY = 'predict-driver';

export function predictConfig(env = process.env) {
  return { driver: env.PREDICT_DRIVER === 'jev' ? 'jev' : 'builtin', jev: jevConfig(env) };
}

export function createPredictor({ db, config = {}, fetchImpl = globalThis.fetch } = {}) {
  const cfg = config.predict || predictConfig();
  const vendor = cfg.driver === 'jev' ? createJev({ ...jevConfig({}), ...cfg.jev }, fetchImpl) : null;
  const flagged = new Set(); // practices this process raised an issue for
  const checked = new Set(); // practices whose leftover issue (from before a restart) was looked at once
  let downUntil = 0; // after a failure the vendor is left alone for a minute, so a whole day's schedule doesn't wait on it
  const own = (list, extra) => list.map((r) => ({ ...r, driver: 'builtin', ...extra }));

  async function predictMany(kind, list, { practiceId = null } = {}) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown prediction: ${kind}`);
    const mine = await builtin.predictMany(kind, list);
    if (!vendor || !list.length) return own(mine);
    const fail = async (message) => {
      if (practiceId && !flagged.has(practiceId)) {
        flagged.add(practiceId);
        await raiseIssue(db, {
          practiceId, kind: 'integration', key: ISSUE_KEY, role: 'admin', severity: 'normal',
          title: 'Predictions: Jev didn’t answer, so the built-in model is being used', detail: message,
        });
      }
      return own(mine, { fallback: true });
    };
    if (Date.now() < downUntil) return fail('Jev failed a moment ago; trying again shortly');
    try {
      const theirs = await vendor.predictMany(kind, list);
      if (practiceId && (flagged.has(practiceId) || !checked.has(practiceId))) {
        flagged.delete(practiceId);
        checked.add(practiceId);
        await resolveIssue(db, practiceId, ISSUE_KEY, 'Resolved automatically: Jev answered again');
      }
      return mine.map((r, i) => {
        const p = Math.round(theirs[i].probability * 100) / 100;
        return {
          ...r, probability: p, percent: pct(p), confidence: theirs[i].confidence || r.confidence, driver: vendor.id, sandbox: vendor.sandbox,
          ...(kind === 'no_show' ? { level: noShowLevel(p, r.base_rate) } : {}), builtin_percent: r.percent,
        };
      });
    } catch (err) {
      downUntil = Date.now() + 60_000;
      return fail(err?.message || String(err));
    }
  }
  return {
    driver: vendor ? vendor.id : 'builtin',
    info: () => ({ driver: vendor ? vendor.id : 'builtin', name: vendor ? vendor.name : builtin.name, sandbox: vendor ? vendor.sandbox : false }),
    predictMany,
    predict: async (kind, features, opts) => (await predictMany(kind, [features], opts))[0],
    reset: () => { downUntil = 0; flagged.clear(); checked.clear(); },
  };
}

// The app's predictor (createApp registers it); code outside a request (huddle emails, jobs) uses it too.
let current = null;
export function registerPredictor(p) { current = p; }
export function getPredictor() {
  if (!current) current = createPredictor({ config: { predict: { driver: 'builtin' } } });
  return current;
}

// The office-wide rates the models learn from are read once and kept for a few minutes per practice: they move
// slowly, and a day's schedule shouldn't re-read two years of visits on every refresh. After that they're refreshed
// in the background while the last ones are still used (only a practice's very first read waits). Keyed by
// practice, so one practice's history never feeds another's. `version` is what the rates were built for (the
// practice's date): a new day refreshes them the same way.
const cache = new Map();
export const STATS_TTL_MS = 30 * 60_000;
export async function cachedStats(key, version, build) {
  const hit = cache.get(key);
  const fresh = hit && hit.version === version && Date.now() - hit.at < STATS_TTL_MS;
  if (fresh) return hit.value;
  if (hit && !hit.refreshing) {
    hit.refreshing = true;
    build().then((value) => cache.set(key, { at: Date.now(), version, value }))
      // A failed refresh isn't hidden: the stale rates are dropped, so the next read rebuilds them in the open and
      // any error surfaces there as usual.
      .catch(() => cache.delete(key));
    return hit.value;
  }
  if (hit) return hit.value;
  const value = await build();
  cache.set(key, { at: Date.now(), version, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
export const clearPredictCache = () => cache.clear();

// What the screens get: the numbers and the words, not the model's internals.
export const forScreen = (r) => (r ? {
  probability: r.probability, percent: r.percent, confidence: r.confidence, reasons: r.reasons, driver: r.driver,
  ...(r.level ? { level: r.level } : {}), ...(r.fallback ? { fallback: true } : {}),
} : null);
