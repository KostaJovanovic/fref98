// Audit B8 regressions: pure helpers behind the app fixes (race guards, caches, file names, card label, colour
// depth, schemes, screen savers, Foldy's lines and typing).
import { describe, expect, it } from 'vitest';
import { LatestCache, Sequence } from '../src/latest';
import { mapSeeds, photoChoices, resolvePhotoParams, type StackNode } from '../src/engine/stack';
import { mostlyGrey, SCROLL_CAP, virtualScroll } from '../src/ui/uimath';
import { safeFileName, stripKnownExt } from '../src/filenames';
import { volumeTitle } from '../src/apps/explorer-model';
import { ditherDepth, hslToRgb, VGA16 } from '../src/ui/palette';
import { SCHEMES, schemeVars, xorWhite } from '../src/ui/scheme';
import { makeSaver, plotLine, scanStart, SAVERS } from '../src/shell/savers';
import { normalizeSettings } from '../src/settings';
import { LINE_IDS, explainEvents, jumbled, nonsense, presetLine, reaction, tip, tutorial } from '../src/foldy/lines';
import { DEFAULT_TIMING, textDelay } from '../src/foldy/timeline';
import { PRESETS } from '../src/presets';
import { link } from '../src/editor/link';
// @ts-expect-error: a plain .mjs script without types
import { readLines } from '../scripts/foldy-lines.mjs';

describe('Sequence (06-5, 06-6, 06-10: overlapping loads)', () => {
  it('only the newest ticket is fresh, and end() makes every ticket stale', () => {
    const s = new Sequence();
    const a = s.begin();
    const b = s.begin();
    expect(a.stale()).toBe(true);
    expect(b.stale()).toBe(false);
    s.end();
    expect(b.stale()).toBe(true);
  });
});

describe('LatestCache (05-26: My Pictures dimensions)', () => {
  it('keeps one entry per photo however many versions it goes through', () => {
    const c = new LatestCache<number>();
    let made = 0;
    for (let v = 1; v <= 50; v++) c.get('p1', v, () => ++made);
    expect(c.size).toBe(1);
    expect(c.get('p1', 50, () => -1)).toBe(50);
    expect(made).toBe(50);
  });
});

describe('mapSeeds (06-4: Re-roll Every Seed)', () => {
  it('re-seeds the steps inside a repeat too', () => {
    const nodes = [
      { type: 'step', uid: 'a', id: 'x', seed: 1, params: {}, enabled: true },
      { type: 'repeat', uid: 'r', seed: 2, times: 2, enabled: true, children: [{ type: 'step', uid: 'c', id: 'x', seed: 3, params: {}, enabled: true }] },
    ] as unknown as StackNode[];
    const out = mapSeeds(nodes, (s) => s + 100) as any[];
    expect(out[0].seed).toBe(101);
    expect(out[1].seed).toBe(102);
    expect(out[1].children[0].seed).toBe(103);
  });
});

describe('a deleted donor photo (stack.ts note)', () => {
  const info = { params: [{ id: 'photo', kind: 'photo' }] } as any;
  it('is sent as the next photo, and the choices say so instead of showing a blank', () => {
    expect(resolvePhotoParams({ photo: 'gone' }, info, ['a', 'b'])).toEqual({ photo: -1 });
    const opts = photoChoices('gone', [{ uid: 'a', name: 'A.jpg' }]);
    expect(opts.map((o) => o[0])).toEqual(['-1', 'a', 'gone']);
    expect(opts[2][1]).toMatch(/using the next photo/);
    expect(photoChoices('a', [{ uid: 'a', name: 'A.jpg' }])).toHaveLength(2);
  });
});

describe('link (04 note: the block selection follows the current photo)', () => {
  it('drops the picked block and highlights when another photo becomes current', () => {
    link.follow('p1');
    link.pick({ mcu: 3, rect: { x: 0, y: 0, w: 8, h: 8 } });
    link.highlight([{ x: 0, y: 0, w: 8, h: 8 }]);
    link.follow('p1');
    expect(link.picked).not.toBeNull();
    link.follow('p2');
    expect(link.picked).toBeNull();
    expect(link.highlights).toEqual([]);
  });
});

