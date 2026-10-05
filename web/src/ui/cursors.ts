// The Windows 98 cursor set, redrawn by us: 1-bit black and white, no shadow. Each cursor is a list of pixel
// rows ('X' black, 'O' white, '.' transparent) plus a hot spot, rendered at n device pixels per cursor pixel
// (n = round(screen scale)) and declared through image-set() at the screen's own resolution, so the browser
// shows it 1:1 on the device and never rescales it.
//
// How Chromium sizes a custom cursor (event_handler.cc + content/common/cursors/webcursor_aura.cc): the bitmap
// is scaled by displayScale / imageScaleFactor, where imageScaleFactor is the chosen image-set() resolution
// and displayScale is the OS display scale. Neither the page zoom (Ctrl+/−) nor CSS `zoom` (our ui.k root
// zoom) enter that formula, and the hot spot numbers are not zoomed either. But window.devicePixelRatio
// DOES include the page zoom, so the screen scale is dpr / pageZoom, with the page zoom estimated from
// outerWidth / innerWidth and snapped to Chrome's zoom levels (see screenScale()).
import { ascii, makeCanvas, scaleCanvas } from './art';
import './css/cursors.css';

export interface CursorArt {
  rows: string[];
  hot: [number, number];
}

// ------------------------------------------------------------------ pure pixel art

/** Pads every row to the same width. */
function pad(rows: string[], w = Math.max(...rows.map((r) => r.length))): string[] {
  return rows.map((r) => r.padEnd(w, '.'));
}

/** Builds rows from a function of (x, y). */
function grid(w: number, h: number, f: (x: number, y: number) => string): string[] {
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) r += f(x, y);
    out.push(r);
  }
  return out;
}

/** Puts a 1 px white ring (8-neighbour) around the black pixels; the grid grows by 1 on every side. */
export function outlined(core: string[]): string[] {
  const src = pad(core);
  const w = src[0].length + 2;
  const h = src.length + 2;
  const at = (x: number, y: number) => (y >= 1 && y <= src.length && x >= 1 && x <= src[0].length ? src[y - 1][x - 1] : '.');
  return grid(w, h, (x, y) => {
    const c = at(x, y);
    if (c !== '.') return c;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === 'X') return 'O';
    return '.';
  });
}

/** Draws `top` over `base` at (ox, oy) ('.' in top is transparent). The canvas grows to fit. */
function overlay(base: string[], top: string[], ox: number, oy: number): string[] {
  const w = Math.max(base[0]?.length ?? 0, ...base.map((r) => r.length), ox + Math.max(...top.map((r) => r.length)));
  const h = Math.max(base.length, oy + top.length);
  const b = pad([...base, ...Array(Math.max(0, h - base.length)).fill('')], w);
  return b.map((r, y) => {
    const t = top[y - oy];
    if (!t) return r;
    let s = '';
    for (let x = 0; x < w; x++) {
      const c = t[x - ox];
      s += c && c !== '.' ? c : r[x];
    }
    return s;
  });
}

function transpose(rows: string[]): string[] {
  const p = pad(rows);
  return grid(p.length, p[0].length, (x, y) => p[x][y]);
}

function mirrorX(rows: string[]): string[] {
  return pad(rows).map((r) => [...r].reverse().join(''));
}

/** Rotates 90° clockwise. */
function rotateCw(rows: string[]): string[] {
  const p = pad(rows);
  const h = p.length;
  return grid(h, p[0].length, (x, y) => p[h - 1 - x][y]);
}

/** The classic arrow: black outline, white fill, 12×19. */
const ARROW = [
  'X',
  'XX',
  'XOX',
  'XOOX',
  'XOOOX',
  'XOOOOX',
  'XOOOOOX',
  'XOOOOOOX',
  'XOOOOOOOX',
  'XOOOOOOOOX',
  'XOOOOOOOOOX',
  'XOOOOOOXXXXX',
  'XOOOXOOX',
  'XOOXXOOX',
  'XOX..XOOX',
  'XX...XOOX',
  'X.....XOOX',
  '......XOOX',
  '.......XX',
];

