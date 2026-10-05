// Windows 98 popup menus: cascading submenus beside their item (opened after a 400 ms hover), keyboard
// (arrows, Enter, Esc one level, Left/Right between submenus and along the menu bar), mnemonics (& in the
// label, Alt+letter on a window's menu bar), menu-bar hover tracking, flip/shift at the screen edges.
// No shadow, navy highlight, embossed grey disabled items, 98 check marks, radio bullets and etched lines.
import { h, tx } from './dom';
import { iconImg } from './art';
import { ui, uiRect } from './scale';
import { popupLifecycle, closePopup } from './popup';
import { placeAtPoint, placeBelow, placeSubmenu, parseMnemonic, mnemonicKey, nextIndex } from './uimath';

export interface MenuItem {
  /** Text; a single & marks the mnemonic letter ("&Open"), && is a literal &. */
  label?: string;
  icon?: string;
  /** Shortcut text, right-aligned ("Ctrl+O"). */
  acc?: string;
  disabled?: boolean;
  /** Shows a check mark (or the radio bullet when `radio`); `false` reserves the column. */
  checked?: boolean;
  radio?: boolean;
  /** The default item, drawn bold (what a double-click would do). */
  default?: boolean;
  /** A separator line. */
  sep?: boolean;
  /** A non-selectable bold heading (the phone layout folds the menu bar into one menu with headings). */
  head?: string;
  onClick?: () => void;
  /** Cascading submenu (an array, or a function called each time it opens). */
  sub?: MenuItem[] | (() => MenuItem[]);
}

export interface MenuOpts {
  onClose?: () => void;
  minWidth?: number;
  label?: string;
  /** Highlight the first item at once (menus opened from the keyboard). */
  keyboard?: boolean;
}

const HOVER_MS = 400;

interface Level {
  el: HTMLElement;
  items: MenuItem[];
  rows: (HTMLElement | null)[];
  hl: number;
  parent: Level | null;
  child: Level | null;
  /** Index of the item whose submenu is open (-1 when none). */
  ci: number;
  openTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
}

interface Session {
  root: Level;
  opts: MenuOpts;
  anchor: HTMLElement | null;
  bar: HTMLElement | null;
  prevFocus: HTMLElement | null;
  close: (restoreFocus?: boolean) => void;
}

let session: Session | null = null;
let layer: HTMLElement | null = null;
let pendingKeyboard = false;

export function setMenuLayer(el: HTMLElement) {
  layer = el;
  installMenuBarKeys();
}

/** The overlay layer menus, drop-down lists and tooltips are placed in (the app root). */
export function menuLayer(): HTMLElement | null {
  return layer;
}

export function closeMenu() {
  session?.close(true);
}

export function isMenuOpen(): boolean {
  return !!session;
}

const subOf = (it: MenuItem) => it.sub;
const isSep = (it: MenuItem) => !!it.sep;
const selectable = (it: MenuItem) => !isSep(it) && !it.head;

/** A label with its mnemonic letter underlined, as one crisp text run. Use it for menu-bar titles too. */
export function mnemonicLabel(label: string): HTMLSpanElement {
  const m = parseMnemonic(label);
  const sp = tx('');
  if (m.index < 0) sp.textContent = m.text;
  else {
    sp.textContent = '';
    const u = document.createElement('u');
    u.textContent = m.text[m.index];
    sp.append(m.text.slice(0, m.index), u, m.text.slice(m.index + 1));
  }
  return sp;
}

