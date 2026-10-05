// The recipe model: an ordered list of steps (plus "Repeat N times" groups and hex-edit patches), and the
// runner that executes it with a per-step result cache, recomputing only from the first changed step.
import type { StepInfo } from './types';
import { hashBytes, hashString, newSeed, repeatSeed, stableJson, uid } from './hash';
import { LruCache } from './cache';

export interface StepItem {
  type: 'step';
  uid: string;
  id: string;
  params: Record<string, unknown>;
  seed: number;
  enabled: boolean;
}

export interface RepeatItem {
  type: 'repeat';
  uid: string;
  times: number;
  seed: number;
  enabled: boolean;
  children: StepItem[];
}

export interface BytePatch {
  offset: number;
  bytes: number[];
}

export interface PatchItem {
  type: 'patch';
  uid: string;
  enabled: boolean;
  patches: BytePatch[];
  /** Hash of the input bytes when the patch was recorded. A different input makes the patch stale (Q13). */
  baseHash: string;
}

export type StackNode = StepItem | RepeatItem | PatchItem;

export type NodeStatus = 'ok' | 'cached' | 'disabled' | 'error' | 'unavailable' | 'stale' | 'pending';

export interface NodeResult {
  uid: string;
  key: string;
  status: NodeStatus;
  error?: string;
  ms?: number;
  size?: number;
}

export interface PoolSpec {
  /** Signature of every pool photo's current bytes (changes when any pool photo or its own stack changes). */
  key: string;
  /** Pool photo uids in pool order, EXCLUDING the image being edited. */
  uids: string[];
  /** Lazily produce the bytes (only called when a step really needs the pool). */
  photos: () => Promise<Uint8Array[]>;
}

export type ApplyFn = (id: string, params: Record<string, unknown>, input: Uint8Array, seed: number, pool: { key: string; photos: Uint8Array[] } | null) => Promise<Uint8Array>;

export interface RunOptions {
  apply: ApplyFn;
  cache: LruCache<Uint8Array>;
  catalog: Map<string, StepInfo>;
  pool: PoolSpec | null;
  /** Ask to stop between steps. */
  shouldStop?: () => boolean;
  onStep?: (index: number, total: number, node: StackNode) => void;
  /** Classifies errors; return 'unavailable' for "not implemented yet" errors. */
  classify?: (e: unknown) => 'unavailable' | 'error' | 'cancel';
}

export interface RunResult {
  output: Uint8Array;
  results: NodeResult[];
  stopped: boolean;
}

/** Remembers failures per cache key so a cached run still shows which steps failed. */
const statusMemo = new Map<string, { status: NodeStatus; error?: string }>();

export class StopError extends Error {
  constructor() {
    super('stopped');
  }
}

// ------------------------------------------------------------------ construction helpers

export function defaultsFor(info: StepInfo | undefined): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (!info) return p;
  for (const prm of info.params) p[prm.id] = structuredCloneSafe(prm.default);
  return p;
}

function structuredCloneSafe<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

export function makeStep(id: string, info: StepInfo | undefined, overrides: Record<string, unknown> = {}, seed?: number): StepItem {
  return {
    type: 'step',
    uid: uid('s'),
    id,
    params: { ...defaultsFor(info), ...overrides },
    seed: seed ?? newSeed(),
    enabled: true,
  };
}

export function makeRepeat(times: number, children: StepItem[], seed?: number): RepeatItem {
  return { type: 'repeat', uid: uid('r'), times: Math.max(1, Math.round(times)), seed: seed ?? newSeed(), enabled: true, children };
}

export function makePatch(baseHash: string, patches: BytePatch[] = []): PatchItem {
  return { type: 'patch', uid: uid('p'), enabled: true, patches, baseHash };
}

export function cloneNodes(nodes: StackNode[]): StackNode[] {
  return JSON.parse(JSON.stringify(nodes)) as StackNode[];
}

/** Applies byte patches to a copy of the input. Offsets past the end are ignored. */
export function applyPatches(input: Uint8Array, patches: BytePatch[]): Uint8Array {
  const out = input.slice();
  for (const p of patches) {
    for (let i = 0; i < p.bytes.length; i++) {
      const o = p.offset + i;
      if (o >= 0 && o < out.length) out[o] = p.bytes[i] & 255;
    }
  }
  return out;
}

/** Records/merges a single-byte edit into a patch list. */
export function setPatchedByte(patches: BytePatch[], offset: number, value: number): BytePatch[] {
  const out = patches.map((p) => ({ offset: p.offset, bytes: p.bytes.slice() }));
  for (const p of out) {
    if (offset >= p.offset && offset < p.offset + p.bytes.length) {
      p.bytes[offset - p.offset] = value & 255;
      return out;
    }
    if (offset === p.offset + p.bytes.length) {
      p.bytes.push(value & 255);
      return out;
    }
  }
  out.push({ offset, bytes: [value & 255] });
  out.sort((a, b) => a.offset - b.offset);
  return out;
}