describe('virtualScroll (06-29: Hex Doctor on big files)', () => {
  it('caps the spacer and still reaches both ends', () => {
    const full = 40_000_000;
    const v = virtualScroll(full, 500);
    expect(v.spacer).toBe(SCROLL_CAP);
    expect(v.toContent(0)).toBe(0);
    expect(v.toContent(SCROLL_CAP - 500)).toBe(full - 500);
    expect(v.toScroll(full - 500)).toBe(SCROLL_CAP - 500);
    expect(virtualScroll(1000, 500).toContent(300)).toBe(300);
  });
});

describe('mostlyGrey (all_grey reaction)', () => {
  it('tells a grey-filled result from a picture', () => {
    const grey = new Uint8ClampedArray(64 * 64 * 4).fill(128);
    expect(mostlyGrey(grey)).toBe(true);
    const pic = grey.map((v, i) => (i % 4 === 0 ? (i * 7) & 255 : v));
    expect(mostlyGrey(pic)).toBe(false);
    expect(mostlyGrey(new Uint8ClampedArray(0))).toBe(false);
  });
});

describe('file names (06-19, 06-20, 06-22)', () => {
  it('keeps letters of any language and drops what file systems refuse', () => {
    expect(safeFileName('Čačak: plaža / 2004?')).toBe('Čačak_ plaža _ 2004');
    expect(safeFileName('***')).toBe('Untitled');
    expect(safeFileName('  .x.  ', 'F')).toBe('x');
  });
  it('strips only our own extensions', () => {
    expect(stripKnownExt('holiday.jpg')).toBe('holiday');
    expect(stripKnownExt('holiday.v2')).toBe('holiday.v2');
  });
});

describe('card volume label (05-16)', () => {
  it('is shown in mixed case, as 98 does', () => {
    expect(volumeTitle('CARD')).toBe('Card');
    expect(volumeTitle('MY CARD')).toBe('My Card');
  });
});

describe('colour depth (D10)', () => {
  const ramp = () => {
    const px = new Uint8ClampedArray(32 * 8 * 4);
    for (let i = 0; i < 32 * 8; i++) px.set([i & 255, (i * 3) & 255, (i * 5) & 255, 255], i * 4);
    return px;
  };
  it('16 colours uses only the VGA 16', () => {
    const px = ramp();
    ditherDepth(px, 32, 8, '16');
    const vga = new Set(VGA16.map((c) => c.join()));
    for (let i = 0; i < px.length; i += 4) expect(vga.has(`${px[i]},${px[i + 1]},${px[i + 2]}`)).toBe(true);
  });
  it('High Color snaps to 5-6-5 steps; True Color leaves the pixels alone', () => {
    const px = ramp();
    ditherDepth(px, 32, 8, 'high');
    for (let i = 0; i < px.length; i += 4) {
      expect(px[i] % 8 === 0 || px[i] === 255).toBe(true);
      expect(px[i + 1] % 4 === 0 || px[i + 1] === 255).toBe(true);
    }
    const t = ramp();
    ditherDepth(t, 32, 8, 'true');
    expect(t).toEqual(ramp());
  });
  it('hslToRgb matches CSS', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
    expect(hslToRgb(240, 1, 0.25)).toEqual([0, 0, 128]);
  });
});

