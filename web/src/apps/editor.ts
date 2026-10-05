// "File Refragmenter Editor": before/after preview, simple mode (story presets + "How bad?") and expert mode (the
// step stack), overlays, decoder personality, three-way compare, export shortcuts.
import { h, mount, setText, fmtBytes, pickFiles } from '../ui/dom';
import { iconImg } from '../ui/art';
import { button, selectField, slider, tabs, toolButton } from '../ui/controls';
import { openWindow, getWin, type Win } from '../ui/wm';
import { ui } from '../ui/scale';
import { Viewer, toCanvas, paintCanvas, type Pane } from '../ui/viewer';
import { sizeNote } from '../ui/compare';
import { registerContext } from '../ui/contextmenu';
import { setWallpaperImage } from '../shell/wallpaper';
import { store } from '../state';
import { pipeline, type PipelineResult } from '../pipeline';
import { settings, setSettings } from '../settings';
import { PRESETS, presetAvailability, type Preset } from '../presets';
import { StackView } from '../editor/stackview';
import { link } from '../editor/link';
import { engine, NotAvailableError } from '../engine/client';
import { newSeed, hashBytes } from '../engine/hash';
import { replaceNode, rebasePatch, findNode, type StackNode, type StepItem } from '../engine/stack';
import type { ParamInfo, Inspection, DecodeEvent, DecodedImage } from '../engine/types';
import { importFiles, useSample, ensureSamples } from '../importflow';
import { foldy } from '../foldy/foldy';
import { explainEvents } from '../foldy/lines';
import { openApp } from './registry';
import { message } from '../ui/dialog';
import type { MenuItem } from '../ui/menu';
import * as bus from '../bus';

let ed: Editor | null = null;

export function open(arg?: { preset?: string; photo?: string; expert?: boolean }) {
  if (!ed || !getWin('editor')) ed = new Editor();
  ed.win.focus();
  if (arg?.photo) store.update((d) => void (d.current = arg.photo!), 'photos');
  if (arg?.preset) ed.choosePreset(arg.preset);
  if (arg?.expert) ed.setTab(1);
}

export function currentEditor(): Editor | null {
  return ed && getWin('editor') ? ed : null;
}

class Editor {
  win: Win;
  viewer = new Viewer();
  private side: HTMLElement;
  private body: HTMLElement;
  private panel: HTMLElement;
  private tabBar: HTMLElement;
  private tab = settings.expert ? 1 : 0;
  private stackView: StackView;
  private zoomLabel = h('span', { class: 'muted ed-zoom' }, '100%');
  private statusMain = h('div', { class: 'grow' }, '');
  private statusSize = h('div', null, '');
  private statusEngine = h('div', null, '');
  private emptyCard: HTMLElement | null = null;
  private preset: Preset | null = null;
  private bad = 0.5;
  private presetSeed = newSeed();
  private viewMode: 'single' | 'split' | 'three' = 'split';
  private heatOn = false;
  private thirdPersonality: 'libjpeg' | 'browser' | 'gdiplus' = 'gdiplus';
  private maskTarget: { uid: string; param: string } | null = null;
  private inspectCache: { key: string; info: Inspection } | null = null;
  private toolbar: HTMLElement;
  private unsub: (() => void)[] = [];
  private lastHeavy = '';
  private selfUpdate = false;
  private busy = false;
  private working = false;
  private workingEl: HTMLElement | null = null;
  private statusKey = '';
  // the preview's image canvases live as long as the editor: a new result is painted into them, never into new
  // elements, and the last good frame stays until the next one is ready
  private cBefore = document.createElement('canvas');
  private cAfter = document.createElement('canvas');
  private cBrowser = document.createElement('canvas');
  private cOther = document.createElement('canvas');
  private shownBefore: DecodedImage | null = null;
  private shownAfter: DecodedImage | null = null;
  private browserPane: Pane = { label: 'Your browser', img: null, w: 1, h: 1 };
  private otherPane: Pane = { label: 'Other decoder', img: null, w: 1, h: 1 };
  private threeFor: Uint8Array | null = null;
  private threePers = '';
  private threeSeq = 0;

