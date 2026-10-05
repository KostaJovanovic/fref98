// Windows 98 form controls built on the theme (all text stays crisp: inputs sit in a .field wrapper).
// No native popups: selects use our drop-down list, number fields our spin buttons, tooltips are data-tip.
import { h } from './dom';
import { dropdown } from './dropdown';
import { spinStep } from './uimath';

let uidN = 0;
const nid = (p: string) => p + ++uidN;
const tip = (s: string | undefined) => (s ? s : undefined);

export function textField(value: string, onInput: (v: string) => void, opts: { label?: string; placeholder?: string; width?: number; type?: string; onChange?: (v: string) => void } = {}): HTMLElement {
  const inp = h('input', { type: opts.type ?? 'text', value, placeholder: opts.placeholder ?? '', 'aria-label': opts.label ?? '', spellcheck: 'false' });
  inp.addEventListener('input', () => onInput(inp.value));
  if (opts.onChange) inp.addEventListener('change', () => opts.onChange!(inp.value));
  const f = h('span', { class: 'field' }, inp);
  if (opts.width) f.style.width = opts.width + 'px';
  return f;
}

/** A number box with the 98 spin buttons (up/down arrow pair; hold to auto-repeat; arrow keys step). */
export function numberField(value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; step?: number; label?: string; width?: number } = {}): HTMLElement {
  const inp = h('input', { type: 'number', value: String(value), 'aria-label': opts.label ?? '', role: 'spinbutton' });
  if (opts.min !== undefined) inp.min = String(opts.min);
  if (opts.max !== undefined) inp.max = String(opts.max);
  if (opts.step !== undefined) inp.step = String(opts.step);
  const clampV = (v: number) => {
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    return v;
  };
  inp.addEventListener('change', () => {
    const v = Number(inp.value);
    if (!Number.isFinite(v) || inp.value.trim() === '') return;
    const c = clampV(v);
    if (c !== v) inp.value = String(c);
    onChange(c);
  });
  const step = (dir: 1 | -1) => {
    if (inp.disabled || inp.readOnly) return;
    const cur = Number(inp.value);
    const base = Number.isFinite(cur) && inp.value.trim() !== '' ? cur : (opts.min ?? 0);
    const v = spinStep(base, dir, opts.step ?? 1, opts.min, opts.max);
    if (v === cur && inp.value.trim() !== '') return;
    inp.value = String(v);
    onChange(v);
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      step(e.key === 'ArrowUp' ? 1 : -1);
    }
  });
  const spinBtn = (dir: 1 | -1) => {
    const b = h('span', { class: dir > 0 ? 'spin-up' : 'spin-down', 'aria-hidden': 'true' });
    let t: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (t) clearTimeout(t);
      t = null;
      b.classList.remove('p');
    };
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || inp.disabled) return;
      e.preventDefault();
      if (e.pointerType !== 'touch') inp.focus({ preventScroll: true });
      b.setPointerCapture?.(e.pointerId);
      b.classList.add('p');
      step(dir);
      const rep = () => {
        step(dir);
        t = setTimeout(rep, 50);
      };
      t = setTimeout(rep, 400);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    return b;
  };
  const f = h('span', { class: 'field spin' }, inp, h('span', { class: 'spin-btns' }, spinBtn(1), spinBtn(-1)));
  f.style.width = (opts.width ?? 64) + 'px';
  return f;
}

