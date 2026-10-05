// LRU cache of step results, bounded by a memory budget in bytes.

export interface Sized {
  byteLength: number;
}

export class LruCache<V extends Sized> {
  private map = new Map<string, V>();
  private total = 0;
  hits = 0;
  misses = 0;

  constructor(public budget: number) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // refresh recency
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, v: V): void {
    const old = this.map.get(key);
    if (old !== undefined) {
      this.total -= old.byteLength;
      this.map.delete(key);
    }
    if (v.byteLength > this.budget) return; // never cache something bigger than the whole budget
    this.map.set(key, v);
    this.total += v.byteLength;
    this.evict();
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.total -= v.byteLength;
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  setBudget(b: number) {
    this.budget = b;
    this.evict();
  }

  private evict() {
    while (this.total > this.budget && this.map.size) {
      const k = this.map.keys().next().value as string;
      this.delete(k);
    }
  }
}

/** 1 GB on desktop, 400 MB on phones (Q25); step results are JPEG bytes so this is generous. */
export function defaultBudget(): number {
  const phone = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return (phone ? 400 : 1024) * 1024 * 1024 * 0.5;
}
