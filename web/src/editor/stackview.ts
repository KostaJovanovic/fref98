// Expert mode step stack: reorder by drag AND by up/down buttons, enable toggles, per-step seed + dice,
// params generated from ParamInfo, layer badges, "simulated" tags, stale/automatic re-encode markers.
// Fully keyboard operable (arrows move focus, Alt+arrows move the step, Space toggles, Delete removes).
import { h, mount } from '../ui/dom';
import { iconImg } from '../ui/art';
import { checkbox, numberField, selectField, slider, textField, button } from '../ui/controls';
import { showMenu, type MenuItem } from '../ui/menu';
import { toUi } from '../ui/scale';
import { trackDrag } from '../ui/wm-drag';
import type { ParamInfo, StepInfo } from '../engine/types';
import { makeRepeat, makeStep, moveNode, removeNode, replaceNode, reencodeMarkers, findNode, photoChoices, type NodeResult, type StackNode, type StepItem } from '../engine/stack';
import { newSeed } from '../engine/hash';

export interface StackViewOpts {
  catalog: () => Map<string, StepInfo>;
  get: () => StackNode[];
  set: (nodes: StackNode[], merge?: string | null, why?: string) => void;
  results: () => NodeResult[] | null;
  pool: () => { uid: string; name: string }[];
  onExplain: (info: StepInfo) => void;
  onMask: (node: StepItem, param: ParamInfo) => void;
  onDelete: (node: StackNode, label: string) => void;
  onRebasePatch: (node: StackNode) => void;
  maskEditing: () => string | null;
  /** Reads (and with an argument, sets) the mask brush's eraser mode. */
  maskEraser: (on?: boolean) => boolean;
}

const GROUP_ORDER = ['Quantise', 'Chroma', 'Colour', 'Generation', 'Encode', 'Progressive', 'Bytes', 'Header', 'Transfer', 'Recovery', 'Card', 'Formats', 'Metadata', 'Sensor'];

export const STD_LUMA = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];

export function nodeLabel(n: StackNode, cat: Map<string, StepInfo>): string {
  if (n.type === 'step') return cat.get(n.id)?.label ?? n.id;
  if (n.type === 'repeat') return `Repeat ${n.times}×`;
  return `Hex edit (${n.patches.reduce((a, p) => a + p.bytes.length, 0)} bytes)`;
}

export class StackView {
  el: HTMLElement;
  private list: HTMLElement;
  private expanded = new Set<string>();
  private lastJson = '';
  private selfJson = '';
  private focusUid: string | null = null;

  constructor(private o: StackViewOpts) {
    this.list = h('div', { class: 'stack', role: 'list', 'aria-label': 'Steps (top runs first)' });
    const add = button('Add step…', () => this.addMenu(add), { icon: iconImg('presets', 16) });
    const rep = button('Repeat group', () => this.addRepeat(), { title: 'Add a "Repeat N times" group' });
    this.el = h('div', { class: 'col' }, h('div', { class: 'row wrap' }, add, rep), this.list);
  }

  /** Re-render when the stack changed from outside (undo, presets, load). Edits made here don't rebuild. */
  render(force = false) {
    const nodes = this.o.get();
    const json = JSON.stringify(nodes);
    if (!force && (json === this.lastJson || json === this.selfJson)) {
      this.lastJson = json;
      this.updateStatus();
      return;
    }
    this.lastJson = json;
    this.selfJson = '';
    const cat = this.o.catalog();
    const marks = reencodeMarkers(nodes, cat);
    const active = document.activeElement as HTMLElement | null;
    const focusUid = this.focusUid ?? active?.closest<HTMLElement>('.sitem')?.dataset.uid ?? null;
    mount(this.list);
    if (!nodes.length) {
      this.list.append(h('div', { class: 'muted pad' }, 'No steps yet. Press "Add step…" or pick a story in the Simple tab.'));
    }
    nodes.forEach((n, i) => {
      if (marks.has(n.uid)) this.list.append(this.reencMarker());
      this.list.append(this.row(n, i, nodes.length, null));
      if (n.type === 'repeat') {
        const kids = h('div', { class: 'repeat-kids' });
        n.children.forEach((c, ci) => {
          if (marks.has(c.uid)) kids.append(this.reencMarker());
          kids.append(this.row(c, ci, n.children.length, n.uid));
        });
        kids.append(h('div', { class: 'row' }, button('Add step to group…', () => this.addMenu(kids.lastElementChild as HTMLElement, n.uid), { cls: 'small' })));
        this.list.append(kids);
      }
    });
    this.updateStatus();
    if (focusUid) (this.list.querySelector(`.sitem[data-uid="${focusUid}"]`) as HTMLElement | null)?.focus();
    this.focusUid = null;
  }

