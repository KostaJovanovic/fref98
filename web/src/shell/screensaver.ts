// Screensaver after inactivity: a JPEG-damaged starfield or flying folders, rendered at low resolution,
// squeezed through our codec at a terrible quality, and faded in/out through Bayer screen-door masks.
import { h } from '../ui/dom';
import { bayerMask } from '../ui/art';
import { ui } from '../ui/scale';
import { settings, reducedMotion } from '../settings';
import { ambientEngine } from '../engine/client';
import { foldyStill } from '../foldy/sheet';

const SAVER_MOUTH = ['body.open.paper', 'body.half.paper', 'body.closed', 'body.half.paper'];

let last = Date.now();
let active: (() => void) | null = null;
let running = 0;
const saverListeners = new Set<() => void>();

/** Is a screensaver on screen (the sky pauses under it)? */
export function saverRunning(): boolean {
  return running > 0;
}

export function onSaver(l: () => void): () => void {
  saverListeners.add(l);
  return () => saverListeners.delete(l);
}

function setRunning(d: number) {
  running = Math.max(0, running + d);
  for (const l of saverListeners) l();
}

export function startScreensaverWatch(app: HTMLElement) {
  const bump = () => {
    last = Date.now();
    if (active) active();
  };
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) addEventListener(ev, bump, { passive: true, capture: true });
  // the key that wakes the screen up is swallowed (98 doesn't type it into the window underneath)
  addEventListener(
    'keydown',
    (e) => {
      const wasUp = running > 0;
      bump();
      if (wasUp) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  setInterval(() => {
    if (active || running || !settings.screensaver.enabled) return;
    if (document.hidden) return;
    if (Date.now() - last >= settings.screensaver.minutes * 60_000) runSaver(app, settings.screensaver.kind);
  }, 5000);
}

/** Display Properties ▸ Screen Saver ▸ Preview: runs the saver now, until the mouse moves or a key is pressed. */
export function previewSaver(app: HTMLElement, kind: 'starfield' | 'folders' = settings.screensaver.kind) {
  if (running) return;
  setTimeout(() => runSaver(app, kind), 300);
}

function runSaver(app: HTMLElement, kind: 'starfield' | 'folders') {
  const S = 4; // UI px per saver pixel
  const W = Math.ceil(ui.w / S);
  const H = Math.ceil(ui.h / S);
  const canvas = h('canvas', { width: W, height: H });
  const el = h('div', { class: 'saver', 'aria-hidden': 'true' }, canvas);
  el.style.setProperty('-webkit-mask-size', '8px 8px');
  el.style.setProperty('mask-size', '8px 8px');
  // its own compositor layer; 98 hides the pointer while the saver runs
  el.style.willChange = 'transform';
  el.style.contain = 'strict';
  el.style.cursor = 'none';
  app.appendChild(el);
  setRunning(1);
  const x = canvas.getContext('2d', { willReadFrequently: true })!;
  const stars = Array.from({ length: 220 }, () => ({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random() }));
  const folders = Array.from({ length: 14 }, () => ({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random() }));
  let fade = 0;
  let closing = false;
  let busy = false;
  let t = 0;
  const setMask = (lvl: number) => {
    const u = `url("${bayerMask(lvl, ui.k)}")`;
    el.style.setProperty('-webkit-mask-image', u);
    el.style.setProperty('mask-image', u);
  };
  setMask(0);
  const frame = async () => {
    t++;
    const raw = new ImageData(W, H);
    const d = raw.data;
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    const plot = (px: number, py: number, r: number, g: number, b: number, size: number) => {
      for (let yy = 0; yy < size; yy++)
        for (let xx = 0; xx < size; xx++) {
          const X = px + xx;
          const Y = py + yy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const i = (Y * W + X) * 4;
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
        }
    };
    if (kind === 'starfield') {
      for (const s of stars) {
        s.z -= 0.012;
        if (s.z <= 0.02) {
          s.x = (Math.random() - 0.5) * 2;
          s.y = (Math.random() - 0.5) * 2;
          s.z = 1;
        }
        const px = Math.round(W / 2 + (s.x / s.z) * W * 0.5);
        const py = Math.round(H / 2 + (s.y / s.z) * H * 0.5);
        // big and bright enough to survive quality 6 (single dim pixels get averaged away to black)
        const c = Math.round(110 + 145 * (1 - s.z));
        plot(px, py, c, c, Math.min(255, c + 40), s.z < 0.3 ? 3 : 2);
      }
      x.putImageData(raw, 0, 0);
    } else {
      x.putImageData(raw, 0, 0);
      folders.sort((a, b) => b.z - a.z);
      for (const f of folders) {
        f.z -= 0.006;
        if (f.z <= 0.05) {
          f.x = (Math.random() - 0.5) * 2;
          f.y = (Math.random() - 0.5) * 2;
          f.z = 1;
        }
        const size = Math.max(4, Math.round(16 / f.z / 4) * 4);
        const px = Math.round(W / 2 + (f.x / f.z) * W * 0.35 - size / 2);
        const py = Math.round(H / 2 + (f.y / f.z) * H * 0.35 - size / 2);
        x.imageSmoothingEnabled = false;
        const still = foldyStill(SAVER_MOUTH[(t >> 2) % 4], 'eyes.happy');
        if (still) x.drawImage(still, px, py, size, size);
      }
    }
    // squeeze it through our codec at an awful quality
    const eng = ambientEngine();
    if (eng.has('encode_rgba') && eng.has('decode') && !busy) {
      busy = true;
      try {
        const img = x.getImageData(0, 0, W, H);
        const jpg = await eng.encodeRgba(W, H, img.data, { quality: 6 + (t % 40 < 20 ? 0 : 4) }).promise;
        const dd = await eng.decode(jpg, {}).promise;
        if (dd.width === W && dd.height === H) x.putImageData(new ImageData(new Uint8ClampedArray(dd.rgba.buffer as ArrayBuffer), W, H), 0, 0);
      } catch {
        /* the clean frame is fine too */
      }
      busy = false;
    }
    if (closing) {
      fade -= 8;
      if (fade <= 0) {
        clearInterval(timer);
        el.remove();
        setRunning(-1);
        return;
      }
    } else if (fade < 64) fade = Math.min(64, fade + (reducedMotion() ? 64 : 6));
    setMask(fade);
  };
  const timer = setInterval(() => void frame(), reducedMotion() ? 500 : 100);
  const startedAt = Date.now();
  active = () => {
    if (closing || Date.now() - startedAt < 900) return;
    closing = true;
    if (reducedMotion()) fade = 1;
    active = null;
    last = Date.now();
  };
}
