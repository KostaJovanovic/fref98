// Shared Windows 98 pieces for the tool windows (Removable Disk, Hex Doctor, Save As, Display, Help): fixed
// modal dialogs, wizards with the left bitmap panel, list boxes, the beige monitor of Display Properties and
// the 3D pie chart of a drive's Properties. All art is drawn here, at run time, in 98 colours.
import { h, mount } from '../ui/dom';
import { iconCanvas } from '../ui/art';
import { button } from '../ui/controls';
import { openWindow, activeWin, type Win } from '../ui/wm';
import { drawText, textWidth } from '../ui/pixeltext';
import { ditherBayer } from '../ui/palette';

let dlgN = 0;

export interface DialogButton {
  label: string;
  /** Return false to keep the dialog open. */
  run?: () => boolean | void;
  primary?: boolean;
  cancel?: boolean;
  disabled?: boolean;
}

/** A fixed-size 98 dialog, modal to its owner (default: the active window): buttons in a row at the bottom
 *  right, Enter presses the default button, Esc the Cancel one. */
export function dialog98(o: { id?: string; title: string; icon: string; body: HTMLElement; width: number; height: number; buttons: DialogButton[]; owner?: Win | null; onClose?: () => void; column?: boolean }): Win & { buttons: HTMLButtonElement[] } {
  let win!: Win;
  const btns = o.buttons.map((b) =>
    button(b.label, () => {
      if (b.run?.() === false) return;
      win.close();
    }, { cls: b.primary ? 'default' : '', disabled: b.disabled }),
  );
  const btnBox = h('div', { class: o.column ? 'dlg-btns col' : 'dlg-btns' }, btns);
  const body = h('div', { class: 'dlg98' + (o.column ? ' side' : '') }, o.body, btnBox);
  win = openWindow({ id: o.id ?? 'dlg' + ++dlgN, title: o.title, icon: o.icon, body, width: o.width, height: o.height, resizable: false, modal: o.owner === undefined ? activeWin() : o.owner, onClose: () => void o.onClose?.() });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const i = o.buttons.findIndex((b) => b.cancel);
      if (i >= 0) btns[i].click();
      else win.close();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !(e.target as HTMLElement).closest?.('.combo')) {
      const i = o.buttons.findIndex((b) => b.primary);
      if (i >= 0 && !btns[i].disabled) {
        e.preventDefault();
        btns[i].click();
      }
    }
  });
  requestAnimationFrame(() => {
    const first = o.body.querySelector<HTMLElement>('input:not([type=radio]):not([type=checkbox]), .combo');
    (first ?? btns.find((_, i) => o.buttons[i].primary) ?? btns[0])?.focus();
  });
  return Object.assign(win, { buttons: btns });
}

// ------------------------------------------------------------------ list box

export interface ListItem {
  id: string;
  label: string;
  icon?: HTMLElement | null;
  /** Extra columns (Details-style). */
  cols?: string[];
  dim?: boolean;
}

