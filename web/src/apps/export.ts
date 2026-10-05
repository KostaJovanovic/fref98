// "Save As": the Windows 98 common dialog (Save in, the file list, File name, Save as type, Save / Cancel /
// Options…) around every export: the broken .jpg, a PNG of the preview, the project (.rfg), the recipe,
// a ZIP of all pictures (batch), GIF / AVI / MP4 animations and contact sheets. Files go to the browser's
// downloads through download(); "My Pictures" keeps a JPEG inside the app instead.
import { h, mount, download } from '../ui/dom';
import { iconImg } from '../ui/art';
import { button, checkbox, numberField, selectField, textField, toolButton } from '../ui/controls';
import { dropdown } from '../ui/dropdown';
import { openWindow, getWin, type Win } from '../ui/wm';
import { store } from '../state';
import { pipeline, type PipelineResult } from '../pipeline';
import { settings, setSettings } from '../settings';
import { engine, NotAvailableError, isCancel } from '../engine/client';
import { insertComment, stripExifFallback } from '../engine/jpegmeta';
import { zipStore } from '../engine/zip';
import { toRecipe, canShareAsLink, linkRecipe, recipeToFragment, APP_VERSION } from '../engine/recipe';
import type { StackNode } from '../engine/stack';
import { contactSheet, canvasToPng, type SheetStyle } from '../contact';
import { canEncodeMp4, encodeMp4 } from '../engine/mp4';
import { errorBox, message, confirmBox, progressDialog, progressDone } from '../ui/dialog';
import { registerContext } from '../ui/contextmenu';
import { dialog98 } from './tools98';
import * as bus from '../bus';

type Kind = 'jpg' | 'png' | 'rfg' | 'json' | 'zip' | 'gif' | 'avi' | 'mp4' | 'sheet';
interface TypeInfo {
  label: string;
  ext: string;
  icon: string;
  suffix: () => string;
  available?: () => boolean;
}

const TYPES: Record<Kind, TypeInfo> = {
  jpg: { label: 'JPEG Image, broken (*.jpg)', ext: 'jpg', icon: 'jpeg', suffix: () => baseName() + '_refrag' },
  png: { label: 'PNG of the Preview (*.png)', ext: 'png', icon: 'pictures', suffix: () => baseName() + '_refrag_preview' },
  rfg: { label: 'Refragmenter Project (*.rfg)', ext: 'rfg', icon: 'project', suffix: () => (store.doc.name || 'Untitled').replace(/[^\w .-]+/g, '_') },
  json: { label: 'Recipe, steps only (*.json)', ext: 'json', icon: 'documents', suffix: () => baseName() + '_recipe' },
  zip: { label: 'ZIP of All Pictures, batch (*.zip)', ext: 'zip', icon: 'project', suffix: () => 'refrag_batch' },
  gif: { label: 'GIF Animation (*.gif)', ext: 'gif', icon: 'video', suffix: () => baseName() + (anim.mode === 'gen' ? '_generations' : '_steps'), available: () => engine().has('encode_gif') },
  avi: { label: 'MJPEG Movie (*.avi)', ext: 'avi', icon: 'video', suffix: () => baseName() + (anim.mode === 'gen' ? '_generations' : '_steps'), available: () => engine().has('avi_write') },
  mp4: { label: 'MP4 Video (*.mp4)', ext: 'mp4', icon: 'video', suffix: () => baseName() + (anim.mode === 'gen' ? '_generations' : '_steps'), available: () => canEncodeMp4() },
  sheet: { label: 'Contact Sheet of My Pictures (*.png)', ext: 'png', icon: 'pictures', suffix: () => 'contact_sheet' },
};
const ORDER: Kind[] = ['jpg', 'png', 'rfg', 'json', 'zip', 'gif', 'avi', 'mp4', 'sheet'];
const TAB_KIND: Kind[] = ['jpg', 'zip', 'gif', 'json'];

type Place = 'downloads' | 'pictures';
const PLACES: [Place, string][] = [
  ['downloads', 'Downloads'],
  ['pictures', 'My Pictures'],
];

// options kept for the session (the Options… dialogs)
const anim = { mode: 'gen' as 'gen' | 'steps', frames: 12, maxDim: 480, fps: 6 };
const batchOpts = { base: 0, skip: new Set<string>() };
let sheetStyle: SheetStyle = 'graft';
/** Names saved to Downloads in this session (the browser doesn't let a page list the real folder). */
const savedNames: { name: string; kind: Kind }[] = [];

