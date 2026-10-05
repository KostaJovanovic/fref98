import { describe, it, expect } from 'vitest';
import { compareRects, boxToImage, sizeNote } from '../src/ui/compare';

const view = (over: Partial<Parameters<typeof compareRects>[4]> = {}) => ({ x: 0, y: 0, w: 1000, h: 800, zoom: 0.5, cx: 0, cy: 0, ...over });

describe('compareRects', () => {
  it('draws Before into exactly the After box, whatever the sizes', () => {
    const cases: [number, number, number, number][] = [
      [1024, 768, 640, 480], // MMS shrinks
      [1024, 768, 1040, 768], // wrong size widens
      [1024, 768, 160, 120], // thumbnail survivor
      [800, 600, 800, 600], // same size
      [600, 800, 800, 600], // rotated aspect
    ];
    for (const [bw, bh, aw, ah] of cases) {
      const v = view({ cx: aw / 2, cy: ah / 2 });
      const r = compareRects(bw, bh, aw, ah, v);
      expect([r.before.x, r.before.y, r.before.w, r.before.h]).toEqual([r.after.x, r.after.y, r.after.w, r.after.h]);
      expect(r.after.w).toBe(Math.round(aw * 0.5));
      expect(r.after.h).toBe(Math.round(ah * 0.5));
      // centred on the pane rectangle
      expect(Math.abs(r.after.x + r.after.w / 2 - 500)).toBeLessThanOrEqual(1);
      expect(Math.abs(r.after.y + r.after.h / 2 - 400)).toBeLessThanOrEqual(1);
      // whole device pixels
      for (const n of [r.after.x, r.after.y, r.after.w, r.after.h]) expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('scales each pane by its own size', () => {
    const r = compareRects(1024, 768, 640, 480, view({ zoom: 1, cx: 320, cy: 240 }));
    expect(r.after.sx).toBeCloseTo(1);
    expect(r.after.sy).toBeCloseTo(1);
    expect(r.before.sx).toBeCloseTo(640 / 1024);
    expect(r.before.sy).toBeCloseTo(480 / 768);
  });

  it('follows the pan centre and the pane offset (three-way panes)', () => {
    const a = compareRects(100, 100, 200, 100, view({ x: 300, w: 300, h: 300, zoom: 2, cx: 50, cy: 25 }));
    expect(a.after.x).toBe(300 + 150 - 100);
    expect(a.after.y).toBe(150 - 50);
    expect(a.before.x).toBe(a.after.x);
  });

  it('maps a screen point back to the same spot in both pictures', () => {
    const r = compareRects(1024, 768, 640, 480, view({ zoom: 1.25, cx: 300, cy: 200 }));
    // the box corners map to each image's corners
    for (const [b, w, h] of [[r.before, 1024, 768], [r.after, 640, 480]] as const) {
      expect(boxToImage(b, b.x, b.y)).toEqual({ x: 0, y: 0 });
      const end = boxToImage(b, b.x + b.w, b.y + b.h);
      expect(end.x).toBeCloseTo(w);
      expect(end.y).toBeCloseTo(h);
    }
    // the same screen point is the same relative position in both
    const px = r.after.x + r.after.w * 0.3;
    const py = r.after.y + r.after.h * 0.7;
    const pb = boxToImage(r.before, px, py);
    const pa = boxToImage(r.after, px, py);
    expect(pb.x / 1024).toBeCloseTo(pa.x / 640);
    expect(pb.y / 768).toBeCloseTo(pa.y / 480);
  });

  it('survives degenerate sizes', () => {
    const r = compareRects(0, 0, 0, 0, view({ zoom: 0.001 }));
    expect(r.after.w).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(r.before.sx)).toBe(true);
  });
});

describe('sizeNote', () => {
  it('mentions the old size only when it changed', () => {
    expect(sizeNote(1024, 768, 640, 480)).toBe('640×480 (was 1024×768)');
    expect(sizeNote(640, 480, 640, 480)).toBe('640×480');
    expect(sizeNote(undefined, undefined, 640, 480)).toBe('640×480');
  });
});
