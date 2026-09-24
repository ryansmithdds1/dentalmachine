import { useState } from 'react';

// Notices at the top of the schedule (late patients, a chair running behind) that a person can hide for the day.
// A dismissal is this person's own convenience on this computer: it never changes a visit, a message or anything
// in Needs attention, and it only hides what was on screen when they hid it. Each notice is a key plus its
// "parts" (e.g. which patients are late and how late): when a part appears that wasn't there when it was hidden
// (someone new is late, someone became very late), the notice comes back. A new day starts clean.
const storeKey = (userId) => `dm_sched_hidden_notices_${userId || 'anon'}`;

function read(userId, day) {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(userId)) || 'null');
    return v && v.day === day && v.items && typeof v.items === 'object' ? v.items : {};
  } catch {
    return {};
  }
}
function write(userId, day, items) {
  try {
    localStorage.setItem(storeKey(userId), JSON.stringify({ day, items }));
  } catch {
    /* storage unavailable: the notice is just hidden until the page reloads */
  }
}

// Hidden while every part now on screen was already there when it was hidden.
export const stillHidden = (dismissed, parts) => Array.isArray(dismissed) && parts.every((p) => dismissed.includes(p));

export function useHiddenNotices(userId, day) {
  // Kept in memory too, so hiding works for the session even where storage is blocked. Keyed by person and day:
  // when the day rolls over (or someone else signs in on this tab) it starts from what's stored for them today.
  const k = `${userId}|${day}`;
  const [state, setState] = useState(() => ({ k, items: read(userId, day) }));
  const items = state.k === k ? state.items : read(userId, day);
  const save = (next) => { setState({ k, items: next }); write(userId, day, next); };
  return {
    items,
    isHidden: (key, parts) => stillHidden(items[key], parts),
    hide: (key, parts) => save({ ...items, [key]: [...parts] }),
    showAll: () => save({}),
  };
}
