// A Windows 98 Explorer folder window, shared by My Pictures, the Recycle Bin and Presets: menu bar, the
// rebar (Standard Buttons with text labels, cold/hot icons, the Views split button; the Address bar), a white
// sunken list view (Large Icons, Small Icons, List, Details with sortable and resizable column headers,
// Thumbnails), 98 selection (navy label, navy-dithered icon, silver when the list is not focused, dotted focus
// rectangle), rubber-band selection, the keyboard (arrows, Home/End, Shift/Ctrl, Space, Enter, Delete, F2,
// Ctrl+A/C/X/V/Z, F5, Alt+Enter, type-ahead), inline rename and the status bar. Also the 98 property sheet
// and the shell clipboard that Cut/Copy/Paste share between these windows.
import { h, setText } from '../ui/dom';
import { iconImg, icon } from '../ui/art';
import { openWindow, getWin, windows, type Win } from '../ui/wm';
import { registerContext } from '../ui/contextmenu';
import { menuAt, type MenuItem } from '../ui/menu';
import { message } from '../ui/dialog';
import { checkbox, tabs } from '../ui/controls';
import { ui, toUi, uiRect } from '../ui/scale';
import { trackDrag } from '../ui/wm-drag';
import { textWidth } from '../ui/pixeltext';
import { bandRect, rectSelect, combineSelection } from '../shell/desktop-grid';
import * as M from './explorer-model';
import { toolIcon, type ToolIcon } from './explorer-art';
import { openApp } from './registry';

export type ViewMode = M.ViewMode;

// ------------------------------------------------------------------ shell clipboard (Cut / Copy / Paste)

export interface ShellClip {
  op: 'cut' | 'copy';
  /** The folder the items came from ('pictures', 'recycle'). */
  from: string;
  keys: string[];
}
let clip: ShellClip | null = null;
const clipListeners = new Set<() => void>();

export function getClip(): ShellClip | null {
  return clip;
}
export function setClip(c: ShellClip | null) {
  clip = c;
  for (const l of clipListeners) l();
}
/** Cut items are drawn ghosted until they are pasted or the clipboard changes. */
export function isCut(from: string, key: string): boolean {
  return !!clip && clip.op === 'cut' && clip.from === from && clip.keys.includes(key);
}

// ------------------------------------------------------------------ folder options shared by every folder

const prefs = { standard: true, address: true, labels: true, status: true };
const folders = new Set<Folder<any>>();

function setPref(k: keyof typeof prefs, v: boolean) {
  prefs[k] = v;
  for (const f of folders) f.chrome();
}

// ------------------------------------------------------------------ the folder

export interface Column<T> {
  id: string;
  label: string;
  width: number;
  right?: boolean;
  text: (t: T) => string;
  /** Ascending compare (defaults to the text, naturally). */
  cmp?: (a: T, b: T) => number;
}

export interface ToolSpec {
  icon: ToolIcon;
  label: string;
  tip?: string;
  enabled: () => boolean;
  run: () => void;
}

export interface FolderSpec<T> {
  id: string;
  title: string;
  short: string;
  icon: string;
  /** Address bar text ("C:\My Documents\My Pictures"). */
  address: string;
  width?: number;
  height?: number;
  items: () => T[];
  key: (t: T) => string;
  name: (t: T) => string;
  iconOf: (t: T) => string;
  /** Thumbnails view: a picture URL for the item. */
  thumb?: (t: T) => Promise<string | null>;
  size?: (t: T) => number;
  columns: Column<T>[];
  views: ViewMode[];
  view: ViewMode;
  /** Initial sort column (null keeps the items' own order). */
  sort?: string | null;
  sortDesc?: boolean;
  /** Arrange Icons ▸ entries: [label, column id]. */
  arrange: [string, string][];
  emptyText?: string;
  open: (items: T[]) => void;
  itemMenu: (items: T[], f: Folder<T>) => MenuItem[];
  bgMenu: (f: Folder<T>) => MenuItem[];
  menus: (f: Folder<T>) => { label: string; items: () => MenuItem[] }[];
  toolbar: (f: Folder<T>) => (ToolSpec | 'sep' | 'views')[];
  onDelete?: (items: T[]) => void;
  /** F2: return false to keep the old name (after showing why). */
  rename?: (t: T, name: string) => boolean | void;
  onCut?: (items: T[]) => void;
  onCopy?: (items: T[]) => void;
  onPaste?: () => void;
  onUndo?: () => void;
  onProperties?: (items: T[]) => void;
  onDrop?: (files: File[]) => void;
  /** View ▸ as Web Page. */
  webView?: () => HTMLElement;
  /** Right status-bar zone: [icon, text]. */
  zone?: [string, string];
  onClose?: () => void;
}

