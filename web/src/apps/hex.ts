// "Hex Doctor": a Windows 98 hex editor window on the editor's current file. The compressed bytes are linked
// both ways with the picture (click a block → its bytes via mcu_map; select bytes → the blocks they paint).
// Typing hex digits edits bytes; edits are recorded as a "Hex edit" step that goes stale instead of being
// re-applied when earlier steps change (Q13). Menu bar, toolbar, a column header, the right-click menu,
// Go To dialog and a status bar with offset and selection. Every glyph is our pixel font in fixed cells.
import { h, mount, fmtBytes, setText } from '../ui/dom';
import { iconImg } from '../ui/art';
import { button, toolButton, textField, radio } from '../ui/controls';
import { openWindow, getWin, type Win } from '../ui/wm';
import { ui, onScale } from '../ui/scale';
import { drawText, charWidth, LINE } from '../ui/pixeltext';
import { pipeline, type PipelineResult } from '../pipeline';
import { store } from '../state';
import { engine, NotAvailableError } from '../engine/client';
import { hashBytes } from '../engine/hash';
import { makePatch, setPatchedByte, type PatchItem } from '../engine/stack';
import type { Inspection, DecodeEvent } from '../engine/types';
import { link } from '../editor/link';
import { explainEvent } from '../foldy/lines';
import { foldy } from '../foldy/foldy';
import { registerContext } from '../ui/contextmenu';
import { message } from '../ui/dialog';
import type { MenuItem } from '../ui/menu';
import { openApp } from './registry';
import { dialog98, swatch98 } from './tools98';

let hv: HexView | null = null;

export function open() {
  if (hv && getWin('hex')) return hv.win.focus();
  hv = new HexView();
}

const ROW_H = 16;
const HEAD = 18;
const OFF_W = 64;
const CELL_W = 20;
const ASC_X = OFF_W + 16 * CELL_W + 12;
const ASC_W = 7;
const HEXCHARS = '0123456789ABCDEF';
const SEL_BG = '#000080';
/** Most bytes a Fill or Randomize may touch at once (each becomes part of the Hex edit step). */
const FILL_MAX = 4096;

class HexView {
  win: Win;
  private scroll: HTMLElement;
  private spacer: HTMLElement;
  private canvas: HTMLCanvasElement;
  private side: HTMLElement;
  private keypad: HTMLElement;
  private bytes: Uint8Array = new Uint8Array();
  private info: Inspection | null = null;
  private mcu: Uint32Array | null = null;
  private mcuNote = '';
  private events: DecodeEvent[] = [];
  private sel: [number, number] | null = null;
  private caret = -1;
  private nibble: number | null = null;
  private pickedRange: [number, number] | null = null;
  private patched = new Set<number>();
  private unsub: (() => void)[] = [];
  private raf = 0;
  private geometry: { mw: number; mh: number; cols: number } | null = null;
  private sideOn = true;
  private stHint = h('div', { class: 'grow' }, '');
  private stOff = h('div', { class: 'hx-st' }, '');
  private stSel = h('div', { class: 'hx-st' }, '');
  private stSize = h('div', { class: 'hx-st' }, '');
  private hint = '';

