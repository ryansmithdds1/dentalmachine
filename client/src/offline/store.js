// Where the offline copy and the queued changes live on this computer: IndexedDB, every record sealed with
// AES-GCM (crypto.subtle). The keys come from the server at sign-in (GET /offline/key) and are never
// stored next to the data:
//   - the snapshot key belongs to this sign-in; it is kept in memory and in this tab's sessionStorage (like the
//     session token itself), so a reload during an outage can still open the copy. Closing the tab or signing
//     out loses it, and the copy is unreadable from then on (and wiped at the next sign-out or sign-in).
//   - the outbox key belongs to this person (it changes when their password changes or they sign out
//     everywhere), so changes queued offline survive an idle sign-out and are sent after they sign in again.
// Nothing here imports the rest of the app, so the server's test runner can check it in Node.

const DB_NAME = 'dm-offline';
const STORES = ['snapshot', 'outbox'];
const KEYS_ITEM = 'dm_offline_keys';

const enc = new TextEncoder();
const dec = new TextDecoder();
// In slices: a whole day's copy is megabytes, too many arguments for one String.fromCharCode call.
export const toB64 = (bytes) => {
  const u = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('This browser can’t encrypt an offline copy (it needs a secure https:// page)');
  return s;
};

// A 32-byte key (base64, from the server) as an AES-GCM key that can't be read back out.
export async function importKey(b64) {
  const raw = fromB64(b64);
  if (raw.length !== 32) throw new Error('Offline key must be 32 bytes');
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Seals a value as JSON. `label` (the record's id and owner) is bound in as additional data, so a sealed
// record can't be swapped in for another one.
export async function seal(key, value, label = '') {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, enc.encode(JSON.stringify(value)));
  return { v: 1, iv: toB64(iv), data: toB64(data) };
}

// Opens a sealed value; throws if the key or label is wrong or the data was altered.
export async function unseal(key, sealed, label = '') {
  if (!sealed || sealed.v !== 1) throw new Error('Unknown offline record format');
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: enc.encode(label) }, key, fromB64(sealed.data));
  return JSON.parse(dec.decode(plain));
}

// ---- Storage backends: IndexedDB in the browser, a Map in tests ----

export function memoryBackend() {
  const stores = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  return {
    get: async (store, id) => structuredClone(stores[store].get(id) ?? null),
    put: async (store, rec) => { stores[store].set(rec.id, structuredClone(rec)); },
    del: async (store, id) => { stores[store].delete(id); },
    all: async (store) => [...stores[store].values()].map((r) => structuredClone(r)),
    clear: async (store) => { stores[store].clear(); },
  };
}

export function idbBackend(name = DB_NAME) {
  let opening = null;
  const open = () => (opening ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('This browser has no offline storage'));
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  }));
  const run = async (store, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Offline storage was interrupted'));
    });
  };
  return {
    get: (store, id) => run(store, 'readonly', (s) => s.get(id)),
    put: (store, rec) => run(store, 'readwrite', (s) => s.put(rec)).then(() => undefined),
    del: (store, id) => run(store, 'readwrite', (s) => s.delete(id)).then(() => undefined),
    all: (store) => run(store, 'readonly', (s) => s.getAll()).then((r) => r || []),
    clear: (store) => run(store, 'readwrite', (s) => s.clear()).then(() => undefined),
  };
}

// ---- The keys for this sign-in ----

let held = null; // { snapshot: CryptoKey, outbox: CryptoKey, keyId, owner, maxAgeHours }

// From GET /offline/key: remembers the keys for this tab (see the top of this file for why sessionStorage).
export async function setKeys(k) {
  held = {
    snapshot: await importKey(k.session_key), outbox: await importKey(k.outbox_key), keyId: k.key_id,
    owner: `${k.practice_id}:${k.user_id}`, maxAgeHours: k.max_age_hours || 14,
  };
  try { sessionStorage.setItem(KEYS_ITEM, JSON.stringify(k)); } catch { /* storage blocked: memory only, lost on reload */ }
  return held;
}

// The keys, from memory or (after a reload in this tab) from sessionStorage; null when there are none.
export async function getKeys() {
  if (held) return held;
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(KEYS_ITEM) || 'null'); } catch { /* storage blocked */ }
  if (!saved) return null;
  try {
    return await setKeys(saved);
  } catch {
    return null;
  }
}

export function forgetKeys() {
  held = null;
  try { sessionStorage.removeItem(KEYS_ITEM); } catch { /* storage blocked */ }
}
