import { describe, it, expect } from 'vitest';
import {
  CELL_W, CELL_H, gridSize, snapToGrid, nearestFreeCell, layoutIcons, arrange, compact, dropIcons, rectSelect, bandRect,
  combineSelection, neighbor, cascadeRects, tileRects, columnMajor, cellKey, setTextScale, cellSize, cellXY, type Cell,
} from '../src/shell/desktop-grid';

const size = { cols: 10, rows: 6 };

describe('desktop grid', () => {
  it('is 75×75 and counts whole cells', () => {
    expect([CELL_W, CELL_H]).toEqual([75, 75]);
    expect(gridSize(800, 572)).toEqual({ cols: 10, rows: 7 });
    expect(gridSize(10, 10)).toEqual({ cols: 1, rows: 1 });
  });
  // 03-3: at Large Fonts two label lines didn't fit a 75 px cell, so the labels ran into the next icon
  it('grows with the text scale and goes back', () => {
    setTextScale(2);
    expect(cellSize()).toEqual({ w: 120, h: 115 });
    // icon 32 + gaps 6 + two 32 px label lines + 1
    expect(cellSize().h).toBeGreaterThanOrEqual(32 + 6 + 2 * 32 + 1);
    expect(gridSize(800, 572)).toEqual({ cols: 6, rows: 4 });
    expect(cellXY({ c: 1, r: 2 })).toEqual({ x: 120, y: 230 });
    expect(snapToGrid(130, 240)).toEqual({ c: 1, r: 2 });
    setTextScale(1);
    expect(cellSize()).toEqual({ w: CELL_W, h: CELL_H });
  });
  it('snapToGrid rounds to the nearest cell and clamps to the grid', () => {
    expect(snapToGrid(0, 0)).toEqual({ c: 0, r: 0 });
    expect(snapToGrid(37, 38)).toEqual({ c: 0, r: 1 });
    expect(snapToGrid(113, 112)).toEqual({ c: 2, r: 1 });
    expect(snapToGrid(-200, -5)).toEqual({ c: 0, r: 0 });
    expect(snapToGrid(5000, 5000, size)).toEqual({ c: 9, r: 5 });
  });
  it('fills column-major from the top left', () => {
    expect([0, 1, 5, 6, 7].map((i) => columnMajor(i, 6))).toEqual([
      { c: 0, r: 0 }, { c: 0, r: 1 }, { c: 0, r: 5 }, { c: 1, r: 0 }, { c: 1, r: 1 },
    ]);
  });
  it('nearestFreeCell picks the closest free cell, ties to the earlier column-major one', () => {
    const taken = new Set(['2,2']);
    expect(nearestFreeCell({ c: 3, r: 3 }, taken, size)).toEqual({ c: 3, r: 3 });
    expect(nearestFreeCell({ c: 2, r: 2 }, taken, size)).toEqual({ c: 1, r: 2 });
    const full = new Set<string>();
    for (let c = 0; c < 2; c++) for (let r = 0; r < 2; r++) full.add(`${c},${r}`);
    expect(nearestFreeCell({ c: 0, r: 0 }, full, { cols: 2, rows: 2 })).toBeNull();
  });
});

describe('layoutIcons', () => {
  it('fills unsaved icons column-major', () => {
    const l = layoutIcons(['a', 'b', 'c'], {}, { cols: 4, rows: 2 });
    expect(l).toEqual({ a: { c: 0, r: 0 }, b: { c: 0, r: 1 }, c: { c: 1, r: 0 } });
  });
  it('keeps saved cells and puts the rest around them', () => {
    const l = layoutIcons(['a', 'b', 'c'], { b: [0, 0], c: [3, 1] }, { cols: 4, rows: 2 });
    expect(l).toEqual({ a: { c: 0, r: 1 }, b: { c: 0, r: 0 }, c: { c: 3, r: 1 } });
  });
  it('moves off-grid and colliding saved cells to the nearest free cell', () => {
    const l = layoutIcons(['a', 'b'], { a: [9, 9], b: [9, 9] }, { cols: 3, rows: 2 });
    expect(l.a).toEqual({ c: 2, r: 1 });
    // (1,1) and (2,0) are equally near: the earlier column-major cell wins
    expect(l.b).toEqual({ c: 1, r: 1 });
  });
});

describe('arrange', () => {
  const items = [
    { id: 'zeta', name: 'Zeta', type: 'Application' },
    { id: 'bin', name: 'Recycle Bin', type: 'System Folder', rank: 2 },
    { id: 'alpha', name: 'alpha', type: 'Shortcut' },
    { id: 'disk', name: 'Removable Disk', type: 'System Folder', rank: 0 },
    { id: 'mid', name: 'Mid', type: 'Application' },
  ];
  it('by Name: system icons first, then case-insensitive names', () => {
    const a = arrange(items, 'name', 3);
    const order = Object.entries(a).sort(([, x], [, y]) => x.c * 3 + x.r - (y.c * 3 + y.r)).map(([id]) => id);
    expect(order).toEqual(['disk', 'bin', 'alpha', 'mid', 'zeta']);
    expect(a.alpha).toEqual({ c: 0, r: 2 });
    expect(a.mid).toEqual({ c: 1, r: 0 });
  });
  it('by Type: system icons first, then type, then name', () => {
    const a = arrange(items, 'type', 10);
    expect([a.disk, a.bin, a.mid, a.zeta, a.alpha].map((c) => c.r)).toEqual([0, 1, 2, 3, 4]);
  });
  it('compact closes the gaps and keeps the reading order', () => {
    expect(compact({ a: { c: 3, r: 1 }, b: { c: 0, r: 4 }, c: { c: 3, r: 0 } }, 2)).toEqual({ b: { c: 0, r: 0 }, c: { c: 0, r: 1 }, a: { c: 1, r: 0 } });
  });
});