  constructor() {
    this.canvas = h('canvas', { class: 'hexcanvas', 'aria-hidden': 'true' });
    this.spacer = h('div', { class: 'hx-spacer' }, this.canvas);
    this.scroll = h('div', { class: 'hexscroll hx-grid', tabIndex: 0, role: 'grid', 'aria-label': 'Hex bytes. Arrow keys move, type 0-9 A-F to edit.' }, this.spacer);
    this.side = h('div', { class: 'hexside hx-side' });
    this.keypad = h('div', { class: 'row wrap hx-keypad' }, [...HEXCHARS].map((c) => button(c, () => this.typeNibble(HEXCHARS.indexOf(c)), { cls: 'small' })));
    this.keypad.style.display = 'none';
    const tb = h(
      'div',
      { class: 'ed-toolbar hx-toolbar', role: 'toolbar', 'aria-label': 'Hex Doctor tools' },
      toolButton(iconImg('undo', 16), 'Undo (Ctrl+Z)', () => store.undo()),
      h('span', { class: 'tsep', 'aria-hidden': 'true' }),
      toolButton(h('span', null, 'Copy'), 'Copy the selection as hex (Ctrl+C)', () => this.copy('hex')),
      toolButton(h('span', null, 'Go To…'), 'Go to an offset (Ctrl+G)', () => this.gotoDialog()),
      h('span', { class: 'tsep', 'aria-hidden': 'true' }),
      toolButton(h('span', null, '◄ FF'), 'Previous marker (Shift+F3)', () => this.marker(-1)),
      toolButton(h('span', null, 'FF ►'), 'Next marker (F3)', () => this.marker(1)),
      toolButton(h('span', null, 'SOS'), 'Start of the picture data', () => this.jumpSos()),
      h('span', { class: 'tsep', 'aria-hidden': 'true' }),
      toolButton(iconImg('editor', 16), 'Show the picture in the editor', () => openApp('editor')),
    );
    const body = h('div', { class: 'hx98' }, tb, h('div', { class: 'hexwrap hx-wrap grow' }, h('div', { class: 'hx-left' }, this.scroll, this.keypad), this.side));
    this.win = openWindow({
      id: 'hex',
      title: 'Hex Doctor',
      short: 'Hex',
      icon: 'hex',
      body,
      width: 780,
      height: 500,
      minWidth: 420,
      minHeight: 220,
      // bottom-right, so the editor's picture (top-left) stays visible for clicking blocks
      x: Math.max(0, ui.w - 780 - 8),
      y: Math.max(0, ui.h - 30 - 500 - 8),
      menu: [
        { label: '&File', items: () => this.fileMenu() },
        { label: '&Edit', items: () => this.editMenu() },
        { label: '&Go', items: () => this.goMenu() },
        { label: '&View', items: () => this.viewMenu() },
        { label: '&Help', items: () => [{ label: '&Hex Doctor Help', icon: 'help', onClick: () => openApp('help', 'hex') }, { label: 'What are &markers?', onClick: () => this.legendBox() }] },
      ],
      status: [this.stHint, this.stOff, this.stSel, this.stSize],
      onClose: () => {
        for (const u of this.unsub) u();
        link.highlight([]);
        hv = null;
      },
      onResize: () => this.render(),
    });
    this.scroll.addEventListener('scroll', () => this.render(), { passive: true });
    this.bindPointer();
    this.bindKeys();
    this.unsub.push(
      pipeline.on((r, phase) => phase === 'done' && void this.load(r)),
      link.on(() => this.onPicked()),
      onScale(() => this.render()),
      registerContext('.hx-grid', (_t, e) => this.gridMenu(e)),
      registerContext('.hx-side .lb-seg .li, .hx-side .lb-ev .li', (t) => {
        const b = t.closest('.li') as HTMLElement;
        return [
          { label: '&Go To', default: true, onClick: () => b.click() },
          { label: '&Copy Name', onClick: () => void navigator.clipboard?.writeText(b.textContent ?? '').catch(() => {}) },
        ];
      }),
    );
    new ResizeObserver(() => this.render()).observe(this.scroll);
    void this.load(pipeline.last);
  }

  // ------------------------------------------------------------ menus

  private fileMenu(): MenuItem[] {
    return [
      { label: 'Save &As…', icon: 'export', onClick: () => openApp('export') },
      { label: '&Open the Editor', icon: 'editor', onClick: () => openApp('editor') },
      { sep: true },
      { label: '&Close', onClick: () => this.win.close() },
    ];
  }

  private editMenu(): MenuItem[] {
    const has = !!this.sel && this.bytes.length > 0;
    return [
      { label: '&Undo', icon: 'undo', acc: 'Ctrl+Z', disabled: !store.history.canUndo, onClick: () => store.undo() },
      { sep: true },
      { label: '&Copy as Hex', acc: 'Ctrl+C', disabled: !has, onClick: () => this.copy('hex') },
      { label: 'Copy as &Text', disabled: !has, onClick: () => this.copy('text') },
      { sep: true },
      { label: 'Fill with &00', disabled: !has, onClick: () => this.fill(() => 0) },
      { label: 'Fill with &FF', disabled: !has, onClick: () => this.fill(() => 0xff) },
      { label: '&Randomize Bytes', disabled: !has, onClick: () => this.fill(() => (Math.random() * 256) | 0) },
      { sep: true },
      { label: 'Select &All', acc: 'Ctrl+A', disabled: !this.bytes.length, onClick: () => this.selectAll() },
    ];
  }

  private goMenu(): MenuItem[] {
    const n = !this.bytes.length;
    return [
      { label: '&Go To Offset…', acc: 'Ctrl+G', disabled: n, onClick: () => this.gotoDialog() },
      { sep: true },
      { label: '&Next Marker', acc: 'F3', disabled: n, onClick: () => this.marker(1) },
      { label: '&Previous Marker', acc: 'Shift+F3', disabled: n, onClick: () => this.marker(-1) },
      { label: '&Start of Picture Data', disabled: n, onClick: () => this.jumpSos() },
      { sep: true },
      { label: 'Start of &File', acc: 'Ctrl+Home', disabled: n, onClick: () => this.goto(0, 0) },
      { label: '&End of File', acc: 'Ctrl+End', disabled: n, onClick: () => this.goto(this.bytes.length - 1, this.bytes.length - 1) },
    ];
  }