// ------------------------------------------------------------------ analysis

export function usesPool(node: StepItem, info: StepInfo | undefined): boolean {
  if (!info) return false;
  return info.uses_pool || info.params.some((p) => p.kind === 'photo');
}

/** Maps photo params from pool uids to indices in the pool list handed to the engine. */
export function resolvePhotoParams(params: Record<string, unknown>, info: StepInfo | undefined, uids: string[]): Record<string, unknown> {
  if (!info) return params;
  const out = { ...params };
  for (const p of info.params) {
    if (p.kind !== 'photo') continue;
    const v = out[p.id];
    if (typeof v === 'string') {
      const idx = uids.indexOf(v);
      out[p.id] = idx;
    } else if (typeof v !== 'number') out[p.id] = -1;
  }
  return out;
}

/** Positions (node uids) where the engine silently decodes + re-encodes because a pixel/coefficient step
 *  follows a byte-level change (Q12). The UI shows a visible marker there. */
export function reencodeMarkers(nodes: StackNode[], catalog: Map<string, StepInfo>): Set<string> {
  const marks = new Set<string>();
  let dirtyBytes = false;
  const visit = (n: StepItem) => {
    const info = catalog.get(n.id);
    const layer = info?.layer;
    if (layer === 'pixel' || layer === 'coeff') {
      if (dirtyBytes) marks.add(n.uid);
      dirtyBytes = false;
    } else if (layer === 'byte' || layer === 'card') {
      dirtyBytes = true;
    }
  };
  for (const n of nodes) {
    if (!n.enabled) continue;
    if (n.type === 'step') visit(n);
    else if (n.type === 'repeat') {
      for (let r = 0; r < Math.min(2, n.times); r++) for (const c of n.children) if (c.enabled) visit(c);
    } else if (n.type === 'patch') dirtyBytes = true;
  }
  return marks;
}

export function nodeSignature(n: StackNode): string {
  if (n.type === 'step') return 'S' + n.id + ':' + n.seed + ':' + stableJson(n.params);
  if (n.type === 'repeat')
    return 'R' + n.times + ':' + n.seed + ':' + n.children.filter((c) => c.enabled).map(nodeSignature).join(';');
  return 'P' + n.baseHash + ':' + stableJson(n.patches);
}

function nodeUsesPool(n: StackNode, catalog: Map<string, StepInfo>): boolean {
  if (n.type === 'step') return usesPool(n, catalog.get(n.id));
  if (n.type === 'repeat') return n.children.some((c) => c.enabled && usesPool(c, catalog.get(c.id)));
  return false;
}

/** Cache keys for every node, without running anything. key[i] identifies the output of node i. */
export function chainKeys(sourceKey: string, nodes: StackNode[], catalog: Map<string, StepInfo>, poolKey: string): string[] {
  let k = 'src:' + sourceKey;
  const keys: string[] = [];
  for (const n of nodes) {
    if (n.enabled && !(n.type === 'repeat' && (n.times < 1 || !n.children.some((c) => c.enabled)))) {
      const sig = nodeSignature(n) + (nodeUsesPool(n, catalog) ? '|pool:' + poolKey : '');
      k = hashString(k + '|' + sig);
    }
    keys.push(k);
  }
  return keys;
}

// ------------------------------------------------------------------ runner

