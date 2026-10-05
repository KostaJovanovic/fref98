// "My Pictures": the photo pool as a Windows 98 Explorer folder (C:\My Documents\My Pictures). Photos are
// imported by drag-and-drop or File ▸ Add Photos; Open sends one to the editor; Delete sends photos to the
// Recycle Bin; Copy/Paste makes "Copy of" duplicates; items Cut in the Recycle Bin are restored by Paste here.
// Per-photo one-level stacks ("Own Steps") open from the file menu.
import { h, pickFiles } from '../ui/dom';
import { openWindow, getWin } from '../ui/wm';
import type { MenuItem } from '../ui/menu';
import { store, type PhotoData } from '../state';
import { pipeline } from '../pipeline';
import { importFiles, ensureSamples } from '../importflow';
import { thumbUrl } from '../thumbs';
import { StackView } from '../editor/stackview';
import { confirmBox, message, errorBox } from '../ui/dialog';
import { ambientEngine } from '../engine/client';
import { inspectJpeg } from '../engine/jpegmeta';
import { setWallpaperImage } from '../shell/wallpaper';
import { openApp } from './registry';
import { foldy } from '../foldy/foldy';
import { Folder, propertySheet, standardButtons, getClip, setClip, type FolderSpec } from './explorer';
import * as M from './explorer-model';
import { restoreItems } from './recycle';
import { LatestCache } from '../latest';

const LOCATION = 'C:\\My Documents';
const ADDRESS = LOCATION + '\\My Pictures';

let f: Folder<PhotoData> | null = null;
let unsub: (() => void) | null = null;
/** Edit ▸ Undo: the last delete or rename. */
let undo: { label: string; run: () => void } | null = null;
/** Dimensions read from the JPEG, one entry per photo (an edit replaces it, so old versions don't pile up). */
const dims = new LatestCache<{ w: number; h: number } | null>();

export function open() {
  if (f && getWin('pictures')) return f.win.focus();
  f = new Folder<PhotoData>(spec());
  unsub = store.on((why) => (why === 'photos' || why === 'load' || why === 'undo' || why === 'redo' || why === 'bin') && f?.render());
  ensureSamples()
    .then(() => f?.render())
    .catch((e) => errorBox(`Cannot load the sample photos: ${e instanceof Error ? e.message : e}`));
}

function dimsOf(p: PhotoData): { w: number; h: number } | null {
  if (p.width && p.height) return { w: p.width, h: p.height };
  return dims.get(p.uid, p.version, () => {
    const fr = inspectJpeg(p.bytes).frame;
    return fr ? { w: fr.width, h: fr.height } : null;
  });
}

const created = (p: PhotoData) => M.uidTime(p.uid);
const sourceText: Record<string, string> = { user: 'Your photo', bundled: 'Sample photo', placeholder: 'Test pattern', recovered: 'Recovered from the card', webcam: 'Camera Wizard snapshot' };

