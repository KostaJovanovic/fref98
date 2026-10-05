// Pure geometry for the desktop: the 98 icon grid (75×75 cells, column-major from the top left), snapping,
// arranging, rubber-band hits, keyboard neighbours, and the taskbar's Cascade / Tile window layouts. No DOM.
import { neighborInDir, type Dir } from '../ui/uimath';

export const CELL_W = 75;
export const CELL_H = 75;
/** Extra cell room per step of text scale (Large Fonts spread the icons, as in 98): two label lines and the
 *  wider label. Keep in step with `.dicon` in desktop.css. */
export const CELL_GROW_W = 45;
export const CELL_GROW_H = 40;

let cellW = CELL_W;
let cellH = CELL_H;

/** Sets the grid for a text scale (1 = the 98 75×75 grid). */
export function setTextScale(ts: number) {
  cellW = CELL_W + CELL_GROW_W * (ts - 1);
  cellH = CELL_H + CELL_GROW_H * (ts - 1);
}

/** The current cell size in UI px. */
export function cellSize(): { w: number; h: number } {
  return { w: cellW, h: cellH };
}

export interface Cell {
  c: number;
  r: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface GridSize {
  cols: number;
  rows: number;
}
export type Cells = Record<string, Cell>;

export const cellKey = (c: Cell) => `${c.c},${c.r}`;

/** How many whole cells fit on a desktop of w×h UI px (at least 1×1). */
export function gridSize(w: number, h: number): GridSize {
  return { cols: Math.max(1, Math.floor(w / cellW)), rows: Math.max(1, Math.floor(h / cellH)) };
}

/** Top-left of a cell in desktop px. */
export function cellXY(c: Cell): { x: number; y: number } {
  return { x: c.c * cellW, y: c.r * cellH };
}

export function inBounds(c: Cell, size: GridSize): boolean {
  return c.c >= 0 && c.r >= 0 && c.c < size.cols && c.r < size.rows;
}

/** The cell whose top-left is nearest to (x,y) (a cell's top-left in px), clamped to the grid when a size is
 *  given. */
export function snapToGrid(x: number, y: number, size?: GridSize): Cell {
  let c = Math.max(0, Math.round(x / cellW));
  let r = Math.max(0, Math.round(y / cellH));
  if (size) {
    c = Math.min(c, size.cols - 1);
    r = Math.min(r, size.rows - 1);
  }
  return { c, r };
}

/** Column-major order: index i is row i % rows of column i / rows. */
export function columnMajor(i: number, rows: number): Cell {
  return { c: Math.floor(i / rows), r: i % rows };
}

const cmIndex = (c: Cell, rows: number) => c.c * rows + c.r;

/** The free cell closest to `want` (Euclidean, ties to the earlier column-major cell). Null when the grid is
 *  full. */
export function nearestFreeCell(want: Cell, taken: Set<string>, size: GridSize): Cell | null {
  let best: Cell | null = null;
  let bestD = Infinity;
  for (let c = 0; c < size.cols; c++)
    for (let r = 0; r < size.rows; r++) {
      if (taken.has(`${c},${r}`)) continue;
      const d = (c - want.c) ** 2 + (r - want.r) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { c, r };
      }
    }
  return best;
}

/** First free cell in column-major order, or one past the grid's last column when it is full. */
function firstFree(taken: Set<string>, size: GridSize): Cell {
  for (let i = 0; ; i++) {
    const c = columnMajor(i, size.rows);
    if (!taken.has(cellKey(c))) return c;
  }
}

/** Places icons: saved cells are kept when they are on the grid and free, otherwise moved to the nearest free
 *  cell; icons without a saved cell fill the first free cells column-major. When the grid is full, icons go
 *  past its last column. */
export function layoutIcons(ids: string[], saved: Record<string, [number, number] | undefined>, size: GridSize): Cells {
  const out: Cells = {};
  const taken = new Set<string>();
  const put = (id: string, c: Cell) => {
    out[id] = c;
    taken.add(cellKey(c));
  };
  for (const id of ids) {
    const s = saved[id];
    if (!s) continue;
    const want = { c: Math.max(0, Math.round(s[0])), r: Math.max(0, Math.round(s[1])) };
    if (inBounds(want, size) && !taken.has(cellKey(want))) put(id, want);
    else {
      const clamped = { c: Math.min(want.c, size.cols - 1), r: Math.min(want.r, size.rows - 1) };
      put(id, nearestFreeCell(clamped, taken, size) ?? firstFree(taken, size));
    }
  }
  for (const id of ids) if (!out[id]) put(id, firstFree(taken, size));
  return out;
}