/** The link-select hand (pointing index finger), 16×20. */
const HAND = [
  '.....XX',
  '....XOOX',
  '....XOOX',
  '....XOOX',
  '....XOOX',
  '....XOOXXX',
  '....XOOXOOXXX',
  '....XOOXOOXOOXX',
  'XXX.XOOXOOXOOXOX',
  'XOOXXOOXOOXOOXOX',
  'XOOOXOOOOOOOOOOX',
  '.XOOXOOOOOOOOOOX',
  '..XOOOOOOOOOOOOX',
  '..XOOOOOOOOOOOOX',
  '...XOOOOOOOOOOX',
  '...XOOOOOOOOOOX',
  '....XOOOOOOOOX',
  '....XOOOOOOOOX',
  '....XOOOOOOOOX',
  '....XXXXXXXXXX',
];

const IBEAM_CORE = ['XXX.XXX', ...Array(14).fill('...X...'), 'XXX.XXX'];

/** Hourglass glass template: t = top bulb, n = neck, b = bottom bulb (all glass, white unless sand). */
const GLASS_BIG = [
  'XXXXXXXXXXXXX',
  'XOOOOOOOOOOOX',
  'XXXXXXXXXXXXX',
  '.XtttttttttX.',
  '.XtttttttttX.',
  '.XtttttttttX.',
  '..XtttttttX..',
  '...XtttttX...',
  '....XtttX....',
  '.....XnX.....',
  '....XbbbX....',
  '...XbbbbbX...',
  '..XbbbbbbbX..',
  '.XbbbbbbbbbX.',
  '.XbbbbbbbbbX.',
  '.XbbbbbbbbbX.',
  'XXXXXXXXXXXXX',
  'XOOOOOOOOOOOX',
  'XXXXXXXXXXXXX',
];
const GLASS_SMALL = [
  'XXXXXXXXX',
  '.XtttttX.',
  '.XtttttX.',
  '..XtttX..',
  '...XnX...',
  '..XbbbX..',
  '.XbbbbbX.',
  '.XbbbbbX.',
  'XXXXXXXXX',
];

/** Number of sand frames; one more frame shows the glass turning on its side. */
export const SAND_FRAMES = 6;
export const WAIT_FRAMES = SAND_FRAMES + 1;

/** Fills `count` cells of bulb `ch`, row by row starting at the bottom row, centre-out within a row. */
function fillBulb(rows: string[][], ch: string, count: number) {
  for (let y = rows.length - 1; y >= 0 && count > 0; y--) {
    const xs: number[] = [];
    rows[y].forEach((c, x) => c === ch && xs.push(x));
    if (!xs.length) continue;
    const mid = (xs[0] + xs[xs.length - 1]) / 2;
    xs.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
    for (const x of xs) {
      if (count <= 0) break;
      rows[y][x] = 'X';
      count--;
    }
  }
}

/** One frame of an hourglass: sand drains from the top bulb into a pile in the bottom one. */
export function hourglass(frame: number, small = false): string[] {
  const tpl = small ? GLASS_SMALL : GLASS_BIG;
  const sand = small ? 8 : 24;
  const f = ((frame % WAIT_FRAMES) + WAIT_FRAMES) % WAIT_FRAMES;
  if (f === SAND_FRAMES) return rotateCw(hourglass(SAND_FRAMES - 1, small));
  const top = Math.round(sand * (1 - f / (SAND_FRAMES - 1)));
  const cells = tpl.map((r) => [...r]);
  fillBulb(cells, 't', top);
  // the pile sits at the bottom of the lower bulb
  fillBulb(cells, 'b', sand - top);
  if (top > 0 && top < sand) {
    // the falling stream: the neck and the centre column down to the pile
    const cx = Math.floor(tpl[0].length / 2);
    let y = cells.findIndex((r) => r.includes('n'));
    cells[y][cx] = 'X';
    for (y++; y < cells.length && cells[y][cx] === 'b'; y++) cells[y][cx] = 'X';
  }
  return cells.map((r) => r.join('').replace(/[tnb]/g, 'O'));
}

/** Double-headed arrow, vertical: heads 1/3/5/7 px wide, a 1 px shaft. */
function nsCore(shaft = 7): string[] {
  const head = ['...X...', '..XXX..', '.XXXXX.', 'XXXXXXX'];
  return [...head, ...Array(shaft).fill('...X...'), ...head.slice().reverse()];
}

