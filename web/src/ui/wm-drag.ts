// Window drag and resize: geometry as pure functions (unit-tested), plus a pointer-capture tracker that hands
// the latest delta to the caller once per animation frame. Callers move an outline frame while dragging and
// commit the window's geometry on release. No imports with side effects, so tests can load this in Node.

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const EDGES: Edge[] = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'];

/** Hit-zone thickness on the edges (the 98 sizing frame) and the length of the corner zones. */
export const RZ_EDGE = 4;
export const RZ_CORNER = 16;

/** Native cursor fallbacks; Phase 3 sets the --cur-* variables to the 98 cursors. */
export function edgeCursor(e: Edge): string {
  if (e === 'n' || e === 's') return 'var(--cur-ns, ns-resize)';
  if (e === 'e' || e === 'w') return 'var(--cur-ew, ew-resize)';
  if (e === 'nw' || e === 'se') return 'var(--cur-nwse, nwse-resize)';
  return 'var(--cur-nesw, nesw-resize)';
}

/** Box of an edge's hit zone, as CSS left/top/right/bottom/width/height in px (unset sides are absent). */
export function zoneBox(e: Edge, b = RZ_EDGE, c = RZ_CORNER): Partial<Record<'left' | 'top' | 'right' | 'bottom' | 'width' | 'height', number>> {
  switch (e) {
    case 'n':
      return { left: c, right: c, top: 0, height: b };
    case 's':
      return { left: c, right: c, bottom: 0, height: b };
    case 'w':
      return { top: c, bottom: c, left: 0, width: b };
    case 'e':
      return { top: c, bottom: c, right: 0, width: b };
    case 'nw':
      return { left: 0, top: 0, width: c, height: c };
    case 'ne':
      return { right: 0, top: 0, width: c, height: c };
    case 'sw':
      return { left: 0, bottom: 0, width: c, height: c };
    case 'se':
      return { right: 0, bottom: 0, width: c, height: c };
  }
}

/** Corner zones are c×c boxes clipped to an L of thickness b (clip-path also limits hit testing), so they
 *  never cover the caption icon. Returns null for the straight edges. */
export function zoneClip(e: Edge, b = RZ_EDGE, c = RZ_CORNER): string | null {
  const P = (...pts: [number, number][]) => `polygon(${pts.map(([x, y]) => `${x}px ${y}px`).join(', ')})`;
  const d = c - b;
  switch (e) {
    case 'nw':
      return P([0, 0], [c, 0], [c, b], [b, b], [b, c], [0, c]);
    case 'ne':
      return P([0, 0], [c, 0], [c, c], [d, c], [d, b], [0, b]);
    case 'sw':
      return P([0, 0], [b, 0], [b, d], [c, d], [c, c], [0, c]);
    case 'se':
      return P([d, 0], [c, 0], [c, c], [0, c], [0, d], [d, d]);
    default:
      return null;
  }
}

/** Which resize zone (if any) a point inside a w×h window falls in. Corner zones are L-shaped: only their
 *  outer b px belong to the corner, the rest of the square is window. */
export function edgeAt(px: number, py: number, w: number, h: number, b = RZ_EDGE, c = RZ_CORNER): Edge | null {
  if (px < 0 || py < 0 || px >= w || py >= h) return null;
  const n = py < b;
  const s = py >= h - b;
  const W = px < b;
  const E = px >= w - b;
  const nearL = px < c;
  const nearR = px >= w - c;
  const nearT = py < c;
  const nearB = py >= h - c;
  if ((n && nearL) || (W && nearT)) return 'nw';
  if ((n && nearR) || (E && nearT)) return 'ne';
  if ((s && nearL) || (W && nearB)) return 'sw';
  if ((s && nearR) || (E && nearB)) return 'se';
  if (n) return 'n';
  if (s) return 's';
  if (W) return 'w';
  if (E) return 'e';
  return null;
}

/** The rect after dragging `edge` by (dx, dy), respecting the minimum size and keeping the top edge on the
 *  desktop (y ≥ 0). The opposite edges stay put. */
export function resizeRect(r: Rect, edge: Edge, dx: number, dy: number, min: { w: number; h: number }, top = 0): Rect {
  let { x, y, w, h } = r;
  if (edge.includes('e')) w = Math.max(min.w, r.w + dx);
  if (edge.includes('s')) h = Math.max(min.h, r.h + dy);
  if (edge.includes('w')) {
    w = Math.max(min.w, r.w - dx);
    x = r.x + r.w - w;
  }
  if (edge.includes('n')) {
    const ny = Math.max(top, Math.min(r.y + dy, r.y + r.h - min.h));
    h = r.y + r.h - ny;
    y = ny;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Where a dragged window may go: its caption must stay reachable (top on the desktop, at least `keep` px of
 *  it horizontally on screen, and above the taskbar). */
export function moveRect(r: Rect, dx: number, dy: number, desk: { w: number; h: number }, keep = 40, cap = 18): { x: number; y: number } {
  const x = Math.min(Math.max(r.x + dx, keep - r.w), desk.w - keep);
  const y = Math.min(Math.max(r.y + dy, 0), desk.h - cap);
  return { x: Math.round(x), y: Math.round(y) };
}

type Pt = { x: number; y: number };

/** Tracks a pointer drag on `target` with pointer capture. onFrame gets the latest delta at most once per
 *  animation frame; onEnd gets the final delta (and whether the pointer moved at all). */
export function trackDrag(
  e: PointerEvent,
  target: HTMLElement,
  toUi: (e: { clientX: number; clientY: number }) => Pt,
  onFrame: (dx: number, dy: number) => void,
  onEnd: (dx: number, dy: number, moved: boolean) => void,
) {
  const start = toUi(e);
  let last = start;
  let moved = false;
  let raf = 0;
  try {
    target.setPointerCapture(e.pointerId);
  } catch {
    /* pointer already gone */
  }
  const frame = () => {
    raf = 0;
    onFrame(last.x - start.x, last.y - start.y);
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    last = toUi(ev);
    if (!moved && (last.x !== start.x || last.y !== start.y)) moved = true;
    if (moved && !raf) raf = requestAnimationFrame(frame);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (ev.type === 'pointerup') last = toUi(ev);
    onEnd(last.x - start.x, last.y - start.y, moved);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}
