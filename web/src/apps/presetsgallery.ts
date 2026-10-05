// Presets: the story presets as a 98 folder (Large Icons by default, Details with Category / Status / Steps /
// Description). Double-click applies one in the editor. View ▸ as Web Page shows the old over-decorated Y2K
// gallery page instead, as 98 folders could show a web view.
import { h } from '../ui/dom';
import { iconImg } from '../ui/art';
import { button } from '../ui/controls';
import { getWin } from '../ui/wm';
import type { MenuItem } from '../ui/menu';
import { PRESETS, presetAvailability, type Preset } from '../presets';
import { pipeline } from '../pipeline';
import { marquee, underConstruction, newBadge, spinningGlobe, hitCounter, visitCount } from '../ui/y2k';
import { foldy } from '../foldy/foldy';
import { presetLine } from '../foldy/lines';
import { openApp } from './registry';
import { Folder, propertySheet, standardButtons, type FolderSpec } from './explorer';

const CATS = ['Storage', 'Sharing', 'Camera', 'Transfer', 'Rescue'] as const;
const STATUS = { full: 'Ready', partial: 'Partly ready', none: 'Coming soon' } as const;

let f: Folder<Preset> | null = null;

const status = (p: Preset) => STATUS[presetAvailability(p, pipeline.catalog)];

export function open() {
  if (f && getWin('presets')) return f.win.focus();
  f = new Folder<Preset>(spec());
}

function spec(): FolderSpec<Preset> {
  return {
    id: 'presets',
    title: 'Presets',
    short: 'Presets',
    icon: 'presets',
    address: 'C:\\Program Files\\Refragmenter\\Presets',
    width: 580,
    height: 400,
    items: () => PRESETS,
    key: (p) => p.id,
    name: (p) => p.title,
    iconOf: (p) => p.icon,
    columns: [
      { id: 'name', label: 'Name', width: 150, text: (p) => p.title },
      { id: 'cat', label: 'Category', width: 70, text: (p) => p.category, cmp: (a, b) => CATS.indexOf(a.category) - CATS.indexOf(b.category) },
      { id: 'status', label: 'Status', width: 80, text: status },
      { id: 'steps', label: 'Steps', width: 44, right: true, text: (p) => String(p.uses.length), cmp: (a, b) => a.uses.length - b.uses.length },
      { id: 'desc', label: 'Description', width: 320, text: (p) => p.story },
    ],
    views: ['large', 'small', 'list', 'details'],
    view: 'large',
    sort: null,
    arrange: [
      ['by &Name', 'name'],
      ['by &Category', 'cat'],
      ['by &Status', 'status'],
    ],
    zone: ['computer', 'My Computer'],
    open: (items) => apply(items[0]),
    itemMenu: (items) => itemMenu(items),
    bgMenu: (fo) => [...fo.bgViewBlock(), { sep: true }, { label: '&Paste', disabled: true }, { label: 'Paste &Shortcut', disabled: true }, { sep: true }, { label: 'P&roperties', onClick: folderProperties }],
    menus: (fo) => [
      {
        label: '&File',
        items: () => {
          const sel = fo.selected();
          return [
            ...(sel.length ? [...itemMenu(sel).slice(0, 2), { sep: true }] : []),
            { label: 'P&roperties', onClick: () => (sel.length ? properties(sel[0]) : folderProperties()) },
            { sep: true },
            { label: '&Close', onClick: () => fo.win.close() },
          ];
        },
      },
      { label: '&Edit', items: () => [{ label: '&Undo', disabled: true }, { sep: true }, { label: 'Cu&t', disabled: true }, { label: '&Copy', disabled: true }, { label: '&Paste', disabled: true }, { sep: true }, ...fo.selectionItems()] },
      { label: '&View', items: () => fo.viewMenu() },
      { label: '&Help', items: () => Folder.helpMenu({ id: 'folders', label: '&Presets Help' }) },
    ],
    toolbar: (fo) => standardButtons({ props: () => properties(fo.selected()[0]), canProps: () => fo.sel.size > 0 }),
    onProperties: (items) => items[0] && properties(items[0]),
    webView: webPage,
    onClose: () => void (f = null),
  };
}

