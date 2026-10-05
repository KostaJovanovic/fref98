// Audit B11 regressions: the docs and scripts say what the code does.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script without types
import { NAMED, fontCodepoints, glyphKey } from '../scripts/glyphs.mjs';

const { readFileSync } = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: URL, enc: 'utf8'): string };
/** A file by its path from the repo root. */
const repo = (p: string) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

describe("audit.mjs reads the font's named glyphs (12-15)", () => {
  const src = repo('web/scripts/glyphs.txt');
  it('č, ć, š, ž, đ and their capitals are in the font, not c/s/z/d twice', () => {
    const have = fontCodepoints(src);
    for (const ch of 'čćšžđČĆŠŽĐ') expect(have.has(ch.codePointAt(0)!), ch).toBe(true);
  });
  it('every glyph key is one build_font.py accepts', () => {
    const keys = src.split(/\r?\n/).filter((l) => l.startsWith('= ')).map((l) => l.slice(2).trim());
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.filter((k) => glyphKey(k) === null)).toEqual([]);
  });
  it('uses the same NAMED table as build_font.py', () => {
    const py = repo('web/scripts/build_font.py');
    const table = /NAMED = \{([^}]*)\}/.exec(py)![1];
    const pyNamed = Object.fromEntries([...table.matchAll(/'(\w+)': 0x([0-9A-Fa-f]+)/g)].map((m) => [m[1], parseInt(m[2], 16)]));
    expect(NAMED).toEqual(pyNamed);
  });
});

describe('docs match the code (10-6, 12-9, 12-10, 04-30, 07-16)', () => {
  it('ENGINE_API lists no option that does not exist and the "fat" carve tool', () => {
    const api = repo('docs/ENGINE_API.md');
    expect(api).not.toContain('keep_exif_from');
    expect(api).not.toContain('"keep\n  original"');
    expect(api).toMatch(/tool: "photorec"\|"graft"\|"fat"\|/);
  });
  it('the asset licences name files that exist, and no photos are claimed', () => {
    expect(repo('web/LICENSES-ASSETS.md')).not.toContain('src/foldy/sprite.ts');
    expect(repo('web/LICENSES-ASSETS.md')).toContain('src/assets/foldy/foldy.png');
    expect(repo('README.md')).toMatch(/No photos are bundled yet/);
  });
  it('PLAN.md starts with the current state and drops the Classic grey promise', () => {
    const plan = repo('PLAN.md');
    expect(plan.indexOf('## Current state')).toBeLessThan(plan.indexOf('## Guiding principle'));
    expect(plan).not.toMatch(/a high-contrast "Classic grey" theme, reduced motion/);
  });
});

describe('scripts (12-19)', () => {
  it('package.json says where the version lives and has the audit scripts', () => {
    const pkg = JSON.parse(repo('web/package.json'));
    expect(pkg.description).toMatch(/version\.ts/);
    expect(pkg.scripts.audit).toBe('node scripts/audit.mjs');
    expect(pkg.scripts.uicheck).toBe('node scripts/uicheck.mjs');
  });
  it('server.bat checks --port and picks the adapter with a gateway', () => {
    const bat = repo('server.bat');
    expect(bat).toMatch(/--port needs a port number/);
    expect(bat).toMatch(/IPv4DefaultGateway/);
  });
});
