// The one fixed 256-colour UI palette: web-safe 216 plus the Windows 98 / VGA colours the cube lacks (the 98
// chrome, the half-intensity VGA colours, the tooltip yellow, the icon manilas), greys and the sky blues. Every
// piece of UI art is dithered into it. Pure module (also used inside workers).

const EXTRA: number[] = [
  // greys that the web-safe cube lacks
  0x111111, 0x222222, 0x444444, 0x555555, 0x777777, 0x888888, 0xaaaaaa, 0xbbbbbb, 0xdddddd, 0xeeeeee,
  // the 98 chrome: shadow, face, light, dark shadow, inactive caption end
  0x808080, 0xc0c0c0, 0xdfdfdf, 0x404040, 0xb5b5b5,
  // VGA half-intensity colours, the active caption end, the tooltip yellow
  0x000080, 0x008080, 0x800000, 0x008000, 0x808000, 0x800080, 0x1084d0, 0xffffe1,
  // the dark end of the wizard panel (teal → navy) and the steps between
  0x006060, 0x004848, 0x002850, 0x000040,
  // icon manilas and browns
  0xfff8c0, 0xf0d878, 0xb89840, 0x804000,
  // sky blues
  0x5c8fd6, 0x87b5f0, 0xa8cbf5, 0xc5ddf7, 0xe3eefb, 0x3a6fc4, 0x295bb1,
];

export const PALETTE: Uint8Array = (() => {
  const p = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) {
        p[i++] = r * 51;
        p[i++] = g * 51;
        p[i++] = b * 51;
      }
  for (const c of EXTRA) {
    p[i++] = (c >> 16) & 255;
    p[i++] = (c >> 8) & 255;
    p[i++] = c & 255;
  }
  return p;
})();

export const PALETTE_SIZE = 216 + EXTRA.length;

let lut: Uint8Array | null = null;

/** 32×32×32 lookup: 5-bit RGB -> nearest palette index (perceptually weighted distance). */
function buildLut(): Uint8Array {
  const t = new Uint8Array(32 * 32 * 32);
  for (let r = 0; r < 32; r++)
    for (let g = 0; g < 32; g++)
      for (let b = 0; b < 32; b++) {
        const R = (r << 3) | (r >> 2);
        const G = (g << 3) | (g >> 2);
        const B = (b << 3) | (b >> 2);
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < PALETTE_SIZE; i++) {
          const dr = R - PALETTE[i * 3];
          const dg = G - PALETTE[i * 3 + 1];
          const db = B - PALETTE[i * 3 + 2];
          const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        t[(r << 10) | (g << 5) | b] = best;
      }
  return t;
}

export function nearest(r: number, g: number, b: number): number {
  if (!lut) lut = buildLut();
  r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  return lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
}

export function hex(i: number): string {
  const n = (PALETTE[i * 3] << 16) | (PALETTE[i * 3 + 1] << 8) | PALETTE[i * 3 + 2];
  return '#' + n.toString(16).padStart(6, '0');
}

/** Snap a #rrggbb colour to the palette (returns #rrggbb). */
export function snap(css: string): string {
  const n = parseInt(css.slice(1), 16);
  return hex(nearest((n >> 16) & 255, (n >> 8) & 255, n & 255));
}

export const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35,
  11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

/** Ordered (Bayer 8×8) dither into the palette, in place. Alpha is made binary. `ox/oy` keep the pattern
 *  anchored to the screen grid when a sprite is drawn at an offset. */
export function ditherBayer(px: Uint8ClampedArray | Uint8Array, w: number, h: number, spread = 44, ox = 0, oy = 0): void {
  for (let y = 0; y < h; y++) {
    const row = ((y + oy) & 7) * 8;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = ((BAYER8[row + ((x + ox) & 7)] + 0.5) / 64 - 0.5) * spread;
      const k = nearest(px[i] + t, px[i + 1] + t, px[i + 2] + t) * 3;
      px[i] = PALETTE[k];
      px[i + 1] = PALETTE[k + 1];
      px[i + 2] = PALETTE[k + 2];
      px[i + 3] = px[i + 3] >= 128 ? 255 : 0;
    }
  }
}