  private reencMarker() {
    return h('div', { class: 'reenc', role: 'note', 'data-tip': 'A pixel or coefficient step after byte damage: the engine decodes forgivingly and re-encodes with the input’s own settings.' }, '↻ automatic re-encode here');
  }

  private commit(nodes: StackNode[], merge: string | null = null, rebuild = false) {
    const json = JSON.stringify(nodes);
    if (!rebuild) this.selfJson = json;
    this.o.set(nodes, merge, 'stack');
    if (rebuild) this.render(true);
  }

  updateStatus() {
    const res = this.o.results();
    for (const el of this.list.querySelectorAll<HTMLElement>('.sitem')) {
      const uid = el.dataset.uid!;
      const st = el.querySelector('.sstatus') as HTMLElement | null;
      if (!st) continue;
      const r = res?.find((x) => x.uid === uid);
      let text = '';
      let cls = 'sstatus muted';
      if (r) {
        if (r.status === 'error') ((text = 'error'), (cls = 'sstatus error'));
        else if (r.status === 'unavailable') ((text = 'not available yet'), (cls = 'sstatus unavailable'));
        else if (r.status === 'stale') ((text = 'stale'), (cls = 'sstatus stale'));
        else if (r.status === 'disabled') text = 'off';
        else if (r.ms !== undefined && r.ms > 300) text = (r.ms / 1000).toFixed(1) + ' s';
      }
      // called for every preview frame while a slider moves: leave the DOM alone unless something changed
      const tip = r ? (r.error ?? '') : (st.dataset.tip ?? '');
      const key = cls + '\n' + text + '\n' + tip;
      if (st.dataset.k !== key) {
        st.dataset.k = key;
        st.dataset.tip = tip;
        st.className = cls;
        st.textContent = '';
        if (text) st.append(h('span', { class: 'tx' }, text));
      }
      const errBox = el.querySelector('.serr') as HTMLElement | null;
      if (errBox) {
        const msg = r?.error ? (r.status === 'unavailable' ? 'This step is not in the engine yet; it is skipped for now.' : r.error) : '';
        if (errBox.dataset.k !== msg) {
          errBox.dataset.k = msg;
          errBox.textContent = '';
          if (msg) errBox.append(h('span', { class: 'tx' }, msg));
        }
      }
    }
  }

