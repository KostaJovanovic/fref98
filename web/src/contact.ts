// Contact sheets: the recovery-script layout (8 per row on black with filenames), an XP "Thumbnails" view and a
// Kodak-style index print. Thumbnails are the real decoded pixels (box-filtered down), never dithered.
import { engine } from './engine/client';
import { drawText, fitText, LINE } from './ui/pixeltext';

export type SheetStyle = 'graft' | 'xp' | 'kodak';

export interface SheetItem {
  name: string;
  bytes: Uint8Array;
}

async function thumb(bytes: Uint8Array, size: number): Promise<HTMLCanvasElement | null> {
  try {
    const d = await engine().decode(bytes, { max_dim: size * 2 }).promise;
    const src = document.createElement('canvas');
    src.width = d.width;
    src.height = d.height;
    src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d.rgba.buffer as ArrayBuffer, d.rgba.byteOffset, d.rgba.byteLength), d.width, d.height), 0, 0);
    const s = Math.min(size / d.width, size / d.height, 1);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(d.width * s));
    c.height = Math.max(1, Math.round(d.height * s));
    const x = c.getContext('2d')!;
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  } catch {
    return null;
  }
}

export async function contactSheet(items: SheetItem[], style: SheetStyle = 'graft', onProgress?: (i: number, n: number) => void, shouldStop?: () => boolean): Promise<HTMLCanvasElement> {
  const perRow = style === 'kodak' ? 6 : 8;
  const cell = style === 'kodak' ? 120 : 160;
  const pad = style === 'graft' ? 6 : 10;
  const labelH = LINE + 4;
  const cols = Math.min(perRow, Math.max(1, items.length));
  const rows = Math.max(1, Math.ceil(items.length / perRow));
  const headH = style === 'kodak' ? 40 : 0;
  const W = cols * (cell + pad) + pad;
  const H = headH + rows * (cell + labelH + pad) + pad;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d')!;
  x.fillStyle = style === 'graft' ? '#000000' : style === 'xp' ? '#ffffff' : '#f4efe1';
  x.fillRect(0, 0, W, H);
  if (style === 'kodak') {
    drawText(x, 'INDEX PRINT  ·  REFRAGMENTER 98  ·  ' + new Date().toISOString().slice(0, 10), pad, 12, '#c65a00', { bold: true });
  }
  for (let i = 0; i < items.length; i++) {
    if (shouldStop?.()) break;
    onProgress?.(i, items.length);
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const cx = pad + col * (cell + pad);
    const cy = headH + pad + row * (cell + labelH + pad);
    const t = await thumb(items[i].bytes, cell);
    if (style === 'xp') {
      x.fillStyle = '#d0d0bf';
      x.fillRect(cx - 1, cy - 1, cell + 2, cell + 2);
      x.fillStyle = '#ffffff';
      x.fillRect(cx, cy, cell, cell);
    }
    if (t) {
      x.imageSmoothingEnabled = false;
      x.drawImage(t, cx + Math.floor((cell - t.width) / 2), cy + Math.floor((cell - t.height) / 2));
    } else {
      drawText(x, '(unreadable)', cx + 8, cy + cell / 2 - 6, style === 'graft' ? '#888888' : '#a00000');
    }
    const label = style === 'kodak' ? `${String(i + 1).padStart(3, '0')} ${items[i].name}` : items[i].name;
    const txt = fitText(label, cell);
    drawText(x, txt, cx, cy + cell + 3, style === 'graft' ? '#dddddd' : style === 'kodak' ? '#c65a00' : '#000000');
  }
  return c;
}

export function canvasToPng(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG failed'))), 'image/png'));
}
