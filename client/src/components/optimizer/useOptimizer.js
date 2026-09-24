import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useLiveEvents } from '../../live.js';

// Today's plan (GET /optimizer/today), shared: the huddle card, the side panel and the markers on the schedule all
// read one copy per day and office, fetched once and re-fetched (once, however many screens listen) whenever the
// schedule changes — the live event every schedule change already sends, over the one shared connection.
const stores = new Map();
function storeFor(path) {
  let s = stores.get(path);
  if (s) return s;
  s = {
    data: null, error: null, ai: null, aiError: null, loading: false, listeners: new Set(), timer: null,
    tell() { this.listeners.forEach((f) => f()); },
    async load() {
      this.loading = true;
      try {
        this.data = await api.get(path);
        this.error = null;
      } catch (e) {
        this.error = e;
      }
      this.loading = false;
      this.tell();
    },
    // Several changes in a row (a move, its procedures, the live event) make one fetch.
    soon() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.load(), 350);
    },
    async explain() {
      this.aiError = null;
      this.ai = { loading: true };
      this.tell();
      try {
        const d = await api.get(`${path}&explain=1`);
        this.data = d;
        this.ai = d.ai;
        this.aiError = d.ai_error || null;
      } catch (e) {
        this.ai = null;
        this.aiError = e.message;
      }
      this.tell();
    },
  };
  stores.set(path, s);
  return s;
}

export const optimizerPath = (date, locationId) => (date ? `/optimizer/today?date=${date}${locationId ? `&location_id=${locationId}` : ''}` : null);

export function useOptimizer(date, locationId, { enabled = true } = {}) {
  const path = enabled ? optimizerPath(date, locationId) : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!path) return undefined;
    const s = storeFor(path);
    const f = () => tick((n) => n + 1);
    s.listeners.add(f);
    if (!s.data && !s.loading) s.load();
    return () => { s.listeners.delete(f); };
  }, [path]);
  useLiveEvents((e) => {
    if (!path || !['schedule', 'optimizer', 'tasks'].includes(e.type)) return;
    if (e.dates && !e.dates.includes(date)) return;
    storeFor(path).soon();
  });
  const s = path ? storeFor(path) : null;
  return {
    data: s?.data || null, error: s?.error || null, ai: s?.ai || null, aiError: s?.aiError || null,
    reload: () => s?.load(), soon: () => s?.soon(), explain: () => s?.explain(),
    // The route isn't there (not switched on for this server yet): screens stay quiet.
    missing: s?.error?.status === 404,
  };
}

// Opening the panel from anywhere (a marker on the schedule, the huddle card): the panel's host listens.
export const openOptimizer = (id = null) => window.dispatchEvent(new CustomEvent('dm:optimizer', { detail: { id } }));

export const ACTION_LABEL = {
  attach: 'Add to visit', finder_add: 'Add to visit', book: 'Book it', move_up: 'Move visit up', shorten: 'Shorten',
  confirm: 'Send reminder', text_offer: 'Text offer', text: 'Text them',
};
export const KIND_LABEL = {
  treatment: 'Planned treatment', finder: 'Due today', family: 'Family', fill: 'Fill open time', shorten: 'Shorten', confirm: 'No-show risk',
};
