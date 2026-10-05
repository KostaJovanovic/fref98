// "Removable Disk (E:)": the simulated memory card, as a Windows 98 Explorer window for the drive. The card
// is a list of camera events replayed by the engine (Card.simulate): File ▸ Copy Pictures to Disk shoots
// photos onto it, the Camera menu deletes, formats, kills the battery…, Tools ▸ Recover Files carves it with
// a recovery tool into E:\Rebuilt. Drive Properties shows the 98 pie chart; Tools ▸ Cluster Map shows who
// owns which cluster. Expert mode adds the editable Camera History and the raw .img download.
import { h, mount, fmtBytes, download, setText } from '../ui/dom';
import { iconImg } from '../ui/art';
import { button, checkbox, group, numberField, radio, selectField, tabs, textField, toolButton } from '../ui/controls';
import { openWindow, getWin, type Win } from '../ui/wm';
import { ui } from '../ui/scale';
import { store } from '../state';
import { pipeline } from '../pipeline';
import { settings } from '../settings';
import { engine, NotAvailableError, isCancel } from '../engine/client';
import { zipStore } from '../engine/zip';
import { newSeed } from '../engine/hash';
import type { CardInfo, CardPreset, CarvedFile, CardEventType, ParamInfo } from '../engine/types';
import { contactSheet, canvasToPng } from '../contact';
import { thumbUrl } from '../thumbs';
import { errorBox, message, progressDialog, progressDone, confirmBox } from '../ui/dialog';
import { ditherBayer } from '../ui/palette';
import { registerContext } from '../ui/contextmenu';
import type { MenuItem } from '../ui/menu';
import { openApp } from './registry';
import { foldy } from '../foldy/foldy';
import { dialog98, wizard98, wizardArt, listBox, pieChart, swatch98 } from './tools98';
import * as bus from '../bus';

interface ScenarioEvent {
  type: string;
  /** How many photos this event appended to the roll (File ▸ Copy Pictures). Not read by the engine. */
  _photos?: number;
  /** What the History shows. Not read by the engine. */
  _label?: string;
  [k: string]: unknown;
}

const STATE_COLORS = ['#202020', '#3366cc', '#2f8f2f', '#ff9933', '#cc0000', '#993399', '#00cccc', '#996633'];
const STATE_NAMES = ['free', 'filesystem', 'live photo', 'deleted photo', 'overwritten', 'damaged', 'video', 'junk'];
/** Cluster states the file system counts as used (free and deleted clusters are free space). */
const USED_STATES = new Set([1, 2, 4, 5, 6, 7]);

const ACCIDENTS: { id: string; label: string; story: string; events: (n: number) => ScenarioEvent[] }[] = [
  { id: 'deleted', label: 'Deleted by Accident', story: 'Half the photos were deleted in the camera.', events: (n) => [{ type: 'shoot', count: n }, { type: 'delete', which: 'random', count: Math.max(1, Math.floor(n / 2)) }] },
  { id: 'formatted', label: 'Quick-Formatted, Then Shot More', story: 'The card was formatted in the camera and a few new photos were taken.', events: (n) => [{ type: 'shoot', count: n }, { type: 'quick_format' }, { type: 'shoot', count: Math.max(1, Math.floor(n / 3)) }] },
  { id: 'fragmented', label: 'Fragmented Card', story: 'Photos were deleted and new ones filled the gaps, so files got split up.', events: (n) => [{ type: 'shoot', count: n }, { type: 'delete', which: 'every_other', count: 1 }, { type: 'shoot', count: n }] },
  { id: 'powerloss', label: 'Battery Died While Saving', story: 'The camera lost power in the middle of writing a photo.', events: () => [{ type: 'shoot', count: 1 }, { type: 'power_loss' }, { type: 'shoot', count: 1 }] },
  { id: 'chkdsk', label: 'A PC "Repaired" It', story: 'Windows ran chkdsk on the card and saved the pieces as FOUND.000.', events: (n) => [{ type: 'shoot', count: n }, { type: 'delete', which: 'random', count: Math.max(1, Math.floor(n / 3)) }, { type: 'chkdsk' }] },
  { id: 'reformat', label: 'Formatted on a PC', story: 'Someone formatted it on a computer (a different filesystem layout).', events: (n) => [{ type: 'shoot', count: n }, { type: 'reformat_pc' }, { type: 'os_junk' }] },
];

const TOOLS: [string, string, string][] = [
  ['photorec', 'PhotoRec-style carving', 'Ignores the file system and finds every JPEG by its header. Finds the most; fragmented files come out mixed.'],
  ['graft', 'Header-graft rebuild', 'Glues a donor header in front of headerless picture data (what a "repair" service does).'],
  ['recuva', 'Undelete (Recuva-style)', 'Reads the deleted directory entries and follows their cluster chains.'],
  ['undelete_contiguous', 'Undelete, assuming contiguous', 'Like DOS UNDELETE: takes the clusters after the start, in a row.'],
  ['thumbnails', 'Thumbnails only', 'Pulls out the small EXIF previews when the photos are lost.'],
];

const LABELS: Record<string, string> = { shoot: 'Take pictures', delete: 'Delete pictures', quick_format: 'Format in camera', reformat_pc: 'Format on a PC', power_loss: 'Battery dies during next save', chkdsk: 'ScanDisk / chkdsk', os_junk: 'Plug into a PC', power_cycle: 'Switch camera off and on', video: 'Record a movie', overwrite: 'Overwrite' };

type Folder = 'root' | 'rebuilt';
type View = 'large' | 'details' | 'thumbs' | 'sheet';
interface Item {
  key: string;
  name: string;
  icon: string;
  size: number;
  type: string;
  deleted?: boolean;
  status?: string;
  cluster?: number;
  file?: CardInfo['files'][number];
  carved?: CarvedFile;
  folder?: boolean;
}

let cw: CardWindow | null = null;

export function open() {
  if (cw && getWin('card')) return cw.win.focus();
  cw = new CardWindow();
}

class CardWindow {
  win: Win;
  private preset: CardPreset | null = null;
  private custom = { fs: 'fat32', size_mb: 512, cluster_kb: 32, camera: 'canon2004' };
  /** The card's whole life, replayed by the engine. */
  private events: ScenarioEvent[] = [];
  /** The photo roll (pool uids), in the order the camera takes them. */
  private roll: string[] = [];
  private seed = newSeed();
  private tool = 'photorec';
  private card: { handle: number; info: CardInfo; map: Uint8Array; owner: Int32Array } | null = null;
  private carved: CarvedFile[] | null = null;
  private recovered = new Map<number, Uint8Array>();
  private colorBy: 'state' | 'photo' = 'state';
  private folder: Folder = 'root';
  private history: Folder[] = [];
  private future: Folder[] = [];
  private view: View = 'large';
  private sort: 'name' | 'size' | 'type' | null = null;
  private showDeleted = true;
  private sel = new Set<string>();
  private anchor: string | null = null;
  private label = 'REFRAG';
  private items: Item[] = [];
  private busy = false;
  private list = h('div', { class: 'cd-view', role: 'listbox', tabIndex: 0, 'aria-multiselectable': 'true', 'aria-label': 'Files' });
  private addr = h('span');
  private tb = h('div');
  private stObjs = h('div', { class: 'grow' }, '');
  private stSize = h('div', { class: 'cd-st' }, '');
  private stFree = h('div', { class: 'cd-st2' }, '');
  private unreg: (() => void)[] = [];

