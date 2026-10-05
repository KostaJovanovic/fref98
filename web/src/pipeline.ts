// Runs the recipe for the current photo whenever something changes, recomputing from the first changed step
// (cache) and decoding the result with the chosen decoder personality. Live edits (slider drags) are coalesced:
// at most one run in flight plus the latest state; a run starts at once when idle, and every finished run is
// shown (the last good frame stays until the next one is ready). Switching photos cancels the run in flight.
import { engine, isCancel, NotAvailableError, CancelledError, type Job } from './engine/client';
import { LatestRunner, type RunToken } from './latest';
import { LruCache, defaultBudget } from './engine/cache';
import { runStack, type NodeResult, type PoolSpec, type StackNode } from './engine/stack';
import { hashString, hashBytes } from './engine/hash';
import type { DecodedImage, EngineCaps, StepInfo } from './engine/types';
import { store } from './state';
import { settings, onSettings } from './settings';

export interface PipelineResult {
  sourceUid: string;
  source: Uint8Array;
  output: Uint8Array;
  results: NodeResult[];
  before: DecodedImage | null;
  after: DecodedImage | null;
  decodeError?: string;
  ms: number;
}

type Listener = (r: PipelineResult | null, phase: 'start' | 'step' | 'done' | 'error') => void;

class Pipeline {
  cache = new LruCache<Uint8Array>(defaultBudget());
  catalog = new Map<string, StepInfo>();
  caps: EngineCaps | null = null;
  last: PipelineResult | null = null;
  /** A run is in flight or waiting (stays true across a frame shown while a newer state waits). */
  running = false;
  progress = { i: 0, n: 0, label: '' };
  private listeners = new Set<Listener>();
  private jobs = new Set<Job<unknown>>();
  private runner = new LatestRunner<string | null>((_photo, token) => this.run(token));
  private queued = false;
  private beforeCache: { key: string; img: DecodedImage } | null = null;
  private afterCache: { key: string; img: DecodedImage } | null = null;
  private photoOut = new Map<string, { key: string; bytes: Uint8Array }>();
  startedAt = 0;

  async init() {
    const eng = engine();
    this.caps = await eng.ready;
    this.catalog = new Map(this.caps.catalog.map((s) => [s.id, s]));
    store.on((why) => {
      if (why === 'bin') return;
      this.schedule();
    });
    onSettings((_s, ch) => {
      if (ch.includes('personality') || ch.includes('fill') || ch.includes('fillDonor')) this.schedule();
    });
    this.schedule();
  }

