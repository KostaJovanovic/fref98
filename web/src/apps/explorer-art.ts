// Our own art for the 98 Explorer toolbar (20×20 "Standard Buttons": Back, Forward, Up, Cut, Copy, Paste,
// Undo, Delete, Properties, Views) and the media player's transport glyphs. As in IE4/98, a toolbar icon is
// grey ("cold") until the pointer is over it, then in colour ("hot"); disabled ones are embossed.
import { ascii, cached, makeCanvas, iconCanvas } from '../ui/art';

const PAL: Record<string, string> = {
  K: '#000000',
  W: '#ffffff',
  S: '#c0c0c0',
  L: '#dfdfdf',
  G: '#808080',
  V: '#000080',
  B: '#0000ff',
  R: '#ff0000',
  M: '#800000',
  N: '#008000',
  E: '#00ff00',
  Y: '#ffff00',
  A: '#f0d878',
  a: '#fff8c0',
  c: '#b89840',
  O: '#804000',
  T: '#008080',
  C: '#00ffff',
};

type Ctx = CanvasRenderingContext2D;
const SZ = 20;

function fill(x: Ctx, col: string, X: number, Y: number, w = 1, h = 1) {
  x.fillStyle = PAL[col] ?? col;
  x.fillRect(X, Y, w, h);
}

/** A white page with a black outline and rows of "text". */
function page(x: Ctx, X: number, Y: number, w: number, h: number, ink = 'G') {
  fill(x, 'K', X, Y, w, h);
  fill(x, 'W', X + 1, Y + 1, w - 2, h - 2);
  for (let r = Y + 3; r < Y + h - 2; r += 2) fill(x, ink, X + 2, r, w - 4 - ((r >> 1) % 2), 1);
}

const BACK = [
  '....................',
  '....................',
  '....................',
  '....................',
  '........K...........',
  '.......KK...........',
  '......KEK...........',
  '.....KEEKKKKKKKKK...',
  '....KEEEEEEEEEEEK...',
  '...KEEENNNNNNNNNK...',
  '....KNNNNNNNNNNNK...',
  '.....KNNKKKKKKKKK...',
  '......KNK...........',
  '.......KK...........',
  '........K...........',
];

const CUT = [
  '....................',
  '....................',
  '.....K.......K......',
  '.....KK.....KK......',
  '.....GK.....KG......',
  '......KK...KK.......',
  '......GK...KG.......',
  '.......KK.KK........',
  '.......GKKKG........',
  '........KKK.........',
  '.........K..........',
  '........KVK.........',
  '......VVV.VVV.......',
  '.....V...V...V......',
  '....V....V....V.....',
  '....V....VV...V.....',
  '....V...V..V..V.....',
  '.....V.V....V.V.....',
  '......V......V......',
];

const PAINTERS: Record<string, (x: Ctx, c: HTMLCanvasElement) => void> = {
  back: (_x, c) => ascii(BACK, PAL, c, 0, 1),
  forward: (_x, c) => ascii(BACK.map((r) => [...r].reverse().join('')), PAL, c, 0, 1),
  up: (x, c) => {
    // a folder, and an arrow coming up out of it
    fill(x, 'K', 2, 5, 6, 1);
    fill(x, 'K', 1, 6, 1, 1);
    fill(x, 'A', 2, 6, 6, 1);
    fill(x, 'K', 8, 6, 1, 1);
    fill(x, 'K', 1, 7, 18, 11);
    fill(x, 'A', 2, 8, 16, 9);
    fill(x, 'a', 2, 8, 16, 1);
    fill(x, 'a', 2, 8, 1, 9);
    fill(x, 'c', 3, 16, 15, 1);
    fill(x, 'c', 17, 9, 1, 8);
    const cx = 12;
    for (let r = 0; r <= 5; r++) {
      fill(x, 'K', cx - r, 1 + r, 2 * r + 1, 1);
      if (r > 0) fill(x, r < 3 ? 'E' : 'N', cx - r + 1, 1 + r, 2 * r - 1, 1);
    }
    fill(x, 'K', cx - 6, 7, 13, 1);
    fill(x, 'K', cx - 2, 7, 5, 7);
    fill(x, 'N', cx - 1, 7, 3, 6);
    fill(x, 'E', cx - 1, 7, 1, 6);
    void c;
  },
  cut: (_x, c) => ascii(CUT, PAL, c),
  copy: (x) => {
    page(x, 2, 1, 10, 12, 'V');
    page(x, 8, 6, 10, 13, 'V');
  },
  paste: (x) => {
    fill(x, 'K', 2, 3, 12, 15);
    fill(x, 'O', 3, 4, 10, 13);
    fill(x, 'K', 5, 1, 6, 4);
    fill(x, 'S', 6, 2, 4, 2);
    fill(x, 'W', 6, 2, 4, 1);
    page(x, 8, 7, 11, 12, 'V');
  },
  undo: (x) => {
    x.imageSmoothingEnabled = false;
    x.drawImage(iconCanvas('undo', 16), 2, 2);
  },
  delete: (x, c) => {
    for (let i = 0; i < 12; i++) {
      fill(x, 'R', 4 + i, 4 + i, 3, 1);
      fill(x, 'R', 13 - i, 4 + i, 3, 1);
    }
    outline(c, PAL.M);
  },
  properties: (x) => {
    fill(x, 'K', 2, 2, 16, 15);
    fill(x, 'S', 3, 3, 14, 13);
    fill(x, 'V', 3, 3, 14, 3);
    fill(x, 'W', 4, 4, 2, 1);
    fill(x, 'W', 3, 6, 14, 1);
    for (let r = 8; r <= 13; r += 2) {
      fill(x, 'W', 5, r, 2, 1);
      fill(x, 'K', 8, r, 7, 1);
    }
    fill(x, 'K', 5, 8, 2, 1);
    fill(x, 'K', 5, 12, 2, 1);
    fill(x, 'G', 3, 15, 14, 1);
  },
  views: (x) => {
    for (const [X, Y] of [
      [2, 2],
      [11, 2],
      [2, 11],
      [11, 11],
    ]) {
      fill(x, 'K', X, Y, 7, 5);
      fill(x, 'B', X + 1, Y + 1, 5, 3);
      fill(x, 'C', X + 1, Y + 1, 2, 1);
      fill(x, 'G', X, Y + 6, 7, 1);
    }
  },
};