  constructor() {
    this.stackView = new StackView({
      catalog: () => pipeline.catalog,
      get: () => store.doc.stack,
      set: (nodes, merge, why) => store.update((d) => void (d.stack = nodes), why ?? 'stack', merge ?? null),
      results: () => pipeline.last?.results ?? null,
      pool: () => store.pool().filter((p) => p.uid !== store.doc.current).map((p) => ({ uid: p.uid, name: p.name })),
      onExplain: (info) => foldy.help(info.help || `${info.label}: no explanation yet.`),
      onMask: (node, param) => this.toggleMask(node, param),
      onDelete: (node, label) => store.binStep(node, label),
      onRebasePatch: (node) => this.rebase(node),
      maskEditing: () => (this.maskTarget ? this.maskTarget.uid + ':' + this.maskTarget.param : null),
      maskEraser: (on) => (on === undefined ? this.viewer.maskErase : (this.viewer.maskErase = on)),
    });
    this.toolbar = this.buildToolbar();
    this.tabBar = h('div');
    this.panel = h('div', { class: 'ed-panel' });
    this.side = h('div', { class: 'ed-side' }, this.tabBar, this.panel);
    const main = h('div', { class: 'ed-main' }, this.toolbar, this.viewer.el);
    const body = h('div', { class: 'editor' + (this.tab === 1 ? ' expert' : '') }, main, this.side);
    this.body = body;
    const d = { w: ui.w, h: ui.h - 30 };
    // big screens get a bigger editor: more room for the photo and readable step names
    const W = Math.min(d.w >= 1600 ? 1400 : 1060, d.w - 120);
    this.win = openWindow({
      id: 'editor',
      title: 'File Refragmenter 98 Gold',
      short: 'Editor',
      icon: 'editor',
      body,
      width: W,
      height: Math.min(d.h >= 900 ? 880 : 660, d.h - 30),
      x: Math.min(110, Math.max(0, d.w - W)),
      y: 8,
      status: [this.statusMain, this.statusSize, this.statusEngine],
      menu: [
        { label: '&File', items: () => this.fileMenu() },
        { label: '&Edit', items: () => this.editMenu() },
        { label: '&View', items: () => this.viewMenu() },
        { label: '&Help', items: () => [{ label: '&Help Topics', icon: 'help', onClick: () => openApp('help') }, { label: '&Why does it look like that?', onClick: () => this.explain() }, { sep: true }, { label: '&About File Refragmenter', onClick: () => openApp('about') }] },
      ],
      onClose: () => {
        for (const u of this.unsub) u();
        ed = null;
        bus.emit('mode-changed', 'closed');
      },
      onResize: () => this.viewer.render(),
    });
    this.bindDrop(body);
    this.viewer.onZoom = (z) => setText(this.zoomLabel, `${Math.round(z * 100)}%`);
    this.viewer.onPick = (x, y) => void this.pickBlock(x, y);
    this.viewer.onMask = (m) => this.commitMask(m);
    this.unsub.push(
      pipeline.on((r, phase) => this.onResult(r, phase)),
      store.on((why) => {
        if (why === 'bin' || this.selfUpdate) return;
        if (why === 'undo' || why === 'redo' || why === 'load') this.preset = null;
        this.renderPanel();
        this.updateEmpty();
      }),
      link.on(() => {
        this.viewer.highlights = [...link.highlights, ...(link.picked ? [link.picked.rect] : [])];
        this.viewer.render();
      }),
      bus.on('explain-image', () => this.explain()),
      registerContext('.editor .viewer', () => this.imageMenu()),
    );
    this.renderTabs();
    this.renderPanel();
    this.updateEmpty();
    if (pipeline.last) this.onResult(pipeline.last, 'done');
    void ensureSamples();
  }

  // ------------------------------------------------------------------ toolbar & menus

  private buildToolbar(): HTMLElement {
    const sep = () => h('span', { class: 'tsep', 'aria-hidden': 'true' });
    const openB = toolButton(iconImg('folder', 16), 'Open photos', () => void this.openFiles(), { text: ui.phone ? '' : 'Open' });
    const undo = toolButton(iconImg('undo', 16), 'Undo (Ctrl+Z)', () => store.undo());
    const redo = toolButton(iconImg('redo', 16), 'Redo (Ctrl+Y)', () => store.redo());
    const zout = toolButton(h('span', { class: 'b' }, '−'), 'Zoom out', () => this.viewer.stepZoom(-1));
    const fit = toolButton(h('span', null, 'Fit'), 'Fit to window', () => this.viewer.setZoom(1, true));
    const one = toolButton(h('span', null, '1:1'), 'Actual pixels (1:1 pixel peep)', () => this.viewer.setZoom(1, false));
    const zin = toolButton(h('span', { class: 'b' }, '+'), 'Zoom in', () => this.viewer.stepZoom(1));
    const split = toolButton(iconImg('split', 16), 'Before/after split', () => {
      this.viewMode = this.viewMode === 'split' ? 'single' : 'split';
      this.refreshPanes();
      split.classList.toggle('on', this.viewMode === 'split');
      split.setAttribute('aria-pressed', String(this.viewMode === 'split'));
    }, { pressed: this.viewMode === 'split' });
    const grid = toolButton(iconImg('grid', 16), 'Block grid (off / 8×8 / 16×16)', () => {
      this.viewer.grid = this.viewer.grid === 0 ? 8 : this.viewer.grid === 8 ? 16 : 0;
      grid.classList.toggle('on', this.viewer.grid > 0);
      grid.setAttribute('aria-pressed', String(this.viewer.grid > 0));
      setText(gridLbl, this.viewer.grid ? `${this.viewer.grid}` : '');
      this.viewer.render();
    }, { pressed: this.viewer.grid > 0 });
    const gridLbl = h('span', null, this.viewer.grid ? `${this.viewer.grid}` : '');
    grid.append(gridLbl);
    const heat = toolButton(iconImg('heat', 16), 'Coefficient heatmap', () => void this.toggleHeat(), { pressed: this.heatOn });
    const export_ = button(ui.phone ? '' : 'Export…',() => openApp('export'), { cls: 'primary small', icon: iconImg('export', 16) });
    const expertBits = settings.expert
      ? [
          sep(),
          toolButton(h('span', null, '3-way'), 'Compare: ours | browser | other decoder', () => {
            this.viewMode = this.viewMode === 'three' ? 'split' : 'three';
            this.refreshPanes();
            this.rebuildToolbar();
          }, { pressed: this.viewMode === 'three' }),
          selectField(settings.personality, [['libjpeg', 'Decoder: libjpeg'], ['browser', 'Decoder: browser'], ['gdiplus', 'Decoder: GDI+']], (v) => setSettings({ personality: v as any }), { label: 'Decoder personality' }),
          toolButton(iconImg('hex', 16), 'Open Hex Doctor', () => openApp('hex')),
        ]
      : [];
    for (const el of [zout, zin, this.zoomLabel]) el.classList.add('ph-hide');
    export_.setAttribute('aria-label', 'Export');
    export_.dataset.tip = 'Export';
    return h('div', { class: 'ed-toolbar', role: 'toolbar', 'aria-label': 'Editor tools' }, openB, sep(), undo, redo, sep(), zout, fit, one, zin, this.zoomLabel, sep(), split, grid, heat, ...expertBits, h('span', { class: 'grow' }), export_);
  }