  private row(n: StackNode, index: number, count: number, parent: string | null): HTMLElement {
    const cat = this.o.catalog();
    const info = n.type === 'step' ? cat.get(n.id) : undefined;
    const label = nodeLabel(n, cat);
    const open = this.expanded.has(n.uid);
    const item = h('div', { class: 'sitem' + (n.enabled ? '' : ' off'), role: 'listitem', tabIndex: 0, dataset: { uid: n.uid }, 'aria-label': `${label}${n.enabled ? '' : ' (off)'}. Step ${index + 1} of ${count}.` });
    const nodes = () => this.o.get();
    const update = (f: (x: StackNode) => StackNode, merge: string | null = null, rebuild = false) => this.commit(replaceNode(nodes(), n.uid, f), merge, rebuild);
    const move = (d: number) => {
      const all = nodes();
      if (parent) {
        const p = all.find((x) => x.uid === parent);
        if (!p || p.type !== 'repeat') return;
        const kids = moveNode(p.children, index, index + d) as StepItem[];
        this.focusUid = n.uid;
        this.commit(replaceNode(all, parent, (x) => ({ ...(x as any), children: kids })), null, true);
      } else {
        this.focusUid = n.uid;
        this.commit(moveNode(all, index, index + d), null, true);
      }
    };
    const del = () => {
      this.o.onDelete(n, label);
      this.commit(removeNode(nodes(), n.uid), null, true);
    };
    const grip = h('span', { class: 'grip', 'data-tip': 'Drag to reorder', 'aria-hidden': 'true' });
    if (!parent) this.bindDrag(grip, item, index);
    const enable = h('input', { type: 'checkbox', checked: n.enabled, 'aria-label': `Enable ${label}`, 'data-tip': 'On/off' });
    enable.onchange = () => update((x) => ({ ...x, enabled: enable.checked }), null, true);
    const badges: HTMLElement[] = [];
    if (info) badges.push(h('span', { class: 'badge ' + info.layer, 'data-tip': `${info.layer} layer` }, info.layer));
    if (info?.simulated) badges.push(h('span', { class: 'badge sim', 'data-tip': 'Simulated look, not real data damage' }, 'sim'));
    if (n.type === 'patch') badges.push(h('span', { class: 'badge byte' }, 'byte'));
    // the full name always shows (it wraps); the badges flow after it
    const name = h('button', { class: 'name', 'aria-expanded': String(open), 'data-tip': info?.help ?? label, onclick: () => this.toggle(n.uid) }, h('span', { class: 'arrow', 'aria-hidden': 'true' }, open ? '▼' : '▶'), h('span', { class: 'nm' }, h('span', { class: 'lbl' }, label), ...badges));
    const st = h('span', { class: 'sstatus' });
    const up = h('button', { class: 'tool', 'aria-label': 'Move up', 'data-tip': 'Move up', disabled: index === 0, onclick: () => move(-1) }, '▲');
    const down = h('button', { class: 'tool', 'aria-label': 'Move down', 'data-tip': 'Move down', disabled: index === count - 1, onclick: () => move(1) }, '▼');
    const dice =
      (n.type === 'step' && info?.random) || n.type === 'repeat'
        ? h('button', { class: 'tool', 'aria-label': 'New random seed', 'data-tip': 'Roll the dice (new seed)', onclick: () => update((x) => ({ ...(x as any), seed: newSeed() }), null, true) }, iconImg('dice', 16))
        : null;
    const x = h('button', { class: 'tool', 'aria-label': `Delete ${label}`, 'data-tip': 'Delete (to Recycle Bin)', onclick: del }, '✕');
    const head = h('div', { class: 'shead' }, parent ? null : grip, enable, name, h('span', { class: 'sctl' }, st, up, down, dice, x));
    item.append(head);
    if (open) item.append(this.body(n, info, update));
    item.addEventListener('keydown', (e) => {
      if (e.target !== item) return;
      const rows = [...this.list.querySelectorAll<HTMLElement>('.sitem')];
      const i = rows.indexOf(item);
      if (e.key === 'ArrowDown' && !e.altKey) (rows[i + 1]?.focus(), e.preventDefault());
      else if (e.key === 'ArrowUp' && !e.altKey) (rows[i - 1]?.focus(), e.preventDefault());
      else if (e.key === 'ArrowDown' && e.altKey) (move(1), e.preventDefault());
      else if (e.key === 'ArrowUp' && e.altKey) (move(-1), e.preventDefault());
      else if (e.key === 'Delete' || e.key === 'Backspace') (del(), e.preventDefault());
      else if (e.key === ' ') ((enable.checked = !enable.checked), enable.onchange!(new Event('change')), e.preventDefault());
      else if (e.key === 'Enter') (this.toggle(n.uid), e.preventDefault());
    });
    return item;
  }

  private toggle(uid: string) {
    if (this.expanded.has(uid)) this.expanded.delete(uid);
    else this.expanded.add(uid);
    this.focusUid = uid;
    this.render(true);
  }

  expand(uid: string) {
    this.expanded.add(uid);
    this.render(true);
  }

