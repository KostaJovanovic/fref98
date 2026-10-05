// The desktop wallpaper. "Sky" is rendered in the ambient worker at ~8 fps in whole-pixel steps, encoded as a
// low-quality JPEG by OUR codec, decoded by our decoder, then Bayer-dithered. During long operations it gets
// more damaged and then recovers. Stops with prefers-reduced-motion.
import { ambientEngine, engine } from '../engine/client';
import { settings, onSettings, reducedMotion } from '../settings';
import { ui, onScale } from '../ui/scale';
import { onWm, windows } from '../ui/wm';
import { onSaver, saverRunning } from './screensaver';
import { h } from '../ui/dom';
import { tilePattern } from '../ui/art';
import { ditherBayer } from '../ui/palette';
import { pipeline } from '../pipeline';
import { wallpaperImage, hasWallpaperImage } from './wallpaper';
import * as bus from '../bus';

const PX = 2; // UI pixels per sky pixel

export class Sky {
  el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private t = 0;
  private damage = 0;
  private busySince = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private photoKey = '';
  private longOps = 0;

  /** Not drawing: tab hidden, a maximised window covers the desktop, or the screensaver runs. */
  private paused = false;
  private ctx: CanvasRenderingContext2D | null = null;

  constructor(private host: HTMLElement) {
    this.canvas = h('canvas', { class: 'wall', 'aria-hidden': 'true' });
    this.el = h('div', { class: 'wall-host', 'aria-hidden': 'true' }, this.canvas);
    host.prepend(this.el);
    // its own compositor layer: a new frame re-uploads this layer only, nothing else on the page repaints
    for (const s of [this.el.style, this.canvas.style]) {
      s.willChange = 'transform';
      s.contain = 'strict';
    }
    onScale(() => this.restart());
    onWm(() => this.updatePause());
    onSaver(() => this.updatePause());
    document.addEventListener('visibilitychange', () => this.updatePause());
    onSettings((_s, ch) => {
      if (ch.some((c) => c === 'wallpaper' || c === 'cloudSpeed' || c === 'solidColor' || c === 'reducedMotion')) this.restart();
    });
    const eng = engine();
    eng.onBusy(() => this.poke());
    bus.on('long-start', () => {
      this.longOps++;
      this.poke();
    });
    bus.on('long-end', () => (this.longOps = Math.max(0, this.longOps - 1)));
    pipeline.on((_r, phase) => {
      // the live "my broken photo" wallpaper follows the editor; a "Set as Wallpaper" picture does not
      if (phase === 'done' && settings.wallpaper === 'photo' && !hasWallpaperImage()) this.restart();
    });
    this.restart();
    this.updatePause();
  }

  private size() {
    const w = this.host.clientWidth || ui.w;
    const hh = this.host.clientHeight || ui.h;
    return { w: Math.max(16, Math.ceil(w / PX)), h: Math.max(16, Math.ceil(hh / PX)), cw: w, ch: hh };
  }