  private rebuildToolbar() {
    const t = this.buildToolbar();
    this.toolbar.replaceWith(t);
    this.toolbar = t;
  }

  private fileMenu() {
    return [
      { label: '&Open Photos…', icon: 'folder', acc: 'Ctrl+O', onClick: () => void this.openFiles() },
      { label: 'Try a &Sample Photo', icon: 'pictures', onClick: () => void useSample() },
      { label: 'Open Pro&ject or Recipe…', icon: 'project', onClick: async () => importFiles(await pickFiles('.rfg,.jpegit,.zip,.json,application/json', false)) },
      { sep: true },
      { label: 'Save &As…', icon: 'export', onClick: () => openApp('export') },
      { label: 'Save &Project (.rfg)', icon: 'project', onClick: () => void import('../shell/shell').then((m) => m.saveProject()) },
      { sep: true },
      { label: '&My Pictures', icon: 'pictures', onClick: () => openApp('pictures') },
      { sep: true },
      { label: '&Close', onClick: () => this.win.close() },
    ];
  }

  private editMenu() {
    return [
      { label: '&Undo', icon: 'undo', acc: 'Ctrl+Z', disabled: !store.history.canUndo, onClick: () => store.undo() },
      { label: '&Redo', icon: 'redo', acc: 'Ctrl+Y', disabled: !store.history.canRedo, onClick: () => store.redo() },
      { sep: true },
      { label: '&Clear All Steps', disabled: !store.doc.stack.length, onClick: () => this.clearSteps() },
      { label: 'Re-roll Every &Seed', icon: 'dice', onClick: () => this.rerollAll() },
      { sep: true },
      { label: '&Expert Mode', checked: settings.expert, onClick: () => this.setExpert(!settings.expert) },
    ];
  }

  private viewMenu(): MenuItem[] {
    const v = this.viewer;
    const zoom = (label: string, z: number): MenuItem => ({ label, radio: true, checked: !v.fit && Math.abs(v.zoom - z) < 1e-6, onClick: () => v.setZoom(z) });
    const cmp = (label: string, m: 'single' | 'split' | 'three'): MenuItem => ({ label, radio: true, checked: this.viewMode === m, onClick: () => this.setViewMode(m) });
    const grid = (label: string, g: 0 | 8 | 16): MenuItem => ({ label, radio: true, checked: v.grid === g, onClick: () => ((v.grid = g), v.render(), this.rebuildToolbar()) });
    return [
      { label: '&Zoom', sub: () => [{ label: '&Fit to Window', radio: true, checked: v.fit, onClick: () => v.setZoom(1, true) }, zoom('&Actual Pixels (1:1)', 1), zoom('&200%', 2), zoom('&400%', 4), zoom('&800%', 8)] },
      { sep: true },
      cmp('&Single Picture', 'single'),
      cmp('&Before/After Split', 'split'),
      cmp('&Three-way Compare', 'three'),
      { sep: true },
      grid('&No Grid', 0),
      grid('Grid &8×8', 8),
      grid('Grid &16×16', 16),
      { sep: true },
      { label: 'Coefficient &Heatmap', checked: this.heatOn, onClick: () => void this.toggleHeat() },
      { label: '&Missing Blocks', sub: this.fillMenu() },
    ];
  }

  setViewMode(m: 'single' | 'split' | 'three') {
    this.viewMode = m;
    this.refreshPanes();
    this.rebuildToolbar();
  }

