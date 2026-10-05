// Desktop, menu and toolbar icons in the Windows 98 manner, drawn by us: flat fills from the 16-colour VGA
// palette plus a few 98-era extras (manila, brown, light grey), light from the top left, a 1 px black
// silhouette outline, and 2×2 checker dithering for in-between tones. Painters draw in a 32×32 space; each
// size is rendered 4× supersampled, every subsample snapped to the icon palette, then each pixel takes the
// most common subsample colour, so there are never blended edge colours. Small (16 px) icons that matter
// most are hand-drawn pixel rows instead (SMALL).
import { drawText } from './pixeltext';
import { cachedUrl, makeCanvas } from './canvas';
import { COLORS98 } from './palette';

type Ctx = CanvasRenderingContext2D;

const { black: K, white: W, silver: S, light: LG, gray: G, darkGray: D, red: R, maroon: M, yellow: Y, olive: O, lime: LI, green: N, cyan: C, teal: T, blue: B, navy: V, purple: P, magenta: F } = COLORS98;
// 98-era extras
const { manilaLight: MA, manila: MB, manilaShade: MC, brown: BR, orange: OR, tan: TN } = COLORS98;

/** The icon colours: all of them are in palette.ts's PALETTE, so only one palette is in play. */
export const PAL = [K, W, S, LG, G, D, R, M, Y, O, LI, N, C, T, B, V, P, F, MA, MB, MC, BR, OR, TN];
const PAL_RGB = PAL.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
const LUMA = PAL_RGB.map(([r, g, b]) => r * 3 + g * 6 + b);

const nearCache = new Map<number, number>();
function nearestIcon(r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b;
  let i = nearCache.get(key);
  if (i === undefined) {
    let bd = Infinity;
    i = 0;
    for (let j = 0; j < PAL_RGB.length; j++) {
      const [pr, pg, pb] = PAL_RGB[j];
      const d = (r - pr) ** 2 * 3 + (g - pg) ** 2 * 4 + (b - pb) ** 2 * 2;
      if (d < bd) {
        bd = d;
        i = j;
      }
    }
    nearCache.set(key, i);
  }
  return i;
}

const canvas = makeCanvas;

const SS = 4; // supersampling

/** Drawing helpers in the 32×32 icon space (integer coordinates are pixel corners). */
class Pen {
  constructor(public x: Ctx, private sc: number) {}
  private style(c: string): string | CanvasPattern {
    if (!c.includes('|')) return c;
    const [a, b] = c.split('|');
    const t = canvas(SS * 2, SS * 2);
    const tx = t.getContext('2d')!;
    tx.fillStyle = a;
    tx.fillRect(0, 0, SS * 2, SS * 2);
    tx.fillStyle = b;
    tx.fillRect(0, 0, SS, SS);
    tx.fillRect(SS, SS, SS, SS);
    const p = this.x.createPattern(t, 'repeat')!;
    // pattern cells are output pixels, whatever the painter's scale
    p.setTransform(new DOMMatrix().scale(1 / this.sc));
    return p;
  }
  rect(x: number, y: number, w: number, h: number, c: string) {
    this.x.fillStyle = this.style(c);
    this.x.fillRect(x, y, w, h);
  }
  px(x: number, y: number, c: string) {
    this.rect(x, y, 1, 1, c);
  }
  poly(c: string, ...p: number[]) {
    this.x.fillStyle = this.style(c);
    this.x.beginPath();
    this.x.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) this.x.lineTo(p[i], p[i + 1]);
    this.x.closePath();
    this.x.fill();
  }
  ell(cx: number, cy: number, rx: number, ry: number, c: string) {
    this.x.fillStyle = this.style(c);
    this.x.beginPath();
    this.x.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    this.x.fill();
  }
  /** A line through pixel centres, w px thick. */
  line(x0: number, y0: number, x1: number, y1: number, c: string, w = 1) {
    this.x.strokeStyle = this.style(c);
    this.x.lineWidth = w;
    this.x.lineCap = 'square';
    this.x.beginPath();
    this.x.moveTo(x0 + 0.5, y0 + 0.5);
    this.x.lineTo(x1 + 0.5, y1 + 0.5);
    this.x.stroke();
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, c: string, w: number) {
    this.x.strokeStyle = this.style(c);
    this.x.lineWidth = w;
    this.x.lineCap = 'butt';
    this.x.beginPath();
    this.x.arc(cx, cy, r, a0, a1);
    this.x.stroke();
  }
  /** Runs `f` clipped to a polygon. */
  clip(p: number[], f: () => void) {
    this.x.save();
    this.x.beginPath();
    this.x.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) this.x.lineTo(p[i], p[i + 1]);
    this.x.closePath();
    this.x.clip();
    f();
    this.x.restore();
  }
  text(s: string, x: number, y: number, c: string, scale = 1, bold = true) {
    drawText(this.x, s, x, y, c, { bold, scale });
  }
}