let sa: SaveAs | null = null;

export function open(arg?: { tab?: number; kind?: Kind }) {
  const k = arg?.kind ?? (arg?.tab !== undefined ? TAB_KIND[arg.tab] : undefined);
  if (sa && getWin('export')) {
    if (k) sa.setKind(k);
    sa.win.focus();
    return;
  }
  sa = new SaveAs(k ?? 'jpg');
}

function baseName(): string {
  const p = store.current;
  return (p?.name ?? 'photo').replace(/[^\w.-]+/g, '_').replace(/\.(jpe?g|png)$/i, '');
}

class SaveAs {
  win: Win;
  private kind: Kind;
  private place: Place = 'downloads';
  private name: string;
  private nameInput: HTMLInputElement;
  private list = h('div', { class: 'sa-list', role: 'listbox', tabIndex: 0, 'aria-label': 'Files' });
  private placeBox = h('span');
  private typeBox = h('span');
  private optBtn: HTMLButtonElement;
  private detail = false;
  private selName: string | null = null;
  private unreg: (() => void)[] = [];

  constructor(kind: Kind) {
    this.kind = kind;
    this.name = TYPES[kind].suffix();
    const nameField = textField(this.fileName(), (v) => (this.name = v), { label: 'File name' });
    this.nameInput = nameField.querySelector('input')!;
    this.optBtn = button('Options…', () => this.options());
    const save = button('Save', () => void this.save(), { cls: 'default' });
    const cancel = button('Cancel', () => this.win.close());
    const tools = h(
      'span',
      { class: 'sa-tools' },
      toolButton(iconImg('folder', 16), 'Up One Level', () => this.setPlace('downloads')),
      toolButton(iconImg('project', 16), 'Create New Folder', () => message('Save As', 'Your browser keeps downloads in one folder. New folders can be made there with your own file manager.', 'info')),
      toolButton(h('span', { class: 'sa-vlist', 'aria-hidden': 'true' }), 'List', () => ((this.detail = false), this.renderList())),
      toolButton(h('span', { class: 'sa-vdet', 'aria-hidden': 'true' }), 'Details', () => ((this.detail = true), this.renderList())),
    );
    const body = h(
      'div',
      { class: 'sa98' },
      h('div', { class: 'sa-top' }, h('span', { class: 'sa-lbl' }, 'Save ', h('u', null, 'i'), 'n:'), this.placeBox, tools),
      this.list,
      h('div', { class: 'sa-grid' }, h('span', { class: 'sa-lbl' }, 'File ', h('u', null, 'n'), 'ame:'), nameField, save, h('span', { class: 'sa-lbl' }, 'Save as ', h('u', null, 't'), 'ype:'), this.typeBox, cancel, h('span'), h('span'), this.optBtn),
    );
    this.win = openWindow({
      id: 'export',
      title: 'Save As',
      short: 'Save As',
      icon: 'export',
      body,
      width: 452,
      height: 312,
      resizable: false,
      onClose: () => {
        for (const u of this.unreg) u();
        sa = null;
      },
      // Enter is Save (from the file list: save under the picked name)
      enter: (t) => {
        if (t === this.list && this.selName) this.name = this.selName.replace(/\.[^.]+$/, '');
        void this.save();
      },
      esc: () => this.win.close(),
    });
    this.unreg.push(
      registerContext('.sa-list .sa-file', (t) => {
        const f = (t.closest('.sa-file') as HTMLElement).dataset.name ?? '';
        return [
          { label: '&Select', default: true, onClick: () => this.pick(f) },
          { label: 'Save as &This Name', onClick: () => (this.pick(f), void this.save()) },
          { sep: true },
          { label: 'Copy &Name', onClick: () => void navigator.clipboard?.writeText(f).catch(() => {}) },
        ];
      }),
      registerContext('.sa-list', () => [
        { label: '&View', sub: [{ label: '&List', radio: true, checked: !this.detail, onClick: () => ((this.detail = false), this.renderList()) }, { label: '&Details', radio: true, checked: this.detail, onClick: () => ((this.detail = true), this.renderList()) }] },
        { sep: true },
        { label: 'R&efresh', onClick: () => this.renderList() },
        { sep: true },
        { label: '&Up One Level', disabled: this.place === 'downloads', onClick: () => this.setPlace('downloads') },
      ]),
    );
    this.renderCombos();
    this.renderList();
    requestAnimationFrame(() => {
      this.nameInput.focus();
      this.nameInput.select();
    });
  }

