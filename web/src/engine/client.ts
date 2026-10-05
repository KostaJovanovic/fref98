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

/** One request for its whole life: the same object is re-sent (under a new wire id) after a restart. */
interface Pending {
  op: string;
  args: unknown;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  cancelled: boolean;
  settled: boolean;
  /** Runs when a result arrives for a request that was cancelled (e.g. free a card nobody will see). */
  onOrphan?: (result: any) => void;
}

/** The worker died (a crash, or a WASM trap that leaves the engine unusable); the request was not run. */
export class EngineCrashedError extends Error {
  constructor(detail: string) {
    super(`The engine stopped (${detail}). It has been restarted; please try again.`);
    this.name = 'EngineCrashedError';
  }
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
  /** In flight, by wire id. */
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private sentPool = '';
  private sentAvi: Uint8Array | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** When the worker last answered anything (only real replies count, never our own sends). */
  private lastHeard = 0;
  private disposed = false;
  private crashes: number[] = [];
  /** Set when the worker keeps crashing: every call then fails with this reason. */
  private down: string | null = null;
  caps: EngineCaps | null = null;
  ready: Promise<EngineCaps>;
  /** Bumped on every restart: worker-side state (card handles, pools) from an older epoch is gone. */
  epoch = 0;
  private restartListeners = new Set<(epoch: number) => void>();
  /** Number of calls in flight (drives busy cursors and the sky's damage). */
  busy = 0;
  private busyListeners = new Set<(busy: number) => void>();

  onBusy(f: (busy: number) => void): () => void {
    this.busyListeners.add(f);
    return () => this.busyListeners.delete(f);
  }

  /** Called after the worker was replaced; anything holding worker-side handles must rebuild them. */
  onRestart(f: (epoch: number) => void): () => void {
    this.restartListeners.add(f);
    return () => void this.restartListeners.delete(f);
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
    this.sentAvi = null;
    this.worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
    // A crash (or a message that can't be read) leaves nothing to wait for: fail what is in flight
    // and start a fresh worker, so later calls work and nothing hangs.
    this.worker.onerror = (ev) => {
      ev.preventDefault?.();
      this.crashed(ev.message || 'worker error');
    };
    this.worker.onmessageerror = () => this.crashed('unreadable reply');
  }

  private crashed(detail: string) {
    if (this.disposed) return;
    const failed = [...this.pending.values()];
    this.pending.clear();
    this.busy = 0;
    this.onBusyChange(0);
    for (const p of failed) this.settle(p, false, new EngineCrashedError(detail));
    // A worker that can't even start (missing file, broken build) would crash again at once: after
    // three crashes in ten seconds, stay down and fail calls straight away instead of looping.
    const now = performance.now();
    this.crashes = this.crashes.filter((t) => now - t < 10_000).concat(now);
    if (this.crashes.length >= 3) {
      console.warn(`[engine:${this.name}] ${detail}; giving up after repeated crashes`);
      this.down = detail;
      this.worker.terminate();
      return;
    }
    console.warn(`[engine:${this.name}] ${detail}; restarting`);
    this.restart();
  }

  private settle(p: Pending, ok: boolean, value: unknown) {
    if (p.settled) return;
    p.settled = true;
    if (ok) p.resolve(value);
    else p.reject(value);
  }

  private onMessage(msg: { id: number; ok: boolean; result?: unknown; error?: string }) {
    this.lastHeard = performance.now();
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    this.setBusy(-1);
    if (p.cancelled) {
      if (msg.ok) p.onOrphan?.(msg.result);
      return;
    }
    if (msg.ok) return this.settle(p, true, msg.result);
    const e = msg.error ?? 'error';
    if (e.startsWith('NOT_AVAILABLE:')) this.settle(p, false, new NotAvailableError(e.slice(14)));
    else if (e.startsWith('ENGINE_CRASHED:')) {
      // The WASM instance trapped: its memory can't be trusted any more, so replace the worker.
      this.settle(p, false, new EngineCrashedError(e.slice(15)));
      this.restart();
    } else this.settle(p, false, new Error(e));
  }

  private setBusy(d: number) {
    this.busy = Math.max(0, this.busy + d);
    this.onBusyChange(this.busy);
  }

  has(fn: string): boolean {
    return !!this.caps && this.caps.exports.includes(fn);
  }

  /** Puts `pend` on the wire under a fresh id. False when it could not be sent (and it was failed). */
  private send(pend: Pending): boolean {
    if (this.down !== null) {
      this.settle(pend, false, new EngineCrashedError(this.down));
      return false;
    }
    const id = this.nextId++;
    this.pending.set(id, pend);
    this.setBusy(1);
    try {
      this.worker.postMessage({ id, op: pend.op, args: pend.args });
      return true;
    } catch (e) {
      // e.g. DataCloneError: undo, or the busy count and the entry would stay forever
      this.pending.delete(id);
      this.setBusy(-1);
      this.settle(pend, false, e);
      return false;
    }
  }

