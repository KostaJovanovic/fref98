// The Windows 98 desktop: icons from a list of registry ids on the 75×75 grid (snap-to-grid drag of the
// selection, positions saved in settings.iconPos), rubber-band selection (Ctrl toggles, Shift adds), keyboard
// (arrows, Home/End, Enter, F2 rename, Ctrl+A, type-ahead) and the desktop / icon / Recycle Bin menus. The icons
// are apps, and the bin holds photos, steps and projects, so nothing on the desktop can be deleted.
import { h, setText } from '../ui/dom';
import { iconImg, icon } from '../ui/art';
import { ui, onScale, toUi, uiRect } from '../ui/scale';
import { trackDrag } from '../ui/wm-drag';
import { registerContext } from '../ui/contextmenu';
import { message } from '../ui/dialog';
import type { MenuItem } from '../ui/menu';
import { APPS, openApp } from '../apps/registry';
import { store } from '../state';
import { settings, setSettings } from '../settings';
import * as G from './desktop-grid';

/** The desktop icons, by registry id, in their first-run order. Cutting an app means removing it from APPS
 *  (or from this list). */
const DESKTOP_ICONS = ['card', 'pictures', 'editor', 'presets', 'recycle', 'help'];

/** Desktop labels that differ from the window title. */
const LABELS: Record<string, string> = { help: 'Help' };
/** "Type" for Arrange Icons ▸ by Type and Properties. */
const TYPES: Record<string, string> = { card: 'Removable Disk', pictures: 'System Folder', recycle: 'Recycle Bin', presets: 'File Folder', help: 'Help File' };
/** System icons stay first when arranging, as My Computer and the Recycle Bin do in 98. */
const RANK: Record<string, number> = { card: 0, pictures: 1, recycle: 2 };

interface DIcon {
  id: string;
  el: HTMLElement;
  img: HTMLImageElement;
  lbl: HTMLElement;
}

let desk: HTMLElement;
let layer: HTMLElement;
let ids: string[] = [];
const icons = new Map<string, DIcon>();
let cells: G.Cells = {};
const sel = new Set<string>();
let focusId: string | null = null;
let renaming: string | null = null;

const appType = (id: string) => TYPES[id] ?? 'Application';
const iconLabel = (id: string) => settings.iconNames[id] ?? LABELS[id] ?? APPS[id]?.title ?? id;

function gridNow(): G.GridSize {
  // phones lay the icons out in rows (CSS); there the grid only keeps the cell order
  G.setTextScale(ui.phone ? 1 : ui.ts);
  return G.gridSize(desk.clientWidth, desk.clientHeight);
}

/** Builds the icon layer inside the desktop and registers the desktop's right-click menus. */
export function buildDesktop(desktop: HTMLElement) {
  desk = desktop;
  layer = h('div', { class: 'dicons', role: 'listbox', 'aria-label': 'Desktop', 'aria-multiselectable': 'true', tabIndex: -1 });
  ids = DESKTOP_ICONS.filter((id) => APPS[id]);
  for (const id of ids) {
    const ic = makeIcon(id);
    icons.set(id, ic);
    layer.appendChild(ic.el);
  }
  desk.appendChild(layer);
  layer.addEventListener('keydown', onKey);
  desk.addEventListener('pointerdown', onDeskDown);

  const upd = () => {
    const ic = icons.get('recycle');
    if (!ic) return;
    ic.img.src = icon(store.bin.length ? 'recyclefull' : 'recycle', 32);
    (ic.img.parentElement as HTMLElement).style.setProperty('--mask-src', `url("${ic.img.src}")`);
  };
  store.on((why) => (why === 'bin' || why === 'load') && upd());
  upd();

  layout();
  new ResizeObserver(() => layout()).observe(desk);
  onScale(() => layout());
  syncSelection();
  registerMenus();
}