function buildLevel(items: MenuItem[], parent: Level | null, opts: MenuOpts): Level {
  const el = h('div', { class: 'menu', role: 'menu', 'aria-label': parseMnemonic(opts.label ?? 'Menu').text, tabIndex: -1 });
  if (opts.minWidth && !parent) el.style.minWidth = opts.minWidth + 'px';
  const lv: Level = { el, items, rows: [], hl: -1, parent, child: null, ci: -1, openTimer: null, closeTimer: null };
  items.forEach((it, i) => {
    if (isSep(it)) {
      el.appendChild(h('div', { class: 'msep', role: 'separator' }));
      lv.rows.push(null);
      return;
    }
    if (it.head) {
      el.appendChild(h('div', { class: 'mhead' }, parseMnemonic(it.head).text));
      lv.rows.push(null);
      return;
    }
    const sub = subOf(it);
    const role = it.checked !== undefined ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem';
    const cls = ['mi'];
    if (it.disabled) cls.push('dis');
    if (it.default) cls.push('def');
    if (sub) cls.push('sub');
    if (it.checked) cls.push(it.radio ? 'rad' : 'chk');
    const shortcut = it.acc;
    const row = h(
      'div',
      {
        class: cls.join(' '),
        role,
        'aria-disabled': it.disabled ? 'true' : undefined,
        'aria-checked': it.checked !== undefined ? String(!!it.checked) : undefined,
        'aria-haspopup': sub ? 'menu' : undefined,
      },
      h('span', { class: 'mck', 'aria-hidden': 'true' }, it.icon && it.checked === undefined ? iconImg(it.icon, 16) : null),
      h('span', { class: 'mlabel' }, mnemonicLabel(it.label ?? '')),
      shortcut ? h('span', { class: 'macc' }, shortcut) : null,
      h('span', { class: 'marr', 'aria-hidden': 'true' }),
    );
    row.addEventListener('pointerenter', () => hover(lv, i));
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      activate(lv, i, false);
    });
    // a right-button release on an item also chooses it, as in Windows
    row.addEventListener('pointerup', (e) => {
      if (e.button === 2) activate(lv, i, false);
    });
    el.appendChild(row);
    lv.rows.push(row);
  });
  el.addEventListener('pointerenter', () => {
    // coming into a submenu keeps it (and its ancestors) open, with the parent item highlighted
    for (let c: Level = lv; c.parent; c = c.parent) {
      const p = c.parent;
      if (p.closeTimer) clearTimeout(p.closeTimer);
      p.closeTimer = null;
      if (p.openTimer) clearTimeout(p.openTimer);
      p.openTimer = null;
      if (p.ci >= 0) setHl(p, p.ci);
    }
  });
  el.addEventListener('pointerleave', () => {
    if (!lv.child) setHl(lv, -1);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return lv;
}

function setHl(lv: Level, i: number) {
  if (lv.hl === i) return;
  lv.rows[lv.hl]?.classList.remove('hl');
  lv.hl = i;
  const r = lv.rows[i];
  if (r) {
    r.classList.add('hl');
    lv.el.setAttribute('aria-activedescendant', r.id || (r.id = 'mi' + Math.random().toString(36).slice(2, 8)));
    // keep the item visible in a scrolled (very tall) menu
    const top = r.offsetTop;
    if (top < lv.el.scrollTop) lv.el.scrollTop = top;
    else if (top + r.offsetHeight > lv.el.scrollTop + lv.el.clientHeight) lv.el.scrollTop = top + r.offsetHeight - lv.el.clientHeight;
  } else lv.el.removeAttribute('aria-activedescendant');
}

function hover(lv: Level, i: number) {
  if (lv.openTimer) clearTimeout(lv.openTimer);
  lv.openTimer = null;
  setHl(lv, i);
  const it = lv.items[i];
  const sub = subOf(it);
  if (lv.child && lv.ci !== i) {
    // a different item: the open submenu goes away after the hover delay unless the pointer returns
    if (!lv.closeTimer)
      lv.closeTimer = setTimeout(() => {
        lv.closeTimer = null;
        if (lv.ci !== lv.hl) closeChild(lv);
      }, HOVER_MS);
  } else if (lv.child && lv.ci === i && lv.closeTimer) {
    clearTimeout(lv.closeTimer);
    lv.closeTimer = null;
  }
  if (sub && !it.disabled && lv.ci !== i) {
    lv.openTimer = setTimeout(() => {
      lv.openTimer = null;
      if (lv.hl === i) openChild(lv, i, false);
    }, HOVER_MS);
  }
}

function closeChild(lv: Level) {
  const c = lv.child;
  if (!c) return;
  closeChild(c);
  if (c.openTimer) clearTimeout(c.openTimer);
  if (c.closeTimer) clearTimeout(c.closeTimer);
  c.el.remove();
  lv.child = null;
  lv.ci = -1;
  lv.rows.forEach((r) => r?.classList.remove('open'));
}

function openChild(lv: Level, i: number, keyboard: boolean) {
  if (!layer || !session) return;
  const it = lv.items[i];
  const src = subOf(it);
  if (!src || it.disabled) return;
  if (lv.closeTimer) clearTimeout(lv.closeTimer);
  lv.closeTimer = null;
  if (lv.child && lv.ci === i) {
    if (keyboard && lv.child.hl < 0) setHl(lv.child, firstSelectable(lv.child));
    return;
  }
  closeChild(lv);
  const items = typeof src === 'function' ? src() : src;
  const c = buildLevel(items, lv, session.opts);
  layer.appendChild(c.el);
  const row = lv.rows[i]!;
  row.classList.add('open');
  const W = ui.w;
  const H = ui.h;
  c.el.style.maxHeight = H + 'px';
  const p = placeSubmenu(uiRect(row), uiRect(lv.el), c.el.offsetWidth, Math.min(c.el.offsetHeight, H), W, H);
  c.el.style.left = p.x + 'px';
  c.el.style.top = p.y + 'px';
  lv.child = c;
  lv.ci = i;
  if (keyboard) setHl(c, firstSelectable(c));
}

function firstSelectable(lv: Level): number {
  return nextIndex(lv.items.length, -1, 1, (k) => selectable(lv.items[k]));
}

function deepest(): Level | null {
  let lv = session?.root ?? null;
  while (lv?.child) lv = lv.child;
  return lv;
}

function activate(lv: Level, i: number, keyboard: boolean) {
  const it = lv.items[i];
  if (!it || !selectable(it) || it.disabled) return;
  if (subOf(it)) {
    if (lv.openTimer) clearTimeout(lv.openTimer);
    openChild(lv, i, keyboard);
    return;
  }
  session?.close(true);
  it.onClick?.();
}

/** Moves to the next/previous title on the menu bar the current menu came from. */
function barStep(dir: 1 | -1): boolean {
  const s = session;
  if (!s?.bar || !s.anchor) return false;
  const titles = barTitles(s.bar);
  const i = titles.indexOf(s.anchor);
  if (i < 0 || titles.length < 2) return false;
  const next = titles[(i + dir + titles.length) % titles.length];
  s.close(false);
  pendingKeyboard = true;
  next.click();
  pendingKeyboard = false;
  return true;
}

function barTitles(bar: HTMLElement): HTMLElement[] {
  return [...bar.querySelectorAll<HTMLElement>(':scope > button, :scope > [role="menuitem"]')].filter((b) => !(b as HTMLButtonElement).disabled);
}

function onKey(e: KeyboardEvent) {
  const lv = deepest();
  if (!lv || !session) return;
  const k = e.key;
  // a menu owns the keyboard while it is open
  e.preventDefault();
  e.stopPropagation();
  const n = lv.items.length;
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    const j = nextIndex(n, lv.hl < 0 && k === 'ArrowUp' ? 0 : lv.hl, k === 'ArrowDown' ? 1 : -1, (x) => selectable(lv.items[x]));
    if (j >= 0) setHl(lv, j);
  } else if (k === 'Home') setHl(lv, firstSelectable(lv));
  else if (k === 'End') {
    const j = nextIndex(n, 0, -1, (x) => selectable(lv.items[x]));
    if (j >= 0) setHl(lv, j);
  } else if (k === 'ArrowRight') {
    const it = lv.items[lv.hl];
    if (it && subOf(it) && !it.disabled) openChild(lv, lv.hl, true);
    else barStep(1);
  } else if (k === 'ArrowLeft') {
    if (lv.parent) closeChild(lv.parent);
    else barStep(-1);
  } else if (k === 'Enter' || k === ' ') {
    if (lv.hl >= 0) activate(lv, lv.hl, true);
  } else if (k === 'Escape') {
    if (lv.parent) closeChild(lv.parent);
    else session.close(true);
  } else if (k === 'Alt' || k === 'F10') {
    session.close(true);
  } else if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
    const key = k.toLowerCase();
    const hits: number[] = [];
    lv.items.forEach((it, x) => selectable(it) && it.label && mnemonicKey(it.label) === key && hits.push(x));
    if (hits.length === 1) {
      setHl(lv, hits[0]);
      activate(lv, hits[0], true);
    } else if (hits.length > 1) {
      setHl(lv, hits.find((x) => x > lv.hl) ?? hits[0]);
    }
  }
}

