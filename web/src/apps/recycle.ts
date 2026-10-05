// The Recycle Bin as the 98 folder: deleted photos, recipe steps and replaced projects in Details view (Name,
// Original Location, Date Deleted, Type, Size). Restore puts items back; Delete and Empty Recycle Bin remove
// them for good after the 98 confirmation; Cut here and Paste in My Pictures restores, as in 98.
import type { MenuItem } from '../ui/menu';
import { getWin } from '../ui/wm';
import { store, type RecycleItem } from '../state';
import { confirmBox, errorBox } from '../ui/dialog';
import { Folder, propertySheet, standardButtons, setClip, type FolderSpec } from './explorer';
import * as M from './explorer-model';

let f: Folder<RecycleItem> | null = null;
let unsub: (() => void) | null = null;

const ORIGIN: Record<RecycleItem['kind'], string> = {
  photo: 'C:\\My Documents\\My Pictures',
  step: 'C:\\Program Files\\Refragmenter\\Recipe',
  project: 'C:\\My Documents',
};
const TYPE: Record<RecycleItem['kind'], string> = { photo: 'JPEG Image', step: 'Recipe Step', project: 'Refragmenter Project' };
const ICON: Record<RecycleItem['kind'], string> = { photo: 'jpeg', step: 'presets', project: 'project' };

/** Bytes an item takes: the photo, the project file, or the step's settings. */
export function itemSize(it: RecycleItem): number {
  if (it.kind === 'photo') return store.photos.get(it.data?.uid)?.bytes.length ?? 0;
  if (it.kind === 'project') return (it.data as Uint8Array | undefined)?.length ?? 0;
  try {
    return JSON.stringify(it.data ?? null).length;
  } catch {
    return 0;
  }
}

export function open() {
  if (f && getWin('recycle')) return f.win.focus();
  f = new Folder<RecycleItem>(spec());
  unsub = store.on((why) => (why === 'bin' || why === 'load') && f?.render());
}

function spec(): FolderSpec<RecycleItem> {
  return {
    id: 'recycle',
    title: 'Recycle Bin',
    short: 'Bin',
    icon: 'recycle',
    address: 'Recycle Bin',
    width: 620,
    height: 360,
    items: () => store.bin,
    key: (it) => it.id,
    name: (it) => it.label,
    iconOf: (it) => ICON[it.kind],
    size: itemSize,
    columns: [
      { id: 'name', label: 'Name', width: 150, text: (it) => it.label },
      { id: 'origin', label: 'Original Location', width: 170, text: (it) => ORIGIN[it.kind] },
      { id: 'deleted', label: 'Date Deleted', width: 120, text: (it) => M.fmtDate98(it.deletedAt), cmp: (a, b) => a.deletedAt - b.deletedAt },
      { id: 'type', label: 'Type', width: 110, text: (it) => TYPE[it.kind] },
      { id: 'size', label: 'Size', width: 56, right: true, text: (it) => M.fmtSizeColumn(itemSize(it)), cmp: (a, b) => itemSize(a) - itemSize(b) },
    ],
    views: ['large', 'small', 'list', 'details'],
    view: 'details',
    sort: null,
    arrange: [
      ['by &Name', 'name'],
      ['by &Origin', 'origin'],
      ['by &Delete Date', 'deleted'],
      ['by &Type', 'type'],
      ['by &Size', 'size'],
    ],
    zone: ['computer', 'My Computer'],
    open: (items) => properties(items),
    itemMenu: (items) => [
      { label: 'R&estore', default: true, onClick: () => restore(items) },
      { sep: true },
      { label: 'Cu&t', onClick: () => cut(items) },
      { sep: true },
      { label: '&Delete', onClick: () => void purge(items) },
      { sep: true },
      { label: 'P&roperties', onClick: () => properties(items) },
    ],
    bgMenu: (fo) => [...fo.bgViewBlock(), { sep: true }, { label: '&Paste', disabled: true }, { label: 'Paste &Shortcut', disabled: true }, { sep: true }, { label: 'P&roperties', onClick: binProperties }],
    menus: (fo) => [
      { label: '&File', items: () => fileMenu(fo) },
      {
        label: '&Edit',
        items: () => [
          { label: '&Undo', acc: 'Ctrl+Z', disabled: true },
          { sep: true },
          { label: 'Cu&t', acc: 'Ctrl+X', disabled: !fo.sel.size, onClick: () => cut(fo.selected()) },
          { label: '&Copy', acc: 'Ctrl+C', disabled: true },
          { label: '&Paste', acc: 'Ctrl+V', disabled: true },
          { label: 'Paste &Shortcut', disabled: true },
          { sep: true },
          ...fo.selectionItems(),
        ],
      },
      { label: '&View', items: () => fo.viewMenu() },
      { label: '&Help', items: () => Folder.helpMenu({ id: 'folders', label: '&Recycle Bin Help' }) },
    ],
    toolbar: (fo) =>
      standardButtons({
        cut: () => cut(fo.selected()),
        del: () => void purge(fo.selected()),
        props: () => properties(fo.selected()),
        canCut: () => fo.sel.size > 0,
        canDel: () => fo.sel.size > 0,
        canProps: () => fo.sel.size > 0,
      }),
    onDelete: (items) => void purge(items),
    // drag items out onto My Pictures to restore them (they go back where they were)
    dropRole: 'bin',
    onDragTo: (items, t) => t === 'pictures' && restore(items),
    onCut: cut,
    onProperties: (items) => properties(items),
    onClose: () => {
      unsub?.();
      unsub = null;
      f = null;
    },
  };
}

