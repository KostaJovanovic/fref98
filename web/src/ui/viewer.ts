// The editor preview. Shows TRUE decoded pixels (never dithered), nearest-neighbour at integer zoom, drawn
// in device pixels so 1:1 really is one image pixel per screen pixel. Overlays (grid, heatmap, highlights)
// are drawn on top with screen-door patterns instead of alpha. Compare panes are all drawn into the main
// (After) image's box (see compare.ts), so they line up whatever their pixel sizes. A new result only redraws
// the one canvas: no elements are created or replaced per frame.
import { h, clamp } from './dom';
import { ui, onScale } from './scale';
import { heatColor } from './art';
import { compareRects, boxToImage, fitZoom, ZOOMS, type Box } from './compare';
import type { DecodedImage } from '../engine/types';

export interface Pane {
  label: string;
  img: HTMLCanvasElement | null;
  w: number;
  h: number;
  error?: string;
}

export interface Heat {
  bw: number;
  bh: number;
  block: number; // image px per block
  values: Float32Array;
}

export interface MaskState {
  w: number; // in MCU units
  h: number;
  unit: number; // image px per MCU
  data: number[];
}


export function toCanvas(d: DecodedImage): HTMLCanvasElement {
  return paintCanvas(document.createElement('canvas'), d);
}

/** Puts a decoded image into an existing (off-screen) canvas, resizing it only when the size changed. */
export function paintCanvas(c: HTMLCanvasElement, d: DecodedImage): HTMLCanvasElement {
  if (c.width !== d.width || c.height !== d.height) {
    c.width = d.width;
    c.height = d.height;
  }
  const x = c.getContext('2d')!;
  x.putImageData(new ImageData(new Uint8ClampedArray(d.rgba.buffer as ArrayBuffer, d.rgba.byteOffset, d.rgba.byteLength), d.width, d.height), 0, 0);
  return c;
}

export class Viewer {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  labels: HTMLElement;
  panes: Pane[] = [];
  mode: 'single' | 'split' | 'three' = 'single';
  zoom = 1;
  fit = true;
  cx = 0;
  cy = 0;
  split = 0.5;
  grid: 0 | 8 | 16 = 0;
  heat: Heat | null = null;
  highlights: { x: number; y: number; w: number; h: number }[] = [];
  mask: MaskState | null = null;
  maskValue = 255;
  /** Eraser for touch screens (no Alt key or right button there). */
  maskErase = false;
  onPick: ((x: number, y: number, pane: number) => void) | null = null;
  onZoom: ((z: number, fit: boolean) => void) | null = null;
  private lastZoom = 0;
  onMask: ((m: MaskState) => void) | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private raf = 0;
  private heatCanvas: HTMLCanvasElement | null = null;
  private labelKey = '';

  constructor() {
    this.canvas = h('canvas', { class: 'view', 'aria-hidden': 'true' });
    this.labels = h('div');
    this.el = h('div', { class: 'viewer', role: 'img', tabIndex: 0, 'aria-label': 'Photo preview. Arrow keys pan, plus and minus zoom, 0 fits, 1 shows actual pixels.' }, this.canvas, this.labels);
    this.bind();
    onScale(() => this.render());
    new ResizeObserver(() => this.render()).observe(this.el);
  }

  setPanes(panes: Pane[], mode: Viewer['mode']) {
    const firstImage = !this.panes.some((p) => p.img) && panes.some((p) => p.img);
    const old = this.main();
    this.panes = panes;
    this.mode = mode;
    const p = this.main();
    const sizeChanged = !!p && !!old && (p.w !== old.w || p.h !== old.h);
    if (p && (firstImage || sizeChanged)) {
      // (cx, cy) is a point of the main pane
      this.cx = p.w / 2;
      this.cy = p.h / 2;
      if (firstImage) this.fit = true;
    }
    this.renderLabels();
    this.render();
  }