export class Folder<T> {
  win: Win;
  readonly spec: FolderSpec<T>;
  view: ViewMode;
  sortCol: string | null;
  sortDesc: boolean;
  web = false;
  readonly sel = new Set<string>();
  focusKey: string | null = null;
  anchor: string | null = null;
  private renaming: string | null = null;
  private dirty = false;
  private order: string[] = [];
  private byKey = new Map<string, T>();
  private widths: Record<string, number> = {};
  private root: HTMLElement;
  private bars: HTMLElement;
  private main: HTMLElement;
  readonly list: HTMLElement;
  private toolBtns: { b: HTMLButtonElement; t: ToolSpec }[] = [];
  private unreg: (() => void)[] = [];
  private typed = '';
  private typedAt = 0;
  private lastTap = { key: '', t: 0 };

  constructor(spec: FolderSpec<T>) {
    this.spec = spec;
    this.view = spec.view;
    this.sortCol = spec.sort ?? null;
    this.sortDesc = !!spec.sortDesc;
    for (const c of spec.columns) this.widths[c.id] = c.width;
    this.list = h('div', { class: 'fv', tabIndex: 0, role: 'listbox', 'aria-label': spec.title, 'aria-multiselectable': 'true' });
    this.bars = h('div', { class: 'xw-bars' });
    this.main = h('div', { class: 'xw-main' }, this.list);
    this.root = h('div', { class: 'xw', dataset: { folder: spec.id } }, this.bars, this.main);
    this.win = openWindow({
      id: spec.id,
      title: spec.title,
      short: spec.short,
      icon: spec.icon,
      body: this.root,
      width: spec.width ?? 560,
      height: spec.height ?? 400,
      minWidth: 260,
      minHeight: 180,
      menu: spec.menus(this),
      status: [h('div', { class: 'grow' })],
      onClose: () => {
        for (const u of this.unreg) u();
        folders.delete(this);
        spec.onClose?.();
      },
      onResize: () => this.view === 'list' && this.layoutList(),
    });
    folders.add(this);
    this.bindList();
    const sel = `.xw[data-folder="${spec.id}"]`;
    this.unreg.push(
      registerContext(`${sel} .fv`, () => {
        // a right-click on empty space deselects everything, as in 98
        this.select([]);
        return spec.bgMenu(this);
      }),
      registerContext(`${sel} .fv-item`, (el) => {
        const k = (el as HTMLElement).dataset.key;
        if (!k || !this.byKey.has(k)) return null;
        if (!this.sel.has(k)) this.select([k]);
        this.setFocus(k);
        return spec.itemMenu(this.selected(), this);
      }),
      registerContext(`${sel} .xw-web`, () => spec.bgMenu(this)),
      registerContext(`${sel} .xw-bars`, () => this.toolbarsMenu()),
    );
    const onClip = () => this.render();
    clipListeners.add(onClip);
    this.unreg.push(() => clipListeners.delete(onClip));
    this.chrome();
    this.render();
    requestAnimationFrame(() => this.list.focus({ preventScroll: true }));
  }

  // ---------------------------------------------------------------- data

  selected(): T[] {
    return this.order.filter((k) => this.sel.has(k)).map((k) => this.byKey.get(k)!);
  }

  item(key: string): T | undefined {
    return this.byKey.get(key);
  }

  private sorted(): T[] {
    const items = this.spec.items();
    const col = this.spec.columns.find((c) => c.id === this.sortCol);
    if (!col) return items;
    const cmp = col.cmp ?? ((a: T, b: T) => M.natCmp(col.text(a), col.text(b)));
    return M.sortItems(items, { cmp }, this.sortDesc, (a, b) => M.natCmp(this.spec.name(a), this.spec.name(b)));
  }

  // ---------------------------------------------------------------- chrome: toolbar, address bar, status bar

  /** Re-applies the View ▸ Toolbars / Status Bar options. */
  chrome() {
    const bands: HTMLElement[] = [];
    if (prefs.standard) bands.push(this.buildToolbar());
    if (prefs.address) bands.push(this.buildAddress());
    this.bars.replaceChildren(...bands);
    this.bars.hidden = !bands.length;
    this.status();
  }

  private buildToolbar(): HTMLElement {
    this.toolBtns = [];
    const band = h('div', { class: 'xw-band xtb' + (prefs.labels ? ' labels' : ''), role: 'toolbar', 'aria-label': 'Standard Buttons' }, h('span', { class: 'xw-grip', 'aria-hidden': 'true' }));
    for (const t of this.spec.toolbar(this)) {
      if (t === 'sep') band.append(h('span', { class: 'xtb-sep', 'aria-hidden': 'true' }));
      else if (t === 'views') band.append(this.viewsButton());
      else {
        const b = this.toolButton(t.icon, t.label, t.tip ?? t.label, t.run);
        this.toolBtns.push({ b, t });
        band.append(b);
      }
    }
    this.updateTools();
    return band;
  }

  private toolButton(name: ToolIcon, label: string, tip: string, run: () => void): HTMLButtonElement {
    const ic = toolIcon(name);
    const img = h('img', { class: 'xtb-ic', src: ic.cold, width: 20, height: 20, alt: '', draggable: false });
    const b = h('button', { class: 'xtb-btn', type: 'button', 'aria-label': tip, 'data-tip': prefs.labels ? undefined : tip, dataset: { ic: name } }, img, prefs.labels ? h('span', { class: 'xtb-lbl' }, label) : null);
    // IE4/98: grey until the pointer is over it, then in colour
    const look = (hot: boolean) => (img.src = b.disabled ? ic.dis : hot ? ic.hot : ic.cold);
    b.addEventListener('pointerenter', () => look(true));
    b.addEventListener('pointerleave', () => look(false));
    b.addEventListener('click', () => !b.disabled && run());
    (b as any).__look = look;
    return b;
  }