type Painter = (p: Pen) => void;

// ---- shared parts

/** The 98 manila folder: tab top left, back sheet, front panel with a light top-left edge. */
function folder(p: Pen, front = true, light = MA, body = MB, shade = MC) {
  p.poly(body, 2, 8, 4, 5, 12, 5, 14, 8);
  p.line(4, 6, 11, 6, light);
  p.rect(2, 8, 28, 4, shade);
  if (front) folderFront(p, 11, light, body, shade);
}

function folderFront(p: Pen, y: number, light = MA, body = MB, shade = MC) {
  p.rect(2, y, 28, 27 - y, body);
  p.line(2, y, 29, y, light);
  p.line(2, y, 2, 26, light);
  p.line(3, 26, 29, 26, shade);
  p.line(29, y + 1, 29, 26, shade);
}

/** A small landscape picture with a white frame. */
function picture(p: Pen, x: number, y: number, w: number, h: number) {
  p.rect(x, y, w, h, W);
  p.rect(x + 1, y + 1, w - 2, h - 2, C);
  p.rect(x + 1, y + 1, w - 2, Math.ceil((h - 2) / 3), B + '|' + C);
  p.poly(N, x + 1, y + h - 1, x + 1, y + h * 0.62, x + w * 0.4, y + h * 0.42, x + w - 1, y + h * 0.7, x + w - 1, y + h - 1);
  p.ell(x + w * 0.72, y + h * 0.32, Math.max(1, w * 0.09), Math.max(1, w * 0.09), Y);
  p.line(x, y + h - 1, x + w - 1, y + h - 1, G);
  p.line(x + w - 1, y, x + w - 1, y + h - 1, G);
}

/** A white page with a folded top-right corner. */
function page(p: Pen, x: number, y: number, w: number, h: number) {
  const f = 6;
  p.poly(W, x, y, x + w - f, y, x + w, y + f, x + w, y + h, x, y + h);
  p.poly(S, x + w - f, y, x + w - f, y + f, x + w, y + f);
  p.line(x + w - f, y, x + w - f, y + f - 1, K);
  p.line(x + w - f, y + f, x + w - 1, y + f, K);
}

/** A beige/grey 98 computer monitor with a teal desktop. */
function monitor(p: Pen, x = 2, y = 2, w = 28, h = 21) {
  p.rect(x, y, w, h, S);
  p.line(x, y, x + w - 1, y, W);
  p.line(x, y, x, y + h - 1, W);
  p.line(x + w - 1, y, x + w - 1, y + h - 1, G);
  p.line(x, y + h - 1, x + w - 1, y + h - 1, G);
  p.rect(x + 3, y + 3, w - 6, h - 7, K);
  p.rect(x + 4, y + 4, w - 8, h - 9, T);
  p.px(x + w - 5, y + h - 3, LI);
  const cx = x + w / 2;
  p.rect(cx - 4, y + h, 8, 2, G);
  p.rect(cx - 8, y + h + 2, 16, 3, S);
  p.line(cx - 8, y + h + 2, cx + 7, y + h + 2, W);
}

/** Thick curved arrow (undo); redo mirrors it. */
function curvedArrow(p: Pen) {
  p.arc(17, 19, 8, Math.PI * 1.02, Math.PI * 2.3, V, 4);
  p.poly(V, 2, 17, 15, 17, 8.5, 9);
}

// ---- the icons

