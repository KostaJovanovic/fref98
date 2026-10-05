import { describe, it, expect } from 'vitest';
import { captionRect, CAPTION_H } from '../src/ui/wm-anim';
import { edgeAt, resizeRect, moveRect, zoneBox, zoneClip, edgeCursor, EDGES, RZ_EDGE, RZ_CORNER, RZ_TOUCH_OUT, type Edge } from '../src/ui/wm-drag';
import { captionButtonRows, sizeGripRows, GRIP_ROWS } from '../src/ui/art-chrome';

// 02-3: the stack-row grip was a 7×15 XP-grey sprite stretched to 8×18 (16×36 on phones), so it blurred
describe('stack-row grip', () => {
  it('is drawn at its shown size (8×18) in 98 greys', () => {
    expect(GRIP_ROWS.length).toBe(18);
    for (const r of GRIP_ROWS) expect(r.length).toBe(8);
    expect(new Set(GRIP_ROWS.join('').replace(/\./g, ''))).toEqual(new Set(['W', 'G']));
  });
});

describe('captionRect', () => {
  const win = { x: 100, y: 50, w: 400, h: 300 };
  const btn = { x: 60, y: 740, w: 160, h: 22 };
  it('starts on the window caption and ends on the taskbar button', () => {
    expect(captionRect(win, btn, 0)).toEqual({ x: 100, y: 50, w: 400, h: CAPTION_H });
    expect(captionRect(win, btn, 1)).toEqual({ x: 60, y: 740, w: 160, h: CAPTION_H });
  });
  it('interpolates in whole pixels and clamps t', () => {
    const m = captionRect(win, btn, 0.5);
    expect(m).toEqual({ x: 80, y: 395, w: 280, h: CAPTION_H });
    for (const t of [0.1, 0.33, 0.77]) for (const v of Object.values(captionRect(win, btn, t))) expect(Number.isInteger(v)).toBe(true);
    expect(captionRect(win, btn, -1)).toEqual(captionRect(win, btn, 0));
    expect(captionRect(win, btn, 2)).toEqual(captionRect(win, btn, 1));
  });
  it('keeps a short target short', () => {
    expect(captionRect(win, { x: 0, y: 0, w: 50, h: 10 }, 1).h).toBe(10);
  });
  it('is monotonic between the ends', () => {
    let prev = captionRect(win, btn, 0);
    for (let i = 1; i <= 10; i++) {
      const r = captionRect(win, btn, i / 10);
      expect(r.y).toBeGreaterThanOrEqual(prev.y);
      expect(r.w).toBeLessThanOrEqual(prev.w);
      prev = r;
    }
  });
});

// 01-15: on touch screens the zones grow outwards, past the frame, and the frame itself stays the same
describe('touch resize zones', () => {
  it('reach RZ_TOUCH_OUT px outside the window and keep their inner edge', () => {
    const o = RZ_TOUCH_OUT;
    expect(zoneBox('n', RZ_EDGE, RZ_CORNER, o)).toEqual({ left: RZ_CORNER, right: RZ_CORNER, top: -o, height: RZ_EDGE + o });
    expect(zoneBox('e', RZ_EDGE, RZ_CORNER, o)).toEqual({ top: RZ_CORNER, bottom: RZ_CORNER, right: -o, width: RZ_EDGE + o });
    expect(zoneBox('se', RZ_EDGE, RZ_CORNER, o)).toEqual({ right: -o, bottom: -o, width: RZ_CORNER + o, height: RZ_CORNER + o });
    for (const e of EDGES) {
      const b = zoneBox(e, RZ_EDGE, RZ_CORNER, o);
      const inner = zoneBox(e);
      // the part inside the window is the mouse zone: offset by -o, grown by o
      for (const k of ['left', 'top', 'right', 'bottom'] as const) if (inner[k] === 0) expect(b[k], `${e} ${k}`).toBe(-o);
      for (const k of ['width', 'height'] as const) if (inner[k] !== undefined && (e.length === 2 || inner[k] === RZ_EDGE)) expect(b[k], `${e} ${k}`).toBe(inner[k]! + o);
    }
    expect(RZ_EDGE + o).toBeGreaterThanOrEqual(10);
    expect(zoneBox('n')).toEqual(zoneBox('n', RZ_EDGE, RZ_CORNER, 0));
  });
});

