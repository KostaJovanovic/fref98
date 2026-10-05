// Audit B10 regressions: dead code, dead settings and dead CSS stay gone.
import { describe, expect, it } from 'vitest';
import { PROJECT_EXT, OLD_PROJECT_EXT, PROJECT_NAME_EXT } from '../src/brand';
import { defaultSettings, normalizeSettings } from '../src/settings';
import { fitSize } from '../src/engine/importer';

// the sources as text, by their path under web/ (vitest turns CSS imports into empty strings, so fs it is)
const { readFileSync, readdirSync } = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
  readFileSync(p: URL, enc: 'utf8'): string;
  readdirSync(p: URL): string[];
};
const file = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const CSS_DIR = new URL('../src/ui/css/', import.meta.url);
const css: Record<string, string> = Object.fromEntries(readdirSync(CSS_DIR).map((f) => [f, readFileSync(new URL(f, CSS_DIR), 'utf8')]));
const allCss = Object.values(css).join('\n');

describe('project file names use the brand constants (04-23)', () => {
  it('strips .rfg, .jpegit and .zip, in any case, and nothing else', () => {
    const strip = (n: string) => n.replace(PROJECT_NAME_EXT, '');
    expect(strip('Holiday' + PROJECT_EXT)).toBe('Holiday');
    expect(strip('Old' + OLD_PROJECT_EXT.toUpperCase())).toBe('Old');
    expect(strip('backup.ZIP')).toBe('backup');
    expect(strip('photo.jpg')).toBe('photo.jpg');
    // the dot is literal: "xrfg" is not an extension
    expect(strip('notxrfg')).toBe('notxrfg');
  });
});

describe('settings with no UI are gone (04-15)', () => {
  it('has no keepOriginal, importProfile or wallpaperPhoto', () => {
    const d = defaultSettings() as unknown as Record<string, unknown>;
    for (const k of ['keepOriginal', 'importProfile', 'wallpaperPhoto']) expect(d).not.toHaveProperty(k);
  });
  it('still reads an old stored object (the load step drops the unknown keys)', () => {
    const s = normalizeSettings({ keepOriginal: true, scheme: 'standard', fill: 'black' });
    expect(s.fill).toBe('black');
    expect(s.scheme).toBe('standard');
  });
  it('imports are always fitted to the camera frame (keepOriginal never had a switch)', () => {
    expect(fitSize(4000, 3000, 2272, 1704)).toEqual([2272, 1704]);
    expect(fitSize(800, 600, 2272, 1704)).toEqual([800, 600]);
  });
});

describe('dead CSS stays gone (03-6, 03-10, 04-22)', () => {
  it('has one phone slider rule, at the 2× thumb', () => {
    expect(css['phone.css']).not.toMatch(/input\[type='range'\]/);
    expect(css['controls.css']).toMatch(/#app\.phone input\[type='range'\]::-webkit-slider-thumb \{\s*width: 22px;\s*height: 42px;/);
  });
  it('drops the selectors nothing creates', () => {
    for (const sel of [/^\.thumbs?\b/m, /^\.thumb\./m, /\.legend-sw\b/, /\.sm-item\b/, /\.card-tile\b/, /\.foldy-balloon\b/, /^\.balloon\b/m, /\.sr-only\b/, /^\.ok \{/m, /\.mck\.narrow/, /\.xw-band \+ \.xw-band/, /\.wall\.tiles/, /--z-balloon/])
      expect(allCss, String(sel)).not.toMatch(sel);
  });
  it('declares the .xw-web padding once (in the rule it shares with .fv)', () => {
    expect(css['apps.css'].match(/^\.xw-web \{/gm) ?? []).toHaveLength(1);
    expect(css['apps.css']).toMatch(/^\.fv,\r?\n\.xw-web \{/m);
  });
});

describe('dead exports stay gone (01-21, 02-5, 04-10, 06-17, 07-12)', () => {
  const src = (p: string) => file('src/' + p);
  it('removed helpers are not defined any more', () => {
    expect(src('ui/art.ts')).not.toMatch(/function frameSprite\b|export function dither\(/);
    expect(src('ui/controls.ts')).not.toMatch(/function statusPane/);
    expect(src('apps/tools98.ts')).not.toMatch(/canvasText|export const CRT_/);
    expect(src('engine/importer.ts')).not.toMatch(/shrinkJpeg|settings\./);
    expect(src('engine/types.ts')).not.toMatch(/hasExport/);
    expect(src('engine/worker.ts')).not.toMatch(/'ping'|'encodeLike'/);
    expect(src('state.ts')).not.toMatch(/replacePhotoBytes/);
    expect(src('pipeline.ts')).not.toMatch(/refreshCaps/);
    expect(src('shell/desktop.ts')).not.toMatch(/DELETABLE|deleteSelected/);
  });
  it('the bus only names events something emits', () => {
    const bus = src('bus.ts');
    for (const ev of ['stack-changed', 'clean', 'decode-events', 'step-added']) expect(bus).not.toContain(`'${ev}'`);
  });
  it('pieChart no longer promises an outline it never draws', () => {
    expect(src('apps/tools98.ts')).not.toMatch(/strokeStyle/);
  });
  it('registry and shell are imported statically (04-11: no build warning)', () => {
    expect(src('importflow.ts')).not.toMatch(/import\('\.\/apps\/registry'\)/);
    expect(src('apps/editor.ts') + src('apps/export.ts')).not.toMatch(/import\('\.\.\/shell\/shell'\)/);
  });
});

describe('the debug handle is opt-in (04-29)', () => {
  it('main.ts sets __refrag only in dev builds or with ?debug, and lists the registry ids (12-16)', () => {
    const main = file('src/main.ts');
    expect(main).toMatch(/if \(import\.meta\.env\.DEV \|\| new URLSearchParams\(location\.search\)\.has\('debug'\)\)\s*\n\s*\(window as any\)\.__refrag = \{[^}]*apps: Object\.keys\(APPS\)/);
  });
});

describe('build scripts (12-7)', () => {
  it('wasm.mjs runs without a shell and explains a missing tool', () => {
    const w = file('scripts/wasm.mjs');
    expect(w).toMatch(/shell: false/);
    expect(w).toMatch(/r\.error\.message/);
  });
});