  private viewMenu(): MenuItem[] {
    return [
      {
        label: '&Segments and Events',
        checked: this.sideOn,
        onClick: () => {
          this.sideOn = !this.sideOn;
          this.side.style.display = this.sideOn ? '' : 'none';
          this.render();
        },
      },
      { label: '&Colour Legend…', onClick: () => this.legendBox() },
    ];
  }

  private gridMenu(e: MouseEvent): MenuItem[] {
    // a right-click outside the selection selects the byte under the pointer first, as 98 list views do
    if (e.isTrusted && this.bytes.length && e.target === this.canvas) {
      const off = this.offsetAt(e);
      const s = this.selRange();
      if (off >= 0 && (!s || off < s[0] || off > s[1])) {
        this.sel = [off, off];
        this.caret = off;
        this.nibble = null;
        this.highlightFromSelection();
        this.render();
      }
    }
    const has = !!this.sel && this.bytes.length > 0;
    return [
      { label: '&Copy as Hex', acc: 'Ctrl+C', default: true, disabled: !has, onClick: () => this.copy('hex') },
      { label: 'Copy as &Text', disabled: !has, onClick: () => this.copy('text') },
      { label: 'Select &All', acc: 'Ctrl+A', disabled: !this.bytes.length, onClick: () => this.selectAll() },
      { sep: true },
      { label: '&Go To Offset…', acc: 'Ctrl+G', disabled: !this.bytes.length, onClick: () => this.gotoDialog() },
      { label: '&Next Marker', acc: 'F3', disabled: !this.bytes.length, onClick: () => this.marker(1) },
      { sep: true },
      {
        label: '&Insert / Delete',
        sub: [
          { label: 'Fill with &00', disabled: !has, onClick: () => this.fill(() => 0) },
          { label: 'Fill with &FF', disabled: !has, onClick: () => this.fill(() => 0xff) },
          { label: '&Randomize Bytes', disabled: !has, onClick: () => this.fill(() => (Math.random() * 256) | 0) },
          { sep: true },
          { label: 'Insert Bytes (the file keeps its length)', disabled: true },
          { label: 'Delete Bytes (the file keeps its length)', disabled: true },
        ],
      },
      { sep: true },
      { label: '&Undo', acc: 'Ctrl+Z', disabled: !store.history.canUndo, onClick: () => store.undo() },
    ];
  }

  // ------------------------------------------------------------ data

  private async load(r: PipelineResult | null) {
    if (!r) {
      this.bytes = new Uint8Array();
      this.renderSide();
      this.render();
      return;
    }
    this.bytes = r.output;
    this.events = r.after?.events ?? [];
    // which bytes are edited by the trailing hex patch
    this.patched.clear();
    const last = store.doc.stack[store.doc.stack.length - 1];
    const lastStatus = r.results.find((x) => x.uid === last?.uid)?.status;
    // a stale patch is not applied, so its bytes are not "your edits" in this file
    if (last && last.type === 'patch' && last.enabled && lastStatus !== 'stale') for (const p of last.patches) for (let i = 0; i < p.bytes.length; i++) this.patched.add(p.offset + i);
    try {
      this.info = await engine().inspect(r.output).promise;
    } catch {
      this.info = null;
    }
    const fr = this.info?.frame;
    if (fr) {
      const hmax = Math.max(1, ...fr.components.map((c) => c.h));
      const vmax = Math.max(1, ...fr.components.map((c) => c.v));
      this.geometry = { mw: 8 * hmax, mh: 8 * vmax, cols: Math.ceil(fr.width / (8 * hmax)) };
    } else this.geometry = null;
    try {
      this.mcu = await engine().mcuMap(r.output).promise;
      this.mcuNote = '';
    } catch (e) {
      this.mcu = null;
      this.mcuNote = e instanceof NotAvailableError ? 'Block ⇄ byte linking needs mcu_map (not in the engine yet).' : 'Could not map blocks to bytes.';
    }
    if (this.caret >= this.bytes.length) {
      this.caret = -1;
      this.sel = null;
    }
    this.renderSide();
    this.onPicked();
    this.render();
  }

  private selRange(): [number, number] | null {
    return this.sel ? [Math.min(this.sel[0], this.sel[1]), Math.max(this.sel[0], this.sel[1])] : null;
  }

