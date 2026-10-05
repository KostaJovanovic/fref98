// The screen savers, drawn at a low resolution into a canvas one frame at a time: the full-screen saver
// (screensaver.ts) and the little monitor in Display Properties use the same ones. All original:
//   starfield  stars flying at you;           folders  Foldy flying at you, mouth flapping;
//   mystify    two bouncing polygons with trails; marquee  a line of text scrolling across;
//   pipes      2D pipes growing across the screen; corrupt  a photo falling apart byte by byte (our codec).
// `codec`: the frame is then squeezed through our JPEG codec at an awful quality (the corrupting photo does its
// own damage). Pixels are plotted whole (no antialiasing), in VGA colours.
import type { SaverKind } from '../settings';
import { drawText, textWidth } from '../ui/pixeltext';
import { foldyStill } from '../foldy/sheet';
import { VGA16 } from '../ui/palette';

export const SAVERS: [SaverKind, string][] = [
  ['starfield', 'JPEG Starfield'],
  ['folders', 'Flying Folders'],
  ['mystify', 'Mystify Your Pixels'],
  ['marquee', 'Scrolling Marquee'],
  ['pipes', 'Pipes'],
  ['corrupt', 'Corrupting JPEG'],
];

export interface SaverOpts {
  /** 1 (slow) .. 5 (fast) */
  speed: number;
  /** what the marquee scrolls */
  text: string;
  /** the corrupting photo's JPEG (null: it makes its own) */
  photo?: () => Uint8Array | null;
  /** decodes a JPEG (the corrupting photo; null result = could not) */
  decode?: (jpeg: Uint8Array) => Promise<{ width: number; height: number; rgba: Uint8ClampedArray | Uint8Array } | null>;
  /** encodes RGBA (the corrupting photo's fallback picture) */
  encode?: (w: number, h: number, rgba: Uint8ClampedArray) => Promise<Uint8Array | null>;
  rand?: () => number;
}

export interface Saver {
  codec: boolean;
  frame(x: CanvasRenderingContext2D): void | Promise<void>;
}

