// Every story preset, run through the real wasm engine exactly like the app does (src/presets.ts builds the
// stack, engine/stack.ts runStack executes it), at "How bad?" 0, 0.5 and 1. Checks that no preset turns the
// photo into flat grey and that the intensity slider really changes the picture.
// Needs the built wasm package (npm run wasm, or npm run test:full).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PRESETS, type Preset } from '../src/presets';
import { runStack, type ApplyFn } from '../src/engine/stack';
import { LruCache } from '../src/engine/cache';
import type { StepInfo, Profile } from '../src/engine/types';
import { greyFraction, meanAbsDiff, syntheticPhoto, type Img, type PhotoKind } from './util';

interface Decoded {
  width: number;
  height: number;
  rgba(): Uint8Array;
  events_json(): string;
  free(): void;
}
interface Wasm {
  initSync(m: { module: BufferSource }): unknown;
  catalog(): string;
  profiles(): string;
  apply_step(id: string, params_json: string, input: Uint8Array, seed: number, pool: unknown[]): Uint8Array;
  decode(input: Uint8Array, opts_json: string): Decoded;
  encode_rgba(width: number, height: number, rgba: Uint8Array, opts_json: string): Uint8Array;
}

// node:fs through a computed specifier: the project has no @types/node and tsc type-checks tests too.
const { existsSync, readFileSync } = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
  existsSync(p: URL): boolean;
  readFileSync(p: URL): Uint8Array<ArrayBuffer>;
};
const PKG_JS = new URL('../src/wasm/pkg/refragmenter_wasm.js', import.meta.url);
const PKG_WASM = new URL('../src/wasm/pkg/refragmenter_wasm_bg.wasm', import.meta.url);
const havePkg = existsSync(PKG_JS) && existsSync(PKG_WASM);
if (!havePkg) {
  console.warn(
    '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
      '!! presets.test.ts SKIPPED: wasm package missing (web/src/wasm/pkg).     !!\n' +
      '!! Run `npm run wasm` or `npm run test:full` to test the story presets. !!\n' +
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n',
  );
}

const W = 640;
const H = 480;
const BADS = [0, 0.5, 1] as const;
/** The app picks a random seed per preset choice; any fixed one is a faithful sample. */
const SEED = 12345;
/** Max fraction of flat-grey 8x8 blocks allowed in a result. */
const MAX_GREY = 0.2;
/** Mean absolute pixel difference (0..255) that counts as a visible change between "barely" and "destroyed". */
const MIN_DIFF_ENDS = 2;
/** Smaller bar for the middle setting against each end. */
const MIN_DIFF_MID = 0.5;

/**
 * Presets whose middle setting may legitimately equal one end. Empty for now; add an id with the reason if a
 * preset's steps are stepwise by design.
 */
const MID_EXEMPT: Record<string, string> = {};

interface Row {
  id: string;
  bad: number;
  grey: number;
  size: string;
  problems: string[];
  img?: Img;
}

const rows: Row[] = [];