export async function runStack(sourceKey: string, source: Uint8Array, nodes: StackNode[], opt: RunOptions): Promise<RunResult> {
  const poolKey = opt.pool?.key ?? '';
  const keys = chainKeys(sourceKey, nodes, opt.catalog, poolKey);
  const results: NodeResult[] = nodes.map((n, i) => ({ uid: n.uid, key: keys[i], status: 'pending' as NodeStatus }));
  const classify = opt.classify ?? (() => 'error' as const);

  // Find the last node whose output is cached: start from there.
  let start = 0;
  let cur = source;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const hit = opt.cache.get(keys[i]);
    if (hit) {
      cur = hit;
      start = i + 1;
      break;
    }
  }
  for (let i = 0; i < start; i++) {
    const memo = statusMemo.get(keys[i]);
    results[i].status = !nodes[i].enabled ? 'disabled' : memo ? memo.status : 'cached';
    if (memo) results[i].error = memo.error;
  }

  let poolCache: { key: string; photos: Uint8Array[] } | null = null;
  const poolFor = async (): Promise<{ key: string; photos: Uint8Array[] } | null> => {
    if (!opt.pool) return null;
    if (!poolCache) poolCache = { key: opt.pool.key, photos: await opt.pool.photos() };
    return poolCache;
  };

  const runOne = async (s: StepItem, input: Uint8Array, seed: number): Promise<Uint8Array> => {
    const info = opt.catalog.get(s.id);
    if (!info) throw Object.assign(new Error(`step "${s.id}" is not available yet`), { unavailable: true });
    const needPool = usesPool(s, info);
    const pool = needPool ? await poolFor() : null;
    const params = needPool ? resolvePhotoParams(s.params, info, opt.pool?.uids ?? []) : s.params;
    return opt.apply(s.id, params, input, seed >>> 0, pool);
  };

  let stopped = false;
  // After a real error, nothing downstream is cached: the error may be a one-off (a restarted worker,
  // out of memory), and a cached result would hide it and never run the failed step again.
  let failed = false;
  for (let i = start; i < nodes.length; i++) {
    const n = nodes[i];
    const r = results[i];
    if (opt.shouldStop?.()) {
      stopped = true;
      break;
    }
    opt.onStep?.(i, nodes.length, n);
    if (!n.enabled) {
      r.status = 'disabled';
      continue;
    }
    const t0 = performance.now();
    try {
      if (n.type === 'step') {
        cur = await runOne(n, cur, n.seed);
      } else if (n.type === 'repeat') {
        const kids = n.children.filter((c) => c.enabled);
        for (let rep = 0; rep < n.times && kids.length; rep++) {
          for (const c of kids) {
            if (opt.shouldStop?.()) throw new StopError();
            cur = await runOne(c, cur, repeatSeed(c.seed, n.seed, rep));
          }
        }
      } else {
        if (hashBytes(cur) !== n.baseHash) {
          r.status = 'stale';
          r.size = cur.length;
          // remembered, so a later cached run still shows the patch as not applied
          statusMemo.set(keys[i], { status: 'stale' });
          continue; // stale patches are never silently re-applied
        }
        cur = applyPatches(cur, n.patches);
      }
      r.status = 'ok';
      r.ms = Math.round(performance.now() - t0);
      statusMemo.delete(keys[i]);
      if (!failed) opt.cache.set(keys[i], cur);
    } catch (e) {
      if (e instanceof StopError) {
        stopped = true;
        break;
      }
      const kind = (e as { unavailable?: boolean })?.unavailable ? 'unavailable' : classify(e);
      if (kind === 'cancel') {
        stopped = true;
        break;
      }
      r.status = kind;
      if (kind === 'error') failed = true;
      r.error = e instanceof Error ? e.message : String(e);
      statusMemo.set(keys[i], { status: kind, error: r.error });
      if (statusMemo.size > 500) statusMemo.delete(statusMemo.keys().next().value as string);
      // failing steps pass their input through so the rest of the recipe still runs
    }
    r.size = cur.length;
  }
  for (const r of results) if (r.status === 'pending' && !stopped) r.status = 'ok';
  return { output: cur, results, stopped };
}

/** Rewrites a hex patch's base after the user confirmed re-applying it to the new input. */
export function rebasePatch(p: PatchItem, input: Uint8Array): PatchItem {
  return { ...p, baseHash: hashBytes(input) };
}

// ------------------------------------------------------------------ editing operations (pure)

export function moveNode(nodes: StackNode[], from: number, to: number): StackNode[] {
  const out = nodes.slice();
  if (from < 0 || from >= out.length) return out;
  to = Math.max(0, Math.min(out.length - 1, to));
  const [n] = out.splice(from, 1);
  out.splice(to, 0, n);
  return out;
}

export function replaceNode(nodes: StackNode[], uidv: string, f: (n: StackNode) => StackNode): StackNode[] {
  return nodes.map((n) => {
    if (n.uid === uidv) return f(n);
    if (n.type === 'repeat' && n.children.some((c) => c.uid === uidv)) {
      return { ...n, children: n.children.map((c) => (c.uid === uidv ? (f(c) as StepItem) : c)) };
    }
    return n;
  });
}

export function findNode(nodes: StackNode[], uidv: string): StackNode | undefined {
  for (const n of nodes) {
    if (n.uid === uidv) return n;
    if (n.type === 'repeat') {
      const c = n.children.find((x) => x.uid === uidv);
      if (c) return c;
    }
  }
  return undefined;
}

export function removeNode(nodes: StackNode[], uidv: string): StackNode[] {
  return nodes
    .filter((n) => n.uid !== uidv)
    .map((n) => (n.type === 'repeat' ? { ...n, children: n.children.filter((c) => c.uid !== uidv) } : n));
}

export function countSteps(nodes: StackNode[]): number {
  return nodes.reduce((a, n) => a + (n.type === 'repeat' ? n.children.length : 1), 0);
}