function spec(): FolderSpec<PhotoData> {
  return {
    id: 'pictures',
    title: 'My Pictures',
    short: 'Pictures',
    icon: 'pictures',
    address: ADDRESS,
    width: 600,
    height: 420,
    items: () => store.pool(),
    key: (p) => p.uid,
    name: (p) => p.name,
    iconOf: () => 'jpeg',
    thumb: (p) => thumbUrl(store.photoKey(p.uid), p.bytes),
    size: (p) => p.bytes.length,
    columns: [
      { id: 'name', label: 'Name', width: 170, text: (p) => p.name },
      { id: 'size', label: 'Size', width: 64, right: true, text: (p) => M.fmtSizeColumn(p.bytes.length), cmp: (a, b) => a.bytes.length - b.bytes.length },
      { id: 'type', label: 'Type', width: 90, text: (p) => M.fileType(p.name) },
      { id: 'modified', label: 'Modified', width: 120, text: (p) => (created(p) ? M.fmtDate98(created(p)!) : ''), cmp: (a, b) => (created(a) ?? 0) - (created(b) ?? 0) },
      { id: 'dims', label: 'Dimensions', width: 80, text: (p) => (dimsOf(p) ? `${dimsOf(p)!.w} x ${dimsOf(p)!.h}` : ''), cmp: (a, b) => (dimsOf(a)?.w ?? 0) * (dimsOf(a)?.h ?? 0) - (dimsOf(b)?.w ?? 0) * (dimsOf(b)?.h ?? 0) },
    ],
    views: ['large', 'small', 'list', 'details', 'thumbs'],
    view: 'thumbs',
    sort: null,
    arrange: [
      ['by &Name', 'name'],
      ['by &Type', 'type'],
      ['by Si&ze', 'size'],
      ['by &Date', 'modified'],
    ],
    emptyText: 'This folder is empty. Drop photos here, or use File, Add Photos.',
    zone: ['computer', 'My Computer'],
    open: (items) => openIn(items[0]),
    itemMenu: (items) => itemMenu(items),
    bgMenu: (fo) => [
      ...fo.bgViewBlock(),
      { sep: true },
      { label: '&Paste', disabled: !canPaste(), onClick: paste },
      { label: 'Paste &Shortcut', disabled: true },
      ...(undo ? [{ label: undo.label, onClick: runUndo }] : []),
      { sep: true },
      { label: 'Ne&w', sub: newItems },
      { sep: true },
      { label: 'P&roperties', onClick: folderProperties },
    ],
    menus: (fo) => [
      { label: '&File', items: () => fileMenu(fo) },
      { label: '&Edit', items: () => editMenu(fo) },
      { label: '&View', items: () => fo.viewMenu() },
      { label: '&Help', items: () => Folder.helpMenu({ id: 'folders', label: 'My &Pictures Help' }) },
    ],
    toolbar: (fo) =>
      standardButtons({
        cut: () => cut(fo.selected()),
        copy: () => copy(fo.selected()),
        paste,
        undo: runUndo,
        del: () => void del(fo.selected()),
        props: () => properties(fo.selected()),
        canCut: () => fo.sel.size > 0,
        canCopy: () => fo.sel.size > 0,
        canPaste,
        canUndo: () => !!undo,
        canDel: () => fo.sel.size > 0,
      }),
    onDelete: (items) => void del(items),
    // drag a picture onto the Recycle Bin (its window or the desktop icon) to delete it
    dropRole: 'pictures',
    onDragTo: (items, t) => t === 'bin' && void del(items),
    rename: (p, name) => rename(p, name),
    onCut: cut,
    onCopy: copy,
    onPaste: paste,
    onUndo: runUndo,
    onProperties: (items) => properties(items),
    onDrop: (files) => void importFiles(files, { makeCurrent: false }),
    onClose: () => {
      unsub?.();
      unsub = null;
      f = null;
    },
  };
}

// ------------------------------------------------------------------ menus

function newItems(): MenuItem[] {
  return [{ label: '&Folder', icon: 'folder', disabled: true }, { label: '&Shortcut', disabled: true }, { sep: true }, { label: 'JPEG Image…', icon: 'jpeg', onClick: () => void addPhotos() }];
}

function itemMenu(items: PhotoData[]): MenuItem[] {
  const one = items.length === 1 ? items[0] : null;
  return [
    { label: '&Open', default: true, onClick: () => openIn(items[0]) },
    { label: 'Open in He&x Doctor', disabled: !one, onClick: () => one && openHex(one) },
    { label: 'Own S&teps…', disabled: !one, onClick: () => one && ownSteps(one) },
    { label: 'Set as &Wallpaper', disabled: !one, onClick: () => one && void wallpaper(one) },
    { sep: true },
    { label: 'Cu&t', onClick: () => cut(items) },
    { label: '&Copy', onClick: () => copy(items) },
    { sep: true },
    { label: '&Delete', onClick: () => void del(items) },
    { label: 'Rena&me', disabled: !one, onClick: () => one && f?.startRename(one.uid) },
    { sep: true },
    { label: 'P&roperties', onClick: () => properties(items) },
  ];
}

function fileMenu(fo: Folder<PhotoData>): MenuItem[] {
  const items = fo.selected();
  const one = items.length === 1 ? items[0] : null;
  const head: MenuItem[] = items.length
    ? [
        { label: '&Open', default: true, onClick: () => openIn(items[0]) },
        { label: 'Open in He&x Doctor', disabled: !one, onClick: () => one && openHex(one) },
        { label: 'Own S&teps…', disabled: !one, onClick: () => one && ownSteps(one) },
        { sep: true },
      ]
    : [];
  return [
    ...head,
    { label: '&Add Photos…', icon: 'folder', onClick: () => void addPhotos() },
    { label: 'Ne&w', sub: newItems },
    { sep: true },
    { label: 'Create &Shortcut', disabled: true },
    { label: '&Delete', disabled: !items.length, onClick: () => void del(items) },
    { label: 'Rena&me', disabled: !one, onClick: () => one && fo.startRename(one.uid) },
    { label: 'P&roperties', onClick: () => (items.length ? properties(items) : folderProperties()) },
    { sep: true },
    { label: '&Close', onClick: () => fo.win.close() },
  ];
}

