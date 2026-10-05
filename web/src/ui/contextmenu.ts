// The one right-click dispatcher. A single document listener (bubble phase) always blocks the browser's
// own menu; when nothing earlier called preventDefault (the caption and taskbar-button system menus do),
// it opens our 98 menu from the most specific registered surface: the deepest element matching a
// registered selector wins (on one element, the latest registration wins). A builder may return null to
// fall through to an outer surface, or [] for "no menu here". Shift+F10 and the ContextMenu key open the
// menu of the focused element.
import { showMenu, isMenuOpen, type MenuItem } from './menu';
import { ui, toUi, uiRect } from './scale';
import { contextCandidates, type ContextEntry } from './uimath';
import { message } from './dialog';
import { showHelpTip } from './tooltip';

export type ContextBuilder = (target: Element, e: MouseEvent) => MenuItem[] | null;

const entries: ContextEntry<ContextBuilder>[] = [];
let order = 0;
let inited = false;
let kbdAt = -1e9;

/** Registers a right-click menu for elements matching `selector`. Returns an unregister function. */
export function registerContext(selector: string, build: ContextBuilder): () => void {
  const e = { selector, build, order: ++order };
  entries.push(e);
  return () => {
    const i = entries.indexOf(e);
    if (i >= 0) entries.splice(i, 1);
  };
}

/** Resolves and opens the context menu for `target` at (x,y) UI px. Returns true when a menu opened. */
export function openContextMenu(target: Element, x: number, y: number, e?: MouseEvent): boolean {
  const chain: Element[] = [];
  for (let el: Element | null = target; el; el = el.parentElement) chain.push(el);
  const ev = e ?? new MouseEvent('contextmenu');
  for (const { el, entry } of contextCandidates(chain, entries, (el, sel) => el.matches(sel))) {
    const items = entry.build(el, ev);
    if (items === null) continue;
    if (!items.length) return false;
    showMenu(items, x, y, { label: 'Context menu', keyboard: !e });
    return true;
  }
  return false;
}

/** How long a finger has to rest for its context menu, and how far it may wander meanwhile (CSS px). */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP = 8;

/** Long-press tracking for touch (iOS Safari never fires `contextmenu`; Android fires it a little later). */
function initLongPress() {
  let press: { id: number; x: number; y: number; t: ReturnType<typeof setTimeout> } | null = null;
  const cancel = () => {
    if (press) clearTimeout(press.t);
    press = null;
  };
  document.addEventListener(
    'pointerdown',
    (e) => {
      cancel();
      const target = e.target as Element;
      // (text boxes keep the phone's own long-press callout: it is the only paste a web page can't block)
      if (e.pointerType !== 'touch' || !e.isPrimary || !target || target.closest?.('.menu') || isTextField(target)) return;
      const { clientX: x, clientY: y } = e;
      press = {
        id: e.pointerId,
        x,
        y,
        t: setTimeout(() => {
          press = null;
          if (isMenuOpen()) return;
          const p = toUi({ clientX: x, clientY: y });
          if (!openContextMenu(target, p.x, p.y, new MouseEvent('contextmenu', { clientX: x, clientY: y }))) return;
          pressAt = performance.now();
          // the finger's release must not also click what it rested on
          const eat = (ev: Event) => {
            ev.preventDefault();
            ev.stopPropagation();
          };
          addEventListener('click', eat, { capture: true, once: true });
          setTimeout(() => removeEventListener('click', eat, { capture: true }), 1000);
        }, LONG_PRESS_MS),
      };
    },
    true,
  );
  document.addEventListener(
    'pointermove',
    (e) => {
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP) cancel();
    },
    true,
  );
  for (const k of ['pointerup', 'pointercancel'] as const)
    document.addEventListener(
      k,
      (e) => {
        if (press && e.pointerId === press.id) cancel();
      },
      true,
    );
  // the browser's own long-press menu event: ours is already open (or about to be)
  document.addEventListener('contextmenu', () => cancel(), true);
}
let pressAt = -1e9;

export function initContextMenu() {
  if (inited) return;
  inited = true;
  initLongPress();
  document.addEventListener('contextmenu', (e) => {
    const already = e.defaultPrevented;
    e.preventDefault();
    if (already || performance.now() - kbdAt < 600 || performance.now() - pressAt < 1500) return;
    const t = e.target as Element;
    if (!t || t.closest?.('.menu')) return;
    const p = toUi(e);
    openContextMenu(t, p.x, p.y, e);
  });
  addEventListener(
    'keydown',
    (e) => {
      if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) || isMenuOpen()) return;
      e.preventDefault();
      kbdAt = performance.now();
      const el = (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.querySelector('.win.active')) ?? document.body;
      const r = uiRect(el);
      openContextMenu(el, Math.round(r.x + Math.min(r.w / 2, 24)), Math.round(r.y + Math.min(r.h / 2, 12)));
    },
    true,
  );
  registerDefaults();
}

