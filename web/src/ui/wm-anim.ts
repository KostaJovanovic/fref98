// The 98 minimise/maximise/restore animation (DrawAnimatedRects with IDANI_CAPTION): a caption-shaped bar
// zooms between the window's caption and its taskbar button (or the maximised caption) in about 200 ms of
// whole steps. Open and close are instant. No imports with side effects, so tests can load this in Node.
import type { Rect } from './wm-drag';

export const ZOOM_MS = 200;
export const ZOOM_STEPS = 10;
export const CAPTION_H = 18;

/** Caption-shaped rect at time t (0..1, clamped) between two rects. Each rect is cut to its top `cap` px
 *  (a taskbar button is already shorter), and the result is in whole pixels. */
export function captionRect(from: Rect, to: Rect, t: number, cap = CAPTION_H): Rect {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const fh = Math.min(cap, from.h);
  const th = Math.min(cap, to.h);
  const l = (a: number, b: number) => Math.round(a + (b - a) * k);
  return { x: l(from.x, to.x), y: l(from.y, to.y), w: Math.max(1, l(from.w, to.w)), h: Math.max(1, l(fh, th)) };
}

/** Plays the zoom in `host` (coordinates in host UI px). Resolves when done; `content` (icon and title) is
 *  shown inside the bar like 98 does. */
export function animateCaption(host: HTMLElement, from: Rect, to: Rect, opts: { active?: boolean; content?: Node[]; ms?: number; steps?: number } = {}): Promise<void> {
  const ms = opts.ms ?? ZOOM_MS;
  const steps = opts.steps ?? ZOOM_STEPS;
  const bar = document.createElement('div');
  bar.className = 'win-zoom' + (opts.active === false ? ' inactive' : '');
  bar.setAttribute('aria-hidden', 'true');
  if (opts.content) bar.append(...opts.content);
  const place = (r: Rect) => {
    bar.style.left = r.x + 'px';
    bar.style.top = r.y + 'px';
    bar.style.width = r.w + 'px';
    bar.style.height = r.h + 'px';
  };
  place(captionRect(from, to, 0));
  host.appendChild(bar);
  return new Promise((resolve) => {
    const t0 = performance.now();
    let shown = 0;
    const tick = (now: number) => {
      const step = Math.min(steps, Math.floor(((now - t0) / ms) * steps));
      if (step !== shown) {
        shown = step;
        place(captionRect(from, to, step / steps));
      }
      if (step >= steps) {
        bar.remove();
        resolve();
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
