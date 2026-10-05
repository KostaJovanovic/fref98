// Small, forgiving JPEG marker walker in TypeScript. Used as a fallback for inspect() while the WASM
// inspector is not available, and for tiny byte edits (COM recipe embedding, EXIF stripping fallback).
import type { Inspection, Segment } from './types';

const NAMES: Record<number, string> = {
  0xd8: 'SOI', 0xd9: 'EOI', 0xda: 'SOS', 0xdb: 'DQT', 0xc4: 'DHT', 0xdd: 'DRI', 0xfe: 'COM',
  0xc0: 'SOF0', 0xc1: 'SOF1', 0xc2: 'SOF2', 0xc3: 'SOF3', 0xc5: 'SOF5', 0xc6: 'SOF6', 0xc7: 'SOF7',
  0xc9: 'SOF9', 0xca: 'SOF10', 0xcb: 'SOF11', 0xcc: 'DAC',
};

export function markerName(m: number): string {
  if (NAMES[m]) return NAMES[m];
  if (m >= 0xe0 && m <= 0xef) return 'APP' + (m - 0xe0);
  if (m >= 0xd0 && m <= 0xd7) return 'RST' + (m - 0xd0);
  return '0x' + m.toString(16).toUpperCase();
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
];

/** Walks markers; inside entropy-coded data skips to the next non-RST marker. Never throws. */
export function inspectJpeg(b: Uint8Array): Inspection {
  const segments: Segment[] = [];
  const out: Inspection = { size: b.length, segments, qtables: [], scans: [], trailing_bytes: 0 };
  let i = 0;
  if (!isJpeg(b)) return out;
  const u16 = (p: number) => (p + 1 < b.length ? (b[p] << 8) | b[p + 1] : 0);
  while (i < b.length - 1) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x00) {
      i += 2;
      continue;
    }
    const start = i;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      segments.push({ offset: start, length: 2, marker: m, name: markerName(m), summary: m === 0xd8 ? 'Start of image' : '' });
      i += 2;
      continue;
    }
    if (m === 0xd9) {
      segments.push({ offset: start, length: 2, marker: m, name: 'EOI', summary: 'End of image' });
      if (out.eoi_offset === undefined) out.eoi_offset = start;
      i += 2;
      if (out.eoi_offset === start) out.trailing_bytes = Math.max(0, b.length - i);
      continue;
    }
    const len = u16(i + 2);
    const body = i + 4;
    let summary = '';
    if (m === 0xdb) {
      let p = body;
      const end = Math.min(b.length, i + 2 + len);
      const ids: number[] = [];
      while (p < end) {
        const pq = b[p] >> 4;
        const tq = b[p] & 15;
        p++;
        const vals = new Array(64).fill(0);
        for (let k = 0; k < 64 && p < end; k++) {
          vals[ZIGZAG[k]] = pq ? u16(p) : b[p];
          p += pq ? 2 : 1;
        }
        out.qtables!.push({ id: tq, values: vals });
        ids.push(tq);
      }
      summary = 'Quantisation table ' + ids.join(', ');
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = u16(body + 1);
      const w = u16(body + 3);
      const nc = b[body + 5] ?? 0;
      const comps = [];
      for (let c = 0; c < nc; c++) {
        const q = body + 6 + c * 3;
        comps.push({ id: b[q], h: b[q + 1] >> 4, v: b[q + 1] & 15, tq: b[q + 2] });
      }
      out.frame = { width: w, height: h, progressive: m === 0xc2 || m === 0xc6 || m === 0xca, components: comps };
      summary = `${w}×${h}, ${nc} components${out.frame.progressive ? ', progressive' : ''}`;
    } else if (m === 0xc4) {
      summary = 'Huffman tables';
    } else if (m === 0xdd) {
      out.restart_interval = u16(body);
      summary = 'Restart every ' + out.restart_interval + ' MCUs';
    } else if (m === 0xe1 && b[body] === 0x45 && b[body + 1] === 0x78) {
      summary = 'EXIF';
    } else if (m === 0xe0 && b[body] === 0x4a) {
      summary = 'JFIF';
    } else if (m === 0xfe) {
      summary = 'Comment';
    }
    if (m === 0xda) {
      const ns = b[body] ?? 0;
      const comps: number[] = [];
      for (let c = 0; c < ns; c++) comps.push(b[body + 1 + c * 2]);
      const q = body + 1 + ns * 2;
      // find the end of the entropy-coded data
      let j = i + 2 + len;
      while (j < b.length - 1) {
        if (b[j] === 0xff) {
          const n = b[j + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
            j += n === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= b.length - 1) j = b.length;
      out.scans!.push({ offset: start, length: j - start, components: comps, ss: b[q] ?? 0, se: b[q + 1] ?? 63, ah: (b[q + 2] ?? 0) >> 4, al: (b[q + 2] ?? 0) & 15 });
      segments.push({ offset: start, length: j - start, marker: m, name: 'SOS', summary: `Scan: ${ns} component(s), ${j - (i + 2 + len)} bytes of entropy data` });
      i = j;
      continue;
    }
    segments.push({ offset: start, length: Math.min(len + 2, b.length - start), marker: m, name: markerName(m), summary });
    i += 2 + Math.max(len, 2);
  }
  return out;
}

/** Fallback EXIF stripper: removes every APP1 (Exif, XMP) and APP13 (IPTC) segment; orientation is lost too. */
export function stripExifFallback(b: Uint8Array): Uint8Array {
  const info = inspectJpeg(b);
  const drop = info.segments.filter((s) => s.marker === 0xe1 || s.marker === 0xed);
  if (!drop.length) return b.slice();
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const s of drop) {
    parts.push(b.subarray(pos, s.offset));
    pos = s.offset + s.length;
  }
  parts.push(b.subarray(pos));
  return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Inserts a COM segment right after SOI (used for the opt-in "embed recipe"). */
export function insertComment(b: Uint8Array, text: string): Uint8Array {
  if (!isJpeg(b)) return b;
  const data = new TextEncoder().encode(text).subarray(0, 65533);
  const seg = new Uint8Array(4 + data.length);
  seg[0] = 0xff;
  seg[1] = 0xfe;
  seg[2] = (data.length + 2) >> 8;
  seg[3] = (data.length + 2) & 255;
  seg.set(data, 4);
  return concat([b.subarray(0, 2), seg, b.subarray(2)]);
}