  setKind(k: Kind) {
    const prev = TYPES[this.kind];
    // a name the user typed stays; only the default name follows the type
    if (this.name === prev.suffix()) this.name = TYPES[k].suffix();
    this.kind = k;
    this.nameInput.value = this.fileName();
    this.renderCombos();
    this.renderList();
  }

  private setPlace(p: Place) {
    this.place = p;
    this.renderCombos();
    this.renderList();
  }

  private fileName(): string {
    return this.name.replace(/\.[^.\\/]*$/, '') + '.' + TYPES[this.kind].ext;
  }

  private renderCombos() {
    const ps = selectField(this.place, PLACES, (v) => this.setPlace(v as Place), { label: 'Save in', width: 200 });
    ps.classList.add('sa-place');
    mount(this.placeBox, ps);
    const sel = h('select', { 'aria-label': 'Save as type' }, ORDER.map((k) => h('option', { value: k, selected: k === this.kind, disabled: TYPES[k].available ? !TYPES[k].available!() : false }, TYPES[k].label)));
    sel.value = this.kind;
    sel.addEventListener('change', () => this.setKind(sel.value as Kind));
    mount(this.typeBox, dropdown(sel, { width: 248, label: 'Save as type' }));
    this.optBtn.disabled = this.kind === 'png' || this.kind === 'rfg';
  }

