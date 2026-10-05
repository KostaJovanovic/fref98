// Autosave: a tiny IndexedDB key/value wrapper. Photos are stored as raw bytes; the project document as JSON.

const DB = 'refragmenter';
const OLD_DB = 'jpegit'; // before the rename; its autosave is moved over once
const STORE = 'kv';
/** Written once the old database was copied (or found missing), so an interrupted copy is retried. */
const MIGRATED = '__migrated';
let dbp: Promise<IDBDatabase> | null = null;
const errorListeners = new Set<(e: unknown) => void>();

/** Called when a write fails (storage full, blocked, the database went away). */
export function onStorageError(f: (e: unknown) => void): () => void {
  errorListeners.add(f);
  return () => errorListeners.delete(f);
}

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      // a closed connection (browser storage cleared, another tab upgrading) is opened again next time
      db.onclose = () => dbp === p && (dbp = null);
      db.onversionchange = () => {
        db.close();
        if (dbp === p) dbp = null;
      };
      migrate(db).then(() => resolve(db));
    };
    req.onerror = () => reject(req.error);
  });
  dbp = p;
  // a failed open is tried again on the next call instead of failing forever
  p.catch(() => dbp === p && (dbp = null));
  return p;
}

/** Copies everything from the pre-rename database that is not here yet, then deletes the old one. Runs until
 *  it finishes once: the marker is written last. */
function migrate(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      try {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(1, MIGRATED);
        t.oncomplete = t.onerror = t.onabort = () => resolve();
      } catch {
        resolve();
      }
    };
    const marker = db.transaction(STORE, 'readonly').objectStore(STORE).get(MIGRATED);
    marker.onerror = () => resolve();
    marker.onsuccess = () => {
      if (marker.result !== undefined) return resolve();
      let none = false;
      const req = indexedDB.open(OLD_DB);
      // no old database: opening created an empty one, so abort that and stop
      req.onupgradeneeded = () => {
        none = true;
        req.transaction?.abort();
      };
      req.onerror = () => (none ? done() : resolve());
      req.onsuccess = () => {
        const old = req.result;
        if (!old.objectStoreNames.contains(STORE)) {
          old.close();
          return done();
        }
        const rt = old.transaction(STORE, 'readonly').objectStore(STORE);
        const keys = rt.getAllKeys();
        const vals = rt.getAll();
        vals.onsuccess = () => {
          const wt = db.transaction(STORE, 'readwrite');
          const ws = wt.objectStore(STORE);
          const have = ws.getAllKeys();
          have.onsuccess = () => {
            const here = new Set(have.result.map(String));
            keys.result.forEach((k, i) => here.has(String(k)) || ws.put(vals.result[i], k));
          };
          wt.oncomplete = () => {
            old.close();
            indexedDB.deleteDatabase(OLD_DB);
            done();
          };
          wt.onerror = () => resolve();
        };
        vals.onerror = () => resolve();
      };
    };
  });
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void, retry = true): Promise<T | undefined> {
  const db = await open();
  let t: IDBTransaction;
  try {
    t = db.transaction(STORE, mode);
  } catch (e) {
    // the connection closed under us: open a new one, once
    dbp = null;
    if (retry) return tx(mode, f, false);
    throw e;
  }
  return new Promise((resolve, reject) => {
    const s = t.objectStore(STORE);
    const r = f(s);
    let val: T | undefined;
    if (r) r.onsuccess = () => (val = r.result);
    t.oncomplete = () => resolve(val);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    return (await tx<T>('readonly', (s) => s.get(key) as IDBRequest<T>)) as T | undefined;
  } catch {
    return undefined;
  }
}

/** Stores a value. False when it could not be written (the error listeners are told). */
export async function kvSet(key: string, value: unknown): Promise<boolean> {
  try {
    await tx('readwrite', (s) => {
      s.put(value, key);
    });
    return true;
  } catch (e) {
    console.warn('autosave failed', e);
    for (const l of errorListeners) l(e);
    return false;
  }
}

export async function kvDelete(key: string): Promise<void> {
  try {
    await tx('readwrite', (s) => {
      s.delete(key);
    });
  } catch {
    /* ignore */
  }
}

export async function kvKeys(prefix: string): Promise<string[]> {
  try {
    const all = (await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? [];
    return all.map(String).filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
}

export async function kvClear(): Promise<void> {
  try {
    await tx('readwrite', (s) => {
      s.clear();
    });
  } catch {
    /* ignore */
  }
}