  // ------------------------------------------------------------ drawing

  private rowsVisible() {
    return Math.ceil((this.scroll.clientHeight - HEAD) / ROW_H) + 1;
  }

  private render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private segAt(off: number) {
    if (!this.info) return null;
    for (const s of this.info.segments) if (off >= s.offset && off < s.offset + s.length) return s;
    return null;
  }

  /** One character centred in a fixed cell: our proportional pixel font set in monospaced columns. */
  private cellChar(x: CanvasRenderingContext2D, ch: string, cx: number, cw: number, y: number, col: string) {
    const k = ui.k;
    drawText(x, ch, cx + Math.floor((cw - charWidth(ch) + 1) / 2) * k, y, col, { scale: k });
  }

  private draw() {
    const k = ui.k;
    const rows = Math.ceil(this.bytes.length / 16);
    // the scroller's 2 px padding (its sunken bevel) is inside clientWidth/Height: size to the content box, or
    // a 2 px overflow shows a useless horizontal scroll bar
    const cs = getComputedStyle(this.scroll);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const w = this.scroll.clientWidth - padX;
    const hh = this.scroll.clientHeight - padY;
    this.spacer.style.height = Math.max(HEAD + rows * ROW_H, hh) + 'px';
    if (!w || !hh) return;
    if (this.canvas.width !== w * k || this.canvas.height !== hh * k) {
      this.canvas.width = w * k;
      this.canvas.height = hh * k;
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = hh + 'px';
    }
    const x = this.canvas.getContext('2d')!;
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const first = Math.floor(this.scroll.scrollTop / ROW_H);
    const dy = HEAD - (this.scroll.scrollTop % ROW_H);
    const n = this.rowsVisible();
    const s = this.selRange();
    for (let r = 0; r < n; r++) {
      const row = first + r;
      const base = row * 16;
      if (base >= this.bytes.length) break;
      const y = Math.round((dy + r * ROW_H) * k);
      const off7 = base.toString(16).toUpperCase().padStart(7, '0');
      for (let i = 0; i < 7; i++) this.cellChar(x, off7[i], (4 + i * 7) * k, 7, y + 2 * k, '#808080');
      for (let c = 0; c < 16; c++) {
        const off = base + c;
        if (off >= this.bytes.length) break;
        const b = this.bytes[off];
        const cx = (OFF_W + c * CELL_W) * k;
        const ax = (ASC_X + c * ASC_W) * k;
        let bg: string | null = null;
        if (this.pickedRange && off >= this.pickedRange[0] && off < this.pickedRange[1]) bg = '#ffff80';
        if (this.patched.has(off)) bg = '#ffb060';
        if (s && off >= s[0] && off <= s[1]) bg = SEL_BG;
        if (bg) {
          x.fillStyle = bg;
          // a selection runs on between the cells of a row, as a 98 edit control's does
          const joinR = s && bg === SEL_BG && off < s[1] && c < 15 ? 2 * k : 0;
          x.fillRect(cx - 2 * k, y, (CELL_W - 2) * k + joinR, ROW_H * k);
          x.fillRect(ax, y, ASC_W * k, ROW_H * k);
        }
        const seg = this.segAt(off);
        const isMarker = b === 0xff && off + 1 < this.bytes.length && this.bytes[off + 1] !== 0x00;
        let col = '#000000';
        if (bg === SEL_BG) col = '#ffffff';
        else if (isMarker || (off > 0 && this.bytes[off - 1] === 0xff && b !== 0 && seg && off === seg.offset + 1)) col = '#c00000';
        else if (seg && seg.name !== 'SOS') col = '#000080';
        else if (seg && seg.name === 'SOS' && off < seg.offset + 4) col = '#000080';
        this.cellChar(x, HEXCHARS[b >> 4], cx, 7, y + 2 * k, col);
        this.cellChar(x, HEXCHARS[b & 15], cx + 7 * k, 7, y + 2 * k, col);
        this.cellChar(x, b >= 32 && b < 127 ? String.fromCharCode(b) : '.', ax, ASC_W, y + 2 * k, bg === SEL_BG ? '#ffffff' : '#808080');
        if (off === this.caret) {
          // the caret: an underline, plus a bar after the first digit while half a byte is typed
          x.fillStyle = bg === SEL_BG ? '#ffffff' : '#000000';
          x.fillRect(cx - k, y + (ROW_H - 2) * k, 15 * k, k);
          if (this.nibble !== null) x.fillRect(cx + 7 * k, y + 2 * k, k, LINE * k);
        }
      }
    }
    this.drawHeader(x, w);
    this.status();
  }