describe('dropIcons (snap-to-grid drag)', () => {
  const cells = { a: { c: 0, r: 0 }, b: { c: 0, r: 1 }, c: { c: 0, r: 2 } };
  it('snaps a dragged icon to the nearest cell', () => {
    expect(dropIcons(cells, ['a'], 160, 10, size).a).toEqual({ c: 2, r: 0 });
    expect(dropIcons(cells, ['a'], 100, 100, size).a).toEqual({ c: 1, r: 1 });
  });
  it('drops onto an occupied cell move to the nearest free one; others stay', () => {
    const d = dropIcons(cells, ['a'], 0, 80, size);
    expect(d.b).toEqual({ c: 0, r: 1 });
    expect(d.a).not.toEqual({ c: 0, r: 1 });
    expect(new Set(Object.values(d).map(cellKey)).size).toBe(3);
  });
  it('moves a multi-selection together', () => {
    const d = dropIcons(cells, ['b', 'c'], 300, 0, size);
    expect(d.b).toEqual({ c: 4, r: 1 });
    expect(d.c).toEqual({ c: 4, r: 2 });
    expect(d.a).toEqual({ c: 0, r: 0 });
  });
  it('clamps to the desktop', () => {
    expect(dropIcons(cells, ['a'], -500, 9000, size).a).toEqual({ c: 0, r: 5 });
  });
});

describe('rubber band', () => {
  const items = [
    { id: 'a', boxes: [{ x: 21, y: 2, w: 32, h: 32 }, { x: 10, y: 37, w: 55, h: 13 }] },
    { id: 'b', boxes: [{ x: 21, y: 77, w: 32, h: 32 }] },
    { id: 'c', boxes: [{ x: 96, y: 2, w: 32, h: 32 }] },
  ];
  it('normalises a band dragged up-left', () => {
    expect(bandRect(100, 90, 20, 10)).toEqual({ x: 20, y: 10, w: 80, h: 80 });
  });
  it('selects icons whose image or label the band touches', () => {
    expect(rectSelect(bandRect(0, 0, 30, 90), items)).toEqual(['a', 'b']);
    expect(rectSelect(bandRect(60, 40, 64, 45), items)).toEqual(['a']);
    expect(rectSelect(bandRect(70, 50, 90, 70), items)).toEqual([]);
    expect(rectSelect(bandRect(0, 0, 200, 200), items)).toEqual(['a', 'b', 'c']);
  });
  it('Shift adds, Ctrl toggles', () => {
    expect(combineSelection(['a'], ['b'], 'replace')).toEqual(['b']);
    expect(combineSelection(['a'], ['a', 'b'], 'add').sort()).toEqual(['a', 'b']);
    expect(combineSelection(['a', 'c'], ['a', 'b'], 'toggle').sort()).toEqual(['b', 'c']);
  });
});

describe('arrow keys', () => {
  const cells: Record<string, Cell> = { a: { c: 0, r: 0 }, b: { c: 0, r: 1 }, c: { c: 1, r: 0 }, d: { c: 2, r: 1 } };
  it('moves to the nearest icon in the direction', () => {
    expect(neighbor(cells, 'a', 'down')).toBe('b');
    expect(neighbor(cells, 'a', 'right')).toBe('c');
    // same row two cells away beats the diagonal next column
    expect(neighbor(cells, 'b', 'right')).toBe('d');
    expect(neighbor(cells, 'c', 'right')).toBe('d');
    expect(neighbor(cells, 'a', 'up')).toBeNull();
    expect(neighbor(cells, 'a', 'left')).toBeNull();
  });
});

describe('Cascade / Tile', () => {
  it('cascades one caption apart and starts over at the edge', () => {
    const r = cascadeRects(3, 800, 572);
    expect(r[0]).toEqual({ x: 0, y: 0, w: 600, h: 429 });
    expect(r[1]).toMatchObject({ x: 22, y: 22 });
    const many = cascadeRects(12, 800, 572);
    for (const b of many) expect(b.x + b.w <= 800 && b.y + b.h <= 572).toBe(true);
    expect(many.some((b, i) => i > 0 && b.x === 0)).toBe(true);
  });
  it('tiles horizontally as full-width strips and vertically as columns', () => {
    expect(tileRects(2, 800, 600, 'h')).toEqual([{ x: 0, y: 0, w: 800, h: 300 }, { x: 0, y: 300, w: 800, h: 300 }]);
    expect(tileRects(3, 900, 600, 'v')).toEqual([{ x: 0, y: 0, w: 300, h: 600 }, { x: 300, y: 0, w: 300, h: 600 }, { x: 600, y: 0, w: 300, h: 600 }]);
  });
  it('covers the desktop exactly with a grid for 4+ windows', () => {
    for (const mode of ['h', 'v'] as const)
      for (const n of [4, 5, 7]) {
        const r = tileRects(n, 801, 573, mode);
        expect(r.length).toBe(n);
        expect(r.reduce((a, b) => a + b.w * b.h, 0)).toBe(801 * 573);
      }
  });
});