const MOUTH = ['body.open.paper', 'body.half.paper', 'body.closed', 'body.half.paper'];
// bright VGA colours (the dark ones vanish on black)
const BRIGHT = [9, 10, 11, 12, 13, 14, 15].map((i) => VGA16[i]);
const css = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Whole-pixel line (Bresenham) into an RGBA buffer. */
export function plotLine(d: Uint8ClampedArray, W: number, H: number, x0: number, y0: number, x1: number, y1: number, c: number[]) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 4096; guard++) {
    if (x0 >= 0 && y0 >= 0 && x0 < W && y0 < H) {
      const i = (y0 * W + x0) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function black(x: CanvasRenderingContext2D) {
  x.fillStyle = '#000';
  x.fillRect(0, 0, x.canvas.width, x.canvas.height);
}

export function makeSaver(kind: SaverKind, W: number, H: number, o: SaverOpts): Saver {
  const rand = o.rand ?? Math.random;
  const sp = Math.max(1, Math.min(5, o.speed)) / 3;
  if (kind === 'folders') return folders(W, H, sp, rand);
  if (kind === 'mystify') return mystify(W, H, sp, rand);
  if (kind === 'marquee') return marquee(W, H, sp, o.text);
  if (kind === 'pipes') return pipes(W, H, sp, rand);
  if (kind === 'corrupt') return corrupt(W, H, sp, o, rand);
  return starfield(W, H, sp, rand);
}

function starfield(W: number, H: number, sp: number, rand: () => number): Saver {
  const n = Math.max(30, Math.min(220, Math.round((W * H) / 350)));
  const stars = Array.from({ length: n }, () => ({ x: (rand() - 0.5) * 2, y: (rand() - 0.5) * 2, z: rand() }));
  const big = W >= 160;
  return {
    codec: true,
    frame(x) {
      black(x);
      for (const s of stars) {
        s.z -= 0.012 * sp;
        if (s.z <= 0.02) Object.assign(s, { x: (rand() - 0.5) * 2, y: (rand() - 0.5) * 2, z: 1 });
        // big and bright enough to survive quality 6 (single dim pixels get averaged away to black)
        const c = Math.round(110 + 145 * (1 - s.z));
        x.fillStyle = `rgb(${c},${c},${Math.min(255, c + 40)})`;
        const size = big ? (s.z < 0.3 ? 3 : 2) : s.z < 0.3 ? 2 : 1;
        x.fillRect(Math.round(W / 2 + (s.x / s.z) * W * 0.5), Math.round(H / 2 + (s.y / s.z) * H * 0.5), size, size);
      }
    },
  };
}

function folders(W: number, H: number, sp: number, rand: () => number): Saver {
  const n = W >= 160 ? 14 : 8;
  const fs = Array.from({ length: n }, () => ({ x: (rand() - 0.5) * 2, y: (rand() - 0.5) * 2, z: rand() }));
  const unit = W >= 160 ? 16 : 6;
  let t = 0;
  return {
    codec: true,
    frame(x) {
      t++;
      black(x);
      fs.sort((a, b) => b.z - a.z);
      x.imageSmoothingEnabled = false;
      const still = foldyStill(MOUTH[(t >> 2) % 4], 'eyes.happy');
      for (const f of fs) {
        f.z -= 0.006 * sp;
        if (f.z <= 0.05) Object.assign(f, { x: (rand() - 0.5) * 2, y: (rand() - 0.5) * 2, z: 1 });
        const size = Math.max(4, Math.round(unit / f.z / 4) * 4);
        if (still) x.drawImage(still, Math.round(W / 2 + (f.x / f.z) * W * 0.35 - size / 2), Math.round(H / 2 + (f.y / f.z) * H * 0.35 - size / 2), size, size);
      }
    },
  };
}

function mystify(W: number, H: number, sp: number, rand: () => number): Saver {
  const TRAIL = 8;
  const shapes = [0, 1].map((k) => ({
    pts: Array.from({ length: 4 }, () => ({ x: rand() * W, y: rand() * H, vx: (rand() < 0.5 ? -1 : 1) * (0.6 + rand()), vy: (rand() < 0.5 ? -1 : 1) * (0.6 + rand()) })),
    trail: [] as { x: number; y: number }[][],
    colour: k * 3,
  }));
  let t = 0;
  const step = Math.max(0.3, (W / 320) * 2) * sp;
  return {
    codec: true,
    frame(x) {
      t++;
      const img = x.createImageData(W, H);
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      for (const s of shapes) {
        for (const p of s.pts) {
          p.x += p.vx * step;
          p.y += p.vy * step;
          if (p.x < 0 || p.x >= W) ((p.vx = -p.vx), (p.x = Math.max(0, Math.min(W - 1, p.x))));
          if (p.y < 0 || p.y >= H) ((p.vy = -p.vy), (p.y = Math.max(0, Math.min(H - 1, p.y))));
        }
        s.trail.unshift(s.pts.map((p) => ({ x: p.x, y: p.y })));
        if (s.trail.length > TRAIL) s.trail.pop();
        // the colour drifts slowly through the bright VGA set
        if (t % 60 === 0) s.colour = (s.colour + 1) % BRIGHT.length;
        const c = BRIGHT[s.colour];
        for (const q of s.trail) for (let i = 0; i < 4; i++) plotLine(img.data, W, H, q[i].x, q[i].y, q[(i + 1) % 4].x, q[(i + 1) % 4].y, c);
      }
      x.putImageData(img, 0, 0);
    },
  };
}

function marquee(W: number, H: number, sp: number, text: string): Saver {
  const s = (text || ' ').slice(0, 80);
  const scale = W >= 160 ? 2 : 1;
  const tw = textWidth(s, true, scale);
  let pos = W;
  const y = Math.round(H / 2 - (13 * scale) / 2);
  return {
    codec: true,
    frame(x) {
      black(x);
      pos -= Math.max(1, Math.round(2 * sp * scale));
      if (pos < -tw) pos = W;
      drawText(x, s, pos, y, '#ffff00', { bold: true, scale });
    },
  };
}

function pipes(W: number, H: number, sp: number, rand: () => number): Saver {
  const CELL = W >= 160 ? 6 : 3;
  const cols = Math.max(4, Math.floor(W / CELL));
  const rows = Math.max(4, Math.floor(H / CELL));
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let used = new Uint8Array(cols * rows);
  let heads: { x: number; y: number; d: number; c: number[] }[] = [];
  let laid = 0;
  let clear = true;
  const newPipe = () => {
    for (let tries = 0; tries < 30; tries++) {
      const x = Math.floor(rand() * cols);
      const y = Math.floor(rand() * rows);
      if (!used[y * cols + x]) return { x, y, d: Math.floor(rand() * 4), c: BRIGHT[Math.floor(rand() * BRIGHT.length)] };
    }
    return null;
  };
  const cell = (ctx: CanvasRenderingContext2D, x: number, y: number, c: number[], joint: boolean) => {
    const px = x * CELL;
    const py = y * CELL;
    ctx.fillStyle = css(c.map((v) => Math.round(v * 0.55)));
    ctx.fillRect(px, py, CELL, CELL);
    // a lit middle line: the 2D stand-in for a round pipe
    ctx.fillStyle = css(c);
    ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
    if (joint) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px + Math.floor(CELL / 2) - 1, py + Math.floor(CELL / 2) - 1, 2, 2);
    }
  };
  return {
    codec: true,
    frame(x) {
      if (clear) {
        black(x);
        used = new Uint8Array(cols * rows);
        heads = [];
        laid = 0;
        clear = false;
      }
      while (heads.length < 2) {
        const p = newPipe();
        if (!p) break;
        heads.push(p);
        used[p.y * cols + p.x] = 1;
        cell(x, p.x, p.y, p.c, true);
      }
      const steps = Math.max(1, Math.round(sp * 2));
      for (let k = 0; k < steps; k++)
        for (let i = heads.length - 1; i >= 0; i--) {
          const p = heads[i];
          let d = p.d;
          const turn = rand() < 0.2;
          if (turn) d = (d + (rand() < 0.5 ? 1 : 3)) % 4;
          // blocked ahead: try the other turns, else this pipe ends
          let ok = false;
          for (const dd of [d, (d + 1) % 4, (d + 3) % 4]) {
            const nx = p.x + DIRS[dd][0];
            const ny = p.y + DIRS[dd][1];
            if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !used[ny * cols + nx]) {
              const bent = dd !== p.d;
              if (bent) cell(x, p.x, p.y, p.c, true);
              p.x = nx;
              p.y = ny;
              p.d = dd;
              used[ny * cols + nx] = 1;
              cell(x, nx, ny, p.c, false);
              laid++;
              ok = true;
              break;
            }
          }
          if (!ok) heads.splice(i, 1);
        }
      // the screen fills up: start again on black
      if (laid > cols * rows * 0.55 || (!heads.length && !newPipe())) clear = true;
    },
  };
}