function inMenus(t: Node | null): boolean {
  for (let lv = session?.root ?? null; lv; lv = lv.child) if (t && lv.el.contains(t)) return true;
  return false;
}

function openSession(items: MenuItem[], place: (w: number, h: number) => { x: number; y: number }, opts: MenuOpts, anchor: HTMLElement | null): () => void {
  closePopup();
  if (!layer) return () => {};
  const keyboard = opts.keyboard ?? pendingKeyboard;
  const prevFocus = session ? null : (document.activeElement as HTMLElement | null);
  const root = buildLevel(items, null, opts);
  layer.appendChild(root.el);
  const H = ui.h;
  root.el.style.maxHeight = H + 'px';
  const p = place(root.el.offsetWidth, Math.min(root.el.offsetHeight, H));
  root.el.style.left = p.x + 'px';
  root.el.style.top = p.y + 'px';
  const bar = (anchor?.closest('[role="menubar"]') as HTMLElement | null) ?? null;

  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (inMenus(t)) return;
    if (anchor && anchor.contains(t)) {
      // pressing the open menu's own title closes it (and the click that follows must not reopen it)
      s.close(true);
      const eat = (ev: Event) => {
        if (anchor.contains(ev.target as Node)) {
          ev.stopPropagation();
          ev.preventDefault();
        }
      };
      addEventListener('click', eat, true);
      setTimeout(() => removeEventListener('click', eat, true), 500);
      return;
    }
    s.close(!(bar && bar.contains(t)));
  };
  const onBarOver = (e: PointerEvent) => {
    if (!bar) return;
    const t = (e.target as HTMLElement).closest('button, [role="menuitem"]') as HTMLElement | null;
    if (!t || t === anchor || t.parentElement !== bar) return;
    // menu-bar tracking: with a menu open, hovering another title opens that one
    s.close(false);
    t.click();
  };
  let end = () => {};
  let closed = false;
  const s: Session = {
    root,
    opts,
    anchor,
    bar,
    prevFocus,
    close: (restoreFocus = true) => {
      if (closed) return;
      closed = true;
      end();
      bar?.removeEventListener('pointerover', onBarOver);
      closeChild(root);
      if (root.openTimer) clearTimeout(root.openTimer);
      root.el.remove();
      if (session === s) session = null;
      opts.onClose?.();
      if (restoreFocus && prevFocus && document.contains(prevFocus) && !document.activeElement?.closest('.menu')) {
        // a window that came up while the menu was open keeps the focus: focusing the menu's old owner would
        // raise it over the new window
        const owner = prevFocus.closest('.win');
        const top = document.querySelector('.win.active');
        if (!owner || !top || owner === top) prevFocus.focus?.({ preventScroll: true });
      }
    },
  };
  session = s;
  end = popupLifecycle({ close: () => s.close(false), onOutside: onDown, onKey });
  bar?.addEventListener('pointerover', onBarOver);
  root.el.focus({ preventScroll: true });
  if (keyboard) setHl(root, firstSelectable(root));
  return () => s.close(true);
}

