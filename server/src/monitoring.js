import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

// ---- Structured logs ----
// One line per event. LOG_FORMAT=json (the default in production) writes JSON a log service can index;
// text is easier to read in a terminal. Fields never include request bodies or patient details.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Error messages can quote the data that caused them (a database error naming the value it rejected, a
// parse error echoing input). Logs and error reports get the shape of the problem, never the values.
export function scrubMessage(text) {
  return String(text ?? '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'…'")
    .replace(/\(([^()]*)\)=\(([^()]*)\)/g, '($1)=(…)')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\d[\d\s().-]{5,}\d/g, '[number]');
}

export function createLogger({ format = process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'text'), level = process.env.LOG_LEVEL || 'info', write } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const out = write || ((lvl, line) => (lvl >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`));
  const emit = (lvl, args) => {
    if (LEVELS[lvl] < min) return;
    // log.info('Sent 3 reminders'), log.error('Backup failed:', err), log.info('request', { status: 200 })
    const fields = {};
    const words = [];
    for (const a of args) {
      if (a instanceof Error) Object.assign(fields, { error: scrubMessage(a.message), stack: scrubMessage(a.stack) });
      else if (a && typeof a === 'object') Object.assign(fields, a);
      else words.push(String(a));
    }
    const msg = words.join(' ');
    if (format === 'json') out(LEVELS[lvl], JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields }));
    else {
      const extra = Object.entries(fields).filter(([k]) => k !== 'stack').map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
      out(LEVELS[lvl], `${lvl === 'info' ? '' : `${lvl.toUpperCase()} `}${msg}${extra ? ` ${extra}` : ''}${fields.stack && lvl === 'error' ? `\n${fields.stack}` : ''}`);
    }
  };
  return Object.fromEntries(Object.keys(LEVELS).map((l) => [l, (...args) => emit(l, args)]));
}

export const log = createLogger();

// ---- Error monitoring (Sentry, or anything that speaks its envelope API: GlitchTip, Bugsink…) ----
// Set SENTRY_DSN. Events carry the error, stack, route pattern, request id, and the user and practice
// ids — never request bodies, query strings or patient data.
export function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, '').split('/').pop();
    if (!u.username || !project) return null;
    const prefix = u.pathname.replace(/\/?[^/]+\/?$/, '');
    return { key: u.username, endpoint: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, dsn };
  } catch {
    return null;
  }
}

const frames = (stack) => String(stack || '').split('\n').slice(1).map((line) => {
  const m = /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line.trim());
  return m ? { function: m[1] || '<anonymous>', filename: m[2].replace(/^file:\/\//, ''), lineno: Number(m[3]), colno: Number(m[4]), in_app: !m[2].includes('node_modules') && !m[2].startsWith('node:') } : null;
}).filter(Boolean).reverse(); // Sentry lists the outermost frame first

export function createErrorReporter({ dsn = process.env.SENTRY_DSN, environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development', release = process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || null, fetchImpl = globalThis.fetch, logger = log } = {}) {
  const target = dsn ? parseDsn(dsn) : null;
  if (dsn && !target) logger.warn('SENTRY_DSN is not a valid DSN; error reports are off');
  // At most 30 reports a minute, and the same error once a minute, so an outage can't flood the service.
  let windowStart = Date.now();
  let sent = 0;
  const recent = new Map();
  const capture = (err, { platform = 'node', tags = {}, user = null, request = null, extra = {} } = {}) => {
    if (!target) return null;
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; sent = 0; recent.clear(); }
    const key = `${err?.name}:${err?.message}:${tags.route || ''}`;
    if (sent >= 30 || recent.has(key)) return null;
    sent++;
    recent.set(key, now);
    const eventId = randomUUID().replace(/-/g, '');
    const event = {
      event_id: eventId, timestamp: now / 1000, platform, level: 'error', environment, ...(release ? { release } : {}), server_name: hostname(),
      exception: { values: [{ type: err?.name || 'Error', value: scrubMessage(err?.message || err).slice(0, 1000), stacktrace: { frames: frames(err?.stack) } }] },
      tags: Object.fromEntries(Object.entries(tags).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])),
      ...(user ? { user } : {}), ...(request ? { request } : {}), extra,
    };
    const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: target.dsn })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
    fetchImpl(target.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=dental-machine/1.0, sentry_key=${target.key}` },
      body,
    }).catch((e) => logger.warn('Error report not sent:', e.message));
    return eventId;
  };
  return { enabled: !!target, capture };
}

// Route pattern for logs and error grouping: the matched Express route, else the path with ids masked.
export const routeOf = (req) => (req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : req.path.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:token'));

// Every API request: a request id (kept from X-Request-Id or made up) and one log line when it finishes.
export function requestLogger(logger = log) {
  return (req, res, next) => {
    const id = /^[\w.-]{8,64}$/.test(req.headers['x-request-id'] || '') ? req.headers['x-request-id'] : randomUUID();
    req.id = id;
    res.set('X-Request-Id', id);
    if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const fields = { method: req.method, route: routeOf(req), status: res.statusCode, ms: Math.round(ms), request_id: id, ...(req.user ? { user_id: req.user.id, practice_id: req.user.practice_id } : {}) };
      if (res.statusCode >= 500) logger.error('request', fields);
      else if (ms > 2000) logger.warn('slow request', fields);
      else if (process.env.NODE_ENV === 'production') logger.info('request', fields);
      else logger.debug('request', fields);
    });
    next();
  };
}
