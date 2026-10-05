// Procedural sky with parallax cartoon clouds (original art): each cloud is a union of round puffs over a
// flat-ish base, painted with flat fills in three shade bands (lit top left, mid, dark underside) and a
// dark outline. Rendered in the ambient worker, run through our own JPEG codec at low quality, then
// Bayer-dithered into the UI palette.
import { ditherBayer } from '../ui/palette';

export interface SkyParams {
  width: number;
  height: number;
  /** Frame counter at ~8 fps. */
  t: number;
  /** Cloud speed multiplier (0 = still). */
  speed: number;
  /** Return without dithering (for a solid/user wallpaper preview). */
  noDither?: boolean;
}

/** Pixel classes in a cloud layer. */
export const NONE = 0;
export const OUTLINE = 1;
export const DARK = 2;
export const MID = 3;
export const LIGHT = 4;

type RGB = [number, number, number];

interface Layer {
  /** Wraps horizontally with period w. */
  w: number;
  h: number;
  y0: number;
  cls: Uint8Array;
  rate: number;
  pal: RGB[];
}

let cache: { key: string; layers: Layer[]; base: Uint8ClampedArray } | null = null;

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Puff {
  x: number;
  y: number;
  r: number;
}

/** Builds one layer's class map: clouds of size ~s, spread along a band of height h. */
export function makeCloudLayer(w: number, h: number, s: number, seed: number): Uint8Array {
  const rnd = rng(seed);
  const inside = new Uint8Array(w * h);
  const shade = new Uint8Array(w * h);
  const n = Math.max(1, Math.round(w / (s * 4.8)));
  for (let i = 0; i < n; i++) {
    const size = s * (0.75 + rnd() * 0.5);
    const cx = ((i + 0.2 + rnd() * 0.6) * w) / n;
    const base = h * 0.35 + rnd() * h * 0.45 + size * 0.3;
    const puffs: Puff[] = [];
    const k = 4 + Math.floor(rnd() * 3);
    for (let j = 0; j < k; j++) {
      const u = k === 1 ? 0 : (j / (k - 1)) * 2 - 1; // -1..1 along the cloud
      const r = size * (0.42 + rnd() * 0.25) * (1 - 0.45 * Math.abs(u));
      puffs.push({ x: cx + u * size * 1.15 + (rnd() - 0.5) * size * 0.2, y: base - r * 0.75 - (1 - Math.abs(u)) * size * 0.25, r });
    }
    // the base: a wide flat ellipse that joins the puffs
    const bx = cx;
    const by = base - size * 0.22;
    const brx = size * 1.45;
    const bry = size * 0.32;
    const flat = base + size * 0.05;
    const x0 = Math.floor(cx - size * 2);
    const x1 = Math.ceil(cx + size * 2);
    const y0 = Math.max(0, Math.floor(base - size * 1.6));
    const y1 = Math.min(h - 1, Math.ceil(flat));
    const inPuffs = (x: number, y: number, dx: number, dy: number, f: number) => {
      for (const p of puffs) {
        const rr = p.r * f;
        const ex = x - (p.x + dx * p.r);
        const ey = y - (p.y + dy * p.r);
        if (ex * ex + ey * ey <= rr * rr) return true;
      }
      const ex = (x - (bx + dx * bry)) / (brx * f);
      const ey = (y - (by + dy * bry)) / (bry * f);
      return ex * ex + ey * ey <= 1;
    };
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (y > flat || !inPuffs(x, y, 0, 0, 1)) continue;
        const xi = ((x % w) + w) % w;
        const i = y * w + xi;
        inside[i] = 1;
        // shade bands: shrunken copies of the shape shifted toward the light (top left)
        let c = DARK;
        if (y < flat - size * 0.16) {
          if (inPuffs(x, y, -0.26, -0.34, 0.68)) c = LIGHT;
          else if (inPuffs(x, y, -0.1, -0.14, 0.88)) c = MID;
        }
        if (c > shade[i]) shade[i] = c;
      }
  }
  // a 1 px dark outline on the shape's edge
  const cls = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inside[i]) continue;
      const l = inside[y * w + ((x + w - 1) % w)];
      const r = inside[y * w + ((x + 1) % w)];
      const u = y > 0 ? inside[i - w] : 0;
      const d = y < h - 1 ? inside[i + w] : 0;
      cls[i] = l && r && u && d ? shade[i] : OUTLINE;
    }
  return cls;
}

function setup(W: number, H: number) {
  const key = W + 'x' + H;
  if (cache && cache.key === key) return cache;
  const base = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1 || 1);
    // deep blue at the top, pale near the horizon
    const r = 40 + v * 120;
    const g = 100 + v * 110;
    const b = 210 + v * 40;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      base[i] = r;
      base[i + 1] = g;
      base[i + 2] = b;
      base[i + 3] = 255;
    }
  }
  // [unused, outline, dark band, mid band, lit]: far clouds are paler and their outline softer
  const far: RGB[] = [[0, 0, 0], [60, 80, 140], [160, 178, 220], [204, 216, 242], [240, 246, 255]];
  const mid: RGB[] = [[0, 0, 0], [32, 42, 96], [136, 154, 204], [196, 210, 238], [255, 255, 255]];
  const near: RGB[] = [[0, 0, 0], [16, 22, 64], [120, 140, 196], [190, 206, 236], [255, 255, 255]];
  const layer = (y0f: number, hf: number, s: number, seed: number, rate: number, pal: RGB[]): Layer => {
    const w = W * 2;
    const h = Math.max(8, Math.round(H * hf));
    return { w, h, y0: Math.round(H * y0f), cls: makeCloudLayer(w, h, Math.max(5, s), seed), rate, pal };
  };
  const layers = [
    layer(0.02, 0.3, H * 0.05, 11, 1, far),
    layer(0.22, 0.36, H * 0.075, 23, 2, mid),
    layer(0.5, 0.5, H * 0.11, 37, 3, near),
  ];
  cache = { key, layers, base };
  return cache;
}

export function renderSkyFrame(p: SkyParams): Uint8ClampedArray {
  const W = p.width | 0;
  const H = p.height | 0;
  const { layers, base } = setup(W, H);
  const out = new Uint8ClampedArray(base);
  for (const L of layers) {
    // whole-pixel steps only
    const off = Math.floor(p.t * p.speed * L.rate * 0.5) % L.w;
    for (let y = 0; y < L.h; y++) {
      const sy = y + L.y0;
      if (sy < 0 || sy >= H) continue;
      const row = y * L.w;
      for (let x = 0; x < W; x++) {
        const c = L.cls[row + ((x + off) % L.w)];
        if (!c) continue;
        const col = L.pal[c];
        const i = (sy * W + x) * 4;
        out[i] = col[0];
        out[i + 1] = col[1];
        out[i + 2] = col[2];
      }
    }
  }
  return out;
}

/** Dithering happens after the JPEG round trip so the block artefacts survive into the palette image. */
export function ditherSky(px: Uint8ClampedArray, w: number, h: number): void {
  ditherBayer(px, w, h, 40);
}