function diagCore(): string[] {
  const n = 11;
  return grid(n, n, (x, y) => (x + y <= 5 || n - 1 - x + (n - 1 - y) <= 5 || x === y ? 'X' : '.'));
}

function moveCore(L = 10): string[] {
  const n = L * 2 + 1;
  return grid(n, n, (x, y) => {
    const dx = Math.abs(x - L);
    const dy = Math.abs(y - L);
    if (x === L || y === L) return 'X';
    // heads: the last 4 px of each arm, 1 px at the tip widening to 7 px
    if (L - dy < 4 && dx <= L - dy) return 'X';
    if (L - dx < 4 && dy <= L - dx) return 'X';
    return '.';
  });
}

function noCore(): string[] {
  const n = 20;
  const c = (n - 1) / 2;
  return grid(n, n, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    if (d <= c + 0.3 && d >= c - 2.9) return 'X';
    if (d < c - 2.9 && Math.abs(x - y) <= 1.5) return 'X';
    return '.';
  });
}

const QUESTION = ['.XXXX.', 'XX..XX', 'XX..XX', '....XX', '...XX.', '..XX..', '..XX..', '......', '..XX..', '..XX..'];

function crossCore(): string[] {
  const n = 21;
  const c = 10;
  return grid(n, n, (x, y) => ((x === c && Math.abs(y - c) > 1) || (y === c && Math.abs(x - c) > 1) ? 'X' : '.'));
}

/** A pen held at 45°, nib at the bottom left (the hot spot). u runs along the pen, v across it. */
function penRows(): string[] {
  return grid(16, 16, (x, y) => {
    const u = x - y;
    const v = x + y;
    const dv = Math.abs(v - 15);
    if (u < -13 || u > 12) return '.';
    if (u >= -9) {
      if (dv > 2) return '.';
      return dv === 2 || u === -9 || u === 12 || u === 7 ? 'X' : 'O';
    }
    const w = u <= -12 ? 0 : u <= -11 ? 1 : 2;
    if (dv > w) return '.';
    return dv === w || u <= -12 ? 'X' : 'O';
  });
}

export type CursorName = 'arrow' | 'hand' | 'text' | 'wait' | 'wait-bg' | 'ns' | 'ew' | 'nwse' | 'nesw' | 'move' | 'no' | 'help' | 'cross' | 'pen';

/** CSS custom property and native fallback for each cursor. */
export const CURSOR_VARS: Record<CursorName, [string, string]> = {
  arrow: ['--cur-arrow', 'default'],
  hand: ['--cur-hand', 'pointer'],
  text: ['--cur-text', 'text'],
  wait: ['--cur-wait', 'wait'],
  'wait-bg': ['--cur-wait-bg', 'progress'],
  ns: ['--cur-ns', 'ns-resize'],
  ew: ['--cur-ew', 'ew-resize'],
  nwse: ['--cur-nwse', 'nwse-resize'],
  nesw: ['--cur-nesw', 'nesw-resize'],
  move: ['--cur-move', 'move'],
  no: ['--cur-no', 'not-allowed'],
  help: ['--cur-help', 'help'],
  cross: ['--cur-cross', 'crosshair'],
  pen: ['--cur-pen', 'crosshair'],
};

const centre = (rows: string[]): [number, number] => [Math.floor(Math.max(...rows.map((r) => r.length)) / 2), Math.floor(rows.length / 2)];