function makeIcon(id: string): DIcon {
  const app = APPS[id];
  const img = iconImg(app.icon, 32);
  const wrap = h('span', { class: 'imgwrap' }, img);
  wrap.style.setProperty('--mask-src', `url("${icon(app.icon, 32)}")`);
  const lbl = h('span', { class: 'lbl' }, iconLabel(id));
  const el = h('div', { class: 'dicon', role: 'option', tabIndex: -1, 'aria-selected': 'false', 'aria-label': iconLabel(id), dataset: { app: id } }, wrap, lbl);
  const ic = { id, el, img, lbl };
  el.addEventListener('pointerdown', (e) => onIconDown(e, ic));
  el.addEventListener('dblclick', (e) => {
    if (e.button === 0 && !renaming) openSelected(id);
  });
  el.addEventListener('focus', () => {
    focusId = id;
    rove();
  });
  return ic;
}

// ------------------------------------------------------------------ layout

/** Places the icons from the saved cells (off-grid or colliding ones move to the nearest free cell). */
function layout() {
  if (!desk || !desk.isConnected) return;
  const size = gridNow();
  cells = G.layoutIcons(ids, settings.iconPos, size);
  if (settings.autoArrange) cells = G.compact(cells, size.rows);
  apply();
}

function apply() {
  let maxX = 0;
  let maxY = 0;
  for (const [id, ic] of icons) {
    if (ui.phone) {
      ic.el.style.left = ic.el.style.top = '';
      continue;
    }
    const p = G.cellXY(cells[id]);
    ic.el.style.left = p.x + 'px';
    ic.el.style.top = p.y + 'px';
    maxX = Math.max(maxX, p.x + G.cellSize().w);
    maxY = Math.max(maxY, p.y + G.cellSize().h);
  }
  // the layer only covers the icons (Foldy keeps clear of it); clicks between icons fall through to the desktop
  layer.style.width = ui.phone ? '' : maxX + 'px';
  layer.style.height = ui.phone ? '' : maxY + 'px';
}

function persist() {
  const pos: Record<string, [number, number]> = {};
  for (const id of ids) pos[id] = [cells[id].c, cells[id].r];
  setSettings({ iconPos: pos });
}

function setCells(next: G.Cells) {
  cells = settings.autoArrange ? G.compact(next, gridNow().rows) : next;
  apply();
  persist();
}

function arrangeIcons(by: 'name' | 'type') {
  setCells(G.arrange(ids.map((id) => ({ id, name: iconLabel(id), type: appType(id), rank: RANK[id] })), by, gridNow().rows));
}

function lineUp() {
  setCells(G.layoutIcons(ids, Object.fromEntries(ids.map((id) => [id, [cells[id].c, cells[id].r] as [number, number]])), gridNow()));
}

function toggleAutoArrange() {
  setSettings({ autoArrange: !settings.autoArrange });
  if (settings.autoArrange) setCells(cells);
}

function refresh() {
  // 98 redraws the desktop: the icons blink off for a frame
  layer.style.visibility = 'hidden';
  layout();
  dispatchEvent(new Event('resize'));
  requestAnimationFrame(() => requestAnimationFrame(() => (layer.style.visibility = '')));
}

// ------------------------------------------------------------------ selection and focus

function syncSelection() {
  for (const [id, ic] of icons) {
    const on = sel.has(id);
    ic.el.classList.toggle('sel', on);
    ic.el.setAttribute('aria-selected', String(on));
  }
}

function select(list: Iterable<string>) {
  sel.clear();
  for (const id of list) sel.add(id);
  syncSelection();
}

/** Roving tab stop: the focused icon (or the first) is the desktop's one Tab stop. */
function rove() {
  const stop = focusId ?? orderedIds()[0];
  for (const [id, ic] of icons) ic.el.tabIndex = id === stop ? 0 : -1;
}

function focusIcon(id: string) {
  focusId = id;
  rove();
  icons.get(id)?.el.focus({ preventScroll: true });
}

/** Icons in reading order (column-major). */
function orderedIds(): string[] {
  const rows = gridNow().rows;
  return [...ids].sort((a, b) => cells[a].c * rows + cells[a].r - (cells[b].c * rows + cells[b].r));
}

