import { useEffect, useRef } from 'react';
import { getToken } from './api.js';

// The server's live event stream (Server-Sent Events over fetch so the bearer token stays in a header, not the
// URL), reconnecting with backoff. One connection per browser tab, shared by every screen that listens:
// browsers allow only about six open requests to a server over HTTP/1.1, and a stream per component used them
// all up (every other request then hung).
const subs = new Set();
let controller = null;
let running = false;
let last = undefined;
const tell = (s) => { last = s; subs.forEach((x) => x.status.current?.(s)); };

async function connect() {
  running = true;
  let retry = 1000;
  while (subs.size) {
    controller = new AbortController();
    try {
      const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${getToken()}` }, signal: controller.signal });
      // 204: this server doesn't do live updates (serverless hosting).
      if (res.status === 204) { tell(null); break; }
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      tell(true);
      retry = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; /* ignore malformed event */ }
          for (const x of [...subs]) {
            try { x.handler.current?.(event); } catch (err) { console.error('Live event handler failed', err); }
          }
        }
      }
    } catch {
      /* network drop or abort */
    }
    if (!subs.size) break;
    tell(false);
    await new Promise((r) => setTimeout(r, retry));
    retry = Math.min(retry * 2, 30000);
  }
  running = false;
}

export function useLiveEvents(onEvent, onStatus) {
  const handler = useRef(onEvent);
  const status = useRef(onStatus);
  handler.current = onEvent;
  status.current = onStatus;
  useEffect(() => {
    const sub = { handler, status };
    subs.add(sub);
    if (!running) connect();
    else if (last !== undefined) status.current?.(last);
    return () => {
      subs.delete(sub);
      if (!subs.size) { controller?.abort(); last = undefined; }
    };
  }, []);
}
