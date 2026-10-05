// Autosave: a tiny IndexedDB key/value wrapper. Photos are stored as raw bytes; the project document as JSON.

const DB = 'refragmenter';
const OLD_DB = 'jpegit'; // before the rename; its autosave is moved over once
const STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    let fresh = false;
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
      fresh = true;
    };
    req.onsuccess = () => (fresh ? migrate(req.result).then(() => resolve(req.result)) : resolve(req.result));
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

/** Copies everything from the pre-rename database into a freshly created one, then deletes the old one. */
function migrate(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.open(OLD_DB);
    // no old database: opening created an empty one, so abort that and stop
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onerror = () => resolve();
    req.onsuccess = () => {
      const old = req.result;
      if (!old.objectStoreNames.contains(STORE)) {
        old.close();
        return resolve();
      }
      const rt = old.transaction(STORE, 'readonly').objectStore(STORE);
      const keys = rt.getAllKeys();
      const vals = rt.getAll();
      vals.onsuccess = () => {
        const wt = db.transaction(STORE, 'readwrite');
        const ws = wt.objectStore(STORE);
        keys.result.forEach((k, i) => ws.put(vals.result[i], k));
        wt.oncomplete = () => {
          old.close();
          indexedDB.deleteDatabase(OLD_DB);
          resolve();
        };
        wt.onerror = () => resolve();
      };
      vals.onerror = () => resolve();
    };
  });
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
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

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    await tx('readwrite', (s) => {
      s.put(value, key);
    });
  } catch (e) {
    console.warn('autosave failed', e);
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