/** A 98 drop-down list (combo box). The hidden <select> inside keeps the value and fires 'change'. */
export function selectField(value: string, options: [string, string][], onChange: (v: string) => void, opts: { label?: string; width?: number } = {}): HTMLElement {
  const sel = h('select', { 'aria-label': opts.label ?? '' }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return dropdown(sel, { width: opts.width, label: opts.label });
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, opts: { title?: string; disabled?: boolean } = {}): HTMLElement {
  const id = nid('cb');
  const inp = h('input', { type: 'checkbox', id, checked, disabled: !!opts.disabled });
  inp.addEventListener('change', () => onChange(inp.checked));
  return h('label', { class: 'check' + (opts.disabled ? ' disabled' : ''), htmlFor: id, 'data-tip': tip(opts.title) }, inp, label);
}

export function radio(name: string, label: string, checked: boolean, onChange: () => void, opts: { disabled?: boolean } = {}): HTMLElement {
  const id = nid('rb');
  const inp = h('input', { type: 'radio', id, name, checked, disabled: !!opts.disabled });
  inp.addEventListener('change', () => inp.checked && onChange());
  return h('label', { class: 'check' + (opts.disabled ? ' disabled' : ''), htmlFor: id }, inp, label);
}

/** A 98 trackbar. `ticks` draws that many intervals of tick marks under the thumb. */
export function slider(value: number, min: number, max: number, step: number, onInput: (v: number) => void, opts: { label?: string; onCommit?: (v: number) => void; ticks?: number } = {}): HTMLInputElement {
  const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': opts.label ?? '' });
  inp.addEventListener('input', () => onInput(Number(inp.value)));
  if (opts.onCommit) inp.addEventListener('change', () => opts.onCommit!(Number(inp.value)));
  if (opts.ticks && opts.ticks > 0) {
    inp.classList.add('ticks');
    inp.style.setProperty('--ticks', String(opts.ticks));
  }
  return inp;
}

export function button(label: string | Node, onClick: () => void, opts: { cls?: string; title?: string; icon?: HTMLElement; disabled?: boolean; aria?: string } = {}): HTMLButtonElement {
  return h('button', { class: 'btn ' + (opts.cls ?? ''), 'data-tip': tip(opts.title), 'aria-label': opts.aria, disabled: !!opts.disabled, onclick: onClick }, opts.icon ?? null, label);
}

export function toolButton(iconEl: HTMLElement, label: string, onClick: () => void, opts: { pressed?: boolean; text?: string } = {}): HTMLButtonElement {
  const b = h('button', { class: 'tool' + (opts.pressed ? ' on' : ''), 'data-tip': tip(label), 'aria-label': label, onclick: onClick }, iconEl, opts.text ?? null);
  if (opts.pressed !== undefined) b.setAttribute('aria-pressed', String(!!opts.pressed));
  return b;
}

export function group(legend: string, ...children: (Node | null)[]): HTMLElement {
  return h('div', { class: 'group', role: 'group', 'aria-label': legend }, h('div', { class: 'legend' }, legend), ...children);
}

export function tabs(names: string[], current: number, onPick: (i: number) => void): HTMLElement {
  const el = h('div', { class: 'tabs', role: 'tablist' });
  names.forEach((n, i) => {
    const b = h('button', { class: 'tab' + (i === current ? ' on' : ''), role: 'tab', 'aria-selected': String(i === current), tabIndex: i === current ? 0 : -1, onclick: () => onPick(i) }, n);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') onPick((i + 1) % names.length);
      if (e.key === 'ArrowLeft') onPick((i - 1 + names.length) % names.length);
    });
    el.appendChild(b);
  });
  return el;
}

/** A 98 block progress bar (sunken, navy 8 px blocks). `set(f)` takes 0..1. */
export function progressBar(fraction = 0): HTMLElement & { set(f: number): void } {
  const fill = h('div', { class: 'fill' });
  const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill) as unknown as HTMLElement & { set(f: number): void };
  bar.set = (f: number) => {
    const p = Math.max(0, Math.min(1, f));
    // whole blocks only (10 px pitch)
    fill.style.width = Math.floor(((bar.clientWidth - 4) * p) / 10) * 10 + 'px';
    bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  };
  requestAnimationFrame(() => bar.set(fraction));
  return bar;
}

/** A sunken status-bar pane (put several in a status bar row). */
export function statusPane(content: string | Node, opts: { grow?: boolean } = {}): HTMLElement {
  return h('div', { class: 'status-pane' + (opts.grow ? ' grow' : '') }, content);
}
