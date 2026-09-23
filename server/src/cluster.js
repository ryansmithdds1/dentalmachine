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
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 50_000) windows.clear();
    return 1;
  }
  return ++entry.count;
}

// Runs a background job on only one server at a time (reminders, autopay, clearinghouse polling).
export async function runExclusive(name, ttlMs, fn) {
  if (!redis) return fn();
  const key = `${PREFIX}:lock:${name}`;
  const ok = await redis.set(key, nodeId, { NX: true, PX: ttlMs });
  if (!ok) return null;
  try {
    return await fn();
  } finally {
    if ((await redis.get(key)) === nodeId) await redis.del(key);
  }
}
