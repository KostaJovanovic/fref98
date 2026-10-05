// The Windows 98 Start menu: one column with the vertical "File Refragmenter 98 Gold" banner, 32 px rows with
// large icons, cascading Programs ▸ / Documents ▸ / Settings ▸ (ui/menu.ts does the cascading, hover timing and
// keyboard; this module dresses its root level as the Start menu), and the Shut Down dialog.
import { h, download } from '../ui/dom';
import { iconImg } from '../ui/art';
import { ui, uiRect } from '../ui/scale';
import { menuAt, menuLayer, type MenuItem } from '../ui/menu';
import { drawText, textWidth } from '../ui/pixeltext';
import { radio } from '../ui/controls';
import { windows } from '../ui/wm';
import { errorBox, message } from '../ui/dialog';
import { APPS, openApp } from '../apps/registry';
import { PRESETS } from '../presets';
import { store } from '../state';
import { clearWallpaperImage } from './wallpaper';
import { settings, setSettings } from '../settings';
import { resetSamples, ensureSamples } from '../importflow';
import { loadRecent, rememberProject, forgetRecent, recentProjects, recentZip } from './recent';
import { PROJECT_EXT } from '../brand';
import { safeFileName } from '../filenames';
import * as bus from '../bus';

export { rememberProject };

/** Saves the project as a download (and in Documents ▸ recent projects). The one place that does it: Save As
 *  with the project type comes here too. */
export async function saveProject(name = safeFileName(store.doc.name || 'Untitled')) {
  const zip = store.projectZip();
  download(zip, name + PROJECT_EXT, 'application/zip');
  bus.emit('exported');
  await rememberProject(name, zip);
}

async function openRecent(name: string) {
  const zip = await recentZip(name);
  if (!zip) return errorBox('That project is no longer stored.');
  try {
    await store.loadProjectZip(zip);
    void openApp('editor');
  } catch (e) {
    errorBox(String((e as Error).message));
  }
}

// ------------------------------------------------------------------ items

/** Apps under Programs ▸ Accessories ▸ (when they exist in the registry). */
const ACCESSORIES = ['hex', 'webcam', 'video'];
/** Registry apps that live elsewhere in the Start menu (Settings, Help) or on the desktop only. */
const NOT_PROGRAMS = new Set(['recycle', 'display', 'help', 'about', 'presets', 'export', ...ACCESSORIES]);

const appItem = (id: string): MenuItem => ({ label: APPS[id].title.replace(/&/g, '&&'), icon: APPS[id].icon, onClick: () => void openApp(id) });

function programs(): MenuItem[] {
  const acc = ACCESSORIES.filter((id) => APPS[id]);
  const apps = Object.keys(APPS)
    .filter((id) => !NOT_PROGRAMS.has(id))
    .sort((a, b) => APPS[a].title.localeCompare(APPS[b].title));
  return [
    ...(acc.length ? [{ label: '&Accessories', icon: 'folder', sub: () => acc.map(appItem) }] : []),
    {
      label: '&Presets',
      icon: 'presets',
      // the gallery window first (when the registry has it), then each preset straight into the editor
      sub: () => [
        ...(APPS.presets ? [{ ...appItem('presets'), label: 'All Presets', default: true }, { sep: true }] : []),
        ...PRESETS.map((p) => ({ label: p.title.replace(/&/g, '&&'), icon: p.icon, onClick: () => void openApp('editor', { preset: p.id }) })),
      ],
    },
    ...apps.map(appItem),
  ];
}

function documents(): MenuItem[] {
  return [
    ...(APPS.pictures ? [{ label: 'My &Pictures', icon: 'pictures', onClick: () => void openApp('pictures') }, { sep: true }] : []),
    ...(recentProjects().length ? recentProjects().map((r) => ({ label: r.name.replace(/&/g, '&&'), icon: 'project', onClick: () => void openRecent(r.name) })) : [{ label: '(Empty)', disabled: true }]),
  ];
}

export function taskbarProperties() {
  message(
    'Taskbar Properties',
    'The taskbar stays on top and never hides, the way it came out of the box.\n\nWallpaper, clouds and the screen saver are in Display Properties.',
    'info',
  );
}

function startItems(): MenuItem[] {
  return [
    ...(APPS.editor ? [{ label: 'File Refragmenter 98 &Gold', icon: APPS.editor.icon, onClick: () => void openApp('editor') }, { sep: true }] : []),
    { label: '&Programs', icon: 'folder', sub: programs },
    { label: '&Documents', icon: 'project', sub: documents },
    {
      label: '&Settings',
      icon: 'display',
      sub: [
        ...(APPS.display ? [{ label: '&Display', icon: 'display', onClick: () => void openApp('display') }] : []),
        { label: '&Taskbar && Start Menu…', icon: 'folder', onClick: taskbarProperties },
      ],
    },
    { label: '&Help', icon: 'help', onClick: () => void openApp('help') },
    { sep: true },
    { label: 'Sh&ut Down…', icon: 'shutdown', onClick: shutDown },
  ];
}

// ------------------------------------------------------------------ the menu

