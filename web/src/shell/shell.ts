// The fake Windows 98 desktop, assembled: desktop (icons, sky, windows), taskbar (Start, tasks, tray) and the
// global shortcuts. The parts live in desktop.ts, taskbar.ts, startmenu.ts and tray.ts.
import { h } from '../ui/dom';
import { initWm } from '../ui/wm';
import { setMenuLayer, closeMenu } from '../ui/menu';
import { Sky } from './sky';
import { foldy } from '../foldy/foldy';
import { store } from '../state';
import { startScreensaverWatch } from './screensaver';
import { buildDesktop } from './desktop';
import { buildTaskbar, taskbarRect } from './taskbar';

export function buildShell(app: HTMLElement) {
  const desktop = h('div', { class: 'desktop', role: 'main', 'aria-label': 'Desktop' });
  const taskbar = buildTaskbar();
  app.append(desktop, taskbar);
  setMenuLayer(app);
  initWm(desktop, { taskbarRect });
  new Sky(desktop);
  buildDesktop(desktop);
  foldy.init(desktop);
  startScreensaverWatch(app);

  // global shortcuts
  addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const t = e.target as HTMLElement;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (mod && !typing && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if (mod && !typing && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      store.redo();
    } else if (e.key === 'Escape') closeMenu();
  });
}