  call<T>(op: string, args: Record<string, unknown>, onOrphan?: (result: T) => void): Job<T> {
    let pend!: Pending;
    const promise = new Promise<T>((resolve, reject) => {
      pend = { op, args, resolve, reject, cancelled: false, settled: false, onOrphan };
    });
    this.send(pend);
    return {
      promise,
      cancel: () => {
        if (pend.cancelled || pend.settled) return;
        pend.cancelled = true;
        this.settle(pend, false, new CancelledError());
        this.armWatchdog();
      },
    };
  }

  /** After a cancel, if the worker stays silent (stuck in a long WASM call), kill it and replay the rest.
   *  While it keeps answering other requests it is alive, so look again later instead. */
  private armWatchdog() {
    if (this.watchdog) return;
    const since = performance.now();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (![...this.pending.values()].some((p) => p.cancelled)) return;
      if (this.lastHeard <= since) this.restart();
      else this.armWatchdog();
    }, 1200);
  }

  /** Ends this engine for good (a window's private worker, e.g. the webcam's). */
  dispose() {
    this.disposed = true;
    if (this.watchdog) clearTimeout(this.watchdog);
    for (const p of this.pending.values()) this.settle(p, false, new CancelledError());
    this.pending.clear();
    this.busy = 0;
    this.onBusyChange(0);
    this.worker.terminate();
  }

  restart() {
    if (this.disposed) return;
    this.worker.terminate();
    this.epoch++;
    const replay = [...this.pending.values()];
    this.pending.clear();
    this.busy = 0;
    this.spawn();
    // (a crash of the new worker fails this too; nobody waits for it, so don't leave it unhandled)
    this.call('init', {}).promise.catch(() => {});
    // The same Pending objects go out again, so their jobs can still be cancelled. Card ops are not
    // replayed: their handles died with the old worker.
    for (const p of replay) {
      if (p.cancelled) continue;
      if (p.op.startsWith('card') && p.op !== 'cardSimulate') this.settle(p, false, new Error('card gone'));
      else this.send(p);
    }
    this.onBusyChange(this.busy);
    for (const f of this.restartListeners) f(this.epoch);
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
    let job = send(!!first || !pool);
    let cancelled = false;
    const promise = job.promise.catch((e) => {
      if (!cancelled && e instanceof Error && e.message === 'POOL_MISSING') {
        this.sentPool = pool!.key;
        job = send(true);
        return job.promise;
      }
      throw e;
    });
    // cancel() reaches the retry too, not only the first send
    return {
      promise,
      cancel: () => {
        cancelled = true;
        job.cancel();
      },
    };
  }

  /** `donor` is only used with `fill: "donor"`: never-reached blocks show that photo instead of grey. */
  decode(input: Uint8Array, opts: DecodeOpts = {}, donor?: Uint8Array): Job<DecodedImage> {
    return this.call<DecodedImage>('decode', { input, opts, donor });
  }

  encodeRgba(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, opts: EncodeOpts = {}): Job<Uint8Array> {
    return this.call<Uint8Array>('encodeRgba', { width, height, rgba, opts });
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

  /** One frame of an AVI. The worker keeps the last AVI it was sent, so stepping through a clip copies
   *  the file once instead of once per frame (it is re-sent only after a restart: AVI_MISSING). */
  aviFrame(avi: Uint8Array, index: number): Job<Uint8Array> {
    const known = this.sentAvi === avi;
    this.sentAvi = avi;
    let job = this.call<Uint8Array>('aviFrame', known ? { index } : { avi, index });
    let cancelled = false;
    const promise = job.promise.catch((e) => {
      if (!cancelled && e instanceof Error && e.message === 'AVI_MISSING') {
        this.sentAvi = avi;
        job = this.call<Uint8Array>('aviFrame', { avi, index });
        return job.promise;
      }
      throw e;
    });
    return {
      promise,
      cancel: () => {
        cancelled = true;
        job.cancel();
      },
    };
  }

  cardSimulate(scenario: unknown, photos: Uint8Array[], seed: number): Job<{ handle: number; info: CardInfo; map: Uint8Array; owner: Int32Array }> {
    // A simulate cancelled after the worker built the card would leave it there forever: free it.
    return this.call('cardSimulate', { scenario, photos, seed }, (r) => void this.cardFree(r.handle).promise.catch(() => {}));
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
