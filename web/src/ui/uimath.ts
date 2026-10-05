// Pure placement and lookup helpers for menus, tooltips, drop-down lists and the context-menu dispatcher.
// No DOM access here, so they run (and are unit-tested) in node.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A popup opened at a point (context menu): right/below the point; flips to the left/above when it would
 *  leave the screen (as Windows 98 does), then is shifted so it stays fully visible. */
export function placeAtPoint(px: number, py: number, w: number, h: number, W: number, H: number): { x: number; y: number } {
  let x = px;
  let y = py;
  if (x + w > W) x = px - w >= 0 ? px - w : W - w;
  if (y + h > H) y = py - h >= 0 ? py - h : H - h;
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
}

/** A popup under an anchor (menu-bar title, combo box): below and left-aligned; above when there's no room
 *  below but there is above; shifted left to stay on screen. */
export function placeBelow(a: Box, w: number, h: number, W: number, H: number): { x: number; y: number; above: boolean } {
  let x = a.x;
  let y = a.y + a.h;
  let above = false;
  if (y + h > H) {
    if (a.y - h >= 0) {
      y = a.y - h;
      above = true;
    } else y = Math.max(0, H - h);
  }
  if (x + w > W) x = W - w;
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), above };
}

/** A cascading submenu beside its parent item. It opens to the right of the parent menu, overlapping by
 *  `overlap` px so the bevels meet; at the right edge it flips to the left side of the parent menu. The top
 *  lines up with the item (less the popup's frame) and is shifted up when it would run off the bottom. */
export function placeSubmenu(item: Box, parent: Box, w: number, h: number, W: number, H: number, frame = 3, overlap = 3): { x: number; y: number; left: boolean } {
  let x = parent.x + parent.w - overlap;
  let left = false;
  if (x + w > W) {
    const lx = parent.x - w + overlap;
    if (lx >= 0) {
      x = lx;
      left = true;
    } else x = W - w;
  }
  let y = item.y - frame;
  if (y + h > H) y = H - h;
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), left };
}

/** Tooltip position: under the cursor (Windows puts it below the pointer's hot spot by the cursor height),
 *  clamped to the screen; above the pointer if it would run off the bottom. */
export function clampTip(cx: number, cy: number, w: number, h: number, W: number, H: number, below = 20): { x: number; y: number } {
  let x = cx;
  let y = cy + below;
  if (y + h > H) y = cy - h - 2;
  if (x + w > W) x = W - w;
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
}

/** Parses "&File" style labels: the character after a single & is the mnemonic; "&&" is a literal &. */
export function parseMnemonic(label: string): { text: string; index: number; key: string } {
  let text = '';
  let index = -1;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === '&' && i + 1 < label.length) {
      if (label[i + 1] === '&') {
        text += '&';
        i++;
        continue;
      }
      if (index < 0) index = text.length;
      continue;
    }
    text += c;
  }
  return { text, index, key: index >= 0 ? text[index].toLowerCase() : '' };
}

/** The key a menu item answers to: its mnemonic, otherwise its first letter (as Windows does). */
export function mnemonicKey(label: string): string {
  const m = parseMnemonic(label);
  return m.key || (m.text.trim()[0] ?? '').toLowerCase();
}

/** Next index in `dir` (+1/-1) whose `ok(i)` is true, wrapping around; -1 when none. */
export function nextIndex(n: number, from: number, dir: 1 | -1, ok: (i: number) => boolean): number {
  for (let s = 1; s <= n; s++) {
    const i = (((from + dir * s) % n) + n) % n;
    if (ok(i)) return i;
  }
  return -1;
}

/** Type-ahead: the first label after `from` (wrapping) that starts with `prefix` (case-insensitive). */
export function typeAhead(labels: string[], from: number, prefix: string): number {
  const p = prefix.toLowerCase();
  if (!p) return -1;
  const n = labels.length;
  // a repeated single letter cycles through the matches; a longer prefix may stay on the current item
  const start = p.length > 1 ? Math.max(0, from) : from + 1;
  for (let s = 0; s < n; s++) {
    const i = (((start + s) % n) + n) % n;
    if (labels[i].toLowerCase().startsWith(p)) return i;
  }
  return -1;
}

export interface ContextEntry<B> {
  selector: string;
  build: B;
  order: number;
}

/** Context-menu target resolution. `chain` runs from the event target outwards. The deepest element that
 *  matches any registered selector wins; on the same element the most recently registered entry wins.
 *  Returns every candidate in priority order (the caller falls through when a builder returns null). */
export function contextCandidates<E, B>(chain: E[], entries: ContextEntry<B>[], matches: (el: E, selector: string) => boolean): { el: E; entry: ContextEntry<B> }[] {
  const out: { el: E; entry: ContextEntry<B> }[] = [];
  const sorted = entries.slice().sort((a, b) => b.order - a.order);
  for (const el of chain) for (const entry of sorted) if (matches(el, entry.selector)) out.push({ el, entry });
  return out;
}

/** Spin-button stepping: adds `dir` steps, snaps to the step grid from `min` (or 0), clamps, and drops float
 *  noise. */
export function spinStep(v: number, dir: 1 | -1, step = 1, min?: number, max?: number): number {
  const s = step > 0 ? step : 1;
  const base = min ?? 0;
  const k = Math.round((v - base) / s);
  let n = base + (k + dir) * s;
  const dec = (String(s).split('.')[1] ?? '').length;
  n = Number(n.toFixed(Math.min(10, dec)));
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  return n;
}