function corrupt(W: number, H: number, sp: number, o: SaverOpts, rand: () => number): Saver {
  let clean: Uint8Array | null = null;
  let cur: Uint8Array | null = null;
  let scanAt = 0;
  let hits = 0;
  let last: ImageData | null = null;
  let t = 0;
  const start = async () => {
    clean = o.photo?.() ?? null;
    if (!clean && o.encode) {
      // no photo: a test card of our own (VGA bars), made into a JPEG
      const c = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const v = VGA16[[15, 11, 14, 10, 13, 9, 12, 0][Math.floor((x / W) * 8)]];
          const i = (y * W + x) * 4;
          c[i] = v[0];
          c[i + 1] = v[1];
          c[i + 2] = v[2];
          c[i + 3] = 255;
        }
      clean = await o.encode(W, H, c);
    }
    cur = clean ? clean.slice() : null;
    scanAt = cur ? scanStart(cur) : 0;
    hits = 0;
  };
  return {
    codec: false,
    async frame(x) {
      t++;
      if (!cur) await start();
      if (!cur || !o.decode) {
        black(x);
        return;
      }
      // a few bytes of the picture data go wrong on every frame; after a while it starts again clean
      const n = Math.max(1, Math.round(sp * 2));
      for (let k = 0; k < n && cur.length > scanAt + 4; k++) {
        const i = scanAt + Math.floor(rand() * (cur.length - scanAt - 2));
        cur[i] = (cur[i] ^ (1 << Math.floor(rand() * 8))) & 255;
        if (cur[i] === 0xff) cur[i] = 0xfe;
        hits++;
      }
      if (t % 2 === 0 || !last) {
        const d = await o.decode(cur).catch(() => null);
        if (d) last = fitInto(d, W, H);
      }
      if (last) x.putImageData(last, 0, 0);
      else black(x);
      if (hits > 120 * sp + 60) cur = null;
    },
  };
}

/** Where the entropy-coded data starts (after the first SOS header), so damage hits the picture, not the
 *  headers. */
export function scanStart(b: Uint8Array): number {
  for (let i = 2; i + 3 < b.length; i++) {
    if (b[i] !== 0xff) continue;
    const m = b[i + 1];
    if (m === 0xda) return Math.min(b.length, i + 2 + ((b[i + 2] << 8) | b[i + 3]));
    if (m >= 0xc0 && m <= 0xfe && m !== 0xd8 && !(m >= 0xd0 && m <= 0xd7)) i += 1 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return Math.min(b.length, 2);
}

/** Nearest-neighbour cover-fit of a decoded picture into W×H (no smoothing). */
function fitInto(d: { width: number; height: number; rgba: Uint8ClampedArray | Uint8Array }, W: number, H: number): ImageData {
  const out = new ImageData(W, H);
  const s = Math.max(W / d.width, H / d.height);
  const ox = (d.width * s - W) / 2;
  const oy = (d.height * s - H) / 2;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(d.height - 1, Math.max(0, Math.floor((y + oy) / s)));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(d.width - 1, Math.max(0, Math.floor((x + ox) / s)));
      const i = (sy * d.width + sx) * 4;
      const j = (y * W + x) * 4;
      out.data[j] = d.rgba[i];
      out.data[j + 1] = d.rgba[i + 1];
      out.data[j + 2] = d.rgba[i + 2];
      out.data[j + 3] = 255;
    }
  }
  return out;
}
