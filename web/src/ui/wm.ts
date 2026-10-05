// Window manager: Windows 98 windows on the desktop (bevel frame, gradient caption, 8 resize zones, size
// grip, system menu, caption-zoom animation, modal owners), full-screen sheets on phones.
import { h, setText, clamp } from './dom';
import { iconImg, bayerMask } from './art';
import { applyChromeVars } from './art-chrome';
import { ui, onScale, toUi, uiRect } from './scale';
import { showMenu, menuAt, mnemonicLabel, type MenuItem } from './menu';
import { reducedMotion } from '../settings';
import { EDGES, RZ_EDGE, RZ_CORNER, RZ_TOUCH_OUT, edgeCursor, zoneBox, zoneClip, resizeRect, moveRect, trackDrag, type Edge, type Rect } from './wm-drag';
import { animateCaption, CAPTION_H } from './wm-anim';

export type { Rect, Edge };

export interface WinOpts {
  id: string;
  title: string;
  icon: string;
  body: HTMLElement;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  resizable?: boolean;
  /** Smallest size the user can drag the window to (defaults 200×100). */
  minWidth?: number;
  minHeight?: number;
  menu?: { label: string; items: () => MenuItem[] }[];
  status?: HTMLElement[];
  /** Keep the status bar on phones too (they hide it to save room; some windows show their only readout there). */
  phoneStatus?: boolean;
  onClose?: () => boolean | void;
  onResize?: () => void;
  onShow?: () => void;
  /** Taskbar label on phones. */
  short?: string;
  /** Owner window: this one is modal to it (clicks on the owner flash this caption instead). */
  modal?: Win | null;
  /** Dialog keys, handled on the whole window, so they also work with the focus on the caption or frame.
   *  Enter runs `enter` unless a button, drop-down or text area has the focus (they use Enter themselves);
   *  Esc runs `esc`. Windows with either, and modal ones, keep Tab inside them. */
  enter?: (target: HTMLElement) => void;
  esc?: () => void;
}

export interface Win {
  id: string;
  opts: WinOpts;
  el: HTMLElement;
  body: HTMLElement;
  frame: HTMLElement;
  foldySlot: HTMLElement;
  statusEl: HTMLElement;
  titleText: HTMLElement;
  minimized: boolean;
  maximized: boolean;
  setTitle(t: string): void;
  setStatus(parts: (string | HTMLElement)[]): void;
  /** Counts busy marks. After 500 ms busy, `scope` (default: the window body) shows the working-in-background
   *  cursor. Nothing is painted over the window. */
  setBusy(b: boolean, opts?: { scope?: HTMLElement }): void;
  notResponding(): void;
  close(): void;
  focus(): void;
  /** Minimises, or restores when minimised. */
  minimize(): void;
  toggleMax(): void;
}

const wins: Win[] = [];
let layer: HTMLElement | null = null;
let active: Win | null = null;
type Listener = () => void;
const listeners = new Set<Listener>();
let cascade = 0;
let taskbarRect: ((id: string) => Rect | null) | null = null;
/** Per-window internals the system menu and keyboard need. */
const internals = new WeakMap<Win, { icon: HTMLElement; flash: () => void; kbMove: (size: boolean) => void; refocus: () => void }>();

/** `taskbarRect(id)` gives the window's taskbar button in UI px (for the minimise/restore animation). */
export function initWm(el: HTMLElement, opts: { taskbarRect?: (id: string) => Rect | null } = {}) {
  layer = el;
  taskbarRect = opts.taskbarRect ?? null;
  applyChromeVars(document.documentElement);
  onScale(() => {
    for (const w of wins) {
      keepInside(w);
      w.opts.onResize?.();
    }
    applyPhoneVisibility();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'F6' && wins.length) {
      e.preventDefault();
      const vis = wins.filter((w) => !w.minimized);
      const i = active ? vis.indexOf(active) : -1;
      vis[(i + 1) % vis.length]?.focus();
    } else if (e.altKey && e.code === 'Space' && active && !ui.phone) {
      e.preventDefault();
      systemMenu(active, undefined, true);
    } else if (e.altKey && e.key === 'F4' && active) {
      // (only where the browser lets the page have it, e.g. a kiosk; the menus don't advertise it)
      e.preventDefault();
      active.close();
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
      // never the browser's own Open dialog: the active window's Ctrl+O command, if it has one
      e.preventDefault();
      const it = active && menuCommand(active, 'Ctrl+O');
      if (it) it.onClick?.();
    }
  });
}

