// User preferences (localStorage). Session content lives in IndexedDB (see engine/storage.ts).
import type { FoldyTiming } from './foldy/timeline';

export type Wallpaper = 'sky' | 'solid' | 'tiles' | 'photo';

export interface Settings {
  uiScale: 'auto' | 1 | 2 | 3;
  bigText: 'auto' | boolean;
  wallpaper: Wallpaper;
  solidColor: string;
  cloudSpeed: number; // 0..3
  screensaver: { enabled: boolean; minutes: number; kind: 'starfield' | 'folders' };
  foldy: { enabled: boolean; glitches: boolean; tutorialDone: boolean; expertIntroDone?: boolean };
  /** Foldy's animation timing as tuned in the hidden Ctrl+Shift+F panel (only the changed values; see
   *  foldy/timeline.ts DEFAULT_TIMING for the rest). */
  foldyTiming: Partial<FoldyTiming>;
  expert: boolean;
  personality: 'libjpeg' | 'browser' | 'gdiplus';
  /** How the preview decoder fills blocks that never received data. */
  fill: 'grey' | 'repeat' | 'black' | 'donor';
  /** Pool photo shown in never-reached blocks with fill "donor" (empty = the next photo in the pool). */
  fillDonor?: string;
  keepOriginal: boolean;
  importProfile: string;
  stripPrivateExif: boolean;
  embedRecipe: boolean;
  reducedMotion: 'auto' | boolean;
  wallpaperPhoto?: string; // pool uid
  /** Desktop icon cells [column, row] on the 75×75 grid, by registry id (missing = next free cell). */
  iconPos: Record<string, [number, number]>;
  /** Desktop icon labels the user renamed with F2, by registry id (the app itself keeps its name). */
  iconNames: Record<string, string>;
  /** Desktop ▸ Arrange Icons ▸ Auto Arrange. */
  autoArrange: boolean;
}

const DEFAULTS: Settings = {
  uiScale: 'auto',
  bigText: 'auto',
  wallpaper: 'sky',
  solidColor: '#3a6fc4',
  cloudSpeed: 1,
  screensaver: { enabled: true, minutes: 5, kind: 'starfield' },
  foldy: { enabled: true, glitches: true, tutorialDone: false },
  foldyTiming: {},
  expert: false,
  personality: 'libjpeg',
  fill: 'grey',
  keepOriginal: false,
  importProfile: '',
  stripPrivateExif: true,
  embedRecipe: false,
  reducedMotion: 'auto',
  iconPos: {},
  iconNames: {},
  autoArrange: false,
};

/** Every setting this version stores (the optional ones have no default). */
const OPTIONAL: (keyof Settings)[] = ['fillDonor', 'wallpaperPhoto'];
const KNOWN = new Set<string>([...Object.keys(DEFAULTS), ...OPTIONAL]);

const KEY = 'refragmenter.settings.v1';
const OLD_KEY = 'jpegit.settings.v1'; // before the rename
try {
  const old = localStorage.getItem(OLD_KEY);
  if (old !== null) {
    if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, old);
    localStorage.removeItem(OLD_KEY);
  }
} catch {
  /* storage may be blocked */
}
type Listener = (s: Settings, changed: (keyof Settings)[]) => void;
const listeners = new Set<Listener>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // keys this version doesn't know (v0.18 cut the Classic theme's 'theme', …) are dropped, in storage too
      const foreign = s && typeof s === 'object' ? Object.keys(s).filter((k) => !KNOWN.has(k)) : [];
      if (foreign.length) {
        for (const k of foreign) delete s[k];
        try {
          localStorage.setItem(KEY, JSON.stringify(s));
        } catch {
          /* ignore */
        }
      }
      return {
        ...DEFAULTS,
        ...s,
        screensaver: { ...DEFAULTS.screensaver, ...(s.screensaver ?? {}) },
        foldy: { ...DEFAULTS.foldy, ...(s.foldy ?? {}) },
        foldyTiming: s.foldyTiming && typeof s.foldyTiming === 'object' ? s.foldyTiming : {},
        iconPos: s.iconPos && typeof s.iconPos === 'object' ? s.iconPos : {},
        iconNames: s.iconNames && typeof s.iconNames === 'object' ? s.iconNames : {},
      };
    }
  } catch {
    /* storage may be blocked */
  }
  return JSON.parse(JSON.stringify(DEFAULTS));
}

export const settings: Settings = load();
/** What is in storage. Differs from `settings` only while a dialog previews unapplied changes. */
const saved: Settings = JSON.parse(JSON.stringify(settings));

export function setSettings(patch: Partial<Settings>) {
  const changed = Object.keys(patch) as (keyof Settings)[];
  Object.assign(settings, patch);
  Object.assign(saved, JSON.parse(JSON.stringify(patch)));
  persist();
  for (const l of listeners) l(settings, changed);
}

/** Changes some fields of an object setting. The stored value gets them on top of what is stored and the live
 *  one on top of what is shown, so another dialog's unapplied preview is neither stored nor lost. */
export function setSubSettings<K extends 'foldy' | 'screensaver'>(k: K, patch: Partial<Settings[K]>) {
  (saved as any)[k] = { ...saved[k], ...JSON.parse(JSON.stringify(patch)) };
  (settings as any)[k] = { ...settings[k], ...patch };
  persist();
  for (const l of listeners) l(settings, [k]);
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* ignore */
  }
}

/** Shows a change live without storing it (Display Properties before OK/Apply). `setSettings` stores it,
 *  `revertPreview` takes it back. */
export function previewSettings(patch: Partial<Settings>) {
  const changed = Object.keys(patch) as (keyof Settings)[];
  Object.assign(settings, patch);
  for (const l of listeners) l(settings, changed);
}

/** Puts the stored values of `keys` back (Cancel in a dialog that previewed them). */
export function revertPreview(keys: (keyof Settings)[]) {
  const patch: Partial<Settings> = {};
  for (const k of keys) (patch as any)[k] = JSON.parse(JSON.stringify(saved[k] ?? null)) ?? undefined;
  previewSettings(patch);
}

/** The stored (applied) value of a setting. */
export function savedSetting<K extends keyof Settings>(k: K): Settings[K] {
  return JSON.parse(JSON.stringify(saved[k] ?? null)) ?? undefined;
}

/** A fresh copy of the defaults. */
export function defaultSettings(): Settings {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

export function onSettings(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function resetSettings() {
  setSettings(JSON.parse(JSON.stringify(DEFAULTS)));
}

export function reducedMotion(): boolean {
  if (settings.reducedMotion !== 'auto') return settings.reducedMotion;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
