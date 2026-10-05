// Generates the theme's art at startup and exposes it to CSS as custom properties on the app root.
import { checker, tilePattern, y2kTile, ascii, cached, makeCanvas, controlArtVars } from './art';
import { GRIP_ROWS } from './art-chrome';
import { onScale } from './scale';
import { initCursors, refreshCursors } from './cursors';
import { settings } from '../settings';

function dots(): string {
  return cached('grip', () => ascii(GRIP_ROWS, { W: '#ffffff', G: '#808080' }, makeCanvas(8, 18)));
}

function tailBorder(): string {
  return cached('tailb', () => {
    const c = makeCanvas(16, 12);
    ascii(['', 'X..........XXXXX', '.X........X', '.X......XX', '..X...XX', '..X..X', '..X.X', '..XX', '..X'], { X: '#000000' }, c);
    ascii(['', '.YYYYYYYYYY', '..YYYYYYYY', '..YYYYYY', '...YYY', '...YY', '...Y'], { Y: '#ffffe1' }, c);
    return c;
  });
}

function hazard(): string {
  return cached('hazard', () => {
    const c = makeCanvas(16, 16);
    const x = c.getContext('2d')!;
    x.fillStyle = '#ffff00';
    x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#000';
    for (let y = 0; y < 16; y++) for (let xx = 0; xx < 16; xx++) if (((xx + y) & 15) < 6) x.fillRect(xx, y, 1, 1);
    return c;
  });
}

function viewerBg(): string {
  return cached('viewerbg', () => {
    const c = makeCanvas(16, 16);
    const x = c.getContext('2d')!;
    x.fillStyle = '#808080';
    x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#888888';
    x.fillRect(0, 0, 8, 8);
    x.fillRect(8, 8, 8, 8);
    return c;
  });
}

export function applyTheme(root: HTMLElement) {
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  const url = (u: string) => `url("${u}")`;
  set('--img-checker-black', url(checker('#000000')));
  set('--img-checker-white', url(checker('#ffffff')));
  set('--img-checker-sel', url(checker('#000080')));
  set('--img-tiles', url(tilePattern()));
  set('--img-y2k', url(y2kTile()));
  set('--img-hazard', url(hazard()));
  set('--img-dots', url(dots()));
  set('--img-tail', url(tailBorder()));
  set('--img-viewer-bg', url(viewerBg()));
  // 98 control sprites (checkbox, radio, trackbar, progress, scroll bar, glyphs): ui/art.ts controlArtVars
  for (const [k, v] of Object.entries(controlArtVars())) set(k, v);
}

export function initTheme(root: HTMLElement) {
  applyTheme(root);
  // 98 cursors, drawn 1:1 in device pixels (ui/cursors.ts)
  initCursors(root);
  onScale(() => refreshCursors());
  void settings;
}