  /** Re-read the catalog after the engine was rebuilt (dev: `npm run wasm`). */
  refreshCaps(c: EngineCaps) {
    this.caps = c;
    this.catalog = new Map(c.catalog.map((s) => [s.id, s]));
    this.schedule();
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(phase: Parameters<Listener>[1]) {
    for (const l of this.listeners) l(this.last, phase);
  }

  /** Re-run for the current state. Changes made in the same task are batched (one microtask), with no delay;
   *  while a run is in flight only the newest state waits for it. */
  schedule() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      const photo = store.current?.uid ?? null;
      // a run for another photo is useless: cancel it rather than wait for it
      const supersede = this.runner.running && this.runner.current !== photo;
      this.running = true;
      this.runner.request(photo, supersede);
    });
  }

  /** Resolves with the result once nothing is running or waiting (a quick Save never gets an old frame). */
  settled(): Promise<PipelineResult | null> {
    if (!this.running) return Promise.resolve(this.last);
    return new Promise((res) => {
      const un = this.on((r, phase) => {
        if ((phase === 'done' || phase === 'error') && !this.running) {
          un();
          res(r);
        }
      });
    });
  }

  cancel() {
    this.runner.cancel();
    for (const j of this.jobs) j.cancel();
    this.jobs.clear();
    if (this.running) {
      this.running = false;
      this.emit('done');
    }
  }

  private track<T>(j: Job<T>, jobs = this.jobs): Promise<T> {
    jobs.add(j as Job<unknown>);
    return j.promise.finally(() => jobs.delete(j as Job<unknown>));
  }

  /** Still running after this frame: a newer state waits (or is about to be requested). */
  private more(): boolean {
    return this.runner.pending || this.queued;
  }

  /** Pool handed to steps: every pool photo except `exclude`, each after its own one-level stack. */
  poolSpec(exclude: string | null): PoolSpec {
    const uids = store.doc.order.filter((u) => u !== exclude && store.photos.has(u));
    const key = hashString(uids.map((u) => store.photoKey(u)).join('|'));
    return { key, uids, photos: () => Promise.all(uids.map((u) => this.photoBytes(u))) };
  }

  /** A pool photo's current bytes: its original, or the output of its own one-level stack (Q10). */
  async photoBytes(uid: string): Promise<Uint8Array> {
    const p = store.photos.get(uid);
    if (!p) return new Uint8Array();
    const steps = store.doc.photoStacks[uid] ?? [];
    if (!steps.some((s) => s.enabled)) return p.bytes;
    const key = store.photoKey(uid);
    const hit = this.photoOut.get(uid);
    if (hit && hit.key === key) return hit.bytes;
    const r = await runStack(uid + '@' + p.version, p.bytes, steps, this.runOptions(null, () => false));
    this.photoOut.set(uid, { key, bytes: r.output });
    return r.output;
  }

  runOptions(pool: PoolSpec | null, shouldStop: () => boolean, onStep?: (i: number, n: number, node: StackNode) => void, jobs = this.jobs) {
    const eng = engine();
    return {
      apply: (id: string, params: Record<string, unknown>, input: Uint8Array, seed: number, poolRef: { key: string; photos: Uint8Array[] } | null) =>
        this.track(eng.applyStep(id, params, input, seed, poolRef), jobs),
      cache: this.cache,
      catalog: this.catalog,
      pool,
      shouldStop,
      onStep,
      classify: (e: unknown) => (e instanceof NotAvailableError || /unknown step/.test(String((e as Error)?.message)) ? ('unavailable' as const) : isCancel(e) ? ('cancel' as const) : ('error' as const)),
    };
  }

  /** Run any stack on any bytes (batch export, video frames, card…). */
  async runOn(sourceKey: string, bytes: Uint8Array, nodes: StackNode[], exclude: string | null, shouldStop: () => boolean = () => false) {
    return runStack(sourceKey, bytes, nodes, this.runOptions(this.poolSpec(exclude), shouldStop));
  }

  async decode(bytes: Uint8Array, personality = settings.personality, jobs = this.jobs): Promise<DecodedImage> {
    return this.track(engine().decode(bytes, { personality }), jobs);
  }

  /** Pool photo used for fill "donor": the chosen one, else the first other photo in the pool. */
  fillDonorUid(exclude: string | null): string | null {
    const chosen = settings.fillDonor;
    if (chosen && chosen !== exclude && store.photos.has(chosen)) return chosen;
    return store.doc.order.find((u) => u !== exclude && store.photos.has(u)) ?? null;
  }

  /** The result decode: personality plus the user's fill choice (with its donor photo). */
  private async decodeAfter(bytes: Uint8Array, exclude: string, jobs: Set<Job<unknown>>): Promise<DecodedImage> {
    const fill = settings.fill ?? 'grey';
    let donor: Uint8Array | undefined;
    if (fill === 'donor') {
      const uid = this.fillDonorUid(exclude);
      if (uid) donor = await this.photoBytes(uid);
    }
    return this.track(engine().decode(bytes, { personality: settings.personality, fill }, donor), jobs);
  }

  private afterKey(bytes: Uint8Array, exclude: string): string {
    const fill = settings.fill ?? 'grey';
    const d = fill === 'donor' ? this.fillDonorUid(exclude) : null;
    return hashBytes(bytes) + settings.personality + fill + (d ? store.photoKey(d) : '');
  }

  private async run(token: RunToken) {
    // this run's engine jobs: cancelled with the run, never someone else's (batch export, Hex Doctor…)
    const jobs = new Set<Job<unknown>>();
    token.onCancel(() => {
      for (const j of jobs) j.cancel();
      jobs.clear();
    });
    const stop = () => token.cancelled;
    const photo = store.current;
    if (!photo) {
      this.last = null;
      this.running = this.more();
      this.emit('done');
      return;
    }
    const t0 = performance.now();
    this.startedAt = t0;
    this.running = true;
    const nodes = store.doc.stack;
    this.progress = { i: 0, n: nodes.length, label: '' };
    this.emit('start');
    try {
      const source = await this.photoBytes(photo.uid);
      if (stop()) return;
      const r = await runStack(photo.uid + '@' + store.photoKey(photo.uid), source, nodes, this.runOptions(this.poolSpec(photo.uid), stop, (i, n, node) => {
        this.progress = { i, n, label: node.type === 'step' ? this.catalog.get(node.id)?.label ?? node.id : node.type === 'repeat' ? `Repeat ×${node.times}` : 'Hex edit' };
        this.emit('step');
      }, jobs));
      if (stop() || r.stopped) return;
      // decode before (cached per source) and after
      let before = null as DecodedImage | null;
      let after = null as DecodedImage | null;
      let decodeError: string | undefined;
      const bkey = hashBytes(source) + settings.personality;
      if (this.beforeCache?.key === bkey) before = this.beforeCache.img;
      else {
        try {
          before = await this.decode(source, settings.personality, jobs);
          this.beforeCache = { key: bkey, img: before };
        } catch (e) {
          if (isCancel(e) || stop()) return;
        }
      }
      if (stop()) return;
      const akey = this.afterKey(r.output, photo.uid);
      if (this.afterCache?.key === akey) after = this.afterCache.img;
      else {
        try {
          after = await this.decodeAfter(r.output, photo.uid, jobs);
          this.afterCache = { key: akey, img: after };
        } catch (e) {
          if (isCancel(e) || stop()) return;
          decodeError = String((e as Error)?.message ?? e);
        }
      }
      if (stop()) return;
      this.last = { sourceUid: photo.uid, source, output: r.output, results: r.results, before, after, decodeError, ms: Math.round(performance.now() - t0) };
      this.running = this.more();
      this.emit('done');
    } catch (e) {
      if (e instanceof CancelledError || stop()) return;
      console.warn('pipeline', e);
      this.running = this.more();
      this.emit('error');
    }
  }
}

export const pipeline = new Pipeline();
