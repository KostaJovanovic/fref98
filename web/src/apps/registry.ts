// Every tool window, opened by id (desktop icons, Start menu, taskbar, deep links).
import { errorBox } from '../ui/dialog';

export interface AppInfo {
  title: string;
  short: string;
  icon: string;
  load: () => Promise<{ open: (arg?: any) => void }>;
}

export const APPS: Record<string, AppInfo> = {
  editor: { title: 'File Refragmenter 98 Gold', short: 'Editor', icon: 'editor', load: () => import('./editor') },
  pictures: { title: 'My Pictures', short: 'Pictures', icon: 'pictures', load: () => import('./pictures') },
  card: { title: 'Removable Disk (E:)', short: 'Disk (E:)', icon: 'disk', load: () => import('./card') },
  presets: { title: 'Presets', short: 'Presets', icon: 'presets', load: () => import('./presetsgallery') },
  recycle: { title: 'Recycle Bin', short: 'Bin', icon: 'recycle', load: () => import('./recycle') },
  help: { title: 'Help and Support', short: 'Help', icon: 'help', load: () => import('./help') },
  about: { title: 'About File Refragmenter', short: 'About', icon: 'about', load: () => import('./help').then((m) => ({ open: (a?: any) => m.openAbout(a) })) },
  display: { title: 'Display Properties', short: 'Display', icon: 'display', load: () => import('./display') },
  hex: { title: 'Hex Doctor', short: 'Hex', icon: 'hex', load: () => import('./hex') },
  webcam: { title: 'Camera Wizard', short: 'Webcam', icon: 'webcam', load: () => import('./webcam') },
  video: { title: 'Video Lab', short: 'Video', icon: 'video', load: () => import('./video') },
  export: { title: 'Save As', short: 'Export', icon: 'export', load: () => import('./export') },
};

export async function openApp(id: keyof typeof APPS | string, arg?: unknown) {
  const app = APPS[id];
  if (!app) return;
  try {
    const m = await app.load();
    m.open(arg);
  } catch (e) {
    console.error(e);
    errorBox(`Could not open ${app.title}: ${(e as Error).message ?? e}`);
  }
}
