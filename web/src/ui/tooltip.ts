// Windows 98 tooltips (#FFFFE1, 1 px black border, our pixel font) and the global native-UI pass.
// The pass watches only the nodes that get added (and `title` attribute changes), never rescans the page:
// - every `title` becomes `data-tip` (so the browser never shows its own tooltip),
// - every <img> gets draggable=false (no drag ghosts),
// - any stray <select> is put behind our drop-down list.
import { menuLayer, isMenuOpen } from './menu';
import { ui, toUi } from './scale';
import { clampTip } from './uimath';
import { h } from './dom';
import { dropdown } from './dropdown';

const DELAY = 500;
const RESHOW = 100;
const AUTOPOP = 5000;

let tipEl: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let popTimer: ReturnType<typeof setTimeout> | null = null;
let cur: HTMLElement | null = null;
let suppressed: HTMLElement | null = null;
let last = { x: 0, y: 0 };
let lastHide = 0;
let inited = false;

/** Sets (or clears) an element's tooltip text. */
export function setTip(el: HTMLElement, text: string | null | undefined) {
  if (text) el.dataset.tip = text;
  else delete el.dataset.tip;
  if (el === cur && tipEl) hideTip();
}

/** Moves a `title` attribute into data-tip (keeping it as the accessible name when there is no other). */
function convert(el: Element) {
  const t = el.getAttribute('title');
  if (t === null) return;
  el.removeAttribute('title');
  const he = el as HTMLElement;
  if (!he.dataset) return;
  if (t.trim()) {
    he.dataset.tip = t;
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !(el.textContent ?? '').trim()) el.setAttribute('aria-label', t);
  } else delete he.dataset.tip;
}

function passOver(node: Element) {
  if (node.hasAttribute('title')) convert(node);
  if (node.tagName === 'IMG') (node as HTMLImageElement).draggable = false;
  if (node.tagName === 'SELECT') upgrade(node as HTMLSelectElement);
  if (!node.firstElementChild) return;
  for (const el of node.querySelectorAll('[title]')) convert(el);
  for (const img of node.querySelectorAll('img')) img.draggable = false;
  for (const sel of node.querySelectorAll('select')) upgrade(sel);
}

function upgrade(sel: HTMLSelectElement) {
  if (sel.closest('.combo') || !sel.parentNode) return;
  dropdown(sel);
}

/** Runs the native-UI pass over a subtree now (the observer does it for everything added later). */
export function nativeUiPass(root: Element) {
  passOver(root);
}

export function initTooltips() {
  if (inited) return;
  inited = true;
  passOver(document.documentElement);
  new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'attributes') {
        if (r.target.nodeType === 1 && (r.target as Element).hasAttribute('title')) convert(r.target as Element);
        continue;
      }
      for (const n of r.addedNodes) if (n.nodeType === 1) passOver(n as Element);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    if (t === cur) return;
    const wasShown = !!tipEl || performance.now() - lastHide < 300;
    hideTip();
    cur = t;
    if (suppressed && suppressed !== t) suppressed = null;
    if (!t || t === suppressed || !t.dataset.tip) return;
    last = toUi(e);
    showTimer = setTimeout(show, wasShown ? RESHOW : DELAY);
  });
  document.addEventListener('pointermove', (e) => {
    if (!tipEl) last = toUi(e);
  });
  document.documentElement.addEventListener('pointerleave', () => {
    hideTip();
    cur = null;
  });
  const quit = () => {
    if (cur) suppressed = cur;
    hideTip();
    lastHide = 0;
  };
  addEventListener('pointerdown', quit, true);
  addEventListener('keydown', quit, true);
  addEventListener('wheel', quit, { capture: true, passive: true });
  addEventListener('scroll', quit, true);
}

function show() {
  showTimer = null;
  const layer = menuLayer();
  if (!cur || !layer || !document.contains(cur) || isMenuOpen()) return;
  const text = cur.dataset.tip;
  if (!text) return;
  place(h('div', { class: 'tooltip', role: 'tooltip' }, text), last.x, last.y);
  popTimer = setTimeout(hideTip, AUTOPOP);
}

function place(el: HTMLElement, x: number, y: number, below = 20) {
  const layer = menuLayer();
  if (!layer) return;
  tipEl?.remove();
  tipEl = el;
  el.style.left = '0px';
  el.style.top = '0px';
  layer.appendChild(el);
  const p = clampTip(x, y, el.offsetWidth, el.offsetHeight, ui.w, ui.h, below);
  el.style.left = p.x + 'px';
  el.style.top = p.y + 'px';
}

export function hideTip() {
  if (showTimer) clearTimeout(showTimer);
  if (popTimer) clearTimeout(popTimer);
  showTimer = popTimer = null;
  if (tipEl) {
    tipEl.remove();
    tipEl = null;
    lastHide = performance.now();
  }
}

/** The "What's This?" popup: a tooltip-style box at (x,y) in UI pixels that stays until the next click
 *  or key press. */
export function showHelpTip(text: string, x: number, y: number) {
  hideTip();
  // let the click that chose "What's This?" finish before listening for the one that dismisses it
  setTimeout(() => {
    place(h('div', { class: 'tooltip help', role: 'tooltip' }, text), x, y, 4);
    cur = null;
  }, 0);
}
