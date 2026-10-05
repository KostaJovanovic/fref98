// The Windows 98 taskbar: 28 px grey bar with a raised top edge, the Start button (54×22, pressed while the
// menu is open), a grip, one task button per window (up to 160 px, shrinking to fit; the active window's
// button pressed in with the dithered face and bold text) and the tray. Right-click menus for the empty
// taskbar (Cascade / Tile / Minimize All), the Start button and the clock. Ctrl+Esc (and a lone Win key)
// open Start.
import { h, setText } from '../ui/dom';
import { iconImg } from '../ui/art';
import { ui, onScale, uiRect, toUi } from '../ui/scale';
import { onWm, windows, activeWin, systemMenu, type Win } from '../ui/wm';
import { registerContext } from '../ui/contextmenu';
import type { MenuItem } from '../ui/menu';
import { APPS } from '../apps/registry';
import { toggleStartMenu, taskbarProperties, isStartOpen } from './startmenu';
import { buildTray, adjustDateTime } from './tray';
import { cascadeRects, tileRects, type Box } from './desktop-grid';

let startBtn: HTMLElement | null = null;

export function buildTaskbar(): HTMLElement {
  const start = h('button', { class: 'start', type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Start', 'data-tip': 'Click here to begin.' }, iconImg('folder', 16), h('b', null, 'Start'));
  startBtn = start;
  start.addEventListener('pointerdown', (e) => {
    // 98 opens the Start menu on the press, not the release
    if (e.button !== 0) return;
    e.preventDefault();
    toggleStartMenu(start);
  });
  start.addEventListener('click', (e) => {
    // keyboard (Enter/Space) clicks have no pointer press
    if (e.detail === 0) toggleStartMenu(start, true);
  });
  const grip = h('div', { class: 'tb-grip', 'aria-hidden': 'true' });
  const tasks = h('div', { class: 'tasks', role: 'tablist', 'aria-label': 'Open windows' });
  const bar = h('nav', { class: 'taskbar', 'aria-label': 'Taskbar' }, start, grip, tasks, buildTray());

  // buttons keep the order the windows opened in (windows() is the z-order, which changes on every focus)
  const btns = new Map<string, HTMLButtonElement>();
  const renderTasks = () => {
    const list = windows();
    const act = activeWin();
    for (const [id, b] of btns) if (!list.some((w) => w.id === id)) (b.remove(), btns.delete(id));
    for (const w of list) {
      let b = btns.get(w.id);
      if (!b) {
        b = taskButton(w);
        btns.set(w.id, b);
        tasks.appendChild(b);
      }
      const info = APPS[w.id];
      const label = ui.phone ? w.opts.short ?? info?.short ?? w.opts.title : w.opts.title;
      const on = w === act && !w.minimized;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.dataset.tip = w.opts.title;
      setText(b.querySelector<HTMLElement>('.tl')!, label);
    }
  };
  onWm(renderTasks);
  onScale(renderTasks);
  renderTasks();

  registerMenus();
  installKeys();
  return bar;
}

function taskButton(w: Win): HTMLButtonElement {
  const b = h('button', { class: 'task', type: 'button', role: 'tab', dataset: { win: w.id } }, iconImg(w.opts.icon, 16), h('span', { class: 'tl' }, ''));
  b.addEventListener('click', () => {
    if (w === activeWin() && !w.minimized && !ui.phone) w.minimize();
    else if (w.minimized) w.minimize();
    else w.focus();
  });
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!ui.phone) systemMenu(w, toUi(e));
  });
  return b;
}

/** A window's taskbar button in UI px (the minimise/restore caption animation flies to it). */
export function taskbarRect(id: string): { x: number; y: number; w: number; h: number } | null {
  const b = document.querySelector<HTMLElement>(`.taskbar .task[data-win="${CSS.escape(id)}"]`);
  return b ? uiRect(b) : null;
}

// ------------------------------------------------------------------ Cascade / Tile / Minimize All

interface Saved {
  w: Win;
  g: Box;
  max: boolean;
  min: boolean;
}
let undo: { label: string; saved: Saved[] } | null = null;

const geomOf = (w: Win): Box => ({ x: parseInt(w.el.style.left) || 0, y: parseInt(w.el.style.top) || 0, w: parseInt(w.el.style.width) || w.el.offsetWidth, h: parseInt(w.el.style.height) || w.el.offsetHeight });

