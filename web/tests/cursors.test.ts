import { describe, it, expect } from 'vitest';
import {
  estimatePageZoom, screenScale, cursorScale, hotCss, hotDevice, cursorValue, cursorArt, outlined, hourglass,
  CURSOR_NAMES, CURSOR_VARS, WAIT_FRAMES, SAND_FRAMES, ZOOM_LEVELS,
} from '../src/ui/cursors';

/** What Chromium does with a custom cursor: device size = bitmap px × displayScale / image-set resolution. */
const deviceSize = (bitmapPx: number, display: number, res: number) => (bitmapPx * display) / res;

describe('cursor scale maths', () => {
  it('estimates the page zoom from outer/inner width and snaps to Chrome levels', () => {
    expect(estimatePageZoom(1936, 1920)).toBe(1); // maximised window, frame overhang
    expect(estimatePageZoom(1920, 1536)).toBe(1.25);
    expect(estimatePageZoom(1920, 1280)).toBe(1.5);
    expect(estimatePageZoom(1000, 500)).toBe(2);
    expect(estimatePageZoom(1920, 2133)).toBe(0.9);
    expect(estimatePageZoom(0, 1200)).toBe(1); // no outer size (some embedded views)
    expect(estimatePageZoom(1920, 1600)).toBe(1); // 1.2: not a zoom level (DevTools docked)
  });

  it('removes the page zoom from devicePixelRatio, keeping a plausible display scale', () => {
    expect(screenScale(1, 1)).toBe(1);
    expect(screenScale(1.25 * 1.1, 1.1)).toBe(1.25);
    expect(screenScale(2 * 1.5, 1.5)).toBe(2);
    expect(screenScale(1.5 * 0.9, 0.9)).toBe(1.5);
    // a bogus zoom estimate that would give an implausible display scale falls back to dpr
    expect(screenScale(1, 1.75)).toBe(1);
    expect(screenScale(1.25, 1.75)).toBe(1.25);
  });

  it('declares the screen scale as the image-set resolution, so the browser never rescales the bitmap', () => {
    for (const display of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
      const { n, res } = cursorScale(display);
      expect(n).toBe(Math.max(1, Math.round(display)));
      expect(res).toBe(display);
      // a 32-px cursor is exactly 32·n device px on screen: 1 device px per bitmap px
      expect(deviceSize(32 * n, display, res)).toBeCloseTo(32 * n, 6);
    }
  });

  it('is unchanged by browser zoom (Ctrl+/−) and does not depend on the UI scale ui.k', () => {
    for (const display of [1, 1.25, 1.5, 2]) {
      const ref = cursorScale(screenScale(display, 1));
      for (const zoom of ZOOM_LEVELS.filter((z) => z >= 0.5 && z <= 3)) {
        const inner = 1600;
        const dpr = display * zoom;
        // outerWidth is in screen DIPs (not zoomed), innerWidth in CSS px (zoomed)
        const z = estimatePageZoom(Math.round(inner * zoom) + 16, inner);
        const s = cursorScale(screenScale(dpr, z));
        expect(s).toEqual(ref);
        const v1 = cursorValue('u', [3, 4], s.n, s.res, 'default');
        expect(v1).toBe(cursorValue('u', [3, 4], ref.n, ref.res, 'default'));
      }
    }
    // no ui.k parameter exists anywhere in the chain: the value for k = 1 and k = 2 is the same string
    expect(cursorScale(2)).toEqual({ n: 2, res: 2 });
  });

  it('places the hot spot on the right device pixel (exact at integer scales, ±1 px otherwise)', () => {
    for (const display of [1, 1.25, 1.5, 1.75, 2, 3]) {
      const { n, res } = cursorScale(display);
      for (let h = 0; h < 32; h++) {
        const target = h * n;
        const c = hotCss(h, n, res);
        expect(Number.isInteger(c)).toBe(true);
        const err = Math.abs(hotDevice(c, res) - target);
        if (Number.isInteger(res)) expect(err).toBe(0);
        else expect(err).toBeLessThanOrEqual(1);
      }
    }
  });

  it('formats an image-set value with the native fallback', () => {
    expect(cursorValue('data:x', [0, 0], 1, 1.25, 'default')).toBe('image-set(url("data:x") 1.25x) 0 0, default');
    expect(cursorValue('data:x', [5, 0], 2, 2, 'pointer')).toBe('image-set(url("data:x") 2x) 5 0, pointer');
    expect(cursorValue('data:x', [5, 0], 1, 1, 'pointer', false)).toBe('url("data:x") 5 0, pointer');
  });
});

describe('cursor art', () => {
  it('every cursor is 1-bit black/white/transparent, at most 32×32, with the hot spot inside', () => {
    for (const name of CURSOR_NAMES) {
      for (let f = 0; f < WAIT_FRAMES; f++) {
        const { rows, hot } = cursorArt(name, f);
        const w = Math.max(...rows.map((r) => r.length));
        expect(rows.length).toBeLessThanOrEqual(32);
        expect(w).toBeLessThanOrEqual(32);
        for (const r of rows) expect(r).toMatch(/^[XO.]*$/);
        expect(hot[0]).toBeGreaterThanOrEqual(0);
        expect(hot[1]).toBeGreaterThanOrEqual(0);
        expect(hot[0]).toBeLessThan(w);
        expect(hot[1]).toBeLessThan(rows.length);
      }
    }
  });

  it('the pointing cursors have their hot spot on the tip', () => {
    for (const name of ['arrow', 'hand', 'help', 'wait-bg', 'pen'] as const) {
      const { rows, hot } = cursorArt(name);
      expect(rows[hot[1]][hot[0]]).toBe('X');
    }
  });

  it('has a CSS variable and a native fallback per cursor', () => {
    for (const name of CURSOR_NAMES) {
      expect(CURSOR_VARS[name][0]).toMatch(/^--cur-/);
      expect(CURSOR_VARS[name][1]).toMatch(/^[a-z-]+$/);
    }
    expect(CURSOR_VARS.arrow).toEqual(['--cur-arrow', 'default']);
    expect(CURSOR_VARS['wait-bg']).toEqual(['--cur-wait-bg', 'progress']);
  });

  it('outlines a black core with a 1 px white ring', () => {
    const o = outlined(['X']);
    expect(o).toEqual(['OOO', 'OXO', 'OOO']);
  });

  it('the hourglass drains its sand and then turns on its side', () => {
    const sand = (rows: string[], from: number, to: number) => rows.slice(from, to).join('').split('X').length - 1;
    const f0 = hourglass(0);
    const fl = hourglass(SAND_FRAMES - 1);
    // rows 3..8 are the top bulb, 10..15 the bottom bulb (between the caps)
    expect(sand(f0, 3, 9) - sand(fl, 3, 9)).toBeGreaterThan(15);
    expect(sand(fl, 10, 16) - sand(f0, 10, 16)).toBeGreaterThan(15);
    const side = hourglass(SAND_FRAMES);
    expect(side.length).toBe(f0[0].length);
    expect(side[0].length).toBe(f0.length);
    // the animation cycles
    expect(hourglass(WAIT_FRAMES)).toEqual(f0);
  });
});
