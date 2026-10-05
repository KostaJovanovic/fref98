// The Card window's camera stories on the real engine (audit B4): the accidents do what their story says,
// and every shoot or movie uses the photos it names. Needs the built wasm package (npm run wasm).
import { describe, it, expect, beforeAll } from 'vitest';
import { ACCIDENTS, shoot, type ScenarioEvent } from '../src/apps/card-stories';
import { sheetHit, sheetLayout } from '../src/contact';
import { syntheticPhoto, type PhotoKind } from './util';

// 05-18: the Card window's double-click hit test hard-coded the sheet's geometry
describe('contact sheet hit test', () => {
  it('finds the picture under a point, from the same layout the sheet is drawn with', () => {
    for (const style of ['graft', 'thumbs', 'kodak'] as const) {
      const L = sheetLayout(20, style);
      const at = (col: number, row: number) => sheetHit(20, L.pad + col * (L.cell + L.pad) + L.cell / 2, L.headH + L.pad + row * (L.cell + L.labelH + L.pad) + L.cell / 2, style);
      expect(at(0, 0), style).toBe(0);
      expect(at(1, 2), style).toBe(2 * L.perRow + 1);
      expect(at(L.perRow - 1, 0), style).toBe(L.perRow - 1);
      // past the last picture, and in the margin
      expect(sheetHit(20, L.W - 1, L.H - 1, style), style).toBe(-1);
      expect(sheetHit(20, 1, 1, style), style).toBe(-1);
    }
  });
});

interface CardHandle {
  info_json(): string;
  free(): void;
}
interface Wasm {
  initSync(m: { module: BufferSource }): unknown;
  encode_rgba(width: number, height: number, rgba: Uint8Array, opts_json: string): Uint8Array;
  Card: { simulate(scenario_json: string, photos: Uint8Array[], seed: number): CardHandle };
}
interface Info {
  log: string[];
  files: { name: string; kind: string; deleted: boolean; photo_index: number }[];
}

const { existsSync, readFileSync } = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
  existsSync(p: URL): boolean;
  readFileSync(p: URL): Uint8Array<ArrayBuffer>;
};
const PKG_JS = new URL('../src/wasm/pkg/refragmenter_wasm.js', import.meta.url);
const PKG_WASM = new URL('../src/wasm/pkg/refragmenter_wasm_bg.wasm', import.meta.url);
const havePkg = existsSync(PKG_JS) && existsSync(PKG_WASM);

(havePkg ? describe : describe.skip)('card stories on the real engine', () => {
  let w: Wasm;
  let roll: Uint8Array[];

  beforeAll(async () => {
    w = (await import(/* @vite-ignore */ PKG_JS.href)) as Wasm;
    w.initSync({ module: readFileSync(PKG_WASM) });
    // different sizes, so photos shot into each other's gaps don't fit exactly
    const kinds: PhotoKind[] = ['landscape', 'portrait', 'stripes', 'checker', 'landscape'];
    roll = kinds.map((k, i) => w.encode_rgba(160 + 48 * i, 120 + 36 * i, syntheticPhoto(k, 160 + 48 * i, 120 + 36 * i, i + 1), JSON.stringify({ quality: 92 })));
  });

  function simulate(events: ScenarioEvent[], photos = roll): Info {
    const c = w.Card.simulate(JSON.stringify({ fs: 'fat16', size_mb: 64, cluster_kb: 4, camera: 'canon2004', events }), photos, 7);
    const info = JSON.parse(c.info_json()) as Info;
    c.free();
    return info;
  }
  const story = (id: string, n = roll.length) => ACCIDENTS.find((a) => a.id === id)!.events(n);

  // 11-6: without a power cycle the new photos went after the last file and nothing was ever split
  it('"Fragmented Card" really fragments photos', () => {
    const info = simulate(story('fragmented'));
    expect(info.log.some((l) => /in \d+ fragments/.test(l))).toBe(true);
  });

  // 11-7: nothing made a lost chain, so chkdsk always said "no errors found"
  it('"A PC Repaired It" leaves FOUND.000 pieces', () => {
    const info = simulate(story('chkdsk'));
    expect(info.files.some((f) => f.kind === 'chk' && /\.CHK$/.test(f.name))).toBe(true);
    expect(info.log).not.toContain('chkdsk: no errors found.');
  });

  it('every accident runs', () => {
    for (const a of ACCIDENTS) expect(simulate(a.events(roll.length)).files.length, a.id).toBeGreaterThan(0);
  });

  // 05-4: a movie used up the photos a later Copy added, so the Copy wrote the wrong pictures
  it('a Copy after a movie shoots the pictures it added', () => {
    const events = [shoot(0, 3, 5), { type: 'video', frames: 4, photos: shoot(0, 4, 5).photos }, shoot(3, 2, 5)];
    const photos = simulate(events).files.filter((f) => f.kind === 'photo').map((f) => f.photo_index);
    expect(photos).toEqual([0, 1, 2, 3, 4]);
  });
});