  private renderList() {
    const ext = '.' + TYPES[this.kind].ext;
    let files: { name: string; icon: string; size: string; type: string }[] = [];
    if (this.place === 'downloads') {
      files = [{ name: 'My Pictures', icon: 'folder', size: '', type: 'File Folder' }];
      for (const f of savedNames) if (f.name.toLowerCase().endsWith(ext)) files.push({ name: f.name, icon: TYPES[f.kind].icon, size: '', type: TYPES[f.kind].label.replace(/ \(.*/, '') });
    } else if (this.kind === 'jpg') {
      for (const p of store.pool()) {
        const n = p.name.replace(/\.(jpe?g|png)$/i, '') + '.jpg';
        files.push({ name: n, icon: 'jpeg', size: Math.max(1, Math.round(p.bytes.length / 1024)).toLocaleString('en-US') + ' KB', type: 'JPEG Image' });
      }
    }
    this.list.classList.toggle('det', this.detail);
    const rows = files.map((f) =>
      h(
        'div',
        { class: 'sa-file' + (f.name === this.selName ? ' sel' : ''), role: 'option', 'aria-selected': String(f.name === this.selName), dataset: { name: f.name, folder: f.type === 'File Folder' ? '1' : '' }, onclick: () => this.pick(f.name), ondblclick: () => this.open(f.name, f.type === 'File Folder') },
        iconImg(f.icon, 16),
        h('span', { class: 'sa-fn' }, f.name),
        this.detail ? [h('span', { class: 'sa-sz' }, f.size), h('span', { class: 'sa-ty' }, f.type)] : null,
      ),
    );
    if (this.detail) rows.unshift(h('div', { class: 'sa-head' }, h('span', { class: 'sa-fn' }, 'Name'), h('span', { class: 'sa-sz' }, 'Size'), h('span', { class: 'sa-ty' }, 'Type')));
    mount(this.list, rows);
  }

  private pick(name: string) {
    this.selName = name;
    for (const r of this.list.querySelectorAll<HTMLElement>('.sa-file')) {
      const on = r.dataset.name === name;
      r.classList.toggle('sel', on);
      r.setAttribute('aria-selected', String(on));
    }
    if (name === 'My Pictures') return;
    this.name = name.replace(/\.[^.]+$/, '');
    this.nameInput.value = this.fileName();
  }

  private open(name: string, folder: boolean) {
    if (folder) return this.setPlace('pictures');
    this.pick(name);
    void this.save();
  }

  // ------------------------------------------------------------ Save

  private async save() {
    this.name = this.nameInput.value.trim();
    if (!this.name || /[\\/:*?"<>|]/.test(this.name)) {
      message('Save As', this.name ? 'A file name cannot contain any of these characters:\n\\ / : * ? " < > |' : 'Type a file name.', 'warning');
      return;
    }
    const file = this.fileName();
    const kind = this.kind;
    const info = TYPES[kind];
    if (info.available && !info.available()) {
      message('Save As', `${info.label.replace(/ \(.*/, '')} needs a part of the engine (or browser) that isn't available here.`, 'warning');
      return;
    }
    if (this.place === 'pictures' && kind !== 'jpg') {
      message('Save As', `My Pictures holds JPEG pictures only.\nChoose Downloads in the Save in box to save a ${info.label.replace(/ \(.*/, '')}.`, 'warning');
      return;
    }
    // (My Pictures keeps every save as a new picture, so only Downloads can "replace")
    const exists = this.place === 'downloads' && savedNames.some((f) => f.name.toLowerCase() === file.toLowerCase());
    if (exists && !(await confirmBox('Save As', `${file} already exists.\nDo you want to replace it?`, 'Yes', 'warning', 'No'))) return;
    const name = file.replace(/\.[^.]+$/, '');
    const place = this.place;
    this.win.close();
    let ok = false;
    try {
      if (kind === 'jpg') ok = await saveJpg(name, place);
      else if (kind === 'png') ok = await savePng(name);
      else if (kind === 'rfg') ok = await saveRfg(name);
      else if (kind === 'json') ok = saveRecipe(name);
      else if (kind === 'zip') ok = await saveBatch(name);
      else if (kind === 'sheet') ok = await saveSheet(name);
      else ok = await saveAnim(kind, name);
    } catch (e) {
      if (!isCancel(e)) errorBox(String((e as Error).message ?? e));
    }
    if (ok && place === 'downloads' && !savedNames.some((f) => f.name === file)) savedNames.push({ name: file, kind });
  }

  // ------------------------------------------------------------ Options…

  private options() {
    const k = this.kind;
    if (k === 'jpg') return jpegOptions();
    if (k === 'zip') return batchOptions();
    if (k === 'gif' || k === 'avi' || k === 'mp4') return animOptions();
    if (k === 'sheet') return sheetOptions();
    if (k === 'json') return recipeOptions();
  }
}


// ------------------------------------------------------------------ the options dialogs

function jpegOptions() {
  const canShare = typeof (navigator as any).canShare === 'function' && (navigator as any).canShare({ files: [new File([new Uint8Array(1)], 'a.jpg', { type: 'image/jpeg' })] });
  let strip = settings.stripPrivateExif;
  let embed = settings.embedRecipe;
  const body = h(
    'div',
    { class: 'col' },
    h('div', { class: 'group' }, h('div', { class: 'legend' }, 'Privacy'), checkbox('Remove private EXIF (GPS, serial number, owner)', strip, (v) => (strip = v)), checkbox('Embed the recipe in the file (a comment segment)', embed, (v) => (embed = v))),
    h('div', { class: 'hint' }, 'These also apply to the pictures in a batch ZIP.'),
    canShare ? h('div', { class: 'row' }, button('Send To…', () => void share(), { cls: 'small' }), h('span', { class: 'hint' }, 'Share the broken JPEG with another app.')) : null,
  );
  dialog98({ title: 'JPEG Options', icon: 'jpeg', body, width: 360, height: canShare ? 200 : 168, buttons: [{ label: 'OK', primary: true, run: () => setSettings({ stripPrivateExif: strip, embedRecipe: embed }) }, { label: 'Cancel', cancel: true }] });
}

function batchOptions() {
  const pool = store.pool();
  const skip = new Set(batchOpts.skip);
  let base = batchOpts.base;
  const list = h('div', { class: 'list sa-batch' }, pool.map((p) => h('div', { class: 'li' }, checkbox(p.name, !skip.has(p.uid), (v) => (v ? skip.delete(p.uid) : skip.add(p.uid))))));
  const body = h(
    'div',
    { class: 'col' },
    h('div', null, 'Apply the current recipe to these pictures. Picture number n gets seed = base + n, so every one breaks a little differently.'),
    list,
    h('div', { class: 'field-row' }, h('span', { class: 'flbl' }, 'Base seed:'), numberField(base, (v) => (base = v | 0), { min: 0, max: 1e9, label: 'Base seed', width: 100 })),
  );
  dialog98({ title: 'Batch Options', icon: 'project', body, width: 380, height: 320, buttons: [{ label: 'OK', primary: true, run: () => void ((batchOpts.base = base), (batchOpts.skip = skip)) }, { label: 'Cancel', cancel: true }] });
}

function animOptions() {
  const o = { ...anim };
  const row = (label: string, ctl: HTMLElement) => h('div', { class: 'field-row sa-opt' }, h('span', { class: 'flbl' }, label), ctl);
  const body = h(
    'div',
    { class: 'col' },
    h('div', null, 'Animate the damage: every frame is a real re-save of the previous one, or the recipe one step at a time.'),
    row('Frames from:', selectField(o.mode, [['gen', 'Generation loss (recipe again and again)'], ['steps', 'Each step of the recipe']], (v) => (o.mode = v as 'gen' | 'steps'), { label: 'Frames from', width: 230 })),
    row('Generations:', numberField(o.frames, (v) => (o.frames = Math.max(2, Math.min(200, v | 0))), { min: 2, max: 200, label: 'Generations' })),
    row('Max size (px):', numberField(o.maxDim, (v) => (o.maxDim = Math.max(64, Math.min(1920, v | 0))), { min: 64, max: 1920, label: 'Max size' })),
    row('Frames / second:', numberField(o.fps, (v) => (o.fps = Math.max(1, Math.min(30, v | 0))), { min: 1, max: 30, label: 'Frames per second' })),
  );
  dialog98({ title: 'Animation Options', icon: 'video', body, width: 380, height: 236, buttons: [{ label: 'OK', primary: true, run: () => void Object.assign(anim, o) }, { label: 'Cancel', cancel: true }] });
}

function sheetOptions() {
  let style = sheetStyle;
  const body = h('div', { class: 'col' }, h('div', null, 'One PNG with every picture in My Pictures.'), h('div', { class: 'field-row sa-opt' }, h('span', { class: 'flbl' }, 'Style:'), selectField(style, [['graft', 'Recovery tool (8 per row, black)'], ['thumbs', 'Thumbnails view'], ['kodak', 'Kodak-style index print']], (v) => (style = v as SheetStyle), { label: 'Sheet style', width: 220 })));
  dialog98({ title: 'Contact Sheet Options', icon: 'pictures', body, width: 340, height: 150, buttons: [{ label: 'OK', primary: true, run: () => void (sheetStyle = style) }, { label: 'Cancel', cancel: true }] });
}

function recipeOptions() {
  const recipe = toRecipe(store.doc.stack, APP_VERSION, store.doc.current ?? undefined);
  const shareable = canShareAsLink(recipe);
  const body = h(
    'div',
    { class: 'col' },
    h('div', null, `${store.doc.stack.length} step(s). A recipe is the steps only, no photos.`),
    h('div', { class: 'row' }, button('Copy Share Link', () => void copyLink(), { cls: 'small', disabled: !shareable })),
    shareable ? h('div', { class: 'hint' }, 'The link holds the steps only, never your photo.') : h('div', { class: 'hint' }, 'This recipe borrows your own photos (or has hex edits), and those never go into a link. Save a project instead.'),
  );
  dialog98({ title: 'Recipe Options', icon: 'documents', body, width: 340, height: 170, buttons: [{ label: 'OK', primary: true }] });
}

// ------------------------------------------------------------------ the savers (behaviour as before)

async function finalBytes(bytes: Uint8Array): Promise<Uint8Array> {
  let out = bytes;
  if (settings.stripPrivateExif) {
    try {
      out = await engine().stripPrivateExif(out).promise;
    } catch {
      // Never save the private fields just because the engine failed: drop every metadata block instead.
      out = stripExifFallback(out);
    }
  }
  if (settings.embedRecipe) out = insertComment(out, 'File Refragmenter recipe: ' + JSON.stringify(toRecipe(store.doc.stack, APP_VERSION)));
  return out;
}

/** The editor's result, waiting for a run that is still going (so a quick Save never gets the old file). */
function latest(): Promise<PipelineResult | null> {
  return pipeline.settled();
}

function needPhoto(): boolean {
  if (pipeline.last || store.current) return true;
  message('Save As', 'Open a photo in the editor first.', 'info');
  return false;
}

async function saveJpg(name: string, place: Place): Promise<boolean> {
  if (!needPhoto()) return false;
  const r = await latest();
  if (!r) return false;
  const out = await finalBytes(r.output);
  if (place === 'pictures') {
    store.addPhoto({ name: name + '.jpg', source: 'user', bytes: out, note: 'Saved from the editor' });
    bus.emit('exported');
    return true;
  }
  download(out, name + '.jpg', 'image/jpeg');
  bus.emit('exported');
  return true;
}

async function savePng(name: string): Promise<boolean> {
  if (!needPhoto()) return false;
  const r = await latest();
  if (!r) return false;
  if (!r.after) {
    errorBox('This file can’t be decoded, so there is no preview to save. The .jpg itself still works.');
    return false;
  }
  const c = document.createElement('canvas');
  c.width = r.after.width;
  c.height = r.after.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.after.rgba), r.after.width, r.after.height), 0, 0);
  download(await canvasToPng(c), name + '.png', 'image/png');
  bus.emit('exported');
  return true;
}

