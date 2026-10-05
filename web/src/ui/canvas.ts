// The canvas helpers every art module shares (art.ts, icons98.ts). Its own module because art.ts re-exports
// icons98, so icons98 can't import art.ts without a cycle.

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export type BevelKind = 'raised' | 'frame' | 'sunken' | 'pressed' | 'pushed';

/** The 98 bevels as 1 px rings of shades, outermost first, [top-left, bottom-right]: W highlight, L light,
 *  G shadow, K dark shadow. 'pushed' is a pressed caption/push button, 'pressed' a toolbar-style one. */
export const BEVEL_RINGS: Record<BevelKind, [string, string][]> = {
  raised: [['W', 'K'], ['L', 'G']],
  frame: [['L', 'K'], ['W', 'G']],
  sunken: [['G', 'W'], ['K', 'L']],
  pressed: [['G', 'G']],
  pushed: [['K', 'W'], ['G', 'L']],
};

/** A w×h grid of shade letters with the bevel's rings drawn in (the two far corners take the bottom-right
 *  shade, as 98 draws them) and `fill` inside. */
export function bevelRows(w: number, h: number, kind: BevelKind, fill = '.'): string[] {
  const g: string[][] = Array.from({ length: h }, () => Array<string>(w).fill(fill));
  BEVEL_RINGS[kind].forEach(([tl, br], i) => {
    for (let x = i; x < w - i; x++) {
      g[i][x] = tl;
      g[h - 1 - i][x] = br;
    }
    for (let y = i; y < h - i; y++) {
      g[y][i] = tl;
      g[y][w - 1 - i] = br;
    }
    g[h - 1 - i][i] = br;
    g[i][w - 1 - i] = br;
  });
  return g.map((r) => r.join(''));
}

const urls = new Map<string, string>();

/** A canvas drawn once per key, kept as a PNG data URL. */
export function cachedUrl(key: string, make: () => HTMLCanvasElement): string {
  let u = urls.get(key);
  if (!u) {
    u = make().toDataURL('image/png');
    urls.set(key, u);
  }
  return u;
}
