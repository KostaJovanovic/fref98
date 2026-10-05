import { describe, it, expect } from 'vitest';
import * as M from '../src/apps/explorer-model';

describe('98 sizes and dates', () => {
  it('formats sizes like StrFormatByteSize (3 significant digits, truncated)', () => {
    expect(M.fmtSize98(0)).toBe('0 bytes');
    expect(M.fmtSize98(1023)).toBe('1023 bytes');
    expect(M.fmtSize98(1024)).toBe('1.00KB');
    expect(M.fmtSize98(1263)).toBe('1.23KB');
    expect(M.fmtSize98(12_700)).toBe('12.4KB');
    expect(M.fmtSize98(126_000)).toBe('123KB');
    expect(M.fmtSize98(1024 * 1024 * 1.2)).toBe('1.20MB');
  });
  it('rounds the Details size column up to whole KB', () => {
    expect(M.fmtSizeColumn(0)).toBe('0KB');
    expect(M.fmtSizeColumn(1)).toBe('1KB');
    expect(M.fmtSizeColumn(1025)).toBe('2KB');
    expect(M.fmtSizeColumn(1_500_000)).toBe('1,465KB');
    expect(M.fmtBytesExact(46301)).toBe('46,301 bytes');
  });
  it('prints 98 short and long dates', () => {
    const t = new Date(2026, 9, 5, 15, 4, 9);
    expect(M.fmtDate98(t)).toBe('10/5/2026 3:04 PM');
    expect(M.fmtDate98(new Date(2026, 0, 1, 0, 30))).toBe('1/1/2026 12:30 AM');
    expect(M.fmtDateLong98(t)).toBe('Monday, October 05, 2026 3:04:09 PM');
  });
  it('status bar text', () => {
    expect(M.statusText(0, 5)).toBe('5 object(s)');
    expect(M.statusText(2, 5)).toBe('2 object(s) selected');
  });
  it('media clock', () => {
    expect(M.fmtClock(0)).toBe('00:00');
    expect(M.fmtClock(72.35, true)).toBe('01:12.3');
    expect(M.fmtClock(3723)).toBe('1:02:03');
  });
});

describe('views and sorting', () => {
  it('Views button cycles Large → Small → List → Details', () => {
    const all: M.ViewMode[] = ['large', 'small', 'list', 'details', 'thumbs'];
    expect(M.nextView('large', all)).toBe('small');
    expect(M.nextView('details', all)).toBe('large');
    expect(M.nextView('thumbs', all)).toBe('large');
    expect(M.nextView('large', ['large', 'details'])).toBe('details');
  });
  it('sorts stably, naturally, both ways', () => {
    const items = ['img10', 'IMG2', 'b', 'a', 'img2'];
    const key = { cmp: (a: string, b: string) => M.natCmp(a, b) };
    expect(M.sortItems(items, key, false)).toEqual(['a', 'b', 'IMG2', 'img2', 'img10']);
    expect(M.sortItems(items, key, true)).toEqual(['img10', 'IMG2', 'img2', 'b', 'a']);
    expect(items[0]).toBe('img10');
  });
});

describe('keyboard and selection', () => {
  // a 3×2 icon grid, 75 px cells
  const grid: M.ItemBox[] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, x: (i % 3) * 75, y: Math.floor(i / 3) * 75, w: 75, h: 70 }));
  it('arrows move to the nearest item in that direction', () => {
    expect(M.neighborBox(grid, 'a', 'right')).toBe('b');
    expect(M.neighborBox(grid, 'a', 'down')).toBe('d');
    expect(M.neighborBox(grid, 'c', 'down')).toBe('e');
    expect(M.neighborBox(grid, 'e', 'up')).toBe('b');
    expect(M.neighborBox(grid, 'a', 'left')).toBeNull();
    expect(M.neighborBox(grid, 'c', 'right')).toBeNull();
  });
  it('details rows: up/down go to the adjacent row', () => {
    const rows: M.ItemBox[] = ['r1', 'r2', 'r3'].map((id, i) => ({ id, x: 0, y: i * 17, w: 400, h: 17 }));
    expect(M.neighborBox(rows, 'r2', 'down')).toBe('r3');
    expect(M.neighborBox(rows, 'r2', 'up')).toBe('r1');
    expect(M.neighborBox(rows, 'r2', 'right')).toBeNull();
  });
  it('Shift ranges run between the anchor and the target, either way', () => {
    const o = ['a', 'b', 'c', 'd', 'e'];
    expect(M.rangeSelect(o, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(M.rangeSelect(o, 'd', 'a')).toEqual(['a', 'b', 'c', 'd']);
    expect(M.rangeSelect(o, null, 'c')).toEqual(['c']);
    expect(M.rangeSelect(o, 'zz', 'c')).toEqual(['c']);
  });
  it('type-ahead finds the next match and wraps', () => {
    const o = ['apple', 'banana', 'avocado', 'cherry'];
    const n = (s: string) => s;
    expect(M.typeAhead(o, n, null, 'a')).toBe('apple');
    expect(M.typeAhead(o, n, 'apple', 'a')).toBe('avocado');
    expect(M.typeAhead(o, n, 'avocado', 'a')).toBe('apple');
    expect(M.typeAhead(o, n, 'apple', 'av')).toBe('avocado');
    expect(M.typeAhead(o, n, null, 'x')).toBeNull();
  });
});

