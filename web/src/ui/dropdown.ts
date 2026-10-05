// Windows 98 drop-down list (combo box). The native <select> stays in the DOM, hidden, and keeps the value:
// choosing an item sets it and fires its 'change' (and 'input') event, so existing listeners keep working.
// Closed: arrows/Home/End/type-ahead change the value at once; F4 or Alt+Down opens the list.
// Open: arrows, PageUp/PageDown, type-ahead move the highlight; Enter/Tab choose; Esc cancels.
import { h, tx } from './dom';
import { ui, uiRect } from './scale';
import { menuLayer } from './menu';
import { popupLifecycle } from './popup';
import { placeBelow, typeAhead } from './uimath';
import { textWidth } from './pixeltext';

const VISIBLE = 8;
let nid = 0;

/** Wraps a <select> in a 98 combo box and returns the wrapper (the select moves inside it, hidden). */
export function dropdown(sel: HTMLSelectElement, opts: { width?: number; label?: string } = {}): HTMLElement {
  const listId = 'cbl' + ++nid;
  const text = h('span', { class: 'combo-text' });
  const btn = h('span', { class: 'combo-btn', 'aria-hidden': 'true' });
  const wrap = h('span', {
    class: 'field combo',
    role: 'combobox',
    tabIndex: sel.disabled ? -1 : 0,
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-label': opts.label ?? sel.getAttribute('aria-label') ?? '',
  });
  if (sel.parentNode) sel.parentNode.insertBefore(wrap, sel);
  sel.classList.add('combo-native');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');
  wrap.append(sel, text, btn);
  if (sel.disabled) wrap.classList.add('disabled');
  if (opts.width) wrap.style.width = opts.width + 'px';
  else {
    // as wide as the longest item (our font's exact advance widths), like a 98 dialog's combo
    const longest = Math.max(24, ...[...sel.options].map((o) => textWidth(o.text)));
    wrap.style.minWidth = `calc(${longest}px * var(--ts) + 28px)`;
  }

  let typed = '';
  let typedAt = 0;
  const labels = () => [...sel.options].map((o) => o.text);
  const sync = () => {
    text.replaceChildren(tx(sel.selectedOptions[0]?.text ?? ''));
  };
  const choose = (i: number) => {
    if (i < 0 || i >= sel.options.length || i === sel.selectedIndex) return;
    sel.selectedIndex = i;
    sync();
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const ahead = (key: string, from: number): number => {
    const now = performance.now();
    typed = now - typedAt < 1000 ? typed + key : key;
    typedAt = now;
    return typeAhead(labels(), from, typed);
  };
  sel.addEventListener('change', sync);
  sync();

  // ---------------------------------------------------------------- the list popup
  let list: HTMLElement | null = null;
  let hl = -1;
  let end: (() => void) | null = null;
  const rows: HTMLElement[] = [];

  const setHl = (i: number) => {
    if (!list || i < 0 || i >= rows.length) return;
    rows[hl]?.classList.remove('hl');
    hl = i;
    const r = rows[i];
    r.classList.add('hl');
    wrap.setAttribute('aria-activedescendant', r.id);
    if (r.offsetTop < list.scrollTop) list.scrollTop = r.offsetTop;
    else if (r.offsetTop + r.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = r.offsetTop + r.offsetHeight - list.clientHeight;
  };

  const close = (commit: boolean) => {
    if (!list) return;
    const pick = hl;
    list.remove();
    list = null;
    rows.length = 0;
    end?.();
    end = null;
    wrap.classList.remove('open');
    wrap.setAttribute('aria-expanded', 'false');
    wrap.removeAttribute('aria-activedescendant');
    if (commit) choose(pick);
  };
  const cancel = () => close(false);
  const onOutside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (list?.contains(t) || wrap.contains(t)) return;
    close(false);
  };
  const onListKey = (e: KeyboardEvent) => {
    if (!list) return;
    const k = e.key;
    const n = rows.length;
    let used = true;
    if (k === 'ArrowDown') setHl(Math.min(n - 1, hl + 1));
    else if (k === 'ArrowUp' && !e.altKey) setHl(Math.max(0, hl - 1));
    else if (k === 'PageDown') setHl(Math.min(n - 1, hl + VISIBLE - 1));
    else if (k === 'PageUp') setHl(Math.max(0, hl - VISIBLE + 1));
    else if (k === 'Home') setHl(0);
    else if (k === 'End') setHl(n - 1);
    else if (k === 'Enter' || k === 'F4' || (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown'))) close(true);
    else if (k === 'Escape') close(false);
    else if (k === 'Tab') {
      close(true);
      used = false;
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const j = ahead(k, hl);
      if (j >= 0) setHl(j);
    } else used = false;
    if (used) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const open = () => {
    const layer = menuLayer();
    if (list || !layer || sel.disabled) return;
    sync();
    const opts = [...sel.options];
    list = h('div', { class: 'combo-list', role: 'listbox', id: listId, 'aria-label': wrap.getAttribute('aria-label') ?? '' });
    opts.forEach((o, i) => {
      const r = h('div', { class: 'combo-opt' + (o.disabled ? ' dis' : ''), role: 'option', id: `${listId}-${i}`, 'aria-selected': String(i === sel.selectedIndex) }, o.text || ' ');
      r.addEventListener('pointermove', () => hl !== i && setHl(i));
      r.addEventListener('pointerup', (e) => {
        if (e.button !== 0 || o.disabled) return;
        hl = i;
        close(true);
        wrap.focus({ preventScroll: true });
      });
      rows.push(r);
      list!.appendChild(r);
    });
    // (an open menu or another list closes first)
    end = popupLifecycle({ close: cancel, onOutside, onKey: onListKey });
    const a = uiRect(wrap);
    list.style.minWidth = Math.round(a.w) + 'px';
    layer.appendChild(list);
    const rowH = rows[0]?.offsetHeight || 16;
    if (rows.length > VISIBLE) list.style.height = rowH * VISIBLE + 2 + 'px';
    const p = placeBelow(a, Math.max(list.offsetWidth, a.w), list.offsetHeight, ui.w, ui.h);
    list.style.left = p.x + 'px';
    list.style.top = p.y + 'px';
    wrap.classList.add('open');
    wrap.setAttribute('aria-expanded', 'true');
    hl = -1;
    setHl(Math.max(0, sel.selectedIndex));
  };

  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || sel.disabled) return;
    e.preventDefault();
    wrap.focus({ preventScroll: true });
    if (list) close(false);
    else open();
  });
  wrap.addEventListener('keydown', (e) => {
    if (list || sel.disabled) return;
    const k = e.key;
    const n = sel.options.length;
    const i = sel.selectedIndex;
    let used = true;
    if (k === 'F4' || (e.altKey && (k === 'ArrowDown' || k === 'ArrowUp'))) open();
    else if (k === 'ArrowDown' || k === 'ArrowRight') choose(Math.min(n - 1, i + 1));
    else if (k === 'ArrowUp' || k === 'ArrowLeft') choose(Math.max(0, i - 1));
    else if (k === 'Home') choose(0);
    else if (k === 'End') choose(n - 1);
    else if (k === 'PageDown') choose(Math.min(n - 1, i + VISIBLE - 1));
    else if (k === 'PageUp') choose(Math.max(0, i - VISIBLE + 1));
    else if (k.length === 1 && k !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const j = ahead(k, i);
      if (j >= 0) choose(j);
    } else used = false;
    if (used) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  return wrap;
}