/** A 98 list box: single selection, arrows/Home/End/type-ahead, double-click or Enter activates. */
export function listBox(items: ListItem[], selected: string | null, onPick: (id: string) => void, opts: { label: string; onOpen?: (id: string) => void; cls?: string } = { label: '' }): HTMLElement {
  const box = h('div', { class: 'list lb98 ' + (opts.cls ?? ''), role: 'listbox', tabIndex: 0, 'aria-label': opts.label });
  let cur = selected;
  const rows = items.map((it) => {
    const r = h('div', { class: 'li' + (it.id === cur ? ' sel' : '') + (it.dim ? ' dim' : ''), role: 'option', 'aria-selected': String(it.id === cur), dataset: { id: it.id } }, it.icon ?? null, h('span', { class: 'lbl' }, it.label), (it.cols ?? []).map((c) => h('span', { class: 'lcol' }, c)));
    r.addEventListener('pointerdown', (e) => {
      if (e.button > 2) return;
      pick(it.id);
    });
    r.addEventListener('dblclick', () => opts.onOpen?.(it.id));
    return r;
  });
  box.append(...rows);
  const pick = (id: string, scroll = false) => {
    cur = id;
    rows.forEach((r, i) => {
      const on = items[i].id === id;
      r.classList.toggle('sel', on);
      r.setAttribute('aria-selected', String(on));
      if (on && scroll) r.scrollIntoView({ block: 'nearest' });
    });
    onPick(id);
  };
  box.addEventListener('keydown', (e) => {
    const i = items.findIndex((it) => it.id === cur);
    let j = -1;
    if (e.key === 'ArrowDown') j = Math.min(items.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else if (e.key === 'Enter' && cur && opts.onOpen) {
      e.preventDefault();
      e.stopPropagation();
      opts.onOpen(cur);
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      j = items.findIndex((it, n) => n > i && it.label.toLowerCase().startsWith(k));
      if (j < 0) j = items.findIndex((it) => it.label.toLowerCase().startsWith(k));
    } else return;
    e.preventDefault();
    if (j >= 0 && items[j]) pick(items[j].id, true);
  });
  return box;
}

// ------------------------------------------------------------------ wizard

export interface WizardPage {
  /** Bold heading at the top of the page. */
  title: string;
  render: (into: HTMLElement) => void;
  /** Can Next / Finish be pressed? */
  canNext?: () => boolean;
  /** Runs on Next / Finish; return false (or a promise of false) to stay. */
  next?: () => boolean | void | Promise<boolean | void>;
}

/** A 98 wizard: the bitmap panel on the left, the page on the right, an etched line and
 *  < Back / Next > (Finish on the last page) / Cancel. */
export function wizard98(o: { id: string; title: string; icon: string; art: HTMLCanvasElement; pages: WizardPage[]; width?: number; height?: number; owner?: Win | null; onCancel?: () => void; onFinish?: () => void }): { win: Win; go(i: number): void; refresh(): void; page(): number } {
  let i = 0;
  let finished = false;
  const content = h('div', { class: 'wiz-page' });
  const back = button('< Back', () => go(i - 1));
  const next = button('Next >', () => void advance(), { cls: 'default' });
  const cancel = button('Cancel', () => win.close());
  const art = h('div', { class: 'wiz-art' }, o.art);
  const body = h('div', { class: 'wiz98' }, h('div', { class: 'wiz-main' }, art, content), h('div', { class: 'wiz-line' }), h('div', { class: 'wiz-btns' }, back, next, h('span', { class: 'wiz-gap' }), cancel));
  const win = openWindow({
    id: o.id,
    title: o.title,
    icon: o.icon,
    body,
    width: o.width ?? 500,
    height: o.height ?? 380,
    resizable: false,
    modal: o.owner === undefined ? activeWin() : o.owner,
    onClose: () => {
      if (!finished) o.onCancel?.();
    },
  });
  let busy = false;
  const refresh = () => {
    const p = o.pages[i];
    back.disabled = i === 0 || busy;
    const last = i === o.pages.length - 1;
    mount(next, last ? 'Finish' : 'Next >');
    next.disabled = busy || (p.canNext ? !p.canNext() : false);
    cancel.disabled = busy;
  };
  const go = (n: number) => {
    i = Math.max(0, Math.min(o.pages.length - 1, n));
    const p = o.pages[i];
    content.replaceChildren(h('div', { class: 'wiz-title b' }, p.title));
    p.render(content);
    refresh();
  };
  const advance = async () => {
    const p = o.pages[i];
    if (p.canNext && !p.canNext()) return;
    busy = true;
    refresh();
    let ok: boolean | void = true;
    try {
      ok = await p.next?.();
    } finally {
      busy = false;
    }
    if (!win.el.isConnected) return;
    if (ok === false) return refresh();
    if (i === o.pages.length - 1) {
      finished = true;
      win.close();
      o.onFinish?.();
    } else go(i + 1);
  };
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      e.stopPropagation();
      win.close();
    }
  });
  go(0);
  requestAnimationFrame(() => next.focus());
  return { win, go, refresh, page: () => i };
}

/** The wizard's left bitmap: a dithered teal panel with big pixel icons (2× nearest-neighbour). */
export function wizardArt(icons: string[], w = 140, hh = 270): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  const g = x.createLinearGradient(0, 0, 0, hh);
  g.addColorStop(0, '#008080');
  g.addColorStop(1, '#000040');
  x.fillStyle = g;
  x.fillRect(0, 0, w, hh);
  const d = x.getImageData(0, 0, w, hh);
  ditherBayer(d.data, w, hh, 40);
  x.putImageData(d, 0, 0);
  x.imageSmoothingEnabled = false;
  icons.forEach((name, n) => {
    const ic = iconCanvas(name, 32);
    const s = n === 0 ? 3 : 2;
    const px = n === 0 ? Math.round((w - 32 * s) / 2) : Math.round(w / 2 - 8 + (n - 1) * 40 - ((icons.length - 2) * 40) / 2);
    const py = n === 0 ? 40 : 40 + 32 * 3 + 24;
    x.drawImage(ic, px, py, 32 * s, 32 * s);
  });
  return c;
}

// ------------------------------------------------------------------ the Display Properties monitor

export const CRT_W = 184;
export const CRT_H = 170;
export const SCREEN = { x: 17, y: 16, w: 150, h: 112 };

