// "Set as Wallpaper": a snapshot of a picture for the desktop (wallpaper mode "photo"). Unlike the live
// "My broken photo" wallpaper it doesn't follow later edits. Kept in memory and in localStorage (as a data URL,
// downscaled to desktop size) so it survives a reload; the sky (shell/sky.ts) reads it.
import { setSettings } from '../settings';

const KEY = 'refragmenter.wallpaper.v1';
const MAX = 1920; // longest side kept; the wallpaper is drawn at half resolution and dithered anyway
const BUDGET = 2_500_000; // characters of data URL we are willing to put in localStorage

export interface WallpaperImage {
  src: CanvasImageSource;
  w: number;
  h: number;
  /** Changes whenever a new picture is set (cache key for the desktop). */
  version: number;
}

let img: HTMLCanvasElement | HTMLImageElement | null = null;
let version = 0;
let loading: Promise<void> | null = null;

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function wrap(i: HTMLCanvasElement | HTMLImageElement): WallpaperImage {
  const w = i instanceof HTMLImageElement ? i.naturalWidth : i.width;
  const h = i instanceof HTMLImageElement ? i.naturalHeight : i.height;
  return { src: i, w, h, version };
}

/** A picture was set with "Set as Wallpaper" (in this session or an earlier one). */
export function hasWallpaperImage(): boolean {
  return !!img || !!stored();
}

/** The picture set with "Set as Wallpaper", or null. */
export async function wallpaperImage(): Promise<WallpaperImage | null> {
  if (img) return wrap(img);
  const url = stored();
  if (!url) return null;
  loading ??= new Promise<void>((res) => {
    const i = new Image();
    i.onload = () => {
      if (!img) {
        img = i;
        version++;
      }
      res();
    };
    i.onerror = () => res();
    i.src = url;
  });
  await loading;
  return img ? wrap(img) : null;
}

/** Puts `src` on the desktop (a copy: later edits don't change it) and switches the wallpaper to "photo". */
export function setWallpaperImage(src: HTMLCanvasElement) {
  const s = Math.min(1, MAX / Math.max(src.width, src.height, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * s));
  c.height = Math.max(1, Math.round(src.height * s));
  const x = c.getContext('2d')!;
  x.imageSmoothingEnabled = s < 1;
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, c.width, c.height);
  img = c;
  loading = null;
  version++;
  try {
    let url = c.toDataURL('image/png');
    if (url.length > BUDGET) url = c.toDataURL('image/jpeg', 0.9);
    if (url.length > BUDGET) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, url);
  } catch {
    /* storage full or blocked: the wallpaper lasts for this session only */
  }
  setSettings({ wallpaper: 'photo' });
}

/** Forgets the picture (the "photo" wallpaper follows the editor again). */
export function clearWallpaperImage() {
  img = null;
  loading = null;
  version++;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
