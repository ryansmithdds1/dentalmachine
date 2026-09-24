// TypeSafe AI's Jev as a swappable prediction vendor: a model that returns typed values with probabilities.
// OFF by default (PREDICT_DRIVER=builtin). See docs/predictions.md.
//
//   PREDICT_DRIVER=jev   use this driver (any failure falls back to the built-in model — predict/index.js)
//   JEV_MODE=sandbox     played locally, nothing leaves the server (the default when JEV_API_KEY is unset)
//   JEV_MODE=live        real calls to JEV_URL with JEV_API_KEY — refused unless JEV_BAA=signed: a Business
//                        Associate Agreement must be in place before any patient-derived data is sent.
//
// ********************************************************************************************************
// PLACEHOLDER: Jev's real API isn't published to us. The path, headers and request/response fields below are
// our own guess at a reasonable shape, kept together in MAPPING so fitting the real spec is a change to one
// object. Verify against TypeSafe AI's documentation (and sign the BAA) before turning live mode on.
// ********************************************************************************************************
//
// What leaves the office: only the whitelisted, de-identified features below — counts, rates, categories and an
// opaque per-request reference ("r0", "r1"…). Never names, dates of birth, phone numbers, record ids, dates of
// service, claim numbers or the scrubber's own messages (those can carry tooth numbers and claim ids). Calls go
// through loggedFetch (Settings → Connection activity: host, path, status, time — no bodies).

const STATS = (s) => (s && Number.isFinite(Number(s.n)) ? { n: Number(s.n) || 0, hits: Number(s.hits) || 0 } : null);
const BOOL = (v) => (v == null ? null : !!v);
const NUM = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const CAT = (v) => (v == null ? null : String(v).replace(/[^A-Za-z0-9 &/–-]/g, '').slice(0, 40));
// The only fields that may be sent, per kind, and how each is cleaned.
export const JEV_FIELDS = {
  no_show: {
    practice: STATS, days_ahead: NUM, first_visit: BOOL, first_visit_stats: STATS, confirmed: BOOL, confirmed_stats: STATS,
    lead_days: NUM, lead_stats: STATS, weekday: CAT, weekday_stats: STATS, time_of_day: CAT, time_stats: STATS,
    visit_type: CAT, type_stats: STATS, owes: BOOL, owes_stats: STATS,
    patient: (p) => (p ? Object.fromEntries(['missed_w', 'kept_w', 'no_shows_1y', 'late_cancels_1y', 'missed_2y', 'kept_2y', 'kept_ever']
      .map((k) => [k, NUM(p[k])]).filter(([, v]) => v != null)) : null),
  },
  denial: {
    code: (c) => (/^D\d{4}$/.test(String(c || '')) ? String(c) : null), practice: STATS, payer_stats: STATS, code_stats: STATS,
    payer_code_stats: STATS, narrative: BOOL, payer_code_narr_stats: STATS,
    rules: (r) => (r ? { deny: NUM(r.deny) || 0, narrative: NUM(r.narrative) || 0, warn: NUM(r.warn) || 0 } : null),
  },
};
export function deidentify(kind, features) {
  const spec = JEV_FIELDS[kind];
  if (!spec) throw new Error(`Unknown prediction: ${kind}`);
  const out = {};
  for (const [k, clean] of Object.entries(spec)) {
    const v = clean(features?.[k]);
    if (v != null) out[k] = v;
  }
  return out;
}

// PLACEHOLDER request/response mapping (see the note at the top).
export const MAPPING = {
  path: '/v1/predict',
  headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
  task: { no_show: 'appointment_no_show', denial: 'dental_claim_line_denial' },
  request: (kind, items) => ({ task: MAPPING.task[kind], output: { type: 'probability', of: 'true' }, items }),
  // Expected: { results: [{ ref, value: { probability }, confidence? }] }
  result: (json, refs) => {
    const byRef = new Map((json?.results || []).map((r) => [r.ref, r]));
    return refs.map((ref) => {
      const r = byRef.get(ref);
      const p = Number(r?.value?.probability ?? r?.probability);
      if (!r || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('Jev answered without a probability for every item');
      const c = Number(r.confidence);
      return { probability: p, confidence: Number.isFinite(c) ? (c >= 0.75 ? 'high' : c >= 0.4 ? 'medium' : 'low') : null };
    });
  },
};

// The sandbox: Jev played locally. It answers like the placeholder shape, from the features alone, so tests and
// demos exercise the whole path (payload, parsing, fallback) without any outside call.
export function sandboxFetch() {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const results = body.items.map((it) => {
      const f = it.features;
      let p = 0.08;
      if (f.payer_code_stats) p = (f.payer_code_stats.hits + 1) / (f.payer_code_stats.n + 20);
      else if (f.patient) p = ((f.patient.missed_w || 0) + 0.2) / ((f.patient.missed_w || 0) + (f.patient.kept_w || 0) + 2.5);
      return { ref: it.ref, value: { probability: Math.round(Math.min(0.95, Math.max(0.01, p)) * 100) / 100 }, confidence: 0.5 };
    });
    return { ok: true, status: 200, headers: { get: () => 'jev-sandbox' }, json: async () => ({ results }) };
  };
}

export function jevConfig(env = process.env) {
  const key = env.JEV_API_KEY || null;
  return {
    mode: env.JEV_MODE === 'live' ? 'live' : env.JEV_MODE === 'sandbox' || !key ? 'sandbox' : 'live',
    url: (env.JEV_URL || 'https://api.typesafe.ai').replace(/\/+$/, ''), key, baa: env.JEV_BAA === 'signed', timeoutMs: Number(env.JEV_TIMEOUT_MS) || 4000,
  };
}

// cfg: jevConfig(); fetchImpl: the app's loggedFetch (live mode), or anything shaped like fetch (tests).
export function createJev(cfg, fetchImpl) {
  const live = cfg.mode === 'live';
  const doFetch = live ? fetchImpl : (cfg.sandboxFetch || sandboxFetch());
  return {
    id: 'jev', name: live ? 'Jev (TypeSafe AI)' : 'Jev (sandbox)', sandbox: !live,
    // Returns [{ probability, confidence }] in the order given; throws on any failure.
    async predictMany(kind, list) {
      if (live && !cfg.baa) throw new Error('Jev live mode needs a signed BAA on file (JEV_BAA=signed) before any patient data is sent');
      if (live && !cfg.key) throw new Error('JEV_API_KEY is not set');
      if (!list.length) return [];
      const items = list.map((f, i) => ({ ref: `r${i}`, features: deidentify(kind, f) }));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 4000);
      try {
        const res = await doFetch(`${cfg.url}${MAPPING.path}`, { method: 'POST', headers: MAPPING.headers(cfg.key || 'sandbox'), body: JSON.stringify(MAPPING.request(kind, items)), signal: ctrl.signal });
        if (!res.ok) throw new Error(`Jev answered ${res.status}`);
        return MAPPING.result(await res.json(), items.map((i) => i.ref));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
