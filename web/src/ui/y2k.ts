// Y2K web-page touches for About/Help/Presets: marquees (whole-pixel steps), "under construction" bars,
// tiny frame-by-frame sprites (like animated GIFs), a hit counter.
import { h } from './dom';
import { reducedMotion } from '../settings';
import { makeCanvas, iconCanvas } from './art';
import { drawText, textWidth } from './pixeltext';

const timers = new Set<ReturnType<typeof setInterval>>();

function every(ms: number, f: () => void, el: HTMLElement) {
  const t = setInterval(() => {
    if (!el.isConnected) {
      clearInterval(t);
      timers.delete(t);
      return;
    }
    f();
  }, ms);
  timers.add(t);
}

export function marquee(text: string): HTMLElement {
  const span = h('span', null, text);
  const el = h('div', { class: 'marquee', role: 'marquee', 'aria-label': text }, span);
  if (reducedMotion()) {
    span.style.position = 'static';
    return el;
  }
  let x = 0;
  every(80, () => {
    const w = el.clientWidth;
    const sw = span.offsetWidth;
    x -= 3;
    if (x < -sw) x = w;
    span.style.transform = `translateX(${x}px)`;
  }, el);
  requestAnimationFrame(() => (x = el.clientWidth));
  return el;
}

export function underConstruction(text = 'UNDER CONSTRUCTION'): HTMLElement {
  return h('div', { class: 'uc', role: 'note' }, spriteWorker(), h('span', { class: 'lbl' }, text), spriteWorker());
}

/** A little digging worker, 2 frames. */
function spriteWorker(): HTMLElement {
  const frames = [0, 1].map((f) => {
    const c = makeCanvas(16, 16);
    const x = c.getContext('2d')!;
    x.fillStyle = '#ffcc00';
    x.fillRect(5, 1, 6, 3);
    x.fillStyle = '#ffd9a0';
    x.fillRect(6, 4, 4, 3);
    x.fillStyle = '#ff6600';
    x.fillRect(5, 7, 6, 5);
    x.fillStyle = '#333';
    x.fillRect(5, 12, 2, 3);
    x.fillRect(9, 12, 2, 3);
    x.fillStyle = '#8b5a2b';
    if (f) x.fillRect(11, 6, 1, 8);
    else x.fillRect(11, 3, 1, 8);
    x.fillStyle = '#999';
    x.fillRect(f ? 10 : 10, f ? 13 : 10, 4, 2);
    return c;
  });
  return animSprite(frames, 3);
}

export function animSprite(frames: HTMLCanvasElement[], fps: number, scale = 1): HTMLElement {
  const c = makeCanvas(frames[0].width, frames[0].height);
  c.style.width = frames[0].width * scale + 'px';
  c.style.height = frames[0].height * scale + 'px';
  c.setAttribute('aria-hidden', 'true');
  const x = c.getContext('2d')!;
  let i = 0;
  const draw = () => {
    x.clearRect(0, 0, c.width, c.height);
    x.drawImage(frames[i % frames.length], 0, 0);
  };
  draw();
  if (!reducedMotion()) every(1000 / fps, () => ((i++), draw()), c as unknown as HTMLElement);
  return c;
}

export function newBadge(): HTMLElement {
  const frames = ['#ff0000', '#ffff00'].map((col) => {
    const w = textWidth('NEW!', true) + 6;
    const c = makeCanvas(w, 15);
    const x = c.getContext('2d')!;
    x.fillStyle = col === '#ff0000' ? '#ffff00' : '#ff0000';
    x.fillRect(0, 0, w, 15);
    drawText(x, 'NEW!', 3, 1, col, { bold: true });
    return c;
  });
  return animSprite(frames, 2);
}

export function spinningGlobe(): HTMLElement {
  const base = iconCanvas('globe', 32);
  const frames = [0, 1, 2, 3].map((f) => {
    const c = makeCanvas(32, 32);
    const x = c.getContext('2d')!;
    x.drawImage(base, 0, 0);
    // shift the land 2 px per frame inside the disc (crude rotation, very 1999)
    const d = x.getImageData(0, 0, 32, 32);
    const src = new Uint8ClampedArray(d.data);
    for (let y = 0; y < 32; y++)
      for (let xx = 4; xx < 28; xx++) {
        const sx = 4 + ((xx - 4 + f * 6) % 24);
        const i = (y * 32 + xx) * 4;
        const j = (y * 32 + sx) * 4;
        if (src[i + 3] && src[j + 3]) for (let k = 0; k < 4; k++) d.data[i + k] = src[j + k];
      }
    x.putImageData(d, 0, 0);
    return c;
  });
  return animSprite(frames, 4);
}

export function hitCounter(n: number): HTMLElement {
  return h('span', { class: 'hitcounter', 'aria-label': `${n} visitors` }, String(n).padStart(6, '0').split('').map((d) => h('span', { class: 'd' }, d)));
}

export function visitCount(): number {
  try {
    const n = Number(localStorage.getItem('refragmenter.visits') ?? '0') + 1;
    localStorage.setItem('refragmenter.visits', String(n));
    return n;
  } catch {
    return 1;
  }
}