  /** Right-click on the picture: Copy, Save As…, Zoom ▸, Compare ▸, Set as Wallpaper. */
  private imageMenu(): MenuItem[] | null {
    const r = pipeline.last;
    if (!store.current || !r) return null; // the empty "Drop a photo here" card: the window's own menu
    const v = this.viewer;
    const zoom = (label: string, z: number): MenuItem => ({ label, radio: true, checked: !v.fit && Math.abs(v.zoom - z) < 1e-6, onClick: () => v.setZoom(z) });
    const cmp = (label: string, m: 'single' | 'split' | 'three'): MenuItem => ({ label, radio: true, checked: this.viewMode === m, onClick: () => this.setViewMode(m) });
    return [
      { label: '&Copy', disabled: !r.after, onClick: () => void this.copyImage() },
      { label: 'Save &As…', icon: 'export', onClick: () => openApp('export') },
      { sep: true },
      { label: '&Zoom', sub: () => [{ label: '&Fit to window', radio: true, checked: v.fit, onClick: () => v.setZoom(1, true) }, zoom('&1:1 (actual pixels)', 1), zoom('&200%', 2), zoom('&400%', 4), zoom('&800%', 8)] },
      { label: 'Co&mpare', sub: () => [cmp('&Before/after split', 'split'), cmp('&Three-way', 'three'), cmp('&Off', 'single')] },
      { sep: true },
      { label: 'Set as &Wallpaper', disabled: !r.after, onClick: () => this.setAsWallpaper() },
    ];
  }

  private async copyImage() {
    const a = pipeline.last?.after;
    if (!a) return;
    const CI = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    const fail = () =>
      message('Copy', 'This browser doesn’t let a web page put pictures on the clipboard. Use Export… to save the picture instead.', 'info', [
        { label: 'Export…', run: () => openApp('export') },
        { label: 'OK', primary: true },
      ]);
    if (!CI || !navigator.clipboard?.write) return void fail();
    const c = toCanvas(a);
    try {
      // the PNG is a promise so the clipboard write still counts as part of the click (Safari)
      const png = new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no PNG'))), 'image/png'));
      await navigator.clipboard.write([new CI({ 'image/png': png })]);
      setText(this.statusMain, 'Copied the picture to the clipboard.');
      this.statusKey = '';
    } catch {
      fail();
    }
  }

  private setAsWallpaper() {
    const a = pipeline.last?.after;
    if (!a) return;
    setWallpaperImage(toCanvas(a));
    setText(this.statusMain, 'The picture is now your desktop wallpaper.');
    this.statusKey = '';
  }

  /** How the preview decoder fills blocks the data never reached (truncated or lost parts). */
  private fillMenu(): MenuItem[] {
    const f = settings.fill ?? 'grey';
    const donor = pipeline.fillDonorUid(store.doc.current);
    const others = store.pool().filter((p) => p.uid !== store.doc.current);
    return [
      { label: 'Plain &Grey (most viewers)', radio: true, checked: f === 'grey', onClick: () => setSettings({ fill: 'grey' }) },
      { label: '&Repeat the Last Row', radio: true, checked: f === 'repeat', onClick: () => setSettings({ fill: 'repeat' }) },
      { label: '&Black', radio: true, checked: f === 'black', onClick: () => setSettings({ fill: 'black' }) },
      { label: '&Another Photo Shows Through', radio: true, checked: f === 'donor', disabled: !others.length, onClick: () => setSettings({ fill: 'donor' }) },
      ...(others.length ? [{ sep: true }, { head: 'Photo that shows through' }] : []),
      ...others.map((p) => ({ label: p.name, radio: true, checked: f === 'donor' && p.uid === donor, onClick: () => setSettings({ fill: 'donor', fillDonor: p.uid }) })),
    ];
  }

  private async openFiles() {
    const files = await pickFiles('image/*,.jpg,.jpeg,.rfg,.jpegit,.json,.avi');
    await importFiles(files);
  }

  private clearSteps() {
    for (const n of store.doc.stack) store.binStep(n, 'step');
    store.update((d) => void (d.stack = []), 'stack');
    this.preset = null;
  }

  private rerollAll() {
    store.update((d) => {
      d.stack = d.stack.map((n) => (n.type === 'step' || n.type === 'repeat' ? { ...n, seed: newSeed() } : n));
    }, 'stack');
  }

  setExpert(on: boolean) {
    setSettings({ expert: on });
    this.setTab(on ? 1 : 0);
  }

  setTab(i: number) {
    const changed = i !== this.tab;
    this.tab = i;
    if (i === 1 && !settings.expert) setSettings({ expert: true });
    this.rebuildToolbar();
    this.renderTabs();
    this.renderPanel();
    this.body.classList.toggle('expert', i === 1);
    if (changed) bus.emit('mode-changed', i === 1 ? 'expert' : 'simple');
  }

  private renderTabs() {
    const t = tabs(['Simple', 'Expert'], this.tab, (i) => this.setTab(i));
    const hadFocus = this.tabBar.contains(document.activeElement);
    this.tabBar.replaceWith(t);
    this.tabBar = t;
    if (hadFocus) (t.querySelector('.tab.on') as HTMLElement | null)?.focus();
  }