async function saveRfg(name: string): Promise<boolean> {
  const zip = store.projectZip();
  download(zip, name + '.rfg', 'application/zip');
  const m = await import('../shell/shell');
  await m.rememberProject(name, zip);
  return true;
}

function saveRecipe(name: string): boolean {
  const recipe = toRecipe(store.doc.stack, APP_VERSION, store.doc.current ?? undefined);
  download(new TextEncoder().encode(JSON.stringify(recipe, null, 1)), name + '.json', 'application/json');
  return true;
}

async function copyLink() {
  const recipe = toRecipe(store.doc.stack, APP_VERSION, store.doc.current ?? undefined);
  const url = location.origin + location.pathname + (await recipeToFragment(linkRecipe(recipe)));
  try {
    await navigator.clipboard.writeText(url);
    message('Link copied', linkRecipe(recipe).source ? 'The link is on your clipboard. It contains the recipe only: whoever opens it gets the same damage on the same sample photo.' : 'The link is on your clipboard. It contains the steps only, never your photo: whoever opens it gets the same damage on their own photo.', 'globe');
  } catch {
    message('Share link', h('div', { class: 'selectable sa-url' }, url), 'globe');
  }
}

async function share() {
  const r = await latest();
  if (!r) return;
  const out = await finalBytes(r.output);
  const file = new File([out as BlobPart], baseName() + '_refrag.jpg', { type: 'image/jpeg' });
  try {
    await (navigator as any).share({ files: [file], title: 'Broken with File Refragmenter' });
    bus.emit('exported');
  } catch {
    /* cancelled */
  }
}

