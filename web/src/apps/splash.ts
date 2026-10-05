// The startup splash, boxed-software style: name, version, "Registered to", a 98 block loading bar. It stays while
// the engine (WASM) loads, at least ~1 s; a click skips it. Everything is drawn here (no network, no images).
// logoArt() is also the banner of the About box.
import { h, setText } from '../ui/dom';
import { progressBar } from '../ui/controls';
import { drawText } from '../ui/pixeltext';
import { bayerOn } from '../ui/palette';
import { APP_NAME } from '../brand';
import { VERSION } from '../version';
import { reducedMotion } from '../settings';
import { loadSheet, foldyStill } from '../foldy/sheet';

const GOLD: [number, number, number][] = [
  [255, 244, 168],
  [252, 220, 96],
  [236, 184, 40],
  [196, 140, 16],
];

/** A Bayer-dithered gradient through `pal` from y0 to y1 (ordered dither between neighbouring colours). */
function ditherFill(x: CanvasRenderingContext2D, w: number, hgt: number, pal: [number, number, number][], y0: number, y1: number, mask?: Uint8ClampedArray, horizontal = false) {
  const img = x.getImageData(0, 0, w, hgt);
  const d = img.data;
  const n = pal.length - 1;
  for (let y = 0; y < hgt; y++)
    for (let xx = 0; xx < w; xx++) {
      const i = (y * w + xx) * 4;
      if (mask && !mask[i + 3]) continue;
      const pos = horizontal ? xx : y;
      const t = Math.min(1, Math.max(0, (pos - y0) / Math.max(1, y1 - y0))) * n;
      const lo = Math.floor(t);
      const c = pal[Math.min(n, bayerOn(xx, y, Math.round((t - lo) * 64)) ? lo + 1 : lo)];
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  x.putImageData(img, 0, 0);
}

/** Gold, dithered, pixel-font text with a hard black drop shadow. */
function goldText(x: CanvasRenderingContext2D, s: string, px: number, py: number, scale: number, bold: boolean) {
  const W = x.canvas.width;
  const H = x.canvas.height;
  const m = document.createElement('canvas');
  m.width = W;
  m.height = H;
  const mx = m.getContext('2d', { willReadFrequently: true })!;
  drawText(mx, s, px, py, '#fff', { scale, bold });
  const mask = mx.getImageData(0, 0, W, H).data;
  drawText(x, s, px + scale, py + scale, '#000', { scale, bold });
  const g = document.createElement('canvas');
  g.width = W;
  g.height = H;
  const gx = g.getContext('2d', { willReadFrequently: true })!;
  ditherFill(gx, W, H, GOLD, py + 2 * scale, py + 12 * scale, mask);
  x.drawImage(g, 0, 0);
}

/** The banner: navy-to-blue dithered sky, the name in gold, Foldy on the right. Drawn at 1:1 (CSS scales it
 *  by whole device pixels: image-rendering: pixelated). */
export function logoArt(w = 412, hgt = 132, opts: { tagline?: string } = {}): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  c.className = 'logo-art';
  const x = c.getContext('2d', { willReadFrequently: true })!;
  ditherFill(x, w, hgt, [[0, 0, 128], [8, 36, 160], [16, 132, 208]], 0, w, undefined, true);
  // a row of 8×8 "damaged blocks" along the bottom: the product, in one line
  for (let bx = 0; bx < w; bx += 8) {
    const k = (bx * 7919) % 13;
    if (k < 4) {
      x.fillStyle = ['#000080', '#808080', '#008080', '#c0c0c0'][k];
      x.fillRect(bx, hgt - 8 - (k === 1 ? 8 : 0), 8, 8);
    }
  }
  const name = APP_NAME.replace(/ 98 Gold$/, '');
  drawText(x, name, 14, 14, '#000', { scale: 2, bold: true });
  drawText(x, name, 12, 12, '#fff', { scale: 2, bold: true });
  goldText(x, '98 Gold', 12, 40, 4, true);
  if (opts.tagline) drawText(x, opts.tagline, 12, hgt - 30, '#fff');
  // Foldy (happy, paper in the folder) at 2×, once the sheet is there
  const put = () => {
    const f = foldyStill('body.quarter.paper', 'eyes.happy');
    if (!f) return;
    x.imageSmoothingEnabled = false;
    x.drawImage(f, w - f.width * 2 - 4, Math.max(0, hgt - f.height * 2 - 6), f.width * 2, f.height * 2);
  };
  if (foldyStill()) put();
  else void loadSheet().then(put, () => {});
  return c;
}

/** Shows the splash until `ready` settles and at least `minMs` passed (or the user clicks). Resolves when gone. */
export function showSplash(root: HTMLElement, ready: Promise<unknown>, minMs = 1000): Promise<void> {
  const bar = progressBar(0);
  const status = h('div', { class: 'splash-status' }, 'Loading the JPEG engine…');
  const box = h(
    'div',
    { class: 'splash', role: 'dialog', 'aria-label': `${APP_NAME} is starting` },
    logoArt(412, 132, { tagline: 'Real JPEG damage, made on your own computer.' }),
    h(
      'div',
      { class: 'splash-info' },
      h('div', { class: 'splash-row' }, h('span', null, `Version ${VERSION}`), h('span', { class: 'splash-dim' }, 'Click to skip')),
      h('div', null, 'Registered to: Unregistered User'),
      status,
      bar,
    ),
  );
  const veil = h('div', { class: 'splash-veil' }, box);
  root.appendChild(veil);
  const t0 = performance.now();
  let frac = 0;
  let done = false;
  let loaded = false;
  return new Promise<void>((resolve) => {
    const close = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      veil.remove();
      resolve();
    };
    veil.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      close();
    });
    addEventListener('keydown', function esc(e) {
      if (done) return removeEventListener('keydown', esc, true);
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        removeEventListener('keydown', esc, true);
        close();
      }
    }, true);
    // the bar creeps (in whole blocks) towards 90 % while loading, then fills
    const timer = setInterval(() => {
      if (loaded) return;
      frac += (0.9 - frac) * (reducedMotion() ? 0.5 : 0.12);
      bar.set(frac);
    }, 120);
    const finish = (ok: boolean) => {
      loaded = true;
      bar.set(1);
      setText(status, ok ?'Ready.' : 'The engine could not load. Some tools will be unavailable.');
      const wait = Math.max(ok ? 150 : 1500, minMs - (performance.now() - t0));
      setTimeout(close, wait);
    };
    ready.then(() => finish(true), () => finish(false));
  });
}