/** The beige monitor of Display Properties. `paint` draws the screen (SCREEN.w × SCREEN.h). */
export function crtMonitor(paint: (x: CanvasRenderingContext2D, w: number, h: number) => void): { el: HTMLElement; redraw(): void; screen: HTMLCanvasElement } {
  const c = document.createElement('canvas');
  c.width = CRT_W;
  c.height = CRT_H;
  c.className = 'crt';
  const screen = document.createElement('canvas');
  screen.width = SCREEN.w;
  screen.height = SCREEN.h;
  const x = c.getContext('2d')!;
  const body = () => {
    x.clearRect(0, 0, CRT_W, CRT_H);
    const B = { x: 4, y: 0, w: CRT_W - 8, h: 142 };
    // case: beige with 98 bevels
    x.fillStyle = '#d4d0c8';
    x.fillRect(B.x, B.y, B.w, B.h);
    x.fillStyle = '#ffffff';
    x.fillRect(B.x, B.y, B.w - 1, 1);
    x.fillRect(B.x, B.y, 1, B.h - 1);
    x.fillStyle = '#dfdfdf';
    x.fillRect(B.x + 1, B.y + 1, B.w - 3, 1);
    x.fillRect(B.x + 1, B.y + 1, 1, B.h - 3);
    x.fillStyle = '#000000';
    x.fillRect(B.x, B.y + B.h - 1, B.w, 1);
    x.fillRect(B.x + B.w - 1, B.y, 1, B.h);
    x.fillStyle = '#808080';
    x.fillRect(B.x + 1, B.y + B.h - 2, B.w - 2, 1);
    x.fillRect(B.x + B.w - 2, B.y + 1, 1, B.h - 2);
    // screen well: sunken
    const S = SCREEN;
    x.fillStyle = '#808080';
    x.fillRect(S.x - 2, S.y - 2, S.w + 3, 1);
    x.fillRect(S.x - 2, S.y - 2, 1, S.h + 3);
    x.fillStyle = '#000000';
    x.fillRect(S.x - 1, S.y - 1, S.w + 1, 1);
    x.fillRect(S.x - 1, S.y - 1, 1, S.h + 1);
    x.fillStyle = '#ffffff';
    x.fillRect(S.x - 2, S.y + S.h + 1, S.w + 4, 1);
    x.fillRect(S.x + S.w + 1, S.y - 2, 1, S.h + 4);
    x.fillStyle = '#dfdfdf';
    x.fillRect(S.x - 1, S.y + S.h, S.w + 2, 1);
    x.fillRect(S.x + S.w, S.y - 1, 1, S.h + 2);
    // power light and button
    x.fillStyle = '#00ff00';
    x.fillRect(B.x + B.w - 18, B.y + B.h - 9, 3, 2);
    x.fillStyle = '#808080';
    x.fillRect(B.x + B.w - 30, B.y + B.h - 9, 8, 3);
    x.fillStyle = '#ffffff';
    x.fillRect(B.x + B.w - 30, B.y + B.h - 9, 7, 1);
    // stand: neck and foot
    x.fillStyle = '#d4d0c8';
    x.fillRect(70, 142, 44, 10);
    x.fillStyle = '#808080';
    x.fillRect(70, 150, 44, 2);
    x.fillStyle = '#d4d0c8';
    x.fillRect(42, 152, 100, 14);
    x.fillStyle = '#ffffff';
    x.fillRect(42, 152, 100, 1);
    x.fillRect(42, 152, 1, 14);
    x.fillStyle = '#000000';
    x.fillRect(42, 166, 100, 1);
    x.fillRect(142, 152, 1, 15);
    x.fillStyle = '#808080';
    x.fillRect(43, 165, 99, 1);
    x.fillRect(141, 153, 1, 13);
  };
  const redraw = () => {
    body();
    const sx = screen.getContext('2d')!;
    sx.imageSmoothingEnabled = true;
    sx.fillStyle = '#000';
    sx.fillRect(0, 0, SCREEN.w, SCREEN.h);
    paint(sx, SCREEN.w, SCREEN.h);
    x.drawImage(screen, SCREEN.x, SCREEN.y);
  };
  redraw();
  return { el: h('div', { class: 'crt-wrap', 'aria-hidden': 'true' }, c), redraw, screen };
}

// ------------------------------------------------------------------ the drive pie chart

