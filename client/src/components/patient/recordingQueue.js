// Parts of a long recording waiting to upload, kept on this computer (IndexedDB) so nothing is lost when the
// connection drops or the browser closes: each part stays here until the server has confirmed it. Also remembers
// each recording in progress (its id, how many parts were made) so the page can finish it after a reload.
const DB = 'dm-recordings';
const PARTS = 'parts';
const SESSIONS = 'sessions';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser can’t keep recordings offline')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PARTS)) db.createObjectStore(PARTS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'sid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); resolve(out?.result ?? out); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}
const all = (store) => tx(store, 'readonly', (s) => s.getAll());

export const putPart = (part) => tx(PARTS, 'readwrite', (s) => s.put({ ...part, key: `${part.sid}:${part.seq}` }));
export const dropPart = (sid, seq) => tx(PARTS, 'readwrite', (s) => s.delete(`${sid}:${seq}`));
export const partsFor = async (sid) => (await all(PARTS)).filter((p) => p.sid === sid).sort((a, b) => a.seq - b.seq);
export const putSession = (session) => tx(SESSIONS, 'readwrite', (s) => s.put(session));
export const dropSession = (sid) => tx(SESSIONS, 'readwrite', (s) => s.delete(sid));
export const openSessions = async (patientId) => (await all(SESSIONS)).filter((s) => !patientId || s.patientId === patientId);
