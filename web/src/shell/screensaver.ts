// Screensaver after inactivity: one of the savers in savers.ts, rendered at low resolution, (most of them)
// squeezed through our codec at a terrible quality, drawn in the desktop's colour depth, and faded in/out
// through Bayer screen-door masks.
import { h } from '../ui/dom';
import { bayerMask } from '../ui/art';
import { ui } from '../ui/scale';
import { settings, reducedMotion, type SaverKind } from '../settings';
import { ambientEngine } from '../engine/client';
import { ditherDepth } from '../ui/palette';
import { pipeline } from '../pipeline';
import { makeSaver, type SaverOpts } from './savers';
import * as bus from '../bus';

/** What the savers need from the engine and the editor (the corrupting photo uses the current result). */
export function saverOpts(): SaverOpts {
  const eng = ambientEngine();
  return {
    speed: settings.screensaver.speed,
    text: settings.screensaver.text,
    photo: () => pipeline.last?.output ?? null,
    decode: async (j) => (eng.has('decode') ? eng.decode(j, {}).promise.catch(() => null) : null),
    encode: async (w, hh, rgba) => (eng.has('encode_rgba') ? eng.encodeRgba(w, hh, rgba, { quality: 75 }).promise.catch(() => null) : null),
  };
}

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
  // long jobs (a batch export, carving a card) and playing media keep the screen awake, as in 98
  bus.on('long-start', () => void awake++);
  bus.on('long-end', () => void (awake = Math.max(0, awake - 1)));
  setInterval(() => {
    if (active || running || !settings.screensaver.enabled) return;
    if (document.hidden) return;
    if (awake > 0) {
      last = Date.now();
      return;
    }
    if (Date.now() - last >= settings.screensaver.minutes * 60_000) runSaver(app, settings.screensaver.kind);
  }, 5000);
}

let awake = 0;

/** Keeps the screen saver away until the returned function is called (video playing, live camera). */
export function keepAwake(): () => void {
  awake++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    awake = Math.max(0, awake - 1);
    last = Date.now();
  };
}

/** Display Properties ▸ Screen Saver ▸ Preview: runs the saver now, until the mouse moves or a key is pressed. */
export function previewSaver(app: HTMLElement, kind: SaverKind = settings.screensaver.kind) {
  if (running) return;
  setTimeout(() => runSaver(app, kind), 300);
}

function runSaver(app: HTMLElement, kind: SaverKind) {
  const S = 4; // UI px per saver pixel
  const W = Math.ceil(ui.w / S);
  const H = Math.ceil(ui.h / S);
  const canvas = h('canvas', { width: W, height: H });
  // exactly S UI px per saver pixel (the last row and column run past the edge; .saver clips them)
  canvas.style.width = W * S + 'px';
  canvas.style.height = H * S + 'px';
  const el = h('div', { class: 'saver', 'aria-hidden': 'true' }, canvas);
  el.style.setProperty('-webkit-mask-size', '8px 8px');
  el.style.setProperty('mask-size', '8px 8px');
  // its own compositor layer; 98 hides the pointer while the saver runs
  el.style.willChange = 'transform';
  el.style.contain = 'strict';
  el.style.cursor = 'none';
  app.appendChild(el);
  setRunning(1);
  const shown = canvas.getContext('2d')!;
  // frames are made off screen and shown when finished (no clean frame flashes while the codec works)
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const x = off.getContext('2d', { willReadFrequently: true })!;
  const saver = makeSaver(kind, W, H, saverOpts());
  let fade = 0;
  let closing = false;
  let done = false;
  let busy = false;
  let t = 0;
  const setMask = (lvl: number) => {
    const u = `url("${bayerMask(lvl, ui.k)}")`;
    el.style.setProperty('-webkit-mask-image', u);
    el.style.setProperty('mask-image', u);
  };
  setMask(0);
  /** The fade, once per tick (synchronous, so a frame that finishes late can't run the teardown again). */
  const fadeStep = () => {
    if (closing) {
      fade -= 8;
      if (fade <= 0) {
        done = true;
        clearInterval(timer);
        el.remove();
        setRunning(-1);
        return;
      }
    } else if (fade < 64) fade = Math.min(64, fade + (reducedMotion() ? 64 : 6));
    setMask(fade);
  };
  const frame = async () => {
    if (done) return;
    t++;
    fadeStep();
    // a frame still being made (an engine round trip) makes this tick only move the fade
    if (!busy && !done) {
      busy = true;
      try {
        await saver.frame(x);
        // squeeze it through our codec at an awful quality
        const eng = ambientEngine();
        if (saver.codec && eng.has('encode_rgba') && eng.has('decode')) {
          const img = x.getImageData(0, 0, W, H);
          const jpg = await eng.encodeRgba(W, H, img.data, { quality: 6 + (t % 40 < 20 ? 0 : 4) }).promise;
          const dd = await eng.decode(jpg, {}).promise;
          if (dd.width === W && dd.height === H) x.putImageData(new ImageData(new Uint8ClampedArray(dd.rgba.buffer as ArrayBuffer), W, H), 0, 0);
        }
        // the desktop's colour depth (Display ▸ Settings ▸ Colors)
        if (settings.colorDepth !== 'true') {
          const img = x.getImageData(0, 0, W, H);
          ditherDepth(img.data, W, H, settings.colorDepth, 40);
          x.putImageData(img, 0, 0);
        }
      } catch {
        /* the clean frame is fine too */
      }
      busy = false;
      if (!done) shown.drawImage(off, 0, 0);
    }
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
