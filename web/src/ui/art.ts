// All UI art is original and generated here at startup: shapes are painted with canvas, then dithered into
// the 256-colour palette (Atkinson for icons, Bayer for gradients), alpha made binary (screen-door, never
// blended). Results are cached as PNG data URLs and exposed to CSS as custom properties.
import { ditherAtkinson, ditherBayer, nearest, PALETTE } from './palette';
import { drawText } from './pixeltext';

type Ctx = CanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): Ctx {
  return c.getContext('2d', { willReadFrequently: true })!;
}

export function scaleCanvas(src: HTMLCanvasElement, k: number): HTMLCanvasElement {
  if (k === 1) return src;
  const c = makeCanvas(src.width * k, src.height * k);
  const x = ctx2d(c);
  x.imageSmoothingEnabled = false;
  x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const urlCache = new Map<string, string>();
export function cached(key: string, make: () => HTMLCanvasElement): string {
  let u = urlCache.get(key);
  if (!u) {
    u = make().toDataURL('image/png');
    urlCache.set(key, u);
  }
  return u;
}

export function dither(c: HTMLCanvasElement, mode: 'atkinson' | 'bayer' | 'none', spread = 40) {
  const x = ctx2d(c);
  const d = x.getImageData(0, 0, c.width, c.height);
  if (mode === 'atkinson') ditherAtkinson(d.data, c.width, c.height);
  else if (mode === 'bayer') ditherBayer(d.data, c.width, c.height, spread);
  else for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i] >= 128 ? 255 : 0;
  x.putImageData(d, 0, 0);
}

/** Adds a 1px outline around opaque pixels (in a palette colour). */
function outline(c: HTMLCanvasElement, rgb: [number, number, number]) {
  const x = ctx2d(c);
  const d = x.getImageData(0, 0, c.width, c.height);
  const w = c.width;
  const h = c.height;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = d.data[i * 4 + 3] >= 128 ? 1 : 0;
  for (let y = 0; y < h; y++)
    for (let xx = 0; xx < w; xx++) {
      const i = y * w + xx;
      if (a[i]) continue;
      const n = (xx > 0 && a[i - 1]) || (xx < w - 1 && a[i + 1]) || (y > 0 && a[i - w]) || (y < h - 1 && a[i + w]);
      if (n) {
        d.data[i * 4] = rgb[0];
        d.data[i * 4 + 1] = rgb[1];
        d.data[i * 4 + 2] = rgb[2];
        d.data[i * 4 + 3] = 255;
      }
    }
  x.putImageData(d, 0, 0);
}

/** Draws ASCII pixel art. `pal` maps characters to CSS colours; '.' and ' ' are transparent. */
export function ascii(rows: string[], pal: Record<string, string>, into?: HTMLCanvasElement, ox = 0, oy = 0): HTMLCanvasElement {
  const w = Math.max(...rows.map((r) => r.length));
  const c = into ?? makeCanvas(w, rows.length);
  const x = ctx2d(c);
  rows.forEach((r, y) => {
    for (let i = 0; i < r.length; i++) {
      const col = pal[r[i]];
      if (!col) continue;
      x.fillStyle = col;
      x.fillRect(ox + i, oy + y, 1, 1);
    }
  });
  return c;
}

