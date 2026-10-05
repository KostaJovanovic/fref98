// Promise RPC to the engine worker, with cancellation. Inputs are copied (not transferred) so that a hung
// worker can be killed and the outstanding requests replayed on a fresh one; results are transferred.
import type { EngineCaps, DecodeOpts, DecodedImage, EncodeOpts, Inspection, CardInfo, CarvedFile } from './types';

export class NotAvailableError extends Error {
  constructor(public fn: string) {
    super(`"${fn}" is not available in the engine yet`);
    this.name = 'NotAvailableError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export interface Job<T> {
  promise: Promise<T>;
  cancel(): void;
}

interface Pending {
  op: string;
  args: unknown;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  cancelled: boolean;
}

export interface PoolRef {
  key: string;
  photos: Uint8Array[];
}

let workerFactory: () => Worker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

/** Tests can swap the worker for a fake. */
export function setWorkerFactory(f: () => Worker) {
  workerFactory = f;
}

export class EngineClient {
  private worker!: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private sentPool = '';
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private lastHeard = 0;
  caps: EngineCaps | null = null;
  ready: Promise<EngineCaps>;
  restarts = 0;
  /** Number of calls in flight (drives busy cursors and the sky's damage). */
  busy = 0;
  private busyListeners = new Set<(busy: number) => void>();

  onBusy(f: (busy: number) => void): () => void {
    this.busyListeners.add(f);
    return () => this.busyListeners.delete(f);
  }

  private onBusyChange(n: number) {
    for (const f of this.busyListeners) f(n);
  }

  constructor(public name: string) {
    this.spawn();
    this.ready = this.call<EngineCaps>('init', {}).promise.then((c) => (this.caps = c));
  }

  private spawn() {
    this.worker = workerFactory();
    this.sentPool = '';
    this.worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      console.warn(`[engine:${this.name}] worker error`, ev.message);
    };
  }

  private onMessage(msg: { id: number; ok: boolean; result?: unknown; error?: string }) {
    this.lastHeard = performance.now();
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    this.setBusy(-1);
    if (p.cancelled) return;
    if (msg.ok) p.resolve(msg.result);
    else {
      const e = msg.error ?? 'error';
      if (e.startsWith('NOT_AVAILABLE:')) p.reject(new NotAvailableError(e.slice(14)));
      else p.reject(new Error(e));
    }
  }

  private setBusy(d: number) {
    this.busy = Math.max(0, this.busy + d);
    this.onBusyChange(this.busy);
  }

  has(fn: string): boolean {
    return !!this.caps && this.caps.exports.includes(fn);
  }

  call<T>(op: string, args: Record<string, unknown>): Job<T> {
    const id = this.nextId++;
    let pend!: Pending;
    const promise = new Promise<T>((resolve, reject) => {
      pend = { op, args, resolve, reject, cancelled: false };
    });
    this.pending.set(id, pend);
    this.setBusy(1);
    this.lastHeard = performance.now();
    this.worker.postMessage({ id, op, args });
    return {
      promise,
      cancel: () => {
        if (pend.cancelled || !this.pending.has(id)) return;
        pend.cancelled = true;
        pend.reject(new CancelledError());
        this.armWatchdog();
      },
    };
  }