function editMenu(fo: Folder<PhotoData>): MenuItem[] {
  const n = fo.sel.size;
  return [
    { label: undo ? undo.label : '&Undo', acc: 'Ctrl+Z', disabled: !undo, onClick: runUndo },
    { sep: true },
    { label: 'Cu&t', acc: 'Ctrl+X', disabled: !n, onClick: () => cut(fo.selected()) },
    { label: '&Copy', acc: 'Ctrl+C', disabled: !n, onClick: () => copy(fo.selected()) },
    { label: '&Paste', acc: 'Ctrl+V', disabled: !canPaste(), onClick: paste },
    { label: 'Paste &Shortcut', disabled: true },
    { sep: true },
    ...fo.selectionItems(),
  ];
}

// ------------------------------------------------------------------ commands

async function addPhotos() {
  try {
    await importFiles(await pickFiles('image/*,.jpg,.jpeg'), { makeCurrent: false });
  } catch (e) {
    errorBox(`Cannot add the photos: ${e instanceof Error ? e.message : e}`);
  }
}

function openIn(p: PhotoData | undefined) {
  if (!p) return;
  store.update((d) => void (d.current = p.uid), 'photos');
  void openApp('editor');
}

function openHex(p: PhotoData) {
  if (store.doc.current !== p.uid) store.update((d) => void (d.current = p.uid), 'photos');
  void openApp('hex');
}

async function wallpaper(p: PhotoData) {
  try {
    const d = await ambientEngine().decode(p.bytes, { max_dim: 1600 }).promise;
    const c = document.createElement('canvas');
    c.width = d.width;
    c.height = d.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d.rgba.buffer as ArrayBuffer), d.width, d.height), 0, 0);
    setWallpaperImage(c);
  } catch (e) {
    errorBox(`Cannot set '${p.name}' as the wallpaper: ${(e as Error).message ?? e}`);
  }
}

function cut(items: PhotoData[]) {
  if (items.length) setClip({ op: 'cut', from: 'pictures', keys: items.map((p) => p.uid) });
}

function copy(items: PhotoData[]) {
  if (items.length) setClip({ op: 'copy', from: 'pictures', keys: items.map((p) => p.uid) });
}

function canPaste(): boolean {
  const c = getClip();
  return !!c && (c.from === 'pictures' || (c.from === 'recycle' && c.op === 'cut' && c.keys.some((k) => store.bin.some((b) => b.id === k))));
}

function paste() {
  const c = getClip();
  if (!c || !canPaste()) return;
  if (c.from === 'recycle') {
    // moving items out of the Recycle Bin puts them back
    void restoreItems(c.keys.filter((k) => store.bin.some((b) => b.id === k)));
    setClip(null);
    return;
  }
  const photos = c.keys.map((k) => store.photos.get(k)).filter((p): p is PhotoData => !!p && store.doc.order.includes(p.uid));
  if (!photos.length) return;
  if (c.op === 'cut') {
    message('Error Moving File', `Cannot move '${photos[0].name}': The source and destination file names are the same.`, 'error');
    return;
  }
  const names = store.pool().map((p) => p.name);
  for (const p of photos) {
    const name = M.copyName(p.name, names);
    names.push(name);
    store.addPhoto({ name, source: 'user', bytes: p.bytes.slice(), note: p.note, license: p.license, width: p.width, height: p.height }, { makeCurrent: false });
  }
}

function runUndo() {
  const u = undo;
  undo = null;
  u?.run();
  f?.updateTools();
}

async function del(items: PhotoData[]) {
  if (!items.length) return;
  const one = items.length === 1;
  const ok = await confirmBox(
    one ? 'Confirm File Delete' : 'Confirm Multiple File Delete',
    one ? `Are you sure you want to send '${items[0].name}' to the Recycle Bin?` : `Are you sure you want to send these ${items.length} items to the Recycle Bin?`,
    'Yes',
    'recycle',
  );
  if (!ok) return;
  const uids = items.map((p) => p.uid);
  for (const u of uids) store.removePhoto(u);
  undo = {
    label: '&Undo Delete',
    run: () => {
      const ids = uids.map((u) => store.bin.find((b) => b.kind === 'photo' && b.data?.uid === u)?.id);
      void restoreItems(ids.filter((id): id is string => !!id));
    },
  };
  f?.updateTools();
}

function rename(p: PhotoData, name: string): boolean {
  if (store.pool().some((x) => x.uid !== p.uid && x.name.toLowerCase() === name.toLowerCase())) {
    message('Error Renaming File', `Cannot rename ${p.name}: A file with the name you specified already exists. Specify a different filename.`, 'error');
    return false;
  }
  const old = p.name;
  store.renamePhoto(p.uid, name);
  undo = { label: '&Undo Rename', run: () => store.photos.has(p.uid) && store.renamePhoto(p.uid, old) };
  f?.updateTools();
  return true;
}