  /** The column header: a raised 98 list-view header with the offsets 00..0F. */
  private drawHeader(x: CanvasRenderingContext2D, w: number) {
    const k = ui.k;
    const bar = (x0: number, x1: number) => {
      x.fillStyle = '#c0c0c0';
      x.fillRect(x0 * k, 0, (x1 - x0) * k, HEAD * k);
      x.fillStyle = '#ffffff';
      x.fillRect(x0 * k, 0, (x1 - x0) * k, k);
      x.fillRect(x0 * k, 0, k, HEAD * k);
      x.fillStyle = '#808080';
      x.fillRect(x0 * k, (HEAD - 1) * k, (x1 - x0) * k, k);
      x.fillRect((x1 - 1) * k, 0, k, HEAD * k);
    };
    bar(0, OFF_W - 4);
    bar(OFF_W - 4, ASC_X - 6);
    bar(ASC_X - 6, Math.max(ASC_X + 16 * ASC_W + 8, w));
    drawText(x, 'Offset', 6 * k, 3 * k, '#000000', { scale: k });
    for (let c = 0; c < 16; c++) {
      const hx = '0' + HEXCHARS[c];
      this.cellChar(x, hx[0], (OFF_W + c * CELL_W) * k, 7, 3 * k, '#000000');
      this.cellChar(x, hx[1], (OFF_W + c * CELL_W + 7) * k, 7, 3 * k, '#000000');
    }
    drawText(x, 'Text', (ASC_X + 2) * k, 3 * k, '#000000', { scale: k });
  }

  private status() {
    const s = this.selRange();
    setText(this.stHint, this.hint || (this.bytes.length ? (s ? 'Type hex digits to change the byte at the caret.' : 'Click a byte to select it; type hex digits to edit.') : 'Open a photo in the editor first.'));
    const at = this.caret >= 0 ? this.caret : s ? s[0] : -1;
    const seg = at >= 0 ? this.segAt(at) : null;
    setText(this.stOff, at >= 0 ? `Offset: ${hex(at)} (${at.toLocaleString('en-US')})${seg ? ' ' + seg.name : ''}` : 'Offset: —');
    setText(this.stSel, s ? `Sel: ${(s[1] - s[0] + 1).toLocaleString('en-US')} byte${s[1] > s[0] ? 's' : ''}` : 'Sel: none');
    setText(this.stSize, fmtBytes(this.bytes.length));
  }

  private renderSide() {
    const segs = this.info?.segments ?? [];
    const segList = h('div', { class: 'list lb-seg', role: 'list', 'aria-label': 'Segments' });
    for (const s of segs.slice(0, 400))
      segList.append(h('button', { class: 'li mi', role: 'listitem', 'data-tip': s.summary, onclick: () => this.goto(s.offset, s.offset + Math.min(s.length, 64) - 1) }, h('span', { class: 'b hx-segname' }, s.name), h('span', { class: 'grow' }, `${hex(s.offset)} · ${s.length} B`)));
    const evList = h('div', { class: 'list lb-ev', role: 'list', 'aria-label': 'Decode events' });
    if (!this.events.length) evList.append(h('div', { class: 'li dim' }, 'None: the file decodes cleanly.'));
    for (const e of this.events.slice(0, 300))
      evList.append(h('button', { class: 'li mi', role: 'listitem', 'data-tip': explainEvent(e), onclick: () => (e.byte >= 0 && this.goto(e.byte, e.byte), this.pickEvent(e), foldy.help(explainEvent(e))) }, h('span', { class: 'b' }, e.kind), h('span', { class: 'grow' }, ((e.x ?? -1) >= 0 ? `x ${e.x}, y ${e.y}` : e.mcu >= 0 ? `MCU ${e.mcu}` : 'header') + (e.byte >= 0 ? ` @${hex(e.byte)}` : ''))));
    const via = (this.info as any)?.via === 'fallback' ? h('div', { class: 'hint' }, 'Segment list from the built-in walker (the engine inspector is not ready).') : null;
    mount(
      this.side,
      h('div', { class: 'hx-lbl' }, 'Segments:'),
      segList,
      via,
      h('div', { class: 'hx-lbl' }, 'Decode events:'),
      evList,
      h('div', { class: 'hint hx-note' }, this.mcuNote || 'Click a block in the editor to jump to its bytes. Select bytes here to see which blocks they paint.'),
    );
  }

