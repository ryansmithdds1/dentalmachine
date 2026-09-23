import { useEffect, useRef } from 'react';
import { getToken } from './api.js';

// Subscribes to the server's live event stream (Server-Sent Events over fetch so the
// bearer token stays in a header, not the URL). Reconnects with backoff.
export function useLiveEvents(onEvent, onStatus) {
  const handler = useRef(onEvent);
  const status = useRef(onStatus);
  handler.current = onEvent;
  status.current = onStatus;

  useEffect(() => {
    let stopped = false;
    let controller;
    let retry = 1000;

    async function connect() {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${getToken()}` }, signal: controller.signal });
          // 204: this server doesn't do live updates (serverless hosting).
          if (res.status === 204) {
            status.current?.(null);
            return;
          }
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
          status.current?.(true);
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
              if (data) {
                try {
                  handler.current?.(JSON.parse(data));
                } catch {
                  /* ignore malformed event */
                }
              }
            }
          }
        } catch {
          /* network drop or abort */
        }
        status.current?.(false);
        if (stopped) return;
        await new Promise((r) => setTimeout(r, retry));
        retry = Math.min(retry * 2, 30000);
      }
    }
    connect();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }, []);
}