/** 98's drive pie: used space blue, free space magenta, a 10 px rim in the dark shades. */
export function pieChart(used: number, total: number, w = 120, hh = 60): HTMLCanvasElement {
  const depth = 10;
  const c = document.createElement('canvas');
  c.width = w + 2;
  c.height = hh + depth + 2;
  c.className = 'pie98';
  const x = c.getContext('2d', { willReadFrequently: true })!;
  const cx = (w + 1) / 2;
  const cy = hh / 2 + 1;
  const rx = w / 2;
  const ry = hh / 2;
  const frac = total > 0 ? Math.max(0, Math.min(1, used / total)) : 0;
  // angle 0 at 3 o'clock, used runs clockwise from there (as 98 draws it)
  const end = frac * Math.PI * 2;
  const inUsed = (a: number) => {
    let t = a % (Math.PI * 2);
    if (t < 0) t += Math.PI * 2;
    return t < end;
  };
  const img = x.createImageData(c.width, c.height);
  const put = (px: number, py: number, rgb: number) => {
    const i = (py * c.width + px) * 4;
    img.data[i] = rgb >> 16;
    img.data[i + 1] = (rgb >> 8) & 255;
    img.data[i + 2] = rgb & 255;
    img.data[i + 3] = 255;
  };
  for (let py = 0; py < c.height; py++)
    for (let px = 0; px < c.width; px++) {
      const dx = (px + 0.5 - cx) / rx;
      // top face
      const dyTop = (py + 0.5 - cy) / ry;
      if (dx * dx + dyTop * dyTop <= 1) {
        const a = Math.atan2(dyTop * rx, dx * rx);
        put(px, py, inUsed(a) ? 0x0000ff : 0xff00ff);
        continue;
      }
      // rim: below the top ellipse, within depth, lower half only
      for (let d = 1; d <= depth; d++) {
        const dy = (py + 0.5 - cy - d) / ry;
        if (dx * dx + dy * dy <= 1 && dy > 0) {
          const a = Math.atan2(dy * rx, dx * rx);
          put(px, py, inUsed(a) ? 0x000080 : 0x800080);
          break;
        }
      }
    }
  x.putImageData(img, 0, 0);
  // black outline around the whole shape and the slice edges on the top face
  x.strokeStyle = '#000';
  x.lineWidth = 1;
  return c;
}

/** A small filled square in a colour, with a black border (legends). */
export function swatch98(col: string): HTMLElement {
  const s = h('span', { class: 'sw98' });
  s.style.background = col;
  return s;
}

// ------------------------------------------------------------------ help-book icons

const BOOK = {
  closed: ['................', '.....KKKKKKKKK..', '....KbbbbbbbbK..', '...KbbbbbbbbKK..', '..KbbbbbbbbKwK..', '.KbbbbbbbbKwwK..', 'KKKKKKKKKKwwwK..', 'KbbbbbbbbKwwK...', 'KbbYYYYbbKwK....', 'KbbbbbbbbKK.....', 'KbbbbbbbbK......', 'KKKKKKKKKK......', '................', '................', '................', '................'],
  open: ['................', '................', '.KKKKKK..KKKKKK.', 'KwwwwwwK.KwwwwwK', 'KwKKKKwwKwKKKKwK', 'KwwwwwwwKwwwwwwK', 'KwKKKKwwKwKKKKwK', 'KwwwwwwwKwwwwwwK', 'KwKKKwwwKwKKKwwK', 'KwwwwwwwKwwwwwwK', 'KKKKKKKKKKKKKKKK', '.KbbbbbbbbbbbbK.', '..KKKKKKKKKKKK..', '................', '................', '................'],
  page: ['................', '..KKKKKKKKK.....', '..KwwwwwwwKK....', '..KwwwwwwwKwK...', '..KwwYYYwwKKKK..', '..KwYKKKYwwwwK..', '..KwwwwKYwwwwK..', '..KwwwYYwwwwwK..', '..KwwwYwwwwwwK..', '..KwwwwwwwwwwK..', '..KwwwYwwwwwwK..', '..KwwwwwwwwwwK..', '..KKKKKKKKKKKK..', '................', '................', '................'],
};
const BOOK_PAL: Record<string, string> = { K: '#000000', b: '#000080', w: '#ffffff', Y: '#ffff00' };
const bookUrls = new Map<string, string>();

/** The HTML Help tree icons: closed book, open book, topic page with a "?". */
export function bookIcon(kind: 'closed' | 'open' | 'page'): HTMLImageElement {
  let u = bookUrls.get(kind);
  if (!u) {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const x = c.getContext('2d')!;
    BOOK[kind].forEach((r, y) => {
      for (let i = 0; i < r.length; i++) {
        const col = BOOK_PAL[r[i]];
        if (!col) continue;
        x.fillStyle = col;
        x.fillRect(i, y, 1, 1);
      }
    });
    u = c.toDataURL('image/png');
    bookUrls.set(kind, u);
  }
  const img = h('img', { class: 'ico', width: 16, height: 16, alt: '', 'aria-hidden': 'true', draggable: false });
  img.src = u;
  return img;
}

/** Pixel-font text in a canvas, for art that needs words (the wizard bitmap, the monitor). */
export function canvasText(x: CanvasRenderingContext2D, s: string, cx: number, y: number, col: string, bold = false) {
  drawText(x, s, Math.round(cx - textWidth(s, bold) / 2), y, col, { bold });
}
