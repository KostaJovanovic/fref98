// Windows 98 message boxes (icon left, text, centred 75×23 buttons; Enter/Esc; modal to the active window)
// and the (never blocking) progress dialog. Never the browser's alert/confirm/prompt.
import { h } from './dom';
import { openWindow, activeWin, type Win } from './wm';
import { iconImg, msgIcon } from './art';
import { textWidth } from './pixeltext';
import { progressBar } from './controls';
import { reducedMotion } from '../settings';
import * as bus from '../bus';

let n = 0;

/** Window chrome around a dialog body: 3 + 3 px frame and a 19 px caption. */
const CHROME_W = 6;
const CHROME_H = 25;

type MsgKind = 'error' | 'warning' | 'info' | 'question';
const MSG: Record<string, MsgKind> = { error: 'error', warning: 'warning', info: 'info', question: 'question', about: 'info' };

/** The 32×32 icon of a message box: our redrawn 98 icons for error/warning/info/question ('about' = info);
 *  any other name is an app icon (the 98 Recycle Bin confirmation shows the bin, too). */
function boxIcon(icon: string): HTMLImageElement {
  const k = MSG[icon];
  if (!k) return iconImg(icon, 32);
  const img = document.createElement('img');
  img.src = msgIcon(k);
  img.width = 32;
  img.height = 32;
  img.alt = '';
  img.className = 'ico';
  img.draggable = false;
  img.setAttribute('aria-hidden', 'true');
  return img;
}

export function message(title: string, text: string | HTMLElement, icon = 'about', buttons: { label: string; primary?: boolean; run?: () => void }[] = [{ label: 'OK', primary: true }]): Win {
  const id = 'msg' + n++;
  let win: Win;
  const btns = buttons.map((b) =>
    // run first: closing fires onClose, and confirmBox reads a close without a choice as "Cancel"
    h('button', { class: 'btn' + (b.primary ? ' default' : ''), onclick: () => (b.run?.(), win.close()) }, b.label),
  );
  const body = h(
    'div',
    { class: 'msgbox' },
    h('div', { class: 'msg-main' }, boxIcon(icon), typeof text === 'string' ? h('div', { class: 'msg-text selectable' }, text) : h('div', { class: 'msg-text' }, text)),
    h('div', { class: 'msg-btns' }, btns),
  );
  // width from the text (our font's exact widths): one line up to ~360 px, then it wraps
  const longest = typeof text === 'string' ? Math.max(...text.split('\n').map((l) => textWidth(l))) : 300;
  const textW = Math.min(360, Math.max(120, longest + 4));
  const btnW = buttons.length * 75 + (buttons.length - 1) * 6 + 24;
  const width = Math.max(btnW, 12 + 32 + 12 + textW + 12) + CHROME_W;
  const lines = typeof text === 'string' ? text.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(textWidth(l) / textW)), 0) : 4;
  const guess = Math.max(32, lines * 16) + 12 + 12 + 23 + 12 + CHROME_H;
  // caption icon: an app icon for the four message kinds (the 32 px icon in the body is the 98 one)
  const capIcon = MSG[icon] ? ({ info: 'about', question: 'help', error: 'shutdown', warning: 'about' } as const)[MSG[icon]] : icon;
  win = openWindow({ id, title, icon: capIcon, body, width, height: guess, minWidth: 120, minHeight: 60, resizable: false, modal: activeWin() });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Esc = Cancel/No when there is one; a lone OK box just closes
      e.preventDefault();
      e.stopPropagation();
      const i = buttons.findIndex((b) => /^(cancel|no)$/i.test(b.label));
      if (i >= 0) btns[i].click();
      else if (buttons.length === 1) btns[0].click();
      else win.close();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (i >= 0) {
        e.preventDefault();
        btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
      }
    }
  });
  requestAnimationFrame(() => {
    // size to the real content, keeping the box centred where it was
    const need = Math.min(body.scrollHeight + CHROME_H, 600);
    const cur = win.el.offsetHeight;
    if (need !== cur) {
      win.el.style.top = Math.max(0, (parseInt(win.el.style.top) || 0) + Math.round((cur - need) / 2)) + 'px';
      win.el.style.height = need + 'px';
      win.el.dataset.wh = String(need);
    }
    (btns.find((_, i) => buttons[i].primary) ?? btns[0])?.focus();
  });
  return win;
}