let closedAt = -1e9;
let close: (() => void) | null = null;

export function isStartOpen(): boolean {
  return !!close;
}

/** Opens (or closes) the Start menu above the Start button. */
export function toggleStartMenu(btn: HTMLElement, keyboard = false) {
  if (close) return close();
  // the press that closed the menu (menu.ts closes it on pointerdown) must not reopen it
  if (performance.now() - closedAt < 80) return;
  void loadRecent();
  const layer = menuLayer();
  if (!layer) return;
  const items = startItems();
  btn.classList.add('open');
  layer.classList.add('sm-open');
  close = menuAt(btn, items, {
    label: 'Start menu',
    keyboard,
    onClose: () => {
      btn.classList.remove('open');
      layer.classList.remove('sm-open');
      close = null;
      closedAt = performance.now();
    },
  });
  const root = layer.querySelector<HTMLElement>(':scope > .menu');
  if (root) dress(root, items, btn);
}

/** Turns menu.ts's root level into the 98 Start menu: banner, 32 px rows, 24 px icons, sitting on the taskbar. */
function dress(root: HTMLElement, items: MenuItem[], btn: HTMLElement) {
  root.classList.add('startmenu');
  root.style.minWidth = '';
  const rows = [...root.querySelectorAll<HTMLElement>(':scope > .mi')];
  const real = items.filter((it) => !it.sep && !it.separator && !it.head);
  rows.forEach((row, i) => {
    const ic = real[i]?.icon;
    const slot = row.querySelector('.mck');
    if (ic && slot) slot.replaceChildren(iconImg(ic, 24));
  });
  const H = root.offsetHeight;
  const bar = btn.closest('.taskbar');
  const top = bar ? uiRect(bar).y : ui.h - 28;
  root.style.left = '0px';
  root.style.top = Math.max(0, Math.round(top - H + 1)) + 'px';
  root.prepend(banner(Math.max(1, H - 6)));
}

/** The vertical banner: navy → blue from the bottom, the product name in the bold pixel font, read upwards. */
function banner(height: number): HTMLCanvasElement {
  const W = 21;
  const c = h('canvas', { class: 'sm-banner', width: W, height, 'aria-hidden': 'true' });
  c.style.height = height + 'px';
  const x = c.getContext('2d')!;
  const g = x.createLinearGradient(0, height, 0, 0);
  g.addColorStop(0, '#000080');
  g.addColorStop(1, '#1084d0');
  x.fillStyle = g;
  x.fillRect(0, 0, W, height);
  // rotate -90°: text runs from the bottom up, glyph tops toward the left edge
  x.save();
  x.translate(0, height);
  x.rotate(-Math.PI / 2);
  const a = 'File Refragmenter';
  const b = ' 98 Gold';
  const room = height - 8;
  if (textWidth(a + b, true) <= room) {
    const w = drawText(x, a, 6, 4, '#c0c0c0', { bold: true });
    drawText(x, b, 6 + w, 4, '#ffffff', { bold: true });
  } else drawText(x, '98 Gold', 6, 4, '#ffffff', { bold: true });
  x.restore();
  return c;
}

// ------------------------------------------------------------------ Shut Down

/** The 98 "Shut Down Windows" box, with our own choices. The screen behind it is dithered, as in 98, but
 *  nothing is blocked. */
export function shutDown() {
  let choice: 'close' | 'restart' | 'clear' = 'close';
  const body = h(
    'div',
    { class: 'col shutdown-opts' },
    h('div', null, 'What do you want File Refragmenter to do?'),
    radio('sd', 'Close all windows', true, () => (choice = 'close')),
    radio('sd', 'Restart', false, () => (choice = 'restart')),
    radio('sd', 'Shut down (forget this session)', false, () => (choice = 'clear')),
  );
  const desk = document.querySelector<HTMLElement>('.desktop');
  const dim = h('div', { class: 'shutdown-dim', 'aria-hidden': 'true' });
  const w = message(
    'Shut Down File Refragmenter',
    body,
    'shutdown',
    [
      { label: 'OK', primary: true, run: () => void doShutDown(choice) },
      { label: 'Cancel' },
      { label: 'Help', run: () => void openApp('help') },
    ],
    { onClose: () => dim.remove() },
  );
  if (desk && w.el.parentElement === desk) {
    dim.style.zIndex = w.el.style.zIndex;
    desk.insertBefore(dim, w.el);
  }
}

async function doShutDown(choice: 'close' | 'restart' | 'clear') {
  // the box closes after its button runs: close the rest on the next turn
  await new Promise((r) => setTimeout(r, 0));
  if (choice === 'restart') return location.reload();
  for (const w of windows()) w.close();
  if (choice === 'clear') {
    await store.clearSession();
    await forgetRecent();
    clearWallpaperImage();
    // the desktop redraws without the forgotten picture
    if (settings.wallpaper === 'photo') setSettings({ wallpaper: 'photo' });
    resetSamples();
    void ensureSamples();
    message('File Refragmenter', 'It is now safe to turn off your computer.\n\n(Just kidding. The session was forgotten; you can keep going.)', 'shutdown');
  }
}