  // ------------------------------------------------------------------ panels

  private renderPanel() {
    if (this.tab === 1) {
      if (!this.panel.contains(this.stackView.el)) mount(this.panel, this.stackView.el, this.expertExtras());
      this.stackView.render();
      return;
    }
    const st = this.panel.scrollTop;
    mount(this.panel, this.simplePanel());
    this.panel.scrollTop = st;
  }

  private expertExtras(): HTMLElement {
    return h(
      'div',
      { class: 'col', style: { marginTop: '10px' } },
      h('div', { class: 'sep' }),
      h('div', { class: 'hint' }, 'Steps run top to bottom. Byte steps damage the file itself; pixel and coefficient steps decode and re-encode it.'),
      h('div', { class: 'row wrap' }, button('Back to simple mode', () => this.setTab(0), { cls: 'small' }), button('Hex Doctor', () => openApp('hex'), { cls: 'small', icon: iconImg('hex', 16) })),
    );
  }

  private simplePanel(): HTMLElement {
    const cat = pipeline.catalog;
    const grid = h('div', { class: 'story', role: 'radiogroup', 'aria-label': 'What happened to this photo?' });
    for (const p of PRESETS) {
      const av = presetAvailability(p, cat);
      const b = h(
        'button',
        { class: 'story-btn' + (this.preset?.id === p.id ? ' on' : '') + (av === 'none' ? ' na' : ''), role: 'radio', 'aria-checked': String(this.preset?.id === p.id), 'data-tip': p.story + (av === 'none' ? ' (not available in the engine yet)' : av === 'partial' ? ' (partly available)' : '') },
        iconImg(p.icon, 32),
        h('span', { class: 'grow' }, p.title),
      );
      b.onclick = () => this.choosePreset(p.id);
      grid.append(b);
    }
    const parts: HTMLElement[] = [];
    if (this.preset) {
      const p = this.preset;
      const av = presetAvailability(p, cat);
      const s = slider(Math.round(this.bad * 100), 0, 100, 1, (v) => {
        this.bad = v / 100;
        this.applyPreset('bad');
      }, { label: 'How bad?' });
      s.style.width = '100%';
      parts.push(
        h('div', { class: 'row' }, iconImg(p.icon, 32), h('div', { class: 'grow' }, h('div', { class: 'b' }, p.title), h('div', null, p.story))),
        av !== 'full' ? h('div', { class: 'warn' }, av === 'none' ? 'The engine can’t do this one yet; nothing happens for now.' : 'Some of its steps are not in the engine yet and are skipped.') : null as any,
        h('div', { class: 'b', style: { marginTop: '6px' } }, 'How bad?'),
        s,
        h('div', { class: 'row' }, h('span', { class: 'muted grow' }, p.scale[0]), h('span', { class: 'muted' }, p.scale[1])),
        h(
          'div',
          { class: 'row wrap', style: { marginTop: '6px' } },
          button('Another roll', () => {
            this.presetSeed = newSeed();
            this.applyPreset('roll');
          }, { cls: 'small', icon: iconImg('dice', 16), title: 'Same damage, different random details' }),
          button('Show me how', () => this.setTab(1), { cls: 'small', title: 'Open these steps in expert mode' }),
          button('Explain', () => foldy.help(p.foldy, [{ label: 'What exactly went wrong?', run: () => this.explain() }]), { cls: 'small' }),
        ),
        p.needsPool && store.pool().length < 2 ? h('div', { class: 'hint' }, 'This one borrows bytes from another photo in My Pictures. Add a second photo for the full effect.') : null as any,
        h('div', { class: 'row wrap', style: { marginTop: '4px' } }, button('Export…', () => openApp('export'), { cls: 'primary', icon: iconImg('export', 16) }), button('Start over', () => this.startOver(), { cls: 'small' })),
        h('div', { class: 'sep' }),
        h('h2', null, 'Something else happened?'),
      );
    } else {
      if (store.doc.stack.length) parts.push(h('div', { class: 'hint' }, `This photo has ${store.doc.stack.length} step(s) from expert mode.`), h('div', { class: 'row' }, button('Show steps', () => this.setTab(1), { cls: 'small' }), button('Start over', () => this.startOver(), { cls: 'small' })), h('div', { class: 'sep' }));
      parts.push(h('h2', null, 'What happened to this photo?'));
    }
    parts.push(grid);
    return h('div', { class: 'col' }, ...parts.filter(Boolean));
  }

  private startOver() {
    this.preset = null;
    store.update((d) => void (d.stack = []), 'stack');
  }

  choosePreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    this.preset = p;
    this.presetSeed = newSeed();
    this.applyPreset(null);
    this.panel.scrollTop = 0;
    bus.emit('preset-chosen', p);
    if (this.tab !== 0) this.stackView.render();
  }

  private applyPreset(merge: string | null) {
    if (!this.preset) return;
    const nodes = this.preset.build({ catalog: pipeline.catalog, profiles: pipeline.caps?.profiles ?? [], bad: this.bad, seed: this.presetSeed });
    this.selfUpdate = merge === 'bad';
    store.update((d) => void (d.stack = nodes), 'stack', merge);
    this.selfUpdate = false;
  }

  // ------------------------------------------------------------------ results

  private onResult(r: PipelineResult | null, phase: 'start' | 'step' | 'done' | 'error') {
    if (phase === 'start' || phase === 'step') {
      const pr = pipeline.progress;
      if (pr.n > 1 && performance.now() - pipeline.startedAt > 400) {
        const text = `Working… step ${pr.i + 1} of ${pr.n}: ${pr.label}`;
        if (!this.working) {
          this.working = true;
          this.workingEl = h('div', { class: 'grow' }, text);
          this.win.setStatus([this.workingEl, this.statusSize, this.statusEngine]);
        } else if (this.workingEl) setText(this.workingEl, text);
      }
      // busy shows only over the picture, and only after 500 ms (the working-in-background cursor); nothing is
      // painted. A superseded run never reports 'done', so the viewer holds at most one busy mark.
      if (phase === 'start' && !this.busy) {
        this.busy = true;
        this.win.setBusy(true, { scope: this.viewer.el });
      }
      return;
    }
    if (this.busy) {
      this.busy = false;
      this.win.setBusy(false, { scope: this.viewer.el });
    }
    if (this.working) {
      this.working = false;
      this.workingEl = null;
      this.win.setStatus([this.statusMain, this.statusSize, this.statusEngine]);
    }
    if (this.tab === 1) this.stackView.updateStatus();
    if (!r) {
      this.viewer.setPanes([], 'single');
      this.updateEmpty();
      return;
    }
    this.refreshPanes();
    const a = r.after;
    const b = r.before;
    setText(this.statusSize, a ? `${sizeNote(b?.width, b?.height, a.width, a.height)} · ${fmtBytes(r.output.length)}` : fmtBytes(r.output.length));
    const evs = a?.events ?? [];
    const lead = evs.length ? `${evs.length} decode event${evs.length === 1 ? '' : 's'} · ` : r.decodeError ? `Can't display: ${r.decodeError} · ` : 'Decodes cleanly · ';
    // a live preview delivers many results a second: rebuild the status text only when it says something new
    if (lead !== this.statusKey) {
      this.statusKey = lead;
      const why = h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), this.explain()) }, 'Why does it look like that?');
      mount(this.statusMain, lead, why);
    }
    const caps = pipeline.caps;
    const fallback = a?.via === 'browser-fallback';
    setText(this.statusEngine, !caps?.exports.length ? 'Engine: not built yet' : fallback ? 'Preview: browser decoder (ours not ready)' : `Engine: ${caps.catalog.length} steps`);
    const tip = caps?.loadError ?? '';
    if ((this.statusEngine.dataset.tip ?? '') !== tip) this.statusEngine.dataset.tip = tip;
    // heavy damage reaction (once per distinct recipe)
    const heavy = evs.some((e) => e.kind === 'truncated' || e.kind === 'bad_huffman') && evs.length > 3;
    const key = hashBytes(r.output);
    if (heavy && key !== this.lastHeavy) {
      this.lastHeavy = key;
      bus.emit('heavy-damage');
    }
    if (this.heatOn) void this.loadHeat();
  }

  private refreshPanes() {
    const r = pipeline.last;
    if (!r) return;
    // paint into the long-lived canvases, and only when the decoded image really changed
    if (r.after && r.after !== this.shownAfter) paintCanvas(this.cAfter, r.after);
    if (r.before && r.before !== this.shownBefore) paintCanvas(this.cBefore, r.before);
    this.shownAfter = r.after;
    this.shownBefore = r.before;
    const after: Pane = {
      label: 'After',
      img: r.after ? this.cAfter : null,
      w: r.after?.width ?? r.before?.width ?? 1,
      h: r.after?.height ?? r.before?.height ?? 1,
      error: r.after ? undefined : `Even the forgiving decoder can’t show this file (${r.decodeError ?? 'cannot decode'}). Export it anyway, or try a header graft.`,
    };
    const before: Pane = { label: 'Before', img: r.before ? this.cBefore : null, w: r.before?.width ?? after.w, h: r.before?.height ?? after.h };
    if (this.viewMode === 'three') {
      const ours: Pane = { ...after, label: `Ours (${settings.personality})` };
      // the other two panes keep showing their previous pictures until the new decodes are ready
      const browser = this.browserPane;
      const other = this.otherPane;
      if (!browser.img && !browser.error) ((browser.w = after.w), (browser.h = after.h));
      if (!other.img && !other.error) ((other.w = after.w), (other.h = after.h));
      this.viewer.setPanes([ours, browser, other], 'three');
      if (this.threeFor === r.output && this.threePers === settings.personality) return;
      this.threeFor = r.output;
      this.threePers = settings.personality;
      const seq = ++this.threeSeq;
      void (async () => {
        let bmp: ImageBitmap | null = null;
        try {
          bmp = await createImageBitmap(new Blob([r.output as BlobPart], { type: 'image/jpeg' }));
        } catch {
          bmp = null;
        }
        if (seq !== this.threeSeq) return bmp?.close();
        if (bmp) {
          const c = this.cBrowser;
          if (c.width !== bmp.width || c.height !== bmp.height) ((c.width = bmp.width), (c.height = bmp.height));
          const x = c.getContext('2d')!;
          x.clearRect(0, 0, c.width, c.height);
          x.drawImage(bmp, 0, 0);
          Object.assign(browser, { img: c, w: bmp.width, h: bmp.height, error: undefined });
          bmp.close();
        } else Object.assign(browser, { img: null, error: 'Your browser refuses to open this file at all.' });
        const third = settings.personality === this.thirdPersonality ? (settings.personality === 'gdiplus' ? 'browser' : 'gdiplus') : this.thirdPersonality;
        other.label = `Ours as ${third}`;
        let d: DecodedImage | null = null;
        let err = '';
        try {
          d = await engine().decode(r.output, { personality: third }).promise;
        } catch (e) {
          err = e instanceof NotAvailableError ? 'not available yet' : 'cannot decode';
        }
        if (seq !== this.threeSeq) return;
        if (d) Object.assign(other, { img: paintCanvas(this.cOther, d), w: d.width, h: d.height, error: undefined });
        else Object.assign(other, { img: null, error: err });
        if (this.viewMode === 'three') this.viewer.setPanes([ours, browser, other], 'three');
      })();
      return;
    }
    this.threeFor = null;
    if (this.viewMode === 'split' && store.doc.stack.length) this.viewer.setPanes([before, after], 'split');
    else this.viewer.setPanes([after], 'single');
  }

  private updateEmpty() {
    const has = !!store.current;
    this.body.classList.toggle('nophoto', !has);
    if (has) {
      this.emptyCard?.remove();
      this.emptyCard = null;
      return;
    }
    if (this.emptyCard) return;
    const card = h(
      'div',
      { class: 'empty-card' },
      h('h1', { class: 'big' }, 'Drop a photo here'),
      h('div', null, 'JPEG, PNG, WebP… or a whole bunch of them.'),
      button('Choose photo…', () => void this.openFiles(), { cls: 'primary big', icon: iconImg('folder', 16) }),
      button('Try a sample photo', () => void useSample(), { cls: 'big', icon: iconImg('pictures', 16) }),
      h('div', { class: 'hint' }, 'Nothing is uploaded. Your photos never leave this computer.'),
    );
    this.emptyCard = h('div', { class: 'empty' }, card);
    this.viewer.el.append(this.emptyCard);
  }

  private bindDrop(el: HTMLElement) {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.viewer.el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => this.viewer.el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.viewer.el.classList.remove('drop');
      const files = [...(e.dataTransfer?.files ?? [])];
      void importFiles(files);
    });
  }

  // ------------------------------------------------------------------ explain, heatmap, blocks, masks

  explain() {
    const r = pipeline.last;
    if (!r) return foldy.help('Load a photo first: drop one onto the editor, or press "Try a sample photo".');
    if (!r.after) return foldy.help(`Even my forgiving decoder can’t make a picture out of this (${r.decodeError}). The header is probably gone; a header graft can rescue it.`);
    const evs = r.after.events;
    foldy.help(explainEvents(evs), [{ label: 'Show in Hex Doctor', run: () => openApp('hex') }]);
    void this.pointAt(evs);
  }

  /** Foldy points: the blocks where the explained events happened get the yellow frame in the picture. */
  private async pointAt(evs: DecodeEvent[]) {
    const r = pipeline.last;
    const kinds = [...new Set(evs.map((e) => e.kind))].slice(0, 2);
    const spots = kinds.map((k) => evs.find((e) => e.kind === k && (e.x ?? -1) >= 0 && (e.y ?? -1) >= 0)).filter((e): e is DecodeEvent => !!e);
    if (!r || !spots.length) return;
    const g = await this.mcuGeometry(r.output).catch(() => null);
    const mw = g?.mw ?? 8;
    const mh = g?.mh ?? 8;
    link.highlight(spots.map((e) => ({ x: e.x!, y: e.y!, w: mw, h: mh })));
  }

  private async toggleHeat() {
    this.heatOn = !this.heatOn;
    this.rebuildToolbar();
    if (!this.heatOn) {
      this.viewer.setHeat(null);
      return;
    }
    await this.loadHeat();
    if (!this.heatOn) this.rebuildToolbar();
  }

  private async getInspect(bytes: Uint8Array): Promise<Inspection> {
    const key = hashBytes(bytes);
    if (this.inspectCache?.key === key) return this.inspectCache.info;
    const info = await engine().inspect(bytes).promise;
    this.inspectCache = { key, info };
    return info;
  }

  private async loadHeat() {
    const r = pipeline.last;
    if (!r?.after) return;
    try {
      const vals = await engine().coeffHeatmap(r.output, 0, 'energy').promise;
      const info = await this.getInspect(r.output);
      const fr = info.frame;
      let bw = Math.ceil(r.after.width / 8);
      if (fr) {
        const hmax = Math.max(...fr.components.map((c) => c.h));
        bw = Math.ceil(fr.width / (8 * hmax)) * (fr.components[0]?.h ?? 1);
      }
      const bh = Math.max(1, Math.floor(vals.length / bw));
      this.viewer.setHeat({ bw, bh, block: 8, values: vals });
    } catch (e) {
      this.heatOn = false;
      this.viewer.setHeat(null);
      if (e instanceof NotAvailableError) message('Heatmap', 'The coefficient heatmap needs a part of the engine that is not built yet. Try again later.', 'heat');
    }
  }

  private async mcuGeometry(bytes: Uint8Array) {
    const info = await this.getInspect(bytes);
    const fr = info.frame;
    if (!fr) return null;
    const hmax = Math.max(1, ...fr.components.map((c) => c.h));
    const vmax = Math.max(1, ...fr.components.map((c) => c.v));
    const mw = 8 * hmax;
    const mh = 8 * vmax;
    return { mw, mh, cols: Math.ceil(fr.width / mw), rows: Math.ceil(fr.height / mh) };
  }

  private async pickBlock(x: number, y: number) {
    if (this.maskTarget) return;
    const r = pipeline.last;
    if (!r?.after || x < 0 || y < 0 || x >= r.after.width || y >= r.after.height) {
      link.pick(null);
      return;
    }
    const g = await this.mcuGeometry(r.output);
    if (!g) return;
    const cx = Math.floor(x / g.mw);
    const cy = Math.floor(y / g.mh);
    link.pick({ mcu: cy * g.cols + cx, rect: { x: cx * g.mw, y: cy * g.mh, w: g.mw, h: g.mh } });
    if (settings.expert) setText(this.statusMain, `Block ${cx},${cy} (MCU ${cy * g.cols + cx}). ${getWin('hex') ? 'Its bytes are marked yellow in Hex Doctor.' : 'Open Hex Doctor to see its bytes.'}`);
  }

  private toggleMask(node: StepItem, param: ParamInfo) {
    const key = { uid: node.uid, param: param.id };
    if (this.maskTarget && this.maskTarget.uid === key.uid && this.maskTarget.param === key.param) {
      this.maskTarget = null;
      this.viewer.mask = null;
      this.viewer.render();
      this.stackView.render(true);
      return;
    }
    const r = pipeline.last;
    if (!r?.after) return;
    void this.mcuGeometry(r.source).then((g) => {
      const unit = g?.mw ?? 16;
      const w = g?.cols ?? Math.ceil(r.after!.width / unit);
      const hh = g?.rows ?? Math.ceil(r.after!.height / unit);
      const cur = node.params[param.id] as { w: number; h: number; data: number[] } | null;
      const data = new Array(w * hh).fill(0);
      if (cur && Array.isArray(cur.data)) {
        // masks live in MCU coordinates and are clipped to the current grid (Q13)
        for (let yy = 0; yy < Math.min(hh, cur.h); yy++) for (let xx = 0; xx < Math.min(w, cur.w); xx++) data[yy * w + xx] = cur.data[yy * cur.w + xx] ?? 0;
      }
      this.maskTarget = key;
      this.viewer.mask = { w, h: hh, unit, data };
      this.viewer.render();
      this.stackView.render(true);
      this.viewer.maskErase = false;
      foldy.help(ui.phone ? 'Paint over the image with your finger to choose the blocks this step affects. Press "Eraser" to wipe blocks out again, and "Done painting" when finished.' : 'Paint over the image to choose the blocks this step affects. Hold Alt or use the right mouse button (or press "Eraser") to erase. Press "Done painting" when finished.');
    });
  }

  private commitMask(m: { w: number; h: number; data: number[] }) {
    if (!this.maskTarget) return;
    const t = this.maskTarget;
    store.update((d) => {
      d.stack = replaceNode(d.stack, t.uid, (n) => ({ ...(n as StepItem), params: { ...(n as StepItem).params, [t.param]: { w: m.w, h: m.h, data: m.data.slice() } } }));
    }, 'stack', 'mask:' + t.uid);
  }

  private rebase(node: StackNode) {
    const r = pipeline.last;
    if (!r) return;
    const idx = store.doc.stack.findIndex((n) => n.uid === node.uid);
    if (idx < 0) return;
    // the input of this patch is the output of the previous node (or the source)
    void (async () => {
      const prev = store.doc.stack.slice(0, idx);
      const out = await pipeline.runOn(store.current!.uid + '@' + store.photoKey(store.current!.uid), r.source, prev, store.doc.current);
      store.update((d) => {
        d.stack = replaceNode(d.stack, node.uid, (n) => (n.type === 'patch' ? rebasePatch(n, out.output) : n));
      }, 'stack');
    })();
  }

  hasNode(uid: string) {
    return !!findNode(store.doc.stack, uid);
  }
}