function setGeom(w: Win, r: Box) {
  const s = w.el.style;
  s.left = r.x + 'px';
  s.top = r.y + 'px';
  s.width = r.w + 'px';
  s.height = r.h + 'px';
  w.el.dataset.ww = String(r.w);
  w.el.dataset.wh = String(r.h);
  w.opts.onResize?.();
}

/** Windows Cascade / Tile can move: open, not minimised, not modal message boxes. Bottom of the stack first. */
const arrangeable = () => windows().filter((w) => !w.minimized && !w.opts.modal);

function arrangeWindows(kind: 'cascade' | 'h' | 'v') {
  const desk = document.querySelector<HTMLElement>('.desktop');
  if (!desk || ui.phone) return;
  const list = arrangeable().filter((w) => kind === 'cascade' || w.opts.resizable !== false);
  if (!list.length) return;
  undo = { label: kind === 'cascade' ? '&Undo Cascade' : '&Undo Tile', saved: list.map((w) => ({ w, g: geomOf(w), max: w.maximized, min: false })) };
  const W = desk.clientWidth;
  const H = desk.clientHeight;
  const place = () => {
    if (kind === 'cascade') {
      cascadeRects(list.length, W, H).forEach((r, i) => {
        const w = list[i];
        const fixed = w.opts.resizable === false;
        const g = geomOf(w);
        setGeom(w, fixed ? { x: r.x, y: r.y, w: g.w, h: g.h } : r);
      });
    } else {
      // the top window takes the first tile
      const top = [...list].reverse();
      tileRects(top.length, W, H, kind).forEach((r, i) => setGeom(top[i], r));
    }
  };
  // maximised windows restore first (their caption zoom runs ~200 ms), then everything is placed
  const maxed = list.filter((w) => w.maximized);
  for (const w of maxed) w.toggleMax();
  if (maxed.length) setTimeout(place, 260);
  else place();
}

function minimizeAll() {
  const list = windows().filter((w) => !w.minimized);
  if (!list.length) return;
  undo = { label: '&Undo Minimize All', saved: list.map((w) => ({ w, g: geomOf(w), max: w.maximized, min: true })) };
  for (const w of list) w.minimize();
}

function undoArrange() {
  const u = undo;
  undo = null;
  if (!u) return;
  const open = new Set(windows());
  for (const s of u.saved) {
    if (!open.has(s.w)) continue;
    if (s.min) {
      if (s.w.minimized) s.w.minimize();
      continue;
    }
    setGeom(s.w, s.g);
    if (s.max && !s.w.maximized) s.w.toggleMax();
  }
}

export function taskbarMenu(): MenuItem[] {
  const n = arrangeable().length;
  const items: MenuItem[] = [
    { label: '&Cascade Windows', disabled: !n || ui.phone, onClick: () => arrangeWindows('cascade') },
    { label: 'Tile Windows &Horizontally', disabled: !n || ui.phone, onClick: () => arrangeWindows('h') },
    { label: 'Tile Windows V&ertically', disabled: !n || ui.phone, onClick: () => arrangeWindows('v') },
    { label: '&Minimize All Windows', disabled: !windows().some((w) => !w.minimized), onClick: minimizeAll },
  ];
  if (undo && undo.saved.some((s) => windows().includes(s.w))) items.push({ label: undo.label, onClick: undoArrange });
  items.push({ sep: true }, { label: 'P&roperties', onClick: taskbarProperties });
  return items;
}

function registerMenus() {
  registerContext('.taskbar', () => taskbarMenu());
  registerContext('.taskbar .start', (el) => [
    { label: '&Open', default: true, onClick: () => toggleStartMenu(el as HTMLElement, true) },
    { label: '&Explore', disabled: true },
    { label: '&Find…', disabled: true },
  ]);
  registerContext('.tray .clock', () => [{ label: '&Adjust Date/Time', default: true, onClick: adjustDateTime }, { sep: true }, ...taskbarMenu()]);
}

// ------------------------------------------------------------------ keyboard

function installKeys() {
  let winAlone = false;
  addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (startBtn) toggleStartMenu(startBtn, true);
      }
      winAlone = e.key === 'Meta' || e.key === 'OS';
    },
    true,
  );
  // a Win key pressed and released on its own (when the OS lets the page see it; not the Mac's Command key)
  if (/Mac|iPhone|iPad/.test(navigator.platform)) return;
  addEventListener('keyup', (e) => {
    if ((e.key === 'Meta' || e.key === 'OS') && winAlone && startBtn && !isStartOpen()) toggleStartMenu(startBtn, true);
    winAlone = false;
  });
}
