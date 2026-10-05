// Integer UI scaling. One UI pixel always covers a whole number of device pixels (k), also on Windows at
// 125%/150% display scaling: the app root is CSS-zoomed by k / devicePixelRatio.
import { settings, onSettings } from '../settings';

export interface UiMetrics {
  /** Device pixels per UI pixel (integer ≥ 1). */
  k: number;
  /** CSS zoom applied to the root. */
  zoom: number;
  /** UI size in UI pixels. */
  w: number;
  h: number;
  phone: boolean;
  /** Text scale (1 or 2). */
  ts: number;
  dpr: number;
}

export const ui: UiMetrics = { k: 1, zoom: 1, w: 800, h: 600, phone: false, ts: 1, dpr: 1 };
type Listener = (m: UiMetrics) => void;
const listeners = new Set<Listener>();
let root: HTMLElement | null = null;

function isPhoneViewport(): boolean {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const w = innerWidth;
  const h = innerHeight;
  return w < 700 || (coarse && Math.min(w, h) < 560);
}

function computeMetrics(): UiMetrics {
  const dpr = window.devicePixelRatio || 1;
  const phone = isPhoneViewport();
  const s = settings.uiScale === 'auto' ? 1 : settings.uiScale;
  const k = Math.max(1, Math.round(s * dpr));
  const zoom = k / dpr;
  const ts = settings.bigText === 'auto' ? (phone ? 2 : 1) : settings.bigText ? 2 : 1;
  return { k, zoom, w: Math.floor(innerWidth / zoom), h: Math.floor(innerHeight / zoom), phone, ts, dpr };
}

function applyScale() {
  if (!root) return;
  const m = computeMetrics();
  Object.assign(ui, m);
  root.style.zoom = String(m.zoom);
  root.style.width = m.w + 'px';
  root.style.height = m.h + 'px';
  root.style.setProperty('--ts', String(m.ts));
  root.style.setProperty('--k', String(m.k));
  root.classList.toggle('phone', m.phone);
  root.classList.toggle('desk', !m.phone);
  root.classList.toggle('bigtext', m.ts > 1);
  for (const l of listeners) l(ui);
}

export function initScale(el: HTMLElement) {
  root = el;
  applyScale();
  let t: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (t) clearTimeout(t);
    t = setTimeout(applyScale, 60);
  };
  addEventListener('resize', later);
  const watchDpr = () => {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener('change', () => {
      applyScale();
      watchDpr();
    }, { once: true });
  };
  watchDpr();
  onSettings((_s, changed) => {
    if (changed.some((c) => c === 'uiScale' || c === 'bigText')) applyScale();
  });
}

export function onScale(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Converts a pointer event's client position into UI pixels relative to the app root. */
export function toUi(e: { clientX: number; clientY: number }): { x: number; y: number } {
  if (!root) return { x: e.clientX, y: e.clientY };
  const r = root.getBoundingClientRect();
  const f = r.width / ui.w || 1;
  return { x: (e.clientX - r.left) / f, y: (e.clientY - r.top) / f };
}

/** Pixel size of an element's box in UI pixels. */
export function uiRect(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  const rr = root!.getBoundingClientRect();
  const f = rr.width / ui.w || 1;
  return { x: (r.left - rr.left) / f, y: (r.top - rr.top) / f, w: r.width / f, h: r.height / f };
}
