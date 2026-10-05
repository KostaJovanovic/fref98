// Tiny DOM helpers. String children are wrapped in <span class="tx">, which carries the alpha-threshold
// filter that keeps the pixel font free of antialiasing (see theme.css).

export type Child = Node | string | number | null | undefined | false | Child[];
export type Props = Record<string, any> | null | undefined;

const RAW_TEXT = new Set(['option', 'textarea', 'title', 'style', 'script']);

export function tx(s: string | number): HTMLSpanElement {
  const sp = document.createElement('span');
  sp.className = 'tx';
  sp.textContent = String(s);
  snapNew(sp);
  return sp;
}

/** Snapping at creation: a new .tx is measured in the next frame's batch (if it is attached by then). */
function snapNew(sp: HTMLElement) {
  if (!snapRoot) return;
  pendingTx.add(sp);
  queueSnap();
}

function append(el: HTMLElement, c: Child, raw: boolean) {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) {
    for (const x of c) append(el, x, raw);
    return;
  }
  if (typeof c === 'string' || typeof c === 'number') {
    if (raw) el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(tx(c));
    return;
  }
  el.appendChild(c);
}

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'tabIndex', 'min', 'max', 'step', 'type', 'multiple', 'accept', 'placeholder', 'readOnly', 'id', 'htmlFor', 'name', 'draggable', 'width', 'height']);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false && !PROPS.has(k)) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        if (typeof v === 'object')
          for (const [sk, sv] of Object.entries(v)) {
            if (sv === undefined || sv === null) continue;
            if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
            else (el.style as any)[sk] = typeof sv === 'number' && !/opacity|zIndex|flex|order/.test(sk) ? sv + 'px' : sv;
          }
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'ref' && typeof v === 'function') v(el);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) (el as any)[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children, RAW_TEXT.has(tag));
  if (el.classList.contains('tx')) snapNew(el);
  return el;
}

/** Replace all children. */
export function mount(el: HTMLElement, ...children: Child[]) {
  el.replaceChildren();
  append(el, children, RAW_TEXT.has(el.tagName.toLowerCase()));
}

/** Set text of an element as a single crisp span. */
export function setText(el: HTMLElement, s: string) {
  const first = el.firstChild as HTMLElement | null;
  if (el.childNodes.length === 1 && first && first.nodeType === 1 && first.classList.contains('tx')) {
    if (first.textContent !== s) first.textContent = s;
  } else mount(el, s);
}

export function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(sel);
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return n + ' bytes';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export function download(data: Uint8Array | Blob, name: string, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    inp.style.display = 'none';
    inp.onchange = () => {
      resolve([...(inp.files ?? [])]);
      inp.remove();
    };
    inp.addEventListener('cancel', () => {
      resolve([]);
      inp.remove();
    });
    document.body.appendChild(inp);
    inp.click();
  });
}

let crispFilterMade = false;
let crispCut: SVGElement | null = null;
/** Where the alpha threshold sits. Light-on-dark text gets a contrast boost that lifts the 1 px right-hand bleed
 *  of each stroke past 0.5, so a 50 % cut turns it into ink (white captions and highlights look smeared): keep
 *  only alpha ≥ 0.75 then. That needs glyphs on whole device pixels in both directions, which only holds when
 *  the root is not zoomed; at 125 %/150 % (fractional zoom) rows land on fractions and need the 50 % cut. */
function setCrispCut(strict: boolean) {
  const v = strict ? '0 0 0 1' : '0 1';
  if (crispCut && crispCut.getAttribute('tableValues') !== v) crispCut.setAttribute('tableValues', v);
}

/** The SVG filter that thresholds glyph alpha: text pixels end up fully on or fully off. */
export function ensureCrispFilter() {
  if (crispFilterMade) return;
  crispFilterMade = true;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('svgdefs');
  const f = document.createElementNS(NS, 'filter');
  f.setAttribute('id', 'crisp');
  f.setAttribute('color-interpolation-filters', 'sRGB');
  f.setAttribute('x', '0');
  f.setAttribute('y', '0');
  f.setAttribute('width', '1');
  f.setAttribute('height', '1');
  const ct = document.createElementNS(NS, 'feComponentTransfer');
  const fa = document.createElementNS(NS, 'feFuncA');
  fa.setAttribute('type', 'discrete');
  fa.setAttribute('tableValues', '0 1');
  crispCut = fa;
  const { dpr, zoom } = snapScale();
  setCrispCut(zoom === 1 && Number.isInteger(dpr));
  ct.appendChild(fa);
  f.appendChild(ct);
  svg.appendChild(f);
  document.body.appendChild(svg);
}

