// EngineClient against a fake worker: cancellation, the hang watchdog, crashes and restarts (audit B2).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EngineClient, setWorkerFactory, isCancel, EngineCrashedError } from '../src/engine/client';

type Msg = { id: number; op: string; args: any };

class FakeWorker {
  static all: FakeWorker[] = [];
  sent: Msg[] = [];
  terminated = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string; preventDefault?: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: Msg) {
    this.sent.push(m);
    // answer init at once, like the real worker after loading
    if (m.op === 'init') queueMicrotask(() => this.reply(m.id, true, { exports: [], catalog: [], profiles: [], cardPresets: [], cardEvents: [] }));
  }
  terminate() {
    this.terminated = true;
  }
  reply(id: number, ok: boolean, payload: unknown) {
    this.onmessage?.({ data: ok ? { id, ok, result: payload } : { id, ok, error: payload } });
  }
  last(op: string) {
    return [...this.sent].reverse().find((m) => m.op === op)!;
  }
}

const current = () => FakeWorker.all[FakeWorker.all.length - 1];

beforeEach(() => {
  FakeWorker.all = [];
  setWorkerFactory(() => new FakeWorker() as unknown as Worker);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => vi.useRealTimers());

async function client() {
  const c = new EngineClient('test');
  await vi.runAllTicks();
  await c.ready;
  return c;
}

describe('EngineClient', () => {
  // 07-2: a new call after the cancel used to count as "heard from the worker" and stop the restart
  it('restarts a hung worker even when new calls arrive after the cancel', async () => {
    const c = await client();
    const stuck = c.decode(new Uint8Array(1));
    stuck.promise.catch(() => {});
    stuck.cancel();
    const next = c.decode(new Uint8Array(2));
    next.promise.catch(() => {});
    const before = current();
    await vi.advanceTimersByTimeAsync(1300);
    expect(before.terminated).toBe(true);
    expect(c.epoch).toBe(1);
    // the request that was not cancelled is sent again to the new worker
    expect(current().sent.some((m) => m.op === 'decode')).toBe(true);
  });

  it('keeps a worker that is still answering', async () => {
    const c = await client();
    const slow = c.decode(new Uint8Array(1));
    slow.promise.catch(() => {});
    slow.cancel();
    const w = current();
    await vi.advanceTimersByTimeAsync(600);
    const other = c.inspect(new Uint8Array(1));
    w.reply(w.last('inspect').id, true, {});
    await other.promise;
    await vi.advanceTimersByTimeAsync(700);
    expect(w.terminated).toBe(false);
  });

  // 07-3: cancel() of a job that was replayed after a restart used to do nothing
  it('can cancel a job after it was replayed on a new worker', async () => {
    const c = await client();
    const job = c.decode(new Uint8Array(3));
    c.restart();
    job.cancel();
    await expect(job.promise).rejects.toSatisfy(isCancel);
  });

  // 07-5: a crash used to leave every request pending forever
  it('fails pending requests and restarts when the worker crashes', async () => {
    const c = await client();
    const job = c.decode(new Uint8Array(4));
    const w = current();
    w.onerror!({ message: 'boom' });
    await expect(job.promise).rejects.toBeInstanceOf(EngineCrashedError);
    expect(w.terminated).toBe(true);
    expect(c.busy).toBe(0);
  });

  it('gives up after repeated crashes instead of looping', async () => {
    const c = await client();
    for (let i = 0; i < 3; i++) current().onerror!({ message: 'cannot load' });
    const workers = FakeWorker.all.length;
    await expect(c.decode(new Uint8Array(1)).promise).rejects.toBeInstanceOf(EngineCrashedError);
    expect(FakeWorker.all.length).toBe(workers);
  });

  it('a WASM trap reported by the worker replaces it', async () => {
    const c = await client();
    const job = c.decode(new Uint8Array(5));
    const w = current();
    w.reply(w.last('decode').id, false, 'ENGINE_CRASHED:unreachable');
    await expect(job.promise).rejects.toBeInstanceOf(EngineCrashedError);
    expect(w.terminated).toBe(true);
    expect(c.epoch).toBe(1);
  });

  // 05-3: a card built for a simulate that was cancelled used to stay in the worker
  it('frees a card whose simulate was cancelled after the worker built it', async () => {
    const c = await client();
    const job = c.cardSimulate({}, [], 1);
    job.promise.catch(() => {});
    job.cancel();
    const w = current();
    w.reply(w.last('cardSimulate').id, true, { handle: 7, info: null, map: new Uint8Array(), owner: new Int32Array() });
    expect(w.last('cardFree')?.args).toEqual({ handle: 7 });
  });

  it('card handles are not replayed onto a new worker', async () => {
    const c = await client();
    const carve = c.cardCarve(3, {});
    c.restart();
    await expect(carve.promise).rejects.toThrow('card gone');
    expect(current().sent.some((m) => m.op === 'cardCarve')).toBe(false);
  });

  // 07-11: the whole AVI used to be copied for every frame
  it('sends an AVI once and then only frame numbers', async () => {
    const c = await client();
    const avi = new Uint8Array(1000);
    const w = current();
    for (let i = 0; i < 3; i++) {
      const j = c.aviFrame(avi, i);
      w.reply(w.last('aviFrame').id, true, new Uint8Array(1));
      await j.promise;
    }
    const frames = w.sent.filter((m) => m.op === 'aviFrame');
    expect(frames.map((m) => 'avi' in m.args)).toEqual([true, false, false]);
  });

  it('re-sends the AVI when the worker lost it', async () => {
    const c = await client();
    const avi = new Uint8Array(10);
    const w = current();
    const a = c.aviFrame(avi, 0);
    w.reply(w.last('aviFrame').id, true, new Uint8Array(1));
    await a.promise;
    const b = c.aviFrame(avi, 1);
    w.reply(w.last('aviFrame').id, false, 'AVI_MISSING');
    await vi.runAllTicks();
    await Promise.resolve();
    const retry = w.last('aviFrame');
    expect('avi' in retry.args).toBe(true);
    w.reply(retry.id, true, new Uint8Array(1));
    await b.promise;
  });

  // a postMessage that throws (DataCloneError) must not leave the busy count up
  it('undoes a request that could not be sent', async () => {
    const c = await client();
    const w = current();
    w.postMessage = () => {
      throw new Error('DataCloneError');
    };
    await expect(c.decode(new Uint8Array(1)).promise).rejects.toThrow('DataCloneError');
    expect(c.busy).toBe(0);
  });
});