  private legendBox() {
    const row = (col: string, text: string, bg = false) => h('div', { class: 'row' }, bg ? swatch98(col) : swatchText(col), text);
    message('Hex Doctor colours', h('div', { class: 'col' }, row('#000080', 'Header segments (tables, sizes)'), row('#c00000', 'Markers: FF followed by a code'), row('#000000', 'Compressed picture data'), row('#ffb060', 'Your edits', true), row('#ffff80', 'The block you clicked in the editor', true)), 'info');
  }

  // ------------------------------------------------------------ navigation

  private goto(a: number, b: number) {
    if (!this.bytes.length) return;
    a = Math.max(0, Math.min(this.bytes.length - 1, a));
    b = Math.max(0, Math.min(this.bytes.length - 1, b));
    this.sel = [a, b];
    this.caret = a;
    this.nibble = null;
    this.hint = '';
    const row = Math.floor(a / 16);
    const top = row * ROW_H;
    const view = this.scroll.clientHeight - HEAD;
    if (top < this.scroll.scrollTop || top > this.scroll.scrollTop + view - ROW_H * 2) this.scroll.scrollTop = Math.max(0, top - ROW_H * 3);
    this.highlightFromSelection();
    this.render();
  }

  private selectAll() {
    if (!this.bytes.length) return;
    this.sel = [0, this.bytes.length - 1];
    this.caret = 0;
    this.highlightFromSelection();
    this.render();
  }

  /** F3 / Shift+F3: the next (previous) FF xx marker from the caret. */
  private marker(dir: 1 | -1) {
    const b = this.bytes;
    if (!b.length) return;
    let i = (this.caret >= 0 ? this.caret : dir > 0 ? -1 : b.length) + dir;
    for (; i >= 0 && i < b.length - 1; i += dir) if (b[i] === 0xff && b[i + 1] !== 0x00 && b[i + 1] !== 0xff) return this.goto(i, i + 1);
    this.hint = dir > 0 ? 'No more markers after this point.' : 'No markers before this point.';
    this.render();
  }

  private jumpSos() {
    const sos = this.info?.segments.find((s) => s.name === 'SOS');
    if (sos) this.goto(sos.offset + sos.length, sos.offset + sos.length);
    else this.marker(1);
  }

  private gotoDialog() {
    if (!this.bytes.length) return;
    let mode: 'hex' | 'dec' = 'hex';
    let text = this.caret >= 0 ? this.caret.toString(16).toUpperCase() : '0';
    const max = this.bytes.length - 1;
    const field = textField(text, (v) => (text = v), { label: 'Offset', width: 150 });
    const body = h(
      'div',
      { class: 'col hx-goto' },
      h('div', { class: 'field-row' }, h('span', { class: 'flbl' }, 'Offset:'), field),
      h('div', { class: 'group' }, h('div', { class: 'legend' }, 'Number base'), radio('hxbase', 'Hexadecimal', true, () => (mode = 'hex')), radio('hxbase', 'Decimal', false, () => (mode = 'dec'))),
      h('div', null, `The file is ${this.bytes.length.toLocaleString('en-US')} bytes (0 to ${hex(max)}).`),
    );
    dialog98({
      title: 'Go To',
      icon: 'hex',
      body,
      width: 300,
      height: 196,
      owner: this.win,
      buttons: [
        {
          label: 'OK',
          primary: true,
          run: () => {
            const t = text.trim().replace(/^0x/i, '').replace(/^\$/, '');
            const v = mode === 'hex' ? parseInt(t, 16) : parseInt(t, 10);
            const ok = /^[0-9a-f]+$/i.test(t) && (mode === 'hex' || /^\d+$/.test(t)) && Number.isFinite(v) && v >= 0 && v <= max;
            if (!ok) {
              message('Hex Doctor', `Enter a ${mode === 'hex' ? 'hexadecimal' : 'decimal'} offset from 0 to ${mode === 'hex' ? max.toString(16).toUpperCase() : max}.`, 'warning');
              return false;
            }
            this.goto(v, v);
            requestAnimationFrame(() => this.scroll.focus({ preventScroll: true }));
          },
        },
        { label: 'Cancel', cancel: true },
      ],
    });
    requestAnimationFrame(() => (field.querySelector('input') as HTMLInputElement | null)?.select());
  }

  /** Frames the event's spot in the editor: by pixel position when the engine gives one (mcu is a per-scan
   *  index, which in single-component scans counts blocks, not MCUs). */
  private pickEvent(e: DecodeEvent) {
    const g = this.geometry;
    if (g && (e.x ?? -1) >= 0 && (e.y ?? -1) >= 0) {
      const cx = Math.floor(e.x! / g.mw);
      const cy = Math.floor(e.y! / g.mh);
      link.pick({ mcu: cy * g.cols + cx, rect: { x: cx * g.mw, y: cy * g.mh, w: g.mw, h: g.mh } });
    } else if (e.mcu >= 0 && (e.comp ?? -1) < 0) this.pickMcu(e.mcu);
  }