/** Adds a 1 px outline in `col` around every opaque shape. */
function outline(c: HTMLCanvasElement, col: string) {
  const x = c.getContext('2d', { willReadFrequently: true })!;
  const d = x.getImageData(0, 0, c.width, c.height);
  const a = (i: number) => d.data[i * 4 + 3] > 0;
  const add: number[] = [];
  for (let y = 0; y < c.height; y++)
    for (let xx = 0; xx < c.width; xx++) {
      const i = y * c.width + xx;
      if (a(i)) continue;
      if ((xx > 0 && a(i - 1)) || (xx < c.width - 1 && a(i + 1)) || (y > 0 && a(i - c.width)) || (y < c.height - 1 && a(i + c.width))) add.push(xx, y);
    }
  x.fillStyle = col;
  for (let k = 0; k < add.length; k += 2) x.fillRect(add[k], add[k + 1], 1, 1);
}

function paint(name: string): HTMLCanvasElement {
  const c = makeCanvas(SZ, SZ);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  PAINTERS[name]?.(x, c);
  return c;
}

/** Each pixel to the nearest of the four 98 greys by luminance (the "cold" toolbar look). */
function greyed(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    if (!d.data[i + 3]) continue;
    const l = 0.3 * d.data[i] + 0.59 * d.data[i + 1] + 0.11 * d.data[i + 2];
    const v = l < 64 ? 0 : l < 150 ? 128 : l < 224 ? 192 : 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 255;
  }
  x.putImageData(d, 0, 0);
  return c;
}

/** 98's disabled look: dark pixels of the image become #808080 with a white copy 1 px down-right. Same size
 *  as the image (it is shown 1:1 in a 20×20 slot; a white pixel past the edge is dropped). */
function embossed(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  const s = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height);
  const dark: number[] = [];
  for (let y = 0; y < src.height; y++)
    for (let xx = 0; xx < src.width; xx++) {
      const i = (y * src.width + xx) * 4;
      if (!s.data[i + 3]) continue;
      const l = 0.3 * s.data[i] + 0.59 * s.data[i + 1] + 0.11 * s.data[i + 2];
      if (l < 200) dark.push(xx, y);
    }
  x.fillStyle = '#ffffff';
  for (let k = 0; k < dark.length; k += 2) x.fillRect(dark[k] + 1, dark[k + 1] + 1, 1, 1);
  x.fillStyle = '#808080';
  for (let k = 0; k < dark.length; k += 2) x.fillRect(dark[k], dark[k + 1], 1, 1);
  return c;
}

export type ToolIcon = 'back' | 'forward' | 'up' | 'cut' | 'copy' | 'paste' | 'undo' | 'delete' | 'properties' | 'views';

/** The three looks of a 20×20 Standard Buttons icon, as image URLs. */
export function toolIcon(name: ToolIcon): { hot: string; cold: string; dis: string } {
  return {
    hot: cached(`xtb:${name}:hot`, () => paint(name)),
    cold: cached(`xtb:${name}:cold`, () => greyed(paint(name))),
    dis: cached(`xtb:${name}:dis`, () => embossed(paint(name))),
  };
}

// ------------------------------------------------------------------ media player transport glyphs

const MEDIA: Record<string, string[]> = {
  play: ['#....', '##...', '###..', '####.', '#####', '####.', '###..', '##...', '#....'],
  pause: ['##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##'],
  stop: ['#######', '#######', '#######', '#######', '#######', '#######', '#######'],
  prev: ['##....#...#', '##...##..##', '##..###.###', '##.########', '##..###.###', '##...##..##', '##....#...#'],
  next: ['#...#....##', '##..##...##', '###.###..##', '########.##', '###.###..##', '##..##...##', '#...#....##'],
  stepb: ['##...#', '##..##', '##.###', '######', '##.###', '##..##', '##...#'],
  stepf: ['#...##', '##..##', '###.##', '######', '###.##', '##..##', '#...##'],
  record: ['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..'],
  eject: ['....#....', '...###...', '..#####..', '.#######.', '#########', '.........', '#########', '#########'],
};

export type MediaGlyph = keyof typeof MEDIA;

/** A transport glyph in black (record: red), or embossed grey when disabled. */
export function mediaGlyph(kind: MediaGlyph, disabled = false): string {
  return cached(`mg:${kind}:${disabled}`, () => {
    const rows = MEDIA[kind];
    const w = Math.max(...rows.map((r) => r.length));
    const c = makeCanvas(w + 1, rows.length + 1);
    if (disabled) {
      ascii(rows, { '#': '#ffffff' }, c, 1, 1);
      ascii(rows, { '#': '#808080' }, c);
    } else ascii(rows, { '#': kind === 'record' ? '#ff0000' : '#000000' }, c);
    return c;
  });
}