  setHeat(heat: Heat | null) {
    this.heat = heat;
    this.heatCanvas = null;
    if (heat) {
      const c = document.createElement('canvas');
      c.width = heat.bw;
      c.height = heat.bh;
      const x = c.getContext('2d')!;
      const d = x.createImageData(heat.bw, heat.bh);
      let max = 0;
      for (const v of heat.values) if (v > max) max = v;
      for (let i = 0; i < heat.bw * heat.bh; i++) {
        const t = max > 0 ? Math.sqrt(heat.values[i] / max) : 0;
        const [r, g, b] = heatColor(t);
        d.data[i * 4] = r;
        d.data[i * 4 + 1] = g;
        d.data[i * 4 + 2] = b;
        d.data[i * 4 + 3] = 255;
      }
      x.putImageData(d, 0, 0);
      this.heatCanvas = c;
    }
    this.render();
  }

  private paneRects(W: number, H: number): { x: number; y: number; w: number; h: number }[] {
    if (this.mode === 'three') {
      const n = Math.max(1, this.panes.length);
      const k = ui.k;
      const pw = Math.floor(W / n);
      return this.panes.map((_, i) => ({ x: i * pw + (i ? k : 0), y: 0, w: pw - (i ? k : 0), h: H }));
    }
    return [{ x: 0, y: 0, w: W, h: H }];
  }

  /** The pane whose geometry everything follows: After in split mode (the last pane), "Ours" in three-way. */
  private main(): Pane | undefined {
    if (this.mode === 'three') return this.panes[0];
    return this.panes[this.panes.length - 1] ?? this.panes[0];
  }

  effectiveZoom(): number {
    const p = this.main();
    if (!p || !this.fit) return this.zoom;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const r = this.paneRects(W, H)[0];
    // every pane is drawn into the main pane's box, so fitting the main pane fits them all
    return fitZoom(Math.min((r.w - 8 * ui.k) / Math.max(1, p.w), (r.h - 8 * ui.k) / Math.max(1, p.h)));
  }

  /** Device-pixel box a pane is drawn into: the main pane's box (at the same place in its pane rectangle), so
   *  differently sized results are stretched over the same area and line up. */
  private paneBox(p: Pane, rc: { x: number; y: number; w: number; h: number }, z: number): Box {
    const m = this.main() ?? p;
    const r = compareRects(p.w, p.h, m.w, m.h, { x: rc.x, y: rc.y, w: rc.w, h: rc.h, zoom: z, cx: this.cx, cy: this.cy });
    return p === m ? r.after : r.before;
  }

