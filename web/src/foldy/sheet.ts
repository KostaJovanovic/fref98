// Foldy's art: one sprite sheet PNG plus a JSON manifest, both in src/assets/foldy/. Replace those two files with
// your own art and nothing else has to change.
//
// FORMAT (foldy.json):
//   {
//     "format": "foldy-sheet-1",
//     "size": [64, 64],                 // Foldy's sprite size in pixels; every layer is placed in this box
//     "frames": {
//       "body.closed": { "x": 0, "y": 0, "w": 64, "h": 64, "ax": 0, "ay": 0 },
//       ...
//     }
//   }
//   x, y, w, h = the frame's rectangle in foldy.png; ax, ay = where its top-left corner goes inside the size box
//   (0, 0 for full-size layers; use them if you trim frames to their content).
//
// LAYERS: Foldy is drawn as a body (the folder; its flap is the mouth) with an eye pair on top. Transparent
// background, hard pixel edges (no antialiasing against a background colour).
//   body.closed  body.quarter  body.half  body.open           mouth frames (talking loops open → half → closed)
//   body.quarter.paper  body.half.paper  body.open.paper      the same with paper inside (happy, shocked, proud)
//   eyes.open                                                 normal (looking left, as in the mockup)
//   eyes.open.center  eyes.open.right  eyes.open.up           looking elsewhere (think = up)
//   eyes.half  eyes.closed                                    blink frames (closed is also asleep)
//   eyes.happy  eyes.worried  eyes.shocked                    moods
//   eyes.pain  eyes.pain2                                     pain glitch (> <) and wide-eye + squeezed
// Only body.closed and eyes.open are required: a missing frame falls back (body.open.paper → body.open →
// body.closed; eyes.pain2 → eyes.pain → eyes.closed; any other eyes.* → eyes.open). The JPEG tear, bob and jolt
// are done in code. The mockup generator (test-local/foldy_mock2.py --sheet) writes these two files.
import sheetUrl from '../assets/foldy/foldy.png';
import manifest from '../assets/foldy/foldy.json';

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
  ax?: number;
  ay?: number;
}

interface Manifest {
  format: string;
  size: [number, number];
  frames: Record<string, FrameRect>;
}

const M = manifest as unknown as Manifest;
export const SPRITE_W: number = M.size?.[0] ?? 64;
export const SPRITE_H: number = M.size?.[1] ?? 64;

const FALLBACK: Record<string, string> = {
  'eyes.pain2': 'eyes.pain',
  'eyes.pain': 'eyes.closed',
  'eyes.happy': 'eyes.closed',
  'eyes.half': 'eyes.closed',
  'eyes.closed': 'eyes.open',
  'body.open': 'body.half',
  'body.half': 'body.quarter',
  'body.quarter': 'body.closed',
};

const resolved = new Map<string, FrameRect | null>();

/** The frame for a layer name, following the fallbacks; null only if the sheet lacks even the base frames. */
export function frame(name: string): FrameRect | null {
  const hit = resolved.get(name);
  if (hit !== undefined) return hit;
  let n: string | undefined = name;
  let out: FrameRect | null = null;
  const seen = new Set<string>();
  while (n && !seen.has(n)) {
    seen.add(n);
    if (M.frames[n]) {
      out = M.frames[n];
      break;
    }
    // body.open.paper → body.open; eyes.open.up → eyes.open
    const parts: string[] = n.split('.');
    n = FALLBACK[n] ?? (parts.length > 2 ? parts.slice(0, -1).join('.') : parts[0] === 'eyes' ? 'eyes.open' : parts[0] === 'body' ? 'body.closed' : undefined);
  }
  resolved.set(name, out);
  return out;
}

let img: HTMLImageElement | null = null;
let loading: Promise<HTMLImageElement> | null = null;

export function loadSheet(): Promise<HTMLImageElement> {
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const i = new Image();
      i.decoding = 'async';
      i.onload = () => {
        img = i;
        resolve(i);
      };
      i.onerror = () => reject(new Error('Foldy sprite sheet failed to load'));
      i.src = sheetUrl;
    });
  }
  return loading;
}

/** Draws one layer at 1:1 into a sprite-sized context, offset by (dx, dy). */
export function drawLayer(ctx: CanvasRenderingContext2D, name: string, dx = 0, dy = 0) {
  const f = frame(name);
  if (!img || !f) return;
  ctx.drawImage(img, f.x, f.y, f.w, f.h, (f.ax ?? 0) + dx, (f.ay ?? 0) + dy, f.w, f.h);
}

const iconCache = new Map<string, HTMLCanvasElement>();

/** A still Foldy (body + eyes) at sprite size, for other parts of the app (screensaver). Null until loaded. */
export function foldyStill(body = 'body.closed', eyes = 'eyes.open'): HTMLCanvasElement | null {
  if (!img) {
    void loadSheet().catch(() => {});
    return null;
  }
  const key = body + '|' + eyes;
  let c = iconCache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = SPRITE_W;
    c.height = SPRITE_H;
    const x = c.getContext('2d')!;
    drawLayer(x, body);
    drawLayer(x, eyes);
    iconCache.set(key, c);
  }
  return c;
}