function fileMenu(fo: Folder<RecycleItem>): MenuItem[] {
  const items = fo.selected();
  return [
    ...(items.length ? [{ label: 'R&estore', default: true, onClick: () => restore(items) }, { sep: true }] : []),
    { label: 'Empty Recycle &Bin', disabled: !store.bin.length, onClick: () => void emptyBin() },
    { sep: true },
    { label: 'Create &Shortcut', disabled: true },
    { label: '&Delete', disabled: !items.length, onClick: () => void purge(items) },
    { label: 'P&roperties', onClick: () => (items.length ? properties(items) : binProperties()) },
    { sep: true },
    { label: '&Close', onClick: () => fo.win.close() },
  ];
}

function restore(items: RecycleItem[]) {
  void restoreItems(items.map((it) => it.id));
}

/** Restores bin items; one 98 error box names those that could not be put back. Also used by My Pictures' Paste. */
export async function restoreItems(ids: string[]) {
  const failed: string[] = [];
  for (const id of ids) {
    const label = store.bin.find((b) => b.id === id)?.label;
    if (label !== undefined && !(await store.restore(id))) failed.push(label);
  }
  if (failed.length) errorBox(`Cannot restore '${failed[0]}'${failed.length > 1 ? ` and ${failed.length - 1} other item(s)` : ''}: the file is no longer stored or is damaged.`);
}

function cut(items: RecycleItem[]) {
  if (items.length) setClip({ op: 'cut', from: 'recycle', keys: items.map((it) => it.id) });
}

/** Removes items for good (photo bytes too, unless the photo is back in My Pictures). */
function forget(ids: Set<string>) {
  store.forget(ids);
}

async function purge(items: RecycleItem[]) {
  if (!items.length) return;
  const one = items.length === 1;
  const ok = await confirmBox(
    one ? 'Confirm File Delete' : 'Confirm Multiple File Delete',
    one ? `Are you sure you want to delete '${items[0].label}'?` : `Are you sure you want to delete these ${items.length} items?`,
    'Yes',
    'recycle',
  );
  if (ok) forget(new Set(items.map((i) => i.id)));
}

/** Empty Recycle Bin, with the 98 confirmation. Also used by the desktop's Recycle Bin icon. */
export async function emptyBin() {
  const n = store.bin.length;
  if (!n) return;
  const ok = await confirmBox('Confirm Multiple File Delete', n === 1 ? `Are you sure you want to delete '${store.bin[0].label}'?` : `Are you sure you want to delete these ${n} items?`, 'Yes', 'recycle');
  if (ok) store.emptyBin();
}

function properties(items: RecycleItem[]) {
  if (!items.length) return binProperties();
  if (items.length > 1) {
    const total = items.reduce((a, it) => a + itemSize(it), 0);
    propertySheet({
      id: 'props:recycle:multi',
      title: 'Properties',
      icon: 'recycle',
      name: `${items.length} Files, 0 Folders`,
      groups: [[{ label: 'Size:', value: `${M.fmtSize98(total)} (${M.fmtBytesExact(total)})` }]],
    });
    return;
  }
  const it = items[0];
  const size = itemSize(it);
  propertySheet({
    id: 'props:recycle:' + it.id,
    title: `${it.label} Properties`,
    icon: ICON[it.kind],
    name: it.label,
    groups: [
      [
        { label: 'Origin:', value: ORIGIN[it.kind] },
        { label: 'Type:', value: TYPE[it.kind] },
        { label: 'Size:', value: `${M.fmtSize98(size)} (${M.fmtBytesExact(size)})` },
      ],
      [{ label: 'Deleted:', value: M.fmtDateLong98(it.deletedAt) }],
    ],
    attrs: { archive: true },
  });
}

/** Recycle Bin Properties. Also used by the desktop's Recycle Bin icon. */
export function binProperties() {
  const total = store.bin.reduce((a, it) => a + itemSize(it), 0);
  propertySheet({
    id: 'props:recycle:bin',
    title: 'Recycle Bin Properties',
    icon: store.bin.length ? 'recyclefull' : 'recycle',
    name: 'Recycle Bin',
    groups: [
      [
        { label: 'Contains:', value: `${store.bin.length} item(s): deleted photos, steps and projects` },
        { label: 'Size:', value: `${M.fmtSize98(total)} (${M.fmtBytesExact(total)})` },
      ],
      [{ label: 'Stored in:', value: 'This browser only. Nothing is uploaded.' }],
    ],
  });
}