export interface IconInfo {
  id: string;
  name: string;
  type: string;
  /** System icons (disk, pictures, Recycle Bin) keep this order before everything else, as in 98. */
  rank?: number;
}

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** Arrange Icons ▸ by Name / by Type: system icons first (by rank), then the rest sorted, column-major. */
export function arrange(items: IconInfo[], by: 'name' | 'type', rows: number): Cells {
  const sys = items.filter((i) => i.rank !== undefined).sort((a, b) => a.rank! - b.rank!);
  const rest = items
    .filter((i) => i.rank === undefined)
    .sort((a, b) => (by === 'type' ? cmp(a.type, b.type) || cmp(a.name, b.name) : cmp(a.name, b.name) || cmp(a.type, b.type)));
  const out: Cells = {};
  [...sys, ...rest].forEach((it, i) => (out[it.id] = columnMajor(i, Math.max(1, rows))));
  return out;
}

/** Auto Arrange: keeps the icons' current reading order (column-major) and closes the gaps. */
export function compact(cells: Cells, rows: number): Cells {
  const ids = Object.keys(cells).sort((a, b) => cmIndex(cells[a], rows) - cmIndex(cells[b], rows));
  const out: Cells = {};
  ids.forEach((id, i) => (out[id] = columnMajor(i, Math.max(1, rows))));
  return out;
}

/** Drops the dragged icons moved by (dx,dy) px: each snaps to the cell nearest its new position, or the nearest
 *  free one. `moving[0]` (the icon under the pointer) is placed first. Other icons stay. */
export function dropIcons(cells: Cells, moving: string[], dx: number, dy: number, size: GridSize): Cells {
  const out: Cells = { ...cells };
  const set = new Set(moving);
  const taken = new Set(Object.keys(cells).filter((id) => !set.has(id)).map((id) => cellKey(cells[id])));
  for (const id of moving) {
    const p = cellXY(cells[id]);
    const want = snapToGrid(p.x + dx, p.y + dy, size);
    const c = taken.has(cellKey(want)) ? nearestFreeCell(want, taken, size) : want;
    if (!c) continue; // grid full: it stays where it was
    out[id] = c;
    taken.add(cellKey(c));
  }
  return out;
}

/** The normalised rectangle between two points. */
export function bandRect(x0: number, y0: number, x1: number, y1: number): Box {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

const overlaps = (a: Box, b: Box) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

/** Ids whose hit boxes (icon image, label) the rubber band touches. */
export function rectSelect(band: Box, items: { id: string; boxes: Box[] }[]): string[] {
  return items.filter((it) => it.boxes.some((b) => overlaps(band, b))).map((it) => it.id);
}

/** Rubber-band selection with modifiers: plain replaces, Shift adds, Ctrl toggles the band's hits. */
export function combineSelection(base: Iterable<string>, hits: string[], mode: 'replace' | 'add' | 'toggle'): string[] {
  if (mode === 'replace') return [...hits];
  const s = new Set(base);
  for (const id of hits) {
    if (mode === 'toggle' && s.has(id)) s.delete(id);
    else s.add(id);
  }
  return [...s];
}

export type { Dir };

/** The icon an arrow key moves to: the nearest one in that direction (sideways distance counts double). */
export function neighbor(cells: Cells, from: string, dir: Dir): string | null {
  return neighborInDir(Object.entries(cells).map(([id, c]) => ({ id, x: c.c, y: c.r })), from, dir);
}

// ------------------------------------------------------------------ taskbar: Cascade / Tile

/** Cascade Windows: each window one caption (22 px) further down and right, 3/4 of the desktop in size;
 *  the stair starts over when the next window would leave the desktop. */
export function cascadeRects(n: number, W: number, H: number, step = 22): Box[] {
  const w = Math.max(200, Math.round((W * 3) / 4));
  const h = Math.max(120, Math.round((H * 3) / 4));
  const fit = Math.max(1, Math.min(Math.floor((W - w) / step), Math.floor((H - h) / step)) + 1);
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const k = i % fit;
    out.push({ x: k * step, y: k * step, w: Math.min(w, W), h: Math.min(h, H) });
  }
  return out;
}

/** Tile Windows Horizontally ('h': full-width strips stacked top to bottom) or Vertically ('v': full-height
 *  columns side by side). Four or more windows make a grid; later lanes take the extra window. */
export function tileRects(n: number, W: number, H: number, mode: 'h' | 'v'): Box[] {
  if (n <= 0) return [];
  // build as 'h' in a (lanes across) × (windows down each lane) layout, then transpose for 'v'
  const [AW, AH] = mode === 'h' ? [W, H] : [H, W];
  const lanes = n <= 3 ? 1 : Math.floor(Math.sqrt(n));
  const base = Math.floor(n / lanes);
  const extra = n % lanes;
  const out: Box[] = [];
  const laneW = Math.floor(AW / lanes);
  for (let l = 0; l < lanes; l++) {
    const count = base + (l >= lanes - extra ? 1 : 0);
    const x = l * laneW;
    const w = l === lanes - 1 ? AW - x : laneW;
    const hh = Math.floor(AH / count);
    for (let i = 0; i < count; i++) {
      const y = i * hh;
      const b = { x, y, w, h: i === count - 1 ? AH - y : hh };
      out.push(mode === 'h' ? b : { x: b.y, y: b.x, w: b.h, h: b.w });
    }
  }
  return out;
}