function openSelected(fallback?: string) {
  const list = sel.size ? [...sel] : fallback ? [fallback] : [];
  for (const id of list) void openApp(id);
}

// ------------------------------------------------------------------ pointer: click, double-click, drag

function onIconDown(e: PointerEvent, ic: DIcon) {
  if (renaming === ic.id) return;
  const id = ic.id;
  const mod = e.ctrlKey || e.metaKey;
  if (e.button === 2) {
    // right-click selects the icon under the pointer first (unless it is already part of the selection)
    if (!sel.has(id)) select([id]);
    focusIcon(id);
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();
  const wasSel = sel.has(id);
  if (e.shiftKey) {
    sel.add(id);
    syncSelection();
  } else if (!mod && !wasSel) select([id]);
  focusIcon(id);

  // touch: a tap opens (phones have no double-click)
  const touch = e.pointerType !== 'mouse';
  if (ui.phone) {
    trackDrag(e, ic.el, toUi, () => {}, (dx, dy) => {
      if (Math.hypot(dx, dy) < 8) {
        select([id]);
        void openApp(id);
      }
    });
    return;
  }

  let ghosts: HTMLElement[] | null = null;
  let moving: string[] = [];
  trackDrag(
    e,
    ic.el,
    toUi,
    (dx, dy) => {
      if (!ghosts) {
        if (Math.hypot(dx, dy) < 4) return;
        // a drag picks up the whole selection (Ctrl+drag of an unselected icon adds it first)
        if (!sel.has(id)) {
          sel.add(id);
          syncSelection();
        }
        moving = [id, ...[...sel].filter((s) => s !== id)];
        // built fresh, not cloned: cloning copies style attributes, which the CSP (style-src 'self') blocks
        ghosts = moving.map((m) => {
          const src = icons.get(m)!;
          const wrap = h('span', { class: 'imgwrap' }, h('img', { class: 'ico', src: src.img.src, width: 32, height: 32, alt: '', draggable: false }));
          wrap.style.setProperty('--mask-src', `url("${src.img.src}")`);
          const g = h('div', { class: 'dicon ghost sel', 'aria-hidden': 'true' }, wrap, h('span', { class: 'lbl' }, iconLabel(m)));
          g.style.left = src.el.style.left;
          g.style.top = src.el.style.top;
          layer.appendChild(g);
          return g;
        });
        desk.classList.add('dragging-icons');
      }
      for (const g of ghosts) g.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
      // the 98 "no" cursor where the icons can't be dropped
      desk.classList.toggle('nodrop', !dropAllowed(e.clientX, e.clientY, dx, dy));
    },
    (dx, dy, moved) => {
      if (ghosts) {
        for (const g of ghosts) g.remove();
        desk.classList.remove('dragging-icons', 'nodrop');
        if (dropAllowed(e.clientX, e.clientY, dx, dy)) setCells(G.dropIcons(cells, moving, Math.round(dx), Math.round(dy), gridNow()));
        return;
      }
      if (moved && Math.hypot(dx, dy) >= 4) return;
      // a plain click on one of several selected icons selects just it; Ctrl+click toggles
      if (mod) {
        if (wasSel) sel.delete(id);
        else sel.add(id);
        syncSelection();
      } else if (!e.shiftKey && wasSel) select([id]);
      if (touch && !mod) void openApp(id);
    },
  );
}

/** Drops land on the desktop only (not on a window, the taskbar or off screen). */
function dropAllowed(cx0: number, cy0: number, dx: number, dy: number): boolean {
  const r = desk.getBoundingClientRect();
  const f = r.width / (desk.clientWidth || 1) || 1; // client px per UI px
  const x = cx0 + dx * f;
  const y = cy0 + dy * f;
  if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return false;
  return !document.elementFromPoint(x, y)?.closest('.win, .foldy');
}

// ------------------------------------------------------------------ rubber band

function isBackground(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !desk.contains(el)) return false;
  return el === desk || el === layer || !!el.closest('.wall-host, .wall');
}

