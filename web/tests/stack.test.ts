import { describe, it, expect } from 'vitest';
import {
  runStack,
  chainKeys,
  makeStep,
  makeRepeat,
  makePatch,
  applyPatches,
  setPatchedByte,
  reencodeMarkers,
  resolvePhotoParams,
  moveNode,
  removeNode,
  findNode,
  replaceNode,
  type StackNode,
  type ApplyFn,
} from '../src/engine/stack';
import { LruCache } from '../src/engine/cache';
import { hashBytes } from '../src/engine/hash';
import type { StepInfo } from '../src/engine/types';

const info = (id: string, layer: string, params: any[] = [], uses_pool = false): StepInfo =>
  ({ id, layer, params, uses_pool, name: id, description: '' }) as unknown as StepInfo;

const catalog = new Map<string, StepInfo>([
  ['add', info('add', 'byte', [{ id: 'n', kind: 'int', default: 1 }])],
  ['blur', info('blur', 'pixel')],
  ['mix', info('mix', 'byte', [{ id: 'other', kind: 'photo', default: null }], true)],
]);

// fake engine: "add" appends n bytes of value n; "blur" reverses; counts calls
function fakeApply() {
  const calls: string[] = [];
  const apply: ApplyFn = async (id, params, input, seed) => {
    calls.push(id + ':' + seed);
    if (id === 'add') {
      const n = Number(params.n);
      const out = new Uint8Array(input.length + n);
      out.set(input);
      out.fill(n, input.length);
      return out;
    }
    if (id === 'blur') return input.slice().reverse();
    if (id === 'mix') return input;
    throw new Error('unknown');
  };
  return { apply, calls };
}

const src = new Uint8Array([1, 2, 3]);

describe('runStack', () => {
  it('runs steps in order and caches each result', async () => {
    const { apply, calls } = fakeApply();
    const cache = new LruCache<Uint8Array>(1e6);
    const nodes: StackNode[] = [makeStep('add', catalog.get('add'), { n: 2 }, 1), makeStep('blur', catalog.get('blur'), {}, 2)];
    const r = await runStack('s', src, nodes, { apply, cache, catalog, pool: null });
    expect([...r.output]).toEqual([2, 2, 3, 2, 1]);
    expect(calls.length).toBe(2);
    // second run is fully cached
    const r2 = await runStack('s', src, nodes, { apply, cache, catalog, pool: null });
    expect(calls.length).toBe(2);
    expect(r2.results.map((x) => x.status)).toEqual(['cached', 'cached']);
  });

  it('recomputes only from the first changed step', async () => {
    const { apply, calls } = fakeApply();
    const cache = new LruCache<Uint8Array>(1e6);
    const a = makeStep('add', catalog.get('add'), { n: 1 }, 1);
    const b = makeStep('add', catalog.get('add'), { n: 2 }, 2);
    await runStack('s', src, [a, b], { apply, cache, catalog, pool: null });
    calls.length = 0;
    const b2 = { ...b, params: { n: 3 } };
    await runStack('s', src, [a, b2], { apply, cache, catalog, pool: null });
    expect(calls).toEqual(['add:2']);
  });

  it('marks unknown steps unavailable and passes input through', async () => {
    const { apply } = fakeApply();
    const nodes: StackNode[] = [makeStep('nope', undefined, {}, 1), makeStep('add', catalog.get('add'), { n: 1 }, 1)];
    const r = await runStack('s2', src, nodes, { apply, cache: new LruCache(1e6), catalog, pool: null });
    expect(r.results[0].status).toBe('unavailable');
    expect([...r.output]).toEqual([1, 2, 3, 1]);
  });

  it('repeat groups run children N times with distinct seeds', async () => {
    const { apply, calls } = fakeApply();
    const rep = makeRepeat(3, [makeStep('add', catalog.get('add'), { n: 1 }, 7)], 9);
    const r = await runStack('s3', src, [rep], { apply, cache: new LruCache(1e6), catalog, pool: null });
    expect(r.output.length).toBe(6);
    expect(new Set(calls).size).toBe(3);
  });

  it('stale patches are not applied', async () => {
    const { apply } = fakeApply();
    const good = makePatch(hashBytes(src), [{ offset: 0, bytes: [9] }]);
    const r = await runStack('s4', src, [good], { apply, cache: new LruCache(1e6), catalog, pool: null });
    expect(r.output[0]).toBe(9);
    const stale = makePatch('different', [{ offset: 0, bytes: [9] }]);
    const r2 = await runStack('s5', src, [stale], { apply, cache: new LruCache(1e6), catalog, pool: null });
    expect(r2.results[0].status).toBe('stale');
    expect(r2.output[0]).toBe(1);
  });

  // audit B2 (07-6)
  it('a stale patch stays stale when a later step comes from the cache', async () => {
    const { apply } = fakeApply();
    const cache = new LruCache<Uint8Array>(1e6);
    const nodes: StackNode[] = [makePatch('different', [{ offset: 0, bytes: [9] }]), makeStep('add', catalog.get('add'), { n: 1 }, 1)];
    await runStack('s7', src, nodes, { apply, cache, catalog, pool: null });
    const again = await runStack('s7', src, nodes, { apply, cache, catalog, pool: null });
    expect(again.results.map((x) => x.status)).toEqual(['stale', 'cached']);
  });

  // audit B2 (07-7)
  it('a failed step is retried on the next run instead of being hidden by the cache', async () => {
    const { apply, calls } = fakeApply();
    let flaky = true;
    const flakyApply: ApplyFn = async (id, params, input, seed, pool) => {
      if (id === 'blur' && flaky) throw new Error('worker restarted');
      return apply(id, params, input, seed, pool);
    };
    const cache = new LruCache<Uint8Array>(1e6);
    const nodes: StackNode[] = [makeStep('blur', catalog.get('blur'), {}, 1), makeStep('add', catalog.get('add'), { n: 1 }, 2)];
    const first = await runStack('s8', src, nodes, { apply: flakyApply, cache, catalog, pool: null });
    expect(first.results[0].status).toBe('error');
    flaky = false;
    calls.length = 0;
    const second = await runStack('s8', src, nodes, { apply: flakyApply, cache, catalog, pool: null });
    expect(calls).toEqual(['blur:1', 'add:2']);
    expect(second.results.map((x) => x.status)).toEqual(['ok', 'ok']);
    expect([...second.output]).toEqual([3, 2, 1, 1]);
    // and once it worked, a cached run no longer shows the old error
    const third = await runStack('s8', src, nodes, { apply: flakyApply, cache, catalog, pool: null });
    expect(third.results.map((x) => x.status)).toEqual(['cached', 'cached']);
  });

  it('can stop between steps', async () => {
    const { apply } = fakeApply();
    const nodes = [makeStep('add', catalog.get('add'), { n: 1 }, 1), makeStep('add', catalog.get('add'), { n: 1 }, 2)];
    let n = 0;
    const r = await runStack('s6', src, nodes, { apply, cache: new LruCache(1e6), catalog, pool: null, shouldStop: () => n++ > 0 });
    expect(r.stopped).toBe(true);
    expect(r.output.length).toBe(4);
  });
});