const ICONS: Record<string, Painter> = {
  folder: (p) => folder(p),
  pictures: (p) => {
    folder(p, false);
    picture(p, 7, 3, 18, 13);
    folderFront(p, 14);
  },
  project: (p) => {
    folder(p, false);
    page(p, 6, 2, 17, 16);
    for (let i = 0; i < 4; i++) p.line(9, 7 + i * 2, 18, 7 + i * 2, i === 0 ? B : G);
    folderFront(p, 14);
    // a red binder clip
    p.rect(13, 12, 6, 4, R);
    p.line(13, 12, 18, 12, W);
  },
  documents: (p) => {
    folder(p, false);
    page(p, 9, 2, 15, 15);
    for (let i = 0; i < 3; i++) p.line(11, 8 + i * 2, 20, 8 + i * 2, G);
    folderFront(p, 14);
  },
  programs: (p) => {
    folder(p, false);
    // a little application window on the folder
    p.rect(8, 3, 16, 11, S);
    p.rect(9, 4, 14, 2, V);
    p.rect(9, 7, 14, 6, W);
    folderFront(p, 14);
  },
  disk: (p) => {
    // 98 removable disk drive: top face, front with slot and a green light
    p.poly(LG, 2, 15, 6, 10, 30, 10, 30, 15);
    p.line(6, 10, 29, 10, W);
    p.rect(2, 15, 29, 10, S);
    p.line(2, 15, 30, 15, W);
    p.line(2, 24, 30, 24, G);
    p.rect(6, 18, 16, 2, K);
    p.line(6, 20, 21, 20, W);
    p.rect(25, 20, 3, 2, LI);
    p.line(25, 22, 27, 22, N);
  },
  card: (p) => {
    p.poly(V, 7, 2, 21, 2, 26, 7, 26, 30, 7, 30);
    p.line(8, 3, 8, 29, B);
    for (let i = 0; i < 5; i++) p.rect(9 + i * 3, 3, 2, 5, Y);
    p.rect(9, 13, 15, 12, W);
    p.line(9, 24, 23, 24, S);
    p.text('SD', 11, 13, R);
  },
  recycle: (p) => recycleBin(p),
  recyclefull: (p) => {
    recycleBin(p);
    // crumpled paper above the rim
    p.poly(W, 8, 7, 10, 2, 15, 4, 19, 1, 24, 4, 25, 7);
    p.line(12, 4, 14, 6, S);
    p.line(19, 3, 21, 6, S);
    p.poly(Y, 15, 6, 17, 3, 20, 5, 19, 7);
  },
  presets: (p) => {
    // magic wand with a star
    p.line(4, 28, 17, 15, K, 3);
    p.line(16, 16, 18, 14, W, 3);
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? 4 : 9;
      pts.push(22 + Math.cos(a) * r, 10 + Math.sin(a) * r);
    }
    p.poly(Y, ...pts);
    p.clip(pts, () => p.rect(22, 10, 10, 10, OR + '|' + Y));
    p.rect(6, 6, 2, 2, C);
    p.rect(3, 14, 2, 2, F);
    p.px(13, 3, Y);
  },
  help: (p) => {
    // a closed help book with a question mark
    p.rect(6, 3, 21, 26, V);
    p.line(7, 3, 7, 28, B);
    p.rect(26, 5, 3, 24, W);
    p.line(27, 6, 27, 28, S);
    p.line(8, 28, 28, 28, K);
    p.text('?', 11, 5, Y, 2);
  },
  about: (p) => {
    p.ell(16, 16, 13, 13, B);
    p.arc(16, 16, 11, Math.PI * 1.05, Math.PI * 1.6, C, 2);
    p.rect(14, 13, 4, 11, W);
    p.rect(12, 13, 2, 2, W);
    p.rect(12, 23, 8, 2, W);
    p.rect(14, 7, 4, 4, W);
  },
  editor: (p) => {
    // a framed photo whose lower right quarter is broken into 8×8 blocks
    p.rect(2, 4, 28, 24, BR);
    p.line(2, 4, 29, 4, TN);
    p.line(2, 4, 2, 27, TN);
    p.line(3, 27, 29, 27, K);
    p.line(29, 5, 29, 27, K);
    picture(p, 5, 7, 22, 18);
    const cols = [B, P, N, G, Y, V, F, T];
    for (let by = 0; by < 2; by++)
      for (let bx = 0; bx < 3; bx++) p.rect(15 + bx * 4, 16 + by * 4, 4, 4, cols[(bx * 3 + by * 5) % cols.length]);
  },
  hex: (p) => {
    p.rect(2, 3, 28, 26, S);
    p.line(2, 3, 29, 3, W);
    p.line(2, 3, 2, 28, W);
    p.rect(4, 5, 24, 4, V);
    p.rect(4, 11, 24, 16, K);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if ((r * 7 + c * 3) % 5 !== 0) p.rect(6 + c * 6, 13 + r * 4, 4, 2, LI);
  },
  webcam: (p) => {
    p.ell(16, 13, 11, 11, S);
    p.arc(16, 13, 9, Math.PI * 1.05, Math.PI * 1.55, W, 2);
    p.ell(16, 13, 6, 6, K);
    p.ell(14.5, 11.5, 2, 2, B);
    p.px(14, 11, W);
    p.rect(13, 24, 6, 3, G);
    p.rect(8, 27, 16, 3, S);
  },
  export: (p) => floppy(p),
  display: (p) => monitor(p),
  computer: (p) => {
    monitor(p, 4, 1, 24, 18);
    // the system box under the monitor
    p.rect(2, 24, 28, 6, S);
    p.line(2, 24, 29, 24, W);
    p.rect(18, 26, 8, 1, K);
    p.px(5, 26, LI);
  },
  settings: (p) => {
    // control panel: a folder with a screwdriver-and-gauge card
    folder(p, false);
    p.rect(7, 3, 18, 12, W);
    p.ell(16, 10, 5, 5, S);
    p.line(16, 10, 19, 7, R);
    folderFront(p, 14);
  },
  find: (p) => {
    page(p, 3, 2, 18, 24);
    for (let i = 0; i < 5; i++) p.line(6, 10 + i * 3, 16, 10 + i * 3, G);
    p.line(21, 21, 28, 28, BR, 3);
    p.ell(17, 16, 6, 6, K);
    p.ell(17, 16, 4.5, 4.5, C);
    p.arc(17, 16, 3, Math.PI * 1.1, Math.PI * 1.5, W, 1.5);
  },
  run: (p) => {
    // a window with a running arrow
    p.rect(2, 5, 28, 22, S);
    p.line(2, 5, 29, 5, W);
    p.line(2, 5, 2, 26, W);
    p.rect(4, 7, 24, 4, V);
    p.rect(4, 13, 24, 12, W);
    p.line(8, 19, 21, 19, N, 3);
    p.poly(N, 19, 14, 26, 19.5, 19, 25);
  },
  jpeg: (p) => {
    page(p, 6, 2, 21, 28);
    picture(p, 9, 11, 15, 12);
  },
  video: (p) => {
    p.rect(3, 5, 26, 22, K);
    for (let i = 0; i < 6; i++) {
      p.rect(5 + i * 4, 6, 2, 2, W);
      p.rect(5 + i * 4, 24, 2, 2, W);
    }
    picture(p, 6, 10, 20, 12);
  },
  shutdown: (p) => {
    monitor(p);
    p.rect(7, 7, 18, 10, V);
    // a moon over the dark screen
    p.ell(16, 12, 4, 4, Y);
    p.ell(18, 11, 3.5, 3.5, V);
  },
  network: (p) => {
    monitor(p, 2, 4, 18, 14);
    p.line(18, 19, 27, 28, R, 3);
    p.line(27, 19, 18, 28, R, 3);
  },
  star: (p) => ICONS.presets(p),
  undo: (p) => curvedArrow(p),
  redo: (p) => {
    p.x.save();
    p.x.translate(32, 0);
    p.x.scale(-1, 1);
    curvedArrow(p);
    p.x.restore();
  },
  dice: (p) => {
    p.rect(5, 5, 22, 22, W);
    p.line(26, 6, 26, 26, S);
    p.line(6, 26, 26, 26, S);
    for (const [a, b] of [[10, 10], [22, 22], [16, 16], [22, 10], [10, 22]]) p.ell(a, b, 2.2, 2.2, R);
  },
  zoom: (p) => {
    p.line(20, 20, 27, 27, M, 4);
    p.ell(13, 13, 9, 9, K);
    p.ell(13, 13, 7, 7, C);
    p.arc(13, 13, 5, Math.PI * 1.05, Math.PI * 1.55, W, 2);
  },
  grid: (p) => {
    p.rect(3, 3, 26, 26, W);
    for (let i = 0; i <= 4; i++) {
      p.rect(3 + Math.round(i * 6.25), 3, 1, 26, V);
      p.rect(3, 3 + Math.round(i * 6.25), 26, 1, V);
    }
  },
  heat: (p) => {
    const cols = [V, B, T, N, LI, Y, OR, R];
    for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) p.rect(3 + bx * 6.5, 3 + by * 6.5, 6.5, 6.5, cols[(bx * 2 + by * 3 + ((bx * by) % 3)) % cols.length]);
  },
  split: (p) => {
    picture(p, 3, 5, 26, 22);
    for (let by = 0; by < 4; by++) for (let bx = 0; bx < 2; bx++) p.rect(17 + bx * 6, 6 + by * 5, 6, 5, [B, P, N, G][(bx + by * 3) % 4]);
    p.rect(15, 3, 2, 26, K);
  },
  play: (p) => {
    p.poly(N, 8, 5, 27, 16, 8, 27);
    p.line(9, 7, 9, 24, LI);
  },
  record: (p) => {
    p.ell(16, 16, 10, 10, R);
    p.arc(16, 16, 7, Math.PI * 1.05, Math.PI * 1.55, W, 2);
  },
  chat: (p) => {
    p.ell(16, 13, 13, 9, W);
    p.poly(W, 8, 19, 6, 29, 16, 21);
    for (let i = 0; i < 3; i++) p.rect(9 + i * 6, 12, 3, 3, K);
  },
  camera: (p) => {
    p.rect(2, 9, 28, 18, S);
    p.line(2, 9, 29, 9, W);
    p.line(2, 9, 2, 26, W);
    p.rect(9, 6, 9, 3, G);
    p.ell(16, 18, 7, 7, K);
    p.ell(16, 18, 4, 4, B);
    p.px(15, 17, W);
    p.rect(24, 11, 3, 2, R);
  },
  shovel: (p) => {
    p.line(5, 4, 17, 16, BR, 3);
    p.rect(3, 2, 5, 3, K);
    p.poly(S, 15, 19, 21, 13, 29, 23, 25, 29);
    p.line(21, 14, 28, 23, W);
  },
  glue: (p) => {
    p.rect(9, 9, 14, 20, W);
    p.line(22, 10, 22, 28, S);
    p.poly(OR, 12, 9, 14, 3, 18, 3, 20, 9);
    p.rect(11, 14, 10, 8, R);
    p.text('G', 13, 13, W);
  },
  globe: (p) => {
    p.ell(16, 16, 13, 13, B);
    p.poly(N, 8, 9, 13, 6, 17, 9, 16, 14, 11, 18, 8, 15);
    p.poly(N, 18, 18, 24, 16, 27, 21, 22, 27, 18, 24);
    p.arc(16, 16, 11, Math.PI * 1.05, Math.PI * 1.45, C, 2);
  },
  lock: (p) => {
    p.arc(16, 13, 6, Math.PI, 0, G, 3);
    p.rect(9, 13, 3, 3, G);
    p.rect(20, 13, 3, 3, G);
    p.rect(6, 15, 20, 14, Y);
    p.line(6, 15, 25, 15, W);
    p.line(7, 28, 25, 28, O);
    p.rect(15, 19, 2, 6, K);
  },
  stamp: (p) => {
    p.rect(4, 4, 24, 24, W);
    for (let i = 0; i < 6; i++) {
      p.px(5 + i * 4, 4, K);
      p.px(5 + i * 4, 27, K);
      p.px(4, 5 + i * 4, K);
      p.px(27, 5 + i * 4, K);
    }
    picture(p, 7, 7, 18, 18);
  },
  palette: (p) => {
    p.ell(16, 16, 14, 11, TN);
    p.ell(21, 21, 3, 2.5, K);
    [R, N, B, Y].forEach((c, i) => p.ell(9 + i * 5, 11 + (i % 2) * 3, 2.4, 2.4, c));
  },
  mail: (p) => {
    p.rect(3, 7, 26, 18, W);
    p.line(3, 7, 15, 17, G);
    p.line(28, 7, 16, 17, G);
    p.line(4, 24, 28, 24, S);
    p.rect(22, 9, 4, 5, R);
  },
  phone: (p) => {
    p.rect(9, 2, 14, 28, G);
    p.line(9, 2, 22, 2, S);
    p.line(9, 2, 9, 29, S);
    p.rect(11, 5, 10, 9, N + '|' + LI);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) p.rect(11 + c * 3.5, 17 + r * 3.5, 2.5, 2.5, LG);
  },
  ruler: (p) => {
    p.x.save();
    p.x.translate(16, 16);
    p.x.rotate(-Math.PI / 4);
    p.x.fillStyle = Y;
    p.x.fillRect(-15, -5, 30, 10);
    p.x.fillStyle = K;
    for (let i = -13; i < 14; i += 3) p.x.fillRect(i, -5, 1, i % 2 ? 4 : 6);
    p.x.restore();
  },
  flame: (p) => {
    const outer = [16, 2, 24, 10, 26, 19, 23, 26, 16, 30, 9, 26, 6, 19, 9, 12, 12, 16, 13, 9];
    p.poly(R, ...outer);
    p.poly(OR, 16, 10, 21, 17, 21, 23, 16, 27, 11, 23, 12, 18, 14, 20);
    p.poly(Y, 16, 18, 19, 22, 17, 26, 14, 25, 14, 22);
  },
};