function onDeskDown(e: PointerEvent) {
  if (!isBackground(e.target) || renaming) return;
  if (e.button !== 0) return;
  const mode = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace';
  const base = [...sel];
  if (mode === 'replace') select([]);
  layer.focus({ preventScroll: true });
  if (ui.phone) return;
  e.preventDefault();
  const o = uiRect(desk);
  const p0 = toUi(e);
  const x0 = p0.x - o.x;
  const y0 = p0.y - o.y;
  const boxes = ids.map((id) => {
    const ic = icons.get(id)!;
    const rel = (el: Element) => {
      const r = uiRect(el);
      return { x: r.x - o.x, y: r.y - o.y, w: r.w, h: r.h };
    };
    return { id, boxes: [rel(ic.img), rel(ic.lbl)] };
  });
  let band: HTMLElement | null = null;
  trackDrag(
    e,
    desk,
    toUi,
    (dx, dy) => {
      if (!band) {
        if (Math.hypot(dx, dy) < 2) return;
        band = h('div', { class: 'rband', 'aria-hidden': 'true' });
        desk.appendChild(band);
      }
      // the band stays inside the desktop
      const x1 = Math.max(0, Math.min(desk.clientWidth - 1, x0 + dx));
      const y1 = Math.max(0, Math.min(desk.clientHeight - 1, y0 + dy));
      const b = G.bandRect(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1));
      band.style.left = b.x + 'px';
      band.style.top = b.y + 'px';
      band.style.width = b.w + 1 + 'px';
      band.style.height = b.h + 1 + 'px';
      select(G.combineSelection(base, G.rectSelect(b, boxes), mode));
    },
    () => {
      band?.remove();
      const first = orderedIds().find((id) => sel.has(id));
      if (first && !(focusId && sel.has(focusId))) focusId = first;
      rove();
    },
  );
}

// ------------------------------------------------------------------ keyboard

let typed = '';
let typedAt = 0;