describe('schemes and saver settings (D10)', () => {
  it('every scheme defines every colour, and the focus colour on a selection is its XOR', () => {
    const keys = Object.keys(SCHEMES.standard.colors).sort();
    expect(Object.keys(SCHEMES).length).toBeGreaterThanOrEqual(15);
    for (const s of Object.values(SCHEMES)) {
      expect(Object.keys(s.colors).sort()).toEqual(keys);
      for (const v of Object.values(schemeVars(s.colors))) expect(v).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(xorWhite('#000080')).toBe('#ffff7f');
  });
  it('bad saved values fall back to the defaults', () => {
    const s = normalizeSettings({ scheme: 'nope', colorDepth: '7', screensaver: { kind: 'flying-toasters', speed: 99 } });
    expect(s.scheme).toBe('standard');
    expect(s.colorDepth).toBe('256');
    expect(SAVERS.map((x) => x[0])).toContain(s.screensaver.kind);
    expect(s.screensaver.speed).toBeLessThanOrEqual(5);
    expect(normalizeSettings({ scheme: 'brick', colorDepth: '16' })).toMatchObject({ scheme: 'brick', colorDepth: '16' });
  });
});

describe('screen savers (D10, 04-18)', () => {
  it('every saver in the list can be made (drawing them is checked in uicheck)', () => {
    expect(SAVERS.map((s) => s[0])).toEqual(['starfield', 'folders', 'mystify', 'marquee', 'pipes', 'corrupt']);
    for (const [kind] of SAVERS) expect(makeSaver(kind, 64, 48, { speed: 3, text: 'Hi', rand: () => 0.5 }).codec).toBe(kind !== 'corrupt'); // the corrupting saver runs the codec itself
  });
  it('plotLine stays inside the frame; scanStart finds the scan data', () => {
    const d = new Uint8ClampedArray(10 * 10 * 4);
    plotLine(d, 10, 10, -5, -5, 20, 20, [255, 0, 0]);
    expect(d[(5 * 10 + 5) * 4]).toBe(255);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 4, 1, 2, 0xff, 0xda, 0, 3, 9, 7, 7, 0xff, 0xd9]);
    expect(scanStart(jpg)).toBe(13);
  });
});

describe("Foldy's lines (07-1, D11)", () => {
  const sheet = readLines() as { ids: string[] };
  const app = new Set([...LINE_IDS, ...PRESETS.map((p) => 'preset_' + p.id)]);
  it('the sheet and the app name the same line IDs', () => {
    expect(sheet.ids.filter((id) => !app.has(id))).toEqual([]);
    expect([...app].filter((id) => !sheet.ids.includes(id))).toEqual([]);
  });
  it('built-in lines come through the ID lookup', () => {
    expect(tutorial('tut_pick')).toMatch(/pick what happened/);
    expect(reaction('exported')).toMatch(/Saved/);
    expect(reaction('working', 'Copying…')).toBe('Copying…');
    expect(tip(() => 0)).toMatch(/^Tip:/);
    expect(nonsense(() => 0)).toBe('Did you know? Every JPEG secretly contains a very small horse.');
    expect(presetLine({ id: 'no-such', foldy: 'X' })).toBe('X');
    expect(explainEvents([])).toMatch(/decodes cleanly/);
  });
  it('a jumble keeps the words', () => {
    const t = 'one two three four';
    expect(jumbled(t, () => 0.3).split(' ').sort()).toEqual(t.split(' ').sort());
  });
});

describe("Foldy's typing (07-14)", () => {
  it('pauses after , and . ! ? at the end of a word, not inside 1.5 or at the very end', () => {
    const t = 'Hi, there. Version 1.5 ok!';
    const d = (i: number) => textDelay(t, i, DEFAULT_TIMING);
    expect(d(t.indexOf(','))).toBe(DEFAULT_TIMING.textCharMs + DEFAULT_TIMING.textCommaMs);
    expect(d(t.indexOf('.'))).toBe(DEFAULT_TIMING.textCharMs + DEFAULT_TIMING.textSentenceMs);
    expect(d(t.indexOf('1.') + 1)).toBe(DEFAULT_TIMING.textCharMs);
    expect(d(0)).toBe(DEFAULT_TIMING.textCharMs);
    expect(d(t.length - 1)).toBe(DEFAULT_TIMING.textCharMs);
  });
});