function recycleBin(p: Pen) {
  // the 98 wire wastebasket: an open rim and a tapered mesh body
  const body = [5, 8, 27, 8, 24, 29, 8, 29];
  p.poly(W, ...body);
  p.clip(body, () => {
    p.rect(0, 0, 32, 32, LG);
    for (let i = -24; i < 32; i += 4) {
      p.line(i, 8, i + 22, 30, G);
      p.line(i + 22, 8, i, 30, G);
    }
    p.rect(19, 8, 8, 22, S + '|' + G);
  });
  p.line(8, 29, 24, 29, G);
  p.ell(16, 8, 11.5, 3, S);
  p.ell(16, 8, 9.5, 1.8, D);
  p.line(6, 7, 14, 6, W);
}

function floppy(p: Pen) {
  // 3½" disk: navy body, sliding metal shutter, white label
  p.poly(V, 3, 3, 26, 3, 29, 6, 29, 29, 3, 29);
  p.line(4, 4, 4, 28, B);
  p.rect(9, 3, 14, 9, S);
  p.line(9, 3, 22, 3, W);
  p.rect(18, 4, 3, 7, V);
  p.rect(7, 16, 18, 13, W);
  p.rect(7, 16, 18, 2, R);
  for (let i = 0; i < 3; i++) p.line(9, 21 + i * 2, 22, 21 + i * 2, S);
}