  constructor() {
    const body = h('div', { class: 'cd98' }, this.tb, h('div', { class: 'cd-addr' }, h('span', { class: 'xw-grip', 'aria-hidden': 'true' }), h('span', { class: 'cd-addrlbl' }, 'Address'), this.addr), this.list);
    this.win = openWindow({
      id: 'card',
      title: 'Removable Disk (E:)',
      short: 'Disk (E:)',
      icon: 'disk',
      body,
      width: 660,
      height: Math.max(420, Math.min(500, ui.h - 80)),
      minWidth: 320,
      minHeight: 200,
      menu: [
        { label: '&File', items: () => this.fileMenu() },
        { label: '&Edit', items: () => this.editMenu() },
        { label: '&View', items: () => this.viewMenu() },
        { label: '&Go', items: () => this.goMenu() },
        { label: '&Camera', items: () => this.cameraMenu() },
        { label: '&Tools', items: () => this.toolsMenu() },
        { label: '&Help', items: () => [{ label: '&Help Topics', icon: 'help', onClick: () => openApp('help', 'card') }, { sep: true }, { label: '&About File Refragmenter', icon: 'about', onClick: () => openApp('about') }] },
      ],
      status: [this.stObjs, this.stSize, this.stFree],
      onClose: () => {
        for (const u of this.unreg) u();
        getWin('cardmap')?.close();
        if (this.card) void engine().cardFree(this.card.handle).promise.catch(() => {});
        cw = null;
      },
    });
    const presets = pipeline.caps?.cardPresets ?? [];
    this.preset = presets[1] ?? presets[0] ?? null;
    this.unreg.push(
      registerContext('.cd-view .cd-item', (t) => this.itemMenu((t.closest('.cd-item') as HTMLElement).dataset.key ?? '')),
      registerContext('.cd-view', () => this.backgroundMenu()),
      // The card lives in the engine worker. When that worker is replaced (it hung or crashed), the
      // handle points at nothing: build the same card again (the replay is deterministic).
      engine().onRestart(() => {
        if (!this.card || this.busy) return;
        this.card = null;
        void this.simulate('Reading the card again…');
      }),
    );
    this.bindKeys();
    this.render();
  }

  private available(): boolean {
    return engine().has('Card.simulate');
  }

  // ------------------------------------------------------------ the window

  private render() {
    this.items = this.folderItems();
    for (const k of [...this.sel]) if (!this.items.some((i) => i.key === k)) this.sel.delete(k);
    this.win.setTitle(this.folder === 'rebuilt' ? 'Rebuilt' : 'Removable Disk (E:)');
    this.renderToolbar();
    this.renderAddr();
    this.renderList();
    this.renderStatus();
    getWin('cardmap') && this.renderMap();
  }

  private renderToolbar() {
    const sep = () => h('span', { class: 'tsep', 'aria-hidden': 'true' });
    const big = (icon: string | HTMLElement, label: string, f: () => void, disabled = false) => {
      const b = toolButton(typeof icon === 'string' ? iconImg(icon, 16) : icon, label, f, { text: label });
      b.classList.add('cd-big');
      b.disabled = disabled;
      return b;
    };
    // only live files can be deleted (a deleted one is already gone from the directory)
    const hasSel = this.items.some((i) => this.sel.has(i.key) && i.file && !i.deleted);
    mount(
      this.tb,
      h(
        'div',
        { class: 'ed-toolbar cd-toolbar', role: 'toolbar', 'aria-label': 'Standard buttons' },
        big('undo', 'Back', () => this.goBack(), !this.history.length),
        big('redo', 'Forward', () => this.goFwd(), !this.future.length),
        big('folder', 'Up', () => this.navigate('root'), this.folder === 'root'),
        sep(),
        big('pictures', 'Copy To', () => this.writeWizard(), !this.available() || this.busy),
        big('recycle', 'Delete', () => void this.deleteSelected(), !hasSel || this.folder !== 'root' || this.busy),
        big('settings', 'Properties', () => this.properties()),
        sep(),
        big('shovel', 'Recover', () => this.recoverWizard(), !this.card || this.busy),
        big('grid', 'Map', () => this.openMap(), !this.card),
      ),
    );
  }

  private renderAddr() {
    const opts: [string, string][] = [['root', 'E:\\']];
    if (this.carved) opts.push(['rebuilt', 'E:\\Rebuilt']);
    const s = selectField(this.folder, opts, (v) => this.navigate(v as Folder), { label: 'Address', width: 300 });
    s.classList.add('cd-addrbox');
    mount(this.addr, iconImg(this.folder === 'root' ? 'disk' : 'folder', 16), s);
  }

  private renderStatus() {
    const n = this.items.length;
    const hidden = this.folder === 'root' && !this.showDeleted ? (this.card?.info.files.filter((f) => f.deleted && kindOf(f) !== 'dir').length ?? 0) : 0;
    const selItems = this.items.filter((i) => this.sel.has(i.key));
    setText(this.stObjs, selItems.length ? `${selItems.length} object(s) selected` : `${n} object(s)${hidden ? ` (plus ${hidden} hidden)` : ''}`);
    const bytes = (selItems.length ? selItems : this.items).reduce((a, i) => a + (i.folder ? 0 : i.size), 0);
    setText(this.stSize, fmtBytes(bytes));
    const sp = this.space();
    setText(this.stFree, sp ? `Free Space: ${mb(sp.free)}, Capacity: ${mb(sp.total)}` : 'No disk in drive E:');
  }

  /** Used and free bytes, from the cluster map (as the FAT reports them). */
  private space(): { used: number; free: number; total: number } | null {
    if (!this.card) return null;
    const { map, info } = this.card;
    let used = 0;
    for (let i = 0; i < map.length; i++) if (USED_STATES.has(map[i])) used++;
    const cb = info.cluster_bytes || 1;
    const total = info.size_bytes || map.length * cb;
    const u = Math.min(total, used * cb);
    return { used: u, free: total - u, total };
  }

  private folderItems(): Item[] {
    let items: Item[] = [];
    if (this.folder === 'root') {
      if (this.carved) items.push({ key: 'rebuilt', name: 'Rebuilt', icon: 'folder', size: 0, type: 'File Folder', folder: true });
      (this.card?.info.files ?? []).forEach((f, i) => {
        if (kindOf(f) === 'dir' || (f.deleted && !this.showDeleted)) return;
        const ext = (f.name.split('.').pop() ?? '').toUpperCase();
        items.push({ key: 'f' + i, name: f.deleted ? '?' + f.name.slice(1) : f.name, icon: kindOf(f) === 'video' ? 'video' : kindOf(f) === 'thm' ? 'pictures' : kindOf(f) === 'photo' || ext === 'JPG' ? 'jpeg' : 'documents', size: f.size, type: typeName(kindOf(f), ext), deleted: f.deleted, status: f.deleted ? 'Deleted' : 'OK', cluster: f.first_cluster, file: f });
      });
    } else {
      for (const c of this.carved ?? []) items.push({ key: 'r' + c.index, name: c.name, icon: 'jpeg', size: c.size, type: 'JPEG Image', status: c.note || 'Recovered', cluster: c.source_clusters?.[0], carved: c });
    }
    if (this.sort) {
      const s = this.sort;
      const dirs = items.filter((i) => i.folder);
      const rest = items.filter((i) => !i.folder).sort((a, b) => (s === 'size' ? a.size - b.size : s === 'type' ? a.type.localeCompare(b.type) || a.name.localeCompare(b.name) : a.name.replace(/^\?/, '').localeCompare(b.name.replace(/^\?/, ''))));
      items = [...dirs, ...rest];
    }
    return items;
  }