function onKey(e: KeyboardEvent) {
  if (renaming || (e.target as HTMLElement).tagName === 'INPUT') return;
  const mod = e.ctrlKey || e.metaKey;
  const order = orderedIds();
  const cur = focusId && icons.has(focusId) ? focusId : null;
  const go = (id: string | null | undefined) => {
    if (!id) return;
    if (mod) focusIcon(id); // Ctrl+arrow moves the focus only
    else if (e.shiftKey) {
      sel.add(id);
      syncSelection();
      focusIcon(id);
    } else {
      select([id]);
      focusIcon(id);
    }
  };
  const dirs: Record<string, G.Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  let handled = true;
  if (dirs[e.key]) go(cur ? G.neighbor(cells, cur, dirs[e.key]) : order[0]);
  else if (e.key === 'Home') go(order[0]);
  else if (e.key === 'End') go(order[order.length - 1]);
  else if (e.key === 'Enter') openSelected(cur ?? undefined);
  else if (e.key === 'F2' && cur) startRename(cur);
  else if (mod && e.key.toLowerCase() === 'a') select(ids);
  else if (e.key === ' ' && cur) {
    if (mod) sel.has(cur) ? sel.delete(cur) : sel.add(cur);
    else sel.add(cur);
    syncSelection();
  } else if (e.key.length === 1 && !mod && !e.altKey) {
    // type-ahead: the next icon whose label starts with what was typed
    const now = performance.now();
    typed = now - typedAt > 1000 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
    typedAt = now;
    const start = cur ? order.indexOf(cur) + (typed.length === 1 ? 1 : 0) : 0;
    const hit = [...order.slice(start), ...order.slice(0, start)].find((id) => iconLabel(id).toLowerCase().startsWith(typed));
    if (hit) {
      select([hit]);
      focusIcon(hit);
    }
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

// ------------------------------------------------------------------ rename (F2)

/** Inline 98 rename box over the label. The new name is a desktop label only; the app keeps its title. */
function startRename(id: string) {
  const ic = icons.get(id);
  if (!ic || renaming || ui.phone) return;
  renaming = id;
  select([id]);
  const inp = h('input', { class: 'dicon-rename', type: 'text', value: iconLabel(id), 'aria-label': 'New name', spellcheck: 'false', maxLength: 64 });
  ic.lbl.hidden = true;
  ic.el.appendChild(inp);
  ic.el.classList.add('renaming');
  inp.focus();
  inp.select();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    inp.remove();
    ic.lbl.hidden = false;
    ic.el.classList.remove('renaming');
    renaming = null;
    if (keep && v) {
      const names = { ...settings.iconNames };
      const def = LABELS[id] ?? APPS[id]?.title ?? id;
      if (v === def) delete names[id];
      else names[id] = v;
      setSettings({ iconNames: names });
      setText(ic.lbl, iconLabel(id));
      ic.el.setAttribute('aria-label', iconLabel(id));
      if (settings.autoArrange) setCells(cells);
    }
    focusIcon(id);
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());
}

// ------------------------------------------------------------------ properties and menus

function properties(id: string) {
  const name = iconLabel(id);
  // the bin's own sheet and confirmation live in the Recycle Bin app (loaded on demand): one wording
  if (id === 'recycle') return void import('../apps/recycle').then((m) => m.binProperties());
  const app = APPS[id];
  message(`${name} Properties`, `${name}\n\nType: ${appType(id)}\nOpens: ${app.title}${name !== app.title ? `\nLabel: renamed on this desktop` : ''}`, app.icon);
}

async function emptyBin() {
  if (store.bin.length) await (await import('../apps/recycle')).emptyBin();
}

/** The desktop's own menu (right-click on empty desktop). */
function desktopMenu(): MenuItem[] {
  return [
    {
      label: 'Arrange &Icons',
      sub: () => [
        { label: 'by &Name', onClick: () => arrangeIcons('name') },
        { label: 'by &Type', onClick: () => arrangeIcons('type') },
        { sep: true },
        { label: '&Auto Arrange', checked: settings.autoArrange, onClick: toggleAutoArrange },
      ],
    },
    { label: 'Line &up Icons', disabled: settings.autoArrange || ui.phone, onClick: lineUp },
    { sep: true },
    { label: 'R&efresh', onClick: refresh },
    { sep: true },
    { label: '&Paste', disabled: true },
    { label: 'Paste &Shortcut', disabled: true },
    { sep: true },
    {
      label: 'Ne&w',
      sub: [
        { label: '&Folder', icon: 'folder', disabled: true },
        { label: '&Shortcut', disabled: true },
        { sep: true },
        { label: 'JPEG Image', icon: 'jpeg', disabled: true },
        { label: 'Text Document', disabled: true },
      ],
    },
    { sep: true },
    { label: 'P&roperties', onClick: () => void openApp('display') },
  ];
}

function selectFor(el: Element): string | null {
  const id = (el as HTMLElement).dataset.app;
  if (!id || !icons.has(id)) return null;
  if (!sel.has(id)) select([id]);
  focusIcon(id);
  return id;
}

function iconMenu(el: Element): MenuItem[] | null {
  const id = selectFor(el);
  if (!id) return null;
  return [
    { label: '&Open', default: true, onClick: () => openSelected(id) },
    { sep: true },
    { label: 'Rena&me', disabled: sel.size > 1 || ui.phone, onClick: () => startRename(id) },
    { sep: true },
    { label: 'P&roperties', onClick: () => properties(id) },
  ];
}

function binMenu(el: Element): MenuItem[] | null {
  const id = selectFor(el);
  if (!id) return null;
  return [
    { label: '&Open', default: true, onClick: () => openSelected(id) },
    { sep: true },
    { label: 'Empty Recycle &Bin', disabled: !store.bin.length, onClick: () => void emptyBin() },
    { sep: true },
    { label: 'Rena&me', disabled: sel.size > 1 || ui.phone, onClick: () => startRename(id) },
    { label: 'P&roperties', onClick: () => properties(id) },
  ];
}

function registerMenus() {
  registerContext('.desktop', () => desktopMenu());
  registerContext('.dicon', (el) => iconMenu(el));
  registerContext('.dicon[data-app="recycle"]', (el) => binMenu(el));
}