// ---- 16×16 pixel rows for the icons that are seen small most often
// Upper case are the VGA colours by their constant names (L = light grey); a/b/c manila light/body/shade,
// y yellow, r red, n green, l lime, w brown, o orange, t tan.
const SMALL_PAL: Record<string, string> = {
  K, W, S, L: LG, G, D, R, M, Y, O, N, C, T, B, V, P, F,
  a: MA, b: MB, c: MC, y: Y, r: R, n: N, l: LI, w: BR, o: OR, t: TN,
};

const SMALL: Record<string, string[]> = {
  folder: [
    '................',
    '................',
    '.KKKKK..........',
    'KaaaaaK.........',
    'KabbbbaKKKKKKK..',
    'KabbbbbaaaaaaaK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KccccccccccccccK',
    '.KKKKKKKKKKKKKK.',
    '................',
  ],
  pictures: [
    '................',
    '....KKKKKKKKK...',
    '.KKKKWWWWWWWKK..',
    'KaaaKWBCBCBWK...',
    'KabbKWCCCyCWKK..',
    'KabbKWCnCCCWbaK.',
    'KabbKWnnnnnWbcK.',
    'KabbKKKKKKKKbcK.',
    'KaaaaaaaaaaaacK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KccccccccccccccK',
    '.KKKKKKKKKKKKKK.',
    '................',
  ],
  project: [
    '................',
    '....KKKKKKKK....',
    '.KKKKWWWWWWKK...',
    'KaaaKWBBBBWWK...',
    'KabbKWWWWWWWKK..',
    'KabbKWGGGGGWbaK.',
    'KabbKWWWrrWWbcK.',
    'KabbKKKKrrKKbcK.',
    'KaaaaaaarraaacK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KabbbbbbbbbbbcK.',
    'KccccccccccccccK',
    '.KKKKKKKKKKKKKK.',
    '................',
  ],
  recycle: [
    '................',
    '...KKKKKKKKK....',
    '.KKSSSSSSSSSKK..',
    'KSWWDDDDDDDSSSK.',
    '.KKSSSSSSSSSKK..',
    '.KLGLLGLLGLGSK..',
    '.KLLGLGLGLLGSK..',
    '..KGLLGLLGGSK...',
    '..KLGLGLGLGSK...',
    '..KLLGLLGLLGK...',
    '..KGLGLGLGGSK...',
    '...KLGLLGLSK....',
    '...KGLGLGLGK....',
    '...KLLGLLGSK....',
    '....KKKKKKK.....',
    '................',
  ],
  recyclefull: [
    '....KKK..KKK....',
    '...KWWWKKWWyK...',
    '..KWWSWWWyyyWK..',
    'KKSKWWWWWWWWKSKK',
    'KSWWDDDDDDDDSSSK',
    '.KKSSSSSSSSSSKK.',
    '.KLGLLGLLGLGSK..',
    '..KGLLGLLGGSK...',
    '..KLGLGLGLGSK...',
    '..KLLGLLGLLGK...',
    '..KGLGLGLGGSK...',
    '...KLGLLGLSK....',
    '...KGLGLGLGK....',
    '...KLLGLLGSK....',
    '....KKKKKKK.....',
    '................',
  ],
  disk: [
    '................',
    '................',
    '................',
    '....KKKKKKKKKKK.',
    '...KLLLLLLLLLWK.',
    '..KWWWWWWWWWWLK.',
    '.KKKKKKKKKKKKSK.',
    '.KWWWWWWWWWWWSK.',
    '.KWSSSSSSSSSSSK.',
    '.KWSKKKKKKSSSGK.',
    '.KWSSWWWWWSSlGK.',
    '.KWSSSSSSSSSSGK.',
    '.KGGGGGGGGGGGGK.',
    '.KKKKKKKKKKKKKK.',
    '................',
    '................',
  ],
  jpeg: [
    '..KKKKKKKK......',
    '..KWWWWWWKK.....',
    '..KWWWWWWKSK....',
    '..KWWWWWWKKKK...',
    '..KWWWWWWWWWK...',
    '..KWKKKKKKKWK...',
    '..KWKBCBCyKWK...',
    '..KWKCCCCCKWK...',
    '..KWKCnCCCKWK...',
    '..KWKnnnCnKWK...',
    '..KWKnnnnnKWK...',
    '..KWKKKKKKKWK...',
    '..KWWWWWWWWWK...',
    '..KWWWWWWWWWK...',
    '..KKKKKKKKKKK...',
    '................',
  ],
  editor: [
    '................',
    'KKKKKKKKKKKKKKKK',
    'KtttttttttttttwK',
    'KtWWWWWWWWWWWWwK',
    'KtWBCBCBCBCyCWwK',
    'KtWCCCCCCCCCCWwK',
    'KtWCCnCCCCCCCWwK',
    'KtWCnnnCCBBPPWwK',
    'KtWnnnnnnBBPPWwK',
    'KtWnnnnnnNNyyWwK',
    'KtWnnnnnnNNyyWwK',
    'KtWWWWWWWWWWWWwK',
    'KtwwwwwwwwwwwwwK',
    'KKKKKKKKKKKKKKKK',
    '................',
    '................',
  ],
  help: [
    '..KKKKKKKKKKK...',
    '..KVBVVVVVVVKW..',
    '..KVBVVyyyVVKWK.',
    '..KVBVyVVVyVKWK.',
    '..KVBVVVVVyVKWK.',
    '..KVBVVVVyVVKWK.',
    '..KVBVVVyVVVKWK.',
    '..KVBVVVyVVVKWK.',
    '..KVBVVVVVVVKWK.',
    '..KVBVVVyVVVKWK.',
    '..KVBVVVVVVVKWK.',
    '..KVBVVVVVVVKWK.',
    '..KVBVVVVVVVKSK.',
    '..KKKKKKKKKKKWK.',
    '...KKKKKKKKKKKK.',
    '................',
  ],
  about: [
    '................',
    '.....KKKKKK.....',
    '...KKBBBBBBKK...',
    '..KBBCCBWWBBBK..',
    '..KBCBBBWWBBBK..',
    '.KBCBBBBBBBBBBK.',
    '.KBBBBWWWWBBBBK.',
    '.KBBBBBBWWBBBBK.',
    '.KBBBBBBWWBBBBK.',
    '.KBBBBBBWWBBBBK.',
    '..KBBBBBWWBBBK..',
    '..KBBBBWWWWBBK..',
    '...KKBBBBBBKK...',
    '.....KKKKKK.....',
    '................',
    '................',
  ],
  display: [
    '................',
    '.KKKKKKKKKKKKKK.',
    '.KWWWWWWWWWWWWGK',
    '.KWKKKKKKKKKKSGK',
    '.KWKTTTTTTTTKSGK',
    '.KWKTTTTTTTTKSGK',
    '.KWKTTTTTTTTKSGK',
    '.KWKTTTTTTTTKSGK',
    '.KWKKKKKKKKKKSGK',
    '.KWSSSSSSSSSlSGK',
    '.KGGGGGGGGGGGGGK',
    '.KKKKKKKKKKKKKKK',
    '......KGGGK.....',
    '...KKKKKKKKKKK..',
    '...KWWWWWWWWSK..',
    '...KKKKKKKKKKK..',
  ],
  export: [
    '................',
    '.KKKKKKKKKKKKK..',
    '.KVKSSSSSSKVVK..',
    '.KVKSSSVVSKVVVK.',
    '.KVKSSSVVSKVVVK.',
    '.KVKSSSSSSKVVVK.',
    '.KVVKKKKKKVVVVK.',
    '.KVVVVVVVVVVVVK.',
    '.KVKKKKKKKKKKVK.',
    '.KVKrrrrrrrrKVK.',
    '.KVKWWWWWWWWKVK.',
    '.KVKWSSSSSSWKVK.',
    '.KVKWWWWWWWWKVK.',
    '.KVKWSSSSSSWKVK.',
    '.KKKKKKKKKKKKKK.',
    '................',
  ],
  presets: [
    '..........K.....',
    '.........KyK....',
    '.C.......KyK....',
    '......KKKyyyKKK.',
    '......KyyyyyyyK.',
    '.......KyyyoyK..',
    '........KyoyK...',
    '.......KyyKyyK..',
    '......KWyK.KyK..',
    '.....KWKK...KK..',
    '....KKK.........',
    '...KKK..........',
    '..KKK.....F.....',
    '.KKK............',
    '.KK.............',
    '................',
  ],
  undo: [
    '................',
    '................',
    '.....KKKKK......',
    '...KKVVVVVKK....',
    '..KVVVKKKVVVK...',
    '.KKKKK...KKVVK..',
    'KVVVVK.....KVVK.',
    '.KVVK......KVVK.',
    '..KK.......KVVK.',
    '...........KVVK.',
    '..........KVVK..',
    '.........KVVK...',
    '........KVVK....',
    '.........KK.....',
    '................',
    '................',
  ],
  hex: [
    '................',
    'KKKKKKKKKKKKKKKK',
    'KVVVVVVVVVVVVVVK',
    'KSSSSSSSSSSSSSSK',
    'KSKKKKKKKKKKKKSK',
    'KSKllKllKKllKKSK',
    'KSKKKKKKKKKKKKSK',
    'KSKllKKKllKllKSK',
    'KSKKKKKKKKKKKKSK',
    'KSKKKllKllKKKKSK',
    'KSKKKKKKKKKKKKSK',
    'KSKllKllKKllKKSK',
    'KSKKKKKKKKKKKKSK',
    'KSSSSSSSSSSSSSSK',
    'KKKKKKKKKKKKKKKK',
    '................',
  ],
  dice: [
    '................',
    '..KKKKKKKKKKKK..',
    '.KWWWWWWWWWWWSK.',
    '.KWRRWWWWWWRRSK.',
    '.KWRRWWWWWWRRSK.',
    '.KWWWWWWWWWWWSK.',
    '.KWWWWWRRWWWWSK.',
    '.KWWWWWRRWWWWSK.',
    '.KWWWWWWWWWWWSK.',
    '.KWRRWWWWWWRRSK.',
    '.KWRRWWWWWWRRSK.',
    '.KWWWWWWWWWWWSK.',
    '.KSSSSSSSSSSSSK.',
    '..KKKKKKKKKKKK..',
    '................',
    '................',
  ],
  // the Start button's own glyph: four disk clusters, one of them out of line (no Windows flag)
  start: [
    '........KKKKKK..',
    '.KKKKKK.KllllK..',
    '.KRRRRK.KllllK..',
    '.KRRRRK.KllllK..',
    '.KRRRRK.KllllK..',
    '.KRRRRK.KKKKKK..',
    '.KKKKKK.........',
    '................',
    'KKKKKK..........',
    'KBBBBK...KKKKKK.',
    'KBBBBK...KYYYYK.',
    'KBBBBK...KYYYYK.',
    'KBBBBK...KYYYYK.',
    'KKKKKK...KYYYYK.',
    '.........KKKKKK.',
    '................',
  ],
};
SMALL.redo = SMALL.undo.map((r) => [...r].reverse().join(''));
SMALL.star = SMALL.presets;

