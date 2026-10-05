import { describe, it, expect } from 'vitest';
import { placeAtPoint, placeBelow, placeSubmenu, clampTip, parseMnemonic, mnemonicKey, nextIndex, typeAhead, contextCandidates, spinStep, tickXs } from '../src/ui/uimath';

// 03-18: trackbar ticks came from a repeating gradient at 100%/n, so they landed between pixels and smeared
describe('trackbar ticks', () => {
  it('sit on whole pixels from the first thumb centre to the last', () => {
    for (const [w, n] of [[150, 4], [173, 7], [100, 3], [12, 1]]) {
      const xs = tickXs(w, n);
      expect(xs.length).toBe(n + 1);
      expect(xs[0]).toBe(5);
      expect(xs[n]).toBe(w - 6);
      for (const x of xs) expect(Number.isInteger(x)).toBe(true);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    }
    expect(tickXs(10, 4)).toEqual([]);
  });
});

const W = 800;
const H = 600;

describe('menu placement', () => {
  it('opens a context menu right and below the point when it fits', () => {
    expect(placeAtPoint(100, 100, 150, 200, W, H)).toEqual({ x: 100, y: 100 });
  });
  it('flips left and up at the screen edges', () => {
    expect(placeAtPoint(750, 500, 150, 200, W, H)).toEqual({ x: 600, y: 300 });
  });
  it('shifts instead of flipping when the flip would leave the screen too', () => {
    expect(placeAtPoint(100, 500, 150, 580, W, 600)).toEqual({ x: 100, y: 20 });
    expect(placeAtPoint(60, 10, 780, 10, W, H)).toEqual({ x: 20, y: 10 });
  });
  it('drops a menu-bar menu below its title, above it near the bottom, and shifts it left at the right edge', () => {
    const a = { x: 10, y: 40, w: 30, h: 18 };
    expect(placeBelow(a, 150, 200, W, H)).toEqual({ x: 10, y: 58, above: false });
    const low = { x: 700, y: 560, w: 60, h: 21 };
    expect(placeBelow(low, 150, 100, W, H)).toEqual({ x: 650, y: 460, above: true });
  });
  it('cascades a submenu beside its parent, overlapping the frame', () => {
    const parent = { x: 100, y: 100, w: 160, h: 200 };
    const item = { x: 103, y: 140, w: 154, h: 17 };
    expect(placeSubmenu(item, parent, 140, 80, W, H)).toEqual({ x: 257, y: 137, left: false });
  });
  it('flips a submenu to the left of its parent at the right edge', () => {
    const parent = { x: 620, y: 100, w: 160, h: 200 };
    const item = { x: 623, y: 140, w: 154, h: 17 };
    expect(placeSubmenu(item, parent, 140, 80, W, H)).toEqual({ x: 483, y: 137, left: true });
  });
  it('moves a submenu up when it would run off the bottom', () => {
    const parent = { x: 100, y: 400, w: 160, h: 190 };
    const item = { x: 103, y: 570, w: 154, h: 17 };
    expect(placeSubmenu(item, parent, 140, 120, W, H).y).toBe(480);
  });
});

describe('tooltip clamping', () => {
  it('sits under the cursor', () => {
    expect(clampTip(100, 100, 80, 18, W, H)).toEqual({ x: 100, y: 120 });
  });
  it('stays inside the right edge and goes above the cursor at the bottom', () => {
    expect(clampTip(790, 590, 80, 18, W, H)).toEqual({ x: 720, y: 570 });
  });
  it('never goes off the top-left', () => {
    expect(clampTip(-5, 5, 900, 700, W, H)).toEqual({ x: 0, y: 0 });
  });
});

describe('mnemonics and keyboard helpers', () => {
  it('parses & mnemonics and && literals', () => {
    expect(parseMnemonic('&File')).toEqual({ text: 'File', index: 0, key: 'f' });
    expect(parseMnemonic('Mi&nimize')).toEqual({ text: 'Minimize', index: 2, key: 'n' });
    expect(parseMnemonic('Save && Exit')).toEqual({ text: 'Save & Exit', index: -1, key: '' });
    expect(mnemonicKey('Properties')).toBe('p');
  });
  it('skips separators when stepping and wraps around', () => {
    const ok = (i: number) => i !== 1;
    expect(nextIndex(3, 0, 1, ok)).toBe(2);
    expect(nextIndex(3, 2, 1, ok)).toBe(0);
    expect(nextIndex(3, 0, -1, ok)).toBe(2);
    expect(nextIndex(2, 0, 1, () => false)).toBe(-1);
  });
  it('type-ahead cycles on a repeated letter and matches prefixes', () => {
    const l = ['FAT16', 'FAT32', 'exFAT'];
    expect(typeAhead(l, 0, 'f')).toBe(1);
    expect(typeAhead(l, 1, 'f')).toBe(0);
    expect(typeAhead(l, 0, 'fat3')).toBe(1);
    expect(typeAhead(l, 0, 'e')).toBe(2);
    expect(typeAhead(l, 0, 'z')).toBe(-1);
  });
  it('spin buttons step on the grid and clamp', () => {
    expect(spinStep(5, 1)).toBe(6);
    expect(spinStep(0.3, 1, 0.1)).toBe(0.4);
    expect(spinStep(10, 1, 1, 0, 10)).toBe(10);
    expect(spinStep(1, -1, 1, 1)).toBe(1);
    expect(spinStep(2.5, 1, 2, 0)).toBe(4);
  });
});

describe('context menu target resolution', () => {
  // a fake tree: span.lbl inside button.tool inside div.win-body inside section.win
  const chain = [{ tag: 'span', cls: ['lbl'] }, { tag: 'button', cls: ['tool'] }, { tag: 'div', cls: ['win-body'] }, { tag: 'section', cls: ['win'] }];
  const matches = (el: { tag: string; cls: string[] }, sel: string) => (sel.startsWith('.') ? el.cls.includes(sel.slice(1)) : el.tag === sel);
  const e = (selector: string, order: number) => ({ selector, build: selector, order });

  it('the deepest matching element wins', () => {
    const c = contextCandidates(chain, [e('.win', 1), e('.tool', 2), e('.win-body', 3)], matches);
    expect(c.map((x) => x.entry.selector)).toEqual(['.tool', '.win-body', '.win']);
  });
  it('on the same element the latest registration wins', () => {
    const c = contextCandidates(chain, [e('button', 1), e('.tool', 2)], matches);
    expect(c[0].entry.selector).toBe('.tool');
    expect(c[1].entry.selector).toBe('button');
  });
  it('returns nothing when no surface matches', () => {
    expect(contextCandidates(chain, [e('.desktop', 1)], matches)).toEqual([]);
  });
});