/** Glyphs only stay crisp when a text run starts on a whole device pixel horizontally (Chrome/DirectWrite
 *  smears glyphs placed at half pixels, and the alpha threshold then breaks them). Centred layouts produce
 *  half pixels, so each .tx is nudged left by its sub-pixel remainder.
 *
 *  No global rescans: a .tx is measured when it is created (tx(), and h() with class "tx"), when a subtree
 *  containing one is attached or its text is replaced (a childList-only observer that looks at the added
 *  nodes), and when the window around it changes size. Everything is measured in one batch per frame. */
let snapRoot: HTMLElement | null = null;
const pendingTx = new Set<HTMLElement>();
let pendingFull = false;
let checkWins = false;
const winSizes = new WeakMap<Element, string>();
let snapQueued = false;
let snapScale: () => { dpr: number; zoom: number } = () => ({ dpr: 1, zoom: 1 });

function snapOne(el: HTMLElement, dpr: number, zoom: number, out: [HTMLElement, number][]) {
  const r = el.getClientRects()[0];
  if (!r) return;
  const cur = Number(el.dataset.sx || 0);
  const dev = (r.left - cur * zoom) * dpr;
  const frac = dev - Math.round(dev);
  const want = Math.abs(frac) < 0.2 ? 0 : -frac / (zoom * dpr);
  if (Math.abs(want - cur) > 0.001) out.push([el, want]);
}

function runSnap() {
  snapQueued = false;
  const root = snapRoot;
  if (!root) return;
  const { dpr, zoom } = snapScale();
  setCrispCut(zoom === 1 && Number.isInteger(dpr));
  if (checkWins && !pendingFull) {
    // only windows whose size changed since the last look (moves are whole UI pixels: nothing to do)
    for (const w of root.querySelectorAll<HTMLElement>('.win')) {
      const s = w.offsetWidth + 'x' + w.offsetHeight;
      if (winSizes.get(w) !== s) {
        winSizes.set(w, s);
        for (const t of w.querySelectorAll<HTMLElement>('.tx')) pendingTx.add(t);
      }
    }
  }
  checkWins = false;
  const list = pendingFull ? root.querySelectorAll<HTMLElement>('.tx') : pendingTx;
  pendingFull = false;
  const shifts: [HTMLElement, number][] = [];
  // measure everything first, then write: one layout for the whole batch
  for (const el of list) if (el.isConnected) snapOne(el, dpr, zoom, shifts);
  pendingTx.clear();
  for (const [el, s] of shifts) {
    el.dataset.sx = String(s);
    el.style.position = s ? 'relative' : '';
    el.style.left = s ? s + 'px' : '';
  }
}

function queueSnap() {
  if (snapQueued || !snapRoot) return;
  snapQueued = true;
  requestAnimationFrame(runSnap);
}

/** Queues one .tx (or every .tx inside an element) for snapping at the next frame. */
export function snapLater(el: Element) {
  if (!snapRoot) return;
  if (el.classList.contains('tx')) pendingTx.add(el as HTMLElement);
  else for (const t of el.querySelectorAll<HTMLElement>('.tx')) pendingTx.add(t);
  queueSnap();
}

export function initTextSnap(root: HTMLElement, getScale: () => { dpr: number; zoom: number }) {
  snapRoot = root;
  snapScale = getScale;
  new MutationObserver((recs) => {
    for (const r of recs) {
      const t = r.target as Element;
      // text replaced inside a .tx (setText / textContent)
      if (t.nodeType === 1 && t.classList.contains('tx')) {
        pendingTx.add(t as HTMLElement);
        continue;
      }
      for (const n of r.addedNodes) if (n.nodeType === 1) snapLater(n as Element);
    }
    if (pendingTx.size) queueSnap();
  }).observe(root, { childList: true, subtree: true });
  // window geometry: only windows whose size changed are re-measured (moves are whole UI pixels)
  let lastScale = '';
  const refresh = () => {
    const { dpr, zoom } = getScale();
    const sc = dpr + ':' + zoom;
    if (sc !== lastScale) {
      lastScale = sc;
      pendingFull = true;
    } else checkWins = true;
    queueSnap();
  };
  addEventListener('resize', () => {
    pendingFull = true;
    queueSnap();
  });
  document.fonts?.ready.then(() => {
    pendingFull = true;
    queueSnap();
  });
  pendingFull = true;
  queueSnap();
  return refresh;
}

export function on<K extends keyof WindowEventMap>(t: Window, ev: K, f: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): () => void {
  t.addEventListener(ev, f, opts);
  return () => t.removeEventListener(ev, f, opts);
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