  private body(n: StackNode, info: StepInfo | undefined, update: (f: (x: StackNode) => StackNode, merge?: string | null, rebuild?: boolean) => void): HTMLElement {
    const b = h('div', { class: 'sbody' });
    if (n.type === 'repeat') {
      b.append(
        h('div', { class: 'param' }, h('label', null, 'Times'), h('div', { class: 'row' }, numberField(n.times, (v) => update((x) => ({ ...(x as any), times: Math.max(1, Math.round(v)) }), 'times:' + n.uid, true), { min: 1, max: 500, label: 'Times' }))),
        h('div', { class: 'hint' }, 'Each repeat gets its own seed, derived from the group seed.'),
        this.seedRow(n.seed, (s) => update((x) => ({ ...(x as any), seed: s }), 'seed:' + n.uid)),
      );
      return b;
    }
    if (n.type === 'patch') {
      const res = this.o.results()?.find((r) => r.uid === n.uid);
      b.append(h('div', null, `${n.patches.length} edited run(s), ${n.patches.reduce((a, p) => a + p.bytes.length, 0)} byte(s). Edit bytes in Hex Doctor.`));
      if (res?.status === 'stale')
        b.append(
          h('div', { class: 'warn' }, 'Stale: an earlier step changed the file, so these byte edits are not applied (they would land on different data).'),
          h('div', { class: 'row' }, button('Re-apply anyway', () => this.o.onRebasePatch(n), { cls: 'small' })),
        );
      return b;
    }
    if (!info) {
      b.append(h('div', { class: 'serr warn' }), h('pre', { class: 'selectable', style: { margin: '0', whiteSpace: 'pre-wrap' } }, JSON.stringify(n.params, null, 1)));
      return b;
    }
    if (info.help) b.append(h('div', { class: 'row', style: { alignItems: 'flex-start' } }, h('div', { class: 'grow hint' }, info.help), button('Explain', () => this.o.onExplain(info), { cls: 'small' })));
    b.append(h('div', { class: 'serr warn' }));
    for (const p of info.params) b.append(this.param(n, p, update));
    if (info.random) b.append(this.seedRow(n.seed, (s) => update((x) => ({ ...(x as any), seed: s }), 'seed:' + n.uid)));
    return b;
  }

  private seedRow(seed: number, set: (s: number) => void) {
    const f = numberField(seed, (v) => set(v >>> 0), { min: 0, max: 4294967295, label: 'Seed', width: 110 });
    return h('div', { class: 'param' }, h('label', null, 'Seed'), h('div', { class: 'row' }, f, button('', () => {
      const s = newSeed();
      (f.querySelector('input') as HTMLInputElement).value = String(s);
      set(s);
    }, { cls: 'small', icon: iconImg('dice', 16), aria: 'Random seed', title: 'Roll the dice' })));
  }