async function saveBatch(name: string): Promise<boolean> {
  const items = store.pool().filter((p) => !batchOpts.skip.has(p.uid));
  if (!items.length) {
    message('Save As', 'No pictures are chosen for the batch. Press Options… to choose some.', 'info');
    return false;
  }
  const steps = store.doc.stack;
  let stop = false;
  const prog = progressDialog('Batch export', { onCancel: () => (stop = true), say: 'Breaking every photo, one by one…' });
  const files: { name: string; data: Uint8Array }[] = [];
  try {
    for (let i = 0; i < items.length && !stop; i++) {
      prog.set(i / items.length, `Breaking photo ${i + 1} of ${items.length}…`);
      const seeded = offsetSeeds(steps, batchOpts.base + i);
      const src = await pipeline.photoBytes(items[i].uid);
      const r = await pipeline.runOn(items[i].uid + '@batch', src, seeded, items[i].uid, () => stop);
      files.push({ name: `IMG_${String(i + 1).padStart(4, '0')}.JPG`, data: await finalBytes(r.output) });
    }
    if (!stop) {
      prog.set(1, 'Packing the ZIP…');
      download(zipStore(files), name + '.zip', 'application/zip');
      bus.emit('exported');
    }
  } catch (e) {
    if (!isCancel(e)) errorBox(String((e as Error).message ?? e));
    stop = true;
  } finally {
    progressDone(prog);
  }
  return !stop;
}

export function offsetSeeds(nodes: StackNode[], add: number): StackNode[] {
  return nodes.map((n) => (n.type === 'step' ? { ...n, seed: (n.seed + add) >>> 0 } : n.type === 'repeat' ? { ...n, seed: (n.seed + add) >>> 0, children: n.children.map((c) => ({ ...c, seed: (c.seed + add) >>> 0 })) } : n));
}

