// The preview's scheduling: at most one run in flight plus the latest value (src/latest.ts, used by pipeline.ts).
import { describe, it, expect } from 'vitest';
import { LatestRunner, type RunToken } from '../src/latest';

/** A fake engine: every run is a promise the test settles by hand; cancelling a run rejects it, as the engine
 *  client does with its jobs. */
function fakeEngine() {
  const runs: { value: number; token: RunToken; resolve: () => void; reject: (e: unknown) => void; settled: boolean }[] = [];
  const shown: number[] = [];
  const runner = new LatestRunner<number>((value, token) => {
    return new Promise<void>((res, rej) => {
      const r = {
        value,
        token,
        settled: false,
        resolve: () => {
          r.settled = true;
          if (!token.cancelled) shown.push(value);
          res();
        },
        reject: (e: unknown) => {
          r.settled = true;
          rej(e);
        },
      };
      token.onCancel(() => r.reject(new Error('cancelled')));
      runs.push(r);
    });
  });
  return { runner, runs, shown };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LatestRunner', () => {
  it('starts at once when idle (no debounce)', () => {
    const { runner, runs } = fakeEngine();
    runner.request(1);
    expect(runs.map((r) => r.value)).toEqual([1]);
    expect(runner.running).toBe(true);
    expect(runner.pending).toBe(false);
  });

  it('rapid values: only the first and the last run', async () => {
    const { runner, runs, shown } = fakeEngine();
    for (let v = 1; v <= 50; v++) runner.request(v);
    expect(runs.map((r) => r.value)).toEqual([1]);
    expect(runner.pending).toBe(true);
    runs[0].resolve();
    await tick();
    expect(runs.map((r) => r.value)).toEqual([1, 50]);
    runs[1].resolve();
    await tick();
    expect(shown).toEqual([1, 50]);
    expect(runner.running).toBe(false);
    expect(runner.pending).toBe(false);
  });

  it('never has two runs in flight during a long drag', async () => {
    const { runner, runs, shown } = fakeEngine();
    let v = 0;
    for (let frame = 0; frame < 20; frame++) {
      for (let i = 0; i < 5; i++) runner.request(++v);
      expect(runs.filter((r) => !r.settled).length).toBeLessThanOrEqual(1);
      runs[runs.length - 1].resolve();
      await tick();
    }
    // every finished run was shown (the last good frame stays until the next is ready), in order, ending on the last value
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    runs[runs.length - 1].resolve();
    await tick();
    expect(shown[shown.length - 1]).toBe(v);
    expect(runs.length).toBeLessThan(v / 2);
  });

  it('keeps going after a failed run', async () => {
    const { runner, runs, shown } = fakeEngine();
    runner.request(1);
    runner.request(2);
    runs[0].reject(new Error('engine error'));
    await tick();
    expect(runs.map((r) => r.value)).toEqual([1, 2]);
    runs[1].resolve();
    await tick();
    expect(shown).toEqual([2]);
  });

  it('cancel(): cancels the run in flight and drops the pending value', async () => {
    const { runner, runs, shown } = fakeEngine();
    runner.request(1);
    runner.request(2);
    runner.cancel();
    expect(runs[0].token.cancelled).toBe(true);
    expect(runner.pending).toBe(false);
    await tick();
    expect(runs.map((r) => r.value)).toEqual([1]);
    expect(shown).toEqual([]);
    expect(runner.running).toBe(false);
    // and it is usable again
    runner.request(3);
    expect(runs.map((r) => r.value)).toEqual([1, 3]);
  });

  it('supersede: cancels the run in flight and runs the new value right after', async () => {
    const { runner, runs, shown } = fakeEngine();
    runner.request(1);
    runner.request(2, true);
    expect(runs[0].token.cancelled).toBe(true);
    await tick();
    expect(runs.map((r) => r.value)).toEqual([1, 2]);
    expect(runs[1].token.cancelled).toBe(false);
    runs[1].resolve();
    await tick();
    expect(shown).toEqual([2]);
  });

  it('a plain request never cancels the run in flight', async () => {
    const { runner, runs } = fakeEngine();
    runner.request(1);
    runner.request(2);
    runner.request(3);
    expect(runs[0].token.cancelled).toBe(false);
    expect(runner.current).toBe(1);
  });

  it('onCancel after cancellation fires at once', () => {
    const { runner, runs } = fakeEngine();
    runner.request(1);
    runner.cancel();
    let fired = false;
    runs[0].token.onCancel(() => (fired = true));
    expect(fired).toBe(true);
  });
});