  private param(n: StepItem, p: ParamInfo, update: (f: (x: StackNode) => StackNode, merge?: string | null, rebuild?: boolean) => void): HTMLElement {
    const v = n.params[p.id] ?? p.default;
    const setv = (val: unknown, merge: string | null = 'p:' + n.uid + ':' + p.id, rebuild = false) => update((x) => ({ ...(x as StepItem), params: { ...(x as StepItem).params, [p.id]: val } }), merge, rebuild);
    let ctl: HTMLElement;
    switch (p.kind) {
      case 'int':
      case 'float': {
        const min = p.min ?? 0;
        const max = p.max ?? 100;
        const step = p.step ?? (p.kind === 'int' ? 1 : (max - min) / 100);
        const val = h('span', { class: 'val' }, fmtNum(Number(v)));
        const num = Number(v);
        const s = slider(num, min, max, step, (nv) => {
          val.firstElementChild!.textContent = fmtNum(nv);
          setv(p.kind === 'int' ? Math.round(nv) : nv);
        }, { label: p.label });
        s.classList.add('grow');
        ctl = h('div', { class: 'row' }, s, val);
        val.dataset.tip = 'Click to type a value';
        val.style.cursor = 'var(--cur-text, text)';
        val.onclick = () => {
          const nf = numberField(Number(n.params[p.id] ?? p.default), (nv) => setv(p.kind === 'int' ? Math.round(nv) : nv, null, true), { min, max, step, label: p.label });
          val.replaceWith(nf);
          (nf.querySelector('input') as HTMLInputElement).focus();
        };
        break;
      }
      case 'bool':
        ctl = checkbox('', !!v, (c) => setv(c, null));
        break;
      case 'enum':
        ctl = selectField(String(v), p.options ?? [], (s) => setv(s, null), { label: p.label });
        break;
      case 'photo': {
        const opts = photoChoices(v, this.o.pool());
        const cur = typeof v === 'string' ? v : '-1';
        ctl = selectField(cur, opts, (s) => setv(s === '-1' ? -1 : s, null), { label: p.label });
        break;
      }
      case 'text':
        ctl = textField(String(v ?? ''), (s) => setv(s), { label: p.label });
        break;
      case 'table':
        ctl = this.tableEditor(Array.isArray(v) && v.length === 64 ? (v as number[]) : null, (t) => setv(t, 'tbl:' + n.uid + ':' + p.id), () => setv(null, null, true), () => setv(STD_LUMA.slice(), null, true));
        break;
      case 'mask': {
        const m = v as { w: number; h: number; data: number[] } | null;
        const painted = m?.data?.filter((x) => x > 0).length ?? 0;
        const editing = this.o.maskEditing() === n.uid + ':' + p.id;
        const erase = this.o.maskEraser();
        const eraser = editing
          ? h('button', { class: 'btn small' + (erase ? ' pressed' : ''), 'aria-pressed': String(erase), 'data-tip': 'Erase painted blocks (or hold Alt / use the right mouse button)', onclick: () => (this.o.maskEraser(!this.o.maskEraser()), this.render(true)) }, erase ? 'Eraser: on' : 'Eraser')
          : null;
        ctl = h(
          'div',
          { class: 'row wrap' },
          button(editing ? 'Done painting' : 'Paint on the image', () => this.o.onMask(n, p), { cls: 'small' + (editing ? ' pressed' : '') }),
          eraser,
          button('Clear', () => setv(null, null, true), { cls: 'small' }),
          h('span', { class: 'muted' }, painted ? `${painted} blocks` : 'whole image'),
        );
        break;
      }
      default:
        ctl = h('span', { class: 'muted' }, String(v));
    }
    return h('div', { class: 'param' }, h('label', { 'data-tip': p.hint }, p.label), ctl, p.hint ? h('div', { class: 'hint' }, p.hint) : null);
  }

