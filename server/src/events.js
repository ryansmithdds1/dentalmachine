import { EventEmitter } from 'node:events';

// In-process pub/sub so every open schedule updates live. For multiple server
// instances, swap this for Redis pub/sub or Postgres LISTEN/NOTIFY.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(practiceId, event) {
  bus.emit(`practice:${practiceId}`, { ...event, at: Date.now() });
}

// Server-Sent Events stream of practice events for the signed-in user.
export function eventStream(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const channel = `practice:${req.user.practice_id}`;
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  bus.on(channel, send);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off(channel, send);
  });
}
