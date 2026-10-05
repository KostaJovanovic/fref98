// Small non-cryptographic hashes for cache keys and stale detection.

export function hashString(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export function hashBytes(b: Uint8Array): string {
  let h1 = 0x811c9dc5 ^ b.length;
  let h2 = 0x9747b28c;
  const n = b.length;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x5bd1e995) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + n.toString(36);
}

/** Stable JSON (sorted object keys) so equal params always hash equally. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
}

/** Random u32 seed. */
export function newSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] >>> 0;
}

/** Deterministic seed for repeat r of a child step inside a repeat group. */
export function repeatSeed(childSeed: number, groupSeed: number, r: number): number {
  let h = (childSeed ^ Math.imul(groupSeed, 0x9e3779b1) ^ Math.imul(r + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

let uidCounter = 0;
export function uid(prefix = 'u'): string {
  uidCounter = (uidCounter + 1) % 1e6;
  return prefix + Date.now().toString(36) + uidCounter.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