  /** After a cancel, if the worker stays silent (stuck in a long WASM call), kill it and replay the rest. */
  private armWatchdog() {
    if (this.watchdog) return;
    const since = performance.now();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      const stillCancelled = [...this.pending.values()].some((p) => p.cancelled);
      if (stillCancelled && this.lastHeard <= since) this.restart();
    }, 1200);
  }

  /** Ends this engine for good (a window's private worker, e.g. the webcam's). */
  dispose() {
    for (const p of this.pending.values()) if (!p.cancelled) p.reject(new CancelledError());
    this.pending.clear();
    this.busy = 0;
    this.onBusyChange(0);
    this.worker.terminate();
  }

  restart() {
    this.worker.terminate();
    this.restarts++;
    const replay = [...this.pending.entries()];
    this.pending.clear();
    this.busy = 0;
    this.spawn();
    this.call('init', {});
    for (const [, p] of replay) {
      if (p.cancelled) continue;
      const job = this.call(p.op, p.args as Record<string, unknown>);
      job.promise.then(p.resolve, p.reject);
    }
    this.onBusyChange(this.busy);
  }

  // ---------- typed helpers ----------

  applyStep(id: string, params: unknown, input: Uint8Array, seed: number, pool: PoolRef | null): Job<Uint8Array> {
    const send = (withPhotos: boolean) =>
      this.call<Uint8Array>('applyStep', {
        id,
        params,
        input,
        seed,
        poolKey: pool?.key,
        pool: pool && withPhotos ? pool.photos : undefined,
      });
    const first = pool && this.sentPool !== pool.key;
    if (pool) this.sentPool = pool.key;
    const job = send(!!first || !pool);
    const promise = job.promise.catch((e) => {
      if (e instanceof Error && e.message === 'POOL_MISSING') {
        this.sentPool = pool!.key;
        return send(true).promise;
      }
      throw e;
    });
    return { promise, cancel: job.cancel };
  }

  /** `donor` is only used with `fill: "donor"`: never-reached blocks show that photo instead of grey. */
  decode(input: Uint8Array, opts: DecodeOpts = {}, donor?: Uint8Array): Job<DecodedImage> {
    return this.call<DecodedImage>('decode', { input, opts, donor });
  }

  encodeRgba(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, opts: EncodeOpts = {}): Job<Uint8Array> {
    return this.call<Uint8Array>('encodeRgba', { width, height, rgba, opts });
  }

  encodeLike(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, like: Uint8Array): Job<Uint8Array> {
    return this.call<Uint8Array>('encodeLike', { width, height, rgba, like });
  }

  inspect(input: Uint8Array): Job<Inspection & { via: 'ours' | 'fallback' }> {
    return this.call('inspect', { input });
  }

  mcuMap(input: Uint8Array): Job<Uint32Array> {
    return this.call('mcuMap', { input });
  }

  coeffHeatmap(input: Uint8Array, component: number, mode: string): Job<Float32Array> {
    return this.call('coeffHeatmap', { input, component, mode });
  }

  stripPrivateExif(input: Uint8Array): Job<Uint8Array> {
    return this.call('stripPrivateExif', { input });
  }

  encodeGif(width: number, height: number, frames: Uint8Array[], delayCs: number): Job<Uint8Array> {
    return this.call('encodeGif', { width, height, frames, delayCs });
  }

  aviWrite(frames: Uint8Array[], width: number, height: number, fps: number): Job<Uint8Array> {
    return this.call('aviWrite', { frames, width, height, fps });
  }

  aviRead(avi: Uint8Array): Job<{ width: number; height: number; fps: number; frames: number }> {
    return this.call('aviRead', { avi });
  }

  aviFrame(avi: Uint8Array, index: number): Job<Uint8Array> {
    return this.call('aviFrame', { avi, index });
  }

  cardSimulate(scenario: unknown, photos: Uint8Array[], seed: number): Job<{ handle: number; info: CardInfo; map: Uint8Array; owner: Int32Array }> {
    return this.call('cardSimulate', { scenario, photos, seed });
  }

  cardCarve(handle: number, method: unknown): Job<CarvedFile[]> {
    return this.call('cardCarve', { handle, method });
  }

  cardRecovered(handle: number, index: number): Job<Uint8Array> {
    return this.call('cardRecovered', { handle, index });
  }

  cardImageSize(handle: number): Job<number> {
    return this.call('cardImageSize', { handle });
  }

  cardImageChunk(handle: number, offset: number, length: number): Job<Uint8Array> {
    return this.call('cardImageChunk', { handle, offset, length });
  }

  cardFree(handle: number): Job<boolean> {
    return this.call('cardFree', { handle });
  }
}

let main: EngineClient | null = null;
let ambient: EngineClient | null = null;

/** The engine used by the editor, pool, card and exports. */
export function engine(): EngineClient {
  if (!main) main = new EngineClient('main');
  return main;
}

/** A second worker for background art (sky, screensaver, thumbnails) so it never delays the editor. */
export function ambientEngine(): EngineClient {
  if (!ambient) ambient = new EngineClient('ambient');
  return ambient;
}

export function isCancel(e: unknown): boolean {
  return e instanceof CancelledError;
}