describe('chainKeys', () => {
  it('disabled steps keep the previous key; pool key only affects pool steps', () => {
    const a = makeStep('add', catalog.get('add'), {}, 1);
    const d = { ...makeStep('blur', catalog.get('blur'), {}, 2), enabled: false };
    const m = makeStep('mix', catalog.get('mix'), {}, 3);
    const k1 = chainKeys('x', [a, d, m], catalog, 'p1');
    const k2 = chainKeys('x', [a, d, m], catalog, 'p2');
    expect(k1[1]).toBe(k1[0]);
    expect(k1[0]).toBe(k2[0]);
    expect(k1[2]).not.toBe(k2[2]);
  });
});

describe('patches', () => {
  it('setPatchedByte merges adjacent edits', () => {
    let p = setPatchedByte([], 10, 1);
    p = setPatchedByte(p, 11, 2);
    p = setPatchedByte(p, 10, 3);
    p = setPatchedByte(p, 2, 4);
    expect(p).toEqual([
      { offset: 2, bytes: [4] },
      { offset: 10, bytes: [3, 2] },
    ]);
  });
  it('applyPatches ignores offsets past the end', () => {
    expect([...applyPatches(src, [{ offset: 2, bytes: [7, 8] }])]).toEqual([1, 2, 7]);
  });
});

describe('analysis and editing', () => {
  it('re-encode markers appear where a pixel step follows a byte step', () => {
    const a = makeStep('add', catalog.get('add'), {}, 1);
    const b = makeStep('blur', catalog.get('blur'), {}, 2);
    const c = makeStep('blur', catalog.get('blur'), {}, 3);
    const marks = reencodeMarkers([b, a, c], catalog);
    expect([...marks]).toEqual([c.uid]);
  });
  it('photo params map pool uids to indices', () => {
    const r = resolvePhotoParams({ other: 'user:b' }, catalog.get('mix'), ['user:a', 'user:b']);
    expect(r.other).toBe(1);
    expect(resolvePhotoParams({ other: null }, catalog.get('mix'), []).other).toBe(-1);
  });
  it('move/find/replace/remove work inside repeat groups', () => {
    const child = makeStep('add', catalog.get('add'), {}, 1);
    const rep = makeRepeat(2, [child]);
    const top = makeStep('blur', catalog.get('blur'));
    let nodes: StackNode[] = [rep, top];
    nodes = moveNode(nodes, 1, 0);
    expect(nodes[0]).toBe(top);
    expect(findNode(nodes, child.uid)).toBe(child);
    nodes = replaceNode(nodes, child.uid, (n) => ({ ...n, enabled: false }));
    expect(findNode(nodes, child.uid)!.enabled).toBe(false);
    nodes = removeNode(nodes, child.uid);
    expect((nodes[1] as any).children.length).toBe(0);
  });
});