  private renderList() {
    const v = this.folder === 'root' && (this.view === 'thumbs' || this.view === 'sheet') ? 'large' : this.view;
    this.list.className = 'cd-view cd-' + v;
    if (!this.available()) {
      mount(this.list, h('div', { class: 'cd-empty' }, iconImg('disk', 32), h('div', null, h('div', { class: 'b' }, 'The card simulator is still being built.'), h('p', null, 'This window will write your photos onto a simulated memory card with a real FAT/exFAT filesystem, damage it and dig the photos back out like a recovery tool.'), button('Open the editor', () => openApp('editor'), { cls: 'small' }))));
      return;
    }
    if (!this.card) {
      mount(this.list, h('div', { class: 'cd-empty' }, iconImg('card', 32), h('div', null, h('div', { class: 'b' }, 'The disk in drive E: is empty.'), h('p', null, 'Copy some pictures onto it (File ▸ Copy Pictures to Disk…), as a camera would.'), button('Copy Pictures to Disk…', () => this.writeWizard(), { cls: 'small' }))));
      return;
    }
    if (v === 'sheet') return this.renderSheet();
    const rows: HTMLElement[] = [];
    if (v === 'details') rows.push(h('div', { class: 'cd-head', 'aria-hidden': 'true' }, ['Name', 'Size', 'Type', 'Status', 'Cluster'].map((c, i) => h('span', { class: 'cd-c' + i, onclick: () => i < 3 && this.setSort((['name', 'size', 'type'] as const)[i]) }, c))));
    for (const it of this.items) {
      const on = this.sel.has(it.key);
      let pic: HTMLElement;
      if (v === 'thumbs' && it.carved) {
        const img = h('img', { alt: '', class: 'cd-thumbimg', draggable: false });
        const bytes = this.recovered.get(it.carved.index);
        if (bytes) void thumbUrl('rec:' + this.seed + ':' + it.carved.index + ':' + bytes.length, bytes).then((u) => u && (img.src = u));
        pic = h('span', { class: 'cd-frame' }, img);
      } else pic = iconImg(it.icon, v === 'details' ? 16 : 32);
      const ico = h('span', { class: 'cd-ico' }, pic);
      if (pic instanceof HTMLImageElement) ico.style.setProperty('--mask-src', `url("${pic.src}")`);
      const cells = v === 'details' ? [h('span', { class: 'cd-c1' }, it.folder ? '' : fmtBytes(it.size)), h('span', { class: 'cd-c2' }, it.type), h('span', { class: 'cd-c3' }, it.status ?? ''), h('span', { class: 'cd-c4' }, it.cluster !== undefined ? String(it.cluster) : '')] : [];
      const row = h(
        'div',
        { class: 'cd-item' + (on ? ' sel' : '') + (it.deleted ? ' ghost' : ''), role: 'option', 'aria-selected': String(on), dataset: { key: it.key }, 'data-tip': it.carved?.note || undefined },
        ico,
        h('span', { class: 'cd-name' + (v === 'details' ? ' cd-c0' : '') }, it.name),
        cells,
      );
      row.addEventListener('pointerdown', (e) => {
        if (e.button === 2 && this.sel.has(it.key)) return;
        if (e.button > 2) return;
        this.click(it.key, e.ctrlKey || e.metaKey, e.shiftKey);
      });
      row.addEventListener('dblclick', () => this.openItem(it.key));
      rows.push(row);
    }
    if (!this.items.length) rows.push(h('div', { class: 'cd-none' }, this.folder === 'root' ? 'This folder is empty.' : 'Nothing could be recovered with that tool. Try another one.'));
    mount(this.list, rows);
  }

  private renderSheet() {
    const files = this.carved ?? [];
    const holder = h('div', { class: 'cd-sheet' }, h('div', { class: 'cd-none' }, 'Drawing…'));
    mount(this.list, holder);
    if (!files.length) return mount(holder, h('div', { class: 'cd-none' }, 'Nothing could be recovered with that tool.'));
    void contactSheet(files.map((f) => ({ name: f.name, bytes: this.recovered.get(f.index) ?? new Uint8Array() }))).then((c) => {
      c.style.width = c.width + 'px';
      c.classList.add('cd-sheetc');
      c.dataset.tip = 'Double-click a picture to open it in the editor';
      c.ondblclick = (e) => {
        const r = c.getBoundingClientRect();
        const f = r.width / c.width;
        const col = Math.floor(((e.clientX - r.left) / f - 6) / 166);
        const row = Math.floor(((e.clientY - r.top) / f - 6) / (160 + 17 + 6));
        const i = row * 8 + col;
        if (files[i]) this.openInEditor(files[i]);
      };
      mount(holder, c);
    });
  }

  private setSort(s: 'name' | 'size' | 'type') {
    this.sort = s;
    this.render();
  }

  // ------------------------------------------------------------ selection and keys

  private click(key: string, ctrl: boolean, shift: boolean) {
    if (shift && this.anchor) {
      const keys = this.items.map((i) => i.key);
      const a = keys.indexOf(this.anchor);
      const b = keys.indexOf(key);
      if (a >= 0 && b >= 0) {
        if (!ctrl) this.sel.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.sel.add(keys[i]);
      }
    } else if (ctrl) {
      if (this.sel.has(key)) this.sel.delete(key);
      else this.sel.add(key);
      this.anchor = key;
    } else {
      this.sel = new Set([key]);
      this.anchor = key;
    }
    this.syncSel();
  }

  private syncSel() {
    for (const r of this.list.querySelectorAll<HTMLElement>('.cd-item')) {
      const on = this.sel.has(r.dataset.key ?? '');
      r.classList.toggle('sel', on);
      r.setAttribute('aria-selected', String(on));
    }
    this.renderToolbar();
    this.renderStatus();
  }

