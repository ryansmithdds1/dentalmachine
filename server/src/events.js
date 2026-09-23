import { broadcast, listen, unlisten } from './cluster.js';

// Pub/sub so every open schedule updates live — across all servers when Redis is configured.
export function publish(practiceId, event) {
  broadcast(`practice:${practiceId}`, { ...event, at: Date.now() });
}

// Server-Sent Events stream of practice events for the signed-in user.
// LIVE_UPDATES=off (serverless hosting, where a request can't stay open) answers 204 so clients stop.
export function eventStream(req, res) {
  if (process.env.LIVE_UPDATES === 'off') return res.status(204).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const channel = `practice:${req.user.practice_id}`;
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  listen(channel, send);
  req.on('close', () => {
    clearInterval(heartbeat);
    unlisten(channel, send);
  });
}