  private tableEditor(table: number[] | null, set: (t: number[]) => void, reset: () => void, start: () => void): HTMLElement {
    if (!table) {
      return h('div', { class: 'row wrap' }, h('span', { class: 'muted' }, 'Uses the input’s own table.'), button('Customise', start, { cls: 'small' }));
    }
    const t = table.slice();
    let brush = 99;
    const grid = h('div', { class: 'tablepaint', role: 'grid', 'aria-label': '8 by 8 quantisation table. Drag to paint the brush value.' });
    const cells: HTMLElement[] = [];
    for (let i = 0; i < 64; i++) {
      const c = h('div', { role: 'gridcell', dataset: { i: String(i) } }, String(t[i]));
      cells.push(c);
      grid.append(c);
    }
    const paint = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-i]') as HTMLElement | null;
      if (!el || !grid.contains(el)) return;
      const i = Number(el.dataset.i);
      if (t[i] === brush) return;
      t[i] = brush;
      el.firstElementChild!.textContent = String(brush);
      set(t.slice());
    };
    grid.addEventListener('pointerdown', (e) => {
      grid.setPointerCapture(e.pointerId);
      paint(e);
      // every move paints (no frame batching: a fast stroke must not skip cells)
      const mv = (ev: PointerEvent) => paint(ev);
      const ends = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;
      const up = () => {
        grid.removeEventListener('pointermove', mv);
        for (const k of ends) grid.removeEventListener(k, up);
      };
      grid.addEventListener('pointermove', mv);
      for (const k of ends) grid.addEventListener(k, up);
    });
    const fill = (f: (i: number, v: number) => number) => {
      for (let i = 0; i < 64; i++) {
        t[i] = Math.max(1, Math.min(255, Math.round(f(i, t[i]))));
        cells[i].firstElementChild!.textContent = String(t[i]);
      }
      set(t.slice());
    };
    return h(
      'div',
      { class: 'col', style: { gap: '4px' } },
      grid,
      h('div', { class: 'row wrap' }, h('label', null, 'Brush'), numberField(brush, (v) => (brush = Math.round(v)), { min: 1, max: 255, label: 'Brush value', width: 54 }),
        button('×2', () => fill((_i, v) => v * 2), { cls: 'small', title: 'Double every value' }),
        button('½', () => fill((_i, v) => v / 2), { cls: 'small', title: 'Halve every value' }),
        button('Kill highs', () => fill((i, v) => ((i >> 3) + (i & 7) > 6 ? 255 : v)), { cls: 'small' }),
        button('Reset', reset, { cls: 'small' })),
    );
  }

  private bindDrag(grip: HTMLElement, item: HTMLElement, index: number) {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      item.classList.add('drag');
      let target = index;
      const y0 = toUi(e).y;
      const rows = () => [...this.list.children].filter((c) => (c as HTMLElement).classList.contains('sitem')) as HTMLElement[];
      const track = (y: number) => {
        const rs = rows();
        target = rs.length;
        for (let i = 0; i < rs.length; i++) {
          const r = rs[i].getBoundingClientRect();
          const mid = toUi({ clientX: 0, clientY: r.top + r.height / 2 }).y;
          if (y < mid) {
            target = i;
            break;
          }
        }
        rs.forEach((r, i) => r.classList.toggle('dropbefore', i === target && i !== index && i !== index + 1));
      };
      trackDrag(e, grip, toUi, (_dx, dy) => track(y0 + dy), (_dx, dy, moved, cancelled) => {
        item.classList.remove('drag');
        for (const r of rows()) r.classList.remove('dropbefore');
        // a cancelled touch (a scroll or a system gesture took it) moves nothing
        if (!moved || cancelled) return;
        track(y0 + dy);
        for (const r of rows()) r.classList.remove('dropbefore');
        const to = target > index ? target - 1 : target;
        if (to !== index) {
          this.focusUid = item.dataset.uid!;
          this.commit(moveNode(this.o.get(), index, to), null, true);
        }
      });
    });
  }

  addMenu(anchor: HTMLElement, intoGroup?: string) {
    const cat = this.o.catalog();
    const groups = new Map<string, StepInfo[]>();
    for (const s of cat.values()) {
      const g = groups.get(s.group) ?? [];
      g.push(s);
      groups.set(s.group, g);
    }
    const names = [...groups.keys()].sort((a, b) => (GROUP_ORDER.indexOf(a) + 100) % 100 - (GROUP_ORDER.indexOf(b) + 100) % 100 || a.localeCompare(b));
    const items: MenuItem[] = [];
    if (!cat.size) items.push({ label: 'The engine has no steps yet (still being built)', disabled: true });
    for (const g of names) {
      items.push({
        label: g,
        sub: groups.get(g)!.map((s) => ({ label: s.label + (s.simulated ? ' (simulated)' : ''), onClick: () => this.add(s, intoGroup) })),
      });
    }
    const r = anchor.getBoundingClientRect();
    const p = toUi({ clientX: r.left, clientY: r.bottom });
    showMenu(items, p.x, p.y, { label: 'Add step' });
  }

  private add(info: StepInfo, intoGroup?: string) {
    const s = makeStep(info.id, info);
    let nodes = this.o.get();
    if (intoGroup) nodes = replaceNode(nodes, intoGroup, (g) => ({ ...(g as any), children: [...(g as any).children, s] }));
    else nodes = [...nodes, s];
    this.expanded.add(s.uid);
    this.focusUid = s.uid;
    this.commit(nodes, null, true);
  }

  private addRepeat() {
    const g = makeRepeat(10, []);
    this.expanded.add(g.uid);
    this.commit([...this.o.get(), g], null, true);
  }

  has(uid: string) {
    return !!findNode(this.o.get(), uid);
  }
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) < 0.001) return v.toExponential(1);
  return v.toFixed(Math.abs(v) < 1 ? 3 : 1);
}
