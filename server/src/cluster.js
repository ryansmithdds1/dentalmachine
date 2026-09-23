import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// Shared state for running several API servers behind a load balancer.
// With REDIS_URL set, live updates, rate limits and background-job locks are shared through Redis.
// Without it, everything stays in this process (fine for a single server).
const local = new EventEmitter();
local.setMaxListeners(0);
let redis = null;
let subscriber = null;
const PREFIX = process.env.REDIS_PREFIX || 'dm';
const CHANNEL = `${PREFIX}:events`;
const nodeId = randomUUID();

export async function initCluster({ redisUrl = process.env.REDIS_URL } = {}) {
  if (!redisUrl || redis) return { mode: redis ? 'redis' : 'single' };
  const { createClient } = await import('redis');
  redis = createClient({ url: redisUrl });
  redis.on('error', (err) => console.error('Redis error:', err.message));
  await redis.connect();
  subscriber = redis.duplicate();
  subscriber.on('error', (err) => console.error('Redis subscriber error:', err.message));
  await subscriber.connect();
  await subscriber.subscribe(CHANNEL, (raw) => {
    try {
      const { channel, event } = JSON.parse(raw);
      local.emit(channel, event);
    } catch {
      /* ignore malformed */
    }
  });
  return { mode: 'redis' };
}

export async function closeCluster() {
  await subscriber?.quit();
  await redis?.quit();
  redis = subscriber = null;
}

export const clusterMode = () => (redis ? 'redis' : 'single');

// Pub/sub: with Redis every server (including this one) receives the event through the subscription.
export function broadcast(channel, event) {
  if (redis) redis.publish(CHANNEL, JSON.stringify({ channel, event })).catch((err) => console.error('Redis publish failed:', err.message));
  else local.emit(channel, event);
}
export const listen = (channel, fn) => local.on(channel, fn);
export const unlisten = (channel, fn) => local.off(channel, fn);

// Fixed-window counter; returns the hit count in the current window.
const windows = new Map();
export async function hit(key, windowMs) {
  if (redis) {
    const k = `${PREFIX}:rl:${key}:${Math.floor(Date.now() / windowMs)}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.pExpire(k, windowMs);
    return n;
  }
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || now - entry.start > windowMs) {
    windows.set(key, { start: now, count: 1, windowMs });
    // Keep memory bounded by dropping only windows that have ended (never live counters).
    if (windows.size > 50_000) for (const [k, e] of windows) if (now - e.start > e.windowMs) windows.delete(k);
    return 1;
  }
  return ++entry.count;
}

// Runs a job on only one server at a time — and only once at a time on this server (reminders, autopay,
// clearinghouse polling). Returns null when the job is already running somewhere.
const running = new Set();
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
export async function runExclusive(name, ttlMs, fn) {
  if (running.has(name)) return null;
  running.add(name);
  try {
    if (!redis) return await fn();
    const key = `${PREFIX}:lock:${name}`;
    const token = `${nodeId}:${randomUUID()}`;
    if (!(await redis.set(key, token, { NX: true, PX: ttlMs }))) return null;
    try {
      return await fn();
    } finally {
      // Delete the lock only if it's still ours (it may have expired and been taken by another server).
      await redis.eval(RELEASE, { keys: [key], arguments: [token] }).catch(() => {});
    }
  } finally {
    running.delete(name);
  }
}