/** The pixel art of a cursor (animated ones take a frame number). */
export function cursorArt(name: CursorName, frame = 0): CursorArt {
  switch (name) {
    case 'arrow':
      return { rows: ARROW, hot: [0, 0] };
    case 'hand':
      return { rows: HAND, hot: [5, 0] };
    case 'text': {
      const rows = outlined(IBEAM_CORE);
      return { rows, hot: [4, 9] };
    }
    case 'wait': {
      const rows = hourglass(frame);
      return { rows, hot: centre(rows) };
    }
    case 'wait-bg': {
      const g = hourglass(frame, true);
      // the small glass sits right of the arrow's lower half; a turned glass is centred on the same spot
      const ox = 12 + Math.floor((9 - Math.max(...g.map((r) => r.length))) / 2);
      const oy = 8 + Math.floor((9 - g.length) / 2);
      return { rows: overlay(ARROW, g, ox, oy), hot: [0, 0] };
    }
    case 'ns': {
      const rows = outlined(nsCore());
      return { rows, hot: centre(rows) };
    }
    case 'ew': {
      const rows = outlined(transpose(nsCore()));
      return { rows, hot: centre(rows) };
    }
    case 'nwse': {
      const rows = outlined(diagCore());
      return { rows, hot: centre(rows) };
    }
    case 'nesw': {
      const rows = outlined(mirrorX(diagCore()));
      return { rows, hot: centre(rows) };
    }
    case 'move': {
      const rows = outlined(moveCore());
      return { rows, hot: centre(rows) };
    }
    case 'no': {
      const rows = outlined(noCore());
      return { rows, hot: [10, 10] };
    }
    case 'help':
      return { rows: overlay(ARROW, outlined(QUESTION), 12, 0), hot: [0, 0] };
    case 'cross': {
      const rows = outlined(crossCore());
      return { rows, hot: [11, 11] };
    }
    case 'pen':
      return { rows: penRows(), hot: [1, 14] };
  }
}

export const CURSOR_NAMES = Object.keys(CURSOR_VARS) as CursorName[];
export const ANIMATED: CursorName[] = ['wait', 'wait-bg'];

// ------------------------------------------------------------------ pure scale maths

/** Chrome's page zoom levels (Ctrl+/−). */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** Is s a plausible OS display scale (a quarter step, as Windows, macOS and Linux offer)? */
function plausible(s: number): boolean {
  return s >= 0.5 && Math.abs(s * 4 - Math.round(s * 4)) < 0.08;
}

/** Page zoom from outerWidth / innerWidth (outer is in screen DIPs, inner in CSS px), snapped to a Chrome zoom
 *  level. Returns 1 when the ratio isn't close to a level (DevTools docked, odd window chrome, no outer size). */
export function estimatePageZoom(outerW: number, innerW: number): number {
  if (!(outerW > 0) || !(innerW > 0)) return 1;
  const r = outerW / innerW;
  let best = 1;
  for (const z of ZOOM_LEVELS) if (Math.abs(z - r) < Math.abs(best - r)) best = z;
  // the frame and scrollbar add a few px to outerWidth; allow 4 %
  return Math.abs(best - r) / best <= 0.04 ? best : 1;
}

/** The OS display scale: devicePixelRatio without the page zoom, when that gives a plausible scale. */
export function screenScale(dpr: number, pageZoom = 1): number {
  const s = dpr / pageZoom;
  if (plausible(s) || !plausible(dpr)) return +s.toFixed(4);
  return +dpr.toFixed(4);
}

/** n: device pixels per cursor pixel; res: the image-set() resolution that makes the browser draw the
 *  n-scaled bitmap without rescaling (displayScale / res = 1). Neither depends on ui.k or the page zoom. */
export function cursorScale(screen: number): { n: number; res: number } {
  const n = Math.max(1, Math.round(screen));
  return { n, res: +screen.toFixed(4) };
}

/** Integer CSS hot-spot coordinate c (Chrome stores it as an int and scales it by res, rounding) that lands
 *  on cursor pixel `hot` of the n-scaled bitmap. */
export function hotCss(hot: number, n: number, res: number): number {
  const target = hot * n;
  const c0 = Math.round(target / res);
  let best = c0;
  for (const c of [c0 - 1, c0, c0 + 1]) if (c >= 0 && Math.abs(Math.round(c * res) - target) < Math.abs(Math.round(best * res) - target)) best = c;
  return Math.max(0, best);
}

/** Device pixel the browser will use as the hot spot for CSS hot spot c. */
export function hotDevice(c: number, res: number): number {
  return Math.round(c * res);
}

/** The CSS cursor value. */
export function cursorValue(url: string, hot: [number, number], n: number, res: number, fallback: string, imageSet = true): string {
  if (!imageSet) return `url("${url}") ${hot[0]} ${hot[1]}, ${fallback}`;
  return `image-set(url("${url}") ${res}x) ${hotCss(hot[0], n, res)} ${hotCss(hot[1], n, res)}, ${fallback}`;
}