// ---------------------------------------------------------------- built-in surfaces

const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type);
}

function selRange(el: HTMLInputElement | HTMLTextAreaElement): [number, number] {
  try {
    const s = el.selectionStart;
    const e = el.selectionEnd;
    if (s !== null && e !== null) return [s, e];
  } catch {
    /* number inputs have no selection API */
  }
  return [0, 0];
}

function insert(el: HTMLInputElement | HTMLTextAreaElement, t: string) {
  el.focus({ preventScroll: true });
  // execCommand keeps the field's own undo history; setRangeText is the fallback
  if (document.execCommand('insertText', false, t)) return;
  const [s, e] = selRange(el);
  try {
    el.setRangeText(t, s, e, 'end');
  } catch {
    el.value = el.value.slice(0, s) + t + el.value.slice(e);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The 98 edit-control menu: Undo, Cut, Copy, Paste, Delete, Select All. */
export function textFieldMenu(el: HTMLInputElement | HTMLTextAreaElement): MenuItem[] {
  const ro = el.readOnly || el.disabled;
  const [s, e] = selRange(el);
  const has = e > s;
  const secret = el instanceof HTMLInputElement && el.type === 'password';
  const selected = () => el.value.slice(...selRange(el));
  const focus = () => el.focus({ preventScroll: true });
  return [
    { label: '&Undo', disabled: ro, onClick: () => (focus(), document.execCommand('undo')) },
    { sep: true },
    {
      label: 'Cu&t',
      disabled: ro || !has || secret,
      onClick: () => {
        focus();
        const t = selected();
        if (!document.execCommand('cut')) void navigator.clipboard?.writeText(t).then(() => insert(el, ''));
      },
    },
    {
      label: '&Copy',
      disabled: !has || secret,
      onClick: () => {
        focus();
        const t = selected();
        if (!document.execCommand('copy')) void navigator.clipboard?.writeText(t);
      },
    },
    {
      label: '&Paste',
      disabled: ro,
      onClick: () => {
        focus();
        // (a phone has no Ctrl+V: its own paste is on a long press in the box)
        const fail = () => message('Paste', ui.phone || matchMedia('(pointer: coarse)').matches ? 'Touch and hold in the box, then choose Paste.' : 'Press Ctrl+V to paste.', 'info');
        if (!navigator.clipboard?.readText) return fail();
        navigator.clipboard.readText().then((t) => insert(el, t), fail);
      },
    },
    {
      label: '&Delete',
      disabled: ro || !has,
      onClick: () => {
        focus();
        if (!document.execCommand('delete')) insert(el, '');
      },
    },
    { sep: true },
    { label: 'Select &All', disabled: !el.value, onClick: () => (focus(), el.select()) },
  ];
}

function registerDefaults() {
  // the desktop, its icons, the taskbar, Start button and clock register their menus in shell/desktop.ts and
  // shell/taskbar.ts (deeper registrations win, so these window-level ones below don't hide them)
  // inside a window: the 98 dialog "What's This?" help for the control under the pointer
  registerContext('.win', (target, e) => {
    const t = target as HTMLElement;
    // a keyboard-opened menu has no pointer position: use the focused element itself
    const under = (e.isTrusted ? document.elementFromPoint(e.clientX, e.clientY) ?? t : t) as HTMLElement;
    const helpEl = under.closest?.('[data-tip], [aria-label]') as HTMLElement | null;
    const help = helpEl && t.contains(helpEl) ? (helpEl.dataset.tip ?? helpEl.getAttribute('aria-label') ?? '') : '';
    const r = uiRect(under);
    const p = e.isTrusted ? toUi(e) : { x: r.x + 8, y: r.y + r.h };
    return [{ label: "&What's This?", default: true, onClick: () => showHelpTip(help || 'No Help topic is associated with this item.', p.x, p.y) }];
  });
  // selected text in read-only text (help pages, About): Copy and Select All
  registerContext('.selectable', (el) => {
    const sel = getSelection();
    const has = !!sel && !sel.isCollapsed && el.contains(sel.anchorNode);
    if (!has) return null;
    return [
      { label: '&Copy', onClick: () => void navigator.clipboard?.writeText(sel!.toString()).catch(() => document.execCommand('copy')) },
      { sep: true },
      {
        label: 'Select &All',
        onClick: () => {
          const r = document.createRange();
          r.selectNodeContents(el);
          sel!.removeAllRanges();
          sel!.addRange(r);
        },
      },
    ];
  });
  registerContext('input, textarea', (el) => (isTextField(el) ? textFieldMenu(el) : null));
}
