// Shared test helpers: deterministic synthetic "photos" and image measurements.

/** Small deterministic PRNG (Park-Miller) returning 0..1. */
export function rng(seed: number): () => number {
  let s = (seed >>> 0) % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export type PhotoKind = 'landscape' | 'portrait' | 'stripes' | 'checker';

/**
 * A deterministic synthetic photo (RGBA): smooth gradients, hard edges, shapes and fine noise, so JPEG
 * coding produces a realistic mix of flat and busy blocks. Each kind looks clearly different.
 */
export function syntheticPhoto(kind: PhotoKind, W: number, H: number, seed = 1): Uint8Array {
  const px = new Uint8Array(W * H * 4);
  const r = rng(seed * 7919 + kind.length);
  const put = (x: number, y: number, c: [number, number, number]) => {
    const i = (y * W + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      let c: [number, number, number];
      switch (kind) {
        case 'landscape': // sky gradient over a green field with a horizon edge
          c = v < 0.4 ? [70 + 140 * v, 130 + 200 * v, 230] : [90 - 60 * (v - 0.4), 160 - 90 * (v - 0.4), 50 + 20 * u];
          break;
        case 'portrait': {
          // warm background with a big soft "face" disc
          const d = Math.hypot(u - 0.5, (v - 0.45) * 1.3);
          c = d < 0.28 ? [225 - 120 * d, 180 - 150 * d, 150 - 120 * d] : [120 + 80 * v, 60 + 40 * u, 40];
          break;
        }
        case 'stripes': // diagonal colour bands
          c = Math.floor((x + y) / 24) % 2 ? [200, 60 + 120 * v, 40] : [30, 90, 160 + 80 * u];
          break;
        default: // checkerboard with a radial tint
          c = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? [240 - 100 * u, 230, 90] : [40, 40 + 100 * v, 90 + 100 * u];
      }
      const n = (r() - 0.5) * 24; // sensor-ish texture
      put(x, y, [clamp(c[0] + n), clamp(c[1] + n), clamp(c[2] + n)]);
    }
  }
  // a few hard-edged shapes on top
  for (let k = 0; k < 40; k++) {
    const cx = r() * W;
    const cy = r() * H;
    const rad = 4 + r() * 30;
    const col: [number, number, number] = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
    for (let y = Math.max(0, Math.floor(cy - rad)); y < Math.min(H, cy + rad); y++)
      for (let x = Math.max(0, Math.floor(cx - rad)); x < Math.min(W, cx + rad); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) put(x, y, col);
  }
  return px;
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Fraction of whole 8x8 blocks whose pixels are all flat grey (every channel within ±2 of 128). */
export function greyFraction(W: number, H: number, px: ArrayLike<number>): number {
  let g = 0;
  let n = 0;
  for (let by = 0; by + 8 <= H; by += 8) {
    for (let bx = 0; bx + 8 <= W; bx += 8) {
      n++;
      let ok = true;
      for (let y = 0; y < 8 && ok; y++) {
        for (let x = 0; x < 8; x++) {
          const i = ((by + y) * W + bx + x) * 4;
          if (Math.abs(px[i] - 128) > 2 || Math.abs(px[i + 1] - 128) > 2 || Math.abs(px[i + 2] - 128) > 2) {
            ok = false;
            break;
          }
        }
      }
      if (ok) g++;
    }
  }
  return n ? g / n : 0;
}

export interface Img {
  width: number;
  height: number;
  rgba: ArrayLike<number>;
}

/**
 * Mean absolute RGB difference (0..255) over the overlapping top-left region. Different dimensions are a
 * visible change in themselves, so they count as 255 for the non-overlapping area.
 */
export function meanAbsDiff(a: Img, b: Img): number {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      sum += Math.abs(a.rgba[i] - b.rgba[j]) + Math.abs(a.rgba[i + 1] - b.rgba[j + 1]) + Math.abs(a.rgba[i + 2] - b.rgba[j + 2]);
    }
  }
  const overlap = w * h;
  const total = Math.max(a.width * a.height, b.width * b.height);
  return (sum / 3 + (total - overlap) * 255) / Math.max(1, total);
}