describe('icon labels', () => {
  const m = (s: string) => s.length * 6;
  it('wraps by words within the width', () => {
    expect(M.wrapLabel('Test card (placeholder)', 69, m)).toEqual(['Test card', '(placeholde', 'r)']);
    expect(M.wrapLabel('Test card (placeholder)', 80, m)).toEqual(['Test card', '(placeholder)']);
    expect(M.wrapLabel('Sunset lake', 69, m)).toEqual(['Sunset lake']);
    expect(M.wrapLabel('a b c', 24, m)).toEqual(['a b', 'c']);
    expect(M.wrapLabel('', 69, m)).toEqual(['']);
  });
  it('breaks a word longer than the label', () => {
    expect(M.wrapLabel('abcdefghijklmnop', 36, m)).toEqual(['abcdef', 'ghijkl', 'mnop']);
  });
  it('clamps to two lines with an ellipsis that fits', () => {
    const lines = M.wrapLabel('one two three four five six', 30, m);
    const c = M.clampLines(lines, 2, 30, m);
    expect(c.length).toBe(2);
    expect(c[1].endsWith('...')).toBe(true);
    expect(m(c[1])).toBeLessThanOrEqual(30);
    expect(M.clampLines(['a', 'b'], 2, 30, m)).toEqual(['a', 'b']);
  });
});

describe('names', () => {
  it('pasted copies are "Copy of", then "Copy (2) of"', () => {
    expect(M.copyName('a.jpg', ['a.jpg'])).toBe('Copy of a.jpg');
    expect(M.copyName('a.jpg', ['a.jpg', 'copy of A.JPG'])).toBe('Copy (2) of a.jpg');
    expect(M.copyName('a.jpg', ['Copy of a.jpg', 'Copy (2) of a.jpg'])).toBe('Copy (3) of a.jpg');
  });
  it('rejects names 98 would not accept', () => {
    expect(M.validFileName('holiday.jpg')).toBe(true);
    expect(M.validFileName('a:b.jpg')).toBe(false);
    expect(M.validFileName('what?')).toBe(false);
    expect(M.validFileName('  ')).toBe(false);
    expect(M.validFileName('...')).toBe(false);
  });
  it('8.3 MS-DOS names', () => {
    expect(M.dosName('DSC1.JPG')).toBe('DSC1.JPG');
    expect(M.dosName('Holiday photo.jpg')).toBe('HOLIDA~1.JPG');
    expect(M.dosName('photo.jpeg')).toBe('PHOTO~1.JPE');
    expect(M.dosName('readme')).toBe('README');
  });
  it('file types by extension', () => {
    expect(M.fileType('a.jpg')).toBe('JPEG Image');
    expect(M.fileType('noext')).toBe('JPEG Image');
    expect(M.fileType('clip.avi')).toBe('Video Clip');
    expect(M.fileType('x.png')).toBe('PNG File');
  });
  it('decodes the time stamp in a photo uid', () => {
    const t = Date.UTC(2026, 9, 5, 12);
    expect(M.uidTime('user:' + t.toString(36) + 'k3zz')).toBe(t);
    expect(M.uidTime('ph:' + t.toString(36) + '1')).toBe(t);
    expect(M.uidTime('bundled:zzzzzzzzz.jpg')).toBeNull();
    expect(M.uidTime('user:abc')).toBeNull();
    // bundled placeholders are named, not timed ("testcard" reads as base-36 2043)
    expect(M.uidTime('ph:testcard')).toBeNull();
    expect(M.uidTime('ph:sunset')).toBeNull();
  });
});
