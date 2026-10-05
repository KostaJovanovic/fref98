// Draws the Refragmenter Pixel font into canvases (hex view, contact sheets, cluster maps): exact pixels, no
// antialiasing, from the same glyph data the web font is built from.
import { GLYPHS } from './glyphdata.gen';

export const LINE = 13;
export const ASCENT = 10;

function glyph(cp: number): number[] {
  return GLYPHS[cp] ?? GLYPHS[63]; // '?'
}

export function charWidth(ch: string, bold = false): number {
  const cp = ch.codePointAt(0)!;
  if (cp === 32 || cp === 160) return bold ? 4 : 3;
  const g = glyph(cp);
  return g[1] + 1 + (bold ? 1 : 0);
}

export function textWidth(s: string, bold = false, scale = 1): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch, bold);
  return w * scale;
}

/** Draws text with its top-left at (x,y) (y = top of the 13-px line box). */
export function drawText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string, opts: { bold?: boolean; scale?: number; maxWidth?: number } = {}): number {
  const k = opts.scale ?? 1;
  const bold = !!opts.bold;
  ctx.fillStyle = color;
  let cx = x;
  const limit = opts.maxWidth !== undefined ? x + opts.maxWidth : Infinity;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const adv = charWidth(ch, bold) * k;
    if (cx + adv > limit) break;
    if (cp !== 32 && cp !== 160) {
      const g = glyph(cp);
      const accents = g[0];
      const rows = g.slice(2);
      const top = y + (ASCENT - 8 - accents) * k;
      for (let r = 0; r < rows.length; r++) {
        let bits = rows[r];
        if (bold) bits |= bits << 1;
        let c = 0;
        while (bits) {
          if (bits & 1) {
            // merge horizontal runs into one rect
            let run = 1;
            while ((bits >> run) & 1) run++;
            ctx.fillRect(cx + c * k, top + r * k, run * k, k);
            bits >>= run;
            c += run;
          } else {
            bits >>= 1;
            c++;
          }
        }
      }
    }
    cx += adv;
  }
  return cx - x;
}

/** Truncates with an ellipsis so the text fits in maxWidth pixels. */
export function fitText(s: string, maxWidth: number, bold = false): string {
  if (textWidth(s, bold) <= maxWidth) return s;
  let out = s;
  while (out.length > 1 && textWidth(out + '…', bold) > maxWidth) out = out.slice(0, -1);
  return out + '…';
}