function lin(x: Ctx, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) {
  const g = x.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

// ------------------------------------------------------------------ icons: ui/icons98.ts (Windows 98 style)

export { iconNames, iconCanvas, icon, iconImg } from './icons98';

// ------------------------------------------------------------------ gradients & patterns

/** A vertical Bayer-dithered gradient strip (8 px wide so the pattern tiles seamlessly). */
export function vgradient(h: number, stops: [number, string][], spread = 36, w = 8): string {
  return cached(`vg:${h}:${w}:${spread}:${JSON.stringify(stops)}`, () => {
    const c = makeCanvas(w, h);
    const x = ctx2d(c);
    x.fillStyle = lin(x, 0, 0, 0, h, stops);
    x.fillRect(0, 0, w, h);
    dither(c, 'bayer', spread);
    return c;
  });
}

export function hgradient(w: number, h: number, stops: [number, string][], spread = 36): string {
  return cached(`hg:${w}:${h}:${spread}:${JSON.stringify(stops)}`, () => {
    const c = makeCanvas(w, h);
    const x = ctx2d(c);
    x.fillStyle = lin(x, 0, 0, w, 0, stops);
    x.fillRect(0, 0, w, h);
    dither(c, 'bayer', spread);
    return c;
  });
}

/** 2×2 checkerboard of a colour and transparency: the screen-door "50 % transparent". */
export function checker(color: string, k = 1): string {
  return cached(`chk:${color}:${k}`, () => {
    const c = makeCanvas(2 * k, 2 * k);
    const x = ctx2d(c);
    x.fillStyle = color;
    x.fillRect(0, 0, k, k);
    x.fillRect(k, k, k, k);
    return c;
  });
}

/** 8×8 Bayer screen-door mask at a level 0..64 (opaque pixels = visible), drawn at k device px per pixel. */
export function bayerMask(level: number, k = 1): string {
  return cached(`bm:${level}:${k}`, () => {
    const c = makeCanvas(8 * k, 8 * k);
    const x = ctx2d(c);
    x.fillStyle = '#000';
    const B = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
    for (let y = 0; y < 8; y++) for (let xx = 0; xx < 8; xx++) if (B[y * 8 + xx] < level) x.fillRect(xx * k, y * k, k, k);
    return c;
  });
}

/** Desktop wallpaper tiles (original pattern). */
export function tilePattern(): string {
  return cached('tiles', () => {
    const c = makeCanvas(32, 32);
    const x = ctx2d(c);
    x.fillStyle = '#3a6fc4';
    x.fillRect(0, 0, 32, 32);
    x.fillStyle = '#5c8fd6';
    x.fillRect(0, 0, 16, 16);
    x.fillRect(16, 16, 16, 16);
    x.fillStyle = '#87b5f0';
    x.fillRect(6, 6, 4, 4);
    x.fillRect(22, 22, 4, 4);
    x.fillStyle = '#295bb1';
    x.fillRect(22, 6, 4, 4);
    x.fillRect(6, 22, 4, 4);
    return c;
  });
}

/** Y2K page background tile (stars on navy). */
export function y2kTile(): string {
  return cached('y2k', () => {
    const c = makeCanvas(48, 48);
    const x = ctx2d(c);
    x.fillStyle = '#000033';
    x.fillRect(0, 0, 48, 48);
    const stars = [[5, 7], [30, 4], [18, 20], [41, 26], [9, 37], [27, 41], [44, 44]];
    stars.forEach(([a, b], i) => {
      x.fillStyle = i % 3 ? '#ffffff' : '#ffff66';
      x.fillRect(a, b, 1, 1);
      if (i % 2 === 0) {
        x.fillRect(a - 1, b, 3, 1);
        x.fillRect(a, b - 1, 1, 3);
      }
    });
    return c;
  });
}

// ------------------------------------------------------------------ Windows 98 control sprites
// Redrawn from the documented 98 metrics (docs/WIN98_METRICS.md): 1-bit pixels in the 98 system colours.

const C98 = { face: '#c0c0c0', hi: '#ffffff', light: '#dfdfdf', shadow: '#808080', dark: '#000000', navy: '#000080' };

/** Small glyphs (menu check/bullet/arrow, combo and scroll arrows, spin arrows) as pixel rows. */
const GLYPH98: Record<string, string[]> = {
  check: ['......#', '.....##', '#...###', '##.###.', '#####..', '.###...', '..#....'],
  radio: ['.##.', '####', '####', '.##.'],
  bullet: ['.###.', '#####', '#####', '#####', '.###.'],
  'arrow-r': ['#...', '##..', '###.', '####', '###.', '##..', '#...'],
  'arrow-l': ['...#', '..##', '.###', '####', '.###', '..##', '...#'],
  'arrow-d': ['#######', '.#####.', '..###..', '...#...'],
  'arrow-u': ['...#...', '..###..', '.#####.', '#######'],
  'spin-u': ['..#..', '.###.', '#####'],
  'spin-d': ['#####', '.###.', '..#..'],
};

export type Glyph98 = keyof typeof GLYPH98;

/** A glyph in a colour; `emboss` draws the 98 disabled look (white copy 1 px down-right, grey on top). */
export function glyph98(kind: Glyph98 | string, color = '#000000', emboss = false): string {
  return cached(`g98:${kind}:${color}:${emboss}`, () => {
    const rows = GLYPH98[kind] ?? GLYPH98.check;
    const w = Math.max(...rows.map((r) => r.length));
    const c = makeCanvas(w + (emboss ? 1 : 0), rows.length + (emboss ? 1 : 0));
    if (emboss) ascii(rows, { '#': C98.hi }, c, 1, 1);
    ascii(rows, { '#': emboss ? C98.shadow : color }, c);
    return c;
  });
}

/** Draws the two-ring 98 bevel into a canvas. kind: raised (push button), frame (window, scroll button,
 *  thumb), sunken (field, checkbox), pressed (flat 1 px shadow, the pressed scroll/combo button). */
function bevel(c: HTMLCanvasElement, kind: 'raised' | 'frame' | 'sunken' | 'pressed', x0 = 0, y0 = 0, w = c.width, h = c.height) {
  const x = ctx2d(c);
  const ring = (i: number, tl: string, br: string) => {
    x.fillStyle = tl;
    x.fillRect(x0 + i, y0 + i, w - i * 2 - 1, 1);
    x.fillRect(x0 + i, y0 + i, 1, h - i * 2 - 1);
    x.fillStyle = br;
    x.fillRect(x0 + i, y0 + h - 1 - i, w - i * 2, 1);
    x.fillRect(x0 + w - 1 - i, y0 + i, 1, h - i * 2);
  };
  if (kind === 'raised') {
    ring(0, C98.hi, C98.dark);
    ring(1, C98.light, C98.shadow);
  } else if (kind === 'frame') {
    ring(0, C98.light, C98.dark);
    ring(1, C98.hi, C98.shadow);
  } else if (kind === 'sunken') {
    ring(0, C98.shadow, C98.hi);
    ring(1, C98.dark, C98.light);
  } else {
    ring(0, C98.shadow, C98.shadow);
  }
}

/** 98 checkbox: 13×13 sunken white box with a 7×7 black check. d = disabled, p = pressed (grey inside). */
export function checkboxSprite(checked: boolean, state: 'n' | 'h' | 'd' | 'p' = 'n'): string {
  return cached(`cb98:${checked}:${state}`, () => {
    const c = makeCanvas(13, 13);
    const x = ctx2d(c);
    x.fillStyle = state === 'd' || state === 'p' ? C98.face : C98.hi;
    x.fillRect(2, 2, 9, 9);
    bevel(c, 'sunken');
    if (checked) ascii(GLYPH98.check, { '#': state === 'd' ? C98.shadow : C98.dark }, c, 3, 3);
    return c;
  });
}

const RADIO_OUT = ['....XXXX....', '..XX....XX..', '.X........X.', '.X........X.', 'X..........X', 'X..........X', 'X..........X', 'X..........X', '.X........X.', '.X........X.', '..XX....XX..', '....XXXX....'];
const RADIO_IN = ['', '....XXXX....', '..XX....XX..', '..X......X..', '.X........X.', '.X........X.', '.X........X.', '.X........X.', '..X......X..', '..XX....XX..', '....XXXX....'];

/** 98 radio button: a 12×12 pixel-stepped sunken circle with a 4×4 dot. */
export function radioSprite(checked: boolean, state: 'n' | 'h' | 'd' | 'p' = 'n'): string {
  return cached(`rb98:${checked}:${state}`, () => {
    const c = makeCanvas(12, 12);
    const x = ctx2d(c);
    const fill = state === 'd' || state === 'p' ? C98.face : C98.hi;
    // the inside of the inner ring (the ring itself is painted over it below)
    for (let y = 1; y <= 10; y++) {
      const r = RADIO_IN[y];
      const a = r.indexOf('X');
      const b = r.lastIndexOf('X');
      x.fillStyle = fill;
      x.fillRect(a + 1, y, b - a - 1, 1);
    }
    const paint = (rows: string[], tl: string, br: string) => {
      rows.forEach((r, y) => {
        for (let i = 0; i < r.length; i++) {
          if (r[i] !== 'X') continue;
          x.fillStyle = i + y < 11 ? tl : br;
          x.fillRect(i, y, 1, 1);
        }
      });
    };
    paint(RADIO_OUT, C98.shadow, C98.hi);
    paint(RADIO_IN, C98.dark, C98.light);
    if (checked) ascii(GLYPH98.radio, { '#': state === 'd' ? C98.shadow : C98.dark }, c, 4, 4);
    return c;
  });
}

/** Back-compat: a small arrow glyph (used by older CSS as --img-arrow-down). */
export function arrowGlyph(dir: 'up' | 'down' | 'left' | 'right', color = '#000000'): string {
  return glyph98(dir === 'up' ? 'arrow-u' : dir === 'down' ? 'arrow-d' : dir === 'left' ? 'arrow-l' : 'arrow-r', color);
}

/** 98 trackbar thumb: an 11×21 raised tab pointing down (toward the tick marks). */
export function sliderThumb(state: 'n' | 'h' | 'd' = 'n'): string {
  return cached(`thumb98:${state}`, () => {
    const rows = [
      'WWWWWWWWWWK',
      'WLLLLLLLLGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      'WLFFFFFFFGK',
      '.WLFFFFFGK.',
      '..WLFFFGK..',
      '...WLFGK...',
      '....WGK....',
      '.....K.....',
    ];
    void state;
    return ascii(rows, { W: C98.hi, L: C98.light, F: C98.face, G: C98.shadow, K: C98.dark });
  });
}

/** One progress-bar block: 8 px of navy and a 2 px gap. */
export function progressBlock(): string {
  return cached('pblock98', () => {
    const c = makeCanvas(10, 14);
    const x = ctx2d(c);
    x.fillStyle = C98.navy;
    x.fillRect(0, 0, 8, 14);
    return c;
  });
}

/** A 2×2 two-colour checker (opaque): the 98 scrollbar track is #C0C0C0 and #FFFFFF dithered. */
export function checker2(a: string, b: string): string {
  return cached(`chk2:${a}:${b}`, () => {
    const c = makeCanvas(2, 2);
    const x = ctx2d(c);
    x.fillStyle = a;
    x.fillRect(0, 0, 2, 2);
    x.fillStyle = b;
    x.fillRect(0, 0, 1, 1);
    x.fillRect(1, 1, 1, 1);
    return c;
  });
}

/** A 98 bevelled button sprite with a centred glyph: scroll-bar arrows (16×16), the combo-box button
 *  (16×17), spin buttons. Pressed: flat 1 px shadow, glyph 1 px down-right. Disabled: embossed glyph. */
export function bevelButton(w: number, h: number, glyph: Glyph98 | string, state: 'n' | 'p' | 'd' = 'n', kind: 'frame' | 'raised' = 'frame'): string {
  return cached(`bb98:${w}:${h}:${glyph}:${state}:${kind}`, () => {
    const c = makeCanvas(w, h);
    const x = ctx2d(c);
    x.fillStyle = C98.face;
    x.fillRect(0, 0, w, h);
    bevel(c, state === 'p' ? 'pressed' : kind);
    const rows = GLYPH98[glyph] ?? [];
    const gw = Math.max(...rows.map((r) => r.length));
    const gh = rows.length;
    const ox = Math.floor((w - gw) / 2) + (state === 'p' ? 1 : 0);
    const oy = Math.floor((h - gh) / 2) + (state === 'p' ? 1 : 0);
    if (state === 'd') ascii(rows, { '#': C98.hi }, c, ox + 1, oy + 1);
    ascii(rows, { '#': state === 'd' ? C98.shadow : C98.dark }, c, ox, oy);
    return c;
  });
}

/** The scroll-bar thumb and other plain raised frames (used where box-shadow bevels can't be drawn). */
export function frameSprite(w: number, h: number): string {
  return cached(`fr98:${w}:${h}`, () => {
    const c = makeCanvas(w, h);
    const x = ctx2d(c);
    x.fillStyle = C98.face;
    x.fillRect(0, 0, w, h);
    bevel(c, 'frame');
    return c;
  });
}

/** Every 98 control sprite as CSS custom properties (applied on the app root by theme.ts). */
export function controlArtVars(): Record<string, string> {
  const u = (s: string) => `url("${s}")`;
  const v: Record<string, string> = {};
  for (const on of [false, true]) {
    const k = on ? '-on' : '';
    v[`--img-cb${k}`] = u(checkboxSprite(on));
    v[`--img-cb${k}-h`] = u(checkboxSprite(on, 'h'));
    v[`--img-cb${k}-d`] = u(checkboxSprite(on, 'd'));
    v[`--img-cb${k}-p`] = u(checkboxSprite(on, 'p'));
    v[`--img-rb${k}`] = u(radioSprite(on));
    v[`--img-rb${k}-h`] = u(radioSprite(on, 'h'));
    v[`--img-rb${k}-d`] = u(radioSprite(on, 'd'));
    v[`--img-rb${k}-p`] = u(radioSprite(on, 'p'));
  }
  v['--img-arrow-down'] = u(arrowGlyph('down'));
  v['--img-thumb'] = u(sliderThumb());
  v['--img-thumb-h'] = u(sliderThumb('h'));
  v['--img-pblock'] = u(progressBlock());
  v['--img-sb-track'] = u(checker2(C98.face, C98.hi));
  for (const [dir, g] of [['up', 'arrow-u'], ['down', 'arrow-d'], ['left', 'arrow-l'], ['right', 'arrow-r']] as const) {
    v[`--img-sb-${dir}`] = u(bevelButton(16, 16, g));
    v[`--img-sb-${dir}-p`] = u(bevelButton(16, 16, g, 'p'));
    v[`--img-sb-${dir}-d`] = u(bevelButton(16, 16, g, 'd'));
  }
  for (const g of Object.keys(GLYPH98)) {
    v[`--img-g-${g}`] = u(glyph98(g));
    v[`--img-g-${g}-w`] = u(glyph98(g, C98.hi));
    v[`--img-g-${g}-d`] = u(glyph98(g, C98.shadow, true));
    v[`--img-g-${g}-g`] = u(glyph98(g, C98.shadow));
  }
  return v;
}

// ------------------------------------------------------------------ message-box icons (redrawn, 32×32)

/** Our own 98-style message-box icons: error (red disc with a white ×), warning (yellow triangle with !),
 *  info (speech balloon with i), question (speech balloon with ?). Hard 1-bit edges, black outline. */
export function msgIcon(kind: 'error' | 'warning' | 'info' | 'question'): string {
  return cached(`msg98:${kind}`, () => {
    const c = makeCanvas(32, 32);
    const x = ctx2d(c);
    if (kind === 'error') {
      x.fillStyle = '#ff0000';
      x.beginPath();
      x.arc(15.5, 15.5, 13.5, 0, Math.PI * 2);
      x.fill();
      dither(c, 'none');
      outline(c, [0, 0, 0]);
      x.fillStyle = '#ffffff';
      // a chunky white ×
      for (let i = 0; i < 12; i++) {
        x.fillRect(9 + i, 9 + i, 3, 2);
        x.fillRect(20 - i, 9 + i, 3, 2);
      }
    } else if (kind === 'warning') {
      x.fillStyle = '#ffff00';
      x.beginPath();
      x.moveTo(15.5, 2);
      x.lineTo(29.5, 28);
      x.lineTo(1.5, 28);
      x.closePath();
      x.fill();
      dither(c, 'none');
      outline(c, [0, 0, 0]);
      x.fillStyle = '#000000';
      x.fillRect(14, 10, 4, 10);
      x.fillRect(14, 22, 4, 3);
      // shadow under the triangle (dark grey, a 98 trait)
      x.fillStyle = '#808080';
      x.fillRect(4, 30, 27, 1);
    } else {
      // speech balloon
      x.fillStyle = '#ffffff';
      x.beginPath();
      x.ellipse(15.5, 13, 13.5, 11, 0, 0, Math.PI * 2);
      x.fill();
      x.beginPath();
      x.moveTo(8, 20);
      x.lineTo(6, 29);
      x.lineTo(15, 22);
      x.closePath();
      x.fill();
      dither(c, 'none');
      outline(c, [0, 0, 0]);
      if (kind === 'info') {
        x.fillStyle = '#0000ff';
        x.fillRect(14, 5, 4, 3);
        x.fillRect(12, 10, 6, 2);
        x.fillRect(14, 12, 4, 7);
        x.fillRect(12, 19, 8, 2);
      } else {
        drawText(x, '?', 11, 1, '#0000ff', { bold: true, scale: 2 });
      }
    }
    return c;
  });
}

// Cursors: ui/cursors.ts (1-bit pixel art, drawn 1:1 in device pixels).

/** Palette colour for a 0..1 heat value (coefficient heatmap overlay legend). */
export function heatColor(t: number): [number, number, number] {
  const stops = [
    [0, 0, 0, 128],
    [0.2, 0, 80, 255],
    [0.4, 0, 192, 192],
    [0.6, 64, 208, 64],
    [0.8, 240, 224, 32],
    [1, 220, 20, 0],
  ];
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const f = (t - a[0]) / (b[0] - a[0]);
      const k = nearest(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f) * 3;
      return [PALETTE[k], PALETTE[k + 1], PALETTE[k + 2]];
    }
  }
  return [220, 20, 0];
}

/** Atkinson-dithered thumbnail of RGBA pixels, scaled to fit `size` (box filter). */
export function ditheredThumb(rgba: Uint8ClampedArray, w: number, h: number, size: number): HTMLCanvasElement {
  const s = Math.min(size / w, size / h, 1);
  const tw = Math.max(1, Math.round(w * s));
  const th = Math.max(1, Math.round(h * s));
  const src = makeCanvas(w, h);
  ctx2d(src).putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const c = makeCanvas(tw, th);
  const x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, tw, th);
  dither(c, 'atkinson');
  return c;
}