async function saveAnim(fmt: 'gif' | 'avi' | 'mp4', name: string): Promise<boolean> {
  const cur = store.current;
  if (!cur) {
    message('Save As', 'Open a photo in the editor first.', 'info');
    return false;
  }
  const { mode, frames, maxDim, fps } = anim;
  let stop = false;
  const prog = progressDialog('Making the animation', { onCancel: () => (stop = true), say: 'Saving the same photo again and again…' });
  try {
    const src = await pipeline.photoBytes(cur.uid);
    const jpegs: Uint8Array[] = [src];
    const steps = store.doc.stack;
    if (mode === 'steps') {
      for (let i = 1; i <= steps.length && !stop; i++) {
        prog.set(i / (steps.length + 1), `Frame ${i + 1} of ${steps.length + 1}…`);
        jpegs.push((await pipeline.runOn(cur.uid + '@anim', src, steps.slice(0, i), cur.uid, () => stop)).output);
      }
    } else {
      let b = src;
      const gen = steps.length ? steps : [];
      for (let i = 1; i < frames && !stop; i++) {
        prog.set(i / frames, `Generation ${i} of ${frames - 1}…`);
        if (gen.length) b = (await pipeline.runOn(cur.uid + '@gen' + i + ':' + jpegs.length, b, offsetSeeds(gen, i), cur.uid, () => stop)).output;
        else {
          const d = await engine().decode(b).promise;
          b = await engine().encodeRgba(d.width, d.height, d.rgba, { quality: 60 }).promise;
        }
        jpegs.push(b);
      }
    }
    if (stop) return false;
    prog.set(null, 'Decoding frames…');
    // decode + scale every frame to one size
    const first = await engine().decode(jpegs[0], {}).promise;
    const s = Math.min(1, maxDim / Math.max(first.width, first.height));
    const W = Math.max(2, Math.round(first.width * s) & ~1);
    const H = Math.max(2, Math.round(first.height * s) & ~1);
    const rgbaFrames: Uint8ClampedArray[] = [];
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    for (const j of jpegs) {
      if (stop) return false;
      x.fillStyle = '#808080';
      x.fillRect(0, 0, W, H);
      try {
        const d = await engine().decode(j, {}).promise;
        const tmp = document.createElement('canvas');
        tmp.width = d.width;
        tmp.height = d.height;
        tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d.rgba), d.width, d.height), 0, 0);
        x.imageSmoothingQuality = 'high';
        x.drawImage(tmp, 0, 0, W, H);
      } catch {
        /* unreadable frame: grey */
      }
      rgbaFrames.push(x.getImageData(0, 0, W, H).data);
    }
    prog.set(null, 'Writing the file…');
    if (fmt === 'gif') {
      const out = await engine().encodeGif(W, H, rgbaFrames.map((f) => new Uint8Array(f.buffer as ArrayBuffer)), Math.round(100 / fps)).promise;
      download(out, name + '.gif', 'image/gif');
    } else if (fmt === 'avi') {
      const enc: Uint8Array[] = [];
      for (const f of rgbaFrames) enc.push(await engine().encodeRgba(W, H, f, { quality: 85 }).promise);
      const out = await engine().aviWrite(enc, W, H, fps).promise;
      download(out, name + '.avi', 'video/x-msvideo');
    } else {
      const out = await encodeMp4(rgbaFrames, W, H, fps);
      download(out, name + '.mp4', 'video/mp4');
    }
    bus.emit('exported');
    return true;
  } catch (e) {
    if (e instanceof NotAvailableError) message('Not available yet', `This export needs "${e.fn}" from the engine, which is not built yet.`, 'video');
    else if (!isCancel(e)) errorBox(String((e as Error).message ?? e));
    return false;
  } finally {
    progressDone(prog);
  }
}

async function saveSheet(name: string): Promise<boolean> {
  const items = store.pool();
  let stop = false;
  const prog = progressDialog('Contact sheet', { onCancel: () => (stop = true) });
  try {
    const imgs = await Promise.all(items.map(async (p) => ({ name: p.name, bytes: await pipeline.photoBytes(p.uid) })));
    const c = await contactSheet(imgs, sheetStyle, (i, n) => prog.set(i / n, `Thumbnail ${i + 1} of ${n}…`), () => stop);
    if (!stop) download(await canvasToPng(c), name + '.png', 'image/png');
  } finally {
    progressDone(prog);
  }
  return !stop;
}