  private pickMcu(mcu: number) {
    const g = this.geometry;
    if (!g) return;
    const cx = mcu % g.cols;
    const cy = Math.floor(mcu / g.cols);
    link.pick({ mcu, rect: { x: cx * g.mw, y: cy * g.mh, w: g.mw, h: g.mh } });
  }

  private onPicked() {
    const p = link.picked;
    if (!p || !this.mcu || p.mcu >= this.mcu.length) {
      this.pickedRange = null;
      this.render();
      return;
    }
    const bit = this.mcu[p.mcu];
    if (bit === 0xffffffff) {
      this.pickedRange = null;
      this.hint = `MCU ${p.mcu} was never reached by the decoder (it was filled in).`;
      this.render();
      return;
    }
    let next = this.bytes.length * 8;
    for (let i = p.mcu + 1; i < this.mcu.length; i++)
      if (this.mcu[i] !== 0xffffffff) {
        next = this.mcu[i];
        break;
      }
    const a = Math.floor(bit / 8);
    const b = Math.max(a + 1, Math.ceil(next / 8));
    this.pickedRange = [a, b];
    this.hint = `Block ${p.mcu}: bytes ${hex(a)} to ${hex(b - 1)}.`;
    const row = Math.floor(a / 16);
    this.scroll.scrollTop = Math.max(0, row * ROW_H - ROW_H * 3);
    this.render();
  }

  private highlightFromSelection() {
    if (!this.sel || !this.mcu || !this.geometry) return link.highlight([]);
    const a = Math.min(...this.sel) * 8;
    const b = (Math.max(...this.sel) + 1) * 8;
    const g = this.geometry;
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    // MCUs that start inside the selection, plus the one the selection starts in
    let containing = -1;
    for (let i = 0; i < this.mcu.length; i++) {
      const v = this.mcu[i];
      if (v === 0xffffffff) continue;
      if (v <= a) containing = i;
      if (v >= a && v < b) rects.push({ x: (i % g.cols) * g.mw, y: Math.floor(i / g.cols) * g.mh, w: g.mw, h: g.mh });
      if (rects.length > 2000) break;
    }
    if (containing >= 0) rects.push({ x: (containing % g.cols) * g.mw, y: Math.floor(containing / g.cols) * g.mh, w: g.mw, h: g.mh });
    link.highlight(rects);
  }

  // ------------------------------------------------------------ input

  private offsetAt(e: { clientX: number; clientY: number }): number {
    const r = this.canvas.getBoundingClientRect();
    const f = r.width / (this.canvas.width / ui.k) || 1;
    const x = (e.clientX - r.left) / f;
    const y = (e.clientY - r.top) / f - HEAD + this.scroll.scrollTop;
    const row = Math.max(0, Math.floor(y / ROW_H));
    let col = Math.floor((x - OFF_W + 3) / CELL_W);
    if (x >= ASC_X - 4) col = Math.floor((x - ASC_X) / ASC_W);
    col = Math.max(0, Math.min(15, col));
    return Math.min(this.bytes.length - 1, row * 16 + col);
  }