  private viewsButton(): HTMLElement {
    const b = this.toolButton('views', 'Views', 'Views', () => this.setView(M.nextView(this.view, this.spec.views)));
    const arr = h('button', { class: 'xtb-drop', type: 'button', 'aria-label': 'Views menu', 'aria-haspopup': 'true' });
    arr.addEventListener('click', () => {
      wrap.classList.add('open');
      menuAt(wrap, this.viewItems(), { onClose: () => wrap.classList.remove('open'), label: 'Views' });
    });
    const wrap = h('span', { class: 'xtb-split' }, b, arr);
    return wrap;
  }

  /** Enables/disables the toolbar buttons for the current selection. */
  updateTools() {
    for (const { b, t } of this.toolBtns) {
      const on = t.enabled();
      if (b.disabled === !on) continue;
      b.disabled = !on;
      (b as any).__look?.(b.matches(':hover'));
    }
    for (const { b } of this.toolBtns) if (b.disabled) (b as any).__look?.(false);
  }

  private buildAddress(): HTMLElement {
    const field = h('div', { class: 'field combo xw-addr-f', role: 'combobox', 'aria-label': 'Address', 'aria-expanded': 'false' }, h('span', { class: 'combo-text' }, iconImg(this.spec.icon, 16), h('span', { class: 'xw-addr-t' }, this.spec.address)), h('span', { class: 'combo-btn', 'aria-hidden': 'true' }));
    field.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      field.classList.add('open');
      menuAt(field, addressMenu(this.spec.id), { onClose: () => field.classList.remove('open'), label: 'Address' });
    });
    return h('div', { class: 'xw-band xw-addr' }, h('span', { class: 'xw-grip', 'aria-hidden': 'true' }), h('span', { class: 'xw-addr-l' }, 'Address'), field);
  }

  /** The right-click menu of the rebar (and View ▸ Toolbars). */
  toolbarsMenu(): MenuItem[] {
    return [
      { label: '&Standard Buttons', checked: prefs.standard, onClick: () => setPref('standard', !prefs.standard) },
      { label: '&Address Bar', checked: prefs.address, onClick: () => setPref('address', !prefs.address) },
      { label: '&Links', checked: false, disabled: true },
      { sep: true },
      { label: '&Text Labels', checked: prefs.labels, disabled: !prefs.standard, onClick: () => setPref('labels', !prefs.labels) },
    ];
  }

  /** The status bar: "N object(s) [selected]", the size, and the zone ("My Computer"). */
  status() {
    if (!prefs.status) {
      this.win.statusEl.style.display = 'none';
      this.win.el.classList.add('nostatus');
      return;
    }
    const n = this.sel.size;
    const items = n ? this.selected() : this.order.map((k) => this.byKey.get(k)!);
    const size = this.spec.size ? items.reduce((a, t) => a + this.spec.size!(t), 0) : 0;
    const [zi, zt] = this.spec.zone ?? ['computer', 'My Computer'];
    this.win.setStatus([
      h('div', { class: 'grow' }, this.web && !n ? `${this.order.length} object(s)` : M.statusText(n, this.order.length)),
      h('div', { class: 'xw-sb-size' }, this.spec.size && (n || this.order.length) ? M.fmtSize98(size) : ''),
      h('div', { class: 'xw-sb-zone' }, iconImg(zi, 16), zt),
    ]);
  }

  // ---------------------------------------------------------------- menus the apps reuse

  viewItems(): MenuItem[] {
    return this.spec.views.map((v) => ({ label: M.VIEW_LABELS[v], checked: !this.web && this.view === v, radio: true, onClick: () => this.setView(v) }));
  }

  arrangeItems(): MenuItem[] {
    return [
      ...this.spec.arrange.map(([label, col]) => ({ label, checked: this.sortCol === col, radio: true, onClick: () => this.arrange(col) })),
      { sep: true },
      { label: '&Auto Arrange', checked: true, disabled: true },
    ];
  }

  /** The View menu of the menu bar. */
  viewMenu(): MenuItem[] {
    const items: MenuItem[] = [
      { label: '&Toolbars', sub: () => this.toolbarsMenu() },
      { label: 'Status &Bar', checked: prefs.status, onClick: () => setPref('status', !prefs.status) },
      { label: '&Explorer Bar', sub: [{ label: '&Search', disabled: true }, { label: '&Favorites', disabled: true }, { label: '&History', disabled: true }, { label: '&Folders', disabled: true }] },
    ];
    if (this.spec.webView) items.push({ sep: true }, { label: 'as &Web Page', checked: this.web, onClick: () => this.setWeb(!this.web) });
    items.push(
      { sep: true },
      ...this.viewItems(),
      { sep: true },
      { label: 'Arrange &Icons', sub: () => this.arrangeItems() },
      { label: 'Line &Up Icons', disabled: this.view === 'details' || this.view === 'list' || this.web, onClick: () => this.lineUp() },
      { sep: true },
      { label: '&Refresh', acc: 'F5', onClick: () => this.refresh() },
    );
    return items;
  }

  /** The empty-space menu's View ▸ / Arrange Icons ▸ / Line up Icons / Refresh block. */
  bgViewBlock(): MenuItem[] {
    return [
      { label: '&View', sub: () => [...this.viewItems(), ...(this.spec.webView ? [{ sep: true }, { label: 'as &Web Page', checked: this.web, onClick: () => this.setWeb(!this.web) }] : [])] },
      { sep: true },
      { label: 'Arrange &Icons', sub: () => this.arrangeItems() },
      { label: 'Line &up Icons', disabled: this.view === 'details' || this.view === 'list' || this.web, onClick: () => this.lineUp() },
      { sep: true },
      { label: 'R&efresh', onClick: () => this.refresh() },
    ];
  }

  selectionItems(): MenuItem[] {
    return [
      { label: 'Select &All', acc: 'Ctrl+A', disabled: !this.order.length, onClick: () => this.selectAll() },
      { label: '&Invert Selection', disabled: !this.order.length, onClick: () => this.invert() },
    ];
  }

  static helpMenu(): MenuItem[] {
    return [{ label: '&Help Topics', icon: 'help', onClick: () => void openApp('help') }, { sep: true }, { label: '&About File Refragmenter', onClick: () => void openApp('about') }];
  }

  // ---------------------------------------------------------------- commands

  setView(v: ViewMode) {
    if (!this.spec.views.includes(v)) return;
    this.view = v;
    if (this.web) this.setWeb(false);
    else this.render();
  }

  setWeb(on: boolean) {
    if (!this.spec.webView) return;
    this.web = on;
    if (on) {
      const page = h('div', { class: 'xw-web' }, this.spec.webView());
      this.main.replaceChildren(page);
    } else {
      this.main.replaceChildren(this.list);
      this.render();
      this.list.focus({ preventScroll: true });
    }
    this.status();
  }

  arrange(col: string) {
    this.sortCol = col;
    this.sortDesc = false;
    this.render();
  }

  lineUp() {
    // the views are always arranged; 98 still redraws them
    this.refresh();
  }

  refresh() {
    this.list.classList.add('xw-blink');
    this.render();
    requestAnimationFrame(() => requestAnimationFrame(() => this.list.classList.remove('xw-blink')));
  }

  select(keys: Iterable<string>) {
    this.sel.clear();
    for (const k of keys) if (this.byKey.has(k)) this.sel.add(k);
    this.syncSel();
  }

  selectAll() {
    this.select(this.order);
  }

  invert() {
    this.select(this.order.filter((k) => !this.sel.has(k)));
  }

  setFocus(k: string | null, scroll = true) {
    this.focusKey = k;
    for (const el of this.list.querySelectorAll<HTMLElement>('.fv-item')) {
      const on = el.dataset.key === k;
      el.classList.toggle('focus', on);
      if (on) {
        this.list.setAttribute('aria-activedescendant', el.id);
        if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  private syncSel() {
    for (const el of this.list.querySelectorAll<HTMLElement>('.fv-item')) {
      const on = this.sel.has(el.dataset.key!);
      el.classList.toggle('sel', on);
      el.setAttribute('aria-selected', String(on));
    }
    this.updateTools();
    this.status();
  }

  openSelected() {
    const items = this.selected();
    if (items.length) this.spec.open(items);
    else if (this.focusKey && this.byKey.has(this.focusKey)) this.spec.open([this.byKey.get(this.focusKey)!]);
  }

  // ---------------------------------------------------------------- rendering

  render() {
    if (this.renaming) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const items = this.sorted();
    this.byKey = new Map(items.map((t) => [this.spec.key(t), t]));
    this.order = items.map((t) => this.spec.key(t));
    for (const k of [...this.sel]) if (!this.byKey.has(k)) this.sel.delete(k);
    if (this.focusKey && !this.byKey.has(this.focusKey)) this.focusKey = null;
    if (this.anchor && !this.byKey.has(this.anchor)) this.anchor = null;
    const st = this.list.scrollTop;
    const sl = this.list.scrollLeft;
    this.list.className = 'fv v-' + this.view;
    const kids: HTMLElement[] = [];
    if (this.view === 'details') kids.push(this.header());
    const body = h('div', { class: 'fv-items' });
    items.forEach((t, i) => body.append(this.view === 'details' ? this.row(t, i) : this.cell(t, i)));
    kids.push(body);
    if (!items.length && this.spec.emptyText) kids.push(h('div', { class: 'fv-empty' }, this.spec.emptyText));
    this.list.replaceChildren(...kids);
    for (const c of this.spec.columns) this.list.style.setProperty('--w-' + c.id, this.widths[c.id] + 'px');
    this.list.scrollTop = st;
    this.list.scrollLeft = sl;
    if (this.view === 'list') this.layoutList();
    this.syncSel();
    this.setFocus(this.focusKey, false);
  }

  private header(): HTMLElement {
    const head = h('div', { class: 'fv-head', role: 'row' });
    for (const c of this.spec.columns) {
      const b = h('div', { class: 'fv-hd' + (c.right ? ' r' : ''), role: 'columnheader', dataset: { col: c.id } }, h('span', { class: 'fv-hd-t' }, c.label));
      b.style.setProperty('width', `var(--w-${c.id})`);
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).classList.contains('fv-split')) return;
        e.preventDefault();
        b.classList.add('down');
        const up = () => {
          b.classList.remove('down');
          removeEventListener('pointerup', up);
        };
        addEventListener('pointerup', up);
      });
      b.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('fv-split')) return;
        if (this.sortCol === c.id) this.sortDesc = !this.sortDesc;
        else {
          this.sortCol = c.id;
          this.sortDesc = false;
        }
        this.render();
      });
      // the divider at the header's right edge drags the column width (double-click: fit the text)
      const split = h('span', { class: 'fv-split', 'aria-hidden': 'true' });
      split.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const w0 = this.widths[c.id];
        trackDrag(e, split, toUi, (dx) => {
          this.widths[c.id] = Math.max(8, Math.round(w0 + dx));
          this.list.style.setProperty('--w-' + c.id, this.widths[c.id] + 'px');
        }, () => {});
      });
      split.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const cells = [...this.list.querySelectorAll<HTMLElement>(`.fv-cell[data-col="${c.id}"]`)];
        const need = Math.max(40, ...cells.map((x) => (x.firstElementChild as HTMLElement | null)?.scrollWidth ?? 0).map((w) => w + 16));
        this.widths[c.id] = Math.min(400, need);
        this.list.style.setProperty('--w-' + c.id, this.widths[c.id] + 'px');
      });
      b.append(split);
      head.append(b);
    }
    head.append(h('div', { class: 'fv-hd fill', 'aria-hidden': 'true' }));
    return head;
  }

  private iconBox(t: T, size: 16 | 32): HTMLElement {
    const name = this.spec.iconOf(t);
    const box = h('span', { class: 'fv-ic s' + size }, iconImg(name, size));
    box.style.setProperty('--mask-src', `url("${icon(name, size)}")`);
    return box;
  }

  private itemEl(t: T, i: number, cls: string, ...kids: HTMLElement[]): HTMLElement {
    const k = this.spec.key(t);
    const el = h('div', { class: 'fv-item ' + cls, role: 'option', id: `fv-${this.spec.id}-${i}`, dataset: { key: k }, 'aria-selected': 'false' }, ...kids);
    if (isCut(this.spec.id, k)) el.classList.add('cut');
    el.addEventListener('dblclick', (e) => {
      if (e.button === 0 && !this.renaming) this.spec.open(this.selected().length ? this.selected() : [t]);
    });
    return el;
  }

  private cell(t: T, i: number): HTMLElement {
    const name = this.spec.name(t);
    const lbl = h('span', { class: 'fv-lbl' }, name);
    if (this.view === 'thumbs') {
      const img = h('img', { alt: '', draggable: false, class: 'fv-thumb' });
      const frame = h('span', { class: 'fv-frame fv-ic' }, img);
      if (this.spec.thumb) void this.spec.thumb(t).then((u) => u && (img.src = u));
      else img.src = icon(this.spec.iconOf(t), 32);
      return this.itemEl(t, i, 'fv-cell-t', frame, lbl);
    }
    if (this.view === 'large') return this.itemEl(t, i, '', this.iconBox(t, 32), this.wrapped(name));
    return this.itemEl(t, i, '', this.iconBox(t, 16), lbl);
  }

  /** A large-icon label as one text run per line (so every line starts on a whole pixel and stays crisp):
   *  two lines ending in "..." normally, all of it while the item has the focus. */
  private wrapped(name: string): HTMLElement {
    const W = 69;
    const measure = (s: string) => textWidth(s) * (ui.ts || 1);
    const full = M.wrapLabel(name, W, measure);
    const lbl = h('span', { class: 'fv-lbl' });
    if (full.length <= 2) lbl.append(...full.map((l) => h('span', { class: 'fv-ln' }, l)));
    else lbl.append(...M.clampLines(full, 2, W, measure).map((l) => h('span', { class: 'fv-ln l-cut' }, l)), ...full.map((l) => h('span', { class: 'fv-ln l-full' }, l)));
    return lbl;
  }

  private row(t: T, i: number): HTMLElement {
    const cells = this.spec.columns.map((c, ci) => {
      const cell = h('div', { class: 'fv-cell' + (c.right ? ' r' : ''), dataset: { col: c.id } }, ci === 0 ? [this.iconBox(t, 16), h('span', { class: 'fv-lbl' }, this.spec.name(t))] : h('span', { class: 'fv-ct' }, c.text(t)));
      cell.style.setProperty('width', `var(--w-${c.id})`);
      return cell;
    });
    return this.itemEl(t, i, 'fv-row', ...cells);
  }

  /** List view runs top to bottom, then into the next column: the column height follows the window. */
  private layoutList() {
    const body = this.list.querySelector<HTMLElement>('.fv-items');
    if (!body) return;
    body.style.setProperty('height', Math.max(18, this.list.clientHeight - 4) + 'px');
  }

  // ---------------------------------------------------------------- pointer and keyboard

  private keyAt(t: EventTarget | null): string | null {
    const it = (t as HTMLElement | null)?.closest?.('.fv-item') as HTMLElement | null;
    return it && this.list.contains(it) ? it.dataset.key ?? null : null;
  }

  private bindList() {
    const L = this.list;
    L.addEventListener('pointerdown', (e) => {
      if (this.renaming || (e.target as HTMLElement).closest('.fv-head, .fv-rename')) return;
      const k = this.keyAt(e.target);
      const mod = e.ctrlKey || e.metaKey;
      if (!k) {
        if (e.button === 0) this.band(e);
        return;
      }
      L.focus({ preventScroll: true });
      if (e.button === 2) {
        if (!this.sel.has(k)) this.select([k]);
        this.setFocus(k);
        return;
      }
      if (e.button !== 0) return;
      if (e.shiftKey) this.select(combineSelection(mod ? this.sel : [], M.rangeSelect(this.order, this.anchor ?? this.focusKey, k), 'add'));
      else if (mod) {
        if (this.sel.has(k)) this.sel.delete(k);
        else this.sel.add(k);
        this.anchor = k;
        this.syncSel();
      } else {
        // touch: a second tap on the selected item opens it (phones have no double-click)
        const now = performance.now();
        if (e.pointerType !== 'mouse' && this.sel.has(k) && this.sel.size === 1 && this.lastTap.key === k && now - this.lastTap.t < 1500) {
          this.lastTap = { key: '', t: 0 };
          this.setFocus(k);
          this.openSelected();
          return;
        }
        this.lastTap = { key: k, t: now };
        this.select([k]);
        this.anchor = k;
      }
      this.setFocus(k);
    });
    L.addEventListener('keydown', (e) => this.onKey(e));
    L.addEventListener('focus', () => {
      if (!this.focusKey && this.order.length) this.setFocus(this.order[0], false);
    });
    if (this.spec.onDrop) {
      const drop = this.spec.onDrop;
      this.root.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      });
      this.root.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length) drop(files);
      });
    }
  }

  /** Rubber band from empty space: a 1 px dotted rectangle; plain replaces, Shift adds, Ctrl toggles. */
  private band(e: PointerEvent) {
    const L = this.list;
    L.focus({ preventScroll: true });
    const mode = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace';
    const base = [...this.sel];
    if (mode === 'replace') this.select([]);
    if (ui.phone) return;
    // clicks on the scroll bars are not bands
    const r = L.getBoundingClientRect();
    if (e.clientX >= r.left + L.clientLeft + L.clientWidth || e.clientY >= r.top + L.clientTop + L.clientHeight) return;
    e.preventDefault();
    const o = uiRect(L);
    const p0 = toUi(e);
    const sx = L.scrollLeft;
    const sy = L.scrollTop;
    const x0 = p0.x - o.x + sx;
    const y0 = p0.y - o.y + sy;
    const rel = (el: Element | null) => {
      if (!el) return { x: -1e6, y: -1e6, w: 0, h: 0 };
      const b = uiRect(el);
      return { x: b.x - o.x + sx, y: b.y - o.y + sy, w: b.w, h: b.h };
    };
    const boxes = [...L.querySelectorAll<HTMLElement>('.fv-item')].map((el) => ({ id: el.dataset.key!, boxes: [rel(el.querySelector('.fv-ic')), rel(el.querySelector('.fv-lbl'))] }));
    const maxW = Math.max(L.scrollWidth, L.clientWidth) - 1;
    const maxH = Math.max(L.scrollHeight, L.clientHeight) - 1;
    let bandEl: HTMLElement | null = null;
    trackDrag(
      e,
      L,
      toUi,
      (dx, dy) => {
        if (!bandEl) {
          if (Math.hypot(dx, dy) < 2) return;
          bandEl = h('div', { class: 'rband', 'aria-hidden': 'true' });
          L.appendChild(bandEl);
        }
        const x1 = Math.max(0, Math.min(maxW, x0 + dx));
        const y1 = Math.max(0, Math.min(maxH, y0 + dy));
        const b = bandRect(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1));
        bandEl.style.left = b.x + 'px';
        bandEl.style.top = b.y + 'px';
        bandEl.style.width = b.w + 1 + 'px';
        bandEl.style.height = b.h + 1 + 'px';
        this.select(combineSelection(base, rectSelect(b, boxes), mode));
      },
      () => {
        bandEl?.remove();
        const first = this.order.find((k) => this.sel.has(k));
        if (first && !(this.focusKey && this.sel.has(this.focusKey))) this.setFocus(first, false);
        if (first) this.anchor = first;
      },
    );
  }

  private boxes(): M.ItemBox[] {
    return [...this.list.querySelectorAll<HTMLElement>('.fv-item')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.key!, x: r.left, y: r.top, w: r.width, h: r.height };
    });
  }

  private onKey(e: KeyboardEvent) {
    if (this.renaming || (e.target as HTMLElement).tagName === 'INPUT') return;
    const mod = e.ctrlKey || e.metaKey;
    const cur = this.focusKey && this.byKey.has(this.focusKey) ? this.focusKey : null;
    const go = (k: string | null | undefined) => {
      if (!k) return;
      if (e.shiftKey) this.select(M.rangeSelect(this.order, this.anchor ?? cur ?? k, k));
      else if (!mod) {
        this.select([k]);
        this.anchor = k;
      }
      this.setFocus(k);
    };
    const dirs: Record<string, M.Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    const s = this.spec;
    let handled = true;
    const k = e.key;
    if (dirs[k]) go(cur ? M.neighborBox(this.boxes(), cur, dirs[k]) : this.order[0]);
    else if (k === 'Home') go(this.order[0]);
    else if (k === 'End') go(this.order[this.order.length - 1]);
    else if (k === 'Enter' && e.altKey) s.onProperties?.(this.selected());
    else if (k === 'Enter') this.openSelected();
    else if (k === 'Delete') this.sel.size && s.onDelete?.(this.selected());
    else if (k === 'F2') cur && this.sel.has(cur) && this.startRename(cur);
    else if (k === 'F5') this.refresh();
    else if (mod && k.toLowerCase() === 'a') this.selectAll();
    else if (mod && k.toLowerCase() === 'c') this.sel.size && s.onCopy?.(this.selected());
    else if (mod && k.toLowerCase() === 'x') this.sel.size && s.onCut?.(this.selected());
    else if (mod && k.toLowerCase() === 'v') s.onPaste?.();
    else if (mod && k.toLowerCase() === 'z') s.onUndo?.();
    else if (k === ' ' && cur) {
      if (mod && this.sel.has(cur)) this.sel.delete(cur);
      else this.sel.add(cur);
      this.anchor = cur;
      this.syncSel();
    } else if (k.length === 1 && !mod && !e.altKey) {
      const now = performance.now();
      this.typed = now - this.typedAt > 1000 ? k.toLowerCase() : this.typed + k.toLowerCase();
      this.typedAt = now;
      const hit = M.typeAhead(this.order, (id) => s.name(this.byKey.get(id)!), cur, this.typed);
      if (hit) {
        this.select([hit]);
        this.anchor = hit;
        this.setFocus(hit);
      }
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---------------------------------------------------------------- inline rename (F2)

  startRename(k: string) {
    const t = this.byKey.get(k);
    const el = this.list.querySelector<HTMLElement>(`.fv-item[data-key="${CSS.escape(k)}"]`);
    const lbl = el?.querySelector<HTMLElement>('.fv-lbl');
    if (!t || !el || !lbl || !this.spec.rename || this.renaming) return;
    this.renaming = k;
    this.select([k]);
    this.setFocus(k);
    const old = this.spec.name(t);
    const inp = h('input', { class: 'fv-rename', type: 'text', value: old, 'aria-label': 'New name', spellcheck: 'false', maxLength: 255 });
    lbl.hidden = true;
    lbl.after(inp);
    el.classList.add('renaming');
    inp.focus();
    // the name is selected without its extension, as in 98
    const dot = old.lastIndexOf('.');
    inp.setSelectionRange(0, dot > 0 ? dot : old.length);
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      inp.remove();
      lbl.hidden = false;
      el.classList.remove('renaming');
      this.renaming = null;
      if (keep && v && v !== old) {
        if (!M.validFileName(v)) {
          message('Rename', 'A filename cannot contain any of the following characters:\n\\ / : * ? " < > |', 'error');
        } else if (this.spec.rename!(t, v) !== false) setText(lbl, v);
      }
      if (this.dirty) this.render();
      this.list.focus({ preventScroll: true });
      this.setFocus(k);
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
}

/** The address bar's drop-down: the places this little shell has. */
function addressMenu(current: string): MenuItem[] {
  const go = (id: string) => () => void openApp(id);
  return [
    { label: 'Desktop', icon: 'display', onClick: () => windows().forEach((w) => !w.minimized && w.minimize()) },
    { label: 'My Computer', icon: 'computer', disabled: true },
    { label: 'Removable Disk (E:)', icon: 'disk', onClick: go('card') },
    { label: 'My Pictures', icon: 'pictures', checked: current === 'pictures' ? true : undefined, onClick: go('pictures') },
    { label: 'Presets', icon: 'presets', onClick: go('presets') },
    { label: 'Recycle Bin', icon: 'recycle', onClick: go('recycle') },
  ];
}

// ------------------------------------------------------------------ the 98 property sheet

export interface PropRow {
  label: string;
  value: string;
}

export interface PropSheet {
  id: string;
  title: string;
  icon: string;
  name: string;
  /** Rename from the name box (OK / Apply). Return false to refuse. */
  onRename?: (name: string) => boolean | void;
  /** Groups of rows, separated by etched lines. */
  groups: PropRow[][];
  attrs?: { readOnly?: boolean; hidden?: boolean; archive?: boolean; system?: boolean };
  /** Extra tabs after General (name, builder). */
  extra?: [string, () => HTMLElement][];
}

/** A modeless 98 property sheet: tabs, the General page (big icon, name box, etched groups of label/value
 *  rows, Attributes), and OK / Cancel / Apply. */
export function propertySheet(p: PropSheet): Win {
  const existing = getWin(p.id);
  if (existing) {
    existing.focus();
    return existing;
  }
  let name = p.name;
  let tab = 0;
  const names = ['General', ...(p.extra ?? []).map((x) => x[0])];
  const tabBar = h('div');
  const page = h('div', { class: 'tabpage xw-psheet' });
  const apply = h('button', { class: 'btn', type: 'button', disabled: true }, 'Apply');
  const commit = () => {
    const v = name.trim();
    if (v === p.name || !p.onRename) return true;
    if (!M.validFileName(v)) {
      message('Rename', 'A filename cannot contain any of the following characters:\n\\ / : * ? " < > |', 'error');
      return false;
    }
    if (p.onRename(v) === false) return false;
    p.name = v;
    apply.disabled = true;
    return true;
  };
  const general = () => {
    const inp = h('input', { type: 'text', value: name, 'aria-label': 'Name', spellcheck: 'false', readOnly: !p.onRename });
    inp.addEventListener('input', () => {
      name = inp.value;
      apply.disabled = name.trim() === p.name;
    });
    const out: HTMLElement[] = [h('div', { class: 'xw-ptop' }, iconImg(p.icon, 32), h('span', { class: 'field grow' + (p.onRename ? '' : ' ro') }, inp))];
    for (const g of p.groups) {
      out.push(h('div', { class: 'xw-psep', 'aria-hidden': 'true' }));
      out.push(h('div', { class: 'xw-pgrid' }, g.map((r) => [h('span', { class: 'xw-pl' }, r.label), h('span', { class: 'xw-pv selectable' }, r.value)])));
    }
    if (p.attrs) {
      const a = p.attrs;
      out.push(h('div', { class: 'xw-psep', 'aria-hidden': 'true' }));
      out.push(
        h(
          'div',
          { class: 'xw-pgrid' },
          h('span', { class: 'xw-pl' }, 'Attributes:'),
          h('div', { class: 'xw-attrs' }, checkbox('Read-only', !!a.readOnly, () => {}, { disabled: true }), checkbox('Hidden', !!a.hidden, () => {}, { disabled: true }), checkbox('Archive', !!a.archive, () => {}, { disabled: true }), checkbox('System', !!a.system, () => {}, { disabled: true })),
        ),
      );
    }
    return out;
  };
  const render = () => {
    tabBar.replaceChildren(tabs(names, tab, (i) => ((tab = i), render())));
    page.replaceChildren(...(tab === 0 ? general() : [p.extra![tab - 1][1]()]));
  };
  render();
  let win: Win;
  const ok = h('button', { class: 'btn default', type: 'button', onclick: () => commit() && win.close() }, 'OK');
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => win.close() }, 'Cancel');
  apply.addEventListener('click', () => void commit());
  const body = h('div', { class: 'xw-props' }, tabBar, page, h('div', { class: 'xw-pbtns' }, ok, cancel, apply));
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      win.close();
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
      e.preventDefault();
      ok.click();
    }
  });
  win = openWindow({ id: p.id, title: p.title, icon: p.icon, body, width: 362, height: 420, resizable: false });
  requestAnimationFrame(() => {
    // fit the sheet to its General page
    const need = Math.min(body.scrollHeight + 25, 600);
    win.el.style.height = need + 'px';
    win.el.dataset.wh = String(need);
    ok.focus();
  });
  return win;
}

