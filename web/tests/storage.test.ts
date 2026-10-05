// The IndexedDB wrapper against a small in-memory IndexedDB: reopening after a failure or a closed
// connection, and the move from the pre-rename database (audit B3, 07-9).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Store = Map<string, unknown>;
const later = (f: () => void) => setTimeout(f, 0);

class Req<T = unknown> {
  result!: T;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  transaction: { abort(): void } | null = null;
}

class Tx {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;
  private pending = 0;
  constructor(private data: Store) {
    later(() => this.finish());
  }
  private finish() {
    if (this.pending) return later(() => this.finish());
    this.oncomplete?.();
  }
  private req<T>(f: () => T): Req<T> {
    const r = new Req<T>();
    this.pending++;
    later(() => {
      r.result = f();
      r.onsuccess?.();
      this.pending--;
    });
    return r;
  }
  objectStore() {
    const d = this.data;
    return {
      get: (k: string) => this.req(() => d.get(k)),
      put: (v: unknown, k: string) => this.req(() => void d.set(k, v)),
      delete: (k: string) => this.req(() => void d.delete(k)),
      clear: () => this.req(() => d.clear()),
      getAllKeys: () => this.req(() => [...d.keys()]),
      getAll: () => this.req(() => [...d.values()]),
    };
  }
}

class Db {
  closed = false;
  onclose: (() => void) | null = null;
  onversionchange: (() => void) | null = null;
  constructor(public stores: Map<string, Store>) {}
  get objectStoreNames() {
    return { contains: (n: string) => this.stores.has(n) };
  }
  createObjectStore(n: string) {
    this.stores.set(n, new Map());
  }
  transaction(n: string) {
    if (this.closed) throw new Error('InvalidStateError: the connection is closing');
    return new Tx(this.stores.get(n)!);
  }
  close() {
    this.closed = true;
  }
}

class FakeIdb {
  dbs = new Map<string, Map<string, Store>>();
  opened: Db[] = [];
  failOpen = 0;
  open(name: string) {
    const r = new Req<Db>();
    later(() => {
      if (this.failOpen > 0) {
        this.failOpen--;
        r.error = new Error('open failed');
        return r.onerror?.();
      }
      let aborted = false;
      const isNew = !this.dbs.has(name);
      const stores = this.dbs.get(name) ?? new Map<string, Store>();
      const db = new Db(stores);
      r.result = db;
      if (isNew) {
        r.transaction = { abort: () => (aborted = true) };
        (r as any).onupgradeneeded?.();
        if (aborted) {
          r.error = new Error('AbortError');
          return r.onerror?.();
        }
      }
      this.dbs.set(name, stores);
      this.opened.push(db);
      r.onsuccess?.();
    });
    return r;
  }
  deleteDatabase(name: string) {
    this.dbs.delete(name);
  }
}

let idb: FakeIdb;
async function lib() {
  vi.resetModules();
  return import('../src/engine/storage');
}

beforeEach(() => {
  idb = new FakeIdb();
  vi.stubGlobal('indexedDB', idb);
});
afterEach(() => vi.unstubAllGlobals());

describe('storage', () => {
  it('stores and reads values', async () => {
    const s = await lib();
    expect(await s.kvSet('a', 1)).toBe(true);
    expect(await s.kvGet('a')).toBe(1);
    expect(await s.kvKeys('')).toContain('a');
  });

  // 07-9: one failed open used to make every later call fail too
  it('opens again after a failed open', async () => {
    const s = await lib();
    idb.failOpen = 1;
    expect(await s.kvSet('a', 1)).toBe(false);
    expect(await s.kvSet('a', 2)).toBe(true);
    expect(await s.kvGet('a')).toBe(2);
  });

  // 07-9: a connection the browser closed was kept for good
  it('opens again after the connection was closed', async () => {
    const s = await lib();
    await s.kvSet('a', 1);
    idb.opened[0].close();
    expect(await s.kvSet('b', 2)).toBe(true);
    expect(await s.kvGet('b')).toBe(2);
    expect(idb.opened.length).toBe(2);
  });

  it('a failed write tells the error listeners', async () => {
    const s = await lib();
    const seen: unknown[] = [];
    s.onStorageError((e) => seen.push(e));
    idb.failOpen = 1;
    await s.kvSet('a', 1);
    expect(seen.length).toBe(1);
  });

  it('copies the old database over once, without overwriting newer values', async () => {
    idb.dbs.set('jpegit', new Map([['kv', new Map<string, unknown>([['project', 'old'], ['photo:x', 'px']])]]));
    // the new database already exists (an earlier copy was interrupted) and has a newer project
    idb.dbs.set('refragmenter', new Map([['kv', new Map<string, unknown>([['project', 'new']])]]));
    const s = await lib();
    expect(await s.kvGet('project')).toBe('new');
    expect(await s.kvGet('photo:x')).toBe('px');
    expect(idb.dbs.has('jpegit')).toBe(false);
    expect(await s.kvGet('__migrated')).toBe(1);
  });

  it('with no old database it only writes the marker', async () => {
    const s = await lib();
    await s.kvSet('a', 1);
    expect(idb.dbs.has('jpegit')).toBe(false);
    expect(await s.kvGet('__migrated')).toBe(1);
  });
});