  private bindPointer() {
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.bytes.length || e.button !== 0) return;
      const r = this.canvas.getBoundingClientRect();
      if ((e.clientY - r.top) / (r.height / (this.canvas.height / ui.k) || 1) < HEAD) return;
      const off = this.offsetAt(e);
      this.canvas.setPointerCapture(e.pointerId);
      if (e.shiftKey && this.sel) this.sel = [this.sel[0], off];
      else this.sel = [off, off];
      this.caret = off;
      this.nibble = null;
      this.hint = '';
      this.scroll.focus({ preventScroll: true });
      this.keypad.style.display = e.pointerType === 'touch' ? 'flex' : 'none';
      const mv = (ev: PointerEvent) => {
        if (!this.sel) return;
        this.sel = [this.sel[0], this.offsetAt(ev)];
        this.caret = this.sel[1];
        this.render();
      };
      const up = () => {
        this.canvas.removeEventListener('pointermove', mv);
        this.canvas.removeEventListener('pointerup', up);
        this.highlightFromSelection();
      };
      this.canvas.addEventListener('pointermove', mv);
      this.canvas.addEventListener('pointerup', up);
      this.render();
    });
  }

  private bindKeys() {
    this.scroll.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        return this.gotoDialog();
      }
      if (e.key === 'F3') {
        e.preventDefault();
        return this.marker(e.shiftKey ? -1 : 1);
      }
      if (ctrl && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        return this.selectAll();
      }
      if (ctrl && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        return this.copy('hex');
      }
      if (ctrl && e.key === 'Home') {
        e.preventDefault();
        return this.goto(0, 0);
      }
      if (ctrl && e.key === 'End') {
        e.preventDefault();
        return this.goto(this.bytes.length - 1, this.bytes.length - 1);
      }
      if (this.caret < 0) return;
      const move = (d: number) => {
        e.preventDefault();
        this.caret = Math.max(0, Math.min(this.bytes.length - 1, this.caret + d));
        this.sel = e.shiftKey && this.sel ? [this.sel[0], this.caret] : [this.caret, this.caret];
        this.nibble = null;
        const c = this.caret;
        this.goto(this.sel[0], this.sel[1]);
        this.caret = c;
        this.render();
      };
      if (e.key === 'ArrowRight') move(1);
      else if (e.key === 'ArrowLeft') move(-1);
      else if (e.key === 'ArrowDown') move(16);
      else if (e.key === 'ArrowUp') move(-16);
      else if (e.key === 'PageDown') move(16 * Math.max(1, this.rowsVisible() - 2));
      else if (e.key === 'PageUp') move(-16 * Math.max(1, this.rowsVisible() - 2));
      else if (/^[0-9a-fA-F]$/.test(e.key) && !ctrl && !e.altKey) {
        e.preventDefault();
        this.typeNibble(parseInt(e.key, 16));
      }
    });
  }

  private copy(kind: 'hex' | 'text') {
    const s = this.selRange();
    if (!s) return;
    const part = this.bytes.subarray(s[0], s[1] + 1);
    const t = kind === 'hex' ? [...part].map((b) => HEXCHARS[b >> 4] + HEXCHARS[b & 15]).join(' ') : [...part].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    this.hint = `Copied ${part.length.toLocaleString('en-US')} byte${part.length > 1 ? 's' : ''} as ${kind === 'hex' ? 'hex' : 'text'}.`;
    void navigator.clipboard?.writeText(t).catch(() => (this.hint = 'The clipboard is not available here.'));
    this.render();
  }

  private typeNibble(v: number) {
    if (this.caret < 0 || this.caret >= this.bytes.length) return;
    if (this.nibble === null) {
      this.nibble = v;
      this.render();
      return;
    }
    const value = (this.nibble << 4) | v;
    this.nibble = null;
    const off = this.caret;
    this.writeBytes(off, [value]);
    this.caret = Math.min(this.bytes.length - 1, off + 1);
    this.sel = [this.caret, this.caret];
  }

  /** Edit ▸ Fill / Randomize: rewrites the selection (the file keeps its length; a Hex edit step holds it). */
  private fill(f: (i: number) => number) {
    const s = this.selRange();
    if (!s) return;
    const n = s[1] - s[0] + 1;
    if (n > FILL_MAX) {
      message('Hex Doctor', `Select at most ${FILL_MAX.toLocaleString('en-US')} bytes to fill at once (now ${n.toLocaleString('en-US')}).`, 'warning');
      return;
    }
    this.writeBytes(s[0], Array.from({ length: n }, (_, i) => f(i) & 255));
  }

  private writeBytes(off: number, values: number[]) {
    const stack = store.doc.stack;
    const last = stack[stack.length - 1];
    const res = pipeline.last?.results.find((r) => r.uid === last?.uid);
    store.update((d) => {
      const l = d.stack[d.stack.length - 1];
      if (l && l.type === 'patch' && l.enabled && res?.status !== 'stale') {
        let p = l.patches;
        values.forEach((v, i) => (p = setPatchedByte(p, off + i, v)));
        (l as PatchItem).patches = p;
      } else {
        // the patch's input is the current output (before this edit)
        d.stack.push(makePatch(hashBytes(this.bytes), [{ offset: off, bytes: values.slice() }]));
      }
    }, 'stack', values.length === 1 ? 'hex:' + Math.floor(off / 4) : null);
    const copy = this.bytes.slice();
    values.forEach((v, i) => {
      copy[off + i] = v;
      this.patched.add(off + i);
    });
    this.bytes = copy;
    this.render();
  }
}

function hex(n: number): string {
  return '0x' + n.toString(16).toUpperCase().padStart(6, '0');
}

function swatchText(col: string): HTMLElement {
  const s = h('span', { class: 'b hx-swt' }, 'FF');
  s.style.color = col;
  return s;
}