/** The standard 98 Explorer toolbar, given the folder's own commands. */
export function standardButtons(o: { cut?: () => void; copy?: () => void; paste?: () => void; undo?: () => void; del?: () => void; props?: () => void; canCut?: () => boolean; canCopy?: () => boolean; canPaste?: () => boolean; canUndo?: () => boolean; canDel?: () => boolean; canProps?: () => boolean }): (ToolSpec | 'sep' | 'views')[] {
  const no = () => false;
  const t = (icon: ToolIcon, label: string, run: (() => void) | undefined, can: (() => boolean) | undefined, tip?: string): ToolSpec => ({ icon, label, tip, run: run ?? (() => {}), enabled: run ? can ?? (() => true) : no });
  return [
    t('back', 'Back', undefined, undefined),
    t('forward', 'Forward', undefined, undefined),
    t('up', 'Up', undefined, undefined, 'Up One Level'),
    'sep',
    t('cut', 'Cut', o.cut, o.canCut),
    t('copy', 'Copy', o.copy, o.canCopy),
    t('paste', 'Paste', o.paste, o.canPaste),
    'sep',
    t('undo', 'Undo', o.undo, o.canUndo),
    'sep',
    t('delete', 'Delete', o.del, o.canDel),
    t('properties', 'Properties', o.props, o.canProps),
    'sep',
    'views',
  ];
}