// ------------------------------------------------------------------ DOM: rendering and applying

const urls = new Map<string, string>();

/** PNG data URL of a cursor drawn at n device pixels per cursor pixel. */
export function cursorUrl(name: CursorName, n: number, frame = 0): string {
  const key = `${name}:${n}:${frame}`;
  let u = urls.get(key);
  if (!u) {
    const art = cursorArt(name, frame);
    const rows = pad(art.rows);
    const c = makeCanvas(rows[0].length, rows.length);
    ascii(rows, { X: '#000000', O: '#ffffff' }, c);
    u = scaleCanvas(c, n).toDataURL('image/png');
    urls.set(key, u);
  }
  return u;
}

let imageSetOk: boolean | null = null;
function supportsImageSet(): boolean {
  if (imageSetOk === null) imageSetOk = typeof CSS !== 'undefined' && CSS.supports('cursor', 'image-set(url("a.png") 1x) 0 0, auto');
  return imageSetOk;
}

/** Current screen scale of this window. */
export function currentScreenScale(): number {
  return screenScale(window.devicePixelRatio || 1, estimatePageZoom(window.outerWidth, window.innerWidth));
}

function valueFor(name: CursorName, screen: number, frame = 0): string {
  const set = supportsImageSet();
  const { n, res } = set ? cursorScale(screen) : { n: 1, res: 1 };
  return cursorValue(cursorUrl(name, n, frame), cursorArt(name, frame).hot, n, res, CURSOR_VARS[name][1], set);
}

let host: HTMLElement | null = null;
let applied = -1;

function apply(force = false) {
  if (!host) return;
  const s = currentScreenScale();
  if (!force && s === applied) return;
  applied = s;
  for (const name of CURSOR_NAMES) host.style.setProperty(CURSOR_VARS[name][0], valueFor(name, s));
  frames.clear();
}

// ---- hourglass animation: frames swap on a timer, only while something is busy

const BUSY_SEL = '.wm-busy, .cur-busy';
const busyEls = new Set<HTMLElement>();
const frames = new Map<string, string>();
let busyTimer: ReturnType<typeof setInterval> | null = null;
let frame = 0;

function frameValue(name: CursorName, f: number): string {
  const key = `${name}:${f}`;
  let v = frames.get(key);
  if (!v) frames.set(key, (v = valueFor(name, applied, f)));
  return v;
}

function tickBusy() {
  frame = (frame + 1) % WAIT_FRAMES;
  for (const el of busyEls) {
    if (!el.isConnected || !el.matches(BUSY_SEL)) {
      for (const n of ANIMATED) el.style.removeProperty(CURSOR_VARS[n][0]);
      busyEls.delete(el);
      continue;
    }
    for (const n of ANIMATED) el.style.setProperty(CURSOR_VARS[n][0], frameValue(n, frame));
  }
  if (!busyEls.size && busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
}

/** A busy scope appeared (found through a CSS animation's animationstart: no observers, no polling while idle). */
function busyStart(el: HTMLElement) {
  busyEls.add(el);
  if (!busyTimer) {
    frame = 0;
    busyTimer = setInterval(tickBusy, 160);
  }
}

/** Sets every --cur-* variable on `root` (and the document element) and keeps them right when the screen
 *  resolution or page zoom changes. */
export function initCursors(root: HTMLElement) {
  host = document.documentElement;
  void root;
  apply(true);
  // the busy probe rules live in css/cursors.css (the CSP forbids inline <style>)
  document.addEventListener(
    'animationstart',
    (e) => {
      if (e.animationName === 'cur-busy-probe' && e.target instanceof HTMLElement) busyStart(e.target);
    },
    true,
  );
  const watch = () => {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener(
      'change',
      () => {
        apply();
        watch();
      },
      { once: true },
    );
  };
  watch();
  let t: ReturnType<typeof setTimeout> | null = null;
  addEventListener('resize', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => apply(), 100);
  });
}

/** Re-applies (e.g. after a scale change); cheap when nothing changed. */
export function refreshCursors() {
  apply();
}
