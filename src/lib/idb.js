// Durable record storage for the offline outbox: IndexedDB (survives app close, phone restart and
// app updates; the service worker never touches it), with a localStorage fallback when IndexedDB
// cannot be opened (some private modes). One record per queued change, so two tabs never
// overwrite each other's changes.
//
//   const storage = openOutboxStorage();
//   await storage.put('ops', op); await storage.del('ops', op.id); const { ops, rejected } = await storage.load();
import { readJSON, writeJSON } from './storage.js';

const DB_NAME = 'tyler-tracker';
const DB_VERSION = 1;
/** @type {Array<'ops' | 'rejected'>} */
const STORES = ['ops', 'rejected'];

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}

/**
 * @param {IDBDatabase} db @param {string} store @param {IDBTransactionMode} mode
 * @param {(s: IDBObjectStore) => IDBRequest | void} fn
 * @returns {Promise<any>}
 */
function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    // Resolve on commit, not on the request: the record is on disk only then.
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}

/** localStorage version of the same interface. @returns {import('../data/outbox.js').OutboxStorage} */
export function localOutboxStorage() {
  /** @param {string} s */
  const read = (s) => readJSON(`outbox.${s}`, /** @type {Record<string, any>} */ ({})) || {};
  return {
    async load() {
      return { ops: Object.values(read('ops')), rejected: Object.values(read('rejected')) };
    },
    async put(store, record) {
      const all = read(store);
      all[record.id] = record;
      writeJSON(`outbox.${store}`, all);
    },
    async del(store, id) {
      const all = read(store);
      if (!(id in all)) return;
      delete all[id];
      writeJSON(`outbox.${store}`, all);
    },
  };
}

/** @returns {import('../data/outbox.js').OutboxStorage} */
export function openOutboxStorage() {
  /** @type {Promise<IDBDatabase | null>} */
  const dbp = openDb().catch((e) => {
    console.warn('IndexedDB unavailable, the outbox uses localStorage', e);
    return null;
  });
  const fallback = localOutboxStorage();
  return {
    async load() {
      const db = await dbp;
      // Anything a fallback session stored is read as well (and moved over on the next change).
      const local = await fallback.load();
      if (!db) return local;
      const [ops, rejected] = await Promise.all(STORES.map((s) => tx(db, s, 'readonly', (st) => st.getAll())));
      const merge = (/** @type {any[]} */ a, /** @type {any[]} */ b) => [...a, ...b.filter((x) => !a.some((y) => y.id === x.id))];
      return { ops: merge(ops || [], local.ops), rejected: merge(rejected || [], local.rejected) };
    },
    async put(store, record) {
      const db = await dbp;
      if (!db) return fallback.put(store, record);
      await tx(db, store, 'readwrite', (st) => st.put(record));
    },
    async del(store, id) {
      const db = await dbp;
      await fallback.del(store, id); // in case it was stored there by an earlier session
      if (db) await tx(db, store, 'readwrite', (st) => st.delete(id));
    },
  };
}

/** Ask the browser not to evict this site's storage under pressure (best effort). */
export function requestPersistentStorage() {
  try {
    /** @type {any} */ (navigator).storage?.persist?.().catch(() => {});
  } catch {
    /* not supported */
  }
}