  /** Each pane's image box in CSS px relative to the viewport (for tests and the right-click menu). */
  paneScreenRects(): { x: number; y: number; w: number; h: number }[] {
    const r = this.canvas.getBoundingClientRect();
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!W || !H) return [];
    const f = r.width / W;
    const rects = this.paneRects(W, H);
    const z = this.effectiveZoom();
    return this.panes.map((p, i) => {
      const b = this.paneBox(p, rects[this.mode === 'three' ? i : 0] ?? rects[0], z);
      return { x: r.left + b.x * f, y: r.top + b.y * f, w: b.w * f, h: b.h * f };
    });
  }

  setZoom(z: number, fit = false, anchor?: { x: number; y: number }) {
    const old = this.effectiveZoom();
    if (anchor && !fit) {
      // keep the image point under the anchor fixed
      const W = this.canvas.width;
      const H = this.canvas.height;
      const ix = this.cx + (anchor.x - W / 2) / old;
      const iy = this.cy + (anchor.y - H / 2) / old;
      this.cx = ix - (anchor.x - W / 2) / z;
      this.cy = iy - (anchor.y - H / 2) / z;
    }
    this.zoom = z;
    this.fit = fit;
    if (fit) {
      const p = this.main();
      if (p) {
        this.cx = p.w / 2;
        this.cy = p.h / 2;
      }
    }
    this.onZoom?.(this.effectiveZoom(), fit);
    this.render();
  }

  stepZoom(dir: 1 | -1, anchor?: { x: number; y: number }) {
    const cur = this.effectiveZoom();
    let next = cur;
    if (dir > 0) next = ZOOMS.find((z) => z > cur + 1e-6) ?? cur;
    else next = [...ZOOMS].reverse().find((z) => z < cur - 1e-6) ?? cur;
    this.setZoom(next, false, anchor);
  }

  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw() {
    const k = ui.k;
    const cw = this.el.clientWidth;
    const ch = this.el.clientHeight;
    if (!cw || !ch) return;
    const W = cw * k;
    const H = ch * k;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.canvas.style.width = cw + 'px';
      this.canvas.style.height = ch + 'px';
    }
    // fit zoom depends on image and canvas size, so report it whenever it moves
    const ez = this.effectiveZoom();
    if (ez !== this.lastZoom) {
      this.lastZoom = ez;
      this.onZoom?.(ez, this.fit);
    }
    const x = this.canvas.getContext('2d')!;
    x.clearRect(0, 0, W, H);
    const z = this.effectiveZoom();
    const rects = this.paneRects(W, H);
    const drawPane = (p: Pane, r: { x: number; y: number; w: number; h: number }, clip?: { x0: number; x1: number }) => {
      x.save();
      x.beginPath();
      const x0 = clip ? Math.max(r.x, clip.x0) : r.x;
      const x1 = clip ? Math.min(r.x + r.w, clip.x1) : r.x + r.w;
      x.rect(x0, r.y, x1 - x0, r.h);
      x.clip();
      const b = this.paneBox(p, r, z);
      if (p.img) {
        // never smoothed: the artifacts are the point (zooming out decimates, see ZOOMS)
        x.imageSmoothingEnabled = false;
        x.drawImage(p.img, 0, 0, p.img.width, p.img.height, b.x, b.y, b.w, b.h);
        this.drawOverlays(x, b, p);
      }
      x.restore();
    };
    if (this.mode === 'split' && this.panes.length >= 2) {
      const sx = Math.round(W * this.split);
      drawPane(this.panes[0], rects[0], { x0: 0, x1: sx });
      drawPane(this.panes[1], rects[0], { x0: sx, x1: W });
      // divider: 1 UI px white line with black edges and a grab handle
      x.fillStyle = '#000';
      x.fillRect(sx - k, 0, k * 3, H);
      x.fillStyle = '#fff';
      x.fillRect(sx, 0, k, H);
      const hy = Math.round(H / 2 - 12 * k);
      x.fillStyle = '#000';
      x.fillRect(sx - 5 * k, hy, 11 * k, 24 * k);
      // (98 button face and shadow)
      x.fillStyle = '#c0c0c0';
      x.fillRect(sx - 4 * k, hy + k, 9 * k, 22 * k);
      x.fillStyle = '#808080';
      for (let i = 0; i < 4; i++) x.fillRect(sx - 2 * k, hy + (6 + i * 3) * k, 5 * k, k);
    } else if (this.mode === 'three') {
      this.panes.forEach((p, i) => {
        drawPane(p, rects[i]);
        if (i) {
          x.fillStyle = '#000';
          x.fillRect(rects[i].x - k, 0, k, H);
        }
      });
    } else if (this.panes.length) {
      drawPane(this.main()!, rects[0]);
    }
  }

  private drawOverlays(x: CanvasRenderingContext2D, b: Box, p: Pane) {
    const k = ui.k;
    const ox = b.x;
    const oy = b.y;
    const zx = b.sx;
    const zy = b.sy;
    // heatmap (screen-door: only every other device-pixel cell is painted)
    // the heatmap belongs to the result, so it is only drawn over the main (After) pane
    if (this.heat && this.heatCanvas && p === this.main()) {
      const hw = this.heat.bw * this.heat.block * zx;
      const hh = this.heat.bh * this.heat.block * zy;
      const off = document.createElement('canvas');
      const vw = this.canvas.width;
      const vh = this.canvas.height;
      off.width = vw;
      off.height = vh;
      const o = off.getContext('2d')!;
      o.imageSmoothingEnabled = false;
      o.drawImage(this.heatCanvas, ox, oy, hw, hh);
      o.globalCompositeOperation = 'destination-in';
      o.fillStyle = checkerPattern(o, k);
      o.fillRect(0, 0, vw, vh);
      x.drawImage(off, 0, 0);
    }
    // block grid
    if (this.grid) {
      const stepX = this.grid * zx;
      const stepY = this.grid * zy;
      if (Math.min(stepX, stepY) >= 4) {
        const x0 = Math.max(0, Math.floor(-ox / stepX));
        const x1 = Math.min(Math.ceil(p.w / this.grid), Math.ceil((this.canvas.width - ox) / stepX));
        const y0 = Math.max(0, Math.floor(-oy / stepY));
        const y1 = Math.min(Math.ceil(p.h / this.grid), Math.ceil((this.canvas.height - oy) / stepY));
        const yTop = Math.max(oy, 0);
        const yBot = Math.min(oy + b.h, this.canvas.height);
        const xL = Math.max(ox, 0);
        const xR = Math.min(ox + b.w, this.canvas.width);
        for (let gx = x0; gx <= x1; gx++) {
          const px = Math.round(ox + gx * stepX);
          for (let yy = yTop; yy < yBot; yy += 2 * k) {
            x.fillStyle = ((yy / k) | 0) % 4 < 2 ? '#000' : '#fff';
            x.fillRect(px, yy, k, Math.min(2 * k, yBot - yy));
          }
        }
        for (let gy = y0; gy <= y1; gy++) {
          const py = Math.round(oy + gy * stepY);
          for (let xx = xL; xx < xR; xx += 2 * k) {
            x.fillStyle = ((xx / k) | 0) % 4 < 2 ? '#000' : '#fff';
            x.fillRect(xx, py, Math.min(2 * k, xR - xx), k);
          }
        }
      }
    }
    // mask cells
    if (this.mask) {
      const m = this.mask;
      const ux = m.unit * zx;
      const uy = m.unit * zy;
      x.fillStyle = checkerPattern(x, k, '#ff2040');
      for (let my = 0; my < m.h; my++)
        for (let mx = 0; mx < m.w; mx++) if (m.data[my * m.w + mx] > 0) x.fillRect(Math.round(ox + mx * ux), Math.round(oy + my * uy), Math.ceil(ux), Math.ceil(uy));
    }
    // highlighted blocks (hex selection / picked block)
    for (const r of this.highlights) {
      const rx = Math.round(ox + r.x * zx);
      const ry = Math.round(oy + r.y * zy);
      const rw = Math.max(k, Math.round(r.w * zx));
      const rh = Math.max(k, Math.round(r.h * zy));
      x.fillStyle = '#000';
      x.fillRect(rx - k, ry - k, rw + 2 * k, k);
      x.fillRect(rx - k, ry + rh, rw + 2 * k, k);
      x.fillRect(rx - k, ry, k, rh);
      x.fillRect(rx + rw, ry, k, rh);
      x.fillStyle = '#ffd400';
      x.fillRect(rx - 2 * k, ry - 2 * k, rw + 4 * k, k);
      x.fillRect(rx - 2 * k, ry + rh + k, rw + 4 * k, k);
      x.fillRect(rx - 2 * k, ry - k, k, rh + 2 * k);
      x.fillRect(rx + rw + k, ry - k, k, rh + 2 * k);
    }
  }

  private renderLabels() {
    // a live preview sets new panes many times a second: touch the DOM only when the labels really change
    const key = this.mode + '\n' + this.panes.map((p) => p.label + '\t' + (p.error ?? '')).join('\n');
    if (key === this.labelKey) return;
    this.labelKey = key;
    this.labels.replaceChildren();
    if (this.mode === 'split' && this.panes.length >= 2) {
      this.labels.append(h('div', { class: 'vlabel l' }, this.panes[0].label), h('div', { class: 'vlabel r' }, this.panes[1].label));
      const err = this.panes[1].error;
      if (err) this.labels.append(h('div', { class: 'vlabel r err' }, err));
    } else if (this.mode === 'three') {
      const n = this.panes.length;
      this.panes.forEach((p, i) => {
        const l = h('div', { class: 'vlabel' }, p.label);
        l.style.left = `calc(${(100 * i) / n}% + 4px)`;
        this.labels.append(l);
        if (p.error) {
          const e = h('div', { class: 'vlabel' }, p.error);
          e.style.left = `calc(${(100 * i) / n}% + 4px)`;
          e.style.top = '28px';
          e.style.background = '#a00000';
          e.style.maxWidth = `calc(${100 / n}% - 8px)`;
          e.style.whiteSpace = 'normal';
          this.labels.append(e);
        }
      });
    } else if (this.panes[0]?.error) {
      this.labels.append(h('div', { class: 'vlabel l err' }, this.panes[0].error));
    }
  }

  /** Image coordinates under a pointer event (for the pane it falls in). */
  imagePoint(e: { clientX: number; clientY: number }): { x: number; y: number; pane: number } {
    const r = this.canvas.getBoundingClientRect();
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dx = ((e.clientX - r.left) / r.width) * W;
    const dy = ((e.clientY - r.top) / r.height) * H;
    const rects = this.paneRects(W, H);
    let pane = 0;
    rects.forEach((rc, i) => {
      if (dx >= rc.x && dx < rc.x + rc.w) pane = i;
    });
    const rc = rects[pane];
    const z = this.effectiveZoom();
    if (this.mode === 'split' && this.panes.length >= 2) pane = dx < W * this.split ? 0 : 1;
    const p = this.panes[pane] ?? this.main();
    if (!p) return { x: dx / z, y: dy / z, pane };
    // each pane is stretched into the main pane's box: map back with that pane's own scale
    const q = boxToImage(this.paneBox(p, rc, z), dx, dy);
    return { x: q.x, y: q.y, pane };
  }

  private devicePoint(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.canvas.width, y: ((e.clientY - r.top) / r.height) * this.canvas.height };
  }

  private bind() {
    const c = this.canvas;
    let mode: 'pan' | 'split' | 'mask' | 'pinch' | null = null;
    let start = { x: 0, y: 0, cx: 0, cy: 0 };
    let moved = 0;
    let pinch0 = 0;
    let zoom0 = 1;
    c.addEventListener('pointerdown', (e) => {
      // the right button opens the picture's menu (or erases while painting a mask); it never pans or picks
      if (e.button !== 0 && !(this.mask && e.button === 2)) return;
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone (or synthetic): dragging still works while it stays over the canvas */
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const d = this.devicePoint(e);
      moved = 0;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
        zoom0 = this.effectiveZoom();
        mode = 'pinch';
        return;
      }
      if (this.mask && (e.button === 0 || e.button === 2)) {
        mode = 'mask';
        this.paintMask(e, e.altKey || e.button === 2 || this.maskErase ? 0 : this.maskValue);
        return;
      }
      if (this.mode === 'split' && Math.abs(d.x - this.canvas.width * this.split) < 10 * ui.k) {
        mode = 'split';
        return;
      }
      mode = 'pan';
      start = { x: d.x, y: d.y, cx: this.cx, cy: this.cy };
    });
    c.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const d = this.devicePoint(e);
      if (!mode) {
        c.style.cursor = this.mode === 'split' && Math.abs(d.x - this.canvas.width * this.split) < 10 * ui.k ? 'var(--cur-ew, ew-resize)' : this.mask ? (this.maskErase ? 'var(--cur-cross, crosshair)' : 'var(--cur-pen, crosshair)') : '';
        return;
      }
      if (mode === 'pinch' && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const target = zoom0 * (dist / (pinch0 || 1));
        const snapped = ZOOMS.reduce((best, z) => (Math.abs(Math.log(z / target)) < Math.abs(Math.log(best / target)) ? z : best), ZOOMS[0]);
        // around the point between the fingers
        if (snapped !== this.effectiveZoom()) this.setZoom(snapped, false, this.devicePoint({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }));
        return;
      }
      if (mode === 'mask') {
        this.paintMask(e, e.altKey || this.maskErase ? 0 : this.maskValue);
        return;
      }
      if (mode === 'split') {
        this.split = clamp(d.x / this.canvas.width, 0.02, 0.98);
        this.render();
        return;
      }
      const z = this.effectiveZoom();
      moved += Math.abs(d.x - start.x) + Math.abs(d.y - start.y);
      if (this.fit && moved > 4 * ui.k) {
        this.zoom = z;
        this.fit = false;
      }
      this.cx = start.cx - (d.x - start.x) / z;
      this.cy = start.cy - (d.y - start.y) / z;
      this.render();
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (mode === 'pan' && moved < 6 * ui.k && this.onPick) {
        const p = this.imagePoint(e);
        this.onPick(p.x, p.y, p.pane);
      }
      if (mode === 'mask' && this.mask) this.onMask?.(this.mask);
      if (this.pointers.size === 0) mode = null;
      else if (mode === 'pinch' && this.pointers.size === 1) {
        // one finger lifted: the other one pans on from where it is now (at the new zoom), picking nothing
        const p = [...this.pointers.values()][0];
        const d = this.devicePoint({ clientX: p.x, clientY: p.y });
        start = { x: d.x, y: d.y, cx: this.cx, cy: this.cy };
        moved = Infinity;
        mode = 'pan';
      }
    };
    // cut off (pointercancel, or the capture was lost without a pointerup): forget the pointer, pick nothing
    const cut = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      moved = Infinity;
      end(e);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', cut);
    c.addEventListener('lostpointercapture', cut);
    c.addEventListener('contextmenu', (e) => this.mask && e.preventDefault());
    // keyboard: pan and zoom without a mouse
    this.el.addEventListener('keydown', (e) => {
      if (e.target !== this.el || e.ctrlKey || e.metaKey || e.altKey) return;
      const z = this.effectiveZoom();
      const step = (48 * ui.k) / z;
      const pan = (dx: number, dy: number) => {
        if (this.fit) {
          this.zoom = z;
          this.fit = false;
        }
        this.cx += dx;
        this.cy += dy;
        this.render();
      };
      if (e.key === 'ArrowLeft') pan(-step, 0);
      else if (e.key === 'ArrowRight') pan(step, 0);
      else if (e.key === 'ArrowUp') pan(0, -step);
      else if (e.key === 'ArrowDown') pan(0, step);
      else if (e.key === '+' || e.key === '=') this.stepZoom(1);
      else if (e.key === '-' || e.key === '_') this.stepZoom(-1);
      else if (e.key === '0') this.setZoom(1, true);
      else if (e.key === '1') this.setZoom(1, false);
      else return;
      e.preventDefault();
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.stepZoom(e.deltaY < 0 ? 1 : -1, this.devicePoint(e));
      },
      { passive: false },
    );
  }

  private paintMask(e: PointerEvent, v: number) {
    if (!this.mask) return;
    const p = this.imagePoint(e);
    const mx = Math.floor(p.x / this.mask.unit);
    const my = Math.floor(p.y / this.mask.unit);
    if (mx < 0 || my < 0 || mx >= this.mask.w || my >= this.mask.h) return;
    const i = my * this.mask.w + mx;
    if (this.mask.data[i] !== v) {
      this.mask.data[i] = v;
      this.render();
    }
  }
}

const patCache = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern>>();
function checkerPattern(x: CanvasRenderingContext2D, k: number, color = '#000'): CanvasPattern {
  let m = patCache.get(x);
  if (!m) patCache.set(x, (m = new Map()));
  const key = k + color;
  let p = m.get(key);
  if (!p) {
    const c = document.createElement('canvas');
    c.width = 2 * k;
    c.height = 2 * k;
    const cx = c.getContext('2d')!;
    cx.fillStyle = color;
    cx.fillRect(0, 0, k, k);
    cx.fillRect(k, k, k, k);
    p = x.createPattern(c, 'repeat')!;
    m.set(key, p);
  }
  return p;
}