export function iconNames(): string[] {
  return Object.keys(ICONS);
}

function smallCanvas(rows: string[]): HTMLCanvasElement {
  const c = canvas(16, 16);
  const x = c.getContext('2d')!;
  rows.forEach((r, y) => {
    for (let i = 0; i < r.length; i++) {
      const col = SMALL_PAL[r[i]];
      if (!col || r[i] === '.') continue;
      x.fillStyle = col;
      x.fillRect(i, y, 1, 1);
    }
  });
  return c;
}

/** Renders a painter at `size` px: 4× supersampled, snapped to the icon palette, majority colour per pixel,
 *  then a black outline around the silhouette. */
export function iconCanvas(name: string, size = 32): HTMLCanvasElement {
  if (size === 16 && SMALL[name]) return smallCanvas(SMALL[name]);
  const big = canvas(size * SS, size * SS);
  const bx = big.getContext('2d', { willReadFrequently: true })!;
  const sc = (size * SS) / 32;
  bx.scale(sc, sc);
  (ICONS[name] ?? ICONS.folder)(new Pen(bx, sc));
  const src = bx.getImageData(0, 0, big.width, big.height).data;
  const c = canvas(size, size);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  const out = x.createImageData(size, size);
  const idx = new Int8Array(size * size).fill(-1);
  const counts = new Int16Array(PAL.length + 1);
  for (let y = 0; y < size; y++)
    for (let xx = 0; xx < size; xx++) {
      counts.fill(0);
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * big.width + xx * SS + sx) * 4;
          counts[src[i + 3] >= 128 ? nearestIcon(src[i], src[i + 1], src[i + 2]) + 1 : 0]++;
        }
      // majority; ties go to opaque, then to the darker colour (keeps outlines and dark details)
      let best = 0;
      for (let j = 1; j < counts.length; j++) {
        if (counts[j] > counts[best] || (counts[j] === counts[best] && counts[j] > 0 && (best === 0 || LUMA[j - 1] < LUMA[best - 1]))) best = j;
      }
      idx[y * size + xx] = best - 1;
    }
  // silhouette outline: transparent pixels touching an opaque one turn black
  const opaque = (X: number, Y: number) => X >= 0 && Y >= 0 && X < size && Y < size && idx[Y * size + X] >= 0;
  for (let y = 0; y < size; y++)
    for (let xx = 0; xx < size; xx++) {
      const i = y * size + xx;
      let k = idx[i];
      if (k < 0 && (opaque(xx - 1, y) || opaque(xx + 1, y) || opaque(xx, y - 1) || opaque(xx, y + 1))) k = 0;
      if (k < 0) continue;
      const [r, g, b] = PAL_RGB[k];
      out.data[i * 4] = r;
      out.data[i * 4 + 1] = g;
      out.data[i * 4 + 2] = b;
      out.data[i * 4 + 3] = 255;
    }
  x.putImageData(out, 0, 0);
  return c;
}

export function icon(name: string, size = 32): string {
  return cachedUrl(`icon:${name}:${size}`, () => iconCanvas(name, size));
}

/** Creates an <img> for an icon (decorative unless alt is given). */
export function iconImg(name: string, size = 16, alt = ''): HTMLImageElement {
  const img = document.createElement('img');
  img.src = icon(name, size);
  img.width = size;
  img.height = size;
  img.alt = alt;
  img.className = 'ico';
  img.draggable = false;
  if (!alt) img.setAttribute('aria-hidden', 'true');
  return img;
}