(havePkg ? describe : describe.skip)('story presets on the real engine', () => {
  let w: Wasm;
  let catalog: Map<string, StepInfo>;
  let profiles: Profile[];
  let source: Uint8Array;
  let pool: Uint8Array[];

  beforeAll(async () => {
    w = (await import(/* @vite-ignore */ PKG_JS.href)) as Wasm;
    w.initSync({ module: readFileSync(PKG_WASM) });
    catalog = new Map((JSON.parse(w.catalog()) as StepInfo[]).map((s) => [s.id, s]));
    profiles = JSON.parse(w.profiles()) as Profile[];
    const enc = (kind: PhotoKind, seed: number) => w.encode_rgba(W, H, syntheticPhoto(kind, W, H, seed), JSON.stringify({ quality: 90, subsampling: '420' }));
    source = enc('landscape', 1);
    pool = [enc('portrait', 2), enc('stripes', 3), enc('checker', 4)];
  });

  afterAll(() => {
    if (!rows.length) return;
    const pct = (v: number) => (v * 100).toFixed(1).padStart(5) + '%';
    const lines = ['preset            b     grey   size      problems'];
    for (const r of rows) lines.push(`${r.id.padEnd(17)} ${r.bad.toFixed(1)}  ${pct(r.grey)}  ${r.size.padEnd(9)} ${r.problems.join('; ')}`);
    console.log('\n' + lines.join('\n'));
  });

  async function run(p: Preset, bad: number): Promise<Row> {
    const nodes = p.build({ catalog, profiles, bad, seed: SEED });
    const apply: ApplyFn = async (id, params, input, seed, pl) => w.apply_step(id, JSON.stringify(params), input, seed >>> 0, pl?.photos ?? []);
    const res = await runStack('src', source, nodes, {
      apply,
      cache: new LruCache<Uint8Array>(0),
      catalog,
      pool: { key: 'pool', uids: ['p1', 'p2', 'p3'], photos: async () => pool },
    });
    const problems = res.results.filter((r) => r.status === 'error' || r.status === 'unavailable').map((r) => `${r.status}: ${r.error}`);
    // Steps the preset uses that the engine doesn't list are silently skipped by the app: count as problems.
    for (const u of p.uses) if (!catalog.has(u)) problems.push(`engine has no step "${u}"`);
    let d: Decoded;
    try {
      d = w.decode(res.output, JSON.stringify({ personality: 'libjpeg', fill: 'grey' }));
    } catch (e) {
      return { id: p.id, bad, grey: 1, size: '-', problems: [...problems, 'unreadable: ' + String(e)] };
    }
    const img: Img = { width: d.width, height: d.height, rgba: d.rgba() };
    d.free();
    return { id: p.id, bad, grey: greyFraction(img.width, img.height, img.rgba), size: `${img.width}x${img.height}`, problems, img };
  }

  it('has the Displaced preset right after Dead SD card, needing the pool', () => {
    const i = PRESETS.findIndex((p) => p.id === 'displaced');
    expect(i).toBeGreaterThan(0);
    expect(PRESETS[i - 1].id).toBe('dead-sd');
    expect(PRESETS[i].needsPool).toBe(true);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  // audit B4 (10-11): "Once" asked for 0 stutters, which the step's minimum turned into 1
  it('the flaky reader has no stutter at the lowest setting', () => {
    const p = PRESETS.find((x) => x.id === 'flaky-reader')!;
    const ids = (bad: number) => p.build({ catalog, profiles, bad, seed: SEED }).map((n) => (n.type === 'step' ? n.id : n.type));
    expect(ids(0)).toEqual(['dropped_sectors']);
    expect(ids(1)).toEqual(['dropped_sectors', 'stutter_read']);
  });

  it('passes only parameter ids the engine knows', () => {
    const unknown: string[] = [];
    for (const p of PRESETS) {
      for (const bad of BADS) {
        for (const n of p.build({ catalog, profiles, bad, seed: SEED })) {
          const steps = n.type === 'step' ? [n] : n.type === 'repeat' ? n.children : [];
          for (const s of steps) {
            const info = catalog.get(s.id);
            if (!info) continue; // reported by the per-preset test
            for (const k of Object.keys(s.params)) {
              if (!info.params.some((x) => x.id === k)) unknown.push(`${p.id}: ${s.id}.${k}`);
            }
          }
        }
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  for (const p of PRESETS) {
    it(`${p.id}: not grey, and "How bad?" changes the picture`, async () => {
      const out: Row[] = [];
      for (const bad of BADS) out.push(await run(p, bad));
      rows.push(...out);
      const [lo, mid, hi] = out;
      const dEnds = lo.img && hi.img ? meanAbsDiff(lo.img, hi.img) : 0;
      const dLoMid = lo.img && mid.img ? meanAbsDiff(lo.img, mid.img) : 0;
      const dMidHi = mid.img && hi.img ? meanAbsDiff(mid.img, hi.img) : 0;
      hi.problems.push(`diff 0-1 ${dEnds.toFixed(2)}, 0-.5 ${dLoMid.toFixed(2)}, .5-1 ${dMidHi.toFixed(2)}`);
      for (const r of out) {
        expect(r.problems.filter((x) => !x.startsWith('diff')), `${p.id} @${r.bad}: steps failed`).toEqual([]);
        expect(r.grey, `${p.id} @${r.bad}: grey fraction`).toBeLessThan(MAX_GREY);
      }
      expect(dEnds, `${p.id}: b=0 vs b=1 mean abs diff`).toBeGreaterThan(MIN_DIFF_ENDS);
      if (!MID_EXEMPT[p.id]) {
        expect(dLoMid, `${p.id}: b=0 vs b=0.5`).toBeGreaterThan(MIN_DIFF_MID);
        expect(dMidHi, `${p.id}: b=0.5 vs b=1`).toBeGreaterThan(MIN_DIFF_MID);
      }
    }, 20000);
  }
});
