// Audit B9 regressions: the duplicate systems now have one implementation each.
import { afterEach, describe, expect, it } from 'vitest';
import { neighborInDir, typeAhead } from '../src/ui/uimath';
import * as M from '../src/apps/explorer-model';
import { neighbor } from '../src/shell/desktop-grid';
import { mix32, mulberry32, repeatSeed } from '../src/engine/hash';
import { rng } from '../src/foldy/timeline';
import { recipeFromFragment, recipeToFragment, toRecipe } from '../src/engine/recipe';
import { COLORS98, PALETTE, PALETTE_SIZE, bayerOn, BAYER8 } from '../src/ui/palette';
import { BEVEL_RINGS, bevelRows } from '../src/ui/canvas';
import { captionButtonRows } from '../src/ui/art-chrome';

const inPalette = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  for (let i = 0; i < PALETTE_SIZE; i++) if (((PALETTE[i * 3] << 16) | (PALETTE[i * 3 + 1] << 8) | PALETTE[i * 3 + 2]) === n) return true;
  return false;
};

describe('one keyboard-neighbour and type-ahead helper (05-25)', () => {
  it('folder items, desktop cells and lists agree', () => {
    const pts = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 0 },
      { id: 'c', x: 0, y: 1 },
    ];
    expect(neighborInDir(pts, 'a', 'right')).toBe('b');
    expect(neighborInDir(pts, 'a', 'down')).toBe('c');
    expect(neighbor({ a: { c: 0, r: 0 }, b: { c: 1, r: 0 }, c: { c: 0, r: 1 } } as any, 'a', 'down')).toBe('c');
    expect(M.neighborBox([{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 20, y: 0, w: 10, h: 10 }], 'a', 'right')).toBe('b');
    const names = ['apple', 'avocado', 'banana'];
    expect(M.typeAhead(names, (s) => s, 'apple', 'a')).toBe(names[typeAhead(names, 0, 'a')]);
  });
});

describe('one PRNG and one mixer (07-17)', () => {
  it('Foldy, the sky and repeat seeds share them', () => {
    const a = mulberry32(42);
    const b = rng(42);
    for (let i = 0; i < 5; i++) expect(b()).toBe(a());
    // repeat seeds are unchanged by the move (saved projects keep their look)
    expect(repeatSeed(1, 2, 0)).toBe(mix32((1 ^ Math.imul(2, 0x9e3779b1) ^ Math.imul(1, 0x85ebca6b)) >>> 0));
    expect(repeatSeed(123456, 789, 3)).toBe(2644123468); // the value before the refactor
  });
});

describe('recipe links on a browser without DecompressionStream (07-17)', () => {
  const real = globalThis.DecompressionStream;
  afterEach(() => void (globalThis.DecompressionStream = real));
  it('give a clear error instead of a ReferenceError', async () => {
    const frag = await recipeToFragment(toRecipe([], 'x'));
    if (!frag.startsWith('#r=')) return; // no CompressionStream here: nothing compressed to read
    // @ts-expect-error: simulating an old browser
    delete globalThis.DecompressionStream;
    await expect(recipeFromFragment(frag)).rejects.toThrow(/cannot read/);
  });
});

describe('one palette (02-6, 02-7, 02-8)', () => {
  it('every named 98 colour is in the UI palette, and the palette fits 256 entries', () => {
    expect(PALETTE_SIZE).toBeLessThanOrEqual(256);
    for (const [name, hex] of Object.entries(COLORS98)) expect(inPalette(hex), name).toBe(true);
  });
  it('bayerOn reads the one Bayer matrix', () => {
    let on = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) on += bayerOn(x, y, 32) ? 1 : 0;
    expect(on).toBe(32);
    expect(BAYER8).toHaveLength(64);
  });
});

describe('one bevel painter (02-9)', () => {
  it('the rings put the bottom-right shade on the far corners, and caption buttons use it', () => {
    const r = bevelRows(5, 4, 'raised', 'F');
    expect(r).toEqual(['WWWWK', 'WLLGK', 'WGGGK', 'KKKKK']);
    expect(captionButtonRows('close', 'n')[0]).toBe('WWWWWWWWWWWWWWWK');
    expect(captionButtonRows('close', 'p')[0][0]).toBe(BEVEL_RINGS.pushed[0][0]);
  });
});
