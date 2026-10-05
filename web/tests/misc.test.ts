import { describe, it, expect } from 'vitest';
import { LruCache } from '../src/engine/cache';
import { History } from '../src/engine/history';
import { zipStore, unzip, crc32 } from '../src/engine/zip';
import { toRecipe, parseRecipe, canShareAsLink, linkRecipe, recipeToFragment, recipeFromFragment } from '../src/engine/recipe';
import { makeStep, makePatch } from '../src/engine/stack';
import { inspectJpeg, isJpeg, insertComment, stripExifFallback } from '../src/engine/jpegmeta';
import { explainEvent, explainEvents } from '../src/foldy/lines';

describe('Foldy explains decode events', () => {
  it('points at the pixel position, never calls an MCU index a row', () => {
    const t = explainEvent({ kind: 'truncated', mcu: 16676, byte: 721695, detail: '', scan: 0, comp: -1, x: 1024, y: 960 });
    expect(t).toContain('x 1024, y 960');
    expect(t).not.toMatch(/row 16676/);
  });
  it('knows the new kinds', () => {
    expect(explainEvent({ kind: 'arithmetic', mcu: -1, byte: 0, detail: '' })).toMatch(/arithmetic/);
    expect(explainEvent({ kind: 'bad_code', mcu: 3, byte: 9, detail: '', x: 16, y: 0 })).toContain('x 16, y 0');
    expect(explainEvents([])).toMatch(/cleanly/);
  });
  it('leaves out positions the engine does not know', () => {
    expect(explainEvent({ kind: 'resync', mcu: -1, byte: 5, detail: '', x: -1, y: -1 })).not.toContain('x -1');
  });
});

const b = (n: number) => new Uint8Array(n);

describe('LruCache', () => {
  it('evicts least recently used past the budget', () => {
    const c = new LruCache<Uint8Array>(10);
    c.set('a', b(4));
    c.set('b', b(4));
    c.get('a');
    c.set('c', b(4));
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.bytes).toBe(8);
  });
  it('refuses items bigger than the budget', () => {
    const c = new LruCache<Uint8Array>(3);
    c.set('x', b(4));
    expect(c.size).toBe(0);
  });
});

describe('History', () => {
  it('undo/redo', () => {
    const h = new History({ v: 0 });
    h.push({ v: 1 });
    h.push({ v: 2 });
    expect(h.undo()).toEqual({ v: 1 });
    expect(h.redo()).toEqual({ v: 2 });
    expect(h.canRedo).toBe(false);
  });
  it('merges slider drags with the same key', () => {
    const h = new History({ v: 0 });
    h.push({ v: 1 }, 'q', 1000);
    h.push({ v: 2 }, 'q', 1100);
    h.push({ v: 3 }, 'q', 1200);
    expect(h.depth).toBe(1);
    expect(h.undo()).toEqual({ v: 0 });
  });
  it('ignores no-op pushes and clears redo on new edits', () => {
    const h = new History({ v: 0 });
    expect(h.push({ v: 0 })).toBe(false);
    h.push({ v: 1 });
    h.undo();
    h.push({ v: 5 });
    expect(h.canRedo).toBe(false);
  });
});

describe('zip', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789')) >>> 0).toBe(0xcbf43926);
  });
  it('round-trips stored entries', async () => {
    const files = [
      { name: 'project.json', data: new TextEncoder().encode('{"a":1}') },
      { name: 'photos/x.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    ];
    const z = zipStore(files as any);
    const back = await unzip(z);
    expect(back.map((e) => e.name)).toEqual(['project.json', 'photos/x.jpg']);
    expect([...back[1].data]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });
});

describe('recipe', () => {
  it('parses back with fresh uids and sanitised values', () => {
    const s = makeStep('quality', undefined, { q: 10 }, 42);
    const r = parseRecipe(JSON.stringify(toRecipe([s], 'test')));
    expect(r.steps.length).toBe(1);
    const p = r.steps[0] as any;
    expect(p.id).toBe('quality');
    expect(p.seed).toBe(42);
    expect(p.uid).not.toBe(s.uid);
  });
  it('rejects non-recipes', () => {
    expect(() => parseRecipe('{"format":"nope"}')).toThrow();
  });
  it('only bundled photos can be shared as a link', () => {
    expect(canShareAsLink(toRecipe([makeStep('x', undefined, { other: 'bundled:a' })], 't', 'bundled:b'))).toBe(true);
    expect(canShareAsLink(toRecipe([makeStep('x', undefined, { other: 'user:a' })], 't'))).toBe(false);
    expect(canShareAsLink(toRecipe([makePatch('h')], 't'))).toBe(false);
    expect(canShareAsLink(toRecipe([makeStep('x', undefined, { other: 'ph:testcard' })], 't'))).toBe(true);
  });
  it('a private source photo is left out of a link', () => {
    const r = toRecipe([makeStep('x', undefined, {})], 't', 'user:abc');
    expect(canShareAsLink(r)).toBe(true);
    expect(linkRecipe(r).source).toBeUndefined();
    expect(linkRecipe(toRecipe([], 't', 'ph:lake')).source).toBe('ph:lake');
  });
  it('round-trips through a URL fragment', async () => {
    const r = toRecipe([makeStep('quality', undefined, { q: 5 }, 7)], 'e', 'bundled:x');
    const frag = await recipeToFragment(r);
    expect(frag).toMatch(/^#[rj]=/);
    const back = await recipeFromFragment(frag);
    expect(back!.source).toBe('bundled:x');
    expect((back!.steps[0] as any).params.q).toBe(5);
  });
});

describe('jpegmeta fallback', () => {
  // SOI, APP1 "Exif", COM, SOS (empty scan), EOI
  const app1 = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const jpg = new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xd9]);
  it('detects JPEG', () => {
    expect(isJpeg(jpg)).toBe(true);
    expect(isJpeg(new Uint8Array([1, 2, 3]))).toBe(false);
  });
  it('strips EXIF and inserts comments', () => {
    const s = stripExifFallback(jpg);
    expect(s.length).toBe(jpg.length - app1.length);
    const c = insertComment(s, 'hi');
    expect(c.length).toBeGreaterThan(s.length);
    expect(inspectJpeg(c)).toBeTruthy();
  });
});
