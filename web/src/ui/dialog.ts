// Windows 98 message boxes (icon left, text, centred 75×23 buttons; Enter/Esc; modal to the active window)
// and the (never blocking) progress dialog. Never the browser's alert/confirm/prompt.
import { h } from './dom';
import { openWindow, activeWin, type Win, type WinOpts } from './wm';
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

export interface DialogButton {
  label: string;
  /** Runs before the dialog closes; return false to keep it open. */
  run?: () => boolean | void;
  /** The default button (Enter, and the thick 98 ring). */
  primary?: boolean;
  /** The button Esc presses (default: one labelled Cancel or No). */
  cancel?: boolean;
  disabled?: boolean;
}

export type DialogOpts = Omit<WinOpts, 'id' | 'body' | 'enter' | 'esc' | 'resizable'> & {
  id?: string;
  buttons: DialogButton[];
  /** The dialog's body around its button elements. */
  body: (buttons: HTMLButtonElement[]) => HTMLElement;
  /** What gets the focus when it opens (default: the default button). */
  focus?: (buttons: HTMLButtonElement[]) => HTMLElement | null | undefined;
};

/** The one core of every fixed 98 dialog (message boxes, the tool dialogs): its buttons (`run` goes first,
 *  so closing through onClose can tell a choice from the close box), Enter = the default button,
 *  Esc = the Cancel button (else a lone button, else just close), modal to the active window. */
export function openDialog(o: DialogOpts): Win & { buttons: HTMLButtonElement[] } {
  let win!: Win;
  const btns = o.buttons.map((b) =>
    h('button', { class: 'btn' + (b.primary ? ' default' : ''), type: 'button', disabled: !!b.disabled, onclick: () => b.run?.() !== false && win.close() }, b.label),
  );
  const cancelAt = () => {
    const i = o.buttons.findIndex((b) => b.cancel);
    return i >= 0 ? i : o.buttons.findIndex((b) => b.cancel === undefined && /^(cancel|no)$/i.test(b.label));
  };
  const { buttons: _b, body: _body, focus: _f, ...rest } = o;
  win = openWindow({
    ...rest,
    id: o.id ?? 'dlg' + n++,
    body: o.body(btns),
    resizable: false,
    modal: o.modal === undefined ? activeWin() : o.modal,
    enter: () => {
      const b = btns[o.buttons.findIndex((x) => x.primary)];
      if (b && !b.disabled) b.click();
    },
    esc: () => {
      const i = cancelAt();
      if (i >= 0 && !btns[i].disabled) btns[i].click();
      else if (btns.length === 1) btns[0].click();
      else win.close();
    },
  });
  requestAnimationFrame(() => ((o.focus?.(btns) ?? btns.find((_, i) => o.buttons[i].primary)) ?? btns[0])?.focus());
  return Object.assign(win, { buttons: btns });
}

export function message(title: string, text: string | HTMLElement, icon = 'about', buttons: DialogButton[] = [{ label: 'OK', primary: true }], opts: { onClose?: () => void } = {}): Win {
  let btns: HTMLButtonElement[] = [];
  let body!: HTMLElement;
  // width from the text (our font's exact widths): one line up to ~360 px, then it wraps
  const longest = typeof text === 'string' ? Math.max(...text.split('\n').map((l) => textWidth(l))) : 300;
  const textW = Math.min(360, Math.max(120, longest + 4));
  const btnW = buttons.length * 75 + (buttons.length - 1) * 6 + 24;
  const width = Math.max(btnW, 12 + 32 + 12 + textW + 12) + CHROME_W;
  const lines = typeof text === 'string' ? text.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(textWidth(l) / textW)), 0) : 4;
  const guess = Math.max(32, lines * 16) + 12 + 12 + 23 + 12 + CHROME_H;
  // caption icon: an app icon for the four message kinds (the 32 px icon in the body is the 98 one)
  const capIcon = MSG[icon] ? ({ info: 'about', question: 'help', error: 'shutdown', warning: 'about' } as const)[MSG[icon]] : icon;
  const win = openDialog({
    id: 'msg' + n++,
    title,
    icon: capIcon,
    buttons,
    width,
    height: guess,
    minWidth: 120,
    minHeight: 60,
    onClose: opts.onClose,
    body: (b) => {
      btns = b;
      return (body = h(
        'div',
        { class: 'msgbox' },
        h('div', { class: 'msg-main' }, boxIcon(icon), typeof text === 'string' ? h('div', { class: 'msg-text selectable' }, text) : h('div', { class: 'msg-text' }, text)),
        h('div', { class: 'msg-btns' }, b),
      ));
    },
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
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
  });
  return win;
}

/** OK/Cancel (or Yes/No, …) box: true for the first button, false for the other one or the close box. */
export function confirmBox(title: string, text: string, okLabel = 'OK', icon = 'question', cancelLabel = 'Cancel'): Promise<boolean> {
  return new Promise((resolve) => {
    message(
      title,
      text,
      icon,
      [
        { label: okLabel, primary: true, run: () => resolve(true) },
        { label: cancelLabel, cancel: true },
      ],
      // (a promise settles once: after the first button this false is ignored)
      { onClose: () => resolve(false) },
    );
  });
}

export function errorBox(text: string, title = 'File Refragmenter') {
  bus.emit('error', text);
  return message(title, text, 'error');
}

export interface ProgressHandle {
  set(fraction: number | null, text?: string): void;
  /** Cancels (what the Cancel button, Esc and the close box do). */
  close(): void;
  /** Closes it because the work finished (not a cancel). */
  done(): void;
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
  const win = openWindow({ id, title, icon: 'disk', body, width: 380, height: 120 + CHROME_H, minHeight: 60, resizable: false, modal: activeWin(), onClose: () => void finish(true), esc: () => handle.close() });
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
    if (!flickered && performance.now() - lastUpdate > 4000) {
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
    done() {
      finish(false);
      win.opts.onClose = undefined;
      win.close();
    },
  };
  return handle;
}

/** Ends a progress dialog because the work finished (not a cancel). */
export function progressDone(p: ProgressHandle) {
  p.done();
}