  private bindKeys() {
    this.list.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && !(e.target as HTMLElement).closest('.cd-item') && !e.ctrlKey && !e.shiftKey) {
        this.sel.clear();
        this.syncSel();
      }
    });
    this.list.addEventListener('keydown', (e) => {
      const keys = this.items.map((i) => i.key);
      const cur = this.anchor ? keys.indexOf(this.anchor) : -1;
      const step = (d: number) => {
        e.preventDefault();
        const j = Math.max(0, Math.min(keys.length - 1, cur + d));
        if (keys[j]) {
          this.click(keys[j], false, e.shiftKey);
          this.list.querySelector<HTMLElement>(`.cd-item[data-key="${keys[j]}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      };
      const across = this.view === 'details' ? 1 : Math.max(1, Math.floor(this.list.clientWidth / 76));
      if (e.key === 'ArrowRight') step(this.view === 'details' ? 0 : 1);
      else if (e.key === 'ArrowLeft') step(this.view === 'details' ? 0 : -1);
      else if (e.key === 'ArrowDown') step(across);
      else if (e.key === 'ArrowUp') step(-across);
      else if (e.key === 'Home') step(-keys.length);
      else if (e.key === 'End') step(keys.length);
      else if (e.key === 'Enter' && this.anchor) {
        e.preventDefault();
        this.openItem(this.anchor);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        void this.deleteSelected();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        this.navigate('root');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.selectAll();
      } else if (e.altKey && e.key === 'Enter') {
        e.preventDefault();
        this.properties();
      }
    });
  }

  private selectAll() {
    this.sel = new Set(this.items.map((i) => i.key));
    this.syncSel();
  }

  // ------------------------------------------------------------ navigation

  private navigate(f: Folder, record = true) {
    if (f === 'rebuilt' && !this.carved) return;
    if (f === this.folder) return;
    if (record) {
      this.history.push(this.folder);
      this.future = [];
    }
    this.folder = f;
    this.sel.clear();
    this.anchor = null;
    if (f === 'rebuilt' && this.view === 'large') this.view = 'thumbs';
    if (f === 'root' && (this.view === 'thumbs' || this.view === 'sheet')) this.view = 'large';
    this.render();
  }

  private goBack() {
    const p = this.history.pop();
    if (!p) return;
    this.future.push(this.folder);
    this.navigate(p, false);
  }

  private goFwd() {
    const n = this.future.pop();
    if (!n) return;
    this.history.push(this.folder);
    this.navigate(n, false);
  }

  private item(key: string): Item | undefined {
    return this.items.find((i) => i.key === key);
  }

  private openItem(key: string) {
    const it = this.item(key);
    if (!it) return;
    if (it.folder) return this.navigate('rebuilt');
    if (it.carved) return this.openInEditor(it.carved);
    const f = it.file;
    if (!f) return;
    if (f.deleted) {
      message(it.name, `${f.name} was deleted. Its clusters are free space now, but the data may still be there.\nUse Tools ▸ Recover Files… to dig it back out.`, 'info', [
        { label: 'Recover…', primary: true, run: () => this.recoverWizard() },
        { label: 'Cancel' },
      ]);
      return;
    }
    if (kindOf(f) === 'photo' && f.photo_index >= 0 && this.roll.length) {
      const uid = this.roll[f.photo_index % this.roll.length];
      if (store.pool().some((p) => p.uid === uid)) {
        store.update((d) => void (d.current = uid), 'photos');
        openApp('editor');
        return;
      }
    }
    message('Open With', `Windows cannot open ${f.name}: no program is registered for ${typeName(kindOf(f), (f.name.split('.').pop() ?? '').toUpperCase())} files.\nRecovered pictures (Tools ▸ Recover Files…) open in the editor.`, 'info');
  }

  private openInEditor(f: CarvedFile) {
    const bytes = this.recovered.get(f.index);
    if (!bytes) return;
    store.addPhoto({ name: 'Recovered ' + f.name, source: 'recovered', bytes, note: f.note }, { makeCurrent: true });
    openApp('editor');
  }

  // ------------------------------------------------------------ menus

  private fileMenu(): MenuItem[] {
    const one = this.sel.size === 1 ? [...this.sel][0] : null;
    const expert = settings.expert;
    return [
      { label: '&Open', default: true, disabled: !one, onClick: () => one && this.openItem(one) },
      { sep: true },
      { label: 'Co&py Pictures to Disk…', icon: 'pictures', disabled: !this.available() || this.busy, onClick: () => this.writeWizard() },
      { label: 'For&mat…', disabled: !this.card || this.busy, onClick: () => this.formatDialog() },
      { sep: true },
      { label: '&Delete', acc: 'Del', disabled: !this.items.some((i) => this.sel.has(i.key) && i.file && !i.deleted) || this.busy, onClick: () => void this.deleteSelected() },
      { label: 'P&roperties', acc: 'Alt+Enter', onClick: () => this.properties() },
      { sep: true },
      { label: 'Save Rebuilt as &ZIP…', icon: 'project', disabled: !this.carved?.length, onClick: () => this.zip() },
      { label: 'Contact &Sheet PNG…', disabled: !this.carved?.length, onClick: () => void this.sheetPng() },
      ...(expert ? [{ label: 'Save Disk &Image (.img)…', icon: 'card', disabled: !this.card, onClick: () => void this.downloadImg() } as MenuItem] : []),
      { sep: true },
      { label: '&Close', onClick: () => this.win.close() },
    ];
  }

  private editMenu(): MenuItem[] {
    const last = this.events[this.events.length - 1];
    return [
      { label: last ? `&Undo ${eventLabel(last)}` : '&Undo', disabled: !last || this.busy, onClick: () => void this.undoEvent() },
      { sep: true },
      { label: 'Select &All', acc: 'Ctrl+A', disabled: !this.items.length, onClick: () => this.selectAll() },
      {
        label: '&Invert Selection',
        disabled: !this.items.length,
        onClick: () => {
          this.sel = new Set(this.items.map((i) => i.key).filter((k) => !this.sel.has(k)));
          this.syncSel();
        },
      },
    ];
  }

  private viewMenu(): MenuItem[] {
    const rb = this.folder === 'rebuilt';
    const setV = (v: View) => () => ((this.view = v), this.render());
    return [
      { label: 'Lar&ge Icons', radio: true, checked: this.view === 'large', onClick: setV('large') },
      { label: '&Details', radio: true, checked: this.view === 'details', onClick: setV('details') },
      { label: '&Thumbnails', radio: true, checked: this.view === 'thumbs', disabled: !rb, onClick: setV('thumbs') },
      { label: '&Contact Sheet', radio: true, checked: this.view === 'sheet', disabled: !rb, onClick: setV('sheet') },
      { sep: true },
      { label: 'Arrange &Icons', sub: this.arrangeMenu() },
      { label: 'Sho&w Deleted Files', checked: this.showDeleted, onClick: () => ((this.showDeleted = !this.showDeleted), this.render()) },
      { sep: true },
      { label: '&Refresh', onClick: () => this.render() },
    ];
  }

  private arrangeMenu(): MenuItem[] {
    return [
      { label: 'by &Name', radio: true, checked: this.sort === 'name', onClick: () => this.setSort('name') },
      { label: 'by &Type', radio: true, checked: this.sort === 'type', onClick: () => this.setSort('type') },
      { label: 'by &Size', radio: true, checked: this.sort === 'size', onClick: () => this.setSort('size') },
      { label: '&Disk Order', radio: true, checked: this.sort === null, onClick: () => ((this.sort = null), this.render()) },
    ];
  }

  private goMenu(): MenuItem[] {
    return [
      { label: '&Back', disabled: !this.history.length, onClick: () => this.goBack() },
      { label: '&Forward', disabled: !this.future.length, onClick: () => this.goFwd() },
      { label: '&Up One Level', disabled: this.folder === 'root', onClick: () => this.navigate('root') },
      { sep: true },
      { label: '&E:\\', icon: 'disk', onClick: () => this.navigate('root') },
      { label: 'E:\\&Rebuilt', icon: 'folder', disabled: !this.carved, onClick: () => this.navigate('rebuilt') },
    ];
  }

  private cameraMenu(): MenuItem[] {
    const no = !this.card || this.busy;
    const ev = (e: ScenarioEvent, title: string) => () => void this.addEvents([e], title);
    return [
      { label: '&Take Pictures…', icon: 'camera', disabled: !this.available() || this.busy, onClick: () => this.writeWizard() },
      { label: 'Record a &Movie', icon: 'video', disabled: no, onClick: ev({ type: 'video', frames: 4 }, 'Recording…') },
      {
        label: '&Delete Pictures',
        disabled: no,
        sub: [
          { label: 'The &Last One', onClick: ev({ type: 'delete', which: 'last', count: 1 }, 'Deleting…') },
          { label: 'The &First One', onClick: ev({ type: 'delete', which: 'first', count: 1 }, 'Deleting…') },
          { label: '&Every Other One', onClick: ev({ type: 'delete', which: 'every_other', count: 1 }, 'Deleting…') },
          { label: '&Three at Random', onClick: ev({ type: 'delete', which: 'random', count: 3 }, 'Deleting…') },
          { sep: true },
          { label: '&All Pictures', onClick: ev({ type: 'delete', which: 'all', count: 1 }, 'Deleting…') },
        ],
      },
      { label: '&Switch Off and On', disabled: no, onClick: ev({ type: 'power_cycle' }, 'Restarting…') },
      { label: 'Battery Dies During &Next Save', disabled: no, onClick: ev({ type: 'power_loss', at: 0.5, mode: 'size_zero' }, 'Arming…') },
      {
        label: '&Format in Camera',
        disabled: no,
        onClick: async () => {
          if (await confirmBox('Format', 'Formatting in the camera writes a fresh, empty file table.\nThe pictures stay physically on the card. Continue?', 'Format', 'warning')) void this.addEvents([{ type: 'quick_format' }], 'Formatting…');
        },
      },
      { sep: true },
      { label: '&Accidents', disabled: no, sub: ACCIDENTS.map((a) => ({ label: a.label, onClick: () => void this.accident(a) })) },
      { label: '&Plug Into a PC', disabled: no, onClick: ev({ type: 'os_junk', kb: 256 }, 'Windows is looking at the card…') },
      { sep: true },
      { label: 'Camera &History…', disabled: !this.events.length, onClick: () => this.historyDialog() },
    ];
  }

  private toolsMenu(): MenuItem[] {
    return [
      { label: '&Recover Files…', icon: 'shovel', disabled: !this.card || this.busy, onClick: () => this.recoverWizard() },
      { label: '&Cluster Map', icon: 'grid', disabled: !this.card, onClick: () => this.openMap() },
      { label: '&ScanDisk…', disabled: !this.card || this.busy, onClick: () => void this.scandisk() },
    ];
  }

  private itemMenu(key: string): MenuItem[] {
    if (!this.sel.has(key)) {
      this.sel = new Set([key]);
      this.anchor = key;
      this.syncSel();
    }
    const it = this.item(key);
    if (!it) return [];
    if (it.folder)
      return [
        { label: '&Open', default: true, onClick: () => this.navigate('rebuilt') },
        { label: '&Explore', onClick: () => this.navigate('rebuilt') },
        { sep: true },
        { label: 'Save as &ZIP…', onClick: () => this.zip() },
        { label: 'Contact &Sheet PNG…', onClick: () => void this.sheetPng() },
        { sep: true },
        { label: 'P&roperties', onClick: () => this.itemProps(it) },
      ];
    if (it.carved)
      return [
        { label: '&Open', default: true, onClick: () => this.openInEditor(it.carved!) },
        {
          label: '&Save As…',
          onClick: () => {
            const b = this.recovered.get(it.carved!.index);
            if (b) download(b, it.name, 'image/jpeg');
          },
        },
        { sep: true },
        { label: 'P&roperties', onClick: () => this.itemProps(it) },
      ];
    return [
      { label: '&Open', default: !it.deleted, disabled: !!it.deleted, onClick: () => this.openItem(key) },
      ...(it.deleted ? [{ label: '&Recover…', default: true, onClick: () => this.recoverWizard() } as MenuItem] : []),
      { sep: true },
      { label: '&Delete', disabled: !!it.deleted || this.busy, onClick: () => void this.deleteSelected() },
      { sep: true },
      { label: 'P&roperties', onClick: () => this.itemProps(it) },
    ];
  }

  private backgroundMenu(): MenuItem[] {
    const rb = this.folder === 'rebuilt';
    const setV = (v: View) => () => ((this.view = v), this.render());
    return [
      {
        label: '&View',
        sub: [
          { label: 'Lar&ge Icons', radio: true, checked: this.view === 'large', onClick: setV('large') },
          { label: '&Details', radio: true, checked: this.view === 'details', onClick: setV('details') },
          { label: '&Thumbnails', radio: true, checked: this.view === 'thumbs', disabled: !rb, onClick: setV('thumbs') },
          { label: '&Contact Sheet', radio: true, checked: this.view === 'sheet', disabled: !rb, onClick: setV('sheet') },
        ],
      },
      { sep: true },
      { label: 'Arrange &Icons', sub: this.arrangeMenu() },
      { label: 'R&efresh', onClick: () => this.render() },
      { sep: true },
      { label: '&Paste', disabled: true },
      { label: 'Copy &Pictures Here…', disabled: !this.available() || this.busy || rb, onClick: () => this.writeWizard() },
      { sep: true },
      { label: 'P&roperties', onClick: () => this.properties() },
    ];
  }

  // ------------------------------------------------------------ the card's life

  private scenario() {
    const p = this.preset;
    const base = p ? { fs: p.fs, size_mb: p.size_mb, cluster_kb: p.cluster_kb, camera: p.camera } : { ...this.custom };
    return { ...base, events: this.events };
  }

  /** Replays the events onto a fresh card. Returns false when it failed or was cancelled. */
  private async simulate(title: string, say?: string): Promise<boolean> {
    if (!this.roll.length) {
      if (this.card) await engine().cardFree(this.card.handle).promise.catch(() => {});
      this.card = null;
      this.carved = null;
      this.recovered.clear();
      this.render();
      return true;
    }
    this.busy = true;
    this.renderToolbar();
    let job: ReturnType<ReturnType<typeof engine>['cardSimulate']> | null = null;
    const n = this.roll.length;
    const prog = progressDialog(title.replace(/…$/, ''), {
      onCancel: () => job?.cancel(),
      messages: (i) => (i < 6 ? `${title.replace(/…$/, '')} ${Math.min(n, i + 1)} of ${n}…` : `Updating cluster ${(i * 4181).toLocaleString('en-US')}…`),
      say,
    });
    try {
      const photos = await Promise.all(this.roll.map((u) => pipeline.photoBytes(u)));
      if (this.card) await engine().cardFree(this.card.handle).promise.catch(() => {});
      this.card = null;
      job = engine().cardSimulate(this.scenario(), photos, this.seed);
      this.card = await job.promise;
      // anything recovered before belonged to the old state of the card
      if (this.carved) {
        this.carved = null;
        this.recovered.clear();
        if (this.folder === 'rebuilt') this.folder = 'root';
        this.history = this.history.filter((f) => f === 'root');
        this.future = [];
      }
      return true;
    } catch (e) {
      if (e instanceof NotAvailableError) message('Not available yet', 'The card simulator is not in the engine yet.', 'disk');
      else if (!isCancel(e)) errorBox(String((e as Error).message ?? e));
      return false;
    } finally {
      progressDone(prog);
      this.busy = false;
      this.render();
    }
  }

  private async addEvents(evs: ScenarioEvent[], title: string) {
    const before = this.events.length;
    this.events.push(...evs);
    if (!(await this.simulate(title))) this.events.length = before;
    this.render();
  }

  private async undoEvent() {
    const last = this.events.pop();
    if (!last) return;
    if (last._photos) this.roll.splice(this.roll.length - last._photos, last._photos);
    if (!(await this.simulate('Undoing…'))) {
      this.events.push(last);
    }
  }

  private async accident(a: (typeof ACCIDENTS)[number]) {
    let evs = a.events(Math.max(1, this.roll.length));
    // the card already has pictures: the accident happens to those
    if (evs[0]?.type === 'shoot' && this.events.length) evs = evs.slice(1);
    evs[0] = { ...evs[0], _label: a.label };
    await this.addEvents(evs, 'Working…');
    foldy.help(a.story);
  }

  private async scandisk() {
    if (!(await confirmBox('ScanDisk - Removable Disk (E:)', 'ScanDisk will look for lost cluster chains and save them as files in FOUND.000.\nStart now?', 'Start', 'question'))) return;
    await this.addEvents([{ type: 'chkdsk' }], 'Checking…');
    message('ScanDisk Results - Removable Disk (E:)', `ScanDisk finished.\n${this.card?.info.files.filter((f) => /\.CHK$/i.test(f.name)).length ?? 0} lost chain(s) were saved in FOUND.000.`, 'info');
  }

  private async deleteSelected() {
    if (this.folder !== 'root' || this.busy || !this.card) return;
    const live = this.card.info.files.map((f, i) => ({ f, i })).filter(({ f }) => !f.deleted && kindOf(f) !== 'dir');
    const chosen = live.filter(({ i }) => this.sel.has('f' + i));
    if (!chosen.length) return;
    const k = chosen.length;
    const ev: ScenarioEvent = k === live.length ? { type: 'delete', which: 'all', count: 1 } : { type: 'delete', which: 'names', names: chosen.map((c) => c.f.name) };
    const q = k === 1 ? `Are you sure you want to delete '${chosen[0].f.name}'?` : `Are you sure you want to delete these ${k} items?`;
    if (!(await confirmBox('Confirm File Delete', q, 'Yes', 'warning'))) return;
    await this.addEvents([ev], 'Deleting…');
  }

  // ------------------------------------------------------------ Copy Pictures to Disk (the write wizard)

  private writeWizard() {
    if (!this.available() || this.busy) return;
    const presets = pipeline.caps?.cardPresets ?? [];
    const pool = store.pool();
    const chosen = new Set(pool.slice(0, 12).map((p) => p.uid));
    const first = !this.card;
    const c = this.custom;
    const pages = [
      ...(first
        ? [
            {
              title: 'Which memory card is in the camera?',
              render: (into: HTMLElement) => {
                const desc = h('div', { class: 'cd-desc' });
                const describe = () => {
                  const p = this.preset;
                  mount(desc, p ? `${p.fs.toUpperCase()} · ${p.size_mb >= 1024 ? p.size_mb / 1024 + ' GB' : p.size_mb + ' MB'} · ${p.cluster_kb} KB clusters · ${p.camera}${p.description ? '. ' + p.description : ''}` : `Custom: ${c.fs.toUpperCase()} · ${c.size_mb} MB · ${c.cluster_kb} KB clusters`);
                };
                const items = presets.map((p) => ({ id: p.id, label: p.label, icon: iconImg('card', 16) }));
                if (settings.expert) items.push({ id: '__custom', label: 'Custom card (expert)', icon: iconImg('settings', 16) });
                const lb = listBox(items, this.preset?.id ?? (settings.expert ? '__custom' : null), (id) => {
                  this.preset = presets.find((p) => p.id === id) ?? null;
                  describe();
                  custom.style.display = this.preset ? 'none' : '';
                }, { label: 'Memory card' });
                const custom = group(
                  'Custom card',
                  h('div', { class: 'field-row' }, h('span', { class: 'flbl cd-flbl' }, 'File system:'), selectField(c.fs, [['fat16', 'FAT16'], ['fat32', 'FAT32'], ['exfat', 'exFAT']], (v) => ((c.fs = v), describe()), { label: 'File system' })),
                  h('div', { class: 'field-row' }, h('span', { class: 'flbl cd-flbl' }, 'Size (MB):'), numberField(c.size_mb, (v) => ((c.size_mb = v), describe()), { min: 8, max: 65536, label: 'Size (MB)' })),
                  h('div', { class: 'field-row' }, h('span', { class: 'flbl cd-flbl' }, 'Cluster (KB):'), numberField(c.cluster_kb, (v) => ((c.cluster_kb = v), describe()), { min: 1, max: 512, label: 'Cluster (KB)' })),
                  h('div', { class: 'field-row' }, h('span', { class: 'flbl cd-flbl' }, 'Camera:'), selectField(c.camera, [['canon2004', '2004 Canon compact'], ['phone', 'Modern phone'], ['generic', 'Generic camera']], (v) => (c.camera = v), { label: 'Camera' })),
                );
                custom.style.display = this.preset ? 'none' : '';
                describe();
                into.append(lb, desc, custom);
                if (!presets.length && !settings.expert) into.append(h('div', { class: 'hint' }, 'No card presets from the engine yet.'));
              },
              canNext: () => !!this.preset || settings.expert,
            },
          ]
        : []),
      {
        title: 'Which pictures should the camera take?',
        render: (into: HTMLElement) => {
          const list = h('div', { class: 'list cd-pick' }, pool.map((p) => h('div', { class: 'li' }, checkbox(p.name, chosen.has(p.uid), (v) => (v ? chosen.add(p.uid) : chosen.delete(p.uid), wz.refresh())))));
          into.append(h('div', null, 'They are taken in this order, from My Pictures.'), list, h('div', { class: 'row' }, button('Select All', () => (pool.forEach((p) => chosen.add(p.uid)), wz.go(wz.page())), { cls: 'small' }), button('Clear', () => (chosen.clear(), wz.go(wz.page())), { cls: 'small' })));
        },
        canNext: () => chosen.size > 0,
      },
      {
        title: first ? 'Ready to copy the pictures' : 'Ready to take more pictures',
        render: (into: HTMLElement) => {
          into.append(h('p', null, `The camera will save ${chosen.size} picture(s) onto Removable Disk (E:), one after another, as files with real FAT directory entries and cluster chains.`));
          if (first)
            into.append(
              h('div', { class: 'field-row' }, h('span', { class: 'flbl' }, 'Random seed:'), numberField(this.seed, (v) => (this.seed = v >>> 0), { width: 110, label: 'Random seed' }), button('', () => ((this.seed = newSeed()), wz.go(wz.page())), { cls: 'small', icon: iconImg('dice', 16), aria: 'New seed' })),
              h('div', { class: 'hint' }, 'The same seed gives the same card every time.'),
            );
          into.append(h('p', null, 'Click Finish to start copying.'));
        },
        next: async () => {
          const uids = pool.filter((p) => chosen.has(p.uid)).map((p) => p.uid);
          const before = this.events.length;
          this.roll.push(...uids);
          this.events.push({ type: 'shoot', count: uids.length, _photos: uids.length, _label: `Copy ${uids.length} picture(s)` });
          wz.win.el.style.visibility = 'hidden';
          const ok = await this.simulate('Copying…', 'Writing your photos onto the card… this can take a moment.');
          if (!ok) {
            this.events.length = before;
            this.roll.splice(this.roll.length - uids.length, uids.length);
            wz.win.el.style.visibility = '';
            return false;
          }
        },
      },
    ];
    const wz = wizard98({ id: 'cardwrite', title: 'Copy Pictures to Disk', icon: 'pictures', art: wizardArt(['card', 'pictures', 'camera']), pages, width: 520, height: 390, owner: this.win });
  }

  // ------------------------------------------------------------ Recover Files wizard

  private recoverWizard() {
    if (!this.card || this.busy) return;
    let open = true;
    let found = 0;
    const pages = [
      {
        title: 'Welcome to the Recover Files Wizard',
        render: (into: HTMLElement) => {
          into.append(
            h('p', null, 'This wizard digs deleted, formatted and damaged pictures back out of Removable Disk (E:), the way a recovery tool does.'),
            h('p', null, 'Nothing is written to the card. The pictures it finds are saved in a new folder, E:\\Rebuilt.'),
            h('p', null, 'To continue, click Next.'),
          );
        },
      },
      {
        title: 'How should the wizard look for pictures?',
        render: (into: HTMLElement) => {
          const desc = h('div', { class: 'cd-desc' });
          const describe = () => mount(desc, TOOLS.find((t) => t[0] === this.tool)?.[2] ?? '');
          const box = h('div', { class: 'col cd-tools', role: 'radiogroup', 'aria-label': 'Recovery method' }, TOOLS.map(([id, label]) => radio('cdtool', label, this.tool === id, () => ((this.tool = id), describe()))));
          describe();
          into.append(box, desc);
        },
      },
      {
        title: 'Ready to recover',
        render: (into: HTMLElement) => {
          into.append(h('p', null, `Method: ${TOOLS.find((t) => t[0] === this.tool)?.[1]}.`), h('p', null, 'This reads every cluster of the card and can take a moment.'), h('p', null, 'Click Next to start.'));
        },
        next: async () => {
          const ok = await this.carve();
          found = this.carved?.length ?? 0;
          return ok;
        },
      },
      {
        title: 'Completing the Recover Files Wizard',
        render: (into: HTMLElement) => {
          into.append(
            h('p', null, found ? `${found} file(s) were recovered into E:\\Rebuilt.` : 'Nothing could be recovered with this method. Try another one.'),
            found ? checkbox('Open the Rebuilt folder', open, (v) => (open = v)) : h('span'),
            h('p', null, 'To close this wizard, click Finish.'),
          );
        },
      },
    ];
    wizard98({
      id: 'cardrecover',
      title: 'Recover Files Wizard',
      icon: 'shovel',
      art: wizardArt(['disk', 'shovel', 'jpeg']),
      pages,
      width: 520,
      height: 360,
      owner: this.win,
      onFinish: () => {
        if (open && found) this.navigate('rebuilt');
        else this.render();
      },
    });
  }

  private async carve(): Promise<boolean> {
    if (!this.card) return false;
    let job: { cancel(): void } | null = null;
    const prog = progressDialog('Recovering files', {
      onCancel: () => job?.cancel(),
      messages: (i) => `Recovering file ${i + 1} of ${Math.max(i + 1, this.card?.info.files.length ?? 166)}…`,
      say: 'Digging through every cluster… fingers crossed.',
    });
    foldy.mood('worried');
    this.busy = true;
    try {
      const j = engine().cardCarve(this.card.handle, { tool: this.tool });
      job = j;
      const carved = await j.promise;
      const rec = new Map<number, Uint8Array>();
      for (let i = 0; i < carved.length; i++) {
        if (prog.cancelled) return false;
        prog.set(i / carved.length, `Recovering file ${i + 1} of ${carved.length}…`);
        const jj = engine().cardRecovered(this.card.handle, carved[i].index);
        job = jj;
        rec.set(carved[i].index, await jj.promise);
      }
      this.carved = carved;
      this.recovered = rec;
      bus.emit('card-carved');
      return true;
    } catch (e) {
      if (!isCancel(e)) errorBox(String((e as Error).message ?? e));
      return false;
    } finally {
      this.busy = false;
      foldy.mood(null);
      progressDone(prog);
      this.render();
    }
  }

  // ------------------------------------------------------------ Format

  private formatDialog() {
    if (!this.card) return;
    const info = this.card.info;
    const curFs = (info.fs || 'fat32').toLowerCase();
    let quick = true;
    let fs = curFs;
    let label = this.label;
    let noLabel = false;
    let summary = true;
    const body = h(
      'div',
      { class: 'col cd-format' },
      h('div', { class: 'field-row' }, h('span', { class: 'flbl' }, 'Capacity:'), selectField('c', [['c', mb(info.size_bytes)]], () => {}, { label: 'Capacity', width: 140 })),
      group('Format type', radio('cdfmt', 'Quick (erase)', true, () => (quick = true)), radio('cdfmt', 'Full', false, () => (quick = false)), radio('cdfmt', 'Copy system files only', false, () => {}, { disabled: true })),
      group(
        'Other options',
        h('div', { class: 'field-row' }, h('span', { class: 'flbl' }, 'Label:'), textField(label, (v) => (label = v.toUpperCase().slice(0, 11)), { label: 'Label', width: 120 })),
        checkbox('No label', false, (v) => (noLabel = v)),
        checkbox('Display summary when finished', true, (v) => (summary = v)),
        h('div', { class: 'field-row' }, h('span', { class: 'flbl' }, 'File system:'), selectField(fs, [['fat16', 'FAT16'], ['fat32', 'FAT32'], ['exfat', 'exFAT']], (v) => (fs = v), { label: 'File system', width: 90 })),
      ),
    );
    dialog98({
      title: 'Format - Removable Disk (E:)',
      icon: 'disk',
      body,
      width: 380,
      height: 296,
      owner: this.win,
      column: true,
      buttons: [
        {
          label: 'Start',
          primary: true,
          run: () => {
            this.label = noLabel ? '' : label;
            // a quick format in the same file system is the camera's; anything else is a PC format
            const ev: ScenarioEvent = quick && fs === curFs ? { type: 'quick_format', _label: 'Quick format' } : { type: 'reformat_pc', fs, cluster_kb: fs === 'exfat' ? 32 : 4, _label: `${quick ? 'Quick' : 'Full'} format (${fs.toUpperCase()})` };
            void this.addEvents([ev], 'Formatting…').then(() => summary && this.card && this.formatSummary());
          },
        },
        { label: 'Close', cancel: true },
      ],
    });
  }

  private formatSummary() {
    const info = this.card!.info;
    const sp = this.space()!;
    const units = info.cluster_count || Math.round(sp.total / (info.cluster_bytes || 1));
    const serial = ((this.seed >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, '0') + '-' + (this.seed & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    message(
      'Format Results - Removable Disk (E:)',
      `${sp.total.toLocaleString('en-US')} bytes total disk space\n0 bytes in bad sectors\n${(sp.used).toLocaleString('en-US')} bytes used\n${sp.free.toLocaleString('en-US')} bytes available on disk\n\n${(info.cluster_bytes || 0).toLocaleString('en-US')} bytes in each allocation unit\n${units.toLocaleString('en-US')} total allocation units on disk\n\nSerial number ${serial}`,
      'disk',
    );
  }

  // ------------------------------------------------------------ Properties

  private properties() {
    let tab = 0;
    let label = this.label;
    const page = h('div', { class: 'tabpage cd-props' });
    const bar = h('div');
    const draw = () => {
      mount(bar, tabs(['General', 'Tools', 'History'], tab, (i) => ((tab = i), draw())));
      page.replaceChildren();
      if (tab === 0) this.generalTab(page, label, (v) => (label = v));
      else if (tab === 1) this.toolsTab(page, () => w.close());
      else this.historyTab(page);
    };
    const w = dialog98({
      id: 'cardprops',
      title: 'Removable Disk (E:) Properties',
      icon: 'disk',
      body: h('div', { class: 'cd-sheetbox' }, bar, page),
      width: 368,
      height: 432,
      owner: this.win,
      buttons: [
        { label: 'OK', primary: true, run: () => void (this.label = label) },
        { label: 'Cancel', cancel: true },
        { label: 'Apply', disabled: true },
      ],
    });
    draw();
  }

  private generalTab(page: HTMLElement, label: string, setLabel: (v: string) => void) {
    const sp = this.space();
    const info = this.card?.info;
    const row = (k: string, v: string, b?: string, sw?: string) => h('div', { class: 'cd-prow' }, sw ? swatch98(sw) : h('span', { class: 'cd-nosw' }), h('span', { class: 'cd-pk' }, k), h('span', { class: 'cd-pv' }, v), h('span', { class: 'cd-pb' }, b ?? ''));
    page.append(
      h('div', { class: 'cd-prow cd-ptop' }, iconImg('disk', 32), textField(label, (v) => setLabel(v.toUpperCase().slice(0, 11)), { label: 'Label', width: 180 })),
      h('div', { class: 'cd-etch' }),
      row('Type:', 'Removable Disk'),
      row('File system:', info ? info.fs.toUpperCase() : '(none)'),
      h('div', { class: 'cd-etch' }),
      row('Used space:', sp ? `${sp.used.toLocaleString('en-US')} bytes` : '0 bytes', sp ? mb(sp.used) : '0MB', '#0000ff'),
      row('Free space:', sp ? `${sp.free.toLocaleString('en-US')} bytes` : '0 bytes', sp ? mb(sp.free) : '0MB', '#ff00ff'),
      h('div', { class: 'cd-etch' }),
      row('Capacity:', sp ? `${sp.total.toLocaleString('en-US')} bytes` : '0 bytes', sp ? mb(sp.total) : '0MB'),
      h('div', { class: 'cd-pie' }, pieChart(sp?.used ?? 0, sp?.total ?? 1), h('div', null, 'Drive E')),
      h('div', { class: 'cd-prow cd-pbtn' }, button('Disk Cleanup…', () => message('Disk Cleanup', 'There is nothing to clean up on Removable Disk (E:).\nCameras don’t leave temporary files; only PCs do (Camera ▸ Plug Into a PC).', 'info'), { cls: 'small', disabled: !this.card })),
    );
  }

  private toolsTab(page: HTMLElement, closeSheet: () => void) {
    const block = (title: string, text: string, label: string, f: () => void, disabled: boolean) => group(title, h('div', { class: 'cd-tool' }, h('div', null, text), h('div', { class: 'cd-toolbtn' }, button(label, () => (closeSheet(), f()), { disabled }))));
    page.append(
      block('Error-checking status', 'ScanDisk saves lost cluster chains as FOUND.000 files (what Windows did to many a camera card).', 'Check Now…', () => void this.scandisk(), !this.card || this.busy),
      block('Recovery status', this.carved ? `${this.carved.length} file(s) were recovered into E:\\Rebuilt.` : 'No files have been recovered from this disk yet.', 'Recover Now…', () => this.recoverWizard(), !this.card || this.busy),
      block('Cluster map', 'Shows which file owns each cluster of the card, deleted ones included.', 'Show Map…', () => this.openMap(), !this.card),
    );
  }

  private historyTab(page: HTMLElement) {
    const log = this.card?.info.log ?? [];
    page.append(
      h('div', null, 'What happened to this card:'),
      h('div', { class: 'list cd-log selectable' }, log.length ? log.map((l) => h('div', { class: 'li' }, l)) : h('div', { class: 'li dim' }, 'Nothing yet.')),
      h('div', { class: 'row' }, button('Camera History…', () => this.historyDialog(), { cls: 'small', disabled: !this.events.length })),
    );
  }

  private itemProps(it: Item) {
    const f = it.file;
    const lines = [
      `Type: ${it.type}`,
      `Location: ${this.folder === 'root' ? 'E:\\' : 'E:\\Rebuilt'}`,
      it.folder ? `Contains: ${this.carved?.length ?? 0} file(s)` : `Size: ${fmtBytes(it.size)} (${it.size.toLocaleString('en-US')} bytes)`,
      it.cluster !== undefined ? `First cluster: ${it.cluster}` : '',
      f ? `Attributes: ${f.deleted ? 'Deleted (the directory entry starts with E5)' : 'Archive'}` : '',
      it.carved?.note ? `Recovery: ${it.carved.note}` : '',
      it.carved?.source_clusters?.length ? `Clusters: ${it.carved.source_clusters.length} (from ${it.carved.source_clusters[0]})` : '',
    ].filter(Boolean);
    message(`${it.name} Properties`, lines.join('\n'), it.folder ? 'folder' : it.icon);
  }

  // ------------------------------------------------------------ Camera History (the timeline)

  private historyDialog() {
    const types: CardEventType[] = pipeline.caps?.cardEvents ?? [];
    const tid = (t: CardEventType) => t.type ?? t.id ?? t.label;
    const work: ScenarioEvent[] = JSON.parse(JSON.stringify(this.events));
    const expert = settings.expert;
    const box = h('div', { class: 'col cd-hist' });
    const draw = () => {
      const rows = h('div', { class: 'list cd-histlist' });
      work.forEach((ev, i) => {
        const info = types.find((t) => tid(t) === ev.type);
        const params = expert
          ? (info?.params ?? []).map((p: ParamInfo) => {
              const v = ev[p.id] ?? p.default;
              let ctl: HTMLElement;
              if (p.kind === 'enum') ctl = selectField(String(v), p.options ?? [], (nv) => (ev[p.id] = nv), { label: p.label });
              else if (p.kind === 'bool') ctl = checkbox('', !!v, (nv) => (ev[p.id] = nv));
              else ctl = numberField(Number(v), (nv) => (ev[p.id] = nv), { min: p.min, max: p.max, step: p.step, label: p.label });
              return h('div', { class: 'field-row cd-param' }, h('span', { class: 'flbl', 'data-tip': p.hint }, p.label), ctl);
            })
          : [];
        rows.append(
          h(
            'div',
            { class: 'cd-hrow' },
            h('div', { class: 'cd-hhead' }, h('span', { class: 'b' }, `${i + 1}.`), h('span', { class: 'grow' }, ev._label ?? info?.label ?? LABELS[ev.type] ?? ev.type),
              expert && !ev._photos ? [
                button('▲', () => (i > 0 && ([work[i - 1], work[i]] = [work[i], work[i - 1]]), draw()), { cls: 'small', aria: 'Move up' }),
                button('▼', () => (i < work.length - 1 && ([work[i + 1], work[i]] = [work[i], work[i + 1]]), draw()), { cls: 'small', aria: 'Move down' }),
                button('✕', () => (work.splice(i, 1), draw()), { cls: 'small', aria: 'Remove' }),
              ] : null),
            params.length && !ev._photos ? h('div', { class: 'cd-hparams' }, params) : null,
          ),
        );
      });
      const add = expert
        ? h('div', { class: 'field-row' }, h('span', { class: 'flbl' }, 'Add:'), selectField('', [['', 'Add an event…'], ...types.filter((t) => tid(t) !== 'shoot').map((t) => [tid(t), t.label] as [string, string])], (v) => {
            if (!v) return;
            const info = types.find((t) => tid(t) === v);
            const ev: ScenarioEvent = { type: v };
            for (const p of info?.params ?? []) ev[p.id] = p.default;
            work.push(ev);
            draw();
          }, { label: 'Add an event', width: 220 }))
        : h('div', { class: 'hint' }, 'Turn on expert mode (editor ▸ Edit) to change, reorder and add events.');
      mount(box, h('div', null, 'Everything that happened to the card, in order. The engine replays it on a fresh card.'), rows, add);
    };
    draw();
    dialog98({
      id: 'cardhist',
      title: 'Camera History',
      icon: 'camera',
      body: box,
      width: 440,
      height: 380,
      owner: this.win,
      buttons: expert
        ? [
            {
              label: 'OK',
              primary: true,
              run: () => {
                const old = this.events;
                this.events = work;
                void this.simulate('Replaying…').then((ok) => {
                  if (!ok) this.events = old;
                });
              },
            },
            { label: 'Cancel', cancel: true },
          ]
        : [{ label: 'Close', primary: true, cancel: true }],
    });
  }

  // ------------------------------------------------------------ Cluster Map

  private openMap() {
    if (!this.card) return;
    const existing = getWin('cardmap');
    if (existing) return existing.focus();
    openWindow({ id: 'cardmap', title: 'Cluster Map - Removable Disk (E:)', short: 'Map', icon: 'grid', body: h('div', { class: 'cd-map' }), width: 520, height: 360, minWidth: 260, minHeight: 200, status: [h('div', { class: 'grow' }, '')], onResize: () => this.renderMap() });
    this.renderMap();
  }

  private renderMap() {
    const w = getWin('cardmap');
    if (!w) return;
    if (!this.card) return w.close();
    const info = this.card.info;
    const holder = w.body;
    const width = Math.max(200, (holder.clientWidth || 500) - 24);
    const { canvas, per } = this.clusterMap(width);
    const legend = h('div', { class: 'cd-legend' }, STATE_NAMES.map((n, i) => h('span', { class: 'cd-leg' }, swatch98(STATE_COLORS[i]), n)));
    mount(
      holder,
      h('div', { class: 'cd-maptop' }, h('span', { class: 'grow' }, `${(info.fs ?? '').toUpperCase()} · ${fmtBytes(info.size_bytes ?? 0)} · ${info.cluster_count?.toLocaleString('en-US') ?? '?'} clusters of ${fmtBytes(info.cluster_bytes ?? 0)}`), selectField(this.colorBy, [['state', 'Colour by state'], ['photo', 'Colour by photo']], (v) => ((this.colorBy = v as 'state' | 'photo'), this.renderMap()), { label: 'Colour by' })),
      h('div', { class: 'cd-mapbox' }, canvas),
      legend,
    );
    w.setStatus([`Each cell is ${per} cluster${per > 1 ? 's' : ''}.`]);
  }

  private clusterMap(widthPx: number): { canvas: HTMLCanvasElement; per: number } {
    const { map, owner } = this.card!;
    const n = map.length;
    const cell = n > 20000 ? 2 : n > 4000 ? 3 : 4;
    const cols = Math.max(16, Math.floor(widthPx / cell));
    const per = Math.max(1, Math.ceil(n / (cols * 60)));
    const cells = Math.ceil(n / per);
    const rows = Math.ceil(cells / cols);
    const c = h('canvas', { class: 'clustermap', width: cols * cell, height: rows * cell, role: 'img', 'aria-label': `Cluster map: ${n} clusters` });
    c.style.width = cols * cell + 'px';
    c.style.height = rows * cell + 'px';
    const x = c.getContext('2d')!;
    const img = x.createImageData(c.width, c.height);
    const prio = [0, 1, 2, 3, 6, 7, 4, 5];
    for (let i = 0; i < cells; i++) {
      // the most "interesting" state wins when one cell covers several clusters
      let st = 0;
      let own = -1;
      for (let j = i * per; j < Math.min(n, (i + 1) * per); j++) {
        if (prio[map[j]] > prio[st]) st = map[j];
        if (owner[j] >= 0) own = owner[j];
      }
      let col = STATE_COLORS[st] ?? '#000000';
      if (this.colorBy === 'photo' && own >= 0) col = `hsl(${(own * 67) % 360} 70% 55%)`;
      const rgb = cssToRgb(col);
      const cx = (i % cols) * cell;
      const cy = Math.floor(i / cols) * cell;
      for (let yy = 0; yy < cell - (cell > 2 ? 1 : 0); yy++)
        for (let xx = 0; xx < cell - (cell > 2 ? 1 : 0); xx++) {
          const p = ((cy + yy) * c.width + cx + xx) * 4;
          img.data[p] = rgb[0];
          img.data[p + 1] = rgb[1];
          img.data[p + 2] = rgb[2];
          img.data[p + 3] = 255;
        }
    }
    ditherBayer(img.data, c.width, c.height, 30);
    x.putImageData(img, 0, 0);
    return { canvas: c, per };
  }

  // ------------------------------------------------------------ saving

  private zip() {
    const files = (this.carved ?? []).map((f) => ({ name: 'Rebuilt/' + f.name, data: this.recovered.get(f.index) ?? new Uint8Array() }));
    download(zipStore(files), 'Rebuilt.zip', 'application/zip');
    bus.emit('exported');
  }

  private async sheetPng() {
    const files = this.carved ?? [];
    const c = await contactSheet(files.map((f) => ({ name: f.name, bytes: this.recovered.get(f.index) ?? new Uint8Array() })));
    download(await canvasToPng(c), 'rebuilt_contact_sheet.png', 'image/png');
  }

  private async downloadImg() {
    if (!this.card) return;
    const eng = engine();
    let stop = false;
    const size = await eng.cardImageSize(this.card.handle).promise.catch(() => 0);
    if (size > 1024 * 1024 * 1024 && !(await confirmBox('Big download', `This card image is ${fmtBytes(size)}. Your browser has to hold all of it before saving, which may fail on this device. A smaller card (512 MB or less) is easier. Save it anyway?`, 'Save anyway', 'card'))) return;
    const prog = progressDialog('Saving the card image', { onCancel: () => (stop = true) });
    try {
      const parts: BlobPart[] = [];
      const CH = 4 * 1024 * 1024;
      for (let off = 0; off < size && !stop; off += CH) {
        prog.set(off / size, `Reading sector ${Math.floor(off / 512).toLocaleString('en-US')}…`);
        parts.push((await eng.cardImageChunk(this.card.handle, off, Math.min(CH, size - off)).promise) as BlobPart);
      }
      if (!stop) download(new Blob(parts, { type: 'application/octet-stream' }), 'card_E.img');
    } catch (e) {
      if (!isCancel(e)) errorBox(String((e as Error).message ?? e));
    } finally {
      progressDone(prog);
    }
  }
}

/** The engine's file record also says what kind of file it is (photo, thm, video, junk, dir). */
function kindOf(f: CardInfo['files'][number]): string {
  return (f as CardInfo['files'][number] & { kind?: string }).kind ?? (f.photo_index >= 0 ? 'photo' : 'file');
}

function eventLabel(e: ScenarioEvent): string {
  return e._label ?? LABELS[e.type] ?? e.type;
}

function typeName(kind: string, ext: string): string {
  if (kind === 'photo') return 'JPEG Image';
  if (kind === 'thm') return 'Thumbnail';
  if (kind === 'video') return 'Video Clip';
  if (ext === 'CHK') return 'Recovered Fragment';
  if (ext === 'DB') return 'Data Base File';
  return ext ? ext + ' File' : 'File';
}

/** 98 shows drive sizes as "30.5MB". */
function mb(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1073741824).toFixed(2) + 'GB';
  if (n >= 1024 * 1024) return (n / 1048576).toFixed(1) + 'MB';
  return Math.round(n / 1024) + 'KB';
}

function cssToRgb(css: string): [number, number, number] {
  const c = document.createElement('canvas').getContext('2d')!;
  c.fillStyle = css;
  const v = c.fillStyle as string;
  if (v.startsWith('#')) {
    const n = parseInt(v.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = v.match(/\d+/g) ?? ['0', '0', '0'];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}