describe('resize hit zones', () => {
  const W = 300;
  const H = 200;
  it('maps the frame to the 8 edges', () => {
    const cases: [number, number, Edge | null][] = [
      [0, 0, 'nw'], [RZ_CORNER - 1, 0, 'nw'], [0, RZ_CORNER - 1, 'nw'],
      [W - 1, 0, 'ne'], [0, H - 1, 'sw'], [W - 1, H - 1, 'se'],
      [150, 0, 'n'], [150, H - 1, 's'], [0, 100, 'w'], [W - 1, 100, 'e'],
      [150, RZ_EDGE, null], [RZ_EDGE, RZ_EDGE, null], [8, 8, null], [-1, 5, null], [W, 5, null],
    ];
    for (const [x, y, e] of cases) expect(edgeAt(x, y, W, H), `${x},${y}`).toBe(e);
  });
  it('agrees with the zone boxes the elements use', () => {
    // resolve each zone box to pixels and check every pixel inside (and inside the L clip) maps to its edge
    for (const e of EDGES) {
      const b = zoneBox(e);
      const left = b.left ?? W - (b.right ?? 0) - (b.width ?? 0);
      const top = b.top ?? H - (b.bottom ?? 0) - (b.height ?? 0);
      const w = b.width ?? W - (b.left ?? 0) - (b.right ?? 0);
      const h = b.height ?? H - (b.top ?? 0) - (b.bottom ?? 0);
      const corner = zoneClip(e) !== null;
      expect(corner).toBe(e.length === 2);
      // sample the zone's centre line pixels that belong to it
      const px = e.includes('w') ? left : e.includes('e') ? left + w - 1 : left + Math.floor(w / 2);
      const py = e.startsWith('n') ? top : e.startsWith('s') ? top + h - 1 : top + Math.floor(h / 2);
      expect(edgeAt(px, py, W, H), e).toBe(e);
    }
  });
  it('gives each edge a resize cursor variable with a native fallback', () => {
    expect(edgeCursor('n')).toBe('var(--cur-ns, ns-resize)');
    expect(edgeCursor('w')).toBe('var(--cur-ew, ew-resize)');
    expect(edgeCursor('se')).toBe('var(--cur-nwse, nwse-resize)');
    expect(edgeCursor('ne')).toBe('var(--cur-nesw, nesw-resize)');
  });
});

describe('resizeRect / moveRect', () => {
  const r = { x: 100, y: 100, w: 300, h: 200 };
  const min = { w: 200, h: 100 };
  it('moves only the dragged edges', () => {
    expect(resizeRect(r, 'e', 20, 99, min)).toEqual({ x: 100, y: 100, w: 320, h: 200 });
    expect(resizeRect(r, 's', 99, 20, min)).toEqual({ x: 100, y: 100, w: 300, h: 220 });
    expect(resizeRect(r, 'w', -20, 0, min)).toEqual({ x: 80, y: 100, w: 320, h: 200 });
    expect(resizeRect(r, 'n', 0, 10, min)).toEqual({ x: 100, y: 110, w: 300, h: 190 });
    expect(resizeRect(r, 'nw', 10, 10, min)).toEqual({ x: 110, y: 110, w: 290, h: 190 });
    expect(resizeRect(r, 'se', 5, 5, min)).toEqual({ x: 100, y: 100, w: 305, h: 205 });
  });
  it('respects the minimum size without moving the opposite edge', () => {
    const a = resizeRect(r, 'w', 500, 0, min);
    expect(a.w).toBe(200);
    expect(a.x + a.w).toBe(r.x + r.w);
    const b = resizeRect(r, 'n', 0, 500, min);
    expect(b.h).toBe(100);
    expect(b.y + b.h).toBe(r.y + r.h);
    expect(resizeRect(r, 'se', -500, -500, min)).toEqual({ x: 100, y: 100, w: 200, h: 100 });
  });
  it('keeps the top edge on the desktop', () => {
    const a = resizeRect(r, 'n', 0, -500, min);
    expect(a.y).toBe(0);
    expect(a.y + a.h).toBe(r.y + r.h);
  });
  it('keeps the caption reachable while dragging', () => {
    const desk = { w: 800, h: 570 };
    expect(moveRect(r, 10, 20, desk)).toEqual({ x: 110, y: 120 });
    expect(moveRect(r, 0, -1000, desk).y).toBe(0);
    expect(moveRect(r, 0, 1000, desk).y).toBe(desk.h - 18);
    expect(moveRect(r, 5000, 0, desk).x).toBe(desk.w - 40);
    expect(moveRect(r, -5000, 0, desk).x).toBe(40 - r.w);
  });
});

describe('98 chrome sprites', () => {
  it('draws 16×14 caption buttons with the raised and pressed bevels', () => {
    const n = captionButtonRows('close', 'n');
    expect(n.length).toBe(14);
    for (const row of n) expect(row.length).toBe(16);
    expect(n[0].slice(0, 15)).toBe('W'.repeat(15));
    expect(n[0][15]).toBe('K');
    expect(n[13]).toBe('K'.repeat(16));
    expect(n[1][1]).toBe('L');
    expect(n[12][14]).toBe('G');
    const p = captionButtonRows('close', 'p');
    expect(p[0][0]).toBe('K');
    expect(p[13][15]).toBe('W');
    // pressed glyph moves 1 px down-right
    expect(n[3][4]).toBe('T');
    expect(p[4][5]).toBe('T');
  });
  it('embosses disabled glyphs', () => {
    const d = captionButtonRows('max', 'd');
    expect(d[2][3]).toBe('G');
    expect(d[11][12]).toBe('W');
    expect(d.slice(2, 12).map((r) => r.slice(2, 14)).join('').includes('K')).toBe(false);
  });
  it('draws the size grip as three diagonal pairs', () => {
    const g = sizeGripRows();
    expect(g.length).toBe(12);
    expect(g[11]).toMatch(/W[G]{2}\.W[G]{2}\.W[G]{2}$/);
  });
});