/** Shows a menu at (x,y) in UI pixels (a context menu: flips left/up at the screen edges). Returns a function
 *  that closes it. */
export function showMenu(items: MenuItem[], x: number, y: number, opts: MenuOpts = {}): () => void {
  return openSession(items, (w, hh) => placeAtPoint(x, y, w, hh, ui.w, ui.h), opts, null);
}

/** Menu under an element (a menu-bar title or a button). On a [role=menubar] the bar tracks the pointer
 *  and Left/Right walk along it. */
export function menuAt(anchor: HTMLElement, items: MenuItem[], opts: MenuOpts = {}): () => void {
  if (!layer) return () => {};
  const a = uiRect(anchor);
  return openSession(items, (w, hh) => placeBelow(a, w, hh, ui.w, ui.h), { minWidth: anchor.closest('[role="menubar"]') ? undefined : Math.round(a.w), ...opts }, anchor);
}

/** Alt+letter opens the matching title on the focused window's menu bar (first letter when no & mnemonic). */
let barKeysInstalled = false;
function installMenuBarKeys() {
  if (barKeysInstalled) return;
  barKeysInstalled = true;
  addEventListener('keydown', (e) => {
    if (session || !e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
    const act = document.activeElement as HTMLElement | null;
    const win = act?.closest('.win') ?? document.querySelector('.win.active');
    const bar = win?.querySelector<HTMLElement>('[role="menubar"]');
    if (!bar) return;
    const key = e.key.toLowerCase();
    const hit = barTitles(bar).find((b) => (b.dataset.mn ?? b.querySelector('u')?.textContent ?? (b.textContent ?? '').trim()[0] ?? '').toLowerCase() === key);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    pendingKeyboard = true;
    hit.click();
    pendingKeyboard = false;
  });
}