export function confirmBox(title: string, text: string, okLabel = 'OK', icon = 'question'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const w = message(title, text, icon, [
      { label: okLabel, primary: true, run: () => ((done = true), resolve(true)) },
      { label: 'Cancel', run: () => ((done = true), resolve(false)) },
    ]);
    const prev = w.opts.onClose;
    w.opts.onClose = () => {
      if (!done) resolve(false);
      return prev?.();
    };
  });
}

export function errorBox(text: string, title = 'File Refragmenter') {
  bus.emit('error', text);
  return message(title, text, 'error');
}

export interface ProgressHandle {
  set(fraction: number | null, text?: string): void;
  close(): void;
  cancelled: boolean;
}

/** A period-style progress dialog: block progress bar, rotating messages, an always-working Cancel,
 *  a brief "(Not Responding)" flicker on long runs. The work itself runs in workers; this never blocks. */
export function progressDialog(title: string, opts: { onCancel?: () => void; messages?: (i: number) => string; total?: number; say?: string } = {}): ProgressHandle {
  const id = 'prog' + n++;
  const text = h('div', { class: 'selectable grow' }, 'Please wait…');
  const bar = progressBar(0);
  const fill = bar.firstElementChild as HTMLElement;
  let handle!: ProgressHandle;
  const cancel = h('button', { class: 'btn default', onclick: () => handle.close() }, 'Cancel');
  const body = h('div', { class: 'pad col' }, h('div', { class: 'row' }, iconImg('disk', 32), text), bar, h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, cancel));
  const win = openWindow({ id, title, icon: 'disk', body, width: 380, height: 120 + CHROME_H, minHeight: 60, resizable: false, modal: activeWin(), onClose: () => void finish(true) });
  win.setBusy(true);
  requestAnimationFrame(() => cancel.focus());
  bus.emit('long-start', { say: opts.say });
  let frac: number | null = null;
  let tick = 0;
  let lastUpdate = performance.now();
  let flickered = false;
  let closed = false;
  const timer = setInterval(() => {
    tick++;
    if (frac === null) {
      // indeterminate: three blocks sweep across in whole steps
      bar.classList.add('indet');
      const w = bar.clientWidth - 4;
      const pos = reducedMotion() ? 0 : ((tick * 10) % (w + 30)) - 30;
      fill.style.transform = `translateX(${Math.round(pos / 10) * 10}px)`;
    }
    if (opts.messages && tick % 3 === 0) text.firstElementChild!.textContent = opts.messages(tick / 3);
    if (!flickered && performance.now() - lastUpdate > 4000 && performance.now() > 0) {
      flickered = true;
      win.notResponding();
    }
  }, 110);
  function finish(fromWin: boolean) {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    bus.emit('long-end');
    if (fromWin) {
      handle.cancelled = true;
      opts.onCancel?.();
    }
  }
  handle = {
    cancelled: false,
    set(f, t) {
      lastUpdate = performance.now();
      frac = f;
      if (f !== null) {
        bar.classList.remove('indet');
        fill.style.transform = '';
        bar.set(f);
      }
      if (t) text.firstElementChild!.textContent = t;
    },
    close() {
      if (closed) return;
      // user pressed Cancel or the work finished
      win.close();
    },
  };
  (handle as any).done = () => {
    finish(false);
    win.opts.onClose = undefined;
    win.close();
  };
  return handle;
}

/** Ends a progress dialog because the work finished (not a cancel). */
export function progressDone(p: ProgressHandle) {
  (p as any).done?.();
}