// ------------------------------------------------------------------ property sheets

function properties(items: PhotoData[]) {
  if (!items.length) return folderProperties();
  if (items.length > 1) {
    const total = items.reduce((a, p) => a + p.bytes.length, 0);
    propertySheet({
      id: 'props:pictures:multi',
      title: 'Properties',
      icon: 'jpeg',
      name: `${items.length} Files, 0 Folders`,
      groups: [
        [
          { label: 'Type:', value: 'All of type ' + M.fileType(items[0].name) },
          { label: 'Location:', value: 'All in ' + ADDRESS },
          { label: 'Size:', value: `${M.fmtSize98(total)} (${M.fmtBytesExact(total)})` },
        ],
      ],
      attrs: { archive: true },
    });
    return;
  }
  const p = items[0];
  const d = dimsOf(p);
  const t = created(p);
  const own = (store.doc.photoStacks[p.uid] ?? []).length;
  propertySheet({
    id: 'props:pictures:' + p.uid,
    title: `${p.name} Properties`,
    icon: 'jpeg',
    name: p.name,
    onRename: (v) => rename(p, v),
    groups: [
      [
        { label: 'Type:', value: M.fileType(p.name) },
        { label: 'Location:', value: ADDRESS },
        { label: 'Size:', value: `${M.fmtSize98(p.bytes.length)} (${M.fmtBytesExact(p.bytes.length)})` },
        { label: 'Dimensions:', value: d ? `${d.w} x ${d.h} pixels` : 'Unknown (the header is damaged)' },
      ],
      [
        { label: 'MS-DOS name:', value: M.dosName(p.name) },
        { label: 'Created:', value: t ? M.fmtDateLong98(t) : '(unknown)' },
        { label: 'Modified:', value: t ? M.fmtDateLong98(t) : '(unknown)' },
        { label: 'Accessed:', value: M.fmtDateLong98(Date.now()).replace(/ \d+:\d\d:\d\d [AP]M$/, '') },
      ],
      [
        { label: 'Source:', value: sourceText[p.source] ?? p.source },
        { label: 'Own steps:', value: own ? `${own} step${own > 1 ? 's' : ''}` : 'None' },
      ],
    ],
    attrs: { archive: true },
  });
}

function folderProperties() {
  const pool = store.pool();
  const total = pool.reduce((a, p) => a + p.bytes.length, 0);
  propertySheet({
    id: 'props:pictures:folder',
    title: 'My Pictures Properties',
    icon: 'pictures',
    name: 'My Pictures',
    groups: [
      [
        { label: 'Type:', value: 'File Folder' },
        { label: 'Location:', value: LOCATION },
        { label: 'Size:', value: `${M.fmtSize98(total)} (${M.fmtBytesExact(total)})` },
        { label: 'Contains:', value: `${pool.length} Files, 0 Folders` },
      ],
      [
        { label: 'MS-DOS name:', value: 'MYPICT~1' },
        { label: 'Stored in:', value: 'This browser only. Nothing is uploaded.' },
      ],
    ],
    attrs: { readOnly: true },
  });
}

// ------------------------------------------------------------------ own steps (one-level stack per photo)

function ownSteps(p: PhotoData) {
  const id = 'own:' + p.uid;
  const existing = getWin(id);
  if (existing) return existing.focus();
  const sv = new StackView({
    catalog: () => pipeline.catalog,
    get: () => store.doc.photoStacks[p.uid] ?? [],
    set: (nodes, merge) => store.update((d) => void (d.photoStacks[p.uid] = nodes), 'photos', merge ?? null),
    results: () => null,
    pool: () => store.pool().filter((x) => x.uid !== p.uid).map((x) => ({ uid: x.uid, name: x.name })),
    onExplain: (info) => foldy.help(info.help),
    onMask: () => message('Masks', 'Masks can only be painted in the editor (open this photo there).'),
    onDelete: (n, label) => store.binStep(n, label),
    onRebasePatch: () => {},
    maskEditing: () => null,
    maskEraser: () => false,
  });
  const body = h('div', { class: 'pad col' }, h('p', null, `Steps applied to "${p.name}" whenever another step borrows it (as a donor header, a neighbour on the card, …). One level only.`), sv.el);
  const un = store.on(() => sv.render());
  openWindow({ id, title: `Own steps: ${p.name}`, icon: 'presets', body, width: 380, height: 420, onClose: () => void un() });
  sv.render(true);
}