  restart() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const mode = settings.wallpaper;
    if (mode !== 'photo') this.photoKey = '';
    this.el.className = 'wall-host';
    this.el.style.background = '';
    // sized by the desktop (strict containment needs a definite box)
    this.el.style.position = 'absolute';
    this.el.style.inset = '0';
    this.el.style.overflow = 'hidden';
    this.canvas.style.display = '';
    if (mode === 'solid') {
      this.canvas.style.display = 'none';
      this.el.style.background = settings.solidColor;
      return;
    }
    if (mode === 'tiles') {
      this.canvas.style.display = 'none';
      this.el.style.backgroundImage = `url("${tilePattern()}")`;
      this.el.style.backgroundSize = '32px 32px';
      return;
    }
    this.el.style.backgroundImage = '';
    if (mode === 'photo') {
      void this.drawPhoto();
      return;
    }
    this.tick();
  }

  private async drawPhoto() {
    const snap = await wallpaperImage();
    if (settings.wallpaper !== 'photo') return;
    const r = pipeline.last;
    const { w, h: hh, cw, ch } = this.size();
    if (!snap && !r?.after) {
      this.tick();
      return;
    }
    const key = (snap ? 'set' + snap.version : 'live' + r!.output.length) + ':' + w + 'x' + hh;
    if (key === this.photoKey) return;
    this.photoKey = key;
    let src: { width: number; height: number; img: CanvasImageSource };
    if (snap) src = { width: snap.w, height: snap.h, img: snap.src };
    else {
      const a = r!.after!;
      const c = document.createElement('canvas');
      c.width = a.width;
      c.height = a.height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(a.rgba), a.width, a.height), 0, 0);
      src = { width: a.width, height: a.height, img: c };
    }
    this.canvas.width = w;
    this.canvas.height = hh;
    this.canvas.style.width = w * PX + 'px';
    this.canvas.style.height = hh * PX + 'px';
    void cw;
    void ch;
    const x = this.context();
    const s = Math.max(w / src.width, hh / src.height);
    x.imageSmoothingEnabled = true;
    x.drawImage(src.img, (w - src.width * s) / 2, (hh - src.height * s) / 2, src.width * s, src.height * s);
    const d = x.getImageData(0, 0, w, hh);
    ditherBayer(d.data, w, hh, 40);
    x.putImageData(d, 0, 0);
  }

  private context(): CanvasRenderingContext2D {
    if (!this.ctx) this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    return this.ctx;
  }

  /** A maximised window (on phones: any open window) hides the whole desktop. */
  private covered(): boolean {
    return windows().some((w) => !w.minimized && (w.maximized || ui.phone));
  }

  private updatePause() {
    const p = document.hidden || saverRunning() || this.covered();
    if (p === this.paused) return;
    this.paused = p;
    if (p) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    } else if (settings.wallpaper === 'sky') this.tick();
  }

  private tick() {
    this.timer = null;
    if (settings.wallpaper !== 'sky' || this.paused) return;
    const still = reducedMotion() || settings.cloudSpeed === 0;
    // damage grows while the main engine is busy for a while, then recovers
    const isBusy = engine().busy > 0 || pipeline.running || this.longOps > 0;
    if (isBusy && !this.busySince) this.busySince = performance.now();
    if (!isBusy) this.busySince = 0;
    const busyFor = this.busySince ? performance.now() - this.busySince : 0;
    const target = busyFor > 1500 ? Math.min(1, (busyFor - 1500) / 6000) : 0;
    this.damage += (target - this.damage) * (target > this.damage ? 0.25 : 0.08);
    if (this.damage < 0.01) this.damage = 0;
    if (!this.inflight) {
      this.inflight = true;
      const { w, h: hh } = this.size();
      const quality = Math.round(34 - this.damage * 28);
      const job = ambientEngine().call<{ rgba: Uint8ClampedArray; via: string }>('sky', {
        width: w,
        height: hh,
        t: this.t,
        speed: settings.cloudSpeed,
        quality,
        damage: this.damage > 0.05 ? this.damage * 0.0004 : 0,
        seed: this.t,
      });
      job.promise
        .then((r) => {
          if (this.canvas.width !== w || this.canvas.height !== hh) {
            this.canvas.width = w;
            this.canvas.height = hh;
          }
          this.canvas.style.width = w * PX + 'px';
          this.canvas.style.height = hh * PX + 'px';
          this.context().putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer as ArrayBuffer), w, hh), 0, 0);
        })
        .catch(() => {})
        .finally(() => (this.inflight = false));
    }
    if (!still || this.damage > 0 || this.busySince) {
      if (!still) this.t++;
      this.timer = setTimeout(() => this.tick(), 125);
    }
  }

  /** Called when the main engine goes busy/idle while the sky is still (reduced motion). */
  poke() {
    if (!this.timer && settings.wallpaper === 'sky') this.tick();
  }
}