/** The enabled menu-bar command of `w` that shows the accelerator `acc`. */
export function menuCommand(w: Win, acc: string): MenuItem | null {
  const find = (items: MenuItem[]): MenuItem | null => {
    for (const it of items) {
      if (it.disabled) continue;
      if (it.acc === acc && it.onClick) return it;
      const sub = it.sub && find(typeof it.sub === 'function' ? it.sub() : it.sub);
      if (sub) return sub;
    }
    return null;
  };
  for (const m of w.opts.menu ?? []) {
    const it = find(m.items());
    if (it) return it;
  }
  return null;
}

/** Tab and Shift+Tab inside a dialog: past the last control back to the first, and the other way round. */
function tabCycle(e: KeyboardEvent, el: HTMLElement) {
  const all = [...el.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')].filter(
    (x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled && x.getClientRects().length > 0 && !x.closest('[inert]'),
  );
  // a radio group is one stop: its checked radio, or its first one
  const list = all.filter((x) => {
    if (!(x instanceof HTMLInputElement) || x.type !== 'radio' || !x.name) return true;
    const group = all.filter((y): y is HTMLInputElement => y instanceof HTMLInputElement && y.type === 'radio' && y.name === x.name);
    return x === (group.find((y) => y.checked) ?? group[0]);
  });
  const cur = document.activeElement as HTMLElement | null;
  const i = list.findIndex((x) => x === cur || (cur instanceof HTMLInputElement && cur.type === 'radio' && x instanceof HTMLInputElement && x.type === 'radio' && x.name === cur.name && !!cur.name));
  if (!list.length) {
    e.preventDefault();
    el.focus({ preventScroll: true });
  } else if (e.shiftKey ? i <= 0 : i < 0 || i === list.length - 1) {
    e.preventDefault();
    list[e.shiftKey ? list.length - 1 : 0].focus();
  }
}

export function onWm(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function emit() {
  for (const l of listeners) l();
}

export function windows(): Win[] {
  return wins.slice();
}

export function activeWin(): Win | null {
  return active;
}

export function getWin(id: string): Win | undefined {
  return wins.find((w) => w.id === id);
}

/** The open window that is modal to `w` (the newest one), if any. */
export function modalOf(w: Win): Win | null {
  for (let i = wins.length - 1; i >= 0; i--) if (wins[i].opts.modal === w) return wins[i];
  return null;
}

function deskSize() {
  const tb = (layer && parseInt(getComputedStyle(layer).getPropertyValue('--taskbar-h'))) || (ui.phone ? 56 : 30);
  return { w: ui.w, h: ui.h - tb };
}

function geom(el: HTMLElement): Rect {
  return {
    x: parseInt(el.style.left) || 0,
    y: parseInt(el.style.top) || 0,
    w: parseInt(el.style.width) || el.offsetWidth,
    h: parseInt(el.style.height) || el.offsetHeight,
  };
}

function setGeom(el: HTMLElement, r: Rect) {
  el.style.left = r.x + 'px';
  el.style.top = r.y + 'px';
  el.style.width = r.w + 'px';
  el.style.height = r.h + 'px';
}

/** Latest dissolve per window: a close that starts during the open dissolve takes over from it. */
const animGen = new WeakMap<HTMLElement, number>();

/** Open and close: the window dissolves in or out through an 8×8 Bayer screen door, in 8 steps. */
async function ditherAnim(el: HTMLElement, from: number, to: number) {
  if (reducedMotion()) return;
  const gen = (animGen.get(el) ?? 0) + 1;
  animGen.set(el, gen);
  el.classList.add('anim');
  const steps = 8;
  for (let s = 0; s <= steps; s++) {
    if (animGen.get(el) !== gen) return;
    const lvl = Math.round(from + ((to - from) * s) / steps);
    el.style.setProperty('--fade-mask', `url("${bayerMask(lvl, ui.k)}")`);
    await new Promise((r) => setTimeout(r, 22));
  }
  if (animGen.get(el) === gen) el.classList.remove('anim');
}

/** The outline Windows 98 drags instead of the window ("Show window contents while dragging" off). */
function dragFrame(win: HTMLElement) {
  const f = document.createElement('div');
  f.className = 'drag-frame' + (win.classList.contains('fixed') ? ' fixed' : '');
  layer!.appendChild(f);
  return {
    set(r: Rect) {
      setGeom(f, r);
    },
    remove() {
      f.remove();
    },
  };
}

function keepInside(w: Win) {
  if (ui.phone) return;
  const d = deskSize();
  const el = w.el;
  if (el.classList.contains('max')) {
    setGeom(el, { x: 0, y: 0, w: d.w, h: d.h });
    return;
  }
  const g = geom(el);
  // the size the window wants (opened or resized to), so a trip through 3× UI scale doesn't shrink it for good
  const ww = Math.min(Number(el.dataset.ww) || g.w, d.w);
  const hh = Math.min(Number(el.dataset.wh) || g.h, d.h);
  // after a UI scale change the whole window must be reachable again (its OK button may be at the edge)
  setGeom(el, { x: clamp(g.x, 0, Math.max(0, d.w - ww)), y: clamp(g.y, 0, Math.max(0, d.h - hh)), w: ww, h: hh });
}

function restack() {
  wins.forEach((w, i) => (w.el.style.zIndex = String(10 + i)));
  applyPhoneVisibility();
}

function applyPhoneVisibility() {
  for (const w of wins) {
    const hide = w.minimized || (ui.phone && w !== active) || w.el.dataset.zoom === '1';
    w.el.classList.toggle('hidden', hide);
    w.el.setAttribute('aria-hidden', hide ? 'true' : 'false');
  }
}

function topmost(): Win | undefined {
  return [...wins].reverse().find((w) => !w.minimized);
}

/** Shows the system menu (Restore, Move, Size, Minimize, Maximize, Close) at a point in UI px, or under the
 *  caption icon. */
export function systemMenu(w: Win, at?: { x: number; y: number }, keyboard = false) {
  const r = w.opts.resizable !== false;
  const normal = !w.minimized && !w.maximized;
  const it = internals.get(w);
  // no "Alt+F4": the browser or the OS takes that key and closes the whole browser window
  const close: MenuItem = { label: '&Close', default: true, onClick: () => w.close() };
  const items: MenuItem[] = r
    ? [
        { label: '&Restore', disabled: normal, onClick: () => (w.minimized ? w.minimize() : w.toggleMax()) },
        { label: '&Move', disabled: !normal || ui.phone, onClick: () => it?.kbMove(false) },
        { label: '&Size', disabled: !normal || ui.phone, onClick: () => it?.kbMove(true) },
        { label: 'Mi&nimize', disabled: w.minimized, onClick: () => w.minimize() },
        {
          label: 'Ma&ximize',
          disabled: w.maximized || ui.phone,
          onClick: () => {
            if (w.minimized) w.minimize();
            w.toggleMax();
          },
        },
        { sep: true },
        close,
      ]
    : [{ label: '&Move', disabled: ui.phone, onClick: () => it?.kbMove(false) }, close];
  if (at) showMenu(items, at.x, at.y, { label: 'System menu', keyboard });
  else if (it && !w.minimized) menuAt(it.icon, items, { label: 'System menu', keyboard });
}

export function openWindow(o: WinOpts): Win {
  const existing = getWin(o.id);
  if (existing) {
    if (existing.minimized) existing.minimize();
    existing.focus();
    return existing;
  }
  if (!layer) throw new Error('wm not ready');
  const resizable = o.resizable !== false;
  const titleText = h('span', { class: 'ttl' }, o.title);
  const capIcon = iconImg(o.icon, 16);
  capIcon.classList.add('cap-ico');
  let win: Win;
  const cbtn = (kind: 'min' | 'max' | 'close', label: string, f: () => void) => {
    const b = h('button', { class: 'tbtn ' + kind, type: 'button', tabIndex: -1, 'aria-label': label, dataset: { k: kind } });
    b.addEventListener('click', (e) => (e.stopPropagation(), f()));
    b.addEventListener('dblclick', (e) => e.stopPropagation());
    return b;
  };
  const bMin = cbtn('min', 'Minimize', () => win.minimize());
  const bMax = cbtn('max', 'Maximize', () => win.toggleMax());
  const bClose = cbtn('close', 'Close', () => win.close());
  // on phones the menu bar folds into one "Menu" button in the title bar
  const tmenu = o.menu ? h('button', { class: 'tmenu', 'aria-haspopup': 'true', 'aria-label': 'Menu' }, 'Menu') : null;
  if (tmenu)
    tmenu.onclick = (e) => {
      e.stopPropagation();
      const items: MenuItem[] = [];
      for (const m of o.menu!) items.push({ head: m.label }, ...m.items());
      menuAt(tmenu, items, { label: 'Menu' });
    };
  const title = h('div', { class: 'win-title' }, capIcon, titleText, tmenu, h('div', { class: 'win-btns' }, resizable ? [bMin, bMax] : null, bClose));
  const menuBar = o.menu
    ? h(
        'div',
        { class: 'win-menu', role: 'menubar' },
        o.menu.map((m) => {
          const b = h('button', { role: 'menuitem', 'aria-haspopup': 'true' }, mnemonicLabel(m.label));
          b.onclick = () => {
            b.classList.add('open');
            menuAt(b, m.items(), { onClose: () => b.classList.remove('open'), label: m.label });
          };
          return b;
        }),
      )
    : null;
  const statusEl = h('div', { class: 'win-status', role: 'status' });
  if (!o.status) statusEl.style.display = 'none';
  else statusEl.append(...o.status);
  const foldySlot = h('div', { class: 'win-foldy', 'aria-live': 'polite' });
  const bodyWrap = h('div', { class: 'win-body' }, o.body);
  const frame = h('div', { class: 'win-frame' }, menuBar, bodyWrap, foldySlot, statusEl);
  const grip = resizable ? h('div', { class: 'win-grip', 'aria-hidden': 'true' }) : null;
  // a finger needs more than the 4 px frame (tablets get the desktop layout): the zones reach outside it
  const out = matchMedia('(pointer: coarse)').matches ? RZ_TOUCH_OUT : 0;
  const zones = resizable
    ? EDGES.map((edge) => {
        const z = h('div', { class: 'win-rz', 'aria-hidden': 'true', dataset: { edge } });
        for (const [k, v] of Object.entries(zoneBox(edge, RZ_EDGE, RZ_CORNER, out))) z.style.setProperty(k, v + 'px');
        const cp = zoneClip(edge, RZ_EDGE + out, RZ_CORNER + out);
        if (cp) z.style.clipPath = cp;
        z.style.cursor = edgeCursor(edge);
        z.addEventListener('pointerdown', (e) => startResize(e, z, edge));
        return z;
      })
    : [];
  const el = h(
    'section',
    { class: 'win' + (resizable ? '' : ' fixed') + (o.status ? '' : ' nostatus') + (o.phoneStatus ? ' phstatus' : ''), role: 'dialog', 'aria-label': o.title, tabIndex: -1 },
    title,
    frame,
    grip,
    zones,
  );
  const d = deskSize();
  const W = Math.min(o.width ?? 640, d.w - 8);
  const H = Math.min(o.height ?? 440, d.h - 8);
  let x = o.x ?? clamp(Math.round((d.w - W) / 2) + ((cascade * 22) % 120) - 60, 0, Math.max(0, d.w - W));
  let y = o.y ?? clamp(Math.round((d.h - H) / 3) + ((cascade * 22) % 120) - 40, 0, Math.max(0, d.h - H));
  if (o.modal && o.x === undefined && o.y === undefined && !o.modal.minimized) {
    // 98 dialogs open centred on their owner
    const g = geom(o.modal.el);
    x = clamp(Math.round(g.x + (g.w - W) / 2), 0, Math.max(0, d.w - W));
    y = clamp(Math.round(g.y + (g.h - H) / 2), 0, Math.max(0, d.h - H));
  } else cascade++;
  setGeom(el, { x, y, w: W, h: H });
  el.dataset.ww = String(o.width ?? 640);
  el.dataset.wh = String(o.height ?? 440);

  let restoreRect: Rect | null = null;
  /** The control that last had the focus here: it gets it back when the window does (e.g. after a modal box). */
  let lastFocus: HTMLElement | null = null;
  const refocus = () => (lastFocus?.isConnected && el.contains(lastFocus) ? lastFocus : el).focus({ preventScroll: true });
  /** Ends a keyboard Move/Size that is under way (undoing it). */
  let kbEnd: ((keep: boolean) => void) | null = null;
  let maxApplied = false;
  let maxAnim = false;
  const busy = new Map<HTMLElement, { n: number; t: ReturnType<typeof setTimeout> | null }>();
  const minSize = () => ({ w: o.minWidth ?? 200, h: o.minHeight ?? 100 });

  /** Caption rect in host UI px for a window rect (laid out or not). */
  const capOf = (r: Rect, max: boolean): Rect => {
    const L = layer ? uiRect(layer) : { x: 0, y: 0 };
    const f = max ? 0 : resizable ? 4 : 3;
    return { x: L.x + r.x + f, y: L.y + r.y + f, w: r.w - 2 * f, h: CAPTION_H };
  };
  const zoom = (from: Rect | null, to: Rect | null, isActive = true): Promise<void> => {
    if (!from || !to || reducedMotion() || ui.phone || !layer) return Promise.resolve();
    const host = layer.parentElement ?? layer;
    return animateCaption(host, from, to, { active: isActive, content: [iconImg(o.icon, 16), h('span', { class: 'ttl' }, o.title)] });
  };
  const applyMax = () => {
    if (win.maximized === maxApplied) return;
    if (win.maximized) {
      const dd = deskSize();
      setGeom(el, { x: 0, y: 0, w: dd.w, h: dd.h });
    } else if (restoreRect) {
      // the screen may have shrunk (rotation, UI scale) while it was maximised
      const dd = deskSize();
      const w = Math.min(restoreRect.w, dd.w);
      const hh = Math.min(restoreRect.h, dd.h);
      setGeom(el, { x: clamp(restoreRect.x, 0, Math.max(0, dd.w - w)), y: clamp(restoreRect.y, 0, Math.max(0, dd.h - hh)), w, h: hh });
      restoreRect = null;
    }
    maxApplied = win.maximized;
    el.classList.toggle('max', maxApplied);
    bMax.dataset.k = maxApplied ? 'restore' : 'max';
    bMax.setAttribute('aria-label', maxApplied ? 'Restore' : 'Maximize');
    o.onResize?.();
    emit();
  };

  win = {
    id: o.id,
    opts: o,
    el,
    body: o.body,
    frame,
    foldySlot,
    statusEl,
    titleText,
    minimized: false,
    maximized: false,
    setTitle(t: string) {
      setText(titleText, t);
      el.setAttribute('aria-label', t);
      o.title = t;
      emit();
    },
    setStatus(parts) {
      statusEl.style.display = '';
      el.classList.remove('nostatus');
      statusEl.replaceChildren(...parts.map((p, i) => (typeof p === 'string' ? h('div', { class: i === 0 ? 'grow' : '' }, p) : p)));
    },
    setBusy(b: boolean, opts?: { scope?: HTMLElement }) {
      const scope = opts?.scope ?? bodyWrap;
      let s = busy.get(scope);
      if (!s) busy.set(scope, (s = { n: 0, t: null }));
      const st = s;
      st.n = Math.max(0, st.n + (b ? 1 : -1));
      if (st.n > 0 && !st.t && !scope.classList.contains('wm-busy'))
        st.t = setTimeout(() => {
          st.t = null;
          if (st.n > 0) scope.classList.add('wm-busy');
        }, 500);
      if (st.n === 0) {
        if (st.t) clearTimeout(st.t);
        scope.classList.remove('wm-busy');
        busy.delete(scope);
      }
      el.setAttribute('aria-busy', [...busy.values()].some((v) => v.n > 0) ? 'true' : 'false');
    },
    notResponding() {
      const t = o.title;
      setText(titleText, t + ' (Not Responding)');
      setTimeout(() => setText(titleText, o.title === t ? t : o.title), 1100);
    },
    close() {
      if (!wins.includes(win)) return;
      if (o.onClose && o.onClose() === false) return;
      kbEnd?.(false);
      // a closing owner takes its modal windows with it
      for (const m of wins.filter((w) => w.opts.modal === win)) m.close();
      const i = wins.indexOf(win);
      if (i >= 0) wins.splice(i, 1);
      if (active === win) active = null;
      for (const s of busy.values()) if (s.t) clearTimeout(s.t);
      busy.clear();
      el.classList.remove('active');
      el.classList.add('closing');
      // Gone for input, focus and assistive tech at once; only the dissolve is still on screen.
      el.inert = true;
      el.setAttribute('aria-hidden', 'true');
      el.removeAttribute('role');
      void ditherAnim(el, 64, 0).then(() => el.remove());
      const next = o.modal && wins.includes(o.modal) && !o.modal.minimized ? o.modal : topmost();
      if (next) next.focus();
      else {
        restack();
        emit();
      }
    },
    focus() {
      if (!wins.includes(win)) return;
      const i = wins.indexOf(win);
      wins.splice(i, 1);
      wins.push(win);
      const m = modalOf(win);
      if (m && !m.minimized) {
        // the owner comes up, but its modal window takes the focus
        m.focus();
        return;
      }
      const prev = active;
      active = win;
      for (const w of wins) w.el.classList.toggle('active', w === active);
      restack();
      if (prev !== win) {
        if (!el.contains(document.activeElement)) refocus();
        o.onShow?.();
      }
      emit();
    },
    minimize() {
      if (!win.minimized) {
        if (!wins.includes(win)) return;
        kbEnd?.(false);
        const from = el.classList.contains('hidden') ? null : uiRect(title);
        const wasActive = active === win;
        win.minimized = true;
        applyPhoneVisibility();
        if (active === win) {
          active = null;
          el.classList.remove('active');
          const next = topmost();
          if (next) next.focus();
          else emit();
        } else emit();
        void zoom(from, taskbarRect?.(o.id) ?? null, wasActive);
      } else {
        const to = capOf(geom(el), maxApplied);
        const from = taskbarRect?.(o.id) ?? null;
        win.minimized = false;
        // stays hidden while the caption zooms out of the taskbar
        el.dataset.zoom = '1';
        void zoom(from, to).then(() => {
          delete el.dataset.zoom;
          applyPhoneVisibility();
          if (win.minimized || !wins.includes(win)) return;
          win.focus();
          if (active === win && !el.contains(document.activeElement)) refocus();
        });
      }
    },
    toggleMax() {
      if (ui.phone || !resizable) return;
      kbEnd?.(false);
      if (!win.maximized && !maxApplied) restoreRect = geom(el);
      const from = capOf(geom(el), maxApplied);
      win.maximized = !win.maximized;
      if (maxAnim) return; // the running animation applies the latest state
      const dd = deskSize();
      const to = win.maximized ? capOf({ x: 0, y: 0, w: dd.w, h: dd.h }, true) : restoreRect ? capOf(restoreRect, false) : null;
      if (win.minimized) return applyMax();
      maxAnim = true;
      void zoom(from, to, active === win).then(() => {
        maxAnim = false;
        applyMax();
      });
    },
  };

  // modal owners take no input: the click flashes the modal window's caption and focuses it instead
  const block = (e: Event) => {
    const m = modalOf(win);
    if (!m) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'pointerdown') {
      m.focus();
      internals.get(m)?.flash();
    }
  };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown']) el.addEventListener(t, block, true);

  // activate on any pointer down
  el.addEventListener('pointerdown', () => {
    if (active !== win) win.focus();
  }, true);
  el.addEventListener('focusin', (e) => {
    const m = modalOf(win);
    if (m) {
      // the keyboard focus goes back into the modal window, too
      m.focus();
      if (!m.el.contains(document.activeElement)) internals.get(m)?.refocus();
      return;
    }
    if (e.target !== el) lastFocus = e.target as HTMLElement;
    if (active !== win) win.focus();
  });
  const trapTab = !!(o.enter || o.esc || o.modal !== undefined);
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Escape' && o.esc) {
      e.preventDefault();
      e.stopPropagation();
      o.esc();
    } else if (e.key === 'Enter' && o.enter && !e.altKey && !t.closest('button, textarea, .combo')) {
      e.preventDefault();
      o.enter(t);
    } else if (e.key === 'Tab' && trapTab && !e.ctrlKey && !e.altKey) tabCycle(e, el);
  });

  // dragging by the caption: an outline frame follows the pointer, the window moves there on release
  title.addEventListener('pointerdown', (e) => {
    if (ui.phone || win.maximized || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, .cap-ico')) return;
    const r0 = geom(el);
    const desk = deskSize();
    let frame: ReturnType<typeof dragFrame> | null = null;
    trackDrag(
      e,
      title,
      toUi,
      (dx, dy) => {
        frame ??= dragFrame(el);
        frame.set({ ...r0, ...moveRect(r0, dx, dy, desk) });
      },
      (dx, dy, moved) => {
        frame?.remove();
        if (!moved) return;
        const p = moveRect(r0, dx, dy, desk);
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
      },
    );
  });
  title.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.cap-ico')) win.close();
    else if (!(e.target as HTMLElement).closest('button')) win.toggleMax();
  });
  title.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!ui.phone) systemMenu(win, toUi(e));
  });
  capIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ui.phone) systemMenu(win);
  });

  function startResize(e: PointerEvent, target: HTMLElement, edge: Edge) {
    if (ui.phone || win.maximized || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r0 = geom(el);
    const min = minSize();
    let frame: ReturnType<typeof dragFrame> | null = null;
    trackDrag(
      e,
      target,
      toUi,
      (dx, dy) => {
        frame ??= dragFrame(el);
        frame.set(resizeRect(r0, edge, dx, dy, min));
      },
      (dx, dy, moved) => {
        frame?.remove();
        if (!moved) return;
        const r = resizeRect(r0, edge, dx, dy, min);
        setGeom(el, r);
        el.dataset.ww = String(r.w);
        el.dataset.wh = String(r.h);
        o.onResize?.();
        emit();
      },
    );
  }
  grip?.addEventListener('pointerdown', (e) => startResize(e, grip, 'se'));

  // keyboard Move / Size from the system menu: arrows (Ctrl for 1 px), Enter keeps, Esc undoes
  const kbMove = (size: boolean) => {
    if (ui.phone || win.maximized || win.minimized) return;
    const start = geom(el);
    let r = { ...start };
    let edge: Edge | null = null;
    const min = minSize();
    el.classList.add('kbmove');
    const frame = dragFrame(el);
    frame.set(r);
    kbEnd?.(false);
    const end = (keep: boolean) => {
      kbEnd = null;
      removeEventListener('keydown', key, true);
      removeEventListener('pointerdown', down, true);
      el.classList.remove('kbmove');
      frame.remove();
      setGeom(el, keep ? r : start);
      el.dataset.ww = String(keep ? r.w : start.w);
      el.dataset.wh = String(keep ? r.h : start.h);
      if (size) o.onResize?.();
      emit();
    };
    const key = (e: KeyboardEvent) => {
      const s = e.ctrlKey ? 1 : 8;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -s;
      else if (e.key === 'ArrowRight') dx = s;
      else if (e.key === 'ArrowUp') dy = -s;
      else if (e.key === 'ArrowDown') dy = s;
      else if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return end(e.key === 'Enter');
      } else return;
      e.preventDefault();
      e.stopPropagation();
      if (size) {
        // the first arrow picks the edge, a perpendicular arrow adds the corner
        if (!edge) edge = dx < 0 ? 'w' : dx > 0 ? 'e' : dy < 0 ? 'n' : 's';
        else if (dx && !/[ew]/.test(edge)) edge = (edge + (dx < 0 ? 'w' : 'e')) as Edge;
        else if (dy && !/[ns]/.test(edge)) edge = ((dy < 0 ? 'n' : 's') + edge) as Edge;
        r = resizeRect(r, edge, dx, dy, min);
      } else r = { ...r, ...moveRect(r, dx, dy, deskSize()) };
      frame.set(r);
    };
    const down = () => end(true);
    kbEnd = end;
    addEventListener('keydown', key, true);
    addEventListener('pointerdown', down, true);
  };

  // FlashWindow: the caption blinks between active and inactive a few times
  let flashT: ReturnType<typeof setInterval> | null = null;
  const flash = () => {
    if (flashT) clearInterval(flashT);
    let n = 0;
    flashT = setInterval(() => {
      el.classList.toggle('flash', n % 2 === 0);
      if (++n >= 8) {
        clearInterval(flashT!);
        flashT = null;
        el.classList.remove('flash');
      }
    }, 70);
  };
  internals.set(win, { icon: capIcon, flash, kbMove, refocus });

  layer.appendChild(el);
  wins.push(win);
  win.focus();
  void ditherAnim(el, 0, 64);
  requestAnimationFrame(() => o.onResize?.());
  emit();
  return win;
}