/** HSL (h in degrees, s and l 0..1) to 0..255 RGB, as CSS hsl() computes it. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** The 16 VGA colours (a 16-colour 98 desktop). */
export const VGA16 = [
  0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
].map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]);

function nearest16(r: number, g: number, b: number): number[] {
  let best = VGA16[0];
  let bd = Infinity;
  for (const c of VGA16) {
    const dr = r - c[0];
    const dg = g - c[1];
    const db = b - c[2];
    const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** Display ▸ Settings ▸ Colors, in place: '16' orders into the VGA 16, '256' into our palette (ditherBayer),
 *  'high' quantises to 5-6-5 bits with a fine ordered dither, 'true' leaves the pixels alone. Alpha binary. */
export function ditherDepth(px: Uint8ClampedArray | Uint8Array, w: number, h: number, depth: string, spread = 40): void {
  if (depth === '256') return ditherBayer(px, w, h, spread);
  if (depth === 'true') {
    for (let i = 3; i < px.length; i += 4) px[i] = px[i] >= 128 ? 255 : 0;
    return;
  }
  const sixteen = depth === '16';
  for (let y = 0; y < h; y++) {
    const row = (y & 7) * 8;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const f = (BAYER8[row + (x & 7)] + 0.5) / 64 - 0.5;
      if (sixteen) {
        // 16 colours are far apart: a wide spread, or a photo turns into flat blobs
        const c = nearest16(px[i] + f * 128, px[i + 1] + f * 128, px[i + 2] + f * 128);
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
      } else {
        // 5 bits red and blue (steps of 8), 6 bits green (steps of 4)
        const q = (v: number, step: number) => Math.max(0, Math.min(255, Math.round((v + f * step) / step) * step));
        px[i] = Math.min(255, q(px[i], 8));
        px[i + 1] = Math.min(255, q(px[i + 1], 4));
        px[i + 2] = Math.min(255, q(px[i + 2], 8));
      }
      px[i + 3] = px[i + 3] >= 128 ? 255 : 0;
    }
  }
}

/** Atkinson error diffusion into the palette, in place (photo thumbnails). Alpha is made binary. */
export function ditherAtkinson(px: Uint8ClampedArray | Uint8Array, w: number, h: number): void {
  const n = w * h;
  const er = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    er[i * 3] = px[i * 4];
    er[i * 3 + 1] = px[i * 4 + 1];
    er[i * 3 + 2] = px[i * 4 + 2];
  }
  const spread = (x: number, y: number, e0: number, e1: number, e2: number) => {
    if (x < 0 || x >= w || y >= h) return;
    const j = (y * w + x) * 3;
    er[j] += e0;
    er[j + 1] += e1;
    er[j + 2] += e2;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (px[i * 4 + 3] < 128) {
        px[i * 4 + 3] = 0;
        continue;
      }
      const r = er[i * 3];
      const g = er[i * 3 + 1];
      const b = er[i * 3 + 2];
      const k = nearest(r, g, b) * 3;
      px[i * 4] = PALETTE[k];
      px[i * 4 + 1] = PALETTE[k + 1];
      px[i * 4 + 2] = PALETTE[k + 2];
      px[i * 4 + 3] = 255;
      const e0 = (r - PALETTE[k]) / 8;
      const e1 = (g - PALETTE[k + 1]) / 8;
      const e2 = (b - PALETTE[k + 2]) / 8;
      spread(x + 1, y, e0, e1, e2);
      spread(x + 2, y, e0, e1, e2);
      spread(x - 1, y + 1, e0, e1, e2);
      spread(x, y + 1, e0, e1, e2);
      spread(x + 1, y + 1, e0, e1, e2);
      spread(x, y + 2, e0, e1, e2);
    }
}

/** Bayer threshold mask level 0..64: is pixel (x,y) "on" at this fade level? Used for dithered fades. */
export function bayerOn(x: number, y: number, level: number): boolean {
  return BAYER8[(y & 7) * 8 + (x & 7)] < level;
}