function itemMenu(items: Preset[]): MenuItem[] {
  const p = items[0];
  return [
    { label: '&Apply', default: true, onClick: () => apply(p) },
    { label: '&Show Me How', onClick: () => showHow(p) },
    { sep: true },
    { label: 'P&roperties', onClick: () => properties(p) },
  ];
}

function apply(p: Preset | undefined) {
  if (p) void openApp('editor', { preset: p.id });
}

/** As in the editor: the preset's real steps, opened in expert mode (Foldy says what they do). */
function showHow(p: Preset) {
  void openApp('editor', { preset: p.id, expert: true });
  foldy.help(`${p.title}: ${p.story} ${presetLine(p)}`);
}

function properties(p: Preset | undefined) {
  if (!p) return;
  const names = p.uses.map((u) => pipeline.catalog.get(u)?.label ?? u);
  propertySheet({
    id: 'props:presets:' + p.id,
    title: `${p.title} Properties`,
    icon: p.icon,
    name: p.title,
    groups: [
      [
        { label: 'Type:', value: 'Story Preset' },
        { label: 'Category:', value: p.category },
        { label: 'Status:', value: status(p) },
      ],
      [
        { label: 'Steps:', value: names.join(', ') || 'None' },
        { label: 'Needs:', value: p.needsPool ? 'Another photo in My Pictures' : 'Just the photo' },
      ],
      [{ label: 'Story:', value: p.story }],
    ],
    attrs: { readOnly: true },
  });
}

function folderProperties() {
  propertySheet({
    id: 'props:presets:folder',
    title: 'Presets Properties',
    icon: 'presets',
    name: 'Presets',
    groups: [
      [
        { label: 'Type:', value: 'File Folder' },
        { label: 'Location:', value: 'C:\\Program Files\\Refragmenter' },
        { label: 'Contains:', value: `${PRESETS.length} Files, 0 Folders` },
      ],
      [{ label: 'Ready:', value: `${PRESETS.filter((p) => presetAvailability(p, pipeline.catalog) === 'full').length} of ${PRESETS.length}` }],
    ],
    attrs: { readOnly: true },
  });
}

/** View ▸ as Web Page: the preset gallery as a lovingly over-decorated Y2K web page. */
function webPage(): HTMLElement {
  return h(
    'div',
    { class: 'y2k' },
    h('div', { class: 'row' }, spinningGlobe(), h('h1', { class: 'big' }, 'Preset Gallery'), newBadge()),
    marquee('*** Welcome to the File Refragmenter preset gallery!!! *** Every preset REALLY breaks your JPEG *** Best viewed at 800x600 *** Sign the guestbook (there is no guestbook) ***'),
    ...CATS.map((c) =>
      h(
        'div',
        { class: 'box' },
        h('h2', null, `» ${c}`),
        ...PRESETS.filter((p) => p.category === c).map((p) => {
          const av = presetAvailability(p, pipeline.catalog);
          return h(
            'div',
            { class: 'row', style: { alignItems: 'flex-start', margin: '6px 0' } },
            iconImg(p.icon, 32),
            h('div', { class: 'grow' }, h('div', { class: 'b' }, p.title + (av === 'none' ? ' (coming soon)' : av === 'partial' ? ' (partly ready)' : '')), h('div', null, p.story)),
            button('Try it!', () => apply(p), { cls: 'small' }),
          );
        }),
      ),
    ),
    underConstruction('MORE PRESETS UNDER CONSTRUCTION'),
    h('div', { class: 'row', style: { marginTop: '8px', justifyContent: 'center' } }, h('span', null, 'You are visitor number'), hitCounter(visitCount())),
  );
}
